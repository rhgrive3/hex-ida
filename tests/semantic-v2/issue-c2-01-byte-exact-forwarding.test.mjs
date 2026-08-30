import assert from 'node:assert/strict';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { validateSemanticIrFunction } from '../../js/semantics/ir/index.js';
import { createMemoryRegionRef, createMemorySsaContract } from '../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa, isCanonicalMemorySsaProducerArtifact } from '../../js/semantics/memoryssa/build.js';
import * as memorySsaBuild from '../../js/semantics/memoryssa/build.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  canonicalMemoryForwardingContext,
  forwardMemoryValue,
  isCanonicalExactMemoryForwarding,
} from '../../js/semantics/memoryssa/queries.js';
import { buildExpressionForTesting } from '../../js/decompiler/pipeline-core.js';
import { stableDigest } from '../../js/core/identity/index.js';
import {
  canonicalAccessProof,
  canonicalAccessBinding,
  canonicalAliasProof,
  canonicalAliasProofDigest,
  canonicalMemorySsaDigest,
  canonicalStoreValueProof,
  canonicalStoreValueProofDigest,
} from '../../js/semantics/memoryssa/proof.js';

const bit16 = { kind: 'bitvector', widthBits: 16 };
const bit32 = { kind: 'bitvector', widthBits: 32 };
const addr64 = { kind: 'address', widthBits: 64, addressSpace: 'memory' };

function origin(id, address = 0x3000n) {
  return { instructionIds: [id], virtualRanges: [{ start: address, end: address + 4n }] };
}

function definitionValue(id, definitionNodeId, machineType, address) {
  return {
    id,
    kind: 'definition',
    machineType,
    definitionNodeId,
    sourceEntityId: definitionNodeId,
    origin: origin(`ins_${id}`, address),
  };
}

function memory(addressValueId, widthBits) {
  return {
    addressSpace: 'memory',
    addressExpr: { valueId: addressValueId },
    widthBits,
    endian: 'little',
    alignment: Math.max(1, widthBits / 8),
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    faults: [],
  };
}

function rangeProof(memorySsaEntityId, sourceEntityId, regionId, range, access) {
  const addressExpr = access.addressExpr;
  const addressValueId = addressExpr.valueId == null ? null : String(addressExpr.valueId);
  const addressDigest = stableDigest(addressExpr);
  const addressDisplacement = (BigInt(range.start) - 0x4000n).toString();
  return {
    kind: 'canonical-memory-byte-range',
    version: '1.0.0',
    memorySsaEntityId,
    sourceEntityId,
    regionId,
    range,
    addressValueId,
    addressDigest,
    addressExpr,
    addressSpace: access.addressSpace,
    addressDisplacement,
    widthBits: access.widthBits,
    endian: access.endian,
    rangeDigest: stableDigest({
      range: {
        domain: String(range.domain),
        start: String(range.start),
        end: String(range.end),
      },
      addressValueId,
      addressDigest,
      addressDisplacement,
      widthBits: access.widthBits,
      endian: access.endian,
    }),
  };
}

const values = [
  definitionValue('addr', 'n_addr', addr64, 0x3000n),
  { ...definitionValue('lo', 'n_lo', bit16, 0x3004n), metadata: { constant: { kind: 'bitvector', widthBits: 16, value: 0x1122n } } },
  { ...definitionValue('hi', 'n_hi', bit16, 0x3008n), metadata: { constant: { kind: 'bitvector', widthBits: 16, value: 0x3344n } } },
  definitionValue('loaded', 'n_load', bit32, 0x3014n),
];

const nodes = [
  { id: 'n_addr', kind: 'address', blockId: 'b0', inputs: [], outputs: ['addr'], attributes: { value: '0x4000' }, origin: origin('addr', 0x3000n) },
  { id: 'n_lo', kind: 'const', blockId: 'b0', inputs: [], outputs: ['lo'], attributes: { value: 0x1122 }, origin: origin('lo', 0x3004n) },
  { id: 'n_store_lo', kind: 'store', blockId: 'b0', inputs: ['addr', 'lo'], outputs: [], memory: memory('addr', 16), attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } }, origin: origin('store_lo', 0x3008n) },
  { id: 'n_hi', kind: 'const', blockId: 'b0', inputs: [], outputs: ['hi'], attributes: { value: 0x3344 }, origin: origin('hi', 0x300cn) },
  { id: 'n_store_hi', kind: 'store', blockId: 'b0', inputs: ['addr', 'hi'], outputs: [], memory: memory('addr', 16), attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '2' } } } }, origin: origin('store_hi', 0x3010n) },
  { id: 'n_load', kind: 'load', blockId: 'b0', inputs: ['addr'], outputs: ['loaded'], memory: memory('addr', 32), attributes: { machineEffects: { operationMetadata: { addressing: { addressDisplacement: '0' } } } }, origin: origin('load', 0x3014n) },
  { id: 'n_return', kind: 'return', blockId: 'b0', inputs: ['loaded'], outputs: [], origin: origin('return', 0x3018n) },
];

const ir = {
  schemaVersion: 2,
  contractVersion: '2.0.0',
  functionId: 'fn_c2_01_fixture',
  entryBlockId: 'b0',
  blocks: [{ id: 'b0', nodeIds: nodes.map((node) => node.id), origin: origin('block') }],
  values,
  nodes,
  completeness: 'complete',
  unknowns: [],
  origin: origin('function'),
};
const canonicalIr = validateSemanticIrFunction(ir);

const canonicalRegion = createMemoryRegionRef({
  id: 'r_global',
  kind: 'global-absolute',
  binaryId: 'binary_fixture',
  address: '0x4000',
  widthBits: 32,
  origin: origin('region', 0x4000n),
});
const canonicalCfg = createSemanticCfg({
  functionId: canonicalIr.functionId,
  entryBlockId: 'b0',
  blocks: [{ id: 'b0', successors: [] }],
});
const canonicalIdentity = {
  binaryId: 'binary_fixture', sliceId: 'slice_fixture', functionId: canonicalIr.functionId,
  semanticIrId: 'ir_fixture', scalarSsaId: 'ssa_fixture', memorySsaId: 'mssa_fixture',
  snapshotId: 'snapshot_fixture', semanticIrContractVersion: '2.0.0',
  semanticIrDigest: stableDigest(canonicalIr), scalarSsaBuildVersion: '1.0.0',
  scalarSsaDigest: 'ssa_fixture_digest', memorySsaBuildVersion: '1.0.0',
  analyzerVersion: 'memoryssa-fixture',
};
const memorySsa = buildMemorySsa(canonicalIr, canonicalCfg, {
  regions: [canonicalRegion],
  resolveRegion: () => canonicalRegion,
  queryAlias: () => ({
    relation: 'must',
    reasonCodes: ['identical-region-identity'],
    evidenceIds: ['canonical-fixture-alias'],
    proof: {
      analyzerId: 'phase7.alias.solver',
      analyzerVersion: '1.1.0',
      completeness: 'complete',
      stopReason: null,
    },
  }),
  identity: canonicalIdentity,
  snapshotId: 'snapshot_fixture',
  canonicalIrIdentity: {
    functionId: canonicalIr.functionId,
    semanticIrId: 'ir_fixture',
    semanticIrContractVersion: '2.0.0',
    semanticIrDigest: stableDigest(canonicalIr),
  },
});
const MEMORY_REGION_ID = canonicalRegion.id;
const LOAD_USE_ID = memorySsa.uses.find((use) => use.sourceEntityId === 'n_load')?.id;
const STORE_LO_ID = memorySsa.definitions.find((definition) => definition.sourceEntityId === 'n_store_lo')?.id;
const STORE_HI_ID = memorySsa.definitions.find((definition) => definition.sourceEntityId === 'n_store_hi')?.id;
assert.ok(LOAD_USE_ID && STORE_LO_ID && STORE_HI_ID, 'canonical builder must publish fixture memory entities');
function fixtureEntityId(id) {
  return ({ u_load: LOAD_USE_ID, m1: STORE_LO_ID, m2: STORE_HI_ID }[id] ?? id);
}

