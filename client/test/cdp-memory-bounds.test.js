'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer, WebSocket } = require('ws');
const { cdpConnectWebSocket } = require('../src/cdp/cdp-fetch');
const { waitForCommandResult } = require('../src/cdp/xhs-cdp-client');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('test_deadline_exceeded');
    await delay(5);
  }
}

async function pair(t, options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => socket.on('error', () => {}));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');
  const peerPromise = once(server, 'connection');
  const conn = await cdpConnectWebSocket(`ws://127.0.0.1:${server.address().port}`, { retries: 0, ...options });
  t.after(() => conn.close());
  const [peer] = await peerPromise;
  return { conn, peer };
}

function assertReleased(conn) {
  const stats = conn.getBufferStats();
  assert.equal(stats.queuedMessages, 0);
  assert.equal(stats.queuedBytes, 0);
  assert.equal(stats.pendingWaiters, 0);
}

test('CDP thousands of unread frame messages fail closed at the count limit and release their buffers', async (t) => {
  const { conn, peer } = await pair(t, { maxQueueMessages: 16, maxQueueBytes: 8 * 1024 * 1024 });
  const frame = JSON.stringify({ method: 'Page.screencastFrame', params: { sessionId: 1, data: 'a'.repeat(4096) } });
  for (let i = 0; i < 16; i++) peer.send(frame);
  await until(() => conn.getBufferStats().queuedMessages === 16);
  assert.equal(conn.getBufferStats().queuedBytes, Buffer.byteLength(frame) * 16);

  // 真正的 ws 消息突发：调用方完全不读取，不能靠丢帧掩盖缓冲继续增长。
  for (let i = 0; i < 3000; i++) peer.send(frame);
  await until(() => conn.getBufferStats().error !== null);
  assert.equal(conn.getBufferStats().error, 'cdp_queue_overflow:message_count');
  assertReleased(conn);
  await assert.rejects(conn.waitForMessage(), { code: 'cdp_queue_overflow' });
  assert.throws(() => conn.send('{"id":1}'), /cdp_queue_overflow:message_count/);
  await until(() => peer.readyState === WebSocket.CLOSED);
  await delay(20);
  assertReleased(conn);
});

test('CDP queue byte budget counts UTF-8 bytes and resets on overflow', async (t) => {
  const { conn, peer } = await pair(t, { maxQueueMessages: 20, maxQueueBytes: 12 });
  peer.send('你好');
  peer.send('你好');
  await until(() => conn.getBufferStats().queuedMessages === 2);
  assert.equal(conn.getBufferStats().queuedBytes, 12);
  peer.send('a');
  await until(() => conn.getBufferStats().error !== null);
  await assert.rejects(conn.waitForMessage(), /cdp_queue_overflow:queue_bytes/);
  assertReleased(conn);
});

test('CDP oversized individual messages are rejected by the websocket receiver before being queued', async (t) => {
  const { conn, peer } = await pair(t, { maxQueueBytes: 1024 });
  const waiting = assert.rejects(conn.waitForMessage(), /cdp_queue_overflow:message_bytes/);
  peer.send('a'.repeat(1024 * 1024));
  await waiting;
  assertReleased(conn);
  await assert.rejects(conn.waitForMessage(), { code: 'cdp_queue_overflow' });
  await until(() => peer.readyState === WebSocket.CLOSED);
});

test('CDP waiter overflow rejects every outstanding waiter and all future operations', async (t) => {
  const { conn, peer } = await pair(t, { maxWaiters: 3 });
  const pending = Array.from({ length: 3 }, () => assert.rejects(conn.waitForMessage(), /cdp_queue_overflow:waiter_count/));
  assert.equal(conn.getBufferStats().pendingWaiters, 3);
  await assert.rejects(conn.waitForMessage(), /cdp_queue_overflow:waiter_count/);
  await Promise.all(pending);
  assertReleased(conn);
  assert.throws(() => conn.send('request'), { code: 'cdp_queue_overflow' });
  await until(() => peer.readyState === WebSocket.CLOSED);
});

