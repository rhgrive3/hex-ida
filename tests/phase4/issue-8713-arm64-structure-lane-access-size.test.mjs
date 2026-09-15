import assert from 'node:assert/strict';
import test from 'node:test';

import { makeInstruction } from '../../js/blocks.js';

const BASE = 0x100000n;

function insn(mn, ops, row = 0) {
  return makeInstruction({ row, address: BASE + BigInt(row * 4), mn, ops });
}

function size(mn, ops) {
  return insn(mn, ops).memory?.size;
}

// ---------------------------------------------------------------------------
// #8713 — LD1/ST1 lane / bare forms must not mint an unproven memory width
// ---------------------------------------------------------------------------

test('#8713 a lane structure form the operand grammar cannot structure stays unproven', () => {
  const load = insn('ld1', '{v0.h}[3], [x1]');
  assert.equal(load.memory?.kind, 'load', 'the memory fact itself is still proven');
  assert.equal(load.memory.size, null, 'lane width is not structurally proven, so no exact size');
  assert.ok(load.reads.includes('x1'), 'the address register is still a read');

  for (const mn of ['ld1', 'ld2', 'ld3', 'ld4']) {
    assert.equal(size(mn, '{v0.s}[1], [x1]'), null, `${mn} lane form must not fallback to 8`);
  }
});

test('#8713 a bare structure register does not launder the physical V width into a transfer size', () => {
  const store = insn('st1', '{v0}, [x1]');
  assert.equal(store.memory?.kind, 'store');
  assert.equal(store.memory.size, null, 'no arrangement, so the footprint is not proven');

  assert.equal(size('ld1', '{v0}, [x1]'), null);
  assert.equal(size('ld1', '{v0.16b,v1}, [x1]'), null, 'one unproven member poisons the whole list');
});

test('#8713 explicit arrangements keep publishing their exact proven widths', () => {
  assert.equal(size('ld1', '{v0.16b}, [x1]'), 16);
  assert.equal(size('ld2', '{v0.8b, v1.8b}, [x2]'), 16);
  assert.equal(size('st1', '{v0.2s}, [x1], #8'), 8);
  assert.equal(size('ld1', '{v0.16b}, [sp, #-16]!'), 16);
  assert.equal(size('ld4', '{v0.8b, v1.8b, v2.8b, v3.8b}, [x0]'), 32);
});

test('#8713 malformed or missing structure lists fail closed instead of defaulting to 8', () => {
  assert.equal(size('ld1', '[x1]'), null, 'no register list at all');
  assert.equal(size('st1', '{v0.q}, [x1]'), null, 'unrecognized arrangement shape');
  assert.equal(size('ld1', '{{v0.16b}}, [x1]'), null, 'nested list member is not a proven width');
});

test('#8713 scalar and pair memory widths are unchanged', () => {
  assert.equal(size('ldr', 'x0, [x1]'), 8);
  assert.equal(size('ldr', 'w0, [x1]'), 4);
  assert.equal(size('ldrb', 'w0, [x1]'), 1);
  assert.equal(size('ldrh', 'w0, [x1]'), 2);
  assert.equal(size('ldrsw', 'x0, [x1]'), 4);
  assert.equal(size('stp', 'x0, x1, [x2]'), 16);
  assert.equal(size('stp', 'w0, w1, [x2, #8]'), 8);
  assert.equal(size('ldp', 'q0, q1, [x2]'), 32);
});
