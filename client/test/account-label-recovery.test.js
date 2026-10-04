'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { usesBrowser } = require('../electron/account-surface');
const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');

function labelsFixture() {
  const storage = new Map([['xhs-account-labels-v1', JSON.stringify({ 1: '牛总', 6: '文' })]]);
  const context = {
    AbortSignal,
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    renderAccountSwitcher: () => {},
    nativeFetch: async (url) => {
      if (url.includes(':3106/')) throw new Error('offline');
      return { json: async () => ({ ok: true, config: { account_label: '正常账号' } }) };
    }
  };
  vm.createContext(context);
  const state = html.slice(html.indexOf('function readCachedAccountLabels()'), html.indexOf('let nativeGalleryProperties'));
  const loader = html.slice(html.indexOf('async function loadAccountLabels()'), html.indexOf('function editActiveAccountLabel()'));
  vm.runInContext('const ACCOUNT_COUNT=6, ACCOUNT_PORT_BASE=3100;' + state + loader, context);
  return { context, storage, state: () => JSON.parse(vm.runInContext('JSON.stringify({accountLabels,accountAvailability})', context)) };
}

test('five production accounts precede the test tab without changing persistent account IDs', () => {
  const order = [...html.matchAll(/<button data-account="(\d)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [1, 2, 3, 4, 6, 5]);
  assert.equal(order.filter(usesBrowser).length, 5);
  assert.equal(usesBrowser(5), false);
});

test('an offline account retains its cached label and reports unavailability', async () => {
  const fixture = labelsFixture();
  await fixture.context.loadAccountLabels();
  assert.equal(fixture.state().accountLabels[6], '文');
  assert.equal(fixture.state().accountAvailability[6], false);
  assert.equal(JSON.parse(fixture.storage.get('xhs-account-labels-v1'))[6], '文');
});

test('a restored service refreshes its label; only a successful explicit empty label removes it', async () => {
  const fixture = labelsFixture();
  let label = '文恢复';
  fixture.context.nativeFetch = async () => ({ json: async () => ({ ok: true, config: { account_label: label } }) });
  await fixture.context.loadAccountLabels();
  assert.equal(fixture.state().accountLabels[6], '文恢复');
  assert.equal(fixture.state().accountAvailability[6], true);
  label = '';
  await fixture.context.loadAccountLabels();
  assert.equal(fixture.state().accountLabels[6], undefined);
  assert.equal(fixture.state().accountAvailability[6], true);
});
