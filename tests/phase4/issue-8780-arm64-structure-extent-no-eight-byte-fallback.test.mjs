import assert from 'node:assert/strict';
import test from 'node:test';

import { ROLE, buildSemanticModel, makeInstruction } from '../../js/blocks.js';

const BASE = 0x100000n;

function insn(mn, ops, row = 0) {
  return makeInstruction({ row, address: BASE + BigInt(row * 4), mn, ops });
}

// ---------------------------------------------------------------------------
// #8780 — an unproven LD1/ST1 extent must never be minted as an 8-byte exact
// ---------------------------------------------------------------------------

test('#8780 lane and bare structure operands publish no exact extent', () => {
  const lane = insn('ld1', '{v0.h}[3], [x1]');
  assert.equal(lane.memory.kind, 'load');
  assert.equal(lane.memory.size, null, '1-lane structure access is not an 8-byte whole-register access');

  const bare = insn('st1', '{v0}, [x1]');
  assert.equal(bare.memory.kind, 'store');
  assert.equal(bare.memory.size, null, 'a missing arrangement must not mint an extent');

  // The exact value the old fallback manufactured was 8; no unproven form may
  // reach it through any structure spelling.
  for (const ops of ['{v0.h}[3], [x1]', '{v0}, [x1]', '{v0.h}[3], {v1.h}[3], [x1]', '{v0,v1}, [x1]']) {
    for (const mn of ['ld1', 'ld2', 'ld3', 'ld4', 'st1', 'st2', 'st3', 'st4']) {
      const m = insn(mn, ops).memory;
      assert.equal(m.size, null, `${mn} ${ops} must fail closed, not mint a width`);
    }
  }
});

test('#8780 proven structure extents and list write/read facts do not regress', () => {
  const full = insn('ld1', '{v0.16b}, [x1]');
  assert.equal(full.memory.size, 16);

  const multi = insn('ld3', '{v0.8b, v1.8b, v2.8b}, [x2]');
  assert.equal(multi.memory.size, 24, 'ld3 list width is still the sum of proven elements');

  const post = insn('st1', '{v0.16b}, [x1], #16');
  assert.equal(post.memory.size, 16);
  assert.equal(post.memory.mode, 'post');
  assert.deepEqual(post.writes, ['x1'], 'post-index base writeback stays a definition');
  assert.ok(post.reads.includes('v0') && post.reads.includes('x1'));

  const pairList = insn('ld2', '{v0.8b, v1.8b}, [x2]');
  assert.deepEqual(pairList.writes, ['v0', 'v1'], 'a list destination is written');
  assert.ok(pairList.reads.includes('x2'));
});

test('#8780 an unproven extent survives the semantic model without a false byte range', () => {
  const model = buildSemanticModel([
    { row: 0, address: BASE, mn: 'ld1', ops: '{v0.h}[3], [x1]' },
    { row: 1, address: BASE + 4n, mn: 'st1', ops: '{v0.16b}, [x1]' },
    { row: 2, address: BASE + 8n, mn: 'ret', ops: '' },
  ], { rowOfAddress: () => null });
  const loads = model.semantic.filter((g) => g.role === ROLE.MEMORY_READ || g.role === ROLE.MEMORY_WRITE);
  assert.ok(loads.length, 'the structure loads still form memory groups');
  const widths = model.instructions.map((i) => i.memory?.size);
  assert.deepEqual(widths, [null, 16, undefined], 'only the proven form carries an extent');
});
