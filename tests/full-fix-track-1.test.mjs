import test from 'node:test';
import assert from 'node:assert/strict';

import { bin, un, constNode, regNode, render } from '../js/expr.js';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile-base.js';
import { expr } from '../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { repairCanonicalPostTestLoop } from '../js/decompiler/loop-repair.js';
import { recoverExactStackPhiExpressions } from '../js/decompiler/passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from '../js/decompiler/passes/stack-return-recovery.js';
import { OP, VK, MK } from '../js/ir.js';

// ---------------------------------------------------------------------------
// 1. [P0] js/expr.js un(): neg/not double cancellation & idempotent-only ops
// ---------------------------------------------------------------------------
test('[T1-01 P0] expr.un cancels --x and ~~x and only absorbs idempotent unary ops', () => {
  const x = regNode('x0', 0);

  const neg1 = un('neg', x);
  assert.equal(neg1.k, 'un');
  assert.equal(neg1.op, 'neg');
  assert.equal(un('neg', neg1), x);

  const not1 = un('not', x);
  assert.equal(not1.k, 'un');
  assert.equal(not1.op, 'not');
  assert.equal(un('not', not1), x);

  // Non-idempotent unary op (e.g. fneg) must not collapse fneg(fneg(x)) -> fneg(x)
  const fneg1 = un('fneg', x);
  const fneg2 = un('fneg', fneg1);
  assert.notEqual(fneg2, fneg1);
  assert.equal(fneg2.k, 'un');
  assert.equal(fneg2.op, 'fneg');
  assert.equal(fneg2.a, fneg1);

  // Idempotent width conversions still absorb duplicates
  const sxt32 = un('sxt32', x);
  assert.equal(un('sxt32', sxt32), sxt32);
  const uxt16 = un('uxt16', x);
  assert.equal(un('uxt16', uxt16), uxt16);
});

