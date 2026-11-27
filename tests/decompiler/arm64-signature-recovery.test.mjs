import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OP } from '../../js/ir.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { abiAdapterForIr, buildIR } from '../../js/ir-core.js';
import { inferSemanticTypes, semanticSignature } from '../../js/decompiler/type-recovery.js';
import { openProduct } from '../../tools/validation/public-benchmark/product-host.mjs';

function hasAArch64Gcc() {
  try {
    execFileSync('aarch64-linux-gnu-gcc', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function parseSignature(sigLine) {
  assert.equal(typeof sigLine, 'string', `expected signature string, got ${sigLine}`);
  const m = /^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)$/.exec(sigLine.trim());
  assert.ok(m, `could not parse signature: ${sigLine}`);
  const retType = m[1].trim();
  const name = m[2].trim();
  const rawParams = m[3].trim();
  const params = rawParams === '' || rawParams === 'void'
    ? []
    : rawParams.split(',').map((p) => p.trim()).filter(Boolean);
  return { retType, name, params };
}

test('1. real ARM64 -O2 ELF: recovers parameter counts and non-void return types', { skip: !hasAArch64Gcc() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm64-sig-recovery-'));
  const cPath = path.join(dir, 'sig_cases.c');
  const soPath = path.join(dir, 'sig_cases.so');
  fs.writeFileSync(cPath, `
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

char *func_strdup_upper(const char *s) {
  size_t n = strlen(s);
  char *out = (char *)malloc(n + 1);
  if (!out) return NULL;
  for (size_t i = 0; i < n; i++) out[i] = (char)toupper((unsigned char)s[i]);
  out[n] = 0;
  return out;
}

int func_skip_arg(int unused, int b) {
  return b * 3 + 1;
}

int func_passthru(const void *a, const void *b, size_t n) {
  return memcmp(a, b, n) == 0 ? 1 : 0;
}

int func_tail_passthru(const void *a, const void *b, size_t n) {
  return memcmp(a, b, n);
}

size_t func_tail_strlen(const char *s) {
  return strlen(s);
}
`);

  execFileSync('aarch64-linux-gnu-gcc', ['-O2', '-shared', '-fPIC', '-o', soPath, cPath]);
  const product = await openProduct(soPath);
  try {
    const snap = await product.query.snapshot();
    const page = await product.query.functions(snap, {}, { offset: 0, limit: 1000 });
    const expectations = [
      { name: 'func_strdup_upper', minParams: 1, maxParams: 1 },
      { name: 'func_skip_arg', minParams: 2, maxParams: 2 },
      { name: 'func_passthru', minParams: 3, maxParams: 3 },
      { name: 'func_tail_passthru', minParams: 3, maxParams: 3 },
      { name: 'func_tail_strlen', minParams: 1, maxParams: 1 },
    ];
    for (const exp of expectations) {
      const fn = page.value.find((f) => f.name === exp.name);
      assert.ok(fn, `compiled function ${exp.name} not found in ELF`);
      const resp = await product.query.decompile(await product.query.snapshot(), fn.address);
      const sigLine = (resp?.value?.lines || []).find((l) => l.kind === 'sig')?.text;
      const parsed = parseSignature(sigLine);
      assert.equal(parsed.name, exp.name);
      assert.notEqual(parsed.retType, 'void', `${exp.name} must have non-void return type (got: ${sigLine})`);
      assert.ok(
        parsed.params.length >= exp.minParams && parsed.params.length <= exp.maxParams,
        `${exp.name} expected ${exp.minParams}..${exp.maxParams} params, got ${parsed.params.length} (${sigLine})`,
      );
    }
  } finally {
    await product.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('2. abiAdapterForIr WeakMap: recovers ABI when opts.abiAdapter is null, respects explicit unsupported adapter', () => {
  // Minimal ARM64 function model: add w0, w1, #1 ; ret (skipping x0, using x1)
  const base = 0x10000n;
  const rows = [
    { row: 0, address: base, mn: 'add', ops: 'w0, w1, #0x1' },
    { row: 1, address: base + 4n, mn: 'ret', ops: '' },
  ];
  const model = buildSemanticModel(rows, {
    startRow: 0,
    endRow: 1,
    rowOfAddress: (addr) => {
      const d = BigInt(addr) - base;
      return d >= 0n && d < 8n && d % 4n === 0n ? Number(d / 4n) : null;
    },
    addrOfRow: (row) => rows[row]?.address ?? null,
    symbolFor: () => null,
  });
  const ir = buildIR(model);
  assert.ok(ir, 'buildIR returned null');
  assert.equal(ir.compat?.projection, 'semantic-ir-v2-to-v1');
  assert.equal(Object.hasOwn(ir, 'abiAdapter'), false, 'must not mutate public ir object with abiAdapter property');

  const adapter = abiAdapterForIr(ir);
  assert.ok(adapter && adapter.supported === true, 'abiAdapterForIr should expose canonical AAPCS64 adapter');

  // Default null abiAdapter (as passed by semantic-core.js) falls back to abiAdapterForIr(ir)
  const recovered = inferSemanticTypes(ir, model, { abiAdapter: null });
  assert.equal(recovered.args.length, 2, `expected 2 args (x0 gap-filled, x1 used), got ${JSON.stringify(recovered.args.map((a) => a.reg))}`);
  assert.equal(recovered.args[0].reg, 'x0');
  assert.equal(recovered.args[0].index, 0);
  assert.equal(recovered.args[1].reg, 'x1');
  assert.equal(recovered.args[1].index, 1);
  assert.notEqual(recovered.ret.type, 'void');

  // Explicit unsupported adapter must NOT be overridden by abiAdapterForIr(ir)
  const unsupported = inferSemanticTypes(ir, model, { abiAdapter: { supported: false } });
  assert.equal(unsupported.args.length, 0, 'explicit supported:false abiAdapter must be respected');
});

test('3. type-recovery: FP positional gaps, incoming x0 return, tail-call return, and FP-over-helper-call return', () => {
  // 3a. FP positional gap: d1 used, d0 unused -> fills d0 before d1
  const d1 = { id: 1, reg: 'd1', bits: 64, uses: [] };
  const faddDst = { id: 2, reg: 'd0', bits: 64, uses: [] };
  const fadd = { id: 'i_fadd', row: 1, block: 0, op: OP.BIN, sub: 'fadd', dst: faddDst, args: [{ value: d1 }, { value: d1 }] };
  faddDst.def = fadd;
  d1.uses.push(fadd);
  const retFp = { id: 'i_ret_fp', row: 2, block: 0, op: OP.RET, args: [] };
  const irFpGap = {
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [d1, faddDst],
    args: new Map([['d1', d1]]),
    instructions: [fadd, retFp],
  };
  const recFpGap = inferSemanticTypes(irFpGap, {});
  assert.equal(recFpGap.args.length, 2, 'FP positional gap d0 must be filled when d1 is used');
  assert.equal(recFpGap.args[0].reg, 'd0');
  assert.equal(recFpGap.args[1].reg, 'd1');
  assert.equal(recFpGap.ret.type, 'double');

  // 3b. Stale helper call (malloc -> x0) before FP computation (fmul -> d0) -> prefers double return
  const nArg = { id: 10, reg: 'x0', bits: 64, uses: [] };
  const scaleArg = { id: 11, reg: 'd0', bits: 64, uses: [] };
  const mallocDst = { id: 12, reg: 'x0', bits: 64, uses: [] };
  const fmulDst = { id: 13, reg: 'd0', bits: 64, uses: [] };
  const callMalloc = { id: 'c_malloc', row: 1, block: 0, op: OP.CALL, dst: mallocDst, extra: { name: 'malloc' }, args: [{ value: nArg }] };
  mallocDst.def = callMalloc;
  nArg.uses.push(callMalloc);
  const fmul = { id: 'i_fmul', row: 2, block: 0, op: OP.BIN, sub: 'fmul', dst: fmulDst, args: [{ value: scaleArg }, { value: scaleArg }] };
  fmulDst.def = fmul;
  scaleArg.uses.push(fmul);
  const retAfterHelper = { id: 'i_ret_h', row: 3, block: 0, op: OP.RET, args: [{ value: mallocDst }] };
  const irHelperFp = {
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [nArg, scaleArg, mallocDst, fmulDst],
    args: new Map([['x0', nArg], ['d0', scaleArg]]),
    instructions: [callMalloc, fmul, retAfterHelper],
  };
  const recHelperFp = inferSemanticTypes(irHelperFp, {});
  assert.equal(recHelperFp.ret.type, 'double', 'latest d0 definition must win over stale malloc x0');

  // 3c. Tail-call return inference (no OP.RET): b strlen -> uint64, b free -> void
  const tailStrlen = { id: 't_strlen', row: 0, block: 0, op: OP.BR, extra: { name: 'strlen' }, args: [] };
  const recTailStrlen = inferSemanticTypes({
    blocks: [{ id: 0, index: 0, succ: [], insts: [tailStrlen] }],
    idom: [-1],
    values: [],
    args: new Map(),
    instructions: [tailStrlen],
  }, {});
  assert.equal(recTailStrlen.args.length, 1);
  assert.equal(recTailStrlen.ret.type, 'uint64');
  assert.equal(semanticSignature('tail_strlen', recTailStrlen), 'uint64 tail_strlen(void * a1)');

  const tailFree = { id: 't_free', row: 0, block: 0, op: OP.BR, extra: { name: 'free' }, args: [] };
  const recTailFree = inferSemanticTypes({
    blocks: [{ id: 0, index: 0, succ: [], insts: [tailFree] }],
    idom: [-1],
    values: [],
    args: new Map(),
    instructions: [tailFree],
  }, {});
  assert.equal(recTailFree.args.length, 1);
  assert.equal(recTailFree.ret.type, 'void');

  // 3d. Incoming x0 returned unmodified after being read
  const inX0 = { id: 30, reg: 'x0', bits: 64, uses: [] };
  const cmp = { id: 'i_cmp', row: 1, block: 0, op: OP.CMP, sub: 'cmp', args: [{ value: inX0 }] };
  inX0.uses.push(cmp);
  const retIn = { id: 'i_ret_in', row: 2, block: 0, op: OP.RET, args: [] };
  const recInRet = inferSemanticTypes({
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [inX0],
    args: new Map([['x0', inX0]]),
    instructions: [cmp, retIn],
  }, {});
  assert.notEqual(recInRet.ret.type, 'void', 'incoming x0 read and returned unmodified must not be void');
});
