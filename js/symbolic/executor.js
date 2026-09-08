/*
 * symbolic/executor.js — bounded light symbolic execution over Semantic IR.
 *
 * It intentionally stops on unsupported semantic operations. The executor does
 * not pretend that an unknown instruction preserved registers/memory.
 */
import { OP, MK, COND, mayAliasProvenance } from '../ir.js';
import { valueBefore } from '../dataflow-semantic.js';
import {
  ByteMemory,
  createByteMemory,
  readCanonicalMemory,
  MEMORY_RESULT_STATUS,
} from './memory/byte-memory.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../semantics/memoryssa/queries.js';
import { TaintStore, taintExpression } from './taint/flow.js';
import { TAINT_STATUS, joinTaint, unknownTaint } from './taint/lattice.js';

export const SYM = Object.freeze({ CONST: 'const', SYMBOL: 'symbol', OP: 'op', ITE: 'ite', UNKNOWN: 'unknown' });

export function symbolic(name, meta) {
  // Caller metadata cannot override the canonical fields that define a symbol
  // expression's semantic identity. Auxiliary metadata (source/index/location)
  // is preserved; `kind` and `name` stay constructor-owned.
  return { ...(meta || {}), kind: SYM.SYMBOL, name: String(name) };
}
export function symbolicArg(index, name) { return symbolic(name || 'arg' + index, { source: 'argument', index }); }
export function symbolicField(location, name) {
  const key = location && (location.key || (location.disp != null ? String(location.disp) : null));
  return symbolic(name || ('field(' + (key || '?') + ')'), { source: 'field', location });
}

function c(value) { return { kind: SYM.CONST, value: BigInt(value) }; }

/*
 * The legacy executor predates the solver-neutral Expr DAG.  ByteMemory is
 * intentionally expression-adapter based so this consumer can retain the
 * legacy public shape while sharing the same byte/alias/budget semantics as
 * the canonical translator.
 */
const LEGACY_MEMORY_EXPRESSION = Object.freeze({
  constant(width, value) {
    const bits = widthOf(width, 8);
    return { ...c(BigInt.asUintN(bits, BigInt(value))), bits };
  },
  unknown(width, reason, detail = null) {
    return { ...unknown(reason, detail), bits: widthOf(width, 8) };
  },
  fresh(width, name, meta = {}) {
    return { ...symbolic(name, meta), bits: widthOf(width, 8) };
  },
  isConstant(value) { return value?.kind === SYM.CONST && typeof value.value === 'bigint'; },
  isUnknown(value) { return value?.kind === SYM.UNKNOWN; },
  constantValue(value) { return value?.kind === SYM.CONST && typeof value.value === 'bigint' ? value.value : null; },
  widthOf(value) {
    if (typeof value?.bits === 'number' && Number.isSafeInteger(value.bits) && value.bits > 0) return value.bits;
    // Legacy argument/field symbols are machine integers even though older
    // callers did not annotate their width.  Keep their 64-bit ABI default so
    // byte stores can preserve symbolic bytes instead of manufacturing a hole.
    return value?.kind === SYM.SYMBOL ? 64 : null;
  },
  extract(value, high, low) {
    if (value?.kind === SYM.CONST) return { ...c((BigInt(value.value) >> BigInt(low)) & ((1n << BigInt(high - low + 1)) - 1n)), bits: high - low + 1 };
    return { kind: SYM.OP, op: `extract[${high}:${low}]`, args: [value], bits: high - low + 1 };
  },
  concat(left, right) {
    if (left?.kind === SYM.CONST && right?.kind === SYM.CONST) {
      const rightBits = typeof right.bits === 'number' ? right.bits : 8;
      return { ...c((BigInt(left.value) << BigInt(rightBits)) | BigInt(right.value)), bits: (left.bits || 8) + rightBits };
    }
    return { kind: SYM.OP, op: 'concat', args: [left, right], bits: (left?.bits || 0) + (right?.bits || 0) };
  },
  structuralKey(value) {
    if (!value) return '?';
    if (value.kind === SYM.CONST) return `const:${value.value}`;
    if (value.kind === SYM.SYMBOL) return `symbol:${value.name}`;
    if (value.kind === SYM.UNKNOWN) return `unknown:${value.reason}`;
    if (value.kind === SYM.OP) return `${value.op}(${(value.args || []).map((arg) => this.structuralKey(arg)).join(',')})`;
    if (value.kind === SYM.ITE) return `ite(${this.structuralKey(value.condition)},${this.structuralKey(value.then)},${this.structuralKey(value.else)})`;
    return JSON.stringify(value);
  },
});

// Bit width is a semantic authority: only primitive finite safe-integer numbers
// may define it. Structured values must not launder into a canonical width via
// Number() coercion (e.g. Number(['8']) === 8).
function widthOf(bits, fallback = 64) {
  if (typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits < 1) return fallback;
  return Math.max(1, Math.min(64, bits));
}
function unknown(reason, detail) { return { kind: SYM.UNKNOWN, reason, detail: detail || null }; }
function op(name, ...args) {
  if (args.every((a) => a && a.kind === SYM.CONST)) {
    const a = args[0].value, b = args[1] && args[1].value;
    try {
      if (name === 'add') return c(a + b);
      if (name === 'sub') return c(a - b);
      if (name === 'and') return c(a & b);
      if (name === 'or' || name === 'orr') return c(a | b);
      if (name === 'xor' || name === 'eor') return c(a ^ b);
      if (name === 'shl') return c(a << b);
      if (name === 'lshr') return c(a >> b);
      if (name === 'mul') return c(a * b);
    } catch { /* symbolic fallback */ }
  }
  return { kind: SYM.OP, op: name, args };
}

