import assert from 'node:assert/strict';
import test from 'node:test';

import { createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/contract.js';
import { createAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';
import { createValidatedPassResult, validateRewriteAdoption } from '../../../js/decompiler/phase8/pass-validation.js';
import { bvSort, BV_BINARY_OP } from '../../../js/symbolic/expr/kinds.js';
import { createFreshSymbol, createBinary, createBv } from '../../../js/symbolic/expr/factory.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { FakeSolverBackend } from '../../../js/symbolic/solver/fake-backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';

const FULL_STATE = Object.freeze({ cfg:{ key:'cfg' }, ssa:{ key:'ssa' }, ranges:{ completeness:'complete' } });

function descriptor(extra = {}) {
  return createPassDescriptor({
    id:'phase8.c4-04-probe', version:'1.0.0', stage:'scalar-optimization',
    consumes:['ssa'], preserves:['cfg'], invalidates:[], ...extra,
  });
}

function passFor(transforms, extra = {}) {
  const d = descriptor(extra);
  return {
    descriptor:d,
    run() {
      return createValidatedPassResult({ descriptor:d, status:'changed', changed:true, transforms });
    },
  };
}

async function equivalentRecord() {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const rewrite = Object.freeze({ before, after });
  const validation = await validateRewriteAdoption({
    passId:'phase8.c4-04-probe', passVersion:'1.0.0', transformKind:'probe',
    targets:['value_1'], beforeTarget:before, afterTarget:after, rewrite,
    backend:new ExhaustiveBvBackend(),
  });
  return { rewrite, validation };
}

test('C4-04 owned snapshot accepts a valid equivalent rewrite and commits it', async () => {
  const { rewrite, validation } = await equivalentRecord();
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), passFor([{
    kind:'probe', targets:['value_1'], proof:'bounded equivalent', rewrite, validation,
  }]), {}, {});
  assert.equal(outcome.committed, true, outcome.stopReason);
  assert.equal(outcome.result.transforms[0].validation.equivalenceProofId, validation.equivalenceProofId);
  assert.equal(Object.isFrozen(outcome.result.transforms[0].rewrite), true);
});

test('C4-04 owned snapshot rejects accessors in validation before admission reads them', () => {
  const d = descriptor();
  const validation = Object.create(null);
  Object.defineProperties(validation, {
    validation:{ value:'equivalent', enumerable:true },
    equivalenceProofId:{ value:'p8rw_fake', enumerable:true },
    verifier:{ value:'hex.symbolic.verify.bounded-equivalence', enumerable:true },
    queryHash:{ get() { throw new Error('getter must not execute'); }, enumerable:true },
  });
  const rawResult = {
    contractVersion:d.contractVersion, passId:d.id, passVersion:d.version, stage:d.stage,
    status:'changed', changed:true, completeness:'complete', diagnostics:[], invalidated:[], produced:[],
    preserved:d.preserves, stopReason:null,
    transforms:[{ kind:'probe', targets:['value_1'], proof:'hostile', originRefs:[], rewrite:{ before:1, after:1 }, validation }],
  };
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), { descriptor:d, run:() => rawResult }, {}, {});
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, `malformed-result:${d.id}`);
});

test('C4-04 refuted validation refuses atomically', async () => {
  const x = createFreshSymbol(bvSort(8), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, createBv(8, 1));
  const after = createBinary(BV_BINARY_OP.ADD, x, createBv(8, 2));
  const validation = await validateRewriteAdoption({
    passId:'phase8.c4-04-probe', passVersion:'1.0.0', transformKind:'probe', targets:['value_1'],
    beforeTarget:before, afterTarget:after,
    backend:new FakeSolverBackend({ defaultStatus:SOLVER_STATUS.SAT, defaultModel:{ x:0n } }),
  });
  assert.equal(validation.validation, 'refuted');
  const state = createAnalysisState(FULL_STATE);
  const beforeState = state.snapshot();
  const outcome = runPassTransaction(state, passFor([{ kind:'probe', targets:['value_1'], proof:'wrong', validation }]), {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-refuted:/);
  assert.deepEqual(state.snapshot(), beforeState);
});

test('C4-04 forged equivalent proof id refuses atomically', async () => {
  const { rewrite, validation } = await equivalentRecord();
  const forged = Object.freeze({ ...validation, equivalenceProofId:'p8rw_forged' });
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), passFor([{
    kind:'probe', targets:['value_1'], proof:'forged', rewrite, validation:forged,
  }]), {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-proof-id-mismatch:/);
});

