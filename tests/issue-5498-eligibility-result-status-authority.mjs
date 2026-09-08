import assert from 'node:assert/strict';
import test from 'node:test';

import { checkProofEligibility } from '../js/symbolic/verify/eligibility.js';
import { isExactProofBackend } from '../js/symbolic/solver/backend.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { createSolverResult, SOLVER_STATUS, isValidSolverResult } from '../js/symbolic/solver/result.js';
import { TRANSLATION_STATUS, COMPLETENESS_STATUS } from '../js/symbolic/translate/support-matrix.js';
import { createVerificationQuery } from '../js/symbolic/verify/query.js';

const backend = new ExhaustiveBvBackend();
const capabilities = backend.capabilities();

const COMPLETE_SCOPE = Object.freeze({
  translation: COMPLETENESS_STATUS.COMPLETE,
  controlFlow: COMPLETENESS_STATUS.COMPLETE,
  memoryEffects: COMPLETENESS_STATUS.COMPLETE,
  pathCoverage: COMPLETENESS_STATUS.COMPLETE,
  queryScope: COMPLETENESS_STATUS.COMPLETE,
});

function greenGateInput(solverResult) {
  return {
    queryValid: true,
    query: createVerificationQuery({ kind: 'bounded_equivalence', claimKind: 'equivalent' }),
    translationStatus: TRANSLATION_STATUS.EXACT,
    scopeCompleteness: COMPLETE_SCOPE,
    semanticUnknowns: 0,
    unsupportedEntities: [],
    assumptionsExplicit: true,
    preconditionsConsistent: true,
    backend,
    solverResult,
    validSolverResult: isValidSolverResult(solverResult, { query: null, backend }),
    solverResultStatus: solverResult?.status ?? null,
  };
}

test('#5498 decoupled solverResultStatus can no longer launder a SAT result into UNSAT eligibility', () => {
  const query = createVerificationQuery({ kind: 'bounded_equivalence', claimKind: 'equivalent' });
  const satResult = createSolverResult({
    status: SOLVER_STATUS.SAT,
    model: { bindings: {} },
    backend: backend.id,
    backendVersion: backend.version,
    queryHash: query.queryHash,
  });
  const gate = checkProofEligibility({
    ...greenGateInput(satResult),
    query,
    validSolverResult: true,
    solverResultStatus: SOLVER_STATUS.UNSAT,
  });
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.some((reason) => reason.startsWith('solver-result-status-not-unsat:sat')),
    `expected result-status reason, got ${JSON.stringify(gate.reasons)}`);
});

test('#5498 a consistent UNSAT result stays eligible', () => {
  const query = createVerificationQuery({ kind: 'bounded_equivalence', claimKind: 'equivalent' });
  const unsatResult = createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: backend.id,
    backendVersion: backend.version,
    queryHash: query.queryHash,
  });
  const gate = checkProofEligibility({
    ...greenGateInput(unsatResult),
    query,
    validSolverResult: true,
    solverResultStatus: SOLVER_STATUS.UNSAT,
  });
  assert.deepEqual([...gate.reasons], []);
  assert.equal(gate.eligible, true);
  const lookalike = { ...backend, capabilities: () => capabilities, capabilityFingerprint: () => backend.capabilityFingerprint() };
  assert.equal(checkProofEligibility({ ...greenGateInput(unsatResult), query, backend: lookalike }).eligible, false,
    'a copied backend declaration cannot inherit genuine exact-provider authority');
});

test('#5498 a non-UNSAT result object fails closed even with a matching label', () => {
  const query = createVerificationQuery({ kind: 'bounded_equivalence', claimKind: 'equivalent' });
  for (const status of [SOLVER_STATUS.SAT, SOLVER_STATUS.UNKNOWN, SOLVER_STATUS.TIMEOUT]) {
    const result = createSolverResult({
      status,
      model: status === SOLVER_STATUS.SAT ? { bindings: {} } : undefined,
      backend: backend.id,
      backendVersion: backend.version,
      queryHash: query.queryHash,
    });
    const gate = checkProofEligibility({
      ...greenGateInput(result),
      query,
      validSolverResult: true,
      solverResultStatus: status,
    });
    assert.equal(gate.eligible, false, `${status} must not be proof-eligible`);
    assert.ok(gate.reasons.some((reason) => reason.startsWith('solver-result-status-not-unsat:')),
      `${status} must carry the result-status reason`);
  }
});

test('#5498 backend proof authority still gates the eligible path', () => {
  const query = createVerificationQuery({ kind: 'bounded_equivalence', claimKind: 'equivalent' });
  const unsatResult = createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    backend: backend.id,
    backendVersion: backend.version,
    queryHash: query.queryHash,
  });
  const weakBackend = { ...backend, proofAuthority: 'heuristic', capabilities: () => ({ ...capabilities, proofAuthority: 'heuristic', exactProofs: false }) };
  assert.equal(isExactProofBackend(weakBackend), false);
  const gate = checkProofEligibility({
    ...greenGateInput(unsatResult),
    query,
    backend: weakBackend,
    validSolverResult: true,
    solverResultStatus: SOLVER_STATUS.UNSAT,
  });
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.some((reason) => reason.startsWith('backend-proof-authority:')));
});
