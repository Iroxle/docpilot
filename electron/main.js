'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell, clipboard, ClipboardItem, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { buildMenu } = require('./menu');
const { FontCatalog, wordDefaults } = require('./fonts');
// macOS: counterparts of the Windows-specific parts (IT policy, Office, scanner, fonts).
const mac = process.platform === 'darwin' ? require('./mac') : null;

const APP_NAME = 'DocPilot';
const RENDERER_DIR = path.join(__dirname, '..', 'dist', 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json',
  '.gz': 'application/gzip', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf', '.icc': 'application/octet-stream',
};

app.setName(APP_NAME);
app.setAppUserModelId('com.docpilot.app');
if (process.env.DP_USER_DATA) app.setPath('userData', process.env.DP_USER_DATA);

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

/** @type {BrowserWindow|null} */
let win = null;
let allowClose = false;
let rendererReady = false;
const pendingPaths = [];

const dataFile = (n) => path.join(app.getPath('userData'), n);
function readJson(n, fallback) {
  try { return JSON.parse(fs.readFileSync(dataFile(n), 'utf8')); } catch { return fallback; }
}
function writeJson(n, value) {
  fs.mkdirSync(path.dirname(dataFile(n)), { recursive: true });
  const tmp = dataFile(n) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, dataFile(n));
}

const settings = () => readJson('settings.json', {});

/**
 * IT policy under HKLM\SOFTWARE\Policies\DocPilot.
 * Default: JavaScript in PDFs and macros when converting Office files are permanently blocked.
 * Only IT can enable them (DWORD AllowJavaScript = 1, AllowOfficeMacros = 1). Normal users cannot
 * change HKLM, and a manually edited settings.json does not lift the block either.
 */
