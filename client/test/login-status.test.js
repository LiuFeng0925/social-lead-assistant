'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOGIN_STATUS_EXPR,
  pageSecurityReason,
  parseLoginStatusValue,
  recoverInteractiveAccess,
  safeXhsUrl
} = require('../src/login-status');

test('parseLoginStatusValue keeps soft login wall separate from hard security wall', () => {
  const parsed = parseLoginStatusValue(JSON.stringify({
    loggedIn: false,
    hasToken: true,
    loginWall: true,
    securityWall: false,
    wallReason: '登录/扫码提示'
  }));
  assert.equal(parsed.loggedIn, false);
  assert.equal(parsed.sessionEvidence, true);
  assert.equal(parsed.loginWall, true);
  assert.equal(parsed.securityWall, false);
});

test('safeXhsUrl only accepts https Xiaohongshu pages', () => {
  assert.equal(safeXhsUrl('https://www.xiaohongshu.com/notification'), 'https://www.xiaohongshu.com/notification');
  assert.equal(safeXhsUrl('https://evil.example/?next=xiaohongshu.com'), '');
  assert.equal(safeXhsUrl('javascript:alert(1)'), '');
});

test('captcha route is always treated as a hard security wall even when a token remains', () => {
  const url = 'https://www.xiaohongshu.com/website-login/captcha?redirectPath=%2Fsearch_result';
  assert.equal(pageSecurityReason({ url, title: '安全验证' }), '账号安全限制页面');
  const parsed = parseLoginStatusValue({ loggedIn: true, hasToken: true, url, title: '安全验证' });
  assert.equal(parsed.loggedIn, false);
  assert.equal(parsed.securityWall, true);
  assert.equal(parsed.wallReason, '账号安全限制页面');
});

test('website-login error 300011 is treated as a hard account restriction', () => {
  const url = 'https://www.xiaohongshu.com/website-login/error?error_code=300011&error_msg=account';
  const parsed = parseLoginStatusValue({ loggedIn: true, hasToken: true, url, title: '安全限制' });
  assert.equal(parsed.loggedIn, false);
  assert.equal(parsed.securityWall, true);
  assert.equal(parsed.wallReason, '账号安全限制页面');
});

test('recoverInteractiveAccess never tries to bypass a hard account security wall', async () => {
  let presses = 0;
  let commands = 0;
  const client = {
    async evaluate({ expression }) {
      assert.equal(expression, LOGIN_STATUS_EXPR);
      return { value: JSON.stringify({ loggedIn: false, hasToken: true, securityWall: true, wallReason: '安全验证' }) };
    },
    async pressKey() { presses++; },
    async sendCommand() { commands++; }
  };
  const result = await recoverInteractiveAccess({ client, target: {} });
  assert.equal(result.ok, false);
  assert.equal(result.hardBlocked, true);
  assert.equal(result.allowWriteProbe, false);
  assert.equal(presses, 0);
  assert.equal(commands, 0);
});

test('recoverInteractiveAccess closes a soft login overlay before allowing writes', async () => {
  let statusReads = 0;
  let presses = 0;
  const client = {
    async evaluate({ expression }) {
      if (expression !== LOGIN_STATUS_EXPR) return { value: 'complete' };
      statusReads++;
      if (statusReads === 1) return { value: JSON.stringify({ loggedIn: false, hasToken: true, loginWall: true, url: 'https://www.xiaohongshu.com/notification' }) };
      return { value: JSON.stringify({ loggedIn: true, hasToken: true, url: 'https://www.xiaohongshu.com/notification' }) };
    },
    async pressKey() { presses++; }
  };
  const result = await recoverInteractiveAccess({ client, target: {} });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.action, 'escape');
  assert.equal(presses, 1);
});

test('recoverInteractiveAccess does not write-probe when the session is really logged out', async () => {
  let statusReads = 0;
  const client = {
    async evaluate({ expression }) {
      if (expression !== LOGIN_STATUS_EXPR) return { value: 'complete' };
      statusReads++;
      return { value: JSON.stringify({ loggedIn: false, loginWall: true, url: 'https://www.xiaohongshu.com/notification' }) };
    },
    async pressKey() {},
    async sendCommand() {}
  };
  const result = await recoverInteractiveAccess({ client, target: {} });
  assert.equal(result.ok, false);
  assert.equal(result.allowWriteProbe, false);
  assert.match(result.reason, /扫码登录/);
  assert.ok(statusReads >= 3);
});
