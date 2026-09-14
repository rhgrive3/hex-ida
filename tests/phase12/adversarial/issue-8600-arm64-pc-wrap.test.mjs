// Issue #8600 regression: ARM64 next-PC and link-register facts must wrap at
// the architectural 64-bit boundary instead of exposing a 65-bit address.
import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64eEffects } from '../../../js/targets/architecture/arm64e/effects.js';

const LAST_INSTRUCTION = 0xfffffffffffffffcn;

const normal = liftArm64MachineEffects({
  instructionId: 'issue-8600-normal-bl',
  mode: 'a64',
  address: LAST_INSTRUCTION,
  mnemonic: 'bl',
  callTarget: 0n,
  ops: [{ k: 'imm', value: 0n }],
  rawBytes: [0x01, 0x00, 0x00, 0x94],
  origin: { instructionIds: ['issue-8600-normal-bl'] },
});
assert.equal(normal.completeness, 'exact');
assert.equal(normal.controlEffect.fallthrough.value, '0');
const normalLink = normal.operations.find((operation) => operation.kind === 'register-write' && operation.register.registerId === 'x30');
assert.equal(normalLink.value.value, '0');

const authenticated = liftArm64eEffects({
  instructionId: 'issue-8600-authenticated-blraa',
  mode: 'arm64e',
  address: LAST_INSTRUCTION,
  mnemonic: 'blraaz',
  opStr: 'x6',
  origin: { instructionIds: ['issue-8600-authenticated-blraa'] },
});
assert.equal(authenticated.completeness, 'exact-with-intrinsic');
const authenticatedLink = authenticated.operations.find((operation) => operation.kind === 'register-write' && operation.register.registerId === 'x30');
assert.equal(authenticatedLink.value.value, '0');

console.log('ARM64 PC+4 uint64 wrap (#8600): PASS');
