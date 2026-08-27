'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { leadTextDecision, leadActorDecision, replyOpenNoteComment, shouldCommentNoteAuthor } = require('../src/engine');

test('outreach only comments a confirmed tenant note author', () => {
  assert.equal(shouldCommentNoteAuthor({ role: 'tenant', eligible: true }), true);
  assert.equal(shouldCommentNoteAuthor({ role: 'agent', eligible: true }), false);
  assert.equal(shouldCommentNoteAuthor({ role: 'supply', eligible: false }), false);
  assert.equal(shouldCommentNoteAuthor({ role: 'tenant', eligible: false }), false);
});

test('comment lead detection accepts explicit rental demand', () => {
  assert.equal(leadTextDecision('长阳附近还有两居吗？预算五千，月底入住').eligible, true);
  assert.equal(leadTextDecision('我也在找房，想整租一居').eligible, true);
  assert.equal(leadTextDecision('求租武侯区住宅套一，准备长期住').eligible, true);
  assert.equal(leadTextDecision('求租武侯区住宅套一，不能短租，只要长租').eligible, true);
});

test('comment lead detection only accepts residential long-term renters', () => {
  assert.deepEqual(leadTextDecision('求租武侯区临街商铺，准备开奶茶店'), {
    eligible: false,
    reason: '非目标受众：求租商业用房，不是用于居住的住宅长租'
  });
  assert.equal(leadTextDecision('找个门面房做餐饮').eligible, false);
  assert.match(leadTextDecision('求租套一，只住两个月').reason, /1到3个月短租/);
  assert.match(leadTextDecision('工作过渡，想租3个月').reason, /1到3个月短租/);
});

test('comment lead detection rejects agents and property listings', () => {
  assert.equal(leadTextDecision('房东直租，精装两居随时带看').eligible, false);
  assert.equal(leadTextDecision('我是中介，有房源可以合作').eligible, false);
  assert.equal(leadTextDecision('私你了').eligible, false);
  assert.equal(leadTextDecision('我手上有两居，主页有房源').eligible, false);
});

test('role is based on demand text rather than author identity', () => {
  assert.equal(leadTextDecision('作者本人求租长阳一居，预算四千').eligible, true);
  assert.equal(leadTextDecision('这个房源还有吗，多少钱').eligible, true);
});

test('comment lead detection rejects vague engagement', () => {
  assert.equal(leadTextDecision('写得真好，收藏了').eligible, false);
});

test('room type by itself is not rental demand', () => {
  assert.equal(leadTextDecision('良乡大学城一居loft 被这套硬控了').eligible, false);
  assert.equal(leadTextDecision('长阳精装两居，随时可看').eligible, false);
  assert.equal(leadTextDecision('想租长阳一居，下月入住').eligible, true);
});

test('explicit agent nicknames are rejected even when their comment sounds interested', () => {
  assert.equal(leadActorDecision('多少钱，还在吗', '贝壳找房合肥-小张').eligible, false);
  assert.equal(leadActorDecision('求租长阳一居', '普通租客').eligible, true);
});

test('notes from an explicit unsupported city are rejected', () => {
  const cfg = { lead_local_words: ['北京', '房山', '长阳', '朱岗子', '大宁村'] };
  assert.equal(leadTextDecision('求租合肥包河区一居', cfg).reason, '异地内容');
  assert.equal(leadTextDecision('求租北京房山长阳一居', cfg).eligible, true);
});

test('stopped machine never starts a comment-area reply', async () => {
  const client = new Proxy({}, { get() { throw new Error('browser must not be touched after stop'); } });
  const result = await replyOpenNoteComment({
    client,
    target: {},
    item: { nick: 'tester', content: '求租一居' },
    text: '房东直租，私',
    dry: false,
    shouldStop: () => true
  });
  assert.equal(result.stopped, true);
  assert.equal(result.ok, false);
});

test('comment-area reply fails closed when the composer is not bound to the intended nickname', async () => {
  const expressions = [];
  let evaluateCall = 0;
  let clicks = 0;
  let typed = false;
  const client = {
    evaluate: async ({ expression }) => {
      expressions.push(expression);
      evaluateCall++;
      if (evaluateCall === 1) return { value: JSON.stringify({ x: 10, y: 20, token: 'reply-token' }) };
      return { value: JSON.stringify({ verified: false, count: 0 }) };
    },
    humanMove: async () => {},
    click: async () => { clicks++; },
    typeText: async () => { typed = true; }
  };
  const result = await replyOpenNoteComment({
    client,
    target: {},
    item: {
      nick: '今天你睡了吗',
      content: '还在吗',
      user_link: '/user/profile/66a0feb3000000002401dd30?xsec_source=pc_comment'
    },
    text: '有的',
    dry: false
  });
  assert.equal(result.ok, false);
  assert.match(result.msg, /已中止发送/);
  assert.equal(clicks, 1, 'only the reply control may be clicked before target verification');
  assert.equal(typed, false, 'text must never be typed into an unverified top-level composer');
  assert.ok(expressions[0].includes('66a0feb3000000002401dd30'), 'exact commenter profile must participate in row matching');
  assert.ok(expressions[1].includes('今天你睡了吗'), 'composer verification must require the intended nickname');
});
