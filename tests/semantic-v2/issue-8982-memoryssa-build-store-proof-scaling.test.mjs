import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { canonicalStoreValueProofDigest } from '../../js/semantics/memoryssa/proof-core.js';

const bit32 = Object.freeze({ kind: 'bitvector', widthBits: 32 });
const addr64 = Object.freeze({ kind: 'address', widthBits: 64, addressSpace: 'memory' });
const functionId = 'function_issue_8982';
const origin = (id) => ({ operationIds: [`op:${id}`] });
const varX = Object.freeze({ key: 'state.x', kind: 'logical-state', scope: 'function' });

const cfg = createSemanticCfg({
  functionId,
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', successors: [] }],
});
const region = createMemoryRegionRef({
  id: 'region_issue_8982',
  kind: 'rooted-offset',
  functionId,
  rootEntityId: 'root_issue_8982',
  offset: 0,
  widthBits: 1024,
});

function memory(widthBits = 32) {
  return {
    addressSpace: 'memory',
    addressValueId: 'addr_0',
    widthBits,
    endian: 'little',
    atomic: false,
    volatility: false,
  };
}

function entryValue(id, machineType, constant = null) {
  return {
    id,
    kind: 'entry',
    machineType,
    sourceEntityId: `source:${id}`,
    variableKey: null,
    ...(constant == null ? {} : { metadata: { constant } }),
    origin: origin(id),
  };
}

function definitionValue(id, definitionNodeId, machineType, variableKey) {
  return {
    id,
    kind: 'definition',
    machineType,
    definitionNodeId,
    sourceEntityId: definitionNodeId,
    variableKey,
    origin: origin(id),
  };
}

function storeNode(id, valueId) {
  return {
    id,
    kind: 'store',
    blockId: 'entry',
    inputs: ['addr_0', valueId],
    outputs: [],
    memory: memory(),
    origin: origin(id),
  };
}

// storeCount direct-constant stores plus one store whose operand resolves
// through the canonical scalar-SSA renamed use/definition chain.
function buildIr(storeCount) {
  const values = [
    entryValue('addr_0', addr64),
    definitionValue('r_0', 'rd_0', bit32, 'state.x'),
    entryValue('cb_0', bit32, { kind: 'bitvector', value: '7', widthBits: 32 }),
  ];
  const nodes = [
    { id: 'sw_0', kind: 'state-write', blockId: 'entry', inputs: ['cb_0'], outputs: [], variable: varX, origin: origin('sw_0') },
    { id: 'rd_0', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['r_0'], variable: varX, origin: origin('rd_0') },
    { id: 'st_scalar', kind: 'store', blockId: 'entry', inputs: ['addr_0', 'r_0'], outputs: [], memory: memory(), origin: origin('st_scalar') },
  ];
  for (let index = 0; index < storeCount; index += 1) {
    values.push(entryValue(`c_${index}`, bit32, { kind: 'bitvector', value: String(7 + index), widthBits: 32 }));
    nodes.push(storeNode(`st_${index}`, `c_${index}`));
  }
  nodes.push({ id: 'ret', kind: 'return', blockId: 'entry', inputs: [], outputs: [], origin: origin('ret') });
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('block') }],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('fn'),
  };
}

const ssa = {
  contractVersion: '2.0.0',
  functionId,
  definitions: [
    { definitionId: 'x-entry', valueId: 'x0', kind: 'entry', blockId: null, variableKey: 'state.x', sourceEntityId: functionId, incoming: [], origin: origin('x-entry'), proof: { kind: 'entry-seed', variableIdentity: varX, sourceSemanticValueId: null, machineType: bit32 } },
    { definitionId: 'x-write', valueId: 'x1', kind: 'definition', blockId: 'entry', variableKey: 'state.x', sourceEntityId: 'sw_0', incoming: [], origin: origin('x-write'), proof: { kind: 'renamed-definition', variableIdentity: varX, sourceSemanticValueId: 'cb_0', machineType: bit32 } },
  ],
  uses: [
    { useId: 'use-rd-0', valueId: 'x1', blockId: 'entry', sourceEntityId: 'rd_0', origin: origin('use-rd-0'), proof: { kind: 'renamed-use', variableIdentity: varX, sourceSemanticValueId: 'r_0', machineType: bit32 } },
    { useId: 'use-rd-shadow', valueId: 'x9', blockId: 'entry', sourceEntityId: 'rd_shadow', origin: origin('use-rd-shadow'), proof: { kind: 'renamed-use', variableIdentity: varX, sourceSemanticValueId: null, machineType: bit32 } },
  ],
};

