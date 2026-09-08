import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import { canonicalMemorySsaDigest, createCanonicalIdentityDigestMemo } from '../../../js/semantics/memoryssa/proof.js';
import {
  canonicalSemanticIrDigest,
  createSemanticIrFunction,
  isCanonicalSemanticIrFunction,
  validateSemanticIrFunction,
} from '../../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import {
  buildMemorySsa,
  canonicalMemorySsaProducerDigest,
  canonicalMemorySsaProducerSemanticIrDigest,
  isCanonicalMemorySsaProducerArtifact,
} from '../../../js/semantics/memoryssa/build.js';

test('unbranded mutable MemorySSA-shaped objects are always redigested', () => {
  const artifact = { definitions: [] };
  const first = canonicalMemorySsaProducerDigest(artifact);
  artifact.definitions.push({ id: 'definition-after-first-digest' });
  const second = canonicalMemorySsaProducerDigest(artifact);

  assert.equal(isCanonicalMemorySsaProducerArtifact(artifact), false);
  assert.notEqual(second, first);
  assert.equal(second, canonicalMemorySsaDigest(artifact));
});

test('identity digest memo preserves primitive compatibility without weak collection coercion', () => {
  const memo = createCanonicalIdentityDigestMemo();
  for (const identity of ['primitive', false, 0, 1.5, 0n]) {
    assert.equal(memo.digest(identity), stableDigest(identity));
  }
});

test('shallow-frozen unbranded Map state is not treated as immutable cache input', () => {
  const entries = new Map([['before', 1]]);
  const artifact = Object.freeze({ identity: entries });
  const first = canonicalMemorySsaProducerDigest(artifact);
  entries.set('after', 2);
  const second = canonicalMemorySsaProducerDigest(artifact);

  assert.equal(isCanonicalMemorySsaProducerArtifact(artifact), false);
  assert.notEqual(second, first);
  assert.equal(second, canonicalMemorySsaDigest(artifact));
});

test('reentrant mutation during an unbranded digest cannot poison later checks', () => {
  const identity = {};
  let firstRead = true;
  Object.defineProperty(identity, 'trigger', {
    configurable: true,
    enumerable: true,
    get() {
      if (firstRead) {
        firstRead = false;
        Object.defineProperty(identity, 'late', {
          configurable: true,
          enumerable: true,
          value: 'added-during-first-digest',
        });
      }
      return 'trigger-value';
    },
  });
  const artifact = { identity };
  const first = canonicalMemorySsaProducerDigest(artifact);
  const second = canonicalMemorySsaProducerDigest(artifact);

  assert.notEqual(second, first);
  assert.equal(second, canonicalMemorySsaDigest(artifact));
});

test('canonical Semantic IR reuse retains cancellation, budget, and clone guards', () => {
  const origin = { instructionIds: ['ir-marker'], virtualRanges: [{ start: 0n, end: 1n }] };
  const ir = createSemanticIrFunction({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'memoryssa-ir-marker',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: [], origin }],
    values: [],
    nodes: [],
    completeness: 'complete',
    unknowns: [],
    origin,
  });

  assert.equal(isCanonicalSemanticIrFunction(ir), true);
  assert.equal(Object.isFrozen(ir), true);
  assert.equal(validateSemanticIrFunction(ir), ir);
  const semanticIrDigest = canonicalSemanticIrDigest(ir);
  assert.equal(semanticIrDigest, canonicalSemanticIrDigest(ir));

  const cfg = createSemanticCfg({
    functionId: ir.functionId,
    entryBlockId: ir.entryBlockId,
    blocks: [{ id: ir.entryBlockId, successors: [] }],
  });
  const artifact = buildMemorySsa(ir, cfg, {
    identity: {
      functionId: ir.functionId,
      semanticIrId: 'memoryssa-ir-marker',
      semanticIrContractVersion: ir.contractVersion,
      semanticIrDigest,
      snapshotId: 'memoryssa-ir-marker-snapshot',
    },
    canonicalIrIdentity: {
      functionId: ir.functionId,
      semanticIrId: 'memoryssa-ir-marker',
      semanticIrContractVersion: ir.contractVersion,
      semanticIrDigest,
    },
    snapshotId: 'memoryssa-ir-marker-snapshot',
  });
  assert.equal(canonicalMemorySsaProducerSemanticIrDigest(artifact, ir), semanticIrDigest);
  assert.equal(canonicalMemorySsaProducerSemanticIrDigest(artifact, structuredClone(ir)), null);

  const controller = new AbortController();
  controller.abort();
  assert.throws(() => validateSemanticIrFunction(ir, { signal: controller.signal }), /cancelled/);
  assert.throws(() => validateSemanticIrFunction(ir, { budget: { maxBlocks: 0 } }), /invalid-budget-maxBlocks/);

  const clone = structuredClone(ir);
  clone.functionId = 'memoryssa-ir-marker-mutated';
  const normalizedClone = validateSemanticIrFunction(clone);
  assert.notEqual(normalizedClone, clone);
  assert.equal(normalizedClone.functionId, 'memoryssa-ir-marker-mutated');
});

test('an explicitly looser canonical IR budget is rechecked against defaults', () => {
  const origin = { instructionIds: ['ir-budget'], virtualRanges: [{ start: 0n, end: 1n }] };
  const blocks = Array.from({ length: 16385 }, (_, index) => ({
    id: `budget-${index}`,
    nodeIds: [],
  }));
  const ir = createSemanticIrFunction({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId: 'memoryssa-ir-budget',
    entryBlockId: 'budget-0',
    blocks,
    values: [],
    nodes: [],
    completeness: 'complete',
    unknowns: [],
    origin,
  }, { budget: { maxBlocks: blocks.length } });

  assert.equal(isCanonicalSemanticIrFunction(ir), true);
  assert.throws(() => validateSemanticIrFunction(ir), /semantic-ir-budget-exceeded-maxBlocks/);
});
