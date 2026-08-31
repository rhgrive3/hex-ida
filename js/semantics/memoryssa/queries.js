import {
  deepFreeze,
  stableDigest,
  stableStringify,
} from '../../core/identity/index.js';
import { createOriginSet } from '../../core/identity/origin.js';
import { validateMemorySsa } from './validate.js';
import { isCanonicalMemorySsaProducerArtifact } from './build.js';
import {
  CANONICAL_ACCESS_ISSUER,
  CANONICAL_ALIAS_ISSUERS,
  CANONICAL_ALIAS_ISSUER_VERSIONS,
  CANONICAL_STORE_VALUE_ISSUER,
  MEMORY_SSA_PROOF_VERSION,
  canonicalAccessBinding,
  canonicalAccessBindingDigest,
  canonicalAccessProofDigest,
  canonicalAliasProofDigest,
  canonicalMemorySsaDigest,
  canonicalStoreValueProofDigest,
} from './proof.js';

function fail(code) { throw new TypeError(code); }
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('memory-ssa-query-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function positiveInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}
function analysisObject(memorySsa) {
  if (!memorySsa || typeof memorySsa !== 'object') fail('memory-ssa-query-analysis-required');
  return memorySsa;
}
function definitionMap(memorySsa) {
  return new Map(analysisObject(memorySsa).definitions.map((definition) => [definition.id, definition]));
}
function useMap(memorySsa) {
  return new Map(analysisObject(memorySsa).uses.map((use) => [use.id, use]));
}
function useFrom(memorySsa, useOrId) {
  if (useOrId && typeof useOrId === 'object') return useOrId;
  const use = useMap(memorySsa).get(String(useOrId));
  if (!use) fail('memory-ssa-query-use-not-found');
  return use;
}

export function getMemoryDefinition(memorySsa, definitionId) {
  const definition = definitionMap(memorySsa).get(String(definitionId));
  return definition ?? null;
}

export function getMemoryUse(memorySsa, useId) {
  return useMap(memorySsa).get(String(useId)) ?? null;
}

export function reachingMemoryDefinition(memorySsa, useOrId) {
  const use = useFrom(memorySsa, useOrId);
  const definition = definitionMap(memorySsa).get(use.reachingDefinitionId);
  if (!definition) fail('memory-ssa-query-dangling-use-def');
  return definition;
}

export function reachingConcreteStore(memorySsa, useOrId) {
  const use = useFrom(memorySsa, useOrId);
  const definition = reachingMemoryDefinition(memorySsa, use);
  if (use.aliasRelation !== 'must' || definition.kind !== 'memory-def') return null;
  return definition;
}

/*
 * Byte-exact forwarding is deliberately a query over the already-built
 * MemorySSA artifact.  It does not discover reaching definitions, ask an
 * alias provider, or create another memory graph.  The builder may attach a
 * byteCoverage index containing the state at each load.  Artifacts without
 * that canonical index are non-exact; callers never get a private one-region
 * fallback.  A missing proof is a refusal, never a fabricated byte.
 */

const FORWARD_EXACT = 'exact';
const FORWARD_NON_EXACT = new Set([
  'unknown',
  'partial',
  'unsupported',
  'stale',
  'cancelled',
  'budget-limited',
  'truncated',
]);
const MEMORY_BARRIER_KINDS = new Set([
  'may-alias-clobber',
  'unknown-clobber',
  'call-clobber',
  'intrinsic-clobber',
  'memory-phi',
]);

// A fact is issued for this precise semantic purpose.  Downstream gates pass
// the same context together with the load identity; a fact copied to another
// load, snapshot, artifact, or consumer therefore cannot be replayed merely by
// matching its serialized shape.
export const CANONICAL_MEMORY_FORWARDING_CONSUMER = 'semantic-memoryssa-forwarding';
export const CANONICAL_MEMORY_FORWARDING_PURPOSE = 'canonical-load-value';

class ForwardingStop extends Error {
  constructor(status, reason, detail = null) {
    super(reason);
    this.name = 'ForwardingStop';
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

/*
 * Exact facts are capabilities published by this canonical query.  Keep the
 * binding in a language-private field instead of a mutable WeakMap.  Calling a
 * dynamically looked-up WeakMap.prototype.get/set at this boundary lets a
 * consumer or test patch the prototype and authorize a clone or re-signed
 * payload.  Private-field membership is not forgeable by copying properties,
 * structured cloning, proxies, or another realm/module, and the class is not
 * exported (there is no registrar or token).
 */
class CanonicalMemoryForwardingFact {
  #binding;

  constructor(payload, binding) {
    for (const key of Object.keys(payload)) this[key] = payload[key];
    this.#binding = Object.freeze(binding);
  }

  static bindingFor(value) {
    return value !== null && typeof value === 'object' && #binding in value
      ? value.#binding
      : null;
  }
}

const intrinsicObjectHasOwn = Object.hasOwn;

function forwardingObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function forwardingContextObject(value) {
  if (!forwardingObject(value)) return null;
  const nested = forwardingObject(value.load) ?? value;
  const range = nested.loadRange ?? nested.range ?? value.loadRange ?? value.range ?? null;
  return {
    artifact: value.artifact ?? null,
    artifactDigest: value.artifactDigest ?? value.artifact?.canonicalDigest ?? null,
    snapshotId: value.snapshotId ?? null,
    useId: nested.useId ?? value.useId ?? null,
    sourceEntityId: nested.sourceEntityId ?? value.sourceEntityId ?? null,
    nodeId: nested.nodeId ?? value.nodeId ?? null,
    entityId: nested.entityId ?? value.entityId ?? null,
    regionId: nested.regionId ?? value.regionId ?? null,
    range,
    consumerId: value.consumerId ?? null,
    purpose: value.purpose ?? null,
  };
}

/*
 * Build the explicit context expected by an exact downstream gate.  The load
 * identity fields are intentionally not inferred from the fact: a caller must
 * supply the identity of the load it is about to consume.  This is what makes
 * cross-load and cross-consumer replay fail closed.
 */
export function canonicalMemoryForwardingContext(fact, context = {}) {
  // `fact` is deliberately not a source of defaults.  A downstream gate must
  // receive the current artifact/snapshot/load context from its owning
  // consumer; copying these values out of the fact would make stale replay
  // indistinguishable from a current query.
  void fact;
  const expected = forwardingContextObject(context) ?? {};
  return Object.freeze({
    artifact: expected.artifact ?? null,
    artifactDigest: expected.artifactDigest ?? null,
    snapshotId: expected.snapshotId ?? null,
    useId: expected.useId ?? null,
    sourceEntityId: expected.sourceEntityId ?? null,
    nodeId: expected.nodeId ?? null,
    entityId: expected.entityId ?? null,
    regionId: expected.regionId ?? null,
    range: expected.range ?? null,
    consumerId: expected.consumerId ?? null,
    purpose: expected.purpose ?? null,
  });
}

/* Convenience for consumers that retain the projected load instruction.  The
 * instruction contributes the caller-owned node/source identity; artifact,
 * use, range, and capability purpose still come from the independently
 * produced fact and are checked by the gate. */
export function canonicalMemoryForwardingContextForLoad(fact, load, context = {}) {
  // Only the independently supplied context and the current projected load
  // may contribute expected identity.  In particular, do not infer use/entity/
  // region/range/artifact/snapshot from `fact` itself.
  void fact;
  const sourceEntityId = context.sourceEntityId
    ?? load?.semanticNodeId
    ?? load?.sourceEntityId
    ?? load?.extra?.semanticNodeId
    ?? load?.extra?.sourceEntityId
    ?? null;
  return canonicalMemoryForwardingContext(fact, {
    ...context,
    useId: context.useId,
    sourceEntityId,
    nodeId: context.nodeId ?? load?.semanticNodeId ?? load?.sourceEntityId
      ?? load?.extra?.semanticNodeId ?? load?.extra?.sourceEntityId ?? null,
    entityId: context.entityId,
    regionId: context.regionId,
    range: context.range,
    artifactDigest: context.artifactDigest,
    snapshotId: context.snapshotId,
    consumerId: context.consumerId,
    purpose: context.purpose,
  });
}

function forwardingBigInt(value) {
  if (value == null) return null;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
    const text = String(value).trim();
    if (!/^[+-]?(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) return null;
    return BigInt(text);
  } catch {
    return null;
  }
}

function forwardingPositiveInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ForwardingStop('unsupported', code);
  }
  return value;
}

function forwardingWidthBits(memory, fallback = null) {
  const width = Number(memory?.widthBits ?? fallback);
  return Number.isSafeInteger(width) && width > 0 && width % 8 === 0 ? width : null;
}

function forwardingBytes(widthBits) {
  const width = forwardingWidthBits({ widthBits });
  return width == null ? null : width / 8;
}

function forwardingMap(value) {
  if (value instanceof Map) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value));
}

function forwardingMetadataIndex(memorySsa, state = null) {
  const raw = memorySsa.accessMetadata;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ForwardingStop('unsupported', 'memoryssa-access-metadata-missing');
  }
  const rawBindings = memorySsa.canonicalAccessBindings;
  if (!Array.isArray(rawBindings) || rawBindings.length !== raw.length || rawBindings.length === 0) {
    throw new ForwardingStop('unknown', 'memoryssa-canonical-access-bindings-missing');
  }
  const bindings = new Map();
  for (const binding of rawBindings) {
    if (state) forwardingScanTick(state);
    if (!forwardingObject(binding)) {
      throw new ForwardingStop('unknown', 'memoryssa-canonical-access-binding-malformed');
    }
    const id = String(binding.memorySsaEntityId ?? '');
    const regionId = String(binding.regionId ?? '');
    if (!id || !regionId || bindings.has(id)) {
      throw new ForwardingStop('unknown', 'memoryssa-canonical-access-binding-duplicate');
    }
    if (binding.bindingDigest !== canonicalAccessBindingDigest(binding)) {
      throw new ForwardingStop('unknown', 'memoryssa-canonical-access-binding-digest-mismatch');
    }
    bindings.set(id, binding);
  }
  const index = new Map();
  for (const item of raw) {
    if (state) forwardingScanTick(state);
    if (!forwardingObject(item)) throw new ForwardingStop('unknown', 'memoryssa-access-metadata-malformed');
    const id = String(item.memorySsaEntityId ?? '');
    if (!id || index.has(id)) throw new ForwardingStop('unknown', 'memoryssa-access-metadata-duplicate');
    if (item.entityKind !== 'use' && item.entityKind !== 'definition') {
      throw new ForwardingStop('unknown', 'memoryssa-access-metadata-kind-invalid');
    }
    if (item.regionId == null) throw new ForwardingStop('unknown', 'memoryssa-access-metadata-region-missing');
    const binding = bindings.get(id);
    if (!binding || stableStringify(canonicalAccessBinding(item)) !== stableStringify(binding)) {
      throw new ForwardingStop('unknown', 'memoryssa-canonical-access-binding-mismatch');
    }
    index.set(id, item);
  }
  return index;
}

function forwardingDomain(region) {
  if (!forwardingObject(region)) return null;
  const identity = { kind: region.kind };
  let hasScope = false;
  for (const key of ['binaryId', 'functionId', 'rootEntityId', 'addressSpace', 'rootIdentity']) {
    if (region[key] == null) continue;
    identity[key] = key === 'rootIdentity' ? region[key] : String(region[key]);
    hasScope = true;
  }
  return hasScope ? stableStringify(identity) : null;
}

function forwardingRegionBase(region) {
  if (!forwardingObject(region)) return null;
  if (region.address != null) return forwardingBigInt(region.address);
  if (region.offset != null) return forwardingBigInt(region.offset);
  return null;
}

function forwardingCanonicalSourceNode(metadata, options) {
  const sourceId = metadata?.sourceEntityId ?? metadata?.nodeId ?? null;
  const nodes = options?.ir?.nodes;
  if (sourceId == null || !Array.isArray(nodes)) return null;
  const node = nodes.find((candidate) => String(candidate?.id ?? '') === String(sourceId));
  return node && (node.kind === 'load' || node.kind === 'store') ? node : null;
}

function forwardingQualifierNormalizationAllowed(sourceMemory, memory) {
  if (!forwardingObject(sourceMemory) || !forwardingObject(memory)
      || sourceMemory.volatility !== 'unknown' || sourceMemory.atomic !== 'unknown') return false;
  const normalized = {
    ...sourceMemory,
    volatility: false,
    atomic: false,
  };
  return stableStringify(normalized) === stableStringify(memory);
}

