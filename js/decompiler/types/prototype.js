import { architecturePluginV2 } from '../../targets/architecture/index.js';
import { abiPlugin as registeredABIPlugin } from '../../targets/abi/index.js';
import {
  abiInvalidState, abiResultInvalidState, canonicalAbiEvidence, canonicalAbiHiddenResult,
  normalizeAbiPieces,
} from '../../targets/abi/evidence.js';

const ARCH_META_CACHE = new Map();
const REGISTER_CANDIDATE_CACHE = new Map();
const STACK_LAYOUT_CACHE = new Map();

function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function normalized(value) { return String(value ?? '').trim().toLowerCase(); }
function compatibleArchitecture(target, canonical) {
  const actual = normalized(target);
  const expected = normalized(canonical);
  if (!actual || !expected) return true;
  return actual === expected || (actual === 'arm64e' && expected === 'arm64');
}

function firstDefined(object, fields) {
  for (const field of fields) if (object?.[field] != null) return object[field];
  return null;
}

function identityToken(value) {
  if (!record(value)) return value;
  return firstDefined(value, ['semanticIdentity', 'abiSemanticIdentity', 'profileIdentity', 'id', 'value']);
}

function sameIdentity(left, right) {
  const a = identityToken(left);
  const b = identityToken(right);
  if (a == null || b == null) return a == null && b == null;
  return String(a) === String(b);
}

function sameIdentityValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameIdentityValue(value, right[index]));
  }
  if (record(left) || record(right)) {
    if (!record(left) || !record(right)) return false;
    const keys = Object.keys(right);
    return keys.length === Object.keys(left).length
      && keys.every((key) => Object.hasOwn(left, key) && sameIdentityValue(left[key], right[key]));
  }
  return sameIdentity(left, right);
}

function requireIdentityMirrors(container, mirrors, prefix) {
  if (!record(container)) return `${prefix}-record-malformed`;
  for (const [field, expected] of mirrors) {
    if (!Object.hasOwn(container, field) || !sameIdentityValue(container[field], expected)) {
      return `${prefix}-${field}-mismatch`;
    }
  }
  return null;
}

function requestedInvalidationState(adapter, opts = {}) {
  const optionState = abiResultInvalidState(opts);
  if (optionState) return optionState;
  const adapterState = abiResultInvalidState(adapter);
  if (adapterState) return adapterState;
  if (opts.cancelled === true || opts.canceled === true || opts.signal?.aborted === true) return 'cancelled';
  if (opts.deadlineExceeded === true || opts.deadlineExpired === true) return 'deadline-exceeded';
  if (opts.truncated === true || opts.truncatedRun === true) return 'truncated';
  if (opts.budgetExhausted === true || opts.resourceBudgetExhausted === true) return 'budget-exhausted';
  if (opts.budgetLimited === true || opts.resourceBudgetLimited === true) return 'budget-limited';
  if (opts.callerCalleeConflict === true || opts.callerCalleeAgreement === false) return 'conflict';
  if (opts.thunkAmbiguous === true || opts.tailCallAmbiguous === true) return 'ambiguous';
  if (opts.indirectCall === true && opts.functionPrototype == null && opts.prototype == null) return 'indirect-call';
  if (opts.malformedEvidence === true || opts.classifierFailed === true) return 'malformed';
  for (const value of [
    opts.status, opts.analysisStatus, opts.completeness, opts.evidenceStatus,
    opts.invalidation?.status, opts.invalidation?.state, opts.invalidation?.completeness,
    adapter?.status, adapter?.analysisStatus, adapter?.completeness,
    adapter?.invalidation?.status, adapter?.invalidation?.state, adapter?.invalidation?.completeness,
  ]) {
    const state = abiInvalidState(value);
    if (state) return state;
  }
  return null;
}

