'use strict';
// 国产 LLM,可切换 provider。火山方舟 / 阿里百炼都兼容 OpenAI 的 chat/completions 协议。
// 默认不开;在「任务设置」填 provider + model + api_key 并勾选启用后,评论改由大模型按对方正文+你的方向生成。
const https = require('https');

const PROVIDERS = {
  ark: { host: 'ark.cn-beijing.volces.com', path: '/api/v3/chat/completions', label: '火山方舟(豆包)' },
  dashscope: { host: 'dashscope.aliyuncs.com', path: '/compatible-mode/v1/chat/completions', label: '阿里百炼(通义)' },
  deepseek: { host: 'api.deepseek.com', path: '/chat/completions', label: 'DeepSeek' },
};

// Newer reasoning-capable models can legitimately take longer than the old
// 18-second cutoff, especially on the first request.  A short cutoff turns a
// valid response into a false "classification failed" decision.
const CLASSIFICATION_TIMEOUT_MS = 60000;

function postChat({ host, path, apiKey, body, timeoutMs = 12000 }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error('LLM ' + res.statusCode + ': ' + (j.error && j.error.message || data).slice(0, 200)));
          resolve(j);
        } catch (e) { reject(new Error('LLM 返回解析失败: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('LLM 超时')); });
    req.write(payload);
    req.end();
  });
}

