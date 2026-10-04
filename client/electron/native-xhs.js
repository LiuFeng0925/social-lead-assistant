'use strict';

// 第 5 号完整控制台的原生执行端。搜索、读笔记和图片评论发生在 Mac 小红书
// App 中，配置、记录和统计仍使用第 5 号原有的独立本地服务与数据库。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const APP_PATH = '/Applications/rednote.app';
const PUBLISH_URL = 'xhsdiscover://post_new_note?source=control_widget';
const NATIVE_PROCESS_NAME = 'rednote';
const HELPER_SOURCE = path.join(__dirname, 'native-xhs-helper.swift');
const HELPER_BIN = path.join(__dirname, '..', 'tmp', 'native-xhs-helper');
const WINDOW_SHOT = path.join(__dirname, '..', 'tmp', 'native-xhs-window.png');
const MONITOR_SHOT = path.join(__dirname, '..', 'tmp', 'native-xhs-monitor.png');
const IMAGE_IDENTITY_UNVERIFIED = 'App 图片选择器未提供可核验的文件标识；没有选择缩略图，也没有附加或发送图片。';
let preparedCommentImage = null;

function status() {
  const installed = fs.existsSync(APP_PATH);
  return {
    ok: installed,
    installed,
    appPath: APP_PATH,
    message: installed ? '已识别到 Mac 小红书 App，账号 5 将使用原生获客模式。' : '未找到 Mac 小红书 App，请先安装后再使用原生获客模式。'
  };
}

async function activate() {
  const current = status();
  if (!current.installed) return current;
  await execFileAsync('open', ['-a', APP_PATH]);
  // App 已经在后台运行时，open -a 不一定把窗口置前；后续坐标点击前必须
  // 明确激活 discover 进程，否则点击会落到控制台或其他前台窗口。
  await execFileAsync('osascript', ['-e', 'tell application "System Events" to tell process "discover" to set frontmost to true'], { timeout: 8000 });
  await sleep(350);
  return { ok: true, installed: true, message: '已打开原生小红书 App。' };
}

async function openPublish() {
  const current = status();
  if (!current.installed) return current;
  await execFileAsync('open', ['-a', APP_PATH]);
  await execFileAsync('open', [PUBLISH_URL]);
  return { ok: true, installed: true, message: '已在原生小红书 App 打开图文发布页，请在 App 内选择图片并检查后发布。' };
}

