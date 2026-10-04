'use strict';

const CLEAR_BROWSER_CACHE_FLAG = '--clear-browser-cache';

// 仅清理可重新下载/生成的 HTTP 与 JS 编译缓存；登录态和业务记录不在本入口范围内。
// 必须在 app ready 后、任何 BrowserView 和任务服务启动前调用。
async function clearBrowserCachesOnRequest({ argv, session, accounts, log = console.log }) {
  if (!argv.includes(CLEAR_BROWSER_CACHE_FLAG)) return { requested: false };
  const results = [];
  for (const account of accounts) {
    const result = {
      accountId: account.id, beforeBytes: null, afterBytes: null,
      httpCleared: false, codeCleared: false, errors: []
    };
    let browserSession;
    try {
      browserSession = account.partition ? session.fromPartition(account.partition) : session.defaultSession;
    } catch (_) {
      result.errors.push('session_unavailable');
    }
    if (browserSession) {
      // 单项失败也继续尝试其余安全缓存操作；不输出可能含 URL、账号或凭据的原始异常。
      for (const [step, action] of [
        ['cache_size_before', async () => { result.beforeBytes = await browserSession.getCacheSize(); }],
        ['http_cache', async () => { await browserSession.clearCache(); result.httpCleared = true; }],
        ['code_cache', async () => { await browserSession.clearCodeCaches({}); result.codeCleared = true; }],
        ['cache_size_after', async () => { result.afterBytes = await browserSession.getCacheSize(); }]
      ]) {
        try { await action(); } catch (_) { result.errors.push(step); }
      }
    } else if (!result.errors.length) {
      result.errors.push('session_unavailable');
    }
    result.ok = result.errors.length === 0;
    results.push(result);
    log(`BROWSER_CACHE_MAINTENANCE_ACCOUNT ${JSON.stringify(result)}`);
  }
  const report = { requested: true, ok: results.every(result => result.ok), accounts: results };
  log(`BROWSER_CACHE_MAINTENANCE_COMPLETE ${JSON.stringify(report)}`);
  return report;
}

module.exports = { CLEAR_BROWSER_CACHE_FLAG, clearBrowserCachesOnRequest };
