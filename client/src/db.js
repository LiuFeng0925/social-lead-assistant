'use strict';

// 数据落库 —— 本地 SQLite(node:sqlite,零依赖)。
// 三张表:notes(看过的笔记)/ comments(评论记录)/ leads(评论区问房者潜客)。
// 都带 tenant_id 预留多租户。

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const inboxUtils = require('./inbox-utils');
const leadModel = require('./lead-model');

const DATA_DIR = path.join(__dirname, '..', 'data');
let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'xhs.sqlite'));
  db.exec(`
    create table if not exists notes (
      id text primary key, tenant_id integer default 1,
      title text, author text, region text, intent text,
      likes text, collects text, comments text, tags text, url text,
      first_seen_at text, last_seen_at text
    );
    create table if not exists comments (
      id integer primary key autoincrement, tenant_id integer default 1,
      note_id text, note_title text, note_url text,
      content text, images text, status text, created_at text
    );
    create table if not exists leads (
      id integer primary key autoincrement, tenant_id integer default 1,
      note_id text, nickname text, question text, city text,
      status text default 'new', created_at text,
      unique(note_id, nickname)
    );
    create table if not exists inbox (
      id integer primary key autoincrement, tenant_id integer default 1,
      type text, nick text, user_link text, content text,
      note_title text, note_url text, action_date text, intent text,
      status text default 'new', reply_text text, fail_reason text,
      received_at text, replied_at text,
      dedup_key text unique,
      event_key text, actor_key text, content_norm text, source_key text,
      time_raw text, event_at_est text, time_confidence text,
      duplicate_of integer, skip_reason text, last_seen_at text,
      basis_text text, raw_text text
    );
    create table if not exists config (k text primary key, v text);
  `);
  ensureInboxSchema(db);
  backfillInboxIdentities(db);
  return db;
}

const now = () => new Date().toISOString();

function rangeWhere(fieldSql, range) {
  const clauses = [];
  const args = [];
  if (range && range.start) { clauses.push(`${fieldSql} >= ?`); args.push(range.start); }
  if (range && range.end) { clauses.push(`${fieldSql} < ?`); args.push(range.end); }
  return { clauses, args };
}

function countWhere(table, extraWhere, fieldSql, range) {
  const r = rangeWhere(fieldSql, range);
  const where = [extraWhere].filter(Boolean).concat(r.clauses).join(' and ');
  const sql = `select count(*) c from ${table}` + (where ? ` where ${where}` : '');
  const row = open().prepare(sql).get(...r.args);
  return row ? row.c : 0;
}

// 采集到的笔记:存/更新(同 id 覆盖热度等,保留首次采集时间)
function upsertNote(n) {
  open().prepare(`
    insert into notes (id, title, author, region, intent, likes, collects, comments, tags, url, first_seen_at, last_seen_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(id) do update set
      title=excluded.title, author=excluded.author, region=excluded.region,
      intent=excluded.intent, likes=excluded.likes, collects=excluded.collects,
      comments=excluded.comments, tags=excluded.tags, url=excluded.url,
      last_seen_at=excluded.last_seen_at
  `).run(n.id, n.title || '', n.author || '', n.region || '', n.intent || '',
    String(n.likes || ''), String(n.collects || ''), String(n.comments || ''),
    JSON.stringify(n.tags || []), n.url || '', now(), now());
}

// 去重核心:这条笔记是否已经成功评论过
function hasCommented(noteId) {
  const r = open().prepare(`select count(*) c from comments where note_id=? and status='sent'`).get(noteId);
  return !!(r && r.c > 0);
}

function insertComment(c) {
  open().prepare(`
    insert into comments (note_id, note_title, note_url, content, images, status, created_at)
    values (?,?,?,?,?,?,?)
  `).run(c.noteId || '', c.noteTitle || '', c.noteUrl || '', c.content || '', c.images || '', c.status || 'sent', now());
}

function insertLead(l) {
  try {
    open().prepare(`
      insert into leads (note_id, nickname, question, city, created_at) values (?,?,?,?,?)
      on conflict(note_id, nickname) do nothing
    `).run(l.noteId || '', l.nickname || '', l.question || '', l.city || '', now());
  } catch (e) { /* 忽略重复 */ }
}

