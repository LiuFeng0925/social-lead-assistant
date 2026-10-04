'use strict';

// 投屏 —— 用持久 WebSocket 连接 + Page.startScreencast,把目标页面一帧帧实时推出来。
// (注意:平时的 sendCommand 是"一命令一短连接",投屏需要长连接持续收 screencastFrame 事件,故单列。)

const { cdpConnectWebSocket, alignCdpWebSocketUrl } = require('./cdp-fetch');
const { performance } = require('node:perf_hooks');

// The monitor image is displayed at the full width of the dashboard.  Keep its
// source dimensions above the usual dashboard width so browser text does not
// become blurry after CSS scales it up.
// Limit delivery/ACK rate, not image quality: text remains readable at the
// existing resolution. Delayed ACKs also apply backpressure to Chrome instead
// of asking it to encode/queue frames as fast as the page can animate.
async function startScreencast({ target, endpoint, onFrame, onStopped, onError,
  quality = 90, maxWidth = 1600, maxHeight = 1440, maxFps = 4 }) {
  const wsUrl = alignCdpWebSocketUrl(target.webSocketDebuggerUrl, endpoint);
  const conn = await cdpConnectWebSocket(wsUrl);
  let mid = 1;
  const send = (method, params) => {
    const id = mid++;
    conn.send(JSON.stringify({ id, method, params: params || {} }));
    return id;
  };

  let running = true;
  let stopped = false;
  let closePromise = null;
  let cancelFrameWait = null;
  let lastFrameAt = -Infinity;
  const requestedFps = Number(maxFps);
  const frameInterval = 1000 / (Number.isFinite(requestedFps) && requestedFps > 0
    ? Math.min(30, Math.max(1, requestedFps)) : 4);
  const notify = (callback, error) => {
    if (typeof callback === 'function') { try { callback(error); } catch (e) {} }
  };
  const finish = (error) => {
    if (stopped) return closePromise;
    stopped = true;
    running = false;
    if (cancelFrameWait) cancelFrameWait();
    try { closePromise = Promise.resolve(conn.close()).catch(() => {}); }
    catch (e) { closePromise = Promise.resolve(); }
    if (error) notify(onError, error);
    // Every exit, including remote socket failure, must release the owner's
    // shared-cast reference so the next monitor connection can start afresh.
    notify(onStopped, error);
    return closePromise;
  };
  const waitForFrameSlot = async () => {
    const delay = frameInterval - (performance.now() - lastFrameAt);
    if (delay <= 0 || !running) return;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        cancelFrameWait = null;
        resolve();
      };
      const timer = setTimeout(done, Math.ceil(delay));
      cancelFrameWait = done;
    });
  };
  const setupCommands = new Map();
  try {
    setupCommands.set(send('Page.enable'), 'Page.enable');
    setupCommands.set(send('Page.startScreencast', {
      format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1
    }), 'Page.startScreencast');
  } catch (error) {
    finish(error);
    throw error;
  }

  const done = (async () => {
    let failure;
    try {
      while (running) {
        const raw = await conn.waitForMessage();
        // stop() can run while waitForMessage() resolves an already queued frame.
        if (!running) break;
        let msg; try { msg = JSON.parse(raw); } catch (e) { continue; }
        if (!msg || typeof msg !== 'object') continue;
        if (setupCommands.has(msg.id)) {
          const method = setupCommands.get(msg.id);
          setupCommands.delete(msg.id);
          if (msg.error) throw new Error(`cdp_screencast_command_failed:${method}`);
        }
        if (msg.method !== 'Page.screencastFrame' || !msg.params) continue;
        await waitForFrameSlot();
        if (!running) break;
        if (typeof msg.params.data === 'string') {
          onFrame(msg.params.data, msg.params.metadata || {});
          lastFrameAt = performance.now();
        }
        // The callback may itself close the last monitor. Do not ACK/request
        // another frame once stop() has been called.
        if (running) send('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
      }
    } catch (error) {
      if (running) failure = error;
    } finally {
      setupCommands.clear();
      finish(failure);
    }
  })();

  return {
    get running() { return running; },
    done,
    stop() {
      if (stopped) return closePromise;
      // Sending stop is best-effort, but closing the connection and notifying
      // the owner are mandatory even if the browser has already disconnected.
      try { send('Page.stopScreencast'); } catch (e) {}
      return finish();
    }
  };
}

module.exports = { startScreencast };
