// Issue #5450 regression: buildSemanticModel() truncates at 6000 instructions,
// but markTailCalls() judged "inside the function" purely from the truncated
// window. A legitimate internal `b` into the untruncated tail was minted as an
// exact external tail call (facts.calls / leaf / FUNCTION_CALL block pollution).
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../js/blocks-base.js';

const MAX = 6000;
function rawFunction({ instructionCount, branchIndex = 5, branchTarget }) {
  return Array.from({ length: instructionCount }, (_v, i) => ({
    row: i + 1,
    address: 0x1000n + BigInt(i) * 4n,
    mn: i === branchIndex ? 'b' : 'mov',
    ops: i === branchIndex ? `#0x${branchTarget.toString(16)}` : 'x0, x0',
  }));
}

test('#5450 internal branch past the truncation boundary must not become a tail call', () => {
  // 6001-instruction function; insn 5 branches to the 6001st instruction
  // (address 0x6dc0), which truncation hides. No caller boundary evidence.
  const raw = rawFunction({ instructionCount: MAX + 1, branchTarget: 0x1000n + BigInt(MAX) * 4n });
  const model = buildSemanticModel(raw, { name: 'repro' });
  assert.equal(model.truncated, true);
  const branch = model.instructions[5];
  assert.equal(branch.isCall, false, 'truncated-window boundary must not mint an exact external tail call');
  assert.equal(branch.isTailCall, undefined);
  assert.equal(branch.callTarget, null);
  assert.equal(model.facts.calls, 0);
  assert.equal(model.facts.leaf, true);
});

test('#5450 caller-declared original bounds resolve the branch as internal', () => {
  const branchTarget = 0x1000n + BigInt(MAX) * 4n; // row 6000 (0-indexed) = original function tail
  const raw = rawFunction({ instructionCount: MAX + 1, branchTarget });
  const model = buildSemanticModel(raw, {
    name: 'repro',
    endRow: MAX + 1,
    rowOfAddress: (a) => (a == null || a < 0x1000n ? null : Number((a - 0x1000n) / 4n) + 1),
  });
  const branch = model.instructions[5];
  assert.equal(branch.isCall, false, 'branch to a row inside the original function is not a call');
  assert.equal(model.facts.calls, 0);
});

test('#5450 a branch proven outside the original bounds is still a tail call', () => {
  const branchTarget = 0x1000n + BigInt(MAX + 100) * 4n; // row well past the function end
  const raw = rawFunction({ instructionCount: MAX + 1, branchTarget });
  const model = buildSemanticModel(raw, {
    name: 'repro',
    endRow: MAX + 1,
    rowOfAddress: (a) => (a == null || a < 0x1000n ? null : Number((a - 0x1000n) / 4n) + 1),
  });
  const branch = model.instructions[5];
  assert.equal(branch.isCall, true, 'proven-external branch keeps tail-call semantics');
  assert.equal(branch.callTarget, branchTarget);
  assert.equal(model.facts.calls, 1);
});

test('#5450 non-truncated functions keep the existing tail-call behavior', () => {
  const raw = [
    { row: 1, address: 0x1000n, mn: 'b', ops: '#0x9000' },
    { row: 2, address: 0x2000n, mn: 'mov', ops: 'x0, x0' },
  ];
  const model = buildSemanticModel(raw, {});
  assert.equal(model.truncated, false);
  assert.equal(model.instructions[0].isCall, true, 'untruncated window keeps the legacy tail-call decision');
  assert.equal(model.instructions[0].isTailCall, true);
});
