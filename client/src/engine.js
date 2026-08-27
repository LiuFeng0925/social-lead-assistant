'use strict';

// 引擎模块 —— 把 M1-M4 跑通的逻辑抽成可被服务/CLI 复用的函数。
// 页面内表达式直接复用已验证的(scan-clean / m3-read-notes)。

const { XhsCdpClient } = require('./cdp/xhs-cdp-client');
const { check, rejectsAgent } = require('./compliance');
const { openNoteFromList, closeCurrentNote, resetSearchListScroll } = require('./note-navigation');
const { pageSecurityReason } = require('./login-status');
const llm = require('./llm');
const inboxUtils = require('./inbox-utils');
const leadModel = require('./lead-model');

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

const EXPR_PROBE = `(function(){var c=document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]').length;return JSON.stringify({readyState:document.readyState,count:c,url:String(location.href||'')});})()`;

// 搜索页以“真实可见卡片”的屏幕坐标决定采集顺序。
// feeds 只按 note id 补充标题/作者等元数据，绝不再决定先后顺序。
const EXPR_EXTRACT = `(function(){
  function norm(v){ return String(v == null ? '' : v).replace(/\\s+/g,' ').trim(); }
  function noteId(href){ var m=String(href||'').match(/\\/(?:explore|search_result)\\/([^?/#]+)/); return m?m[1]:''; }
  function absoluteUrl(href){ try{return new URL(String(href||''),location.origin).toString();}catch(e){return String(href||'');} }
  function visibleRect(el){
    if(!el || el.offsetParent===null) return null;
    var r=el.getBoundingClientRect(), vh=window.innerHeight||900;
    if(r.width<80 || r.height<60 || r.bottom<60 || r.top>vh-45) return null;
    return r;
  }
  function cardOf(a){
    try{return a.closest('section,.note-item,li,div[class*="note-item"],div[class*="note-card"]')||a.parentElement||a;}catch(e){return a;}
  }
  function textFrom(card, selectors){
    for(var i=0;i<selectors.length;i++){
      var el=null; try{el=card.querySelector(selectors[i]);}catch(e){}
      var text=norm(el&&(el.innerText||el.textContent)); if(text)return text;
    }
    return '';
  }

  var feedArr=${FEEDS_PICK}, feedById={};
  for(var f=0;f<feedArr.length;f++){
    var item=feedArr[f]||{}, nc=item.noteCard||item.note_card||{}, user=nc.user||{}, it=nc.interactInfo||{}, cover=nc.cover||{};
    var fid=String(item.id||nc.noteId||''); if(!fid)continue;
    feedById[fid]={
      type:nc.type||'', title:nc.displayTitle||'', author:user.nickName||user.nickname||'', userId:user.userId||'',
      likes:it.likedCount!=null?it.likedCount:'', collects:it.collectedCount!=null?it.collectedCount:'', comments:it.commentCount!=null?it.commentCount:'',
      cover:cover.urlDefault||cover.urlPre||'', xsecToken:item.xsecToken||(user&&user.xsecToken)||''
    };
  }

  var anchors=[].slice.call(document.querySelectorAll('a[class*="cover"][href*="/explore/"],a[class*="cover"][href*="/search_result/"]'));
  if(!anchors.length) anchors=[].slice.call(document.querySelectorAll('a[href*="/explore/"],a[href*="/search_result/"]'));
  var out=[], seen={};
  for(var i=0;i<anchors.length;i++){
    var a=anchors[i], href=a.href||a.getAttribute('href')||'', id=noteId(href), r=visibleRect(a);
    if(!id||!r||seen[id])continue;
    seen[id]=1;
    var card=cardOf(a), meta=feedById[id]||{};
    var title=textFrom(card,['a[class*="title"]','[class*="title"]','span[class*="title"]'])||meta.title||'';
    var author=textFrom(card,['a[href*="/user/profile"]','[class*="author"]','[class*="name"]'])||meta.author||'';
    var xsec=''; try{xsec=new URL(absoluteUrl(href)).searchParams.get('xsec_token')||'';}catch(e){}
    out.push({
      id:id, type:meta.type||'', title:title, author:author, userId:meta.userId||'',
      likes:meta.likes||'', collects:meta.collects||'', comments:meta.comments||'', cover:meta.cover||'',
      xsecToken:xsec||meta.xsecToken||'', url:absoluteUrl(href),
      visualTop:Math.round(r.top), visualLeft:Math.round(r.left)
    });
  }
  return JSON.stringify({count:out.length,notes:out});
})()`;

function sortVisualNotes(notes, rowTolerance = 36) {
  return (notes || []).slice().sort((a, b) => {
    const at = Number(a && a.visualTop) || 0;
    const bt = Number(b && b.visualTop) || 0;
    const al = Number(a && a.visualLeft) || 0;
    const bl = Number(b && b.visualLeft) || 0;
    if (Math.abs(at - bt) <= rowTolerance) return al - bl || at - bt;
    return at - bt || al - bl;
  });
}

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

// 当前详情页里已经加载出来的评论。只读取 DOM，不调用或逆向平台接口。
function _commentScanFn() {
  function directReplyControl(root) {
    var controls = root.querySelectorAll('.reply.icon-container,[class~="reply"][class*="icon-container"],button,span,div');
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      if (el.offsetParent === null || (el.closest && el.closest('.comment-item') !== root)) continue;
      var classes = String(el.className || '');
      if (/(^|\s)reply(\s|$)/.test(classes) || (el.childElementCount === 0 && (el.textContent || '').trim() === '回复')) return el;
    }
    return null;
  }
  function rowFor(link) {
    var row = link && link.closest ? link.closest('.comment-item') : null;
    return row && directReplyControl(row) ? row : null;
  }
  function contentOf(row, nick) {
    var lines = String(row.innerText || '').split(/\n+/).map(function (line) { return line.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var ignored = { '回复':1, '赞':1, '作者':1, '置顶':1 };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === nick || ignored[line]) continue;
      if (/^(\d+天前|\d+小时前|\d+分钟前|刚刚|昨天|前天)(\s+\S+)?$/.test(line)) continue;
      if (/^\d+$/.test(line)) continue;
      if (/^(展开|收起)\s*\d*\s*条?回复$/.test(line)) continue;
      if (/^回复\s+[^:：]+[:：]?\s*$/.test(line)) continue;
      return line.replace(/^回复\s+[^:：]+[:：]\s*/, '').trim();
    }
    return '';
  }
  var links = document.querySelectorAll('a[href*="/user/profile"]');
  var out = [], seen = {};
  for (var i = 0; i < links.length; i++) {
    var user = links[i], box = rowFor(user);
    if (!box || box.offsetParent === null) continue;
    var nick = (user.innerText || user.textContent || '').trim();
    var content = contentOf(box, nick);
    if (!nick || !content || content === nick || content.length > 500) continue;
    var key = (user && user.getAttribute('href') || nick) + '|' + content;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ nick: nick, content: content, user_link: user.getAttribute('href') || '', is_author: /(^|\s)作者(\s|$)/.test(box.innerText || ''), can_auto_reply: !!directReplyControl(box) });
  }
  return JSON.stringify(out.slice(0, 80));
}
const SCAN_OPEN_NOTE_COMMENTS = '(' + _commentScanFn.toString() + ')()';

async function scanOpenNoteComments({ client, target }) {
  const r = await client.evaluate({ target, expression: SCAN_OPEN_NOTE_COMMENTS });
  return JSON.parse((r && r.value) || '[]');
}

function classify(note, model) {
  return leadModel.classifyNote(note, model);
}

function matchNotes(notes, cfg = {}) {
  return leadModel.classifyNotes(notes, cfg.lead_model || cfg.leadModel || cfg);
}

// 检索页只有标题，任何分类模式都不能在这里决定发布者身份。
// 本轮采集到的每一篇都进入详情页，读取标题 + 完整正文后再选择关键词或大模型分类器。
function prepareNotesForDetailClassification(notes) {
  const pending = (notes || []).map((note) => Object.assign({}, note, {
    intent: '待读取正文',
    category_name: '待读取正文',
    category_action: 'classify_detail',
    classify_reason: '检索页信息不完整，等待读取标题和正文'
  }));
  return {
    tagged: pending,
    targets: pending.slice(),
    byIntent: { '待读取正文': pending.length }
  };
}

// 兼容已接入的调用方；新代码使用更准确的函数名。
const prepareNotesForLlmClassification = prepareNotesForDetailClassification;

const NOTE_ROLE_LABELS = {
  tenant: '租户/求租者',
  supply: '房源方/转租方',
  agent: '同行/中介',
  irrelevant: '无关内容',
  uncertain: '不确定'
};

function noteClassificationDecision(classification, minConfidence = 0.65) {
  const c = llm.normalizeNoteClassification(classification);
  const label = NOTE_ROLE_LABELS[c.role] || NOTE_ROLE_LABELS.uncertain;
  let reason = c.reason || '模型未提供理由';
  let eligible = true;
  if (c.role !== 'tenant') { eligible = false; reason = `${label}：${reason}`; }
  else if (c.locationMatch === 'mismatch') { eligible = false; reason = `明确不在服务区：${reason}`; }
  else if (c.locationMatch !== 'match') { eligible = false; reason = `地点未确认属于服务区：${reason}`; }
  else if (c.confidence < minConfidence) { eligible = false; reason = `模型置信度不足：${reason}`; }
  return Object.assign({}, c, { label, eligible, decisionReason: reason });
}

// 外呼只面向笔记作者本人，且必须是已确认的求租者。
// 不把“评论区里看起来在找房的人”作为外呼对象，避免在房东或同行笔记下触达。
function shouldCommentNoteAuthor(decision) {
  return !!decision && decision.eligible === true && decision.role === 'tenant';
}

function residentialLongTermAudienceDecision(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return { eligible: true, reason: '' };
  const rentalContext = /(求租|找房|想租|要租|租房|租住|租期|出租|转租|招租)/.test(text);
  const commercialUse = /(商铺|店铺|门面房?|门脸房?|档口|摊位|写字楼|办公室|办公场地|仓库|厂房|车位|车库|商业用房|经营场所)/.test(text);
  if (rentalContext && commercialUse) {
    return { eligible: false, reason: '非目标受众：求租商业用房，不是用于居住的住宅长租' };
  }

  // 先去掉“不要短租/不接受短租”等否定表达，防止把明确要长租的人误伤。
  const withoutNegatedShortRent = text.replace(/(?:不接受|不考虑|不能|不要|不是|拒绝|非|不)\s*(?:日租|周租|短租|月租房|临时过渡)/g, '');
  const explicitShortRent = /(?:日租|周租|短租|月租房|临时过渡|过渡租)|(?:只|仅|就|计划|打算|需要|想|要|求|找|临时|过渡).{0,6}(?:租|住|租住).{0,6}(?:1|2|3|一|二|两|三)\s*个?月|(?:租期|租住时间|租多久).{0,8}(?:1|2|3|一|二|两|三)\s*个?月|(?:1|2|3|一|二|两|三)\s*个?月.{0,5}(?:短租|过渡)/.test(withoutNegatedShortRent);
  if (explicitShortRent) {
    return { eligible: false, reason: '非目标受众：明确是1到3个月短租或临时过渡，只触达住宅长租' };
  }
  return { eligible: true, reason: '' };
}

