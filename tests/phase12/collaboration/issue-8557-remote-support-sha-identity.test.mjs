import assert from 'node:assert/strict';

import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  remoteCollaborationSupport,
} from '../../../js/collaboration/remote-authority.js';
import { validatedCapabilityProofFixture } from '../../stage2/helpers/profile-proof-fixture.mjs';

const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);

function activeGate() {
  const gate = new RemoteCollaborationGate({
    projectIdentity: 'project:issue-8557',
    binaryIdentity: 'binary:issue-8557',
    sessionIdentity: 'session:issue-8557',
    allowedActors: { alice: ['*'] },
    verifyTransportProof: (proof) => proof?.proofIdentity === 'tls:issue-8557',
    transportVerifierIdentity: 'oracle:S2-P12-COLLAB-REMOTE:independent',
  });
  const envelope = createRemoteCollaborationEnvelope({
    projectIdentity: 'project:issue-8557',
    binaryIdentity: 'binary:issue-8557',
    sessionIdentity: 'session:issue-8557',
    actorIdentity: 'alice',
    deviceIdentity: 'device:alice',
    messageId: 'message:issue-8557',
    sequence: 1,
    operations: [{ targetEntityId: 'fn:1000', factKind: 'name', action: 'set', payload: 'main' }],
    transportProof: {
      authenticated: true,
      confidentiality: 'verified',
      integrity: 'verified',
      proofIdentity: 'tls:issue-8557',
    },
    egress: { userAuthorized: true, rawBinaryBytes: false, derivedDataOnly: true },
  });
  assert.deepEqual(gate.validate(envelope), { ok: true });
  return gate;
}

const { proofs } = validatedCapabilityProofFixture();
const profileProof = proofs['S2-P12-COLLAB-REMOTE'];
const gate = activeGate();

assert.equal(remoteCollaborationSupport({
  gate,
  profileProof,
  expectedCommitSha: COMMIT_SHA,
  expectedTreeSha: TREE_SHA,
}).status, 'supported-for-exact-security-profile');

assert.equal(remoteCollaborationSupport({
  gate,
  profileProof,
  expectedCommitSha: COMMIT_SHA.toUpperCase(),
  expectedTreeSha: TREE_SHA.toUpperCase(),
}).status, 'supported-for-exact-security-profile', 'canonical primitive SHA matching remains case-insensitive');

for (const expectedCommitSha of [[COMMIT_SHA], new String(COMMIT_SHA), { toString: () => COMMIT_SHA }, 1, true]) {
  assert.equal(remoteCollaborationSupport({
    gate,
    profileProof,
    expectedCommitSha,
    expectedTreeSha: TREE_SHA,
  }).status, 'unsupported', 'structured/non-string commit identity must fail closed');
}

for (const expectedTreeSha of [[TREE_SHA], new String(TREE_SHA), { toString: () => TREE_SHA }, 1, true]) {
  assert.equal(remoteCollaborationSupport({
    gate,
    profileProof,
    expectedCommitSha: COMMIT_SHA,
    expectedTreeSha,
  }).status, 'unsupported', 'structured/non-string tree identity must fail closed');
}

let coercions = 0;
const hostileCommit = { toString() { coercions += 1; return COMMIT_SHA; } };
const hostileTree = { toString() { coercions += 1; return TREE_SHA; } };
assert.equal(remoteCollaborationSupport({ gate, profileProof, expectedCommitSha: hostileCommit, expectedTreeSha: TREE_SHA }).status, 'unsupported');
assert.equal(remoteCollaborationSupport({ gate, profileProof, expectedCommitSha: COMMIT_SHA, expectedTreeSha: hostileTree }).status, 'unsupported');
assert.equal(coercions, 0, 'authority identity validation must not invoke coercion hooks');

for (const [expectedCommitSha, expectedTreeSha] of [
  [null, TREE_SHA],
  [COMMIT_SHA, null],
  ['c'.repeat(40), TREE_SHA],
  [COMMIT_SHA, 'c'.repeat(40)],
  ['not-a-sha', TREE_SHA],
  [COMMIT_SHA, 'not-a-sha'],
]) {
  assert.equal(remoteCollaborationSupport({ gate, profileProof, expectedCommitSha, expectedTreeSha }).status, 'unsupported');
}

console.log('issue #8557 remote collaboration exact-head SHA identity regressions: PASS');
