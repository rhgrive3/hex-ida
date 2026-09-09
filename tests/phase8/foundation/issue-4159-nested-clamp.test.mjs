import assert from 'node:assert/strict';
import test from 'node:test';

import { expr } from '../../../js/decompiler/ast/nodes.js';
import { recognizeClamp } from '../../../js/decompiler/idioms/arm64-clang.js';

const x = expr.variable('x', 32, true);
const low = expr.constant(0, 32, true);
const high = expr.constant(100, 32, true);

test('#4159 the canonical nested clamp min(max(x, low), high) is recognized', () => {
  const root = expr.intrinsic('min', [expr.intrinsic('max', [x, low], 32, true), high], 32, true);
  const result = recognizeClamp(root);
  assert.equal(result?.kind, 'clamp');
  assert.equal(result.value.name, 'x');
  assert.equal(result.low.value, 0n);
  assert.equal(result.high.value, 100n);
});

test('#4159 the canonical nested clamp max(min(x, high), low) is recognized', () => {
  const root = expr.intrinsic('max', [expr.intrinsic('min', [x, high], 32, true), low], 32, true);
  const result = recognizeClamp(root);
  assert.equal(result?.kind, 'clamp');
  assert.equal(result.value.name, 'x');
  assert.equal(result.low.value, 0n);
  assert.equal(result.high.value, 100n);
});

test('#4159 the redundant shared-argument spelling keeps its historical result', () => {
  const inner = expr.intrinsic('max', [x, low], 32, true);
  const root = expr.intrinsic('min', [x, inner], 32, true);
  const result = recognizeClamp(root);
  assert.equal(result?.kind, 'clamp');
  assert.equal(result.value.name, 'x');
});

test('#4159 ambiguous structures fail closed', () => {
  // Deeper nesting in the value slot: not a single clamp.
  const deep = expr.intrinsic('min', [
    expr.intrinsic('max', [expr.intrinsic('max', [x, low], 32, true), low], 32, true),
    high,
  ], 32, true);
  assert.equal(recognizeClamp(deep), null);
  // Non-min/max outer intrinsic: not a clamp.
  const notClamp = expr.intrinsic('abs', [x], 32, true);
  assert.equal(recognizeClamp(notClamp), null);
});
