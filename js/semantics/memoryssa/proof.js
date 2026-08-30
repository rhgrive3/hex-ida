import { jsonSafe, stableDigest } from '../../core/identity/index.js';

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
  'phase7.alias.solver': '1.1.0',
});
export const CANONICAL_ACCESS_ISSUER = 'semantic-memoryssa.access';
export const CANONICAL_STORE_VALUE_ISSUER = 'semantic-memoryssa.store-operand';

function weakObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function withoutDigest(value, key = 'proofDigest') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { [key]: ignored, ...rest } = value;
  return rest;
}

export function canonicalIdentityDigest(identity) {
  return stableDigest(identity ?? null);
}

export function canonicalAliasProofDigest(proof) {
  return stableDigest(withoutDigest(proof));
}

export function canonicalAccessProofDigest(proof) {
  return stableDigest(withoutDigest(proof));
}

export function canonicalStoreValueProofDigest(proof) {
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
    accessMetadata: artifact?.accessMetadata ?? null,
    canonicalAccessBindings: artifact?.canonicalAccessBindings ?? null,
    byteCoverage: artifact?.byteCoverage ?? null,
    blockStates: artifact?.blockStates ?? null,
  };
}

export function canonicalMemorySsaDigest(artifact) {
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
export function canonicalAccessBinding({
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
}) {
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
  return {
    ...base,
    bindingDigest: stableDigest(base),
  };
}

export function canonicalAccessBindingDigest(binding) {
  return stableDigest(withoutDigest(binding, 'bindingDigest'));
}

export function canonicalAliasProof({
  result,
  identity,
  functionId,
  leftRegionId,
  rightRegionId,
  sourceEntityIds = [],
  purpose,
}) {
  const provider = result?.proof;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return null;
  let issuerId = provider.analyzerId == null ? null : String(provider.analyzerId);
  let issuerVersion = provider.analyzerVersion == null ? null : String(provider.analyzerVersion);
  if (!issuerId || !CANONICAL_ALIAS_ISSUERS.has(issuerId) || !issuerVersion.trim()
      || CANONICAL_ALIAS_ISSUER_VERSIONS[issuerId] !== issuerVersion) return null;
  const relation = String(result.relation ?? '');
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
      digest: canonicalIdentityDigest(identity),
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
  return {
    ...base,
    proofDigest: canonicalAliasProofDigest(base),
  };
}

export function canonicalAccessProof({ raw, descriptor, identity, functionId }) {
  const memory = descriptor?.memory;
  if (!memory) return null;
  const sourceEntityId = String(descriptor?.node?.id ?? '');
  if (!sourceEntityId) return null;
  const provider = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sourceQualifiersKnown = memory.volatility === false
    && memory.atomic === false
    && (memory.ordering == null || memory.ordering === 'unknown');
  const providerQualifiersKnown = provider.kind === 'canonical-memory-access-qualifiers'
    && String(provider.sourceEntityId ?? '') === sourceEntityId
    && provider.volatility === false
    && provider.atomic === false
    && (provider.ordering == null || provider.ordering === 'unknown')
    && Number(provider.widthBits) === Number(memory.widthBits)
    && String(provider.endian ?? '') === String(memory.endian ?? '');
  // Some canonical machine-effect producers intentionally leave the
  // source-level qualifiers unknown.  Only their canonical access provider
  // may close that gap; an arbitrary callback cannot turn unknown metadata
  // into an ordinary access proof.
  if (!sourceQualifiersKnown && !providerQualifiersKnown) return null;
  const rawEvidence = provider.evidence && typeof provider.evidence === 'object' && !Array.isArray(provider.evidence)
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
      digest: canonicalIdentityDigest(identity),
    },
    provenance: {
      functionId: String(functionId ?? ''),
      sourceEntityId,
      sourceOriginDigest: stableDigest(descriptor.node?.origin ?? null),
    },
    architectureId: provider.architectureId == null ? 'canonical-semantic' : String(provider.architectureId),
    family: provider.family == null ? 'semantic-memory-access' : String(provider.family),
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
  return {
    ...base,
    proofDigest: canonicalAccessProofDigest(base),
  };
}

export function canonicalStoreValueProof({
  semanticValue,
  memorySsaEntityId,
  valueId,
  sourceEntityId,
  value,
  widthBits,
  identity,
  functionId,
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
    const constant = weakObject(semanticValue.metadata?.constant);
    if (!constant || constant.kind !== 'bitvector'
        || Number(constant.widthBits) !== width || constant.value == null) return null;
    let canonicalConstant;
    try {
      if (typeof constant.value === 'bigint') canonicalConstant = constant.value;
      else if (typeof constant.value === 'number' && Number.isSafeInteger(constant.value)) canonicalConstant = BigInt(constant.value);
      else if (typeof constant.value === 'string' && /^[+-]?(?:0|[1-9][0-9]*)$/.test(constant.value)) canonicalConstant = BigInt(constant.value);
      else return null;
    } catch {
      return null;
    }
    const constantUnsigned = BigInt.asUintN(width, canonicalConstant);
    const constantSigned = BigInt.asIntN(width, canonicalConstant);
    if ((canonicalConstant !== constantUnsigned && canonicalConstant !== constantSigned)
        || constantUnsigned !== canonicalValue) return null;
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
      digest: canonicalIdentityDigest(identity),
    },
    widthBits: width,
    valueKind,
    ...(valueKind === 'bitvector' ? { value: canonicalValue.toString() } : {}),
  };
  return {
    ...base,
    proofDigest: canonicalStoreValueProofDigest(base),
  };
}
