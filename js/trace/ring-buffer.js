import { boundedInteger } from '../debug/adapter.js';

function estimateBytes(event) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(event, (_,v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }).length * 2;
  }
  catch { return Number.POSITIVE_INFINITY; }
}

function binaryPayloadBytes(event, limit) {
  if (event == null || typeof event !== 'object') return 0;
  const seen = new Set();
  const stack = [[event, 0]];
  let total = 0;
  let nodes = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (value == null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (depth > 48 || ++nodes > 20000) return limit + 1;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      const byteLength = value.byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > limit - total) return limit + 1;
      total += byteLength;
      continue;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return total;
}

function cloneTraceValue(value, state = null, depth = 0) {
  const s = state || { seen: new WeakMap(), nodes: 0 };
  if (value == null || typeof value !== 'object') return value;
  if (depth > 48 || ++s.nodes > 20000) throw new RangeError('trace event is too deeply nested');
  if (s.seen.has(value)) return s.seen.get(value);
  if (ArrayBuffer.isView(value)) {
    const out = value instanceof DataView
      ? new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      : new value.constructor(value);
    s.seen.set(value, out);
    return out;
  }
  if (value instanceof ArrayBuffer) {
    const out = value.slice(0);
    s.seen.set(value, out);
    return out;
  }
  if (value instanceof Date) {
    const out = new Date(value.getTime());
    s.seen.set(value, out);
    return out;
  }
  const out = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  s.seen.set(value, out);
  if (Array.isArray(value)) {
    for (const item of value) out.push(cloneTraceValue(item, s, depth + 1));
  } else {
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: cloneTraceValue(item, s, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

function publicEvent(event) {
  const copy = cloneTraceValue(event);
  if (copy && typeof copy === 'object') { delete copy.__bytes; delete copy.__aggregateKey; }
  return copy;
}

export class TraceRingBuffer {
  constructor(options = {}) {
    this.maxEvents = boundedInteger(options.maxEvents, 4096, 16, 100000, 'maxEvents');
    this.maxBytes = boundedInteger(options.maxBytes, 2 * 1024 * 1024, 4096, 32 * 1024 * 1024, 'maxBytes');
    this.sampleRate = boundedInteger(options.sampleRate, 1, 1, 100000, 'sampleRate');
    this.filter = typeof options.filter === 'function' ? options.filter : null;
    this.events = [];
    this.bytes = 0;
    this.seen = 0;
    this.dropped = 0;
    this.aggregates = new Map();
  }
  _increment(type) { this.aggregates.set(type, (this.aggregates.get(type) || 0) + 1); }
  _decrement(type) {
    const next = (this.aggregates.get(type) || 0) - 1;
    if (next > 0) this.aggregates.set(type, next); else this.aggregates.delete(type);
  }
  push(event) {
    this.seen++;
    if (this.sampleRate > 1 && ((this.seen - 1) % this.sampleRate)) { this.dropped++; return false; }
    let safe;
    let binary = 0;
    try {
      if (this.filter && !this.filter(event)) { this.dropped++; return false; }
      binary = binaryPayloadBytes(event, this.maxBytes);
      if (binary > this.maxBytes) { this.dropped++; return false; }
      safe = event && typeof event === 'object' ? cloneTraceValue(event) : { type:'event', value:event };
    }
    catch { this.dropped++; return false; }
    const size = estimateBytes(safe) + binary;
    if (size > this.maxBytes) { this.dropped++; return false; }
    const aggregateKey = String(safe.type || 'event').slice(0,128);
    safe.__bytes = size;
    safe.__aggregateKey = aggregateKey;
    this.events.push(safe); this.bytes += size; this._increment(aggregateKey);
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const old = this.events.shift(); this.bytes -= old.__bytes || 0; this._decrement(old.__aggregateKey || 'event'); this.dropped++;
    }
    return true;
  }
  clear() { this.events = []; this.bytes = 0; this.seen = 0; this.dropped = 0; this.aggregates.clear(); }
  snapshot({ limit = this.maxEvents } = {}) {
    const requested = typeof limit === 'number' && Number.isFinite(limit) ? limit : this.maxEvents;
    const n = Math.max(0, Math.min(this.events.length, Math.floor(requested)));
    return { events:this.events.slice(this.events.length - n).map(publicEvent), seen:this.seen, dropped:this.dropped, bytes:this.bytes, aggregates:Object.fromEntries(this.aggregates) };
  }
}