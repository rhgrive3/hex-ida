// Regression for #5129: TraceRingBuffer.push() deep-cloned and JSON-serialized
// an entire event *before* consulting maxBytes, so a single oversized event
// (a giant TypedArray/ArrayBuffer or many small payloads summing past the
// budget) could allocate and serialize hundreds of MiB independently of a tiny
// byte budget. A bounded admission walk now charges real binary byte lengths
// and string lengths before any clone/serialization, rejecting oversized
// events cheaply while preserving accepted-event snapshot/eviction semantics.
import assert from 'node:assert/strict';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';

const MIB = 1024 * 1024;
const BUDGET = 4096;
const FAST = 2000; // an in-budget rejection must never touch the payload

function elapsed(fn) {
  const started = Date.now();
  const result = fn();
  return { result, ms: Date.now() - started };
}

// 1. A single giant TypedArray must be dropped without a full clone/stringify.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: BUDGET });
  const payload = new Uint8Array(16 * MIB);
  const { result, ms } = elapsed(() => ring.push({ type: 'blob', payload }));
  assert.equal(result, false, 'a 16 MiB view must be rejected against a 4 KiB budget');
  assert.equal(ring.snapshot().events.length, 0, 'the oversized event must not be stored');
  assert.ok(ms < FAST, `giant TypedArray must be rejected before materializing (took ${ms}ms)`);
}

// 2. The same must hold for a nested ArrayBuffer buried inside the object graph.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: BUDGET });
  const event = { type: 'blob', envelope: { inner: { bytes: new ArrayBuffer(16 * MIB) } } };
  const { result, ms } = elapsed(() => ring.push(event));
  assert.equal(result, false, 'a nested 16 MiB ArrayBuffer must be rejected');
  assert.ok(ms < FAST, `nested ArrayBuffer must be rejected cheaply (took ${ms}ms)`);
}

// 3. Many individually small payloads whose total exceeds the budget must be
//    dropped mid-traversal, not after copying/serializing every one of them.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: BUDGET });
  const payloads = Array.from({ length: 2000 }, () => new Uint8Array(2048)); // 4 MiB total, each ~2 KiB
  const { result, ms } = elapsed(() => ring.push({ type: 'many', payloads }));
  assert.equal(result, false, 'aggregate payload beyond budget must be rejected');
  assert.ok(ms < FAST, `summed overflow must abort early (took ${ms}ms)`);
}

// 4. Ordinary small events are still snapshotted and own their nested data.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: BUDGET });
  const original = { type: 'instruction', nested: { regs: [1, 2] }, note: 'ok' };
  assert.equal(ring.push(original), true, 'a small event is admitted');
  original.nested.regs[0] = 99;
  assert.equal(ring.snapshot().events[0].nested.regs[0], 1, 'ingestion must deep-snapshot');
}

// 5. Existing circular-reference clone semantics are preserved (still admitted).
{
  const ring = new TraceRingBuffer({ maxBytes: 1024 * 1024 });
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;
  assert.equal(ring.push(cyclic), true, 'a cyclic event stays admissible under its budget');
}

// 6. maxEvents eviction, aggregate counts and drop accounting are unchanged.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: BUDGET });
  for (let i = 0; i < 100; i++) ring.push({ type: `branch:${i}`, address: BigInt(i) });
  const snap = ring.snapshot();
  assert.equal(snap.events.length, 16, 'maxEvents eviction still bounds stored events');
  assert.ok(snap.bytes <= BUDGET, 'stored bytes stay within the budget');
  assert.ok(snap.dropped > 0, 'evicted events are counted as dropped');
  assert.ok(Object.keys(snap.aggregates).length <= 16, 'aggregates stay bounded');
}

// 7. The existing depth and node guards still reject malicious graphs.
{
  let deep = {};
  const root = deep;
  for (let i = 0; i < 60; i++) { deep.next = {}; deep = deep.next; }
  const ringDepth = new TraceRingBuffer({ maxBytes: 2 * MIB });
  assert.equal(ringDepth.push({ type: 'deep', root }), false, 'over-deep events remain rejected');

  const heavy = Array.from({ length: 20001 }, () => ({}));
  const ringNodes = new TraceRingBuffer({ maxBytes: 2 * MIB });
  assert.equal(ringNodes.push({ type: 'heavy', heavy }), false, 'node-heavy events remain rejected');
}

console.log('issue-5129 trace ring-buffer bounded admission: PASS');
