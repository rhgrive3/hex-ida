import assert from 'node:assert/strict';

import { liftArm64SystemEffects } from '../js/targets/architecture/arm64/effects/system.js';

function lift(mnemonic, ops = []) {
  return liftArm64SystemEffects({
    instructionId:`issue-1902:${mnemonic}:${ops[0]?.value ?? 'omitted'}`,
    mnemonic,
    mode:'a64',
    ops,
  });
}

function immediate(value) {
  return { k:'imm', value:BigInt(value), text:`#${value}` };
}

for (const value of [0, 127]) {
  const effect = lift('hint', [immediate(value)]);
  assert.ok(effect, `hint #${value}:effect-required`);
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(effect.operations.some((operation) => operation.kind === 'unknown'), false);
}

for (const value of [-1, 128]) {
  const effect = lift('hint', [immediate(value)]);
  assert.ok(effect, `hint #${value}:fail-closed-effect-required`);
  assert.equal(effect.completeness, 'partial');
  assert.equal(effect.unknownEffects?.reason, 'generic-hint-imm7-out-of-range');
  assert.ok(effect.operations.some((operation) => operation.kind === 'unknown'));
}

for (const value of [0, 15]) {
  const effect = lift('clrex', [immediate(value)]);
  assert.ok(effect, `clrex #${value}:effect-required`);
  assert.equal(effect.completeness, 'exact-with-intrinsic');
  assert.equal(effect.operations.some((operation) => operation.kind === 'unknown'), false);
}

for (const value of [-1, 16]) {
  const effect = lift('clrex', [immediate(value)]);
  assert.ok(effect, `clrex #${value}:fail-closed-effect-required`);
  assert.equal(effect.completeness, 'partial');
  assert.equal(effect.unknownEffects?.reason, 'clrex-imm4-out-of-range');
  assert.ok(effect.operations.some((operation) => operation.kind === 'unknown'));
}

const omitted = lift('clrex');
assert.ok(omitted, 'clrex omitted immediate:effect-required');
assert.equal(omitted.completeness, 'exact-with-intrinsic');
assert.equal(omitted.operations.some((operation) => operation.kind === 'unknown'), false);

console.log('ARM64 HINT/CLREX immediate validation (#1902): PASS');
