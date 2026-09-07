import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function lift(mnemonic, operands) {
  sequence += 1;
  const instructionId = `arm64-system-immediate-modifier-${sequence}`;
  return liftArm64SystemEffects({
    instructionId,
    mnemonic,
    operands,
    ops: parseOperands(operands),
    mode: 'a64',
    address: 0xb000n + BigInt(sequence * 4),
    origin: { instructionIds: [instructionId] },
  });
}

for (const [mnemonic, operands] of [
  ['svc', '#0'],
  ['svc', '#65535'],
  ['clrex', '#0'],
  ['clrex', '#15'],
  ['hint', '#0'],
  ['hint', '#127'],
  ['msr', 'daifset, #0'],
  ['msr', 'daifset, #15'],
  ['sys', '#0, c7, c5, #0, x0'],
  ['sys', '#7, c15, c15, #7, xzr'],
]) {
  const bundle = lift(mnemonic, operands);
  assert.ok(bundle.completeness === 'exact' || bundle.completeness === 'exact-with-intrinsic',
    `${mnemonic.toUpperCase()} ${operands} must preserve its valid encoding boundary`);
}

for (const { mnemonic, operands, reason } of [
  { mnemonic:'svc', operands:'#1, lsl #1', reason:'svc-immediate-unavailable' },
  { mnemonic:'hvc', operands:'#1, lsl #1', reason:'hvc-immediate-unavailable' },
  { mnemonic:'smc', operands:'#1, lsl #1', reason:'smc-immediate-unavailable' },
  { mnemonic:'brk', operands:'#1, lsl #1', reason:'brk-immediate-unavailable' },
  { mnemonic:'hlt', operands:'#1, lsl #1', reason:'hlt-immediate-unavailable' },
  { mnemonic:'clrex', operands:'#1, lsl #1', reason:'clrex-immediate-unavailable' },
  { mnemonic:'hint', operands:'#1, lsl #1', reason:'generic-hint-immediate-unavailable' },
  { mnemonic:'msr', operands:'daifset, #1, lsl #1', reason:'msr-operand-shape-invalid' },
  { mnemonic:'sys', operands:'#1, lsl #1, c7, c5, #0, x0', reason:'sys-operand-shape-invalid' },
  { mnemonic:'sys', operands:'#1, c7, c5, #0, lsl #1, x0', reason:'sys-operand-shape-invalid' },
]) {
  const bundle = lift(mnemonic, operands);
  assert.equal(bundle.completeness, 'partial', `${mnemonic.toUpperCase()} modified immediate must fail closed`);
  assert.equal(bundle.unknownEffects.reason, reason);
  assert.equal(bundle.operations.some((operation) => operation.kind === 'intrinsic'), false,
    'encoding-impossible system immediates must not emit a definite intrinsic/environment effect');
  assert.notEqual(bundle.controlEffect.kind, 'trap',
    'encoding-impossible trap immediates must not synthesize a definite trap');
}

const canonicalClrexInstructionId = 'arm64-system-immediate-modifier-canonical-clrex';
const canonicalClrex = liftArm64MachineEffects({
  instructionId:canonicalClrexInstructionId,
  mnemonic:'clrex',
  operands:'#1, lsl #1',
  ops:parseOperands('#1, lsl #1'),
  mode:'a64',
  origin:{instructionIds:[canonicalClrexInstructionId]},
});
assert.equal(canonicalClrex.completeness, 'partial', 'canonical memory/atomic owner must reject modified CLREX imm4');
assert.equal(canonicalClrex.operations.some((operation) => operation.kind === 'intrinsic' || operation.kind === 'register-write'), false,
  'invalid canonical CLREX must not clear or mutate exclusive-monitor state');

console.log('arm64 system immediate modifier encoding: PASS');
