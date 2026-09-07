import assert from 'node:assert/strict';
import test from 'node:test';
import * as collaboration from '../../../js/collaboration/index.js';

const { ChangeLog, createProjectOperation } = collaboration;
const base = { projectIdentity: 'project:review', binaryIdentity: 'binary:review' };
const op = (operationId, extra = {}) => createProjectOperation({
  ...base, operationId, targetEntityId: operationId, factKind: 'name', payload: 'value', ...extra,
});
const invalid = [[], ['alice'], {}, false, true, 0, 1, 1n, new String('alice'), '', '   '];

test('configured authors reject non-string identities without coercion', () => {
  let conversions = 0;
  const coercible = { [Symbol.toPrimitive]() { conversions++; return 'alice'; } };
  for (const value of [...invalid, coercible]) {
    assert.throws(
      () => new ChangeLog({ ...base, allowRemote: true, authorizedAuthors: [value] }),
      /changelog-author-identity-invalid/,
    );
  }
  assert.equal(conversions, 0);
  const log = new ChangeLog({ ...base, allowRemote: true, authorizedAuthors: [' alice ', 'alice'] });
  assert.deepEqual([...log.authorizedAuthors], ['alice']);
  assert.equal(log.applyOperation(op('allowed', {
    authorIdentity: 'alice', provenance: { transport: 'remote' },
  })).status, 'applied');
  assert.equal(log.applyOperation(op('denied', {
    authorIdentity: 'bob', provenance: { transport: 'remote' },
  })).reason, 'unauthorized-remote-actor');
});

test('causal parents reject structured identities and retain canonical dependencies', () => {
  let conversions = 0;
  const coercible = { toString() { conversions++; return 'parent'; } };
  for (const value of [...invalid, coercible]) {
    assert.throws(() => op('child', { causalParents: [value] }), /operation-causal-parent-invalid/);
  }
  assert.equal(conversions, 0);
  for (const value of ['parent', {}, true, 1]) {
    assert.throws(() => op('child', { causalParents: value }), /operation-causal-parents-invalid/);
  }
  for (const value of [null, undefined]) assert.deepEqual(op('child', { causalParents: value }).causalParents, []);
  const child = op('child', { causalParents: [' parent ', 'parent'] });
  assert.deepEqual(child.causalParents, ['parent']);
  const log = new ChangeLog(base);
  assert.equal(log.applyOperation(child).status, 'unresolved');
  assert.equal(log.applyOperation(op('parent')).status, 'applied');
  assert.equal(log.operations.get('child'), child);
});

test('constructor validates restored applied and pending operation identities', () => {
  const canonical = op('child', { causalParents: ['parent'] });
  const forged = { ...canonical, targetEntityId: ['child'] };
  assert.throws(() => new ChangeLog({ ...base, operations: [forged] }), /operation-target-entity-required/);
  assert.throws(() => new ChangeLog({ ...base, pending: [['child', forged]] }), /operation-target-entity-required/);
  for (const key of ['wrong-id', ['child'], {}]) {
    assert.throws(() => new ChangeLog({ ...base, pending: [[key, canonical]] }), /changelog-pending-(key-invalid|id-mismatch)/);
  }
  const log = new ChangeLog({ ...base, pending: new Map([['child', canonical]]) });
  assert.equal(log.pending.get('child'), canonical);
  assert.equal(log.applyOperation(op('parent')).status, 'applied');
  assert.equal(log.pending.size, 0);
  assert.equal(log.operations.get('child'), canonical);
  assert.equal(log.snapshot().facts['child\0name'].values[0].value, 'value');
});

test('restoration rejects duplicate IDs bound to different canonical content', () => {
  const first = op('same');
  const different = op('same', { payload: 'different' });
  assert.throws(() => new ChangeLog({ ...base, operations: [first, different] }), /operation-id-content-mismatch/);
  assert.throws(() => new ChangeLog({ ...base, pending: [['same', first], ['same', different]] }), /operation-id-content-mismatch/);
  const identical = new ChangeLog({ ...base, operations: [first, first], pending: [['same', first], ['same', first]] });
  assert.equal(identical.operations.size, 1);
  assert.equal(identical.pending.size, 1);
});

test('canonical factory provenance preserves identity but schema tags do not establish it', () => {
  assert.equal(typeof collaboration.canonicalizeProjectOperation, 'function');
  assert.equal(typeof collaboration.isCanonicalProjectOperation, 'function');
  const original = op('canonical');
  assert.equal(collaboration.isCanonicalProjectOperation(original), true);
  assert.equal(collaboration.canonicalizeProjectOperation(original), original);
  const raw = { ...original };
  assert.equal(collaboration.isCanonicalProjectOperation(raw), false);
  assert.equal(collaboration.isCanonicalProjectOperation(Object.freeze(raw)), false);
  const normalized = collaboration.canonicalizeProjectOperation(raw);
  assert.notEqual(normalized, raw);
  assert.equal(collaboration.isCanonicalProjectOperation(normalized), true);
  assert.equal(
    collaboration.canonicalizeProjectOperation({ ...original, targetEntityId: ['canonical'] }),
    null,
  );
});

test('remote consumer imports canonical helpers and rejects malformed operations without publication', async () => {
  const { RemoteCollaborationGate, createRemoteCollaborationEnvelope, envelopeIdentity } = await import('../../../js/collaboration/remote-authority.js');
  const gate = new RemoteCollaborationGate({
    ...base, sessionIdentity: 'session', allowedActors: { alice: ['*'] },
    verifyTransportProof: () => true, transportVerifierIdentity: 'review-verifier',
  });
  const envelope = createRemoteCollaborationEnvelope({
    ...base, sessionIdentity: 'session', actorIdentity: 'alice', deviceIdentity: 'device',
    messageId: 'message', sequence: 1,
    operations: [{ targetEntityId: 'entity', factKind: 'name', payload: 'value' }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified' },
    egress: { userAuthorized: true },
  });
  assert.deepEqual(gate.validate(envelope), { ok: true });
  for (const value of [null, {}, { ...envelope.operations[0], targetEntityId: ['entity'] }]) {
    const malformed = { ...envelope, operations: [value] };
    malformed.envelopeId = envelopeIdentity(malformed);
    assert.deepEqual(gate.accept(malformed), { status: 'rejected', reason: 'remote-operation-shape-invalid' });
    assert.equal(gate.seenMessages.size, 0);
    assert.equal(gate.lastSequenceByActor.size, 0);
  }
  assert.equal(gate.accept(envelope).status, 'accepted');
});
