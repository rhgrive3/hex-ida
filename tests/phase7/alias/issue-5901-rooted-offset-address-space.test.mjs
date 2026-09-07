import assert from 'node:assert/strict';
import {
  deriveCanonicalAddressProof,
  canonicalAddressProofToRegionEvidence,
} from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { deriveMemoryRegion, classifySemanticMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { effectSummaryAliasRelation, aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { provenAddressSpace } from '../../../js/analysis/alias/a1-region-alias.js';

const origin = { instructionIds: ['i1'] };

// Root descriptors accepted by the canonical proof core.
const tlsRoots = new Map([
  ['value:p', { kind: 'tls-like', rootEntityId: 'tls:R', addressSpace: 'tls', baseOffset: 0, linearOffsets: true }],
]);
const ioRoots = new Map([
  ['value:p', { kind: 'tls-like', rootEntityId: 'io:R', addressSpace: 'io', baseOffset: 0, linearOffsets: true }],
]);
const memRoots = new Map([
  ['value:p', { kind: 'heap-like', rootEntityId: 'heap:R', addressSpace: 'memory', baseOffset: 0, linearOffsets: true }],
]);

const ir = {
  functionId: 'fn:alias-space',
  values: [{ id: 'p', kind: 'address', definitionNodeId: 'n1' }],
  nodes: [{ id: 'n1', kind: 'const', value: 0x0n }],
};

function regionFor(space, roots) {
  const proof = deriveCanonicalAddressProof(ir, 'p', { addressSpace: space, rootDescriptors: roots });
  const evidence = canonicalAddressProofToRegionEvidence(proof);
  return { proof, evidence, region: deriveMemoryRegion({
    functionId: ir.functionId,
    memory: { addressSpace: space, widthBits: 64, addressExpr: { valueId: 'p' } },
    origin,
    regionEvidence: evidence,
  }) };
}

// 1. tls-like rooted descriptor keeps the final precise region in TLS.
const tls = regionFor('tls', tlsRoots);
assert.equal(tls.proof.kind, 'rooted');
assert.equal(tls.proof.addressSpace, 'tls');
assert.equal(tls.evidence.addressSpace, 'tls');
assert.equal(tls.region.kind, 'rooted-offset');
assert.equal(tls.region.addressSpace, 'tls');

// 2. TLS rooted region vs TLS-wide write: never a proven `no`.
assert.equal(
  effectSummaryAliasRelation({ scope: 'all', addressSpaces: ['tls'] }, tls.region),
  'may',
  'TLS-wide write must not be proven disjoint from a TLS rooted region',
);

// 3. TLS rooted region vs proven disjoint `memory` scope: separation holds.
assert.equal(
  effectSummaryAliasRelation({ scope: 'all', addressSpaces: ['memory'] }, tls.region),
  'no',
  'memory-only scope must stay separable from a TLS rooted region',
);

// 4. io rooted descriptor keeps its space too.
const io = regionFor('io', ioRoots);
assert.equal(io.region.addressSpace, 'io');
assert.equal(effectSummaryAliasRelation({ scope: 'all', addressSpaces: ['memory'] }, io.region), 'no');
assert.equal(effectSummaryAliasRelation({ scope: 'all', addressSpaces: ['io'] }, io.region), 'may');

// 5. Ordinary memory rooted descriptor keeps the historical space-less shape.
const mem = regionFor('memory', memRoots);
assert.equal(mem.region.kind, 'rooted-offset');
assert.equal(mem.region.addressSpace, undefined);
assert.equal(effectSummaryAliasRelation({ scope: 'all', addressSpaces: ['memory'] }, mem.region), 'may');

// 6. Same root/offset with different proven spaces are different regions.
assert.notEqual(tls.region.id, mem.region.id);

// 7. provenAddressSpace agrees along the round-trip.
assert.equal(provenAddressSpace(tls.region), 'tls');
assert.equal(provenAddressSpace(io.region), 'io');
assert.equal(provenAddressSpace(mem.region), 'memory');

// 8. Same root identity across different storage domains: never `must`.
// (Distinct rootEntityIds stay conservative `may` per the floor.)
const sharedRootTls = deriveMemoryRegion({
  functionId: ir.functionId,
  memory: { addressSpace: 'tls', widthBits: 64, addressExpr: { valueId: 'p' } },
  origin,
  regionEvidence: { kind: 'rooted-offset', rootEntityId: 'R:shared', offset: '0', addressSpace: 'tls' },
});
const sharedRootMem = deriveMemoryRegion({
  functionId: ir.functionId,
  memory: { widthBits: 64, addressExpr: { valueId: 'p' } },
  origin,
  regionEvidence: { kind: 'rooted-offset', rootEntityId: 'R:shared', offset: '0' },
});
assert.equal(aliasMemoryRegions(sharedRootTls, sharedRootMem), 'no',
  'same-root regions in different storage domains must not overlap by interval');
assert.equal(aliasMemoryRegions(sharedRootMem, sharedRootTls), 'no');

// 9. classifySemanticMemoryRegion end-to-end on a real store node keeps tls.
// The store's address value carries the canonical root descriptor, so the
// proof core derives the rooted proof itself.
const storeIr = {
  functionId: ir.functionId,
  origin: { instructionIds: ['i1'] },
  values: [
    { id: 'p', kind: 'address', definitionNodeId: 'n2', metadata: { canonicalRoot: { kind: 'tls-like', rootEntityId: 'tls:R', addressSpace: 'tls', baseOffset: 0, linearOffsets: true } } },
  ],
  nodes: [
    { id: 'n2', kind: 'store', origin: { instructionIds: ['i1'] }, memory: { addressSpace: 'tls', widthBits: 64, addressExpr: { valueId: 'p' } }, inputs: ['p'] },
  ],
};
const classified = classifySemanticMemoryRegion(storeIr, 'n2', { rootDescriptors: tlsRoots });
assert.equal(classified.kind, 'rooted-offset', `expected rooted region, got ${classified.kind}`);
assert.equal(classified.addressSpace, 'tls');

console.log('issue-5901 rooted-offset keeps its proven address space end-to-end: ok');
