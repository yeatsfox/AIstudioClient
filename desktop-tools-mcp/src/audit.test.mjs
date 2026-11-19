import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuditLog } from './audit.mjs';

let dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amc-audit-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const readLines = async (logPath) =>
  (await fs.readFile(logPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('createAuditLog', () => {
  it('writes one JSON object per call', async () => {
    const logPath = path.join(dir, 'logs', 'audit.jsonl');
    const audit = createAuditLog({ logPath });

    await audit.record({ tool: 'read_file', risk: 'read', outcome: 'ok' });
    await audit.record({ tool: 'write_file', risk: 'mutate', outcome: 'ok' });

    const lines = await readLines(logPath);
    expect(lines).toHaveLength(2);
    expect(lines[0].tool).toBe('read_file');
    expect(lines[1].risk).toBe('mutate');
    expect(typeof lines[0].ts).toBe('string');
  });

  it('creates the parent directory', async () => {
    const logPath = path.join(dir, 'a', 'b', 'audit.jsonl');
    await createAuditLog({ logPath }).record({ tool: 'list_dir' });

    await expect(fs.stat(logPath)).resolves.toBeTruthy();
  });

  it('redacts secrets that reach the log through arguments', async () => {
    const logPath = path.join(dir, 'audit.jsonl');
    await createAuditLog({ logPath }).record({
      tool: 'run_powershell',
      script: 'gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123',
    });

    const [line] = await readLines(logPath);
    expect(line.script).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(line.script).toContain('[redacted GitHub token]');
  });

  it('serialises concurrent writes instead of interleaving them', async () => {
    const logPath = path.join(dir, 'audit.jsonl');
    const audit = createAuditLog({ logPath });

    await Promise.all(Array.from({ length: 25 }, (_, index) => audit.record({ tool: 't', index })));

    const lines = await readLines(logPath);
    expect(lines).toHaveLength(25);
    // Every line must be complete JSON; a torn line would throw above.
    expect(new Set(lines.map((line) => line.index)).size).toBe(25);
  });

  it('does not throw when the log path cannot be written', async () => {
    const audit = createAuditLog({ logPath: path.join(dir, 'missing', 'nested', 'audit.jsonl') });
    // Make the parent a file so append must fail.
    await fs.writeFile(path.join(dir, 'missing'), 'not a directory');

    await expect(audit.record({ tool: 'read_file' })).resolves.toBeUndefined();
  });

  it('writes nothing when no path is configured', async () => {
    const audit = createAuditLog({ logPath: null });
    await expect(audit.record({ tool: 'read_file' })).resolves.toBeUndefined();
  });

  it('flushes pending writes', async () => {
    const logPath = path.join(dir, 'audit.jsonl');
    const audit = createAuditLog({ logPath });

    audit.record({ tool: 'a' });
    audit.record({ tool: 'b' });
    await audit.flush();

    expect(await readLines(logPath)).toHaveLength(2);
  });
});