function isResidentialRentalLeadModel(model) {
  return !!(model && Array.isArray(model.categories) && model.categories.some((category) => {
    return String(category.action || '') === 'comment'
      && (/(seek_rent|tenant)/i.test(String(category.id || '')) || /(求租|租户)/.test(String(category.name || '')));
  }));
}

function applyResidentialAudienceGuard(decision, note, model) {
  if (!isResidentialRentalLeadModel(model)) return decision;
  const text = [note && note.title, note && note.desc, ...(note && Array.isArray(note.tags) ? note.tags : [])].join(' ');
  const audience = residentialLongTermAudienceDecision(text);
  if (audience.eligible) return Object.assign({}, decision, { audienceMatch: 'match' });
  return Object.assign({}, decision, {
    eligible: false,
    audienceMatch: 'mismatch',
    reason: audience.reason,
    decisionReason: audience.reason,
    evidence: audience.reason
  });
}

async function classifyNotePublisher(note, cfg = {}) {
  if (!cfg.llm_enabled || !String(cfg.llm_api_key || '').trim()) {
    return noteClassificationDecision({
      role: 'uncertain', locationMatch: 'unknown', confidence: 0,
      reason: '未启用大模型或未配置 API Key', evidence: ''
    });
  }
  let classification;
  try {
    classification = await llm.classifyNotePublisher({
      note,
      localWords: cfg.lead_local_words,
      provider: cfg.llm_provider,
      model: cfg.llm_model,
      apiKey: cfg.llm_api_key
    });
  } catch (e) {
    return Object.assign(noteClassificationDecision({
      role: 'uncertain', locationMatch: 'unknown', confidence: 0,
      reason: '大模型分类失败', evidence: ''
    }), { error: e && e.message ? e.message : String(e) });
  }

  // 明确的同行昵称是发送前的安全兜底，避免模型偶发误判后直接触达同行。
  const nick = String((note && note.author) || '').replace(/\s+/g, ' ').trim();
  if (/(贝壳找房|链家|我爱我家|麦田房产|房产|地产|置业|经纪|租房管家|公寓管家|好房推荐|好房安利)/.test(nick)) {
    classification = Object.assign({}, classification, {
      role: 'agent', confidence: Math.max(0.95, Number(classification.confidence) || 0),
      reason: `发布者昵称“${nick}”具有明确房产从业者特征`
    });
  }

  const area = serviceAreaDecision([note && note.title, note && note.desc, ...(note && Array.isArray(note.tags) ? note.tags : [])].join(' '), cfg);
  if (area.locationMatch === 'mismatch') {
    classification = Object.assign({}, classification, { locationMatch: 'mismatch', reason: area.reason });
  } else if (area.locationMatch === 'match' && classification.locationMatch === 'unknown') {
    classification = Object.assign({}, classification, { locationMatch: 'match' });
  }
  const decision = noteClassificationDecision(classification);
  const rentalModel = leadModel.normalizeLeadModel(cfg.lead_model || cfg.leadModel || cfg);
  return applyResidentialAudienceGuard(decision, note, rentalModel);
}

function isLlmNoteClassificationEnabled(cfg = {}) {
  const model = leadModel.normalizeLeadModel(cfg.lead_model || cfg.leadModel || cfg);
  return model.llmClassificationEnabled === true;
}

function roleFromCategory(category) {
  const id = String((category && category.id) || '').toLowerCase();
  const name = String((category && category.name) || '');
  if (/seek|tenant|demand/.test(id) || /求租|租户|需求方/.test(name)) return 'tenant';
  if (/supply|landlord|owner/.test(id) || /房源|房东|转租方/.test(name)) return 'supply';
  if (/agent|peer|broker/.test(id) || /中介|同行|经纪/.test(name)) return 'agent';
  if (category && category.fallback) return 'uncertain';
  return 'other';
}

function categoryClassificationDecision({ category, confidence, reason, evidence, locationMatch, demandLocation, city, district, location, matchedServiceArea, locationConfidence, locationEvidence, slotValues, method, cfg, error }) {
  const c = category || { id: 'unknown', name: '不明', action: 'record', fallback: true };
  const conf = Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : 0;
  const hasServiceAreas = Array.isArray(cfg && cfg.lead_local_words) && cfg.lead_local_words.some(Boolean);
  let eligible = String(c.action || 'skip') === 'comment';
  let decisionReason = String(reason || '未提供分类理由');
  if (!eligible) decisionReason = `${c.name || c.id}：${decisionReason}`;
  else if (locationMatch === 'mismatch') { eligible = false; decisionReason = `明确不在服务区：${decisionReason}`; }
  else if (hasServiceAreas && locationMatch !== 'match') { eligible = false; decisionReason = `地点未确认属于服务区：${decisionReason}`; }
  else if (method === 'llm' && conf < 0.65) { eligible = false; decisionReason = `模型置信度不足：${decisionReason}`; }
  return {
    categoryId: String(c.id || 'unknown'),
    categoryName: String(c.name || c.id || '不明'),
    categoryAction: String(c.action || 'skip'),
    categoryFallback: !!c.fallback,
    categoryReplyStrategy: String(c.replyStrategy || ''),
    label: String(c.name || c.id || '不明'),
    role: roleFromCategory(c),
    classificationMethod: method,
    classificationMethodLabel: method === 'llm' ? '大模型' : '关键词',
    confidence: conf,
    locationMatch: locationMatch || 'unknown',
    demandLocation: String(demandLocation || ''),
    city: String(city || ''),
    district: String(district || ''),
    location: String(location || demandLocation || ''),
    matchedServiceArea: String(matchedServiceArea || ''),
    locationConfidence: Number.isFinite(Number(locationConfidence)) ? Number(locationConfidence) : 0,
    locationEvidence: String(locationEvidence || ''),
    slotValues: slotValues && typeof slotValues === 'object' ? slotValues : {},
    reason: String(reason || ''),
    decisionReason,
    evidence: Array.isArray(evidence) ? evidence.join('、') : String(evidence || ''),
    eligible,
    error: error || ''
  };
}

function classifyDetailedNoteByKeywords(note, cfg = {}) {
  const model = leadModel.normalizeLeadModel(cfg.lead_model || cfg.leadModel || cfg);
  const tagged = leadModel.classifyNote(note, model);
  const category = model.categories.find((item) => item.id === tagged.category_id)
    || model.categories.find((item) => item.fallback)
    || model.categories[model.categories.length - 1];
  const area = serviceAreaDecision([note && note.title, note && note.desc, ...(note && Array.isArray(note.tags) ? note.tags : [])].join(' '), cfg);
  const decision = categoryClassificationDecision({
    category,
    confidence: tagged.category_confidence,
    reason: tagged.classify_reason,
    evidence: tagged.evidence,
    locationMatch: area.locationMatch,
    method: 'keyword',
    cfg
  });
  return applyResidentialAudienceGuard(decision, note, model);
}

function validateLlmLocation(raw, note, cfg = {}) {
  const sourceText = [note && note.title, note && note.desc, ...(note && Array.isArray(note.tags) ? note.tags : [])].join(' ').replace(/\s+/g, ' ').trim();
  const serviceAreas = Array.isArray(cfg.lead_local_words) ? cfg.lead_local_words.map((word) => String(word || '').trim()).filter(Boolean) : [];
  let locationMatch = ['match', 'mismatch', 'unknown'].includes(raw && raw.locationMatch) ? raw.locationMatch : 'unknown';
  let reason = String((raw && raw.reason) || '').trim() || '大模型未提供地区判断理由';
  let matchedServiceArea = String((raw && raw.matchedServiceArea) || '').trim();
  const locationConfidence = Number(raw && raw.locationConfidence) || 0;
  const rawEvidenceQuotes = raw && raw.locationEvidenceQuotes;
  const locationEvidenceQuotes = (Array.isArray(rawEvidenceQuotes) ? rawEvidenceQuotes : [raw && raw.locationEvidence])
    .map((quote) => String(quote || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3);
  const locationEvidence = locationEvidenceQuotes.join('；');
  if (!serviceAreas.length) {
    return { locationMatch: 'unknown', reason: '未配置服务区域', matchedServiceArea: '', locationConfidence: 0, locationEvidence };
  }
  const evidenceExistsInBody = locationEvidenceQuotes.some((quote) => quote.length >= 2 && sourceText.includes(quote));
  if (locationMatch === 'match') {
    const matchedAreaIsConfigured = serviceAreas.includes(String(matchedServiceArea || '').trim());
    if (!matchedAreaIsConfigured || Number(locationConfidence) < 0.75 || !evidenceExistsInBody) {
      locationMatch = 'unknown';
      matchedServiceArea = '';
      reason = `大模型地区匹配证据不足：${reason}`;
    }
  } else if (locationMatch === 'mismatch') {
    matchedServiceArea = '';
    if (Number(locationConfidence) < 0.75 || !evidenceExistsInBody) {
      locationMatch = 'unknown';
      reason = `大模型异地判断证据不足：${reason}`;
    }
  } else {
    matchedServiceArea = '';
  }
  return { locationMatch, reason, matchedServiceArea, locationConfidence, locationEvidence };
}

async function classifyDetailedNoteByLlm(note, cfg = {}) {
  const model = leadModel.normalizeLeadModel(cfg.lead_model || cfg.leadModel || cfg);
  const fallback = model.categories.find((item) => item.fallback) || model.categories[model.categories.length - 1];
  if (!cfg.llm_enabled || !String(cfg.llm_api_key || '').trim()) {
    return categoryClassificationDecision({
      category: fallback, confidence: 0, reason: '获客模型已开启大模型分类，但模型服务未启用或未配置 API Key',
      locationMatch: 'unknown', method: 'llm', cfg
    });
  }
  let raw;
  try {
    raw = await llm.classifyNoteCategory({
      note,
      localWords: cfg.lead_local_words,
      leadModel: model,
      provider: cfg.llm_provider,
      model: cfg.llm_model,
      apiKey: cfg.llm_api_key
    });
  } catch (e) {
    return categoryClassificationDecision({
      category: fallback, confidence: 0, reason: '大模型分类失败', locationMatch: 'unknown',
      method: 'llm', cfg, error: e && e.message ? e.message : String(e)
    });
  }
  const category = model.categories.find((item) => item.id === raw.categoryId) || fallback;
  let locationRaw = { locationMatch: 'unknown', matchedServiceArea: '', locationConfidence: 0, locationEvidence: '', reason: '未配置服务区域' };
  let locationError = '';
  if (Array.isArray(cfg.lead_local_words) && cfg.lead_local_words.some(Boolean)) {
    try {
      locationRaw = await llm.classifyServiceArea({
        note,
        extracted: raw,
        localWords: cfg.lead_local_words,
        provider: cfg.llm_provider,
        model: cfg.llm_model,
        apiKey: cfg.llm_api_key
      });
    } catch (e) {
      locationRaw = { locationMatch: 'unknown', matchedServiceArea: '', locationConfidence: 0, locationEvidence: '', reason: '大模型地区判断失败' };
      locationError = e && e.message ? e.message : String(e);
    }
  }
  const locationDecision = validateLlmLocation(locationRaw, note, cfg);
  const decision = categoryClassificationDecision({
    category,
    confidence: raw.confidence,
    reason: `分类：${raw.reason || '未说明'}；地区：${locationDecision.reason}`,
    evidence: raw.evidence,
    locationMatch: locationDecision.locationMatch,
    demandLocation: raw.demandLocation,
    city: raw.city,
    district: raw.district,
    location: raw.location,
    matchedServiceArea: locationDecision.matchedServiceArea,
    locationConfidence: locationDecision.locationConfidence,
    locationEvidence: locationDecision.locationEvidence,
    slotValues: raw.slotValues,
    method: 'llm',
    cfg,
    error: locationError
  });
  return applyResidentialAudienceGuard(decision, note, model);
}

async function classifyDetailedNote(note, cfg = {}) {
  return isLlmNoteClassificationEnabled(cfg)
    ? classifyDetailedNoteByLlm(note, cfg)
    : classifyDetailedNoteByKeywords(note, cfg);
}

// ── CDP 连接 ──
async function connect(endpoint, onPointer, options = {}) {
  const client = new XhsCdpClient({ endpoint: endpoint || 'http://127.0.0.1:9222', onPointer });
  const target = await client.resolvePageTarget({
    accountMarker: options.accountMarker || process.env.XHS_ACCOUNT_MARKER || ''
  });
  return { client, target };
}

function accountSecurityError(reason) {
  const error = new Error('account_security_block:' + (reason || '安全验证页面'));
  error.code = 'ACCOUNT_SECURITY_BLOCK';
  error.userMessage = reason || '安全验证页面';
  return error;
}

function isAccountSecurityError(error) {
  return !!error && (error.code === 'ACCOUNT_SECURITY_BLOCK' || /^account_security_block:/.test(String(error.message || error)));
}

async function assertNoAccountSecurityPage({ client, target }) {
  let page = {};
  try {
    const result = await client.evaluate({
      target,
      expression: 'JSON.stringify({url:String(location.href||""),title:String(document.title||"")})'
    });
    page = JSON.parse(result && result.value || '{}');
  } catch (e) { return page; }
  const reason = pageSecurityReason(page);
  if (reason) throw accountSecurityError(reason);
  return page;
}

function canReturnHomeFromSecurityPage(url) {
  try {
    const parsed = new URL(String(url || ''));
    const isXhs = parsed.hostname === 'xiaohongshu.com' || parsed.hostname.endsWith('.xiaohongshu.com');
    return isXhs && /\/website-login\/error(?:\/|$)/i.test(parsed.pathname);
  } catch (e) {
    return false;
  }
}

const SECURITY_HOME_PROBE = `(function(){
  function visible(el){if(!el||el.offsetParent===null)return false;var r=el.getBoundingClientRect();return r.width>30&&r.height>20;}
  var nodes=document.querySelectorAll('a,button,[role="button"],div,span');
  for(var i=0;i<nodes.length;i++){
    var el=nodes[i];
    if(!visible(el)||(el.textContent||'').replace(/\\s+/g,' ').trim()!=='返回首页')continue;
    var action=el.closest?(el.closest('a,button,[role="button"]')||el):el;
    if(!visible(action))continue;
    var r=action.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
  }
  return '';
})()`;

// 只对安全错误页里小红书自带的“返回首页”操作一次；返回后任务仍保持暂停。
// 扫码/验证码页不处理，避免把未完成的人工验证藏起来。
async function returnHomeFromSecurityPage({ client, target }) {
  let current = {};
  try {
    const r = await client.evaluate({ target, expression: 'JSON.stringify({url:String(location.href||""),title:String(document.title||"")})' });
    current = JSON.parse(r && r.value || '{}');
  } catch (e) { return { ok: false, reason: 'security_page_read_failed' }; }
  if (!canReturnHomeFromSecurityPage(current.url)) return { ok: false, reason: 'not_returnable_security_page' };
  let point = null;
  try { point = JSON.parse((await client.evaluate({ target, expression: SECURITY_HOME_PROBE })).value || ''); } catch (e) {}
  if (!point || !Number.isFinite(point.x)) return { ok: false, reason: 'home_button_not_found' };
  await client.click({ target, x: point.x, y: point.y });
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500);
    try {
      const r = await client.evaluate({ target, expression: 'JSON.stringify({url:String(location.href||""),title:String(document.title||"")})' });
      const page = JSON.parse(r && r.value || '{}');
      if (!pageSecurityReason(page) && /xiaohongshu\.com/i.test(page.url || '')) return { ok: true, page };
    } catch (e) {}
  }
  return { ok: false, reason: 'home_not_restored' };
}

