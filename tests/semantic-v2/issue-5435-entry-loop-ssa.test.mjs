import assert from 'node:assert/strict';

import { buildSemanticSsa } from '../../js/semantics/ssa/build.js';
import { semanticSsaVirtualEntryPredecessor } from '../../js/semantics/ssa/contract.js';
import { getDefinitionForUse, getDefinitionsForVariable, getSsaUsesForSourceEntity } from '../../js/semantics/ssa/queries.js';
import { validateSemanticSsa } from '../../js/semantics/ssa/validate.js';

const bit32 = Object.freeze({ kind: 'bitvector', widthBits: 32 });
const origin = (id) => ({ operationIds: [id] });
const variable = (key) => ({ key, kind: 'logical-state', scope: 'function' });

function entryValue(id, variableKey = null) {
  return { id, kind: 'entry', machineType: bit32, sourceEntityId: `source:${id}`, variableKey, origin: origin(`value:${id}`) };
}
function definitionValue(id, definitionNodeId) {
  return { id, kind: 'definition', machineType: bit32, definitionNodeId, sourceEntityId: `source:${id}`, origin: origin(`value:${id}`) };
}
function stateRead(id, blockId, key, outputId) {
  return { id, kind: 'state-read', blockId, inputs: [], outputs: [outputId], variable: variable(key), origin: origin(`node:${id}`) };
}
function stateWrite(id, blockId, key, inputId) {
  return { id, kind: 'state-write', blockId, inputs: [inputId], outputs: [], variable: variable(key), origin: origin(`node:${id}`) };
}
function semanticFunction({ functionId = 'issue_5435', entryBlockId = 'entry', blocks, nodes = [], values = [] }) {
  const nodeIdsByBlock = new Map(blocks.map((id) => [id, []]));
  for (const node of nodes) nodeIdsByBlock.get(node.blockId).push(node.id);
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId,
    blocks: blocks.map((id) => ({ id, nodeIds: nodeIdsByBlock.get(id), origin: origin(`block:${id}`) })),
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin(`function:${functionId}`),
  };
}
function semanticCfg({ functionId = 'issue_5435', entryBlockId = 'entry', blocks, edges }) {
  const successors = new Map(blocks.map((id) => [id, []]));
  for (const [from, to, kind = 'branch'] of edges) successors.get(from).push({ to, kind });
  return { functionId, entryBlockId, blocks: blocks.map((id) => ({ id, successors: successors.get(id) })) };
}
function phiFor(ssa, key, blockId = 'entry') {
  return getDefinitionsForVariable(ssa, key).find((definition) => definition.kind === 'phi' && definition.blockId === blockId) ?? null;
}
function renamedUse(ssa, sourceEntityId) {
  return getSsaUsesForSourceEntity(ssa, sourceEntityId).find((use) => use.proof?.kind === 'renamed-use') ?? null;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

// The CFG layer's minimal two-block entry loop is accepted even without SSA state.
{
  const blocks = ['entry', 'body'];
  const ir = semanticFunction({ blocks });
  const cfg = semanticCfg({ blocks, edges: [['entry', 'body'], ['body', 'entry']] });
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));
  assert.equal(ssa.definitions.some((definition) => definition.kind === 'phi'), false);
}

// A canonical one-block infinite loop is equally valid.
{
  const blocks = ['entry'];
  const ir = semanticFunction({ blocks });
  const cfg = semanticCfg({ blocks, edges: [['entry', 'entry']] });
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));
}

