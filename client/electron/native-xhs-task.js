'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const http = require('node:http');
const nativeXhs = require('./native-xhs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomMs = (min, max) => Math.round(min + Math.random() * (max - min));

function requestJson(port, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {};
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 270000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); }
        catch (e) { reject(new Error('native_api_invalid_response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('native_api_timeout')));
    if (payload) req.end(payload); else req.end();
  });
}

function postJson(port, pathname, body) {
  return requestJson(port, pathname, { method: 'POST', body: body || {} });
}

function parseKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/[,，；;\n]+/).map((item) => item.trim()).filter(Boolean);
}

function nativeNoteId(note) {
  const key = [note && note.title, note && note.author].map((value) => String(value || '').trim()).join('|');
  return 'native:' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 24);
}

function initialState() {
  return {
    running: false, status: 'idle', phase: 'idle', keyword: '', keywordIndex: 0, keywordTotal: 0, runId: 0,
    seen: 0, judged: 0, useful: 0, useless: 0, replied: 0, failed: 0, unmatched: 0,
    currentTitle: '', lastDecision: null, previewReady: false, message: ''
  };
}

const FOREGROUND_PAUSE_MESSAGE = '你已切换到其他应用，App 任务已暂停，不会抢回窗口。当前是前台测试模式，不支持同时后台运行。';
function isForegroundLoss(error) { return /native_app_not_frontmost/.test(String(error && error.message || error)); }

class NativeXhsTask extends EventEmitter {
  constructor({ accountPort = 3105, native = nativeXhs, request = requestJson, delay = sleep } = {}) {
    super();
    this.accountPort = accountPort;
    this.native = native;
    this.request = request;
    this.delay = delay;
    this.state = initialState();
    this.stopping = false;
    this.seenKeys = new Set();
    this.finishedRunId = 0;
  }

  snapshot() { return { ...this.state }; }

