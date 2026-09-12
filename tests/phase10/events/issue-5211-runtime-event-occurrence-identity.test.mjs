import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeEvent } from '../../../js/runtime/events.js';
import { RuntimeEvidenceBridge } from '../../../js/runtime/evidence-bridge.js';

const base = Object.freeze({
  runtimeSessionId: 'session-5211',
  providerId: 'provider-5211',
  providerVersion: '1',
  sessionEpoch: 1,
  kind: 'memory-read',
  payload: { address: '0x1000', value: 1 },
  completeness: 'bounded',
  observationMode: 'observed',
});

test('#5211 fallback event identity distinguishes timestamped occurrences', () => {
  const first = createRuntimeEvent({ ...base, timestamp: '2026-09-03T00:00:00.000Z' });
  const second = createRuntimeEvent({ ...base, timestamp: '2026-09-03T00:00:01.000Z' });

  assert.notEqual(first.eventId, second.eventId);
});

test('#5211 repeated fallback events do not collide in RuntimeEvidenceBridge', () => {
  const bridge = new RuntimeEvidenceBridge();
  const first = createRuntimeEvent({ ...base, timestamp: '2026-09-03T00:00:00.000Z' });
  const second = createRuntimeEvent({ ...base, timestamp: '2026-09-03T00:00:01.000Z' });

  const firstEvidence = bridge.eventToEvidence(first);
  const secondEvidence = bridge.eventToEvidence(second);

  assert.notEqual(firstEvidence.id, secondEvidence.id);
  assert.equal(bridge.graph.allNodes().length, 2);
});

test('#5211 providerEventId keeps provider-owned stable identity across timestamps', () => {
  const first = createRuntimeEvent({ ...base, providerEventId: 'provider-event-7', timestamp: '2026-09-03T00:00:00.000Z' });
  const second = createRuntimeEvent({ ...base, providerEventId: 'provider-event-7', timestamp: '2026-09-03T00:00:01.000Z' });

  assert.equal(first.eventId, second.eventId);
});

test('#5211 stream sequence keeps provider-owned stable identity across timestamps', () => {
  const first = createRuntimeEvent({ ...base, streamId: 'stream-a', sequence: 9, timestamp: '2026-09-03T00:00:00.000Z' });
  const second = createRuntimeEvent({ ...base, streamId: 'stream-a', sequence: 9, timestamp: '2026-09-03T00:00:01.000Z' });

  assert.equal(first.eventId, second.eventId);
});

test('#5211 exact fallback replay remains idempotent', () => {
  const first = createRuntimeEvent({ ...base, timestamp: '2026-09-03T00:00:00.000Z' });
  const second = createRuntimeEvent({ ...base, timestamp: '2026-09-03T00:00:00.000Z' });

  assert.equal(first.eventId, second.eventId);
});

test('#5211 fallback semantic provenance participates in auto identity', () => {
  const timestamp = '2026-09-03T00:00:00.000Z';
  const observed = createRuntimeEvent({ ...base, timestamp, observationMode: 'observed' });
  const synthetic = createRuntimeEvent({ ...base, timestamp, observationMode: 'synthetic' });
  const partial = createRuntimeEvent({ ...base, timestamp, completeness: 'partial' });
  const intervened = createRuntimeEvent({ ...base, timestamp, interventionIds: ['intervention-a'] });
  const causallyLinked = createRuntimeEvent({ ...base, timestamp, predecessorIds: ['event-a'] });

  assert.notEqual(observed.eventId, synthetic.eventId);
  assert.notEqual(observed.eventId, partial.eventId);
  assert.notEqual(observed.eventId, intervened.eventId);
  assert.notEqual(observed.eventId, causallyLinked.eventId);
});

test('#5211 normalizer assigns distinct auto identities without fabricating stream order', async () => {
  const { RuntimeEventNormalizer } = await import('../../../js/runtime/events.js');
  const normalizer = new RuntimeEventNormalizer({
    runtimeSessionId: base.runtimeSessionId,
    providerId: base.providerId,
    providerVersion: base.providerVersion,
    sessionEpoch: base.sessionEpoch,
  });
  const first = normalizer.push({ kind: 'call', payload: { target: 'helper' } });
  const second = normalizer.push({ kind: 'call', payload: { target: 'helper' } });

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(first.streamId, null);
  assert.equal(second.streamId, null);
  assert.equal(first.sequence, null);
  assert.equal(second.sequence, null);
  const batch = normalizer.flush();
  assert.equal(new Set(batch.events.map((event) => event.eventId)).size, batch.events.length);
});

