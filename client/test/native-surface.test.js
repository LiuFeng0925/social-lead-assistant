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

test('native account owns no BrowserView and cannot be shown by stale visibility messages', () => {
  assert.deepEqual([1,2,3,4,5,6].filter(usesBrowser), [1,2,3,4,6]);
  assert.equal(usesBrowser('5'), false);
  const functionCode = main.slice(main.indexOf('function layoutBrowserView()'), main.indexOf('\nfunction selectAccount'));
  const events = [];
  const ctx = vm.createContext({ usesBrowser, browserVisible: true, activeAccountId: 5,
    accountViews: new Map([[1, {}], [5, {}]]),
    win: { removeBrowserView: v => events.push(['remove',v]), setBrowserView: v => events.push(['attach',v]) }
  });
  vm.runInContext(functionCode + ';layoutBrowserView()', ctx);
  assert.equal(events.filter(e => e[0] === 'remove').length, 2);
  assert.equal(events.some(e => e[0] === 'attach'), false);
  assert.match(main, /for \(let id = 1; id <= ACCOUNT_COUNT; id\+\+\) \{\s*if \(!usesBrowser\(id\)\) continue;/);
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

test('switching to native immediately clears old browser image and rejects a late browser frame', async () => {
  const f = monitorFixture(); f.select(1);
  f.streams[0].emit('frame', { d: 'browser-A' });
  assert.match(f.elements.cast.src, /browser-A/);
  f.select(5);
  await flush();
  assert.equal(f.elements.cast.src, undefined);
  assert.equal(f.elements.cast.style.display, 'none');
  f.streams[0].emit('frame', { d: 'stale-browser' });
  assert.equal(f.elements.cast.src, undefined);
  f.captureWaits[0].resolve({ ok: true, image: 'native-image' }); await flush();
  assert.equal(f.elements.cast.src, 'data:image/png;base64,native-image');
});

test('late native frame cannot overwrite another account and refreshes do not overlap', async () => {
  const f = monitorFixture(); f.select(5);
  await flush();
  assert.equal(f.captureWaits.length, 1);
  assert.equal(f.timers.size, 0);
  f.select(2);
  f.captureWaits[0].resolve({ ok: true, image: 'old-native' }); await flush();
  assert.equal(f.elements.cast.src, undefined);
  assert.equal(f.timers.size, 0);
  f.streams[0].emit('frame', { d: 'browser-B' });
  assert.match(f.elements.cast.src, /browser-B/);
});

test('unavailable native capture clears cached pixels and reports read-only unavailability', async () => {
  const f = monitorFixture(); f.select(5);
  await flush();
  f.captureWaits[0].resolve({ ok: false, message: 'App 已最小化；不会自动唤起' }); await flush();
  assert.equal(f.elements.cast.src, undefined);
  assert.match(f.elements.castempty.textContent, /不会自动唤起/);
  assert.equal(f.timers.size, 1);
});

test('new UI never calls old capture implementation without passive capability', async () => {
  const f = monitorFixture();
  f.ctx.window.electronView.nativeXhsStatus = async () => ({ installed: true });
  f.select(5); await flush();
  assert.equal(f.captureWaits.length, 0);
  assert.match(f.elements.castempty.textContent, /不会调用旧版抢前台/);
});

test('restoring page5 applies native right-pane layout without needing an account click', () => {
  assert.match(ui, /const initialShowsBrowser = activeAccountId !== 5/);
  assert.match(ui, /classList.toggle\('native-console', activeAccountId === 5\)/);
  assert.match(ui, /native-console #monitor-card\{[^}]*position:fixed;left:50vw/);
  assert.match(ui, /实时画面（只读）/);
  assert.match(main, /captureWindow\(\{ passive: true \}\)/);
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
