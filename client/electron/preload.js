'use strict';
// 预加载:给渲染进程(控制台 app.html)暴露一个控制内嵌浏览器(BrowserView)显隐的安全 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronView', {
  // 切到控制台 → setVisible(true) 显示右侧内嵌浏览器;切到其他页签 → setVisible(false) 隐藏并铺平
  setVisible: (visible) => ipcRenderer.send('view-visible', !!visible),
  // 选择一个账号时只展示该账号的内嵌页面；后台三个页面与任务仍继续运行。
  selectAccount: (accountId) => ipcRenderer.send('account-selected', Number(accountId) || 1),
  // 第 5 个账号使用完整控制台与独立数据库，只把执行端切换为 Mac 原生 App。
  nativeXhsStatus: () => ipcRenderer.invoke('native-xhs:status'),
  nativeXhsActivate: () => ipcRenderer.invoke('native-xhs:activate'),
  nativeXhsHome: () => ipcRenderer.invoke('native-xhs:home'),
  nativeXhsOpenPublish: () => ipcRenderer.invoke('native-xhs:publish'),
  nativeXhsSearch: (keyword) => ipcRenderer.invoke('native-xhs:search', String(keyword || '')),
  nativeXhsTaskStatus: () => ipcRenderer.invoke('native-xhs:task-status'),
  nativeXhsTaskStart: (options) => ipcRenderer.invoke('native-xhs:task-start', options || {}),
  nativeXhsTaskStop: () => ipcRenderer.invoke('native-xhs:task-stop'),
  nativeXhsTaskClear: () => ipcRenderer.invoke('native-xhs:task-clear'),
  nativeXhsCapture: () => ipcRenderer.invoke('native-xhs:capture'),
  nativeXhsChooseImage: () => ipcRenderer.invoke('native-xhs:choose-image'),
  onNativeXhsStatus: (callback) => ipcRenderer.on('native-xhs:status-event', (_event, value) => callback(value)),
  onNativeXhsLog: (callback) => ipcRenderer.on('native-xhs:log-event', (_event, value) => callback(value)),
});