function validateABIIdentity(adapter, plugin, opts = {}) {
  if (!record(adapter)) return { supported:false, status:'malformed', reason:'abi-adapter-object-required' };
  if (!record(plugin) || plugin.supported === false || normalized(plugin.id) === 'unknown') {
    return { supported:false, status:'unsupported', reason:'abi-plugin-unsupported' };
  }
  const required = ['id', 'semanticVersion', 'semanticIdentity', 'architectureId'];
  if (required.some((field) => typeof adapter[field] !== 'string' || adapter[field].trim() === '')) {
    return { supported:false, status:'malformed', reason:'abi-identity-fields-incomplete' };
  }
  if (typeof adapter.classifyArguments !== 'function'
    || typeof adapter.classifyFunctionReturn !== 'function'
    || typeof adapter.classifyEntryRegister !== 'function'
    || typeof adapter.stackRules !== 'function'
    || !record(adapter.identity) || !record(adapter.provenance) || !record(adapter.invalidation)) {
    return { supported:false, status:'malformed', reason:'abi-adapter-contract-incomplete' };
  }
  if (normalized(adapter.id) !== normalized(plugin.id)) {
    return { supported:false, status:'stale', reason:'abi-id-mismatch' };
  }
  if (String(adapter.semanticVersion) !== String(plugin.semanticVersion)
    || String(adapter.semanticIdentity) !== String(plugin.semanticIdentity)) {
    return { supported:false, status:'stale', reason:'abi-semantic-identity-mismatch' };
  }
  if (normalized(adapter.architectureId) !== normalized(plugin.architectureId)) {
    return { supported:false, status:'profile-mismatch', reason:'abi-architecture-profile-mismatch' };
  }
  const targetArchitecture = firstDefined(adapter, ['targetArchitecture'])
    ?? firstDefined(opts, ['targetArchitecture', 'architecture', 'arch', 'architectureId']);
  if (!targetArchitecture) {
    return { supported:false, status:'profile-mismatch', reason:'abi-target-architecture-required' };
  }
  if (!compatibleArchitecture(targetArchitecture, plugin.architectureId)) {
    return { supported:false, status:'profile-mismatch', reason:'abi-target-architecture-mismatch' };
  }
  const platform = firstDefined(adapter, ['platformId', 'platform'])
    ?? firstDefined(opts, ['platformId', 'platform', 'os']);
  if (platform && typeof plugin.platformPredicate === 'function') {
    let platformMatches = false;
    try {
      platformMatches = plugin.platformPredicate({
        architecture:normalized(targetArchitecture || plugin.architectureId),
        platform:normalized(platform),
      }) === true;
    } catch { platformMatches = false; }
    if (!platformMatches) return { supported:false, status:'profile-mismatch', reason:'abi-platform-profile-mismatch' };
  }
  const profile = adapter.architectureProfile || opts.architectureProfile || null;
  if (!record(profile)) {
    return { supported:false, status:'malformed', reason:'abi-profile-identity-required' };
  }
  const profileArchitecture = firstDefined(profile, ['architectureId', 'architecture', 'arch']);
  if (!profileArchitecture || !compatibleArchitecture(profileArchitecture, targetArchitecture)) {
    return { supported:false, status:'profile-mismatch', reason:'abi-profile-architecture-mismatch' };
  }
  const profileIdentity = firstDefined(profile, ['profileIdentity', 'semanticIdentity', 'abiSemanticIdentity', 'id']);
  if (!profileIdentity || String(profileIdentity) !== String(plugin.semanticIdentity)) {
    return { supported:false, status:'stale', reason:'abi-profile-semantic-identity-mismatch' };
  }
  const canonicalProfileIdentity = firstDefined(adapter, ['profileIdentity'])
    ?? firstDefined(adapter.identity, ['profileIdentity'])
    ?? profileIdentity;
  if (String(canonicalProfileIdentity) !== String(plugin.semanticIdentity)) {
    return { supported:false, status:'stale', reason:'abi-profile-identity-mismatch' };
  }
  // arm64e is an ISA/profile variant, not an ABI authorization.  It is valid
  // only with an explicit Apple platform/profile identity; architecture text
  // alone must never select Darwin or AAPCS64 placement.
  if (normalized(targetArchitecture) === 'arm64e'
    && (!platform || !['apple', 'darwin', 'macos', 'macosx', 'ios', 'ios-simulator', 'ipados', 'tvos', 'watchos', 'visionos'].includes(normalized(platform)))) {
    return { supported:false, status:'profile-mismatch', reason:'abi-arm64e-platform-profile-required' };
  }
  if (normalized(targetArchitecture) === 'arm64e' && normalized(plugin.id) !== 'darwin-arm64') {
    return { supported:false, status:'profile-mismatch', reason:'abi-arm64e-darwin-profile-required' };
  }

  if (!record(adapter.identity)) return { supported:false, status:'malformed', reason:'abi-identity-record-malformed' };
  const profileMirrors = [
    ['id', plugin.semanticIdentity],
    ['profileIdentity', plugin.semanticIdentity],
    ['semanticIdentity', plugin.semanticIdentity],
    ['abiSemanticIdentity', plugin.semanticIdentity],
    ['abiId', plugin.id],
    ['architectureId', targetArchitecture],
    ['architecture', targetArchitecture],
    ['platform', platform],
    ['platformId', platform],
  ];
  const profileMirrorError = requireIdentityMirrors(profile, profileMirrors, 'abi-profile');
  if (profileMirrorError) {
    return { supported:false, status:'stale', reason:profileMirrorError };
  }
  const identityMirrors = [
    ['id', adapter.id],
    ['semanticVersion', adapter.semanticVersion],
    ['semanticIdentity', adapter.semanticIdentity],
    ['architectureId', adapter.architectureId],
    ['targetArchitecture', targetArchitecture],
    ['platform', platform],
    ['profileIdentity', canonicalProfileIdentity],
    ['abiId', adapter.id],
    ['schemaVersion', adapter.schemaVersion ?? null],
    ['snapshotId', adapter.snapshotId ?? null],
    ['analyzerId', adapter.analyzerId ?? null],
    ['analyzerVersion', adapter.analyzerVersion ?? null],
    ['binaryId', adapter.binaryId ?? null],
    ['sliceId', adapter.sliceId ?? null],
    ['functionId', adapter.functionId ?? null],
    ['architectureProfile', profile],
  ];
  const identityMirrorError = requireIdentityMirrors(adapter.identity, identityMirrors, 'abi-nested');
  if (identityMirrorError) {
    return { supported:false, status:'stale', reason:identityMirrorError };
  }

  const provenanceMirrors = [
    ['abiId', plugin.id],
    ['semanticVersion', plugin.semanticVersion],
    ['semanticIdentity', plugin.semanticIdentity],
    ['architectureId', plugin.architectureId],
    ['profileIdentity', canonicalProfileIdentity],
    ['targetArchitecture', targetArchitecture],
    ['platformId', platform],
    ['schemaVersion', adapter.schemaVersion ?? null],
    ['snapshotId', adapter.snapshotId ?? null],
    ['analyzerId', adapter.analyzerId ?? null],
    ['analyzerVersion', adapter.analyzerVersion ?? null],
    ['binaryId', adapter.binaryId ?? null],
    ['sliceId', adapter.sliceId ?? null],
    ['functionId', adapter.functionId ?? null],
    ['architectureProfile', profile],
  ];
  if (adapter.provenance.source !== 'canonical-abi-registry') {
    return { supported:false, status:'stale', reason:'abi-provenance-mismatch' };
  }
  const provenanceMirrorError = requireIdentityMirrors(adapter.provenance, provenanceMirrors, 'abi-provenance');
  if (provenanceMirrorError) {
    return { supported:false, status:'stale', reason:provenanceMirrorError };
  }

  const invalidationMirrors = [
    ['abiId', plugin.id],
    ['abiSemanticIdentity', plugin.semanticIdentity],
    ['abiSemanticVersion', plugin.semanticVersion],
    ['architectureId', plugin.architectureId],
    ['targetArchitecture', targetArchitecture],
    ['platformId', platform],
    ['profileIdentity', canonicalProfileIdentity],
    ['schemaVersion', adapter.schemaVersion ?? null],
    ['snapshotId', adapter.snapshotId ?? null],
    ['analyzerId', adapter.analyzerId ?? null],
    ['analyzerVersion', adapter.analyzerVersion ?? null],
    ['binaryId', adapter.binaryId ?? null],
    ['sliceId', adapter.sliceId ?? null],
    ['functionId', adapter.functionId ?? null],
    ['architectureProfile', profile],
  ];
  const invalidationMirrorError = requireIdentityMirrors(adapter.invalidation, invalidationMirrors, 'abi-invalidation');
  if (invalidationMirrorError) {
    return { supported:false, status:'stale', reason:invalidationMirrorError };
  }

  const expectedIdentityFields = [
    ['binaryId', ['binaryId', 'binaryIdentity']],
    ['sliceId', ['sliceId', 'sliceIdentity']],
    ['functionId', ['functionId', 'functionIdentity', 'semanticFunctionId']],
    ['snapshotId', ['snapshotId', 'analysisSnapshotId', 'snapshotIdentity']],
    ['analyzerId', ['analyzerId', 'analysisAnalyzerId']],
    ['analyzerVersion', ['analyzerVersion', 'analysisAnalyzerVersion']],
    ['schemaVersion', ['schemaVersion', 'semanticIrSchemaVersion', 'semanticIRSchemaVersion']],
  ];
  for (const [field, optionFields] of expectedIdentityFields) {
    const expected = firstDefined(opts, optionFields);
    if (expected == null) continue;
    const observed = adapter.invalidation?.[field];
    if (observed == null || !sameIdentity(observed, expected)) {
      return { supported:false, status:'stale', reason:`abi-${field}-identity-mismatch` };
    }
  }
  const expectedArchitecture = firstDefined(opts, ['architecture', 'arch']);
  if (expectedArchitecture != null && !sameIdentity(targetArchitecture, expectedArchitecture)) {
    return { supported:false, status:'profile-mismatch', reason:'abi-target-architecture-identity-mismatch' };
  }
  const expectedCanonicalArchitecture = opts.architectureId;
  if (expectedCanonicalArchitecture != null && !sameIdentity(adapter.architectureId, expectedCanonicalArchitecture)) {
    return { supported:false, status:'profile-mismatch', reason:'abi-architecture-identity-mismatch' };
  }
  const expectedPlatform = firstDefined(opts, ['platformId', 'platform', 'os']);
  if (expectedPlatform != null && !sameIdentity(platform, expectedPlatform)) {
    return { supported:false, status:'profile-mismatch', reason:'abi-platform-identity-mismatch' };
  }
  const expectedProfile = firstDefined(opts, ['profileIdentity', 'architectureProfileId']);
  if (expectedProfile != null && !sameIdentity(canonicalProfileIdentity, expectedProfile)) {
    return { supported:false, status:'stale', reason:'abi-profile-identity-mismatch' };
  }
  const expectedAbi = firstDefined(opts, ['abiId', 'abi', 'callingConvention', 'convention']);
  if (typeof expectedAbi === 'string' && !sameIdentity(plugin.id, expectedAbi)) {
    return { supported:false, status:'stale', reason:'abi-id-identity-mismatch' };
  }
  const expectedVersion = firstDefined(opts, ['semanticVersion', 'abiSemanticVersion']);
  if (expectedVersion != null && !sameIdentity(plugin.semanticVersion, expectedVersion)) {
    return { supported:false, status:'stale', reason:'abi-version-identity-mismatch' };
  }
  const expectedSemanticIdentity = firstDefined(opts, ['semanticIdentity', 'abiSemanticIdentity']);
  if (expectedSemanticIdentity != null && !sameIdentity(plugin.semanticIdentity, expectedSemanticIdentity)) {
    return { supported:false, status:'stale', reason:'abi-semantic-identity-mismatch' };
  }
  if (adapter.supported === false) return { supported:false, status:'unsupported', reason:'abi-adapter-unsupported' };
  return { supported:true, status:'canonical', reason:null };
}

