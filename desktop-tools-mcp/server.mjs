#!/usr/bin/env node
// Local file + PowerShell tools exposed over MCP stdio.
//
// The allowed roots come from the first CLI argument (repeatable, separated by
// path.delimiter) so the embedding app decides the sandbox, not the model.
// Example:
//   desktop-tools-mcp C:\work C:\Users\me\Documents
//
// Tools that write or execute are declared without auto-approval: the host
// application asks the user before each call (see mcpServerConfig
// autoApproveTools). Reads are safe to run unattended.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

import { listDir, readFile, replaceInFile, searchFiles, writeFile } from './src/fileTools.mjs';
import { normalizeRoots } from './src/paths.mjs';
import { detectShell, runPowerShell } from './src/shellRunner.mjs';

/** Roots are passed as argv; fall back to the CWD so the server is never rootless. */
async function resolveRoots(argv) {
  const raw = argv.filter((arg) => typeof arg === 'string' && arg.trim() && !arg.startsWith('--'));
  const candidates = raw.length > 0 ? raw : [process.cwd()];

  const roots = [];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    const stat = await fs.stat(absolute).catch(() => null);
    // A root that does not exist would silently deny every call, so drop it
    // and let the error below explain what happened.
    if (stat?.isDirectory()) roots.push(absolute);
  }
  return normalizeRoots(roots);
}

const BASE_PROPS = {
  path: {
    type: 'string',
    description:
      'Absolute path, or a path relative to the process working directory. Must be inside one of the allowed workspace roots.',
  },
};

const TOOLS = [
  {
    name: 'list_dir',
    description:
      'List the contents of a directory. Returns entries with "/" for directories and sizes for files. ' +
      'Use depth 2-3 to see a project structure at a glance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: BASE_PROPS.path,
        depth: { type: 'number', description: 'How many directory levels to recurse (default 1, max 4).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file. Reads the whole file unless startLine/endLine are given. ' +
      'Binary files and files above 2 MB are rejected — use read_file with a line range for large logs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: BASE_PROPS.path,
        startLine: { type: 'number', description: 'First line to return (1-based).' },
        endLine: { type: 'number', description: 'Last line to return (inclusive).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write a text file, creating or overwriting it. To change part of an existing file prefer ' +
      'replace_in_file — it is safer than rewriting the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: BASE_PROPS.path,
        content: { type: 'string', description: 'Full file content to write.' },
        createDirs: { type: 'boolean', description: 'Create missing parent directories (default false).' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'replace_in_file',
    description:
      'Replace an exact string in a text file. oldString must match exactly once unless replaceAll is true. ' +
      'Read the file first and copy the text verbatim, including indentation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: BASE_PROPS.path,
        oldString: { type: 'string', description: 'Exact text to find.' },
        newString: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'search_files',
    description:
      'Search file contents for a plain-text substring and return "path:line: text" matches. ' +
      'Skips node_modules, .git, dist, build, .next and target directories.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-sensitive).' },
        path: { type: 'string', description: 'Directory to search in. Defaults to the first workspace root.' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default 200).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'run_powershell',
    description:
      'Run a PowerShell command in a workspace directory and return stdout, stderr and the exit code. ' +
      'Use it for builds, tests, git, file listing and any system task the file tools cannot express. ' +
      'Runs with -NoProfile -NonInteractive and a 120s timeout by default. ' +
      'Prefer read-only commands; anything destructive needs the user to approve the call.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'PowerShell script to execute.' },
        cwd: { type: 'string', description: 'Working directory inside the workspace. Defaults to the first root.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (max 600000).' },
      },
      required: ['script'],
    },
  },
];

async function main() {
  const roots = await resolveRoots(process.argv.slice(2));
  if (roots.length === 0) {
    console.error(
      'desktop-tools-mcp: no valid workspace directory. Pass at least one existing directory as an argument.',
    );
    process.exit(1);
  }

  const server = new Server(
    { name: 'desktop-tools', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs = {} } = request.params;
    const args = rawArgs ?? {};

    try {
      let text;

      switch (name) {
        case 'list_dir': {
          const depth = Math.min(Math.max(Number(args.depth ?? 1) || 1, 1), 4);
          text = await listDir({ dirPath: String(args.path ?? ''), roots, depth });
          break;
        }
        case 'read_file':
          text = await readFile({
            filePath: String(args.path ?? ''),
            roots,
            startLine: args.startLine === undefined ? undefined : Number(args.startLine),
            endLine: args.endLine === undefined ? undefined : Number(args.endLine),
          });
          break;
        case 'write_file':
          text = await writeFile({
            filePath: String(args.path ?? ''),
            roots,
            content: args.content,
            createDirs: Boolean(args.createDirs),
          });
          break;
        case 'replace_in_file':
          text = await replaceInFile({
            filePath: String(args.path ?? ''),
            roots,
            oldString: String(args.oldString ?? ''),
            newString: String(args.newString ?? ''),
            replaceAll: Boolean(args.replaceAll),
          });
          break;
        case 'search_files':
          text = await searchFiles({
            query: String(args.query ?? ''),
            roots,
            dirPath: args.path === undefined ? undefined : String(args.path),
            maxResults: args.maxResults === undefined ? undefined : Number(args.maxResults),
          });
          break;
        case 'run_powershell':
          text = await runPowerShell({
            script: String(args.script ?? ''),
            roots,
            cwd: args.cwd === undefined ? undefined : String(args.cwd),
            timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
          });
          break;
        default:
          return {
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          };
      }

      return { content: [{ type: 'text', text }] };
    } catch (error) {
      // Errors go back as tool results, not crashes: the model can read the
      // message and correct itself instead of losing the whole session.
      return {
        isError: true,
        content: [{ type: 'text', text: `${name} failed: ${error?.message ?? String(error)}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shell = await detectShell();
  console.error(
    `desktop-tools-mcp ready. roots=[${roots.join(', ')}] shell=${shell ? `${shell.label} ${shell.version}` : 'not found'}`,
  );
}

main().catch((error) => {
  console.error('desktop-tools-mcp failed to start:', error);
  process.exit(1);
});
