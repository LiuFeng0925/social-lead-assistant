'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('sent comments migrate into the visibility audit queue and retain the verifier result', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-visibility-'));
  const oldDir = process.env.XHS_DATA_DIR;
  process.env.XHS_DATA_DIR = directory;
  const modulePath = require.resolve('../src/db');
  delete require.cache[modulePath];
  const db = require('../src/db');
  try {
    db.insertComment({ noteId: 'note-1', noteTitle: '求租', noteUrl: 'https://www.xiaohongshu.com/explore/note-1', content: '有房，刚腾出来', status: 'sent' });
    const items = db.listVisibilityCandidates(10);
    assert.equal(items.length, 1);
    assert.equal(items[0].visibility_status, 'unverified');
    db.updateCommentVisibility(items[0].id, { status: 'visible', verifierAccount: 2, reason: '身份和正文均匹配' });
    const stats = db.visibilityStats();
    assert.equal(stats.visible, 1);
    assert.equal(stats.unverified, 0);
    const checked = db.listVisibilityCandidates(10)[0];
    assert.equal(checked.visibility_verifier_account, 2);
    assert.equal(checked.visibility_reason, '身份和正文均匹配');
  } finally {
    db.close();
    if (oldDir === undefined) delete process.env.XHS_DATA_DIR; else process.env.XHS_DATA_DIR = oldDir;
    delete require.cache[modulePath];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
