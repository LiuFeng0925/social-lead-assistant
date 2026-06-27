'use strict';

// 引擎模块 —— 把 M1-M4 跑通的逻辑抽成可被服务/CLI 复用的函数。
// 页面内表达式直接复用已验证的(scan-clean / m3-read-notes)。

const { XhsCdpClient } = require('./cdp/xhs-cdp-client');
const { check, rejectsAgent } = require('./compliance');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

// ── 页面内表达式(已验证) ──
const FEEDS_PICK = `(function(){
  var s = window.__INITIAL_STATE__; var f = s && s.search && s.search.feeds; var arr = [];
  try { if (f && Array.isArray(f.value)) arr = f.value; } catch(e){}
  if (!arr.length) { try { var rv = f && (f._rawValue || f._value); if (rv && Array.isArray(rv.value)) arr = rv.value; } catch(e){} }
  if (!arr.length && Array.isArray(f)) arr = f;
  return arr;
})()`;

const EXPR_PROBE = `(function(){var c=document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]').length;return document.readyState+'|'+c;})()`;

const EXPR_EXTRACT = `(function(){
  var arr = ${FEEDS_PICK};
  var out = [];
  for (var i=0;i<arr.length;i++){
    var item = arr[i] || {};
    if (item.modelType && item.modelType !== 'note') continue;
    var nc = item.noteCard || item.note_card || {};
    if (!nc || typeof nc !== 'object') continue;
    var user = nc.user || {}; var it = nc.interactInfo || {}; var cover = nc.cover || {};
    var id = item.id || nc.noteId || '';
    var xsec = item.xsecToken || (user && user.xsecToken) || '';
    out.push({
      id: id, type: nc.type || '', title: nc.displayTitle || '',
      author: user.nickName || user.nickname || '', userId: user.userId || '',
      likes: it.likedCount!=null?it.likedCount:'', collects: it.collectedCount!=null?it.collectedCount:'',
      comments: it.commentCount!=null?it.commentCount:'',
      cover: cover.urlDefault || cover.urlPre || '', xsecToken: xsec,
      url: id ? ('https://www.xiaohongshu.com/explore/'+id+(xsec?('?xsec_token='+xsec+'&xsec_source=pc_search'):'')) : ''
    });
  }
  return JSON.stringify({ count: out.length, notes: out });
})()`;

const DETAIL_EXTRACT = `(function(){
  try{
    var s=window.__INITIAL_STATE__||{}; var n=s.note||{}; var map=n.noteDetailMap||{};
    var cur=n.currentNoteId; if(cur&&typeof cur==='object') cur=(cur.value!=null?cur.value:cur._value); cur=cur!=null?String(cur):'';
    var id=(cur&&map[cur])?cur:Object.keys(map)[0];
    if(!id) return JSON.stringify({ok:false});
    var note=(map[id]&&(map[id].note||map[id]))||{}; var it=note.interactInfo||{}; var user=note.user||{};
    var tags=[]; try{ var tl=note.tagList||[]; for(var i=0;i<tl.length;i++){ var nm=tl[i]&&tl[i].name; if(nm) tags.push(String(nm)); } }catch(e){}
    return JSON.stringify({ ok:true, id:String(id), title:String(note.title||''), desc:String(note.desc||''),
      type:String(note.type||''), author:String(user.nickname||user.nickName||''), ip:String(note.ipLocation||''),
      likes:String(it.likedCount==null?'':it.likedCount), comments:String(it.commentCount==null?'':it.commentCount),
      tags:tags.slice(0,15) });
  }catch(e){ return JSON.stringify({ok:false,error:String((e&&e.message)||e)}); }
})()`;

// ── 匹配规则(同 match.js) ──
const TARGET_REGIONS = ['朝阳', '北京', '望京', '国贸', '三里屯', '双井', '十里河', '大悦城', '酒仙桥', '798', '团结湖', '安贞', '劲松', '潘家园', '日坛', '亮马', '燕莎', '草房', '常营', '管庄', '高碑店', '四惠'];
const RE_SEEK = /(求租|求转租|求直租|求推荐|求靠谱|求房|找房|蹲|谁有|有没有|想租|要租|跪求|急租|预算[\d千万]|[\d千万]+(以)?内.{0,4}(一居|两居|室|开间|房|公寓))/;
const RE_SUPPLY = /(整租|^直租|房东直租|出租|转租出|拎包入住|可短租|月付|押[一二三]付|空房|新出|有房|出房|招租|转租|急转)/;
const RE_AGENT = /(CH$|好房|直租|物业|公寓|甄选|管家|房产|租房记|安家|房探|地产|不动产|优选|房屋|租赁|严选)/;

