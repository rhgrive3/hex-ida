import { analyzeSemanticDominance, createSemanticCfg } from '../cfg/index.js';
import { analyzeGraph } from '../../controlflow.js';
import {
  abiResultInvalidState, canonicalAbiEvidence, canonicalAbiHiddenResult, normalizeAbiPieces,
} from '../../targets/abi/evidence.js';

/** Internal architecture-neutral helpers for the Semantic IR v2 -> v1 projection. */

export const V1_OP = Object.freeze({
  CONST: 'const', MOV: 'mov', BIN: 'bin', UN: 'un', MAC: 'mac', BFX: 'bfx', BFI: 'bfi',
  CMP: 'cmp', SEL: 'sel', LOAD: 'load', STORE: 'store', ADDR: 'addr', CALL: 'call',
  RET: 'ret', BR: 'br', CBR: 'cbr', PHI: 'phi', CLOBBER: 'clobber', UNKNOWN: 'unknown',
});
export const V1_VK = Object.freeze({ ARG: 'arg', CONST: 'const', DEF: 'def', PHI: 'phi', UNDEF: 'undef' });
export const V1_MK = Object.freeze({ STACK: 'stack', FIELD: 'field', GLOBAL: 'global', UNKNOWN: 'unknown' });

const CONTROL_KINDS = new Set(['branch', 'conditional-branch', 'switch', 'return', 'trap', 'unknown-control-effect']);
function abiNonExact(raw) {
  return raw?.partial === true || raw?.unsupported === true || !!abiResultInvalidState(raw);
}

function provenAbiArgument(argument) {
  return argument?.partial !== true && argument?.possible !== true
    && argument?.mustUse !== false && argument?.exact !== false
    && argument?.named !== false && argument?.variadic !== true;
}

/*
 * Compatibility is a publication boundary, not a second ABI classifier.
 * Validate every aggregate argument layout emitted by the canonical adapter;
 * an exact-looking register list without complete byte pieces is rejected.
 */
function normalizeArgumentEvidence(rawArguments) {
  if (!Array.isArray(rawArguments)) return rawArguments;
  const normalized = [];
  for (const argument of rawArguments) {
    if (!argument || typeof argument !== 'object' || Array.isArray(argument)) return null;
    const piecesPresent = Array.isArray(argument.pieces) || Array.isArray(argument.parts);
    const pieces = Array.isArray(argument.pieces) ? argument.pieces
      : Array.isArray(argument.parts) ? argument.parts : null;
    const regs = Array.isArray(argument.regs)
      ? argument.regs
      : typeof argument.reg === 'string' && argument.reg ? [argument.reg] : [];
    const aggregate = argument.aggregate === true || regs.length > 1 || piecesPresent
      || /aggregate|hfa|hva|eightbyte|wide-integer|integer-pair/.test(String(argument.abiClass || '').toLowerCase());
    if (aggregate) {
      if (piecesPresent && pieces?.length) {
        const validated = normalizeAbiPieces({ ...argument, regs }, pieces, { defaultAbiClass:'aggregate-piece' });
        if (!validated) return null;
        normalized.push({ ...argument, regs, pieces:validated, aggregate:true });
        continue;
      }
      // A conservative/unknown aggregate may have no physical pieces yet;
      // an exact aggregate may not omit them.
      if (provenAbiArgument(argument)) return null;
      normalized.push({ ...argument, aggregate:true });
      continue;
    }
    normalized.push(argument);
  }
  return normalized;
}

