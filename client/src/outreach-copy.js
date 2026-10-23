'use strict';

const MAX_OUTREACH_TEXTS = 10;

function normalizeOutreachTexts(value, legacy = '') {
  const source = Array.isArray(value) ? value : [];
  const rows = source
    .map((item) => String(item == null ? '' : item).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!rows.length && String(legacy || '').trim()) rows.push(String(legacy).replace(/\s+/g, ' ').trim());
  return [...new Set(rows)].slice(0, MAX_OUTREACH_TEXTS);
}

function shuffle(values, random = Math.random) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function createOutreachPicker({ random = Math.random } = {}) {
  let signature = '';
  let bag = [];
  let previous = '';
  return {
    pick(config = {}) {
      const pool = normalizeOutreachTexts(config.outreach_fixed_texts, config.outreach_fixed_text);
      if (!pool.length) return '';
      const nextSignature = JSON.stringify(pool);
      if (nextSignature !== signature) {
        signature = nextSignature;
        bag = [];
        previous = '';
      }
      if (!bag.length) {
        bag = shuffle(pool, random);
        if (bag.length > 1 && bag[bag.length - 1] === previous) {
          const first = bag[0];
          bag[0] = bag[bag.length - 1];
          bag[bag.length - 1] = first;
        }
      }
      const selected = bag.pop();
      previous = selected;
      return selected;
    },
    reset() { signature = ''; bag = []; previous = ''; }
  };
}

module.exports = { MAX_OUTREACH_TEXTS, normalizeOutreachTexts, createOutreachPicker };
