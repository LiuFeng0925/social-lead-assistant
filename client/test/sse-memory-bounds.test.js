'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSseWriter, selectSseReplay } = require('../src/sse-writer');

class Response extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.writableEnded = false; this.writableLength = 0; this.chunks = []; this.slow = true; }
  writeHead() {}
  write(text) { this.chunks.push(text); if (this.slow) this.writableLength += Buffer.byteLength(text); return !this.slow; }
  destroy() { this.destroyed = true; this.writableLength = 0; this.emit('close'); }
  drain() { this.writableLength = 0; this.slow = false; this.emit('drain'); }
}

test('a stalled monitor retains one newest frame instead of queuing 10000 screenshots', () => {
  const res = new Response();
  const send = createSseWriter(res);
  const data = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 10000; i++) send('frame', { index: i, d: data });
  assert.equal(res.chunks.length, 1, 'stop writing when the downstream buffer is full');
  const stats = send.stats();
  assert.equal(stats.latestEvents, 1);
  assert.equal(stats.queuedEvents, 0);
  assert.ok(stats.queuedBytes + stats.writableBytes < 140000);
  res.drain();
  assert.equal(res.chunks.length, 2);
  assert.ok(res.chunks[1].includes('"index":9999'));
  assert.equal(send.stats().queuedBytes, 0);
});

test('reliable events stay ordered while intermediate pointer events are coalesced', () => {
  const res = new Response(), send = createSseWriter(res);
  send('frame', { n: 1 });
  send('log', 'first'); send('status', { running: true });
  send('pointer', { x: 1 }); send('pointer', { x: 2 });
  res.drain();
  assert.deepEqual(res.chunks.map(s => s.match(/^event: (.+)/)[1]), ['frame', 'log', 'status', 'pointer']);
  assert.ok(res.chunks[3].includes('"x":2'));
});

test('reliable queue overflow disconnects the slow UI instead of exhausting worker memory', () => {
  const res = new Response(), send = createSseWriter(res, { maxQueuedEvents: 2 });
  send('log', 'first'); send('log', 'second'); send('log', 'third'); send('log', 'fourth');
  assert.equal(res.destroyed, true);
  assert.equal(send.stats().queuedBytes, 0);
  assert.equal(send.stats().queuedEvents, 0);
  assert.equal(send('log', 'after-close'), false);
});

test('total byte bound accounts for the HTTP response buffer as well as queued packets', () => {
  const res = new Response(), send = createSseWriter(res, { maxBufferedBytes: 1024 });
  send('log', 'x'.repeat(600));
  send('log', 'y'.repeat(600));
  assert.equal(res.destroyed, true);
  assert.equal(send.stats().queuedBytes, 0);
});

test('closing/erroring/finishing a monitor releases frame references and drain listeners', () => {
  for (const event of ['close', 'error', 'finish']) {
    const res = new Response(), send = createSseWriter(res);
    send('frame', { d: 'first' }); send('frame', { d: 'pending' });
    res.emit(event);
    assert.equal(send.isClosed(), true);
    assert.equal(send.stats().queuedBytes, 0);
    assert.equal(send.stats().latestEvents, 0);
    assert.equal(res.listenerCount('drain'), 0);
    const count = res.chunks.length;
    send('frame', { d: 'ignored' });
    assert.equal(res.chunks.length, count);
  }
});

test('all 800 ordinary replay logs and first status survive normal initial HTTP backpressure', () => {
  const res = new Response();
  const send = createSseWriter(res, { maxQueuedEvents: 1024 });
  const logs = Array.from({ length: 800 }, (_, index) => ({ t: '12:00:00', m: `日志 ${index}：检索并判断用户需求` }));
  const replay = selectSseReplay(logs);
  assert.equal(replay.length, 800);
  for (const line of replay) assert.equal(send('log', line), true);
  assert.equal(send('status', { running: true }), true);
  assert.equal(res.destroyed, false);
  assert.equal(send.stats().queuedEvents, 800);
  assert.ok(send.stats().queuedBytes + send.stats().writableBytes <= 512 * 1024 + 100);
  res.drain();
  assert.equal(res.chunks.length, 801);
  for (let index = 0; index < 800; index++) {
    assert.deepEqual(JSON.parse(res.chunks[index].split('\ndata: ')[1]), logs[index]);
  }
  assert.match(res.chunks[800], /^event: status/);
  assert.equal(send.stats().queuedBytes, 0);
});

test('large Chinese replay logs keep only the newest contiguous tail within the serialized byte budget', () => {
  const logs = Array.from({ length: 800 }, (_, index) => ({ t: '12:00:00', m: `第 ${index} 条：${'中文'.repeat(1900)}` }));
  const replay = selectSseReplay(logs);
  assert.ok(replay.length > 0 && replay.length < 800);
  assert.deepEqual(replay, logs.slice(-replay.length));
  assert.equal(replay.at(-1), logs.at(-1));
  const bytes = (items) => items.reduce((total, item) => total + Buffer.byteLength(`event: log\ndata: ${JSON.stringify(item)}\n\n`), 0);
  assert.ok(bytes(replay) <= 512 * 1024);
  assert.ok(bytes(logs.slice(-replay.length - 1)) > 512 * 1024);
  const res = new Response();
  const send = createSseWriter(res, { maxQueuedEvents: 1024 });
  for (const line of replay) assert.equal(send('log', line), true);
  assert.equal(send('status', { running: true }), true);
  assert.equal(res.destroyed, false);
});

test('replay also limits event count and never skips an oversized newest entry to show older logs', () => {
  const logs = [{ m: 'first' }, { m: 'second' }, { m: 'x'.repeat(2000) }];
  assert.deepEqual(selectSseReplay(logs, { maxEvents: 2 }), logs.slice(1));
  assert.deepEqual(selectSseReplay(logs, { maxBytes: 1024 }), []);
});
