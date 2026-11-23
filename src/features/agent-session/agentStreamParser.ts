/**
 * Parser for Antigravity CLI `--output-format stream-json` output.
 *
 * The CLI writes NDJSON: one JSON object per line. Three event kinds exist:
 *   - `init`        once, at stream start (cwd, tools, permission_mode, model)
 *   - `step_update` per step transition or text delta
 *   - `result`      once, at the end (status, response, usage)
 *
 * Parsing is deliberately tolerant. The CLI is a separate program with its own
 * release cadence, so an unknown `step_type`, a missing field or a future event
 * kind must degrade into something visible rather than throwing and taking the
 * whole conversation down with it.
 */

/** A single step inside a turn, as far as the UI cares about. */
export type AgentStep = {
  index: number;
  kind: 'user_input' | 'agent_response' | 'tool' | 'checkpoint' | 'unknown';
  state: 'ACTIVE' | 'DONE';
  toolName?: string;
  /** Tool arguments, already unpacked for display. */
  toolParameters?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  durationSeconds?: number;
};

export type AgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
};

export type AgentRunResult = {
  conversationId?: string;
  status: string;
  response: string;
  error?: string;
  durationSeconds?: number;
  numTurns?: number;
  usage?: AgentUsage;
};

export type AgentStreamEvent =
  | { type: 'init'; conversationId?: string; cwd?: string; tools: string[]; permissionMode?: string; model?: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'result'; result: AgentRunResult }
  | { type: 'unknown'; event: string };

const toNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const normalizeStepKind = (raw: unknown): AgentStep['kind'] => {
  switch (raw) {
    case 'user_input':
    case 'agent_response':
    case 'tool':
    case 'checkpoint':
      return raw;
    default:
      return 'unknown';
  }
};

const parseUsage = (raw: unknown): AgentUsage | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const usage: AgentUsage = {
    inputTokens: toNumber(source.input_tokens),
    outputTokens: toNumber(source.output_tokens),
    thinkingTokens: toNumber(source.thinking_tokens),
    cacheReadTokens: toNumber(source.cache_read_tokens),
    totalTokens: toNumber(source.total_tokens),
  };
  // An all-undefined usage object is noise; report "unknown" instead.
  const hasAny = Object.values(usage).some((value) => value !== undefined);
  return hasAny ? usage : undefined;
};

/**
 * `tool_info` carries the invocation and its result. The failure shape nests an
 * `error` object with `type` and `message`, so flatten it for display.
 */
const parseToolInfo = (
  raw: unknown,
): { parameters?: Record<string, unknown>; output?: string; error?: string } => {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const parameters =
    source.parameters && typeof source.parameters === 'object'
      ? (source.parameters as Record<string, unknown>)
      : undefined;

  let error: string | undefined;
  const rawError = source.error;
  if (typeof rawError === 'string') {
    error = rawError;
  } else if (rawError && typeof rawError === 'object') {
    const errObj = rawError as Record<string, unknown>;
    const message = toString(errObj.message);
    const type = toString(errObj.type);
    error = message || type;
  }

  return {
    parameters,
    output: typeof source.output === 'string' ? source.output : undefined,
    error,
  };
};

const parseStep = (raw: unknown): AgentStep | null => {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const index = toNumber(source.step_index);
  if (index === undefined) return null;

  const state = source.state === 'ACTIVE' ? 'ACTIVE' : 'DONE';
  const kind = normalizeStepKind(source.step_type);
  const toolInfo = kind === 'tool' ? parseToolInfo(source.tool_info) : {};

  return {
    index,
    kind,
    state,
    toolName: toString(source.tool_name),
    toolParameters: toolInfo.parameters,
    toolOutput: toolInfo.output,
    toolError: toolInfo.error,
    durationSeconds: toNumber(source.duration_seconds),
  };
};

const parseResult = (raw: unknown): AgentRunResult | null => {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const status = toString(source.status);
  if (!status) return null;

  return {
    conversationId: toString(source.conversation_id),
    status,
    response: typeof source.response === 'string' ? source.response : '',
    error: toString(source.error),
    durationSeconds: toNumber(source.duration_seconds),
    numTurns: toNumber(source.num_turns),
    usage: parseUsage(source.usage),
  };
};

/** Parse one NDJSON line. Returns null for blank or malformed lines. */
export const parseAgentStreamLine = (line: string): AgentStreamEvent | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const envelope = payload as Record<string, unknown>;
  const eventName = toString(envelope.event);

  switch (eventName) {
    case 'init': {
      const initRaw = envelope.init;
      const init = initRaw && typeof initRaw === 'object' ? (initRaw as Record<string, unknown>) : {};
      const tools = Array.isArray(init.tools) ? init.tools.filter((t): t is string => typeof t === 'string') : [];
      return {
        type: 'init',
        conversationId: toString(envelope.conversation_id) ?? toString(init.conversation_id),
        cwd: toString(init.cwd),
        tools,
        permissionMode: toString(init.permission_mode),
        model: toString(init.model),
      };
    }
    case 'step_update': {
      const step = parseStep(envelope.step_update);
      return step ? { type: 'step', step } : null;
    }
    case 'result': {
      const result = parseResult(envelope.result);
      return result ? { type: 'result', result } : null;
    }
    default:
      return eventName ? { type: 'unknown', event: eventName } : null;
  }
};

/** Extract the incremental text of an `agent_response` step, if any. */
export const readStepTextDelta = (stepPayload: unknown): string => {
  if (!stepPayload || typeof stepPayload !== 'object') return '';
  const delta = (stepPayload as Record<string, unknown>).text_delta;
  return typeof delta === 'string' ? delta : '';
};

/**
 * Recognize the "tool was soft-denied" notice.
 *
 * In headless mode an approval the CLI cannot obtain is soft-denied: the run
 * continues, exits 0, and prints a notice on stderr naming the tool and how to
 * allow it. That notice is the only signal that the agent wanted to do
 * something and was blocked, so the UI must surface it rather than leave the
 * user wondering why a file was never written.
 */
export const isPermissionNotice = (line: string): boolean => {
  const lower = line.toLowerCase();
  // Mention of any tool/action vocabulary plus a blocking verb. Kept as two
  // independent signals so unrelated stderr (auth prompts, progress) does not
  // masquerade as a permission notice.
  const mentionsPermission =
    lower.includes('permission') ||
    lower.includes('approval') ||
    lower.includes('not allowed') ||
    lower.includes('tool') ||
    lower.includes('command') ||
    lower.includes('write_to_file') ||
    lower.includes('run_command');
  if (!mentionsPermission) return false;
  return (
    lower.includes('denied') ||
    lower.includes('not allowed') ||
    lower.includes('requires approval') ||
    lower.includes('not permitted') ||
    lower.includes('permission')
  );
};