async function goHome() {
  const current = await activate();
  if (!current.ok) return current;
  await sleep(500);
  await pressEscape().catch(optionalNativeResult());
  await closeCurrentNote().catch(optionalNativeResult());
  await returnToDiscover();
  return { ok: true, installed: true, message: '已回到原生小红书首页。' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeAppleScriptText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
}

async function appWindowBounds() {
  // 查询窗口不会自动打开/置前 App；用户最小化窗口时留给界面提示。
  return windowInfo();
}

async function clickAt(x, y) {
  const px = Math.round(Number(x)); const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('native_click_point_invalid');
  // 统一走发送事件前再次核验前台进程的 helper，不能点击用户切走后的窗口。
  await helper('click', ['0', `${px},${py}`]);
}

function nativeError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function normalizeNativeError(error) {
  if (error && (error.code === 78 || /native_app_not_frontmost/.test(String(error.stderr || error.message || '')))) {
    return nativeError('native_app_not_frontmost', error);
  }
  return error;
}

function optionalNativeResult(fallback) {
  return (error) => {
    const normalized = normalizeNativeError(error);
    // 找不到控件可以走备用定位，但焦点丢失必须立即上抛以暂停，不能继续尝试。
    if (normalized && normalized.code === 'native_app_not_frontmost') throw normalized;
    return fallback;
  };
}

async function assertForeground() {
  const state = JSON.parse(await helper('foreground'));
  if (!state.ok || state.frontmost !== true) throw nativeError('native_app_not_frontmost');
  return state;
}

const FOREGROUND_SCRIPT = `on requireNativeForeground()
tell application "System Events"
  if not (exists process "discover") then error "native_app_not_frontmost" number 78
  if not (frontmost of process "discover") then error "native_app_not_frontmost" number 78
end tell
end requireNativeForeground`;

async function runNativeInput(text, keyCommands) {
  await assertForeground();
  // 每次按键前检查焦点；保留原剪贴板，若用户期间复制了其他内容则不覆盖。
  const script = `${FOREGROUND_SCRIPT}
on restoreClipboard(previousClipboard, insertedText)
try
  if (the clipboard as text) is insertedText then set the clipboard to previousClipboard
end try
end restoreClipboard
on run argv
my requireNativeForeground()
set previousClipboard to the clipboard as record
set insertedText to (item 1 of argv as Unicode text)
try
  my requireNativeForeground()
  set the clipboard to insertedText
  tell application "System Events" to tell process "discover"
    ${keyCommands}
  end tell
  delay 0.2
  my restoreClipboard(previousClipboard, insertedText)
on error errorText number errorNumber
  my restoreClipboard(previousClipboard, insertedText)
  error errorText number errorNumber
end try
end run`;
  try {
    await execFileAsync('osascript', ['-e', script, '--', String(text || '')], { timeout: 8000 });
  } catch (error) { throw normalizeNativeError(error); }
}

async function typeAndSubmit(text) {
  await runNativeInput(text, `my requireNativeForeground()
    keystroke "a" using {command down}
    my requireNativeForeground()
    keystroke "v" using {command down}
    my requireNativeForeground()
    key code 36`);
}

async function pasteWithoutSubmit(text) {
  await runNativeInput(text, `my requireNativeForeground()
    keystroke "a" using {command down}
    my requireNativeForeground()
    key code 51
    repeat 100 times
      my requireNativeForeground()
      key code 51
    end repeat
    my requireNativeForeground()
    keystroke "v" using {command down}`);
}

async function pressEscape() {
  await assertForeground();
  const script = `${FOREGROUND_SCRIPT}
my requireNativeForeground()
tell application "System Events" to tell process "discover"
  my requireNativeForeground()
  key code 53
end tell`;
  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 8000 });
  } catch (error) { throw normalizeNativeError(error); }
}

async function returnToDiscover() {
  const box = await appWindowBounds();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const nodes = await accessibilitySnapshot().catch(() => []);
    const discover = nodes.find((node) => cleanText(node.text) === '发现');
    if (discover) {
      await helper('click', ['0', `${discover.x + discover.width / 2},${discover.y + discover.height / 2}`]);
      await sleep(650);
      return true;
    }
    const back = nodes.find((node) => cleanText(node.text) === 'navi back');
    if (back) {
      await helper('click', ['0', `${back.x + back.width / 2},${back.y + back.height / 2}`]);
    } else {
      await pressEscape().catch(optionalNativeResult());
      // 少量原生浮层没有辅助功能名称，用窗口左上角返回区逐层退出。
      if (attempt >= 2) await helper('click', ['0', `${box.x + 28},${box.y + 55}`]).catch(optionalNativeResult());
    }
    await sleep(500);
  }
  // 最后一轮“返回”可能刚好回到首页，退出循环前再确认一次。
  const finalNodes = await accessibilitySnapshot().catch(() => []);
  const finalDiscover = finalNodes.find((node) => cleanText(node.text) === '发现');
  if (finalDiscover) {
    await helper('click', ['0', `${finalDiscover.x + finalDiscover.width / 2},${finalDiscover.y + finalDiscover.height / 2}`]);
    await sleep(650);
    return true;
  }
  return false;
}

