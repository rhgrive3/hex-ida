import { currentCppReceiver, isCppReceiverAlias } from '../cxx-evidence.js';

/* Conservative SSA coalescing. It prefers false negatives over false source variables. */

const RESERVED_SPECIAL_REGS = new Set(['sp', 'xzr', 'wzr', 'nzcv']);

function typeName(t) { return t?.name || t?.type || t?.kind || 'unknown'; }
function compatibleType(a, b) {
  const x = typeName(a), y = typeName(b);
  if (x === 'unknown' || y === 'unknown') return true;
  if (x === y) return true;
  const ax = a?.bits, by = b?.bits;
  return ax && by && ax === by && a?.kind === 'integer' && b?.kind === 'integer';
}
function canonicalArgumentIndex(v, opts = {}) {
  const adapter = opts.abiAdapter;
  if (!adapter || adapter.supported !== true || typeof adapter.classifyEntryRegister !== 'function') return null;
  if (v?.def) return null;
  const reg = typeof v?.reg === 'string' ? v.reg : null;
  if (!reg) return null;
  try {
    const entry = adapter.classifyEntryRegister(reg);
    return entry?.kind === 'argument' && Number.isInteger(entry.index) && entry.index >= 0
      ? entry.index : null;
  } catch {
    return null;
  }
}

function legacyAArch64Path(ir, opts = {}) {
  return opts.legacyAArch64 === true
    || !opts.abiAdapter
    || opts.abiAdapter?.id === 'aapcs64'
    || opts.abiAdapter?.architectureId === 'arm64';
}

function canonicalArgReg(reg, isAArch64) {
  const text = String(reg || '').toLowerCase();
  const gp = /^[wx](\d+)$/.exec(text);
  if (gp) return `r${gp[1]}`;
  if (isAArch64) {
    const fp = /^[bhsdqv]([0-9]|[12][0-9]|3[01])$/.exec(text);
    if (fp) return `v${fp[1]}`;
  }
  return text;
}

function buildRecoveredArgMap(recoveredTypes, isAArch64) {
  const list = Array.isArray(recoveredTypes?.args) ? recoveredTypes.args : [];
  if (!list.length) return null;
  const byValueId = new Map();
  const byCanonReg = new Map();
  const ownerByIndex = new Map();
  for (const a of list) {
    if (!a || !Number.isInteger(a.index) || a.index < 0) continue;
    if (a.valueId != null && !byValueId.has(a.valueId)) byValueId.set(a.valueId, a.index);
    if (a.reg) {
      const canon = canonicalArgReg(a.reg, isAArch64);
      if (!byCanonReg.has(canon)) byCanonReg.set(canon, a.index);
      if (!ownerByIndex.has(a.index)) ownerByIndex.set(a.index, canon);
    }
  }
  return { byValueId, byCanonReg, ownerByIndex };
}

function recoveredArgIndex(v, opts = {}) {
  const map = opts.recoveredArgs;
  if (!map || !v) return null;
  if (v.kind !== 'arg' && v.def) return null;
  if (v.id != null && map.byValueId.has(v.id)) return map.byValueId.get(v.id);
  if (v.reg) {
    const canon = canonicalArgReg(v.reg, opts.isAArch64 === true);
    if (map.byCanonReg.has(canon)) return map.byCanonReg.get(canon);
  }
  return null;
}

function collidesWithRecoveredArg(idx, v, opts = {}) {
  const ownerByIndex = opts.recoveredArgs?.ownerByIndex;
  if (!ownerByIndex || !ownerByIndex.has(idx)) return false;
  const canon = v?.reg ? canonicalArgReg(v.reg, opts.isAArch64 === true) : null;
  return ownerByIndex.get(idx) !== canon;
}

