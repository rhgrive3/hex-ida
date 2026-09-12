/*
 * ir.js — public facade for the Semantic IR engine.
 *
 * ir-core.js contains lifting / SSA / Memory-SSA. This facade is the semantic
 * boundary seen by the rest of Hex: it supplies CFG address resolution,
 * conservative memory safety, pointer provenance, value/range queries and
 * canonical alias checks. Consumers must not reinterpret ARM64 to recover these
 * facts a second time.
 */

export * from './ir-core.js';

import {
  buildIR as buildCoreIR,
  readModifyWrite as coreReadModifyWrite,
  getSemanticMigrationMode,
  OP, MK, VK, COND, pointerProvenance,
} from './ir-core.js';
import { normalizeIntegerValue, normalizeRangeDomain, rangeWithDomain } from './range-domain.js';
import { annotateValueRanges, shiftedConst, typeBounds } from './semantics/compat/legacy-value-ranges.js';

function inferredRowResolver(model) {
  const byAddress = new Map();
  for (const insn of (model && model.instructions) || []) {
    if (insn && insn.address != null && insn.row != null) {
      byAddress.set(insn.address.toString(), insn.row);
    }
  }
  if (!byAddress.size) return () => null;
  return (addr) => {
    if (addr == null) return null;
    const row = byAddress.get(addr.toString());
    return row == null ? null : row;
  };
}

function normalizedOptions(model, opts) {
  const o = opts ? { ...opts } : {};
  if (!o.cfg && !o.rowOfAddress) o.rowOfAddress = inferredRowResolver(model);
  return o;
}

function blockReachability(ir) {
  if (ir._canReachBlock) return ir._canReachBlock;
  const cache = new Map();
  const canReach = (from, to) => {
    if (from == null || to == null || from < 0 || to < 0) return false;
    if (from === to) return true;
    const key = from + '>' + to;
    if (cache.has(key)) return cache.get(key);
    const seen = new Set([from]);
    const work = [from];
    let yes = false;
    while (work.length && !yes) {
      const b = work.pop();
      for (const s of (ir.blocks[b] && ir.blocks[b].succ) || []) {
        if (s === to) { yes = true; break; }
        if (!seen.has(s)) { seen.add(s); work.push(s); }
      }
    }
    cache.set(key, yes);
    return yes;
  };
  ir._canReachBlock = canReach;
  return canReach;
}

function orderedBefore(a, b, canReach) {
  if (!a || !b) return false;
  if (a.block === b.block) return (a.row == null ? -1 : a.row) < (b.row == null ? -1 : b.row);
  return canReach(a.block, b.block);
}

function unknownStores(ir) {
  if (ir._unknownStoreBarriers) return ir._unknownStoreBarriers;
  const list = (ir.instructions || []).filter((inst) =>
    inst.op === OP.STORE && (!inst.loc || inst.loc.kind === MK.UNKNOWN));
  ir._unknownStoreBarriers = list;
  return list;
}

function unknownStoreBetween(ir, from, to) {
  const barriers = unknownStores(ir);
  if (!barriers.length || !from || !to) return null;
  const canReach = blockReachability(ir);
  for (const candidate of barriers) {
    if (orderedBefore(from, candidate, canReach) && orderedBefore(candidate, to, canReach)) return candidate;
  }
  return null;
}

/** A legacy proof is unsafe when an unknown indexed store can occur in-between. */
export function hasUnknownStoreBarrier(ir, from, to) {
  return !!unknownStoreBetween(ir, from, to);
}

/**
 * STORE(MK.UNKNOWN) is a may-alias write to every non-stack object/global state.
 * Never let a concrete reaching-store proof pass through it.
 */
function hardenUnknownStores(ir) {
  if (!ir || !ir.instructions) return ir;
  const barriers = unknownStores(ir);
  if (!barriers.length) {
    ir.memorySafety = { unknownStores: 0, blockedLoads: 0 };
    return ir;
  }

  let blocked = 0;
  for (const load of ir.instructions) {
    if (load.op !== OP.LOAD) continue;
    // Core Memory-SSA may already have materialized the unknown indexed store as
    // the reaching clobber. Count that blocked proof instead of requiring a stale
    // reachingStore to still be attached (#358). This keeps telemetry aligned
    // with the actual proof state without re-running alias inference.
    if (load.memUse?.kind === 'clobber' && load.memUse.unknownAlias) {
      load.unknownAliasBarrier = load.memUse.inst || null;
      blocked++;
      continue;
    }
    if (!load.reachingStore) continue;
    const barrier = unknownStoreBetween(ir, load.reachingStore, load);
    if (!barrier) continue;
    load.reachingStore = null;
    load.memUse = {
      kind: 'clobber',
      key: load.loc ? load.loc.key : 'unknown',
      inst: barrier,
      block: barrier.block,
      unknownAlias: true,
    };
    load.unknownAliasBarrier = barrier;
    blocked++;
  }
  ir.memorySafety = { unknownStores: barriers.length, blockedLoads: blocked };
  return ir;
}

