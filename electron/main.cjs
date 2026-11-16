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
const { spawn } = require('node:child_process');

const isDev = !app.isPackaged;
const APP_ROOT = isDev ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'app');
// Dev runs from the repo; a packaged build reads the deployed runtime payload.
const SERVER_ROOT = isDev ? path.join(APP_ROOT, 'server') : path.join(APP_ROOT, 'server-runtime');

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
  child.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
}

function startApiServer(port) {
  const entry = path.join(SERVER_ROOT, 'dist', 'server', 'src', 'index.js');
  const child = spawnNode([entry], { PORT: String(port) });
  pipeLogs(child, 'api');
  child.on('exit', (code) => {
    if (code !== 0 && !app.isQuitting) {
      dialog.showErrorBox('API server stopped', `The local API server exited with code ${code}.`);
    }
  });
  return child;
}

function startWebServer(port, upstreamPort) {
  const entry = path.join(__dirname, 'web-server.cjs');
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

async function boot() {
  apiPort = await findFreePort();
  webPort = await findFreePort();

  apiProcess = startApiServer(apiPort);
  await waitForHttp(apiPort);

  webProcess = startWebServer(webPort, apiPort);
  await waitForHttp(webPort);

  await createWindow();
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
  try {
    await boot();
  } catch (error) {
    dialog.showErrorBox('Failed to start', String(error && error.message ? error.message : error));
    app.quit();
  }

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
