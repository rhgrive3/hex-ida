import assert from 'node:assert/strict';
import test from 'node:test';
import { bvSort, BV_BINARY_OP, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBv, createFreshSymbol, createBinary, createCompare } from '../../../js/symbolic/expr/factory.js';
import { createVerificationQuery, VERIFICATION_QUERY_KIND, CLAIM_KIND } from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';
import { BitBlastBvBackend } from '../../../js/symbolic/solver/bitblast-backend.js';
import { TieredBvBackend, classifyTieredQuery } from '../../../js/symbolic/solver/tiered-backend.js';
import { createProductionSolverRegistry } from '../../../js/symbolic/solver/registry.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

function query(assertion, constraints = []) {
  return createVerificationQuery({ kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY, claimKind: CLAIM_KIND.EDGE_FEASIBLE, targetEntity: 't014-wide', constraints, assertion });
}

for (const width of [32, 64]) {
  test(`T014 exact bitblast solves ${width}-bit SAT and validates the witness`, async () => {
    const x = createFreshSymbol(bvSort(width), `x${width}`);
    const q = query(createCompare(BV_COMPARE_OP.EQ, createBinary(BV_BINARY_OP.ADD, x, createBv(width, 1n)), createBv(width, 0n)));
    const result = await new BitBlastBvBackend().createSession({ timeoutMs: 0 }).check(q, { timeoutMs: 2000 });
    assert.equal(result.status, SOLVER_STATUS.SAT);
    assert.equal(validateSatModel(q, result.model).valid, true);
    assert.equal(result.model.get(x.symbolId), (1n << BigInt(width)) - 1n);
  });

  test(`T014 exact bitblast proves ${width}-bit contradictory equalities UNSAT`, async () => {
    const x = createFreshSymbol(bvSort(width), `u${width}`);
    const q = query(
      createCompare(BV_COMPARE_OP.EQ, x, createBv(width, 0n)),
      [createCompare(BV_COMPARE_OP.EQ, x, createBv(width, 1n))],
    );
    const result = await new BitBlastBvBackend().createSession({ timeoutMs: 0 }).check(q, { timeoutMs: 2000 });
    assert.equal(result.status, SOLVER_STATUS.UNSAT);
  });
}

test('T014 tiered router keeps tiny domains on exhaustive and routes 32/64-bit to bitblast', () => {
  const small = createFreshSymbol(bvSort(4), 'small');
  const wide = createFreshSymbol(bvSort(32), 'wide');
  const smallQ = query(createCompare(BV_COMPARE_OP.EQ, small, createBv(4, 3n)));
  const wideQ = query(createCompare(BV_COMPARE_OP.EQ, wide, createBv(32, 3n)));
  assert.equal(classifyTieredQuery(smallQ).tier, 'exhaustive-oracle');
  assert.equal(classifyTieredQuery(wideQ).tier, 'bitblast-qfbv');
});

test('T014 production Node registry exposes the exact tiered backend', () => {
  const backend = createProductionSolverRegistry({ preferWorker: false }).getDefaultBackend();
  assert.ok(backend instanceof TieredBvBackend);
  assert.equal(backend.capabilities().maxBvWidth, 64);
  assert.equal(backend.capabilities().exactProofs, true);
});

test('T014 resource ceilings fail closed and cannot be raised per query', async () => {
  const x = createFreshSymbol(bvSort(32), 'limited');
  const q = query(createCompare(BV_COMPARE_OP.EQ, createBinary(BV_BINARY_OP.MUL, x, x), createBv(32, 7n)));
  const backend = new BitBlastBvBackend({ maxVariables: 16 });
  const result = await backend.createSession({ timeoutMs: 0 }).check(q, { timeoutMs: 2000, maxVariables: 1_000_000 });
  assert.equal(result.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(result.lifecycle.publishable, false);
});

test('T014 coercive resource limits are rejected', () => {
  for (const invalid of ['64', 64n, new Number(64), true, 1.5, NaN, Infinity, 0, -1]) {
    assert.throws(() => new BitBlastBvBackend({ maxVariables: invalid }), TypeError);
  }
});