function forwardingProducerRange(region, memory, metadata, options) {
  const sourceNode = forwardingCanonicalSourceNode(metadata, options);
  const addressExpr = forwardingMemoryAddressExpr(memory);
  const domain = forwardingDomain(region);
  const base = forwardingRegionBase(region);
  const widthBytes = forwardingBytes(forwardingWidthBits(memory));
  if (!forwardingObject(addressExpr) || domain == null || base == null || widthBytes == null) return null;

  if (sourceNode) {
    // The range must come from the canonical producer that owns the access.
    // A caller may not relabel a store as a load (or provide a malformed
    // operand list) and then reuse the same address expression/range proof.
    if (metadata?.sourceKind !== sourceNode.kind
        || !Array.isArray(sourceNode.inputs)
        || sourceNode.inputs.length !== (sourceNode.kind === 'load' ? 1 : 2)) return null;
    const sourceMemory = forwardingObject(sourceNode.memory)
      && stableStringify(sourceNode.memory) === stableStringify(memory)
      ? sourceNode.memory
      : (forwardingQualifierNormalizationAllowed(sourceNode.memory, memory) ? memory : null);
    if (!sourceMemory) return null;
    forwardingCheckSourceNode(sourceNode, sourceMemory, metadata?.sourceKind ?? 'access', { requireComplete: true });
    if (metadata?.origin != null && sourceNode.origin != null) {
      forwardingCheckOrigins(metadata.origin, sourceNode.origin, 'memory-forwarding-source-provenance-conflict');
    }
    const sourceAddressExpr = forwardingMemoryAddressExpr(sourceNode.memory);
    if (!forwardingObject(sourceAddressExpr)
        || stableStringify(addressExpr) !== stableStringify(sourceAddressExpr)) return null;
    const sourceAddressId = addressExpr.valueId == null ? null : String(addressExpr.valueId);
    if (!sourceAddressId || !Array.isArray(sourceNode.inputs)
        || String(sourceNode.inputs[0] ?? '') !== sourceAddressId) return null;
  }

  const displacement = region?.metadata?.canonicalAddressIncludesOperationDisplacement === true
    ? 0n
    : forwardingBigInt(
      sourceNode?.attributes?.machineEffects?.operationMetadata?.addressing?.addressDisplacement
        ?? sourceNode?.attributes?.machineEffects?.bundleMetadata?.addressing?.addressDisplacement,
    );
  if (sourceNode) {
    const normalizedDisplacement = displacement
      ?? (sourceNode.attributes?.machineEffects?.operationMetadata?.addressing?.addressDisplacement == null
        && sourceNode.attributes?.machineEffects?.bundleMetadata?.addressing?.addressDisplacement == null ? 0n : null);
    if (normalizedDisplacement == null) return null;
    const start = base + normalizedDisplacement;
    return { domain, start, end: start + BigInt(widthBytes) };
  }

  // A caller may query an immutable canonical artifact without retaining the
  // full Semantic IR projection. In that case the producer's range proof is
  // the only acceptable range source; an arbitrary byteRange or projected
  // address is not enough. forwardingCheckRangeBinding below verifies that
  // this proof is bound to the same canonical address expression, region,
  // width, endian, and source entity before any bytes are consumed.
  const proven = forwardingRawRange(metadata?.rangeProof?.range, domain);
  const proofDisplacement = forwardingBigInt(metadata?.rangeProof?.addressDisplacement);
  if (!proven || proofDisplacement == null || base + proofDisplacement !== proven.start) return null;
  return proven;
}

function forwardingSourceAccess(source) {
  if (!forwardingObject(source)) return null;
  return source.memoryAccess ?? source.extra?.memoryAccess ?? source.memory ?? null;
}

function forwardingSourceAddress(source) {
  const address = source?.addr ?? source?.address ?? null;
  if (!forwardingObject(address) || address.precise !== true || address.index != null) return null;
  const base = forwardingBigInt(address.base?.const ?? address.base?.value ?? null);
  const displacement = forwardingBigInt(address.disp ?? 0);
  if (base == null || displacement == null) return null;
  return base + displacement;
}

function forwardingMemoryAddressExpr(memory) {
  if (forwardingObject(memory?.addressExpr)) return memory.addressExpr;
  if (memory?.addressValueId != null && String(memory.addressValueId).trim()) {
    return { valueId: String(memory.addressValueId) };
  }
  return null;
}

function forwardingSourceIdentity(source) {
  if (!forwardingObject(source)) return null;
  return source.semanticNodeId ?? source.sourceEntityId ?? source.id ?? null;
}

/*
 * `sourceByEntityId` is an optional projection witness. The canonical artifact
 * still owns the producer identity, so a missing IR/source projection must not
 * turn a caller-supplied (and possibly re-signed) sourceEntityId/nodeId into a
 * new producer. Every selected access metadata row must carry both identity
 * fields and bind them to the MemorySSA entity's canonical sourceEntityId.
 */
function forwardingCheckSourceBinding(metadata, expectedSourceId, role) {
  const expected = String(expectedSourceId ?? '').trim();
  const sourceEntityId = String(metadata?.sourceEntityId ?? '').trim();
  const nodeId = String(metadata?.nodeId ?? '').trim();
  if (!expected || !sourceEntityId || !nodeId) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-source-binding-missing`);
  }
  if (sourceEntityId !== expected || nodeId !== expected) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-source-binding-mismatch`);
  }
  return expected;
}

const FORWARDING_ORIGIN_DOMAINS = Object.freeze([
  'instructionIds',
  'operationIds',
  'parentEntityIds',
  'byteRanges',
  'virtualRanges',
  'sourceLocations',
]);

function forwardingCanonicalOrigin(origin) {
  if (!forwardingObject(origin)) return null;
  try {
    return createOriginSet(origin);
  } catch {
    return null;
  }
}

function forwardingOriginDomainKey(domain, value) {
  // A provenance domain is a key *and* a value.  Reducing byte/virtual ranges
  // to their container identity would make two different offsets appear to
  // agree after a caller re-signed the outer artifact digest.
  return stableStringify(value);
}

function forwardingOriginDomains(origin) {
  const normalized = forwardingCanonicalOrigin(origin);
  if (!normalized) return null;
  const domains = new Map();
  for (const domain of FORWARDING_ORIGIN_DOMAINS) {
    const values = Array.isArray(normalized[domain]) ? normalized[domain] : [];
    if (values.length) domains.set(domain, new Set(values.map((value) => forwardingOriginDomainKey(domain, value))));
  }
  return domains;
}

/*
 * Origin sets are structured by independent provenance domains.  Comparing
 * only instructionIds (and skipping absent keys) lets a malformed producer
 * replace one domain with another while still appearing to agree.  Normalize
 * through the canonical origin contract, then require the complete populated
 * domain map to agree.  A producer may not drop a provenance key-domain or
 * replace it with a different value while retaining one matching instruction
 * id.  This is intentionally conservative: disagreement is unknown, never a
 * reason to publish exact bytes.
 */
function forwardingOriginsAgree(left, right) {
  const leftDomains = forwardingOriginDomains(left);
  const rightDomains = forwardingOriginDomains(right);
  if (!leftDomains || !rightDomains || !leftDomains.size || !rightDomains.size) return false;
  if (leftDomains.size !== rightDomains.size) return false;
  for (const domain of leftDomains.keys()) {
    if (!rightDomains.has(domain)) return false;
    const rightValues = rightDomains.get(domain);
    const leftValues = leftDomains.get(domain);
    if (leftValues.size !== rightValues.size
        || [...leftValues].some((value) => !rightValues.has(value))) return false;
  }
  return true;
}

function forwardingCanonicalStringList(values, { allowEmpty = false } = {}) {
  return Array.isArray(values)
    && (allowEmpty || values.length > 0)
    && values.every((value) => typeof value === 'string' && value.trim() === value && value.length > 0)
    && new Set(values).size === values.length
    // `canonicalAliasProof` uses JavaScript's default (UTF-16 code-unit)
    // sort. Keep validation on that same ordering; locale collation would
    // accept/reject provider evidence differently across runtimes.
    && values.every((value, index) => index === 0 || values[index - 1] < value);
}

/* Alias metadata is canonical evidence, not a boolean supplied by a caller.
 * The builder wraps every provider answer with issuer, identity, provenance,
 * and its own content digest.  In particular, arbitrary `source`/`method`
 * strings are never accepted as a must-alias proof. */
function forwardingCanonicalAliasProofIsValid(proof, relation, context = {}) {
  if (!forwardingObject(proof)
      || proof.kind !== 'canonical-memory-alias-proof'
      || String(proof.version ?? '') !== MEMORY_SSA_PROOF_VERSION
      || String(proof.relation ?? '') !== relation) return false;
  const issuer = proof.issuer;
  if (!forwardingObject(issuer)
      || issuer.type !== 'canonical-alias-analyzer'
      || !CANONICAL_ALIAS_ISSUERS.has(String(issuer.id ?? ''))
      || typeof issuer.version !== 'string' || !issuer.version.trim()
      || CANONICAL_ALIAS_ISSUER_VERSIONS[String(issuer.id)] !== issuer.version) return false;
  const identity = context.memorySsa?.identity;
  if (!forwardingObject(proof.identity)
      || String(proof.identity.functionId ?? '') !== String(context.memorySsa?.functionId ?? '')
      || String(proof.identity.digest ?? '') !== stableDigest(identity ?? null)) return false;
  const provenance = proof.provenance;
  if (!forwardingObject(provenance)
      || String(provenance.functionId ?? '') !== String(context.memorySsa?.functionId ?? '')
      || typeof provenance.purpose !== 'string'
      || !provenance.purpose.trim()
      || !Array.isArray(provenance.sourceEntityIds)
      || provenance.sourceEntityIds.length === 0
      || provenance.leftRegionId == null || provenance.rightRegionId == null) return false;
  const expectedRegions = context.expectedRegionIds ?? [];
  if (expectedRegions.length > 0) {
    const actual = new Set([String(provenance.leftRegionId), String(provenance.rightRegionId)]);
    for (const regionId of expectedRegions) if (!actual.has(String(regionId))) return false;
  }
  const expectedSources = context.expectedSourceEntityIds ?? [];
  const actualSources = new Set(provenance.sourceEntityIds.map(String));
  if (expectedSources.some((sourceId) => sourceId == null || !actualSources.has(String(sourceId)))
      || provenance.sourceEntityIds.some((sourceId) => !String(sourceId).trim())
      || actualSources.size !== provenance.sourceEntityIds.length
      || !forwardingCanonicalStringList(provenance.sourceEntityIds)) return false;
  if (!forwardingObject(proof.evidence)
      || !forwardingCanonicalStringList(proof.evidence.reasonCodes, { allowEmpty: true })
      || !forwardingCanonicalStringList(proof.evidence.evidenceIds, { allowEmpty: true })
      || !forwardingObject(proof.evidence.provider)
      || String(proof.proofDigest ?? '') !== canonicalAliasProofDigest(proof)) return false;
  const provider = proof.evidence.provider;
  const issuerId = String(issuer.id);
  const providerId = provider.analyzerId == null ? null : String(provider.analyzerId);
  const providerVersion = provider.analyzerVersion == null ? null : String(provider.analyzerVersion);
  if (providerId !== issuerId
      || providerVersion !== issuer.version
      || provider.completeness !== 'complete'
      || provider.stopReason != null) {
    return false;
  }
  if (provider.reasonCodes != null && !forwardingCanonicalStringList(provider.reasonCodes, { allowEmpty: true })) return false;
  if (provider.evidenceIds != null && !forwardingCanonicalStringList(provider.evidenceIds, { allowEmpty: true })) return false;
  // Redundant provider witnesses are checked against the outer canonical
  // envelope.  The envelope digest protects transport integrity, but it is
  // not an authority by itself: a caller that rewrites and re-digests the
  // provider must still agree with the relation, evidence, identity, and
  // region/source keys that the consumer is using.
  if (provider.relation != null && String(provider.relation) !== relation) return false;
  if (provider.functionId != null
      && String(provider.functionId) !== String(provenance.functionId)) return false;
  if (provider.reasonCodes != null
      && stableStringify(provider.reasonCodes) !== stableStringify(proof.evidence.reasonCodes)) return false;
  if (provider.evidenceIds != null
      && stableStringify(provider.evidenceIds) !== stableStringify(proof.evidence.evidenceIds)) return false;
  const expectedRegionsSet = new Set([String(provenance.leftRegionId), String(provenance.rightRegionId)]);
  if (provider.regionIds != null) {
    if (!forwardingCanonicalStringList(provider.regionIds)) return false;
    const providerRegions = new Set(provider.regionIds.map(String));
    if (providerRegions.size !== expectedRegionsSet.size
        || [...providerRegions].some((regionId) => !expectedRegionsSet.has(regionId))) return false;
  }
  if (provider.leftRegionId != null && String(provider.leftRegionId) !== String(provenance.leftRegionId)) return false;
  if (provider.rightRegionId != null && String(provider.rightRegionId) !== String(provenance.rightRegionId)) return false;
  if (provider.regionId != null && !expectedRegionsSet.has(String(provider.regionId))) return false;
  if (provider.sourceEntityId != null
      && !actualSources.has(String(provider.sourceEntityId))) return false;
  if (provider.sourceEntityIds != null) {
    if (!forwardingCanonicalStringList(provider.sourceEntityIds)) return false;
    const providerSources = new Set(provider.sourceEntityIds.map(String));
    if (providerSources.size !== actualSources.size
        || [...providerSources].some((sourceId) => !actualSources.has(sourceId))) return false;
  }
  return true;
}

function forwardingAliasProofIsMust(proof, context = {}, depth = 0) {
  if (!forwardingObject(proof) || depth > 8) return false;
  if (Array.isArray(proof.alternatives)) {
    return proof.alternatives.length > 0
      && proof.alternatives.every((alternative) => forwardingObject(alternative)
        && String(alternative.relation ?? '') === 'must'
        && forwardingAliasProofIsMust(alternative.proof, context, depth + 1));
  }
  return forwardingCanonicalAliasProofIsValid(proof, 'must', context);
}

