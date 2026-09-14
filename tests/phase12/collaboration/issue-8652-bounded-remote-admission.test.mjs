import assert from 'node:assert/strict';
import {
  RemoteCollaborationGate,
  REMOTE_COLLAB_SCHEMA,
  createRemoteCollaborationEnvelope,
} from '../../../js/collaboration/remote-authority.js';
import { CHANGELOG_SCHEMA_VERSION } from '../../../js/collaboration/index.js';

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

const PROJECT = 'project:8652';
const SESSION = 'session:8652';
const DEVICE = 'device:8652';

let verifierCalls = 0;
const gate = (overrides = {}) => new RemoteCollaborationGate({
  projectIdentity: PROJECT,
  sessionIdentity: SESSION,
  allowedActors: { alice: ['*'] },
  maxBatch: 1,
  maxMessageBytes: 1024,
  verifyTransportProof: (proof) => {
    verifierCalls += 1;
    return proof?.proofIdentity === 'proof:8652';
  },
  transportVerifierIdentity: 'oracle:8652',
  ...overrides,
});

const operation = (suffix, payload = `value:${suffix}`) => ({
  operationId: `op:${suffix}`,
  targetEntityId: `entity:${suffix}`,
  factKind: 'name',
  action: 'set',
  payload,
});

// A deliberately wrong envelopeId is the structural oracle for "rejected before
// the identity digest": if any check reached the digest it would report
// `remote-envelope-identity-mismatch` instead of the budget reason.
const hostileEnvelope = (operations, overrides = {}) => {
  const envelope = {
    schemaVersion: REMOTE_COLLAB_SCHEMA,
    operationSchemaVersion: CHANGELOG_SCHEMA_VERSION,
    projectIdentity: PROJECT,
    binaryIdentity: null,
    sessionIdentity: SESSION,
    actorIdentity: 'alice',
    deviceIdentity: DEVICE,
    messageId: 'message:8652',
    sequence: 1,
    operations,
    envelopeId: 'remote-envelope:not-computed',
    transportProof: { authenticated: false, confidentiality: 'unverified', integrity: 'unverified' },
    egress: { userAuthorized: false, rawBinaryBytes: false, derivedDataOnly: true },
    ...overrides,
  };
  return envelope;
};

const validEnvelope = (payload = 'value:8652') => createRemoteCollaborationEnvelope({
  projectIdentity: PROJECT,
  sessionIdentity: SESSION,
  actorIdentity: 'alice',
  deviceIdentity: DEVICE,
  messageId: 'message:valid:8652',
  sequence: 1,
  operations: [operation('valid', payload)],
  transportProof: {
    authenticated: true,
    confidentiality: 'verified',
    integrity: 'verified',
    proofIdentity: 'proof:8652',
  },
  egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
});

const canonicalBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

function watchedOperation() {
  const state = { reads: 0 };
  const watched = {
    operationId: 'op:watched',
    targetEntityId: 'entity:watched',
    factKind: 'name',
    action: 'set',
    get payload() { state.reads += 1; return 'x'.repeat(4096); },
  };
  return { watched, state };
}

check('batch budget is enforced before operation payload traversal or digest', () => {
  const { watched, state } = watchedOperation();
  const result = gate({ maxBatch: 1 }).validate(hostileEnvelope([watched, watched, watched]));
  assert.deepEqual(result, { ok: false, reason: 'remote-batch-budget-exceeded' });
  assert.equal(state.reads, 0, 'no operation payload property may be read');
  assert.equal(verifierCalls, 0);
});

check('100k operations with maxBatch=1 never reaches canonical identity work', () => {
  const operations = new Array(100_000);
  for (let index = 0; index < operations.length; index += 1) operations[index] = {};
  const started = process.hrtime.bigint();
  const result = gate({ maxBatch: 1 }).validate(hostileEnvelope(operations));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(result, { ok: false, reason: 'remote-batch-budget-exceeded' });
  assert.ok(elapsedMs < 50, `admission work must not scale with the over-limit batch (${elapsedMs}ms)`);
});

check('message budget is enforced before materialization and digest', () => {
  const result = gate({ maxMessageBytes: 1024 }).validate(
    hostileEnvelope([operation('big', 'x'.repeat(32 * 1024 * 1024))]),
  );
  assert.deepEqual(result, { ok: false, reason: 'remote-message-budget-exceeded' });
  assert.equal(verifierCalls, 0);
});

check('oversized non-cloneable envelope rejects on budget instead of reaching structuredClone', () => {
  const result = gate({ maxMessageBytes: 1024 }).validate(
    hostileEnvelope([{ ...operation('hostile'), payload: { text: 'y'.repeat(4 * 1024 * 1024), fn() { } } }]),
  );
  assert.deepEqual(result, { ok: false, reason: 'remote-message-budget-exceeded' });
});

check('oversized unauthenticated envelope gets no larger budget than an authenticated one', () => {
  const big = 'z'.repeat(8 * 1024 * 1024);
  const unauthenticated = gate({ maxMessageBytes: 1024 }).validate(
    hostileEnvelope([operation('unauth', big)], {
      transportProof: { authenticated: false, confidentiality: 'unverified', integrity: 'unverified' },
    }),
  );
  const authenticated = gate({ maxMessageBytes: 1024 }).validate(
    hostileEnvelope([operation('auth', big)], {
      transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:8652' },
    }),
  );
  assert.deepEqual(unauthenticated, { ok: false, reason: 'remote-message-budget-exceeded' });
  assert.deepEqual(authenticated, { ok: false, reason: 'remote-message-budget-exceeded' });
  assert.equal(verifierCalls, 0, 'transport verifier must not run for an over-budget envelope');
});

