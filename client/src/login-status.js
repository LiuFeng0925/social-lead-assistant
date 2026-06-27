'use strict';

const LOGIN_STATUS_EXPR = `(function(){
  function unwrap(v){
    var n = 0;
    while (v && typeof v === 'object' && n++ < 6) {
      if (Object.prototype.hasOwnProperty.call(v, 'value')) { v = v.value; continue; }
      if (Object.prototype.hasOwnProperty.call(v, '_value')) { v = v._value; continue; }
      if (Object.prototype.hasOwnProperty.call(v, '_rawValue')) { v = v._rawValue; continue; }
      break;
    }
    return v;
  }
  function storage(k){ try { return localStorage.getItem(k) || ''; } catch(e) { return ''; } }
  var s = window.__INITIAL_STATE__ || {};
  var user = unwrap(s.user) || {};
  var info = unwrap(user.userInfo) || unwrap(user.user_info) || unwrap(user.info) || {};
  var userId = info.userId || info.user_id || user.userId || user.user_id || '';
  var loggedFlag = unwrap(user.loggedIn) === true;
  var token = storage('RWP_LOGIN_TOKEN');
  var body = (document.body && document.body.innerText) || '';
  var loginWall = body.indexOf('登录后') >= 0 || body.indexOf('扫码登录') >= 0 || body.indexOf('验证码登录') >= 0;
  var loggedIn = !loginWall && (!!userId || loggedFlag || token.length > 20);
  return JSON.stringify({
    loggedIn: !!loggedIn,
    hasUserId: !!userId,
    loggedFlag: !!loggedFlag,
    hasToken: token.length > 20,
    loginWall: !!loginWall
  });
})()`;

function parseLoginStatusValue(value) {
  let data = {};
  try {
    data = typeof value === 'string' ? JSON.parse(value) : (value || {});
  } catch (e) {
    data = {};
  }
  return {
    loggedIn: !!data.loggedIn,
    hasUserId: !!data.hasUserId,
    loggedFlag: !!data.loggedFlag,
    hasToken: !!data.hasToken,
    loginWall: !!data.loginWall
  };
}

async function readLoginStatus(client, target) {
  const r = await client.evaluate({ target, expression: LOGIN_STATUS_EXPR });
  return parseLoginStatusValue(r && r.value);
}

module.exports = { LOGIN_STATUS_EXPR, parseLoginStatusValue, readLoginStatus };
