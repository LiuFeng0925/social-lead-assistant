'use strict';

function splitWords(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
  return String(v || '').split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean);
}

const DEFAULT_RENT_COMMENT_STRATEGY = '例:笔记只写“望京求租房”。系统能确定的只有:意向=求租,地点=望京,地点粒度=商圈/区域级,预算=未知,户型=未知,通勤/地铁要求=未知。判断逻辑:先抽取 location = 望京、location_type = 商圈/区域、city = 北京;房源库检索先用地点做第一层召回,优先找望京、望京SOHO、望京南、望京西、阜通、东湖渠、来广营附近。预算/户型未知时不要硬筛,不要脑补预算/户型,可选地点贴近、展示质量较好、可沟通空间大的房源做候选,但评论里要追问缺失信息。评论应是半匹配话术,例如“望京这边我有几套在看,近地铁和商圈附近的都有。你大概预算和想要几居呀?”不要直接说“我这有一套望京6500一居,特别适合你”。';
const LEGACY_RENT_COMMENT_STRATEGY = '结合区域、预算、户型等诉求友好回应,引导看主页/私聊,绝不留联系方式';
const PREVIOUS_RENT_COMMENT_STRATEGY = '先判断笔记已明确哪些槽位:地点、预算、户型、通勤/特殊要求。地点只写“望京求租房”时,只按区域级判断为望京附近,不要脑补预算/户型。信息完整时结合匹配房源自然回应;信息不完整时先呼应已知地点/诉求,再追问缺失的预算、户型或通勤要求。可引导看主页/私聊,绝不留联系方式。';
const DEFAULT_CATEGORY_LLM_PROMPTS = {
  seek_rent: '只有发布者本人明确表达正在求租、找房、想租房或询问租房方案时才归入此类。不能因为标题里出现“租房”就判断为求租；要结合正文里的第一人称诉求、地点、预算、户型、入住时间等信息。',
  supply_rent: '发布者本人在出租、转租、展示或提供房源，包括个人房东、二房东和转租人。即使评论区有人求租，发布者仍应归入房源方。',
  agent_peer: '发布者是中介、经纪人、公寓管家、房产机构、租房营销账号或其他同行。要结合正文的批量房源、带看、获客、职业身份和营销表达判断。',
  unknown: '信息不足、角色冲突、仅分享经验资讯，或无法可靠判断发布者是需求方、房源方还是同行时归入此兜底分类。',
};

function defaultCategoryLlmPrompt(id, name, fallback) {
  if (DEFAULT_CATEGORY_LLM_PROMPTS[id]) return DEFAULT_CATEGORY_LLM_PROMPTS[id];
  if (name === '求租笔记') return DEFAULT_CATEGORY_LLM_PROMPTS.seek_rent;
  if (name === '房源笔记') return DEFAULT_CATEGORY_LLM_PROMPTS.supply_rent;
  if (name === '中介/同行') return DEFAULT_CATEGORY_LLM_PROMPTS.agent_peer;
  if (fallback || name === '不明') return DEFAULT_CATEGORY_LLM_PROMPTS.unknown;
  return '';
}

function normalizeReplyStrategy(cat, name) {
  const id = String((cat && cat.id) || '').trim();
  const raw = String((cat && cat.replyStrategy) || '').trim();
  if ((id === 'seek_rent' || name === '求租笔记') && (raw === LEGACY_RENT_COMMENT_STRATEGY || raw === PREVIOUS_RENT_COMMENT_STRATEGY)) {
    return DEFAULT_RENT_COMMENT_STRATEGY;
  }
  return raw;
}

function defaultLeadModel() {
  return {
    name: '租房获客',
    goal: '找到正在求租的人',
    llmClassificationEnabled: false,
    categories: [
      {
        id: 'seek_rent',
        name: '求租笔记',
        action: 'comment',
        description: '用户正在找房、求推荐、问预算/区域/户型。',
        keywords: ['求租', '求转租', '求直租', '求推荐', '求靠谱', '求房', '找房', '蹲', '谁有', '有没有', '想租', '要租', '跪求', '急租', '预算'],
        excludeKeywords: ['出租', '招租', '出房', '房东直租'],
        llmPrompt: '只有发布者本人明确表达正在求租、找房、想租房或询问租房方案时才归入此类。不能因为标题里出现“租房”就判断为求租；要结合正文里的第一人称诉求、地点、预算、户型、入住时间等信息。',
        replyStrategy: DEFAULT_RENT_COMMENT_STRATEGY,
      },
      {
        id: 'supply_rent',
        name: '房源笔记',
        action: 'skip',
        description: '对方在发布房源、转租或招租。',
        keywords: ['整租', '房东直租', '出租', '转租出', '拎包入住', '可短租', '月付', '押一付', '押二付', '押三付', '空房', '新出', '有房', '出房', '招租', '急转'],
        llmPrompt: '发布者本人在出租、转租、展示或提供房源，包括个人房东、二房东和转租人。即使评论区有人求租，发布者仍应归入房源方。',
      },
      {
        id: 'agent_peer',
        name: '中介/同行',
        action: 'skip',
        description: '作者或内容像同行/营销号。',
        keywords: ['中介', '房产', '公寓', '物业', '租赁', '好房', '甄选', '管家'],
        llmPrompt: '发布者是中介、经纪人、公寓管家、房产机构、租房营销账号或其他同行。要结合正文的批量房源、带看、获客、职业身份和营销表达判断。',
      },
      { id: 'unknown', name: '不明', action: 'record', description: '规则和模型都无法高置信判断。', llmPrompt: '信息不足、角色冲突、仅分享经验资讯，或无法可靠判断发布者是需求方、房源方还是同行时归入此兜底分类。', fallback: true },
    ],
    slots: [
      { key: 'area', name: '区域', description: '城市、商圈、地铁站、小区位置' },
      { key: 'budget', name: '预算', description: '可接受租金或价格范围' },
      { key: 'room_type', name: '户型', description: '一居、两居、单间、开间等' },
      { key: 'move_in_time', name: '入住时间', description: '希望入住日期或紧急程度' },
      { key: 'requirements', name: '特殊要求', description: '通勤、近地铁、可养宠、独卫、朝向等' },
    ],
  };
}