test('CDP local close drops queued frame references even when the peer does not acknowledge closure', async (t) => {
  const { conn, peer } = await pair(t);
  peer.send('x'.repeat(1024 * 1024));
  await until(() => conn.getBufferStats().queuedBytes > 0);
  peer.pause();
  await conn.close();
  assertReleased(conn);
  await assert.rejects(conn.waitForMessage(), /cdp_socket_closed/);
  // 传输缓冲也不能等待 ws 默认的 30 秒关闭超时。
  await delay(350);
  peer.resume();
  await until(() => peer.readyState === WebSocket.CLOSED);
});

test('CDP remote close releases unread data, including command results that can no longer be trusted', async (t) => {
  const { conn, peer } = await pair(t);
  peer.send('{"id":1,"result":{"data":"old"}}');
  await until(() => conn.getBufferStats().queuedMessages === 1);
  peer.close();
  await until(() => conn.getBufferStats().error !== null);
  assertReleased(conn);
  await assert.rejects(conn.waitForMessage(), /cdp_socket_closed/);
});

test('CDP ordinary screenshot payloads and ordered command results still work within the default budget', async (t) => {
  const { conn, peer } = await pair(t);
  const screenshot = 'a'.repeat(4 * 1024 * 1024);
  const response = JSON.stringify({ id: 7, result: { data: screenshot } });
  peer.send(response);
  peer.send('{"id":8,"result":{}}');
  await until(() => conn.getBufferStats().queuedMessages === 2);
  assert.equal(conn.getBufferStats().queuedBytes, Buffer.byteLength(response) + Buffer.byteLength('{"id":8,"result":{}}'));
  assert.deepEqual(await waitForCommandResult(conn, 7, 1000), { data: screenshot });
  assert.deepEqual(await waitForCommandResult(conn, 8, 1000), {});
  assertReleased(conn);
  assert.equal(conn.getBufferStats().error, null);
});

test('CDP command timeout followed by close does not retain its abandoned waiter', async (t) => {
  const { conn } = await pair(t);
  await assert.rejects(waitForCommandResult(conn, 99, 30), /cdp_command_timeout/);
  assert.equal(conn.getBufferStats().pendingWaiters, 1);
  await conn.close();
  assertReleased(conn);
  await assert.rejects(conn.waitForMessage(), /cdp_socket_closed/);
});

test('CDP outgoing writes also have a finite budget and reject pending reads when exceeded', async (t) => {
  const { conn, peer } = await pair(t, { maxBufferedSendBytes: 1024 });
  const pending = assert.rejects(conn.waitForMessage(), /cdp_queue_overflow:send_bytes/);
  assert.throws(() => conn.send('x'.repeat(1025)), { code: 'cdp_queue_overflow' });
  await pending;
  assertReleased(conn);
  await until(() => peer.readyState === WebSocket.CLOSED);
});

test('CDP invalid and excessive limit overrides cannot disable the memory bounds', async (t) => {
  const invalid = await pair(t, { maxQueueMessages: Infinity, maxQueueBytes: NaN, maxWaiters: -1, maxBufferedSendBytes: 0 });
  assert.equal(invalid.conn.getBufferStats().maxQueueMessages, 256);
  assert.equal(invalid.conn.getBufferStats().maxQueueBytes, 32 * 1024 * 1024);
  assert.equal(invalid.conn.getBufferStats().maxWaiters, 64);
  assert.equal(invalid.conn.getBufferStats().maxBufferedSendBytes, 32 * 1024 * 1024);
  const excessive = await pair(t, { maxQueueMessages: 1e20, maxQueueBytes: 1e20, maxWaiters: 1e20, maxBufferedSendBytes: 1e20 });
  assert.equal(excessive.conn.getBufferStats().maxQueueMessages, 4096);
  assert.equal(excessive.conn.getBufferStats().maxQueueBytes, 128 * 1024 * 1024);
  assert.equal(excessive.conn.getBufferStats().maxWaiters, 512);
  assert.equal(excessive.conn.getBufferStats().maxBufferedSendBytes, 128 * 1024 * 1024);
});
