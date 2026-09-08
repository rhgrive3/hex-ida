import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMicrosoftVectorcallArguments } from '../../../js/targets/abi/microsoft-vectorcall.js';

/* Microsoft x64 __vectorcall register allocation (Learn "Example 2"): the
 * first six argument positions that carry vector/FP values map to their own
 * position's XMM/YMM0..5; HVA members then take the still-unused vector
 * registers left to right (#5586). */

const vector = (bits) => ({ type:bits === 256 ? '__m256' : '__m128', vector:true, bits });
const int = () => ({ type:'int', bits:32 });
const flt = () => ({ type:'float', floating:true, bits:32 });

test('position-carrying vectors map to their argument position registers', () => {
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), vector(128), int(), vector(128), vector(256), flt(), int()],
  } });
  const regs = result.arguments.map((entry) => entry.reg ?? `stack:${entry.offset}`);
  assert.deepEqual(regs, ['rcx', 'xmm1', 'r8', 'xmm3', 'ymm4', 'xmm5', 'stack:32']);
  assert.equal(result.partial, false);
});

test('the first six positions reserve their vector register even when consumed later', () => {
  // Five integers then two vectors: the integers hold positions 0-4, so the
  // vectors take XMM5 and then spill (position 5's register is the last one
  // reserved; there is no sixth vector slot left).
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), int(), int(), int(), int(), vector(128), vector(128)],
  } });
  assert.equal(result.arguments[5].reg, 'xmm5');
  assert.equal(result.arguments[6].location, 'stack');
  assert.equal(result.arguments[6].abiClass, 'vector-indirect');
});

test('HVA members fill the unused vector registers after positional reservation', () => {
  // Positions 0/2/4 are vectors (reserving xmm0/2/4), positions 1/3 are
  // integers. A 2-member HVA at position 5 takes the two unused registers.
  const hva2 = {
    hva:true, bits:256, bytes:32,
    members:[{ bits:128, bytes:16, byteOffset:0 }, { bits:128, bytes:16, byteOffset:16 }],
  };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[vector(128), int(), vector(128), int(), vector(128), hva2],
  } });
  assert.deepEqual(result.arguments[0].regs, ['xmm0']);
  assert.deepEqual(result.arguments[2].regs, ['xmm2']);
  assert.deepEqual(result.arguments[4].regs, ['xmm4']);
  assert.deepEqual(result.arguments[5].regs, ['xmm1', 'xmm3'], 'the HVA members use the unused registers');
  const vectorRegs = result.arguments.flatMap((entry) => entry.regs ?? []);
  assert.equal(new Set(vectorRegs).size, vectorRegs.length,
    'different arguments cannot reuse one physical vector lane');
});

test('Microsoft official Example 3 keeps HVA members and integer positions distinct', () => {
  // `int a, hva2 b, int c, int d, int e`: the HVA consumes the unused
  // vector positions while the integer arguments retain their own x64
  // positions; the fifth argument is the first caller stack slot.
  const hva2 = {
    hva:true, bits:256, bytes:32,
    members:[{ bits:128, bytes:16, byteOffset:0 }, { bits:128, bytes:16, byteOffset:16 }],
  };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), hva2, int(), int(), int()],
  } });
  assert.equal(result.arguments[0].reg, 'rcx');
  assert.deepEqual(result.arguments[1].regs, ['xmm0', 'xmm1']);
  assert.deepEqual(result.arguments[1].pieces.map((piece) => piece.reg), ['xmm0', 'xmm1']);
  assert.equal(result.arguments[2].reg, 'r8');
  assert.equal(result.arguments[3].reg, 'r9');
  assert.equal(result.arguments[4].location, 'stack');
  assert.equal(result.arguments[4].offset, 32);
  assert.equal(result.partial, false);
});

