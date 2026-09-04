import assert from 'node:assert/strict';

import { parseOperands as parseArm64Operands } from '../../js/arm64.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { parseOperands as parseSimdOperands } from '../../js/ui/explain/arm64-operands.js';

const ACCESS_CONTROLS = [
  'CPACR_EL1.FPEN',
  'CPTR_EL2.FPEN',
  'CPTR_EL2.TFP',
  'CPTR_EL3.TFP',
];

function lift(mnemonic, operands, id, parse = parseArm64Operands, context = {}) {
  return liftArm64MachineEffects({
    instructionId:id,
    mnemonic,
    ops:parse(operands),
    mode:'a64',
    origin:{ instructionIds:[id] },
  }, context);
}

function fpAdvSimdAccessFault(bundle) {
  return bundle.possibleFaults.find((fault) =>
    fault?.kind === 'system-instruction-trap'
    && fault?.condition?.kind === 'architectural-access-check'
    && fault?.condition?.operation === 'fp-advsimd');
}

for (const [mnemonic, operands] of [
  ['fadd', 's0, s1, s2'],
  ['fmov', 's0, s1'],
  ['fabs', 's0, s1'],
  ['fcmp', 's0, s1'],
  ['fcsel', 's0, s1, s2, eq'],
]) {
  const id = `issue-4201-scalar-${mnemonic}`;
  const bundle = lift(mnemonic, operands, id);
  assert.ok(bundle, `${mnemonic}:missing-bundle`);
  assert.ok(['exact','exact-with-intrinsic'].includes(bundle.completeness), `${mnemonic}:unexpected-completeness`);
  assert.equal(bundle.metadata.family, 'arm64-fp', `${mnemonic}:wrong-family`);
  const fault = fpAdvSimdAccessFault(bundle);
  assert.ok(fault, `${mnemonic}:missing-FP-AdvSIMD-access-trap`);
  assert.equal(fault.condition.resolution, 'unknown');
  assert.equal(fault.detail.architecturalCheck, 'CheckFPAdvSIMDEnabled');
  assert.deepEqual(fault.detail.controls, ACCESS_CONTROLS);
  assert.doesNotThrow(() => validateMachineEffectBundle(bundle), `${mnemonic}:invalid-bundle`);
}

const trapContext = {
  fpAdvSimdAccess:{
    state:'trap',
    source:'arm64-access-control-proof',
    evidence:{ currentEL:'EL0', CPACR_EL1:{ FPEN:0 } },
  },
};
const trapped = lift('fadd', 's0, s1, s2', 'issue-4201-resolved-trap', parseArm64Operands, trapContext);
const resolvedTrap = fpAdvSimdAccessFault(trapped);
assert.ok(resolvedTrap, 'explicit trap authority must retain the access fault');
assert.equal(resolvedTrap.condition.resolution, 'trap');
assert.equal(resolvedTrap.condition.source, 'arm64-access-control-proof');
assert.deepEqual(resolvedTrap.condition.evidence, trapContext.fpAdvSimdAccess.evidence);
assert.equal(trapped.metadata.fpAdvSimdAccessCheck, 'trap-by-explicit-authority');
assert.doesNotThrow(() => validateMachineEffectBundle(trapped));

const allowed = lift('fadd', 's0, s1, s2', 'issue-4201-resolved-allowed', parseArm64Operands, {
  fpAdvSimdAccess:{ state:'allowed', source:'arm64-access-control-proof', evidence:{ currentEL:'EL0', effectiveAccess:'enabled' } },
});
assert.equal(fpAdvSimdAccessFault(allowed), undefined, 'explicit allowed authority may remove the access trap');
assert.equal(allowed.metadata.fpAdvSimdAccessCheck, 'allowed-by-explicit-authority');
assert.doesNotThrow(() => validateMachineEffectBundle(allowed));

const malformedAuthority = lift('fadd', 's0, s1, s2', 'issue-4201-malformed-authority', parseArm64Operands, {
  fpAdvSimdAccess:'allowed',
});
assert.ok(fpAdvSimdAccessFault(malformedAuthority), 'non-structured authority must fail closed to an unresolved trap possibility');
assert.equal(fpAdvSimdAccessFault(malformedAuthority).condition.resolution, 'unknown');

const vector = lift('add', 'v0.4s, v1.4s, v2.4s', 'issue-4201-vector-add', parseSimdOperands);
assert.ok(vector, 'vector-add:missing-bundle');
assert.ok(['exact','exact-with-intrinsic'].includes(vector.completeness), 'vector-add:unexpected-completeness');
assert.equal(vector.metadata.family, 'arm64-simd');
assert.ok(fpAdvSimdAccessFault(vector), 'integer AdvSIMD ADD must retain the architectural access trap possibility');
assert.doesNotThrow(() => validateMachineEffectBundle(vector));

const integer = lift('add', 'x0, x1, x2', 'issue-4201-integer-add');
assert.ok(integer, 'integer-add:missing-bundle');
assert.equal(integer.metadata.family, 'arm64-integer');
assert.equal(fpAdvSimdAccessFault(integer), undefined, 'ordinary integer instructions must not gain an FP/AdvSIMD access trap');
assert.doesNotThrow(() => validateMachineEffectBundle(integer));

const malformed = lift('fadd', 's0, d1, s2', 'issue-4201-malformed-fadd');
assert.ok(malformed, 'malformed-fadd:missing-bundle');
assert.equal(malformed.completeness, 'partial', 'malformed FP evidence must remain fail-closed');
assert.equal(fpAdvSimdAccessFault(malformed), undefined, 'a fail-closed partial must not be promoted by the access-trap decorator');
assert.doesNotThrow(() => validateMachineEffectBundle(malformed));

console.log('issue #4201 ARM64 FP/AdvSIMD access-trap regression: PASS');
