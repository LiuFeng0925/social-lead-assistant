'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeXhsTask } = require('../electron/native-xhs-task');
const { buildReplyPlan, groundedComment, saveReplyPlan } = require('../src/native-reply-plan');
const { DatabaseSync } = require('node:sqlite');

const demand = { city: '石家庄', district: '桥西区', locations: ['测试小区'], budgetMax: 1800, budgetMin: null, bedrooms: [2] };
const property = { id: 'fixture-a', title: '测试房源', city: '石家庄', district: '桥西区', locations: ['测试小区'], rent: 1600, bedrooms: 2, rentalType: 'entire' };
const decision = { eligible: true, categoryName: '求租笔记', locationMatch: 'match', rentalDemand: demand, reason: '明确住宅长租需求' };
const match = { status: 'matched', reason: '明确需求匹配', property, imagePath: '/test/property-a.png', matchReasons: ['地区匹配', '预算匹配'] };

test('reply generation happens only after a matching property and uses its facts', async () => {
  let received;
  const plan = await buildReplyPlan({ decision, catalogPath: '/test/catalog.json', select: async args => { received = args; return match; } });
  assert.deepEqual(received.demand, demand);
  assert.match(plan.comment, /测试小区2室整租，1600元\/月/);
  assert.equal(plan.imagePath, match.imagePath);
  assert.doesNotMatch(plan.comment, /特别适合|几套|拎包/);
});

test('missing budget and bedrooms are questions, not inferred matching claims', () => {
  assert.match(groundedComment(property, {}), /你的预算和户型要求是/);
});

test('gallery failure and no match never fall back to fixed images/text', async () => {
  for (const status of ['no_match', 'needs_more_info', 'not_configured', 'failed']) {
    const plan = await buildReplyPlan({ decision, select: async () => ({ status, reason: status }) });
    assert.equal(plan.status, status);
    assert.equal(plan.comment, undefined);
    assert.equal(plan.imagePath, undefined);
  }
  const rejected = await buildReplyPlan({ decision: { ...decision, eligible: false }, select: () => { throw new Error('must not query'); } });
  assert.equal(rejected.status, 'not_eligible');
});

test('invalid explicit constraints do not become a broader unknown-demand query', async () => {
  const plan = await buildReplyPlan({ decision: { ...decision, rentalDemand: { ...demand, unverifiedFields: ['budgetMax'] } }, select: () => { throw new Error('must not query'); } });
  assert.equal(plan.status, 'needs_more_info');
  assert.match(plan.reason, /不放宽条件/);
});

test('provenance stores structured per-note needs and selected image without incrementing sent count', () => {
  const db = new DatabaseSync(':memory:');
  saveReplyPlan(db, { runId: 1, noteId: 'a', keyword: '租房', plan: { ...match, demand } });
  saveReplyPlan(db, { runId: 1, noteId: 'a', keyword: '租房', plan: { ...match, demand, status: 'preview_ready' } });
  const rows = db.prepare('select * from native_reply_plans').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'preview_ready');
  assert.deepEqual(JSON.parse(rows[0].plan_json).demand, demand);
  db.close();
});

function runnerFixture({ plan = { ...match, comment: groundedComment(property, demand) }, verified = false, stopDuringPlan = false, modelFailed = false } = {}) {
  const events = [];
  const records = [];
  let task;
  const native = {
    search: async () => events.push('search'), listVisibleCards: async () => [{ title: '找两室', author: '租户' }],
    openCard: async () => events.push('open'), readCurrentNote: async () => ({ title: '找两室', author: '租户', desc: '本人找长租住宅' }),
    securityReason: () => '', scrollList: async () => {}, closeCurrentNote: async () => events.push('close'),
    prepareImage: async path => events.push(['prepare', path]), fillComment: async text => events.push(['fill', text]),
    attachImage: async path => { events.push(['attach', path]); return { verified, attached: verified }; },
    sendPreparedComment: async () => events.push('send')
  };
  const request = async (port, pathname, options = {}) => {
    assert.equal(port, 3105);
    if (pathname === '/api/native/app-assess') { events.push('classify'); return modelFailed ? { ok: false, model_failed: true } : { ok: true, decision }; }
    if (pathname === '/api/native/reply-plan') {
      events.push('gallery');
      if (stopDuringPlan) task.stop();
      return { ok: true, plan, decision };
    }
    if (pathname === '/api/native/app-record') {
      records.push(options.body);
      if (options.body.action === 'gate') return { ok: true, gate: { ok: true } };
      return { ok: true, commented: false };
    }
    throw new Error('unexpected path: ' + pathname);
  };
  task = new NativeXhsTask({ native, request, delay: async () => {} });
  task.state = { ...task.state, running: true, runId: 12, status: 'running' };
  return { task, events, records };
}
const keywordOptions = { keyword: '石家庄求租', keywordIndex: 1, keywordTotal: 1, maxNotes: 1, liveSend: true };

test('native per-note sequence is classify → gallery → selected image, never preselected image', async () => {
  const { task, events, records } = runnerFixture();
  assert.equal(await task.runKeyword({ ...keywordOptions, imagePath: '/wrong/old.png' }), 'preview');
  assert.ok(events.indexOf('classify') < events.indexOf('gallery'));
  assert.deepEqual(events.find(e => Array.isArray(e) && e[0] === 'prepare'), ['prepare', match.imagePath]);
  assert.equal(events.includes('send'), false);
  assert.equal(events.some(e => Array.isArray(e) && e[0] === 'fill'), false);
  assert.equal(task.state.useful, 1);
  assert.equal(task.state.replied, 0);
  assert.equal(records.filter(r => r.action === 'sent').length, 0);
});

test('useful note without matching image remains useful and no composer is touched', async () => {
  const { task, events } = runnerFixture({ plan: { status: 'no_match', reason: '预算没有匹配' } });
  await task.runKeyword(keywordOptions);
  assert.equal(task.state.useful, 1);
  assert.equal(task.state.useless, 0);
  assert.equal(task.state.unmatched, 1);
  assert.equal(events.some(Array.isArray), false);
  assert.equal(events.at(-1), 'close');
});

test('explicit stop during gallery lookup prevents native input and sending', async () => {
  const { task, events } = runnerFixture({ stopDuringPlan: true });
  await task.runKeyword(keywordOptions);
  assert.equal(events.some(Array.isArray), false);
  assert.equal(events.includes('send'), false);
});

test('classification call failure is not counted as useless or sent', async () => {
  const { task, events, records } = runnerFixture({ modelFailed: true });
  await task.runKeyword(keywordOptions);
  assert.equal(task.state.useless, 0);
  assert.equal(task.state.failed, 1);
  assert.equal(events.includes('gallery'), false);
  assert.equal(records.find(r => r.action === 'decision').decision.categoryName, '调用失败');
});

test('only verified attachment plus live mode reaches send and persisted reply count', async () => {
  const { task, events, records } = runnerFixture({ verified: true });
  await task.runKeyword(keywordOptions);
  assert.equal(events.filter(e => e === 'send').length, 1);
  assert.equal(records.filter(r => r.action === 'sent').length, 1);
  assert.equal(task.state.replied, 1);
  assert.equal(records.filter(r => r.action === 'gate').length, 2);
});
