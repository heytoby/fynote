const { app, BrowserWindow, dialog, shell, screen } = require('electron');
const path = require('node:path');

const port = Number(app.commandLine.getSwitchValue('fynote-port'));
const profile = app.commandLine.getSwitchValue('fynote-profile');
const smoke = app.commandLine.hasSwitch('fynote-smoke');
if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.isAbsolute(profile)) {
  app.exit(1);
} else {
  start();
}

function start() {
  app.setName('Fynote');
  app.setAppUserModelId('Fynote.Desktop');
  app.setPath('userData', profile);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const origin = 'http://127.0.0.1:' + port;
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
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
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
