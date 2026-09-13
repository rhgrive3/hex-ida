// Regression for #4847: exception region boundaries must become basic block leaders.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVMEffectBundle, createVMEffectFunction } from '../js/managed/shared/vm-effects.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';

function bundleAt(offset, terminator = false) {
  return createVMEffectBundle({
    frontendId: 'jvm',
    methodId: 'm',
    operationId: `op:${offset}`,
    bytecodeOffset: offset,
    mnemonic: terminator ? 'return' : 'nop',
    completeness: 'exact',
    controlEffects: terminator ? [{ kind: 'return' }] : [],
  });
}

// Shape: protected/unprotected nops, one terminating instruction, then handler
// blocks. Every stack-neutral bundle keeps the JVM stack-height propagation of
// the fixture well defined while the exception edges are under audit.
function method(spec, exceptionRegions) {
  const bundles = spec.map(([offset, terminator]) => bundleAt(offset, terminator));
  return createVMEffectFunction({
    frontendId: 'jvm',
    methodId: 'm',
    bundles,
    exceptionRegions,
    aggregateCompleteness: 'exact',
  });
}

function blockOffsets(lowered) {
  const nodes = new Map(lowered.semanticIr.nodes.map((n) => [n.id, n]));
  const offsetByEffect = new Map();
  for (const [id, node] of nodes) {
    const effect = node.sourceEffectIds?.[0];
    if (effect != null) offsetByEffect.set(id, Number(effect.split(':')[1]));
  }
  const out = new Map();
  for (const block of lowered.semanticIr.blocks) {
    const offsets = block.nodeIds.map((id) => offsetByEffect.get(id)).filter((off) => off != null);
    out.set(block.id, [...new Set(offsets)].sort((a, b) => a - b));
  }
  return out;
}

// Every instruction of a block must agree with that block's exception edges.
function coverageAudit(fn, lowered) {
  const offsetsByBlock = blockOffsets(lowered);
  for (const block of lowered.cfg.blocks) {
    const offsets = offsetsByBlock.get(block.id) ?? [];
    const handlerTargets = new Set(block.successors.filter((s) => s.kind === 'exception').map((s) => s.to));
    for (const region of fn.exceptionRegions) {
      const covered = offsets.filter((off) => off >= region.startOffset && off < region.endOffset);
      const handlerId = `bb_0x${region.handlerOffset.toString(16)}`;
      assert.equal(covered.length > 0 && covered.length < offsets.length, false,
        `block ${block.id} ${JSON.stringify(offsets)} mixes protected and unprotected instructions for region ${region.id} [${region.startOffset},${region.endOffset})`);
      if (covered.length > 0 && handlerId !== block.id) {
        assert.equal(handlerTargets.has(handlerId), true,
          `block ${block.id} ${JSON.stringify(offsets)} is protected by region ${region.id} [${region.startOffset},${region.endOffset}) but has no exception edge to ${handlerId}: ${JSON.stringify(block.successors)}`);
      }
      if (covered.length === 0) {
        assert.equal(handlerTargets.has(handlerId), false,
          `block ${block.id} ${JSON.stringify(offsets)} is outside region ${region.id} [${region.startOffset},${region.endOffset}) yet has an exception edge to ${handlerId}`);
      }
    }
  }
}

function successorCheck(lowered, from, to) {
  const block = lowered.cfg.blocks.find((b) => b.id === from);
  assert.ok(block, `block ${from} missing from CFG: ${JSON.stringify(lowered.cfg.blocks.map((b) => b.id))}`);
  return block.successors.some((s) => s.kind === 'exception' && s.to === to);
}

const blockIds = (lowered) => lowered.cfg.blocks.map((b) => b.id);

const handlerEdgeCount = (lowered, handlerId) => lowered.cfg.blocks
  .filter((b) => b.successors.some((s) => s.kind === 'exception' && s.to === handlerId)).length;

