import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decompileSemantic } from '../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../js/decompiler/pipeline-core.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { OP, VK } from '../../js/ir-core.js';
import { openProduct } from '../../tools/validation/public-benchmark/product-host.mjs';

function hasTool(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

const HAS_AARCH64_GCC = hasTool('aarch64-linux-gnu-gcc');
const CC = hasTool('gcc') ? 'gcc' : hasTool('clang') ? 'clang' : null;

function assertAllGotoTargetsDefined(code, context = '') {
  const gotos = [...code.matchAll(/\bgoto\s+(loc_[0-9A-Fa-f]+)\s*;/g)].map((m) => m[1]);
  for (const label of gotos) {
    assert.match(code, new RegExp(`\\b${label}:`), `${context}: undefined goto target ${label}\n${code}`);
  }
}

function assertCSyntaxOk(code, context = '') {
  if (!CC) return;
  try {
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-w', '-'], {
      input: code,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    assert.fail(`${context}: C syntax check failed:\n${code}\n--- stderr ---\n${String(err.stderr || err.message || '')}`);
  }
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

test('1. phi variable naming matches between semantic-core and pipeline-core (and preserves local_phi_ under phase8Optimize)', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const c0 = { id: 2, bits: 64, signed: false, kind: VK.CONST, const: 0n, def: null, uses: [] };
  const c10 = { id: 3, bits: 64, signed: false, kind: VK.CONST, const: 10n, def: null, uses: [] };
  const c20 = { id: 4, bits: 64, signed: false, kind: VK.CONST, const: 20n, def: null, uses: [] };
  const flags = { id: 5, bits: 64, signed: false, kind: VK.REG, reg: 'nzcv', def: null, uses: [] };
  const phiDst = { id: 117, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };

  const iConst0 = { id: 1, row: 0, address: 0x1000n, block: 0, op: OP.CONST, dst: c0, args: [], extra: { value: 0n } };
  const iCmp = { id: 2, row: 1, address: 0x1004n, block: 0, op: OP.CMP, dst: flags, args: [{ value: a1 }, { value: c0 }] };
  const iCbr = { id: 3, row: 2, address: 0x1008n, block: 0, op: OP.CBR, cond: 'eq', args: [{ value: flags }], trueTarget: 1, falseTarget: 2, extra: { cond: 'eq', target: 0x100cn, fallthrough: 0x1014n } };

  const iConst10 = { id: 4, row: 3, address: 0x100cn, block: 1, op: OP.CONST, dst: c10, args: [], extra: { value: 10n } };
  const iBr1 = { id: 5, row: 4, address: 0x1010n, block: 1, op: OP.BR, args: [], target: 3 };

  const iConst20 = { id: 6, row: 5, address: 0x1014n, block: 2, op: OP.CONST, dst: c20, args: [], extra: { value: 20n } };
  const iBr2 = { id: 7, row: 6, address: 0x1018n, block: 2, op: OP.BR, args: [], target: 3 };

  const iPhi = { id: 8, row: 7, address: 0x101cn, block: 3, op: OP.PHI, dst: phiDst, incoming: [{ from: 1, value: c10 }, { from: 2, value: c20 }] };
  const iRet = { id: 9, row: 8, address: 0x1020n, block: 3, op: OP.RET, args: [{ value: phiDst }] };

  c0.def = iConst0; c10.def = iConst10; c20.def = iConst20; flags.def = iCmp; phiDst.def = iPhi;
  a1.uses.push(iCmp); c0.uses.push(iCmp); flags.uses.push(iCbr);
  c10.uses.push(iPhi); c20.uses.push(iPhi); phiDst.uses.push(iRet);

  const blocks = [
    { index: 0, startRow: 0, endRow: 2, succ: [1, 2], pred: [], phis: [], insts: [iConst0, iCmp, iCbr] },
    { index: 1, startRow: 3, endRow: 4, succ: [3], pred: [0], phis: [], insts: [iConst10, iBr1] },
    { index: 2, startRow: 5, endRow: 6, succ: [3], pred: [0], phis: [], insts: [iConst20, iBr2] },
    { index: 3, startRow: 7, endRow: 8, succ: [], pred: [1, 2], phis: [iPhi], insts: [iRet] },
  ];
  const ir = makeIR(blocks, [a1, c0, c10, c20, flags, phiDst], new Map([['x0', a1]]));
  const model = {
    arch: 'arm64',
    name: 'phi_select',
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  // Default mode: branches assign phi_117 and return uses phi_117 (no local_phi_117).
  const sem = decompileSemantic(model, { ir });
  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  closeFunctionOutput(enhanced);
  assert.match(enhanced.pseudocode, /\bphi_117\s*=/);
  assert.match(enhanced.pseudocode, /\breturn\s+phi_117\s*;/);
  assert.doesNotMatch(enhanced.pseudocode, /\blocal_phi_117\b/);
  assertCSyntaxOk(enhanced.pseudocode, 'phi_select default mode');

  // phase8Optimize mode: preserves local_phi_117 naming when buildPhiLowering is skipped.
  const semP8 = decompileSemantic(model, { ir, phase8Optimize: true });
  const enhancedP8 = enhanceSemanticDecompilation(semP8, model, { phase8Optimize: true });
  assert.match(enhancedP8.pseudocode, /\blocal_phi_117\b/);
});

test('2. OP.CALL without inst.dst materializes call_<v.id> assignment and matches pipeline-core references', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const c1 = { id: 2, bits: 64, signed: false, kind: VK.CONST, const: 1n, def: null, uses: [] };
  // Semantic-v2 style: OP.CALL has inst.dst === undefined, while x0 return value v110 has def === iCall.
  const vCallRet = { id: 110, bits: 64, signed: false, kind: VK.UNDEF, unknown: true, reg: 'x0', def: null, uses: [] };
  const vAdd = { id: 111, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };

  const iCall = {
    id: 42, row: 0, address: 0x2000n, block: 0, op: OP.CALL, dst: undefined,
    args: [{ value: a1 }],
    extra: { name: 'strlen', target: 0x500n },
  };
  const iConst1 = { id: 43, row: 1, address: 0x2004n, block: 0, op: OP.CONST, dst: c1, args: [], extra: { value: 1n } };
  const iAdd = { id: 44, row: 2, address: 0x2008n, block: 0, op: OP.BIN, sub: 'add', dst: vAdd, args: [{ value: vCallRet }, { value: c1 }] };
  const iRet = { id: 45, row: 3, address: 0x200cn, block: 0, op: OP.RET, args: [{ value: vAdd }] };

  vCallRet.def = iCall;
  c1.def = iConst1;
  vAdd.def = iAdd;
  a1.uses.push(iCall);
  vCallRet.uses.push(iAdd);
  c1.uses.push(iAdd);
  vAdd.uses.push(iRet);

  const blocks = [
    { index: 0, startRow: 0, endRow: 3, succ: [], pred: [], phis: [], insts: [iCall, iConst1, iAdd, iRet] },
  ];
  const ir = makeIR(blocks, [a1, c1, vCallRet, vAdd], new Map([['x0', a1]]));
  const model = {
    arch: 'arm64',
    name: 'strlen_plus_one',
    calls: [{ row: 0, name: 'strlen', target: 0x500n }],
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  const sem = decompileSemantic(model, { ir });
  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  closeFunctionOutput(enhanced);

  assert.match(enhanced.pseudocode, /\bcall_110\s*=\s*strlen\(/, `expected call_110 = strlen(...):\n${enhanced.pseudocode}`);
  assert.match(enhanced.pseudocode, /\breturn\s+call_110\s*\+\s*1\s*;/, `expected return call_110 + 1:\n${enhanced.pseudocode}`);
  assert.doesNotMatch(enhanced.pseudocode, /\bcall_42\b/, `must not use inst.id call_42:\n${enhanced.pseudocode}`);
  assertCSyntaxOk(enhanced.pseudocode, 'strlen_plus_one');
});

test('3. real ARM64 func_strdup_upper (-O2 -shared -fPIC) materializes strlen/malloc calls and matches phi return', { skip: !HAS_AARCH64_GCC }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-strdup-upper-'));
  const src = path.join(tmp, 'test.c');
  const so = path.join(tmp, 'test.so');
  fs.writeFileSync(src, `
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

char *func_strdup_upper(const char *s) {
  size_t n = strlen(s);
  char *out = (char *)malloc(n + 1);
  if (!out) return NULL;
  memcpy(out, s, n + 1);
  for (size_t i = 0; i < n; i++) {
    out[i] = (char)toupper((unsigned char)out[i]);
  }
  return out;
}
`, 'utf8');
  execFileSync('aarch64-linux-gnu-gcc', ['-O2', '-shared', '-fPIC', '-o', so, src]);
  const product = await openProduct(so);
  try {
    const snap = await product.query.snapshot();
    const page = await product.query.functions(snap, {}, { offset: 0, limit: 1000 });
    const fn = page.value.find((f) => f.name.includes('func_strdup_upper'));
    assert.ok(fn, 'func_strdup_upper not discovered');
    const resp = await product.query.decompile(await product.query.snapshot(), fn.address);
    const code = resp?.value?.pseudocode || '';

    // strlen result is assigned to call_N and used in malloc(call_N + 1)
    const strlenMatch = code.match(/\b(call_\d+)\s*=\s*strlen\(([^\n;]+)\)\s*;/);
    assert.ok(strlenMatch, `expected call_N = strlen(...):\n${code}`);
    const strlenVar = strlenMatch[1];
    assert.equal(strlenMatch[2].split(',').length, 1, `strlen must have 1 argument, got: ${strlenMatch[2]}`);

    const mallocMatch = code.match(new RegExp(`\\b(call_\\d+)\\s*=\\s*malloc\\(${strlenVar}\\s*\\+\\s*1\\)\\s*;`));
    assert.ok(mallocMatch, `expected call_M = malloc(${strlenVar} + 1):\n${code}`);
    const mallocVar = mallocMatch[1];
    assert.match(code, new RegExp(`\\b${mallocVar}\\b.*==\\s*0|\\b0\\s*==\\s*${mallocVar}\\b`), `expected null check on ${mallocVar}:\n${code}`);

    // Return phi variable matches branch assignments and never uses uninitialized local_phi_
    assert.doesNotMatch(code, /\blocal_phi_\d+\b/, `must not emit local_phi_:\n${code}`);
    const retPhiMatch = code.match(/\breturn\s+(phi_\d+)\s*;/);
    assert.ok(retPhiMatch, `expected return phi_K;:\n${code}`);
    const retPhi = retPhiMatch[1];
    assert.match(code, new RegExp(`\\b${retPhi}\\s*=`), `expected branch assignment to ${retPhi}:\n${code}`);

    assertAllGotoTargetsDefined(code, 'func_strdup_upper');
  } finally {
    await product.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('4. shared firstNode anchors and irreducible CFG never emit undefined loc_XXX labels', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const c0 = { id: 2, bits: 64, signed: false, kind: VK.CONST, const: 0n, def: null, uses: [] };
  const c1 = { id: 3, bits: 64, signed: false, kind: VK.CONST, const: 1n, def: null, uses: [] };
  const f0 = { id: 4, bits: 64, signed: false, kind: VK.REG, reg: 'nzcv', def: null, uses: [] };
  const f1 = { id: 5, bits: 64, signed: false, kind: VK.REG, reg: 'nzcv', def: null, uses: [] };
  const f2 = { id: 6, bits: 64, signed: false, kind: VK.REG, reg: 'nzcv', def: null, uses: [] };

  // Irreducible 2-entry loop + shared fallthrough blocks that force goto loc_XXX targets
  // across nested/empty blocks sharing anchors.
  const iConst0 = { id: 1, row: 0, address: 0x7a0n, block: 0, op: OP.CONST, dst: c0, args: [], extra: { value: 0n } };
  const iCmp0 = { id: 2, row: 1, address: 0x7a4n, block: 0, op: OP.CMP, dst: f0, args: [{ value: a1 }, { value: c0 }] };
  const iCbr0 = { id: 3, row: 2, address: 0x7a8n, block: 0, op: OP.CBR, cond: 'eq', args: [{ value: f0 }], trueTarget: 1, falseTarget: 2, extra: { cond: 'eq', target: 0x7b0n, fallthrough: 0x7b8n } };

  // Block 1: empty wrapper branching straight to Block 2 (shares firstNode with Block 2 if inlined)
  const iBr1 = { id: 4, row: 3, address: 0x7b0n, block: 1, op: OP.BR, args: [], target: 2 };

  // Block 2: branches to Block 3 or back to Block 1 (making Block 1 a goto target!)
  const iCmp1 = { id: 5, row: 4, address: 0x7b8n, block: 2, op: OP.CMP, dst: f1, args: [{ value: a1 }, { value: c0 }] };
  const iCbr1 = { id: 6, row: 5, address: 0x7bcn, block: 2, op: OP.CBR, cond: 'ne', args: [{ value: f1 }], trueTarget: 1, falseTarget: 3, extra: { cond: 'ne', target: 0x7b0n, fallthrough: 0x7c0n } };

  // Block 3: branches to Block 2 (making Block 2 a goto target too) or Block 4
  const iConst1 = { id: 7, row: 6, address: 0x7c0n, block: 3, op: OP.CONST, dst: c1, args: [], extra: { value: 1n } };
  const iCmp2 = { id: 8, row: 7, address: 0x7c4n, block: 3, op: OP.CMP, dst: f2, args: [{ value: a1 }, { value: c1 }] };
  const iCbr2 = { id: 9, row: 8, address: 0x7c8n, block: 3, op: OP.CBR, cond: 'eq', args: [{ value: f2 }], trueTarget: 2, falseTarget: 4, extra: { cond: 'eq', target: 0x7b8n, fallthrough: 0x7ccn } };

  // Block 4: return
  const iRet = { id: 10, row: 9, address: 0x7ccn, block: 4, op: OP.RET, args: [{ value: c0 }] };

  c0.def = iConst0; c1.def = iConst1; f0.def = iCmp0; f1.def = iCmp1; f2.def = iCmp2;
  a1.uses.push(iCmp0, iCmp1, iCmp2);
  c0.uses.push(iCmp0, iCmp1, iRet);
  c1.uses.push(iCmp2);
  f0.uses.push(iCbr0); f1.uses.push(iCbr1); f2.uses.push(iCbr2);

  const blocks = [
    { index: 0, startRow: 0, endRow: 2, succ: [1, 2], pred: [], phis: [], insts: [iConst0, iCmp0, iCbr0] },
    { index: 1, startRow: 3, endRow: 3, succ: [2], pred: [0, 2], phis: [], insts: [iBr1] },
    { index: 2, startRow: 4, endRow: 5, succ: [1, 3], pred: [0, 1, 3], phis: [], insts: [iCmp1, iCbr1] },
    { index: 3, startRow: 6, endRow: 8, succ: [2, 4], pred: [2], phis: [], insts: [iConst1, iCmp2, iCbr2] },
    { index: 4, startRow: 9, endRow: 9, succ: [], pred: [3], phis: [], insts: [iRet] },
  ];
  const ir = makeIR(blocks, [a1, c0, c1, f0, f1, f2], new Map([['x0', a1]]));
  const model = {
    arch: 'arm64',
    name: 'irreducible_shared_anchor',
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  const sem = decompileSemantic(model, { ir });
  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  closeFunctionOutput(enhanced);

  assertAllGotoTargetsDefined(enhanced.pseudocode, 'irreducible_shared_anchor');
  assertCSyntaxOk(enhanced.pseudocode, 'irreducible_shared_anchor');
});

test('5. known fixed-arity non-variadic calls like strlen are capped to 1 arg even with oversized override/api metadata', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const a2 = { id: 2, bits: 64, signed: false, kind: VK.ARG, reg: 'x1', def: null, uses: [] };
  const vRet = { id: 3, bits: 64, signed: false, kind: VK.DEF, reg: 'x0', def: null, uses: [] };

  const iCall = {
    id: 1, row: 0, address: 0x3000n, block: 0, op: OP.CALL, dst: vRet,
    args: [{ value: a1 }, { value: a2 }],
    extra: { name: 'strlen', target: 0x600n },
  };
  const iRet = { id: 2, row: 1, address: 0x3004n, block: 0, op: OP.RET, args: [{ value: vRet }] };

  vRet.def = iCall;
  a1.uses.push(iCall);
  a2.uses.push(iCall);
  vRet.uses.push(iRet);

  const blocks = [
    { index: 0, startRow: 0, endRow: 1, succ: [], pred: [], phis: [], insts: [iCall, iRet] },
  ];
  const ir = makeIR(blocks, [a1, a2, vRet], new Map([['x0', a1], ['x1', a2]]));
  const model = {
    arch: 'arm64',
    name: 'strlen_arity_cap',
    calls: [{ row: 0, name: 'strlen', target: 0x600n, api: { args: ['s', 'extra'] } }],
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  // Even when both modelCall.api.args (len 2) and callPrototypeFor override ({ arity: 2 })
  // claim 2 arguments, strlen is capped to its known fixed arity of 1.
  const sem = decompileSemantic(model, {
    ir,
    callPrototypeFor: () => ({ arity: 2 }),
  });
  assert.match(sem.pseudocode, /\bstrlen\([^,)]+\)/, `expected 1-arg strlen:\n${sem.pseudocode}`);
  assert.doesNotMatch(sem.pseudocode, /\bstrlen\([^)]*,/, `strlen must never take 2 args:\n${sem.pseudocode}`);

  // Variadic functions (e.g. printf) are NOT capped below override arity.
  const iPrintf = {
    id: 10, row: 0, address: 0x3100n, block: 0, op: OP.CALL, dst: null,
    args: [{ value: a1 }, { value: a2 }],
    extra: { name: 'printf', target: 0x700n },
  };
  const iRet2 = { id: 11, row: 1, address: 0x3104n, block: 0, op: OP.RET, args: [{ value: a1 }] };
  const irPrintf = makeIR(
    [{ index: 0, startRow: 0, endRow: 1, succ: [], pred: [], phis: [], insts: [iPrintf, iRet2] }],
    [a1, a2],
    new Map([['x0', a1], ['x1', a2]]),
  );
  const modelPrintf = {
    arch: 'arm64',
    name: 'printf_variadic_preserved',
    calls: [{ row: 0, name: 'printf', target: 0x700n }],
    instructions: irPrintf.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };
  const semPrintf = decompileSemantic(modelPrintf, {
    ir: irPrintf,
    callPrototypeFor: () => ({ arity: 2 }),
  });
  assert.match(semPrintf.pseudocode, /\bprintf\([^,)]+,\s*[^,)]+\)/, `variadic printf should keep 2 args from override:\n${semPrintf.pseudocode}`);
});
