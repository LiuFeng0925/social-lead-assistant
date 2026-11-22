'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { XhsCdpClient } = require('../src/cdp/xhs-cdp-client');

function clientWithTargets(targets, names) {
  const client = new XhsCdpClient({ endpoint: 'http://127.0.0.1:9333' });
  client.listTargets = async () => targets;
  client.sendCommand = async ({ target }) => ({ value: names[target.id] || '' });
  return client;
}

test('multi-account target resolver binds only the requested BrowserView marker', async () => {
  const a = { id: 'a', type: 'page', url: 'https://www.xiaohongshu.com/search_result?keyword=A', webSocketDebuggerUrl: 'ws://a' };
  const b = { id: 'b', type: 'page', url: 'https://www.xiaohongshu.com/search_result?keyword=B', webSocketDebuggerUrl: 'ws://b' };
  const client = clientWithTargets([a, b], { a: 'xhs-lead-account-1', b: 'xhs-lead-account-2' });
  const target = await client.resolvePageTarget({ accountMarker: 'xhs-lead-account-2' });
  assert.equal(target.id, 'b');
});

test('multi-account target resolver fails closed instead of using another account page', async () => {
  const a = { id: 'a', type: 'page', url: 'https://www.xiaohongshu.com/', webSocketDebuggerUrl: 'ws://a' };
  const client = clientWithTargets([a], { a: 'xhs-lead-account-1' });
  await assert.rejects(
    () => client.resolvePageTarget({ accountMarker: 'xhs-lead-account-2' }),
    /account_page_target_not_ready:xhs-lead-account-2/
  );
});

test('two-digit account markers cannot be mistaken for account 1', async () => {
  const targets = [10, 11, 15, 1].map(id => ({ id: String(id), type: 'page', url: 'https://www.xiaohongshu.com/?sla_account=xhs-lead-account-' + id }));
  const client = clientWithTargets(targets, {});
  assert.equal((await client.resolvePageTarget({ accountMarker: 'xhs-lead-account-1' })).id, '1');
  assert.equal((await client.resolvePageTarget({ accountMarker: 'xhs-lead-account-15' })).id, '15');
  client.listTargets = async () => targets.slice(0, 3);
  await assert.rejects(() => client.resolvePageTarget({ accountMarker: 'xhs-lead-account-1' }), /account_page_target_not_ready/);
});

test('remembered account target survives URL and page marker changes', async () => {
  const initial = { id: 'stable-account-4', type: 'page', url: 'https://www.xiaohongshu.com/?sla_account=xhs-lead-account-4', webSocketDebuggerUrl: 'ws://stable-account-4' };
  const client = clientWithTargets([initial], {});
  assert.equal((await client.resolvePageTarget({ accountMarker: 'xhs-lead-account-4' })).id, 'stable-account-4');

  const navigated = { ...initial, url: 'https://www.xiaohongshu.com/search_result_ai?keyword=%E6%96%B0%E5%8D%8E%E5%8C%BA%E6%89%BE%E6%88%BF' };
  client.listTargets = async () => [navigated];
  client.sendCommand = async () => { throw new Error('page marker was cleared'); };
  assert.equal((await client.resolvePageTarget({ accountMarker: 'xhs-lead-account-4' })).id, 'stable-account-4');
});

test('persistent storage marker can rebind an account after target recreation', async () => {
  const recreated = { id: 'recreated-account-5', type: 'page', url: 'https://www.xiaohongshu.com/search_result?keyword=B', webSocketDebuggerUrl: 'ws://recreated-account-5' };
  const client = clientWithTargets([recreated], { 'recreated-account-5': 'xhs-lead-account-5' });
  const target = await client.resolvePageTarget({ accountMarker: 'xhs-lead-account-5' });
  assert.equal(target.id, 'recreated-account-5');
});

test('Electron account marker writes a partition-local persistent identity', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  assert.match(source, /localStorage\.setItem\('__xhs_lead_account_marker'/);
});

test('an unresponsive account browser recovers only its own BrowserView', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
  assert.match(source, /function installBrowserRecovery/);
  assert.match(source, /webContents\.on\('unresponsive'/);
  assert.match(source, /webContents\.on\('render-process-gone'/);
  assert.doesNotMatch(source, /unresponsive[^]*app\.relaunch/);
});
