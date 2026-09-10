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

test('#4159 commutative inner operand order preserves value and bound roles', () => {
  const swappedMin = expr.intrinsic('min', [expr.intrinsic('max', [low, x], 32, true), high], 32, true);
  const minResult = recognizeClamp(swappedMin);
  assert.equal(minResult?.kind, 'clamp');
  assert.equal(minResult.value.name, 'x');
  assert.equal(minResult.low.value, 0n);
  assert.equal(minResult.high.value, 100n);

  const swappedMax = expr.intrinsic('max', [expr.intrinsic('min', [high, x], 32, true), low], 32, true);
  const maxResult = recognizeClamp(swappedMax);
  assert.equal(maxResult?.kind, 'clamp');
  assert.equal(maxResult.value.name, 'x');
  assert.equal(maxResult.low.value, 0n);
  assert.equal(maxResult.high.value, 100n);
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

  // Both outer and inner min/max nodes must be exactly binary.
  const naryRoot = expr.intrinsic('min', [expr.intrinsic('max', [x, low], 32, true), high, expr.constant(200, 32, true)], 32, true);
  assert.equal(recognizeClamp(naryRoot), null);
  const naryInner = expr.intrinsic('min', [expr.intrinsic('max', [x, low, high], 32, true), high], 32, true);
  assert.equal(recognizeClamp(naryInner), null);

  // With no proof that distinguishes the inner value from the bound, do not guess.
  const variableLow = expr.variable('lowBound', 32, true);
  const variableHigh = expr.variable('highBound', 32, true);
  const noRoleAuthority = expr.intrinsic('min', [expr.intrinsic('max', [x, variableLow], 32, true), variableHigh], 32, true);
  assert.equal(recognizeClamp(noRoleAuthority), null);

  // Non-min/max outer intrinsic: not a clamp.
  const notClamp = expr.intrinsic('abs', [x], 32, true);
  assert.equal(recognizeClamp(notClamp), null);
});
