import { create } from 'zustand';
import {
  isPermissionNotice,
  parseAgentStreamLine,
  readStepTextDelta,
  readPermissionRequest,
  type AgentStep,
  type AgentUsage,
  type PermissionRequest,
} from './agentStreamParser';

/**
 * One rendered block inside an agent turn. Tool steps and text are both
 * blocks so a turn renders in the order the agent produced it, instead of a
 * wall of text with the tool calls hidden in a log.
 */
export type AgentBlock =
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      toolName: string;
      parameters?: Record<string, unknown>;
      output?: string;
      error?: string;
      state: 'running' | 'done' | 'failed';
      durationSeconds?: number;
    };

export type AgentTurn = {
  id: string;
  prompt: string;
  status: 'running' | 'succeeded' | 'failed' | 'stopped';
  blocks: AgentBlock[];
  errorMessage?: string;
  usage?: AgentUsage;
  durationSeconds?: number;
  /**
   * Tools the CLI could not obtain approval for.
   *
   * `request` is null when the notice named a tool but no buildable rule, in
   * which case the raw text is shown with no approve button: offering an
   * approval that would write a guessed rule is worse than offering none.
   */
  permissionNotices: AgentPermissionNotice[];
};

export type AgentPermissionNotice = {
  notice: string;
  request: PermissionRequest | null;
  /** Set once the user acts, so the same notice is not offered twice. */
  resolution?: { status: 'allowed'; rule: string } | { status: 'failed'; message: string };
};

export type HarnessId = 'antigravity';

export type HarnessInfo = {
  id: HarnessId | string;
  label: string;
  installed: boolean;
  path: string | null;
};

export type AgentConnectionState = 'idle' | 'starting' | 'ready' | 'exited' | 'unsupported';

export interface AgentSessionState {
  /** Which harness this tab is driving. */
  harness: HarnessId;
  availableHarnesses: HarnessInfo[];
  /** Resolved working folder; agents act on whichever directory they are given. */
  cwd: string;
  /** Optional model override passed to the CLI. */
  model: string;
  connection: AgentConnectionState;
  /** CLI session id from its `init` event, useful when resuming. */
  conversationId?: string;
  permissionMode?: string;
  turns: AgentTurn[];
  /** Last failure of the transport itself (not of a turn). */
  transportError?: string;
  busy: boolean;
  /** Path of the running conversation process, owned by the main process. */
  sessionId?: string;
}

interface AgentSessionActions {
  setHarness: (harness: HarnessId) => void;
  setAvailableHarnesses: (harnesses: HarnessInfo[]) => void;
  setCwd: (cwd: string) => void;
  setModel: (model: string) => void;
  setConnection: (connection: AgentConnectionState) => void;
  setBusy: (busy: boolean) => void;
  setSessionId: (sessionId: string | undefined) => void;
  setTransportError: (error: string | undefined) => void;
  /** Append a prompt the user just sent and begin a turn. */
  beginTurn: (prompt: string) => string;
  /** Apply one NDJSON line from the CLI. */
  applyStreamLine: (line: string) => void;
  /** Settle the turn after the process exits without a `result` event. */
  settleExit: (payload: { code: number | null; stderr?: string; stopped?: boolean }) => void;

  /**
   * Record the outcome of an approval so the UI can stop offering it.
   *
   * The write itself happens in the main process; this only reflects it. Keyed
   * by the notice text because that is what the user saw and clicked.
   */
  resolvePermission: (
    notice: string,
    resolution: { status: 'allowed'; rule: string } | { status: 'failed'; message: string },
  ) => void;

  reset: () => void;
}

const INITIAL_STATE: AgentSessionState = {
  harness: 'antigravity',
  availableHarnesses: [],
  cwd: '',
  model: '',
  connection: 'idle',
  turns: [],
  busy: false,
};

let blockSeq = 0;
const nextBlockId = () => `block-${++blockSeq}`;
let turnSeq = 0;
const nextTurnId = () => `turn-${++turnSeq}`;

const lastTurn = (turns: AgentTurn[]): AgentTurn | undefined => turns[turns.length - 1];

/**
 * The parsed step intentionally omits `text_delta` (it describes a step's
 * shape, not its streaming content), so the raw payload is read for the delta.
 * The line was already validated by `parseAgentStreamLine`.
 */
const readRawStepUpdate = (line: string): unknown => {
  try {
    return (JSON.parse(line) as { step_update?: unknown }).step_update ?? null;
  } catch {
    return null;
  }
};

/**
 * Find or create the block a step belongs to.
 *
 * Steps arrive repeatedly for the same `step_index` (ACTIVE deltas then DONE),
 * so a tool step maps to a stable block and text accumulates in place rather
 * than creating a block per delta.
 */
const locateBlock = (
  blocks: AgentBlock[],
  step: AgentStep,
): { index: number; block?: AgentBlock } => {
  // Tools are keyed by index because each invocation is its own step.
  if (step.kind === 'tool') {
    const index = blocks.findIndex((b) => b.kind === 'tool' && b.id === `tool-step-${step.index}`);
    return { index, block: index >= 0 ? blocks[index] : undefined };
  }
  // Text steps: append to the trailing text block while it is still open. A
  // new agent_response step index starts a fresh block.
  if (step.kind === 'agent_response') {
    const marker = `text-step-${step.index}`;
    const index = blocks.findIndex((b) => b.kind === 'text' && b.id === marker);
    return { index, block: index >= 0 ? blocks[index] : undefined };
  }
  return { index: -1 };
};

