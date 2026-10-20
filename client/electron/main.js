'use strict';

// Electron 多账号版：一个管理窗口 + 15 个隔离 BrowserView + 15 个独立本地任务服务。
// 每个服务各自持有 SQLite、配置、限频、任务循环和 SSE 日志；BrowserView 则通过
// 不同 partition 保存独立登录态。账号之间不共享 cookie、任务或统计。

const { app, BrowserWindow, BrowserView, ipcMain, powerSaveBlocker, session } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { xhsZoomFactor } = require('../src/view-scale');
const { usesBrowser } = require('./account-surface');
const { clearBrowserCachesOnRequest } = require('./cache-maintenance');

const { ACCOUNT_COUNT, UI_PORT_BASE, normalizeAccountId } = require('../src/account-config');
const CDP_PORT = 9333;

app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));

let win;
let activeAccountId = 1;
let browserVisible = true;
let taskWakeLockId = null;
const accountViews = new Map();
const accountWorkers = new Map();
const runningAccounts = new Set();
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
  // 第一次升级时将单账号数据库交给账号 1；之后其余账号各建自己的库。
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
  const [w, h] = win.getContentSize();
  const x = Math.round(w * 0.5);
  const width = Math.max(1, w - x);
  const visibleBounds = { x, y: 0, width, height: Math.max(1, h) };
  // 留 1×1 像素与窗口相交，避免 Chromium 把完全位于窗口外的页面判定
  // 为不可见并把渲染视口重新压成 0×0。当前账号最后挂载，会覆盖该像素。
  const backgroundBounds = { x: Math.max(0, w - 1), y: Math.max(0, h - 1), width, height: Math.max(1, h) };
  const zoom = xhsZoomFactor(width, h);
  for (const view of accountViews.values()) win.removeBrowserView(view);
  const activeView = browserVisible && usesBrowser(activeAccountId) ? accountViews.get(activeAccountId) : null;
  // BrowserView 只有挂在 BrowserWindow 上才会保留有效渲染视口。后台账号
  // 继续挂载到窗口外的不可见区域，既不会覆盖当前界面，也不会变成 0×0。
  // 先挂后台、最后挂当前账号，确保当前账号处于最上层。
  const browserEntries = Array.from(accountViews.entries()).filter(([id]) => usesBrowser(id));
  const orderedViews = browserEntries.map(([, view]) => view).filter((view) => view !== activeView);
  if (activeView) orderedViews.push(activeView);
  for (const view of orderedViews) {
    win.addBrowserView(view);
    view.setBounds(view === activeView ? visibleBounds : backgroundBounds);
    view.webContents.setZoomFactor(zoom);
  }
}

function selectAccount(accountId) {
  const id = normalizeAccountId(accountId);
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
app.whenReady().then(async () => {
  // 仅显式维护启动清缓存。包含账号 5 旧网页分区，不删除 Cookie、设置、图库或数据库。
  await clearBrowserCachesOnRequest({
    argv: process.argv, session,
    accounts: Array.from({ length: ACCOUNT_COUNT }, (_, index) => accountMeta(index + 1))
  });
  // 每个网页账号拥有独立任务服务与持久登录页面，启动时不自动运行获客任务。
  for (let id = 1; id <= ACCOUNT_COUNT; id++) startWorker(id);

  win = new BrowserWindow({
    width: 1520,
    height: 960,
    title: `小红书获客 · ${ACCOUNT_COUNT} 个网页账号`,
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

  // 多进程启动速度取决于机器配置，等首个控制台可连接后再展示。
  const consoleUrl = `http://127.0.0.1:${UI_PORT_BASE + 1}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(consoleUrl + '/api/account', { signal: AbortSignal.timeout(1000) });
      if (response.ok) { await win.loadURL(consoleUrl); return; }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.error('账号控制台启动超时，请检查本地端口和任务服务日志。');
  await win.loadURL(consoleUrl);
});

app.on('before-quit', () => { stopWorkers(); setTaskWakeLock(false); });
app.on('window-all-closed', () => app.quit());