function forwardingAliasProofIsNo(proof, context = {}, depth = 0) {
  if (!forwardingObject(proof) || depth > 8) return false;
  if (proof.kind === 'canonical-memory-stack-no-escape') {
    const expectedUseId = context.expectedUseId ?? context.useId ?? null;
    const expectedNodeId = context.expectedSourceEntityIds?.[0] ?? context.nodeId ?? null;
    const expectedRegions = context.expectedRegionIds ?? [];
    const expectedRegionId = expectedRegions[expectedRegions.length - 1] ?? null;
    return String(proof.version ?? '') === MEMORY_SSA_PROOF_VERSION
      && expectedUseId != null
      && String(proof.useId ?? '') === String(expectedUseId)
      && expectedNodeId != null
      && String(proof.nodeId ?? '') === String(expectedNodeId)
      && expectedRegionId != null
      && String(proof.regionId ?? '') === String(expectedRegionId)
      && String(proof.functionId ?? '') === String(context.memorySsa?.functionId ?? '')
      && String(proof.identityDigest ?? '') === stableDigest(context.memorySsa?.identity ?? null)
      && forwardingObject(proof.evidence)
      && proof.evidence.source === 'canonical-semantic-stack-root'
      && proof.evidence.root === 'canonical-stack-root'
      && proof.evidence.scope === 'function-local-stack'
      && String(proof.proofDigest ?? '') === stableDigest({
        kind: proof.kind,
        version: proof.version,
        functionId: proof.functionId,
        useId: proof.useId,
        nodeId: proof.nodeId,
        regionId: proof.regionId,
        identityDigest: proof.identityDigest,
        evidence: proof.evidence,
      });
  }
  if (Array.isArray(proof.alternatives)) {
    return proof.alternatives.length > 0
      && proof.alternatives.every((alternative) => forwardingObject(alternative)
        && String(alternative.relation ?? '') === 'no'
        && forwardingAliasProofIsNo(alternative.proof, context, depth + 1));
  }
  return forwardingCanonicalAliasProofIsValid(proof, 'no', context);
}

function forwardingRawRange(raw, domainFallback = null) {
  if (!forwardingObject(raw)) return null;
  const start = forwardingBigInt(raw.start ?? raw.offset ?? raw.begin);
  const end = forwardingBigInt(raw.end ?? raw.limit);
  if (start == null || end == null || end <= start) return null;
  const domain = raw.domain ?? raw.addressDomain ?? domainFallback;
  if (domain == null) return null;
  const normalizedDomain = typeof domain === 'string' ? domain : stableStringify(domain);
  if (domainFallback != null && normalizedDomain !== domainFallback) return null;
  return { domain: normalizedDomain, start, end };
}

function forwardingRange(region, memory, metadata, source = null, options = {}) {
  const domain = forwardingDomain(region);
  const canonical = forwardingProducerRange(region, memory, metadata, options);
  if (!canonical) {
    throw new ForwardingStop('unknown', 'memory-forwarding-range-producer-binding-missing');
  }
  const explicitRaw = metadata?.byteRange ?? memory?.byteRange ?? null;
  if (explicitRaw != null) {
    if (domain == null) throw new ForwardingStop('unknown', 'memory-forwarding-range-domain-unproven');
    const explicit = forwardingRawRange(explicitRaw, domain);
    if (!explicit) throw new ForwardingStop('unknown', 'memory-forwarding-range-malformed');
    if (explicit.start !== canonical.start || explicit.end !== canonical.end) {
      throw new ForwardingStop('unknown', 'memory-forwarding-range-producer-mismatch');
    }
  }
  const sourceAddress = forwardingSourceAddress(source);
  if (sourceAddress != null) {
    const widthBytes = forwardingBytes(forwardingWidthBits(memory));
    if (widthBytes == null || canonical.start !== sourceAddress
        || canonical.end !== sourceAddress + BigInt(widthBytes)) {
      throw new ForwardingStop('unknown', 'memory-forwarding-range-source-mismatch');
    }
  }
  return canonical;
}

function forwardingCheckRangeBinding(range, region, memory, metadata, source, expectedSourceId, role) {
  if (!metadata || metadata.regionId !== String(region.id)) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-region-binding-invalid`);
  }
  const canonicalSourceId = forwardingCheckSourceBinding(metadata, expectedSourceId, role);
  const proof = metadata.rangeProof;
  if (!forwardingObject(proof)
      || proof.kind !== 'canonical-memory-byte-range'
      || String(proof.version ?? '') !== MEMORY_SSA_PROOF_VERSION
      || String(proof.regionId ?? '') !== String(region.id)
      || String(proof.sourceEntityId ?? '') !== canonicalSourceId
      || String(proof.memorySsaEntityId ?? '') !== String(metadata.memorySsaEntityId ?? '')) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-range-proof-missing`);
  }
  const proofRange = forwardingRawRange(proof.range, range.domain);
  if (!proofRange || proofRange.start !== range.start || proofRange.end !== range.end) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-range-proof-mismatch`);
  }
  const regionBase = forwardingRegionBase(region);
  const displacement = forwardingBigInt(proof.addressDisplacement);
  if (regionBase == null || displacement == null || regionBase + displacement !== range.start) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-range-proof-region-mismatch`);
  }
  const addressExpr = forwardingMemoryAddressExpr(memory);
  if (!forwardingObject(addressExpr)) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-canonical-address-missing`);
  }
  const addressValueId = addressExpr.valueId == null ? null : String(addressExpr.valueId);
  const proofValueId = proof.addressValueId == null ? null : String(proof.addressValueId);
  if (!addressValueId
      || proofValueId !== addressValueId
      || proof.addressDigest == null
      || String(proof.addressDigest) !== stableDigest(addressExpr)
      || proof.addressExpr == null
      || stableStringify(proof.addressExpr) !== stableStringify(addressExpr)
      || Number(proof.widthBits) !== forwardingWidthBits(memory)
      || String(proof.addressSpace ?? '') !== String(memory?.addressSpace ?? '')
      || String(proof.endian ?? '') !== String(memory?.endian ?? '')) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-canonical-address-mismatch`);
  }
  const expectedRangeDigest = stableDigest({
    range: proofRange,
    addressValueId,
    addressDigest: stableDigest(addressExpr),
    addressDisplacement: displacement.toString(),
    widthBits: forwardingWidthBits(memory),
    endian: memory?.endian ?? null,
  });
  if (proof.rangeDigest == null || String(proof.rangeDigest) !== expectedRangeDigest) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-range-proof-unbound`);
  }
  if (source) {
    const sourceAddress = forwardingSourceAddress(source);
    if (sourceAddress != null) {
      const widthBytes = forwardingBytes(forwardingWidthBits(memory));
      if (widthBytes == null || range.start !== sourceAddress
          || range.end !== sourceAddress + BigInt(widthBytes)) {
        throw new ForwardingStop('unknown', `memory-forwarding-${role}-source-range-mismatch`);
      }
    }
  }
  for (const raw of [metadata.byteRange, memory?.byteRange]) {
    if (raw == null) continue;
    const explicit = forwardingRawRange(raw, range.domain);
    if (!explicit || explicit.start !== range.start || explicit.end !== range.end) {
      throw new ForwardingStop('unknown', `memory-forwarding-${role}-range-explicit-mismatch`);
    }
  }
}

function forwardingLookup(sourceMap, id) {
  if (id == null) return null;
  return sourceMap.get(String(id)) ?? null;
}

function forwardingValueFromRaw(raw) {
  if (raw == null) return null;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? BigInt(raw) : null;
  if (typeof raw === 'string') return forwardingBigInt(raw);
  if (forwardingObject(raw)) {
    for (const candidate of [raw.value, raw.const, raw.constant, raw.byteValue]) {
      const parsed = forwardingValueFromRaw(candidate);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

function forwardingValueForDefinition(definition, metadata, memorySsa, options) {
  const proof = metadata?.canonicalValue;
  const valueKind = String(proof?.valueKind ?? '');
  const hasOwnValue = forwardingObject(proof) && Object.hasOwn(proof, 'value');
  // Never read a value through the prototype chain.  Bitvector proofs are
  // canonical primitive decimal strings; address proofs are identity-only.
  let parsedValue = null;
  if (valueKind === 'bitvector' && hasOwnValue
      && typeof proof.value === 'string'
      && /^(?:0|[1-9][0-9]*)$/.test(proof.value)) {
    try { parsedValue = BigInt(proof.value); } catch { parsedValue = null; }
  }
  if (!forwardingObject(proof)
      || proof.kind !== 'canonical-semantic-store-operand'
      || String(proof.version ?? '') !== MEMORY_SSA_PROOF_VERSION
      || String(proof.memorySsaEntityId ?? '') !== String(definition.id)
      || String(proof.sourceEntityId ?? '') !== String(definition.sourceEntityId ?? '')
      || !String(proof.valueId ?? '').trim()
      || String(proof.identity?.functionId ?? '') !== String(memorySsa.functionId ?? '')
      || String(proof.identity?.digest ?? '') !== stableDigest(memorySsa.identity ?? null)
      || !forwardingObject(proof.issuer)
      || proof.issuer.type !== 'canonical-semantic-value-provider'
      || String(proof.issuer.id ?? '') !== CANONICAL_STORE_VALUE_ISSUER
      || proof.issuer.version !== MEMORY_SSA_PROOF_VERSION
      || !proof.semanticValueDigest
      || !['address', 'bitvector'].includes(valueKind)
      // Address operands are identity-only.  An inherited value is rejected
      // by the own-property proof below just as an own numeric value is.
      || (valueKind === 'address' && hasOwnValue)
      || (valueKind === 'bitvector' && (!hasOwnValue || parsedValue == null
        || parsedValue.toString() !== proof.value))
      || String(proof.proofDigest ?? '') !== canonicalStoreValueProofDigest(proof)
      || Number(proof.widthBits) !== forwardingWidthBits(metadata.memory)) {
    throw new ForwardingStop('unknown', 'memory-forwarding-store-canonical-value-unproven');
  }
  if (options.ir != null) {
    const storeNode = (options.ir.nodes ?? []).find((node) => String(node.id) === String(definition.sourceEntityId));
    const semanticValue = (options.ir.values ?? []).find((value) => String(value.id) === String(proof.valueId));
    const hasResolvedValue = intrinsicObjectHasOwn(proof, 'resolvedValueId')
      || intrinsicObjectHasOwn(proof, 'resolvedSemanticValueDigest')
      || intrinsicObjectHasOwn(proof, 'resolvedWidthBits');
    let resolvedValueValid = true;
    if (hasResolvedValue) {
      const resolved = (options.ir.values ?? []).find((value) => String(value.id) === String(proof.resolvedValueId));
      const constant = resolved?.metadata?.constant;
      const sourceWidth = Number(proof.resolvedWidthBits);
      let sourceValue = null;
      try {
        if (typeof constant?.value === 'bigint') sourceValue = constant.value;
        else if (typeof constant?.value === 'number' && Number.isSafeInteger(constant.value)) sourceValue = BigInt(constant.value);
        else if (typeof constant?.value === 'string' && /^[+-]?(?:0|[1-9][0-9]*)$/.test(constant.value)) sourceValue = BigInt(constant.value);
      } catch { sourceValue = null; }
      resolvedValueValid = !!resolved
        && String(proof.resolvedValueId ?? '').trim() !== ''
        && String(proof.resolvedSemanticValueDigest ?? '') === stableDigest(resolved)
        && String(proof.scalarSsaDigest ?? '') === String(memorySsa.identity?.scalarSsaDigest ?? '')
        && resolved.machineType?.kind === 'bitvector'
        && Number(resolved.machineType?.widthBits) === sourceWidth
        && Number(constant?.widthBits) === sourceWidth
        && sourceValue != null
        && parsedValue != null
        && BigInt.asUintN(sourceWidth, sourceValue) === sourceValue
        && BigInt.asUintN(Number(proof.widthBits), sourceValue) === parsedValue;
    }
    if (!storeNode || storeNode.kind !== 'store' || !Array.isArray(storeNode.inputs)
        || storeNode.inputs.length !== 2
        || String(storeNode.inputs[1]) !== String(proof.valueId)
        || !semanticValue
        || stableDigest(semanticValue) !== String(proof.semanticValueDigest)
        || String(semanticValue.machineType?.kind ?? '') !== String(proof.valueKind)
        || Number(semanticValue.machineType?.widthBits) !== Number(proof.widthBits)
        || (parsedValue != null && !hasResolvedValue && (semanticValue.metadata?.constant?.value == null
          || String(semanticValue.metadata.constant.value) !== String(proof.value)))
        || !resolvedValueValid) {
      throw new ForwardingStop('unknown', 'memory-forwarding-store-canonical-value-mismatch');
    }
  }
  return {
    value: parsedValue,
    valueId: String(proof.valueId),
    valueKind: String(proof.valueKind),
    raw: proof,
    source: 'canonical-semantic-operand',
  };
}

function forwardingStoreValue(value, widthBits) {
  if (!value || typeof value !== 'object' || value.value == null) {
    throw new ForwardingStop('unknown', 'memory-forwarding-store-value-unproven');
  }
  let parsed;
  try { parsed = BigInt(value.value); } catch { throw new ForwardingStop('unknown', 'memory-forwarding-store-value-malformed'); }
  const unsigned = BigInt.asUintN(widthBits, parsed);
  const signed = BigInt.asIntN(widthBits, parsed);
  if (parsed !== unsigned && parsed !== signed) {
    throw new ForwardingStop('unknown', 'memory-forwarding-store-value-width-exceeded');
  }
  return { value: unsigned, raw: value.raw, source: value.source };
}

function forwardingCheckOrigins(left, right, code) {
  if (!forwardingOriginsAgree(left, right)) throw new ForwardingStop('unknown', code);
}

function forwardingOriginComplete(origin) {
  const domains = forwardingOriginDomains(origin);
  return !!domains?.size;
}

function forwardingDeadlineMs(options) {
  const raw = options.deadline ?? options.deadlineAt
    ?? options.budget?.deadline ?? options.budget?.deadlineAt ?? null;
  if (raw == null) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new ForwardingStop('unsupported', 'memory-forwarding-deadline-invalid');
  }
  return raw;
}

function forwardingSourceMap(options) {
  const raw = options.sourceByEntityId ?? options.sourcesByEntityId ?? options.instructionsBySemanticId;
  return forwardingMap(raw);
}

function forwardingStatusForReason(raw) {
  if (raw == null) return null;
  const reason = String(raw).trim().toLowerCase();
  if (!reason || reason === 'complete' || reason === 'ok' || reason === 'success') return null;
  if (['unknown', 'partial', 'unsupported', 'stale', 'cancelled', 'canceled', 'truncated', 'budget-limited'].includes(reason)) {
    if (reason === 'canceled') return 'cancelled';
    return reason;
  }
  if (/cancel|aborted/.test(reason)) return 'cancelled';
  if (/truncat/.test(reason)) return 'truncated';
  // Unknown and partial are semantic completeness states, not budget
  // exhaustion.  Keep them distinct so downstream publication can preserve
  // the producer's typed taxonomy instead of laundering an ambiguous result
  // into a resource-limit diagnostic.
  if (/^unknown(?:[-_:]|$)|unknown[-_:]/.test(reason)) return 'unknown';
  if (/^partial(?:[-_:]|$)|partial[-_:]|incomplete|missing|hole|unproven/.test(reason)) return 'partial';
  if (/deadline|timeout|budget|limit|exhaust/.test(reason)) return 'budget-limited';
  // A non-empty stop reason that is not part of the published status
  // vocabulary is still evidence that the producer did not prove completion.
  // Treating it as success would let a future/unknown termination mode publish
  // an exact value by accident.
  return 'unknown';
}

function forwardingStatusForCompleteness(raw) {
  if (raw == null) return null;
  const completeness = String(raw).trim().toLowerCase();
  if (!completeness || completeness === 'complete' || completeness === 'ok' || completeness === 'success') return null;
  if (completeness === 'cancelled' || completeness === 'canceled' || completeness === 'aborted') return 'cancelled';
  if (completeness === 'truncated') return 'truncated';
  if (completeness === 'partial') return 'partial';
  if (completeness === 'budget-limited' || completeness === 'budget_exhausted') return 'budget-limited';
  return 'unknown';
}

function forwardingStatusObjectStatus(statusObject) {
  if (typeof statusObject === 'string') return forwardingStatusForReason(statusObject);
  if (!forwardingObject(statusObject)) return null;
  const explicitStatus = statusObject.status ?? statusObject.state ?? null;
  const explicit = forwardingStatusForReason(explicitStatus);
  if (explicit != null) return explicit;
  const reason = statusObject.stopReason ?? statusObject.reason ?? statusObject.terminationReason;
  const stopped = forwardingStatusForReason(reason);
  if (stopped != null) return stopped;
  return forwardingStatusForCompleteness(statusObject.completeness);
}

function forwardingMemoryUnknown(value) {
  if (!forwardingObject(value)) return false;
  const categories = [
    ...(Array.isArray(value.categories) ? value.categories : []),
    ...(Array.isArray(value.unknownEffects?.categories) ? value.unknownEffects.categories : []),
    ...(Array.isArray(value.unknown?.categories) ? value.unknown.categories : []),
  ];
  return categories.some((category) => String(category).trim().toLowerCase().includes('memory'));
}

function forwardingUnknownEntryIsValid(value) {
  if (!forwardingObject(value)
      || typeof value.reason !== 'string'
      || !value.reason.trim()
      || !Array.isArray(value.categories)
      || value.categories.some((category) => typeof category !== 'string' || !category.trim())) return false;
  if (value.detail != null && (typeof value.detail !== 'object' || Array.isArray(value.detail))) return false;
  return true;
}

function forwardingCheckSourceNode(node, memory, role, { requireComplete = false } = {}) {
  if (!node) throw new ForwardingStop('unknown', `memory-forwarding-${role}-producer-missing`);
  if ((requireComplete && node.completeness !== 'complete')
      || (!requireComplete && node.completeness != null && node.completeness !== 'complete')) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-producer-incomplete`);
  }
  if (forwardingMemoryUnknown(node)) {
    throw new ForwardingStop('unknown', `memory-forwarding-${role}-memory-unknown`);
  }
  if (!forwardingObject(memory) || String(memory.addressSpace ?? '') !== 'memory') {
    throw new ForwardingStop('unsupported', `memory-forwarding-${role}-address-space-unsupported`);
  }
}