function tname(t, fallback = 'unknown') { return t?.name || t?.type || fallback; }
function used(v) { return (v?.uses || []).some((u) => u && !u.clobbered); }
function bitsOf(t) { return Number(t?.bits || (t?.size ? Number(t.size) * 8 : 0) || 0); }
function kindOf(t) { return String(t?.kind || t?.class || t?.abiClass || '').toLowerCase(); }
function stringValue(value) { return typeof value === 'string' && value.length ? value : null; }

function abiContext(opts = {}) {
  const adapter = opts.abiAdapter || null;
  let plugin = opts.abiPlugin || null;
  if (!plugin && adapter?.id) {
    try { plugin = registeredABIPlugin(adapter.id); } catch { plugin = null; }
  }
  const invalidation = requestedInvalidationState(adapter, opts);
  const identity = validateABIIdentity(adapter, plugin, opts);
  const validation = invalidation
    ? { supported:false, status:invalidation, reason:`abi-evidence-${invalidation}` }
    : identity;
  const supported = validation.supported === true;
  const cacheKey = supported ? String(plugin.semanticIdentity || `${plugin.id}@${plugin.semanticVersion || '1'}`) : 'unknown';
  let meta = ARCH_META_CACHE.get(cacheKey) || null;
  if (!meta) {
    let architecture = null;
    try { if (supported) architecture = architecturePluginV2(plugin.architectureId); } catch { architecture = null; }
    let registers = [];
    try { registers = architecture?.registerFile?.() || []; } catch { registers = []; }
    const aliases = new Map();
    for (const descriptor of registers) {
      const canonicalReg = stringValue(descriptor?.physicalId) || stringValue(descriptor?.id);
      if (!canonicalReg) continue;
      for (const name of [descriptor?.id, descriptor?.physicalId, descriptor?.abiName, ...(Array.isArray(descriptor?.views) ? descriptor.views : [])]) {
        const value = stringValue(name);
        if (value) aliases.set(value.toLowerCase(), canonicalReg);
      }
    }
    const canonicalReg = (reg) => aliases.get(String(reg || '').toLowerCase()) || String(reg || '');
    const stackPointers = new Set();
    for (const descriptor of registers) {
      if (descriptor?.kind !== 'stack-pointer' && descriptor?.role !== 'stack-pointer') continue;
      for (const name of [descriptor?.id, descriptor?.physicalId, descriptor?.abiName]) {
        const value = stringValue(name);
        if (value) stackPointers.add(canonicalReg(value));
      }
    }
    meta = { aliases, stackPointers };
    ARCH_META_CACHE.set(cacheKey, meta);
  }
  const canonical = (reg) => meta.aliases.get(String(reg || '').toLowerCase()) || String(reg || '');
  return {
    adapter, plugin, supported, status:validation.status, reason:validation.reason,
    canonical, stackPointers:meta.stackPointers, cacheKey,
    identity:supported ? {
      id:String(plugin.id), semanticVersion:String(plugin.semanticVersion),
      semanticIdentity:String(plugin.semanticIdentity), architectureId:String(plugin.architectureId),
      targetArchitecture:adapter?.targetArchitecture ?? null,
      platform:adapter?.platformId ?? adapter?.platform ?? null,
      profileIdentity:adapter?.profileIdentity ?? adapter?.identity?.profileIdentity ?? null,
      abiId:adapter?.abiId ?? adapter?.id ?? null,
      schemaVersion:adapter?.schemaVersion ?? adapter?.identity?.schemaVersion ?? null,
      snapshotId:adapter?.snapshotId ?? adapter?.identity?.snapshotId ?? null,
      analyzerId:adapter?.analyzerId ?? adapter?.identity?.analyzerId ?? null,
      analyzerVersion:adapter?.analyzerVersion ?? adapter?.identity?.analyzerVersion ?? null,
      architectureProfile:adapter?.architectureProfile ?? null,
      invalidation:adapter?.invalidation ?? null,
    } : null,
  };
}

