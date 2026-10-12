'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detailExtractExpr, detailSignature } = require('../src/engine');

function runDetailExtract(expectedId, noteState) {
  const expression = detailExtractExpr(expectedId);
  const fn = new Function('window', 'location', 'return ' + expression);
  return JSON.parse(fn({ __INITIAL_STATE__: { note: noteState } }, { href: 'https://www.xiaohongshu.com/search_result' }));
}

test('detail extraction never falls back to a stale cached note', () => {
  const result = runDetailExtract('expected-note', {
    currentNoteId: { value: 'old-note' },
    noteDetailMap: {
      'old-note': { note: { title: '上一篇', desc: '上海房源' } },
      'expected-note': { note: { title: '当前篇', desc: '石家庄求租' } }
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'current_note_mismatch');
  assert.equal(result.currentNoteId, 'old-note');
});

test('detail extraction returns only the exact expected note', () => {
  const result = runDetailExtract('expected-note', {
    currentNoteId: { value: 'expected-note' },
    noteDetailMap: {
      'old-note': { note: { title: '上一篇', desc: '上海房源' } },
      'expected-note': { note: { title: '当前篇', desc: '石家庄求租', user: { nickname: '租客' } } }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'expected-note');
  assert.equal(result.title, '当前篇');
  assert.notEqual(detailSignature(result), '');
});
