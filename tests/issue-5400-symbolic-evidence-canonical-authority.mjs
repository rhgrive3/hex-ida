import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isProvedEvidence,
  isRefutedEvidence,
  createSymbolicEvidence,
  EVIDENCE_VERDICT,
  PRECONDITION_STATUS,
  VALIDATION_STATUS,
  EVIDENCE_SCHEMA_VERSION,
} from '../js/symbolic/evidence/symbolic-evidence.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';

function mintProved(overrides = {}) {
  return createSymbolicEvidence({
    queryKind: 'bounded-equivalence',
    claimKind: 'bounded-equivalence',
    proofStatement: 'equivalence holds',
    targetEntities: ['func:0x1000'],
    queryHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    backendId: 'fake-exact',
    backendVersion: '1.0.0',
    solverStatus: SOLVER_STATUS.UNSAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    capabilityFingerprint: 'fp-1',
    proofAuthority: PROOF_AUTHORITY.EXACT,
    verdict: EVIDENCE_VERDICT.PROVED,
    ...overrides,
  });
}

const FORGED_PLAIN_OBJECT = {
  verdict: 'proved',
  proofAuthority: 'exact',
  capabilityFingerprint: 'anything',
  preconditionStatus: 'satisfiable',
  completeness: {
    translation: 'complete', controlFlow: 'complete', memoryEffects: 'complete',
    pathCoverage: 'complete', queryScope: 'complete',
  },
  solverStatus: 'unsat',
};

test('#5400 forged plain objects must not pass the proved predicate', () => {
  assert.equal(isProvedEvidence(FORGED_PLAIN_OBJECT), false);
  assert.equal(isProvedEvidence(null), false);
  assert.equal(isProvedEvidence('proved'), false);
});

test('#5400 canonical proved evidence stays accepted', () => {
  const evidence = mintProved();
  assert.equal(isProvedEvidence(evidence), true);
  assert.equal(isRefutedEvidence(evidence), false);
});

test('#5400 tampered identity fields invalidate the record', () => {
  const evidence = mintProved();
  for (const [field, value] of [
    ['queryHash', 'f'.repeat(64)],
    ['backendId', 'other-backend'],
    ['backendVersion', '9.9.9'],
    ['queryKind', 'edge-feasibility'],
    ['claimKind', 'edge-feasibility'],
    ['verdict', EVIDENCE_VERDICT.REFUTED],
    ['proofAuthority', PROOF_AUTHORITY.NONE],
    ['capabilityFingerprint', 'fp-2'],
    ['id', 'ev_00000000000000000000000000000000'],
    ['schemaVersion', '9.9.9'],
  ]) {
    assert.equal(isProvedEvidence({ ...evidence, [field]: value }), false,
      `tampered ${field} must fail the proved predicate`);
  }
});

test('#5400 capabilityFingerprintHash mismatch fails closed', () => {
  const evidence = mintProved();
  assert.equal(isProvedEvidence({ ...evidence, capabilityFingerprintHash: 'deadbeef' }), false);
  assert.equal(isProvedEvidence({ ...evidence, capabilityFingerprint: null }), false,
    'fingerprint removal must invalidate both hash pairing and authority');
});

test('#5400 canonical records reject non-canonical field shapes', () => {
  const evidence = mintProved();
  const aliasEntity = { toString() { return evidence.targetEntities[0]; } };
  assert.equal(isProvedEvidence({ ...evidence, targetEntities: [aliasEntity] }), false);
  assert.equal(isProvedEvidence({ ...evidence, capabilityFingerprint: { value: 'fp-1' } }), false);
  assert.equal(isProvedEvidence({ ...evidence, proofStatement: null }), false);
});

test('#5400 the refuted predicate shares the canonicality boundary', () => {
  const refuted = createSymbolicEvidence({
    queryKind: 'bounded-equivalence',
    claimKind: 'bounded-equivalence',
    proofStatement: 'counterexample found',
    targetEntities: ['func:0x2000'],
    queryHash: 'deadbeef12345678deadbeef12345678deadbeef12345678deadbeef12345678',
    backendId: 'fake-solver',
    backendVersion: '1.0.0',
    solverStatus: SOLVER_STATUS.SAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    validationStatus: VALIDATION_STATUS.VALIDATED,
    verdict: EVIDENCE_VERDICT.REFUTED,
    witnessModel: new Map([['arg_x0', 42n]]),
  });
  assert.equal(isRefutedEvidence(refuted), true);
  assert.equal(isRefutedEvidence({ ...refuted, queryHash: '0'.repeat(64) }), false);
  assert.equal(isRefutedEvidence({ ...refuted, id: 'ev_ff' }), false);
  assert.equal(isRefutedEvidence({ verdict: 'refuted', solverStatus: 'sat' }), false);
  assert.equal(isProvedEvidence({ ...refuted }), false);
  assert.equal(EVIDENCE_SCHEMA_VERSION, '1.1.0');
});
