'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { usesBrowser } = require('../electron/account-surface');
const { NativeXhsTask } = require('../electron/native-xhs-task');

const ui = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');

test('background browser accounts keep a nonzero viewport without being displayed', () => {
  const functionCode = main.slice(main.indexOf('function layoutBrowserView()'), main.indexOf('\nfunction selectAccount'));
  const events = [];
  const makeView = id => ({ id, setBounds: bounds => events.push(['bounds', id, bounds]), webContents: { setZoomFactor: zoom => events.push(['zoom', id, zoom]) } });
  const first = makeView(1);
  const second = makeView(2);
  const ctx = vm.createContext({ usesBrowser, xhsZoomFactor: () => 0.9, browserVisible: true, activeAccountId: 1,
    accountViews: new Map([[1, first], [2, second]]),
    win: { getContentSize: () => [1520, 960], removeBrowserView: view => events.push(['remove', view.id]), addBrowserView: view => events.push(['attach', view.id]) }
  });

  vm.runInContext(functionCode + ';layoutBrowserView()', ctx);

  const backgroundBounds = events.find(event => event[0] === 'bounds' && event[1] === 2);
  assert.deepEqual(JSON.parse(JSON.stringify(backgroundBounds[2])), { x: 1519, y: 959, width: 760, height: 960 });
  assert.deepEqual(events.filter(event => event[0] === 'attach'), [['attach', 2], ['attach', 1]]);
  const activeBounds = events.find(event => event[0] === 'bounds' && event[1] === 1);
  assert.deepEqual(JSON.parse(JSON.stringify(activeBounds[2])), { x: 760, y: 0, width: 760, height: 960 });
  assert.ok(events.some(event => event[0] === 'zoom' && event[1] === 2 && event[2] === 0.9));
});

function monitorFixture() {
  const elements = Object.fromEntries(['cast','cursor','castempty','caststatus','page-console'].map(id => [id, { style: {}, textContent: '', src: '', removeAttribute(key) { delete this[key]; }, classList: { contains: () => true } }]));
  const streams = [];
  const captureWaits = [];
  const timers = new Map(); let timerId = 0;
  class EventSource {
    constructor() { this.handlers = {}; streams.push(this); }
    addEventListener(key, fn) { this.handlers[key] = fn; }
    close() { this.closed = true; }
    emit(key, data) { this.handlers[key]({ data: JSON.stringify(data) }); }
  }
  const ctx = vm.createContext({ $: id => elements[id], activeAccountId: 1, frameW: 0, frameH: 0,
    EventSource, showCursor() {},
    window: { electronView: { nativeXhsStatus: async () => ({ passiveCapture: true }), nativeXhsCapture: () => new Promise((resolve, reject) => captureWaits.push({ resolve, reject })) } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }
  });
  const start = ui.indexOf('let _monitor = null;');
  const end = ui.indexOf('\nlet _trail =', start);
  vm.runInContext(ui.slice(start, end), ctx);
  return { elements, streams, captureWaits, timers, ctx, select(id) { ctx.activeAccountId = id; vm.runInContext('connectMonitor()', ctx); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('account 5 and account 15 use browser monitoring and reject stale frames', () => {
  const f = monitorFixture(); f.select(1);
  f.streams[0].emit('frame', { d: 'account-1' });
  f.select(5);
  assert.equal(f.streams[0].closed, true);
  assert.equal(f.elements.cast.src, undefined);
  f.streams[0].emit('frame', { d: 'stale-1' });
  assert.equal(f.elements.cast.src, undefined);
  f.streams[1].emit('frame', { d: 'account-5' });
  assert.match(f.elements.cast.src, /account-5/);
  f.select(15);
  f.streams[1].emit('frame', { d: 'stale-5' });
  assert.equal(f.elements.cast.src, undefined);
  f.streams[2].emit('frame', { d: 'account-15' });
  assert.match(f.elements.cast.src, /account-15/);
  assert.equal(f.captureWaits.length, 0);
});

test('background start is blocked without explicit foreground-test consent', async () => {
  let touched = false;
  const task = new NativeXhsTask({ request: async () => { touched = true; } });
  const result = await task.start();
  assert.equal(result.ok, false);
  assert.match(result.message, /尚不支持后台无干扰/);
  assert.equal(touched, false);
  assert.equal(task.state.running, false);
});

test('losing App focus pauses instead of closing notes or marking a model failure', async () => {
  let closed = false;
  const native = {
    search: async () => {}, listVisibleCards: async () => [{ title: 'test', author: 'author' }],
    assertForeground: async () => { throw new Error('native_app_not_frontmost'); },
    closeCurrentNote: async () => { closed = true; }
  };
  const task = new NativeXhsTask({ native, delay: async () => {}, request: async () => ({ ok: true }) });
  task.state = { ...task.state, running: true, status: 'running', runId: 1 };
  const result = await task.runKeyword({ keyword: 'test', keywordIndex: 1, keywordTotal: 1, maxNotes: 1, liveSend: false });
  assert.equal(result, 'paused');
  assert.equal(task.state.running, false);
  assert.equal(task.state.failed, 0);
  assert.equal(closed, false);
});
