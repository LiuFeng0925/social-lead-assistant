'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultSlot,
  scheduleToSlots,
  slotsToSchedule,
  validateSlots,
} = require('../src/schedule-slots');

test('default schedule is one every-day time slot', () => {
  assert.deepEqual(defaultSlot(), {
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '09:30',
    end: '23:00',
    notes: 40,
    quota: 8,
  });
});

test('seven-day schedule collapses into time slots by same time and quota', () => {
  const day = { on: true, windows: [{ start: '09:30', end: '23:00', notes: 40, quota: 8 }] };
  const schedule = [day, day, day, day, day, day, day];

  assert.deepEqual(scheduleToSlots(schedule), [defaultSlot()]);
});

test('time slots expand back to existing seven-day schedule format', () => {
  const schedule = slotsToSchedule([
    { days: [0, 1, 2, 3, 4], start: '09:30', end: '18:00', notes: 20, quota: 5 },
    { days: [5, 6], start: '11:00', end: '16:00', notes: 10, quota: 2 },
  ]);

  assert.equal(schedule.length, 7);
  assert.deepEqual(schedule[0].windows, [{ start: '09:30', end: '18:00', notes: 20, quota: 5 }]);
  assert.deepEqual(schedule[5].windows, [{ start: '11:00', end: '16:00', notes: 10, quota: 2 }]);
});

test('slot validation catches invalid ranges and same-day overlaps', () => {
  assert.deepEqual(validateSlots([{ days: [0], start: '12:00', end: '11:00', notes: 10, quota: 2 }]), [
    '时间段 1:开始要早于结束',
  ]);
  assert.deepEqual(validateSlots([{ days: [], start: '09:00', end: '11:00', notes: 10, quota: 2 }]), [
    '时间段 1:至少选择一天',
  ]);
  assert.deepEqual(validateSlots([
    { days: [0], start: '09:00', end: '12:00', notes: 10, quota: 2 },
    { days: [0, 1], start: '11:00', end: '13:00', notes: 10, quota: 2 },
  ]), ['周一:时间段 1 与 时间段 2 重叠']);
});