export function safeBigInt(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    if (value.kind === 'bitvector' && value.value != null) return safeBigInt(value.value);
    if ((value.kind === 'absolute-address' || value.kind === 'address') && value.value != null) return safeBigInt(value.value);
    return null;
  }
  try { return typeof value === 'bigint' ? value : BigInt(value); } catch { return null; }
}
function machineWidth(type) {
  if (!type || typeof type !== 'object') return 64;
  if (type.kind === 'vector') return Math.max(1, Number(type.laneCount || 1)) * machineWidth(type.elementType);
  return Math.max(1, Number(type.widthBits || 64) || 64);
}
export function firstAddress(origin) {
  const value = origin?.virtualRanges?.[0]?.start;
  return safeBigInt(value);
}
export function sourceInstructionIds(origin) {
  return Array.isArray(origin?.instructionIds) ? origin.instructionIds.slice() : [];
}
export function unique(values) { return [...new Set(values.filter((value) => value != null))]; }
export function asArray(value) { return Array.isArray(value) ? value : []; }
export function bytesForBits(bits) { return Math.max(1, Math.ceil(Number(bits || 8) / 8)); }
function unknownCategories(node, fallback = ['other']) {
  const categories = node?.unknown?.categories;
  return unique((categories?.length ? categories : fallback).map(String)).sort();
}
function addressForNode(node, options) {
  if (typeof options.addressOfNode === 'function') {
    const value = options.addressOfNode(node);
    if (value != null) return safeBigInt(value) ?? value;
  }
  return firstAddress(node.origin);
}
function textForNode(node, options) {
  if (typeof options.textOfNode === 'function') {
    const value = options.textOfNode(node);
    if (value != null) return String(value);
  }
  return `semantic-v2 ${node.kind}`;
}

/**
 * v1 exposes the physical state name, not Semantic SSA's internal variable key.
 * Width/view information deliberately stays on the value itself. This means two
 * access views of one physical register keep one public identity without any
 * architecture-specific register-name rule in compatibility code.
 */
export function legacyPublicStateIdentity(variable) {
  const physical = variable?.physicalIdentity;
  if (physical?.kind === 'register' && physical.registerId != null) return String(physical.registerId);
  if (physical?.kind === 'flag' && physical.flagId != null) return String(physical.flagId);
  return variable?.key == null ? null : String(variable.key);
}

function stateIdentityByVariableKey(ir, ssa) {
  const map = new Map();
  for (const node of ir.nodes) {
    if (!node.variable?.key) continue;
    map.set(node.variable.key, node.variable);
  }
  for (const definition of ssa?.definitions ?? []) {
    const variable = definition.proof?.variableIdentity ?? null;
    if (!variable) continue;
    if (definition.variableKey) map.set(definition.variableKey, variable);
    if (variable.key) map.set(variable.key, variable);
  }
  return map;
}

function normalizedReturnLocations(raw) {
  if (!Array.isArray(raw.returnLocations) || raw.returnLocations.length === 0) return [];
  if (raw.returnLocations.some((location) => !location || typeof location !== 'object')) return null;
  const indirect = raw.returnIndirect === true || raw.returnLocations.some((location) => location.kind === 'indirect');
  if (indirect) {
    if (raw.returnLocations.length !== 1 || raw.returnIndirect !== true) return null;
    const location = raw.returnLocations[0];
    const hidden = raw.returnHiddenResultPointer;
    if (location.kind !== 'indirect' || typeof location.reg !== 'string' || !location.reg
      || !hidden || typeof hidden !== 'object' || hidden.input !== location.reg
      || !canonicalAbiHiddenResult(raw, hidden)) return null;
    const indirectBits = Number(location.bits ?? hidden.pointerBits);
    const indirectBytes = Number(location.bytes ?? 8);
    if (!Number.isSafeInteger(indirectBits) || indirectBits <= 0
      || !Number.isSafeInteger(indirectBytes) || indirectBytes <= 0) return null;
    return [{
      ...location,
      bits:indirectBits,
      bytes:indirectBytes,
      aggregate:true,
    }];
  }
  const aggregate = raw.returnAggregate === true || raw.returnLocations.length > 1
    || raw.returnLocations.some((location) => location.aggregate === true);
  if (!aggregate) {
    if (raw.returnLocations.length !== 1) return null;
    const location = raw.returnLocations[0];
    if (location.kind !== 'register' || typeof location.reg !== 'string' || !location.reg
      || location.aggregate === true || !Number.isSafeInteger(Number(location.bits))
      || Number(location.bits) <= 0) return null;
    const scalarBits = Number(location.bits);
    const scalarBytes = Number(location.bytes ?? Math.ceil(scalarBits / 8));
    if (!Number.isSafeInteger(scalarBytes) || scalarBytes <= 0) return null;
    return [{
      ...location,
      bits:scalarBits,
      bytes:scalarBytes,
      aggregate:false,
    }];
  }
  const pieces = raw.returnLocations.map((location, index) => {
    if (!['register','stack'].includes(location.kind)) return null;
    return {
      ...(location.kind === 'register' ? { reg:location.reg } : { stackOffset:location.stackOffset }),
      abiClass:location.abiClass,
      pieceIndex:location.pieceIndex ?? index,
      order:location.order ?? index,
      bits:location.bits,
      bytes:location.bytes,
      byteOffset:location.byteOffset,
    };
  });
  const normalized = normalizeAbiPieces({
    bits:raw.returnBits,
    bytes:raw.returnBytes,
    regs:raw.returnLocations.filter((location) => location.kind === 'register').map((location) => location.reg),
    abiClass:raw.returnAggregate === true ? 'aggregate-piece' : raw.abiClass,
  }, pieces, { defaultAbiClass:'aggregate-piece' });
  if (!normalized) return null;
  if (Array.isArray(raw.returnPieces)) {
    const rawNormalized = normalizeAbiPieces({
      bits:raw.returnBits,
      bytes:raw.returnBytes,
      regs:raw.returnLocations.filter((location) => location.kind === 'register').map((location) => location.reg),
      abiClass:raw.returnAggregate === true ? 'aggregate-piece' : raw.abiClass,
    }, raw.returnPieces, { defaultAbiClass:'aggregate-piece' });
    if (!rawNormalized || rawNormalized.length !== normalized.length
      || rawNormalized.some((piece, index) => piece.reg !== normalized[index].reg
        || piece.stackOffset !== normalized[index].stackOffset
        || piece.bits !== normalized[index].bits
        || piece.bytes !== normalized[index].bytes
        || piece.byteOffset !== normalized[index].byteOffset
        || piece.abiClass !== normalized[index].abiClass)) return null;
  }
  return normalized.map((piece) => ({
    kind:piece.reg ? 'register' : 'stack',
    ...(piece.reg ? { reg:piece.reg } : { stackOffset:piece.stackOffset }),
    abiClass:piece.abiClass,
    pieceIndex:piece.pieceIndex,
    order:piece.order,
    bits:piece.bits,
    bytes:piece.bytes,
    byteOffset:piece.byteOffset,
    aggregate:true,
  }));
}