/** Reclassify addresses proved absolute only after constant propagation. */
function promoteResolvedGlobals(ir) {
  if (!ir || !ir.instructions) return ir;
  const globals = new Map();
  for (const inst of ir.instructions) {
    if ((inst.op !== OP.LOAD && inst.op !== OP.STORE) || !inst.addr) continue;
    const a = inst.addr;
    if (a.stack || a.index || !a.base || a.base.const == null || a.disp == null) continue;

    const address = a.base.const + a.disp;
    const size = (inst.loc && inst.loc.size) || a.size || (inst.extra && inst.extra.size) || null;
    // A global address identifies the storage root, not an access extent. Keep
    // per-access width in the canonical location key so a 32-bit access cannot
    // overwrite the size carried by an 8-bit/64-bit access at the same address.
    const extent = size == null ? 'unknown' : String(size);
    const key = 'global:' + address.toString(16) + ':size:' + extent;
    let loc = globals.get(key);
    if (!loc) {
      loc = { key, kind: MK.GLOBAL, address, size };
      globals.set(key, loc);
    }

    const oldKey = inst.loc && inst.loc.key;
    inst.loc = loc;
    inst.globalAddress = address;
    if (inst.memUse && oldKey != null && inst.memUse.key === oldKey) inst.memUse.key = key;
    if (inst.memDef && oldKey != null && inst.memDef.key === oldKey) inst.memDef.key = key;
  }
  if (ir.locations && ir.locations.set) {
    for (const [key, loc] of globals) ir.locations.set(key, loc);
  }
  delete ir._unknownStoreBarriers;
  return ir;
}

/* ── Pointer provenance ─────────────────────────────────────── */


function effectiveLocation(loc) {
  if (!loc) return null;
  if (loc.kind === MK.UNKNOWN) return { kind: MK.UNKNOWN, key: 'unknown', size: loc.size || null, must: false };
  if (loc.kind === MK.STACK) return { kind: MK.STACK, root: 'stack', disp: loc.disp || 0n, size: loc.size || null, must: true };
  if (loc.kind === MK.GLOBAL) return { kind: MK.GLOBAL, root: 'global', address: loc.address, size: loc.size || null, must: true };
  if (loc.kind !== MK.FIELD || !loc.base || loc.disp == null) return { kind: loc.kind, must: false, size: loc.size || null };

  const p = pointerProvenance(loc.base);
  if (!p || p.must === false || p.kind === 'phi') {
    return { kind: MK.FIELD, root: p ? p.root : null, disp: loc.disp, size: loc.size || null, must: false };
  }
  const off = (p.offset || 0n) + loc.disp;
  if (p.kind === 'stack') return { kind: MK.STACK, root: 'stack', disp: off, size: loc.size || null, must: true };
  if (p.kind === 'global' && p.address != null) {
    return { kind: MK.GLOBAL, root: 'global', address: p.address + off, size: loc.size || null, must: true };
  }
  return { kind: MK.FIELD, root: p.root, disp: off, size: loc.size || null, must: p.must !== false, provenance: p };
}

function sizeCompatible(a, b) {
  if (a.size == null || b.size == null) return false;
  return a.size === b.size;
}

function rangesProvablyDisjoint(startA, sizeA, startB, sizeB) {
  if (startA == null || startB == null || sizeA == null || sizeB == null) return false;
  const sa = BigInt(sizeA), sb = BigInt(sizeB);
  return startA + sa <= startB || startB + sb <= startA;
}

