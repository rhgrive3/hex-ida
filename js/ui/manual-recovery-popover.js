/*
 * Track 10 (§15): Contextual Manual Recovery Popover.
 *
 * Supports Authority Level 0 manual overrides:
 *   1. Manual Segments (`ManualSegmentMap`: UNDEF/CODE/DATA_U8..U64/STR/ALIGN)
 *   2. Discontiguous Function Chunks (`FuncChunkTable`: attach / detach)
 *   3. Custom ABI (`__usercall` / `__userpurge` `CustomAbiSpec`)
 *   4. Stack Slot Overrides (`HexStackSlotOverride`: forceSplit / forceMerge)
 *   5. Shifted Pointers (`__shifted(T, delta)` / `HEX_CONTAINER_OF`)
 *
 * Pure ESM, zero external runtime dependencies, strictly XSS-safe DOM
 * construction (`textContent` only, never `innerHTML`).
 */

export const MANUAL_SEG_KINDS = Object.freeze({
  UNDEF: 0,
  CODE: 1,
  DATA_U8: 2,
  DATA_U16: 3,
  DATA_U32: 4,
  DATA_U64: 5,
  STR: 6,
  ALIGN: 7,
});

export const MANUAL_SEG_LABELS = Object.freeze([
  'UNDEF (U)',
  'CODE (C)',
  'DATA_U8 (D1)',
  'DATA_U16 (D2)',
  'DATA_U32 (D4)',
  'DATA_U64 (D8)',
  'STR (A)',
  'ALIGN',
]);

export const ABI_LOC_KINDS = Object.freeze({
  NONE: 0,
  GPR: 1,
  FPR_SIMD: 2,
  GPR_PAIR: 3,
  FPR_PAIR: 4,
  STACK: 5,
});

export const RECOVERY_TABS = Object.freeze([
  'segment',
  'chunk',
  'abi',
  'stack',
  'shifted',
]);

export const MAX_MANUAL_SEGMENTS = 8192;
export const MAX_CUSTOM_ABI_ARGS = 12;
export const DEFAULT_UNDO_LIMIT = 50;

const VALID_ARM64_GP_RE = /^[xw](?:[0-9]|[12][0-9]|30)$/i;
const VALID_ARM64_FP_RE = /^[vqdshb](?:[0-9]|[12][0-9]|3[01])$/i;
const VALID_X64_GP_RE = /^(?:r(?:ax|bx|cx|dx|si|di|bp|8|9|1[0-5])|e(?:ax|bx|cx|dx|si|di|bp))$/i;
const VALID_X64_FP_RE = /^xmm(?:[0-9]|1[0-5])$/i;
const VALID_STACK_ARG_RE = /^(?:0x[0-9a-f]+|\d+)\[(?:sp|rsp|esp)\]$/i;
const FORBIDDEN_REG_RE = /^(?:sp|rsp|esp|xzr|wzr)$/i;
const C_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseVa(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? BigInt(value) : null;
  }
  const s = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(s)) return null;
  try {
    const big = BigInt(s);
    return big >= 0n ? big : null;
  } catch {
    return null;
  }
}

function toHexVa(big) {
  return `0x${BigInt(big).toString(16)}`;
}

/* ── Validators (Fail-Closed per §15) ────────────────────────── */

