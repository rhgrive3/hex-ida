// Regression for #4981: TraceRingBuffer sized events with
// JSON.stringify(event).length * 2, but an ArrayBuffer (and a DataView)
// serializes to `{}`, so a multi-megabyte binary payload was estimated at a
// few dozen bytes, cloned in full, and retained forever under a 4 KiB
// maxBytes. Binary payloads must be charged from their real byteLength and an
// over-budget event must be rejected before it is cloned and retained.
import assert from 'node:assert/strict';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';

function slicedArrayBuffer(byteLength) {
  const buffer = new ArrayBuffer(byteLength);
  const state = { copies: 0 };
  Object.defineProperty(buffer, 'slice', {
    configurable: true,
    writable: true,
    value: (...args) => { state.copies += 1; return ArrayBuffer.prototype.slice.apply(buffer, args); },
  });
  return { buffer, state };
}

// 1. An ArrayBuffer payload above maxBytes is rejected before cloning/retaining.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  const { buffer, state } = slicedArrayBuffer(8 * 1024 * 1024);
  assert.equal(ring.push({ type: 'blob', payload: buffer }), false,
    'an over-budget ArrayBuffer payload must be rejected');
  assert.equal(state.copies, 0, 'the over-budget payload must not be cloned');
  assert.equal(ring.events.length, 0, 'nothing may be retained');
  assert.equal(ring.snapshot().bytes, 0, 'retained byte accounting must stay empty');
  // 6. one rejected push costs exactly one drop and one seen event.
  assert.equal(ring.snapshot().dropped, 1);
  assert.equal(ring.snapshot().seen, 1);
}

// 2. A small ArrayBuffer payload is accepted and charged by real byteLength.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  const payload = new ArrayBuffer(2048);
  assert.equal(ring.push({ type: 'blob', payload }), true);
  assert.equal(ring.events.length, 1);
  assert.notEqual(ring.events[0].payload, payload, 'the retained buffer must be an owned copy');
  assert.equal(ring.events[0].payload.byteLength, 2048);
  // 7. reported bytes never under-report retained binary bytes.
  assert.ok(ring.bytes >= 2048, `bytes must cover the retained payload (${ring.bytes})`);
  assert.ok(ring.snapshot().bytes >= 2048, `snapshot bytes must cover the retained payload (${ring.snapshot().bytes})`);
}

// 3a. A DataView is charged by view range, not as `{}` and not by backing size.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  const backing = new ArrayBuffer(1024 * 1024);
  const view = new DataView(backing, 4096, 2048);
  assert.equal(ring.push({ type: 'view', payload: view }), true);
  assert.equal(ring.events[0].payload.byteLength, 2048, 'only the view range may be retained');
  assert.ok(ring.snapshot().bytes >= 2048, `view bytes must be accounted (${ring.snapshot().bytes})`);
}

// 3b. An over-budget DataView range is rejected before the backing copy happens.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  const { buffer, state } = slicedArrayBuffer(8192);
  assert.equal(ring.push({ type: 'view', payload: new DataView(buffer, 0, 8192) }), false);
  assert.equal(state.copies, 0, 'the over-budget view must not be copied');
  assert.equal(ring.events.length, 0);
  assert.equal(ring.snapshot().dropped, 1);
}

// 3c. TypedArray payloads are charged at least their view byteLength.
{
  const bytes = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  assert.equal(bytes.push({ type: 'u8', payload: new Uint8Array(64) }), true);
  assert.ok(bytes.snapshot().bytes >= 64, `Uint8Array bytes must be accounted (${bytes.snapshot().bytes})`);
  const floats = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  assert.equal(floats.push({ type: 'f64', payload: new Float64Array(32) }), true);
  assert.ok(floats.snapshot().bytes >= 256, `Float64Array bytes must be accounted (${floats.snapshot().bytes})`);
  const overBudget = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  assert.equal(overBudget.push({ type: 'u8', payload: new Uint8Array(new ArrayBuffer(1024 * 1024), 0, 512 * 1024) }), false,
    'a nested oversized view must not be retained');
  assert.equal(overBudget.events.length, 0);
}

// 4. One binary object referenced from several properties is charged exactly once.
{
  const shared = new ArrayBuffer(3000);
  const once = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  assert.equal(once.push({ type: 'shared', first: shared, second: shared }), true);
  assert.equal(once.events[0].first, once.events[0].second,
    'a shared binary object must remain one owned copy after snapshotting');
  const control = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  assert.equal(control.push({ type: 'shared', first: shared, second: {} }), true);
  assert.equal(once.snapshot().bytes, control.snapshot().bytes,
    'a shared reference must be charged once, like a cycle');
  const distinct = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  assert.equal(distinct.push({ type: 'shared', first: new ArrayBuffer(3000), second: new ArrayBuffer(3000) }), false,
    'two distinct over-budget payloads must not fit the same budget');
  assert.equal(distinct.events.length, 0);
}

// 5. Plain object/string events keep the existing ring eviction behavior.
{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096, sampleRate: 1 });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(ring.push({ type: `branch:${index}`, address: BigInt(index) }), true);
  }
  const snap = ring.snapshot();
  assert.ok(snap.events.length <= 16);
  assert.ok(ring.bytes <= 4096);
  assert.ok(snap.dropped > 0);
  assert.ok(Object.keys(snap.aggregates).length <= 16);
  const oversized = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  assert.equal(oversized.push({ type: 'huge', data: 'x'.repeat(10000) }), false);
  assert.equal(oversized.snapshot().events.length, 0);
}

// 8. Cyclic and deeply nested inputs keep their existing boundedness.
{
  const ring = new TraceRingBuffer({ maxBytes: 1024 * 1024 });
  const cyclic = { name: 'cyclic', payload: new ArrayBuffer(512) };
  cyclic.self = cyclic;
  assert.equal(ring.push(cyclic), true, 'a cyclic event stays admissible');
  assert.ok(ring.snapshot().bytes >= 512, 'the cyclic payload is still charged');

  let deep = { payload: new ArrayBuffer(64) };
  const root = deep;
  for (let index = 0; index < 60; index += 1) {
    deep.next = {};
    deep = deep.next;
  }
  const bounded = new TraceRingBuffer({ maxBytes: 1024 * 1024 });
  assert.equal(bounded.push(root), false, 'an over-deep event is still rejected');
  assert.equal(bounded.snapshot().dropped, 1);
}

console.log('  ok #4981 trace ring buffer maxBytes accounts binary payloads');