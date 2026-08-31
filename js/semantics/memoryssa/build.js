import {
  deepFreeze,
  jsonSafe,
  stableDigest,
  stableStringify,
} from '../../core/identity/index.js';
import {
  appendTransform,
  createTransformRecord,
} from '../../core/identity/origin.js';
import {
  deterministicTraversal,
  reachableBlocks,
} from '../cfg/index.js';
import {
  MEMORY_SSA_ALIAS_RELATIONS,
  MEMORY_SSA_DEFAULT_BUDGET,
  createMemoryRegionRef,
  createMemorySsaContract,
} from './contract.js';
import {
  canonicalAccessProof,
  canonicalAccessBinding,
  canonicalAliasProof,
  canonicalMemorySsaDigest,
  canonicalStoreValueProof,
  MEMORY_SSA_PROOF_VERSION,
} from './proof.js';

export const MEMORY_SSA_BUILD_VERSION = '1.0.0';
export const MEMORY_SSA_BUILD_DEFAULT_BUDGET = Object.freeze({
  ...MEMORY_SSA_DEFAULT_BUDGET,
  maxAliasQueries: 1048576,
  maxWorkItems: 4194304,
});

const ALIAS_RELATIONS = new Set(MEMORY_SSA_ALIAS_RELATIONS);

/*
 * Producer authority is a language-private brand, rather than a lookup in a
 * mutable WeakSet.  A WeakSet is easy to make look authoritative by replacing
 * WeakSet.prototype.has/add after this module is imported (or by retaining a
 * patched method and invoking it at the boundary).  A private field is checked
 * by the language itself: structured clones, proxies, copied payloads, and
 * objects from another module/realm do not carry this brand and cannot mint it.
 * The class is intentionally not exported; there is no registrar or token.
 */
class CanonicalMemorySsaArtifact {
  #producerBrand = true;

  constructor(payload) {
    for (const key of Object.keys(payload)) this[key] = payload[key];
  }

  static has(value) {
    return value !== null && typeof value === 'object' && #producerBrand in value;
  }
}

export function isCanonicalMemorySsaProducerArtifact(artifact) {
  return !Array.isArray(artifact) && CanonicalMemorySsaArtifact.has(artifact);
}

