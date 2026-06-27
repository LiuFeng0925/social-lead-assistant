'use strict';

// 一次性探测:把运行时 __INITIAL_STATE__.search.feeds 的真实结构挖出来。
// 报告:search 有哪些 key、feeds 是什么类型、哪条候选路径能拿到数组、第一个元素的字段结构。
// 用法:node src/probe-state.js "朝阳 租房"

const { XhsCdpClient } = require('./cdp/xhs-cdp-client');

const KEYWORD = process.argv[2] || '朝阳 租房';
const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR = `(function(){
  var s = window.__INITIAL_STATE__;
  var info = { hasState: !!s };
  if (!s) return JSON.stringify(info);
  info.searchKeys = s.search ? Object.keys(s.search) : null;
  var f = s.search && s.search.feeds;
  info.feedsType = typeof f;
  info.feedsIsArray = Array.isArray(f);
  if (f && typeof f === 'object') info.feedsKeys = Object.keys(f).slice(0, 15);
  var cand = [
    ['f', f],
    ['f.value', f && f.value],
    ['f.value.value', f && f.value && f.value.value],
    ['f._value.value', f && f._value && f._value.value],
    ['f._rawValue.value', f && f._rawValue && f._rawValue.value]
  ];
  info.cands = {}; var arr = null, hp = null;
  for (var i = 0; i < cand.length; i++) {
    var a = cand[i][1]; var isA = Array.isArray(a);
    info.cands[cand[i][0]] = isA ? ('Array(' + a.length + ')') : typeof a;
    if (isA && a.length && !arr) { arr = a; hp = cand[i][0]; }
  }
  info.hitPath = hp;
  if (arr && arr[0]) {
    function shape(o, d) {
      if (d > 4 || o == null) return o === null ? 'null' : typeof o;
      if (typeof o !== 'object') { var v = String(o); return (typeof o) + (v.length < 50 ? (':' + v) : ''); }
      if (Array.isArray(o)) return 'Array(' + o.length + ')' + (o.length ? (' of ' + shape(o[0], d + 1)) : '');
      var out = {}; var ks = Object.keys(o).slice(0, 30);
      for (var j = 0; j < ks.length; j++) out[ks[j]] = shape(o[ks[j]], d + 1);
      return out;
    }
    info.firstItem = shape(arr[0], 0);
  }
  return JSON.stringify(info);
})()`;

(async () => {
  const client = new XhsCdpClient({ endpoint: ENDPOINT });
  const target = await client.resolvePageTarget();
  console.log('已接管:', target.title || target.url);
  await client.navigate({ target, url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(KEYWORD)}&source=web_search_result_notes` });
  // 等渲染
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const r = await client.evaluate({ target, expression: `(function(){return document.readyState+'|'+document.querySelectorAll('a[href*="/explore/"]').length;})()` });
    const [rs, cnt] = String(r?.value || '').split('|');
    if (rs === 'complete' && Number(cnt) > 0) { console.log(`就绪,锚点 ${cnt}`); break; }
  }
  const res = await client.evaluate({ target, expression: EXPR });
  console.log('\n—— 运行时 __INITIAL_STATE__ 探测 ——');
  try { console.log(JSON.stringify(JSON.parse(res.value), null, 2)); }
  catch (e) { console.log(res.value); }
  process.exit(0);
})().catch((e) => { console.error('探测失败:', e.message); process.exit(1); });