function classify(note) {
  const title = note.title || '';
  const author = note.author || '';
  const region = TARGET_REGIONS.find((r) => title.includes(r)) || (/租/.test(title) ? '(泛北京)' : '');
  const isAgent = RE_AGENT.test(author);
  const seek = RE_SEEK.test(title);
  const supply = RE_SUPPLY.test(title);
  let intent = seek ? '求租' : (supply ? '房源' : '不明');
  const isTarget = intent === '求租' && !!region && !isAgent;
  const heat = Number(note.comments || 0) + Number(note.likes || 0);
  return { ...note, region, isAgent, intent, isTarget, heat };
}

function matchNotes(notes) {
  const tagged = notes.map(classify);
  const byIntent = {};
  tagged.forEach((n) => { byIntent[n.intent] = (byIntent[n.intent] || 0) + 1; });
  const targets = tagged.filter((n) => n.isTarget).sort((a, b) => b.heat - a.heat);
  return { tagged, targets, byIntent };
}

// ── CDP 连接 ──
async function connect(endpoint, onPointer) {
  const client = new XhsCdpClient({ endpoint: endpoint || 'http://127.0.0.1:9222', onPointer });
  const target = await client.resolvePageTarget();
  return { client, target };
}

// ── 检索 + 滚动扫全 + 干净取数 ──
async function scanClean({ client, target, keyword, maxNotes = 60, maxRounds = 20, onLog = () => {} }) {
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
  onLog(`导航到搜索页:${keyword}`);
  await client.navigate({ target, url });
  let ready = false;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try { const r = await client.evaluate({ target, expression: EXPR_PROBE }); const [rs, cnt] = String(r?.value || '').split('|'); if (rs === 'complete' && Number(cnt) > 0) { ready = true; break; } } catch (e) {}
  }
  if (!ready) onLog('⚠ 未稳定就绪(需登录?),仍尝试');
  const all = new Map();
  let stale = 0;
  for (let round = 0; round < maxRounds && stale < 4 && all.size < maxNotes; round++) {
    let res = { notes: [] };
    try { const r = await client.evaluate({ target, expression: EXPR_EXTRACT }); res = JSON.parse(r.value); } catch (e) {}
    const before = all.size;
    for (const n of (res.notes || [])) { if (n.id && !all.has(n.id)) all.set(n.id, n); }
    const added = all.size - before;
    onLog(`第 ${round + 1} 轮:本屏 ${res.count || 0},新增 ${added},累计 ${all.size}`);
    if (added === 0) stale++; else stale = 0;
    await client.evaluate({ target, expression: 'window.scrollBy(0,900);"ok"' }).catch(() => {});
    await sleep(rand(1100, 2200));
  }
  return [...all.values()];
}

// ── 进详情读正文 ──
async function readDetail({ client, target, url, onLog = () => {} }) {
  await client.navigate({ target, url });
  for (let k = 0; k < 12; k++) { await sleep(800); const rs = await client.evaluate({ target, expression: 'document.readyState' }); if (rs && rs.value === 'complete') break; }
  await sleep(1300);
  try { const r = await client.evaluate({ target, expression: DETAIL_EXTRACT }); return JSON.parse(r.value); } catch (e) { return { ok: false, error: e.message }; }
}

// ── 生成评论(开发期模板;接 LLM 后替换为 API 调用)──
function genComment(note, direction) {
  const title = note.title || '';
  const tags = note.tags || [];
  const hay = title + ' ' + tags.join(' ');
  const region = ['朝阳大悦城', '团结湖', '望京', '国贸', '三里屯', '双井', '十里河', '高碑店', '四惠', '酒仙桥', '朝阳'].find((r) => hay.includes(r)) || '你说的那一片';
  const hu = /三居/.test(hay) ? '三居' : /两居/.test(hay) ? '两居' : /(一居|单间|开间|主卧|次卧)/.test(hay) ? '一居' : '房子';
  return `看你在找${region}的${hu}呀~我手上正好有挺合适的房源,通勤方便、可以拎包入住。要不要看看?主页有实拍,合适的话私聊我聊细节~`;
}

module.exports = { connect, scanClean, matchNotes, readDetail, genComment, classify, check, rejectsAgent };
