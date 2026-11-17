// Registers the bundled local file/PowerShell MCP server on first launch.
//
// The desktop shell injects a `desktopTools` block into runtime-config.js
// describing where the server script lives and which directories it may touch.
// This module turns that into a normal `McpServerConfig`, so the capability is
// just a configured MCP server: users can rename it, disable it, or point it at
// different folders in Settings → MCP, exactly like a hand-added server.
import { getDesktopToolsConfig } from '@/runtime/runtimeConfig';
import { useSettingsStore } from '@/stores/settingsStore';
import type { McpServerConfig } from '@/types';

/** Stable id so re-runs update the existing entry instead of adding duplicates. */
export const DESKTOP_TOOLS_SERVER_ID = 'amc_desktop_tools';

/**
 * Write tools and shell execution always ask first; only the read tools skip
 * the dialog. Everything else (write_file, replace_in_file, run_powershell)
 * stays in the approval path defined in `features/mcp/toolApproval.ts`.
 */
const AUTO_APPROVED_TOOLS = ['list_dir', 'read_file', 'search_files'];

export function buildDesktopToolsServer(config: {
  serverPath: string;
  roots: string[];
  command: string;
}): McpServerConfig {
  return {
    id: DESKTOP_TOOLS_SERVER_ID,
    name: '本地文件与 PowerShell',
    enabled: true,
    transport: 'stdio',
    command: config.command,
    // Roots are separate arguments, so a path containing spaces is not split.
    args: [config.serverPath, ...config.roots],
    // The desktop shell launches the server with the Electron binary, which only
    // behaves as a plain Node runtime when this flag is set. The MCP client
    // passes only a whitelist of environment variables, so the flag has to
    // travel in the server's own `env` or the child exits immediately.
    env: { ELECTRON_RUN_AS_NODE: '1' },
    autoApproveTools: AUTO_APPROVED_TOOLS,
    isTrusted: false,
    timeout: 180,
  };
}

/**
 * The server path and roots are owned by the desktop shell, so an existing
 * entry is refreshed when the install moves (an app update to a new Program
 * Files path). User choices such as `enabled` and `disabledTools` survive.
 */
export function syncDesktopToolsServer(): void {
  const config = getDesktopToolsConfig();
  if (!config || config.roots.length === 0) {
    // Not a desktop build, or the shell passed no usable folder.
    return;
  }

  const { appSettings, setAppSettings, isSettingsLoaded } = useSettingsStore.getState();
  // Writing before the DB load finishes would be overwritten by loadSettings().
  if (!isSettingsLoaded) {
    return;
  }

  const servers = appSettings.mcpServers ?? [];
  const existing = servers.find((server) => server.id === DESKTOP_TOOLS_SERVER_ID);
  const desired = buildDesktopToolsServer(config);

  if (!existing) {
    setAppSettings((prev) => ({
      ...prev,
      mcpServers: [...(prev.mcpServers ?? []), desired],
    }));
    return;
  }

  const unchanged =
    existing.command === desired.command &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(desired.args ?? []) &&
    JSON.stringify(existing.env ?? {}) === JSON.stringify(desired.env ?? {});
  if (unchanged) {
    return;
  }

  setAppSettings((prev) => ({
    ...prev,
    mcpServers: (prev.mcpServers ?? []).map((server) =>
      server.id === DESKTOP_TOOLS_SERVER_ID
        ? { ...server, command: desired.command, args: desired.args, env: desired.env }
        : server,
    ),
  }));
}

/**
 * Settings load asynchronously after mount, so this subscribes until the first
 * load completes and then syncs once.
 */
export function initDesktopToolsMcpServer(): void {
  syncDesktopToolsServer();

  let done = false;
  const unsubscribe = useSettingsStore.subscribe((state) => {
    if (done || !state.isSettingsLoaded) return;
    done = true;
    syncDesktopToolsServer();
    unsubscribe();
  });
}
