import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestRenderer } from '@/test/render/renderer';
import { useSettingsStore } from '@/stores/settingsStore';
import { AgentSessionView } from './AgentSessionView';
import { useAgentSessionStore } from './agentSessionStore';

// setupTestRenderer registers its own beforeEach, so it is created once per
// file rather than per test.
const renderer = setupTestRenderer();

const renderView = () => {
  act(() => {
    renderer.render(<AgentSessionView />);
  });
  return renderer.container;
};

const resetStore = () => {
  useAgentSessionStore.setState({
    turns: [],
    busy: false,
    connection: 'idle',
    cwd: '',
    model: '',
    harness: 'antigravity',
    availableHarnesses: [{ id: 'antigravity', label: 'Antigravity', installed: true, path: '/usr/bin/agy' }],
    transportError: undefined,
    permissionMode: undefined,
    conversationId: undefined,
    sessionId: undefined,
  });
};

describe('AgentSessionView', () => {
  beforeEach(() => {
    resetStore();
    // Assertions below quote the Chinese copy, so pin the language instead of
    // inheriting whatever the test environment resolved.
    useSettingsStore.setState({ language: 'zh' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { __AMC_DESKTOP__?: unknown }).__AMC_DESKTOP__;
  });

  it('shows the empty hint before any task is sent', () => {
    const container = renderView();

    expect(container.textContent).toContain('Agent 会话');
    expect(container.textContent).toContain('选好工作目录后直接发任务');
  });

  it('renders a tool card with the command that ran and its output', () => {
    useAgentSessionStore.setState({
      cwd: '/w',
      turns: [
        {
          id: 'turn-1',
          prompt: 'check the repo',
          status: 'succeeded',
          blocks: [
            {
              kind: 'tool',
              id: 'tool-step-3',
              toolName: 'run_command',
              parameters: { CommandLine: 'git status' },
              output: 'working tree clean',
              state: 'done',
            },
          ],
          permissionNotices: [],
        },
      ],
    });

    const container = renderView();

    expect(container.textContent).toContain('git status');
    expect(container.textContent).toContain('working tree clean');
    expect(container.textContent).toContain('run_command');
  });

  it('shows a failed tool with its error rather than a bare status', () => {
    useAgentSessionStore.setState({
      cwd: '/w',
      turns: [
        {
          id: 'turn-1',
          prompt: 'write a file',
          status: 'succeeded',
          blocks: [
            {
              kind: 'tool',
              id: 'tool-step-4',
              toolName: 'write_to_file',
              parameters: { path: 'a.txt' },
              error: 'denied by policy',
              state: 'failed',
            },
          ],
          permissionNotices: [],
        },
      ],
    });

    const container = renderView();

    expect(container.textContent).toContain('a.txt');
    expect(container.textContent).toContain('denied by policy');
  });

  it('surfaces a soft-denied tool notice in the turn', () => {
    useAgentSessionStore.setState({
      cwd: '/w',
      turns: [
        {
          id: 'turn-1',
          prompt: 'do work',
          status: 'succeeded',
          blocks: [],
          permissionNotices: [
            {
              notice: 'Tool write_to_file was denied: requires approval',
              request: null,
            },
          ],
        },
      ],
    });

    const container = renderView();

    expect(container.textContent).toContain('有工具因缺少授权被拒绝');
    expect(container.textContent).toContain('requires approval');
    // No buildable action(target) in the notice: offering an approval here
    // would mean writing a guessed rule, so no Allow button may appear.
    const allowButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === '允许',
    );
    expect(allowButtons).toHaveLength(0);
  });

  it('offers to allow the tool when the notice names a rule', () => {
    const notice = 'run_command was denied: add command(git) to permissions.allow';
    useAgentSessionStore.setState({
      cwd: '/w',
      turns: [
        {
          id: 'turn-1',
          prompt: 'do work',
          status: 'succeeded',
          blocks: [],
          permissionNotices: [
            { notice, request: { action: 'command', target: 'git', rule: 'command(git)', notice } },
          ],
        },
      ],
    });

    const container = renderView();

    // The exact rule is shown, so the user approves something specific that
    // affects every future session rather than a vague "allow this tool".
    expect(container.textContent).toContain('command(git)');
    const allowButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '允许',
    );
    expect(allowButton).toBeDefined();
  });

  it('shows the saved state instead of the button once approved', () => {
    const notice = 'run_command was denied: add command(git) to permissions.allow';
    useAgentSessionStore.setState({
      cwd: '/w',
      turns: [
        {
          id: 'turn-1',
          prompt: 'do work',
          status: 'succeeded',
          blocks: [],
          permissionNotices: [
            {
              notice,
              request: { action: 'command', target: 'git', rule: 'command(git)', notice },
              resolution: { status: 'allowed', rule: 'command(git)' },
            },
          ],
        },
      ],
    });

    const container = renderView();

    expect(container.textContent).toContain('已允许');
    expect(container.textContent).toContain('发送新消息后生效');
    const allowButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '允许',
    );
    expect(allowButton).toBeUndefined();
  });

  it('warns that the desktop app is required when no bridge exists', () => {
    useAgentSessionStore.setState({ connection: 'unsupported' });

    const container = renderView();

    expect(container.textContent).toContain('需要桌面版');
  });

  it('warns when the CLI is not installed', () => {
    useAgentSessionStore.setState({
      availableHarnesses: [{ id: 'antigravity', label: 'Antigravity', installed: false, path: null }],
    });

    const container = renderView();

    expect(container.textContent).toContain('未检测到 Antigravity CLI');
  });

  it('disables sending while a turn is running', () => {
    useAgentSessionStore.setState({ cwd: '/w', busy: true });

    const container = renderView();

    const textarea = container.querySelector('textarea');
    expect(textarea?.disabled).toBe(true);
    expect(container.textContent).toContain('停止');
  });

  it('shows the working folder in the header once chosen', () => {
    useAgentSessionStore.setState({ cwd: '/home/user/project' });

    const container = renderView();

    expect(container.textContent).toContain('/home/user/project');
  });

  it('exposes the model as an editable field', () => {
    useAgentSessionStore.setState({ model: 'gemini-3-pro' });

    const container = renderView();
    const input = container.querySelector('input[aria-label="agent model"]') as HTMLInputElement | null;

    expect(input?.value).toBe('gemini-3-pro');
  });
});
