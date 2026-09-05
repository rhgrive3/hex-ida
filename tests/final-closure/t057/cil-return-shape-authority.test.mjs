import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';

function op({ completeness = 'exact', controlEffects = [{ kind: 'return' }], callEffects = [] } = {}) {
  return {
    bytecodeOffset: 0,
    operationId: 'op:t057:return',
    consumedValues: [],
    producedValues: [{ bits: 32 }],
    controlEffects,
    callEffects,
    completeness,
  };
}

function validate({ context = {}, bundle = op() } = {}) {
  return validateCilEffectFunction({
    methodId: 'managed-method:t057:return-shape',
    profileId: 'ecma-335',
    bundles: [bundle],
    entryState: { maxStack: 1 },
    exceptionRegions: [],
  }, context);
}

function dataflowFact(report) {
  return report.verifierFacts.find((fact) => fact.code === 'cil-stack-dataflow-validated');
}

test('T057 keeps a return method partial without explicit return-shape authority', () => {
  const report = validate();

  assert.equal(report.status, 'partial');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.completeness, {
    structural: 'complete',
    specValidation: 'partial',
    semanticEffect: 'complete',
    resolution: 'complete',
  });
  assert.deepEqual(report.warnings, [
    { code: 'cil-return-stack-shape-unavailable' },
  ]);
  assert.equal(dataflowFact(report)?.returnStackSlots, null);
});

test('T057 accepts valid only with the explicit one-slot return authority', () => {
  const report = validate({ context: { returnStackSlots: 1 } });

  assert.equal(report.status, 'valid');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.completeness, {
    structural: 'complete',
    specValidation: 'valid',
    semanticEffect: 'complete',
    resolution: 'complete',
  });
  assert.equal(dataflowFact(report)?.returnStackSlots, 1);
});

test('T057 rejects an explicit return-shape mismatch without weakening other completeness dimensions', () => {
  for (const expected of [0, 2]) {
    const report = validate({ context: { returnStackSlots: expected } });

    assert.equal(report.status, 'invalid');
    assert.equal(report.errors.length, 1);
    assert.deepEqual(report.errors[0], {
      code: 'cil-return-stack-shape-invalid',
      operationId: 'op:t057:return',
      bytecodeOffset: 0,
      stackHeight: 1,
      expected,
    });
    assert.deepEqual(report.completeness, {
      structural: 'complete',
      specValidation: 'failed',
      semanticEffect: 'complete',
      resolution: 'complete',
    });
  }
});

test('T057 does not treat coercive or non-primitive authority as proof', () => {
  for (const returnStackSlots of ['1', new Number(1), 1n, -1, NaN, Infinity]) {
    const report = validate({ context: { returnStackSlots } });

    assert.equal(report.status, 'partial');
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.some((warning) => warning.code === 'cil-return-stack-shape-unavailable'));
    assert.equal(dataflowFact(report)?.returnStackSlots, null);
  }
});

test('T057 preserves semantic, resolution, and structural negatives with explicit authority', () => {
  const incompleteEffect = validate({
    context: { returnStackSlots: 1 },
    bundle: op({ completeness: 'partial' }),
  });
  assert.equal(incompleteEffect.status, 'partial');
  assert.equal(incompleteEffect.completeness.semanticEffect, 'partial');

  const unresolvedCall = validate({
    context: { returnStackSlots: 1 },
    bundle: op({ callEffects: [{ kind: 'call', target: 'unknown' }] }),
  });
  assert.equal(unresolvedCall.status, 'partial');
  assert.equal(unresolvedCall.completeness.resolution, 'partial');
  assert.ok(unresolvedCall.warnings.some((warning) => warning.code === 'cil-call-stack-effect-unresolved'));

  const malformedControl = validate({
    context: { returnStackSlots: 1 },
    bundle: op({ controlEffects: [{ kind: 'branch', targetOffset: 99 }] }),
  });
  assert.equal(malformedControl.status, 'invalid');
  assert.equal(malformedControl.completeness.structural, 'partial');
  assert.ok(malformedControl.errors.some((error) => error.code === 'cil-invalid-branch-target'));
});
