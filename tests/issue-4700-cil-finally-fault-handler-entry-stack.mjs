// Regression for #4700: on CIL exception edges the bridge set the handler
// entry stack height to 1 for every handler kind, fabricating an exception
// object slot in `finally`/`fault` entries (ECMA-335 pushes the exception
// object only upon entry of a filter or catch clause). The handler kind is
// already carried on the exception regions but was never bound onto the
// exception CFG edge or used by the stack-height propagation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../js/managed/cil/lifter-core.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-lowering-v2.js';
import { lowerVMEffectsToSemanticIr as lowerViaBridge } from '../js/managed/shared/bridge-v2.js';
import { createVMEffectBundle, createVMEffectFunction } from '../js/managed/shared/vm-effects.js';

function cilExceptionFunction(handlerKind, extraRegion = {}) {
  const methodId = `managed-method:cil-4700-${handlerKind}`;
  const mk = (offset, bundleExtra = {}) => createVMEffectBundle({
    frontendId: 'cil',
    methodId,
    operationId: `op:${offset}`,
    bytecodeOffset: offset,
    mnemonic: 'nop',
    completeness: 'exact',
    ...bundleExtra,
  });
  return createVMEffectFunction({
    frontendId: 'cil',
    methodId,
    bundles: [
      mk(0, { mnemonic: 'ret', controlEffects: [{ kind: 'return' }] }),
      mk(10),
    ],
    exceptionRegions: [{
      id: 'eh:0',
      startOffset: 0,
      endOffset: 1,
      handlerOffset: 10,
      handlerKind,
      ...extraRegion,
    }],
  });
}

function stackSlotReads(lowered, blockId, frontendId) {
  return lowered.semanticIr.nodes.filter((node) =>
    node.kind === 'state-read'
    && node.blockId === blockId
    && node.variable?.key === `vm:${frontendId}:stack:0`);
}

function exceptionEdge(lowered) {
  return lowered.cfg.blocks.find((block) => block.id === 'bb_0x0')
    .successors.find((edge) => edge.kind === 'exception');
}

function cilImage(bytecode, exceptionClauses) {
  return {
    moduleId: 'managed-mod:managed-image:bin:test-4700',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      maxStack: 1,
      isTiny: false,
      exceptionClauses,
    }],
  };
}

test('#4700 finally handler entry has an empty CIL evaluation stack', () => {
  const lowered = lowerVMEffectsToSemanticIr(cilExceptionFunction('finally'));
  assert.deepEqual(stackSlotReads(lowered, 'bb_0xa', 'cil'), [],
    'finally must not enter with a fabricated exception object slot');
});

test('#4700 fault handler entry has an empty CIL evaluation stack', () => {
  const lowered = lowerVMEffectsToSemanticIr(cilExceptionFunction('fault'));
  assert.deepEqual(stackSlotReads(lowered, 'bb_0xa', 'cil'), [],
    'fault must not enter with a fabricated exception object slot');
});

test('#4700 catch handler entry keeps the one-item exception object', () => {
  const lowered = lowerVMEffectsToSemanticIr(cilExceptionFunction('catch'));
  assert.equal(stackSlotReads(lowered, 'bb_0xa', 'cil').length, 1);
});

test('#4700 filter entry keeps the exception object and the filter start stays distinct', () => {
  const fn = cilExceptionFunction('filter', { filterOffset: 20 });
  const lowered = lowerVMEffectsToSemanticIr(fn);
  assert.equal(stackSlotReads(lowered, 'bb_0xa', 'cil').length, 1,
    'a filter clause is entered with the exception object on the stack');
  assert.equal(exceptionEdge(lowered).metadata?.handlerKind, 'filter',
    'the edge must state that it enters the accepted handler of a filter clause');
  const region = lowered.exceptionRegions.find((item) => item.id === 'eh:0');
  assert.ok(region, 'the exception region is published');
  assert.notEqual(region.filterOffset, region.handlerOffset,
    'filter code start and accepted-handler start are distinct contract offsets');
});

