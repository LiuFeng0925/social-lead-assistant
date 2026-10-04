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
    req.setTimeout(Number(init.timeoutMs) || 5000, () => req.destroy(new Error('cdp_http_timeout')));
    if (init.body !== undefined && init.body !== null) {
      req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body));
    }
    req.end();
  });
}

const MIB = 1024 * 1024;

function boundedLimit(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(number), maximum));
}

function connectionLimits(options = {}) {
  return {
    maxQueueMessages: boundedLimit(options.maxQueueMessages, 256, 4096),
    // 32 MiB 足以接收普通截图；上限也不能被配置为 Infinity 而重新变成无界。
    maxQueueBytes: boundedLimit(options.maxQueueBytes, 32 * MIB, 128 * MIB),
    maxWaiters: boundedLimit(options.maxWaiters, 64, 512),
    maxBufferedSendBytes: boundedLimit(options.maxBufferedSendBytes, 32 * MIB, 128 * MIB)
  };
}

function overflowError(limit) {
  const error = new Error(`cdp_queue_overflow:${limit}`);
  error.code = 'cdp_queue_overflow';
  return error;
}

function socketError(error) {
  return error?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
    ? overflowError('message_bytes')
    : new Error('cdp_socket_error');
}

function cdpWebSocket(url, options = {}) {
  const limits = connectionLimits(options);
  return new WsWebSocket(url, {
    headers: { Host: 'localhost' },
    // 同时限制 ws 的接收缓冲，不能等超大帧完整转成字符串后才检查队列。
    maxPayload: limits.maxQueueBytes,
    perMessageDeflate: false
  });
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openWebSocket(url, retries = 2, timeoutMs = 5000, limits = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const socket = cdpWebSocket(url, limits);
    const state = { error: null };
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const cleanupHandshake = () => {
          clearTimeout(timer);
          socket.off('open', onOpen);
        };
        const fail = (error) => {
          if (!state.error) state.error = error;
          if (settled) return;
          settled = true;
          cleanupHandshake();
          reject(state.error);
        };
        const onOpen = () => {
          if (settled) return;
          settled = true;
          cleanupHandshake();
          resolve();
        };
        const onError = (error) => fail(socketError(error));
        const onClose = () => {
          fail(new Error('cdp_socket_closed'));
          socket.off('error', onError);
        };
        const timer = setTimeout(() => {
          fail(new Error('cdp_socket_timeout'));
          // CONNECTING 时 terminate 会异步触发 error，必须等 close 后再移除监听。
          try { socket.terminate(); } catch (e) {}
        }, timeoutMs);
        socket.once('open', onOpen);
        socket.on('error', onError);
        socket.once('close', onClose);
      });
      // 握手成功到调用方接管之间也可能关闭，保留该阶段的错误状态。
      return { socket, state };
    } catch (error) {
      lastError = error;
      try { socket.terminate(); } catch (e) {}
      if (attempt < retries) await sleep(200 * (attempt + 1));
    }
  }
  throw lastError || new Error('cdp_socket_error');
}

async function cdpConnectWebSocket(url, options = {}) {
  const limits = connectionLimits(options);
  const { socket, state } = await openWebSocket(url, options.retries == null ? 2 : options.retries, options.timeoutMs || 5000, limits);

  const messageQueue = [];
  const waiters = [];
  let queuedBytes = 0;
  let closeTimer;
  let terminalError = state.error;
  const failWaiters = (error) => {
    if (!terminalError) terminalError = error;
    // 关闭后不再交付旧消息，截图等大字符串必须立即解除引用。
    messageQueue.length = 0;
    queuedBytes = 0;
    while (waiters.length > 0) waiters.shift().reject(terminalError);
  };
  const abort = (error) => {
    failWaiters(error);
    try { socket.terminate(); } catch (e) {}
  };
  const closedError = () => terminalError || state.error || new Error('cdp_socket_closed');
  const flushWaiter = (payload) => {
    const waiter = waiters.shift();
    if (waiter) { waiter.resolve(payload); return true; }
    return false;
  };

  socket.on('message', (data) => {
    if (terminalError) return;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
    if (bytes > limits.maxQueueBytes) { abort(overflowError('message_bytes')); return; }
    if (!waiters.length && (messageQueue.length >= limits.maxQueueMessages || queuedBytes + bytes > limits.maxQueueBytes)) {
      // 不能丢弃“看起来像事件”的消息，否则可能吞掉指令响应。明确断开让上层恢复。
      abort(overflowError(messageQueue.length >= limits.maxQueueMessages ? 'message_count' : 'queue_bytes'));
      return;
    }
    const payload = typeof data === 'string' ? data : data.toString('utf8');
    if (!flushWaiter(payload)) {
      messageQueue.push({ payload, bytes });
      queuedBytes += bytes;
    }
  });
  socket.on('error', (error) => {
    abort(socketError(error));
  });
  socket.on('close', () => {
    clearTimeout(closeTimer);
    failWaiters(new Error('cdp_socket_closed'));
  });

  return {
    send(message) {
      if (terminalError || socket.readyState !== WsWebSocket.OPEN) throw closedError();
      const bytes = typeof message === 'string' ? Buffer.byteLength(message, 'utf8') : Buffer.byteLength(message);
      if (socket.bufferedAmount + bytes > limits.maxBufferedSendBytes) {
        const error = overflowError('send_bytes');
        abort(error);
        throw error;
      }
      socket.send(message, (error) => { if (error && !terminalError) abort(socketError(error)); });
    },
    waitForMessage() {
      if (terminalError || socket.readyState !== WsWebSocket.OPEN) return Promise.reject(closedError());
      if (messageQueue.length > 0) {
        const message = messageQueue.shift();
        queuedBytes -= message.bytes;
        return Promise.resolve(message.payload);
      }
      if (waiters.length >= limits.maxWaiters) {
        const error = overflowError('waiter_count');
        abort(error);
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    // 只读计数，不暴露消息/账号数据；用于测试和后续运行健康诊断。
    getBufferStats() {
      return { queuedMessages: messageQueue.length, queuedBytes, pendingWaiters: waiters.length, ...limits, error: terminalError?.message || null };
    },
    close() {
      failWaiters(closedError());
      if (socket.readyState === WsWebSocket.CLOSING || socket.readyState === WsWebSocket.CLOSED) {
        return Promise.resolve();
      }
      socket.close();
      // 不让不响应关闭握手的页面把短连接和传输缓冲保留 ws 默认的 30 秒。
      closeTimer = setTimeout(() => { try { socket.terminate(); } catch (e) {} }, 250);
      closeTimer.unref?.();
      return Promise.resolve();
    }
  };
}

module.exports = { cdpFetch, cdpWebSocket, cdpConnectWebSocket, alignCdpWebSocketUrl };
