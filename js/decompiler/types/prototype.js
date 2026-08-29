import { architecturePluginV2 } from '../../targets/architecture/index.js';
import { abiPlugin as registeredABIPlugin } from '../../targets/abi/index.js';

const ARCH_META_CACHE = new Map();
const REGISTER_CANDIDATE_CACHE = new Map();
const AGGREGATE_CANDIDATE_CACHE = new Map();
const STACK_LAYOUT_CACHE = new Map();

const INVALID_ABI_STATES = new Set([
  'stale', 'malformed', 'conflict', 'cancelled', 'canceled', 'deadline',
  'deadline-exceeded', 'truncated', 'budget', 'budget-exhausted',
  'resource-exhausted', 'unsupported', 'invalid', 'failed', 'error',
  'indirect-call', 'ambiguous', 'unknown', 'incomplete', 'not-proven',
]);

function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function normalized(value) { return String(value ?? '').trim().toLowerCase(); }
function invalidState(value) {
  const state = normalized(value).replace(/_/g, '-');
  return INVALID_ABI_STATES.has(state) ? state : null;
}
function compatibleArchitecture(target, canonical) {
  const actual = normalized(target);
  const expected = normalized(canonical);
  if (!actual || !expected) return true;
  return actual === expected || (actual === 'arm64e' && expected === 'arm64');
}

function requestedInvalidationState(adapter, opts = {}) {
  if (opts.cancelled === true || opts.canceled === true || opts.signal?.aborted === true) return 'cancelled';
  if (opts.deadlineExceeded === true || opts.deadlineExpired === true) return 'deadline-exceeded';
  if (opts.truncated === true || opts.truncatedRun === true) return 'truncated';
  if (opts.budgetExhausted === true || opts.resourceBudgetExhausted === true) return 'budget-exhausted';
  if (opts.callerCalleeConflict === true || opts.callerCalleeAgreement === false) return 'conflict';
  if (opts.thunkAmbiguous === true || opts.tailCallAmbiguous === true) return 'ambiguous';
  if (opts.indirectCall === true && opts.functionPrototype == null && opts.prototype == null) return 'indirect-call';
  if (opts.malformedEvidence === true || opts.classifierFailed === true) return 'malformed';
  for (const value of [
    opts.status, opts.analysisStatus, opts.completeness, opts.evidenceStatus,
    adapter?.status, adapter?.analysisStatus, adapter?.completeness,
    adapter?.invalidation?.status, adapter?.invalidation?.state,
  ]) {
    const state = invalidState(value);
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
  const targetArchitecture = adapter.targetArchitecture || opts.architectureId || opts.architecture || null;
  if (!compatibleArchitecture(targetArchitecture, plugin.architectureId)) {
    return { supported:false, status:'profile-mismatch', reason:'abi-target-architecture-mismatch' };
  }
  const platform = adapter.platformId || adapter.platform || opts.platformId || opts.platform || null;
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
  if (record(profile)) {
    const profileArchitecture = profile.architectureId || profile.architecture || profile.arch;
    if (profileArchitecture && !compatibleArchitecture(profileArchitecture, plugin.architectureId)) {
      return { supported:false, status:'profile-mismatch', reason:'abi-profile-architecture-mismatch' };
    }
    const profileIdentity = profile.semanticIdentity || profile.abiSemanticIdentity;
    if (profileIdentity && String(profileIdentity) !== String(plugin.semanticIdentity)) {
      return { supported:false, status:'stale', reason:'abi-profile-semantic-identity-mismatch' };
    }
  }
  if (adapter.identity != null) {
    if (!record(adapter.identity)) return { supported:false, status:'malformed', reason:'abi-identity-record-malformed' };
    for (const field of required) {
      if (adapter.identity[field] == null || String(adapter.identity[field]) !== String(adapter[field])) {
        return { supported:false, status:'stale', reason:`abi-nested-${field}-mismatch` };
      }
    }
  }
  if (adapter.provenance.source !== 'canonical-abi-registry'
    || String(adapter.provenance.abiId ?? '') !== String(plugin.id)
    || String(adapter.provenance.semanticVersion ?? '') !== String(plugin.semanticVersion)
    || String(adapter.provenance.semanticIdentity ?? '') !== String(plugin.semanticIdentity)
    || String(adapter.provenance.architectureId ?? '') !== String(plugin.architectureId)) {
    return { supported:false, status:'stale', reason:'abi-provenance-mismatch' };
  }
  if (String(adapter.invalidation.abiSemanticIdentity ?? '') !== String(plugin.semanticIdentity)
    || String(adapter.invalidation.abiSemanticVersion ?? '') !== String(plugin.semanticVersion)
    || String(adapter.invalidation.architectureId ?? '') !== String(plugin.architectureId)) {
    return { supported:false, status:'stale', reason:'abi-invalidation-mismatch' };
  }
  for (const field of ['binaryId', 'sliceId', 'functionId']) {
    const expected = opts?.[field];
    const observed = adapter.invalidation?.[field];
    if (expected != null && observed != null && String(expected) !== String(observed)) {
      return { supported:false, status:'stale', reason:`abi-${field}-identity-mismatch` };
    }
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
      architectureProfile:adapter?.architectureProfile ?? null,
      invalidation:adapter?.invalidation ?? null,
    } : null,
  };
}

