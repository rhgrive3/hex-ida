import assert from 'node:assert/strict';

import { TraceRingBuffer } from '../js/trace/ring-buffer.js';

{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  let toJSONCalls = 0;
  const huge = {
    type: 'instruction',
    payload: 'A'.repeat(1_000_000),
    toJSON() {
      toJSONCalls += 1;
      return { type: 'instruction' };
    },
  };
  assert.equal(ring.push(huge), false, 'a 1MB payload must not pass a 4096-byte budget');
  assert.equal(toJSONCalls, 0, 'size accounting must never invoke an event-defined toJSON');
  assert.equal(ring.bytes, 0, 'rejected events must not be charged');
  assert.equal(ring.snapshot().events.length, 0, 'rejected events must not be retained');
}

{
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  const push = ring.push({ type: 'mem', view: new DataView(new ArrayBuffer(1_000_000)) });
  assert.equal(push, false, 'a 1MB DataView must not pass a 4096-byte budget');
  assert.equal(ring.bytes, 0, 'oversized retained buffer must not be charged as a few bytes');
  assert.equal(ring.snapshot().events.length, 0, 'oversized retained buffer must not be retained');
}

{
  const ring = new TraceRingBuffer({ maxEvents: 16 });
  assert.equal(ring.push({ type: 'mem', view: new DataView(new ArrayBuffer(64)) }), true);
  assert.ok(ring.bytes >= 64, `byte accounting must cover the retained view byteLength (got ${ring.bytes})`);
}

{
  const ring = new TraceRingBuffer({ maxEvents: 16 });
  assert.equal(ring.push({ type: 'bytes', payload: new Uint8Array(2000) }), true);
  assert.ok(ring.bytes >= 2000, `typed-array payload must be charged at least its byteLength (got ${ring.bytes})`);
  const events = ring.snapshot().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.length, 2000, 'typed-array snapshot semantics must be preserved');
}

{
  const ring = new TraceRingBuffer({ maxEvents: 16 });
  assert.equal(ring.push({ type: 'addr', address: 0xdead_beefn, taken: true }), true);
  assert.ok(ring.bytes > 0, 'BigInt must remain accounted');
  const events = ring.snapshot().events;
  assert.equal(events[0].address, 0xdead_beefn);
  assert.equal(events[0].taken, true);
}

{
  const ring = new TraceRingBuffer({ maxEvents: 16 });
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;
  assert.equal(ring.push(cyclic), true, 'bounded circular handling must be preserved');
  assert.ok(Number.isFinite(ring.bytes) && ring.bytes > 0 && ring.bytes < 1024, `circular accounting must stay bounded (got ${ring.bytes})`);
}

{
  const ring = new TraceRingBuffer({ maxEvents: 16 });
  assert.equal(ring.push({ type: 'instruction', pc: 0x1000, taken: true, note: 'hello' }), true);
  const events = ring.snapshot().events;
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0] }, { type: 'instruction', pc: 0x1000, taken: true, note: 'hello' });
  assert.equal(ring.bytes, ring.events.reduce((total, entry) => total + entry.__bytes, 0), 'bytes must equal the sum of retained event accounting');
}

console.log('issue-4636 trace ring buffer toJSON/byte-accounting regression: PASS');