function forwardingStatusFromArtifact(memorySsa, options) {
  if (options.signal?.aborted) throw new ForwardingStop('cancelled', 'analysis-cancelled');
  const deadlineMs = forwardingDeadlineMs(options);
  if (deadlineMs != null && Date.now() >= deadlineMs) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-deadline-exhausted');
  }
  const artifact = forwardingObject(memorySsa);
  if (!artifact) throw new ForwardingStop('unknown', 'memoryssa-artifact-missing');
  if (options.consumerId !== CANONICAL_MEMORY_FORWARDING_CONSUMER
      || options.purpose !== CANONICAL_MEMORY_FORWARDING_PURPOSE) {
    throw new ForwardingStop('unsupported', 'memory-forwarding-consumer-context-invalid');
  }
  if (options.skipValidation === true) {
    throw new ForwardingStop('unsupported', 'memory-forwarding-validation-bypass-forbidden');
  }
  if (options.accessMetadata != null) {
    throw new ForwardingStop('unsupported', 'memory-forwarding-metadata-override-forbidden');
  }
  for (const [key, value] of [
    ['status', artifact.status],
    ['completeness-status', artifact.completenessStatus],
    ['analysis-status', artifact.analysisStatus],
  ]) {
    const status = forwardingStatusObjectStatus(value);
    if (status != null) throw new ForwardingStop(status, `memoryssa-${key}-${String(value?.stopReason ?? value?.reason ?? value)}`);
  }
  const topLevelStop = forwardingStatusForReason(artifact.stopReason);
  if (topLevelStop != null) throw new ForwardingStop(topLevelStop, `memoryssa-stop-reason-${artifact.stopReason}`);
  if (artifact.completeness == null || String(artifact.completeness).trim() === '') {
    throw new ForwardingStop('unknown', 'memoryssa-completeness-missing');
  }
  const completeness = String(artifact.completeness);
  // Artifact completeness is function-wide. A partial/unknown call summary
  // must not erase a load whose own canonical MemorySSA byte state is complete
  // (for example, a non-escaping caller-local stack slot). The per-use chain,
  // coverage proof, and access metadata below remain authoritative and will
  // still stop on any unknown state that reaches this load. Budget, cancelled,
  // truncated, or explicit stop-reason statuses were rejected above and never
  // receive this localized exception.
  if (completeness !== 'complete' && completeness !== 'partial') {
    const completenessStatus = forwardingStatusForCompleteness(completeness) ?? 'unknown';
    throw new ForwardingStop(completenessStatus, `memoryssa-${completeness}`);
  }
  if (!Array.isArray(artifact.unknowns)) {
    throw new ForwardingStop('unknown', 'memoryssa-unknowns-missing');
  }
  if (artifact.memoryUnknown === true || forwardingMemoryUnknown(artifact)) {
    throw new ForwardingStop('unknown', 'memoryssa-memory-unknown-present');
  }
  for (const unknown of artifact.unknowns) {
    if (!forwardingUnknownEntryIsValid(unknown)) throw new ForwardingStop('unknown', 'memoryssa-unknown-entry-malformed');
    if (completeness === 'complete' && forwardingMemoryUnknown(unknown)) {
      throw new ForwardingStop('unknown', 'memoryssa-memory-unknown-present');
    }
  }
  if (artifact.cancelled === true || artifact.status?.stopReason === 'cancelled') {
    throw new ForwardingStop('cancelled', 'analysis-cancelled');
  }
  if (artifact.truncated === true) {
    throw new ForwardingStop('truncated', 'memoryssa-truncated');
  }
  if (artifact.status?.stopReason === 'budget-exhausted') {
    throw new ForwardingStop('budget-limited', 'memoryssa-budget-exhausted');
  }
  if (artifact.contractVersion == null || String(artifact.contractVersion) !== '2.0.0') {
    throw new ForwardingStop('unsupported', 'memoryssa-contract-mismatch');
  }
  if (options.functionId != null && String(artifact.functionId) !== String(options.functionId)) {
    throw new ForwardingStop('stale', 'memoryssa-stale-function');
  }
  if (artifact.snapshotId != null && options.snapshotId != null
      && String(artifact.snapshotId) !== String(options.snapshotId)) {
    throw new ForwardingStop('stale', 'memoryssa-stale-snapshot');
  }
  if (options.memorySsaBuildVersion != null
      && String(artifact.buildVersion ?? '') !== String(options.memorySsaBuildVersion)) {
    throw new ForwardingStop('stale', 'memoryssa-build-mismatch');
  }
  if (artifact.identity == null) {
    throw new ForwardingStop('stale', 'memoryssa-identity-missing');
  }
  const identity = artifact.identity;
  if (identity != null) {
    if (!forwardingObject(identity)) throw new ForwardingStop('stale', 'memoryssa-identity-malformed');
    const requiredIdentityKeys = [
      'binaryId', 'sliceId', 'functionId', 'snapshotId', 'semanticIrId',
      'semanticIrContractVersion', 'semanticIrDigest', 'scalarSsaId',
      'scalarSsaBuildVersion', 'scalarSsaDigest', 'memorySsaId',
      'memorySsaBuildVersion', 'analyzerVersion',
    ];
    for (const key of requiredIdentityKeys) {
      const value = identity[key];
      if (value == null || (typeof value === 'string' && !value.trim())) {
        throw new ForwardingStop('stale', `memoryssa-identity-${key}-missing`);
      }
    }
    if (artifact.functionId == null || String(identity.functionId) !== String(artifact.functionId)) {
      throw new ForwardingStop('stale', 'memoryssa-identity-function-mismatch');
    }
    if (artifact.snapshotId == null || String(identity.snapshotId) !== String(artifact.snapshotId)) {
      throw new ForwardingStop('stale', 'memoryssa-identity-snapshot-mismatch');
    }
    if (artifact.buildVersion != null && String(identity.memorySsaBuildVersion) !== String(artifact.buildVersion)) {
      throw new ForwardingStop('stale', 'memoryssa-identity-memory-build-mismatch');
    }
    if (artifact.regions?.some((region) => region.binaryId != null
        && String(region.binaryId) !== String(identity.binaryId))) {
      throw new ForwardingStop('stale', 'memoryssa-identity-binary-mismatch');
    }
    if (artifact.regions?.some((region) => region.functionId != null
        && String(region.functionId) !== String(identity.functionId))) {
      throw new ForwardingStop('stale', 'memoryssa-identity-function-scope-mismatch');
    }
  }
  const canonicalIrIdentity = artifact.canonicalIrIdentity;
  if (!forwardingObject(canonicalIrIdentity)
      || canonicalIrIdentity.functionId == null
      || canonicalIrIdentity.semanticIrDigest == null
      || canonicalIrIdentity.semanticIrId == null
      || canonicalIrIdentity.semanticIrContractVersion == null
      || String(canonicalIrIdentity.functionId) !== String(artifact.functionId)
      || String(canonicalIrIdentity.semanticIrId) !== String(identity.semanticIrId)
      || String(canonicalIrIdentity.semanticIrContractVersion) !== String(identity.semanticIrContractVersion)
      || String(canonicalIrIdentity.semanticIrDigest) !== String(identity.semanticIrDigest)) {
    throw new ForwardingStop('stale', 'memoryssa-canonical-ir-identity-missing');
  }
  if (options.ir != null) {
    if (!forwardingObject(options.ir)
        || String(options.ir.functionId ?? '') !== String(artifact.functionId)
        || String(options.ir.contractVersion ?? '') !== String(identity.semanticIrContractVersion)
        || stableDigest(options.ir) !== String(identity.semanticIrDigest)) {
      throw new ForwardingStop('stale', 'memoryssa-canonical-ir-identity-mismatch');
    }
  }
  if (typeof artifact.canonicalDigest !== 'string' || !artifact.canonicalDigest.trim()
      || artifact.canonicalDigest !== canonicalMemorySsaDigest(artifact)) {
    throw new ForwardingStop('stale', 'memoryssa-canonical-digest-mismatch');
  }
  // The artifact's serialized identity is not an authority for itself. Exact
  // publication requires the private producer binding created by
  // buildMemorySsa. Only the exact object issued by that builder can carry the
  // binding; a clone or a re-signed object cannot register itself. A caller
  // may optionally provide a current identity for freshness checking, but that
  // value is context—not a capability—and is never used to mint authority.
  if (!isCanonicalMemorySsaProducerArtifact(artifact)) {
    throw new ForwardingStop('stale', 'memoryssa-independent-producer-identity-unavailable');
  }
  if (Object.hasOwn(options, 'currentIdentity')) {
    const currentIdentity = options.currentIdentity;
    if (!forwardingObject(currentIdentity)
        || currentIdentity === artifact.identity
        || stableDigest(currentIdentity) !== stableDigest(artifact.identity)) {
      throw new ForwardingStop('stale', 'memoryssa-independent-current-identity-mismatch');
    }
  }
}

