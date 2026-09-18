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
  // Positional shadow slots mean g sits at 32 + 8·(6−4) = 48 (#6003).
  const regs = result.arguments.map((entry) => entry.reg ?? `stack:${entry.offset}`);
  assert.deepEqual(regs, ['rcx', 'xmm1', 'r8', 'xmm3', 'ymm4', 'xmm5', 'stack:48']);
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
  // Positions 4/5 pass on the stack (integer overflow from the standard x64
  // half), positions 6/7 continue after them — never compacted (#6003).
  assert.equal(result.arguments[6].offset, 48);
  assert.equal(result.arguments[7].offset, 56);
  assert.equal(result.arguments[6].calleeEntryOffset, 56);
  assert.equal(result.arguments[7].calleeEntryOffset, 64);
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