async function search(keyword) {
  const text = String(keyword || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!text) return { ok: false, message: '请先填写要测试的搜索词。' };
  await assertForeground();
  await sleep(900);
  // 先收起可能遗留的大图预览或评论草稿层。
  await pressEscape().catch(optionalNativeResult());
  await sleep(250);
  // 图片选择器、笔记详情或私信页可能叠了多层；先可靠回到「发现」。
  for (let attempt = 0; attempt < 3; attempt++) {
    const currentNodes = await accessibilitySnapshot().catch(() => []);
    const isPicker = currentNodes.some((node) => cleanText(node.text) === '多选');
    const isDetail = currentNodes.some((node) => /共\s*\d+\s*条评论|有话要说|听到你的声音|爱评论的人运气都不差/.test(cleanText(node.text)));
    if (!isPicker && !isDetail) break;
    await closeCurrentNote();
  }
  if (!await returnToDiscover()) throw new Error('native_discover_page_not_ready');
  const box = await appWindowBounds();
  const currentNodes = await accessibilitySnapshot().catch(() => []);
  const existingField = currentNodes.find((node) => node.role === 'AXTextArea' && node.y < box.y + 100 && node.width > 200);
  const searchEntry = currentNodes.filter((node) => node.role === 'AXStaticText'
    && node.x > box.x + 35 && node.x < box.x + box.width - 80 && node.y < box.y + 100
    && node.width >= 50 && node.height >= 10).sort((a, b) => a.y - b.y || b.width - a.width)[0];
  if (!existingField) {
    if (searchEntry) await helper('click', ['0', `${searchEntry.x + searchEntry.width / 2},${searchEntry.y + searchEntry.height / 2}`]);
    else await clickAt(box.x + box.width - Math.round(box.width * 0.09), box.y + Math.round(box.height * 0.085));
    await sleep(350);
  }
  const readyNodes = await accessibilitySnapshot().catch(() => []);
  const readyField = readyNodes.find((node) => node.role === 'AXTextArea' && node.y < box.y + 100 && node.width > 200);
  if (readyField) {
    await helper('click', ['0', `${readyField.x + Math.min(160, readyField.width / 2)},${readyField.y + readyField.height / 2}`]);
    await sleep(180);
  }
  // AXValue 只会改变文本外观，不会更新小红书内部搜索状态；必须真实粘贴并回车。
  await typeAndSubmit(text);
  await sleep(280);
  // Mac 版搜索框在部分页面会把回车解释为展开搜索建议，再点一次「搜索」才会提交。
  await pressText('搜索').catch(optionalNativeResult(false));
  await sleep(1500);
  return { ok: true, message: `已在原生 App 提交搜索：${text}。` };
}

async function ensureHelper() {
  fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
  const sourceTime = fs.statSync(HELPER_SOURCE).mtimeMs;
  const binaryTime = fs.existsSync(HELPER_BIN) ? fs.statSync(HELPER_BIN).mtimeMs : 0;
  if (binaryTime >= sourceTime) return HELPER_BIN;
  await execFileAsync('xcrun', ['swiftc', HELPER_SOURCE, '-o', HELPER_BIN], { timeout: 120000, maxBuffer: 1024 * 1024 });
  return HELPER_BIN;
}

async function nativePid() {
  const { stdout } = await execFileAsync('pgrep', ['-x', 'discover'], { timeout: 5000 });
  const pid = Number(String(stdout || '').trim().split(/\s+/)[0]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('native_app_not_running');
  return pid;
}

async function helper(command, args = [], options = {}) {
  const binary = await ensureHelper();
  try {
    const { stdout } = await execFileAsync(binary, [command, ...args.map(String)], {
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024
    });
    return String(stdout || '').trim();
  } catch (error) { throw normalizeNativeError(error); }
}

async function windowInfo(options = {}) {
  let lastError;
  const attempts = options.passive === true ? 1 : 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const box = JSON.parse(await helper('window', ['0']));
      if (!Number.isInteger(box.id) || box.id <= 0 || !Number.isFinite(box.x) || !Number.isFinite(box.y)
        || box.width < 500 || box.height < 400) throw nativeError('native_app_window_unavailable');
      return box;
    }
    catch (error) {
      lastError = error && error.code === 4 ? nativeError('native_app_window_unavailable', error) : error;
      if (attempt + 1 < attempts) await sleep(150);
    }
  }
  throw lastError || nativeError('native_app_window_unavailable');
}

