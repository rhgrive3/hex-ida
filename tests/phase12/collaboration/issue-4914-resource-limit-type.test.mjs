import assert from 'node:assert/strict';
import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
} from '../../../js/collaboration/remote-authority.js';

const baseGate = (overrides = {}) => new RemoteCollaborationGate({
  projectIdentity: 'project:4914',
  binaryIdentity: 'binary:4914',
  sessionIdentity: 'session:4914',
  allowedActors: { alice: ['*'] },
  verifyTransportProof: (proof) => proof?.proofIdentity === 'proof:4914',
  ...overrides,
});

const makeEnvelope = (operations) => createRemoteCollaborationEnvelope({
  projectIdentity: 'project:4914',
  binaryIdentity: 'binary:4914',
  sessionIdentity: 'session:4914',
  actorIdentity: 'alice',
  deviceIdentity: 'device:alice',
  messageId: `message:${operations.length}`,
  sequence: 1,
  operations,
  transportProof: {
    authenticated: true,
    confidentiality: 'verified',
    integrity: 'verified',
    proofIdentity: 'proof:4914',
  },
  egress: {
    userAuthorized: true,
    rawBinaryBytes: false,
    derivedDataOnly: true,
  },
});

const operation = (suffix) => ({
  operationId: `op:${suffix}`,
  targetEntityId: `entity:${suffix}`,
  factKind: 'name',
  action: 'set',
  payload: `value:${suffix}`,
});

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

check('primitive integer limits remain accepted', () => {
  const gate = baseGate({ maxBatch: 8, maxMessageBytes: 65536 });
  assert.equal(gate.maxBatch, 8);
  assert.equal(gate.maxMessageBytes, 65536);
});

check('nullish limits retain defaults', () => {
  assert.equal(baseGate().maxBatch, 256);
  assert.equal(baseGate().maxMessageBytes, 1024 * 1024);
  assert.equal(baseGate({ maxBatch: null, maxMessageBytes: null }).maxBatch, 256);
});

check('maxBatch rejects coercible non-number values', () => {
  for (const value of ['1', ['1'], true, 1n, new Number(1)]) {
    assert.throws(
      () => baseGate({ maxBatch: value }),
      { name: 'TypeError', message: 'remote-gate-max-batch-invalid' },
      `maxBatch must reject ${Object.prototype.toString.call(value)}`,
    );
  }
});

check('maxMessageBytes rejects coercible non-number values', () => {
  for (const value of ['1024', ['1024'], true, 1024n, new Number(1024)]) {
    assert.throws(
      () => baseGate({ maxMessageBytes: value }),
      { name: 'TypeError', message: 'remote-gate-max-message-invalid' },
      `maxMessageBytes must reject ${Object.prototype.toString.call(value)}`,
    );
  }
});

check('numeric range validation remains fail-closed', () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4097]) {
    assert.throws(() => baseGate({ maxBatch: value }), { name: 'TypeError', message: 'remote-gate-max-batch-invalid' });
  }
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 32 * 1024 * 1024 + 1]) {
    assert.throws(() => baseGate({ maxMessageBytes: value }), { name: 'TypeError', message: 'remote-gate-max-message-invalid' });
  }
});

check('invalid structured limits are not coerced or executed', () => {
  let batchCoercions = 0;
  let messageCoercions = 0;
  const batchValue = { valueOf() { batchCoercions++; return 1; } };
  const messageValue = { [Symbol.toPrimitive]() { messageCoercions++; return 1024; } };
  assert.throws(() => baseGate({ maxBatch: batchValue }), { name: 'TypeError', message: 'remote-gate-max-batch-invalid' });
  assert.throws(() => baseGate({ maxMessageBytes: messageValue }), { name: 'TypeError', message: 'remote-gate-max-message-invalid' });
  assert.equal(batchCoercions, 0);
  assert.equal(messageCoercions, 0);
});

check('valid maxBatch still enforces the remote batch budget', () => {
  const gate = baseGate({ maxBatch: 1, maxMessageBytes: 65536 });
  const result = gate.validate(makeEnvelope([operation('a'), operation('b')]));
  assert.deepEqual(result, { ok: false, reason: 'remote-batch-budget-exceeded' });
});

check('valid maxMessageBytes still enforces bytes and valid envelopes pass', () => {
  const envelope = makeEnvelope([operation('a')]);
  assert.deepEqual(baseGate({ maxBatch: 1, maxMessageBytes: 64 }).validate(envelope), {
    ok: false,
    reason: 'remote-message-budget-exceeded',
  });
  assert.deepEqual(baseGate({ maxBatch: 1, maxMessageBytes: 65536 }).validate(envelope), { ok: true });
});

const failed = cases.filter((entry) => !entry.ok);
console.log(`issue-4914 regression: ${cases.length - failed.length}/${cases.length} passed`);
if (failed.length) {
  throw new AggregateError(failed.map((entry) => entry.error), `issue-4914 regression: ${failed.length} case(s) failed`);
}
