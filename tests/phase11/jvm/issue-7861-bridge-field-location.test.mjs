import assert from 'node:assert/strict';
import test from 'node:test';
import { createVMEffectBundle, createVMEffectFunction } from '../../../js/managed/shared/vm-effects.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function bundle({ operationId, bytecodeOffset, mnemonic, consumedValues = [], producedValues = [], memoryEffects = [] }) {
  return createVMEffectBundle({
    frontendId: 'jvm', frontendSemanticVersion: 'test', methodId: 'A.m:()V',
    operationId, bytecodeOffset, mnemonic, consumedValues, producedValues,
    memoryEffects, completeness: 'exact',
  });
}
function fn(bundles) {
  return createVMEffectFunction({
    frontendId: 'jvm', methodId: 'A.m:()V', bundles,
    aggregateCompleteness: 'exact', resolutionCompleteness: 'complete',
  });
}
function field({ name = 'x', isWrite = false, isStatic = true, volatile = true }) {
  return {
    space: isStatic ? 'static-field' : 'field', owner: 'A', name, descriptor: 'I',
    valueBits: 32, byteWidth: 4, isWrite,
    ...(volatile ? { isVolatile: true, ordering: 'synchronizes-with' } : {}),
  };
}
function memoryNode(lowered, kind) {
  const node = lowered.semanticIr.nodes.find((item) => item.kind === kind);
  assert.ok(node, `${kind} node required`);
  return node;
}

test('#7861 static same-field read/write share one canonical field location', () => {
  const read = lowerVMEffectsToSemanticIr(fn([
    bundle({ operationId: 'get-x', bytecodeOffset: 0, mnemonic: 'getstatic', producedValues: [{ id: 'x', bits: 32 }], memoryEffects: [field({})] }),
  ]));
  const write = lowerVMEffectsToSemanticIr(fn([
    bundle({ operationId: 'const-1', bytecodeOffset: 0, mnemonic: 'iconst_1', producedValues: [{ id: 'v', bits: 32 }] }),
    bundle({ operationId: 'put-x', bytecodeOffset: 1, mnemonic: 'putstatic', consumedValues: [{ id: 'v', bits: 32 }], memoryEffects: [field({ isWrite: true })] }),
  ]));
  const load = memoryNode(read, 'load');
  const store = memoryNode(write, 'store');
  assert.deepEqual(load.attributes.fieldIdentity, { kind: 'jvm-field', owner: 'A', name: 'x', descriptor: 'I', static: true });
  assert.deepEqual(store.attributes.fieldIdentity, load.attributes.fieldIdentity);
  assert.equal(load.memory.addressExpr.valueId, store.memory.addressExpr.valueId,
    'same static field must use one canonical location value');
  assert.deepEqual({ volatility: load.memory.volatility, atomic: load.memory.atomic, ordering: load.memory.ordering },
    { volatility: true, atomic: true, ordering: 'seq-cst' });
  assert.deepEqual({ volatility: store.memory.volatility, atomic: store.memory.atomic, ordering: store.memory.ordering },
    { volatility: true, atomic: true, ordering: 'seq-cst' });
});

test('#7861 different JVM fields never collapse to one canonical location', () => {
  const lower = (name) => lowerVMEffectsToSemanticIr(fn([
    bundle({ operationId: `get-${name}`, bytecodeOffset: 0, mnemonic: 'getstatic', producedValues: [{ id: name, bits: 32 }], memoryEffects: [field({ name })] }),
  ]));
  const x = memoryNode(lower('x'), 'load');
  const y = memoryNode(lower('y'), 'load');
  assert.notDeepEqual(x.attributes.fieldIdentity, y.attributes.fieldIdentity);
  assert.notEqual(x.memory.addressExpr.valueId, y.memory.addressExpr.valueId);
});

test('#7861 malformed complete JVM field effect fails closed in the bridge', () => {
  const malformed = fn([
    bundle({ operationId: 'get-malformed', bytecodeOffset: 0, mnemonic: 'getstatic', producedValues: [{ id: 'x', bits: 32 }], memoryEffects: [{ space: 'static-field', valueBits: 32, byteWidth: 4, isWrite: false, isVolatile: true }] }),
  ]);
  const lowered = lowerVMEffectsToSemanticIr(malformed);
  const load = memoryNode(lowered, 'load');
  assert.equal(load.completeness, 'partial');
  assert.equal(load.unknown?.reason, 'managed-jvm-field-identity-unresolved');
  assert.equal(lowered.semanticIr.completeness, 'partial');
});
