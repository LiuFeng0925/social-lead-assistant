'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKeywords, uniqueNotes, limitNotes, keywordScanPlan } = require('../src/keyword-utils');

test('keywords accept Chinese commas, English commas, semicolons, and newlines', () => {
  assert.deepEqual(parseKeywords('长阳租房，房山租房, 良乡租房；长阳租房\n大学城租房'), ['长阳租房', '房山租房', '良乡租房', '大学城租房']);
});

test('notes from overlapping keyword searches are de-duplicated', () => {
  const notes = uniqueNotes([{ id: 'a', title: 'first' }, { id: 'a', title: 'duplicate' }, { url: '/note/b' }]);
  assert.deepEqual(notes.map((note) => note.id || note.url), ['a', '/note/b']);
});

test('up to twenty keywords are accepted', () => {
  const keywords = Array.from({ length: 20 }, (_, i) => `keyword-${i + 1}`);
  assert.equal(parseKeywords(keywords.join(','), '', 20).length, 20);
});

test('multi-keyword scan results never exceed the configured total', () => {
  const notes = Array.from({ length: 80 }, (_, i) => ({ id: String(i) }));
  assert.equal(limitNotes(notes, 40).length, 40);
});

test('forty notes are distributed as two per keyword across twenty keywords', () => {
  const keywords = Array.from({ length: 20 }, (_, i) => `keyword-${i + 1}`);
  const quotas = keywords.map((_, index) => keywordScanPlan(keywords.join(','), 40, index).quota);
  assert.deepEqual(quotas, Array(20).fill(2));
  assert.equal(quotas.reduce((sum, value) => sum + value, 0), 40);
});