function fixtureAlias(relation, sourceEntityId, evidenceId, purpose = 'fixture-memory-proof', artifact = memorySsa) {
  return canonicalAliasProof({
    result: {
      relation,
      reasonCodes: [relation === 'must' ? 'identical-region-identity' : 'disjoint-global-interval'],
      evidenceIds: [evidenceId],
      proof: {
        analyzerId: 'phase7.alias.solver',
        analyzerVersion: '1.1.0',
        completeness: 'complete',
        stopReason: null,
      },
    },
    identity: artifact.identity,
    functionId: artifact.functionId,
    leftRegionId: MEMORY_REGION_ID,
    rightRegionId: MEMORY_REGION_ID,
    sourceEntityIds: [sourceEntityId],
    purpose,
  });
}


const projected = projectSemanticIrV2ToLegacyV1(ir, { memorySsa });
const load = projected.instructions.find((instruction) => instruction.semanticNodeId === 'n_load');
assert.ok(load, 'fixture must produce a load instruction');

// C2-01: the two ordered 16-bit writes cover the 32-bit little-endian load.
// This is intentionally expected to fail on the pre-fix boundary, which forwards only the
// latest same-region store (0x3344) instead of reconstructing 0x33441122.
assert.equal(load.dst.const, 0x33441122n, 'MemorySSA must forward every proven byte, not only the latest store');
assert.equal(load.dst.bits, 32);
assert.equal(load.memoryForwarding?.status, 'exact');
assert.equal(load.reachingStore, undefined, 'exact consumers must use canonical forwarding, not structural reachingStore');
assert.deepEqual(load.memoryForwarding?.bytes, [0x22, 0x11, 0x44, 0x33]);
assert.deepEqual(load.memoryForwarding?.contributingDefinitionIds, [STORE_LO_ID, STORE_HI_ID]);

function query(artifact = memorySsa, options = {}) {
  return forwardMemoryValue(artifact, artifact.uses[0]?.id ?? 'u_load', {
    functionId: ir.functionId,
    ir: canonicalIr,
    consumerId: options.consumerId ?? CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: options.purpose ?? CANONICAL_MEMORY_FORWARDING_PURPOSE,
    ...options,
  });
}

function clonedArtifact() {
  return structuredClone(memorySsa);
}

function refreshDigest(artifact) {
  artifact.canonicalDigest = canonicalMemorySsaDigest(artifact);
  return artifact;
}

function refreshBindings(artifact) {
  artifact.canonicalAccessBindings = artifact.accessMetadata
    .map((metadata) => canonicalAccessBinding(metadata))
    .sort((a, b) => a.memorySsaEntityId.localeCompare(b.memorySsaEntityId)
      || a.regionId.localeCompare(b.regionId));
  return artifact;
}

function refreshAccessProof(artifact, id) {
  const item = metadataFor(artifact, id);
  const node = canonicalIr.nodes.find((candidate) => candidate.id === item.sourceEntityId);
  item.accessProof = canonicalAccessProof({
    raw: { architectureId: 'fixture', family: 'fixture-memory', evidence: { source: 'fixture-canonical-access', memoryAccessDigest: stableDigest(item.memory) } },
    descriptor: { node, memory: item.memory },
    identity: artifact.identity,
    functionId: artifact.functionId,
  });
}

function metadataFor(artifact, id) {
  return artifact.accessMetadata.find((item) => item.memorySsaEntityId === fixtureEntityId(id));
}

function definitionFor(artifact, id) {
  return artifact.definitions.find((item) => item.id === fixtureEntityId(id));
}

function setRange(artifact, id, start, end) {
  const metadata = metadataFor(artifact, id);
  const range = { ...metadata.byteRange, start: String(start), end: String(end) };
  metadata.byteRange = range;
  metadata.rangeProof = rangeProof(
    metadata.memorySsaEntityId,
    metadata.sourceEntityId,
    metadata.regionId,
    range,
    metadata.memory,
  );
  refreshBindings(artifact);
  refreshDigest(artifact);
}

function setLoadCoverageRange(artifact, start, end) {
  const coverage = artifact.byteCoverage[0];
  coverage.loadRange = { ...coverage.loadRange, start: String(start), end: String(end) };
  coverage.proof = { ...coverage.proof, loadRange: coverage.loadRange };
  refreshDigest(artifact);
}

// The direct canonical query returns the same proof-bearing fact as the v1
// compatibility consumer, including deterministic bytes and winning stores.
const direct = query();
assert.equal(direct.status, 'exact');
assert.equal(direct.value, 0x33441122n);
assert.deepEqual(direct.bytes, [0x22, 0x11, 0x44, 0x33]);
assert.equal(direct.completeness, 'complete');
assert.deepEqual(query(), direct, 'equivalent immutable artifacts must replay byte-for-byte');
const concurrentReplay = await Promise.all(
  Array.from({ length: 4 }, () => Promise.resolve().then(() => query())),
);
for (const replay of concurrentReplay) {
  assert.deepEqual(replay, direct, 'same-artifact concurrent replay must be deterministic');
}

// Producer authority is deliberately non-serializable and is not exposed as a
// token or registrar. A clean clone, a clone carrying a copied identity, and a
// clone carrying a re-signed identity must all fail closed.
assert.equal(memorySsa.__canonicalProducerIdentity, undefined,
  'producer authority must not be readable from an artifact property');
assert.equal(Object.getOwnPropertyNames(memorySsa).some((name) => /producer/i.test(name)), false,
  'producer authority must not be exposed as an enumerable or non-enumerable field');
assert.equal(isCanonicalMemorySsaProducerArtifact(memorySsa), true,
  'the exact object issued by the canonical builder must carry private authority');
for (const exportedName of [
  'canonicalMemorySsaProducerBinding',
  'canonicalMemorySsaProducerIdentity',
  'canonicalMemorySsaIdentityBinding',
  'registerCanonicalMemorySsaProducerArtifact',
  'transferCanonicalMemorySsaProducerBinding',
]) {
  assert.equal(typeof memorySsaBuild[exportedName], 'undefined',
    `${exportedName} must not expose a readable or mintable producer capability`);
}
const sameIdentityArtifact = buildMemorySsa(canonicalIr, canonicalCfg, {
  regions: [canonicalRegion],
  resolveRegion: () => canonicalRegion,
  queryAlias: () => ({
    relation: 'must',
    reasonCodes: ['identical-region-identity'],
    evidenceIds: ['canonical-fixture-alias'],
    proof: {
      analyzerId: 'phase7.alias.solver',
      analyzerVersion: '1.1.0',
      completeness: 'complete',
      stopReason: null,
    },
  }),
  identity: canonicalIdentity,
  snapshotId: 'snapshot_fixture',
  canonicalIrIdentity: {
    functionId: canonicalIr.functionId,
    semanticIrId: 'ir_fixture',
    semanticIrContractVersion: '2.0.0',
    semanticIrDigest: stableDigest(canonicalIr),
  },
});
assert.equal(query(sameIdentityArtifact).status, 'exact',
  'each canonical build receives its own exact publication authority');
const cleanClone = structuredClone(memorySsa);
assert.equal(query(cleanClone, {
  ir: null,
  registerArtifact: true,
}).status, 'stale', 'clean clone fake-registration must be rejected');
assert.equal(query(cleanClone, {
  currentIdentity: structuredClone(memorySsa.identity),
  ir: null,
}).status, 'stale', 'cross-process cloned identity must not authorize a clone');
const tamperedResignedClone = structuredClone(memorySsa);
metadataFor(tamperedResignedClone, 'm1').canonicalValue.value = '4369';
refreshDigest(tamperedResignedClone);
const tamperedCloneFact = query(tamperedResignedClone, {
  ir: null,
});
assert.notEqual(tamperedCloneFact.status, 'exact',
  'tampered/re-signed clone must not become exact');
const irNullClone = structuredClone(memorySsa);
assert.equal(query(irNullClone, { ir: null }).status, 'stale',
  'IR-null clone must remain stale without producer revalidation');

// A caller may not cross-wire a selected load to another producer by changing
// both metadata identities and re-signing its serialized range/access proofs.
// This attack intentionally omits the optional IR/source projection.
{
  const crossWiredLoad = clonedArtifact();
  const metadata = metadataFor(crossWiredLoad, 'u_load');
  const crossSourceId = 'n_cross_wired_load';
  const loadNode = canonicalIr.nodes.find((node) => node.id === 'n_load');
  metadata.sourceEntityId = crossSourceId;
  metadata.nodeId = crossSourceId;
  metadata.rangeProof = rangeProof(
    metadata.memorySsaEntityId,
    crossSourceId,
    metadata.regionId,
    metadata.byteRange,
    metadata.memory,
  );
  metadata.accessProof = canonicalAccessProof({
    raw: { architectureId: 'fixture', family: 'fixture-memory' },
    descriptor: { node: { ...loadNode, id: crossSourceId }, memory: metadata.memory },
    identity: crossWiredLoad.identity,
    functionId: crossWiredLoad.functionId,
  });
  refreshDigest(crossWiredLoad);
  assert.notEqual(query(crossWiredLoad, { ir: null }).status, 'exact');
}

