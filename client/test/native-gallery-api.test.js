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

test('account5 gallery API persists local inventory only in its isolated data directory', async t => {
  const { base, directory } = await startServer(t, 5);
  const before = await fetch(base + '/api/native/gallery').then(r => r.json());
  assert.deepEqual(before.catalog, { version: 1, properties: [] });
  const catalog = { version: 1, properties: [{ id: 'fixture-only', title: '接口测试占位数据', city: '测试城市', district: '测试区', locations: ['测试小区'], rent: 1500, bedrooms: 2, rentalType: 'entire', minLeaseMonths: 12, purpose: 'residential', available: true, features: [], images: [] }] };
  const saved = await fetch(base + '/api/native/gallery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(catalog) }).then(r => r.json());
  assert.equal(saved.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'native-gallery.json'))).properties[0].id, 'fixture-only');
  const invalid = await fetch(base + '/api/native/gallery', { method: 'POST', body: JSON.stringify({ version: 1, properties: [{ title: 'bad' }] }) });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(base + '/api/native/gallery').then(r => r.json())).catalog.properties[0].id, 'fixture-only');
  const unassessed = await fetch(base + '/api/native/reply-plan', { method: 'POST', body: JSON.stringify({ noteId: 'unknown' }) }).then(r => r.json());
  assert.equal(unassessed.ok, false);
  assert.match(unassessed.msg, /尚未判断/);
  assert.equal((await fetch(base + '/api/native/reply-image?path=/etc/passwd')).status, 404);
});

test('browser account cannot use or overwrite native gallery APIs', async t => {
  const { base, directory } = await startServer(t, 1);
  for (const route of ['gallery', 'reply-plan', 'reply-image']) {
    assert.equal((await fetch(base + '/api/native/' + route, { method: 'POST', body: '{}' })).status, 409);
  }
  assert.equal(fs.existsSync(path.join(directory, 'native-gallery.json')), false);
});

test('native UI reuses task settings and removes the global fixed image selector', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');
  assert.match(html, /id="native-gallery-settings" hidden/);
  assert.match(html, /id="page-tasksettings"[\s\S]*id="native-gallery-settings"[\s\S]*id="page-leadmodel"/);
  assert.doesNotMatch(html, /nativeImagePath|id="native-image-path"|chooseNativeImage\(/);
  assert.match(html, /http:\/\/127\.0\.0\.1:3105\/api\/native\/gallery/);
  assert.match(html, /暂无匹配图片/);
  assert.match(html, /imageVerified|图片身份|图片身份尚未核验|选图未核验/);
});
