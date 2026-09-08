// Regression for #5680: RuntimeEventNormalizer.flush() always requested batch
// completeness 'partial' (when the queue is non-empty and nothing was dropped
// by the normalizer itself). createRuntimeEventBatch() rejects any upgrade
// above the weakest queued event, so a successfully accepted 'truncated'
// (kind:'gap') or 'unsupported' event made every subsequent flush() throw
// runtime-completeness-upgrade — and the queue was already cleared, losing
// the events. Contract now: flush() demotes the requested completeness to the
// weakest queued event instead of upgrading.
import assert from 'node:assert/strict';
import { RuntimeEventNormalizer, createRuntimeEvent, createRuntimeEventBatch } from '../js/runtime/events.js';

function makeNormalizer(options = {}) {
  return new RuntimeEventNormalizer({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
  }, options);
}

function pushObservation(normalizer, note) {
  return normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'instrumentation-observation',
    payload: { note },
  });
}

// 1. The issue's scenario: a canonical 'gap' event must not brick flush().
{
  const normalizer = makeNormalizer();
  const event = normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'gap',
    payload: { reason: 'transport-gap' },
  });
  assert.equal(event.completeness, 'truncated', 'gap events are canonical truncated');
  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'truncated', 'batch must demote to the weakest queued event');
  assert.equal(batch.events.length, 1);
}

// 2. An explicitly 'unsupported' event demotes the batch to 'unsupported'.
{
  const normalizer = makeNormalizer();
  normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'instrumentation-observation',
    payload: { note: 'x' },
    completeness: 'unsupported',
  });
  assert.equal(normalizer.flush().completeness, 'unsupported');
}

// 3. Normal partial events keep the existing 'partial' batch semantics.
{
  const normalizer = makeNormalizer();
  normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'instrumentation-observation',
    payload: { note: 'x' },
  });
  assert.equal(normalizer.flush().completeness, 'partial');
}

// 4. The weakest event wins when a partial event shares the queue with a
//    truncated one.
{
  const normalizer = makeNormalizer();
  normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'instrumentation-observation',
    payload: { note: 'a' },
  });
  normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'gap',
    payload: { reason: 'transport-gap' },
  });
  assert.equal(normalizer.flush().completeness, 'truncated');
}

// 5. Empty queue without drops keeps 'bounded'.
{
  const normalizer = makeNormalizer();
  assert.equal(normalizer.flush().completeness, 'bounded');
}

// 6. The normalizer keeps working after flushing lossy events (no bricked state).
{
  const normalizer = makeNormalizer();
  normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'gap',
    payload: { reason: 'one' },
  });
  assert.equal(normalizer.flush().completeness, 'truncated');
  normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'instrumentation-observation',
    payload: { note: 'after' },
  });
  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'partial', 'the next batch is independent again');
  assert.equal(batch.events.length, 1);
}

// 7. A canonical 'dropped-events' event is truncated and must flush.
{
  const normalizer = makeNormalizer();
  const event = normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'dropped-events',
    payload: { dropped: 3 },
  });
  assert.equal(event.completeness, 'truncated', 'dropped-events events are canonical truncated');
  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'truncated');
  assert.equal(batch.events.length, 1);
}

// 8. An explicit 'truncated' completeness on a normal observation flushes.
{
  const normalizer = makeNormalizer();
  const event = normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'instrumentation-observation',
    payload: { note: 'honest-loss' },
    completeness: 'truncated',
  });
  assert.equal(event.completeness, 'truncated');
  assert.equal(normalizer.flush().completeness, 'truncated');
}

// 9. An internal normalizer drop (queue-full) keeps the truncated contract:
//    the synthesized dropped-events marker plus the surviving queued events.
{
  const normalizer = makeNormalizer({ maxEvents: 2 });
  assert.ok(pushObservation(normalizer, 'kept-1'), 'first event is queued');
  assert.ok(pushObservation(normalizer, 'kept-2'), 'second event is queued');
  assert.equal(pushObservation(normalizer, 'overflow'), null, 'the third event is dropped internally');
  const batch = normalizer.flush();
  // The overflow drop plus the flush-time eviction (to make room for the
  // marker) both count as drops; the marker still leads the batch.
  assert.equal(batch.dropped, 2);
  assert.equal(batch.completeness, 'truncated', 'internal drop keeps the batch truncated');
  assert.equal(batch.events.length, 2, 'the drop marker plus one surviving event are delivered');
  assert.equal(batch.events[0].kind, 'dropped-events');
}

// 10. An internal drop combined with a queued unsupported event must not
//     upgrade the source: 'unsupported' wins over the drop's 'truncated'.
{
  const normalizer = makeNormalizer({ maxEvents: 2 });
  const queued = normalizer.push({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    kind: 'instrumentation-observation',
    payload: { note: 'honest-unsupported' },
    completeness: 'unsupported',
  });
  assert.ok(queued);
  assert.ok(pushObservation(normalizer, 'kept-2'));
  assert.equal(pushObservation(normalizer, 'overflow'), null);
  const batch = normalizer.flush();
  assert.equal(batch.dropped, 2);
  assert.equal(batch.completeness, 'unsupported', 'the weakest source completeness must win');
  assert.ok(batch.events.some((event) => event.completeness === 'unsupported'));
}

// 11. createRuntimeEventBatch() keeps its conservative upgrade rejection.
{
  assert.throws(() => createRuntimeEventBatch({
    runtimeSessionId: 'session-1',
    providerId: 'provider-1',
    sessionEpoch: 1,
    events: [createRuntimeEvent({
      runtimeSessionId: 'session-1',
      providerId: 'provider-1',
      sessionEpoch: 1,
      kind: 'gap',
      payload: { reason: 'transport-gap' },
    })],
    completeness: 'complete',
    dropped: 0,
  }), (error) => error.code === 'runtime-completeness-upgrade',
  'an upgrade above the weakest queued event must still be rejected');
}

console.log('issue-5680 runtime normalizer flush completeness: ok');
