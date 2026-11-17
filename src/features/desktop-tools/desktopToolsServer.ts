// Registers the bundled local file/PowerShell MCP server on first launch.
//
// The desktop shell injects a `desktopTools` block into runtime-config.js
// describing where the server script lives. Which directories it may touch is
// NOT injected: it comes from the workspace list the user manages in Settings,
// so adding or removing a folder takes effect by rewriting this server's
// arguments and reconnecting, without restarting the app.
//
// The capability remains an ordinary MCP server: it shows up in Settings → MCP,
// and the user can rename, disable or delete it like any other.
import { getDesktopToolsConfig } from '@/runtime/runtimeConfig';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
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
 * The server path is owned by the desktop shell, so an existing entry is
 * refreshed when the install moves (an app update to a new Program Files path).
 * The roots come from the workspace list, so adding a folder only rewrites
 * `args`. User choices such as `enabled` and `disabledTools` survive, and a
 * server the user disabled stays disabled.
 */
export function syncDesktopToolsServer(): void {
  const config = getDesktopToolsConfig();
  if (!config) {
    // Not a desktop build.
    return;
  }

  const { appSettings, setAppSettings, isSettingsLoaded } = useSettingsStore.getState();
  // Writing before the DB load finishes would be overwritten by loadSettings().
  if (!isSettingsLoaded) {
    return;
  }

  const roots = useWorkspaceStore.getState().mountedPaths();
  const servers = appSettings.mcpServers ?? [];
  const existing = servers.find((server) => server.id === DESKTOP_TOOLS_SERVER_ID);

  if (roots.length === 0) {
    // No workspace means the tools have nothing to work on. Remove the entry
    // rather than register a server that would deny every call.
    if (existing) {
      setAppSettings((prev) => ({
        ...prev,
        mcpServers: (prev.mcpServers ?? []).filter((server) => server.id !== DESKTOP_TOOLS_SERVER_ID),
      }));
    }
    return;
  }

  const desired = buildDesktopToolsServer({ ...config, roots });

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
 * Settings and workspaces both load asynchronously after mount, so this waits
 * for the first successful load of each and then syncs once. Later workspace
 * edits call `syncDesktopToolsServer` directly from the store subscription.
 */
export function initDesktopToolsMcpServer(): void {
  syncDesktopToolsServer();

  let settingsReady = useSettingsStore.getState().isSettingsLoaded;
  let workspacesReady = useWorkspaceStore.getState().isLoaded;

  const maybeSync = () => {
    if (!settingsReady || !workspacesReady) return;
    syncDesktopToolsServer();
  };

  useSettingsStore.subscribe((state) => {
    if (settingsReady || !state.isSettingsLoaded) return;
    settingsReady = true;
    maybeSync();
  });

  useWorkspaceStore.subscribe((state) => {
    if (workspacesReady || !state.isLoaded) return;
    workspacesReady = true;
    maybeSync();
  });

  // Every accepted workspace mutation rewrites the server arguments. This is
  // the whole "add a folder" flow: the store changes, the MCP config follows,
  // and the MCP client reconnects the server on next use.
  useWorkspaceStore.subscribe((state, previous) => {
    if (!state.isLoaded) return;
    if (state.workspaces === previous.workspaces) return;
    syncDesktopToolsServer();
  });
}
