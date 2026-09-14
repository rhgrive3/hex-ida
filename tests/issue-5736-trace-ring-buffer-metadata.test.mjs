import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';

test('#5736: TraceRingBuffer preserves caller-owned __bytes and __aggregateKey properties', () => {
  const ring = new TraceRingBuffer();
  const event = {
    type: 'custom_type',
    __bytes: 'caller-owned-bytes-payload',
    __aggregateKey: 'caller-owned-key-payload',
    data: 12345,
  };

  const pushed = ring.push(event);
  assert.equal(pushed, true);

  const snapshot = ring.snapshot();
  assert.equal(snapshot.events.length, 1);
  const received = snapshot.events[0];

  assert.equal(received.type, 'custom_type');
  assert.equal(received.__bytes, 'caller-owned-bytes-payload', '__bytes must not be overwritten or deleted');
  assert.equal(received.__aggregateKey, 'caller-owned-key-payload', '__aggregateKey must not be overwritten or deleted');
  assert.equal(received.data, 12345);
  assert.deepEqual(received, event);
});

test('#5736: TraceRingBuffer preserves internal accounting and eviction when user fields collide', () => {
  const ring = new TraceRingBuffer({ maxEvents: 16 });
  const event1 = {
    type: 'alpha',
    __bytes: 999999,
    __aggregateKey: 'fake_key',
  };
  ring.push(event1);
  for (let i = 0; i < 15; i++) {
    ring.push({ type: 'beta', __bytes: 'second', __aggregateKey: 'second_key' });
  }

  assert.equal(ring.snapshot().aggregates.alpha, 1);
  assert.equal(ring.snapshot().aggregates.beta, 15);
  assert.equal(ring.snapshot().aggregates.fake_key, undefined, 'user __aggregateKey must not pollute internal aggregates');

  // Push 17th event which triggers eviction of event1
  const event17 = {
    type: 'gamma',
    payload: 'seventeenth',
  };
  ring.push(event17);

  const snap = ring.snapshot();
  assert.equal(snap.events.length, 16);
  assert.equal(snap.dropped, 1);
  assert.equal(snap.aggregates.alpha, undefined, 'evicting alpha removes it from aggregates');
  assert.equal(snap.aggregates.beta, 15);
  assert.equal(snap.aggregates.gamma, 1);

  // event1 was evicted; event17 is present at end
  assert.deepEqual(snap.events[15], event17);
});