function classifyArguments(ctx, functionPrototype) {
  if (!ctx?.supported || !ctx.adapter?.classifyArguments) return null;
  try { return ctx.adapter.classifyArguments({ functionPrototype }) || null; }
  catch { return null; }
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

// These are deliberately only canonical ABI classifier queries.  The
// consumer needs a shape-independent way to recognise a multi-register
// parameter when entry SSA does not retain the source declaration, but it
// must not grow a second placement engine of its own.  Each probe asks the
// selected profile for a known aggregate/HFA/HVA shape and retains only an
// exact, must-use result.
function canonicalAggregateCandidates(ctx) {
  if (!ctx.supported) return [];
  const cached = AGGREGATE_CANDIDATE_CACHE.get(ctx.cacheKey);
  if (cached) return cached;
  const probes = [
    { type:'struct Pair', aggregate:true, bits:128, eightbyteClasses:['INTEGER','INTEGER'] },
    { type:'struct FPair', aggregate:true, bits:128, eightbyteClasses:['SSE','SSE'] },
    { type:'struct HFA', aggregate:true, hfa:true, members:4, elementBits:32, bits:128 },
    { type:'struct HVA', aggregate:true, hva:true, members:4, elementBits:64, bits:256 },
    { type:'struct Aggregate', aggregate:true, bits:128 },
  ];
  const byKey = new Map();
  for (const parameter of probes) {
    const classified = classifyArguments(ctx, { parameters:[parameter] });
    for (const entry of classified?.arguments || []) {
      if (!entry || entry.possible === true || entry.mustUse === false) continue;
      const regs = (Array.isArray(entry.regs) ? entry.regs : typeof entry.reg === 'string' ? [entry.reg] : [])
        .map((reg) => ctx.canonical(reg)).filter(Boolean);
      if (!regs.length) continue;
      const abiClass = String(entry.abiClass || '').toLowerCase();
      const aggregate = entry.aggregate === true || Array.isArray(entry.pieces) || Array.isArray(entry.parts)
        || regs.length > 1 || /aggregate|hfa|hva|eightbyte|wide-integer|integer-pair/.test(abiClass);
      if (!aggregate) continue;
      const pieces = Array.isArray(entry.pieces) ? entry.pieces
        : Array.isArray(entry.parts) ? entry.parts
          : regs.map((reg, index) => ({ piece:index, index, reg, bits:entry.bits ?? null }));
      const normalizedPieces = pieces.map((piece, index) => ({
        ...piece,
        piece:Number.isInteger(Number(piece?.piece)) ? Number(piece.piece) : Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
        index:Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
        reg:piece?.reg ? ctx.canonical(piece.reg) : null,
      }));
      const key = regs.join(',');
      const candidate = {
        regs:[...new Set(regs)],
        reg:regs[0],
        location:entry.location || 'register',
        abiClass:entry.abiClass || 'aggregate',
        pointer:entry.pointer === true,
        bits:Number.isFinite(Number(entry.bits)) ? Number(entry.bits) : null,
        pointeeBits:Number.isFinite(Number(entry.pointeeBits)) ? Number(entry.pointeeBits) : null,
        alignment:Number.isFinite(Number(entry.alignment)) ? Number(entry.alignment) : null,
        pieces:normalizedPieces,
        source:'canonical-abi-classifier',
        evidence:classified.evidence || null,
      };
      const prior = byKey.get(key);
      // Prefer the profile's explicitly aggregate class over a generic wide
      // integer label when two probes describe the same physical lanes.
      if (!prior || (/aggregate|hfa|hva/.test(String(candidate.abiClass).toLowerCase())
        && !/aggregate|hfa|hva/.test(String(prior.abiClass).toLowerCase()))) byKey.set(key, candidate);
    }
  }
  const result = Object.freeze([...byKey.values()].sort((left, right) => right.regs.length - left.regs.length));
  AGGREGATE_CANDIDATE_CACHE.set(ctx.cacheKey, result);
  return result;
}

function isFpAbiClass(value) {
  return /fp|float|sse|vector|hfa|hva|simd/.test(String(value || '').toLowerCase());
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
  if (!classified || !Array.isArray(classified.arguments)) return null;
  return classified.arguments.filter((entry) => entry && entry.possible !== true && entry.mustUse !== false).map((entry) => {
    const regs = (Array.isArray(entry?.regs) ? entry.regs : typeof entry?.reg === 'string' ? [entry.reg] : [])
      .map((reg) => ctx.canonical(reg)).filter(Boolean);
    const pieces = Array.isArray(entry?.pieces) ? entry.pieces
      : Array.isArray(entry?.parts) ? entry.parts
        : entry?.stackOffset != null ? [
          ...regs.map((reg, index) => ({
            index, piece:index, reg,
            bits:entry.bits == null ? null : Math.max(1, Number(entry.bits) - Number(entry.stackBytes ?? 8) * 8),
          })),
          { index:regs.length, piece:regs.length, reg:null, stackOffset:entry.stackOffset, bytes:entry.stackBytes ?? 8 },
        ] : null;
    return {
      ...entry,
      regs,
      pieces:pieces?.map((piece, index) => ({
        ...piece,
        index:Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
        piece:Number.isInteger(Number(piece?.piece)) ? Number(piece.piece) : Number.isInteger(Number(piece?.index)) ? Number(piece.index) : index,
        reg:piece?.reg ? ctx.canonical(piece.reg) : null,
      })) ?? null,
      aggregate:entry?.aggregate === true || regs.length > 1 || !!pieces
        || /aggregate|hfa|hva|eightbyte|wide-integer|integer-pair/.test(String(entry?.abiClass || '').toLowerCase()),
    };
  });
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
  const aggregateCandidates = canonicalEntries ? [] : canonicalAggregateCandidates(ctx);
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
          pieces:(entry.pieces || regs.map((reg, index) => ({ index, piece:index, reg, bits:entry.bits ?? null }))).map((piece, index) => ({
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

  const byReg = new Map(out.map((argument) => [argument.reg, argument]));
  const selected = [];
  const claimed = new Set();
  for (const candidate of aggregateCandidates) {
    if (!candidate.regs.every((reg) => byReg.has(reg))) continue;
    if (candidate.regs.some((reg) => claimed.has(reg))) continue;
    const members = candidate.regs.map((reg) => byReg.get(reg));
    const first = members[0];
      const aggregate = {
      ...first,
      reg:candidate.regs[0],
      regs:candidate.regs.slice(),
      aggregate:true,
      pointer:candidate.pointer,
      abiClass:candidate.abiClass || first.abiClass,
      bits:candidate.bits ?? first.bits ?? null,
      ...(candidate.pointeeBits != null ? { pointeeBits:candidate.pointeeBits } : {}),
      ...(candidate.alignment != null ? { alignment:candidate.alignment } : {}),
      pieces:candidate.pieces.map((piece, index) => ({
        ...piece,
        piece:index,
        index:Number.isInteger(Number(piece.index)) ? Number(piece.index) : index,
        reg:piece.reg || candidate.regs[index] || null,
        valueId:byReg.get(piece.reg || candidate.regs[index])?.valueId ?? null,
      })),
      valueIds:members.map((member) => member.valueId ?? null),
      pieceValueIds:members.map((member) => member.valueId ?? null),
      aggregateEvidence:'canonical-abi-classifier-probe-without-source-prototype',
      aggregateLayoutComplete:false,
      partial:true,
      evidence:`canonical ABI ${ctx.adapter.semanticIdentity} aggregate classification`,
      sourceOrderKnown:false,
    };
    selected.push({ firstIndex:out.indexOf(first), argument:aggregate });
    for (const reg of candidate.regs) claimed.add(reg);
  }
  const merged = [];
  const byFirst = new Map(selected.map((entry) => [entry.firstIndex, entry.argument]));
  for (let index = 0; index < out.length; index++) {
    const grouped = byFirst.get(index);
    if (grouped) {
      merged.push(grouped);
      continue;
    }
    if (claimed.has(out[index].reg)) continue;
    merged.push(out[index]);
  }
  return merged;
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
    return ctx.adapter.classifyFunctionReturn({
      functionPrototype, prototype:functionPrototype,
      returnType:functionPrototype.returnType,
      returnClass:functionPrototype.returnClass,
      returnBits:functionPrototype.returnBits,
      returnsValue:functionPrototype.returnsValue,
    }) || null;
  } catch { return null; }
}

function hiddenResultRegisterFrom(classified, ctx) {
  const hidden = classified?.hiddenResultPointer;
  const raw = typeof hidden === 'string' ? hidden : hidden?.input;
  return raw ? ctx.canonical(raw) : null;
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
    if (reg) return reg;
  }
  return null;
}

function returnLocations(classified, indirectRegister, ctx) {
  // Keep the established hidden-result projection shape stable.  Identity and
  // provenance travel on the enclosing prototype; consumers must not infer a
  // second ABI fact from extra fields on this sentinel location.
  if (indirectRegister) return [{ kind:'indirect', reg:indirectRegister, role:'result-address' }];
  if (!classified) return [];
  if (classified.partial === true || classified.unsupported === true) return [];
  const pieces = Array.isArray(classified.pieces) && classified.pieces.length
    ? classified.pieces
    : Array.isArray(classified.parts) && classified.parts.length
      ? classified.parts
      : null;
  if (pieces) {
    return pieces.map((piece, index) => {
      const reg = piece?.reg ? ctx.canonical(piece.reg) : null;
      if (!reg) return null;
      return {
        kind:'register', reg,
        abiClass:piece.abiClass ?? classified.abiClass ?? (classified.aggregate === true ? 'aggregate-piece' : null),
        pieceIndex:Number.isInteger(Number(piece.index)) ? Number(piece.index) : index,
        bits:piece.bits ?? null,
        byteOffset:piece.byteOffset ?? null,
        stackOffset:piece.stackOffset ?? null,
        order:index,
        aggregate:classified.aggregate === true || pieces.length > 1,
        abiSemanticIdentity:ctx.identity?.semanticIdentity ?? null,
      };
    }).filter(Boolean);
  }
  const regs = Array.isArray(classified.regs) && classified.regs.length
    ? classified.regs
    : classified.reg ? [classified.reg] : [];
  return regs.map((rawReg, index) => {
    const reg = ctx.canonical(rawReg);
    return {
      kind:'register', reg, abiClass:classified.abiClass ?? (classified.aggregate === true ? 'aggregate-piece' : null),
      pieceIndex:regs.length > 1 ? index : null,
      bits:classified.bits ?? null,
      order:index,
      aggregate:classified.aggregate === true || regs.length > 1,
      abiSemanticIdentity:ctx.identity?.semanticIdentity ?? null,
    };
  }).filter((location) => location.reg);
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
  const classifiedReturn = classifyReturn(ctx, ret, opts);
  let indirectRegister = classifiedReturn?.indirect === true ? hiddenResultRegisterFrom(classifiedReturn, ctx) : null;
  if (!indirectRegister) {
    const candidate = indirectResultCandidate(ctx);
    if (candidate) {
      const entry = entryValueForBase(ir, ctx, candidate);
      const recovered = entry ? types?.values?.get?.(entry.id) : null;
      if (entry && used(entry) && (recovered?.kind === 'pointer' || opts.indirectResult === true)) indirectRegister = candidate;
    }
  }
  const locations = returnLocations(classifiedReturn, indirectRegister, ctx);
  const retType = tname(ret, opts.returnType || 'unknown');
  const status = ctx.supported ? 'partial' : ctx.status || 'unknown';
  const identity = ctx.identity ? {
    ...ctx.identity,
    status:ctx.status,
    provenance:'canonical-abi-registry',
  } : null;
  const anonymousArgumentFrontier = opts.variadic === true && ctx.supported ? {
    location:'unknown', possible:true, mustUse:false,
    reason:'anonymous-vararg-frontier-not-source-prototyped',
  } : null;
  return {
    convention:ctx.supported ? String(ctx.adapter.id || ctx.plugin.id) : 'unknown',
    conventionKnown:ctx.supported,
    arguments:args,
    argumentBanks:{ integer:integerArgs, fp:fpArgs, stack:stackArgs },
    returnType:retType, returnConfidence:ret?.confidence || (locations.length ? 0.35 : 0),
    returnLocations:locations,
    returnLocationKnown:ctx.supported && locations.length > 0,
    indirectResult:indirectRegister != null,
    indirectResultRegister:indirectRegister,
    variadic:opts.variadic === true,
    anonymousArgumentFrontier,
    completeness:status,
    abiSemanticIdentity:ctx.identity?.semanticIdentity ?? null,
    abiSemanticVersion:ctx.identity?.semanticVersion ?? null,
    abiArchitectureId:ctx.identity?.architectureId ?? null,
    abiIdentity:identity,
    provenance:ctx.supported ? 'canonical-abi-registry' : null,
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
