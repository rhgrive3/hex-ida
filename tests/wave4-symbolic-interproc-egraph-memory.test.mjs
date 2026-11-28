import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP } from '../js/ir.js';
import { summarizeFunction, createFunctionSummaryCache } from '../js/interproc.js';
import { symbolicExecute, SYM } from '../js/symbolic/executor.js';
import * as E from '../js/symbolic/expr/index.js';
import { saturatePureExpression, EGRAPH_LIMITS } from '../js/symbolic/egraph/graph.js';
import {
  createByteMemory,
  joinByteMemory,
  assertMemoryExpr,
} from '../js/symbolic/memory/byte-memory.js';
import { createQueryGuard, QueryFailure } from '../js/symbolic/memory/query-state.js';
import { identity as TEST_IDENTITY } from './phase9/taint/fixtures.mjs';

const BASE = 0x100000000n;
const CALLEE_B = 0x100001000n;
const CALLEE_C = 0x100002000n;

function modelAt(base, lines) {
  const rows = lines.map((line, i) => {
    const text = line.trim();
    const space = text.indexOf(' ');
    return {
      row: i,
      address: base + BigInt(i * 4),
      mn: space < 0 ? text : text.slice(0, space),
      ops: space < 0 ? '' : text.slice(space + 1),
    };
  });
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    rowOfAddress(address) {
      const delta = address - base;
      if (delta < 0n || delta >= BigInt(rows.length * 4)) return null;
      return Number(delta / 4n);
    },
  });
}

const makeArg = (id, reg, bits = 64) => ({
  id, reg, bits, kind: 'arg', const: null, def: null, uses: [],
});

const makeConst = (id, value, bits = 64) => ({
  id, reg: null, bits, kind: 'const', const: BigInt(value), def: null, uses: [],
});

const makeDef = (id, reg, bits = 64) => ({
  id, reg, bits, kind: 'def', const: null, def: null, uses: [],
});

// ============================================================================
// 1. js/interproc.js
// ============================================================================

test('interproc: depth-truncated forwarding summary is NOT cached and later top-level call expands', async () => {
  const fnA = modelAt(BASE, [`bl #0x${CALLEE_B.toString(16)}`, 'ret']);
  const fnB = modelAt(CALLEE_B, [`bl #0x${CALLEE_C.toString(16)}`, 'ret']);
  const fnC = modelAt(CALLEE_C, ['mov x0, #42', 'ret']);
  const models = new Map([
    [BASE, fnA],
    [CALLEE_B, fnB],
    [CALLEE_C, fnC],
  ]);

  let analyzeBCount = 0;
  const cache = createFunctionSummaryCache({
    analyze: async (addr) => {
      if (addr === CALLEE_B) analyzeBCount += 1;
      return models.get(addr) || null;
    },
    returnEvidenceFor: () => ({ trusted: true, source: 'prototype' }),
  }, { maxDepth: 1 });

  // At depth=0 for A, B is visited at depth=1 (== maxDepth), so B cannot expand C and must not be cached.
  await cache.summaryFor(BASE);
  const bKey = JSON.stringify([JSON.stringify(['', '']), CALLEE_B.toString()]);
  assert.equal(cache.cache.has(bKey), false);
  assert.ok(analyzeBCount >= 1);

  // Now query B directly at depth=0: B -> C (depth=1) MUST expand to constant 42n.
  const sumB = await cache.summaryFor(CALLEE_B);
  assert.ok(sumB);
  assert.equal(sumB.returns.some((r) => r.kind === 'constant' && r.value === 42n), true);
});

test('interproc: cycle-blocked summary is NOT cached', async () => {
  const fnA = modelAt(BASE, [`bl #0x${CALLEE_B.toString(16)}`, 'ret']);
  const fnB = modelAt(CALLEE_B, [`bl #0x${BASE.toString(16)}`, 'ret']);
  const models = new Map([
    [BASE, fnA],
    [CALLEE_B, fnB],
  ]);

  const cache = createFunctionSummaryCache({
    analyze: async (addr) => models.get(addr) || null,
  }, { maxDepth: 4 });

  const sumA = await cache.summaryFor(BASE);
  assert.ok(sumA);
  const bKey = JSON.stringify([JSON.stringify(['', '']), CALLEE_B.toString()]);
  assert.equal(cache.cache.has(bKey), false);
});

