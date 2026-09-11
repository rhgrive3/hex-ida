import { architecturePluginV2 } from '../targets/architecture/index.js';
import {
  resolveABIPlugin, isRegisteredABIPlugin, abiPluginRegistryDigest,
  abiPluginRegistryGeneration,
} from '../targets/abi/index.js';
import {
  abiInvalidState, abiResultInvalidState, canonicalAbiEvidence, canonicalAbiHiddenResult,
  normalizeAbiPieces, abiPhysicalIntervalsValid,
} from '../targets/abi/evidence.js';
import { buildSemanticV2CompatibilityPipeline } from '../semantics/compat/index.js';
import { decompileSemantic } from '../decompiler/semantic.js';
import { canonicalAddress, createFunctionId } from '../core/identity/index.js';
import { validateSemanticIrFunction } from '../semantics/ir/function.js';

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

function optionalIdentity(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`semantic-function-abi-${label}-invalid`);
  }
  return value;
}

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
  if (options.thunkAmbiguous === true || options.tailCallAmbiguous === true
    || call?.thunkAmbiguous === true || call?.tailCallAmbiguous === true) return 'ambiguous';
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

function normalizedProtocolString(value, code, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim().toLowerCase();
  if (!allowEmpty && !text) throw new TypeError(code);
  return text;
}

// Instruction geometry decides block keys and fallthrough edges: it is CFG
// authority. Only primitive representations (bigint, safe integer number, or a
// canonical integer string) may define it; structured values fail closed.
function canonicalInstructionAddress(value, code) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    if (parsed >= 0n) return parsed;
  }
  throw new TypeError(code);
}

function addressOf(instruction) {
  return canonicalInstructionAddress(instruction.address, 'semantic-function-instruction-address-invalid');
}
function instructionLengthOf(instruction) {
  const length = canonicalInstructionAddress(
    instruction.length ?? instruction.size,
    'semantic-function-instruction-length-invalid',
  );
  if (length === 0n) throw new TypeError('semantic-function-instruction-length-invalid');
  return length;
}
function endOf(instruction) {
  return addressOf(instruction) + instructionLengthOf(instruction);
}
function keyOf(address) { return `block-${BigInt(address).toString(16)}`; }

function controlKind(plugin, instruction) {
  try { return String(plugin.classifyControlFlow?.(instruction) || 'fallthrough'); }
  catch { return 'unknown'; }
}

function directTarget(plugin, instruction) {
  try {
    const target = plugin.directControlTarget?.(instruction);
    if (target == null) return null;
    // Blank strings coerce to 0n and would mint a fake direct edge to address
    // 0 (#5741). Use the same strict non-negative integer contract as
    // instruction addresses; anything else means "no direct target".
    if (typeof target === 'string' && target !== target.trim()) return null;
    return canonicalInstructionAddress(target, 'semantic-function-direct-control-target-invalid');
  } catch { return null; }
}

function prototypeNoreturnState(prototype) {
  if (!prototype || typeof prototype !== 'object') return 'unknown';
  if (prototype.noreturn === true || prototype.returns === false) return true;
  if (prototype.noreturn === false || prototype.returns === true) return false;
  return 'unknown';
}

const SEMANTIC_CALL_PROTOTYPE_AUTHORITIES = new WeakSet();

function authorityAddressKey(value) {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value).toString();
  if (typeof value === 'string' && /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(value.trim())) {
    try {
      const parsed = BigInt(value.trim());
      return parsed >= 0n ? parsed.toString() : null;
    } catch { return null; }
  }
  return null;
}

/**
 * Build one stable callsite -> prototype authority shared by CFG and ABI consumers.
 * Callers provide already-classified callsites so each architecture route retains
 * its own strict control/target validation while prototype precedence and caching
 * stay identical. Resolver results (including null) are evaluated at most once
 * per callsite and the exact object identity is reused by every downstream stage.
 */
