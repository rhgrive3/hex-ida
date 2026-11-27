import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OP, VK, MK } from '../../js/ir.js';
import {
  decompileSemantic,
  renderBranchCondition,
  renderValue,
} from '../../js/decompiler/semantic-core.js';

function val(id, reg, bits = 64, kind = VK.DEF, extra = {}) {
  return { id, reg, bits, kind, uses: [], def: null, const: null, ...extra };
}
function arg(id, reg, bits = 64, extra = {}) {
  return val(id, reg, bits, VK.ARG, extra);
}
function av(v) {
  return { value: v };
}

function makeCtx(ir, { model = { calls: [], addressRefs: [], instructions: [] }, opts = {}, types = null } = {}) {
  return {
    ir,
    model,
    opts,
    types: types || { values: new Map(), locations: new Map() },
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
    callCache: new Map(),
    callByRow: new Map((model.calls || []).map((c) => [c.row, c])),
    materialNames: new Map(),
    phiVarNames: new Map(),
    unknownCallArities: 0,
    runtime: null,
  };
}

function makeIr(args, values, insts, blocks = null, loops = []) {
  const allValues = [...args, ...values];
  const defaultBlocks = blocks || [{
    index: 0,
    startRow: 0,
    endRow: Math.max(0, insts.length - 1),
    succ: [],
    pred: [],
    phis: [],
    insts,
  }];
  return {
    entry: 0,
    values: allValues,
    instructions: insts,
    args: new Map(args.map((a) => [a.reg, a])),
    blocks: defaultBlocks,
    loops,
    stackSlots: [],
  };
}