test('interproc: composeReturn remaps field base register and fails closed on unmappable base', async () => {
  // Wrapper passes caller x1 into callee x0; callee loads [x0, #0x10].
  const wrapperRemap = modelAt(BASE, [
    'mov x0, x1',
    `bl #0x${CALLEE_B.toString(16)}`,
    'ret',
  ]);
  const calleeField = modelAt(CALLEE_B, [
    'ldr x0, [x0, #0x10]',
    'ret',
  ]);
  const models = new Map([
    [BASE, wrapperRemap],
    [CALLEE_B, calleeField],
  ]);
  const cache = createFunctionSummaryCache({
    analyze: async (addr) => models.get(addr) || null,
    returnEvidenceFor: () => ({ trusted: true, source: 'prototype' }),
  }, { maxDepth: 3 });

  const sum = await cache.summaryFor(BASE);
  assert.ok(sum);
  const fieldRet = sum.returns.find((r) => r.kind === 'field');
  assert.ok(fieldRet, 'expected remapped field return');
  assert.equal(fieldRet.location.base, 'x1');
  assert.equal(fieldRet.location.disp, 16n);

  // Wrapper passes a constant into callee x0 -> base register cannot be remapped -> fail closed (no stale x0 field).
  const wrapperConst = modelAt(BASE, [
    'mov x0, #0x1000',
    `bl #0x${CALLEE_B.toString(16)}`,
    'ret',
  ]);
  const cache2 = createFunctionSummaryCache({
    analyze: async (addr) => (addr === BASE ? wrapperConst : calleeField),
    returnEvidenceFor: () => ({ trusted: true, source: 'prototype' }),
  }, { maxDepth: 3 });
  const sum2 = await cache2.summaryFor(BASE);
  assert.ok(sum2);
  assert.equal(sum2.returns.some((r) => r.kind === 'field'), false);
});

test('interproc: composeReturn handles constant & argument arithmetic and argument width inheritance', async () => {
  // Wrapper passes constant #5 into callee x0; callee adds #3 -> composed constant 8n.
  const wrapperConst = modelAt(BASE, [
    'mov x0, #5',
    `bl #0x${CALLEE_B.toString(16)}`,
    'ret',
  ]);
  const calleeAdd = modelAt(CALLEE_B, [
    'add x0, x0, #3',
    'ret',
  ]);
  const cacheConst = createFunctionSummaryCache({
    analyze: async (addr) => (addr === BASE ? wrapperConst : calleeAdd),
    returnEvidenceFor: () => ({ trusted: true, source: 'prototype' }),
  }, { maxDepth: 3 });
  const sumConst = await cacheConst.summaryFor(BASE);
  assert.ok(sumConst);
  assert.equal(sumConst.returns.some((r) => r.kind === 'constant' && r.value === 8n), true);

  // Wrapper passes argument x1 into callee x0; callee adds #3 -> argument-arithmetic on arg 1 + 3n.
  const wrapperArg = modelAt(BASE, [
    'mov x0, x1',
    `bl #0x${CALLEE_B.toString(16)}`,
    'ret',
  ]);
  const cacheArg = createFunctionSummaryCache({
    analyze: async (addr) => (addr === BASE ? wrapperArg : calleeAdd),
    returnEvidenceFor: () => ({ trusted: true, source: 'prototype' }),
  }, { maxDepth: 3 });
  const sumArg = await cacheArg.summaryFor(BASE);
  assert.ok(sumArg);
  const arith = sumArg.returns.find((r) => r.kind === 'argument-arithmetic');
  assert.ok(arith);
  assert.equal(arith.argument, 1);
  assert.equal(arith.constant, 3n);
});