function forwardingTick(state) {
  if (state.options.signal?.aborted) throw new ForwardingStop('cancelled', 'analysis-cancelled');
  if (state.deadlineMs != null && Date.now() >= state.deadlineMs) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-deadline-exhausted');
  }
  state.usedDefinitions += 1;
  state.iterations += 1;
  if (state.iterations > state.maxIterations) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-iteration-budget-exhausted');
  }
  if (state.usedDefinitions > state.maxDefinitions) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-definition-budget-exhausted');
  }
}

// Metadata, alias-state, and overlap scans are part of the proof boundary too.
// They must observe cancellation/deadlines and consume the same bounded work
// budget rather than leaving an uninterruptible O(n²) validation path.
function forwardingScanTick(state) {
  if (state.options.signal?.aborted) throw new ForwardingStop('cancelled', 'analysis-cancelled');
  if (state.deadlineMs != null && Date.now() >= state.deadlineMs) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-deadline-exhausted');
  }
  state.iterations += 1;
  if (state.iterations > state.maxIterations) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-iteration-budget-exhausted');
  }
}

function forwardingByteTick(state) {
  if (state.options.signal?.aborted) throw new ForwardingStop('cancelled', 'analysis-cancelled');
  if (state.deadlineMs != null && Date.now() >= state.deadlineMs) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-deadline-exhausted');
  }
  state.usedBytes += 1;
  state.iterations += 1;
  if (state.iterations > state.maxIterations) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-iteration-budget-exhausted');
  }
  if (state.usedBytes > state.maxBytes) {
    throw new ForwardingStop('budget-limited', 'memory-forwarding-byte-budget-exhausted');
  }
}

function forwardingOverlap(left, right) {
  return left.domain === right.domain && left.start < right.end && right.start < left.end;
}

function forwardingContains(outer, inner) {
  return outer.domain === inner.domain && outer.start <= inner.start && outer.end >= inner.end;
}

function forwardingDefinitionChain(memorySsa, startId, state) {
  const definitions = new Map((memorySsa.definitions ?? []).map((definition) => [String(definition.id), definition]));
  const chain = [];
  const visited = new Set();
  let currentId = String(startId ?? '');
  while (currentId) {
    forwardingTick(state);
    if (visited.has(currentId)) throw new ForwardingStop('unknown', 'memoryssa-definition-cycle');
    visited.add(currentId);
    const definition = definitions.get(currentId);
    if (!definition) throw new ForwardingStop('unknown', 'memoryssa-dangling-definition');
    chain.push(definition);
    if (definition.kind === 'memory-phi') {
      throw new ForwardingStop('unknown', 'memoryssa-memory-phi-ambiguous');
    }
    const previous = definition.previousDefinitionIds ?? [];
    if (!Array.isArray(previous)) throw new ForwardingStop('unknown', 'memoryssa-previous-definitions-malformed');
    if (previous.length > 1) throw new ForwardingStop('unknown', 'memoryssa-definition-order-ambiguous');
    currentId = previous.length === 1 ? String(previous[0]) : '';
  }
  return { chain, definitions };
}

function forwardingOrderFor(definition, index, coverageOrder, metadata) {
  const explicit = metadata?.order ?? metadata?.sequence ?? coverageOrder ?? null;
  if (explicit != null) {
    const value = Number(explicit);
    if (Number.isSafeInteger(value) && value >= 0) {
      if (coverageOrder != null && Number(coverageOrder) !== value) {
        throw new ForwardingStop('unknown', 'memory-forwarding-store-order-conflict');
      }
      return value;
    }
    throw new ForwardingStop('unknown', 'memory-forwarding-store-order-malformed');
  }
  // Chain traversal order is not a semantic store-order proof.  In particular,
  // an explicit order on one overlapping write must never be combined with a
  // synthetic index for another write.
  return null;
}

function forwardingBytesForStore(value, widthBits, endian, state) {
  const widthBytes = forwardingBytes(widthBits);
  if (widthBytes == null || !['little', 'big'].includes(endian)) {
    throw new ForwardingStop('unsupported', 'memory-forwarding-store-access-invalid');
  }
  const normalized = forwardingStoreValue(value, widthBits).value;
  const bytes = [];
  for (let index = 0; index < widthBytes; index++) {
    forwardingByteTick(state);
    const shift = endian === 'little' ? index : widthBytes - index - 1;
    bytes.push((normalized >> BigInt(shift * 8)) & 0xffn);
  }
  return bytes;
}

function forwardingLoadValue(byteMap, loadRange, loadWidthBits, endian, state) {
  const widthBytes = forwardingBytes(loadWidthBits);
  if (widthBytes == null || !['little', 'big'].includes(endian)) {
    throw new ForwardingStop('unsupported', 'memory-forwarding-load-access-invalid');
  }
  let value = 0n;
  for (let index = 0; index < widthBytes; index++) {
    forwardingByteTick(state);
    const absolute = loadRange.start + BigInt(index);
    const lane = byteMap.get(absolute.toString());
    if (!lane) throw new ForwardingStop('partial', 'memory-forwarding-byte-hole', { missing: [absolute.toString()] });
    const shift = endian === 'little' ? index : widthBytes - index - 1;
    value |= lane.byte << BigInt(shift * 8);
  }
  return BigInt.asUintN(loadWidthBits, value);
}

function forwardingMetaForDefinition(metadataById, definition) {
  return metadataById.get(String(definition.id)) ?? null;
}

function forwardingAccessFromMetadata(metadata, source) {
  // The source projection is an optional consistency witness only. It cannot
  // supply a missing memory descriptor or turn an incomplete artifact into a
  // canonical access proof.
  return metadata?.memory ?? null;
}

function forwardingAccessProofIsCanonical(proof, metadata, memory, memorySsa = null) {
  if (!forwardingObject(proof)
      || proof.kind !== 'canonical-memory-access-qualifiers'
      || String(proof.version ?? '') !== MEMORY_SSA_PROOF_VERSION) return false;
  const sourceId = metadata?.sourceEntityId ?? metadata?.nodeId ?? null;
  const provenance = proof.provenance;
  const issuer = proof.issuer;
  const valid = sourceId != null
    && String(proof.sourceEntityId ?? '') === String(sourceId)
    && forwardingObject(issuer)
    && issuer.type === 'canonical-memory-access-provider'
    && String(issuer.id ?? '') === CANONICAL_ACCESS_ISSUER
    && typeof issuer.version === 'string' && issuer.version === MEMORY_SSA_PROOF_VERSION
    && forwardingObject(proof.identity)
    && String(proof.identity.functionId ?? '') === String(memorySsa?.functionId ?? '')
    && String(proof.identity.digest ?? '') === stableDigest(memorySsa?.identity ?? null)
    && forwardingObject(provenance)
    && String(provenance.functionId ?? '') === String(memorySsa?.functionId ?? '')
    && String(provenance.sourceEntityId ?? '') === String(sourceId)
    && metadata?.origin != null
    && String(provenance.sourceOriginDigest ?? '') === stableDigest(metadata.origin)
    && typeof proof.architectureId === 'string' && proof.architectureId.trim().length > 0
    && typeof proof.family === 'string' && proof.family.trim().length > 0
    && Number(proof.widthBits) === forwardingWidthBits(memory)
    && String(proof.endian ?? '') === String(memory?.endian ?? '')
    // Unknown source qualifiers never compare equal to a proven false value.
    // The access proof must agree with the producer's explicit qualifier and
    // with the separately serialized sequencing witness.
    && memory?.volatility === false
    && memory?.atomic === false
    && proof.volatility === memory.volatility
    && proof.atomic === memory.atomic
    && proof.ordering === memory.ordering
    && forwardingObject(metadata?.sequencing)
    && metadata.sequencing.volatility === memory.volatility
    && metadata.sequencing.atomic === memory.atomic
    && metadata.sequencing.ordering === memory.ordering
    && (memory.ordering == null || memory.ordering === 'unknown')
    && forwardingObject(proof.evidence)
    && typeof proof.evidence.source === 'string' && proof.evidence.source.trim().length > 0
    && String(proof.evidence.memoryAccessDigest ?? '') === stableDigest(memory)
    && String(proof.proofDigest ?? '') === canonicalAccessProofDigest(proof);
  return valid;
}

function forwardingCheckAccess(memory, role, metadata = null, memorySsa = null) {
  if (!forwardingObject(memory) || String(memory.addressSpace ?? '') !== 'memory') {
    throw new ForwardingStop('unsupported', `memory-forwarding-${role}-address-space-unsupported`);
  }
  const widthBits = forwardingWidthBits(memory);
  if (widthBits == null) throw new ForwardingStop('unsupported', `memory-forwarding-${role}-width-invalid`);
  if (!['little', 'big'].includes(memory.endian)) {
    throw new ForwardingStop('unsupported', `memory-forwarding-${role}-endian-invalid`);
  }
  const qualifierProof = forwardingAccessProofIsCanonical(metadata?.accessProof, metadata, memory, memorySsa);
  // A missing or forged qualifier is not proof of an ordinary access. The
  // canonical access proof is required even for explicit false qualifiers so
  // a caller cannot manufacture exactness by editing the access metadata.
  if (!qualifierProof) {
    throw new ForwardingStop('unsupported', `memory-forwarding-${role}-access-proof-unproven`);
  }
  if (metadata?.accessProof?.volatility !== false) {
    throw new ForwardingStop('unsupported', 'memory-forwarding-volatile-unsupported');
  }
  if (metadata?.accessProof?.atomic !== false) {
    throw new ForwardingStop('unsupported', 'memory-forwarding-atomic-unsupported');
  }
  if (metadata?.accessProof?.ordering != null && metadata.accessProof.ordering !== 'unknown') {
    throw new ForwardingStop('unsupported', 'memory-forwarding-ordering-unsupported');
  }
  return widthBits;
}

function forwardingCheckRangeWidth(range, widthBits, code) {
  const widthBytes = forwardingBytes(widthBits);
  if (!range || widthBytes == null || range.end - range.start !== BigInt(widthBytes)) {
    throw new ForwardingStop('unknown', code);
  }
}

function forwardingIdentity(memorySsa, use, loadMeta, winners, stores, coverage, context, options) {
  return {
    digest: stableDigest({
      artifact: memorySsa.identity ?? null,
      regions: memorySsa.regions ?? null,
      canonicalIrIdentity: memorySsa.canonicalIrIdentity ?? {
        functionId: memorySsa.functionId,
        semanticIrDigest: memorySsa.identity?.semanticIrDigest ?? null,
      },
      functionId: memorySsa.functionId,
      contractVersion: memorySsa.contractVersion,
      buildVersion: memorySsa.buildVersion ?? null,
      use,
      loadMetadata: loadMeta,
      loadRange: context.loadRange,
      loadMemory: context.loadMemory,
      loadSource: context.loadSource == null ? null : {
        identity: forwardingSourceIdentity(context.loadSource),
        memory: forwardingSourceAccess(context.loadSource),
        origin: context.loadSource.origin ?? null,
      },
      coverageProof: coverage?.proof ?? null,
      coverageStates: coverage?.regionStates ?? null,
      coverageRegionAliases: coverage?.regionAliasStates ?? null,
      stores: stores.map((store) => ({
        definitionId: store.definition.id,
        value: store.value.value,
        rawValue: store.value.raw ?? null,
        range: store.range,
        order: store.order,
        sourceEntityId: store.definition.sourceEntityId,
        origin: store.definition.origin ?? null,
        proof: store.definition.proof ?? null,
        aliasRelation: store.definition.aliasRelation ?? null,
        aliasProof: store.metadata?.aliasProof ?? null,
        metadataOrigin: store.metadata?.origin ?? null,
        sourceOrigin: store.source?.origin ?? null,
        memory: store.metadata?.memory ?? null,
        sequencing: store.metadata?.sequencing ?? null,
        rangeProof: store.metadata?.rangeProof ?? null,
      })),
      winners: winners.map((winner) => ({
        definitionId: winner.definition.id,
        byte: winner.byte,
        range: winner.range,
        order: winner.order,
        sourceEntityId: winner.definition.sourceEntityId,
      })),
      optionsIdentity: options.currentIdentity ?? null,
      consumerId: options.consumerId ?? null,
      purpose: options.purpose ?? null,
      canonicalIrDigest: options.ir == null ? null : stableDigest(options.ir),
    }),
    functionId: memorySsa.functionId,
    snapshotId: memorySsa.snapshotId ?? options.snapshotId ?? null,
    memorySsaBuildVersion: memorySsa.buildVersion ?? null,
  };
}

function forwardingResult(status, reason, details = {}) {
  const normalizedStatus = status === FORWARD_EXACT ? FORWARD_EXACT : (FORWARD_NON_EXACT.has(status) ? status : 'unknown');
  return deepFreeze({
    status: normalizedStatus,
    exact: normalizedStatus === FORWARD_EXACT,
    reason: reason == null ? null : String(reason),
    ...details,
  });
}

function forwardingCapabilityDetails(artifact, use, context, options) {
  return {
    useId: String(use.id),
    loadSourceEntityId: String(use.sourceEntityId ?? ''),
    loadNodeId: String(context.useMeta?.nodeId ?? use.sourceEntityId ?? ''),
    loadEntityId: String(context.useMeta?.memorySsaEntityId ?? use.id),
    loadRegionId: String(use.regionId ?? ''),
    snapshotId: artifact.snapshotId == null ? null : String(artifact.snapshotId),
    consumerId: options.consumerId,
    purpose: options.purpose,
  };
}

