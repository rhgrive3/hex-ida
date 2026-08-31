import {
  V1_OP, V1_VK, V1_MK, safeBigInt, bytesForBits, firstAddress,
  sourceInstructionIds, unique, asArray, makeArg, addUse, legacyPublicStateIdentity,
} from './semantic-ir-v2-to-v1-core.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  canonicalMemoryForwardingContext,
  forwardMemoryValue,
} from '../memoryssa/queries.js';
import { isCanonicalMemorySsaProducerArtifact } from '../memoryssa/build.js';
import { propagateScalarConstants } from './semantic-ir-v2-to-v1-finalize.js';

const MEMORY_CLOBBER_KINDS = new Set(['may-alias-clobber', 'unknown-clobber', 'call-clobber', 'intrinsic-clobber']);

function mergeForwardingFacts(previous, next) {
  if (!previous) return next;
  if (previous.status !== 'exact') return previous;
  if (next.status !== 'exact') return next;
  if (previous.value === next.value
      && JSON.stringify(previous.bytes ?? []) === JSON.stringify(next.bytes ?? [])
      && previous.identity?.digest === next.identity?.digest) return previous;
  return Object.freeze({
    status: 'unknown',
    exact: false,
    reason: 'memory-forwarding-conflicting-use-facts',
    completeness: 'partial',
  });
}

function preciseProjectedAddress(address) {
  return address?.precise === true && address.index == null ? address : null;
}

function legacyLocation(region, valuesById, projectedAddress = null) {
  const size = region.widthBits == null ? null : bytesForBits(region.widthBits);
  const address = preciseProjectedAddress(projectedAddress);
  if (region.kind === 'stack-fixed') {
    const regionOffset = safeBigInt(region.offset) ?? 0n;
    const disp = safeBigInt(address?.disp) ?? regionOffset;
    return { key: `stack:${regionOffset.toString()}`, kind: V1_MK.STACK, disp, size, regionId: region.id, origin: region.origin ?? null };
  }
  if (region.kind === 'global-absolute') {
    const absolute = safeBigInt(region.address);
    if (absolute != null) return { key: `global:${absolute.toString(16)}`, kind: V1_MK.GLOBAL, address: absolute, size, regionId: region.id, origin: region.origin ?? null };
  }
  if (region.kind === 'rooted-offset') {
    const regionOffset = safeBigInt(region.offset) ?? 0n;
    const disp = safeBigInt(address?.disp) ?? regionOffset;
    const base = address?.base ?? valuesById.get(region.rootEntityId) ?? null;
    return {
      key: `field:${region.rootEntityId}+${regionOffset.toString()}`,
      kind: V1_MK.FIELD,
      base,
      baseEntityId: region.rootEntityId,
      disp,
      size,
      regionId: region.id,
      origin: region.origin ?? address?.origin ?? null,
      addressMetadataSource: address ? 'semantic-ir-address-projection' : 'memory-region',
    };
  }
  return { key: `unknown:${region.id}`, kind: V1_MK.UNKNOWN, size, regionId: region.id, uncertaintyIdentity: region.uncertaintyIdentity ?? region.rootIdentity ?? region.addressSpace ?? region.id, origin: region.origin ?? null };
}

function fallbackLocation(inst) {
  if (!inst?.addr) return { key: 'unknown', kind: V1_MK.UNKNOWN, size: inst?.extra?.size ?? null };
  const base = inst.addr.base;
  if (base?.const != null && inst.addr.index == null) {
    const address = base.const + (inst.addr.disp ?? 0n);
    return { key: `global:${address.toString(16)}`, kind: V1_MK.GLOBAL, address, size: inst.addr.size ?? null };
  }
  return { key: `unknown:${inst.semanticNodeId ?? inst.id ?? 'memory'}`, kind: V1_MK.UNKNOWN, size: inst.addr.size ?? null };
}

function representativeProjectedAddress(regionId, memorySsa, instructionBySemanticId) {
  for (const definition of memorySsa.definitions) {
    if (definition.regionId !== regionId || definition.sourceEntityId == null) continue;
    const address = instructionBySemanticId.get(definition.sourceEntityId)?.addr ?? null;
    if (preciseProjectedAddress(address)) return address;
  }
  for (const use of memorySsa.uses) {
    if (use.regionId !== regionId) continue;
    const address = instructionBySemanticId.get(use.sourceEntityId)?.addr ?? null;
    if (preciseProjectedAddress(address)) return address;
  }
  return null;
}

