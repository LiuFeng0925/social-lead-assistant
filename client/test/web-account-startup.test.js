'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ACCOUNT_COUNT } = require('../src/account-config');

test('one window creates 15 isolated web accounts without starting tasks or native integration', async () => {
  const workers = [], views = [], windows = [], ipc = {};
  let startup;
  class BrowserWindow {
    constructor() { windows.push(this); this.attached = []; this.webContents = {}; }
    on() {} once() {}
    getContentSize() { return [1520, 960]; }
    addBrowserView(view) { this.attached.push(view); }
    removeBrowserView(view) { this.attached = this.attached.filter(v => v !== view); }
    async loadURL(url) { this.url = url; }
  }
  class BrowserView {
    constructor(options) {
      this.options = options; views.push(this);
      this.webContents = { on() {}, setBackgroundThrottling() {}, setZoomFactor() {}, loadURL: url => { this.url = url; }, executeJavaScript: async () => {} };
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  const electron = {
    app: { commandLine: { appendSwitch() {} }, on() {}, whenReady: () => ({ then: callback => { startup = callback(); } }) },
    BrowserWindow, BrowserView, session: {}, powerSaveBlocker: {},
    ipcMain: { on: (name, callback) => { ipc[name] = callback; } }
  };
  const directory = path.join(__dirname, '../electron');
  const source = fs.readFileSync(path.join(directory, 'main.js'), 'utf8');
  const context = vm.createContext({
    __dirname: directory, console: { log() {}, error() {} }, setTimeout, AbortSignal,
    process: { env: {}, argv: [], on() {} },
    fetch: async () => ({ ok: true }),
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === './proxy-runtime') return {
        readAccountProxy: () => ({ enabled: false, error: '' }),
        verifyHttpProxy: async () => ({ ok: true, status: 'disabled', city: '', ip: '' }),
        applyProxyToSession: async () => {}
      };
      if (name === 'node:child_process') return { fork(file, args, options) {
        const worker = { file, options, stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
        workers.push(worker); return worker;
      } };
      if (name.includes('native-xhs')) throw new Error('retired App integration was loaded');
      return name.startsWith('.') ? require(path.resolve(directory, name)) : require(name);
    }
  });
  vm.runInContext(source, context);
  await startup;
  assert.equal(ACCOUNT_COUNT, 15);
  assert.equal(windows.length, 1);
  assert.equal(workers.length, 15);
  assert.equal(views.length, 15);
  assert.equal(new Set(workers.map(w => w.options.env.XHS_DATA_DIR)).size, 15);
  assert.equal(new Set(workers.map(w => w.options.env.XHS_UI_PORT)).size, 15);
  assert.equal(new Set(views.map(v => v.options.webPreferences.partition || 'default')).size, 15);
  assert.equal(views[0].options.webPreferences.partition, undefined);
  for (let id = 1; id <= 15; id++) {
    const env = workers[id - 1].options.env;
    assert.equal(env.XHS_ACCOUNT_ID, String(id));
    assert.equal(env.XHS_ACCOUNT_MARKER, 'xhs-lead-account-' + id);
    assert.equal(env.XHS_PROXY_STATUS, 'disabled');
    assert.equal(path.basename(env.XHS_DATA_DIR), 'account-' + id);
    assert.equal(new URL(views[id - 1].url).searchParams.get('sla_account'), env.XHS_ACCOUNT_MARKER);
  }
  ipc['account-selected']({}, 5);
  assert.equal(windows[0].attached.at(-1), views[4]);
  ipc['account-selected']({}, 15);
  assert.equal(windows[0].attached.at(-1), views[14]);
  assert.equal(views[14].bounds.x, 760);
  assert.equal(views[4].bounds.x, 1519);
  assert.deepEqual(Object.keys(ipc).sort(), ['account-selected', 'view-visible']);
});
