import { stableDigest } from '../../core/identity/index.js';
import { createOriginSet, mergeOriginSets } from '../../core/identity/origin.js';
import { isCanonicalMemorySsaProducerArtifact } from '../../semantics/memoryssa/build.js';
import {
  classifySemanticMemoryRegion as classifySemanticMemoryRegionBase,
  deriveMemoryRegion,
} from './regions-v2.js';
import { deriveCanonicalAddressProof } from './canonical-address-v2.js';

/*
 * The canonical MemorySSA pipeline classifies every memory node twice. The
 * second pass differs only by `canonicalMemorySsa`: it may refine an otherwise
 * unknown pointer that was reloaded through a caller-local stack slot.
 *
 * The historical second-pass resolver rescanned the full immutable IR, scalar
 * SSA, MemorySSA use/def tables and access metadata for every such node. This
 * adapter preserves the exact first-pass result and proof requirements while
 * building those immutable lookup tables once per canonical artifact.
 */
const firstPassByIr = new WeakMap();
const irIndexMemo = new WeakMap();
const pointerIndexMemo = new WeakMap();
const irDigestMemo = new WeakMap();

function normalizedOrigin(...origins) {
  const present = origins.filter((value) => value && typeof value === 'object');
  if (!present.length) return createOriginSet({});
  try { return mergeOriginSets(...present); }
  catch { return createOriginSet({}); }
}

function memoryInteger(value) {
  if (value == null) return null;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!/^[+-]?(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) return null;
    return BigInt(text);
  } catch {
    return null;
  }
}

function strictNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function optionalIdentityString(value, label) {
  if (value == null) return null;
  const text = strictNonEmptyString(value);
  if (!text) throw new TypeError(`alias-region-invalid-${label}`);
  return text;
}

function irDigest(ir) {
  let digest = irDigestMemo.get(ir);
  if (digest === undefined) {
    digest = stableDigest(ir);
    irDigestMemo.set(ir, digest);
  }
  return digest;
}

function irIndexes(ir) {
  let indexed = irIndexMemo.get(ir);
  if (indexed) return indexed;
  const valuesById = new Map();
  const nodesById = new Map();
  // The original pointer path constructs `new Map(String(id), value)`, hence
  // duplicate string identities (though forbidden by canonical IR) are
  // intentionally last-match-wins here too.
  for (const value of ir.values ?? []) valuesById.set(String(value.id), value);
  for (const node of ir.nodes ?? []) nodesById.set(String(node.id), node);
  indexed = { valuesById, nodesById };
  irIndexMemo.set(ir, indexed);
  return indexed;
}

function append(map, key, item) {
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  list.push(item);
}

function pointerIndexes(ir, ssa, memorySsa) {
  if (!isCanonicalMemorySsaProducerArtifact(memorySsa)
      || String(memorySsa.functionId ?? '') !== String(ir.functionId ?? '')
      || String(memorySsa.identity?.semanticIrDigest ?? '') !== irDigest(ir)
      || !Array.isArray(memorySsa.uses)
      || !Array.isArray(memorySsa.definitions)
      || !Array.isArray(memorySsa.accessMetadata)
      || !ssa || !Array.isArray(ssa.uses) || !Array.isArray(ssa.definitions)) return null;

  const cached = pointerIndexMemo.get(memorySsa);
  if (cached?.ir === ir && cached?.ssa === ssa) return cached;

  const ssaUsesBySource = new Map();
  for (const use of ssa.uses) append(ssaUsesBySource, String(use.sourceEntityId ?? ''), use);

  const renamedDefinitionByValueId = new Map();
  for (const definition of ssa.definitions) {
    if (definition?.proof?.kind !== 'renamed-definition') continue;
    const key = String(definition.valueId ?? '');
    if (!renamedDefinitionByValueId.has(key)) renamedDefinitionByValueId.set(key, definition);
  }

  const mustMemoryUsesBySource = new Map();
  for (const use of memorySsa.uses) {
    if (use?.aliasRelation === 'must') append(mustMemoryUsesBySource, String(use.sourceEntityId ?? ''), use);
  }

  const memoryDefinitionById = new Map();
  for (const definition of memorySsa.definitions) {
    if (definition?.kind !== 'memory-def') continue;
    const key = String(definition.id ?? '');
    if (!memoryDefinitionById.has(key)) memoryDefinitionById.set(key, definition);
  }

  const accessMetadataByEntityId = new Map();
  for (const metadata of memorySsa.accessMetadata) {
    const key = String(metadata?.memorySsaEntityId ?? '');
    // Preserve Array.find()'s first-match authority.
    if (!accessMetadataByEntityId.has(key)) accessMetadataByEntityId.set(key, metadata);
  }

  const indexed = {
    ir,
    ssa,
    ...irIndexes(ir),
    ssaUsesBySource,
    renamedDefinitionByValueId,
    mustMemoryUsesBySource,
    memoryDefinitionById,
    accessMetadataByEntityId,
  };
  pointerIndexMemo.set(memorySsa, indexed);
  return indexed;
}