export function createSemanticCallPrototypeAuthority(callsites, options = {}) {
  if (!Array.isArray(callsites)) throw new TypeError('semantic-function-callsite-list-required');
  const entries = [];
  const byAddress = new Map();
  const byTarget = new Map();
  const byInstruction = new WeakMap();
  for (const raw of callsites) {
    if (!raw || typeof raw !== 'object' || !raw.instruction || typeof raw.instruction !== 'object') {
      throw new TypeError('semantic-function-callsite-invalid');
    }
    const addressKey = authorityAddressKey(raw.address ?? raw.instruction.address);
    if (addressKey == null || byAddress.has(addressKey)) throw new TypeError('semantic-function-callsite-address-invalid');
    const address = BigInt(addressKey);
    const entry = {
      instruction:raw.instruction,
      address,
      target:raw.target ?? null,
      call:null,
    };
    entry.call = Object.freeze({
      instruction:entry.instruction,
      address:entry.address,
      target:entry.target,
      callTarget:entry.target,
    });
    Object.freeze(entry);
    entries.push(entry);
    byAddress.set(addressKey, entry);
    byInstruction.set(entry.instruction, entry);
    const targetKey = authorityAddressKey(entry.target);
    if (targetKey != null) {
      if (!byTarget.has(targetKey)) byTarget.set(targetKey, []);
      byTarget.get(targetKey).push(entry);
    }
  }

  const resolver = typeof options?.callPrototypeFor === 'function' ? options.callPrototypeFor : null;
  const globalPrototype = options?.callPrototype ?? null;
  const cache = new Map();

  const resolveEntry = (entry) => {
    const key = entry.address.toString();
    if (cache.has(key)) return cache.get(key);
    let prototype = entry.instruction?.callPrototype ?? null;
    if (prototype == null && resolver) {
      try { prototype = resolver(entry.target, entry.call) ?? null; }
      catch { prototype = null; }
    }
    if (prototype == null && entries.length === 1) prototype = globalPrototype;
    cache.set(key, prototype);
    return prototype;
  };

  const entryForNode = (node, call = null) => {
    const matched = new Set();
    for (const range of node?.origin?.virtualRanges ?? []) {
      const key = authorityAddressKey(range?.start);
      if (key != null && byAddress.has(key)) matched.add(byAddress.get(key));
    }
    if (matched.size === 1) return [...matched][0];
    if (matched.size > 1) return null;
    const callKey = authorityAddressKey(call?.address);
    if (callKey != null && byAddress.has(callKey)) return byAddress.get(callKey);
    return entries.length === 1 ? entries[0] : null;
  };

  const authority = Object.freeze({
    callSiteCount:entries.length,
    prototypeForInstruction(instruction) {
      const entry = instruction && typeof instruction === 'object' ? byInstruction.get(instruction) : null;
      return entry ? resolveEntry(entry) : null;
    },
    prototypeForNode(node, call = null) {
      const entry = entryForNode(node, call);
      return entry ? { matched:true, prototype:resolveEntry(entry), address:entry.address, target:entry.target }
        : { matched:false, prototype:null, address:null, target:null };
    },
    prototypeObservationsForNode(node, call = null) {
      const entry = entryForNode(node, call);
      const targetKey = authorityAddressKey(entry?.target);
      const group = targetKey == null ? null : byTarget.get(targetKey);
      if (!group || group.length < 2) return null;
      // Grouping is linear in the input, and each comparison is bounded. Do
      // not turn a large direct-call group into quadratic classifier work or
      // pretend a sampled prefix proves the absence of contradictions.
      if (group.length > 64) return Object.freeze({ status:'budget-limited', target:entry.target });
      return Object.freeze({
        status:'complete', target:entry.target,
        observations:Object.freeze(group.map(peer => Object.freeze({
          address:peer.address, prototype:resolveEntry(peer),
        }))),
      });
    },
  });
  SEMANTIC_CALL_PROTOTYPE_AUTHORITIES.add(authority);
  return authority;
}

export function isSemanticCallPrototypeAuthority(value) {
  return !!value && typeof value === 'object' && SEMANTIC_CALL_PROTOTYPE_AUTHORITIES.has(value);
}

function canonicalCallPrototypeAuthority(value) {
  return isSemanticCallPrototypeAuthority(value) ? value : null;
}

function callPrototypeAuthorityFor(instructions, architecturePlugin, options = {}) {
  const supplied = canonicalCallPrototypeAuthority(options?.callPrototypeAuthority);
  if (supplied) return supplied;
  const callsites = [];
  for (const instruction of instructions) {
    if (controlKind(architecturePlugin, instruction) !== 'call') continue;
    callsites.push({
      instruction,
      address:addressOf(instruction),
      target:directTarget(architecturePlugin, instruction),
    });
  }
  return createSemanticCallPrototypeAuthority(callsites, options);
}

/**
 * Convert decoder-proven instruction starts into discovery facts for the shared
 * semantic pipeline. This is architecture-front-end work: generic CFG/SSA never
 * inspect register names or mnemonics.
 */
export function canonicalDecodedInstructions(instructions) {
  if (!Array.isArray(instructions) || !instructions.length) throw new TypeError('semantic-function-decoded-instructions-required');
  const ordered = instructions.slice().sort((left, right) => addressOf(left) < addressOf(right) ? -1 : addressOf(left) > addressOf(right) ? 1 : 0);
  const byAddress = new Map();
  let previousEnd = null;
  for (const instruction of ordered) {
    const address = addressOf(instruction);
    instructionLengthOf(instruction);
    if (byAddress.has(address.toString())) throw new TypeError('semantic-function-duplicate-instruction-address');
    // Sorted neighbors must not overlap byte ranges: [start,end) intervals of
    // a linear decoded stream are disjoint geometry (#5821). Overlapping
    // ranges would launder the same bytes into one linear path twice.
    const end = endOf(instruction);
    if (previousEnd != null && address < previousEnd) {
      throw new TypeError('semantic-function-instruction-range-overlap');
    }
    previousEnd = end;
    byAddress.set(address.toString(), instruction);
  }
  return { instructions: ordered, byAddress };
}

