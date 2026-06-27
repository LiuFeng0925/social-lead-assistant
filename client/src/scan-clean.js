'use strict';

// M1.5 · 干净 + 全量检索
// 滚动扫全部(已验证)+ 从 __INITIAL_STATE__.search.feeds 读干净结构化字段(标题/类型/点赞/作者/封面)。
// 先 dump 一条真实 feed 结构核对字段,再批量提取;DOM 锚点数作对照。
// 用法:node src/scan-clean.js "朝阳 租房"

const fs = require('node:fs');
const path = require('node:path');
const { XhsCdpClient } = require('./cdp/xhs-cdp-client');

const KEYWORD = process.argv[2] || '朝阳 租房';
const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const MAX_NOTES = Number(process.env.XHS_MAX_NOTES || 120);
const MAX_ROUNDS = Number(process.env.XHS_MAX_ROUNDS || 30);
const STALE_LIMIT = Number(process.env.XHS_STALE_LIMIT || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const ts = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log(`[${ts()}]`, ...a);

// 页面内:取 feeds 数组(优先活 ref 值 feeds.value.value,回退快照 _value/_rawValue.value)
const FEEDS_PICK = `(function(){
  var s = window.__INITIAL_STATE__; var f = s && s.search && s.search.feeds; var arr = [];
  try { if (f && Array.isArray(f.value)) arr = f.value; } catch(e){}                                  // 运行时:ref.value 直接是数组
  if (!arr.length) { try { var rv = f && (f._rawValue || f._value); if (rv && Array.isArray(rv.value)) arr = rv.value; } catch(e){} }  // 初始 SSR 快照
  if (!arr.length && Array.isArray(f)) arr = f;
  return arr;
})()`;

const EXPR_PROBE = `(function(){var c=document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]').length;return document.readyState+'|'+c;})()`;

const EXPR_DUMP = `(function(){
  var arr = ${FEEDS_PICK};
  if (!arr.length) return JSON.stringify({ empty:true });
  function shape(o,d){
    if (d>4||o==null) return o===null?'null':typeof o;
    if (typeof o!=='object'){ var v=String(o); return (typeof o)+(v.length<40?(':'+v):''); }
    if (Array.isArray(o)) return 'Array('+o.length+')'+(o.length?(' of '+shape(o[0],d+1)):'');
    var out={}; var ks=Object.keys(o).slice(0,25);
    for (var i=0;i<ks.length;i++) out[ks[i]]=shape(o[ks[i]],d+1);
    return out;
  }
  return JSON.stringify(shape(arr[0],0));
})()`;

const EXPR_EXTRACT = `(function(){
  var arr = ${FEEDS_PICK};
  var out = [];
  for (var i=0;i<arr.length;i++){
    var item = arr[i] || {};
    if (item.modelType && item.modelType !== 'note') continue;   // 跳过广告/用户卡等非笔记
    var nc = item.noteCard || item.note_card || {};
    if (!nc || typeof nc !== 'object') continue;
    var user = nc.user || {};
    var it = nc.interactInfo || {};
    var cover = nc.cover || {};
    var id = item.id || nc.noteId || '';
    var xsec = item.xsecToken || (user && user.xsecToken) || '';
    out.push({
      id: id,
      type: nc.type || '',
      title: nc.displayTitle || '',
      author: user.nickName || user.nickname || '',
      userId: user.userId || '',
      likes: it.likedCount!=null?it.likedCount:'',
      collects: it.collectedCount!=null?it.collectedCount:'',
      comments: it.commentCount!=null?it.commentCount:'',
      cover: cover.urlDefault || cover.urlPre || '',
      xsecToken: xsec,
      url: id ? ('https://www.xiaohongshu.com/explore/'+id+(xsec?('?xsec_token='+xsec+'&xsec_source=pc_search'):'')) : ''
    });
  }
  return JSON.stringify({ ok:true, count: out.length, notes: out });
})()`;

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
  if (!ready) log('⚠ 未稳定就绪,仍尝试。');

  try {
    const d = await client.evaluate({ target, expression: EXPR_DUMP });
    console.log('\n—— 单条 feed 真实结构(核对提取字段) ——');
    console.log(d.value);
    console.log('');
  } catch (e) { log('dump 失败:', e.message); }

  const all = new Map();
  let stale = 0, round = 0;
  for (round = 0; round < MAX_ROUNDS && stale < STALE_LIMIT && all.size < MAX_NOTES; round++) {
    let res = { count: 0, notes: [] };
    try { const r = await client.evaluate({ target, expression: EXPR_EXTRACT }); res = JSON.parse(r.value); }
    catch (e) { log('提取出错:', e.message); }
    let domCnt = 0;
    try { const p = await client.evaluate({ target, expression: EXPR_PROBE }); domCnt = Number(String(p?.value || '').split('|')[1] || 0); } catch (e) {}
    const before = all.size;
    for (const n of (res.notes || [])) { if (n.id && !all.has(n.id)) all.set(n.id, n); }
    const added = all.size - before;
    log(`第 ${String(round + 1).padStart(2)} 轮:state ${res.count} 条 / DOM锚点 ${domCnt} | 新增 ${added},累计 ${all.size}`);
    if (added === 0) stale++; else stale = 0;
    await client.evaluate({ target, expression: 'window.scrollBy(0, 900); "ok"' }).catch(() => {});
    await sleep(rand(1200, 2500));
  }

  const reason = all.size >= MAX_NOTES ? `到上限 ${MAX_NOTES}` : (stale >= STALE_LIMIT ? '连续无新增(到底)' : `到轮数上限 ${MAX_ROUNDS}`);
  console.log(`\n===== 干净数据:${all.size} 条,滚动 ${round} 轮,${reason} =====`);

  const list = [...all.values()];
  list.slice(0, 20).forEach((n, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${n.type || '?'}] ${n.title || '(无标题)'}`);
    console.log(`     作者:${n.author || '?'}  赞${n.likes || '?'}/藏${n.collects || '?'}/评${n.comments || '?'}  ${n.url}`);
  });
  if (list.length > 20) console.log(`… 其余 ${list.length - 20} 条已存 JSON`);

  try {
    const outDir = path.join(__dirname, '..', 'tmp'); fs.mkdirSync(outDir, { recursive: true });
    const jf = path.join(outDir, `clean-${Date.now()}.json`);
    fs.writeFileSync(jf, JSON.stringify({ keyword: KEYWORD, count: all.size, rounds: round, reason, notes: list }, null, 2));
    log('已存:', jf);
  } catch (e) { log('存档失败:', e.message); }

  const withTitle = list.filter((n) => n.title).length;
  const withLikes = list.filter((n) => n.likes !== '').length;
  const withType = list.filter((n) => n.type).length;
  console.log('');
  log(`字段完整度:标题 ${withTitle}/${list.length} · 点赞 ${withLikes}/${list.length} · 类型 ${withType}/${list.length}`);
  log(all.size > 30 && withTitle > all.size * 0.5
    ? '✓ M1.5 成:拿到干净 + 全量数据。'
    : '△ 字段提取需按上面 dump 的真实结构微调。');
  process.exit(0);
}

main().catch((e) => { console.error('未捕获错误:', e); process.exit(1); });
