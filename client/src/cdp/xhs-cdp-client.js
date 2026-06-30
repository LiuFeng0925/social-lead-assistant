'use strict';

// 精简版 CDP 客户端:接管已登录的真实 Chrome,提供 导航 / 执行JS / 截图 等原子能力。
// 思路与 BOSS 的 BossCdpClient 一致(每条命令一个短连接),只保留 M1 需要的部分。

const { cdpFetch, cdpConnectWebSocket, alignCdpWebSocketUrl } = require('./cdp-fetch');

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
  async resolvePageTarget({ preferHost = 'xiaohongshu.com' } = {}) {
    const targets = await this.listTargets();
    const pages = targets.filter((t) =>
      t.type === 'page' &&
      typeof t.url === 'string' &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('chrome-extension://'));
    if (!pages.length) throw new Error('no_page_target');
    return pages.find((p) => p.url.includes(preferHost)) || pages[0];
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
      while (true) {
        const raw = await Promise.race([
          conn.waitForMessage(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('cdp_command_timeout')), timeoutMs))
        ]);
        const msg = JSON.parse(raw);
        if (msg.id !== id) continue;            // 跳过事件/其它响应
        if (msg.error) throw new Error(msg.error.message || 'cdp_command_failed');
        return msg.result?.result ?? msg.result ?? null;
      }
    } finally {
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
    const SCRIPT = '(function(){function ins(){if(window.__xhsCur){window.__xhsCur.style.opacity="1";return;}if(!document.body){return setTimeout(ins,60);}var d=document.createElement("div");d.id="__xhsCur";d.style.cssText="position:fixed;left:50%;top:50%;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;background:rgba(255,39,66,.30);border:3px solid #ff2742;box-shadow:0 0 0 3px rgba(255,255,255,.95),0 0 16px 6px rgba(255,39,66,.55);pointer-events:none;z-index:2147483647;transition:left .05s linear,top .05s linear";var c=document.createElement("div");c.style.cssText="position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:#ff2742";d.appendChild(c);(document.body||document.documentElement).appendChild(d);window.__xhsCur=d;var mv=function(x,y){d.style.left=x+"px";d.style.top=y+"px";};document.addEventListener("mousemove",function(e){mv(e.clientX,e.clientY);},true);document.addEventListener("mousedown",function(e){mv(e.clientX,e.clientY);try{d.animate([{boxShadow:"0 0 0 3px rgba(255,255,255,.95),0 0 0 0 rgba(255,39,66,.6)"},{boxShadow:"0 0 0 3px rgba(255,255,255,.95),0 0 0 26px rgba(255,39,66,0)"}],{duration:520});}catch(_){}},true);}ins();return "ok";})()';
    try { await this.evaluate({ target, expression: SCRIPT }); } catch (e) {}
  }

  // 按一个键(切图用 ArrowRight 等;选择器无关,稳)
  async pressKey({ target, key, code, vk }) {
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: key, code: code, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0 } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 60));
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: key, code: code, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0 } }).catch(() => {});
  }

  async humanMove({ target, toX, toY }) {
    const fromX = Number.isFinite(this._lastX) ? this._lastX : (toX - 80);
    const fromY = Number.isFinite(this._lastY) ? this._lastY : (toY - 60);
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const steps = Math.max(5, Math.min(25, Math.floor(dist / 30)));
    const cp1x = fromX + (toX - fromX) * (0.2 + Math.random() * 0.3);
    const cp1y = fromY + (toY - fromY) * (0.1 + Math.random() * 0.2) + (Math.random() - 0.5) * 40;
    const cp2x = fromX + (toX - fromX) * (0.5 + Math.random() * 0.3);
    const cp2y = fromY + (toY - fromY) * (0.7 + Math.random() * 0.2) + (Math.random() - 0.5) * 30;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, it = 1 - t;
      const px = it * it * it * fromX + 3 * it * it * t * cp1x + 3 * it * t * t * cp2x + t * t * t * toX;
      const py = it * it * it * fromY + 3 * it * it * t * cp1y + 3 * it * t * t * cp2y + t * t * t * toY;
      await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: Math.round(px), y: Math.round(py), button: 'none' } }).catch(() => {});
      if (this.onPointer) { try { this.onPointer({ type: 'move', x: Math.round(px), y: Math.round(py) }); } catch (e) {} }
      await new Promise((r) => setTimeout(r, 8 + Math.random() * 16));
    }
    this._lastX = toX; this._lastY = toY;
  }

  // 拟人点击:贝塞尔移过去 → 落点±抖动(不总点正中心)→ mousedown → dwell → mouseup(release 微抖)
  async click({ target, x, y }) {
    let X = Math.round(Number(x) + (Math.random() - 0.5) * 8);
    let Y = Math.round(Number(y) + (Math.random() - 0.5) * 6);
    await this.humanMove({ target, toX: X, toY: Y });
    if (this.onPointer) { try { this.onPointer({ type: 'click', x: X, y: Y }); } catch (e) {} }
    await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1 } });
    await new Promise((r) => setTimeout(r, 60 + Math.floor(Math.random() * 90)));
    await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: X + (Math.random() * 2 - 1), y: Y + (Math.random() * 2 - 1), button: 'left', clickCount: 1 } });
  }

  // 拟人滚动:trusted 滚轮(Input mouseWheel),拆成多个 280-500px tick + 横向漂移,搬自 BOSS humanWheelScroll
  // 取代 window.scrollBy(那是 isTrusted=false 的机器特征)
  async wheelScroll({ target, x = 600, y = 400, totalDeltaY = 0 }) {
    let remaining = Number(totalDeltaY) || 0;
    const dir = remaining >= 0 ? 1 : -1;
    let ticks = 0;
    while (Math.abs(remaining) > 0.5 && ticks < 64) {
      ticks++;
      const chunk = Math.min(Math.abs(remaining), 280 + Math.random() * 220);
      const tickY = dir * Math.round(chunk);
      remaining -= tickY;
      const tickX = Math.round(Math.random() * 4 - 2); // 横向漂移
      await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX: tickX, deltaY: tickY, button: 'none' } }).catch(() => {});
      if (this.onPointer) { try { this.onPointer({ type: 'scroll', x: x + tickX, y: y }); } catch (e) {} }
      this._lastX = x + tickX; this._lastY = y;
      await new Promise((r) => setTimeout(r, 3 + Math.floor(Math.random() * 13)));
    }
  }

  // 真实输入:逐字 insertText(isTrusted=true)+ 不均匀间隔
  // → 监控里能看到打字过程,也更拟人(避免一次性整段插入的机器特征)
  async typeText({ target, text }) {
    for (const ch of String(text)) {
      await this.sendCommand({ target, method: 'Input.insertText', params: { text: ch } });
      await new Promise((r) => setTimeout(r, 45 + Math.floor(Math.random() * 95)));
    }
  }

  async pressKey({ target, key, code, windowsVirtualKeyCode }) {
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode } });
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode } });
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

module.exports = { XhsCdpClient };
