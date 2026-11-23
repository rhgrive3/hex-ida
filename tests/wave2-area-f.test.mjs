import assert from 'node:assert/strict';
import test from 'node:test';

import { OP, MK } from '../js/ir-base.js';
import {
  bvSort,
  boolSort,
  BV_BINARY_OP,
  BV_COMPARE_OP,
} from '../js/symbolic/expr/kinds.js';
import {
  createBool,
  createBv,
  createFreshSymbol,
  createBinary,
  createCompare,
} from '../js/symbolic/expr/factory.js';
import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';
import { ExhaustiveBvBackend } from '../js/symbolic/solver/exhaustive-backend.js';
import { VERDICT } from '../js/symbolic/verify/query.js';
import { verifyBoundedEquivalence } from '../js/symbolic/verify/equivalence.js';
import { queryTerminalEffectEquivalence } from '../js/symbolic/query/terminal-effect-equivalence.js';
import { createByteMemory } from '../js/symbolic/memory/byte-memory.js';
import {
  createExecutionCapture,
  isExecutionResult,
  isExecutionSnapshot,
} from '../js/symbolic/memory/execution-snapshot.js';
import { backwardDependencySlice } from '../js/symbolic/translate/slice.js';
import { translateSemanticIR } from '../js/symbolic/translate/semantic-ir.js';

const TEST_IDENTITY = Object.freeze({
  queryId: 'wave2-area-f',
  snapshotId: 'snap-1',
  binaryId: 'bin-1',
  functionId: 'fn-1',
  architecture: 'arm64',
  addressSpace: 'data',
  semanticsVersion: '2',
});

// 1. [P0] equivalence.js: replaceSymbols must not substitute unrelated same-name FreshSymbol
test('Wave2-F1 [P0]: verifyBoundedEquivalence does not substitute unrelated same-name FreshSymbol in preconditions', async () => {
  const beforeSym = createFreshSymbol(bvSort(4), 'x');
  const afterSym = createFreshSymbol(bvSort(4), 'x');
  const unrelatedSameName = createFreshSymbol(bvSort(4), 'x');
  const backend = new ExhaustiveBvBackend();

  // before: x, after: 5 (not equivalent in general), precondition constrains an unrelated same-name symbol x == 5
  const res = await verifyBoundedEquivalence({
    beforeTarget: beforeSym,
    afterTarget: createBv(4, 5),
    correspondence: {},
    preconditions: createCompare(BV_COMPARE_OP.EQ, unrelatedSameName, createBv(4, 5)),
    backend,
  });

  // Must NOT issue a false PROVED; solver finds counterexample for beforeSym != 5
  assert.equal(res.verdict, VERDICT.REFUTED);
  assert.notEqual(res.verdict, VERDICT.PROVED);

  // When correspondence maps afterSym -> beforeSym and precondition references afterSym by identity,
  // it IS substituted to beforeSym and proves equivalence.
  const resMapped = await verifyBoundedEquivalence({
    beforeTarget: beforeSym,
    afterTarget: createBinary(BV_BINARY_OP.ADD, afterSym, createBv(4, 0)),
    correspondence: { symbols: { [afterSym.symbolId]: beforeSym.symbolId } },
    preconditions: createCompare(BV_COMPARE_OP.EQ, afterSym, createBv(4, 5)),
    backend,
  });
  assert.equal(resMapped.verdict, VERDICT.PROVED);
});

// 2. [P1] terminal-effect-equivalence.js: shared initial byteMemory, tautology includes initial memory symbols, preconditions validated
function makeInitialLoadReturnIr(xorMask = null) {
  const loaded = { id: 'loaded_pc', bits: 64 };
  const retTarget = xorMask == null ? loaded : { id: 'masked_pc', bits: 64 };
  const loc = { kind: MK.GLOBAL, key: 'global:0x200', address: 0x200n, size: 8 };
  const instructions = [
    { id: 'load_pc', op: OP.LOAD, loc, args: [], dst: loaded },
  ];
  if (xorMask != null) {
    const maskVal = { id: 'mask', bits: 64, const: xorMask };
    instructions.push({
      id: 'xor_pc',
      op: OP.BIN,
      subOp: 'xor',
      args: [{ value: loaded }, { value: maskVal }],
      dst: retTarget,
    });
  }
  const retInst = {
    id: 'ret_inst',
    op: OP.RET,
    args: [{ value: retTarget }],
    returnTargetValue: retTarget,
    extra: {
      returnControlTargetValueId: 'return-pc',
      returnControlTarget: { schema: 'semantic-return-control-target/v1', state: 'resolved', valueId: 'return-pc' },
      attributes: {
        machineEffects: {
          bundleCompleteness: 'exact',
          unknownEffects: false,
          architectureId: 'arm64',
          mode: 'a64',
          possibleFaults: [],
        },
      },
    },
  };
  instructions.push(retInst);
  instructions.forEach((inst, row) => Object.assign(inst, { row, address: BigInt(row * 4) }));
  loaded.def = instructions[0];
  if (xorMask != null) retTarget.def = instructions[1];
  return { entry: 0, blocks: [{ index: 0, insts: instructions, succ: [] }], instructions };
}

