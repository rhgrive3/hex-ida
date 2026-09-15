import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = String(line).trim();
    const p = s.indexOf(' ');
    return { row:i, address:BASE + BigInt(i * 4), mn:p < 0 ? s : s.slice(0, p), ops:p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
}
function irOf(lines) {
  const model = modelOf(lines);
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildIR(model, { rowOfAddress, semanticMigrationMode:'legacy-v1' });
}
function loadAt(ir, row) { return ir.instructions.find((i) => i.op === OP.LOAD && i.row === row); }

// Criterion 1: FP-based store must be clobbered by the later SP store to the same slot.
{
  const ir = irOf([
    'mov x29, sp',
    'mov x0, #1',
    'str x0, [x29, #0]',
    'mov x1, #2',
    'str x1, [sp, #0]',
    'ldr x2, [x29, #0]',
    'ret',
  ]);
  assert.equal(loadAt(ir, 5)?.reachingStore?.row, 4, 'FP load must reach the later SP store');
  assert.equal(loadAt(ir, 5)?.dst?.const, 2n, 'x29-based load must see the value 2, not stale 1');
}

// Criterion 1b: reverse direction — FP store clobbers the SP-based slot.
{
  const ir = irOf([
    'mov x29, sp',
    'mov x0, #1',
    'str x0, [sp, #0]',
    'mov x1, #2',
    'str x1, [x29, #0]',
    'ldr x2, [sp, #0]',
    'ret',
  ]);
  assert.equal(loadAt(ir, 5)?.reachingStore?.row, 4, 'SP load must reach the later FP store');
  assert.equal(loadAt(ir, 5)?.dst?.const, 2n);
}

// Criterion 3: the same absolute slot canonicalizes across `sub sp, sp, #N`.
{
  const ir = irOf([
    'mov x29, sp',
    'sub sp, sp, #16',
    'mov x0, #1',
    'str x0, [sp, #8]',
    'mov x1, #2',
    'str x1, [x29, #-8]',
    'ldr x2, [sp, #8]',
    'ret',
  ]);
  assert.equal(loadAt(ir, 6)?.reachingStore?.row, 5, 'adjusted-SP slot equals the FP slot');
  assert.equal(loadAt(ir, 6)?.dst?.const, 2n);
}

// Criterion 4: distinct canonical offsets stay distinct (no over-clobber).
{
  const ir = irOf([
    'mov x29, sp',
    'mov x0, #1',
    'str x0, [x29, #8]',
    'mov x1, #2',
    'str x1, [sp, #16]',
    'ldr x2, [x29, #8]',
    'ret',
  ]);
  assert.equal(loadAt(ir, 5)?.reachingStore?.row, 2, 'distinct slots must keep their own reaching store');
  assert.equal(loadAt(ir, 5)?.dst?.const, 1n);
}

// Criterion 5: unknown stack provenance must not create a false no-alias.
{
  const ir = irOf([
    'mov x29, x0',
    'mov x1, #7',
    'str x1, [x29, #0]',
    'mov x2, #2',
    'str x2, [sp, #0]',
    'ldr x3, [x29, #0]',
    'ret',
  ]);
  const load = loadAt(ir, 5);
  assert.ok(load, 'stack-shaped load exists');
  assert.notEqual(load?.reachingStore?.row, 2, 'unproven FP base must not isolate the slot from the SP store');
  assert.notEqual(load?.dst?.const, 7n, 'stale constant 7 must not propagate through a may-alias SP store');
}

console.log('issue #4272 ARM64 stack SP/FP alias regressions PASS');
