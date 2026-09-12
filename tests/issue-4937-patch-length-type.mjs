// Regression for #4937: validatePatchRange() must accept only primitive
// positive safe-integer numbers as the patch length. Number() coercion let
// [4], '4', true, and objects promote to a validated byte length, so a
// malformed structured value passed the public mutation guard exactly like a
// real length and reached the range/alignment/file-bounds logic.
import assert from 'node:assert/strict';
import { validatePatchRange } from '../js/patch.js';

const region = { vmAddr: 0x1000n, size: 0x100n, fileOffset: 0n };
const FILE = 0x1000n;

function show(result) {
  return `ok=${result.ok} error=${JSON.stringify(result.error)} fileOffset=${result.fileOffset}`;
}

function expectOk(result, label) {
  assert.ok(result.ok, `${label}: expected ok, got ${show(result)}`);
  assert.equal(result.fileOffset, region.fileOffset + 0n, `${label}: fileOffset`);
}

function expectError(result, label) {
  assert.ok(result.error, `${label}: expected error, got ${show(result)}`);
  assert.equal(result.ok, undefined, `${label}: must not report ok`);
}

// 1. Primitive 4 stays a valid ARM64 instruction patch.
expectOk(validatePatchRange(region, 0x1000n, 4, FILE, true), 'primitive 4 instruction patch');

// 2. Structured/coerced lengths must be rejected in instruction mode.
expectError(validatePatchRange(region, 0x1000n, [4], FILE, true), 'array [4] instruction patch');
expectError(validatePatchRange(region, 0x1000n, '4', FILE, true), "numeric string '4' instruction patch");
expectError(validatePatchRange(region, 0x1000n, true, FILE, true), 'boolean true instruction patch');
expectError(validatePatchRange(region, 0x1000n, { length: 4 }, FILE, true), 'object instruction patch');
expectError(validatePatchRange(region, 0x1000n, [8], FILE, false), 'array [8] non-instruction patch');

// 3. Non-instruction mode rejects structured lengths too.
expectOk(validatePatchRange(region, 0x1000n, 8, FILE, false), 'primitive 8 non-instruction patch');
expectError(validatePatchRange(region, 0x1000n, '8', FILE, false), "numeric string '8' non-instruction patch");
expectError(validatePatchRange(region, 0x1000n, [8], FILE, false), 'array [8] non-instruction patch');
expectError(validatePatchRange(region, 0x1000n, true, FILE, false), 'boolean true non-instruction patch');

// 4. Existing range/alignment/file-size checks stay intact.
expectError(validatePatchRange(region, 0x1002n, 4, FILE, true), 'misaligned address');
expectError(validatePatchRange(region, 0x1000n, 8, FILE, true), 'instruction length != 4');
expectError(validatePatchRange(region, 0x1100n, 4, FILE, true), 'address beyond region');
expectError(validatePatchRange(region, 0x10ffn, 4, FILE, true), 'length crosses region end');
expectError(validatePatchRange(region, 0x1000n, 8, 0x4n, false), 'length crosses file end');
expectError(validatePatchRange(region, 0x1000n, 8, -1n, false), 'negative file size');

// 5. Zero/negative/fraction/NaN/Infinity stay rejected.
for (const bad of [0, -4, 0.5, NaN, Infinity, -Infinity]) {
  expectError(validatePatchRange(region, 0x1000n, bad, FILE, true), `non-positive/unsafe length ${bad}`);
}

console.log('issue-4937 patch length type authority: ok');