// ── 检索 + 滚动扫全 + 干净取数 ──
function buildSearchUrl(keyword) {
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
}

function normalizeSearchKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeSearchKeyword(value) {
  let decoded = String(value || '');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (e) { break; }
  }
  return normalizeSearchKeyword(decoded);
}

function searchPageMatches(url, expectedKeyword) {
  try {
    const parsed = new URL(String(url || ''));
    const isXhs = parsed.hostname === 'xiaohongshu.com' || parsed.hostname.endsWith('.xiaohongshu.com');
    if (!isXhs || !/^\/search_result(?:_ai)?\/?$/.test(parsed.pathname)) return false;
    return decodeSearchKeyword(parsed.searchParams.get('keyword')) === normalizeSearchKeyword(expectedKeyword);
  } catch (e) {
    return false;
  }
}

function parseSearchPageProbe(value) {
  let probe = {};
  try { probe = typeof value === 'string' ? JSON.parse(value) : (value || {}); } catch (e) {}
  return {
    readyState: String(probe.readyState || ''),
    count: Math.max(0, Number(probe.count) || 0),
    url: String(probe.url || '')
  };
}

function searchPageMismatchError(keyword, actualUrl) {
  const error = new Error('search_page_mismatch:' + normalizeSearchKeyword(keyword));
  error.code = 'SEARCH_PAGE_MISMATCH';
  error.userMessage = '搜索页未正确打开，已停止采集，避免误读首页推荐';
  error.actualUrl = String(actualUrl || '');
  return error;
}

function isSearchPageMismatchError(error) {
  return !!error && (error.code === 'SEARCH_PAGE_MISMATCH' || /^search_page_mismatch:/.test(String(error.message || error)));
}

const SEARCH_INPUT_PROBE = `(function(){
  var selectors=['textarea#search-input','textarea[name="aiSearchTextarea"]','input.search-input','input#search-input','input[placeholder*="搜索"]','input[type="search"]','[role="searchbox"]'];
  for(var s=0;s<selectors.length;s++){
    var nodes=[];try{nodes=document.querySelectorAll(selectors[s]);}catch(e){}
    for(var i=0;i<nodes.length;i++){
      var el=nodes[i],r=el.getBoundingClientRect(),style=getComputedStyle(el);
      if(el.offsetParent===null||r.width<200||r.height<18||r.top<0||r.top>140||r.bottom<=0||r.right<=0||style.visibility==='hidden'||style.display==='none'||Number(style.opacity||1)<0.05)continue;
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),value:String(el.value||el.textContent||''),placeholder:String(el.placeholder||el.getAttribute('aria-label')||'')});
    }
  }
  return '';
})()`;

const SEARCH_SUBMIT_PROBE = `(function(){
  // 经典搜索页、AI 搜索页和新版单行搜索框的按钮类名不同；缺少新版
  // single-line-search-btn 会导致输入成功却无法提交，进而反复报错。
  var nodes=document.querySelectorAll('.input-box .submit-button-wrapper,.input-box .search-icon,.input-button .search-icon,.single-line-search-btn,[aria-label="搜索"],button[type="submit"]');
  for(var i=0;i<nodes.length;i++){
    var el=nodes[i],r=el.getBoundingClientRect(),style=getComputedStyle(el);
    if(el.offsetParent===null||r.width<16||r.height<16||r.bottom<=0||r.right<=0||style.visibility==='hidden')continue;
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
  }
  return '';
})()`;

function parseSearchInputProbe(value) {
  let input = null;
  try { input = typeof value === 'string' ? JSON.parse(value) : value; } catch (e) {}
  if (!input || !Number.isFinite(Number(input.x)) || !Number.isFinite(Number(input.y))) return null;
  return { x: Number(input.x), y: Number(input.y), value: String(input.value || ''), placeholder: String(input.placeholder || '') };
}

