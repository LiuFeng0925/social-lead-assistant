'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('inbox basis context is collapsed after the reply content', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('<details class="basis-detail"><summary>查看依据</summary>'), 'basis is collapsed');
  assert.ok(html.indexOf('+ reply') < html.indexOf('+ basisDetail'), 'basis is appended after reply');
  assert.equal(html.includes('↩ 基于消息</div><div'), false);
});

test('left navigation is fixed while content scrolls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.match(html, /\.side\{[^}]*position:fixed[^}]*\}/, 'side menu should be fixed');
  assert.match(html, /\.main\{[^}]*margin-left:174px[^}]*\}/, 'main content should leave space for fixed menu');
});

test('task settings expose fixed outreach copy and clarify pending analysis count', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('id="outreach_fixed_text"'));
  assert.ok(html.includes('待分析笔记'));
  assert.equal(html.includes('<div class="l">待评论</div>'), false);
});

test('record pages expose compact date filters with custom seconds', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  for (const id of ['comments-filter', 'notes-filter', 'inbox-filter']) {
    assert.ok(html.includes('id="' + id + '"'), id + ' should exist');
  }
  for (const label of ['今日', '昨日', '近3日', '近7日', '自定义']) {
    assert.ok(html.includes(label), label + ' preset should exist');
  }
  assert.match(html, /type="datetime-local"[^>]*step="1"/, 'custom range should support seconds');
  assert.ok(html.includes('评论发送'), 'comment records should label send time');
  assert.ok(html.includes('用户互动'), 'inbox records should label user interaction time');
});

test('model settings are separated from task settings', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('data-p="modelsettings"'), 'left nav should expose model settings');
  assert.ok(html.includes('id="page-modelsettings"'), 'model settings page should exist');
  assert.ok(html.includes('saveModelSettings()'), 'model settings should save independently');

  const taskStart = html.indexOf('id="page-tasksettings"');
  const modelStart = html.indexOf('id="page-modelsettings"');
  const taskHtml = html.slice(taskStart, modelStart);
  assert.equal(taskHtml.includes('id="llm_enabled"'), false, 'task settings should not own llm switch');
  assert.equal(taskHtml.includes('id="llm_provider"'), false, 'task settings should not own provider');
});

test('task schedule is edited as time slots defaulting to every day', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('排班 · 时间段'), 'schedule copy should use time-slot wording');
  assert.ok(html.includes('class="sch-slot"'), 'schedule rows should be slots');
  assert.ok(html.includes('sch-days'), 'each slot should expose day selection');
  assert.ok(html.includes('每天'), 'default day scope should be every day');
  assert.ok(html.includes('不再另有隐藏的40篇上限'), 'schedule should explain that its note amount is no longer capped by a hidden value');
  assert.equal(html.includes('class="sch-day"'), false, 'old weekday-row editor should be removed');
});

test('reply rate limit controls pair labels with inputs inline', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(html.includes('class="limit-grid"'), 'reply limits should use a compact inline grid');
  assert.ok(html.includes('每日最多 <input id="r_daily"'), 'daily limit label should sit beside input');
  assert.ok(html.includes('每小时最多 <input id="r_hourly"'), 'hourly limit label should sit beside input');
  assert.ok(html.includes('回复间隔 <input id="r_gapmin"'), 'gap label should sit beside min input');
  assert.ok(html.includes('<input id="r_gapmax"'), 'gap max input should stay in the inline gap control');
  assert.ok(html.includes('<span class="unit">分钟</span>'), 'gap control should show minute unit inline');
  assert.ok(html.includes('每次承接最多 <input id="r_batch"'), 'batch limit should explain it is per accept run');
  assert.ok(html.includes('每 <input id="r_check"'), 'notification polling interval should be labelled inline');
  assert.equal(html.includes('间隔分钟(最小~最大)'), false, 'old stacked gap label should be gone');
});

test('lead model settings expose configurable note categories', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  assert.ok(html.includes('data-p="leadmodel"'), 'sidebar should expose lead model settings');
  assert.ok(html.includes('id="page-leadmodel"'), 'lead model page should exist');
  assert.ok(html.includes('id="lm_name"'), 'lead model name should be editable');
  assert.ok(html.includes('id="lm_categories"'), 'category editor container should exist');
  assert.ok(html.includes('class="lm-category"'), 'category rows should render with a stable class');
  assert.ok(html.includes('saveLeadModel'), 'lead model settings should be saved through UI');
  assert.ok(html.includes('笔记分类'), 'records and model settings should use note category wording');
  assert.equal(html.includes('<td>意向</td>'), false, 'records table should no longer label note category as intent');
});

