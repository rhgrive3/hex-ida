import {
  canonicalAddress,
  createMemoryRegionId,
  deepFreeze,
  jsonSafe,
  stableDigest,
  validateCanonicalIdentityNumbers,
} from '../../core/identity/index.js';
import { createOriginSet, mergeOriginSets } from '../../core/identity/origin.js';
import { createMemoryRegionRef } from '../../semantics/memoryssa/contract.js';
import { isCanonicalMemorySsaProducerArtifact } from '../../semantics/memoryssa/build.js';
import {
  canonicalSemanticSsaProducerBindingForIr,
  canonicalSemanticSsaProducerMatches,
  canonicalSemanticSsaRowMatches,
} from '../../semantics/ssa/build.js';
import { normalizeAddressProofIr } from './address-ir-normalize-v2.js';
import { FLAT_MEMORY_SPACE, canonicalAddressSpace } from './address-space.js';
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

// Address space is proof-bearing: it can mint a strong `NoAlias` and it feeds
// canonical region identity. A region therefore stores the *canonical* token,
// never the spelling it happened to receive, so case/whitespace drift cannot add
// a physical-space dimension to one region's identity or separate two regions
// that name the same domain (#8879). Shape errors keep the strict failure.
function canonicalAddressSpaceField(value, label) {
  if (value == null) return null;
  const text = canonicalAddressSpace(value);
  if (!text) throw new TypeError(`alias-region-invalid-${label}`);
  return text;
}

function toBigIntString(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value).toString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]?(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
      try { return BigInt(trimmed).toString(); } catch {}
    }
  }
  return null;
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
  const ids = new Set();
  for (const range of origin?.byteRanges ?? []) {
    if (range?.binaryId == null) continue;
    ids.add(optionalIdentityString(range.binaryId, 'binary-id'));
  }
  // Explicit identity and byte provenance are co-authorities. A direct claim
  // may not contradict provenance, and it may not collapse provenance that
  // spans multiple binaries into one precise binary scope (#5218). Without an
  // explicit claim, however, multi-binary provenance keeps the historical
  // conservative path: no unique binary authority is available, so callers
  // can fall back to an unknown/non-binary-scoped region instead of throwing.
  if (direct && (ids.size > 1 || (ids.size === 1 && !ids.has(direct)))) {
    throw new TypeError('alias-region-binary-identity-mismatch');
  }
  if (direct) return direct;
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
// The scalar SSA rows consumed below are proof authority for the reload
// chain, but the scalar contract carries no content binding (unlike the
// branded, digest-bound MemorySSA artifact), so a hand-made object can weld an
// unrelated state-read onto an arbitrary load→store chain (#4777). The builder
// scheme is deterministic, so genuineness of exactly the rows this chain
// consumes is verifiable against the IR: a renamed link must carry the state
// variable's identity, sit in the IR block that contains the access node, use
// the builder's transform metadata, and the paired definition must be a
// content-addressed definition of the same variable variant. Anything else is
// rejected and the conservative unknown-region path stays in force.
function ssaVariableIdentity(variable) {
  if (!variable) return null;
  return {
    key: String(variable.key),
    kind: String(variable.kind),
    scope: String(variable.scope),
    ...(variable.physicalIdentity == null ? {} : { physicalIdentity: variable.physicalIdentity }),
  };
}

// The canonical semantic IR digest is a pure function of the IR object. Recomputing
// it for every memory access makes region classification quadratic; memoize per source IR.
const semanticIrDigestMemo = new WeakMap();

/**
 * Computes or retrieves a memoized stable digest for a semantic IR object.
 * Uses a module-scoped WeakMap to avoid repeated quadratic digest computation across memory accesses.
 *
 * @param {object|*} ir - The semantic IR object (or primitive value)
 * @returns {string} The canonical stable digest string
 */
