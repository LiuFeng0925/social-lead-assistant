'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-task-run-stats-'));
process.env.XHS_DATA_DIR = dataDir;
const db = require('../src/db');

test('repeated scans never erase already-sent reply statistics', () => {
  const runId = db.createTaskRun({ live: true });
  const note = { id: 'note-1', title: '求租一室', url: 'https://example.test/note-1' };
  const decision = { eligible: true, categoryName: '求租笔记', locationMatch: 'match', decisionReason: '符合条件' };
  db.addTaskRunScan(runId, '桥西区求租', 2);

  // 真实发送记录先落库；同一篇笔记稍后被循环扫描到时，这条记录仍必须保留。
  db.insertComment({ noteId: note.id, noteTitle: note.title, noteUrl: note.url, content: '您好', status: 'sent' });
  db.recordTaskRunDecision({ runId, keyword: '桥西区求租', note, decision, replyCount: 1 });
  db.recordTaskRunDecision({ runId, keyword: '桥西区求租', note, decision, replyCount: 0 });

  // 评论区另一位求租者的成功回复也归入同一篇笔记。
  db.insertComment({ noteId: note.id + ':reply:user-a:找房', noteTitle: note.title, noteUrl: note.url, content: '可以聊聊', status: 'sent' });
  db.recordTaskRunDecision({ runId, keyword: '桥西区求租', note, decision, replyCount: 1 });

  const report = db.taskRunReport(runId);
  assert.equal(report.keywords[0].reply_count, 2);
  assert.equal(report.decisions[0].reply_count, 2);
});