function accessRow(indexes, entityId, nodeId, sourceKind, role) {
  const metadata = indexes.accessMetadataByEntityId.get(String(entityId));
  if (!metadata
      || String(metadata.sourceEntityId ?? '') !== String(nodeId)
      || String(metadata.nodeId ?? '') !== String(nodeId)
      || String(metadata.sourceKind ?? '') !== String(sourceKind)
      || String(metadata.role ?? '') !== String(role)
      || metadata.broad === true) return null;
  return metadata;
}

function sameFirstPassOptions(first, options) {
  return first.binaryId === options.binaryId
    && first.ssa === options.ssa
    && first.rootDescriptors === options.rootDescriptors
    && first.rootDescriptorProvider === options.rootDescriptorProvider
    && first.regionEvidence === options.regionEvidence
    && first.unknownMetadata === options.unknownMetadata;
}

function rememberFirstPass(ir, node, options, result) {
  if (!ir || typeof ir !== 'object' || !node || typeof node !== 'object') return;
  let byNode = firstPassByIr.get(ir);
  if (!byNode) { byNode = new WeakMap(); firstPassByIr.set(ir, byNode); }
  byNode.set(node, {
    binaryId: options.binaryId,
    ssa: options.ssa,
    rootDescriptors: options.rootDescriptors,
    rootDescriptorProvider: options.rootDescriptorProvider,
    regionEvidence: options.regionEvidence,
    unknownMetadata: options.unknownMetadata,
    result,
  });
}

function firstPassFor(ir, node, options) {
  const first = firstPassByIr.get(ir)?.get(node) ?? null;
  return first && sameFirstPassOptions(first, options) ? first : null;
}

