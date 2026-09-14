import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

// Exact-head regression contract: encoding-impossible modifiers must remain fail-closed.
let sequence = 0;
function lift(mnemonic, operands, extra = {}) {
  sequence += 1;
  const instructionId = `arm64-indirect-control-modifier-${sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    operands,
    ops: parseOperands(operands),
    mode: 'a64',
    address: 0x9000n + BigInt(sequence * 4),
    origin: { instructionIds: [instructionId] },
    ...extra,
  });
}

for (const [mnemonic, operands] of [
  ['br', 'x0'],
  ['br', 'xzr'],
  ['blr', 'x30'],
  ['ret', ''],
  ['ret', 'x30'],
]) {
  const bundle = lift(mnemonic, operands);
  assert.equal(bundle.completeness, 'exact', `${mnemonic.toUpperCase()} ${operands} remains a valid indirect-control form`);
}

for (const [mnemonic, operands] of [
  ['br', 'x0, lsl #1'],
  ['br', 'x0, lsr #1'],
  ['br', 'x0, asr #1'],
  ['br', 'x0, ror #1'],
  ['blr', 'x1, uxtw #2'],
  ['ret', 'x30, ror #1'],
]) {
  const bundle = lift(mnemonic, operands);
  assert.equal(bundle.completeness, 'partial', `${mnemonic.toUpperCase()} modifier must fail closed`);
  assert.equal(bundle.controlEffect.kind, 'unknown');
  assert.equal(bundle.unknownEffects.reason, `arm64-${mnemonic}-operand-shape-invalid`);
  assert.equal(bundle.operations.some((operation) => operation.kind === 'register-write' && operation.register?.registerId === 'x30'), false,
    'invalid indirect control must not synthesize a link-register write');
}

for (const [mnemonic, operands] of [
  ['cbz', 'w0, #0xa000'],
  ['cbnz', 'x1, #0xa000'],
  ['tbz', 'w2, #31, #0xa000'],
  ['tbnz', 'x3, #63, #0xa000'],
]) {
  const bundle = lift(mnemonic, operands, { branchTarget: 0xa000n });
  assert.equal(bundle.completeness, 'exact', `${mnemonic.toUpperCase()} normal test-register form remains exact`);
  assert.ok(bundle.controlEffect.kind === 'conditional-branch' || bundle.controlEffect.kind === 'branch');
}

for (const [mnemonic, operands] of [
  ['cbz', 'x0, lsl #1, #0xa000'],
  ['cbnz', 'w1, uxtw #2, #0xa000'],
  ['tbz', 'x2, ror #3, #5, #0xa000'],
  ['tbnz', 'x3, asr #1, #63, #0xa000'],
]) {
  const bundle = lift(mnemonic, operands, { branchTarget: 0xa000n });
  assert.equal(bundle.completeness, 'partial', `${mnemonic.toUpperCase()} test-register modifier must fail closed`);
  assert.equal(bundle.controlEffect.kind, 'unknown');
  assert.equal(bundle.unknownEffects.reason, `arm64-${mnemonic}-operand-shape-invalid`);
}

for (const { mnemonic, operands, extra } of [
  { mnemonic:'b', operands:'#0xa000, lsl #1', extra:{ branchTarget:0xa000n } },
  { mnemonic:'bl', operands:'#0xa000, lsl #1', extra:{ callTarget:0xa000n } },
  { mnemonic:'b.eq', operands:'#0xa000, lsl #1', extra:{ branchTarget:0xa000n } },
  { mnemonic:'cbz', operands:'x0, #0xa000, lsl #1', extra:{ branchTarget:0xa000n } },
  { mnemonic:'tbz', operands:'x0, #0, #0xa000, lsl #1', extra:{ branchTarget:0xa000n } },
]) {
  const bundle = lift(mnemonic, operands, extra);
  assert.equal(bundle.completeness, 'partial', `${mnemonic.toUpperCase()} target modifier must fail closed`);
  assert.equal(bundle.controlEffect.kind, 'unknown');
  assert.equal(bundle.unknownEffects.reason, `arm64-${mnemonic}-operand-shape-invalid`);
  assert.equal(bundle.operations.some((operation) => operation.kind === 'register-write' && operation.register?.registerId === 'x30'), false,
    'invalid direct call target must not synthesize a link-register write');
}

for (const [mnemonic, operands] of [
  ['tbz', 'x0, #1, lsl #1, #0xa000'],
  ['tbnz', 'x1, #63, ror #1, #0xa000'],
]) {
  const bundle = lift(mnemonic, operands, { branchTarget: 0xa000n });
  assert.equal(bundle.completeness, 'partial', `${mnemonic.toUpperCase()} bit-index modifier must fail closed`);
  assert.equal(bundle.controlEffect.kind, 'unknown');
  assert.equal(bundle.unknownEffects.reason, `arm64-${mnemonic}-operand-shape-invalid`);
}

console.log('arm64 control modifier encoding: PASS');