async function searchFromPageUi({ client, target, keyword, onLog = () => {} }) {
  let page = await assertNoAccountSecurityPage({ client, target });
  if (searchPageMatches(page && page.url, keyword)) {
    onLog(`当前已是该关键词的搜索结果页，直接复用:${keyword}`);
    return { reused: true, url: page.url };
  }
  let input = null;
  let escapeRecoveryTried = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const result = await client.evaluate({ target, expression: SEARCH_INPUT_PROBE }).catch(() => null);
    input = parseSearchInputProbe(result && result.value);
    if (input) break;
    if (!escapeRecoveryTried && attempt === 3 && client.pressKey) {
      escapeRecoveryTried = true;
      onLog('搜索框暂时不可用，尝试按 Escape 关闭残留的笔记详情层');
      await client.pressKey({ target, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    }
    await sleep(500);
    page = await assertNoAccountSecurityPage({ client, target });
    if (searchPageMatches(page && page.url, keyword)) {
      onLog(`搜索页已在加载中，直接等待结果:${keyword}`);
      return { reused: true, url: page.url };
    }
  }
  if (!input) throw new Error('search_input_not_found');

  onLog(`通过页面搜索框输入:${keyword}`);
  if (!client.selectAll) throw new Error('search_select_all_unavailable');
  let typed = '';
  // Xiaohongshu currently renders two overlapping search textareas and keeps
  // them in sync asynchronously.  The trusted keystrokes can already be in
  // the real editor while the textarea returned by the DOM probe is still one
  // render behind.  Give the page time to settle before rewriting or failing.
  for (let writeAttempt = 0; writeAttempt < 3; writeAttempt++) {
    const freshResult = await client.evaluate({ target, expression: SEARCH_INPUT_PROBE }).catch(() => null);
    const freshInput = parseSearchInputProbe(freshResult && freshResult.value);
    if (freshInput) input = freshInput;
    await client.click({ target, x: input.x, y: input.y });
    await sleep(rand(350, 650));
    await client.selectAll({ target });
    await sleep(rand(180, 360));
    await client.typeText({ target, text: keyword });
    for (let attempt = 0; attempt < 16; attempt++) {
      const result = await client.evaluate({ target, expression: SEARCH_INPUT_PROBE }).catch(() => null);
      const current = parseSearchInputProbe(result && result.value);
      typed = current ? normalizeSearchKeyword(current.value) : '';
      if (typed === normalizeSearchKeyword(keyword)) break;
      await sleep(250);
    }
    if (typed === normalizeSearchKeyword(keyword)) break;
    if (writeAttempt < 2) onLog('搜索框同步较慢，自动重新全选确认');
  }
  if (typed !== normalizeSearchKeyword(keyword)) {
    // One final read without more typing catches a late React state commit.
    await sleep(1500);
    const result = await client.evaluate({ target, expression: SEARCH_INPUT_PROBE }).catch(() => null);
    const current = parseSearchInputProbe(result && result.value);
    typed = current ? normalizeSearchKeyword(current.value) : '';
  }
  if (typed !== normalizeSearchKeyword(keyword)) throw new Error('search_keyword_not_entered');
  const submitResult = await client.evaluate({ target, expression: SEARCH_SUBMIT_PROBE }).catch(() => null);
  const submit = parseSearchInputProbe(submitResult && submitResult.value);
  if (!submit) throw new Error('search_submit_button_not_found');
  await client.click({ target, x: submit.x, y: submit.y });
  onLog(`已点击页面搜索按钮:${keyword}`);
  return { reused: false };
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
  const noteLimit = Math.max(1, Number(maxNotes) || 1);
  const url = buildSearchUrl(keyword);
  await searchFromPageUi({ client, target, keyword, onLog });
  let ready = false;
  let lastProbe = { readyState: '', count: 0, url: '' };
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    await assertNoAccountSecurityPage({ client, target });
    try {
      const r = await client.evaluate({ target, expression: EXPR_PROBE });
      lastProbe = parseSearchPageProbe(r && r.value);
      if (lastProbe.readyState === 'complete' && lastProbe.count > 0 && searchPageMatches(lastProbe.url, keyword)) { ready = true; break; }
    } catch (e) {}
  }
  if (!ready) {
    if (!searchPageMatches(lastProbe.url, keyword) || lastProbe.readyState !== 'complete') {
      throw searchPageMismatchError(keyword, lastProbe.url);
    }
    onLog(`搜索页已确认是当前关键词，但没有可见笔记:${keyword}`);
    return [];
  }
  try { await client.installCursor({ target }); } catch (e) {} // 先注入红点,保证后面点筛选时看得到鼠标

  try { await applyFilters({ client, target, filters, onLog }); } catch (e) { onLog('筛选应用失败(忽略):' + e.message); }
  const afterFilters = await client.evaluate({ target, expression: EXPR_PROBE }).catch(() => null);
  const filteredProbe = parseSearchPageProbe(afterFilters && afterFilters.value);
  if (!searchPageMatches(filteredProbe.url, keyword)) throw searchPageMismatchError(keyword, filteredProbe.url);
  try { await client.evaluate({ target, expression: 'window.scrollTo(0,0);"ok"' }); await sleep(500); } catch (e) {}
  onLog('按页面顺序采集:从左到右、从上到下');
  let activeSearchUrl = url;
  try {
    const current = await client.evaluate({ target, expression: 'location.href' });
    if (current && /\/search_result/.test(String(current.value || ''))) activeSearchUrl = String(current.value);
  } catch (e) {}
  const all = new Map();
  let stale = 0;
  for (let round = 0; round < maxRounds && stale < 4 && all.size < noteLimit; round++) {
    if (shouldStop()) { onLog('⏹ 收到停止,中断检索'); break; }
    const pageCheck = await client.evaluate({ target, expression: EXPR_PROBE }).catch(() => null);
    const roundProbe = parseSearchPageProbe(pageCheck && pageCheck.value);
    if (!searchPageMatches(roundProbe.url, keyword)) throw searchPageMismatchError(keyword, roundProbe.url);
    let res = { notes: [] };
    try { const r = await client.evaluate({ target, expression: EXPR_EXTRACT }); res = JSON.parse(r.value); } catch (e) {}
    const before = all.size;
    for (const n of sortVisualNotes(res.notes || [])) {
      if (all.size >= noteLimit) break;
      if (n.id && !all.has(n.id)) all.set(n.id, { ...n, searchUrl: activeSearchUrl, searchKeyword: keyword, scanOrder: all.size });
    }
    const added = all.size - before;
    onLog(`第 ${round + 1} 轮:本屏 ${res.count || 0},新增 ${added},累计 ${all.size}`);
    if (added === 0) stale++; else stale = 0;
    if (all.size >= noteLimit) break;
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
  await resetSearchListScroll({ client, target }).catch(() => {});
  return [...all.values()].slice(0, noteLimit);
}

// ── 进详情读正文 ──
async function readDetail({ client, target, note, onLog = () => {}, browse = {}, onBeforeClose = null, shouldStop = () => false }) {
  if (!note || !note.id) throw new Error('read_detail_note_required');
  const b = Object.assign({ imagesMin: 2, imagesMax: 5, bodyMin: 1500, bodyMax: 5000, cScrollMin: 2, cScrollMax: 5, cDwellMin: 1800, cDwellMax: 4500 }, browse || {});
  const openState = await openNoteFromList({ client, target, note, onLog });
  let preserveSecurityPage = false;
  try {
    for (let k = 0; k < 12; k++) { if (shouldStop()) break; await sleep(800); await assertNoAccountSecurityPage({ client, target }); const rs = await client.evaluate({ target, expression: 'document.readyState' }); if (rs && rs.value === 'complete') break; }
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
          if (shouldStop()) break;
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
        if (shouldStop()) break;
        await client.humanMove({ target, toX: rand(180, 560), toY: rand(340, 680) }).catch(() => {}); // 滚前鼠标先滑到评论区(有目的)
        await sleep(rand(300, 700));
        await client.wheelScroll({ target, x: rand(380, 640), y: rand(360, 620), totalDeltaY: rand(300, 700) }).catch(() => {});
        onLog(`  往下读评论 ${k + 1}/${cs}`);
        await sleep(rand(b.cDwellMin, b.cDwellMax)); // 滑动后停留读(已加长)
        if (Math.random() < 0.6) { await client.humanMove({ target, toX: rand(160, 520), toY: rand(320, 720) }).catch(() => {}); await sleep(rand(500, 1200)); } // 偶尔鼠标再滑,像在看某条评论
      }
    } catch (e) {}
    try {
      if (shouldStop()) return detail;
      detail.commentsList = await scanOpenNoteComments({ client, target });
      onLog(`  读取到评论区留言 ${detail.commentsList.length} 条`);
    } catch (e) { detail.commentsList = []; }
    if (onBeforeClose && !shouldStop()) { try { await onBeforeClose({ client, target, note, detail }); } catch (e) {} } // 浏览完、关闭前:自动评论在这里评
    return detail;
  } catch (error) {
    preserveSecurityPage = isAccountSecurityError(error);
    throw error;
  } finally {
    if (!preserveSecurityPage) await closeCurrentNote({ client, target, note, onLog, openedDirectly: !!(openState && openState.openedDirectly) });
  }
}

// ── 生成评论 · 内置话术模板(读对方正文+诉求,多套句式按笔记轮换、不雷同;direction 是给 LLM 的指令,模板用不上)──
function _hash(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }
function _pick(arr, seed) { return arr[Math.abs(seed) % arr.length]; }
function buildCommentDirection(note, direction) {
  const strategy = String((note && (note.category_reply_strategy || note.categoryReplyStrategy || note.replyStrategy)) || '').trim();
  const globalDirection = String(direction || '').trim();
  const parts = [];
  if (strategy) parts.push(strategy);
  if (globalDirection && globalDirection !== strategy) parts.push(globalDirection);
  return parts.join('；') || '友好回应对方诉求,引导看主页/私聊,绝不留联系方式';
}

const LOCATION_RULES = [
  { name: '望京SOHO', city: '北京', type: '地标/商圈', nearby: ['望京', '望京SOHO', '望京南', '望京西', '阜通', '东湖渠', '来广营附近'] },
  { name: '望京南', city: '北京', type: '地铁站/邻近区域', nearby: ['望京', '望京SOHO', '望京南', '望京西', '阜通', '东湖渠', '来广营附近'] },
  { name: '望京西', city: '北京', type: '地铁站/邻近区域', nearby: ['望京', '望京SOHO', '望京南', '望京西', '阜通', '东湖渠', '来广营附近'] },
  { name: '东湖渠', city: '北京', type: '地铁站/邻近区域', nearby: ['望京', '望京SOHO', '望京南', '望京西', '阜通', '东湖渠', '来广营附近'] },
  { name: '来广营', city: '北京', type: '邻近区域', nearby: ['望京', '望京SOHO', '望京南', '望京西', '阜通', '东湖渠', '来广营附近'] },
  { name: '阜通', city: '北京', type: '地铁站/邻近区域', nearby: ['望京', '望京SOHO', '望京南', '望京西', '阜通', '东湖渠', '来广营附近'] },
  { name: '望京', city: '北京', type: '商圈/区域', nearby: ['望京', '望京SOHO', '望京南', '望京西', '阜通', '东湖渠', '来广营附近'] },
  { name: '朝阳大悦城', city: '北京', type: '商圈/地标', nearby: ['朝阳大悦城', '青年路', '十里堡', '高碑店', '四惠', '常营'] },
  { name: '团结湖', city: '北京', type: '商圈/地铁站', nearby: ['团结湖', '三里屯', '农业展览馆', '呼家楼', '亮马桥'] },
  { name: '国贸', city: '北京', type: '商圈/地铁站', nearby: ['国贸', '大望路', '双井', '永安里', '建国门'] },
  { name: '三里屯', city: '北京', type: '商圈/区域', nearby: ['三里屯', '团结湖', '农业展览馆', '东直门', '亮马桥'] },
  { name: '双井', city: '北京', type: '商圈/地铁站', nearby: ['双井', '九龙山', '劲松', '国贸', '广渠门外'] },
  { name: '朝阳', city: '北京', type: '行政区', nearby: ['朝阳', '望京', '国贸', '三里屯', '双井', '青年路'] },
];

function commentHay(note) {
  const tags = Array.isArray(note && note.tags) ? note.tags.join(' ') : '';
  return [note && note.title, note && note.desc, tags].map((x) => String(x || '')).join(' ');
}

function detectLocation(text) {
  const sorted = LOCATION_RULES.slice().sort((a, b) => b.name.length - a.name.length);
  return sorted.find((r) => String(text || '').includes(r.name)) || null;
}

function detectBudget(text) {
  const s = String(text || '');
  const m = s.match(/(\d[\d,]{2,5})\s*(元|块)/) || s.match(/(\d(\.\d)?)\s*[kK千]/) || s.match(/预算\s*(\d[\d,]{2,5})/);
  return m ? m[0].replace(/[,]/g, '') : '';
}

function detectRoomType(text) {
  const s = String(text || '');
  if (/三居|3居|三室/.test(s)) return '三居';
  if (/两居|2居|两室|二居/.test(s)) return '两居';
  if (/一居|1居|一室/.test(s)) return '一居';
  if (/单间|主卧|次卧/.test(s)) return '单间';
  if (/开间/.test(s)) return '开间';
  return '';
}

function detectCommute(text) {
  const s = String(text || '');
  if (/地铁|近地铁|轨交/.test(s)) return '近地铁';
  if (/通勤|上班|公司/.test(s)) return '通勤';
  return '';
}

function inferCity(text, cfg, location) {
  const ctx = [text, cfg && cfg.task_keyword].map((x) => String(x || '')).join(' ');
  if (/北京|朝阳|望京|国贸|三里屯|双井|团结湖/.test(ctx)) return '北京';
  return (location && location.city) || '未知';
}

function analyzeCommentNeed(note, cfg = {}) {
  const text = commentHay(note);
  const location = detectLocation(text);
  const budget = detectBudget(text);
  const roomType = detectRoomType(text);
  const commute = detectCommute(text);
  const intent = /求租|找房|求房|想租|要租|租房|求推荐|蹲|有没有|预算/.test(text) ? '求租' : '未知';
  const missing = [];
  if (!budget) missing.push('预算');
  if (!roomType) missing.push('户型');
  if (!commute) missing.push('通勤/地铁要求');
  const city = inferCity(text, cfg, location);
  let mode = 'probe';
  if (intent === '求租' && location && budget && roomType) mode = 'full_match';
  else if (intent === '求租' && location) mode = 'semi_match';
  return {
    intent,
    location: location ? location.name : '未知',
    locationType: location ? location.type : '未知',
    city,
    budget: budget || '未知',
    roomType: roomType || '未知',
    commute: commute || '未知',
    nearbyLocations: location ? location.nearby.slice() : [],
    missing,
    mode,
  };
}

