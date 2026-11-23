import test from 'node:test';
import assert from 'node:assert/strict';

import { OP, VK, MK } from '../js/ir-core.js';
import { decompileSemantic } from '../js/decompiler/semantic-core.js';
import {
  enhanceSemanticDecompilation,
  reachingRegisterValueForTesting,
} from '../js/decompiler/pipeline-core.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import { recoverHighVariables } from '../js/decompiler/types/high-variables.js';
import { inferSemanticTypes } from '../js/decompiler/type-recovery.js';
import { closeFunctionOutput } from '../js/decompiler/c-output-closure.js';

function makeVal(id, fields = {}) {
  return {
    id,
    kind: VK.TEMP,
    reg: null,
    bits: 64,
    signed: null,
    const: null,
    def: null,
    uses: [],
    clobbered: false,
    ...fields,
  };
}

function makeInst(id, op, fields = {}) {
  const normArgs = (fields.args || []).map((a) => (
    a && typeof a === 'object' && 'id' in a && !('value' in a)
      ? { value: a, bits: a.bits }
      : a
  ));
  return {
    id,
    op,
    sub: null,
    block: 0,
    row: id,
    address: 0x1000n + BigInt(id * 4),
    dst: null,
    extra: {},
    ...fields,
    args: normArgs,
  };
}

function linkValue(v, defInst) {
  v.def = defInst;
  defInst.dst = v;
  return v;
}

function makeSimpleIr(insts, values, extra = {}) {
  const block0 = {
    index: 0,
    id: 0,
    startRow: 0,
    address: 0x1000n,
    insts,
    phis: [],
    succ: [],
    pred: [],
  };
  return {
    blocks: extra.blocks || [block0],
    instructions: insts,
    values,
    args: extra.args || new Map(),
    stackSlots: extra.stackSlots || [],
    locations: extra.locations || new Map(),
    idom: extra.idom || [-1],
    dominators: extra.dominators || [new Set([0])],
    ...extra,
  };
}

