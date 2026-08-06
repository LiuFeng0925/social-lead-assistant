'use strict';

function parseKeywords(value, fallback = '朝阳 租房', maxKeywords = 20) {
  const entries = String(value || '')
    .split(/[，,；;\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(entries)].slice(0, Math.max(1, Number(maxKeywords) || 20));
  return unique.length ? unique : [fallback];
}

function limitNotes(notes, maxNotes) {
  const max = Math.max(0, Number(maxNotes) || 0);
  return uniqueNotes(notes).slice(0, max);
}

function keywordScanPlan(value, notesPerKeyword, index = 0) {
  const keywords = parseKeywords(value);
  const safeIndex = Math.max(0, Math.min(keywords.length - 1, Number(index) || 0));
  const quota = Math.max(1, Math.floor(Number(notesPerKeyword) || 1));
  return {
    keywords,
    index: safeIndex,
    keyword: keywords[safeIndex],
    quota,
    notesPerKeyword: quota,
    total: quota * keywords.length
  };
}

function migrateLegacyTotalSchedule(schedule, keywordCount) {
  const count = Math.max(1, Math.floor(Number(keywordCount) || 1));
  if (!Array.isArray(schedule)) return schedule;
  return schedule.map((day) => Object.assign({}, day, {
    windows: Array.isArray(day && day.windows) ? day.windows.map((window) => {
      const next = Object.assign({}, window);
      if (next.notes != null && Number(next.notes) > 0) next.notes = Math.max(1, Math.ceil(Number(next.notes) / count));
      return next;
    }) : []
  }));
}

function uniqueNotes(notes) {
  const seen = new Set();
  return (notes || []).filter((note) => {
    const key = note && (note.id || note.url || `${note.title || ''}\u0000${note.author || ''}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { parseKeywords, uniqueNotes, limitNotes, keywordScanPlan, migrateLegacyTotalSchedule };