// ---------------------------------------------------------------------------
// 2. [P0] stack-phi-recovery & stack-return-recovery: partial byte-range overlap
// ---------------------------------------------------------------------------
function makeStackScenario({ interveningInsts = [], sameRowInsts = null } = {}) {
  const valOld = { id: 1, kind: VK.ARG, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };
  const valNew = { id: 2, kind: VK.ARG, reg: 'x1', bits: 64, signed: false, def: null, uses: [] };
  const valPart = { id: 3, kind: VK.ARG, reg: 'w2', bits: 32, signed: false, def: null, uses: [] };
  const valLoaded = { id: 4, kind: VK.TEMP, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };

  const store8 = {
    id: 10, op: OP.STORE, block: 0, row: 1, address: 0x1004n,
    args: [{ value: valOld, bits: 64 }],
    loc: { kind: MK.STACK, key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
    size: 8,
  };
  const load8 = {
    id: 30, op: OP.LOAD, block: 0, row: 4, address: 0x1010n,
    dst: valLoaded, args: [],
    loc: { kind: MK.STACK, key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
    size: 8,
  };
  valLoaded.def = load8;
  const ret = {
    id: 40, op: OP.RET, block: 0, row: 5, address: 0x1014n,
    args: [{ value: valLoaded, bits: 64 }],
  };

  const insts = sameRowInsts
    ? [...sameRowInsts, load8, ret]
    : [store8, ...interveningInsts, load8, ret];

  const block0 = {
    index: 0, id: 0, startRow: 0, endRow: 5, address: 0x1000n,
    insts, phis: [], pred: [], succ: [], idom: -1,
  };

  const loadExpr = expr.load(
    { kind: 'stack', key: 'stack:sp:c16:s8', size: 8 },
    64,
    { ir: [load8.id], rows: [load8.row], addresses: [load8.address] },
  );

  const ir = {
    blocks: [block0],
    instructions: insts,
    values: [valOld, valNew, valPart, valLoaded],
    idom: [-1],
    dominators: [new Set([0])],
  };

  const semanticAst = {
    values: [
      { valueId: valOld.id, expression: expr.variable('a1', 64, false) },
      { valueId: valNew.id, expression: expr.variable('a2', 64, false) },
      { valueId: valPart.id, expression: expr.variable('a3', 32, false) },
      { valueId: valLoaded.id, expression: loadExpr },
    ],
    conditions: [],
    stores: [],
    outputs: [{ name: 'return', expression: loadExpr }],
  };

  const cAst = {
    header: 'int64_t f(int64_t a1, int64_t a2, int32_t a3) {',
    footer: '}',
    body: [
      {
        kind: 'stmt', indent: 1, text: 'return local_16;',
        row: ret.row, addr: ret.address,
        source: { ir: [ret.id], rows: [ret.row], addresses: [ret.address] },
        semantic: { op: 'return', ir: ret.id, expression: loadExpr },
      },
    ],
  };

  return {
    result: {
      semantic: true,
      ir,
      semanticAst,
      cAst,
      lines: [],
      pseudocode: '',
    },
    valOld,
    valNew,
    valPart,
  };
}

test('[T1-02 P0] stack-phi-recovery treats partially overlapping stack store as barrier', () => {
  const partVal = { id: 3, kind: VK.ARG, reg: 'w2', bits: 32, signed: false, def: null, uses: [] };
  const overlapStoreHigh = {
    id: 20, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: partVal, bits: 32 }],
    loc: { kind: MK.STACK, key: 'stack:sp:c20:s4', baseReg: 'sp', frameEpoch: 0, disp: 20n, size: 4 },
    size: 4,
  };
  const overlapStoreLow = {
    id: 21, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: partVal, bits: 32 }],
    loc: { kind: MK.STACK, key: 'stack:sp:c16:s4', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 4 },
    size: 4,
  };
  const disjointStore = {
    id: 22, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: partVal, bits: 32 }],
    loc: { kind: MK.STACK, key: 'stack:sp:c24:s4', baseReg: 'sp', frameEpoch: 0, disp: 24n, size: 4 },
    size: 4,
  };

  // Overlapping high half [sp+20, +24) blocks recovery of [sp+16, +24)
  const s1 = makeStackScenario({ interveningInsts: [overlapStoreHigh] });
  recoverExactStackPhiExpressions(s1.result);
  assert.equal(s1.result.cAst.body[0].text, 'return local_16;');

  // Overlapping low half [sp+16, +20) blocks recovery of [sp+16, +24)
  const s2 = makeStackScenario({ interveningInsts: [overlapStoreLow] });
  recoverExactStackPhiExpressions(s2.result);
  assert.equal(s2.result.cAst.body[0].text, 'return local_16;');

  // Disjoint [sp+24, +28) does NOT block recovery of [sp+16, +24)
  const s3 = makeStackScenario({ interveningInsts: [disjointStore] });
  recoverExactStackPhiExpressions(s3.result);
  assert.equal(s3.result.cAst.body[0].text, 'return a1;');
});

test('[T1-02 P0] stack-return-recovery treats partially overlapping store and call memKills as barriers', () => {
  const partVal = { id: 3, kind: VK.ARG, reg: 'w2', bits: 32, signed: false, def: null, uses: [] };
  const overlapStore = {
    id: 20, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: partVal, bits: 32 }],
    loc: { kind: MK.STACK, key: 'stack:sp:c20:s4', baseReg: 'sp', frameEpoch: 0, disp: 20n, size: 4 },
    size: 4,
  };
  const overlapCall = {
    id: 21, op: OP.CALL, block: 0, row: 2, address: 0x1008n,
    args: [],
    memKills: [{ kind: MK.STACK, key: 'stack:sp:c20:s4', baseReg: 'sp', frameEpoch: 0, disp: 20n, size: 4 }],
  };
  const disjointCall = {
    id: 22, op: OP.CALL, block: 0, row: 2, address: 0x1008n,
    args: [],
    memKills: [{ kind: MK.STACK, key: 'stack:sp:c24:s4', baseReg: 'sp', frameEpoch: 0, disp: 24n, size: 4 }],
  };

  // Overlapping store blocks recovery
  const s1 = makeStackScenario({ interveningInsts: [overlapStore] });
  recoverExactStackReturn(s1.result);
  assert.equal(s1.result.cAst.body[0].text, 'return local_16;');

  // Overlapping call memKills blocks recovery
  const s2 = makeStackScenario({ interveningInsts: [overlapCall] });
  recoverExactStackReturn(s2.result);
  assert.equal(s2.result.cAst.body[0].text, 'return local_16;');

  // Disjoint call memKills allows recovery
  const s3 = makeStackScenario({ interveningInsts: [disjointCall] });
  recoverExactStackReturn(s3.result);
  assert.equal(s3.result.cAst.body[0].text, 'return a1;');
});

