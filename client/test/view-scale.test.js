'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { xhsZoomFactor } = require('../src/view-scale');

test('small desktop browser panes zoom out enough to fit the comment composer', () => {
  assert.equal(xhsZoomFactor(752, 895), 0.9);
  assert.equal(xhsZoomFactor(840, 980), 1);
});

test('large displays remain at 100 percent and tiny panes keep a readable floor', () => {
  assert.equal(xhsZoomFactor(1280, 1200), 1);
  assert.equal(xhsZoomFactor(500, 600), 0.8);
});
