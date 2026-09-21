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

const canonical = createSemanticIrFunction(raw);
assert.equal(isCanonicalSemanticIrProducerArtifact(canonical), true,
  'the exact validated producer object must carry private canonical identity');

const copied = structuredClone(canonical);
const frozenCopy = Object.freeze(structuredClone(canonical));
assert.equal(isCanonicalSemanticIrProducerArtifact(copied), false,
  'a structural copy must not acquire producer identity');
assert.equal(isCanonicalSemanticIrProducerArtifact(frozenCopy), false,
  'Object.freeze must not manufacture producer identity');

// The default internal path may reuse the exact canonical producer object.
const ssa = buildSemanticSsa(canonical, cfg);
assert.doesNotThrow(() => validateSemanticSsa(ssa, canonical, cfg));
assert.doesNotThrow(() => projectSemanticIrV2ToLegacyV1(canonical, { cfg, ssa }));

// Explicit validation controls are authoritative even for a canonical object.
// A deliberately tiny ingestion budget proves the fast path does not bypass them.
const tinyIrBudget = { budget:{ maxNodes:1 } };
for (const [name, run] of [
  ['SSA builder', () => buildSemanticSsa(canonical, cfg, { irOptions:tinyIrBudget })],
  ['SSA validator', () => validateSemanticSsa(ssa, canonical, cfg, { irOptions:tinyIrBudget })],
  ['v1 projector', () => projectSemanticIrV2ToLegacyV1(canonical, {
    cfg, ssa, validationOptions:tinyIrBudget,
  })],
]) {
  assert.throws(run, /semantic-ir-budget-exceeded-maxNodes/,
    `${name} must preserve explicit validation budgets`);
}

// Copies stay on the original fail-closed ingestion path as well.
for (const [name, run] of [
  ['SSA builder copy', () => buildSemanticSsa(copied, cfg, { irOptions:tinyIrBudget })],
  ['SSA validator copy', () => validateSemanticSsa(ssa, copied, cfg, { irOptions:tinyIrBudget })],
  ['v1 projector copy', () => projectSemanticIrV2ToLegacyV1(copied, {
    cfg, ssa, validationOptions:tinyIrBudget,
  })],
]) {
  assert.throws(run, /semantic-ir-budget-exceeded-maxNodes/,
    `${name} must fully validate copied IR`);
}

// Explicit nested abort signals must also remain authoritative.
const controller = new AbortController();
controller.abort('canonical-ir-fast-path-abort');
for (const [name, run] of [
  ['SSA builder abort', () => buildSemanticSsa(canonical, cfg, {
    irOptions:{ signal:controller.signal },
  })],
  ['SSA validator abort', () => validateSemanticSsa(ssa, canonical, cfg, {
    irOptions:{ signal:controller.signal },
  })],
  ['v1 projector abort', () => projectSemanticIrV2ToLegacyV1(canonical, {
    cfg, ssa, validationOptions:{ signal:controller.signal },
  })],
]) {
  assert.throws(run, /cancelled|abort/i,
    `${name} must preserve explicit abort signals`);
}

console.log('canonical Semantic IR producer fast path: PASS');