function fail(code) { throw new TypeError(code); }
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('memory-ssa-build-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function positiveInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}
function budgetLimit(options, key, fallback = MEMORY_SSA_BUILD_DEFAULT_BUDGET[key]) {
  if (options?.budget?.[key] == null) return fallback;
  return positiveInteger(options.budget[key], `memory-ssa-build-invalid-budget-${key}`);
}
function createCounter(options, key) {
  const maximum = budgetLimit(options, key);
  let used = 0;
  return () => {
    assertNotAborted(options);
    if (++used > maximum) fail(`memory-ssa-build-budget-exceeded-${key}`);
  };
}
function entityId(prefix, payload) {
  return `${prefix}_${stableDigest({ version: MEMORY_SSA_BUILD_VERSION, ...payload })}`;
}

function memoryInteger(value) {
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

function memoryRegionDomain(region) {
  if (!region || typeof region !== 'object') return null;
  const identity = { kind: region.kind };
  let hasScope = false;
  for (const key of ['binaryId', 'functionId', 'rootEntityId', 'addressSpace', 'rootIdentity']) {
    if (region[key] == null) continue;
    identity[key] = key === 'rootIdentity' ? region[key] : String(region[key]);
    hasScope = true;
  }
  return hasScope ? stableStringify(identity) : null;
}

function memoryRegionBase(region) {
  if (!region || typeof region !== 'object') return null;
  if (region.address != null) return memoryInteger(region.address);
  if (region.offset != null) return memoryInteger(region.offset);
  return null;
}

function memoryRegionByteRange(region) {
  const widthBits = Number(region?.widthBits);
  const base = memoryRegionBase(region);
  if (!Number.isSafeInteger(widthBits) || widthBits <= 0 || widthBits % 8 !== 0 || base == null) return null;
  const domain = memoryRegionDomain(region);
  if (domain == null) return null;
  return {
    domain,
    start: base,
    end: base + BigInt(widthBits / 8),
  };
}

function memoryDescriptorDisplacement(node) {
  const machineEffects = node?.attributes?.machineEffects;
  const raw = machineEffects?.operationMetadata?.addressing?.addressDisplacement
    ?? machineEffects?.bundleMetadata?.addressing?.addressDisplacement;
  return raw == null ? 0n : memoryInteger(raw);
}

function memoryAccessDisplacement(region, node) {
  if (region?.metadata?.canonicalAddressIncludesOperationDisplacement === true) return 0n;
  return memoryDescriptorDisplacement(node);
}

function memoryAddressExpr(memory) {
  if (memory?.addressExpr && typeof memory.addressExpr === 'object'
      && !Array.isArray(memory.addressExpr)) return memory.addressExpr;
  if (memory?.addressValueId != null && String(memory.addressValueId).trim()) {
    return { valueId: String(memory.addressValueId) };
  }
  return null;
}

function memoryByteRange(region, memory, node) {
  const widthBits = Number(memory?.widthBits);
  if (!Number.isSafeInteger(widthBits) || widthBits <= 0 || widthBits % 8 !== 0) return null;
  const domain = memoryRegionDomain(region);
  const base = memoryRegionBase(region);
  const displacement = memoryAccessDisplacement(region, node);
  if (domain == null || base == null || displacement == null) return null;
  const start = base + displacement;
  return {
    domain,
    start: start.toString(),
    end: (start + BigInt(widthBits / 8)).toString(),
  };
}
function memoryRangeProof(memorySsaEntityId, sourceEntityId, regionId, range, memory, node, region = null) {
  if (range == null) return null;
  const rawAddressExpr = memoryAddressExpr(memory);
  if (!rawAddressExpr || typeof rawAddressExpr !== 'object' || Array.isArray(rawAddressExpr)) return null;
  const addressExpr = jsonSafe(rawAddressExpr);
  const addressValueId = addressExpr.valueId == null ? null : String(addressExpr.valueId);
  const addressDigest = stableDigest(addressExpr);
  const displacement = memoryAccessDisplacement(region, node);
  return {
    kind: 'canonical-memory-byte-range',
    version: MEMORY_SSA_PROOF_VERSION,
    memorySsaEntityId,
    sourceEntityId,
    regionId,
    range,
    addressValueId,
    addressDigest,
    addressExpr: jsonSafe(addressExpr),
    addressSpace: memory.addressSpace,
    addressDisplacement: displacement == null ? null : displacement.toString(),
    widthBits: Number(memory.widthBits),
    endian: memory.endian,
    rangeDigest: stableDigest({
      range: {
        domain: String(range.domain),
        start: String(range.start),
        end: String(range.end),
      },
      addressValueId,
      addressDigest,
      addressDisplacement: displacement == null ? null : displacement.toString(),
      widthBits: Number(memory.widthBits),
      endian: memory.endian,
    }),
  };
}

function canonicalStackNoEscapeProof(identity, functionId, useId, nodeId, regionId) {
  const identityDigest = stableDigest(identity ?? null);
  const proof = {
    kind: 'canonical-memory-stack-no-escape',
    version: MEMORY_SSA_PROOF_VERSION,
    functionId: String(functionId),
    useId: String(useId),
    nodeId: String(nodeId),
    regionId: String(regionId),
    identityDigest,
    evidence: {
      source: 'canonical-semantic-stack-root',
      root: 'aapcs64-sp',
      scope: 'function-local-stack',
    },
  };
  return {
    ...proof,
    proofDigest: stableDigest(proof),
  };
}
function transformOrigin(origin, { ruleId, consumedEntityIds, producedEntityIds, proofKind }) {
  return appendTransform(origin, createTransformRecord({
    passId: 'semantic-memoryssa',
    passVersion: MEMORY_SSA_BUILD_VERSION,
    ruleId,
    consumedEntityIds,
    producedEntityIds,
    preconditions: [],
    proofKind,
  }));
}
function functionAndCfgMatch(irFunction, cfg) {
  if (!irFunction || typeof irFunction !== 'object') fail('memory-ssa-build-ir-required');
  if (!cfg || typeof cfg !== 'object') fail('memory-ssa-build-cfg-required');
  if (String(irFunction.functionId) !== String(cfg.functionId)) fail('memory-ssa-build-function-mismatch');
}
function nodeOrder(irFunction, cfg, options) {
  const nodeById = new Map(irFunction.nodes.map((node) => [node.id, node]));
  const blockById = new Map(irFunction.blocks.map((block) => [block.id, block]));
  const ordered = [];
  for (const blockId of deterministicTraversal(cfg, { signal: options.signal, includeUnreachable: true })) {
    const block = blockById.get(blockId);
    if (!block) fail('memory-ssa-build-cfg-ir-block-mismatch');
    for (const nodeId of block.nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) fail('memory-ssa-build-dangling-node');
      ordered.push(node);
    }
  }
  return ordered;
}
function defaultUnknownRegion(functionId) {
  return createMemoryRegionRef({
    id: entityId('memoryregion', { functionId, kind: 'default-unknown' }),
    kind: 'unknown',
    functionId,
    uncertaintyIdentity: { source: 'generic-memoryssa-default' },
    metadata: { precision: 'conservative-default' },
  });
}
function normalizeResolution(raw, fallback) {
  const values = raw == null ? [fallback] : Array.isArray(raw) ? raw : [raw];
  const regions = [];
  for (const value of values) {
    if (value == null) continue;
    const candidate = value && typeof value === 'object' && value.region ? value.region : value;
    regions.push(createMemoryRegionRef(candidate));
  }
  if (!regions.length) regions.push(fallback);
  const byId = new Map();
  for (const region of regions) {
    const prior = byId.get(region.id);
    if (prior && stableStringify(prior) !== stableStringify(region)) fail('memory-ssa-build-conflicting-region-id');
    byId.set(region.id, region);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function callResolver(resolver, memory, context, fallback) {
  if (typeof resolver !== 'function') return [fallback];
  const value = resolver(memory, context);
  if (value && typeof value.then === 'function') fail('memory-ssa-build-async-region-resolver-unsupported');
  return normalizeResolution(value, fallback);
}
function normalizeAliasResult(raw) {
  const relation = typeof raw === 'string' ? raw : raw?.relation ?? raw?.aliasRelation;
  if (relation != null && typeof relation !== 'string') fail('memory-ssa-build-invalid-alias-relation');
  const normalized = relation ?? 'unknown';
  if (!ALIAS_RELATIONS.has(normalized)) fail('memory-ssa-build-invalid-alias-relation');
  const proof = raw && typeof raw === 'object' && !Array.isArray(raw)
    && raw.proof && typeof raw.proof === 'object' && !Array.isArray(raw.proof)
    ? jsonSafe(raw.proof)
    : null;
  return {
    relation: normalized,
    reasonCodes: raw && typeof raw === 'object' && Array.isArray(raw.reasonCodes)
      ? raw.reasonCodes.map(String).sort() : [],
    evidenceIds: raw && typeof raw === 'object' && Array.isArray(raw.evidenceIds)
      ? raw.evidenceIds.map(String).sort() : [],
    proof,
  };
}
function combineAliasResults(results) {
  if (!results.length) return { relation: 'unknown', proof: null };
  const relations = results.map((result) => result.relation);
  let relation;
  if (relations.every((value) => value === 'no')) relation = 'no';
  else if (relations.every((value) => value === 'must')) relation = 'must';
  else if (relations.includes('unknown')) relation = 'unknown';
  else relation = 'may';
  return {
    relation,
    reasonCodes: [...new Set(results.flatMap((result) => result.reasonCodes ?? []))].sort(),
    evidenceIds: [...new Set(results.flatMap((result) => result.evidenceIds ?? []))].sort(),
    proof: jsonSafe({ alternatives: results.map((result) => ({ relation: result.relation, proof: result.proof })) }),
  };
}

function disjointRangeReason(leftRegion, rightRegion) {
  const kinds = new Set([leftRegion?.kind, rightRegion?.kind]);
  if (kinds.size === 1 && kinds.has('stack-fixed')) return 'disjoint-stack-interval';
  if (kinds.size === 1 && kinds.has('global-absolute')) return 'disjoint-global-interval';
  if (kinds.size === 1 && kinds.has('rooted-offset')) return 'disjoint-field-interval';
  if (kinds.has('stack-fixed') && (kinds.has('global-absolute') || kinds.has('rooted-offset'))) {
    return 'distinct-proven-root';
  }
  return null;
}

function rangeDisjointAlias(descriptor, sourceRegion, targetRegion, relation, purpose, identity, functionId) {
  // Region identity is the canonical storage root.  For a non-identical
  // precise region, however, an instruction displacement can place the
  // actual access wholly outside that root's interval.  Refine only this
  // positive, independently computed byte-range fact; unknown/broad regions
  // remain conservative and an identity (`must`) answer is never weakened.
  if (relation?.relation === 'must' || !descriptor?.memory || descriptor.broad) return relation;
  const sourceBase = memoryRegionBase(sourceRegion);
  const sourceWidthBits = Number(descriptor.memory.widthBits);
  const sourceDomain = memoryRegionDomain(sourceRegion);
  const targetRange = memoryRegionByteRange(targetRegion);
  if (sourceBase == null || sourceDomain == null || !targetRange
      || sourceDomain !== targetRange.domain
      || !Number.isSafeInteger(sourceWidthBits) || sourceWidthBits <= 0 || sourceWidthBits % 8 !== 0) {
    return relation;
  }
  const displacement = memoryAccessDisplacement(sourceRegion, descriptor.node);
  if (displacement == null) return relation;
  const sourceStart = sourceBase + displacement;
  const sourceEnd = sourceStart + BigInt(sourceWidthBits / 8);
  if (!(sourceEnd <= targetRange.start || targetRange.end <= sourceStart)) return relation;
  const reason = disjointRangeReason(sourceRegion, targetRegion);
  if (reason == null) return relation;
  const reasonCodes = [reason];
  const evidenceIds = ['canonical-memory-byte-range-disjoint'];
  const provider = {
    analyzerId: 'phase7.alias.a1-region',
    analyzerVersion: '1.0.0',
    completeness: 'complete',
    stopReason: null,
    relation: 'no',
    reasonCodes,
    evidenceIds,
  };
  const proof = canonicalAliasProof({
    result: { relation: 'no', reasonCodes, evidenceIds, proof: provider },
    identity,
    functionId,
    leftRegionId: sourceRegion.id,
    rightRegionId: targetRegion.id,
    sourceEntityIds: [descriptor.node?.id],
    purpose,
  });
  return {
    relation: 'no',
    reasonCodes,
    evidenceIds,
    proof,
  };
}
function scopeNeedsBroadAccess(node, summary) {
  return node.kind === 'call' && summary.completeness !== 'complete';
}
function memoryUnknown(node) {
  if (node.kind === 'unknown-memory-effect') return true;
  if (node.kind !== 'incomplete') return false;
  return (node.unknown?.categories ?? []).some((category) => String(category).toLowerCase().includes('memory'))
    || (node.unknown?.missing ?? []).some((category) => String(category).toLowerCase().includes('memory'));
}
function descriptorKey(node, role, sourceKind, index, suffix = '') {
  return `${node.id}\u0000${role}\u0000${sourceKind}\u0000${index}\u0000${suffix}`;
}
function makeDescriptor(node, role, sourceKind, index, memory, extra = {}) {
  return {
    key: descriptorKey(node, role, sourceKind, index, extra.suffix ?? ''),
    node,
    role,
    sourceKind,
    index,
    memory,
    broad: Boolean(extra.broad),
    scope: extra.scope ?? null,
    summary: extra.summary ?? null,
    regions: [],
  };
}

/*
 * A complete call summary may still have an unknown/all memory write scope.
 * A caller-local stack region is nevertheless safe across that call when the
 * canonical Semantic IR contains no stack-derived argument. Keep this proof
 * in the producer: compatibility consumers must not reconstruct it by walking
 * projected legacy instructions (the removed private stack-flow fallback did
 * exactly that). The walk follows only canonical value definitions and the
 * machine address expression metadata emitted by the Semantic IR builder.
 */
function expressionContainsStackRegister(expression, active = new Set()) {
  if (!expression || typeof expression !== 'object' || active.has(expression)) return false;
  active.add(expression);
  const kind = String(expression.kind ?? '').toLowerCase();
  const role = String(expression.role ?? expression.storageRole ?? '').toLowerCase();
  const registerId = String(expression.physicalId ?? expression.registerId ?? expression.name ?? '').toLowerCase();
  if (kind === 'register' && (role === 'stack-pointer' || role === 'frame-pointer' || registerId === 'sp' || registerId === 'fp' || registerId.endsWith('_sp') || registerId.endsWith('_fp'))) {
    active.delete(expression);
    return true;
  }
  for (const value of Object.values(expression)) {
    if (expressionContainsStackRegister(value, active)) {
      active.delete(expression);
      return true;
    }
  }
  active.delete(expression);
  return false;
}

function stackDerivedValueIds(irFunction) {
  const valuesById = new Map((irFunction.values ?? []).map((value) => [String(value.id), value]));
  const nodesById = new Map((irFunction.nodes ?? []).map((node) => [String(node.id), node]));
  const memo = new Map();
  const active = new Set();
  const derives = (valueId) => {
    const id = String(valueId ?? '');
    if (!id) return false;
    if (memo.has(id)) return memo.get(id);
    if (active.has(id)) return false;
    active.add(id);
    const value = valuesById.get(id);
    const machineValue = value?.metadata?.machineValue;
    let result = expressionContainsStackRegister(machineValue);
    result = result || expressionContainsStackRegister(value?.metadata?.machineAddressExpression);
    const definition = value?.definitionNodeId == null
      ? null : nodesById.get(String(value.definitionNodeId));
    if (!result && definition?.variable?.physicalIdentity) {
      const registerId = definition.variable.physicalIdentity.registerId;
      result = ['sp', 'x29', 'fp'].includes(String(registerId ?? '').toLowerCase());
    }
    if (!result && Array.isArray(definition?.inputs)) {
      result = definition.inputs.some((input) => derives(input));
    }
    active.delete(id);
    memo.set(id, result);
    return result;
  };
  return {
    derives,
    nodeHasStackDerivedArgument: (node) => [
      ...(node?.inputs ?? []),
      ...(node?.call?.targetValueIds ?? []),
      ...(node?.call?.arguments ?? []),
      ...(node?.call?.memoryRead?.accesses ?? []).map((access) => access.addressExpr?.valueId),
      ...(node?.call?.memoryWrite?.accesses ?? []).map((access) => access.addressExpr?.valueId),
      ...(node?.intrinsic?.inputs ?? []),
      ...(node?.intrinsic?.memoryRead?.accesses ?? []).map((access) => access.addressExpr?.valueId),
      ...(node?.intrinsic?.memoryWrite?.accesses ?? []).map((access) => access.addressExpr?.valueId),
    ].some((input) => derives(input)),
  };
}

function callMayExposeStackAddress(node, orderedNodes, irFunction, stackValues) {
  if (node?.kind !== 'call') return false;
  const explicitArguments = [
    ...(node.call?.arguments ?? []),
    ...(node.call?.memoryRead?.accesses ?? []).map((access) => access.addressExpr?.valueId),
    ...(node.call?.memoryWrite?.accesses ?? []).map((access) => access.addressExpr?.valueId),
  ];
  if (explicitArguments.some((valueId) => stackValues.derives(valueId))) return true;
  const valuesById = new Map((irFunction.values ?? []).map((value) => [String(value.id), value]));
  const nodeIndex = new Map(orderedNodes.map((candidate, index) => [String(candidate.id), index]));
  const callIndex = nodeIndex.get(String(node.id));
  if (callIndex == null) return true;
  // A canonical call summary may omit ABI arguments.  Recover only the
  // current x0..x7 definitions from canonical Semantic IR + scalar SSA
  // state-write nodes; this is still producer evidence, not a projected
  // instruction walk.  An unknown argument conservatively prevents the
  // no-escape claim as well.
  const seenRegisters = new Set();
  for (let index = callIndex - 1; index >= 0 && seenRegisters.size < 8; index--) {
    const candidate = orderedNodes[index];
    if (candidate?.kind !== 'state-write') continue;
    const registerId = candidate.variable?.physicalIdentity?.registerId;
    const match = String(registerId ?? '').toLowerCase().match(/^(?:x|w)([0-7])$/);
    if (!match) continue;
    const register = `x${match[1]}`;
    if (seenRegisters.has(register)) continue;
    seenRegisters.add(register);
    const valueId = candidate.inputs?.[0];
    const value = valuesById.get(String(valueId));
    if (stackValues.derives(valueId)
        || value == null
        || value.kind === 'unknown'
        || value.kind === 'undef'
        || nodesByIdForStack(irFunction).get(String(value.definitionNodeId))?.completeness !== 'complete') return true;
  }
  return false;
}

function nodesByIdForStack(irFunction) {
  return new Map((irFunction.nodes ?? []).map((node) => [String(node.id), node]));
}

function discoverDescriptors(irFunction, cfg, options, fallbackRegion, orderedNodes = null) {
  const descriptors = [];
  const readsByNode = new Map();
  const writesByNode = new Map();
  const add = (descriptor) => {
    descriptors.push(descriptor);
    const target = descriptor.role === 'read' ? readsByNode : writesByNode;
    if (!target.has(descriptor.node.id)) target.set(descriptor.node.id, []);
    target.get(descriptor.node.id).push(descriptor);
  };
  const addSummaryScope = (node, summary, scope, role, sourceKind) => {
    const forceBroad = scopeNeedsBroadAccess(node, summary);
    if (forceBroad || scope.scope === 'all' || scope.scope === 'unknown') {
      add(makeDescriptor(node, role, sourceKind, 0, null, { broad: true, scope, summary, suffix: forceBroad ? 'incomplete-call' : scope.scope }));
      return;
    }
    if (scope.scope !== 'accesses') return;
    scope.accesses.forEach((memory, index) => add(makeDescriptor(node, role, sourceKind, index, memory, { scope, summary })));
  };

  const nodes = orderedNodes ?? nodeOrder(irFunction, cfg, options);
  for (const node of nodes) {
    if (node.kind === 'load') add(makeDescriptor(node, 'read', 'load', 0, node.memory));
    if (node.kind === 'store') add(makeDescriptor(node, 'write', 'store', 0, node.memory));
    if (node.kind === 'call') {
      addSummaryScope(node, node.call, node.call.memoryRead, 'read', 'call');
      addSummaryScope(node, node.call, node.call.memoryWrite, 'write', 'call');
    }
    if (node.kind === 'intrinsic') {
      addSummaryScope(node, node.intrinsic, node.intrinsic.memoryRead, 'read', 'intrinsic');
      addSummaryScope(node, node.intrinsic, node.intrinsic.memoryWrite, 'write', 'intrinsic');
    }
    if (memoryUnknown(node)) {
      add(makeDescriptor(node, 'read', 'unknown-memory-effect', 0, null, { broad: true, suffix: 'unknown-read' }));
      add(makeDescriptor(node, 'write', 'unknown-memory-effect', 0, null, { broad: true, suffix: 'unknown-write' }));
    } else if (node.completeness !== 'complete'
      && node.kind === 'store'
      && (node.unknown?.categories ?? []).some((category) => String(category).toLowerCase().includes('memory'))) {
      add(makeDescriptor(node, 'write', 'unknown-memory-effect', 1, null, { broad: true, suffix: 'partial-store' }));
    }
  }

  const stackValues = stackDerivedValueIds(irFunction);
  for (const descriptor of descriptors) {
    if (descriptor.role === 'write' && descriptor.broad
        && (descriptor.sourceKind === 'call'
          || (descriptor.sourceKind === 'unknown-memory-effect' && descriptor.node?.kind === 'call'))
        && !stackValues.nodeHasStackDerivedArgument(descriptor.node)
        && !callMayExposeStackAddress(descriptor.node, nodes, irFunction, stackValues)) {
      descriptor.noEscapeStack = true;
    }
  }

  for (const descriptor of descriptors) {
    assertNotAborted(options);
    if (descriptor.broad) {
      descriptor.regions = [fallbackRegion];
      continue;
    }
    descriptor.regions = callResolver(options.resolveRegion, descriptor.memory, {
      function: irFunction,
      cfg,
      node: descriptor.node,
      role: descriptor.role,
      sourceKind: descriptor.sourceKind,
      accessIndex: descriptor.index,
      signal: options.signal,
    }, fallbackRegion);
  }
  return { descriptors, readsByNode, writesByNode };
}
function addRegion(regionById, region) {
  const normalized = createMemoryRegionRef(region);
  const prior = regionById.get(normalized.id);
  if (prior && stableStringify(prior) !== stableStringify(normalized)) fail('memory-ssa-build-conflicting-region-id');
  regionById.set(normalized.id, normalized);
}
function unreachableRoots(cfg, options) {
  const reachable = new Set(reachableBlocks(cfg, cfg.entryBlockId, { signal: options.signal }));
  const unreachable = cfg.blocks.map((block) => block.id).filter((id) => !reachable.has(id)).sort();
  const unreachableSet = new Set(unreachable);
  const byId = new Map(cfg.blocks.map((block) => [block.id, block]));
  const roots = new Set([cfg.entryBlockId]);
  const seen = new Set();
  for (const seed of unreachable) {
    if (seen.has(seed)) continue;
    roots.add(seed);
    const stack = [seed];
    seen.add(seed);
    while (stack.length) {
      const id = stack.pop();
      const block = byId.get(id);
      const neighbors = [
        ...block.predecessors,
        ...block.successors.map((edge) => edge.to),
      ].filter((value) => unreachableSet.has(value)).sort().reverse();
      for (const next of neighbors) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return roots;
}
function mapEqual(left, right, regionIds) {
  if (!left || !right) return false;
  return regionIds.every((regionId) => left.get(regionId) === right.get(regionId));
}
function cloneState(state) { return new Map(state); }
function blockStateArray(blockId, state) {
  return {
    blockId,
    regions: [...state.entries()]
      .map(([regionId, definitionId]) => ({ regionId, definitionId }))
      .sort((a, b) => a.regionId.localeCompare(b.regionId)),
  };
}
function effectSummary(descriptor, relation) {
  const memory = descriptor.memory == null ? null : jsonSafe(descriptor.memory);
  const sequencing = descriptor.memory == null ? null : jsonSafe({
    volatility: descriptor.memory.volatility,
    atomic: descriptor.memory.atomic,
    ordering: descriptor.memory.ordering,
    alignment: descriptor.memory.alignment,
  });
  const out = {
    sourceKind: descriptor.sourceKind,
    role: descriptor.role,
    accessIndex: descriptor.index,
    broad: descriptor.broad,
    relation,
    memory,
    sequencing,
    ...(descriptor.noEscapeStack === true ? { noEscapeStack: true } : {}),
  };
  if (descriptor.scope != null) out.memoryScope = jsonSafe(descriptor.scope);
  if (descriptor.summary != null) {
    if (descriptor.sourceKind === 'call') {
      out.summarySource = descriptor.summary.summarySource;
      out.completeness = descriptor.summary.completeness;
    } else {
      out.determinism = descriptor.summary.determinism;
    }
  }
  return jsonSafe(out);
}
function memoryAccessProof(descriptor, options, identity) {
  const raw = typeof options?.accessProofForDescriptor === 'function'
    ? options.accessProofForDescriptor(descriptor)
    : null;
  return canonicalAccessProof({
    raw,
    descriptor,
    identity,
    functionId: identity?.functionId ?? descriptor?.node?.functionId ?? null,
  });
}

function canonicalConstantValue(semanticValue) {
  const raw = semanticValue?.metadata?.constant ?? null;
  if (raw?.kind !== 'bitvector' || raw.value == null) return null;
  const widthBits = Number(raw.widthBits ?? semanticValue?.machineType?.widthBits);
  if (!Number.isSafeInteger(widthBits) || widthBits <= 0 || widthBits % 8 !== 0) return null;
  const value = memoryInteger(raw.value);
  if (value == null) return null;
  const unsigned = BigInt.asUintN(widthBits, value);
  const signed = BigInt.asIntN(widthBits, value);
  if (value !== unsigned && value !== signed) return null;
  return { value: unsigned, widthBits, semanticValue };
}

/*
 * A memory store often receives a register view (for example the 32-bit
 * `w8` view of a 64-bit `x8` constant), so the store operand itself is not a
 * literal Semantic IR value.  Resolve only canonical scalar-SSA edges and
 * simple width-preserving projections.  This is deliberately a producer-side
 * proof: the compatibility layer must not infer a value from projected
 * instructions or recreate a second data-flow engine.
 */
function canonicalScalarConstant(valueId, valuesById, nodesById, scalarSsa, active = new Set()) {
  const id = String(valueId ?? '');
  if (!id || active.has(id)) return null;
  active.add(id);
  const semanticValue = valuesById.get(id) ?? null;
  const direct = canonicalConstantValue(semanticValue);
  if (direct) {
    active.delete(id);
    return direct;
  }
  const definition = nodesById?.get?.(String(semanticValue?.definitionNodeId)) ?? null;
  if (!definition) {
    active.delete(id);
    return null;
  }
  if (definition.kind === 'state-read') {
    const scalarUse = scalarSsa?.uses?.find((use) => String(use.sourceEntityId) === String(definition.id)
      && use.proof?.kind === 'renamed-use') ?? null;
    const scalarDefinition = scalarUse == null ? null : scalarSsa?.definitions?.find((candidate) =>
      String(candidate.valueId) === String(scalarUse.valueId)
      && candidate.kind === 'definition'
      && candidate.proof?.kind === 'renamed-definition') ?? null;
    const sourceSemanticValueId = scalarDefinition?.proof?.sourceSemanticValueId ?? null;
    const source = sourceSemanticValueId == null ? null : valuesById.get(String(sourceSemanticValueId));
    const sourceConstant = source == null ? null
      : canonicalScalarConstant(source.id, valuesById, nodesById, scalarSsa, active);
    if (sourceConstant) {
      active.delete(id);
      return {
        ...sourceConstant,
        scalarSsaUseId: scalarUse.useId,
        scalarSsaDefinitionId: scalarDefinition.definitionId,
        scalarSsaDigest: null,
      };
    }
    active.delete(id);
    return null;
  }
  const projectionKinds = new Set(['trunc', 'truncate', 'zext', 'zero-extend', 'sext', 'sign-extend', 'extend', 'copy', 'move', 'bitcast', 'identity']);
  if (!projectionKinds.has(String(definition.kind).toLowerCase()) || !Array.isArray(definition.inputs)
      || definition.inputs.length !== 1) {
    active.delete(id);
    return null;
  }
  const input = canonicalScalarConstant(definition.inputs[0], valuesById, nodesById, scalarSsa, active);
  if (!input) {
    active.delete(id);
    return null;
  }
  const outputWidth = Number(semanticValue?.machineType?.widthBits);
  if (!Number.isSafeInteger(outputWidth) || outputWidth <= 0 || outputWidth % 8 !== 0) {
    active.delete(id);
    return null;
  }
  let value = input.value;
  const kind = String(definition.kind).toLowerCase();
  if (kind === 'sext' || kind === 'sign-extend') value = BigInt.asIntN(input.widthBits, value);
  value = BigInt.asUintN(outputWidth, value);
  active.delete(id);
  return { ...input, value, widthBits: outputWidth };
}

function canonicalStoreOperand(node, valuesById, identity, functionId, memorySsaEntityId, scalarSsa = null, nodesById = null) {
  if (node?.kind !== 'store' || !Array.isArray(node.inputs) || node.inputs.length !== 2) return null;
  const addressValueId = memoryAddressExpr(node.memory)?.valueId ?? null;
  if (addressValueId == null || String(node.inputs[0]) !== String(addressValueId)) return null;
  const valueId = node.inputs[1];
  const semanticValue = valuesById.get(String(valueId)) ?? null;
  const widthBits = Number(node.memory?.widthBits);
  if (!Number.isSafeInteger(widthBits) || widthBits <= 0 || widthBits % 8 !== 0 || !semanticValue) return null;
  if (semanticValue.machineType?.kind === 'address') {
    if (Number(semanticValue.machineType?.widthBits) !== widthBits) return null;
    return canonicalStoreValueProof({
      semanticValue,
      memorySsaEntityId,
      valueId,
      sourceEntityId: node.id,
      value: null,
      widthBits,
      identity,
      functionId,
    });
  }
  if (semanticValue.machineType?.kind !== 'bitvector'
      || Number(semanticValue.machineType?.widthBits) !== widthBits) return null;
  const resolved = canonicalScalarConstant(valueId, valuesById, nodesById, scalarSsa);
  if (!resolved || resolved.widthBits !== widthBits) return null;
  return canonicalStoreValueProof({
    semanticValue,
    memorySsaEntityId,
    valueId,
    sourceEntityId: node.id,
    value: resolved.value,
    widthBits,
    identity,
    functionId,
    ...(resolved.semanticValue?.id === semanticValue.id ? {} : {
      resolvedSemanticValue: resolved.semanticValue,
      resolvedValueId: resolved.semanticValue.id,
      scalarSsaDefinitionId: resolved.scalarSsaDefinitionId,
      scalarSsaUseId: resolved.scalarSsaUseId,
      scalarSsaDigest: identity?.scalarSsaDigest ?? resolved.scalarSsaDigest,
    }),
  });
}
function eventKind(descriptor, relation) {
  if (descriptor.sourceKind === 'call') return 'call-clobber';
  if (descriptor.sourceKind === 'intrinsic') return 'intrinsic-clobber';
  if (descriptor.sourceKind === 'unknown-memory-effect') return 'unknown-clobber';
  if (relation === 'must') return 'memory-def';
  if (relation === 'may') return 'may-alias-clobber';
  return 'unknown-clobber';
}
function definitionRelation(kind, relation) {
  if (kind === 'unknown-clobber') return 'unknown';
  return relation;
}

export function buildMemorySsa(irFunction, cfg, options = {}) {
  assertNotAborted(options);
  functionAndCfgMatch(irFunction, cfg);
  const tick = createCounter(options, 'maxWorkItems');
  const aliasTick = createCounter(options, 'maxAliasQueries');
  const fallbackRegion = defaultUnknownRegion(irFunction.functionId);
  const orderedNodes = nodeOrder(irFunction, cfg, options);
  const { descriptors, readsByNode, writesByNode } = discoverDescriptors(irFunction, cfg, options, fallbackRegion, orderedNodes);
  const stackValues = stackDerivedValueIds(irFunction);
  const nodeOrderById = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const semanticValueById = new Map((irFunction.values ?? []).map((value) => [String(value.id), value]));

  const regionById = new Map();
  for (const region of options.regions ?? []) addRegion(regionById, region);
  for (const descriptor of descriptors) for (const region of descriptor.regions) addRegion(regionById, region);
  // The address root can remain the ABI stack pointer across a call while its
  // post-call SSA value has a distinct identity. If canonical address proof
  // still establishes that root, reuse the already discovered fixed-stack
  // region for the access so the producer's MemorySSA chain remains precise.
  // This is an IR/value proof, not a compatibility-layer instruction walk.
  const stackRegionBySlot = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.sourceKind !== 'load' && descriptor.sourceKind !== 'store') continue;
    const displacement = memoryDescriptorDisplacement(descriptor.node);
    const widthBits = Number(descriptor.memory?.widthBits);
    if (displacement == null || !Number.isSafeInteger(widthBits) || widthBits <= 0) continue;
    for (const region of descriptor.regions ?? []) {
      if (region.kind !== 'stack-fixed') continue;
      stackRegionBySlot.set(`${displacement.toString()}\u0000${widthBits}`, region);
    }
  }
  for (const descriptor of descriptors) {
    if (descriptor.sourceKind !== 'load' && descriptor.sourceKind !== 'store') continue;
    const addressValueId = descriptor.memory?.addressExpr?.valueId;
    if (addressValueId == null || !stackValues.derives(addressValueId)) continue;
    const displacement = memoryDescriptorDisplacement(descriptor.node);
    if (displacement == null) continue;
    const widthBits = Number(descriptor.memory?.widthBits);
    const stackRegion = stackRegionBySlot.get(`${displacement.toString()}\u0000${widthBits}`)
      ?? [...regionById.values()].find((region) => {
        if (region.kind !== 'stack-fixed') return false;
        try { return BigInt(region.offset) === displacement; }
        catch { return false; }
      });
    if (stackRegion) {
      descriptor.regions = [stackRegion];
      // The ARM64 memory-effect decoder intentionally leaves qualifiers
      // unknown until a higher-level region proves ordinary function-local
      // storage. A fixed stack root is that canonical proof: this access is
      // neither volatile nor atomic, while ordering remains the decoder's
      // explicit (and still conservative) value.
      if (descriptor.memory?.volatility === 'unknown' && descriptor.memory?.atomic === 'unknown') {
        descriptor.memory = {
          ...descriptor.memory,
          volatility: false,
          atomic: false,
        };
      }
    }
  }
  if (!regionById.size) addRegion(regionById, fallbackRegion);
  if (regionById.size > budgetLimit(options, 'maxRegions')) fail('memory-ssa-build-budget-exceeded-maxRegions');
  const regions = [...regionById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const regionIds = regions.map((region) => region.id);
  // The serialized identity describes the canonical build, but is not an
  // authority for publication. The exact artifact object is bound privately
  // below; copying or re-signing its fields cannot copy that binding.
  const identity = deepFreeze(jsonSafe(options.identity ?? {
    functionId: irFunction.functionId,
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: MEMORY_SSA_BUILD_VERSION,
  }));

  // The ARM64 Semantic IR access provider is the canonical producer for the
  // decoder's intentionally-unknown ordinary-access qualifiers. Normalize the
  // descriptor before publishing metadata so the proof and its sequencing
  // witness describe the same current access. No arbitrary callback may close
  // this gap: only the canonical ARM64 family/provider shape is accepted.
  for (const descriptor of descriptors) {
    if (!descriptor.memory || descriptor.memory.addressSpace !== 'memory') continue;
    const proof = memoryAccessProof(descriptor, options, identity);
    if (!proof
        || proof.volatility !== false || proof.atomic !== false
        || (proof.ordering != null && proof.ordering !== 'unknown')) continue;
    descriptor.memory = {
      ...descriptor.memory,
      volatility: false,
      atomic: false,
      ordering: descriptor.memory.ordering ?? 'unknown',
    };
  }

  const aliasCache = new Map();
  const queryAlias = (left, right, purpose) => {
    const key = `${left.key}\u0000${right.key}\u0000${purpose}`;
    if (aliasCache.has(key)) return aliasCache.get(key);
    aliasTick();
    let raw = null;
    if (typeof options.querySpecialAlias === 'function') {
      raw = options.querySpecialAlias(left.region, right.region, {
        function: irFunction,
        cfg,
        left,
        right,
        purpose,
        signal: options.signal,
        ssa: options.ssa ?? null,
        rootDescriptorProvider: options.rootDescriptorProvider ?? null,
      });
      if (raw && typeof raw.then === 'function') fail('memory-ssa-build-async-special-alias-query-unsupported');
    }
    if (raw == null && typeof options.queryAlias === 'function') {
      raw = options.queryAlias(left.region, right.region, {
        function: irFunction,
        cfg,
        left,
        right,
        purpose,
        signal: options.signal,
        ssa: options.ssa ?? null,
        rootDescriptorProvider: options.rootDescriptorProvider ?? null,
      });
      if (raw && typeof raw.then === 'function') fail('memory-ssa-build-async-alias-query-unsupported');
    }
    if (raw == null) raw = 'unknown';
    const result = normalizeAliasResult(raw);
    const canonicalProof = canonicalAliasProof({
      result,
      identity,
      functionId: irFunction.functionId,
      leftRegionId: left?.region?.id,
      rightRegionId: right?.region?.id,
      sourceEntityIds: [left?.descriptor?.node?.id, right?.descriptor?.node?.id],
      purpose,
    });
    result.proof = canonicalProof;
    aliasCache.set(key, result);
    return result;
  };
  const descriptorToRegionAlias = (descriptor, targetRegion, purpose) => combineAliasResults(
    descriptor.regions.map((sourceRegion) => {
      const queried = queryAlias(
        { key: `${descriptor.key}\u0000${sourceRegion.id}`, region: sourceRegion, descriptor },
        { key: `region\u0000${targetRegion.id}`, region: targetRegion, descriptor: null },
        purpose,
      );
      return rangeDisjointAlias(
        descriptor,
        sourceRegion,
        targetRegion,
        queried,
        purpose,
        identity,
        irFunction.functionId,
      );
    }),
  );
  const descriptorAlias = (leftDescriptor, rightDescriptor, purpose) => {
    const results = [];
    for (const leftRegion of leftDescriptor.regions) {
      for (const rightRegion of rightDescriptor.regions) {
        results.push(queryAlias(
          { key: `${leftDescriptor.key}\u0000${leftRegion.id}`, region: leftRegion, descriptor: leftDescriptor },
          { key: `${rightDescriptor.key}\u0000${rightRegion.id}`, region: rightRegion, descriptor: rightDescriptor },
          purpose,
        ));
      }
    }
    return combineAliasResults(results);
  };

  const eventsByNode = new Map();
  const eventById = new Map();
  for (const node of orderedNodes) {
    const writes = writesByNode.get(node.id) ?? [];
    for (const descriptor of writes) {
      for (const region of regions) {
        if (descriptor.noEscapeStack && region.kind === 'stack-fixed') continue;
        tick();
        const alias = descriptorToRegionAlias(descriptor, region, 'write-region-impact');
        if (alias.relation === 'no') continue;
        const kind = eventKind(descriptor, alias.relation);
        const id = entityId('memdef', {
          functionId: irFunction.functionId,
          nodeId: node.id,
          descriptorKey: descriptor.key,
          regionId: region.id,
          kind,
          relation: definitionRelation(kind, alias.relation),
        });
        const event = {
          id,
          kind,
          regionId: region.id,
          blockId: node.blockId,
          descriptor,
          aliasRelation: definitionRelation(kind, alias.relation),
          aliasProof: alias.proof,
        };
        if (!eventsByNode.has(node.id)) eventsByNode.set(node.id, []);
        eventsByNode.get(node.id).push(event);
        eventById.set(id, event);
      }
    }
  }
  for (const events of eventsByNode.values()) {
    events.sort((a, b) => a.descriptor.index - b.descriptor.index
      || a.descriptor.key.localeCompare(b.descriptor.key)
      || a.regionId.localeCompare(b.regionId)
      || a.id.localeCompare(b.id));
  }

  const entryDefinitionIds = new Map(regionIds.map((regionId) => [
    regionId,
    entityId('memdef', { functionId: irFunction.functionId, regionId, kind: 'entry' }),
  ]));
  const phiId = (blockId, regionId) => entityId('memphi', {
    functionId: irFunction.functionId,
    blockId,
    regionId,
  });
  const cfgBlockById = new Map(cfg.blocks.map((block) => [block.id, block]));
  const irBlockById = new Map(irFunction.blocks.map((block) => [block.id, block]));
  const traversal = deterministicTraversal(cfg, { signal: options.signal, includeUnreachable: true });
  const syntheticRoots = unreachableRoots(cfg, options);
  const initialState = new Map(entryDefinitionIds);
  const inStateByBlock = new Map();
  const outStateByBlock = new Map(cfg.blocks.map((block) => [block.id, cloneState(initialState)]));

  const mergeBlockState = (blockId) => {
    const block = cfgBlockById.get(blockId);
    const state = new Map();
    for (const regionId of regionIds) {
      tick();
      const candidates = block.predecessors.map((pred) => outStateByBlock.get(pred)?.get(regionId) ?? entryDefinitionIds.get(regionId));
      if (syntheticRoots.has(blockId)) candidates.push(entryDefinitionIds.get(regionId));
      if (!candidates.length) candidates.push(entryDefinitionIds.get(regionId));
      const unique = [...new Set(candidates)];
      state.set(regionId, unique.length === 1 ? unique[0] : phiId(blockId, regionId));
    }
    return state;
  };
  const applyBlockEvents = (blockId, input) => {
    const state = cloneState(input);
    const irBlock = irBlockById.get(blockId);
    for (const nodeId of irBlock.nodeIds) {
      for (const event of eventsByNode.get(nodeId) ?? []) {
        tick();
        state.set(event.regionId, event.id);
      }
    }
    return state;
  };

  const maxRounds = budgetLimit(options, 'maxRounds', Math.max(32, cfg.blocks.length * 4 + 16));
  let converged = false;
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (const blockId of traversal) {
      tick();
      const input = mergeBlockState(blockId);
      const output = applyBlockEvents(blockId, input);
      inStateByBlock.set(blockId, input);
      if (!mapEqual(outStateByBlock.get(blockId), output, regionIds)) {
        outStateByBlock.set(blockId, output);
        changed = true;
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  if (!converged) fail('memory-ssa-build-did-not-converge');
  for (const blockId of traversal) inStateByBlock.set(blockId, mergeBlockState(blockId));

  const definitions = [];
  const definitionById = new Map();
  const addDefinition = (definition) => {
    if (definitionById.has(definition.id)) return;
    definitionById.set(definition.id, definition);
    definitions.push(definition);
  };
  for (const region of regions) {
    const id = entryDefinitionIds.get(region.id);
    addDefinition({
      id,
      kind: 'entry',
      regionId: region.id,
      blockId: cfg.entryBlockId,
      previousDefinitionIds: [],
      incoming: [],
      aliasRelation: null,
      sourceEntityId: irFunction.functionId,
      origin: transformOrigin(irFunction.origin, {
        ruleId: 'initial-memory-version',
        consumedEntityIds: [irFunction.functionId],
        producedEntityIds: [id],
        proofKind: 'initial-memory-version',
      }),
      proof: { kind: 'initial-memory-version' },
    });
  }
  for (const blockId of traversal) {
    const block = cfgBlockById.get(blockId);
    for (const regionId of regionIds) {
      const expectedPhiId = phiId(blockId, regionId);
      if (inStateByBlock.get(blockId).get(regionId) !== expectedPhiId) continue;
      const incoming = block.predecessors.map((pred) => ({
        predecessorBlockId: pred,
        definitionId: outStateByBlock.get(pred).get(regionId),
      }));
      const previousDefinitionIds = syntheticRoots.has(blockId) ? [entryDefinitionIds.get(regionId)] : [];
      const baseOrigin = irBlockById.get(blockId)?.origin ?? irFunction.origin;
      addDefinition({
        id: expectedPhiId,
        kind: 'memory-phi',
        regionId,
        blockId,
        previousDefinitionIds,
        incoming,
        aliasRelation: null,
        sourceEntityId: blockId,
        origin: transformOrigin(baseOrigin, {
          ruleId: 'memory-merge',
          consumedEntityIds: [...previousDefinitionIds, ...incoming.map((item) => item.definitionId)],
          producedEntityIds: [expectedPhiId],
          proofKind: 'cfg-memory-merge',
        }),
        proof: { kind: 'cfg-memory-merge', syntheticEntry: syntheticRoots.has(blockId) },
      });
    }
  }
  for (const blockId of traversal) {
    const state = cloneState(inStateByBlock.get(blockId));
    const block = irBlockById.get(blockId);
    for (const nodeId of block.nodeIds) {
      for (const event of eventsByNode.get(nodeId) ?? []) {
        const prior = state.get(event.regionId);
        const id = event.id;
        addDefinition({
          id,
          kind: event.kind,
          regionId: event.regionId,
          blockId,
          previousDefinitionIds: prior == null ? [] : [prior],
          incoming: [],
          aliasRelation: event.aliasRelation,
          sourceEntityId: event.descriptor.node.id,
          origin: transformOrigin(event.descriptor.node.origin, {
            ruleId: event.kind,
            consumedEntityIds: [event.descriptor.node.id, ...(prior == null ? [] : [prior])],
            producedEntityIds: [id],
            proofKind: event.kind === 'memory-def' ? 'must-alias-memory-write' : 'conservative-memory-clobber',
          }),
          effectSummary: effectSummary(event.descriptor, event.aliasRelation),
          proof: {
            kind: event.kind === 'memory-def' ? 'must-alias-memory-write' : 'conservative-memory-clobber',
            version: MEMORY_SSA_PROOF_VERSION,
            aliasRelation: event.aliasRelation,
            providerProof: event.aliasProof,
          },
        });
        state.set(event.regionId, id);
      }
    }
  }

  if (definitions.length > budgetLimit(options, 'maxDefinitions')) fail('memory-ssa-build-budget-exceeded-maxDefinitions');

  const sourceDescriptorByDefinitionId = new Map([...eventById.entries()].map(([id, event]) => [id, event.descriptor]));
  const reachingForRead = (readDescriptor, startDefinitionId) => {
    let definitionId = startDefinitionId;
    const visited = new Set();
    while (definitionId != null) {
      tick();
      if (visited.has(definitionId)) return { definitionId, relation: 'unknown' };
      visited.add(definitionId);
      const definition = definitionById.get(definitionId);
      if (!definition) fail('memory-ssa-build-missing-definition');
      const sourceDescriptor = sourceDescriptorByDefinitionId.get(definitionId);
      if (!sourceDescriptor) return { definitionId, relation: 'unknown' };
      const alias = descriptorAlias(readDescriptor, sourceDescriptor, 'read-reaches-write');
      if (alias.relation !== 'no') return { definitionId, relation: alias.relation, proof: alias.proof };
      if (definition.previousDefinitionIds.length !== 1) return { definitionId, relation: 'unknown', proof: alias.proof };
      definitionId = definition.previousDefinitionIds[0];
    }
    fail('memory-ssa-build-read-without-initial-definition');
  };

  const uses = [];
  const accessMetadata = [];
  const byteCoverageInputs = [];
  for (const blockId of traversal) {
    const state = cloneState(inStateByBlock.get(blockId));
    const block = irBlockById.get(blockId);
    for (const nodeId of block.nodeIds) {
      const nodeReads = readsByNode.get(nodeId) ?? [];
      for (const descriptor of nodeReads) {
        const targets = descriptor.broad ? regions : descriptor.regions;
        const uniqueTargets = [...new Map(targets.map((region) => [region.id, region])).values()].sort((a, b) => a.id.localeCompare(b.id));
        for (const region of uniqueTargets) {
          tick();
          const reaching = reachingForRead(descriptor, state.get(region.id));
          const id = entityId('memuse', {
            functionId: irFunction.functionId,
            nodeId,
            descriptorKey: descriptor.key,
            regionId: region.id,
          });
          uses.push({
            id,
            regionId: region.id,
            reachingDefinitionId: reaching.definitionId,
            aliasRelation: reaching.relation === 'no' ? 'unknown' : reaching.relation,
            blockId,
            sourceEntityId: descriptor.node.id,
            origin: transformOrigin(descriptor.node.origin, {
              ruleId: 'memory-use',
              consumedEntityIds: [descriptor.node.id, reaching.definitionId],
              producedEntityIds: [id],
              proofKind: 'memory-use-def-link',
            }),
          });
          if (descriptor.sourceKind === 'load') {
            byteCoverageInputs.push({
              useId: id,
              nodeId,
              regionId: region.id,
              descriptor,
              state: cloneState(state),
            });
          }
          accessMetadata.push({
            memorySsaEntityId: id,
            entityKind: 'use',
            nodeId,
            sourceEntityId: nodeId,
            regionId: region.id,
            sourceKind: descriptor.sourceKind,
            role: descriptor.role,
            accessIndex: descriptor.index,
            broad: descriptor.broad,
            memory: descriptor.memory == null ? null : jsonSafe(descriptor.memory),
            sequencing: descriptor.memory == null ? null : jsonSafe({
              volatility: descriptor.memory.volatility,
              atomic: descriptor.memory.atomic,
              ordering: descriptor.memory.ordering,
              alignment: descriptor.memory.alignment,
            }),
            aliasProof: reaching.proof ?? null,
            aliasRelation: reaching.relation === 'no' ? 'unknown' : reaching.relation,
            accessProof: memoryAccessProof(descriptor, options, identity),
            ...(descriptor.sourceKind === 'load' || descriptor.sourceKind === 'store'
              ? (() => {
                const canonicalValue = descriptor.role === 'write'
                  ? canonicalStoreOperand(descriptor.node, semanticValueById, identity, irFunction.functionId, id, options.ssa, new Map(irFunction.nodes.map((candidate) => [String(candidate.id), candidate])))
                  : null;
                return canonicalValue == null ? {} : { canonicalValue };
              })()
              : {}),
            origin: jsonSafe(descriptor.node.origin),
            byteRange: memoryByteRange(region, descriptor.memory, descriptor.node),
            rangeProof: memoryRangeProof(
              id,
              nodeId,
              region.id,
              memoryByteRange(region, descriptor.memory, descriptor.node),
              descriptor.memory,
              descriptor.node,
              region,
            ),
            order: nodeOrderById.get(nodeId) ?? null,
          });
        }
      }
      for (const event of eventsByNode.get(nodeId) ?? []) state.set(event.regionId, event.id);
    }
  }
  if (uses.length > budgetLimit(options, 'maxUses')) fail('memory-ssa-build-budget-exceeded-maxUses');

  for (const event of eventById.values()) {
    accessMetadata.push({
      memorySsaEntityId: event.id,
      entityKind: 'definition',
      nodeId: event.descriptor.node.id,
      sourceEntityId: event.descriptor.node.id,
      regionId: event.regionId,
      sourceKind: event.descriptor.sourceKind,
      role: event.descriptor.role,
      accessIndex: event.descriptor.index,
      broad: event.descriptor.broad,
      memory: event.descriptor.memory == null ? null : jsonSafe(event.descriptor.memory),
      sequencing: event.descriptor.memory == null ? null : jsonSafe({
        volatility: event.descriptor.memory.volatility,
        atomic: event.descriptor.memory.atomic,
        ordering: event.descriptor.memory.ordering,
        alignment: event.descriptor.memory.alignment,
      }),
      aliasProof: event.aliasProof,
      aliasRelation: event.aliasRelation,
      accessProof: memoryAccessProof(event.descriptor, options, identity),
      ...(event.descriptor.role === 'write'
        ? (() => {
          const canonicalValue = canonicalStoreOperand(
            event.descriptor.node,
            semanticValueById,
            identity,
            irFunction.functionId,
            event.id,
            options.ssa,
            new Map(irFunction.nodes.map((candidate) => [String(candidate.id), candidate])),
          );
          return canonicalValue == null ? {} : { canonicalValue };
        })()
        : {}),
      origin: jsonSafe(event.descriptor.node.origin),
      byteRange: memoryByteRange(regionById.get(event.regionId), event.descriptor.memory, event.descriptor.node),
      rangeProof: memoryRangeProof(
        event.id,
        event.descriptor.node.id,
        event.regionId,
        memoryByteRange(regionById.get(event.regionId), event.descriptor.memory, event.descriptor.node),
        event.descriptor.memory,
        event.descriptor.node,
        regionById.get(event.regionId),
      ),
      order: nodeOrderById.get(event.descriptor.node.id) ?? null,
    });
  }

  const definitionByIdForCoverage = new Map(definitions.map((definition) => [definition.id, definition]));
  const byteCoverage = byteCoverageInputs.map((input) => {
    const region = regionById.get(input.regionId) ?? null;
    const loadRange = memoryByteRange(region, input.descriptor.memory, input.descriptor.node);
    const regionAliases = regions.map((candidate) => {
      const alias = descriptorToRegionAlias(input.descriptor, candidate, 'load-byte-region');
      const stackRoot = input.descriptor.regions.some((region) => region.kind === 'stack-fixed');
      const hasConservativeStackWrite = descriptors.some((descriptor) => descriptor.role === 'write'
        && descriptor.regions.some((region) => region.id === candidate.id)
        && !(descriptor.sourceKind === 'call' && descriptor.noEscapeStack === true));
      if (stackRoot && candidate.kind === 'unknown' && !hasConservativeStackWrite) {
        return {
          regionId: candidate.id,
          aliasRelation: 'no',
          aliasProof: canonicalStackNoEscapeProof(
            identity,
            irFunction.functionId,
            input.useId,
            input.nodeId,
            candidate.id,
          ),
        };
      }
      return {
        regionId: candidate.id,
        aliasRelation: alias.relation,
        aliasProof: alias.proof,
      };
    });
    const regionStates = regionAliases.map((aliasState) => {
      if (aliasState.aliasRelation === 'no') return null;
      const candidate = regionById.get(aliasState.regionId);
      const definitionId = input.state.get(candidate.id) ?? null;
      const definition = definitionId == null ? null : definitionByIdForCoverage.get(definitionId);
      return {
        regionId: candidate.id,
        definitionId,
        order: definition?.sourceEntityId == null
          ? null
          : nodeOrderById.get(definition.sourceEntityId) ?? null,
        aliasRelation: aliasState.aliasRelation,
        aliasProof: aliasState.aliasProof,
      };
    }).filter(Boolean);
    const coverageProof = {
      kind: 'memoryssa-byte-state',
      version: MEMORY_SSA_PROOF_VERSION,
      buildVersion: MEMORY_SSA_BUILD_VERSION,
      functionId: irFunction.functionId,
      useId: input.useId,
      nodeId: input.nodeId,
      regionId: input.regionId,
      loadRange,
      identityDigest: stableDigest(identity),
    };
    return {
      useId: input.useId,
      nodeId: input.nodeId,
      regionId: input.regionId,
      loadRange,
      coverageState: loadRange != null && regionStates.every((item) => item.definitionId != null)
        ? 'complete'
        : 'partial',
      regionAliasStates: regionAliases,
      regionStates,
      proof: coverageProof,
    };
  });

  const contract = createMemorySsaContract({
    functionId: irFunction.functionId,
    regions,
    definitions,
    uses,
  }, { signal: options.signal, budget: options.budget, cfg });
  const useDefLinks = contract.reachingDefinitionLinks.map((link) => ({ ...link }));
  const useIdsByDefinition = new Map(contract.definitions.map((definition) => [definition.id, []]));
  for (const link of useDefLinks) useIdsByDefinition.get(link.definitionId).push(link.useId);
  const defUseLinks = [...useIdsByDefinition.entries()]
    .map(([definitionId, useIds]) => ({ definitionId, useIds: useIds.sort() }))
    .sort((a, b) => a.definitionId.localeCompare(b.definitionId));
  const blockStates = traversal.map((blockId) => ({
    blockId,
    entry: blockStateArray(blockId, inStateByBlock.get(blockId)).regions,
    exit: blockStateArray(blockId, outStateByBlock.get(blockId)).regions,
  }));

  accessMetadata.sort((a, b) => a.memorySsaEntityId.localeCompare(b.memorySsaEntityId)
    || a.regionId.localeCompare(b.regionId));
  const canonicalAccessBindings = accessMetadata
    .map((metadata) => canonicalAccessBinding(metadata))
    .sort((a, b) => a.memorySsaEntityId.localeCompare(b.memorySsaEntityId)
      || a.regionId.localeCompare(b.regionId));
  const artifact = {
    ...contract,
    buildVersion: MEMORY_SSA_BUILD_VERSION,
    completeness: irFunction.completeness,
    unknowns: jsonSafe(irFunction.unknowns ?? []),
    ...(identity == null ? {} : { identity }),
    canonicalIrIdentity: jsonSafe(options.canonicalIrIdentity ?? {
      functionId: irFunction.functionId,
      semanticIrDigest: identity?.semanticIrDigest ?? null,
    }),
    ...(options.snapshotId == null ? {} : { snapshotId: String(options.snapshotId) }),
    useDefLinks,
    defUseLinks,
    accessMetadata,
    canonicalAccessBindings,
    byteCoverage,
    blockStates,
  };
  const unpublished = {
    ...artifact,
    canonicalDigest: canonicalMemorySsaDigest(artifact),
  };
  const published = deepFreeze(new CanonicalMemorySsaArtifact(unpublished));
  return published;
}
