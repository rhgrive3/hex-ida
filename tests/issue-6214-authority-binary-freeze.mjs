// Issue #6214 regression: canonical RuntimeObservation binary payloads
// (TypedArray/ArrayBuffer) must be immutable after the observation identity is
// computed. deepFreeze cannot freeze element storage of views, so the authority
// clone stores an owned, frozen, type-tagged byte representation.
import assert from 'node:assert/strict';
import {
  createRuntimeAuthorityBinding, createRuntimeObservation, validateRuntimeObservation,
  RuntimeAuthorityTracker,
} from '../js/runtime/authority.js';

const bindingInput = {
  providerIdentity: 'provider-1', runtimeInstanceIdentity: 'runtime-1', targetIdentity: 'target-1',
  binaryIdentity: 'binary-1', moduleIdentity: 'module-1', loadMappingIdentity: 'mapping-1',
  sessionIdentity: 'session-1', capabilityVersion: '1',
};

const binding = createRuntimeAuthorityBinding(bindingInput);

function observe(payload) {
  return createRuntimeObservation({ binding, sequence: 0, observedAt: '2026-09-03T00:00:00Z', kind: 'memory-read', payload });
}

// 1. TypedArray payload: the factory-owned record cannot be mutated through the
//    public reference, and its identity keeps matching its content.
{
  const observation = observe({ bytes: new Uint8Array([0x11, 0x22]) });
  const originalId = observation.observationId;
  assert.equal(observation.payload.bytes.$hexRuntimeBinary, 'Uint8Array');
  assert.deepEqual(observation.payload.bytes.bytes, [0x11, 0x22]);
  let mutated = false;
  try {
    observation.payload.bytes.bytes[0] = 0xff;
    mutated = observation.payload.bytes.bytes[0] === 0xff;
  } catch { /* frozen */ }
  assert.equal(mutated, false, 'TypedArray payload elements must not be mutable through the record');
  assert.deepEqual(observation.payload.bytes.bytes, [0x11, 0x22]);
  assert.equal(observation.observationId, originalId);
  assert.ok(validateRuntimeObservation(binding, observation).ok, 'factory observation must stay valid');
}

// 2. ArrayBuffer payload: same contract.
{
  const observation = observe({ raw: new ArrayBuffer(3) });
  const view = observation.payload.raw;
  assert.equal(view.$hexRuntimeBinary, 'ArrayBuffer');
  assert.deepEqual(view.bytes, [0, 0, 0]);
  assert.ok(validateRuntimeObservation(binding, observation).ok);
}

// 3. TypedArray nested inside arrays/objects is canonicalized too.
{
  const observation = observe({ frames: [{ bytes: new Uint8Array([1, 2, 3]) }] });
  let mutated = false;
  try {
    observation.payload.frames[0].bytes.bytes[0] = 9;
    mutated = observation.payload.frames[0].bytes.bytes[0] === 9;
  } catch { /* frozen */ }
  assert.equal(mutated, false);
  assert.equal(observation.payload.frames[0].bytes.$hexRuntimeBinary, 'Uint8Array');
  assert.deepEqual(observation.payload.frames[0].bytes.bytes, [1, 2, 3]);
  assert.ok(validateRuntimeObservation(binding, observation).ok);
}

// 4. Observation identity keeps the original binary type. Equal bytes in a
//    plain array, a Uint8Array, a Uint16Array, and an ArrayBuffer are distinct
//    payloads; equivalent values of the same type remain deterministic.
{
  const fromView = observe({ bytes: new Uint8Array([7, 8]) });
  const fromSameType = observe({ bytes: new Uint8Array([7, 8]) });
  const fromArray = observe({ bytes: [7, 8] });
  const fromUint16 = observe({ bytes: new Uint16Array(new Uint8Array([7, 8]).buffer) });
  const fromBuffer = observe({ bytes: new Uint8Array([7, 8]).buffer });
  assert.equal(fromView.observationId, fromSameType.observationId, 'same binary type and bytes must be deterministic');
  assert.notEqual(fromView.observationId, fromArray.observationId, 'binary type must differ from a plain array');
  assert.notEqual(fromView.observationId, fromUint16.observationId, 'binary view width must remain part of identity');
  assert.notEqual(fromView.observationId, fromBuffer.observationId, 'ArrayBuffer must remain distinct from a view');
}

