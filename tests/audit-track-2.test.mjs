import test from 'node:test';
import assert from 'node:assert/strict';

import { OP, VK, MK } from '../js/ir-core.js';
import {
  decompileSemantic,
  reachingRegisterValue,
  renderValue,
} from '../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../js/decompiler/pipeline-core.js';
import {
  closeFunctionOutput,
  isStandaloneGlobalPreludeDeclaration,
} from '../js/decompiler/c-output-closure.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import { inferSemanticTypes } from '../js/decompiler/type-recovery.js';

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
  const normArgs = (fields.args || []).map((a) => (a && typeof a === 'object' && 'id' in a && !('value' in a)) ? { value: a, bits: a.bits } : a);
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

function runSemantic(ir, model, opts = {}) {
  return decompileSemantic(model, { ...opts, ir });
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
// [T2-P0-1] FP library call AArch64 FP register resolution & AArch64-only alias
// ---------------------------------------------------------------------------
test('[T2-P0-1] AArch64 FP library calls resolve FP & mixed FP/GP args and avoid RISC-V s0 alias collision', () => {
  const d0 = makeVal(1, { kind: VK.ARG, reg: 'd0', bits: 64 });
  const d1 = makeVal(2, { kind: VK.ARG, reg: 'd1', bits: 64 });
  const x0 = makeVal(3, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const callRes = makeVal(4, { reg: 'd0', bits: 64 });
  const callInst = makeInst(1, OP.CALL, {
    extra: { name: 'pow', target: 0x2000n },
    args: [],
  });
  linkValue(callRes, callInst);
  const retInst = makeInst(2, OP.RET, { args: [callRes] });
  callRes.uses.push(retInst);

  const ir = makeSimpleIr([callInst, retInst], [d0, d1, x0, callRes], {
    args: new Map([['d0', d0], ['d1', d1], ['x0', x0]]),
  });

  // 1. reachingRegisterValue AArch64 alias (d0 <-> s0 <-> v0) vs RISC-V (no alias)
  const v0FoundAArch64 = reachingRegisterValue(ir, callInst, 'v0', true);
  assert.equal(v0FoundAArch64, d0);
  const s0FoundAArch64 = reachingRegisterValue(ir, callInst, 's0', true);
  assert.equal(s0FoundAArch64, d0);

  const riscvAdapter = { id: 'riscv64-lp64d', architectureId: 'riscv64' };
  const s0InRiscv = reachingRegisterValue(ir, callInst, 'v0', { abiAdapter: riscvAdapter });
  assert.equal(s0InRiscv, null);

  // Verify getValuesByReg cache separates AArch64 and non-AArch64 on same IR
  const s0DefVal = makeVal(10, { reg: 's0', bits: 64 });
  const s0DefInst = makeInst(0, OP.CONST, { extra: { value: 42n } });
  linkValue(s0DefVal, s0DefInst);
  const atUse = makeInst(1, OP.RET, { args: [] });
  const irRiscv = makeSimpleIr([s0DefInst, atUse], [s0DefVal]);
  assert.equal(reachingRegisterValue(irRiscv, atUse, 'v0', true), s0DefVal);
  assert.equal(reachingRegisterValue(irRiscv, atUse, 'v0', false), null);
  assert.equal(reachingRegisterValue(irRiscv, atUse, 's0', false), s0DefVal);

  // 2. pow(double, double) uses d0 & d1 (not x0/x1)
  const out = runSemantic(ir, makeSimpleModel(), {
    name: 'test_pow',
    returnType: 'double',
  });
  assert.match(out.pseudocode, /pow\(/);
  assert.ok(!out.pseudocode.includes('pow(a1, unknown)'), `unexpected GP fallback: ${out.pseudocode}`);

  // 3. Mixed FP+GP call: ldexp(double, int) resolves d0 and x0 independently
  const ldRes = makeVal(5, { reg: 'd0', bits: 64 });
  const ldCall = makeInst(1, OP.CALL, {
    extra: { name: 'ldexp', target: 0x2010n },
    args: [],
  });
  linkValue(ldRes, ldCall);
  const ldRet = makeInst(2, OP.RET, { args: [ldRes] });
  ldRes.uses.push(ldRet);
  const irLdexp = makeSimpleIr([ldCall, ldRet], [d0, x0, ldRes], {
    args: new Map([['d0', d0], ['x0', x0]]),
  });
  const outLdexp = runSemantic(irLdexp, makeSimpleModel(), {
    name: 'test_ldexp',
    returnType: 'double',
  });
  assert.match(outLdexp.pseudocode, /ldexp\([^,]+,\s*[^)]+\)/);
  assert.ok(!outLdexp.pseudocode.includes('unknown'), `unexpected unknown in ldexp: ${outLdexp.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [T2-P0-2] Input FP argument formal parameter name binding (AArch64-only)
// ---------------------------------------------------------------------------
test('[T2-P0-2] Input FP arguments bind to formal parameter names a1/a2 in semantic-core and pipeline-core', () => {
  const x0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const d0 = makeVal(2, { kind: VK.ARG, reg: 'd0', bits: 64 });
  const c2 = makeVal(3, { bits: 64, constKind: 'float', floatConst: 2.0 });
  const cInst = makeInst(0, OP.CONST, {});
  linkValue(c2, cInst);
  const prod = makeVal(4, { reg: 'd0', bits: 64 });
  const mulInst = makeInst(1, OP.BIN, { sub: 'fmul', args: [d0, c2] });
  linkValue(prod, mulInst);
  d0.uses.push(mulInst);
  c2.uses.push(mulInst);
  const retInst = makeInst(2, OP.RET, { args: [prod] });
  prod.uses.push(retInst);

  const ir = makeSimpleIr([cInst, mulInst, retInst], [x0, d0, c2, prod], {
    args: new Map([['x0', x0], ['d0', d0]]),
  });

  const semOut = runSemantic(ir, makeSimpleModel(), { name: 'fp_arg_fn' });
  // Signature has `double a1` (only d0 is used), body should use `a1` instead of raw `d0`
  assert.match(semOut.pseudocode, /\ba1\b/);
  assert.ok(!/\bd0\b/.test(semOut.pseudocode), `expected formal param name instead of d0:\n${semOut.pseudocode}`);

  const pipeOut = enhanceSemanticDecompilation(semOut, makeSimpleModel(), { name: 'fp_arg_fn' });
  assert.match(pipeOut.pseudocode, /\ba1\b/);
});

// ---------------------------------------------------------------------------
// [T2-P0-3] Synthetic stack frame positive & negative offset support
// ---------------------------------------------------------------------------
test('[T2-P0-3] Synthetic stack frame handles negative-only, positive, bare sp, and clamped layouts', () => {
  // 1. Negative-only preserves existing format
  const negRes = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn_neg(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'return *(uint64_t *)(uintptr_t)(sp - 0x20);' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.ok(negRes.pseudocode.includes('uint64 sp = (uintptr_t)(__hex_stack_frame + sizeof(__hex_stack_frame));'));

  // 2. Positive offset sp + 0x10 places sp in the interior of __hex_stack_frame
  const posRes = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn_pos(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'return *(uint64_t *)(uintptr_t)(sp + 0x10);' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.match(posRes.pseudocode, /uint8_t __hex_stack_frame\[8192\] = \{0\};/);
  assert.match(posRes.pseudocode, /uint64 sp = \(uintptr_t\)\(__hex_stack_frame \+ 4096\);/);

  // 3. Bare (uintptr_t)sp triggers positive-capable layout
  const bareRes = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn_bare(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'return *(uint64_t *)(uintptr_t)sp;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.match(bareRes.pseudocode, /uint64 sp = \(uintptr_t\)\(__hex_stack_frame \+ 4096\);/);

  // 4. Oversized both sides clamps total <= 65536, each side >= 256 & 16-byte aligned
  const clampRes = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn_clamp(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'uint64 a = *(uint64_t *)(uintptr_t)(sp - 0x20000);' },
      { kind: 'stmt', indent: 1, text: 'uint64 b = *(uint64_t *)(uintptr_t)(sp + 0x20000);' },
      { kind: 'stmt', indent: 1, text: 'return a + b;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  const mFrame = /uint8_t __hex_stack_frame\[(\d+)\] = \{0\};/.exec(clampRes.pseudocode);
  const mOff = /uint64 sp = \(uintptr_t\)\(__hex_stack_frame \+ (\d+)\);/.exec(clampRes.pseudocode);
  assert.ok(mFrame && mOff);
  const total = Number(mFrame[1]);
  const below = Number(mOff[1]);
  const above = total - below;
  assert.ok(total <= 65536 && total % 16 === 0);
  assert.ok(below >= 256 && below % 16 === 0);
  assert.ok(above >= 256 && above % 16 === 0);
});

// ---------------------------------------------------------------------------
// [T2-P0-4] unaryDerefRe escape fix
// ---------------------------------------------------------------------------
test('[T2-P0-4] Multiplication `2 * global_1000` is not misclassified as unary pointer dereference', () => {
  const mulRes = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn_mul(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'return 2 * global_1000;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.ok(mulRes.pseudocode.includes('static uint64 global_1000 = 0;'));
  assert.ok(!mulRes.pseudocode.includes('__hex_global_1000_backing'));

  const derefRes = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn_deref(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'return -*global_2000;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.ok(derefRes.pseudocode.includes('__hex_global_2000_backing'));
});

// ---------------------------------------------------------------------------
// [T2-P0-5] Suppress .rodata short string literal on multi-byte/FP load base
// ---------------------------------------------------------------------------
test('[T2-P0-5] Multi-byte/FP loads suppress .rodata string substitution while 1-byte loads allow it', () => {
  const rodataBytes = new Uint8Array([0x4e, 0x4f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // "NO\0..."
  const sections = [{ name: '.rodata', addr: 0x4000n, size: 8n, readOnly: true, bytes: rodataBytes }];

  const addrVal = makeVal(1, { reg: 'x0', bits: 64, const: 0x4000n });
  const addrInst = makeInst(0, OP.ADDR, { extra: { value: 0x4000n } });
  linkValue(addrVal, addrInst);

  const movVal = makeVal(2, { reg: 'x1', bits: 64 });
  const movInst = makeInst(1, OP.MOV, { args: [addrVal] });
  linkValue(movVal, movInst);
  addrVal.uses.push(movInst);

  // 8-byte load from movVal (should NOT substitute "NO")
  const ld8Val = makeVal(3, { reg: 'x2', bits: 64 });
  const ld8Inst = makeInst(2, OP.LOAD, {
    size: 8,
    addr: { base: movVal, disp: 0n, size: 8 },
    loc: { kind: MK.UNKNOWN, key: 'mem:ld8', size: 8 },
  });
  linkValue(ld8Val, ld8Inst);
  movVal.uses.push(ld8Inst);

  // 1-byte load from addrVal (allowed to substitute "NO")
  const ld1Val = makeVal(4, { reg: 'w3', bits: 32 });
  const ld1Inst = makeInst(3, OP.LOAD, {
    size: 1,
    addr: { base: addrVal, disp: 0n, size: 1 },
    loc: { kind: MK.UNKNOWN, key: 'mem:ld1', size: 1 },
  });
  linkValue(ld1Val, ld1Inst);
  addrVal.uses.push(ld1Inst);

  const sumVal = makeVal(5, { reg: 'x0', bits: 64 });
  const addInst = makeInst(4, OP.BIN, { sub: 'add', args: [ld8Val, ld1Val] });
  linkValue(sumVal, addInst);
  ld8Val.uses.push(addInst);
  ld1Val.uses.push(addInst);

  const retInst = makeInst(5, OP.RET, { args: [sumVal] });
  sumVal.uses.push(retInst);

  const ir = makeSimpleIr(
    [addrInst, movInst, ld8Inst, ld1Inst, addInst, retInst],
    [addrVal, movVal, ld8Val, ld1Val, sumVal],
  );

  const semOut = runSemantic(ir, makeSimpleModel(), { name: 'rodata_load', sections });
  assert.ok(!/\*\(uint64_t \*\)\(uintptr_t\)\("NO"\)/.test(semOut.pseudocode), `multi-byte load got string base:\n${semOut.pseudocode}`);
  assert.ok(semOut.pseudocode.includes('&global_4000'), `expected &global_4000 for 8B load:\n${semOut.pseudocode}`);

  const pipeOut = enhanceSemanticDecompilation(semOut, makeSimpleModel(), { name: 'rodata_load', sections });
  assert.ok(!/\*\(uint64_t \*\)\(uintptr_t\)\("NO"\)/.test(pipeOut.pseudocode), `pipeline multi-byte load got string base:\n${pipeOut.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [T2-P1-1] fabs integer abs() miscompilation fix
// ---------------------------------------------------------------------------
test('[T2-P1-1] fabs emits fabs()/fabsf() instead of integer abs()', () => {
  const d0 = makeVal(1, { kind: VK.ARG, reg: 'd0', bits: 64 });
  const res64 = makeVal(2, { reg: 'd0', bits: 64 });
  const fabs64 = makeInst(1, OP.UN, { sub: 'fabs', bits: 64, args: [d0] });
  linkValue(res64, fabs64);
  d0.uses.push(fabs64);
  const ret64 = makeInst(2, OP.RET, { args: [res64] });
  res64.uses.push(ret64);

  const out64 = runSemantic(
    makeSimpleIr([fabs64, ret64], [d0, res64], { args: new Map([['d0', d0]]) }),
    makeSimpleModel(),
    { name: 'fn_fabs64', returnType: 'double' },
  );
  assert.match(out64.pseudocode, /\bfabs\(/);
  assert.ok(!/\babs\(/.test(out64.pseudocode));

  const s0 = makeVal(1, { kind: VK.ARG, reg: 's0', bits: 32 });
  const res32 = makeVal(2, { reg: 's0', bits: 32 });
  const fabs32 = makeInst(1, OP.UN, { sub: 'fabs', bits: 32, args: [s0] });
  linkValue(res32, fabs32);
  s0.uses.push(fabs32);
  const ret32 = makeInst(2, OP.RET, { args: [res32] });
  res32.uses.push(ret32);

  const out32 = runSemantic(
    makeSimpleIr([fabs32, ret32], [s0, res32], { args: new Map([['s0', s0]]) }),
    makeSimpleModel(),
    { name: 'fn_fabs32', returnType: 'float' },
  );
  assert.match(out32.pseudocode, /\bfabsf\(/);
});

// ---------------------------------------------------------------------------
// [T2-P1-2] scvtf/ucvtf 32-bit source width support
// ---------------------------------------------------------------------------
test('[T2-P1-2] scvtf/ucvtf emit int32_t/uint32_t for 32-bit sources and int64_t/uint64_t for 64-bit', () => {
  // pretty/c.js
  assert.equal(
    printExpression({ kind: 'unary', op: 'scvtf', bits: 64, arg: { kind: 'var', name: 'w0', bits: 32 } }),
    '((double)(int32_t)(w0))',
  );
  assert.equal(
    printExpression({ kind: 'unary', op: 'ucvtf', bits: 32, arg: { kind: 'var', name: 'w0', bits: 32 } }),
    '((float)(uint32_t)(w0))',
  );
  assert.equal(
    printExpression({ kind: 'unary', op: 'scvtf', bits: 64, arg: { kind: 'var', name: 'x0', bits: 64 } }),
    '((double)(int64_t)(x0))',
  );

  // semantic-core.js
  const w0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 32 });
  const d0 = makeVal(2, { reg: 'd0', bits: 64 });
  const cvt = makeInst(1, OP.UN, { sub: 'scvtf', bits: 64, args: [w0] });
  linkValue(d0, cvt);
  w0.uses.push(cvt);
  const ret = makeInst(2, OP.RET, { args: [d0] });
  d0.uses.push(ret);
  const out = runSemantic(
    makeSimpleIr([cvt, ret], [w0, d0], { args: new Map([['x0', w0]]) }),
    makeSimpleModel(),
    { name: 'fn_scvtf32', returnType: 'double' },
  );
  assert.ok(out.pseudocode.includes('(double)(int32_t)'), `expected (double)(int32_t):\n${out.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [T2-P1-3] &global_XXXX field ref parenthesization, sizing & 2-pass idempotency
// ---------------------------------------------------------------------------
test('[T2-P1-3] &global_XXXX field access parenthesizes, sizes uint8_t array, rewrites, and is 2-pass idempotent', () => {
  // 1. pretty/c.js parenthesizes &global_4000
  const fieldText = printExpression({
    kind: 'field',
    base: { kind: 'var', name: '&global_4000', bits: 64 },
    name: 'field_10',
    offset: 0x10n,
  });
  assert.equal(fieldText, '(&global_4000)->field_10');

  // 2. Pure address-of member access -> static uint8_t global_4000[N] = {0}; + 2-pass idempotent
  const pass1 = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'void fn_addr_global(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: '(&global_4000)->field_100 = 1;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.ok(pass1.pseudocode.includes('static uint8_t global_4000[272] = {0};'), `unexpected global decl:\n${pass1.pseudocode}`);
  assert.ok(pass1.pseudocode.includes('((hex_struct_global_4000 *)(uintptr_t)(&global_4000))->field_100 = 1;'));
  assert.equal(isStandaloneGlobalPreludeDeclaration('static uint8_t global_4000[272] = {0};'), true);

  const pass2 = closeFunctionOutput({ lines: pass1.lines.map((l) => ({ ...l })), pseudocode: pass1.pseudocode });
  assert.equal(pass2.pseudocode, pass1.pseudocode, '2nd pass of closeFunctionOutput must be idempotent');

  // 3. Scalar mixed -> falls back to static uint64 global_6000 = 0;
  const mixed = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'void fn_mixed_global(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'global_6000 = 5;' },
      { kind: 'stmt', indent: 1, text: '(&global_6000)->field_8 = 1;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.ok(mixed.pseudocode.includes('static uint64 global_6000 = 0;'));
  assert.ok(mixed.pseudocode.includes('((hex_struct_global_6000 *)(uintptr_t)(&global_6000))->field_8 = 1;'));

  // 4. Pointer-value deref -> keeps __hex_global_7000_backing
  const ptrDeref = closeFunctionOutput({
    lines: [
      { kind: 'sig', indent: 0, text: 'void fn_ptr_global(void)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'global_7000->field_8 = 1;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  });
  assert.ok(ptrDeref.pseudocode.includes('__hex_global_7000_backing'));
});

// ---------------------------------------------------------------------------
// [T2-P1-4] crossesBarrier forbids cross-block non-PHI load motion when ui <= di
// ---------------------------------------------------------------------------
test('[T2-P1-4] Load in later block used by non-PHI in earlier block (ui <= di) is materialized, not moved across blocks', () => {
  const ptrArg = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const loaded = makeVal(2, { reg: 'x1', bits: 64 });

  // Block 0 (index 0, lower linear pos ui=0): uses `loaded` in RET
  const retInst = makeInst(0, OP.RET, { block: 0, row: 0, args: [loaded] });
  // Block 1 (index 1, higher linear pos di=1): defines `loaded` via LOAD and jumps to block 0
  const loadInst = makeInst(1, OP.LOAD, {
    block: 1,
    row: 1,
    size: 8,
    addr: { base: ptrArg, disp: 0n, size: 8 },
    loc: { kind: MK.FIELD, base: ptrArg, disp: 0n, key: 'field:x0:0', size: 8 },
  });
  linkValue(loaded, loadInst);
  ptrArg.uses.push(loadInst);
  loaded.uses.push(retInst);
  const brInst = makeInst(2, OP.BR, { block: 1, row: 2 });

  const b0 = { index: 0, id: 0, startRow: 0, address: 0x1000n, insts: [retInst], phis: [], succ: [], pred: [1] };
  const b1 = { index: 1, id: 1, startRow: 1, address: 0x1004n, insts: [loadInst, brInst], phis: [], succ: [0], pred: [] };

  const ir = makeSimpleIr([retInst, loadInst, brInst], [ptrArg, loaded], {
    blocks: [b0, b1],
    args: new Map([['x0', ptrArg]]),
    idom: [1, -1],
    entry: 1,
    dominators: [new Set([0, 1]), new Set([1])],
  });

  const out = runSemantic(ir, makeSimpleModel(), { name: 'cross_block_load', entryBlock: 1 });
  // Because crossesBarrier returns true, `loaded` must be materialized (var_2 = ...) rather than inlined into return
  assert.match(out.pseudocode, /\bload_2\s*=\s*a1->field_0;/);
  assert.match(out.pseudocode, /return load_2;/);
});

// ---------------------------------------------------------------------------
// [T2-P1-5] emitTailCallBranch & type-recovery return type alignment + anonymous tail call
// ---------------------------------------------------------------------------
test('[T2-P1-5] Anonymous direct tail calls recover return type and void callers emit `call(); return;`', () => {
  const x0 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const brTail = makeInst(1, OP.BR, {
    extra: { isTailCall: true, target: 0x401000n },
  });
  const ir = makeSimpleIr([brTail], [x0], { args: new Map([['x0', x0]]) });

  // type-recovery recovers non-void uint64 for anonymous direct tail call
  const types = inferSemanticTypes(ir, makeSimpleModel());
  assert.equal(types.ret.type, 'uint64');

  // semantic-core emits `return sub_401000(...)` for non-void caller
  const outNonVoid = runSemantic(ir, makeSimpleModel(), { name: 'tail_wrapper' });
  assert.match(outNonVoid.pseudocode, /return sub_401000\(/);

  // semantic-core emits `sub_401000(...); return;` when caller is void
  const outVoid = runSemantic(ir, makeSimpleModel(), { name: 'void_tail_wrapper', returnType: 'void' });
  assert.match(outVoid.pseudocode, /sub_401000\([^)]*\);\s*return;/);
  assert.ok(!/return sub_401000\(/.test(outVoid.pseudocode));
});

// ---------------------------------------------------------------------------
// [T2-P2-1] addr1 - addr2 address-origin misidentification fix
// ---------------------------------------------------------------------------
test('[T2-P2-1] Subtracting two address-derived values is not treated as an address', () => {
  const rodataBytes = new Uint8Array([0x41, 0x42, 0x00, 0x00]); // "AB\0"
  const sections = [{ name: '.rodata', addr: 0x10n, size: 4n, readOnly: true, bytes: rodataBytes }];

  const base = makeVal(1, { reg: 'x0', bits: 64, const: 0x1000n });
  const baseInst = makeInst(0, OP.ADDR, { extra: { value: 0x1000n } });
  linkValue(base, baseInst);

  const c20 = makeVal(2, { bits: 64, const: 0x20n });
  const c20Inst = makeInst(1, OP.CONST, { extra: { value: 0x20n } });
  linkValue(c20, c20Inst);

  const c10 = makeVal(3, { bits: 64, const: 0x10n });
  const c10Inst = makeInst(2, OP.CONST, { extra: { value: 0x10n } });
  linkValue(c10, c10Inst);

  const addr1 = makeVal(4, { reg: 'x1', bits: 64, const: 0x1020n });
  const add1 = makeInst(3, OP.BIN, { sub: 'add', args: [base, c20] });
  linkValue(addr1, add1);
  base.uses.push(add1);
  c20.uses.push(add1);

  const addr2 = makeVal(5, { reg: 'x2', bits: 64, const: 0x1010n });
  const add2 = makeInst(4, OP.BIN, { sub: 'add', args: [base, c10] });
  linkValue(addr2, add2);
  base.uses.push(add2);
  c10.uses.push(add2);

  // addr1 - addr2 = 0x10n (which happens to coincide with .rodata at 0x10n!)
  const diff = makeVal(6, { reg: 'x0', bits: 64, const: 0x10n });
  const subInst = makeInst(5, OP.BIN, { sub: 'sub', args: [addr1, addr2] });
  linkValue(diff, subInst);
  addr1.uses.push(subInst);
  addr2.uses.push(subInst);

  const ret = makeInst(6, OP.RET, { args: [diff] });
  diff.uses.push(ret);

  const ir = makeSimpleIr(
    [baseInst, c20Inst, c10Inst, add1, add2, subInst, ret],
    [base, c20, c10, addr1, addr2, diff],
  );

  const semOut = runSemantic(ir, makeSimpleModel(), { name: 'ptr_diff', sections });
  assert.ok(!semOut.pseudocode.includes('"AB"'), `addr1 - addr2 misidentified as string:\n${semOut.pseudocode}`);

  const pipeOut = enhanceSemanticDecompilation(semOut, makeSimpleModel(), { name: 'ptr_diff', sections });
  assert.ok(!pipeOut.pseudocode.includes('"AB"'), `pipeline addr1 - addr2 misidentified as string:\n${pipeOut.pseudocode}`);
  assert.ok(!pipeOut.pseudocode.includes('&global_10'), `pipeline addr1 - addr2 misidentified as global:\n${pipeOut.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [T2-P2-2] Raw .rodata byte string \n/\r/\t corruption fix
// ---------------------------------------------------------------------------
test('[T2-P2-2] Raw .rodata bytes containing literal backslash-n stay escaped as "\\\\n"', () => {
  // Raw bytes: '\' (0x5c), 'n' (0x6e), NUL (0x00)
  const rodataBytes = new Uint8Array([0x5c, 0x6e, 0x00]);
  const sections = [{ name: '.rodata', addr: 0x5000n, size: 3n, readOnly: true, bytes: rodataBytes }];

  const addrVal = makeVal(1, { reg: 'x0', bits: 64, const: 0x5000n });
  const addrInst = makeInst(0, OP.ADDR, { extra: { value: 0x5000n } });
  linkValue(addrVal, addrInst);
  const ret = makeInst(1, OP.RET, { args: [addrVal] });
  addrVal.uses.push(ret);

  const ir = makeSimpleIr([addrInst, ret], [addrVal]);

  const semOut = runSemantic(ir, makeSimpleModel(), { name: 'raw_escape', sections });
  assert.ok(semOut.pseudocode.includes('"\\\\n"'), `expected "\\\\n" in semantic output:\n${semOut.pseudocode}`);

  const pipeOut = enhanceSemanticDecompilation(semOut, makeSimpleModel(), { name: 'raw_escape', sections });
  assert.ok(pipeOut.pseudocode.includes('"\\\\n"'), `expected "\\\\n" in pipeline output:\n${pipeOut.pseudocode}`);
});

// ---------------------------------------------------------------------------
// [T2-P2-3] Unsigned hi/lo signed min/max folding suppression
// ---------------------------------------------------------------------------
test('[T2-P2-3] Unsigned hi/lo select is not folded into signed min()/max(), while signed gt still folds', () => {
  const a = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const b = makeVal(2, { kind: VK.ARG, reg: 'x1', bits: 64 });
  const flags = makeVal(3, { reg: 'nzcv', bits: 4 });
  const cmp = makeInst(0, OP.CMP, { sub: 'sub', bits: 64, args: [a, b] });
  linkValue(flags, cmp);
  a.uses.push(cmp);
  b.uses.push(cmp);

  // Unsigned hi select -> must NOT fold to max()
  const selHiVal = makeVal(4, { reg: 'x0', bits: 64 });
  const selHi = makeInst(1, OP.SEL, { cond: 'hi', args: [a, b, flags] });
  linkValue(selHiVal, selHi);
  a.uses.push(selHi);
  b.uses.push(selHi);
  flags.uses.push(selHi);
  const retHi = makeInst(2, OP.RET, { args: [selHiVal] });
  selHiVal.uses.push(retHi);

  const outHi = runSemantic(
    makeSimpleIr([cmp, selHi, retHi], [a, b, flags, selHiVal], { args: new Map([['x0', a], ['x1', b]]) }),
    makeSimpleModel(),
    { name: 'u_max' },
  );
  assert.ok(!/\b(?:min|max)\(/.test(outHi.pseudocode), `unsigned hi folded into signed min/max:\n${outHi.pseudocode}`);

  // Signed gt select -> still folds to max()
  const selGtVal = makeVal(5, { reg: 'x0', bits: 64 });
  const selGt = makeInst(1, OP.SEL, { cond: 'gt', args: [a, b, flags] });
  linkValue(selGtVal, selGt);
  const retGt = makeInst(2, OP.RET, { args: [selGtVal] });
  selGtVal.uses.push(retGt);

  const outGt = runSemantic(
    makeSimpleIr([cmp, selGt, retGt], [a, b, flags, selGtVal], { args: new Map([['x0', a], ['x1', b]]) }),
    makeSimpleModel(),
    { name: 's_max' },
  );
  assert.match(outGt.pseudocode, /\bmax\(/);
});

// ---------------------------------------------------------------------------
// [T2-P2-4] renderValueText fallback cache & trace memo contamination prevention
// ---------------------------------------------------------------------------
test('[T2-P2-4] Circular or budget-exceeded fallback does not pollute exprCache', () => {
  const v1 = makeVal(1, { reg: 'x0', bits: 64 });
  const v2 = makeVal(2, { reg: 'x1', bits: 64 });
  const inst1 = makeInst(1, OP.BIN, { sub: 'add', args: [v2, v2] });
  const inst2 = makeInst(2, OP.MOV, { args: [v1] }); // cycle v1 -> v2 -> v1
  linkValue(v1, inst1);
  linkValue(v2, inst2);

  const ctx = {
    ir: makeSimpleIr([inst1, inst2], [v1, v2]),
    model: makeSimpleModel(),
    opts: {},
    types: { values: new Map(), args: [] },
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
    exprFallbackHit: false,
    materialNames: new Map(),
    phiVarNames: new Map(),
    callCache: new Map(),
  };

  const rendered = renderValue(v1, ctx);
  assert.ok(typeof rendered === 'string' && rendered.length > 0);
  // Neither v1 nor v2 should be cached because a cycle fallback occurred
  assert.equal(ctx.exprCache.has('1:v'), false);
  assert.equal(ctx.exprCache.has('2:v'), false);
  assert.equal(ctx.exprFallbackHit, false);

  // Subsequent non-cyclic render should still cache normally
  const v3 = makeVal(3, { reg: 'x2', bits: 64, const: 7n });
  const cInst = makeInst(3, OP.CONST, { extra: { value: 7n } });
  linkValue(v3, cInst);
  assert.equal(renderValue(v3, ctx), '7');
  assert.equal(ctx.exprCache.get('3:v'), '7');
});