function classifyArguments(ctx, functionPrototype) {
  if (!ctx?.supported || !ctx.adapter?.classifyArguments) return null;
  try {
    const classified = ctx.adapter.classifyArguments({ functionPrototype }) || null;
    const state = abiResultInvalidState(classified);
    // An unprototyped call deliberately carries possible register candidates
    // as a conservative frontier.  Keep that uncertainty available, but do
    // not let a partial result with a known prototype become a source of exact
    // parameter entries.
    const hasParameterList = ['parameters', 'params', 'args', 'arguments']
      .some((field) => Array.isArray(functionPrototype?.[field]));
    const uncertainUnknownPrototype = classified?.partial === true
      && classified?.unsupported !== true && !hasParameterList;
    const knownVariadicPartial = classified?.partial === true
      && classified?.unsupported !== true && hasParameterList
      && (functionPrototype?.variadic === true || functionPrototype?.varargs === true)
      && state === 'partial';
    if (!classified || (state && !uncertainUnknownPrototype && !knownVariadicPartial) || classified.unsupported === true) {
      ctx.classifierState ||= state || (classified?.unsupported === true ? 'unsupported' : 'unknown');
      return null;
    }
    return classified;
  } catch { ctx.classifierState ||= 'failed'; return null; }
}

function registerCandidates(ctx) {
  if (!ctx.supported) return new Map();
  const cached = REGISTER_CANDIDATE_CACHE.get(ctx.cacheKey);
  if (cached) return cached;
  const out = new Map();
  const add = (reg, entry = {}) => {
    const canonical = ctx.canonical(reg);
    if (!canonical || out.has(canonical)) return;
    out.set(canonical, {
      reg:canonical,
      bankIndex:Number.isInteger(Number(entry.index)) ? Number(entry.index) : null,
      abiClass:entry.abiClass ?? null,
    });
  };
  const probes = [
    { type:'int64', bits:64, abiClass:'integer' },
    { type:'double', bits:64, abiClass:'fp' },
    { type:'void *', bits:64, pointer:true, abiClass:'pointer' },
  ];
  for (const parameter of probes) {
    const functionPrototype = { parameters:Array.from({ length:16 }, () => ({ ...parameter })) };
    const classified = classifyArguments(ctx, functionPrototype);
    for (const entry of classified?.arguments || []) {
      if (!entry || !['register','registers'].includes(entry.location)) continue;
      const regs = Array.isArray(entry.regs) ? entry.regs : [entry.reg];
      for (const reg of regs) if (typeof reg === 'string') add(reg, entry);
    }
  }
  REGISTER_CANDIDATE_CACHE.set(ctx.cacheKey, out);
  return out;
}

function isFpAbiClass(value) {
  return /fp|float|sse|vector|hfa|hva|simd/.test(String(value || '').toLowerCase());
}

function aggregateKind(value) {
  return /aggregate|hfa|hva|eightbyte|wide-integer|integer-pair/.test(String(value || '').toLowerCase());
}

function normalizeArgumentPieces(entry, regs, pieces) {
  const kind = String(entry?.abiClass || '').toLowerCase();
  const homogeneous = /hfa|hva|homogeneous/.test(kind) || entry?.hfa === true || entry?.hva === true;
  // A multi-lane/aggregate register list is not enough evidence to recover a
  // layout.  Require the canonical producer's explicit piece records instead
  // of filling widths, byte offsets, or classes from register order.
  // Aggregate placement is canonical only when the producer supplied every
  // physical piece.  Register lists, total width, and a stack offset are not
  // enough to recover padding, lane order, or a split register/stack layout.
  if (!pieces?.length) return null;
  const locations = pieces;
  if (homogeneous) {
    const memberCount = Number(entry.members ?? entry.memberCount ?? entry.elementCount);
    const elementBits = Number(entry.elementBits ?? entry.memberBits);
    if (!Number.isSafeInteger(memberCount) || memberCount < 1 || memberCount > 4
      || !Number.isSafeInteger(elementBits) || elementBits <= 0
      || locations.length !== memberCount) return null;
  }
  const normalized = normalizeAbiPieces({
    ...entry,
    bits:entry.bits,
    bytes:entry.bytes,
    elementBits:homogeneous ? Number(entry.elementBits ?? entry.memberBits) : entry.elementBits,
  }, locations, { defaultAbiClass:aggregateKind(entry.abiClass) ? entry.abiClass : null });
  return normalized;
}

function physicalArgumentView(argument, reg, pieceIndex, value) {
  const { regs:_regs, pieces:_pieces, valueIds:_valueIds, pieceValueIds:_pieceValueIds, ...rest } = argument;
  return {
    ...rest,
    reg,
    pieceIndex,
    valueId:value?.id ?? null,
    aggregatePiece:argument.aggregate === true,
  };
}

function physicalArgumentBanks(registerArgs, ir) {
  const physical = [];
  for (const argument of registerArgs) {
    const regs = Array.isArray(argument.regs) && argument.regs.length ? argument.regs : [argument.reg];
    for (let index = 0; index < regs.length; index++) {
      const reg = regs[index];
      let value = null;
      for (const [rawReg, entryValue] of ir?.args?.entries?.() || []) {
        if (String(rawReg) === String(reg)) { value = entryValue; break; }
      }
      physical.push(physicalArgumentView(argument, reg, index, value));
    }
  }
  return physical;
}

function canonicalFunctionArgumentEntries(ctx, opts = {}) {
  const functionPrototype = opts?.functionPrototype || opts?.prototype || null;
  if (!functionPrototype || !ctx.supported) return null;
  const classified = classifyArguments(ctx, functionPrototype);
  if (!classified || !Array.isArray(classified.arguments)) return [];
  const entries = [];
  for (const entry of classified.arguments.filter((candidate) => candidate
    && candidate.partial !== true && candidate.unsupported !== true
    && candidate.possible !== true && candidate.mustUse !== false)) {
    const regs = (Array.isArray(entry?.regs) ? entry.regs : typeof entry?.reg === 'string' ? [entry.reg] : [])
      .map((reg) => ctx.canonical(reg)).filter(Boolean);
    const pieces = Array.isArray(entry?.pieces) ? entry.pieces
      : Array.isArray(entry?.parts) ? entry.parts : null;
    const aggregate = entry?.aggregate === true || regs.length > 1 || !!pieces
      || /aggregate|hfa|hva|eightbyte|wide-integer|integer-pair/.test(String(entry?.abiClass || '').toLowerCase());
    if (aggregate) {
      const canonicalPieces = normalizeArgumentPieces(entry, regs, pieces);
      if (!canonicalPieces) return [];
      entries.push({
        ...entry,
        regs,
        pieces:canonicalPieces,
        aggregate:true,
      });
      continue;
    }
    entries.push({
      ...entry,
      regs,
      pieces:pieces?.map((piece, index) => ({
        ...piece,
        index:Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
        piece:Number.isInteger(Number(piece?.piece)) ? Number(piece.piece) : Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
        reg:piece?.reg ? ctx.canonical(piece.reg) : null,
      })) ?? null,
      aggregate:false,
    });
  }
  return entries;
}

