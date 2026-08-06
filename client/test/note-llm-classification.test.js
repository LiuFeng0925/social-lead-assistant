'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/llm');
const engine = require('../src/engine');

test('note classifier prompt contains both the title and the complete body', () => {
  const fullBody = '本人下个月到长阳上班，想整租一居，预算四千五，不接受隔断。';
  const messages = llm.buildNoteClassificationMessages({
    note: { title: '第一次租房求建议', desc: fullBody, author: '普通用户', tags: ['长阳租房'] },
    localWords: ['房山', '长阳', '朱岗子', '大宁村']
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /必须同时阅读标题和完整正文/);
  assert.match(messages[1].content, /【标题】第一次租房求建议/);
  assert.match(messages[1].content, new RegExp(fullBody));
  assert.match(messages[1].content, /【服务区域】房山、长阳、朱岗子、大宁村/);
});

test('note classifier parses fenced structured JSON and normalizes labels', () => {
  const parsed = llm.parseNoteClassificationContent('```json\n{"role":"租户","locationMatch":"匹配","demandLocation":"长阳","confidence":0.91,"reason":"正文明确说本人想租","evidence":"想整租一居"}\n```');

  assert.equal(parsed.role, 'tenant');
  assert.equal(parsed.locationMatch, 'match');
  assert.equal(parsed.demandLocation, '长阳');
  assert.equal(parsed.confidence, 0.91);
});

test('all search results wait for detail classification even with generic titles and zero comments', () => {
  const queued = engine.prepareNotesForDetailClassification([
    { id: 'a', title: '求建议', comments: 0 },
    { id: 'b', title: '今天搬家', comments: 0 },
    { id: 'c', title: '长阳两居', comments: 8 }
  ], {});

  assert.equal(queued.targets.length, 3);
  assert.deepEqual(queued.targets.map((note) => note.id), ['a', 'b', 'c']);
  assert.equal(queued.byIntent['待读取正文'], 3);
});

test('keyword mode classifies from title plus body after detail is read', async () => {
  const result = await engine.classifyDetailedNote({
    title: '第一次租房求建议',
    desc: '本人下个月想租长阳一居，预算四千五。',
    tags: []
  }, {
    lead_local_words: ['长阳'],
    lead_model: {
      llmClassificationEnabled: false,
      categories: [
        { id: 'tenant', name: '租户', action: 'comment', keywords: ['想租'], llmPrompt: '发布者本人明确求租' },
        { id: 'unknown', name: '不明', action: 'record', fallback: true }
      ]
    }
  });

  assert.equal(result.classificationMethod, 'keyword');
  assert.equal(result.categoryId, 'tenant');
  assert.equal(result.eligible, true);
  assert.match(result.evidence, /想租/);
});

test('llm category prompt includes every category prompt and the complete body', () => {
  const fullBody = '标题没说身份，但正文明确写本人想在长阳租一居。';
  const leadModel = {
    name: '租房获客',
    categories: [
      { id: 'tenant', name: '租户', description: '需求方', llmPrompt: '必须是发布者本人明确求租' },
      { id: 'supply', name: '房源方', description: '供给方', llmPrompt: '发布者在出租或转租房源' },
      { id: 'unknown', name: '不明', fallback: true, llmPrompt: '其他分类都不成立时使用' }
    ],
    slots: [
      { key: 'area', name: '区域', description: '城市、区县、地铁站或小区位置', enabled: true },
      { key: 'budget', name: '预算', description: '租金预算', enabled: true }
    ]
  };
  const messages = llm.buildNoteCategoryClassificationMessages({
    note: { title: '租房记录', desc: fullBody },
    localWords: ['长阳'],
    leadModel
  });

  assert.match(messages[0].content, /必须同时阅读标题和完整正文/);
  assert.match(messages[0].content, /必须是发布者本人明确求租/);
  assert.match(messages[0].content, /发布者在出租或转租房源/);
  assert.match(messages[0].content, /甘泉路、志丹路、新村路地铁站/);
  assert.match(messages[0].content, /budget（预算）：租金预算/);
  assert.match(messages[0].content, /slotValues/);
  assert.match(messages[1].content, new RegExp(fullBody));
});

test('llm structured classification preserves extracted location and configured slots', () => {
  const categories = [
    { id: 'tenant', name: '租户', action: 'comment' },
    { id: 'unknown', name: '不明', action: 'record', fallback: true }
  ];
  const parsed = llm.parseNoteCategoryClassificationContent(JSON.stringify({
    categoryId: 'tenant', city: '北京', district: '房山区', location: '长阳',
    locationMatch: 'match', matchedServiceArea: '长阳', locationConfidence: 0.96,
    locationEvidence: '想在长阳整租一居', slotValues: { area: '长阳', budget: '4500元', room_type: '一居' },
    confidence: 0.95, reason: '本人明确求租', evidence: '想在长阳整租一居'
  }), categories);

  assert.equal(parsed.city, '北京');
  assert.equal(parsed.district, '房山区');
  assert.equal(parsed.matchedServiceArea, '长阳');
  assert.equal(parsed.locationConfidence, 0.96);
  assert.deepEqual(parsed.slotValues, { area: '长阳', budget: '4500元', room_type: '一居' });
});

test('service-area prompt uses title, body, extracted facts and geographic relationships', () => {
  const messages = llm.buildServiceAreaClassificationMessages({
    note: { title: '房山求租', desc: '本人想在房山朱岗子村附近租一居', tags: ['租房'] },
    extracted: { city: '北京', district: '房山区', location: '朱岗子村', locationEvidence: '房山朱岗子村' },
    localWords: ['朱岗子', '长阳']
  });

  assert.match(messages[0].content, /不能只做字符串包含/);
  assert.match(messages[0].content, /房山朱岗子村/);
  assert.match(messages[0].content, /上海普陀/);
  assert.match(messages[1].content, /【服务区域】朱岗子、长阳/);
  assert.match(messages[1].content, /【第一阶段地点事实】城市=北京；区县=房山区；具体位置=朱岗子村；地点原文=房山朱岗子村/);
  assert.match(messages[1].content, /【完整正文】本人想在房山朱岗子村附近租一居/);
});

test('service-area parser requires an exact configured area value', () => {
  const parsed = llm.parseServiceAreaClassificationContent(JSON.stringify({
    locationMatch: 'match', matchedServiceArea: '朱岗子', locationConfidence: 0.94,
    locationEvidence: '房山朱岗子村', reason: '朱岗子村属于配置的朱岗子服务区'
  }), ['朱岗子', '长阳']);

  assert.equal(parsed.locationMatch, 'match');
  assert.equal(parsed.matchedServiceArea, '朱岗子');
  assert.equal(parsed.locationConfidence, 0.94);
  assert.equal(parsed.locationEvidence, '房山朱岗子村');
});

test('llm can match a configured area through geographic alias reasoning', () => {
  const decision = engine.validateLlmLocation({
    locationMatch: 'match', matchedServiceArea: '朱岗子', locationConfidence: 0.95,
    locationEvidence: '房山朱岗子村', reason: '房山朱岗子村与服务区域朱岗子是同一地点'
  }, {
    title: '房山求租', desc: '本人想在房山朱岗子村附近租一居'
  }, { lead_local_words: ['朱岗子', '长阳'] });

  assert.equal(decision.locationMatch, 'match');
  assert.equal(decision.matchedServiceArea, '朱岗子');
});

test('confident llm mismatch with exact Shanghai evidence is preserved', () => {
  const cfg = { lead_local_words: ['北京朱岗子', '大宁村', '长阳', '稻田', '篱笆房', '长辛店'] };
  const decision = engine.validateLlmLocation({
    locationMatch: 'mismatch', matchedServiceArea: '', locationConfidence: 0.95,
    locationEvidence: '甘泉路志丹路交界处', reason: '正文地点在上海普陀，明确不属于配置的北京服务区域'
  }, {
    title: '7号线新村路转租',
    desc: '甘泉路志丹路交界处一居室转租，靠近7号线新村路地铁站'
  }, cfg);

  assert.equal(decision.locationMatch, 'mismatch');
  assert.match(decision.reason, /上海/);
});

test('llm match without configured area and body evidence is downgraded to unknown', () => {
  const decision = engine.validateLlmLocation({
    city: '北京', locationMatch: 'match', matchedServiceArea: '', locationConfidence: 0.9,
    locationEvidence: '', reason: '可能在附近'
  }, { title: '北京租房', desc: '想找一个一居室' }, { lead_local_words: ['北京朱岗子', '长阳'] });

  assert.equal(decision.locationMatch, 'unknown');
  assert.match(decision.reason, /证据不足/);
});

test('lead model switch independently chooses keyword or llm classification', () => {
  assert.equal(engine.isLlmNoteClassificationEnabled({ lead_model: { llmClassificationEnabled: false, categories: [{ id: 'unknown', fallback: true }] } }), false);
  assert.equal(engine.isLlmNoteClassificationEnabled({ lead_model: { llmClassificationEnabled: true, categories: [{ id: 'unknown', fallback: true }] } }), true);
});

test('enabled llm classification performs a second service-area diagnosis', async () => {
  const originalCategory = llm.classifyNoteCategory;
  const originalArea = llm.classifyServiceArea;
  let areaCalled = false;
  llm.classifyNoteCategory = async () => ({
    categoryId: 'tenant', city: '北京', district: '房山区', location: '朱岗子村',
    locationEvidence: '房山朱岗子村', slotValues: { area: '朱岗子村' },
    confidence: 0.93, reason: '发布者本人明确求租', evidence: '本人想租一居'
  });
  llm.classifyServiceArea = async ({ note, extracted, localWords }) => {
    areaCalled = true;
    assert.equal(note.desc, '本人想在房山朱岗子村附近租一居');
    assert.equal(extracted.location, '朱岗子村');
    assert.deepEqual(localWords, ['朱岗子', '长阳']);
    return {
      locationMatch: 'match', matchedServiceArea: '朱岗子', locationConfidence: 0.96,
      locationEvidence: '房山朱岗子村', reason: '房山朱岗子村属于朱岗子服务区'
    };
  };

  try {
    const result = await engine.classifyDetailedNote({
      title: '房山求租', desc: '本人想在房山朱岗子村附近租一居'
    }, {
      llm_enabled: true, llm_api_key: 'test-key', llm_provider: 'dashscope', llm_model: 'test-model',
      lead_local_words: ['朱岗子', '长阳'],
      lead_model: {
        llmClassificationEnabled: true,
        categories: [
          { id: 'tenant', name: '租户', action: 'comment' },
          { id: 'unknown', name: '不明', action: 'record', fallback: true }
        ]
      }
    });

    assert.equal(areaCalled, true);
    assert.equal(result.classificationMethod, 'llm');
    assert.equal(result.locationMatch, 'match');
    assert.equal(result.matchedServiceArea, '朱岗子');
    assert.equal(result.eligible, true);
  } finally {
    llm.classifyNoteCategory = originalCategory;
    llm.classifyServiceArea = originalArea;
  }
});

test('only a confident in-area tenant is eligible for an author comment', () => {
  assert.equal(engine.noteClassificationDecision({ role: 'tenant', locationMatch: 'match', confidence: 0.9, reason: '本人求租' }).eligible, true);
  assert.equal(engine.noteClassificationDecision({ role: 'supply', locationMatch: 'match', confidence: 0.9, reason: '房东出租' }).eligible, false);
  assert.equal(engine.noteClassificationDecision({ role: 'tenant', locationMatch: 'mismatch', confidence: 0.9, reason: '求租石景山' }).eligible, false);
  assert.equal(engine.noteClassificationDecision({ role: 'tenant', locationMatch: 'unknown', confidence: 0.9, reason: '未说地点' }).eligible, false);
  assert.equal(engine.noteClassificationDecision({ role: 'tenant', locationMatch: 'match', confidence: 0.4, reason: '证据弱' }).eligible, false);
});

test('Beijing city mention does not make an unsupported district local', () => {
  const cfg = { lead_local_words: ['北京', '房山', '朱岗子', '大宁村', '长阳'] };

  assert.equal(engine.serviceAreaDecision('本人求租北京石景山一居', cfg).locationMatch, 'mismatch');
  assert.equal(engine.serviceAreaDecision('本人求租北京房山长阳一居', cfg).locationMatch, 'match');
  assert.equal(engine.serviceAreaDecision('在石景山上班，想租长阳一居', cfg).locationMatch, 'match');
});

test('enabled llm classification fails closed when the model service is unavailable', async () => {
  const result = await engine.classifyDetailedNote({ title: '长阳求租', desc: '本人想租一居' }, {
    llm_enabled: false,
    lead_local_words: ['长阳'],
    lead_model: {
      llmClassificationEnabled: true,
      categories: [
        { id: 'tenant', name: '租户', action: 'comment', keywords: ['求租'] },
        { id: 'unknown', name: '不明', action: 'record', fallback: true }
      ]
    }
  });

  assert.equal(result.classificationMethod, 'llm');
  assert.equal(result.categoryId, 'unknown');
  assert.equal(result.eligible, false);
  assert.match(result.decisionReason, /模型服务未启用/);
});
