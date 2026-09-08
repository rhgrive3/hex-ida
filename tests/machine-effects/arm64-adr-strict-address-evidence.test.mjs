import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function adr(mnemonic, pcRelTarget, address = 0n, targetOperand = null) {
  sequence += 1;
  const instructionId = `arm64-adr-strict-evidence-${sequence}`;
  return {
    instructionId,
    architectureId: 'arm64',
    mode: 'a64',
    mnemonic,
    address,
    ...(pcRelTarget === undefined ? {} : { pcRelTarget }),
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      targetOperand ?? { k: 'other', text: 'symbolic-target' },
    ],
    origin: { instructionIds: [instructionId] },
  };
}

function assertExact(effect, label) {
  assert.ok(effect, `${label}: effect required`);
  assert.equal(effect.completeness, 'exact', `${label}: canonical evidence must stay exact`);
}

function assertClosed(effect, label) {
  assert.ok(effect, `${label}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${label}: schema-invalid evidence must be partial`);
  assert.equal(effect.operations.length, 0, `${label}: schema-invalid evidence must emit zero definite operations`);
}

const otherNumeric = (text) => ({ k: 'other', text });

// Canonical bigint evidence keeps its exact results through every gate.
for (const [label, decoded] of [
  ['adr canonical bigint', adr('adr', 4096n)],
  ['adr canonical number', adr('adr', 4096, 0)],
  ['adr canonical hex text', adr('adr', '0x1000')],
  ['adr canonical negative text', adr('adr', '-4096')],
  ['adrp canonical page target', adr('adrp', 4096n * 4096n)],
]) {
  assertExact(liftArm64MachineEffects(decoded), label);
  assertExact(liftArm64IntegerEffects(decoded), `${label} (integer family)`);
}

// Structured schema-invalid targets must never coerce into exact addresses.
for (const [label, invalid] of [
  ['array target', [4096]],
  ['array of text target', ['4096']],
  ['boolean target', true],
  ['object target', { value: 4096 }],
  ['malformed text target', '4096xyz'],
]) {
  assertClosed(liftArm64MachineEffects(adr('adr', invalid)), `ADR ${label}`);
  assertClosed(liftArm64MachineEffects(adr('adrp', invalid)), `ADRP ${label}`);
  assertClosed(liftArm64IntegerEffects(adr('adr', invalid)), `ADR ${label} (integer family)`);
}

// A numeric `other` target keeps its text-grammar authority; a nonnumeric
// operand plus an invalid structured target must not become an exact result.
assertExact(liftArm64MachineEffects(adr('adr', 4096n, 0n, otherNumeric('#0x1000'))), 'ADR numeric other operand');
assertClosed(liftArm64MachineEffects(adr('adr', [4096], 0n, otherNumeric('symbolic'))), 'ADR symbolic operand + array target');

// Structured address evidence feeds the encoding-range authority and must obey
// the same contract.
for (const [label, address] of [
  ['array address', [0]],
  ['boolean address', true],
  ['object address', {}],
]) {
  assertClosed(liftArm64MachineEffects(adr('adr', 4096n, address)), `ADR ${label}`);
  assertClosed(liftArm64IntegerEffects(adr('adr', 4096n, address)), `ADR ${label} (integer family)`);
}

// Literal-load (LDR/PRFM) structured target evidence uses the same canonical
// contract at the shared helper boundary.
let literalSequence = 0;
const literal = (mnemonic, literalTarget) => {
  literalSequence += 1;
  const instructionId = `arm64-adr-strict-evidence-literal-${literalSequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    mode: 'a64',
    address: 0n,
    ...(literalTarget === undefined ? {} : { literalTarget }),
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'imm', value: 4096n, text: '#0x1000' },
    ],
    origin: { instructionIds: [instructionId] },
  });
};
assertExact(literal('ldr', 4096n), 'LDR literal canonical target');
assertClosed(literal('ldr', [4096]), 'LDR literal array target');
assertClosed(literal('ldr', true), 'LDR literal boolean target');

console.log('ARM64 ADR/ADRP strict address evidence validation: PASS');
