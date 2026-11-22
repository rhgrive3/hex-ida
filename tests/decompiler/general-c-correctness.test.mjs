import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { decompileSemantic } from '../../js/decompiler/semantic.js';
import { closeFunctionOutput, declarationBearingSource, scanIdentifierUses } from '../../js/decompiler/c-output-closure.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { openProduct } from '../../tools/validation/public-benchmark/product-host.mjs';

function findCCompiler() {
  for (const cc of ['gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
}

const CC = findCCompiler();

function cSyntaxOk(code) {
  if (!CC) return { skipped: true, ok: true, stderr: '' };
  try {
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-'], { input: code, stdio: ['pipe', 'pipe', 'pipe'] });
    return { skipped: false, ok: true, stderr: '' };
  } catch (err) {
    return { skipped: false, ok: false, stderr: String(err.stderr || err.message || '') };
  }
}

test('declarationBearingSource strips numeric/hex/binary literals so 0xFFFFFFF8 never emits uint64 xFFFFFFF8', () => {
  const src = 'x8 = x9 & 0xFFFFFFF8;\nx1 = 0b1010ULL + 1.5e-3f;\nx2 = 0x1e+x3;\n';
  const stripped = declarationBearingSource(src);
  const uses = scanIdentifierUses(src);
  assert.equal(uses.has('xFFFFFFF8'), false);
  assert.equal(uses.has('b1010ULL'), false);
  assert.equal(uses.has('x3'), true);
  assert.equal(stripped.split('\n').length, src.split('\n').length);

  const result = {
    lines: [
      { kind: 'sig', indent: 0, text: 'uint64 fn(uint64 x9)' },
      { kind: 'ctrl', indent: 0, text: '{' },
      { kind: 'stmt', indent: 1, text: 'x8 = x9 & 0xFFFFFFF8;' },
      { kind: 'stmt', indent: 1, text: 'return x8;' },
      { kind: 'ctrl', indent: 0, text: '}' },
    ],
  };
  result.pseudocode = result.lines.map(l => l.text).join('\n');
  closeFunctionOutput(result);
  assert.doesNotMatch(result.pseudocode, /uint64 xFFFFFFF8;/);
  assert.match(result.pseudocode, /uint64 x8;/);
  const chk = cSyntaxOk(result.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('pretty/c printExpression casts non-pointer index bases via uintptr_t instead of subscripting scalars', () => {
  const idx = expr.index(
    expr.binary('add', expr.variable('base', 64), expr.constant(16n, 64), 64),
    expr.variable('i', 64),
    4,
    32,
  );
  const text = printExpression(idx);
  assert.match(text, /\(\(uint32_t \*\)\(uintptr_t\)\(base \+ 16\)\)\[i\]/);

  const constIdx = expr.index(expr.constant(0x2C50n, 64), expr.variable('i', 64), 4, 32);
  const constText = printExpression(constIdx);
  assert.match(constText, /\(\(uint32_t \*\)\(uintptr_t\)\(0x2C50\)\)\[i\]/);

  const ptrIdx = printExpression(
    expr.index(expr.variable('arr', 64), expr.variable('i', 64), 4, 32),
    0,
    { indexBaseIsPointer: true },
  );
  assert.equal(ptrIdx, 'arr[i]');
});

test('emitRegion emits cfg-label for every revisit-goto target and handles empty blocks', () => {
  const ir = {
    entry: 0,
    blocks: [
      {
        index: 0, startRow: 0, endRow: 1, succ: [1, 2], pred: [],
        insts: [
          { id: 'i0', row: 0, address: 0x100n, op: 'const', dst: { id: 'v0', reg: 'x0', bits: 64 }, value: 1n, args: [] },
          { id: 'i1', row: 1, address: 0x104n, op: 'cbr', cond: { id: 'v0', reg: 'x0', bits: 64 }, args: [{ value: { id: 'v0', reg: 'x0', bits: 64 } }], trueTarget: 1, falseTarget: 2 },
        ],
      },
      {
        index: 1, startRow: 2, endRow: 2, succ: [3], pred: [0],
        insts: [
          { id: 'i2', row: 2, address: 0x108n, op: 'br', args: [], target: 3 },
        ],
      },
      {
        index: 2, startRow: 3, endRow: 3, succ: [3], pred: [0],
        insts: [
          { id: 'i3', row: 3, address: 0x10Cn, op: 'br', args: [], target: 3 },
        ],
      },
      {
        index: 3, startRow: 4, endRow: 4, succ: [], pred: [1, 2],
        insts: [
          { id: 'i4', row: 4, address: 0x110n, op: 'ret', args: [{ value: { id: 'v0', reg: 'x0', bits: 64 } }] },
        ],
      },
    ],
    values: [{ id: 'v0', reg: 'x0', bits: 64, const: 1n }],
    instructions: [],
  };
  ir.instructions = ir.blocks.flatMap(b => b.insts);
  const model = {
    arch: 'arm64',
    instructions: ir.instructions.map(i => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };
  const res = decompileSemantic(model, { ir });
  closeFunctionOutput(res);
  const gotos = [...res.pseudocode.matchAll(/\bgoto\s+(loc_[0-9A-Za-z_]+)\s*;/g)].map(m => m[1]);
  for (const label of gotos) {
    assert.match(res.pseudocode, new RegExp(`\\b${label}:`));
  }
  const chk = cSyntaxOk(res.pseudocode);
  assert.equal(chk.ok, true, chk.stderr);
});

test('real ARM64 binaries satisfy C-syntax invariants (no dangling/duplicate labels, no .2d/?=/xFFFFFFF8, no scalar subscripts)', async () => {
  const manifestPath = path.resolve('benchmarks/public/codefuse-arm64/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const checks = [
    ['1/1_clang_O0_g', 'call_weak_fn'],
    ['2/2_clang_O0_g', 'array_3d'],
    ['2/2_clang_O0_g', 'array_complex_index'],
    ['2/2_clang_O2_g', 'struct_array'],
    ['3/3_clang_O2_g', 'linked_list_heap'],
  ];
  const byCase = new Map();
  for (const [cid, fnName] of checks) {
    if (!byCase.has(cid)) byCase.set(cid, []);
    byCase.get(cid).push(fnName);
  }
  for (const [caseId, fnNames] of byCase) {
    const entry = manifest.cases.find(c => c.id === caseId);
    const product = await openProduct(path.resolve('benchmarks/public/codefuse-arm64', entry.binary));
    try {
      const snap = await product.query.snapshot();
      const page = await product.query.functions(snap, {}, { offset: 0, limit: 1000 });
      for (const fnName of fnNames) {
        const fn = page.value.find(f => f.name === fnName);
        assert.ok(fn, `Missing ${caseId}::${fnName}`);
        const resp = await product.query.decompile(await product.query.snapshot(), fn.address);
        const code = resp?.value?.pseudocode ?? '';
        assert.doesNotMatch(code, /\bv\d+\.2d\b/, `${caseId}::${fnName}`);
        assert.doesNotMatch(code, /\?\s*=/, `${caseId}::${fnName}`);
        assert.doesNotMatch(code, /uint64 xFFFFFFF8;/, `${caseId}::${fnName}`);
        const gotos = [...code.matchAll(/\bgoto\s+(loc_[0-9A-Za-z_]+)\s*;/g)].map(m => m[1]);
        for (const label of gotos) {
          assert.match(code, new RegExp(`\\b${label}:`), `${caseId}::${fnName} missing ${label}`);
        }
        if (fnName === 'call_weak_fn') {
          const labels = code.match(/\bloc_[0-9A-Fa-f]+:/g) || [];
          assert.equal(new Set(labels).size, labels.length, `duplicate label in ${caseId}::${fnName}`);
          const chk = cSyntaxOk(code);
          assert.equal(chk.ok, true, `${caseId}::${fnName} failed C syntax:\n${chk.stderr}`);
        } else {
          const chk = cSyntaxOk(code);
          assert.equal(chk.ok, true, `${caseId}::${fnName} failed C syntax:\n${chk.stderr}`);
        }
      }
    } finally {
      await product.close();
    }
  }
});