export function partitionDecodedFunction(instructions, architecturePlugin, options = {}) {
  const { instructions: ordered, byAddress } = canonicalDecodedInstructions(instructions);

  const callPrototypeAuthority = callPrototypeAuthorityFor(ordered, architecturePlugin, options);
  const controlByAddress = new Map();
  for (const instruction of ordered) {
    const address = addressOf(instruction);
    const kind = controlKind(architecturePlugin, instruction);
    const target = directTarget(architecturePlugin, instruction);
    const callPrototype = kind === 'call' ? callPrototypeAuthority.prototypeForInstruction(instruction) : null;
    controlByAddress.set(address.toString(), {
      kind,
      target,
      callPrototype,
      noreturn: kind === 'call' && prototypeNoreturnState(callPrototype) === true,
    });
  }

  const starts = new Set([addressOf(ordered[0]).toString()]);
  for (let index = 0; index < ordered.length; index++) {
    const instruction = ordered[index];
    const control = controlByAddress.get(addressOf(instruction).toString());
    const { kind, target } = control;
    if (target != null && byAddress.has(target.toString()) && ['branch','conditional-branch'].includes(kind)) starts.add(target.toString());
    if (ordered[index + 1] && addressOf(ordered[index + 1]) !== endOf(instruction)) {
      starts.add(addressOf(ordered[index + 1]).toString());
    }
    if ((['branch','conditional-branch','return','unknown'].includes(kind) || control.noreturn) && ordered[index + 1]) {
      starts.add(addressOf(ordered[index + 1]).toString());
    }
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
  for (const block of blocks) {
    const instruction = block.instructions.at(-1).decoded;
    const control = controlByAddress.get(addressOf(instruction).toString());
    const { kind, target } = control;
    const targetBlock = target == null ? null : byStart.get(target.toString());
    const fallthroughBlock = byStart.get(endOf(instruction).toString()) || null;
    if (kind === 'conditional-branch') {
      if (targetBlock) block.successors.push({ to:targetBlock.key, kind:'conditional-true' });
      if (fallthroughBlock && (!targetBlock || fallthroughBlock.key !== targetBlock.key)) {
        block.successors.push({ to:fallthroughBlock.key, kind:'conditional-false' });
      }
    } else if (kind === 'branch') {
      if (targetBlock) block.successors.push({ to:targetBlock.key, kind:'branch' });
    } else if (!['return','unknown'].includes(kind) && !control.noreturn && fallthroughBlock) {
      block.successors.push({ to:fallthroughBlock.key, kind:'fallthrough' });
    }
  }
  return blocks;
}

export function semanticControlUnknowns(blocks, architecturePlugin, options = {}) {
  if (!Array.isArray(blocks)) throw new TypeError('semantic-function-blocks-required');
  const instructions = blocks.flatMap((block) => (block.instructions || []).map((entry) => entry?.decoded).filter(Boolean));
  const callPrototypeAuthority = callPrototypeAuthorityFor(instructions, architecturePlugin, options);
  const blockStarts = new Set(blocks.map((block) => BigInt(block.startAddress).toString()));
  const unknowns = [];
  for (const block of blocks) {
    const instruction = block.instructions?.at(-1)?.decoded;
    if (!instruction) continue;
    const kind = controlKind(architecturePlugin, instruction);
    const callPrototype = kind === 'call' ? callPrototypeAuthority.prototypeForInstruction(instruction) : null;
    if (kind === 'branch' || kind === 'return' || kind === 'unknown'
        || (kind === 'call' && prototypeNoreturnState(callPrototype) === true)) continue;
    const expectedAddress = endOf(instruction);
    if (blockStarts.has(expectedAddress.toString())) continue;
    unknowns.push({
      reason: 'semantic-cfg-missing-fallthrough',
      categories: ['control'],
      detail: {
        blockKey: block.key,
        instructionAddress: addressOf(instruction).toString(),
        expectedAddress: expectedAddress.toString(),
      },
    });
  }
  return unknowns;
}

export function semanticAbiAdapter(abiPlugin, options = {}, internalOptions = {}) {
  const callPrototypeAuthority = canonicalCallPrototypeAuthority(internalOptions?.callPrototypeAuthority);
  const plugin = abiPlugin && typeof abiPlugin === 'object' ? abiPlugin : null;
  const registryRegistered = isRegisteredABIPlugin(plugin);
  const registryDigest = registryRegistered ? abiPluginRegistryDigest(plugin) : null;
  const registryGeneration = registryRegistered ? abiPluginRegistryGeneration(plugin) : null;
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
    registryGeneration,
    schemaVersion:schemaVersion == null ? null : String(schemaVersion),
    snapshotId:optionalIdentity(snapshotId, 'snapshot-id'),
    analyzerId:optionalIdentity(analyzerId, 'analyzer-id'),
    analyzerVersion:optionalIdentity(analyzerVersion, 'analyzer-version'),
    binaryId:optionalIdentity(binaryId, 'binary-id'),
    sliceId:optionalIdentity(sliceId, 'slice-id'),
    functionId:optionalIdentity(functionId, 'function-id'),
    architectureProfile,
  });
  const provenance = Object.freeze({
    source:registryRegistered ? 'canonical-abi-registry' : 'unregistered-abi-adapter',
    abiId:pluginId,
    registryDigest,
    registryGeneration,
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
    registryGeneration,
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

  /*
   * Canonical producers expose a complete stack argument in both public
   * arrays.  Give that intentional projection an internal marker before the
   * global interval validator runs; an unmarked duplicate (including a direct
   * scalar object supplied to abiPhysicalIntervalsValid) remains invalid.
   * Keep the marker non-enumerable so it cannot become a second public ABI
   * field or a serialization key.
   */
  function prepareCanonicalStackMirrors(result) {
    if (!result || typeof result !== 'object'
      || !Array.isArray(result.arguments) || !Array.isArray(result.stackArguments)) return result;
    const stackEntries = new Set(result.stackArguments);
    const mirrors = new Map();
    const mark = (entry) => {
      if (!stackEntries.has(entry) || String(entry?.location || '').toLowerCase() !== 'stack') return entry;
      if (mirrors.has(entry)) return mirrors.get(entry);
      const marked = { ...entry };
      Object.defineProperty(marked, 'canonicalStackMirror', { value:true, enumerable:false });
      mirrors.set(entry, marked);
      return marked;
    };
    const arguments_ = result.arguments.map(mark);
    if (!mirrors.size) return result;
    const stackArguments = result.stackArguments.map((entry) => mirrors.get(entry) ?? entry);
    return { ...result, arguments:arguments_, stackArguments };
  }

  function annotateCanonicalResult(result) {
    if (!result || typeof result !== 'object') return result || null;
    const prepared = prepareCanonicalStackMirrors(result);
    const physicalEvidenceValid = abiPhysicalIntervalsValid(prepared);
    const annotated = {
      ...prepared,
      ...(supported ? {} : { status:'unsupported', completeness:'unsupported', unsupported:true }),
      ...(!physicalEvidenceValid ? {
        malformedEvidence:true, status:'malformed', completeness:'malformed',
        evidence:'canonical ABI physical stack interval validation failed',
      } : {}),
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

  function resolveCallPrototype(call = null, node = null) {
    if (callPrototypeAuthority) {
      const resolved = callPrototypeAuthority.prototypeForNode(node, call);
      if (resolved.matched) return resolved.prototype;
    }
    const direct = call?.callPrototype ?? options?.callPrototype ?? null;
    if (direct != null || typeof options?.callPrototypeFor !== 'function') return direct;
    try {
      return options.callPrototypeFor(call?.target ?? call?.callTarget ?? null, call) ?? null;
    } catch {
      return null;
    }
  }

  function classifyCanonicalArguments({ functionPrototype = null, call = null, resolvePrototype = true } = {}) {
    if (!registryRegistered || !plugin?.classifyArguments) return null;
    if (abiEvidenceState(options, call, plugin)) return null;
    const prototype = functionPrototype ?? call?.callPrototype ?? options?.callPrototype
      ?? (resolvePrototype && call != null ? resolveCallPrototype(call) : null);
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

  // Compare canonical physical facts only. Source names, confidence and type
  // spelling are not ABI evidence; this is not a second placement classifier.
  function physicalObservation(entry) {
    const fields = ['index', 'kind', 'role', 'location', 'reg', 'regs', 'abiClass', 'bits', 'bytes',
      'offset', 'stackOffset', 'calleeEntryOffset', 'stackBytes', 'stackAlignment',
      'alignmentBytes', 'aggregate', 'byReference', 'indirect', 'pieceIndex', 'order', 'byteOffset'];
    const scalar = value => fields.map(field => value?.[field] ?? null);
    const pieces = entry?.pieces ?? entry?.parts;
    return [scalar(entry), Array.isArray(pieces) ? pieces.map(scalar) : null];
  }

  const declarationUnknown = Object.freeze({ version:1, status:'unknown', basis:'canonical-source-declarations' });
  const validatedFunctions = new WeakMap();
  const fixedDeclaration = value => value && !abiResultInvalidState(value)
    && value.variadic !== true && value.varargs !== true
    && ['parameters', 'params', 'args', 'arguments'].some(field => Array.isArray(value[field]));
  function declarationContextCurrent() {
    return (options.binaryId ?? null) === identity.binaryId && (options.sliceId ?? null) === identity.sliceId
      && (options.functionId ?? null) === identity.functionId
      && (options.snapshotId ?? options.analysisSnapshotId ?? null) === identity.snapshotId
      && (options.schemaVersion ?? options.semanticIrSchemaVersion ?? options.semanticIRSchemaVersion ?? null) === identity.schemaVersion
      && (options.analyzerId ?? options.analysisAnalyzerId ?? null) === identity.analyzerId
      && (options.analyzerVersion ?? options.analysisAnalyzerVersion ?? null) === identity.analyzerVersion;
  }
  function bindDeclarationIndex(ir, index) {
    if (index.startAddress == null) return null;
    const expected = createFunctionId({ binaryId:identity.binaryId, sliceId:identity.sliceId,
      canonicalStartIdentity:{ address:index.startAddress } });
    return expected === ir.functionId && (identity.functionId == null || identity.functionId === expected) ? index : null;
  }
  function declarationFunctionIndex(ir, { bindIdentity = true } = {}) {
    let index = validatedFunctions.get(ir);
    if (index) return bindIdentity ? bindDeclarationIndex(ir, index) : index;
    validateSemanticIrFunction(ir);
    const pending = [ir], visited = new Set();
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object' || visited.has(value)) continue;
      if (!Object.isFrozen(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return null;
      visited.add(value);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!Object.hasOwn(descriptor, 'value')) return null;
        pending.push(descriptor.value);
      }
    }
    index = { nodes:new Set(ir.nodes), byId:new Map(ir.nodes.map(value => [value.id, value])),
      values:new Map(ir.values.map(value => [value.id, value])) };
    const entry = ir.blocks.find(block => block.id === ir.entryBlockId);
    const starts = entry.nodeIds.flatMap(id => index.byId.get(id).origin?.virtualRanges ?? [])
      .map(range => BigInt(canonicalAddress(range.start)));
    index.startAddress = starts.length
      ? canonicalAddress(starts.reduce((left, right) => left < right ? left : right)) : null;
    const blocks = new Map(ir.blocks.map(block => [block.id, block]));
    const missingFallthrough = new Set(ir.unknowns
      .filter(unknown => unknown.reason === 'semantic-cfg-missing-fallthrough')
      .map(unknown => unknown.detail?.instructionAddress == null ? null : canonicalAddress(unknown.detail.instructionAddress)));
    const candidates = [];
    let truncated = false;
    for (const node of ir.nodes) {
      let reason = null;
      if (node.kind === 'unknown-control-effect') reason = 'unresolved-control-transfer';
      else if (missingFallthrough.has(null) || node.origin?.virtualRanges?.some(range => missingFallthrough.has(canonicalAddress(range.start)))) {
        reason = 'unresolved-transfer-destination';
      } else if (['branch', 'conditional-branch', 'switch'].includes(node.kind)
        && (!node.targets.length || node.targets.some(target => !blocks.get(target)?.nodeIds.length))) {
        reason = 'unresolved-transfer-destination';
      }
      if (!reason) continue;
      if (candidates.length === 64) { truncated = true; break; }
      const target = node.attributes?.machineControlEffect?.target;
      candidates.push(Object.freeze({ nodeId:node.id, reason,
        targetAddress:target?.kind === 'absolute-address' ? canonicalAddress(target.value) : null }));
    }
    // These are unresolved transfer candidates, not assertions that an
    // arbitrary branch is a thunk. Scan the whole supplied function: without
    // a bound CFG reachability proof, unreachable-looking nodes are not waived.
    index.controlTransfers = Object.freeze({ version:1,
      status:truncated ? 'budget-limited' : candidates.length ? 'ambiguous' : 'resolved',
      truncated, candidates:Object.freeze(candidates) });
    validatedFunctions.set(ir, index);
    return bindIdentity ? bindDeclarationIndex(ir, index) : index;
  }

  // Function-local negative evidence, not a new source of exact ABI facts.
  // Projection may normalize the same function into fresh immutable roots;
  // accumulate uncertainty instead of letting a later resolved copy erase it.
  // Reusing this function-scoped adapter for another function is stale.
  let observedFunctionId = null;
  let observedFunctionState = null;
  const observedFunctions = new WeakSet();
  function functionEvidenceState() {
    if (observedFunctionId === null && observedFunctionState === null) return null;
    return abiEvidenceState(options, null, plugin)
      || (!declarationContextCurrent() ? 'stale' : observedFunctionState);
  }
  function observeFunction({ semanticIr = null } = {}) {
    try {
      if (observedFunctions.has(semanticIr)) return functionEvidenceState();
      const index = declarationFunctionIndex(semanticIr, { bindIdentity:false });
      if (!index) throw new TypeError('abi-function-observation-not-immutable');
      // The function ID is opaque here. Legacy producers may supply a typed
      // canonicalStartIdentity (for example a bigint address); recomputing an
      // address-only declaration ID would falsely invalidate that valid route.
      // Exact external declaration comparison still uses bindDeclarationIndex.
      if ((observedFunctionId != null && observedFunctionId !== semanticIr.functionId)
        || (identity.functionId != null && identity.functionId !== semanticIr.functionId)) {
        observedFunctionState = 'stale';
      } else if (!['stale', 'malformed'].includes(observedFunctionState)) {
        const status = index.controlTransfers.status;
        if (status === 'budget-limited' || (status === 'ambiguous' && observedFunctionState == null)) {
          observedFunctionState = status;
        }
      }
      observedFunctionId ??= semanticIr.functionId;
      observedFunctions.add(semanticIr);
    } catch {
      observedFunctionState = 'malformed';
    }
    return functionEvidenceState();
  }

  function functionDeclaration({ semanticIr = null } = {}) {
    try {
      if (!supported || !isRegisteredABIPlugin(plugin) || abiPluginRegistryDigest(plugin) !== registryDigest
        || !declarationContextCurrent() || !identity.snapshotId || abiEvidenceState(options, null, plugin)
        || !fixedDeclaration(options.functionPrototype)) return null;
      const index = declarationFunctionIndex(semanticIr);
      if (!index) return null;
      return frozenAbiRecord({ version:2, basis:'canonical-source-declarations',
        status:index.controlTransfers.status === 'resolved' ? 'complete' : index.controlTransfers.status,
        controlTransfers:index.controlTransfers,
        binaryId:identity.binaryId, sliceId:identity.sliceId, snapshotId:identity.snapshotId,
        functionId:semanticIr.functionId, startAddress:index.startAddress,
        abiSemanticIdentity:semanticIdentity, abiId:pluginId, registryDigest, profileIdentity,
        schemaVersion:identity.schemaVersion, prototype:options.functionPrototype });
    } catch { return null; }
  }

  function compareCalleeDeclaration(node, call, ir, prototype, arguments_, returned) {
    if (!ir || !node || call !== node.call || abiEvidenceState(options, call, plugin)) return declarationUnknown;
    try {
      if (!fixedDeclaration(prototype) || (!fixedDeclaration(options.functionPrototype)
        && typeof options.calleeDeclarationFor !== 'function')) return declarationUnknown;
      const index = declarationFunctionIndex(ir);
      if (!index?.nodes.has(node)) return declarationUnknown;
      const bound = callPrototypeAuthority?.prototypeForNode(node, call);
      if (!bound?.matched || bound.target == null || bound.address == null) return declarationUnknown;
      if (!node.origin?.virtualRanges?.some(range => canonicalAddress(range.start) === canonicalAddress(bound.address))) return declarationUnknown;
      if (call.targetValueIds.length !== 1) return declarationUnknown;
      const targetValue = index.values.get(call.targetValueIds[0]);
      const targetNode = index.byId.get(targetValue?.definitionNodeId);
      if (targetNode?.kind !== 'const' || targetNode.attributes.constant?.kind !== 'bitvector'
        || canonicalAddress(targetNode.attributes.constant.value) !== canonicalAddress(bound.target)) return declarationUnknown;
      if (!declarationContextCurrent()) return declarationUnknown;
      const targetAddress = canonicalAddress(bound.target);
      const calleeFunctionId = createFunctionId({ binaryId:identity.binaryId, sliceId:identity.sliceId,
        canonicalStartIdentity:{ address:targetAddress } });
      let declaration = options.functionPrototype;
      let controlTransfers = index.controlTransfers;
      if (calleeFunctionId !== ir.functionId) {
        if (!identity.snapshotId || typeof options.calleeDeclarationFor !== 'function') return declarationUnknown;
        const source = options.calleeDeclarationFor(targetAddress, Object.freeze({
          binaryId:identity.binaryId, sliceId:identity.sliceId, snapshotId:identity.snapshotId,
          functionId:calleeFunctionId, abiSemanticIdentity:semanticIdentity,
        }));
        // This boundary is synchronous. Observe rejection without allowing a
        // late promise result to replace the current unknown declaration.
        if (source instanceof Promise) {
          source.catch(() => {});
          return declarationUnknown;
        }
        if (!source || source.version !== 2 || source.basis !== 'canonical-source-declarations'
          || !['complete', 'ambiguous', 'budget-limited'].includes(source.status)
          || (abiResultInvalidState(source) ?? 'complete') !== source.status
          || source.binaryId !== identity.binaryId || source.sliceId !== identity.sliceId
          || source.snapshotId !== identity.snapshotId || source.abiSemanticIdentity !== semanticIdentity
          || source.abiId !== pluginId || source.registryDigest !== registryDigest
          || source.profileIdentity !== profileIdentity || source.schemaVersion !== identity.schemaVersion
          || source.status !== (source.controlTransfers?.status === 'resolved' ? 'complete' : source.controlTransfers?.status)
          || source.functionId !== calleeFunctionId || source.startAddress !== targetAddress) return declarationUnknown;
        declaration = source.prototype;
        controlTransfers = source.controlTransfers;
      }
      if (!fixedDeclaration(declaration)) return declarationUnknown;
      if (!controlTransfers || controlTransfers.version !== 1
        || !['resolved', 'ambiguous', 'budget-limited'].includes(controlTransfers.status)
        || !Array.isArray(controlTransfers.candidates) || controlTransfers.candidates.length > 64
        || typeof controlTransfers.truncated !== 'boolean'
        || (controlTransfers.status === 'resolved' && (controlTransfers.candidates.length || controlTransfers.truncated))
        || (controlTransfers.status === 'ambiguous' && (!controlTransfers.candidates.length || controlTransfers.truncated))
        || (controlTransfers.status === 'budget-limited' && (!controlTransfers.truncated || controlTransfers.candidates.length !== 64))
        || !Array.from(controlTransfers.candidates).every(candidate => candidate
          && typeof candidate.nodeId === 'string' && candidate.nodeId.length > 0
          && ['unresolved-control-transfer', 'unresolved-transfer-destination'].includes(candidate.reason)
          && (candidate.targetAddress === null || canonicalAddress(candidate.targetAddress) === candidate.targetAddress))) return declarationUnknown;
      const comparisonIdentity = { version:1, basis:'canonical-source-declarations', functionId:ir.functionId,
        calleeFunctionId, nodeId:node.id, binaryId:identity.binaryId, sliceId:identity.sliceId,
        snapshotId:identity.snapshotId, callsiteAddress:canonicalAddress(bound.address), targetAddress,
        abiSemanticIdentity:semanticIdentity };
      if (controlTransfers.status !== 'resolved') {
        if (!declarationContextCurrent() || abiEvidenceState(options, call, plugin)) return declarationUnknown;
        return Object.freeze({ ...comparisonIdentity, status:controlTransfers.status,
          diagnostic:'unresolved-callee-control-transfer' });
      }
      const declaredArguments = classifyCanonicalArguments({ functionPrototype:declaration, resolvePrototype:false });
      const declaredReturn = classifyCanonicalFunctionReturn({ functionPrototype:declaration });
      const argumentSignature = value => value && !abiResultInvalidState(value)
        && canonicalAbiEvidence(value) && Array.isArray(value.arguments)
        && value.arguments.every(argument => argument && argument.possible !== true
          && argument.exact !== false && argument.mustUse !== false)
        ? JSON.stringify(value.arguments.map(physicalObservation)) : null;
      const returnSignature = value => {
        const locations = canonicalReturnLocations(value);
        return locations.length ? JSON.stringify([locations.map(physicalObservation), value.indirect === true]) : null;
      };
      const left = [argumentSignature(arguments_), returnSignature(returned)];
      const right = [argumentSignature(declaredArguments), returnSignature(declaredReturn)];
      const conflict = left.some((value, index) => value != null && right[index] != null && value !== right[index]);
      if (!conflict && !left.every((value, index) => value != null && value === right[index])) return declarationUnknown;
      if (!declarationContextCurrent() || abiEvidenceState(options, call, plugin)) return declarationUnknown;
      return Object.freeze({ ...comparisonIdentity, status:conflict ? 'conflict' : 'agreement' });
    } catch { return declarationUnknown; }
  }

  function callObservationState(node, call, prototype, classified, returned) {
    const group = callPrototypeAuthority?.prototypeObservationsForNode(node, call);
    if (!group) return null;
    if (group.status !== 'complete') return group.status;
    const argumentSignatures = new Set();
    const returnSignatures = new Set();
    for (const observation of group.observations) {
      const peer = observation.prototype;
      // Anonymous variadic arguments and missing declarations cannot prove
      // contradictory fixed signatures. They also never become agreement.
      if (!peer || abiResultInvalidState(peer) || peer.variadic === true || peer.varargs === true
        || !['parameters', 'params', 'args', 'arguments'].some(field => Array.isArray(peer[field]))) continue;
      const arguments_ = peer === prototype ? classified
        : classifyCanonicalArguments({ functionPrototype:peer, resolvePrototype:false });
      let returns = peer === prototype ? returned : null;
      if (peer !== prototype) {
        try {
          returns = annotateCanonicalResult(plugin?.classifyCallReturn?.(
            { callTarget:group.target, callPrototype:peer }, { ...options, callPrototype:peer },
          ) ?? null);
        } catch { returns = null; }
      }
      if (!arguments_ || abiResultInvalidState(arguments_) || !Array.isArray(arguments_.arguments)) continue;
      if (arguments_.arguments.some(argument => !argument || argument.possible === true
        || argument.exact === false || argument.mustUse === false)) continue;
      try {
        argumentSignatures.add(JSON.stringify(arguments_.arguments.map(physicalObservation)));
        if (argumentSignatures.size > 1) return 'conflict';
        // Missing return proof must not hide a proven argument contradiction.
        // Conversely, only canonical return locations can contradict another
        // return observation; a null classifier result is not a void proof.
        if (returns && !abiResultInvalidState(returns)) {
          const returnLocations = canonicalReturnLocations(returns);
          if (returnLocations.length) returnSignatures.add(JSON.stringify([
            returnLocations.map(physicalObservation), returns.indirect === true,
          ]));
        }
      } catch { continue; }
      if (returnSignatures.size > 1) return 'conflict';
    }
    // Even unanimous callsite observations are NOT independent callee proof.
    // Leave each original classifier's completeness and uncertainty unchanged.
    return null;
  }

  function canonicalReturnLocations(classified) {
    if (!classified || classified.partial === true || classified.unsupported === true
      || abiResultInvalidState(classified) || !canonicalAbiEvidence(classified)
      || !abiPhysicalIntervalsValid(classified)) return [];
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
    // Exact return placement requires primitive width identity. Number()
    // would launder structured values like ['32'] into a canonical width and
    // publish a malformed schema value as exact ABI evidence (#5814).
    if (typeof classified.bits !== 'number'
      || (classified.bytes != null && typeof classified.bytes !== 'number')) return [];
    const scalarBits = classified.bits;
    const scalarBytes = classified.bytes == null ? Math.ceil(scalarBits / 8) : classified.bytes;
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
    functionDeclaration,
    observeFunction,
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
    registryGeneration,
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
    // The shared decompiler receives this adapter, not the driver's original
    // options. Publish the same evidence state used by the classifiers so
    // consumers cannot recover cached placements after producer invalidation.
    // Keep it live: the options and AbortSignal can change after construction.
    get completeness() {
      return supported ? abiEvidenceState(options, null, plugin) || functionEvidenceState() || 'canonical' : 'unsupported';
    },
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
    classifyFunctionReturn(returnOptions = {}) {
      return functionEvidenceState() ? null : classifyCanonicalFunctionReturn(returnOptions);
    },
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
      if (functionEvidenceState() || abiEvidenceState({ ...options, ...returnOptions }, null, plugin)) return Object.freeze([]);
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
      if (functionEvidenceState() || abiEvidenceState({ ...options, ...returnOptions }, null, plugin)) return null;
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
      if (functionEvidenceState()) return Object.freeze([]);
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
      const provenEntry = (entry) => !unknownPrototypePartial
        && entry?.partial !== true && entry?.possible !== true
        && entry?.mustUse !== false && entry?.exact !== false
        && entry?.named !== false && entry?.variadic !== true;
      const locations = [];
      const seen = new Set();
      for (const entry of classified?.arguments ?? []) {
        if (!entry || !['register','registers'].includes(entry.location)) continue;
        // ABI argument locations are canonical middle-end authority. Structured
        // values must not launder into register identities or indices via
        // String()/Number() coercion; malformed plugin output fails closed.
        const registers = Array.isArray(entry.regs)
          ? entry.regs.filter((reg) => typeof reg === 'string' && reg.trim() !== '')
          : typeof entry.reg === 'string' && entry.reg.trim() !== '' ? [entry.reg] : [];
        for (const register of registers) {
          const reg = register;
          const explicitIndex = typeof entry.index === 'number' && Number.isSafeInteger(entry.index) ? entry.index : null;
          const key = String(explicitIndex ?? locations.length) + ':' + reg;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push(Object.freeze({
            index: explicitIndex ?? locations.length,
            reg,
            abiClass:entry.abiClass ?? null,
            aggregate:entry.aggregate === true || Array.isArray(entry.pieces) || registers.length > 1,
            possible:uncertain && !provenEntry(entry),
            mustUse:!uncertain || provenEntry(entry),
            exact:!uncertain || provenEntry(entry),
            ...(uncertain && !provenEntry(entry) ? { certainty:'unknown' } : {}),
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
    classifyCall({ node = null, call = null, semanticIr = null } = {}) {
      const callPrototype = resolveCallPrototype(call, node);
      const classified = classifyCanonicalArguments({ call, functionPrototype:callPrototype, resolvePrototype:false });
      // A call without a source prototype has no parameter grouping proof.
      // Keep even an over-eager/custom classifier conservative at this shared
      // boundary; a callback-based prototype resolver is the one exception
      // because the canonical producer can bind the call to source evidence.
      const unknownCallPrototype = callPrototype == null;
      const instruction = {
        callTarget:call?.target ?? null,
        callPrototype,
      };
      let returned = null;
      try { returned = annotateCanonicalResult(plugin?.classifyCallReturn?.(instruction, { ...options, callPrototype:instruction.callPrototype }) ?? null); }
      catch { returned = null; }
      const observationState = callObservationState(node, call, callPrototype, classified, returned);
      const callerCallee = observationState ? declarationUnknown
        : compareCalleeDeclaration(node, call, semanticIr, callPrototype, classified, returned);
      const evidenceState = abiEvidenceState(options, call, plugin) || observationState
        || (['conflict', 'ambiguous', 'budget-limited'].includes(callerCallee.status) ? callerCallee.status : null);
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
      const candidateReturnPublish = !unknownCallPrototype && !hardEvidence && !hardClassifier && !returnState
        && classified != null && classified?.partial !== true && classified?.unsupported !== true
        && returned != null && returned?.partial !== true && returned?.unsupported !== true;
      const candidateReturnLocations = candidateReturnPublish ? canonicalReturnLocations(returned) : [];
      const returnProofMissing = candidateReturnPublish && candidateReturnLocations.length === 0;
      const partial = !!hardInvalid || unknownCallPrototype || classified?.partial === true || !!returnState
        || returned?.partial === true || returned?.unsupported === true || returnProofMissing;
      const markUncertain = (entry) => ({
        ...entry,
        possible:true,
        mustUse:false,
        exact:false,
        certainty:'unknown',
      });
      const provenArgument = (entry) => !unknownCallPrototype
        && entry?.partial !== true && entry?.possible !== true
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
        callerCallee,
        argumentEvidence:['conflict', 'ambiguous', 'budget-limited'].includes(callerCallee.status)
          ? `abi-caller-callee-${callerCallee.status}`
          : observationState ? `abi-callsite-observations-${observationState}`
          : classified?.evidence ?? `abi-${pluginId}`,
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
        noreturn:prototypeNoreturnState(callPrototype),
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
  const architectureId = normalizedProtocolString(input.architecture, 'semantic-function-architecture-required');
  const architecturePlugin = architecturePluginV2(architectureId);
  if (!architecturePlugin) throw new TypeError(`semantic-function-unsupported-architecture:${architectureId}`);
  const requestedInstructionEndianness = input.instructionEndianness ?? input.endianness ?? input.endian;
  if (requestedInstructionEndianness != null) {
    const endian = normalizedProtocolString(requestedInstructionEndianness, 'semantic-function-invalid-instruction-endianness');
    if (endian !== 'unknown') {
      const supported = architecturePlugin.supportedInstructionEndianness ?? [];
      if (supported.length && !supported.includes(endian))
        throw new TypeError(`semantic-function-unsupported-instruction-endianness:${endian}`);
    }
  }
  const requestedMemoryEndianness = input.dataEndianness ?? input.endianness ?? input.endian;
  if (requestedMemoryEndianness != null) {
    const endian = normalizedProtocolString(requestedMemoryEndianness, 'semantic-function-invalid-memory-endianness');
    if (endian !== 'unknown') {
      const supported = architecturePlugin.supportedMemoryEndianness ?? [];
      if (supported.length && !supported.includes(endian))
        throw new TypeError(`semantic-function-unsupported-memory-endianness:${endian}`);
    }
  }
  const abiPlugin = resolveABIPlugin({ architecture:architectureId, platform:input.platform, abiId:input.abiId });
  if (!abiPlugin?.supported) throw new TypeError('semantic-function-supported-abi-required');
  if (abiPlugin.architectureId !== architectureId) throw new TypeError('semantic-function-abi-architecture-mismatch');
  const decoderSemanticVersion = assertRequiredString(input.decoderSemanticVersion, 'decoder-semantic-version');
  const binaryId = assertRequiredString(input.binaryId, 'binary-id');
  const sliceId = assertRequiredString(input.sliceId, 'slice-id');
  const orderedInstructions = canonicalDecodedInstructions(input.instructions).instructions;
  const callPrototypeAuthority = callPrototypeAuthorityFor(orderedInstructions, architecturePlugin, {
    callPrototype:input.callPrototype ?? null,
    callPrototypeFor:input.callPrototypeFor,
  });
  const cfgOptions = { callPrototypeAuthority };
  const blocks = partitionDecodedFunction(orderedInstructions, architecturePlugin, cfgOptions);
  const controlUnknowns = semanticControlUnknowns(blocks, architecturePlugin, cfgOptions);
  const abiAdapter = semanticAbiAdapter(abiPlugin, input, { callPrototypeAuthority });
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
    completeness: controlUnknowns.length ? 'partial' : 'complete',
    unknowns: controlUnknowns,
    abiAdapter,
    machineEffectsContext:input.machineEffectsContext ?? {
      dataEndianness:input.dataEndianness,
      instructionEndianness:input.instructionEndianness,
    },
  }, { signal:options.signal, abiAdapter });
  abortIfRequested(options.signal);
  const decodedByInstructionId = new Map(pipeline.machineEffects.map((bundle, index) => [bundle.instructionId, orderedInstructions[index]]));
  const legacyRows = new Map();
  for (const legacy of pipeline.legacyV1.instructions) {
    const candidates = (legacy.origin?.instructionIds || []).map((id) => decodedByInstructionId.get(id)).filter(Boolean);
    const decoded = candidates.sort((left, right) => addressOf(left) < addressOf(right) ? -1 : addressOf(left) > addressOf(right) ? 1 : 0)[0] ?? orderedInstructions[0];
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
    name:String(input.name || `sub_${addressOf(orderedInstructions[0]).toString(16)}`),
    instructions:Array.from({ length:maximumRow + 1 }, (_unused, row) => legacyRows.get(row) ?? {
      row, address:addressOf(orderedInstructions[0]), size:0, mn:'', ops:'',
    }),
    switches:[],
  };
  const decompiler = decompileSemantic(model, {
    ir:pipeline.legacyV1,
    abiAdapter,
    decoderSemanticVersion,
    binaryId,
    sliceId,
    addr:addressOf(orderedInstructions[0]),
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
