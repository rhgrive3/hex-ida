import { addressText } from '../validation.js';

let turnSequence = 1;

export function canonicalBindingId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

export function firstBinding(...values) {
  for (const value of values) {
    const id = canonicalBindingId(value);
    if (id != null) return id;
  }
  return null;
}

function canonicalSlice(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  try { return BigInt(text).toString(); }
  catch { return null; }
}

function selectedSlice(local) {
  const raw = first(local.sliceIndex, local.slice, local.binary?.sliceIndex);
  if (raw == null) return { value:null, invalid:false };
  const value = canonicalSlice(raw);
  return { value, invalid:value == null };
}

export function createTurnSnapshot(local = {}, request = {}) {
  const cursor = first(local.currentAddress, local.activeFunction?.address, local.currentFunction?.address);
  const range = resolveFunctionRange(local, cursor);
  // The cursor identifies the instruction the user is looking at; it is not
  // necessarily the identity of the containing function. Prefer an explicit
  // function identity, then an exact range boundary, and only use the cursor
  // as the final fallback for contexts that have no function metadata.
  const functionAddress = first(
    local.activeFunction?.address,
    local.currentFunction?.address,
    range?.start,
    cursor,
  );
  const selection = snapshotSelection(local.selection);
  const identity = resolveBinaryIdentity(local, request);
  const projectId = firstBinding(request.projectId, local.projectId, local.project?.id, local.project?.binaryHash);
  const runtimeId = firstBinding(local.runtimeSession?.id, local.runtime?.sessionId, local.runtimeSessionId);
  const runtimeKnown = local.runtimeSessionKnown === true || runtimeId != null;
  const requestedScope = String(request.scope || 'auto');
  return deepFreeze({
    id: `turn_${Date.now().toString(36)}_${turnSequence++}`,
    createdAt: new Date().toISOString(),
    binaryIdentity: identity,
    binaryId: identity.id,
    legacyBinaryId: identity.legacyId,
    projectIdentity: projectId,
    architecture: copyScalar(first(local.architecture, local.binary?.architecture, local.capability?.architecture)),
    slice: copyScalar(first(local.slice, local.sliceIndex, local.binary?.sliceIndex)),
    currentAddress: cursor == null ? null : addressText(cursor),
    currentFunction: functionAddress == null ? null : {
      address: addressText(functionAddress),
      range,
      name: first(local.activeFunction?.name, local.currentFunction?.name, safeName(local, functionAddress)),
    },
    selection,
    runtimeSessionIdentity: runtimeId,
    runtimeSessionState: runtimeKnown ? (runtimeId == null ? 'none' : 'bound') : 'unknown',
    requestedScope,
    capabilities: snapshotCapabilities(local),
    neighborhood: snapshotNeighborhood(local, cursor),
  });
}

export function createSnapshotContext(local = {}, snapshot, scopeController = null) {
  const frozen = {};
  for (const key of Reflect.ownKeys(local)) {
    try {
      Object.defineProperty(frozen, key, {
        value:local[key], enumerable:true, configurable:true, writable:true,
      });
    } catch { /* best-effort capability capture */ }
  }
  frozen.turnSnapshot = snapshot;
  frozen.binaryIdentity = snapshot.binaryIdentity;
  frozen.binaryId = snapshot.binaryId;
  frozen.projectId = snapshot.projectIdentity;
  frozen.currentAddress = parseAddress(snapshot.currentAddress ?? snapshot.currentFunction?.address);
  frozen.activeFunction = snapshot.currentFunction ? {
    address: parseAddress(snapshot.currentFunction.address),
    name: snapshot.currentFunction.name,
    start: parseAddress(snapshot.currentFunction.range?.start),
    end: parseAddress(snapshot.currentFunction.range?.end),
  } : null;
  frozen.currentFunction = frozen.activeFunction;
  frozen.selection = snapshot.selection;
  if (scopeController) {
    frozen.scopeAllowsTool = (scope, tool, args) => scopeController.scopeAllowsTool(scope, tool, args);
    frozen.scopeContainsAddress = (scope, address) => scopeController.scopeContainsAddress(scope, address);
    frozen.scopeContainsFunction = (scope, address) => scopeController.scopeContainsFunction(scope, address);
  }
  return Object.freeze(frozen);
}

export function resolveBinaryIdentity(local = {}, request = {}) {
  const explicit = normalizeIdentity(request.binaryIdentity ?? local.binaryIdentity);
  if (explicit) return explicit;
  const contentHash = firstBinding(
    request.binaryHash,
    local.binaryHash,
    local.binaryFingerprint?.hash,
    local.fingerprint?.hash,
    local.binary?.fingerprint?.hash,
    local.project?.binaryHash,
  );
  const legacyId = firstBinding(request.binaryId, local.binaryId);
  const slice = selectedSlice(local);
  if (contentHash != null && !slice.invalid) {
    const suffix = slice.value == null ? '' : `:${slice.value}`;
    return {
      id: `content:${contentHash}${suffix}`,
      kind: 'content-derived',
      confidence: 'strong',
      state: 'ready',
      algorithm: first(local.binaryFingerprint?.algorithm, local.fingerprint?.algorithm, 'existing-hash'),
      hash: contentHash,
      legacyId,
    };
  }
  const name = typeof local.fileInfo?.name === 'string' ? local.fileInfo.name : typeof local.binary?.name === 'string' ? local.binary.name : null;
  const fallback = legacyId != null ? legacyId : (!slice.invalid && name ? `${name}:${slice.value ?? '0'}` : null);
  return {
    id: fallback ? `fallback:${fallback}` : 'fallback:unbound',
    kind: 'fallback', confidence: fallback ? 'weak' : 'none', state: 'hash-unavailable',
    algorithm: null, hash: null, legacyId: fallback,
  };
}

