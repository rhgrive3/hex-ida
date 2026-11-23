import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  closeFunctionOutput,
  declarationBearingSource,
  isStandaloneGlobalPreludeDeclaration,
  scanIdentifierUses,
} from '../../js/decompiler/c-output-closure.js';
import {
  decompileSemantic,
  renderBranchCondition,
  renderMemoryLocation,
} from '../../js/decompiler/semantic-core.js';
import { OP, VK, MK } from '../../js/ir.js';

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

function checkGccSyntax(cSource, label = 'gcc-syntax') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-pass7-3b-'));
  const srcPath = path.join(tmpDir, 'test.c');
  try {
    fs.writeFileSync(srcPath, cSource, 'utf8');
    execFileSync('gcc', ['-fsyntax-only', '-x', 'c', srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    assert.fail(`${label} failed:\n--- C source ---\n${cSource}\n--- stderr ---\n${stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeVal(id, fields = {}) {
  return { id, kind: VK.TEMP, bits: 64, uses: [], ...fields };
}

function makeMinimalCtx(ir, opts = {}) {
  return {
    ir,
    model: { instructions: [], calls: [], addressRefs: [] },
    opts,
    types: { values: new Map(), ret: null },
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
    callCache: new Map(),
    materialNames: new Map(),
    phiVarNames: new Map(),
  };
}

// ============================================================================
// Fix 1: Numeric-literal blanking & isPointerCast guard in c-output-closure.js
// ============================================================================

test('Fix 1: declarationBearingSource keeps non-whitespace digits so (x1 * 5) is not misread as pointer cast', () => {
  const cleaned = declarationBearingSource('uint64 y = (x1 * 5) + (phi_10 * 3);');
  assert.match(cleaned, /\(x1 \* 0\)/);
  assert.match(cleaned, /\(phi_10 \* 0\)/);

  const uses = scanIdentifierUses('uint64 y = (x1 * 5) + (phi_10 * 3);');
  assert.equal(uses.get('x1')?.castType, false);
  assert.equal(uses.get('x1')?.value, true);
  assert.equal(uses.get('phi_10')?.castType, false);
  assert.equal(uses.get('phi_10')?.value, true);

  // Even if a register or synthetic local appears before `*)`, isPointerCast must not suppress it.
  const usesGuard = scanIdentifierUses('uint64 z = (x1 *)a + (local_p10 *)b + (phi_4 *)c;');
  assert.equal(usesGuard.get('x1')?.castType, false);
  assert.equal(usesGuard.get('local_p10')?.castType, false);
  assert.equal(usesGuard.get('phi_4')?.castType, false);

  // Real typedef pointer casts still classify as castType.
  const usesType = scanIdentifierUses('uint64 z = (MyStruct *)ptr;');
  assert.equal(usesType.get('MyStruct')?.castType, true);

  const closed = closeFunctionOutput(makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 func0(uint64 a1)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'x1 = a1 + 1;' },
    { kind: 'stmt', indent: 1, text: 'return (x1 * 5);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]));
  assert.match(closed.pseudocode, /\buint64 x1;/);
  checkGccSyntax(closed.pseudocode, 'fix1-x1-mul-5');
});

// ============================================================================
// Fix 2: .bss static buffer sizing for &global_<ADDR> in c-output-closure.js
// ============================================================================

test('Fix 2: &global_<ADDR> emits 4096-byte backing buffer compatible with scalar reads/writes and gcc -fsyntax-only', () => {
  const closed = closeFunctionOutput(makeResult([
    { kind: 'sig', indent: 0, text: 'char * func0(uint64 a1)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'global_20048 = a1;' },
    { kind: 'stmt', indent: 1, text: 'memset(&global_20048, 0, 128);' },
    { kind: 'stmt', indent: 1, text: 'sprintf((char *)&global_20048, "%llu", (unsigned long long)a1);' },
    { kind: 'stmt', indent: 1, text: 'global_30000 = 7;' },
    { kind: 'stmt', indent: 1, text: 'return (char *)&global_20048;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]));

  assert.match(closed.pseudocode, /static uint64 __hex_global_20048_buf\[512\] = \{0\};/);
  assert.match(closed.pseudocode, /#define global_20048 \(__hex_global_20048_buf\[0\]\)/);
  // Plain scalar global without address-of stays scalar.
  assert.match(closed.pseudocode, /static uint64 global_30000 = 0;/);
  assert.doesNotMatch(closed.pseudocode, /__hex_global_30000_buf/);

  // Recognized by prelude declaration helper for TU packager stripping.
  assert.equal(isStandaloneGlobalPreludeDeclaration('static uint64 __hex_global_20048_buf[512] = {0};'), true);
  assert.equal(isStandaloneGlobalPreludeDeclaration('#define global_20048 (__hex_global_20048_buf[0])'), true);
  assert.equal(isStandaloneGlobalPreludeDeclaration('#define global_20048 (__hex_global_OTHER_buf[0])'), false);

  // Must compile cleanly with gcc -fsyntax-only.
  checkGccSyntax(closed.pseudocode, 'fix2-bss-buffer');

  // Idempotency: re-closing already closed output must not duplicate global_20048.
  const reclosed = closeFunctionOutput(closed);
  const bufMatches = reclosed.pseudocode.match(/__hex_global_20048_buf\[512\]/g) || [];
  assert.equal(bufMatches.length, 1);
  checkGccSyntax(reclosed.pseudocode, 'fix2-bss-buffer-idempotent');
});

// ============================================================================
// Fix 3: Escaped-frame guard in semantic-core.js (renderMemoryLocation)
// ============================================================================

test('Fix 3: renderMemoryLocation lowers MK.STACK to typed sp dereferences when stack pointer escapes', () => {
  const spEntry = makeVal(1, { kind: VK.ARG, reg: 'sp' });
  const c16 = makeVal(2, { kind: VK.CONST, const: 16n });
  const ptrVal = makeVal(3, { reg: 'x0' });
  const addInst = { id: 1, op: OP.BIN, sub: 'add', dst: ptrVal, args: [{ value: spEntry }, { value: c16 }], row: 0 };
  ptrVal.def = addInst;

  const callInst = { id: 2, op: OP.CALL, args: [{ value: ptrVal }], extra: { name: 'memset', target: 0x1000n }, row: 1 };
  const loadDst = makeVal(4, { reg: 'w0', bits: 32 });
  const stackLoc = { key: 'stack:sp:c-32:s4', kind: MK.STACK, baseReg: 'sp', frameEpoch: 0, disp: -32n, size: 4 };
  const loadInst = { id: 3, op: OP.LOAD, dst: loadDst, loc: stackLoc, addr: { base: spEntry, disp: -32n, size: 4 }, size: 4, row: 2 };
  loadDst.def = loadInst;

  const escapedIr = {
    instructions: [addInst, callInst, loadInst],
    blocks: [{ id: 0, insts: [addInst, callInst, loadInst], phis: [], succ: [] }],
    stackSlots: [{ key: stackLoc.key, disp: -32n, name: 'local_m20' }],
    values: [spEntry, c16, ptrVal, loadDst],
  };
  const escapedCtx = makeMinimalCtx(escapedIr);
  assert.equal(renderMemoryLocation(stackLoc, loadInst, escapedCtx), '*(uint32_t *)(uintptr_t)(sp - 32)');

  // Non-escaped stack frame must keep scalar local name.
  const nonEscapedIr = {
    instructions: [loadInst],
    blocks: [{ id: 0, insts: [loadInst], phis: [], succ: [] }],
    stackSlots: [{ key: stackLoc.key, disp: -32n, name: 'local_m20' }],
    values: [spEntry, loadDst],
  };
  const nonEscapedCtx = makeMinimalCtx(nonEscapedIr);
  assert.equal(renderMemoryLocation(stackLoc, loadInst, nonEscapedCtx), 'local_m20');
});

// ============================================================================
// Fix 4: ccmp/ccmn conditional compare carriers in renderCmp
// ============================================================================

test('Fix 4: renderBranchCondition lowers conditional compare carriers (ccmp/ccmn)', () => {
  const a1 = makeVal(1, { kind: VK.ARG, reg: 'x0', bits: 64 });
  const a2 = makeVal(2, { kind: VK.ARG, reg: 'x1', bits: 64 });
  const c0 = makeVal(3, { kind: VK.CONST, const: 0n, bits: 64 });
  const c5 = makeVal(4, { kind: VK.CONST, const: 5n, bits: 64 });

  const guardFlags = makeVal(5, { reg: 'nzcv' });
  const guardCmp = { id: 1, op: OP.CMP, sub: 'sub', dst: guardFlags, args: [{ value: a1 }, { value: c0 }], bits: 64, row: 0 };
  guardFlags.def = guardCmp;

  // Case A: fallbackNzcv = 0 (Z=0 -> eq is false) => (guardExpr && innerExpr)
  const ccmpFlagsAnd = makeVal(6, { reg: 'nzcv' });
  const ccmpAnd = {
    id: 2,
    op: OP.CMP,
    sub: 'sub',
    dst: ccmpFlagsAnd,
    args: [{ value: a2 }, { value: c5 }],
    bits: 64,
    row: 1,
    extra: {
      conditional: true,
      guardCond: 'ne',
      guardCmp,
      innerOp: 'sub',
      innerLhs: a2,
      innerRhs: c5,
      fallbackNzcv: 0,
    },
  };
  ccmpFlagsAnd.def = ccmpAnd;

  const cbrAnd = { id: 3, op: OP.CBR, cond: 'eq', args: [{ value: ccmpFlagsAnd }], row: 2 };
  const ctx = makeMinimalCtx({ instructions: [guardCmp, ccmpAnd, cbrAnd], blocks: [], values: [] });
  assert.equal(renderBranchCondition(cbrAnd, ctx, false), '((uint64_t)a1 != 0 && (uint64_t)a2 == 5)');

  // Case B: fallbackNzcv = 4 (Z=1 -> eq is true) => (!(guardExpr) || innerExpr)
  const ccmpFlagsOr = makeVal(7, { reg: 'nzcv' });
  const ccmpOr = {
    id: 4,
    op: OP.CMP,
    sub: 'sub',
    dst: ccmpFlagsOr,
    args: [{ value: a2 }, { value: c5 }],
    bits: 64,
    row: 3,
    extra: {
      conditional: true,
      guardCond: 'ne',
      guardCmp: guardFlags,
      innerOp: 'sub',
      innerLhs: a2,
      innerRhs: c5,
      fallbackNzcv: 4,
    },
  };
  ccmpFlagsOr.def = ccmpOr;

  const cbrOr = { id: 5, op: OP.CBR, cond: 'eq', args: [{ value: ccmpFlagsOr }], row: 4 };
  assert.equal(renderBranchCondition(cbrOr, ctx, false), '(!((uint64_t)a1 != 0) || (uint64_t)a2 == 5)');
});

// ============================================================================
// Fix 5: C operator precedence in cbz/cbnz
// ============================================================================

test('Fix 5: cbz/cbnz wraps non-atomic expressions in parentheses to preserve C precedence', () => {
  const phi = makeVal(1, { reg: 'x0' });
  phi.def = { id: 0, op: OP.PHI, dst: phi, incoming: [] };
  const one = makeVal(2, { kind: VK.CONST, const: 1n });
  const masked = makeVal(3, { reg: 'x1' });
  const andInst = { id: 1, op: OP.BIN, sub: 'and', dst: masked, args: [{ value: phi }, { value: one }], row: 0 };
  masked.def = andInst;

  const cbrZ = { id: 2, op: OP.CBR, sub: 'cbz', extra: { kind: 'cbz' }, args: [{ value: masked }], row: 1 };
  const cbrNz = { id: 3, op: OP.CBR, sub: 'cbnz', extra: { kind: 'cbnz' }, args: [{ value: masked }], row: 2 };
  const cbrAtomic = { id: 4, op: OP.CBR, sub: 'cbz', extra: { kind: 'cbz' }, args: [{ value: phi }], row: 3 };

  const ctx = makeMinimalCtx({ instructions: [andInst, cbrZ, cbrNz, cbrAtomic], blocks: [], values: [] });
  ctx.phiVarNames.set(phi.id, 'phi_262');

  assert.equal(renderBranchCondition(cbrZ, ctx, false), '(phi_262 & 1) == 0');
  assert.equal(renderBranchCondition(cbrNz, ctx, false), '(phi_262 & 1) != 0');
  assert.equal(renderBranchCondition(cbrAtomic, ctx, false), 'phi_262 == 0');
});

// ============================================================================
// Fix 6: Early-exit structuring false-edge PHI copy placement
// ============================================================================

test('Fix 6: earlyExit structuring wraps false-edge PHI copy in else arm when body can reach continuation', () => {
  // CFG:
  //   B0: if (a1 == 0) goto B1 else goto B3 (continuation)
  //   B1: if (a2 == 0) goto B2 (return 99) else goto B3 (continuation)
  //   B2: return 99
  //   B3: phi_val = phi(B0: 10, B1: 20); return phi_val
  // Here ipdom(B0) is null (B2 returns), earlyExit body is B1 -> {B2 (ret), B3 (cont)}.
  // Because B1 reaches B3, the B0->B3 PHI copy (phi_val = 10) MUST be in an `} else {` arm!
  const a1 = makeVal(1, { kind: VK.ARG, reg: 'x0' });
  const a2 = makeVal(2, { kind: VK.ARG, reg: 'x1' });
  const c10 = makeVal(3, { kind: VK.CONST, const: 10n });
  const c20 = makeVal(4, { kind: VK.CONST, const: 20n });
  const c99 = makeVal(5, { kind: VK.CONST, const: 99n });
  const phiVal = makeVal(6, { reg: 'x0' });

  const b0Cbr = { id: 1, block: 0, op: OP.CBR, sub: 'cbz', extra: { kind: 'cbz', targetBlock: 1 }, args: [{ value: a1 }], row: 0, address: 0x1000n };
  const b1Cbr = { id: 2, block: 1, op: OP.CBR, sub: 'cbz', extra: { kind: 'cbz', targetBlock: 2 }, args: [{ value: a2 }], row: 1, address: 0x1004n };
  const b2Ret = { id: 3, block: 2, op: OP.RET, args: [{ value: c99 }], row: 2, address: 0x1008n };
  const b3Phi = {
    id: 4, block: 3, op: OP.PHI, dst: phiVal,
    incoming: [{ from: 0, value: c10 }, { from: 1, value: c20 }],
    row: 3, address: 0x100cn,
  };
  phiVal.def = b3Phi;
  const b3Ret = { id: 5, block: 3, op: OP.RET, args: [{ value: phiVal }], row: 4, address: 0x1010n };
  phiVal.uses.push(b3Ret);

  const ir = {
    entry: 0,
    blocks: [
      { id: 0, startRow: 0, insts: [b0Cbr], phis: [], succ: [1, 3], pred: [] },
      { id: 1, startRow: 1, insts: [b1Cbr], phis: [], succ: [2, 3], pred: [0] },
      { id: 2, startRow: 2, insts: [b2Ret], phis: [], succ: [], pred: [1] },
      { id: 3, startRow: 3, insts: [b3Phi, b3Ret], phis: [b3Phi], succ: [], pred: [0, 1] },
    ],
    instructions: [b0Cbr, b1Cbr, b2Ret, b3Phi, b3Ret],
    values: [a1, a2, c10, c20, c99, phiVal],
    stackSlots: [],
  };
  const model = {
    name: 'early_exit_phi_test',
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'cbz', operands: 'x0, #0x1004' },
      { row: 1, address: 0x1004n, mnemonic: 'cbz', operands: 'x1, #0x1008' },
      { row: 2, address: 0x1008n, mnemonic: 'ret', operands: '' },
      { row: 3, address: 0x100cn, mnemonic: 'nop', operands: '' },
      { row: 4, address: 0x1010n, mnemonic: 'ret', operands: '' },
    ],
    calls: [],
    addressRefs: [],
  };

  const res = decompileSemantic(model, { ir, addr: 0x1000n });
  assert.ok(res && res.pseudocode, 'decompileSemantic should succeed');
  assert.match(res.pseudocode, /\} else \{/, `false-edge PHI copy must be guarded by else arm:\n${res.pseudocode}`);
  // The B0->B3 copy (`= 10;`) must appear inside the else arm, not unconditionally after the closing brace.
  assert.match(res.pseudocode, /\} else \{\s*\n\s*[A-Za-z0-9_]+ = 10;\s*\n\s*\}/, `expected = 10 inside else arm:\n${res.pseudocode}`);
});

// ============================================================================
// Fix 7: Folded adrp+add &global_ fallback + printf/sprintf/snprintf varargs
// ============================================================================

test('Fix 7A: folded adrp+add without string literal emits &global_<ADDR> instead of raw hex', () => {
  const pageVal = makeVal(1, { reg: 'x0', const: 0x20000n });
  const adrpInst = { id: 1, block: 0, op: OP.ADDR, dst: pageVal, extra: { value: 0x20000n }, args: [], row: 0, address: 0x1000n };
  pageVal.def = adrpInst;

  const offVal = makeVal(2, { kind: VK.CONST, const: 0x48n });
  const foldedVal = makeVal(3, { reg: 'x0', const: 0x20048n });
  const addInst = { id: 2, block: 0, op: OP.BIN, sub: 'add', dst: foldedVal, args: [{ value: pageVal }, { value: offVal }], row: 1, address: 0x1004n };
  foldedVal.def = addInst;

  const retInst = { id: 3, block: 0, op: OP.RET, args: [{ value: foldedVal }], row: 2, address: 0x1008n };

  const ir = {
    entry: 0,
    blocks: [{ id: 0, startRow: 0, insts: [adrpInst, addInst, retInst], phis: [], succ: [] }],
    instructions: [adrpInst, addInst, retInst],
    values: [pageVal, offVal, foldedVal],
    stackSlots: [],
  };
  const model = {
    name: 'folded_adrp_add_bss',
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'adrp', operands: 'x0, #0x20000' },
      { row: 1, address: 0x1004n, mnemonic: 'add', operands: 'x0, x0, #0x48' },
      { row: 2, address: 0x1008n, mnemonic: 'ret', operands: '' },
    ],
    calls: [],
    addressRefs: [],
  };

  const res = decompileSemantic(model, { ir, addr: 0x1000n });
  assert.ok(res && res.pseudocode);
  assert.match(res.pseudocode, /&global_20048\b/);
  assert.doesNotMatch(res.pseudocode, /\b0x20048\b/);
});

test('Fix 7B: sprintf/snprintf/printf recover AAPCS64 GP and FP variadic arguments from static format string', () => {
  const bufArg = makeVal(1, { kind: VK.ARG, reg: 'x0' });
  const fmtVal = makeVal(2, { reg: 'x1', const: 0x3000n });
  const fmtAddr = { id: 1, block: 0, op: OP.ADDR, dst: fmtVal, extra: { value: 0x3000n }, args: [], row: 0, address: 0x1000n };
  fmtVal.def = fmtAddr;

  const intArg = makeVal(3, { kind: VK.ARG, reg: 'x2', bits: 32 });
  const strArg = makeVal(4, { kind: VK.ARG, reg: 'x3' });
  const fpArg = makeVal(5, { kind: VK.ARG, reg: 'd0', bits: 64 });

  const callDst = makeVal(6, { reg: 'x0', bits: 32 });
  const callInst = {
    id: 2,
    block: 0,
    op: OP.CALL,
    dst: callDst,
    args: [{ value: bufArg }, { value: fmtVal }, { value: intArg }, { value: strArg }, { value: fpArg }],
    extra: { name: 'sprintf', target: 0x8000n },
    row: 1,
    address: 0x1004n,
  };
  callDst.def = callInst;

  const retInst = { id: 3, block: 0, op: OP.RET, args: [{ value: callDst }], row: 2, address: 0x1008n };

  const ir = {
    entry: 0,
    blocks: [{ id: 0, startRow: 0, insts: [fmtAddr, callInst, retInst], phis: [], succ: [] }],
    instructions: [fmtAddr, callInst, retInst],
    values: [bufArg, fmtVal, intArg, strArg, fpArg, callDst],
    stackSlots: [],
  };
  const model = {
    name: 'sprintf_varargs_test',
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'adr', operands: 'x1, #0x3000' },
      { row: 1, address: 0x1004n, mnemonic: 'bl', operands: '#0x8000' },
      { row: 2, address: 0x1008n, mnemonic: 'ret', operands: '' },
    ],
    calls: [{ row: 1, name: 'sprintf', target: 0x8000n }],
    addressRefs: [{ row: 0, addr: 0x3000n, text: '%d %.2f %s' }],
  };

  const res = decompileSemantic(model, { ir, addr: 0x1000n });
  assert.ok(res && res.pseudocode);
  assert.doesNotMatch(res.pseudocode, /varargs unknown/, `should resolve format varargs:\n${res.pseudocode}`);
  assert.match(res.pseudocode, /sprintf\(a1,\s*"%d %\.2f %s",\s*a3,\s*d0,\s*a4\)/, `expected GP+FP args in order:\n${res.pseudocode}`);
});