// The same binding is required for every selected store definition, even when
// its range and access proof are re-signed against a different store node.
{
  const crossWiredStore = clonedArtifact();
  const metadata = metadataFor(crossWiredStore, 'm1');
  const crossSourceId = 'n_store_hi';
  const storeNode = canonicalIr.nodes.find((node) => node.id === crossSourceId);
  metadata.sourceEntityId = crossSourceId;
  metadata.nodeId = crossSourceId;
  metadata.rangeProof = rangeProof(
    metadata.memorySsaEntityId,
    crossSourceId,
    metadata.regionId,
    metadata.byteRange,
    metadata.memory,
  );
  metadata.accessProof = canonicalAccessProof({
    raw: { architectureId: 'fixture', family: 'fixture-memory' },
    descriptor: { node: storeNode, memory: metadata.memory },
    identity: crossWiredStore.identity,
    functionId: crossWiredStore.functionId,
  });
  refreshDigest(crossWiredStore);
  assert.notEqual(query(crossWiredStore, { ir: null }).status, 'exact');
}

// Re-signing every selected use field is still not enough. Without the
// canonical producer binding, an IR-less caller could redirect the use to a
// different (or even non-existent) source and make all pairwise metadata
// checks agree with that new identity.
{
  const reboundUse = clonedArtifact();
  const use = reboundUse.uses[0];
  const metadata = metadataFor(reboundUse, 'u_load');
  const reboundSourceId = 'n_store_lo';
  const reboundOrigin = metadataFor(memorySsa, 'm1').origin;
  use.sourceEntityId = reboundSourceId;
  use.origin = reboundOrigin;
  metadata.sourceEntityId = reboundSourceId;
  metadata.nodeId = reboundSourceId;
  metadata.origin = reboundOrigin;
  metadata.rangeProof = rangeProof(
    metadata.memorySsaEntityId,
    reboundSourceId,
    metadata.regionId,
    metadata.byteRange,
    metadata.memory,
  );
  metadata.accessProof = canonicalAccessProof({
    raw: { architectureId: 'fixture', family: 'fixture-memory' },
    descriptor: { node: { id: reboundSourceId, kind: 'load', origin: reboundOrigin }, memory: metadata.memory },
    identity: reboundUse.identity,
    functionId: reboundUse.functionId,
  });
  metadata.aliasProof = fixtureAlias('must', reboundSourceId, 'alias-rebound-load');
  reboundUse.origin = reboundOrigin;
  const coverage = reboundUse.byteCoverage[0];
  coverage.nodeId = reboundSourceId;
  coverage.proof = {
    ...coverage.proof,
    nodeId: reboundSourceId,
    identityDigest: stableDigest(reboundUse.identity),
  };
  coverage.regionAliasStates[0].aliasProof = fixtureAlias('must', reboundSourceId, 'alias-rebound-region');
  coverage.regionStates[0].aliasProof = fixtureAlias('must', reboundSourceId, 'alias-rebound-state');
  refreshDigest(reboundUse);
  assert.notEqual(query(reboundUse, { ir: null }).status, 'exact',
    'IR-less re-signed use/source cross-wiring must fail closed');
}

// The same IR-less re-signing attack must not redirect a contributing
// definition to another source while retaining its original MemorySSA ID.
{
  const reboundDefinition = clonedArtifact();
  const definition = definitionFor(reboundDefinition, 'm1');
  const metadata = metadataFor(reboundDefinition, 'm1');
  const reboundSourceId = 'n_store_hi';
  definition.sourceEntityId = reboundSourceId;
  metadata.sourceEntityId = reboundSourceId;
  metadata.nodeId = reboundSourceId;
  metadata.origin = metadataFor(memorySsa, 'm2').origin;
  definition.origin = metadata.origin;
  metadata.rangeProof = rangeProof(
    metadata.memorySsaEntityId,
    reboundSourceId,
    metadata.regionId,
    metadata.byteRange,
    metadata.memory,
  );
  metadata.accessProof = canonicalAccessProof({
    raw: { architectureId: 'fixture', family: 'fixture-memory' },
    descriptor: { node: { id: reboundSourceId, kind: 'store', origin: metadata.origin }, memory: metadata.memory },
    identity: reboundDefinition.identity,
    functionId: reboundDefinition.functionId,
  });
  metadata.aliasProof = fixtureAlias('must', reboundSourceId, 'alias-rebound-store');
  definition.proof.providerProof = metadata.aliasProof;
  metadata.canonicalValue = canonicalStoreValueProof({
    semanticValue: canonicalIr.values.find((value) => value.id === 'lo'),
    memorySsaEntityId: 'm1',
    valueId: 'lo',
    sourceEntityId: reboundSourceId,
    value: 0x1122n,
    widthBits: 16,
    identity: reboundDefinition.identity,
    functionId: reboundDefinition.functionId,
  });
  refreshDigest(reboundDefinition);
  assert.notEqual(query(reboundDefinition, { ir: null }).status, 'exact',
    'IR-less re-signed definition/source cross-wiring must fail closed');
}

// Address operands carry identity only; both the canonical producer and the
// query boundary reject an otherwise well-formed numeric address payload.
assert.equal(canonicalStoreValueProof({
  semanticValue: { id: 'address-value', kind: 'definition', machineType: addr64 },
  memorySsaEntityId: 'm-address',
  valueId: 'address-value',
  sourceEntityId: 'n_store_address',
  value: 0x1234n,
  widthBits: 64,
  identity: memorySsa.identity,
  functionId: memorySsa.functionId,
}), null);
{
  const numericAddress = clonedArtifact();
  const proof = { ...metadataFor(numericAddress, 'm1').canonicalValue, valueKind: 'address', value: '4660' };
  proof.proofDigest = canonicalStoreValueProofDigest(proof);
  metadataFor(numericAddress, 'm1').canonicalValue = proof;
  refreshDigest(numericAddress);
  assert.notEqual(query(numericAddress, { ir: null }).status, 'exact');
}
{
  const inheritedNumericAddress = clonedArtifact();
  const sourceProof = metadataFor(inheritedNumericAddress, 'm1').canonicalValue;
  const inheritedProof = Object.create({ value: '4660' });
  Object.assign(inheritedProof, { ...sourceProof, valueKind: 'address' });
  inheritedProof.proofDigest = canonicalStoreValueProofDigest(inheritedProof);
  metadataFor(inheritedNumericAddress, 'm1').canonicalValue = inheritedProof;
  refreshDigest(inheritedNumericAddress);
  assert.notEqual(query(inheritedNumericAddress, { ir: null }).status, 'exact',
    'address proofs must not expose inherited numeric values as byte constants');
}
{
  // A bitvector value must be an own canonical primitive too.  Re-signing the
  // proof digest while placing the value on its prototype must not make it
  // reachable through the query's value parser.
  const inheritedNumericBitvector = clonedArtifact();
  const sourceProof = metadataFor(inheritedNumericBitvector, 'm1').canonicalValue;
  const { value: ignoredValue, ...proofWithoutValue } = sourceProof;
  const inheritedProof = Object.create({ value: '4369' });
  Object.assign(inheritedProof, { ...proofWithoutValue, valueKind: 'bitvector' });
  inheritedProof.proofDigest = canonicalStoreValueProofDigest(inheritedProof);
  metadataFor(inheritedNumericBitvector, 'm1').canonicalValue = inheritedProof;
  refreshDigest(inheritedNumericBitvector);
  assert.notEqual(query(inheritedNumericBitvector, { ir: null, registerArtifact: true }).status, 'exact',
    'bitvector proofs must not expose inherited values as byte constants');
}

