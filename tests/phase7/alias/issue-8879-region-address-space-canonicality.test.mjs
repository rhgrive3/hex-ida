// Regression for #8879: a non-canonical address-space *spelling* must never become
// separation or non-clobber authority on the C1 canonical-proof -> region -> A1 ->
// legacy-floor/effect-summary path. #5587/#5717 already established this rule for the
// A2/points-to consumer; this is the sibling authority path that was still comparing
// raw strings, so `"MEMORY"` against canonical flat `memory` minted a complete,
// transform-authorizing `NoAlias` for the same root, offset and width.
//
// Genuinely proven canonical domains (memory vs tls/io/custom spaces) must keep
// separating: #5901/#4329 are not reverted and nothing is blanket-degraded to `may`.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalAddressProofToRegionEvidence,
  deriveCanonicalAddressProof,
} from '../../../js/analysis/alias/canonical-address-v2-core.js';
import { classifySemanticMemoryRegion, deriveMemoryRegion, sameMemoryRegionIdentity } from '../../../js/analysis/alias/regions-v2.js';
import { a1RegionAlias, provenAddressSpace } from '../../../js/analysis/alias/a1-region-alias.js';
import { aliasMemoryRegions, effectSummaryAliasRelation } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { permitsSeparationTransform } from '../../../js/analysis/alias/result.js';

const origin = { instructionIds: ['i1'] };

function rooted(space, entityId = 'R:same') {
  const rootDesc = {
    kind: 'heap-like',
    rootEntityId: entityId,
    baseOffset: 0,
    linearOffsets: true,
    addressSpace: space,
  };
  const ir = {
    functionId: 'fn:space-canonical',
    origin,
    values: [{ id: 'p', kind: 'address', definitionNodeId: 'n1', metadata: { canonicalRoot: rootDesc } }],
    nodes: [{
      id: 'n1', kind: 'store', origin,
      memory: { addressSpace: space, widthBits: 64, addressExpr: { valueId: 'p' } },
      inputs: ['p'],
    }],
  };
  return classifySemanticMemoryRegion(ir, 'n1', { rootDescriptors: new Map([['value:p', rootDesc]]) });
}

test('#8879 case drift cannot mint NoAlias through the production classifier', () => {
  const drifted = rooted('MEMORY');
  const canonical = rooted('memory');

  assert.equal(drifted.kind, 'rooted-offset');
  assert.equal(canonical.kind, 'rooted-offset');
  // Same canonical root/offset/width is the same storage, whatever the spelling.
  assert.equal(drifted.rootEntityId, canonical.rootEntityId);
  assert.equal(String(drifted.offset), String(canonical.offset));
  assert.equal(provenAddressSpace(drifted), 'memory', 'a drift of flat memory must not name a new domain');
  assert.notEqual(aliasMemoryRegions(drifted, canonical), 'no');
  assert.notEqual(aliasMemoryRegions(canonical, drifted), 'no');

  const a1 = a1RegionAlias(drifted, canonical);
  assert.notEqual(a1.relation, 'no');
  assert.ok(!a1.reasonCodes.includes('distinct-address-space'));
  assert.equal(permitsSeparationTransform(a1), false, 'a spelling must not authorize a separation transform');
});

test('#8879 a case-drifted flat-memory target cannot escape a memory-wide clobber', () => {
  const drifted = rooted('MEMORY');
  const canonical = rooted('memory');
  for (const region of [drifted, canonical]) {
    assert.equal(effectSummaryAliasRelation({ scope: 'all', spaces: ['memory'] }, region), 'may');
    assert.equal(effectSummaryAliasRelation({ scope: 'all', addressSpaces: ['memory'] }, region), 'may');
  }
  // A canonical non-memory domain still separates from a memory-wide effect.
  const tls = rooted('tls', 'R:tls');
  assert.equal(tls.kind, 'rooted-offset');
  assert.equal(effectSummaryAliasRelation({ scope: 'all', spaces: ['memory'] }, tls), 'no');
});

test('#8879 padded and structured space tokens carry no separation authority', () => {
  const padded = rooted('  memory  ');
  const canonical = rooted('memory');
  assert.equal(provenAddressSpace(padded), 'memory');
  assert.notEqual(aliasMemoryRegions(padded, canonical), 'no');
  assert.notEqual(a1RegionAlias(padded, canonical).relation, 'no');
});

test('#8879 region identity gains no physical dimension from a spelling', () => {
  const drifted = rooted('MEMORY');
  const canonical = rooted('memory');
  assert.equal(drifted.id, canonical.id, 'one domain must keep one region identity');
  assert.equal(sameMemoryRegionIdentity(drifted, canonical), true);
  // Serialized/reconstructed form must not reintroduce the drift as authority.
  const rebuilt = deriveMemoryRegion({
    functionId: 'fn:space-canonical',
    memory: { addressSpace: 'MEMORY', widthBits: 64, addressExpr: { valueId: 'p' } },
    origin,
    regionEvidence: { kind: 'rooted-offset', rootEntityId: 'R:same', offset: '0', addressSpace: 'MEMORY' },
  });
  assert.equal(provenAddressSpace(rebuilt), 'memory');
  assert.notEqual(aliasMemoryRegions(rebuilt, canonical), 'no');
  assert.notEqual(a1RegionAlias(rebuilt, canonical).relation, 'no');
});

test('#8879 absolute proof projection treats a case drift as flat memory, not a new domain', () => {
  const ir = {
    functionId: 'fn:absolute-space-canonical',
    origin,
    values: [{ id: 'p', kind: 'address', definitionNodeId: 'n:const' }],
    nodes: [{ id: 'n:const', kind: 'const', value: 0x1000n, origin }],
  };
  const project = (space) => {
    const roots = new Map([['value:p', { kind: 'absolute-address', address: '0x1000', addressSpace: space }]]);
    const proof = deriveCanonicalAddressProof(ir, 'p', { addressSpace: space, rootDescriptors: roots });
    return { proof, evidence: canonicalAddressProofToRegionEvidence(proof) };
  };
  const drifted = project('MEMORY');
  assert.equal(drifted.proof.addressSpace, 'memory', 'the descriptor boundary stores the canonical token');
  assert.deepEqual(drifted.evidence, { kind: 'global-absolute', address: '0x1000' },
    'a drift of flat memory must not be reclassified as a rooted non-memory domain');
  // Genuine non-memory absolute spaces are still preserved (#4329).
  assert.deepEqual(project('io').evidence.addressSpace, 'io');
});

test('#8879 canonical proven spaces still separate, case-insensitively', () => {
  const memory = rooted('memory', 'R:shared');
  const tls = rooted('tls', 'R:shared');
  const io = rooted('io', 'R:shared');
  assert.equal(aliasMemoryRegions(memory, tls), 'no');
  assert.equal(aliasMemoryRegions(tls, io), 'no');
  assert.equal(a1RegionAlias(memory, tls).relation, 'no');
  // A differently-cased spelling of the *same* custom domain is the same domain.
  const customUpper = rooted('MMIO-A', 'R:shared');
  const customLower = rooted('mmio-a', 'R:shared');
  assert.notEqual(a1RegionAlias(customUpper, customLower).relation, 'no');
  assert.equal(a1RegionAlias(customLower, memory).relation, 'no',
    'a canonical custom space still separates from flat memory');
});