function binOp(name, a, b, bits = 64) {
  const width = widthOf(bits);
  if (a && b && a.kind === SYM.CONST && b.kind === SYM.CONST) {
    const av = a.value, bv = b.value;
    try {
      let value;
      if (name === 'add') value = av + bv;
      else if (name === 'sub') value = av - bv;
      else if (name === 'mul') value = av * bv;
      else if (name === 'and') value = av & bv;
      else if (name === 'or' || name === 'orr') value = av | bv;
      else if (name === 'xor' || name === 'eor') value = av ^ bv;
      else if (name === 'shl') value = av << (bv & BigInt(width - 1));
      else if (name === 'lshr') value = BigInt.asUintN(width, av) >> (bv & BigInt(width - 1));
      else if (name === 'ashr') value = BigInt.asIntN(width, av) >> (bv & BigInt(width - 1));
      else return op(name, a, b);
      return c(BigInt.asUintN(width, value));
    } catch { /* symbolic fallback */ }
  }
    if (name === 'shl' || name === 'lshr' || name === 'ashr') {
  const masked = { kind:SYM.OP, op:'and', args:[b, c(BigInt(width - 1))], bits:width };
  return { kind: SYM.OP, op: name, args: [a, masked], bits:width };
}
// Symbolic integer arithmetic is still a fixed-width bitvector. Keep
// that identity even when we cannot fold the operands to constants.
return { kind: SYM.OP, op: name, args: [a, b], bits:width };

}

function cmp(name, a, b, options = {}) {
  const bits = widthOf(options.bits);
  const signed = options.signed === true ? true : options.signed === false ? false : null;
  if (a?.kind === SYM.CONST && b?.kind === SYM.CONST) {
    const au = BigInt.asUintN(bits, a.value), bu = BigInt.asUintN(bits, b.value);
    const av = signed === true ? BigInt.asIntN(bits, au) : au;
    const bv = signed === true ? BigInt.asIntN(bits, bu) : bu;
    const yes = name === '==' ? au === bu : name === '!=' ? au !== bu : name === '<' ? av < bv : name === '<=' ? av <= bv : name === '>' ? av > bv : name === '>=' ? av >= bv : null;
    if (yes != null) return { ...c(yes ? 1n : 0n), boolean:true, bits, signed };
  }
  return { kind: SYM.OP, op: name, args: [a, b], boolean: true, bits, signed };
}
function conditionIdentity(condition) {
  if (condition?.kind === SYM.OP && condition.boolean && ['==', '!=', '<', '<=', '>', '>='].includes(condition.op)) {
    const mode = condition.signed === true ? 's' : condition.signed === false ? 'u' : 'n';
    return `${mode}${condition.bits || 64}:${expressionText(condition)}`;
  }
  return expressionText(condition);
}
function negate(condition) {
  if (!condition) return unknown('missing-condition');
  if (condition.kind === SYM.CONST && condition.boolean) return { ...c(condition.value === 0n ? 1n : 0n), boolean:true };
  const inverse = { '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[condition.op];
  if (condition.kind === SYM.OP && inverse) return { ...condition, op: inverse };
  return { kind: SYM.OP, op: 'not', args: [condition], boolean: true };
}
function constraintAllowed(existing, condition) {
  if (condition?.kind === SYM.CONST && condition.boolean) return condition.value !== 0n;
  const key = conditionIdentity(condition);
  for (const prior of existing || []) {
    if (prior?.kind === SYM.CONST && prior.boolean && prior.value === 0n) return false;
    if (conditionIdentity(negate(prior)) === key) return false;
  }
  return true;
}

export function expressionText(e) {
  if (!e) return '?';
  if (e.kind === SYM.CONST) return e.value.toString();
  if (e.kind === SYM.SYMBOL) return e.name;
  if (e.kind === SYM.UNKNOWN) return 'unknown(' + e.reason + ')';
  if (e.kind === SYM.ITE) return '(' + expressionText(e.condition) + ' ? ' + expressionText(e.then) + ' : ' + expressionText(e.else) + ')';
    if (e.kind === SYM.OP) {
  let body;
  if (e.op === 'not') body = 'not ' + expressionText(e.args[0]);
  else if (e.args.length === 1) body = e.op + '(' + expressionText(e.args[0]) + ')';
  else body = '(' + expressionText(e.args[0]) + ' ' + e.op + ' ' + expressionText(e.args[1]) + ')';
  const bits = typeof e.bits === 'number' ? e.bits : null;
  return Number.isSafeInteger(bits) && bits > 0 ? `i${bits}${body}` : body;
}

  return '?';
}

function cloneState(s) {
  return {
    block: s.block,
    prevBlock: s.prevBlock,
    memory: new Map(s.memory),
    byteMemory: s.byteMemory ? s.byteMemory.clone() : null,
    taint: s.taint ? s.taint.clone() : null,
    values: new Map(s.values),
    constraints: s.constraints.slice(),
    branches: s.branches.slice(),
    touchedFields: s.touchedFields.slice(),
    visits: new Map(s.visits),
    steps: s.steps,
  };
}

function fieldName(opts, loc) {
  const configured = opts && opts.symbolicFields;
  if (configured) {
    const keys = [loc && loc.key, loc && loc.disp != null ? String(loc.disp) : null].filter(Boolean);
    for (const k of keys) {
      if (configured instanceof Map && configured.has(k)) return configured.get(k);
      if (typeof configured === 'object' && Object.prototype.hasOwnProperty.call(configured, k)) return configured[k];
    }
  }
  return null;
}

function argExpr(value, opts) {
  const reg = String(value && value.reg || '');
  const m = /^x([0-7])$/.exec(reg);
  if (!m) return unknown('undefined-entry-register', { reg });
  const index = Number(m[1]);
  const configured = opts && opts.symbolicArgs;
  if (configured && typeof configured === 'object') {
    const v = configured[index] != null ? configured[index] : configured[reg];
    if (typeof v === 'bigint' || typeof v === 'number') return c(v);
    if (typeof v === 'string') return symbolicArg(index, v);
    if (v && typeof v === 'object' && v.kind) return v;
  }
  return symbolicArg(index);
}

function locationKey(loc) {
  if (!loc) return null;
  return loc.key || (loc.kind === MK.GLOBAL && loc.address != null ? 'global:' + loc.address.toString(16) : null);
}

function strictMemoryEnabled(opts = {}) {
  return opts.symbolicMemory === true
    || opts.symbolicMemory instanceof ByteMemory
    || (opts.symbolicMemory && typeof opts.symbolicMemory === 'object' && !Array.isArray(opts.symbolicMemory))
    || opts.strictMemory === true
    || opts.memoryMode === 'byte'
    || opts.memoryModel === 'byte'
    || opts.byteMemory instanceof ByteMemory
    || opts.byteMemory != null
    || opts.memory instanceof ByteMemory
    || (opts.memory != null && typeof opts.memory === 'object')
    || opts.memoryInitial != null
    || opts.memorySsa != null;
}

function memoryWidthBits(inst, fallback = 64) {
  const candidates = [
    inst?.extra?.widthBits,
    inst?.extra?.memoryAccess?.widthBits,
    inst?.widthBits,
    inst?.extra?.size != null ? Number(inst.extra.size) * 8 : null,
    inst?.loc?.size != null ? Number(inst.loc.size) * 8 : null,
    inst?.addr?.size != null ? Number(inst.addr.size) * 8 : null,
    inst?.dst?.bits,
    fallback,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 && candidate % 8 === 0) return candidate;
  }
  return fallback;
}