test('#4700 exception CFG edges bind the handler kind for stack propagation', () => {
  for (const handlerKind of ['catch', 'filter', 'finally', 'fault']) {
    const lowered = lowerVMEffectsToSemanticIr(
      cilExceptionFunction(handlerKind, handlerKind === 'filter' ? { filterOffset: 20 } : {}));
    assert.equal(exceptionEdge(lowered).metadata?.handlerKind, handlerKind,
      `handlerKind=${handlerKind} must be bound onto the exception edge`);
  }
});

test('#4700 JVM exception handler entry keeps its one-item operand stack contract', () => {
  const methodId = 'managed-method:jvm-4700';
  const mk = (offset, bundleExtra = {}) => createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId: `op:${offset}`,
    bytecodeOffset: offset,
    mnemonic: 'nop',
    completeness: 'exact',
    ...bundleExtra,
  });
  const lowered = lowerVMEffectsToSemanticIr(createVMEffectFunction({
    frontendId: 'jvm',
    methodId,
    bundles: [
      mk(0, { mnemonic: 'return', controlEffects: [{ kind: 'return' }] }),
      mk(10),
    ],
    exceptionRegions: [{ id: 'eh:0', startOffset: 0, endOffset: 1, handlerOffset: 10, catchType: 5 }],
  }));
  assert.equal(stackSlotReads(lowered, 'bb_0xa', 'jvm').length, 1);
});

test('#4700 the canonical finally lowering no longer mismatches fallthrough into the handler', () => {
  // Shape of the issue #4700 reproduction: fallthrough and exception edges
  // reach the finally entry together; the fabricated height 1 collided with
  // the fallthrough height 0 as managed-bridge-stack-height-mismatch.
  const methodId = 'managed-method:cil-4700-repro';
  const mk = (offset, seq) => createVMEffectBundle({
    frontendId: 'cil',
    methodId,
    operationId: `op:${seq}`,
    bytecodeOffset: offset,
    mnemonic: 'nop',
    completeness: 'exact',
  });
  const lowered = lowerViaBridge(createVMEffectFunction({
    frontendId: 'cil',
    methodId,
    bundles: [mk(0, 0), mk(10, 1)],
    exceptionRegions: [{
      id: 'eh:0',
      startOffset: 0,
      endOffset: 1,
      handlerOffset: 10,
      handlerKind: 'finally',
    }],
  }));
  assert.deepEqual(stackSlotReads(lowered, 'bb_0xa', 'cil'), []);
});

test('#4700 lifter-sourced finally and catch entries follow the stack contract', () => {
  // 00: ldnull; 01: throw  (try [0,2))
  // 02: endfinally         (finally handler)
  // 03: ret
  const finallyRegion = {
    kind: 'finally',
    tryOffset: 0,
    tryLength: 2,
    handlerOffset: 2,
    handlerLength: 1,
    classTokenOrFilter: 0,
  };
  const finallyLowered = lowerVMEffectsToSemanticIr(liftCilMethod(
    0,
    cilImage(Uint8Array.from([0x14, 0x7a, 0xdc, 0x2a]), [finallyRegion]),
  ));
  assert.deepEqual(stackSlotReads(finallyLowered, 'bb_0x2', 'cil'), [],
    'finally handler entry stays empty through the public bridge');
  assert.equal(exceptionEdge(finallyLowered).metadata?.handlerKind, 'finally');

  // 00: ldnull; 01: throw  (try [0,2))
  // 02: pop                (catch handler consumes the exception object)
  // 03: ret
  const catchRegion = {
    kind: 'catch',
    tryOffset: 0,
    tryLength: 2,
    handlerOffset: 2,
    handlerLength: 1,
    classTokenOrFilter: 0x01000001,
  };
  const catchLowered = lowerVMEffectsToSemanticIr(liftCilMethod(
    0,
    cilImage(Uint8Array.from([0x14, 0x7a, 0x26, 0x2a]), [catchRegion]),
  ));
  assert.equal(stackSlotReads(catchLowered, 'bb_0x2', 'cil').length, 1);
  assert.equal(exceptionEdge(catchLowered).metadata?.handlerKind, 'catch');
});