function normalizeCategory(cat, i) {
  const name = String((cat && cat.name) || '').trim() || ('分类 ' + (i + 1));
  const id = String((cat && cat.id) || name).trim();
  let keywords = splitWords(cat && cat.keywords);
  if (id === 'seek_rent' || id === '求租笔记' || name === '求租笔记') {
    keywords = keywords.filter((word) => !['一居', '两居', '三居', '开间', '合租', '整租', '短租', '入住'].includes(word));
  }
  return {
    id,
    name,
    action: (cat && cat.action) || 'skip',
    description: (cat && cat.description) || '',
    keywords,
    excludeKeywords: splitWords(cat && cat.excludeKeywords),
    replyStrategy: normalizeReplyStrategy(cat, name),
    llmPrompt: String((cat && cat.llmPrompt) || defaultCategoryLlmPrompt(id, name, !!(cat && cat.fallback))),
    fallback: !!(cat && cat.fallback),
    order: i,
  };
}

function normalizeLeadModel(model) {
  const base = model && Array.isArray(model.categories) && model.categories.length ? model : defaultLeadModel();
  const categories = base.categories.map(normalizeCategory);
  if (!categories.some((c) => c.fallback)) categories.push(normalizeCategory({ id: 'unknown', name: '不明', action: 'record', fallback: true }, categories.length));
  return {
    name: base.name || '获客模型',
    goal: base.goal || '',
    classifyPrompt: base.classifyPrompt || '',
    llmClassificationEnabled: !!base.llmClassificationEnabled,
    categories,
    slots: Array.isArray(base.slots) ? base.slots : [],
  };
}

function noteText(note) {
  const tags = Array.isArray(note && note.tags) ? note.tags.join(' ') : '';
  return [note && note.title, note && note.desc, tags].map((x) => String(x || '')).join(' ');
}

function hasWord(text, word) {
  if (!word) return false;
  return String(text || '').toLowerCase().includes(String(word).toLowerCase());
}

function matchCategory(note, category) {
  const body = noteText(note);
  const evidence = [];
  const excluded = [];

  for (const w of category.excludeKeywords) {
    if (hasWord(body, w)) excluded.push('排除词:' + w);
  }
  if (excluded.length) return { category, matched: false, evidence: excluded, excluded: true };

  for (const w of category.keywords) {
    if (hasWord(body, w)) evidence.push('内容命中:' + w);
  }
  return { category, matched: evidence.length > 0, evidence, excluded: false };
}

function classifyNote(note, model) {
  const leadModel = normalizeLeadModel(model);
  const fallback = leadModel.categories.find((c) => c.fallback) || leadModel.categories[leadModel.categories.length - 1];
  let picked = null;
  for (const category of leadModel.categories) {
    if (category.fallback) continue;
    const matched = matchCategory(note || {}, category);
    if (matched.matched) { picked = matched; break; }
  }
  const needsLlmFallback = !picked;
  if (!picked) picked = { category: fallback, matched: false, evidence: [] };
  const c = picked.category;
  const confidence = c.fallback ? 0 : 1;
  const reason = picked.evidence.length ? picked.evidence.join('、') : '未命中规则,进入兜底分类';
  const heat = Number((note && note.comments) || 0) + Number((note && note.likes) || 0);
  const action = c.action || 'skip';
  return {
    ...(note || {}),
    category_id: c.id,
    category_name: c.name,
    categoryId: c.id,
    categoryName: c.name,
    category_action: action,
    action,
    category_confidence: Number(confidence.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    classify_reason: reason,
    classifyReason: reason,
    needs_llm_fallback: needsLlmFallback,
    needsLlmFallback,
    category_reply_strategy: c.replyStrategy || '',
    evidence: picked.evidence,
    intent: c.name,
    isTarget: action === 'comment',
    heat,
  };
}

function classifyNotes(notes, model) {
  const tagged = (notes || []).map((n) => classifyNote(n, model));
  const byIntent = {};
  tagged.forEach((n) => { byIntent[n.intent] = (byIntent[n.intent] || 0) + 1; });
  const targets = tagged.filter((n) => n.isTarget).sort((a, b) => b.heat - a.heat);
  return { tagged, targets, byIntent };
}

module.exports = {
  DEFAULT_RENT_COMMENT_STRATEGY,
  defaultLeadModel,
  normalizeLeadModel,
  classifyNote,
  classifyNotes,
};