export function validateManualSegment(entry, options = {}) {
  const arch = String(options.arch ?? 'arm64').toLowerCase();
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Manual segment must be an object'], normalized: null };
  }
  const startNum = parseVa(entry.startVa);
  if (startNum == null) errors.push('startVa must be a non-negative integer or hex VA');
  const byteLen = Number(entry.byteLen);
  if (!Number.isSafeInteger(byteLen) || byteLen < 1) errors.push('byteLen must be an integer >= 1');
  const kind = Number(entry.kind);
  if (!Number.isSafeInteger(kind) || kind < 0 || kind > 7) errors.push('kind must be between 0 (UNDEF) and 7 (ALIGN)');

  // §15.1 Fail-Closed ARM64 4-byte alignment requirement for CODE segments
  if (kind === MANUAL_SEG_KINDS.CODE && arch.startsWith('arm64')) {
    if (startNum != null && startNum % 4n !== 0n) {
      errors.push('ARM64 CODE segment startVa must be 4-byte aligned');
    }
    if (Number.isSafeInteger(byteLen) && byteLen % 4 !== 0) {
      errors.push('ARM64 CODE segment byteLen must be a multiple of 4');
    }
  }

  const normalized = errors.length === 0 ? {
    startVa: toHexVa(startNum),
    byteLen,
    kind,
    elemSize: Number.isSafeInteger(entry.elemSize) ? entry.elemSize : (kind === 1 ? 4 : 1),
    strEncoding: Number.isSafeInteger(entry.strEncoding) ? entry.strEncoding : 0,
    alignPow2: Number.isSafeInteger(entry.alignPow2) ? entry.alignPow2 : 0,
    flags: Number.isSafeInteger(entry.flags) ? entry.flags : 0,
    offsetBaseRel: Number.isSafeInteger(entry.offsetBaseRel) ? entry.offsetBaseRel : 0,
  } : null;

  return { valid: errors.length === 0, errors, normalized };
}

export function validateFuncChunk(entry, options = {}) {
  const arch = String(options.arch ?? 'arm64').toLowerCase();
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Function chunk must be an object'], normalized: null };
  }
  const funcVaNum = parseVa(entry.funcVa ?? entry.parentVa);
  const startNum = parseVa(entry.startVa);
  const endNum = parseVa(entry.endVa);
  if (funcVaNum == null) errors.push('funcVa must be a valid VA');
  if (startNum == null) errors.push('startVa must be a valid VA');
  if (endNum == null) errors.push('endVa must be a valid VA');
  if (startNum != null && endNum != null && endNum <= startNum) {
    errors.push('endVa must be strictly greater than startVa');
  }
  if (arch.startsWith('arm64')) {
    if (startNum != null && startNum % 4n !== 0n) errors.push('ARM64 chunk startVa must be 4-byte aligned');
    if (endNum != null && endNum % 4n !== 0n) errors.push('ARM64 chunk endVa must be 4-byte aligned');
  }

  const normalized = errors.length === 0 ? {
    funcVa: toHexVa(funcVaNum),
    startVa: toHexVa(startNum),
    endVa: toHexVa(endNum),
    chunkOrd: Number.isSafeInteger(entry.chunkOrd) && entry.chunkOrd >= 0 ? entry.chunkOrd : 1,
    detached: Boolean(entry.detached),
    flags: Number.isSafeInteger(entry.flags) ? entry.flags : 1, // bit0 = manual
  } : null;

  return { valid: errors.length === 0, errors, normalized };
}

