/**
 * P7-2 — A2 field-sensitive local points-to analysis.
 *
 * A2 sits directly on top of the canonical address/root service in
 * `js/analysis/alias/canonical-address-v2-core.js`. That service already proves
 * exact roots and exact offsets for straight-line address computations; what it
 * cannot do is close a cycle. It returns `canonical-address-semantic-cycle` for
 * a loop-carried pointer and `root-only` for a merge whose offsets disagree.
 *
 * A2's whole job is those two cases: run a real fixed point over the SSA phi
 * graph so a merged or loop-carried pointer keeps its root and gains a bounded
 * *offset range* instead of collapsing to "somewhere in this object". That is
 * what turns overlapping-field questions from `may` into `no`.
 *
 * Pointer loads and call returns are resolved only through already-proven
 * MemorySSA / FunctionSummary evidence. Unsupported, incomplete or ambiguous
 * boundaries stay conservative rather than being guessed from presentation.
 */

import { createAnalysisStatus, isCompleteStatus } from '../status.js';
import { classifyCallTargetProof, summaryIdentityMatches } from '../summary/contract.js';
import { stableDigest, stableStringify } from '../../core/identity/index.js';
import {
  defaultRootEntityId,
  deriveCanonicalAddressProof,
  normalizeRootIdentity,
} from '../alias/canonical-address-v2.js';
import { MEMORY_SSA_BUILD_VERSION } from '../../semantics/memoryssa/build.js';
import { MEMORY_SSA_CONTRACT_VERSION } from '../../semantics/memoryssa/contract.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  canonicalMemoryForwardingContext,
  forwardMemoryValue,
  isCanonicalExactMemoryOperandForwarding,
} from '../../semantics/memoryssa/queries.js';
import { deterministicTraversal } from '../../semantics/cfg/index.js';
import {
  BOTTOM_POINTS_TO,
  POINTS_TO_DEFAULT_BUDGET,
  addRange,
  createPointsToSet,
  createPointsToTarget,
  UNBOUNDED_RANGE,
  exactRange,
  joinPointsTo,
  pointsToDigest,
  pointsToEqual,
  pointsToIsBottom,
  topPointsTo,
  widenPointsTo,
} from './lattice.js';

export const A2_ANALYZER_ID = 'phase7.pointsto.a2-local';
export const A2_ANALYZER_VERSION = '1.2.0';

/** Casts that keep pointer provenance intact when the width does not change. */
const WIDTH_PRESERVING_CASTS = new Set(['copy', 'bitcast']);
const WIDTH_CHANGING_CASTS = new Set(['zext', 'sext', 'trunc']);

function parseInteger(candidate) {
  if (candidate == null) return null;
  const raw = typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate.value ?? candidate.bits ?? null)
    : candidate;
  if (raw == null) return null;
  try {
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? BigInt(raw) : null;
    const text = String(raw).trim();
    if (!/^[+-]?(0x[0-9a-fA-F]+|\d+)$/.test(text)) return null;
    return BigInt(text);
  } catch { return null; }
}

/**
 * Reads a compile-time constant the same way the canonical address derivation
 * does, so A2 and the root service never disagree about what "constant" means.
 */
function constantOf(value, node) {
  for (const candidate of [value?.metadata?.constant, node?.attributes?.constant, node?.metadata?.constant]) {
    const parsed = parseInteger(candidate);
    if (parsed != null) return parsed;
  }
  return null;
}

function widthOf(value, node) {
  const fromValue = Number(value?.machineType?.widthBits);
  if (Number.isSafeInteger(fromValue) && fromValue > 0) return fromValue;
  const fromNode = Number(node?.attributes?.widthBits);
  return Number.isSafeInteger(fromNode) && fromNode > 0 ? fromNode : null;
}

function pointerValue(value) {
  return value?.machineType?.kind === 'address';
}

function finiteWidth(widthBits) {
  const width = Number(widthBits);
  return Number.isSafeInteger(width) && width > 0 && width % 8 === 0 ? width : null;
}

function ordinaryAccess(memory) {
  return !!memory
    && (memory.endian === 'little' || memory.endian === 'big')
    && memory.volatility === false
    && memory.atomic === false
    && (memory.ordering == null || memory.ordering === 'unknown');
}

function memoryAddressValueId(memory) {
  return memory?.addressExpr?.valueId ?? memory?.addressValueId ?? null;
}

function metadataFor(metadataByEntity, entityId) {
  return metadataByEntity.get(String(entityId)) ?? null;
}

function sourceOriginIds(value) {
  return new Set((value?.origin?.instructionIds ?? []).map(String));
}

