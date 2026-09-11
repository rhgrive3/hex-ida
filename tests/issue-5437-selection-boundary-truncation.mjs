// Regression for #5437: the selection display payload is truncated to 80
// instructions, but the selection boundaries authorize selection scope. The
// end boundary must derive from the original instruction list before
// truncation, or the scope shrinks with the display payload.
import assert from 'node:assert/strict';
import { createTurnSnapshot } from '../js/ai/control/snapshot.js';
import { ScopeController } from '../js/ai/control/scope.js';

const instructions = (count) => Array.from({ length: count }, (_, i) => ({
  address: `0x${(0x1000 + i * 4).toString(16)}`,
  mnemonic: 'nop',
  operands: '',
}));

// 1. ≤80 instructions with no explicit end keep the existing behavior.
{
  const snapshot = createTurnSnapshot({ selection: { instructions: instructions(80) } }, { scope: 'auto' });
  assert.equal(snapshot.selection.truncated, false);
  assert.equal(snapshot.selection.start, '0x1000');
  assert.equal(snapshot.selection.end, '0x113c', 'the 80th instruction is the last one');
  assert.equal(snapshot.selection.instructions.length, 80);
}

// 2. 81+ instructions with no explicit end: the end boundary must stay at the
// true final instruction, and the payload stays truncated to 80.
{
  const snapshot = createTurnSnapshot({ selection: { instructions: instructions(81) } }, { scope: 'auto' });
  assert.equal(snapshot.selection.truncated, true);
  assert.equal(snapshot.selection.instructions.length, 80, 'the display payload stays truncated');
  assert.equal(snapshot.selection.end, '0x1140', 'the boundary derives from the original instruction list');

  const scope = new ScopeController(snapshot, 'selection');
  assert.equal(scope.scopeContainsAddress('selection', '0x113c'), true);
  assert.equal(scope.scopeContainsAddress('selection', '0x1140'), true, 'the 81st selected address stays inside selection scope');
  assert.equal(scope.scopeContainsAddress('selection', '0x1144'), false, 'addresses past the selection stay outside');
}

// 3. An explicit end is never overridden by the instruction list.
{
  const snapshot = createTurnSnapshot({ selection: { instructions: instructions(81), end: '0x1020' } }, { scope: 'auto' });
  assert.equal(snapshot.selection.end, '0x1020');
}

// 4. The bare-array selection form keeps working (#5759) with the same rule.
{
  const snapshot = createTurnSnapshot({ selection: instructions(81) }, { scope: 'auto' });
  assert.equal(snapshot.selection.truncated, true);
  assert.equal(snapshot.selection.end, '0x1140');
}

console.log('issue #5437 selection boundary truncation regressions PASS');
