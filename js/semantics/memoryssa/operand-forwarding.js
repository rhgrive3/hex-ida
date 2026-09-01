import { stableDigest, stableStringify } from '../../core/identity/index.js';
import { isCanonicalMemorySsaProducerArtifact } from './build.js';

/*
 * Exact identity forwarding for one narrow case that byte forwarding cannot
 * represent: a non-constant scalar value spilled to one fixed stack slot and
 * loaded back from that exact slot.
 *
 * This remains a canonical MemorySSA query. It consumes only the branded,
 * immutable builder artifact plus the exact Semantic IR object bound into that
 * artifact. It never walks projected v1 instructions and never treats the
 * legacy `reachingStore` compatibility pointer as proof.
 *
 * The query intentionally refuses memory-phi, partial overlap, cross-region
 * may/unknown aliases, volatile/atomic accesses, width/endian changes, and
 * stale Semantic IR. Those cases remain explicit unknowns.
 */

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function rangeKey(range) {
  if (!record(range) || range.domain == null || range.start == null || range.end == null) return null;
  try {
    const start = BigInt(range.start);
    const end = BigInt(range.end);
    if (end <= start) return null;
    return `${String(range.domain)}\u0000${start.toString()}\u0000${end.toString()}`;
  } catch {
    return null;
  }
}

function ordinaryMemory(memory) {
  const widthBits = Number(memory?.widthBits);
  return record(memory)
    && memory.addressSpace === 'memory'
    && Number.isSafeInteger(widthBits)
    && widthBits > 0
    && widthBits % 8 === 0
    && (memory.endian === 'little' || memory.endian === 'big')
    && memory.volatility === false
    && memory.atomic === false
    && (memory.ordering == null || memory.ordering === 'unknown');
}

function normalizedUnknownOrdering(value) {
  return value == null || value === 'unknown' ? 'unknown' : value;
}

function producerNormalizedBooleanMatches(original, canonical) {
  return original === canonical || (original === 'unknown' && canonical === false);
}

function metadataMatchesSemanticAccess(nodeMemory, metadataMemory) {
  if (!record(nodeMemory) || !record(metadataMemory)) return false;
  return nodeMemory.addressSpace === metadataMemory.addressSpace
    && Number(nodeMemory.widthBits) === Number(metadataMemory.widthBits)
    && nodeMemory.endian === metadataMemory.endian
    && stableStringify(nodeMemory.addressExpr ?? nodeMemory.addressValueId ?? null)
      === stableStringify(metadataMemory.addressExpr ?? metadataMemory.addressValueId ?? null)
    && stableStringify(nodeMemory.alignment ?? null) === stableStringify(metadataMemory.alignment ?? null)
    && producerNormalizedBooleanMatches(nodeMemory.volatility, metadataMemory.volatility)
    && producerNormalizedBooleanMatches(nodeMemory.atomic, metadataMemory.atomic)
    && normalizedUnknownOrdering(nodeMemory.ordering) === normalizedUnknownOrdering(metadataMemory.ordering);
}

function sameOrdinaryMemoryView(left, right) {
  return ordinaryMemory(left)
    && ordinaryMemory(right)
    && left.addressSpace === right.addressSpace
    && Number(left.widthBits) === Number(right.widthBits)
    && left.endian === right.endian;
}