function memoryEndian(inst, opts = {}) {
  const candidates = [
    inst?.extra?.memoryAccess?.endian,
    inst?.extra?.endian,
    inst?.memoryAccess?.endian,
    inst?.endian,
    opts.memoryEndian,
    opts.endian,
    'little',
  ];
  return candidates.find((candidate) => candidate === 'little' || candidate === 'big') || 'little';
}

function memoryQualifiers(inst) {
  const access = inst?.extra?.memoryAccess ?? inst?.memoryAccess ?? {};
  return {
    volatile: inst?.volatile === true || inst?.extra?.volatile === true || access.volatile === true || access.isVolatile === true,
    atomic: inst?.atomic === true || inst?.extra?.atomic === true || access.atomic === true || access.isAtomic === true,
    barrier: inst?.barrier === true || inst?.extra?.barrier === true || access.barrier === true,
    ordering: inst?.ordering ?? inst?.extra?.ordering ?? access.ordering ?? null,
  };
}

function memoryAliasRelation(inst, opts = {}) {
  const relation = inst?.memoryAliasRelation
    ?? inst?.extra?.aliasRelation
    ?? inst?.extra?.memoryAliasRelation
    ?? opts.memoryAliasRelation
    ?? null;
  return ['must', 'no', 'may', 'unknown'].includes(relation) ? relation : null;
}

function bigintAddress(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[+-]?(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  return null;
}

function memoryAddressExpression(inst, state, ir, opts, memo) {
  const addr = inst?.addr;
  if (addr?.base) {
    let expression = evalValue(addr.base, state, ir, opts, memo, new Set());
    if (addr.index) {
      const index = evalValue(addr.index, state, ir, opts, memo, new Set());
      const scale = typeof addr.scale === 'number' && Number.isSafeInteger(addr.scale) && addr.scale > 0 ? addr.scale : 0;
      const scaled = scale > 0 ? binOp('shl', index, c(BigInt(scale)), widthOf(expression?.bits, 64)) : index;
      expression = binOp('add', expression, scaled, widthOf(expression?.bits, widthOf(index?.bits, 64)));
    }
    const displacement = bigintAddress(addr.disp ?? 0);
    if (displacement != null && displacement !== 0n) {
      expression = binOp('add', expression, c(displacement), widthOf(expression?.bits, 64));
    }
    return expression;
  }
  const location = inst?.loc;
  const concrete = bigintAddress(location?.address);
  if (concrete != null) return c(concrete);
  const key = locationKey(location);
  if (key && location?.kind !== MK.UNKNOWN) return symbolic(`memory:${key}`, { source: 'symbolic-memory-address', location });
  return unknown('unknown-memory-address', { instruction: inst?.id ?? null });
}

function canonicalMemoryLoad(inst, opts = {}) {
  const qualifiers = memoryQualifiers(inst);
  if (qualifiers.volatile || qualifiers.atomic || qualifiers.barrier || qualifiers.ordering != null) {
    return { status: MEMORY_RESULT_STATUS.UNKNOWN, reason: qualifiers.atomic || qualifiers.ordering != null ? 'atomic-memory-barrier' : 'volatile-memory-barrier' };
  }
  const attached = inst?.memoryForwarding ?? null;
  const context = canonicalMemoryForwardingContextForLoad(attached, inst,
    inst?.memoryForwardingContext ?? inst?.extra?.memoryForwardingContext ?? opts.memoryForwardingContext ?? {});
  if (attached != null) {
    if (isCanonicalExactMemoryForwarding(attached, context) && attached.value != null) {
      return { status: MEMORY_RESULT_STATUS.EXACT, value: attached.value, widthBits: Number(attached.widthBits), endian: attached.endian, fact: attached };
    }
    return { status: MEMORY_RESULT_STATUS.UNKNOWN, reason: attached.reason || 'missing-canonical-memory-proof', fact: attached };
  }
  const memorySsa = opts.memorySsa ?? null;
  if (!memorySsa) return null;
  let useId = inst?.memorySsaUseId
    ?? inst?.extra?.memorySsaUseId
    ?? inst?.memorySsaUse?.id
    ?? inst?.extra?.memorySsaUse?.id
    ?? null;
  const byInstruction = opts.memorySsaUseByInstruction ?? opts.memorySsaUses ?? null;
  if (useId == null && byInstruction instanceof Map) useId = byInstruction.get(inst?.id) ?? null;
  if (useId == null && byInstruction && typeof byInstruction === 'object') useId = byInstruction[inst?.id] ?? null;
  if (useId == null) {
    const candidates = (memorySsa.uses || []).filter((use) => String(use?.sourceEntityId ?? '') === String(inst?.id ?? ''));
    if (candidates.length === 1) useId = candidates[0].id;
  }
  if (useId == null) return { status: MEMORY_RESULT_STATUS.UNKNOWN, reason: 'memoryssa-use-identity-missing' };
  const queried = readCanonicalMemory(memorySsa, useId, {
    context,
    signal: opts.signal,
    budget: opts.memoryBudget,
    maxIterations: opts.memoryMaxIterations,
    ir: opts.memoryIr,
    cfg: opts.memoryCfg,
    sourceByEntityId: opts.sourceByEntityId,
    widthBits: memoryWidthBits(inst),
  });
  if (queried.exact && queried.fact) {
    return { status: MEMORY_RESULT_STATUS.EXACT, value: queried.fact.value, widthBits: Number(queried.fact.widthBits), endian: queried.fact.endian, fact: queried.fact };
  }
  return { status: queried.status || MEMORY_RESULT_STATUS.UNKNOWN, reason: queried.expression?.reason || queried.fact?.reason || 'canonical-memory-forwarding-not-exact', fact: queried.fact };
}

function phiValue(inst, state) {
  if (!inst || !inst.incoming || !inst.incoming.length) return null;
  const hit = inst.incoming.find((x) => x.from === state.prevBlock);
  return hit ? hit.value : (inst.incoming.length === 1 ? inst.incoming[0].value : null);
}

function loadExpression(inst, state, opts) {
  if (!inst || !inst.loc) return unknown('missing-load-location', { instruction: inst && inst.id });
  const key = locationKey(inst.loc);
  if (key && state.memory.has(key)) {
    const remembered = state.memory.get(key);
    return remembered && remembered.value ? remembered.value : remembered;
  }
  if (inst.loc.kind === MK.UNKNOWN) return unknown('unknown-load-alias', { instruction: inst.id });
  return symbolicField(inst.loc, fieldName(opts, inst.loc));
}

function strictLoadExpression(inst, state, ir, opts, memo) {
  const canonical = canonicalMemoryLoad(inst, opts);
  if (canonical) {
    if (canonical.status === MEMORY_RESULT_STATUS.EXACT && canonical.value != null) {
      return LEGACY_MEMORY_EXPRESSION.constant(canonical.widthBits || memoryWidthBits(inst), canonical.value);
    }
    return unknown(canonical.reason || 'canonical-memory-forwarding-not-exact', {
      instruction: inst?.id ?? null,
      status: canonical.status,
    });
  }
  if (!state.byteMemory) return unknown('symbolic-memory-state-missing', { instruction: inst?.id ?? null });
  const widthBits = memoryWidthBits(inst, 8);
  const address = memoryAddressExpression(inst, state, ir, opts, memo);
  const loaded = state.byteMemory.read(address, widthBits, {
    endian: memoryEndian(inst, opts),
    aliasRelation: memoryAliasRelation(inst, opts),
    ...memoryQualifiers(inst),
  });
  if (loaded.status === MEMORY_RESULT_STATUS.EXACT && loaded.expression) return loaded.expression;
  return unknown(loaded.reason || `symbolic-memory-${loaded.status}`, loaded.detail || {
    instruction: inst?.id ?? null,
    status: loaded.status,
  });
}

function rememberLegacyStore(inst, state, value) {
  if (!inst?.loc) return;
  const key = locationKey(inst.loc);
  if (!key) return;
  for (const [knownKey, remembered] of Array.from(state.memory.entries())) {
    const knownLocation = remembered && remembered.location ? remembered.location : null;
    if (!knownLocation || mayAliasProvenance(knownLocation, inst.loc)) state.memory.delete(knownKey);
  }
  state.memory.set(key, { location: inst.loc, value });
}

function strictStore(inst, state, ir, opts, memo) {
  if (!state.byteMemory) return { status: MEMORY_RESULT_STATUS.UNKNOWN, reason: 'symbolic-memory-state-missing' };
  const widthBits = memoryWidthBits(inst, 8);
  const address = memoryAddressExpression(inst, state, ir, opts, memo);
  const value = inst.args?.[0]
    ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set())
    : unknown('missing-store-value');
  const stored = state.byteMemory.store(address, value, {
    widthBits,
    endian: memoryEndian(inst, opts),
    aliasRelation: memoryAliasRelation(inst, opts),
    ...memoryQualifiers(inst),
  });
  if (stored.status === MEMORY_RESULT_STATUS.EXACT) rememberLegacyStore(inst, state, value);
  return stored;
}

