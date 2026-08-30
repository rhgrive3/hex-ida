import { architecturePluginV2 } from '../targets/architecture/index.js';
import {
  resolveABIPlugin, isRegisteredABIPlugin, abiPluginRegistryDigest,
} from '../targets/abi/index.js';
import {
  abiInvalidState, abiResultInvalidState, canonicalAbiEvidence, canonicalAbiHiddenResult,
  normalizeAbiPieces,
} from '../targets/abi/evidence.js';
import { buildSemanticV2CompatibilityPipeline } from '../semantics/compat/index.js';
import { decompileSemantic } from '../decompiler/semantic.js';

/**
 * Architecture-neutral function-level semantic analysis driver.
 *
 * This is the single shared route from decoded instructions to the decompiler:
 *
 *   decoded instructions
 *     -> architecture MachineEffects lifter
 *     -> Semantic IR
 *     -> CFG -> SSA -> MemorySSA -> alias/dataflow
 *     -> v1 compatibility projection
 *     -> shared decompiler
 *
 * Everything architecture-specific is reached through the ArchitecturePluginV2
 * and ABIPlugin boundaries: `liftExact`, `classifyControlFlow`,
 * `directControlTarget`, `registerFile`, `modes`. This module never inspects a
 * mnemonic, an operand-shape, a register name, or an architecture id to decide
 * behaviour, which is what makes "same middle-end" a checkable property rather
 * than a claim.
 *
 * `SEMANTIC_FUNCTION_ROUTE` is the identity of this route, not of an
 * architecture; x86-64 and RISC-V64 both travel it, and the architecture is
 * reported separately as `architectureId`.
 */
export const SEMANTIC_FUNCTION_ROUTE = 'phase5-shadow-v2';

// Identity records cross several cache/publication boundaries.  Copying and
// recursively freezing the profile keeps the producer's nested evidence from
// becoming an accidental mutable second source of ABI truth.
function frozenAbiRecord(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, child] of Object.entries(value)) copy[key] = frozenAbiRecord(child, seen);
  return Object.freeze(copy);
}

function optionalIdentity(value) { return value == null ? null : String(value); }

function abiEvidenceState(options = {}, call = null, adapter = null) {
  const optionState = abiResultInvalidState(options);
  if (optionState) return optionState;
  const adapterState = abiResultInvalidState(adapter);
  if (adapterState) return adapterState;
  if (options.cancelled === true || options.canceled === true || options.signal?.aborted === true
    || call?.cancelled === true || call?.canceled === true || call?.signal?.aborted === true) return 'cancelled';
  if (options.deadlineExceeded === true || options.deadlineExpired === true
    || call?.deadlineExceeded === true || call?.deadlineExpired === true) return 'deadline-exceeded';
  if (options.truncated === true || options.truncatedRun === true || call?.truncated === true) return 'truncated';
  if (options.budgetExhausted === true || options.resourceBudgetExhausted === true
    || call?.budgetExhausted === true || call?.resourceBudgetExhausted === true) return 'budget-exhausted';
  if (options.budgetLimited === true || options.resourceBudgetLimited === true
    || call?.budgetLimited === true || call?.resourceBudgetLimited === true) return 'budget-limited';
  if (options.callerCalleeConflict === true || options.callerCalleeAgreement === false
    || call?.callerCalleeConflict === true || call?.callerCalleeAgreement === false) return 'conflict';
  if (options.malformedEvidence === true || options.classifierFailed === true
    || call?.malformedEvidence === true || call?.classifierFailed === true) return 'malformed';
  const callState = abiResultInvalidState(call && {
    unsupported:call.unsupported,
    partial:call.partial,
    malformed:call.malformed,
    malformedEvidence:call.malformedEvidence,
    cancelled:call.cancelled,
    canceled:call.canceled,
    cancellation:call.cancellation,
    deadlineExceeded:call.deadlineExceeded,
    deadlineExpired:call.deadlineExpired,
    truncated:call.truncated,
    truncatedRun:call.truncatedRun,
    budgetExhausted:call.budgetExhausted,
    resourceBudgetExhausted:call.resourceBudgetExhausted,
    budgetLimited:call.budgetLimited,
    resourceBudgetLimited:call.resourceBudgetLimited,
    status:call.abiStatus,
    analysisStatus:call.abiAnalysisStatus,
    completeness:call.abiCompleteness,
    evidenceStatus:call.abiEvidenceStatus,
    abiIdentity:call.abiIdentity,
    provenance:call.abiProvenance,
    invalidation:call.abiInvalidation,
  });
  if (callState) return callState;
  for (const value of [
    options.status, options.analysisStatus, options.completeness, options.evidenceStatus,
    // A call summary's completeness describes callee effects (memory/state),
    // not the ABI classifier's placement evidence. Keep ABI argument
    // candidates available as explicitly-uncertain inputs while the call
    // effects remain unknown; ABI exactness is still governed by the
    // classifier result below. ABI-specific status fields, when present, are
    // still fail-closed here.
    call?.abiStatus, call?.abiAnalysisStatus, call?.abiCompleteness, call?.abiEvidenceStatus,
    adapter?.status, adapter?.analysisStatus, adapter?.completeness,
    adapter?.invalidation?.status, adapter?.invalidation?.state, adapter?.invalidation?.completeness,
  ]) {
    const state = abiInvalidState(value);
    if (state) return state;
  }
  return null;
}

function abortIfRequested(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error('semantic-function-analysis-cancelled');
  error.name = 'AbortError';
  throw error;
}

function addressOf(instruction) { return BigInt(instruction.address); }
function endOf(instruction) { return addressOf(instruction) + BigInt(instruction.length ?? instruction.size); }
function keyOf(address) { return `block-${BigInt(address).toString(16)}`; }

