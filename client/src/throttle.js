'use strict';

// 防封限频判断 —— 发每个动作前先问它"现在能发吗"。
// 规则全部读自数据库 config(可在「防封控制」页改),默认是保守值。

const db = require('./db');

const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
function dowIndex(d) { d = d || new Date(); return (d.getDay() + 6) % 7; } // 0=周一..6=周日

function winHit(wins, cur) {
  return wins.some(function (w) {
    var a = String(w.start || '00:00').split(':').map(Number);
    var b = String(w.end || '23:59').split(':').map(Number);
    return cur >= (a[0] * 60 + a[1]) && cur <= (b[0] * 60 + b[1]);
  });
}

// 工作时段判断:排班优先(按今天周几查 schedule,任一时段命中即在),否则回退单一 work_start/end
function inWorkWindow(cfg, d) {
  d = d || new Date();
  var cur = d.getHours() * 60 + d.getMinutes();
  if (cfg.schedule_enabled !== false && Array.isArray(cfg.schedule) && cfg.schedule.length === 7) {
    var day = cfg.schedule[dowIndex(d)];
    if (!day || day.on === false) return false;
    var wins = (day.windows && day.windows.length) ? day.windows : [{ start: cfg.work_start || '09:30', end: cfg.work_end || '23:00' }];
    return winHit(wins, cur);
  }
  return winHit([{ start: cfg.work_start || '09:30', end: cfg.work_end || '23:00' }], cur);
}

// 不在工作时段时,给一句人话原因
function workReason(cfg, d) {
  d = d || new Date();
  if (cfg.schedule_enabled !== false && Array.isArray(cfg.schedule) && cfg.schedule.length === 7) {
    var idx = dowIndex(d);
    var day = cfg.schedule[idx];
    if (!day || day.on === false) return '今天(' + WD[idx] + ')排班为休息日';
    var wins = (day.windows || []).map(function (w) { return w.start + '–' + w.end; }).join('、');
    return '不在今天(' + WD[idx] + ')排班时段(' + wins + ')';
  }
  return '不在工作时段(' + cfg.work_start + '–' + cfg.work_end + ')';
}

function toMin(hhmm) { const a = String(hhmm || '0:0').split(':').map(Number); return (a[0] || 0) * 60 + (a[1] || 0); }
function atTimeToday(hhmm) { const d = new Date(); const a = String(hhmm || '0:0').split(':').map(Number); d.setHours(a[0] || 0, a[1] || 0, 0, 0); return d.toISOString(); }
// 返回当前时刻命中的排班时段(含 quota);不在任何时段返回 null
function currentWindow(cfg, d) {
  d = d || new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  let wins;
  if (cfg.schedule_enabled !== false && Array.isArray(cfg.schedule) && cfg.schedule.length === 7) {
    const day = cfg.schedule[dowIndex(d)];
    if (!day || day.on === false) return null;
    wins = (day.windows && day.windows.length) ? day.windows : [{ start: cfg.work_start || '09:30', end: cfg.work_end || '23:00' }];
  } else {
    wins = [{ start: cfg.work_start || '09:30', end: cfg.work_end || '23:00' }];
  }
  for (const w of wins) { if (cur >= toMin(w.start) && cur <= toMin(w.end)) return w; }
  return null;
}

// 账号"年龄"(天),用于养号阶梯
function accountDays() {
  return Math.floor((Date.now() - new Date(db.firstUsedAt()).getTime()) / 86400000) + 1;
}

// 今日评论上限:养号开启则按账号天数取阶梯值,否则用固定值
function commentDailyLimit(cfg) {
  if (!cfg.nurture_enabled) return cfg.comment_daily;
  const days = accountDays();
  for (const s of (cfg.nurture_stages || [])) { if (days <= s.days) return s.comment; }
  return cfg.comment_daily;
}

// 评论能不能发:工作时间 + 今日上限 + 每小时 + 间隔
function canComment(opts) {
  opts = opts || {};
  const cfg = db.getConfig();
  const st = db.commentStats();
  if (!inWorkWindow(cfg)) return { ok: false, reason: workReason(cfg) };
  const dailyLimit = commentDailyLimit(cfg);
  if (st.today >= dailyLimit) return { ok: false, reason: `今日评论已达上限 ${dailyLimit} 条` };
  if (st.lastHour >= cfg.comment_hourly) return { ok: false, reason: `本小时已达上限 ${cfg.comment_hourly} 条` };
  if (cfg.slot_pacing !== 'burst' && !opts.ignoreGap && st.lastAt) {
    const gapMs = (cfg.comment_gap_min || 2) * 60000;
    const since = Date.now() - new Date(st.lastAt).getTime();
    if (since < gapMs) return { ok: false, reason: `离上次评论太近,还需等约 ${Math.ceil((gapMs - since) / 60000)} 分钟` };
  }
  // 时段配额 + 时段内节奏(配额为准,前面的养号阶梯/每日上限已做安全天花板)
  const w = currentWindow(cfg);
  if (w && w.quota != null && Number(w.quota) > 0) {
    const startIso = atTimeToday(w.start);
    const sentInWin = db.commentCountSince(startIso);
    if (sentInWin >= Number(w.quota)) return { ok: false, reason: '本时段(' + w.start + '–' + w.end + ')配额 ' + w.quota + ' 条已用完,等下个时段' };
    // 节奏改由「评论间隔 comment_gap」体现(见下方 gap 判断):匀速=每条隔 2~6 分钟;开头集中=连续发。配额只作本时段上限,不再均摊到整个时段。
  }
  return { ok: true, dailyLimit, today: st.today };
}

// 防封状态(给界面看)
function status() {
  const cfg = db.getConfig();
  const st = db.commentStats();
  return {
    config: cfg,
    accountDays: accountDays(),
    inWork: inWorkWindow(cfg),
    today: WD[dowIndex()],
    scheduleEnabled: cfg.schedule_enabled !== false,
    workReason: inWorkWindow(cfg) ? '' : workReason(cfg),
    slot: (function () { const w = currentWindow(cfg); if (!w) return null; return { start: w.start, end: w.end, quota: (w.quota != null ? w.quota : null), sent: db.commentCountSince(atTimeToday(w.start)) }; })(),
    commentToday: st.today,
    commentLastHour: st.lastHour,
    commentDailyLimit: commentDailyLimit(cfg)
  };
}

module.exports = { canComment, status, inWorkWindow, currentWindow, commentDailyLimit, accountDays };
