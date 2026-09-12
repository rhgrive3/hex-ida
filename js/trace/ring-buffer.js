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

function addAdmissionBytes(state, amount) {
  state.bytes += amount;
  return state.bytes > state.limit;
}

function exhaustsAdmissionBudget(value, depth, state) {
  if (typeof value === 'string') return addAdmissionBytes(state, value.length * 2);
  if (value == null || typeof value !== 'object') return addAdmissionBytes(state, 2);
  if (depth > 48 || ++state.nodes > 20000) return true;
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  if (addAdmissionBytes(state, 2)) return true;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const byteLength = value.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return true;
    state.binaryBytes += byteLength;
    return addAdmissionBytes(state, byteLength);
  }
  if (value instanceof Date) return addAdmissionBytes(state, 2);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) if (exhaustsAdmissionBudget(value[i], depth + 1, state)) return true;
    return false;
  }
  for (const key of Object.keys(value)) if (exhaustsAdmissionBudget(value[key], depth + 1, state)) return true;
  return false;
}

function admissionInfo(event, limit) {
  const state = { seen: new WeakSet(), bytes: 0, binaryBytes: 0, nodes: 0, limit };
  return { rejected: exhaustsAdmissionBudget(event, 0, state), binaryBytes: state.binaryBytes };
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
    let binaryBytes = 0;
    try {
      if (this.filter && !this.filter(event)) { this.dropped++; return false; }
      if (event && typeof event === 'object') {
        const admission = admissionInfo(event, this.maxBytes);
        if (admission.rejected) { this.dropped++; return false; }
        binaryBytes = admission.binaryBytes;
      }
      safe = event && typeof event === 'object' ? cloneTraceValue(event) : { type:'event', value:event };
      assertWireSafeTrace(safe, new WeakSet());
    }
    catch { this.dropped++; return false; }
    const size = estimateBytes(safe) + binaryBytes;
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