function controlKind(plugin, instruction) {
  try { return String(plugin.classifyControlFlow?.(instruction) || 'fallthrough'); }
  catch { return 'unknown'; }
}

function directTarget(plugin, instruction) {
  try {
    const target = plugin.directControlTarget?.(instruction);
    return target == null ? null : BigInt(target);
  } catch { return null; }
}

function callNoreturnState(options = {}) {
  const prototype = options?.callPrototype;
  if (!prototype || typeof prototype !== 'object') return 'unknown';
  if (prototype.noreturn === true || prototype.returns === false) return true;
  if (prototype.noreturn === false || prototype.returns === true) return false;
  return 'unknown';
}

function isAuthoritativeNoreturnCall(kind, options = {}) {
  return kind === 'call' && callNoreturnState(options) === true;
}

/**
 * Convert decoder-proven instruction starts into discovery facts for the shared
 * semantic pipeline. This is architecture-front-end work: generic CFG/SSA never
 * inspect register names or mnemonics.
 */
export function partitionDecodedFunction(instructions, architecturePlugin, options = {}) {
  if (!Array.isArray(instructions) || !instructions.length) throw new TypeError('semantic-function-decoded-instructions-required');
  const ordered = instructions.slice().sort((left, right) => addressOf(left) < addressOf(right) ? -1 : addressOf(left) > addressOf(right) ? 1 : 0);
  const byAddress = new Map();
  for (const instruction of ordered) {
    const address = addressOf(instruction);
    if (byAddress.has(address.toString())) throw new TypeError('semantic-function-duplicate-instruction-address');
    byAddress.set(address.toString(), instruction);
  }

  const starts = new Set([addressOf(ordered[0]).toString()]);
  for (let index = 0; index < ordered.length; index++) {
    const instruction = ordered[index];
    const kind = controlKind(architecturePlugin, instruction);
    const target = directTarget(architecturePlugin, instruction);
    if (target != null && byAddress.has(target.toString()) && ['branch','conditional-branch'].includes(kind)) starts.add(target.toString());
    if ((['branch','conditional-branch','return','unknown'].includes(kind) || isAuthoritativeNoreturnCall(kind, options)) && ordered[index + 1]) starts.add(addressOf(ordered[index + 1]).toString());
  }

  const blocks = [];
  let current = null;
  for (const instruction of ordered) {
    const address = addressOf(instruction);
    if (!current || starts.has(address.toString())) {
      current = { key:keyOf(address), startAddress:address, instructions:[], successors:[] };
      blocks.push(current);
    }
    current.instructions.push({ decoded:instruction });
  }
  const byStart = new Map(blocks.map((block) => [block.startAddress.toString(), block]));
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const instruction = block.instructions.at(-1).decoded;
    const kind = controlKind(architecturePlugin, instruction);
    const target = directTarget(architecturePlugin, instruction);
    const targetBlock = target == null ? null : byStart.get(target.toString());
    const fallthroughBlock = byStart.get(endOf(instruction).toString()) || blocks[index + 1] || null;
    if (kind === 'conditional-branch') {
      if (targetBlock) block.successors.push({ to:targetBlock.key, kind:'conditional-true' });
      if (fallthroughBlock && (!targetBlock || fallthroughBlock.key !== targetBlock.key)) {
        block.successors.push({ to:fallthroughBlock.key, kind:'conditional-false' });
      }
    } else if (kind === 'branch') {
      if (targetBlock) block.successors.push({ to:targetBlock.key, kind:'branch' });
    } else if (!['return','unknown'].includes(kind) && !isAuthoritativeNoreturnCall(kind, options) && fallthroughBlock) {
      block.successors.push({ to:fallthroughBlock.key, kind:'fallthrough' });
    }
  }
  return blocks;
}

