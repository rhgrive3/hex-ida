import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';

const BASE = 0x100000n;

function flows(lines) {
  const raw = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  return buildSemanticModel(raw, {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress: () => null,
  }).flows;
}

function reload(flowsResult, row) {
  return flowsResult.find((f) => f.row === row && f.kind === 'stack->reg') || null;
}

function save(flowsResult, row) {
  return flowsResult.find((f) => f.row === row && f.kind === 'reg->mem') || null;
}

// Acceptance 1: pre-index save then offset-0 reload is the same slot.
{
  const f = flows([
    'str x0, [sp, #-16]!',
    'ldr x1, [sp]',
  ]);
  const s = save(f, 0);
  assert.ok(s && s.to === 'sp+-16', `pre-index save slot: ${s && s.to}`);
  const r = reload(f, 1);
  assert.ok(r, 'post-writeback [sp] reload must link to the saved stack slot');
  assert.equal(r.from, 'sp+-16');
}

// Acceptance 2: post-index access is recorded as an offset-0 stack slot and
// later SP-relative accesses resolve against the moved frame coordinate.
{
  const f = flows([
    'str x0, [sp], #16',
    'ldr x1, [sp, #-16]',
  ]);
  const s = save(f, 0);
  assert.ok(s && s.to === 'sp+0', `post-index save slot: ${s && s.to}`);
  const r = reload(f, 1);
  assert.ok(r, 'access after post-index writeback must reconcile to the same slot');
  assert.equal(r.from, 'sp+0');
}

// Acceptance 3: coordinate conversion keeps distinct physical locations distinct.
{
  const f = flows([
    'str x0, [sp, #-16]!',
    'str x1, [sp, #8]',
    'ldr x2, [sp, #8]',
    'ldr x3, [sp]',
  ]);
  assert.equal(save(f, 0).to, 'sp+-16');
  assert.equal(save(f, 1).to, 'sp+-8');
  const r2 = reload(f, 2);
  assert.ok(r2 && r2.from === 'sp+-8', 'x1 save must reload at the same physical address');
  const r3 = reload(f, 3);
  assert.ok(r3 && r3.from === 'sp+-16', 'x0 save must reload at the same physical address');
}

// Acceptance 4: offset-only accesses keep their established slot keys.
{
  const f = flows([
    'mov x0, #1',
    'str x0, [sp, #-8]',
    'ldr x1, [sp, #-8]',
  ]);
  assert.equal(save(f, 1).to, 'sp+-8');
  const r = reload(f, 2);
  assert.ok(r && r.from === 'sp+-8');
}

// Acceptance 5: frame-pointer-relative accesses never merge with SP slots.
{
  const f = flows([
    'str x0, [sp, #-16]!',
    'ldr x1, [x29, #-16]',
  ]);
  const r = reload(f, 1);
  assert.ok(!r || !String(r.from).startsWith('sp'), 'FP-relative load must not consume an SP slot');
}

// Acceptance 6: the writeback applies after the access, not before it.
{
  const f = flows([
    'str x0, [sp, #32]',
    'str x1, [sp], #16',
    'ldr x2, [sp, #16]',
  ]);
  assert.equal(save(f, 0).to, 'sp+32');
  assert.equal(save(f, 1).to, 'sp+0');
  const r = reload(f, 2);
  assert.ok(r, 'post-writeback base+16 must equal the pre-writeback frame slot sp+32');
  assert.equal(r.from, 'sp+32');
}
