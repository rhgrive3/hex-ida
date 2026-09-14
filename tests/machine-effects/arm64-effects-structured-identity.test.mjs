import assert from 'node:assert/strict';
import { createArm64EffectContext, canonicalIdentityString, canonicalIdentityStringList } from '../../js/targets/architecture/arm64/effects/common.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function intInstruction(overrides = {}) {
  return {
    instructionId: 'arm64-ctx-identity-1',
    mnemonic: 'add',
    mode: 'a64',
    address: 0x1000n,
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'reg', cls: 'gp', num: 1, bits: 64, text: 'x1' },
      { k: 'reg', cls: 'gp', num: 2, bits: 64, text: 'x2' },
    ],
    origin: { instructionIds: ['arm64-ctx-identity-1'] },
    ...overrides,
  };
}

function assertThrows(label, fn, code) {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `${label}: structured identity must fail closed, not launder through String()`);
  if (code) assert.match(String(thrown.message), new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${label}: expected ${code}`);
}

// Context boundary: instructionId/mode must be primitive strings.
assertThrows('context array instructionId', () => createArm64EffectContext({ instructionId: ['insn:1'], mnemonic: 'nop', ops: [] }), 'arm64-effects-instruction-id-required');
assertThrows('context object instructionId', () => createArm64EffectContext({ instructionId: { id: 'insn:1' }, mnemonic: 'nop', ops: [] }), 'arm64-effects-instruction-id-required');
assertThrows('context empty instructionId', () => createArm64EffectContext({ instructionId: '   ', mnemonic: 'nop', ops: [] }), 'arm64-effects-instruction-id-required');
assertThrows('context array mode', () => createArm64EffectContext({ instructionId: 'insn:1', mode: ['a64'], mnemonic: 'nop', ops: [] }), 'arm64-effects-mode-invalid');
assertThrows('context object mode', () => createArm64EffectContext({ instructionId: 'insn:1', mode: { name: 'a64' }, mnemonic: 'nop', ops: [] }), 'arm64-effects-mode-invalid');
assertThrows('context numeric mode', () => createArm64EffectContext({ instructionId: 'insn:1', mode: 7, mnemonic: 'nop', ops: [] }), 'arm64-effects-mode-invalid');

// Origin identity lists must be string lists, not String()-coerced values.
// originInput runs at finish(), so drive it through a completed context.
function finishContext(instruction) {
  const ctx = createArm64EffectContext(instruction);
  return ctx.finish();
}
assertThrows('origin nested-array instructionIds', () => finishContext(intInstruction({ origin: { instructionIds: [['origin:1']] } })));
assertThrows('origin object instructionIds', () => finishContext(intInstruction({ origin: { instructionIds: { id: 'origin:1' } } })));
assertThrows('origin array operationIds', () => finishContext(intInstruction({ origin: { instructionIds: ['arm64-ctx-identity-1'], bytecodeOperationIds: [['op:1']] } })));
assertThrows('origin non-object', () => finishContext(intInstruction({ origin: 'origin:1' })));

// Whole-lifter boundaries: integer family, system family, SIMD, FP, top-level.
assertThrows('integer family array instructionId', () => liftArm64MachineEffects(intInstruction({ instructionId: ['arm64-ctx-identity-1'] })));
assertThrows('system family array instructionId', () => liftArm64MachineEffects(intInstruction({ instructionId: ['arm64-ctx-identity-1'], mnemonic: 'nop', ops: [] })));
assertThrows('simd family array instructionId', () => liftArm64MachineEffects(intInstruction({
  instructionId: ['arm64-ctx-identity-1'],
  mnemonic: 'add',
  ops: [
    { k: 'reg', cls: 'vec', num: 0, bits: 128, arr: '4s', text: 'v0.4s' },
    { k: 'reg', cls: 'vec', num: 1, bits: 128, arr: '4s', text: 'v1.4s' },
    { k: 'reg', cls: 'vec', num: 2, bits: 128, arr: '4s', text: 'v2.4s' },
  ],
})));
assertThrows('fp family array instructionId', () => liftArm64MachineEffects(intInstruction({
  instructionId: ['arm64-ctx-identity-1'],
  mnemonic: 'fadd',
  ops: [
    { k: 'reg', cls: 'fp', num: 0, bits: 64, text: 'd0' },
    { k: 'reg', cls: 'fp', num: 1, bits: 64, text: 'd1' },
    { k: 'reg', cls: 'fp', num: 2, bits: 64, text: 'd2' },
  ],
})));
assertThrows('origin nested-array through lifter', () => liftArm64MachineEffects(intInstruction({ origin: { instructionIds: [['origin:1']] } })));

// Canonical primitives keep their exact results.
const good = liftArm64MachineEffects(intInstruction());
assert.equal(good?.completeness, 'exact');
assert.equal(good?.instructionId, 'arm64-ctx-identity-1');

const modeDefault = createArm64EffectContext({ instructionId: 'insn:2', mnemonic: 'nop', ops: [] });
assert.equal(modeDefault.mode, 'a64');

// Helper contract itself.
assert.equal(canonicalIdentityString(' id ', 'x'), 'id');
assert.deepEqual(canonicalIdentityStringList(null, 'x'), []);
assert.deepEqual(canonicalIdentityStringList(['a', ' b '], 'x'), ['a', 'b']);
assertThrows('helper rejects array', () => canonicalIdentityString(['a'], 'x-error'));
assertThrows('helper list rejects object entries', () => canonicalIdentityStringList(['a', {}], 'x-error'));

console.log('ARM64 MachineEffects structured identity fail-closed validation: PASS');