function taintEnabled(opts = {}) {
  return opts.taint === true
    || opts.taint instanceof TaintStore
    || opts.taint != null
    || opts.taintSources != null
    || opts.taintSinks != null
    || opts.sources != null
    || opts.sinks != null
    || opts.sanitizers != null;
}

function initialTaintStore(opts, cancelled) {
  if (opts?.taint instanceof TaintStore) {
    const copy = opts.taint.clone();
    copy.signal = opts.signal ?? copy.signal;
    copy.isCancelled = cancelled;
    return copy;
  }
  const config = opts?.taint && typeof opts.taint === 'object' && !Array.isArray(opts.taint) ? opts.taint : {};
  return new TaintStore({
    ...config,
    maxLatticeValues: opts?.maxTaintLatticeValues ?? config.maxLatticeValues,
    maxFlowEdges: opts?.maxTaintFlowEdges ?? config.maxFlowEdges,
    maxWorkItems: opts?.maxTaintWorkItems ?? config.maxWorkItems,
    maxUpdatesPerValue: opts?.maxTaintUpdatesPerValue ?? config.maxUpdatesPerValue,
    maxSources: opts?.maxTaintSources ?? config.maxSources,
    maxSinks: opts?.maxTaintSinks ?? config.maxSinks,
    maxEmittedRecords: opts?.maxTaintEmittedRecords ?? config.maxEmittedRecords,
    signal: opts?.signal ?? config.signal ?? null,
    isCancelled: cancelled,
  });
}

function taintOptions(opts, state) {
  return {
    store: state.taint,
    sourceByValueId: opts?.taintSourcesByValueId ?? opts?.sourceByValueId,
    sourceLabels: opts?.taintSourceLabels ?? opts?.sourceLabels,
    sources: opts?.taintSources ?? opts?.sources,
    treatArgumentsAsSources: opts?.treatArgumentsAsSources === true,
    autoSourceMetadata: opts?.autoSourceMetadata !== false,
  };
}

function recordTaint(inst, value, state, opts) {
  if (!state.taint || !inst?.dst) return null;
  let taint = taintExpression(value, taintOptions(opts, state));
  const direct = opts?.taintSourcesByValueId?.[inst.dst.id]
    ?? (opts?.taintSourcesByValueId instanceof Map ? opts.taintSourcesByValueId.get(inst.dst.id) : null)
    ?? opts?.taintSources?.[inst.id]
    ?? (opts?.taintSources instanceof Map ? opts.taintSources.get(inst.id) : null);
  if (direct != null) {
    const sourceResult = state.taint.source(inst.dst, direct, { provenance: { instructionId: inst.id } });
    taint = sourceResult.taint || taint;
  }
  state.taint.setValue(inst.dst, taint, { provenance: { instructionId: inst.id } });
  return taint;
}

function recordMemoryTaint(inst, value, state, ir, opts, memo, kind) {
  if (!state.taint) return null;
  const address = memoryAddressExpression(inst, state, ir, opts, memo);
  const addressTaint = taintExpression(address, taintOptions(opts, state));
  const widthBits = memoryWidthBits(inst, 8);
  if (kind === 'store') {
    const sourceValue = inst?.args?.[0]?.value ?? value;
    const valueTaint = taintExpression(sourceValue, taintOptions(opts, state));
    return state.taint.storeMemory(address, valueTaint, widthBits, {
      endian: memoryEndian(inst, opts),
      aliasRelation: memoryAliasRelation(inst, opts),
      addressTaint,
    });
  }
  return state.taint.loadMemory(address, widthBits, {
    endian: memoryEndian(inst, opts),
    aliasRelation: memoryAliasRelation(inst, opts),
    addressTaint,
  });
}

