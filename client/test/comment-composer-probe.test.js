'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COMMENT_COMPOSER_PROBE,
  inputCandidateScore,
  sendCandidateScore,
  pickCommentInput,
  pickEnabledSendButton,
  inputHasExpectedText
} = require('../src/comment-composer-probe');

test('semantic comment input outranks and excludes a visible search textarea', () => {
  const search = inputCandidateScore({
    visible: true, tag: 'TEXTAREA', classes: 'textarea', placeholder: '搜索小红书', inSearch: true
  });
  const comment = inputCandidateScore({
    visible: true, tag: 'P', id: 'content-textarea', classes: 'content-input',
    contentEditable: true, inEngageBar: true, inNoteDetail: true
  });

  assert.ok(search < 0, 'search textarea must never be a comment target');
  assert.ok(comment > 900, 'the note-detail editor should be a strong target');
  assert.ok(comment > search);
});

test('send button is selected only from enabled semantic candidates', () => {
  const disabledScore = sendCandidateScore({
    visible: true, tag: 'BUTTON', classes: 'btn submit gray', text: '发送', inComposer: true
  });
  const enabled = { x: 100, y: 200, classes: 'btn submit', text: '发送', disabled: false, score: disabledScore };
  const disabled = { x: 90, y: 200, classes: 'btn submit gray', text: '发送', disabled: true, score: disabledScore };

  assert.ok(disabledScore > 500);
  assert.ok(sendCandidateScore({ visible: true, tag: 'DIV', classes: 'right-btn-area', text: '收藏', inComposer: true }) < 0, 'unrelated composer controls must not become send buttons');
  assert.equal(pickEnabledSendButton({ sendBtns: [disabled, enabled] }), enabled);
  assert.equal(pickEnabledSendButton({ sendBtns: [disabled] }), null);
});

test('the typed text must be present in the selected comment editor before sending', () => {
  const input = pickCommentInput({ inputs: [{ text: '  有的\n', score: 1000 }] });
  assert.equal(inputHasExpectedText(input, '有的'), true);
  assert.equal(inputHasExpectedText({ text: '有房，私' }, '有的'), false);
  assert.equal(inputHasExpectedText(null, '有的'), false);
});

test('browser probe scopes controls to the note composer and detects modern Xiaohongshu classes', () => {
  assert.match(COMMENT_COMPOSER_PROBE, /#content-textarea/);
  assert.match(COMMENT_COMPOSER_PROBE, /\.engage-bar/);
  assert.match(COMMENT_COMPOSER_PROBE, /\[class\*="search"\]/);
  assert.match(COMMENT_COMPOSER_PROBE, /buttonRoot\.querySelectorAll/);
  assert.match(COMMENT_COMPOSER_PROBE, /disabled:/);
});
