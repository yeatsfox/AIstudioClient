// PowerShell execution.
//
// Commands run through `pwsh`/`powershell` with -NoProfile so a user profile
// cannot change behaviour behind the model's back. The working directory is
// pinned to a workspace root, output is capped, and the child is killed on
// timeout so a hung command cannot wedge the MCP server.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWithinRoots } from './paths.mjs';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_OUTPUT_CHARS = 60_000;

const IS_WINDOWS = process.platform === 'win32';

let cachedShell = null;

/**
 * Prefer PowerShell 7+ (`pwsh`) and fall back to Windows PowerShell 5.1.
 * Resolved once and cached: this check spawns a process, so doing it per call
 * would add a noticeable delay to every command.
 */
export async function detectShell() {
  if (cachedShell) return cachedShell;

  const candidates = IS_WINDOWS
    ? [
        { command: 'pwsh.exe', label: 'PowerShell 7' },
        { command: 'powershell.exe', label: 'Windows PowerShell' },
      ]
    : [
        { command: 'pwsh', label: 'PowerShell 7' },
        { command: 'powershell', label: 'PowerShell' },
      ];

  for (const candidate of candidates) {
    const ok = await new Promise((resolve) => {
      const probe = spawn(candidate.command, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      probe.stdout?.on('data', (chunk) => {
        out += chunk.toString();
      });
      probe.on('error', () => resolve(false));
      probe.on('close', (code) => resolve(code === 0 ? out.trim() || true : false));
      setTimeout(() => {
        probe.kill();
        resolve(false);
      }, 5000).unref?.();
    });
    if (ok) {
      cachedShell = { ...candidate, version: typeof ok === 'string' ? ok : 'unknown' };
      return cachedShell;
    }
  }

  cachedShell = null;
  return null;
}

/** Cap captured output while telling the model that it was cut. */
function appendBounded(target, chunk) {
  const remaining = MAX_OUTPUT_CHARS - target.text.length;
  if (remaining <= 0) {
    target.truncated = true;
    return;
  }
  const text = chunk.toString();
  if (text.length > remaining) {
    target.text += text.slice(0, remaining);
    target.truncated = true;
  } else {
    target.text += text;
  }
}

export async function runPowerShell({ script, roots, cwd, timeoutMs }) {
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error('script must be a non-empty string.');
  }

  const shell = await detectShell();
  if (!shell) {
    throw new Error(
      'PowerShell was not found on this machine. Install PowerShell 7 (winget install Microsoft.PowerShell) and try again.',
    );
  }

  const workingDir = cwd ? await resolveWithinRoots(cwd, roots, 'existing') : roots[0];
  const stat = await fs.stat(workingDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Working directory does not exist: ${workingDir}`);
  }

  const effectiveTimeout = Math.min(Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  // -NoProfile keeps the user's profile from altering behavior; -NonInteractive
  // stops a prompt from hanging the call forever.
  const args = ['-NoProfile', '-NonInteractive', '-Command', script];

  const started = Date.now();
  const isWindows = IS_WINDOWS;

  return new Promise((resolve, reject) => {
    const child = spawn(shell.command, args, {
      cwd: workingDir,
      windowsHide: true,
      env: { ...process.env, ...(isWindows ? {} : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = { text: '', truncated: false };
    const stderr = { text: '', truncated: false };
    let timedOut = false;

    child.stdout.on('data', (chunk) => appendBounded(stdout, chunk));
    child.stderr.on('data', (chunk) => appendBounded(stderr, chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      // PowerShell spawns child processes; killing the shell alone can leave
      // orphans, so the tree is killed on Windows too.
      if (isWindows) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    }, effectiveTimeout);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const parts = [
        `PowerShell: ${shell.label} ${shell.version}`,
        `Directory: ${workingDir}`,
        `Duration: ${(durationMs / 1000).toFixed(2)}s`,
        timedOut ? `Timed out after ${effectiveTimeout}ms (process tree killed).` : `Exit code: ${code}`,
      ];

      if (stdout.text.trim()) {
        parts.push('', '--- stdout ---', stdout.text.trimEnd() + (stdout.truncated ? '\n[output truncated]' : ''));
      } else {
        parts.push('', '--- stdout ---', '(empty)');
      }

      if (stderr.text.trim()) {
        parts.push('', '--- stderr ---', stderr.text.trimEnd() + (stderr.truncated ? '\n[output truncated]' : ''));
      }

      resolve(parts.join('\n'));
    });
  });
}
