'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatLocalSecond,
  parseRangeParams,
  presetRange,
} = require('../src/date-filter');

test('date presets resolve to local calendar day boundaries', () => {
  const now = new Date(2026, 6, 1, 15, 4, 5);

  assert.deepEqual(presetRange('today', now), {
    start: new Date(2026, 6, 1, 0, 0, 0, 0).toISOString(),
    end: new Date(2026, 6, 2, 0, 0, 0, 0).toISOString(),
  });
  assert.deepEqual(presetRange('yesterday', now), {
    start: new Date(2026, 5, 30, 0, 0, 0, 0).toISOString(),
    end: new Date(2026, 6, 1, 0, 0, 0, 0).toISOString(),
  });
  assert.deepEqual(presetRange('last3', now), {
    start: new Date(2026, 5, 29, 0, 0, 0, 0).toISOString(),
    end: new Date(2026, 6, 2, 0, 0, 0, 0).toISOString(),
  });
});

test('custom range params keep exact second precision', () => {
  const params = new URLSearchParams();
  params.set('comments_start', '2026-07-01T08:09:10.000Z');
  params.set('comments_end', '2026-07-02T11:12:13.000Z');

  assert.deepEqual(parseRangeParams(params, 'comments_'), {
    start: '2026-07-01T08:09:10.000Z',
    end: '2026-07-02T11:12:13.000Z',
  });
});

test('record timestamps render to seconds instead of minutes', () => {
  const iso = new Date(2026, 6, 1, 14, 34, 56).toISOString();
  assert.equal(formatLocalSecond(iso), '2026-07-01 14:34:56');
});