export function semanticAbiAdapter(abiPlugin, options = {}) {
  const plugin = abiPlugin && typeof abiPlugin === 'object' ? abiPlugin : null;
  const registryRegistered = isRegisteredABIPlugin(plugin);
  const registryDigest = registryRegistered ? abiPluginRegistryDigest(plugin) : null;
  const pluginId = String(plugin?.id || 'unknown');
  const semanticVersion = plugin?.semanticVersion == null ? null : String(plugin.semanticVersion);
  const semanticIdentity = plugin?.semanticIdentity == null ? null : String(plugin.semanticIdentity);
  const architectureId = plugin?.architectureId == null ? null : String(plugin.architectureId);
  const targetArchitecture = options?.architectureId || options?.architecture
    || options?.architectureProfile?.architectureId || architectureId;
  const platformId = options?.platformId || options?.platform || null;
  const profileIdentity = String(options?.profileIdentity
    || options?.architectureProfile?.semanticIdentity
    || options?.architectureProfile?.abiSemanticIdentity
    || semanticIdentity || '');
  const schemaVersion = options?.schemaVersion ?? options?.semanticIrSchemaVersion
    ?? options?.semanticIRSchemaVersion ?? null;
  const snapshotId = options?.snapshotId ?? options?.analysisSnapshotId ?? null;
  const analyzerId = options?.analyzerId ?? options?.analysisAnalyzerId ?? null;
  const analyzerVersion = options?.analyzerVersion ?? options?.analysisAnalyzerVersion ?? null;
  const binaryId = options?.binaryId ?? null;
  const sliceId = options?.sliceId ?? null;
  const functionId = options?.functionId ?? null;
  const targetArchitectureText = targetArchitecture == null ? '' : String(targetArchitecture).trim().toLowerCase();
  const architectureMatches = !targetArchitectureText
    || targetArchitectureText === String(architectureId || '').trim().toLowerCase()
    || (targetArchitectureText === 'arm64e' && String(architectureId || '').trim().toLowerCase() === 'arm64');
  const platformMatches = pluginId === 'darwin-arm64' ? (() => {
    try {
      return plugin?.platformPredicate?.({
        architecture:targetArchitectureText || String(architectureId || '').trim().toLowerCase(),
        platform:platformId == null ? null : String(platformId).trim().toLowerCase(),
      }) === true;
    } catch { return false; }
  })() : !platformId || (() => {
    try {
      return plugin?.platformPredicate?.({
        architecture:targetArchitectureText || String(architectureId || '').trim().toLowerCase(),
        platform:String(platformId).trim().toLowerCase(),
      }) === true;
    } catch { return false; }
  })();
  const appleArm64ePlatforms = new Set([
    'apple', 'darwin', 'macos', 'macosx', 'ios', 'ios-simulator', 'ipados',
    'tvos', 'watchos', 'visionos',
  ]);
  const arm64eProfileMatches = targetArchitectureText !== 'arm64e'
    || (pluginId === 'darwin-arm64' && platformId != null
      && appleArm64ePlatforms.has(String(platformId).trim().toLowerCase()));
  const supported = !!plugin && registryRegistered && !!registryDigest
    && plugin.supported !== false && pluginId !== 'unknown'
    && !!semanticVersion && !!semanticIdentity && !!architectureId
    && architectureMatches && platformMatches && arm64eProfileMatches;
  // A profile descriptor is an identity record, not a placement classifier.
  // Supplying it here makes every adapter carry an explicit canonical profile
  // even when a legacy caller omitted target metadata.  arm64e still requires
  // a real Apple platform at the consumer validation boundary.
  const architectureProfile = frozenAbiRecord({
    ...(options?.architectureProfile && typeof options.architectureProfile === 'object'
      ? options.architectureProfile : {}),
    id:options?.architectureProfile?.id ?? profileIdentity,
    profileIdentity:options?.architectureProfile?.profileIdentity ?? profileIdentity,
    semanticIdentity:options?.architectureProfile?.semanticIdentity ?? semanticIdentity,
    abiSemanticIdentity:options?.architectureProfile?.abiSemanticIdentity ?? semanticIdentity,
    abiId:options?.architectureProfile?.abiId ?? pluginId,
    architectureId:options?.architectureProfile?.architectureId
      ?? (targetArchitecture == null ? null : String(targetArchitecture)),
    architecture:options?.architectureProfile?.architecture
      ?? (targetArchitecture == null ? null : String(targetArchitecture)),
    platform:options?.architectureProfile?.platform ?? (platformId == null ? null : String(platformId)),
    platformId:options?.architectureProfile?.platformId ?? (platformId == null ? null : String(platformId)),
  });
  const identity = Object.freeze({
    id:pluginId,
    semanticVersion,
    semanticIdentity,
    architectureId,
    targetArchitecture:targetArchitecture == null ? null : String(targetArchitecture),
    platform:platformId == null ? null : String(platformId),
    profileIdentity,
    abiId:pluginId,
    registryDigest,
    schemaVersion:schemaVersion == null ? null : String(schemaVersion),
    snapshotId:snapshotId == null ? null : String(snapshotId),
    analyzerId:analyzerId == null ? null : String(analyzerId),
    analyzerVersion:analyzerVersion == null ? null : String(analyzerVersion),
    binaryId:optionalIdentity(binaryId),
    sliceId:optionalIdentity(sliceId),
    functionId:optionalIdentity(functionId),
    architectureProfile,
  });
  const provenance = Object.freeze({
    source:registryRegistered ? 'canonical-abi-registry' : 'unregistered-abi-adapter',
    abiId:pluginId,
    registryDigest,
    semanticIdentity,
    semanticVersion,
    architectureId,
    profileIdentity,
    targetArchitecture:identity.targetArchitecture,
    platformId:identity.platform,
    schemaVersion:identity.schemaVersion,
    snapshotId:identity.snapshotId,
    analyzerId:identity.analyzerId,
    analyzerVersion:identity.analyzerVersion,
    binaryId:identity.binaryId,
    sliceId:identity.sliceId,
    functionId:identity.functionId,
    architectureProfile,
  });
  const invalidation = Object.freeze({
    abiSemanticIdentity:semanticIdentity,
    abiSemanticVersion:semanticVersion,
    architectureId,
    targetArchitecture:identity.targetArchitecture,
    architectureProfile,
    profileIdentity,
    abiId:pluginId,
    registryDigest,
    platformId:identity.platform,
    schemaVersion:identity.schemaVersion,
    snapshotId:identity.snapshotId,
    analyzerId:identity.analyzerId,
    analyzerVersion:identity.analyzerVersion,
    binaryId:identity.binaryId,
    sliceId:identity.sliceId,
    functionId:identity.functionId,
    status:options?.invalidation?.status ?? options?.status ?? null,
    semanticFunctionRoute:SEMANTIC_FUNCTION_ROUTE,
  });
  const stackRules = (() => { try { return plugin?.stackRules?.() ?? {}; } catch { return {}; } })();
  const unwindRules = (() => { try { return plugin?.unwindRules?.() ?? {}; } catch { return {}; } })();

  function annotateCanonicalResult(result) {
    if (!result || typeof result !== 'object') return result || null;
    const annotated = {
      ...result,
      ...(supported ? {} : { status:'unsupported', completeness:'unsupported', unsupported:true }),
      abiId:pluginId,
      abiSemanticVersion:semanticVersion,
      abiSemanticIdentity:semanticIdentity,
      profileIdentity,
      abiIdentity:identity,
      registryDigest,
      provenance,
      invalidation,
    };
    if (annotated.indirect === true) {
      const pointer = typeof annotated.hiddenResultPointer === 'string'
        ? { input:annotated.hiddenResultPointer }
        : annotated.hiddenResultPointer;
      if (pointer && typeof pointer === 'object') {
        annotated.resultLocation = annotated.resultLocation ?? 'memory';
        annotated.hiddenResultPointer = {
          ...pointer,
          // Preserve the register selected by the canonical producer.  The
          // input field is part of the proof, not an adapter-controlled hint:
          // a copied result with a different pointer register must not become
          // a new exact hidden-sret placement at a consumer boundary.
          canonicalInput:pointer.canonicalInput ?? pointer.input ?? null,
          location:pointer.location ?? 'register',
          pointerBits:pointer.pointerBits ?? 64,
          profileIdentity,
          abiSemanticIdentity:semanticIdentity,
          abiId:pluginId,
          registryDigest,
          abiIdentity:identity,
          provenance,
          invalidation,
        };
      }
    }
    return annotated;
  }

  function classifyCanonicalArguments({ functionPrototype = null, call = null } = {}) {
    if (!registryRegistered || !plugin?.classifyArguments) return null;
    if (abiEvidenceState(options, call, plugin)) return null;
    const prototype = functionPrototype ?? call?.callPrototype ?? options?.callPrototype ?? null;
    const instruction = {
      callTarget:call?.target ?? call?.callTarget ?? null,
      callPrototype:prototype,
    };
    const classifyOptions = { ...options, callPrototype:prototype };
    try { return annotateCanonicalResult(plugin.classifyArguments(instruction, classifyOptions) || null); }
    catch { return null; }
  }

  function classifyCanonicalFunctionReturn({ functionPrototype = null, ...returnOptions } = {}) {
    if (!registryRegistered || !plugin?.classifyFunctionReturn) return null;
    if (abiEvidenceState({ ...options, ...returnOptions }, null, plugin)) return null;
    const prototype = functionPrototype ?? options?.functionPrototype ?? null;
    try {
      return annotateCanonicalResult(plugin.classifyFunctionReturn({
        functionPrototype:prototype,
        prototype,
        ...returnOptions,
      }) || null);
    } catch { return null; }
  }

  function canonicalReturnLocations(classified) {
    if (!classified || classified.partial === true || classified.unsupported === true
      || abiResultInvalidState(classified) || !canonicalAbiEvidence(classified)) return [];
    if (classified.indirect === true) {
      // Hidden sret is a complete indirect-return proof, never an ordinary
      // aggregate lane list.  Check it before inspecting pieces so a copied
      // result cannot smuggle direct lanes alongside an invalid pointer proof.
      const hidden = classified.hiddenResultPointer;
      const hiddenReg = typeof hidden === 'object' ? hidden.input : null;
      if (classified.resultLocation === 'memory' && typeof hiddenReg === 'string'
        && canonicalAbiHiddenResult(classified, hidden)) {
        return [{
          kind:'indirect', reg:hiddenReg, role:'result-address',
        }];
      }
      return [];
    }
    const pieces = Array.isArray(classified.pieces) && classified.pieces.length
      ? classified.pieces
      : Array.isArray(classified.parts) && classified.parts.length
        ? classified.parts
        : null;
    if (pieces) {
      const normalizedPieces = normalizeAbiPieces(classified, pieces, {
        defaultAbiClass:classified.aggregate === true ? 'aggregate-piece' : null,
      });
      if (!normalizedPieces) return [];
      const locations = normalizedPieces.map((piece, index) => {
        const rawReg = piece?.reg ?? null;
        const stackOffset = piece?.stackOffset ?? null;
        const kind = rawReg ? 'register' : 'stack';
        return {
          kind,
          ...(kind === 'register' ? { reg:String(rawReg) } : {}),
          abiClass:piece.abiClass,
          pieceIndex:piece.pieceIndex,
          bits:piece.bits,
          byteOffset:piece.byteOffset,
          ...(stackOffset == null ? {} : { stackOffset }),
          bytes:piece.bytes,
          order:piece.order ?? index,
          aggregate:classified.aggregate === true || pieces.length > 1,
        };
      });
      return locations;
    }
    const rawRegisters = Array.isArray(classified.regs) && classified.regs.length
      ? classified.regs
      : typeof classified.reg === 'string' && classified.reg.length ? [classified.reg] : [];
    const aggregate = classified.aggregate === true || rawRegisters.length > 1;
    if (aggregate) {
      // A register list is not an aggregate layout.  The producer must carry
      // the per-piece widths, physical byte spans, classes, and positions; do
      // not derive missing lanes from register count or total width.
      const aggregatePieces = Array.isArray(classified.pieces) && classified.pieces.length
        ? classified.pieces
        : Array.isArray(classified.parts) && classified.parts.length ? classified.parts : null;
      if (!aggregatePieces) return [];
      const normalizedPieces = normalizeAbiPieces(classified, aggregatePieces, {
        defaultAbiClass:'aggregate-piece',
      });
      if (!normalizedPieces) return [];
      return normalizedPieces.map((piece) => ({
        kind:'register',
        reg:String(piece.reg),
        abiClass:piece.abiClass,
        pieceIndex:piece.pieceIndex,
        bits:piece.bits,
        bytes:piece.bytes,
        byteOffset:piece.byteOffset,
        order:piece.order,
        aggregate:true,
      }));
    }
    const scalarBits = Number(classified.bits);
    const scalarBytes = classified.bytes == null ? Math.ceil(scalarBits / 8) : Number(classified.bytes);
    if (!Number.isSafeInteger(scalarBits) || scalarBits <= 0
      || !Number.isSafeInteger(scalarBytes) || scalarBytes <= 0) return [];
    const locations = rawRegisters.map((rawReg, index) => {
      if (typeof rawReg !== 'string' || !rawReg.length) return null;
      return {
        kind:'register',
        reg:String(rawReg),
        abiClass:classified.abiClass ?? null,
        pieceIndex:rawRegisters.length > 1 ? index : null,
        bits:scalarBits,
        byteOffset:null,
        stackOffset:null,
        bytes:scalarBytes,
        order:index,
        aggregate:false,
      };
    });
    if (locations.every(Boolean) && (locations.length || classified.indirect !== true)) return locations;
    const hidden = typeof classified.hiddenResultPointer === 'string'
      ? classified.hiddenResultPointer
      : classified.hiddenResultPointer?.input;
    return hidden ? [{ kind:'indirect', reg:String(hidden), role:'result-address', aggregate:true }] : [];
  }

  return Object.freeze({
    id:pluginId,
    semanticVersion,
    semanticIdentity,
    architectureId,
    targetArchitecture:identity.targetArchitecture,
    platformId:identity.platform,
    architectureProfile:identity.architectureProfile,
    profileIdentity,
    abiId:pluginId,
    registryDigest,
    schemaVersion:identity.schemaVersion,
    snapshotId:identity.snapshotId,
    analyzerId:identity.analyzerId,
    analyzerVersion:identity.analyzerVersion,
    binaryId:identity.binaryId,
    sliceId:identity.sliceId,
    functionId:identity.functionId,
    supported,
    // Keep the actual registry object attached to the adapter. Matching an id
    // and digest is insufficient: an unregistered classifier can copy both
    // fields while implementing different placement rules.
    registryPlugin:registryRegistered ? plugin : null,
    identity,
    provenance,
    invalidation,
    completeness:supported ? 'canonical' : 'unsupported',
    stackRules:() => stackRules,
    unwindRules:() => unwindRules,
    callerSaved:() => { try { return Object.freeze([...(plugin?.callerSaved?.(options) ?? [])]); } catch { return Object.freeze([]); } },
    calleeSaved:() => { try { return Object.freeze([...(plugin?.calleeSaved?.(options) ?? [])]); } catch { return Object.freeze([]); } },
    /**
     * Canonical ABI classification entry points.  These deliberately return
     * the registry classifier's evidence object unchanged: the adapter carries
     * identity/provenance around the one ABI truth, but never reimplements
     * placement or aggregate classification.
     */
    classifyArguments:classifyCanonicalArguments,
    classifyFunctionReturn:classifyCanonicalFunctionReturn,
    classifyEntryRegister(reg) {
      try { return plugin?.classifyEntryRegister?.(reg) || null; }
      catch { return null; }
    },
    /**
     * Physical register that carries a returned value of `returnType`, or null
     * when the ABI does not designate one. Generic decompiler code must ask for
     * this rather than assume a register name: AArch64's result register `x0`
     * is RISC-V's hardwired *zero* register, so a hardcoded name is not merely
     * imprecise, it reads the wrong location.
     */
    returnLocations({ classified = null, functionPrototype = null, returnType = null, ...returnOptions } = {}) {
      if (abiEvidenceState({ ...options, ...returnOptions }, null, plugin)) return Object.freeze([]);
      const prototype = functionPrototype ?? (returnType == null ? null : {
        returnType, returnsValue:true,
      });
      const result = classified ?? classifyCanonicalFunctionReturn({
        functionPrototype:prototype,
        returnType,
        ...returnOptions,
      });
      return Object.freeze(canonicalReturnLocations(result));
    },
    returnRegister(returnOptions = {}) {
      const type = String(returnOptions?.returnType
        ?? returnOptions?.functionPrototype?.returnType
        ?? returnOptions?.functionPrototype?.type
        ?? '').trim();
      if (!type || type.toLowerCase() === 'void') return null;
      const functionPrototype = returnOptions?.functionPrototype
        ?? (returnOptions && typeof returnOptions === 'object' ? returnOptions : null);
      if (abiEvidenceState({ ...options, ...returnOptions }, null, plugin)) return null;
      const classified = classifyCanonicalFunctionReturn({
        ...returnOptions, functionPrototype, returnType:type,
      });
      const locations = canonicalReturnLocations(classified);
      return locations.length === 1 && locations[0]?.kind === 'register' ? locations[0].reg : null;
    },
    /**
     * Ordered physical registers that carry incoming integer arguments. Generic
     * type recovery must ask the ABI for these: assuming `x0..x7` is an AAPCS64
     * fact, and on RISC-V those ids are the zero register, the return address,
     * the stack pointer, and the temporaries, so the assumption does not just
     * lose arguments, it reports the stack pointer as one.
     */
    argumentLocations({ functionPrototype = null } = {}) {
      const classified = classifyCanonicalArguments({ functionPrototype });
      // Physical argument locations are publishable only from the canonical
      // identity-bearing result.  Keep a producer's explicitly uncertain
      // fixed-prefix entries available (for example a known variadic prefix),
      // but never expose placements from a stale/partial-status result or an
      // unwrapped adapter object.
      const classifiedState = abiResultInvalidState(classified);
      const knownVariadicPartial = classified?.partial === true
        && classified?.unsupported !== true && functionPrototype != null
        && (functionPrototype?.variadic === true || functionPrototype?.varargs === true)
        && classifiedState === 'partial';
      const unknownPrototypePartial = classified?.partial === true
        && classified?.unsupported !== true && functionPrototype == null
        && classifiedState === 'partial';
      if (abiEvidenceState(options, null, plugin)
        || !classified || (classified.partial === true && functionPrototype != null && !knownVariadicPartial) || classified.unsupported === true
        || (classifiedState && !unknownPrototypePartial) || !canonicalAbiEvidence(classified)) return Object.freeze([]);
      const uncertain = classified.partial === true;
      const provenEntry = (entry) => entry?.partial !== true && entry?.possible !== true
        && entry?.mustUse !== false && entry?.exact !== false
        && entry?.named !== false && entry?.variadic !== true;
      const locations = [];
      const seen = new Set();
      for (const entry of classified?.arguments ?? []) {
        if (!entry || !['register','registers'].includes(entry.location)) continue;
        const registers = Array.isArray(entry.regs) ? entry.regs : typeof entry.reg === 'string' ? [entry.reg] : [];
        for (const register of registers) {
          const reg = String(register || '');
          if (!reg) continue;
          const key = String(entry.index ?? locations.length) + ':' + reg;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push(Object.freeze({
            index:Number.isInteger(Number(entry.index)) ? Number(entry.index) : locations.length,
            reg,
            abiClass:entry.abiClass ?? null,
            aggregate:entry.aggregate === true || Array.isArray(entry.pieces) || registers.length > 1,
            possible:uncertain && !provenEntry(entry),
            mustUse:!uncertain || provenEntry(entry),
            exact:!uncertain || provenEntry(entry),
            pieceIndex:Array.isArray(entry.pieces)
              ? (entry.pieces.findIndex((piece) => String(piece?.reg || '') === reg) >= 0
                ? entry.pieces.findIndex((piece) => String(piece?.reg || '') === reg)
                : null)
              : null,
            pieces:Array.isArray(entry.pieces) ? entry.pieces : null,
          }));
        }
      }
      return Object.freeze(locations);
    },
    argumentRegisters(options = {}) {
      return Object.freeze(this.argumentLocations(options).map((location) => location.reg));
    },
    /**
     * Registers whose spill/restore is pure call-frame bookkeeping rather than
     * program data: the frame pointer and the return address.
     */
    frameBookkeepingRegisters() {
      const named = [
        unwindRules.framePointer, stackRules.framePointer,
        unwindRules.returnAddressRegister, stackRules.returnAddressRegister,
        unwindRules.linkRegister, stackRules.linkRegister,
      ].filter((value) => typeof value === 'string' && value.length > 0);
      return Object.freeze([...new Set(named)]);
    },
    classifyCall({ call = null } = {}) {
      const classified = classifyCanonicalArguments({ call });
      const instruction = {
        callTarget:call?.target ?? null,
        callPrototype:options.callPrototype ?? call?.callPrototype ?? null,
      };
      let returned = null;
      try { returned = annotateCanonicalResult(plugin?.classifyCallReturn?.(instruction, { ...options, callPrototype:instruction.callPrototype }) ?? null); }
      catch { returned = null; }
      const evidenceState = abiEvidenceState(options, call, plugin);
      const classifierState = abiResultInvalidState(classified);
      const returnState = abiResultInvalidState(returned);
      // A classifier's partial result may still carry a conservative set of
      // possible input candidates.  Keep those candidates explicitly
      // uncertain, while treating every other terminal state as hard invalid
      // and withholding all exact placements.  In particular, `partial` must
      // not turn an exact-looking return lane into a publication.
      const hardEvidence = evidenceState && evidenceState !== 'partial';
      const hardClassifier = classifierState && classifierState !== 'partial';
      const hardInvalid = hardEvidence || classified == null || classified?.unsupported === true || hardClassifier;
      const candidateReturnPublish = !hardEvidence && !hardClassifier && !returnState
        && classified != null && classified?.partial !== true && classified?.unsupported !== true
        && returned != null && returned?.partial !== true && returned?.unsupported !== true;
      const candidateReturnLocations = candidateReturnPublish ? canonicalReturnLocations(returned) : [];
      const returnProofMissing = candidateReturnPublish && candidateReturnLocations.length === 0;
      const partial = !!hardInvalid || classified?.partial === true || !!returnState
        || returned?.partial === true || returned?.unsupported === true || returnProofMissing;
      const markUncertain = (entry) => ({
        ...entry,
        possible:true,
        mustUse:false,
        exact:false,
        certainty:'unknown',
      });
      const provenArgument = (entry) => entry?.partial !== true && entry?.possible !== true
        && entry?.mustUse !== false && entry?.exact !== false
        && entry?.named !== false && entry?.variadic !== true;
      const explicitArguments = hardInvalid ? null : Array.isArray(classified?.arguments)
        ? (partial ? classified.arguments.map((entry) => provenArgument(entry) ? entry : markUncertain(entry)) : classified.arguments)
        : null;
      const implicitInputs = hardInvalid ? [] : Array.isArray(classified?.implicitInputs)
        ? classified.implicitInputs.map((input, index) => Object.freeze({
          ...input,
          index:`implicit:${index}`,
          location:input.location ?? 'register',
          abiClass:input.abiClass ?? 'abi-implicit-input',
          implicit:true,
          variadicVectorRegisterCount:classified?.variadicVectorRegisterCount ?? null,
          countKnown:Number.isSafeInteger(classified?.variadicVectorRegisterCount),
          ...(partial ? { possible:true, mustUse:false, exact:false, certainty:'unknown' } : {}),
        }))
        : [];
      const publishableReturn = candidateReturnPublish && !returnProofMissing;
      const returnLocations = publishableReturn ? candidateReturnLocations : [];
      const returnRegister = returnLocations.length === 1 && returnLocations[0]?.kind === 'register'
        ? returnLocations[0].reg : null;
      return {
        arguments:hardInvalid ? null : explicitArguments == null ? (implicitInputs.length ? implicitInputs : null) : [...explicitArguments, ...implicitInputs],
        explicitArguments,
        implicitInputs,
        variadicVectorRegisterCount:classified?.variadicVectorRegisterCount ?? null,
        partial,
        completeness:evidenceState || classifierState || returnState
          || (returnProofMissing ? 'malformed' : classified == null || classified?.unsupported === true ? 'unknown' : partial ? 'partial' : 'complete'),
        stackArguments:hardInvalid || partial ? null : classified?.stackArguments ?? null,
        stackArgsUnknown:hardInvalid || partial ? true : classified?.stackArgsUnknown ?? true,
        stackArgsMayContainPointers:hardInvalid || partial ? true : classified?.stackArgsMayContainPointers ?? true,
        argumentEvidence:classified?.evidence ?? `abi-${pluginId}`,
        clobbers:(() => { try { return plugin?.callerSaved?.(options) ?? []; } catch { return []; } })(),
        returnReg:returnRegister,
        returnBits:publishableReturn ? returned?.bits ?? null : null,
        returnBytes:publishableReturn ? returned?.bytes ?? null : null,
        returnEvidence:publishableReturn && returned != null ? `abi-${pluginId}-return` : null,
        returnLocations,
        returnPieces:publishableReturn && Array.isArray(returned?.pieces) ? returned.pieces : publishableReturn && Array.isArray(returned?.parts) ? returned.parts : null,
        returnAggregate:publishableReturn && returned?.aggregate === true,
        returnIndirect:publishableReturn && returned?.indirect === true,
        returnHiddenResultPointer:publishableReturn ? returned?.hiddenResultPointer ?? null : null,
        noreturn:callNoreturnState(options),
        abiId:pluginId,
        registryDigest,
        abiSemanticVersion:semanticVersion,
        abiSemanticIdentity:semanticIdentity,
        abiIdentity:identity,
        provenance,
        invalidation,
      };
    },
  });
}

