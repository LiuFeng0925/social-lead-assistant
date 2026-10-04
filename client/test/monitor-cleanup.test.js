'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
const { createSseWriter } = require('../src/sse-writer');
function extract(name, next) { return source.slice(source.indexOf('async function ' + name + '('), source.indexOf('\n' + next, source.indexOf('async function ' + name + '('))); }
class Response extends EventEmitter {
  constructor() { super(); this.destroyed = false; }
  writeHead() {} write() { return true; } end() { this.emit('finish'); this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
function fixture() {
  const context = { monitors: new Set(), sharedCast: null, lastRun: null, ENDPOINT: 'test', MAX_MONITOR_CLIENTS: 4,
    sse: createSseWriter, broadcastPointer: () => {}, broadcastFrame: () => {}, engine: {},
    startScreencast: async () => ({ stop() {} }) };
  vm.createContext(context);
  vm.runInContext(extract('ensureScreencast', 'function sse'), context);
  vm.runInContext(extract('handleScreencast', 'async function handleClick'), context);
  return context;
}

test('disconnect during account connection setup removes the monitor immediately', async () => {
  const context = fixture(); let resolve;
  context.engine.connect = () => new Promise(r => { resolve = r; });
  const res = new Response();
  const pending = context.handleScreencast(new EventEmitter(), res);
  assert.equal(context.monitors.size, 1);
  res.destroy();
  assert.equal(context.monitors.size, 0);
  resolve({ client: { screenshot: () => assert.fail('no screenshot after disconnect') }, target: {} });
  await pending;
  assert.equal(context.sharedCast, null);
});

test('late screencast initialization is stopped after the last monitor disconnects', async () => {
  const context = fixture(); let resolve, stops = 0;
  context.monitors.add(() => {});
  context.startScreencast = () => new Promise(r => { resolve = r; });
  const pending = context.ensureScreencast({}, {});
  context.monitors.clear(); context.sharedCast = null;
  resolve({ stop: () => stops++ });
  await pending;
  assert.equal(stops, 1);
  assert.equal(context.sharedCast, null);
});

test('a dead screencast releases its last image and disconnects stale subscribers', async () => {
  const context = fixture(); let options, disconnected = 0;
  const subscriber = () => {}; subscriber.disconnect = () => disconnected++;
  context.monitors.add(subscriber);
  context.startScreencast = async args => { options = args; return { stop() {} }; };
  await context.ensureScreencast({}, {});
  options.onFrame('frame', {});
  const old = context.sharedCast;
  options.onStopped();
  assert.equal(context.sharedCast, null);
  assert.equal(old.lastFrame, null);
  assert.equal(disconnected, 1);
});

test('an old cast finishing after a replacement cannot discard the replacement', async () => {
  const context = fixture(); let options;
  context.monitors.add(() => {});
  context.startScreencast = async args => { options = args; return { stop() {} }; };
  await context.ensureScreencast({}, {});
  const replacement = { handle: {}, lastFrame: 'new' };
  context.sharedCast = replacement;
  options.onStopped(); options.onFrame('old', {});
  assert.equal(context.sharedCast, replacement);
  assert.equal(context.sharedCast.lastFrame, 'new');
});

test('failed shared initialization disconnects all subscribers waiting on that cast', async () => {
  const context = fixture(); let reject, disconnected = 0;
  for (let n = 0; n < 2; n++) {
    const send = () => {}; send.disconnect = () => disconnected++;
    context.monitors.add(send);
  }
  context.startScreencast = () => new Promise((resolve, fail) => { reject = fail; });
  const first = context.ensureScreencast({}, {});
  await context.ensureScreencast({}, {});
  reject(new Error('cdp_socket_error'));
  await assert.rejects(first, /cdp_socket_error/);
  assert.equal(disconnected, 2);
  assert.equal(context.sharedCast, null);
});
