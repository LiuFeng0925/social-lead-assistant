'use strict';

// 投屏 —— 用持久 WebSocket 连接 + Page.startScreencast,把目标页面一帧帧实时推出来。
// (注意:平时的 sendCommand 是"一命令一短连接",投屏需要长连接持续收 screencastFrame 事件,故单列。)

const { cdpConnectWebSocket, alignCdpWebSocketUrl } = require('./cdp-fetch');

// The monitor image is displayed at the full width of the dashboard.  Keep its
// source dimensions above the usual dashboard width so browser text does not
// become blurry after CSS scales it up.
async function startScreencast({ target, endpoint, onFrame, quality = 90, maxWidth = 1600, maxHeight = 1440 }) {
  const wsUrl = alignCdpWebSocketUrl(target.webSocketDebuggerUrl, endpoint);
  const conn = await cdpConnectWebSocket(wsUrl);
  let mid = 1;
  const send = (method, params) => { try { conn.send(JSON.stringify({ id: mid++, method, params: params || {} })); } catch (e) {} };

  let running = true;
  (async () => {
    while (running) {
      let raw;
      try { raw = await conn.waitForMessage(); } catch (e) { break; }
      let msg; try { msg = JSON.parse(raw); } catch (e) { continue; }
      if (msg.method === 'Page.screencastFrame') {
        send('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
        try { onFrame(msg.params.data, msg.params.metadata || {}); } catch (e) {}
      }
    }
  })();

  send('Page.enable');
  send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1 });

  return {
    stop() { running = false; send('Page.stopScreencast'); conn.close().catch(() => {}); }
  };
}

module.exports = { startScreencast };
