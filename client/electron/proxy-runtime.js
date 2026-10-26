'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PROXY_KEYS = [
  'proxy_enabled', 'proxy_city', 'proxy_protocol', 'proxy_host',
  'proxy_port', 'proxy_username', 'proxy_password', 'proxy_profiles'
];

function parseStored(value) {
  try { return JSON.parse(value); } catch (_) { return value; }
}

function readAccountProxy(dataDir) {
  const file = path.join(dataDir, 'xhs.sqlite');
  if (!fs.existsSync(file)) return normalizeProxyConfig({});
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const placeholders = PROXY_KEYS.map(() => '?').join(',');
    const rows = database.prepare(`select k,v from config where k in (${placeholders})`).all(...PROXY_KEYS);
    const stored = {};
    for (const row of rows) stored[row.k] = parseStored(row.v);
    return normalizeProxyConfig(stored);
  } finally {
    database.close();
  }
}

function normalizeProxyConfig(input = {}) {
  const enabled = input.proxy_enabled === true;
  const expectedCity = String(input.proxy_city || '').replace(/[省市\s]/g, '').trim();
  const profiles = input.proxy_profiles && typeof input.proxy_profiles === 'object' ? input.proxy_profiles : {};
  const profileKey = Object.keys(profiles).find(city => String(city).replace(/[省市\s]/g, '').trim() === expectedCity);
  const profile = profileKey && profiles[profileKey] && typeof profiles[profileKey] === 'object' ? profiles[profileKey] : {};
  const protocol = String(profile.protocol || input.proxy_protocol || 'http').trim().toLowerCase();
  const host = String(profile.host || input.proxy_host || '').trim();
  const port = Math.floor(Number(profile.port || input.proxy_port) || 0);
  const username = String(profile.username || input.proxy_username || '');
  const password = String(profile.password || input.proxy_password || '');
  let error = '';
  if (enabled && protocol !== 'http') error = '当前版本只支持带账号密码的 HTTP 代理';
  else if (enabled && (!host || /[\s/:]/.test(host))) error = '代理主机格式不正确';
  else if (enabled && (!Number.isInteger(port) || port < 1 || port > 65535)) error = '代理端口不正确';
  else if (enabled && (!username || !password)) error = '代理用户名或密码未填写';
  else if (enabled && !expectedCity) error = '未填写期望出口城市';
  return { enabled, protocol, host, port, username, password, expectedCity, error };
}

function proxyRulesFor(config) {
  const cfg = normalizeProxyConfig({
    proxy_enabled: config.enabled,
    proxy_protocol: config.protocol,
    proxy_host: config.host,
    proxy_port: config.port,
    proxy_username: config.username,
    proxy_password: config.password,
    proxy_city: config.expectedCity
  });
  if (!cfg.enabled || cfg.error) return '';
  return `${cfg.protocol}://${cfg.host}:${cfg.port}`;
}

function sameCity(actual, expected) {
  const left = String(actual || '').replace(/[省市\s]/g, '').trim();
  const right = String(expected || '').replace(/[省市\s]/g, '').trim();
  return !!left && !!right && (left.includes(right) || right.includes(left));
}

function verifyHttpProxy(config, { timeoutMs = 12000, request = http.request } = {}) {
  const cfg = config && config.enabled != null ? config : normalizeProxyConfig(config || {});
  if (!cfg.enabled) return Promise.resolve({ ok: true, status: 'disabled', city: '', ip: '' });
  if (cfg.error) return Promise.resolve({ ok: false, status: 'blocked', message: cfg.error, city: '', ip: '' });
  return new Promise((resolve) => {
    const authorization = Buffer.from(`${cfg.username}:${cfg.password}`, 'utf8').toString('base64');
    const req = request({
      hostname: cfg.host,
      port: cfg.port,
      method: 'GET',
      path: 'http://ip-api.com/json/?fields=status,message,country,regionName,city,query,isp&lang=zh-CN',
      headers: { Host: 'ip-api.com', 'Proxy-Authorization': `Basic ${authorization}`, Connection: 'close' }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 65536) body += chunk; });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (response.statusCode !== 200 || data.status !== 'success') throw new Error(data.message || `HTTP ${response.statusCode}`);
          if (!sameCity(data.city, cfg.expectedCity)) {
            resolve({ ok: false, status: 'blocked', city: data.city || '', ip: data.query || '', isp: data.isp || '', message: `代理出口为${data.city || '未知城市'}，不是${cfg.expectedCity}` });
            return;
          }
          resolve({ ok: true, status: 'ready', city: data.city || '', ip: data.query || '', isp: data.isp || '', message: '代理出口校验通过' });
        } catch (error) {
          resolve({ ok: false, status: 'blocked', city: '', ip: '', message: `代理校验响应异常：${error.message}` });
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('代理连接超时')));
    req.on('error', error => resolve({ ok: false, status: 'blocked', city: '', ip: '', message: `代理连接失败：${error.message}` }));
    req.end();
  });
}

async function applyProxyToSession(browserSession, config) {
  const rules = proxyRulesFor(config);
  if (!rules) return;
  await browserSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: rules,
    proxyBypassRules: '<-loopback>;localhost;127.0.0.1'
  });
  if (typeof browserSession.closeAllConnections === 'function') await browserSession.closeAllConnections();
}

module.exports = { PROXY_KEYS, readAccountProxy, normalizeProxyConfig, proxyRulesFor, sameCity, verifyHttpProxy, applyProxyToSession };