export function semanticIrDigestFor(ir, ssa = null) {
  if (!ir || typeof ir !== 'object') return stableDigest(ir);
  const producerBinding = canonicalSemanticSsaProducerBindingForIr(ssa, ir);
  if (producerBinding?.semanticIrDigest) return producerBinding.semanticIrDigest;
  let digest = semanticIrDigestMemo.get(ir);
  if (digest === undefined) {
    digest = stableDigest(ir);
    semanticIrDigestMemo.set(ir, digest);
  }
  return digest;
}

const irIndexMemo = new WeakMap();

/**
 * Retrieves or builds a cached index of values, nodes, and block mappings for an immutable Semantic IR.
 *
 * @param {object|*} ir - The semantic IR function
 * @returns {{ valuesById: Map<string, object>, nodesById: Map<string, object>, blockIdByNode: Map<string, string> }}
 */
function irIndexFor(ir) {
  if (!ir || typeof ir !== 'object') {
    return {
      valuesById: new Map(),
      nodesById: new Map(),
      blockIdByNode: new Map(),
    };
  }
  let index = irIndexMemo.get(ir);
  if (index === undefined) {
    const valuesById = new Map((ir.values ?? []).map((value) => [String(value.id), value]));
    const nodesById = new Map((ir.nodes ?? []).map((node) => [String(node.id), node]));
    const blockIdByNode = new Map();
    for (const block of ir.blocks ?? []) {
      for (const nodeId of block?.nodeIds ?? []) blockIdByNode.set(String(nodeId), String(block.id));
    }
    index = { valuesById, nodesById, blockIdByNode };
    irIndexMemo.set(ir, index);
  }
  return index;
}

function sameVariableIdentity(left, right) {
  return stableDigest(left) === stableDigest(right);
}

/**
 * Verifies that a candidate renamed-use scalar SSA row matches the semantic IR and access node.
 *
 * @param {object} ir - The semantic IR function
 * @param {object} use - The candidate scalar SSA use row
 * @param {object} addressRead - The semantic address read node
 * @param {string|number} addressReadValueId - The value ID of the address read
 * @param {Map<string, string>} blockIdByNode - Mapping from node ID to containing block ID
 * @param {object} [options={}] - Additional options containing SSA and binding context
 * @returns {boolean} True if the renamed use row is genuine and matches the IR
 */
export function genuineRenamedUseRow(ir, use, addressRead, addressReadValueId, blockIdByNode, options = {}) {
  const ssa = options?.ssa;
  const binding = options?.binding;
  if (!ssa || !binding) return false;
  if (binding.snapshotId == null) return false;
  if (ir?.functionId == null || String(binding.functionId) !== String(ir.functionId)) return false;
  if (String(binding.semanticIrDigest) !== semanticIrDigestFor(ir, ssa)) return false;
  if (!canonicalSemanticSsaProducerMatches(ssa, binding)) return false;
  if (!canonicalSemanticSsaRowMatches(use, ssa)) return false;
  const proof = use?.proof;
  if (!proof || proof.kind !== 'renamed-use') return false;
  if (String(use.sourceEntityId ?? '') !== String(addressRead.id)) return false;
  // A first read of a variable carries a null source value and defaults to the
  // read's own semantic value; a spelled source must agree with it.
  if (proof.sourceSemanticValueId != null
      && String(proof.sourceSemanticValueId) !== String(addressReadValueId)) return false;
  if (String(proof.sourceSemanticEntityId ?? '') !== String(use.sourceEntityId ?? '')) return false;
  if (proof.transform?.ruleId !== 'rename-use' || proof.transform?.proofKind !== 'dominance-renaming') return false;
  if (!sameVariableIdentity(proof.variableIdentity, ssaVariableIdentity(addressRead.variable))) return false;
  // A rename source must be a value the linked node actually produces.
  if (proof.sourceSemanticValueId != null
      && !(Array.isArray(addressRead.outputs) && addressRead.outputs.map(String).includes(String(proof.sourceSemanticValueId)))) return false;
  return blockIdByNode.get(String(addressRead.id)) != null
    && String(use.blockId ?? '') === String(blockIdByNode.get(String(addressRead.id)));
}

