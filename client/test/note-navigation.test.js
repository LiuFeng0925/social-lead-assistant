'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sameSearchContext, listStateExpr } = require('../src/note-navigation');

test('note navigation distinguishes different keyword result pages', () => {
  const first = 'https://www.xiaohongshu.com/search_result?keyword=%E6%9C%B1%E5%B2%97%E5%AD%90%E7%A7%9F%E6%88%BF&source=web_search_result_notes';
  const second = 'https://www.xiaohongshu.com/search_result?keyword=%E9%95%BF%E9%98%B3%E7%A7%9F%E6%88%BF&source=web_search_result_notes';
  assert.equal(sameSearchContext(first, first), true);
  assert.equal(sameSearchContext(first, second), false);
});

test('search-list probe includes the current url', () => {
  assert.match(listStateExpr(), /location\.href/);
});
