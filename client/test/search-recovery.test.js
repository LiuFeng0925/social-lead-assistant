'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const engine = require('../src/engine');
const { LOGIN_STATUS_EXPR } = require('../src/login-status');
const { withSearchRecovery, returnHomeForSearch, isSearchRecoveryError, homeRetryLimit,
  waitForSearch, SEARCH_HOME_PROBE, isXhsHome } = require('../src/search-recovery');

const mismatch = () => engine.searchPageMismatchError('石家庄求租', 'https://www.xiaohongshu.com/explore');

test('correct search needs no recovery and returns the original results', async () => {
  const notes = [{ id: 'correct' }];
  const result = await withSearchRecovery({ scan: async () => notes, returnHome: async () => assert.fail('no navigation') });
  assert.equal(result, notes);
});

test('mismatch returns home once and retries the same scan without surfacing failed data', async () => {
  const calls = [], logs = [];
  let attempt = 0;
  const result = await withSearchRecovery({
    scan: async () => { calls.push('scan'); if (++attempt === 1) throw mismatch(); return [{ id: 'correct' }]; },
    returnHome: async () => calls.push('home'), onLog: (m) => logs.push(m)
  });
  assert.deepEqual(calls, ['scan', 'home', 'scan']);
  assert.deepEqual(result, [{ id: 'correct' }]);
  assert.ok(logs.some((m) => m.includes('1/1')));
  assert.ok(logs.some((m) => m.includes('搜索恢复成功')));
});

test('repeated mismatch is terminal after one home retry, not an endless loop', async () => {
  let scans = 0, homes = 0;
  await assert.rejects(withSearchRecovery({
    scan: async () => { scans++; throw mismatch(); }, returnHome: async () => homes++
  }), (e) => engine.isSearchRecoveryError(e) && /已达上限/.test(e.userMessage));
  assert.equal(scans, 2);
  assert.equal(homes, 1);
});

test('input and submit failures use the same bounded recovery budget', async () => {
  for (const reason of ['search_input_not_found', 'search_input_not_focused', 'search_keyword_not_entered', 'search_submit_button_not_found']) {
    let calls = 0;
    await assert.rejects(withSearchRecovery({
      scan: async () => { throw new Error(reason); }, returnHome: async () => calls++
    }), isSearchRecoveryError);
    assert.equal(calls, 1);
  }
});

test('unrelated errors and account verification never cause a recovery navigation', async () => {
  for (const error of [engine.accountSecurityError('验证码'), new Error('WebSocket closed'), new Error('llm_timeout')]) {
    await assert.rejects(withSearchRecovery({
      scan: async () => { throw error; }, returnHome: async () => assert.fail('no recovery')
    }), (e) => e === error);
  }
});

test('retry setting can disable recovery and cannot exceed two retries', async () => {
  assert.deepEqual([undefined, null, '', NaN, 0, -2, 1, 2, 99].map(homeRetryLimit), [1, 1, 1, 1, 0, 0, 1, 2, 2]);
  let homes = 0;
  await assert.rejects(withSearchRecovery({
    maxHomeRetries: 0, scan: async () => { throw mismatch(); }, returnHome: async () => homes++
  }), isSearchRecoveryError);
  assert.equal(homes, 0);
});

test('stopping during scan or recovery returns no results and never starts a new attempt', async () => {
  for (const stopAtHome of [false, true]) {
    let stopped = false, scans = 0, homes = 0;
    const result = await withSearchRecovery({
      shouldStop: () => stopped,
      scan: async () => { scans++; if (!stopAtHome) stopped = true; throw mismatch(); },
      returnHome: async () => { homes++; stopped = true; }
    });
    assert.deepEqual(result, []);
    assert.equal(scans, 1);
    assert.equal(homes, Number(stopAtHome));
  }
});

test('stop-aware waiting checks every 250 ms', async () => {
  const waits = [];
  await assert.rejects(waitForSearch(15000, () => waits.length > 0, async (ms) => waits.push(ms)), { code: 'SEARCH_CANCELLED' });
  assert.deepEqual(waits, [250]);
});

