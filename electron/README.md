# Desktop build (Electron)

The web app is served by two Node processes in production (`docker/web-server.js`
+ the compiled API server). This shell reuses exactly that arrangement.

## How it boots

`electron/main.cjs`:

1. asks the OS for two free loopback ports;
2. starts `server-runtime/dist/server/src/index.js` (packaged) or
   `server/dist/server/src/index.js` (dev) as a child Node process via
   `ELECTRON_RUN_AS_NODE`;
3. starts `electron/web-server.cjs` with `WEB_ROOT=dist` and
   `API_UPSTREAM=http://127.0.0.1:<apiPort>`;
4. loads `http://127.0.0.1:<webPort>` in a sandboxed `BrowserWindow`.

Because the frontend and the proxied `/api` share one origin, no application
code changes are needed.

## Build

```bash
pnpm approve-builds          # allow the electron binary download
pnpm build:desktop           # vite build (PYODIDE_ASSETS_EXTERNAL=true) + build:api
pnpm --filter amc-webui-api deploy --prod ./.tmp-runtime   # self-contained server deps
pnpm dist:win                # electron-builder --win --x64
```

`PYODIDE_ASSETS_EXTERNAL=true` is required: the default build downloads Pyodide
from jsDelivr, which times out on slow links.

## Cross-building Windows from Linux

`rcedit` (used to stamp icon/version metadata) needs Wine with a 32-bit prefix:

```bash
dpkg --add-architecture i386 && apt-get update
apt-get install -y wine32:i386 wine64 xvfb
export WINEARCH=win32 WINEDLLOVERRIDES="mscoree,mshtml="
xvfb-run -a wineboot -u
CSC_IDENTITY_AUTO_DISCOVERY=false xvfb-run -a pnpm dist:win
```

Outputs land in `release/`.

## Desktop icon

`build-resources/icon.png` is a generated placeholder; replace it with real
artwork before a public release.
