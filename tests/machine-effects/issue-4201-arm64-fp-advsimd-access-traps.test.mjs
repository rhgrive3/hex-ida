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

function accessState(fpAdvSimdAccess) {
  return accessFault(lift('fadd', 's0, s1, s2', { fpAdvSimdAccess }))?.condition?.accessState ?? 'allowed';
}

const noUpperTrapControls = Object.freeze({ el2Enabled:false, el3Present:false });

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

test('#4201 scalar and vector single memory transfers retain the access trap', () => {
  for (const prefix of ['b', 'h', 's', 'd', 'q']) {
    for (const mnemonic of ['ldr', 'str', 'ldur', 'stur']) {
      const bundle = lift(mnemonic, `${prefix}0, [x2]`);
      assert.equal(bundle.completeness, 'exact', `${mnemonic} ${prefix}`);
      assert.equal(bundle.metadata.family, 'arm64-memory');
      assert.equal(accessFault(bundle)?.condition.accessState, 'unknown', `${mnemonic} ${prefix}`);
      assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'data-abort'));
    }
  }
});

test('#4201 vector pair transfers retain one access trap before both memory accesses', () => {
  for (const prefix of ['s', 'd', 'q']) {
    for (const mnemonic of ['ldp', 'stp', 'ldnp', 'stnp']) {
      const bundle = lift(mnemonic, `${prefix}0, ${prefix}1, [x2]`);
      assert.equal(bundle.completeness, 'exact', `${mnemonic} ${prefix}`);
      assert.equal(bundle.possibleFaults[0]?.kind, 'fp-advsimd-access-trap', `${mnemonic} ${prefix}`);
      assert.equal(bundle.possibleFaults.filter((fault) => fault.kind === 'fp-advsimd-access-trap').length, 1);
      assert.equal(bundle.possibleFaults.filter((fault) => fault.kind === 'data-abort').length, 2);
    }
  }
});

test('#4201 vector literal loads also recognize the operands-array decode surface', () => {
  for (const prefix of ['s', 'd', 'q']) {
    const bundle = liftArm64MachineEffects({
      instructionId:`issue-4201:literal:${prefix}`,
      mnemonic:'ldr',
      address:0x1000n,
      literalTarget:0x1010n,
      operands:parseOperands(`${prefix}0, #0x1010`),
      mode:'a64',
    });
    assert.doesNotThrow(() => validateMachineEffectBundle(bundle));
    assert.equal(bundle.completeness, 'exact');
    assert.equal(bundle.metadata.transfer, 'literal');
    assert.equal(accessFault(bundle)?.condition.accessState, 'unknown', prefix);
  }
});

test('#4201 memory access controls preserve memory effects and unrelated faults', () => {
  for (const [mnemonic, operands] of [['ldr', 'q0, [sp]'], ['stp', 'd0, d1, [sp]']]) {
    const unknown = lift(mnemonic, operands);
    const trapped = lift(mnemonic, operands, {
      fpAdvSimdAccess:{ currentEL:0, cpacrEl1Fpen:0, ...noUpperTrapControls },
    });
    const allowed = lift(mnemonic, operands, {
      fpAdvSimdAccess:{ currentEL:0, cpacrEl1Fpen:3, ...noUpperTrapControls },
    });
    assert.equal(accessFault(trapped)?.condition.accessState, 'trapped');
    assert.equal(accessFault(trapped)?.detail.normalCompletionEffectsCommitOnFault, false);
    assert.equal(accessFault(allowed), undefined);
    assert.deepEqual(trapped.operations, unknown.operations);
    assert.deepEqual(allowed.operations, unknown.operations);
    assert.deepEqual(allowed.possibleFaults,
      unknown.possibleFaults.filter((fault) => fault.kind !== 'fp-advsimd-access-trap'));
    assert.ok(allowed.possibleFaults.some((fault) => fault.kind === 'data-abort'));
    assert.ok(allowed.possibleFaults.some((fault) => fault.kind === 'stack-pointer-alignment-fault'));
  }
});

