'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine');

test('search page must be Xiaohongshu search_result with the exact keyword', () => {
  assert.equal(engine.searchPageMatches('https://www.xiaohongshu.com/search_result?keyword=%E6%AD%A6%E4%BE%AF%E5%8C%BA%E6%B1%82%E7%A7%9F', '武侯区求租'), true);
  assert.equal(engine.searchPageMatches('https://www.xiaohongshu.com/search_result/?keyword=%E6%AD%A6%E4%BE%AF%E5%8C%BA%E6%B1%82%E7%A7%9F&type=51', '武侯区求租'), true);
  assert.equal(engine.searchPageMatches('https://www.xiaohongshu.com/search_result_ai?keyword=%25E6%25AD%25A6%25E4%25BE%25AF%25E5%258C%25BA%25E6%25B1%2582%25E7%25A7%259F&source=web_explore_feed', '武侯区求租'), true);
  assert.equal(engine.searchPageMatches('https://www.xiaohongshu.com/explore', '武侯区求租'), false);
  assert.equal(engine.searchPageMatches('https://www.xiaohongshu.com/search_result?keyword=%E9%87%91%E7%89%9B%E5%8C%BA%E6%B1%82%E7%A7%9F', '武侯区求租'), false);
  assert.equal(engine.searchPageMatches('https://evil.example/search_result?keyword=%E6%AD%A6%E4%BE%AF%E5%8C%BA%E6%B1%82%E7%A7%9F', '武侯区求租'), false);
});

test('search page probe is parsed without accepting legacy text accidentally', () => {
  assert.deepEqual(engine.parseSearchPageProbe(JSON.stringify({ readyState: 'complete', count: 20, url: 'https://www.xiaohongshu.com/search_result?keyword=test' })), {
    readyState: 'complete',
    count: 20,
    url: 'https://www.xiaohongshu.com/search_result?keyword=test'
  });
  assert.deepEqual(engine.parseSearchPageProbe('complete|20'), { readyState: '', count: 0, url: '' });
});

test('search mismatch uses a dedicated fail-closed error', () => {
  const error = engine.searchPageMismatchError('武侯区求租', 'https://www.xiaohongshu.com/explore');
  assert.equal(error.code, 'SEARCH_PAGE_MISMATCH');
  assert.equal(engine.isSearchPageMismatchError(error), true);
});

test('keyword matching tolerates URL encoding but not a different search term', () => {
  assert.equal(engine.searchPageMatches(engine.buildSearchUrl('大宁村 租房'), '大宁村 租房'), true);
  assert.equal(engine.searchPageMatches(engine.buildSearchUrl('大宁村求租'), '大宁村租房'), false);
});

test('visible page search input probe requires usable coordinates', () => {
  assert.deepEqual(engine.parseSearchInputProbe(JSON.stringify({ x: 419, y: 36, value: '武侯区求租', placeholder: '搜索' })), {
    x: 419,
    y: 36,
    value: '武侯区求租',
    placeholder: '搜索'
  });
  assert.equal(engine.parseSearchInputProbe(''), null);
  assert.match(engine.SEARCH_INPUT_PROBE, /textarea#search-input/);
  assert.match(engine.SEARCH_INPUT_PROBE, /opacity/);
  assert.match(engine.SEARCH_SUBMIT_PROBE, /submit-button-wrapper/);
  assert.match(engine.SEARCH_SUBMIT_PROBE, /single-line-search-btn/);
});

test('page UI search clicks, replaces text and clicks submit without direct navigation', async () => {
  const calls = [];
  let probeCount = 0;
  const client = {
    async evaluate({ expression }) {
      if (expression.includes('document.title')) return { value: JSON.stringify({ url: 'https://www.xiaohongshu.com/explore', title: '小红书' }) };
      if (expression === engine.SEARCH_SUBMIT_PROBE) return { value: JSON.stringify({ x: 690, y: 36 }) };
      probeCount++;
      return { value: JSON.stringify({ x: 419, y: 36, value: probeCount > 1 ? '武侯区求租' : '', placeholder: '搜索', focused: true }) };
    },
    async click(point) { calls.push(['click', point.x, point.y]); },
    async selectAll() { calls.push(['selectAll']); },
    async typeText({ text }) { calls.push(['typeText', text]); },
    async navigate() { calls.push(['navigate']); }
  };
  await engine.searchFromPageUi({ client, target: {}, keyword: '武侯区求租' });
  assert.deepEqual(calls.map((call) => call[0]), ['click', 'selectAll', 'typeText', 'click']);
});

test('page UI search reuses an already-open matching AI result page', async () => {
  const calls = [];
  const client = {
    async evaluate({ expression }) {
      if (expression.includes('document.title')) return {
        value: JSON.stringify({
          url: 'https://www.xiaohongshu.com/search_result_ai?keyword=%25E6%25AD%25A6%25E4%25BE%25AF%25E5%258C%25BA%25E6%25B1%2582%25E7%25A7%259F',
          title: '武侯区求租 - 小红书搜索'
        })
      };
      calls.push('probe');
      return { value: '' };
    },
    async click() { calls.push('click'); },
    async selectAll() { calls.push('selectAll'); },
    async typeText() { calls.push('typeText'); }
  };
  const result = await engine.searchFromPageUi({ client, target: {}, keyword: '武侯区求租' });
  assert.equal(result.reused, true);
  assert.deepEqual(calls, []);
});

test('page UI search retries a search term that was appended instead of replacing', async () => {
  const calls = [];
  let selectCount = 0;
  const client = {
    async evaluate({ expression }) {
      if (expression.includes('document.title')) return { value: JSON.stringify({ url: 'https://www.xiaohongshu.com/explore', title: '小红书' }) };
      if (expression === engine.SEARCH_SUBMIT_PROBE) return { value: JSON.stringify({ x: 690, y: 36 }) };
      return { value: JSON.stringify({ x: 419, y: 36, value: selectCount >= 2 ? '金牛区求租' : '武侯区求租金牛区求租', placeholder: '搜索', focused: true }) };
    },
    async click() { calls.push('click'); },
    async selectAll() { selectCount++; calls.push('selectAll'); },
    async typeText() { calls.push('typeText'); }
  };
  await engine.searchFromPageUi({ client, target: {}, keyword: '金牛区求租' });
  assert.equal(selectCount, 2);
  assert.deepEqual(calls, ['click', 'selectAll', 'typeText', 'click', 'selectAll', 'typeText', 'click']);
});

test('page UI search can dismiss a leftover detail layer before finding the search box', () => {
  assert.match(String(engine.searchFromPageUi), /pressKey/);
  assert.match(String(engine.searchFromPageUi), /Escape/);
});
