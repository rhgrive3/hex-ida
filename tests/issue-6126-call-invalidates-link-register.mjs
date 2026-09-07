import assert from 'node:assert/strict';
import test from 'node:test';
import { makeInstruction, analyzeDataFlow } from '../js/blocks-base.js';

// #6126: BL/BLR write the return address into X30/LR as part of the branch
// itself (Arm branch-with-link contract), but the call handler only
// invalidated the ABI caller-saved x0..x17 and `writeIndexes()` gives calls
// an empty write set. A pre-call X30 value therefore survived the call and
// propagated as stale provenance into `mov xN, x30` afterwards.

function rows(lines) {
  return lines.map(([row, address, mn, ops]) => makeInstruction({ row, address, mn, ops }));
}

test('#6126: a pre-call X30 value does not survive BL into a post-call read', () => {
  const df = analyzeDataFlow(rows([
    [0, 0x1000n, 'mov', 'x30, #0x1111'],
    [1, 0x1004n, 'bl', '#0x1040'],
    [2, 0x1008n, 'mov', 'x0, x30'],
  ]), {});
  const x0 = df.finalRegs.get('x0');
  assert.ok(!x0 || !(x0.kind === 'imm' && x0.value === 0x1111n),
    'x0 must not inherit the pre-call X30 immediate after BL');
});

test('#6126: a pre-call X30 value does not survive BLR into a post-call read', () => {
  const df = analyzeDataFlow(rows([
    [0, 0x1000n, 'mov', 'x30, #0x2222'],
    [1, 0x1004n, 'blr', 'x9'],
    [2, 0x1008n, 'mov', 'x1, x30'],
  ]), {});
  const x1 = df.finalRegs.get('x1');
  assert.ok(!x1 || !(x1.kind === 'imm' && x1.value === 0x2222n),
    'x1 must not inherit the pre-call X30 immediate after BLR');
});

test('#6126: authenticated link call forms also invalidate X30', () => {
  for (const mn of ['blraa', 'blrab']) {
    const df = analyzeDataFlow(rows([
      [0, 0x1000n, 'mov', 'x30, #0x3333'],
      [1, 0x1004n, mn, 'x9, #0'],
      [2, 0x1008n, 'mov', 'x2, x30'],
    ]), {});
    const x2 = df.finalRegs.get('x2');
    assert.ok(!x2 || !(x2.kind === 'imm' && x2.value === 0x3333n), `${mn} must invalidate X30`);
  }
});

test('#6126: X30 reads before the call keep their provenance', () => {
  const df = analyzeDataFlow(rows([
    [0, 0x1000n, 'mov', 'x30, #0x4444'],
    [1, 0x1004n, 'mov', 'x19, x30'],
    [2, 0x1008n, 'bl', '#0x1040'],
  ]), {});
  const x19 = df.finalRegs.get('x19');
  assert.ok(x19 && x19.kind === 'imm' && x19.value === 0x4444n,
    'pre-call copy of X30 keeps its immediate value');
});

test('#6126: non-call branches do not invalidate X30', () => {
  const df = analyzeDataFlow(rows([
    [0, 0x1000n, 'mov', 'x30, #0x5555'],
    [1, 0x1004n, 'b', '#0x100c'],
    [2, 0x100cn, 'mov', 'x6, x30'],
  ]), { joinRows: new Set([2]) });
  const x6 = df.finalRegs.get('x6');
  // joinRows clears state at the join regardless; without it, B alone must
  // preserve X30.
  const df2 = analyzeDataFlow(rows([
    [0, 0x1000n, 'mov', 'x30, #0x5555'],
    [1, 0x1004n, 'b', '#0x100c'],
    [2, 0x100cn, 'mov', 'x6, x30'],
  ]), {});
  const x6b = df2.finalRegs.get('x6');
  assert.ok(x6b && x6b.kind === 'imm' && x6b.value === 0x5555n,
    'plain B leaves X30 untouched');
  void x6;
});
