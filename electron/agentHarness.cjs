// Native agent harnesses, driven as child processes.
//
// The renderer asks a native agent CLI to do work; this module owns the
// process, the conversation lifecycle and nothing else. It deliberately does
// not interpret the agent's output: every line is forwarded to the renderer,
// which parses `--output-format stream-json` NDJSON. That keeps the protocol
// knowledge in one place (the frontend) and this file small enough to audit.
//
// Antigravity (`agy`) is the only harness for now. Adding another means adding
// a spec below: the argument shape is the only per-harness knowledge.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * How long a single turn may take before the process is considered stuck.
 * Antigravity's own default is "no limit" (`--print-timeout 0s`), which in a
 * GUI means a spinner that spins forever when the agent stops responding.
 */
const TURN_TIMEOUT_MS = 30 * 60 * 1000;
/** Cap on the total number of live conversations, so a UI bug cannot fork-bomb. */
const MAX_SESSIONS = 8;
/** Prompt size ceiling; a prompt this large is a bug, not an intent. */
const MAX_PROMPT_CHARS = 200_000;

/**
 * Harness definitions.
 *
 * `binary` is looked up on PATH (and in the per-user install locations below,
 * because a GUI app on Windows does not inherit an interactive shell's PATH).
 */
const HARNESSES = {
  antigravity: {
    label: 'Antigravity',
    binary: process.platform === 'win32' ? 'agy.exe' : 'agy',
    extraSearchDirs: () => [
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity'),
      path.join(os.homedir(), '.antigravity', 'bin'),
    ],
    /**
     * `-p` with `--input-format stream-json` keeps one process for many turns.
     * `--print-timeout` is set so a wedged turn fails loudly.
     */
    args: ({ model, mode }) => {
      const args = [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--print-timeout', `${Math.round(TURN_TIMEOUT_MS / 1000)}s`,
      ];
      // Never pass --dangerously-skip-permissions: approval policy stays with
      // the user's own Antigravity settings, and a soft-denied tool is
      // reported to the UI instead of being silently allowed.
      if (model) args.push('--model', model);
      if (mode) args.push('--mode', mode);
      return args;
    },
    /** Encode one prompt as the user event the CLI expects on stdin. */
    encodePrompt: (prompt) => JSON.stringify({ event: 'user', message: prompt }) + '\n',
  },
};

/** Resolve a harness binary, preferring PATH and falling back to known dirs. */
function resolveBinary(spec) {
  const candidates = [spec.binary];
  const searchDirs = typeof spec.extraSearchDirs === 'function' ? spec.extraSearchDirs() : [];
  for (const dir of searchDirs) {
    candidates.push(path.join(dir, spec.binary));
    // Windows ships console shims as .cmd next to the exe.
    if (process.platform === 'win32') candidates.push(path.join(dir, spec.binary.replace(/\.exe$/, '.cmd')));
  }

  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // Not here; try the next candidate.
      }
      continue;
    }
    // Bare name: search PATH ourselves so we can report the resolved path.
    const found = findOnPath(candidate);
    if (found) return found;
  }
  return null;
}