/** True only when the two locations are proved identical. */
export function mustAlias(a, b) {
  if (!a || !b || a.kind === MK.UNKNOWN || b.kind === MK.UNKNOWN) return false;
  const x = effectiveLocation(a), y = effectiveLocation(b);
  if (!x || !y || x.must === false || y.must === false || x.kind !== y.kind) return false;
  if (!sizeCompatible(x, y)) return false;
  if (x.kind === MK.STACK) return x.disp != null && x.disp === y.disp;
  if (x.kind === MK.GLOBAL) return x.address != null && x.address === y.address;
  return x.kind === MK.FIELD && x.root != null && x.root === y.root && x.disp != null && x.disp === y.disp;
}

/** Conservative may-alias query that understands pointer+constant provenance. */
export function mayAliasProvenance(a, b) {
  if (!a || !b) return true;
  if (mustAlias(a, b)) return true;
  const x = effectiveLocation(a), y = effectiveLocation(b);
  if (!x || !y || x.kind === MK.UNKNOWN || y.kind === MK.UNKNOWN) return true;
  if (x.kind !== y.kind) {
    if (x.kind === MK.FIELD || y.kind === MK.FIELD) return true;
    return false;
  }
  if (x.kind === MK.STACK || x.kind === MK.GLOBAL) {
    const pa = x.kind === MK.STACK ? x.disp : x.address;
    const pb = y.kind === MK.STACK ? y.disp : y.address;
    if (pa == null || pb == null) return true;
    return !rangesProvablyDisjoint(pa, x.size, pb, y.size);
  }
  if (x.kind === MK.FIELD && x.root && y.root && x.root === y.root && x.disp != null && y.disp != null) {
    return !rangesProvablyDisjoint(x.disp, x.size, y.disp, y.size);
  }
  return true;
}

/* ── Value range / signedness / nullability ─────────────────── */






export function valueRange(value) {
  if (!value) return null;
  if (value.const != null) {
    const n = normalizeIntegerValue(value.const, value.bits || 64, value.signed);
    return { min:n, max:n };
  }
  return value.range ? { min: value.range.min, max: value.range.max } : null;
}

function nullabilityFromZero(zero, explicit) {
  if (explicit === false) return 'non-null';
  if (explicit === true) return 'maybe-null';
  if (zero === 'zero') return 'null';
  if (zero === 'non-zero') return 'non-null';
  return 'unknown';
}

export function valueInfo(value) {
  if (!value) return {
    constant: null, min: null, max: null, signedness: 'unknown', zero: 'unknown', nullability: 'unknown', provenance: null,
  };
  const range = valueRange(value);
  let zero = 'unknown';
  if (value.const != null) zero = value.const === 0n ? 'zero' : 'non-zero';
  else if (range && range.min === 0n && range.max === 0n) zero = 'zero';
  else if (range && (range.min > 0n || range.max < 0n)) zero = 'non-zero';
  return {
    constant: value.const == null ? null : value.const,
    min: range ? range.min : null,
    max: range ? range.max : null,
    signedness: value.signed === true ? 'signed' : value.signed === false ? 'unsigned' : 'unknown',
    zero,
    nullability: nullabilityFromZero(zero, value.nullable),
    provenance: pointerProvenance(value),
  };
}

function comparisonOfBranch(branch) {
  if (!branch || branch.op !== OP.CBR) return null;
  const kind = branch.extra && branch.extra.kind;
  if ((kind === 'cbz' || kind === 'cbnz') && branch.args[0] && branch.args[0].value) {
    return {
      lhs: branch.args[0].value,
      rhs: 0n,
      cond: kind === 'cbz' ? 'eq' : 'ne',
      cmp: null,
      bits: branch.args[0].bits || branch.args[0].value.bits || 64,
    };
  }
  const flags = branch.args[0] && branch.args[0].value;
  const cmp = flags && flags.def && flags.def.op === OP.CMP ? flags.def : null;
  if (!cmp || !cmp.args[0] || !cmp.args[0].value || !cmp.args[1] || !cmp.args[1].value) return null;
  const semanticBits = Number(
    cmp.extra?.attributes?.machineEffects?.operationMetadata?.widthBits
      ?? cmp.extra?.attributes?.machineEffects?.bundleMetadata?.widthBits
      ?? cmp.extra?.widthBits
      ?? 0,
  );
  const bits = (semanticBits === 32 || semanticBits === 64)
    ? semanticBits
    : (cmp.bits || cmp.args[0].bits || cmp.args[0].value.bits || 64);
  const rhs = shiftedConst(cmp.args[1], bits);
  if (rhs == null) return null;
  return { lhs: cmp.args[0].value, rhs, cond: branch.cond || null, cmp, bits };
}

