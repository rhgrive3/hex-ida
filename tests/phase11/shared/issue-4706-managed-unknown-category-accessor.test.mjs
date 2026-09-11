import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

function lowerForgedUnknown(unknownEffect, suffix) {
  const methodId = createManagedMethodId(`issue-4706-accessor-${suffix}`, 'unknown');
  const canonicalBundle = createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId: createVMOperationId(methodId, 0),
    bytecodeOffset: 0,
    mnemonic: 'unsupported-op',
    completeness: 'unknown',
    unknownEffects: [{ category: 'memory', reason: 'placeholder' }],
  });
  const canonicalFn = createVMEffectFunction({
    frontendId: 'jvm',
    methodId,
    bundles: [canonicalBundle],
    aggregateCompleteness: 'unknown',
    resolutionCompleteness: 'partial',
  });
  const forgedBundle = { ...canonicalBundle, unknownEffects: [unknownEffect] };
  return lowerVMEffectsToSemanticIr({ ...canonicalFn, bundles: [forgedBundle] });
}

const invalidCategory = /managed-bridge-invalid-unknown-category/;

test('bridge rejects singular category accessors without executing them', () => {
  let reads = 0;
  const effect = { reason: 'singular-accessor' };
  Object.defineProperty(effect, 'category', {
    enumerable: true,
    get() {
      reads += 1;
      return reads < 3 ? 'memory' : 'invented-after-validation';
    },
  });
  assert.throws(() => lowerForgedUnknown(effect, 'singular'), invalidCategory);
  assert.equal(reads, 0);
});

test('bridge rejects plural categories property accessors without executing them', () => {
  let reads = 0;
  const effect = { reason: 'plural-property-accessor' };
  Object.defineProperty(effect, 'categories', {
    enumerable: true,
    get() {
      reads += 1;
      return ['memory', 'calls'];
    },
  });
  assert.throws(() => lowerForgedUnknown(effect, 'plural-property'), invalidCategory);
  assert.equal(reads, 0);
});

test('bridge rejects accessor-backed plural array entries without executing them', () => {
  let reads = 0;
  const categories = ['memory', 'calls'];
  Object.defineProperty(categories, '1', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'calls' : 'invented-after-validation';
    },
  });
  assert.throws(
    () => lowerForgedUnknown({ categories, reason: 'plural-index-accessor' }, 'plural-index'),
    invalidCategory,
  );
  assert.equal(reads, 0);
});

test('bridge rejects sparse or inherited plural category entries', () => {
  const categories = ['memory'];
  categories.length = 2;
  const inherited = [];
  Object.defineProperty(inherited, '1', { value: 'calls', enumerable: true });
  Object.setPrototypeOf(categories, inherited);
  assert.throws(
    () => lowerForgedUnknown({ categories, reason: 'inherited-index' }, 'inherited-index'),
    invalidCategory,
  );
});

test('bridge snapshots own plural data and ignores custom array iteration authority', () => {
  const categories = ['memory', 'calls'];
  let iteratorReads = 0;
  Object.defineProperty(categories, Symbol.iterator, {
    value: function* forgedIterator() {
      iteratorReads += 1;
      yield 'invented-after-validation';
    },
  });
  const lowered = lowerForgedUnknown({ categories, reason: 'custom-iterator' }, 'custom-iterator');
  assert.equal(iteratorReads, 0);
  const node = lowered.semanticIr.nodes.find((entry) => entry.unknown?.reason === 'custom-iterator');
  assert.deepEqual(node.unknown.categories, ['calls', 'memory']);
});
