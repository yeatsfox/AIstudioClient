import { describe, expect, it } from 'vitest';
import {
  createWorkspace,
  defaultWorkspaceTitle,
  isWorkspaceEnabled,
  workspacePaths,
  workspacePathsEqual,
} from './workspaceModel';

describe('workspace identity', () => {
  it('generates a distinct id for each record', () => {
    const a = createWorkspace('/home/me/project');
    const b = createWorkspace('/home/me/project');
    // Two records for the same path would be a duplicate, but ids must still
    // differ: the id is the anchor, not the path.
    expect(a.id).not.toBe(b.id);
  });

  it('defaults the title to the final path segment', () => {
    expect(defaultWorkspaceTitle('/home/me/project')).toBe('project');
    expect(defaultWorkspaceTitle('/home/me/project/')).toBe('project');
    expect(defaultWorkspaceTitle('C:\\work\\demo')).toBe('demo');
  });

  it('keeps a drive root readable instead of dropping to a bare letter', () => {
    expect(defaultWorkspaceTitle('C:\\')).toBe('C:\\');
    expect(defaultWorkspaceTitle('C:')).toBe('C:\\');
    expect(defaultWorkspaceTitle('/')).toBe('/');
  });

  it('keeps a user-supplied title', () => {
    expect(createWorkspace('/home/me/project', '  我的项目  ').title).toBe('我的项目');
  });

  it('treats a record written before the flag existed as enabled', () => {
    const legacy = { ...createWorkspace('/home/me/project') };
    delete (legacy as { enabled?: boolean }).enabled;
    expect(isWorkspaceEnabled(legacy)).toBe(true);
    expect(isWorkspaceEnabled({ ...legacy, enabled: false })).toBe(false);
  });
});

describe('workspace path comparison', () => {
  it('matches a path with and without a trailing separator', () => {
    expect(workspacePathsEqual('/home/me/project', '/home/me/project/')).toBe(true);
    expect(workspacePathsEqual('C:\\work\\demo', 'C:\\work\\demo\\')).toBe(true);
  });

  it('folds case on Windows paths only', () => {
    expect(workspacePathsEqual('C:\\Work\\Demo', 'c:\\work\\demo')).toBe(true);
    // Two Unix paths differing only in case are genuinely different folders.
    expect(workspacePathsEqual('/home/me/Project', '/home/me/project')).toBe(false);
  });

  it('does not confuse sibling directories', () => {
    expect(workspacePathsEqual('/home/me/project', '/home/me/project2')).toBe(false);
  });

  it('preserves the order given by the user', () => {
    const workspaces = [
      createWorkspace('/a'),
      createWorkspace('/b'),
      createWorkspace('/c'),
    ];
    expect(workspacePaths(workspaces)).toEqual(['/a', '/b', '/c']);
  });
});