function homeFixture({ point = { x: 70, y: 120 }, wall = null, afterWall = null, navigateWorks = true } = {}) {
  const target = { id: 'isolated-account-4' }, calls = [];
  let moved = false;
  const client = {
    async evaluate(request) {
      assert.equal(request.target, target);
      if (request.expression === LOGIN_STATUS_EXPR) {
        const blocked = moved ? afterWall : wall;
        return { value: JSON.stringify({ url: moved && navigateWorks ? 'https://www.xiaohongshu.com/explore' : 'https://www.xiaohongshu.com/search_result?keyword=wrong', loggedIn: true, ...blocked }) };
      }
      if (request.expression === SEARCH_HOME_PROBE) return { value: JSON.stringify(point) };
      if (request.expression === 'document.readyState') return { value: 'complete' };
      assert.fail('unexpected evaluation');
    },
    async click(request) { assert.equal(request.target, target); calls.push('click'); moved = true; },
    async navigate(request) { assert.equal(request.target, target); calls.push(request.url); moved = true; }
  };
  return { client, target, calls, wait: async () => {} };
}

test('home recovery clicks the same account page and waits for the real home route', async () => {
  const fixture = homeFixture();
  await returnHomeForSearch(fixture);
  assert.deepEqual(fixture.calls, ['click']);
});

test('absent home button may navigate only to the fixed homepage, not a search/note URL', async () => {
  const fixture = homeFixture({ point: null });
  await returnHomeForSearch(fixture);
  assert.deepEqual(fixture.calls, ['https://www.xiaohongshu.com/explore']);
});

test('visible login/security wall and captcha/error routes block home recovery without clicks', async () => {
  for (const wall of [{ loginWall: true }, { securityWall: true },
    { url: 'https://www.xiaohongshu.com/website-login/captcha' },
    { url: 'https://www.xiaohongshu.com/website-login/error?error_code=300011' }]) {
    const fixture = homeFixture({ wall });
    await assert.rejects(returnHomeForSearch(fixture), { code: 'ACCOUNT_SECURITY_BLOCK' });
    assert.deepEqual(fixture.calls, []);
  }
});

test('verification appearing after home click stops before any further search', async () => {
  const fixture = homeFixture({ afterWall: { loginWall: true } });
  await assert.rejects(returnHomeForSearch(fixture), { code: 'ACCOUNT_SECURITY_BLOCK' });
  assert.deepEqual(fixture.calls, ['click']);
});

test('home did not load: fail closed without repeated clicks', async () => {
  const fixture = homeFixture({ navigateWorks: false });
  await assert.rejects(returnHomeForSearch(fixture), isSearchRecoveryError);
  assert.deepEqual(fixture.calls, ['click']);
});

test('stopping while resolving the home button prevents a navigation', async () => {
  const fixture = homeFixture();
  let stopped = false;
  const evaluate = fixture.client.evaluate;
  fixture.client.evaluate = async (request) => {
    const result = await evaluate(request);
    if (request.expression === SEARCH_HOME_PROBE) stopped = true;
    return result;
  };
  await assert.rejects(returnHomeForSearch({ ...fixture, shouldStop: () => stopped }), { code: 'SEARCH_CANCELLED' });
  assert.deepEqual(fixture.calls, []);
});

test('home verification rejects profile, external and insecure URLs', () => {
  assert.equal(isXhsHome('https://www.xiaohongshu.com/'), true);
  assert.equal(isXhsHome('https://www.xiaohongshu.com/explore?channel=x'), true);
  for (const url of ['https://www.xiaohongshu.com/user/profile/123', 'https://evilxiaohongshu.com/explore', 'http://www.xiaohongshu.com/explore']) assert.equal(isXhsHome(url), false);
});

test('home button probe requires homepage link and rejects an occluded hit target', () => {
  const anchor = {
    href: 'https://www.xiaohongshu.com/explore', innerText: '发现',
    getBoundingClientRect: () => ({ left: 20, top: 60, right: 120, bottom: 100, width: 100, height: 40 }),
    contains: (node) => node === anchor
  };
  let hit = anchor;
  const context = {
    URL, location: { href: 'https://www.xiaohongshu.com/search_result?keyword=wrong', origin: 'https://www.xiaohongshu.com' },
    document: { querySelectorAll: () => [anchor], elementFromPoint: () => hit },
    innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({ opacity: 1 })
  };
  assert.deepEqual(JSON.parse(vm.runInNewContext(SEARCH_HOME_PROBE, context)), { x: 70, y: 80 });
  hit = {};
  assert.equal(vm.runInNewContext(SEARCH_HOME_PROBE, context), '');
  hit = anchor;
  anchor.href = 'https://www.xiaohongshu.com/user/profile/123';
  assert.equal(vm.runInNewContext(SEARCH_HOME_PROBE, context), '');
});