function classifyAbiLocation(locStr) {
  const s = String(locStr ?? '').trim();
  if (!s) return { ok: false, error: 'Empty ABI location' };
  if (FORBIDDEN_REG_RE.test(s)) return { ok: false, error: `Forbidden ABI register: ${s}` };
  if (VALID_STACK_ARG_RE.test(s)) {
    const m = s.match(/^(0x[0-9a-f]+|\d+)\[/i);
    const spOffset = Number.parseInt(m[1], 0);
    if (spOffset < 0 || spOffset > 4096) return { ok: false, error: `Stack offset out of range (0..4096): ${spOffset}` };
    return { ok: true, locKind: ABI_LOC_KINDS.STACK, reg: null, spOffset };
  }
  if (s.includes(':')) {
    const [hi, lo] = s.split(':').map((p) => p.trim());
    if (!hi || !lo || hi.toLowerCase() === lo.toLowerCase()) {
      return { ok: false, error: `Invalid register pair: ${s}` };
    }
    const isGpPair = (VALID_ARM64_GP_RE.test(hi) && VALID_ARM64_GP_RE.test(lo))
      || (VALID_X64_GP_RE.test(hi) && VALID_X64_GP_RE.test(lo));
    const isFpPair = (VALID_ARM64_FP_RE.test(hi) && VALID_ARM64_FP_RE.test(lo))
      || (VALID_X64_FP_RE.test(hi) && VALID_X64_FP_RE.test(lo));
    if (isGpPair) return { ok: true, locKind: ABI_LOC_KINDS.GPR_PAIR, reg: `${hi.toLowerCase()}:${lo.toLowerCase()}`, regs: [hi.toLowerCase(), lo.toLowerCase()] };
    if (isFpPair) return { ok: true, locKind: ABI_LOC_KINDS.FPR_PAIR, reg: `${hi.toLowerCase()}:${lo.toLowerCase()}`, regs: [hi.toLowerCase(), lo.toLowerCase()] };
    return { ok: false, error: `Invalid register pair: ${s}` };
  }
  if (VALID_ARM64_GP_RE.test(s) || VALID_X64_GP_RE.test(s)) {
    return { ok: true, locKind: ABI_LOC_KINDS.GPR, reg: s.toLowerCase(), regs: [s.toLowerCase()] };
  }
  if (VALID_ARM64_FP_RE.test(s) || VALID_X64_FP_RE.test(s)) {
    return { ok: true, locKind: ABI_LOC_KINDS.FPR_SIMD, reg: s.toLowerCase(), regs: [s.toLowerCase()] };
  }
  return { ok: false, error: `Unknown ABI location: ${s}` };
}

/**
 * Parses IDA-style `__usercall` / `__userpurge` declaration:
 * e.g. `int64_t __usercall f@<x0>(void *ctx@<x20>, uint64_t key@<0x10[sp]>)`
 */
export function parseUsercallSignature(decl) {
  const text = String(decl ?? '').trim();
  const m = text.match(/^(.+?)\s+(__usercall|__userpurge)\s+([A-Za-z_][A-Za-z0-9_]*)(?:@<([^<>]+)>)?\s*\((.*?)\)\s*(?:__purge\s*\(\s*(0x[0-9a-fA-F]+|\d+)\s*\))?$/);
  if (!m) {
    return { ok: false, error: 'Expected format: ret_type __usercall|__userpurge name@<ret_reg>(type arg@<loc>, ...)' };
  }
  const retType = m[1].trim();
  const cc = m[2];
  const name = m[3];
  const retLoc = m[4] ? m[4].trim() : null;
  const argsStr = m[5].trim();
  const spPurgeBytes = m[6] ? Number.parseInt(m[6], 0) : 0;

  const args = [];
  if (argsStr && argsStr !== 'void') {
    const rawParts = argsStr.split(',').map((p) => p.trim()).filter(Boolean);
    for (const part of rawParts) {
      const am = part.match(/^(.+?)@<([^<>]+)>$/);
      if (!am) return { ok: false, error: `Argument missing @<loc>: ${part}` };
      args.push({ decl: am[1].trim(), loc: am[2].trim() });
    }
  }
  return { ok: true, retType, cc, name, retLoc, args, spPurgeBytes };
}

export function validateCustomAbi(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return { valid: false, errors: ['Custom ABI spec must be an object'], normalized: null };
  }

  let working = { ...spec };
  if (typeof spec.signature === 'string' && spec.signature.trim()) {
    const parsed = parseUsercallSignature(spec.signature);
    if (!parsed.ok) {
      return { valid: false, errors: [parsed.error], normalized: null };
    }
    working = {
      ...working,
      cc: parsed.cc,
      retType: parsed.retType,
      retLoc: parsed.retLoc,
      args: parsed.args,
      spPurgeBytes: parsed.spPurgeBytes,
    };
  }

  const funcVaNum = parseVa(working.funcVa);
  if (funcVaNum == null) errors.push('funcVa must be a valid VA');

  const spPurgeBytes = Number(working.spPurgeBytes ?? 0);
  if (!Number.isSafeInteger(spPurgeBytes) || spPurgeBytes < 0 || spPurgeBytes % 16 !== 0) {
    errors.push('spPurgeBytes must be a non-negative 16-byte aligned integer');
  }

  let retLocInfo = { locKind: ABI_LOC_KINDS.NONE, reg: null };
  if (working.retLoc) {
    const rc = classifyAbiLocation(working.retLoc);
    if (!rc.ok) errors.push(`Return location: ${rc.error}`);
    else retLocInfo = rc;
  }

  const args = Array.isArray(working.args) ? working.args : [];
  if (args.length > MAX_CUSTOM_ABI_ARGS) {
    errors.push(`Custom ABI supports at most ${MAX_CUSTOM_ABI_ARGS} arguments (got ${args.length})`);
  }

  const seenRegs = new Set();
  const normalizedArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const loc = typeof a === 'string' ? a : a?.loc;
    const lc = classifyAbiLocation(loc);
    if (!lc.ok) {
      errors.push(`arg[${i}]: ${lc.error}`);
      continue;
    }
    if (Array.isArray(lc.regs)) {
      for (const r of lc.regs) {
        if (seenRegs.has(r)) errors.push(`Duplicate physical register across arguments: ${r}`);
        seenRegs.add(r);
      }
    }
    normalizedArgs.push({
      decl: String(a?.decl ?? a?.type ?? 'uint64_t'),
      loc: String(loc).trim(),
      locKind: lc.locKind,
      spOffset: lc.spOffset ?? 0,
    });
  }

  const normalized = errors.length === 0 ? {
    funcVa: toHexVa(funcVaNum),
    cc: working.cc === '__userpurge' ? '__userpurge' : '__usercall',
    retType: String(working.retType ?? 'void'),
    retLoc: working.retLoc ? String(working.retLoc).trim() : null,
    retLocKind: retLocInfo.locKind,
    spPurgeBytes,
    args: normalizedArgs,
    argCount: normalizedArgs.length,
    signature: typeof spec.signature === 'string' ? spec.signature.trim() : null,
  } : null;

  return { valid: errors.length === 0, errors, normalized };
}