function storedPointerSetIsValid(set, value, widthBits) {
  if (!set || set.top || !set.targets.length || set.lossReasons.length) return false;
  const originIds = sourceOriginIds(value);
  if (!originIds.size) return false;
  for (const target of set.targets) {
    if (!target || typeof target !== 'object' || !target.rootKey) return false;
    if (!['rooted', 'stack-like', 'absolute'].includes(String(target.rootKind))) return false;
    if (target.widthBits !== widthBits) return false;
    if (!target.offsetRange || typeof target.offsetRange !== 'object') return false;
    const { min, max } = target.offsetRange;
    if (min != null && typeof min !== 'bigint') return false;
    if (max != null && typeof max !== 'bigint') return false;
    if (min != null && max != null && min > max) return false;
    if (!Array.isArray(target.evidenceIds) || !target.evidenceIds.length) return false;
    if (!target.evidenceIds.some((id) => originIds.has(String(id)))) return false;
    if (target.rootKind === 'absolute') {
      if (target.address == null) return false;
    } else if (target.rootIdentity == null && target.rootEntityId == null) {
      return false;
    }
  }
  return true;
}

function boundaryBinding(options, memorySsa) {
  const supplied = options.memorySsaBinding && typeof options.memorySsaBinding === 'object'
    ? options.memorySsaBinding
    : {};
  return {
    ...supplied,
    memorySsa,
    snapshotId: supplied.snapshotId ?? options.memorySsaSnapshotId ?? options.snapshotId ?? 'snapshot-unbound',
    functionId: supplied.functionId ?? options.functionId ?? null,
    semanticIrVersion: supplied.semanticIrVersion ?? options.semanticIrVersion ?? null,
    memorySsaBuildVersion: supplied.memorySsaBuildVersion ?? options.memorySsaBuildVersion ?? null,
    completeness: supplied.completeness ?? options.memorySsaCompleteness ?? 'complete',
  };
}

/**
 * Indexes the already-built MemorySSA artifact once and validates the narrow
 * loaded-pointer boundary. The index is deliberately a consumer of MemorySSA:
 * it never walks or rebuilds reaching definitions itself.
 */