test('#4201 equivalent FP and SIMD register transfers retain the access gate', () => {
  for (const [mnemonic, operands] of [
    ['fmov', 'd0, x1'], ['fmov', 'x0, d1'],
    ['fmov', 's0, w1'], ['fmov', 'w0, s1'],
    ['ins', 'v0.d[1], x1'], ['umov', 'x0, v1.d[1]'],
    ['smov', 'x0, v1.b[0]'], ['dup', 'v0.4s, w1'],
  ]) {
    const bundle = lift(mnemonic, operands);
    assert.ok(['exact', 'exact-with-intrinsic'].includes(bundle.completeness), `${mnemonic} ${operands}`);
    assert.equal(accessFault(bundle)?.condition.accessState, 'unknown', `${mnemonic} ${operands}`);
  }
});

test('#4201 integer memory transfers and partial vector forms do not gain an access trap', () => {
  for (const [mnemonic, operands] of [
    ['ldr', 'x0, [x2]'], ['str', 'w0, [x2]'],
    ['ldur', 'x0, [x2]'], ['stur', 'w0, [x2]'],
    ['ldp', 'x0, x1, [x2]'], ['stp', 'w0, w1, [x2]'],
  ]) {
    const bundle = lift(mnemonic, operands);
    assert.equal(bundle.completeness, 'exact');
    assert.equal(accessFault(bundle), undefined);
  }
  const partial = lift('ldp', 'q0, q0, [x2]');
  assert.equal(partial.completeness, 'partial');
  assert.equal(accessFault(partial), undefined);
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

test('#4201 a plain claimed allowed proof cannot suppress the architectural access fault', () => {
  const fault = accessFault(lift('fmov', 's0, s1', {
    fpAdvSimdAccess:{ state:'allowed', proven:true, source:'caller-controlled-record' },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'unknown');
});

test('#4201 complete architectural allow state removes only the access-trap possibility', () => {
  const bundle = lift('fdiv', 's0, s1, s2', {
    fpAdvSimdAccess:{
      currentEL:0,
      cpacrEl1Fpen:3,
      el2Enabled:false,
      el3Present:false,
      state:'allowed',
      proven:true,
      source:'validated-execution-context',
    },
  });
  assert.equal(accessFault(bundle), undefined);
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'arm64-floating-point-exception'));
});

test('#4201 CPACR_EL1.FPEN covers every EL0 encoding', () => {
  for (const [cpacrEl1Fpen, expected] of [
    [0, 'trapped'],
    [1, 'trapped'],
    [2, 'trapped'],
    [3, 'allowed'],
  ]) {
    assert.equal(accessState({ currentEL:0, cpacrEl1Fpen, ...noUpperTrapControls }), expected,
      `EL0 FPEN=${cpacrEl1Fpen}`);
  }
});

test('#4201 CPACR_EL1.FPEN covers every EL1 encoding', () => {
  for (const [cpacrEl1Fpen, expected] of [
    [0, 'trapped'],
    [1, 'allowed'],
    [2, 'trapped'],
    [3, 'allowed'],
  ]) {
    assert.equal(accessState({ currentEL:1, cpacrEl1Fpen, ...noUpperTrapControls }), expected,
      `EL1 FPEN=${cpacrEl1Fpen}`);
  }
});

test('#4201 EL0 CPACR_EL1 trap keeps definite EL1 provenance', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{ currentEL:0, cpacrEl1Fpen:1, ...noUpperTrapControls },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.trapTargetEL, 1);
  assert.equal(fault.condition.reason, 'cpacr-el1-fpen-traps-fp-advsimd');
});