test('#4847 a region starting mid-block splits the block and keeps the handler edge', () => {
  const fn = method([[0, false], [1, false], [2, true], [3, false]], [{
    id: 'eh:0', startOffset: 1, endOffset: 3, handlerOffset: 3, catchType: 1,
  }]);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  assert.equal(handlerEdgeCount(lowered, 'bb_0x3') > 0, true,
    'instructions 1..2 are protected but no block has an exception edge to the handler');
  coverageAudit(fn, lowered);
  assert.equal(successorCheck(lowered, 'bb_0x1', 'bb_0x3'), true,
    'offset 1 is protected but its block has no exception edge to the handler');
  assert.equal(successorCheck(lowered, 'bb_0x0', 'bb_0x3'), false,
    'offset 0 is outside the region and must not inherit the handler edge');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#4847 a region ending mid-block stops the handler edge at endOffset', () => {
  const fn = method([[0, false], [1, false], [2, true], [3, false]], [{
    id: 'eh:0', startOffset: 0, endOffset: 1, handlerOffset: 3, catchType: 1,
  }]);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  coverageAudit(fn, lowered);
  assert.equal(successorCheck(lowered, 'bb_0x0', 'bb_0x3'), true);
  assert.equal(successorCheck(lowered, 'bb_0x1', 'bb_0x3'), false,
    'offset 1 is past the region end but shares a block with the protected instruction');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#4847 a region ending before the terminator splits the trailing block', () => {
  const fn = method([[0, false], [1, false], [2, false], [3, true], [4, false]], [{
    id: 'eh:0', startOffset: 0, endOffset: 2, handlerOffset: 4, catchType: 1,
  }]);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  coverageAudit(fn, lowered);
  assert.equal(successorCheck(lowered, 'bb_0x0', 'bb_0x4'), true);
  assert.equal(successorCheck(lowered, 'bb_0x2', 'bb_0x4'), false,
    'offset 2 is outside the region but joins the protected block');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#4847 a region end past the last instruction adds no spurious leader', () => {
  const fn = method([[0, false], [1, false], [2, true], [5, false]], [{
    id: 'eh:0', startOffset: 0, endOffset: 3, handlerOffset: 5, catchType: 1,
  }]);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  coverageAudit(fn, lowered);
  assert.deepEqual(blockIds(lowered), ['bb_0x0', 'bb_0x5']);
  assert.equal(successorCheck(lowered, 'bb_0x0', 'bb_0x5'), true);
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#4847 aligned region boundaries keep the existing single handler edge', () => {
  const fn = method([[0, false], [1, false], [2, true], [3, false]], [{
    id: 'eh:0', startOffset: 0, endOffset: 3, handlerOffset: 3, catchType: 1,
  }]);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  coverageAudit(fn, lowered);
  assert.deepEqual(blockIds(lowered), ['bb_0x0', 'bb_0x3']);
  assert.equal(successorCheck(lowered, 'bb_0x0', 'bb_0x3'), true);
  assert.equal(successorCheck(lowered, 'bb_0x3', 'bb_0x3'), false);
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#4847 overlapping regions split the block at every coverage change', () => {
  const fn = method([[0, false], [1, false], [2, false], [3, true], [4, false], [5, false]], [
    { id: 'eh:0', startOffset: 1, endOffset: 3, handlerOffset: 4, catchType: 1 },
    { id: 'eh:1', startOffset: 2, endOffset: 4, handlerOffset: 5, catchType: 2 },
  ]);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  coverageAudit(fn, lowered);
  assert.deepEqual(blockIds(lowered), ['bb_0x0', 'bb_0x1', 'bb_0x2', 'bb_0x3', 'bb_0x4', 'bb_0x5']);
  assert.equal(successorCheck(lowered, 'bb_0x1', 'bb_0x4'), true);
  assert.equal(successorCheck(lowered, 'bb_0x2', 'bb_0x4'), true);
  assert.equal(successorCheck(lowered, 'bb_0x2', 'bb_0x5'), true);
  assert.equal(successorCheck(lowered, 'bb_0x3', 'bb_0x5'), true);
  assert.equal(successorCheck(lowered, 'bb_0x3', 'bb_0x4'), false);
});
