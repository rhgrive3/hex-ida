import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stableDigest } from '../../js/core/identity/index.js';
import { createOriginSet } from '../../js/core/identity/origin.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';
import { aliasMemoryRegions, classifySemanticMemoryRegion as classifyIndexed } from '../../js/analysis/alias/index-v2.js';
import { classifySemanticMemoryRegion as classifyHistorical } from '../../js/analysis/alias/regions-v2.js';

const facade = fs.readFileSync('js/analysis/alias/index-v2.js', 'utf8');
const source = fs.readFileSync('js/analysis/alias/regions-v2-indexed.js', 'utf8');

assert.match(facade, /export \{ classifySemanticMemoryRegion \} from '\.\/regions-v2-indexed\.js';/,
  'semantic-v2 consumers must use the indexed canonical region classifier');
assert.match(source, /classifySemanticMemoryRegion as classifySemanticMemoryRegionBase/,
  'indexed classifier must retain the historical classifier as its authority\/fallback');
assert.match(source, /const firstPassByIr = new WeakMap\(\)/,
  'first-pass canonical results must be cached only by immutable IR identity');
assert.match(source, /const pointerIndexMemo = new WeakMap\(\)/,
  'canonical pointer lookup tables must be indexed once per MemorySSA artifact');
assert.match(source, /isCanonicalMemorySsaProducerArtifact\(memorySsa\)/,
  'indexed refinement must retain the private producer-brand gate');
assert.match(source, /memorySsa\.identity\?\.semanticIrDigest[^\n]*irDigest\(ir\)/,
  'indexed refinement must retain exact Semantic IR digest binding');