test('full scan refuses a visible verification wall before submitting or extracting cards', async () => {
  const fixture = homeFixture({ wall: { loginWall: true } });
  await assert.rejects(engine.scanClean({ ...fixture, keyword: '石家庄求租' }), { code: 'ACCOUNT_SECURITY_BLOCK' });
  assert.deepEqual(fixture.calls, []);
});

test('stopped full scan performs no browser actions', async () => {
  const notes = await engine.scanClean({ client: {}, target: {}, keyword: '石家庄求租', shouldStop: () => true });
  assert.deepEqual(notes, []);
});

test('a login wall appearing while finding the search box is not dismissed with Escape', async () => {
  const fast = fastEngine();
  let checks = 0;
  const client = {
    async evaluate({ expression }) {
      if (expression === LOGIN_STATUS_EXPR) return { value: JSON.stringify({ url: 'https://www.xiaohongshu.com/explore', loggedIn: true, loginWall: ++checks > 1 }) };
      return { value: '' };
    },
    async pressKey() { assert.fail('must preserve the login wall'); },
    async click() { assert.fail('must not click'); }
  };
  await assert.rejects(fast.searchFromPageUi({ client, target: {}, keyword: '石家庄求租' }), { code: 'ACCOUNT_SECURITY_BLOCK' });
});

test('stop or verification during filter mouse movement prevents the filter click', async () => {
  for (const verification of [false, true]) {
    const fast = fastEngine();
    let moved = false;
    const client = {
      async evaluate({ expression }) {
        if (expression.includes('querySelector(".filter-panel")')) return { value: 1 };
        return { value: JSON.stringify({ x: 100, y: 200, active: false }) };
      },
      async humanMove() { moved = true; },
      async click() { assert.fail('no filter click after stop or verification'); }
    };
    await assert.rejects(fast.applyFilters({ client, target: {}, filters: { sort: '最新' },
      shouldStop: () => !verification && moved,
      beforeAction: async () => { if (verification && moved) throw engine.accountSecurityError('安全验证'); }
    }), { code: verification ? 'ACCOUNT_SECURITY_BLOCK' : 'SEARCH_CANCELLED' });
  }
});

// Execute the real engine flow with only waits and list-scroll cleanup replaced.
// This reproduces the user's stuck submit without touching a live account.
function fastEngine() {
  const filename = path.join(__dirname, '../src/engine.js');
  const localRequire = createRequire(filename);
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, URL, process,
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    require: (name) => {
      const original = localRequire(name);
      if (name === './search-recovery') return {
        ...original,
        waitForSearch: (ms, stop) => original.waitForSearch(ms, stop, async () => {}),
        returnHomeForSearch: (options) => original.returnHomeForSearch({ ...options, wait: async () => {} })
      };
      if (name === './note-navigation') return { ...original, resetSearchListScroll: async () => {} };
      return original;
    }
  }, { filename });
  return mod.exports;
}

