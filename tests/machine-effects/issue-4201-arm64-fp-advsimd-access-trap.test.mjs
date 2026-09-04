import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function instruction(mnemonic, operands, id) {
  return {
    instructionId:id,
    mnemonic,
    operands,
    opStr:operands,
    ops:parseOperands(operands),
    mode:'a64',
    origin:{ instructionIds:[id] },
  };
}

function accessTrap(bundle, label) {
  assert.ok(bundle, `${label}: missing MachineEffects bundle`);
  assert.ok(['exact','exact-with-intrinsic'].includes(bundle.completeness), `${label}: unexpected completeness ${bundle.completeness}`);
  const faults = bundle.possibleFaults.filter((fault) => fault.kind === 'fp-advsimd-access-trap');
  assert.equal(faults.length, 1, `${label}: FP/AdvSIMD access trap must be represented exactly once`);
  const fault = faults[0];
  assert.equal(fault.condition?.kind, 'architectural-access-check', `${label}: access trap must remain environment-conditional`);
  assert.equal(fault.condition?.architecture, 'arm64', `${label}: wrong architecture authority`);
  assert.equal(fault.condition?.access, 'fp-advsimd', `${label}: wrong access class`);
  assert.equal(fault.condition?.check, 'CheckFPAdvSIMDEnabled', `${label}: wrong architectural check`);
  for (const control of ['PSTATE.EL','CPACR_EL1.FPEN','CPTR_EL2.FPEN','CPTR_EL2.TFP','CPTR_EL3.TFP']) {
    assert.ok(fault.condition.controls.includes(control), `${label}: missing access-control authority ${control}`);
  }
  assert.equal(fault.detail?.target, 'environment-dependent-exception-level', `${label}: trap target must not be fabricated`);
  assert.doesNotThrow(() => validateMachineEffectBundle(bundle), `${label}: emitted bundle must satisfy MachineEffects schema`);
  return bundle;
}

for (const [mnemonic, operands] of [
  ['fadd', 's0, s1, s2'],
  ['fmov', 's0, s1'],
  ['fabs', 's0, s1'],
  ['fcmp', 's0, s1'],
  ['fcsel', 's0, s1, s2, eq'],
]) {
  const id = `issue-4201:fp:${mnemonic}`;
  const bundle = accessTrap(liftArm64MachineEffects(instruction(mnemonic, operands, id)), id);
  assert.equal(bundle.metadata.family, 'arm64-fp', `${id}: scalar FP semantics must stay owned by FP family`);
}

const simd = accessTrap(
  liftArm64MachineEffects(instruction('add', 'v0.4s, v1.4s, v2.4s', 'issue-4201:simd:add')),
  'issue-4201:simd:add',
);
assert.equal(simd.metadata.family, 'arm64-simd', 'Advanced SIMD integer semantics must receive the same architectural access gate');

const gpAdd = liftArm64MachineEffects(instruction('add', 'x0, x1, x2', 'issue-4201:integer:add'));
assert.ok(gpAdd);
assert.equal(gpAdd.metadata.family, 'arm64-integer');
assert.equal(gpAdd.possibleFaults.some((fault) => fault.kind === 'fp-advsimd-access-trap'), false,
  'ordinary GP integer instructions must not inherit the FP/AdvSIMD access gate');

const malformed = liftArm64MachineEffects(instruction('fadd', 's0, d1, s2', 'issue-4201:malformed:fadd'));
assert.ok(malformed);
assert.equal(malformed.completeness, 'partial');
assert.equal(malformed.possibleFaults.some((fault) => fault.kind === 'fp-advsimd-access-trap'), false,
  'malformed structured evidence must fail closed before acquiring architectural execution semantics');

console.log('issue #4201 ARM64 FP/AdvSIMD access-trap regression: PASS');
