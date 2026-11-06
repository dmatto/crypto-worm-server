// Crypto Worm Wars for Windows, Mac and Linux: a window around the live game at
// play.cryptoworm.io. Game pages stay in the app; other links open in the browser.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

const HOST = 'play.cryptoworm.io';
const SRC = { win32: 'windows', darwin: 'mac' }[process.platform] || 'linux';
const START_URL = `https://${HOST}/?src=${SRC}`;

const isGame = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === HOST; } catch (e) { return false; } };
const openOutside = (url) => { try { const u = new URL(url); if (['https:', 'http:', 'tg:', 'mailto:'].includes(u.protocol)) shell.openExternal(url); } catch (e) {} };

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 400,
    backgroundColor: '#0d1030', title: 'Crypto Worm Wars',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.webContents.setUserAgent(win.webContents.getUserAgent() + ' CryptoWormApp/' + SRC);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isGame(url)) win.loadURL(url); else openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isGame(url) && !url.startsWith('file:')) { e.preventDefault(); openOutside(url); }
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, mainFrame) => {
    if (mainFrame && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { u: START_URL } });
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.key === 'Escape' && win.isFullScreen()) { win.setFullScreen(false); }
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') { win.reload(); e.preventDefault(); }
  });

  win.loadURL(START_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' }, { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
        { role: 'windowMenu' },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
