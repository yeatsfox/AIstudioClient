import type { McpServerCapabilities } from '@/services/api/mcpApi';
import type { McpStatus, McpServerState } from '@/stores/mcp/mcpStatusStore';

export type DeriveStatusResult = Pick<McpStatus, 'state' | 'lastError' | 'version'> & {
  lastCheckedAt: number;
};

type CapabilityError = McpServerCapabilities['errors'][number];

/**
 * Folds the per-endpoint errors into one line worth showing.
 *
 * Capabilities are fetched from three endpoints in parallel, so a single dead
 * server produces the same message three times. Showing it once keeps the card
 * readable; distinct causes are all kept because the second one is often the
 * real reason.
 */
export const summarizeCapabilityErrors = (errors: readonly CapabilityError[]): string | null => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of errors) {
    const message = entry.error?.trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    unique.push(message);
  }
  if (unique.length === 0) return null;
  return unique.join(' · ');
};

const hasAnyCapability = (cap: McpServerCapabilities): boolean =>
  cap.tools.length > 0 || cap.resources.length > 0 || cap.resourceTemplates.length > 0 || cap.prompts.length > 0;

/**
 * Derives MCP server state from capabilities / error / enabled flag.
 * Priority: disabled > error > connected > connecting
 *
 * "Has a capabilities object" is not the same as "is connected". The object is
 * also produced when every endpoint failed, and when the endpoints answered but
 * returned nothing at all. Counting either of those as connected paints a green
 * pill over a server that cannot be reached, which is worse than no status at
 * all. So connected requires actual data or at least one endpoint that worked.
 */
export const deriveStatus = (
  cap: McpServerCapabilities | null,
  error: string | null,
  enabled: boolean,
  serverId?: string,
): DeriveStatusResult => {
  const now = Date.now();
  if (!enabled) {
    return { state: 'disabled' as McpServerState, lastCheckedAt: now };
  }
  if (error) {
    return { state: 'error' as McpServerState, lastError: error, lastCheckedAt: now };
  }
  if (cap) {
    // A capabilities object that arrived over IPC may predate this field, so
    // treat a missing list as "no errors reported" rather than crashing.
    const errors = Array.isArray(cap.errors) ? cap.errors : [];
    const relevant = serverId === undefined ? errors : errors.filter((entry) => entry.serverId === serverId);
    const capabilityError = summarizeCapabilityErrors(relevant);
    const version = typeof cap.version === 'string' ? cap.version : undefined;

    if (hasAnyCapability(cap)) {
      // Partial success: the server is usable, but say which part is missing
      // rather than hiding it.
      return {
        state: 'connected' as McpServerState,
        lastCheckedAt: now,
        ...(capabilityError ? { lastError: capabilityError } : {}),
        ...(version ? { version } : {}),
      };
    }

    return {
      state: 'error' as McpServerState,
      lastError: capabilityError ?? 'no capabilities reported',
      lastCheckedAt: now,
    };
  }
  return { state: 'connecting' as McpServerState, lastCheckedAt: now };
};
