import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopToolsServer, DESKTOP_TOOLS_SERVER_ID } from './desktopToolsServer';

const mockConfig = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/runtime/runtimeConfig', () => ({
  getDesktopToolsConfig: () => mockConfig.value,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      appSettings: { mcpServers: [] },
      setAppSettings: () => undefined,
      isSettingsLoaded: true,
    }),
    subscribe: () => () => undefined,
  },
}));

describe('buildDesktopToolsServer', () => {
  beforeEach(() => {
    mockConfig.value = null;
  });

  it('maps the injected config to a stdio MCP server', () => {
    const server = buildDesktopToolsServer({
      serverPath: 'C:\\app\\desktop-tools-mcp\\server.mjs',
      roots: ['D:\\work'],
      command: 'C:\\app\\AMC WebUI.exe',
    });

    expect(server.id).toBe(DESKTOP_TOOLS_SERVER_ID);
    expect(server.transport).toBe('stdio');
    expect(server.enabled).toBe(true);
    expect(server.command).toBe('C:\\app\\AMC WebUI.exe');
    // The script path comes first, then every allowed root as its own argument.
    expect(server.args).toEqual(['C:\\app\\desktop-tools-mcp\\server.mjs', 'D:\\work']);
  });

  it('sets ELECTRON_RUN_AS_NODE so the Electron binary acts as Node', () => {
    const server = buildDesktopToolsServer({
      serverPath: 'C:\\app\\server.mjs',
      roots: ['D:\\work'],
      command: 'C:\\app\\AMC WebUI.exe',
    });

    // Without this the child process starts the GUI instead of the script and
    // the MCP connection closes immediately.
    expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('auto-approves only the read-only tools', () => {
    const server = buildDesktopToolsServer({ serverPath: 's.mjs', roots: ['D:\\work'], command: 'node' });

    expect(server.autoApproveTools).toEqual(['list_dir', 'read_file', 'search_files']);
    // Anything that changes disk state or runs a shell must stay behind the
    // approval dialog.
    for (const gated of ['write_file', 'replace_in_file', 'run_powershell']) {
      expect(server.autoApproveTools).not.toContain(gated);
    }
  });

  it('does not mark the server trusted', () => {
    const server = buildDesktopToolsServer({ serverPath: 's.mjs', roots: ['D:\\work'], command: 'node' });
    expect(server.isTrusted).toBe(false);
  });

  it('keeps the server in the approval path by default', () => {
    const server = buildDesktopToolsServer({ serverPath: 's.mjs', roots: ['D:\\work'], command: 'node' });
    expect(server.disabledAutoApproveTools ?? []).not.toContain('read_file');
  });
});
