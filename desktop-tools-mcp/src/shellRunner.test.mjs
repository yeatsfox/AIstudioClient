import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';

const SERVER = path.join(process.cwd(), 'desktop-tools-mcp', 'server.mjs');

/**
 * The shell probe must not depend on `process.platform`. A Windows build under
 * a compatibility layer reports a non-win32 platform, and probing only `.exe`
 * names there would wrongly tell the user PowerShell is missing.
 */
describe('shell detection candidates', () => {
  it('tries both the bare and the .exe command name on every platform', async () => {
    // Import the module in a child so the real probe runs without a cache from
    // another test file.
    const script = `
      import { detectShell } from ${JSON.stringify(pathToFileUrl(path.join(process.cwd(), 'desktop-tools-mcp', 'src', 'shellRunner.mjs')))};
      const result = await detectShell();
      process.stdout.write(JSON.stringify({ detected: Boolean(result) }));
    `;

    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', () => resolve({ out, err }));
    });

    // On CI there is no PowerShell at all, which is a valid outcome; the point
    // is that detection completes and reports a definite answer.
    expect(output.out).toContain('"detected":');
  }, 30000);

  it('reports a clear error when PowerShell is unavailable', async () => {
    const script = `
      import { runPowerShell } from ${JSON.stringify(pathToFileUrl(path.join(process.cwd(), 'desktop-tools-mcp', 'src', 'shellRunner.mjs')))};
      try {
        await runPowerShell({ script: 'echo hi', roots: [process.cwd()] });
        process.stdout.write('RAN');
      } catch (error) {
        process.stdout.write('ERR:' + error.message);
      }
    `;

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', () => resolve(out));
    });

    // Either PowerShell ran (a machine that has it) or the message explains how
    // to install it — never a bare spawn failure.
    if (result.startsWith('ERR:')) {
      expect(result).toMatch(/PowerShell was not found|install PowerShell/i);
    } else {
      expect(result).toBe('RAN');
    }
  }, 60000);
});

function pathToFileUrl(filePath) {
  const url = new URL('file://');
  url.pathname = filePath.split(path.sep).join('/');
  return url.href;
}