test('interproc: maxDepth clamping and await-time cancellation skip caching', async () => {
  const cNaN = createFunctionSummaryCache({}, { maxDepth: Number.NaN });
  const cInf = createFunctionSummaryCache({}, { maxDepth: Number.POSITIVE_INFINITY });
  const cNeg = createFunctionSummaryCache({}, { maxDepth: -5 });
  const cHuge = createFunctionSummaryCache({}, { maxDepth: 999 });
  assert.equal(cNaN.maxDepth, 3);
  assert.equal(cInf.maxDepth, 3);
  assert.equal(cNeg.maxDepth, 0);
  assert.equal(cHuge.maxDepth, 16);

  let cancelled = false;
  const fn = modelAt(BASE, ['mov x0, #7', 'ret']);
  const cache = createFunctionSummaryCache({
    analyze: async () => {
      cancelled = true;
      return fn;
    },
  });
  const res = await cache.summaryFor(BASE, { isCancelled: () => cancelled });
  assert.equal(res, null);
  assert.equal(cache.cache.size, 0);
});

test('interproc: returnDescriptor rejects non-x0..x7 arg origin as unknown (no NaN index)', () => {
  const model = modelAt(BASE, ['mov x0, x8', 'ret']);
  const sum = summarizeFunction(model, { returnEvidence: { trusted: true, source: 'prototype' } });
  assert.ok(sum.returns.length > 0);
  for (const r of sum.returns) {
    if (r.kind === 'argument') {
      assert.equal(Number.isInteger(r.index), true);
      assert.ok(r.index >= 0 && r.index <= 7);
    }
  }
});

// ============================================================================
// 2. js/symbolic/executor.js
// ============================================================================

test('executor: OP.UN rejects unsupported sub (fmov/neg32/sxt0) as unknown instead of identity', () => {
  for (const badSub of ['fmov', 'neg32', 'sxt0', '']) {
    const arg0 = makeArg('a0', 'x0', 64);
    const dst = makeDef('d0', 'x0', 64);
    const un = {
      id: 'u0', op: OP.UN, sub: badSub, row: 0, address: BASE, block: 0,
      args: [{ value: arg0, bits: 64 }], dst,
    };
    dst.def = un;
    const ret = { id: 'r0', op: OP.RET, row: 1, address: BASE + 4n, block: 0, args: [{ value: dst, bits: 64 }] };
    const ir = {
      entry: 0,
      instructions: [un, ret],
      values: [arg0, dst],
      blocks: [{ index: 0, idom: -1, insts: [un, ret], succ: [] }],
      args: new Map(),
    };
    const res = symbolicExecute(ir, { timeoutMs: 1000 });
    assert.equal(res.paths.length, 1);
    const p = res.paths[0];
    assert.equal(p.status, 'unknown', `expected unknown status for badSub=${badSub}`);
    assert.equal(p.reason, 'unsupported-value-op', `expected unsupported-value-op for badSub=${badSub}`);
    assert.equal(p.returnValue.kind, SYM.UNKNOWN, `expected UNKNOWN returnValue for badSub=${badSub}`);
  }

  // Valid neg still works.
  const arg0 = makeArg('a0', 'x0', 64);
  const dst = makeDef('d0', 'x0', 64);
  const un = {
    id: 'u0', op: OP.UN, sub: 'neg', row: 0, address: BASE, block: 0,
    args: [{ value: arg0, bits: 64 }], dst,
  };
  dst.def = un;
  const ret = { id: 'r0', op: OP.RET, row: 1, address: BASE + 4n, block: 0, args: [{ value: dst, bits: 64 }] };
  const ir = {
    entry: 0,
    instructions: [un, ret],
    values: [arg0, dst],
    blocks: [{ index: 0, idom: -1, insts: [un, ret], succ: [] }],
    args: new Map(),
  };
  const p = symbolicExecute(ir, { timeoutMs: 1000 }).paths.find((x) => x.status === 'complete');
  assert.ok(p);
  assert.equal(p.returnValue.kind, SYM.OP);
  assert.equal(p.returnValue.op, 'sub');
});

