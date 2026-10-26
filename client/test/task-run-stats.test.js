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

test('run funnel counts unique notes and keeps pending plus read failures truthful', () => {
  const runId = db.createTaskRun({ live: true });
  const first = [
    { id: 'unique-a', title: '求租一室' },
    { id: 'unique-b', title: '求租两室' }
  ];
  const addedFirst = db.recordTaskRunNotes({ runId, keyword: '石家庄求租', notes: first });
  const addedAgain = db.recordTaskRunNotes({ runId, keyword: '石家庄求租', notes: [first[0]] });
  const addedOtherKeyword = db.recordTaskRunNotes({
    runId,
    keyword: '长安区求租',
    notes: [first[0], { id: 'unique-c', title: '长安找房' }]
  });

  assert.deepEqual(addedFirst.map((note) => note.id), ['unique-a', 'unique-b']);
  assert.deepEqual(addedAgain, []);
  assert.deepEqual(addedOtherKeyword.map((note) => note.id), ['unique-c']);

  db.startTaskRunNoteAttempt(runId, 'unique-a');
  db.recordTaskRunDecision({
    runId,
    keyword: '石家庄求租',
    note: first[0],
    decision: { eligible: true, categoryName: '求租笔记', locationMatch: 'match', decisionReason: '符合条件' }
  });

  db.startTaskRunNoteAttempt(runId, 'unique-b');
  const firstFailure = db.recordTaskRunReadFailure({ runId, noteId: 'unique-b', reason: 'note_card_not_found', maxAttempts: 2 });
  assert.equal(firstFailure.retry, true);
  db.startTaskRunNoteAttempt(runId, 'unique-b');
  const finalFailure = db.recordTaskRunReadFailure({ runId, noteId: 'unique-b', reason: 'note_detail_not_opened', maxAttempts: 2 });
  assert.equal(finalFailure.retry, false);

  const report = db.taskRunReport(runId);
  assert.deepEqual({
    seen: report.summary.seen_count,
    judged: report.summary.judged_count,
    failed: report.summary.read_failed_count,
    pending: report.summary.pending_count,
    duplicates: report.summary.duplicate_seen_count
  }, { seen: 3, judged: 1, failed: 1, pending: 1, duplicates: 2 });
  assert.equal(report.summary.seen_count,
    report.summary.judged_count + report.summary.read_failed_count + report.summary.pending_count);
  assert.equal(report.readFailures[0].note_id, 'unique-b');
  assert.equal(report.readFailures[0].attempt_count, 2);
  assert.deepEqual(report.keywords.map((row) => ({
    keyword: row.keyword,
    seen: row.scanned_count,
    judged: row.judged_count,
    failed: row.read_failed_count,
    pending: row.pending_count
  })), [
    { keyword: '石家庄求租', seen: 2, judged: 1, failed: 1, pending: 0 },
    { keyword: '长安区求租', seen: 1, judged: 0, failed: 0, pending: 1 }
  ]);
});