function prepareMemoryBoundary(ir, nodes, values, options, budget) {
  const memorySsa = options.memorySsaBinding?.memorySsa ?? options.memorySsa ?? null;
  const empty = {
    provided: memorySsa != null,
    state: memorySsa == null ? 'missing' : 'unsupported',
    reason: memorySsa == null ? 'memory-boundary-missing' : 'memoryssa-invalid',
    candidates: new Map(),
    diagnostics: new Map(),
    proofs: new Map(),
    binding: null,
    publicationAllowed: false,
  };
  if (memorySsa == null) return empty;
  if (options.signal?.aborted) {
    return { ...empty, state: 'partial', reason: 'cancelled' };
  }

  const binding = boundaryBinding(options, memorySsa);
  const failBoundary = (state, reason) => ({
    ...empty,
    state,
    reason,
    binding,
  });
  if (!memorySsa || typeof memorySsa !== 'object' || Array.isArray(memorySsa)) {
    return failBoundary('unsupported', 'memoryssa-invalid');
  }
  if (String(memorySsa.functionId ?? '') !== String(ir.functionId)) {
    return failBoundary('stale', 'memoryssa-stale-function');
  }
  if (binding.functionId != null && String(binding.functionId) !== String(ir.functionId)) {
    return failBoundary('stale', 'memoryssa-stale-function');
  }
  if (memorySsa.snapshotId != null && String(memorySsa.snapshotId) !== String(options.snapshotId ?? 'snapshot-unbound')) {
    return failBoundary('stale', 'memoryssa-stale-snapshot');
  }
  if (binding.snapshotId !== (options.snapshotId ?? 'snapshot-unbound')) {
    return failBoundary('stale', 'memoryssa-stale-snapshot');
  }
  if (memorySsa.contractVersion !== MEMORY_SSA_CONTRACT_VERSION) {
    return failBoundary('unsupported', 'memoryssa-contract-mismatch');
  }
  if (memorySsa.buildVersion !== MEMORY_SSA_BUILD_VERSION) {
    return failBoundary('stale', 'memoryssa-build-mismatch');
  }
  if (binding.memorySsaBuildVersion != null && String(binding.memorySsaBuildVersion) !== String(memorySsa.buildVersion)) {
    return failBoundary('stale', 'memoryssa-build-mismatch');
  }
  if (binding.semanticIrVersion != null && String(binding.semanticIrVersion) !== String(ir.contractVersion)) {
    return failBoundary('stale', 'semantic-ir-version-mismatch');
  }
  if (binding.completeness !== 'complete') {
    return failBoundary('unsupported', 'memoryssa-incomplete');
  }

  const definitions = Array.isArray(memorySsa.definitions) ? memorySsa.definitions : null;
  const uses = Array.isArray(memorySsa.uses) ? memorySsa.uses : null;
  const regions = Array.isArray(memorySsa.regions) ? memorySsa.regions : null;
  const accessMetadata = Array.isArray(memorySsa.accessMetadata) ? memorySsa.accessMetadata : null;
  const maxIndexEntries = Math.max(1, Number(budget.maxValues) || 1);
  if (!definitions || !uses || !regions || !accessMetadata) {
    return failBoundary('unsupported', 'memoryssa-metadata-missing');
  }
  if (definitions.length > maxIndexEntries || uses.length > maxIndexEntries || regions.length > maxIndexEntries
    || accessMetadata.length > maxIndexEntries * 2) {
    return failBoundary('truncated', 'memoryssa-index-budget-exhausted');
  }

  const definitionsById = new Map();
  const usesById = new Map();
  const usesBySource = new Map();
  const metadataByEntity = new Map();
  for (const definition of definitions) {
    if (options.signal?.aborted) return failBoundary('partial', 'cancelled');
    const id = String(definition?.id ?? '');
    if (!id || definitionsById.has(id)) return failBoundary('unsupported', 'memoryssa-duplicate-definition');
    definitionsById.set(id, definition);
  }
  for (const use of uses) {
    if (options.signal?.aborted) return failBoundary('partial', 'cancelled');
    const id = String(use?.id ?? '');
    if (!id || usesById.has(id)) {
      return failBoundary('unsupported', 'memoryssa-duplicate-use');
    }
    usesById.set(id, use);
    const sourceId = String(use?.sourceEntityId ?? '');
    if (!sourceId) return failBoundary('unsupported', 'memoryssa-use-source-missing');
    const list = usesBySource.get(sourceId) ?? [];
    list.push(use);
    usesBySource.set(sourceId, list);
  }
  for (const list of usesBySource.values()) list.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  for (const metadata of accessMetadata) {
    if (options.signal?.aborted) return failBoundary('partial', 'cancelled');
    const id = String(metadata?.memorySsaEntityId ?? '');
    if (!id || metadataByEntity.has(id)) return failBoundary('unsupported', 'memoryssa-duplicate-access-metadata');
    metadataByEntity.set(id, metadata);
  }

  const regionById = new Map(regions.map((region) => [String(region?.id ?? ''), region]));
  const boundary = {
    provided: true,
    state: 'current',
    reason: null,
    candidates: new Map(),
    diagnostics: new Map(),
    proofs: new Map(),
    binding,
    publicationAllowed: true,
  };
  const reject = (nodeId, reason) => {
    const id = String(nodeId);
    if (!boundary.diagnostics.has(id)) boundary.diagnostics.set(id, reason);
  };

  for (const node of nodes.values()) {
    if (node.kind !== 'load') continue;
    const valueId = node.outputs?.length === 1 ? String(node.outputs[0]) : null;
    const value = valueId == null ? null : values.get(valueId);
    if (!valueId || !value || !pointerValue(value)) {
      reject(valueId ?? node.id, 'load-not-pointer');
      continue;
    }
    if (node.completeness !== 'complete' || node.memory == null || node.inputs?.length !== 1) {
      reject(valueId, 'load-incomplete');
      continue;
    }
    const widthBits = finiteWidth(node.memory.widthBits);
    if (widthBits == null || widthOf(value, node) !== widthBits || memoryAddressValueId(node.memory) !== node.inputs[0]) {
      reject(valueId, 'load-access-invalid');
      continue;
    }
    if (!ordinaryAccess(node.memory)) {
      reject(valueId, 'load-access-not-ordinary');
      continue;
    }
    const sourceUses = usesBySource.get(String(node.id)) ?? [];
    if (sourceUses.length !== 1) {
      reject(valueId, sourceUses.length ? 'load-use-ambiguous' : 'load-use-missing');
      continue;
    }
    const use = sourceUses[0];
    const useMetadata = metadataFor(metadataByEntity, use.id);
    if (!useMetadata || useMetadata.entityKind !== 'use' || useMetadata.nodeId !== node.id
      || useMetadata.regionId !== use.regionId || useMetadata.sourceKind !== 'load'
      || useMetadata.role !== 'read' || useMetadata.broad !== false
      || stableStringify(useMetadata.memory) !== stableStringify(node.memory)) {
      reject(valueId, 'load-access-metadata-mismatch');
      continue;
    }
    let forwarding;
    try {
      forwarding = forwardMemoryValue(memorySsa, use, {
        functionId: ir.functionId,
        snapshotId: binding.snapshotId,
        memorySsaBuildVersion: memorySsa.buildVersion,
        consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
        purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
        ir,
        signal: options.signal,
      });
    } catch {
      forwarding = null;
    }
    if (!isCanonicalExactMemoryOperandForwarding(forwarding, canonicalMemoryForwardingContext(forwarding, {
      artifact: memorySsa,
      artifactDigest: memorySsa.canonicalDigest,
      snapshotId: binding.snapshotId,
      useId: use.id,
      sourceEntityId: node.id,
      nodeId: node.id,
      entityId: useMetadata.memorySsaEntityId,
      regionId: use.regionId,
      range: useMetadata.byteRange,
      consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
      purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
    }))) {
      reject(valueId, use.aliasRelation === 'may' ? 'load-use-may-alias' : 'load-store-not-concrete');
      continue;
    }
    const definitionId = String(forwarding.definitionId ?? '');
    const definition = definitionsById.get(definitionId) ?? null;
    if (!definition || definition.kind !== 'memory-def'
      || String(forwarding.storedSourceEntityId ?? '') !== String(definition.sourceEntityId ?? '')
      || !forwarding.contributingDefinitionIds.includes(definitionId)) {
      reject(valueId, 'load-store-proof-incomplete');
      continue;
    }
    if (String(definition.regionId) !== String(use.regionId) || !definitionsById.has(String(definition.id))) {
      reject(valueId, 'load-store-region-mismatch');
      continue;
    }
    const storeNode = nodes.get(String(definition.sourceEntityId));
    const storeValueId = String(forwarding.storedValueId ?? '');
    const storeValue = storeValueId == null ? null : values.get(storeValueId);
    if (!storeNode || storeNode.kind !== 'store' || storeNode.completeness !== 'complete'
      || !Array.isArray(storeNode.inputs) || storeNode.inputs.length !== 2
      || String(storeNode.inputs[1]) !== storeValueId
      || !storeValueId || !storeValue || !pointerValue(storeValue)) {
      reject(valueId, 'store-value-missing');
      continue;
    }
    if (storeNode.memory == null || !ordinaryAccess(storeNode.memory)
      || stableStringify(storeNode.memory) !== stableStringify(node.memory)) {
      reject(valueId, 'store-access-mismatch');
      continue;
    }
    if (widthOf(storeValue, storeNode) !== widthBits || finiteWidth(storeNode.memory.widthBits) !== widthBits
      || memoryAddressValueId(storeNode.memory) !== storeNode.inputs[0]) {
      reject(valueId, 'store-access-invalid');
      continue;
    }
    const storeMetadata = metadataFor(metadataByEntity, definition.id);
    if (!storeMetadata || storeMetadata.entityKind !== 'definition' || storeMetadata.nodeId !== storeNode.id
      || storeMetadata.regionId !== definition.regionId || storeMetadata.sourceKind !== 'store'
      || storeMetadata.role !== 'write' || storeMetadata.broad !== false
      || stableStringify(storeMetadata.memory) !== stableStringify(storeNode.memory)) {
      reject(valueId, 'store-access-metadata-mismatch');
      continue;
    }
    const region = regionById.get(String(use.regionId));
    if (!region || (region.widthBits != null && Number(region.widthBits) !== widthBits)) {
      reject(valueId, 'load-store-region-invalid');
      continue;
    }
    const proofIdentity = forwarding.identity.digest;
    boundary.candidates.set(valueId, {
      valueId,
      loadNode: node,
      loadNodeId: node.id,
      loadUse: use,
      definition,
      storeNode,
      storeNodeId: storeNode.id,
      storedValueId: storeValueId,
      widthBits,
      proofIdentity,
      forwarding,
    });
  }
  return boundary;
}

