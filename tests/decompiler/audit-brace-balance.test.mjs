import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { decompileSemantic, readSemanticControlLineHistory } from '../../js/decompiler/semantic.js';
import { enhanceSemanticDecompilation } from '../../js/decompiler/pipeline.js';
import { closePublicCOutputForTesting } from '../../js/decompile-base.js';
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

function measureBraceBalance(code) {
  let depth = 0;
  let minDepth = 0;
  let opens = 0;
  let closes = 0;
  for (const ch of code) {
    if (ch === '{') {
      depth += 1;
      opens += 1;
    } else if (ch === '}') {
      depth -= 1;
      closes += 1;
      if (depth < minDepth) minDepth = depth;
    }
  }
  return { depth, minDepth, opens, closes };
}

test('revisit-goto carries originating branch provenance so Phase 8 control projection does not re-emit target conditional braces', () => {
  const v0 = { id: 'v0', reg: 'x0', bits: 64 };
  const v1 = { id: 'v1', reg: 'x1', bits: 64 };
  const ir = {
    entry: 0,
    blocks: [
      {
        index: 0, startRow: 0, endRow: 0, succ: [1], pred: [],
        insts: [
          { id: 'i0', block: 0, row: 0, address: 0x100n, op: 'br', args: [], target: 1 },
        ],
      },
      {
        index: 1, startRow: 1, endRow: 1, succ: [2, 3], pred: [0, 3],
        insts: [
          {
            id: 'i1', block: 1, row: 1, address: 0x104n, op: 'cbr',
            cond: v0, args: [{ value: v0 }], trueTarget: 2, falseTarget: 3,
            extra: { targetBlock: 2 },
          },
        ],
      },
      {
        index: 2, startRow: 2, endRow: 2, succ: [3], pred: [1],
        insts: [
          { id: 'i2', block: 2, row: 2, address: 0x108n, op: 'br', args: [], target: 3 },
        ],
      },
      {
        index: 3, startRow: 3, endRow: 3, succ: [1, 4], pred: [1, 2],
        insts: [
          {
            id: 'i3', block: 3, row: 3, address: 0x10Cn, op: 'cbr',
            cond: v1, args: [{ value: v1 }], trueTarget: 1, falseTarget: 4,
            extra: { targetBlock: 1 },
          },
        ],
      },
      {
        index: 4, startRow: 4, endRow: 4, succ: [], pred: [3],
        insts: [
          { id: 'i4', block: 4, row: 4, address: 0x110n, op: 'ret', args: [{ value: v0 }] },
        ],
      },
    ],
    values: [v0, v1],
    instructions: [],
  };
  ir.instructions = ir.blocks.flatMap((b) => b.insts);
  const model = {
    arch: 'arm64',
    instructions: ir.instructions.map((i) => ({
      row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [],
    })),
  };
  const opts = { ir, functionName: 'revisit_loop_cond', arch: 'arm64' };
  const sem = decompileSemantic(model, opts);
  assert.ok(sem, 'decompileSemantic should succeed');

  const gotoLine = sem.lines.find((l) => /^goto\s+loc_104;$/i.test(l.text || ''));
  assert.ok(gotoLine, 'expected revisit-goto back to loop header loc_104');
  const ctrlHistory = readSemanticControlLineHistory(gotoLine, sem.ir);
  assert.equal(ctrlHistory?.instruction?.block, 3,
    'revisit-goto must be attributed to originating latch block (3), not target header block (1)');

  const enhanced = enhanceSemanticDecompilation(sem, model, { ...opts, renderProvenance: true });
  const closed = closePublicCOutputForTesting(enhanced, opts);
  const code = closed.pseudocode ?? '';
  const balance = measureBraceBalance(code);
  assert.equal(balance.depth, 0, `unbalanced braces:\n${code}`);
  assert.equal(balance.minDepth, 0, `stray closing brace:\n${code}`);
  const chk = cSyntaxOk(code);
  assert.equal(chk.ok, true, `failed C syntax:\n${chk.stderr}\n${code}`);
});

test('2/2_clang_O2_g::pointer_array has balanced braces and passes C syntax check', async () => {
  const manifestPath = path.resolve('benchmarks/public/codefuse-arm64/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest.cases.find((c) => c.id === '2/2_clang_O2_g');
  assert.ok(entry, 'missing 2/2_clang_O2_g manifest entry');

  const product = await openProduct(path.resolve('benchmarks/public/codefuse-arm64', entry.binary));
  try {
    const snap = await product.query.snapshot();
    const page = await product.query.functions(snap, {}, { offset: 0, limit: 1000 });
    const fn = page.value.find((f) => f.name === 'pointer_array');
    assert.ok(fn, 'missing pointer_array function');

    const resp = await product.query.decompile(await product.query.snapshot(), fn.address);
    const code = resp?.value?.pseudocode ?? '';
    const balance = measureBraceBalance(code);
    assert.equal(balance.depth, 0, `unbalanced braces in pointer_array:\n${code}`);
    assert.equal(balance.minDepth, 0, `extra closing brace in pointer_array:\n${code}`);
    assert.ok(balance.opens > 0, 'expected function body braces');
    assert.doesNotMatch(code, /if\s*\(!\(!\(load_7 == 0\)\)\)/,
      'already-structured inner conditional should not be re-emitted with double negation');

    const chk = cSyntaxOk(code);
    assert.equal(chk.ok, true, `pointer_array failed C syntax:\n${chk.stderr}\n${code}`);
  } finally {
    await product.close();
  }
});