function evalValue(value, state, ir, opts, memo, active) {
  if (!value) return unknown('missing-value');
  if (state.values.has(value.id)) return state.values.get(value.id);
  const stateKey = value.id + '@' + state.prevBlock + '@' + state.block;
  if (memo.has(stateKey)) return memo.get(stateKey);
  if (active.has(value.id)) return unknown('symbolic-cycle', { value: value.id });
  active.add(value.id);
  let out = null;
  if (value.const != null) out = c(value.const);
  else if (value.kind === 'arg') out = argExpr(value, opts);
  else if (!value.def) out = unknown('value-without-definition', { value: value.id });
  else {
    const d = value.def;
    if (d.op === OP.MOV && d.args[0]) out = evalValue(d.args[0].value, state, ir, opts, memo, active);
    else if (d.op === OP.PHI) {
      const chosen = phiValue(d, state);
      out = chosen ? evalValue(chosen, state, ir, opts, memo, active) : unknown('ambiguous-phi', { instruction: d.id });
    } else if (d.op === OP.BIN && d.args.length >= 2 && ['add', 'sub', 'and', 'or', 'xor', 'orr', 'eor', 'shl', 'lshr', 'ashr', 'mul'].includes(d.sub)) {
      out = binOp(d.sub,
        evalValue(d.args[0].value, state, ir, opts, memo, active),
        evalValue(d.args[1].value, state, ir, opts, memo, active),
        widthOf(d.dst?.bits, widthOf(value?.bits, 64)));
    } else if (d.op === OP.UN && d.args[0] && /^(sxt|uxt|fmov|neg)/.test(d.sub || '')) {
      const x = evalValue(d.args[0].value, state, ir, opts, memo, active);
      const toBits = widthOf(d.dst?.bits, widthOf(value?.bits, 64));
      const m = /^(sxt|uxt)(8|16|32|64)?/.exec(d.sub || '');
      if (d.sub === 'neg') out = binOp('sub', c(0n), x, toBits);
      else if (m) {
        // m[2] comes from the canonical op-name grammar, not decoder evidence.
        const fromBits = m[2] != null
          ? Number(m[2])
          : widthOf(d.args[0].bits, widthOf(d.args[0].value?.bits, toBits));
        if (x.kind === SYM.CONST) {
          const narrowed = m[1] === 'sxt' ? BigInt.asIntN(fromBits, x.value) : BigInt.asUintN(fromBits, x.value);
          out = c(BigInt.asUintN(toBits, narrowed));
        } else out = { kind:SYM.OP, op:m[1] === 'sxt' ? 'sext' : 'zext', args:[x], fromBits, toBits };
      } else out = x;
    } else if (d.op === OP.LOAD && d.loc) {
      out = strictMemoryEnabled(opts || {})
        ? strictLoadExpression(d, state, ir, opts || {}, memo)
        : loadExpression(d, state, opts);
    } else if (d.op === OP.SEL && d.args.length >= 2) {
      const condition = conditionFromFlags(d, state, ir, opts, memo, active);
      out = {
        kind: SYM.ITE,
        condition,
        then: evalValue(d.args[0].value, state, ir, opts, memo, active),
        else: evalValue(d.args[1].value, state, ir, opts, memo, active),
      };
    } else if (d.op === OP.ADDR && value.const != null) out = c(value.const);
    else out = unknown('unsupported-value-op', { op: d.op, sub: d.sub, instruction: d.id });
  }
  active.delete(value.id);
  memo.set(stateKey, out);
  return out;
}

function conditionFromCmp(cmpInst, condCode, state, ir, opts, memo, active) {
  if (!cmpInst || cmpInst.op !== OP.CMP || cmpInst.args.length < 2) return unknown('unsupported-compare');
  const info = COND[condCode];
  if (!info || !info.op) return unknown('unsupported-condition', { condition: condCode });
  const a = evalValue(cmpInst.args[0].value, state, ir, opts, memo, active);
  const b = evalValue(cmpInst.args[1].value, state, ir, opts, memo, active);
  const bits = widthOf(
    cmpInst.args[0]?.bits,
    widthOf(cmpInst.args[0]?.value?.bits,
      widthOf(cmpInst.args[1]?.bits,
        widthOf(cmpInst.args[1]?.value?.bits, 64))));
  return cmp(info.op, a, b, { bits, signed: info.signed });
}

function conditionFromFlags(inst, state, ir, opts, memo, active) {
  // Semantic-v2 compatibility carries the comparison result explicitly as a
  // value whose defining instruction is CMP. Prefer that architecture-neutral
  // proof. SEL has two data arms before its flags carrier, while CBR keeps its
  // flags carrier at the last argument; choosing the first CMP would let a
  // data arm hijack the condition. The legacy nzcv register identity remains
  // a fallback for old IR that does not retain the defining CMP.
  const args = inst.args || [];
  const positionalCarrier = inst.op === OP.SEL ? args[2]
    : inst.op === OP.CBR ? args.at(-1)
      : null;
  const carrierArg = positionalCarrier?.value?.def?.op === OP.CMP
    ? positionalCarrier
    : args.find((a) => a?.value?.reg === 'nzcv');
  const carrier = carrierArg?.value ?? null;
  return conditionFromCmp(carrier?.def, inst.cond, state, ir, opts, memo, active);
}

function branchCondition(inst, state, ir, opts, memo) {
  const kind = inst.extra && inst.extra.kind;
  if ((kind === 'cbz' || kind === 'cbnz') && inst.args[0]) {
    const a = evalValue(inst.args[0].value, state, ir, opts, memo, new Set());
    return cmp(kind === 'cbz' ? '==' : '!=', a, c(0n));
  }
  if (kind === 'tbz' || kind === 'tbnz') {
    const a = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : unknown('missing-test-value');
    const bit = BigInt(inst.extra && inst.extra.bit != null ? inst.extra.bit : 0);
    const masked = op('and', op('lshr', a, c(bit)), c(1n));
    return cmp(kind === 'tbz' ? '==' : '!=', masked, c(0n));
  }
  return conditionFromFlags(inst, state, ir, opts, memo, new Set());
}

