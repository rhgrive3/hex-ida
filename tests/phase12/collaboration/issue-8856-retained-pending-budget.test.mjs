import assert from 'node:assert/strict';
import { ChangeLog, PENDING_BUDGET_REASON, restoreCheckpoint } from '../../../js/collaboration/index.js';
import {
  RemoteCollaborationChannel,
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  createRemoteTransportVerifier,
} from '../../../js/collaboration/remote-authority.js';
import { applyRemoteEnvelopeQueued } from '../../../js/collaboration/remote-delivery.js';

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

const PROJECT = 'project:8856';
const BINARY = 'binary:8856';
const SESSION = 'collab-session:8856';
const verifier = createRemoteTransportVerifier({
  oracleIdentity: 'oracle:8856',
  verifyTransportProof: (proof) => proof.proofIdentity === 'tls:8856',
});

const gate = (overrides = {}) => new RemoteCollaborationGate({
  projectIdentity: PROJECT,
  binaryIdentity: BINARY,
  sessionIdentity: SESSION,
  allowedActors: { alice: ['*'], bob: ['*'] },
  maxBatch: 8,
  maxMessageBytes: 65536,
  verifyTransportProof: verifier.verifyTransportProof,
  transportVerifierIdentity: verifier.transportVerifierIdentity,
  ...overrides,
});

const log = (overrides = {}) => new ChangeLog({
  projectIdentity: PROJECT,
  binaryIdentity: BINARY,
  allowRemote: true,
  authorizedAuthors: ['alice', 'bob'],
  maxPendingOperations: 4,
  maxPendingOperationsPerActor: 4,
  maxPendingBytes: 1024 * 1024,
  ...overrides,
});

let messageCounter = 0;
const envelope = (actor, operations) => createRemoteCollaborationEnvelope({
  projectIdentity: PROJECT,
  binaryIdentity: BINARY,
  sessionIdentity: SESSION,
  actorIdentity: actor,
  deviceIdentity: `device:${actor}`,
  messageId: `message:8856:${++messageCounter}`,
  sequence: messageCounter,
  operations,
  transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:8856' },
  egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
});

// Individually valid, authenticated, authorized, and under the per-envelope
// budget — the only resource effect is retained unresolved state.
const missingParentEnvelope = (actor, index, payload = 'x') => envelope(actor, [{
  operationId: `op:${actor}:${index}`,
  targetEntityId: `fn:${actor}:${index}`,
  factKind: 'name',
  action: 'set',
  payload,
  causalParents: [`never:${actor}:${index}`],
}]);

check('retained pending count budget backpressures after the configured ceiling', () => {
  const instance = log();
  const gateInstance = gate();
  const delivered = [];
  for (let index = 0; index < 4; index += 1) {
    const result = applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('bob', index));
    assert.equal(result.status, 'accepted-with-pending-dependencies', `envelope ${index} must be admitted`);
    delivered.push(result);
  }
  assert.equal(instance.pending.size, 4);
  const overflow = applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('bob', 99));
  assert.equal(overflow.status, 'rejected');
  assert.equal(overflow.reason, PENDING_BUDGET_REASON);
  assert.equal(instance.pending.size, 4, 'rejected admission must not grow retained state');
});

check('byte budget bounds retained unresolved state', () => {
  const instance = log({ maxPendingOperations: 64, maxPendingOperationsPerActor: 64, maxPendingBytes: 1024 });
  const gateInstance = gate();
  const payload = 'p'.repeat(400);
  let admitted = 0;
  let rejected = null;
  for (let index = 0; index < 12; index += 1) {
    const result = applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('bob', index, payload));
    if (result.status === 'rejected') { rejected = result; break; }
    admitted += 1;
  }
  assert.ok(admitted > 0 && admitted < 12, `byte budget must bind before the count budget (admitted ${admitted})`);
  assert.equal(rejected.reason, PENDING_BUDGET_REASON);
  assert.ok(instance.retainedPendingUsage().bytes <= 1024);
});

check('one actor cannot consume the whole global retained budget', () => {
  const instance = log({ maxPendingOperations: 8, maxPendingOperationsPerActor: 3 });
  const gateInstance = gate();
  for (let index = 0; index < 3; index += 1) {
    assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('alice', index)).status, 'accepted-with-pending-dependencies');
  }
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('alice', 99)).reason, PENDING_BUDGET_REASON);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('bob', index)).status, 'accepted-with-pending-dependencies', 'another actor keeps its own capacity');
  }
  assert.equal(instance.pending.size, 6);
});

