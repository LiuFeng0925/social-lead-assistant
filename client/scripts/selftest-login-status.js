'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { LOGIN_STATUS_EXPR, parseLoginStatusValue } = require('../src/login-status');

function evalStatus({ state = {}, body = '', storage = {} }) {
  const context = {
    window: { __INITIAL_STATE__: state },
    document: { body: { innerText: body } },
    localStorage: { getItem: (key) => storage[key] || null }
  };
  return parseLoginStatusValue(vm.runInNewContext(LOGIN_STATUS_EXPR, context));
}

function run() {
  const logged = evalStatus({
    state: {
      user: {
        loggedIn: { value: true },
        userInfo: { value: { user_id: '58775a0aa9b2ed259ec7cc8e', nickname: '小刘学法' } }
      }
    },
    body: '全部 图文 视频 用户 筛选 首页 点点 直播 通知 我',
    storage: { RWP_LOGIN_TOKEN: 'x'.repeat(80) }
  });
  assert.equal(logged.loggedIn, true, 'detects current XHS logged-in userInfo.user_id shape');

  const tokenOnly = evalStatus({
    body: '全部 图文 视频 用户 筛选 首页 点点 直播 通知 我',
    storage: { RWP_LOGIN_TOKEN: 'x'.repeat(80) }
  });
  assert.equal(tokenOnly.loggedIn, true, 'uses RWP_LOGIN_TOKEN fallback when user store is not hydrated');

  const loginWall = evalStatus({
    state: { user: { loggedIn: { value: true }, userInfo: { value: { userId: 'u1' } } } },
    body: '登录后查看更多内容 扫码登录',
    storage: { RWP_LOGIN_TOKEN: 'x'.repeat(80) }
  });
  assert.equal(loginWall.loggedIn, false, 'login wall wins over stale user/token state');

  const loggedOut = evalStatus({
    body: '全部 图文 视频 用户 筛选',
    storage: {}
  });
  assert.equal(loggedOut.loggedIn, false, 'does not mark logged out anonymous page as logged in');
}

run();
console.log('login-status selftest passed');