function addressBlockMap(ir) {
  const m = new Map();
  for (const block of ir.blocks || []) {
    let first = null;
    for (const inst of block.insts || []) {
      if (inst.address != null && (first == null || inst.row < first.row)) first = inst;
    }
    if (first && first.address != null) m.set(first.address.toString(), block.index);
  }
  return m;
}

function successorsForBranch(ir, block, inst, addressMap) {
  const succ = (block && block.succ || []).slice();
  const target = inst.extra && inst.extra.target != null ? addressMap.get(inst.extra.target.toString()) : null;
  if (inst.op === OP.BR) return { target: target == null ? null : target, fallthrough: null };
  if (inst.op !== OP.CBR) return { target: null, fallthrough: null };
  let fallthrough = succ.find((b) => b !== target);
  if (target == null && succ.length === 2) return { target: null, fallthrough: null };
  if (fallthrough == null && succ.length === 1 && target !== succ[0]) fallthrough = succ[0];
  return { target, fallthrough: fallthrough == null ? null : fallthrough };
}

function stopResult(state, reason, inst) {
  return {
    status: 'unknown',
    reason,
    at: inst ? { row: inst.row, address: inst.address, op: inst.op, sub: inst.sub || null } : null,
    constraints: state.constraints.slice(),
    constraintText: state.constraints.map(expressionText),
    takenBranches: state.branches.slice(),
    touchedFields: state.touchedFields.slice(),
    memory: state.byteMemory ? state.byteMemory.stats() : null,
    taint: state.taint ? state.taint.stats() : null,
    steps: state.steps,
    returnValue: null,
  };
}

function legacyMemoryValue(value, active = new Set()) {
  if (value == null) return null;
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))) {
    return LEGACY_MEMORY_EXPRESSION.constant(8, value);
  }
  if (typeof value !== 'object') return null;
  if (active.has(value)) return LEGACY_MEMORY_EXPRESSION.unknown(8, 'symbolic-memory-expression-cycle');
  if (value.kind === SYM.CONST) {
    return LEGACY_MEMORY_EXPRESSION.constant(value.bits || value.sort?.width || 8, value.value);
  }
  if (value.kind === SYM.SYMBOL || value.kind === 'fresh_symbol') {
    return LEGACY_MEMORY_EXPRESSION.fresh(value.bits || value.sort?.width || 8, value.name || value.symbolId || 'memory_symbol', value.meta || {});
  }
  if (value.kind === SYM.UNKNOWN || value.kind === 'unknown_semantic') {
    return LEGACY_MEMORY_EXPRESSION.unknown(value.bits || value.sort?.width || 8, value.reason || 'symbolic-memory-unknown', value.detail || null);
  }
  active.add(value);
  let converted = null;
  if (value.kind === SYM.OP || value.kind === 'unary' || value.kind === 'binary') {
    const args = value.args || [value.left, value.right].filter((item) => item != null);
    const convertedArgs = args.map((item) => legacyMemoryValue(item, active));
    converted = convertedArgs.some((item) => !item)
      ? null
      : { kind: SYM.OP, op: value.op || 'memory-expression', args: convertedArgs, bits: value.bits || value.sort?.width || 8 };
  } else if (value.kind === 'extract') {
    const arg = legacyMemoryValue(value.arg, active);
    converted = arg ? LEGACY_MEMORY_EXPRESSION.extract(arg, value.high, value.low) : null;
  } else if (value.kind === 'concat') {
    const left = legacyMemoryValue(value.left, active);
    const right = legacyMemoryValue(value.right, active);
    converted = left && right ? LEGACY_MEMORY_EXPRESSION.concat(left, right) : null;
  }
  active.delete(value);
  return converted || LEGACY_MEMORY_EXPRESSION.unknown(value.sort?.width || value.bits || 8, 'symbolic-memory-expression-unsupported');
}

function executionBudget(value, fallback, min, max, name) {
  // Execution budgets are resource authorities. Only a primitive finite safe
  // integer may define one; structured values must not coerce into a regular
  // limit (Number(['1']) === 1). null/undefined still take the fallback.
  const n = value == null ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new TypeError(`${name} must be a finite safe integer`);
  }
  if (n < min) return min;
  return Math.min(n, max);
}

function initialByteMemory(opts, cancelled) {
  const supplied = opts?.byteMemory instanceof ByteMemory
    ? opts.byteMemory
    : opts?.symbolicMemory instanceof ByteMemory
      ? opts.symbolicMemory
    : opts?.memory instanceof ByteMemory
      ? opts.memory
      : null;
  if (supplied) {
    if (supplied.expression === LEGACY_MEMORY_EXPRESSION) {
      const copy = supplied.clone();
      copy.signal = opts?.signal ?? copy.signal;
      copy.isCancelled = cancelled;
      return copy;
    }
    const snapshot = supplied.snapshot();
    const initial = new Map();
    for (const cell of snapshot.cells || []) {
      const legacy = legacyMemoryValue(cell.value);
      if (legacy) initial.set(BigInt(cell.address), legacy);
    }
    const copy = createByteMemory({
      expression: LEGACY_MEMORY_EXPRESSION,
      initial,
      maxConcreteBytes: supplied.maxConcreteBytes,
      maxSymbolicCells: supplied.maxSymbolicCells,
      maxStoreHistory: supplied.maxStoreHistory,
      maxAliasForks: supplied.maxAliasForks,
      signal: opts?.signal ?? supplied.signal ?? null,
      isCancelled: cancelled,
    });
    for (const cell of snapshot.symbolicCells || []) {
      const legacy = legacyMemoryValue(cell.value);
      if (legacy) copy.symbolicCells.set(cell.key, legacy);
    }
    copy.tier = snapshot.tier;
    copy.uncertain = snapshot.uncertain === true || copy.uncertain;
    copy._unknownReason = snapshot.reason ?? copy._unknownReason;
    copy.aliasForks = Number.isSafeInteger(snapshot.stats?.aliasForks)
      ? snapshot.stats.aliasForks
      : (Number.isSafeInteger(supplied.aliasForks) ? supplied.aliasForks : 0);
    copy.storeHistory = Array.isArray(supplied.storeHistory) ? supplied.storeHistory.slice() : [];
    return copy;
  }
  let config = {};
  if (opts?.byteMemory && typeof opts.byteMemory === 'object' && !Array.isArray(opts.byteMemory)) config = { ...opts.byteMemory };
  if (opts?.symbolicMemory && typeof opts.symbolicMemory === 'object' && !(opts.symbolicMemory instanceof ByteMemory) && !Array.isArray(opts.symbolicMemory)) {
    config = { ...config, ...opts.symbolicMemory };
  }
  if (opts?.memory && typeof opts.memory === 'object' && !(opts.memory instanceof Map) && !Array.isArray(opts.memory)) {
    config = { ...config, ...opts.memory };
  }
  const initial = config.initial ?? config.bytes ?? opts?.memoryInitial
    ?? (opts?.byteMemory instanceof Map ? opts.byteMemory : null)
    ?? (opts?.symbolicMemory instanceof Map ? opts.symbolicMemory : null)
    ?? (opts?.memory instanceof Map || (opts?.memory && typeof opts.memory === 'object' && !Array.isArray(opts.memory)) ? opts.memory : null);
  return createByteMemory({
    ...config,
    expression: LEGACY_MEMORY_EXPRESSION,
    ...(initial != null ? { initial } : {}),
    signal: opts?.signal ?? config.signal ?? null,
    isCancelled: cancelled,
  });
}

