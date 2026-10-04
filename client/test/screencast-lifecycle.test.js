'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

// Exercise the actual receive loop with a controllable connection. No browser
// targets, running workers, or user accounts are opened by these tests.
function fakeConnection({ failSend } = {}) {
  const commands = [];
  const queue = [];
  let waiter;
  let terminalError;
  let closeCalls = 0;
  return {
    commands,
    get closeCalls() { return closeCalls; },
    get queued() { return queue.length; },
    send(raw) {
      const command = JSON.parse(raw);
      if (failSend === command.method) throw new Error('test_send_failed');
      if (terminalError) throw terminalError;
      commands.push(command);
    },
    waitForMessage() {
      if (terminalError) return Promise.reject(terminalError);
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    emit(message) {
      if (terminalError) return;
      const raw = typeof message === 'string' ? message : JSON.stringify(message);
      if (waiter) {
        const pending = waiter; waiter = null; pending.resolve(raw);
      } else queue.push(raw);
    },
    fail(error = new Error('cdp_socket_closed')) {
      terminalError = error;
      queue.length = 0;
      if (waiter) { const pending = waiter; waiter = null; pending.reject(error); }
    },
    close() {
      closeCalls++;
      this.fail(terminalError || new Error('cdp_socket_closed'));
      return Promise.resolve();
    }
  };
}

function loadStart(conn) {
  const module = { exports: {} };
  const filename = require.resolve('../src/cdp/screencast');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, setTimeout, clearTimeout,
    require(name) {
      if (name === './cdp-fetch') return {
        cdpConnectWebSocket: async () => conn,
        alignCdpWebSocketUrl: (url) => url
      };
      return require(name);
    }
  }, { filename });
  return (options = {}) => module.exports.startScreencast({
    target: { webSocketDebuggerUrl: 'ws://fake.invalid/test' },
    endpoint: 'http://fake.invalid', onFrame() {}, ...options
  });
}

function frame(sessionId, data = `frame-${sessionId}`) {
  return { method: 'Page.screencastFrame', params: { sessionId, data, metadata: { deviceWidth: 1600 } } };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 1000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('test_deadline_exceeded');
    await delay(5);
  }
}
async function within(promise, timeout = 500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('test_deadline_exceeded')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

test('screencast stop is idempotent and closes the idle receive loop exactly once', async () => {
  const conn = fakeConnection();
  const stopped = [];
  const frames = [];
  const handle = await loadStart(conn)({ onFrame: (data) => frames.push(data), onStopped: (e) => stopped.push(e) });
  assert.equal(handle.running, true);
  await handle.stop();
  await handle.stop();
  conn.emit(frame(1));
  await within(handle.done);
  assert.equal(handle.running, false);
  assert.equal(conn.closeCalls, 1);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0], undefined);
  assert.deepEqual(frames, []);
  assert.equal(conn.commands.filter((item) => item.method === 'Page.stopScreencast').length, 1);
});

test('screencast does not deliver a queued frame after stop wins the promise race', async () => {
  const conn = fakeConnection();
  const frames = [];
  const handle = await loadStart(conn)({ onFrame: (data) => frames.push(data) });
  conn.emit(frame(1));
  conn.emit(frame(2));
  handle.stop();
  await within(handle.done);
  assert.deepEqual(frames, []);
  assert.equal(conn.queued, 0);
});

test('stopping a throttled frame cancels the timer without delivery or another ACK', async () => {
  const conn = fakeConnection();
  const frames = [];
  const handle = await loadStart(conn)({ maxFps: 1, onFrame: (data) => frames.push(data) });
  conn.emit(frame(1));
  await until(() => frames.length === 1);
  conn.emit(frame(2));
  await delay(10);
  handle.stop();
  await within(handle.done, 100);
  assert.deepEqual(frames, ['frame-1']);
  assert.equal(conn.closeCalls, 1);
  assert.equal(conn.commands.filter((item) => item.method === 'Page.screencastFrameAck').length, 1);
});

test('remote disconnection notifies the owner and allows a fresh screencast', async () => {
  const conn = fakeConnection();
  const errors = [];
  const stops = [];
  const handle = await loadStart(conn)({ onError: (e) => errors.push(e), onStopped: (e) => stops.push(e) });
  const error = new Error('cdp_socket_closed');
  conn.fail(error);
  await within(handle.done);
  assert.equal(handle.running, false);
  assert.equal(conn.closeCalls, 1);
  assert.deepEqual(errors, [error]);
  assert.deepEqual(stops, [error]);
  await handle.stop();
  assert.equal(stops.length, 1);
  const fresh = fakeConnection();
  const frames = [];
  const next = await loadStart(fresh)({ onFrame: (data) => frames.push(data) });
  fresh.emit(frame(3));
  await until(() => frames.length === 1);
  await next.stop();
  await within(next.done);
  assert.deepEqual(frames, ['frame-3']);
});

test('frame callback failure releases the connection and reports the failure once', async () => {
  const conn = fakeConnection();
  const error = new Error('monitor_delivery_failed');
  const stops = [];
  const handle = await loadStart(conn)({ onFrame: () => { throw error; }, onStopped: (e) => stops.push(e) });
  conn.emit(frame(1));
  await within(handle.done);
  assert.equal(conn.closeCalls, 1);
  assert.deepEqual(stops, [error]);
  assert.equal(conn.commands.some((item) => item.method === 'Page.screencastFrameAck'), false);
});

