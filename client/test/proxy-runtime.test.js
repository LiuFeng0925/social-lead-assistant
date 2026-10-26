'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { normalizeProxyConfig, proxyRulesFor, sameCity, verifyHttpProxy, applyProxyToSession } = require('../electron/proxy-runtime');

function configured(overrides = {}) {
  return normalizeProxyConfig({
    proxy_enabled: true, proxy_protocol: 'http', proxy_host: '192.0.2.10', proxy_port: 29100,
    proxy_username: 'local-user', proxy_password: 'local-pass', proxy_city: '石家庄', ...overrides
  });
}

test('proxy config fails closed when enabled fields are incomplete', () => {
  assert.match(normalizeProxyConfig({ proxy_enabled: true }).error, /代理主机/);
  assert.equal(proxyRulesFor(configured()), 'http://192.0.2.10:29100');
  assert.equal(sameCity('石家庄市', '石家庄'), true);
  assert.equal(sameCity('成都市', '石家庄'), false);
});

test('selected city resolves its locally stored proxy profile', () => {
  const config = normalizeProxyConfig({
    proxy_enabled: true,
    proxy_city: '成都',
    proxy_profiles: {
      '石家庄': { protocol: 'http', host: '192.0.2.10', port: 29100, username: 'sjz-user', password: 'sjz-pass' },
      '成都': { protocol: 'http', host: '192.0.2.20', port: 29100, username: 'cd-user', password: 'cd-pass' }
    }
  });
  assert.equal(config.expectedCity, '成都');
  assert.equal(config.host, '192.0.2.20');
  assert.equal(config.username, 'cd-user');
  assert.equal(config.error, '');
});

test('proxy verification accepts the configured city and rejects a mismatch', async () => {
  const requestFor = city => (options, callback) => {
    const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {};
    const request = new EventEmitter(); request.setTimeout = () => {}; request.end = () => {
      callback(response); response.emit('data', JSON.stringify({ status: 'success', city, query: '192.0.2.10', isp: 'Chinanet' })); response.emit('end');
    }; request.destroy = error => request.emit('error', error); request.options = options; return request;
  };
  const ok = await verifyHttpProxy(configured(), { request: requestFor('石家庄市') });
  assert.equal(ok.ok, true); assert.equal(ok.status, 'ready');
  const bad = await verifyHttpProxy(configured(), { request: requestFor('成都市') });
  assert.equal(bad.ok, false); assert.match(bad.message, /不是石家庄/);
});

test('electron session gets fixed proxy rules with no direct fallback', async () => {
  const calls = [];
  await applyProxyToSession({ setProxy: async value => calls.push(value), closeAllConnections: async () => calls.push('closed') }, configured());
  assert.deepEqual(calls[0], { mode: 'fixed_servers', proxyRules: 'http://192.0.2.10:29100', proxyBypassRules: '<-loopback>;localhost;127.0.0.1' });
  assert.equal(calls[1], 'closed');
});
