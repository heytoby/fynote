const { app, BrowserWindow, dialog, shell, screen, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/** Markdown library root: Documents/Fynote, overridable for tests. */
function notesRoot() {
  const override = process.env.FYNOTE_NOTES_DIR;
  if (override && path.isAbsolute(override)) return override;
  return path.join(app.getPath('documents'), 'Fynote');
}

/** Resolve a renderer-supplied relative path inside the library, or throw. */
function safePath(root, relativePath) {
  const target = path.resolve(root, String(relativePath || ''));
  const prefix = path.resolve(root) + path.sep;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) throw new Error('Path escapes the notes library.');
  return target;
}

function walkMarkdown(root, current, files) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) walkMarkdown(root, full, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const stat = fs.statSync(full);
      files.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        content: fs.readFileSync(full, 'utf8'),
        modifiedMs: stat.mtimeMs
      });
    }
  }
}

function registerNotesIpc() {
  ipcMain.handle('fynote:notes:dir', () => notesRoot());

  ipcMain.handle('fynote:notes:list', () => {
    const root = notesRoot();
    fs.mkdirSync(root, { recursive: true });
    const files = [];
    walkMarkdown(root, root, files);
    return files;
  });

  ipcMain.handle('fynote:notes:write', (_event, relativePath, content) => {
    const root = notesRoot();
    fs.mkdirSync(root, { recursive: true });
    const target = safePath(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(content ?? ''), 'utf8');
    return true;
  });

  ipcMain.handle('fynote:notes:remove', (_event, relativePath) => {
    fs.rmSync(safePath(notesRoot(), relativePath), { force: true });
    return true;
  });
}


// The SPA is served from a privileged scheme so IndexedDB/localStorage keep a
// real, stable origin without any local HTTP server.
protocol.registerSchemesAsPrivileged([{
  scheme: 'fynote',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

const ORIGIN = 'fynote://app';
const profile = app.commandLine.getSwitchValue('fynote-profile');
const smoke = app.commandLine.hasSwitch('fynote-smoke');
const webRoot = path.resolve(__dirname, '..', '..', '..', 'app', 'dist', 'keep');
if (!path.isAbsolute(profile) || !fs.existsSync(path.join(webRoot, 'index.html'))) {
  app.exit(1);
} else {
  start();
}

function serveWebAsset(request) {
  const url = new URL(request.url);
  const requested = decodeURIComponent(url.pathname);
  const candidate = path.resolve(webRoot, '.' + requested);
  const inside = candidate === webRoot || candidate.startsWith(webRoot + path.sep);
  let file = inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
  if (!file) file = path.join(webRoot, 'index.html');
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2', '.otf': 'font/otf', '.svg': 'image/svg+xml'
  };
  return new Response(fs.createReadStream(file), {
    headers: { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' }
  });
}

function start() {
  app.setName('Fynote');
  app.setAppUserModelId('Fynote.Desktop');
  app.setPath('userData', profile);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const origin = ORIGIN;
  let window;
  function openExternal(url) {
    try {
      const target = new URL(url);
      if ((target.protocol === 'https:' || target.protocol === 'http:') && target.origin !== origin) {
        void shell.openExternal(target.href).catch(() => {});
      }
    } catch {}
  }

  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    protocol.handle('fynote', serveWebAsset);
    registerNotesIpc();
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const w = Math.min(1160, width);
    const h = Math.min(820, height);
    window = new BrowserWindow({
      title: 'Fynote',
      x: x + Math.floor((width - w) / 2),
      y: y + Math.floor((height - h) / 2),
      width: w,
      height: h,
      minWidth: Math.min(680, w),
      minHeight: Math.min(480, h),
      show: false,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#e6e6e6', symbolColor: '#17161b', height: 48 },
      roundedCorners: true,
      backgroundColor: '#e6e6e6',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.cjs')
      }
    });
    window.removeMenu();
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin === origin) return;
      event.preventDefault();
      openExternal(url);
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('dom-ready', () => {
      void window.webContents.insertCSS(`
        app-navbar .navbar, app-navbar .selection-navbar {
          padding-right: 148px !important;
          -webkit-app-region: drag;
        }
        app-navbar :is(button, a, input, form, .filters-dropdown, .profile-menu, [data-tooltip]) {
          -webkit-app-region: no-drag;
        }
        body:not(:has(app-navbar))::before {
          content: ''; position: fixed; top: 0; left: 0; right: 148px;
          height: 32px; z-index: 9999; -webkit-app-region: drag;
        }
      `).catch(() => {});
    });

    await window.loadURL(origin);
    if (smoke) {
      const loaded = await window.webContents.executeJavaScript('Boolean(document.querySelector("app-root"))');
      app.exit(loaded ? 0 : 1);
    } else {
      window.show();
    }
  }).catch(error => {
    if (!smoke) dialog.showErrorBox('无法启动 Fynote', error.message);
    app.exit(1);
  });
}
