'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currentScanLimit } = require('../src/throttle');

test('schedule per-keyword note quota is not capped by the legacy hidden task scan limit', () => {
  const schedule = Array.from({ length: 7 }, () => ({
    on: true,
    windows: [{ start: '00:00', end: '23:59', notes: 100, quota: 100 }]
  }));
  assert.equal(currentScanLimit({ task_max: 4, schedule_enabled: true, schedule }), 100);
});

test('legacy task max is only used when the active window has no note amount', () => {
  assert.equal(currentScanLimit({ task_max: 60, collect_daily: 120, schedule_enabled: false, work_start: '00:00', work_end: '23:59' }), 60);
});