test('ACK send failure closes the cast instead of silently leaving a stale running handle', async () => {
  const conn = fakeConnection({ failSend: 'Page.screencastFrameAck' });
  const stops = [];
  const handle = await loadStart(conn)({ onStopped: (e) => stops.push(e) });
  conn.emit(frame(1));
  await within(handle.done);
  assert.equal(handle.running, false);
  assert.equal(conn.closeCalls, 1);
  assert.match(stops[0].message, /test_send_failed/);
});

test('start command protocol rejection closes and notifies the owner', async () => {
  const conn = fakeConnection();
  const stops = [];
  const handle = await loadStart(conn)({ onStopped: (e) => stops.push(e) });
  const start = conn.commands.find((item) => item.method === 'Page.startScreencast');
  conn.emit({ id: start.id, error: { code: -32000, message: 'Target closed' } });
  await within(handle.done);
  assert.equal(conn.closeCalls, 1);
  assert.equal(stops.length, 1);
  assert.match(stops[0].message, /cdp_screencast_command_failed:Page.startScreencast/);
});

test('synchronous startup failure closes its connection and rejects start', async () => {
  const conn = fakeConnection({ failSend: 'Page.startScreencast' });
  const stops = [];
  await assert.rejects(loadStart(conn)({ onStopped: (e) => stops.push(e) }), /test_send_failed/);
  assert.equal(conn.closeCalls, 1);
  assert.equal(stops.length, 1);
});

test('owner callback exceptions do not prevent receive-loop cleanup', async () => {
  const conn = fakeConnection();
  let notified = 0;
  const handle = await loadStart(conn)({
    onError() { throw new Error('owner_error'); },
    onStopped() { notified++; throw new Error('owner_error'); }
  });
  conn.fail();
  await within(handle.done);
  assert.equal(conn.closeCalls, 1);
  assert.equal(notified, 1);
});

test('default delivery is limited to four FPS while preserving text resolution and quality', async () => {
  const conn = fakeConnection();
  const times = [];
  const handle = await loadStart(conn)({ onFrame: () => times.push(performance.now()) });
  const start = conn.commands.find((item) => item.method === 'Page.startScreencast');
  assert.equal(start.params.quality, 90);
  assert.equal(start.params.maxWidth, 1600);
  assert.equal(start.params.maxHeight, 1440);
  conn.emit(frame(1));
  conn.emit(frame(2));
  await until(() => times.length === 2);
  await handle.stop();
  await within(handle.done);
  assert.ok(times[1] - times[0] >= 240, `frame interval was ${times[1] - times[0]}ms`);
  assert.equal(conn.commands.filter((item) => item.method === 'Page.screencastFrameAck').length, 2);
});

test('the frame rate is configurable and ACK is sent after frame delivery', async () => {
  const conn = fakeConnection();
  const times = [];
  const handle = await loadStart(conn)({ maxFps: 10, onFrame: () => {
    assert.equal(conn.commands.filter((item) => item.method === 'Page.screencastFrameAck').length, times.length);
    times.push(performance.now());
  } });
  conn.emit(frame(1));
  conn.emit(frame(2));
  conn.emit(frame(3));
  await until(() => times.length === 3);
  await handle.stop();
  await within(handle.done);
  assert.ok(times[1] - times[0] >= 90);
  assert.ok(times[2] - times[1] >= 90);
});

test('a frame callback stopping the cast does not request another frame', async () => {
  const conn = fakeConnection();
  const handle = await loadStart(conn)({ onFrame: () => handle.stop() });
  conn.emit(frame(1));
  await within(handle.done);
  assert.equal(conn.closeCalls, 1);
  assert.equal(conn.commands.some((item) => item.method === 'Page.screencastFrameAck'), false);
});

test('real bounded CDP transport drains ACK-paced frames and reports a closed peer', async (t) => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  let acknowledgments = 0;
  wss.on('connection', (client) => {
    client.on('error', () => {});
    client.on('message', (raw) => {
      const command = JSON.parse(raw);
      client.send(JSON.stringify({ id: command.id, result: {} }));
      if (command.method === 'Page.startScreencast') client.send(JSON.stringify(frame(1)));
      if (command.method === 'Page.screencastFrameAck') {
        acknowledgments++;
        if (acknowledgments === 3) client.close();
        else client.send(JSON.stringify(frame(acknowledgments + 1)));
      }
    });
  });
  const endpoint = `http://127.0.0.1:${wss.address().port}`;
  const frames = [];
  const stops = [];
  const { startScreencast } = require('../src/cdp/screencast');
  const handle = await startScreencast({
    target: { webSocketDebuggerUrl: `${endpoint.replace('http:', 'ws:')}/devtools/page/test` },
    endpoint, maxFps: 10, onFrame: (data) => frames.push(data), onStopped: (error) => stops.push(error)
  });
  t.after(() => handle.stop());
  await within(handle.done, 2000);
  assert.deepEqual(frames, ['frame-1', 'frame-2', 'frame-3']);
  assert.equal(acknowledgments, 3);
  assert.equal(stops.length, 1);
  assert.match(stops[0].message, /cdp_socket_closed/);
  assert.equal(handle.running, false);
});