function formatCommentContext(analysis) {
  const a = analysis || {};
  const nearby = (a.nearbyLocations || []).length ? a.nearbyLocations.join('、') : '暂无';
  return [
    '系统能确定的只有:',
    '- 意向: ' + (a.intent || '未知'),
    '- 地点: ' + (a.location || '未知'),
    '- 地点粒度: ' + (a.locationType || '未知') + ((a.locationType && a.locationType !== '未知') ? ',不是具体小区' : ''),
    '- 预算: ' + (a.budget || '未知'),
    '- 户型: ' + (a.roomType || '未知'),
    '- 通勤/地铁要求: ' + (a.commute || '未知'),
    '',
    '判断逻辑:',
    '1. 先把地点识别成槽位,例如 location = ' + (a.location || '未知') + ', location_type = ' + (a.locationType || '未知') + ', city = ' + (a.city || '未知') + '。',
    '2. 房源库检索时先用地点做第一层召回,优先找: ' + nearby + '。',
    '3. 预算/户型未知时不要硬筛,不要脑补预算/户型;可以选地点贴近、展示质量较好、可沟通空间大的房源作为候选,但评论里要追问缺失信息。',
    '4. 评论应使用半匹配话术,比如: “' + (a.location && a.location !== '未知' ? a.location : '这边') + '这边我有几套在看,近地铁和商圈附近的都有。你大概预算和想要几居呀?”',
    '不要直接说: “我这有一套' + (a.location && a.location !== '未知' ? a.location : '附近') + '6500一居,特别适合你”。'
  ].join('\n');
}

function genComment(note, direction) {
  const title = note.title || '';
  const desc = note.desc || '';
  const hay = commentHay(note);
  const analysis = (note && note.comment_analysis) || analyzeCommentNeed(note || {});
  const region = (analysis.location && analysis.location !== '未知') ? analysis.location : (note.region || '你说的那一片');
  const hu = analysis.roomType && analysis.roomType !== '未知' ? analysis.roomType : '';
  const budget = analysis.budget && analysis.budget !== '未知' ? analysis.budget : '';
  const need = /地铁|通勤|上班|公司/.test(hay) ? '通勤' : /拎包|家电|家具|齐全|押一付一|随时入住|短租/.test(hay) ? '拎包入住' : /独卫|朝南|采光|阳台|精装|新装修/.test(hay) ? '居住体验' : '';
  if (analysis.mode === 'semi_match' && region !== '你说的那一片' && (!hu || !budget)) {
    const seed = _hash(note.id || title);
    const opens = [region + '这边我有几套在看,', '看你在找' + region + '附近,', region + '这块可以帮你看看,'];
    const asks = (!hu && !budget)
      ? ['你大概预算和想要几居呀?', '预算和户型大概怎么想的呀?', '你想要几居、预算多少呀?']
      : (!budget ? ['你大概预算多少呀?', '预算大概卡在哪个范围呀?'] : ['你想要几居或单间呀?', '户型这块想看几居呀?']);
    const ends = ['合适我再帮你挑~', '合适的话再给你细看~', '我按这个给你筛一下~'];
    return _pick(opens, seed) + _pick(asks, seed >> 3) + _pick(ends, seed >> 6);
  }
  const huP = hu ? ('的' + hu) : '的房子';
  const budP = budget ? ('预算' + budget + '左右的话,') : '';
  const seed = _hash(note.id || title);
  const opens = ['看你在找' + region + huP + '呀~', region + '这边' + huP + '我刚好有~', '同找' + region + '?我手上有几套' + huP + '~', '刷到你找' + region + huP + ',来对人啦~'];
  const mids = [budP + '有挺合适的,', budP + '正好对得上,', need ? ('看你看重' + need + ',我这几套挺搭,') : (budP + '房子都挺新,')];
  const ends = ['主页有实拍,合适私聊我聊细节~', '主页能看实拍图,觉得行私我~', '图和细节都在主页,合适咱私聊~', '想看图主页有,私聊我帮你挑~'];
  return _pick(opens, seed) + _pick(mids, seed >> 3) + _pick(ends, seed >> 6);
}
// 评论生成统一入口:开了 LLM 且填了 key → 大模型按对方正文+你的方向生成;否则回退内置话术模板。失败也回退,不阻断。
async function makeComment(note, direction, cfg) {
  cfg = cfg || {};
  const analysis = analyzeCommentNeed(note, cfg);
  const noteWithContext = Object.assign({}, note || {}, { comment_analysis: analysis, comment_context: formatCommentContext(analysis) });
  const effectiveDirection = buildCommentDirection(noteWithContext, direction);
  if (cfg.llm_enabled && cfg.llm_api_key) {
    try {
      const c = await llm.genComment({ note: noteWithContext, direction: effectiveDirection, provider: cfg.llm_provider, model: cfg.llm_model, apiKey: cfg.llm_api_key });
      if (c && c.length >= 4 && check(c).ok) return c;
    } catch (e) { /* 回退模板 */ }
  }
  return genComment(noteWithContext, effectiveDirection);
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
// 筛选面板里的选项芯片(排序/类型/时间/范围都是 div.tags),按精确文字找,返回坐标+是否已选中
function FIND_TAG(label) {
  const j = JSON.stringify(label);
  return '(function(){var want=' + j + ';var nodes=document.querySelectorAll(".filter-panel div.tags");var best=null;'
    + 'for(var i=0;i<nodes.length;i++){var e=nodes[i],s=getComputedStyle(e);if((e.textContent||"").trim()!==want)continue;if(e.offsetParent===null||e.getAttribute("aria-hidden")==="true"||s.visibility==="hidden"||s.display==="none"||Number(s.opacity||1)<0.05)continue;'
    + 'var r=e.getBoundingClientRect();if(r.width<=20||r.height<=15||r.bottom<=0||r.right<=0)continue;'
    + 'var active=((e.className||"").toString().indexOf("active")>=0);'
    + 'if(!best||r.top<best.top)best={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),active:active};}'
    + 'return best?JSON.stringify(best):"";})()';
}
// 选中筛选项:对"可见"的那个芯片派发完整 指针+鼠标 事件序列(React 最认这个;比单纯 e.click() 可靠),坐标真鼠标会把面板碰收起所以不能用
function JS_CLICK_TAG(label) {
  const j = JSON.stringify(label);
  return '(function(){var want=' + j + ';var n=document.querySelectorAll("div[class*=tags]");for(var i=0;i<n.length;i++){var e=n[i];if((e.textContent||"").trim()!==want)continue;if(e.offsetParent===null)continue;'
    + 'var r=e.getBoundingClientRect();var cx=r.left+r.width/2,cy=r.top+r.height/2;var tg=document.elementFromPoint(cx,cy)||e;'
    + 'var P=window.PointerEvent||MouseEvent;var o={bubbles:true,cancelable:true,composed:true,view:window,clientX:cx,clientY:cy,button:0};'
    + 'function fire(el,ty,C){try{el.dispatchEvent(new C(ty,o));}catch(_){try{el.dispatchEvent(new MouseEvent(ty,o));}catch(__){}}}'
    + 'fire(tg,"pointerdown",P);fire(tg,"mousedown",MouseEvent);fire(tg,"pointerup",P);fire(tg,"mouseup",MouseEvent);fire(tg,"click",MouseEvent);'
    + 'return "ok";}return "no";})()';
}
// 校验某项是否已选中(active)
function TAG_ACTIVE(label) {
  const j = JSON.stringify(label);
  return '(function(){var want=' + j + ';var n=document.querySelectorAll(".filter-panel div.tags");for(var i=0;i<n.length;i++){var e=n[i],s=getComputedStyle(e);if((e.textContent||"").trim()!==want)continue;if(e.offsetParent===null||e.getAttribute("aria-hidden")==="true"||s.visibility==="hidden"||s.display==="none"||Number(s.opacity||1)<0.05)continue;return (e.className||"").toString().indexOf("active")>=0?"YES":"no";}return "gone";})()';
}
// 当前已选中的非默认项汇总(给日志,证明真生效;只看可见面板)
const ACTIVE_SUMMARY = '(function(){var n=document.querySelectorAll(".filter-panel div.tags");var a=[];for(var i=0;i<n.length;i++){var e=n[i],s=getComputedStyle(e);if(e.offsetParent===null||e.getAttribute("aria-hidden")==="true"||s.visibility==="hidden"||s.display==="none"||Number(s.opacity||1)<0.05)continue;var t=(e.textContent||"").trim();if(t&&t!=="不限"&&t!=="综合"&&(e.className||"").toString().indexOf("active")>=0&&a.indexOf(t)<0)a.push(t);}return a.join("、");})()';
async function clickFilterPoint({ client, target, x, y }) {
  const X = Math.round(Number(x)), Y = Math.round(Number(y));
  if (!Number.isFinite(X) || !Number.isFinite(Y)) return false;
  await client.humanMove({ target, toX: X, toY: Y }).catch(() => {});
  if (client.sendCommandSequence) {
    await client.sendCommandSequence({
      target,
      timeoutMs: 2500,
      commands: [
        { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1 }, delayAfterMs: 80 },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: X, y: Y, button: 'left', clickCount: 1 } }
      ]
    });
  } else {
    await client.click({ target, x: X, y: Y });
  }
  return true;
}
// 慢动作可见点选:红点慢慢移过去(看得见)→ JS 点选一次(只点一次,小红书是"点一下切换",多点会切回去)
async function pickTagOnce({ client, target, label, onLog }) {
  const r = await client.evaluate({ target, expression: FIND_TAG(label) });
  let p = null; try { p = JSON.parse((r && r.value) || ''); } catch (e) {}
  if (!p) { onLog('筛选·没找到「' + label + '」'); return; }
  if (p.active) { onLog('筛选·「' + label + '」已是选中'); return; }
  await clickFilterPoint({ client, target, x: p.x, y: p.y });
  onLog('筛选·点了「' + label + '」');
  await sleep(rand(1000, 1500));
}
async function findFilterBtn({ client, target }) {
  const expression = '(function(){var e=document.querySelector(".search-layout__top .filter");if(!e)return "";var r=e.getBoundingClientRect(),s=getComputedStyle(e);if(e.offsetParent===null||r.width<30||r.height<20||s.visibility==="hidden"||Number(s.opacity||1)<0.05)return "";return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()';
  const r = await client.evaluate({ target, expression });
  let p = null; try { p = JSON.parse((r && r.value) || ''); } catch (e) {}
  return (p && Number.isFinite(p.x)) ? p : null;
}
async function panelOpen({ client, target }) {
  const r = await client.evaluate({ target, expression: '(function(){var e=document.querySelector(".filter-panel");if(!e)return 0;var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>200&&r.height>100&&r.bottom>0&&r.right>0&&s.visibility!=="hidden"&&s.display!=="none"&&Number(s.opacity||1)>=0.05?1:0;})()' });
  return !!(r && Number(r.value) > 0);
}
async function findFilterCloseBtn({ client, target }) {
  const expression = '(function(){var n=document.querySelectorAll(".filter-panel .operation");for(var i=0;i<n.length;i++){var e=n[i],s=getComputedStyle(e),r=e.getBoundingClientRect(),t=(e.textContent||"").replace(/\\s+/g," ").trim();if(t.indexOf("收起")<0||e.getAttribute("aria-hidden")==="true"||s.visibility==="hidden"||s.display==="none"||Number(s.opacity||1)<0.05||r.width<30||r.height<20)continue;return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}return "";})()';
  const r = await client.evaluate({ target, expression });
  let p = null; try { p = JSON.parse((r && r.value) || ''); } catch (e) {}
  return (p && Number.isFinite(p.x)) ? p : null;
}
// 按文字找可见元素,派发完整 指针+鼠标 事件序列(用来点「筛选」入口,比真鼠标坐标点击稳)
function JS_CLICK_TEXT(text) {
  const j = JSON.stringify(text);
  return '(function(){var want=' + j + ';var n=document.querySelectorAll("span,div,button,a");var best=null;'
    + 'for(var i=0;i<n.length;i++){var e=n[i];if((e.textContent||"").trim()!==want)continue;if(e.offsetParent===null)continue;var r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)continue;if(!best||(e.textContent||"").length<=(best.textContent||"").length)best=e;}'
    + 'if(!best)return "no";var r=best.getBoundingClientRect();var cx=r.left+r.width/2,cy=r.top+r.height/2;var tg=document.elementFromPoint(cx,cy)||best;'
    + 'var P=window.PointerEvent||MouseEvent;var o={bubbles:true,cancelable:true,composed:true,view:window,clientX:cx,clientY:cy,button:0};'
    + 'function fire(el,ty,C){try{el.dispatchEvent(new C(ty,o));}catch(_){try{el.dispatchEvent(new MouseEvent(ty,o));}catch(__){}}}'
    + 'fire(tg,"pointerdown",P);fire(tg,"mousedown",MouseEvent);fire(tg,"pointerup",P);fire(tg,"mouseup",MouseEvent);fire(tg,"click",MouseEvent);return "ok";})()';
}
// 健壮地点开筛选面板:只用精确的真鼠标点击，不命中透明注入副本。
async function openFilterPanel({ client, target, onLog }) {
  for (let k = 0; k < 4; k++) {
    if (await panelOpen({ client, target })) return true;
    const fb = await findFilterBtn({ client, target });
    if (fb) await clickFilterPoint({ client, target, x: fb.x, y: fb.y }).catch(() => {});
    await sleep(rand(1100, 1700));
  }
  return await panelOpen({ client, target });
}
async function applyFilters({ client, target, filters = {}, onLog = () => {} }) {
  const want = (v, def) => (v && v !== def ? v : null);
  const picks = [['排序', want(filters.sort, '综合')], ['类型', want(filters.noteType, '不限')], ['时间', want(filters.noteTime, '不限')], ['范围', want(filters.noteRange, '不限')]].filter((x) => x[1]);
  if (!picks.length) { onLog('筛选:全部默认,无需设置'); return; }
  // 新版页面选择一项后可能重绘面板，每项前都重新确认它确实开着。
  const wantLabels = picks.map((x) => x[1]);
  let announcedOpen = false;
  for (const [dim, label] of picks) {
    if (!(await openFilterPanel({ client, target, onLog }))) { onLog('筛选:面板没打开,跳过「' + label + '」'); continue; }
    if (!announcedOpen) { onLog('筛选:已点开筛选面板'); announcedOpen = true; }
    await pickTagOnce({ client, target, label, onLog });
  }
  // 2.5) 读一次真实生效状态;只对"确实没生效"的补点一次(避免重复点把已选的切回去)
  await sleep(rand(400, 700));
  await openFilterPanel({ client, target, onLog }).catch(() => false);
  let summary = ''; try { summary = (await client.evaluate({ target, expression: ACTIVE_SUMMARY })).value || ''; } catch (e) {}
  const missing = wantLabels.filter((l) => summary.indexOf(l) < 0);
  for (const label of missing) {
    onLog('筛选·「' + label + '」没生效,补点一次');
    if (await openFilterPanel({ client, target, onLog })) await pickTagOnce({ client, target, label, onLog });
  }
  if (missing.length) {
    await openFilterPanel({ client, target, onLog }).catch(() => false);
    try { summary = (await client.evaluate({ target, expression: ACTIVE_SUMMARY })).value || ''; } catch (e) {}
  }
  // 逐项如实汇报(以真实生效状态为准)
  for (const label of wantLabels) { onLog(summary.indexOf(label) >= 0 ? ('筛选·「' + label + '」✓ 已生效') : ('筛选·「' + label + '」✗ 没选上')); }
  onLog(summary ? ('筛选已生效:' + summary + '(结果列表已按此过滤)') : '筛选:没有选项生效(可能页面改版)');
  // 3) 点击面板自带的「收起」，避免遮挡后续笔记卡片。
  if (await panelOpen({ client, target })) {
    const close = await findFilterCloseBtn({ client, target });
    if (close) await clickFilterPoint({ client, target, x: close.x, y: close.y }).catch(() => {});
  }
  await sleep(rand(1500, 2400));
}

