import { boundedInteger } from '../debug/adapter.js';

function estimateBytes(value) {
  const seen = new WeakSet();
  const stack = [value];
  let total = 0;
  try {
    while (stack.length > 0) {
      const v = stack.pop();
      if (v === null || v === undefined) { total += 4; continue; }
      const type = typeof v;
      if (type === 'string') { total += v.length * 2 + 2; continue; }
      if (type === 'bigint') { total += v.toString().length * 2 + 2; continue; }
      if (type === 'number' || type === 'boolean') { total += 16; continue; }
      if (type === 'function' || type === 'symbol') { total += 16; continue; }
      if (type !== 'object') { total += 16; continue; }
      if (seen.has(v)) { total += 10; continue; }
      seen.add(v);
      total += 16;
      if (ArrayBuffer.isView(v)) { total += v.byteLength + 2; continue; }
      if (v instanceof ArrayBuffer) { total += v.byteLength + 2; continue; }
      if (v instanceof Date) { total += 24 * 2 + 2; continue; }
      if (Array.isArray(v)) {
        total += 2;
        for (let i = 0; i < v.length; i += 1) stack.push(v[i]);
        continue;
      }
      total += 2;
      for (const key of Object.keys(v)) { total += key.length * 2 + 4; stack.push(v[key]); }
    }
    return total;
  }
  catch { return Number.POSITIVE_INFINITY; }
}

function cloneTraceValue(value, state = null, depth = 0) {
  const s = state || { seen: new WeakMap(), nodes: 0 };
  if (value == null || typeof value !== 'object') return value;
  if (depth > 48 || ++s.nodes > 20000) throw new RangeError('trace event is too deeply nested');
  if (s.seen.has(value)) return s.seen.get(value);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return new value.constructor(value);
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Date) return new Date(value.getTime());
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

function assertWireSafeTrace(value, seen) {
  if (value == null) return;
  const type = typeof value;
  if (type === 'boolean' || type === 'string' || type === 'bigint') return;
  if (type === 'number') { if (Number.isFinite(value)) return; throw new TypeError('trace number must be finite'); }
  if (type === 'function' || type === 'symbol') throw new TypeError('trace value is not wire serializable');
  if (ArrayBuffer.isView(value)) return;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new TypeError('trace object must be plain data');
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertWireSafeTrace(item, seen);
    return;
  }
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (field === undefined || typeof field === 'function' || typeof field === 'symbol') throw new TypeError('trace field is not wire serializable');
    assertWireSafeTrace(field, seen);
  }
}

function publicEvent(entry) {
  const target = entry && typeof entry === 'object' && 'event' in entry ? entry.event : entry;
  return cloneTraceValue(target);
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
    try {
      if (this.filter && !this.filter(event)) { this.dropped++; return false; }
      safe = event && typeof event === 'object' ? cloneTraceValue(event) : { type:'event', value:event };
      assertWireSafeTrace(safe, new WeakSet());
    }
    catch { this.dropped++; return false; }
    const size = estimateBytes(safe);
    if (size > this.maxBytes) { this.dropped++; return false; }
    const aggregateKey = String(safe.type || 'event').slice(0,128);
    const entry = {
      event: safe,
      bytes: size,
      aggregateKey,
      get __bytes() { return this.bytes; },
      get __aggregateKey() { return this.aggregateKey; },
    };
    this.events.push(entry); this.bytes += size; this._increment(aggregateKey);
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const old = this.events.shift(); this.bytes -= old.bytes || 0; this._decrement(old.aggregateKey || 'event'); this.dropped++;
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
