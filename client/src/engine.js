'use strict';

// 引擎模块 —— 把 M1-M4 跑通的逻辑抽成可被服务/CLI 复用的函数。
// 页面内表达式直接复用已验证的(scan-clean / m3-read-notes)。

const { XhsCdpClient } = require('./cdp/xhs-cdp-client');
const { check, rejectsAgent } = require('./compliance');
const { openNoteFromList, closeCurrentNote } = require('./note-navigation');

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
function buildSearchUrl(keyword) {
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
}

// 当前视口内可见的笔记卡片中,随机挑一张返回其中心坐标(供"浏览时移过去看一眼")
const PICK_VISIBLE_CARD = `(function(){
  var links = document.querySelectorAll('a[class*=cover]');
  var vis = [];
  for (var i=0;i<links.length;i++){ var r=links[i].getBoundingClientRect(); if (r.width>120 && r.height>120 && r.top>=40 && r.top<window.innerHeight-120){ vis.push({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}); } }
  if (!vis.length) return JSON.stringify(null);
  return JSON.stringify(vis[Math.floor(Math.random()*vis.length)]);
})()`;

async function scanClean({ client, target, keyword, maxNotes = 60, maxRounds = 20, onLog = () => {}, shouldStop = () => false, filters = {} }) {
  const url = buildSearchUrl(keyword);
  onLog(`导航到搜索页:${keyword}`);
  await client.navigate({ target, url });
  let ready = false;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try { const r = await client.evaluate({ target, expression: EXPR_PROBE }); const [rs, cnt] = String(r?.value || '').split('|'); if (rs === 'complete' && Number(cnt) > 0) { ready = true; break; } } catch (e) {}
  }
  if (!ready) onLog('⚠ 未稳定就绪(需登录?),仍尝试');
  try { await client.installCursor({ target }); } catch (e) {} // 先注入红点,保证后面点筛选时看得到鼠标

  try { await applyFilters({ client, target, filters, onLog }); } catch (e) { onLog('筛选应用失败(忽略):' + e.message); }
  const all = new Map();
  let stale = 0;
  for (let round = 0; round < maxRounds && stale < 4 && all.size < maxNotes; round++) {
    if (shouldStop()) { onLog('⏹ 收到停止,中断检索'); break; }
    let res = { notes: [] };
    try { const r = await client.evaluate({ target, expression: EXPR_EXTRACT }); res = JSON.parse(r.value); } catch (e) {}
    const before = all.size;
    for (const n of (res.notes || [])) { if (n.id && !all.has(n.id)) all.set(n.id, { ...n, searchUrl: url }); }
    const added = all.size - before;
    onLog(`第 ${round + 1} 轮:本屏 ${res.count || 0},新增 ${added},累计 ${all.size}`);
    if (added === 0) stale++; else stale = 0;
    // 拟人:移到当前可见的一条笔记上看一眼(有目的的鼠标移动,红点随之移动),再翻页
    if (Math.random() < 0.75) {
      try {
        const cr = await client.evaluate({ target, expression: PICK_VISIBLE_CARD });
        const cp = JSON.parse((cr && cr.value) || 'null');
        if (cp && Number.isFinite(cp.x)) { await client.humanMove({ target, toX: cp.x, toY: cp.y }); await sleep(rand(500, 1300)); }
      } catch (e) {}
    }
    await client.wheelScroll({ target, x: rand(400, 800), y: rand(300, 520), totalDeltaY: rand(700, 1100) }).catch(() => {}); // trusted 滚轮(拟人)
    await sleep(rand(700, 1700) + (Math.random() < 0.14 ? rand(800, 1600) : 0)); // 拟人停顿:随机 + 14% 概率长停
  }
  return [...all.values()];
}

