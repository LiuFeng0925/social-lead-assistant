'use strict';

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function defaultSlot() {
  return { days: [0, 1, 2, 3, 4, 5, 6], start: '09:30', end: '23:00', notes: 40, quota: 8 };
}

function toMin(hhmm) {
  const a = String(hhmm || '0:0').split(':').map(Number);
  return (a[0] || 0) * 60 + (a[1] || 0);
}

function normalizeSlot(slot) {
  const days = Array.isArray(slot.days)
    ? [...new Set(slot.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b)
    : [0, 1, 2, 3, 4, 5, 6];
  return {
    days,
    start: slot.start || '09:30',
    end: slot.end || '23:00',
    notes: Number(slot.notes) || 40,
    quota: Number(slot.quota) || 8,
  };
}

function slotKey(w) {
  return [w.start || '09:30', w.end || '23:00', Number(w.notes) || 40, Number(w.quota) || 8].join('|');
}

function scheduleToSlots(schedule) {
  if (!Array.isArray(schedule) || schedule.length !== 7) return [defaultSlot()];
  const map = new Map();
  schedule.forEach((day, d) => {
    if (!day || day.on === false) return;
    const windows = Array.isArray(day.windows) && day.windows.length ? day.windows : [];
    windows.forEach((w) => {
      const key = slotKey(w);
      const cur = map.get(key) || normalizeSlot({
        days: [],
        start: w.start,
        end: w.end,
        notes: w.notes,
        quota: w.quota,
      });
      cur.days.push(d);
      cur.days = [...new Set(cur.days)].sort((a, b) => a - b);
      map.set(key, cur);
    });
  });
  const slots = [...map.values()].sort((a, b) => toMin(a.start) - toMin(b.start) || a.days[0] - b.days[0]);
  return slots.length ? slots : [defaultSlot()];
}

function slotsToSchedule(slots) {
  const schedule = DAY_NAMES.map(() => ({ on: false, windows: [] }));
  const clean = (Array.isArray(slots) && slots.length ? slots : [defaultSlot()]).map(normalizeSlot);
  clean.forEach((slot) => {
    slot.days.forEach((d) => {
      schedule[d].on = true;
      schedule[d].windows.push({ start: slot.start, end: slot.end, notes: slot.notes, quota: slot.quota });
    });
  });
  schedule.forEach((day) => day.windows.sort((a, b) => toMin(a.start) - toMin(b.start)));
  return schedule;
}

function validateSlots(slots) {
  const errs = [];
  const clean = Array.isArray(slots) ? slots.map(normalizeSlot) : [];
  clean.forEach((slot, i) => {
    if (toMin(slot.start) >= toMin(slot.end)) errs.push('时间段 ' + (i + 1) + ':开始要早于结束');
    if (!slot.days.length) errs.push('时间段 ' + (i + 1) + ':至少选择一天');
  });
  for (let d = 0; d < 7; d++) {
    const daySlots = clean
      .map((slot, i) => ({ slot, i }))
      .filter((x) => x.slot.days.includes(d))
      .sort((a, b) => toMin(a.slot.start) - toMin(b.slot.start));
    for (let i = 1; i < daySlots.length; i++) {
      const prev = daySlots[i - 1];
      const cur = daySlots[i];
      if (toMin(cur.slot.start) < toMin(prev.slot.end)) {
        errs.push(DAY_NAMES[d] + ':时间段 ' + (prev.i + 1) + ' 与 时间段 ' + (cur.i + 1) + ' 重叠');
      }
    }
  }
  return errs;
}

module.exports = {
  DAY_NAMES,
  defaultSlot,
  scheduleToSlots,
  slotsToSchedule,
  validateSlots,
};