// Exact facts are capabilities published for one canonical artifact snapshot;
// a shape-compatible forged/re-signed fact must not pass the direct downstream
// gate, nor be folded by the decompiler consumer.
const directContext = canonicalMemoryForwardingContext(direct, {
  useId: direct.useId,
  sourceEntityId: 'n_load',
  nodeId: 'n_load',
  entityId: direct.loadEntityId,
  regionId: direct.loadRegionId,
  range: direct.loadRange,
  artifactDigest: direct.artifactDigest,
  snapshotId: direct.snapshotId,
  consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
  purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
});
assert.equal(isCanonicalExactMemoryForwarding(direct, directContext), true);
const forgedExact = {
  ...direct,
  artifactDigest: 'forged-artifact-digest',
  identity: { ...direct.identity, digest: 'forged-identity-digest' },
  loadRange: { ...direct.loadRange, start: '16385', end: '16389' },
};
assert.equal(isCanonicalExactMemoryForwarding(forgedExact, directContext), false);
assert.equal(isCanonicalExactMemoryForwarding(structuredClone(direct), directContext), false);
for (const [field, value] of [
  ['useId', 'u_other'],
  ['sourceEntityId', 'n_other_load'],
  ['nodeId', 'n_other_load'],
  ['entityId', 'u_other'],
  ['regionId', 'r_other'],
  ['artifactDigest', 'artifact-from-another-load'],
  ['snapshotId', 'snapshot-other'],
  ['consumerId', 'unrelated-consumer'],
  ['purpose', 'unrelated-purpose'],
]) {
  assert.equal(isCanonicalExactMemoryForwarding(direct, { ...directContext, [field]: value }), false,
    `exact fact must not replay across ${field}`);
}
assert.equal(isCanonicalExactMemoryForwarding(direct, {
  ...directContext,
  range: { ...direct.loadRange, start: '16385', end: '16389' },
}), false, 'exact fact must not replay across load ranges');
assert.equal(isCanonicalExactMemoryForwarding(direct, {
  ...directContext,
  artifact: {},
}), false, 'exact fact must not replay across artifact objects');

// A complete artifact's coverage index is global evidence. An unrelated
// malformed row therefore invalidates exact publication for this load too.
{
  const malformedUnrelatedCoverage = clonedArtifact();
  malformedUnrelatedCoverage.byteCoverage.push({ useId: 'u_missing' });
  refreshDigest(malformedUnrelatedCoverage);
  assert.notEqual(query(malformedUnrelatedCoverage, { ir: null }).status, 'exact');
}

// Downstream decompilation must not turn a structural MemorySSA edge into an
// exact constant after the canonical query has explicitly published a partial
// result.  The old pipeline-core path followed memUse.store here.
{
  const stored = {
    id: 'pipeline_stored', bits: 32, signed: false, kind: 'def', const: 0xdeadbeefn,
    uses: [], def: { id: 'pipeline_store_const', op: 'const', args: [], extra: { value: 0xdeadbeefn } },
  };
  const loaded = {
    id: 'pipeline_loaded', bits: 32, signed: false, kind: 'def', const: null, uses: [], def: null,
  };
  loaded.def = {
    id: 'pipeline_load', op: 'load', dst: loaded, args: [],
    loc: { kind: 'unknown', key: 'pipeline-memory' },
    memUse: { kind: 'store', inst: { args: [{ value: stored }] } },
    memoryForwarding: { status: 'partial', exact: false, reason: 'memory-forwarding-byte-hole', completeness: 'partial' },
  };
const expression = buildExpressionForTesting(loaded, {
    ir: { values: [stored, loaded], args: new Map() },
    model: { calls: [] },
  });
  assert.equal(expression.kind, 'load', 'partial canonical forwarding must remain a load expression');

  const structuralOnlyStored = { id: 'structural_store_value', const: 0x55667788n, bits: 32 };
  const structuralOnlyStore = { id: 'structural_store', op: 'store', args: [{ value: structuralOnlyStored }] };
  const structuralOnlyLoad = {
    id: 'structural_load',
    op: 'load',
    dst: { id: 'structural_load_dst', bits: 32 },
    args: [],
    loc: { kind: 'stack', key: 'sp+8' },
    memUse: { kind: 'store', inst: structuralOnlyStore },
    reachingStore: structuralOnlyStore,
  };
  structuralOnlyLoad.dst.def = structuralOnlyLoad;
  const structuralOnlyExpression = buildExpressionForTesting(structuralOnlyLoad.dst, {
    ir: { values: [structuralOnlyStored, structuralOnlyLoad.dst], args: new Map() },
    model: { calls: [] },
  });
  assert.equal(structuralOnlyExpression.kind, 'load', 'structural memory links cannot substitute a value without canonical proof');

  const forgedExpression = buildExpressionForTesting({
    ...loaded,
    def: {
      ...loaded.def,
      memoryForwarding: forgedExact,
    },
  }, {
    ir: { values: [stored, loaded], args: new Map() },
    model: { calls: [] },
  });
  assert.equal(forgedExpression.kind, 'load', 'forged exact forwarding must remain a load expression');
}

// Exercise the production builder and compatibility boundary as well as the
// hand-authored contract fixture above.  This variant is same-width so the
// canonical builder can prove the newest store without any test-only metadata.
const exactIrRaw = structuredClone(ir);
exactIrRaw.values.find((value) => value.id === 'loaded').machineType.widthBits = 16;
exactIrRaw.nodes.find((node) => node.id === 'n_load').memory.widthBits = 16;
exactIrRaw.nodes.find((node) => node.id === 'n_load').attributes.machineEffects.operationMetadata.addressing.addressDisplacement = '2';
const exactIr = createSemanticIrFunction(exactIrRaw);
const exactCfg = createSemanticCfg({
  functionId: exactIr.functionId,
  entryBlockId: 'b0',
  blocks: [{ id: 'b0', successors: [] }],
});
const builtRegion = memorySsa.regions[0];
const builtMemorySsa = buildMemorySsa(exactIr, exactCfg, {
  regions: [builtRegion],
  resolveRegion: () => builtRegion,
  queryAlias: () => ({
    relation: 'must',
    reasonCodes: ['identical-region-identity'],
    evidenceIds: ['canonical-fixture-alias'],
    proof: {
      analyzerId: 'phase7.alias.solver',
      analyzerVersion: '1.1.0',
      completeness: 'complete',
      stopReason: null,
    },
  }),
  identity: {
    binaryId: 'binary_fixture', sliceId: 'slice_fixture', functionId: exactIr.functionId,
    semanticIrId: 'ir_fixture', snapshotId: 'snapshot_fixture', semanticIrContractVersion: '2.0.0', semanticIrDigest: stableDigest(exactIr),
    scalarSsaId: 'ssa_fixture', scalarSsaBuildVersion: '1.0.0', scalarSsaDigest: 'ssa_fixture_digest',
    memorySsaId: 'mssa_fixture', memorySsaBuildVersion: '1.0.0', analyzerVersion: 'memoryssa-fixture',
  },
  snapshotId: 'snapshot_fixture',
  canonicalIrIdentity: { functionId: exactIr.functionId, semanticIrId: 'ir_fixture', semanticIrContractVersion: '2.0.0', semanticIrDigest: stableDigest(exactIr) },
});
assert.ok(builtMemorySsa.accessMetadata.length >= 3);
assert.equal(builtMemorySsa.byteCoverage.length, 1);
const builtProjection = projectSemanticIrV2ToLegacyV1(exactIr, { memorySsa: builtMemorySsa, cfg: exactCfg });
const builtLoad = builtProjection.instructions.find((instruction) => instruction.semanticNodeId === 'n_load');
assert.equal(builtLoad.memoryForwarding.status, 'exact');
assert.equal(builtLoad.dst.const, 0x3344n);

// A same-width store is an exact positive when the artifact is rebuilt by the
// canonical producer. A structured clone of the same bytes has no authority.
assert.equal(query(builtMemorySsa, { ir: exactIr }).status, 'exact');
assert.equal(query(builtMemorySsa, { ir: exactIr }).value, 0x3344n);
assert.equal(isCanonicalMemorySsaProducerArtifact(builtMemorySsa), true);

const bigEndian = clonedArtifact();
for (const id of ['u_load', 'm1', 'm2']) {
  const item = metadataFor(bigEndian, id);
  item.memory = { ...item.memory, endian: 'big' };
  item.rangeProof = rangeProof(item.memorySsaEntityId, item.sourceEntityId, item.regionId, item.byteRange, item.memory);
  refreshAccessProof(bigEndian, id);
}
refreshBindings(bigEndian);
refreshDigest(bigEndian);
assert.notEqual(query(bigEndian, { ir: null }).status, 'exact',
  'a re-signed endian clone must not become exact without a producer rebuild');

