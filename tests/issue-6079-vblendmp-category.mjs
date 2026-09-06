import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvexCategory } from '../js/targets/architecture/x86_64/effects/extended-state-evex.js';

test('6079: VBLENDMP* are opmask selects, not FP computations', () => {
  assert.equal(classifyEvexCategory('vblendmps'), 'simd');
  assert.equal(classifyEvexCategory('vblendmpd'), 'simd');
  assert.equal(classifyEvexCategory('VBLENDMPS'), 'simd');
});

test('6079: genuine FP families stay fp', () => {
  assert.equal(classifyEvexCategory('vaddps'), 'fp');
  assert.equal(classifyEvexCategory('vmulpd'), 'fp');
  assert.equal(classifyEvexCategory('vsqrtps'), 'fp');
});

test('6079: integer blends stay simd', () => {
  assert.equal(classifyEvexCategory('vpblendmb'), 'simd');
  assert.equal(classifyEvexCategory('vpblendmd'), 'simd');
});