function normalizeAbiResult(raw) {
  if (!raw || typeof raw !== 'object' || !canonicalAbiEvidence(raw)) return null;
  const rawCallArguments = Array.isArray(raw.callArguments) ? raw.callArguments
    : Array.isArray(raw.arguments) ? raw.arguments : null;
  const nonExact = abiNonExact(raw);
  const normalizedArguments = normalizeArgumentEvidence(rawCallArguments);
  if (rawCallArguments && !normalizedArguments) return null;
  const rawState = abiResultInvalidState(raw);
  const callArguments = nonExact && normalizedArguments
    ? normalizedArguments.map((argument) => rawState === 'partial' && provenAbiArgument(argument)
      ? argument
      : { ...argument, possible:true, mustUse:false, exact:false, certainty:'unknown' })
    : normalizedArguments;
  // A partial/stale result may contain a producer's provisional locations.
  // Dropping every physical placement at this boundary prevents a legacy
  // scalar field from laundering incomplete canonical ABI evidence.
  const candidateReturnLocations = nonExact ? [] : normalizedReturnLocations(raw);
  const returnLocations = candidateReturnLocations == null ? [] : candidateReturnLocations;
  const hasAggregateReturn = raw.returnAggregate === true || raw.returnIndirect === true
    || (Array.isArray(raw.returnPieces) && raw.returnPieces.length > 1)
    || returnLocations.length > 1
    || returnLocations.some((location) => location.aggregate === true);
  const scalarReturnLocation = !hasAggregateReturn && returnLocations.length === 1
    && returnLocations[0]?.kind === 'register'
    && returnLocations[0]?.aggregate !== true
    ? returnLocations[0].reg : null;
  return {
    callArguments,
    stackArguments: nonExact ? null : Array.isArray(raw.stackArguments) ? raw.stackArguments : null,
    stackArgsUnknown: raw.stackArgsUnknown == null ? callArguments == null : !!raw.stackArgsUnknown,
    stackArgsMayContainPointers: raw.stackArgsMayContainPointers == null ? true : !!raw.stackArgsMayContainPointers,
    argumentEvidence: raw.argumentEvidence == null ? 'injected-abi-adapter' : String(raw.argumentEvidence),
    clobbers: unique(asArray(raw.clobbers).map(String)),
    // A legacy scalar field cannot represent an aggregate or an indirect
    // result.  Never let a producer's first-register convenience field erase
    // the complete canonical location list.
    returnReg:nonExact ? null : scalarReturnLocation,
    returnBits: nonExact ? null : raw.returnBits == null ? null : Number(raw.returnBits),
    returnEvidence:nonExact ? null : raw.returnEvidence ?? null,
    returnLocations,
    returnPieces: nonExact ? null : Array.isArray(raw.returnPieces) ? raw.returnPieces : null,
    returnAggregate:nonExact ? false : raw.returnAggregate === true,
    returnIndirect:nonExact ? false : raw.returnIndirect === true,
    returnHiddenResultPointer:nonExact ? null : raw.returnHiddenResultPointer ?? null,
    abiId:raw.abiId == null ? null : String(raw.abiId),
    abiSemanticVersion:raw.abiSemanticVersion == null ? null : String(raw.abiSemanticVersion),
    abiSemanticIdentity:raw.abiSemanticIdentity == null ? null : String(raw.abiSemanticIdentity),
    abiIdentity:raw.abiIdentity ?? null,
    abiProvenance:raw.provenance ?? null,
    abiInvalidation:raw.invalidation ?? null,
    completeness:raw.completeness ?? (nonExact ? 'unknown' : null),
    partial:nonExact,
  };
}

