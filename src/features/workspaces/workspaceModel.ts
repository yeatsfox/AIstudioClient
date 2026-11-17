// Workspace records for the desktop build.
//
// A workspace is the durable record of a directory the user works in: a stable
// id over a canonical path, a display title, and whether it is currently
// mounted into the local tools server. The id never changes even when the path
// does, because it is what sessions and UI state refer to.
//
// Only the desktop shell can add a directory: the browser sandbox cannot open a
// native folder picker or stat a path, so the picked directory is validated and
// canonicalized in the main process before it is recorded here.

export interface Workspace {
  /**
   * Stable record id, generated once. Never the path: normalizing a path can
   * rewrite it, and it must stay a stable anchor.
   */
  id: string;
  /**
   * Canonical absolute path as reported by the main process (`fs.realpath`), so
   * `..`, trailing slashes and symlinks are already resolved. What the tools
   * server is allowed to touch is compared against exactly this string.
   */
  path: string;
  /** Display title. Defaults to the last path segment. */
  title: string;
  /**
   * Whether the tools server may touch this directory. Disabling keeps the
   * record and its title, so a large folder can be taken out of reach
   * temporarily without having to pick it again.
   *
   * Absent on records written before this flag existed; treated as enabled.
   */
  enabled?: boolean;
  /** ISO-8601 creation instant, stamped once and never rewritten. */
  createdAt: string;
  /** ISO-8601 instant of the last durable mutation. */
  updatedAt: string;
}

/** Everything the folder picker needs to tell us, as returned by the main process. */
export interface PickedDirectory {
  path: string;
  title: string;
}

/**
 * Generates an id without depending on a crypto API that may be missing in an
 * older embedded browser. Collisions are not a practical concern for a list the
 * user builds by hand, but the timestamp keeps them sorted usefully.
 */
export function createWorkspaceId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `ws_${Date.now().toString(36)}_${random}`;
}

/** Default title: the final path segment, or the root's own spelling (`C:\`, `/`). */
export function defaultWorkspaceTitle(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return path;
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1] || trimmed;
  // `C:` alone reads better as `C:\` than as a bare drive letter.
  return /^[A-Za-z]:$/.test(last) ? `${last}\\` : last;
}

export function createWorkspace(path: string, title?: string): Workspace {
  const now = new Date().toISOString();
  return {
    id: createWorkspaceId(),
    path,
    title: title?.trim() || defaultWorkspaceTitle(path),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** A record written before the `enabled` flag existed counts as enabled. */
export function isWorkspaceEnabled(workspace: Workspace): boolean {
  return workspace.enabled !== false;
}

/**
 * Two records with the same canonical path are the same folder. Comparing
 * canonically-normalized strings is the whole uniqueness rule: a symlink to an
 * already-added directory collides, which is what the user means by "already
 * added".
 *
 * Case is folded on Windows because the filesystem is case-insensitive there.
 */
export function workspacePathsEqual(a: string, b: string): boolean {
  const isWindows = /^[A-Za-z]:|^\\\\/.test(a) || /^[A-Za-z]:|^\\\\/.test(b);
  const normalize = (value: string) => {
    const trimmed = value.replace(/[\\/]+$/, '');
    return isWindows ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(a) === normalize(b);
}

/** The list a request would use, preserving the user's ordering. */
export function workspacePaths(workspaces: Workspace[]): string[] {
  return workspaces.map((workspace) => workspace.path);
}
