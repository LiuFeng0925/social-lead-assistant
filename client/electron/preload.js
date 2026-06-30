'use strict';
// 预加载:给渲染进程(控制台 app.html)暴露一个控制内嵌浏览器(BrowserView)显隐的安全 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronView', {
  // 切到控制台 → setVisible(true) 显示右侧内嵌浏览器;切到其他页签 → setVisible(false) 隐藏并铺平
  setVisible: (visible) => ipcRenderer.send('view-visible', !!visible),
});
