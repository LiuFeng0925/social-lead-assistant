'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRentalDemand } = require('../src/rental-demand');
const llm = require('../src/llm');
const engine = require('../src/engine');

const categories = [
  { id: 'tenant', name: '求租笔记', action: 'comment' },
  { id: 'unknown', name: '不明', action: 'record', fallback: true }
];

test('native rental demand preserves only explicit note facts with evidence', () => {
  const note = { title: '石家庄桥西区求租', desc: '想在志诚华府整租两室一厅，预算1500到2000元/月，一家三口自住，租一年，9月入住，要带厨房。' };
  const demand = normalizeRentalDemand({
    city: '石家庄', district: '桥西区', locations: ['志诚华府'], budgetMin: 1500, budgetMax: 2000,
    bedrooms: [2], rentalType: 'entire', leaseMonthsMin: 12, leaseMonthsMax: 12,
    purpose: 'residential', moveIn: '9月入住', requirements: ['带厨房'],
    evidence: { city: '石家庄', district: '桥西区', locations: '想在志诚华府整租', budgetMin: '预算1500到2000元/月', budgetMax: '预算1500到2000元/月', bedrooms: '两室一厅', rentalType: '整租两室一厅', leaseMonthsMin: '租一年', leaseMonthsMax: '租一年', purpose: '一家三口自住', moveIn: '9月入住', requirements: '要带厨房' }
  }, note);
  assert.equal(demand.city, '石家庄');
  assert.deepEqual(demand.locations, ['志诚华府']);
  assert.equal(demand.budgetMax, 2000);
  assert.deepEqual(demand.bedrooms, [2]);
  assert.equal(demand.leaseMonthsMax, 12);
  assert.deepEqual(demand.requirements, ['带厨房']);
  assert.deepEqual(demand.missing, []);
  assert.deepEqual(demand.unverifiedFields, []);
});

test('missing budget and term are unknown, never copied from service area or query', () => {
  const note = { title: '志诚华府求租', desc: '两室一厅，长期自住。' };
  const demand = normalizeRentalDemand({
    city: '石家庄', district: '桥西区', budgetMax: 2000, leaseMonthsMin: 12,
    locations: ['志诚华府'], bedrooms: [2], rentalType: 'entire', purpose: 'residential',
    evidence: { city: '石家庄', district: '桥西区', budgetMax: '预算2000', locations: '志诚华府求租', bedrooms: '两室一厅', leaseMonthsMin: '长期自住', rentalType: '两室一厅', purpose: '长期自住' }
  }, note);
  assert.equal(demand.city, '');
  assert.equal(demand.district, '');
  assert.equal(demand.budgetMax, null);
  assert.equal(demand.leaseMonthsMin, null);
  assert.equal(demand.rentalType, 'unknown');
  assert.ok(demand.missing.includes('budgetMax'));
  assert.deepEqual(demand.locations, ['志诚华府']);
  assert.deepEqual(demand.unverifiedFields, ['city', 'district', 'budgetMax', 'rentalType', 'leaseMonthsMin']);
});

test('commercial and short term facts are not silently converted into target audience', () => {
  const demand = normalizeRentalDemand({
    purpose: 'commercial', leaseMonthsMin: 1, leaseMonthsMax: 3,
    evidence: { purpose: '求租门面开店', leaseMonthsMin: '只租1到3个月', leaseMonthsMax: '只租1到3个月' }
  }, { title: '求租门面开店', desc: '只租1到3个月' });
  assert.equal(demand.purpose, 'commercial');
  assert.equal(demand.leaseMonthsMin, 1);
  assert.equal(demand.leaseMonthsMax, 3);
});

