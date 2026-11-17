import { create } from 'zustand';
import { getKeyValue, setKeyValue } from '@/services/db/indexedDbAccess';
import { logService } from '@/services/logService';
import {
  createWorkspace,
  isWorkspaceEnabled,
  type Workspace,
  workspacePathsEqual,
} from '@/features/workspaces/workspaceModel';

/**
 * Key in the shared key/value store. The list is tiny and read once at startup,
 * so it lives beside the other app settings rather than in its own object store.
 */
const STORAGE_KEY = 'amc_workspaces_v1';

interface WorkspaceState {
  workspaces: Workspace[];
  isLoaded: boolean;
  /**
   * Directories currently honoured by the local tools server, in user order.
   * Derived rather than stored: the servers' arguments are the source of truth
   * and the store only reflects them.
   */
  mountedPaths: () => string[];
  load: () => Promise<void>;
  add: (path: string, title?: string) => Workspace | null;
  remove: (id: string) => void;
  rename: (id: string, title: string) => void;
  /** Move a workspace within the list, so the order users see is the order used. */
  move: (id: string, toIndex: number) => void;
  setEnabled: (id: string, enabled: boolean) => void;
}

function persist(workspaces: Workspace[]): void {
  // Fire and forget: the in-memory list is already correct, and a failed write
  // is reported but must not undo what the user just did on screen.
  setKeyValue(STORAGE_KEY, workspaces).catch((error) => {
    logService.error(`Failed to persist workspaces: ${String(error)}`);
  });
}

/**
 * Whether this build can add directories at all.
 *
 * The browser sandbox cannot open a native folder picker, so the button is
 * hidden outside the desktop shell rather than failing on click.
 */
export function canPickWorkspaceDirectory(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__AMC_DESKTOP__?.pickDirectory);
}

/**
 * Ask the desktop shell for a directory.
 *
 * The returned path is already canonical (`fs.realpath` in the main process),
 * so it can be compared directly against what the tools server reports.
 * Returns null when the user cancels or the build has no picker.
 */
export async function pickWorkspaceDirectory(): Promise<{ path: string; title: string } | null> {
  const bridge = typeof window !== 'undefined' ? window.__AMC_DESKTOP__ : undefined;
  if (!bridge?.pickDirectory) return null;
  try {
    return await bridge.pickDirectory();
  } catch (error) {
    logService.error(`Directory picker failed: ${String(error)}`);
    return null;
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  isLoaded: false,

  mountedPaths: () => get().workspaces.filter(isWorkspaceEnabled).map((workspace) => workspace.path),

  load: async () => {
    try {
      const stored = await getKeyValue<Workspace[]>(STORAGE_KEY);
      const workspaces = Array.isArray(stored)
        ? stored.filter(
            (entry): entry is Workspace =>
              Boolean(entry) &&
              typeof entry.id === 'string' &&
              typeof entry.path === 'string' &&
              entry.path.length > 0,
          )
        : [];
      set({ workspaces, isLoaded: true });
    } catch (error) {
      logService.error(`Failed to load workspaces: ${String(error)}`);
      // Still mark as loaded: leaving the flag false would block the tools
      // server from ever registering.
      set({ isLoaded: true });
    }
  },

  add: (path, title) => {
    const trimmed = path.trim();
    if (!trimmed) return null;

    // A second record for the same folder would register overlapping roots and
    // show the user two rows they cannot tell apart.
    const duplicate = get().workspaces.some((workspace) => workspacePathsEqual(workspace.path, trimmed));
    if (duplicate) return null;

    const workspace = createWorkspace(trimmed, title);
    const workspaces = [...get().workspaces, workspace];
    set({ workspaces });
    persist(workspaces);
    return workspace;
  },

  remove: (id) => {
    const workspaces = get().workspaces.filter((workspace) => workspace.id !== id);
    if (workspaces.length === get().workspaces.length) return;
    set({ workspaces });
    persist(workspaces);
  },

  rename: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    const workspaces = get().workspaces.map((workspace) =>
      workspace.id === id ? { ...workspace, title: trimmed, updatedAt: now } : workspace,
    );
    set({ workspaces });
    persist(workspaces);
  },

  move: (id, toIndex) => {
    const current = get().workspaces;
    const from = current.findIndex((workspace) => workspace.id === id);
    if (from < 0) return;
    const target = Math.max(0, Math.min(current.length - 1, toIndex));
    if (from === target) return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    set({ workspaces: next });
    persist(next);
  },

  setEnabled: (id, enabled) => {
    // Disabling keeps the record (and its title) but drops it from the roots,
    // so a large folder can be taken out of reach temporarily.
    const now = new Date().toISOString();
    const workspaces = get().workspaces.map((workspace) =>
      workspace.id === id ? { ...workspace, enabled, updatedAt: now } : workspace,
    );
    set({ workspaces });
    persist(workspaces);
  },
}));
