'use strict';

// CDP 底层连接:走原生 http + ws,直连 Chrome 的 DevTools 端口。
// 复用自 BOSS 项目(search-boss-toc/src/services/cdp-fetch.js),仅精简注释。
//
// 为什么不用全局 fetch:Node 的 undici fetch 会强制把 Host header 设为 URL host,
// 无法覆盖;而 Chrome 的 CDP 端口会拒绝 Host 既不是 IP 也不是 "localhost" 的请求。
// 这里走原生 http,自己拼一个 fetch-like 返回值,并强制 Host: localhost。

const http = require('node:http');
const { WebSocket: WsWebSocket } = require('ws');

function cdpFetch(input, init = {}) {
  const url = typeof input === 'string' ? new URL(input) : new URL(input.url || input);
  const headers = {};
  const inputHeaders = init.headers instanceof Headers
    ? Object.fromEntries(init.headers.entries())
    : { ...(init.headers || {}) };
  for (const [k, v] of Object.entries(inputHeaders)) {
    if (k.toLowerCase() === 'host') continue;
    headers[k] = v;
  }
  headers.Host = 'localhost';

  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: init.method || 'GET',
      headers,
      signal: init.signal
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage || '',
          headers: res.headers,
          text: async () => buffer.toString('utf8'),
          json: async () => JSON.parse(buffer.toString('utf8'))
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (init.body !== undefined && init.body !== null) {
      req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body));
    }
    req.end();
  });
}

function cdpWebSocket(url) {
  return new WsWebSocket(url, { headers: { Host: 'localhost' } });
}

// Chrome 用 Host: localhost 时会把端口从 webSocketDebuggerUrl 里省掉,
// 这里把 host:port 换回我们最初连过去的 endpoint,确保 dial 到正确的浏览器。
function alignCdpWebSocketUrl(wsUrl, anchorEndpoint) {
  try {
    const ws = new URL(wsUrl);
    const anchor = new URL(anchorEndpoint);
    ws.host = anchor.host;
    return ws.toString();
  } catch {
    return wsUrl;
  }
}

async function cdpConnectWebSocket(url) {
  const socket = cdpWebSocket(url);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('cdp_socket_error')); };
    const onClose = () => { cleanup(); reject(new Error('cdp_socket_closed')); };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });

  const messageQueue = [];
  const waiters = [];
  const flushWaiter = (payload) => {
    const waiter = waiters.shift();
    if (waiter) { waiter.resolve(payload); return true; }
    return false;
  };

  socket.on('message', (data) => {
    const payload = typeof data === 'string' ? data : data.toString('utf8');
    if (!flushWaiter(payload)) messageQueue.push(payload);
  });
  socket.on('error', () => {
    const error = new Error('cdp_socket_error');
    while (waiters.length > 0) waiters.shift().reject(error);
  });
  socket.on('close', () => {
    const error = new Error('cdp_socket_closed');
    while (waiters.length > 0) waiters.shift().reject(error);
  });

  return {
    send(message) { socket.send(message); },
    waitForMessage() {
      if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close() {
      if (socket.readyState === WsWebSocket.CLOSING || socket.readyState === WsWebSocket.CLOSED) {
        return Promise.resolve();
      }
      socket.close();
      return Promise.resolve();
    }
  };
}

module.exports = { cdpFetch, cdpWebSocket, cdpConnectWebSocket, alignCdpWebSocketUrl };
