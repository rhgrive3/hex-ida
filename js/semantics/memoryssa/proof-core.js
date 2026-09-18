import { jsonSafe, stableDigest } from '../../core/identity/index.js';
import { canonicalMemoryAccessQualifiers } from '../memory-access-provider.js';

/*
 * MemorySSA forwarding is allowed to consume only evidence emitted by the
 * canonical builder.  These small, shared helpers keep the binding format in
 * one place so the producer and query cannot silently disagree about what is
 * covered by a proof digest.
 */
export const MEMORY_SSA_PROOF_VERSION = '1.0.0';
export const CANONICAL_ALIAS_ISSUERS = Object.freeze(new Set([
  'phase7.alias.a1-region',
  'phase7.alias.solver',
]));
// Alias proof versions are part of the authority boundary.  Accepting an
// arbitrary non-empty provider version would let a caller relabel a stale or
// incompatible provider answer as canonical merely by recomputing its digest.
export const CANONICAL_ALIAS_ISSUER_VERSIONS = Object.freeze({
  'phase7.alias.a1-region': '1.0.0',
  'phase7.alias.solver': '1.1.1',
});
export const CANONICAL_ACCESS_ISSUER = 'semantic-memoryssa.access';
export const CANONICAL_STORE_VALUE_ISSUER = 'semantic-memoryssa.store-operand';

/**
 * Module-owned ordinary-access provider for the canonical Semantic IR path.
 *
 * The callback implementation itself is the capability. Callers may pass this
 * exact function to MemorySSA, but cannot register or substitute their own
 * callback. The provider derives every claim from producer-independent,
 * architecture-specific adapter facts on the current descriptor. The
 * composition boundary remains in memory-access-provider.js; this layer only
 * binds the returned facts to the exact module-owned issuer/version/source.
 */
function canonicalSemanticAccessProvider(descriptor) {
  const facts = canonicalMemoryAccessQualifiers(descriptor);
  if (!facts) return null;
  return Object.freeze({
    kind: 'canonical-memory-access-qualifiers',
    issuer: Object.freeze({
      type: 'canonical-memory-access-provider',
      id: CANONICAL_ACCESS_ISSUER,
      version: MEMORY_SSA_PROOF_VERSION,
    }),
    ...facts,
  });
}

export function isCanonicalAccessProvider(_provider) {
  // #4513: caller-supplied callbacks never acquire access-qualifier authority.
  // canonicalAccessProof() derives the only allowed provider evidence from the
  // current descriptor inside this module instead.
  return false;
}

function weakObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const deeplyFrozenObjects = new WeakSet();
const memorySsaDigestCache = new WeakMap();
const accessBindingCache = new WeakMap();

// These caches are populated only by the canonical MemorySSA builder after it
// has deeply frozen the published artifact. Generic proof helpers remain
// content based for caller-owned values; only the exact frozen producer object
// can take the identity fast path.
const CANONICAL_PRODUCER_ACCESS_BINDINGS = new WeakMap();
const CANONICAL_PRODUCER_ACCESS_BINDING_DIGESTS = new WeakMap();
const CANONICAL_ACCESS_BINDING_CONSTRUCTED_DIGESTS = new WeakMap();
const CANONICAL_PRODUCER_IDENTITY_DIGESTS = new WeakMap();
const CANONICAL_PRODUCER_VALUE_DIGESTS = new WeakMap();
const CANONICAL_PRODUCER_ALIAS_PROOF_DIGESTS = new WeakMap();
const CANONICAL_PRODUCER_ACCESS_PROOF_DIGESTS = new WeakMap();
const CANONICAL_PRODUCER_STORE_VALUE_PROOF_DIGESTS = new WeakMap();
const CANONICAL_ALIAS_PROOF_CONSTRUCTED_DIGESTS = new WeakMap();
const CANONICAL_ACCESS_PROOF_CONSTRUCTED_DIGESTS = new WeakMap();
const CANONICAL_STORE_VALUE_PROOF_CONSTRUCTED_DIGESTS = new WeakMap();
const CANONICAL_IDENTITY_DIGEST_MEMOS = new WeakSet();