export function classifyCallWithAbi(node, ir, legacyValues, options) {
  const adapter = options.abiAdapter ?? options.abi ?? null;
  if (!adapter) return {
    callArguments: null,
    stackArguments: null,
    stackArgsUnknown: true,
    stackArgsMayContainPointers: true,
    argumentEvidence: 'semantic-ir-v2-no-abi-adapter',
    clobbers: asArray(node.call?.stateWrites).map((state) => state.key).filter(Boolean),
    returnReg: null,
    returnBits: null,
    returnEvidence: null,
    adapterStatus: 'absent',
  };
  try {
    const raw = typeof adapter === 'function'
      ? adapter({ node, call: node.call, semanticIr: ir, legacyValues })
      : typeof adapter.classifyCall === 'function'
        ? adapter.classifyCall({ node, call: node.call, semanticIr: ir, legacyValues })
        : null;
    const normalized = normalizeAbiResult(raw);
    if (normalized) return { ...normalized, adapterStatus: 'used' };
  } catch {
    // Adapter failure must degrade to the same conservative no-ABI behavior.
  }
  return {
    callArguments: null,
    stackArguments: null,
    stackArgsUnknown: true,
    stackArgsMayContainPointers: true,
    argumentEvidence: 'semantic-ir-v2-abi-adapter-unavailable',
    clobbers: asArray(node.call?.stateWrites).map((state) => state.key).filter(Boolean),
    returnReg: null,
    returnBits: null,
    returnEvidence: null,
    adapterStatus: 'failed-or-unsupported',
  };
}

export function blockOrder(ir) {
  const entry = ir.blocks.find((block) => block.id === ir.entryBlockId);
  const rest = ir.blocks.filter((block) => block.id !== ir.entryBlockId).slice().sort((a, b) => a.id.localeCompare(b.id));
  return entry ? [entry, ...rest] : rest;
}

export function explicitTargetsForBlock(block, nodeById) {
  const out = [];
  for (const nodeId of block.nodeIds) {
    const node = nodeById.get(nodeId);
    if (!node || !CONTROL_KINDS.has(node.kind)) continue;
    for (const target of node.targets || []) out.push(target);
  }
  return unique(out).sort();
}

function fallbackCfg(blocks, entryIndex, functionId) {
  const semanticIdByIndex = new Map(blocks.map((block) => [block.index, block.semanticBlockId]));
  const entryBlockId = semanticIdByIndex.get(entryIndex);
  if (entryBlockId == null) throw new TypeError('semantic-v2-v1-compat-entry-block-required');
  return createSemanticCfg({
    functionId,
    entryBlockId,
    blocks: blocks.map((block) => ({
      id: block.semanticBlockId,
      successors: block.succ
        .map((targetIndex) => semanticIdByIndex.get(targetIndex))
        .filter((target) => target != null)
        .map((to) => ({ to, kind: 'branch' })),
    })),
  });
}

