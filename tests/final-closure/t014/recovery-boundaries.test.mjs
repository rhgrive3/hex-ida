import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOL_CONNECTIVE_OP,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  boolSort,
  bvSort,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBinary,
  createBv,
  createCompare,
  createConnective,
  createFreshSymbol,
  resetSymbolCounterForTesting,
} from '../../../js/symbolic/expr/factory.js';
import { deserializeExprDag } from '../../../js/symbolic/expr/serialize.js';
import {
  BitBlastBvBackend,
  ExhaustiveBvBackend,
  TieredBvBackend,
  isExactProofBackend,
} from '../../../js/symbolic/solver/index.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import {
  CLAIM_KIND,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
} from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';

function query(assertion, constraints = []) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_FEASIBLE,
    targetEntity: 't014-recovery-boundary',
    constraints,
    assertion,
  });
}

test('public solver facade exposes bounded exact bit-blast and tiered backends', async () => {
  assert.equal(typeof BitBlastBvBackend, 'function');
  assert.equal(typeof TieredBvBackend, 'function');

  const symbol = createFreshSymbol(bvSort(32), 't014_facade_x');
  const candidate = query(createCompare(
    BV_COMPARE_OP.EQ,
    createBinary(BV_BINARY_OP.ADD, symbol, createBv(32, 1n)),
    createBv(32, 0n),
  ));
  const result = await new BitBlastBvBackend().createSession().check(candidate);
  assert.equal(result.status, SOLVER_STATUS.SAT);
  assert.equal(validateSatModel(candidate, result.model).valid, true);
});

test('unsupported semantics and hard resource limits cannot publish exact results', async () => {
  const tooWide = createFreshSymbol(bvSort(65), 't014_too_wide');
  const unsupported = await new BitBlastBvBackend().createSession().check(query(
    createCompare(BV_COMPARE_OP.EQ, tooWide, createBv(65, 0n)),
  ));
  assert.equal(unsupported.status, SOLVER_STATUS.UNSUPPORTED);
  assert.equal(unsupported.lifecycle.publishable, false);

  const left = createFreshSymbol(bvSort(64), 't014_limited_left');
  const right = createFreshSymbol(bvSort(64), 't014_limited_right');
  const limited = await new BitBlastBvBackend({ maxVariables: 32 }).createSession().check(query(
    createCompare(
      BV_COMPARE_OP.EQ,
      createBinary(BV_BINARY_OP.UDIV, left, right),
      createBv(64, 7n),
    ),
  ));
  assert.equal(limited.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(limited.lifecycle.publishable, false);

  for (const invalid of [NaN, Infinity, 1.5, '32', 32n, new Number(32)]) {
    assert.throws(() => new BitBlastBvBackend({ maxVariables: invalid }), TypeError);
  }
});

test('a self-reported or proxied provider cannot forge exact proof authority', () => {
  const exact = new ExhaustiveBvBackend();
  assert.equal(isExactProofBackend(exact), true);
  assert.equal(isExactProofBackend(new Proxy(exact, {})), false);
  assert.equal(isExactProofBackend({
    id: exact.id,
    version: exact.version,
    proofAuthority: exact.proofAuthority,
    capabilityFingerprint: () => exact.capabilityFingerprint(),
    capabilities: () => exact.capabilities(),
  }), false);
});

test('deserialization rejects one symbol identity with conflicting declarations', () => {
  const payload = {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'concat',
      sort: { kind: 'bv', width: 72 },
      left: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'x', symbolId: 'sym_900_x' },
      right: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 64 }, name: 'x', symbolId: 'sym_900_x' },
    },
  };
  assert.throws(() => deserializeExprDag(payload), /conflicting fresh symbol declaration/);
});

test('solver models bind canonical symbol ids despite display-name collisions', async () => {
  resetSymbolCounterForTesting(0);
  const first = createFreshSymbol(boolSort(), 'sym_2_second');
  const second = createFreshSymbol(boolSort(), 'second');
  assert.equal(first.name, second.symbolId);

  const assertion = createConnective(BOOL_CONNECTIVE_OP.XOR, first, second);
  const candidate = query(assertion);
  const backend = new ExhaustiveBvBackend();
  const firstResult = await backend.createSession().check(candidate);
  const replayResult = await backend.createSession().check(candidate);
  assert.equal(firstResult.status, SOLVER_STATUS.SAT);
  assert.equal(replayResult.status, SOLVER_STATUS.SAT);
  assert.equal(validateSatModel(candidate, firstResult.model).valid, true);
  assert.deepEqual(replayResult.model, firstResult.model);
  assert.notEqual(firstResult.model[first.symbolId], firstResult.model[second.symbolId]);
});