function isDeeplyFrozenPlainData(value, active = new WeakSet()) {
  if (value == null || typeof value !== 'object') return true;
  if (deeplyFrozenObjects.has(value)) return true;
  if (active.has(value)) return false;
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return false;
    if (!Object.isFrozen(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    active.add(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || !isDeeplyFrozenPlainData(descriptor.value, active)) {
        active.delete(value);
        return false;
      }
    }
    active.delete(value);
    deeplyFrozenObjects.add(value);
    return true;
  } catch {
    active.delete(value);
    return false;
  }
}

function isCacheablePlainRecord(value) {
  if (value == null || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
  } catch {
    return false;
  }
  return isDeeplyFrozenPlainData(value);
}

function frozenObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.isFrozen(value)
    ? value
    : null;
}

function cacheProducerProof(proof, cache, constructedDigests) {
  const candidate = frozenObject(proof);
  if (!candidate || typeof candidate.proofDigest !== 'string' || !candidate.proofDigest.trim()) return;
  if (constructedDigests.get(candidate) !== candidate.proofDigest) return;
  cache.set(candidate, candidate.proofDigest);
}

function cacheProducerValue(value, digest) {
  const candidate = frozenObject(value);
  if (!candidate || typeof digest !== 'string' || !digest.trim()) return;
  CANONICAL_PRODUCER_VALUE_DIGESTS.set(candidate, digest);
}

/*
 * The builder calls this after publishing one deeply frozen artifact. The
 * source-to-binding association lets forwarding validate the exact producer
 * row by identity, while copied/unbranded rows retain the full digest path.
 * This is a narrow internal handoff from build.js; it does not authorize
 * arbitrary caller-provided objects.
 */
export function registerCanonicalMemorySsaIdentities({ identity, accessMetadata, canonicalAccessBindings, byteCoverage } = {}) {
  if (!Array.isArray(accessMetadata) || !Array.isArray(canonicalAccessBindings)) return;
  const producerIdentity = frozenObject(identity);
  if (producerIdentity) CANONICAL_PRODUCER_IDENTITY_DIGESTS.set(producerIdentity, stableDigest(producerIdentity));
  const bindingById = new Map();
  for (const binding of canonicalAccessBindings) {
    const candidate = frozenObject(binding);
    const id = String(candidate?.memorySsaEntityId ?? '');
    if (!candidate || !id || bindingById.has(id)
        || CANONICAL_ACCESS_BINDING_CONSTRUCTED_DIGESTS.get(candidate) !== candidate.bindingDigest) continue;
    CANONICAL_PRODUCER_ACCESS_BINDING_DIGESTS.set(candidate, candidate.bindingDigest);
    bindingById.set(id, candidate);
  }
  for (const metadata of accessMetadata) {
    const source = frozenObject(metadata);
    const id = String(source?.memorySsaEntityId ?? '');
    const binding = bindingById.get(id);
    if (!source || !binding) continue;
    CANONICAL_PRODUCER_ACCESS_BINDINGS.set(source, binding);
    cacheProducerValue(source.memory, binding.memoryDigest);
    cacheProducerValue(source.sequencing, binding.sequencingDigest);
    cacheProducerValue(source.origin, binding.originDigest);
    cacheProducerValue(source.byteRange, binding.byteRangeDigest);
    cacheProducerValue(source.rangeProof, binding.rangeProofDigest);
    cacheProducerProof(source.aliasProof, CANONICAL_PRODUCER_ALIAS_PROOF_DIGESTS, CANONICAL_ALIAS_PROOF_CONSTRUCTED_DIGESTS);
    cacheProducerProof(source.accessProof, CANONICAL_PRODUCER_ACCESS_PROOF_DIGESTS, CANONICAL_ACCESS_PROOF_CONSTRUCTED_DIGESTS);
    cacheProducerProof(source.canonicalValue, CANONICAL_PRODUCER_STORE_VALUE_PROOF_DIGESTS, CANONICAL_STORE_VALUE_PROOF_CONSTRUCTED_DIGESTS);
  }
  for (const coverage of Array.isArray(byteCoverage) ? byteCoverage : []) {
    for (const state of coverage?.regionAliasStates ?? []) {
      cacheProducerProof(state?.aliasProof, CANONICAL_PRODUCER_ALIAS_PROOF_DIGESTS, CANONICAL_ALIAS_PROOF_CONSTRUCTED_DIGESTS);
    }
  }
}