function semanticIrMatches(memorySsa, ir) {
  if (!record(ir)
      || String(ir.functionId ?? '') !== String(memorySsa.functionId ?? '')
      || typeof memorySsa.identity?.semanticIrDigest !== 'string'
      || !memorySsa.identity.semanticIrDigest
      || stableDigest(ir) !== memorySsa.identity.semanticIrDigest) return false;
  const canonical = memorySsa.canonicalIrIdentity;
  return record(canonical)
    && String(canonical.functionId ?? '') === String(ir.functionId ?? '')
    && String(canonical.semanticIrId ?? '') === String(memorySsa.identity?.semanticIrId ?? '')
    && String(canonical.semanticIrContractVersion ?? '') === String(ir.contractVersion ?? '')
    && String(canonical.semanticIrDigest ?? '') === memorySsa.identity.semanticIrDigest;
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  for (const item of items) {
    const key = keyOf(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function metadataFor(memorySsa, id) {
  const rows = (memorySsa.accessMetadata ?? [])
    .filter((item) => String(item?.memorySsaEntityId ?? '') === String(id));
  return rows.length === 1 ? rows[0] : null;
}

function coverageFor(memorySsa, use) {
  if (!Array.isArray(memorySsa.byteCoverage)) return null;
  const rows = memorySsa.byteCoverage.filter((item) => String(item?.useId ?? '') === String(use.id));
  if (rows.length !== 1) return null;
  const coverage = rows[0];
  if (!record(coverage)
      || coverage.coverageState !== 'complete'
      || String(coverage.nodeId ?? '') !== String(use.sourceEntityId ?? '')
      || String(coverage.regionId ?? '') !== String(use.regionId ?? '')) return null;

  const aliases = coverage.regionAliasStates;
  if (!Array.isArray(memorySsa.regions)
      || !Array.isArray(aliases)
      || aliases.length !== memorySsa.regions.length
      || !uniqueBy(aliases, (item) => String(item?.regionId ?? ''))) return null;
  const regionIds = new Set(memorySsa.regions.map((region) => String(region?.id ?? '')));
  if (regionIds.has('') || aliases.some((item) => !regionIds.has(String(item?.regionId ?? ''))
      || !['must', 'no'].includes(String(item?.aliasRelation ?? '')))) return null;
  const relevant = aliases.filter((item) => item.aliasRelation !== 'no');
  if (relevant.length !== 1
      || relevant[0].aliasRelation !== 'must'
      || String(relevant[0].regionId) !== String(use.regionId)) return null;

  const states = coverage.regionStates;
  if (!Array.isArray(states) || states.length !== 1) return null;
  const state = states[0];
  if (String(state?.regionId ?? '') !== String(use.regionId)
      || String(state?.definitionId ?? '') !== String(use.reachingDefinitionId ?? '')
      || state?.aliasRelation !== 'must') return null;
  return coverage;
}

function semanticValueUseCount(ir, valueId) {
  const target = String(valueId ?? '');
  if (!target) return 0;
  let count = 0;
  for (const node of ir.nodes ?? []) {
    for (const input of node?.inputs ?? []) {
      if (String(input ?? '') === target) count++;
    }
  }
  return count;
}

function semanticBlockMayBeJoin(ir, blockId) {
  const target = String(blockId ?? '');
  if (!target) return true;
  const predecessors = new Set();
  for (const node of ir.nodes ?? []) {
    if (String(node?.blockId ?? '') === target) continue;
    for (const successor of node?.targets ?? []) {
      if (String(successor ?? '') === target) predecessors.add(String(node?.blockId ?? ''));
    }
  }
  predecessors.delete('');
  return predecessors.size > 0;
}

function semanticIntervalContainsCall(ir, storeNode, loadNode) {
  if (!Array.isArray(ir?.nodes)) return true;
  const storeBlockId = String(storeNode?.blockId ?? '');
  const loadBlockId = String(loadNode?.blockId ?? '');
  if (!storeBlockId || !loadBlockId) return true;

  if (storeBlockId !== loadBlockId) {
    // Cross-block publication is allowed only for a canonical entry-block spill.
    // The entry block cannot be a CFG join, and the caller has already proven
    // through MemorySSA that this exact store is the load's must-alias reaching
    // definition with complete byte coverage. This is the ordinary clang -O0
    // argument-spill pattern used by max/min. Every other cross-block case stays
    // fail-closed and must use CFG-aware recovery instead.
    return storeBlockId !== String(ir.entryBlockId ?? '');
  }

  if (!ir.nodes.some((node) => String(node?.blockId ?? '') === storeBlockId && node?.kind === 'call')) return false;
  const storeIndex = ir.nodes.indexOf(storeNode);
  const loadIndex = ir.nodes.indexOf(loadNode);
  if (storeIndex < 0 || loadIndex <= storeIndex) return true;
  return ir.nodes.slice(storeIndex + 1, loadIndex).some((node) =>
    String(node?.blockId ?? '') === storeBlockId && node?.kind === 'call');
}

export function forwardExactStackOperandIdentity(memorySsa, useOrId, ir) {
  if (!isCanonicalMemorySsaProducerArtifact(memorySsa)
      || !semanticIrMatches(memorySsa, ir)
      || !Array.isArray(memorySsa.uses)
      || !Array.isArray(memorySsa.definitions)
      || !Array.isArray(memorySsa.accessMetadata)) return null;

  const useId = typeof useOrId === 'object' ? useOrId?.id : useOrId;
  const uses = memorySsa.uses.filter((item) => String(item?.id ?? '') === String(useId ?? ''));
  if (uses.length !== 1) return null;
  const use = uses[0];
  if (use.aliasRelation !== 'must' || use.sourceEntityId == null || use.regionId == null) return null;

  const definitions = memorySsa.definitions.filter((item) => String(item?.id ?? '') === String(use.reachingDefinitionId ?? ''));
  if (definitions.length !== 1) return null;
  const definition = definitions[0];
  if (definition.kind !== 'memory-def'
      || definition.aliasRelation !== 'must'
      || String(definition.regionId ?? '') !== String(use.regionId)) return null;

  const region = (memorySsa.regions ?? []).find((item) => String(item?.id ?? '') === String(use.regionId)) ?? null;
  if (!region || region.kind !== 'stack-fixed') return null;

  const loadMetadata = metadataFor(memorySsa, use.id);
  const storeMetadata = metadataFor(memorySsa, definition.id);
  if (!loadMetadata || !storeMetadata
      || loadMetadata.entityKind !== 'use'
      || loadMetadata.sourceKind !== 'load'
      || loadMetadata.role !== 'read'
      || loadMetadata.broad === true
      || loadMetadata.aliasRelation !== 'must'
      || String(loadMetadata.sourceEntityId ?? '') !== String(use.sourceEntityId)
      || String(loadMetadata.nodeId ?? '') !== String(use.sourceEntityId)
      || String(loadMetadata.regionId ?? '') !== String(use.regionId)
      || storeMetadata.entityKind !== 'definition'
      || storeMetadata.sourceKind !== 'store'
      || storeMetadata.role !== 'write'
      || storeMetadata.broad === true
      || storeMetadata.aliasRelation !== 'must'
      || String(storeMetadata.sourceEntityId ?? '') !== String(definition.sourceEntityId ?? '')
      || String(storeMetadata.nodeId ?? '') !== String(definition.sourceEntityId ?? '')
      || String(storeMetadata.regionId ?? '') !== String(definition.regionId ?? '')
      || !sameOrdinaryMemoryView(loadMetadata.memory, storeMetadata.memory)) return null;

  const loadRange = rangeKey(loadMetadata.byteRange);
  const storeRange = rangeKey(storeMetadata.byteRange);
  if (!loadRange || loadRange !== storeRange) return null;
  const coverage = coverageFor(memorySsa, use);
  if (!coverage || rangeKey(coverage.loadRange) !== loadRange) return null;

  const nodes = new Map((ir.nodes ?? []).map((node) => [String(node?.id ?? ''), node]));
  const values = new Map((ir.values ?? []).map((value) => [String(value?.id ?? ''), value]));
  if (nodes.has('') || values.has('')) return null;
  const loadNode = nodes.get(String(use.sourceEntityId));
  const storeNode = nodes.get(String(definition.sourceEntityId));
  if (!loadNode || loadNode.kind !== 'load' || loadNode.completeness !== 'complete'
      || !storeNode || storeNode.kind !== 'store' || storeNode.completeness !== 'complete'
      || !Array.isArray(loadNode.inputs) || loadNode.inputs.length !== 1
      || !Array.isArray(loadNode.outputs) || loadNode.outputs.length !== 1
      || !Array.isArray(storeNode.inputs) || storeNode.inputs.length !== 2
      || !metadataMatchesSemanticAccess(loadNode.memory, loadMetadata.memory)
      || !metadataMatchesSemanticAccess(storeNode.memory, storeMetadata.memory)) return null;

  const loadAddressValueId = String(loadNode.memory?.addressExpr?.valueId ?? loadNode.memory?.addressValueId ?? '');
  const storeAddressValueId = String(storeNode.memory?.addressExpr?.valueId ?? storeNode.memory?.addressValueId ?? '');
  if (!loadAddressValueId || !storeAddressValueId
      || String(loadNode.inputs[0] ?? '') !== loadAddressValueId
      || String(storeNode.inputs[0] ?? '') !== storeAddressValueId) return null;

  const storedValueId = String(storeNode.inputs[1] ?? '');
  const outputValueId = String(loadNode.outputs[0] ?? '');
  const storedValue = values.get(storedValueId);
  const outputValue = values.get(outputValueId);
  const widthBits = Number(loadMetadata.memory.widthBits);
  if (!storedValueId || !outputValueId || !storedValue || !outputValue
      || storedValue.machineType?.kind !== 'bitvector'
      || outputValue.machineType?.kind !== 'bitvector'
      || Number(storedValue.machineType?.widthBits) !== widthBits
      || Number(outputValue.machineType?.widthBits) !== widthBits) return null;

  if (semanticValueUseCount(ir, outputValueId) === 0) return null;
  if (semanticBlockMayBeJoin(ir, storeNode.blockId)) return null;
  if (semanticIntervalContainsCall(ir, storeNode, loadNode)) return null;

  return Object.freeze({
    status: 'exact',
    exact: true,
    proofKind: 'canonical-memoryssa-direct-stack-operand-identity',
    completeness: 'complete',
    artifactDigest: memorySsa.canonicalDigest,
    useId: String(use.id),
    definitionId: String(definition.id),
    loadSourceEntityId: String(use.sourceEntityId),
    storedSourceEntityId: String(definition.sourceEntityId),
    storedValueId,
    outputValueId,
    regionId: String(use.regionId),
    widthBits,
    endian: loadMetadata.memory.endian,
    range: loadMetadata.byteRange,
    semanticIrDigest: memorySsa.identity.semanticIrDigest,
  });
}
