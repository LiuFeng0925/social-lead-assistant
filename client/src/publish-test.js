'use strict';

// 发布笔记的第一阶段：只进入图文编辑器、上传一张本地测试图并填入测试文案。
// 绝不调用「发布」按钮；真实发布功能会在编辑器结构验证稳定后单独实现。

const fs = require('node:fs');
const path = require('node:path');

const CREATOR_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';
const TEST_TITLE = '1';
const TEST_BODY = '1\n#1';
// 使用项目已有的无敏感测试截图，避免下载外网图片或弹出本地文件选择窗口。
const TEST_IMAGE_PATH = path.join(__dirname, '..', 'tmp', 'current-xhs-screen.png');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function testAsset() {
  if (!fs.existsSync(TEST_IMAGE_PATH)) throw new Error('publish_test_image_missing');
  return TEST_IMAGE_PATH;
}

function editorProbeScript() {
  return `(() => {
    const text = String(document.body && document.body.innerText || '');
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const info = (el, i) => { const r = el.getBoundingClientRect(); return {
      i, tag: el.tagName, type: el.type || '', placeholder: el.getAttribute('placeholder') || '',
      name: el.getAttribute('name') || '', accept: el.getAttribute('accept') || '', aria: el.getAttribute('aria-label') || '',
      cls: String(el.className || '').slice(0, 180), text: String(el.innerText || el.value || '').slice(0, 120),
      visible: visible(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height)
    }; };
    const fields = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')]
      .filter(visible).map(info);
    const files = [...document.querySelectorAll('input[type="file"]')].map(info);
    return JSON.stringify({ url: location.href, title: document.title, fields, files, text: text.slice(0, 1800) });
  })()`;
}

function parseProbe(result) {
  try { return JSON.parse((result && result.value) || '{}'); } catch (e) { return {}; }
}

function hasImageUploadInput(probe) {
  return (probe && probe.files || []).some((field) => /image|jpg|jpeg|png|webp|gif/i.test(String(field.accept || '')));
}

function selectField(fields, kind) {
  const list = (fields || []).filter((field) => field && field.visible);
  const haystack = (field) => [field.placeholder, field.name, field.aria, field.cls, field.text].join(' ').toLowerCase();
  if (kind === 'title') {
    return list.find((field) => /标题|title/.test(haystack(field))) ||
      list.find((field) => field.tag === 'INPUT' && !/search|搜索/.test(haystack(field)));
  }
  return list.find((field) => field.tag === 'TEXTAREA') ||
    list.find((field) => /正文|内容|content|描述|description/.test(haystack(field))) ||
    list.find((field) => field.tag !== 'INPUT' && (field.h > 40 || /editor/.test(haystack(field))));
}

function imageModeProbeScript() {
  return `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
    const rows = [...document.querySelectorAll('button,a,[role="tab"],[role="button"],div,span')]
      .filter((el) => visible(el) && String(el.innerText || el.textContent || '').trim() === '上传图文')
      .map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), area: Math.round(r.width * r.height) }; })
      .filter((row) => row.area > 20).sort((a, b) => a.area - b.area);
    return JSON.stringify({ rows, text: String(document.body && document.body.innerText || '').slice(0, 1200) });
  })()`;
}

async function ensureImageMode({ client, target }) {
  let probe = parseProbe(await client.evaluate({ target, expression: editorProbeScript() }));
  if (hasImageUploadInput(probe) || /拖拽图片|上传图片|图片笔记/.test(String(probe.text || ''))) return;
  // 后台导航后页签偶尔会晚于页面骨架出现；最多等 5 秒再判定失败。
  // 创作后台的页签在部分窗口缩放下会有透明浮层，CDP 鼠标点击会被浮层吃掉。
  // 页签本身不是敏感写操作，直接触发它的页面事件再等待真实编辑器出现更稳定。
  let activated = false;
  for (let attempt = 0; attempt < 10 && !activated; attempt++) {
    const action = await client.evaluate({ target, expression: `(() => {
    const ok = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
    const tabs = [...document.querySelectorAll('.creator-tab')].filter((el) => ok(el) && !el.getAttribute('style') && String(el.innerText || el.textContent || '').trim() === '上传图文');
    const el = tabs[0]; if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
    })()` });
    activated = !!(action && action.value === true);
    if (!activated) await sleep(500);
  }
  if (!activated) throw new Error('publish_image_tab_not_found');
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    probe = parseProbe(await client.evaluate({ target, expression: editorProbeScript() }));
    if (hasImageUploadInput(probe) || /拖拽图片|上传图片|图片笔记/.test(String(probe.text || ''))) return;
  }
  throw new Error('publish_image_tab_not_ready');
}

