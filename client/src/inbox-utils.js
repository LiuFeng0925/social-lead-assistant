'use strict';

const crypto = require('node:crypto');

const INVALID_CONTENT = new Set(['你的关注', '你的粉丝', '作者', '回复']);

function _asDate(now) {
  return now instanceof Date ? new Date(now.getTime()) : new Date(now || Date.now());
}

function _startOfLocalDay(d) {
  const x = _asDate(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function _daysBetweenLocalDates(now, date) {
  return Math.max(0, Math.floor((_startOfLocalDay(now) - _startOfLocalDay(date)) / 86400000));
}

function parseNotificationTime(raw, now = new Date()) {
  const text = String(raw || '').replace(/\s+/g, '').trim();
  const base = _asDate(now);
  if (!text) return { raw: text, daysAgo: null, eventAtEst: null, confidence: 'unknown' };

  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text);
    const d = new Date(text.length === 10 ? n * 1000 : n);
    if (!Number.isNaN(d.getTime())) return { raw: text, daysAgo: _daysBetweenLocalDates(base, d), eventAtEst: d.toISOString(), confidence: 'exact' };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) return { raw: text, daysAgo: _daysBetweenLocalDates(base, d), eventAtEst: d.toISOString(), confidence: 'exact' };
  }
  let exact = text.match(/^(\d{4})-(\d{2})-(\d{2})(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (exact) {
    const d = new Date(Number(exact[1]), Number(exact[2]) - 1, Number(exact[3]), Number(exact[4]), Number(exact[5]), Number(exact[6] || 0));
    if (!Number.isNaN(d.getTime())) return { raw: text, daysAgo: _daysBetweenLocalDates(base, d), eventAtEst: d.toISOString(), confidence: 'exact' };
  }

  if (text === '刚刚' || /秒前$/.test(text)) {
    return { raw: text, daysAgo: 0, eventAtEst: base.toISOString(), confidence: 'relative' };
  }
  let m = text.match(/^(\d+)分钟前$/);
  if (m) {
    const d = new Date(base.getTime() - Number(m[1]) * 60000);
    return { raw: text, daysAgo: 0, eventAtEst: d.toISOString(), confidence: 'relative' };
  }
  m = text.match(/^(\d+)小时前$/);
  if (m) {
    const d = new Date(base.getTime() - Number(m[1]) * 3600000);
    return { raw: text, daysAgo: _daysBetweenLocalDates(base, d), eventAtEst: d.toISOString(), confidence: 'relative' };
  }
  if (text === '今天') {
    const d = _startOfLocalDay(base);
    return { raw: text, daysAgo: 0, eventAtEst: d.toISOString(), confidence: 'date_only' };
  }
  if (text === '昨天') {
    const d = _startOfLocalDay(base);
    d.setDate(d.getDate() - 1);
    return { raw: text, daysAgo: 1, eventAtEst: d.toISOString(), confidence: 'date_only' };
  }
  m = text.match(/^(\d+)天前$/);
  if (m) {
    const daysAgo = Number(m[1]);
    const d = _startOfLocalDay(base);
    d.setDate(d.getDate() - daysAgo);
    return { raw: text, daysAgo, eventAtEst: d.toISOString(), confidence: 'date_only' };
  }
  m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return { raw: text, daysAgo: _daysBetweenLocalDates(base, d), eventAtEst: d.toISOString(), confidence: 'date_only' };
  }
  m = text.match(/^(\d{2})-(\d{2})$/);
  if (m) {
    let d = new Date(base.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d > _startOfLocalDay(base)) d = new Date(base.getFullYear() - 1, Number(m[1]) - 1, Number(m[2]));
    return { raw: text, daysAgo: _daysBetweenLocalDates(base, d), eventAtEst: d.toISOString(), confidence: 'date_only' };
  }
  return { raw: text, daysAgo: null, eventAtEst: null, confidence: 'unknown' };
}

