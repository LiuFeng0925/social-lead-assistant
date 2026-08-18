'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sameSearchContext, listStateExpr, searchScrollStateExpr, resetSearchScrollExpr, isSearchListPath, decodedSearchKeyword, ensureSearchList, locateNoteCard, openNoteFromList } = require('../src/note-navigation');

test('note navigation distinguishes different keyword result pages', () => {
  const first = 'https://www.xiaohongshu.com/search_result?keyword=%E6%9C%B1%E5%B2%97%E5%AD%90%E7%A7%9F%E6%88%BF&source=web_search_result_notes';
  const second = 'https://www.xiaohongshu.com/search_result?keyword=%E9%95%BF%E9%98%B3%E7%A7%9F%E6%88%BF&source=web_search_result_notes';
  assert.equal(sameSearchContext(first, first), true);
  assert.equal(sameSearchContext(first, second), false);
});

test('search-list probe includes the current url', () => {
  const expression = listStateExpr();
  assert.match(expression, /location\.href/);
  assert.match(expression, /search_result/);
  assert.match(expression, /_ai/);
  assert.doesNotThrow(() => new Function('return ' + expression));
});

test('classic and AI search pages are both recognized as search lists', () => {
  assert.equal(isSearchListPath('/search_result'), true);
  assert.equal(isSearchListPath('/search_result/'), true);
  assert.equal(isSearchListPath('/search_result_ai'), true);
  assert.equal(isSearchListPath('/explore'), false);
});

test('AI search double-encoded keyword matches the classic search context', () => {
  const classic = 'https://www.xiaohongshu.com/search_result?keyword=%E6%AD%A6%E4%BE%AF%E5%8C%BA%E6%B1%82%E7%A7%9F';
  const ai = 'https://www.xiaohongshu.com/search_result_ai?keyword=%25E6%25AD%25A6%25E4%25BE%25AF%25E5%258C%25BA%25E6%25B1%2582%25E7%25A7%259F';
  assert.equal(decodedSearchKeyword('%E6%AD%A6%E4%BE%AF%E5%8C%BA%E6%B1%82%E7%A7%9F'), '武侯区求租');
  assert.equal(sameSearchContext(ai, classic), true);
  assert.equal(sameSearchContext(ai, classic.replace('%E6%AD%A6%E4%BE%AF%E5%8C%BA%E6%B1%82%E7%A7%9F', '%E9%87%91%E7%89%9B%E5%8C%BA%E6%B1%82%E7%A7%9F')), false);
});

test('note opening no longer contains a direct-link fallback', () => {
  assert.doesNotMatch(String(openNoteFromList), /openDirectly|client\.navigate/);
});

test('AI search scrolling targets its internal results container', () => {
  const stateExpression = searchScrollStateExpr();
  const resetExpression = resetSearchScrollExpr();
  assert.match(stateExpression, /ai-feeds-page/);
  assert.match(stateExpression, /scrollTop/);
  assert.match(resetExpression, /scrollTop=0/);
  assert.doesNotThrow(() => new Function('return ' + stateExpression));
  assert.doesNotThrow(() => new Function('return ' + resetExpression));
});

test('matching search page waits for cards instead of navigating backward', async () => {
  const href = 'https://www.xiaohongshu.com/search_result_ai?keyword=%25E9%25BE%2599%25E6%25B3%2589%25E9%25A9%25BF%25E5%258C%25BA%25E7%25A7%259F%25E6%2588%25BF';
  let probes = 0;
  let backCount = 0;
  const client = {
    async evaluate() {
      probes++;
      return { value: JSON.stringify({ onSearch: true, cardCount: probes >= 2 ? 12 : 0, href }) };
    },
    async goBack() { backCount++; }
  };
  const state = await ensureSearchList({ client, target: {}, searchUrl: href });
  assert.equal(state.cardCount, 12);
  assert.equal(backCount, 0);
});

test('note locator retries from the list top after the current scroll position is exhausted', () => {
  const source = String(locateNoteCard);
  assert.match(source, /resetSearchListScroll/);
  assert.match(source, /回到列表顶部/);
  assert.match(source, /scroll\.top/);
  assert.match(source, /scroll\.max/);
});
