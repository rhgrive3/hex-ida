import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands, context = {}) {
  const bundle = liftArm64MachineEffects({
    instructionId:`issue-4201:${mnemonic}:${operands}`,
    mnemonic,
    operands,
    opStr:operands,
    ops:parseOperands(operands),
    mode:'a64',
  }, context);
  assert.ok(bundle, `${mnemonic} must remain owned`);
  assert.doesNotThrow(() => validateMachineEffectBundle(bundle));
  return bundle;
}

function accessFault(bundle) {
  return bundle.possibleFaults.find((fault) => fault.kind === 'fp-advsimd-access-trap');
}

test('#4201 generic scalar FP keeps the architectural FP/AdvSIMD access trap possibility', () => {
  const bundle = lift('fmov', 's0, s1');
  const fault = accessFault(bundle);
  assert.ok(fault);
  assert.equal(fault.condition.kind, 'arm64-fp-advsimd-access-check');
  assert.equal(fault.condition.accessState, 'unknown');
  assert.equal(fault.detail.normalCompletionEffectsCommitOnFault, false);
  assert.equal(fault.detail.ordering, 'before-fp-simd-execution');
});

test('#4201 generic Advanced SIMD integer instructions have the same access gate', () => {
  const bundle = lift('add', 'v0.4s, v1.4s, v2.4s');
  assert.ok(accessFault(bundle));
  assert.equal(bundle.metadata.family, 'arm64-simd');
});

test('#4201 scalar FP exception semantics compose after the access check', () => {
  const bundle = lift('fdiv', 's0, s1, s2');
  assert.ok(accessFault(bundle));
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'arm64-floating-point-exception'));
});

test('#4201 bitwise/select/compare exact paths all retain the pre-execution access gate', () => {
  for (const [mnemonic, operands] of [
    ['fabs', 's0, s1'],
    ['fcsel', 's0, s1, s2, eq'],
    ['fcmp', 's0, s1'],
  ]) {
    assert.ok(accessFault(lift(mnemonic, operands)), mnemonic);
  }
});

test('#4201 proof-bearing allowed context removes only the access-trap possibility', () => {
  const bundle = lift('fdiv', 's0, s1, s2', {
    fpAdvSimdAccess:{ state:'allowed', proven:true, source:'validated-execution-context' },
  });
  assert.equal(accessFault(bundle), undefined);
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'arm64-floating-point-exception'));
});

test('#4201 an unproven allowed label cannot suppress the architectural access fault', () => {
  const fault = accessFault(lift('fmov', 's0, s1', {
    fpAdvSimdAccess:{ state:'allowed', source:'unproven-caller-label' },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'unknown');
});

test('#4201 EL0 + CPACR_EL1.FPEN=00 proves that normal FP execution is access-trapped', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{ currentEL:0, cpacrEl1Fpen:0, el2Enabled:false, el3Present:false },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.trapTargetEL, 1);
  assert.equal(fault.condition.reason, 'cpacr-el1-fpen-traps-fp-advsimd');
});

test('#4201 upper-level CPTR trap evidence is retained as a definite access trap', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{ currentEL:0, el2Enabled:true, cptrEl2Tfp:true, el3Present:false },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.trapTargetEL, 2);
});

test('#4201 definite EL2 trapping does not overclaim the target while higher-EL trap state is unknown', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{ currentEL:0, el2Enabled:true, cptrEl2Tfp:true, el3Present:true },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.trapTargetEL, undefined);
});

test('#4201 EL3 CPTR trap evidence is retained when EL3 is known present', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{ currentEL:1, el3Present:true, cptrEl3Tfp:true },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.trapTargetEL, 3);
  assert.equal(fault.condition.reason, 'cptr-el3-tfp-traps-fp-advsimd');
});

test('#4201 non-applicable or malformed raw controls never manufacture a definite trap', () => {
  for (const fpAdvSimdAccess of [
    { currentEL:2, cpacrEl1Fpen:0 },
    { currentEL:0, el2Enabled:false, cptrEl2Tfp:true },
    { currentEL:0, el3Present:false, cptrEl3Tfp:true },
    { currentEL:'0', cpacrEl1Fpen:0 },
  ]) {
    const fault = accessFault(lift('fmov', 's0, s1', { fpAdvSimdAccess }));
    assert.ok(fault);
    assert.equal(fault.condition.accessState, 'unknown');
  }
});

test('#4201 contradictory allowed proof and trapping register evidence fails closed', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{ state:'allowed', proven:true, currentEL:0, cpacrEl1Fpen:0, el2Enabled:false, el3Present:false },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'unknown');
  assert.equal(fault.condition.evidenceConflict, true);
});

test('#4201 non-FP/SIMD instructions do not gain the access fault', () => {
  const bundle = lift('add', 'x0, x1, x2');
  assert.equal(accessFault(bundle), undefined);
});
