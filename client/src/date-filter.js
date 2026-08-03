'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function presetRange(preset, now = new Date()) {
  const today = startOfLocalDay(now);
  const tomorrow = addDays(today, 1);
  if (preset === 'today') return { start: today.toISOString(), end: tomorrow.toISOString() };
  if (preset === 'yesterday') {
    const yesterday = addDays(today, -1);
    return { start: yesterday.toISOString(), end: today.toISOString() };
  }
  if (preset === 'last3') return { start: addDays(today, -2).toISOString(), end: tomorrow.toISOString() };
  if (preset === 'last7') return { start: addDays(today, -6).toISOString(), end: tomorrow.toISOString() };
  return {};
}

function normalizeIso(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function parseRangeParams(params, prefix = '') {
  const start = normalizeIso(params.get(prefix + 'start'));
  const end = normalizeIso(params.get(prefix + 'end'));
  const range = {};
  if (start) range.start = start;
  if (end) range.end = end;
  return range;
}

function formatLocalSecond(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

module.exports = {
  formatLocalSecond,
  parseRangeParams,
  presetRange,
};
