const { app, BrowserWindow, dialog, shell, screen, ipcMain, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const UPDATE_REPOSITORY = 'heytoby/fynote';
const LATEST_RELEASE_API = process.env.FYNOTE_UPDATE_API ||
  'https://api.github.com/repos/' + UPDATE_REPOSITORY + '/releases/latest';
const SETUP_EXIT_CODE = 43;

/** Folder that holds versions/, current.json and .update (the install root). */
function installRoot(webRoot) {
  return path.resolve(webRoot, '..', '..', '..');
}

function currentVersion(webRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(webRoot, '..', '..', 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

function compareVersion(left, right) {
  const parts = (value) => String(value || '').replace(/^v/i, '').split('-')[0].split('.').map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Ask GitHub for the newest published installer. */
async function checkForUpdate(webRoot) {
  const current = currentVersion(webRoot);
  const response = await fetch(LATEST_RELEASE_API, {
    headers: { 'User-Agent': 'Fynote Desktop', Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) throw new Error('GitHub returned ' + response.status);
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Unexpected release tag');
  const name = 'fynote-Setup-' + version + '.exe';
  const asset = (release.assets || []).find((item) => item && item.name === name &&
    item.state === 'uploaded' && typeof item.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(item.digest));
  const isOutdated = compareVersion(version, current) > 0;
  return {
    current,
    latest: version,
    isOutdated,
    canInstall: isOutdated && !!asset,
    releaseUrl: 'https://github.com/' + UPDATE_REPOSITORY + '/releases/tag/' + release.tag_name,
    notes: String(release.body || '').slice(0, 4000),
    asset: asset ? { url: asset.browser_download_url, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() } : null
  };
}

/** Download the installer, verify it, then hand over to the launcher (exit 43). */
async function installUpdate(webRoot) {
  const info = await checkForUpdate(webRoot);
  if (!info.canInstall || !info.asset) throw new Error('No installable update.');
  const directory = path.join(installRoot(webRoot), '.update');
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, 'setup.download');
  const target = path.join(directory, 'setup.exe');
  const response = await fetch(info.asset.url, { headers: { 'User-Agent': 'Fynote Desktop' } });
  if (!response.ok || !response.body) throw new Error('Download failed (' + response.status + ').');
  const hash = crypto.createHash('sha256');
  const meter = new TransformStream({
    transform(chunk, controller) { hash.update(chunk); controller.enqueue(chunk); }
  });
  await pipeline(Readable.fromWeb(response.body.pipeThrough(meter)), fs.createWriteStream(temporary));
  const digest = hash.digest('hex');
  if (digest !== info.asset.sha256 || fs.statSync(temporary).size !== info.asset.size) {
    fs.rmSync(temporary, { force: true });
    throw new Error('Downloaded installer did not match the release.');
  }
  fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);
  setTimeout(() => app.exit(SETUP_EXIT_CODE), 300);
  return { version: info.latest };
}


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

  ipcMain.handle('fynote:update:check', () => checkForUpdate(webRoot));
  ipcMain.handle('fynote:update:install', () => installUpdate(webRoot));
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
    headers: {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // The app is served from disk; never let Chromium serve a stale bundle.
      'Cache-Control': 'no-store'
    }
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