function optionsFor(overriddenSsa) {
  return {
    regions: [region],
    resolveRegion() { return region; },
    queryAlias() { return 'must'; },
    ssa: overriddenSsa ?? ssa,
    identity: { functionId, memorySsaBuildVersion: '1.0.1' },
  };
}

// Behaviour: the hoisted node map and scalar-SSA index must produce exactly
// the same canonical store proofs as the previous per-store construction.
{
  const artifact = buildMemorySsa(buildIr(3), cfg, optionsFor());
  const writes = artifact.accessMetadata.filter((item) => item.canonicalValue);
  assert.equal(writes.length, 4, 'every store publishes exactly one canonical store-value proof entity');
  const proofBySource = new Map(writes.map((item) => [item.sourceEntityId, item.canonicalValue]));
  const scalar = proofBySource.get('st_scalar');
  assert.equal(scalar?.value, '7');
  assert.equal(scalar?.resolvedValueId, 'cb_0');
  assert.equal(scalar?.scalarSsaUseId, 'use-rd-0');
  assert.equal(scalar?.scalarSsaDefinitionId, 'x-write');
  assert.equal(canonicalStoreValueProofDigest(scalar), scalar.proofDigest, 'scalar-chained proof is self-digested');
  for (const [index, source] of ['st_0', 'st_1', 'st_2'].entries()) {
    const proof = proofBySource.get(source);
    assert.equal(proof.value, String(7 + index));
    assert.equal(proof.widthBits, 32);
    assert.equal(canonicalStoreValueProofDigest(proof), proof.proofDigest, 'direct proof is self-digested');
  }
}

// Scaling: building the node-by-id map once per store (the #8982 defect) is
// observable as a per-store re-materialisation of `irFunction.nodes`.  The
// fixed build reads the nodes array through `.map` a constant number of times
// regardless of the store count, and never falls back to linear `.find`
// rescans of the scalar-SSA arrays.
function instrumentedBuild(storeCount) {
  let nodeMapReads = 0;
  let scalarArrayScans = 0;
  const ir = buildIr(storeCount);
  const nodesProxy = new Proxy(ir.nodes, {
    get(target, property, receiver) {
      if (property === 'map') {
        return (...args) => {
          nodeMapReads += 1;
          return Array.prototype.map.apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const scanned = (array) => new Proxy(array, {
    get(target, property, receiver) {
      if (property === 'find' || property === 'findLast' || property === 'filter') {
        return (...args) => {
          scalarArrayScans += 1;
          return Array.prototype[property].apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const ssaProxy = new Proxy(ssa, {
    get(target, property, receiver) {
      if (property === 'uses') return scanned(target.uses);
      if (property === 'definitions') return scanned(target.definitions);
      return Reflect.get(target, property, receiver);
    },
  });
  const instrumentedIr = new Proxy(ir, {
    get(target, property, receiver) {
      if (property === 'nodes') return nodesProxy;
      return Reflect.get(target, property, receiver);
    },
  });
  const artifact = buildMemorySsa(instrumentedIr, cfg, optionsFor(ssaProxy));
  const writes = artifact.accessMetadata.filter((item) => item.canonicalValue);
  assert.equal(writes.length, storeCount + 1);
  return { nodeMapReads, scalarArrayScans };
}

{
  const small = instrumentedBuild(10);
  const large = instrumentedBuild(60);
  assert.equal(small.scalarArrayScans, 0, 'store proofs must not linearly rescan scalar-SSA arrays');
  assert.equal(large.scalarArrayScans, 0, 'store proofs must not linearly rescan scalar-SSA arrays');
  assert.ok(large.nodeMapReads <= small.nodeMapReads + 1,
    `node materialisation must stay build-constant, saw ${small.nodeMapReads} -> ${large.nodeMapReads}`);
  assert.equal(large.nodeMapReads, small.nodeMapReads,
    'node materialisation count must be independent of the store count');
}

console.log('issue-8982 memoryssa build store-proof scaling: PASS');
