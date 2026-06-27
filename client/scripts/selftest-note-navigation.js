'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  findNoteCardExpr,
  findCloseButtonExpr,
  detailStateExpr,
  listStateExpr,
  parseEvalJson
} = require('../src/note-navigation');

function rect(x, y, width, height) {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
}

function anchor(href, cardRect) {
  const card = { getBoundingClientRect: () => cardRect };
  return {
    href,
    getAttribute: (name) => (name === 'href' ? href : ''),
    closest: () => card,
    getBoundingClientRect: () => cardRect
  };
}

function runExpr(expression, context) {
  return parseEvalJson(vm.runInNewContext(expression, context));
}

function testFindsNoteCardById() {
  const result = runExpr(findNoteCardExpr({ id: 'abc123', url: 'https://www.xiaohongshu.com/explore/abc123' }), {
    document: {
      querySelectorAll: () => [
        anchor('https://www.xiaohongshu.com/explore/other', rect(10, 10, 200, 260)),
        anchor('https://www.xiaohongshu.com/explore/abc123?xsec_token=t', rect(100, 200, 240, 320))
      ]
    },
    window: { innerHeight: 900 }
  });
  assert.equal(result.ok, true);
  assert.equal(result.x, 220);
  assert.equal(result.y, 360);
  assert.match(result.href, /abc123/);
}

function testDetectsDetailState() {
  const result = runExpr(detailStateExpr({ id: 'abc123' }), {
    location: { href: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=t' },
    window: { __INITIAL_STATE__: { note: { currentNoteId: { value: 'abc123' }, noteDetailMap: { abc123: { note: {} } } } } }
  });
  assert.equal(result.open, true);
  assert.equal(result.ready, true);
  assert.equal(result.urlMatches, true);
}

function testDetectsSearchResultDetailState() {
  const result = runExpr(detailStateExpr({ id: 'abc123' }), {
    location: { href: 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=t' },
    window: { __INITIAL_STATE__: { note: {} } }
  });
  assert.equal(result.open, true);
  assert.equal(result.ready, true);
  assert.equal(result.urlMatches, true);
}

function testFindsNoteCardByTitleFallback() {
  const card = {
    innerText: '北京朝阳区望京一居室求租\\n小红薯\\n12',
    getBoundingClientRect: () => rect(40, 80, 300, 360)
  };
  const result = runExpr(findNoteCardExpr({ id: 'missing-id', title: '北京朝阳区望京一居室求租' }), {
    document: {
      querySelectorAll: () => [{
        href: 'https://www.xiaohongshu.com/explore/other-id',
        getAttribute: (name) => (name === 'href' ? 'https://www.xiaohongshu.com/explore/other-id' : ''),
        closest: () => card,
        getBoundingClientRect: () => rect(40, 80, 300, 360)
      }]
    },
    window: { innerHeight: 900 }
  });
  assert.equal(result.ok, true);
  assert.equal(result.x, 190);
  assert.equal(result.y, 260);
}

function testDetectsSearchListState() {
  const result = runExpr(listStateExpr(), {
    location: { href: 'https://www.xiaohongshu.com/search_result?keyword=%E6%9C%9D%E9%98%B3', pathname: '/search_result' },
    document: { querySelectorAll: () => [anchor('/explore/a', rect(0, 0, 1, 1)), anchor('/explore/b', rect(0, 0, 1, 1))] }
  });
  assert.equal(result.onSearch, true);
  assert.equal(result.cardCount, 2);
}

function testFindsCloseButton() {
  const close = {
    innerText: '',
    className: 'close-circle',
    title: '',
    getAttribute: (name) => (name === 'aria-label' ? '关闭' : ''),
    getBoundingClientRect: () => rect(32, 24, 36, 36)
  };
  const result = runExpr(findCloseButtonExpr(), {
    document: { querySelectorAll: () => [close] },
    window: { innerHeight: 900 }
  });
  assert.equal(result.ok, true);
  assert.equal(result.x, 50);
  assert.equal(result.y, 42);
}

testFindsNoteCardById();
testFindsNoteCardByTitleFallback();
testDetectsDetailState();
testDetectsSearchResultDetailState();
testDetectsSearchListState();
testFindsCloseButton();
console.log('note-navigation selftest passed');