// ============================================================================
// Fix 1: Pointer-to-(uintptr_t) casts in binText and unaryText + gcc check
// ============================================================================
test('Fix 1: binText and unaryText cast pointer operands to (uintptr_t) on integer-only ops and compile with gcc', () => {
  const ptr = arg(1, 'x0', 64);
  const ptr2 = arg(2, 'x1', 64);
  const idx = arg(3, 'x2', 64);
  const zero = val(4, 'imm', 64, VK.DEF, { const: 0n });
  const mask = val(5, 'imm', 64, VK.DEF, { const: 0xfn });

  const notDst = val(10, 'x3', 64);
  const negDst = val(11, 'x4', 64);
  const andDst = val(12, 'x5', 64);
  const subFromZeroDst = val(13, 'x6', 64);
  const addPtrPtrDst = val(14, 'x7', 64);
  const validPtrAddDst = val(15, 'x8', 64);
  const validPtrSubIntDst = val(16, 'x9', 64);
  const validPtrSubPtrDst = val(17, 'x10', 64);

  const notInst = { id: 100, op: OP.UN, sub: 'not', row: 0, block: 0, bits: 64, dst: notDst, args: [av(ptr)] };
  const negInst = { id: 101, op: OP.UN, sub: 'neg', row: 1, block: 0, bits: 64, dst: negDst, args: [av(ptr)] };
  const andInst = { id: 102, op: OP.BIN, sub: 'and', row: 2, block: 0, bits: 64, dst: andDst, args: [av(ptr), av(mask)] };
  const subZeroInst = { id: 103, op: OP.BIN, sub: 'sub', row: 3, block: 0, bits: 64, dst: subFromZeroDst, args: [av(zero), av(ptr)] };
  const addPtrPtrInst = { id: 104, op: OP.BIN, sub: 'add', row: 4, block: 0, bits: 64, dst: addPtrPtrDst, args: [av(ptr), av(ptr2)] };
  const validAddInst = { id: 105, op: OP.BIN, sub: 'add', row: 5, block: 0, bits: 64, dst: validPtrAddDst, args: [av(ptr), av(idx)] };
  const validSubIntInst = { id: 106, op: OP.BIN, sub: 'sub', row: 6, block: 0, bits: 64, dst: validPtrSubIntDst, args: [av(ptr), av(idx)] };
  const validSubPtrInst = { id: 107, op: OP.BIN, sub: 'sub', row: 7, block: 0, bits: 64, dst: validPtrSubPtrDst, args: [av(ptr), av(ptr2)] };

  notDst.def = notInst;
  negDst.def = negInst;
  andDst.def = andInst;
  subFromZeroDst.def = subZeroInst;
  addPtrPtrDst.def = addPtrPtrInst;
  validPtrAddDst.def = validAddInst;
  validPtrSubIntDst.def = validSubIntInst;
  validPtrSubPtrDst.def = validSubPtrInst;

  const ir = makeIr(
    [ptr, ptr2, idx],
    [zero, mask, notDst, negDst, andDst, subFromZeroDst, addPtrPtrDst, validPtrAddDst, validPtrSubIntDst, validPtrSubPtrDst],
    [notInst, negInst, andInst, subZeroInst, addPtrPtrInst, validAddInst, validSubIntInst, validSubPtrInst],
  );
  const types = {
    values: new Map([
      [ptr.id, { kind: 'pointer', cType: 'char *' }],
      [ptr2.id, { kind: 'pointer', cType: 'char *' }],
    ]),
    locations: new Map(),
  };
  const ctx = makeCtx(ir, { types });

  const notExpr = renderValue(notDst, ctx);
  const negExpr = renderValue(negDst, ctx);
  const andExpr = renderValue(andDst, ctx);
  const subZeroExpr = renderValue(subFromZeroDst, ctx);
  const addPtrPtrExpr = renderValue(addPtrPtrDst, ctx);
  const validAddExpr = renderValue(validPtrAddDst, ctx);
  const validSubIntExpr = renderValue(validPtrSubIntDst, ctx);
  const validSubPtrExpr = renderValue(validPtrSubPtrDst, ctx);

  assert.match(notExpr, /\(uintptr_t\)\(a1\)/, notExpr);
  assert.match(negExpr, /\(uintptr_t\)\(a1\)/, negExpr);
  assert.match(andExpr, /\(uintptr_t\)\(a1\)/, andExpr);
  assert.match(subZeroExpr, /0\s*-\s*\(\(uintptr_t\)\(a1\)\)/, subZeroExpr);
  assert.match(addPtrPtrExpr, /\(uintptr_t\)\(a1\).*\(uintptr_t\)\(a2\)/, addPtrPtrExpr);

  // Valid pointer arithmetic must stay clean without (uintptr_t)
  assert.doesNotMatch(validAddExpr, /uintptr_t/, validAddExpr);
  assert.doesNotMatch(validSubIntExpr, /uintptr_t/, validSubIntExpr);
  assert.doesNotMatch(validSubPtrExpr, /uintptr_t/, validSubPtrExpr);

  // Verify gcc -fsyntax-only accepts all generated expressions with real pointer params
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass9-ptr-'));
  const cPath = path.join(tmpDir, 'test.c');
  try {
    const cCode = [
      '#include <stdint.h>',
      '#include <stddef.h>',
      'void f(char *a1, char *a2, size_t a3) {',
      `  uintptr_t v1 = ${notExpr};`,
      `  uintptr_t v2 = ${negExpr};`,
      `  uintptr_t v3 = ${andExpr};`,
      `  uintptr_t v4 = ${subZeroExpr};`,
      `  uintptr_t v5 = ${addPtrPtrExpr};`,
      `  char *v6 = ${validAddExpr};`,
      `  char *v7 = ${validSubIntExpr};`,
      `  ptrdiff_t v8 = ${validSubPtrExpr};`,
      '  (void)v1; (void)v2; (void)v3; (void)v4; (void)v5; (void)v6; (void)v7; (void)v8;',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(cPath, cCode, 'utf8');
    execFileSync('gcc', ['-fsyntax-only', '-Wall', '-Wextra', '-Werror', cPath], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Fix 2: returnValueAt call-clobber check
// ============================================================================
test('Fix 2: returnValueAt resolves reaching x0 when ret.args[0] precedes an intervening OP.CALL', () => {
  const a1 = arg(1, 'x0', 64);
  const callRes = val(2, 'x0', 64);
  const callInst = {
    id: 100, op: OP.CALL, row: 0, block: 0, address: 0x1000n,
    dst: callRes, args: [av(a1)], extra: { name: 'helper' },
  };
  callRes.def = callInst;

  // Stale ret.args[0] still points to `a1` even though `callInst` redefined x0
  const retInst = {
    id: 101, op: OP.RET, row: 1, block: 0, address: 0x1004n,
    args: [av(a1)],
  };
  a1.uses.push(callInst, retInst);

  const ir = makeIr([a1], [callRes], [callInst, retInst]);
  const model = {
    calls: [{ row: 0, name: 'helper', argCount: 1 }],
    addressRefs: [],
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'bl', op_str: 'helper' },
      { row: 1, address: 0x1004n, mnemonic: 'ret', op_str: '' },
    ],
  };

  const out = decompileSemantic(model, { ir, name: 'test_fn', addr: 0x1000n });
  const text = out.lines.map((l) => l.text).join('\n');
  assert.match(text, /helper\(/, text);
  assert.doesNotMatch(text, /return a1;/, text);
  assert.match(text, /return call_2;|return helper\(/, text);
});

// ============================================================================
// Fix 3: resolveAddressConstForValue anyRow for declared/data/bss addresses
// ============================================================================
test('Fix 3: resolveAddressConstForValue uses anyRow for known .bss/.data/.rodata or declared globals', () => {
  const dstPtr = val(1, 'x0', 64, VK.DEF, { const: 0x20060n });
  const srcPtr = arg(2, 'x1', 64);
  const constInst = {
    id: 100, op: OP.CONST, row: 5, block: 0, address: 0x1014n, bits: 64,
    dst: dstPtr, args: [], extra: { value: 0x20060n },
  };
  dstPtr.def = constInst;

  const ir = makeIr([srcPtr], [dstPtr], [constInst]);
  const model = {
    calls: [],
    // addressRef was recorded at row 1 (different from constInst.row === 5)
    addressRefs: [{ row: 1, addr: 0x20060n }],
    sections: [{ name: '.bss', addr: 0x20000n, size: 0x1000n }],
    instructions: [],
  };
  const ctx = makeCtx(ir, { model });
  const rendered = renderValue(dstPtr, ctx);
  assert.equal(rendered, '&global_20060');
});

// ============================================================================
// Fix 4: cmpFromFlags fcmp/fcmpe NZCV resolution
// ============================================================================
test('Fix 4: cmpFromFlags handles fcmp/fcmpe NZCV producers without emitting condition_<cc>', () => {
  const d0 = arg(1, 'd0', 64);
  const d1 = arg(2, 'd1', 64);
  const flags1 = val(10, 'nzcv', 4);
  const flags2 = val(11, 'nzcv', 4);

  // Producer 1: direct fcmp op
  const fcmpInst = {
    id: 100, op: 'fcmp', row: 0, block: 0, address: 0x1000n, bits: 64,
    dst: flags1, args: [av(d0), av(d1)], extra: {},
  };
  flags1.def = fcmpInst;

  // Producer 2: OP.UNKNOWN with mnemonic 'fcmpe' forwarded through OP.MOV
  const fcmpeRaw = val(12, 'nzcv', 4);
  const fcmpeInst = {
    id: 101, op: OP.UNKNOWN, sub: 'fcmpe', row: 1, block: 0, address: 0x1004n, bits: 64,
    dst: fcmpeRaw, args: [av(d0), av(d1)], extra: { mnemonic: 'fcmpe' },
  };
  fcmpeRaw.def = fcmpeInst;
  const movFlags = {
    id: 102, op: OP.MOV, row: 2, block: 0, address: 0x1008n, bits: 4,
    dst: flags2, args: [av(fcmpeRaw)],
  };
  flags2.def = movFlags;

  const ir = makeIr([d0, d1], [flags1, flags2, fcmpeRaw], [fcmpInst, fcmpeInst, movFlags]);
  const ctx = makeCtx(ir);

  for (const [flags, cond, opRe] of [
    [flags1, 'eq', /==/],
    [flags1, 'gt', />/],
    [flags1, 'ne', /!=/],
    [flags2, 'eq', /==/],
    [flags2, 'gt', />/],
    [flags2, 'ne', /!=/],
  ]) {
    const cbr = { id: 200, op: OP.CBR, cond, row: 3, block: 0, address: 0x100cn, args: [av(flags)], extra: { cond } };
    const rendered = renderBranchCondition(cbr, ctx);
    assert.doesNotMatch(rendered, /condition_/, rendered);
    assert.match(rendered, opRe, rendered);
  }
});

// ============================================================================
// Fix 5: resolveConstantCString cycle-safe OP.PHI unwrapping
// ============================================================================
test('Fix 5: resolveConstantCString unwraps cyclic OP.PHI chains to recover printf format string', () => {
  const x1Val = arg(1, 'x1', 64);
  const strVal = val(2, 'x0', 64, VK.DEF, { const: 0x3000n });
  const addrInst = {
    id: 100, op: OP.ADDR, row: 0, block: 0, address: 0x1000n, bits: 64,
    dst: strVal, args: [], extra: { value: 0x3000n },
  };
  strVal.def = addrInst;

  const phi1 = val(3, 'x0', 64, VK.PHI);
  const phi2 = val(4, 'x0', 64, VK.PHI);
  const phiInst1 = {
    id: 101, op: OP.PHI, row: 1, block: 1, dst: phi1,
    incoming: [{ from: 0, value: strVal }, { from: 1, value: phi2 }],
    args: [av(strVal), av(phi2)],
  };
  const phiInst2 = {
    id: 102, op: OP.PHI, row: 2, block: 1, dst: phi2,
    incoming: [{ from: 1, value: phi1 }],
    args: [av(phi1)],
  };
  phi1.def = phiInst1;
  phi2.def = phiInst2;

  const callRes = val(5, 'x0', 32);
  const callInst = {
    id: 103, op: OP.CALL, row: 3, block: 1, address: 0x1010n,
    dst: callRes, args: [av(phi1), av(x1Val)],
    callArguments: [
      { reg: 'x0', value: phi1 },
      { reg: 'x1', value: x1Val },
    ],
    extra: { name: 'printf' },
  };
  callRes.def = callInst;
  const retInst = { id: 104, op: OP.RET, row: 4, block: 1, address: 0x1014n, args: [av(callRes)] };
  phi1.uses.push(phiInst2, callInst);
  phi2.uses.push(phiInst1);
  strVal.uses.push(phiInst1);
  x1Val.uses.push(callInst);
  callRes.uses.push(retInst);

  const b0 = { index: 0, startRow: 0, endRow: 0, succ: [1], pred: [], phis: [], insts: [addrInst] };
  const b1 = { index: 1, startRow: 1, endRow: 4, succ: [], pred: [0], phis: [phiInst1, phiInst2], insts: [callInst, retInst] };
  const ir = makeIr([x1Val], [strVal, phi1, phi2, callRes], [addrInst, phiInst1, phiInst2, callInst, retInst], [b0, b1]);
  const model = {
    calls: [{ row: 3, name: 'printf', argCount: 1 }],
    addressRefs: [{ row: 0, addr: 0x3000n, text: '%ld\\n' }],
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'adrp', op_str: 'x0, #0x3000' },
      { row: 3, address: 0x1010n, mnemonic: 'bl', op_str: 'printf' },
      { row: 4, address: 0x1014n, mnemonic: 'ret', op_str: '' },
    ],
  };

  const out = decompileSemantic(model, { ir, name: 'test_phi_cstr', addr: 0x1000n });
  const text = out.lines.map((l) => l.text).join('\n');
  assert.match(text, /printf\(.*,\s*a2\)/, text);
  assert.match(text, /"%ld\\n"/, text);
});

// ============================================================================
// Fix 6: Prevent OP.LOAD inlining/sinking across OP.CALL / OP.STORE / loop boundaries
// ============================================================================
test('Fix 6: OP.LOAD before free() materializes before free() rather than sinking into return', () => {
  const ptr = arg(1, 'x0', 64);
  const loaded = val(2, 'x1', 64);
  const loadInst = {
    id: 100, op: OP.LOAD, row: 0, block: 0, address: 0x1000n, size: 8,
    dst: loaded,
    loc: { kind: MK.FIELD, key: 'field:1:8', base: ptr, disp: 8n, size: 8 },
    addr: { base: ptr, disp: 8n, size: 8 },
    args: [],
  };
  loaded.def = loadInst;

  const freeInst = {
    id: 101, op: OP.CALL, row: 1, block: 0, address: 0x1004n,
    dst: null, args: [av(ptr)],
    callArguments: [{ reg: 'x0', value: ptr }],
    extra: { name: 'free' },
  };
  const retInst = {
    id: 102, op: OP.RET, row: 2, block: 0, address: 0x1008n,
    args: [av(loaded)],
  };
  ptr.uses.push(loadInst, freeInst);
  loaded.uses.push(retInst);

  const ir = makeIr([ptr], [loaded], [loadInst, freeInst, retInst]);
  const model = {
    calls: [{ row: 1, name: 'free', argCount: 1 }],
    addressRefs: [],
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'ldr', op_str: 'x1, [x0, #8]' },
      { row: 1, address: 0x1004n, mnemonic: 'bl', op_str: 'free' },
      { row: 2, address: 0x1008n, mnemonic: 'ret', op_str: '' },
    ],
  };

  const out = decompileSemantic(model, { ir, name: 'no_uaf', addr: 0x1000n });
  const text = out.lines.map((l) => l.text).join('\n');
  const loadIdx = text.indexOf('load_2 =');
  const freeIdx = text.indexOf('free(');
  assert.ok(loadIdx !== -1, `expected materialized load_2 in:\n${text}`);
  assert.ok(freeIdx !== -1, `expected free() in:\n${text}`);
  assert.ok(loadIdx < freeIdx, `load_2 must appear before free():\n${text}`);
  assert.match(text, /return load_2;/, text);
});

// ============================================================================
// Fix 7: emitRegion already-emitted / loop-header / out-of-allowed target emits jump
// ============================================================================
test('Fix 7: emitRegion emits continue/goto instead of an empty {} arm when target is loopHeader or already visited', () => {
  const a1 = arg(1, 'x0', 64);
  const c0 = val(2, 'imm', 64, VK.DEF, { const: 0n });
  const flags0 = val(3, 'nzcv', 4);
  const flags1 = val(4, 'nzcv', 4);

  // b0 (loop header): if (a1 == 0) goto b2 (exit) else b1 (body)
  const cmp0 = { id: 100, op: OP.CMP, sub: 'sub', row: 0, block: 0, address: 0x1000n, bits: 64, dst: flags0, args: [av(a1), av(c0)] };
  flags0.def = cmp0;
  const cbr0 = { id: 101, op: OP.CBR, cond: 'eq', row: 1, block: 0, address: 0x1004n, args: [av(flags0)], extra: { cond: 'eq', trueBlock: 2, falseBlock: 1 } };

  // b1 (loop body): if (a1 != 0) -> b0 (loopHeader, backedge) else b1_else -> b0
  // Here yes = 0 (loopHeader), no = 3 (both reach loopHeader=0, join=0).
  const cmp1 = { id: 102, op: OP.CMP, sub: 'sub', row: 2, block: 1, address: 0x1008n, bits: 64, dst: flags1, args: [av(a1), av(c0)] };
  flags1.def = cmp1;
  const cbr1 = { id: 103, op: OP.CBR, cond: 'ne', row: 3, block: 1, address: 0x100cn, args: [av(flags1)], extra: { cond: 'ne', trueBlock: 0, falseBlock: 3 } };

  const helperCall = { id: 104, op: OP.CALL, row: 4, block: 3, address: 0x1010n, dst: null, args: [av(a1)], extra: { name: 'work' } };
  const br3 = { id: 105, op: OP.BR, row: 5, block: 3, address: 0x1014n, args: [], extra: { targetBlock: 0 } };

  const ret2 = { id: 106, op: OP.RET, row: 6, block: 2, address: 0x1018n, args: [av(a1)] };

  const b0 = { index: 0, startRow: 0, endRow: 1, succ: [2, 1], pred: [1, 3], phis: [], insts: [cmp0, cbr0] };
  const b1 = { index: 1, startRow: 2, endRow: 3, succ: [0, 3], pred: [0], phis: [], insts: [cmp1, cbr1] };
  const b2 = { index: 2, startRow: 6, endRow: 6, succ: [], pred: [0], phis: [], insts: [ret2] };
  const b3 = { index: 3, startRow: 4, endRow: 5, succ: [0], pred: [1], phis: [], insts: [helperCall, br3] };

  const ir = makeIr(
    [a1],
    [c0, flags0, flags1],
    [cmp0, cbr0, cmp1, cbr1, helperCall, br3, ret2],
    [b0, b1, b2, b3],
    [{ header: 0, nodes: new Set([0, 1, 3]), exits: new Set([2]), latches: new Set([1, 3]) }],
  );
  const model = {
    calls: [{ row: 4, name: 'work', argCount: 1 }],
    addressRefs: [],
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'cmp', op_str: 'x0, #0' },
      { row: 1, address: 0x1004n, mnemonic: 'b.eq', op_str: '#0x1018' },
      { row: 2, address: 0x1008n, mnemonic: 'cmp', op_str: 'x0, #0' },
      { row: 3, address: 0x100cn, mnemonic: 'b.ne', op_str: '#0x1000' },
      { row: 4, address: 0x1010n, mnemonic: 'bl', op_str: 'work' },
      { row: 5, address: 0x1014n, mnemonic: 'b', op_str: '#0x1000' },
      { row: 6, address: 0x1018n, mnemonic: 'ret', op_str: '' },
    ],
  };

  const out = decompileSemantic(model, { ir, name: 'loop_arm_goto', addr: 0x1000n });
  const text = out.lines.map((l) => l.text).join('\n');
  // Must not emit an empty `if (...) {\n  }` block
  assert.doesNotMatch(text, /if\s*\([^)]+\)\s*\{\s*\}/, text);
});
