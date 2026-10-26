'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function startServer(t, accountId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-gallery-api-test-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env: { ...process.env, XHS_DATA_DIR: directory, XHS_ACCOUNT_ID: String(accountId), XHS_UI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('temporary server did not start')), 10000);
    child.stdout.on('data', data => { if (data.toString().includes('本地界面已启动')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('temporary server exited ' + code)); });
  });
  return { base: `http://127.0.0.1:${port}`, directory };
}

test('all web accounts reject retired App and publishing test routes', async t => {
  for (const id of [5, 15]) {
    const { base, directory } = await startServer(t, id);
    const historicalPath = path.join(directory, 'native-gallery.json');
    fs.writeFileSync(historicalPath, '{"historical":true}');
    for (const route of ['gallery', 'reply-plan', 'reply-image', 'app-assess', 'app-config', 'app-record']) {
      assert.equal((await fetch(base + '/api/native/' + route, { method: 'POST', body: '{}' })).status, 404);
    }
    assert.equal((await fetch(base + '/api/publish/test')).status, 404);
    assert.equal(fs.readFileSync(historicalPath, 'utf8'), '{"historical":true}');
    const script = await fetch(base + '/account-config.js').then(r => r.text());
    assert.match(script, /"count":15/);
    assert.equal((await fetch(base + '/api/account').then(r => r.json())).accountId, id);
    assert.equal((await fetch(base + '/api/engine/status').then(r => r.json())).status.running, false);
  }
});

test('web account settings and task history stay isolated', async t => {
  const first = await startServer(t, 5);
  const last = await startServer(t, 15);
  for (const [instance, label] of [[first, '石家庄五号'], [last, '成都十五号']]) {
    const data = encodeURIComponent(JSON.stringify({ account_label: label }));
    assert.equal((await fetch(instance.base + '/api/save-config?data=' + data).then(r => r.json())).ok, true);
  }
  assert.equal((await fetch(first.base + '/api/config').then(r => r.json())).config.account_label, '石家庄五号');
  assert.equal((await fetch(last.base + '/api/config').then(r => r.json())).config.account_label, '成都十五号');
});

test('account proxy credentials use POST storage and are never returned by config API', async t => {
  const instance = await startServer(t, 3);
  const saved = await fetch(instance.base + '/api/proxy-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy_enabled: true, proxy_city: '石家庄', proxy_host: '192.0.2.10', proxy_port: 29100, proxy_username: 'local-user', proxy_password: 'local-pass' })
  }).then(r => r.json());
  assert.equal(saved.ok, true);
  assert.equal(saved.restartRequired, true);
  const response = await fetch(instance.base + '/api/config').then(r => r.json());
  assert.equal(response.config.proxy_enabled, true);
  assert.equal(response.config.proxy_city, '石家庄');
  assert.equal(response.config.proxy_password, '');
  assert.equal(response.config.proxy_password_set, true);
});

test('account selects a saved city profile without exposing either profile credential', async t => {
  const instance = await startServer(t, 7);
  const profiles = {
    '石家庄': { protocol: 'http', host: '192.0.2.10', port: 29100, username: 'sjz-user', password: 'sjz-pass' },
    '成都': { protocol: 'http', host: '192.0.2.20', port: 29100, username: 'cd-user', password: 'cd-pass' }
  };
  const seed = encodeURIComponent(JSON.stringify({ proxy_profiles: profiles }));
  assert.equal((await fetch(instance.base + '/api/save-config?data=' + seed).then(r => r.json())).ok, true);
  const selected = await fetch(instance.base + '/api/proxy-city', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: '成都' })
  }).then(r => r.json());
  assert.equal(selected.ok, true);
  assert.equal(selected.city, '成都');
  const response = await fetch(instance.base + '/api/config').then(r => r.json());
  assert.deepEqual(response.config.proxy_cities.sort(), ['成都', '石家庄']);
  assert.equal(response.config.proxy_city, '成都');
  assert.equal(response.config.proxy_password, '');
  assert.equal(Object.hasOwn(response.config, 'proxy_profiles'), false);
  assert.equal(JSON.stringify(response).includes('sjz-pass'), false);
  assert.equal(JSON.stringify(response).includes('cd-pass'), false);
});
