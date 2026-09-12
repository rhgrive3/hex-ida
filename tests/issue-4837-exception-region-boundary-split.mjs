// Regression for #4837: the shared bridge built its CFG basic-block boundary
// set (`M`) from control-flow targets and exception *handler* offsets only; an
// exception region's `startOffset` / `endOffset` never entered the partition.
// When a try region began or ended in the middle of an existing block, that
// block was not split, and the exception-successor test (which keys off the
// block start offset `t`) dropped the handler edge for protected code that did
// not open a block, or over-applied it to a region's trailing instructions.
// The fix feeds every legal region boundary into the block partition so a
// block is fully inside or fully outside a protected range before the handler
// edge is added, while non-instruction ends (e.g. a region end at method end)
// stay fail-closed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-lowering-v2.js';
import { createVMEffectBundle, createVMEffectFunction } from '../js/managed/shared/vm-effects.js';

let caseNo = 0;

function lower(frontendId, offsets, { returnOffset = -1 } = {}, regions = []) {
  const methodId = `managed-method:${frontendId}-4837-${caseNo++}`;
  const bundles = offsets.map((offset) => createVMEffectBundle({
    frontendId,
    methodId,
    operationId: `op:${offset}`,
    bytecodeOffset: offset,
    mnemonic: offset === returnOffset ? 'return' : 'nop',
    completeness: 'exact',
    ...(offset === returnOffset ? { controlEffects: [{ kind: 'return' }] } : {}),
  }));
  return lowerVMEffectsToSemanticIr(createVMEffectFunction({
    frontendId, methodId, bundles, exceptionRegions: regions,
  }));
}

function blockIds(lowered) { return lowered.cfg.blocks.map((b) => b.id); }

function exceptionTargets(lowered, blockId) {
  const block = lowered.cfg.blocks.find((b) => b.id === blockId);
  assert.ok(block, `expected basic block ${blockId} to exist (region boundary did not split)`);
  return [...new Set(block.successors.filter((e) => e.kind === 'exception').map((e) => e.to))].sort();
}

function blocksWithExceptionEdge(lowered) {
  return lowered.cfg.blocks
    .filter((b) => b.successors.some((e) => e.kind === 'exception'))
    .map((b) => b.id)
    .sort();
}

test('#4837 splits the block at the try start and tags only the protected block', () => {
  const lowered = lower('wasm', [0, 1, 2, 3, 4], {}, [
    { id: 'eh:0', startOffset: 1, endOffset: 3, handlerOffset: 4 },
  ]);
  assert.ok(blockIds(lowered).includes('bb_0x1'), 'try start must open a new basic block');
  assert.deepEqual(blocksWithExceptionEdge(lowered), ['bb_0x1']);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x1'), ['bb_0x4']);
});

test('#4837 splits the block at the try end and excludes trailing instructions', () => {
  const lowered = lower('wasm', [0, 1, 2, 3, 4], {}, [
    { id: 'eh:0', startOffset: 0, endOffset: 2, handlerOffset: 4 },
  ]);
  assert.ok(blockIds(lowered).includes('bb_0x2'), 'try end must close the protected block');
  assert.deepEqual(blocksWithExceptionEdge(lowered), ['bb_0x0']);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x0'), ['bb_0x4']);
});

test('#4837 keeps the boundary set stable for nested / overlapping regions', () => {
  const lowered = lower('wasm', [0, 1, 2, 3, 4, 5], {}, [
    { id: 'eh:0', startOffset: 1, endOffset: 4, handlerOffset: 5 },
    { id: 'eh:1', startOffset: 2, endOffset: 5, handlerOffset: 5 },
  ]);
  assert.deepEqual([...blockIds(lowered)].sort(), ['bb_0x0', 'bb_0x1', 'bb_0x2', 'bb_0x4', 'bb_0x5']);
  assert.deepEqual(blocksWithExceptionEdge(lowered), ['bb_0x1', 'bb_0x2', 'bb_0x4']);
  for (const id of ['bb_0x1', 'bb_0x2', 'bb_0x4']) {
    assert.deepEqual(exceptionTargets(lowered, id), ['bb_0x5']);
  }
});

test('#4837 preserves handler-offset boundaries and stays fail-closed on non-instruction ends', () => {
  const lowered = lower('wasm', [0, 1, 2], {}, [
    { id: 'eh:0', startOffset: 1, endOffset: 2, handlerOffset: 2 },
    { id: 'eh:1', startOffset: 2, endOffset: 9, handlerOffset: 2 },
  ]);
  assert.equal(blockIds(lowered).includes('bb_0x9'), false, 'a region end past the last instruction must not split');
  assert.ok(blockIds(lowered).includes('bb_0x1'), 'start/end region boundaries must open a block');
  assert.ok(blockIds(lowered).includes('bb_0x2'), 'handler offset remains a block boundary');
});

test('#4837 CIL catch: only the protected block reaches the handler via the exception edge', () => {
  // 0 fallthrough, 1..2 protected, 3..4 (offset 4 is the return terminator), 5 catch handler.
  const lowered = lower('cil', [0, 1, 2, 3, 4, 5], { returnOffset: 4 }, [
    { id: 'eh:0', startOffset: 1, endOffset: 3, handlerOffset: 5, handlerKind: 'catch' },
  ]);
  assert.ok(blockIds(lowered).includes('bb_0x1'), 'try start splits the block');
  assert.ok(blockIds(lowered).includes('bb_0x3'), 'try end splits the block');
  assert.deepEqual(blocksWithExceptionEdge(lowered), ['bb_0x1']);
  assert.deepEqual(exceptionTargets(lowered, 'bb_0x1'), ['bb_0x5']);
  const handler = lowered.cfg.blocks.find((b) => b.id === 'bb_0x5');
  assert.ok(handler.predecessors.includes('bb_0x1'), 'handler reached from the protected block via the exception edge');
});
