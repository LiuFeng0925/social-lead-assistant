'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_OUTREACH_TEXTS, normalizeOutreachTexts, createOutreachPicker } = require('../src/outreach-copy');

test('outreach copy pool preserves a legacy phrase and accepts at most ten unique phrases', () => {
  assert.deepEqual(normalizeOutreachTexts([], '  有房，刚腾出来的  '), ['有房，刚腾出来的']);
  const values = Array.from({ length: 14 }, (_, index) => '话术 ' + (index + 1));
  values.splice(4, 0, '话术 1');
  const normalized = normalizeOutreachTexts(values);
  assert.equal(normalized.length, MAX_OUTREACH_TEXTS);
  assert.equal(new Set(normalized).size, MAX_OUTREACH_TEXTS);
});

test('random outreach picker uses every configured phrase before refilling the pool', () => {
  const picker = createOutreachPicker({ random: () => 0.25 });
  const config = { outreach_fixed_texts: ['第一条', '第二条', '第三条'] };
  const firstRound = [picker.pick(config), picker.pick(config), picker.pick(config)];
  assert.deepEqual(new Set(firstRound), new Set(config.outreach_fixed_texts));
  assert.ok(config.outreach_fixed_texts.includes(picker.pick(config)));
});

test('empty outreach pool leaves generation to AI or the built-in template', () => {
  const picker = createOutreachPicker();
  assert.equal(picker.pick({ outreach_fixed_texts: [], outreach_fixed_text: '' }), '');
});
