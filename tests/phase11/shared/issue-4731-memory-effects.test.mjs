import assert from 'node:assert/strict';

import {
  buildManagedMethodSummary,
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

function fixture(memoryEffects, { completeness = 'exact', aggregateCompleteness = completeness } = {}) {
  const methodId = createManagedMethodId('module-4731', 'multi-memory');
  const operationId = createVMOperationId(methodId, 0);
  const bundle = createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId,
    bytecodeOffset: 0,
    mnemonic: 'synthetic-memory-effects',
    locationReads: [{ kind: 'register', index: 0, type: { kind: 'address', widthBits: 32 } }],
    memoryEffects,
    completeness,
    ...(completeness === 'exact' ? {} : { unknownEffects: [{ reason: 'unsupported-memory-shape', categories: ['memory'] }] }),
  });
  return createVMEffectFunction({
    frontendId: 'jvm',
    methodId,
    bundles: [bundle],
    aggregateCompleteness,
  });
}

function memoryNodes(lowered, operationId) {
  return lowered.semanticIr.nodes
    .filter((node) => node.sourceEffectIds.includes(operationId))
    .filter((node) => node.kind === 'load' || node.kind === 'store');
}

for (const [label, memoryEffects] of [
    ['single-read', [
      { space: 'memory', byteWidth: 4, isWrite: false },
    ]],
    ['single-write', [
      { space: 'memory', byteWidth: 4, isWrite: true },
    ]],
    ['read-write', [
      { space: 'memory', byteWidth: 4, isWrite: false },
      { space: 'memory', byteWidth: 4, isWrite: true },
    ]],
    ['write-read', [
      { space: 'memory', byteWidth: 8, isWrite: true },
      { space: 'memory', byteWidth: 2, isWrite: false },
    ]],
    ['read-read', [
      { space: 'memory-a', byteWidth: 4, isWrite: false },
      { space: 'memory-b', byteWidth: 8, isWrite: false },
    ]],
  ]) {
    const operationId = createVMOperationId(createManagedMethodId('module-4731', 'multi-memory'), 0);
    const lowered = lowerVMEffectsToSemanticIr(fixture(memoryEffects));
    assert.deepEqual(memoryNodes(lowered, operationId).map((node) => ({
      kind: node.kind,
      addressSpace: node.memory.addressSpace,
      widthBits: node.memory.widthBits,
    })), memoryEffects.map((effect) => ({
      kind: effect.isWrite ? 'store' : 'load',
      addressSpace: effect.space,
      widthBits: effect.byteWidth * 8,
    })), label);
    assert.equal(lowered.semanticIr.completeness, 'complete', `${label} must not become falsely partial`);
  }

{
  const lowered = lowerVMEffectsToSemanticIr(fixture([
    { space: 'memory', byteWidth: 4, isWrite: false },
    { space: 'memory', byteWidth: 4, isWrite: true },
  ]));
  const summary = buildManagedMethodSummary(lowered);
  assert.equal(summary.summary.memoryReadRegions.length, 1);
  assert.equal(summary.summary.memoryWriteRegions.length, 1);
  assert.equal(summary.completeness, 'complete');
}

{
  const lowered = lowerVMEffectsToSemanticIr(fixture([
    { space: 'memory', byteWidth: 4, isWrite: false },
    { space: 'memory', byteWidth: 0, isWrite: true },
  ]));
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some(({ reason }) => reason === 'invalid-memory-effect-shape'));
  assert.equal(lowered.semanticIr.nodes.filter((node) => node.kind === 'barrier').length, 1);
}

{
  const lowered = lowerVMEffectsToSemanticIr(fixture([
    { space: 'memory', byteWidth: 4, isWrite: false },
    { space: 'memory', byteWidth: 4, isWrite: true },
  ], { completeness: 'unknown', aggregateCompleteness: 'unknown' }));
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.equal(lowered.semanticIr.nodes.filter((node) => node.kind === 'barrier').length, 1);
}

console.log('[phase11] issue #4731 managed bridge multi-memory regression passed');