/** Turns an exact canonical proof into a singleton points-to set. */
function targetFromCanonicalProof(proof, evidenceIds) {
  if (!proof || proof.kind === 'unknown' || proof.kind === 'root-only') return null;
  if (proof.kind === 'constant') {
    return createPointsToTarget({
      addressSpace: 'memory', rootKind: 'absolute', address: String(proof.value), offsetRange: exactRange(0n),
      widthBits: proof.widthBits, evidenceIds,
    });
  }
  if (proof.kind === 'absolute') {
    return createPointsToTarget({
      addressSpace: proof.addressSpace, rootKind: 'absolute', address: String(proof.address),
      offsetRange: exactRange(0n), widthBits: proof.widthBits, evidenceIds,
    });
  }
  if (proof.kind === 'stack-like' || proof.kind === 'rooted') {
    return createPointsToTarget({
      addressSpace: proof.addressSpace,
      rootKind: proof.kind,
      rootIdentity: proof.rootIdentity,
      rootEntityId: proof.rootEntityId ?? null,
      separationClass: proof.separationClass ?? null,
      separationAuthority: proof.separationAuthority ?? null,
      offsetRange: exactRange(proof.offset),
      widthBits: proof.widthBits,
      evidenceIds,
    });
  }
  return null;
}

/**
 * The root of a `root-only` proof, with the offset left unbounded.
 *
 * This is the key A2 seed: the canonical service proved the *root* even though
 * it could not prove the offset, so A2 starts from the right object and only
 * has to bound the displacement.
 */
function rootOnlySeed(proof, evidenceIds) {
  if (!proof || proof.kind !== 'root-only') return null;
  return createPointsToTarget({
    addressSpace: proof.addressSpace,
    rootKind: proof.rootKind,
    rootIdentity: proof.rootIdentity,
    rootEntityId: proof.rootEntityId ?? null,
    separationClass: proof.separationClass ?? null,
    separationAuthority: proof.separationAuthority ?? null,
    offsetRange: { min: null, max: null, exact: false },
    widthBits: proof.widthBits,
    evidenceIds,
  });
}

function shiftSet(set, delta, widthBits) {
  if (set.top) return set;
  const lossReasons = [...set.lossReasons];
  const targets = set.targets.map((target) => {
    const { range, lost } = addRange(target.offsetRange, delta, widthBits ?? target.widthBits);
    if (lost) lossReasons.push(lost);
    return createPointsToTarget({ ...target, offsetRange: range });
  });
  return createPointsToSet({ targets, lossReasons });
}

