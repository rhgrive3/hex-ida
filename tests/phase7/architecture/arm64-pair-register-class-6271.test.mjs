import test from 'node:test';
import assert from 'node:assert/strict';
import { explain } from '../../../js/arm64.js';

test('issue 6271: only GP x29/x30 pair is classified as frame prologue/epilogue', () => {
  const push = explain('stp', 'x29, x30, [sp, #-16]!');
  assert.ok(push.terms.includes('prologue'));

  const pop = explain('ldp', 'x29, x30, [sp], #16');
  assert.ok(pop.terms.includes('epilogue'));

  for (const [mnemonic, operands] of [
    ['stp', 'q29, q30, [sp, #-32]!'],
    ['ldp', 'q29, q30, [sp], #32'],
    ['stp', 'd29, d30, [sp, #-16]!'],
  ]) {
    const result = explain(mnemonic, operands);
    assert.ok(!result.terms.includes('prologue'));
    assert.ok(!result.terms.includes('epilogue'));
  }

  const vectorSaved = explain('stp', 'q19, q20, [sp, #-32]!');
  assert.ok(!vectorSaved.terms.includes('calleesaved'));

  const gpSaved = explain('stp', 'x19, x20, [sp, #-16]!');
  assert.ok(gpSaved.terms.includes('calleesaved'));
});