test('integration: stuck submit -> same-account home -> same keyword and filters -> verified cards only', async () => {
  const fast = fastEngine(), target = { id: 'account-4' }, logs = [], typed = [];
  let url = 'https://www.xiaohongshu.com/search_result?keyword=wrong', input = '', submits = 0, homes = 0, extracts = 0;
  const client = {
    async evaluate(request) {
      assert.equal(request.target, target);
      const expr = request.expression;
      if (expr === LOGIN_STATUS_EXPR || expr.includes('document.title')) return { value: JSON.stringify({ url, title: '小红书', loggedIn: true }) };
      if (expr === fast.SEARCH_INPUT_PROBE) return { value: JSON.stringify({ x: 419, y: 36, value: input, focused: true }) };
      if (expr === fast.SEARCH_SUBMIT_PROBE) return { value: JSON.stringify({ x: 690, y: 36 }) };
      if (expr === SEARCH_HOME_PROBE) return { value: JSON.stringify({ x: 70, y: 120 }) };
      if (expr === 'document.readyState') return { value: 'complete' };
      if (expr.includes('readyState:document.readyState')) return { value: JSON.stringify({ url, readyState: 'complete', count: 8 }) };
      if (expr.includes('var feedArr=')) {
        assert.ok(fast.searchPageMatches(url, '石家庄求租'), 'never extract the wrong page');
        extracts++;
        return { value: JSON.stringify({ count: 1, notes: [{ id: 'verified', title: '求租', x: 200, y: 200 }] }) };
      }
      if (expr.includes('var want=') && expr.includes('.filter-panel div.tags')) return { value: JSON.stringify({ x: 100, y: 200, active: true }) };
      if (expr.includes('querySelector(".filter-panel")')) return { value: 1 };
      if (expr.includes('a.join("、")')) return { value: '最新、一周内' };
      if (expr.includes('.filter-panel .operation')) return { value: '' };
      if (expr === 'location.href') return { value: url };
      if (expr.startsWith('window.scrollTo')) return { value: 'ok' };
      assert.fail('unexpected expression: ' + expr.slice(0, 100));
    },
    async click({ target: requested, x }) {
      assert.equal(requested, target);
      if (x === 70) { homes++; url = 'https://www.xiaohongshu.com/explore'; input = ''; }
      if (x === 690 && ++submits === 2) url = fast.buildSearchUrl('石家庄求租');
    },
    async selectAll() { input = ''; },
    async typeText({ text }) { input = text; typed.push(text); },
    async installCursor() {}, async navigate() { assert.fail('the home link exists'); }
  };
  const notes = await fast.scanClean({ client, target, keyword: '石家庄求租', maxNotes: 1,
    filters: { sort: '最新', noteTime: '一周内' }, onLog: (m) => logs.push(m) });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, 'verified');
  assert.equal(notes[0].searchKeyword, '石家庄求租');
  assert.deepEqual(typed, ['石家庄求租', '石家庄求租']);
  assert.equal(homes, 1);
  assert.equal(extracts, 1);
  assert.ok(logs.some((m) => m.includes('「最新」✓ 已生效')));
  assert.ok(logs.some((m) => m.includes('「一周内」✓ 已生效')));
});

function pageGuardFixture(sequence, { stopAfterRead = false, wallAfterRead = false } = {}) {
  const fast = fastEngine(); let reads = 0;
  const client = { async evaluate({ expression }) {
    if (expression === LOGIN_STATUS_EXPR) return { value: JSON.stringify({ url: fast.buildSearchUrl('石家庄求租'), loggedIn: true, securityWall: wallAfterRead && reads > 0 }) };
    const next = sequence[Math.min(reads++, sequence.length - 1)];
    if (next instanceof Error) throw next;
    return { value: next == null ? '' : JSON.stringify(next) };
  } };
  return { run: () => fast.waitForVerifiedSearchPage({ client, target: {}, keyword: '石家庄求租', shouldStop: () => stopAfterRead && reads > 0 }), get reads() { return reads; } };
}

test('search guard tolerates a transient missing DOM result without a homepage restart', async () => {
  const good = { url: engine.buildSearchUrl('石家庄求租'), readyState: 'complete', count: 0 };
  for (const first of [null, new Error('context destroyed'), { ...good, readyState: 'loading' }]) {
    const f = pageGuardFixture([first, good]);
    assert.equal((await f.run()).url, good.url);
    assert.equal(f.reads, 2);
  }
});

test('search guard immediately refuses a known wrong page or keyword', async () => {
  for (const url of ['https://www.xiaohongshu.com/explore', engine.buildSearchUrl('另一关键词')]) {
    const f = pageGuardFixture([{ url, readyState: 'complete', count: 20 }]);
    await assert.rejects(f.run(), { code: 'SEARCH_PAGE_MISMATCH' });
    assert.equal(f.reads, 1);
  }
});

test('search guard times out rather than accepting stale or unreadable state', async () => {
  const f = pageGuardFixture([null]);
  await assert.rejects(f.run(), { code: 'SEARCH_PAGE_MISMATCH' });
  assert.equal(f.reads, 9);
});

test('stop or verification during search-page settling prevents further probing', async () => {
  for (const wallAfterRead of [false, true]) {
    const f = pageGuardFixture([null], { wallAfterRead, stopAfterRead: !wallAfterRead });
    await assert.rejects(f.run(), { code: wallAfterRead ? 'ACCOUNT_SECURITY_BLOCK' : 'SEARCH_CANCELLED' });
    assert.equal(f.reads, 1);
  }
});