// Adjacent and overlapping positive coverage use BigInt byte ranges and never
// infer an uncovered byte.
const overlap = clonedArtifact();
setRange(overlap, 'm2', '16385', '16387');
metadataFor(overlap, 'm2').order = 4;
refreshBindings(overlap);
refreshDigest(overlap);
assert.notEqual(query(overlap, { ir: null, registerArtifact: true }).status, 'exact');
const orderedOverlap = clonedArtifact();
metadataFor(orderedOverlap, 'm1').memory = memory('addr', 32);
setRange(orderedOverlap, 'm1', '16384', '16388');
metadataFor(orderedOverlap, 'm2').memory = memory('addr', 16);
setRange(orderedOverlap, 'm2', '16385', '16387');
metadataFor(orderedOverlap, 'm2').order = 4;
metadataFor(orderedOverlap, 'm1').order = 2;
const overlapValue = canonicalStoreValueProof({
  semanticValue: { id: 'fixture-overlap-value', kind: 'definition', machineType: bit32, metadata: { constant: { kind: 'bitvector', widthBits: 32, value: 0xaabbccddn } } },
  memorySsaEntityId: 'm1', valueId: 'fixture-overlap-value', sourceEntityId: 'n_store_lo', value: 0xaabbccddn,
  widthBits: 32, identity: orderedOverlap.identity, functionId: orderedOverlap.functionId,
});
metadataFor(orderedOverlap, 'm1').canonicalValue = overlapValue;
refreshAccessProof(orderedOverlap, 'm1');
refreshAccessProof(orderedOverlap, 'm2');
refreshBindings(orderedOverlap);
refreshDigest(orderedOverlap);
assert.notEqual(query(orderedOverlap, { ir: null }).status, 'exact',
  'a re-signed overlap clone must not become exact without a producer rebuild');
const uncertainOverlap = clonedArtifact();
metadataFor(uncertainOverlap, 'm1').memory = memory('addr', 32);
setRange(uncertainOverlap, 'm1', '16384', '16388');
metadataFor(uncertainOverlap, 'm2').memory = memory('addr', 16);
setRange(uncertainOverlap, 'm2', '16385', '16387');
metadataFor(uncertainOverlap, 'm1').order = 2;
metadataFor(uncertainOverlap, 'm2').order = 2;
refreshBindings(uncertainOverlap);
refreshDigest(uncertainOverlap);
assert.notEqual(query(uncertainOverlap, { ir: null, registerArtifact: true }).status, 'exact');

// An overlap with one missing order is not ordered by the MemorySSA chain
// walk.  It must not be resolved by a fallback visit index.
const mixedOrderOverlap = structuredClone(orderedOverlap);
delete metadataFor(mixedOrderOverlap, 'm1').order;
refreshDigest(mixedOrderOverlap);
assert.notEqual(query(mixedOrderOverlap, { ir: null, registerArtifact: true }).status, 'exact');

// A range proof is tied to the canonical source address.  Supplying a
// conflicting projected address cannot redirect the bytes into another lane.
const sourceAddressMismatch = clonedArtifact();
assert.notEqual(query(sourceAddressMismatch, {
  registerArtifact: true,
  sourceByEntityId: new Map([['n_store_hi', {
    semanticNodeId: 'n_store_hi',
    addr: { precise: true, index: null, base: { const: 0x4001n }, disp: 0n },
    memoryAccess: memory('addr', 16),
    origin: metadataFor(sourceAddressMismatch, 'm2').origin,
  }]]),
}).status, 'exact');

// A range is not authoritative merely because its enclosing artifact digest
// was recomputed.  Without the canonical source node, the serialized proof
// must still carry the region-relative displacement; a shifted range is not
// allowed to redirect a load to another byte lane.
const reboundRange = clonedArtifact();
setRange(reboundRange, 'm1', '16385', '16387');
assert.notEqual(query(reboundRange, { ir: null }).status, 'exact');
const shiftedRegion = clonedArtifact();
shiftedRegion.regions[0].address = '0x4001';
refreshDigest(shiftedRegion);
assert.notEqual(query(shiftedRegion, { ir: null }).status, 'exact');

// A provenance conflict in a secondary key domain is still a conflict even
// when the instruction id remains unchanged.
const conflictingRangeProvenance = clonedArtifact();
  definitionFor(conflictingRangeProvenance, 'm1').origin = {
  instructionIds: ['ins_m1'],
  virtualRanges: [{ start: '0x3999', end: '0x399d' }],
};
refreshDigest(conflictingRangeProvenance);
assert.notEqual(query(conflictingRangeProvenance, { registerArtifact: true }).status, 'exact');

// Completeness is a required value, not a truthy hint.  Missing/null
// completeness and a memory-category unknown must all remain non-exact.
for (const value of [null, undefined]) {
  const missingCompleteness = clonedArtifact();
  if (value === null) missingCompleteness.completeness = null;
  else delete missingCompleteness.completeness;
  refreshDigest(missingCompleteness);
  assert.notEqual(query(missingCompleteness, { registerArtifact: true }).status, 'exact');
}
const memoryUnknownArtifact = clonedArtifact();
memoryUnknownArtifact.unknowns = [{ reason: 'memory state unavailable', categories: ['memory'] }];
refreshDigest(memoryUnknownArtifact);
assert.notEqual(query(memoryUnknownArtifact, { registerArtifact: true }).status, 'exact');
const malformedUnknownArtifact = clonedArtifact();
malformedUnknownArtifact.unknowns = [{ reason: 'malformed unknown', categories: null }];
refreshDigest(malformedUnknownArtifact);
assert.notEqual(query(malformedUnknownArtifact, { registerArtifact: true }).status, 'exact');

// Unknown volatile/atomic/sequencing qualifiers cannot be relabelled as
// ordinary accesses by recomputing their proof and artifact digests.
for (const field of ['volatility', 'atomic', 'ordering']) {
  const unknownQualifier = clonedArtifact();
  const item = metadataFor(unknownQualifier, 'u_load');
  item.memory = { ...item.memory, [field]: 'unknown' };
  item.sequencing = { ...item.sequencing, [field]: 'unknown' };
  item.accessProof = null;
  refreshDigest(unknownQualifier);
  assert.notEqual(query(unknownQualifier, { ir: null }).status, 'exact', `${field} unknown must block forwarding`);
}

// Alias issuer, provider completeness, and evidence are independently
// authoritative fields; an attacker cannot forge them by re-signing only the
// proof and outer artifact digests.
{
  const issuerForgery = clonedArtifact();
  const item = metadataFor(issuerForgery, 'm1');
  item.aliasProof = {
    ...item.aliasProof,
    issuer: { ...item.aliasProof.issuer, id: 'caller.asserted.alias' },
  };
  item.aliasProof.proofDigest = canonicalAliasProofDigest(item.aliasProof);
  refreshDigest(issuerForgery);
  assert.notEqual(query(issuerForgery, { registerArtifact: true }).status, 'exact');

  const providerForgery = clonedArtifact();
  const providerItem = metadataFor(providerForgery, 'm1');
  const providerEvidence = providerItem.aliasProof?.evidence ?? {};
  providerItem.aliasProof = {
    ...providerItem.aliasProof,
    evidence: {
      ...providerEvidence,
      provider: { ...providerEvidence.provider, completeness: 'partial' },
    },
  };
  providerItem.aliasProof.proofDigest = canonicalAliasProofDigest(providerItem.aliasProof);
  refreshDigest(providerForgery);
  assert.notEqual(query(providerForgery, { registerArtifact: true }).status, 'exact');

  const providerEvidenceForgery = clonedArtifact();
  const providerEvidenceItem = metadataFor(providerEvidenceForgery, 'm1');
  const providerEvidenceData = providerEvidenceItem.aliasProof?.evidence ?? {};
  providerEvidenceItem.aliasProof = {
    ...providerEvidenceItem.aliasProof,
    evidence: {
      ...providerEvidenceData,
      reasonCodes: ['different-canonical-reason'],
      provider: {
        ...providerEvidenceData.provider,
        reasonCodes: ['different-canonical-reason'],
        regionIds: ['r_other'],
      },
    },
  };
  providerEvidenceItem.aliasProof.proofDigest = canonicalAliasProofDigest(providerEvidenceItem.aliasProof);
  refreshDigest(providerEvidenceForgery);
  assert.notEqual(query(providerEvidenceForgery, { registerArtifact: true }).status, 'exact');

  const evidenceForgery = clonedArtifact();
  const evidenceItem = metadataFor(evidenceForgery, 'm1');
  evidenceItem.aliasProof = {
    ...evidenceItem.aliasProof,
    evidence: { ...evidenceItem.aliasProof.evidence, evidenceIds: [''] },
  };
  evidenceItem.aliasProof.proofDigest = canonicalAliasProofDigest(evidenceItem.aliasProof);
  refreshDigest(evidenceForgery);
  assert.notEqual(query(evidenceForgery, { registerArtifact: true }).status, 'exact');
}

