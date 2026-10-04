'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const keywordUtils = require('../src/keyword-utils');

const serverSource = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');

// Load just the production functions with fake engine/database dependencies.
// Requiring server.js would listen on a real port and access account data.
function functionSource(name, nextName) {
  const start = serverSource.indexOf('async function ' + name + '(');
  const end = serverSource.indexOf('\nasync function ' + nextName + '(', start);
  assert.ok(start >= 0 && end > start, 'production function boundaries must exist: ' + name);
  return serverSource.slice(start, end);
}

function scanFixture() {
  const scans = [], savedNotes = [], logs = [], events = [];
  const machine = {
    running: true, runId: 17,
    client: { account: 1 }, target: { id: 'account-1-only' },
    scanCycleActive: true, keywordSignature: '石家庄求租\u0000桥西区求租',
    keywordIndex: 0, keywordTotal: 2,
    scanSeen: new Set(['previous-note']),
    keywordCollected: new Map([['石家庄求租', 3]]), scanCollected: 3,
    retrySourceRunId: 0, targets: [], lastScan: 123
  };
  const cfg = {
    task_keyword: '石家庄求租,桥西区求租', search_home_retries: 2,
    task_sort: '最新', task_note_time: '一周内', task_note_type: '图文', task_note_range: '不限'
  };
  const context = {
    machine, ...keywordUtils, OUTBOUND_FRESH_BATCH_SIZE: 8,
    throttle: { currentScanLimit: () => 40 },
    engine: {
      prepareNotesForDetailClassification: (notes) => ({ tagged: notes, targets: notes, byIntent: { 待分析: notes.length } })
    },
    db: { addTaskRunScan: (...args) => scans.push(args), upsertNote: (note) => savedNotes.push(note) },
    emitLog: (message) => logs.push(message), emitEvent: (...args) => events.push(args),
    emitRunStats: () => {}, formatCategoryCounts: () => ''
  };
  vm.createContext(context);
  vm.runInContext(functionSource('_scanNextKeywordTargets', 'engageOpenNote'), context);
  return { context, machine, cfg, scans, savedNotes, logs, events };
}

for (const mode of ['stop', 'new-run']) {
  test('a ' + mode + ' during search discards its result without advancing keyword or statistics', async () => {
    const fixture = scanFixture();
    const { context, machine, cfg, scans, savedNotes, logs, events } = fixture;
    let finishScan, request;
    context.engine.scanClean = (options) => {
      request = options;
      return new Promise((resolve) => { finishScan = resolve; });
    };
    const pending = context._scanNextKeywordTargets(cfg);
    assert.equal(request.shouldStop(), false);
    assert.equal(request.maxHomeRetries, 2);
    assert.equal(request.client, machine.client);
    assert.equal(request.target, machine.target);
    if (mode === 'stop') machine.running = false;
    else machine.runId = 18;
    assert.equal(request.shouldStop(), true);

    const logCount = logs.length;
    request.onLog('stale recovery progress');
    assert.equal(logs.length, logCount, 'cancelled scans must not emit late progress');
    finishScan([{ id: 'must-not-be-counted' }]);
    await pending;

    assert.equal(machine.keywordIndex, 0);
    assert.equal(machine.scanCycleActive, true);
    assert.equal(machine.scanCollected, 3);
    assert.equal(machine.keywordCollected.get('石家庄求租'), 3);
    assert.deepEqual([...machine.scanSeen], ['previous-note']);
    assert.equal(machine.lastScan, 123);
    assert.deepEqual(machine.targets, []);
    assert.deepEqual(scans, []);
    assert.deepEqual(savedNotes, []);
    assert.deepEqual(events, []);
  });
}

test('a valid recovered scan preserves existing counts and belongs to the captured run and keyword', async () => {
  const { context, machine, cfg, scans, savedNotes } = scanFixture();
  context.engine.scanClean = async (request) => {
    assert.equal(request.keyword, '石家庄求租');
    assert.equal(request.maxHomeRetries, 2);
    assert.equal(request.filters.sort, '最新');
    assert.equal(request.filters.noteTime, '一周内');
    assert.equal(request.filters.noteType, '图文');
    return [{ id: 'previous-note' }, { id: 'new-note' }];
  };
  await context._scanNextKeywordTargets(cfg, 17);
  assert.deepEqual(scans, [[17, '石家庄求租', 1]]);
  assert.equal(machine.scanCollected, 4);
  assert.equal(machine.keywordCollected.get('石家庄求租'), 4);
  assert.equal(machine.keywordIndex, 0);
  assert.equal(machine.targets.length, 1);
  assert.equal(machine.targets[0].id, 'new-note');
  assert.equal(machine.targets[0].sourceKeyword, '石家庄求租');
  assert.equal(machine.targets[0].classificationPending, true);
  assert.equal(savedNotes.length, 1);
});

