'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine');

test('notification reply finder targets the full action container', () => {
  assert.match(engine._replyFindFn.toString(), /closest\('\.action-reply'\)/);
});

test('notification composer probe supports modern editable controls', () => {
  const source = engine._inboxReplyComposerProbeFn.toString();
  assert.match(source, /contenteditable=true/);
  assert.match(source, /role="textbox"/);
});

test('notification send probe binds send to the composer containing expected text', () => {
  const source = engine._inboxSendProbeFn.toString();
  assert.match(source, /expectedText/);
  assert.match(source, /closest\('button'\)/);
});

test('notification sent probe waits while expected text remains', () => {
  assert.match(engine._inboxSentProbeFn.toString(), /return 'pending'/);
});
