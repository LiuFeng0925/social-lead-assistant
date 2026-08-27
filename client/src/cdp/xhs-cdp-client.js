'use strict';

// 精简版 CDP 客户端:接管已登录的真实 Chrome,提供 导航 / 执行JS / 截图 等原子能力。
// 思路与 BOSS 的 BossCdpClient 一致(每条命令一个短连接),只保留 M1 需要的部分。

const { cdpFetch, cdpConnectWebSocket, alignCdpWebSocketUrl } = require('./cdp-fetch');

async function waitForCommandResult(conn, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let skipped = 0;
  let timer;
  const hardTimeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('cdp_command_timeout')), timeoutMs);
  });
  try {
    while (true) {
      if (Date.now() >= deadline) throw new Error('cdp_command_timeout');
      const raw = await Promise.race([conn.waitForMessage(), hardTimeout]);
      const msg = JSON.parse(raw);
      if (msg.id !== id) {
        skipped++;
        if (skipped % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      if (msg.error) throw new Error(msg.error.message || 'cdp_command_failed');
      return msg.result?.result ?? msg.result ?? null;
    }
  } finally {
    clearTimeout(timer);
  }
}

class XhsCdpClient {
  constructor({ endpoint = 'http://127.0.0.1:9222', onPointer = null } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.nextId = 1;
    this.onPointer = onPointer; // 上报点击坐标,供实时监控叠加光标
  }

  async listTargets() {
    const res = await cdpFetch(`${this.endpoint}/json`);
    if (!res.ok) throw new Error(`cdp_list_targets_failed:${res.status || 'unknown'}`);
    const targets = await res.json();
    return Array.isArray(targets) ? targets : [];
  }

  // 找一个可用的网页标签页:优先小红书域名,否则取第一个普通网页 tab。
  // 多账号 Electron 版会给每个 BrowserView 写入独立 window.name；必须精确
  // 命中该标记，绝不能在账号 A 的任务里误操作账号 B 的页面。
  async resolvePageTarget({ preferHost = 'xiaohongshu.com', accountMarker = '' } = {}) {
    const targets = await this.listTargets();
    const pages = targets.filter((t) =>
      t.type === 'page' &&
      typeof t.url === 'string' &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('chrome-extension://'));
    if (!pages.length) throw new Error('no_page_target');
    const preferred = pages.filter((p) => p.url.includes(preferHost));
    if (!accountMarker) return preferred[0] || pages[0];

    // 首屏加载前，URL 中也带有标记，先走零开销的快速定位。
    const urlMatched = preferred.find((p) => p.url.includes(accountMarker));
    if (urlMatched) return urlMatched;

    // 搜索、详情等页面跳转会丢掉 URL 参数，但同一个 BrowserView 的
    // window.name 会持续存在；逐个探测后精确绑定到对应账号。
    for (const target of preferred) {
      try {
        const value = await this.sendCommand({
          target,
          method: 'Runtime.evaluate',
          params: { expression: 'String(window.name || "")', returnByValue: true },
          timeoutMs: 1800
        });
        if (value && value.value === accountMarker) return target;
      } catch (e) { /* 页面正在跳转，继续检查其他候选页 */ }
    }
    throw new Error(`account_page_target_not_ready:${accountMarker}`);
  }

  _wsUrl(target) {
    return alignCdpWebSocketUrl(target.webSocketDebuggerUrl, this.endpoint);
  }

  // 单条命令:开短连接 → 发送 → 等对应 id 的响应 → 关闭。
  async sendCommand({ target, method, params = {}, timeoutMs = 20000 }) {
    const conn = await cdpConnectWebSocket(this._wsUrl(target));
    const id = this.nextId++;
    try {
      await conn.send(JSON.stringify({ id, method, params }));
      return await waitForCommandResult(conn, id, timeoutMs);
    } finally {
      await conn.close().catch(() => {});
    }
  }

  // Mouse press/release must share one CDP session. Splitting them across
  // short-lived sockets can focus an element on press without ever producing
  // the click event that establishes a comment reply target.
  async sendCommandSequence({ target, commands = [], timeoutMs = 5000 }) {
    const conn = await cdpConnectWebSocket(this._wsUrl(target));
    const pending = new Map();
    const orderedIds = [];
    const completed = new Set();
    let timer;
    try {
      for (const command of commands) {
        const id = this.nextId++;
        orderedIds.push(id);
        pending.set(id, null);
        await conn.send(JSON.stringify({ id, method: command.method, params: command.params || {} }));
        if (command.delayAfterMs) await new Promise((resolve) => setTimeout(resolve, command.delayAfterMs));
      }
      const hardTimeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('cdp_command_timeout')), timeoutMs);
      });
      while (completed.size < orderedIds.length) {
        const raw = await Promise.race([conn.waitForMessage(), hardTimeout]);
        const msg = JSON.parse(raw);
        if (!pending.has(msg.id)) continue;
        if (msg.error) throw new Error(msg.error.message || 'cdp_command_failed');
        pending.set(msg.id, msg.result?.result ?? msg.result ?? {});
        completed.add(msg.id);
      }
      return orderedIds.map((id) => pending.get(id));
    } finally {
      clearTimeout(timer);
      await conn.close().catch(() => {});
    }
  }

  // 在页面上下文执行 JS(awaitPromise + returnByValue)。返回 { type, value }。
  async evaluate({ target, expression }) {
    return this.sendCommand({
      target,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    });
  }

  async navigate({ target, url }) {
    return this.sendCommand({ target, method: 'Page.navigate', params: { url } });
  }

  async screenshot({ target, format = 'jpeg', quality = 70 }) {
    const r = await this.sendCommand({ target, method: 'Page.captureScreenshot', params: { format, quality } });
    return r?.data || null;
  }

  // 贝塞尔曲线鼠标移动:从上次位置平滑移到目标(不瞬移),搬自 BOSS humanMouseMove
  // 往目标页面注入固定红点光标:监听 trusted 鼠标事件自动跟随(引擎 CDP 派发的是真事件);position:fixed → 滚动时停在视口
  async installCursor({ target }) {
    const SCRIPT = '(function(){function ins(){if(window.__xhsCur){window.__xhsCur.style.opacity="1";return;}if(!document.body){return setTimeout(ins,60);}var d=document.createElement("div");d.id="__xhsCur";d.style.cssText="position:fixed;left:50%;top:50%;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;background:rgba(255,39,66,.30);border:3px solid #ff2742;box-shadow:0 0 0 3px rgba(255,255,255,.95),0 0 16px 6px rgba(255,39,66,.55);pointer-events:none;z-index:2147483647;transition:left .05s linear,top .05s linear";var c=document.createElement("div");c.style.cssText="position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:#ff2742";d.appendChild(c);(document.body||document.documentElement).appendChild(d);window.__xhsCur=d;var mv=function(x,y){d.style.left=x+"px";d.style.top=y+"px";};window.__xhsMove=mv;document.addEventListener("mousemove",function(e){mv(e.clientX,e.clientY);},true);document.addEventListener("mousedown",function(e){mv(e.clientX,e.clientY);try{d.animate([{boxShadow:"0 0 0 3px rgba(255,255,255,.95),0 0 0 0 rgba(255,39,66,.6)"},{boxShadow:"0 0 0 3px rgba(255,255,255,.95),0 0 0 26px rgba(255,39,66,0)"}],{duration:520});}catch(_){}},true);}ins();return "ok";})()';
    try { await this.evaluate({ target, expression: SCRIPT }); } catch (e) {}
  }

  // 按一个键(切图用 ArrowRight 等;选择器无关,稳)
  async pressKey({ target, key, code, vk }) {
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: key, code: code, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0 }, timeoutMs: 2500 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 60));
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: key, code: code, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0 }, timeoutMs: 2500 }).catch(() => {});
  }

  async humanMove({ target, toX, toY }) {
    const x = Math.round(toX), y = Math.round(toY);
    await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none' }, timeoutMs: 2500 }).catch(() => {});
    if (this.onPointer) { try { this.onPointer({ type: 'move', x, y }); } catch (e) {} }
    this._lastX = x; this._lastY = y;
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 100));
  }

  // 只移动红点(走 window.__xhsMove,不派发真实鼠标事件)——给悬浮敏感的元素(如筛选下拉)用:红点可见但不会触发面板收起
  async moveCursorVisual({ target, toX, toY }) {
    const x = Math.round(toX), y = Math.round(toY);
    await this.evaluate({ target, expression: 'window.__xhsMove&&window.__xhsMove(' + x + ',' + y + ')' }).catch(() => {});
    if (this.onPointer) { try { this.onPointer({ type: 'move', x, y }); } catch (e) {} }
    this._lastX = x; this._lastY = y;
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 100));
  }

  // 拟人点击:贝塞尔移过去 → 落点±抖动(不总点正中心)→ mousedown → dwell → mouseup(release 微抖)
  async click({ target, x, y }) {
    let X = Math.round(Number(x) + (Math.random() - 0.5) * 8);
    let Y = Math.round(Number(y) + (Math.random() - 0.5) * 6);
    await this.sendCommand({ target, method: 'Page.bringToFront', params: {}, timeoutMs: 2500 });
    await this.humanMove({ target, toX: X, toY: Y });
    if (this.onPointer) { try { this.onPointer({ type: 'click', x: X, y: Y }); } catch (e) {} }
    const releaseX = X + (Math.random() * 2 - 1);
    const releaseY = Y + (Math.random() * 2 - 1);
    await this.sendCommandSequence({
      target,
      timeoutMs: 2500,
      commands: [
        { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1 }, delayAfterMs: 60 + Math.floor(Math.random() * 90) },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: releaseX, y: releaseY, button: 'left', clickCount: 1 } }
      ]
    });
  }

  // 拟人滚动:trusted 滚轮(Input mouseWheel),拆成多个 280-500px tick + 横向漂移,搬自 BOSS humanWheelScroll
  // 取代 window.scrollBy(那是 isTrusted=false 的机器特征)
  async wheelScroll({ target, x = 600, y = 400, totalDeltaY = 0 }) {
    const deltaY = Math.round(Number(totalDeltaY) || 0);
    if (!deltaY) return;
    const deltaX = Math.round(Math.random() * 4 - 2);
    await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none' }, timeoutMs: 2500 }).catch(() => {});
    if (this.onPointer) { try { this.onPointer({ type: 'scroll', x: x + deltaX, y }); } catch (e) {} }
    this._lastX = x + deltaX; this._lastY = y;
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 60)));
  }

  // 真实输入:逐字 insertText(isTrusted=true)+ 不均匀间隔
  // → 监控里能看到打字过程,也更拟人(避免一次性整段插入的机器特征)
  async typeText({ target, text }) {
    const value = String(text || '');
    if (!value) return;
    await this.sendCommand({ target, method: 'Input.insertText', params: { text: value }, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 120 + Math.floor(Math.random() * 180)));
  }

  async selectAll({ target }) {
    const modifiers = process.platform === 'darwin' ? 4 : 2; // Meta on macOS, Ctrl elsewhere
    await this.sendCommandSequence({
      target,
      timeoutMs: 2500,
      commands: [
        // macOS Chromium may receive Meta+A without applying the editing action.
        // The explicit CDP editing command makes the selection reliable while
        // retaining the same real keyboard event path.
        { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers, commands: ['SelectAll'] } },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers } }
      ]
    });
  }

  async pressKey({ target, key, code, windowsVirtualKeyCode }) {
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode }, timeoutMs: 2500 }).catch(() => {});
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode }, timeoutMs: 2500 }).catch(() => {});
  }

  async pressEnter({ target }) {
    await this.pressKey({ target, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }

  async goBack({ target }) {
    const h = await this.sendCommand({ target, method: 'Page.getNavigationHistory' });
    const index = Number(h && h.currentIndex);
    const entries = (h && h.entries) || [];
    if (!Number.isFinite(index) || index <= 0 || !entries[index - 1]) throw new Error('no_navigation_history');
    return this.sendCommand({ target, method: 'Page.navigateToHistoryEntry', params: { entryId: entries[index - 1].id } });
  }
}

module.exports = { XhsCdpClient, waitForCommandResult };
