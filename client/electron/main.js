'use strict';

// Electron 多账号版：一个管理窗口 + 五个隔离 BrowserView + 六个独立本地任务服务。
// 每个服务各自持有 SQLite、配置、限频、任务循环和 SSE 日志；BrowserView 则通过
// 不同 partition 保存五份独立登录态。账号之间不共享 cookie、任务或统计。

const { app, BrowserWindow, BrowserView, ipcMain, powerSaveBlocker, dialog, session } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { xhsZoomFactor } = require('../src/view-scale');
const nativeXhs = require('./native-xhs');
const { NativeXhsTask } = require('./native-xhs-task');
const { usesBrowser } = require('./account-surface');
const { clearBrowserCachesOnRequest } = require('./cache-maintenance');

// 1–4 为正式网页获客号，5 为原生 App 测试空间，6 为新增的正式网页获客号。
const ACCOUNT_COUNT = 6;
const UI_PORT_BASE = 3100;
const CDP_PORT = 9333;

app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));

let win;
let activeAccountId = 1;
let browserVisible = true;
let taskWakeLockId = null;
const accountViews = new Map();
const accountWorkers = new Map();
const runningAccounts = new Set();
const nativeTask = new NativeXhsTask({ accountPort: UI_PORT_BASE + 5 });

nativeTask.on('status', (status) => {
  if (status && status.running) runningAccounts.add('native-5'); else runningAccounts.delete('native-5');
  syncTaskWakeLock();
  if (win && !win.isDestroyed()) win.webContents.send('native-xhs:status-event', status);
});
nativeTask.on('log', (row) => { if (win && !win.isDestroyed()) win.webContents.send('native-xhs:log-event', row); });

function accountMeta(id) {
  return {
    id,
    port: UI_PORT_BASE + id,
    marker: `xhs-lead-account-${id}`,
    // 账号 1 沿用旧单账号版的默认 session，升级后无需重新扫码；其余账号
    // 用独立持久分区，cookie/登录态绝不串号。
    partition: id === 1 ? null : `persist:xhs-lead-account-${id}`,
    dataDir: path.join(__dirname, '..', 'data', 'accounts', `account-${id}`)
  };
}

function initializeAccountData(id) {
  const meta = accountMeta(id);
  const target = path.join(meta.dataDir, 'xhs.sqlite');
  if (fs.existsSync(target)) return;
  fs.mkdirSync(meta.dataDir, { recursive: true });
  // 第一次升级时将单账号数据库交给账号 1；之后账号 2–5 各建自己的库。
  if (id !== 1) return;
  const legacyDir = path.join(__dirname, '..', 'data');
  for (const suffix of ['xhs.sqlite', 'xhs.sqlite-wal', 'xhs.sqlite-shm']) {
    const source = path.join(legacyDir, suffix);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(meta.dataDir, suffix));
  }
}

function setTaskWakeLock(active) {
  if (active && taskWakeLockId == null) {
    taskWakeLockId = powerSaveBlocker.start('prevent-display-sleep');
    console.log('多账号任务保持唤醒已开启');
  } else if (!active && taskWakeLockId != null) {
    powerSaveBlocker.stop(taskWakeLockId);
    taskWakeLockId = null;
    console.log('多账号任务保持唤醒已关闭');
  }
}
// 保留单进程事件入口，开发调试或未来直接挂载本地引擎时同样能维持唤醒。
process.on('xhs:task-wake-lock', setTaskWakeLock);

function syncTaskWakeLock() { setTaskWakeLock(runningAccounts.size > 0); }

function markBrowserAccount(view, marker) {
  // 页面每次跳转后都重新标记；window.name 会跨同一个 BrowserView 的搜索/详情页
  // 跳转保留，后端据此只驱动本账号的页面。
  const apply = () => view.webContents.executeJavaScript(`window.name=${JSON.stringify(marker)};`, true).catch(() => {});
  view.webContents.on('dom-ready', apply);
  view.webContents.on('did-finish-load', apply);
}

function layoutBrowserView() {
  if (!win) return;
  for (const view of accountViews.values()) win.removeBrowserView(view);
  if (!browserVisible || !usesBrowser(activeAccountId)) return;
  const view = accountViews.get(activeAccountId);
  if (!view) return;
  const [w, h] = win.getContentSize();
  const x = Math.round(w * 0.5);
  const width = Math.max(1, w - x);
  win.setBrowserView(view);
  view.setBounds({ x, y: 0, width, height: h });
  view.webContents.setZoomFactor(xhsZoomFactor(width, h));
}

function selectAccount(accountId) {
  const id = Math.max(1, Math.min(ACCOUNT_COUNT, Number(accountId) || 1));
  activeAccountId = id;
  layoutBrowserView();
}

