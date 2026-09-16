// Regression for #4032: the raw ARM64 word decoder returned PC-relative targets
// as signed BigInt arithmetic (`pc + imm`). A branch / ADR / literal load at a
// low address with a negative offset therefore produced `-4n` instead of the
// A64 64-bit bit pattern `0xfffffffffffffffc`, and those values are published as
// address truth by the worker program scan and Objective-C stub recovery. Every
// PC-relative target is now canonicalized to unsigned 64-bit.
import assert from 'node:assert/strict';

await import('../js/words.js');
const W = globalThis.Words;

const u64 = (value) => value & ((1n << 64n) - 1n);
const MINUS_4 = u64(-4n);

// 1. `B` with imm26 = -1 at pc = 0 is a branch to 0xfffffffffffffffc, not -4n.
{
  const target = W.branchImm26(0x17ffffff, 0n);
  assert.equal(target, MINUS_4, 'b #-4 at pc=0 must be the unsigned 64-bit address');
  assert.ok(target >= 0n, `a published target must not be a negative BigInt (got ${target})`);
}

// 2. `BL` shares the same decode and the same normalization.
assert.equal(W.branchImm26(0x97ffffff, 0n), MINUS_4);

// 3. `LDR (literal)` with a negative offset at pc = 0.
assert.equal(W.literalTarget(0x58ffffe0, 0n), MINUS_4);

// 4. `wordTarget()` is the aggregated entry point; it must agree.
assert.equal(W.wordTarget(0x17ffffff, 0n), MINUS_4);

// 5. `ADR` / `ADRP` with imm = -1: the non-page form wraps to UINT64_MAX and the
//    page form subtracts one page from the page base.
{
  const adr = W.pcRelTarget(0x70ffffe0, 0n); // adr x0, #-1
  assert.equal(adr.page, false);
  assert.equal(adr.value, u64(-1n));

  const adrp = W.pcRelTarget(0xf0ffffe0, 0n); // adrp x0, #-0x1000
  assert.equal(adrp.page, true);
  assert.equal(adrp.value, u64(-0x1000n));
}

// 6. In-range targets are unchanged.
assert.equal(W.pcRelTarget(0x10000008, 0x1000n).value, 0x1000n);
assert.equal(W.branchImm26(0x14000001, 0x1000n), 0x1004n);

console.log('issue #4032 Words PC-relative uint64 normalization regression passed');
