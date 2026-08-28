import assert from 'node:assert/strict';
import { createInstructionId } from '../../js/core/identity/index.js';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/index.js';

function instruction(mnemonic, opStr = '', address = 0x2000n) {
  return {
    mnemonic,
    opStr,
    address,
    instructionId: createInstructionId({
      binaryId: 'bin_issue_2383_2384',
      sliceId: 'slice_issue_2383_2384',
      virtualAddress: address,
      decodeMode: 'arm64e',
      decoderSemanticVersion: `issue-2383-2384-${mnemonic}-${opStr}`,
    }),
  };
}

function alignmentFault(bundle) {
  return bundle.possibleFaults?.find((fault) => fault.kind === 'pc-alignment-fault');
}

for (const [mnemonic, operands, kind] of [
  ['braa', 'x1, x2', 'branch'],
  ['brab', 'x1, sp', 'branch'],
  ['braaz', 'x1', 'branch'],
  ['brabz', 'x1', 'branch'],
  ['blraa', 'x1, x2', 'call'],
  ['blrab', 'x1, sp', 'call'],
  ['blraaz', 'x1', 'call'],
  ['blrabz', 'x1', 'call'],
  ['retaa', '', 'return'],
  ['retab', '', 'return'],
]) {
  const bundle = liftArm64eEffects(instruction(mnemonic, operands));
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${mnemonic} must remain exact-with-intrinsic`);
  assert.equal(bundle.controlEffect.kind, kind);
  const fault = alignmentFault(bundle);
  assert.ok(fault, `${mnemonic} must retain A64 PC alignment fault after authentication`);
  assert.deepEqual(fault.condition, { kind: 'target-misaligned', alignmentBytes: 4 });
}

for (const mnemonic of ['braa', 'brab', 'blraa', 'blrab']) {
  const invalid = liftArm64eEffects(instruction(mnemonic, 'x1, xzr'));
  assert.equal(invalid.completeness, 'partial', `${mnemonic} XZR modifier is not a legal non-Z encoding`);
  assert.equal(invalid.controlEffect.kind, 'unknown');
  assert.match(invalid.unknownEffects.reason, /operand shape|modifier/i);

  const validSp = liftArm64eEffects(instruction(mnemonic, 'x1, sp'));
  assert.equal(validSp.completeness, 'exact-with-intrinsic', `${mnemonic} SP modifier is legal`);
  assert.equal(validSp.metadata.modifier.registerId, 'sp');
}

for (const [mnemonic, operands] of [
  ['braa', 'x1'],
  ['braaz', 'x1, x2'],
  ['blraa', 'x1'],
  ['blraaz', 'x1, x2'],
  ['retaa', 'x30'],
]) {
  const bundle = liftArm64eEffects(instruction(mnemonic, operands));
  assert.equal(bundle.completeness, 'partial', `${mnemonic} must reject a nonexistent operand count`);
  assert.equal(bundle.controlEffect.kind, 'unknown');
}

for (const [mnemonic, operands] of [
  ['braa', 'sp, x2'],
  ['braaz', 'sp'],
]) {
  const bundle = liftArm64eEffects(instruction(mnemonic, operands));
  assert.equal(bundle.completeness, 'partial', `${mnemonic} must reject a non-X0..X30 target`);
  assert.equal(bundle.controlEffect.kind, 'unknown');
}

for (const [mnemonic, operands] of [
  ['braa', 'xzr, x2'],
  ['braaz', 'xzr'],
]) {
  const bundle = liftArm64eEffects(instruction(mnemonic, operands));
  assert.equal(bundle.completeness, 'exact-with-intrinsic', `${mnemonic} XZR target is an encodable Rn=31 target`);
}

{
  const decoded = instruction('braa', 'x1, x2');
  decoded.operands = [
    { registerId: 'x1', bits: 64 },
    { registerId: 'xzr', bits: 64 },
  ];
  const bundle = liftArm64eEffects(decoded);
  assert.equal(bundle.completeness, 'partial', 'structured XZR modifier must not be treated as zero modifier');
  assert.equal(bundle.controlEffect.kind, 'unknown');
}

console.log('issues #2383/#2384 arm64e authenticated control: PASS');