function listComments(limit = 100, range = {}) {
  const r = rangeWhere('created_at', range);
  const where = r.clauses.length ? `where ${r.clauses.join(' and ')}` : '';
  return open().prepare(`select * from comments ${where} order by id desc limit ?`).all(...r.args, limit);
}
function listNotes(limit = 200, range = {}) {
  const r = rangeWhere('last_seen_at', range);
  const where = r.clauses.length ? `where ${r.clauses.join(' and ')}` : '';
  return open().prepare(`select * from notes ${where} order by last_seen_at desc limit ?`).all(...r.args, limit);
}
function listLeads(limit = 100) { return open().prepare(`select * from leads order by id desc limit ?`).all(limit); }

// ── 承接收件箱 ──
function ensureInboxSchema(d) {
  const cols = new Set(d.prepare('pragma table_info(inbox)').all().map((r) => r.name));
  const add = (name, sql) => { if (!cols.has(name)) d.exec(`alter table inbox add column ${name} ${sql}`); };
  add('event_key', 'text');
  add('actor_key', 'text');
  add('content_norm', 'text');
  add('source_key', 'text');
  add('time_raw', 'text');
  add('event_at_est', 'text');
  add('time_confidence', 'text');
  add('duplicate_of', 'integer');
  add('skip_reason', 'text');
  add('last_seen_at', 'text');
  add('basis_text', 'text');
  add('raw_text', 'text');
  d.exec(`
    create index if not exists idx_inbox_event_key on inbox(event_key);
    create index if not exists idx_inbox_identity on inbox(actor_key, content_norm);
    create index if not exists idx_inbox_duplicate_of on inbox(duplicate_of);
  `);
}

function _statusRank(status) {
  if (status === 'replied') return 4;
  if (status === 'failed') return 3;
  if (status === 'skipped') return 2;
  return 1;
}

function backfillInboxIdentities(d) {
  const rows = d.prepare('select * from inbox order by id').all();
  if (!rows.length) return;
  const groups = new Map();
  for (const row of rows) {
    const p = inboxUtils.prepareInboxItem(row);
    const cur = groups.get(p.event_key) || [];
    cur.push({ row, prepared: p });
    groups.set(p.event_key, cur);
  }
  const update = d.prepare(`update inbox set
    event_key=?, actor_key=?, content_norm=?, source_key=?, time_raw=?,
    event_at_est=?, time_confidence=?, duplicate_of=?, skip_reason=?,
    last_seen_at=coalesce(last_seen_at, received_at),
    basis_text=coalesce(nullif(basis_text,''), ?),
    raw_text=coalesce(nullif(raw_text,''), ?)
    where id=?`);
  const updateStatus = d.prepare(`update inbox set status=?, skip_reason=coalesce(skip_reason, ?) where id=?`);
  for (const group of groups.values()) {
    let primary = group[0];
    for (const item of group) {
      const a = _statusRank(item.row.status);
      const b = _statusRank(primary.row.status);
      if (a > b || (a === b && item.row.id > primary.row.id)) primary = item;
    }
    for (const item of group) {
      const isPrimary = item.row.id === primary.row.id;
      const p = item.prepared;
      const duplicateOf = isPrimary ? null : primary.row.id;
      const skipReason = item.row.skip_reason || (p.skip_reason && item.row.status !== 'replied' ? p.skip_reason : null) || null;
      update.run(p.event_key, p.actor_key, p.content_norm, p.source_key, p.time_raw, p.event_at_est, p.time_confidence, duplicateOf, skipReason, p.basis_text, p.raw_text, item.row.id);
      if (p.skip_reason && item.row.status === 'new') updateStatus.run('skipped', p.skip_reason, item.row.id);
    }
  }
}

function backfillInboxIfNeeded() {
  const d = open();
  const r = d.prepare(`select count(*) c from inbox where event_key is null or event_key=''`).get();
  if (r && r.c > 0) backfillInboxIdentities(d);
  d.prepare(`update inbox
    set event_at_est=coalesce(received_at,replied_at), time_confidence='estimated'
    where duplicate_of is null and status='replied'
      and replied_at is not null and event_at_est is not null and event_at_est > replied_at`).run();
}