// External entry state and a real backedge write merge at the real entry header.
{
  const blocks = ['entry', 'body'];
  const values = [
    entryValue('state_a_seed', 'state.a'),
    entryValue('body_source'),
    definitionValue('entry_read_value', 'entry_read'),
  ];
  const nodes = [
    stateRead('entry_read', 'entry', 'state.a', 'entry_read_value'),
    stateWrite('body_write', 'body', 'state.a', 'body_source'),
  ];
  const ir = semanticFunction({ blocks, nodes, values });
  const cfg = semanticCfg({ blocks, edges: [['entry', 'body'], ['body', 'entry']] });
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));

  const phi = phiFor(ssa, 'state.a');
  assert.ok(phi, 'entry header must receive a phi for loop-carried state');
  const virtual = semanticSsaVirtualEntryPredecessor(cfg);
  assert.deepEqual(phi.incoming.map((item) => item.predecessorBlockId).sort(), [virtual, 'body'].sort());
  const virtualIncoming = phi.incoming.find((item) => item.predecessorBlockId === virtual);
  const seed = ssa.definitions.find((definition) => definition.valueId === virtualIncoming.valueId);
  assert.equal(seed.proof.kind, 'entry-seed');
  assert.equal(seed.proof.sourceSemanticValueId, 'state_a_seed');
  assert.equal(getDefinitionForUse(ssa, renamedUse(ssa, 'entry_read')).valueId, phi.valueId);

  const missingSeed = clone(ssa);
  const missingSeedPhi = missingSeed.definitions.find((definition) => definition.valueId === phi.valueId);
  missingSeedPhi.incoming = missingSeedPhi.incoming.filter((item) => item.predecessorBlockId !== virtual);
  assert.throws(() => validateSemanticSsa(missingSeed, ir, cfg), /semantic-ssa-phi-predecessor-set-incomplete/);

  const forgedSeed = clone(ssa);
  const forgedPhi = forgedSeed.definitions.find((definition) => definition.valueId === phi.valueId);
  const realIncoming = forgedPhi.incoming.find((item) => item.predecessorBlockId === 'body');
  forgedPhi.incoming.find((item) => item.predecessorBlockId === virtual).valueId = realIncoming.valueId;
  assert.throws(() => validateSemanticSsa(forgedSeed, ir, cfg), /semantic-ssa-entry-phi-seed-required/);
}

// Self-loop writes use the same entry-seed merge semantics.
{
  const blocks = ['entry'];
  const values = [
    entryValue('state_a_seed', 'state.a'),
    entryValue('loop_source'),
    definitionValue('entry_read_value', 'entry_read'),
  ];
  const nodes = [
    stateRead('entry_read', 'entry', 'state.a', 'entry_read_value'),
    stateWrite('entry_write', 'entry', 'state.a', 'loop_source'),
  ];
  const ir = semanticFunction({ functionId: 'issue_5435_self', blocks, nodes, values });
  const cfg = semanticCfg({ functionId: 'issue_5435_self', blocks, edges: [['entry', 'entry']] });
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));
  const phi = phiFor(ssa, 'state.a');
  assert.ok(phi);
  assert.deepEqual(phi.incoming.map((item) => item.predecessorBlockId).sort(), [semanticSsaVirtualEntryPredecessor(cfg), 'entry'].sort());
  assert.equal(getDefinitionForUse(ssa, renamedUse(ssa, 'entry_read')).valueId, phi.valueId);
}

// A backedge with no write keeps the entry seed directly and does not invent a phi.
{
  const blocks = ['entry', 'body'];
  const values = [entryValue('state_a_seed', 'state.a'), definitionValue('entry_read_value', 'entry_read')];
  const nodes = [stateRead('entry_read', 'entry', 'state.a', 'entry_read_value')];
  const ir = semanticFunction({ functionId: 'issue_5435_no_write', blocks, nodes, values });
  const cfg = semanticCfg({ functionId: 'issue_5435_no_write', blocks, edges: [['entry', 'body'], ['body', 'entry']] });
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));
  assert.equal(phiFor(ssa, 'state.a'), null);
  assert.equal(getDefinitionForUse(ssa, renamedUse(ssa, 'entry_read')).proof.kind, 'entry-seed');
}

// A real block may use the preferred sentinel spelling; the SSA-only identity moves deterministically.
{
  const reserved = '@semantic-ssa-virtual-entry';
  const blocks = ['entry', 'body', reserved];
  const values = [entryValue('state_a_seed', 'state.a'), entryValue('body_source')];
  const nodes = [stateWrite('body_write', 'body', 'state.a', 'body_source')];
  const ir = semanticFunction({ functionId: 'issue_5435_collision', blocks, nodes, values });
  const cfg = semanticCfg({ functionId: 'issue_5435_collision', blocks, edges: [['entry', 'body'], ['body', 'entry']] });
  const virtual = semanticSsaVirtualEntryPredecessor(cfg);
  assert.equal(virtual, '@semantic-ssa-virtual-entry#1');
  const ssa = buildSemanticSsa(ir, cfg);
  assert.doesNotThrow(() => validateSemanticSsa(ssa, ir, cfg));
  assert.ok(phiFor(ssa, 'state.a').incoming.some((item) => item.predecessorBlockId === virtual));
}

console.log('issue #5435 entry-loop SSA: PASS');
