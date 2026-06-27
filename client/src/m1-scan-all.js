'use strict';

// 扫全部 —— 验证"把能搜到的都过一遍":持续滚动、懒加载、去重累积。
// 保守上限(防封 + 这是可行性验证):到 MAX_NOTES 或连续多轮无新增即停;每轮拟人停顿。
// 用法:node src/m1-scan-all.js "朝阳 租房"

const fs = require('node:fs');
const path = require('node:path');
const { XhsCdpClient } = require('./cdp/xhs-cdp-client');

const KEYWORD = process.argv[2] || '朝阳 租房';
const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const MAX_NOTES = Number(process.env.XHS_MAX_NOTES || 150);
const MAX_ROUNDS = Number(process.env.XHS_MAX_ROUNDS || 40);
const STALE_LIMIT = Number(process.env.XHS_STALE_LIMIT || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const ts = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log(`[${ts()}]`, ...a);

function pageProbe() {
  var c = document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]').length;
  return document.readyState + '|' + c;
}

function pageParse() {
  var anchors = Array.prototype.slice.call(
    document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]'));
  var seen = {}; var notes = [];
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var href = a.getAttribute('href') || '';
    var m = href.match(/\/(explore|search_result)\/([0-9a-zA-Z]+)/);
    if (!m) continue;
    var id = m[2]; if (seen[id]) continue; seen[id] = 1;
    var card = a.closest('section,.note-item,li,div[class*="note"]') || a.parentElement;
    var author = '';
    try { var ae = card && card.querySelector('.name,.author .name,.user-name,[class*="author"] [class*="name"]'); author = ae ? (ae.innerText || '').trim() : ''; } catch (e) {}
    var title = '';
    try { var te = card && card.querySelector('a[href*="/explore/"] .title,.title,[class*="title"]'); title = te ? (te.innerText || '').trim() : ''; } catch (e) {}
    if (title && author && title === author) title = '';
    var img = ''; try { var im = card && card.querySelector('img'); img = im ? (im.src || im.getAttribute('data-src') || '') : ''; } catch (e) {}
    var full = href.indexOf('http') === 0 ? href : (location.origin + (href.charAt(0) === '/' ? href : '/' + href));
    notes.push({ id: id, url: full, title: title, author: author, img: img });
  }
  return JSON.stringify(notes);
}

// 浅 dump __INITIAL_STATE__ 结构(找搜索 feeds 数组在哪),为 M1.5 干净取数铺路。
function probeState() {
  try {
    var s = window.__INITIAL_STATE__; if (!s) return JSON.stringify({ has: false });
    function shape(o, d) {
      if (d > 2 || !o || typeof o !== 'object') return typeof o;
      var out = {}; var ks = Object.keys(o).slice(0, 15);
      for (var i = 0; i < ks.length; i++) {
        var v = o[ks[i]];
        if (Array.isArray(v)) out[ks[i]] = 'Array(' + v.length + ')';
        else if (v && typeof v === 'object') out[ks[i]] = shape(v, d + 1);
        else out[ks[i]] = typeof v;
      }
      return out;
    }
    return JSON.stringify({ has: true, topKeys: Object.keys(s), search: s.search ? shape(s.search, 0) : null });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
}

const EXPR_PROBE = `(${pageProbe.toString()})()`;
const EXPR_PARSE = `(${pageParse.toString()})()`;
const EXPR_STATE = `(${probeState.toString()})()`;

async function main() {
  log('连接 CDP:', ENDPOINT, `| 上限 ${MAX_NOTES} 条 / ${MAX_ROUNDS} 轮`);
  const client = new XhsCdpClient({ endpoint: ENDPOINT });

  let target;
  try { target = await client.resolvePageTarget(); }
  catch (e) { log('✗ 找不到标签页,先 npm run launch 并登录。', e.message); process.exit(1); }
  log('已接管:', target.title || target.url);

  const searchUrl =
    `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(KEYWORD)}&source=web_search_result_notes`;
  log('搜索:', JSON.stringify(KEYWORD));
  await client.navigate({ target, url: searchUrl });

  let ready = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const r = await client.evaluate({ target, expression: EXPR_PROBE });
      const [rs, cnt] = String(r?.value || '').split('|');
      if (rs === 'complete' && Number(cnt) > 0) { ready = true; log(`就绪,首屏锚点 ${cnt}`); break; }
    } catch (e) {}
  }
  if (!ready) log('⚠ 未稳定就绪(需登录/改版?),仍尝试。');

  try {
    const st = await client.evaluate({ target, expression: EXPR_STATE });
    console.log('\n—— __INITIAL_STATE__ 结构(找 feeds) ——');
    console.log(st.value);
    console.log('');
  } catch (e) { log('state 探测失败:', e.message); }

  const all = new Map();
  let stale = 0, round = 0;
  for (round = 0; round < MAX_ROUNDS && stale < STALE_LIMIT && all.size < MAX_NOTES; round++) {
    let batch = [];
    try { const r = await client.evaluate({ target, expression: EXPR_PARSE }); batch = JSON.parse(r.value); }
    catch (e) { log('解析出错:', e.message); }
    const before = all.size;
    for (const n of batch) { if (!all.has(n.id)) all.set(n.id, n); }
    const added = all.size - before;
    log(`第 ${String(round + 1).padStart(2)} 轮:本屏 ${batch.length} 条,新增 ${added},累计 ${all.size}`);
    if (added === 0) stale++; else stale = 0;
    await client.evaluate({ target, expression: 'window.scrollBy(0, 900); "ok"' }).catch(() => {});
    await sleep(rand(1200, 2500)); // 拟人停顿
  }

  const reason = all.size >= MAX_NOTES ? `到达上限 ${MAX_NOTES} 条`
    : (stale >= STALE_LIMIT ? '连续多轮无新增(到底了)' : `到达轮数上限 ${MAX_ROUNDS}`);
  console.log(`\n===== 扫描结束:共 ${all.size} 条,滚动 ${round} 轮,停止原因:${reason} =====`);

  const list = [...all.values()];
  list.slice(0, 40).forEach((n, i) => {
    console.log(`${String(i + 1).padStart(3)}. ${n.title || '(无标题/图文)'}  · ${n.author || '?'}`);
  });
  if (list.length > 40) console.log(`… 其余 ${list.length - 40} 条已存入 JSON`);

  try {
    const outDir = path.join(__dirname, '..', 'tmp'); fs.mkdirSync(outDir, { recursive: true });
    const jf = path.join(outDir, `scan-${Date.now()}.json`);
    fs.writeFileSync(jf, JSON.stringify({ keyword: KEYWORD, count: all.size, rounds: round, reason, notes: list }, null, 2));
    log('已存数据:', jf);
    const img = await client.screenshot({ target });
    if (img) { const f = path.join(outDir, `scan-${Date.now()}.jpg`); fs.writeFileSync(f, Buffer.from(img, 'base64')); log('已存截图:', f); }
  } catch (e) { log('存档失败:', e.message); }

  console.log('');
  log(all.size > 30 ? '✓ 扫全部可行:能持续滚动加载、去重累积。' : '△ 抓取偏少,看上面诊断。');
  process.exit(0);
}

main().catch((e) => { console.error('未捕获错误:', e); process.exit(1); });