// ── 承接:抓「评论和@」通知 ── 在浏览器里跑(用 .toString 嵌入,免转义),解析每条:昵称/类型/内容/日期/主页/可回复
function _inboxScanFn() {
  var ACT = [['回复了你的评论', 'reply'], ['评论了你的笔记', 'comment'], ['评论了你的评论', 'reply'], ['提到了你', 'mention']];
  var BAD_LINE = { '回复': 1, '作者': 1, '你的关注': 1, '你的粉丝': 1 };
  function cleanHref(h) { return String(h || '').split('?')[0]; }
  var links = document.querySelectorAll('a[href*="/user/profile"]');
  var out = [], seen = {};
  for (var i = 0; i < links.length; i++) {
    var L = links[i]; var nick = (L.textContent || '').trim();
    if (!nick || nick === '我') continue;
    var box = L; for (var k = 0; k < 7 && box; k++) { box = box.parentElement; if (box && /回复了你|评论了你|提到了你/.test(box.innerText || '')) break; }
    if (!box) continue;
    var txt = (box.innerText || '').replace(/ /g, ' ');
    var type = '', actStr = ''; for (var a = 0; a < ACT.length; a++) { if (txt.indexOf(ACT[a][0]) >= 0) { type = ACT[a][1]; actStr = ACT[a][0]; break; } }
    if (!type) continue;
    var href = L.getAttribute('href') || '';
    var attrDate = '';
    try {
      var dated = box.querySelector('time,[datetime],[title],[data-time],[data-timestamp]');
      if (dated) attrDate = dated.getAttribute('datetime') || dated.getAttribute('title') || dated.getAttribute('data-time') || dated.getAttribute('data-timestamp') || '';
    } catch (e) {}
    var dm = txt.match(/(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|刚刚|今天|昨天|\d+\s*(秒|分钟|小时|天)前)/); var date = attrDate || (dm ? dm[0] : '');
    var source = '';
    try {
      var as = box.querySelectorAll('a[href]');
      for (var x = 0; x < as.length; x++) { var ah = as[x].getAttribute('href') || ''; if (ah.indexOf('/explore/') >= 0 || ah.indexOf('/search_result/') >= 0) { source = cleanHref(ah); break; } }
    } catch (e) {}
    var lines = txt.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    var content = '', basis = '';
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j];
      if (ln === nick || ln.indexOf(actStr) >= 0 || ln === '回复' || ln === '作者' || /^(刚刚|今天|昨天|\d+\s*(秒|分钟|小时|天)前|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/.test(ln)) continue;
      if (!content && !BAD_LINE[ln]) { content = ln; continue; }
      if (!basis && ln !== content) basis = ln;
    }
    var key = type + '|' + cleanHref(href) + '|' + content + '|' + source; if (seen[key]) continue; seen[key] = 1;
    out.push({ nick: nick, type: type, content: content, basis_text: basis, raw_text: txt, date: date, link: cleanHref(href), source_key: source, note_url: source, canReply: /\n回复$/.test(txt) });
  }
  return JSON.stringify(out);
}
const SCAN_INBOX = '(' + _inboxScanFn.toString() + ')()';
// recentDays>0：只要近 N 天的；通知是新→旧排列，滚到已经超出窗口就停，不用把老的全读一遍
const FIND_NOTIF_ICON = '(function(){var as=document.querySelectorAll(\'a[href="/notification"]\');for(var i=0;i<as.length;i++){var a=as[i];if(a.offsetParent===null)continue;var r=a.getBoundingClientRect();if(r.width>0&&r.height>0)return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});}return "";})()';
async function scanInbox({ client, target, onLog = () => {}, max = 40, recentDays = 0 }) {
  await assertNoAccountSecurityPage({ client, target });
  let cur = ''; try { cur = String((await client.evaluate({ target, expression: 'location.href' })).value || ''); } catch (e) {}
  if (cur.indexOf('notification') < 0) {
    // 拟人:鼠标滑到底部「通知」图标 → 点击进入(不直接跳 URL)
    let nav = null; try { nav = JSON.parse((await client.evaluate({ target, expression: FIND_NOTIF_ICON })).value || ''); } catch (e) {}
    if (nav && Number.isFinite(nav.x)) {
      onLog('鼠标移到「通知」并点击…');
      await client.humanMove({ target, toX: nav.x, toY: nav.y }).catch(() => {});
      await sleep(rand(350, 800));
      await client.click({ target, x: nav.x, y: nav.y }).catch(() => {});
    } else {
      onLog('进通知页,看「评论和@」…');
      await client.navigate({ target, url: 'https://www.xiaohongshu.com/notification' });
    }
  }
  for (let k = 0; k < 14; k++) { await sleep(1000); await assertNoAccountSecurityPage({ client, target }); try { const rs = await client.evaluate({ target, expression: 'document.readyState' }); if (rs && rs.value === 'complete') break; } catch (e) {} }
  await sleep(rand(2500, 3800));
  try { await client.installCursor({ target }); } catch (e) {}
  let items = [];
  for (let round = 0; round < 6 && items.length < max; round++) {
    try { const r = await client.evaluate({ target, expression: SCAN_INBOX }); items = JSON.parse(r.value || '[]'); } catch (e) {}
    if (items.length >= max) break;
    // 已经滚到"超出近 N 天"的老评论了，停止往下翻
    if (recentDays > 0 && items.length && inboxUtils.shouldStopForRecentWindow(items[items.length - 1].date, recentDays)) break;
    // 拟人:滚动前鼠标先滑到内容区(和浏览页面同款)
    await client.humanMove({ target, toX: rand(260, 680), toY: rand(340, 640) }).catch(() => {});
    await sleep(rand(250, 600));
    await client.wheelScroll({ target, x: rand(400, 700), y: rand(360, 600), totalDeltaY: rand(500, 900) }).catch(() => {});
    await sleep(rand(900, 1500));
  }
  if (recentDays > 0) items = items.filter(function (it) {
    var parsed = inboxUtils.parseNotificationTime(it.date);
    return !Number.isFinite(parsed.daysAgo) || parsed.daysAgo <= recentDays;
  });
  onLog('收件:解析到 ' + items.length + ' 条' + (recentDays > 0 ? '(近 ' + recentDays + ' 天)' : ''));
  return items.slice(0, max);
}
// ── 承接:意向判定（关键词可配）──
function inboxIntent(content, cfg) {
  content = content || ''; cfg = cfg || {};
  if ((cfg.reply_hot_words || []).some(function (w) { return content.indexOf(w) >= 0; })) return 'hot';   // 高意向：想加微/要联系方式
  if ((cfg.reply_intent_words || []).some(function (w) { return content.indexOf(w) >= 0; })) return 'seek'; // 有意向：求租相关
  return 'other';
}
function inboxBlocked(content, cfg) { content = content || ''; return ((cfg && cfg.reply_black_words) || []).some(function (w) { return content.indexOf(w) >= 0; }); }
// 这条该不该回（范围 + 黑词 + 意向过滤 + 内容有效）
function shouldReply(item, cfg) {
  cfg = cfg || {};
  if (item.can_auto_reply === false || inboxUtils.invalidIncomingReason(item.content)) return false;
  if (item.type === 'comment' && cfg.reply_scope_comment === false) return false;
  if (item.type === 'reply' && cfg.reply_scope_reply === false) return false;
  if (item.type === 'mention' && cfg.reply_scope_mention === false) return false;
  if (!item.content || item.content === '原评论已删除') return false;
  if (inboxBlocked(item.content, cfg)) return false;
  if (cfg.reply_only_intent && inboxIntent(item.content, cfg) === 'other') return false;
  return true;
}
// 回复话术（按意向多套轮换；红线：绝不留明文联系方式）
function replyTemplate(item, intent) {
  const seed = _hash((item.nick || '') + (item.content || ''));
  const hot = ['可以呀~我主页有实拍房源和详情，点我头像进主页看看，合适直接私聊我细聊哈~', '没问题~主页有图有细节，先看看合不合适，私聊我帮你安排~', '方便的~你点我主页能看到房源实拍，合适咱私聊聊细节~'];
  const seek = ['在的~你大概什么预算、想租哪一片？主页有几套实拍，先看看合不合适，私聊我帮你挑~', '看到啦~说下你的预算和区域，主页有实拍房源，对得上咱私聊细聊~', '有的~你是要整租还是合租呀？主页有图，合适私聊我给你推~'];
  const other = ['看到你的留言啦~有租房需要可以看我主页或私聊我哈~', '收到~需要找房的话我主页有实拍，私聊我也行~', '嗯嗯~有需要随时看我主页或私聊我~'];
  const arr = intent === 'hot' ? hot : intent === 'seek' ? seek : other;
  return _pick(arr, seed);
}
async function makeReply(item, cfg) {
  cfg = cfg || {};
  const intent = inboxIntent(item.content, cfg);
  if (cfg.llm_enabled && cfg.llm_api_key) {
    try {
      const dir = (cfg.reply_direction || '友好回应对方诉求，引导看主页/私聊详聊，绝不留联系方式') + (intent === 'hot' ? '；对方想要联系方式，礼貌引导去主页/私聊，不要直接给微信电话' : '');
      const c = await llm.genComment({ note: { title: '(对方对我的评论)', desc: item.content, tags: [] }, direction: dir, provider: cfg.llm_provider, model: cfg.llm_model, apiKey: cfg.llm_api_key });
      if (c && c.length >= 3 && check(c).ok) return c;
    } catch (e) {}
  }
  return replyTemplate(item, intent);
}

