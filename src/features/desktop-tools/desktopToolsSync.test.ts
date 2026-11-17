import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sync path is what makes "add a folder" work: the workspace store changes,
 * the MCP server's arguments follow, and the next tool call sees the new root.
 * These tests drive that chain with in-memory stores.
 */
const state = vi.hoisted(() => ({
  desktopConfig: null as { serverPath: string; roots: string[]; command: string } | null,
  mounted: [] as string[],
  servers: [] as Array<Record<string, unknown>>,
  writes: 0,
}));

vi.mock('@/runtime/runtimeConfig', () => ({
  getDesktopToolsConfig: () => state.desktopConfig,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      appSettings: { mcpServers: state.servers },
      isSettingsLoaded: true,
      setAppSettings: (updater: unknown) => {
        state.writes += 1;
        const prev = { mcpServers: state.servers };
        const next = typeof updater === 'function' ? (updater as (p: unknown) => unknown)(prev) : updater;
        state.servers = (next as { mcpServers: Array<Record<string, unknown>> }).mcpServers;
      },
    }),
    subscribe: () => () => undefined,
  },
}));

vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ mountedPaths: () => state.mounted, isLoaded: true }),
    subscribe: () => () => undefined,
  },
}));

import { DESKTOP_TOOLS_SERVER_ID, syncDesktopToolsServer } from './desktopToolsServer';

describe('syncDesktopToolsServer', () => {
  beforeEach(() => {
    state.desktopConfig = {
      serverPath: '/app/server.mjs',
      roots: [],
      command: '/app/AMC WebUI',
    };
    state.mounted = [];
    state.servers = [];
    state.writes = 0;
  });

  it('registers the server with the mounted folders as roots', () => {
    state.mounted = ['/home/me/project', '/home/me/notes'];
    syncDesktopToolsServer();

    expect(state.servers).toHaveLength(1);
    const server = state.servers[0];
    expect(server.id).toBe(DESKTOP_TOOLS_SERVER_ID);
    expect(server.args).toEqual(['/app/server.mjs', '/home/me/project', '/home/me/notes']);
  });

  it('rewrites the arguments when a folder is added', () => {
    state.mounted = ['/home/me/project'];
    syncDesktopToolsServer();
    expect(state.servers[0].args).toEqual(['/app/server.mjs', '/home/me/project']);

    state.mounted = ['/home/me/project', '/home/me/new'];
    syncDesktopToolsServer();
    expect(state.servers[0].args).toEqual(['/app/server.mjs', '/home/me/project', '/home/me/new']);
  });

  it('removes the server entirely when no folder is mounted', () => {
    state.mounted = ['/home/me/project'];
    syncDesktopToolsServer();
    expect(state.servers).toHaveLength(1);

    // A registered server with no roots would deny every call, which is worse
    // than not offering the tools at all.
    state.mounted = [];
    syncDesktopToolsServer();
    expect(state.servers).toHaveLength(0);
  });

  it('does not write when nothing changed', () => {
    state.mounted = ['/home/me/project'];
    syncDesktopToolsServer();
    const writesAfterFirst = state.writes;

    syncDesktopToolsServer();
    expect(state.writes).toBe(writesAfterFirst);
  });

  it('preserves the user disabling the server', () => {
    state.mounted = ['/home/me/project'];
    syncDesktopToolsServer();
    state.servers = [{ ...state.servers[0], enabled: false }];

    state.mounted = ['/home/me/project', '/home/me/other'];
    syncDesktopToolsServer();

    // A folder change must not silently re-enable something the user turned off.
    expect(state.servers[0].enabled).toBe(false);
    expect(state.servers[0].args).toContain('/home/me/other');
  });

  it('is a no-op outside the desktop build', () => {
    state.desktopConfig = null;
    state.mounted = ['/home/me/project'];
    syncDesktopToolsServer();
    expect(state.servers).toHaveLength(0);
  });
});