function findOnPath(name) {
  const rawPath = process.env.PATH || process.env.Path || '';
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Report which harnesses are usable.
 *
 * A missing binary is a normal state (the user chose not to install it), so
 * this resolves rather than throwing and the UI can show "not installed".
 */
function detectHarnesses() {
  return Object.entries(HARNESSES).map(([id, spec]) => {
    const binaryPath = resolveBinary(spec);
    return { id, label: spec.label, installed: Boolean(binaryPath), path: binaryPath || null };
  });
}

/** Live conversations, keyed by the session id handed to the renderer. */
const sessions = new Map();
let nextSessionId = 1;

function isValidDirectory(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  try {
    const resolved = fs.realpathSync(path.resolve(candidate));
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Start a harness process for one conversation.
 *
 * @param {{harness: string, cwd: string, model?: string, mode?: string}} options
 * @param {(payload: object) => void} emit forwards lines to the renderer
 */
function startSession(options, emit) {
  const harnessId = String(options?.harness || '');
  const spec = HARNESSES[harnessId];
  if (!spec) return { error: `Unknown harness: ${harnessId}` };

  if (sessions.size >= MAX_SESSIONS) {
    return { error: `Too many agent sessions are open (limit ${MAX_SESSIONS}). Close one first.` };
  }

  const cwd = isValidDirectory(options?.cwd);
  if (!cwd) return { error: 'The working folder does not exist.' };

  const binaryPath = resolveBinary(spec);
  if (!binaryPath) return { error: `${spec.label} CLI was not found. Install it, then reopen the app.` };

  const args = spec.args({ model: options?.model, mode: options?.mode });

  let child;
  try {
    child = spawn(binaryPath, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return { error: `Could not start ${spec.label}: ${error && error.message}` };
  }

  const sessionId = `agent-${nextSessionId}`;
  nextSessionId += 1;

  const session = { child, spec, cwd, timeout: null, stderrTail: '', stopped: false };
  sessions.set(sessionId, session);

  // Split on newlines without assuming the chunks align with lines: a stream
  // can deliver half a JSON object, and passing that through would make the
  // renderer drop an event.
  attachLineReader(child.stdout, (line) => emit({ sessionId, stream: 'stdout', line }));
  attachLineReader(child.stderr, (line) => {
    session.stderrTail = (session.stderrTail + line + '\n').slice(-4000);
    emit({ sessionId, stream: 'stderr', line });
  });

  child.on('error', (error) => {
    emit({ sessionId, stream: 'exit', code: null, error: String(error && error.message) });
    clearTimeout(session.timeout);
    sessions.delete(sessionId);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(session.timeout);
    sessions.delete(sessionId);
    emit({
      sessionId,
      stream: 'exit',
      code,
      signal: signal || null,
      // The tail is what explains a non-zero exit; the frontend shows it.
      stderr: session.stderrTail,
      stopped: session.stopped,
    });
  });

  return { sessionId };
}

function attachLineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer.replace(/\r$/, ''));
    buffer = '';
  });
}

/** Forward one prompt to a conversation. */
function sendPrompt(sessionId, prompt) {
  const session = sessions.get(sessionId);
  if (!session) return { error: 'This agent session is no longer running.' };

  if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'The prompt is empty.' };
  if (prompt.length > MAX_PROMPT_CHARS) return { error: 'The prompt is too long.' };
  if (!session.child.stdin || session.child.stdin.destroyed) {
    return { error: 'The agent process stopped accepting input.' };
  }

  try {
    session.child.stdin.write(session.spec.encodePrompt(prompt));
  } catch (error) {
    return { error: `Could not reach the agent: ${error && error.message}` };
  }

  // A turn that produces nothing for this long is stuck rather than slow.
  clearTimeout(session.timeout);
  session.timeout = setTimeout(() => {
    try {
      session.child.stdin.end();
      session.child.kill();
    } catch {
      // Already gone.
    }
  }, TURN_TIMEOUT_MS);

  return { ok: true };
}

/** Stop a conversation; the exit event still fires so the UI can settle. */
function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: true };
  session.stopped = true;
  clearTimeout(session.timeout);
  try {
    session.child.stdin.end();
    session.child.kill();
  } catch {
    // Already gone.
  }
  sessions.delete(sessionId);
  return { ok: true };
}

/** Kill every process; called on quit so no agent outlives the window. */
function stopAll() {
  for (const id of [...sessions.keys()]) stopSession(id);
}

/**
 * Register the IPC handlers.
 *
 * `getWindow` is passed in rather than imported so a window destroyed mid-run
 * results in dropped events instead of a crash.
 */
function registerAgentIpc(ipcMain, getWindow, log) {
  const emit = (payload) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('amc:agents-event', payload);
  };

  ipcMain.handle('amc:agents-detect', () => detectHarnesses());

  ipcMain.handle('amc:agents-start', (_event, options) => {
    const result = startSession(options, emit);
    if (result.sessionId) {
      log('agent', `started ${options.harness} in ${options.cwd} as ${result.sessionId}`);
    } else {
      log('agent', `start failed: ${result.error}`);
    }
    return result;
  });

  ipcMain.handle('amc:agents-send', (_event, { sessionId, prompt } = {}) => sendPrompt(sessionId, prompt));

  ipcMain.handle('amc:agents-stop', (_event, { sessionId } = {}) => stopSession(sessionId));
}

module.exports = { HARNESSES, detectHarnesses, startSession, sendPrompt, stopSession, stopAll, registerAgentIpc };
