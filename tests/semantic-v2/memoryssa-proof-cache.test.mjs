import assert from 'node:assert/strict';
import {
  canonicalAccessBinding,
  canonicalMemorySsaDigest,
} from '../../js/semantics/memoryssa/proof.js';

function deepFreeze(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function artifact(functionId = 'fn_cache') {
  return {
    contractVersion: '1.0.0',
    functionId,
    buildVersion: '1.0.0',
    completeness: 'complete',
    unknowns: [],
    identity: { functionId, memorySsaId: 'mssa_cache' },
    canonicalIrIdentity: { functionId, semanticIrDigest: 'ir-cache' },
    snapshotId: 'snapshot-cache',
    regions: [],
    definitions: [],
    uses: [],
    reachingDefinitionLinks: [],
    useDefLinks: [],
    defUseLinks: [],
    accessMetadata: [],
    canonicalAccessBindings: [],
    byteCoverage: [],
    blockStates: [],
  };
}

function access(sourceEntityId = 'n_load') {
  return {
    memorySsaEntityId: 'use_cache',
    entityKind: 'use',
    sourceEntityId,
    nodeId: sourceEntityId,
    regionId: 'region_cache',
    sourceKind: 'load',
    role: 'read',
    accessIndex: 0,
    order: 1,
    broad: false,
    memory: { addressSpace: 'memory', widthBits: 32, endian: 'little' },
    sequencing: { volatility: false, atomic: false, ordering: 'unknown' },
    origin: { instructionIds: ['ins_load'], virtualRanges: [] },
    byteRange: { domain: 'cache', start: '0', end: '4' },
    rangeProof: { kind: 'canonical-memory-byte-range', proofDigest: 'range' },
    accessProof: { kind: 'canonical-memory-access-qualifiers', proofDigest: 'access' },
    aliasRelation: 'must',
    aliasProof: { kind: 'canonical-memory-alias-proof', proofDigest: 'alias' },
    canonicalValue: null,
  };
}

const frozenArtifact = deepFreeze(artifact());
const frozenDigest = canonicalMemorySsaDigest(frozenArtifact);
assert.equal(canonicalMemorySsaDigest(frozenArtifact), frozenDigest,
  'deep-frozen canonical payloads must replay an identical digest');

const mutableArtifact = artifact();
const mutableDigest = canonicalMemorySsaDigest(mutableArtifact);
mutableArtifact.functionId = 'fn_changed';
assert.notEqual(canonicalMemorySsaDigest(mutableArtifact), mutableDigest,
  'mutable artifacts must never receive a stale memoized digest');

let accessorFunctionId = 'fn_accessor_a';
const accessorArtifact = artifact();
Object.defineProperty(accessorArtifact, 'functionId', {
  enumerable: true,
  configurable: false,
  get: () => accessorFunctionId,
});
Object.freeze(accessorArtifact);
const accessorDigest = canonicalMemorySsaDigest(accessorArtifact);
accessorFunctionId = 'fn_accessor_b';
assert.notEqual(canonicalMemorySsaDigest(accessorArtifact), accessorDigest,
  'frozen accessor objects must not be treated as immutable plain data');

const frozenAccess = deepFreeze(access());
const frozenBinding = canonicalAccessBinding(frozenAccess);
assert.equal(Object.isFrozen(frozenBinding), true,
  'memoized access bindings must be immutable');
assert.equal(canonicalAccessBinding(frozenAccess), frozenBinding,
  'deep-frozen access rows may reuse the exact immutable binding');

const mutableAccess = access();
const mutableBinding = canonicalAccessBinding(mutableAccess);
mutableAccess.sourceEntityId = 'n_changed';
assert.notEqual(canonicalAccessBinding(mutableAccess).bindingDigest, mutableBinding.bindingDigest,
  'mutable access rows must be revalidated after mutation');

console.log('semantic-v2 MemorySSA immutable proof cache: PASS');
