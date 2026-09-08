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

test('producer access binding and proof identities reuse only exact frozen rows', () => {
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(canonicalAccessBindingForMetadata(metadata), binding);
  assert.equal(canonicalAccessBindingDigest(binding), binding.bindingDigest);
  assert.equal(canonicalIdentityDigest(artifact.identity), stableDigest(artifact.identity));
  assert.equal(canonicalProducerValueDigest(metadata.memory), binding.memoryDigest);
  assert.equal(canonicalProducerValueDigest(metadata.origin), binding.originDigest);

  const producerAccessProof = metadata.accessProof;
  if (producerAccessProof) {
    assert.equal(Object.isFrozen(producerAccessProof), true);
    assert.equal(canonicalAccessProofDigest(producerAccessProof), producerAccessProof.proofDigest);
  }
  if (typeof metadata.aliasProof?.proofDigest === 'string') {
    assert.equal(Object.isFrozen(metadata.aliasProof), true);
    assert.equal(canonicalAliasProofDigest(metadata.aliasProof), metadata.aliasProof.proofDigest);
  }
});

test('copied and mutable rows remain on content-validation paths', () => {
  const copiedMetadata = structuredClone(metadata);
  const copiedBinding = canonicalAccessBindingForMetadata(copiedMetadata);
  assert.notEqual(copiedBinding, binding);
  assert.equal(copiedBinding.bindingDigest, binding.bindingDigest);
  assert.equal(canonicalProducerValueDigest(copiedMetadata.memory), binding.memoryDigest);

  const mutableBinding = structuredClone(binding);
  const before = canonicalAccessBindingDigest(mutableBinding);
  mutableBinding.sourceEntityId = 't013-mutated-source';
  const after = canonicalAccessBindingDigest(mutableBinding);
  assert.notEqual(after, before);
  assert.equal(typeof after, 'string');

  if (metadata.accessProof) {
    const copiedProof = structuredClone(metadata.accessProof);
    const proofBefore = canonicalAccessProofDigest(copiedProof);
    copiedProof.identity.digest = 'mutated-proof-identity';
    assert.notEqual(canonicalAccessProofDigest(copiedProof), proofBefore);
  }
});

test('per-build identity digest memo preserves mutable and shallow-freeze boundaries', () => {
  const memo = createCanonicalIdentityDigestMemo();
  const identity = Object.freeze({
    functionId: 't013-frozen-identity',
    nested: Object.freeze({ scope: 'function-local' }),
  });
  assert.equal(memo.digest(identity), stableDigest(identity));
  assert.equal(memo.digest(identity), stableDigest(identity));

  const mutable = { functionId: 't013-mutable-identity' };
  const before = memo.digest(mutable);
  mutable.functionId = 't013-mutated-identity';
  assert.notEqual(memo.digest(mutable), before);

  const entries = new Map([['before', 1]]);
  const shallowFrozen = Object.freeze({ entries });
  const mapBefore = memo.digest(shallowFrozen);
  entries.set('after', 2);
  assert.notEqual(memo.digest(shallowFrozen), mapBefore);
});

test('projection forwarding session reuses only the exact producer lifecycle', () => {
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
  assert.ok(session, 'exact frozen producer artifact should create a projection session');
  assert.equal(Object.isFrozen(ir), true, 'producer-bound Semantic IR is immutable before reuse');

  const direct = forwardMemoryValue(artifact, loadUse, sessionOptions);
  const reused = forwardMemoryValue(artifact, loadUse, {
    ...sessionOptions,
    forwardingSession: session,
  });
  assert.equal(reused.status, direct.status);
  assert.equal(reused.exact, direct.exact);
  assert.equal(reused.artifactDigest, direct.artifactDigest);

  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(forwardMemoryValue(artifact, loadUse, {
    ...sessionOptions,
    signal: cancelled.signal,
    forwardingSession: session,
  }).status, 'cancelled');
  assert.equal(forwardMemoryValue(artifact, loadUse, {
    ...sessionOptions,
    budget: { maxDefinitions: 1 },
    forwardingSession: session,
  }).status, 'budget-limited');
  assert.equal(forwardMemoryValue(artifact, loadUse, {
    ...sessionOptions,
    snapshotId: 't013-stale-snapshot',
    forwardingSession: session,
  }).status, 'stale');

  const copiedArtifact = structuredClone(artifact);
  assert.equal(createCanonicalMemoryForwardingSession(copiedArtifact, sessionOptions), null,
    'serialized copies must not inherit the producer lifecycle');
  const mutableCallerIr = structuredClone(ir);
  mutableCallerIr.nodes[0].kind = 'unsupported';
  assert.equal(createCanonicalMemoryForwardingSession(artifact, {
    ...sessionOptions,
    ir: mutableCallerIr,
  }), null, 'mutated caller-owned IR must not inherit the producer lifecycle');
  assert.equal(forwardMemoryValue(artifact, loadUse, {
    ...sessionOptions,
    ir: mutableCallerIr,
    forwardingSession: session,
  }).status, 'stale', 'a changed IR identity must re-enter the ordinary freshness check');
});