// ── 承接：通知红点检测（纯读 DOM，不动鼠标）──
async function hasUnread({ client, target }) {
  const EXPR = '(function(){var a=document.querySelector(\'a[href="/notification"]\');if(!a)return "noicon";var bc=a.querySelector(\'[class*=badge]\');if(!bc)return "nobadge";var txt=(bc.textContent||"").trim();var extra=bc.children.length>1;return (extra||/[0-9]/.test(txt))?"unread":"read";})()';
  try { const r = await client.evaluate({ target, expression: EXPR }); return r && r.value === 'unread'; } catch (e) { return false; }
}

// ── 承接：在通知页定位某条的「回复」按钮，返回坐标（不点，点击交给真鼠标 humanMove+click）──
function _replyFindFn(nick, head) {
  var links = document.querySelectorAll('a[href*="/user/profile"]');
  for (var i = 0; i < links.length; i++) {
    var L = links[i]; if ((L.textContent || '').trim() !== nick) continue;
    var box = L; for (var k = 0; k < 7 && box; k++) { box = box.parentElement; if (box && /回复了你|评论了你|提到了你/.test(box.innerText || '')) break; }
    if (!box) continue;
    if (head && (box.innerText || '').indexOf(head) < 0) continue;
    var rep = null, sp = box.querySelectorAll('button,span,div');
    for (var j = 0; j < sp.length; j++) {
      var e = sp[j]; if (e.offsetParent === null || (e.textContent || '').trim() !== '回复') continue;
      // 当前页面是 action-reply > action-text；点完整按钮比点内层文字稳定。
      var action = e.closest ? e.closest('.action-reply') : null;
      rep = action && action.offsetParent !== null ? action : e;
      break;
    }
    if (!rep) return 'norep';
    var r = rep.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  }
  return 'notfound';
}

function _inboxReplyComposerProbeFn(nick) {
  function visible(el) { if (!el || el.offsetParent === null) return false; var r=el.getBoundingClientRect(); return r.width>80&&r.height>15; }
  var nodes=document.querySelectorAll('textarea,[contenteditable=true],[role="textbox"]');
  for(var i=0;i<nodes.length;i++){
    var el=nodes[i]; if(!visible(el))continue;
    var ph=String(el.getAttribute('placeholder')||el.getAttribute('aria-label')||''), cls=String(el.className||'');
    if(ph.indexOf(nick)<0&&ph.indexOf('回复')<0&&cls.indexOf('comment-input')<0)continue;
    var r=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),ph:ph});
  }
  return '';
}

function _inboxSendProbeFn(expectedText) {
  function visible(el){return !!el&&el.offsetParent!==null;}
  function valueOf(el){return String(el&&(el.value!=null?el.value:(el.innerText||el.textContent))||'').trim();}
  var inputs=document.querySelectorAll('textarea,[contenteditable=true],[role="textbox"]'),input=null;
  for(var i=0;i<inputs.length;i++){if(!visible(inputs[i]))continue;var v=valueOf(inputs[i]);if(v===expectedText||v.indexOf(expectedText)>=0){input=inputs[i];break;}}
  if(!input)return JSON.stringify({ok:false,reason:'typed_text_not_found'});
  var scope=input.parentElement;
  for(var k=0;k<4&&scope;k++,scope=scope.parentElement){
    var buttons=scope.querySelectorAll('button,span,div');
    for(var j=0;j<buttons.length;j++){
      var e=buttons[j];if(!visible(e)||(e.textContent||'').trim()!=='发送')continue;
      var button=e.closest?(e.closest('button')||e):e,r=button.getBoundingClientRect();if(r.width<=2||r.height<=2)continue;
      return JSON.stringify({ok:true,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
    }
  }
  return JSON.stringify({ok:false,reason:'send_button_not_found'});
}

function _inboxSentProbeFn(expectedText) {
  function visible(el){return !!el&&el.offsetParent!==null;}
  function valueOf(el){return String(el&&(el.value!=null?el.value:(el.innerText||el.textContent))||'').trim();}
  var inputs=document.querySelectorAll('textarea,[contenteditable=true],[role="textbox"]');
  for(var i=0;i<inputs.length;i++){if(!visible(inputs[i]))continue;var v=valueOf(inputs[i]);if(v===expectedText||v.indexOf(expectedText)>=0)return 'pending';}
  return String(document.body.innerText||'').indexOf('回复成功')>=0?'sent':'cleared';
}
// 回复一条：鼠标滑到「回复」→(演练: 只滑过去不点)/(真发: 点回复→点输入框→打字→点发送→验证)。全程真鼠标(拟人可见)。登录检测由调用方做。
async function replyInboxItem({ client, target, item, text, dry = true, onLog = () => {} }) {
  let cur = ''; try { cur = String((await client.evaluate({ target, expression: 'location.href' })).value || ''); } catch (e) {}
  if (cur.indexOf('notification') < 0) return { ok: false, msg: '不在通知页' };
  const head = (item.content || '').slice(0, 8);
  const expr = '(' + _replyFindFn.toString() + ')(' + JSON.stringify(item.nick || '') + ',' + JSON.stringify(head) + ')';
  let res = ''; try { res = String((await client.evaluate({ target, expression: expr })).value || ''); } catch (e) {}
  if (res === 'notfound') return { ok: false, msg: '没找到这条(可能已滚走)' };
  if (res === 'norep') return { ok: false, msg: '这条不能回复(可能原评论已删)' };
  let rep = null; try { rep = JSON.parse(res); } catch (e) {}
  if (!rep || !Number.isFinite(rep.x)) return { ok: false, msg: '定位回复按钮失败' };
  // 拟人:鼠标滑到「回复」按钮(看得见)
  await client.humanMove({ target, toX: rep.x, toY: rep.y }).catch(() => {});
  await sleep(rand(400, 800));
  if (dry) return { ok: true, msg: '演练:鼠标已移到「回复」(未点开)' };
  // 真发:鼠标点「回复」→ 内联输入框
  await client.click({ target, x: rep.x, y: rep.y }).catch(() => {});
  let inp = null;
  const composerExpr = '(' + _inboxReplyComposerProbeFn.toString() + ')(' + JSON.stringify(item.nick || '') + ')';
  for (let attempt = 0; attempt < 8 && !inp; attempt++) {
    await sleep(attempt === 0 ? 450 : 350);
    try { inp = JSON.parse((await client.evaluate({ target, expression: composerExpr })).value || ''); } catch (e) {}
  }
  if (!inp) return { ok: false, msg: '回复框没出现' };
  // 鼠标点输入框聚焦 → 逐字打字
  await client.click({ target, x: inp.x, y: inp.y });
  await sleep(rand(500, 900));
  await client.typeText({ target, text: text });
  await sleep(rand(900, 1500));
  let send = null;
  const sendExpr = '(' + _inboxSendProbeFn.toString() + ')(' + JSON.stringify(text) + ')';
  try { const found = JSON.parse((await client.evaluate({ target, expression: sendExpr })).value || '{}'); if (found.ok) send = found; } catch (e) {}
  if (!send) return { ok: false, msg: '没找到发送按钮' };
  await client.click({ target, x: send.x, y: send.y });
  let okSent = false;
  const sentExpr = '(' + _inboxSentProbeFn.toString() + ')(' + JSON.stringify(text) + ')';
  for (let attempt = 0; attempt < 12 && !okSent; attempt++) {
    await sleep(400);
    try { const v = await client.evaluate({ target, expression: sentExpr }); okSent = v && (v.value === 'sent' || v.value === 'cleared'); } catch (e) {}
  }
  return okSent ? { ok: true, msg: '已回复✓' } : { ok: false, msg: '点了发送但没确认成功' };
}

function serviceAreaDecision(content, cfg = {}) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  const localWords = Array.isArray(cfg.lead_local_words) ? cfg.lead_local_words.filter(Boolean) : [];
  const otherCities = ['合肥', '上海', '广州', '深圳', '杭州', '南京', '成都', '重庆', '武汉', '西安', '天津', '郑州', '长沙', '苏州', '济南', '青岛', '沈阳', '大连'];
  const beijingDistricts = ['东城', '西城', '朝阳', '海淀', '丰台', '石景山', '门头沟', '房山', '通州', '顺义', '昌平', '大兴', '怀柔', '平谷', '密云', '延庆'];
  if (!text || !localWords.length) return { locationMatch: 'unknown', reason: '未配置或未识别服务区域' };
  const preciseLocalWords = localWords.filter((word) => !/^(北京|北京市)$/.test(String(word)));
  const hasPreciseLocal = preciseLocalWords.some((word) => text.includes(String(word)));
  if (hasPreciseLocal) return { locationMatch: 'match', reason: '正文命中服务区域' };
  const explicitAreas = otherCities.concat(beijingDistricts);
  const unsupported = explicitAreas.find((area) => text.includes(area) && !localWords.some((word) => String(word).includes(area) || area.includes(String(word)) && !/^(北京|北京市)$/.test(String(word))));
  if (unsupported) {
    return { locationMatch: 'mismatch', reason: `明确地点“${unsupported}”不在当前服务区域` };
  }
  return { locationMatch: 'unknown', reason: '正文没有足够的服务区域信息' };
}

function leadTextDecision(content, cfg = {}) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2) return { eligible: false, reason: '内容为空' };
  const area = serviceAreaDecision(text, cfg);
  if (area.locationMatch === 'mismatch') return { eligible: false, reason: '异地内容' };
  if ((cfg.reply_black_words || []).some((word) => word && text.includes(word))) return { eligible: false, reason: '命中黑词' };
  const audience = residentialLongTermAudienceDecision(text);
  if (!audience.eligible) return audience;
  if (/(中介|经纪人|房产销售|公寓管家|招租|出租|转租|房源发布|佣金|合作|房东直租|可带看|随时带看|我.{0,4}有房|我.{0,6}有.{0,4}(一居|两居|三居)|手上有|主页.{0,6}(房源|房子|实拍)|私你了|已私|我私你|私信你了)/.test(text)) return { eligible: false, reason: '供给方/同行信息' };
  const strong = /(求租|找房|想租|要租|租房需求|蹲房|有没有.{0,8}(房|一居|两居|合租|整租)|还在吗|还有吗|多少钱|价格多少|预算.{0,10}(元|千|万)|(想|求|找|要|蹲).{0,8}(一居|两居|三居|合租|整租|入住)|(一居|两居|三居|合租|整租).{0,8}(求租|找房|想租|要租))/.test(text);
  return strong ? { eligible: true, reason: '明确租房需求' } : { eligible: false, reason: '未识别到明确需求' };
}

