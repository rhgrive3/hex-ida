import assert from 'node:assert/strict';
import { uniqueReachableMergePredecessorIndex as arm } from '../../../js/decompiler/passes/stack-join-arm-proof.js';

function ir(edges) {
  const max = Math.max(0, ...Object.keys(edges).map(Number), ...Object.values(edges).flat().map(Number));
  const blocks = Array.from({ length: max + 1 }, (_, index) => ({ index, succ: [] }));
  for (const [from, succ] of Object.entries(edges)) blocks[Number(from)] = { index: Number(from), succ: [...succ] };
  return { blocks };
}

// A conditional controller must expose exactly two distinct CFG successors.
{
  const cfg = ir({ 0: [1, 2, 3], 1: [4], 2: [4], 3: [], 4: [] });
  assert.equal(arm(cfg, 0, 1, 4, [1, 2]), -1);
}

// A direct edge into merge that is absent from merge predecessor identity is
// contradictory evidence, not permission to ignore that path.
{
  const cfg = ir({ 0: [1, 3], 1: [2, 4], 2: [4], 3: [4], 4: [] });
  assert.equal(arm(cfg, 0, 1, 4, [2, 3]), -1);
}

// The production proof bound is fixed: callers cannot raise the 256-node cap.
{
  const cfg = ir({ 0: [1, 2], 1: [3], 2: [3], 3: [] });
  assert.equal(arm(cfg, 0, 1, 3, [1, 2], 257), -1);
}

console.log('issue #3999 stack join proof hardening: PASS');