/**
 * Verifies that a candidate renamed-definition scalar SSA row matches the semantic IR and reaching state use.
 *
 * @param {object} ir - The semantic IR function
 * @param {object} definition - The candidate scalar SSA definition row
 * @param {object} stateUse - The reaching state use row
 * @param {object} addressRead - The semantic address read node
 * @param {string|number|null} loadedSemanticValueId - The semantic value ID loaded by the memory operation
 * @param {Map<string, object>} nodesById - Map of nodes by ID
 * @param {object} [options={}] - Additional options containing SSA and binding context
 * @returns {boolean} True if the renamed definition row is genuine and matches the IR
 */
export function genuineRenamedDefinitionRow(ir, definition, stateUse, addressRead, loadedSemanticValueId, nodesById, options = {}) {
  const ssa = options?.ssa;
  const binding = options?.binding;
  if (!ssa || !binding) return false;
  if (binding.snapshotId == null) return false;
  if (ir?.functionId == null || String(binding.functionId) !== String(ir.functionId)) return false;
  if (String(binding.semanticIrDigest) !== semanticIrDigestFor(ir, ssa)) return false;
  if (!canonicalSemanticSsaProducerMatches(ssa, binding)) return false;
  if (!canonicalSemanticSsaRowMatches(definition, ssa)) return false;
  const proof = definition?.proof;
  if (!proof || proof.kind !== 'renamed-definition') return false;
  if (String(definition.valueId ?? '') !== String(stateUse.valueId ?? '')) return false;
  if (loadedSemanticValueId != null && String(proof.sourceSemanticValueId ?? '') !== String(loadedSemanticValueId)) return false;
  if (String(proof.sourceSemanticEntityId ?? '') !== String(definition.sourceEntityId ?? '')) return false;
  if (proof.transform?.ruleId !== 'rename-definition' || proof.transform?.proofKind !== 'dominance-renaming') return false;
  if (!sameVariableIdentity(proof.variableIdentity, ssaVariableIdentity(addressRead.variable))) return false;
  // The reaching definition of a renamed use belongs to the same variable
  // variant. Variant keys are the source key, or the source key with a
  // machine-type collision suffix.
  const variantKey = proof.variableIdentity?.key == null ? null : String(proof.variableIdentity.key);
  const definitionKey = definition.variableKey == null ? null : String(definition.variableKey);
  if (variantKey == null || definitionKey == null) return false;
  if (definitionKey !== variantKey && !definitionKey.startsWith(`${variantKey}::`)) return false;
  const writingNode = nodesById?.get(String(definition.sourceEntityId ?? ''));
  if (writingNode) {
    if (writingNode.kind === 'state-write') {
      if (proof.sourceSemanticValueId != null && Array.isArray(writingNode.inputs)
          && !writingNode.inputs.map(String).includes(String(proof.sourceSemanticValueId))) return false;
    } else if (writingNode.kind !== 'load') {
      return false;
    }
  }
  // A state-variable rename consumes the value flowing through the variable,
  // which is not an output of the writing node — only the builder metadata
  // above binds it.
  return String(definition.definitionId ?? '')
    === `ssa_def_${stableDigest({ functionId: ir.functionId, valueId: definition.valueId })}`;
}

/**
 * Derives canonical memory pointer region evidence for a node from trusted MemorySSA artifacts.
 *
 * @param {object} ir - The semantic IR function
 * @param {object} node - The memory access node
 * @param {object} [options={}] - Options containing canonical MemorySSA and scalar SSA artifacts
 * @returns {object|null} The canonical region evidence, or null if unverified
 */