test('executor: OP.MOV performs width truncation/zext/sext on const and symbol, fails closed on bad sub', () => {
  // Constant truncation 0x1ff -> 8-bit 0xff
  const c1 = makeConst('c1', 0x1ffn, 64);
  const d1 = makeDef('d1', 'x0', 8);
  const m1 = {
    id: 'm1', op: OP.MOV, sub: 'trunc', row: 0, address: BASE, block: 0,
    args: [{ value: c1, bits: 64 }], dst: d1,
  };
  d1.def = m1;
  const r1 = { id: 'r1', op: OP.RET, row: 1, address: BASE + 4n, block: 0, args: [{ value: d1, bits: 8 }] };
  const p1 = symbolicExecute({
    entry: 0, instructions: [m1, r1], values: [c1, d1],
    blocks: [{ index: 0, idom: -1, insts: [m1, r1], succ: [] }], args: new Map(),
  }, { timeoutMs: 1000 }).paths[0];
  assert.equal(p1.returnValue.kind, SYM.CONST);
  assert.equal(p1.returnValue.value, 0xffn);

  // Constant sext 0xff (8-bit) -> 64-bit (0xffffffffffffffffn = BigInt.asUintN(64, -1n))
  const c2 = makeConst('c2', 0xffn, 8);
  const d2 = makeDef('d2', 'x0', 64);
  const m2 = {
    id: 'm2', op: OP.MOV, sub: 'sext', row: 0, address: BASE, block: 0,
    args: [{ value: c2, bits: 8 }], dst: d2,
  };
  d2.def = m2;
  const r2 = { id: 'r2', op: OP.RET, row: 1, address: BASE + 4n, block: 0, args: [{ value: d2, bits: 64 }] };
  const p2 = symbolicExecute({
    entry: 0, instructions: [m2, r2], values: [c2, d2],
    blocks: [{ index: 0, idom: -1, insts: [m2, r2], succ: [] }], args: new Map(),
  }, { timeoutMs: 1000 }).paths[0];
  assert.equal(p2.returnValue.kind, SYM.CONST);
  assert.equal(p2.returnValue.value, 0xffffffffffffffffn);

  // Symbolic zext produces SYM.OP with fromBits/toBits
  const a3 = makeArg('a3', 'x0', 32);
  const d3 = makeDef('d3', 'x0', 64);
  const m3 = {
    id: 'm3', op: OP.MOV, sub: 'zext', row: 0, address: BASE, block: 0,
    args: [{ value: a3, bits: 32 }], dst: d3,
  };
  d3.def = m3;
  const r3 = { id: 'r3', op: OP.RET, row: 1, address: BASE + 4n, block: 0, args: [{ value: d3, bits: 64 }] };
  const p3 = symbolicExecute({
    entry: 0, instructions: [m3, r3], values: [a3, d3],
    blocks: [{ index: 0, idom: -1, insts: [m3, r3], succ: [] }], args: new Map(),
  }, { timeoutMs: 1000 }).paths[0];
  assert.equal(p3.returnValue.kind, SYM.OP);
  assert.equal(p3.returnValue.op, 'zext');
  assert.equal(p3.returnValue.fromBits, 32);
  assert.equal(p3.returnValue.toBits, 64);

  // Unsupported sub on width change fails closed
  const d4 = makeDef('d4', 'x0', 64);
  const m4 = {
    id: 'm4', op: OP.MOV, sub: 'bogus_cast', row: 0, address: BASE, block: 0,
    args: [{ value: a3, bits: 32 }], dst: d4,
  };
  d4.def = m4;
  const r4 = { id: 'r4', op: OP.RET, row: 1, address: BASE + 4n, block: 0, args: [{ value: d4, bits: 64 }] };
  const p4 = symbolicExecute({
    entry: 0, instructions: [m4, r4], values: [a3, d4],
    blocks: [{ index: 0, idom: -1, insts: [m4, r4], succ: [] }], args: new Map(),
  }, { timeoutMs: 1000 }).paths[0];
  assert.equal(p4.returnValue.kind, SYM.UNKNOWN);
});