function forwardingRegisterExactFact(fact, artifact, use, context) {
  if (!forwardingObject(fact) || !forwardingObject(artifact) || !forwardingObject(use) || !context) return fact;
  const binding = Object.freeze({
    artifact,
    useId: String(use.id),
    sourceEntityId: String(use.sourceEntityId ?? ''),
    snapshotId: String(artifact.snapshotId ?? ''),
    artifactDigest: String(fact.artifactDigest ?? ''),
    identityDigest: String(fact.identity?.digest ?? ''),
    nodeId: String(context.useMeta?.nodeId ?? use.sourceEntityId ?? ''),
    entityId: String(context.useMeta?.memorySsaEntityId ?? use.id),
    regionId: String(use.regionId ?? ''),
    consumerId: String(fact.consumerId ?? ''),
    purpose: String(fact.purpose ?? ''),
    loadRange: {
      domain: String(context.loadRange?.domain ?? ''),
      start: context.loadRange?.start?.toString?.() ?? '',
      end: context.loadRange?.end?.toString?.() ?? '',
    },
  });
  return deepFreeze(new CanonicalMemoryForwardingFact(fact, binding));
}

function forwardingFactBindingIsCurrent(fact, expectedContext = null) {
  const binding = CanonicalMemoryForwardingFact.bindingFor(fact);
  if (!binding) return false;
  const expected = forwardingContextObject(expectedContext);
  if (!expected
      || !expected.artifact
      || expected.artifact !== binding.artifact
      || !expected.artifactDigest
      || !expected.snapshotId
      || !expected.useId
      || !expected.sourceEntityId
      || !expected.nodeId
      || !expected.entityId
      || !expected.regionId
      || !expected.consumerId
      || !expected.purpose
      || expected.consumerId !== binding.consumerId
      || expected.purpose !== binding.purpose
      || String(expected.artifactDigest ?? '') !== binding.artifactDigest
      || String(expected.snapshotId ?? '') !== binding.snapshotId
      || String(expected.useId ?? '') !== binding.useId
      || String(expected.sourceEntityId ?? '') !== binding.sourceEntityId
      || String(expected.nodeId ?? '') !== binding.nodeId
      || String(expected.entityId ?? '') !== binding.entityId
      || String(expected.regionId ?? '') !== binding.regionId) return false;
  const artifact = binding.artifact;
  try {
    if (!forwardingObject(artifact)
        || !isCanonicalMemorySsaProducerArtifact(artifact)
        || String(artifact.canonicalDigest ?? '') !== binding.artifactDigest
        || String(canonicalMemorySsaDigest(artifact)) !== binding.artifactDigest
        || String(artifact.snapshotId ?? '') !== binding.snapshotId
        || String(fact.artifactDigest ?? '') !== binding.artifactDigest
        || String(fact.identity?.digest ?? '') !== binding.identityDigest
        || String(fact.useId ?? '') !== binding.useId
        || String(fact.loadSourceEntityId ?? '') !== binding.sourceEntityId
        || String(fact.loadNodeId ?? '') !== binding.nodeId
        || String(fact.loadEntityId ?? '') !== binding.entityId
        || String(fact.loadRegionId ?? '') !== binding.regionId
        || String(fact.consumerId ?? '') !== binding.consumerId
        || String(fact.purpose ?? '') !== binding.purpose) return false;
    if (expected.artifact != null && expected.artifact !== artifact) return false;
    const expectedRange = forwardingRawRange(expected.range, binding.loadRange.domain);
    if (!expectedRange
        || expectedRange.start.toString() !== binding.loadRange.start
        || expectedRange.end.toString() !== binding.loadRange.end) return false;
    const use = (artifact.uses ?? []).find((item) => String(item?.id ?? '') === binding.useId);
    if (!use || String(use.sourceEntityId ?? '') !== binding.sourceEntityId) return false;
    const metadata = (artifact.accessMetadata ?? []).find((item) =>
      String(item?.memorySsaEntityId ?? '') === binding.useId);
    if (!metadata
        || String(metadata.sourceEntityId ?? '') !== binding.sourceEntityId
        || String(metadata.nodeId ?? '') !== binding.sourceEntityId
        || String(metadata.rangeProof?.sourceEntityId ?? '') !== binding.sourceEntityId
        || String(metadata.accessProof?.sourceEntityId ?? '') !== binding.sourceEntityId) return false;
    const loadRange = forwardingRawRange(fact.loadRange, binding.loadRange.domain);
    if (!loadRange
        || loadRange.start.toString() !== binding.loadRange.start
        || loadRange.end.toString() !== binding.loadRange.end) return false;
    return true;
  } catch {
    return false;
  }
}

/* The compatibility projection and all exact downstream consumers use this
 * gate instead of structural `reachingStore`.  Keeping the predicate beside
 * the canonical query prevents a consumer from accidentally treating a
 * partial/legacy shape as a proven value. */
export function isCanonicalExactMemoryForwarding(fact, expectedContext = null) {
  if (!forwardingObject(fact)
      || fact.status !== FORWARD_EXACT
      || fact.exact !== true
      || fact.reason !== null
      || fact.completeness !== 'complete'
      || fact.proofKind !== 'canonical-memoryssa-byte-forwarding'
      || String(fact.proofVersion ?? '') !== MEMORY_SSA_PROOF_VERSION
      || typeof fact.artifactDigest !== 'string' || !fact.artifactDigest.trim()
      || !forwardingObject(fact.identity)
      || typeof fact.identity.digest !== 'string' || !fact.identity.digest.trim()
      || !Number.isSafeInteger(Number(fact.widthBits)) || Number(fact.widthBits) <= 0
      || !['little', 'big'].includes(String(fact.endian ?? ''))
      || !Array.isArray(fact.bytes)
      || fact.bytes.length !== Number(fact.widthBits) / 8
      || !Array.isArray(fact.contributingDefinitionIds)
      || !fact.contributingDefinitionIds.length
      || new Set(fact.contributingDefinitionIds.map(String)).size !== fact.contributingDefinitionIds.length
      || fact.contributingDefinitionIds.some((id) => !String(id).trim())
      || !intrinsicObjectHasOwn(fact, 'value')
      || typeof fact.value !== 'bigint'
      || !forwardingObject(fact.provenance)
      || !Array.isArray(fact.provenance.sourceEntityIds)
      || fact.provenance.sourceEntityIds.length !== fact.contributingDefinitionIds.length
      || !Array.isArray(fact.provenance.definitionOrigins)
      || fact.provenance.definitionOrigins.length !== fact.contributingDefinitionIds.length) return false;
  const widthBits = Number(fact.widthBits);
  const value = fact.value;
  if (value == null) return false;
  const unsigned = BigInt.asUintN(widthBits, value);
  const signed = BigInt.asIntN(widthBits, value);
  if (value !== unsigned && value !== signed) return false;
  const widthBytes = widthBits / 8;
  for (let index = 0; index < widthBytes; index++) {
    if (!Number.isInteger(fact.bytes[index]) || fact.bytes[index] < 0 || fact.bytes[index] > 0xff) return false;
    const shift = fact.endian === 'little' ? index : widthBytes - index - 1;
    const expected = Number((unsigned >> BigInt(shift * 8)) & 0xffn);
    if (fact.bytes[index] !== expected) return false;
  }
  return forwardingFactBindingIsCurrent(fact, expectedContext);
}

/*
 * A pointer load can be exact without having a numeric byte literal: the
 * complete byte proof may establish that every loaded byte is the one
 * canonical Semantic IR store operand.  This is a distinct gate from the
 * numeric-byte gate above.  It is intentionally narrow (one full-width
 * operand) and is consumed only by the canonical points-to boundary; generic
 * scalar/decompiler consumers must continue to require numeric bytes.
 */
export function isCanonicalExactMemoryOperandForwarding(fact, expectedContext = null) {
  if (!forwardingObject(fact)
      || fact.status !== FORWARD_EXACT
      || fact.exact !== true
      || fact.reason !== null
      || fact.completeness !== 'complete'
      || fact.proofKind !== 'canonical-memoryssa-operand-forwarding'
      || String(fact.proofVersion ?? '') !== MEMORY_SSA_PROOF_VERSION
      || typeof fact.artifactDigest !== 'string' || !fact.artifactDigest.trim()
      || !forwardingObject(fact.identity)
      || typeof fact.identity.digest !== 'string' || !fact.identity.digest.trim()
      || String(fact.operandKind ?? '') !== 'address'
      || !String(fact.storedValueId ?? '').trim()
      || !String(fact.storedSourceEntityId ?? '').trim()
      || typeof fact.semanticValueDigest !== 'string' || !fact.semanticValueDigest.trim()
      || !Number.isSafeInteger(Number(fact.widthBits)) || Number(fact.widthBits) <= 0
      || !['little', 'big'].includes(String(fact.endian ?? ''))
      || !Array.isArray(fact.contributingDefinitionIds)
      || fact.contributingDefinitionIds.length !== 1
      || String(fact.contributingDefinitionIds[0] ?? '') !== String(fact.definitionId ?? '')
      || !forwardingObject(fact.provenance)
      || !Array.isArray(fact.provenance.sourceEntityIds)
      || fact.provenance.sourceEntityIds.length !== 1
      || String(fact.provenance.sourceEntityIds[0] ?? '') !== String(fact.storedSourceEntityId)
      || !Array.isArray(fact.provenance.definitionOrigins)
      || fact.provenance.definitionOrigins.length !== 1) return false;
  return forwardingFactBindingIsCurrent(fact, expectedContext);
}

function forwardingExactOperand(stores, context, state) {
  const overlapping = stores.filter((store) => forwardingOverlap(store.range, context.loadRange));
  if (overlapping.length !== 1) return null;
  const [store] = overlapping;
  if (store.value?.value != null
      || store.storeWidthBits !== context.loadWidthBits
      || store.range.domain !== context.loadRange.domain
      || store.range.start !== context.loadRange.start
      || store.range.end !== context.loadRange.end
      || store.metadata?.memory?.endian !== context.loadMemory.endian) return null;
  forwardingScanTick(state);
  return store;
}

function forwardingLoadContext(memorySsa, use, options, metadataById, regionById, sourceById) {
  const useMeta = metadataById.get(String(use.id));
  if (!useMeta || useMeta.entityKind !== 'use' || useMeta.regionId !== String(use.regionId)
      || useMeta.sourceKind !== 'load' || useMeta.role !== 'read' || useMeta.broad === true) {
    throw new ForwardingStop('unknown', 'memory-forwarding-load-metadata-invalid');
  }
  forwardingCheckSourceBinding(useMeta, use.sourceEntityId, 'load');
  const loadSource = forwardingLookup(sourceById, use.sourceEntityId);
  const loadMemory = forwardingAccessFromMetadata(useMeta, loadSource);
  if (loadSource) {
    const sourceMemory = forwardingSourceAccess(loadSource);
    if (sourceMemory != null || loadSource.completeness != null || forwardingMemoryUnknown(loadSource)) {
      forwardingCheckSourceNode(loadSource, sourceMemory ?? loadMemory, 'load');
    }
  }
  if (!forwardingOriginComplete(use.origin)
      || (loadSource && !forwardingOriginComplete(loadSource.origin))) {
    throw new ForwardingStop('unknown', 'memory-forwarding-load-provenance-missing');
  }
  forwardingCheckOrigins(useMeta.origin, use.origin, 'memory-forwarding-load-provenance-conflict');
  if (loadSource) forwardingCheckOrigins(useMeta.origin, loadSource.origin, 'memory-forwarding-load-provenance-conflict');
  if (useMeta.memory != null && loadSource != null) {
    const sourceMemory = forwardingSourceAccess(loadSource);
    if (sourceMemory != null && stableStringify(useMeta.memory) !== stableStringify(sourceMemory)) {
      throw new ForwardingStop('unknown', 'memory-forwarding-load-memory-mismatch');
    }
  }
  const loadWidthBits = forwardingCheckAccess(loadMemory, 'load', useMeta, memorySsa);
  const loadRegion = regionById.get(String(use.regionId));
  if (!loadRegion) throw new ForwardingStop('unknown', 'memory-forwarding-load-region-missing');
  const loadRange = forwardingRange(loadRegion, loadMemory, useMeta, loadSource, options);
  if (!loadRange) throw new ForwardingStop('unknown', 'memory-forwarding-load-range-unproven');
  forwardingCheckRangeWidth(loadRange, loadWidthBits, 'memory-forwarding-load-range-width-mismatch');
  forwardingCheckRangeBinding(loadRange, loadRegion, loadMemory, useMeta, loadSource, use.sourceEntityId, 'load');
  if (use.aliasRelation !== 'must') throw new ForwardingStop('unknown', 'memory-forwarding-load-alias-unproven');
  if (useMeta.aliasRelation !== 'must') {
    throw new ForwardingStop('unknown', 'memory-forwarding-load-alias-proof-unproven');
  }
  if (!forwardingAliasProofIsMust(useMeta.aliasProof, {
    memorySsa,
    expectedRegionIds: [use.regionId],
    expectedSourceEntityIds: [use.sourceEntityId],
  })) {
    throw new ForwardingStop('unknown', 'memory-forwarding-load-alias-proof-missing');
  }
  return { useMeta, loadSource, loadMemory, loadWidthBits, loadRegion, loadRange };
}

