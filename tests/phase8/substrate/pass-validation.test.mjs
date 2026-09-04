import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import { createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/contract.js';
import { createAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';
import {
  REWRITE_VALIDATION_VERIFIER,
  recomputeEquivalenceProofId,
  rewriteProofDigest,
  validateRewriteAdoption,
} from '../../../js/decompiler/phase8/pass-validation.js';
import { bvSort, BV_BINARY_OP } from '../../../js/symbolic/expr/kinds.js';
import { createFreshSymbol, createBinary, createBv } from '../../../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

const FULL_STATE = Object.freeze(Object.fromEntries(['cfg', 'ssa'].map((key) => [key, { key }])));

function descriptorInput(extra = {}) {
  return { id: 'phase8.probe-rewrite', version: '1.0.0', stage: 'scalar-optimization', consumes: ['ssa'], preserves: ['cfg'], invalidates: [], ...extra };
}

function passWithTransforms(transforms, { changed = true } = {}) {
  const descriptor = createPassDescriptor(descriptorInput());
  return {
    descriptor,
    run(_context, _budget, _area) {
      return createPassResult({
        descriptor,
        status: changed ? 'changed' : 'unchanged',
        changed,
        transforms,
      });
    },
  };
}

test('C4-04: an equivalent rewrite commits with a deterministic proof id', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const rewrite = Object.freeze({ before, after });
  const backend = new ExhaustiveBvBackend();

  const validation = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: before,
    afterTarget: after,
    rewrite,
    backend,
  });
  assert.equal(validation.validation, 'equivalent');
  assert.equal(validation.verifier, REWRITE_VALIDATION_VERIFIER);
  assert.match(validation.equivalenceProofId, /^p8rw_/);

  const replay = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: before,
    afterTarget: after,
    rewrite,
    backend,
  });
  assert.equal(replay.equivalenceProofId, validation.equivalenceProofId);

  const pass = passWithTransforms([{
    kind: 'probe-algebraic', targets: ['value_1'], proof: 'x+x == x<<1 for width 4',
    rewrite,
    validation,
  }]);
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, true, outcome.stopReason);
  assert.equal(outcome.result.transforms[0].validation.equivalenceProofId, validation.equivalenceProofId);
});

test('C4-04: a refuted rewrite refuses the whole transaction', async () => {
  const x = createFreshSymbol(bvSort(32), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, createBv(32, 1));
  const after = createBinary(BV_BINARY_OP.ADD, x, createBv(32, 2));
  const backend = new FakeSolverBackend({ defaultStatus: SOLVER_STATUS.SAT, defaultModel: { x: 0n } });

  const validation = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: before,
    afterTarget: after,
    backend,
  });
  assert.equal(validation.validation, 'refuted');

  const pass = passWithTransforms([{
    kind: 'probe-algebraic', targets: ['value_1'], proof: 'claimed x+1 == x+2',
    validation,
  }]);
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-refuted:phase8\.probe-rewrite$/);
});

test('C4-04: an unknown rewrite is dropped with diagnostics, not adopted', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));

  // Missing correspondence keeps the canonical verifier at explicit unknown.
  const validation = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: createBinary(BV_BINARY_OP.ADD, createFreshSymbol(bvSort(4), 'before_x'), createFreshSymbol(bvSort(4), 'before_x')),
    afterTarget: createBinary(BV_BINARY_OP.SHL, createFreshSymbol(bvSort(4), 'after_x'), createBv(4, 1)),
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(validation.validation, 'unknown');

  const pass = passWithTransforms([
    { kind: 'probe-unvalidated-other', targets: ['value_2'], proof: 'unrelated probe' },
    { kind: 'probe-algebraic', targets: ['value_1'], proof: 'claimed equivalence', validation },
  ]);
  const descriptor = createPassDescriptor(descriptorInput());
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, true);
  assert.equal(outcome.result.transforms.length, 1, 'the unknown rewrite must be dropped');
  assert.equal(outcome.result.transforms[0].kind, 'probe-unvalidated-other');
  assert.ok(outcome.result.diagnostics.some((item) => item.code === 'phase8-rewrite-not-adopted'));
  void descriptor;
});

test('C4-04: a forged proof id refuses the transaction', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const rewrite = Object.freeze({ before, after });
  const genuine = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: before,
    afterTarget: after,
    rewrite,
    backend: new ExhaustiveBvBackend(),
  });
  const forged = { ...genuine, equivalenceProofId: 'p8rw_forged' };
  const pass = passWithTransforms([{
    kind: 'probe-algebraic', targets: ['value_1'], proof: 'claimed', rewrite, validation: forged,
  }]);
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-proof-id-mismatch:phase8\.probe-rewrite$/);
});

test('C4-04: a validated proof cannot be replayed onto a different staged rewrite', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const rewriteA = Object.freeze({ before, after });
  const validation = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: before,
    afterTarget: after,
    rewrite: rewriteA,
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(validation.validation, 'equivalent');

  const differentAfter = createBinary(BV_BINARY_OP.ADD, x, createBv(4, 1));
  const rewriteB = Object.freeze({ before, after: differentAfter });
  const pass = passWithTransforms([{
    kind: 'probe-algebraic',
    targets: ['value_1'],
    proof: 'copied proof must not authorize another payload',
    rewrite: rewriteB,
    validation,
  }]);
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-proof-id-mismatch:phase8\.probe-rewrite$/);
});