const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\DocPilot';
function readPolicy() {
  // Only for automated tests in the development build, never in the installed program.
  if (!app.isPackaged && process.env.DP_TEST_POLICY === 'allow') return { allowJavaScript: true, allowOfficeMacros: true, key: POLICY_KEY };
  if (mac) return Object.freeze(mac.policy());
  const p = { allowJavaScript: false, allowOfficeMacros: false, key: POLICY_KEY };
  try {
    const out = execFileSync('reg.exe', ['query', POLICY_KEY], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const on = (n) => { const m = new RegExp(`^\\s*${n}\\s+REG_DWORD\\s+0x([0-9a-f]+)\\s*$`, 'im').exec(out); return !!m && parseInt(m[1], 16) === 1; };
    p.allowJavaScript = on('AllowJavaScript');
    p.allowOfficeMacros = on('AllowOfficeMacros');
  } catch { /* key missing: everything stays blocked */ }
  return Object.freeze(p);
}
const POLICY = readPolicy();
const recentCount = () => Math.min(50, Math.max(1, Number(settings().recentCount) || 10));

function pathsFromArgv(argv) {
  return argv.slice(1).filter((a) => /\.pdf$/i.test(a) && !a.startsWith('-') && fs.existsSync(a)).map((a) => path.resolve(a));
}
function requestOpen(paths) {
  if (!paths.length) return;
  if (win && rendererReady) win.webContents.send('dp:open-paths', paths);
  else pendingPaths.push(...paths);
}

function refreshMenu() {
  const recent = readJson('recent.json', []).slice(0, recentCount());
  Menu.setApplicationMenu(buildMenu({
    recent,
    send: (cmd, arg) => { if (win) win.webContents.send('dp:command', cmd, arg); },
    openRecent: (p) => requestOpen([p]),
    devtools: () => win && win.webContents.toggleDevTools(),
  }));
}

/**
 * Appearance from Preferences (General): 'light' (default), 'dark' or 'system' (same as Windows).
 * Applies to the menus, the window buttons and system dialogs; the interface itself is colored by styles.css.
 */
function applyAppearance() {
  const v = settings().appearance;
  nativeTheme.themeSource = v === 'dark' || v === 'system' ? v : 'light';
  if (win) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#f3f4f6');
}

/**
 * DocPilot draws its own title bar with the tabs (#topbar in styles.css, TITLEBAR px high). On Windows the system adds
 * only the minimize, maximize and close buttons at the right, in the colors of the bar: these start values match
 * --titlebar and --ink2 in styles.css, and the window reports the exact colors after every change of the appearance
 * (dp:titlebar). On a Mac the three window buttons sit at the left of the bar.
 */
const TITLEBAR = 40;
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s/%]+\))$/i;
const titleBarColors = () => (nativeTheme.shouldUseDarkColors ? { color: '#141517', symbolColor: '#c0bdbb' } : { color: '#e9ebee', symbolColor: '#4a4647' });
const windowState = () => ({ fullscreen: !!win && win.isFullScreen(), maximized: !!win && win.isMaximized() });
const sendWindowState = () => { if (win) win.webContents.send('dp:window-state', windowState()); };

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, show: false,
    title: APP_NAME, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#f3f4f6',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    titleBarStyle: 'hidden',
    ...(mac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { ...titleBarColors(), height: TITLEBAR } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true,
    },
  });
  for (const ev of ['enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize']) win.on(ev, sendWindowState);
  const bounds = readJson('window.json', null);
  if (bounds && bounds.width) win.setBounds(bounds);
  if (bounds && bounds.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.env.DP_HIDE) win.show(); });
  win.loadURL('app://docpilot/index.html');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.on('close', (e) => {
    try { writeJson('window.json', { ...win.getNormalBounds(), maximized: win.isMaximized() }); } catch { /* not critical */ }
    if (allowClose || !rendererReady) return;
    e.preventDefault();
    win.webContents.send('dp:request-close');
  });
  win.on('closed', () => { win = null; rendererReady = false; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    requestOpen(pathsFromArgv(argv));
  });
  app.on('open-file', (e, p) => { e.preventDefault(); requestOpen([p]); });
  app.whenReady().then(() => {
    // Appearance from Preferences. The default is light, even when Windows runs in dark mode.
    applyAppearance();
    protocol.handle('app', async (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
      // Fonts for preview and input field: only faces from the catalog, addressed by their number.
      const fm = /^__font\/(\d+)$/.exec(rel);
      if (fm) {
        await fontCatalog().load();
        const data = await fontCatalog().data(Number(fm[1])).catch(() => null);
        return data ? new Response(data, { headers: { 'content-type': 'font/ttf', 'cache-control': 'max-age=3600' } }) : new Response('not found', { status: 404 });
      }
      // Pictures of recent files (home page): only the files of the thumbnail folder, addressed by their key.
      const tm = /^__thumb\/([0-9a-f]{24})\.jpg$/.exec(rel);
      if (tm) {
        try { return new Response(await fs.promises.readFile(thumbFile(tm[1])), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' } }); }
        catch { return new Response('not found', { status: 404 }); }
      }
      const file = path.normalize(path.join(RENDERER_DIR, rel));
      if (!file.startsWith(RENDERER_DIR)) return new Response('forbidden', { status: 403 });
      try {
        const data = await fs.promises.readFile(file);
        return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
      } catch { return new Response('not found', { status: 404 }); }
    });
    pendingPaths.push(...pathsFromArgv(process.argv));
    refreshMenu();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

const toBuf = (b) => Buffer.from(b.buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b);

ipcMain.handle('dp:ready', () => { rendererReady = true; const p = pendingPaths.splice(0); return p; });
ipcMain.handle('dp:close-ok', () => { allowClose = true; if (win) win.close(); });
ipcMain.handle('dp:set-title', (_e, t) => { if (win) win.setTitle(t ? `${t} - ${APP_NAME}` : APP_NAME); });
// On a Mac, full screen is an animated transition: isFullScreen() only changes once it has finished.
// Until then, the state requested last counts.
let fullScreenWanted = null;
ipcMain.handle('dp:fullscreen', (_e, on) => {
  if (!win) return false;
  const now = mac && fullScreenWanted !== null ? fullScreenWanted : win.isFullScreen();
  const target = on === undefined ? !now : !!on;
  if (mac) { fullScreenWanted = target; win.once(target ? 'enter-full-screen' : 'leave-full-screen', () => { fullScreenWanted = null; }); }
  win.setFullScreen(target);
  return mac ? target : win.isFullScreen();
});
ipcMain.handle('dp:window-state', () => windowState());
// Colors of the window buttons (Windows): those of DocPilot's title bar in the current appearance.
ipcMain.handle('dp:titlebar', (_e, c) => {
  if (!win || mac || !c || !COLOR.test(String(c.color).trim()) || !COLOR.test(String(c.symbolColor).trim())) return false;
  win.setTitleBarOverlay({ color: String(c.color).trim(), symbolColor: String(c.symbolColor).trim(), height: TITLEBAR });
  return true;
});
// The menu behind the ☰ button of the title bar: the menu bar's menu with all entries and shortcuts, below the button.
ipcMain.handle('dp:menu', (_e, x, y) => {
  const m = Menu.getApplicationMenu();
  if (!win || !m) return false;
  m.popup({ window: win, x: Math.max(0, Math.round(Number(x) || 0)), y: Math.max(0, Math.round(Number(y) || 0)) });
  return true;
});
ipcMain.handle('dp:version', () => app.getVersion());
ipcMain.handle('dp:policy', () => POLICY);

ipcMain.handle('dp:open-dialog', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title || 'Open',
    filters: opts.filters || [{ name: 'PDF files', extensions: ['pdf'] }],
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dp:save-dialog', async (_e, opts = {}) => {
  const r = await dialog.showSaveDialog(win, {
    title: opts.title || 'Save as', defaultPath: opts.defaultPath,
    filters: opts.filters || [{ name: 'PDF files', extensions: ['pdf'] }],
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dp:folder-dialog', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dp:read-file', async (_e, p) => {
  const b = await fs.promises.readFile(p);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
});
// Write atomically: an existing file is only replaced once the new content is completely on disk.
ipcMain.handle('dp:write-file', async (_e, p, bytes) => {
  const tmp = `${p}.bmtmp-${process.pid}`;
  await fs.promises.writeFile(tmp, toBuf(bytes));
  try { await fs.promises.rename(tmp, p); }
  catch (err) {
    await fs.promises.rm(tmp, { force: true });
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw new Error('The file is open in another program or is read-only.');
    }
    throw err;
  }
  return true;
});
ipcMain.handle('dp:file-stat', async (_e, p) => {
  try { const s = await fs.promises.stat(p); return { size: s.size, mtime: s.mtimeMs, ctime: s.birthtimeMs }; } catch { return null; }
});
ipcMain.handle('dp:reveal', (_e, p) => shell.showItemInFolder(p));

// Autosave: copies of documents with unsaved changes in the data folder (see src/autosave.js). The id is checked so
// that it can only name a file in that folder.
const autosaveDir = () => path.join(app.getPath('userData'), 'autosave');
const autosaveFile = (id, ext) => { if (!/^[a-z0-9-]{1,80}$/i.test(String(id))) throw new Error('Invalid autosave id'); return path.join(autosaveDir(), `${id}.${ext}`); };
ipcMain.handle('dp:autosave-write', async (_e, id, bytes, meta) => {
  await fs.promises.mkdir(autosaveDir(), { recursive: true });
  const tmp = `${autosaveFile(id, 'pdf')}.tmp`;
  await fs.promises.writeFile(tmp, toBuf(bytes));
  await fs.promises.rename(tmp, autosaveFile(id, 'pdf'));
  await fs.promises.writeFile(autosaveFile(id, 'json'), JSON.stringify({ name: String(meta?.name || 'Document.pdf'), path: String(meta?.path || ''), time: Number(meta?.time) || Date.now() }));
  return true;
});
ipcMain.handle('dp:autosave-remove', async (_e, id) => { for (const x of ['pdf', 'json']) await fs.promises.rm(autosaveFile(id, x), { force: true }); return true; });
ipcMain.handle('dp:autosave-read', async (_e, id) => { try { return new Uint8Array(await fs.promises.readFile(autosaveFile(id, 'pdf'))); } catch { return null; } });
ipcMain.handle('dp:autosave-list', async () => {
  let names = [];
  try { names = await fs.promises.readdir(autosaveDir()); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    const id = n.slice(0, -5);
    try { const meta = JSON.parse(await fs.promises.readFile(autosaveFile(id, 'json'), 'utf8')); if (fs.existsSync(autosaveFile(id, 'pdf'))) out.push({ id, ...meta }); } catch { /* damaged copy: skip */ }
  }
  return out.sort((a, b) => a.time - b.time);
});
// Links from documents: behavior according to the preference (ask, always allow, block).
ipcMain.handle('dp:open-external', async (_e, url) => {
  if (!/^(https?:|mailto:)/i.test(url)) return false;
  const mode = settings().links || 'ask';
  if (mode === 'block') {
    await dialog.showMessageBox(win, { type: 'info', title: APP_NAME, message: 'Links to web pages are blocked in Preferences.', detail: url });
    return false;
  }
  if (mode === 'allow') { await shell.openExternal(url); return true; }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Open', 'Cancel'], defaultId: 0, cancelId: 1,
    title: APP_NAME, message: 'This link leads outside the document. Open it?', detail: url,
  });
  if (response !== 0) return false;
  await shell.openExternal(url);
  return true;
});
// Only open folders (e.g. the destination of an export). Files or programs are never started this way.
ipcMain.handle('dp:open-path', async (_e, p) => {
  try { if (!(await fs.promises.stat(p)).isDirectory() || (mac && mac.isBundle(p))) return 'Only folders can be opened.'; }
  catch { return 'The folder was not found.'; }
  return shell.openPath(p);
});

// Pictures of the first page of recent files for the home page: JPEG files in <userData>/thumbs, named after the
// file's path, served as app://docpilot/__thumb/<key>.jpg. A picture counts while the file has not changed since.
const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');
const thumbKey = (p) => crypto.createHash('sha1').update(String(p).toLowerCase()).digest('hex').slice(0, 24);
const thumbFile = (key) => path.join(thumbDir(), `${key}.jpg`);
const dropThumbs = (list) => { for (const r of list) if (r.thumb) fs.rmSync(thumbFile(thumbKey(r.path)), { force: true }); };
ipcMain.handle('dp:recent-get', () => readJson('recent.json', []).slice(0, recentCount()).map((r) => {
  let st = null;
  try { st = fs.statSync(r.path); } catch { /* moved or deleted */ }
  const fresh = st && r.thumb && r.thumbOf >= st.mtimeMs - 2000 && fs.existsSync(thumbFile(thumbKey(r.path)));
  return { path: r.path, name: r.name, opened: r.opened, exists: !!st, size: st ? st.size : 0, thumb: fresh ? `app://docpilot/__thumb/${thumbKey(r.path)}.jpg?v=${Math.round(r.thumbOf)}` : null };
}));
ipcMain.handle('dp:recent-add', (_e, p) => {
  const all = readJson('recent.json', []);
  const old = all.find((r) => r.path.toLowerCase() === p.toLowerCase());
  const list = all.filter((r) => r !== old);
  list.unshift({ ...(old?.thumb ? { thumb: old.thumb, thumbOf: old.thumbOf } : {}), path: p, name: path.basename(p), opened: Date.now() });
  dropThumbs(list.slice(30));
  writeJson('recent.json', list.slice(0, 30));
  refreshMenu();
});
ipcMain.handle('dp:recent-remove', (_e, p) => {
  const all = readJson('recent.json', []);
  dropThumbs(p ? all.filter((r) => r.path === p) : all);
  writeJson('recent.json', p ? all.filter((r) => r.path !== p) : []);
  refreshMenu();
});
ipcMain.handle('dp:recent-thumb', async (_e, p, bytes) => {
  const list = readJson('recent.json', []);
  const r = list.find((x) => x.path.toLowerCase() === String(p).toLowerCase());
  const b = bytes ? toBuf(bytes) : null;
  if (!r || !b || b.length > 2e6 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  await fs.promises.mkdir(thumbDir(), { recursive: true });
  await fs.promises.writeFile(thumbFile(thumbKey(r.path)), b);
  const st = await fs.promises.stat(r.path).catch(() => null);
  r.thumb = true; r.thumbOf = st ? st.mtimeMs : Date.now();
  writeJson('recent.json', list);
  return `app://docpilot/__thumb/${thumbKey(r.path)}.jpg?v=${Math.round(r.thumbOf)}`;
});
ipcMain.handle('dp:settings-get', () => readJson('settings.json', {}));
ipcMain.handle('dp:settings-set', (_e, s) => { writeJson('settings.json', s); applyAppearance(); refreshMenu(); return true; });

// Windows fonts for new text in the PDF. Only files from the fonts folder are readable.
const FONT_DIR = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
ipcMain.handle('dp:font', async (_e, file) => {
  const p = mac ? mac.fontFile(file) : path.join(FONT_DIR, path.basename(file));
  try { const b = await fs.promises.readFile(p); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); } catch { return null; }
});
// All fonts like in Word (installed and Office cloud fonts) and Word's default font.
let catalog = null;
const fontCatalog = () => (catalog || (catalog = new FontCatalog(dataFile('fonts-cache.json'))));
ipcMain.handle('dp:fonts', async () => ({ ...(await fontCatalog().load()), word: wordDefaults() }));
ipcMain.handle('dp:font-face', async (_e, id) => {
  await fontCatalog().load();
  try { const b = await fontCatalog().data(Number(id)); return b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null; } catch { return null; }
});
ipcMain.handle('dp:srgb-icc', async () => {
  const p = mac ? mac.SRGB_ICC : path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'spool', 'drivers', 'color', 'sRGB Color Space Profile.icm');
  try { const b = await fs.promises.readFile(p); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); } catch { return null; }
});
// Clipboard (since Electron 45 only asynchronously via clipboard.read/write with ClipboardItem).
// Windows screenshots (Win+Shift+S, Print key) are stored there as an image, which is read as PNG.
async function readClipboardImage() {
  const { nativeImage } = require('electron');
  const items = await clipboard.read();
  for (const it of items) {
    const type = it.types.find((t) => t === 'image/png') || it.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    let b = Buffer.from(await (await it.getType(type)).arrayBuffer());
    if (type !== 'image/png') { const img = nativeImage.createFromBuffer(b); if (img.isEmpty()) continue; b = img.toPNG(); }
    if (!b.length) continue;
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  return null;
}
ipcMain.handle('dp:clipboard-image', async () => {
  // Windows briefly locks the clipboard while another program writes to it (e.g. the
  // Snipping Tool right after the screenshot). Then wait briefly and read again.
  for (let k = 0; k < 6; k++) {
    try {
      const img = await readClipboardImage();
      if (img) return img;
      if (!clipboard.availableFormats().some((f) => f.startsWith('image/'))) return null;
    } catch { /* locked: try again */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
});
ipcMain.handle('dp:clipboard-write-image', async (_e, bytes) => {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([toBuf(bytes)], { type: 'image/png' }) })]);
  return true;
});

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'docpilot-')); }

