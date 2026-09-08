import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } from '../../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import {
  canonicalAccessBindingDigest,
  canonicalAccessBindingForMetadata,
  canonicalAccessProofDigest,
  canonicalAliasProofDigest,
  canonicalIdentityDigest,
  canonicalProducerValueDigest,
  createCanonicalIdentityDigestMemo,
} from '../../../js/semantics/memoryssa/proof.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  createCanonicalMemoryForwardingSession,
  forwardMemoryValue,
} from '../../../js/semantics/memoryssa/queries.js';

function origin(id, address = 0x4000n) {
  return { instructionIds: [id], virtualRanges: [{ start: address, end: address + 4n }] };
}

const addrType = { kind: 'address', widthBits: 64, addressSpace: 'memory' };
const valueType = { kind: 'bitvector', widthBits: 32 };
const memory = {
  addressSpace: 'memory',
  addressExpr: { valueId: 'addr' },
  widthBits: 32,
  endian: 'little',
  alignment: 4,
  volatility: false,
  atomic: false,
  ordering: 'unknown',
  faults: [],
};
const nodes = [
  { id: 'n_addr', kind: 'const', blockId: 'entry', inputs: [], outputs: ['addr'], attributes: { value: 0x4000 }, origin: origin('addr') },
  { id: 'n_value', kind: 'const', blockId: 'entry', inputs: [], outputs: ['value'], attributes: { value: 0x11223344 }, origin: origin('value', 0x4004n) },
  { id: 'n_store', kind: 'store', blockId: 'entry', inputs: ['addr', 'value'], outputs: [], memory, origin: origin('store', 0x4008n) },
  { id: 'n_load', kind: 'load', blockId: 'entry', inputs: ['addr'], outputs: ['loaded'], memory, origin: origin('load', 0x400cn) },
];
const ir = createSemanticIrFunction({
  schemaVersion: 2,
  contractVersion: '2.0.0',
  functionId: 't013-memoryssa-access-cache',
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('block') }],
  values: [
    { id: 'addr', kind: 'definition', machineType: addrType, definitionNodeId: 'n_addr', sourceEntityId: 'n_addr', origin: origin('addr-value') },
    { id: 'value', kind: 'definition', machineType: valueType, definitionNodeId: 'n_value', sourceEntityId: 'n_value', metadata: { constant: { kind: 'bitvector', widthBits: 32, value: 0x11223344n } }, origin: origin('value-value') },
    { id: 'loaded', kind: 'definition', machineType: valueType, definitionNodeId: 'n_load', sourceEntityId: 'n_load', origin: origin('loaded-value') },
  ],
  nodes,
  completeness: 'complete',
  unknowns: [],
  origin: origin('function'),
});
const cfg = createSemanticCfg({
  functionId: ir.functionId,
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', successors: [] }],
});
const region = createMemoryRegionRef({
  id: 'r_global',
  kind: 'global-absolute',
  binaryId: 't013-cache-binary',
  address: '0x4000',
  widthBits: 32,
  origin: origin('region'),
});
const semanticIrDigest = stableDigest(ir);
const identity = {
  binaryId: 't013-cache-binary',
  sliceId: 't013-cache-slice',
  functionId: ir.functionId,
  semanticIrId: 't013-cache-ir',
  scalarSsaId: 't013-cache-ssa',
  memorySsaId: 't013-cache-memoryssa',
  snapshotId: 't013-cache-snapshot',
  semanticIrContractVersion: ir.contractVersion,
  semanticIrDigest,
  scalarSsaBuildVersion: '1.0.0',
  scalarSsaDigest: 't013-cache-ssa-digest',
  memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
  analyzerVersion: 't013-cache-analyzer',
};
const artifact = buildMemorySsa(ir, cfg, {
  regions: [region],
  resolveRegion: () => region,
  queryAlias: () => ({
    relation: 'must',
    reasonCodes: ['identical-region-identity'],
    evidenceIds: ['t013-cache-alias'],
    proof: {
      analyzerId: 'phase7.alias.solver',
      analyzerVersion: '1.1.0',
      completeness: 'complete',
      stopReason: null,
    },
  }),
  identity,
  snapshotId: identity.snapshotId,
  canonicalIrIdentity: {
    functionId: ir.functionId,
    semanticIrId: identity.semanticIrId,
    semanticIrContractVersion: ir.contractVersion,
    semanticIrDigest,
  },
});

const metadata = artifact.accessMetadata[0];
const binding = artifact.canonicalAccessBindings.find((candidate) =>
  candidate.memorySsaEntityId === metadata.memorySsaEntityId);
assert.ok(metadata && binding, 'fixture must publish a canonical access row and binding');

test('forwarding session private brand cannot be minted through constructor exposure', () => {
  const loadUse = artifact.uses.find((use) => use.sourceEntityId === 'n_load');
  assert.ok(loadUse, 'fixture must publish a load use');
  const sessionOptions = {
    functionId: artifact.functionId,
    memorySsaBuildVersion: artifact.buildVersion,
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
    ir,
  };
  const session = createCanonicalMemoryForwardingSession(artifact, sessionOptions);
  assert.ok(session, 'exact producer must create a session');
  assert.equal(Object.getPrototypeOf(session), Object.prototype, 'session constructor must not be exposed');
  assert.equal(session.constructor, Object, 'session must not reveal its private class constructor');

  const copiedArtifact = structuredClone(artifact);
  const copiedUse = copiedArtifact.uses.find((use) => use.sourceEntityId === 'n_load');
  // Object is the only reachable constructor after the prototype is hidden;
  // extra arguments cannot mint the private session brand.
  const constructorCandidate = new session.constructor(copiedArtifact, ir, {
    usesById: new Map(copiedArtifact.uses.map((use) => [String(use.id), use])),
    definitionsById: new Map(copiedArtifact.definitions.map((definition) => [String(definition.id), definition])),
    regionsById: new Map(copiedArtifact.regions.map((region) => [String(region.id), region])),
    metadataById: new Map(copiedArtifact.accessMetadata.map((metadata) => [String(metadata.memorySsaEntityId), metadata])),
  });
  const result = forwardMemoryValue(copiedArtifact, copiedUse, {
    ...sessionOptions,
    forwardingSession: constructorCandidate,
  });
  assert.equal(result.status, 'stale', 'serialized clone must not gain exact authority through constructor lookup');
  assert.equal(result.reason, 'memoryssa-independent-producer-identity-unavailable');
});
