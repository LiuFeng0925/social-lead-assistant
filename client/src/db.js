'use strict';

// 数据落库 —— 本地 SQLite(node:sqlite,零依赖)。
// 三张表:notes(看过的笔记)/ comments(评论记录)/ leads(评论区问房者潜客)。
// 都带 tenant_id 预留多租户。

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

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
    create table if not exists config (k text primary key, v text);
  `);
  return db;
}

const now = () => new Date().toISOString();

// 采集到的笔记:存/更新(同 id 覆盖热度等,保留首次采集时间)
function upsertNote(n) {
  open().prepare(`
    insert into notes (id, title, author, region, intent, likes, collects, comments, tags, url, first_seen_at, last_seen_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(id) do update set
      title=excluded.title, likes=excluded.likes, collects=excluded.collects,
      comments=excluded.comments, last_seen_at=excluded.last_seen_at
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

function listComments(limit = 100) { return open().prepare(`select * from comments order by id desc limit ?`).all(limit); }
function listNotes(limit = 200) { return open().prepare(`select * from notes order by last_seen_at desc limit ?`).all(limit); }
function listLeads(limit = 100) { return open().prepare(`select * from leads order by id desc limit ?`).all(limit); }

function stats() {
  const c = open().prepare(`select count(*) c from comments where status='sent'`).get();
  const n = open().prepare(`select count(*) c from notes`).get();
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
  fail_rate_threshold: 0.3   // 健康:评论失败率阈值
};

function getConfig() {
  const rows = open().prepare('select k,v from config').all();
  const saved = {};
  rows.forEach((r) => { try { saved[r.k] = JSON.parse(r.v); } catch (e) { saved[r.k] = r.v; } });
  return { ...DEFAULT_CONFIG, ...saved };
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
function commentStats() {
  const ds = new Date(); ds.setHours(0, 0, 0, 0);
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const today = open().prepare("select count(*) c from comments where status='sent' and created_at >= ?").get(ds.toISOString());
  const hour = open().prepare("select count(*) c from comments where status='sent' and created_at >= ?").get(hourAgo);
  const last = open().prepare("select max(created_at) m from comments where status='sent'").get();
  return { today: today.c, lastHour: hour.c, lastAt: last.m || null };
}

module.exports = { open, upsertNote, hasCommented, insertComment, insertLead, listComments, listNotes, listLeads, stats, getConfig, setConfig, firstUsedAt, commentStats };
