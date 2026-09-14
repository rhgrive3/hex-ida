import assert from 'node:assert/strict';
import { classifyMicrosoftVectorcallArguments } from '../../../js/targets/abi/microsoft-vectorcall.js';

const vectors = (count) => Array.from({ length: count }, () => ({ type: '__m128', vector: true, bits: 128 }));
const floatHva4 = () => ({
  hva: true, bits: 128, bytes: 16, type: 'HF4',
  members: Array.from({ length: 4 }, (_unused, index) => ({
    type: 'float', bits: 32, bytes: 4, byteOffset: index * 4,
  })),
});
const scalarFloat = () => ({ type: 'float', floating: true, bits: 32 });
const hva = (members, bits) => ({
  hva: true, bits, bytes: members * 16, type: `HVA${members}`,
  members: Array.from({ length: members }, (_unused, index) => ({ type: '__m128', bits: 128, bytes: 16, byteOffset: index * 16 })),
});

// #5993: an HVA in one of the first four parameter positions that cannot fit
// the remaining vector registers passes a caller-memory REFERENCE in the
// corresponding integer register (RCX/RDX/R8/R9), never a direct stack slot.
// The classifier pushed it to the stack regardless of position.
{
  // 3 vectors consume XMM0-2; the 4-member HVA at position 3 needs 4 more
  // slots (only 3 left) → reference in R9 (position 3's integer register).
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [...vectors(3), hva(4, 512)],
  } });
  assert.equal(result.arguments[0].reg, 'xmm0');
  assert.equal(result.arguments[1].reg, 'xmm1');
  assert.equal(result.arguments[2].reg, 'xmm2');
  const indirect = result.arguments[3];
  assert.equal(indirect.location, 'register', 'first-four HVA overflow must stay in a register');
  assert.equal(indirect.reg, 'r9', 'position 3 maps to R9');
  assert.equal(indirect.abiClass, 'hva-indirect');
  assert.equal(indirect.pointer, true);
  assert.equal(indirect.indirectReference, true);
  assert.equal(indirect.pointeeBits, 512);
}


 // A scalar FP parameter reserves one vector register before a following HVA.
{
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [scalarFloat(), floatHva4()],
  } });
  assert.equal(result.arguments[0].reg, 'xmm0');
  assert.deepEqual(result.arguments[1].regs, ['xmm1', 'xmm2', 'xmm3', 'xmm4']);
  assert.equal(new Set(result.srcs.map((source) => source.reg)).size, result.srcs.length);
}

// Three scalar FP parameters consume XMM0-XMM2; a following first-four HVA
// cannot fit and must use its corresponding integer register (R9), without
// repeating a vector register.
{
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall',
    args: [scalarFloat(), scalarFloat(), scalarFloat(), hva(4, 512)],
  } });
  assert.deepEqual(result.arguments.slice(0, 3).map((entry) => entry.reg), ['xmm0', 'xmm1', 'xmm2']);
  const indirect = result.arguments[3];
  assert.equal(indirect.location, 'register');
  assert.equal(indirect.reg, 'r9');
  assert.equal(indirect.abiClass, 'hva-indirect');
  assert.equal(indirect.indirectReference, true);
}

// Positions 0-2 map to RCX/RDX/R8. A position-0 HVA alone always fits the
// six vector slots, so each case exhausts the bank with earlier arguments.
{
  // Two 4-member HVAs: position 0 takes XMM0-3, position 1 cannot fit → RDX.
  const first = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [hva(4, 512), hva(4, 512)],
  } });
  assert.equal(first.arguments[0].reg, 'xmm0');
  assert.equal(first.arguments[1].location, 'register');
  assert.equal(first.arguments[1].reg, 'rdx', 'position 1 maps to RDX');
  assert.equal(first.arguments[1].indirectReference, true);
}
{
  // HVA4 + HVA2 + HVA2: position 2 exhausts the bank → R8.
  const hva4 = hva(4, 512);
  const hva2 = hva(2, 256);
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [hva4, hva2, hva2],
  } });
  assert.equal(result.arguments[2].location, 'register');
  assert.equal(result.arguments[2].reg, 'r8', 'position 2 maps to R8');
  assert.equal(result.arguments[2].indirectReference, true);
}

// An HVA beyond the first four positions keeps the direct stack fallback.
{
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [...vectors(6), hva(2, 256)],
  } });
  const stackEntry = result.arguments[6];
  assert.equal(stackEntry.location, 'stack');
  assert.equal(stackEntry.abiClass, 'hva-indirect');
  assert.equal(stackEntry.pointer, true);
}

// Non-HVA vectors overflowing the vector bank keep the vector-indirect
// stack fallback.
{
  const result = classifyMicrosoftVectorcallArguments({ callPrototype: {
    callingConvention: '__vectorcall', args: [...vectors(7)],
  } });
  assert.equal(result.arguments[6].location, 'stack');
  assert.equal(result.arguments[6].abiClass, 'vector-indirect');
}

console.log('vectorcall first-four HVA indirect-register authority (#5993): PASS');