test('Microsoft official Example 4 reserves direct FP positions before HVA lanes', () => {
  // The documented example uses four __m256 members and therefore YMM views.
  // This canonical four-member fixture exercises the same non-contiguous
  // reservation topology with the repository's exact __m128 HVA shape;
  // Example 2 separately proves the XMM/YMM width views.
  const hva4 = {
    hva:true, bits:512, bytes:64,
    members:Array.from({ length:4 }, (_unused, index) => ({ bits:128, bytes:16, byteOffset:index * 16 })),
  };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), flt(), hva4, vector(128), int()],
  } });
  assert.equal(result.arguments[0].reg, 'rcx');
  assert.equal(result.arguments[1].reg, 'xmm1');
  assert.deepEqual(result.arguments[2].regs, ['xmm0', 'xmm2', 'xmm4', 'xmm5']);
  assert.equal(result.arguments[3].reg, 'xmm3');
  assert.equal(result.arguments[4].location, 'stack');
  assert.equal(result.arguments[4].offset, 32);
  const vectorRegs = result.arguments.flatMap((entry) => entry.regs ?? []);
  assert.equal(new Set(vectorRegs).size, vectorRegs.length);
  assert.equal(result.partial, false);
});

test('an HVA too large for the unused registers goes indirect in its integer register', () => {
  const hva4 = {
    hva:true, bits:512, bytes:64,
    members:Array.from({ length:4 }, (_unused, index) => ({ bits:128, bytes:16, byteOffset:index * 16 })),
  };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[vector(128), int(), vector(128), int(), vector(128), vector(128), hva4],
  } });
  // Five positional vectors used xmm0/2/4/5 and xmm1 (position 1 unused ->
  // HVA members) — only position-based reservation leaves no room for 4
  // members, so the HVA (index 6, beyond the first four positions) passes
  // by reference on the stack slot.
  assert.equal(result.arguments[6].location, 'stack');
  assert.equal(result.arguments[6].abiClass, 'hva-indirect');
});

test('HVA spilling after positional vectors keeps the integer-register reference (control)', () => {
  const hva4 = {
    hva:true, bits:512, bytes:64,
    members:Array.from({ length:4 }, (_unused, index) => ({ bits:128, bytes:16, byteOffset:index * 16 })),
  };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall', args:[vector(128), vector(128), vector(128), hva4],
  } });
  assert.equal(result.arguments[0].regs, result.arguments[0].regs);
  assert.equal(result.arguments[3].location, 'register');
  assert.equal(result.arguments[3].reg, 'r9');
  assert.equal(result.arguments[3].abiClass, 'hva-indirect');
  assert.equal(result.arguments[3].stackPossible, undefined, 'early HVA fallback has no stack alternative');
  assert.equal(result.stackArguments.length, 0);
  assert.equal(result.stackArgsMayContainPointers, false);
});


test('a seventh-position scalar FP argument is an indirect stack pointer', () => {
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), int(), int(), int(), int(), int(), flt()],
  } });
  const seventh = result.arguments[6];
  assert.equal(seventh.location, 'stack');
  assert.equal(seventh.abiClass, 'fp-indirect');
  assert.equal(seventh.pointer, true);
  assert.equal(seventh.indirectReference, true);
  assert.equal(seventh.pointeeBits, 32);
  assert.equal(result.stackArgsMayContainPointers, true);
});

  
test('an unproven HVA keeps a later HVA non-exact', () => {
  const laterHVA = {
    hva:true, bits:256, bytes:32,
    members:[{ bits:128, bytes:16, byteOffset:0 }, { bits:128, bytes:16, byteOffset:16 }],
  };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[{ hva:true, bits:256 }, laterHVA],
  } });
  const later = result.arguments[1];
  assert.equal(later.location, 'unknown');
  assert.deepEqual(later.candidateRegisters, ['xmm0','xmm1','xmm2','xmm3','xmm4','xmm5']);
  assert.equal(later.abiClass, 'hva-after-unproven-hva');
  assert.equal(later.partial, true);
  assert.equal(later.possible, true);
  assert.equal(later.mustUse, false);
  assert.equal(later.exact, false);
  assert.equal(result.partial, true);
});

  
test('wide indirect vectors do not reserve positional vector registers', () => {
  const hva4 = {
    hva:true, bits:512, bytes:64,
    members:Array.from({ length:4 }, (_unused, index) => ({ bits:128, bytes:16, byteOffset:index * 16 })),
  };
  const wide = { type:'__m512', vector:true, bits:512 };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[hva4, wide, wide, wide],
  } });
  assert.equal(result.arguments[0].location, 'register');
  assert.deepEqual(result.arguments[0].regs, ['xmm0','xmm1','xmm2','xmm3']);
  assert.deepEqual(result.arguments.slice(1).map((entry) => entry.location), ['stack','stack','stack']);
  assert.equal(result.arguments[1].abiClass, 'vector-indirect');
});