function explicitArgumentForRegister(entries, reg) {
  if (!entries) return null;
  return entries.find((entry) => entry.regs.includes(reg)) || null;
}

function canonicalStackEvidence(entries, disp) {
  if (!entries) return null;
  const target = BigInt(disp);
  for (const entry of entries) {
    if (!['stack', 'stack-fragment', 'register-stack', 'register-and-stack'].includes(entry.location)) continue;
    const pieces = entry.pieces || [];
    const stackPiece = pieces.find((piece) => piece.stackOffset != null && BigInt(piece.stackOffset) === target)
      || pieces.find((piece) => piece.stackOffset != null);
    const offsets = [entry.offset, entry.calleeEntryOffset, entry.stackOffset, stackPiece?.stackOffset].filter((offset) => offset != null).map((offset) => BigInt(offset));
    if (!offsets.some((offset) => offset === target)) continue;
    return {
      canonicalParameterIndex:entry.index ?? null,
      aggregate:entry.aggregate === true,
      abiClass:entry.abiClass ?? 'stack',
      pieces,
      pieceIndex:stackPiece?.index ?? stackPiece?.piece ?? null,
      stackBytes:stackPiece?.bytes ?? entry.bytes ?? null,
      canonicalEntry:entry,
      split:entry.location === 'register-stack' || entry.location === 'register-and-stack' || entry.location === 'stack-fragment',
    };
  }
  return null;
}

function registerArguments(ir, types, opts, ctx) {
  if (!ctx.supported) return [];
  const candidates = registerCandidates(ctx);
  const canonicalEntries = canonicalFunctionArgumentEntries(ctx, opts);
  const out = [];
  const seen = new Set();
  for (const [rawReg, value] of ir?.args?.entries?.() || []) {
    if (!value || !used(value)) continue;
    const reg = ctx.canonical(rawReg);
    let classified = null;
    try { classified = ctx.adapter.classifyEntryRegister?.(reg) || null; } catch { classified = null; }
    const explicit = explicitArgumentForRegister(canonicalEntries, reg);
    const candidate = explicit
      ? {
        reg, bankIndex:Number.isInteger(Number(explicit.index)) ? Number(explicit.index) : null,
        abiClass:explicit.abiClass ?? null,
        pointer:explicit.pointer === true,
        bits:explicit.bits ?? null,
        aggregate:explicit.aggregate === true,
        regs:explicit.regs,
        pieces:explicit.pieces,
        canonicalParameterIndex:explicit.index ?? null,
        canonicalLocation:explicit.location ?? null,
      }
      : canonicalEntries
        ? null
        : ctx.classifierState
        ? null
        : classified?.kind === 'argument'
        ? { reg, bankIndex:Number.isInteger(Number(classified.index)) ? Number(classified.index) : null, abiClass:classified.abiClass ?? null }
        : candidates.get(reg) || null;
    if (!candidate || seen.has(reg)) continue;
    seen.add(reg);
    const recovered = types?.values?.get?.(value.id) || null;
    const abiClass = String(candidate.abiClass || '').toLowerCase();
    const bank = /fp|float|sse|vector/.test(abiClass) ? 'fp' : 'integer';
    const fallbackIndex = candidate.bankIndex == null ? out.length : candidate.bankIndex;
    out.push({
      index:null, bankIndex:candidate.bankIndex, reg, abiClass:candidate.abiClass || bank,
      ...(candidate.canonicalParameterIndex != null ? { canonicalParameterIndex:candidate.canonicalParameterIndex } : {}),
      ...(candidate.canonicalLocation ? { canonicalLocation:candidate.canonicalLocation } : {}),
      ...(candidate.pointer != null ? { pointer:candidate.pointer } : {}),
      ...(candidate.bits != null ? { bits:candidate.bits } : {}),
      name:opts.argNames?.[reg] || opts.argNames?.[fallbackIndex] || `${bank === 'fp' ? 'fpArg' : 'arg'}${fallbackIndex + 1}`,
      type:tname(recovered), confidence:recovered?.confidence || 0.45,
      valueId:value.id ?? null, used:true, sourceOrderKnown:false,
      ...(!canonicalEntries ? {
        possible:true,
        mustUse:false,
        exact:false,
        certainty:'unknown',
      } : {}),
      evidence:`entry SSA use classified by ABI ${ctx.adapter.id}`,
      ...(candidate.aggregate ? {
        aggregate:true,
        pieces:(candidate.pieces || candidate.regs.map((pieceReg, index) => ({ index, piece:index, reg:pieceReg, bits:candidate.bits ?? null }))).map((piece, index) => ({
          ...piece,
          index:Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
          piece:Number.isInteger(Number(piece?.piece)) ? Number(piece.piece) : index,
          reg:piece?.reg ? ctx.canonical(piece.reg) : null,
        })),
      } : {}),
    });
  }
  if (!out.length) return out;

  if (canonicalEntries) {
    // The explicit function prototype is the canonical source of parameter
    // grouping.  In particular, do not apply a synthetic two-register probe
    // across adjacent scalar parameters when a split register/stack entry is
    // already classified by the selected profile.
    const byReg = new Map(out.map((argument) => [argument.reg, argument]));
    const merged = [];
    const claimed = new Set();
    for (const entry of canonicalEntries) {
      const regs = entry.regs.filter((reg) => byReg.has(reg));
      if (!regs.length || regs.some((reg) => claimed.has(reg))) continue;
      const first = byReg.get(regs[0]);
      const aggregate = entry.aggregate || regs.length > 1;
      if (aggregate) {
        merged.push({
          ...first,
          reg:regs[0], regs, aggregate:true,
          canonicalParameterIndex:entry.index ?? null,
          canonicalLocation:entry.location ?? null,
          abiClass:entry.abiClass || first.abiClass,
          pointer:entry.pointer === true,
          bits:entry.bits ?? first.bits ?? null,
          pieces:entry.pieces.map((piece, index) => ({
            ...piece,
            index:Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
            piece:Number.isInteger(Number(piece?.piece)) ? Number(piece.piece) : index,
            reg:piece?.reg ? ctx.canonical(piece.reg) : null,
          })),
          aggregateLayoutComplete:entry.partial !== true && entry.possible !== true && entry.mustUse !== false,
          sourceOrderKnown:true,
          evidence:`canonical ABI ${ctx.adapter.semanticIdentity} aggregate declaration`,
        });
      } else merged.push(first);
      for (const reg of regs) { claimed.add(reg); }
    }
    for (const argument of out) if (!claimed.has(argument.reg)) merged.push(argument);
    return merged.sort((left, right) => {
      const li = Number.isInteger(Number(left.bankIndex)) ? Number(left.bankIndex) : Number.MAX_SAFE_INTEGER;
      const ri = Number.isInteger(Number(right.bankIndex)) ? Number(right.bankIndex) : Number.MAX_SAFE_INTEGER;
      return li - ri;
    });
  }

  // Without a source-level prototype each live register is only an individual
  // ABI entry candidate.  Physical adjacency does not prove that two values
  // form one aggregate; grouping is owned exclusively by the canonical
  // classifier queried with the actual function prototype above.
  return out;
}