// Coverage is bound to the exact load use and region, not just to a matching
// use id or load range.
for (const field of ['nodeId', 'regionId']) {
  const coverageBinding = clonedArtifact();
  coverageBinding.byteCoverage[0][field] = field === 'nodeId' ? 'n_other_load' : 'r_other';
  refreshDigest(coverageBinding);
  assert.notEqual(query(coverageBinding, { registerArtifact: true }).status, 'exact');
}
const coverageProofRegionForgery = clonedArtifact();
coverageProofRegionForgery.byteCoverage[0].proof.regionId = 'r_other';
refreshDigest(coverageProofRegionForgery);
assert.notEqual(query(coverageProofRegionForgery, { registerArtifact: true }).status, 'exact');

// A concrete definition must carry the canonical MemorySSA write-proof kind
// and schema version; alias evidence alone is not enough.
for (const field of ['kind', 'version']) {
  const definitionProofForgery = clonedArtifact();
  definitionFor(definitionProofForgery, 'm1').proof[field] = field === 'kind'
    ? 'caller-asserted-memory-write' : '0.0.0';
  refreshDigest(definitionProofForgery);
  assert.notEqual(query(definitionProofForgery, { registerArtifact: true }).status, 'exact');
}

// A forged/oversized canonical value cannot be smuggled through a narrow
// proven store by relying on BigInt.asUintN truncation.
const oversizedCanonicalValue = clonedArtifact();
metadataFor(oversizedCanonicalValue, 'm1').canonicalValue.value = '65536';
assert.equal(query(oversizedCanonicalValue).status, 'stale');

// A source projection may contain a forwardedValue field, but it has no
// authority over the canonical store operand.
const forgedSourceArtifact = clonedArtifact();
const forgedSourceValue = query(forgedSourceArtifact, {
  sourceByEntityId: new Map([
    ['n_store_lo', {
      semanticNodeId: 'n_store_lo', forwardedValue: 0xdeadbeefn,
      memoryAccess: metadataFor(memorySsa, 'm1').memory, origin: metadataFor(memorySsa, 'm1').origin,
    }],
    ['n_store_hi', {
      semanticNodeId: 'n_store_hi', forwardedValue: 0xcafebaben,
      memoryAccess: metadataFor(memorySsa, 'm2').memory, origin: metadataFor(memorySsa, 'm2').origin,
    }],
  ]),
});
assert.notEqual(forgedSourceValue.status, 'exact');

// A source projection cannot fill in a missing canonical memory descriptor.
// The query may use it to detect disagreement, but it may not turn incomplete
// artifact metadata into an exact access proof.
const sourceMemoryFallback = clonedArtifact();
delete metadataFor(sourceMemoryFallback, 'm2').memory;
delete metadataFor(sourceMemoryFallback, 'm2').sequencing;
refreshDigest(sourceMemoryFallback);
assert.notEqual(query(sourceMemoryFallback, {
  sourceByEntityId: new Map([['n_store_hi', {
    semanticNodeId: 'n_store_hi',
    memoryAccess: memory('addr', 16),
    origin: metadataFor(memorySsa, 'm2').origin,
  }]]),
}).status, 'exact');

// The canonical store operand is bound to the actual Semantic IR store input;
// changing only the proof's value id cannot redirect a store to another value.
const mismatchedStoreOperand = clonedArtifact();
const mismatchedValue = canonicalIr.values.find((value) => value.id === 'hi');
metadataFor(mismatchedStoreOperand, 'm1').canonicalValue = canonicalStoreValueProof({
  semanticValue: mismatchedValue,
  memorySsaEntityId: 'm1',
  valueId: 'hi',
  sourceEntityId: 'n_store_lo',
  value: mismatchedValue.metadata.constant.value,
  widthBits: 16,
  identity: mismatchedStoreOperand.identity,
  functionId: mismatchedStoreOperand.functionId,
});
refreshDigest(mismatchedStoreOperand);
assert.notEqual(query(mismatchedStoreOperand).status, 'exact');

// Only a must-alias proof for every contributing region may authorize byte
// reconstruction.  The region-state index cannot mix an unrelated region.
const uncertainRegionAlias = clonedArtifact();
uncertainRegionAlias.byteCoverage[0].regionStates[0].aliasRelation = 'may';
refreshDigest(uncertainRegionAlias);
assert.notEqual(query(uncertainRegionAlias, { registerArtifact: true }).status, 'exact');
const crossRegion = clonedArtifact();
crossRegion.regions.push({
  id: 'r_other', kind: 'global-absolute', binaryId: 'binary_fixture', address: '0x4000', widthBits: 32,
  origin: origin('region-other', 0x4000n),
});
crossRegion.byteCoverage[0].regionStates.push({
  regionId: 'r_other', definitionId: 'm1', order: 2,
  aliasRelation: 'must', aliasProof: { relation: 'must', evidenceIds: ['incorrect-cross-region'] },
});
refreshDigest(crossRegion);
assert.notEqual(query(crossRegion, { registerArtifact: true }).status, 'exact');

// Missing the canonical coverage index must not fall back to this use's one
// region: a second/may-alias region could own an uncovered byte.
const missingCoverageIndex = clonedArtifact();
missingCoverageIndex.regions.push({
  id: 'r_may', kind: 'global-absolute', binaryId: 'binary_fixture', address: '0x4000', widthBits: 32,
  origin: origin('region-may', 0x4000n),
});
delete missingCoverageIndex.byteCoverage;
refreshDigest(missingCoverageIndex);
assert.notEqual(query(missingCoverageIndex, { registerArtifact: true }).status, 'exact');

// An arbitrary source string is not a must-alias proof, even when the rest of
// the artifact is otherwise complete.
const forgedAliasSource = clonedArtifact();
metadataFor(forgedAliasSource, 'm1').aliasProof = { relation: 'must', source: 'caller-asserted' };
refreshDigest(forgedAliasSource);
assert.notEqual(query(forgedAliasSource, { registerArtifact: true }).status, 'exact');

// Proof metadata is bound to the stored canonical artifact digest and cannot
// be edited in place without invalidating exactness.
const alteredProofMetadata = clonedArtifact();
metadataFor(alteredProofMetadata, 'm1').canonicalValue.value = '4369';
assert.equal(query(alteredProofMetadata).status, 'stale');

// Rebinding the artifact digest cannot authorize an edited store value: the
// value proof itself is bound to the canonical Semantic IR value and its
// stored digest.  This closes the tempting "edit metadata, then re-sign the
// outer artifact" bypass.
const reboundAlteredProof = clonedArtifact();
metadataFor(reboundAlteredProof, 'm1').canonicalValue.value = '4369';
refreshDigest(reboundAlteredProof);
assert.notEqual(query(reboundAlteredProof).status, 'exact');

function addBarrier(artifact, kind, aliasRelation = 'unknown') {
  const barrierId = `barrier_${kind}`;
  artifact.definitions.push({
    id: barrierId, kind, regionId: MEMORY_REGION_ID, blockId: 'b0', previousDefinitionIds: [fixtureEntityId('m2')],
    incoming: [], aliasRelation, sourceEntityId: `n_${barrierId}`, origin: origin(barrierId),
    proof: { kind: 'conservative-memory-clobber', aliasRelation },
  });
  artifact.uses[0].reachingDefinitionId = barrierId;
  artifact.accessMetadata.push({
    memorySsaEntityId: barrierId, entityKind: 'definition', nodeId: `n_${barrierId}`, regionId: MEMORY_REGION_ID,
    sourceKind: kind === 'call-clobber' ? 'call' : kind === 'intrinsic-clobber' ? 'intrinsic' : 'store',
    role: 'write', accessIndex: 0, broad: kind !== 'may-alias-clobber', memory: kind === 'may-alias-clobber' ? memory('addr', 16) : null,
    sequencing: null, aliasProof: { relation: aliasRelation },
    ...(kind === 'may-alias-clobber' ? { byteRange: { ...metadataFor(artifact, 'm2').byteRange, start: '16384', end: '16388' } } : {}),
    order: 6,
  });
  artifact.byteCoverage[0].regionStates[0].definitionId = barrierId;
  return artifact;
}