// 插入一条收到的评论;dedup_key 已存在则忽略(不重复入库)。返回 true=新增。
function insertInbox(it) {
  const d = open();
  const p = inboxUtils.prepareInboxItem(it);
  const old = d.prepare(`select id, action_date, time_raw, event_at_est, time_confidence from inbox where event_key=? and duplicate_of is null order by id desc limit 1`).get(p.event_key);
  if (old) {
    const merged = inboxUtils.mergeEventTime(old, p);
    const useIncomingTime = merged.event_at_est === p.event_at_est && merged.time_confidence === p.time_confidence;
    d.prepare(`update inbox set last_seen_at=?, time_raw=?, action_date=?, event_at_est=?, time_confidence=? where id=?`)
      .run(now(), useIncomingTime ? p.time_raw : old.time_raw, useIncomingTime ? p.action_date : old.action_date, merged.event_at_est, merged.time_confidence, old.id);
    return false;
  }
  const status = (it.status && it.status !== 'new') ? it.status : (p.skip_reason ? 'skipped' : (it.status || 'new'));
  const r = d.prepare(`insert or ignore into inbox
    (type, nick, user_link, content, note_title, note_url, action_date, intent, status, received_at, last_seen_at, dedup_key,
     event_key, actor_key, content_norm, source_key, time_raw, event_at_est, time_confidence, skip_reason, basis_text, raw_text)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    p.type || '', p.nick || '', p.user_link || '', p.content || '',
    it.note_title || '', p.note_url || it.note_url || '', p.action_date || '', it.intent || '',
    status, now(), now(), p.dedup_key,
    p.event_key, p.actor_key, p.content_norm, p.source_key, p.time_raw, p.event_at_est, p.time_confidence, p.skip_reason || it.skip_reason || '', p.basis_text || '', p.raw_text || '');
  return r.changes > 0;
}
function listInbox(limit = 100, range = {}) {
  backfillInboxIfNeeded();
  const r = rangeWhere('coalesce(i.event_at_est,i.received_at)', range);
  const where = ['i.duplicate_of is null'].concat(r.clauses).join(' and ');
  return open().prepare(`select i.*,
    (select count(*) from inbox d where d.duplicate_of=i.id) duplicate_count
    from inbox i where ${where} order by i.id desc limit ?`).all(...r.args, limit);
}
function findInboxByEventKey(key) {
  backfillInboxIfNeeded();
  return open().prepare(`select * from inbox where event_key=? and duplicate_of is null order by id desc limit 1`).get(key);
}
function updateInboxByKey(key, fields) {
  const f = fields || {};
  open().prepare(`update inbox set
    status=coalesce(?,status), reply_text=coalesce(?,reply_text),
    fail_reason=coalesce(?,fail_reason), intent=coalesce(?,intent),
    replied_at=coalesce(?,replied_at), skip_reason=coalesce(?,skip_reason),
    last_seen_at=?
    where dedup_key=? or event_key=?`)
    .run(f.status != null ? f.status : null, f.reply_text != null ? f.reply_text : null,
      f.fail_reason != null ? f.fail_reason : null, f.intent != null ? f.intent : null,
      f.replied_at != null ? f.replied_at : null, f.skip_reason != null ? f.skip_reason : null,
      now(), key, key);
}
function repliedToday() {
  backfillInboxIfNeeded();
  const day = now().slice(0, 10);
  const r = open().prepare(`select count(*) c from inbox where duplicate_of is null and status='replied' and substr(coalesce(replied_at,received_at),1,10)=?`).get(day);
  return r.c || 0;
}
function hasRecentInboxReply(it, days = 7) {
  backfillInboxIfNeeded();
  const p = inboxUtils.prepareInboxItem(it);
  if (!p.actor_key || !p.content_norm) return false;
  const since = new Date(Date.now() - (Number(days) || 7) * 86400000).toISOString();
  const r = open().prepare(`select count(*) c from inbox
    where duplicate_of is null and status='replied'
      and actor_key=? and content_norm=?
      and coalesce(replied_at, received_at, '') >= ?`).get(p.actor_key, p.content_norm, since);
  return !!(r && r.c > 0);
}
function inboxStats(range = {}) {
  backfillInboxIfNeeded();
  const r = rangeWhere('coalesce(event_at_est,received_at)', range);
  const where = ['duplicate_of is null'].concat(r.clauses).join(' and ');
  const row = open().prepare(`select
    count(*) total,
    sum(case when status='new' then 1 else 0 end) pending,
    sum(case when status='replied' then 1 else 0 end) replied,
    sum(case when status='skipped' then 1 else 0 end) skipped,
    sum(case when status='failed' then 1 else 0 end) failed
    from inbox where ${where}`).get(...r.args);
  return { total: row.total || 0, pending: row.pending || 0, replied: row.replied || 0, skipped: row.skipped || 0, failed: row.failed || 0 };
}

function stats(ranges = {}) {
  const c = { c: countWhere('comments', "status='sent'", 'created_at', ranges.comments || {}) };
  const n = { c: countWhere('notes', '', 'last_seen_at', ranges.notes || {}) };
  const l = open().prepare(`select count(*) c from leads`).get();
  return { commented: c.c, notes: n.c, leads: l.c };
}

// ── 防封配置(默认保守值,全部可在「防封控制」页改)──
const DEFAULT_CONFIG = {
  comment_daily: 8,          // 评论每日上限(养号期)
  comment_hourly: 5,         // 评论每小时上限
  comment_gap_min: 2,        // 两条评论最小间隔(分钟)
  comment_gap_max: 6,        // 最大间隔(分钟,实际随机停顿用)
  collect_daily: 120,        // 采集每日上限
  quota_jitter: 0.2,         // 每日上限 ±随机浮动比例
  work_start: '09:30',       // 工作时间窗
  work_end: '23:00',
  nurture_enabled: true,     // 养号阶梯开关
  nurture_stages: [{ days: 3, comment: 3 }, { days: 7, comment: 8 }, { days: 14, comment: 15 }, { days: 9999, comment: 30 }],
  // ── 任务设置(在「任务设置」页改)──
  task_keyword: '朝阳 租房',
  task_direction: '结合对方诉求友好回应,引导看主页/私聊,绝不留联系方式',
  outreach_fixed_text: '',           // 外呼固定短句；留空才使用 AI/模板生成
  lead_local_words: [],              // 可服务区域；命中明确外地城市时整篇跳过
  task_max: 40,
  task_sort: '综合', task_note_time: '不限', task_note_type: '不限', task_note_range: '不限',
  // ── 评论生成 LLM(可切换 provider:ark 火山方舟 / dashscope 阿里百炼)。默认关=用内置话术模板;填 key 并启用后,评论改由大模型按对方正文+方向生成 ──
  llm_enabled: false, llm_provider: 'ark', llm_model: '', llm_api_key: '',
  // ── 获客模型:笔记分类、提槽和分类后的处理动作。租房只是默认模板,可在「获客模型」页改成其他行业 ──
  lead_model: leadModel.defaultLeadModel(),
  // ── 评论承接(在「评论承接」页改)── 别人评论/回复我 → 自动接住回复
  reply_enabled: true,                 // 任务里是否承接(开始任务时一并跑)
  reply_scope_comment: true, reply_scope_reply: true, reply_scope_mention: true, // 接哪些动作
  reply_intent_words: ['求租', '租房', '多少钱', '价格', '有房', '还在', '怎么联系', '看看', '地址', '地铁', '合租', '整租', '押一', '预算', '想租'],
  reply_hot_words: ['加微', '微信', '联系方式', '怎么加', 'vx', 'v信', '电话', '加你', '私聊'],
  reply_black_words: ['中介勿扰', '广告', '刷单', '代理', '加盟', '同行'],
  reply_only_intent: false,            // true=只回命中意向词的；false=都回
  reply_recent_days: 7,                // 只回近 N 天的评论(抓取时滚到更老就停，不用全读)
  // 承接单独排班(7天，index 0=周一..6=周日；每天 {on, windows:[{start,end}]}）
  reply_schedule_enabled: true,
  reply_schedule: [
    { on: true, windows: [{ start: '09:00', end: '23:30' }] }, { on: true, windows: [{ start: '09:00', end: '23:30' }] },
    { on: true, windows: [{ start: '09:00', end: '23:30' }] }, { on: true, windows: [{ start: '09:00', end: '23:30' }] },
    { on: true, windows: [{ start: '09:00', end: '23:30' }] }, { on: true, windows: [{ start: '09:00', end: '23:30' }] },
    { on: true, windows: [{ start: '09:00', end: '23:30' }] }
  ],
  // 常驻机器
  live_send: false,                    // 总真发开关：false=全演练；true=主任务+承接都真发(开启时二次确认)
  rescan_minutes: 15,                  // 外呼把当前一批逛完后，隔多久重新检索一批新笔记
  reply_direction: '友好回应对方诉求，引导看主页/私聊详聊，绝不留联系方式',
  reply_daily: 30, reply_hourly: 10, reply_gap_min: 1, reply_gap_max: 4, // 回复限频(分钟)
  reply_batch_max: 5,                  // 一轮最多回几条(防外呼饿死)
  reply_check_minutes: 5,              // 兜底每 N 分钟看一次通知红点
  reply_dry_run: true,                 // 默认演练(只定位+生成，不真发)
  // ── 打开笔记后的拟人浏览(在「任务设置」可配)──
  browse_images_min: 2, browse_images_max: 5,            // 图文看几张图
  browse_body_dwell_min: 1500, browse_body_dwell_max: 5000, // 正文停留(ms)
  browse_comment_scrolls_min: 2, browse_comment_scrolls_max: 5, // 往下滑读评论几下
  browse_comment_dwell_min: 1000, browse_comment_dwell_max: 3000, // 每下停留读评论(ms)
  // ── 排班(在「排班管理」页改)── 7 天,index 0=周一..6=周日;每天 {on, windows:[{start,end,notes 采集量,quota 评论量}]}
  slot_pacing: 'even', // 时段内节奏:even 匀速摊开 | burst 开头集中发完就歇
  auto_send_dry_run: true, // 自动评论默认只演练(走完整流程但不真发);改 false 才真发
  schedule_enabled: true,
  schedule: [
    { on: true, windows: [{ start: '09:30', end: '23:00', notes: 40, quota: 8 }] },
    { on: true, windows: [{ start: '09:30', end: '23:00', notes: 40, quota: 8 }] },
    { on: true, windows: [{ start: '09:30', end: '23:00', notes: 40, quota: 8 }] },
    { on: true, windows: [{ start: '09:30', end: '23:00', notes: 40, quota: 8 }] },
    { on: true, windows: [{ start: '09:30', end: '23:00', notes: 40, quota: 8 }] },
    { on: true, windows: [{ start: '09:30', end: '23:00', notes: 40, quota: 8 }] },
    { on: true, windows: [{ start: '09:30', end: '23:00', notes: 40, quota: 8 }] }
  ],
  fail_rate_threshold: 0.3   // 健康:评论失败率阈值
};

function getConfig() {
  const rows = open().prepare('select k,v from config').all();
  const saved = {};
  rows.forEach((r) => { try { saved[r.k] = JSON.parse(r.v); } catch (e) { saved[r.k] = r.v; } });
  const cfg = { ...DEFAULT_CONFIG, ...saved };
  // 兼容旧排班:每个时段补上 notes(采集量)/quota(评论量),旧库用 task_max 当采集种子
  if (Array.isArray(cfg.schedule)) {
    cfg.schedule.forEach((day) => {
      if (day && Array.isArray(day.windows)) day.windows.forEach((w) => {
        if (w && w.notes == null) w.notes = Number(cfg.task_max) || 40;
        if (w && w.quota == null) w.quota = 8;
      });
    });
  }
  cfg.lead_model = leadModel.normalizeLeadModel(cfg.lead_model);
  return cfg;
}
function setConfig(partial) {
  const st = open().prepare('insert into config(k,v) values(?,?) on conflict(k) do update set v=excluded.v');
  for (const k of Object.keys(partial || {})) st.run(k, JSON.stringify(partial[k]));
}
function firstUsedAt() {
  const r = open().prepare("select v from config where k='first_used_at'").get();
  if (r) { try { return JSON.parse(r.v); } catch (e) { return r.v; } }
  const t = now(); open().prepare("insert into config(k,v) values('first_used_at',?)").run(JSON.stringify(t)); return t;
}
function commentCountSince(iso) {
  const r = open().prepare("select count(*) c from comments where status='sent' and created_at >= ?").get(iso);
  return r ? r.c : 0;
}
function commentStats() {
  const ds = new Date(); ds.setHours(0, 0, 0, 0);
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const today = open().prepare("select count(*) c from comments where status='sent' and created_at >= ?").get(ds.toISOString());
  const hour = open().prepare("select count(*) c from comments where status='sent' and created_at >= ?").get(hourAgo);
  const last = open().prepare("select max(created_at) m from comments where status='sent'").get();
  return { today: today.c, lastHour: hour.c, lastAt: last.m || null };
}

module.exports = { open, upsertNote, hasCommented, insertComment, insertLead, listComments, listNotes, listLeads, stats, getConfig, setConfig, firstUsedAt, commentStats, commentCountSince, insertInbox, listInbox, inboxStats, updateInboxByKey, repliedToday, findInboxByEventKey, hasRecentInboxReply };