function stackLayout(ctx) {
  if (!ctx.supported || !ctx.stackPointers.size) return null;
  if (STACK_LAYOUT_CACHE.has(ctx.cacheKey)) return STACK_LAYOUT_CACHE.get(ctx.cacheKey);
  let rules = {};
  try { rules = ctx.adapter.stackRules?.() || ctx.plugin.stackRules?.() || {}; } catch { rules = {}; }
  if (rules.unknown === true) { STACK_LAYOUT_CACHE.set(ctx.cacheKey, null); return null; }
  const explicit = Number(rules.firstStackArgumentOffset);
  const derived = Number(rules.returnAddressBytes || 0) + Number(rules.shadowSpaceBytes || 0);
  const firstStackArgumentOffset = Number.isSafeInteger(explicit) && explicit >= 0 ? explicit
    : Number.isSafeInteger(derived) && derived >= 0 ? derived : 0;
  const layout = {
    firstStackArgumentOffset:BigInt(firstStackArgumentOffset),
    argumentSlotBytes:Number.isSafeInteger(Number(rules.argumentSlotBytes)) ? Number(rules.argumentSlotBytes) : null,
    returnAddressBytes:Number(rules.returnAddressBytes || 0),
    shadowSpaceBytes:Number(rules.shadowSpaceBytes || 0),
  };
  STACK_LAYOUT_CACHE.set(ctx.cacheKey, layout);
  return layout;
}

function entryValueForBase(ir, ctx, canonicalBase) {
  for (const [rawReg, value] of ir?.args?.entries?.() || []) {
    if (ctx.canonical(rawReg) === canonicalBase) return value;
  }
  return null;
}

function entryStackArguments(ir, types, ctx, opts = {}) {
  const layout = stackLayout(ctx);
  const canonicalEntries = canonicalFunctionArgumentEntries(ctx, opts);
  if (!layout) return [];
  const byKey = new Map();
  for (const inst of ir?.instructions || []) {
    if (inst?.op !== 'load' || inst.loc?.kind !== 'stack') continue;
    const baseReg = ctx.canonical(inst.loc?.baseReg);
    if (!ctx.stackPointers.has(baseReg)) continue;
    const entrySp = entryValueForBase(ir, ctx, baseReg);
    if (!entrySp || inst.loc.frameEpoch !== entrySp.id || inst.loc.disp == null) continue;
    const disp = BigInt(inst.loc.disp);
    if (disp < layout.firstStackArgumentOffset || inst.memUse?.kind !== 'entry') continue;
    const key = inst.loc.key || `${baseReg}:${disp}`;
    if (byKey.has(key)) continue;
    const recovered = inst.dst ? types?.values?.get?.(inst.dst.id) : null;
    const canonicalEvidence = canonicalStackEvidence(canonicalEntries, disp);
    byKey.set(key, {
      index:null, reg:null, abiClass:'stack', stackOffset:disp,
      abiStackOffset:disp - layout.firstStackArgumentOffset,
      stackBaseRegister:baseReg, stackCoordinate:'callee-entry-sp',
      name:`stackArg_${disp.toString(16)}`, type:tname(recovered),
      confidence:recovered?.confidence || 0.5, valueId:inst.dst?.id ?? null, used:true,
      sourceOrderKnown:false, evidence:'load from ABI-proven entry stack base Memory-SSA version with no reaching store',
      ...(canonicalEvidence ? {
        canonicalParameterIndex:canonicalEvidence.canonicalParameterIndex,
        aggregate:canonicalEvidence.aggregate,
        abiClass:canonicalEvidence.abiClass,
        pieceIndex:canonicalEvidence.pieceIndex,
        stackBytes:canonicalEvidence.stackBytes ?? canonicalEvidence.canonicalEntry?.bytes ?? null,
        pieces:canonicalEvidence.pieces,
        split:canonicalEvidence.split,
        canonicalLocation:canonicalEvidence.canonicalEntry?.location ?? null,
        evidence:`canonical ABI ${ctx.adapter.semanticIdentity} stack argument classification`,
      } : {}),
    });
  }
  return [...byKey.values()].sort((a,b) => a.stackOffset < b.stackOffset ? -1 : a.stackOffset > b.stackOffset ? 1 : 0);
}

function mergeCanonicalSplitArguments(registerArgs, stackArgs) {
  const merged = registerArgs.slice();
  const consumed = new Set();
  for (const stack of stackArgs) {
    if (!stack.aggregate || stack.canonicalParameterIndex == null) continue;
    const index = merged.findIndex((argument) => argument.aggregate
      && argument.canonicalParameterIndex === stack.canonicalParameterIndex);
    if (index < 0) continue;
    const register = merged[index];
    const pieces = Array.isArray(register.pieces) ? register.pieces.slice() : [];
    for (const piece of stack.pieces || []) {
      if (piece?.stackOffset == null && piece?.reg) continue;
      if (!pieces.some((existing) => Number(existing?.index) === Number(piece?.index))) pieces.push(piece);
    }
    merged[index] = {
      ...register,
      location:'register-stack',
      stackOffset:stack.stackOffset,
      stackBytes:stack.stackBytes ?? null,
      split:true,
      pieces,
      evidence:`${register.evidence}; canonical ABI split register/stack aggregate`,
    };
    consumed.add(stack);
  }
  return { registerArgs:merged, stackArgs:stackArgs.filter((stack) => !consumed.has(stack)) };
}

function returnPrototype(ret, opts = {}) {
  const returnType = tname(ret, opts.returnType || '');
  const returnClass = kindOf(ret) || String(opts.returnClass || '').toLowerCase();
  const returnBits = bitsOf(ret) || Number(opts.returnBits || 0);
  const prototype = {
    returnType, returnClass, returnBits,
    aggregate:ret?.aggregate === true || /aggregate|struct|union|record|array|composite/.test(`${returnType} ${returnClass}`.toLowerCase()),
    hfaCount:Number(ret?.hfaCount || ret?.hvaCount || opts.hfaCount || 0),
    returnsValue:returnType !== 'void' && returnClass !== 'void',
  };
  // Keep the canonical type facts needed by profile classifiers.  The old
  // projection retained only a boolean aggregate bit and silently discarded
  // eightbyte classes, HFA/HVA members, padding, and indirect-result hints.
  for (const field of [
    'eightbyteClasses', 'abiClasses', 'returnEightbyteClasses', 'members',
    'elements', 'count', 'elementBits', 'memberBits', 'hfa', 'hva', 'vector',
    'alignment', 'alignmentBytes', 'align', 'size', 'sizeBits', 'bits',
    'returnAggregate', 'returnVector', 'vectorReturn', 'trivialForCalls',
    'returnTrivialForCalls', 'nonTrivialForCalls', 'returnNonTrivialForCalls',
    'pod', 'indirectResult', 'callingConvention', 'convention',
  ]) {
    if (ret?.[field] != null) prototype[field] = ret[field];
    else if (opts?.[field] != null) prototype[field] = opts[field];
  }
  return prototype;
}

