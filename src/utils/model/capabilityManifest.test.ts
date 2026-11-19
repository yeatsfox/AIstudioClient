import { describe, expect, it } from 'vitest';
import {
  buildCapabilityManifest,
  CAPABILITY_KEYS,
  formatTokenWindow,
  summarizeCapabilityManifest,
} from './capabilityManifest';
import type { ModelOption } from '@/types';
import type { CapabilityKey } from './capabilityManifest';

const model = (overrides: Partial<ModelOption> = {}): ModelOption => ({
  id: 'test-model',
  name: 'Test Model',
  ...overrides,
});

const factOf = (manifest: ReturnType<typeof buildCapabilityManifest>, key: CapabilityKey) =>
  manifest.facts.find((fact) => fact.key === key)!;

describe('buildCapabilityManifest', () => {
  it('reports every capability key, so nothing is silently omitted', () => {
    const manifest = buildCapabilityManifest({ model: model() });

    expect(manifest.facts.map((fact) => fact.key)).toEqual([...CAPABILITY_KEYS]);
  });

  it('prefers what the user declared over the catalog', () => {
    const manifest = buildCapabilityManifest({
      model: model({ capabilities: { vision: false } }),
      catalogCapabilities: { vision: true },
      isKnown: true,
    });

    expect(factOf(manifest, 'vision')).toEqual({ key: 'vision', state: 'unsupported', source: 'declared' });
  });

  it('uses the catalog when the model does not declare a value', () => {
    const manifest = buildCapabilityManifest({
      model: model(),
      catalogCapabilities: { thinking: true },
      isKnown: true,
    });

    expect(factOf(manifest, 'thinking').state).toBe('supported');
    expect(factOf(manifest, 'thinking').source).toBe('catalog');
  });

  it('keeps an unidentified model unverified instead of guessing yes or no', () => {
    // The whole point: with nothing declared, nothing in the catalog, and no
    // recognized id, the honest answer is "we do not know".
    const manifest = buildCapabilityManifest({ model: model({ id: 'some-new-model' }) });

    expect(factOf(manifest, 'tools').state).toBe('unknown');
    expect(factOf(manifest, 'thinking').state).toBe('unknown');
    expect(manifest.unverified.length).toBe(CAPABILITY_KEYS.length);
    expect(manifest.enabled).toEqual([]);
  });

  it('treats an explicit false as unsupported, not unknown', () => {
    const manifest = buildCapabilityManifest({
      model: model(),
      catalogCapabilities: { tools: false },
      isKnown: true,
    });

    expect(factOf(manifest, 'tools').state).toBe('unsupported');
    expect(manifest.unverified).not.toContain('tools');
  });

  it('ignores the regex guess for models the catalog does not know', () => {
    const manifest = buildCapabilityManifest({
      model: model({ id: 'mystery' }),
      inferredCapabilities: { tools: true, vision: false },
      isKnown: false,
    });

    expect(factOf(manifest, 'tools').state).toBe('unknown');
    expect(factOf(manifest, 'vision').state).toBe('unknown');
  });

  it('collects enabled capabilities', () => {
    const manifest = buildCapabilityManifest({
      model: model({ capabilities: { vision: true, tools: true, thinking: false } }),
    });

    expect(manifest.enabled).toEqual(['vision', 'tools']);
  });

  it('carries the context window through only when it is a number', () => {
    expect(buildCapabilityManifest({ model: model({ contextWindow: 128000 }) }).contextWindow).toBe(128000);
    expect(buildCapabilityManifest({ model: model() }).contextWindow).toBeNull();
  });
});

describe('summarizeCapabilityManifest', () => {
  it('lists enabled capabilities', () => {
    const manifest = buildCapabilityManifest({
      model: model({ capabilities: { vision: true, tools: true } }),
    });

    // The remaining six capabilities are unknown, and saying so is the point.
    expect(summarizeCapabilityManifest(manifest)).toBe('vision, tools, 6');
  });

  it('mentions the unverified count so a guess is never presented as fact', () => {
    const manifest = buildCapabilityManifest({ model: model() });

    expect(summarizeCapabilityManifest(manifest, (count) => `${count} unverified`)).toContain(
      `${CAPABILITY_KEYS.length} unverified`,
    );
  });

  it('stays short when everything is known', () => {
    const all = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false]));
    const manifest = buildCapabilityManifest({ model: model({ capabilities: all }) });

    expect(summarizeCapabilityManifest(manifest)).toBe('');
  });
});

describe('formatTokenWindow', () => {
  it('formats round windows compactly', () => {
    expect(formatTokenWindow(128000)).toBe('128K');
    expect(formatTokenWindow(200000)).toBe('200K');
    expect(formatTokenWindow(1000000)).toBe('1M');
    expect(formatTokenWindow(1048576)).toBe('1048576');
  });

  it('returns null for missing or nonsense values', () => {
    expect(formatTokenWindow(null)).toBeNull();
    expect(formatTokenWindow(0)).toBeNull();
    expect(formatTokenWindow(-5)).toBeNull();
    expect(formatTokenWindow(Number.NaN)).toBeNull();
  });
});
