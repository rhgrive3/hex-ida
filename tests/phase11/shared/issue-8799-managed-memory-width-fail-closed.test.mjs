import assert from 'node:assert/strict';

import { createVMEffectFunction } from '../../../js/managed/shared/vm-effects.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function exactJvmFieldFunction({ byteWidth } = {}) {
  const memoryEffect = {
    isWrite: false,
    space: 'static-field',
    owner: 'pkg/Test',
    name: 'value',
    descriptor: 'I',
  };
  if (byteWidth !== undefined) memoryEffect.byteWidth = byteWidth;

  return createVMEffectFunction({
    methodId: 'managed-method:issue-8799-generic-width',
    frontendId: 'jvm',
    bundles: [{
      frontendId: 'jvm',
      methodId: 'managed-method:issue-8799-generic-width',
      operationId: 'issue-8799:generic-width',
      bytecodeOffset: 0,
      opcode: 0xb2,
      mnemonic: 'getstatic',
      producedValues: [{ bits: 32 }],
      memoryEffects: [memoryEffect],
      completeness: 'exact',
    }],
  });
}

{
  const lowered = lowerVMEffectsToSemanticIr(exactJvmFieldFunction());
  const load = lowered.semanticIr.nodes.find((node) => node.kind === 'load');
  assert.ok(load, 'legacy lowerer may retain a placeholder load node for compatibility');
  assert.equal(load.completeness, 'partial',
    'missing byteWidth must never survive the public bridge as a complete memory access');
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((entry) => entry.reason === 'managed-memory-width-unresolved'),
    'the missing storage-width authority must be explicit at function scope');
  assert.equal(load.unknown?.reason, 'managed-memory-width-unresolved');
}

{
  const lowered = lowerVMEffectsToSemanticIr(exactJvmFieldFunction({ byteWidth: 4 }));
  const load = lowered.semanticIr.nodes.find((node) => node.kind === 'load');
  assert.ok(load);
  assert.equal(load.memory.widthBits, 32);
  assert.equal(load.completeness, 'complete', 'a proven width remains exact');
  assert.equal(lowered.semanticIr.completeness, 'complete');
  assert.ok(!lowered.semanticIr.unknowns.some((entry) => entry.reason === 'managed-memory-width-unresolved'));
}

console.log('ok #8799 generic managed bridge fails closed when memory byteWidth is unproven');