test('#5211 normalizer occurrence identity remains unique across flushes', async () => {
  const { RuntimeEventNormalizer } = await import('../../../js/runtime/events.js');
  const normalizer = new RuntimeEventNormalizer({
    runtimeSessionId: base.runtimeSessionId,
    providerId: base.providerId,
    providerVersion: base.providerVersion,
    sessionEpoch: base.sessionEpoch,
  });
  const first = normalizer.push({ kind: 'return', payload: { value: 1 } });
  normalizer.flush();
  const second = normalizer.push({ kind: 'return', payload: { value: 1 } });

  assert.notEqual(first.eventId, second.eventId);
  assert.equal(second.sequence, null);
});

test('#5211 timestamp identity refuses structured coercion', () => {
  let coercions = 0;
  const hostile = { toString() { coercions++; return '2026-09-03T00:00:00.000Z'; } };
  assert.throws(
    () => createRuntimeEvent({ ...base, timestamp: hostile }),
    (error) => error?.code === 'runtime-invalid-event-text',
  );
  assert.equal(coercions, 0);
});

test('#5211 normalizer loss markers remain distinct across flush windows', async () => {
  const { RuntimeEventNormalizer } = await import('../../../js/runtime/events.js');
  const normalizer = new RuntimeEventNormalizer({
    runtimeSessionId: base.runtimeSessionId,
    providerId: base.providerId,
    providerVersion: base.providerVersion,
    sessionEpoch: base.sessionEpoch,
  }, { maxEvents: 2, maxBytes: 65536 });

  normalizer.push({ kind: 'call', payload: { target: 'a' } });
  normalizer.push({ kind: 'call', payload: { target: 'b' } });
  assert.equal(normalizer.push({ kind: 'call', payload: { target: 'c' } }), null);
  const firstMarker = normalizer.flush().events.find((event) => event.kind === 'dropped-events');

  normalizer.push({ kind: 'call', payload: { target: 'a' } });
  normalizer.push({ kind: 'call', payload: { target: 'b' } });
  assert.equal(normalizer.push({ kind: 'call', payload: { target: 'c' } }), null);
  const secondMarker = normalizer.flush().events.find((event) => event.kind === 'dropped-events');

  assert.ok(firstMarker);
  assert.ok(secondMarker);
  assert.notEqual(firstMarker.eventId, secondMarker.eventId);
  assert.equal(firstMarker.streamId, null);
  assert.equal(secondMarker.sequence, null);
});

test('#5211 fallback observation mode changes cannot collide in evidence graph', () => {
  const bridge = new RuntimeEvidenceBridge();
  const timestamp = '2026-09-03T00:00:00.000Z';
  const observed = bridge.eventToEvidence(createRuntimeEvent({ ...base, timestamp, observationMode: 'observed' }));
  const synthetic = bridge.eventToEvidence(createRuntimeEvent({ ...base, timestamp, observationMode: 'synthetic' }));

  assert.notEqual(observed.id, synthetic.id);
  assert.equal(bridge.graph.allNodes().length, 2);
});

test('#5211 fallback intervention lineage changes cannot collide in evidence graph', () => {
  const bridge = new RuntimeEvidenceBridge();
  const firstIntervention = bridge.interventions.add({
    runtimeSessionId: base.runtimeSessionId,
    providerId: base.providerId,
    kind: 'register-write',
    target: { register: 'x0' },
    requestedChange: { value: '1' },
    sequence: 1,
  });
  const secondIntervention = bridge.interventions.add({
    runtimeSessionId: base.runtimeSessionId,
    providerId: base.providerId,
    kind: 'register-write',
    target: { register: 'x0' },
    requestedChange: { value: '1' },
    sequence: 2,
  });
  const timestamp = '2026-09-03T00:00:00.000Z';
  const first = bridge.eventToEvidence(createRuntimeEvent({ ...base, timestamp, interventionIds: [firstIntervention.interventionId] }));
  const second = bridge.eventToEvidence(createRuntimeEvent({ ...base, timestamp, interventionIds: [secondIntervention.interventionId] }));

  assert.notEqual(first.id, second.id);
  assert.equal(bridge.graph.allNodes().length, 2);
});