/** Explore bounded Semantic IR paths. */
export function symbolicExecute(ir, opts) {
  const startedAt = Date.now();
  const cancelledFn = opts?.isCancelled ?? (() => false);
  if (typeof cancelledFn !== 'function') throw new TypeError('isCancelled must be a function');
  if (!ir || !ir.blocks || !ir.blocks.length) return {
    paths: [], truncated: false, engine: 'semantic-ir-symbolic',
  };
  const maxPaths = executionBudget(opts && opts.maxPaths, 16, 1, 64, 'maxPaths');
  const maxSteps = executionBudget(opts && opts.maxSteps, 2000, 8, 20000, 'maxSteps');
  const maxBranches = executionBudget(opts && opts.maxBranches, 32, 1, 256, 'maxBranches');
  const maxBlockVisits = executionBudget(opts && opts.maxBlockVisits, 3, 1, 32, 'maxBlockVisits');
  const timeoutMs = executionBudget(opts && opts.timeoutMs, 250, 10, 5000, 'timeoutMs');
  const signal = opts && opts.signal || null;
  const cancelled = () => !!(signal && signal.aborted) || cancelledFn();
  const deadline = Date.now() + timeoutMs;
  const addressMap = addressBlockMap(ir);
  const byteMemoryEnabled = strictMemoryEnabled(opts || {});
  const taintEnabledForExecution = taintEnabled(opts || {});
  const queue = [{
    block: ir.entry || 0,
    prevBlock: -1,
    memory: new Map(),
    byteMemory: byteMemoryEnabled ? initialByteMemory(opts || {}, cancelled) : null,
    taint: taintEnabledForExecution ? initialTaintStore(opts || {}, cancelled) : null,
    values: new Map(),
    constraints: [],
    branches: [],
    touchedFields: [],
    visits: new Map(),
    steps: 0,
  }];
  const paths = [];
  let branchCount = 0;
  let truncated = false;
  let maxBlockVisitsObserved = 0;

  while (queue.length && paths.length < maxPaths) {
    if (cancelled() || Date.now() > deadline) { truncated = true; break; }
    const state = queue.shift();
    if (state.steps > maxSteps) { paths.push(stopResult(state, 'step-budget')); continue; }
    const n = (state.visits.get(state.block) || 0) + 1;
    state.visits.set(state.block, n);
    maxBlockVisitsObserved = Math.max(maxBlockVisitsObserved, n);
    if (n > maxBlockVisits) { paths.push(stopResult(state, 'loop-budget')); continue; }
    const block = ir.blocks[state.block];
    if (!block) { paths.push(stopResult(state, 'missing-block')); continue; }
    const memo = new Map();
    let transferred = false;

        // PHIs are parallel assignments at block entry. Evaluate every
  // incoming value against the previous iteration's state, then commit
  // the new PHI values together. Reusing the cached destination here
  // would freeze a loop-carried value after its first visit.
  const phiUpdates = [];
  for (const phi of block.phis || []) {
    if (!phi.dst) continue;
    const chosen = phiValue(phi, state);
    const value = chosen
      ? evalValue(chosen, state, ir, opts, memo, new Set())
      : unknown('ambiguous-phi', { instruction: phi.id });
    phiUpdates.push([phi.dst.id, value]);
  }
  for (const [id, value] of phiUpdates) state.values.set(id, value);
  if (state.taint) {
    for (const [id, value] of phiUpdates) {
      state.taint.setValue({ id }, taintExpression(value, taintOptions(opts || {}, state)), { provenance: { phi: id } });
    }
  }


    for (const inst of block.insts || []) {
      state.steps++;
      if (state.steps > maxSteps) { paths.push(stopResult(state, 'step-budget', inst)); transferred = true; break; }

      if (inst.op === OP.LOAD) {
        if (!inst.dst || (!inst.loc && !inst.addr)) {
          paths.push(stopResult(state, 'unsupported-load', inst)); transferred = true; break;
        }
        const value = byteMemoryEnabled
          ? strictLoadExpression(inst, state, ir, opts || {}, memo)
          : loadExpression(inst, state, opts);
        if (value.kind === SYM.UNKNOWN) {
          paths.push(stopResult(state, value.reason, inst)); transferred = true; break;
        }
        state.values.set(inst.dst.id, value);
        if (state.taint) {
          const direct = recordTaint(inst, value, state, opts || {});
          const memory = recordMemoryTaint(inst, value, state, ir, opts || {}, memo, 'load');
          state.taint.setValue(inst.dst, joinTaint(direct, memory), { provenance: { instructionId: inst.id, kind: 'load' } });
        }
        continue;
      }
      if (inst.op === OP.STORE) {
        if (!byteMemoryEnabled && (!inst.loc || inst.loc.kind === MK.UNKNOWN)) {
          paths.push(stopResult(state, 'unknown-store-alias', inst)); transferred = true; break;
        }
        if (byteMemoryEnabled) {
          const stored = strictStore(inst, state, ir, opts || {}, memo);
          if (stored.status !== MEMORY_RESULT_STATUS.EXACT) {
            paths.push(stopResult(state, stored.reason || `symbolic-memory-${stored.status}`, inst)); transferred = true; break;
          }
        }
        const key = locationKey(inst.loc);
        const value = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : unknown('missing-store-value');
        if (!byteMemoryEnabled) rememberLegacyStore(inst, state, value);
        if (state.taint) recordMemoryTaint(inst, value, state, ir, opts || {}, memo, 'store');
        if (inst.loc?.kind === MK.FIELD || inst.loc?.kind === MK.GLOBAL) {
          state.touchedFields.push({ key, location: inst.loc, row: inst.row, address: inst.address, value, valueText: expressionText(value) });
        }
        continue;
      }
      if (inst.op === OP.CALL) {
        paths.push(stopResult(state, 'unsupported-call', inst)); transferred = true; break;
      }
      if (inst.op === OP.UNKNOWN || inst.op === OP.CLOBBER) {
        paths.push(stopResult(state, 'unsupported-instruction', inst)); transferred = true; break;
      }
      if (inst.op === OP.RET) {
        const explicit = inst.args[0]?.value || null;
        let candidate = explicit;
        let inferredReturn = false;
        if (!candidate) {
          const terminal = valueBefore(ir, inst, 'x0');
          // Keep #130's ABI truth intact: RET has no implicit x0 operand. The
          // symbolic layer may expose a local terminal x0 expression only when
          // it was actually defined inside this function and evaluates to a
          // non-constant expression. This preserves field/dataflow experiments
          // while refusing the weakest `mov x0,#imm; ret` void-like ambiguity.
          if (terminal?.def && terminal.kind !== 'arg' && terminal.def.row != null && inst.row != null && terminal.def.row < inst.row) {
            const evaluated = evalValue(terminal, state, ir, opts, memo, new Set());
            if (evaluated && evaluated.kind !== SYM.UNKNOWN && evaluated.kind !== SYM.CONST) {
              candidate = terminal; inferredReturn = true;
            }
          }
        }
        const value = candidate ? evalValue(candidate, state, ir, opts, memo, new Set()) : null;
        const returnTaint = state.taint
          ? (candidate && state.taint.getValue(candidate)
            ? state.taint.getValue(candidate)
            : (value ? taintExpression(value, taintOptions(opts || {}, state)) : unknownTaint('missing-return-value')))
          : null;
        paths.push({
          status: value && value.kind === SYM.UNKNOWN ? 'unknown' : 'complete',
          reason: value && value.kind === SYM.UNKNOWN ? value.reason : null,
          returnValue: value,
          returnText: expressionText(value),
          returnInferred: inferredReturn,
          constraints: state.constraints.slice(),
          constraintText: state.constraints.map(expressionText),
          takenBranches: state.branches.slice(),
          touchedFields: state.touchedFields.slice(),
          memory: state.byteMemory ? state.byteMemory.stats() : null,
          taint: state.taint ? state.taint.stats() : null,
          steps: state.steps,
          returnTaint,
        });
        transferred = true;
        break;
      }
      if (inst.op === OP.CBR) {
        if (++branchCount > maxBranches) { paths.push(stopResult(state, 'branch-budget', inst)); transferred = true; break; }
        const cond = branchCondition(inst, state, ir, opts, memo);
        if (cond.kind === SYM.UNKNOWN) { paths.push(stopResult(state, cond.reason, inst)); transferred = true; break; }
        const next = successorsForBranch(ir, block, inst, addressMap);
        if (next.target == null || next.fallthrough == null) { paths.push(stopResult(state, 'unresolved-branch-target', inst)); transferred = true; break; }
        const inverse = negate(cond);
        if (constraintAllowed(state.constraints, cond)) {
          const yes = cloneState(state);
          if (yes.taint) yes.taint.branch(taintExpression(cond, taintOptions(opts || {}, yes)), { instructionId: inst.id, taken: true });
          yes.prevBlock = state.block; yes.block = next.target;
          yes.constraints.push(cond);
          yes.branches.push({ row: inst.row, address: inst.address, taken: true, condition: expressionText(cond) });
          queue.push(yes);
        }
        if (constraintAllowed(state.constraints, inverse)) {
          const no = cloneState(state);
          if (no.taint) no.taint.branch(taintExpression(inverse, taintOptions(opts || {}, no)), { instructionId: inst.id, taken: false });
          no.prevBlock = state.block; no.block = next.fallthrough;
          no.constraints.push(inverse);
          no.branches.push({ row: inst.row, address: inst.address, taken: false, condition: expressionText(inverse) });
          queue.push(no);
        }
        transferred = true;
        break;
      }
      if (inst.op === OP.BR) {
        const next = successorsForBranch(ir, block, inst, addressMap);
        if (next.target == null) { paths.push(stopResult(state, 'unresolved-branch-target', inst)); transferred = true; break; }
        state.prevBlock = state.block; state.block = next.target; queue.push(state);
        transferred = true;
        break;
      }
    }

    if (!transferred) {
      const succ = block.succ || [];
      if (succ.length === 1) {
        state.prevBlock = state.block; state.block = succ[0]; queue.push(state);
      } else if (!succ.length) paths.push(stopResult(state, 'fell-off-function'));
      else paths.push(stopResult(state, 'ambiguous-control-flow'));
    }
  }
  if (queue.length) truncated = true;
  const maxPathSteps = paths.reduce((max, path) => Math.max(max, Number(path.steps) || 0), 0);
  const memoryStats = paths.map((path) => path.memory).filter(Boolean);
  return {
    paths,
    truncated,
    engine: 'semantic-ir-symbolic',
    memoryModel: byteMemoryEnabled ? 'symbolic-byte-memory-v1' : 'legacy-location-memory',
    metrics: {
      paths: paths.length,
      stepsPerPath: maxPathSteps,
      branches: branchCount,
      blockVisitsPerBlock: maxBlockVisitsObserved,
      concreteMemoryBytes: memoryStats.reduce((max, stats) => Math.max(max, stats.concreteMemoryBytes || 0), 0),
      symbolicMemoryCells: memoryStats.reduce((max, stats) => Math.max(max, stats.symbolicMemoryCells || 0), 0),
      storeHistoryEntries: memoryStats.reduce((max, stats) => Math.max(max, stats.storeHistoryEntries || 0), 0),
      aliasForks: memoryStats.reduce((max, stats) => Math.max(max, stats.aliasForks || 0), 0),
      wallClock: Date.now() - startedAt,
    },
  };
}
