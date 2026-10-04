'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { clearBrowserCachesOnRequest } = require('../electron/cache-maintenance');

const accounts = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1, partition: index === 0 ? null : `persist:xhs-lead-account-${index + 1}`
}));

function fixture(failures = {}) {
  const events = [];
  const logs = [];
  const sessions = new Map(accounts.map(account => {
    let size = account.id * 100;
    return [account.id, {
      async getCacheSize() { events.push([account.id, 'size']); return size; },
      async clearCache() {
        events.push([account.id, 'http']);
        if (failures[account.id] === 'http') throw new Error('private URL token must not be logged');
        size = 0;
      },
      async clearCodeCaches(options) {
        assert.deepEqual(options, {});
        events.push([account.id, 'code']);
        if (failures[account.id] === 'code') throw new Error('private URL token must not be logged');
      },
      async clearStorageData() { assert.fail('login/storage must be preserved'); },
      async clearData() { assert.fail('login/storage must be preserved'); },
      cookies: { remove() { assert.fail('cookies must be preserved'); } }
    }];
  }));
  const session = {
    get defaultSession() { events.push([1, 'session']); return sessions.get(1); },
    fromPartition(partition) {
      const account = accounts.find(item => item.partition === partition);
      assert.ok(account, 'must only resolve an explicitly listed account');
      events.push([account.id, 'session']);
      return sessions.get(account.id);
    }
  };
  return { session, events, logs, log: line => logs.push(line) };
}

test('normal launch does not resolve any session or clear cache', async () => {
  const f = fixture();
  const report = await clearBrowserCachesOnRequest({ ...f, argv: ['electron', 'main.js'], accounts });
  assert.deepEqual(report, { requested: false });
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.logs, []);
});

test('explicit cache maintenance covers six isolated sessions, including old test partition', async () => {
  const f = fixture();
  const report = await clearBrowserCachesOnRequest({ ...f, argv: ['--clear-browser-cache'], accounts });
  assert.equal(report.ok, true);
  assert.equal(report.accounts.length, 6);
  for (const row of report.accounts) {
    assert.equal(row.beforeBytes, row.accountId * 100);
    assert.equal(row.afterBytes, 0);
    assert.equal(row.httpCleared, true);
    assert.equal(row.codeCleared, true);
    assert.deepEqual(f.events.filter(event => event[0] === row.accountId).map(event => event[1]),
      ['session', 'size', 'http', 'code', 'size']);
  }
  assert.equal(f.logs.length, 7);
  assert.ok(f.logs.at(-1).startsWith('BROWSER_CACHE_MAINTENANCE_COMPLETE '));
  assert.deepEqual(JSON.parse(f.logs.at(-1).slice('BROWSER_CACHE_MAINTENANCE_COMPLETE '.length)), report);
});

test('failures are reported safely and do not prevent remaining account caches from clearing', async () => {
  const f = fixture({ 2: 'http', 5: 'code' });
  const report = await clearBrowserCachesOnRequest({ ...f, argv: ['--clear-browser-cache'], accounts });
  assert.equal(report.ok, false);
  assert.equal(report.accounts[1].codeCleared, true);
  assert.equal(report.accounts[1].httpCleared, false);
  assert.deepEqual(report.accounts[1].errors, ['http_cache']);
  assert.equal(report.accounts[4].httpCleared, true);
  assert.equal(report.accounts[4].codeCleared, false);
  assert.equal(report.accounts[5].ok, true);
  assert.doesNotMatch(f.logs.join('\n'), /private URL|token/);
});

test('cache-size probe failure does not skip clearing, but completion reports incomplete verification', async () => {
  const f = fixture();
  const original = f.session.fromPartition;
  f.session.fromPartition = partition => {
    const current = original(partition);
    current.getCacheSize = async () => { throw new Error('probe unavailable'); };
    return current;
  };
  const report = await clearBrowserCachesOnRequest({ ...f, argv: ['--clear-browser-cache'], accounts });
  assert.equal(report.ok, false);
  assert.equal(report.accounts[1].httpCleared, true);
  assert.equal(report.accounts[1].codeCleared, true);
  assert.equal(report.accounts[1].beforeBytes, null);
  assert.deepEqual(report.accounts[1].errors, ['cache_size_before', 'cache_size_after']);
});

test('maintenance finishes before worker and browser creation on startup', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  const startup = source.slice(source.indexOf('app.whenReady().then(async () => {'));
  assert.ok(startup.indexOf('await clearBrowserCachesOnRequest(') >= 0);
  assert.ok(startup.indexOf('await clearBrowserCachesOnRequest(') < startup.indexOf('startWorker(id)'));
  assert.ok(startup.indexOf('await clearBrowserCachesOnRequest(') < startup.indexOf('new BrowserWindow('));
  assert.match(startup, /Array.from\(\{ length: ACCOUNT_COUNT \}, \(_, index\) => accountMeta\(index \+ 1\)\)/);
});
