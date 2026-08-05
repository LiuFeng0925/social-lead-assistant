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

function keywordScanPlan(value, maxNotes, index = 0) {
  const keywords = parseKeywords(value);
  const safeIndex = Math.max(0, Math.min(keywords.length - 1, Number(index) || 0));
  const total = Math.max(1, Number(maxNotes) || 1);
  const base = Math.floor(total / keywords.length);
  const extra = total % keywords.length;
  return {
    keywords,
    index: safeIndex,
    keyword: keywords[safeIndex],
    quota: base + (safeIndex < extra ? 1 : 0),
    total
  };
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

module.exports = { parseKeywords, uniqueNotes, limitNotes, keywordScanPlan };
