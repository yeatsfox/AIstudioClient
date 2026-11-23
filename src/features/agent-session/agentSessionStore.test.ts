import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentSessionStore } from './agentSessionStore';

const initLine = () =>
  JSON.stringify({
    event: 'init',
    conversation_id: 'conv-1',
    init: { cwd: '/w', tools: ['run_command'], permission_mode: 'request-review' },
  });

const textStep = (index: number, delta: string, state: 'ACTIVE' | 'DONE' = 'ACTIVE') =>
  JSON.stringify({
    event: 'step_update',
    step_update: { step_index: index, state, step_type: 'agent_response', text_delta: delta },
  });

const toolStep = (
  index: number,
  toolName: string,
  extra: { output?: string; error?: string; state?: 'ACTIVE' | 'DONE' } = {},
) =>
  JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: index,
      state: extra.state ?? 'DONE',
      step_type: 'tool',
      tool_name: toolName,
      tool_info: {
        parameters: { CommandLine: 'git status' },
        ...(extra.output !== undefined ? { output: extra.output } : {}),
        ...(extra.error !== undefined ? { error: { type: 'permission', message: extra.error } } : {}),
      },
    },
  });

const resultLine = (response: string, status = 'SUCCESS') =>
  JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'conv-1',
      status,
      response,
      duration_seconds: 1.2,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });

const setup = () => {
  localStorage.clear();
  useAgentSessionStore.getState().reset();
  useAgentSessionStore.setState({ turns: [], busy: false, connection: 'idle' });
};