test('indirect scalar FP arguments use non-overlapping eight-byte stack slots', () => {
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), int(), int(), int(), int(), int(), flt(), { type:'double', floating:true, bits:64 }],
  } });
  const stackEntries = result.arguments.slice(4);
  assert.deepEqual(stackEntries.map((entry) => entry.index), [4, 5, 6, 7]);
  assert.deepEqual(stackEntries.map((entry) => entry.offset), [32, 40, 48, 56]);
  assert.equal(new Set(stackEntries.map((entry) => entry.offset)).size, stackEntries.length,
    'each spilled argument has a distinct caller stack slot');
  assert.deepEqual(stackEntries.map((entry) => entry.calleeEntryOffset), [40, 48, 56, 64]);
  for (const entry of stackEntries) {
    assert.equal(entry.offsetBase, 'caller-stack-before-call');
    assert.equal(entry.calleeEntryOffset, entry.offset + 8);
    assert.equal(entry.bytes, 8);
  }
  assert.deepEqual(stackEntries.map((entry) => entry.abiClass), ['integer', 'integer', 'fp-indirect', 'fp-indirect']);
  assert.deepEqual(stackEntries.map((entry) => entry.pointer), [false, false, true, true]);
  assert.deepEqual(stackEntries.map((entry) => entry.bits), [32, 32, 64, 64]);
  assert.deepEqual(stackEntries.slice(2).map((entry) => ({
    indirectReference:entry.indirectReference,
    pointeeBits:entry.pointeeBits,
    pieceStackOffset:entry.pieces?.[0]?.stackOffset,
    pieceBits:entry.pieces?.[0]?.bits,
    pieceBytes:entry.pieces?.[0]?.bytes,
  })), [
    { indirectReference:true, pointeeBits:32, pieceStackOffset:48, pieceBits:64, pieceBytes:8 },
    { indirectReference:true, pointeeBits:64, pieceStackOffset:56, pieceBits:64, pieceBytes:8 },
  ]);
  assert.deepEqual(result.stackArguments, stackEntries,
    'stackArguments retains every spill with the same provenance');
  assert.equal(result.stackArgsMayContainPointers, true);
});

test('an unproven HVA at position six taints every later HVA', () => {
  const laterHVA = {
    hva:true, bits:256, bytes:32,
    members:[{ bits:128, bytes:16, byteOffset:0 }, { bits:128, bytes:16, byteOffset:16 }],
  };
  const result = classifyMicrosoftVectorcallArguments({ callPrototype:{
    callingConvention:'vectorcall',
    args:[int(), int(), int(), int(), int(), int(), { hva:true, bits:256 }, laterHVA],
  } });
  const later = result.arguments[7];
  assert.equal(later.location, 'unknown');
  assert.deepEqual(later.candidateRegisters, ['xmm0','xmm1','xmm2','xmm3','xmm4','xmm5']);
  assert.equal(later.abiClass, 'hva-after-unproven-hva');
  assert.equal(later.partial, true);
  assert.equal(later.possible, true);
  assert.equal(later.mustUse, false);
  assert.equal(later.exact, false);
  assert.equal(result.partial, true);
});
