import { isRecord } from './predicates.js';

export type McpServerTransport = 'stdio' | 'http' | 'sse';
export type McpServerAuthType = 'none' | 'bearer' | 'customHeaders';

export interface McpServerAuthConfig {
  type: McpServerAuthType;
  token?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpServerTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: McpServerAuthConfig;
  disabledTools?: string[];
  /**
   * Tools that run without asking the user first. Approval is the default, so
   * this is the only way a tool skips the confirmation dialog (see
   * `src/features/mcp/toolApproval.ts`).
   */
  autoApproveTools?: string[];
  /** Legacy deny-list; still honoured and wins over `autoApproveTools`. */
  disabledAutoApproveTools?: string[];
  isTrusted?: boolean;
  /**
   * Set once the user has flipped this server's switch by hand. Until then an
   * `enabled: false` is not a decision, it is just an entry that was never
   * turned on — the bundled local tools server registers itself enabled, and a
   * user who adds a workspace plainly means "let the model read this folder".
   * Without the distinction, either the folder silently stays unreachable or
   * every sync re-enables a server the user deliberately switched off.
   */
  enabledByUser?: boolean;
  /** Per-server tool-call timeout in seconds (1..3600). */
  timeout?: number;
  /** Long-running tools keep the connection alive on progress notifications. */
  longRunning?: boolean;
}

export const sanitizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
};

export const sanitizeStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export const sanitizeMcpAuth = (value: unknown): McpServerAuthConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === 'none' || value.type === 'customHeaders') {
    return { type: value.type };
  }

  if (value.type === 'bearer') {
    const token = typeof value.token === 'string' ? value.token.trim() : '';
    return {
      type: 'bearer',
      ...(token ? { token } : {}),
    };
  }

  return undefined;
};

export const isValidMcpHttpUrl = (value: string): boolean => {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Integer seconds in [1, 3600]; anything else is dropped. */
export const sanitizeMcpTimeout = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < 1 || value > 3600) {
    return undefined;
  }
  return value;
};