function legacyProjectionSnapshot(legacy) {
  return {
    name:legacy.name,
    functionId:legacy.functionId,
    startAddress:legacy.startAddress,
    truncated:legacy.truncated === true,
    entry:legacy.entry,
    instructions:(legacy.instructions || []).map((instruction) => ({
      id:instruction.id,
      op:instruction.op,
      sub:instruction.sub ?? null,
      row:instruction.row,
      address:instruction.address ?? null,
      block:instruction.block,
      args:(instruction.args || []).map((arg) => ({
        valueId:arg?.value?.semanticSsaValueId ?? arg?.value?.semanticValueId ?? arg?.value?.id ?? null,
        bits:arg?.bits ?? arg?.value?.bits ?? null,
      })),
      semanticNodeId:instruction.semanticNodeId ?? null,
      sourceInstructionIds:instruction.sourceInstructionIds ?? [],
      origin:instruction.origin ?? null,
    })),
    blocks:(legacy.blocks || []).map((block) => ({
      index:block.index,
      semanticBlockId:block.semanticBlockId,
      startRow:block.startRow,
      endRow:block.endRow,
      succ:block.succ ?? [],
      successorEdges:block.successorEdges ?? [],
      pred:block.pred ?? [],
      isEntry:block.isEntry === true,
      isExit:block.isExit === true,
      origin:block.origin ?? null,
    })),
    origin:legacy.origin,
    compat:{
      projection:legacy.compat?.projection,
      version:legacy.compat?.version,
      semanticFunctionId:legacy.compat?.semanticFunctionId,
      scalarSsa:legacy.compat?.scalarSsa === true,
      memorySsa:legacy.compat?.memorySsa === true,
      origins:legacy.compat?.origins ?? {},
    },
  };
}

