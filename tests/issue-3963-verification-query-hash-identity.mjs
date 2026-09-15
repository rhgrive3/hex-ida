import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort } from '../js/symbolic/expr/kinds.js';
import { BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { createBv, createCompare, createFreshSymbol } from '../js/symbolic/expr/factory.js';
import {
  CLAIM_KIND,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
  isVerificationQuery,
} from '../js/symbolic/verify/query.js';
import { SOLVER_STATUS, isValidSolverResult } from '../js/symbolic/solver/result.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { computeProofCacheKey, isCacheableProof } from '../js/symbolic/evidence/cache-policy.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';

function canonicalQuery() {
  const x = createFreshSymbol(bvSort(1), 'x3963');
  return {
    x,
    query: createVerificationQuery({
      kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
      claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
      targetEntity: 'q3963',
      assertion: createCompare(BV_COMPARE_OP.EQ, x, createBv(1, 0n)),
    }),
  };
}

test('#3963 changed assertion with copied queryHash is rejected by the validator', () => {
  const { x, query } = canonicalQuery();
  const forged = { ...query, assertion: createCompare(BV_COMPARE_OP.NE, x, x), queryHash: query.queryHash };
  assert.equal(isVerificationQuery(forged), false);
});

test('#3963 changed constraints/assumptions/versions with copied queryHash are rejected', () => {
  const { query } = canonicalQuery();
  for (const [index, forged] of [
    { ...query, constraints: [{ kind: 'bogus' }], queryHash: query.queryHash },
    { ...query, assumptions: ['extra'], queryHash: query.queryHash },
    { ...query, semanticIrVersion: '9.9.9', queryHash: query.queryHash },
    { ...query, translatorVersion: '9.9.9', queryHash: query.queryHash },
    { ...query, proofScope: { kind: 'extra' }, queryHash: query.queryHash },
    { ...query, completeness: { ...query.completeness, lowering: 'partial' }, queryHash: query.queryHash },
  ].entries()) {
    assert.equal(isVerificationQuery(forged), false, `stale-hash forgery #${index} must be rejected`);
  }
});

test('#3963 exact solver boundary refuses a stale-hash forged query before SAT/UNSAT', async () => {
  const { x, query } = canonicalQuery();
  const forged = { ...query, assertion: createCompare(BV_COMPARE_OP.NE, x, x), queryHash: query.queryHash };
  const result = await new ExhaustiveBvBackend().createSession().check(forged);
  assert.equal(result.status, SOLVER_STATUS.INVALID_QUERY);
  assert.equal(isCacheableProof({ verdict: 'proved', solverStatus: result.status, capabilityFingerprint: 'cf', backendId: 'hex-exhaustive-bv', backendVersion: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT }), false);

  const canonical = await new ExhaustiveBvBackend().createSession().check(query);
  assert.equal(canonical.status, SOLVER_STATUS.SAT);
  assert.equal(canonical.queryHash, query.queryHash);
});

test('#3963 serialized/deserialized canonical query is accepted with the same recomputed hash', () => {
  const { query } = canonicalQuery();
  const clone = structuredClone({ ...query });
  assert.equal(isVerificationQuery(clone), true);
  assert.equal(clone.queryHash, query.queryHash);
});

test('#3963 copying a forged hash into both query and result cannot satisfy result validation', async () => {
  const { x, query } = canonicalQuery();
  const forged = { ...query, assertion: createCompare(BV_COMPARE_OP.NE, x, x), queryHash: query.queryHash };
  const forgedResult = {
    status: SOLVER_STATUS.UNSAT,
    model: null,
    reason: null,
    stats: {},
    backend: 'hex-exhaustive-bv',
    backendVersion: '1.0.0',
    queryHash: query.queryHash,
    lifecycle: { publishable: true },
  };
  assert.equal(isValidSolverResult(forgedResult, { query: forged }), false);
});

test('#3963 proof-cache identity comes from the verified canonical hash', () => {
  const { x, query } = canonicalQuery();
  const forged = { ...query, assertion: createCompare(BV_COMPARE_OP.NE, x, x), queryHash: query.queryHash };
  assert.equal(isVerificationQuery(forged), false);
  const canonicalKey = computeProofCacheKey({ queryHash: query.queryHash, verifierFingerprint: 'vf3963' });
  assert.ok(typeof canonicalKey === 'string' && canonicalKey.length > 0);
  const other = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: 'q3963',
    assertion: createCompare(BV_COMPARE_OP.EQ, x, createBv(1, 1n)),
  });
  assert.notEqual(computeProofCacheKey({ queryHash: other.queryHash, verifierFingerprint: 'vf3963' }), canonicalKey);
});

test('#3963 factory-created frozen queries remain valid', () => {
  const { query } = canonicalQuery();
  assert.equal(isVerificationQuery(query), true);
});