test('lead model slots use a visual information-item editor instead of json', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  assert.ok(html.includes('要从笔记里识别的信息'), 'slot section should use user-facing wording');
  assert.ok(html.includes('id="lm_slots_editor"'), 'visual slot editor should exist');
  assert.ok(html.includes('class="lead-slot"'), 'slot rows should have a stable class');
  assert.ok(html.includes('addLeadSlot()'), 'users should be able to add an information item');
  assert.ok(html.includes('字段名(高级)'), 'technical key should be tucked into advanced settings');
  assert.match(html, /id="lm_slots"[^>]*type="hidden"/, 'raw slot json should be stored in a hidden field only');
  assert.equal(html.includes('槽位配置(JSON'), false, 'raw json label should be removed');
  assert.equal(html.includes('下一步会做成可视化'), false, 'temporary visualisation copy should be removed');
});

test('lead model page exposes an independent llm classification switch', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  assert.equal(html.includes('id="lm_goal"'), false, 'unused goal field should be removed from the visible config');
  assert.equal(html.includes('id="lm_prompt"'), false, 'unused llm fallback prompt should be removed from the visible config');
  assert.equal(html.includes('模型目标/要找的人'), false, 'goal wording should not appear until it is wired to behavior');
  assert.ok(html.includes('id="lm_llm_classification_enabled"'), 'lead model should have its own llm classification switch');
  assert.ok(html.includes('每篇笔记都会先打开并读取标题＋完整正文'), 'both classification modes should promise full-body reading');
  assert.ok(html.includes("llmClassificationEnabled: $('lm_llm_classification_enabled').checked"), 'the switch should be persisted in the lead model');
  assert.equal(html.includes('class="lm-advanced"'), false, 'advanced section should be removed while it has no active controls');
});

test('lead model page edits and saves service areas with the model', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  assert.ok(html.includes('id="lm_service_areas"'), 'service-area input should be visible in the lead model page');
  assert.ok(html.includes("setVal('lm_service_areas'"), 'saved service areas should load into the editor');
  assert.ok(html.includes("lead_local_words: serviceAreas"), 'saving the lead model should persist service areas');
  assert.ok(html.includes('关键词分类和大模型分类都会使用'), 'the UI should explain that both classifiers share the same areas');
});

test('lead model category wording explains deterministic rules', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  assert.ok(html.includes('命中关键词（任一命中即归类）'), 'keyword label should explain hard-match behavior');
  assert.ok(html.includes('排除关键词（命中则不归此类）'), 'exclude label should explain blocking behavior');
  assert.ok(html.includes('LLM 判断说明（开启大模型分类时使用）'), 'each category should expose an active llm prompt');
  assert.ok(html.includes('模型会同时看到标题和完整正文'), 'category prompt should explain its input context');
  assert.equal(html.includes('低置信兜底时使用'), false, 'old wording should not imply llm fallback is already active');
});

test('lead model comment strategy label has a hover explanation', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  assert.ok(html.includes('评论策略'), 'category reply strategy should be named comment strategy');
  assert.ok(html.includes('class="help-tip"'), 'comment strategy should expose a hover help tip');
  assert.ok(html.includes('系统能确定'), 'hover tip should show the reasoning process');
  assert.ok(html.includes('location = 望京'), 'hover tip should include the extracted location slot');
  assert.ok(html.includes('location_type = 商圈/区域'), 'hover tip should include location granularity');
  assert.ok(html.includes('预算: 未知'), 'hover tip should show missing budget');
  assert.ok(html.includes('房源库检索'), 'hover tip should explain listing retrieval');
  assert.ok(html.includes('不要直接说'), 'hover tip should explain what not to say');
  assert.equal(html.includes('该分类的回复策略'), false, 'old wording should be removed');
});

test('lead model category editor does not use author nickname rules', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  assert.equal(html.includes('作者关键词'), false, 'author keyword field should be removed');
  assert.equal(html.includes('lm-c-author'), false, 'author keyword input should not be rendered or saved');
});
