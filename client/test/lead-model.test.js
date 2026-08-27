'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/engine');
const {
  DEFAULT_RENT_COMMENT_STRATEGY,
  defaultLeadModel,
  normalizeLeadModel,
  classifyNote,
  classifyNotes,
} = require('../src/lead-model');

test('default lead model classifies rental notes with configured categories', () => {
  const model = defaultLeadModel();

  assert.equal(model.llmClassificationEnabled, false, 'keyword classification should remain the default');
  assert.match(model.categories.find((c) => c.id === 'seek_rent').llmPrompt, /发布者本人/);
  assert.match(model.categories.find((c) => c.id === 'seek_rent').llmPrompt, /用于日常居住的住宅/);
  assert.match(model.categories.find((c) => c.id === 'seek_rent').llmPrompt, /1到3个月/);

  const seek = classifyNote({ title: '朝阳求租一居 预算5000 近地铁', author: '安安' }, model);
  assert.equal(seek.categoryName, '求租笔记');
  assert.equal(seek.action, 'comment');
  assert.equal(seek.isTarget, true);
  assert.ok(seek.evidence.some((x) => x.includes('求租')));

  const supply = classifyNote({ title: '望京房东直租一居 拎包入住', author: '小周' }, model);
  assert.equal(supply.categoryName, '房源笔记');
  assert.equal(supply.action, 'skip');

  const unknown = classifyNote({ title: '北京生活碎片', author: '普通用户' }, model);
  assert.equal(unknown.categoryName, '不明');
  assert.equal(unknown.action, 'record');
});

test('legacy rental prompt is upgraded to residential long-term targeting', () => {
  const model = normalizeLeadModel({
    categories: [
      {
        id: '求租笔记', name: '求租笔记', action: 'comment', keywords: ['求租'],
        llmPrompt: '只有发布者本人明确表达正在求租、找房、想租房或询问租房方案时才归入此类。不能因为标题里出现“租房”就判断为求租；要结合正文里的第一人称诉求、地点、预算、户型、入住时间等信息。'
      },
      { id: 'unknown', name: '不明', action: 'record', fallback: true }
    ]
  });
  assert.match(model.categories[0].llmPrompt, /商业或经营用途/);
  assert.match(model.categories[0].llmPrompt, /普通住宅求租未写租期/);
});

test('lead model normalization preserves the llm classification switch and category prompts', () => {
  const model = normalizeLeadModel({
    name: '自定义获客',
    llmClassificationEnabled: true,
    categories: [
      { id: 'buyer', name: '买家', action: 'comment', keywords: ['求购'], llmPrompt: '正文明确表达本人求购' },
      { id: 'unknown', name: '不明', action: 'record', fallback: true, llmPrompt: '不能可靠判断时使用' }
    ]
  });

  assert.equal(model.llmClassificationEnabled, true);
  assert.equal(model.categories[0].llmPrompt, '正文明确表达本人求购');
  assert.equal(model.categories[1].llmPrompt, '不能可靠判断时使用');
});

test('rental demand category does not use room type alone as intent', () => {
  const model = normalizeLeadModel({
    categories: [{ id: '求租笔记', name: '求租笔记', action: 'comment', keywords: ['求租', '一居', '两居'] }]
  });
  assert.deepEqual(model.categories[0].keywords, ['求租']);
});

test('default rental comment strategy handles weak note information explicitly', () => {
  const model = defaultLeadModel();
  const seek = model.categories.find((c) => c.id === 'seek_rent');

  assert.ok(seek, 'seek rent category should exist');
  assert.match(seek.replyStrategy, /系统能确定/, 'strategy should document the reasoning process');
  assert.match(seek.replyStrategy, /location = 望京/, 'strategy should document slot extraction');
  assert.match(seek.replyStrategy, /不要脑补/, 'strategy should forbid guessing missing slots');
  assert.match(seek.replyStrategy, /预算/, 'strategy should mention budget handling');
  assert.match(seek.replyStrategy, /户型/, 'strategy should mention room type handling');
});

test('legacy default rental strategy is upgraded without overwriting custom strategy', () => {
  const legacy = normalizeLeadModel({
    name: '租房获客',
    categories: [
      {
        id: 'seek_rent',
        name: '求租笔记',
        action: 'comment',
        keywords: ['求租'],
        replyStrategy: '结合区域、预算、户型等诉求友好回应,引导看主页/私聊,绝不留联系方式',
      },
      {
        id: 'custom',
        name: '自定义',
        action: 'comment',
        keywords: ['咨询'],
        replyStrategy: '我自己写的评论策略',
      },
      { id: 'unknown', name: '不明', action: 'record', fallback: true },
    ],
  });

  assert.equal(legacy.categories[0].replyStrategy, DEFAULT_RENT_COMMENT_STRATEGY);
  assert.equal(legacy.categories[1].replyStrategy, '我自己写的评论策略');
});