function argIndex(v, opts = {}) {
  if (!v) return null;
  const explicit = v.argIndex ?? v.argumentIndex ?? v.abiArgIndex;
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const origin = v.abiOrigin || v.origin || v.provenance;
  const originKind = origin?.kind || origin?.type;
  const originIndex = origin?.index ?? origin?.argIndex;
  if ((originKind === 'arg' || originKind === 'argument') && Number.isInteger(originIndex) && originIndex >= 0) return originIndex;
  const fromRecovered = recoveredArgIndex(v, opts);
  if (fromRecovered != null) return fromRecovered;
  const isAArch64 = opts.isAArch64 ?? legacyAArch64Path(opts.ir, opts);
  const isAArch64FpReg = isAArch64 && /^[bhsdqv][0-7]$/i.test(String(v.reg || ''));
  const canonical = canonicalArgumentIndex(v, opts);
  if (canonical != null) {
    if (isAArch64FpReg && opts.recoveredArgs) return null;
    if (!collidesWithRecoveredArg(canonical, v, opts)) return canonical;
  }
  if (v.kind !== 'arg') return null;
  if (Number.isInteger(v.n) && v.n >= 0 && !collidesWithRecoveredArg(v.n, v, opts)) return v.n;
  if (!legacyAArch64Path(opts.ir, opts)) return null;
  const m = /^x([0-7])$/.exec(v.reg || '');
  if (m) {
    const idx = Number(m[1]);
    return collidesWithRecoveredArg(idx, v, opts) ? null : idx;
  }
  if (isAArch64FpReg && !opts.recoveredArgs) {
    const fpIdx = Number(String(v.reg).slice(1));
    let gpCount = 0;
    if (opts.ir?.args && typeof opts.ir.args.keys === 'function') {
      for (const k of opts.ir.args.keys()) {
        const gm = /^x([0-7])$/.exec(String(k));
        if (gm) {
          const gv = opts.ir.args.get(k);
          if (gv && (gv.uses || []).length > 0) gpCount = Math.max(gpCount, Number(gm[1]) + 1);
        }
      }
    }
    return gpCount + fpIdx;
  }
  return null;
}
function isArg(v) { return argIndex(v) != null; }
function addressTaken(v, stackAddressBaseIds) {
  return (v?.uses || []).some((u) => u?.op === 'store' && u?.addr?.base?.id === v.id)
    || stackAddressBaseIds.has(v?.id);
}
function phiSensitive(v) { return v?.def?.op === 'phi' || (v?.uses || []).some((u) => u?.op === 'phi'); }

function candidateName(group, index, opts = {}) {
  const v = group.values[0];
  const reservedReg = String(v?.reg || '').toLowerCase();
  if (RESERVED_SPECIAL_REGS.has(reservedReg)) {
    return { name: reservedReg, confidence: 1.0, reason: 'reserved architectural register' };
  }
  if (group.kind === 'argument') {
    const n = group.argIndex ?? argIndex(v, opts) ?? index;
    const explicit = opts.argNames?.[n] || null;
    if (explicit) return { name: explicit, confidence: 0.95, reason: 'explicit argument metadata' };
    const cxxRec = currentCppReceiver(opts, opts.ir);
    if (n === 0 && cxxRec && group.values.some(value => isCppReceiverAlias(value, cxxRec, opts.ir))) {
      return { name: 'this', confidence: 0.95, reason: 'proven C++ receiver in canonical ABI argument 0' };
    }
    if (n === 0 && opts.receiverType) return { name: 'self', confidence: 0.92, reason: 'typed receiver in canonical ABI argument 0' };
    // Keep the public decompiler's established source-like ABI naming while the
    // HighVariable identity itself remains SSA/proof based.
    return { name: `a${n + 1}`, confidence: 0.72, reason: 'canonical ABI argument origin' };
  }

  // A no-def SSA value in x0-x7 is an ABI live-in at function entry. It is safe
  // to give that *single SSA value* an argument-like source name, but it is not
  // safe to use the physical register as HighVariable identity: the same xN may
  // later hold a call result or an unrelated temporary. This preserves `self`
  // readability without reintroducing the register-reuse coalescing bug.
  const liveInIndex = !v?.def
    ? (() => {
        const rec = recoveredArgIndex(v, opts);
        if (rec != null) return rec;
        const isAArch64 = opts.isAArch64 ?? legacyAArch64Path(opts.ir, opts);
        if (isAArch64 && /^[bhsdqv][0-7]$/i.test(String(v?.reg || '')) && opts.recoveredArgs) return null;
        const can = canonicalArgumentIndex(v, opts);
        if (can != null && !collidesWithRecoveredArg(can, v, opts)) return can;
        if (legacyAArch64Path(opts.ir, opts) && /^x([0-7])$/.test(v?.reg || '')) {
          const idx = Number(/^x([0-7])$/.exec(v.reg)[1]);
          return collidesWithRecoveredArg(idx, v, opts) ? null : idx;
        }
        return null;
      })()
    : null;
  if (liveInIndex != null) {
    const n = liveInIndex;
    const explicit = opts.argNames?.[n] || null;
    if (explicit) return { name: explicit, confidence: 0.9, reason: 'canonical ABI live-in SSA value' };
    const cxxRec = currentCppReceiver(opts, opts.ir);
    if (n === 0 && cxxRec && isCppReceiverAlias(v, cxxRec, opts.ir)) {
      return { name: 'this', confidence: 0.95, reason: 'proven C++ receiver live-in SSA value' };
    }
    if (n === 0 && opts.receiverType) return { name: 'self', confidence: 0.9, reason: 'typed canonical ABI receiver live-in' };
    return { name: `a${n + 1}`, confidence: 0.68, reason: 'canonical ABI live-in SSA value' };
  }

  if (group.fieldName) return { name: group.fieldName, confidence: group.fieldConfidence || 0.9, reason: 'field metadata' };
  if (group.stackOffset != null) {
    const off = BigInt(group.stackOffset);
    return { name: `local_${(off < 0n ? -off : off).toString(16).toUpperCase()}`, confidence: 0.82, reason: 'stable stack slot' };
  }
  const reg = String(v?.reg || '');
  return { name: /^x\d+$/.test(reg) ? `local_${reg}` : `local_${index + 1}`, confidence: 0.45, reason: 'conservative local' };
}

