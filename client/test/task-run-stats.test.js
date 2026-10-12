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

test('run report separates unique useful notes and delivery failures', () => {
  const runId = db.createTaskRun({ live: true });
  const decision = { eligible: true, categoryName: '求租笔记', locationMatch: 'match', decisionReason: '符合条件' };
  const note = { id: 'same-note', title: '求租一室' };
  db.addTaskRunScan(runId, '关键词A', 1);
  db.addTaskRunScan(runId, '关键词B', 1);
  db.recordTaskRunDecision({ runId, keyword: '关键词A', note, decision });
  db.recordTaskRunDecision({ runId, keyword: '关键词B', note, decision });
  db.recordTaskRunDelivery({ runId, keyword: '关键词A', noteId: note.id, targetType: 'author', status: 'send_button_not_found', reason: '按钮未出现' });
  db.recordTaskRunDelivery({ runId, keyword: '关键词A', noteId: note.id, targetType: 'commenter', targetKey: '用户甲', status: 'reply_target_mismatch', reason: '对象未确认' });

  const report = db.taskRunReport(runId);
  assert.equal(report.summary.unique_useful_count, 1);
  assert.equal(report.summary.duplicate_useful_count, 1);
  assert.deepEqual(Object.fromEntries(report.deliveries.map((row) => [row.status, row.count])), {
    send_button_not_found: 1,
    reply_target_mismatch: 1
  });
});

test('run report counts location-review tenants separately from useless notes', () => {
  const runId = db.createTaskRun({ live: false });
  db.addTaskRunScan(runId, '石家庄求租', 1);
  db.recordTaskRunDecision({
    runId,
    keyword: '石家庄求租',
    note: { id: 'review-note', title: '方兆科技园求租' },
    decision: {
      eligible: false,
      reviewRequired: true,
      categoryName: '求租笔记',
      locationMatch: 'unknown',
      decisionReason: '地区待确认：通勤范围未映射'
    }
  });

  const report = db.taskRunReport(runId);
  assert.equal(report.keywords[0].review_count, 1);
  assert.equal(report.keywords[0].useful_count, 0);
  assert.equal(report.keywords[0].useless_count, 0);
  assert.equal(report.decisions[0].review_required, 1);
});