function accessLocation(regionId, source, regionById, locationByRegion, valuesById) {
  const canonical = locationByRegion.get(regionId) ?? null;
  const region = regionById.get(regionId) ?? null;
  if (!region || !source) return canonical;
  const address = preciseProjectedAddress(source.addr);
  return address ? legacyLocation(region, valuesById, address) : canonical;
}

function canonicalRangeKey(range) {
  if (!range || typeof range !== 'object') return null;
  if (range.domain == null || range.start == null || range.end == null) return null;
  try {
    const start = BigInt(range.start);
    const end = BigInt(range.end);
    if (end <= start) return null;
    return `${String(range.domain)}\u0000${start.toString()}\u0000${end.toString()}`;
  } catch {
    return null;
  }
}

/*
 * `reachingStore` is an old public compatibility pointer, not a value-proof
 * surface.  Preserve it only when the exact canonical producer object issued
 * a one-store, same-range MemorySSA link.  This keeps reopened legacy owner
 * contracts (for example #359) intact without recreating the removed private
 * stack-flow engine or allowing a serialized clone to mint a pointer.
 */
function canonicalCompatibilityStore(memorySsa, use, memoryNodeById, metadataById) {
  if (!isCanonicalMemorySsaProducerArtifact(memorySsa)
      || use?.aliasRelation !== 'must') return null;
  const memoryNode = memoryNodeById.get(String(use.reachingDefinitionId)) ?? null;
  const definition = memorySsa.definitions.find((item) => String(item.id) === String(use.reachingDefinitionId)) ?? null;
  const loadMetadata = metadataById.get(String(use.id)) ?? null;
  const storeMetadata = metadataById.get(String(use.reachingDefinitionId)) ?? null;
  if (!memoryNode || memoryNode.kind !== 'store' || !definition
      || definition.kind !== 'memory-def' || definition.aliasRelation !== 'must'
      || !loadMetadata || !storeMetadata
      || loadMetadata.entityKind !== 'use' || loadMetadata.sourceKind !== 'load'
      || loadMetadata.role !== 'read' || loadMetadata.broad === true
      || storeMetadata.entityKind !== 'definition' || storeMetadata.sourceKind !== 'store'
      || storeMetadata.role !== 'write' || storeMetadata.broad === true
      || loadMetadata.aliasRelation !== 'must' || storeMetadata.aliasRelation !== 'must') return null;
  const loadRange = canonicalRangeKey(loadMetadata.byteRange);
  const storeRange = canonicalRangeKey(storeMetadata.byteRange);
  if (!loadRange || loadRange !== storeRange) return null;
  const loadWidth = Number(loadMetadata.memory?.widthBits);
  const storeWidth = Number(storeMetadata.memory?.widthBits);
  if (!Number.isSafeInteger(loadWidth) || loadWidth <= 0 || loadWidth !== storeWidth
      || loadMetadata.memory?.endian !== storeMetadata.memory?.endian) return null;
  return memoryNode.inst?.op === V1_OP.STORE ? memoryNode.inst : null;
}