export function validateStackSlotOverride(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Stack slot override must be an object'], normalized: null };
  }
  const funcVaNum = parseVa(entry.funcVa ?? '0x0');
  if (funcVaNum == null) errors.push('funcVa must be a valid VA');
  const spOffset = Number(entry.spOffset);
  if (!Number.isSafeInteger(spOffset)) errors.push('spOffset must be a safe integer');
  const byteSize = Number(entry.byteSize);
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) errors.push('byteSize must be an integer >= 1');
  const arrayLen = Number(entry.arrayLen ?? 0);
  if (!Number.isSafeInteger(arrayLen) || arrayLen < 0) errors.push('arrayLen must be >= 0');
  if (entry.forceSplit && entry.forceMerge) {
    errors.push('forceSplit and forceMerge cannot both be enabled');
  }
  const typeStr = String(entry.type ?? '').trim();
  if (!typeStr || /[<>]/.test(typeStr)) {
    errors.push('type must be a valid non-empty C type without < or >');
  }

  const normalized = errors.length === 0 ? {
    funcVa: toHexVa(funcVaNum),
    spOffset,
    byteSize,
    type: typeStr,
    arrayLen,
    name: entry.name ? String(entry.name).trim() : null,
    forceSplit: Boolean(entry.forceSplit),
    forceMerge: Boolean(entry.forceMerge),
    noRegPromote: Boolean(entry.noRegPromote),
    fpRel: Boolean(entry.fpRel),
  } : null;

  return { valid: errors.length === 0, errors, normalized };
}

