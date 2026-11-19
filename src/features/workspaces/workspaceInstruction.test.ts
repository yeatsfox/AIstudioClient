import { describe, expect, it } from 'vitest';
import { appendWorkspaceInstruction, buildWorkspaceSystemInstruction } from './workspaceInstruction';
import type { Workspace } from './workspaceModel';

const ws = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'ws_1',
  path: 'C:\\work\\doc\\feishu',
  title: 'feishu',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('buildWorkspaceSystemInstruction', () => {
  it('lists mounted folders so the model knows they exist', () => {
    const block = buildWorkspaceSystemInstruction([ws()], true);

    expect(block).toContain('C:\\work\\doc\\feishu');
    expect(block).toContain('list_dir');
  });

  it('skips disabled folders', () => {
    const block = buildWorkspaceSystemInstruction([ws(), ws({ id: 'ws_2', path: 'D:\\secret', enabled: false })], true);

    expect(block).toContain('C:\\work\\doc\\feishu');
    expect(block).not.toContain('D:\\secret');
  });

  it('returns null when nothing is mounted', () => {
    expect(buildWorkspaceSystemInstruction([], true)).toBeNull();
    expect(buildWorkspaceSystemInstruction([ws({ enabled: false })], true)).toBeNull();
  });

  it('returns null when there are no file tools to use', () => {
    // Listing paths without tools would only encourage invented reads.
    expect(buildWorkspaceSystemInstruction([ws()], false)).toBeNull();
  });

  it('shows the title only when it differs from the path', () => {
    const block = buildWorkspaceSystemInstruction([ws({ title: 'C:\\work\\doc\\feishu' })], true);

    expect(block).not.toContain('(C:\\work\\doc\\feishu)');
  });
});

describe('appendWorkspaceInstruction', () => {
  it('keeps the user instruction first', () => {
    const result = appendWorkspaceInstruction('You are terse.', [ws()], true);

    expect(result!.startsWith('You are terse.')).toBe(true);
    expect(result).toContain('C:\\work\\doc\\feishu');
  });

  it('uses the workspace block alone when there is no prior instruction', () => {
    const result = appendWorkspaceInstruction('', [ws()], true);

    expect(result).toContain('C:\\work\\doc\\feishu');
    expect(result!.startsWith('The user has added')).toBe(true);
  });

  it('leaves the instruction untouched when nothing is mounted', () => {
    expect(appendWorkspaceInstruction('You are terse.', [], true)).toBe('You are terse.');
    expect(appendWorkspaceInstruction(undefined, [], true)).toBeUndefined();
  });
});