check('oversized malformed schema rejects on budget before schema classification', () => {
  const result = gate({ maxMessageBytes: 1024 }).validate(
    hostileEnvelope([operation('schema', 'w'.repeat(2 * 1024 * 1024))], { schemaVersion: 'unsupported/v9' }),
  );
  assert.deepEqual(result, { ok: false, reason: 'remote-message-budget-exceeded' });
});

check('exactly-at-limit valid envelope keeps working and limit+1 rejects', () => {
  const envelope = validEnvelope();
  const size = canonicalBytes(envelope);
  assert.deepEqual(gate({ maxBatch: 1, maxMessageBytes: size }).validate(envelope), { ok: true });
  assert.deepEqual(gate({ maxBatch: 1, maxMessageBytes: size - 1 }).validate(envelope), {
    ok: false,
    reason: 'remote-message-budget-exceeded',
  });
});

check('exactly-at-limit batch keeps working and limit+1 rejects', () => {
  const envelope = createRemoteCollaborationEnvelope({
    projectIdentity: PROJECT,
    sessionIdentity: SESSION,
    actorIdentity: 'alice',
    deviceIdentity: DEVICE,
    messageId: 'message:batch:8652',
    sequence: 1,
    operations: [operation('a'), operation('b')],
    transportProof: {
      authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'proof:8652',
    },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  });
  assert.deepEqual(gate({ maxBatch: 2, maxMessageBytes: 1024 * 1024 }).validate(envelope), { ok: true });
  assert.deepEqual(gate({ maxBatch: 1, maxMessageBytes: 1024 * 1024 }).validate(envelope), {
    ok: false,
    reason: 'remote-batch-budget-exceeded',
  });
});

check('cyclic and shared-DAG graphs stay fail-closed without bypassing the budget', () => {
  const cyclic = { note: 'c' };
  cyclic.self = cyclic;
  assert.deepEqual(gate({ maxMessageBytes: 4096 }).validate(hostileEnvelope([operation('cyc', cyclic)])), {
    ok: false,
    reason: 'remote-envelope-shape-invalid',
  });
  let node = { leaf: '0123456789' };
  for (let level = 0; level < 30; level += 1) node = { a: node, b: node };
  const started = process.hrtime.bigint();
  const result = gate({ maxMessageBytes: 1024 }).validate(hostileEnvelope([operation('dag', node)]));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(result, { ok: false, reason: 'remote-message-budget-exceeded' });
  assert.ok(elapsedMs < 250, `DAG amplification must stop at the budget (${elapsedMs}ms)`);
});

check('small raw-binary payload keeps the #4964 egress classification precedence', () => {
  const result = gate({ maxMessageBytes: 4096 }).validate(
    hostileEnvelope([operation('binary', new Uint8Array([1, 2, 3]))]),
  );
  assert.deepEqual(result, { ok: false, reason: 'remote-raw-binary-egress-forbidden' });
});

check('oversized rejection leaves no replay, snapshot, or proof state', () => {
  const instance = gate({ maxMessageBytes: 1024 });
  const oversized = hostileEnvelope([operation('leak', 'q'.repeat(2 * 1024 * 1024))]);
  assert.equal(instance.accept(oversized).status, 'rejected');
  assert.equal(instance.validatedSnapshot(oversized), null);
  assert.equal(instance.snapshot().seenMessageCount, 0);
  assert.equal(instance.seenEnvelopeIds.size, 0);
  assert.deepEqual(
    instance.validate(hostileEnvelope([operation('later')], { messageId: 'message:later', sequence: 2 })),
    { ok: false, reason: 'remote-envelope-identity-mismatch' },
    'a later envelope must still be judged on its own authority',
  );
});

check('hostile proxies cannot turn admission into a thrown ingress error', () => {
  const throwingLength = new Proxy([{}, {}], {
    get(target, key) {
      if (key === 'length') throw new Error('length-getter-invoked');
      return Reflect.get(target, key);
    },
  });
  const instance = gate({ maxBatch: 1 });
  assert.doesNotThrow(() => assert.deepEqual(
    instance.validate(hostileEnvelope(throwingLength)),
    { ok: false, reason: 'remote-raw-binary-egress-forbidden' },
  ));
  const accessorOperations = hostileEnvelope([{}]);
  Object.defineProperty(accessorOperations, 'operations', { enumerable: true, get() { throw new Error('accessor-invoked'); } });
  assert.doesNotThrow(() => assert.deepEqual(
    instance.validate(accessorOperations),
    { ok: false, reason: 'remote-envelope-shape-invalid' },
    'an unreadable operations accessor must stay with the existing fail-closed shape path',
  ));
  const nonArray = hostileEnvelope('not-an-array');
  assert.deepEqual(instance.validate(nonArray), { ok: false, reason: 'remote-batch-budget-exceeded' });
});

check('admission keeps the normal valid path intact', () => {
  const instance = gate({ maxBatch: 4, maxMessageBytes: 1024 * 1024 });
  const envelope = validEnvelope();
  assert.deepEqual(instance.validate(envelope), { ok: true });
  assert.equal(instance.validatedSnapshot(envelope).envelopeId, envelope.envelopeId);
  assert.equal(instance.accept(envelope).status, 'accepted');
});

const failed = cases.filter((entry) => !entry.ok);
console.log(`issue-8652 regression: ${cases.length - failed.length}/${cases.length} passed`);
if (failed.length) {
  throw new AggregateError(failed.map((entry) => entry.error), `issue-8652 regression: ${failed.length} case(s) failed`);
}
