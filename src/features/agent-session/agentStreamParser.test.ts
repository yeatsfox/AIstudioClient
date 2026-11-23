import { describe, expect, it } from 'vitest';
import {
  isPermissionNotice,
  parseAgentStreamLine,
  readStepTextDelta,
} from './agentStreamParser';

describe('parseAgentStreamLine', () => {
  it('parses the init event with its run configuration', () => {
    const line = JSON.stringify({
      event: 'init',
      conversation_id: 'c3b66b04',
      init: {
        cwd: '/home/user/project',
        tools: ['ask_permission', 'run_command', 'write_to_file'],
        permission_mode: 'request-review',
      },
    });

    const parsed = parseAgentStreamLine(line);

    expect(parsed).toEqual({
      type: 'init',
      conversationId: 'c3b66b04',
      cwd: '/home/user/project',
      tools: ['ask_permission', 'run_command', 'write_to_file'],
      permissionMode: 'request-review',
      model: undefined,
    });
  });

  it('keeps model and agent when the run overrode them', () => {
    const line = JSON.stringify({
      event: 'init',
      conversation_id: 'abc',
      init: { cwd: '/w', tools: [], permission_mode: 'always-proceed', model: 'gemini-3-pro' },
    });

    const parsed = parseAgentStreamLine(line);

    expect(parsed).toMatchObject({ type: 'init', model: 'gemini-3-pro', permissionMode: 'always-proceed' });
  });

  it('tolerates an init event with no tools array', () => {
    const parsed = parseAgentStreamLine(JSON.stringify({ event: 'init', conversation_id: 'x', init: {} }));

    expect(parsed).toMatchObject({ type: 'init', tools: [] });
  });

  it('parses an agent_response step and exposes the text delta', () => {
    const payload = {
      event: 'step_update',
      step_update: {
        conversation_id: 'c3b66b04',
        step_index: 3,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'Git rebase rewrites history.',
        duration_seconds: 6.28,
        usage: { input_tokens: 10302, output_tokens: 582, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 10884 },
      },
    };

    const parsed = parseAgentStreamLine(JSON.stringify(payload));

    expect(parsed).toMatchObject({
      type: 'step',
      step: { index: 3, kind: 'agent_response', state: 'DONE', durationSeconds: 6.28 },
    });
    expect(readStepTextDelta(payload.step_update)).toBe('Git rebase rewrites history.');
  });

  it('reports ACTIVE state so partial text can stream before the step finishes', () => {
    const parsed = parseAgentStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'apple' },
      }),
    );

    expect(parsed).toMatchObject({ type: 'step', step: { state: 'ACTIVE', index: 2 } });
  });

  it('unpacks a tool step including its command and output', () => {
    const parsed = parseAgentStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'edb1c8c1',
          step_index: 4,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          duration_seconds: 0.07,
          tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello' }, output: 'hello\n' },
        },
      }),
    );

    expect(parsed).toMatchObject({
      type: 'step',
      step: {
        kind: 'tool',
        toolName: 'run_command',
        toolParameters: { CommandLine: 'echo hello' },
        toolOutput: 'hello\n',
        toolError: undefined,
      },
    });
  });

  it('flattens a nested tool error into a message', () => {
    const parsed = parseAgentStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 5,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'write_to_file',
          tool_info: { parameters: { path: 'a.txt' }, error: { type: 'permission', message: 'denied by policy' } },
        },
      }),
    );

    expect(parsed).toMatchObject({ type: 'step', step: { toolError: 'denied by policy' } });
  });

  it('falls back to the error type when no message is present', () => {
    const parsed = parseAgentStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_info: { error: { type: 'timeout' } } },
      }),
    );

    expect(parsed).toMatchObject({ type: 'step', step: { toolError: 'timeout' } });
  });

  it('marks an unrecognized step type as unknown instead of failing', () => {
    const parsed = parseAgentStreamLine(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 7, state: 'DONE', step_type: 'something_new' },
      }),
    );

    expect(parsed).toMatchObject({ type: 'step', step: { kind: 'unknown', index: 7 } });
  });

  it('drops a step that has no index', () => {
    const parsed = parseAgentStreamLine(
      JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'tool' } }),
    );

    expect(parsed).toBeNull();
  });

  it('parses the terminal result event with usage counters', () => {
    const parsed = parseAgentStreamLine(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'c3b66b04',
          status: 'SUCCESS',
          response: 'A git rebase rewrites history.\n',
          duration_seconds: 6.88,
          num_turns: 1,
          usage: { input_tokens: 10418, output_tokens: 589, total_tokens: 11007 },
        },
      }),
    );

    expect(parsed).toEqual({
      type: 'result',
      result: {
        conversationId: 'c3b66b04',
        status: 'SUCCESS',
        response: 'A git rebase rewrites history.\n',
        error: undefined,
        durationSeconds: 6.88,
        numTurns: 1,
        usage: { inputTokens: 10418, outputTokens: 589, thinkingTokens: undefined, cacheReadTokens: undefined, totalTokens: 11007 },
      },
    });
  });

  it('keeps the error message of a failed run', () => {
    const parsed = parseAgentStreamLine(
      JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'model not found' } }),
    );

    expect(parsed).toMatchObject({ type: 'result', result: { status: 'ERROR', error: 'model not found' } });
  });

  it('drops a result with no status rather than inventing one', () => {
    expect(parseAgentStreamLine(JSON.stringify({ event: 'result', result: { response: 'hi' } }))).toBeNull();
  });

  it('reports an unrecognized event name so it is not silently lost', () => {
    expect(parseAgentStreamLine(JSON.stringify({ event: 'heartbeat', x: 1 }))).toEqual({
      type: 'unknown',
      event: 'heartbeat',
    });
  });

  it('returns null for blank and malformed lines', () => {
    expect(parseAgentStreamLine('')).toBeNull();
    expect(parseAgentStreamLine('   ')).toBeNull();
    expect(parseAgentStreamLine('not json')).toBeNull();
    expect(parseAgentStreamLine('{"unterminated":')).toBeNull();
    expect(parseAgentStreamLine('"just a string"')).toBeNull();
    expect(parseAgentStreamLine('null')).toBeNull();
  });

  it('tolerates surrounding whitespace and a trailing carriage return', () => {
    const parsed = parseAgentStreamLine('  {"event":"result","result":{"status":"SUCCESS","response":"ok"}}\r  ');

    expect(parsed).toMatchObject({ type: 'result', result: { status: 'SUCCESS', response: 'ok' } });
  });
});

describe('readStepTextDelta', () => {
  it('returns empty string when there is no delta', () => {
    expect(readStepTextDelta({ step_type: 'tool' })).toBe('');
    expect(readStepTextDelta(null)).toBe('');
    expect(readStepTextDelta('nope')).toBe('');
  });
});

describe('isPermissionNotice', () => {
  it('recognizes a soft-denied tool notice', () => {
    expect(isPermissionNotice('Tool write_to_file was denied: requires approval')).toBe(true);
    expect(isPermissionNotice('run_command not allowed in headless mode')).toBe(true);
  });

  it('ignores ordinary stderr chatter', () => {
    expect(isPermissionNotice('warming up conversation')).toBe(false);
    expect(isPermissionNotice('Authentication required')).toBe(false);
  });
});