// ── 进详情读正文 ──
async function readDetail({ client, target, note, onLog = () => {}, browse = {}, onBeforeClose = null }) {
  if (!note || !note.id) throw new Error('read_detail_note_required');
  const b = Object.assign({ imagesMin: 2, imagesMax: 5, bodyMin: 1500, bodyMax: 5000, cScrollMin: 2, cScrollMax: 5, cDwellMin: 1800, cDwellMax: 4500 }, browse || {});
  await openNoteFromList({ client, target, note, onLog });
  try {
    for (let k = 0; k < 12; k++) { await sleep(800); const rs = await client.evaluate({ target, expression: 'document.readyState' }); if (rs && rs.value === 'complete') break; }
    await sleep(rand(900, 1800));
    let detail; try { const r = await client.evaluate({ target, expression: DETAIL_EXTRACT }); detail = JSON.parse(r.value); } catch (e) { detail = { ok: false, error: e.message }; }
    // ③ 图文按实际张数看图:点右箭头切图,直到轮播 transform 不再变化(已是最后一张)就停,绝不超过实际图片数
    try {
      if (b.imagesMax > 0 && (detail && detail.type !== 'video')) {
        const want = rand(b.imagesMin, b.imagesMax + 1); // 最多想看几张(含第 1 张),实际看几张取决于笔记真实图片数
        const EXPR_SW = `(function(){var a=document.querySelector('[class*=arrow-controller][class*=right]');var ar=null;if(a){var r=a.getBoundingClientRect();if(r.width>0&&r.top<window.innerHeight)ar={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};}var w=document.querySelector('[class*=swiper-wrapper]');var tf=w?getComputedStyle(w).transform:'';return JSON.stringify({arrow:ar,tf:tf});})()`;
        await client.humanMove({ target, toX: rand(470, 600), toY: rand(280, 440) }).catch(() => {});
        await sleep(rand(700, 1500)); // 看第 1 张
        let seen = 1;
        for (let k = 1; k < want; k++) {
          let st1; try { st1 = JSON.parse((await client.evaluate({ target, expression: EXPR_SW })).value); } catch (e) { break; }
          if (!st1 || !st1.arrow) break; // 无轮播/无右箭头(单图或视频)
          await client.click({ target, x: st1.arrow.x, y: st1.arrow.y });
          await sleep(rand(700, 1400));
          let st2; try { st2 = JSON.parse((await client.evaluate({ target, expression: EXPR_SW })).value); } catch (e) { st2 = st1; }
          if (!st2 || st2.tf === st1.tf) break; // transform 没变 = 已是最后一张,停
          seen++;
          onLog('  看第 ' + seen + ' 张图');
          await sleep(rand(400, 900));
        }
      }
    } catch (e) {}
    // ③ 正文随机停留(像在读)
    await sleep(rand(b.bodyMin, b.bodyMax));
    // ② 往下滑读评论:随机几下,每下停留几秒读,鼠标偶尔游走
    try {
      const cs = rand(b.cScrollMin, b.cScrollMax + 1);
      for (let k = 0; k < cs; k++) {
        await client.humanMove({ target, toX: rand(180, 560), toY: rand(340, 680) }).catch(() => {}); // 滚前鼠标先滑到评论区(有目的)
        await sleep(rand(300, 700));
        await client.wheelScroll({ target, x: rand(380, 640), y: rand(360, 620), totalDeltaY: rand(300, 700) }).catch(() => {});
        onLog(`  往下读评论 ${k + 1}/${cs}`);
        await sleep(rand(b.cDwellMin, b.cDwellMax)); // 滑动后停留读(已加长)
        if (Math.random() < 0.6) { await client.humanMove({ target, toX: rand(160, 520), toY: rand(320, 720) }).catch(() => {}); await sleep(rand(500, 1200)); } // 偶尔鼠标再滑,像在看某条评论
      }
    } catch (e) {}
    if (onBeforeClose) { try { await onBeforeClose({ client, target, note, detail }); } catch (e) {} } // 浏览完、关闭前:自动评论在这里评
    return detail;
  } finally {
    await closeCurrentNote({ client, target, note, onLog });
  }
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


// —— 搜索筛选(拟人点击:按可见文字匹配筛选选项,不写死脆弱选择器,抗改版) ——
function FIND_BY_TEXT(label) {
  const j = JSON.stringify(label);
  return '(function(){'
    + 'function vis(r){return r.width>0&&r.height>0&&r.top>=0&&r.top<window.innerHeight*0.75&&r.left>=0;}'
    + 'var want=' + j + ';'
    + 'var nodes=document.querySelectorAll("span,div,button,a,li,p");'
    + 'var best=null;'
    + 'for(var i=0;i<nodes.length;i++){var e=nodes[i];if(e.childElementCount>0)continue;'
    + 'var t=(e.textContent||"").trim();if(t!==want)continue;'
    + 'var r=e.getBoundingClientRect();if(!vis(r))continue;'
    + 'if(!best||r.top<best.top)best={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),top:Math.round(r.top)};}'
    + 'return best?JSON.stringify(best):"";'
    + '})()';
}
async function clickByText({ client, target, label }) {
  const r = await client.evaluate({ target, expression: FIND_BY_TEXT(label) });
  let p = null; try { p = JSON.parse((r && r.value) || ''); } catch (e) {}
  if (p && Number.isFinite(p.x)) { await client.click({ target, x: p.x, y: p.y }); return true; }
  return false;
}
async function applyFilters({ client, target, filters = {}, onLog = () => {} }) {
  const want = (v, def) => (v && v !== def ? v : null);
  const sort = want(filters.sort, '综合');
  const noteType = want(filters.noteType, '不限');
  const noteTime = want(filters.noteTime, '不限');
  const noteRange = want(filters.noteRange, '不限');
  if (!sort && !noteType && !noteTime && !noteRange) { onLog('筛选:全部默认,无需设置'); return; }
  if (sort) {
    await clickByText({ client, target, label: '综合' }); // 排序若是下拉,先展开
    await sleep(rand(400, 900));
    const ok = await clickByText({ client, target, label: sort });
    onLog(ok ? ('筛选·排序:已选「' + sort + '」') : ('筛选·排序:没找到「' + sort + '」,跳过'));
    await sleep(rand(500, 1000));
  }
  const panel = [['类型', noteType], ['发布时间', noteTime], ['范围', noteRange]].filter((x) => x[1]);
  if (panel.length) {
    const opened = await clickByText({ client, target, label: '筛选' });
    onLog(opened ? '筛选:已点开筛选面板' : '筛选:没找到「筛选」入口,跳过类型/时间/范围');
    await sleep(rand(1300, 2300));
    for (const [dim, label] of panel) {
      const ok = await clickByText({ client, target, label });
      onLog(ok ? ('筛选·' + dim + ':已选「' + label + '」') : ('筛选·' + dim + ':没找到「' + label + '」,跳过'));
      await sleep(rand(500, 1000));
    }
    await clickByText({ client, target, label: '筛选' }).catch(() => {}); // 收起面板
  }
  await sleep(rand(1200, 2000)); // 等列表按筛选刷新
}
module.exports = { connect, buildSearchUrl, scanClean, matchNotes, readDetail, genComment, classify, check, rejectsAgent, applyFilters };
