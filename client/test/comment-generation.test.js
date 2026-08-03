'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/engine');
const llm = require('../src/llm');

test('comment analysis exposes the weak-location reasoning process', () => {
  const analysis = engine.analyzeCommentNeed({ id: 'weak-area', title: '望京求租房' }, { task_keyword: '北京 租房' });

  assert.equal(analysis.intent, '求租');
  assert.equal(analysis.location, '望京');
  assert.equal(analysis.locationType, '商圈/区域');
  assert.equal(analysis.city, '北京');
  assert.equal(analysis.budget, '未知');
  assert.equal(analysis.roomType, '未知');
  assert.equal(analysis.commute, '未知');
  assert.deepEqual(analysis.nearbyLocations, ['望京', '望京SOHO', '望京南', '望京西', '阜通', '东湖渠', '来广营附近']);
  assert.equal(analysis.mode, 'semi_match');

  const context = engine.formatCommentContext(analysis);
  assert.match(context, /系统能确定的只有/);
  assert.match(context, /location = 望京/);
  assert.match(context, /location_type = 商圈\/区域/);
  assert.match(context, /预算: 未知/);
  assert.match(context, /房源库检索/);
  assert.match(context, /不要脑补/);
  assert.match(context, /不要直接说/);
});

test('fallback comment asks missing details when the note only gives an area', () => {
  const comment = engine.genComment({ id: 'weak-area', title: '望京求租房' });

  assert.match(comment, /望京/, 'comment should acknowledge the known area');
  assert.match(comment, /预算/, 'comment should ask for missing budget');
  assert.match(comment, /几居|户型|单间/, 'comment should ask for missing room type');
  assert.doesNotMatch(comment, /预算\d/, 'comment should not invent a budget');
});

test('comment direction prefers category comment strategy over global task direction', () => {
  const direction = engine.buildCommentDirection(
    { category_reply_strategy: '分类策略:缺预算先追问' },
    '全局方向:引导看主页'
  );

  assert.match(direction, /^分类策略/, 'category strategy should be first in the prompt');
  assert.match(direction, /全局方向/, 'global direction should remain as a fallback constraint');
});

test('llm comment prompt includes structured system judgment', () => {
  const analysis = engine.analyzeCommentNeed({ id: 'weak-area', title: '望京求租房' }, { task_keyword: '北京 租房' });
  const messages = llm.buildCommentMessages({
    note: { title: '望京求租房', desc: '', tags: [], comment_context: engine.formatCommentContext(analysis) },
    direction: '分类策略:缺信息先追问',
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /未知/);
  assert.match(messages[1].content, /【系统判断】/);
  assert.match(messages[1].content, /location = 望京/);
  assert.match(messages[1].content, /不要直接说/);
});