function buildCommentMessages({ note, direction }) {
  const title = (note && note.title) || '';
  const desc = ((note && note.desc) || '').slice(0, 600);
  const tags = ((note && note.tags) || []).join(' ');
  const context = (note && note.comment_context) ? String(note.comment_context) : '';
  const sys = '你是帮租房中介在小红书做获客的助手。读对方的求租笔记,写一句自然、口语化、像真人随手回的评论,呼应对方的具体诉求(地区/户型/预算/通勤等),态度友好,引导对方看你主页或私聊。如果系统判断里预算、户型、通勤等是未知,绝对不能编造,要自然追问缺失信息。硬性红线:绝对不能出现微信号、手机号、二维码、任何外链或"加我"等明示联系方式;不超过 50 字;只输出评论本身,不要引号、不要解释。';
  const user = '【对方笔记标题】' + title + '\n【正文】' + desc + '\n【标签】' + tags + (context ? '\n【系统判断】\n' + context : '') + '\n【我的方向/卖点】' + (direction || '友好回应,引导看主页/私聊') + '\n请按上面要求写这一句评论。';
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

const NOTE_ROLES = new Set(['tenant', 'supply', 'agent', 'irrelevant', 'uncertain']);
const LOCATION_MATCHES = new Set(['match', 'mismatch', 'unknown']);

function buildNoteClassificationMessages({ note, localWords = [] }) {
  const title = String((note && note.title) || '').trim();
  const desc = String((note && note.desc) || '').trim();
  const author = String((note && note.author) || '').trim();
  const tags = Array.isArray(note && note.tags) ? note.tags.join('、') : '';
  const serviceAreas = (Array.isArray(localWords) ? localWords : [])
    .map((word) => String(word || '').trim()).filter(Boolean).join('、') || '未配置';
  const system = [
    '你是租房获客场景的笔记分类器。你的唯一任务是判断“这篇笔记的发布者”是什么角色，并判断笔记对应地点是否在服务区。',
    '必须同时阅读标题和完整正文，不能只凭标题、标签或单个“租房”关键词判断。标题与正文冲突时，以正文中发布者的第一人称立场和明确行为为主。',
    '角色只能是以下五种之一：',
    '- tenant：发布者本人明确在求租、找房、想租房，是租房需求方。',
    '- supply：发布者本人在出租、转租、展示或提供房源，包括个人房东和转租人。',
    '- agent：发布者是中介、经纪人、公寓管家、房产营销号或同行。',
    '- irrelevant：内容与租房获客无关，或只是经验分享、资讯、吐槽，没有发布者本人的租房需求或房源供给。',
    '- uncertain：信息不足，无法可靠确定角色。',
    '地点判断 locationMatch 只能是 match、mismatch、unknown。要判断的是笔记里的目标租房地/房源地，不要把上班地、通勤地误当成求租地。',
    '只有明确属于服务区才填 match；明确求租地或房源地在服务区之外填 mismatch；没有明确地点填 unknown。',
    '不要分析评论区用户。不要因为评论区可能有租户就把发布者判成 tenant。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。格式：',
    '{"role":"tenant|supply|agent|irrelevant|uncertain","locationMatch":"match|mismatch|unknown","demandLocation":"地点或空字符串","confidence":0到1之间的小数,"reason":"一句话理由","evidence":"来自标题或正文的关键依据"}'
  ].join('\n');
  const user = [
    '【服务区域】' + serviceAreas,
    '【发布者昵称】' + (author || '未知'),
    '【标题】' + (title || '空'),
    '【完整正文】' + (desc || '空'),
    '【标签】' + (tags || '空'),
    '请按要求输出 JSON。'
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function normalizeNoteClassification(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const roleRaw = String(raw.role || raw.publisherRole || raw.publisher_role || '').trim().toLowerCase();
  const roleAliases = {
    renter: 'tenant', demand: 'tenant', '求租者': 'tenant', '租户': 'tenant', '需求方': 'tenant',
    landlord: 'supply', owner: 'supply', supplier: 'supply', '房源方': 'supply', '房东': 'supply', '转租方': 'supply',
    broker: 'agent', agency: 'agent', peer: 'agent', '中介': 'agent', '经纪人': 'agent', '同行': 'agent',
    other: 'irrelevant', unrelated: 'irrelevant', '无关': 'irrelevant', '其他': 'irrelevant',
    unknown: 'uncertain', unsure: 'uncertain', '不确定': 'uncertain', '未知': 'uncertain'
  };
  const role = NOTE_ROLES.has(roleRaw) ? roleRaw : (roleAliases[roleRaw] || 'uncertain');
  const locationRaw = String(raw.locationMatch || raw.location_match || raw.areaMatch || '').trim().toLowerCase();
  const locationAliases = {
    yes: 'match', true: 'match', local: 'match', '匹配': 'match', '服务区内': 'match',
    no: 'mismatch', false: 'mismatch', remote: 'mismatch', '不匹配': 'mismatch', '服务区外': 'mismatch',
    unsure: 'unknown', '不确定': 'unknown', '未知': 'unknown'
  };
  const locationMatch = LOCATION_MATCHES.has(locationRaw) ? locationRaw : (locationAliases[locationRaw] || 'unknown');
  const confidenceNumber = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : 0;
  return {
    role,
    locationMatch,
    demandLocation: String(raw.demandLocation || raw.demand_location || raw.location || '').trim().slice(0, 80),
    confidence,
    reason: String(raw.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    evidence: String(raw.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 240)
  };
}

function parseNoteClassificationContent(content) {
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('大模型分类未返回 JSON');
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { throw new Error('大模型分类 JSON 解析失败'); }
  return normalizeNoteClassification(parsed);
}

async function classifyNotePublisher({ note, localWords, provider, model, apiKey }) {
  const ep = PROVIDERS[provider] || PROVIDERS.ark;
  const j = await postChat({
    host: ep.host, path: ep.path, apiKey,
    body: {
      model: model || (provider === 'deepseek' ? 'deepseek-v4-flash' : ''),
      messages: buildNoteClassificationMessages({ note, localWords }),
      temperature: 0.1,
      max_tokens: 320
    },
    timeoutMs: CLASSIFICATION_TIMEOUT_MS
  });
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw new Error('大模型分类没有返回内容');
  return parseNoteClassificationContent(content);
}

function buildNoteCategoryClassificationMessages({ note, leadModel = {} }) {
  const title = String((note && note.title) || '').trim();
  const desc = String((note && note.desc) || '').trim();
  const author = String((note && note.author) || '').trim();
  const tags = Array.isArray(note && note.tags) ? note.tags.join('、') : '';
  const categories = Array.isArray(leadModel && leadModel.categories) ? leadModel.categories : [];
  const slots = Array.isArray(leadModel && leadModel.slots) ? leadModel.slots.filter((slot) => slot && slot.enabled !== false) : [];
  const categoryText = categories.map((category, index) => {
    const lines = [
      `${index + 1}. categoryId=${String(category.id || '').trim()}`,
      `分类名称=${String(category.name || '').trim()}`,
      `分类说明=${String(category.description || '').trim() || '无'}`,
      `LLM判断说明=${String(category.llmPrompt || '').trim() || '按分类说明判断'}`
    ];
    if (category.fallback) lines.push('这是兜底分类：只有其他分类都不成立时才选择。');
    return lines.join('\n');
  }).join('\n\n');
  const slotText = slots.map((slot) => `- ${String(slot.key || '').trim()}（${String(slot.name || slot.key || '').trim()}）：${String(slot.description || '').trim() || '从标题和正文提取，无法确定则留空'}`).join('\n');
  const extraPrompt = String((leadModel && leadModel.classifyPrompt) || '').trim();
  const system = [
    `你是“${String((leadModel && leadModel.name) || '获客模型')}”的笔记分类器。`,
    '必须同时阅读标题和完整正文，不能只凭标题、标签或单个关键词判断。标题与正文冲突时，以正文中发布者的第一人称立场和明确行为为主。',
    '你的任务是先从标题和正文提取客观信息，再判断“这篇笔记的发布者”最符合下面哪一个分类。不要分析评论区用户，也不要因为评论区可能存在目标用户而改变发布者分类。',
    '必须按以下顺序判断：1）仅依据标题和正文提取城市、区县、具体位置、预算、户型、入住时间等事实；2）确定发布者分类。',
    '本阶段不会向你提供检索关键词或服务区域，因为它们会污染事实提取。绝对不能猜测笔记是从什么关键词搜出的，也不要假设它属于任何服务区域。',
    '例如：正文写“甘泉路、志丹路、新村路地铁站”时，应依据地理知识识别为上海普陀附近；“新村路”不能被臆测成北京的“大宁村”。',
    extraPrompt ? `【统一补充判断要求】\n${extraPrompt}` : '',
    '【可选分类及各分类专属判断要求】',
    categoryText || '没有配置分类',
    '【需要从标题和正文提取的信息】',
    slotText || '- area（地区/位置）\n- budget（预算）\n- room_type（户型）\n- move_in_time（入住时间）\n- requirements（其他要求）',
    'categoryId 必须严格使用上面某个分类的 categoryId，不能创造新分类。',
    '本阶段只抽取正文事实，不做服务区匹配，因此 locationMatch 必须填 unknown，matchedServiceArea 必须为空字符串。系统会在事实提取完成后单独与服务区域比较。',
    'locationEvidence 必须是标题或正文里的地点原文。判断目标需求地/房源地，不要把上班地、通勤地误当成目标地点。',
    'slotValues 的键必须使用上面配置的信息 key，值只能来自标题和正文；无法确定就填空字符串，禁止猜测。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。格式：',
    '{"categoryId":"上面某个分类ID","city":"城市或空字符串","district":"区县或空字符串","location":"具体位置或空字符串","locationMatch":"match|mismatch|unknown","matchedServiceArea":"匹配时填服务区域原值，否则空字符串","locationConfidence":0到1之间的小数,"locationEvidence":"标题或正文中的地点原文","slotValues":{"配置的信息key":"提取值或空字符串"},"confidence":0到1之间的小数,"reason":"一句话分类理由","evidence":"来自标题或正文的分类依据"}'
  ].filter(Boolean).join('\n');
  const user = [
    '【发布者昵称】' + (author || '未知'),
    '【标题】' + (title || '空'),
    '【完整正文】' + (desc || '空'),
    '【标签】' + (tags || '空'),
    '请严格按上面的分类和 JSON 格式输出。'
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function normalizeNoteCategoryClassification(value, categories = []) {
  const raw = value && typeof value === 'object' ? value : {};
  const requested = String(raw.categoryId || raw.category_id || raw.category || '').trim();
  const list = Array.isArray(categories) ? categories : [];
  const picked = list.find((category) => String(category.id || '').trim() === requested)
    || list.find((category) => String(category.name || '').trim() === requested)
    || list.find((category) => String(category.id || '').trim().toLowerCase() === requested.toLowerCase())
    || list.find((category) => category.fallback)
    || list[list.length - 1]
    || { id: 'unknown', name: '不明', action: 'record', fallback: true };
  const common = normalizeNoteClassification(raw);
  const locationConfidenceNumber = Number(raw.locationConfidence || raw.location_confidence);
  const rawSlots = raw.slotValues || raw.slot_values || raw.slots;
  const slotValues = {};
  if (rawSlots && typeof rawSlots === 'object' && !Array.isArray(rawSlots)) {
    for (const [key, val] of Object.entries(rawSlots)) {
      slotValues[String(key).slice(0, 80)] = String(val == null ? '' : val).replace(/\s+/g, ' ').trim().slice(0, 240);
    }
  }
  return Object.assign({}, common, {
    categoryId: String(picked.id || 'unknown'),
    categoryName: String(picked.name || picked.id || '不明'),
    categoryAction: String(picked.action || 'skip'),
    categoryFallback: !!picked.fallback,
    categoryReplyStrategy: String(picked.replyStrategy || ''),
    categoryLlmPrompt: String(picked.llmPrompt || ''),
    requestedCategoryId: requested,
    city: String(raw.city || '').trim().slice(0, 80),
    district: String(raw.district || '').trim().slice(0, 80),
    location: String(raw.location || raw.demandLocation || raw.demand_location || '').trim().slice(0, 160),
    matchedServiceArea: String(raw.matchedServiceArea || raw.matched_service_area || '').trim().slice(0, 160),
    locationConfidence: Number.isFinite(locationConfidenceNumber) ? Math.max(0, Math.min(1, locationConfidenceNumber)) : 0,
    locationEvidence: String(raw.locationEvidence || raw.location_evidence || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    slotValues
  });
}

function parseNoteCategoryClassificationContent(content, categories) {
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('大模型分类未返回 JSON');
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { throw new Error('大模型分类 JSON 解析失败'); }
  return normalizeNoteCategoryClassification(parsed, categories);
}

async function classifyNoteCategory({ note, localWords, leadModel, provider, model, apiKey, requestChat = postChat }) {
  const ep = PROVIDERS[provider] || PROVIDERS.ark;
  const categories = Array.isArray(leadModel && leadModel.categories) ? leadModel.categories : [];
  const baseMessages = buildNoteCategoryClassificationMessages({ note, leadModel });
  let formatError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt === 0 ? baseMessages : baseMessages.concat([{
      role: 'user',
      content: '上一次没有返回可解析的完整 JSON。请立即重新输出：只输出一个完整、合法的 JSON 对象，不要 Markdown、不要解释、不要在 JSON 前后添加任何文字。'
    }]);
    const body = {
      model: model || (provider === 'deepseek' ? 'deepseek-v4-flash' : ''),
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 800
    };
    // DeepSeek V4 defaults to high-effort thinking. For short structured
    // extraction this can consume the output budget before the final JSON.
    if (provider === 'deepseek') body.thinking = { type: 'disabled' };
    const j = await requestChat({
      host: ep.host, path: ep.path, apiKey, body,
      timeoutMs: CLASSIFICATION_TIMEOUT_MS
    });
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    try {
      if (!content) throw new Error('大模型分类没有返回内容');
      return parseNoteCategoryClassificationContent(content, categories);
    } catch (error) {
      formatError = error;
      if (attempt === 1) throw error;
    }
  }
  throw formatError || new Error('大模型分类返回格式异常');
}

function buildServiceAreaClassificationMessages({ note, extracted = {}, localWords = [] }) {
  const title = String((note && note.title) || '').trim();
  const desc = String((note && note.desc) || '').trim();
  const tags = Array.isArray(note && note.tags) ? note.tags.join('、') : '';
  const serviceAreas = (Array.isArray(localWords) ? localWords : [])
    .map((word) => String(word || '').trim()).filter(Boolean);
  const facts = [
    extracted.city ? `城市=${extracted.city}` : '',
    extracted.district ? `区县=${extracted.district}` : '',
    extracted.location ? `具体位置=${extracted.location}` : '',
    extracted.locationEvidence ? `地点原文=${extracted.locationEvidence}` : ''
  ].filter(Boolean).join('；') || '第一阶段没有提取到明确地点';
  const system = [
    '你是获客任务的服务地区诊断器。分类模型已经先从标题和完整正文提取了客观地点；你只负责判断笔记里的目标求租地或房源地是否属于用户配置的服务区域，不要重新判断发布者分类。',
    '必须结合标题、完整正文、第一阶段地点事实和常识地理关系判断，不能只做字符串包含，也不能只看单个地点词。要理解行政区、村、小区、商圈、地铁站、简称和常见别名之间的归属关系。',
    '例如服务区是“朱岗子”时，“房山朱岗子村”“北京房山朱岗子”应视为同一地点；服务区是“长阳”时，“长阳地铁站”“长阳镇”可视为覆盖。反过来，上海普陀“新村路/甘泉路”不能因为字面相近而匹配北京“大宁村”。',
    '判断的是笔记真正想租房或提供房源的位置。上班地、通勤目的地、作者IP、检索关键词都不能当作目标租房地。',
    'locationMatch 只能是 match、mismatch、unknown：能根据地理关系确认属于任一服务区域才填 match；明确在全部服务区域之外填 mismatch；正文地点不足或存在歧义填 unknown。',
    'match 时 matchedServiceArea 必须逐字填写下面服务区域中的一个原值，禁止创造新区域。mismatch 或 unknown 时必须为空字符串。',
    'locationEvidenceQuotes 必须返回 1到3 段标题或正文里的简短地点原文，每段逐字复制，不得把分散地点合并成新句子，不得改写或编造。例如正文有“武侯区”和“双楠立交”，应返回 ["武侯区","双楠立交"]。置信度不足时宁可 unknown，不要猜。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。格式：',
    '{"locationMatch":"match|mismatch|unknown","matchedServiceArea":"服务区域原值或空字符串","locationConfidence":0到1之间的小数,"locationEvidenceQuotes":["标题或正文中的简短地点原文"],"reason":"一句话地理判断理由"}'
  ].join('\n');
  const user = [
    '【服务区域】' + (serviceAreas.join('、') || '未配置'),
    '【第一阶段地点事实】' + facts,
    '【标题】' + (title || '空'),
    '【完整正文】' + (desc || '空'),
    '【标签】' + (tags || '空'),
    '请判断目标地点是否属于服务区域并输出 JSON。'
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function normalizeServiceAreaClassification(value, localWords = []) {
  const raw = value && typeof value === 'object' ? value : {};
  const common = normalizeNoteClassification({
    locationMatch: raw.locationMatch || raw.location_match,
    confidence: raw.locationConfidence != null ? raw.locationConfidence : raw.confidence,
    reason: raw.reason,
    evidence: raw.locationEvidence || raw.location_evidence || raw.evidence
  });
  const configured = (Array.isArray(localWords) ? localWords : []).map((word) => String(word || '').trim()).filter(Boolean);
  const requestedArea = String(raw.matchedServiceArea || raw.matched_service_area || '').trim();
  const matchedServiceArea = configured.find((area) => area === requestedArea) || '';
  const rawQuotes = raw.locationEvidenceQuotes || raw.location_evidence_quotes;
  const evidenceQuotes = (Array.isArray(rawQuotes) ? rawQuotes : [raw.locationEvidence || raw.location_evidence || raw.evidence])
    .map((quote) => String(quote || '').replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 3);
  return {
    locationMatch: common.locationMatch,
    matchedServiceArea,
    locationConfidence: common.confidence,
    locationEvidence: evidenceQuotes.join('；'),
    locationEvidenceQuotes: evidenceQuotes,
    reason: common.reason
  };
}

function parseServiceAreaClassificationContent(content, localWords = []) {
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('大模型地区判断未返回 JSON');
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { throw new Error('大模型地区判断 JSON 解析失败'); }
  return normalizeServiceAreaClassification(parsed, localWords);
}

async function classifyServiceArea({ note, extracted, localWords, provider, model, apiKey, requestChat = postChat }) {
  const ep = PROVIDERS[provider] || PROVIDERS.ark;
  const baseMessages = buildServiceAreaClassificationMessages({ note, extracted, localWords });
  let formatError = null;
  let retryReason = '';
  const sourceText = [note && note.title, note && note.desc]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt === 0 ? baseMessages : baseMessages.concat([{
      role: 'user',
      content: retryReason === 'evidence'
        ? '上一次 locationEvidenceQuotes 不是标题或正文中可逐字找到的原文。请重新输出 JSON：从标题或完整正文中逐字复制 1到3 段简短地点原文，每段单独放入 locationEvidenceQuotes，不得汇总、改写或拼接。只输出合法 JSON。'
        : '上一次输出不是可解析的 JSON。请立即修正：只输出一个完整、合法的 JSON 对象，不要 Markdown、不要解释、不要在 JSON 前后添加任何文字。'
    }]);
    const body = {
      model: model || (provider === 'deepseek' ? 'deepseek-v4-flash' : ''),
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.05,
      max_tokens: 800
    };
    if (provider === 'deepseek') body.thinking = { type: 'disabled' };
    const j = await requestChat({
      host: ep.host, path: ep.path, apiKey,
      body,
      timeoutMs: CLASSIFICATION_TIMEOUT_MS
    });
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    try {
      if (!content) throw new Error('大模型地区判断没有返回内容');
      const parsed = parseServiceAreaClassificationContent(content, localWords);
      if (parsed.locationMatch !== 'unknown') {
        const hasVerbatimEvidence = parsed.locationEvidenceQuotes.some((quote) => sourceText.includes(quote));
        if (!hasVerbatimEvidence) {
          retryReason = 'evidence';
          throw new Error('大模型地区判断未返回可核对的地点原文');
        }
      }
      return parsed;
    } catch (error) {
      formatError = error;
      if (attempt === 1) throw error;
    }
  }
  throw formatError || new Error('大模型地区判断返回格式异常');
}

// 按对方笔记 + 方向,让大模型生成一句拟人评论
async function genComment({ note, direction, provider, model, apiKey }) {
  const ep = PROVIDERS[provider] || PROVIDERS.ark;
  const body = { model: model || (provider === 'deepseek' ? 'deepseek-v4-flash' : ''), messages: buildCommentMessages({ note, direction }), temperature: 0.9, max_tokens: 120 };
  if (provider === 'deepseek') body.thinking = { type: 'disabled' };
  const j = await postChat({
    host: ep.host, path: ep.path, apiKey,
    body,
  });
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!txt) throw new Error('LLM 没返回内容');
  return String(txt).trim().replace(/^["「『]|["」』]$/g, '').trim();
}

module.exports = {
  genComment,
  buildCommentMessages,
  classifyNotePublisher,
  buildNoteClassificationMessages,
  parseNoteClassificationContent,
  normalizeNoteClassification,
  classifyNoteCategory,
  buildNoteCategoryClassificationMessages,
  parseNoteCategoryClassificationContent,
  normalizeNoteCategoryClassification,
  classifyServiceArea,
  buildServiceAreaClassificationMessages,
  parseServiceAreaClassificationContent,
  normalizeServiceAreaClassification,
  PROVIDERS
};