function forwardingCoverageStateForUse(memorySsa, use, context, coverage, state) {
  if (!forwardingObject(coverage)
      || String(coverage.useId ?? '') !== String(use.id)) {
    throw new ForwardingStop('unknown', 'memory-forwarding-coverage-row-malformed');
  }
  if (String(coverage.nodeId ?? '') !== String(use.sourceEntityId ?? '')
      || String(coverage.regionId ?? '') !== String(use.regionId ?? '')) {
    throw new ForwardingStop('unknown', 'memory-forwarding-coverage-use-binding-invalid');
  }
  if (coverage.coverageState !== 'complete') {
    throw new ForwardingStop('partial', 'memory-forwarding-coverage-incomplete');
  }
  if (!Array.isArray(coverage.regionStates) || coverage.regionStates.length === 0) {
    throw new ForwardingStop('unknown', 'memory-forwarding-region-state-missing');
  }
  const coveredLoadRange = forwardingRawRange(coverage.loadRange, context.loadRange.domain);
  if (!coveredLoadRange
      || coveredLoadRange.start !== context.loadRange.start
      || coveredLoadRange.end !== context.loadRange.end) {
    throw new ForwardingStop('unknown', 'memory-forwarding-coverage-load-range-mismatch');
  }
  const proof = coverage.proof;
  const expectedBuildVersion = memorySsa.buildVersion
    ?? memorySsa.identity?.memorySsaBuildVersion
    ?? null;
  if (!forwardingObject(proof)
      || proof.kind !== 'memoryssa-byte-state'
      || String(proof.version ?? '') !== MEMORY_SSA_PROOF_VERSION
      || String(proof.functionId ?? '') !== String(memorySsa.functionId ?? '')
      || String(proof.useId ?? '') !== String(use.id)
      || String(proof.nodeId ?? '') !== String(use.sourceEntityId ?? '')
      || String(proof.regionId ?? '') !== String(use.regionId ?? '')
      || expectedBuildVersion == null
      || String(proof.buildVersion ?? '') !== String(expectedBuildVersion)
      || String(proof.identityDigest ?? '') !== stableDigest(memorySsa.identity ?? null)) {
    throw new ForwardingStop('unknown', 'memory-forwarding-coverage-proof-invalid');
  }
  const proofRange = forwardingRawRange(proof.loadRange, context.loadRange.domain);
  if (!proofRange || proofRange.start !== context.loadRange.start || proofRange.end !== context.loadRange.end) {
    throw new ForwardingStop('unknown', 'memory-forwarding-coverage-proof-range-mismatch');
  }
  const regionAliasStates = coverage.regionAliasStates;
  if (!Array.isArray(memorySsa.regions)
      || !Array.isArray(regionAliasStates)
      || regionAliasStates.length !== memorySsa.regions.length) {
    throw new ForwardingStop('unknown', 'memory-forwarding-region-alias-coverage-incomplete');
  }
  const seenRegionAliases = new Set();
  for (const item of regionAliasStates) {
    forwardingScanTick(state);
    const regionId = String(item?.regionId ?? '');
    if (!regionId || seenRegionAliases.has(regionId) || !regionByIdForCoverage(memorySsa, regionId)) {
      throw new ForwardingStop('unknown', 'memory-forwarding-region-alias-coverage-malformed');
    }
    seenRegionAliases.add(regionId);
    if (item.aliasRelation === 'must') {
      if (!forwardingAliasProofIsMust(item.aliasProof, {
        memorySsa,
        expectedUseId: use.id,
        expectedRegionIds: [use.regionId, regionId],
        expectedSourceEntityIds: [use.sourceEntityId],
      })) {
        throw new ForwardingStop('unknown', 'memory-forwarding-region-alias-proof-unproven');
      }
    } else if (item.aliasRelation === 'no') {
      if (!forwardingAliasProofIsNo(item.aliasProof, {
        memorySsa,
        expectedUseId: use.id,
        expectedRegionIds: [use.regionId, regionId],
        expectedSourceEntityIds: [use.sourceEntityId],
      })) {
        throw new ForwardingStop('unknown', 'memory-forwarding-region-no-alias-proof-missing');
      }
    } else {
      throw new ForwardingStop('unknown', 'memory-forwarding-region-alias-coverage-unproven');
    }
  }
  if (seenRegionAliases.size !== memorySsa.regions.length) {
    throw new ForwardingStop('unknown', 'memory-forwarding-region-alias-coverage-incomplete');
  }
  const relevantRegions = new Set(regionAliasStates
    .filter((item) => item.aliasRelation !== 'no')
    .map((item) => String(item.regionId)));
  const stateRegions = new Set();
  for (const item of coverage.regionStates) {
    forwardingScanTick(state);
    const stateRegionId = String(item?.regionId ?? '');
    if (stateRegions.has(stateRegionId) || !relevantRegions.has(stateRegionId)
        || item.aliasRelation !== 'must'
        || !forwardingAliasProofIsMust(item.aliasProof, {
          memorySsa,
          expectedRegionIds: [use.regionId, stateRegionId],
          expectedSourceEntityIds: [use.sourceEntityId],
        })) {
      throw new ForwardingStop('unknown', 'memory-forwarding-load-region-alias-unproven');
    }
    stateRegions.add(stateRegionId);
  }
  if (stateRegions.size !== relevantRegions.size) {
    throw new ForwardingStop('unknown', 'memory-forwarding-region-state-incomplete');
  }
  return coverage.regionStates.map((item) => ({
    regionId: String(item.regionId ?? ''),
    definitionId: String(item.definitionId ?? ''),
    order: item.order == null ? null : item.order,
    aliasRelation: item.aliasRelation ?? null,
    aliasProof: item.aliasProof ?? null,
  }));
}

function forwardingCoverageStates(memorySsa, use, context, options, state, metadataById, regionById, sourceById) {
  if (!Array.isArray(memorySsa.byteCoverage)) {
    // Without the producer's complete cross-region index there is no proof
    // that another region did not clobber one of the load bytes. Never fall
    // back to this use's region or a subset of canonical coverage.
    throw new ForwardingStop('unknown', 'memory-forwarding-coverage-index-missing');
  }
  const usesById = new Map((memorySsa.uses ?? []).map((item) => [String(item.id), item]));
  const seenUseIds = new Set();
  let selectedStates = null;
  for (const coverage of memorySsa.byteCoverage) {
    forwardingScanTick(state);
    if (!forwardingObject(coverage)) {
      throw new ForwardingStop('unknown', 'memory-forwarding-coverage-row-malformed');
    }
    const coverageUseId = String(coverage.useId ?? '').trim();
    if (!coverageUseId || seenUseIds.has(coverageUseId)) {
      throw new ForwardingStop('unknown', 'memory-forwarding-coverage-use-duplicate');
    }
    seenUseIds.add(coverageUseId);
    const coverageUse = usesById.get(coverageUseId);
    if (!coverageUse) throw new ForwardingStop('unknown', 'memory-forwarding-coverage-use-missing');
    const coverageContext = coverageUseId === String(use.id)
      ? context
      : forwardingLoadContext(memorySsa, coverageUse, options, metadataById, regionById, sourceById);
    const states = forwardingCoverageStateForUse(memorySsa, coverageUse, coverageContext, coverage, state);
    if (coverageUseId === String(use.id)) selectedStates = states;
  }
  if (!selectedStates) throw new ForwardingStop('unknown', 'memory-forwarding-coverage-missing');
  return selectedStates;
}

function regionByIdForCoverage(memorySsa, regionId) {
  return (memorySsa.regions ?? []).some((region) => String(region.id) === regionId);
}

function forwardingCollect(memorySsa, use, context, options, metadataById, regionById, sourceById, state) {
  const states = forwardingCoverageStates(
    memorySsa,
    use,
    context,
    options,
    state,
    metadataById,
    regionById,
    sourceById,
  );
  const definitions = new Map((memorySsa.definitions ?? []).map((definition) => [String(definition.id), definition]));
  if (!states.every((item) => item.regionId && item.definitionId)) {
    throw new ForwardingStop('unknown', 'memory-forwarding-region-state-malformed');
  }
  const seenRegions = new Set();
  const stores = [];
  const visitedByRegion = new Set();
  for (const stateItem of states) {
    forwardingScanTick(state);
    if (seenRegions.has(stateItem.regionId)) {
      throw new ForwardingStop('unknown', 'memory-forwarding-region-state-duplicate');
    }
    seenRegions.add(stateItem.regionId);
    if (stateItem.aliasRelation !== 'must' || !forwardingAliasProofIsMust(stateItem.aliasProof, {
      memorySsa,
      expectedRegionIds: [use.regionId, stateItem.regionId],
      expectedSourceEntityIds: [use.sourceEntityId],
    })) {
      throw new ForwardingStop('unknown', 'memory-forwarding-load-region-alias-unproven');
    }
    const region = regionById.get(stateItem.regionId);
    if (!region) throw new ForwardingStop('unknown', 'memory-forwarding-state-region-missing');
    const chainInfo = forwardingDefinitionChain(memorySsa, stateItem.definitionId, state);
    let priorStoreOrder = null;
    for (let index = 0; index < chainInfo.chain.length; index++) {
      forwardingScanTick(state);
      const definition = chainInfo.chain[index];
      if (String(definition.regionId) !== stateItem.regionId) {
        throw new ForwardingStop('unknown', 'memory-forwarding-cross-region-definition');
      }
      const visitKey = `${stateItem.regionId}\u0000${definition.id}`;
      if (visitedByRegion.has(visitKey)) continue;
      visitedByRegion.add(visitKey);
      const metadata = forwardingMetaForDefinition(metadataById, definition);
      const source = forwardingLookup(sourceById, definition.sourceEntityId);
      // The entry version is the canonical initial-memory state, not a
      // concrete access.  It has no access metadata, byte range, or producer
      // provenance to validate; treating its absent metadata as a conflict
      // would reject every otherwise valid definition chain before reaching
      // the proven stores.
      if (definition.kind === 'entry') continue;
      const memory = forwardingAccessFromMetadata(metadata, source);
      if (source) {
        const sourceMemory = forwardingSourceAccess(source);
        if (sourceMemory != null || source.completeness != null || forwardingMemoryUnknown(source)) {
          forwardingCheckSourceNode(source, sourceMemory ?? memory, 'store');
        }
      }
      if (!forwardingOriginComplete(definition.origin)
          || (source && !forwardingOriginComplete(source.origin))) {
        throw new ForwardingStop('unknown', 'memory-forwarding-store-provenance-missing');
      }
      forwardingCheckOrigins(metadata?.origin, definition.origin, 'memory-forwarding-store-provenance-conflict');
      if (source) forwardingCheckOrigins(metadata?.origin, source.origin, 'memory-forwarding-store-provenance-conflict');
      if (metadata?.memory != null && source != null) {
        const sourceMemory = forwardingSourceAccess(source);
        if (sourceMemory != null && stableStringify(metadata.memory) !== stableStringify(sourceMemory)) {
          throw new ForwardingStop('unknown', 'memory-forwarding-store-memory-mismatch');
        }
      }
      const range = forwardingRange(region, memory, metadata, source, options);
      if (!range) {
        // An unknown-range clobber can touch any load byte.  A missing range
        // on an ordinary definition is equally unproven and must fail closed.
        throw new ForwardingStop('unknown', `memory-forwarding-${definition.kind}-range-unproven`);
      }
      if (!forwardingOverlap(range, context.loadRange)) continue;
      if (MEMORY_BARRIER_KINDS.has(definition.kind)) {
        throw new ForwardingStop('unknown', `memory-forwarding-${definition.kind}-barrier`);
      }
      if (definition.kind !== 'memory-def' || definition.aliasRelation !== 'must'
          || !forwardingObject(definition.proof)
          || definition.proof.kind !== 'must-alias-memory-write'
          || String(definition.proof.version ?? '') !== MEMORY_SSA_PROOF_VERSION
          || definition.proof?.aliasRelation !== 'must'
          || !forwardingAliasProofIsMust(definition.proof?.providerProof, {
            memorySsa,
            expectedRegionIds: [stateItem.regionId, stateItem.regionId],
            expectedSourceEntityIds: [definition.sourceEntityId],
          })
          || definition.proof?.aliasRelation === 'may'
          || definition.proof?.aliasRelation === 'unknown') {
        throw new ForwardingStop('unknown', 'memory-forwarding-store-proof-unproven');
      }
      if (!metadata || metadata.entityKind !== 'definition' || metadata.regionId !== String(definition.regionId)
          || metadata.sourceKind !== 'store' || metadata.role !== 'write' || metadata.broad === true
          || metadata.aliasRelation !== 'must' || !forwardingAliasProofIsMust(metadata.aliasProof, {
            memorySsa,
            expectedRegionIds: [stateItem.regionId],
            expectedSourceEntityIds: [metadata.sourceEntityId],
          })) {
        throw new ForwardingStop('unknown', 'memory-forwarding-store-metadata-invalid');
      }
      forwardingCheckSourceBinding(metadata, definition.sourceEntityId, 'store');
      const storeWidthBits = forwardingCheckAccess(memory, 'store', metadata, memorySsa);
      if (memory.endian !== context.loadMemory.endian) {
        throw new ForwardingStop('unsupported', 'memory-forwarding-endian-conflict');
      }
      forwardingCheckRangeWidth(range, storeWidthBits, 'memory-forwarding-store-range-width-mismatch');
      forwardingCheckRangeBinding(range, region, memory, metadata, source, definition.sourceEntityId, 'store');
      const value = forwardingValueForDefinition(definition, metadata, memorySsa, options);
      const order = forwardingOrderFor(
        definition,
        index,
        String(stateItem.definitionId) === String(definition.id) ? stateItem.order : null,
        metadata,
      );
      if (order == null) throw new ForwardingStop('unknown', 'memory-forwarding-store-order-unproven');
      if (priorStoreOrder != null && order >= priorStoreOrder) {
        throw new ForwardingStop('unknown', 'memory-forwarding-store-order-conflict');
      }
      priorStoreOrder = order;
      stores.push({
        definition,
        metadata,
        source,
        range,
        value,
        storeWidthBits,
        order,
      });
    }
  }
  return stores;
}