/**
 * Project canonical Semantic CFG/dominance facts into the integer-indexed v1
 * shape. A supplied canonical CFG is never rediscovered from instructions.
 * The existing graph utility is used only to serialize the already-proven edge
 * graph into the established v1 loop/backedge shape.
 */
export function graphFacts(blocks, blockIndex, entryIndex, functionId = 'semantic-v2-v1-compat', canonicalCfg = null) {
  const cfg = canonicalCfg == null ? fallbackCfg(blocks, entryIndex, functionId) : createSemanticCfg(canonicalCfg);
  if (cfg.functionId !== functionId) throw new TypeError('semantic-v2-v1-compat-cfg-function-mismatch');
  const cfgById = new Map(cfg.blocks.map((block) => [block.id, block]));
  const edgeFacts = [];

  for (const block of blocks) {
    const cfgBlock = cfgById.get(block.semanticBlockId);
    if (!cfgBlock) throw new TypeError('semantic-v2-v1-compat-cfg-block-mismatch');
    block.succ = cfgBlock.successors
      .map((edge) => blockIndex.get(edge.to))
      .filter((index) => index != null);
    block.successorEdges = cfgBlock.successors
      .map((edge) => ({
        to: blockIndex.get(edge.to),
        semanticTo: edge.to,
        kind: edge.kind,
        metadata: edge.metadata ?? null,
      }))
      .filter((edge) => edge.to != null);
    block.pred = cfgBlock.predecessors
      .map((id) => blockIndex.get(id))
      .filter((index) => index != null)
      .sort((a, b) => a - b);
    for (const edge of block.successorEdges) edgeFacts.push({
      from: block.index,
      to: edge.to,
      semanticFrom: block.semanticBlockId,
      semanticTo: edge.semanticTo,
      kind: edge.kind,
      metadata: edge.metadata,
    });
  }

  const dominance = analyzeSemanticDominance(cfg);
  const reachable = new Set(dominance.reachable
    .map((id) => blockIndex.get(id))
    .filter((index) => index != null));
  const dominators = blocks.map((block) => new Set(
    (dominance.dominators[block.semanticBlockId] ?? [])
      .map((id) => blockIndex.get(id))
      .filter((index) => index != null),
  ));
  const idom = blocks.map((block) => {
    const parent = dominance.immediateDominators[block.semanticBlockId];
    return parent == null ? -1 : (blockIndex.get(parent) ?? -1);
  });
  for (const block of blocks) block.idom = idom[block.index] ?? -1;

  const legacyGraph = analyzeGraph(blocks.map((block) => block.succ), entryIndex);
  for (const loop of legacyGraph.loops) {
    const header = blocks[loop.header];
    if (header) header.isLoopHeader = true;
  }
  return {
    reachable,
    dominators,
    idom,
    loops: legacyGraph.loops,
    backEdges: legacyGraph.backEdges,
    blockIndex,
    cfg,
    edges: edgeFacts,
  };
}