test('custom lead model can replace rental intent with another industry', () => {
  const courseModel = {
    name: '教育获客',
    categories: [
      {
        id: 'course_buyer',
        name: '想报课笔记',
        action: 'comment',
        keywords: ['想学', '报课', '求推荐', '找老师'],
        replyStrategy: '结合科目和目标友好回应,引导私聊咨询',
      },
      {
        id: 'course_seller',
        name: '机构卖课笔记',
        action: 'skip',
        keywords: ['招生', '课程优惠', '名师班'],
      },
      { id: 'unknown', name: '不明', action: 'record', fallback: true },
    ],
  };

  const buyer = classifyNote({ title: '想学雅思 求推荐靠谱老师', desc: '目标 7 分' }, courseModel);
  assert.equal(buyer.categoryName, '想报课笔记');
  assert.equal(buyer.isTarget, true);

  const seller = classifyNote({ title: '雅思名师班招生 课程优惠', desc: '限时报名' }, courseModel);
  assert.equal(seller.categoryName, '机构卖课笔记');
  assert.equal(seller.isTarget, false);

  const grouped = classifyNotes([
    { id: 'a', title: '想学雅思 求推荐靠谱老师' },
    { id: 'b', title: '雅思名师班招生 课程优惠' },
  ], courseModel);
  assert.deepEqual(grouped.targets.map((n) => n.id), ['a']);
  assert.equal(grouped.byIntent['想报课笔记'], 1);
  assert.equal(grouped.byIntent['机构卖课笔记'], 1);
});

test('engine matchNotes uses configured lead model instead of hard-coded rental labels', () => {
  const courseModel = {
    name: '教育获客',
    categories: [
      { id: 'buyer', name: '求课笔记', action: 'comment', keywords: ['想学', '求推荐'] },
      { id: 'seller', name: '卖课笔记', action: 'skip', keywords: ['招生', '优惠'] },
      { id: 'unknown', name: '不明', action: 'record', fallback: true },
    ],
  };

  const out = engine.matchNotes([
    { id: '1', title: '想学钢琴 求推荐老师' },
    { id: '2', title: '钢琴课招生 暑期优惠' },
  ], { lead_model: courseModel });

  assert.deepEqual(out.targets.map((n) => n.id), ['1']);
  assert.equal(out.tagged[0].intent, '求课笔记');
  assert.equal(out.tagged[1].intent, '卖课笔记');
  assert.equal(out.byIntent['求课笔记'], 1);
  assert.equal(out.byIntent['卖课笔记'], 1);
});

test('rule classification is deterministic by category order instead of scoring weights', () => {
  const model = {
    name: '教育获客',
    categories: [
      { id: 'buyer', name: '求课笔记', action: 'comment', keywords: ['想学'] },
      { id: 'seller', name: '卖课笔记', action: 'skip', keywords: ['想学', '雅思', '老师'] },
      { id: 'unknown', name: '不明', action: 'record', fallback: true },
    ],
  };

  const out = classifyNote({ title: '想学雅思 求推荐老师' }, model);

  assert.equal(out.categoryName, '求课笔记');
  assert.equal(out.classifyReason, '内容命中:想学');
  assert.equal(out.needsLlmFallback, false);
});

test('exclude keywords block a category before falling through to later categories', () => {
  const model = {
    name: '租房获客',
    categories: [
      { id: 'seek', name: '求租笔记', action: 'comment', keywords: ['预算'], excludeKeywords: ['出租'] },
      { id: 'supply', name: '房源笔记', action: 'skip', keywords: ['出租'] },
      { id: 'unknown', name: '不明', action: 'record', fallback: true },
    ],
  };

  const out = classifyNote({ title: '朝阳一居预算5000 出租' }, model);

  assert.equal(out.categoryName, '房源笔记');
  assert.equal(out.classifyReason, '内容命中:出租');
});

test('unmatched notes go to fallback and are marked for future llm fallback', () => {
  const out = classifyNote({ title: '北京生活碎片' }, defaultLeadModel());

  assert.equal(out.categoryName, '不明');
  assert.equal(out.needsLlmFallback, true);
  assert.equal(out.classifyReason, '未命中规则,进入兜底分类');
});

test('author nickname is not used for note classification', () => {
  const model = {
    name: '租房获客',
    categories: [
      { id: 'agent', name: '中介/同行', action: 'skip', keywords: ['中介'], authorKeywords: ['房产'] },
      { id: 'unknown', name: '不明', action: 'record', fallback: true },
    ],
  };

  const out = classifyNote({ title: '今天随便逛逛', author: '朝阳房产小王' }, model);

  assert.equal(out.categoryName, '不明');
  assert.equal(out.classifyReason, '未命中规则,进入兜底分类');
});
