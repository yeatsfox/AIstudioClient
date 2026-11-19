import type { ModelCapabilities, ModelOption } from '@/types';

/**
 * What we actually know about one capability.
 *
 * 'unknown' is not a cosmetic third state. The previous code collapsed it into a
 * boolean: a model absent from the catalog got `tools: true` because the regex
 * did not match, and `thinking: false` because it did not match either. Those
 * two answers look just as certain as a hard-coded `true`, so the UI could not
 * tell the user "we think so" from "we looked and it does not". That is how a
 * model ends up silently losing tool calling with no explanation.
 */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export type CapabilityKey = keyof ModelCapabilities;

export interface CapabilityFact {
  key: CapabilityKey;
  state: CapabilityState;
  /** Where the answer came from, for the tooltip. */
  source: 'declared' | 'catalog' | 'inferred' | 'none';
}

export interface CapabilityManifest {
  modelId: string;
  facts: CapabilityFact[];
  /** Capabilities that are effectively on for this model. */
  enabled: CapabilityKey[];
  /** Capabilities the user may want to check manually. */
  unverified: CapabilityKey[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

export const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  'vision',
  'thinking',
  'tools',
  'webSearch',
  'image',
  'embedding',
  'audio',
  'free',
];

export const CAPABILITY_I18N_KEYS: Record<CapabilityKey, string> = {
  vision: 'modelCapabilityVision',
  thinking: 'modelCapabilityThinking',
  tools: 'modelCapabilityTools',
  webSearch: 'modelCapabilityWebSearch',
  image: 'modelCapabilityImage',
  embedding: 'modelCapabilityEmbedding',
  audio: 'modelCapabilityAudio',
  free: 'modelCapabilityFree',
};

interface BuildManifestInput {
  model: ModelOption;
  /** Catalog entry, when the id is known. */
  catalogCapabilities?: ModelCapabilities;
  /** Regex-derived guess, when it is not. */
  inferredCapabilities?: ModelCapabilities;
  /** Model ids come back in mixed case; the caller normalizes as it prefers. */
  isKnown?: boolean;
}

const stateOf = (value: boolean | undefined): CapabilityState =>
  value === true ? 'supported' : value === false ? 'unsupported' : 'unknown';

/**
 * Builds the per-model capability list shown in the UI.
 *
 * Precedence matches getOrInferModelCapabilities so the manifest cannot disagree
 * with what the app actually does: user declaration beats catalog beats guess.
 * Crucially, an absent guess stays 'unknown' instead of becoming 'supported' or
 * 'unsupported', so the manifest never overstates its confidence.
 */
export const buildCapabilityManifest = ({
  model,
  catalogCapabilities,
  inferredCapabilities,
  isKnown = false,
}: BuildManifestInput): CapabilityManifest => {
  const declared = model.capabilities ?? {};
  const facts: CapabilityFact[] = CAPABILITY_KEYS.map((key) => {
    const declaredValue = declared[key];
    if (declaredValue !== undefined) {
      return { key, state: stateOf(declaredValue), source: 'declared' };
    }
    const catalogValue = catalogCapabilities?.[key];
    if (catalogValue !== undefined) {
      return { key, state: stateOf(catalogValue), source: 'catalog' };
    }
    const inferredValue = inferredCapabilities?.[key];
    if (isKnown && inferredValue !== undefined) {
      return { key, state: stateOf(inferredValue), source: 'inferred' };
    }
    return { key, state: 'unknown', source: 'none' };
  });

  const enabled = facts.filter((fact) => fact.state === 'supported').map((fact) => fact.key);

  return {
    modelId: model.id,
    facts,
    enabled,
    unverified: facts.filter((fact) => fact.state === 'unknown').map((fact) => fact.key),
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
    maxOutputTokens: typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : null,
  };
};

/** One-line summary for a picker row or tooltip: "Vision, Tools · 2 unverified". */
export const summarizeCapabilityManifest = (
  manifest: CapabilityManifest,
  formatCount: (count: number) => string = String,
): string => {
  const parts: string[] = [...manifest.enabled];
  if (manifest.unverified.length > 0) {
    parts.push(formatCount(manifest.unverified.length));
  }
  return parts.join(', ');
};

/** Formats a context window as 128K / 1M, or null when nothing is known. */
export const formatTokenWindow = (tokens: number | null): string | null => {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
};
