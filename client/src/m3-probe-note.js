'use strict';

// M3.1 探测 · 进笔记详情页,把正文(desc)在 __INITIAL_STATE__ 里的位置挖出来。
// 读最新 match-*.json 的第 1 条 target,导航其详情页,dump note 结构 + DOM 正文样本。
// 用法:node src/m3-probe-note.js

const fs = require('node:fs');
const path = require('node:path');
const { XhsCdpClient } = require('./cdp/xhs-cdp-client');
const { buildSearchUrl } = require('./engine');
const { openNoteFromList, closeCurrentNote } = require('./note-navigation');

const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = path.join(__dirname, '..', 'tmp');

function latestMatch() {
  const files = fs.readdirSync(TMP).filter((f) => /^match-\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('没有 match-*.json,先跑 match.js');
  return path.join(TMP, files[files.length - 1]);
}

const DUMP = `(function(){
  var NL = String.fromCharCode(10);
  try {
    var s = window.__INITIAL_STATE__ || {}; var n = s.note || {};
    var map = n.noteDetailMap || {};
    var cur = n.currentNoteId;
    if (cur && typeof cur === 'object') cur = (cur.value != null ? cur.value : cur._value);
    cur = cur != null ? String(cur) : '';
    var id = (cur && map[cur]) ? cur : Object.keys(map)[0];
    if (!id) return 'ERR: no note id; noteKeys=' + Object.keys(n).slice(0,20).join(',');
    var detail = map[id];
    if (!detail) return 'ERR: no detail; id=' + String(id) + '; mapKeys=' + Object.keys(map).slice(0,5).join(',');
    var note = detail.note || detail;
    var it = note.interactInfo || {};
    var user = note.user || {};
    var tags = [];
    try { var tl = note.tagList || []; for (var i=0;i<tl.length;i++){ var nm = tl[i] && tl[i].name; if (nm) tags.push(String(nm)); } } catch(e){}
    var out = [];
    out.push('id=' + String(id));
    out.push('fields=' + Object.keys(note).slice(0,30).join(','));
    out.push('title=' + String(note.title||''));
    out.push('type=' + String(note.type||'') + '  author=' + String(user.nickname||user.nickName||''));
    out.push('likes=' + String(it.likedCount==null?'':it.likedCount) + '  comments=' + String(it.commentCount==null?'':it.commentCount));
    out.push('tags=' + tags.join(' / '));
    out.push('--- desc(正文) ---');
    out.push(String(note.desc||'(空)'));
    return out.join(NL);
  } catch(e) {
    return 'ERR: ' + String((e&&e.message)||e);
  }
})()`;

(async () => {
  const m = JSON.parse(fs.readFileSync(latestMatch(), 'utf8'));
  const searchUrl = buildSearchUrl(m.keyword);
  const rawTarget = (m.targets || [])[0];
  if (!rawTarget) { console.log('match 结果里没有 target'); process.exit(1); }
  const t = { ...rawTarget, searchUrl };
  console.log('目标笔记:', t.title);
  console.log('URL:', t.url, '\n');

  const c = new XhsCdpClient({ endpoint: ENDPOINT });
  const target = await c.resolvePageTarget();
  await openNoteFromList({ client: c, target, note: t, onLog: console.log });
  try {
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const r = await c.evaluate({ target, expression: 'document.readyState' });
      if (r && r.value === 'complete') break;
    }
    await sleep(1800); // 详情/正文异步渲染,多等一下

    const r = await c.evaluate({ target, expression: DUMP });
    console.log('—— explore 详情页正文 ——');
    console.log(r && r.value);
  } finally {
    await closeCurrentNote({ client: c, target, note: t, onLog: console.log });
  }
  process.exit(0);
})().catch((e) => { console.error('探测失败:', e.message); process.exit(1); });