test('executor: OP.SEL fails closed on UNKNOWN condition and folds boolean CONST condition', () => {
  const cTrue = makeConst('ct', 11n, 64);
  const cFalse = makeConst('cf', 22n, 64);

  const badCarrier = makeArg('unk', 'nzcv', 4);
  const dUnk = makeDef('du', 'x0', 64);
  const selUnk = {
    id: 'su', op: OP.SEL, sub: 'sel', cond: 'eq', row: 0, address: BASE, block: 0,
    args: [{ value: cTrue, bits: 64 }, { value: cFalse, bits: 64 }, { value: badCarrier, bits: 4 }],
    dst: dUnk,
  };
  dUnk.def = selUnk;
  const rUnk = { id: 'ru', op: OP.RET, row: 1, address: BASE + 4n, block: 0, args: [{ value: dUnk, bits: 64 }] };
  const pUnk = symbolicExecute({
    entry: 0, instructions: [selUnk, rUnk], values: [cTrue, cFalse, badCarrier, dUnk],
    blocks: [{ index: 0, idom: -1, insts: [selUnk, rUnk], succ: [] }], args: new Map(),
  }, { timeoutMs: 1000 }).paths[0];
  assert.equal(pUnk.returnValue.kind, SYM.UNKNOWN);

  const c5a = makeConst('c5a', 5n, 64);
  const c5b = makeConst('c5b', 5n, 64);
  const flags = makeDef('fl', 'nzcv', 4);
  const cmpInst = {
    id: 'cmp0', op: OP.CMP, sub: 'sub', row: 0, address: BASE, block: 0,
    args: [{ value: c5a, bits: 64 }, { value: c5b, bits: 64 }], dst: flags,
  };
  flags.def = cmpInst;
  const dFold = makeDef('df', 'x0', 64);
  const selFold = {
    id: 'sf', op: OP.SEL, sub: 'sel', cond: 'eq', row: 1, address: BASE + 4n, block: 0,
    args: [{ value: cTrue, bits: 64 }, { value: cFalse, bits: 64 }, { value: flags, bits: 4 }],
    dst: dFold,
  };
  dFold.def = selFold;
  const rFold = { id: 'rf', op: OP.RET, row: 2, address: BASE + 8n, block: 0, args: [{ value: dFold, bits: 64 }] };
  const pFold = symbolicExecute({
    entry: 0, instructions: [cmpInst, selFold, rFold], values: [c5a, c5b, flags, cTrue, cFalse, dFold],
    blocks: [{ index: 0, idom: -1, insts: [cmpInst, selFold, rFold], succ: [] }], args: new Map(),
  }, { timeoutMs: 1000 }).paths[0];
  assert.equal(pFold.returnValue.kind, SYM.CONST);
  assert.equal(pFold.returnValue.value, 11n);
});