function isWithinRecentDays(raw, recentDays, now = new Date()) {
  const n = Number(recentDays) || 0;
  if (n <= 0) return true;
  const parsed = parseNotificationTime(raw, now);
  return Number.isFinite(parsed.daysAgo) && parsed.daysAgo <= n;
}

function shouldStopForRecentWindow(raw, recentDays, now = new Date()) {
  const n = Number(recentDays) || 0;
  if (n <= 0) return false;
  const parsed = parseNotificationTime(raw, now);
  return Number.isFinite(parsed.daysAgo) && parsed.daysAgo > n;
}

function normalizeIncomingText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function invalidIncomingReason(text) {
  const norm = normalizeIncomingText(text);
  if (!norm || INVALID_CONTENT.has(norm)) return '未识别到评论正文';
  if (norm === '原评论已删除') return '原评论已删/无内容';
  return '';
}

function normalizeUserLink(link) {
  const s = String(link || '').trim();
  if (!s) return '';
  return s.split('?')[0].replace(/^https?:\/\/www\.xiaohongshu\.com/, '');
}

function hashKey(parts) {
  return 'inbox_' + crypto.createHash('sha1').update(parts.map((p) => String(p || '')).join('|')).digest('hex').slice(0, 24);
}

function resolvePostInboxReturnUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\/www\.xiaohongshu\.com\//.test(s)) return '';
  if (/\/notification(?:[/?#]|$)/.test(s)) return '';
  return s;
}

function mergeEventTime(existing, next) {
  const cur = existing || {};
  const inc = next || {};
  const curTime = cur.event_at_est || cur.eventAtEst || '';
  const incTime = inc.event_at_est || inc.eventAtEst || '';
  const curConfidence = cur.time_confidence || cur.confidence || '';
  const incConfidence = inc.time_confidence || inc.confidence || '';
  const useIncoming = !!incTime && (!curTime || (curConfidence !== 'exact' && incConfidence === 'exact'));
  const picked = useIncoming ? inc : cur;
  return {
    event_at_est: picked.event_at_est || picked.eventAtEst || '',
    time_confidence: picked.time_confidence || picked.confidence || ''
  };
}

function prepareInboxItem(item, now = new Date()) {
  const it = item || {};
  const userLink = normalizeUserLink(it.user_link || it.link || '');
  const actorKey = userLink || normalizeIncomingText(it.nick);
  const contentNorm = normalizeIncomingText(it.content);
  const basisText = normalizeIncomingText(it.basis_text || it.basis || it.context_text || '');
  const rawText = String(it.raw_text || it.raw || '').trim();
  const sourceKey = String(it.source_key || it.note_url || it.note_link || '').split('?')[0].trim();
  const timeRaw = String(it.action_date || it.date || it.time_raw || '').trim();
  const parsed = parseNotificationTime(timeRaw, now);
  const skipReason = invalidIncomingReason(contentNorm);
  const eventKey = hashKey([it.type || '', actorKey, contentNorm, sourceKey]);
  return {
    ...it,
    type: it.type || '',
    nick: it.nick || '',
    user_link: userLink,
    content: contentNorm,
    incoming_text: contentNorm,
    basis_text: basisText,
    raw_text: rawText,
    action_date: timeRaw,
    time_raw: timeRaw,
    event_at_est: parsed.eventAtEst,
    time_confidence: parsed.confidence,
    actor_key: actorKey,
    content_norm: contentNorm,
    source_key: sourceKey,
    event_key: eventKey,
    dedup_key: eventKey,
    can_auto_reply: !skipReason,
    skip_reason: skipReason
  };
}

module.exports = {
  parseNotificationTime,
  isWithinRecentDays,
  shouldStopForRecentWindow,
  normalizeIncomingText,
  invalidIncomingReason,
  normalizeUserLink,
  prepareInboxItem,
  hashKey,
  resolvePostInboxReturnUrl,
  mergeEventTime
};
