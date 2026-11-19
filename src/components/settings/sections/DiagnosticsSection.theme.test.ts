import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The diagnostics panel was written with fixed `text-white/NN` colours while
 * every other settings section uses the theme variables. On the light theme
 * that produced white text on a near-white panel: the status pills stayed
 * readable, everything else — check names, headline, the re-run button —
 * vanished. Colours here must follow the theme.
 */
const source = readFileSync(resolve(__dirname, 'DiagnosticsSection.tsx'), 'utf8');

describe('DiagnosticsSection theme colours', () => {
  it('does not hard-code white text or white-alpha panels', () => {
    const offenders = source.match(/text-white\/\d+|bg-white\/\[?[\d.]+\]?|border-white\/\d+/g) ?? [];

    expect(offenders).toEqual([]);
  });

  it('takes body and heading colour from the theme', () => {
    expect(source).toContain('var(--theme-text-primary)');
    expect(source).toContain('var(--theme-text-secondary)');
  });

  it('keeps the check container readable in both themes', () => {
    expect(source).toContain('var(--theme-bg-secondary)');
    expect(source).toContain('var(--theme-border-secondary)');
  });
});