export function formatShiftedPtrPreviews(entry) {
  const deltaHex = entry.shiftOffset < 0
    ? `-0x${Math.abs(entry.shiftOffset).toString(16)}`
    : `0x${entry.shiftOffset.toString(16)}`;
  const pathA = `${entry.parentType} *__shifted(${entry.parentType}, ${deltaHex}) ${entry.varKey}`;
  const pathB = `HEX_CONTAINER_OF(${entry.varKey}, ${entry.parentType}, ${deltaHex})`;
  return { pathA, pathB };
}

export function validateShiftedPtr(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Shifted pointer spec must be an object'], normalized: null };
  }
  const funcVaNum = parseVa(entry.funcVa ?? '0x0');
  if (funcVaNum == null) errors.push('funcVa must be a valid VA');
  const varKey = String(entry.varKey ?? '').trim();
  if (!varKey || /[<>]/.test(varKey)) errors.push('varKey must be a non-empty variable key (e.g. arg:0, loc:sp+0x20)');
  const parentType = String(entry.parentType ?? '').trim();
  if (!C_IDENT_RE.test(parentType)) errors.push('parentType must be a valid C struct/type identifier');
  const shiftOffset = Number(entry.shiftOffset);
  if (!Number.isSafeInteger(shiftOffset)) errors.push('shiftOffset must be a safe integer');
  if (shiftOffset === 0 && !entry.allowZeroShift) errors.push('shiftOffset must be non-zero');

  const normalized = errors.length === 0 ? {
    funcVa: toHexVa(funcVaNum),
    varKey,
    parentType,
    shiftOffset,
    memberOff: Number.isSafeInteger(entry.memberOff) ? entry.memberOff : 0,
    memberName: entry.memberName ? String(entry.memberName).trim() : null,
    preferContainerOf: entry.preferContainerOf !== false,
    allowNegOffset: Boolean(entry.allowNegOffset),
    ...formatShiftedPtrPreviews({ varKey, parentType, shiftOffset }),
  } : null;

  return { valid: errors.length === 0, errors, normalized };
}

/* ── Controller ──────────────────────────────────────────────── */