for (const kind of ['may-alias-clobber', 'unknown-clobber', 'call-clobber', 'intrinsic-clobber']) {
  assert.notEqual(query(addBarrier(clonedArtifact(), kind)).status, 'exact', `${kind} must block exactness`);
}

const unknownAlias = clonedArtifact();
definitionFor(unknownAlias, 'm2').aliasRelation = 'may';
refreshDigest(unknownAlias);
assert.notEqual(query(unknownAlias, { registerArtifact: true }).status, 'exact');

const hole = clonedArtifact();
setRange(hole, 'm2', '16387', '16389');
assert.notEqual(query(hole, { ir: null, registerArtifact: true }).status, 'exact');
assert.equal(Object.hasOwn(query(hole, { ir: null }), 'value'), false, 'a byte hole must not expose a staged value');

const widthMismatch = clonedArtifact();
metadataFor(widthMismatch, 'u_load').memory = memory('addr', 16);
assert.notEqual(query(widthMismatch).status, 'exact');
const malformedAccess = clonedArtifact();
metadataFor(malformedAccess, 'u_load').memory = { ...memory('addr', 32), endian: 'middle' };
assert.notEqual(query(malformedAccess).status, 'exact');
const unsupportedWidth = clonedArtifact();
metadataFor(unsupportedWidth, 'u_load').memory = { ...memory('addr', 7) };
refreshBindings(unsupportedWidth);
refreshDigest(unsupportedWidth);
assert.notEqual(query(unsupportedWidth, { ir: null, registerArtifact: true }).status, 'exact');
const endianConflict = clonedArtifact();
metadataFor(endianConflict, 'm2').memory = { ...metadataFor(endianConflict, 'm2').memory, endian: 'big' };
refreshBindings(endianConflict);
refreshDigest(endianConflict);
assert.notEqual(query(endianConflict, { ir: null, registerArtifact: true }).status, 'exact');
const volatileAccess = clonedArtifact();
metadataFor(volatileAccess, 'u_load').memory = { ...metadataFor(volatileAccess, 'u_load').memory, volatility: true };
refreshBindings(volatileAccess);
refreshDigest(volatileAccess);
assert.notEqual(query(volatileAccess, { ir: null, registerArtifact: true }).status, 'exact');
const atomicAccess = clonedArtifact();
metadataFor(atomicAccess, 'u_load').memory = { ...metadataFor(atomicAccess, 'u_load').memory, atomic: true };
refreshBindings(atomicAccess);
refreshDigest(atomicAccess);
assert.notEqual(query(atomicAccess, { ir: null, registerArtifact: true }).status, 'exact');

const conflictingProvenance = clonedArtifact();
metadataFor(conflictingProvenance, 'm1').origin = origin('different-store');
refreshDigest(conflictingProvenance);
assert.notEqual(query(conflictingProvenance, { registerArtifact: true }).status, 'exact');
const missingStoreProvenance = clonedArtifact();
delete definitionFor(missingStoreProvenance, 'm1').origin;
refreshDigest(missingStoreProvenance);
assert.notEqual(query(missingStoreProvenance, { registerArtifact: true }).status, 'exact');
const missingLoadProvenance = clonedArtifact();
delete missingLoadProvenance.uses[0].origin;
refreshDigest(missingLoadProvenance);
assert.notEqual(query(missingLoadProvenance, { registerArtifact: true }).status, 'exact');

const staleFunction = clonedArtifact();
assert.equal(query(staleFunction, { functionId: 'different-function' }).status, 'stale');
const staleSnapshot = clonedArtifact();
staleSnapshot.snapshotId = 'snapshot-old';
assert.equal(query(staleSnapshot, { snapshotId: 'snapshot-new' }).status, 'stale');
const staleIdentity = clonedArtifact();
staleIdentity.identity = { binaryId: 'binary-old', semanticIrId: 'ir-old', ssaId: 'ssa-old', analyzerVersion: 'analyzer-old' };
assert.equal(query(staleIdentity, { expectedIdentity: { ...staleIdentity.identity, binaryId: 'binary-new' } }).status, 'stale');
assert.equal(query(memorySsa, { currentIdentity: memorySsa.identity }).status, 'stale',
  'the serialized artifact identity is not an independent current producer identity');
{
  // Re-signing every serialized identity/proof/digest field still cannot
  // publish a stale artifact when the caller supplies that artifact's own
  // identity. The private producer binding is intentionally absent from this
  // clone.
  const staleReSigned = clonedArtifact();
  staleReSigned.identity = { ...staleReSigned.identity, analyzerVersion: 'memoryssa-stale-resigned' };
  for (const item of staleReSigned.accessMetadata) {
    const node = canonicalIr.nodes.find((candidate) => candidate.id === item.sourceEntityId);
    item.accessProof = canonicalAccessProof({
      raw: { architectureId: 'fixture', family: 'fixture-memory', evidence: { source: 'fixture-canonical-access', memoryAccessDigest: stableDigest(item.memory) } },
      descriptor: { node, memory: item.memory },
      identity: staleReSigned.identity,
      functionId: staleReSigned.functionId,
    });
    item.aliasProof = fixtureAlias('must', item.sourceEntityId, `alias_stale_${item.memorySsaEntityId}`, 'fixture-memory-proof', staleReSigned);
    if (item.entityKind !== 'definition') continue;
    const valueId = item.sourceEntityId === 'n_store_lo' ? 'lo' : 'hi';
    const semanticValue = canonicalIr.values.find((value) => value.id === valueId);
    item.canonicalValue = canonicalStoreValueProof({
      semanticValue,
      memorySsaEntityId: item.memorySsaEntityId,
      valueId,
      sourceEntityId: item.sourceEntityId,
      value: semanticValue.metadata.constant.value,
      widthBits: item.memory.widthBits,
      identity: staleReSigned.identity,
      functionId: staleReSigned.functionId,
    });
    staleReSigned.definitions.find((definition) => definition.id === item.memorySsaEntityId).proof.providerProof = item.aliasProof;
  }
  for (const coverage of staleReSigned.byteCoverage) {
    coverage.proof.identityDigest = stableDigest(staleReSigned.identity);
    for (const state of coverage.regionAliasStates ?? []) {
      state.aliasProof = fixtureAlias('must', coverage.nodeId, `alias_stale_region_${state.regionId}`, 'fixture-memory-proof', staleReSigned);
    }
    for (const state of coverage.regionStates ?? []) {
      state.aliasProof = fixtureAlias('must', coverage.nodeId, `alias_stale_state_${state.regionId}`, 'fixture-memory-proof', staleReSigned);
    }
  }
  refreshBindings(staleReSigned);
  refreshDigest(staleReSigned);
  assert.equal(query(staleReSigned, { currentIdentity: staleReSigned.identity, ir: null }).status, 'stale');
}
const emptyIdentityField = clonedArtifact();
emptyIdentityField.identity.semanticIrDigest = '';
assert.equal(query(emptyIdentityField).status, 'stale');
const incompleteIdentity = clonedArtifact();
delete incompleteIdentity.identity.scalarSsaDigest;
assert.equal(query(incompleteIdentity).status, 'stale');
const staleBuild = clonedArtifact();
staleBuild.buildVersion = '0.0.0';
assert.equal(query(staleBuild, { memorySsaBuildVersion: '1.0.0' }).status, 'stale');