export function canonicalMemoryPointerRegionEvidence(ir, node, options = {}) {
  const debug = typeof process !== 'undefined'
    && process?.env?.HEX_DEBUG_C2_POINTER === '1'
    && typeof process?.stderr?.write === 'function';
  const memorySsa = options.canonicalMemorySsa;
  const ssa = options.ssa;
  const semanticIrDigest = semanticIrDigestFor(ir, ssa);
  if (debug) {
    process.stderr.write(`pointer-hint inputs ${String(node?.id)} brand=${isCanonicalMemorySsaProducerArtifact(memorySsa)} fn=${String(memorySsa?.functionId)} irfn=${String(ir?.functionId)} md=${String(memorySsa?.identity?.semanticIrDigest)} id=${semanticIrDigest} uses=${Array.isArray(memorySsa?.uses)} defs=${Array.isArray(memorySsa?.definitions)} meta=${Array.isArray(memorySsa?.accessMetadata)} ssa=${Boolean(ssa)}\n`);
  }
  const identity = memorySsa?.identity;
  const scalarSsaDigest = typeof identity?.scalarSsaDigest === 'string' && identity.scalarSsaDigest.trim()
    ? identity.scalarSsaDigest.trim() : null;
  const snapshotId = typeof memorySsa?.snapshotId === 'string' && memorySsa.snapshotId.trim()
    ? memorySsa.snapshotId.trim() : null;
  const identitySnapshotId = typeof identity?.snapshotId === 'string' && identity.snapshotId.trim()
    ? identity.snapshotId.trim() : null;
  const binding = Object.freeze({
    functionId: ir?.functionId,
    semanticIrDigest,
    scalarSsaDigest,
    snapshotId,
  });
  if (!isCanonicalMemorySsaProducerArtifact(memorySsa)
      || String(memorySsa.functionId ?? '') !== String(ir?.functionId ?? '')
      || String(identity?.functionId ?? '') !== String(ir?.functionId ?? '')
      || String(identity?.semanticIrDigest ?? '') !== semanticIrDigest
      || scalarSsaDigest == null
      || snapshotId == null
      || identitySnapshotId == null
      || snapshotId !== identitySnapshotId
      || !canonicalSemanticSsaProducerMatches(ssa, binding)
      || !Array.isArray(memorySsa.uses)
      || !Array.isArray(memorySsa.definitions)
      || !Array.isArray(memorySsa.accessMetadata)
      || !ssa || !Array.isArray(ssa.uses) || !Array.isArray(ssa.definitions)) {
    return null;
  }
  const addressValueId = node?.memory?.addressExpr?.valueId;
  if (addressValueId == null) return null;
  const { valuesById, nodesById, blockIdByNode } = irIndexFor(ir);
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
    return null;
  }

  const stateUses = ssa.uses.filter((use) => String(use.sourceEntityId ?? '') === String(addressRead.id)
    && use.proof?.kind === 'renamed-use'
    && String(use.proof?.sourceSemanticValueId ?? addressReadValueId) === String(addressReadValueId)
    && genuineRenamedUseRow(ir, use, addressRead, addressReadValueId, blockIdByNode, { ssa, binding }));
  const candidates = [];
  for (const stateUse of stateUses) {
    const scalarDefinition = ssa.definitions.find((definition) =>
      String(definition.valueId ?? '') === String(stateUse.valueId ?? '')
      && definition.proof?.kind === 'renamed-definition'
      && genuineRenamedDefinitionRow(ir, definition, stateUse, addressRead, definition?.proof?.sourceSemanticValueId, nodesById, { ssa, binding }));
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
    // `root-only` means "same root, exact offset NOT proven" — mergeAlternatives
    // mints it when two paths through one root disagree on the offset. It is
    // not evidence for offset 0: converting it into a precise rooted-offset /
    // stack-fixed descriptor would fabricate exact separation (#5729), so the
    // conservative unknown-region path stays in force.
    if (rootProof?.kind === 'root-only') continue;
    const rootOffset = rootProof.offset;
    if (rootOffset == null) continue;
    const offset = rootOffset + addressOffset;
    if (rootKind === 'stack-like') {
      candidates.push({
        kind: 'stack-fixed',
        offset: offset.toString(),
        metadata: { canonicalAddressIncludesOperationDisplacement: true },
      });
    } else if (rootProof.rootEntityId != null) {
      const rootProofSpace = canonicalAddressSpace(rootProof.addressSpace);
      candidates.push({
        kind: 'rooted-offset',
        rootEntityId: String(rootProof.rootEntityId),
        offset: offset.toString(),
        // Keep the proof's non-memory storage domain (#5901), compared on the
        // canonical token so a case drift of flat memory cannot masquerade as a
        // genuine non-memory domain (#8879).
        ...(rootProofSpace && rootProofSpace !== FLAT_MEMORY_SPACE
          ? { addressSpace: rootProofSpace } : {}),
        metadata: {
          canonicalAddressIncludesOperationDisplacement: true,
          ...(rootProof.rootIdentity?.storageClass == null ? {} : {
            canonicalRootStorageClass: String(rootProof.rootIdentity.storageClass),
          }),
        },
      });
    }
  }
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
    addressSpace: canonicalAddressSpaceField(addressSpace, 'address-space'),
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
    // A rooted-offset region must keep the storage domain its canonical proof
    // proved (#5901): a tls/io-rooted region is not flat memory and must not
    // share an identity with a same-root memory region.
    const rootedSpace = canonicalAddressSpaceField(descriptor.addressSpace, 'address-space');
    canonicalRegionIdentity = { rootEntityId, offset, widthBits: normalizedWidth, ...(rootedSpace ? { addressSpace: rootedSpace } : {}) };
    specific = { ...(scope.functionId ? { functionId: scope.functionId } : {}), ...(scope.binaryId ? { binaryId: scope.binaryId } : {}), rootEntityId, offset, ...(rootedSpace ? { addressSpace: rootedSpace } : {}) };
  } else {
    const explicitSpace = canonicalAddressSpaceField(descriptor.addressSpace ?? addressSpace, 'address-space');
    if (!explicitSpace || (!scope.functionId && !scope.binaryId)) return null;
    const rootIdentity = descriptor.rootIdentity ?? (addressValueId ? { addressValueId } : null);
    if (rootIdentity == null) return null;
    try { validateCanonicalIdentityNumbers(rootIdentity); } catch { return null; }
    canonicalRegionIdentity = { addressSpace: explicitSpace, rootIdentity, widthBits: normalizedWidth };
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

function deriveMemoryRegionWithCandidates(input = {}, rawEvidenceCandidates = null) {
  const memory = object(input.memory) ?? {};
  const origin = normalizedOrigin(input.origin);
  const functionId = optionalIdentityString(input.functionId, 'function-id');
  const binaryId = uniqueBinaryId(origin, input.binaryId);
  const rawWidthBits = memory.widthBits ?? input.widthBits;
  const widthBits = typeof rawWidthBits === 'number'
    && Number.isSafeInteger(rawWidthBits)
    && rawWidthBits > 0
    ? rawWidthBits
    : null;
  const addressSpace = canonicalAddressSpaceField(memory.addressSpace ?? input.addressSpace, 'address-space');
  const addressValueId = optionalIdentityString(memory.addressExpr?.valueId ?? input.addressValueId, 'address-value-id');
  const evidenceCandidates = Array.isArray(rawEvidenceCandidates)
    ? rawEvidenceCandidates.map(normalizeDescriptor).filter(Boolean)
    : null;
  let descriptor = evidenceCandidates?.[0]
    ?? normalizeDescriptor(input.regionEvidence ?? input.provenance ?? input.metadata);
  let comparableCandidates = evidenceCandidates;
  let descriptorConflict = false;

  if (descriptor && evidenceCandidates?.length > 1 && PRECISE_KINDS.has(descriptor.kind)) {
    const preciseKindCandidates = evidenceCandidates.filter((candidate) => PRECISE_KINDS.has(candidate.kind));
    descriptorConflict = preciseKindCandidates.some((candidate) => candidate.kind !== descriptor.kind);

    // rooted-offset addressSpace is optional proof detail. One source may
    // supply the storage domain while another supplies the same root/offset.
    // Merge that one-way refinement before comparing canonical identities so
    // source ordering cannot turn compatible evidence into a false conflict.
    if (!descriptorConflict && descriptor.kind === 'rooted-offset') {
      const spaces = new Set();
      for (const candidate of preciseKindCandidates) {
        if (candidate.kind !== 'rooted-offset' || candidate.addressSpace == null) continue;
        try {
          const candidateSpace = canonicalAddressSpaceField(candidate.addressSpace, 'address-space');
          if (candidateSpace) spaces.add(candidateSpace);
        } catch {
          // Malformed auxiliary metadata is not proof-grade authority.
        }
      }
      if (spaces.size > 1) {
        descriptorConflict = true;
      } else if (spaces.size === 1) {
        const [consensusSpace] = spaces;
        if (descriptor.addressSpace == null) descriptor = { ...descriptor, addressSpace: consensusSpace };
        comparableCandidates = evidenceCandidates.map((candidate) =>
          candidate.kind === 'rooted-offset' && candidate.addressSpace == null
            ? { ...candidate, addressSpace: consensusSpace }
            : candidate);
      }
    }
  }

  const conflictingRegion = () => unknownRegion({
    functionId,
    binaryId,
    widthBits,
    origin,
    sourceEntityId: input.sourceEntityId,
    addressValueId,
    addressSpace,
    reason: 'conflicting-region-evidence',
    metadata: {
      ...(object(input.unknownMetadata) ?? {}),
      regionEvidenceConflict: true,
      regionEvidenceCandidateCount: evidenceCandidates?.length ?? 0,
    },
  });
  if (descriptorConflict) return conflictingRegion();

  const precise = descriptor && Number.isSafeInteger(widthBits) && widthBits > 0
    ? preciseRegion({ descriptor, functionId, binaryId, widthBits, origin, addressSpace, addressValueId })
    : null;
  if (precise && comparableCandidates?.length > 1) {
    const conflicting = comparableCandidates.slice(1).some((candidate) => {
      let candidateRegion = null;
      try {
        candidateRegion = preciseRegion({
          descriptor: candidate, functionId, binaryId, widthBits, origin, addressSpace, addressValueId,
        });
      } catch {
        // A malformed secondary candidate is not proof-grade authority. The
        // primary descriptor keeps its historical behavior; only two valid
        // precise claims can establish a contradiction.
        return false;
      }
      return candidateRegion != null && candidateRegion.id !== precise.id;
    });
    if (conflicting) return conflictingRegion();
  }
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

export function deriveMemoryRegion(input = {}) {
  return deriveMemoryRegionWithCandidates(input);
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
  const { nodesById, valuesById } = irIndexFor(ir);
  const node = typeof nodeOrId === 'string' ? nodesById.get(nodeOrId) : nodeOrId;
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
  const value = addressValueId ? valuesById.get(addressValueId) : null;
  const definingNode = value?.definitionNodeId ? nodesById.get(String(value.definitionNodeId)) : null;
  const accessOrigin = normalizedOrigin(node.origin, value?.origin, definingNode?.origin);
  const explicitDescriptors = descriptorCandidates(node, value, definingNode, options.regionEvidence)
    .map(normalizeDescriptor)
    .filter(Boolean);
  const explicitDescriptor = explicitDescriptors[0] ?? null;

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

  return deriveMemoryRegionWithCandidates({
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
  }, explicitDescriptor ? explicitDescriptors : null);
}

export function isPreciseMemoryRegion(region) {
  return !!region && PRECISE_KINDS.has(region.kind) && originHasEvidence(region.origin);
}

export function sameMemoryRegionIdentity(a, b) {
  return !!a && !!b && a.id === b.id;
}

export const __regionInternalsForTests = deepFreeze({ originHasEvidence });