function runPowerShell(script, env, timeout = 240000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

// Convert Office files using a locally installed Microsoft Office.
// Paths are passed through environment variables so file names are never interpreted as commands.
// Macros: AutomationSecurity 3 blocks all macros (default), 2 uses the user's Office settings.
// 2 only applies if IT has enabled macros through the policy AND the user has turned them on.
const macroSecurity = () => (POLICY.allowOfficeMacros && settings().officeMacros === true ? '2' : '3');
const OFFICE_SCRIPTS = {
  word: `$a=New-Object -ComObject Word.Application;$a.Visible=$false;$a.AutomationSecurity=[int]$env:DP_SEC;try{$d=$a.Documents.Open($env:DP_IN,$false,$true);$d.ExportAsFixedFormat($env:DP_OUT,17);$d.Close(0)}finally{$a.Quit()}`,
  excel: `$a=New-Object -ComObject Excel.Application;$a.Visible=$false;$a.DisplayAlerts=$false;$a.AutomationSecurity=[int]$env:DP_SEC;try{$d=$a.Workbooks.Open($env:DP_IN,0,$true);$d.ExportAsFixedFormat(0,$env:DP_OUT);$d.Close($false)}finally{$a.Quit()}`,
  powerpoint: `$a=New-Object -ComObject PowerPoint.Application;$a.AutomationSecurity=[int]$env:DP_SEC;try{$d=$a.Presentations.Open($env:DP_IN,-1,0,0);$d.SaveAs($env:DP_OUT,32);$d.Close()}finally{$a.Quit()}`,
};
ipcMain.handle('dp:office-available', async () => {
  if (mac) return mac.officeAvailable();
  try {
    const out = await runPowerShell(`foreach($n in 'Word.Application','Excel.Application','PowerPoint.Application'){ if(Test-Path "Registry::HKEY_CLASSES_ROOT\\$n\\CLSID"){$n} }`, {}, 20000);
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return []; }
});
ipcMain.handle('dp:office-to-pdf', async (_e, input) => {
  const ext = path.extname(input).toLowerCase();
  const kind = /\.docx?$|\.rtf$|\.odt$/.test(ext) ? 'word' : /\.xlsx?$|\.xlsm$|\.ods$|\.csv$/.test(ext) ? 'excel' : /\.pptx?$|\.odp$/.test(ext) ? 'powerpoint' : null;
  if (!kind) throw new Error('This file type is not supported.');
  const dir = tempDir();
  const out = path.join(dir, 'out.pdf');
  try {
    if (mac) await mac.officeToPdf(kind, input, out, macroSecurity() === '2');
    else await runPowerShell(OFFICE_SCRIPTS[kind], { DP_IN: input, DP_OUT: out, DP_SEC: macroSecurity() });
    const b = await fs.promises.readFile(out);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Scanner via the Windows WIA interface (on a Mac via the helper program, see electron/mac.js).
ipcMain.handle('dp:scan', async () => {
  const dir = tempDir();
  const out = path.join(dir, 'scan.png');
  try {
    if (mac) await mac.scan(out);
    else await runPowerShell(`$d=New-Object -ComObject WIA.CommonDialog;$i=$d.ShowAcquireImage();if($i){$f=New-Object -ComObject WIA.ImageFile;$p=New-Object -ComObject WIA.ImageProcess;$p.Filters.Add($p.FilterInfos.Item('Convert').FilterID);$p.Filters.Item(1).Properties.Item('FormatID').Value='{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}';$i=$p.Apply($i);$i.SaveFile($env:DP_OUT)}`, { DP_OUT: out }, 600000);
    if (!fs.existsSync(out)) return null;
    const b = await fs.promises.readFile(out);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Invisible windows for conversion and printing: without JavaScript and without internet. Only local
// files and embedded data are allowed, so that e.g. an HTML file cannot load anything or send anything out.
let offline = null;
function offlineSession() {
  if (!offline) {
    offline = session.fromPartition('dp-offline');
    offline.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|blob):/i.test(d.url) }));
    offline.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  }
  return offline;
}
function hiddenWindow(extra = {}) {
  const w = new BrowserWindow({
    show: false, width: 1000, height: 1400,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, session: offlineSession(), ...extra },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  return w;
}

ipcMain.handle('dp:html-to-pdf', async (_e, html, opts = {}) => {
  const dir = tempDir();
  const w = hiddenWindow();
  try {
    const file = path.join(dir, 'in.html');
    await fs.promises.writeFile(file, html, 'utf8');
    await w.loadFile(file);
    const out = await w.webContents.printToPDF({ printBackground: true, pageSize: opts.pageSize || 'A4', landscape: !!opts.landscape });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } finally { w.destroy(); fs.rmSync(dir, { recursive: true, force: true }); }
});

ipcMain.handle('dp:printers', async () => {
  const list = await win.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
});

function printHtml(files, pages, o) {
  const body = files.map((f, i) => {
    const size = o.fit === 'actual'
      ? `width:${pages[i].width}pt;height:${pages[i].height}pt` : 'width:100%;height:100%;object-fit:contain';
    return `<div class="p"><img style="${size}" src="${encodeURI(path.basename(f))}"></div>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><style>@page{margin:0}html,body{margin:0;padding:0;height:100%}.p{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;break-after:page}img{display:block}</style>${body}`;
}
// pages: [{bytes,width,height}] as fully rendered pages
ipcMain.handle('dp:print', async (_e, pages, o = {}) => {
  const dir = tempDir();
  const w = hiddenWindow();
  try {
    const files = pages.map((p, i) => {
      const f = path.join(dir, `p${i}.jpg`);
      fs.writeFileSync(f, toBuf(p.bytes));
      return f;
    });
    const html = path.join(dir, 'print.html');
    fs.writeFileSync(html, printHtml(files, pages, o), 'utf8');
    await w.loadFile(html);
    if (o.toPdf) {
      const out = await w.webContents.printToPDF({ landscape: !!o.landscape, printBackground: true, preferCSSPageSize: false });
      return { ok: true, pdf: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
    }
    return await new Promise((resolve) => {
      w.webContents.print({
        silent: true, printBackground: true, deviceName: o.deviceName || '', copies: o.copies || 1,
        collate: true, landscape: !!o.landscape, color: o.color !== false, duplexMode: o.duplexMode || 'simplex',
        margins: { marginType: 'none' },
      }, (ok, reason) => resolve({ ok, reason }));
    });
  } finally { w.destroy(); fs.rmSync(dir, { recursive: true, force: true }); }
});
