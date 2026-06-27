'use strict';

// Electron 完整版(方案 B):一个窗口 = 左侧控制台(复用 app.html)+ 右侧内嵌小红书浏览器。
// 引擎/服务/数据库全部复用现有 server.js;通过 Electron 的远程调试端口(9333)驱动内嵌浏览器。
// 跑:npm run app

const { app, BrowserWindow, BrowserView } = require('electron');

// 暴露内嵌浏览器的 CDP 调试端口,让引擎能连上驱动它
app.commandLine.appendSwitch('remote-debugging-port', '9333');
// 引擎/服务连"内嵌浏览器"(而不是外部 Chrome)
process.env.XHS_CDP_ENDPOINT = 'http://127.0.0.1:9333';

let win, view;

app.whenReady().then(() => {
  // 起本地服务(引擎 + API + SQLite),复用现有 server.js(注意 main 在 electron/ 子目录,要往上一级)
  require('../src/server');

  win = new BrowserWindow({ width: 1520, height: 960, title: '小红书获客' });
  setTimeout(() => win.loadURL('http://localhost:3000'), 1000); // 等 server listen

  // 右侧:内嵌小红书浏览器(用户能直接在里面点/扫码登录)
  view = new BrowserView();
  win.setBrowserView(view);
  const layout = () => {
    const [w, h] = win.getContentSize();
    const x = Math.round(w * 0.5); // 内嵌浏览器占右半,和左侧控制台严格对齐
    view.setBounds({ x, y: 0, width: w - x, height: h });
  };
  layout();
  win.on('resize', layout);
  view.webContents.loadURL('https://www.xiaohongshu.com');
});

app.on('window-all-closed', () => app.quit());
