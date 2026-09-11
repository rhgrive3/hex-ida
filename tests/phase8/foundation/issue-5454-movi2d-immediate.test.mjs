import assert from 'node:assert/strict';
import { lowerArm64RawAssembly } from '../../../js/decompiler/arm64-extra-semantics.js';

function rawResult(text) {
  return { lines: [{ text, indent: 0 }] };
}

// The printed 2D immediate is the already-expanded 64-bit byte mask: it is
// passed through exactly, never re-expanded from the 8-bit encoding field.
const ff = lowerArm64RawAssembly(rawResult('__asm("movi v0.2d, #0xff");'));
assert.equal(ff.lines[0].text, 'v0 = __a64_movi_2d(0xff);', `#0xff must stay 0xff: ${ff.lines[0].text}`);

const zero = lowerArm64RawAssembly(rawResult('__asm("movi v0.2d, #0x0");'));
assert.equal(zero.lines[0].text, 'v0 = __a64_movi_2d(0x0);');

const mixed = lowerArm64RawAssembly(rawResult('__asm("movi v1.2d, #0xff00ff00ff00ff00");'));
assert.equal(mixed.lines[0].text, 'v1 = __a64_movi_2d(0xff00ff00ff00ff00);', `full-width mask must lower exactly: ${mixed.lines[0].text}`);

const allOnes = lowerArm64RawAssembly(rawResult('__asm("movi v0.2d, #0xffffffffffffffff");'));
assert.equal(allOnes.lines[0].text, 'v0 = __a64_movi_2d(0xffffffffffffffff);');

// Not a canonical 00/ff byte mask -> fail closed, keep the raw __asm.
const nonMask = lowerArm64RawAssembly(rawResult('__asm("movi v0.2d, #0x1234");'));
assert.equal(nonMask.lines[0].text, '__asm("movi v0.2d, #0x1234");');
assert.equal(nonMask.lines[0].note, undefined);

// 2D has no shifted form in the assembly syntax: keep rejecting it.
const shifted2d = lowerArm64RawAssembly(rawResult('__asm("movi v0.2d, #0xff, lsl #8");'));
assert.equal(shifted2d.lines[0].text, '__asm("movi v0.2d, #0xff, lsl #8");');

// Non-2D arrangements keep their existing behavior (immediate + optional LSL).
const shifted16b = lowerArm64RawAssembly(rawResult('__asm("movi v0.16b, #0xff, lsl #8");'));
assert.equal(shifted16b.lines[0].text, 'v0 = __a64_movi_16b(0xff00);');

const plain16b = lowerArm64RawAssembly(rawResult('__asm("movi v0.16b, #0xab");'));
assert.equal(plain16b.lines[0].text, 'v0 = __a64_movi_16b(0xab);');

console.log('#5454: All tests passed successfully.');