test('Wave2-F2a [P1]: queryTerminalEffectEquivalence shares initial byteMemory and includes initial memory symbols in tautology', async () => {
  const beforeIr = makeInitialLoadReturnIr(null);
  const afterIr = makeInitialLoadReturnIr(0n);
  const result = await queryTerminalEffectEquivalence({
    identity: TEST_IDENTITY,
    beforeIr,
    afterIr,
    inputs: [],
    preconditions: [],
    timeoutMs: 5000,
    backendTier: 'tiered',
  });
  assert.equal(result.verdict, 'proved', result.reason);
  assert.equal(result.eligible, true);

  const mismatched = await queryTerminalEffectEquivalence({
    identity: TEST_IDENTITY,
    beforeIr: makeInitialLoadReturnIr(null),
    afterIr: makeInitialLoadReturnIr(1n),
    inputs: [],
    preconditions: [],
    timeoutMs: 5000,
    backendTier: 'tiered',
  });
  assert.equal(mismatched.verdict, 'refuted', mismatched.reason);
  assert.equal(mismatched.eligible, false);
});

test('Wave2-F2b [P1]: queryTerminalEffectEquivalence validates preconditions via assertMemoryExpr and symbol ownership', async () => {
  const beforeIr = makeInitialLoadReturnIr(null);
  const afterIr = makeInitialLoadReturnIr(0n);

  // Unfrozen / forged expression object must be rejected by assertMemoryExpr
  const forgedExpr = { kind: 'const', sort: { kind: 'bool' }, value: true };
  const resForged = await queryTerminalEffectEquivalence({
    identity: TEST_IDENTITY,
    beforeIr,
    afterIr,
    inputs: [],
    preconditions: [forgedExpr],
    timeoutMs: 5000,
    backendTier: 'tiered',
  });
  assert.equal(resForged.eligible, false);
  assert.equal(resForged.verdict, 'unknown');

  // Unbound FreshSymbol in preconditions must be rejected
  const straySymbol = createFreshSymbol(boolSort(), 'stray_bool');
  const resStray = await queryTerminalEffectEquivalence({
    identity: TEST_IDENTITY,
    beforeIr,
    afterIr,
    inputs: [],
    preconditions: [straySymbol],
    timeoutMs: 5000,
    backendTier: 'tiered',
  });
  assert.equal(resStray.eligible, false);
  assert.equal(resStray.verdict, 'unknown');
  assert.equal(resStray.reason, 'unbound-input-or-precondition');
});

// 3. [P1] execution-snapshot.js: SHAPES.inst / SHAPES.extra track comparison, conditionCarrierValueId, targetBlock
test('Wave2-F3 [P1]: execution-snapshot detects tampering of comparison, conditionCarrierValueId, and targetBlock', () => {
  const makeIr = () => {
    const v0 = { id: 'v0', bits: 64, kind: 'arg', reg: 'x0', index: 0 };
    const v1 = { id: 'v1', bits: 64, const: 0n };
    const cmpDst = { id: 'cmp0', bits: 1, machineType: { kind: 'boolean', widthBits: 1 } };
    const cmpInst = {
      id: 'inst_cmp',
      op: OP.CMP,
      comparison: 'eq',
      args: [{ value: v0 }, { value: v1 }],
      dst: cmpDst,
      extra: {
        comparison: 'eq',
        conditionCarrierValueId: 'cmp0',
        targetBlock: 1,
      },
    };
    cmpDst.def = cmpInst;
    return {
      entry: 0,
      values: [v0, v1, cmpDst],
      blocks: [{ index: 0, insts: [cmpInst], succ: [1] }],
      instructions: [cmpInst],
      _cmpInst: cmpInst,
    };
  };

  for (const mutate of [
    (inst) => { inst.comparison = 'ne'; },
    (inst) => { inst.extra.comparison = 'ne'; },
    (inst) => { inst.extra.conditionCarrierValueId = 'tampered'; },
    (inst) => { inst.extra.targetBlock = 2; },
  ]) {
    const ir = makeIr();
    const memory = createByteMemory({ identity: TEST_IDENTITY });
    const capture = createExecutionCapture(ir, memory);
    const state = {
      byteMemory: memory,
      values: new Map(),
      scalarCache: new Map(),
      valueIdentities: new Map(),
      constraints: [],
    };
    const snapshot = capture.capture(state, 0);
    const result = { identity: TEST_IDENTITY };
    capture.publish(result);

    assert.equal(isExecutionSnapshot(snapshot, TEST_IDENTITY, ir), true);
    assert.equal(isExecutionResult(result, TEST_IDENTITY, ir), true);

    mutate(ir._cmpInst);

    assert.equal(isExecutionSnapshot(snapshot, TEST_IDENTITY, ir), false);
    assert.equal(isExecutionResult(result, TEST_IDENTITY, ir), false);
  }
});

