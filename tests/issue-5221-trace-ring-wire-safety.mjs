import assert from 'node:assert/strict';

import { TraceRingBuffer } from '../js/trace/ring-buffer.js';
import { DebugSession } from '../js/runtime/session.js';
import { encodeWireValue } from '../js/debug/remote-protocol.js';

// #5221: TraceRingBuffer's acceptance contract and the persistence wire
// contract must agree even for acyclic values. An event that push()/
// acceptEvent() admits must survive the session's official serialize()/
// replayShape(). Cyclic events are owned by #3909 and are exercised only to
// prove this fix does not regress them (see the separate #3909 regression).

function adapterFixture() {
  return {
    id: 'trace-wire-safe-fixture',
    kind: 'fixture',
    capabilities: { modules: false, threads: false },
    async disconnect() {},
  };
}

function snapshotEncodes(buffer) {
  let outcome = 'OK';
  try { encodeWireValue(buffer.snapshot()); }
  catch (error) { outcome = `THROW:${error.message}`; }
  return outcome;
}

// (1) plain event + BigInt/Uint8Array stays retained and serializable.
{
  const ring = new TraceRingBuffer();
  const event = { type: 'memory-write', address: 0x2000n, bytes: new Uint8Array([1, 2, 3, 4]), taken: true };
  assert.equal(ring.push(event), true, 'wire-safe acyclic event must be accepted');
  assert.equal(ring.snapshot().events.length, 1);
  assert.equal(ring.snapshot().events[0].address, 0x2000n);
  assert.deepEqual([...ring.snapshot().events[0].bytes], [1, 2, 3, 4]);
  assert.equal(snapshotEncodes(ring), 'OK', 'retained wire-safe event must encode');
}

// (2) acyclic function field must not be retained unserializably.
{
  const ring = new TraceRingBuffer();
  assert.equal(ring.push({ type: 'trace', callback() {} }), false, 'function field must be rejected at push');
  assert.equal(ring.snapshot().events.length, 0);
  assert.equal(snapshotEncodes(ring), 'OK');
}

// (3) acyclic Date must not be retained unserializably.
{
  const ring = new TraceRingBuffer();
  assert.equal(ring.push({ type: 'trace', at: new Date(0) }), false, 'Date field must be rejected at push');
  assert.equal(ring.snapshot().events.length, 0);
  assert.equal(snapshotEncodes(ring), 'OK');
}

// (4) symbol / undefined field / non-finite numbers are pinned to the reject
// side of the contract; a nested class instance is normalized to plain data
// and therefore stays accepted (matching the wire codec).
{
  const symbolRing = new TraceRingBuffer();
  assert.equal(symbolRing.push({ type: 'trace', s: Symbol('x') }), false, 'symbol field must be rejected at push');
  assert.equal(snapshotEncodes(symbolRing), 'OK');

  const undefinedRing = new TraceRingBuffer();
  assert.equal(undefinedRing.push({ type: 'trace', value: undefined }), false, 'undefined field must be rejected at push');
  assert.equal(snapshotEncodes(undefinedRing), 'OK');

  const nonFiniteRing = new TraceRingBuffer();
  assert.equal(nonFiniteRing.push({ type: 'trace', ratio: Infinity }), false, 'non-finite number must be rejected at push');
  assert.equal(snapshotEncodes(nonFiniteRing), 'OK');

  const nestedRing = new TraceRingBuffer();
  class Box { constructor() { this.value = 7; } }
  assert.equal(nestedRing.push({ type: 'trace', box: new Box() }), true, 'class instance must normalize to plain data');
  assert.equal(snapshotEncodes(nestedRing), 'OK');
  assert.deepEqual(nestedRing.snapshot().events[0].box, { value: 7 });
}

// (5) a rejected value must not corrupt byte accounting for the ring: every
// retained event is wire-encodable and bytes equals the sum of retained sizes.
{
  const ring = new TraceRingBuffer();
  ring.push({ type: 'trace', bad: new Date(0) });
  ring.push({ type: 'trace', address: 0x10n });
  ring.push({ type: 'trace', cb() {} });
  const events = ring.snapshot().events;
  assert.equal(events.length, 1, 'only the wire-safe event is retained');
  const retained = ring.events.reduce((total, entry) => total + (entry.__bytes || 0), 0);
  assert.equal(ring.bytes, retained, 'byte accounting must match retained representation');
  assert.equal(snapshotEncodes(ring), 'OK');
}

// (6) DebugSession end-to-end: a non-cyclic event admitted via acceptEvent or
// a direct push into the session's ring keeps serialize()/replayShape() working.
{
  const session = new DebugSession(adapterFixture(), { id: 'session-serialize-invariant' });
  assert.equal(session.acceptEvent({ type: 'trace', epoch: 1, address: 0x30n, bytes: new Uint8Array([9]) }), true);
  assert.equal(session.traces.push({ type: 'trace', epoch: 1, at: new Date(0) }), false, 'ring must reject the Date even on the session path');
  assert.equal(session.traces.snapshot().events.length, 1, 'only the accepted wire-safe event remains');
  assert.doesNotThrow(() => session.serialize(), 'session with accepted acyclic events must serialize');
  assert.doesNotThrow(() => session.replayShape(), 'session with accepted acyclic events must replay');
}

// (7) cyclic handling stays owned by #3909: this fix must not change it. The
// ring still accepts a cyclic event (#1048) and DebugSession still rejects one
// before retention (#3909).
{
  const ring = new TraceRingBuffer();
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;
  assert.equal(ring.push(cyclic), true, 'cyclic acceptance is #1048/#3909 scope and must be unchanged');

  const session = new DebugSession(adapterFixture(), { id: 'cycle-guard-intact' });
  const self = { type: 'branch', epoch: 1 };
  self.self = self;
  assert.equal(session.acceptEvent(self), false, 'cyclic rejection at the session boundary must be unchanged');
  assert.equal(session.traces.snapshot().events.length, 0);
}

console.log('issue #5221 trace ring buffer wire-safety regressions PASS');