// ---------------------------------------------------------------------------
// 3. [P1] js/expr.js emitFlagCondition(): cmn overflow & width casts
// ---------------------------------------------------------------------------
test('[T1-03 P1] expr.render emitFlagCondition handles cmn overflow (lt/ge/le/gt) and width casts', () => {
  const a = { k: 'arg', n: 0 };
  const b = { k: 'arg', n: 1 };
  const renderCmn = (cc, bits = 32) => render({
    k: 'sel',
    cc,
    a: constNode(1n),
    b: constNode(0n),
    predicate: { k: 'flagcond', producer: 'cmn', cc, bits, a, b },
  });

  // lt/ge/le/gt depend on V flag and must NOT collapse to mi/pl (< 0 / >= 0)
  assert.equal(renderCmn('lt', 32), 'N_cmn32(a1, a2) != V_cmn32(a1, a2) ? 1 : 0');
  assert.equal(renderCmn('ge', 32), 'N_cmn32(a1, a2) == V_cmn32(a1, a2) ? 1 : 0');
  assert.equal(renderCmn('le', 32), 'Z_cmn32(a1, a2) || N_cmn32(a1, a2) != V_cmn32(a1, a2) ? 1 : 0');
  assert.equal(renderCmn('gt', 32), '!Z_cmn32(a1, a2) && N_cmn32(a1, a2) == V_cmn32(a1, a2) ? 1 : 0');

  // mi/pl/eq/ne include proper width casts
  assert.equal(renderCmn('mi', 32), '((int32)(a1 + a2) < 0) ? 1 : 0');
  assert.equal(renderCmn('pl', 32), '((int32)(a1 + a2) >= 0) ? 1 : 0');
  assert.equal(renderCmn('eq', 32), '((uint32)(a1 + a2) == 0) ? 1 : 0');
  assert.equal(renderCmn('ne', 32), '((uint32)(a1 + a2) != 0) ? 1 : 0');
  assert.equal(renderCmn('mi', 64), '((int64)(a1 + a2) < 0) ? 1 : 0');
});

// ---------------------------------------------------------------------------
// 4. [P1] js/expr.js bin(): modular wrap on (x ± c1) ± c2
// ---------------------------------------------------------------------------
test('[T1-04 P1] expr.bin wraps combined add/sub constants modulo bit width', () => {
  const x = regNode('x0', 0);

  // 32-bit: (x + 0x80000000) + 0x80000000 === x (mod 2^32)
  const add32Cancel = bin('add', bin('add', x, constNode(0x80000000n), 32), constNode(0x80000000n), 32);
  assert.equal(add32Cancel, x);

  // 32-bit: (x + 0x7fffffff) + 1 === x - 0x80000000 (wrapped signed 32-bit)
  const add32Wrap = bin('add', bin('add', x, constNode(0x7fffffffn), 32), constNode(1n), 32);
  assert.equal(add32Wrap.k, 'bin');
  assert.equal(add32Wrap.op, 'sub');
  assert.equal(add32Wrap.a, x);
  assert.equal(add32Wrap.b.v, 0x80000000n);

  // 32-bit: (x - 0x80000000) - 0x80000000 === x (mod 2^32)
  const sub32Cancel = bin('sub', bin('sub', x, constNode(0x80000000n), 32), constNode(0x80000000n), 32);
  assert.equal(sub32Cancel, x);

  // 64-bit: (x + 0x7fffffffffffffff) + 1 === x - 0x8000000000000000 (wrapped signed 64-bit)
  const add64Wrap = bin('add', bin('add', x, constNode(0x7fffffffffffffffn), 64), constNode(1n), 64);
  assert.equal(add64Wrap.k, 'bin');
  assert.equal(add64Wrap.op, 'sub');
  assert.equal(add64Wrap.a, x);
  assert.equal(add64Wrap.b.v, 0x8000000000000000n);
});

