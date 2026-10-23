'use strict';

const { safeXhsUrl, waitForPageReady, readLoginStatus } = require('./login-status');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeCommentText(value) {
  return String(value || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '').trim();
}

function visibilityProbeExpression({ userId, nickname, content }) {
  return `(${visibilityProbeFn.toString()})(${JSON.stringify(String(userId || ''))},${JSON.stringify(String(nickname || ''))},${JSON.stringify(String(content || ''))})`;
}

function visibilityProbeFn(expectedUserId, expectedNickname, expectedContent) {
  function norm(value) { return String(value || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '').trim(); }
  function visible(el) {
    if (!el || el.offsetParent === null) return false;
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < (innerHeight || 900) && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  }
  function profileId(href) {
    var m = String(href || '').match(/\/user\/profile\/([^?/#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  var wanted = norm(expectedContent), links = document.querySelectorAll('a[href*="/user/profile/"]');
  var rowsSeen = 0, identityRows = 0, samples = [];
  for (var i = 0; i < links.length; i++) {
    var link = links[i]; if (!visible(link)) continue;
    var id = profileId(link.getAttribute('href') || link.href || '');
    var nick = String(link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim();
    var identityMatches = !!expectedUserId && id === expectedUserId;
    var row = link.closest ? link.closest('.comment-item,[class*="comment-item"],[class*="commentItem"]') : null;
    if (!row) row = link.parentElement;
    if (!row || !visible(row)) continue;
    rowsSeen++;
    var text = norm(row.innerText || row.textContent || '');
    if (identityMatches) {
      identityRows++;
      if (samples.length < 3) samples.push({ id: id, nickname: nick, text: String(row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180) });
      if (wanted && text.indexOf(wanted) >= 0) return JSON.stringify({ found: true, rowsSeen: rowsSeen, identityRows: identityRows, matchedUserId: id, matchedNickname: nick });
    }
  }
  return JSON.stringify({ found: false, rowsSeen: rowsSeen, identityRows: identityRows, samples: samples });
}

async function verifyCommentVisibility({ client, target, noteUrl, userId, nickname, content, maxScrolls = 12, onLog = () => {} }) {
  const url = safeXhsUrl(noteUrl);
  if (!url) return { status: 'error', reason: '笔记链接无效' };
  if (!String(userId || '').trim()) return { status: 'error', reason: '没有读取到发布账号的小红书 ID' };
  if (!normalizeCommentText(content)) return { status: 'error', reason: '评论内容为空' };
  let originalUrl = '';
  try { originalUrl = safeXhsUrl(String((await client.evaluate({ target, expression: 'location.href' })).value || '')); } catch (_) {}
  let maxRows = 0, identityRows = 0;
  try {
    await client.navigate({ target, url });
    await waitForPageReady(client, target, 12000);
    await sleep(1300);
    const access = await readLoginStatus(client, target).catch(() => null);
    if (access && access.securityWall) return { status: 'error', reason: '抽检账号遇到安全验证，已停止抽检' };
    const expression = visibilityProbeExpression({ userId, nickname, content });
    for (let round = 0; round <= Math.max(0, Number(maxScrolls) || 0); round++) {
      let result = {};
      try { result = JSON.parse(String((await client.evaluate({ target, expression })).value || '{}')); } catch (_) {}
      maxRows = Math.max(maxRows, Number(result.rowsSeen) || 0);
      identityRows = Math.max(identityRows, Number(result.identityRows) || 0);
      if (result.found) return {
        status: 'visible',
        reason: `已找到账号身份和评论正文（第 ${round + 1} 屏）`,
        rowsSeen: maxRows,
        matchedUserId: result.matchedUserId || '',
        matchedNickname: result.matchedNickname || ''
      };
      if (round >= maxScrolls) break;
      onLog(`抽检评论区第 ${round + 1}/${maxScrolls + 1} 屏`);
      if (client.humanMove) await client.humanMove({ target, toX: 2, toY: 2 }).catch(() => {});
      await client.wheelScroll({ target, x: 720, y: 650, totalDeltaY: 780 }).catch(() => {});
      await sleep(850);
    }
    return {
      status: 'not_found',
      reason: identityRows
        ? `找到发布账号，但未匹配到这条评论正文；已读取约 ${maxRows} 条可见评论`
        : `未找到发布账号及评论正文；已读取约 ${maxRows} 条可见评论`,
      rowsSeen: maxRows
    };
  } catch (error) {
    return { status: 'error', reason: String(error && error.message || error || '抽检失败').slice(0, 300) };
  } finally {
    if (originalUrl && originalUrl !== url) {
      await client.navigate({ target, url: originalUrl }).catch(() => {});
    }
  }
}

function balancedSample(groups, limit, random = Math.random) {
  const queues = (groups || []).map((group) => ({
    accountId: Number(group.accountId),
    items: (group.items || []).slice().sort(() => random() - 0.5)
  })).filter((group) => group.items.length);
  const result = [];
  while (queues.length && result.length < Math.max(1, Number(limit) || 1)) {
    for (let index = queues.length - 1; index >= 0 && result.length < limit; index--) {
      const group = queues[index];
      const item = group.items.pop();
      if (item) result.push({ ...item, accountId: group.accountId });
      if (!group.items.length) queues.splice(index, 1);
    }
  }
  return result;
}

module.exports = { normalizeCommentText, visibilityProbeExpression, verifyCommentVisibility, balancedSample, visibilityProbeFn };
