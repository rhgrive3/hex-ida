import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeEventNormalizer } from '../../../js/runtime/events.js';

const context = {
  runtimeSessionId: 'runtime-4646',
  providerId: 'provider-4646',
  providerVersion: '1',
  sessionEpoch: 1,
};

function normalizer() {
  return new RuntimeEventNormalizer(context, { maxEvents:16, maxBytes:1024 });
}

function oversizedLazyStrings(prefix, reads, { length = 1_000_000, sentinelAt = 4096 } = {}) {
  const target = [];
  target.length = length;
  return new Proxy(target, {
    get(array, key, receiver) {
      if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) {
        const index = Number(key);
        reads.count += 1;
        if (index >= sentinelAt) throw new Error(`walked-past-budget:${prefix}:${index}`);
        return `${prefix}-${index}`;
      }
      return Reflect.get(array, key, receiver);
    },
    has(array, key) {
      if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) return true;
      return Reflect.has(array, key);
    },
  });
}

function assertBoundedDrop(makeInput) {
  const reads = { count:0 };
  const n = normalizer();
  let accepted;
  assert.doesNotThrow(() => {
    accepted = n.push(makeInput(oversizedLazyStrings('id', reads)));
  });
  assert.equal(accepted, null);
  assert.ok(reads.count < 4096, `preflight must stop before expensive canonicalization; reads=${reads.count}`);
  const batch = n.flush();
  assert.equal(batch.dropped, 1);
  assert.equal(batch.completeness, 'truncated');
}

test('#4646 rejects oversized predecessorIds before createRuntimeEvent walks the whole array', () => {
  assertBoundedDrop((ids) => ({ ...context, kind:'trace-marker', payload:{}, predecessorIds:ids }));
});

test('#4646 rejects oversized interventionIds before createRuntimeEvent walks the whole array', () => {
  assertBoundedDrop((ids) => ({ ...context, kind:'trace-marker', payload:{}, interventionIds:ids }));
});

test('#4646 preserves an early byte guard for oversized canonical payload graphs', () => {
  assertBoundedDrop((values) => ({ ...context, kind:'trace-marker', payload:{ values } }));
});

test('#4646 applies the same bounded admission to legacy event payloads', () => {
  assertBoundedDrop((values) => ({ type:'trace', payload:{ values } }));
});

test('#4646 bounds raw metadata even when jsonSafe would omit every value', () => {
  const payload = {};
  for (let index = 0; index < 5000; index += 1) payload[`ignored-${index}`] = undefined;
  const n = normalizer();
  assert.equal(n.push({ ...context, kind:'trace-marker', payload }), null);
  const batch = n.flush();
  assert.equal(batch.dropped, 1);
  assert.equal(batch.completeness, 'truncated');
});

test('#4646 fails closed on cyclic event metadata before canonical serialization', () => {
  const payload = { marker:'cycle' };
  payload.self = payload;
  const n = normalizer();
  let accepted;
  assert.doesNotThrow(() => {
    accepted = n.push({ ...context, kind:'trace-marker', payload });
  });
  assert.equal(accepted, null);
  const batch = n.flush();
  assert.equal(batch.dropped, 1);
  assert.equal(batch.completeness, 'truncated');
});

test('#4646 keeps ordinary in-budget canonical and legacy events admissible', () => {
  const canonical = normalizer();
  assert.ok(canonical.push({ ...context, kind:'trace-marker', payload:{ value:1 }, predecessorIds:['a'], interventionIds:['b'] }));
  assert.equal(canonical.flush().dropped, 0);

  const legacy = normalizer();
  assert.ok(legacy.push({ type:'trace', payload:{ value:1 }, predecessorIds:['a'], interventionIds:['b'] }));
  assert.equal(legacy.flush().dropped, 0);
});

test('#4646 bounds long scalar event metadata before canonical serialization', () => {
  for (const field of ['eventId', 'timestamp', 'streamId', 'providerEventId', 'processKey']) {
    const n = normalizer();
    assert.equal(n.push({ ...context, kind:'trace-marker', payload:{}, [field]:'x'.repeat(4096) }), null, field);
    const batch = n.flush();
    assert.equal(batch.dropped, 1, field);
    assert.equal(batch.completeness, 'truncated', field);
  }
});

test('#4646 snapshots admitted scalar metadata once before use', () => {
  let reads = 0;
  const input = { ...context, kind:'trace-marker', payload:{} };
  Object.defineProperty(input, 'timestamp', {
    enumerable:true,
    get() {
      reads += 1;
      return reads === 1 ? '2026-09-10T00:00:00.000Z' : 'x'.repeat(4096);
    },
  });
  const n = normalizer();
  const event = n.push(input);
  assert.ok(event);
  assert.equal(event.timestamp, '2026-09-10T00:00:00.000Z');
  assert.equal(reads, 1);
});
