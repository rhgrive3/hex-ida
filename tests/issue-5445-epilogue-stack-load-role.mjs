// Regression for #5445: a stack load whose destination is not x29/x30 must
// not be classified as cleanup just because it sits near a return. The
// `|| true` in looksEpilogue() disabled the register check entirely.
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks-base.js';

function blockRoles(raw) {
  const model = buildSemanticModel(raw, {});
  return model.semantic.map((block) => ({ role: block.role, startRow: block.startRow, endRow: block.endRow }));
}

// 1. A caller-saved stack load (return-value reload) before a ret stays a
// memory read, not cleanup.
{
  const roles = blockRoles([
    { mn: 'ldr', ops: 'x0, [sp, #16]', address: 0x1000, row: 1 },
    { mn: 'ret', ops: '', address: 0x1004, row: 2 },
  ]);
  assert.equal(roles[0].role, 'memory_read', `a non-x29/x30 stack load must not be cleanup, got ${roles[0].role}`);
}

// 2. Genuine x29/x30 restores keep their cleanup classification.
{
  const roles = blockRoles([
    { mn: 'ldp', ops: 'x29, x30, [sp], #16', address: 0x1000, row: 1 },
    { mn: 'ret', ops: '', address: 0x1004, row: 2 },
  ]);
  assert.equal(roles[0].role, 'cleanup');
}

// 3. An x30-only load before a ret is still cleanup.
{
  const roles = blockRoles([
    { mn: 'ldr', ops: 'x30, [sp, #8]', address: 0x1000, row: 1 },
    { mn: 'ret', ops: '', address: 0x1004, row: 2 },
  ]);
  assert.equal(roles[0].role, 'cleanup');
}

// 4. A frame-pointer-only restore (x29 without x30) still reads as cleanup.
{
  const roles = blockRoles([
    { mn: 'ldr', ops: 'x29, [sp, #8]', address: 0x1000, row: 1 },
    { mn: 'ret', ops: '', address: 0x1004, row: 2 },
  ]);
  assert.equal(roles[0].role, 'cleanup');
}

console.log('issue #5445 epilogue stack-load role regressions PASS');