function loopFixture() {
  const machine = { running: true, runId: 12, retrySourceRunId: 0, phase: 'search' };
  const logs = [], finished = [], wakeLocks = [];
  const context = {
    machine,
    db: { getConfig: () => ({}), finishTaskRun: (runId) => finished.push(runId) },
    emitLog: (message) => logs.push(message), emitEvent: () => {},
    machineStatus: () => ({}), emitRunStats: () => {}, setTaskWakeLock: (active) => wakeLocks.push(active),
    sleep: async () => assert.fail('terminal search errors must not start an automatic retry loop'),
    isCdpConnectionError: () => false, resetMachineConnection: () => {},
    engine: {
      isAccountSecurityError: () => false,
      isSearchRecoveryError: (error) => error.code === 'SEARCH_RECOVERY_FAILED',
      isSearchPageMismatchError: (error) => error.code === 'SEARCH_PAGE_MISMATCH'
    }
  };
  vm.createContext(context);
  vm.runInContext(functionSource('machineLoop', '_ensureConn'), context);
  return { context, machine, logs, finished, wakeLocks };
}

function exhaustedError() {
  return Object.assign(new Error('search_recovery_failed'), {
    code: 'SEARCH_RECOVERY_FAILED', userMessage: '返回首页重试已达上限，任务暂停'
  });
}

test('exhausted search recovery pauses once instead of looping and finalizes only the current run', async () => {
  const { context, machine, logs, finished, wakeLocks } = loopFixture();
  let cycles = 0;
  context.machineCycle = async (runId) => {
    assert.equal(runId, 12);
    cycles++;
    throw exhaustedError();
  };
  await context.machineLoop(12);
  assert.equal(cycles, 1);
  assert.equal(machine.running, false);
  assert.equal(machine.phase, 'idle');
  assert.deepEqual(finished, [12]);
  assert.deepEqual(wakeLocks, [false]);
  assert.equal(logs.filter((message) => message.includes('重试已达上限')).length, 1);
  assert.ok(logs.some((message) => message.includes('已有统计和回复记录保留')));
});

test('a stale recovery error cannot stop a newly started run or release its wake lock', async () => {
  const { context, machine, logs, finished, wakeLocks } = loopFixture();
  context.machineCycle = async () => {
    machine.runId = 13;
    throw exhaustedError();
  };
  await context.machineLoop(12);
  assert.equal(machine.running, true);
  assert.equal(machine.runId, 13);
  assert.equal(machine.phase, 'search');
  assert.deepEqual(finished, []);
  assert.deepEqual(wakeLocks, []);
  assert.equal(logs.some((message) => message.includes('任务暂停')), false);
});

test('browser recovery setting exposes 0/1/2, defaults to one and reaches every scan entry', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');
  const dbSource = fs.readFileSync(path.join(__dirname, '../src/db.js'), 'utf8');
  const select = html.match(/<select id="search_home_retries">([\s\S]*?)<\/select>/);
  assert.ok(select, 'task settings should expose the retry budget');
  assert.deepEqual([...select[1].matchAll(/<option value="(\d)"/g)].map((match) => Number(match[1])), [0, 1, 2]);
  assert.match(select[1], /<option value="1" selected>/);
  assert.match(dbSource, /search_home_retries:\s*1/);
  assert.match(html, /setVal\('search_home_retries',\s*c\.search_home_retries/);
  assert.match(html, /search_home_retries:\s*Math\.max\(0,\s*Math\.min\(2,\s*Number\(\$\('search_home_retries'\)\.value\)\)\)/);
  assert.match(html, /仅浏览器模式/);
  assert.match(html, /扫码、登录或账号安全验证不会自动重试/);
  for (const [name, nextName] of [
    ['handleRun', 'handleSend'], ['handleAutoRun', 'handleConfig'],
    ['_scanNextKeywordTargets', 'engageOpenNote']
  ]) {
    assert.match(functionSource(name, nextName), /maxHomeRetries:\s*cfg\.search_home_retries/, name + ' must pass the account configuration');
  }
  const keywordScan = functionSource('scanKeywords', 'ensureScreencast');
  assert.match(keywordScan, /engine\.scanClean\(\{[^\n]*maxHomeRetries[, }]/);
});