/**
 * Converts a finite root/allocation return fact into the canonical points-to
 * target shape. An identity is mandatory: a kind without its stable root/site
 * id is only a label, not provenance, and therefore remains unresolved.
 */
function targetFromReturnProvenance(provenance, widthBits, evidenceIds) {
  if (provenance?.kind !== 'root' && provenance?.kind !== 'allocation') return null;
  const rootEntityId = provenance.rootEntityId ?? provenance.allocationSiteId ?? null;
  if (rootEntityId == null || !String(rootEntityId).trim()) return null;
  let offset;
  try { offset = BigInt(provenance.offset ?? 0n); }
  catch { return null; }
  return createPointsToTarget({
    addressSpace: provenance.addressSpace == null ? 'memory' : String(provenance.addressSpace),
    rootKind: provenance.kind === 'allocation' ? 'allocation' : 'rooted',
    rootIdentity: provenance.rootIdentity ?? null,
    rootEntityId: String(rootEntityId),
    separationClass: provenance.separationClass ?? null,
    separationAuthority: provenance.separationAuthority ?? null,
    offsetRange: exactRange(offset),
    widthBits,
    evidenceIds,
  });
}

/**
 * Root singleton for an SSA `entry` definition: the incoming machine state a
 * function was handed. The root identity is built with the canonical helpers so
 * A2 and the exact derivation name the same object.
 */
function entryRootTarget(definition, functionId, values) {
  const variable = definition.proof?.variableIdentity ?? {
    key: definition.variableKey ?? `ssa-entry:${definition.definitionId}`,
    kind: 'logical-state',
    scope: 'function',
  };
  const identity = normalizeRootIdentity(variable, functionId);
  if (identity == null) return null;
  const semanticValue = definition.proof?.sourceSemanticValueId == null
    ? null
    : values.get(String(definition.proof.sourceSemanticValueId));
  const widthBits = Number(semanticValue?.machineType?.widthBits)
    || Number(definition.proof?.machineType?.widthBits)
    || null;
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootIdentity: identity,
    rootEntityId: defaultRootEntityId(identity),
    offsetRange: exactRange(0n),
    widthBits,
  });
}

/**
 * Runs the local points-to fixed point for one function.
 *
 * Two coupled maps are solved together: one over IR values and one over SSA
 * value ids. They have to be one fixed point rather than two passes because the
 * interesting case is a cycle that runs through both — a loop-carried pointer
 * is an SSA phi whose incoming value is an IR add of the phi itself.
 *
 * Returns the IR-value map plus the status describing how the run terminated. A
 * run that hits its iteration cap reports `truncated`, never `complete`.
 */
