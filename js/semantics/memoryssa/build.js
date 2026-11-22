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
  MEMORY_SSA_CONTRACT_VERSION,
  MEMORY_SSA_DEFAULT_BUDGET,
  canonicalSnapshotId,
  createMemoryRegionRef,
  createMemorySsaContract,
} from './contract.js';
import {
  canonicalAccessProof,
  canonicalAccessBinding,
  canonicalAliasProof,
  bindMemorySsaProducerVerifier,
  canonicalIdentityDigest,
  canonicalMemorySsaDigest,
  registerPublishedMemorySsaCaches,
  canonicalStoreValueProof,
  isCanonicalAccessProvider,
  MEMORY_SSA_PROOF_VERSION,
} from './proof.js';

export const MEMORY_SSA_BUILD_VERSION = '1.0.2';
export const MEMORY_SSA_BUILD_DEFAULT_BUDGET = Object.freeze({
  ...MEMORY_SSA_DEFAULT_BUDGET,
  maxAliasQueries: 1048576,
  maxWorkItems: 4194304,
});

const ALIAS_RELATIONS = new Set(MEMORY_SSA_ALIAS_RELATIONS);
class CanonicalMemorySsaArtifact {
  #producerBrand = true;
  #semanticIrSource;
  #canonicalDigest;

  constructor(payload, semanticIrSource = null) {
    for (const key of Object.keys(payload)) this[key] = payload[key];
    this.#semanticIrSource = semanticIrSource;
    this.#canonicalDigest = typeof payload.canonicalDigest === 'string' ? payload.canonicalDigest : null;
    Object.setPrototypeOf(this, Object.prototype);
  }

  static has(value) {
    try {
      return value !== null && typeof value === 'object' && #producerBrand in value;
    } catch {
      return false;
    }
  }

  static matchesSemanticIr(value, ir) {
    try {
      return value !== null && typeof value === 'object' && #producerBrand in value
        && value.#semanticIrSource === ir;
    } catch {
      return false;
    }
  }

  static canonicalDigest(value) {
    try {
      return value !== null && typeof value === 'object' && #producerBrand in value
        ? value.#canonicalDigest : null;
    } catch {
      return null;
    }
  }
}

export function isCanonicalMemorySsaProducerArtifact(artifact) {
  return !Array.isArray(artifact) && CanonicalMemorySsaArtifact.has(artifact);
}
bindMemorySsaProducerVerifier(isCanonicalMemorySsaProducerArtifact);

export function canonicalMemorySsaProducerMatchesSemanticIr(artifact, ir) {
  return !Array.isArray(artifact) && CanonicalMemorySsaArtifact.matchesSemanticIr(artifact, ir);
}

