import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decompileSemantic, renderMemoryLocation } from '../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../js/decompiler/pipeline-core.js';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { OP, VK, MK } from '../../js/ir-core.js';
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
const HUMANEVAL_PATH = '/tmp/llm4d/decompile-bench/data/humaneval-decompile.json';
const HAS_HUMANEVAL = fs.existsSync(HUMANEVAL_PATH);

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

function findUninitializedCalls(code) {
  const used = new Set([...code.matchAll(/\b(call_\d+)\b/g)].map((m) => m[1]));
  const assigned = new Set([...code.matchAll(/\b(call_\d+)\s*=/g)].map((m) => m[1]));
  return [...used].filter((name) => !assigned.has(name));
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

test('1. renderMemoryLocation and pipeline-core emit typed derefs for addr.base and mismatched base+index scale (preserving memory_unknown under phase8Optimize)', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const a2 = { id: 2, bits: 64, signed: false, kind: VK.ARG, reg: 'x1', def: null, uses: [] };
  const a3 = { id: 3, bits: 64, signed: false, kind: VK.ARG, reg: 'x2', def: null, uses: [] };
  const vLoad0 = { id: 10, bits: 32, signed: false, kind: VK.REG, reg: 'x3', def: null, uses: [] };
  const vLoadIdx = { id: 11, bits: 32, signed: false, kind: VK.REG, reg: 'x4', def: null, uses: [] };
  const vSum = { id: 12, bits: 32, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };

  // Load *(uint32_t *)(uintptr_t)(a1)
  const iLoad0 = {
    id: 1, row: 0, address: 0x1000n, block: 0, op: OP.LOAD, dst: vLoad0, args: [],
    loc: { kind: MK.UNKNOWN, key: 'unk:1' },
    addr: { base: a1, index: null, scale: 0, disp: 0n, size: 4 },
  };
  // Load *(uint32_t *)((uintptr_t)(a1) + (a2))  (size=4, scale=0 => 1-byte byte offset)
  const iLoadIdx = {
    id: 2, row: 1, address: 0x1004n, block: 0, op: OP.LOAD, dst: vLoadIdx, args: [],
    loc: { kind: MK.UNKNOWN, key: 'unk:2' },
    addr: { base: a1, index: a2, scale: 0, disp: 0n, size: 4 },
  };
  const iAdd = {
    id: 3, row: 2, address: 0x1008n, block: 0, op: OP.BIN, sub: 'add', dst: vSum,
    args: [{ value: vLoad0 }, { value: vLoadIdx }],
  };
  // Store *(uint32_t *)((uintptr_t)(a3) - 4) = vSum
  const iStore = {
    id: 4, row: 3, address: 0x100cn, block: 0, op: OP.STORE, dst: null,
    args: [{ value: vSum }],
    loc: { kind: MK.UNKNOWN, key: 'unk:3' },
    addr: { base: a3, index: null, scale: 0, disp: -4n, size: 4 },
  };
  const iRet = { id: 5, row: 4, address: 0x1010n, block: 0, op: OP.RET, args: [{ value: vSum }] };

  vLoad0.def = iLoad0;
  vLoadIdx.def = iLoadIdx;
  vSum.def = iAdd;
  a1.uses.push(iLoad0, iLoadIdx);
  a2.uses.push(iLoadIdx);
  a3.uses.push(iStore);
  vLoad0.uses.push(iAdd);
  vLoadIdx.uses.push(iAdd);
  vSum.uses.push(iStore, iRet);

  const blocks = [
    { index: 0, startRow: 0, endRow: 4, succ: [], pred: [], phis: [], insts: [iLoad0, iLoadIdx, iAdd, iStore, iRet] },
  ];
  const ir = makeIR(blocks, [a1, a2, a3, vLoad0, vLoadIdx, vSum], new Map([['x0', a1], ['x1', a2], ['x2', a3]]));
  const model = {
    arch: 'arm64',
    name: 'typed_deref_test',
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  // Direct renderMemoryLocation check (default vs phase8Optimize)
  const ctxDefault = { opts: {}, exprCache: new Map(), exprActive: new Set(), exprNodes: 0 };
  assert.equal(renderMemoryLocation(iLoad0.loc, iLoad0, ctxDefault), '*(uint32_t *)(uintptr_t)(a1)');
  assert.equal(renderMemoryLocation(iStore.loc, iStore, ctxDefault), '*(uint32_t *)((uintptr_t)(a3) - 4)');
  assert.equal(renderMemoryLocation(iLoadIdx.loc, iLoadIdx, ctxDefault), '*(uint32_t *)((uintptr_t)(a1) + (a2))');

  const ctxP8 = { opts: { phase8Optimize: true }, exprCache: new Map(), exprActive: new Set(), exprNodes: 0 };
  assert.equal(renderMemoryLocation(iLoad0.loc, iLoad0, ctxP8), 'memory_unknown');

  // Full pipeline check
  const sem = decompileSemantic(model, { ir });
  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  closeFunctionOutput(enhanced);

  assert.doesNotMatch(enhanced.pseudocode, /\bmemory_unknown\b/, `unexpected memory_unknown:\n${enhanced.pseudocode}`);
  assert.match(enhanced.pseudocode, /\*\(uint32_t \*\)\(\(uintptr_t\)\(a3\) - 4\)\s*=/, `expected negative disp store:\n${enhanced.pseudocode}`);
  assert.match(enhanced.pseudocode, /\*\(uint32_t \*\)\(uintptr_t\)\(a1\)/, `expected zero disp load:\n${enhanced.pseudocode}`);
  assert.match(enhanced.pseudocode, /\*\(uint32_t \*\)\(\(uintptr_t\)\(a1\) \+ \(a2\)\)/, `expected byte-offset indexed load:\n${enhanced.pseudocode}`);
  assertCSyntaxOk(enhanced.pseudocode, 'typed_deref_test');
});

test('2. secondary OP.CALL return-register aliases unify to canonical call_<id> and clobbered non-return regs do not emit uninit call_XXX', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const a2 = { id: 2, bits: 64, signed: false, kind: VK.ARG, reg: 'x1', def: null, uses: [] };
  // Canonical x0 (64-bit) + secondary x0 (32-bit, e.g. w0 view) + clobbered x4
  const vCallX0 = { id: 280, bits: 64, signed: false, kind: VK.UNDEF, unknown: true, reg: 'x0', def: null, uses: [] };
  const vCallW0 = { id: 337, bits: 32, signed: false, kind: VK.UNDEF, unknown: true, reg: 'x0', def: null, uses: [] };
  const vClobX4 = { id: 285, bits: 64, signed: false, kind: VK.UNDEF, unknown: true, reg: 'x4', def: null, uses: [] };
  const vSum = { id: 340, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };
  const vSum2 = { id: 341, bits: 64, signed: false, kind: VK.REG, reg: 'x0', def: null, uses: [] };

  const iCall = {
    id: 71, row: 0, address: 0x2000n, block: 0, op: OP.CALL, dst: undefined,
    args: [{ value: a1 }],
    extra: { name: 'strlen', target: 0x500n },
  };
  const iAdd1 = {
    id: 72, row: 1, address: 0x2004n, block: 0, op: OP.BIN, sub: 'add', dst: vSum,
    args: [{ value: vCallX0 }, { value: vCallW0 }],
  };
  const iAdd2 = {
    id: 73, row: 2, address: 0x2008n, block: 0, op: OP.BIN, sub: 'add', dst: vSum2,
    args: [{ value: vSum }, { value: vClobX4 }],
  };
  const iStore = {
    id: 74, row: 3, address: 0x200cn, block: 0, op: OP.STORE, dst: null,
    args: [{ value: vCallW0 }],
    loc: { kind: MK.UNKNOWN, key: 'unk:store' },
    addr: { base: a2, index: null, scale: 0, disp: 0n, size: 4 },
  };
  const iRet = { id: 75, row: 4, address: 0x2010n, block: 0, op: OP.RET, args: [{ value: vSum2 }] };

  vCallX0.def = iCall;
  vCallW0.def = iCall;
  vClobX4.def = iCall;
  vSum.def = iAdd1;
  vSum2.def = iAdd2;
  a1.uses.push(iCall);
  a2.uses.push(iStore);
  vCallX0.uses.push(iAdd1);
  vCallW0.uses.push(iAdd1, iStore);
  vClobX4.uses.push(iAdd2);
  vSum.uses.push(iAdd2);
  vSum2.uses.push(iRet);

  const blocks = [
    { index: 0, startRow: 0, endRow: 4, succ: [], pred: [], phis: [], insts: [iCall, iAdd1, iAdd2, iStore, iRet] },
  ];
  const ir = makeIR(blocks, [a1, a2, vCallX0, vCallW0, vClobX4, vSum, vSum2], new Map([['x0', a1], ['x1', a2]]));
  const model = {
    arch: 'arm64',
    name: 'call_alias_test',
    calls: [{ row: 0, name: 'strlen', target: 0x500n }],
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  const sem = decompileSemantic(model, { ir });
  const enhanced = enhanceSemanticDecompilation(sem, model, {});
  closeFunctionOutput(enhanced);

  assert.match(enhanced.pseudocode, /\bcall_280\s*=\s*strlen\(/, `expected call_280 = strlen(...):\n${enhanced.pseudocode}`);
  assert.doesNotMatch(enhanced.pseudocode, /\bcall_337\b/, `secondary x0/w0 alias call_337 must unify to call_280:\n${enhanced.pseudocode}`);
  assert.doesNotMatch(enhanced.pseudocode, /\bcall_285\b/, `clobbered x4 call_285 must not be emitted:\n${enhanced.pseudocode}`);
  assert.deepEqual(findUninitializedCalls(enhanced.pseudocode), [], `uninit calls found:\n${enhanced.pseudocode}`);
  assertCSyntaxOk(enhanced.pseudocode, 'call_alias_test');
});

for (const idx of [678, 694, 702, 766]) {
  test(`3. HumanEval-Decompile idx ${idx} (ARM64) has zero memory_unknown and zero uninitialized call_XXX`, {
    skip: !HAS_AARCH64_GCC || !HAS_HUMANEVAL,
  }, async () => {
    const data = JSON.parse(fs.readFileSync(HUMANEVAL_PATH, 'utf8'));
    const item = data[idx];
    assert.ok(item, `idx ${idx} not found in humaneval-decompile.json`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hex-he-${idx}-`));
    const src = path.join(tmp, 'test.c');
    const so = path.join(tmp, 'test.so');
    fs.writeFileSync(src, `${item.func_dep || ''}\n${item.func}\n`, 'utf8');
    execFileSync('aarch64-linux-gnu-gcc', [`-${item.opt || 'O2'}`, '-shared', '-fPIC', '-w', '-o', so, src, '-lm']);

    const product = await openProduct(so);
    try {
      const snap = await product.query.snapshot();
      const page = await product.query.functions(snap, {}, { offset: 0, limit: 1000 });
      const fn = page.value.find((f) => f.name === item.func_name || f.name.includes(item.func_name));
      assert.ok(fn, `function ${item.func_name} not found for idx ${idx}`);
      const resp = await product.query.decompile(await product.query.snapshot(), fn.address);
      const code = resp?.value?.pseudocode || '';
      assert.ok(code.length > 0, `empty pseudocode for idx ${idx}`);

      assert.doesNotMatch(code, /\bmemory_unknown\b/, `idx ${idx}: unexpected memory_unknown:\n${code}`);
      assert.deepEqual(findUninitializedCalls(code), [], `idx ${idx}: uninitialized call_XXX found:\n${code}`);
      if (idx === 694) {
        assert.doesNotMatch(code, /\bmemory\[/, `idx 694: unexpected raw memory[...] fallback:\n${code}`);
      }
      assertCSyntaxOk(code, `HumanEval idx ${idx}`);
    } finally {
      await product.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
