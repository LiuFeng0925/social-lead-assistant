'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

function chromeCandidates(env = process.env) {
  return [
    env.XHS_CHROME_BIN,
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
}

function findChrome(env = process.env) {
  return chromeCandidates(env).find((candidate) => fs.existsSync(candidate)) || null;
}

function buildChromeArgs({ port = 9222, profileDir, url = 'https://www.xiaohongshu.com/explore' }) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url
  ];
}

function endpointReady(endpoint) {
  const url = new URL('/json/version', endpoint);
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForEndpoint(endpoint, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointReady(endpoint)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function launchChromeForCdp({ endpoint, profileDir }) {
  if (process.platform !== 'win32') throw new Error('browser_not_running_run_npm_launch');
  const parsed = new URL(endpoint);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('browser_auto_launch_requires_local_endpoint');
  const chrome = findChrome();
  if (!chrome) throw new Error('chrome_not_found');
  const port = Number(parsed.port || 9222);
  const child = spawn(chrome, buildChromeArgs({ port, profileDir }), {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  if (!(await waitForEndpoint(endpoint))) throw new Error(`chrome_cdp_start_timeout:${port}`);
  return { chrome, port };
}

module.exports = { chromeCandidates, findChrome, buildChromeArgs, endpointReady, waitForEndpoint, launchChromeForCdp };