test('executor: byteMemory mode prunes direct contradictory branch constraints', () => {
  const a0 = makeArg('a0', 'x0', 64);
  const c5 = makeConst('c5', 5n, 64);
  const c1 = makeConst('c1', 1n, 64);
  const c2 = makeConst('c2', 2n, 64);
  const c3 = makeConst('c3', 3n, 64);
  const cbr0 = { id: 'cbr0', op: OP.CBR, row: 0, address: BASE, block: 0, args: [{ value: a0, bits: 64 }], extra: { kind: 'cbz', target: BASE + 0x10n } };
  const ret1 = { id: 'ret1', op: OP.RET, row: 1, address: BASE + 4n, block: 1, args: [{ value: c1, bits: 64 }] };
  const cbr1 = { id: 'cbr1', op: OP.CBR, row: 2, address: BASE + 0x10n, block: 2, args: [{ value: a0, bits: 64 }], extra: { kind: 'cbz', target: BASE + 0x20n } };
  const ret2 = { id: 'ret2', op: OP.RET, row: 3, address: BASE + 0x14n, block: 3, args: [{ value: c2, bits: 64 }] };
  const ret3 = { id: 'ret3', op: OP.RET, row: 4, address: BASE + 0x20n, block: 4, args: [{ value: c3, bits: 64 }] };
  const ir = {
    entry: 0,
    instructions: [cbr0, ret1, cbr1, ret2, ret3],
    values: [a0, c5, c1, c2, c3],
    blocks: [
      { index: 0, idom: -1, insts: [cbr0], succ: [1, 2] },
      { index: 1, idom: 0, insts: [ret1], succ: [] },
      { index: 2, idom: 0, insts: [cbr1], succ: [3, 4] },
      { index: 3, idom: 2, insts: [ret2], succ: [] },
      { index: 4, idom: 2, insts: [ret3], succ: [] },
    ],
    args: new Map([['x0', a0]]),
  };

  const res = symbolicExecute(ir, {
    timeoutMs: 1000,
    byteMemory: { identity: TEST_IDENTITY, addressBits: 64, endian: 'little' },
  });
  assert.equal(res.status, 'complete', `unexpected status=${res.status} reason=${res.reason}`);
  // Only 2 feasible paths (x0 != 5 -> 1n, x0 == 5 -> 3n); contradictory path (-> 2n) must be pruned!
  assert.equal(res.paths.length, 2);
  const retVals = res.paths.map((p) => p.returnValue?.value).sort();
  assert.deepEqual(retVals, [1n, 3n]);
});

test('executor: cmp handles signed/unsigned constant folding accurately', () => {
  const cNeg1 = makeConst('cn1', -1n, 64);
  const cOne = makeConst('c1', 1n, 64);
  const flags = makeDef('fl', 'nzcv', 4);
  const cmpInst = {
    id: 'cmp0', op: OP.CMP, sub: 'sub', row: 0, address: BASE, block: 0,
    args: [{ value: cNeg1, bits: 64 }, { value: cOne, bits: 64 }], dst: flags,
  };
  flags.def = cmpInst;
  const d = makeDef('d0', 'x0', 64);
  const selSigned = {
    id: 's1', op: OP.SEL, sub: 'sel', cond: 'lt', row: 1, address: BASE + 4n, block: 0,
    args: [{ value: cOne, bits: 64 }, { value: cNeg1, bits: 64 }, { value: flags, bits: 4 }],
    dst: d,
  };
  d.def = selSigned;
  const ret = { id: 'r0', op: OP.RET, row: 2, address: BASE + 8n, block: 0, args: [{ value: d, bits: 64 }] };
  const p = symbolicExecute({
    entry: 0, instructions: [cmpInst, selSigned, ret], values: [cNeg1, cOne, flags, d],
    blocks: [{ index: 0, idom: -1, insts: [cmpInst, selSigned, ret], succ: [] }], args: new Map(),
  }, { timeoutMs: 1000 }).paths[0];
  assert.equal(p.returnValue.kind, SYM.CONST);
  assert.equal(p.returnValue.value, 1n);
});

test('executor: in-block cancellation stops long basic blocks every 64 instructions', () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push('add x0, x0, #1');
  lines.push('ret');
  const ir = irFor(modelAt(BASE, lines));

  let polls = 0;
  const res = symbolicExecute(ir, {
    timeoutMs: 5000,
    maxSteps: 1000,
    isCancelled: () => {
      polls += 1;
      return polls >= 2;
    },
  });
  assert.equal(res.truncated, true);
  assert.ok(polls >= 2, 'expected in-block cancellation poll to fire');
  assert.equal(res.paths.filter((p) => p.status === 'complete').length, 0);
});

// ============================================================================
// 3. js/symbolic/egraph/graph.js
// ============================================================================

