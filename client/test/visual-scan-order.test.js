'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sortVisualNotes } = require('../src/engine');

test('visible search cards are read left-to-right and then top-to-bottom', () => {
  const notes = [
    { id: 'second-row-left', visualTop: 430, visualLeft: 20 },
    { id: 'first-row-right', visualTop: 102, visualLeft: 560 },
    { id: 'first-row-left', visualTop: 100, visualLeft: 20 },
    { id: 'first-row-middle', visualTop: 108, visualLeft: 290 },
  ];
  assert.deepEqual(sortVisualNotes(notes).map((n) => n.id), [
    'first-row-left',
    'first-row-middle',
    'first-row-right',
    'second-row-left',
  ]);
});

test('a clearly higher masonry card is read before lower cards', () => {
  const notes = [
    { id: 'lower-left', visualTop: 280, visualLeft: 10 },
    { id: 'higher-right', visualTop: 180, visualLeft: 500 },
  ];
  assert.deepEqual(sortVisualNotes(notes).map((n) => n.id), ['higher-right', 'lower-left']);
});