describe('agentSessionStore', () => {
  beforeEach(setup);

  it('marks the connection ready and records the conversation id on init', () => {
    useAgentSessionStore.getState().applyStreamLine(initLine());

    const state = useAgentSessionStore.getState();
    expect(state.connection).toBe('ready');
    expect(state.conversationId).toBe('conv-1');
    expect(state.permissionMode).toBe('request-review');
  });

  it('accumulates streamed deltas into a single text block', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.applyStreamLine(initLine());
    store.applyStreamLine(textStep(2, 'Hello '));
    store.applyStreamLine(textStep(2, 'world'));

    const turn = useAgentSessionStore.getState().turns[0];
    expect(turn.blocks).toHaveLength(1);
    expect(turn.blocks[0]).toMatchObject({ kind: 'text', text: 'Hello world' });
  });

  it('starts a new text block when the step index changes', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.applyStreamLine(textStep(2, 'first'));
    store.applyStreamLine(textStep(4, 'second'));

    const turn = useAgentSessionStore.getState().turns[0];
    expect(turn.blocks).toHaveLength(2);
    expect(turn.blocks.map((b) => (b.kind === 'text' ? b.text : ''))).toEqual(['first', 'second']);
  });

  it('keeps tool steps in the order they ran, alongside text', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('do it');
    store.applyStreamLine(textStep(2, 'Checking '));
    store.applyStreamLine(toolStep(3, 'run_command', { output: 'clean' }));
    store.applyStreamLine(textStep(5, 'done'));

    const turn = useAgentSessionStore.getState().turns[0];
    expect(turn.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect(turn.blocks[1]).toMatchObject({ toolName: 'run_command', output: 'clean', state: 'done' });
  });

  it('shows a running tool step as running until it finishes', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('go');
    store.applyStreamLine(toolStep(3, 'run_command', { state: 'ACTIVE' }));

    expect(useAgentSessionStore.getState().turns[0].blocks[0]).toMatchObject({ state: 'running' });

    store.applyStreamLine(toolStep(3, 'run_command', { output: 'ok' }));
    expect(useAgentSessionStore.getState().turns[0].blocks[0]).toMatchObject({ state: 'done', output: 'ok' });
  });

  it('marks a tool step failed when it carries an error', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('go');
    store.applyStreamLine(toolStep(3, 'write_to_file', { error: 'denied by policy' }));

    expect(useAgentSessionStore.getState().turns[0].blocks[0]).toMatchObject({
      state: 'failed',
      error: 'denied by policy',
    });
  });

  it('never renders checkpoints or the echoed user input', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('go');
    store.applyStreamLine(
      JSON.stringify({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } }),
    );
    store.applyStreamLine(
      JSON.stringify({ event: 'step_update', step_update: { step_index: 9, state: 'DONE', step_type: 'checkpoint' } }),
    );

    expect(useAgentSessionStore.getState().turns[0].blocks).toHaveLength(0);
  });

  it('settles the turn as succeeded on a result event and stores usage', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.applyStreamLine(textStep(2, 'all good'));
    store.applyStreamLine(resultLine('all good'));

    const state = useAgentSessionStore.getState();
    expect(state.busy).toBe(false);
    expect(state.turns[0]).toMatchObject({
      status: 'succeeded',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      durationSeconds: 1.2,
    });
  });

  it('fills the answer from the result when nothing streamed', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.applyStreamLine(resultLine('the final answer'));

    expect(useAgentSessionStore.getState().turns[0].blocks).toEqual([
      expect.objectContaining({ kind: 'text', text: 'the final answer' }),
    ]);
  });

  it('marks the turn failed with the CLI error message', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.applyStreamLine(
      JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'model not found' } }),
    );

    const state = useAgentSessionStore.getState();
    expect(state.turns[0]).toMatchObject({ status: 'failed', errorMessage: 'model not found' });
    expect(state.busy).toBe(false);
  });

  it('fails an in-flight turn when the process exits without a result', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.settleExit({ code: 1, stderr: '' });

    const state = useAgentSessionStore.getState();
    expect(state.turns[0].status).toBe('failed');
    expect(state.turns[0].errorMessage).toContain('code 1');
    expect(state.busy).toBe(false);
    expect(state.connection).toBe('exited');
    expect(state.sessionId).toBeUndefined();
  });

  it('marks the turn stopped when the user stopped it', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.settleExit({ code: null, stopped: true });

    expect(useAgentSessionStore.getState().turns[0].status).toBe('stopped');
    expect(useAgentSessionStore.getState().transportError).toBeUndefined();
  });

  it('records permission notices found on stderr', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.settleExit({ code: 0, stderr: 'Tool write_to_file was denied: requires approval' });

    expect(useAgentSessionStore.getState().turns[0].permissionNotices).toEqual([
      {
        notice: 'Tool write_to_file was denied: requires approval',
        // No action(target) in this line, so nothing is offered for approval.
        request: null,
      },
    ]);
  });

  it('builds an approve rule when the notice names one', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    store.settleExit({
      code: 0,
      stderr: 'run_command was denied: add command(git) to permissions.allow',
    });

    const [entry] = useAgentSessionStore.getState().turns[0].permissionNotices;
    expect(entry.request).toEqual({
      action: 'command',
      target: 'git',
      rule: 'command(git)',
      notice: 'run_command was denied: add command(git) to permissions.allow',
    });
  });

  it('records one notice per distinct line', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    const line = 'run_command was denied: add command(git) to permissions.allow';
    store.settleExit({ code: 0, stderr: `${line}\n${line}\n` });

    expect(useAgentSessionStore.getState().turns[0].permissionNotices).toHaveLength(1);
  });

  it('marks a notice resolved once approved', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');
    const line = 'run_command was denied: add command(git) to permissions.allow';
    store.settleExit({ code: 0, stderr: line });
    store.resolvePermission(line, { status: 'allowed', rule: 'command(git)' });

    const [entry] = useAgentSessionStore.getState().turns[0].permissionNotices;
    expect(entry.resolution).toEqual({ status: 'allowed', rule: 'command(git)' });
  });

  it('ignores unparseable lines instead of throwing', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('hi');

    expect(() => store.applyStreamLine('garbage')).not.toThrow();
    expect(() => store.applyStreamLine('')).not.toThrow();
    expect(useAgentSessionStore.getState().turns[0].blocks).toHaveLength(0);
  });

  it('keeps a previous turn intact when a second turn runs', () => {
    const store = useAgentSessionStore.getState();
    store.beginTurn('first');
    store.applyStreamLine(textStep(2, 'answer one'));
    store.applyStreamLine(resultLine('answer one'));
    store.beginTurn('second');
    store.applyStreamLine(textStep(2, 'answer two'));

    const state = useAgentSessionStore.getState();
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({ status: 'succeeded' });
    expect(state.turns[1]).toMatchObject({ prompt: 'second', status: 'running' });
    expect(state.turns[1].blocks[0]).toMatchObject({ text: 'answer two' });
  });

  it('reset clears the conversation but keeps harness and folder choices', () => {
    const store = useAgentSessionStore.getState();
    store.setCwd('/work');
    store.setModel('gemini-3-pro');
    store.beginTurn('hi');
    store.applyStreamLine(initLine());

    useAgentSessionStore.getState().reset();

    const state = useAgentSessionStore.getState();
    expect(state.turns).toEqual([]);
    expect(state.conversationId).toBeUndefined();
    expect(state.connection).toBe('idle');
    expect(state.cwd).toBe('/work');
    expect(state.model).toBe('gemini-3-pro');
  });
});