export const useAgentSessionStore = create<AgentSessionState & AgentSessionActions>()((set) => ({
  ...INITIAL_STATE,

  setHarness: (harness) => set({ harness }),
  setAvailableHarnesses: (availableHarnesses) => set({ availableHarnesses }),
  setCwd: (cwd) => set({ cwd }),
  setModel: (model) => set({ model }),
  setConnection: (connection) => set({ connection }),
  setBusy: (busy) => set({ busy }),
  setSessionId: (sessionId) => set({ sessionId }),
  setTransportError: (transportError) => set({ transportError }),

  beginTurn: (prompt) => {
    const id = nextTurnId();
    set((state) => ({
      busy: true,
      turns: [...state.turns, { id, prompt, status: 'running', blocks: [], permissionNotices: [] }],
    }));
    return id;
  },

  applyStreamLine: (line) => {
    const event = parseAgentStreamLine(line);
    if (!event) return;

    if (event.type === 'init') {
      set({ connection: 'ready', conversationId: event.conversationId, permissionMode: event.permissionMode });
      return;
    }

    if (event.type === 'result') {
      set((state) => {
        const turns = [...state.turns];
        const turn = lastTurn(turns);
        if (!turn) return { busy: false };
        const failed = event.result.status !== 'SUCCESS';
        const updated: AgentTurn = {
          ...turn,
          status: failed ? 'failed' : 'succeeded',
          errorMessage: event.result.error,
          usage: event.result.usage,
          durationSeconds: event.result.durationSeconds,
          // The result's response is the authoritative full text; a run that
          // streamed nothing still gets its answer from here.
          blocks: turn.blocks.length > 0 ? turn.blocks : event.result.response
            ? [{ kind: 'text', id: nextBlockId(), text: event.result.response }]
            : [],
        };
        turns[turns.length - 1] = updated;
        return {
          turns,
          busy: false,
          conversationId: event.result.conversationId ?? state.conversationId,
        };
      });
      return;
    }

    if (event.type !== 'step') return;

    const delta = event.step.kind === 'agent_response' ? readStepTextDelta(readRawStepUpdate(line)) : '';

    set((state) => {
      const turns = [...state.turns];
      const turn = lastTurn(turns);
      if (!turn) return {};

      // Checkpoints are bookkeeping, not something a user reads.
      if (event.step.kind === 'checkpoint' || event.step.kind === 'user_input') return {};

      const { index, block } = locateBlock(turn.blocks, event.step);
      const blocks = [...turn.blocks];

      if (event.step.kind === 'agent_response') {
        const marker = `text-step-${event.step.index}`;
        if (index >= 0 && block?.kind === 'text') {
          if (delta) blocks[index] = { ...block, text: block.text + delta };
        } else if (delta) {
          blocks.push({ kind: 'text', id: marker, text: delta });
        }
      } else if (event.step.kind === 'tool') {
        const marker = `tool-step-${event.step.index}`;
        const toolState: 'running' | 'done' | 'failed' = event.step.toolError
          ? 'failed'
          : event.step.state === 'DONE'
            ? 'done'
            : 'running';
        const nextBlock: AgentBlock = {
          kind: 'tool',
          id: marker,
          toolName: event.step.toolName || 'tool',
          parameters: event.step.toolParameters ?? (block?.kind === 'tool' ? block.parameters : undefined),
          output: event.step.toolOutput ?? (block?.kind === 'tool' ? block.output : undefined),
          error: event.step.toolError,
          state: toolState,
          durationSeconds: event.step.durationSeconds,
        };
        if (index >= 0) blocks[index] = nextBlock;
        else blocks.push(nextBlock);
      } else {
        return {};
      }

      turns[turns.length - 1] = { ...turn, blocks };
      return { turns };
    });
  },

  settleExit: ({ code, stderr, stopped }) => {
    set((state) => {
      const turns = [...state.turns];
      const turn = lastTurn(turns);
      // The CLI can repeat the same notice; one entry per distinct line keeps
      // the approve list from filling with duplicates the user cannot tell apart.
      const seen = new Set<string>();
      const notices: AgentPermissionNotice[] = [];
      for (const line of (stderr || '').split('\n')) {
        const text = line.trim();
        if (!text || seen.has(text) || !isPermissionNotice(text)) continue;
        seen.add(text);
        notices.push({ notice: text, request: readPermissionRequest(text) });
      }

      if (turn && turn.status === 'running') {
        // No `result` event: the process died mid-turn, which is a failure the
        // user must see rather than a turn that spins forever.
        turns[turns.length - 1] = {
          ...turn,
          status: stopped ? 'stopped' : 'failed',
          errorMessage: turn.errorMessage || (stopped ? undefined : `The agent exited with code ${code ?? 'unknown'}.`),
          permissionNotices: [...turn.permissionNotices, ...notices],
        };
      }

      return {
        turns,
        busy: false,
        connection: 'exited',
        sessionId: undefined,
        transportError: !stopped && code ? `The agent exited with code ${code}.` : state.transportError,
      };
    });
  },

  resolvePermission: (notice, resolution) =>
    set((state) => ({
      turns: state.turns.map((turn) => ({
        ...turn,
        permissionNotices: turn.permissionNotices.map((entry) =>
          entry.notice === notice ? { ...entry, resolution } : entry,
        ),
      })),
    })),

  reset: () =>
    set((state) => ({
      ...INITIAL_STATE,
      // Spread alone would leave a previously-set key (conversationId,
      // permissionMode, transportError) behind, since zustand's set merges.
      conversationId: undefined,
      permissionMode: undefined,
      transportError: undefined,
      sessionId: undefined,
      // Keep the user's choice of harness and folder across a reset.
      availableHarnesses: state.availableHarnesses,
      harness: state.harness,
      cwd: state.cwd,
      model: state.model,
    })),
}));