export function analyzeLocalPointsTo(ir, cfg, ssa, options = {}) {
  const budget = { ...POINTS_TO_DEFAULT_BUDGET, ...(options.budget ?? {}) };
  const values = new Map((ir.values ?? []).map((value) => [String(value.id), value]));
  const nodes = new Map((ir.nodes ?? []).map((node) => [String(node.id), node]));
  const functionId = String(ir.functionId);

  const ssaDefinitions = new Map((ssa?.definitions ?? []).map((definition) => [String(definition.valueId), definition]));
  const ssaUsesByEntity = new Map();
  for (const use of ssa?.uses ?? []) {
    const key = String(use.sourceEntityId);
    if (!ssaUsesByEntity.has(key)) ssaUsesByEntity.set(key, []);
    ssaUsesByEntity.get(key).push(use);
  }

  const fallbackStatus = (completeness, stopReason) => createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: A2_ANALYZER_ID,
    analyzerVersion: A2_ANALYZER_VERSION,
    completeness,
    budgetClass: options.budgetClass ?? null,
    stopReason,
  });

  if (values.size > budget.maxValues) {
    return { pointsTo: new Map(), ssaPointsTo: new Map(), iterations: 0, status: fallbackStatus('unsupported', 'budget-exhausted') };
  }

  let memoryBoundary;
  try {
    memoryBoundary = prepareMemoryBoundary(ir, nodes, values, options, budget);
  } catch {
    memoryBoundary = {
      provided: options.memorySsaBinding?.memorySsa != null || options.memorySsa != null,
      state: 'unsupported',
      reason: 'memoryssa-invalid',
      candidates: new Map(),
      diagnostics: new Map(),
      proofs: new Map(),
      binding: null,
      publicationAllowed: false,
    };
  }

  // Canonical proofs are computed once per value. They are the exact answers;
  // the fixed point only has to improve on the merged and cyclic ones.
  const canonical = new Map();
  for (const id of values.keys()) {
    let proof;
    try { proof = deriveCanonicalAddressProof(ir, id, { ssa, ...(options.canonicalOptions ?? {}) }); }
    catch { proof = null; }
    canonical.set(id, proof);
  }

  const blockOrder = cfg ? deterministicTraversal(cfg) : [];
  const blockRank = new Map(blockOrder.map((blockId, index) => [blockId, index]));
  const rankOf = (valueId) => {
    const value = values.get(String(valueId));
    const node = value?.definitionNodeId == null ? null : nodes.get(String(value.definitionNodeId));
    return blockRank.get(node?.blockId) ?? Number.MAX_SAFE_INTEGER;
  };
  const irOrder = [...values.keys()].sort((left, right) => rankOf(left) - rankOf(right) || left.localeCompare(right));
  const ssaOrder = [...ssaDefinitions.keys()].sort((left, right) => {
    const leftRank = blockRank.get(ssaDefinitions.get(left).blockId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = blockRank.get(ssaDefinitions.get(right).blockId) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });

  const irState = new Map(irOrder.map((id) => [id, BOTTOM_POINTS_TO]));
  const ssaState = new Map(ssaOrder.map((id) => [id, BOTTOM_POINTS_TO]));
  const irPrevious = new Map();
  const ssaPrevious = new Map();

  const irGet = (id) => irState.get(String(id)) ?? topPointsTo('unsupported-operation');
  const ssaGet = (id) => ssaState.get(String(id)) ?? topPointsTo('unsupported-operation');

  function transferLoadedPointer(id) {
    const candidate = memoryBoundary.candidates.get(String(id));
    if (!candidate) return { candidate: null, set: null };
    const storedSet = irState.get(candidate.storedValueId);
    // The stored value may be visited later in this iteration. Keep the seed
    // at BOTTOM until it is available so a valid proof can converge without
    // first publishing an irreversible TOP value.
    if (!storedSet || pointsToIsBottom(storedSet)) return { candidate, set: BOTTOM_POINTS_TO };
    if (!storedPointerSetIsValid(storedSet, values.get(candidate.storedValueId), candidate.widthBits)) {
      return {
        candidate,
        set: createPointsToSet({
          top: true,
          lossReasons: [...(storedSet.lossReasons ?? []), 'unresolved-load'],
        }),
      };
    }
    return {
      candidate,
      set: createPointsToSet({ targets: storedSet.targets, lossReasons: storedSet.lossReasons }),
    };
  }

  /** Reaching SSA values for one `state-read`, matched on variable identity. */
  function reachingSsaValues(node) {
    const variableKey = String(node.variable?.key ?? '');
    if (!variableKey) return [];
    const uses = (ssaUsesByEntity.get(String(node.id)) ?? []).filter((use) => (
      String(use.proof?.variableIdentity?.key ?? use.proof?.sourceVariableKey ?? '') === variableKey
    ));
    return [...new Set(uses.map((use) => String(use.valueId)))].sort();
  }

  function transferSsa(ssaValueId) {
    const definition = ssaDefinitions.get(ssaValueId);
    if (!definition) return topPointsTo('unsupported-operation');
    if (definition.kind === 'unknown') return topPointsTo('unresolved-call');
    if (definition.kind === 'undef') {
      // An implicit-undef seed means "no earlier semantic definition", not a
      // clobber. Treat it as the incoming entry root rather than as TOP,
      // matching the canonical derivation's reading of the same sentinel.
      if (definition.proof?.kind === 'implicit-undef') {
        const target = entryRootTarget(definition, functionId, values);
        return target == null ? topPointsTo('unsupported-operation') : createPointsToSet({ targets: [target] });
      }
      return topPointsTo('unsupported-operation');
    }
    if (definition.kind === 'entry') {
      const target = entryRootTarget(definition, functionId, values);
      return target == null ? topPointsTo('unsupported-operation') : createPointsToSet({ targets: [target] });
    }
    if (definition.kind === 'phi') {
      let merged = BOTTOM_POINTS_TO;
      for (const incoming of definition.incoming ?? []) merged = joinPointsTo(merged, ssaGet(incoming.valueId), budget);
      return merged;
    }
    const sourceSemanticValueId = definition.proof?.sourceSemanticValueId;
    if (sourceSemanticValueId == null) return topPointsTo('unsupported-operation');
    return irGet(sourceSemanticValueId);
  }

  function transferIr(id) {
    const value = values.get(id);
    if (!value) return topPointsTo('unsupported-operation');
    if (value.kind === 'unknown' || value.kind === 'undef') return topPointsTo('unsupported-operation');

    const proof = canonical.get(id);
    const evidenceIds = [...(value.origin?.instructionIds ?? [])].map(String);
    const exact = targetFromCanonicalProof(proof, evidenceIds);
    if (exact) return createPointsToSet({ targets: [exact] });

    const node = value.definitionNodeId == null ? null : nodes.get(String(value.definitionNodeId));
    if (!node) {
      const seed = rootOnlySeed(proof, evidenceIds);
      return seed ? createPointsToSet({ targets: [seed] }) : topPointsTo('unresolved-load');
    }

    const width = widthOf(value, node);

    if (node.kind === 'state-read') {
      const reaching = reachingSsaValues(node);
      if (!reaching.length) {
        const seed = rootOnlySeed(proof, evidenceIds);
        return seed ? createPointsToSet({ targets: [seed] }) : topPointsTo('unsupported-operation');
      }
      let merged = BOTTOM_POINTS_TO;
      for (const ssaValueId of reaching) merged = joinPointsTo(merged, ssaGet(ssaValueId), budget);
      return merged;
    }

    if (WIDTH_PRESERVING_CASTS.has(node.kind) && node.inputs.length === 1) return irGet(node.inputs[0]);
    if (WIDTH_CHANGING_CASTS.has(node.kind) && node.inputs.length === 1) {
      const inputValue = values.get(String(node.inputs[0]));
      const inputWidth = widthOf(inputValue, null);
      // Narrowing or re-widening a pointer destroys provenance: the recovered
      // bits are no longer proof of which object the pointer came from.
      if (inputWidth == null || width == null || inputWidth !== width) return topPointsTo('integer-to-pointer');
      return irGet(node.inputs[0]);
    }
    if (node.kind === 'select') {
      const arms = node.inputs.length === 3 ? node.inputs.slice(1) : node.inputs;
      let merged = BOTTOM_POINTS_TO;
      for (const arm of arms) merged = joinPointsTo(merged, irGet(arm), budget);
      return merged;
    }
    if (node.kind === 'binary' && node.inputs.length === 2) {
      const operator = String(node.operator ?? '').toLowerCase();
      if (operator !== 'add' && operator !== 'sub') return topPointsTo('non-linear-arithmetic');
      const leftValue = values.get(String(node.inputs[0]));
      const rightValue = values.get(String(node.inputs[1]));
      const leftNode = leftValue?.definitionNodeId == null ? null : nodes.get(String(leftValue.definitionNodeId));
      const rightNode = rightValue?.definitionNodeId == null ? null : nodes.get(String(rightValue.definitionNodeId));
      const leftConstant = constantOf(leftValue, leftNode);
      const rightConstant = constantOf(rightValue, rightNode);
      if (rightConstant != null) {
        return shiftSet(irGet(node.inputs[0]), operator === 'sub' ? -rightConstant : rightConstant, width);
      }
      if (leftConstant != null && operator === 'add') {
        return shiftSet(irGet(node.inputs[1]), leftConstant, width);
      }
      // Neither operand is a constant, so we cannot tell which side is the
      // pointer. Both sides' roots must survive: taking only the left operand
      // would drop the right one's targets, and a points-to set that is missing
      // a target falsely proves separation from it.
      const left = irGet(node.inputs[0]);
      const right = irGet(node.inputs[1]);
      if (left.top || right.top) return topPointsTo('non-linear-arithmetic');
      const merged = joinPointsTo(left, right, budget);
      if (merged.top || pointsToIsBottom(merged)) return topPointsTo('non-linear-arithmetic');
      // The displacement is unbounded, so every surviving root keeps its
      // identity and loses its offset.
      return createPointsToSet({
        targets: merged.targets.map((target) => createPointsToTarget({ ...target, offsetRange: UNBOUNDED_RANGE })),
        lossReasons: [...merged.lossReasons, 'non-linear-arithmetic'],
      });
    }
    if (node.kind === 'load') {
      const loaded = transferLoadedPointer(id);
      if (loaded.candidate) return loaded.set;
      return topPointsTo('unresolved-load');
    }
    if (node.kind === 'call') {
      const targetProof = classifyCallTargetProof(node.call);
      const calleeId = targetProof.exactSingletonEntityId;
      const calleeSummary = calleeId == null
        ? null
        : (options.summaries?.get(String(calleeId))
          || (typeof options.summaryProvider === 'function' ? options.summaryProvider(String(calleeId)) : null));
      const configuredSummaryIdentity = options.summaryIdentity ?? options.expectedSummaryIdentity;
      const summaryIdentity = configuredSummaryIdentity
        && typeof configuredSummaryIdentity === 'object'
        && !Array.isArray(configuredSummaryIdentity)
        ? configuredSummaryIdentity
        : {};
      if (!calleeSummary
        || !summaryIdentityMatches(calleeSummary, {
          functionId: calleeId,
          snapshotId: options.snapshotId ?? 'snapshot-unbound',
          analyzerId: options.summaryAnalyzerId ?? options.expectedSummaryAnalyzerId ?? summaryIdentity.analyzerId ?? null,
          analyzerVersion: options.summaryAnalyzerVersion
            ?? options.expectedSummaryAnalyzerVersion
            ?? summaryIdentity.analyzerVersion
            ?? null,
        })
        || !isCompleteStatus(calleeSummary.status)
        || (calleeSummary.unknownCallEffects || []).length > 0) {
        return topPointsTo('unresolved-call');
      }

      const returnIndex = Math.max(0, (node.outputs ?? []).indexOf(id));
      const alternatives = (calleeSummary.returnProvenance ?? []).filter(
        (prov) => Number(prov.returnIndex ?? 0) === returnIndex,
      );
      if (!alternatives.length) return topPointsTo('unresolved-call');

      // Canonical Semantic IR carries the argument list independently from a
      // runtime target value. Old fixtures predate that field, so node.inputs is
      // retained only as a compatibility fallback.
      const argumentIds = node.call?.arguments?.length ? node.call.arguments : node.inputs;
      let merged = BOTTOM_POINTS_TO;
      for (const prov of alternatives) {
        let candidate;
        if (prov.kind === 'arg' && prov.argIndex != null && argumentIds?.[prov.argIndex] != null) {
          const argSet = irGet(argumentIds[prov.argIndex]);
          if (argSet.top || pointsToIsBottom(argSet)) return topPointsTo('unresolved-call');
          let offset;
          try { offset = BigInt(prov.offset ?? 0n); }
          catch { return topPointsTo('unresolved-call'); }
          candidate = offset !== 0n ? shiftSet(argSet, offset, width ?? 64) : argSet;
        } else {
          const target = targetFromReturnProvenance(prov, width ?? 64, evidenceIds);
          if (!target) return topPointsTo('unresolved-call');
          candidate = createPointsToSet({ targets: [target] });
        }
        if (candidate.top || pointsToIsBottom(candidate)) return topPointsTo('unresolved-call');
        merged = joinPointsTo(merged, candidate, budget);
        if (merged.top) return merged;
      }
      return pointsToIsBottom(merged) ? topPointsTo('unresolved-call') : merged;
    }

    const seed = rootOnlySeed(proof, evidenceIds);
    if (seed) return createPointsToSet({ targets: [seed] });
    return topPointsTo('unsupported-operation');
  }

  let iterations = 0;
  let changed = true;
  let stopReason = null;
  while (changed) {
    if (options.signal?.aborted) { stopReason = 'cancelled'; break; }
    if (iterations >= budget.maxIterations) { stopReason = 'iteration-limit'; break; }
    iterations += 1;
    changed = false;
    const widening = iterations > budget.widenAfterIterations;

    const step = (order, state, previous, transfer) => {
      for (const id of order) {
        if (options.signal?.aborted) {
          stopReason = 'cancelled';
          return;
        }
        const current = state.get(id);
        const joined = joinPointsTo(current, transfer(id), budget);
        const next = widening ? widenPointsTo(previous.get(id) ?? current, joined, budget) : joined;
        if (!pointsToEqual(current, next)) {
          previous.set(id, current);
          state.set(id, next);
          changed = true;
        }
      }
    };
    step(ssaOrder, ssaState, ssaPrevious, transferSsa);
    step(irOrder, irState, irPrevious, transferIr);
  }

  // Bottom is the fixed-point seed, never an answer. A value the solve never
  // reached is unreachable or unmodelled, and TOP is the only sound report:
  // an empty points-to set would falsely separate it from everything.
  for (const [id, set] of irState) if (pointsToIsBottom(set)) irState.set(id, topPointsTo('unsupported-operation'));
  for (const [id, set] of ssaState) if (pointsToIsBottom(set)) ssaState.set(id, topPointsTo('unsupported-operation'));

  let completeness = stopReason == null ? 'complete' : stopReason === 'cancelled' ? 'partial' : 'truncated';
  if (stopReason == null && memoryBoundary.state === 'truncated') {
    completeness = 'truncated';
    stopReason = 'budget-exhausted';
  } else if (stopReason == null && memoryBoundary.provided && memoryBoundary.state !== 'current') {
    completeness = 'unsupported';
    stopReason = memoryBoundary.state === 'stale' ? 'dependency-mismatch' : 'dependency-missing';
  }
  const proofs = {};
  const diagnostics = new Map(memoryBoundary.diagnostics);
  for (const [valueId, candidate] of memoryBoundary.candidates) {
    const storedSet = irState.get(candidate.storedValueId);
    const loadedSet = irState.get(valueId);
    if (storedPointerSetIsValid(storedSet, values.get(candidate.storedValueId), candidate.widthBits)
      && loadedSet && !loadedSet.top && !pointsToIsBottom(loadedSet)
      && pointsToEqual(loadedSet, storedSet)) {
      const storedPointsToDigest = pointsToDigest(storedSet);
      proofs[valueId] = {
        proofIdentity: stableDigest({
          boundaryProofIdentity: candidate.proofIdentity,
          storedPointsToDigest,
        }),
        storedPointsToDigest,
        loadNodeId: candidate.loadNodeId,
        loadUseId: candidate.loadUse.id,
        definitionId: candidate.definition.id,
        storeNodeId: candidate.storeNodeId,
        storedValueId: candidate.storedValueId,
        widthBits: candidate.widthBits,
      };
    } else if (!diagnostics.has(valueId)) {
      diagnostics.set(valueId, stopReason ?? 'stored-pointer-unproven');
    }
  }
  const diagnosticList = [...diagnostics.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([valueId, reason]) => ({ valueId, reason }));
  const recovery = memoryBoundary.provided ? {
    bindingState: memoryBoundary.state,
    bindingReason: memoryBoundary.reason,
    publicationAllowed: memoryBoundary.publicationAllowed && completeness === 'complete' && stopReason == null,
    recoveredValueIds: Object.keys(proofs).sort(),
    proofs,
    diagnostics: diagnosticList,
  } : null;
  return {
    pointsTo: irState,
    ssaPointsTo: ssaState,
    iterations,
    status: fallbackStatus(completeness, stopReason),
    ...(recovery == null ? {} : { recovery }),
  };
}