test('invalid numbers, fabricated bounds, reversed ranges and room count confusion fail closed', () => {
  const note = { title: '求租两室一厅', desc: '预算1500到2000元，租6到12个月。' };
  const demand = normalizeRentalDemand({
    budgetMin: 2000, budgetMax: 1500, bedrooms: [1, 2, '2', 0, 200],
    leaseMonthsMin: -1, leaseMonthsMax: 18,
    evidence: { budgetMin: '预算1500到2000元', budgetMax: '预算1500到2000元', bedrooms: '两室一厅', leaseMonthsMin: '租6到12个月', leaseMonthsMax: '租6到12个月' }
  }, note);
  assert.equal(demand.budgetMin, null);
  assert.equal(demand.budgetMax, null);
  assert.equal(demand.leaseMonthsMin, null);
  assert.equal(demand.leaseMonthsMax, null);
  assert.deepEqual(demand.bedrooms, [2], 'a living room must not become another requested bedroom count');
  assert.equal(demand.evidence.budgetMax, undefined);
  assert.deepEqual(demand.unverifiedFields, ['budgetMin', 'budgetMax', 'bedrooms', 'leaseMonthsMin', 'leaseMonthsMax']);
});

test('truly missing facts are not flagged as unverified constraints', () => {
  const demand = normalizeRentalDemand({ city: '', locations: [], budgetMin: null, budgetMax: null, bedrooms: [], rentalType: 'unknown', purpose: 'unknown' }, { title: '想租房' });
  assert.deepEqual(demand.unverifiedFields, []);
  assert.ok(demand.missing.includes('budgetMax'));
});

test('partially unsupported locations remain marked for human verification', () => {
  const demand = normalizeRentalDemand({ locations: ['志诚华府', '杜甫城'], evidence: { locations: '想租志诚华府' } }, { title: '想租志诚华府' });
  assert.deepEqual(demand.locations, ['志诚华府']);
  assert.deepEqual(demand.unverifiedFields, ['locations']);
});

test('negative rental types must not become affirmative gallery filters', () => {
  const note = { title: '求租', desc: '不要合租，只想整租。' };
  const rejected = normalizeRentalDemand({ rentalType: 'shared', evidence: { rentalType: '不要合租，只想整租' } }, note);
  const accepted = normalizeRentalDemand({ rentalType: 'entire', evidence: { rentalType: '不要合租，只想整租' } }, note);
  assert.equal(rejected.rentalType, 'unknown');
  assert.deepEqual(rejected.unverifiedFields, ['rentalType']);
  assert.equal(accepted.rentalType, 'entire');
  assert.deepEqual(accepted.unverifiedFields, []);
  const suffix = normalizeRentalDemand({ rentalType: 'shared', evidence: { rentalType: '合租不考虑' } }, { title: '合租不考虑' });
  assert.deepEqual(suffix.unverifiedFields, ['rentalType']);
});

test('upper budget bounds cannot silently be inverted into a lower bound', () => {
  const note = { desc: '预算2000以内。' };
  const demand = normalizeRentalDemand({ budgetMin: 2000, budgetMax: 2000, evidence: { budget: '预算2000以内' } }, note);
  assert.equal(demand.budgetMin, null);
  assert.equal(demand.budgetMax, 2000);
  assert.deepEqual(demand.unverifiedFields, ['budgetMin']);
  const lowOnly = normalizeRentalDemand({ budgetMax: 2000, evidence: { budgetMax: '预算最低2000元' } }, { desc: '预算最低2000元' });
  assert.equal(lowOnly.budgetMax, null);
  assert.deepEqual(lowOnly.unverifiedFields, ['budgetMax']);
});

test('reversed lease ranges are flagged rather than broadening the search', () => {
  const demand = normalizeRentalDemand({ leaseMonthsMin: 12, leaseMonthsMax: 6, evidence: { lease: '想租6到12个月' } }, { desc: '想租6到12个月' });
  assert.equal(demand.leaseMonthsMin, null);
  assert.equal(demand.leaseMonthsMax, null);
  assert.deepEqual(demand.unverifiedFields, ['leaseMonthsMin', 'leaseMonthsMax']);
});

