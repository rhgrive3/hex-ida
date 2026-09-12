import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_VERDICT,
  PRECONDITION_STATUS,
  createSymbolicEvidence,
  isProvedEvidence,
} from '../../../js/symbolic/evidence/symbolic-evidence.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { PROOF_AUTHORITY } from '../../../js/symbolic/solver/backend.js';
import { COMPLETENESS_STATUS, createCompleteness } from '../../../js/symbolic/translate/support-matrix.js';

const allComplete = createCompleteness({
  translation: COMPLETENESS_STATUS.COMPLETE,
  controlFlow: COMPLETENESS_STATUS.COMPLETE,
  memoryEffects: COMPLETENESS_STATUS.COMPLETE,
  pathCoverage: COMPLETENESS_STATUS.COMPLETE,
  queryScope: COMPLETENESS_STATUS.COMPLETE,
});

function exactProof(overrides = {}) {
  return {
    queryKind: 'equivalence',
    claimKind: 'bounded-equivalence',
    proofStatement: 'x == x',
    targetEntities: ['fn:1'],
    queryHash: 'q1',
    backendId: 'solver',
    backendVersion: '1',
    proofAuthority: PROOF_AUTHORITY.EXACT,
    capabilityFingerprint: 'cap',
    solverStatus: SOLVER_STATUS.UNSAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    verdict: EVIDENCE_VERDICT.PROVED,
    completeness: allComplete,
    architecture: 'arm64',
    bitWidth: 64,
    ...overrides,
  };
}

test('#4663 valid primitive scope metadata keeps minting proved evidence', () => {
  const evidence = createSymbolicEvidence(exactProof());
  assert.equal(evidence.architecture, 'arm64');
  assert.equal(evidence.bitWidth, 64);
  assert.deepEqual(evidence.targetEntities, ['fn:1']);
  assert.equal(isProvedEvidence(evidence), true);

  const again = createSymbolicEvidence(exactProof());
  assert.equal(again.id, evidence.id, 'evidence ID determinism must survive the type guards');

  const defaults = createSymbolicEvidence(exactProof({ architecture: undefined, bitWidth: undefined }));
  assert.equal(defaults.architecture, 'generic');
  assert.equal(defaults.bitWidth, null);
  assert.equal(isProvedEvidence(defaults), true);
});

test('#4663 structured architecture is not laundered into a primitive string', () => {
  assert.throws(() => createSymbolicEvidence(exactProof({ architecture: ['arm64'] })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ architecture: { toString: () => 'arm64' } })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ architecture: 64 })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ architecture: '' })), TypeError);
});

test('#4663 structured or numeric-string bitWidth is not laundered into a number', () => {
  assert.throws(() => createSymbolicEvidence(exactProof({ bitWidth: ['64'] })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ bitWidth: '64' })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ bitWidth: 64.5 })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ bitWidth: 0 })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ bitWidth: -64 })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ bitWidth: Number.MAX_SAFE_INTEGER + 1 })), TypeError);
});

test('#4663 structured target entities cannot become canonical entity IDs', () => {
  assert.throws(() => createSymbolicEvidence(exactProof({ targetEntities: [{ id: 'x' }] })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ targetEntities: [{ toString: () => 'fn:1' }] })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ targetEntities: [1] })), TypeError);
  assert.throws(() => createSymbolicEvidence(exactProof({ targetEntities: [''] })), TypeError);
});

test('#4663 identity collision between a JSON-shaped string and an equivalent object target is closed', () => {
  const stringTarget = createSymbolicEvidence(exactProof({ targetEntities: ['{"id":"x"}'] }));
  assert.equal(isProvedEvidence(stringTarget), true);
  assert.throws(() => createSymbolicEvidence(exactProof({ targetEntities: [{ id: 'x' }] })), TypeError,
    'the object form must never reach the evidence identity material');
});

test('#4663 malformed scope metadata cannot mint proved evidence', () => {
  for (const overrides of [
    { architecture: ['arm64'], bitWidth: ['64'], targetEntities: ['fn:1'] },
    { architecture: 'arm64', bitWidth: ['64'] },
    { architecture: 'arm64', bitWidth: 64, targetEntities: [{ id: 'x' }] },
    { architecture: 'arm64', bitWidth: 64, targetEntities: [['fn:1']] },
  ]) {
    assert.throws(() => createSymbolicEvidence(exactProof(overrides)), TypeError);
  }
});
