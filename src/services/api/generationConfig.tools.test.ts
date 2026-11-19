import { describe, expect, it, vi, beforeEach } from 'vitest';
import { appendFunctionDeclarationsToTools } from './generationConfig';

// The real @google/genai types are wider than what these tests need; a plain
// object shape keeps the assertions readable without fighting the SDK unions.
const declaration = {
  name: 'mcp_local_read_file',
  description: 'Read a file',
  parameters: { type: 'OBJECT', properties: {} },
} as never;

const withWebSearch = () => ({ tools: [{ googleSearch: {} }] }) as never;

const readDroppedFlag = (result: unknown): boolean | undefined =>
  (result as Record<string, unknown>).__droppedFunctionDeclarations as boolean | undefined;

describe('appendFunctionDeclarationsToTools', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('appends declarations to a plain config', () => {
    const result = appendFunctionDeclarationsToTools('gemini-2.5-flash', {} as never, [declaration]) as unknown as {
      tools: Array<Record<string, unknown>>;
    };

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toHaveProperty('functionDeclarations');
  });

  it('drops declarations when built-in tools are present on a model that cannot combine them', () => {
    // Only Gemini 3 mixes googleSearch with custom functions. For anything else
    // the request would be rejected, so the declarations are stripped — and the
    // caller has to notice, or the model silently loses every local tool.
    const result = appendFunctionDeclarationsToTools('gemini-2.5-flash', withWebSearch(), [declaration]) as unknown as {
      tools: Array<Record<string, unknown>>;
    };

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).not.toHaveProperty('functionDeclarations');
    expect(result.tools[0]).toHaveProperty('googleSearch');
  });

  it('reports whether the declarations actually survived', () => {
    // The caller needs this to tell the user "your tools were dropped because
    // web search is on" instead of leaving them guessing why nothing works.
    const kept = appendFunctionDeclarationsToTools('gemini-3-pro', withWebSearch(), [declaration]);
    const dropped = appendFunctionDeclarationsToTools('gemini-2.5-flash', withWebSearch(), [declaration]);

    // Absent means kept; only an explicit true means the caller must warn.
    expect(readDroppedFlag(kept)).toBeUndefined();
    expect(readDroppedFlag(dropped)).toBe(true);
  });

  it('does not flag a drop when there was nothing to drop', () => {
    const result = appendFunctionDeclarationsToTools('gemini-2.5-flash', withWebSearch(), []);

    expect(readDroppedFlag(result)).not.toBe(true);
  });

  it('marks server-side tool invocations for Gemini 3 with built-ins', () => {
    const result = appendFunctionDeclarationsToTools('gemini-3-pro', withWebSearch(), [declaration]) as unknown as {
      toolConfig?: { includeServerSideToolInvocations?: boolean };
    };

    expect(result.toolConfig?.includeServerSideToolInvocations).toBe(true);
  });
});
