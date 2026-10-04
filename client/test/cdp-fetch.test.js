'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { cdpConnectWebSocket } = require('../src/cdp/cdp-fetch');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function within(promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('test_deadline_exceeded')), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function localServer(t, onUpgrade) {
  const server = http.createServer();
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('end', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  let upgrades = 0;
  server.on('upgrade', (req, socket, head) => {
    upgrades++;
    if (onUpgrade) onUpgrade({ req, socket, head, wss, upgrades });
    else wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client));
  });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => wss.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `ws://127.0.0.1:${server.address().port}/devtools/page/test`,
    wss,
    sockets,
    get upgrades() { return upgrades; }
  };
}

// 使用真实挂起的 HTTP Upgrade：旧实现 terminate 后会异步发出未捕获 error，
// node:test 会直接将该回归标记为 uncaughtException，而不是只检查一个模拟返回值。
test('CDP handshake timeout rejects safely without crashing the worker', async (t) => {
  const local = await localServer(t, ({ socket }) => socket.resume());
  await assert.rejects(
    within(cdpConnectWebSocket(local.url, { retries: 0, timeoutMs: 40 })),
    /cdp_socket_timeout/
  );
  await delay(30);
  assert.equal(local.upgrades, 1);
  assert.equal(local.sockets.size, 0);
});

test('CDP stalled handshake retries are bounded and release each failed socket', async (t) => {
  const local = await localServer(t, ({ socket }) => socket.resume());
  await assert.rejects(
    within(cdpConnectWebSocket(local.url, { retries: 2, timeoutMs: 40 }), 3000),
    /cdp_socket_timeout/
  );
  await delay(30);
  assert.equal(local.upgrades, 3);
  assert.equal(local.sockets.size, 0);
});

test('CDP rejected handshake reports the error and safely retries', async (t) => {
  const local = await localServer(t, ({ socket }) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await assert.rejects(
    within(cdpConnectWebSocket(local.url, { retries: 1, timeoutMs: 500 })),
    /cdp_socket_error/
  );
  await delay(30);
  assert.equal(local.upgrades, 2);
  assert.equal(local.sockets.size, 0);
});

test('CDP connection closed during handshake rejects instead of hanging', async (t) => {
  const local = await localServer(t, ({ socket }) => socket.destroy());
  await assert.rejects(
    within(cdpConnectWebSocket(local.url, { retries: 0, timeoutMs: 500 })),
    /cdp_socket_(error|closed)/
  );
  await delay(30);
  assert.equal(local.sockets.size, 0);
});

test('CDP can recover on the next attempt after a handshake timeout', async (t) => {
  const local = await localServer(t, ({ req, socket, head, wss, upgrades }) => {
    if (upgrades === 1) { socket.resume(); return; }
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (data) => client.send(data));
    });
  });
  const conn = await within(cdpConnectWebSocket(local.url, { retries: 1, timeoutMs: 100 }));
  conn.send('recovered');
  assert.equal(await within(conn.waitForMessage()), 'recovered');
  assert.equal(local.upgrades, 2);
  await conn.close();
});

test('CDP successful connection preserves message order and supports binary payloads', async (t) => {
  const local = await localServer(t);
  local.wss.on('connection', (client) => {
    client.on('message', () => {
      client.send('first');
      client.send(Buffer.from('second'));
    });
  });
  const conn = await within(cdpConnectWebSocket(local.url, { retries: 0 }));
  const first = conn.waitForMessage();
  conn.send('request');
  assert.equal(await within(first), 'first');
  assert.equal(await within(conn.waitForMessage()), 'second');
  await conn.close();
});

test('CDP remote close rejects all pending and subsequent message waits', async (t) => {
  const local = await localServer(t);
  local.wss.on('connection', (client) => client.on('message', () => client.close()));
  const conn = await within(cdpConnectWebSocket(local.url, { retries: 0 }));
  const pending = Promise.all([
    assert.rejects(conn.waitForMessage(), /cdp_socket_closed/),
    assert.rejects(conn.waitForMessage(), /cdp_socket_closed/)
  ]);
  conn.send('close');
  await within(pending);
  await assert.rejects(within(conn.waitForMessage()), /cdp_socket_closed/);
  assert.throws(() => conn.send('late request'), /cdp_socket_closed/);
  await conn.close();
});

test('CDP local close immediately rejects waits even if peer delays the close handshake', async (t) => {
  const local = await localServer(t);
  local.wss.on('connection', (client) => client.pause());
  const conn = await within(cdpConnectWebSocket(local.url, { retries: 0 }));
  const pending = assert.rejects(conn.waitForMessage(), /cdp_socket_closed/);
  await conn.close();
  await within(pending, 300);
  await assert.rejects(within(conn.waitForMessage(), 300), /cdp_socket_closed/);
  assert.throws(() => conn.send('late request'), /cdp_socket_closed/);
  await conn.close();
});

test('CDP message waits issued after remote close fail without requiring another close event', async (t) => {
  const local = await localServer(t);
  let peer;
  local.wss.on('connection', (client) => { peer = client; });
  const conn = await within(cdpConnectWebSocket(local.url, { retries: 0 }));
  const closed = once(peer, 'close');
  peer.close();
  await within(closed);
  await assert.rejects(within(conn.waitForMessage(), 300), /cdp_socket_closed/);
  await conn.close();
});

test('CDP malformed incoming frame surfaces a socket error to current and future waiters', async (t) => {
  const local = await localServer(t);
  let peer;
  local.wss.on('connection', (client) => {
    peer = client;
    client.on('error', () => {});
  });
  const conn = await within(cdpConnectWebSocket(local.url, { retries: 0 }));
  const pending = assert.rejects(conn.waitForMessage(), /cdp_socket_error/);
  // RSV1 without negotiated compression is an invalid real WebSocket frame.
  peer._socket.write(Buffer.from([0xc1, 0x00]));
  await within(pending);
  await assert.rejects(within(conn.waitForMessage(), 300), /cdp_socket_error/);
  await conn.close();
});
