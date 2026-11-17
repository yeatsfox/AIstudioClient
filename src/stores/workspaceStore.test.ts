import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store keeps the list in the shared key/value store. These tests pin the
 * round trip that makes the feature survive a restart: write, then load in a
 * fresh store instance and get the same directories back.
 */
const memory = new Map<string, unknown>();

vi.mock('@/services/db/indexedDbAccess', () => ({
  getKeyValue: vi.fn(async (key: string) => memory.get(key) ?? null),
  setKeyValue: vi.fn(async (key: string, value: unknown) => {
    memory.set(key, value);
  }),
}));

vi.mock('@/services/logService', () => ({
  logService: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const STORAGE_KEY = 'amc_workspaces_v1';

async function freshStore() {
  vi.resetModules();
  const module = await import('@/stores/workspaceStore');
  return module.useWorkspaceStore;
}

describe('workspace store persistence', () => {
  beforeEach(() => {
    memory.clear();
  });

  it('restores directories after a reload', async () => {
    const store = await freshStore();
    store.getState().add('/home/me/project', 'project');
    store.getState().add('/home/me/notes', 'notes');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A reload means a brand new store reading whatever was written.
    const reopened = await freshStore();
    expect(reopened.getState().workspaces).toHaveLength(0);
    await reopened.getState().load();

    expect(reopened.getState().workspaces.map((workspace) => workspace.path)).toEqual([
      '/home/me/project',
      '/home/me/notes',
    ]);
    expect(reopened.getState().isLoaded).toBe(true);
  });

  it('keeps disabled directories persisted but out of the allowed paths', async () => {
    const store = await freshStore();
    store.getState().add('/home/me/project');
    store.getState().add('/home/me/secret');
    const secret = store.getState().workspaces.find((workspace) => workspace.path === '/home/me/secret');
    store.getState().setEnabled(secret!.id, false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reopened = await freshStore();
    await reopened.getState().load();

    // Both are remembered, but only the enabled one is handed to the tools server.
    expect(reopened.getState().workspaces).toHaveLength(2);
    expect(reopened.getState().mountedPaths()).toEqual(['/home/me/project']);
  });

  it('does not duplicate a directory that is added twice', async () => {
    const store = await freshStore();
    store.getState().add('/home/me/project');
    store.getState().add('/home/me/project/');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reopened = await freshStore();
    await reopened.getState().load();

    expect(reopened.getState().workspaces).toHaveLength(1);
  });

  it('survives a corrupt stored value', async () => {
    memory.set(STORAGE_KEY, 'not a list');

    const store = await freshStore();
    await store.getState().load();

    expect(store.getState().workspaces).toEqual([]);
    expect(store.getState().isLoaded).toBe(true);
  });
});
