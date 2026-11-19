import { describe, expect, it } from 'vitest';
import { deriveStatus, summarizeCapabilityErrors } from './mcpStatus';
import type { McpServerCapabilities } from '@/services/api/mcpApi';

const capabilities = (overrides: Partial<McpServerCapabilities> = {}): McpServerCapabilities => ({
  tools: [],
  resources: [],
  resourceTemplates: [],
  prompts: [],
  errors: [],
  ...overrides,
});

const errorFor = (serverId: string, error: string) => ({
  serverId,
  serverName: serverId,
  error,
});

describe('deriveStatus', () => {
  it('reports disabled regardless of other evidence', () => {
    expect(deriveStatus(capabilities(), 'boom', false).state).toBe('disabled');
  });

  it('reports error when the transport threw', () => {
    const result = deriveStatus(null, 'connect ECONNREFUSED', true);

    expect(result.state).toBe('error');
    expect(result.lastError).toBe('connect ECONNREFUSED');
  });

  it('reports connecting before any response arrives', () => {
    expect(deriveStatus(null, null, true).state).toBe('connecting');
  });

  it('reports connected when every capability endpoint succeeded', () => {
    const result = deriveStatus(capabilities({ tools: [{ name: 'list' }], version: '2.1.0' }), null, true);

    expect(result.state).toBe('connected');
    expect(result.version).toBe('2.1.0');
  });

  it('does not report connected when every capability endpoint failed', () => {
    // This is the case that used to lie: three parallel requests all failed, so
    // the response exists but carries no data and three errors. Calling that
    // "connected" showed a green pill for a server that could not be reached.
    const result = deriveStatus(
      capabilities({
        errors: [errorFor('s1', 'spawn ENOENT'), errorFor('s1', 'spawn ENOENT'), errorFor('s1', 'spawn ENOENT')],
      }),
      null,
      true,
    );

    expect(result.state).toBe('error');
    expect(result.lastError).toContain('spawn ENOENT');
  });

  it('reports error when the server produced no capabilities and no errors either', () => {
    // Empty everywhere with no error is still not evidence of a healthy server;
    // it means the endpoints answered but knew nothing about this server.
    const result = deriveStatus(capabilities(), null, true);

    expect(result.state).toBe('error');
    expect(result.lastError).toBeTruthy();
  });

  it('stays connected when only one endpoint failed but others returned data', () => {
    const result = deriveStatus(
      capabilities({
        tools: [{ name: 'read_file' }],
        errors: [errorFor('s1', 'prompts unsupported')],
      }),
      null,
      true,
    );

    expect(result.state).toBe('connected');
    expect(result.lastError).toContain('prompts unsupported');
  });

  it('does not count resources as data on their own when only prompts failed', () => {
    const result = deriveStatus(
      capabilities({
        resources: [{ uri: 'file:///a', name: 'a' }],
        errors: [errorFor('s1', 'prompts unsupported')],
      }),
      null,
      true,
    );

    expect(result.state).toBe('connected');
  });

  it('ignores errors belonging to a different server', () => {
    const result = deriveStatus(
      capabilities({
        tools: [{ name: 'read_file' }],
        errors: [errorFor('other', 'boom')],
      }),
      null,
      true,
      's1',
    );

    expect(result.state).toBe('connected');
    expect(result.lastError).toBeUndefined();
  });
});

describe('summarizeCapabilityErrors', () => {
  it('deduplicates the same message repeated per endpoint', () => {
    const summary = summarizeCapabilityErrors([
      errorFor('s1', 'spawn ENOENT'),
      errorFor('s1', 'spawn ENOENT'),
      errorFor('s1', 'timeout'),
    ]);

    // Repeats collapse, but a genuinely different cause is still reported.
    expect(summary).toBe('spawn ENOENT · timeout');
  });

  it('joins distinct messages', () => {
    const summary = summarizeCapabilityErrors([errorFor('s1', 'spawn ENOENT'), errorFor('s1', 'timeout')]);

    expect(summary).toContain('spawn ENOENT');
    expect(summary).toContain('timeout');
  });

  it('returns null when there is nothing to report', () => {
    expect(summarizeCapabilityErrors([])).toBeNull();
    expect(summarizeCapabilityErrors([errorFor('s1', '   ')])).toBeNull();
  });
});