export function recoverHighVariables(ir, recoveredTypes, opts = {}) {
  const values = (ir?.values || []).filter((v) => v && v.kind !== 'const' && v.reg !== 'nzcv');
  // addressTaken() is evaluated once per SSA value. Build the exact set of
  // stack-address base identities once instead of rescanning every instruction
  // for every value.
  const stackAddressBaseIds = new Set();
  for (const inst of ir?.instructions || []) {
    const address = inst?.addr;
    if (address?.stack) stackAddressBaseIds.add(address?.base?.id);
  }
  const types = recoveredTypes?.values || new Map();
  const isAArch64 = legacyAArch64Path(ir, opts);
  const recoveredArgs = buildRecoveredArgMap(recoveredTypes, isAArch64);
  const argOpts = { ...opts, ir, isAArch64, recoveredArgs };
  const groups = [];
  const byKey = new Map();
  const valueToGroup = new Map();

  for (const v of values) {
    const t = types.get?.(v.id) || null;
    const isReserved = RESERVED_SPECIAL_REGS.has(String(v.reg || '').toLowerCase());
    const unsafe = isReserved || addressTaken(v, stackAddressBaseIds) || phiSensitive(v);
    const origin = !isReserved && v.def?.op === 'mov' && v.def?.args?.[0]?.value ? v.def.args[0].value : null;
    const originGroup = origin ? valueToGroup.get(origin.id) : null;
    // Register allocation is not source-variable identity: unrelated SSA values that
    // merely reuse xN must never be coalesced. Only an explicit ABI argument origin,
    // a stable stack slot, or an explicit MOV lineage is eligible for grouping.
    const ai = isReserved ? null : argIndex(v, argOpts);
    const key = unsafe ? `v:${v.id}` : ai != null ? `arg:${ai}` : v.stackSlot?.key ? `stack:${v.stackSlot.key}` : `v:${v.id}`;
    let g = !unsafe && originGroup ? groups[originGroup - 1] : byKey.get(key);
    if (g && (!compatibleType(g.type, t) || g.unsafeMerge)) g = null;
    if (!g) {
      g = { id: groups.length + 1, key, kind: ai != null ? 'argument' : v.stackSlot ? 'stack' : 'local', values: [], type: t, unsafeMerge: unsafe };
      if (ai != null) g.argIndex = ai;
      if (v.stackSlot?.offset != null) g.stackOffset = v.stackSlot.offset;
      groups.push(g); byKey.set(key, g);
    }
    g.values.push(v); valueToGroup.set(v.id, g.id);
  }

  for (let i = 0; i < groups.length; i++) {
    const naming = candidateName(groups[i], i, argOpts);
    groups[i].name = naming.name;
    groups[i].nameConfidence = naming.confidence;
    groups[i].nameEvidence = naming.reason;
  }
  return { groups, valueToGroup };
}
