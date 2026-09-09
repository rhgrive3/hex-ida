import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOperands } from '../../js/arm64.js';
import { validateMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands) {
  const bundle = liftArm64MachineEffects({
    instructionId: `issue-4211:${mnemonic}:${operands}`,
    mnemonic,
    operands,
    opStr: operands,
    ops: parseOperands(operands),
    mode: 'a64',
  });
  assert.ok(bundle, `${mnemonic} must remain owned`);
  assert.doesNotThrow(() => validateMachineEffectBundle(bundle));
  return bundle;
}

function fpTrap(bundle) {
  return bundle.possibleFaults.find((fault) => fault.kind === 'arm64-floating-point-exception');
}

function exceptionTerm(fault, exceptionClass) {
  return fault?.condition?.alternatives?.find((entry) => entry?.exceptionClass === exceptionClass);
}

test('#4211 scalar FDIV exposes the DZE-controlled synchronous FP trap alternative', () => {
  const bundle = lift('fdiv', 's0, s1, s2');
  const fault = fpTrap(bundle);
  assert.ok(fault, 'FDIV must publish a floating-point exception path');
  const dz = exceptionTerm(fault, 'divide-by-zero');
  assert.ok(dz, 'FDIV must retain the divide-by-zero exception class');
  assert.equal(dz.trapEnableBit, 'DZE');
  assert.equal(dz.trapEnableBitIndex, 9);
  assert.equal(fault.condition.fpcrRegisterId, 'fpcr');
  assert.equal(fault.condition.exceptionPredicate, 'operation-raises-class');
  assert.equal(fault.condition.trapSupportPredicate, 'implementation-supports-class');
  assert.equal(fault.detail.normalCompletionEffectsCommitOnFault, false,
    'destination/FPSR writes describe only the non-trapping completion path');
  assert.ok(bundle.operations.some((op) => op.kind === 'register-write' && op.register?.registerId === 'v0'));
  assert.ok(bundle.operations.some((op) => op.kind === 'register-write' && op.register?.registerId === 'fpsr'));
});

test('#4211 DZE=0 is representable by a named FPCR guard rather than an unconditional trap', () => {
  const fault = fpTrap(lift('fdiv', 's0, s1, s2'));
  const dz = exceptionTerm(fault, 'divide-by-zero');
  assert.equal(dz.trapEnableBit, 'DZE');
  assert.equal(dz.trapEnableBitIndex, 9);
  assert.equal(fault.condition.kind, 'arm64-fp-exception-trap');
  assert.equal(fault.condition.operation, 'fdiv');
});

test('#4211 FCMPE exposes the IOE-controlled invalid-operation trap without losing NZCV/FPSR normal semantics', () => {
  const bundle = lift('fcmpe', 's0, s1');
  const fault = fpTrap(bundle);
  const invalid = exceptionTerm(fault, 'invalid-operation');
  assert.ok(invalid);
  assert.equal(invalid.trapEnableBit, 'IOE');
  assert.equal(invalid.trapEnableBitIndex, 8);
  assert.ok(bundle.operations.some((op) => op.kind === 'register-write' && op.register?.registerId === 'nzcv'));
  assert.ok(bundle.operations.some((op) => op.kind === 'register-write' && op.register?.registerId === 'fpsr'));
});

test('#4211 arithmetic retains overflow/underflow/inexact trap controls', () => {
  const fault = fpTrap(lift('fmul', 'd0, d1, d2'));
  for (const [exceptionClass, bit, bitIndex] of [
    ['overflow', 'OFE', 10],
    ['underflow', 'UFE', 11],
    ['inexact', 'IXE', 12],
  ]) {
    const term = exceptionTerm(fault, exceptionClass);
    assert.ok(term, exceptionClass);
    assert.equal(term.trapEnableBit, bit);
    assert.equal(term.trapEnableBitIndex, bitIndex);
  }
});

test('#4211 vector FP uses the same FPCR trap policy while status-free FP bit operations do not', () => {
  const vector = lift('fdiv', 'v0.4s, v1.4s, v2.4s');
  const fault = fpTrap(vector);
  assert.ok(exceptionTerm(fault, 'divide-by-zero'));
  assert.ok(exceptionTerm(fault, 'overflow'));
  assert.equal(fault.detail.normalCompletionEffectsCommitOnFault, false);

  const scalarMove = lift('fmov', 's0, s1');
  assert.equal(fpTrap(scalarMove), undefined, 'bit-preserving FMOV does not gain a spurious FP exception path');
  const vectorNeg = lift('fneg', 'v0.4s, v1.4s');
  assert.equal(fpTrap(vectorNeg), undefined, 'status-free vector FNEG does not gain a spurious FP exception path');
});

test('#4211 conditional FCCMPE faults only on the executed compare arm', () => {
  const bundle = lift('fccmpe', 's0, s1, #0, eq');
  const fault = fpTrap(bundle);
  const invalid = exceptionTerm(fault, 'invalid-operation');
  assert.ok(invalid);
  const guard = fault?.condition?.executionCondition;
  assert.ok(guard, 'conditional compare fault must retain the NZCV execution predicate');
  assert.equal(guard.kind, 'arm64-condition-holds');
  assert.equal(guard.condition, 'eq');
  assert.equal(guard.nzcv?.kind, 'temporary');
  assert.ok(String(guard.nzcv?.temporaryId).includes('old-nzcv'));
});

test('#4211 only FRINTX exposes an inexact trap among scalar FRINT forms', () => {
  for (const mnemonic of ['frinta','frintm','frintn','frintp','frinti','frintz']) {
    const fault = fpTrap(lift(mnemonic, 's0, s1'));
    assert.equal(exceptionTerm(fault, 'inexact'), undefined,
      `${mnemonic} uses exact=FALSE and must not expose IXE`);
  }
  const exact = fpTrap(lift('frintx', 's0, s1'));
  assert.ok(exceptionTerm(exact, 'inexact'), 'FRINTX uses exact=TRUE and can expose IXE');
});
