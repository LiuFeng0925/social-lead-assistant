'use strict';

// 本地界面服务 —— 原生 http + SSE(实时推进度)。把引擎接上网页,浏览器打开即可用。
// 启动:node src/server.js  →  http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('./engine');
const { startScreencast } = require('./cdp/screencast');
const db = require('./db');
const throttle = require('./throttle');
const inboxUtils = require('./inbox-utils');
const dateFilter = require('./date-filter');
const { readLoginStatus, recoverInteractiveAccess } = require('./login-status');
const { openNoteFromList, closeCurrentNote } = require('./note-navigation');
const { parseKeywords, uniqueNotes, keywordScanPlan } = require('./keyword-utils');
const { launchChromeForCdp } = require('./browser-launch');
const {
  COMMENT_COMPOSER_PROBE: PROBE,
  pickCommentInput,
  pickEnabledSendButton,
  inputHasExpectedText,
  normalizeText
} = require('./comment-composer-probe');

const PORT = Number(process.env.XHS_UI_PORT || 3000);
const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const ACCOUNT_ID = Math.max(1, Number(process.env.XHS_ACCOUNT_ID || 1));
const TMP = path.join(__dirname, '..', 'tmp');
const CHROME_PROFILE = path.join(__dirname, '..', '.xhs-chrome-profile');
const DETAIL_N = Number(process.env.XHS_DETAIL_N || 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

function formatCategoryCounts(byIntent) {
  const rows = Object.entries(byIntent || {}).filter(([, v]) => Number(v) > 0);
  return rows.length ? rows.map(([k, v]) => `${k} ${v}`).join(' / ') : '无分类';
}

function formatClassificationFacts(decision) {
  const rows = [];
  if (decision.city) rows.push('城市=' + decision.city);
  if (decision.district) rows.push('区县=' + decision.district);
  if (decision.location) rows.push('位置=' + decision.location);
  for (const [key, value] of Object.entries(decision.slotValues || {})) {
    if (value && !rows.some((row) => row.endsWith('=' + value))) rows.push(key + '=' + value);
  }
  if (decision.matchedServiceArea) rows.push('对应服务区=' + decision.matchedServiceArea);
  if (decision.locationEvidence) rows.push('地点依据=' + decision.locationEvidence);
  return rows.length ? rows.join('；') : '正文未提取到明确地区/预算/位置等信息';
}

async function scanKeywords({ client, target, keywordText, filters, maxNotes, onLog, shouldStop }) {
  const keywords = parseKeywords(keywordText);
  const eachMax = Math.max(1, Math.floor(Number(maxNotes) || 1));
  const collected = [];
  for (let index = 0; index < keywords.length; index++) {
    if (shouldStop()) break;
    const keyword = keywords[index];
    onLog(`关键词 ${index + 1}/${keywords.length}: ${keyword}`);
    const notes = await engine.scanClean({ client, target, keyword, filters, maxNotes: eachMax, onLog, shouldStop });
    collected.push(...notes);
  }
  const notes = uniqueNotes(collected);
  if (keywords.length > 1) onLog(`多关键词合并：每词最多 ${eachMax} 篇，共抓取 ${collected.length} 篇 → 去重后 ${notes.length} 篇`);
  return notes;
}

let lastRun = null; // { client, target, results }
let runState = { running: false, cancelled: false }; // 任务停止开关
const monitors = new Set(); // 实时监控的 SSE 推送函数
function broadcastPointer(p) { monitors.forEach((s) => { try { s('pointer', p); } catch (e) {} }); }
let sharedCast = null; // 单一共享 screencast:所有 monitor 共用一份,避免互相 start/stop 打架
function broadcastFrame(p) { monitors.forEach((s) => { try { s('frame', p); } catch (e) {} }); }
async function ensureScreencast(client, target) {
  if (sharedCast) return;
  sharedCast = { handle: null, lastFrame: null }; // 先占位(同步),防并发重复启动
  try {
    sharedCast.handle = await startScreencast({ target, endpoint: ENDPOINT, onFrame: (data, meta) => { const p = { d: data, w: meta.deviceWidth || 0, h: meta.deviceHeight || 0 }; sharedCast.lastFrame = p; broadcastFrame(p); } });
  } catch (e) { sharedCast = null; throw e; }
}

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleRun(req, res, q) {
  const cfg = db.getConfig();
  const keyword = q.get('keyword') || cfg.task_keyword || '朝阳 租房';
  const max = Number(q.get('max')) || throttle.currentScanLimit(cfg);
  const filters = { sort: q.get('sort') || cfg.task_sort || '综合', noteTime: q.get('note_time') || cfg.task_note_time || '不限', noteType: q.get('note_type') || cfg.task_note_type || '不限', noteRange: q.get('note_range') || cfg.task_note_range || '不限' };
  const direction = q.get('direction') || cfg.task_direction || '我是房源方,结合对方诉求友好回应,引导看主页/私聊,绝不留联系方式';
  const send = sse(res);
  runState = { running: true, cancelled: false };
  try {
    send('log', '连接 CDP…');
    const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
    send('log', '已接管:' + (target.title || target.url));
    send('phase', { phase: 'search' });
    const notes = await scanKeywords({ client, target, keywordText: keyword, filters, maxNotes: max, onLog: (m) => send('log', m), shouldStop: () => runState.cancelled });
    if (runState.cancelled) { send('log', '⏹ 任务已停止'); send('done', { stopped: true }); res.end(); runState.running = false; return; }
    send('phase', { phase: 'match' });
    const { tagged, targets, byIntent } = engine.prepareNotesForDetailClassification(notes, cfg);
    tagged.forEach((n) => { try { db.upsertNote(n); } catch (e) {} }); // 存采集历史(看过哪些笔记,带意向/地区)
    const fresh = targets;
    send('log', `采集:${notes.length} 条 → ${formatCategoryCounts(byIntent)};全部先读标题+正文再分类`);
    send('stats', { total: notes.length, byIntent, targetCount: fresh.length });
    send('phase', { phase: 'generate' });
    const results = [];
    const todo = fresh.slice(0, DETAIL_N);
    for (let i = 0; i < todo.length; i++) {
      if (runState.cancelled) { send('log', '⏹ 任务已停止'); break; }
      const t = todo[i];
      send('log', `读详情 + 生成 ${i + 1}/${todo.length}:${t.title || '(无标题)'}`);
      let d;
      try {
        d = await engine.readDetail({ client, target, note: t, onLog: (m) => send('log', m), browse: { imagesMin: cfg.browse_images_min, imagesMax: cfg.browse_images_max, bodyMin: cfg.browse_body_dwell_min, bodyMax: cfg.browse_body_dwell_max, cScrollMin: cfg.browse_comment_scrolls_min, cScrollMax: cfg.browse_comment_scrolls_max, cDwellMin: cfg.browse_comment_dwell_min, cDwellMax: cfg.browse_comment_dwell_max } });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (msg.startsWith('note_card_not_found:') || msg.startsWith('note_detail_not_opened:')) {
          send('log', `跳过:${t.title || t.id} —— 当前搜索列表里无法像真人一样点开,不直跳详情`);
          continue;
        }
        throw e;
      }
      const merged = { ...t, title: d.title || t.title, author: d.author || t.author, tags: d.tags || [], desc: d.desc || '' };
      const publisher = await engine.classifyDetailedNote(merged, cfg);
      send('log', `${publisher.classificationMethodLabel}分类:${publisher.label} / 地区${publisher.locationMatch} / 置信度${Math.round(publisher.confidence * 100)}% —— ${publisher.decisionReason}`);
      send('log', '正文提取:' + formatClassificationFacts(publisher));
      const classifiedNote = Object.assign({}, merged, {
        category_id: publisher.categoryId,
        category_name: publisher.categoryName,
        category_action: publisher.categoryAction,
        category_reply_strategy: publisher.categoryReplyStrategy,
        intent: publisher.categoryName
      });
      const comment = publisher.eligible ? await engine.makeComment(classifiedNote, direction, cfg) : '';
      const comp = comment ? engine.check(comment) : { ok: false, violations: ['当前分类不允许评论作者或地区不匹配'] };
      const agentReject = engine.rejectsAgent((d.title || '') + (d.desc || ''));
      const r = {
        index: i, id: t.id, url: t.url, title: t.title || '(无标题)', author: t.author, region: t.region,
        searchUrl: t.searchUrl,
        likes: t.likes, collects: t.collects, comments: t.comments, intent: publisher.categoryName, category_confidence: publisher.confidence, classify_reason: publisher.decisionReason, tags: d.tags || [],
        descSample: (d.desc || '').replace(/#[^#]*\[话题\]#/g, '').replace(/\s+/g, ' ').trim().slice(0, 80),
        category_name: publisher.categoryName, category_action: publisher.categoryAction,
        classification_method: publisher.classificationMethod,
        publisher_role: publisher.role, publisher_label: publisher.label, location_match: publisher.locationMatch,
        classification_confidence: publisher.confidence, classification_reason: publisher.decisionReason,
        extracted_slots: publisher.slotValues, extracted_city: publisher.city, extracted_district: publisher.district, extracted_location: publisher.location,
        comment, compliant: comp.ok, violations: comp.violations, agentReject
      };
      results.push(r);
      send('result', r);
      await sleep(rand(400, 900));
    }
    lastRun = { client, target, results };
    send('done', { total: notes.length, byIntent, targetCount: targets.length, generated: results.length });
  } catch (e) {
    send('log', '✗ 出错:' + e.message);
    send('done', { error: e.message });
  }
  res.end();
}

async function handleSend(req, res, q) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const index = Number(q.get('index') || 0);
  const confirm = q.get('confirm') === '1';
  const dry = !confirm;
  try {
    if (!lastRun || !lastRun.results[index]) { res.end(JSON.stringify({ ok: false, msg: '没有这条结果,先运行一次检索' })); return; }
    if (confirm && fs.existsSync(path.join(TMP, 'STOP'))) { res.end(JSON.stringify({ ok: false, msg: 'STOP 刹车生效,拒绝发送' })); return; }
    const r = lastRun.results[index];
    const comment = q.get('comment') || r.comment;
    const comp = engine.check(comment);
    if (!comp.ok) { res.end(JSON.stringify({ ok: false, msg: '合规不过:' + comp.violations.map((v) => v.hint).join('、') })); return; }
    const { client, target } = lastRun;
    let opened = false;
    const closeAndEnd = async (payload) => {
      if (opened) {
        try { await closeCurrentNote({ client, target, note: r }); }
        catch (e) {
          payload.ok = false;
          payload.msg = (payload.msg ? payload.msg + '；' : '') + '关闭当前笔记失败:' + e.message;
        }
      }
      res.end(JSON.stringify(payload));
    };
    await openNoteFromList({ client, target, note: r });
    opened = true;
    for (let k = 0; k < 12; k++) { await sleep(800); const rs = await client.evaluate({ target, expression: 'document.readyState' }); if (rs && rs.value === 'complete') break; }
    await sleep(1400);
    if (!dry) {
      const access = await recoverInteractiveAccess({ client, target });
      if (!access.ok && !access.allowWriteProbe) { await closeAndEnd({ ok: false, msg: '⚠ ' + (access.reason || '账号需要人工登录/验证') }); return; }
    }
    await client.wheelScroll({ target, x: 600, y: 400, totalDeltaY: 600 }).catch(() => {}); // trusted 滚轮(拟人)
    await sleep(rand(900, 1600));
    const pr = await client.evaluate({ target, expression: PROBE });
    let probe; try { probe = JSON.parse(pr.value); } catch (e) { probe = { inputs: [], sendBtns: [] }; }
    const input = pickCommentInput(probe);
    if (!input) { await closeAndEnd({ ok: false, msg: '没定位到笔记底部评论框' }); return; }
    if (dry) { await closeAndEnd({ ok: true, dry: true, msg: 'dry-run:已定位评论框并关闭详情(未发送)' }); return; }
    // 防封限频:真发前先过 throttle(工作时间/今日上限/每小时/间隔)
    const gate = throttle.canComment();
    if (!gate.ok) { await closeAndEnd({ ok: false, msg: '⛔ 限频拦截:' + gate.reason }); return; }
    if (normalizeText(input.text)) { await closeAndEnd({ ok: false, msg: '评论框已有未发送内容,为避免误发已跳过' }); return; }
    await client.click({ target, x: input.x, y: input.y });
    await sleep(rand(700, 1300));
    await client.typeText({ target, text: comment });
    await sleep(rand(1200, 2000));
    const pr2 = await client.evaluate({ target, expression: PROBE });
    let probe2; try { probe2 = JSON.parse(pr2.value); } catch (e) { probe2 = { inputs: [], sendBtns: [] }; }
    if (!inputHasExpectedText(pickCommentInput(probe2), comment)) { await closeAndEnd({ ok: false, msg: '文字没有进入目标评论框,为避免点错已停止发送' }); return; }
    const btn = pickEnabledSendButton(probe2);
    if (!btn) { await closeAndEnd({ ok: false, msg: '评论已输入但没找到发送按钮' }); return; }
    await client.click({ target, x: btn.x, y: btn.y });
    await sleep(1800);
    // 验证真的发出去了(评论成功提示 或 输入框被清空),不再盲目报成功
    let okSent = false;
    try {
      const sentProbe = JSON.parse((await client.evaluate({ target, expression: PROBE })).value);
      const sentInput = pickCommentInput(sentProbe);
      okSent = sentProbe.success === true || (!!sentInput && !normalizeText(sentInput.text));
    } catch (e) {}
    if (okSent) {
      try { db.insertComment({ noteId: r.id, noteTitle: r.title, noteUrl: r.url, content: comment, status: 'sent' }); } catch (e) {}
      await closeAndEnd({ ok: true, dry: false, msg: '已发送 ✓(已确认成功,已关闭详情)' });
    } else {
      await closeAndEnd({ ok: false, dry: false, msg: '✗ 点了发送但没确认成功——可能未登录/被拦/按钮禁用,评论没发出' });
    }
  } catch (e) {
    res.end(JSON.stringify({ ok: false, msg: e.message }));
  }
}

async function handleScreencast(req, res) {
  const send = sse(res);
  monitors.add(send);
  try {
    let client, target;
    if (lastRun && lastRun.target) { client = lastRun.client; target = lastRun.target; }
    else { const c = await engine.connect(ENDPOINT, broadcastPointer); client = c.client; target = c.target; lastRun = { client, target, results: [] }; }
    send('hello', { ok: true });
    // 一连上就给画面:有共享最近帧直接发,否则现拍一张
    if (sharedCast && sharedCast.lastFrame) { send('frame', sharedCast.lastFrame); }
    else {
      try {
        const img = await client.screenshot({ target });
        let wh = {};
        try { const vp = await client.evaluate({ target, expression: 'JSON.stringify({w:window.innerWidth,h:window.innerHeight})' }); wh = JSON.parse((vp && vp.value) || '{}'); } catch (e) {}
        if (img) send('frame', { d: img, w: wh.w || 1280, h: wh.h || 800 });
      } catch (e) {}
    }
    // 单一共享 screencast,帧广播给所有 monitor(多个连接不再各自 start/stop 打架)
    await ensureScreencast(client, target);
  } catch (e) { send('hello', { ok: false, msg: e.message }); }
  req.on('close', () => {
    monitors.delete(send);
    if (monitors.size === 0 && sharedCast && sharedCast.handle) { try { sharedCast.handle.stop(); } catch (e) {} sharedCast = null; }
  });
}

async function handleClick(req, res, q) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    let cli = lastRun && lastRun.client, tgt = lastRun && lastRun.target;
    if (!cli) { const c = await engine.connect(ENDPOINT, broadcastPointer); cli = c.client; tgt = c.target; lastRun = { client: cli, target: tgt, results: (lastRun && lastRun.results) || [] }; }
    const x = Number(q.get('x')), y = Number(q.get('y'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) { res.end(JSON.stringify({ ok: false, msg: '坐标无效' })); return; }
    await cli.click({ target: tgt, x, y }); // click 会广播 pointer,前端同步显示红点
    res.end(JSON.stringify({ ok: true }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

async function handleRecords(req, res, q) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const commentsRange = dateFilter.parseRangeParams(q, 'comments_');
    const notesRange = dateFilter.parseRangeParams(q, 'notes_');
    res.end(JSON.stringify({
      ok: true,
      stats: db.stats({ comments: commentsRange, notes: notesRange }),
      comments: db.listComments(100, commentsRange),
      notes: db.listNotes(120, notesRange),
      leads: db.listLeads(60),
    }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

async function handleStop(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  runState.cancelled = true; // 引擎循环会在下一步检查到并中断
  res.end(JSON.stringify({ ok: true }));
}

// 承接 step1:刷新收件 = 进通知页抓「评论和@」→ 去重入库 → 返回列表+统计
async function handleInboxScan(req, res, q) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const range = dateFilter.parseRangeParams(q);
    const cfg = db.getConfig();
    const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
    try { await client.installCursor({ target }); } catch (e) {}
    const items = await engine.scanInbox({ client, target, max: 40, recentDays: Number(cfg.reply_recent_days) || 0 });
    let added = 0;
    for (const it of items) {
      const p = inboxUtils.prepareInboxItem({ type: it.type, nick: it.nick, user_link: it.link, content: it.content, basis_text: it.basis_text, raw_text: it.raw_text, action_date: it.date, note_url: it.note_url, source_key: it.source_key });
      const timeWhy = inboxTimeSkipReason(p, cfg);
      const why = p.skip_reason || timeWhy;
      try { if (db.insertInbox({ ...p, status: why ? 'skipped' : 'new', skip_reason: why })) added++; } catch (e) {}
    }
    res.end(JSON.stringify({ ok: true, scanned: items.length, added, items: db.listInbox(100, range), stats: db.inboxStats(range) }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

function inboxTimeSkipReason(item, cfg) {
  const recentDays = Number(cfg && cfg.reply_recent_days) || 0;
  if (recentDays <= 0) return '';
  const parsed = inboxUtils.parseNotificationTime(item.action_date || item.date || item.time_raw || '');
  if (parsed.confidence === 'unknown') return '未识别到评论时间';
  if (Number.isFinite(parsed.daysAgo) && parsed.daysAgo > recentDays) return '超出近 ' + recentDays + ' 天';
  return '';
}
async function handleInboxList(req, res, q) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const range = dateFilter.parseRangeParams(q);
    res.end(JSON.stringify({ ok: true, items: db.listInbox(100, range), stats: db.inboxStats(range) }));
  }
  catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}
// 独立跑一轮承接(测试 / 手动「开始承接」);dry 默认看 reply_dry_run
async function handleInboxRun(req, res, q) {
  const send = sse(res);
  runState = { running: true, cancelled: false };
  const cfg = db.getConfig();
  const dryParam = q.get('dry');
  const dry = dryParam != null ? (dryParam !== '0') : (cfg.reply_dry_run !== false);
  try {
    send('log', dry ? '🟡 承接 · 演练(只定位+生成草稿,不真发)' : '🔴 承接 · 真发(会真回评论!)');
    const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
    try { await client.installCursor({ target }); } catch (e) {}
    const replied = await drainInbox({ client, target, cfg, dry, send });
    send('done', { replied: replied, dry: dry });
  } catch (e) { send('log', '✗ 出错:' + e.message); send('done', { error: e.message }); }
  runState.running = false;
  res.end();
}

async function handleThrottle(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try { res.end(JSON.stringify({ ok: true, ...throttle.status() })); } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}
async function handleSaveConfig(req, res, q) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try { const data = JSON.parse(q.get('data') || '{}'); db.setConfig(data); res.end(JSON.stringify({ ok: true })); } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

async function handleLoginStatus(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
    lastRun = { client, target, results: (lastRun && lastRun.results) || [] };
    const st = await readLoginStatus(client, target);
    res.end(JSON.stringify({ ok: true, loggedIn: st.loggedIn }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

async function handleTriggerLogin(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    let connection;
    try {
      connection = await engine.connect(ENDPOINT, broadcastPointer);
    } catch (error) {
      if (!/ECONNREFUSED|cdp_list_targets|cdp_socket/i.test(String(error && error.message || error))) throw error;
      await launchChromeForCdp({ endpoint: ENDPOINT, profileDir: CHROME_PROFILE });
      connection = await engine.connect(ENDPOINT, broadcastPointer);
    }
    const { client, target } = connection;
    lastRun = { client, target, results: (lastRun && lastRun.results) || [] };
    const before = await readLoginStatus(client, target);
    if (before.loggedIn) {
      res.end(JSON.stringify({ ok: true, loggedIn: true, msg: '已检测到右侧浏览器已登录,不用扫码' }));
      return;
    }
    // 导航到搜索页:小红书未登录时会自动弹出登录扫码框(比找按钮点击可靠)
    await client.navigate({ target, url: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent('朝阳 租房') + '&source=web_search_result_notes' });
    await sleep(2500);
    const after = await readLoginStatus(client, target);
    if (after.loggedIn) {
      res.end(JSON.stringify({ ok: true, loggedIn: true, msg: '已登录,现在可以开始检索' }));
      return;
    }
    let wall = false;
    try { const r = await client.evaluate({ target, expression: '(document.body.innerText.indexOf("登录后")>=0||document.body.innerText.indexOf("扫码")>=0)?"wall":"ok"' }); wall = r && r.value === 'wall'; } catch (e) {}
    res.end(JSON.stringify({ ok: true, loggedIn: false, msg: wall ? '登录扫码框已弹出 → 扫右侧浏览器里的二维码' : '已打开搜索页;如果右侧没弹框,请在页面里手动点「登录」' }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

async function handleCursorInstall(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    let client, target;
    if (lastRun && lastRun.target) { client = lastRun.client; target = lastRun.target; }
    else { const c = await engine.connect(ENDPOINT, broadcastPointer); client = c.client; target = c.target; lastRun = { client, target, results: [] }; }
    await client.installCursor({ target });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

// 打开一篇笔记 → 定位评论框 →(真发:输入+点发送+验证成功+入库)→ 关闭。dry=true 只定位不发。
// 在「已打开且已浏览到评论区」的笔记上评论:定位评论框 →(真发:输入+点发送+验证+入库)。不开不关(由 readDetail 管)。
async function commentOnOpenNote({ client, target, note, comment, dry, onLog = () => {}, shouldStop = () => false }) {
  try {
    if (shouldStop()) return { ok: false, stopped: true, msg: 'machine_stopped' };
    let uncertainAccess = false;
    let probe = { inputs: [], sendBtns: [] };
    try { probe = JSON.parse((await client.evaluate({ target, expression: PROBE })).value); } catch (e) {}
    if (!pickCommentInput(probe)) { await client.wheelScroll({ target, x: 600, y: 500, totalDeltaY: 420 }).catch(() => {}); await sleep(rand(700, 1300)); try { probe = JSON.parse((await client.evaluate({ target, expression: PROBE })).value); } catch (e) {} }
    const input = pickCommentInput(probe);
    if (!input) return { ok: false, msg: '没定位到笔记底部评论框' };
    if (dry) return { ok: true, msg: '演练:已定位评论框(未发送)' };
    if (shouldStop()) return { ok: false, stopped: true, msg: 'machine_stopped' };
      const access = await recoverInteractiveAccess({ client, target, onLog });
      if (!access.ok && !access.allowWriteProbe) {
        return { ok: false, accountBlocked: true, msg: access.reason || '账号需要人工登录/验证' };
    }
    uncertainAccess = !access.ok;
    if (access.recovered) {
      try { probe = JSON.parse((await client.evaluate({ target, expression: PROBE })).value); } catch (e) { probe = { inputs: [], sendBtns: [] }; }
    }
    if (uncertainAccess) onLog(access.reason + '；只尝试写入目标评论框，写入校验成功才会点发送');
    const activeInput = pickCommentInput(probe);
    if (!activeInput) return { ok: false, msg: '页面恢复后没有重新定位到笔记评论框' };
    if (normalizeText(activeInput.text)) return { ok: false, msg: '评论框已有未发送内容,为避免误发已跳过' };
    await client.click({ target, x: activeInput.x, y: activeInput.y });
    await sleep(rand(700, 1300));
    await client.typeText({ target, text: comment });
    await sleep(rand(1200, 2000));
    if (shouldStop()) return { ok: false, stopped: true, msg: 'machine_stopped_before_send' };
    let probe2 = { inputs: [], sendBtns: [] };
    try { probe2 = JSON.parse((await client.evaluate({ target, expression: PROBE })).value); } catch (e) {}
    if (!inputHasExpectedText(pickCommentInput(probe2), comment)) return { ok: false, msg: uncertainAccess ? '写入探测未通过，登录浮层/限制仍在，未点发送' : '文字没有进入目标评论框,为避免点错已停止发送' };
    const btn = pickEnabledSendButton(probe2);
    if (!btn) return { ok: false, msg: '评论已输入但没找到发送按钮' };
    await client.click({ target, x: btn.x, y: btn.y });
    await sleep(1800);
    let okSent = false;
    try {
      const sentProbe = JSON.parse((await client.evaluate({ target, expression: PROBE })).value);
      const sentInput = pickCommentInput(sentProbe);
      okSent = sentProbe.success === true || (!!sentInput && !normalizeText(sentInput.text));
    } catch (e) {}
    if (okSent) {
      try { db.insertComment({ noteId: note.id, noteTitle: note.title, noteUrl: note.url, content: comment, status: 'sent' }); } catch (e) {}
      return { ok: true, msg: '已发送✓(已确认成功)' };
    }
    return { ok: false, msg: uncertainAccess ? '已尝试写入/发送，但登录状态仍不确定，本条不自动重试以免重复' : '点了发送但没确认成功(可能未登录/被拦)' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// 自动评论循环:采集→匹配→去重→逐条(限频闸门→生成→合规→打开评论关闭→拟人间隔)。默认演练。
// 承接一轮:进通知页抓「评论和@」→ 逐条判意向+回复(限频/批量上限)→ 回搜索页。dry=演练只定位+草稿。
async function drainInbox({ client, target, cfg, dry, send }) {
  // 自动承接是可随时关闭的总开关。运行中关闭后，在下一条互动前立刻退出，
  // 不再让通知页阻塞外呼主线；手动“开始承接”仍由用户主动触发。
  if (db.getConfig().reply_enabled === false) {
    send('log', '💬 自动承接已关闭，跳过通知处理，继续外呼。');
    return 0;
  }
  send('log', '📥 发现通知,暂停外呼,先去回复…');
  let beforeInboxUrl = '';
  try { beforeInboxUrl = String((await client.evaluate({ target, expression: 'location.href' })).value || ''); } catch (e) {}
  const returnUrl = inboxUtils.resolvePostInboxReturnUrl(beforeInboxUrl) || engine.buildSearchUrl(parseKeywords(cfg.task_keyword)[0]);
  const items = await engine.scanInbox({ client, target, max: 40, recentDays: Number(cfg.reply_recent_days) || 0, onLog: (m) => send('log', '  ' + m) });
  let replied = 0;
  let accountBlocked = false;
  const seenThisRun = new Set();
  const batchMax = Number(cfg.reply_batch_max) || 5;
  const dailyCap = Number(cfg.reply_daily) || 30;
  if (!items.length) { send('log', '  近 ' + (Number(cfg.reply_recent_days) || 0) + ' 天内没有新评论可回(更早的按"只回近N天"略过)'); }
  for (const it of items) {
    if (db.getConfig().reply_enabled === false) {
      send('log', '💬 自动承接已关闭，本轮通知处理结束，回到外呼。');
      break;
    }
    if (runState.cancelled) break;
    const prepared = inboxUtils.prepareInboxItem({ type: it.type, nick: it.nick, user_link: it.link, content: it.content, basis_text: it.basis_text, raw_text: it.raw_text, action_date: it.date, note_url: it.note_url, source_key: it.source_key });
    const intent = engine.inboxIntent(prepared.content, cfg);
    const key = prepared.event_key;
    if (seenThisRun.has(key)) { send('log', '  跳过 ' + prepared.nick + '(本轮重复通知)'); continue; }
    seenThisRun.add(key);
    const timeWhy = inboxTimeSkipReason(prepared, cfg);
    const preSkip = prepared.skip_reason || timeWhy;
    try { db.insertInbox({ ...prepared, intent, status: preSkip ? 'skipped' : 'new', skip_reason: preSkip }); } catch (e) {}
    const row = db.findInboxByEventKey(key);
    if (row && row.status !== 'new') { send('log', '  跳过 ' + prepared.nick + '(' + (row.skip_reason || row.fail_reason || '之前已处理过') + ')'); continue; }
    if (db.hasRecentInboxReply(prepared, 7)) {
      db.updateInboxByKey(key, { status: 'skipped', intent, skip_reason: '同一用户同一内容近期已回复' });
      send('log', '  跳过 ' + prepared.nick + '(同一用户同一内容近期已回复)');
      continue;
    }
    if (!engine.shouldReply(prepared, cfg)) {
      let why = '不符承接规则';
      if (prepared.skip_reason) why = prepared.skip_reason;
      else if ((cfg.reply_black_words || []).some((w) => prepared.content.indexOf(w) >= 0)) why = '命中黑词';
      else if (cfg.reply_only_intent && intent === 'other') why = '没意向词(已开"只回有意向")';
      else why = '该类型未在承接范围勾选';
      db.updateInboxByKey(key, { status: 'skipped', intent, skip_reason: why });
      send('log', '  跳过 ' + prepared.nick + '(' + why + ')');
      continue;
    }
    if (db.repliedToday() >= dailyCap) { send('log', '  今日回复达上限 ' + dailyCap + ',停止承接'); break; }
    if (replied >= batchMax) { send('log', '  本轮已回 ' + batchMax + ' 条,先回外呼'); break; }
    if (replied > 0) await sleep(dry ? rand(1500, 3000) : rand((cfg.reply_gap_min || 1) * 60000, (cfg.reply_gap_max || 4) * 60000));
    const text = await engine.makeReply(prepared, cfg);
    send('log', (dry ? '  [演练] ' : '  ') + '回复 ' + (prepared.nick || '') + ':' + text);
    let uncertainAccess = false;
    if (!dry) {
      const access = await recoverInteractiveAccess({ client, target, onLog: (message) => send('log', '  ' + message) });
      if (!access.ok && !access.allowWriteProbe) {
        send('log', '  ⚠ ' + (access.reason || '账号需要人工登录/验证') + '，已停止本账号真发');
        accountBlocked = true;
        break;
      }
      uncertainAccess = !access.ok;
      if (uncertainAccess) send('log', '  ' + access.reason + '；先精确写入这条回复，校验通过才点发送');
    }
    const r = await engine.replyInboxItem({ client, target, item: prepared, text, dry });
    send('log', '  ' + (r.ok ? '✓ ' : '✗ ') + r.msg);
    if (r.ok && !dry) {
      db.updateInboxByKey(key, { status: 'replied', reply_text: text, intent, replied_at: new Date().toISOString() });
      replied++;
      if (intent !== 'other') { try { db.insertLead({ note_id: '', nickname: prepared.nick, question: prepared.content, city: '' }); } catch (e) {} }
    } else if (dry) {
      db.updateInboxByKey(key, { reply_text: text, intent }); // 演练:存草稿,状态留 new
    } else {
      db.updateInboxByKey(key, { status: 'failed', fail_reason: r.msg, intent });
    }
  }
  if (accountBlocked) {
    if (machine.running) machine.running = false;
    send('log', '🛡 已保留当前安全验证页面，不再刷新或跳转，请人工处理后重新开始');
    return replied;
  }
  send('log', '📥 承接完成(本轮回复 ' + replied + ' 条),回到主线页面');
  await client.navigate({ target, url: returnUrl });
  for (let k = 0; k < 12; k++) { await sleep(1000); try { const rs = await client.evaluate({ target, expression: 'document.readyState' }); if (rs && rs.value === 'complete') break; } catch (e) {} }
  await sleep(rand(2000, 3500));
  return replied;
}

// ════════ 常驻机器:总开关 + 循环 + 日志广播(关网页不停,只有点停止才停)════════
const logBus = { buffer: [], clients: new Set() };
function _ts() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function emitLog(msg) {
  const line = { t: _ts(), m: String(msg) };
  logBus.buffer.push(line); if (logBus.buffer.length > 800) logBus.buffer.shift();
  for (const res of logBus.clients) { try { res.write('event: log\ndata: ' + JSON.stringify(line) + '\n\n'); } catch (e) {} }
}
function emitEvent(type, data) { for (const res of logBus.clients) { try { res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {} } }
function busSend(type, data) { if (type === 'log') emitLog(data); else emitEvent(type, data); }

const OUTBOUND_FRESH_BATCH_SIZE = 8;
const machine = { running: false, phase: 'idle', client: null, target: null, targets: [], lastScan: 0, lastInboxCheck: 0, sent: 0, replied: 0, done: 0, keywordIndex: 0, keywordTotal: 0, keywordSignature: '', scanCycleActive: false, scanSeen: new Set(), keywordCollected: new Map(), scanCollected: 0, runId: null, retrySourceRunId: 0, retryIdsByKeyword: new Map(), retryTotal: 0, retryScanComplete: false };
const processedOutboundLeads = new Set();
function machineStatus() { return { running: machine.running, phase: machine.phase, live: db.getConfig().live_send === true, sent: machine.sent, replied: machine.replied, done: machine.done, keywordIndex: machine.keywordIndex, keywordTotal: machine.keywordTotal, runId: machine.runId }; }
function resetMachineConnection() { machine.client = null; machine.target = null; }
function isCdpConnectionError(error) { return /cdp_|no_page_target/i.test(String(error && error.message || error || '')); }
function emitRunStats() { emitEvent('run-stats', db.taskRunReport(machine.runId)); }
function setTaskWakeLock(active) {
  // 多账号时每个工作进程把唤醒状态汇报给 Electron 主进程，由主进程按
  // “任一账号在跑”统一保持唤醒。单账号/开发模式仍保留原事件路径。
  if (typeof process.send === 'function') process.send({ type: 'xhs:task-wake-lock', accountId: ACCOUNT_ID, active: !!active });
  else process.emit('xhs:task-wake-lock', !!active);
}
function startMachine({ retryRunId = 0 } = {}) {
  if (machine.running) return false;
  const cfg = db.getConfig();
  const failed = retryRunId ? db.listFailedTaskRunDecisions(retryRunId) : [];
  if (retryRunId && !failed.length) return false;
  resetMachineConnection(); machine.running = true; machine.phase = 'starting'; machine.targets = []; machine.lastScan = 0; machine.lastInboxCheck = 0; machine.sent = 0; machine.replied = 0; machine.done = 0; machine.keywordIndex = 0; machine.keywordTotal = 0; machine.keywordSignature = ''; machine.scanCycleActive = false; machine.scanSeen = new Set(); machine.keywordCollected = new Map(); machine.scanCollected = 0;
  machine.retrySourceRunId = retryRunId ? Number(retryRunId) : 0;
  machine.retryIdsByKeyword = new Map();
  for (const item of failed) {
    if (!machine.retryIdsByKeyword.has(item.keyword)) machine.retryIdsByKeyword.set(item.keyword, new Set());
    machine.retryIdsByKeyword.get(item.keyword).add(String(item.note_id));
  }
  machine.retryTotal = new Set(failed.map((item) => String(item.note_id))).size;
  machine.retryScanComplete = false;
  machine.runId = db.createTaskRun({ live: cfg.live_send === true }); setTaskWakeLock(true); emitEvent('status', machineStatus()); emitRunStats(); machineLoop(machine.runId); return true;
}
function stopMachine() { if (!machine.running) return; machine.running = false; emitLog('⏹ 收到停止,机器即将停下'); emitEvent('status', machineStatus()); }
function clearMachineCache() {
  if (machine.running) return false;
  if (lastRun) lastRun = Object.assign({}, lastRun, { results: [] });
  logBus.buffer.length = 0;
  machine.targets = [];
  machine.scanSeen = new Set();
  machine.keywordCollected = new Map();
  machine.scanCollected = 0;
  machine.keywordIndex = 0;
  machine.keywordTotal = 0;
  machine.keywordSignature = '';
  machine.sent = 0;
  machine.replied = 0;
  machine.done = 0;
  processedOutboundLeads.clear();
  return true;
}
async function _sleepI(ms) { const step = 1500; let w = 0; while (w < ms && machine.running) { await sleep(Math.min(step, ms - w)); w += step; } }

async function machineLoop(runId) {
  emitLog('▶ 机器已启动' + (db.getConfig().live_send === true ? '(🔴 真发)' : '(🟡 演练)'));
  if (machine.retrySourceRunId) emitLog(`重试任务:只处理第 ${machine.retrySourceRunId} 轮的 ${machine.retryTotal} 篇大模型失败笔记`);
  while (machine.running && machine.runId === runId) {
    try {
      await machineCycle();
    } catch (e) {
      if (engine.isAccountSecurityError(e)) {
        emitLog('🛡 小红书要求账号安全验证，任务已自动暂停，不再刷新或切换关键词');
        machine.running = false;
        emitEvent('status', machineStatus());
        try {
          const home = await engine.returnHomeFromSecurityPage({ client: machine.client, target: machine.target });
          if (home.ok) emitLog('已点击安全限制页的“返回首页”，任务仍保持暂停');
          else if (home.reason !== 'not_returnable_security_page') emitLog('未能安全返回首页，已保留当前限制页供人工处理');
        } catch (returnError) {
          emitLog('返回首页失败，已保留当前限制页供人工处理');
        }
        break;
      }
      if (engine.isSearchPageMismatchError(e)) {
        emitLog('⚠ 搜索页或关键词不对，任务已暂停；未采集当前页任何卡片');
        machine.running = false;
        emitEvent('status', machineStatus());
        break;
      }
      if (isCdpConnectionError(e)) resetMachineConnection();
      emitLog('⚠ 循环出错(自动继续):' + e.message);
      await sleep(8000);
    }
  }
  if (machine.runId !== runId) return;
  emitLog('■ 机器已停止'); machine.phase = 'idle'; db.finishTaskRun(runId); setTaskWakeLock(false); emitEvent('status', machineStatus()); emitRunStats();
}
async function _ensureConn() {
  if (machine.client && machine.target) return;
  emitLog('连接浏览器…');
  const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
  machine.client = client; machine.target = target;
  try { await client.installCursor({ target }); } catch (e) {}
}
async function machineCycle() {
  const cfg = db.getConfig();
  const dry = cfg.live_send !== true;
  await _ensureConn();
  const client = machine.client, target = machine.target;
  // ① 承接(承接排班 + 红点)——全程优先
  if (cfg.reply_enabled !== false && throttle.inReplyWindow(cfg)) {
    let due = false; try { due = await engine.hasUnread({ client, target }); } catch (e) {}
    if (!due && machine.lastInboxCheck && (Date.now() - machine.lastInboxCheck) > (Number(cfg.reply_check_minutes) || 5) * 60000) due = true;
    if (due) {
      machine.phase = 'reply'; emitEvent('status', machineStatus());
      try {
        machine.replied += (await drainInbox({ client, target, cfg, dry, send: busSend })) || 0;
      } catch (e) {
        if (engine.isAccountSecurityError(e)) throw e;
        emitLog('承接出错:' + e.message);
      }
      machine.lastInboxCheck = Date.now(); emitEvent('status', machineStatus());
    }
  }
  if (!machine.running) return;
  // ② 外呼(主排班 + 配额)
  if (!throttle.inWorkWindow(cfg)) { emitLog('外呼:不在排班时段,待命中(承接仍在线)…'); machine.phase = 'idle'; emitEvent('status', machineStatus()); await _sleepI(rand(45000, 90000)); return; }
  const gate = throttle.canComment({ ignoreGap: true });
  if (!gate.ok) {
    emitLog('外呼:' + gate.reason + (/上限|配额/.test(gate.reason) ? ',本时段歇,等下一节奏' : ''));
    machine.phase = 'idle'; emitEvent('status', machineStatus());
    await _sleepI(/上限|配额|休息日|时段/.test(gate.reason) ? rand(60000, 120000) : rand(20000, 40000)); return;
  }
  if (!machine.targets.length) {
    if (machine.retrySourceRunId && machine.retryScanComplete) {
      emitLog(`重试任务完成:共处理 ${machine.scanCollected}/${machine.retryTotal} 篇可从当前搜索页找回的历史失败笔记`);
      machine.running = false;
      return;
    }
    const rescanMs = (Number(cfg.rescan_minutes) || 15) * 60000;
    const sinceScan = Date.now() - machine.lastScan;
    if (!machine.scanCycleActive && machine.lastScan && sinceScan < rescanMs) {
      machine.phase = 'idle'; emitEvent('status', machineStatus());
      await _sleepI(Math.min(rescanMs - sinceScan, 30000));
      return;
    }
    machine.phase = 'search'; emitEvent('status', machineStatus());
    try {
      await _scanNextKeywordTargets(cfg);
    } catch (e) {
      if (engine.isAccountSecurityError(e)) throw e;
      if (engine.isSearchPageMismatchError(e)) throw e;
      if (isCdpConnectionError(e)) { resetMachineConnection(); emitLog('浏览器连接已失效,下一轮自动重连'); }
      emitLog('检索出错:' + e.message);
      await _sleepI(rand(20000, 40000));
      return;
    }
  }
  const t = machine.targets.shift();
  if (!t) {
    emitLog(machine.scanCycleActive ? '本关键词暂无合适目标,继续下一个关键词' : '本轮关键词已扫完,等待下一轮');
    machine.phase = 'idle'; emitEvent('status', machineStatus()); await _sleepI(rand(1200, 2600)); return;
  }
  machine.phase = 'comment'; emitEvent('status', machineStatus());
  await _processOutbound(cfg, t, dry);
  await _sleepI(rand(1500, 4000));
}
async function _scanNextKeywordTargets(cfg) {
  const client = machine.client, target = machine.target;
  const signature = parseKeywords(cfg.task_keyword).join('\u0000');
  if (!machine.scanCycleActive || machine.keywordSignature !== signature) {
    machine.keywordIndex = 0;
    machine.keywordSignature = signature;
    machine.scanCycleActive = true;
    machine.scanSeen = new Set();
    machine.keywordCollected = new Map();
    machine.scanCollected = 0;
  }
  const plan = keywordScanPlan(cfg.task_keyword, throttle.currentScanLimit(cfg), machine.keywordIndex);
  const retryIds = machine.retrySourceRunId ? machine.retryIdsByKeyword.get(plan.keyword) : null;
  if (machine.retrySourceRunId) plan.quota = retryIds ? retryIds.size : 0;
  machine.keywordTotal = plan.keywords.length;
  emitLog(`关键词 ${plan.index + 1}/${plan.keywords.length}: ${plan.keyword}(本词最多 ${plan.quota} 篇)`);
  const filters = { sort: cfg.task_sort, noteTime: cfg.task_note_time, noteType: cfg.task_note_type, noteRange: cfg.task_note_range };
  const searchLimit = machine.retrySourceRunId ? Math.max(40, Math.min(240, plan.quota * 3)) : plan.quota;
  const scanned = plan.quota > 0
    ? await engine.scanClean({ client, target, keyword: plan.keyword, maxNotes: searchLimit, onLog: (m) => emitLog(m), shouldStop: () => !machine.running, filters })
    : [];
  const alreadyCollected = Number(machine.keywordCollected.get(plan.keyword)) || 0;
  const remaining = Math.max(0, plan.quota - alreadyCollected);
  const notes = scanned.filter((note) => {
    const key = note && (note.id || note.url);
    if (!key || machine.scanSeen.has(key)) return false;
    if (retryIds && !retryIds.has(String(note.id))) return false;
    return true;
  }).slice(0, Math.min(OUTBOUND_FRESH_BATCH_SIZE, remaining));
  for (const note of notes) machine.scanSeen.add(note.id || note.url);
  const keywordCollected = alreadyCollected + notes.length;
  machine.keywordCollected.set(plan.keyword, keywordCollected);
  machine.scanCollected += notes.length;
  db.addTaskRunScan(machine.runId, plan.keyword, notes.length);
  const { tagged, targets, byIntent } = engine.prepareNotesForDetailClassification(notes, cfg);
  tagged.forEach((n) => { try { db.upsertNote(n); } catch (e) {} });
  // 检索页只有标题；不能再按标题或评论数提前过滤。每篇都打开详情读取正文后分类。
  machine.targets = targets.map((t) => Object.assign({}, t, { classificationPending: true, sourceKeyword: plan.keyword }));
  const keywordComplete = keywordCollected >= plan.quota || notes.length === 0;
  machine.keywordIndex = keywordComplete ? plan.index + 1 : plan.index;
  if (!keywordComplete) emitLog(`本批先处理 ${notes.length} 篇，${plan.keyword}已累计 ${keywordCollected}/${plan.quota} 篇，处理完立即刷新当前列表`);
  if (keywordComplete && machine.keywordIndex >= plan.keywords.length) {
    machine.keywordIndex = 0;
    machine.scanCycleActive = false;
    machine.lastScan = Date.now();
    emitLog(`本轮 ${plan.keywords.length} 个关键词已扫完,共采集 ${machine.scanCollected} 篇`);
    if (machine.retrySourceRunId) {
      emitLog(`重试扫描完成:找回 ${machine.scanCollected}/${machine.retryTotal} 篇历史失败笔记`);
      machine.retryScanComplete = true;
    }
  }
  emitEvent('stats', { total: notes.length, byIntent, targetCount: machine.targets.length });
  emitRunStats();
  emitLog('本关键词当前批次 ' + notes.length + ' 篇,' + formatCategoryCounts(byIntent) + ',全部打开详情读取标题+正文');
}

async function engageOpenNote({ client, target, note, detail, cfg, dry, log, result, shouldStop = () => false }) {
  let sent = 0, done = 0, accountBlocked = false;
  if (shouldStop()) return { sent, done, stopped: true };
  const merged = Object.assign({}, note, {
    title: (detail && detail.title) || note.title || '',
    author: (detail && detail.author) || note.author || '',
    tags: (detail && detail.tags) || [],
    desc: (detail && detail.desc) || ''
  });
  const authorDecision = await engine.classifyDetailedNote(merged, cfg);
  log(`${authorDecision.classificationMethodLabel}分类:${authorDecision.label} / 地区${authorDecision.locationMatch} / 置信度${Math.round(authorDecision.confidence * 100)}% —— ${authorDecision.decisionReason}`);
  log('正文提取:' + formatClassificationFacts(authorDecision));
  if (authorDecision.evidence) log('分类依据:' + authorDecision.evidence);
  if (authorDecision.error) log('模型调用异常:' + authorDecision.error + '；为避免误评，作者不会评论');
  const classifiedNote = Object.assign({}, merged, {
    intent: authorDecision.categoryName,
    category_id: authorDecision.categoryId,
    category_name: authorDecision.categoryName,
    category_action: authorDecision.categoryAction,
    category_reply_strategy: authorDecision.categoryReplyStrategy
  });
  try { db.upsertNote(classifiedNote); } catch (e) {}
  if (authorDecision.locationMatch === 'mismatch') {
    const locationJudge = authorDecision.classificationMethod === 'llm' ? '大模型地区诊断' : '关键词地区规则';
    log(`整篇跳过:${locationJudge}判定不属于当前房源服务区`);
    return { sent, done, decision: authorDecision };
  }
  if (engine.shouldCommentNoteAuthor(authorDecision)) {
    let already = false; try { already = db.hasCommented(note.id); } catch (e) {}
    if (!already) {
      const text = String(cfg.outreach_fixed_text || '').trim() || await engine.makeComment(classifiedNote, cfg.task_direction || '', cfg);
      if (engine.check(text).ok) {
        log((dry ? '[草稿] ' : '') + '作者有需求，顶层评论:' + text);
        if (shouldStop()) return { sent, done, stopped: true };
        const response = await commentOnOpenNote({ client, target, note, comment: text, dry, onLog: (m) => log('  ' + m), shouldStop });
        result({ targetType: 'author', nick: merged.author || '', content: merged.desc || merged.title, text, response });
        log((response.ok ? '✓ ' : '✗ ') + response.msg);
        done++;
        if (response.ok && !dry) sent++;
        if (response.accountBlocked) return { sent, done, decision: authorDecision, accountBlocked: true };
      }
    }
  } else {
    log('作者跳过:' + authorDecision.decisionReason + '；仅触达已确认的求租笔记作者');
  }

  const inspectCommenters = engine.shouldInspectNoteCommenters(authorDecision, cfg);
  // 默认只读求租笔记评论区。用户可额外开启“房源/同行笔记评论区线索”开关，
  // 但始终不评论这类笔记的作者本人，只逐条筛选评论里的明确求租者。
  if (!inspectCommenters) {
    log('评论区跳过:当前只处理求租笔记；房源/同行笔记下的求租评论者开关未开启或地区不匹配。');
    return { sent, done, decision: authorDecision };
  }

  const evaluatedCommenters = ((detail && detail.commentsList) || [])
    .map((item) => {
      const decision = engine.commenterLeadDecision({
        content: item.content, nickname: item.nick, parentNote: merged, parentDecision: authorDecision, cfg
      });
      const area = engine.serviceAreaDecision(item.content, cfg);
      if (decision.eligible && authorDecision.locationMatch === 'unknown' && area.locationMatch !== 'match') {
        return Object.assign({}, item, { decision: { eligible: false, reason: '笔记及留言均未确认服务区域' } });
      }
      return Object.assign({}, item, { decision });
    });
  evaluatedCommenters
    .filter((item) => !item.decision.eligible && /^非目标受众：/.test(item.decision.reason || ''))
    .forEach((item) => log('评论者跳过:' + (item.nick || '未知用户') + ' / ' + item.decision.reason));
  const leads = evaluatedCommenters
    .filter((item) => item.decision.eligible && item.can_auto_reply !== false)
    .slice(0, Number(cfg.comment_leads_per_note) || 3);
  log((engine.shouldCommentNoteAuthor(authorDecision) ? '求租笔记' : '房源/同行笔记') + '评论区识别到明确或上下文需求 ' + leads.length + ' 条');
  for (const item of leads) {
    if (shouldStop()) break;
    const key = [note.id, item.user_link || item.nick, item.content].join('|');
    if (processedOutboundLeads.has(key)) { log('评论者跳过(本次已处理):' + item.nick); continue; }
    processedOutboundLeads.add(key);
    const prepared = { type: 'comment', nick: item.nick, content: item.content, basis_text: '来自《' + (note.title || '无标题') + '》评论区', can_auto_reply: true };
    const text = String(cfg.outreach_fixed_text || '').trim() || await engine.makeReply(prepared, cfg);
    if (!engine.check(text).ok) { log('评论者跳过(文案合规不过):' + item.nick); continue; }
    if (!dry) {
      const gate = throttle.canComment({ ignoreGap: true });
      if (!gate.ok) { log('评论区回复停止:' + gate.reason); break; }
    }
    log((dry ? '[草稿] ' : '') + '回复求租评论者 ' + item.nick + ':' + text);
    if (!dry) {
      const access = await recoverInteractiveAccess({ client, target, onLog: (message) => log('  ' + message) });
      if (!access.ok && !access.allowWriteProbe) {
        log('⚠ ' + (access.reason || '账号需要人工登录/验证') + '，已停止本账号真发');
        accountBlocked = true;
        break;
      }
      if (!access.ok) log('  ' + access.reason + '；先精确写入这条回复，校验通过才点发送');
    }
    const response = await engine.replyOpenNoteComment({ client, target, item, text, dry, shouldStop });
    result({ targetType: 'commenter', nick: item.nick, content: item.content, text, response });
    log((response.ok ? '✓ ' : '✗ ') + response.msg);
    done++;
    if (response.ok && !dry) {
      sent++;
      try { db.insertComment({ noteId: note.id + ':reply:' + (item.user_link || item.nick) + ':' + item.content.slice(0, 16), noteTitle: note.title, noteUrl: note.url, content: text, status: 'sent' }); } catch (e) {}
    }
  }
  return { sent, done, decision: authorDecision, accountBlocked };
}

async function _processOutbound(cfg, t, dry) {
  if (!machine.running) return;
  const client = machine.client, target = machine.target;
  const browse = { imagesMin: cfg.browse_images_min, imagesMax: cfg.browse_images_max, bodyMin: cfg.browse_body_dwell_min, bodyMax: cfg.browse_body_dwell_max, cScrollMin: cfg.browse_comment_scrolls_min, cScrollMax: cfg.browse_comment_scrolls_max, cDwellMin: cfg.browse_comment_dwell_min, cDwellMax: cfg.browse_comment_dwell_max };
  try {
    await engine.readDetail({ client, target, note: t, browse, onLog: (m) => emitLog('  ' + m), shouldStop: () => !machine.running, onBeforeClose: async ({ detail }) => {
      if (!machine.running) return;
      const totals = await engageOpenNote({ client, target, note: t, detail, cfg, dry, shouldStop: () => !machine.running, log: (m) => emitLog('  ' + m), result: (lead) => emitEvent('result', { id: t.id, url: t.url, title: t.title || '无标题', target_type: lead.targetType, nickname: lead.nick, source_content: lead.content, comment: lead.text, ok: lead.response.ok, dry }) });
      machine.done += totals.done;
      machine.sent += totals.sent;
      if (totals.accountBlocked) {
        emitLog('⚠ 检测到真实账号安全限制，已暂停这个账号，等人工验证后再开始');
        machine.running = false;
      }
      if (totals.decision) db.recordTaskRunDecision({ runId: machine.runId, keyword: t.sourceKeyword || '未标记关键词', note: t, decision: totals.decision, replyCount: totals.sent });
      emitEvent('status', machineStatus());
      emitRunStats();
    } });
  } catch (e) { if (isCdpConnectionError(e)) resetMachineConnection(); emitLog('  跳过:' + e.message); }
}

async function handleAutoRun(req, res, q) {
  const send = sse(res);
  runState = { running: true, cancelled: false };
  const cfg = db.getConfig();
  const dryParam = q.get('dry');
  const dry = dryParam != null ? (dryParam !== '0') : (cfg.auto_send_dry_run !== false);
  try {
    send('log', dry ? '🟡 自动评论 · 演练模式(走完整流程,不真发)' : '🔴 自动评论 · 真发模式(会真的发评论!)');
    send('phase', { phase: 'search' });
    const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
    lastRun = { client, target, results: [] };
    try { await client.installCursor({ target }); } catch (e) {}
    const filters = { sort: cfg.task_sort, noteTime: cfg.task_note_time, noteType: cfg.task_note_type, noteRange: cfg.task_note_range };
    const notes = await scanKeywords({ client, target, keywordText: cfg.task_keyword, maxNotes: throttle.currentScanLimit(cfg), onLog: (m) => send('log', m), shouldStop: () => runState.cancelled, filters });
    if (runState.cancelled) { send('log', '⏹ 已停止'); send('done', { stopped: true }); res.end(); runState.running = false; return; }
    send('phase', { phase: 'match' });
    const { tagged, targets, byIntent } = engine.prepareNotesForDetailClassification(notes, cfg);
    tagged.forEach((n) => { try { db.upsertNote(n); } catch (e) {} });
    const fresh = targets.map((t) => Object.assign({}, t, { classificationPending: true }));
    send('stats', { total: notes.length, byIntent, targetCount: fresh.length });
    send('log', '全部 ' + fresh.length + ' 篇先读取标题+正文，再按获客模型开关使用' + (engine.isLlmNoteClassificationEnabled(cfg) ? '大模型' : '关键词') + '分类');
    send('phase', { phase: 'generate' });
    let sent = 0, done = 0, lastInboxCheck = 0;
    for (const t of fresh) {
      if (runState.cancelled) { send('log', '⏹ 已停止'); break; }
      // 承接第一优先级:每篇前先「看」通知红点(纯读 DOM,不动鼠标),有未读就插队回复再回外呼
      if (cfg.reply_enabled !== false) {
        let due = false;
        try { due = await engine.hasUnread({ client, target }); } catch (e) {}
        if (!due && lastInboxCheck && (Date.now() - lastInboxCheck) > (Number(cfg.reply_check_minutes) || 5) * 60000) due = true;
        if (due) { try { await drainInbox({ client, target, cfg, dry, send }); } catch (e) { send('log', '承接出错(忽略):' + e.message); } }
        lastInboxCheck = Date.now();
      }
      if (runState.cancelled) { send('log', '⏹ 已停止'); break; }
      const gate = throttle.canComment({ ignoreGap: true }); // 不卡固定间隔,浏览本身就是自然间隔
      if (!gate.ok) {
        send('log', '⛔ ' + gate.reason);
        if (/休息日|不在.*时段|今日.*上限|配额.*用完/.test(gate.reason)) { send('log', '今日/本时段配额到顶,自动停。'); break; }
        send('log', '…' + gate.reason + ',跳过这条'); continue;
      }
      const browse = { imagesMin: cfg.browse_images_min, imagesMax: cfg.browse_images_max, bodyMin: cfg.browse_body_dwell_min, bodyMax: cfg.browse_body_dwell_max, cScrollMin: cfg.browse_comment_scrolls_min, cScrollMax: cfg.browse_comment_scrolls_max, cDwellMin: cfg.browse_comment_dwell_min, cDwellMax: cfg.browse_comment_dwell_max };
      try {
        // 一次访问：正文作者与评论区留言分别判断、分别触达。
        await engine.readDetail({ client, target, note: t, browse, onLog: (m) => send('log', '  ' + m), onBeforeClose: async ({ detail }) => {
          const totals = await engageOpenNote({ client, target, note: t, detail, cfg, dry,
            log: (m) => send('log', '  ' + m),
            result: (lead) => send('result', { id: t.id, url: t.url, title: t.title || '无标题', target_type: lead.targetType, nickname: lead.nick, source_content: lead.content, comment: lead.text, ok: lead.response.ok, dry })
          });
          done += totals.done;
          sent += totals.sent;
        } });
      } catch (e) { send('log', '  跳过:' + e.message); }
      await sleep(rand(1200, 3500)); // 去下一篇前的自然小停(不再强制几分钟)
    }
    send('done', { sent: sent, done: done, dry: dry });
  } catch (e) {
    send('log', '✗ 出错:' + e.message);
    send('done', { error: e.message });
  }
  runState.running = false;
  res.end();
}

async function handleConfig(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try { res.end(JSON.stringify({ ok: true, config: db.getConfig() })); } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}
async function handleRunStats(req, res, q) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try { res.end(JSON.stringify({ ok: true, ...db.taskRunReport(q.get('run_id') || machine.runId) })); }
  catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

// 用户手动恢复右侧小红书页面。刷新是明确的人工操作，安全限制时系统仍不会自动刷新。
async function handleBrowserRefresh(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  let paused = false;
  try {
    if (machine.running) { stopMachine(); paused = true; }
    if (runState.running) { runState.cancelled = true; paused = true; }
    // 给当前操作一个很短的停止窗口，再由用户发起普通刷新。
    await sleep(350);
    const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
    await client.sendCommand({ target, method: 'Page.reload', params: { ignoreCache: false }, timeoutMs: 10000 });
    resetMachineConnection();
    emitLog((paused ? '任务已暂停；' : '') + '已手动刷新右侧小红书页面');
    res.end(JSON.stringify({ ok: true, paused, msg: paused ? '任务已暂停，小红书页面已刷新' : '小红书页面已刷新', status: machineStatus() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, msg: e && e.message ? e.message : String(e), status: machineStatus() }));
  }
}

const server = http.createServer(async (req, res) => {
  // 控制台切换账号时会请求另一个本地账号服务。仅限本机端口，开放 CORS
  // 让 EventSource 和 fetch 可以无刷新切换，绝不对外网监听。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }
  if (u.pathname === '/api/run') { await handleRun(req, res, u.searchParams); return; }
  if (u.pathname === '/api/auto-run') { await handleAutoRun(req, res, u.searchParams); return; }
  if (u.pathname === '/api/send') { await handleSend(req, res, u.searchParams); return; }
  if (u.pathname === '/api/screencast') { await handleScreencast(req, res); return; }
  if (u.pathname === '/api/click') { await handleClick(req, res, u.searchParams); return; }
  if (u.pathname === '/api/records') { await handleRecords(req, res, u.searchParams); return; }
  if (u.pathname === '/api/inbox-scan') { await handleInboxScan(req, res, u.searchParams); return; }
  if (u.pathname === '/api/inbox-list') { await handleInboxList(req, res, u.searchParams); return; }
  if (u.pathname === '/api/inbox-run') { await handleInboxRun(req, res, u.searchParams); return; }
  if (u.pathname === '/api/engine/start') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, started: startMachine(), status: machineStatus() })); return; }
  if (u.pathname === '/api/engine/retry-failed') { const retryRunId = Number(u.searchParams.get('run_id')) || 0; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, started: startMachine({ retryRunId }), status: machineStatus() })); return; }
  if (u.pathname === '/api/engine/stop') { stopMachine(); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, status: machineStatus() })); return; }
  if (u.pathname === '/api/browser/refresh') { await handleBrowserRefresh(req, res); return; }
  if (u.pathname === '/api/engine/clear-cache') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!clearMachineCache()) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, msg: '任务仍在运行，请先停止' })); return; }
    res.end(JSON.stringify({ ok: true, status: machineStatus() })); return;
  }
  if (u.pathname === '/api/engine/run-stats') { await handleRunStats(req, res, u.searchParams); return; }
  if (u.pathname === '/api/engine/status') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, status: machineStatus() })); return; }
  if (u.pathname === '/api/engine/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    logBus.clients.add(res);
    for (const line of logBus.buffer) { res.write('event: log\ndata: ' + JSON.stringify(line) + '\n\n'); }
    res.write('event: status\ndata: ' + JSON.stringify(machineStatus()) + '\n\n');
    req.on('close', () => { logBus.clients.delete(res); });
    return;
  }
  if (u.pathname === '/api/login-status') { await handleLoginStatus(req, res); return; }
  if (u.pathname === '/api/trigger-login') { await handleTriggerLogin(req, res); return; }
  if (u.pathname === '/api/stop') { await handleStop(req, res); return; }
  if (u.pathname === '/api/cursor-install') { await handleCursorInstall(req, res); return; }
  if (u.pathname === '/api/config') { await handleConfig(req, res); return; }
  if (u.pathname === '/api/account') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, accountId: ACCOUNT_ID, port: PORT })); return; }
  if (u.pathname === '/api/throttle') { await handleThrottle(req, res); return; }
  if (u.pathname === '/api/save-config') { await handleSaveConfig(req, res, u.searchParams); return; }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`小红书获客 · 本地界面已启动 → http://localhost:${PORT}`));