test('C4-04 rewrite payload without validation refuses', () => {
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), passFor([{
    kind:'probe', targets:['value_1'], proof:'unvalidated', rewrite:{ before:'x', after:'y' },
  }]), {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-unvalidated:/);
});

test('C4-04 explicit non-BV unvalidated reason remains admissible', () => {
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), passFor([{
    kind:'memory-probe', targets:['value_1'], proof:'memory proof', rewrite:{ memory:true },
    unvalidatedReason:'outside scalar BV validation scope',
  }]), {}, {});
  assert.equal(outcome.committed, true, outcome.stopReason);
});

test('C4-04 unknown-only rewrite becomes an unchanged no-op and preserves state', () => {
  const d = descriptor();
  const state = createAnalysisState(FULL_STATE);
  const beforeState = state.snapshot();
  const pass = {
    descriptor:d,
    run() {
      return createValidatedPassResult({
        descriptor:d, status:'changed', changed:true,
        transforms:[{
          kind:'probe', targets:['value_1'], proof:'withheld',
          validation:{ validation:'unknown', reason:'budget-exhausted' },
        }],
      });
    },
  };
  const outcome = runPassTransaction(state, pass, {}, {});
  assert.equal(outcome.committed, true, outcome.stopReason);
  assert.equal(outcome.result.changed, false);
  assert.equal(outcome.result.status, 'unchanged');
  assert.equal(outcome.result.transforms.length, 0);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(state.snapshot(), beforeState);
  assert.ok(outcome.result.diagnostics.some((item) => item.code === 'phase8-rewrite-not-adopted'));
});

test('C4-04 proof binding distinguishes BigInt from string payloads', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const rewrite = Object.freeze({ before, after });
  const validation = await validateRewriteAdoption({
    passId:'phase8.c4-04-probe', passVersion:'1.0.0', transformKind:'probe', targets:['value_1'],
    beforeTarget:before, afterTarget:after, rewrite, backend:new ExhaustiveBvBackend(),
  });
  const malformedAfter = Object.freeze({ ...after, right:Object.freeze({ ...after.right, value:String(after.right.value) }) });
  const outcome = runPassTransaction(createAnalysisState(FULL_STATE), passFor([{
    kind:'probe', targets:['value_1'], proof:'typed binding',
    rewrite:Object.freeze({ before, after:malformedAfter }), validation,
  }]), {}, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^rewrite-proof-id-mismatch:/);
});

test('C4-04 equivalent validation queryHash is non-coercive', () => {
  const d = descriptor();
  const make = (queryHash) => createValidatedPassResult({
    descriptor:d, status:'changed', changed:true,
    transforms:[{
      kind:'probe', targets:['value_1'], proof:'query hash shape', rewrite:{ before:1, after:1 },
      validation:{
        validation:'equivalent', equivalenceProofId:'p8rw_placeholder',
        verifier:'hex.symbolic.verify.bounded-equivalence', queryHash,
      },
    }],
  });
  assert.doesNotThrow(() => make('qh'));
  assert.equal(make('qh').transforms[0].validation, undefined, 'validation authority stays in the private sidecar');
  for (const value of [['qh'], { toString:() => 'qh' }, true, 1, '']) {
    assert.throws(() => make(value), /phase8-pass-transform-validation-query-hash-required/);
  }
});

test('C4-04 verifier refuses a rewrite payload that differs from its verified targets', async () => {
  const x = createFreshSymbol(bvSort(4), 'x');
  const before = createBinary(BV_BINARY_OP.ADD, x, x);
  const after = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const differentAfter = createBinary(BV_BINARY_OP.ADD, x, createBv(4, 1));
  await assert.rejects(
    validateRewriteAdoption({
      passId:'phase8.c4-04-probe', passVersion:'1.0.0', transformKind:'probe', targets:['value_1'],
      beforeTarget:before, afterTarget:after, rewrite:{ before, after:differentAfter },
      backend:new ExhaustiveBvBackend(),
    }),
    /phase8-rewrite-adoption-after-binding-mismatch/,
  );
});
