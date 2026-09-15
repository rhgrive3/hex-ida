import assert from 'node:assert/strict';
import {
  ChangeLog,
  collaborationDigest,
  createProjectOperation,
  replayOperations,
  restoreCheckpoint,
} from '../../../js/collaboration/index.js';
import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  envelopeIdentity,
} from '../../../js/collaboration/remote-authority.js';

const cases = [];
function check(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, ok: false, error });
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}

const PROJECT = 'project:8869';
const BINARY = 'binary:8869';
const base = {
  projectIdentity: PROJECT,
  binaryIdentity: BINARY,
  targetEntityId: 'entity:8869',
  factKind: 'patch',
  action: 'set',
};

const log = () => new ChangeLog({ projectIdentity: PROJECT, binaryIdentity: BINARY });
const bytesOf = (logInstance) => {
  const records = Object.values(logInstance.snapshot().facts);
  return records.flatMap((record) => record.values.map((entry) => entry.value));
};
const bytesRecord = (type, values) => ({ $immutableBytes: { type, bytes: [...values] } });

check('generated identity pins the owned byte content; later mutation cannot republish it', () => {
  const operation = createProjectOperation({ ...base, payload: { bytes: new Uint8Array([1, 2, 3]) } });
  assert.deepEqual(operation.payload.bytes, bytesRecord('Uint8Array', [1, 2, 3]));
  assert.throws(() => { operation.payload.bytes.$immutableBytes.bytes[0] = 9; }, TypeError, 'canonical bytes must be read-only');
  assert.throws(() => { operation.payload.bytes.$immutableBytes = null; }, TypeError, 'the canonical record itself must be read-only');
  const instance = log();
  assert.equal(instance.applyOperation(operation).status, 'applied');
  assert.deepEqual(bytesOf(instance)[0], { bytes: bytesRecord('Uint8Array', [1, 2, 3]) });
  assert.equal(operation.operationId, createProjectOperation({ ...base, payload: { bytes: new Uint8Array([1, 2, 3]) } }).operationId);
  assert.notEqual(operation.operationId, createProjectOperation({ ...base, payload: { bytes: new Uint8Array([9, 2, 3]) } }).operationId);
});

check('ArrayBuffer and non-Uint8 views are pinned as well', () => {
  const buffer = new ArrayBuffer(4);
  new Uint32Array(buffer)[0] = 7;
  const view = new Int16Array(new ArrayBuffer(4));
  view[0] = 258;
  for (const [payload, type, bytes] of [
    [buffer, 'ArrayBuffer', new Uint8Array(buffer)],
    [view, 'Int16Array', new Uint8Array(view.buffer, view.byteOffset, view.byteLength)],
    [new DataView(new Uint8Array([4, 5, 6]).buffer), 'DataView', [4, 5, 6]],
  ]) {
    const operation = createProjectOperation({ ...base, payload, targetEntityId: `entity:${type}` });
    assert.deepEqual(operation.payload, { $immutableBytes: { type, bytes: Array.from(bytes) } }, type);
    const instance = log();
    assert.equal(instance.applyOperation(operation).status, 'applied', type);
    assert.deepEqual(bytesOf(instance)[0], operation.payload, type);
  }
});

check('mutation through the source collection after creation cannot change the canonical record', () => {
  const source = new Uint8Array([1, 2, 3]);
  const operation = createProjectOperation({ ...base, payload: { bytes: source } });
  source[0] = 99;
  assert.deepEqual(operation.payload.bytes, bytesRecord('Uint8Array', [1, 2, 3]), 'the canonical payload must not alias caller-owned storage');
  const instance = log();
  instance.applyOperation(operation);
  assert.deepEqual(bytesOf(instance)[0], { bytes: bytesRecord('Uint8Array', [1, 2, 3]) });
});

check('nested binary and collection leaves receive the same protection', () => {
  const payload = { note: 'derived', list: [1, { deeper: [{ ok: true }, new Uint8Array([7, 8])] }] };
  const operation = createProjectOperation({ ...base, payload });
  assert.throws(() => { operation.payload.list[1].deeper[1].$immutableBytes.bytes[0] = 0; }, TypeError);
  const instance = log();
  instance.applyOperation(operation);
  assert.deepEqual(bytesOf(instance)[0].list[1].deeper[1], bytesRecord('Uint8Array', [7, 8]));
});

