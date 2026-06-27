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

  // 拟人点击:mousedown→dwell→mouseup,release 落点 ±1px 微抖(贴近真人,避免合成点击指纹)
  async click({ target, x, y }) {
    const X = Number(x), Y = Number(y);
    if (this.onPointer) { try { this.onPointer({ type: 'click', x: X, y: Y }); } catch (e) {} }
    await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: X, y: Y, button: 'none' } });
    await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1 } });
    await new Promise((r) => setTimeout(r, 60 + Math.floor(Math.random() * 90)));
    await this.sendCommand({ target, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: X + (Math.random() * 2 - 1), y: Y + (Math.random() * 2 - 1), button: 'left', clickCount: 1 } });
  }

  // 真实输入:CDP Input.insertText(isTrusted=true),非 JS 赋值
  async typeText({ target, text }) {
    await this.sendCommand({ target, method: 'Input.insertText', params: { text } });
  }

  async pressEnter({ target }) {
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } });
    await this.sendCommand({ target, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } });
  }
}

module.exports = { XhsCdpClient };
