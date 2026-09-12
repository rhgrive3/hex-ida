/**
 * Issue #4955 regression: `transportVerifierIdentity` must not be an independent
 * caller-supplied label. Remote support authority may only be reached when the
 * gate's transport verifier is a trusted capability atomically bound to the
 * validated Stage2 independent-oracle identity. A raw `() => true` paired with a
 * copied oracle identity string cannot be promoted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  remoteCollaborationSupport,
} from '../js/collaboration/remote-authority.js';
import * as remoteAuthority from '../js/collaboration/remote-authority.js';
import { validatedCapabilityProofFixture } from './stage2/helpers/profile-proof-fixture.mjs';

const ORACLE_IDENTITY = 'oracle:S2-P12-COLLAB-REMOTE:independent';

function envelope(proofIdentity = 'tls:real') {
  return createRemoteCollaborationEnvelope({
    projectIdentity: 'project:4955',
    sessionIdentity: 'session:4955',
    actorIdentity: 'alice',
    deviceIdentity: 'device:alice',
    messageId: `message:${proofIdentity}:${Math.random().toString(36).slice(2)}`,
    sequence: 1,
    operations: [{ targetEntityId: 'fn:4955', factKind: 'name', action: 'set', payload: 'x' }],
    transportProof: { authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity },
    egress: { userAuthorized: true, derivedDataOnly: true },
  });
}

function gate({ verifyTransportProof, transportVerifierIdentity }) {
  return new RemoteCollaborationGate({
    projectIdentity: 'project:4955',
    sessionIdentity: 'session:4955',
    allowedActors: { alice: ['*'] },
    verifyTransportProof,
    transportVerifierIdentity,
  });
}

function supportFor(gateInstance, profileProof, env) {
  assert.deepEqual(gateInstance.accept(env).status === 'accepted' ? { ok: true } : gateInstance.validate(env), { ok: true }, 'fixture envelope must pass gate');
  return remoteCollaborationSupport({
    gate: gateInstance,
    profileProof,
    expectedCommitSha: profileProof.commitSha,
    expectedTreeSha: profileProof.treeSha,
  });
}

const { proofs } = validatedCapabilityProofFixture();
const profileProof = proofs['S2-P12-COLLAB-REMOTE'];

test('#4955 arbitrary () => true + copied oracle identity cannot mint support', () => {
  const g = gate({ verifyTransportProof: () => true, transportVerifierIdentity: ORACLE_IDENTITY });
  assert.equal(supportFor(g, profileProof, envelope()).status, 'unsupported');
});

test('#4955 a real-checking raw function still lacks oracle-capability provenance', () => {
  const g = gate({ verifyTransportProof: (proof) => proof.proofIdentity === 'tls:real', transportVerifierIdentity: ORACLE_IDENTITY });
  assert.equal(supportFor(g, profileProof, envelope()).status, 'unsupported', 'a caller-plugged function is not a validated oracle capability');
});

test('#4955 branded verifier + exact oracle identity + exact head is supported (post validate/accept)', () => {
  const verifier = remoteAuthority.createRemoteTransportVerifier({ oracleIdentity: ORACLE_IDENTITY, verifyTransportProof: (proof) => proof.proofIdentity === 'tls:real' });
  const g = gate({ verifyTransportProof: verifier.verifyTransportProof, transportVerifierIdentity: verifier.transportVerifierIdentity });
  const support = supportFor(g, profileProof, envelope());
  assert.equal(support.status, 'supported-for-exact-security-profile');
  assert.equal(support.authority, 'remote-authorized-canonical-operations');
});

test('#4955 same identity string but non-branded function loses support', () => {
  const branded = remoteAuthority.createRemoteTransportVerifier({ oracleIdentity: ORACLE_IDENTITY, verifyTransportProof: (proof) => proof.proofIdentity === 'tls:real' });
  const swapped = (proof) => proof.proofIdentity === 'tls:real';
  const g = gate({ verifyTransportProof: swapped, transportVerifierIdentity: branded.transportVerifierIdentity });
  assert.equal(supportFor(g, profileProof, envelope()).status, 'unsupported');
});

test('#4955 branded function but self-declared different identity loses support', () => {
  const verifier = remoteAuthority.createRemoteTransportVerifier({ oracleIdentity: ORACLE_IDENTITY, verifyTransportProof: (proof) => proof.proofIdentity === 'tls:real' });
  const g = gate({ verifyTransportProof: verifier.verifyTransportProof, transportVerifierIdentity: 'oracle:4955:spoof' });
  assert.equal(supportFor(g, profileProof, envelope()).status, 'unsupported', 'identity must equal the capability-bound oracle identity');
});

test('#4955 branded verifier whose identity is absent from validated profile evidence loses support', () => {
  const verifier = remoteAuthority.createRemoteTransportVerifier({ oracleIdentity: 'oracle:not-in-evidence:independent', verifyTransportProof: (proof) => proof.proofIdentity === 'tls:real' });
  const g = gate({ verifyTransportProof: verifier.verifyTransportProof, transportVerifierIdentity: verifier.transportVerifierIdentity });
  assert.equal(supportFor(g, profileProof, envelope()).status, 'unsupported', 'provenance must connect to the Stage2 independent-oracle identity set');
});