check('accepted pending operations cannot be rewritten before causal drain', () => {
  const instance = log();
  const child = createProjectOperation({
    ...base,
    targetEntityId: 'entity:child',
    causalParents: ['op:parent'],
    payload: { bytes: new Uint8Array([10, 11]) },
  });
  const childId = child.operationId;
  assert.equal(instance.applyOperation(child).status, 'unresolved');
  assert.ok([...instance.pending.values()].some((operation) => operation.operationId === childId));
  assert.throws(() => { [...instance.pending.values()][0].payload.bytes[0] = 99; }, TypeError);
  const parent = createProjectOperation({ ...base, targetEntityId: 'entity:parent', operationId: 'op:parent', payload: 'p' });
  assert.equal(instance.applyOperation(parent).status, 'applied');
  assert.ok(instance.appliedOperationIds().includes(childId));
  const values = Object.entries(instance.snapshot().facts)
    .filter(([key]) => key.startsWith('entity:child'))
    .flatMap(([, record]) => record.values.map((entry) => entry.value));
  assert.deepEqual(values, [{ bytes: bytesRecord('Uint8Array', [10, 11]) }], 'only the accepted bytes may apply');
});

check('retained history cannot be mutated in place and the digest stays consistent', () => {
  const instance = log();
  const operation = createProjectOperation({ ...base, payload: { bytes: new Uint8Array([1, 2, 3]) } });
  instance.applyOperation(operation);
  const before = instance.digest();
  const retained = instance.operations.get(operation.operationId);
  assert.throws(() => { retained.payload.bytes.$immutableBytes.bytes[0] = 9; }, TypeError);
  assert.throws(() => { retained.targetEntityId = 'entity:other'; }, TypeError);
  assert.equal(instance.digest(), before, 'digest must not drift under attempted mutation');
  assert.deepEqual(bytesOf(instance)[0], { bytes: bytesRecord('Uint8Array', [1, 2, 3]) });
});

check('exact retry stays idempotent while genuine same-ID conflict still rejects', () => {
  const instance = log();
  const operation = createProjectOperation({ ...base, payload: { bytes: new Uint8Array([1, 2, 3]) } });
  assert.equal(instance.applyOperation(operation).status, 'applied');
  assert.equal(instance.applyOperation(operation).status, 'duplicate');
  assert.equal(instance.applyOperation(createProjectOperation({ ...base, operationId: operation.operationId, payload: { bytes: new Uint8Array([9, 2, 3]) } })).reason, 'operation-id-content-mismatch');
  assert.deepEqual(bytesOf(instance)[0], { bytes: bytesRecord('Uint8Array', [1, 2, 3]) });
});

check('checkpoint and replay preserve the ID/content binding', () => {
  const instance = log();
  const operation = createProjectOperation({ ...base, payload: { bytes: new Uint8Array([1, 2, 3]) } });
  instance.applyOperation(operation);
  const checkpoint = instance.checkpoint();
  const restored = restoreCheckpoint(structuredClone(checkpoint), { projectIdentity: PROJECT, binaryIdentity: BINARY });
  assert.equal(restored.digest(), instance.digest());
  assert.deepEqual(restored.appliedOperationIds(), [operation.operationId]);
  const replayExact = replayOperations({
    projectIdentity: PROJECT,
    binaryIdentity: BINARY,
    checkpoint: structuredClone(checkpoint),
    operations: [operation],
  });
  assert.equal(replayExact.digest, instance.digest(), 'replaying the exact original cannot rewrite committed content');
  assert.throws(
    () => replayOperations({
      projectIdentity: PROJECT,
      binaryIdentity: BINARY,
      operations: [
        operation,
        createProjectOperation({ ...base, operationId: operation.operationId, payload: { bytes: new Uint8Array([9, 9, 9]) } }),
      ],
    }),
    { name: 'TypeError', message: 'operation-id-content-mismatch' },
    'a same-ID byte rewrite cannot slip past replay',
  );

  const pendingLog = log();
  const child = createProjectOperation({
    ...base,
    targetEntityId: 'entity:pending',
    causalParents: ['op:missing-parent'],
    payload: { bytes: new Uint8Array([4, 5, 6]) },
  });
  assert.equal(pendingLog.applyOperation(child).status, 'unresolved');
  const pendingCheckpoint = pendingLog.checkpoint();
  const pendingRestored = restoreCheckpoint(structuredClone(pendingCheckpoint), { projectIdentity: PROJECT, binaryIdentity: BINARY });
  assert.equal(pendingRestored.digest(), pendingLog.digest());
  assert.deepEqual([...pendingRestored.pending.values()][0].payload, { bytes: bytesRecord('Uint8Array', [4, 5, 6]) }, 'restored pending content must stay bound to the accepted ID');
  const tamperable = structuredClone(pendingCheckpoint);
  tamperable.pendingOperations[0].payload.bytes.$immutableBytes.bytes[0] = 99;
  assert.throws(() => restoreCheckpoint(tamperable, { projectIdentity: PROJECT, binaryIdentity: BINARY }), TypeError,
    'a rewritten pending payload must not restore under the accepted ID');
});

