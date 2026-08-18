'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

function noteIdOf(note = {}) {
  if (note.id) return String(note.id);
  const m = String(note.url || '').match(/\/explore\/([^/?#]+)/);
  return m ? m[1] : '';
}

function parseEvalJson(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : (value || {});
  } catch (e) {
    return {};
  }
}

function isSearchListPath(pathname) {
  return /^\/search_result(?:_ai)?\/?$/.test(String(pathname || ''));
}

function decodedSearchKeyword(value) {
  let decoded = String(value || '');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (e) { break; }
  }
  return decoded.replace(/\s+/g, ' ').trim();
}

function findNoteCardExpr(note) {
  const noteId = noteIdOf(note);
  const title = String((note && note.title) || '').replace(/\s+/g, ' ').trim();
  return `(function(){
    var noteId = ${JSON.stringify(noteId)};
    var title = ${JSON.stringify(title)};
    function hrefOf(a){ try { return String(a.href || a.getAttribute('href') || ''); } catch(e) { return ''; } }
    function norm(s){ return String(s || '').replace(/\\s+/g, ' ').trim(); }
    function vis(r){
      if (!r || r.width <= 30 || r.height <= 20) return false;
      var vw = window.innerWidth || 1400, vh = window.innerHeight || 900;
      var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return cx > 8 && cx < vw - 8 && cy > 48 && cy < vh - 48;
    }
    function sane(r){
      var vw = window.innerWidth || 1400, vh = window.innerHeight || 900;
      return vis(r) && r.width < vw * 0.75 && r.height < vh * 0.85;
    }
    function rectOf(e){ try { return e && e.getBoundingClientRect && e.getBoundingClientRect(); } catch(e2) { return null; } }
    function pickRect(a, card) {
      var ar = rectOf(a);
      if (sane(ar)) return ar;
      var best = null;
      function take(e) {
        var r = rectOf(e);
        if (!sane(r) || r.width < 80 || r.height < 60) return;
        if (!best || (r.width * r.height) > (best.width * best.height)) best = r;
      }
      take(card);
      var p = a.parentElement;
      for (var d = 0; p && d < 5; d++, p = p.parentElement) take(p);
      return best || ar;
    }
    var anchors = document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]');
    var best = null;
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i], href = hrefOf(a);
      var card = null;
      try { card = a.closest('section,.note-item,li,div[class*="note"],div[class*="card"]'); } catch(e) {}
      var txt = '';
      try { txt = norm((card || a).innerText || a.innerText || ''); } catch(e) {}
      var ownText = '';
      try { ownText = norm(a.innerText || a.textContent || ''); } catch(e) {}
      var idHit = !!(noteId && href.indexOf(noteId) >= 0);
      var titleHit = !!(title && txt.indexOf(title) >= 0);
      if (!idHit && !titleHit) continue;
      var r = rectOf(a);
      if (!vis(r)) continue;
      var hay = String(a.className || '').toLowerCase() + ' ' + ownText;
      var score = 20;
      if (ownText && title && ownText.indexOf(title) >= 0) score -= 12;
      if (hay.indexOf('title') >= 0) score -= 6;
      if (href.indexOf('/search_result/') >= 0) score -= 2;
      if (hay.indexOf('cover') >= 0) score += 4;
      if (href.indexOf('/explore/') >= 0 && r.width === 0) score += 100;
      if (!best || score < best.score || (score === best.score && r.top < best.r.top)) best = { score: score, href: href, r: r };
    }
    if (best) return JSON.stringify({ ok: true, noteId: noteId, href: best.href, x: Math.round(best.r.x + best.r.width / 2), y: Math.round(best.r.y + best.r.height / 2) });
    return JSON.stringify({ ok: false, noteId: noteId, reason: 'note_card_not_found' });
  })()`;
}

function detailStateExpr(note) {
  const noteId = noteIdOf(note);
  return `(function(){
    function unwrap(v){
      var n = 0;
      while (v && typeof v === 'object' && n++ < 6) {
        if (Object.prototype.hasOwnProperty.call(v, 'value')) { v = v.value; continue; }
        if (Object.prototype.hasOwnProperty.call(v, '_value')) { v = v._value; continue; }
        if (Object.prototype.hasOwnProperty.call(v, '_rawValue')) { v = v._rawValue; continue; }
        break;
      }
      return v;
    }
    var noteId = ${JSON.stringify(noteId)};
    var href = String(location.href || '');
    var s = window.__INITIAL_STATE__ || {};
    var n = unwrap(s.note) || {};
    var cur = unwrap(n.currentNoteId);
    cur = cur == null ? '' : String(cur);
    var map = unwrap(n.noteDetailMap) || {};
    var urlMatches = !!(noteId && href.indexOf(noteId) >= 0);
    var hasDetailMap = !!(noteId && map && map[noteId]);
    var currentMatches = !!(noteId && cur === noteId);
    var inExplore = href.indexOf('/explore/') >= 0;
    var inSearchDetail = !!(noteId && (href.indexOf('/search_result/' + noteId) >= 0 || href.indexOf('/search_result_ai/' + noteId) >= 0));
    return JSON.stringify({ open: !!(inExplore || inSearchDetail || urlMatches), ready: !!(urlMatches || hasDetailMap || currentMatches), urlMatches: urlMatches, hasDetailMap: hasDetailMap, currentNoteId: cur });
  })()`;
}

function listStateExpr() {
  return `(function(){
    var path = String(location.pathname || '');
    var cardCount = 0;
    try { cardCount = document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]').length; } catch(e) {}
    return JSON.stringify({ onSearch: /^\\/search_result(?:_ai)?\\/?$/.test(path), cardCount: cardCount, href: String(location.href || '') });
  })()`;
}

function searchScrollStateExpr() {
  return `(function(){
    var nodes=document.querySelectorAll('.ai-feeds-page,body *'),best=null;
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i],r=el.getBoundingClientRect(),max=Math.max(0,(el.scrollHeight||0)-(el.clientHeight||0));
      if(max<100||r.width<300||r.height<200)continue;
      var score=max+(String(el.className||'').indexOf('ai-feeds-page')>=0?1000000:0);
      if(!best||score>best.score)best={el:el,score:score,r:r,max:max};
    }
    if(!best)return JSON.stringify({found:false,top:Math.max(0,Math.round(window.scrollY||0)),max:0,x:500,y:500});
    return JSON.stringify({found:true,top:Math.max(0,Math.round(best.el.scrollTop||0)),max:Math.round(best.max),x:Math.round(best.r.left+best.r.width/2),y:Math.round(best.r.top+Math.min(best.r.height-80,Math.max(120,best.r.height/2)))});
  })()`;
}

function resetSearchScrollExpr() {
  return `(function(){
    var nodes=document.querySelectorAll('.ai-feeds-page,body *'),best=null;
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i],r=el.getBoundingClientRect(),max=Math.max(0,(el.scrollHeight||0)-(el.clientHeight||0));
      if(max<100||r.width<300||r.height<200)continue;
      var score=max+(String(el.className||'').indexOf('ai-feeds-page')>=0?1000000:0);
      if(!best||score>best.score)best={el:el,score:score};
    }
    if(best){best.el.scrollTop=0;try{best.el.dispatchEvent(new Event('scroll',{bubbles:true}));}catch(e){}return 'container';}
    try{window.scrollTo(0,0);}catch(e){}return 'window';
  })()`;
}

async function resetSearchListScroll({ client, target }) {
  await client.evaluate({ target, expression: resetSearchScrollExpr() });
  await sleep(650);
  return evalJson(client, target, searchScrollStateExpr());
}

function sameSearchContext(currentHref, expectedHref) {
  if (!expectedHref) return true;
  try {
    const current = new URL(currentHref);
    const expected = new URL(expectedHref);
    if (!isSearchListPath(current.pathname) || !isSearchListPath(expected.pathname)) return false;
    return decodedSearchKeyword(current.searchParams.get('keyword')) === decodedSearchKeyword(expected.searchParams.get('keyword'));
  } catch (e) {
    return false;
  }
}

function findCloseButtonExpr() {
  return `(function(){
    function attr(e, n){ try { return String(e.getAttribute(n) || ''); } catch(err) { return ''; } }
    function text(e){ try { return String(e.innerText || e.textContent || '').trim(); } catch(err) { return ''; } }
    function cls(e){ try { return String(e.className || ''); } catch(err) { return ''; } }
    function vis(r){ return r && r.width >= 12 && r.height >= 12 && r.width <= 90 && r.height <= 90 && r.bottom > 0 && r.top < (window.innerHeight || 900); }
    var els = document.querySelectorAll('button,[role="button"],[aria-label],[title],[class*="close"],[class*="Close"],div,span');
    var best = null;
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var hay = (attr(e, 'aria-label') + ' ' + attr(e, 'title') + ' ' + text(e) + ' ' + cls(e)).toLowerCase();
      var looksClose = hay.indexOf('关闭') >= 0 || hay.indexOf('close') >= 0 || hay === 'x' || hay === '×';
      if (!looksClose) continue;
      var r = null;
      try { r = e.getBoundingClientRect(); } catch(err) {}
      if (!vis(r)) continue;
      var score = r.top + Math.abs(r.left - 40) * 0.1;
      if (!best || score < best.score) best = { score: score, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return JSON.stringify(best ? { ok: true, x: best.x, y: best.y } : { ok: false, reason: 'close_button_not_found' });
  })()`;
}

async function evalJson(client, target, expression) {
  const r = await client.evaluate({ target, expression });
  return parseEvalJson(r && r.value);
}

async function waitForJson({ client, target, expression, ok, timeoutMs = 10000, intervalMs = 450 }) {
  const end = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < end) {
    last = await evalJson(client, target, expression);
    if (await ok(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function waitForList({ client, target, timeoutMs = 10000 }) {
  return waitForJson({
    client, target, expression: listStateExpr(), timeoutMs,
    ok: (s) => s.onSearch && Number(s.cardCount || 0) > 0
  });
}

async function ensureSearchList({ client, target, searchUrl, onLog = () => {} }) {
  const current = await evalJson(client, target, listStateExpr());
  if (current.onSearch && Number(current.cardCount || 0) > 0 && sameSearchContext(current.href, searchUrl)) return current;
  if (!searchUrl) throw new Error('not_on_search_list');
  // Closing a note can reveal the right result page before its virtualized card
  // list has hydrated. Going back at that moment leaves the correct search page
  // and makes the next keyword's top search box unavailable. Stay put and wait.
  if (current.onSearch && sameSearchContext(current.href, searchUrl)) {
    onLog('已回到当前关键词搜索页，等待列表恢复');
    const state = await waitForList({ client, target, timeoutMs: 15000 });
    if (state.onSearch && Number(state.cardCount || 0) > 0 && sameSearchContext(state.href, searchUrl)) return state;
    throw new Error('search_list_not_ready');
  }
  if (client.goBack) {
    onLog('通过页面历史返回该笔记所属的搜索结果页');
    await client.goBack({ target }).catch(() => {});
    const state = await waitForList({ client, target, timeoutMs: 15000 });
    if (state.onSearch && Number(state.cardCount || 0) > 0 && sameSearchContext(state.href, searchUrl)) return state;
  }
  throw new Error('search_list_not_ready');
}

async function locateNoteCard({ client, target, note, searchUrl, onLog = () => {}, maxScrollRounds = 12 }) {
  await ensureSearchList({ client, target, searchUrl, onLog });
  if (Number(note && note.scanOrder) === 0) await resetSearchListScroll({ client, target }).catch(() => {});
  async function scanDown(rounds) {
    for (let round = 0; round < rounds; round++) {
      const hit = await evalJson(client, target, findNoteCardExpr(note));
      if (hit.ok) return hit;
      const scroll = await evalJson(client, target, searchScrollStateExpr()).catch(() => ({}));
      if (Number(scroll.max) > 0 && Number(scroll.top) >= Number(scroll.max) - 20) break;
      const x = Number(scroll.x) || rand(420, 760);
      const y = Number(scroll.y) || rand(260, 560);
      await client.wheelScroll({ target, x, y, totalDeltaY: rand(520, 920) }).catch(() => {});
      await sleep(rand(650, 1400));
    }
    return null;
  }
  let hit = await scanDown(maxScrollRounds);
  if (hit) return hit;
  // A failed card leaves the virtualized list at the bottom. Without this
  // reset, every later note starts from the same dead end and fails in a row.
  onLog('当前滚动位置未找到，回到列表顶部再完整定位一次');
  await resetSearchListScroll({ client, target }).catch(() => {});
  hit = await scanDown(maxScrollRounds);
  if (hit) return hit;
  throw new Error('note_card_not_found:' + noteIdOf(note));
}

async function openNoteFromList({ client, target, note, searchUrl = note && note.searchUrl, onLog = () => {} }) {
  const noteId = noteIdOf(note);
  if (!noteId) throw new Error('note_id_required');
  let hit;
  try {
    hit = await locateNoteCard({ client, target, note, searchUrl, onLog });
  } catch (error) {
    onLog('列表定位失败(' + error.message + '),跳过本篇，不直接跳转笔记链接');
    throw error;
  }
  onLog('从搜索列表点开笔记:' + ((note && note.title) || noteId));
  await client.click({ target, x: hit.x, y: hit.y });
  await sleep(rand(900, 1600));
  const state = await waitForJson({
    client, target, expression: detailStateExpr(note), timeoutMs: 12000,
    ok: (s) => s.open || s.ready
  });
  if (!state.open && !state.ready) {
    throw new Error('note_detail_not_opened:' + noteId);
  }
  return state;
}

async function closeCurrentNote({ client, target, note = {}, searchUrl = note.searchUrl, onLog = () => {}, openedDirectly = false }) {
  if (openedDirectly && searchUrl) {
    onLog('直接返回该笔记的搜索结果页');
    await client.navigate({ target, url: searchUrl });
    await waitForList({ client, target, timeoutMs: 10000 }).catch(() => {});
    return { ok: true, method: 'navigate' };
  }
  const before = await evalJson(client, target, detailStateExpr(note));
  if (!before.open && !before.ready) {
    await ensureSearchList({ client, target, searchUrl, onLog }).catch(() => {});
    return { ok: true, alreadyClosed: true };
  }

  async function closed() {
    const list = await evalJson(client, target, listStateExpr());
    const detail = await evalJson(client, target, detailStateExpr(note));
    return list.onSearch && Number(list.cardCount || 0) > 0 && !detail.open;
  }

  const btn = await evalJson(client, target, findCloseButtonExpr());
  if (btn.ok) {
    onLog('关闭当前笔记,回到搜索列表');
    await client.click({ target, x: btn.x, y: btn.y });
    const state = await waitForJson({ client, target, expression: listStateExpr(), timeoutMs: 8000, ok: () => closed() });
    if (state.onSearch) return { ok: true, method: 'button' };
  }

  onLog('未稳定找到关闭按钮,尝试按 Escape 关闭详情');
  if (client.pressKey) await client.pressKey({ target, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(rand(600, 1100));
  if (await closed()) return { ok: true, method: 'escape' };

  if (client.goBack) {
    onLog('Escape 未关闭,尝试浏览器后退回列表');
    await client.goBack({ target }).catch(() => {});
    const state = await waitForJson({ client, target, expression: listStateExpr(), timeoutMs: 8000, ok: () => closed() });
    if (state.onSearch && await closed()) return { ok: true, method: 'back' };
  }

  throw new Error('note_detail_close_failed');
}

module.exports = {
  isSearchListPath,
  decodedSearchKeyword,
  findNoteCardExpr,
  detailStateExpr,
  listStateExpr,
  searchScrollStateExpr,
  resetSearchScrollExpr,
  resetSearchListScroll,
  findCloseButtonExpr,
  sameSearchContext,
  parseEvalJson,
  ensureSearchList,
  locateNoteCard,
  openNoteFromList,
  closeCurrentNote
};