function fastPointerRegion(ir, node, options, indexes) {
  const addressValueId = node?.memory?.addressExpr?.valueId;
  if (addressValueId == null) return null;
  const addressValue = indexes.valuesById.get(String(addressValueId));
  const addressDefinition = addressValue?.definitionNodeId == null
    ? null : indexes.nodesById.get(String(addressValue.definitionNodeId));

  let addressRead = addressDefinition;
  let addressReadValueId = addressValueId;
  let addressOffset = 0n;
  if (addressDefinition && ['address', 'binary', 'intrinsic'].includes(addressDefinition.kind)
      && String(addressDefinition.operator ?? '').toLowerCase() === 'add'
      && Array.isArray(addressDefinition.inputs) && addressDefinition.inputs.length === 2) {
    const inputValues = addressDefinition.inputs.map((inputId) => indexes.valuesById.get(String(inputId)));
    const constantIndex = inputValues.findIndex((value) => value?.metadata?.constant?.kind === 'bitvector');
    const baseIndex = constantIndex === 0 ? 1 : constantIndex === 1 ? 0 : -1;
    if (baseIndex >= 0) {
      const constant = memoryInteger(inputValues[constantIndex]?.metadata?.constant?.value);
      const baseValue = inputValues[baseIndex];
      if (constant != null && baseValue?.definitionNodeId != null) {
        addressOffset = constant;
        addressReadValueId = baseValue.id;
        addressRead = indexes.nodesById.get(String(baseValue.definitionNodeId));
      }
    }
  }
  if (!addressRead || addressRead.kind !== 'state-read') return null;

  const stateUses = (indexes.ssaUsesBySource.get(String(addressRead.id)) ?? []).filter((use) =>
    use.proof?.kind === 'renamed-use'
    && String(use.proof?.sourceSemanticValueId ?? addressReadValueId) === String(addressReadValueId));
  const candidates = [];
  for (const stateUse of stateUses) {
    const scalarDefinition = indexes.renamedDefinitionByValueId.get(String(stateUse.valueId ?? '')) ?? null;
    const loadedSemanticValueId = scalarDefinition?.proof?.sourceSemanticValueId;
    const loadedValue = loadedSemanticValueId == null ? null : indexes.valuesById.get(String(loadedSemanticValueId));
    const loadNode = loadedValue?.definitionNodeId == null
      ? null : indexes.nodesById.get(String(loadedValue.definitionNodeId));
    if (!loadNode || loadNode.kind !== 'load') continue;
    const loadUses = indexes.mustMemoryUsesBySource.get(String(loadNode.id)) ?? [];
    if (loadUses.length !== 1) continue;
    const loadUse = loadUses[0];
    if (!accessRow(indexes, loadUse.id, loadNode.id, 'load', 'read')) continue;
    const reachingDefinition = indexes.memoryDefinitionById.get(String(loadUse.reachingDefinitionId ?? '')) ?? null;
    if (!reachingDefinition) continue;
    const storeNode = indexes.nodesById.get(String(reachingDefinition.sourceEntityId ?? ''));
    if (!storeNode || storeNode.kind !== 'store' || !Array.isArray(storeNode.inputs)
        || storeNode.inputs.length !== 2) continue;
    if (!accessRow(indexes, reachingDefinition.id, storeNode.id, 'store', 'write')) continue;

    const rootValueId = storeNode.inputs[1];
    const rootProof = deriveCanonicalAddressProof(ir, rootValueId, {
      addressSpace: node.memory?.addressSpace,
      ssa: options.ssa,
      rootDescriptors: options.rootDescriptors,
      rootDescriptorProvider: options.rootDescriptorProvider,
    });
    const rootKind = rootProof?.kind === 'root-only' ? rootProof.rootKind : rootProof?.kind;
    if (!['rooted', 'stack-like'].includes(String(rootKind))) continue;
    const rootOffset = rootProof.kind === 'root-only' ? 0n : rootProof.offset;
    if (rootOffset == null) continue;
    const offset = rootOffset + addressOffset;
    if (rootKind === 'stack-like') {
      candidates.push({
        kind: 'stack-fixed',
        offset: offset.toString(),
        metadata: { canonicalAddressIncludesOperationDisplacement: true },
      });
    } else if (rootProof.rootEntityId != null) {
      candidates.push({
        kind: 'rooted-offset',
        rootEntityId: String(rootProof.rootEntityId),
        offset: offset.toString(),
        metadata: {
          canonicalAddressIncludesOperationDisplacement: true,
          ...(rootProof.rootIdentity?.storageClass == null ? {} : {
            canonicalRootStorageClass: String(rootProof.rootIdentity.storageClass),
          }),
        },
      });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function classifySemanticMemoryRegion(ir, nodeOrId, options = {}) {
  // Non-canonical and string-ID callers keep the historical implementation.
  // The optimized two-pass path is deliberately scoped to the exact producer
  // call shape used by semantic-v2 compatibility integration.
  const node = typeof nodeOrId === 'object' && nodeOrId !== null ? nodeOrId : null;
  if (!node) return classifySemanticMemoryRegionBase(ir, nodeOrId, options);

  if (options.canonicalMemorySsa == null) {
    const result = classifySemanticMemoryRegionBase(ir, node, options);
    rememberFirstPass(ir, node, options, result);
    return result;
  }

  const first = firstPassFor(ir, node, options);
  if (!first) return classifySemanticMemoryRegionBase(ir, node, options);

  // canonicalMemorySsa can affect only the pointer-through-stack fallback.
  // A first-pass precise or explicitly-malformed result is therefore already
  // the exact second-pass result.
  if (first.result?.kind !== 'unknown'
      || first.result?.metadata?.reason !== 'missing-region-provenance') return first.result;

  const indexes = pointerIndexes(ir, options.ssa, options.canonicalMemorySsa);
  if (!indexes) return classifySemanticMemoryRegionBase(ir, node, options);
  const descriptor = fastPointerRegion(ir, node, options, indexes);
  if (!descriptor) return first.result;

  return deriveMemoryRegion({
    functionId: ir.functionId,
    binaryId: options.binaryId ?? ir.binaryId ?? ir.metadata?.binaryId,
    memory: node.memory,
    origin: normalizedOrigin(ir.origin),
    sourceEntityId: node.id,
    addressValueId: optionalIdentityString(node.memory.addressExpr?.valueId, 'address-value-id'),
    regionEvidence: descriptor,
  });
}