function pipelineSnapshot(pipeline) {
  return {
    mode:pipeline.mode,
    pipelineVersion:pipeline.pipelineVersion,
    path:pipeline.path,
    semanticSchemaVersion:pipeline.semanticSchemaVersion,
    architectureId:pipeline.architectureId,
    architectureSemanticVersion:pipeline.architectureSemanticVersion,
    decoderSemanticVersion:pipeline.decoderSemanticVersion,
    scalarSsaPassVersion:pipeline.scalarSsaPassVersion,
    memorySsaPassVersion:pipeline.memorySsaPassVersion,
    binaryId:pipeline.binaryId,
    sliceId:pipeline.sliceId,
    functionId:pipeline.functionId,
    machineEffects:pipeline.machineEffects,
    semanticIr:pipeline.semanticIr,
    cfg:pipeline.cfg,
    ssa:pipeline.ssa,
    regions:pipeline.regions,
    memorySsa:pipeline.memorySsa,
    legacyV1:legacyProjectionSnapshot(pipeline.legacyV1),
    instrumentation:pipeline.instrumentation,
  };
}

function decompilerSnapshot(result) {
  return {
    semantic:result.semantic === true,
    signature:result.signature,
    summary:result.summary,
    pseudocode:result.pseudocode,
    lines:result.lines,
    evidence:result.evidence,
    warnings:result.warnings,
    labels:[...(result.labels || [])],
    coverage:result.coverage,
    unknownInstructions:result.ctx?.unknownInstructions ?? 0,
  };
}