// 4. [P1] evaluate.js: memoization for shared DAG and depth/cost guards
test('Wave2-F4 [P1]: evaluateExpr memoizes shared DAGs and enforces depth/cost limits', () => {
  // 40-level diamond DAG: without memoization this takes 2^40 steps and hangs
  let node = createBv(8, 1);
  for (let i = 0; i < 40; i += 1) {
    node = createBinary(BV_BINARY_OP.ADD, node, node);
  }
  const t0 = performance.now();
  const dagRes = evaluateExpr(node);
  const elapsedMs = performance.now() - t0;
  assert.equal(dagRes.status, EVAL_STATUS.VALUE);
  assert.equal(dagRes.value, 0n); // (1 * 2^40) mod 256 == 0
  assert.ok(elapsedMs < 500, `Expected fast DAG evaluation, took ${elapsedMs}ms`);

  // Deep chain exceeding default maxDepth (512) must fail closed without stack overflow
  let deep = createBv(8, 1);
  for (let i = 0; i < 600; i += 1) {
    deep = createBinary(BV_BINARY_OP.ADD, deep, createBv(8, 1));
  }
  const deepRes = evaluateExpr(deep);
  assert.equal(deepRes.status, EVAL_STATUS.UNKNOWN);
  assert.equal(deepRes.reason, 'evaluation-depth-limit');

  // Cost limit guard
  const costRes = evaluateExpr(node, null, { maxSteps: 5 });
  assert.equal(costRes.status, EVAL_STATUS.UNKNOWN);
  assert.equal(costRes.reason, 'evaluation-cost-limit');
});

// 5. [P1] slice.js: OP.SEL condition operands, visitInstruction maxDepth, and anonymous cycle detection
test('Wave2-F5 [P1]: backwardDependencySlice traverses OP.SEL condition, enforces maxDepth in visitInstruction, and detects anonymous cycles', () => {
  // (a) OP.SEL conditionValue and cond traversal
  const condArg = { id: 'cond_arg', origin: 'orig_cond_arg' };
  const condInst = { id: 'cmp_inst', op: OP.CMP, args: [{ value: condArg }], origin: 'orig_cmp' };
  const condVal = { id: 'cond_val', def: condInst, origin: 'orig_cond_val' };
  const trueVal = { id: 't_val', origin: 'orig_true' };
  const falseVal = { id: 'f_val', origin: 'orig_false' };
  const selInst = {
    id: 'sel_inst',
    op: OP.SEL,
    conditionValue: condVal,
    args: [{ value: trueVal }, { value: falseVal }],
    origin: 'orig_sel',
  };

  const selSlice = backwardDependencySlice(selInst);
  assert.equal(selSlice.values.has('cond_val'), true);
  assert.equal(selSlice.values.has('cond_arg'), true);
  assert.equal(selSlice.instructions.has('cmp_inst'), true);
  assert.equal(selSlice.origins.has('orig_cond_arg'), true);

  // Also test fallback `inst.cond`
  const condOnlyInst = { id: 'cond_only_inst', op: OP.CMP, args: [{ value: condArg }], origin: 'orig_cond_only' };
  const selWithCondInst = {
    id: 'sel_cond_inst',
    op: OP.SEL,
    cond: condOnlyInst,
    args: [{ value: trueVal }, { value: falseVal }],
  };
  const selCondSlice = backwardDependencySlice(selWithCondInst);
  assert.equal(selCondSlice.instructions.has('cond_only_inst'), true);
  assert.equal(selCondSlice.values.has('cond_arg'), true);

  // (b1) visitInstruction depth > maxDepth
  const v0 = { id: 'v0' };
  const i1 = { id: 'i1', op: OP.MOV, args: [{ value: v0 }] };
  const v1 = { id: 'v1', def: i1 };
  const i2 = { id: 'i2', op: OP.MOV, args: [{ value: v1 }] };
  const depthSlice = backwardDependencySlice(i2, { maxDepth: 1 });
  assert.equal(depthSlice.hitDepthLimit, true);
  assert.equal(depthSlice.completeness.translation, 'partial');

  // (b2) Anonymous node cycle (no ids on values or instructions)
  const anonVal = {};
  const anonInst = { op: OP.MOV, args: [{ value: anonVal }] };
  anonVal.def = anonInst;
  const cycleSlice = backwardDependencySlice(anonInst);
  assert.equal(cycleSlice.hasCycle, true);
  assert.equal(cycleSlice.completeness.controlFlow, 'partial');
});

// 6. [P2] semantic-ir.js: timeoutMs: 0 must not be ignored when deterministic is true
test('Wave2-F6 [P2]: translateSemanticIR respects timeoutMs: 0 even when deterministic is true', () => {
  const val = { id: 'v0', bits: 64, const: 42n };
  const resDet = translateSemanticIR(val, { deterministic: true, timeoutMs: 0 });
  assert.equal(resDet.status, 'unsupported');
  assert.equal(resDet.expression.kind, 'unknown_semantic');
  assert.equal(resDet.expression.reason, 'deadline');

  const resDetTransforms = translateSemanticIR(val, { deterministicTransforms: true, timeoutMs: 0 });
  assert.equal(resDetTransforms.status, 'unsupported');
  assert.equal(resDetTransforms.expression.kind, 'unknown_semantic');
  assert.equal(resDetTransforms.expression.reason, 'deadline');
});
