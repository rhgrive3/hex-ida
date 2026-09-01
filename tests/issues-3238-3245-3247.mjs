import assert from 'node:assert/strict';
import { boolSort } from '../js/symbolic/expr/kinds.js';
import { createFreshSymbol, resetSymbolCounterForTesting } from '../js/symbolic/expr/factory.js';
import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';
import { computeStructuralHash, structuralEquals } from '../js/symbolic/expr/hash.js';
import { exprToPlain, plainToExpr } from '../js/symbolic/expr/serialize.js';
import { isCacheableProof } from '../js/symbolic/evidence/cache-policy.js';
import { SOLVER_STATUS } from '../js/symbolic/solver/result.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';

const complete = Object.freeze({
  translation: 'complete', controlFlow: 'complete', memoryEffects: 'complete',
  pathCoverage: 'complete', queryScope: 'complete',
});
const baseProof = {
  verdict: 'proved', solverStatus: SOLVER_STATUS.UNSAT,
  proofAuthority: PROOF_AUTHORITY.EXACT, capabilityFingerprint: 'fp',
  backendId: 'test', backendVersion: '1', preconditionStatus: 'satisfiable',
};
assert.equal(isCacheableProof({ ...baseProof, completeness: complete }), true);
assert.equal(isCacheableProof({ ...baseProof, completeness: null }), false);
assert.equal(isCacheableProof({ ...baseProof, completeness: { ...complete, controlFlow: 'partial' } }), false);
assert.equal(isCacheableProof({ ...baseProof, completeness: { translation: 'complete' } }), false);

resetSymbolCounterForTesting(0);
const flag = createFreshSymbol(boolSort(), 'flag');
assert.equal(evaluateExpr(flag, { [flag.symbolId]: true }).value, true);
assert.equal(evaluateExpr(flag, { [flag.symbolId]: { value: false } }).value, false);
for (const malformed of ['false', 1, {}, [], { value: 'false' }]) {
  assert.equal(evaluateExpr(flag, { [flag.symbolId]: malformed }).status, EVAL_STATUS.UNKNOWN);
}

const a = createFreshSymbol(boolSort(), 'x');
const b = createFreshSymbol(boolSort(), 'x');
assert.notEqual(a.symbolId, b.symbolId);
assert.notEqual(computeStructuralHash(a), computeStructuralHash(b));
assert.equal(structuralEquals(a, b), false);
const plain = exprToPlain(a);
createFreshSymbol(boolSort(), 'other');
const restored = plainToExpr(plain);
assert.equal(restored.symbolId, a.symbolId);
assert.equal(computeStructuralHash(restored), computeStructuralHash(a));
assert.equal(structuralEquals(restored, a), true);
const next = createFreshSymbol(boolSort(), 'x');
assert.notEqual(next.symbolId, restored.symbolId);
assert.throws(() => plainToExpr({ ...plain, symbolId: 'sym_0_x' }), TypeError);

console.log('issues 3238/3245/3246/3247 regressions passed');
