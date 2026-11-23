import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCallResultMap,
  decompileSemantic,
  hasUnbalancedBracesInLines,
  memoryElementType,
  readSemanticConditionalRegions,
  renderMemoryLocation,
} from '../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../js/decompiler/pipeline-core.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { lowerArm64RawAssembly } from '../../js/decompiler/arm64-extra-semantics.js';
import { OP, VK, MK } from '../../js/ir-core.js';

function gccAvailable() {
  const probe = spawnSync('gcc', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function makeIR(blocks, values, args = new Map(), extra = {}) {
  const instructions = blocks.flatMap((b) => [...(b.phis || []), ...(b.insts || [])]);
  const ir = {
    entry: 0,
    blocks,
    values,
    instructions,
    args,
    locations: new Map(),
    stackSlots: [],
    loops: [],
    byRow: new Map(),
    ...extra,
  };
  for (const inst of instructions) {
    if (inst.row != null && !ir.byRow.has(inst.row)) ir.byRow.set(inst.row, inst);
  }
  return ir;
}

function findUninitializedCalls(code) {
  const used = new Set([...code.matchAll(/\b(call_\d+)\b/g)].map((m) => m[1]));
  const assigned = new Set([...code.matchAll(/\b(call_\d+)\s*=/g)].map((m) => m[1]));
  return [...used].filter((name) => !assigned.has(name));
}

test('1. semantic-core: unused inst.dst (x0) with used sibling (w0) materializes canonical call_<id> = foo()', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const vX0 = { id: 10, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };
  const vW0 = { id: 11, bits: 32, signed: false, kind: VK.REG, reg: 'w0', def: null, uses: [] };
  const vAdd = { id: 12, bits: 32, signed: false, kind: VK.REG, reg: 'w0', def: null, uses: [] };

  const iCall = {
    id: 1, row: 0, address: 0x1000n, block: 0, op: OP.CALL, dst: vX0,
    args: [{ value: a1 }],
    extra: { name: 'foo', target: 0x500n },
  };
  const iAdd = {
    id: 2, row: 1, address: 0x1004n, block: 0, op: OP.BIN, sub: 'add', dst: vAdd,
    args: [{ value: vW0 }, { value: { id: 13, bits: 32, kind: VK.CONST, const: 1n, def: null, uses: [] } }],
  };
  const iRet = { id: 3, row: 2, address: 0x1008n, block: 0, op: OP.RET, args: [{ value: vAdd }] };

  vX0.def = iCall;
  vW0.def = iCall;
  vAdd.def = iAdd;
  a1.uses.push(iCall);
  // vX0 deliberately has uses: [] while sibling vW0 has uses!
  vW0.uses.push(iAdd);
  vAdd.uses.push(iRet);

  const blocks = [{ index: 0, startRow: 0, endRow: 2, succ: [], pred: [], phis: [], insts: [iCall, iAdd, iRet] }];
  const ir = makeIR(blocks, [a1, vX0, vW0, vAdd], new Map([['x0', a1]]));
  const model = {
    arch: 'arm64',
    name: 'unused_dst_sibling_alias',
    calls: [{ row: 0, name: 'foo', target: 0x500n }],
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  const sem = decompileSemantic(model, { ir });
  assert.doesNotMatch(sem.pseudocode, /\bcall_11\b/, `sibling w0 must alias to call_10:\n${sem.pseudocode}`);
  assert.match(sem.pseudocode, /\bcall_10\s*=\s*foo\(/, `expected call_10 = foo(...):\n${sem.pseudocode}`);
  assert.deepEqual(findUninitializedCalls(sem.pseudocode), [], `uninitialized call_10:\n${sem.pseudocode}`);

  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  closeFunctionOutput(enhanced);
  assert.match(enhanced.pseudocode, /\bcall_10\s*=\s*foo\(/, `enhanced expected call_10 = foo(...):\n${enhanced.pseudocode}`);
  assert.deepEqual(findUninitializedCalls(enhanced.pseudocode), [], `enhanced uninit calls:\n${enhanced.pseudocode}`);
});

test('2. semantic-core & pipeline-core: preserve multi-reg (x1/rdx) and FP (v0/d0/xmm0) returns, fold only clobbered, prefer FP for float/double callees', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const vX0 = { id: 20, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };
  const vX1 = { id: 21, bits: 64, signed: false, kind: VK.REG, reg: 'x1', def: null, uses: [] };
  const vClob = { id: 22, bits: 64, signed: false, kind: VK.REG, reg: 'x2', clobbered: true, def: null, uses: [] };
  const vSum1 = { id: 23, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };
  const vSum2 = { id: 24, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };

  const iCall = {
    id: 1, row: 0, address: 0x2000n, block: 0, op: OP.CALL, dst: vX0,
    args: [{ value: a1 }],
    extra: { name: 'pair_fn', target: 0x600n },
  };
  const iAdd1 = { id: 2, row: 1, address: 0x2004n, block: 0, op: OP.BIN, sub: 'add', dst: vSum1, args: [{ value: vX0 }, { value: vX1 }] };
  const iAdd2 = { id: 3, row: 2, address: 0x2008n, block: 0, op: OP.BIN, sub: 'add', dst: vSum2, args: [{ value: vSum1 }, { value: vClob }] };
  const iRet = { id: 4, row: 3, address: 0x200cn, block: 0, op: OP.RET, args: [{ value: vSum2 }] };

  vX0.def = iCall;
  vX1.def = iCall;
  vClob.def = iCall;
  vSum1.def = iAdd1;
  vSum2.def = iAdd2;
  a1.uses.push(iCall);
  vX0.uses.push(iAdd1);
  vX1.uses.push(iAdd1);
  vClob.uses.push(iAdd2);
  vSum1.uses.push(iAdd2);
  vSum2.uses.push(iRet);

  const blocks = [{ index: 0, startRow: 0, endRow: 3, succ: [], pred: [], phis: [], insts: [iCall, iAdd1, iAdd2, iRet] }];
  const ir = makeIR(blocks, [a1, vX0, vX1, vClob, vSum1, vSum2], new Map([['x0', a1]]));
  const model = {
    arch: 'arm64',
    name: 'multi_reg_return_test',
    calls: [{ row: 0, name: 'pair_fn', target: 0x600n }],
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  const sem = decompileSemantic(model, { ir });
  // Multi-reg return x1 must NOT fold to 0; provably clobbered x2 MUST be folded/omitted.
  assert.match(sem.pseudocode, /\bcall_21\b/, `x1 should not fold to 0:\n${sem.pseudocode}`);
  assert.doesNotMatch(sem.pseudocode, /\bcall_22\b/, `clobbered x2 should be deleted:\n${sem.pseudocode}`);

  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  assert.match(enhanced.pseudocode, /\bcall_21\b/, `pipeline-core must not fold x1 to 0n:\n${enhanced.pseudocode}`);
  assert.doesNotMatch(enhanced.pseudocode, /\bcall_22\b/, `pipeline-core should fold clobbered x2:\n${enhanced.pseudocode}`);

  // FP-returning callee (sqrt) should prefer d0 over x0 in buildCallResultMap
  const vFpX0 = { id: 30, bits: 64, kind: VK.REG, reg: 'x0', def: null, uses: [] };
  const vFpD0 = { id: 31, bits: 64, kind: VK.REG, reg: 'd0', def: null, uses: [] };
  const iSqrt = { id: 10, row: 0, op: OP.CALL, dst: undefined, args: [], extra: { name: 'sqrt' } };
  const iUse = { id: 11, row: 1, op: OP.RET, args: [{ value: vFpD0 }] };
  vFpX0.def = iSqrt;
  vFpD0.def = iSqrt;
  vFpX0.uses.push(iUse);
  vFpD0.uses.push(iUse);
  const fpMap = buildCallResultMap({ values: [vFpX0, vFpD0] });
  assert.equal(fpMap.get(iSqrt), vFpD0, 'sqrt (double return) must prefer d0 over x0');

  // Integer-returning callee (strlen) still prefers x0 over d0
  const vIntX0 = { id: 40, bits: 64, kind: VK.REG, reg: 'x0', def: null, uses: [] };
  const vIntD0 = { id: 41, bits: 64, kind: VK.REG, reg: 'd0', def: null, uses: [] };
  const iStrlen = { id: 12, row: 0, op: OP.CALL, dst: undefined, args: [], extra: { name: 'strlen' } };
  vIntX0.def = iStrlen;
  vIntD0.def = iStrlen;
  vIntX0.uses.push(iUse);
  vIntD0.uses.push(iUse);
  const intMap = buildCallResultMap({ values: [vIntX0, vIntD0] });
  assert.equal(intMap.get(iStrlen), vIntX0, 'strlen (int return) must prefer x0 over d0');
});

test('3. semantic-core & pipeline-core: renderMemoryLocation / memoryLocation preserve signedness, FP types, disp when scale===size, and scale bounds', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const a2 = { id: 2, bits: 64, signed: false, kind: VK.ARG, reg: 'x1', def: null, uses: [] };
  const ctx = { opts: {}, exprCache: new Map(), exprActive: new Set(), exprNodes: 0 };

  // Signed loads: ldrsb / ldrsh / ldrsw
  const iLdrsb = { id: 1, op: OP.LOAD, sub: 'ldrsb', signed: true, dst: { id: 10, bits: 32, signed: true }, loc: { kind: MK.UNKNOWN }, addr: { base: a1, size: 1 } };
  const iLdrsh = { id: 2, op: OP.LOAD, mnemonic: 'ldrsh', dst: { id: 11, bits: 32, signed: true }, loc: { kind: MK.UNKNOWN }, addr: { base: a1, size: 2 } };
  const iLdrsw = { id: 3, op: OP.LOAD, extra: { signed: true }, dst: { id: 12, bits: 64, signed: true }, loc: { kind: MK.UNKNOWN }, addr: { base: a1, size: 4 } };
  assert.equal(renderMemoryLocation(iLdrsb.loc, iLdrsb, ctx), '*(int8_t *)(uintptr_t)(a1)');
  assert.equal(renderMemoryLocation(iLdrsh.loc, iLdrsh, ctx), '*(int16_t *)(uintptr_t)(a1)');
  assert.equal(renderMemoryLocation(iLdrsw.loc, iLdrsw, ctx), '*(int32_t *)(uintptr_t)(a1)');

  // FP load & store: float / double
  const iFload = { id: 4, op: OP.LOAD, dst: { id: 13, bits: 32, reg: 's0' }, loc: { kind: MK.UNKNOWN }, addr: { base: a1, size: 4 } };
  const iDstore = { id: 5, op: OP.STORE, args: [{ value: { id: 14, bits: 64, reg: 'd1' } }], loc: { kind: MK.UNKNOWN }, addr: { base: a1, size: 8, disp: 16n } };
  assert.equal(renderMemoryLocation(iFload.loc, iFload, ctx), '*(float *)(uintptr_t)(a1)');
  assert.equal(renderMemoryLocation(iDstore.loc, iDstore, ctx), '*(double *)((uintptr_t)(a1) + 16)');

  // Preserve addr.disp even when scaleBytes === size (scale=2 => 4, size=4, disp=8)
  const iScaledDisp = {
    id: 6, row: 0, address: 0x3000n, block: 0, op: OP.LOAD, signed: true,
    dst: { id: 15, bits: 32, signed: true, kind: VK.REG, reg: 'w0', def: null, uses: [] },
    loc: { kind: MK.UNKNOWN, key: 'unk:sd' },
    addr: { base: a1, index: a2, scale: 2, size: 4, disp: 8n },
  };
  assert.equal(renderMemoryLocation(iScaledDisp.loc, iScaledDisp, ctx), '*(int32_t *)((uintptr_t)(a1) + (a2) * 4 + 8)');

  // Unified width fallback (unknown/0 size -> uint64_t)
  assert.equal(memoryElementType({ op: OP.LOAD }, 0), 'uint64_t');
  assert.equal(memoryElementType({ op: OP.LOAD }, 3), 'uint64_t');

  // Verify pipeline-core memoryLocation also preserves signed type, disp when scale===size, and guards out-of-bounds scale
  const vRet = iScaledDisp.dst;
  const vBadScale = { id: 16, bits: 32, signed: false, kind: VK.REG, reg: 'w1', def: null, uses: [] };
  const iBadScale = {
    id: 7, row: 1, address: 0x3004n, block: 0, op: OP.LOAD, dst: vBadScale, args: [],
    loc: { kind: MK.UNKNOWN, key: 'unk:badscale' },
    addr: { base: a1, index: a2, scale: 32, size: 4, disp: 0n },
  };
  const vSum = { id: 17, bits: 32, signed: false, kind: VK.REG, reg: 'w0', def: null, uses: [] };
  const iAdd = { id: 8, row: 2, address: 0x3008n, block: 0, op: OP.BIN, sub: 'add', dst: vSum, args: [{ value: vRet }, { value: vBadScale }] };
  const iRet = { id: 9, row: 3, address: 0x300cn, block: 0, op: OP.RET, args: [{ value: vSum }] };
  vRet.def = iScaledDisp;
  vBadScale.def = iBadScale;
  vSum.def = iAdd;
  a1.uses.push(iScaledDisp, iBadScale);
  a2.uses.push(iScaledDisp, iBadScale);
  vRet.uses.push(iAdd);
  vBadScale.uses.push(iAdd);
  vSum.uses.push(iRet);

  const blocks = [{ index: 0, startRow: 0, endRow: 3, succ: [], pred: [], phis: [], insts: [iScaledDisp, iBadScale, iAdd, iRet] }];
  const ir = makeIR(blocks, [a1, a2, vRet, vBadScale, vSum], new Map([['x0', a1], ['x1', a2]]));
  const model = {
    arch: 'arm64',
    name: 'mem_loc_alignment',
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };
  const sem = decompileSemantic(model, { ir });
  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  assert.match(enhanced.pseudocode, /\*\(int32_t \*\)\(\(uintptr_t\)\(a1\) \+ \(a2\) \* 4 \+ 8\)/, `pipeline-core must preserve int32_t and + 8:\n${enhanced.pseudocode}`);
  assert.doesNotMatch(enhanced.pseudocode, /\(a2\) \* 1\b/, `out-of-bounds scale=32 must not wrap via 1 << 32:\n${enhanced.pseudocode}`);
});

test('4. semantic-core: conditionalRegionHistory fixup respects region.selection.invert', () => {
  // Build a diamond CFG where the `no` arm is emitted first (invert: true) and a goto label is inserted inside an arm.
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const c0 = { id: 2, bits: 64, kind: VK.CONST, const: 0n, def: null, uses: [] };
  const c1 = { id: 3, bits: 64, kind: VK.CONST, const: 1n, def: null, uses: [] };
  const c2 = { id: 4, bits: 64, kind: VK.CONST, const: 2n, def: null, uses: [] };
  const vFlags = { id: 5, bits: 4, kind: VK.FLAGS, def: null, uses: [] };

  const iCmp = { id: 1, row: 0, address: 0x4000n, block: 0, op: OP.CMP, dst: vFlags, args: [{ value: a1 }, { value: c0 }] };
  const iCbr = { id: 2, row: 1, address: 0x4004n, block: 0, op: OP.CBR, cond: 'eq', args: [{ value: vFlags }], extra: { target: 0x400cn, targetBlock: 2 } };
  // Block 1 (no arm, fallthrough): return 1
  const iRetNo = { id: 3, row: 2, address: 0x4008n, block: 1, op: OP.RET, args: [{ value: c1 }] };
  // Block 2 (yes arm, taken): return 2
  const iRetYes = { id: 4, row: 3, address: 0x400cn, block: 2, op: OP.RET, args: [{ value: c2 }] };

  vFlags.def = iCmp;
  a1.uses.push(iCmp);
  vFlags.uses.push(iCbr);

  const blocks = [
    { index: 0, startRow: 0, endRow: 1, succ: [1, 2], pred: [], phis: [], insts: [iCmp, iCbr] },
    { index: 1, startRow: 2, endRow: 2, succ: [], pred: [0], phis: [], insts: [iRetNo] },
    { index: 2, startRow: 3, endRow: 3, succ: [], pred: [0], phis: [], insts: [iRetYes] },
  ];
  const ir = makeIR(blocks, [a1, c0, c1, c2, vFlags], new Map([['x0', a1]]));
  const model = {
    arch: 'arm64',
    name: 'cond_region_invert',
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };
  const sem = decompileSemantic(model, { ir, phase8PrepareRegionProof: true });
  const hist = readSemanticConditionalRegions(sem);
  if (hist?.events?.length) {
    for (const region of hist.events) {
      if (region.separator && region.selection?.invert) {
        const noArm = region.arms.find((a) => a.role === 'no');
        const yesArm = region.arms.find((a) => a.role === 'yes');
        assert.ok(noArm && yesArm);
        const firstIdx = region.nodes.indexOf(noArm.nodes[0]);
        const secondIdx = region.nodes.indexOf(yesArm.nodes[0]);
        assert.ok(firstIdx < secondIdx, 'inverted region must place no-arm nodes before yes-arm nodes');
      }
    }
  }
});

test('5. semantic-core: hasUnbalancedBracesInLines handles strings with "//", char literals, and block comments', () => {
  assert.equal(hasUnbalancedBracesInLines([
    { text: 'if (cond) { log("http://example.com/{not-a-brace}"); }' },
  ]), false, '"//" inside string literal must not truncate closing "}"');

  assert.equal(hasUnbalancedBracesInLines([
    { text: 'if (cond) {' },
    { text: '  const char *u = "https://a.b/c"; /* } still balanced */' },
    { text: '  char c = \'{\'; // } line comment' },
    { text: '}' },
  ]), false);

  assert.equal(hasUnbalancedBracesInLines([
    { text: '/* multi-line { comment' },
    { text: '   still in comment { */' },
    { text: 'if (x) { return 1; }' },
  ]), false);

  assert.equal(hasUnbalancedBracesInLines([
    { text: 'if (x) { return 1;' },
  ]), true, 'truly unbalanced opening brace must return true');

  assert.equal(hasUnbalancedBracesInLines([
    { text: 'return 1; }' },
  ]), true, 'truly unbalanced closing brace must return true');
});

test('6. arm64-extra-semantics: fcvtas gated on standardC and NaN/overflow-safe via GCC runtime check', () => {
  // Non-standardC mode must emit __a64_fcvtas_* instead of UB C expression
  const legacy = lowerArm64RawAssembly({
    lines: [
      { kind: 'stmt', indent: 1, text: '__asm("fcvtas x0, d0");' },
      { kind: 'stmt', indent: 1, text: '__asm("fcvtas w1, s1");' },
    ],
  }, { standardC: false });
  assert.match(legacy.lines[0].text, /__a64_fcvtas_64\(d0\)/);
  assert.match(legacy.lines[1].text, /__a64_fcvtas_32\(s1\)/);

  // Standard-C mode must not use UB `x >= 0.0 ? x + 0.5 : x - 0.5`
  const std = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: 'void f(double d0, float s0)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: '__asm("fcvtas x0, d0");' },
      { kind: 'stmt', indent: 1, text: '__asm("fcvtas w1, d0");' },
      { kind: 'stmt', indent: 1, text: '__asm("fcvtas w2, s0");' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, { standardC: true });
  const loweredStmts = std.lines.filter((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.').map((l) => l.text);
  assert.equal(loweredStmts.length, 3);
  for (const s of loweredStmts) {
    assert.doesNotMatch(s, /\+\s*0\.5/, `must not use UB +0.5 formula: ${s}`);
    assert.match(s, /__builtin_llroundf?/, `expected __builtin_llround(f): ${s}`);
  }

  if (gccAvailable()) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-fcvtas-'));
    try {
      const cSrc = `
#include <stdint.h>
#include <stdio.h>
#include <math.h>
static int64_t run_x0_d0(double d0) { int64_t x0 = 0; ${loweredStmts[0]} return x0; }
static int32_t run_w1_d0(double d0) { int32_t w1 = 0; ${loweredStmts[1]} return w1; }
static int32_t run_w2_s0(float s0)  { int32_t w2 = 0; ${loweredStmts[2]} return w2; }
int main(void) {
  int f = 0;
  if (run_x0_d0(2.5) != 3) f++;
  if (run_x0_d0(-2.5) != -3) f++;
  if (run_x0_d0(0.49999999999999994) != 0) f++;
  if (run_x0_d0(4503599627370497.0) != 4503599627370497LL) f++;
  if (run_x0_d0(NAN) != 0) f++;
  if (run_x0_d0(INFINITY) != 0x7fffffffffffffffLL) f++;
  if (run_x0_d0(-INFINITY) != (-0x7fffffffffffffffLL - 1LL)) f++;
  if (run_w1_d0(2147483647.5) != 0x7fffffff) f++;
  if (run_w1_d0(-2147483648.5) != (-0x7fffffff - 1)) f++;
  if (run_w1_d0(NAN) != 0) f++;
  if (run_w2_s0(2.5f) != 3) f++;
  if (run_w2_s0(-2.5f) != -3) f++;
  if (run_w2_s0(NAN) != 0) f++;
  if (run_w2_s0(INFINITY) != 0x7fffffff) f++;
  if (run_w2_s0(-INFINITY) != (-0x7fffffff - 1)) f++;
  return f ? 1 : 0;
}
`;
      const srcPath = path.join(tmpDir, 'fcvtas.c');
      const binPath = path.join(tmpDir, 'fcvtas');
      fs.writeFileSync(srcPath, cSrc, 'utf8');
      execFileSync('gcc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', srcPath, '-lm', '-o', binPath]);
      execFileSync(binPath, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('7. arm64-extra-semantics: fcmp NaN/unordered truth table matches ARM64 FCMP NZCV=0011 for all 14 condition codes', () => {
  // ARM64 FCMP NZCV: == -> 0110, < -> 1000, > -> 0010, NaN -> 0011
  const expected = {
    //        [==,   <,    >,    NaN ]
    eq: [1, 0, 0, 0],
    ne: [0, 1, 1, 1],
    lo: [0, 1, 0, 0],
    cc: [0, 1, 0, 0],
    mi: [0, 1, 0, 0],
    ls: [1, 1, 0, 0],
    gt: [0, 0, 1, 0],
    ge: [1, 0, 1, 0],
    lt: [0, 1, 0, 1],
    le: [1, 1, 0, 1],
    hi: [0, 0, 1, 1],
    hs: [1, 0, 1, 1],
    cs: [1, 0, 1, 1],
    pl: [1, 0, 1, 1],
    vs: [0, 0, 0, 1],
    vc: [1, 1, 1, 0],
  };
  const stmts = {};
  for (const cond of Object.keys(expected)) {
    const res = lowerArm64RawAssembly({
      lines: [
        { kind: 'sig', indent: 0, text: 'uint64_t f(double d0, double d1)' },
        { kind: 'ctrl', indent: 0, text: '{' },
        { kind: 'stmt', indent: 1, text: '/* fcmp d0, d1 */' },
        { kind: 'stmt', indent: 1, text: `__asm("cset x0, ${cond}");` },
        { kind: 'stmt', indent: 1, text: 'return x0;' },
        { kind: 'ctrl', indent: 0, text: '}' },
      ],
    }, { standardC: true });
    const lowered = res.lines.find((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.');
    assert.ok(lowered, `expected lowering for cset x0, ${cond}`);
    stmts[cond] = lowered.text;
  }

  // Direct spot checks on the previously buggy codes
  assert.match(stmts.lo, /\(d0 < d1\)/);
  assert.match(stmts.cc, /\(d0 < d1\)/);
  assert.match(stmts.lt, /\(!\(d0 >= d1\)\)/);
  assert.match(stmts.le, /\(!\(d0 > d1\)\)/);
  assert.match(stmts.hi, /\(!\(d0 <= d1\)\)/);
  assert.match(stmts.hs, /\(!\(d0 < d1\)\)/);
  assert.match(stmts.cs, /\(!\(d0 < d1\)\)/);
  assert.match(stmts.pl, /\(!\(d0 < d1\)\)/);

  if (gccAvailable()) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-fcmp-'));
    try {
      const lines = [
        '#include <stdint.h>',
        '#include <stdio.h>',
        '#include <math.h>',
        'int main(void) {',
        '  int f = 0;',
        '  double pairs[4][2] = { {1.0, 1.0}, {1.0, 2.0}, {2.0, 1.0}, {NAN, 1.0} };',
      ];
      for (const [cond, exp] of Object.entries(expected)) {
        lines.push(`  { int exp[4] = {${exp.join(',')}}; for (int i = 0; i < 4; i++) { double d0 = pairs[i][0], d1 = pairs[i][1]; uint64_t x0 = 0; ${stmts[cond]} if ((int)x0 != exp[i]) { fprintf(stderr, "FAIL ${cond} case %d: got %llu exp %d\\n", i, (unsigned long long)x0, exp[i]); f++; } } }`);
      }
      lines.push('  return f ? 1 : 0;', '}');
      const srcPath = path.join(tmpDir, 'fcmp.c');
      const binPath = path.join(tmpDir, 'fcmp');
      fs.writeFileSync(srcPath, lines.join('\n'), 'utf8');
      execFileSync('gcc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', srcPath, '-o', binPath]);
      execFileSync(binPath, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('8. arm64-extra-semantics: lastCmp invalidated by calls, operand writes, flag-setting asm; fccmp preserves guard or invalidates', () => {
  // 8a. Call invalidates lastCmp
  const afterCall = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64_t f(uint64_t x1, uint64_t x2)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: '/* cmp x1, x2 */' },
      { kind: 'stmt', indent: 1, text: 'helper(x1);' },
      { kind: 'stmt', indent: 1, text: '__asm("cset x0, eq");' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, { standardC: true });
  const csetAfterCall = afterCall.lines.find((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.');
  assert.match(csetAfterCall.text, /cond:eq/, `call must invalidate lastCmp: ${csetAfterCall.text}`);

  // 8b. bl / blr in __asm invalidates lastCmp
  const afterBl = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64_t f(uint64_t x1, uint64_t x2)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: '/* cmp x1, x2 */' },
      { kind: 'stmt', indent: 1, text: '__asm("bl helper");' },
      { kind: 'stmt', indent: 1, text: '__asm("cset x0, ne");' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, { standardC: true });
  const csetAfterBl = afterBl.lines.find((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.');
  assert.match(csetAfterBl.text, /cond:ne/, `bl must invalidate lastCmp: ${csetAfterBl.text}`);

  // 8c. Write to register in lastCmp.lhs invalidates lastCmp
  const afterWrite = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64_t f(uint64_t x1, uint64_t x2)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: '/* cmp x1, x2 */' },
      { kind: 'stmt', indent: 1, text: 'x1 = x1 + 1;' },
      { kind: 'stmt', indent: 1, text: '__asm("cset x0, lt");' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, { standardC: true });
  const csetAfterWrite = afterWrite.lines.find((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.');
  assert.match(csetAfterWrite.text, /cond:lt/, `write to x1 must invalidate lastCmp: ${csetAfterWrite.text}`);

  // 8d. Flag-setting __asm (adds) invalidates lastCmp
  const afterAdds = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64_t f(uint64_t x1, uint64_t x2)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: '/* cmp x1, x2 */' },
      { kind: 'stmt', indent: 1, text: '__asm("adds x3, x4, #1");' },
      { kind: 'stmt', indent: 1, text: '__asm("cset x0, gt");' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, { standardC: true });
  const csetAfterAdds = afterAdds.lines.find((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.');
  assert.match(csetAfterAdds.text, /cond:gt/, `adds must invalidate lastCmp: ${csetAfterAdds.text}`);

  // 8e. fccmp preserves prior guard condition & fallback NZCV
  const withFccmp = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: 'double f(uint64_t x1, uint64_t x2, double d0, double d1, double d2)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: '/* cmp x1, x2 */' },
      { kind: 'stmt', indent: 1, text: '__asm("fccmp d0, d1, #4, eq");' },
      { kind: 'stmt', indent: 1, text: '__asm("fcsel d0, d1, d2, eq");' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, { standardC: true });
  const fcselLine = withFccmp.lines.find((l) => l.text.startsWith('d0 = '));
  assert.ok(fcselLine, 'expected lowered fcsel');
  assert.match(fcselLine.text, /\(uint64_t\)\(x1\)\s*==\s*\(uint64_t\)\(x2\)/, `fccmp must preserve cmp guard: ${fcselLine.text}`);
  assert.match(fcselLine.text, /\(d0 == d1\)/, `fccmp must include d0 == d1: ${fcselLine.text}`);

  // 8f. fccmp without prior lastCmp must invalidate lastCmp (not synthesize unconditional fcmp)
  const unguardedFccmp = lowerArm64RawAssembly({
    lines: [
      { kind: 'sig', indent: 0, text: 'double f(double d0, double d1, double d2)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: '__asm("fccmp d0, d1, #0, eq");' },
      { kind: 'stmt', indent: 1, text: '__asm("fcsel d0, d1, d2, gt");' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  }, { standardC: true });
  const unguardedFcsel = unguardedFccmp.lines.find((l) => l.text.startsWith('d0 = '));
  assert.match(unguardedFcsel.text, /cond:gt/, `unguarded fccmp must not become unconditional fcmp: ${unguardedFcsel.text}`);
});

test('9. arm64-extra-semantics: canonicalGpNames unifies wN -> xN when enabled or IR-backed, preserving wN otherwise', () => {
  const mkLines = () => ([
    { kind: 'sig', indent: 0, text: 'uint64_t f(uint64_t x0, uint64_t x1)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: '__asm("rev16 w0, w1");' },
    { kind: 'stmt', indent: 1, text: '__asm("ubfx w0, w0, #4, #8");' },
    { kind: 'stmt', indent: 1, text: 'return x0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  const canonical = lowerArm64RawAssembly({ lines: mkLines() }, { canonicalGpNames: true });
  const canonStmts = canonical.lines.filter((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.').map((l) => l.text);
  assert.equal(canonStmts.length, 2);
  assert.match(canonStmts[0], /^x0\s*=.*\(uint32_t\)\(x1\)/);
  assert.match(canonStmts[1], /^x0\s*=.*\(uint32_t\)\(x0\)/);

  const nonCanonical = lowerArm64RawAssembly({ lines: mkLines() });
  const rawStmts = nonCanonical.lines.filter((l) => l.note === 'Exact ARM64 instruction semantics lowered from the raw fallback.').map((l) => l.text);
  assert.match(rawStmts[0], /^w0\s*=.*\(uint32_t\)\(w1\)/);
});