check('parent arrival drains a pending child and frees its budget slot', () => {
  const instance = log();
  const gateInstance = gate();
  const child = envelope('alice', [{
    operationId: 'op:child', targetEntityId: 'fn:order', factKind: 'name', action: 'set', payload: 'child', causalParents: ['op:parent'],
  }]);
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, child).status, 'accepted-with-pending-dependencies');
  for (let index = 0; index < 3; index += 1) {
    assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('alice', index)).status, 'accepted-with-pending-dependencies');
  }
  assert.equal(instance.pending.size, 4);
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('alice', 77)).reason, PENDING_BUDGET_REASON);
  const parent = envelope('alice', [{ operationId: 'op:parent', targetEntityId: 'fn:order', factKind: 'type', action: 'set', payload: 'parent' }]);
  const parentResult = applyRemoteEnvelopeQueued(instance, gateInstance, parent);
  assert.ok(parentResult.results.some((entry) => entry.operationId === 'op:parent' && entry.status === 'applied'));
  assert.equal(instance.pending.size, 3, 'the drained child must release its retained slot');
  assert.ok(instance.appliedOperationIds().includes('op:child'));
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('alice', 78)).status, 'accepted-with-pending-dependencies');
});

check('multi-level chains converge deterministically inside the budget', () => {
  const instance = log({ maxPendingOperations: 8, maxPendingOperationsPerActor: 8 });
  const gateInstance = gate();
  // Delivered child -> grandparent -> grandparent's parent -> root order.
  const first = envelope('bob', [{
    operationId: 'op:level-1', targetEntityId: 'fn:chain', factKind: 'name', action: 'set', payload: 'one', causalParents: ['op:level-2'],
  }]);
  const second = envelope('bob', [{
    operationId: 'op:level-2', targetEntityId: 'fn:chain', factKind: 'type', action: 'set', payload: 'two', causalParents: ['op:level-3'],
  }]);
  const third = envelope('bob', [{
    operationId: 'op:level-3', targetEntityId: 'fn:chain', factKind: 'struct', action: 'set', payload: 'three',
  }]);
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, first).status, 'accepted-with-pending-dependencies');
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, second).status, 'accepted-with-pending-dependencies');
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, third).status, 'applied');
  assert.deepEqual([...instance.pending.keys()], []);
  assert.deepEqual(instance.appliedOperationIds(), ['op:level-1', 'op:level-2', 'op:level-3']);
});

check('budget rejection burns no replay or sequence authority and stays retryable', () => {
  const instance = log();
  const gateInstance = gate();
  for (let index = 0; index < 4; index += 1) {
    applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('bob', index));
  }
  assert.equal(gateInstance.snapshot().seenMessageCount, 4);
  const rejectedEnvelope = missingParentEnvelope('alice', 500);
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, rejectedEnvelope).reason, PENDING_BUDGET_REASON);
  assert.equal(gateInstance.snapshot().seenMessageCount, 4, 'rejected envelope must not consume message authority');
  assert.equal(gateInstance.lastSequenceByActor.get('alice'), undefined, 'rejected envelope must not advance actor sequence');
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, rejectedEnvelope).reason, PENDING_BUDGET_REASON);
  instance.pending.delete('op:bob:0');
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, rejectedEnvelope).status, 'accepted-with-pending-dependencies', 'the same envelope stays retryable once capacity is freed');
});

check('rejected pending admission leaves state, operations, pending, and digest unchanged', () => {
  const instance = log();
  const gateInstance = gate();
  for (let index = 0; index < 4; index += 1) {
    applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('bob', index));
  }
  const before = { state: JSON.stringify(instance.snapshot()), operations: instance.appliedOperationIds(), pending: [...instance.pending.keys()], digest: instance.digest() };
  assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('alice', 404)).reason, PENDING_BUDGET_REASON);
  assert.deepEqual(JSON.stringify(instance.snapshot()), before.state);
  assert.deepEqual(instance.appliedOperationIds(), before.operations);
  assert.deepEqual([...instance.pending.keys()], before.pending);
  assert.equal(instance.digest(), before.digest);
});

check('ready work is still admitted while the retained backlog is full', () => {
  const instance = log();
  const gateInstance = gate();
  for (let index = 0; index < 4; index += 1) {
    applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('bob', index));
  }
  const applied = applyRemoteEnvelopeQueued(instance, gateInstance, envelope('alice', [{
    operationId: 'op:ready', targetEntityId: 'fn:ready', factKind: 'name', action: 'set', payload: 'now',
  }]));
  assert.ok(applied.results.some((entry) => entry.operationId === 'op:ready' && entry.status === 'applied'), 'ready work must not be blocked by a full unresolved backlog');
  assert.ok(instance.appliedOperationIds().includes('op:ready'));
  assert.equal(instance.pending.size, 4, 'the ready operation must not displace retained state');
});

