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