test('Chinese budget, years and half-year units normalize without guessing', () => {
  const note = { title: '求租', desc: '预算三千以内，租半年。' };
  const demand = normalizeRentalDemand({ budgetMax: 3000, leaseMonthsMin: 6, evidence: { budgetMax: '预算三千以内', leaseMonthsMin: '租半年' } }, note);
  assert.equal(demand.budgetMax, 3000);
  assert.equal(demand.leaseMonthsMin, 6);
  const daily = normalizeRentalDemand({ budgetMax: 150, evidence: { budgetMax: '日租150元' } }, { desc: '日租150元' });
  assert.equal(daily.budgetMax, null, 'daily price must not be used as monthly budget');
});

test('default browser classification has no demand schema or added output budget', async () => {
  const requests = [];
  const result = await llm.classifyNoteCategory({
    note: { title: '求租', desc: '长期自住' }, leadModel: { categories }, provider: 'deepseek', apiKey: 'unused-test',
    requestChat: async (request) => { requests.push(request); return { choices: [{ message: { content: JSON.stringify({ categoryId: 'tenant', confidence: 0.9, rentalDemand: { purpose: 'residential' } }) } }] }; }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.max_tokens, 800);
  assert.doesNotMatch(requests[0].body.messages[0].content, /rentalDemand/);
  assert.equal(Object.hasOwn(result, 'rentalDemand'), false);
});

test('native opt-in extracts demand in the existing classification call with grounded prompt', async () => {
  const requests = [];
  const result = await llm.classifyNoteCategory({
    note: { title: '桥西区求租', desc: '预算2000以内，长期自住' }, leadModel: { categories }, extractDemand: true,
    requestChat: async (request) => {
      requests.push(request);
      return { choices: [{ message: { content: JSON.stringify({ categoryId: 'tenant', confidence: 0.9,
        rentalDemand: { district: '桥西区', budgetMax: 2000, purpose: 'residential', evidence: { district: '桥西区求租', budgetMax: '预算2000以内', purpose: '长期自住' } }
      }) } }] };
    }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.max_tokens, 2400);
  assert.match(requests[0].body.messages[0].content, /city、district、locations 必须逐字来自目标租房地/);
  assert.match(requests[0].body.messages[0].content, /不能把“分类符合”伪装成已明确的长租事实/);
  assert.equal(result.rentalDemand.budgetMax, 2000);
  assert.equal(result.rentalDemand.leaseMonthsMin, null);
});

test('native model omitting the demand schema is retried and fails visibly', async () => {
  let calls = 0;
  await assert.rejects(llm.classifyNoteCategory({
    note: { title: '求租' }, leadModel: { categories }, extractDemand: true,
    requestChat: async () => { calls++; return { choices: [{ message: { content: '{"categoryId":"tenant"}' } }] }; }
  }), /未返回租房需求对象/);
  assert.equal(calls, 2);
});

test('engine only exposes structured demand when native account configuration opts in', async () => {
  const original = llm.classifyNoteCategory;
  const flags = [];
  llm.classifyNoteCategory = async (options) => {
    flags.push(options.extractDemand);
    return { categoryId: 'tenant', confidence: 0.99, reason: '明确求租', rentalDemand: { purpose: 'residential' } };
  };
  try {
    const cfg = { llm_enabled: true, llm_api_key: 'unused-test', lead_model: { categories, llmClassificationEnabled: true } };
    const browser = await engine.classifyDetailedNote({ title: '长期住宅求租' }, cfg);
    const native = await engine.classifyDetailedNote({ title: '长期住宅求租' }, { ...cfg, native_extract_demand: true });
    assert.deepEqual(flags, [false, true]);
    assert.equal(Object.hasOwn(browser, 'rentalDemand'), false);
    assert.equal(native.rentalDemand.purpose, 'residential');
  } finally { llm.classifyNoteCategory = original; }
});
