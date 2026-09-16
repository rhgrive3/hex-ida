/**
 * Issue #8839 regression: `createRemoteTransportVerifier()` is a public factory,
 * so a caller can pair a *valid* independent-oracle identity copied from a
 * Stage2 profile proof with a trivially permissive verifier and receive the
 * exact brand `remoteCollaborationSupport()` treats as trusted provenance. The
 * mint must therefore withhold the trusted brand from any implementation that
 * behaves like a blanket oracle, while still allowing a genuine independent
 * transport verifier to promote support. A permissive capability may keep the
 * gate functioning, but it must never carry authority.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemoteCollaborationGate,
  createRemoteCollaborationEnvelope,
  createRemoteTransportVerifier,
  remoteCollaborationSupport,
} from '../../../js/collaboration/remote-authority.js';
import { validatedCapabilityProofFixture } from '../../stage2/helpers/profile-proof-fixture.mjs';

const { proofs } = validatedCapabilityProofFixture();
const profileProof = proofs['S2-P12-COLLAB-REMOTE'];
const COPIED_ORACLE_IDENTITY = profileProof.independentOracleIdentities[0];

function envelope(transportProof) {
  return createRemoteCollaborationEnvelope({
    projectIdentity: 'project:8839',
    sessionIdentity: 'session:8839',
    actorIdentity: 'alice',
    deviceIdentity: 'device:alice',
    messageId: `message:8839:${Math.random().toString(36).slice(2)}`,
    sequence: 1,
    operations: [{ targetEntityId: 'fn:8839', factKind: 'name', action: 'set', payload: 'x' }],
    transportProof,
    egress: { userAuthorized: true, derivedDataOnly: true },
  });
}

function supportForGate(gate, env) {
  assert.deepEqual(gate.validate(env), { ok: true }, 'fixture envelope must pass the gate');
  return remoteCollaborationSupport({
    gate,
    profileProof,
    expectedCommitSha: profileProof.commitSha,
    expectedTreeSha: profileProof.treeSha,
  });
}

function gateFrom(verifier) {
  return new RemoteCollaborationGate({
    projectIdentity: 'project:8839',
    sessionIdentity: 'session:8839',
    allowedActors: { alice: ['*'] },
    verifyTransportProof: verifier.verifyTransportProof,
    transportVerifierIdentity: verifier.transportVerifierIdentity,
  });
}

// The exact issue counterexample: copied oracle identity + blanket `() => true`.
test('#8839 public factory mint of `() => true` with a copied oracle identity stays unsupported', () => {
  const fake = createRemoteTransportVerifier({
    oracleIdentity: COPIED_ORACLE_IDENTITY,
    verifyTransportProof: () => true,
  });
  const g = gateFrom(fake);
  const env = envelope({
    authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'not-server-verified',
  });
  const support = supportForGate(g, env);
  assert.equal(support.status, 'unsupported', 'blanket oracle must not self-mint trusted provenance');
  assert.equal(support.authority, 'none');
});

test('#8839 a verifier that only echoes the self-attested authenticated flag stays unsupported', () => {
  const fake = createRemoteTransportVerifier({
    oracleIdentity: COPIED_ORACLE_IDENTITY,
    verifyTransportProof: (proof) => proof.authenticated === true,
  });
  const g = gateFrom(fake);
  const env = envelope({
    authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'attacker-chosen',
  });
  assert.equal(supportForGate(g, env).status, 'unsupported', 'a proof-independent verifier is not an oracle');
});

test('#8839 a genuine proof-identity-checking oracle minted through the factory is supported', () => {
  const verifier = createRemoteTransportVerifier({
    oracleIdentity: COPIED_ORACLE_IDENTITY,
    verifyTransportProof: (proof) => proof.proofIdentity === 'tls:8839:server-issued',
  });
  const g = gateFrom(verifier);
  const env = envelope({
    authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:8839:server-issued',
  });
  const support = supportForGate(g, env);
  assert.equal(support.status, 'supported-for-exact-security-profile', 'independent oracle + exact head promotes support');
  assert.equal(support.authority, 'remote-authorized-canonical-operations');
});

test('#8839 a throwing-but-non-trusting capability keeps its trusted brand (fail-closed attestation)', () => {
  const verifier = createRemoteTransportVerifier({
    oracleIdentity: COPIED_ORACLE_IDENTITY,
    verifyTransportProof: (proof) => {
      if (proof.proofIdentity !== 'tls:8839:server-issued') throw new Error('unrecognised proof');
      return true;
    },
  });
  const g = gateFrom(verifier);
  const env = envelope({
    authenticated: true, confidentiality: 'verified', integrity: 'verified', proofIdentity: 'tls:8839:server-issued',
  });
  assert.equal(supportForGate(g, env).status, 'supported-for-exact-security-profile',
    'a verifier that rejects fabricated proofs still attests');
});