function makeSimpleModel(extra = {}) {
  return {
    rows: [],
    calls: [],
    addressRefs: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// [W1-T2-01] P0: fadd/fsub/fmul/fdiv, smull, umull, ror in pretty/c & pipeline-core
// ---------------------------------------------------------------------------
test('[W1-T2-01] pretty/c and pipeline-core lower fadd/fsub/fmul/fdiv, smull, umull, and ror cleanly', () => {
  const a = { kind: 'var', name: 'a1', bits: 64 };
  const b = { kind: 'var', name: 'a2', bits: 64 };
  const c = { kind: 'var', name: 'a3', bits: 64 };

  assert.equal(printExpression({ kind: 'binary', op: 'fadd', left: a, right: b }), 'a1 + a2');
  assert.equal(printExpression({ kind: 'binary', op: 'fsub', left: a, right: { kind: 'binary', op: 'fsub', left: b, right: c } }), 'a1 - (a2 - a3)');
  assert.equal(printExpression({ kind: 'binary', op: 'fmul', left: { kind: 'binary', op: 'fadd', left: a, right: b }, right: c }), '(a1 + a2) * a3');
  assert.equal(printExpression({ kind: 'binary', op: 'fdiv', left: a, right: b }), 'a1 / a2');
  assert.equal(
    printExpression({ kind: 'binary', op: 'smull', left: { kind: 'binary', op: 'add', left: a, right: b }, right: c }),
    '(int64_t)(int32_t)(a1 + a2) * (int64_t)(int32_t)a3',
  );
  assert.equal(printExpression({ kind: 'binary', op: 'umull', left: a, right: b }), '(uint64_t)(uint32_t)a1 * (uint64_t)(uint32_t)a2');
  assert.equal(printExpression({ kind: 'binary', op: 'ror', left: a, right: { kind: 'const', value: 7n, bits: 64 } }), 'ror(a1, 7)');

  // End-to-end through pipeline-core for ror and smull
  const x0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const x1 = makeVal(2, { kind: VK.ARG, reg: 'x1', bits: 64 });
  const rorRes = makeVal(3, { reg: 'x0', bits: 64 });
  const rorInst = makeInst(1, OP.BIN, { sub: 'ror', args: [x0, x1] });
  linkValue(rorRes, rorInst);
  x0.uses.push(rorInst);
  x1.uses.push(rorInst);
  const retRor = makeInst(2, OP.RET, { args: [rorRes] });
  rorRes.uses.push(retRor);
  const irRor = makeSimpleIr([rorInst, retRor], [x0, x1, rorRes], { args: new Map([['x0', x0], ['x1', x1]]) });
  const semRor = decompileSemantic(makeSimpleModel(), { name: 'fn_ror', ir: irRor });
  const pipeRor = enhanceSemanticDecompilation(semRor, makeSimpleModel(), { name: 'fn_ror' });
  assert.match(pipeRor.pseudocode, /return ror\(a1, a2\);/);
  assert.ok(!/\ba1\s+ror\s+a2\b/.test(pipeRor.pseudocode));

  const smRes = makeVal(4, { reg: 'x0', bits: 64 });
  const smInst = makeInst(1, OP.BIN, { sub: 'smull', args: [x0, x1] });
  linkValue(smRes, smInst);
  const retSm = makeInst(2, OP.RET, { args: [smRes] });
  smRes.uses.push(retSm);
  const irSm = makeSimpleIr([smInst, retSm], [x0, x1, smRes], { args: new Map([['x0', x0], ['x1', x1]]) });
  const semSm = decompileSemantic(makeSimpleModel(), { name: 'fn_smull', ir: irSm });
  const pipeSm = enhanceSemanticDecompilation(semSm, makeSimpleModel(), { name: 'fn_smull' });
  assert.ok(!/\bsmull\b/.test(pipeSm.pseudocode), `smull leaked as infix:\n${pipeSm.pseudocode}`);
  assert.match(pipeSm.pseudocode, /return \(int64_t\)\(int32_t\)a1 \* \(int64_t\)\(int32_t\)a2;/);

  const umRes = makeVal(5, { reg: 'x0', bits: 64 });
  const umInst = makeInst(1, OP.BIN, { sub: 'umull', args: [x0, x1] });
  linkValue(umRes, umInst);
  const retUm = makeInst(2, OP.RET, { args: [umRes] });
  umRes.uses.push(retUm);
  const irUm = makeSimpleIr([umInst, retUm], [x0, x1, umRes], { args: new Map([['x0', x0], ['x1', x1]]) });
  const semUm = decompileSemantic(makeSimpleModel(), { name: 'fn_umull', ir: irUm });
  const pipeUm = enhanceSemanticDecompilation(semUm, makeSimpleModel(), { name: 'fn_umull' });
  assert.ok(!/\bumull\b/.test(pipeUm.pseudocode), `umull leaked as infix:\n${pipeUm.pseudocode}`);
  assert.match(pipeUm.pseudocode, /return \(uint64_t\)\(uint32_t\)a1 \* \(uint64_t\)\(uint32_t\)a2;/);
});

// ---------------------------------------------------------------------------
// [W1-T2-02] P0: unary is-zero, is-nonzero, fneg, fsqrt, frint*, fcvt[pmna][su]
// ---------------------------------------------------------------------------
test('[W1-T2-02] pretty/c and pipeline-core lower is-zero, is-nonzero, fneg, fsqrt, frint*, fcvt[pmna][su]', () => {
  const x = { kind: 'var', name: 'a1', bits: 64 };
  const d = { kind: 'var', name: 'd0', bits: 64 };
  const s = { kind: 'var', name: 's0', bits: 32 };

  assert.equal(printExpression({ kind: 'unary', op: 'is-zero', arg: x }), 'a1 == 0');
  assert.equal(printExpression({ kind: 'unary', op: 'is-nonzero', arg: x }), 'a1 != 0');
  assert.equal(printExpression({ kind: 'unary', op: 'fneg', arg: d, bits: 64 }), '-d0');
  assert.equal(printExpression({ kind: 'unary', op: 'fsqrt', arg: d, bits: 64 }), 'sqrt(d0)');
  assert.equal(printExpression({ kind: 'unary', op: 'fsqrt', arg: s, bits: 32 }), 'sqrtf(s0)');
  assert.equal(printExpression({ kind: 'unary', op: 'frinta', arg: d, bits: 64 }), 'round(d0)');
  assert.equal(printExpression({ kind: 'unary', op: 'frintm', arg: d, bits: 64 }), 'floor(d0)');
  assert.equal(printExpression({ kind: 'unary', op: 'frintn', arg: s, bits: 32 }), 'roundf(s0)');
  assert.equal(printExpression({ kind: 'unary', op: 'frintp', arg: d, bits: 64 }), 'ceil(d0)');
  assert.equal(printExpression({ kind: 'unary', op: 'frintz', arg: d, bits: 64 }), 'trunc(d0)');
  assert.equal(printExpression({ kind: 'unary', op: 'fcvtps', arg: d, bits: 32 }), '((int32_t)ceil(d0))');
  assert.equal(printExpression({ kind: 'unary', op: 'fcvtms', arg: s, bits: 64 }), '((int64_t)floorf(s0))');
  assert.equal(printExpression({ kind: 'unary', op: 'fcvtnu', arg: d, bits: 32 }), '((uint32_t)round(d0))');
  assert.equal(printExpression({ kind: 'unary', op: 'fcvtau', arg: s, bits: 64 }), '((uint64_t)roundf(s0))');

  // End-to-end through pipeline-core for is-zero and is-nonzero
  const x0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const zRes = makeVal(2, { reg: 'x0', bits: 32 });
  const zInst = makeInst(1, OP.UN, { sub: 'is-zero', bits: 32, args: [x0] });
  linkValue(zRes, zInst);
  x0.uses.push(zInst);
  const retZ = makeInst(2, OP.RET, { args: [zRes] });
  zRes.uses.push(retZ);
  const irZ = makeSimpleIr([zInst, retZ], [x0, zRes], { args: new Map([['x0', x0]]) });
  const semZ = decompileSemantic(makeSimpleModel(), { name: 'fn_is_zero', ir: irZ });
  const pipeZ = enhanceSemanticDecompilation(semZ, makeSimpleModel(), { name: 'fn_is_zero' });
  assert.ok(!/is-zero/.test(pipeZ.pseudocode), `invalid C syntax is-zero:\n${pipeZ.pseudocode}`);
  assert.match(pipeZ.pseudocode, /a1 == 0/);
});

// ---------------------------------------------------------------------------
// [W1-T2-03] P0: for-loop induction variable hoisting (no shadowing) & pipeline-core phi_<id> fix
// ---------------------------------------------------------------------------
test('[W1-T2-03] for-loop induction variable hoists declaration when live after loop and never becomes phi_<id> in pipeline-core', () => {
  const nArg = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const ptrArg = makeVal(2, { kind: VK.ARG, reg: 'x1', bits: 64 });
  const c0 = makeVal(3, { bits: 64, const: 0n });
  const c1 = makeVal(4, { bits: 64, const: 1n });
  const ivPhi = makeVal(5, { reg: 'x2', bits: 64 });
  const ivNext = makeVal(6, { reg: 'x2', bits: 64 });
  const flags = makeVal(7, { reg: 'nzcv', bits: 4 });

  // Block 0 (entry): br -> 1
  const c0Inst = makeInst(0, OP.CONST, { block: 0, row: 0, extra: { value: 0n } });
  linkValue(c0, c0Inst);
  const br0 = makeInst(1, OP.BR, { block: 0, row: 1, extra: { target: 0x1010n } });

  // Block 1 (loop header): phi ivPhi = [0: c0, 2: ivNext]; cmp ivPhi, nArg; cbr lt -> 2 else 3
  const phiInst = makeInst(2, OP.PHI, {
    block: 1,
    row: 2,
    incoming: [{ from: 0, value: c0 }, { from: 2, value: ivNext }],
  });
  linkValue(ivPhi, phiInst);
  c0.uses.push(phiInst);
  ivNext.uses.push(phiInst);

  const cmpInst = makeInst(3, OP.CMP, { block: 1, row: 3, sub: 'sub', bits: 64, args: [ivPhi, nArg] });
  linkValue(flags, cmpInst);
  ivPhi.uses.push(cmpInst);
  nArg.uses.push(cmpInst);

  const cbrInst = makeInst(4, OP.CBR, { block: 1, row: 4, cond: 'lt', args: [flags], extra: { target: 0x1020n, targetBlock: 2 } });
  flags.uses.push(cbrInst);

  // Block 2 (loop body): store ptrArg[ivPhi] = ivPhi; ivNext = ivPhi + 1; br -> 1
  const stInst = makeInst(5, OP.STORE, {
    block: 2,
    row: 5,
    size: 8,
    args: [ivPhi],
    addr: { base: ptrArg, index: ivPhi, scale: 3, size: 8 },
    loc: { kind: MK.UNKNOWN, key: 'mem:arr', size: 8 },
  });
  ivPhi.uses.push(stInst);
  ptrArg.uses.push(stInst);

  const c1Inst = makeInst(6, OP.CONST, { block: 2, row: 6, extra: { value: 1n } });
  linkValue(c1, c1Inst);
  const addInst = makeInst(7, OP.BIN, { block: 2, row: 7, sub: 'add', args: [ivPhi, c1] });
  linkValue(ivNext, addInst);
  ivPhi.uses.push(addInst);
  c1.uses.push(addInst);
  const brBack = makeInst(8, OP.BR, { block: 2, row: 8, extra: { target: 0x1010n } });

  // Block 3 (exit): return ivPhi (LIVE OUTSIDE LOOP!)
  const retInst = makeInst(9, OP.RET, { block: 3, row: 9, args: [ivPhi] });
  ivPhi.uses.push(retInst);

  const b0 = { index: 0, id: 0, startRow: 0, address: 0x1000n, insts: [c0Inst, br0], phis: [], succ: [1], pred: [] };
  const b1 = { index: 1, id: 1, startRow: 2, address: 0x1010n, insts: [cmpInst, cbrInst], phis: [phiInst], succ: [2, 3], pred: [0, 2] };
  const b2 = { index: 2, id: 2, startRow: 5, address: 0x1020n, insts: [stInst, c1Inst, addInst, brBack], phis: [], succ: [1], pred: [1] };
  const b3 = { index: 3, id: 3, startRow: 9, address: 0x1030n, insts: [retInst], phis: [], succ: [], pred: [1] };

  const ir = makeSimpleIr(
    [c0Inst, br0, phiInst, cmpInst, cbrInst, stInst, c1Inst, addInst, brBack, retInst],
    [nArg, ptrArg, c0, c1, ivPhi, ivNext, flags],
    {
      blocks: [b0, b1, b2, b3],
      args: new Map([['x0', nArg], ['x1', ptrArg]]),
      idom: [-1, 0, 1, 1],
      dominators: [new Set([0]), new Set([0, 1]), new Set([0, 1, 2]), new Set([0, 1, 3])],
      loops: [{ header: 1, nodes: new Set([1, 2]), latches: new Set([2]), exits: new Set([3]) }],
    },
  );

  const sem = decompileSemantic(makeSimpleModel(), { name: 'loop_live_out', ir });
  // Must declare `i` at function scope and NOT shadow it in `for (int64 i = ...)`
  assert.match(sem.pseudocode, /^\s*int64 i;/m, `expected hoisted decl int64 i;:\n${sem.pseudocode}`);
  assert.match(sem.pseudocode, /for \(i = 0;/, `expected non-shadowing for (i = 0; ...):\n${sem.pseudocode}`);
  assert.ok(!/for \(int64 i =/.test(sem.pseudocode), `shadowing declaration inside for:\n${sem.pseudocode}`);
  assert.match(sem.pseudocode, /return i;/);

  // pipeline-core must use `i` (NOT `phi_5`) in both loop body store and post-loop return
  const pipe = enhanceSemanticDecompilation(sem, makeSimpleModel(), { name: 'loop_live_out' });
  assert.ok(!/\bphi_5\b/.test(pipe.pseudocode), `pipeline-core emitted uninitialized phi_5:\n${pipe.pseudocode}`);
  assert.match(pipe.pseudocode, /\[i\] = i;/);
  assert.match(pipe.pseudocode, /return i;/);
});

// ---------------------------------------------------------------------------
// [W1-T2-04] P0: AArch64 FP arguments d0..d7 / s0..s7 naming consistency (a1/a2, not a9/local_N)
// ---------------------------------------------------------------------------
test('[W1-T2-04] AArch64 FP args d0/d1 and mixed x0/s0 match signature a1/a2 without a9/local_N collision', () => {
  const x0Unused = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const d0 = makeVal(2, { kind: VK.ARG, reg: 'd0', bits: 64 });
  const d1 = makeVal(3, { kind: VK.ARG, reg: 'd1', bits: 64 });
  const sum = makeVal(4, { reg: 'd0', bits: 64 });
  const addInst = makeInst(1, OP.BIN, { sub: 'fadd', bits: 64, args: [d0, d1] });
  linkValue(sum, addInst);
  d0.uses.push(addInst);
  d1.uses.push(addInst);
  const retInst = makeInst(2, OP.RET, { args: [sum] });
  sum.uses.push(retInst);

  const ir = makeSimpleIr([addInst, retInst], [x0Unused, d0, d1, sum], {
    args: new Map([['x0', x0Unused], ['d0', d0], ['d1', d1]]),
  });

  // Simulate AAPCS64 adapter that maps d0->8, d1->9 (which previously caused a9/a10!)
  const aapcs64Adapter = {
    id: 'aapcs64',
    architectureId: 'arm64',
    supported: true,
    argumentRegisters() {
      return ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];
    },
    classifyEntryRegister(reg) {
      const xm = /^x([0-7])$/.exec(reg);
      if (xm) return { kind: 'argument', index: Number(xm[1]) };
      const dm = /^[dsqv]([0-7])$/.exec(reg);
      if (dm) return { kind: 'argument', index: 8 + Number(dm[1]) };
      return null;
    },
    returnRegister({ returnType }) {
      return returnType === 'double' || returnType === 'float' ? 'd0' : 'x0';
    },
  };

  const types = inferSemanticTypes(ir, makeSimpleModel(), { abiAdapter: aapcs64Adapter });
  const hv = recoverHighVariables(ir, types, { abiAdapter: aapcs64Adapter });
  const d0Group = hv.groups.find((g) => g.id === hv.valueToGroup.get(d0.id));
  const d1Group = hv.groups.find((g) => g.id === hv.valueToGroup.get(d1.id));
  assert.equal(d0Group?.name, 'a1');
  assert.equal(d1Group?.name, 'a2');

  const sem = decompileSemantic(makeSimpleModel(), { name: 'add_doubles', ir, abiAdapter: aapcs64Adapter });
  const pipe = enhanceSemanticDecompilation(sem, makeSimpleModel(), { name: 'add_doubles', abiAdapter: aapcs64Adapter });
  assert.match(pipe.pseudocode, /double add_doubles\(double a1, double a2\)/);
  assert.match(pipe.pseudocode, /return a1 \+ a2;/);
  assert.ok(!/\b(?:a9|a10|local_\d+)\b/.test(pipe.pseudocode), `unexpected FP arg name:\n${pipe.pseudocode}`);

  // Also test without abiAdapter (previously fell back to local_N)
  const semNoAdapter = decompileSemantic(makeSimpleModel(), { name: 'add_doubles2', ir });
  const pipeNoAdapter = enhanceSemanticDecompilation(semNoAdapter, makeSimpleModel(), { name: 'add_doubles2' });
  assert.match(pipeNoAdapter.pseudocode, /return a1 \+ a2;/);
  assert.ok(!/\blocal_\d+\b/.test(pipeNoAdapter.pseudocode), `unexpected local_N:\n${pipeNoAdapter.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [W1-T2-05] P1: pipeline-core reachingRegisterValue handles aliases (w0/x0, s0/d0/v0) & block PHIs
// ---------------------------------------------------------------------------
test('[W1-T2-05] pipeline-core reachingRegisterValue resolves w0/x0, s0/d0/v0 aliases and block-entry PHIs', () => {
  // 1. w0 def in same block must be found when querying x0 (not overwritten with a1)
  const x0Arg = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const c5 = makeVal(2, { bits: 32, const: 5n });
  const c5Inst = makeInst(0, OP.CONST, { block: 0, row: 0, extra: { value: 5n } });
  linkValue(c5, c5Inst);
  const w0Def = makeVal(3, { reg: 'w0', bits: 32 });
  const addW0 = makeInst(1, OP.BIN, { block: 0, row: 1, sub: 'add', bits: 32, args: [x0Arg, c5] });
  linkValue(w0Def, addW0);
  x0Arg.uses.push(addW0);
  c5.uses.push(addW0);
  const retNoArg = makeInst(2, OP.RET, { block: 0, row: 2, args: [] });

  const irW0 = makeSimpleIr([c5Inst, addW0, retNoArg], [x0Arg, c5, w0Def], {
    args: new Map([['x0', x0Arg]]),
  });
  assert.equal(reachingRegisterValueForTesting(irW0, retNoArg, 'x0', true), w0Def);

  const semW0 = decompileSemantic(makeSimpleModel(), { name: 'fn_w0_ret', ir: irW0 });
  const pipeW0 = enhanceSemanticDecompilation(semW0, makeSimpleModel(), { name: 'fn_w0_ret' });
  assert.ok(!/\breturn a1;/.test(pipeW0.pseudocode), `pipeline-core overwrote return with a1:\n${pipeW0.pseudocode}`);
  assert.match(pipeW0.pseudocode, /return .*a1.*\+.*5/);

  // 2. s0 def found when querying d0 on AArch64, not on non-AArch64
  const s0Val = makeVal(10, { reg: 's0', bits: 32 });
  const s0Inst = makeInst(0, OP.CONST, { block: 0, row: 0, extra: { value: 1n } });
  linkValue(s0Val, s0Inst);
  const retFp = makeInst(1, OP.RET, { block: 0, row: 1, args: [] });
  const irFp = makeSimpleIr([s0Inst, retFp], [s0Val]);
  assert.equal(reachingRegisterValueForTesting(irFp, retFp, 'd0', true), s0Val);
  assert.equal(reachingRegisterValueForTesting(irFp, retFp, 'v0', true), s0Val);
  assert.equal(reachingRegisterValueForTesting(irFp, retFp, 'd0', false), null);

  // 3. Block-entry PHI in return block (with row: null) beats entry arg x0
  const x0In = makeVal(20, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const vA = makeVal(21, { reg: 'x0', bits: 64, const: 10n });
  const vB = makeVal(22, { reg: 'x0', bits: 64, const: 20n });
  const phiDst = makeVal(23, { reg: 'x0', bits: 64 });
  const phiInst = makeInst(5, OP.PHI, {
    block: 1,
    row: null,
    incoming: [{ from: 0, value: vA }, { from: 0, value: vB }],
  });
  linkValue(phiDst, phiInst);
  const retPhi = makeInst(6, OP.RET, { block: 1, row: 6, args: [] });
  const b0 = { index: 0, id: 0, startRow: 0, address: 0x1000n, insts: [], phis: [], succ: [1], pred: [] };
  const b1 = { index: 1, id: 1, startRow: 5, address: 0x1010n, insts: [retPhi], phis: [phiInst], succ: [], pred: [0] };
  const irPhi = makeSimpleIr([phiInst, retPhi], [x0In, vA, vB, phiDst], {
    blocks: [b0, b1],
    args: new Map([['x0', x0In]]),
    idom: [-1, 0],
    dominators: [new Set([0]), new Set([0, 1])],
  });
  assert.equal(reachingRegisterValueForTesting(irPhi, retPhi, 'x0', true), phiDst);
});

// ---------------------------------------------------------------------------
// [W1-T2-06] P1: sxtb/sxth/sxtw/uxtb/uxth/uxtw preserve source width truncation & sign/zero extension
// ---------------------------------------------------------------------------
test('[W1-T2-06] sxtb/sxth/sxtw/uxtb/uxth/uxtw preserve source bitwidth truncation and sign/zero extension', () => {
  const x = { kind: 'var', name: 'a1', bits: 64 };
  assert.equal(printExpression({ kind: 'unary', op: 'sext', bits: 64, fromBits: 8, arg: x }), '(int64_t)(int8_t)a1');
  assert.equal(printExpression({ kind: 'unary', op: 'sext', bits: 64, fromBits: 16, arg: x }), '(int64_t)(int16_t)a1');
  assert.equal(printExpression({ kind: 'unary', op: 'sext', bits: 64, fromBits: 32, arg: x }), '(int64_t)(int32_t)a1');
  assert.equal(printExpression({ kind: 'unary', op: 'zext', bits: 64, fromBits: 8, arg: x }), '(uint64_t)(uint8_t)a1');
  assert.equal(printExpression({ kind: 'unary', op: 'zext', bits: 64, fromBits: 16, arg: x }), '(uint64_t)(uint16_t)a1');
  assert.equal(printExpression({ kind: 'unary', op: 'zext', bits: 64, fromBits: 32, arg: x }), '(uint64_t)(uint32_t)a1');

  // Verify nested signed trunc inside sext stays signed (int8_t, NOT uint8_t!)
  assert.equal(
    printExpression({
      kind: 'unary',
      op: 'sext',
      bits: 64,
      fromBits: 8,
      arg: { kind: 'unary', op: 'trunc', bits: 8, signed: true, arg: x },
    }),
    '(int64_t)(int8_t)a1',
  );

  // End-to-end through pipeline-core for all 6 ops
  const cases = [
    ['sxtb', '(int64_t)(int8_t)a1'],
    ['sxth', '(int64_t)(int16_t)a1'],
    ['sxtw', '(int64_t)(int32_t)a1'],
    ['uxtb', '(uint64_t)(uint8_t)a1'],
    ['uxth', '(uint64_t)(uint16_t)a1'],
    ['uxtw', '(uint64_t)(uint32_t)a1'],
  ];
  for (const [sub, expected] of cases) {
    const x0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
    const res = makeVal(2, { reg: 'x0', bits: 64 });
    const unInst = makeInst(1, OP.UN, { sub, bits: 64, args: [x0] });
    linkValue(res, unInst);
    x0.uses.push(unInst);
    const retInst = makeInst(2, OP.RET, { args: [res] });
    res.uses.push(retInst);
    const ir = makeSimpleIr([unInst, retInst], [x0, res], { args: new Map([['x0', x0]]) });
    const sem = decompileSemantic(makeSimpleModel(), { name: `fn_${sub}`, ir });
    const pipe = enhanceSemanticDecompilation(sem, makeSimpleModel(), { name: `fn_${sub}` });
    assert.ok(pipe.pseudocode.includes(expected), `${sub}: expected ${expected} in:\n${pipe.pseudocode}`);
  }
});

// ---------------------------------------------------------------------------
// [W1-T2-07] P1: Indexed memory access preserves addr.extend, scale===4 (16B), and element types
// ---------------------------------------------------------------------------
test('[W1-T2-07] indexed memory access preserves addr.extend (sxtw/uxtw), 16-byte scale===4, and double/float/int32_t', () => {
  // Direct pretty/c.js element types
  const base = { kind: 'var', name: 'a1', bits: 64 };
  const idx = { kind: 'var', name: 'a2', bits: 64 };
  assert.equal(printExpression({ kind: 'index', base, index: idx, bits: 64, elemType: 'double' }), '((double *)(uintptr_t)(a1))[a2]');
  assert.equal(printExpression({ kind: 'index', base, index: idx, bits: 32, elemType: 'float' }), '((float *)(uintptr_t)(a1))[a2]');
  assert.equal(printExpression({ kind: 'index', base, index: idx, bits: 32, elemType: 'int32_t' }), '((int32_t *)(uintptr_t)(a1))[a2]');
  assert.equal(printExpression({ kind: 'index', base, index: idx, bits: 128, elemType: 'uint128' }), '((uint128 *)(uintptr_t)(a1))[a2]');

  // pipeline-core: double load with addr.extend = 'sxtw' and scale = 3 (8B)
  const x0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const w1 = makeVal(2, { kind: VK.ARG, reg: 'x1', bits: 64 });
  const d0 = makeVal(3, { reg: 'd0', bits: 64 });
  const ldDbl = makeInst(1, OP.LOAD, {
    size: 8,
    addr: { base: x0, index: w1, scale: 3, extend: 'sxtw', size: 8 },
    loc: { kind: MK.UNKNOWN, key: 'mem:dbl', size: 8 },
  });
  linkValue(d0, ldDbl);
  x0.uses.push(ldDbl);
  w1.uses.push(ldDbl);
  const retDbl = makeInst(2, OP.RET, { args: [d0] });
  d0.uses.push(retDbl);
  const irDbl = makeSimpleIr([ldDbl, retDbl], [x0, w1, d0], { args: new Map([['x0', x0], ['x1', w1]]) });
  const semDbl = decompileSemantic(makeSimpleModel(), { name: 'ld_dbl_sxtw', ir: irDbl, returnType: 'double' });
  const pipeDbl = enhanceSemanticDecompilation(semDbl, makeSimpleModel(), { name: 'ld_dbl_sxtw', returnType: 'double' });
  assert.ok(pipeDbl.pseudocode.includes('(double *)'), `expected double * in:\n${pipeDbl.pseudocode}`);
  assert.ok(pipeDbl.pseudocode.includes('(int32_t)'), `expected sxtw (int32_t) extend in:\n${pipeDbl.pseudocode}`);

  // pipeline-core: 16-byte scale === 4 load
  const q0 = makeVal(4, { reg: 'q0', bits: 128 });
  const ld16 = makeInst(1, OP.LOAD, {
    size: 16,
    addr: { base: x0, index: w1, scale: 4, extend: 'uxtw', size: 16 },
    loc: { kind: MK.UNKNOWN, key: 'mem:vec16', size: 16 },
  });
  linkValue(q0, ld16);
  const ret16 = makeInst(2, OP.RET, { args: [q0] });
  q0.uses.push(ret16);
  const ir16 = makeSimpleIr([ld16, ret16], [x0, w1, q0], { args: new Map([['x0', x0], ['x1', w1]]) });
  const sem16 = decompileSemantic(makeSimpleModel(), { name: 'ld_vec16', ir: ir16 });
  const pipe16 = enhanceSemanticDecompilation(sem16, makeSimpleModel(), { name: 'ld_vec16' });
  assert.ok(!pipe16.pseudocode.includes('memory_unknown'), `scale===4 fell back to memory_unknown:\n${pipe16.pseudocode}`);
  assert.ok(pipe16.pseudocode.includes('uint128 *'), `expected uint128 * for 16-byte scale:\n${pipe16.pseudocode}`);
  assert.ok(pipe16.pseudocode.includes('(uint32_t)'), `expected uxtw (uint32_t) extend:\n${pipe16.pseudocode}`);

  // pipeline-core: signed int32_t load
  const s32 = makeVal(5, { reg: 'x0', bits: 64, signed: true });
  const ldS32 = makeInst(1, OP.LOAD, {
    sub: 'ldrsw',
    size: 4,
    signed: true,
    addr: { base: x0, index: w1, scale: 2, size: 4 },
    loc: { kind: MK.UNKNOWN, key: 'mem:s32', size: 4 },
  });
  linkValue(s32, ldS32);
  const retS32 = makeInst(2, OP.RET, { args: [s32] });
  s32.uses.push(retS32);
  const irS32 = makeSimpleIr([ldS32, retS32], [x0, w1, s32], { args: new Map([['x0', x0], ['x1', w1]]) });
  const semS32 = decompileSemantic(makeSimpleModel(), { name: 'ld_s32', ir: irS32 });
  const pipeS32 = enhanceSemanticDecompilation(semS32, makeSimpleModel(), { name: 'ld_s32' });
  assert.ok(pipeS32.pseudocode.includes('(int32_t *)'), `expected int32_t * in:\n${pipeS32.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [W1-T2-08] P1: OP.BFX signed bitfield extraction (SBFX) emits __arm64_sbfx
// ---------------------------------------------------------------------------
test('[W1-T2-08] OP.BFX signed right extraction emits __arm64_sbfx while unsigned emits bit_extract', () => {
  const x0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const sRes = makeVal(2, { reg: 'x0', bits: 64 });
  const sbfx = makeInst(1, OP.BFX, {
    args: [x0],
    extra: { lsb: 4, width: 8, signed: true, toward: 'right' },
  });
  linkValue(sRes, sbfx);
  x0.uses.push(sbfx);
  const retS = makeInst(2, OP.RET, { args: [sRes] });
  sRes.uses.push(retS);
  const irS = makeSimpleIr([sbfx, retS], [x0, sRes], { args: new Map([['x0', x0]]) });
  const semS = decompileSemantic(makeSimpleModel(), { name: 'fn_sbfx', ir: irS });
  const pipeS = enhanceSemanticDecompilation(semS, makeSimpleModel(), { name: 'fn_sbfx' });
  assert.match(pipeS.pseudocode, /__arm64_sbfx\(a1, 4, 8\)/);
  assert.ok(!/bit_extract\(/.test(pipeS.pseudocode), `signed SBFX emitted unsigned bit_extract:\n${pipeS.pseudocode}`);

  const uRes = makeVal(3, { reg: 'x0', bits: 64 });
  const ubfx = makeInst(1, OP.BFX, {
    args: [x0],
    extra: { lsb: 4, width: 8, signed: false, toward: 'right' },
  });
  linkValue(uRes, ubfx);
  const retU = makeInst(2, OP.RET, { args: [uRes] });
  uRes.uses.push(retU);
  const irU = makeSimpleIr([ubfx, retU], [x0, uRes], { args: new Map([['x0', x0]]) });
  const semU = decompileSemantic(makeSimpleModel(), { name: 'fn_ubfx', ir: irU });
  const pipeU = enhanceSemanticDecompilation(semU, makeSimpleModel(), { name: 'fn_ubfx' });
  assert.match(pipeU.pseudocode, /bit_extract\(a1, 4, 8\)/);
});

// ---------------------------------------------------------------------------
// [W1-T2-09] P2: is32BitIntReturnValue OP.PHI reads def.incoming (not only def.args)
// ---------------------------------------------------------------------------
test('[W1-T2-09] is32BitIntReturnValue inspects OP.PHI def.incoming when def.args is empty', () => {
  const w1 = makeVal(1, { reg: 'w0', bits: 32, const: 1n });
  const w2 = makeVal(2, { reg: 'w0', bits: 32, const: 2n });
  const c1 = makeInst(0, OP.CONST, { block: 0, row: 0, extra: { value: 1n } });
  const c2 = makeInst(1, OP.CONST, { block: 1, row: 1, extra: { value: 2n } });
  linkValue(w1, c1);
  linkValue(w2, c2);

  // PHI result is in x0 (64-bit container), incoming has 32-bit w0 values, def.args is []
  const phiVal = makeVal(3, { reg: 'x0', bits: 64 });
  const phiInst = makeInst(2, OP.PHI, {
    block: 2,
    row: 2,
    args: [],
    incoming: [{ from: 0, value: w1 }, { from: 1, value: w2 }],
  });
  linkValue(phiVal, phiInst);
  w1.uses.push(phiInst);
  w2.uses.push(phiInst);

  const retInst = makeInst(3, OP.RET, { block: 2, row: 3, args: [phiVal] });
  phiVal.uses.push(retInst);

  const b0 = { index: 0, id: 0, startRow: 0, address: 0x1000n, insts: [c1], phis: [], succ: [2], pred: [] };
  const b1 = { index: 1, id: 1, startRow: 1, address: 0x1004n, insts: [c2], phis: [], succ: [2], pred: [] };
  const b2 = { index: 2, id: 2, startRow: 2, address: 0x1008n, insts: [retInst], phis: [phiInst], succ: [], pred: [0, 1] };
  const ir = makeSimpleIr([c1, c2, phiInst, retInst], [w1, w2, phiVal], {
    blocks: [b0, b1, b2],
    idom: [-1, 0, 0],
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
  });

  const types = inferSemanticTypes(ir, makeSimpleModel());
  assert.equal(types.ret.type, 'int32');
});

// ---------------------------------------------------------------------------
// [W1-T2-10] P2: rewriteArrowAccessesInCode handles field_0x<HEX> with 0x/0X prefix
// ---------------------------------------------------------------------------
test('[W1-T2-10] rewriteArrowAccessesInCode rewrites field_0x<HEX> and field_0X<HEX> as byte-offset deref', () => {
  const closed = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn_hex_field(uint64 a1)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'uint64 v1 = a1->field_0x10;' },
      { kind: 'stmt', indent: 1, text: 'uint64 v2 = a1->field_0X28;' },
      { kind: 'stmt', indent: 1, text: 'return v1 + v2;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.ok(closed.pseudocode.includes('*(uint64 *)((uintptr_t)(a1) + 0x10)'), `expected + 0x10 deref:\n${closed.pseudocode}`);
  assert.ok(closed.pseudocode.includes('*(uint64 *)((uintptr_t)(a1) + 0x28)'), `expected + 0x28 deref:\n${closed.pseudocode}`);
  assert.ok(!closed.pseudocode.includes('->field_0x10'), `a1->field_0x10 was not rewritten:\n${closed.pseudocode}`);
  assert.ok(!closed.pseudocode.includes('->field_0X28'), `a1->field_0X28 was not rewritten:\n${closed.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [W1-T2-11] P1: indexBaseIsPointer checks pointee byte stride against elemType
// ---------------------------------------------------------------------------
test('[W1-T2-11] indexBaseIsPointer keeps cast when pointer stride differs from access width', () => {
  const mkIndexedLoad = (name, baseCType, elemBytes, scale, signed = false) => {
    const x0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
    const x1 = makeVal(2, { kind: VK.ARG, reg: 'x1', bits: 64 });
    const dst = makeVal(3, { reg: signed ? 'x0' : 'w0', bits: elemBytes * 8, signed });
    const ld = makeInst(1, OP.LOAD, {
      size: elemBytes,
      signed,
      addr: { base: x0, index: x1, scale, size: elemBytes },
      loc: { kind: MK.UNKNOWN, key: `mem:${name}`, size: elemBytes },
    });
    linkValue(dst, ld);
    x0.uses.push(ld);
    x1.uses.push(ld);
    const ret = makeInst(2, OP.RET, { args: [dst] });
    dst.uses.push(ret);
    const ir = makeSimpleIr([ld, ret], [x0, x1, dst], { args: new Map([['x0', x0], ['x1', x1]]) });
    const sem = decompileSemantic(makeSimpleModel(), { name, ir });
    sem.types.values.set(x0.id, { kind: 'pointer', name: baseCType, cType: baseCType, confidence: 0.95 });
    return enhanceSemanticDecompilation(sem, makeSimpleModel(), { name });
  };

  // uint8_t * indexed at 4-byte stride -> must keep (uint32_t *) cast
  const u8AsU32 = mkIndexedLoad('ld_u8_as_u32', 'uint8_t *', 4, 2, false);
  assert.match(u8AsU32.pseudocode, /\(\(uint32_t \*\)\(uintptr_t\)\(a1\)\)\[a2\]/,
    `uint8_t * with 4B load must not emit a1[a2]:\n${u8AsU32.pseudocode}`);

  // int8_t * indexed at 4-byte stride -> must keep (int32_t *) cast
  const i8AsI32 = mkIndexedLoad('ld_i8_as_i32', 'int8_t *', 4, 2, true);
  assert.match(i8AsI32.pseudocode, /\(\(int32_t \*\)\(uintptr_t\)\(a1\)\)\[a2\]/,
    `int8_t * with 4B signed load must not emit a1[a2]:\n${i8AsI32.pseudocode}`);

  // uint8_t * indexed at 8-byte stride -> must keep (uint64_t *) cast
  const u8AsU64 = mkIndexedLoad('ld_u8_as_u64', 'uint8_t *', 8, 3, false);
  assert.match(u8AsU64.pseudocode, /\(\(uint64_t \*\)\(uintptr_t\)\(a1\)\)\[a2\]/,
    `uint8_t * with 8B load must not emit a1[a2]:\n${u8AsU64.pseudocode}`);

  // Matching uint32_t * indexed at 4-byte stride -> can omit cast and emit a1[a2]
  const u32AsU32 = mkIndexedLoad('ld_u32_as_u32', 'uint32_t *', 4, 2, false);
  assert.match(u32AsU32.pseudocode, /return a1\[a2\];/,
    `matching uint32_t * with 4B load should emit a1[a2]:\n${u32AsU32.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [W1-T2-12] P1: type-recovery OP.PHI reads def.incoming (not empty def.args)
// ---------------------------------------------------------------------------
test('[W1-T2-12] type-recovery OP.PHI reads def.incoming so non-const GP PHI is not misclassified as double', () => {
  const x0Arg = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const x1Arg = makeVal(2, { kind: VK.ARG, reg: 'x1', bits: 64 });
  const d0Arg = makeVal(3, { kind: VK.ARG, reg: 'd0', bits: 64 });

  const sumA = makeVal(4, { reg: 'x0', bits: 64 });
  const addA = makeInst(0, OP.BIN, { block: 0, row: 0, sub: 'add', bits: 64, args: [x0Arg, x1Arg] });
  linkValue(sumA, addA);
  x0Arg.uses.push(addA);
  x1Arg.uses.push(addA);

  const sumB = makeVal(5, { reg: 'x0', bits: 64 });
  const subB = makeInst(1, OP.BIN, { block: 1, row: 1, sub: 'sub', bits: 64, args: [x0Arg, x1Arg] });
  linkValue(sumB, subB);
  x0Arg.uses.push(subB);
  x1Arg.uses.push(subB);

  // Dead/side FP computation in d0 with higher row than GP PHI
  const dTmp = makeVal(6, { reg: 'd0', bits: 64 });
  const fadd = makeInst(2, OP.BIN, { block: 2, row: 2, sub: 'fadd', bits: 64, args: [d0Arg, d0Arg] });
  linkValue(dTmp, fadd);
  d0Arg.uses.push(fadd);

  // GP PHI with empty args: [] and non-const incoming
  const gpPhi = makeVal(7, { reg: 'x0', bits: 64 });
  const phiInst = makeInst(3, OP.PHI, {
    block: 2,
    row: 3,
    args: [],
    incoming: [{ from: 0, value: sumA }, { from: 1, value: sumB }],
  });
  linkValue(gpPhi, phiInst);
  sumA.uses.push(phiInst);
  sumB.uses.push(phiInst);

  const retInst = makeInst(4, OP.RET, { block: 2, row: 4, args: [gpPhi] });
  gpPhi.uses.push(retInst);

  const b0 = { index: 0, id: 0, startRow: 0, address: 0x1000n, insts: [addA], phis: [], succ: [2], pred: [] };
  const b1 = { index: 1, id: 1, startRow: 1, address: 0x1004n, insts: [subB], phis: [], succ: [2], pred: [] };
  const b2 = { index: 2, id: 2, startRow: 2, address: 0x1008n, insts: [fadd, retInst], phis: [phiInst], succ: [], pred: [0, 1] };
  const ir = makeSimpleIr([addA, subB, fadd, phiInst, retInst], [x0Arg, x1Arg, d0Arg, sumA, sumB, dTmp, gpPhi], {
    blocks: [b0, b1, b2],
    args: new Map([['x0', x0Arg], ['x1', x1Arg], ['d0', d0Arg]]),
    idom: [-1, 0, 0],
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
  });

  const types = inferSemanticTypes(ir, makeSimpleModel());
  assert.notEqual(types.ret.type, 'double');
  assert.notEqual(types.ret.type, 'float');
});

// ---------------------------------------------------------------------------
// [W1-T2-13] P1: reachingRegisterValue returns null for clobbered blockPhis
// ---------------------------------------------------------------------------
test('[W1-T2-13] reachingRegisterValue returns null when block-entry PHI is clobbered', () => {
  const x0In = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const vA = makeVal(2, { reg: 'x0', bits: 64, const: 10n });
  const vB = makeVal(3, { reg: 'x0', bits: 64, const: 20n });
  const clobberedPhiDst = makeVal(4, { reg: 'x0', bits: 64, clobbered: true });
  const phiInst = makeInst(5, OP.PHI, {
    block: 1,
    row: null,
    incoming: [{ from: 0, value: vA }, { from: 0, value: vB }],
  });
  linkValue(clobberedPhiDst, phiInst);
  const retPhi = makeInst(6, OP.RET, { block: 1, row: 6, args: [] });
  const b0 = { index: 0, id: 0, startRow: 0, address: 0x1000n, insts: [], phis: [], succ: [1], pred: [] };
  const b1 = { index: 1, id: 1, startRow: 5, address: 0x1010n, insts: [retPhi], phis: [phiInst], succ: [], pred: [0] };
  const irPhi = makeSimpleIr([phiInst, retPhi], [x0In, vA, vB, clobberedPhiDst], {
    blocks: [b0, b1],
    args: new Map([['x0', x0In]]),
    idom: [-1, 0],
    dominators: [new Set([0]), new Set([0, 1])],
  });
  assert.equal(reachingRegisterValueForTesting(irPhi, retPhi, 'x0', true), null);
});