export function attachMemorySsa(projected, memorySsa, valuesById, instructionBySemanticId, blockIndexById, canonicalIr = null) {
  propagateScalarConstants(projected);
  const regionById = new Map(memorySsa.regions.map((region) => [region.id, region]));
  const locationByRegion = new Map();
  for (const region of memorySsa.regions) {
    const loc = legacyLocation(region, valuesById, representativeProjectedAddress(region.id, memorySsa, instructionBySemanticId));
    locationByRegion.set(region.id, loc);
    projected.locations.set(loc.key, loc);
  }

  const memoryNodeById = new Map();
  for (const definition of memorySsa.definitions) {
    const loc = locationByRegion.get(definition.regionId);
    const inst = definition.sourceEntityId == null ? null : instructionBySemanticId.get(definition.sourceEntityId) ?? null;
    let kind = 'clobber';
    if (definition.kind === 'entry') kind = 'entry';
    else if (definition.kind === 'memory-def') kind = 'store';
    else if (definition.kind === 'memory-phi') kind = 'phi';
    const memoryNode = {
      kind,
      key: loc?.key ?? `unknown:${definition.regionId}`,
      definitionId: definition.id,
      regionId: definition.regionId,
      block: definition.blockId == null ? null : blockIndexById.get(definition.blockId) ?? null,
      inst,
      prev: null,
      incoming: [],
      reason: MEMORY_CLOBBER_KINDS.has(definition.kind) ? definition.kind : null,
      unknownAlias: definition.kind === 'unknown-clobber' || definition.aliasRelation === 'unknown' || definition.kind === 'may-alias-clobber',
      aliasRelation: definition.aliasRelation,
      effectSummary: definition.effectSummary ?? null,
      proof: definition.proof ?? null,
      origin: definition.origin,
    };
    memoryNodeById.set(definition.id, memoryNode);
  }

  const metadataById = new Map(
    (memorySsa.accessMetadata ?? []).map((metadata) => [String(metadata.memorySsaEntityId), metadata]),
  );

  const definitionById = new Map(memorySsa.definitions.map((definition) => [definition.id, definition]));
  for (const definition of memorySsa.definitions) {
    const memoryNode = memoryNodeById.get(definition.id);
    if (definition.previousDefinitionIds.length) {
      const previous = definition.previousDefinitionIds.map((id) => memoryNodeById.get(id)).filter(Boolean);
      memoryNode.previous = previous;
      memoryNode.prev = previous.length === 1 ? previous[0] : null;
    }
    if (definition.kind === 'memory-phi') {
      memoryNode.incoming = definition.incoming.map((item) => ({
        from: blockIndexById.get(item.predecessorBlockId) ?? null,
        semanticPredecessorBlockId: item.predecessorBlockId,
        node: memoryNodeById.get(item.definitionId) ?? null,
      }));
      const block = projected.blocks[memoryNode.block];
      if (block) block.memPhis.push(memoryNode);
    }
    const source = definition.sourceEntityId == null ? null : instructionBySemanticId.get(definition.sourceEntityId);
    if (!source) continue;
    if (definition.kind === 'memory-def' && source.op === V1_OP.STORE) {
      const loc = accessLocation(definition.regionId, source, regionById, locationByRegion, valuesById);
      if (loc) source.loc = loc;
      if (!source.memDefs) source.memDefs = [];
      source.memDefs.push(memoryNode);
      if (!source.memDef) source.memDef = memoryNode;
    } else if (MEMORY_CLOBBER_KINDS.has(definition.kind)) {
      if (!source.memKills) source.memKills = [];
      const loc = locationByRegion.get(definition.regionId);
      if (loc && !source.memKills.includes(loc)) source.memKills.push(loc);
      source.memoryBarrier = true;
    }
  }

  for (const use of memorySsa.uses) {
    const source = instructionBySemanticId.get(use.sourceEntityId);
    if (!source) continue;
    const loc = accessLocation(use.regionId, source, regionById, locationByRegion, valuesById);
    if (loc && (source.op === V1_OP.LOAD || source.op === V1_OP.STORE)) source.loc = loc;
    const reaching = memoryNodeById.get(use.reachingDefinitionId) ?? null;
    source.memUse = reaching;
    source.memoryAliasRelation = use.aliasRelation;
    if (source.op === V1_OP.LOAD && reaching?.kind === 'clobber') {
      source.unknownAliasBarrier = reaching.inst ?? null;
    }
  }

  // Exact value recovery is a canonical MemorySSA query.  Only artifacts that
  // carry the builder's proof indexes enter this path.  No projection path
  // retains a structural reaching-store pointer as a substitute for the
  // canonical byte proof.
  const forwardingEligible = Array.isArray(memorySsa.accessMetadata)
    || Array.isArray(memorySsa.byteCoverage)
    || memorySsa.buildVersion != null;
  if (forwardingEligible) {
    const queriedLoads = new Set();
    for (const use of memorySsa.uses) {
      const source = instructionBySemanticId.get(use.sourceEntityId);
      if (!source || source.op !== V1_OP.LOAD) continue;
      queriedLoads.add(source);
      const fact = forwardMemoryValue(memorySsa, use, {
        functionId: projected.functionId,
        ...(memorySsa.buildVersion == null ? {} : { memorySsaBuildVersion: memorySsa.buildVersion }),
        consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
        purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
        ...(canonicalIr == null ? {} : { ir: canonicalIr }),
      });
      const useMetadata = metadataById.get(String(use.id)) ?? null;
      const currentContext = canonicalMemoryForwardingContext(fact, {
        artifact: memorySsa,
        artifactDigest: memorySsa.canonicalDigest ?? null,
        snapshotId: memorySsa.snapshotId ?? null,
        useId: use.id,
        sourceEntityId: use.sourceEntityId,
        nodeId: useMetadata?.nodeId ?? use.sourceEntityId,
        entityId: useMetadata?.memorySsaEntityId ?? use.id,
        regionId: use.regionId,
        range: useMetadata?.byteRange ?? null,
        consumerId: CANONICAL_MEMORY_FORWARDING_CONSUMER,
        purpose: CANONICAL_MEMORY_FORWARDING_PURPOSE,
      });
      const mergedFact = mergeForwardingFacts(source.memoryForwarding, fact);
      source.memoryForwarding = mergedFact;
      source.memoryForwardingContext = currentContext;
      source.extra = {
        ...source.extra,
        memoryForwarding: mergedFact,
        memoryForwardingContext: currentContext,
      };
      const compatibilityStore = canonicalCompatibilityStore(memorySsa, use, memoryNodeById, metadataById);
      if (compatibilityStore) source.reachingStore = compatibilityStore;
      if (mergedFact.status !== 'exact') {
        delete source.compatStackCallPreservation;
        // A non-exact value must stay unknown, but a same-range canonical
        // MemorySSA store may still be retained as legacy structural metadata
        // for compatibility.  All exact consumers independently reject this
        // pointer and require the branded forwarding fact.
        if (!compatibilityStore) {
          delete source.reachingStore;
          source.memoryAliasRelation = 'unknown';
          source.unknownAliasBarrier = source.unknownAliasBarrier ?? source.memUse ?? null;
        }
      }
    }
    // A proof-bearing artifact with no canonical use for a projected load is a
    // malformed/incomplete handoff, not permission to revive the old
    // reachingStore or stack-flow fallback.
    for (const source of projected.instructions) {
      if (source.op !== V1_OP.LOAD || queriedLoads.has(source) || Object.hasOwn(source, 'memoryForwarding')) continue;
      const fact = Object.freeze({
        status: 'unknown',
        exact: false,
        reason: 'memory-forwarding-use-missing',
        completeness: 'partial',
      });
      source.memoryForwarding = fact;
      source.extra = { ...source.extra, memoryForwarding: fact };
      delete source.reachingStore;
      source.memoryAliasRelation = 'unknown';
    }
  }

  for (const inst of projected.instructions) {
    if ((inst.op === V1_OP.LOAD || inst.op === V1_OP.STORE) && !inst.loc) {
      inst.loc = fallbackLocation(inst);
      projected.locations.set(inst.loc.key, inst.loc);
    }
  }

  projected.compat.memoryDefinitionById = Object.fromEntries([...memoryNodeById.entries()].map(([id, node]) => [id, {
    kind: node.kind,
    regionId: node.regionId,
    sourceSemanticNodeId: node.inst?.sourceEntityId ?? null,
    previousDefinitionIds: definitionById.get(id)?.previousDefinitionIds?.slice() ?? [],
  }]));
}

