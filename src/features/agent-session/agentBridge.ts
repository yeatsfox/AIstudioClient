/**
 * Renderer-side access to the native agent harness bridge.
 *
 * The bridge is only present in the desktop shell (`preload.cjs`). In the
 * browser build there is no way to spawn a local process at all, so every
 * entry point here degrades to a typed "unsupported" answer instead of
 * throwing or pretending the feature works.
 */

export type AgentHarnessBridge = {
  detect: () => Promise<HarnessDetection[]>;
  start: (options: { harness: string; cwd: string; model?: string; mode?: string }) => Promise<
    { sessionId: string } | { error: string }
  >;
  send: (sessionId: string, prompt: string) => Promise<{ ok?: boolean; error?: string }>;
  stop: (sessionId: string) => Promise<{ ok?: boolean }>;
  onEvent: (listener: (payload: AgentBridgeEvent) => void) => () => void;
};

export type HarnessDetection = {
  id: string;
  label: string;
  installed: boolean;
  path: string | null;
};

export type AgentBridgeEvent =
  | { sessionId: string; stream: 'stdout'; line: string }
  | { sessionId: string; stream: 'stderr'; line: string }
  | {
      sessionId: string;
      stream: 'exit';
      code: number | null;
      signal?: string | null;
      error?: string;
      stderr?: string;
      stopped?: boolean;
    };

declare global {
  interface Window {
    __AMC_DESKTOP__?: {
      pickDirectory?: () => Promise<{ path: string; title: string } | null>;
      isDesktop?: boolean;
      agents?: AgentHarnessBridge;
    };
  }
}

/** The bridge when running in the desktop shell, otherwise null. */
export const getAgentBridge = (): AgentHarnessBridge | null => {
  if (typeof window === 'undefined') return null;
  return window.__AMC_DESKTOP__?.agents ?? null;
};

export const isAgentHarnessAvailable = (): boolean => getAgentBridge() !== null;
