// AArch64 FMOV (general) element form: the general-purpose source register is
// written into one addressed vector element while the remaining elements keep
// their prior values (merge-selected-lane). Only the S (32-bit, W source) and
// D (64-bit, X source) element forms exist; every other shape fails closed as
// an explicit partial effect instead of borrowing the INS lane-insert form.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOperands } from '../../js/arm64.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64SimdEffects } from '../../js/targets/architecture/arm64/effects/simd.js';

function instruction(mnemonic, operands) {
  return { mnemonic, operands, opStr: operands, ops: parseOperands(operands), mode:'a64',
    instructionId:`arm64-fmov:${mnemonic}:${operands}`, origin:{ instructionIds:[`arm64-fmov:${mnemonic}:${operands}`] } };
}
function lift(mnemonic, operands) {
  return liftArm64MachineEffects(instruction(mnemonic, operands));
}
const intrinsicOf = (effect) => effect?.operations.find((operation) => operation.kind === 'intrinsic');
const writes = (effect, registerId) => effect.operations
  .filter((operation) => operation.kind === 'register-write' && operation.register?.registerId === registerId);
const reads = (effect, registerId) => effect.operations
  .filter((operation) => operation.kind === 'register-read' && operation.register?.registerId === registerId);
const assertPartial = (effect, reason) => {
  assert.ok(effect, 'SIMD-owned malformed FMOV must fail closed rather than disappear');
  assert.equal(effect.completeness, 'partial');
  assert.match(effect.unknownEffects.reason, reason);
};

test('FMOV D element from X is an exact merge-lane insert', () => {
  const effect = lift('fmov', 'v0.d[1], x5');
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.doesNotThrow(() => validateMachineEffectBundle(effect));
  const intrinsic = intrinsicOf(effect);
  assert.equal(intrinsic.intrinsicId, 'arm64.simd.fmov.lane-insert');
  assert.equal(intrinsic.metadata.destinationLane, 1);
  assert.equal(intrinsic.metadata.laneWidthBits, 64);
  assert.equal(intrinsic.metadata.sourceLane, null, 'the general-purpose source carries no lane index');
  assert.ok(reads(effect, 'v0').length >= 1, 'the untouched prior destination lanes must be read');
  assert.ok(reads(effect, 'x5').length === 1, 'the general-purpose source must be read');
  const write = writes(effect, 'v0')[0];
  assert.equal(write.register.widthBits, 128, 'the physical vector register is written whole');
  assert.equal(write.metadata.laneWritten, 1);
  assert.equal(write.metadata.destinationSemantics, 'merge-selected-lane');
});

test('FMOV S element from W is an exact merge-lane insert', () => {
  const effect = lift('fmov', 'v0.s[1], w1');
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  const intrinsic = intrinsicOf(effect);
  assert.equal(intrinsic.metadata.laneWidthBits, 32);
  // A `w` operand names the low 32 bits of the physical x register: the exact
  // machine effect reads x1 once and publishes the 32-bit architectural view as
  // an explicit low-bits truncation, never as a separate invented register.
  const read = reads(effect, 'x1')[0];
  assert.ok(read, 'the physical general-purpose source x1 must be read');
  assert.equal(read.metadata.architecturalViewRead, 'w1');
  const truncation = effect.operations.find((operation) => operation.kind === 'value'
    && operation.opcode === 'truncate' && operation.metadata?.readPolicy === 'low-bits');
  assert.ok(truncation, 'the 32-bit W view must be an explicit low-bits truncation of the 64-bit read');
  assert.equal(truncation.metadata.fromBits, 64);
  assert.equal(truncation.metadata.toBits, 32);
  assert.ok(writes(effect, 'v0').length === 1);
});

test('FMOV element forms that do not exist stay explicitly partial', () => {
  assertPartial(lift('fmov', 'v0.b[0], w1'), /fmov-element-width-unavailable/);
  assertPartial(lift('fmov', 'v0.h[1], w1'), /fmov-element-width-unavailable/);
  assertPartial(lift('fmov', 'v0.d[1], w1'), /fmov-general-source-unavailable/);
  assertPartial(lift('fmov', 'v0.d[1], v1.d[1]'), /fmov-general-source-unavailable/);
});

test('FMOV vector-arrangement forms are not lane moves and stay unsupported', () => {
  assertPartial(lift('fmov', 'v0.2d, x0'), /arm64-simd-instruction-unsupported:fmov/);
  assertPartial(lift('fmov', 'x0, v0.2d'), /arm64-simd-instruction-unsupported:fmov/);
});

test('scalar FMOV stays owned by the FP lifter', () => {
  assert.equal(lift('fmov', 's0, s1').completeness, 'exact');
  assert.equal(lift('fmov', 'd0, x5').completeness, 'exact');
  assert.equal(lift('fmov', 'x5, d0').completeness, 'exact');
  assert.equal(liftArm64SimdEffects(instruction('fmov', 'v0.d[1], x5')).completeness, 'exact-with-intrinsic');
});

console.log('arm64 FMOV (general) element lane effects: PASS');