function forwardingAssign(stores, context, options, state) {
  for (let leftIndex = 0; leftIndex < stores.length; leftIndex++) {
    const left = stores[leftIndex];
    if (!forwardingOverlap(left.range, context.loadRange)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < stores.length; rightIndex++) {
      forwardingScanTick(state);
      const right = stores[rightIndex];
      if (!forwardingOverlap(right.range, context.loadRange)
          || !forwardingOverlap(left.range, right.range)) continue;
      if (left.order == null || right.order == null || left.order === right.order) {
        throw new ForwardingStop('unknown', 'memory-forwarding-store-order-unproven');
      }
    }
  }
  const byteMap = new Map();
  for (const store of stores) {
    forwardingScanTick(state);
    if (store.value.value == null) {
      throw new ForwardingStop('unknown', 'memory-forwarding-store-byte-value-unproven');
    }
    const bytes = forwardingBytesForStore(store.value, store.storeWidthBits, store.metadata.memory.endian, state);
    for (let index = 0; index < bytes.length; index++) {
      const absolute = store.range.start + BigInt(index);
      if (absolute < context.loadRange.start || absolute >= context.loadRange.end) continue;
      const key = absolute.toString();
      const previous = byteMap.get(key);
      if (!previous) {
        byteMap.set(key, { byte: bytes[index], definition: store.definition, order: store.order });
        continue;
      }
      if (previous.order == null || store.order == null || previous.order === store.order) {
        throw new ForwardingStop('unknown', 'memory-forwarding-store-order-unproven');
      }
      if (store.order > previous.order) {
        byteMap.set(key, { byte: bytes[index], definition: store.definition, order: store.order });
      }
    }
  }
  return byteMap;
}

/**
 * Return one proof-bearing value for a load, or an explicit non-exact result.
 *
 * `options.sourceByEntityId` (or `instructionsBySemanticId`) is an optional
 * projection used only for consistency checks; it is not a memory fact and
 * cannot provide a forwarded value. Every exact result still requires the
 * canonical store operand/value and every MemorySSA proof dimension.
 */
export function forwardMemoryValue(memorySsa, useOrId, options = {}) {
  let context = null;
  try {
    forwardingStatusFromArtifact(memorySsa, options);
    const validated = validateMemorySsa(memorySsa, {
      signal: options.signal,
      budget: options.validationBudget,
      cfg: options.cfg,
    });
    // Preserve the producer-published object when validation succeeds.  The
    // validator may return a normalized overlay, but that new object must not
    // silently lose the private producer binding required for exactness.
    const artifact = isCanonicalMemorySsaProducerArtifact(memorySsa)
      ? memorySsa
      : (validated ?? memorySsa);
    const use = useOrId && typeof useOrId === 'object'
      ? useMap(artifact).get(String(useOrId.id ?? ''))
      : useFrom(artifact, useOrId);
    if (!use || typeof use !== 'object') throw new ForwardingStop('unknown', 'memory-forwarding-use-missing');
    const definitions = Array.isArray(artifact.definitions) ? artifact.definitions : null;
    const uses = Array.isArray(artifact.uses) ? artifact.uses : null;
    const regions = Array.isArray(artifact.regions) ? artifact.regions : null;
    if (!definitions || !uses || !regions) throw new ForwardingStop('unknown', 'memory-forwarding-artifact-malformed');
    const state = {
      options,
      usedDefinitions: 0,
      usedBytes: 0,
      iterations: 0,
      maxDefinitions: forwardingPositiveInteger(options.budget?.maxDefinitions ?? 262144, 'memory-forwarding-invalid-definition-budget'),
      maxBytes: forwardingPositiveInteger(options.budget?.maxBytes ?? options.budget?.maxWorkItems ?? 1048576, 'memory-forwarding-invalid-byte-budget'),
      maxIterations: forwardingPositiveInteger(options.maxIterations ?? options.budget?.maxIterations ?? 4194304, 'memory-forwarding-invalid-iteration-budget'),
      deadlineMs: forwardingDeadlineMs(options),
    };
    const regionById = new Map(regions.map((region) => [String(region.id), region]));
    const metadataById = forwardingMetadataIndex(artifact, state);
    const sourceById = forwardingSourceMap(options);
    context = forwardingLoadContext(artifact, use, options, metadataById, regionById, sourceById);
    const stores = forwardingCollect(artifact, use, context, options, metadataById, regionById, sourceById, state);
    const operandStore = forwardingExactOperand(stores, context, state);
    if (operandStore) {
      const coverage = Array.isArray(artifact.byteCoverage)
        ? artifact.byteCoverage.find((item) => String(item.useId) === String(use.id))
        : null;
      const winner = {
        definition: operandStore.definition,
        range: operandStore.range,
        order: operandStore.order,
        byte: null,
      };
      const proofIdentity = forwardingIdentity(
        artifact,
        use,
        context.useMeta,
        [winner],
        stores,
        coverage,
        context,
        options,
      );
      return forwardingRegisterExactFact(forwardingResult(FORWARD_EXACT, null, {
        ...forwardingCapabilityDetails(artifact, use, context, options),
        proofKind: 'canonical-memoryssa-operand-forwarding',
        proofVersion: MEMORY_SSA_PROOF_VERSION,
        artifactDigest: artifact.canonicalDigest,
        storedValueId: operandStore.value.valueId,
        storedSourceEntityId: operandStore.definition.sourceEntityId,
        operandKind: operandStore.value.valueKind,
        semanticValueDigest: operandStore.value.raw.semanticValueDigest,
        definitionId: String(operandStore.definition.id),
        valueId: operandStore.value.valueId,
        widthBits: context.loadWidthBits,
        endian: context.loadMemory.endian,
        loadRange: {
          domain: context.loadRange.domain,
          start: context.loadRange.start.toString(),
          end: context.loadRange.end.toString(),
        },
        contributingDefinitionIds: [String(operandStore.definition.id)],
        provenance: {
          loadOrigin: use.origin ?? null,
          definitionOrigins: [operandStore.definition.origin ?? null],
          sourceEntityIds: [operandStore.definition.sourceEntityId ?? null],
        },
        identity: proofIdentity,
        completeness: 'complete',
      }), artifact, use, context);
    }
    const byteMap = forwardingAssign(stores, context, options, state);
    const widthBytes = forwardingBytes(context.loadWidthBits);
    const missing = [];
    for (let index = 0; index < widthBytes; index++) {
      forwardingByteTick(state);
      const key = (context.loadRange.start + BigInt(index)).toString();
      if (!byteMap.has(key)) missing.push(key);
    }
    if (missing.length) {
      return forwardingResult('partial', 'memory-forwarding-byte-hole', {
        widthBits: context.loadWidthBits,
        endian: context.loadMemory.endian,
        loadRange: { domain: context.loadRange.domain, start: context.loadRange.start.toString(), end: context.loadRange.end.toString() },
        missingBytes: missing,
        completeness: 'partial',
      });
    }
    const value = forwardingLoadValue(byteMap, context.loadRange, context.loadWidthBits, context.loadMemory.endian, state);
    // Check once more after the final lane and before assembling/publicizing
    // the proof.  A cancellation or exhausted iteration budget at that
    // boundary must not race with an exact publication.
    forwardingScanTick(state);
    const winners = [...new Map([...byteMap.values()].map((lane) => [String(lane.definition.id), lane])).values()]
      .sort((left, right) => left.order - right.order || String(left.definition.id).localeCompare(String(right.definition.id)));
    const coverage = Array.isArray(artifact.byteCoverage)
      ? artifact.byteCoverage.find((item) => String(item.useId) === String(use.id))
      : null;
    const proofIdentity = forwardingIdentity(artifact, use, context.useMeta, winners, stores, coverage, context, options);
    return forwardingRegisterExactFact(forwardingResult(FORWARD_EXACT, null, {
      ...forwardingCapabilityDetails(artifact, use, context, options),
      proofKind: 'canonical-memoryssa-byte-forwarding',
      proofVersion: MEMORY_SSA_PROOF_VERSION,
      artifactDigest: artifact.canonicalDigest,
      value,
      bytes: [...byteMap.entries()].sort(([left], [right]) => forwardingBigInt(left) < forwardingBigInt(right) ? -1 : 1).map(([, lane]) => Number(lane.byte)),
      widthBits: context.loadWidthBits,
      endian: context.loadMemory.endian,
      loadRange: { domain: context.loadRange.domain, start: context.loadRange.start.toString(), end: context.loadRange.end.toString() },
      contributingDefinitionIds: winners.map((winner) => String(winner.definition.id)),
      provenance: {
        loadOrigin: use.origin ?? null,
        definitionOrigins: winners.map((winner) => winner.definition.origin ?? null),
        sourceEntityIds: winners.map((winner) => winner.definition.sourceEntityId ?? null),
      },
      identity: proofIdentity,
      completeness: 'complete',
    }), artifact, use, context);
  } catch (error) {
    if (error instanceof ForwardingStop) {
      return forwardingResult(error.status, error.reason, {
        ...(context?.loadWidthBits == null ? {} : { widthBits: context.loadWidthBits }),
        ...(error.detail == null ? {} : error.detail),
        completeness: error.status === 'exact' ? 'complete' : error.status,
      });
    }
    if (error?.status === 'budget-limited'
        || /^memory-ssa-(?:budget|validation-deadline)/.test(String(error?.message ?? error?.code ?? ''))) {
      return forwardingResult('budget-limited', String(error.message ?? error.code ?? 'memory-ssa-validation-budget-exhausted'), {
        completeness: 'budget-limited',
      });
    }
    if (/^memory-ssa-invalid-budget(?:-|$)/.test(String(error?.message ?? error?.code ?? ''))) {
      return forwardingResult('unsupported', String(error.message ?? error.code), { completeness: 'unsupported' });
    }
    if (options.signal?.aborted || error?.name === 'AbortError') {
      return forwardingResult('cancelled', 'analysis-cancelled', { completeness: 'cancelled' });
    }
    return forwardingResult('unknown', 'memory-forwarding-malformed-evidence', { completeness: 'partial' });
  }
}

export const reconstructMemoryValue = forwardMemoryValue;

export function memoryUsesOfDefinition(memorySsa, definitionOrId) {
  const definitionId = typeof definitionOrId === 'object' ? definitionOrId.id : String(definitionOrId);
  const byId = useMap(memorySsa);
  const indexed = memorySsa.defUseLinks?.find((link) => link.definitionId === definitionId)?.useIds;
  const useIds = indexed ?? memorySsa.uses
    .filter((use) => use.reachingDefinitionId === definitionId)
    .map((use) => use.id)
    .sort();
  return Object.freeze(useIds.map((id) => byId.get(id)).filter(Boolean));
}

export function memoryDefinitionsForRegion(memorySsa, regionId) {
  const id = String(regionId);
  return Object.freeze(memorySsa.definitions.filter((definition) => definition.regionId === id));
}

export function memoryAccessMetadata(memorySsa, memorySsaEntityId) {
  const id = String(memorySsaEntityId);
  return memorySsa.accessMetadata?.find((item) => item.memorySsaEntityId === id) ?? null;
}

export function memoryVersionAtBlock(memorySsa, blockId, regionId, position = 'exit') {
  if (!['entry', 'exit'].includes(position)) fail('memory-ssa-query-invalid-block-position');
  const state = memorySsa.blockStates?.find((item) => item.blockId === String(blockId));
  if (!state) return null;
  const item = state[position].find((entry) => entry.regionId === String(regionId));
  return item?.definitionId ?? null;
}

export function explainMemoryPath(memorySsa, useOrId, options = {}) {
  assertNotAborted(options);
  const maximum = options.maxDefinitions == null
    ? 4096
    : positiveInteger(options.maxDefinitions, 'memory-ssa-query-invalid-max-definitions');
  const definitions = definitionMap(memorySsa);
  const use = useFrom(memorySsa, useOrId);
  const visited = new Set();
  const work = [use.reachingDefinitionId];
  const nodes = [];
  const edges = [];
  while (work.length) {
    assertNotAborted(options);
    if (visited.size >= maximum) fail('memory-ssa-query-budget-exceeded-max-definitions');
    const id = work.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const definition = definitions.get(id);
    if (!definition) fail('memory-ssa-query-dangling-definition-link');
    nodes.push(definition);
    for (const previousId of definition.previousDefinitionIds) {
      edges.push({ from: definition.id, to: previousId, kind: 'previous' });
      if (!visited.has(previousId)) work.push(previousId);
    }
    for (const incoming of definition.incoming) {
      edges.push({
        from: definition.id,
        to: incoming.definitionId,
        kind: 'phi-incoming',
        predecessorBlockId: incoming.predecessorBlockId,
      });
      if (!visited.has(incoming.definitionId)) work.push(incoming.definitionId);
    }
    work.sort();
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
    || a.kind.localeCompare(b.kind)
    || String(a.predecessorBlockId ?? '').localeCompare(String(b.predecessorBlockId ?? '')));
  return deepFreeze({ use, nodes, edges });
}