function withoutDigest(value, key = 'proofDigest') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { [key]: ignored, ...rest } = value;
  return rest;
}

export function canonicalIdentityDigest(identity) {
  const cached = CANONICAL_PRODUCER_IDENTITY_DIGESTS.get(identity);
  if (cached !== undefined && Object.isFrozen(identity)) return cached;
  return stableDigest(identity ?? null);
}

function deeplyFrozenIdentity(value, seen = new WeakSet()) {
  if (value == null || (typeof value !== 'object' && typeof value !== 'function')) return true;
  try {
    if (!Object.isFrozen(value) || typeof value === 'function'
        || value instanceof Map || value instanceof Set || value instanceof Date
        || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
    if (seen.has(value)) return true;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor == null || !('value' in descriptor) || !deeplyFrozenIdentity(descriptor.value, seen)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/*
 * Proofs emitted during one MemorySSA build all bind the same immutable
 * identity snapshot. Keep this memo scoped to that build, and cache only a
 * deeply frozen data graph; mutable/untrusted values continue through
 * stableDigest every time.
 */
export function createCanonicalIdentityDigestMemo() {
  const cache = new WeakMap();
  const eligible = new WeakSet();
  let nullDigest;
  let hasNullDigest = false;
  const memo = Object.freeze({
    digest(identity) {
      if (identity == null) {
        if (!hasNullDigest) {
          nullDigest = stableDigest(null);
          hasNullDigest = true;
        }
        return nullDigest;
      }
      if (typeof identity !== 'object' && typeof identity !== 'function') return stableDigest(identity);
      if (!eligible.has(identity)) {
        if (!deeplyFrozenIdentity(identity)) return stableDigest(identity);
        eligible.add(identity);
      }
      const cached = cache.get(identity);
      if (cached !== undefined) return cached;
      const digest = stableDigest(identity);
      cache.set(identity, digest);
      return digest;
    },
  });
  CANONICAL_IDENTITY_DIGEST_MEMOS.add(memo);
  return memo;
}

function identityDigestForProof(identity, memo) {
  return CANONICAL_IDENTITY_DIGEST_MEMOS.has(memo)
    ? memo.digest(identity)
    : canonicalIdentityDigest(identity);
}

export function canonicalProducerValueDigest(value) {
  const cached = CANONICAL_PRODUCER_VALUE_DIGESTS.get(value);
  if (cached !== undefined && Object.isFrozen(value)) return cached;
  return stableDigest(value ?? null);
}

export function canonicalAliasProofDigest(proof) {
  const cached = CANONICAL_PRODUCER_ALIAS_PROOF_DIGESTS.get(proof);
  if (cached !== undefined && Object.isFrozen(proof)) return cached;
  return stableDigest(withoutDigest(proof));
}

export function canonicalAccessProofDigest(proof) {
  const cached = CANONICAL_PRODUCER_ACCESS_PROOF_DIGESTS.get(proof);
  if (cached !== undefined && Object.isFrozen(proof)) return cached;
  return stableDigest(withoutDigest(proof));
}

export function canonicalStoreValueProofDigest(proof) {
  const cached = CANONICAL_PRODUCER_STORE_VALUE_PROOF_DIGESTS.get(proof);
  if (cached !== undefined && Object.isFrozen(proof)) return cached;
  return stableDigest(withoutDigest(proof));
}

/*
 * This payload intentionally includes every serialized producer-side index.
 * `canonicalDigest` itself is excluded, which makes it a stable content
 * address that can be checked after transport or projection.  A mutation of
 * an alias/access/value proof therefore invalidates the artifact before any
 * exact result can be published.
 */
export function canonicalMemorySsaPayload(artifact) {
  return {
    contractVersion: artifact?.contractVersion ?? null,
    functionId: artifact?.functionId ?? null,
    buildVersion: artifact?.buildVersion ?? null,
    completeness: artifact?.completeness ?? null,
    unknowns: artifact?.unknowns ?? null,
    identity: artifact?.identity ?? null,
    canonicalIrIdentity: artifact?.canonicalIrIdentity ?? null,
    snapshotId: artifact?.snapshotId ?? null,
    regions: artifact?.regions ?? null,
    definitions: artifact?.definitions ?? null,
    uses: artifact?.uses ?? null,
    reachingDefinitionLinks: artifact?.reachingDefinitionLinks ?? null,
    useDefLinks: artifact?.useDefLinks ?? null,
    defUseLinks: artifact?.defUseLinks ?? null,
    accessMetadata: Array.isArray(artifact?.accessMetadata)
      ? artifact.accessMetadata.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const canonicalValue = entry.canonicalValue;
        return {
          ...entry,
          ...(canonicalValue && typeof canonicalValue === 'object' && !Array.isArray(canonicalValue)
            ? { canonicalValue: { ...canonicalValue } }
            : {}),
        };
      })
      : (artifact?.accessMetadata ?? null),
    canonicalAccessBindings: artifact?.canonicalAccessBindings ?? null,
    byteCoverage: artifact?.byteCoverage ?? null,
    blockStates: artifact?.blockStates ?? null,
  };
}

export function canonicalMemorySsaDigest(artifact) {
  if (isCacheablePlainRecord(artifact)) {
    const cached = memorySsaDigestCache.get(artifact);
    if (cached !== undefined) return cached;
    const digest = stableDigest(canonicalMemorySsaPayload(artifact));
    memorySsaDigestCache.set(artifact, digest);
    return digest;
  }
  return stableDigest(canonicalMemorySsaPayload(artifact));
}

/*
 * A MemorySSA access row is not self-authenticating: a caller can rewrite its
 * sourceEntityId/nodeId and recompute the row's access/range proof and the
 * enclosing artifact digest.  The builder therefore emits a second,
 * producer-owned binding table derived before publication.  Queries compare
 * every metadata row with this table (and with its selected use/definition),
 * so an IR-less serialized artifact cannot redirect one access merely by
 * re-signing the fields it is presenting.
 */
export function canonicalAccessBinding(access) {
  const cacheable = isCacheablePlainRecord(access);
  if (cacheable) {
    const cached = accessBindingCache.get(access);
    if (cached !== undefined) return cached;
  }
  const {
    memorySsaEntityId,
    entityKind,
    sourceEntityId,
    nodeId,
    regionId,
    sourceKind,
    role,
    accessIndex,
    order,
    broad,
    memory,
    sequencing,
    origin,
    byteRange,
    rangeProof,
    accessProof,
    aliasRelation,
    aliasProof,
    canonicalValue,
  } = access;
  const base = {
    memorySsaEntityId: String(memorySsaEntityId ?? ''),
    entityKind: String(entityKind ?? ''),
    sourceEntityId: String(sourceEntityId ?? ''),
    nodeId: String(nodeId ?? ''),
    regionId: String(regionId ?? ''),
    sourceKind: String(sourceKind ?? ''),
    role: String(role ?? ''),
    accessIndex: Number(accessIndex),
    order: order == null ? null : Number(order),
    broad: broad === true,
    memoryDigest: stableDigest(memory ?? null),
    sequencingDigest: stableDigest(sequencing ?? null),
    originDigest: stableDigest(origin ?? null),
    byteRangeDigest: stableDigest(byteRange ?? null),
    rangeProofDigest: stableDigest(rangeProof ?? null),
    accessProofDigest: stableDigest(accessProof ?? null),
    aliasRelation: String(aliasRelation ?? ''),
    aliasProofDigest: stableDigest(aliasProof ?? null),
    canonicalValueDigest: stableDigest(canonicalValue ?? null),
  };
  const binding = {
    ...base,
    bindingDigest: stableDigest(base),
  };
  if (!cacheable) {
    CANONICAL_ACCESS_BINDING_CONSTRUCTED_DIGESTS.set(binding, binding.bindingDigest);
    return binding;
  }
  const frozen = Object.freeze(binding);
  CANONICAL_ACCESS_BINDING_CONSTRUCTED_DIGESTS.set(frozen, frozen.bindingDigest);
  accessBindingCache.set(access, frozen);
  return frozen;
}

export function canonicalAccessBindingDigest(binding) {
  const cached = CANONICAL_PRODUCER_ACCESS_BINDING_DIGESTS.get(binding);
  if (cached !== undefined && Object.isFrozen(binding)) return cached;
  return stableDigest(withoutDigest(binding, 'bindingDigest'));
}

export function canonicalAccessBindingForMetadata(metadata) {
  const cached = CANONICAL_PRODUCER_ACCESS_BINDINGS.get(metadata);
  if (cached !== undefined && Object.isFrozen(metadata) && Object.isFrozen(cached)) return cached;
  return canonicalAccessBinding(metadata);
}

export function canonicalAliasProof({
  result,
  identity,
  identityDigestMemo = null,
  functionId,
  leftRegionId,
  rightRegionId,
  sourceEntityIds = [],
  purpose,
}) {
  const provider = result?.proof;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return null;
  /*
   * The issuer identity and relation enum are the soundness authority of a
   * canonical no/must-alias proof. String()-coercing structured values here
   * let `relation:['no']` or an array analyzer id launder into a canonical
   * proof issued by a "solver" that never existed (#5862).
   */
  const canonicalIssuerText = (value) => (typeof value === 'string' ? value : null);
  let issuerId = provider.analyzerId == null ? null : canonicalIssuerText(provider.analyzerId);
  let issuerVersion = provider.analyzerVersion == null ? null : canonicalIssuerText(provider.analyzerVersion);
  if (!issuerId || !CANONICAL_ALIAS_ISSUERS.has(issuerId) || !issuerVersion || !issuerVersion.trim()
      || CANONICAL_ALIAS_ISSUER_VERSIONS[issuerId] !== issuerVersion) return null;
  const relation = typeof result.relation === 'string' ? result.relation : '';
  if (!['must', 'no', 'may', 'unknown'].includes(relation)) return null;
  const base = {
    kind: 'canonical-memory-alias-proof',
    version: MEMORY_SSA_PROOF_VERSION,
    relation,
    issuer: {
      type: 'canonical-alias-analyzer',
      id: issuerId,
      version: issuerVersion,
    },
    identity: {
      functionId: String(functionId ?? ''),
      digest: identityDigestForProof(identity, identityDigestMemo),
    },
    provenance: {
      functionId: String(functionId ?? ''),
      purpose: String(purpose ?? ''),
      leftRegionId: String(leftRegionId ?? ''),
      rightRegionId: String(rightRegionId ?? ''),
      sourceEntityIds: [...new Set(sourceEntityIds.filter((id) => id != null).map(String))].sort(),
    },
    evidence: {
      reasonCodes: Array.isArray(result.reasonCodes) ? [...new Set(result.reasonCodes.map(String))].sort() : [],
      evidenceIds: Array.isArray(result.evidenceIds) ? [...new Set(result.evidenceIds.map(String))].sort() : [],
      provider: jsonSafe(provider),
    },
  };
  const proof = {
    ...base,
    proofDigest: canonicalAliasProofDigest(base),
  };
  CANONICAL_ALIAS_PROOF_CONSTRUCTED_DIGESTS.set(proof, proof.proofDigest);
  return proof;
}

export function canonicalAccessProof({ raw, descriptor, identity, identityDigestMemo = null, functionId, providerCallback }) {
  const memory = descriptor?.memory;
  if (!memory) return null;
  const sourceEntityId = typeof descriptor?.node?.id === 'string' ? descriptor.node.id : '';
  if (!sourceEntityId) return null;
  // Ignore caller-supplied provider evidence for authority. The canonical
  // ordinary-access claim is derived from the current descriptor inside this
  // module, so a callback cannot self-register, forge issuer fields, or execute
  // user code to close unknown qualifiers.
  const derivedProvider = canonicalSemanticAccessProvider(descriptor);
  const provider = derivedProvider ?? {};
  const providerIssuer = weakObject(provider.issuer);
  const providerAuthority = derivedProvider != null
    && providerIssuer?.type === 'canonical-memory-access-provider'
    && providerIssuer.id === CANONICAL_ACCESS_ISSUER
    && providerIssuer.version === MEMORY_SSA_PROOF_VERSION;
  const sourceQualifiersKnown = memory.volatility === false
    && memory.atomic === false
    && (memory.ordering == null || memory.ordering === 'unknown');
  const providerQualifiersKnown = providerAuthority
    && provider.kind === 'canonical-memory-access-qualifiers'
    && provider.sourceEntityId === sourceEntityId
    && provider.volatility === false
    && provider.atomic === false
    && (provider.ordering == null || provider.ordering === 'unknown')
    && provider.widthBits === memory.widthBits
    && provider.endian === memory.endian;
  // Some canonical machine-effect producers intentionally leave the
  // source-level qualifiers unknown.  Only their canonical access provider
  // may close that gap; an arbitrary callback cannot turn unknown metadata
  // into an ordinary access proof.
  if (!sourceQualifiersKnown && !providerQualifiersKnown) return null;
  const rawEvidence = providerAuthority && provider.evidence
    && typeof provider.evidence === 'object' && !Array.isArray(provider.evidence)
    ? jsonSafe(provider.evidence) : {};
  const base = {
    kind: 'canonical-memory-access-qualifiers',
    version: MEMORY_SSA_PROOF_VERSION,
    sourceEntityId,
    issuer: {
      type: 'canonical-memory-access-provider',
      id: CANONICAL_ACCESS_ISSUER,
      version: MEMORY_SSA_PROOF_VERSION,
    },
    identity: {
      functionId: String(functionId ?? ''),
      digest: identityDigestForProof(identity, identityDigestMemo),
    },
    provenance: {
      functionId: String(functionId ?? ''),
      sourceEntityId,
      sourceOriginDigest: stableDigest(descriptor.node?.origin ?? null),
    },
    architectureId: providerAuthority && typeof provider.architectureId === 'string' ? provider.architectureId : 'canonical-semantic',
    family: providerAuthority && typeof provider.family === 'string' ? provider.family : 'semantic-memory-access',
    widthBits: Number(memory.widthBits),
    endian: String(memory.endian ?? ''),
    volatility: false,
    atomic: false,
    ordering: providerQualifiersKnown ? 'unknown' : (memory.ordering ?? 'unknown'),
    // The provider may add explanatory fields, but the canonical memory
    // descriptor digest is always emitted by this producer.  Consumers must
    // validate this structural witness; the proof digest alone is not an
    // authority for an arbitrary evidence payload.
    evidence: {
      ...rawEvidence,
      source: rawEvidence.source == null ? 'canonical-semantic-memory-access' : String(rawEvidence.source),
      memoryAccessDigest: stableDigest(memory),
    },
  };
  const proof = {
    ...base,
    proofDigest: canonicalAccessProofDigest(base),
  };
  CANONICAL_ACCESS_PROOF_CONSTRUCTED_DIGESTS.set(proof, proof.proofDigest);
  return proof;
}

export function canonicalStoreValueProof({
  semanticValue,
  memorySsaEntityId,
  valueId,
  sourceEntityId,
  value,
  widthBits,
  identity,
  identityDigestMemo = null,
  functionId,
  resolvedSemanticValue = null,
  resolvedValueId = null,
  scalarSsaDefinitionId = null,
  scalarSsaUseId = null,
  scalarSsaDigest = null,
}) {
  if (!semanticValue || valueId == null || sourceEntityId == null
      || !String(memorySsaEntityId ?? '').trim()
      || !String(valueId).trim() || !String(sourceEntityId).trim()) return null;
  if (String(semanticValue.id ?? '') !== String(valueId)) return null;
  const valueKind = semanticValue.machineType?.kind == null
    ? null
    : String(semanticValue.machineType.kind);
  if (!['address', 'bitvector'].includes(valueKind)) return null;
  // Address operands are identity-only. A numeric payload would let a caller
  // reinterpret a pointer identity as a byte literal at the forwarding
  // boundary, so the canonical proof producer must reject it outright.
  if (valueKind === 'address' && value != null) return null;
  const width = Number(widthBits);
  if (!Number.isSafeInteger(width) || width <= 0 || width % 8 !== 0) return null;
  if (Number(semanticValue.machineType?.widthBits) !== width) return null;
  let canonicalValue = null;
  if (valueKind === 'bitvector') {
    // Bitvector proofs always carry an own, primitive decimal representation.
    // In particular, do not let an object/string wrapper or inherited member
    // become a value merely because a consumer later calls BigInt().
    try {
      if (typeof value === 'bigint') canonicalValue = value;
      else if (typeof value === 'number' && Number.isSafeInteger(value)) canonicalValue = BigInt(value);
      else if (typeof value === 'string' && /^[+-]?(?:0|[1-9][0-9]*)$/.test(value)) canonicalValue = BigInt(value);
      else return null;
    } catch {
      return null;
    }
    const unsigned = BigInt.asUintN(width, canonicalValue);
    const signed = BigInt.asIntN(width, canonicalValue);
    if (canonicalValue !== unsigned && canonicalValue !== signed) return null;
    canonicalValue = unsigned;
    const constantSource = resolvedSemanticValue ?? semanticValue;
    const constant = weakObject(constantSource.metadata?.constant);
    if (!constant || constant.kind !== 'bitvector'
        || Number(constant.widthBits) !== Number(constantSource.machineType?.widthBits)
        || constant.value == null) return null;
    let canonicalConstant;
    try {
      if (typeof constant.value === 'bigint') canonicalConstant = constant.value;
      else if (typeof constant.value === 'number' && Number.isSafeInteger(constant.value)) canonicalConstant = BigInt(constant.value);
      else if (typeof constant.value === 'string' && /^[+-]?(?:0|[1-9][0-9]*)$/.test(constant.value)) canonicalConstant = BigInt(constant.value);
      else return null;
    } catch {
      return null;
    }
    const sourceWidth = Number(constantSource.machineType?.widthBits);
    if (!Number.isSafeInteger(sourceWidth) || sourceWidth <= 0 || sourceWidth % 8 !== 0) return null;
    const constantUnsigned = BigInt.asUintN(sourceWidth, canonicalConstant);
    const constantSigned = BigInt.asIntN(sourceWidth, canonicalConstant);
    if ((canonicalConstant !== constantUnsigned && canonicalConstant !== constantSigned)
        || BigInt.asUintN(width, constantUnsigned) !== canonicalValue) return null;
    if (resolvedSemanticValue != null) {
      if (resolvedValueId == null || String(resolvedSemanticValue.id ?? '') !== String(resolvedValueId)
          || String(resolvedValueId).trim() === '') return null;
    }
  }
  const base = {
    kind: 'canonical-semantic-store-operand',
    version: MEMORY_SSA_PROOF_VERSION,
    issuer: {
      type: 'canonical-semantic-value-provider',
      id: CANONICAL_STORE_VALUE_ISSUER,
      version: MEMORY_SSA_PROOF_VERSION,
    },
    memorySsaEntityId: String(memorySsaEntityId ?? ''),
    sourceEntityId: String(sourceEntityId),
    valueId: String(valueId),
    semanticValueDigest: stableDigest(semanticValue),
    identity: {
      functionId: String(functionId ?? ''),
      digest: identityDigestForProof(identity, identityDigestMemo),
    },
    widthBits: width,
    valueKind,
    ...(valueKind === 'bitvector' ? { value: canonicalValue.toString() } : {}),
    ...(resolvedSemanticValue == null ? {} : {
      resolvedValueId: String(resolvedValueId ?? resolvedSemanticValue.id ?? ''),
      resolvedSemanticValueDigest: stableDigest(resolvedSemanticValue),
      resolvedWidthBits: Number(resolvedSemanticValue.machineType?.widthBits),
      ...(scalarSsaDefinitionId == null ? {} : { scalarSsaDefinitionId: String(scalarSsaDefinitionId) }),
      ...(scalarSsaUseId == null ? {} : { scalarSsaUseId: String(scalarSsaUseId) }),
      ...(scalarSsaDigest == null ? {} : { scalarSsaDigest: String(scalarSsaDigest) }),
    }),
  };
  const proof = {
    ...base,
    proofDigest: canonicalStoreValueProofDigest(base),
  };
  CANONICAL_STORE_VALUE_PROOF_CONSTRUCTED_DIGESTS.set(proof, proof.proofDigest);
  return proof;
}