// 5. Tracker-accepted factory observations cannot be invalidated afterwards.
{
  const tracker = new RuntimeAuthorityTracker(binding);
  const observation = observe({ bytes: new Uint8Array([1]) });
  const accepted = tracker.accept(observation);
  assert.equal(accepted.status, 'accepted');
  let mutated = false;
  try {
    observation.payload.bytes.bytes[0] = 9;
    mutated = observation.payload.bytes.bytes[0] === 9;
  } catch { /* frozen */ }
  assert.equal(mutated, false);
  assert.ok(validateRuntimeObservation(binding, tracker.observations[0]).ok, 'tracker copy must stay valid');
  const snapshot = tracker.snapshot();
  let snapshotMutated = false;
  try {
    snapshot.observations[0].payload.bytes.bytes[0] = 42;
    snapshotMutated = snapshot.observations[0].payload.bytes.bytes[0] === 42;
  } catch { /* frozen */ }
  assert.equal(snapshotMutated, false, 'snapshot binary payload must be immutable');
}

// 6. Existing canonical semantics for plain payloads are preserved.
{
  const observation = observe({ note: 'hello', hits: 3, flags: { retry: true } });
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.payload), true);
  assert.ok(validateRuntimeObservation(binding, observation).ok);
}

// 7. Binary values nested in Map/Set must not bypass canonicalization. The
//    ownership guards already freeze Map/Set mutators; this pins their values too.
{
  const observation = observe({
    map: new Map([['bytes', new Uint8Array([4, 5])]]),
    set: new Set([new Uint8Array([6, 7])]),
  });
  const mapBytes = observation.payload.map.get('bytes');
  const [setBytes] = observation.payload.set.values();
  assert.equal(mapBytes.$hexRuntimeBinary, 'Uint8Array');
  assert.equal(setBytes.$hexRuntimeBinary, 'Uint8Array');
  assert.deepEqual(mapBytes.bytes, [4, 5]);
  assert.deepEqual(setBytes.bytes, [6, 7]);
  let mapMutated = false;
  let setMutated = false;
  try { mapBytes.bytes[0] = 99; mapMutated = mapBytes.bytes[0] === 99; } catch { /* frozen */ }
  try { setBytes.bytes[0] = 99; setMutated = setBytes.bytes[0] === 99; } catch { /* frozen */ }
  assert.equal(mapMutated, false);
  assert.equal(setMutated, false);
  assert.throws(() => observation.payload.map.set('x', [1]), /Cannot mutate frozen Map/);
  assert.throws(() => observation.payload.set.add([1]), /Cannot mutate frozen Set/);
  assert.ok(validateRuntimeObservation(binding, observation).ok);
}

// 8. Mutation-authority scope uses the same clone boundary and therefore must
//    not retain mutable TypedArray/ArrayBuffer storage either.
{
  const tracker = new RuntimeAuthorityTracker(binding);
  const authorized = tracker.authorizeMutation({
    explicitApproval: true,
    actorIdentity: 'actor-1',
    operation: 'memory-write',
    issuedAt: '2026-09-03T00:00:01Z',
    scope: { bytes: new Uint8Array([9, 10]) },
  });
  assert.equal(authorized.status, 'authorized');
  assert.equal(authorized.token.scope.bytes.$hexRuntimeBinary, 'Uint8Array');
  assert.deepEqual(authorized.token.scope.bytes.bytes, [9, 10]);
  let mutated = false;
  try {
    authorized.token.scope.bytes.bytes[0] = 77;
    mutated = authorized.token.scope.bytes.bytes[0] === 77;
  } catch { /* frozen */ }
  assert.equal(mutated, false, 'mutation token binary scope must be immutable');
}

// 9. The clone boundary retains shared references while replacing their
// mutable binary backing storage. This keeps valid metadata/Map/Set topology
// intact instead of projecting each occurrence independently.
{
  const shared = new Uint8Array([0xaa, 0xbb]);
  const observation = observe({
    left: shared,
    right: shared,
    map: new Map([['shared', shared]]),
    set: new Set([shared]),
  });
  assert.equal(observation.payload.left, observation.payload.right);
  assert.equal(observation.payload.map.get('shared'), observation.payload.left);
  assert.equal([...observation.payload.set][0], observation.payload.left);
  shared[0] = 0xff;
  assert.deepEqual(observation.payload.left.bytes, [0xaa, 0xbb]);
  assert.ok(validateRuntimeObservation(binding, observation).ok);
}

// Marker-like ordinary metadata must not silently lose fields or type information.
{
  const metadata = { $hexRuntimeBinary: 'Uint8Array', bytes: [1, 2], description: 'sample' };
  assert.deepEqual(observe(metadata).payload, metadata);
  const ordinary = { $hexRuntimeBinary: 'application-record', bytes: [1, 2] };
  assert.deepEqual(observe(ordinary).payload, ordinary);
  const original = observe({ data: new Uint8Array([1, 2]) });
  const transported = observe(structuredClone(original.payload));
  assert.equal(transported.observationId, original.observationId);
}

console.log('issue #6214 canonical binary payload immutability regressions: PASS');
