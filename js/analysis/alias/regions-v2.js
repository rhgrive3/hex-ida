import {
  canonicalAddress,
  createMemoryRegionId,
  deepFreeze,
  jsonSafe,
  stableDigest,
} from '../../core/identity/index.js';
import { createOriginSet, mergeOriginSets } from '../../core/identity/origin.js';
import { createMemoryRegionRef } from '../../semantics/memoryssa/contract.js';
import { isCanonicalMemorySsaProducerArtifact } from '../../semantics/memoryssa/build.js';
import { normalizeAddressProofIr } from './address-ir-normalize-v2.js';
import {
  canonicalAddressProofToRegionEvidence,
  deriveCanonicalAddressProof,
} from './canonical-address-v2.js';

export const REGION_ALIAS_FLOOR_VERSION = '1.0.0';

const PRECISE_KINDS = new Set([
  'stack-fixed',
  'global-absolute',
  'rooted-offset',
  'tls',
  'io',
  'physical-space',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  const text = String(value ?? '').trim();
  return text || null;
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

function toBigIntString(value) {
  try { return (typeof value === 'bigint' ? value : BigInt(value)).toString(); }
  catch { return null; }
}

function memoryInteger(value) {
  const normalized = toBigIntString(value);
  return normalized == null ? null : BigInt(normalized);
}

function originHasEvidence(origin) {
  return !!origin && [
    'byteRanges', 'virtualRanges', 'instructionIds', 'operationIds',
    'sourceLocations', 'parentEntityIds', 'transforms',
  ].some((key) => Array.isArray(origin[key]) && origin[key].length > 0);
}

function normalizedOrigin(...origins) {
  const present = origins.filter((value) => value && typeof value === 'object');
  if (!present.length) return createOriginSet({});
  try { return mergeOriginSets(...present); }
  catch { return createOriginSet({}); }
}

function uniqueBinaryId(origin, explicit) {
  const direct = optionalIdentityString(explicit, 'binary-id');
  if (direct) return direct;
  const ids = new Set();
  for (const range of origin?.byteRanges ?? []) {
    if (range?.binaryId == null) continue;
    ids.add(optionalIdentityString(range.binaryId, 'binary-id'));
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function descriptorFrom(value) {
  const source = object(value);
  if (!source) return null;
  const direct = object(source.memoryRegion);
  if (direct) return direct;
  const provenance = object(source.provenance);
  return object(provenance?.memoryRegion) ?? object(provenance?.region) ?? null;
}

function descriptorCandidates(node, value, definingNode, explicit) {
  return [
    descriptorFrom(explicit) ?? object(explicit),
    descriptorFrom(node?.attributes),
    descriptorFrom(node?.metadata),
    descriptorFrom(value?.metadata),
    descriptorFrom(definingNode?.attributes),
    descriptorFrom(definingNode?.metadata),
  ].filter(Boolean);
}

function normalizeDescriptor(raw) {
  const descriptor = object(raw);
  if (!descriptor) return null;
  const kind = optionalIdentityString(descriptor.kind, 'kind');
  if (!kind) return null;
  return { ...descriptor, kind };
}

function memoryNodeDisplacement(node) {
  const machineEffects = node?.attributes?.machineEffects;
  const raw = machineEffects?.operationMetadata?.addressing?.addressDisplacement
    ?? machineEffects?.bundleMetadata?.addressing?.addressDisplacement;
  if (raw == null) return 0n;
  try {
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw);
    const text = String(raw).trim();
    if (!/^[+-]?(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) return null;
    return BigInt(text);
  } catch {
    return null;
  }
}

function canonicalMemoryAccessRow(memorySsa, entityId, nodeId, sourceKind, role) {
  const metadata = (memorySsa?.accessMetadata ?? []).find((item) =>
    String(item?.memorySsaEntityId ?? '') === String(entityId));
  if (!metadata
      || String(metadata.sourceEntityId ?? '') !== String(nodeId)
      || String(metadata.nodeId ?? '') !== String(nodeId)
      || String(metadata.sourceKind ?? '') !== String(sourceKind)
      || String(metadata.role ?? '') !== String(role)
      || metadata.broad === true) return null;
  return metadata;
}

/*
 * A register reload can carry an incoming pointer through a caller-local
 * stack slot.  The initial region pass cannot know that value's source (the
 * load output is intentionally opaque to the address proof), so the pipeline
 * may provide one already-built, branded MemorySSA artifact for a second
 * producer pass.  This resolver follows only:
 *
 *   scalar state-read -> scalar renamed definition -> canonical memory load
 *   -> canonical memory definition -> canonical store operand -> address root
 *
 * Every link is checked against the immutable artifact's own access table.
 * No projected instruction, legacy location, or caller-supplied witness is
 * consulted.  If any link is absent or ambiguous, classification stays
 * unknown and the ordinary conservative path remains in force.
 */
function canonicalMemoryPointerRegionEvidence(ir, node, options = {}) {
  const debug = process.env.HEX_DEBUG_C2_POINTER === '1';
  const memorySsa = options.canonicalMemorySsa;
  const ssa = options.ssa;
  if (debug) process.stderr.write(`pointer-hint inputs ${String(node?.id)} brand=${isCanonicalMemorySsaProducerArtifact(memorySsa)} fn=${String(memorySsa?.functionId)} irfn=${String(ir?.functionId)} md=${String(memorySsa?.identity?.semanticIrDigest)} id=${stableDigest(ir)} uses=${Array.isArray(memorySsa?.uses)} defs=${Array.isArray(memorySsa?.definitions)} meta=${Array.isArray(memorySsa?.accessMetadata)} ssa=${Boolean(ssa)}\n`);
  if (!isCanonicalMemorySsaProducerArtifact(memorySsa)
      || String(memorySsa.functionId ?? '') !== String(ir?.functionId ?? '')
      || String(memorySsa.identity?.semanticIrDigest ?? '') !== stableDigest(ir)
      || !Array.isArray(memorySsa.uses)
      || !Array.isArray(memorySsa.definitions)
      || !Array.isArray(memorySsa.accessMetadata)
      || !ssa || !Array.isArray(ssa.uses) || !Array.isArray(ssa.definitions)) {
    if (debug) process.stderr.write(`pointer-hint precondition failed ${String(node?.id)}\n`);
    return null;
  }
  const addressValueId = node?.memory?.addressExpr?.valueId;
  if (addressValueId == null) return null;
  const valuesById = new Map((ir.values ?? []).map((value) => [String(value.id), value]));
  const nodesById = new Map((ir.nodes ?? []).map((value) => [String(value.id), value]));
  const addressValue = valuesById.get(String(addressValueId));
  const addressDefinition = addressValue?.definitionNodeId == null
    ? null : nodesById.get(String(addressValue.definitionNodeId));
  let addressRead = addressDefinition;
  let addressReadValueId = addressValueId;
  let addressOffset = 0n;
  if (addressDefinition && ['address', 'binary', 'intrinsic'].includes(addressDefinition.kind)
      && String(addressDefinition.operator ?? '').toLowerCase() === 'add'
      && Array.isArray(addressDefinition.inputs) && addressDefinition.inputs.length === 2) {
    const inputValues = addressDefinition.inputs.map((inputId) => valuesById.get(String(inputId)));
    const constantIndex = inputValues.findIndex((value) => value?.metadata?.constant?.kind === 'bitvector');
    const baseIndex = constantIndex === 0 ? 1 : constantIndex === 1 ? 0 : -1;
    if (baseIndex >= 0) {
      const constant = memoryInteger(inputValues[constantIndex]?.metadata?.constant?.value);
      const baseValue = inputValues[baseIndex];
      if (constant != null && baseValue?.definitionNodeId != null) {
        addressOffset = constant;
        addressReadValueId = baseValue.id;
        addressRead = nodesById.get(String(baseValue.definitionNodeId));
      }
    }
  }
  if (!addressRead || addressRead.kind !== 'state-read') {
    if (debug) process.stderr.write(`pointer-hint address read failed ${String(node?.id)} ${String(addressRead?.kind)}\n`);
    return null;
  }

  const stateUses = ssa.uses.filter((use) => String(use.sourceEntityId ?? '') === String(addressRead.id)
    && use.proof?.kind === 'renamed-use'
    && String(use.proof?.sourceSemanticValueId ?? addressReadValueId) === String(addressReadValueId));
  const candidates = [];
  if (debug) process.stderr.write(`pointer-hint state uses ${String(node?.id)} ${stateUses.length}\n`);
  for (const stateUse of stateUses) {
    const scalarDefinition = ssa.definitions.find((definition) =>
      String(definition.valueId ?? '') === String(stateUse.valueId ?? '')
      && definition.proof?.kind === 'renamed-definition');
    const loadedSemanticValueId = scalarDefinition?.proof?.sourceSemanticValueId;
    const loadedValue = loadedSemanticValueId == null ? null : valuesById.get(String(loadedSemanticValueId));
    const loadNode = loadedValue?.definitionNodeId == null
      ? null : nodesById.get(String(loadedValue.definitionNodeId));
    if (!loadNode || loadNode.kind !== 'load') continue;
    const loadUses = memorySsa.uses.filter((use) => String(use.sourceEntityId ?? '') === String(loadNode.id)
      && use.aliasRelation === 'must');
    if (loadUses.length !== 1) continue;
    const loadUse = loadUses[0];
    const loadMetadata = canonicalMemoryAccessRow(memorySsa, loadUse.id, loadNode.id, 'load', 'read');
    if (!loadMetadata) continue;
    const reachingDefinition = memorySsa.definitions.find((definition) =>
      String(definition.id ?? '') === String(loadUse.reachingDefinitionId ?? '')
      && definition.kind === 'memory-def');
    if (!reachingDefinition) continue;
    const storeNode = nodesById.get(String(reachingDefinition.sourceEntityId ?? ''));
    if (!storeNode || storeNode.kind !== 'store' || !Array.isArray(storeNode.inputs)
        || storeNode.inputs.length !== 2) continue;
    const storeMetadata = canonicalMemoryAccessRow(
      memorySsa,
      reachingDefinition.id,
      storeNode.id,
      'store',
      'write',
    );
    if (!storeMetadata) continue;
    // Semantic memory stores use [address, value]; the reloaded pointer is
    // the stored value, not the stack-slot address.
    const rootValueId = storeNode.inputs[1];
    const rootProof = deriveCanonicalAddressProof(ir, rootValueId, {
      addressSpace: node.memory?.addressSpace,
      ssa,
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
  if (debug) process.stderr.write(`pointer-hint candidates ${String(node?.id)} ${candidates.length}\n`);
  if (candidates.length !== 1) return null;
  return candidates[0];
}

function descriptorWithProofMetadata(descriptor, proof) {
  if (!descriptor || !proof) return descriptor;
  const rootIdentity = object(proof.rootIdentity);
  const storageClass = nonEmpty(rootIdentity?.storageClass);
  return {
    ...descriptor,
    metadata: {
      ...(object(descriptor.metadata) ?? {}),
      ...(storageClass == null ? {} : { canonicalRootStorageClass: storageClass }),
      canonicalAddressIncludesOperationDisplacement: true,
    },
  };
}

function unknownRegion({ functionId, binaryId, widthBits, origin, sourceEntityId, addressValueId, addressSpace, reason, metadata }) {
  const normalizedWidth = Number.isSafeInteger(Number(widthBits)) && Number(widthBits) > 0 ? Number(widthBits) : null;
  const uncertaintyIdentity = {
    sourceEntityId: optionalIdentityString(sourceEntityId, 'source-entity-id'),
    addressValueId: optionalIdentityString(addressValueId, 'address-value-id'),
    addressSpace: optionalIdentityString(addressSpace, 'address-space'),
    ...(normalizedWidth == null ? {} : { widthBits: normalizedWidth }),
    reason: nonEmpty(reason) ?? 'unproven-memory-region',
  };
  const scope = functionId ? { functionId, binaryId } : { binaryId };
  if (!scope.functionId && !scope.binaryId) {
    throw new TypeError('alias-region-scope-required');
  }
  const id = createMemoryRegionId({
    ...scope,
    regionKind: 'unknown',
    canonicalRegionIdentity: uncertaintyIdentity,
  });
  return createMemoryRegionRef({
    id,
    kind: 'unknown',
    ...scope,
    uncertaintyIdentity,
    ...(normalizedWidth == null ? {} : { widthBits: normalizedWidth }),
    ...(originHasEvidence(origin) ? { origin } : {}),
    metadata: jsonSafe({ reason: uncertaintyIdentity.reason, ...(object(metadata) ?? {}) }),
  });
}

function preciseRegion({ descriptor, functionId, binaryId, widthBits, origin, addressSpace, addressValueId }) {
  const kind = descriptor.kind;
  if (!PRECISE_KINDS.has(kind) || !originHasEvidence(origin)) return null;
  const normalizedWidth = Number(widthBits);
  const scope = { functionId: functionId ?? null, binaryId: binaryId ?? null };
  const common = { kind, widthBits: normalizedWidth, origin };
  let canonicalRegionIdentity;
  let specific;

  if (kind === 'stack-fixed') {
    const offset = toBigIntString(descriptor.offset);
    if (!scope.functionId || offset == null) return null;
    canonicalRegionIdentity = { offset, widthBits: normalizedWidth };
    specific = { functionId: scope.functionId, ...(scope.binaryId ? { binaryId: scope.binaryId } : {}), offset };
  } else if (kind === 'global-absolute') {
    const rawAddress = descriptor.address ?? descriptor.absoluteAddress;
    if (!scope.binaryId || rawAddress == null) return null;
    let address;
    try { address = canonicalAddress(rawAddress); }
    catch { return null; }
    canonicalRegionIdentity = { address, widthBits: normalizedWidth };
    specific = { binaryId: scope.binaryId, ...(scope.functionId ? { functionId: scope.functionId } : {}), address };
  } else if (kind === 'rooted-offset') {
    const rootEntityId = optionalIdentityString(descriptor.rootEntityId ?? descriptor.rootId, 'root-entity-id');
    const offset = toBigIntString(descriptor.offset ?? 0);
    if (!rootEntityId || offset == null || (!scope.functionId && !scope.binaryId)) return null;
    canonicalRegionIdentity = { rootEntityId, offset, widthBits: normalizedWidth };
    specific = { ...(scope.functionId ? { functionId: scope.functionId } : {}), ...(scope.binaryId ? { binaryId: scope.binaryId } : {}), rootEntityId, offset };
  } else {
    const explicitSpace = optionalIdentityString(descriptor.addressSpace ?? addressSpace, 'address-space');
    if (!explicitSpace || (!scope.functionId && !scope.binaryId)) return null;
    const rootIdentity = descriptor.rootIdentity ?? (addressValueId ? { addressValueId } : null);
    if (rootIdentity == null) return null;
    canonicalRegionIdentity = { addressSpace: explicitSpace, rootIdentity: jsonSafe(rootIdentity), widthBits: normalizedWidth };
    specific = {
      ...(scope.functionId ? { functionId: scope.functionId } : {}),
      ...(scope.binaryId ? { binaryId: scope.binaryId } : {}),
      addressSpace: explicitSpace,
      ...(rootIdentity == null ? {} : { rootIdentity }),
    };
  }

  const id = createMemoryRegionId({
    functionId: specific.functionId ?? null,
    binaryId: specific.binaryId ?? null,
    regionKind: kind,
    canonicalRegionIdentity,
  });
  return createMemoryRegionRef({
    id,
    ...common,
    ...specific,
    ...(descriptor.metadata == null ? {} : { metadata: descriptor.metadata }),
  });
}

export function deriveMemoryRegion(input = {}) {
  const memory = object(input.memory) ?? {};
  const origin = normalizedOrigin(input.origin);
  const functionId = optionalIdentityString(input.functionId, 'function-id');
  const binaryId = uniqueBinaryId(origin, input.binaryId);
  const widthBits = Number(memory.widthBits ?? input.widthBits);
  const addressSpace = optionalIdentityString(memory.addressSpace ?? input.addressSpace, 'address-space');
  const addressValueId = optionalIdentityString(memory.addressExpr?.valueId ?? input.addressValueId, 'address-value-id');
  const descriptor = normalizeDescriptor(input.regionEvidence ?? input.provenance ?? input.metadata);

  const precise = descriptor && Number.isSafeInteger(widthBits) && widthBits > 0
    ? preciseRegion({ descriptor, functionId, binaryId, widthBits, origin, addressSpace, addressValueId })
    : null;
  if (precise) return precise;

  if (originHasEvidence(origin) && Number.isSafeInteger(widthBits) && widthBits > 0 && (addressSpace === 'tls' || addressSpace === 'io')) {
    const inferred = preciseRegion({
      descriptor: { kind: addressSpace, addressSpace, rootIdentity: addressValueId ? { addressValueId } : null },
      functionId,
      binaryId,
      widthBits,
      origin,
      addressSpace,
      addressValueId,
    });
    if (inferred) return inferred;
  }

  return unknownRegion({
    functionId,
    binaryId,
    widthBits,
    origin,
    sourceEntityId: input.sourceEntityId,
    addressValueId,
    addressSpace,
    reason: descriptor ? 'malformed-or-unproven-region-evidence' : 'missing-region-provenance',
    metadata: object(input.unknownMetadata),
  });
}

function irForAddressRootDerivation(ir) {
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  // A flags-only unknown state effect cannot mutate a non-flag physical root.
  // Only apply this projection when no flag state value is read anywhere in the
  // function, so a flag-derived address can never gain precision accidentally.
  const readsFlagState = nodes.some((node) => node?.kind === 'state-read' && node.variable?.physicalIdentity?.kind === 'flag');
  if (readsFlagState) return ir;
  const ignored = new Set(nodes.filter((node) => {
    if (node?.kind !== 'unknown-state-write') return false;
    const categories = Array.isArray(node.unknown?.categories) ? node.unknown.categories : [];
    return categories.length > 0 && categories.every((category) => category === 'flags');
  }).map((node) => String(node.id)));
  if (!ignored.size) return ir;
  return {
    ...ir,
    nodes: nodes.filter((node) => !ignored.has(String(node.id))),
    blocks: (ir.blocks ?? []).map((block) => ({
      ...block,
      nodeIds: (block.nodeIds ?? []).filter((nodeId) => !ignored.has(String(nodeId))),
    })),
  };
}

// Both derivations are pure functions of the IR object. Rebuilding them for
// every memory access makes region classification quadratic; the core proof
// cache also needs a stable IR identity to hit, so memoize per source IR.
const addressProofIrMemo = new WeakMap();
function addressProofIrFor(ir) {
  let derived = addressProofIrMemo.get(ir);
  if (derived === undefined) {
    derived = normalizeAddressProofIr(irForAddressRootDerivation(ir));
    addressProofIrMemo.set(ir, derived);
  }
  return derived;
}

export function classifySemanticMemoryRegion(ir, nodeOrId, options = {}) {
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  const values = Array.isArray(ir?.values) ? ir.values : [];
  const node = typeof nodeOrId === 'string' ? nodes.find((item) => item.id === nodeOrId) : nodeOrId;
  if (!node || (node.kind !== 'load' && node.kind !== 'store') || !object(node.memory)) {
    return unknownRegion({
      functionId: optionalIdentityString(ir?.functionId, 'function-id'),
      binaryId: optionalIdentityString(options.binaryId, 'binary-id'),
      origin: normalizedOrigin(node?.origin, ir?.origin),
      sourceEntityId: node?.id ?? null,
      reason: 'malformed-memory-node',
    });
  }

  const addressValueId = optionalIdentityString(node.memory.addressExpr?.valueId, 'address-value-id');
  const value = addressValueId ? values.find((item) => item.id === addressValueId) : null;
  const definingNode = value?.definitionNodeId ? nodes.find((item) => item.id === value.definitionNodeId) : null;
  const accessOrigin = normalizedOrigin(node.origin, value?.origin, definingNode?.origin);
  const explicitDescriptor = descriptorCandidates(node, value, definingNode, options.regionEvidence)
    .map(normalizeDescriptor)
    .find(Boolean) ?? null;

  let proof = null;
  let graphDescriptor = null;
  if (!explicitDescriptor && addressValueId) {
    const proofIr = addressProofIrFor(ir);
    proof = deriveCanonicalAddressProof(proofIr, addressValueId, {
      addressSpace: node.memory.addressSpace,
      ssa: options.ssa,
      rootDescriptors: options.rootDescriptors,
      rootDescriptorProvider: options.rootDescriptorProvider,
    });
    graphDescriptor = descriptorWithProofMetadata(canonicalAddressProofToRegionEvidence(proof), proof);
  }
  const memoryPointerDescriptor = !explicitDescriptor && graphDescriptor == null
    ? canonicalMemoryPointerRegionEvidence(ir, node, options)
    : null;
  const descriptor = explicitDescriptor ?? graphDescriptor ?? memoryPointerDescriptor;
  const derivationMetadata = proof == null ? null : {
    canonicalAddressKind: proof.kind,
    ...(proof.reason == null ? {} : { canonicalAddressReason: proof.reason }),
  };
  // A canonical region is shared by every equivalent access. Its descriptor
  // therefore uses the function-level IR origin instead of an access-local
  // origin; otherwise equal MemoryRegionIds would carry conflicting objects.
  const regionOrigin = graphDescriptor || memoryPointerDescriptor ? normalizedOrigin(ir.origin) : accessOrigin;

  return deriveMemoryRegion({
    functionId: ir.functionId,
    binaryId: options.binaryId ?? ir.binaryId ?? ir.metadata?.binaryId,
    memory: node.memory,
    origin: regionOrigin,
    sourceEntityId: node.id,
    addressValueId,
    regionEvidence: descriptor,
    unknownMetadata: {
      ...(object(options.unknownMetadata) ?? {}),
      ...(derivationMetadata ?? {}),
    },
  });
}

export function isPreciseMemoryRegion(region) {
  return !!region && PRECISE_KINDS.has(region.kind) && originHasEvidence(region.origin);
}

export function sameMemoryRegionIdentity(a, b) {
  return !!a && !!b && a.id === b.id;
}

export const __regionInternalsForTests = deepFreeze({ originHasEvidence });