function startWorker(id) {
  const meta = accountMeta(id);
  initializeAccountData(id);
  const worker = fork(path.join(__dirname, '..', 'src', 'server.js'), [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      XHS_UI_PORT: String(meta.port),
      XHS_CDP_ENDPOINT: `http://127.0.0.1:${CDP_PORT}`,
      XHS_ACCOUNT_ID: String(meta.id),
      XHS_ACCOUNT_MARKER: meta.marker,
      XHS_DATA_DIR: meta.dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  worker.stdout.on('data', (chunk) => console.log(`[账号${id}] ${String(chunk).trim()}`));
  worker.stderr.on('data', (chunk) => console.error(`[账号${id}] ${String(chunk).trim()}`));
  worker.on('message', (message) => {
    if (!message || message.type !== 'xhs:task-wake-lock') return;
    if (message.active) runningAccounts.add(id); else runningAccounts.delete(id);
    syncTaskWakeLock();
  });
  worker.on('exit', () => { runningAccounts.delete(id); syncTaskWakeLock(); accountWorkers.delete(id); });
  accountWorkers.set(id, worker);
}

function stopWorkers() {
  for (const worker of accountWorkers.values()) {
    try { worker.kill(); } catch (e) {}
  }
  accountWorkers.clear();
  runningAccounts.clear();
  syncTaskWakeLock();
}

ipcMain.on('view-visible', (e, visible) => {
  browserVisible = !!visible;
  layoutBrowserView();
});
ipcMain.on('account-selected', (e, accountId) => selectAccount(accountId));
ipcMain.handle('native-xhs:status', () => ({ ...nativeXhs.status(), surfaceVersion: 2, passiveCapture: true, foregroundPause: true }));
ipcMain.handle('native-xhs:activate', () => nativeXhs.activate());
ipcMain.handle('native-xhs:home', () => nativeXhs.goHome());
ipcMain.handle('native-xhs:publish', () => nativeXhs.openPublish());
ipcMain.handle('native-xhs:search', (e, keyword) => nativeXhs.search(keyword));
ipcMain.handle('native-xhs:task-status', () => nativeTask.snapshot());
ipcMain.handle('native-xhs:task-start', (e, options) => nativeTask.start(options || {}));
ipcMain.handle('native-xhs:task-stop', () => nativeTask.stop());
ipcMain.handle('native-xhs:task-clear', () => nativeTask.clear());
ipcMain.handle('native-xhs:capture', async () => {
  try {
    const result = await nativeXhs.captureWindow({ passive: true });
    if (result.ok === false) return result;
    return { ok: true, image: fs.readFileSync(result.imagePath).toString('base64') };
  } catch (_) {
    return { ok: false, message: '暂时无法读取 App 窗口；不会自动打开或切换窗口。请手动打开 App 后查看。' };
  }
});
ipcMain.handle('native-xhs:choose-image', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择这套真实房源对应的图片', properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  });
  return { ok: !result.canceled && !!result.filePaths[0], path: result.filePaths[0] || '' };
});

app.whenReady().then(async () => {
  // 仅显式维护启动清缓存。包含账号 5 旧网页分区，不删除 Cookie、设置、图库或数据库。
  await clearBrowserCachesOnRequest({
    argv: process.argv, session,
    accounts: Array.from({ length: ACCOUNT_COUNT }, (_, index) => accountMeta(index + 1))
  });
  // 先启动六个独立任务服务，再创建五个正式账号的隔离登录页面（第 5 号是 App 测试）。
  for (let id = 1; id <= ACCOUNT_COUNT; id++) startWorker(id);

  win = new BrowserWindow({
    width: 1520,
    height: 960,
    title: '小红书获客 · 多账号并发版',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.once('ready-to-show', () => { win.show(); win.focus(); win.moveTop(); });
  win.on('resize', layoutBrowserView);

  for (let id = 1; id <= ACCOUNT_COUNT; id++) {
    if (!usesBrowser(id)) continue;
    const meta = accountMeta(id);
    const webPreferences = { backgroundThrottling: false };
    if (meta.partition) webPreferences.partition = meta.partition;
    const view = new BrowserView({ webPreferences });
    view.webContents.setBackgroundThrottling(false);
    markBrowserAccount(view, meta.marker);
    view.webContents.on('did-finish-load', layoutBrowserView);
    // URL 标记是首屏的快速绑定；后续页面由 window.name 保持账号身份。
    view.webContents.loadURL(`https://www.xiaohongshu.com/?sla_account=${encodeURIComponent(meta.marker)}`);
    accountViews.set(id, view);
  }
  layoutBrowserView();

  // 账号 1 是原有单账号数据的升级入口；账号 5 预留给原生 App 测试；账号 6 为新增网页获客号。
  setTimeout(() => win.loadURL(`http://127.0.0.1:${UI_PORT_BASE + 1}`), 900);
});

app.on('before-quit', () => { stopWorkers(); setTaskWakeLock(false); });
app.on('window-all-closed', () => app.quit());
