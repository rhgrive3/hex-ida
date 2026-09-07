import { stableDigest } from '../../core/identity/index.js';
import { isCanonicalMemorySsaProducerArtifact } from './build.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  canonicalMemoryForwardingContext,
  forwardMemoryValue,
  isCanonicalExactMemoryOperandForwarding,
} from './queries.js';

/*
 * Compatibility projection may need the Semantic IR operand identity when a
 * store writes a non-constant value. Memory exactness belongs entirely to
 * the canonical query in queries.js; this module only checks the projected
 * node/value shape needed by the v2 -> v1 publication.
 */

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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

function semanticIndex(ir) {
  if (!Array.isArray(ir?.nodes) || !Array.isArray(ir?.values)) return null;
  const nodes = new Map(ir.nodes.map((node) => [String(node?.id ?? ''), node]));
  const values = new Map(ir.values.map((value) => [String(value?.id ?? ''), value]));
  if (nodes.has('') || values.has('')) return null;
  const useCounts = new Map();
  for (const node of ir.nodes) {
    for (const input of node?.inputs ?? []) {
      const inputId = String(input ?? '');
      if (inputId) useCounts.set(inputId, (useCounts.get(inputId) ?? 0) + 1);
    }
  }
  return { nodes, values, useCounts };
}

function metadataFor(memorySsa, id) {
  const rows = (memorySsa.accessMetadata ?? [])
    .filter((item) => String(item?.memorySsaEntityId ?? '') === String(id));
  return rows.length === 1 ? rows[0] : null;
}

function forwardingContext(memorySsa, use, fact) {
  const metadata = metadataFor(memorySsa, use.id);
  return canonicalMemoryForwardingContext(fact, {
    artifact: memorySsa,
    artifactDigest: memorySsa.canonicalDigest ?? null,
    snapshotId: memorySsa.snapshotId ?? null,
    useId: use.id,
    sourceEntityId: use.sourceEntityId,
    nodeId: metadata?.nodeId ?? use.sourceEntityId,
    entityId: metadata?.memorySsaEntityId ?? use.id,
    regionId: use.regionId,
    range: metadata?.byteRange ?? null,
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
  });
}

function semanticValueUseCount(index, valueId) {
  return index?.useCounts?.get(String(valueId ?? '')) ?? 0;
}

function canonicalFactFor(memorySsa, use, ir, fact) {
  if (fact != null) return fact;
  return forwardMemoryValue(memorySsa, use, {
    functionId: memorySsa.functionId,
    ...(memorySsa.buildVersion == null ? {} : { memorySsaBuildVersion: memorySsa.buildVersion }),
    consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
    requireOperand: true,
    ir,
  });
}

export function forwardExactStackOperandIdentity(memorySsa, useOrId, ir, options = {}) {
  if (!isCanonicalMemorySsaProducerArtifact(memorySsa)
      || !Array.isArray(memorySsa.uses)
      || !Array.isArray(memorySsa.regions)
      || !Array.isArray(memorySsa.accessMetadata)
      || !semanticIrMatches(memorySsa, ir)) return null;

  const useId = typeof useOrId === 'object' ? useOrId?.id : useOrId;
  const uses = memorySsa.uses.filter((item) => String(item?.id ?? '') === String(useId ?? ''));
  if (uses.length !== 1) return null;
  const use = uses[0];
  const fact = canonicalFactFor(memorySsa, use, ir, options.fact ?? null);
  const context = options.context ?? forwardingContext(memorySsa, use, fact);
  if (!isCanonicalExactMemoryOperandForwarding(fact, context)) return null;

  const region = memorySsa.regions.find((item) => String(item?.id ?? '') === String(use.regionId ?? ''));
  if (!region || region.kind !== 'stack-fixed'
      || String(fact.loadRegionId ?? '') !== String(use.regionId ?? '')) return null;
  const index = semanticIndex(ir);
  if (!index) return null;
  const loadNode = index.nodes.get(String(use.sourceEntityId));
  const storeNode = index.nodes.get(String(fact.storedSourceEntityId));
  if (!loadNode || loadNode.kind !== 'load' || loadNode.completeness !== 'complete'
      || !Array.isArray(loadNode.inputs) || loadNode.inputs.length !== 1
      || !Array.isArray(loadNode.outputs) || loadNode.outputs.length !== 1
      || !storeNode || storeNode.kind !== 'store' || storeNode.completeness !== 'complete'
      || !Array.isArray(storeNode.inputs) || storeNode.inputs.length !== 2
      || String(storeNode.inputs[1] ?? '') !== String(fact.storedValueId ?? '')) return null;

  const storedValue = index.values.get(String(fact.storedValueId));
  const outputValue = index.values.get(String(loadNode.outputs[0] ?? ''));
  const widthBits = Number(fact.widthBits);
  if (!storedValue || !outputValue
      || storedValue.machineType?.kind !== String(fact.operandKind ?? '')
      || outputValue.machineType?.kind !== String(fact.operandKind ?? '')
      || Number(storedValue.machineType?.widthBits) !== widthBits
      || Number(outputValue.machineType?.widthBits) !== widthBits
      || semanticValueUseCount(index, loadNode.outputs[0]) === 0) return null;

  return fact;
}