export function attachFallbackMemory(projected) {
  for (const inst of projected.instructions) {
    if (inst.op !== V1_OP.LOAD && inst.op !== V1_OP.STORE) continue;
    inst.loc = fallbackLocation(inst);
    projected.locations.set(inst.loc.key, inst.loc);
  }
}

export function addScalarSsaPhis(projected, ssa, valuesById, blockIndexById, instructionBySemanticId) {
  if (!ssa) return;
  const phiDefinitions = ssa.definitions.filter((definition) => definition.kind === 'phi');
  for (const definition of phiDefinitions) {
    const value = valuesById.get(definition.valueId);
    if (!value) continue;
    const block = blockIndexById.get(definition.blockId);
    if (block == null) continue;
    const publicIdentity = legacyPublicStateIdentity(definition.proof?.variableIdentity) ?? value.reg ?? definition.variableKey;
    const inst = {
      id: -1,
      op: V1_OP.PHI,
      sub: null,
      block,
      row: projected.blocks[block]?.startRow ?? block,
      address: firstAddress(definition.origin),
      text: `phi ${publicIdentity ?? definition.valueId}`,
      args: [],
      dst: value,
      incoming: [],
      reg: publicIdentity,
      semanticSsaValueId: definition.valueId,
      semanticNodeId: definition.sourceEntityId,
      sourceEntityId: definition.sourceEntityId,
      sourceInstructionIds: sourceInstructionIds(definition.origin),
      instructionId: sourceInstructionIds(definition.origin)[0] ?? null,
      origin: definition.origin,
      extra: {
        semanticSsaDefinitionId: definition.definitionId,
        semanticVariableKey: definition.variableKey,
        publicStateIdentity: publicIdentity,
        proof: definition.proof ?? null,
      },
    };
    for (const incoming of definition.incoming) {
      const incomingValue = valuesById.get(incoming.valueId);
      if (!incomingValue) continue;
      inst.incoming.push({
        from: blockIndexById.get(incoming.predecessorBlockId) ?? null,
        semanticPredecessorBlockId: incoming.predecessorBlockId,
        semanticSsaValueId: incoming.valueId,
        value: incomingValue,
      });
      inst.args.push(makeArg(incomingValue));
      addUse(incomingValue, inst);
    }
    value.kind = V1_VK.PHI;
    value.reg = publicIdentity;
    value.def = inst;
    projected.blocks[block].phis.push(inst);
    projected.instructions.unshift(inst);
  }

  for (const definition of ssa.definitions) {
    if (definition.kind === 'phi') continue;
    const value = valuesById.get(definition.valueId);
    if (!value) continue;
    const source = definition.sourceEntityId == null ? null : instructionBySemanticId.get(definition.sourceEntityId);
    if (source && value.def == null) value.def = source;
  }
  for (const use of ssa.uses) {
    const value = valuesById.get(use.valueId);
    const source = instructionBySemanticId.get(use.sourceEntityId);
    if (value && source) addUse(value, source);
  }
}

