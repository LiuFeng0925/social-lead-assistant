'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
