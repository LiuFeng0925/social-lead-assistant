'use strict';

// M3.2 · 批量读详情
// 读最新 match-*.json 的 targets 前 N 条,逐条进详情页提取(标题/正文/tags/IP/赞评),
// 输出一份"生成清单"JSON,供下一步生成评论。每条之间拟人停顿。
// 用法:node src/m3-read-notes.js [N=5]

const fs = require('node:fs');
const path = require('node:path');
const { XhsCdpClient } = require('./cdp/xhs-cdp-client');
const { buildSearchUrl } = require('./engine');
const { openNoteFromList, closeCurrentNote } = require('./note-navigation');

const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const N = Number(process.argv[2] || 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const ts = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log(`[${ts()}]`, ...a);
const TMP = path.join(__dirname, '..', 'tmp');

function latestMatch() {
  const files = fs.readdirSync(TMP).filter((f) => /^match-\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('没有 match-*.json,先跑 match.js');
  return path.join(TMP, files[files.length - 1]);
}

// 详情页提取:所有字段强制 String/string[],避开 Vue reactive 的循环引用
const EXTRACT = `(function(){
  try{
    var s=window.__INITIAL_STATE__||{}; var n=s.note||{}; var map=n.noteDetailMap||{};
    var cur=n.currentNoteId; if(cur&&typeof cur==='object') cur=(cur.value!=null?cur.value:cur._value); cur=cur!=null?String(cur):'';
    var id=(cur&&map[cur])?cur:Object.keys(map)[0];
    if(!id) return JSON.stringify({ok:false,reason:'no id'});
    var note=(map[id]&&(map[id].note||map[id]))||{};
    var it=note.interactInfo||{}; var user=note.user||{};
    var tags=[]; try{ var tl=note.tagList||[]; for(var i=0;i<tl.length;i++){ var nm=tl[i]&&tl[i].name; if(nm) tags.push(String(nm)); } }catch(e){}
    return JSON.stringify({ ok:true, id:String(id),
      title:String(note.title||''), desc:String(note.desc||''), type:String(note.type||''),
      author:String(user.nickname||user.nickName||''), ip:String(note.ipLocation||''),
      likes:String(it.likedCount==null?'':it.likedCount),
      comments:String(it.commentCount==null?'':it.commentCount),
      collects:String(it.collectedCount==null?'':it.collectedCount),
      tags:tags.slice(0,15) });
  }catch(e){ return JSON.stringify({ok:false,error:String((e&&e.message)||e)}); }
})()`;

async function main() {
  const m = JSON.parse(fs.readFileSync(latestMatch(), 'utf8'));
  const targets = (m.targets || []).slice(0, N);
  if (!targets.length) { console.log('match 结果里没有 target'); process.exit(1); }
  log(`关键词「${m.keyword}」· 读前 ${targets.length} 条目标笔记详情`);
  const searchUrl = buildSearchUrl(m.keyword);

  const client = new XhsCdpClient({ endpoint: ENDPOINT });
  const target = await client.resolvePageTarget();

  const details = [];
  for (let i = 0; i < targets.length; i++) {
    const t = { ...targets[i], searchUrl };
    await openNoteFromList({ client, target, note: t, onLog: log });
    try {
      for (let k = 0; k < 12; k++) {
        await sleep(900);
        const rs = await client.evaluate({ target, expression: 'document.readyState' });
        if (rs && rs.value === 'complete') break;
      }
      await sleep(1400); // 正文异步
      let d = { ok: false };
      try { const r = await client.evaluate({ target, expression: EXTRACT }); d = JSON.parse(r.value); } catch (e) { d.error = e.message; }
      if (d.ok) {
        d.url = t.url;
        d.searchUrl = searchUrl;
        details.push(d);
        log(`${i + 1}/${targets.length} ✓ ${d.title || '(无标题)'} · ${d.author} · 评${d.comments} · [${d.tags.slice(0, 4).join('/')}]`);
      } else {
        log(`${i + 1}/${targets.length} ✗ 提取失败:${d.reason || d.error || '?'}`);
      }
    } finally {
      await closeCurrentNote({ client, target, note: t, onLog: log });
    }
    await sleep(rand(1500, 3000)); // 拟人停顿
  }

  const out = path.join(TMP, `details-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ keyword: m.keyword, searchUrl, count: details.length, details }, null, 2));
  console.log(`\n已存详情清单:${path.basename(out)}(${details.length} 条)`);
  console.log('\n—— 生成清单(喂给下一步生成评论)——');
  details.forEach((d, i) => {
    console.log(`\n[${i + 1}] ${d.title || '(无标题)'}  · ${d.author} · ${d.ip} · 赞${d.likes}/评${d.comments}`);
    console.log(`    tags: ${d.tags.join(' / ')}`);
    const body = (d.desc || '').replace(/#[^#]*\[话题\]#/g, '').replace(/\s+/g, ' ').trim();
    console.log(`    正文: ${body ? body.slice(0, 160) : '(仅话题标签/图文为主)'}`);
  });
}

main().catch((e) => { console.error('未捕获错误:', e); process.exit(1); });
