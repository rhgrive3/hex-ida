import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VM_UNKNOWN_CATEGORIES,
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

function lowerUnknown(unknownEffect, suffix = 'case') {
  const methodId = createManagedMethodId(`issue-4706-${suffix}`, 'unknown');
  const bundle = createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId: createVMOperationId(methodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'unsupported-op',
    completeness: 'unknown',
    unknownEffects: [unknownEffect],
  });
  const fn = createVMEffectFunction({
    frontendId: 'jvm',
    methodId,
    bundles: [bundle],
    aggregateCompleteness: 'unknown',
    resolutionCompleteness: 'partial',
  });
  return lowerVMEffectsToSemanticIr(fn);
}

for (const category of VM_UNKNOWN_CATEGORIES) {
  test(`canonical VMEffects unknown category ${category} survives lowering`, () => {
    const reason = `unknown-${category}`;
    const lowered = lowerUnknown({ category, reason }, category);
    const node = lowered.semanticIr.nodes.find((entry) => entry.unknown?.reason === reason);
    assert.ok(node, `missing unknown node for ${category}`);
    assert.deepEqual(node.unknown.categories, [category]);

    const fnUnknown = lowered.semanticIr.unknowns.find((entry) => entry.reason === reason);
    assert.ok(fnUnknown, `missing function unknown for ${category}`);
    assert.deepEqual(fnUnknown.categories, [category]);
  });
}

test('unknown reason remains lossless while category is propagated', () => {
  const lowered = lowerUnknown({ category: 'memory', reason: 'memory-effect-not-modeled' }, 'reason');
  const node = lowered.semanticIr.nodes.find((entry) => entry.unknown?.reason === 'memory-effect-not-modeled');
  assert.equal(node.unknown.reason, 'memory-effect-not-modeled');
  assert.deepEqual(node.unknown.categories, ['memory']);
});

test('multiple canonical unknown effects preserve the union at node and per-reason function level', () => {
  const methodId = createManagedMethodId('issue-4706-multiple', 'unknown');
  const bundle = createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId: createVMOperationId(methodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'unsupported-op',
    completeness: 'unknown',
    unknownEffects: [
      { category: 'memory', reason: 'unknown-memory' },
      { category: 'calls', reason: 'unknown-call' },
    ],
  });
  const fn = createVMEffectFunction({
    frontendId: 'jvm',
    methodId,
    bundles: [bundle],
    aggregateCompleteness: 'unknown',
    resolutionCompleteness: 'partial',
  });
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const node = lowered.semanticIr.nodes.find((entry) => entry.unknown?.reason === 'unknown-memory');
  assert.deepEqual(node.unknown.categories, ['calls', 'memory']);
  assert.deepEqual(
    lowered.semanticIr.unknowns.find((entry) => entry.reason === 'unknown-memory').categories,
    ['memory'],
  );
  assert.deepEqual(
    lowered.semanticIr.unknowns.find((entry) => entry.reason === 'unknown-call').categories,
    ['calls'],
  );
});

test('schema-outside category does not silently launder to other', () => {
  const invalidCategory = /vm-effect-invalid-unknown-category|managed-bridge-invalid-unknown-category|managed-bridge-conflicting-unknown-category/;
  assert.throws(
    () => lowerUnknown({ category: 'definitely-not-a-vm-category', reason: 'bad-category' }, 'invalid'),
    invalidCategory,
  );
  assert.throws(
    () => lowerUnknown({ category: ['memory'], reason: 'structured-category' }, 'structured'),
    invalidCategory,
  );
  assert.throws(
    () => lowerUnknown({ category: { value: 'memory' }, reason: 'object-category' }, 'object'),
    invalidCategory,
  );
  assert.throws(
    () => lowerUnknown({ category: 'memory', categories: ['calls'], reason: 'conflicting-category' }, 'conflict'),
    invalidCategory,
  );
});

test('legacy plural category fixture remains lossless when each category is valid', () => {
  const lowered = lowerUnknown({ categories: ['memory', 'calls'], reason: 'legacy-valid-plural' }, 'legacy-plural');
  const node = lowered.semanticIr.nodes.find((entry) => entry.unknown?.reason === 'legacy-valid-plural');
  assert.deepEqual(node.unknown.categories, ['calls', 'memory']);
  const fnUnknown = lowered.semanticIr.unknowns.find((entry) => entry.reason === 'legacy-valid-plural');
  assert.deepEqual(fnUnknown.categories, ['calls', 'memory']);
});