function leadActorDecision(content, nickname, cfg = {}) {
  const nick = String(nickname || '').replace(/\s+/g, ' ').trim();
  if (/(贝壳找房|链家|我爱我家|麦田房产|房产|地产|置业|经纪|租房管家|公寓管家|好房推荐|好房安利)/.test(nick)) {
    return { eligible: false, reason: '同行/经纪人昵称' };
  }
  return leadTextDecision(content, cfg);
}

function _openNoteReplyFindFn(nick, head, userLink) {
  function profilePath(href) {
    return String(href || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  }
  function visible(el) {
    if (!el || el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  var expectedProfile = profilePath(userLink);
  var links = document.querySelectorAll('a[href*="/user/profile"]');
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    if ((link.textContent || '').trim() !== nick) continue;
    if (expectedProfile && profilePath(link.getAttribute('href')) !== expectedProfile) continue;
    var box = link.closest ? link.closest('.comment-item') : null;
    if (!box || !visible(box)) continue;
    var body = (box.innerText || '').trim();
    if (head && body.indexOf(head) < 0) continue;
    var controls = box.querySelectorAll('.reply.icon-container,[class~="reply"][class*="icon-container"],button,span,div');
    var best = null;
    for (var j = 0; j < controls.length; j++) {
      var el = controls[j];
      if (!visible(el) || (el.closest && el.closest('.comment-item') !== box)) continue;
      var classes = String(el.className || '');
      if (/(^|\s)reply(\s|$)/.test(classes) || (el.childElementCount === 0 && (el.textContent || '').trim() === '回复')) { best = el; break; }
    }
    if (!best) continue;
    var token = 'sla-reply-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    best.setAttribute('data-sla-reply-target', token);
    box.setAttribute('data-sla-reply-row', token);
    var r = best.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      token: token,
      profilePath: profilePath(link.getAttribute('href'))
    });
  }
  return 'notfound';
}

function _openNoteReplyComposerFn(nick, token) {
  function visible(el) {
    if (!el || el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    return r.width > 80 && r.height > 15;
  }
  function replyContext(el) {
    var attrs = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-placeholder')]
      .filter(Boolean).join(' ');
    var box = el;
    var nearby = '';
    for (var k = 0; k < 5 && box; k++, box = box.parentElement) {
      var body = String(box.innerText || '').replace(/\s+/g, ' ').trim();
      if (body.length <= 400) nearby = body;
      if (body.indexOf(nick) >= 0 && body.indexOf('回复') >= 0) break;
    }
    return { attrs: attrs, nearby: nearby };
  }
  var nodes = document.querySelectorAll('textarea,[contenteditable=true]');
  var matches = [], seen = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!visible(el)) continue;
    var ctx = replyContext(el);
    seen.push((ctx.attrs || '(无提示)').slice(0, 80));
    var targetNamed = ctx.attrs.indexOf(nick) >= 0 ||
      (ctx.nearby.indexOf(nick) >= 0 && ctx.nearby.indexOf('回复') >= 0);
    if (targetNamed) matches.push({ el: el, ctx: ctx });
  }
  if (matches.length !== 1) {
    return JSON.stringify({ verified: false, count: matches.length, visibleInputs: seen.slice(0, 5) });
  }
  var input = matches[0].el;
  input.setAttribute('data-sla-reply-input', token);
  var r = input.getBoundingClientRect();
  return JSON.stringify({
    verified: true,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    context: (matches[0].ctx.attrs || matches[0].ctx.nearby).slice(0, 120)
  });
}

function _openNoteReplySendFn(nick, token, expectedText) {
  function visible(el) {
    if (!el || el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  var nodes = document.querySelectorAll('textarea,[contenteditable=true]');
  var input = null;
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute('data-sla-reply-input') === token) { input = nodes[i]; break; }
  }
  if (!input || !visible(input)) return JSON.stringify({ verified: false, reason: 'reply_input_lost' });
  var typed = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT' ? String(input.value || '') : String(input.innerText || input.textContent || '');
  if (typed.indexOf(expectedText) < 0) return JSON.stringify({ verified: false, reason: 'reply_text_not_in_target_input' });
  var attrs = [input.getAttribute('placeholder'), input.getAttribute('aria-label'), input.getAttribute('data-placeholder')]
    .filter(Boolean).join(' ');
  var box = input;
  for (var k = 0; k < 6 && box; k++, box = box.parentElement) {
    var nearby = String(box.innerText || '').replace(/\s+/g, ' ').trim();
    var targetNamed = attrs.indexOf(nick) >= 0 || (nearby.indexOf(nick) >= 0 && nearby.indexOf('回复') >= 0);
    if (!targetNamed) continue;
    var controls = box.querySelectorAll('button,span,div');
    for (var j = 0; j < controls.length; j++) {
      var el = controls[j];
      if (el.childElementCount !== 0 || (el.textContent || '').trim() !== '发送' || !visible(el)) continue;
      var r = el.getBoundingClientRect();
      return JSON.stringify({ verified: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    }
  }
  return JSON.stringify({ verified: false, reason: 'scoped_reply_send_not_found' });
}

async function replyOpenNoteComment({ client, target, item, text, dry = true, shouldStop = () => false }) {
  if (shouldStop()) return { ok: false, stopped: true, msg: 'machine_stopped' };
  const head = String(item.content || '').slice(0, 12);
  const expr = '(' + _openNoteReplyFindFn.toString() + ')(' + JSON.stringify(item.nick || '') + ',' + JSON.stringify(head) + ',' + JSON.stringify(item.user_link || '') + ')';
  let raw = ''; try { raw = String((await client.evaluate({ target, expression: expr })).value || ''); } catch (e) {}
  let point = null; try { point = JSON.parse(raw); } catch (e) {}
  if (!point || !Number.isFinite(point.x)) return { ok: false, msg: '没找到评论区这条留言的回复按钮' };
  await client.humanMove({ target, toX: point.x, toY: point.y }).catch(() => {});
  await sleep(rand(350, 750));
  if (shouldStop()) return { ok: false, stopped: true, msg: 'machine_stopped' };
  await client.click({ target, x: point.x, y: point.y });
  await sleep(rand(800, 1300));
  let input = null;
  const inputExpr = '(' + _openNoteReplyComposerFn.toString() + ')(' + JSON.stringify(item.nick || '') + ',' + JSON.stringify(point.token || '') + ')';
  try { input = JSON.parse((await client.evaluate({ target, expression: inputExpr })).value || ''); } catch (e) {}
  if (!input || !input.verified) return { ok: false, msg: '未确认当前输入框正在回复“' + (item.nick || '目标用户') + '”，已中止发送' };
  if (dry) return { ok: true, dry: true, msg: '草稿:已确认正在回复“' + (item.nick || '目标用户') + '”(未输入、未发送)' };
  await client.click({ target, x: input.x, y: input.y });
  await client.typeText({ target, text });
  await sleep(rand(800, 1400));
  if (shouldStop()) return { ok: false, stopped: true, msg: 'machine_stopped_before_send' };
  let send = null;
  const sendExpr = '(' + _openNoteReplySendFn.toString() + ')(' + JSON.stringify(item.nick || '') + ',' + JSON.stringify(point.token || '') + ',' + JSON.stringify(text) + ')';
  try { send = JSON.parse((await client.evaluate({ target, expression: sendExpr })).value || ''); } catch (e) {}
  if (!send || !send.verified) return { ok: false, msg: '回复对象或发送按钮校验失败，已中止发送' };
  await client.click({ target, x: send.x, y: send.y });
  await sleep(1600);
  return { ok: true, dry: false, msg: '评论区回复已发送' };
}

module.exports = { connect, buildSearchUrl, normalizeSearchKeyword, decodeSearchKeyword, searchPageMatches, parseSearchPageProbe, parseSearchInputProbe, SEARCH_INPUT_PROBE, SEARCH_SUBMIT_PROBE, searchFromPageUi, searchPageMismatchError, isSearchPageMismatchError, scanClean, sortVisualNotes, matchNotes, prepareNotesForDetailClassification, prepareNotesForLlmClassification, isLlmNoteClassificationEnabled, classifyDetailedNote, classifyDetailedNoteByKeywords, classifyDetailedNoteByLlm, validateLlmLocation, classifyNotePublisher, noteClassificationDecision, shouldCommentNoteAuthor, categoryClassificationDecision, residentialLongTermAudienceDecision, serviceAreaDecision, readDetail, scanOpenNoteComments, genComment, makeComment, buildCommentDirection, analyzeCommentNeed, formatCommentContext, classify, check, rejectsAgent, applyFilters, scanInbox, inboxIntent, shouldReply, makeReply, hasUnread, replyInboxItem, leadTextDecision, leadActorDecision, replyOpenNoteComment, assertNoAccountSecurityPage, accountSecurityError, isAccountSecurityError, canReturnHomeFromSecurityPage, returnHomeFromSecurityPage, _replyFindFn, _inboxReplyComposerProbeFn, _inboxSendProbeFn, _inboxSentProbeFn };
