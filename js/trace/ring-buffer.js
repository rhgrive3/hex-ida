import { boundedInteger } from '../debug/adapter.js';

function estimateBytes(event) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(event, (_,v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return {};
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

const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;

const SAFE_TYPED_ARRAY_CTORS = Object.assign(Object.create(null), {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  ...(typeof BigInt64Array === 'function' ? { BigInt64Array } : {}),
  ...(typeof BigUint64Array === 'function' ? { BigUint64Array } : {}),
});

function cloneArrayBufferView(value) {
  const copiedBuffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (value instanceof DataView) return new DataView(copiedBuffer);
  let tag = null;
  try { tag = TYPED_ARRAY_TAG_GETTER?.call(value) ?? null; } catch { tag = null; }
  const Ctor = tag && Object.hasOwn(SAFE_TYPED_ARRAY_CTORS, tag) ? SAFE_TYPED_ARRAY_CTORS[tag] : null;
  if (!Ctor) throw new TypeError('trace typed array is not wire serializable');
  return new Ctor(copiedBuffer);
}

function cloneTraceValue(value, state = null, depth = 0) {
  const s = state || { seen: new WeakMap(), nodes: 0 };
  if (value == null || typeof value !== 'object') return value;
  if (depth > 48 || ++s.nodes > 20000) throw new RangeError('trace event is too deeply nested');
  if (s.seen.has(value)) return s.seen.get(value);
  if (ArrayBuffer.isView(value)) {
    const out = cloneArrayBufferView(value);
    s.seen.set(value, out);
    return out;
  }
  if (value instanceof ArrayBuffer) {
    const out = value.slice(0);
    s.seen.set(value, out);
    return out;
  }
  if (value instanceof Date) {
    throw new TypeError('trace object must be plain data');
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

function assertWireSafeTrace(value, seen) {
  if (value == null) return;
  const type = typeof value;
  if (type === 'boolean' || type === 'string' || type === 'bigint') return;
  if (type === 'number') { if (Number.isFinite(value)) return; throw new TypeError('trace number must be finite'); }
  if (type === 'function' || type === 'symbol') throw new TypeError('trace value is not wire serializable');
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
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
    this._ring = new Array(this.maxEvents);
    this._head = 0;
    this._count = 0;
    this._eventsCache = null;
    this.bytes = 0;
    this.seen = 0;
    this.dropped = 0;
    this.aggregates = new Map();
  }
  get events() {
    if (this._eventsCache) return this._eventsCache;
    const out = new Array(this._count);
    for (let i = 0; i < this._count; i++) {
      out[i] = this._ring[(this._head + i) % this.maxEvents];
    }
    this._eventsCache = out;
    return out;
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
      assertWireSafeTrace(safe, new WeakSet());
    }
    catch { this.dropped++; return false; }
    const size = estimateBytes(safe) + binary;
    if (size > this.maxBytes) { this.dropped++; return false; }
    const aggregateKey = String(safe.type || 'event').slice(0,128);
    const entry = {
      event: safe,
      bytes: size,
      aggregateKey,
      get __bytes() { return this.bytes; },
      get __aggregateKey() { return this.aggregateKey; },
    };
    // Preserve the historical inspection shape for callers/tests that inspect
    // the ring's retained entries directly, while keeping the canonical event
    // under .event for snapshot/publication.
    for (const key of Object.keys(safe)) {
      if (key in entry) continue;
      Object.defineProperty(entry, key, {
        value: safe[key],
        enumerable: false,
        configurable: true,
      });
    }
    if (this._count === this.maxEvents) {
      const old = this._ring[this._head];
      this._ring[this._head] = undefined;
      this._head = (this._head + 1) % this.maxEvents;
      this._count--;
      this.bytes -= old.bytes || 0;
      this._decrement(old.aggregateKey || 'event');
      this.dropped++;
    }
    const tail = (this._head + this._count) % this.maxEvents;
    this._ring[tail] = entry;
    this._count++;
    this.bytes += size;
    this._increment(aggregateKey);
    while (this._count > 0 && this.bytes > this.maxBytes) {
      const old = this._ring[this._head];
      this._ring[this._head] = undefined;
      this._head = (this._head + 1) % this.maxEvents;
      this._count--;
      this.bytes -= old.bytes || 0;
      this._decrement(old.aggregateKey || 'event');
      this.dropped++;
    }
    this._eventsCache = null;
    return true;
  }
  clear() { this._ring = new Array(this.maxEvents); this._head = 0; this._count = 0; this._eventsCache = null; this.bytes = 0; this.seen = 0; this.dropped = 0; this.aggregates.clear(); }
  snapshot({ limit = this.maxEvents } = {}) {
    const requested = typeof limit === 'number' && Number.isFinite(limit) ? limit : this.maxEvents;
    const n = Math.max(0, Math.min(this._count, Math.floor(requested)));
    const startOffset = this._count - n;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = publicEvent(this._ring[(this._head + startOffset + i) % this.maxEvents]);
    }
    return { events: out, seen:this.seen, dropped:this.dropped, bytes:this.bytes, aggregates:Object.fromEntries(this.aggregates) };
  }
}