// Proof identity covers values, definition provenance, definition proof,
// coverage proof, and canonical IR identity—not only definition IDs.
const changedValueArtifact = clonedArtifact();
const changedValue = canonicalIr.values.find((value) => value.id === 'lo');
metadataFor(changedValueArtifact, 'm1').canonicalValue = canonicalStoreValueProof({
  semanticValue: { ...changedValue, metadata: { constant: { kind: 'bitvector', widthBits: 16, value: 0x1123n } } },
  memorySsaEntityId: 'm1', valueId: 'lo', sourceEntityId: 'n_store_lo', value: 0x1123n,
  widthBits: 16, identity: changedValueArtifact.identity, functionId: changedValueArtifact.functionId,
});
refreshBindings(changedValueArtifact);
refreshDigest(changedValueArtifact);
const changedValueFact = query(changedValueArtifact, { ir: null, registerArtifact: true });
assert.notEqual(changedValueFact.status, 'exact');
const changedOrigin = clonedArtifact();
const changedOriginValue = origin('m1-rewritten');
definitionFor(changedOrigin, 'm1').origin = changedOriginValue;
metadataFor(changedOrigin, 'm1').origin = changedOriginValue;
refreshAccessProof(changedOrigin, 'm1');
refreshDigest(changedOrigin);
assert.notEqual(query(changedOrigin).status, 'exact');
const changedDefinitionProof = clonedArtifact();
const changedAlias = fixtureAlias('must', 'n_store_lo', 'different-proof');
definitionFor(changedDefinitionProof, 'm1').proof.providerProof = changedAlias;
metadataFor(changedDefinitionProof, 'm1').aliasProof = changedAlias;
refreshBindings(changedDefinitionProof);
refreshDigest(changedDefinitionProof);
assert.notEqual(query(changedDefinitionProof, { registerArtifact: true }).status, 'exact');
const changedCoverageProof = clonedArtifact();
changedCoverageProof.byteCoverage[0].proof.evidenceIds = ['different-coverage-proof'];
refreshDigest(changedCoverageProof);
assert.notEqual(query(changedCoverageProof, { registerArtifact: true }).status, 'exact');
const changedCanonicalIr = clonedArtifact();
changedCanonicalIr.canonicalIrIdentity = { functionId: ir.functionId, semanticIrDigest: 'different-ir' };
assert.equal(query(changedCanonicalIr).status, 'stale');

const cancelledController = new AbortController();
cancelledController.abort();
assert.equal(query(memorySsa, { signal: cancelledController.signal }).status, 'cancelled');
assert.equal(query(memorySsa, { deadline: Date.now() - 1 }).status, 'budget-limited');
assert.equal(query(memorySsa, { maxIterations: 1 }).status, 'budget-limited');
assert.equal(query(memorySsa, { budget: { maxDefinitions: 1 } }).status, 'budget-limited');
assert.equal(query(memorySsa, { budget: { maxBytes: 1 } }).status, 'budget-limited');
assert.equal(query(memorySsa, { validationBudget: { maxWorkItems: 1 } }).status, 'budget-limited');
assert.equal(query(memorySsa, { validationBudget: { maxDefinitions: 1 } }).status, 'budget-limited');
assert.equal(query(memorySsa, { validationBudget: { deadline: Date.now() - 1 } }).status, 'budget-limited');
assert.equal(query(memorySsa, { validationBudget: { maxWorkItems: Number.MAX_SAFE_INTEGER + 1 } }).status, 'unsupported');
assert.equal(query(memorySsa, { deadline: 'not-a-deadline' }).status, 'unsupported');
for (const invalid of ['1', new Number(1), NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(query(memorySsa, { budget: { maxDefinitions: invalid } }).status, 'unsupported',
    `maxDefinitions must reject non-safe resource type ${String(invalid)}`);
  assert.equal(query(memorySsa, { budget: { maxWorkItems: invalid } }).status, 'unsupported',
    `maxWorkItems must reject non-safe resource type ${String(invalid)}`);
  assert.equal(query(memorySsa, { validationBudget: { maxWorkItems: invalid } }).status, 'unsupported',
    `validation maxWorkItems must reject non-safe resource type ${String(invalid)}`);
  assert.equal(query(memorySsa, { deadline: invalid }).status, 'unsupported',
    `deadline must reject non-safe resource type ${String(invalid)}`);
  assert.equal(query(memorySsa, { budget: { deadline: invalid } }).status, 'unsupported',
    `budget deadline must reject non-safe resource type ${String(invalid)}`);
  assert.throws(() => buildMemorySsa(canonicalIr, canonicalCfg, {
    budget: { maxWorkItems: invalid },
  }), /memory-ssa-build-invalid-budget-maxWorkItems/,
  `builder maxWorkItems must reject non-safe resource type ${String(invalid)}`);
  assert.throws(() => createMemorySsaContract({
    functionId: memorySsa.functionId,
    regions: memorySsa.regions,
    definitions: memorySsa.definitions,
    uses: memorySsa.uses,
  }, { budget: { maxWorkItems: invalid } }), /memory-ssa-invalid-budget-maxWorkItems/,
  `contract maxWorkItems must reject non-safe resource type ${String(invalid)}`);
}
const truncated = clonedArtifact();
truncated.completeness = 'truncated';
assert.notEqual(query(truncated, { registerArtifact: true }).status, 'exact');
const falselyCompleteBudget = clonedArtifact();
falselyCompleteBudget.status = { completeness: 'complete', stopReason: 'budget-exhausted' };
assert.notEqual(query(falselyCompleteBudget, { registerArtifact: true }).status, 'exact');
const falselyCompleteDeadline = clonedArtifact();
falselyCompleteDeadline.status = { completeness: 'complete', stopReason: 'timeout' };
assert.notEqual(query(falselyCompleteDeadline, { registerArtifact: true }).status, 'exact');
const falselyCompleteUnknown = clonedArtifact();
falselyCompleteUnknown.stopReason = 'unknown';
assert.notEqual(query(falselyCompleteUnknown, { registerArtifact: true }).status, 'exact');
const falselyCompleteTruncated = clonedArtifact();
falselyCompleteTruncated.truncated = true;
assert.notEqual(query(falselyCompleteTruncated, { registerArtifact: true }).status, 'exact');
const partialArtifact = clonedArtifact();
partialArtifact.completeness = 'partial';
assert.notEqual(query(partialArtifact, { registerArtifact: true }).status, 'exact');
const partialWithUnknowns = clonedArtifact();
partialWithUnknowns.completeness = 'partial';
partialWithUnknowns.unknowns = [{ reason: 'unrelated-state-gap', categories: ['state'] }];
refreshDigest(partialWithUnknowns);
assert.notEqual(query(partialWithUnknowns, { registerArtifact: true }).status, 'exact', 'declared unrelated unknowns cannot promote partial MemorySSA to exact');
assert.equal(query(memorySsa, { skipValidation: true }).status, 'unsupported');
assert.equal(query(memorySsa, { accessMetadata: memorySsa.accessMetadata }).status, 'unsupported');
const malformedArtifact = clonedArtifact();
malformedArtifact.accessMetadata = malformedArtifact.accessMetadata.filter((item) => item.memorySsaEntityId !== 'm2');
assert.notEqual(query(malformedArtifact).status, 'exact');
const malformedCoverage = clonedArtifact();
malformedCoverage.byteCoverage[0].loadRange.end = '16389';
assert.notEqual(query(malformedCoverage).status, 'exact');

// Downstream paired behavior: the compatibility projection receives the exact
// reconstructed value, while the paired hole remains unresolved.
const pairedHoleProjection = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: hole });
const pairedHoleLoad = pairedHoleProjection.instructions.find((instruction) => instruction.semanticNodeId === 'n_load');
assert.notEqual(pairedHoleLoad.dst.const, 0x33441122n);
assert.equal(pairedHoleLoad.reachingStore, undefined, 'a non-exact canonical result must not expose a legacy value link');

// Cancellation is checked during metadata/definition/byte scans, so a run
// cancelled mid-reconstruction cannot publish an exact value.
let cancellationReads = 0;
assert.equal(query(memorySsa, {
  signal: { get aborted() { cancellationReads += 1; return cancellationReads > 18; } },
}).status, 'cancelled');

// The downstream projection must clear structural reachingStore metadata when
// canonical MemorySSA is blocked by an unresolved call clobber.
const unresolvedCall = addBarrier(clonedArtifact(), 'call-clobber');
const unresolvedCallProjection = projectSemanticIrV2ToLegacyV1(ir, { memorySsa: unresolvedCall });
const unresolvedCallLoad = unresolvedCallProjection.instructions.find((instruction) => instruction.semanticNodeId === 'n_load');
assert.notEqual(unresolvedCallLoad.memoryForwarding?.status, 'exact');
assert.equal(unresolvedCallLoad.reachingStore, undefined);
assert.equal(unresolvedCallLoad.dst.const, null);

console.log('HEX-C2-01 minimum byte-exact forwarding regression: PASS');
