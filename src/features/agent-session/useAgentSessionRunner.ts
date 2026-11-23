import { useCallback, useEffect, useRef } from 'react';
import { getAgentBridge, type AgentBridgeEvent } from './agentBridge';
import { useAgentSessionStore } from './agentSessionStore';

/**
 * Owns the transport between this tab and its agent process.
 *
 * One process per conversation: the first prompt starts it, later prompts are
 * written to the same stdin so the agent keeps its context and its warm start.
 * Events from every harness are funneled here and applied to the store, so the
 * components stay presentational.
 */
export const useAgentSessionRunner = () => {
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);

  const store = useAgentSessionStore;

  // Subscribe once for the lifetime of the tab. The handler reads its own
  // sessionId from the payload and ignores anything that is not ours, so a
  // stale process from a previous conversation cannot write into this one.
  useEffect(() => {
    const bridge = getAgentBridge();
    if (!bridge) return;

    const handle = (payload: AgentBridgeEvent) => {
      const state = store.getState();
      if (payload.sessionId !== state.sessionId) return;

      if (payload.stream === 'stdout') {
        state.applyStreamLine(payload.line);
        return;
      }
      if (payload.stream === 'stderr') {
        // stderr carries progress, auth prompts and permission notices. A
        // permission notice only becomes visible if the process exits, so it
        // is accumulated by settleExit from the tail the main process sends.
        return;
      }
      state.settleExit({ code: payload.code, stderr: payload.stderr, stopped: payload.stopped });
    };

    unsubscribeRef.current = bridge.onEvent(handle);
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [store]);

  const ensureProcess = useCallback(async (): Promise<string | null> => {
    const state = store.getState();
    if (state.sessionId) return state.sessionId;
    if (startingRef.current) return null;
    if (!state.cwd) {
      store.getState().setTransportError('Choose a working folder first.');
      return null;
    }

    const bridge = getAgentBridge();
    if (!bridge) {
      store.getState().setConnection('unsupported');
      store.getState().setTransportError('Agent sessions need the desktop app.');
      return null;
    }

    startingRef.current = true;
    store.getState().setConnection('starting');
    try {
      const result = await bridge.start({
        harness: state.harness,
        cwd: state.cwd,
        model: state.model || undefined,
      });
      if ('error' in result) {
        store.getState().setConnection('exited');
        store.getState().setTransportError(result.error);
        return null;
      }
      store.getState().setSessionId(result.sessionId);
      return result.sessionId;
    } finally {
      startingRef.current = false;
    }
  }, [store]);

  const send = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const state = store.getState();
      if (state.busy) return;

      // The turn is created before the process starts so a startup failure is
      // visible as a failed turn rather than a message that vanishes.
      store.getState().beginTurn(trimmed);

      const bridge = getAgentBridge();
      const sessionId = await ensureProcess();
      if (!sessionId || !bridge) {
        const reason = store.getState().transportError || 'The agent could not be started.';
        const turns = store.getState().turns;
        const last = turns[turns.length - 1];
        if (last && last.status === 'running') {
          store.getState().settleExit({ code: null, stderr: reason });
        }
        return;
      }

      const sent = await bridge.send(sessionId, trimmed);
      if ('error' in sent && sent.error) {
        store.getState().setTransportError(sent.error);
        store.getState().settleExit({ code: null, stderr: sent.error });
      }
    },
    [ensureProcess, store],
  );

  const stop = useCallback(async () => {
    const state = store.getState();
    const bridge = getAgentBridge();
    const sessionId = state.sessionId;
    if (bridge && sessionId) {
      await bridge.stop(sessionId);
    }
    store.getState().settleExit({ code: null, stopped: true });
  }, [store]);

  /** Drop the conversation and release the process, keeping folder/model. */
  const restartConversation = useCallback(async () => {
    const state = store.getState();
    const bridge = getAgentBridge();
    if (bridge && state.sessionId) {
      await bridge.stop(state.sessionId);
    }
    store.getState().reset();
  }, [store]);

  const detect = useCallback(async () => {
    const bridge = getAgentBridge();
    if (!bridge) {
      // Nothing to detect without a bridge. Leave the state untouched: writing
      // an empty list here would erase a "CLI is missing" answer that
      // detection already produced, and the view would lose the reason.
      return;
    }
    try {
      const harnesses = await bridge.detect();
      store.getState().setAvailableHarnesses(harnesses);
      store.getState().setConnection('idle');
    } catch {
      store.getState().setConnection('unsupported');
    }
  }, [store]);

  return { send, stop, restartConversation, detect };
};
