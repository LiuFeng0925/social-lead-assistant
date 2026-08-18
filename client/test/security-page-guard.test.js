'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine');

test('security page guard stops search work on a captcha route', async () => {
  const client = {
    async evaluate() {
      return { value: JSON.stringify({ url: 'https://www.xiaohongshu.com/website-login/captcha?verifyType=124', title: '安全验证' }) };
    }
  };
  await assert.rejects(
    engine.assertNoAccountSecurityPage({ client, target: {} }),
    (error) => engine.isAccountSecurityError(error) && error.code === 'ACCOUNT_SECURITY_BLOCK'
  );
});

test('security page guard allows normal Xiaohongshu pages', async () => {
  const client = {
    async evaluate() {
      return { value: JSON.stringify({ url: 'https://www.xiaohongshu.com/search_result?keyword=test', title: '小红书' }) };
    }
  };
  const page = await engine.assertNoAccountSecurityPage({ client, target: {} });
  assert.match(page.url, /search_result/);
});

test('security page guard stops on account error 300011', async () => {
  const client = {
    async evaluate() {
      return { value: JSON.stringify({ url: 'https://www.xiaohongshu.com/website-login/error?error_code=300011', title: '安全限制' }) };
    }
  };
  await assert.rejects(
    engine.assertNoAccountSecurityPage({ client, target: {} }),
    (error) => engine.isAccountSecurityError(error)
  );
});

test('only account error pages can use automatic return-home recovery', () => {
  assert.equal(engine.canReturnHomeFromSecurityPage('https://www.xiaohongshu.com/website-login/error?error_code=300011'), true);
  assert.equal(engine.canReturnHomeFromSecurityPage('https://www.xiaohongshu.com/website-login/captcha?verifyType=124'), false);
  assert.equal(engine.canReturnHomeFromSecurityPage('https://evil.example/website-login/error'), false);
  assert.equal(engine.canReturnHomeFromSecurityPage('https://evilxiaohongshu.com/website-login/error'), false);
});