function representedCallContextUnknown(projected, unknown) {
  if (unknown?.reason !== 'call-context-effects-not-enriched') return false;
  const calls = projected.instructions.filter((inst) => inst.op === V1_OP.CALL);
  if (!calls.length) return false;
  return calls.every((call) => {
    const controlRepresented = call.extra?.target != null || call.extra?.indirect === true;
    const stateRepresented = call.extra?.abiAdapterStatus === 'used' && Array.isArray(call.clobbers) && call.clobbers.length > 0;
    const memoryRepresented = call.memoryBarrier === true && call.extra?.memoryWrite?.scope !== 'none';
    return controlRepresented && stateRepresented && memoryRepresented;
  });
}

export function appendFunctionUnknowns(projected, ir) {
  if (!ir.unknowns.length) return;
  const block = projected.blocks[projected.entry];
  if (!block) return;
  const instructionIds = sourceInstructionIds(ir.origin);
  const row = block.endRow;
  ir.unknowns.forEach((unknown, index) => {
    // `call-context-effects-not-enriched` is a function-level marker emitted
    // before an ABI adapter is available. If every projected CALL already
    // carries the exact control target plus ABI clobbers and a conservative
    // memory barrier, emitting another UNKNOWN duplicates the same uncertainty
    // and incorrectly forces legacy fallback. The CALL remains conservative;
    // no memory/state/control uncertainty is discarded.
    if (representedCallContextUnknown(projected, unknown)) return;
    const categories = unique(asArray(unknown.categories).map(String)).sort();
    const semanticNodeId = `${ir.functionId}:function-unknown:${index}`;
    const inst = {
      id: -1,
      op: V1_OP.UNKNOWN,
      sub: null,
      block: block.index,
      row,
      address: firstAddress(ir.origin),
      text: `semantic-v2 function unknown: ${unknown.reason}`,
      args: [],
      dst: null,
      semanticNodeId,
      sourceEntityId: ir.functionId,
      sourceEffectIds: [],
      instructionId: instructionIds[0] ?? null,
      sourceInstructionIds: instructionIds.slice(),
      origin: ir.origin,
      extra: {
        semanticNodeId,
        reason: unknown.reason,
        unknownCategories: categories.length ? categories : ['other'],
        functionUnknown: true,
        detail: unknown.detail ?? null,
      },
    };
    if (categories.includes('memory')) inst.memoryBarrier = true;
    projected.instructions.push(inst);
    block.insts.push(inst);
  });
}

export function assignInstructionIds(projected) {
  projected.instructions.forEach((inst, index) => { inst.id = index; });
  projected.byRow.clear();
  for (const block of projected.blocks) block.insts = block.insts.filter((inst) => inst.op !== V1_OP.PHI);
  for (const inst of projected.instructions) {
    if (inst.op !== V1_OP.PHI) {
      const block = projected.blocks[inst.block];
      if (block && !block.insts.includes(inst)) block.insts.push(inst);
    }
    let list = projected.byRow.get(inst.row);
    if (!list) { list = []; projected.byRow.set(inst.row, list); }
    list.push(inst);
  }
}

export function memorySafetySummary(projected) {
  const unknownStores = projected.instructions.filter((inst) => inst.op === V1_OP.STORE && (!inst.loc || inst.loc.kind === V1_MK.UNKNOWN)).length;
  const blockedLoads = projected.instructions.filter((inst) => inst.op === V1_OP.LOAD && !inst.reachingStore && inst.memUse?.kind === 'clobber').length;
  return { unknownStores, blockedLoads };
}
