import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeAuthorityTracker,
  createRuntimeAuthorityBinding,
  createRuntimeObservation,
} from '../../../js/runtime/authority.js';

function validBinding() {
  return createRuntimeAuthorityBinding({
    providerIdentity: 'provider-1',
    runtimeInstanceIdentity: 'runtime-1',
    targetIdentity: 'target-1',
    binaryIdentity: 'binary-1',
    moduleIdentity: 'module-1',
    loadMappingIdentity: 'mapping-1',
    sessionIdentity: 'session-1',
    capabilityVersion: 'cap-v1',
    epoch: 0,
  });
}

function mutableObservation(binding, overrides = {}) {
  return structuredClone(createRuntimeObservation({
    binding,
    sequence: 0,
    observedAt: '2026-09-05T00:00:00Z',
    kind: 'register-snapshot',
    payload: { registers: { x0: '1' }, lanes: ['a', 'b'] },
    ...overrides,
  }));
}

test('P10 runtime authority tracker owns accepted schema observations (#4408)', () => {
  const binding = validBinding();
  const input = mutableObservation(binding);
  const tracker = new RuntimeAuthorityTracker(binding);

  assert.equal(tracker.accept(input).status, 'accepted');
  input.payload.registers.x0 = '999';
  input.payload.lanes.push('c');
  input.kind = 'exception';
  input.observedAt = '2099-01-01T00:00:00Z';

  const stored = tracker.observations[0];
  assert.equal(stored.kind, 'register-snapshot');
  assert.equal(stored.observedAt, '2026-09-05T00:00:00Z');
  assert.equal(stored.payload.registers.x0, '1');
  assert.deepEqual(stored.payload.lanes, ['a', 'b']);
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.payload), true);
  assert.equal(Object.isFrozen(stored.payload.registers), true);
  assert.equal(Object.isFrozen(stored.payload.lanes), true);
});

test('P10 runtime authority snapshot cannot expose mutable tracker records (#4408)', () => {
  const binding = validBinding();
  const tracker = new RuntimeAuthorityTracker(binding);
  const input = mutableObservation(binding);
  const accepted = tracker.accept(input);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.observations[0].observationId, accepted.observationId);
  assert.throws(() => {
    snapshot.observations[0].payload.registers.x0 = '999';
  }, TypeError);
  assert.equal(tracker.observations[0].payload.registers.x0, '1');
});

test('P10 runtime authority tracker still rejects invalid observation identity (#4408)', () => {
  const binding = validBinding();
  const tracker = new RuntimeAuthorityTracker(binding);
  const input = mutableObservation(binding);
  input.observationId = 'runtime-observation:forged';

  const result = tracker.accept(input);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'runtime-observation-identity-invalid');
  assert.equal(tracker.observations.length, 0);
  assert.equal(tracker.lastSequence, -1);
});

test('P10 runtime authority tracker preserves canonical factory observations (#4408)', () => {
  const binding = validBinding();
  const tracker = new RuntimeAuthorityTracker(binding);
  const canonical = createRuntimeObservation({
    binding,
    sequence: 0,
    observedAt: '2026-09-05T00:00:00Z',
    kind: 'register-snapshot',
    payload: { x0: '1' },
  });

  const result = tracker.accept(canonical);
  assert.equal(result.status, 'accepted');
  assert.equal(result.observationId, canonical.observationId);
  assert.equal(tracker.observations[0].observationId, canonical.observationId);
  assert.deepEqual(tracker.observations[0].payload, { x0: '1' });
});

test('P10 runtime authority tracker isolates Map and Set payloads against mutation (#4408)', () => {
  const binding = validBinding();
  const tracker = new RuntimeAuthorityTracker(binding);
  const inputMap = new Map([['n', 1]]);
  const inputSet = new Set(['alpha']);
  const canonical = createRuntimeObservation({
    binding,
    sequence: 0,
    observedAt: '2026-09-05T00:00:00Z',
    kind: 'structured-state',
    payload: { map: inputMap, set: inputSet },
  });

  const accepted = tracker.accept(canonical);
  assert.equal(accepted.status, 'accepted');

  // Post-accept mutation of source Map/Set cannot affect stored tracker state
  inputMap.set('n', 999);
  inputSet.add('forged');
  assert.equal(tracker.observations[0].payload.map.get('n'), 1);
  assert.equal(tracker.observations[0].payload.set.has('forged'), false);

  // Snapshot cannot expose mutable Map/Set references
  const snapshot = tracker.snapshot();
  assert.throws(() => {
    snapshot.observations[0].payload.map.set('n', 2);
  }, TypeError);
  assert.throws(() => {
    snapshot.observations[0].payload.set.add('beta');
  }, TypeError);

  assert.equal(tracker.observations[0].payload.map.get('n'), 1);
  assert.equal(tracker.observations[0].payload.set.has('beta'), false);
  assert.equal(tracker.observations[0].observationId, accepted.observationId);
});

test('P10 runtime authority tracker isolates Uint8Array and ArrayBuffer payloads against mutation (#4408)', () => {
  const binding = validBinding();
  const tracker = new RuntimeAuthorityTracker(binding);
  const rawBytes = new Uint8Array([1, 2, 3]);
  const rawBuffer = new Uint8Array([4, 5]).buffer;
  const canonical = createRuntimeObservation({
    binding,
    sequence: 0,
    observedAt: '2026-09-05T00:00:00Z',
    kind: 'buffer-snapshot',
    payload: { bytes: rawBytes, buffer: rawBuffer },
  });

  const accepted = tracker.accept(canonical);
  assert.equal(accepted.status, 'accepted');

  // Post-accept mutation of source typed array cannot affect tracker
  rawBytes[0] = 99;
  assert.equal(tracker.observations[0].payload.bytes[0], 1);

  // Post-snapshot mutation cannot alter stored tracker bytes or committed identity
  const snapshot = tracker.snapshot();
  snapshot.observations[0].payload.bytes[0] = 77;
  new Uint8Array(snapshot.observations[0].payload.buffer)[0] = 88;

  assert.equal(tracker.observations[0].payload.bytes[0], 1);
  assert.equal(new Uint8Array(tracker.observations[0].payload.buffer)[0], 4);
  assert.equal(tracker.snapshot().observations[0].payload.bytes[0], 1);
  assert.equal(tracker.observations[0].observationId, accepted.observationId);
});