test('C4-04: lossy JSON BigInt/string collision cannot reuse a valid rewrite proof', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const rewrite = Object.freeze({ before, after });
  const validation = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: before,
    afterTarget: after,
    rewrite,
    backend: new ExhaustiveBvBackend(),
  });
  assert.equal(validation.validation, 'equivalent');
  assert.equal(typeof after.right.value, 'bigint');

  const malformedConst = Object.freeze({ ...after.right, value: after.right.value.toString(10) });
  const malformedAfter = Object.freeze({ ...after, right: malformedConst });
  // Lock the historical counterexample: the generic identity digest is lossy
  // for this type-only mutation, so the Phase 8 proof binder must be stronger.
  assert.equal(stableDigest(after), stableDigest(malformedAfter));

  const pass = passWithTransforms([{
    kind: 'probe-algebraic',
    targets: ['value_1'],
    proof: 'a schema-invalid string constant must not reuse a BigInt proof',
    rewrite: Object.freeze({ before, after: malformedAfter }),
    validation,
  }]);
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-proof-id-mismatch:phase8\.probe-rewrite$/);
});

test('C4-04: validation refuses a rewrite payload that differs from the verifier targets', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const differentAfter = createBinary(BV_BINARY_OP.ADD, x, createBv(4, 1));

  await assert.rejects(
    validateRewriteAdoption({
      passId: 'phase8.probe-rewrite',
      passVersion: '1.0.0',
      transformKind: 'probe-algebraic',
      targets: ['value_1'],
      beforeTarget: before,
      afterTarget: after,
      rewrite: { before, after: differentAfter },
      backend: new ExhaustiveBvBackend(),
    }),
    /phase8-rewrite-adoption-after-binding-mismatch/,
  );
});

test('C4-04: an equivalent validation without its staged rewrite fails closed', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const validation = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: before,
    afterTarget: after,
    backend: new ExhaustiveBvBackend(),
  });

  const pass = passWithTransforms([{
    kind: 'probe-algebraic',
    targets: ['value_1'],
    proof: 'validation without staged payload is not admissible',
    validation,
  }]);
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-proof-id-mismatch:phase8\.probe-rewrite$/);
});

test('C4-04: a rewrite payload without validation or explicit reason refuses', () => {
  const pass = passWithTransforms([{
    kind: 'probe-algebraic', targets: ['value_1'], proof: 'claimed', rewrite: { before: 'x+x', after: 'x<<1' },
  }]);
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-unvalidated:phase8\.probe-rewrite$/);
});

test('C4-04: an explicitly unvalidated rewrite may commit for non-BV lanes', () => {
  const pass = passWithTransforms([{
    kind: 'probe-memory-rewrite', targets: ['value_1'], proof: 'memory lane',
    rewrite: { memory: true }, unvalidatedReason: 'memory-bearing proof out of scalar gate scope',
  }]);
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), pass, {}, {});
  assert.equal(outcome.committed, true, outcome.stopReason);
});

test('C4-04: digest recompute matches the minted proof id', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const rewrite = Object.freeze({ before, after });
  const validation = await validateRewriteAdoption({
    passId: 'phase8.probe-rewrite',
    passVersion: '1.0.0',
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeTarget: before,
    afterTarget: after,
    rewrite,
    backend: new ExhaustiveBvBackend(),
  });
  const descriptor = createPassDescriptor(descriptorInput());
  const recomputed = recomputeEquivalenceProofId({
    kind: 'probe-algebraic', targets: ['value_1'], rewrite, validation,
  }, descriptor);
  assert.equal(recomputed, validation.equivalenceProofId);
  assert.equal(typeof rewriteProofDigest({
    passId: 'p',
    passVersion: 'v',
    transformKind: 'k',
    targets: ['t'],
    beforeDigest: 'before',
    afterDigest: 'after',
    rewriteDigest: 'rewrite',
    verifierIdentity: 'x',
    verdict: 'proved',
    claimKind: 'equivalent',
  }), 'string');
});

test('C4-04: equivalent validation rejects coercible query hashes', () => {
  const descriptor = createPassDescriptor(descriptorInput());
  const equivalenceProofId = rewriteProofDigest({
    passId: descriptor.id,
    passVersion: descriptor.version,
    transformKind: 'probe-algebraic',
    targets: ['value_1'],
    beforeDigest: 'before',
    afterDigest: 'after',
    rewriteDigest: 'rewrite',
    verifierIdentity: REWRITE_VALIDATION_VERIFIER,
    verdict: 'proved',
    claimKind: 'equivalent',
    queryHash: 'qh',
  });
  const makeResult = (queryHash) => createPassResult({
    descriptor,
    status: 'changed',
    changed: true,
    transforms: [{
      kind: 'probe-algebraic',
      targets: ['value_1'],
      proof: 'query hash contract probe',
      validation: {
        validation: 'equivalent',
        equivalenceProofId,
        verifier: REWRITE_VALIDATION_VERIFIER,
        queryHash,
      },
    }],
  });

  const canonical = makeResult('qh');
  assert.equal(canonical.transforms[0].validation.queryHash, 'qh');
  assert.equal(canonical.transforms[0].validation.equivalenceProofId, equivalenceProofId);

  for (const queryHash of [['qh'], { toString: () => 'qh' }, true, 1, '']) {
    assert.throws(
      () => makeResult(queryHash),
      /phase8-pass-transform-validation-query-hash-required/,
    );
  }
});