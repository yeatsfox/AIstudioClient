// Tells the model which folders the local tools may touch.
//
// Adding a workspace only rewrites the MCP server's arguments: the server can
// now read those directories, but nothing in the conversation said they exist.
// Asked to read a folder it had just been given, the model truthfully answered
// "I have no access to that path" because it had never been told otherwise.
// The tool being available is not the same as the model knowing it is.
import type { Workspace } from '@/features/workspaces/workspaceModel';
import { isWorkspaceEnabled } from '@/features/workspaces/workspaceModel';

/**
 * Builds the system-prompt section describing mounted workspaces.
 *
 * Returns null when nothing is mounted, so the web build and a desktop build
 * with no folders added send exactly the same prompt as before this existed.
 */
export function buildWorkspaceSystemInstruction(
  workspaces: readonly Workspace[],
  hasTools: boolean,
): string | null {
  const enabled = workspaces.filter(isWorkspaceEnabled);
  if (enabled.length === 0) return null;
  if (!hasTools) {
    // Without file tools, listing paths only invites the model to invent reads
    // it cannot perform.
    return null;
  }

  const lines = enabled.map((workspace) => `- ${workspace.path}${workspace.title !== workspace.path ? ` (${workspace.title})` : ''}`);

  return [
    'The user has added these local folders as workspaces:',
    ...lines,
    '',
    'Use the local file tools (list_dir, read_file, search_files) to look inside them when the user refers to',
    'files or folders. Do not claim you cannot access a path before trying a tool — if a listed folder is',
    'unreachable the tool will say so, and only then should you report it. These are real folders on the',
    "user's machine; never invent file contents.",
  ].join('\n');
}

/**
 * Appends the workspace block to an existing instruction without disturbing it.
 * User-written instructions come first: this is added context, not a replacement.
 */
export function appendWorkspaceInstruction(
  systemInstruction: string | undefined,
  workspaces: readonly Workspace[],
  hasTools: boolean,
): string | undefined {
  const block = buildWorkspaceSystemInstruction(workspaces, hasTools);
  if (!block) return systemInstruction;
  const existing = systemInstruction?.trim();
  return existing ? `${existing}\n\n${block}` : block;
}
