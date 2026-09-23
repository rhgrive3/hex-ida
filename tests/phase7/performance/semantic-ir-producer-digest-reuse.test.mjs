import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import {
  buildSemanticSsa,
  canonicalSemanticSsaProducerBinding,
} from '../../../js/semantics/ssa/index.js';
import { semanticIrDigestFor } from '../../../js/analysis/alias/regions-v2.js';

test('Phase7 reuses SSA producer digest only for the exact Semantic IR source', () => {
  const functionId = 'phase7_exact_source_digest';
  const origin = { instructionIds: ['instruction_phase7_digest'] };
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

  assert.equal(semanticIrDigestFor(ir, ssa), binding.semanticIrDigest);

  const changedClone = {
    ...ir,
    unknowns: [{ category: 'other', reason: 'clone-must-not-inherit-private-source-authority' }],
  };
  assert.notEqual(
    semanticIrDigestFor(changedClone, ssa),
    binding.semanticIrDigest,
    'a cloned/different IR must fall back to content hashing instead of producer authority',
  );
});
