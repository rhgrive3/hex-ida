import assert from 'node:assert/strict';
import {
  canonicalAddressProofToRegionEvidence,
  deriveCanonicalAddressProof,
} from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { deriveMemoryRegion, classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { a1RegionAlias, provenAddressSpace } from '../../../js/analysis/alias/a1-region-alias.js';
import { effectSummaryAliasRelation } from '../../../js/analysis/alias/legacy-safety-floor.js';

const origin = { instructionIds: ['i:4329'] };
const ir = {
  functionId: 'fn:4329',
  origin,
  values: [{ id: 'p', kind: 'address', definitionNodeId: 'n:const' }],
  nodes: [{ id: 'n:const', kind: 'const', value: 0x1000n, origin }],
};

function absolute(space) {
  const roots = new Map([['value:p', {
    kind: 'absolute-address',
    address: '0x1000',
    addressSpace: space,
  }]]);
  const proof = deriveCanonicalAddressProof(ir, 'p', { addressSpace: space, rootDescriptors: roots });
  const evidence = canonicalAddressProofToRegionEvidence(proof);
  const region = deriveMemoryRegion({
    functionId: ir.functionId,
    binaryId: 'bin:4329',
    memory: { addressSpace: space, widthBits: 32, addressExpr: { valueId: 'p' } },
    origin,
    regionEvidence: evidence,
  });
  return { roots, proof, evidence, region };
}

const memory = absolute('memory');
assert.equal(memory.proof.kind, 'absolute');
assert.equal(memory.proof.addressSpace, 'memory');
assert.deepEqual(memory.evidence, { kind: 'global-absolute', address: '0x1000' });
assert.equal(memory.region.kind, 'global-absolute');
assert.equal(provenAddressSpace(memory.region), 'memory');

const io = absolute('io');
assert.equal(io.proof.kind, 'absolute');
assert.equal(io.proof.addressSpace, 'io');
assert.equal(io.evidence.addressSpace, 'io', 'proof→region evidence must retain the proven non-memory space');
assert.equal(io.region.addressSpace, 'io', 'MemoryRegionRef must retain non-memory absolute space');
assert.equal(provenAddressSpace(io.region), 'io');
assert.notEqual(io.region.id, memory.region.id, 'same numeric address in different spaces must not share region identity');
assert.equal(a1RegionAlias(io.region, memory.region).relation, 'no', 'proven distinct spaces must separate');
assert.equal(effectSummaryAliasRelation({ scope: 'all', spaces: ['memory'] }, io.region), 'no', 'memory-wide effects must stay disjoint from absolute IO');
assert.equal(effectSummaryAliasRelation({ scope: 'all', spaces: ['io'] }, io.region), 'may', 'IO-wide effects must still clobber absolute IO');

const storeIr = {
  functionId: ir.functionId,
  origin,
  values: [{
    id: 'p', kind: 'address', definitionNodeId: 'n:store',
    metadata: { canonicalRoot: { kind: 'absolute-address', address: '0x1000', addressSpace: 'io' } },
  }],
  nodes: [{
    id: 'n:store', kind: 'store', origin,
    memory: { addressSpace: 'io', widthBits: 32, addressExpr: { valueId: 'p' } },
    inputs: ['p'],
  }],
};
const classified = classifySemanticMemoryRegion(storeIr, 'n:store', { binaryId: 'bin:4329' });
assert.equal(provenAddressSpace(classified), 'io', 'end-to-end classification must preserve the absolute proof space');
assert.equal(classified.addressSpace, 'io');

console.log('issue-4329 non-memory absolute address-space round-trip: ok');
