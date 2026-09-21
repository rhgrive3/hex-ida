import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import {
  createSemanticIrFunction,
  isCanonicalSemanticIrProducerArtifact,
} from '../../js/semantics/ir/index.js';
import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import { validateSemanticSsa } from '../../js/semantics/ssa/validate.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const origin = { operationIds:['canonical-ir-fast-path-fixture'] };
const raw = {
  schemaVersion:2,
  contractVersion:'2.0.0',
  functionId:'canonical_ir_fast_path',
  entryBlockId:'entry',
  blocks:[{ id:'entry', nodeIds:['copy','ret'], origin }],
  values:[
    { id:'v0', kind:'entry', machineType:{ kind:'bitvector', widthBits:32 }, sourceEntityId:'canonical_ir_fast_path', origin },
    { id:'v1', kind:'definition', machineType:{ kind:'bitvector', widthBits:32 }, definitionNodeId:'copy', sourceEntityId:'copy', origin },
  ],
  nodes:[
    { id:'copy', kind:'copy', blockId:'entry', inputs:['v0'], outputs:['v1'], origin },
    { id:'ret', kind:'return', blockId:'entry', inputs:['v1'], outputs:[], origin },
  ],
  completeness:'complete',
  unknowns:[],
  origin,
};
const cfg = createSemanticCfg({
  functionId:'canonical_ir_fast_path',
  entryBlockId:'entry',
  blocks:[{ id:'entry', successors:[] }],
});
const tinyIrBudget = { budget:{ maxNodes:1 } };

const canonical = createSemanticIrFunction(raw);
assert.equal(isCanonicalSemanticIrProducerArtifact(canonical), true,
  'the exact validated producer object must carry private canonical identity');
assert.equal(isCanonicalSemanticIrProducerArtifact(Object.freeze(structuredClone(canonical))), false,
  'a frozen structural copy must not acquire producer identity');

// Producer-owned canonical IR has already paid createSemanticIrFunction's full validation
// and normalization cost. Internal consumers may reuse that exact immutable object rather
// than charging the caller's ingestion budget a second time.
const ssa = buildSemanticSsa(canonical, cfg, { irOptions:tinyIrBudget });
assert.doesNotThrow(() => validateSemanticSsa(ssa, canonical, cfg, { irOptions:tinyIrBudget }));
assert.doesNotThrow(() => projectSemanticIrV2ToLegacyV1(canonical, {
  cfg,
  ssa,
  validationOptions:tinyIrBudget,
}));

// Copies and foreign/frozen lookalikes remain untrusted and must traverse the original
// fail-closed validation path. The deliberately tiny budget proves that none of the
// fast paths can be obtained by structural equality or Object.freeze().
const copied = structuredClone(canonical);
for (const [name, run] of [
  ['SSA builder', () => buildSemanticSsa(copied, cfg, { irOptions:tinyIrBudget })],
  ['SSA validator', () => validateSemanticSsa(ssa, copied, cfg, { irOptions:tinyIrBudget })],
  ['v1 projector', () => projectSemanticIrV2ToLegacyV1(copied, { cfg, ssa, validationOptions:tinyIrBudget })],
]) {
  assert.throws(run, /semantic-ir-budget-exceeded-maxNodes/, `${name} must fully validate a copied IR`);
}

console.log('canonical Semantic IR producer fast path: PASS');