function variableVersions(ir, ssa, stateByKey) {
  const map = new Map();
  if (ssa) {
    const groups = new Map();
    for (const definition of ssa.definitions) {
      if (!definition.variableKey) continue;
      const variable = definition.proof?.variableIdentity ?? stateByKey.get(definition.variableKey) ?? null;
      const publicIdentity = legacyPublicStateIdentity(variable) ?? definition.variableKey;
      let list = groups.get(publicIdentity);
      if (!list) { list = []; groups.set(publicIdentity, list); }
      list.push(definition);
    }
    for (const [publicIdentity, definitions] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const entries = definitions.filter((definition) => definition.kind === 'entry').sort((a, b) => a.valueId.localeCompare(b.valueId));
      const others = definitions.filter((definition) => definition.kind !== 'entry').sort((a, b) => a.definitionId.localeCompare(b.definitionId));
      for (const definition of entries) map.set(definition.valueId, { reg: publicIdentity, version: 0, stateKey: definition.variableKey });
      others.forEach((definition, index) => map.set(definition.valueId, { reg: publicIdentity, version: index + 1, stateKey: definition.variableKey }));
    }
  }
  const fallbackGroups = new Map();
  for (const value of ir.values) {
    if (map.has(value.id) || !value.variableKey) continue;
    const variable = stateByKey.get(value.variableKey) ?? null;
    const publicIdentity = legacyPublicStateIdentity(variable) ?? value.variableKey;
    let list = fallbackGroups.get(publicIdentity);
    if (!list) { list = []; fallbackGroups.set(publicIdentity, list); }
    list.push(value);
  }
  for (const [publicIdentity, values] of [...fallbackGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    values.sort((a, b) => a.id.localeCompare(b.id));
    let version = 0;
    for (const value of values) map.set(value.id, { reg: publicIdentity, version: value.kind === 'entry' ? 0 : ++version, stateKey: value.variableKey });
  }
  return map;
}

function legacyKind(semanticKind, ssaKind = null) {
  if (ssaKind === 'phi') return V1_VK.PHI;
  if (ssaKind === 'entry' || semanticKind === 'entry') return V1_VK.ARG;
  if (ssaKind === 'undef' || ssaKind === 'unknown' || semanticKind === 'undef' || semanticKind === 'unknown') return V1_VK.UNDEF;
  if (semanticKind === 'const') return V1_VK.CONST;
  return V1_VK.DEF;
}

function canonicalScalarDefinitionBySemanticValue(ssa) {
  const map = new Map();
  for (const definition of ssa?.definitions ?? []) {
    const sourceSemanticValueId = definition.proof?.sourceSemanticValueId ?? null;
    if (sourceSemanticValueId == null) continue;
    const isScalarSemanticDefinition = definition.variableKey == null
      && (definition.proof?.kind === 'semantic-value-definition' || definition.sourceEntityId === sourceSemanticValueId);
    if (isScalarSemanticDefinition && !map.has(sourceSemanticValueId)) map.set(sourceSemanticValueId, definition);
  }
  return map;
}

export function buildStateProjectionIndex(ssa) {
  const definitionByValueId = new Map((ssa?.definitions ?? []).map((definition) => [definition.valueId, definition]));
  const writeDefinitionByNodeId = new Map();
  const readUseByNodeId = new Map();
  for (const definition of ssa?.definitions ?? []) {
    if (!definition.variableKey || !definition.sourceEntityId) continue;
    if (definition.kind === 'definition' && definition.proof?.kind === 'renamed-definition'
        && definition.proof?.sourceSemanticValueId != null) {
      writeDefinitionByNodeId.set(definition.sourceEntityId, definition);
    }
  }
  for (const use of ssa?.uses ?? []) {
    if (!use.sourceEntityId || use.proof?.kind !== 'renamed-use') continue;
    if (!readUseByNodeId.has(use.sourceEntityId)) readUseByNodeId.set(use.sourceEntityId, use);
  }
  return { definitionByValueId, writeDefinitionByNodeId, readUseByNodeId };
}

export function buildLegacyValues(ir, ssa) {
  const ssaByValue = new Map(ssa?.definitions?.map((definition) => [definition.valueId, definition]) || []);
  const scalarBySemanticValue = canonicalScalarDefinitionBySemanticValue(ssa);
  const semanticById = new Map(ir.values.map((value) => [value.id, value]));
  const stateByKey = stateIdentityByVariableKey(ir, ssa);
  const versions = variableVersions(ir, ssa, stateByKey);
  const values = [];
  const byId = new Map();

  const pushValue = (value) => {
    value.id = values.length;
    value.vid = values.length + 1;
    values.push(value);
    return value;
  };

  for (const semanticValue of ir.values) {
    const directDefinition = ssaByValue.get(semanticValue.id) ?? scalarBySemanticValue.get(semanticValue.id) ?? null;
    const version = versions.get(semanticValue.id) || {};
    const variable = semanticValue.variableKey == null ? null : stateByKey.get(semanticValue.variableKey) ?? null;
    const publicIdentity = version.reg ?? legacyPublicStateIdentity(variable) ?? semanticValue.variableKey ?? null;
    const value = pushValue({
      kind: legacyKind(semanticValue.kind, directDefinition?.kind ?? null),
      reg: publicIdentity,
      stateKey: version.stateKey ?? semanticValue.variableKey ?? null,
      version: version.version ?? 0,
      bits: machineWidth(semanticValue.machineType),
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: publicIdentity ?? semanticValue.sourceEntityId ?? null,
      semanticValueId: semanticValue.id,
      semanticSsaValueId: directDefinition?.valueId ?? null,
      sourceEntityId: semanticValue.sourceEntityId,
      machineType: semanticValue.machineType,
      origin: semanticValue.origin,
    });
    if (semanticValue.kind === 'unknown' || directDefinition?.kind === 'unknown') value.unknown = true;
    if (semanticValue.kind === 'undef' || directDefinition?.kind === 'undef') value.undefined = true;
    byId.set(semanticValue.id, value);
    if (directDefinition && directDefinition.variableKey == null) byId.set(directDefinition.valueId, value);
  }

  for (const definition of ssa?.definitions ?? []) {
    if (byId.has(definition.valueId)) continue;
    const sourceSemanticValueId = definition.proof?.sourceSemanticValueId ?? null;
    const sourceSemanticValue = sourceSemanticValueId == null ? null : semanticById.get(sourceSemanticValueId) ?? null;
    const version = versions.get(definition.valueId) || {};
    const machineType = definition.proof?.machineType ?? sourceSemanticValue?.machineType ?? null;
    const variable = definition.proof?.variableIdentity ?? stateByKey.get(definition.variableKey) ?? null;
    const publicIdentity = version.reg ?? legacyPublicStateIdentity(variable) ?? definition.variableKey ?? sourceSemanticValue?.variableKey ?? null;
    const value = pushValue({
      kind: legacyKind(sourceSemanticValue?.kind ?? null, definition.kind),
      reg: publicIdentity,
      stateKey: version.stateKey ?? definition.variableKey ?? variable?.key ?? null,
      version: version.version ?? 0,
      bits: machineWidth(machineType),
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: publicIdentity ?? sourceSemanticValue?.sourceEntityId ?? definition.sourceEntityId ?? null,
      semanticValueId: null,
      semanticSsaValueId: definition.valueId,
      sourceSemanticValueId,
      sourceEntityId: definition.sourceEntityId,
      machineType,
      origin: definition.origin,
    });
    if (definition.kind === 'unknown') {
      value.unknown = true;
      if (definition.variableKey != null) value.clobbered = true;
    }
    if (definition.kind === 'undef') value.undefined = true;
    byId.set(definition.valueId, value);
  }

  return { values, byId, ssaByValue };
}

export function makeArg(value) { return value ? { value, bits: value.bits || 64 } : null; }
export function addUse(value, inst) {
  if (!value || !inst || value.uses.includes(inst)) return;
  value.uses.push(inst);
}
export function attachArgs(inst, values) {
  inst.args = values.filter(Boolean).map(makeArg);
  for (const value of values) addUse(value, inst);
}

export function defaultUnknownInstruction(node, block, row, options, fields = {}) {
  return {
    op: V1_OP.UNKNOWN,
    sub: null,
    block,
    row,
    address: addressForNode(node, options),
    text: textForNode(node, options),
    args: [],
    dst: null,
    extra: {
      reason: node.unknown?.reason ?? `semantic-ir-v2-${node.kind}-not-representable-in-v1`,
      unknownCategories: unknownCategories(node),
      semanticNodeId: node.id,
      ...fields,
    },
  };
}

export function baseInstruction(node, block, row, options) {
  const ids = sourceInstructionIds(node.origin);
  return {
    op: null,
    sub: null,
    block,
    row,
    address: addressForNode(node, options),
    text: textForNode(node, options),
    args: [],
    dst: null,
    extra: null,
    semanticNodeId: node.id,
    sourceEntityId: node.id,
    sourceEffectIds: node.sourceEffectIds.slice(),
    instructionId: ids[0] ?? null,
    sourceInstructionIds: ids,
    origin: node.origin,
  };
}

export function targetAddress(targetBlockId, blockBySemanticId, nodeById, options) {
  const block = blockBySemanticId.get(targetBlockId);
  if (!block) return null;
  for (const nodeId of block.semanticNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const address = addressForNode(node, options);
    if (address != null) return address;
  }
  return null;
}