check('revokeActor purges that actor’s retained unresolved debt deterministically', () => {
  const instance = log({ maxPendingOperations: 8, maxPendingOperationsPerActor: 8 });
  const channel = new RemoteCollaborationChannel({
    gate: gate(),
    log: instance,
    transport: { send: async (snap) => ({ status: 'sent', envelopeId: snap.envelopeId }) },
  });
  assert.equal(channel.receive(missingParentEnvelope('alice', 1)).status, 'accepted-with-pending-dependencies');
  assert.equal(channel.receive(missingParentEnvelope('alice', 2)).status, 'accepted-with-pending-dependencies');
  assert.equal(channel.receive(missingParentEnvelope('bob', 1)).status, 'accepted-with-pending-dependencies');
  const summary = channel.revokeActor('alice');
  assert.equal(summary.status, 'revoked');
  assert.equal(summary.purgedCount, 2);
  assert.deepEqual([...instance.pending.keys()], ['op:bob:1']);
  assert.equal(applyRemoteEnvelopeQueued(instance, channel.gate, missingParentEnvelope('alice', 3)).reason, 'remote-actor-revoked');
  assert.equal(applyRemoteEnvelopeQueued(instance, channel.gate, missingParentEnvelope('bob', 2)).status, 'accepted-with-pending-dependencies');
});

check('checkpoint restore cannot resurrect a backlog larger than the policy', () => {
  const source = log({ maxPendingOperations: 8, maxPendingOperationsPerActor: 8 });
  const gateInstance = gate();
  for (let index = 0; index < 3; index += 1) {
    applyRemoteEnvelopeQueued(source, gateInstance, missingParentEnvelope('bob', index));
  }
  const checkpoint = source.checkpoint();
  const restored = restoreWithBudget(checkpoint, { maxPendingOperations: 8, maxPendingOperationsPerActor: 8 });
  assert.deepEqual([...restored.pending.keys()].sort(), ['op:bob:0', 'op:bob:1', 'op:bob:2']);
  assert.throws(
    () => restoreWithBudget(checkpoint, { maxPendingOperations: 2, maxPendingOperationsPerActor: 8 }),
    { name: 'TypeError', message: PENDING_BUDGET_REASON },
  );
  assert.throws(
    () => restoreWithBudget(checkpoint, { maxPendingOperations: 8, maxPendingOperationsPerActor: 2 }),
    { name: 'TypeError', message: PENDING_BUDGET_REASON },
    'per-actor debt must be bounded on restore too',
  );
});

check('receive summary stays bounded while reporting the exact retained count', () => {
  const instance = log({ maxPendingOperations: 300, maxPendingOperationsPerActor: 300, maxPendingBytes: 4 * 1024 * 1024 });
  const gateInstance = gate();
  for (let index = 0; index < 300; index += 1) {
    assert.equal(applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('bob', index)).status, 'accepted-with-pending-dependencies');
  }
  const result = applyRemoteEnvelopeQueued(instance, gateInstance, envelope('bob', [{
    operationId: 'op:ready:large', targetEntityId: 'fn:ready:large', factKind: 'name', action: 'set', payload: 'now',
  }]));
  assert.ok(result.results.some((entry) => entry.operationId === 'op:ready:large' && entry.status === 'applied'));
  assert.equal(result.unresolvedCount, 300);
  assert.equal(result.unresolvedOperationIds.length, 256);
  assert.equal(result.unresolvedOperationIdsTruncated, true);
  assert.deepEqual(result.pendingBudget, { maxOperations: 300, maxOperationsPerActor: 300, maxBytes: 4 * 1024 * 1024 });
});

check('repeated tiny authenticated missing-parent envelopes cannot grow state without bound', () => {
  const instance = log({ maxPendingOperations: 8, maxPendingOperationsPerActor: 8 });
  const gateInstance = gate();
  let admitted = 0;
  for (let index = 0; index < 200; index += 1) {
    const result = applyRemoteEnvelopeQueued(instance, gateInstance, missingParentEnvelope('alice', index));
    if (result.status !== 'rejected') admitted += 1;
    assert.ok(instance.pending.size <= 8, 'retained set must stay inside the configured ceiling');
  }
  assert.equal(admitted, 8);
  assert.equal(instance.pending.size, 8);
});

check('configured pending ceilings stay strictly typed and bounded', () => {
  assert.equal(log().maxPendingOperations, 4);
  for (const value of ['4', [4], true, 4n, new Number(4), 0, -1, 1.5, Number.NaN, 16385]) {
    assert.throws(() => log({ maxPendingOperations: value }), { name: 'TypeError', message: 'changelog-max-pending-operations-invalid' }, `must reject ${String(value)}`);
    assert.throws(() => log({ maxPendingOperationsPerActor: value }), { name: 'TypeError', message: 'changelog-max-pending-per-actor-invalid' });
  }
  for (const value of ['1024', 1024n, 0, 128 * 1024 * 1024 + 1]) {
    assert.throws(() => log({ maxPendingBytes: value }), { name: 'TypeError', message: 'changelog-max-pending-bytes-invalid' });
  }
});

function restoreWithBudget(checkpoint, budget) {
  return restoreCheckpoint(structuredClone(checkpoint), { projectIdentity: PROJECT, binaryIdentity: BINARY, ...budget });
}

const failed = cases.filter((entry) => !entry.ok);
console.log(`issue-8856 regression: ${cases.length - failed.length}/${cases.length} passed`);
if (failed.length) {
  throw new AggregateError(failed.map((entry) => entry.error), `issue-8856 regression: ${failed.length} case(s) failed`);
}
