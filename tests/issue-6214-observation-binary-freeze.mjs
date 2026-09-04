/**
 * #6214 regression: canonical RuntimeObservation records must not stay
 * mutable through nested TypedArray/ArrayBuffer payloads. Previously
 * deepFreeze() skipped binary views, so a factory-created observation could
 * be mutated via its own public reference until its observationId no longer
 * matched its content.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntimeAuthorityBinding,
  createRuntimeObservation,
  validateRuntimeObservation,
  RuntimeAuthorityTracker,
} from '../js/runtime/authority.js';

function binding() {
  return createRuntimeAuthorityBinding({
    providerIdentity: 'provider-1',
    runtimeInstanceIdentity: 'runtime-1',
    targetIdentity: 'target-1',
    binaryIdentity: 'binary-1',
    moduleIdentity: 'module-1',
    loadMappingIdentity: 'mapping-1',
    sessionIdentity: 'session-1',
    capabilityVersion: '1',
  });
}

test('#6214 Uint8Array payload cannot mutate canonical observation', () => {
  const b = binding();
  const observation = createRuntimeObservation({
    binding: b,
    sequence: 0,
    observedAt: '2026-09-03T00:00:00Z',
    kind: 'memory-read',
    payload: { bytes: new Uint8Array([0x11, 0x22]) },
  });
  assert.equal(Object.isFrozen(observation), true);
  const originalId = observation.observationId;
  assert.throws(
    () => { observation.payload.bytes[0] = 0xff; },
    TypeError,
    'frozen binary payload must reject mutation',
  );
  assert.deepEqual(Array.from(observation.payload.bytes), [0x11, 0x22]);
  assert.equal(observation.observationId, originalId);
  assert.equal(validateRuntimeObservation(b, observation).ok, true);
});

test('#6214 ArrayBuffer payload is immutable', () => {
  const b = binding();
  const observation = createRuntimeObservation({
    binding: b,
    sequence: 0,
    observedAt: '2026-09-03T00:00:00Z',
    kind: 'memory-read',
    payload: { bytes: Uint8Array.of(1, 2, 3).buffer },
  });
  assert.throws(() => { observation.payload.bytes[0] = 9; }, TypeError);
  assert.equal(validateRuntimeObservation(b, observation).ok, true);
});

test('#6214 mutating the input after creation does not affect the record', () => {
  const b = binding();
  const inputBytes = new Uint8Array([1, 2]);
  const observation = createRuntimeObservation({
    binding: b,
    sequence: 0,
    observedAt: '2026-09-03T00:00:00Z',
    kind: 'memory-read',
    payload: { bytes: inputBytes },
  });
  inputBytes[0] = 99;
  assert.deepEqual(Array.from(observation.payload.bytes), [1, 2]);
  assert.equal(validateRuntimeObservation(b, observation).ok, true);
});

test('#6214 tracker observations stay valid after external mutation attempts', () => {
  const b = binding();
  const tracker = new RuntimeAuthorityTracker(b);
  const observation = createRuntimeObservation({
    binding: b,
    sequence: 0,
    observedAt: '2026-09-03T00:00:00Z',
    kind: 'memory-read',
    payload: { bytes: new Uint8Array([1]) },
  });
  assert.equal(tracker.accept(observation).status, 'accepted');
  assert.throws(() => { observation.payload.bytes[0] = 9; }, TypeError);
  assert.deepEqual(Array.from(tracker.observations[0].payload.bytes), [1]);
  assert.equal(validateRuntimeObservation(b, tracker.observations[0]).ok, true);
  // Mutating the caller's input array must not reach the ledger either.
  const raw = new Uint8Array([7, 8]);
  const second = createRuntimeObservation({
    binding: b,
    sequence: 1,
    observedAt: '2026-09-03T00:00:01Z',
    kind: 'memory-read',
    payload: { bytes: raw },
  });
  assert.equal(tracker.accept(second).status, 'accepted');
  raw[0] = 0;
  assert.deepEqual(Array.from(tracker.observations[1].payload.bytes), [7, 8]);
});

test('#6214 plain payloads keep canonical semantics', () => {
  const b = binding();
  const observation = createRuntimeObservation({
    binding: b,
    sequence: 0,
    observedAt: '2026-09-03T00:00:00Z',
    kind: 'memory-read',
    payload: { pc: '0x1000', count: 3 },
  });
  assert.equal(validateRuntimeObservation(b, observation).ok, true);
  assert.equal(
    validateRuntimeObservation(b, { ...observation, payload: { pc: 'tampered' } }).reason,
    'runtime-observation-identity-invalid',
  );
});

test('#6214 DataView payload is immutable', () => {
  const b = binding();
  const observation = createRuntimeObservation({
    binding: b,
    sequence: 0,
    observedAt: '2026-09-03T00:00:00Z',
    kind: 'memory-read',
    payload: { view: new DataView(Uint8Array.of(4, 5).buffer) },
  });
  assert.equal(validateRuntimeObservation(b, observation).ok, true);
  assert.throws(() => { observation.payload.view[0] = 9; }, TypeError);
  assert.equal(validateRuntimeObservation(b, observation).ok, true);
});