function classifyReturn(ctx, ret, opts = {}) {
  if (!ctx.supported) return null;
  const functionPrototype = returnPrototype(ret, opts);
  if (!ret && !opts.returnType && !opts.returnClass && !opts.returnBits) return null;
  try {
    const classified = ctx.adapter.classifyFunctionReturn({
      functionPrototype, prototype:functionPrototype,
      returnType:functionPrototype.returnType,
      returnClass:functionPrototype.returnClass,
      returnBits:functionPrototype.returnBits,
      returnsValue:functionPrototype.returnsValue,
    }) || null;
    const state = abiResultInvalidState(classified);
    if (!classified || state || classified.unsupported === true) {
      ctx.classifierState ||= state || (classified?.unsupported === true ? 'unsupported' : 'unknown');
      return null;
    }
    return classified;
  } catch { ctx.classifierState ||= 'failed'; return null; }
}

function hiddenResultRegisterFrom(classified, ctx) {
  const hidden = classified?.hiddenResultPointer;
  const raw = typeof hidden === 'object' ? hidden.input : null;
  if (abiResultInvalidState(classified) || classified?.indirect !== true || classified?.resultLocation !== 'memory'
    || !raw || typeof raw !== 'string'
    || !canonicalAbiHiddenResult(classified, hidden)) return null;
  return ctx.canonical(raw);
}

function indirectResultCandidate(ctx) {
  if (!ctx.supported) return null;
  const probes = [
    { returnType:'struct aggregate', returnClass:'aggregate', returnBits:256, aggregate:true, returnsValue:true },
    { returnType:'struct aggregate', returnClass:'indirect', returnBits:256, aggregate:true, indirectResult:true, returnsValue:true },
  ];
  for (const functionPrototype of probes) {
    let classified = null;
    try { classified = ctx.adapter.classifyFunctionReturn({ functionPrototype, prototype:functionPrototype, ...functionPrototype }) || null; } catch { classified = null; }
    const reg = hiddenResultRegisterFrom(classified, ctx);
    if (reg) return classified;
  }
  return null;
}

function normalizeReturnLocationList(canonical, classified, ctx) {
  if (!Array.isArray(canonical) || !canonical.length || !canonicalAbiEvidence(classified)) return [];
  if (canonical.length === 1 && canonical[0]?.kind === 'indirect') {
    const hidden = hiddenResultRegisterFrom(classified, ctx);
    if (!hidden || String(canonical[0]?.reg || '') !== hidden) return [];
    return [{
      kind:'indirect', reg:hidden, role:'result-address',
    }];
  }
  const aggregate = classified.aggregate === true || canonical.length > 1
    || canonical.some((location) => location?.aggregate === true);
  if (!aggregate) {
    if (canonical.length !== 1 || canonical[0]?.kind !== 'register'
      || canonical[0]?.aggregate === true || typeof canonical[0]?.reg !== 'string'
      || !Number.isSafeInteger(Number(canonical[0]?.bits)) || Number(canonical[0].bits) <= 0) return [];
    const scalarBits = Number(canonical[0].bits);
    const scalarBytes = canonical[0].bytes == null
      ? Math.ceil(scalarBits / 8) : Number(canonical[0].bytes);
    if (!Number.isSafeInteger(scalarBytes) || scalarBytes <= 0) return [];
    return [{
      ...canonical[0],
      reg:ctx.canonical(canonical[0].reg),
      bits:scalarBits,
      bytes:scalarBytes,
      pieceIndex:null,
      order:0,
      aggregate:false,
      abiSemanticIdentity:ctx.identity.semanticIdentity,
    }];
  }
  const pieces = canonical.map((location, index) => {
    if (!location || !['register','stack'].includes(location.kind)) return null;
    return {
      ...(location.kind === 'register' ? { reg:location.reg } : { stackOffset:location.stackOffset }),
      abiClass:location.abiClass ?? classified.abiClass,
      pieceIndex:location.pieceIndex ?? index,
      order:location.order ?? index,
      bits:location.bits,
      bytes:location.bytes,
      byteOffset:location.byteOffset,
    };
  });
  const normalizedPieces = normalizeAbiPieces({
    ...classified,
    abiClass:classified.abiClass ?? 'aggregate-piece',
  }, pieces, { defaultAbiClass:'aggregate-piece' });
  if (!normalizedPieces) return [];
  return normalizedPieces.map((piece) => ({
    kind:piece.reg ? 'register' : 'stack',
    ...(piece.reg ? { reg:ctx.canonical(piece.reg) } : { stackOffset:piece.stackOffset }),
    abiClass:piece.abiClass,
    pieceIndex:piece.pieceIndex,
    bits:piece.bits,
    bytes:piece.bytes,
    byteOffset:piece.byteOffset,
    order:piece.order,
    aggregate:true,
    abiSemanticIdentity:ctx.identity.semanticIdentity,
  }));
}

