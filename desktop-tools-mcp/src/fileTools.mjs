// File tools: list, read, write, replace, search.
//
// Reads are bounded so a stray `read_file` on a 4 GB log cannot blow up the
// model context; edits are expressed as exact string replacement so the model
// can change a few lines without rewriting a whole file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWithinRoots } from './paths.mjs';

export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 500;
export const MAX_SEARCH_RESULTS = 200;

const BINARY_SNIFF_BYTES = 8000;

/** Reject files that look binary: the model cannot use raw bytes anyway. */
function looksBinary(buffer) {
  const sample = buffer.subarray(0, BINARY_SNIFF_BYTES);
  return sample.includes(0);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function listDir({ dirPath, roots, depth = 1 }) {
  const target = await resolveWithinRoots(dirPath, roots, 'existing');
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }

  const lines = [];
  let truncated = false;

  const walk = async (current, level, prefix) => {
    if (lines.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (lines.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        if (level < depth) {
          await walk(full, level + 1, `${prefix}${entry.name}/`);
        }
      } else if (entry.isSymbolicLink()) {
        lines.push(`${prefix}${entry.name} -> (link)`);
      } else {
        const size = await fs.stat(full).then((s) => s.size).catch(() => 0);
        lines.push(`${prefix}${entry.name} (${formatSize(size)})`);
      }
    }
  };

  await walk(target, 1, '');

  const header = `Directory: ${target}${truncated ? ` (truncated at ${MAX_LIST_ENTRIES} entries)` : ''}`;
  return [header, ...lines].join('\n');
}

export async function readFile({ filePath, roots, startLine, endLine }) {
  const target = await resolveWithinRoots(filePath, roots, 'existing');
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    throw new Error(`Is a directory, use list_dir: ${filePath}`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `File is ${formatSize(stat.size)}, above the ${formatSize(MAX_READ_BYTES)} read limit. ` +
        'Use read_file_range with startLine/endLine, or search_files.',
    );
  }

  const buffer = await fs.readFile(target);
  if (looksBinary(buffer)) {
    throw new Error('File appears to be binary; refusing to read it as text.');
  }

  const text = buffer.toString('utf8');
  if (startLine === undefined && endLine === undefined) {
    const lineCount = text.split('\n').length;
    return `File: ${target} (${lineCount} lines, ${formatSize(stat.size)})\n\n${text}`;
  }

  const lines = text.split('\n');
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? lines.length);
  if (from > to) {
    throw new Error(`Invalid range: startLine ${from} is after endLine ${to}.`);
  }
  const slice = lines.slice(from - 1, to).join('\n');
  return `File: ${target} (lines ${from}-${to} of ${lines.length})\n\n${slice}`;
}

export async function writeFile({ filePath, roots, content, createDirs = false }) {
  if (typeof content !== 'string') {
    throw new Error('content must be a string.');
  }
  const target = await resolveWithinRoots(filePath, roots, 'create');

  if (createDirs) {
    await fs.mkdir(path.dirname(target), { recursive: true });
  }

  const existed = await fs.stat(target).then(() => true).catch(() => false);
  await fs.writeFile(target, content, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  return `${existed ? 'Overwrote' : 'Created'} ${target} (${formatSize(bytes)})`;
}

/**
 * Exact-string replacement. A unique match is required unless replaceAll is
 * set, which prevents the model from silently editing the wrong occurrence.
 */
export async function replaceInFile({ filePath, roots, oldString, newString, replaceAll = false }) {
  if (!oldString) {
    throw new Error('oldString must not be empty.');
  }
  if (typeof newString !== 'string') {
    throw new Error('newString must be a string.');
  }

  const target = await resolveWithinRoots(filePath, roots, 'existing');
  const original = await fs.readFile(target, 'utf8');

  const occurrences = original.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error('oldString was not found in the file. Read the file first and copy the text exactly.');
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `oldString appears ${occurrences} times. Add surrounding context to make it unique, or pass replaceAll: true.`,
    );
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);

  await fs.writeFile(target, updated, 'utf8');
  return `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${target}`;
}

/** Plain substring search over text files, skipping binaries and huge files. */
export async function searchFiles({ query, roots, dirPath, maxResults = MAX_SEARCH_RESULTS }) {
  const needle = typeof query === 'string' ? query : '';
  if (!needle) {
    throw new Error('query must be a non-empty string.');
  }

  const start = await resolveWithinRoots(dirPath ?? roots[0], roots, 'existing');
  const results = [];
  let scanned = 0;

  const walk = async (current) => {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      // Skip dependency and VCS noise: searching those is never what the user means.
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', '.next', 'target'].includes(entry.name)) continue;
        await walk(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const full = path.join(current, entry.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > MAX_READ_BYTES) continue;

      const buffer = await fs.readFile(full).catch(() => null);
      if (!buffer || looksBinary(buffer)) continue;

      scanned += 1;
      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(needle)) {
          results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          if (results.length >= maxResults) return;
        }
      }
    }
  };

  await walk(start);

  const header = `Search "${needle}" in ${start} — ${results.length} match(es) across ${scanned} file(s)`;
  return results.length ? [header, ...results].join('\n') : `${header}\nNo matches found.`;
}
