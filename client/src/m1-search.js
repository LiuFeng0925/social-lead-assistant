'use strict';

// M1 · 接管浏览器 + 检索
// 流程:接管已登录 Chrome → 导航到小红书搜索页 → 等待渲染 → 滚动加载 → 解析第一屏笔记 → 打印 + 截图。
// 用法:node src/m1-search.js "朝阳 租房"
//
// 这一枪验证的是整个项目最大的未知数:"借真实页面的手取数,在小红书到底灵不灵"。
// 搜索结果是页面自己用 x-s/x-t 签名请求并渲染的,我们只读 DOM —— 不逆向签名。

const fs = require('node:fs');
const path = require('node:path');
const { XhsCdpClient } = require('./cdp/xhs-cdp-client');

const KEYWORD = process.argv[2] || '朝阳 租房';
const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ── 在页面里执行:探测就绪状态(readyState + 笔记锚点数) ──
function pageProbe() {
  var c = document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]').length;
  return document.readyState + '|' + c;
}

// ── 在页面里执行:解析搜索结果笔记 + 诊断信息 ──
function pageParse() {
  var diag = { url: location.href, title: document.title, readyState: document.readyState };
  diag.needLogin = /\/login/i.test(location.href) ||
    !!document.querySelector('.login-container,.login-box,[class*="signin"],[class*="login-modal"]');
  try { diag.hasInitialState = !!window.__INITIAL_STATE__; } catch (e) { diag.hasInitialState = false; }

  var anchors = Array.prototype.slice.call(
    document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]'));
  diag.anchorCount = anchors.length;

  var seen = {};
  var notes = [];
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var href = a.getAttribute('href') || '';
    var m = href.match(/\/(explore|search_result)\/([0-9a-zA-Z]+)/);
    if (!m) continue;
    var id = m[2];
    if (seen[id]) continue;
    seen[id] = 1;

    var card = a.closest('section,.note-item,li,div[class*="note"]') || a.parentElement;
    var pick = function (sel) {
      try { var el = card && card.querySelector(sel); return el ? (el.innerText || '').trim() : ''; }
      catch (e) { return ''; }
    };
    var title = pick('.title,[class*="title"]');
    var author = pick('.name,.author .name,.user-name,[class*="author"] [class*="name"]');
    var img = '';
    try { var im = card && card.querySelector('img'); img = im ? (im.src || im.getAttribute('data-src') || '') : ''; } catch (e) {}
    var snippet = '';
    try { snippet = ((card && card.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 100); } catch (e) {}
    var full = href.indexOf('http') === 0 ? href : (location.origin + (href.charAt(0) === '/' ? href : '/' + href));
    notes.push({ id: id, url: full, title: title, author: author, img: img, snippet: snippet });
  }
  diag.noteCount = notes.length;
  return JSON.stringify({ diag: diag, notes: notes.slice(0, 30) });
}

const EXPR_PROBE = `(${pageProbe.toString()})()`;
const EXPR_PARSE = `(${pageParse.toString()})()`;

async function main() {
  log('连接 CDP:', ENDPOINT);
  const client = new XhsCdpClient({ endpoint: ENDPOINT });

  let target;
  try {
    target = await client.resolvePageTarget();
  } catch (e) {
    log('✗ 找不到可用的浏览器标签页。');
    log('  请先用调试端口启动 Chrome 并登录小红书 —— 见 README(或 npm run launch)。');
    log('  详细:', e.message);
    process.exit(1);
  }
  log('已接管标签页:', target.title || target.url);

  const searchUrl =
    `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(KEYWORD)}&source=web_search_result_notes`;
  log('导航到搜索页,关键词:', JSON.stringify(KEYWORD));
  await client.navigate({ target, url: searchUrl });

  log('等待页面渲染…');
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const r = await client.evaluate({ target, expression: EXPR_PROBE });
      const [rs, cnt] = String(r?.value || '').split('|');
      log(`  readyState=${rs} 笔记锚点=${cnt}`);
      if (rs === 'complete' && Number(cnt) > 0) { ready = true; break; }
    } catch (e) {
      log('  轮询中(可能正在导航/重连):', e.message);
    }
  }
  if (!ready) log('⚠ 未稳定检测到笔记锚点,仍尝试解析(可能需登录/已改版/被风控)。');

  // 滚动两屏触发懒加载(M1 用 scrollBy 够用;真发评论的 M4 才需 trusted 滚轮)
  for (let s = 0; s < 2; s++) {
    await client.evaluate({ target, expression: 'window.scrollBy(0,1600); "ok"' }).catch(() => {});
    await sleep(1200);
  }

  // 解析
  let payload;
  try {
    const res = await client.evaluate({ target, expression: EXPR_PARSE });
    payload = JSON.parse(res.value);
  } catch (e) {
    log('✗ 解析失败:', e.message);
    process.exit(1);
  }

  console.log('\n—— 诊断 ——');
  console.log(payload.diag);
  if (payload.diag.needLogin) {
    log('⚠ 页面疑似要求登录:请在该浏览器里先登录小红书,再重试。');
  }

  console.log(`\n—— 解析到 ${payload.notes.length} 条笔记 ——`);
  payload.notes.forEach((n, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${n.title || n.snippet || '(无标题)'}`);
    console.log(`    作者:${n.author || '?'}  ${n.url}`);
  });

  // 截图存档(监控器雏形:留一张"机器当时看到的页面")
  try {
    const img = await client.screenshot({ target });
    if (img) {
      const outDir = path.join(__dirname, '..', 'tmp');
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `m1-${Date.now()}.jpg`);
      fs.writeFileSync(file, Buffer.from(img, 'base64'));
      log('已存截图:', file);
    }
  } catch (e) {
    log('截图失败(不影响结果):', e.message);
  }

  console.log('');
  log(payload.notes.length > 0
    ? '✓ M1 跑通:能接管浏览器、搜到并解析出真实笔记。'
    : '△ 接管/导航 OK,但没解析到笔记 —— 把上面的「诊断」发我,据此调选择器或换取数方式。');
  process.exit(0);
}

main().catch((e) => { console.error('未捕获错误:', e); process.exit(1); });
