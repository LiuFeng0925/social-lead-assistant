'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCommentText, visibilityProbeExpression, balancedSample } = require('../src/comment-visibility');

test('comment visibility comparison ignores layout whitespace but keeps the actual content', () => {
  assert.equal(normalizeCommentText(' 有房！\n刚腾出来的\u200b '), '有房！刚腾出来的');
  const expression = visibilityProbeExpression({ userId: 'user-1', nickname: '小王', content: '有房！' });
  assert.match(expression, /user-1/);
  assert.match(expression, /有房/);
  assert.match(expression, /user\\\/profile/);
});

test('global visibility sampling is balanced across accounts', () => {
  const groups = [
    { accountId: 1, items: Array.from({ length: 8 }, (_, id) => ({ id })) },
    { accountId: 2, items: [{ id: 10 }, { id: 11 }] },
    { accountId: 3, items: [{ id: 20 }, { id: 21 }] }
  ];
  const sample = balancedSample(groups, 6, () => 0.5);
  assert.equal(sample.length, 6);
  assert.deepEqual(new Set(sample.map((item) => item.accountId)), new Set([1, 2, 3]));
  const counts = sample.reduce((out, item) => ((out[item.accountId] = (out[item.accountId] || 0) + 1), out), {});
  assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) <= 1);
});
