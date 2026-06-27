'use strict';

// 防封限频判断 —— 发每个动作前先问它"现在能发吗"。
// 规则全部读自数据库 config(可在「防封控制」页改),默认是保守值。

const db = require('./db');

function inWorkWindow(cfg, d = new Date()) {
  const [sh, sm] = String(cfg.work_start || '09:30').split(':').map(Number);
  const [eh, em] = String(cfg.work_end || '23:00').split(':').map(Number);
  const cur = d.getHours() * 60 + d.getMinutes();
  return cur >= (sh * 60 + sm) && cur <= (eh * 60 + em);
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
function canComment() {
  const cfg = db.getConfig();
  const st = db.commentStats();
  if (!inWorkWindow(cfg)) return { ok: false, reason: `不在工作时段(${cfg.work_start}–${cfg.work_end})` };
  const dailyLimit = commentDailyLimit(cfg);
  if (st.today >= dailyLimit) return { ok: false, reason: `今日评论已达上限 ${dailyLimit} 条` };
  if (st.lastHour >= cfg.comment_hourly) return { ok: false, reason: `本小时已达上限 ${cfg.comment_hourly} 条` };
  if (st.lastAt) {
    const gapMs = (cfg.comment_gap_min || 2) * 60000;
    const since = Date.now() - new Date(st.lastAt).getTime();
    if (since < gapMs) return { ok: false, reason: `离上次评论太近,还需等约 ${Math.ceil((gapMs - since) / 60000)} 分钟` };
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
    commentToday: st.today,
    commentLastHour: st.lastHour,
    commentDailyLimit: commentDailyLimit(cfg)
  };
}

module.exports = { canComment, status, inWorkWindow, commentDailyLimit, accountDays };