test('#4201 VHE host CPTR_EL2.FPEN covers every EL0 encoding', () => {
  for (const [cptrEl2Fpen, expected] of [
    [0, 'trapped'],
    [1, 'trapped'],
    [2, 'trapped'],
    [3, 'allowed'],
  ]) {
    assert.equal(accessState({
      currentEL:0,
      el2Enabled:true,
      hcrEl2E2h:true,
      hcrEl2Tge:true,
      cptrEl2Fpen,
      el3Present:false,
    }), expected, `VHE host EL0 FPEN=${cptrEl2Fpen}`);
  }
});

test('#4201 VHE guest EL0 FPEN=01 does not trap when CPACR_EL1 also allows', () => {
  assert.equal(accessState({
    currentEL:0,
    cpacrEl1Fpen:3,
    el2Enabled:true,
    hcrEl2E2h:true,
    hcrEl2Tge:false,
    cptrEl2Fpen:1,
    el3Present:false,
  }), 'allowed');
});

test('#4201 VHE raw trap wins over a contradictory allowed claim', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{
      state:'allowed',
      proven:true,
      currentEL:0,
      el2Enabled:true,
      hcrEl2E2h:true,
      hcrEl2Tge:true,
      cptrEl2Fpen:1,
      el3Present:false,
    },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.evidenceConflict, true);
});

test('#4201 legacy CPTR_EL2.TFP remains the non-VHE EL2 access control', () => {
  const common = {
    currentEL:0,
    cpacrEl1Fpen:3,
    el2Enabled:true,
    hcrEl2E2h:false,
    el3Present:false,
  };
  assert.equal(accessState({ ...common, cptrEl2Tfp:true }), 'trapped');
  assert.equal(accessState({ ...common, cptrEl2Tfp:false }), 'allowed');
});

test('#4201 definite EL2 trapping does not overclaim the target while EL3 trap state is unknown', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{
      currentEL:0,
      cpacrEl1Fpen:3,
      el2Enabled:true,
      hcrEl2E2h:false,
      cptrEl2Tfp:true,
      el3Present:true,
    },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.trapTargetEL, undefined);
});

test('#4201 EL3 CPTR trap evidence takes precedence over lower-level trap targets', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{
      currentEL:0,
      cpacrEl1Fpen:0,
      el2Enabled:true,
      hcrEl2E2h:false,
      cptrEl2Tfp:true,
      el3Present:true,
      cptrEl3Tfp:true,
    },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.trapTargetEL, 3);
  assert.equal(fault.condition.reason, 'cptr-el3-tfp-traps-fp-advsimd');
});

test('#4201 malformed or incomplete execution-regime controls remain unknown', () => {
  for (const fpAdvSimdAccess of [
    { currentEL:2, cpacrEl1Fpen:0 },
    { currentEL:0, el2Enabled:true, hcrEl2E2h:'true', cptrEl2Fpen:3, cpacrEl1Fpen:3, el3Present:false },
    { currentEL:0, el2Enabled:true, hcrEl2E2h:true, cptrEl2Fpen:1, cpacrEl1Fpen:3, el3Present:false },
    { currentEL:0, el2Enabled:false, el3Present:true },
    { currentEL:'0', cpacrEl1Fpen:0 },
  ]) {
    const fault = accessFault(lift('fmov', 's0, s1', { fpAdvSimdAccess }));
    assert.ok(fault);
    assert.equal(fault.condition.accessState, 'unknown');
  }
});

test('#4201 raw trapping state wins over contradictory caller claimed allowed state', () => {
  const fault = accessFault(lift('fadd', 's0, s1, s2', {
    fpAdvSimdAccess:{
      state:'allowed',
      proven:true,
      currentEL:0,
      cpacrEl1Fpen:1,
      ...noUpperTrapControls,
    },
  }));
  assert.ok(fault);
  assert.equal(fault.condition.accessState, 'trapped');
  assert.equal(fault.condition.evidenceConflict, true);
});

test('#4201 non-FP/SIMD instructions do not gain the access fault', () => {
  const bundle = lift('add', 'x0, x1, x2');
  assert.equal(accessFault(bundle), undefined);
});
