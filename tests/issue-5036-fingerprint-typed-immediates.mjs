import assert from 'node:assert/strict';
import { normalizeInstruction, fingerprintFunction, fingerprintFunctionFast } from '../js/fingerprint/index.js';

// Issue #5036: canonicalImmediate() ran BigInt() over structured
// parsedOperands values, laundering booleans/arrays into real immediates
// (BigInt(true)===1n, BigInt(['16'])===16n) and throwing on non-coercible
// shapes. Only canonical primitives — bigint, finite safe-integer number,
// canonical integer string — may mint a constant; anything else falls back to
// the operand text instead of becoming a different real constant.

const malformed = { mnemonic: 'mov', parsedOperands: [{ k: 'imm', value: true }] };
const real = { mnemonic: 'mov', parsedOperands: [{ k: 'imm', value: 1n }] };

assert.notEqual(normalizeInstruction(malformed).operands, '#1', 'a boolean must not become the constant #1');
assert.equal(normalizeInstruction(real).operands, '#1', 'canonical bigint immediates are unchanged');

// Malformed structured values never mint constants (and never throw).
for (const value of [true, false, ['16'], ['0x10'], {}, { toString: () => '5' }, 1.5, 2 ** 53, 'abc', '0x', null]) {
  const instruction = { mnemonic: 'mov', parsedOperands: [{ k: 'imm', value }] };
  const normalized = normalizeInstruction(instruction);
  assert.ok(!/^#/.test(normalized.operands), `value ${String(JSON.stringify(value) ?? value)} must not mint a constant`);
}

// Canonical primitives keep their exact constants.
for (const [value, expected] of [[16, '#16'], [1n, '#1'], [0n, '#0'], [-8n, '#-8'], ['0x10', '#16'], ['16', '#16'], [' 16 ', '#16'], ['016', '#16'], [-4, '#-4']]) {
  const normalized = normalizeInstruction({ mnemonic: 'mov', parsedOperands: [{ k: 'imm', value }] });
  assert.equal(normalized.operands, expected, `value ${String(value)} canonicalizes to ${expected}`);
}

// Signed hex is sign-aware: BigInt() itself rejects '-0x10', so the parser
// must split the sign from the magnitude before parsing (#5036 R2).
for (const [value, expected] of [['-0x10', '#-16'], ['+0x10', '#16'], ['-0X1F', '#-31'], ['-16', '#-16']]) {
  const normalized = normalizeInstruction({ mnemonic: 'mov', parsedOperands: [{ k: 'imm', value }] });
  assert.equal(normalized.operands, expected, `signed hex ${String(value)} canonicalizes to ${expected}`);
}
assert.equal(
  normalizeInstruction({ mnemonic: 'mov', parsedOperands: [{ k: 'imm', value: '-0x10' }] }).operands,
  normalizeInstruction({ mnemonic: 'mov', parsedOperands: [{ k: 'imm', value: -16n }] }).operands,
  'signed hex and the equivalent bigint canonicalize identically',
);

// Float immediates stay numeric evidence; structured junk falls back to text.
assert.equal(normalizeInstruction({ mnemonic: 'fmov', parsedOperands: [{ k: 'imm', float: 0.5 }] }).operands, '0.5');
assert.notEqual(normalizeInstruction({ mnemonic: 'fmov', parsedOperands: [{ k: 'imm', float: '0.5' }] }).operands, '0.5');

// Branch-target/address classification no longer launders malformed values.
assert.equal(normalizeInstruction({ mnemonic: 'cbz', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: true }] }).operands.includes('@branch'), false, 'a boolean branch operand is not @branch evidence');
assert.ok(normalizeInstruction({ mnemonic: 'cbz', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: 8n }] }).operands.endsWith('@branch'), 'canonical branch targets keep their classification');
assert.equal(normalizeInstruction({ mnemonic: 'adrp', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: ['0x1000'] }] }).operands.includes('@address'), false, 'a structured adrp operand is not @address evidence');

// Memory displacement payloads follow the same contract.
assert.equal(normalizeInstruction({ mnemonic: 'ldr', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'mem', base: { text: 'x1' }, disp: { value: true } }] }).operands.includes('#8'), false, 'a boolean displacement is not the constant #8');
assert.ok(normalizeInstruction({ mnemonic: 'ldr', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'mem', base: { text: 'x1' }, disp: { value: 8n } }] }).operands.includes('#8]'), 'canonical displacements unchanged');

// Function fingerprints differ between a real constant and a boolean payload.

const fastReal = fingerprintFunctionFast({ architecture: 'arm64', bytes: new Uint8Array(4), instructions: [
  { mnemonic: 'mov', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: 1n }] },
  { mnemonic: 'ret' },
] });
const fastJunk = fingerprintFunctionFast({ architecture: 'arm64', bytes: new Uint8Array(4), instructions: [
  { mnemonic: 'mov', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: true }] },
  { mnemonic: 'ret' },
] });
assert.notEqual(fastReal.normalizedOperandsHash, fastJunk.normalizedOperandsHash, 'the fast fingerprint path also rejects type-corrupted immediates');
assert.notEqual(fingerprintFunctionFast({ architecture: 'arm64', bytes: new Uint8Array(4), instructions: [
  { mnemonic: 'mov', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: '-0x10' }] },
  { mnemonic: 'ret' },
] }), fastJunk, 'signed hex survives the fast path');

const realFn = fingerprintFunction([
  { mnemonic: 'mov', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: 1n }] },
  { mnemonic: 'ret' },
]);
const junkFn = fingerprintFunction([
  { mnemonic: 'mov', parsedOperands: [{ k: 'reg', text: 'x0' }, { k: 'imm', value: true }] },
  { mnemonic: 'ret' },
]);
assert.notEqual(realFn, junkFn, 'type-corrupted operands must not produce the same fingerprint as the real constant');

console.log('issue-5036 fingerprint structured immediate typed contract: ok');
