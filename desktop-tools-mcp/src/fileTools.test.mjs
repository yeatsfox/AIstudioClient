import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isInside, normalizeRoots, PathDeniedError, resolveWithinRoots } from './paths.mjs';
import { listDir, readFile, replaceInFile, searchFiles, writeFile } from './fileTools.mjs';

const makeWorkspace = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dtmcp-'));
  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha\nbeta\n');
  await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'needle in here\n');
  return root;
};

describe('isInside', () => {
  it('accepts the root itself and its children', () => {
    expect(isInside('/work', '/work')).toBe(true);
    expect(isInside('/work', '/work/file.txt')).toBe(true);
  });

  it('rejects a sibling directory sharing a prefix', () => {
    // "/work2" starts with "/work" but is not inside it.
    expect(isInside('/work', '/work2')).toBe(false);
    expect(isInside('/work', '/etc/passwd')).toBe(false);
  });
});

describe('resolveWithinRoots', () => {
  it('resolves an existing file inside the root', async () => {
    const root = await makeWorkspace();
    const resolved = await resolveWithinRoots(path.join(root, 'a.txt'), normalizeRoots([root]), 'existing');
    expect(resolved).toBe(path.join(root, 'a.txt'));
  });

  it('rejects traversal with ..', async () => {
    const root = await makeWorkspace();
    await expect(
      resolveWithinRoots(path.join(root, '..', '..', 'etc', 'passwd'), [root], 'existing'),
    ).rejects.toThrow(PathDeniedError);
  });

  it('rejects an absolute path outside the root', async () => {
    const root = await makeWorkspace();
    await expect(resolveWithinRoots('/etc/passwd', [root], 'existing')).rejects.toThrow(PathDeniedError);
  });

  it('rejects a symlink that escapes the root', async () => {
    const root = await makeWorkspace();
    const link = path.join(root, 'escape');
    await fs.symlink('/etc', link);
    await expect(resolveWithinRoots(link, [root], 'existing')).rejects.toThrow(PathDeniedError);
  });

  it('allows creating a file whose parent exists', async () => {
    const root = await makeWorkspace();
    const target = await resolveWithinRoots(path.join(root, 'new.txt'), [root], 'create');
    expect(target).toBe(path.join(root, 'new.txt'));
  });

  it('rejects a missing parent on create', async () => {
    const root = await makeWorkspace();
    await expect(
      resolveWithinRoots(path.join(root, 'nope', 'new.txt'), [root], 'create'),
    ).rejects.toThrow(/Parent directory does not exist/);
  });
});

describe('file tools', () => {
  it('lists directories with a trailing slash and file sizes', async () => {
    const root = await makeWorkspace();
    const output = await listDir({ dirPath: root, roots: [root] });
    expect(output).toContain('sub/');
    expect(output).toContain('a.txt');
  });

  it('reads a whole file', async () => {
    const root = await makeWorkspace();
    const output = await readFile({ filePath: path.join(root, 'a.txt'), roots: [root] });
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
  });

  it('reads a line range', async () => {
    const root = await makeWorkspace();
    const output = await readFile({ filePath: path.join(root, 'a.txt'), roots: [root], startLine: 2, endLine: 2 });
    expect(output).toContain('beta');
    expect(output).not.toContain('alpha');
  });

  it('refuses to read a binary file', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    await expect(readFile({ filePath: path.join(root, 'bin.dat'), roots: [root] })).rejects.toThrow(/binary/);
  });

  it('writes a new file', async () => {
    const root = await makeWorkspace();
    await writeFile({ filePath: path.join(root, 'out.txt'), roots: [root], content: 'hello' });
    expect(await fs.readFile(path.join(root, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('replaces a unique string', async () => {
    const root = await makeWorkspace();
    await replaceInFile({
      filePath: path.join(root, 'a.txt'),
      roots: [root],
      oldString: 'alpha',
      newString: 'ALPHA',
    });
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('ALPHA\nbeta\n');
  });

  it('rejects an ambiguous replacement unless replaceAll is set', async () => {
    const root = await makeWorkspace();
    const file = path.join(root, 'dup.txt');
    await fs.writeFile(file, 'x\nx\n');

    await expect(
      replaceInFile({ filePath: file, roots: [root], oldString: 'x', newString: 'y' }),
    ).rejects.toThrow(/appears 2 times/);

    await replaceInFile({ filePath: file, roots: [root], oldString: 'x', newString: 'y', replaceAll: true });
    expect(await fs.readFile(file, 'utf8')).toBe('y\ny\n');
  });

  it('rejects a replacement whose oldString is absent', async () => {
    const root = await makeWorkspace();
    await expect(
      replaceInFile({
        filePath: path.join(root, 'a.txt'),
        roots: [root],
        oldString: 'missing',
        newString: 'x',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('searches file contents and reports path:line', async () => {
    const root = await makeWorkspace();
    const output = await searchFiles({ query: 'needle', roots: [root] });
    expect(output).toContain('b.txt:1:');
  });

  it('skips node_modules while searching', async () => {
    const root = await makeWorkspace();
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'dep.js'), 'needle');
    const output = await searchFiles({ query: 'needle', roots: [root] });
    expect(output).not.toContain('node_modules');
  });
});
