import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../../js/blocks.js';
import { irFor } from '../../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

/* AAPCS64 SIMD and Floating-Point Registers: v8-v15 are callee-saved only in
 * their bottom 64 bits; the upper 64 bits of any 128-bit value held there are
 * caller-saved. The compat v1 IR models one location per SIMD register, so a
 * 128-bit v8-v15 definition must not flow across a CALL as the same SSA
 * definition, while a proven ≤64-bit (low-half) definition still survives. */

const BASE = 0x100000000n;

function irOf(lines, revision) {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return { row, address: BASE + BigInt(row * 4), mn: line.slice(0, split), ops: line.slice(split + 1) };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  return irFor(model, { rowOfAddress, cacheRevision: revision });
}

const argOf = (inst, reg) => (inst?.args || []).find((a) => a.value?.reg === reg)?.value ?? null;

test('#4979: a 128-bit v8 definition does not survive a CALL boundary', () => {
  const ir = irOf([
    'ldr q8, [x0]',
    'str q8, [x1]',
    'bl #0x100000100',
    'str q8, [x2]',
    'ret',
  ], 'issue-4979-wide');
  const def = ir.instructions.find((i) => i.row === 0)?.dst;
  assert.ok(def, 'the q8 load must define v8');
  assert.equal(def.bits, 128);
  const preCall = ir.instructions.find((i) => i.row === 1);
  assert.equal(argOf(preCall, 'v8')?.id, def.id, 'the pre-call use still reaches the 128-bit definition');
  const postCall = ir.instructions.find((i) => i.row === 3);
  const postValue = argOf(postCall, 'v8');
  assert.ok(postValue, 'the post-call use resolves to a v8 value');
  assert.notEqual(postValue.id, def.id, 'the pre-call 128-bit definition must not flow through the call');
  assert.equal(postValue.clobbered, true, 'the post-call value is the call clobber');
});

test('#4979: a proven 64-bit low-half d8 definition still survives a CALL boundary', () => {
  const ir = irOf([
    'fmov d8, d0',
    'str d8, [x1]',
    'bl #0x100000100',
    'str d8, [x2]',
    'ret',
  ], 'issue-4979-narrow');
  const def = ir.instructions.find((i) => i.row === 0)?.dst;
  assert.ok(def, 'the d8 fmov must define v8');
  assert.equal(def.bits, 64);
  const preCall = ir.instructions.find((i) => i.row === 1);
  assert.equal(argOf(preCall, 'v8')?.id, def.id);
  const postCall = ir.instructions.find((i) => i.row === 3);
  assert.equal(argOf(postCall, 'v8')?.id, def.id, 'the callee-saved low half keeps its definition across the call');
});
