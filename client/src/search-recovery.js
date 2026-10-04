'use strict';

const { readLoginStatus } = require('./login-status');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RECOVERABLE = new Set(['search_input_not_found', 'search_input_not_focused', 'search_keyword_not_entered', 'search_submit_button_not_found']);

function checkSearchStopped(shouldStop = () => false) {
  if (!shouldStop()) return;
  const error = new Error('search_cancelled');
  error.code = 'SEARCH_CANCELLED';
  throw error;
}

async function waitForSearch(ms, shouldStop = () => false, wait = sleep) {
  checkSearchStopped(shouldStop);
  for (let remaining = ms; remaining > 0; remaining -= 250) {
    await wait(Math.min(remaining, 250));
    checkSearchStopped(shouldStop);
  }
}

function searchRecoveryError(reason, cause) {
  const error = new Error('search_recovery_failed:' + reason, { cause });
  error.code = 'SEARCH_RECOVERY_FAILED';
  error.userMessage = reason;
  return error;
}

function isSearchRecoveryError(error) {
  return !!error && error.code === 'SEARCH_RECOVERY_FAILED';
}

function isRecoverableSearchError(error) {
  return !!error && (error.code === 'SEARCH_PAGE_MISMATCH' || RECOVERABLE.has(error.message));
}

function homeRetryLimit(value) {
  if (value == null || value === '') return 1;
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.min(2, Math.floor(count))) : 1;
}

function isXhsPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'www.xiaohongshu.com' || url.hostname === 'xiaohongshu.com');
  } catch (_) { return false; }
}

function isXhsHome(value) {
  if (!isXhsPage(value)) return false;
  return /^\/(?:explore\/?)?$/.test(new URL(value).pathname);
}

// Read visible login/security walls, not just the URL. Never dismiss or refresh
// a verification prompt as part of automatic search recovery.
async function assertSearchRecoveryAccess({ client, target, shouldStop }) {
  checkSearchStopped(shouldStop);
  const status = await readLoginStatus(client, target);
  checkSearchStopped(shouldStop);
  if (status.securityWall || status.loginWall) {
    const error = new Error('account_security_block:' + (status.wallReason || '需要人工登录/验证'));
    error.code = 'ACCOUNT_SECURITY_BLOCK';
    error.userMessage = status.wallReason || '需要人工登录/验证';
    throw error;
  }
  if (!isXhsPage(status.url)) throw searchRecoveryError('当前页面无法确认，未自动返回首页');
  return status;
}

const SEARCH_HOME_PROBE = `(function(){
  var anchors=document.querySelectorAll('a[href]');
  for(var i=0;i<anchors.length;i++){
    var el=anchors[i],u;try{u=new URL(el.href,location.href);}catch(e){continue;}
    if(u.origin!==location.origin||!/^\\/(?:explore\\/?)?$/.test(u.pathname))continue;
    var text=String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,'').trim();
    if(!/^(首页|发现|返回首页)$/.test(text))continue;
    var r=el.getBoundingClientRect(),s=getComputedStyle(el);
    if(r.width<24||r.height<24||r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth||s.visibility==='hidden'||s.display==='none'||Number(s.opacity||1)<0.1)continue;
    var x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),safe=true;
    // The driver's small coordinate variation must still land on this anchor.
    for(var dx=-6;dx<=6;dx+=6)for(var dy=-6;dy<=6;dy+=6){var hit=document.elementFromPoint(x+dx,y+dy);if(!hit||!el.contains(hit))safe=false;}
    if(safe)return JSON.stringify({x:x,y:y});
  }
  return '';
})()`;

async function returnHomeForSearch({ client, target, onLog = () => {}, shouldStop = () => false, wait = sleep }) {
  await assertSearchRecoveryAccess({ client, target, shouldStop });
  const result = await client.evaluate({ target, expression: SEARCH_HOME_PROBE });
  let point;
  try { point = JSON.parse(result && result.value || ''); } catch (_) {}
  // Recheck after locating the control, before any navigation/input action.
  await assertSearchRecoveryAccess({ client, target, shouldStop });
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    onLog('搜索恢复：点击当前账号页面的“首页/发现”');
    checkSearchStopped(shouldStop);
    await client.click({ target, x: point.x, y: point.y });
  } else {
    onLog('搜索恢复：首页按钮不可用，在当前账号页面打开小红书首页');
    checkSearchStopped(shouldStop);
    await client.navigate({ target, url: 'https://www.xiaohongshu.com/explore' });
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await waitForSearch(500, shouldStop, wait);
    let status;
    try { status = await assertSearchRecoveryAccess({ client, target, shouldStop }); }
    catch (error) {
      if (error.code === 'ACCOUNT_SECURITY_BLOCK' || error.code === 'SEARCH_CANCELLED' || isSearchRecoveryError(error)) throw error;
      continue; // A navigating document may briefly have no execution context.
    }
    const ready = await client.evaluate({ target, expression: 'document.readyState' }).catch(() => null);
    if (isXhsHome(status.url) && ready && ready.value === 'complete') {
      onLog('搜索恢复：首页已就绪，重新输入原关键词并应用原筛选条件');
      return;
    }
  }
  throw searchRecoveryError('返回首页未成功，保留当前页面供检查');
}

// Retry the complete scan in a fresh local result buffer. The caller receives
// results only after a successful attempt, so failed pages never enter stats.
async function withSearchRecovery({ scan, returnHome, maxHomeRetries = 1, onLog = () => {}, shouldStop = () => false }) {
  const limit = homeRetryLimit(maxHomeRetries);
  let retries = 0;
  while (true) {
    try {
      checkSearchStopped(shouldStop);
      const notes = await scan();
      checkSearchStopped(shouldStop);
      if (retries) onLog('✓ 搜索恢复成功，继续当前关键词；历史统计和已回复记录保留');
      return notes;
    } catch (error) {
      if (shouldStop() || error.code === 'SEARCH_CANCELLED') return [];
      if (!isRecoverableSearchError(error)) throw error;
      const reason = error.code === 'SEARCH_PAGE_MISMATCH' ? '搜索页未加载完成或关键词不匹配' : ({
        search_input_not_found: '未找到可操作的搜索框', search_input_not_focused: '搜索框未获得输入焦点', search_keyword_not_entered: '搜索词未成功输入',
        search_submit_button_not_found: '未找到搜索按钮'
      })[error.message];
      if (retries >= limit) throw searchRecoveryError(`${reason}；${limit ? '返回首页重试已达上限（' + limit + '次）' : '自动恢复已关闭'}，任务暂停`, error);
      retries++;
      onLog(`⚠ ${reason}；自动返回首页重搜 ${retries}/${limit}，不采集异常页面`);
      try {
        checkSearchStopped(shouldStop);
        await returnHome();
      } catch (homeError) {
        if (shouldStop() || homeError.code === 'SEARCH_CANCELLED') return [];
        if (homeError.code === 'ACCOUNT_SECURITY_BLOCK' || isSearchRecoveryError(homeError)) throw homeError;
        throw searchRecoveryError('返回首页失败，任务暂停', homeError);
      }
    }
  }
}

module.exports = { withSearchRecovery, returnHomeForSearch, isSearchRecoveryError, homeRetryLimit,
  checkSearchStopped, waitForSearch, assertSearchRecoveryAccess, SEARCH_HOME_PROBE, isXhsHome };
