'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKeywords, uniqueNotes, limitNotes, keywordScanPlan, migrateLegacyTotalSchedule } = require('../src/keyword-utils');

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

test('configured note amount applies independently to every keyword', () => {
  const keywords = Array.from({ length: 20 }, (_, i) => `keyword-${i + 1}`);
  const quotas = keywords.map((_, index) => keywordScanPlan(keywords.join(','), 40, index).quota);
  assert.deepEqual(quotas, Array(20).fill(40));
  assert.equal(keywordScanPlan(keywords.join(','), 40, 0).total, 800);
});

test('legacy total scan amounts migrate to equivalent per-keyword amounts', () => {
  const schedule = [{ on: true, windows: [{ start: '01:00', end: '23:00', notes: 2000, quota: 100 }] }];
  const migrated = migrateLegacyTotalSchedule(schedule, 5);
  assert.equal(migrated[0].windows[0].notes, 400);
  assert.equal(schedule[0].windows[0].notes, 2000, 'migration should not mutate the saved object in place');
});