check('Map and Set payloads become order-insensitive immutable records', () => {
  const first = createProjectOperation({ ...base, targetEntityId: 'entity:map', payload: new Map([['role', 'reader'], ['scope', 'all']]) });
  const reordered = createProjectOperation({ ...base, targetEntityId: 'entity:map', payload: new Map([['scope', 'all'], ['role', 'reader']]) });
  assert.equal(first.operationId, reordered.operationId, 'canonical Map identity stays entry-order insensitive');
  assert.equal(Object.isFrozen(first.payload), true);
  assert.throws(() => Map.prototype.set.call(first.payload, 'role', 'writer'), TypeError);
  const source = new Map([['role', 'reader']]);
  const pinned = createProjectOperation({ ...base, targetEntityId: 'entity:pin', payload: source });
  source.set('role', 'writer');
  assert.equal(JSON.stringify(pinned.payload).includes('reader'), true, 'caller mutation after creation cannot rewrite the record');
  const setOp = createProjectOperation({ ...base, targetEntityId: 'entity:set', payload: new Set(['b', 'a']) });
  assert.throws(() => Set.prototype.add.call(setOp.payload, 'c'), TypeError);
  assert.equal(setOp.operationId, createProjectOperation({ ...base, targetEntityId: 'entity:set', payload: new Set(['a', 'b']) }).operationId);
  const instance = log();
  assert.equal(instance.applyOperation(setOp).status, 'applied');
  assert.deepEqual(bytesOf(instance)[0], setOp.payload);
});

check('non-cloneable and cyclic payload content fails closed', () => {
  assert.throws(() => createProjectOperation({ ...base, payload: { fn() { } } }), { name: 'TypeError', message: 'operation-payload-type-unsupported' });
  assert.throws(() => createProjectOperation({ ...base, payload: [Symbol('x')] }), { name: 'TypeError', message: 'operation-payload-type-unsupported' });
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => createProjectOperation({ ...base, payload: cyclic }), { name: 'TypeError', message: 'operation-payload-cyclic' });
  assert.throws(() => createProjectOperation({ ...base, payload: new Date('invalid') }), { name: 'TypeError', message: 'identity-invalid-date' });
});

check('a canonical binary record still counts as raw bytes at the remote egress boundary', () => {
  const gate = new RemoteCollaborationGate({
    projectIdentity: PROJECT,
    binaryIdentity: BINARY,
    sessionIdentity: 'session:8869',
    allowedActors: { alice: ['*'] },
    verifyTransportProof: () => true,
    transportVerifierIdentity: 'transport:8869',
  });
  const forged = {
    schemaVersion: 'hex-remote-collaboration-envelope/v1',
    operationSchemaVersion: 'hex-project-operation-v1',
    projectIdentity: PROJECT,
    binaryIdentity: BINARY,
    sessionIdentity: 'session:8869',
    actorIdentity: 'alice',
    deviceIdentity: 'device:1',
    messageId: 'message:8869',
    sequence: 1,
    operations: [{ ...base, targetEntityId: 'entity:egress', factKind: 'confirmation', payload: { $immutableBytes: { type: 'Uint8Array', bytes: [1, 2, 3] } } }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:8869' },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  };
  forged.envelopeId = envelopeIdentity(forged);
  assert.deepEqual(gate.validate(forged), { ok: false, reason: 'remote-raw-binary-egress-forbidden' });
  assert.equal(createRemoteCollaborationEnvelope({
    projectIdentity: PROJECT,
    binaryIdentity: BINARY,
    sessionIdentity: 'session:8869',
    actorIdentity: 'alice',
    deviceIdentity: 'device:1',
    messageId: 'message:clean:8869',
    sequence: 1,
    operations: [{ targetEntityId: 'entity:clean', factKind: 'confirmation', action: 'set', payload: { note: 'derived' } }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:8869' },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  }).egress.rawBinaryBytes, false, 'derived payloads keep working');
});

check('semantic digest binds the canonical record, not a caller-mutable live value', () => {
  const live = { bytes: new Uint8Array([1, 2, 3]) };
  const operation = createProjectOperation({ ...base, payload: live });
  live.bytes[0] = 9;
  assert.equal(collaborationDigest(operation.payload), collaborationDigest({ bytes: bytesRecord('Uint8Array', [1, 2, 3]) }));
});

const failed = cases.filter((entry) => !entry.ok);
console.log(`issue-8869 regression: ${cases.length - failed.length}/${cases.length} passed`);
if (failed.length) {
  throw new AggregateError(failed.map((entry) => entry.error), `issue-8869 regression: ${failed.length} case(s) failed`);
}
