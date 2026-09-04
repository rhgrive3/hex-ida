import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeEvent, RuntimeEventNormalizer } from '../../../js/runtime/events.js';

function runtimeEvent(overrides = {}) {
  return createRuntimeEvent({
    runtimeSessionId: 'session-A',
    providerId: 'provider-A',
    sessionEpoch: 1,
    kind: 'trace-marker',
    payload: { ok: true },
    ...overrides,
  });
}

function runtimeNormalizer(context = {}) {
  return new RuntimeEventNormalizer({
    runtimeSessionId: 'session-A',
    providerId: 'provider-A',
    sessionEpoch: 1,
    ...context,
  });
}

test('P10 #3807 RuntimeEventNormalizer rejects foreign direct identities before queue/dedupe mutation', () => {
  const normalizer = runtimeNormalizer();

  assert.ok(normalizer.push(runtimeEvent({ providerEventId: 'first' })));
  const queuedBytes = normalizer.queuedBytes;

  assert.equal(normalizer.push(runtimeEvent({
    runtimeSessionId: 'session-B',
    providerEventId: 'collision',
  })), null);
  assert.equal(normalizer.queuedBytes, queuedBytes);

  assert.equal(normalizer.push(runtimeEvent({
    providerId: 'provider-B',
    providerEventId: 'foreign-provider',
  })), null);
  assert.equal(normalizer.queuedBytes, queuedBytes);

  assert.equal(normalizer.push(runtimeEvent({
    runtimeSessionId: 'session-B',
    providerId: 'provider-B',
    providerEventId: 'foreign-both',
  })), null);
  assert.equal(normalizer.queuedBytes, queuedBytes);

  assert.equal(normalizer.push(runtimeEvent({
    sessionEpoch: 2,
    providerEventId: 'stale-epoch',
  })), null);
  assert.equal(normalizer.queuedBytes, queuedBytes);

  // The rejected foreign event must not reserve its providerEventId in #seen.
  assert.ok(normalizer.push(runtimeEvent({ providerEventId: 'collision' })));

  const batch = normalizer.flush();
  assert.equal(batch.dropped, 0);
  assert.deepEqual(batch.events.map((event) => event.providerEventId), ['first', 'collision']);
  assert.ok(batch.events.every((event) => event.runtimeSessionId === 'session-A'));
  assert.ok(batch.events.every((event) => event.providerId === 'provider-A'));
  assert.ok(batch.events.every((event) => event.sessionEpoch === 1));
});

test('P10 #3807 legacy events keep using the canonicalized normalizer context identity', () => {
  const normalizer = runtimeNormalizer({
    runtimeSessionId: ' session-A ',
    providerId: ' provider-A ',
  });

  const accepted = normalizer.push({
    type: 'event',
    event: 'trace-marker',
    id: 'legacy-1',
    data: { legacy: true },
  });
  assert.ok(accepted);
  assert.equal(accepted.runtimeSessionId, 'session-A');
  assert.equal(accepted.providerId, 'provider-A');

  const batch = normalizer.flush();
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].providerEventId, 'legacy-1');
  assert.equal(batch.runtimeSessionId, 'session-A');
  assert.equal(batch.providerId, 'provider-A');
});
