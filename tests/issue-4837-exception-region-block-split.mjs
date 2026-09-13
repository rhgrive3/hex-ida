// Regression for #4837: the shared managed bridge built its basic-block
// boundary set from control targets plus the exception `handlerOffset` only, so
// a try range that starts or ends in the middle of an existing block never
// split it. The exception-edge test then used the block *start* offset, so
// protected instructions lost their handler edge (or unprotected trailing
// instructions inherited one).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
  lowerVMEffectsToSemanticIr,
} from '../js/managed/index.js';

const methodId = createManagedMethodId('mod-4837', 'tryMethod');

function bundle(bytecodeOffset, terminator) {
  return createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId: createVMOperationId(methodId, bytecodeOffset),
    bytecodeOffset,
    opcode: terminator ? 0xb1 : 0x00,
    mnemonic: terminator ? 'return' : 'nop',
    controlEffects: terminator ? [{ kind: 'return' }] : [],
    completeness: 'exact',
  });
}

function lower(offsets, terminatorOffsets, exceptionRegions) {
  const terminators = new Set(terminatorOffsets);
  return lowerVMEffectsToSemanticIr(createVMEffectFunction({
    methodId,
    frontendId: 'jvm',
    bundles: offsets.map((off) => bundle(off, terminators.has(off))),
    exceptionRegions,
    aggregateCompleteness: 'exact',
  }));
}

const offsetOf = (id) => Number.parseInt(id.replace(/^bb_0x/, ''), 16);
const blockOffsets = (lowered) => lowered.cfg.blocks.map((b) => offsetOf(b.id)).sort((a, b) => a - b);
const exceptionTargets = (lowered, id) => (lowered.cfg.blocks.find((b) => b.id === id)?.successors ?? [])
  .filter((edge) => edge.kind === 'exception')
  .map((edge) => edge.to)
  .sort();
const shape = (lowered) => JSON.stringify(lowered.cfg.blocks
  .map((b) => [b.id, b.successors.map((e) => `${e.kind}:${e.to}`).sort()])
  .sort(([a], [b]) => offsetOf(a) - offsetOf(b)));

// 0: nop        outside, before the try
// 2: nop  <- try start
// 4: nop        protected
// 6: nop  <- try end, outside
// 8: return     terminating tail of the region
// 10: nop <- handler
const BODY = [0, 2, 4, 6, 8, 10];
const LEADING = { startOffset: 2, endOffset: 6, handlerOffset: 10 };

test('#4837 exception region start/end become basic-block boundaries', () => {
  const lowered = lower(BODY, [8], [LEADING]);
  assert.deepEqual(blockOffsets(lowered), [0, 2, 6, 10],
    `try start and try end must split the partition: ${JSON.stringify(lowered.cfg.blocks)}`);
});

test('#4837 only the fully protected block gets the handler exception edge', () => {
  const lowered = lower(BODY, [8], [LEADING]);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x2'), ['bb_0xa'],
    'the protected block must keep its exception edge to the handler');
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x0'), [],
    'the block before the try must not be treated as protected');
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x6'), [],
    'instructions after the try end must not inherit the exception edge');
  const handler = lowered.cfg.blocks.find((b) => b.id === 'bb_0xa');
  assert.deepEqual(handler.predecessors, ['bb_0x2'],
    'the handler is reachable through the protected block only');
});

test('#4837 handlerOffset keeps its existing boundary behavior', () => {
  const lowered = lower(BODY, [8], [{
    startOffset: 0,
    endOffset: 6,
    handlerOffset: 10,
  }]);
  assert.ok(lowered.cfg.blocks.some((b) => b.id === 'bb_0xa'),
    'the handler offset must stay a block boundary');
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x0'), ['bb_0xa'],
    'a try starting at the entry keeps its block-start based edge');
});

test('#4837 a region ending at the method end fabricates no boundary block', () => {
  const lowered = lower([0, 2, 4, 6, 8], [4, 8], [{
    startOffset: 2,
    endOffset: 9,
    handlerOffset: 6,
  }]);
  assert.deepEqual(blockOffsets(lowered), [0, 2, 6],
    `endOffset past the last instruction must not split: ${JSON.stringify(blockOffsets(lowered))}`);
  assert.ok(blockOffsets(lowered).every((off) => [0, 2, 4, 6, 8].includes(off)),
    'every block start must be a real instruction offset');
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x2'), ['bb_0x6'],
    'the protected block inside a method-end region still reaches its handler');
});

test('#4837 nested and overlapping regions keep a stable boundary set', () => {
  const regions = [
    { startOffset: 2, endOffset: 8, handlerOffset: 12 },
    { startOffset: 4, endOffset: 10, handlerOffset: 14 },
  ];
  const offsets = [0, 2, 4, 6, 8, 10, 12, 14];
  const lowered = lower(offsets, [6, 10, 12, 14], regions);
  const reversed = lower(offsets, [6, 10, 12, 14], [...regions].reverse());
  assert.deepEqual(blockOffsets(lowered), [0, 2, 4, 8, 10, 12, 14],
    `every region boundary must be a block boundary: ${JSON.stringify(blockOffsets(lowered))}`);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x0'), []);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x2'), ['bb_0xc']);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x4'), ['bb_0xc', 'bb_0xe']);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x8'), ['bb_0xe']);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0xa'), [],
    'a block outside both regions must not be protected');
  assert.deepEqual(exceptionTargets(lowered, 'bb_0xc'), [],
    'the handler of one region sits outside the other region');
  assert.equal(shape(reversed), shape(lowered),
    'the boundary set must not depend on region order');
});