async function accessibilitySnapshot() {
  const pid = await nativePid();
  return JSON.parse(await helper('snapshot', [pid]));
}

async function pressText(text) {
  const pid = await nativePid();
  return (await helper('press', [pid, String(text || '')])) === 'ok';
}

async function captureWindow(options = {}) {
  // 监控只是读窗口。最小化/关闭时返回不可用，绝不为了截图抢回焦点。
  const box = await windowInfo(options);
  const imagePath = options.passive === true ? MONITOR_SHOT : WINDOW_SHOT;
  await execFileAsync('screencapture', ['-x', '-l', String(box.id), imagePath], { timeout: 10000 });
  return { box, imagePath };
}

async function captureOcr() {
  const { box, imagePath } = await captureWindow();
  const rows = JSON.parse(await helper('ocr', [imagePath], { timeout: 60000 }));
  return { box, rows, imagePath };
}

function cleanText(value) {
  return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

function looksLikeCardTitle(node, box) {
  const text = cleanText(node && node.text);
  if (!text || node.role !== 'AXStaticText' || !Array.isArray(node.actions) || !node.actions.includes('AXPress')) return false;
  if (node.width < 70 || node.height < 15 || node.height > 55) return false;
  if (node.x < box.x || node.x > box.x + box.width || node.y < box.y + 120 || node.y > box.y + box.height - 25) return false;
  if (/^(推荐|RED|直播|世界杯|短剧|穿搭|美食|美甲|旅行|明星|手工|家居|搞笑|影视|母婴|游戏|减脂|动漫|汽车|情感|彩妆|绘画|音乐)$/.test(text)) return false;
  if (/^\d+(\.\d+)?[万wW]?$/.test(text) || /^(赞|广告|作者|回复|关注|发现|视频)$/.test(text)) return false;
  if (/^按住提问\s*有问必答$/.test(text)) return false;
  return true;
}

function visibleCards(nodes, box) {
  const titles = (nodes || []).filter((node) => looksLikeCardTitle(node, box));
  return titles.map((title) => {
    const author = (nodes || []).filter((node) => node.role === 'AXStaticText' && cleanText(node.text)
      && node !== title && Math.abs(node.x - title.x) < 36
      && node.y > title.y + title.height && node.y < title.y + title.height + 42
      && node.height <= 13).sort((a, b) => a.y - b.y)[0];
    return {
      title: cleanText(title.text), author: cleanText(author && author.text),
      x: title.x, y: title.y, width: title.width, height: title.height
    };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}

async function listVisibleCards() {
  const [nodes, box] = await Promise.all([accessibilitySnapshot(), windowInfo()]);
  const searchField = nodes.some((node) => node.role === 'AXTextArea' && node.y < box.y + 115 && node.width > 200);
  if (!searchField) return [];
  return visibleCards(nodes, box);
}

async function openCard(card) {
  if (!card || !card.title) throw new Error('native_note_card_missing');
  if (!await pressText(card.title)) {
    await helper('click', ['0', `${card.x + card.width / 2},${card.y + card.height / 2}`]);
  }
  await sleep(1400);
  const nodes = await accessibilitySnapshot();
  if (!nodes.some((node) => /有话要说|快来评论|爱评论的人运气都不差|共\s*\d+\s*条评论|评论\s*\d+/.test(cleanText(node.text)))) throw new Error('native_note_detail_not_ready');
  return true;
}

function extractNoteFromOcr(card, rows) {
  const uiWords = /^(小红书|立即关注|猜你想搜|不喜欢|作者|回复|置顶评论|发送|说点什么|有话要说|快来评论|展开\s*\d+\s*条回复|共\s*\d+\s*条评论)/;
  const imageText = (rows || []).filter((row) => row.x < 0.53 && row.y > 0.20 && row.y < 0.88)
    .map((row) => cleanText(row.text)).filter((text) => text && !uiWords.test(text));
  const captionText = (rows || []).filter((row) => row.x >= 0.53 && row.y >= 0.69 && row.y < 0.92)
    .map((row) => cleanText(row.text)).filter((text) => text && !uiWords.test(text) && !/^\d+天前/.test(text));
  const merged = [...captionText, ...imageText].filter((text, index, arr) => arr.indexOf(text) === index);
  const title = cleanText(card && card.title) || merged[0] || '无标题';
  return { title, author: cleanText(card && card.author), desc: merged.filter((text) => text !== title).join('\n'), imageText };
}

async function readCurrentNote(card) {
  const shot = await captureOcr();
  return Object.assign(extractNoteFromOcr(card, shot.rows), { screenshot: shot.imagePath });
}

async function composerVisible() {
  const shot = await captureOcr();
  return shot.rows.some((row) => cleanText(row.text) === '发送' && row.y < 0.34);
}

function imageFileIdentity(imagePath) {
  const supplied = String(imagePath || '').trim();
  if (!supplied || !fs.existsSync(supplied)) throw new Error('native_comment_image_missing');
  const imageFile = fs.realpathSync(path.resolve(supplied));
  const stat = fs.statSync(imageFile);
  if (!stat.isFile() || stat.size === 0) throw new Error('native_comment_image_invalid');
  return {
    imagePath: imageFile,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(imageFile)).digest('hex')
  };
}

async function prepareImage(imagePath) {
  // 每篇独立绑定文件内容，不能让上一条的图片或同路径被替换后的文件沿用核验结果。
  preparedCommentImage = null;
  const identity = imageFileIdentity(imagePath);
  preparedCommentImage = { ...identity, attached: false, verified: false };
  // 现有选择器只有匿名缩略图，导入 Photos 不代表「最近项目」首图就是本文件。
  // 尚无可靠选择方式时仅准备控制台的本地预览，不导入/污染系统照片图库。
  return identity.imagePath;
}

async function openCommentComposer() {
  if (await composerVisible()) return true;
  const nodes = await accessibilitySnapshot();
  if (nodes.some((node) => node.role === 'AXTextArea')) return true;
  const entry = nodes.find((node) => /有话要说|快来评论|听到你的声音|说点什么|留下你的想法|爱评论的人运气都不差/.test(cleanText(node.text)));
  if (!entry) throw new Error('native_comment_entry_not_found');
  // 新版 App 的评论入口虽然公开 AXPress，但执行该动作不会真正打开输入层，需要真实点击。
  for (let attempt = 0; attempt < 2; attempt++) {
    await helper('click', ['0', `${entry.x + entry.width / 2},${entry.y + entry.height / 2}`]);
    await sleep(650);
    const opened = await accessibilitySnapshot();
    if (opened.some((node) => node.role === 'AXTextArea') || await composerVisible()) return true;
  }
  throw new Error('native_comment_composer_not_ready');
}

async function fillComment(text) {
  const value = cleanText(text).slice(0, 80);
  if (!value) throw new Error('native_comment_empty');
  await openCommentComposer();
  const pid = await nativePid();
  const result = await helper('set-comment', [pid, value]).catch(optionalNativeResult('not_found'));
  if (result !== 'ok') await pasteWithoutSubmit(value);
  await sleep(500);
  if (!await composerVisible()) throw new Error('native_comment_fill_failed');
  return value;
}

async function attachImage(imagePath) {
  const current = imageFileIdentity(imagePath);
  if (!preparedCommentImage) throw new Error('native_comment_image_not_prepared');
  if (current.imagePath !== preparedCommentImage.imagePath) throw new Error('native_comment_image_does_not_match_prepared');
  if (current.sha256 !== preparedCommentImage.sha256) {
    preparedCommentImage = null;
    throw new Error('native_comment_image_changed');
  }
  // 禁止依据格子位置/导入时间猜选图库图片。当前 AX 层只有匿名图片格子，
  // 无法证明它对应本篇房源，所以不点击任何图片，交给控制台展示选图计划。
  return { ...current, verified: false, attached: false, reason: IMAGE_IDENTITY_UNVERIFIED };
}

async function sendPreparedComment() {
  // 防止其他调用入口绕过任务层检查，把旧草稿图或未验证的图片直接发出去。
  if (!preparedCommentImage || !preparedCommentImage.verified || !preparedCommentImage.attached) {
    throw new Error('native_comment_image_identity_unverified');
  }
  const current = imageFileIdentity(preparedCommentImage.imagePath);
  if (current.sha256 !== preparedCommentImage.sha256) {
    preparedCommentImage = null;
    throw new Error('native_comment_image_changed');
  }
  if (!await composerVisible()) throw new Error('native_comment_send_button_not_found');
  if (!await pressText('发送')) {
    const box = await windowInfo();
    await helper('click', ['0', `${box.x + box.width - 32},${box.y + box.height - 95}`]);
  }
  await sleep(1600);
  if (await composerVisible()) throw new Error('native_comment_send_unconfirmed');
  return true;
}

async function closeCurrentNote() {
  const box = await windowInfo();
  // 评论层、图片选择器和笔记详情可能同时叠加，逐层返回到搜索列表。
  for (let attempt = 0; attempt < 6; attempt++) {
    const nodes = await accessibilitySnapshot().catch(() => []);
    const picker = nodes.some((node) => cleanText(node.text) === '最近项目')
      && nodes.some((node) => /多选/.test(cleanText(node.text)));
    if (picker) {
      await pressText('取消多选').catch(optionalNativeResult(false));
      await sleep(200);
      await helper('click', ['0', `${box.x + 20},${box.y + 65}`]);
      await sleep(500);
      continue;
    }
    if (await composerVisible()) {
      await pressEscape();
      await sleep(500);
      continue;
    }
    const detail = nodes.some((node) => /共\s*\d+\s*条评论|评论\s*\d+|留下你的想法|有话要说|听到你的声音|爱评论的人运气都不差/.test(cleanText(node.text)));
    if (!detail) {
      const listOrSearch = visibleCards(nodes, box).length > 0
        || nodes.some((node) => node.role === 'AXTextArea' && node.y < box.y + 100 && node.width > 200);
      if (!listOrSearch && attempt === 0) {
        await pressEscape().catch(optionalNativeResult());
        await sleep(450);
        continue;
      }
      break;
    }
    await helper('click', ['0', `${box.x + 25},${box.y + 65}`]);
    await sleep(650);
  }
}

async function scrollList() {
  const box = await windowInfo();
  await helper('scroll', ['0', `${box.x + box.width / 2},${box.y + box.height * 0.72},-520`]);
  await sleep(700);
}

function securityReason(text) {
  const value = cleanText(text);
  if (/为了您的账号安全|安全验证|扫码验证|请退出应用重新操作|登录后继续/.test(value)) return value.match(/为了您的账号安全|安全验证|扫码验证|请退出应用重新操作|登录后继续/)[0];
  return '';
}

module.exports = {
  APP_PATH, PUBLISH_URL, HELPER_SOURCE, HELPER_BIN, status, activate, openPublish, goHome, search, returnToDiscover, appWindowBounds,
  ensureHelper, nativePid, windowInfo, assertForeground, accessibilitySnapshot, pressText, captureWindow, captureOcr, visibleCards,
  listVisibleCards, openCard, extractNoteFromOcr, readCurrentNote, openCommentComposer, fillComment,
  composerVisible, imageFileIdentity, prepareImage, attachImage, sendPreparedComment, closeCurrentNote, scrollList, securityReason
};
