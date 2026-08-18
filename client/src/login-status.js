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
  function visible(el){
    if(!el) return false;
    var r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>80&&r.height>40&&r.bottom>0&&r.right>0&&r.top<(window.innerHeight||900)&&r.left<(window.innerWidth||1400)&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0;
  }
  function clean(v){ return String(v||'').replace(/\\s+/g,' ').trim(); }
  var s = window.__INITIAL_STATE__ || {};
  var user = unwrap(s.user) || {};
  var info = unwrap(user.userInfo) || unwrap(user.user_info) || unwrap(user.info) || {};
  var userId = info.userId || info.user_id || user.userId || user.user_id || '';
  var loggedFlag = unwrap(user.loggedIn) === true;
  var token = storage('RWP_LOGIN_TOKEN');
  var body = clean(document.body && document.body.innerText);
  var selectors='[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="Modal"],[class*="login"],[class*="Login"],[class*="verify"],[class*="Verify"],[class*="security"],[class*="Security"],[class*="risk"],[class*="Risk"]';
  var nodes=[]; try{nodes=[].slice.call(document.querySelectorAll(selectors));}catch(e){}
  var wallParts=[];
  for(var i=0;i<nodes.length;i++){
    if(!visible(nodes[i]))continue;
    var text=clean(nodes[i].innerText||nodes[i].textContent);
    if(text&&wallParts.indexOf(text)<0)wallParts.push(text.slice(0,800));
  }
  var wallText=wallParts.join(' | ');
  var pageUrl=String(location.href||'');
  var pageTitle=clean(document.title||'');
  var securityRoute=false;
  try{securityRoute=/\\/(?:website-login\\/(?:captcha|error)|captcha|security|verify)(?:\\/|$)/i.test(new URL(pageUrl).pathname);}catch(e){}
  var normalPageNodes=0;
  try{normalPageNodes=document.querySelectorAll('a[href*="/explore/"],a[href*="/user/profile"],.note-detail-mask,.engage-bar').length;}catch(e){}
  var shortPage=body.length>0&&body.length<1800&&normalPageNodes===0?body:'';
  var blockingText=wallText||shortPage;
  var hardPatterns=[
    '为了您的账号安全','为了您的账户安全','请退出程序','账号异常','账户异常','账号存在异常','账户存在异常','安全验证','安全限制',
    '操作频繁','访问频繁','环境异常','设备异常','风险提示','存在风险','暂时无法操作'
  ];
  var hardReason=securityRoute?'账号安全限制页面':(/安全(?:验证|限制)/.test(pageTitle)?'账号安全限制页面':'');
  for(var j=0;!hardReason&&j<hardPatterns.length;j++){if(blockingText.indexOf(hardPatterns[j])>=0){hardReason=hardPatterns[j];break;}}
  var loginPatterns=['登录后','扫码登录','验证码登录','请先登录','手机号登录','登录小红书'];
  var loginWall=false;
  for(var k=0;k<loginPatterns.length;k++){if(blockingText.indexOf(loginPatterns[k])>=0){loginWall=true;break;}}
  var sessionEvidence=!!userId||loggedFlag||token.length>20;
  var securityWall=!!hardReason;
  var loggedIn=sessionEvidence&&!loginWall&&!securityWall;
  return JSON.stringify({
    loggedIn:!!loggedIn,
    sessionEvidence:!!sessionEvidence,
    hasUserId:!!userId,
    loggedFlag:!!loggedFlag,
    hasToken:token.length>20,
    loginWall:!!loginWall,
    securityWall:!!securityWall,
    wallReason:hardReason||(loginWall?'登录/扫码提示':''),
    wallText:wallText.slice(0,240),
    url:pageUrl,
    title:pageTitle
  });
})()`;

function pageSecurityReason({ url = '', title = '' } = {}) {
  let pathname = '';
  try { pathname = new URL(String(url || '')).pathname; } catch (e) {}
  if (/\/(?:website-login\/(?:captcha|error)|captcha|security|verify)(?:\/|$)/i.test(pathname)) return '账号安全限制页面';
  if (/安全(?:验证|限制)/.test(String(title || ''))) return '账号安全限制页面';
  return '';
}

function parseLoginStatusValue(value) {
  let data = {};
  try {
    data = typeof value === 'string' ? JSON.parse(value) : (value || {});
  } catch (e) {
    data = {};
  }
  const pageReason = pageSecurityReason(data);
  const securityWall = !!data.securityWall || !!pageReason;
  return {
    loggedIn: !!data.loggedIn && !securityWall,
    sessionEvidence: !!(data.sessionEvidence || data.hasUserId || data.loggedFlag || data.hasToken),
    hasUserId: !!data.hasUserId,
    loggedFlag: !!data.loggedFlag,
    hasToken: !!data.hasToken,
    loginWall: !!data.loginWall,
    securityWall,
    wallReason: String(data.wallReason || pageReason || ''),
    wallText: String(data.wallText || ''),
    url: String(data.url || ''),
    title: String(data.title || '')
  };
}

async function readLoginStatus(client, target) {
  const r = await client.evaluate({ target, expression: LOGIN_STATUS_EXPR });
  return parseLoginStatusValue(r && r.value);
}

async function waitForPageReady(client, target, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const r = await client.evaluate({ target, expression: 'document.readyState' });
      if (r && r.value === 'complete') return true;
    } catch (e) {}
  }
  return false;
}

function safeXhsUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' && (u.hostname === 'xiaohongshu.com' || u.hostname.endsWith('.xiaohongshu.com')) ? u.toString() : '';
  } catch (e) {
    return '';
  }
}

// 只做温和恢复：Esc 关普通浮层，再受控返回原页/刷新一次。
// 真正的账号安全限制绝不尝试绕过；软登录浮层则可交给精确的输入框写入验证。
async function recoverInteractiveAccess({ client, target, onLog = () => {} }) {
  let initial;
  try { initial = await readLoginStatus(client, target); }
  catch (e) { return { ok: false, allowWriteProbe: true, reason: '登录状态读取失败，改用目标输入框校验' }; }
  if (initial.loggedIn) return { ok: true, recovered: false, status: initial };
  if (initial.securityWall) {
    return { ok: false, hardBlocked: true, allowWriteProbe: false, status: initial, reason: '账号安全限制：' + (initial.wallReason || '需要人工验证') };
  }

  onLog('检测到登录/扫码浮层，先尝试关闭普通浮层');
  if (client.pressKey) await client.pressKey({ target, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 650));
  let afterEscape = initial;
  try { afterEscape = await readLoginStatus(client, target); } catch (e) {}
  if (afterEscape.loggedIn) {
    onLog('浮层已关闭，登录态仍有效');
    return { ok: true, recovered: true, action: 'escape', status: afterEscape };
  }
  if (afterEscape.securityWall) {
    return { ok: false, hardBlocked: true, allowWriteProbe: false, status: afterEscape, reason: '账号安全限制：' + (afterEscape.wallReason || '需要人工验证') };
  }

  const originalUrl = safeXhsUrl(initial.url);
  const currentUrl = safeXhsUrl(afterEscape.url);
  try {
    if (originalUrl && currentUrl && originalUrl !== currentUrl) {
      onLog('页面被带离原位置，受控返回原页一次');
      await client.navigate({ target, url: originalUrl });
    } else {
      onLog('浮层仍在，单次刷新页面恢复会话');
      await client.sendCommand({ target, method: 'Page.reload', params: { ignoreCache: false } });
    }
    await waitForPageReady(client, target);
    await new Promise((resolve) => setTimeout(resolve, 900));
  } catch (e) {}

  let afterReload = afterEscape;
  try { afterReload = await readLoginStatus(client, target); } catch (e) {}
  if (afterReload.loggedIn) {
    onLog('页面恢复成功，可继续操作');
    return { ok: true, recovered: true, action: 'reload', status: afterReload };
  }
  if (afterReload.securityWall) {
    return { ok: false, hardBlocked: true, allowWriteProbe: false, status: afterReload, reason: '账号安全限制：' + (afterReload.wallReason || '需要人工验证') };
  }
  return {
    ok: false,
    hardBlocked: false,
    allowWriteProbe: !!afterReload.sessionEvidence,
    status: afterReload,
    reason: afterReload.sessionEvidence
      ? '登录状态仍不确定，但会话凭据还在，允许对精确目标输入框做写入校验'
      : '没有检测到有效会话，需要人工扫码登录'
  };
}

module.exports = {
  LOGIN_STATUS_EXPR,
  parseLoginStatusValue,
  readLoginStatus,
  recoverInteractiveAccess,
  pageSecurityReason,
  safeXhsUrl,
  waitForPageReady
};