export function createManualRecoveryPopoverController(options = {}) {
  const arch = String(options.arch ?? 'arm64');
  const undoLimit = Number.isSafeInteger(options.undoLimit) && options.undoLimit > 0
    ? options.undoLimit
    : DEFAULT_UNDO_LIMIT;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;

  let state = {
    open: false,
    activeTab: 'segment',
    manualSegments: [],
    funcChunks: [],
    customAbis: [],
    stackSlotOverrides: [],
    shiftedPtrs: [],
    lastError: null,
    revision: 0,
  };

  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();

  function cloneCollections(src) {
    return {
      manualSegments: src.manualSegments.map((x) => ({ ...x })),
      funcChunks: src.funcChunks.map((x) => ({ ...x })),
      customAbis: src.customAbis.map((x) => ({ ...x, args: (x.args ?? []).map((a) => ({ ...a })) })),
      stackSlotOverrides: src.stackSlotOverrides.map((x) => ({ ...x })),
      shiftedPtrs: src.shiftedPtrs.map((x) => ({ ...x })),
    };
  }

  function emit() {
    const snap = getState();
    for (const fn of listeners) fn(snap);
  }

  function applyMutation(mutator) {
    const before = cloneCollections(state);
    const next = cloneCollections(state);
    mutator(next);
    const after = cloneCollections(next);
    undoStack.push({ before, after });
    while (undoStack.length > undoLimit) undoStack.shift();
    redoStack.length = 0;
    state = {
      ...state,
      ...after,
      lastError: null,
      revision: state.revision + 1,
    };
    if (onChange) onChange(exportState());
    emit();
  }

  function getState() {
    return Object.freeze({
      open: state.open,
      activeTab: state.activeTab,
      manualSegments: Object.freeze(state.manualSegments.map((x) => Object.freeze({ ...x }))),
      funcChunks: Object.freeze(state.funcChunks.map((x) => Object.freeze({ ...x }))),
      customAbis: Object.freeze(state.customAbis.map((x) => Object.freeze({ ...x }))),
      stackSlotOverrides: Object.freeze(state.stackSlotOverrides.map((x) => Object.freeze({ ...x }))),
      shiftedPtrs: Object.freeze(state.shiftedPtrs.map((x) => Object.freeze({ ...x }))),
      lastError: state.lastError,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      revision: state.revision,
    });
  }

  function open(tab = 'segment') {
    state = { ...state, open: true, activeTab: RECOVERY_TABS.includes(tab) ? tab : 'segment', lastError: null };
    emit();
    return getState();
  }

  function close() {
    state = { ...state, open: false };
    emit();
    return getState();
  }

  function setTab(tab) {
    if (!RECOVERY_TABS.includes(tab)) return getState();
    state = { ...state, activeTab: tab, lastError: null };
    emit();
    return getState();
  }

  function fail(errors) {
    state = { ...state, lastError: errors.join('; ') };
    emit();
    return { ok: false, errors };
  }

  function addOrUpdateManualSegment(entry) {
    const res = validateManualSegment(entry, { arch });
    if (!res.valid) return fail(res.errors);
    if (state.manualSegments.length >= MAX_MANUAL_SEGMENTS) {
      return fail([`Manual segment limit reached (${MAX_MANUAL_SEGMENTS})`]);
    }
    applyMutation((c) => {
      const idx = c.manualSegments.findIndex((s) => s.startVa === res.normalized.startVa);
      if (idx >= 0) c.manualSegments[idx] = res.normalized;
      else c.manualSegments.push(res.normalized);
      c.manualSegments.sort((a, b) => { const av = parseVa(a.startVa) ?? 0n; const bv = parseVa(b.startVa) ?? 0n; return av < bv ? -1 : (av > bv ? 1 : 0); });
    });
    return { ok: true, entry: res.normalized };
  }

  function removeManualSegment(startVa) {
    const normVa = toHexVa(parseVa(startVa) ?? 0n);
    applyMutation((c) => {
      c.manualSegments = c.manualSegments.filter((s) => s.startVa !== normVa);
    });
    return { ok: true };
  }

  function addOrUpdateFuncChunk(entry) {
    const res = validateFuncChunk(entry, { arch });
    if (!res.valid) return fail(res.errors);
    applyMutation((c) => {
      const idx = c.funcChunks.findIndex((x) => x.funcVa === res.normalized.funcVa && x.startVa === res.normalized.startVa);
      if (idx >= 0) c.funcChunks[idx] = res.normalized;
      else c.funcChunks.push(res.normalized);
    });
    return { ok: true, entry: res.normalized };
  }

  function detachFuncChunk(funcVa, startVa) {
    const fVa = toHexVa(parseVa(funcVa) ?? 0n);
    const sVa = toHexVa(parseVa(startVa) ?? 0n);
    applyMutation((c) => {
      const idx = c.funcChunks.findIndex((x) => x.funcVa === fVa && x.startVa === sVa);
      if (idx >= 0) c.funcChunks[idx] = { ...c.funcChunks[idx], detached: true };
    });
    return { ok: true };
  }

  function setCustomAbi(spec) {
    const res = validateCustomAbi(spec);
    if (!res.valid) return fail(res.errors);
    applyMutation((c) => {
      const idx = c.customAbis.findIndex((a) => a.funcVa === res.normalized.funcVa);
      if (idx >= 0) c.customAbis[idx] = res.normalized;
      else c.customAbis.push(res.normalized);
    });
    return { ok: true, entry: res.normalized };
  }

  function removeCustomAbi(funcVa) {
    const fVa = toHexVa(parseVa(funcVa) ?? 0n);
    applyMutation((c) => {
      c.customAbis = c.customAbis.filter((a) => a.funcVa !== fVa);
    });
    return { ok: true };
  }

  function setStackSlotOverride(entry) {
    const res = validateStackSlotOverride(entry);
    if (!res.valid) return fail(res.errors);
    applyMutation((c) => {
      const idx = c.stackSlotOverrides.findIndex(
        (s) => s.funcVa === res.normalized.funcVa && s.spOffset === res.normalized.spOffset,
      );
      if (idx >= 0) c.stackSlotOverrides[idx] = res.normalized;
      else c.stackSlotOverrides.push(res.normalized);
    });
    return { ok: true, entry: res.normalized };
  }

  function setShiftedPtr(entry) {
    const res = validateShiftedPtr(entry);
    if (!res.valid) return fail(res.errors);
    applyMutation((c) => {
      const idx = c.shiftedPtrs.findIndex(
        (p) => p.funcVa === res.normalized.funcVa && p.varKey === res.normalized.varKey,
      );
      if (idx >= 0) c.shiftedPtrs[idx] = res.normalized;
      else c.shiftedPtrs.push(res.normalized);
    });
    return { ok: true, entry: res.normalized };
  }

  function undo() {
    if (undoStack.length === 0) return { ok: false, reason: 'nothing_to_undo' };
    const tx = undoStack.pop();
    redoStack.push(tx);
    state = { ...state, ...cloneCollections(tx.before), lastError: null, revision: state.revision + 1 };
    if (onChange) onChange(exportState());
    emit();
    return { ok: true };
  }

  function redo() {
    if (redoStack.length === 0) return { ok: false, reason: 'nothing_to_redo' };
    const tx = redoStack.pop();
    undoStack.push(tx);
    state = { ...state, ...cloneCollections(tx.after), lastError: null, revision: state.revision + 1 };
    if (onChange) onChange(exportState());
    emit();
    return { ok: true };
  }

  function exportState() {
    return cloneCollections(state);
  }

  function loadState(snapshot = {}) {
    state = {
      ...state,
      manualSegments: Array.isArray(snapshot.manualSegments) ? snapshot.manualSegments.map((x) => ({ ...x })) : [],
      funcChunks: Array.isArray(snapshot.funcChunks) ? snapshot.funcChunks.map((x) => ({ ...x })) : [],
      customAbis: Array.isArray(snapshot.customAbis) ? snapshot.customAbis.map((x) => ({ ...x })) : [],
      stackSlotOverrides: Array.isArray(snapshot.stackSlotOverrides) ? snapshot.stackSlotOverrides.map((x) => ({ ...x })) : [],
      shiftedPtrs: Array.isArray(snapshot.shiftedPtrs) ? snapshot.shiftedPtrs.map((x) => ({ ...x })) : [],
      lastError: null,
      revision: state.revision + 1,
    };
    emit();
    return getState();
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    open,
    close,
    setTab,
    addOrUpdateManualSegment,
    removeManualSegment,
    addOrUpdateFuncChunk,
    detachFuncChunk,
    setCustomAbi,
    removeCustomAbi,
    setStackSlotOverride,
    setShiftedPtr,
    undo,
    redo,
    exportState,
    loadState,
    getState,
    subscribe,
  };
}

