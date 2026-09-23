import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../js/core/identity/index.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import {
  buildSemanticSsa,
  canonicalSemanticSsaProducerBinding,
} from '../../js/semantics/ssa/index.js';

test('canonical semantic SSA exposes only its already-bound producer digests', () => {
  const functionId = 'function_digest_reuse';
  const origin = { instructionIds: ['instruction_digest_reuse'] };
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: [], origin }],
    values: [],
    nodes: [],
    completeness: 'complete',
    unknowns: [],
    origin,
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }],
  });

  const ssa = buildSemanticSsa(ir, cfg);
  const binding = canonicalSemanticSsaProducerBinding(ssa);

  assert.ok(binding);
  assert.equal(binding.functionId, functionId);
  assert.equal(binding.semanticIrDigest, stableDigest(ir));
  assert.equal(binding.scalarSsaDigest, stableDigest(ssa));
  assert.equal(
    canonicalSemanticSsaProducerBinding({ ...ssa }),
    null,
    'a copied/forged SSA object must not expose authority-bound producer digests',
  );
});
