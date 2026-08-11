'use strict';

// Electron 完整版(方案 B):一个窗口 = 左侧控制台(复用 app.html)+ 右侧内嵌小红书浏览器。
// 引擎/服务/数据库全部复用现有 server.js;通过 Electron 的远程调试端口(9333)驱动内嵌浏览器。
// 跑:npm run app

const { app, BrowserWindow, BrowserView, ipcMain, powerSaveBlocker } = require('electron');
const { xhsZoomFactor } = require('../src/view-scale');

// 暴露内嵌浏览器的 CDP 调试端口,让引擎能连上驱动它
app.commandLine.appendSwitch('remote-debugging-port', '9333');
// 引擎/服务连"内嵌浏览器"(而不是外部 Chrome)
process.env.XHS_CDP_ENDPOINT = 'http://127.0.0.1:9333';

let win, view;
let taskWakeLockId = null;

// 任务运行时阻止 macOS 自动睡眠；停止任务或退出应用后自动释放。
// 用 prevent-display-sleep 才能在锁屏后继续跑任务，屏幕仍会保持锁定状态。
function setTaskWakeLock(active) {
  if (active && taskWakeLockId == null) {
    taskWakeLockId = powerSaveBlocker.start('prevent-display-sleep');
    console.log('任务保持唤醒已开启');
  } else if (!active && taskWakeLockId != null) {
    powerSaveBlocker.stop(taskWakeLockId);
    taskWakeLockId = null;
    console.log('任务保持唤醒已关闭');
  }
}
process.on('xhs:task-wake-lock', setTaskWakeLock);
function layoutBrowserView() {
  if (!win || !view) return;
  const [w, h] = win.getContentSize();
  const x = Math.round(w * 0.5);
  const width = Math.max(1, w - x);
  view.setBounds({ x, y: 0, width, height: h });
  view.webContents.setZoomFactor(xhsZoomFactor(width, h));
}

// 控制内嵌浏览器(监视器)显隐:控制台页签显示右半,其他页签隐藏(让左侧内容铺平)
ipcMain.on('view-visible', (e, visible) => {
  if (!win || !view) return;
  if (visible) {
    win.setBrowserView(view);
    layoutBrowserView();
  } else {
    win.setBrowserView(null);
  }
});

app.whenReady().then(() => {
  // 起本地服务(引擎 + API + SQLite),复用现有 server.js(注意 main 在 electron/ 子目录,要往上一级)
  require('../src/server');

  win = new BrowserWindow({ width: 1520, height: 960, title: '小红书获客', webPreferences: { preload: __dirname + '/preload.js' } });
  setTimeout(() => win.loadURL('http://localhost:3000'), 1000);
  win.once('ready-to-show', () => { win.show(); win.focus(); win.moveTop(); });
  app.focus({ steal: true }); // 等 server listen

  // 右侧:内嵌小红书浏览器(用户能直接在里面点/扫码登录)
  view = new BrowserView();
  win.setBrowserView(view);
  layoutBrowserView();
  win.on('resize', layoutBrowserView);
  view.webContents.on('did-finish-load', layoutBrowserView);
  view.webContents.loadURL('https://www.xiaohongshu.com');
});

app.on('before-quit', () => setTaskWakeLock(false));
app.on('window-all-closed', () => app.quit());
