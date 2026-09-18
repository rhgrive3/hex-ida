// Regression for #5680: RuntimeEventNormalizer.flush() must never upgrade
// weaker queued evidence when forming a batch.
import assert from 'node:assert/strict';
import { RuntimeEventNormalizer, createRuntimeEvent, createRuntimeEventBatch } from '../../../js/runtime/events.js';

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

{
  const normalizer = makeNormalizer();
  const event = normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'gap', payload: { reason: 'transport-gap' },
  });
  assert.equal(event.completeness, 'truncated');
  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'truncated');
  assert.equal(batch.events.length, 1);
}

{
  const normalizer = makeNormalizer();
  normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'instrumentation-observation', payload: { note: 'x' }, completeness: 'unsupported',
  });
  assert.equal(normalizer.flush().completeness, 'unsupported');
}

{
  const normalizer = makeNormalizer();
  normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'instrumentation-observation', payload: { note: 'x' },
  });
  assert.equal(normalizer.flush().completeness, 'partial');
}

{
  const normalizer = makeNormalizer();
  normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'instrumentation-observation', payload: { note: 'a' },
  });
  normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'gap', payload: { reason: 'transport-gap' },
  });
  assert.equal(normalizer.flush().completeness, 'truncated');
}

{
  const normalizer = makeNormalizer();
  assert.equal(normalizer.flush().completeness, 'bounded');
}

{
  const normalizer = makeNormalizer();
  normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'gap', payload: { reason: 'one' },
  });
  assert.equal(normalizer.flush().completeness, 'truncated');
  normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'instrumentation-observation', payload: { note: 'after' },
  });
  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'partial');
  assert.equal(batch.events.length, 1);
}

{
  const normalizer = makeNormalizer();
  const event = normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'dropped-events', payload: { dropped: 3 },
  });
  assert.equal(event.completeness, 'truncated');
  const batch = normalizer.flush();
  assert.equal(batch.completeness, 'truncated');
  assert.equal(batch.events.length, 1);
}

{
  const normalizer = makeNormalizer();
  const event = normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'instrumentation-observation', payload: { note: 'honest-loss' }, completeness: 'truncated',
  });
  assert.equal(event.completeness, 'truncated');
  assert.equal(normalizer.flush().completeness, 'truncated');
}

{
  const normalizer = makeNormalizer({ maxEvents: 2 });
  assert.ok(pushObservation(normalizer, 'kept-1'));
  assert.ok(pushObservation(normalizer, 'kept-2'));
  assert.equal(pushObservation(normalizer, 'overflow'), null);
  const batch = normalizer.flush();
  assert.equal(batch.dropped, 2);
  assert.equal(batch.completeness, 'truncated');
  assert.equal(batch.events.length, 2);
  assert.equal(batch.events[0].kind, 'dropped-events');
}

{
  const normalizer = makeNormalizer({ maxEvents: 2 });
  const queued = normalizer.push({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    kind: 'instrumentation-observation', payload: { note: 'honest-unsupported' }, completeness: 'unsupported',
  });
  assert.ok(queued);
  assert.ok(pushObservation(normalizer, 'kept-2'));
  assert.equal(pushObservation(normalizer, 'overflow'), null);
  const batch = normalizer.flush();
  assert.equal(batch.dropped, 2);
  assert.equal(batch.completeness, 'unsupported');
  assert.ok(batch.events.some((event) => event.completeness === 'unsupported'));
}

{
  assert.throws(() => createRuntimeEventBatch({
    runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
    events: [createRuntimeEvent({
      runtimeSessionId: 'session-1', providerId: 'provider-1', sessionEpoch: 1,
      kind: 'gap', payload: { reason: 'transport-gap' },
    })],
    completeness: 'complete', dropped: 0,
  }), (error) => error.code === 'runtime-completeness-upgrade');
}

console.log('issue-5680 runtime normalizer flush completeness: ok');