function addressWidthBitsFor(architecturePlugin) {
  let descriptors = [];
  try { descriptors = architecturePlugin.registerFile() || []; } catch { descriptors = []; }
  const stack = descriptors.find((descriptor) => String(descriptor?.kind ?? '') === 'stack-pointer');
  const bits = Number(stack?.bits ?? 0);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : 64;
}

function assertRequiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`semantic-function-${label}-required`);
  }
  return value.trim();
}

export function analyzeDecodedSemanticFunction(input = {}, options = {}) {
  abortIfRequested(options.signal);
  if (!input || typeof input !== 'object') throw new TypeError('semantic-function-input-object-required');
  if (!Array.isArray(input.instructions)) throw new TypeError('semantic-function-decoded-instructions-required');
  const architectureId = String(input.architecture || '').trim().toLowerCase();
  const architecturePlugin = architecturePluginV2(architectureId);
  if (!architecturePlugin) throw new TypeError(`semantic-function-unsupported-architecture:${architectureId}`);
  const requestedInstructionEndianness = input.instructionEndianness ?? input.endianness ?? input.endian;
  if (requestedInstructionEndianness != null && requestedInstructionEndianness !== 'unknown') {
    const endian = String(requestedInstructionEndianness).trim().toLowerCase();
    const supported = architecturePlugin.supportedInstructionEndianness ?? [];
    if (supported.length && !supported.includes(endian))
      throw new TypeError(`semantic-function-unsupported-instruction-endianness:${endian}`);
  }
  const requestedMemoryEndianness = input.dataEndianness ?? input.endianness ?? input.endian;
  if (requestedMemoryEndianness != null && requestedMemoryEndianness !== 'unknown') {
    const endian = String(requestedMemoryEndianness).trim().toLowerCase();
    const supported = architecturePlugin.supportedMemoryEndianness ?? [];
    if (supported.length && !supported.includes(endian))
      throw new TypeError(`semantic-function-unsupported-memory-endianness:${endian}`);
  }
  const abiPlugin = resolveABIPlugin({ architecture:architectureId, platform:input.platform, abiId:input.abiId });
  if (!abiPlugin?.supported) throw new TypeError('semantic-function-supported-abi-required');
  if (abiPlugin.architectureId !== architectureId) throw new TypeError('semantic-function-abi-architecture-mismatch');
  const decoderSemanticVersion = assertRequiredString(input.decoderSemanticVersion, 'decoder-semantic-version');
  const binaryId = assertRequiredString(input.binaryId, 'binary-id');
  const sliceId = assertRequiredString(input.sliceId, 'slice-id');
  const blocks = partitionDecodedFunction(input.instructions, architecturePlugin, { callPrototype:input.callPrototype ?? null });
  const abiAdapter = semanticAbiAdapter(abiPlugin, input);
  let defaultMode = null;
  try { defaultMode = architecturePlugin.modes()?.[0] ?? null; } catch { defaultMode = null; }
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin,
    decoderSemanticVersion,
    binaryId,
    sliceId,
    addressWidthBits:addressWidthBitsFor(architecturePlugin),
    mode:input.mode ?? defaultMode ?? 'default',
    entryBlockKey:blocks[0].key,
    blocks,
    abiAdapter,
    machineEffectsContext:input.machineEffectsContext ?? {
      dataEndianness:input.dataEndianness,
      instructionEndianness:input.instructionEndianness,
    },
  }, { signal:options.signal, abiAdapter });
  abortIfRequested(options.signal);
  const decodedByInstructionId = new Map(pipeline.machineEffects.map((bundle, index) => [bundle.instructionId, input.instructions[index]]));
  const legacyRows = new Map();
  for (const legacy of pipeline.legacyV1.instructions) {
    const candidates = (legacy.origin?.instructionIds || []).map((id) => decodedByInstructionId.get(id)).filter(Boolean);
    const decoded = candidates.sort((left, right) => addressOf(left) < addressOf(right) ? -1 : addressOf(left) > addressOf(right) ? 1 : 0)[0] ?? input.instructions[0];
    if (!legacyRows.has(legacy.row)) legacyRows.set(legacy.row, {
      row:legacy.row,
      address:legacy.address == null ? addressOf(decoded) : BigInt(legacy.address),
      size:Number(decoded.length ?? decoded.size),
      mn:String(decoded.mnemonic || decoded.instructionFamily || ''),
      ops:String(decoded.opStr || ''),
    });
  }
  const maximumRow = Math.max(...legacyRows.keys());
  for (const block of pipeline.legacyV1.blocks) {
    const proven = (block.insts || []).map((instruction) => instruction.address).filter((address) => address != null).map(BigInt)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)[0];
    if (proven == null) continue;
    const prior = legacyRows.get(block.startRow);
    legacyRows.set(block.startRow, { ...(prior || { row:block.startRow, size:0, mn:'', ops:'' }), address:proven });
  }
  const model = {
    name:String(input.name || `sub_${addressOf(input.instructions[0]).toString(16)}`),
    instructions:Array.from({ length:maximumRow + 1 }, (_unused, row) => legacyRows.get(row) ?? {
      row, address:addressOf(input.instructions[0]), size:0, mn:'', ops:'',
    }),
    switches:[],
  };
  const decompiler = decompileSemantic(model, {
    ir:pipeline.legacyV1,
    abiAdapter,
    decoderSemanticVersion,
    binaryId,
    sliceId,
    addr:addressOf(input.instructions[0]),
    name:model.name,
    functionPrototype:input.functionPrototype ?? null,
  });
  if (!decompiler) throw new Error('semantic-function-shared-decompiler-produced-no-result');
  return Object.freeze({
    route:SEMANTIC_FUNCTION_ROUTE,
    version:String(input.analysisVersion ?? options.analysisVersion ?? '1'),
    architectureId,
    architectureSemanticVersion:architecturePlugin.semanticVersion,
    abiId:abiPlugin.id,
    abiSemanticVersion:abiPlugin.semanticVersion,
    decoderSemanticVersion,
    analysisContext:Object.freeze({
      dataEndianness:input.dataEndianness ?? null,
      instructionEndianness:input.instructionEndianness ?? null,
      architectureProfile:input.architectureProfile ?? null,
    }),
    pipeline:pipelineSnapshot(pipeline),
    decompiler:decompilerSnapshot(decompiler),
  });
}