function invertRel(op) {
  return ({ '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<' })[op] || null;
}

function constrainedRange(value, op, constant, signed, compareBits = null) {
  const bits = compareBits || value?.bits || 64;
  const rhs = normalizeIntegerValue(constant, bits, signed);
  const bounds = typeBounds(bits, signed);
  let min = bounds.min, max = bounds.max;
  if (op === '==') min = max = rhs;
  else if (op === '<') max = rhs - 1n;
  else if (op === '<=') max = rhs;
  else if (op === '>') min = rhs + 1n;
  else if (op === '>=') min = rhs;
  else return null;
  const existing = value?.range ?? null;
  const comparableExisting = existing
    ? normalizeRangeDomain(existing, bits, signed)
    : null;
  if (comparableExisting) {
    if (comparableExisting.min > min) min = comparableExisting.min;
    if (comparableExisting.max < max) max = comparableExisting.max;
  }
  if (min > max) return { min, max, impossible: true };
  return { min, max };
}

function zeroFactOnEdge(op, constant) {
  if (constant !== 0n) return 'unknown';
  if (op === '==') return 'zero';
  if (op === '!=') return 'non-zero';
  if (op === '>') return 'non-zero';
  return 'unknown';
}

/** Range/nullability that is true on one branch edge. Does not mutate SSA globally. */
export function rangeOnBranch(ir, branch, taken = true) {
  void ir;
  const c = comparisonOfBranch(branch);
  if (!c || !c.cond) return null;
  const info = c.cond === 'eq' || c.cond === 'ne' ? { op: c.cond === 'eq' ? '==' : '!=', signed: null } : COND[c.cond];
  if (!info || !info.op) return null;
  const relation = taken ? info.op : invertRel(info.op);
  const signedForBounds = info.signed == null ? (c.lhs.signed === true) : info.signed;
  const signedness = info.signed === true ? 'signed'
    : info.signed === false ? 'unsigned'
      : c.lhs.signed === true ? 'signed'
        : c.lhs.signed === false ? 'unsigned' : 'unknown';
  const compareBits = c.bits || c.lhs.bits || 64;
  const rhs = normalizeIntegerValue(c.rhs, compareBits, signedForBounds);
  const range = constrainedRange(c.lhs, relation, rhs, signedForBounds, compareBits);
  const zero = zeroFactOnEdge(relation, rhs);
  return {
    value: c.lhs,
    condition: relation,
    constant: rhs,
    signedness,
    range,
    zero,
    nullability: nullabilityFromZero(zero, null),
    taken: !!taken,
    branch,
    compare: c.cmp,
  };
}

export function branchConstraints(ir) {
  if (!ir) return [];
  if (ir._branchConstraints) return ir._branchConstraints;
  const out = [];
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.CBR) continue;
    const yes = rangeOnBranch(ir, inst, true);
    const no = rangeOnBranch(ir, inst, false);
    if (yes || no) out.push({ branch: inst, taken: yes, fallthrough: no });
  }
  ir._branchConstraints = out;
  return out;
}

/* ── Stable value origin ────────────────────────────────────── */

function originIdentity(o) {
  if (!o) return null;
  if (o.kind === 'field' || o.kind === 'stack') return o.kind + ':' + (o.location && o.location.key || '');
  if (o.kind === 'global') return 'global:' + String(o.address);
  if (o.kind === 'argument') return 'arg:' + o.reg;
  if (o.kind === 'constant') return 'const:' + String(o.value);
  if (o.kind === 'call') return 'call:' + String(o.instructionId);
  return null;
}