/* ── Safe DOM View Renderer ──────────────────────────────────── */

export function renderManualRecoveryPopover(controller, options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('renderManualRecoveryPopover requires a document with createElement');
  }

  const ac = new AbortController();
  const { signal } = ac;

  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  };

  const root = el('div', 'hex-popover hex-manual-recovery-popover');
  root.setAttribute('role', 'dialog');
  root.setAttribute('data-popover', 'manual-recovery');
  root.setAttribute('aria-label', 'Manual Recovery Overrides');

  const header = el('div', 'hex-popover-header');
  header.appendChild(el('span', 'hex-popover-title', 'Manual Recovery (Authority L0)'));
  const closeBtn = el('button', 'hex-popover-close', '×');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => controller.close(), { signal });
  header.appendChild(closeBtn);

  const tabBar = el('div', 'hex-recovery-tabs');
  const tabLabels = {
    segment: 'Segments (C/D/U)',
    chunk: 'Func Chunks',
    abi: 'Custom ABI',
    stack: 'Stack Slots',
    shifted: 'Shifted Ptrs',
  };
  const tabBtns = new Map();
  for (const tab of RECOVERY_TABS) {
    const btn = el('button', 'hex-recovery-tab', tabLabels[tab]);
    btn.type = 'button';
    btn.setAttribute('data-tab', tab);
    btn.addEventListener('click', () => controller.setTab(tab), { signal });
    tabBar.appendChild(btn);
    tabBtns.set(tab, btn);
  }

  const errorBanner = el('div', 'hex-recovery-error', '');
  errorBanner.setAttribute('data-role', 'error-banner');

  const listEl = el('ul', 'hex-recovery-entry-list');
  listEl.setAttribute('data-role', 'entry-list');

  const footer = el('div', 'hex-popover-actions');
  const undoBtn = el('button', 'hex-btn-undo', 'Undo');
  undoBtn.type = 'button';
  undoBtn.addEventListener('click', () => controller.undo(), { signal });
  const redoBtn = el('button', 'hex-btn-redo', 'Redo');
  redoBtn.type = 'button';
  redoBtn.addEventListener('click', () => controller.redo(), { signal });
  footer.appendChild(undoBtn);
  footer.appendChild(redoBtn);

  root.appendChild(header);
  root.appendChild(tabBar);
  root.appendChild(errorBanner);
  root.appendChild(listEl);
  root.appendChild(footer);

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function sync(snap) {
    root.setAttribute('data-open', snap.open ? 'true' : 'false');
    root.setAttribute('data-active-tab', snap.activeTab);
    for (const [tab, btn] of tabBtns.entries()) {
      btn.setAttribute('aria-pressed', String(tab === snap.activeTab));
    }
    errorBanner.textContent = snap.lastError ?? '';
    undoBtn.disabled = !snap.canUndo;
    redoBtn.disabled = !snap.canRedo;

    clearChildren(listEl);
    let items = [];
    if (snap.activeTab === 'segment') {
      items = snap.manualSegments.map((s) => `${s.startVa} (+${s.byteLen}B) [${MANUAL_SEG_LABELS[s.kind] ?? s.kind}]`);
    } else if (snap.activeTab === 'chunk') {
      items = snap.funcChunks.map((c) => `${c.funcVa}: [${c.startVa}, ${c.endVa})${c.detached ? ' (detached)' : ''}`);
    } else if (snap.activeTab === 'abi') {
      items = snap.customAbis.map((a) => `${a.funcVa}: ${a.cc} ${a.retType}${a.retLoc ? `@<${a.retLoc}>` : ''} (${a.argCount} args)`);
    } else if (snap.activeTab === 'stack') {
      items = snap.stackSlotOverrides.map((s) => `${s.funcVa} ${s.fpRel ? 'fp' : 'sp'}${s.spOffset >= 0 ? '+' : ''}${s.spOffset}: ${s.type} (${s.byteSize}B)${s.name ? ` ${s.name}` : ''}`);
    } else if (snap.activeTab === 'shifted') {
      items = snap.shiftedPtrs.map((p) => `${p.funcVa}: ${p.pathA} | C11: ${p.pathB}`);
    }

    for (const line of items) {
      listEl.appendChild(el('li', 'hex-recovery-entry', line));
    }
  }

  sync(controller.getState());
  const unsubscribe = controller.subscribe(sync);
  return {
    element: root,
    destroy: () => {
      unsubscribe();
      ac.abort();
      root.remove?.();
    },
    sync: () => sync(controller.getState()),
  };
}