async function waitForUploadInput({ client, target, timeoutMs = 10000 }) {
  const end = Date.now() + timeoutMs;
  let latest = {};
  while (Date.now() < end) {
    latest = parseProbe(await client.evaluate({ target, expression: editorProbeScript() }));
    if (hasImageUploadInput(latest)) return latest;
    await sleep(500);
  }
  return latest;
}

async function waitForEditor({ client, target, timeoutMs = 18000 }) {
  const end = Date.now() + timeoutMs;
  let latest = {};
  while (Date.now() < end) {
    latest = parseProbe(await client.evaluate({ target, expression: editorProbeScript() }));
    const title = selectField(latest.fields, 'title');
    const body = selectField(latest.fields, 'body');
    if (latest.files && latest.files.length && title && body) return { probe: latest, title, body };
    await sleep(700);
  }
  return { probe: latest, title: selectField(latest.fields, 'title'), body: selectField(latest.fields, 'body') };
}

async function uploadFirstFileInput({ client, target, filePath }) {
  await client.setFileInputFiles({ target, selector: 'input[type="file"]', files: [filePath] });
}

async function typeInto({ client, target, field, text }) {
  if (!field || !Number.isFinite(field.x) || !Number.isFinite(field.y)) throw new Error('publish_editor_field_not_found');
  await client.click({ target, x: field.x, y: field.y });
  await sleep(250);
  await client.selectAll({ target });
  await client.typeText({ target, text });
  await sleep(350);
}

async function runPublishTest({ client, target, onLog = () => {} }) {
  const imagePath = testAsset();
  onLog('发布测试：打开小红书图文编辑页…');
  await client.navigate({ target, url: CREATOR_PUBLISH_URL });
  await sleep(1800);
  const entryProbe = parseProbe(await client.evaluate({ target, expression: editorProbeScript() }));
  const pageText = String(entryProbe.text || '');
  if (/扫码登录|登录后|登录\s*注册/.test(pageText) && !(entryProbe.files || []).length) {
    return { ok: false, code: 'publish_login_required', msg: '第五个账号尚未登录创作后台，请在右侧完成扫码登录后再点一次测试。' };
  }
  onLog('发布测试：切换到「上传图文」…');
  await ensureImageMode({ client, target });
  const uploadProbe = await waitForUploadInput({ client, target });
  if (!(uploadProbe.files || []).length) return { ok: false, code: 'publish_upload_input_not_ready', msg: '已切换到图文发布，但尚未识别到图片上传框，请在右侧稍等页面加载后再试。' };
  onLog('发布测试：上传 1 张本地图片…');
  await uploadFirstFileInput({ client, target, filePath: imagePath });
  await sleep(1300);
  const ready = await waitForEditor({ client, target });
  if (!ready.title || !ready.body) return { ok: false, code: 'publish_editor_not_ready', msg: '图片已交给创作后台，但编辑字段仍未出现，请确认右侧图片上传完成后重试。' };
  onLog('发布测试：填写标题「1」…');
  await typeInto({ client, target, field: ready.title, text: TEST_TITLE });
  onLog('发布测试：填写正文「1」及话题「#1」…');
  await typeInto({ client, target, field: ready.body, text: TEST_BODY });
  const finalProbe = parseProbe(await client.evaluate({ target, expression: editorProbeScript() }));
  return {
    ok: true,
    msg: '测试素材已填入右侧图文编辑器：1 张图片、标题 1、正文 1、话题 #1。未点击发布。',
    imagePath,
    url: finalProbe.url || CREATOR_PUBLISH_URL
  };
}

module.exports = { CREATOR_PUBLISH_URL, TEST_TITLE, TEST_BODY, TEST_IMAGE_PATH, selectField, runPublishTest, editorProbeScript, imageModeProbeScript };