function returnLocations(classified, indirectRegister, ctx) {
  const classifierState = abiResultInvalidState(classified);
  // A placement list is an all-or-nothing canonical fact.  Do not retain a
  // hidden-result sentinel or surviving lanes when the classifier says the
  // result is partial, stale, unsupported, or otherwise not proven.
  if (classifierState || classified?.partial === true || classified?.unsupported === true) return [];
  // Keep the established hidden-result projection shape stable.  Identity and
  // provenance travel on the enclosing prototype; consumers must not infer a
  // second ABI fact from extra fields on this sentinel location.
  if (indirectRegister) {
    const proof = hiddenResultRegisterFrom(classified, ctx);
    if (!proof || proof !== indirectRegister) return [];
    return [{
      // This is a legacy presentation sentinel.  The enclosing prototype
      // carries the complete canonical hidden-sret proof and identity.
      kind:'indirect', reg:indirectRegister, role:'result-address',
    }];
  }
  if (!classified) return [];
  // A malformed hidden-result record must not fall through to a convenience
  // `reg`/`regs` field and reappear as a direct aggregate return.
  if (classified.indirect === true) return [];
  // The adapter owns the canonical return-piece interpretation.  The
  // decompiler only attaches consumer-facing identity and register aliases;
  // it must not collapse a multi-register result to the legacy scalar field.
  if (typeof ctx.adapter?.returnLocations === 'function') {
    try {
      const canonical = ctx.adapter.returnLocations({ classified });
      if (Array.isArray(canonical)) {
        return normalizeReturnLocationList(canonical, classified, ctx);
      }
    } catch { /* fall through to the strict shape-preserving projection */ }
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
    return normalizedPieces.map((piece) => ({
      kind:piece.reg ? 'register' : 'stack',
      ...(piece.reg ? { reg:ctx.canonical(piece.reg) } : { stackOffset:piece.stackOffset }),
      abiClass:piece.abiClass,
      pieceIndex:piece.pieceIndex,
      bits:piece.bits,
      bytes:piece.bytes,
      byteOffset:piece.byteOffset,
      order:piece.order,
      aggregate:classified.aggregate === true || pieces.length > 1,
      abiSemanticIdentity:ctx.identity?.semanticIdentity ?? null,
    }));
  }
  const regs = Array.isArray(classified.regs) && classified.regs.length
    ? classified.regs
    : classified.reg ? [classified.reg] : [];
  const aggregate = classified.aggregate === true || regs.length > 1;
  if (aggregate) {
    const pieces = Array.isArray(classified.pieces) && classified.pieces.length
      ? classified.pieces
      : Array.isArray(classified.parts) && classified.parts.length ? classified.parts : null;
    if (!pieces) return [];
    const normalizedPieces = normalizeAbiPieces(classified, pieces, { defaultAbiClass:'aggregate-piece' });
    if (!normalizedPieces) return [];
    return normalizedPieces.map((piece) => ({
      kind:'register', reg:ctx.canonical(piece.reg), abiClass:piece.abiClass,
      pieceIndex:piece.pieceIndex, bits:piece.bits, bytes:piece.bytes,
      byteOffset:piece.byteOffset, order:piece.order, aggregate:true,
      abiSemanticIdentity:ctx.identity?.semanticIdentity ?? null,
    }));
  }
  if (regs.length !== 1 || typeof regs[0] !== 'string' || !regs[0].length) return [];
  const bits = Number(classified.bits);
  if (!Number.isSafeInteger(bits) || bits <= 0) return [];
  return [{
    kind:'register', reg:ctx.canonical(regs[0]), abiClass:classified.abiClass ?? null,
    pieceIndex:null, bits, bytes:Math.ceil(bits / 8), byteOffset:0, order:0,
    aggregate:false, abiSemanticIdentity:ctx.identity?.semanticIdentity ?? null,
  }];
}

export function recoverFunctionPrototype(ir, types, opts = {}) {
  const ctx = abiContext(opts);
  const recoveredRegisterArgs = registerArguments(ir, types, opts, ctx);
  const recoveredStackArgs = entryStackArguments(ir, types, ctx, opts);
  const split = mergeCanonicalSplitArguments(recoveredRegisterArgs, recoveredStackArgs);
  const registerArgs = split.registerArgs;
  const physicalArgs = physicalArgumentBanks(registerArgs, ir);
  const integerArgs = physicalArgs.filter((arg) => !isFpAbiClass(arg.abiClass));
  const fpArgs = physicalArgs.filter((arg) => isFpAbiClass(arg.abiClass));
  const stackArgs = split.stackArgs;
  const args = [...registerArgs, ...stackArgs];
  const ret = types?.ret || null;
  let classifiedReturn = classifyReturn(ctx, ret, opts);
  let indirectRegister = classifiedReturn?.indirect === true ? hiddenResultRegisterFrom(classifiedReturn, ctx) : null;
  if (!indirectRegister && opts.indirectResult === true) {
    // An explicit indirect-result fact permits one canonical classifier query;
    // an untyped entry register alone never invents a hidden sret placement.
    const candidate = indirectResultCandidate(ctx);
    const candidateRegister = hiddenResultRegisterFrom(candidate, ctx);
    if (candidateRegister) {
      const entry = entryValueForBase(ir, ctx, candidateRegister);
      const recovered = entry ? types?.values?.get?.(entry.id) : null;
      if (entry && used(entry) && (recovered?.kind === 'pointer' || opts.indirectResult === true)) {
        classifiedReturn = candidate;
        indirectRegister = candidateRegister;
      }
    }
  }
  const locations = returnLocations(classifiedReturn, indirectRegister, ctx);
  const retType = tname(ret, opts.returnType || 'unknown');
  const conventionKnown = ctx.supported && !ctx.classifierState;
  const status = conventionKnown ? 'partial' : ctx.classifierState || ctx.status || 'unknown';
  const identity = conventionKnown && ctx.identity ? {
    ...ctx.identity,
    status:ctx.status,
    provenance:'canonical-abi-registry',
  } : null;
  const sourcePrototype = opts.functionPrototype || opts.prototype || null;
  const variadic = opts.variadic === true || opts.varargs === true
    || sourcePrototype?.variadic === true || sourcePrototype?.varargs === true;
  const anonymousArgumentFrontier = variadic && ctx.supported ? {
    location:'unknown', possible:true, mustUse:false,
    reason:'anonymous-vararg-frontier-not-source-prototyped',
  } : null;
  return {
    convention:conventionKnown ? String(ctx.adapter.id || ctx.plugin.id) : 'unknown',
    conventionKnown,
    arguments:args,
    argumentBanks:{ integer:integerArgs, fp:fpArgs, stack:stackArgs },
    returnType:retType, returnConfidence:ret?.confidence || (locations.length ? 0.35 : 0),
    returnLocations:locations,
    returnLocationKnown:conventionKnown && locations.length > 0,
    indirectResult:indirectRegister != null,
    indirectResultRegister:indirectRegister,
    variadic,
    anonymousArgumentFrontier,
    completeness:status,
    abiSemanticIdentity:conventionKnown ? ctx.identity?.semanticIdentity ?? null : null,
    abiSemanticVersion:conventionKnown ? ctx.identity?.semanticVersion ?? null : null,
    abiArchitectureId:conventionKnown ? ctx.identity?.architectureId ?? null : null,
    abiIdentity:identity,
    provenance:conventionKnown ? 'canonical-abi-registry' : null,
    evidence:[
      ...(registerArgs.length ? [`entry SSA register uses classified by ABI ${ctx.adapter.id}`] : []),
      ...(stackArgs.length ? [`entry stack loads classified by ABI ${ctx.adapter.id} stack rules`] : []),
      ...(indirectRegister ? [`ABI ${ctx.adapter.id} indirect-result register evidence`] : []),
      ...(ret ? ['semantic return-type evidence classified by ABI plugin'] : []),
      ...(anonymousArgumentFrontier ? ['anonymous variadic frontier remains unknown'] : []),
      ...(!ctx.supported ? [`ABI evidence rejected: ${ctx.reason || ctx.status || 'unknown'}`] : []),
    ],
  };
}