// ---------------------------------------------------------------------------
// 5. [P1] js/decompiler/rewrite/rules.js: select-min-max & select-abs width domain
// ---------------------------------------------------------------------------
test('[T1-05 P1] select-min-max and select-abs reject cross-width cast unwrapping', () => {
  const engine = new RewriteEngine(DEFAULT_RULES);
  const x64 = expr.variable('x', 64, true);
  const y64 = expr.variable('y', 64, true);
  const x32Cast = { kind: 'cast', arg: x64, type: 'int32', bits: 32, signed: true };
  const y32Cast = { kind: 'cast', arg: y64, type: 'int32', bits: 32, signed: true };

  // Cross-width select-min-max: 32-bit compare with 64-bit select/arms must NOT rewrite to max()
  const crossMinMax = expr.select(
    expr.compare('gt', x32Cast, y32Cast, true, null, { comparisonDomain: 'integer' }),
    x64,
    y64,
    64,
    true,
  );
  const outMinMax = engine.rewrite(crossMinMax);
  assert.equal(outMinMax.root.kind, 'select');
  assert.ok(!outMinMax.proof.some((p) => p.rule === 'select-min-max'));

  // Cross-width select-abs: 32-bit compare with 64-bit select/arms must NOT rewrite to abs()
  const crossAbs = expr.select(
    expr.compare('lt', x32Cast, expr.constant(0n, 32, true), true, null, { comparisonDomain: 'integer' }),
    expr.unary('neg', x64, 64, true),
    x64,
    64,
    true,
  );
  const outAbs = engine.rewrite(crossAbs);
  assert.equal(outAbs.root.kind, 'select');
  assert.ok(!outAbs.proof.some((p) => p.rule === 'select-abs'));

  // Same-width domain (including same-width signedness cast) MUST still rewrite
  const x32 = expr.variable('a', 32, true);
  const y32 = expr.variable('b', 32, true);
  const sameWidthMinMax = expr.select(
    expr.compare('gt', { kind: 'cast', arg: x32, type: 'int32', bits: 32, signed: true }, y32, true, null, { comparisonDomain: 'integer' }),
    x32,
    y32,
    32,
    true,
  );
  const outSameMinMax = engine.rewrite(sameWidthMinMax);
  assert.equal(outSameMinMax.root.kind, 'intrinsic');
  assert.equal(outSameMinMax.root.name, 'max');

  const sameWidthAbs = expr.select(
    expr.compare('lt', x32, expr.constant(0n, 32, true), true, null, { comparisonDomain: 'integer' }),
    expr.unary('neg', x32, 32, true),
    x32,
    32,
    true,
  );
  const outSameAbs = engine.rewrite(sameWidthAbs);
  assert.equal(outSameAbs.root.kind, 'intrinsic');
  assert.equal(outSameAbs.root.name, 'abs');
});