  log(message) {
    const row = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message: String(message || '') };
    this.emit('log', row);
  }

  update(partial) {
    Object.assign(this.state, partial || {});
    this.emit('status', this.snapshot());
  }

  async record(action, body = {}) {
    const result = await this.request(this.accountPort, '/api/native/app-record', { method: 'POST', body: { action, ...body } });
    if (!result.ok) throw new Error(result.msg || 'native_record_failed');
    return result;
  }

  async finishRun(status) {
    const runId = Number(this.state.runId) || 0;
    if (!runId || this.finishedRunId === runId) return;
    this.finishedRunId = runId;
    await this.record('finish', { runId, status }).catch(() => {});
  }

  async start(options = {}) {
    if (this.state.running) return { ok: false, message: '第 5 号 App 任务已在运行。', status: this.snapshot() };
    if (options.allowForeground !== true) return { ok: false, message: '当前 App 引擎尚不支持后台无干扰运行。接受占用 App 前台测试时，请先勾选控制台的“允许前台测试”；否则不会启动。', status: this.snapshot() };
    const runtime = await this.request(this.accountPort, '/api/native/app-config');
    if (!runtime.ok) return { ok: false, message: runtime.msg || '读取第 5 号任务设置失败。', status: this.snapshot() };
    const keywords = parseKeywords(options.keyword || runtime.keywords);
    const maxNotes = Math.max(1, Math.min(300, Number(options.maxNotes) || Number(runtime.maxNotes) || 10));
    const liveSend = typeof options.liveSend === 'boolean' ? options.liveSend : runtime.liveSend === true;
    const continuous = options.continuous !== false;
    const rescanMinutes = Math.max(1, Number(options.rescanMinutes) || Number(runtime.rescanMinutes) || 15);
    if (!keywords.length) return { ok: false, message: '请先到“任务设置”填写检索关键词。', status: this.snapshot() };
    if (runtime.scheduleEnabled && !runtime.inWork) return { ok: false, message: runtime.workReason || '当前不在任务设置的运行时段。', status: this.snapshot() };

    const started = await this.record('start', { live: liveSend });
    this.stopping = false;
    this.seenKeys.clear();
    this.finishedRunId = 0;
    this.state = {
      ...initialState(), running: true, status: 'running', phase: 'search', keyword: keywords[0],
      keywordIndex: 1, keywordTotal: keywords.length, runId: Number(started.runId) || 0,
      message: '第 5 号原生 App 任务正在运行。'
    };
    this.emit('status', this.snapshot());
    this.run({ keywords, maxNotes, liveSend, continuous, rescanMinutes }).catch(async (error) => {
      if (isForegroundLoss(error)) {
        await this.finishRun('paused');
        this.update({ running: false, status: 'paused', phase: 'paused', message: FOREGROUND_PAUSE_MESSAGE });
        this.log(FOREGROUND_PAUSE_MESSAGE);
        return;
      }
      await this.finishRun('failed');
      this.update({ running: false, status: 'failed', phase: 'failed', failed: this.state.failed + 1, message: error.message });
      this.log('任务停止：' + error.message);
    });
    return { ok: true, message: '第 5 号原生 App 获客任务已启动。', status: this.snapshot() };
  }

  stop() {
    this.stopping = true;
    if (this.state.running) this.update({ status: 'stopping', message: '正在安全停止…' });
    return { ok: true, status: this.snapshot() };
  }

  clear() {
    if (this.state.running) return { ok: false, message: '任务仍在运行，请先停止。', status: this.snapshot() };
    this.state = initialState();
    this.seenKeys.clear();
    this.emit('status', this.snapshot());
    return { ok: true, status: this.snapshot() };
  }

  async wait(ms) {
    for (let elapsed = 0; elapsed < ms && !this.stopping; elapsed += 1000) await this.delay(Math.min(1000, ms - elapsed));
  }

  async runKeyword({ keyword, keywordIndex, keywordTotal, maxNotes, liveSend }) {
    this.update({ phase: 'search', keyword, keywordIndex, keywordTotal });
    this.log(`关键词 ${keywordIndex}/${keywordTotal}：${keyword}（本词最多 ${maxNotes} 篇）`);
    await this.native.search(keyword);
    await this.delay(1800);
    let emptyRounds = 0;
    let judgedForKeyword = 0;
    while (!this.stopping && judgedForKeyword < maxNotes) {
      this.update({ phase: 'scan' });
      const cards = await this.native.listVisibleCards();
      const fresh = cards.filter((card) => !this.seenKeys.has(card.title + '|' + card.author));
      if (!fresh.length) {
        emptyRounds += 1;
        if (emptyRounds >= 4) break;
        this.log('本屏没有新笔记，继续向下浏览。');
        await this.native.scrollList();
        continue;
      }
      emptyRounds = 0;
      for (const card of fresh) {
        if (this.stopping || judgedForKeyword >= maxNotes) break;
        const key = card.title + '|' + card.author;
        this.seenKeys.add(key);
        const stub = { id: nativeNoteId(card), title: card.title, author: card.author, region: '', intent: '', url: '', tags: [] };
        await this.record('scan', { runId: this.state.runId, keyword, note: stub });
        this.update({ phase: 'open', seen: this.state.seen + 1, currentTitle: card.title });
        this.log('打开笔记：' + card.title);
        let note = stub;
        let markedJudged = false;
        try {
          if (this.native.assertForeground) await this.native.assertForeground();
          await this.native.openCard(card);
          note = Object.assign({}, await this.native.readCurrentNote(card), { id: stub.id, url: '', tags: [] });
          const security = this.native.securityReason(note.title + '\n' + note.desc);
          if (security) throw new Error('检测到' + security + '，请手动处理后再继续');
          this.update({ phase: 'classify' });
          this.log('读取完成，按第 5 号“获客模型”和“模型设置”判断。');
          const assessed = await this.request(this.accountPort, '/api/native/app-assess', { method: 'POST', body: note });
          if (this.stopping) break;
          if (!assessed.ok) {
            if (assessed.model_failed) {
              await this.record('decision', { runId: this.state.runId, keyword, note, decision: { eligible: false, categoryName: '调用失败', locationMatch: 'unknown', reason: '大模型分类失败' } });
              throw new Error('大模型调用失败');
            }
            throw new Error(assessed.msg || '笔记判断失败');
          }
          let decision = assessed.decision || {};
          const eligible = decision.eligible === true;
          await this.record('decision', { runId: this.state.runId, keyword, note, decision });
          judgedForKeyword += 1;
          this.update({
            judged: this.state.judged + 1,
            useful: this.state.useful + (eligible ? 1 : 0),
            useless: this.state.useless + (eligible ? 0 : 1),
            lastDecision: { id: note.id, keyword, title: note.title, author: note.author, desc: note.desc, decision, comment: '', screenshot: note.screenshot }
          });
          markedJudged = true;
          this.log((eligible ? '有用' : '无用') + '：' + (decision.decisionReason || decision.reason || decision.categoryName || '未说明'));
          if (eligible) {
            const old = await this.record('commented', { note });
            if (old.commented) {
              this.log('该账号以前已经成功评论过，跳过重复发送。');
            } else {
              const gate = await this.record('gate');
              if (!gate.gate || !gate.gate.ok) {
                this.log('暂不发送：' + ((gate.gate && gate.gate.reason) || '防封控制暂不允许评论'));
              } else {
                this.update({ phase: 'gallery' });
                this.log('按本篇明确需求查询本地房源图库，不使用预先固定的图片。');
                const planned = await this.request(this.accountPort, '/api/native/reply-plan', { method: 'POST', body: { noteId: note.id, runId: this.state.runId, keyword } });
                if (!planned.ok) throw new Error(planned.msg || '图库匹配失败');
                const plan = planned.plan || {};
                decision = planned.decision || decision;
                this.update({ lastDecision: { ...this.state.lastDecision, decision, plan, comment: plan.comment || '' } });
                this.log('图库：' + (plan.reason || plan.status));
                if (plan.status !== 'matched') {
                  this.update({ unmatched: this.state.unmatched + 1 });
                  if (plan.status === 'failed') throw new Error(plan.reason || '图库调用失败');
                  continue;
                }
                if (this.stopping) break;
                this.log('匹配房源：' + plan.property.id + ' · ' + plan.property.title + '；' + (plan.matchReasons || []).join('；'));
                this.update({ phase: 'prepare_image' });
                await this.native.prepareImage(plan.imagePath);
                if (this.stopping) break;
                this.update({ phase: 'compose' });
                const attachment = await this.native.attachImage(plan.imagePath);
                // 选图器若无法证实选中的正是本篇房源图片，只能留下预览，禁止盲发最近图片。
                const imageVerified = attachment && attachment.verified === true;
                if (imageVerified && !this.stopping) await this.native.fillComment(plan.comment);
                if (this.stopping) break;
                if (!liveSend || !imageVerified) {
                  const reason = !imageVerified ? '已按需求匹配房源并生成文案；App 图片身份尚未核验，未自动选图或发送，请在控制台查看匹配结果。' : '文字和匹配房源图片已经填好，请在 App 中检查。';
                  const previewPlan = { ...plan, status: 'preview_ready', imageVerified, imageSha256: attachment && attachment.sha256, reason };
                  decision = { ...decision, decisionReason: (decision.decisionReason || decision.reason || '') + '\n发送：' + reason };
                  await this.record('reply-plan', { runId: this.state.runId, keyword, note, decision, plan: previewPlan });
                  await this.finishRun('preview_ready');
                  this.update({ running: false, status: 'preview_ready', phase: 'preview', previewReady: true, message: reason, lastDecision: { ...this.state.lastDecision, decision, plan: previewPlan } });
                  this.log(reason);
                  return 'preview';
                }
                if (this.stopping) break;
                const finalGate = await this.record('gate');
                if (!finalGate.gate || !finalGate.gate.ok || this.stopping) throw new Error('发送前暂停：' + ((finalGate.gate && finalGate.gate.reason) || '任务已停止'));
                this.update({ phase: 'send' });
                await this.native.sendPreparedComment();
                await this.record('sent', { runId: this.state.runId, keyword, note, decision, comment: plan.comment, imagePath: plan.imagePath });
                await this.record('reply-plan', { runId: this.state.runId, keyword, note, decision, plan: { ...plan, status: 'sent', imageVerified: true } });
                this.update({ replied: this.state.replied + 1 });
                this.log('图片评论已发送，并已写入“评论记录”。');
                const humanPause = randomMs(25000, 55000);
                this.log(`拟人间隔 ${Math.round(humanPause / 1000)} 秒后再继续。`);
                await this.wait(humanPause);
              }
            }
          }
        } catch (error) {
          if (isForegroundLoss(error)) {
            await this.finishRun('paused');
            this.update({ running: false, status: 'paused', phase: 'paused', message: FOREGROUND_PAUSE_MESSAGE });
            this.log(FOREGROUND_PAUSE_MESSAGE);
            return 'paused';
          }
          if (!markedJudged) {
            judgedForKeyword += 1;
            this.update({ judged: this.state.judged + 1, failed: this.state.failed + 1 });
          } else {
            this.update({ failed: this.state.failed + 1 });
          }
          this.log('本篇失败：' + (error && error.message ? error.message : String(error)));
          if (/安全|验证|登录/.test(String(error && error.message || error))) {
            await this.finishRun('paused');
            this.update({ running: false, status: 'paused', phase: 'paused', message: error.message });
            return 'paused';
          }
        } finally {
          if (!this.stopping && !this.state.previewReady && this.state.status !== 'paused') await this.native.closeCurrentNote().catch(() => {});
        }
      }
      if (!this.stopping && judgedForKeyword < maxNotes) await this.native.scrollList();
    }
    return 'done';
  }

  async run({ keywords, maxNotes, liveSend, continuous, rescanMinutes }) {
    // The user explicitly opted in to foreground testing at Start. This is the
    // only automatic activation: later focus loss pauses rather than stealing it.
    const activated = await this.native.activate();
    if (!activated.ok) throw new Error(activated.message || '原生 App 无法启动');
    this.log('按需图文模式：先读笔记提取需求，再找匹配房源图片；无匹配不发图。');
    while (!this.stopping) {
      for (let i = 0; i < keywords.length && !this.stopping; i += 1) {
        const result = await this.runKeyword({ keyword: keywords[i], keywordIndex: i + 1, keywordTotal: keywords.length, maxNotes, liveSend });
        if (result === 'preview' || result === 'paused') return;
      }
      if (!continuous || !liveSend || this.stopping) break;
      const waitMs = rescanMinutes * 60000;
      this.update({ phase: 'waiting', message: `本轮完成，${rescanMinutes} 分钟后重新检索。` });
      this.log(`本轮关键词已完成，${rescanMinutes} 分钟后重新检索。`);
      await this.wait(waitMs);
    }
    const status = this.stopping ? 'stopped' : 'completed';
    await this.finishRun(status);
    this.update({ running: false, status, phase: 'done', message: this.stopping ? '已停止' : '本轮完成' });
    this.log(this.stopping ? '第 5 号 App 任务已停止。' : '第 5 号 App 本轮任务完成。');
  }
}

module.exports = { NativeXhsTask, requestJson, postJson, parseKeywords, nativeNoteId, initialState };
