import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceRingBuffer } from '../../js/trace/ring-buffer.js';

function populatedRing() {
  const ring = new TraceRingBuffer({ maxEvents: 16, maxBytes: 4096 });
  for (let sequence = 0; sequence < 5; sequence += 1) {
    assert.equal(ring.push({ type: 'branch', sequence }), true);
  }
  return ring;
}

function sequences(snapshot) {
  return snapshot.events.map((event) => event.sequence);
}

test('#2966 snapshot limit accepts only finite numeric authority', () => {
  const ring = populatedRing();

  assert.deepEqual(sequences(ring.snapshot({ limit: 2 })), [3, 4]);
  assert.deepEqual(sequences(ring.snapshot({ limit: 2.9 })), [3, 4], 'finite numeric limits keep floor semantics');
  assert.deepEqual(sequences(ring.snapshot({ limit: 0 })), [], 'zero keeps the existing empty-snapshot contract');
  assert.deepEqual(sequences(ring.snapshot({ limit: -4 })), [], 'negative numeric limits remain clamped to zero');

  const all = [0, 1, 2, 3, 4];
  for (const malformed of [
    '2',
    ['2'],
    true,
    false,
    { valueOf() { return 2; } },
    { toString() { return '2'; } },
  ]) {
    assert.deepEqual(
      sequences(ring.snapshot({ limit: malformed })),
      all,
      `non-number limit must fail closed instead of selecting a subset: ${Object.prototype.toString.call(malformed)}`,
    );
  }

  assert.deepEqual(sequences(ring.snapshot({ limit: Number.NaN })), all);
  assert.deepEqual(sequences(ring.snapshot({ limit: Number.POSITIVE_INFINITY })), all);
  assert.deepEqual(sequences(ring.snapshot({ limit: Number.NEGATIVE_INFINITY })), all);
  assert.deepEqual(sequences(ring.snapshot()), all, 'default snapshot ordering and completeness are unchanged');
});
