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
const { readLoginStatus } = require('./login-status');
const { openNoteFromList, closeCurrentNote } = require('./note-navigation');

const PORT = Number(process.env.XHS_UI_PORT || 3000);
const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const TMP = path.join(__dirname, '..', 'tmp');
const DETAIL_N = Number(process.env.XHS_DETAIL_N || 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

// 评论框 / 发送按钮定位(同 m4)
const PROBE = `(function(){
  function vis(r){ return r.width>40&&r.height>10&&r.bottom>0&&r.top<window.innerHeight; }
  var inputs=[]; var els=document.querySelectorAll('[contenteditable="true"],textarea,p[class*="content-input"],[class*="comment-input"]');
  for(var i=0;i<els.length;i++){ var e=els[i]; var r=e.getBoundingClientRect(); if(!vis(r))continue; inputs.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); }
  var btns=[]; var all=document.querySelectorAll('button,span,div');
  for(var j=0;j<all.length&&btns.length<6;j++){ var b=all[j]; var tx=(b.childElementCount===0?(b.innerText||''):'').trim(); if(tx==='发送'||tx==='发布'){ var br=b.getBoundingClientRect(); if(vis(br)) btns.push({x:Math.round(br.x+br.width/2),y:Math.round(br.y+br.height/2)}); } }
  return JSON.stringify({inputs:inputs.slice(0,4),sendBtns:btns});
})()`;

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
    const notes = await engine.scanClean({ client, target, keyword, filters, maxNotes: max, onLog: (m) => send('log', m), shouldStop: () => runState.cancelled });
    if (runState.cancelled) { send('log', '⏹ 任务已停止'); send('done', { stopped: true }); res.end(); runState.running = false; return; }
    send('phase', { phase: 'match' });
    const { tagged, targets, byIntent } = engine.matchNotes(notes);
    tagged.forEach((n) => { try { db.upsertNote(n); } catch (e) {} }); // 存采集历史(看过哪些笔记,带意向/地区)
    const fresh = targets.filter((t) => { try { return !db.hasCommented(t.id); } catch (e) { return true; } }); // 评过的跳过
    const skipped = targets.length - fresh.length;
    send('log', `匹配:${notes.length} 条 → 求租 ${byIntent['求租'] || 0} / 房源 ${byIntent['房源'] || 0} / 不明 ${byIntent['不明'] || 0};该评论 ${targets.length} 条${skipped ? `(已评过 ${skipped} 条自动跳过,剩 ${fresh.length})` : ''}`);
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
      const merged = { ...t, tags: d.tags || [], desc: d.desc || '' };
      const comment = await engine.makeComment(merged, direction, cfg);
      const comp = engine.check(comment);
      const agentReject = engine.rejectsAgent((d.title || '') + (d.desc || ''));
      const r = {
        index: i, id: t.id, url: t.url, title: t.title || '(无标题)', author: t.author, region: t.region,
        searchUrl: t.searchUrl,
        likes: t.likes, collects: t.collects, comments: t.comments, intent: t.intent, tags: d.tags || [],
        descSample: (d.desc || '').replace(/#[^#]*\[话题\]#/g, '').replace(/\s+/g, ' ').trim().slice(0, 80),
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
    await client.wheelScroll({ target, x: 600, y: 400, totalDeltaY: 600 }).catch(() => {}); // trusted 滚轮(拟人)
    await sleep(rand(900, 1600));
    const pr = await client.evaluate({ target, expression: PROBE });
    let probe; try { probe = JSON.parse(pr.value); } catch (e) { probe = { inputs: [], sendBtns: [] }; }
    if (!probe.inputs[0]) { await closeAndEnd({ ok: false, msg: '没定位到评论框' }); return; }
    // 登录检测:未登录直接拦住,绝不假发
    try { const st = await readLoginStatus(client, target); if (!st.loggedIn) { await closeAndEnd({ ok: false, msg: '⚠ 浏览器未登录小红书!请在右侧浏览器扫码登录,再发' }); return; } } catch (e) {}
    if (dry) { await closeAndEnd({ ok: true, dry: true, msg: 'dry-run:已定位评论框并关闭详情(未发送)' }); return; }
    // 防封限频:真发前先过 throttle(工作时间/今日上限/每小时/间隔)
    const gate = throttle.canComment();
    if (!gate.ok) { await closeAndEnd({ ok: false, msg: '⛔ 限频拦截:' + gate.reason }); return; }
    await client.click({ target, x: probe.inputs[0].x, y: probe.inputs[0].y });
    await sleep(rand(700, 1300));
    await client.typeText({ target, text: comment });
    await sleep(rand(1200, 2000));
    const pr2 = await client.evaluate({ target, expression: PROBE });
    let probe2; try { probe2 = JSON.parse(pr2.value); } catch (e) { probe2 = { sendBtns: [] }; }
    const btn = (probe2.sendBtns || [])[0] || (probe.sendBtns || [])[0];
    if (!btn) { await closeAndEnd({ ok: false, msg: '评论已输入但没找到发送按钮' }); return; }
    await client.click({ target, x: btn.x, y: btn.y });
    await sleep(1800);
    // 验证真的发出去了(评论成功提示 或 输入框被清空),不再盲目报成功
    let okSent = false;
    try {
      const vf = await client.evaluate({ target, expression: '(function(){var t=document.body.innerText.indexOf("评论成功")>=0;var b=document.querySelector("p[class*=content-input],div[contenteditable=true]");var empty=b?((b.innerText||"").trim().length===0):false;return (t||empty)?"ok":"no";})()' });
      okSent = vf && vf.value === 'ok';
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

async function handleRecords(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    res.end(JSON.stringify({ ok: true, stats: db.stats(), comments: db.listComments(100), notes: db.listNotes(120), leads: db.listLeads(60) }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

async function handleStop(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  runState.cancelled = true; // 引擎循环会在下一步检查到并中断
  res.end(JSON.stringify({ ok: true }));
}

// 承接 step1:刷新收件 = 进通知页抓「评论和@」→ 去重入库 → 返回列表+统计
async function handleInboxScan(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const cfg = db.getConfig();
    const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
    try { await client.installCursor({ target }); } catch (e) {}
    const items = await engine.scanInbox({ client, target, max: 40, recentDays: Number(cfg.reply_recent_days) || 0 });
    let added = 0;
    for (const it of items) {
      try { if (db.insertInbox({ type: it.type, nick: it.nick, user_link: it.link, content: it.content, action_date: it.date, status: 'new' })) added++; } catch (e) {}
    }
    res.end(JSON.stringify({ ok: true, scanned: items.length, added, items: db.listInbox(100), stats: db.inboxStats() }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}
async function handleInboxList(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try { res.end(JSON.stringify({ ok: true, items: db.listInbox(100), stats: db.inboxStats() })); }
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
    if (!dry) { let li = true; try { li = (await readLoginStatus(client, target)).loggedIn; } catch (e) {} if (!li) { send('log', '⚠ 未登录,真发停止'); send('done', { error: 'not_logged_in' }); res.end(); runState.running = false; return; } }
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
    let client, target;
    if (lastRun && lastRun.target) { client = lastRun.client; target = lastRun.target; }
    else { const c = await engine.connect(ENDPOINT, broadcastPointer); client = c.client; target = c.target; lastRun = { client, target, results: [] }; }
    const st = await readLoginStatus(client, target);
    res.end(JSON.stringify({ ok: true, loggedIn: st.loggedIn }));
  } catch (e) { res.end(JSON.stringify({ ok: false, msg: e.message })); }
}

async function handleTriggerLogin(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    let client, target;
    if (lastRun && lastRun.target) { client = lastRun.client; target = lastRun.target; }
    else { const c = await engine.connect(ENDPOINT, broadcastPointer); client = c.client; target = c.target; lastRun = { client, target, results: [] }; }
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
async function commentOnOpenNote({ client, target, note, comment, dry, onLog = () => {} }) {
  try {
    let probe = { inputs: [], sendBtns: [] };
    try { probe = JSON.parse((await client.evaluate({ target, expression: PROBE })).value); } catch (e) {}
    if (!probe.inputs[0]) { await client.wheelScroll({ target, x: 600, y: 500, totalDeltaY: 420 }).catch(() => {}); await sleep(rand(700, 1300)); try { probe = JSON.parse((await client.evaluate({ target, expression: PROBE })).value); } catch (e) {} }
    if (!probe.inputs[0]) return { ok: false, msg: '没定位到评论框' };
    if (dry) return { ok: true, msg: '演练:已定位评论框(未发送)' };
    try { const st = await readLoginStatus(client, target); if (!st.loggedIn) return { ok: false, msg: '未登录,跳过(绝不假发)' }; } catch (e) {}
    await client.click({ target, x: probe.inputs[0].x, y: probe.inputs[0].y });
    await sleep(rand(700, 1300));
    await client.typeText({ target, text: comment });
    await sleep(rand(1200, 2000));
    let probe2 = { sendBtns: [] };
    try { probe2 = JSON.parse((await client.evaluate({ target, expression: PROBE })).value); } catch (e) {}
    const btn = (probe2.sendBtns || [])[0] || (probe.sendBtns || [])[0];
    if (!btn) return { ok: false, msg: '评论已输入但没找到发送按钮' };
    await client.click({ target, x: btn.x, y: btn.y });
    await sleep(1800);
    let okSent = false;
    try {
      const vf = await client.evaluate({ target, expression: '(function(){var t=document.body.innerText.indexOf("评论成功")>=0;var b=document.querySelector("p[class*=content-input],div[contenteditable=true]");var empty=b?((b.innerText||"").trim().length===0):false;return (t||empty)?"ok":"no";})()' });
      okSent = vf && vf.value === 'ok';
    } catch (e) {}
    if (okSent) {
      try { db.insertComment({ noteId: note.id, noteTitle: note.title, noteUrl: note.url, content: comment, status: 'sent' }); } catch (e) {}
      return { ok: true, msg: '已发送✓(已确认成功)' };
    }
    return { ok: false, msg: '点了发送但没确认成功(可能未登录/被拦)' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// 自动评论循环:采集→匹配→去重→逐条(限频闸门→生成→合规→打开评论关闭→拟人间隔)。默认演练。
// 承接一轮:进通知页抓「评论和@」→ 逐条判意向+回复(限频/批量上限)→ 回搜索页。dry=演练只定位+草稿。
async function drainInbox({ client, target, cfg, dry, send }) {
  send('log', '📥 发现通知,暂停外呼,先去回复…');
  const items = await engine.scanInbox({ client, target, max: 40, recentDays: Number(cfg.reply_recent_days) || 0, onLog: (m) => send('log', '  ' + m) });
  let replied = 0;
  const batchMax = Number(cfg.reply_batch_max) || 5;
  const dailyCap = Number(cfg.reply_daily) || 30;
  if (!items.length) { send('log', '  近 ' + (Number(cfg.reply_recent_days) || 0) + ' 天内没有新评论可回(更早的按"只回近N天"略过)'); }
  for (const it of items) {
    if (runState.cancelled) break;
    const intent = engine.inboxIntent(it.content, cfg);
    const key = (it.nick || '') + '|' + (it.content || '') + '|' + (it.date || '');
    try { db.insertInbox({ type: it.type, nick: it.nick, user_link: it.link, content: it.content, action_date: it.date, intent, status: 'new', dedup_key: key }); } catch (e) {}
    const row = db.listInbox(300).find((r) => r.dedup_key === key);
    if (row && row.status !== 'new') { send('log', '  跳过 ' + it.nick + '(之前已处理过)'); continue; }
    if (!engine.shouldReply(it, cfg)) {
      let why = '不符承接规则';
      if (!it.content || it.content === '原评论已删除') why = '原评论已删/无内容';
      else if ((cfg.reply_black_words || []).some((w) => it.content.indexOf(w) >= 0)) why = '命中黑词';
      else if (cfg.reply_only_intent && intent === 'other') why = '没意向词(已开"只回有意向")';
      else why = '该类型未在承接范围勾选';
      db.updateInboxByKey(key, { status: 'skipped', intent });
      send('log', '  跳过 ' + it.nick + '(' + why + ')');
      continue;
    }
    if (db.repliedToday() >= dailyCap) { send('log', '  今日回复达上限 ' + dailyCap + ',停止承接'); break; }
    if (replied >= batchMax) { send('log', '  本轮已回 ' + batchMax + ' 条,先回外呼'); break; }
    const text = await engine.makeReply(it, cfg);
    send('log', (dry ? '  [演练] ' : '  ') + '回复 ' + (it.nick || '') + ':' + text);
    if (!dry) { let li = true; try { li = (await readLoginStatus(client, target)).loggedIn; } catch (e) {} if (!li) { send('log', '  未登录,停止真发承接'); break; } }
    const r = await engine.replyInboxItem({ client, target, item: it, text, dry });
    send('log', '  ' + (r.ok ? '✓ ' : '✗ ') + r.msg);
    if (r.ok && !dry) {
      db.updateInboxByKey(key, { status: 'replied', reply_text: text, intent, replied_at: new Date().toISOString() });
      replied++;
      if (intent !== 'other') { try { db.insertLead({ note_id: '', nickname: it.nick, question: it.content, city: '' }); } catch (e) {} }
    } else if (dry) {
      db.updateInboxByKey(key, { reply_text: text, intent }); // 演练:存草稿,状态留 new
    } else {
      db.updateInboxByKey(key, { status: 'failed', fail_reason: r.msg, intent });
    }
    await sleep(dry ? rand(1500, 3000) : rand((cfg.reply_gap_min || 1) * 60000, (cfg.reply_gap_max || 4) * 60000));
  }
  send('log', '📥 承接完成(本轮回复 ' + replied + ' 条),回到外呼');
  await client.navigate({ target, url: engine.buildSearchUrl(cfg.task_keyword || '朝阳 租房') });
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

const machine = { running: false, phase: 'idle', client: null, target: null, targets: [], lastScan: 0, lastInboxCheck: 0, sent: 0, replied: 0, done: 0 };
function machineStatus() { return { running: machine.running, phase: machine.phase, live: db.getConfig().live_send === true, sent: machine.sent, replied: machine.replied, done: machine.done }; }
function startMachine() { if (machine.running) return false; machine.running = true; machine.phase = 'starting'; machine.targets = []; machine.lastScan = 0; machine.lastInboxCheck = 0; emitEvent('status', machineStatus()); machineLoop(); return true; }
function stopMachine() { if (!machine.running) return; machine.running = false; emitLog('⏹ 收到停止,机器即将停下'); emitEvent('status', machineStatus()); }
async function _sleepI(ms) { const step = 1500; let w = 0; while (w < ms && machine.running) { await sleep(Math.min(step, ms - w)); w += step; } }

async function machineLoop() {
  emitLog('▶ 机器已启动' + (db.getConfig().live_send === true ? '(🔴 真发)' : '(🟡 演练)'));
  while (machine.running) {
    try { await machineCycle(); } catch (e) { emitLog('⚠ 循环出错(自动继续):' + e.message); await sleep(8000); }
  }
  emitLog('■ 机器已停止'); machine.phase = 'idle'; emitEvent('status', machineStatus());
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
      try { machine.replied += (await drainInbox({ client, target, cfg, dry, send: busSend })) || 0; } catch (e) { emitLog('承接出错:' + e.message); }
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
  if (!machine.targets.length || (Date.now() - machine.lastScan) > (Number(cfg.rescan_minutes) || 15) * 60000) {
    machine.phase = 'search'; emitEvent('status', machineStatus());
    try { await _rescanTargets(cfg); } catch (e) { emitLog('检索出错:' + e.message); await _sleepI(rand(20000, 40000)); return; }
  }
  const t = machine.targets.shift();
  if (!t) { emitLog('外呼:暂无新目标,等下一轮检索'); machine.phase = 'idle'; emitEvent('status', machineStatus()); await _sleepI(rand(30000, 60000)); return; }
  machine.phase = 'comment'; emitEvent('status', machineStatus());
  await _processOutbound(cfg, t, dry);
  await _sleepI(rand(1500, 4000));
}
async function _rescanTargets(cfg) {
  const client = machine.client, target = machine.target;
  const filters = { sort: cfg.task_sort, noteTime: cfg.task_note_time, noteType: cfg.task_note_type, noteRange: cfg.task_note_range };
  const notes = await engine.scanClean({ client, target, keyword: cfg.task_keyword || '朝阳 租房', maxNotes: throttle.currentScanLimit(cfg), onLog: (m) => emitLog(m), shouldStop: () => !machine.running, filters });
  const { tagged, targets, byIntent } = engine.matchNotes(notes);
  tagged.forEach((n) => { try { db.upsertNote(n); } catch (e) {} });
  machine.targets = targets.filter((t) => { try { return !db.hasCommented(t.id); } catch (e) { return true; } });
  machine.lastScan = Date.now();
  emitEvent('stats', { total: notes.length, byIntent, targetCount: machine.targets.length });
  emitLog('检索 ' + notes.length + ' 篇,求租 ' + targets.length + ',去重后待评 ' + machine.targets.length + ' 条');
}
async function _processOutbound(cfg, t, dry) {
  const client = machine.client, target = machine.target;
  const browse = { imagesMin: cfg.browse_images_min, imagesMax: cfg.browse_images_max, bodyMin: cfg.browse_body_dwell_min, bodyMax: cfg.browse_body_dwell_max, cScrollMin: cfg.browse_comment_scrolls_min, cScrollMax: cfg.browse_comment_scrolls_max, cDwellMin: cfg.browse_comment_dwell_min, cDwellMax: cfg.browse_comment_dwell_max };
  try {
    await engine.readDetail({ client, target, note: t, browse, onLog: (m) => emitLog('  ' + m), onBeforeClose: async ({ detail }) => {
      const merged = Object.assign({}, t, { tags: (detail && detail.tags) || [], desc: (detail && detail.desc) || '' });
      const comment = await engine.makeComment(merged, cfg.task_direction || '', cfg);
      if (!engine.check(comment).ok) { emitLog('  跳过(合规不过)'); return; }
      emitLog((dry ? '  [演练] ' : '  ') + '评论 → 《' + (t.title || '无标题') + '》:' + comment);
      const r = await commentOnOpenNote({ client, target, note: t, comment, dry, onLog: (m) => emitLog('    ' + m) });
      emitEvent('result', { id: t.id, url: t.url, title: t.title || '无标题', comment, intent: t.intent, region: t.region, ok: r.ok, dry: dry });
      emitLog('  ' + (r.ok ? '✓ ' : '✗ ') + r.msg);
      machine.done++;
      if (r.ok && !dry) { machine.sent++; emitEvent('status', machineStatus()); }
    } });
  } catch (e) { emitLog('  跳过:' + e.message); }
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
    let loggedIn = true; try { loggedIn = (await readLoginStatus(client, target)).loggedIn; } catch (e) {}
    if (!loggedIn && !dry) { send('log', '⚠ 浏览器未登录小红书,真发模式已停止(先扫码登录)'); send('done', { error: 'not_logged_in' }); res.end(); runState.running = false; return; }
    const filters = { sort: cfg.task_sort, noteTime: cfg.task_note_time, noteType: cfg.task_note_type, noteRange: cfg.task_note_range };
    const notes = await engine.scanClean({ client, target, keyword: cfg.task_keyword || '朝阳 租房', maxNotes: throttle.currentScanLimit(cfg), onLog: (m) => send('log', m), shouldStop: () => runState.cancelled, filters });
    if (runState.cancelled) { send('log', '⏹ 已停止'); send('done', { stopped: true }); res.end(); runState.running = false; return; }
    send('phase', { phase: 'match' });
    const { tagged, targets, byIntent } = engine.matchNotes(notes);
    tagged.forEach((n) => { try { db.upsertNote(n); } catch (e) {} });
    const fresh = targets.filter((t) => { try { return !db.hasCommented(t.id); } catch (e) { return true; } });
    send('stats', { total: notes.length, byIntent, targetCount: fresh.length });
    send('log', '求租目标 ' + targets.length + ',去重后待评 ' + fresh.length + ' 条');
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
        // 一次访问:打开 → 正常浏览(看图/读评论/正文停留)→ 浏览完遇匹配就评论 → 关闭
        await engine.readDetail({ client, target, note: t, browse, onLog: (m) => send('log', '  ' + m), onBeforeClose: async ({ detail }) => {
          const merged = Object.assign({}, t, { tags: (detail && detail.tags) || [], desc: (detail && detail.desc) || '' });
          const comment = await engine.makeComment(merged, cfg.task_direction || '', cfg);
          if (!engine.check(comment).ok) { send('log', '  跳过(合规不过)'); return; }
          send('log', (dry ? '  [演练] ' : '  ') + '评论:' + comment);
          const r = await commentOnOpenNote({ client, target, note: t, comment, dry, onLog: (m) => send('log', '    ' + m) });
          send('result', { id: t.id, url: t.url, title: t.title || '无标题', comment, intent: t.intent, region: t.region, ok: r.ok, dry: dry });
          send('log', '  ' + (r.ok ? '✓ ' : '✗ ') + r.msg);
          done++;
          if (r.ok && !dry) sent++;
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

const server = http.createServer(async (req, res) => {
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
  if (u.pathname === '/api/records') { await handleRecords(req, res); return; }
  if (u.pathname === '/api/inbox-scan') { await handleInboxScan(req, res); return; }
  if (u.pathname === '/api/inbox-list') { await handleInboxList(req, res); return; }
  if (u.pathname === '/api/inbox-run') { await handleInboxRun(req, res, u.searchParams); return; }
  if (u.pathname === '/api/engine/start') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, started: startMachine(), status: machineStatus() })); return; }
  if (u.pathname === '/api/engine/stop') { stopMachine(); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, status: machineStatus() })); return; }
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
  if (u.pathname === '/api/throttle') { await handleThrottle(req, res); return; }
  if (u.pathname === '/api/save-config') { await handleSaveConfig(req, res, u.searchParams); return; }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`小红书获客 · 本地界面已启动 → http://localhost:${PORT}`));