export function canonicalMemorySsaProducerDigest(artifact) {
  return !Array.isArray(artifact) ? CanonicalMemorySsaArtifact.canonicalDigest(artifact) : null;
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

function canonicalStackNoEscapeProof(identity, functionId, useId, nodeId, regionId, precomputedIdentityDigest = null) {
  const identityDigest = precomputedIdentityDigest ?? stableDigest(identity ?? null);
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
      root: 'canonical-stack-root',
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
  const irFunctionId = irFunction.functionId;
  const cfgFunctionId = cfg.functionId;
  if (typeof irFunctionId !== 'string'
      || typeof cfgFunctionId !== 'string'
      || irFunctionId.length === 0
      || cfgFunctionId.length === 0
      || irFunctionId.trim() !== irFunctionId
      || cfgFunctionId.trim() !== cfgFunctionId
      || irFunctionId !== cfgFunctionId) {
    fail('memory-ssa-build-function-mismatch');
  }
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

function disjointIntervalReason(leftRegion, rightRegion) {
  const kinds = new Set([leftRegion?.kind, rightRegion?.kind].filter(Boolean));
  const isStack = [...kinds].some((k) => String(k).startsWith('stack'));
  const isGlobal = [...kinds].some((k) => String(k).startsWith('global'));
  const isField = [...kinds].some((k) => String(k).startsWith('rooted'));
  if (kinds.size === 1 && isStack) return 'disjoint-stack-interval';
  if (kinds.size === 1 && isGlobal) return 'disjoint-global-interval';
  if (kinds.size === 1 && isField) return 'disjoint-field-interval';
  if (isStack && (isGlobal || isField)) {
    return 'disjoint-storage-domains';
  }
  return 'disjoint-memory-ranges';
}

function rangeDisjointAlias(
  descriptor,
  sourceRegion,
  targetRegion,
  relation,
  purpose,
  identity,
  functionId,
  regionMetaById = null,
  skipProofIfNo = false,
) {
  // Region identity is the canonical storage root.  For a non-identical
  // precise region, however, an instruction displacement can place the
  // actual access wholly outside that root's interval.  Refine only this
  // positive, independently computed byte-range fact; unknown/broad regions
  // remain conservative and an identity (`must`) answer is never weakened.
  if (relation?.relation === 'must' || !descriptor?.memory || descriptor.broad) return relation;
  const sourceMeta = regionMetaById?.get(sourceRegion.id) ?? null;
  const targetMeta = regionMetaById?.get(targetRegion.id) ?? null;
  const sourceBase = sourceMeta ? sourceMeta.base : memoryRegionBase(sourceRegion);
  const sourceWidthBits = Number(descriptor.memory.widthBits);
  const sourceDomain = sourceMeta ? sourceMeta.domain : memoryRegionDomain(sourceRegion);
  const targetRange = targetMeta ? targetMeta.byteRange : memoryRegionByteRange(targetRegion);
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
  const reason = disjointIntervalReason(sourceRegion, targetRegion);
  if (reason == null) return relation;
  const reasonCodes = [reason];
  const evidenceIds = ['canonical-memory-byte-range-disjoint'];
  if (skipProofIfNo) {
    return {
      relation: 'no',
      reasonCodes,
      evidenceIds,
      proof: null,
    };
  }
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
/*
 * Canonical stack/frame pointer identities across the owned architectures.
 * The pre-existing heuristic spelled one target family's names; the x86-64 canonical
 * names are now recognized too (base pointer + stack pointer spellings with
 * their `r`-prefixed long forms). A stack-derived proof that misses an
 * architecture's canonical names silently drops unknown-call stack clobbers
 * for that target. Canonical register identity comes from the target
 * registers-core tables; this set only re-states the frame/stack root names
 * those tables already normalize.
 */
const STACK_POINTER_REGISTER_IDS = new Set(['sp', 'fp', 'x29', 'rsp', 'rbp']);
const STACK_POINTER_REGISTER_SUFFIXES = ['_sp', '_fp'];

/*
 * x86-64 ABI argument register slots (SysV order; Win64 is a subset). Slot
 * numbering is a dedup identity only; every recognized register independently
 * blocks the no-escape claim when its latest definition is unknown or
 * stack-derived. Names are matched by position index + register class so the
 * MemorySSA core stays free of architecture token tables: the accepted
 * spellings are exactly the six integer argument registers of the two owned
 * 64-bit ABIs, each mapping to its parameter slot.
 */
const X86_64_ARGUMENT_REGISTER_SLOTS = new Map([
  ['rdi', 'arg0'], ['rsi', 'arg1'], ['rdx', 'arg2'], ['rcx', 'arg3'], ['r8', 'arg4'], ['r9', 'arg5'],
]);

function expressionContainsStackRegister(expression, active = new Set()) {
  if (!expression || typeof expression !== 'object' || active.has(expression)) return false;
  active.add(expression);
  const kind = String(expression.kind ?? '').toLowerCase();
  const role = String(expression.role ?? expression.storageRole ?? '').toLowerCase();
  const registerId = String(expression.physicalId ?? expression.registerId ?? expression.name ?? '').toLowerCase();
  if (kind === 'register' && (role === 'stack-pointer' || role === 'frame-pointer' || STACK_POINTER_REGISTER_IDS.has(registerId) || STACK_POINTER_REGISTER_SUFFIXES.some((suffix) => registerId.endsWith(suffix)))) {
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
      result = STACK_POINTER_REGISTER_IDS.has(String(registerId ?? '').toLowerCase());
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
    valuesById,
    nodesById,
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

function argumentRegisterSlot(candidate) {
  if (candidate?.kind !== 'state-write') return null;
  const rawRegisterId = String(candidate.variable?.physicalIdentity?.registerId ?? '').toLowerCase();
  // legacy `argN`/`paramN`/`xN` spellings map to `argN`; x86-64 SysV
  // argument registers map to their positional slot. Unrecognized register
  // names never authorize a no-escape claim — they are skipped as
  // non-argument state so the conservative outcome survives.
  const slot = X86_64_ARGUMENT_REGISTER_SLOTS.get(rawRegisterId)
    ?? rawRegisterId.match(/^(?:arg|param|[a-z])([0-7])$/)?.[1];
  if (slot == null) return null;
  return typeof slot === 'string' && slot.startsWith('arg') ? slot : `arg${slot}`;
}

function stateWriteMayExposeStack(candidate, stackValues) {
  const valueId = candidate.inputs?.[0];
  const value = stackValues.valuesById.get(String(valueId));
  return stackValues.derives(valueId)
    || value == null
    || value.kind === 'unknown'
    || value.kind === 'undef'
    || stackValues.nodesById.get(String(value.definitionNodeId))?.completeness !== 'complete';
}

function buildStackEscapeCfgIndex(irFunction, cfg, stackValues) {
  const cfgBlockById = new Map((cfg?.blocks ?? []).map((block) => [String(block.id), block]));
  const irBlockById = new Map((irFunction?.blocks ?? []).map((block) => [String(block.id), block]));
  const lastArgWriteByBlock = new Map();
  const writtenArgRegisters = new Set();
  for (const block of irFunction?.blocks ?? []) {
    const blockId = String(block.id);
    const writes = new Map();
    for (const nodeId of block.nodeIds ?? []) {
      const candidate = stackValues.nodesById.get(String(nodeId));
      const register = argumentRegisterSlot(candidate);
      if (register == null) continue;
      writtenArgRegisters.add(register);
      writes.set(register, stateWriteMayExposeStack(candidate, stackValues));
    }
    if (writes.size > 0) lastArgWriteByBlock.set(blockId, writes);
  }
  return {
    cfgBlockById,
    irBlockById,
    lastArgWriteByBlock,
    writtenArgRegisters,
  };
}

function predecessorBlockClosure(startBlockId, cfgBlockById) {
  const visited = new Set();
  const stack = [...(cfgBlockById.get(startBlockId)?.predecessors ?? [])].map(String);
  while (stack.length > 0) {
    const blockId = stack.pop();
    if (visited.has(blockId)) continue;
    visited.add(blockId);
    const block = cfgBlockById.get(blockId);
    if (!block) continue;
    for (const pred of block.predecessors ?? []) {
      const predId = String(pred);
      if (!visited.has(predId)) stack.push(predId);
    }
  }
  return visited;
}

function callMayExposeStackAddress(node, stackValues, escapeCfgIndex) {
  if (node?.kind !== 'call') return false;
  const explicitArguments = [
    ...(node.call?.arguments ?? []),
    ...(node.call?.memoryRead?.accesses ?? []).map((access) => access.addressExpr?.valueId),
    ...(node.call?.memoryWrite?.accesses ?? []).map((access) => access.addressExpr?.valueId),
  ];
  if (explicitArguments.some((valueId) => stackValues.derives(valueId))) return true;
  if (escapeCfgIndex.writtenArgRegisters.size === 0) return false;
  const callBlockId = node.blockId == null ? null : String(node.blockId);
  const callCfgBlock = callBlockId == null ? null : escapeCfgIndex.cfgBlockById.get(callBlockId);
  const callIrBlock = callBlockId == null ? null : escapeCfgIndex.irBlockById.get(callBlockId);
  const callPos = callIrBlock?.nodeIds?.findIndex((id) => String(id) === String(node.id)) ?? -1;
  if (!callCfgBlock || !callIrBlock || callPos < 0) return true;
  // A canonical call summary may omit ABI arguments.  Recover only the
  // reaching argument definitions from canonical Semantic IR + scalar SSA
  // state-write nodes along CFG predecessors; this is still producer
  // evidence, not a projected instruction walk.  A non-stack overwrite only
  // kills earlier definitions on that path, never across sibling branches.
  const killedInCallBlock = new Set();
  for (let index = callPos - 1; index >= 0; index--) {
    const candidate = stackValues.nodesById.get(String(callIrBlock.nodeIds[index]));
    const register = argumentRegisterSlot(candidate);
    if (register == null || killedInCallBlock.has(register)) continue;
    killedInCallBlock.add(register);
    if (stateWriteMayExposeStack(candidate, stackValues)) return true;
  }
  for (const register of escapeCfgIndex.writtenArgRegisters) {
    if (killedInCallBlock.has(register)) continue;
    const visited = new Set();
    const stack = (callCfgBlock.predecessors ?? []).map(String);
    while (stack.length > 0) {
      const blockId = stack.pop();
      if (visited.has(blockId)) continue;
      visited.add(blockId);
      const blockWrites = escapeCfgIndex.lastArgWriteByBlock.get(blockId);
      if (blockWrites?.has(register)) {
        if (blockWrites.get(register)) return true;
        continue;
      }
      const block = escapeCfgIndex.cfgBlockById.get(blockId);
      if (!block) continue;
      for (const pred of block.predecessors ?? []) {
        const predId = String(pred);
        if (!visited.has(predId)) stack.push(predId);
      }
    }
  }
  return false;
}

function nodePublishesStackAddress(upstream, stackValues) {
  if (!upstream) return false;
  const stores = [
    ...(upstream.kind === 'store' ? [{ addressValueId: memoryAddressExpr(upstream.memory)?.valueId ?? upstream.inputs?.[0], storedValueId: upstream.inputs?.[1] }] : []),
    ...(upstream.intrinsic?.memoryWrite?.accesses ?? []).map((access) => ({
      addressValueId: access.addressExpr?.valueId,
      storedValueId: access.valueId ?? null,
    })),
  ];
  for (const store of stores) {
    const stored = store.storedValueId;
    if (stored == null || !stackValues.derives(stored)) continue;
    if (!stackValues.derives(store.addressValueId)) return true;
  }
  return false;
}

function stackAddressPublishedBeforeCall(node, stackValues, escapeCfgIndex) {
  const callBlockId = node?.blockId == null ? null : String(node.blockId);
  const callCfgBlock = callBlockId == null ? null : escapeCfgIndex.cfgBlockById.get(callBlockId);
  const callIrBlock = callBlockId == null ? null : escapeCfgIndex.irBlockById.get(callBlockId);
  const callPos = callIrBlock?.nodeIds?.findIndex((id) => String(id) === String(node.id)) ?? -1;
  if (!callCfgBlock || !callIrBlock || callPos < 0) return true;
  for (let index = 0; index < callPos; index++) {
    const upstream = stackValues.nodesById.get(String(callIrBlock.nodeIds[index]));
    if (nodePublishesStackAddress(upstream, stackValues)) return true;
  }
  const reachingPredecessors = predecessorBlockClosure(callBlockId, escapeCfgIndex.cfgBlockById);
  for (const blockId of reachingPredecessors) {
    const irBlock = escapeCfgIndex.irBlockById.get(blockId);
    if (!irBlock) continue;
    for (const nodeId of irBlock.nodeIds ?? []) {
      if (String(nodeId) === String(node.id)) continue;
      const upstream = stackValues.nodesById.get(String(nodeId));
      if (nodePublishesStackAddress(upstream, stackValues)) return true;
    }
  }
  return false;
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
  let escapeCfgIndex = null;
  const getEscapeCfgIndex = () => {
    if (escapeCfgIndex == null) escapeCfgIndex = buildStackEscapeCfgIndex(irFunction, cfg, stackValues);
    return escapeCfgIndex;
  };
  for (const descriptor of descriptors) {
    if (descriptor.role === 'write' && descriptor.broad
        && (descriptor.sourceKind === 'call'
          || (descriptor.sourceKind === 'unknown-memory-effect' && descriptor.node?.kind === 'call'))
        && !stackValues.nodeHasStackDerivedArgument(descriptor.node)
        && !callMayExposeStackAddress(descriptor.node, stackValues, getEscapeCfgIndex())
        && !stackAddressPublishedBeforeCall(descriptor.node, stackValues, getEscapeCfgIndex())) {
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
function unreachableComponents(cfg, options) {
  const reachable = new Set(reachableBlocks(cfg, cfg.entryBlockId, { signal: options.signal }));
  const unreachable = cfg.blocks.map((block) => block.id).filter((id) => !reachable.has(id)).sort();
  const unreachableSet = new Set(unreachable);
  const byId = new Map(cfg.blocks.map((block) => [block.id, block]));
  const roots = new Set([cfg.entryBlockId]);
  const componentSeedByBlock = new Map();
  const seen = new Set();
  for (const seed of unreachable) {
    if (seen.has(seed)) continue;
    roots.add(seed);
    const stack = [seed];
    seen.add(seed);
    componentSeedByBlock.set(seed, seed);
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
        componentSeedByBlock.set(next, seed);
        stack.push(next);
      }
    }
  }
  return Object.freeze({ roots, componentSeedByBlock });
}
function createIndexMinHeap() {
  const heap = [];
  const push = (value) => {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (heap[index] >= heap[parent]) break;
      const tmp = heap[index];
      heap[index] = heap[parent];
      heap[parent] = tmp;
      index = parent;
    }
  };
  const pop = () => {
    if (heap.length === 0) return -1;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heap[left] < heap[smallest]) smallest = left;
        if (right < heap.length && heap[right] < heap[smallest]) smallest = right;
        if (smallest === index) break;
        const tmp = heap[index];
        heap[index] = heap[smallest];
        heap[smallest] = tmp;
        index = smallest;
      }
    }
    return top;
  };
  return {
    push,
    pop,
    get size() { return heap.length; },
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
  const provider = options?.accessProofForDescriptor;
  const raw = isCanonicalAccessProvider(provider) ? provider(descriptor) : null;
  return canonicalAccessProof({
    raw,
    descriptor,
    identity,
    functionId: identity?.functionId ?? descriptor?.node?.functionId ?? null,
    providerCallback: provider,
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
 * narrowed view of a 64-bit constant), so the store operand itself is not a
 * literal Semantic IR value.  Resolve only canonical scalar-SSA edges and
 * simple width-preserving projections.  This is deliberately a producer-side
 * proof: the compatibility layer must not infer a value from projected
 * instructions or recreate a second data-flow engine.
 */
/*
 * Index scalar-SSA renamed uses by source entity and renamed definitions by
 * value id once per build so store-proof resolution does not rescan the full
 * arrays for every store (issue #8982).  The maps keep exactly the same
 * first-match-in-array-order and proof-kind predicates as the previous linear
 * `find` scans; they only make them O(1) per lookup.
 */
function buildScalarSsaIndex(scalarSsa) {
  const usesBySource = new Map();
  for (const use of scalarSsa?.uses ?? []) {
    if (use?.proof?.kind !== 'renamed-use') continue;
    const key = String(use.sourceEntityId);
    if (!usesBySource.has(key)) usesBySource.set(key, use);
  }
  const definitionsByValue = new Map();
  for (const definition of scalarSsa?.definitions ?? []) {
    if (definition?.kind !== 'definition' || definition?.proof?.kind !== 'renamed-definition') continue;
    const key = String(definition.valueId);
    if (!definitionsByValue.has(key)) definitionsByValue.set(key, definition);
  }
  return { usesBySource, definitionsByValue };
}

function canonicalScalarConstant(valueId, valuesById, nodesById, scalarSsa, active = new Set(), scalarIndex = null) {
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
    const index = scalarIndex ?? buildScalarSsaIndex(scalarSsa);
    const scalarUse = scalarSsa?.uses == null ? null : index.usesBySource.get(String(definition.id)) ?? null;
    const scalarDefinition = scalarUse == null || scalarSsa?.definitions == null ? null
      : index.definitionsByValue.get(String(scalarUse.valueId)) ?? null;
    const sourceSemanticValueId = scalarDefinition?.proof?.sourceSemanticValueId ?? null;
    const source = sourceSemanticValueId == null ? null : valuesById.get(String(sourceSemanticValueId));
    const sourceConstant = source == null ? null
      : canonicalScalarConstant(source.id, valuesById, nodesById, scalarSsa, active, scalarIndex ?? index);
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
  const input = canonicalScalarConstant(definition.inputs[0], valuesById, nodesById, scalarSsa, active, scalarIndex);
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

function canonicalStoreOperand(node, valuesById, identity, functionId, memorySsaEntityId, scalarSsa = null, nodesById = null, scalarIndex = null) {
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
  const resolved = canonicalScalarConstant(valueId, valuesById, nodesById, scalarSsa, new Set(), scalarIndex);
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
  const nodeOrderById = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const semanticValueById = new Map((irFunction.values ?? []).map((value) => [String(value.id), value]));
  const irNodeById = new Map((irFunction.nodes ?? []).map((candidate) => [String(candidate.id), candidate]));
  const scalarSsaIndex = options.ssa == null ? null : buildScalarSsaIndex(options.ssa);

  const regionById = new Map();
  for (const region of options.regions ?? []) addRegion(regionById, region);
  for (const descriptor of descriptors) for (const region of descriptor.regions) addRegion(regionById, region);
  // Region identity belongs to the canonical resolver. A stack-derived
  // value may have a different root, a dynamic offset, or lost provenance.
  // Borrowing a region from another access based on displacement/width alone
  // would issue a false must-alias/forwarding proof (#4388). Access qualifiers
  // are established independently by the canonical access provider below.
  if (!regionById.size) addRegion(regionById, fallbackRegion);
  if (regionById.size > budgetLimit(options, 'maxRegions')) fail('memory-ssa-build-budget-exceeded-maxRegions');
  const regions = [...regionById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const regionIds = regions.map((region) => region.id);
  // The serialized identity describes the canonical build, but is not an
  // authority for publication. The exact artifact object is bound privately
  // below; copying or re-signing its fields cannot copy that binding.
  // Snapshot provenance is validated before it is published or jsonSafe'd: the
  // identity block survives structured values, and a structured `snapshotId`
  // there would otherwise be re-coerced by every consumer that compares it
  // against the artifact (#8804).
  if (options.identity?.snapshotId != null) {
    canonicalSnapshotId(options.identity.snapshotId, 'memory-ssa-identity-snapshot-id-invalid');
  }
  const identity = deepFreeze(jsonSafe(options.identity ?? {
    functionId: irFunction.functionId,
    memorySsaBuildVersion: MEMORY_SSA_BUILD_VERSION,
    analyzerVersion: MEMORY_SSA_BUILD_VERSION,
  }));
  const identityDigest = canonicalIdentityDigest(identity);
  const accessProofCache = new Map();
  const cachedMemoryAccessProof = (descriptor) => {
    if (accessProofCache.has(descriptor)) return accessProofCache.get(descriptor);
    const proof = memoryAccessProof(descriptor, options, identity);
    accessProofCache.set(descriptor, proof);
    return proof;
  };

  // The Semantic IR access provider is the canonical producer for the
  // decoder's intentionally-unknown ordinary-access qualifiers. Normalize the
  // descriptor before publishing metadata so the proof and its sequencing
  // witness describe the same current access. No arbitrary callback may close
  // this gap: only the canonical family/provider shape is accepted.
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

  const regionMetaById = new Map(regions.map((region) => [region.id, {
    base: memoryRegionBase(region),
    domain: memoryRegionDomain(region),
    byteRange: memoryRegionByteRange(region),
  }]));
  const aliasCache = new Map();
  const queryAlias = (left, right, purpose, skipProofIfNo = false) => {
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
    if (skipProofIfNo && result.relation === 'no') {
      result.proof = null;
      return result;
    }
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
  const descriptorToRegionAlias = (descriptor, targetRegion, purpose) => {
    const skipProofIfNo = purpose === 'write-region-impact' && descriptor.regions.length === 1;
    if (skipProofIfNo) {
      const sourceRegion = descriptor.regions[0];
      const queried = queryAlias(
        { key: `${descriptor.key}\u0000${sourceRegion.id}`, region: sourceRegion, descriptor },
        { key: `region\u0000${targetRegion.id}`, region: targetRegion, descriptor: null },
        purpose,
        true,
      );
      if (queried.relation === 'no') return queried;
      const refined = rangeDisjointAlias(
        descriptor,
        sourceRegion,
        targetRegion,
        queried,
        purpose,
        identity,
        irFunction.functionId,
        regionMetaById,
        true,
      );
      if (refined.relation === 'no') return refined;
      return combineAliasResults([refined]);
    }
    return combineAliasResults(
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
          regionMetaById,
        );
      }),
    );
  };
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
        if (descriptor.noEscapeStack && String(region.kind).startsWith('stack')) continue;
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
  const unreachableInfo = unreachableComponents(cfg, options);
  const syntheticRoots = unreachableInfo.roots;
  const componentSeedByBlock = unreachableInfo.componentSeedByBlock;
  const componentSeeds = [...new Set(componentSeedByBlock.values())].sort();
  const unreachableEntryDefinitionIds = new Map(componentSeeds.map((componentSeed) => [
    componentSeed,
    new Map(regionIds.map((regionId) => [
      regionId,
      entityId('memdef', {
        functionId: irFunction.functionId,
        regionId,
        blockId: componentSeed,
        kind: 'unreachable-entry',
      }),
    ])),
  ]));
  const seedDefinitionIdFor = (blockId, regionId) => {
    const componentSeed = componentSeedByBlock.get(blockId);
    return componentSeed == null
      ? entryDefinitionIds.get(regionId)
      : unreachableEntryDefinitionIds.get(componentSeed).get(regionId);
  };
  const blockCount = traversal.length;
  const regionCount = regionIds.length;
  const blockIndexById = new Map(traversal.map((blockId, index) => [blockId, index]));
  const regionIndexById = new Map(regionIds.map((regionId, index) => [regionId, index]));
  const predIndices = traversal.map((blockId) => cfgBlockById.get(blockId).predecessors.map((pred) => blockIndexById.get(pred)));
  const succSets = Array.from({ length: blockCount }, () => new Set());
  for (let b = 0; b < blockCount; b += 1) {
    const preds = predIndices[b];
    for (let p = 0; p < preds.length; p += 1) {
      const predIdx = preds[p];
      if (predIdx != null) succSets[predIdx].add(b);
    }
  }
  const succIndices = succSets.map((set) => [...set].sort((a, b) => a - b));
  const isSyntheticRoot = new Uint8Array(blockCount);
  const blockComponentSeed = new Array(blockCount);
  for (let b = 0; b < blockCount; b += 1) {
    const blockId = traversal[b];
    isSyntheticRoot[b] = syntheticRoots.has(blockId) ? 1 : 0;
    blockComponentSeed[b] = componentSeedByBlock.get(blockId) ?? null;
  }
  const hasUnreachableComponents = componentSeeds.length > 0;
  const blockWritesByRegion = Array.from({ length: regionCount }, () => new Map());
  for (let b = 0; b < blockCount; b += 1) {
    const irBlock = irBlockById.get(traversal[b]);
    for (const nodeId of irBlock.nodeIds) {
      for (const event of eventsByNode.get(nodeId) ?? []) {
        tick();
        blockWritesByRegion[regionIndexById.get(event.regionId)].set(b, event.id);
      }
    }
  }
  const seedDefForIndex = (bIdx, rIdx) => {
    const componentSeed = blockComponentSeed[bIdx];
    const regionId = regionIds[rIdx];
    return componentSeed == null
      ? entryDefinitionIds.get(regionId)
      : unreachableEntryDefinitionIds.get(componentSeed).get(regionId);
  };

  const maxRounds = budgetLimit(options, 'maxRounds', Math.max(32, cfg.blocks.length * 4 + 16));
  const regionInDefs = new Array(regionCount).fill(null);
  const regionOutDefs = new Array(regionCount).fill(null);
  const phiRegionsByBlock = Array.from({ length: blockCount }, () => []);
  const inCurrent = new Uint8Array(blockCount);
  const inNext = new Uint8Array(blockCount);
  const currentHeap = createIndexMinHeap();

  for (let rIdx = 0; rIdx < regionCount; rIdx += 1) {
    const regionId = regionIds[rIdx];
    const writes = blockWritesByRegion[rIdx];
    if (writes.size === 0 && !hasUnreachableComponents) continue;
    const inDefs = new Array(blockCount);
    const outDefs = new Array(blockCount);
    for (let b = 0; b < blockCount; b += 1) {
      const seed = seedDefForIndex(b, rIdx);
      inDefs[b] = seed;
      outDefs[b] = seed;
    }
    for (const b of writes.keys()) {
      if (!inCurrent[b]) {
        inCurrent[b] = 1;
        currentHeap.push(b);
      }
    }
    if (hasUnreachableComponents) {
      for (let b = 0; b < blockCount; b += 1) {
        if (inCurrent[b]) continue;
        const seed = outDefs[b];
        const preds = predIndices[b];
        for (let p = 0; p < preds.length; p += 1) {
          if (outDefs[preds[p]] !== seed) {
            inCurrent[b] = 1;
            currentHeap.push(b);
            break;
          }
        }
      }
    }
    if (currentHeap.size > 0) {
      let converged = false;
      let nextDirty = [];
      for (let round = 0; round < maxRounds; round += 1) {
        let roundChanged = false;
        while (currentHeap.size > 0) {
          const b = currentHeap.pop();
          inCurrent[b] = 0;
          tick();
          const preds = predIndices[b];
          let firstVal = null;
          let hasMultiple = false;
          for (let p = 0; p < preds.length; p += 1) {
            const val = outDefs[preds[p]];
            if (firstVal === null) firstVal = val;
            else if (val !== firstVal) {
              hasMultiple = true;
              break;
            }
          }
          if (!hasMultiple && (isSyntheticRoot[b] || preds.length === 0)) {
            const seed = seedDefForIndex(b, rIdx);
            if (firstVal === null) firstVal = seed;
            else if (seed !== firstVal) hasMultiple = true;
          }
          const merged = hasMultiple ? phiId(traversal[b], regionId) : firstVal;
          inDefs[b] = merged;
          const nextOut = writes.get(b) ?? merged;
          if (nextOut !== outDefs[b]) {
            outDefs[b] = nextOut;
            roundChanged = true;
            const succs = succIndices[b];
            for (let s = 0; s < succs.length; s += 1) {
              const succ = succs[s];
              if (succ > b) {
                if (!inCurrent[succ]) {
                  inCurrent[succ] = 1;
                  currentHeap.push(succ);
                }
              } else if (!inNext[succ]) {
                inNext[succ] = 1;
                nextDirty.push(succ);
              }
            }
          }
        }
        if (!roundChanged || nextDirty.length === 0) {
          converged = true;
          break;
        }
        for (let i = 0; i < nextDirty.length; i += 1) {
          const idx = nextDirty[i];
          inNext[idx] = 0;
          if (!inCurrent[idx]) {
            inCurrent[idx] = 1;
            currentHeap.push(idx);
          }
        }
        nextDirty = [];
      }
      if (!converged) fail('memory-ssa-build-did-not-converge');
    }
    regionInDefs[rIdx] = inDefs;
    regionOutDefs[rIdx] = outDefs;
    for (let b = 0; b < blockCount; b += 1) {
      if (inDefs[b] === phiId(traversal[b], regionId)) {
        phiRegionsByBlock[b].push(rIdx);
      }
    }
  }
  const getInDef = (bIdx, rIdx) => (regionInDefs[rIdx] ? regionInDefs[rIdx][bIdx] : seedDefForIndex(bIdx, rIdx));
  const getOutDef = (bIdx, rIdx) => (regionOutDefs[rIdx] ? regionOutDefs[rIdx][bIdx] : seedDefForIndex(bIdx, rIdx));

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
      // This is boundary memory, not an instruction in the CFG entry block.
      // It also seeds unreachable roots, which the live entry cannot dominate.
      // Keep real writes and phis pinned to their actual defining blocks.
      blockId: null,
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
  for (const region of regions) {
    for (const componentSeed of componentSeeds) {
      const id = unreachableEntryDefinitionIds.get(componentSeed).get(region.id);
      addDefinition({
        id,
        kind: 'entry',
        regionId: region.id,
        blockId: null,
        previousDefinitionIds: [],
        incoming: [],
        aliasRelation: null,
        sourceEntityId: irFunction.functionId,
        origin: transformOrigin(irFunction.origin, {
          ruleId: 'unreachable-initial-memory-version',
          consumedEntityIds: [irFunction.functionId, componentSeed],
          producedEntityIds: [id],
          proofKind: 'unreachable-initial-memory-version',
        }),
        proof: { kind: 'unreachable-initial-memory-version', seedBlockId: componentSeed },
      });
    }
  }
  for (let bIdx = 0; bIdx < blockCount; bIdx += 1) {
    const blockId = traversal[bIdx];
    const block = cfgBlockById.get(blockId);
    const phiRegions = phiRegionsByBlock[bIdx];
    for (let p = 0; p < phiRegions.length; p += 1) {
      const rIdx = phiRegions[p];
      const regionId = regionIds[rIdx];
      const expectedPhiId = phiId(blockId, regionId);
      const incoming = block.predecessors.map((pred) => ({
        predecessorBlockId: pred,
        definitionId: getOutDef(blockIndexById.get(pred), rIdx),
      }));
      const previousDefinitionIds = isSyntheticRoot[bIdx]
        ? [seedDefForIndex(bIdx, rIdx)]
        : [];
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
        proof: { kind: 'cfg-memory-merge', syntheticEntry: Boolean(isSyntheticRoot[bIdx]) },
      });
    }
  }
  for (let bIdx = 0; bIdx < blockCount; bIdx += 1) {
    const blockId = traversal[bIdx];
    const blockOverrides = new Map();
    const block = irBlockById.get(blockId);
    for (const nodeId of block.nodeIds) {
      for (const event of eventsByNode.get(nodeId) ?? []) {
        const prior = blockOverrides.has(event.regionId)
          ? blockOverrides.get(event.regionId)
          : getInDef(bIdx, regionIndexById.get(event.regionId));
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
        blockOverrides.set(event.regionId, id);
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

  const conservativeWriteRegionIds = new Set();
  for (let i = 0; i < descriptors.length; i += 1) {
    const descriptor = descriptors[i];
    if (descriptor.role !== 'write') continue;
    if ((descriptor.sourceKind === 'call'
        || (descriptor.sourceKind === 'unknown-memory-effect' && descriptor.node?.kind === 'call'))
      && descriptor.noEscapeStack === true) continue;
    for (let j = 0; j < descriptor.regions.length; j += 1) {
      conservativeWriteRegionIds.add(descriptor.regions[j].id);
    }
  }

  const maxUsesBudget = budgetLimit(options, 'maxUses');
  const uses = [];
  const accessMetadata = [];
  const byteCoverage = [];
  for (let bIdx = 0; bIdx < blockCount; bIdx += 1) {
    const blockId = traversal[bIdx];
    const blockOverrides = new Map();
    const currentDefForRegion = (regionId) => (blockOverrides.has(regionId)
      ? blockOverrides.get(regionId)
      : getInDef(bIdx, regionIndexById.get(regionId)));
    const block = irBlockById.get(blockId);
    for (const nodeId of block.nodeIds) {
      const nodeReads = readsByNode.get(nodeId) ?? [];
      for (const descriptor of nodeReads) {
        const targets = descriptor.broad ? regions : descriptor.regions;
        const uniqueTargets = [...new Map(targets.map((region) => [region.id, region])).values()].sort((a, b) => a.id.localeCompare(b.id));
        for (const region of uniqueTargets) {
          tick();
          const reaching = reachingForRead(descriptor, currentDefForRegion(region.id));
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
          if (uses.length > maxUsesBudget) fail('memory-ssa-build-budget-exceeded-maxUses');
          const byteRange = memoryByteRange(region, descriptor.memory, descriptor.node);
          if (descriptor.sourceKind === 'load') {
            const stackRoot = descriptor.regions.some((r) => String(r.kind).startsWith('stack'));
            const regionAliases = new Array(regionCount);
            const regionStates = [];
            for (let rIdx = 0; rIdx < regionCount; rIdx += 1) {
              const candidate = regions[rIdx];
              let aliasState;
              if (stackRoot && candidate.kind === 'unknown' && !conservativeWriteRegionIds.has(candidate.id)) {
                aliasState = {
                  regionId: candidate.id,
                  aliasRelation: 'no',
                  aliasProof: canonicalStackNoEscapeProof(
                    identity,
                    irFunction.functionId,
                    id,
                    nodeId,
                    candidate.id,
                    identityDigest,
                  ),
                };
              } else {
                const alias = descriptorToRegionAlias(descriptor, candidate, 'load-byte-region');
                aliasState = {
                  regionId: candidate.id,
                  aliasRelation: alias.relation,
                  aliasProof: alias.proof,
                };
              }
              regionAliases[rIdx] = aliasState;
              if (aliasState.aliasRelation !== 'no') {
                const definitionId = currentDefForRegion(candidate.id) ?? null;
                const definition = definitionId == null ? null : definitionById.get(definitionId);
                regionStates.push({
                  regionId: candidate.id,
                  definitionId,
                  order: definition?.sourceEntityId == null
                    ? null
                    : nodeOrderById.get(definition.sourceEntityId) ?? null,
                  aliasRelation: aliasState.aliasRelation,
                  aliasProof: aliasState.aliasProof,
                });
              }
            }
            const coverageProof = {
              kind: 'memoryssa-byte-state',
              version: MEMORY_SSA_PROOF_VERSION,
              buildVersion: MEMORY_SSA_BUILD_VERSION,
              functionId: irFunction.functionId,
              useId: id,
              nodeId,
              regionId: region.id,
              loadRange: byteRange,
              identityDigest,
            };
            byteCoverage.push({
              useId: id,
              nodeId,
              regionId: region.id,
              loadRange: byteRange,
              coverageState: byteRange != null && regionStates.every((item) => item.definitionId != null)
                ? 'complete'
                : 'partial',
              regionAliasStates: regionAliases,
              regionStates,
              proof: coverageProof,
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
            accessProof: cachedMemoryAccessProof(descriptor),
            ...(descriptor.sourceKind === 'load' || descriptor.sourceKind === 'store'
              ? (() => {
                const canonicalValue = descriptor.role === 'write'
                  ? canonicalStoreOperand(descriptor.node, semanticValueById, identity, irFunction.functionId, id, options.ssa, irNodeById, scalarSsaIndex)
                  : null;
                return canonicalValue == null ? {} : { canonicalValue };
              })()
              : {}),
            origin: jsonSafe(descriptor.node.origin),
            byteRange,
            rangeProof: memoryRangeProof(
              id,
              nodeId,
              region.id,
              byteRange,
              descriptor.memory,
              descriptor.node,
              region,
            ),
            order: nodeOrderById.get(nodeId) ?? null,
          });
        }
      }
      for (const event of eventsByNode.get(nodeId) ?? []) blockOverrides.set(event.regionId, event.id);
    }
  }

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
      accessProof: cachedMemoryAccessProof(event.descriptor),
      ...(event.descriptor.role === 'write'
        ? (() => {
          const canonicalValue = canonicalStoreOperand(
            event.descriptor.node,
            semanticValueById,
            identity,
            irFunction.functionId,
            event.id,
            options.ssa,
            irNodeById,
            scalarSsaIndex,
          );
          return canonicalValue == null ? {} : { canonicalValue };
        })()
        : {}),
      origin: jsonSafe(event.descriptor.node.origin),
      ...(() => {
        const eventRegion = regionById.get(event.regionId);
        const byteRange = memoryByteRange(eventRegion, event.descriptor.memory, event.descriptor.node);
        return {
          byteRange,
          rangeProof: memoryRangeProof(
            event.id,
            event.descriptor.node.id,
            event.regionId,
            byteRange,
            event.descriptor.memory,
            event.descriptor.node,
            eventRegion,
          ),
        };
      })(),
      order: nodeOrderById.get(event.descriptor.node.id) ?? null,
    });
  }



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
  const blockStates = traversal.map((blockId, bIdx) => ({
    blockId,
    entry: regionIds.map((regionId, rIdx) => ({ regionId, definitionId: getInDef(bIdx, rIdx) })),
    exit: regionIds.map((regionId, rIdx) => ({ regionId, definitionId: getOutDef(bIdx, rIdx) })),
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
    ...(options.snapshotId == null ? {} : { snapshotId: canonicalSnapshotId(options.snapshotId) }),
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
  const published = deepFreeze(new CanonicalMemorySsaArtifact(unpublished, irFunction));
  registerPublishedMemorySsaCaches(published, unpublished.canonicalDigest, published.accessMetadata, published.canonicalAccessBindings);
  return published;
}
