// Electron main process for the AMC-WebUI desktop build.
//
// The app is a static SPA plus a separate Node API server. The desktop shell
// starts the same two servers the Docker image uses, as child processes, then
// shows the web server in a BrowserWindow:
//   - API server : server/dist/server/src/index.js   (loopback port)
//   - web server : electron/web-server.cjs            (serves dist/, proxies /api)
// Running them as real processes keeps the runtime identical to production, so
// no application code depends on Electron-specific behaviour.
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const isDev = !app.isPackaged;
const APP_ROOT = isDev ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'app');
// Dev runs from the repo; a packaged build reads the deployed runtime payload.
const SERVER_ROOT = isDev ? path.join(APP_ROOT, 'server') : path.join(APP_ROOT, 'server-runtime');

// A packaged GUI app has no console on Windows, so capture everything the
// child processes print. Without this, a startup crash is invisible.
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'desktop.log');
let logStream = null;

function initLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch {
    logStream = null; // Logging is best effort; never block startup on it.
  }
}

function log(tag, message) {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}`;
  if (logStream) logStream.write(line + '\n');
  process.stdout.write(line + '\n');
}

let mainWindow = null;
let apiProcess = null;
let webProcess = null;
let apiPort = 0;
let webPort = 0;

/** Ask the OS for a free port so another instance or other software cannot collide. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForHttp(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Port ${port} did not respond in time`));
        else setTimeout(attempt, 300);
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

function spawnNode(args, env) {
  return spawn(process.execPath, args, {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      ...env,
      NODE_ENV: 'production',
      // Makes the Electron binary behave as a plain Node runtime for the child.
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function pipeLogs(child, tag) {
  child.stdout.on('data', (d) => log(tag, String(d).trimEnd()));
  child.stderr.on('data', (d) => log(tag, String(d).trimEnd()));
  // spawn() failures (missing entry file, bad cwd) surface only as an error
  // event; without a listener they become unhandled exceptions.
  child.on('error', (error) => log(tag, `spawn error: ${error && error.message}`));
}

function startApiServer(port, onExit) {
  const entry = path.join(SERVER_ROOT, 'dist', 'server', 'src', 'index.js');
  const child = spawnNode([entry], { PORT: String(port) });
  pipeLogs(child, 'api');
  // The API server crashes fast on a broken install, so report the last output
  // lines instead of only a bare exit code.
  let tail = '';
  const collect = (d) => {
    tail = (tail + String(d)).slice(-1500);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', (code) => {
    if (!app.isQuitting) onExit(code, tail);
  });
  return child;
}

function startWebServer(port, upstreamPort) {
  // Not __dirname: inside a packaged build that points into app.asar, while
  // web-server.cjs ships as an extraResource next to the other payload.
  const entry = path.join(APP_ROOT, 'electron', 'web-server.cjs');
  const child = spawnNode([entry], {
    PORT: String(port),
    WEB_ROOT: path.join(APP_ROOT, 'dist'),
    API_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  });
  pipeLogs(child, 'web');
  return child;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      // The renderer only talks to the local HTTP server, so it stays sandboxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External links go to the user's browser instead of replacing the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${webPort}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function fail(title, detail) {
  log('main', `${title}: ${detail}`);
  dialog.showErrorBox(title, `${detail}\n\nLog file: ${LOG_FILE}`);
  app.quit();
}

async function boot() {
  initLog();
  log('main', `packaged=${app.isPackaged} appRoot=${APP_ROOT} serverRoot=${SERVER_ROOT}`);

  // Fail with an actionable message when the payload is incomplete, which is
  // what a bad build or a partial extraction looks like.
  const apiEntry = path.join(SERVER_ROOT, 'dist', 'server', 'src', 'index.js');
  if (!fs.existsSync(apiEntry)) {
    fail('Installation is incomplete', `Missing API server entry:\n${apiEntry}`);
    return false;
  }
  const webEntry = path.join(APP_ROOT, 'electron', 'web-server.cjs');
  if (!fs.existsSync(webEntry)) {
    fail('Installation is incomplete', `Missing web server entry:\n${webEntry}`);
    return false;
  }
  if (!fs.existsSync(path.join(APP_ROOT, 'dist', 'index.html'))) {
    fail('Installation is incomplete', `Missing frontend build:\n${path.join(APP_ROOT, 'dist')}`);
    return false;
  }

  apiPort = await findFreePort();
  webPort = await findFreePort();
  log('main', `ports api=${apiPort} web=${webPort}`);

  // Resolve the first failure instead of letting the startup timeout fire, so
  // the user sees the real cause rather than "did not respond in time".
  const apiFailure = new Promise((_, reject) => {
    apiProcess = startApiServer(apiPort, (code, tail) => {
      reject(new Error(`The API server exited with code ${code}.\n\n${tail.trim() || '(no output)'}`));
    });
  });

  try {
    await Promise.race([waitForHttp(apiPort), apiFailure]);
  } catch (error) {
    fail('API server failed to start', String(error && error.message ? error.message : error));
    return false;
  }

  webProcess = startWebServer(webPort, apiPort);
  try {
    await waitForHttp(webPort);
  } catch (error) {
    fail('Web server failed to start', String(error && error.message ? error.message : error));
    return false;
  }

  await createWindow();
  return true;
}

function shutdown() {
  app.isQuitting = true;
  for (const child of [webProcess, apiProcess]) {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // boot() reports its own failures with the child process output.
  const started = await boot().catch((error) => {
    fail('Failed to start', String(error && error.message ? error.message : error));
    return false;
  });
  if (!started) return;

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  shutdown();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', shutdown);
process.on('exit', shutdown);