test('egraph: rebuild deduplicates e-nodes and extract skips unchanged children cleanly', () => {
  const x = E.createFreshSymbol(E.bvSort(8), 'w4_x');
  const y = E.createFreshSymbol(E.bvSort(8), 'w4_y');
  const expr = E.createBinary('xor', E.createBinary('xor', x, y), y);

  const guard = createQueryGuard({ identity: TEST_IDENTITY, timeoutMs: 2000 }, {
    ...EGRAPH_LIMITS,
    extractedTrees: 500,
  });
  const search = saturatePureExpression(expr, guard, 'canonical');
  const expectedHash = E.computeStructuralHash(x);
  assert.equal(search.choices.some((c) => c.digest === expectedHash), true);
  assert.ok(guard.metrics().extractedTrees <= 500);
});

test('egraph: multi-class extraction converges cleanly under expanded pass cap', () => {
  const x = E.createFreshSymbol(E.bvSort(8), 'w4_mc_x');
  const zero = E.createBv(8, 0n);
  const expr = E.createBinary(
    'add',
    E.createBinary('xor', E.createBinary('add', x, zero), zero),
    zero,
  );
  const guard = createQueryGuard({ identity: TEST_IDENTITY, timeoutMs: 2000 }, EGRAPH_LIMITS);
  const search = saturatePureExpression(expr, guard, 'canonical');
  const expectedHash = E.computeStructuralHash(x);
  assert.equal(search.choices.some((c) => c.digest === expectedHash), true);
});

// ============================================================================
// 4. js/symbolic/memory/byte-memory.js
// ============================================================================

test('byte-memory: 10,000 initialBytes + repeated const loads stay well within workItems budget', () => {
  const initialBytes = [];
  for (let i = 0; i < 10000; i++) {
    initialBytes.push([0x10000n + BigInt(i), BigInt(i & 0xff)]);
  }
  const mem = createByteMemory({
    identity: TEST_IDENTITY,
    endian: 'little',
    addressBits: 64,
    initialBytes,
    limits: {
      workItems: 100000,
      allocationUnits: 200000,
      concreteMemoryBytes: 20000,
      storeHistoryEntries: 256,
      symbolicMemoryCells: 256,
      aliasForks: 16,
    },
  });
  const symAddr = E.createFreshSymbol(E.bvSort(64), 'sym_ptr');
  assert.equal(mem.store(symAddr, 1, 0xabn).status, 'stored');
  const beforeWork = mem.metrics().workItems;
  for (let i = 0; i < 20; i++) {
    const addr = E.createBv(64, 0x90000n + BigInt(i * 8));
    const loaded = mem.load(addr, 1);
    assert.equal(loaded.status, 'symbolic');
    assert.ok(loaded.expression);
  }
  const deltaWork = mem.metrics().workItems - beforeWork;
  assert.ok(deltaWork < 5000, `expected O(1) const-address initialByte lookup, got workItems delta=${deltaWork}`);
});

test('byte-memory: assertMemoryExpr single-pass validation rejects invalid/unfrozen expressions', () => {
  const guard = createQueryGuard({ identity: TEST_IDENTITY, timeoutMs: 2000 }, {
    workItems: 500,
    allocationUnits: 500,
  });
  const valid = E.createBinary('add', E.createFreshSymbol(E.bvSort(64), 'a'), E.createBv(64, 1n));
  assert.doesNotThrow(() => assertMemoryExpr(valid, guard));

  const unfrozen = { ...valid };
  assert.throws(() => assertMemoryExpr(unfrozen, guard), QueryFailure);

  const badKind = Object.freeze({ kind: 'bogus_kind', sort: E.bvSort(64) });
  assert.throws(() => assertMemoryExpr(badKind, guard), QueryFailure);
});

test('byte-memory: joinByteMemory enforces guard.check() at entry on cancelled guard', () => {
  let cancelled = false;
  const m1 = createByteMemory({
    identity: TEST_IDENTITY,
    endian: 'little',
    addressBits: 64,
    isCancelled: () => cancelled,
  });
  const m2 = m1.fork();
  cancelled = true;
  assert.throws(
    () => joinByteMemory(E.createFreshSymbol(E.boolSort(), 'cond'), m1, m2),
    (err) => err instanceof QueryFailure && /cancel/.test(err.reason),
  );
});
