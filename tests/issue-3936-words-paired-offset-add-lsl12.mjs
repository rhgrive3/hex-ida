// Regression for #3936: Words.pairedOffset() accepted only `ADD (immediate)`
// with shift = 0, so the very common `adrp xN, page` + `add xN, xN, #imm, lsl
// #12` pair returned null and the exact data reference was dropped from the
// ProgramIndex. The LSL #12 form is a valid A64 page-offset idiom and must be
// decoded with its shift applied.
import assert from 'node:assert/strict';

await import('../js/words.js');
const W = globalThis.Words;

const addLsl12 = 0x91400400; // add x0, x0, #1, lsl #12
const addShift0 = 0x91000400; // add x0, x0, #1

// 1. The shifted form decodes, and the immediate is already in bytes.
{
  const pair = W.pairedOffset(addLsl12);
  assert.notEqual(pair, null, 'ADD (immediate) with LSL #12 must decode');
  assert.equal(pair.rn, 0);
  assert.equal(pair.rd, 0);
  assert.equal(pair.imm, 0x1000n, 'LSL #12 must be applied to the immediate');
  assert.equal(pair.load, false);
}

// 2. The unshifted form is unchanged.
{
  const pair = W.pairedOffset(addShift0);
  assert.equal(pair.imm, 1n);
}

// 3. Both forms must agree with the page-relative target of their ADRP.
{
  assert.equal(W.pairedOffset(0x91400c00).imm, 0x3000n); // add x0, x0, #3, lsl #12
  assert.equal(W.pairedOffset(0x91000c00).imm, 3n);      // add x0, x0, #3
}

console.log('issue #3936 Words.pairedOffset ADD LSL #12 regression passed');
