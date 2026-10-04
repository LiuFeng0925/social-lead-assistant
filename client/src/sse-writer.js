'use strict';

function bounded(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function serializeEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Replay a contiguous tail in original order, with both a count and an exact
// serialized-byte budget. Large Chinese logs must not turn the initial replay
// into a disconnect/reconnect loop before the UI receives its first status.
function selectSseReplay(items, options = {}) {
  const event = options.event || 'log';
  const maxBytes = bounded(options.maxBytes, 512 * 1024, 1, 4 * 1024 * 1024);
  const maxEvents = bounded(options.maxEvents, 800, 1, 4096);
  const source = Array.isArray(items) ? items : [];
  let start = source.length, bytes = 0;
  while (start > 0 && source.length - start < maxEvents) {
    const nextBytes = Buffer.byteLength(serializeEvent(event, source[start - 1]));
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    start--;
  }
  return source.slice(start);
}

// A slow UI must never turn live video into an ever-growing response buffer.
// Frames/pointers keep only their latest value. Reliable events have a bounded
// queue; a persistently slow client is disconnected and can reconnect normally.
function createSseWriter(res, options = {}) {
  const maxBytes = bounded(options.maxBufferedBytes, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024);
  const maxEvents = bounded(options.maxQueuedEvents, 128, 1, 1024);
  let closed = false, blocked = false, bytes = 0;
  const queue = [], latest = new Map();
  const forget = () => { queue.length = 0; latest.clear(); bytes = 0; };
  function cleanup() {
    closed = true;
    forget();
    res.off('drain', drain);
  }
  function disconnect() {
    cleanup();
    if (!res.destroyed) res.destroy();
  }
  function write(packet) {
    if (closed || res.destroyed || res.writableEnded) { cleanup(); return false; }
    // Include Node's already-buffered bytes, not only this writer's own queue.
    if (Number(res.writableLength || 0) + packet.bytes > maxBytes) { disconnect(); return false; }
    try { blocked = !res.write(packet.text); } catch (_) { disconnect(); }
    return !closed;
  }
  function drain() {
    if (closed) return;
    blocked = false;
    while (!closed && !blocked && (queue.length || latest.size)) {
      const packet = queue.length ? queue.shift() : latest.values().next().value;
      if (packet.replaceable) latest.delete(packet.event);
      bytes -= packet.bytes;
      write(packet);
    }
  }
  res.once('close', cleanup);
  res.once('finish', cleanup);
  res.once('error', cleanup);
  res.on('drain', drain);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => {
    if (closed || res.destroyed || res.writableEnded) { cleanup(); return false; }
    const text = serializeEvent(event, data);
    const packet = { event, text, bytes: Buffer.byteLength(text), replaceable: event === 'frame' || event === 'pointer' };
    if (packet.bytes > maxBytes) {
      if (!packet.replaceable) disconnect();
      return false;
    }
    if (!blocked) return write(packet);
    if (packet.replaceable) {
      const previous = latest.get(event);
      if (previous) bytes -= previous.bytes;
      latest.set(event, packet);
    } else queue.push(packet);
    bytes += packet.bytes;
    if (bytes + Number(res.writableLength || 0) > maxBytes || queue.length > maxEvents) disconnect();
    return !closed;
  };
  send.isClosed = () => closed || res.destroyed || res.writableEnded;
  send.stats = () => ({ closed: !!send.isClosed(), blocked, queuedBytes: bytes, queuedEvents: queue.length, latestEvents: latest.size, writableBytes: Number(res.writableLength || 0), maxBytes });
  return send;
}

module.exports = { createSseWriter, selectSseReplay };