function normalizeIdentity(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const id = canonicalBindingId(value);
    return id ? { id, kind: 'external', confidence: 'strong', state: 'ready', algorithm: null, hash: null, legacyId: null } : null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const id = canonicalBindingId(value.id);
  const kind = value.kind == null ? 'external' : canonicalBindingId(value.kind);
  const confidence = value.confidence == null ? 'strong' : canonicalBindingId(value.confidence);
  const state = value.state == null ? 'ready' : canonicalBindingId(value.state);
  const algorithm = value.algorithm == null ? null : canonicalBindingId(value.algorithm);
  const hash = value.hash == null ? null : canonicalBindingId(value.hash);
  const legacyId = value.legacyId == null ? null : canonicalBindingId(value.legacyId);
  if (!id || !kind || !confidence || !state || (value.algorithm != null && !algorithm) || (value.hash != null && !hash) || (value.legacyId != null && !legacyId)) return null;
  return {
    id, kind, confidence, state, algorithm, hash, legacyId,
  };
}

function resolveFunctionRange(local, current) {
  if (current == null) return null;
  let range = null;
  // Each boundary source is optional: one source throwing must not skip the
  // remaining fallbacks, or function scope collapses to the start address
  // (#5416).
  for (const candidate of [
    () => local.functionRange?.(current),
    () => local.symbols?.functionAt?.(current),
    () => local.program?.functionRange?.(current),
  ]) {
    try {
      // Prefer an exact function boundary source over ProgramIndex.functionRange.
      // ProgramIndex intentionally falls back to the executable region end when
      // an exact end is unknown; using that fallback for AI scope=function would
      // silently widen one function to the remainder of the region.
      range = candidate() || null;
    } catch { range = null; continue; }
    if (range) break;
  }
  const start = first(range?.start, range?.address, range?.startAddr, local.activeFunction?.start, local.currentFunction?.start, current);
  const end = first(range?.end, range?.endAddr, local.activeFunction?.end, local.currentFunction?.end);
  return { start: addressText(start), end: addressText(end) };
}

function snapshotSelection(value) {
  if (!value) return null;
  // compactSelection() (and the workbench) accept the selection both as
  // `{ instructions: [...] }` and as a bare instruction array; only the
  // object form here dropped the array form, so the turn snapshot lost the
  // selection boundaries and broke selection scope (#5759).
  const source = Array.isArray(value) ? { instructions: value } : value;
  const rawInstructions = Array.isArray(source.instructions) ? source.instructions : [];
  // The display payload is truncated to 80 entries, but the selection
  // boundaries authorize the scope: they must derive from the original
  // instruction list before truncation, or the scope shrinks with the
  // display payload (#5437).
  const start = addressText(first(source.start, rawInstructions[0]?.address));
  const end = addressText(first(source.end, rawInstructions[rawInstructions.length - 1]?.address, start));
  const instructions = rawInstructions.slice(0, 80).map((item) => ({
    address: addressText(item?.address), mnemonic: String(item?.mnemonic || ''), operands: String(item?.operands || ''),
  }));
  return deepFreeze({ start, end, instructions, truncated: !!source.truncated || (rawInstructions.length > 80) });
}

function snapshotCapabilities(local) {
  const source = local.capabilities || local.capability || {};
  const out = {};
  for (const key of ['canDisassemble', 'architecture', 'instructionAlignment', 'runtime', 'project', 'knowledge', 'semanticIR']) {
    const value = source[key] ?? local[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return out;
}

function snapshotNeighborhood(local, current) {
  const raw = local.allowedNeighborhood || local.neighborhood || [];
  const addresses = new Set();
  if (current != null) addresses.add(addressText(current));
  for (const item of Array.isArray(raw) ? raw.slice(0, 256) : []) {
    const value = item?.address ?? item?.start ?? item;
    const text = addressText(value);
    if (text) addresses.add(text);
  }
  return Array.from(addresses);
}

function safeName(local, address) { try { return local.functionName?.(address) || null; } catch { return null; } }
function copyScalar(value) { return ['string', 'number', 'boolean'].includes(typeof value) ? value : value == null ? null : String(value); }
function first(...values) { return values.find((value) => value !== undefined && value !== null) ?? null; }
function parseAddress(value) { try { return value == null ? null : BigInt(value); } catch { return value; } }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
