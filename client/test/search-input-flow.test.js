'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { LOGIN_STATUS_EXPR } = require('../src/login-status');
const probes = require('../src/search-input-probe');

function fixture(options = {}) {
  const filename = require.resolve('../src/engine');
  const localRequire = createRequire(filename), mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, URL, process,
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    require: name => {
      const original = localRequire(name);
      return name === './search-recovery' ? { ...original,
        waitForSearch: (ms, stop) => original.waitForSearch(ms, stop, async () => {}) } : original;
    }
  }, { filename });
  const calls = [], logs = [], target = { id: 'account-2-only' };
  const state = { focused: false, value: '', covered: !!options.covered, clicks: 0, selections: 0, typed: 0, reads: 0, stopped: false, wall: false, ...options.state };
  const client = {
    async evaluate(request) {
      assert.equal(request.target, target);
      if (request.expression === LOGIN_STATUS_EXPR) return { value: JSON.stringify({ url: 'https://www.xiaohongshu.com/explore', loggedIn: true, securityWall: state.wall }) };
      if (request.expression === probes.SEARCH_INPUT_DIAGNOSTIC_PROBE) return { value: JSON.stringify({ reason: 'fixture', focused: state.focused }) };
      if (request.expression === probes.SEARCH_SUBMIT_PROBE) {
        if (options.hideSubmit) return { value: '' };
        return { value: JSON.stringify({ x: 690, y: 36 }) };
      }
      assert.equal(request.expression, probes.SEARCH_INPUT_PROBE);
      state.reads++;
      if (options.onRead) options.onRead(state);
      if (state.covered) return { value: '' };
      return { value: JSON.stringify({ x: 419, y: 36, value: state.value, focused: state.focused }) };
    },
    async click({ target: t, x }) {
      assert.equal(t, target);
      calls.push(x === 690 ? 'submit' : 'focus');
      if (x !== 690) { state.clicks++; state.focused = state.clicks > (options.failedClicks || 0); }
    },
    async selectAll({ target: t }) {
      assert.equal(t, target); assert.equal(state.focused, true);
      calls.push('select'); state.selections++; state.value = '';
      if (options.dropFocusAfterSelect && state.selections === 1) state.focused = false;
      if (options.stopAfterSelect) state.stopped = true;
      if (options.wallAfterSelect) state.wall = true;
    },
    async typeText({ target: t, text }) {
      assert.equal(t, target); assert.equal(state.focused, true);
      calls.push('type'); state.typed++;
      state.value = options.alwaysWrong ? '错误关键词' : text;
    },
    async pressKey({ target: t, key }) {
      assert.equal(t, target); assert.equal(key, 'Escape');
      calls.push('escape'); state.covered = false;
    },
    async navigate() { assert.fail('no direct search/note navigation'); }
  };
  return { state, calls, logs,
    run: () => mod.exports.searchFromPageUi({ client, target, keyword: '石家庄求租', onLog: m => logs.push(m), shouldStop: () => state.stopped }) };
}

test('covered input is recovered before any typing, using the same account only', async () => {
  const f = fixture({ covered: true }); await f.run();
  assert.deepEqual(f.calls, ['escape', 'focus', 'select', 'type', 'submit']);
});

test('a failed focus click never types into an unrelated control, then re-resolves', async () => {
  const f = fixture({ failedClicks: 1 }); await f.run();
  assert.deepEqual(f.calls, ['focus', 'escape', 'focus', 'select', 'type', 'submit']);
  assert.ok(f.logs.some(m => m.includes('search_input_not_focused')));
});

test('focus lost after SelectAll cancels that write and re-clicks safely', async () => {
  const f = fixture({ dropFocusAfterSelect: true }); await f.run();
  assert.deepEqual(f.calls, ['focus', 'select', 'focus', 'select', 'type', 'submit']);
});

test('persistent focus failure is bounded and never types or submits', async () => {
  const f = fixture({ failedClicks: 10 });
  await assert.rejects(f.run(), /search_input_not_focused/);
  assert.equal(f.state.clicks, 3);
  assert.equal(f.state.typed, 0);
  assert.equal(f.calls.filter(x => x === 'escape').length, 1);
  assert.ok(!f.calls.includes('submit'));
});

test('persistent value mismatch has a specific diagnostic and no submit', async () => {
  const f = fixture({ alwaysWrong: true });
  await assert.rejects(f.run(), /search_keyword_not_entered/);
  assert.equal(f.state.typed, 3);
  assert.ok(f.logs.some(m => m.includes('search_value_mismatch')));
  assert.ok(!f.calls.includes('submit'));
});

test('redrawn or covered input never reuses stale coordinates', async () => {
  const f = fixture({ onRead: s => { if (s.reads >= 2) s.covered = true; } });
  await assert.rejects(f.run(), /search_keyword_not_entered/);
  assert.equal(f.state.clicks, 0);
  assert.equal(f.state.typed, 0);
});

test('stop after selection prevents subsequent input and submit', async () => {
  const f = fixture({ stopAfterSelect: true });
  await assert.rejects(f.run(), { code: 'SEARCH_CANCELLED' });
  assert.equal(f.state.typed, 0);
  assert.ok(!f.calls.includes('submit'));
});

test('verification appearing mid-input prevents typing and is not dismissed', async () => {
  const f = fixture({ wallAfterSelect: true });
  await assert.rejects(f.run(), { code: 'ACCOUNT_SECURITY_BLOCK' });
  assert.equal(f.state.typed, 0);
  assert.ok(!f.calls.includes('escape'));
});

test('missing submit button is bounded and records a diagnostic', async () => {
  const f = fixture({ hideSubmit: true });
  await assert.rejects(f.run(), /search_submit_button_not_found/);
  assert.ok(f.logs.some(m => m.includes('search_submit_missing_or_covered')));
  assert.ok(!f.calls.includes('submit'));
});
