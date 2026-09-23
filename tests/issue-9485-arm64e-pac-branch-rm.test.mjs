import assert from 'node:assert/strict';
import test from 'node:test';
import '../js/words.js';

const W = globalThis.Words;

test('issue #9485: Rm-qualified PAC branches and calls are classified correctly', () => {
  // BLRAA X16, X0 (Rn=16, Rm=0) -> 0xd7200a00
  const blraa_x16_x0 = 0xd7200a00;
  assert.equal(W.isIndirectCall(blraa_x16_x0), true, 'BLRAA with Rm=0 should be indirect call');
  assert.equal(W.KIND_NAME[W.classifyWord(blraa_x16_x0)], 'INDCALL');

  // BLRAB X16, X1 (Rn=16, Rm=1) -> 0xd7210a00
  const blrab_x16_x1 = 0xd7210a00;
  assert.equal(W.isIndirectCall(blrab_x16_x1), true, 'BLRAB with Rm=1 should be indirect call');
  assert.equal(W.KIND_NAME[W.classifyWord(blrab_x16_x1)], 'INDCALL');

  // BRAA X16, X0 (Rn=16, Rm=0) -> 0xd7000a00
  const braa_x16_x0 = 0xd7000a00;
  assert.equal(W.isBr(braa_x16_x0), true, 'BRAA with Rm=0 should be branch');
  assert.equal(W.KIND_NAME[W.classifyWord(braa_x16_x0)], 'BRANCH');

  // BRAB X16, X2 (Rn=16, Rm=2) -> 0xd7020a00
  const brab_x16_x2 = 0xd7020a00;
  assert.equal(W.isBr(brab_x16_x2), true, 'BRAB with Rm=2 should be branch');
  assert.equal(W.KIND_NAME[W.classifyWord(brab_x16_x2)], 'BRANCH');
});