const originMemo = new WeakMap();
export function originOf(value, active) {
  if (!value) return null;
  if (originMemo.has(value)) return originMemo.get(value);
  const visiting = active || new Set();
  if (visiting.has(value)) return null;
  visiting.add(value);
  const def = value.def;
  let out = null;
  if (def && def.op === OP.LOAD && def.loc) {
    if (def.loc.kind === MK.GLOBAL) out = { kind: 'global', address: def.loc.address, location: def.loc, row: def.row, addressOfInstruction: def.address };
    else out = { kind: def.loc.kind === MK.STACK ? 'stack' : 'field', location: def.loc, row: def.row, address: def.address };
  } else if (def && def.op === OP.CALL) {
    out = { kind: 'call', target: def.extra && def.extra.target != null ? def.extra.target : null,
      instructionId: def.id, row: def.row, address: def.address };
  } else if (def && (def.op === OP.MOV || (def.op === OP.UN && /^(sxt|uxt|fmov)/.test(def.sub || ''))) && def.args[0]) {
    out = originOf(def.args[0].value, visiting);
  } else if (def && def.op === OP.PHI && def.args && def.args.length) {
    const os = def.args.map((a) => originOf(a && a.value, visiting));
    const keys = os.map(originIdentity);
    if (keys[0] && keys.every((k) => k === keys[0])) out = os[0];
  } else if (value.kind === VK.ARG && /^x[0-7]$/.test(String(value.reg || ''))) {
    out = { kind: 'argument', reg: value.reg };
  } else if (value.const != null) {
    out = { kind: 'constant', value: value.const };
  } else if (def) {
    out = { kind: 'computed', op: def.op, sub: def.sub || null, row: def.row, address: def.address };
  }
  visiting.delete(value);
  originMemo.set(value, out);
  return out;
}

/** Build Semantic IR with all public safety/value annotations. */
export function buildIR(model, opts) {
  const ir = buildCoreIR(model, normalizedOptions(model, opts));
  if (!ir) return null;
  promoteResolvedGlobals(ir);
  hardenUnknownStores(ir);
  annotateValueRanges(ir);
  branchConstraints(ir);
  return ir;
}

const irCache = new WeakMap();
export function irFor(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return null;
  const cacheable = opts == null || Object.keys(opts).length === 0;
  const mode = getSemanticMigrationMode();
  const byMode = cacheable ? irCache.get(model) : null;
  if (byMode?.has(mode)) return byMode.get(mode);
  let ir = null;
  try { ir = buildIR(model, opts); } catch { ir = null; }
  if (cacheable) {
    const next = byMode ?? new Map();
    next.set(mode, ir);
    if (!byMode) irCache.set(model, next);
  }
  return ir;
}

/* ── RMW query using canonical pointer provenance ───────────── */

function classifyUpdate(chain) {
  const ops = chain.map((c) => (c.op === OP.BIN ? c.sub : c.op));
  if (ops.includes('add')) return 'add';
  if (ops.includes('sub')) return 'sub';
  if (ops.includes('mul')) return 'mul';
  if (ops.includes('sdiv') || ops.includes('udiv')) return 'div';
  if (ops.includes(OP.SEL)) return 'clamp';
  if (!ops.length) return 'copy';
  return 'other';
}

/**
 * Read/modify/write proof. MOV/PHI/pointer+constant aliases are accepted only
 * when provenance proves must-alias; unknown indexed stores invalidate the path.
 */
export function readModifyWrite(ir) {
  if (!ir || !ir.instructions) return [];
  const out = [];
  const seen = new Set();

  for (const r of coreReadModifyWrite(ir)) {
    if (!r || !r.load || !r.store || unknownStoreBetween(ir, r.load, r.store)) continue;
    const key = r.load.id + '>' + r.store.id;
    seen.add(key);
    out.push(r);
  }

  for (const store of ir.instructions) {
    if (store.op !== OP.STORE || !store.loc) continue;
    const written = store.args && store.args[0] && store.args[0].value;
    if (!written) continue;

    const chain = [];
    const visited = new Set();
    const work = [written];
    let load = null;
    while (work.length && chain.length < 40) {
      const v = work.pop();
      if (!v || visited.has(v.id)) continue;
      visited.add(v.id);
      const def = v.def;
      if (!def) continue;
      chain.push(def);
      if (def.op === OP.LOAD) {
        if (mustAlias(def.loc, store.loc) && !unknownStoreBetween(ir, def, store)) load = def;
        continue;
      }
      for (const a of def.args || []) if (a && a.value) work.push(a.value);
    }
    if (!load) continue;
    // The public provenance fallback must not resurrect a def-use RMW
    // across a Memory-SSA clobber. Core Memory SSA is the semantic truth.
    if (!store.memDef || store.memDef.prev !== load.memUse) continue;
    const key = load.id + '>' + store.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      load,
      store,
      location: store.loc,
      chain: chain.filter((c) => c !== load && c.op !== OP.STORE),
      kind: classifyUpdate(chain),
      canonicalAlias: load.loc && store.loc && load.loc.key !== store.loc.key,
    });
  }

  return out;
}