// ---------------------------------------------------------------------------
// 6. [P1] js/decompiler/loop-repair.js: continuationCondition fail-closed
// ---------------------------------------------------------------------------
test('[T1-06 P1] loop-repair fails closed when inverseCondition fails on exit branch', () => {
  const initVal = { id: 1, kind: VK.CONST, const: 0n, bits: 32 };
  const stepConst = { id: 2, kind: VK.CONST, const: 1n, bits: 32 };
  const limitConst = { id: 3, kind: VK.CONST, const: 10n, bits: 32 };
  const phiVal = { id: 4, kind: VK.TEMP, bits: 32, def: null };
  const nextVal = { id: 5, kind: VK.TEMP, bits: 32, def: null };
  const flagsVal = { id: 6, kind: VK.TEMP, bits: 32, def: null };

  const phiInst = {
    id: 10, op: OP.PHI, block: 1, row: 1,
    dst: phiVal,
    incoming: [{ from: 0, value: initVal }, { from: 1, value: nextVal }],
  };
  phiVal.def = phiInst;

  const addInst = {
    id: 11, op: OP.BIN, sub: 'add', block: 1, row: 2,
    dst: nextVal,
    args: [{ value: phiVal, bits: 32 }, { value: stepConst, bits: 32 }],
  };
  nextVal.def = addInst;

  const cmpInst = {
    id: 12, op: OP.CMP, sub: 'sub', block: 1, row: 3, bits: 32,
    dst: flagsVal,
    args: [{ value: nextVal, bits: 32 }, { value: limitConst, bits: 32 }],
  };
  flagsVal.def = cmpInst;

  // Target is 0x2000n (exit block, NOT header 0x1004n) so branchContinues === false.
  // Condition 'al' is in COND but inverseCondition('al') returns null.
  const cbrInst = {
    id: 13, op: OP.CBR, block: 1, row: 4, cond: 'al',
    args: [{ value: flagsVal, bits: 32 }],
    extra: { target: 0x2000n, cond: 'al' },
  };

  const result = {
    semantic: true,
    ir: {
      blocks: [
        { index: 0, startRow: 0, endRow: 0, insts: [], pred: [], succ: [1] },
        { index: 1, startRow: 1, endRow: 4, insts: [phiInst, addInst, cmpInst, cbrInst], pred: [0, 1], succ: [1, 2] },
        { index: 2, startRow: 5, endRow: 5, insts: [], pred: [1], succ: [] },
      ],
      loops: [{ header: 1, nodes: new Set([1]) }],
    },
    lines: [
      { kind: 'ctrl', indent: 1, text: 'while (1) {' },
      { kind: 'stmt', indent: 2, text: 'body();' },
      { kind: 'ctrl', indent: 1, text: '}' },
    ],
    pseudocode: '    while (1) {\n        body();\n    }',
  };

  const repaired = repairCanonicalPostTestLoop(result, (bi) => (bi === 1 ? 0x1004n : 0x2000n));
  // Must fail closed and NOT rewrite while (1) with un-inverted 'al'
  assert.equal(repaired.lines[0].text, 'while (1) {');
});

// ---------------------------------------------------------------------------
// 7. [P2] stack-phi-recovery & stack-return-recovery: same-row reverse id tie-break
// ---------------------------------------------------------------------------
test('[T1-07 P2] stack-phi-recovery and stack-return-recovery reverse-sort same-row instructions by id', () => {
  const valOld = { id: 1, kind: VK.ARG, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };
  const valNew = { id: 2, kind: VK.ARG, reg: 'x1', bits: 64, signed: false, def: null, uses: [] };

  // Two stores in the exact same row (row: 2), with id 10 (older) before id 11 (newer).
  // Reverse traversal must see id 11 first and recover a2, not a1.
  const storeOld = {
    id: 10, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: valOld, bits: 64 }],
    loc: { kind: MK.STACK, key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
    size: 8,
  };
  const storeNew = {
    id: 11, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: valNew, bits: 64 }],
    loc: { kind: MK.STACK, key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 },
    size: 8,
  };

  const sPhi = makeStackScenario({ sameRowInsts: [storeOld, storeNew] });
  recoverExactStackPhiExpressions(sPhi.result);
  assert.equal(sPhi.result.cAst.body[0].text, 'return a2;');

  const sRet = makeStackScenario({ sameRowInsts: [storeOld, storeNew] });
  recoverExactStackReturn(sRet.result);
  assert.equal(sRet.result.cAst.body[0].text, 'return a2;');
});

// ---------------------------------------------------------------------------
// 8. [P2] js/decompile-base.js: decompile() rethrows AbortError
// ---------------------------------------------------------------------------
test('[T1-08 P2] decompile() rethrows AbortError instead of swallowing it into legacy fallback', () => {
  const abortErr = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  const BASE = 0x100000000n;
  const rows = [
    { row: 0, address: BASE, mn: 'bl', ops: '#0x100001000' },
    { row: 1, address: BASE + 4n, mn: 'ret', ops: '' },
  ];
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < 8n ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: 1, rowOfAddress });

  assert.throws(
    () => decompile(model, {
      addr: BASE,
      rowOfAddress,
      addrOfRow: (r) => BASE + BigInt(r) * 4n,
      symbolFor: () => { throw abortErr; },
    }),
    (err) => err === abortErr && err.name === 'AbortError',
  );
});