const fastStart = source.indexOf('function fastPointerRegion(');
const fastEnd = source.indexOf('\nexport function classifySemanticMemoryRegion', fastStart);
assert.ok(fastStart >= 0 && fastEnd > fastStart, 'indexed pointer resolver must exist');
const fast = source.slice(fastStart, fastEnd);
assert.doesNotMatch(fast, /ssa\.uses\.filter\(/,
  'pointer refinement must not rescan all scalar SSA uses per memory access');
assert.doesNotMatch(fast, /ssa\.definitions\.find\(/,
  'pointer refinement must not rescan all scalar SSA definitions per memory access');
assert.doesNotMatch(fast, /memorySsa\.uses\.filter\(/,
  'pointer refinement must not rescan all MemorySSA uses per memory access');
assert.doesNotMatch(fast, /memorySsa\.definitions\.find\(/,
  'pointer refinement must not rescan all MemorySSA definitions per memory access');
assert.doesNotMatch(fast, /accessMetadata\.find\(/,
  'pointer refinement must not rescan all access metadata per memory access');

const publicStart = source.indexOf('export function classifySemanticMemoryRegion(');
const publicBody = source.slice(publicStart);
assert.match(publicBody, /if \(!first\) return classifySemanticMemoryRegionBase/,
  'unknown call shapes must fall back to historical classification');
assert.match(publicBody, /first\.result\?\.metadata\?\.reason !== 'missing-region-provenance'/,
  'only the historical pointer-through-stack missing-provenance case may refine');
assert.match(publicBody, /if \(!indexes\) return classifySemanticMemoryRegionBase/,
  'failed producer\/digest\/index preconditions must fail back to historical authority');
assert.match(publicBody, /if \(!descriptor\) return first\.result/,
  'an unproven pointer refinement must preserve the exact first-pass result');

const addr64 = Object.freeze({ kind: 'address', widthBits: 64, addressSpace: 'memory' });
const bit64 = Object.freeze({ kind: 'bitvector', widthBits: 64 });

function fixtureOrigin(id) {
  return createOriginSet({ instructionIds: [`instruction:${id}`] });
}

function memory(addressValueId) {
  return {
    addressSpace: 'memory',
    addressExpr: { valueId: addressValueId },
    widthBits: 64,
    endian: 'little',
    alignment: null,
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    faults: [],
  };
}

function pointerThroughStackFixture(label, displacement) {
  const functionId = `fn:index-parity:${label}`;
  const binaryId = 'binary:index-parity';
  const rootVariableKey = `stack-root:${label}`;
  const stateVariableKey = `state-pointer:${label}`;
  const nodeIds = ['store.ptr', 'load.ptr', 'state.read', 'const.disp', 'address.add', 'target.load'];
  const values = [
    { id: 'slot.addr', kind: 'entry', machineType: addr64, origin: fixtureOrigin(`${label}:slot`) },
    { id: 'root.ptr', kind: 'entry', machineType: addr64, variableKey: rootVariableKey, origin: fixtureOrigin(`${label}:root`) },
    { id: 'loaded.ptr', kind: 'definition', machineType: addr64, definitionNodeId: 'load.ptr', origin: fixtureOrigin(`${label}:loaded`) },
    { id: 'reloaded.ptr', kind: 'definition', machineType: addr64, definitionNodeId: 'state.read', variableKey: stateVariableKey, origin: fixtureOrigin(`${label}:reloaded`) },
    { id: 'disp', kind: 'definition', machineType: bit64, definitionNodeId: 'const.disp', metadata: { constant: { kind: 'bitvector', value: displacement } }, origin: fixtureOrigin(`${label}:disp`) },
    { id: 'target.addr', kind: 'definition', machineType: addr64, definitionNodeId: 'address.add', origin: fixtureOrigin(`${label}:target-addr`) },
    { id: 'target.value', kind: 'definition', machineType: bit64, definitionNodeId: 'target.load', origin: fixtureOrigin(`${label}:target-value`) },
  ];
  const stateVariable = { key: stateVariableKey, kind: 'logical-state', scope: 'function' };
  const nodes = [
    { id: 'store.ptr', kind: 'store', blockId: 'entry', inputs: ['slot.addr', 'root.ptr'], outputs: [], memory: memory('slot.addr'), origin: fixtureOrigin(`${label}:store`) },
    { id: 'load.ptr', kind: 'load', blockId: 'entry', inputs: ['slot.addr'], outputs: ['loaded.ptr'], memory: memory('slot.addr'), origin: fixtureOrigin(`${label}:load`) },
    { id: 'state.read', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['reloaded.ptr'], variable: stateVariable, origin: fixtureOrigin(`${label}:state-read`) },
    { id: 'const.disp', kind: 'const', blockId: 'entry', inputs: [], outputs: ['disp'], origin: fixtureOrigin(`${label}:const`) },
    { id: 'address.add', kind: 'binary', operator: 'add', blockId: 'entry', inputs: ['reloaded.ptr', 'disp'], outputs: ['target.addr'], origin: fixtureOrigin(`${label}:add`) },
    { id: 'target.load', kind: 'load', blockId: 'entry', inputs: ['target.addr'], outputs: ['target.value'], memory: memory('target.addr'), origin: fixtureOrigin(`${label}:target-load`) },
  ];
  const ir = {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds, origin: fixtureOrigin(`${label}:block`) }],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: fixtureOrigin(`${label}:function`),
  };
  const cfg = createSemanticCfg({ functionId, entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
  const ssa = {
    contractVersion: '2.0.0',
    functionId,
    definitions: [{
      definitionId: `ssa-definition:${label}`,
      valueId: `ssa-value:${label}`,
      kind: 'definition',
      blockId: 'entry',
      variableKey: stateVariableKey,
      sourceEntityId: 'state.read',
      proof: { kind: 'renamed-definition', variableIdentity: stateVariable, sourceSemanticValueId: 'loaded.ptr', machineType: addr64 },
    }],
    uses: [{
      useId: `ssa-use:${label}`,
      valueId: `ssa-value:${label}`,
      blockId: 'entry',
      sourceEntityId: 'state.read',
      proof: { kind: 'renamed-use', variableIdentity: stateVariable, sourceSemanticValueId: 'reloaded.ptr', machineType: addr64 },
    }],
  };
  const region = createMemoryRegionRef({
    id: `region:index-parity:${label}`,
    kind: 'global-absolute',
    binaryId,
    address: '0x4000',
    widthBits: 64,
    origin: fixtureOrigin(`${label}:region`),
  });
  const memorySsa = buildMemorySsa(ir, cfg, {
    resolveRegion: () => region,
    queryAlias: (left, right) => aliasMemoryRegions(left, right),
    identity: {
      functionId,
      semanticIrDigest: stableDigest(ir),
      memorySsaBuildVersion: '1.0.0',
      analyzerVersion: '1.0.0',
    },
  });
  const rootDescriptors = {
    [rootVariableKey]: { kind: 'stack-like', baseOffset: 0, addressSpace: 'memory', linearOffsets: true },
  };
  return { ir, targetNode: nodes.at(-1), options: { binaryId, ssa, rootDescriptors }, memorySsa };
}

function classifyParity(label, displacement) {
  const fixture = pointerThroughStackFixture(label, displacement);
  const first = classifyIndexed(fixture.ir, fixture.targetNode, fixture.options);
  assert.equal(first.kind, 'unknown', `${label}: first pass must remain conservative`);
  assert.equal(first.metadata?.reason, 'missing-region-provenance', `${label}: fixture must enter the pointer-through-stack fallback`);
  const options = { ...fixture.options, canonicalMemorySsa: fixture.memorySsa };
  const historical = classifyHistorical(fixture.ir, fixture.targetNode, options);
  const indexed = classifyIndexed(fixture.ir, fixture.targetNode, options);
  return { historical, indexed };
}

for (const [label, displacement, expectedOffset] of [
  ['primitive-string', '8', '8'],
  ['primitive-number', 8, '8'],
  ['primitive-bigint', 8n, '8'],
]) {
  const { historical, indexed } = classifyParity(label, displacement);
  assert.equal(historical.kind, 'stack-fixed', `${label}: historical primitive displacement must refine`);
  assert.equal(indexed.kind, 'stack-fixed', `${label}: indexed primitive displacement must refine`);
  assert.equal(indexed.offset, expectedOffset, `${label}: indexed displacement must preserve the canonical offset`);
  assert.equal(indexed.id, historical.id, `${label}: indexed and historical classifiers must mint the same region identity`);
}

for (const [label, displacement] of [
  ['structured-array', ['8']],
  ['boxed-string', new String('8')],
]) {
  const { historical, indexed } = classifyParity(label, displacement);
  assert.equal(historical.kind, 'unknown', `${label}: historical typed boundary must reject structured displacement`);
  assert.equal(indexed.kind, 'unknown', `${label}: indexed typed boundary must reject structured displacement`);
  assert.equal(indexed.id, historical.id, `${label}: rejected structured displacement must preserve historical region identity`);
}

let coercionReads = 0;
const coercible = {};
Object.defineProperty(coercible, 'toString', {
  enumerable: false,
  value() {
    coercionReads += 1;
    return '8';
  },
});
const coercibleParity = classifyParity('coercible-object', coercible);
assert.equal(coercibleParity.historical.kind, 'unknown', 'historical typed boundary must reject coercible objects');
assert.equal(coercibleParity.indexed.kind, 'unknown', 'indexed typed boundary must reject coercible objects');
assert.equal(coercionReads, 0, 'indexed displacement parsing must not execute user-controlled coercion hooks');

console.log('semantic-v2 indexed region-classification hot-path regression passed');
