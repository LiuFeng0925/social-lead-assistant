'use strict';

// 本地界面服务 —— 原生 http + SSE(实时推进度)。把引擎接上网页,浏览器打开即可用。
// 启动:node src/server.js  →  http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('./engine');
const { startScreencast } = require('./cdp/screencast');

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
const monitors = new Set(); // 实时监控的 SSE 推送函数
function broadcastPointer(p) { monitors.forEach((s) => { try { s('pointer', p); } catch (e) {} }); }

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleRun(req, res, q) {
  const keyword = q.get('keyword') || '朝阳 租房';
  const max = Number(q.get('max') || 40);
  const direction = q.get('direction') || '我是房源方,结合对方诉求友好回应,引导看主页/私聊,绝不留联系方式';
  const send = sse(res);
  try {
    send('log', '连接 CDP…');
    const { client, target } = await engine.connect(ENDPOINT, broadcastPointer);
    send('log', '已接管:' + (target.title || target.url));
    send('phase', { phase: 'search' });
    const notes = await engine.scanClean({ client, target, keyword, maxNotes: max, onLog: (m) => send('log', m) });
    send('phase', { phase: 'match' });
    const { targets, byIntent } = engine.matchNotes(notes);
    send('log', `匹配:${notes.length} 条 → 求租 ${byIntent['求租'] || 0} / 房源 ${byIntent['房源'] || 0} / 不明 ${byIntent['不明'] || 0};该评论 ${targets.length} 条`);
    send('stats', { total: notes.length, byIntent, targetCount: targets.length });
    send('phase', { phase: 'generate' });
    const results = [];
    const todo = targets.slice(0, DETAIL_N);
    for (let i = 0; i < todo.length; i++) {
      const t = todo[i];
      send('log', `读详情 + 生成 ${i + 1}/${todo.length}:${t.title || '(无标题)'}`);
      const d = await engine.readDetail({ client, target, url: t.url });
      const merged = { ...t, tags: d.tags || [], desc: d.desc || '' };
      const comment = engine.genComment(merged, direction);
      const comp = engine.check(comment);
      const agentReject = engine.rejectsAgent((d.title || '') + (d.desc || ''));
      const r = {
        index: i, id: t.id, url: t.url, title: t.title || '(无标题)', author: t.author, region: t.region,
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
    await client.navigate({ target, url: r.url });
    for (let k = 0; k < 12; k++) { await sleep(800); const rs = await client.evaluate({ target, expression: 'document.readyState' }); if (rs && rs.value === 'complete') break; }
    await sleep(1400);
    await client.evaluate({ target, expression: 'window.scrollBy(0,600);"ok"' }).catch(() => {});
    await sleep(900);
    const pr = await client.evaluate({ target, expression: PROBE });
    let probe; try { probe = JSON.parse(pr.value); } catch (e) { probe = { inputs: [], sendBtns: [] }; }
    if (!probe.inputs[0]) { res.end(JSON.stringify({ ok: false, msg: '没定位到评论框' })); return; }
    if (dry) { res.end(JSON.stringify({ ok: true, dry: true, msg: 'dry-run:已定位评论框(未发送)' })); return; }
    await client.click({ target, x: probe.inputs[0].x, y: probe.inputs[0].y });
    await sleep(rand(700, 1300));
    await client.typeText({ target, text: comment });
    await sleep(rand(1200, 2000));
    const pr2 = await client.evaluate({ target, expression: PROBE });
    let probe2; try { probe2 = JSON.parse(pr2.value); } catch (e) { probe2 = { sendBtns: [] }; }
    const btn = (probe2.sendBtns || [])[0] || (probe.sendBtns || [])[0];
    if (!btn) { res.end(JSON.stringify({ ok: false, msg: '评论已输入但没找到发送按钮' })); return; }
    await client.click({ target, x: btn.x, y: btn.y });
    await sleep(2000);
    res.end(JSON.stringify({ ok: true, dry: false, msg: '已发送 ✓(看浏览器确认评论已出现)' }));
  } catch (e) {
    res.end(JSON.stringify({ ok: false, msg: e.message }));
  }
}

async function handleScreencast(req, res) {
  const send = sse(res);
  monitors.add(send);
  let cast = null;
  try {
    let target = lastRun && lastRun.target;
    if (!target) { const c = await engine.connect(ENDPOINT, broadcastPointer); target = c.target; lastRun = lastRun || { client: c.client, target, results: [] }; }
    cast = await startScreencast({ target, endpoint: ENDPOINT, onFrame: (data, meta) => send('frame', { d: data, w: meta.deviceWidth || 0, h: meta.deviceHeight || 0 }) });
    send('hello', { ok: true });
  } catch (e) { send('hello', { ok: false, msg: e.message }); }
  req.on('close', () => { monitors.delete(send); if (cast) cast.stop(); });
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }
  if (u.pathname === '/api/run') { await handleRun(req, res, u.searchParams); return; }
  if (u.pathname === '/api/send') { await handleSend(req, res, u.searchParams); return; }
  if (u.pathname === '/api/screencast') { await handleScreencast(req, res); return; }
  if (u.pathname === '/api/click') { await handleClick(req, res, u.searchParams); return; }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`小红书获客 · 本地界面已启动 → http://localhost:${PORT}`));
