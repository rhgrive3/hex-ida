/** Taint propagation over canonical Semantic IR values and byte memory. */

import { stableDigest } from '../../core/identity/index.js';
import { EXPR_KIND } from '../expr/kinds.js';
import { OP } from '../../ir.js';
import {
  CLEAN_TAINT,
  TAINT_STATUS,
  createTaint,
  hasUnknownTaint,
  joinTaint,
  sanitizeTaint,
  sourceTaint,
  taintDigest,
  unknownTaint,
  withControl,
} from './lattice.js';

function positiveLimit(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError('taint-budget-limit-invalid');
  return value;
}

function parseAddress(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[+-]?(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  if (value?.kind === EXPR_KIND.CONST && typeof value.value === 'bigint') return value.value;
  if (value?.kind === 'const' && typeof value.value === 'bigint') return value.value;
  if (value && typeof value === 'object' && value.const != null) {
    try { return BigInt(value.const); } catch { return null; }
  }
  return null;
}

function expressionKey(value) {
  if (value == null) return null;
  const address = parseAddress(value);
  if (address != null) return `address:${address.toString()}`;
  if (typeof value === 'string' || typeof value === 'number') return `value:${String(value)}`;
  if (typeof value === 'object') {
    if (value.id != null) return `id:${String(value.id)}`;
    if (value.symbolId != null) return `symbol:${String(value.symbolId)}`;
    try { return `expr:${stableDigest(value)}`; } catch { return null; }
  }
  return null;
}

function normalizeWidth(width, fallback = 8) {
  const selected = width == null ? fallback : width;
  if (typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected <= 0 || selected % 8 !== 0) return fallback;
  return selected;
}

function relation(options = {}) {
  const value = options.aliasRelation ?? options.relation ?? null;
  return ['must', 'no', 'may', 'unknown'].includes(value) ? value : null;
}

function mapLookup(value, key) {
  if (value instanceof Map) return value.get(key) ?? value.get(String(key)) ?? null;
  if (value && typeof value === 'object') return value[key] ?? value[String(key)] ?? null;
  return null;
}

function iterableSpecs(value) {
  if (value instanceof Map) return [...value.entries()].map(([id, spec]) => ({ id, ...(spec || {}) }));
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.entries(value).map(([id, spec]) => ({ id, ...(spec || {}) }));
  return [];
}

function sourceSpecFor(value, options = {}) {
  const ids = [value?.id, value?.symbolId, value?.name, value?.reg].filter((id) => id != null).map(String);
  for (const id of ids) {
    const direct = mapLookup(options.sourceByValueId, id) ?? mapLookup(options.sourceLabels, id) ?? mapLookup(options.sourcesByValueId, id);
    if (direct != null) return typeof direct === 'string' ? { source: direct } : direct;
  }
  for (const spec of iterableSpecs(options.sources)) {
    const matches = [spec.id, spec.valueId, spec.symbolId, spec.name, spec.reg].filter((id) => id != null).map(String);
    if (ids.some((id) => matches.includes(id))) return spec;
  }
  return null;
}

function taintFromSourceSpec(spec, fallbackOrigin = null) {
  if (!spec) return null;
  if (typeof spec === 'string') return sourceTaint(spec, { origin: fallbackOrigin });
  const source = spec.source ?? spec.label ?? spec.category ?? spec.id ?? null;
  if (source == null) return null;
  return sourceTaint(String(source), {
    id: spec.labelId ?? spec.taintId ?? spec.id,
    category: spec.category ?? 'source',
    origin: spec.origin ?? fallbackOrigin,
    metadata: spec.metadata,
    provenance: spec.provenance,
  });
}

function sourceForExpression(expression, options = {}) {
  const spec = sourceSpecFor(expression, options);
  if (spec) return taintFromSourceSpec(spec, expression?.id ?? expression?.symbolId ?? null);
  if (options.treatArgumentsAsSources === true && (expression?.kind === 'arg' || expression?.meta?.source === 'argument')) {
    return sourceTaint(expression.reg ?? expression.name ?? expression.id ?? 'argument', { category: 'argument', origin: expression.id ?? null });
  }
  return null;
}

function taintLookup(source, value) {
  if (!source) return null;
  if (source instanceof TaintStore) return source.getValue(value);
  if (source instanceof Map) return source.get(expressionKey(value)) ?? source.get(value?.id) ?? null;
  if (typeof source === 'object') return source[expressionKey(value)] ?? source[value?.id] ?? null;
  return null;
}

/**
 * Derive a taint value from either a solver-neutral Expr or the legacy
 * executor expression.  Unknown semantic nodes are intentionally infectious.
 */
export function taintExpression(expression, options = {}) {
  const seen = options.seen ?? new Set();
  if (expression == null) return unknownTaint('missing-taint-expression');
  const remembered = taintLookup(options.store ?? options.values ?? options.taints, expression);
  if (remembered) return remembered;
  if (typeof expression !== 'object') return CLEAN_TAINT;
  if (seen.has(expression)) return unknownTaint('taint-expression-cycle');
  seen.add(expression);

  let out = sourceForExpression(expression, options);
  if (!out && (expression.kind === EXPR_KIND.CONST || expression.kind === 'const')) out = CLEAN_TAINT;
  else if (!out && (expression.kind === EXPR_KIND.FRESH_SYMBOL || expression.kind === 'symbol')) {
    const metadataSource = expression.source ?? expression.meta?.source ?? null;
    out = metadataSource && options.autoSourceMetadata === true
      ? sourceTaint(metadataSource, { category: expression.meta?.source === 'argument' ? 'argument' : 'symbol', origin: expression.name ?? expression.symbolId })
      : unknownTaint('unclassified-symbol', { name: expression.name ?? expression.symbolId ?? null });
  } else if (!out && (expression.kind === EXPR_KIND.UNKNOWN_SEMANTIC || expression.kind === 'unknown')) {
    out = unknownTaint(expression.reason || 'unknown-semantic-expression', { expression: expression.reason ?? null });
  } else if (!out && (expression.kind === EXPR_KIND.UNARY || expression.kind === EXPR_KIND.EXTRACT || expression.kind === EXPR_KIND.CAST)) {
    out = taintExpression(expression.arg, { ...options, seen });
  } else if (!out && (expression.kind === EXPR_KIND.BINARY || expression.kind === EXPR_KIND.COMPARE || expression.kind === EXPR_KIND.CONCAT)) {
    out = joinTaint(
      taintExpression(expression.left, { ...options, seen }),
      taintExpression(expression.right, { ...options, seen }),
    );
  } else if (!out && (expression.kind === EXPR_KIND.CONNECTIVE)) {
    out = joinTaint((expression.args || []).map((arg) => taintExpression(arg, { ...options, seen })));
  } else if (!out && expression.kind === EXPR_KIND.ITE) {
    const condition = taintExpression(expression.cond, { ...options, seen });
    out = withControl(joinTaint(
      taintExpression(expression.thenExpr, { ...options, seen }),
      taintExpression(expression.elseExpr, { ...options, seen }),
    ), condition, { expression: 'ite' });
  } else if (!out && expression.kind === 'op') {
    out = joinTaint((expression.args || []).map((arg) => taintExpression(arg, { ...options, seen })));
  } else if (!out && expression.kind === 'ite') {
    out = withControl(joinTaint(
      taintExpression(expression.then, { ...options, seen }),
      taintExpression(expression.else, { ...options, seen }),
    ), taintExpression(expression.condition, { ...options, seen }), { expression: 'ite' });
  }
  seen.delete(expression);
  return out || unknownTaint('unrecognized-taint-expression', { kind: expression.kind ?? null });
}

export class TaintStore {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('taint-store-options-required');
    this.version = 'symbolic-taint-proof-v1';
    this.maxLatticeValues = positiveLimit(options.maxLatticeValues ?? options.maxValues, 100000);
    this.maxFlowEdges = positiveLimit(options.maxFlowEdges, 200000);
    this.maxWorkItems = positiveLimit(options.maxWorkItems, 1000000);
    this.maxUpdatesPerValue = positiveLimit(options.maxUpdatesPerValue ?? options.updatesPerValue, 8);
    this.maxSources = positiveLimit(options.maxSources, 4096);
    this.maxSinks = positiveLimit(options.maxSinks, 4096);
    this.maxEmittedRecords = positiveLimit(options.maxEmittedRecords, 100000);
    this.signal = options.signal ?? null;
    this.isCancelled = options.isCancelled ?? (() => false);
    if (typeof this.isCancelled !== 'function') throw new TypeError('taint-store-isCancelled-must-be-function');
    this.values = new Map();
    this.memory = new Map();
    this.symbolicMemory = new Map();
    this.memoryUnknown = false;
    this.control = CLEAN_TAINT;
    this.sinks = [];
    this.sources = [];
    this.flowEdges = [];
    this.latticeDigests = new Set();
    this.updateCounts = new Map();
    this.workItems = 0;
    this.status = TAINT_STATUS.COMPLETE;
    this.reasons = [];
  }

  clone() {
    const copy = Object.create(TaintStore.prototype);
    Object.assign(copy, this);
    copy.values = new Map(this.values);
    copy.memory = new Map(this.memory);
    copy.symbolicMemory = new Map(this.symbolicMemory);
    copy.sinks = this.sinks.slice();
    copy.sources = this.sources.slice();
    copy.flowEdges = this.flowEdges.slice();
    copy.latticeDigests = new Set(this.latticeDigests);
    copy.updateCounts = new Map(this.updateCounts);
    copy.reasons = this.reasons.slice();
    return copy;
  }

  _stop(status, reason) {
    if (status === TAINT_STATUS.CANCELLED || status === TAINT_STATUS.BUDGET_LIMITED || this.status === TAINT_STATUS.COMPLETE) this.status = status;
    if (reason && !this.reasons.includes(reason)) this.reasons.push(reason);
    return { status: this.status, reason };
  }

  _guard(work = 1) {
    this.workItems += work;
    if (this.signal?.aborted || this.isCancelled()) return this._stop(TAINT_STATUS.CANCELLED, 'taint-analysis-cancelled');
    if (this.workItems > this.maxWorkItems) return this._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-work-item-budget');
    if (this.latticeDigests.size > this.maxLatticeValues) return this._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-lattice-value-budget');
    if (this.flowEdges.length > this.maxFlowEdges) return this._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-flow-edge-budget');
    return null;
  }

  _remember(taint) {
    this.latticeDigests.add(taintDigest(taint));
    return this._guard(0);
  }

  getValue(value) {
    return this.values.get(expressionKey(value)) ?? null;
  }

  setValue(value, taint, options = {}) {
    const key = expressionKey(value);
    if (!key) return this._stop(TAINT_STATUS.UNKNOWN, 'taint-value-identity-missing');
    const incoming = options.includeControl === false ? taint : withControl(taint, this.control);
    const previous = this.values.get(key);
    const digest = taintDigest(incoming);
    if (previous && taintDigest(previous) === digest) return { status: this.status, changed: false, taint: previous };
    const count = (this.updateCounts.get(key) || 0) + 1;
    this.updateCounts.set(key, count);
    if (count > this.maxUpdatesPerValue) {
      const unknown = unknownTaint('taint-update-budget', { key }, { labels: incoming.labels, control: incoming.control });
      this.values.set(key, unknown);
      this._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-updates-per-value-budget');
      return { status: this.status, changed: true, taint: unknown };
    }
    this.values.set(key, incoming);
    this._remember(incoming);
    if (previous) this.addFlowEdge(key, key, previous, incoming, options.provenance);
    return { status: this.status, changed: true, taint: incoming };
  }

  source(value, source, options = {}) {
    if (this.sources.length >= this.maxSources) return this._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-source-budget');
    const taint = typeof source === 'object' && source?.version === this.version ? source : taintFromSourceSpec(typeof source === 'string' ? { source } : source) || sourceTaint(String(source ?? 'source'), options);
    this.sources.push(Object.freeze({ value: expressionKey(value), taint, provenance: options.provenance ?? null }));
    return this.setValue(value, taint, options);
  }

  addFlowEdge(from, to, before, after, provenance = null) {
    if (this.flowEdges.length >= this.maxFlowEdges || this.flowEdges.length + this.sinks.length >= this.maxEmittedRecords) return this._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-flow-edge-budget');
    this.flowEdges.push(Object.freeze({ from: String(from), to: String(to), before: taintDigest(before), after: taintDigest(after), provenance: provenance ?? null }));
    return null;
  }

  _byteKey(address, index = 0) {
    const concrete = parseAddress(address);
    if (concrete != null) return { kind: 'concrete', key: `${(concrete + BigInt(index)).toString()}` };
    const symbolic = expressionKey(address);
    return symbolic ? { kind: 'symbolic', key: `${symbolic}:${index}` } : { kind: 'unknown', key: null };
  }

  storeMemory(address, taint, widthBits = 8, options = {}) {
    const relationValue = relation(options);
    const width = normalizeWidth(widthBits, 8);
    const info = this._byteKey(address, 0);
    if (relationValue === 'may' || relationValue === 'unknown' || info.kind === 'unknown') {
      this.memory.clear();
      this.symbolicMemory.clear();
      this.memoryUnknown = true;
      return this._stop(TAINT_STATUS.UNKNOWN, 'taint-memory-alias-unknown');
    }
    if (info.kind === 'symbolic' && relationValue !== 'no') {
      // A symbolic write can overlap every previously forwarded byte. Drop
      // stale clean memory and make every subsequent load conservative until
      // an independently proven state replaces the uncertainty.
      this.memory.clear();
      this.symbolicMemory.clear();
      this.memoryUnknown = true;
    }
    const byteCount = width / 8;
    const combined = joinTaint(taint, options.addressTaint ?? CLEAN_TAINT);
    for (let index = 0; index < byteCount; index++) {
      const byte = this._byteKey(address, index);
      if (byte.kind === 'concrete') this.memory.set(byte.key, combined);
      else this.symbolicMemory.set(byte.key, combined);
    }
    if (info.kind === 'symbolic') this.status = this.status === TAINT_STATUS.COMPLETE ? TAINT_STATUS.PARTIAL : this.status;
    this._remember(combined);
    return { status: this.status, taint: combined };
  }

  loadMemory(address, widthBits = 8, options = {}) {
    const width = normalizeWidth(widthBits, 8);
    const relationValue = relation(options);
    const info = this._byteKey(address, 0);
    if (relationValue === 'may' || relationValue === 'unknown' || info.kind === 'unknown' || this.memoryUnknown) {
      return unknownTaint('taint-memory-alias-unknown', { address: expressionKey(address) }, { labels: [...this.memory.values(), ...this.symbolicMemory.values()].flatMap((item) => item.labels) });
    }
    const bytes = [];
    for (let index = 0; index < width / 8; index++) {
      const byte = this._byteKey(address, index);
      const taint = byte.kind === 'concrete' ? this.memory.get(byte.key) : this.symbolicMemory.get(byte.key);
      if (!taint) return unknownTaint('taint-memory-byte-hole', { address: expressionKey(address), missingByte: index });
      bytes.push(taint);
    }
    return joinTaint(bytes, options.addressTaint ?? CLEAN_TAINT);
  }

  branch(condition, provenance = null) {
    this.control = joinTaint(this.control, condition);
    if (hasUnknownTaint(condition)) this._stop(TAINT_STATUS.UNKNOWN, 'taint-control-unknown');
    return this.control;
  }

  sanitize(value, sanitizer, provenance = null) {
    const clean = sanitizeTaint(value, sanitizer, provenance);
    this._remember(clean);
    return clean;
  }

  sink(sink, taint, provenance = null) {
    if (this.sinks.length >= this.maxSinks || this.sinks.length >= this.maxEmittedRecords) return this._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-sink-budget');
    const record = Object.freeze({ id: String(sink?.id ?? sink?.name ?? sink ?? `sink_${this.sinks.length}`), taint, taintDigest: taintDigest(taint), provenance: provenance ?? null });
    this.sinks.push(record);
    return record;
  }

  stats() {
    let updatesPerValue = 0;
    for (const value of this.updateCounts.values()) updatesPerValue = Math.max(updatesPerValue, value);
    return Object.freeze({
      latticeValues: this.latticeDigests.size,
      flowEdges: this.flowEdges.length,
      workItems: this.workItems,
      updatesPerValue,
      sources: this.sources.length,
      sinks: this.sinks.length,
      emittedRecords: this.sinks.length + this.flowEdges.length,
      status: this.status,
    });
  }

  snapshot() {
    return Object.freeze({ version: this.version, status: this.status, reasons: Object.freeze(this.reasons.slice()), stats: this.stats() });
  }
}

function valueTaint(value, state, options, seen = new Set()) {
  if (!value) return unknownTaint('missing-ssa-value');
  const remembered = state.getValue(value);
  if (remembered) return remembered;
  if (value.const != null || value.kind === 'const') return CLEAN_TAINT;
  if (value.kind === 'arg') {
    const direct = sourceForExpression(value, options);
    return direct || unknownTaint('unclassified-argument', { valueId: value.id ?? null });
  }
  if (value.def && !seen.has(value.id)) {
    seen.add(value.id);
    return instructionTaint(value.def, state, options, seen);
  }
  return taintExpression(value, { ...options, store: state, seen });
}

function instructionArguments(inst, state, options, seen) {
  return (inst?.args || []).map((arg) => valueTaint(arg?.value ?? arg, state, options, seen));
}

function sanitizerFor(inst, options) {
  if (inst?.sanitizer) return inst.sanitizer;
  const configured = options?.sanitizers;
  const id = inst?.id == null ? null : String(inst.id);
  if (configured instanceof Map) return configured.get(id) ?? configured.get(inst.id) ?? null;
  if (configured && typeof configured === 'object') return configured[id] ?? null;
  return null;
}

function sinkSpecsFor(inst, options) {
  const specs = iterableSpecs(options?.sinks);
  return specs.filter((spec) => {
    const ids = [spec.id, spec.instructionId, spec.instId, spec.valueId].filter((id) => id != null).map(String);
    return ids.length === 0 || ids.includes(String(inst?.id));
  });
}

function sourceSpecForInstruction(inst, options) {
  const configured = mapLookup(options?.sourceByInstructionId, inst?.id) ?? mapLookup(options?.sourceByInstruction, inst?.id);
  if (configured) return configured;
  for (const spec of iterableSpecs(options?.sources)) {
    if ([spec.instructionId, spec.instId, spec.id].filter((id) => id != null).map(String).includes(String(inst?.id))) return spec;
  }
  return null;
}

function memoryAddressForInstruction(inst) {
  const address = inst?.addr;
  if (address?.base) {
    const base = parseAddress(address.base);
    const displacement = address.disp == null ? 0n : parseAddress(address.disp);
    const index = address.index ? parseAddress(address.index) : 0n;
    const scale = typeof address.scale === 'number' && Number.isSafeInteger(address.scale) && address.scale > 0 ? address.scale : 0;
    if (base != null && displacement != null && index != null) return base + displacement + (index << BigInt(scale));
    if (displacement != null || address.index) return {
      kind: 'taint-memory-address', base: address.base, index: address.index ?? null,
      displacement: (displacement ?? 0n).toString(), scale,
    };
    return address.base;
  }
  return inst?.loc?.address ?? inst?.loc?.key ?? null;
}

function memoryAddressTaintForInstruction(inst, state, options, seen = new Set()) {
  const parts = [];
  if (inst?.addr?.base) parts.push(valueTaint(inst.addr.base, state, options, seen));
  if (inst?.addr?.index) parts.push(valueTaint(inst.addr.index, state, options, seen));
  return parts.length ? joinTaint(parts) : CLEAN_TAINT;
}

function instructionTaint(inst, state, options, seen = new Set()) {
  if (!inst) return unknownTaint('missing-instruction-taint');
  const args = instructionArguments(inst, state, options, seen);
  let out = joinTaint(args);
  if (inst.op === OP.LOAD) {
    const addressTaint = memoryAddressTaintForInstruction(inst, state, options, seen);
    out = joinTaint(state.loadMemory(memoryAddressForInstruction(inst), inst.extra?.widthBits ?? (inst.loc?.size ? inst.loc.size * 8 : 8), { addressTaint, aliasRelation: inst.memoryAliasRelation ?? inst.extra?.aliasRelation }));
  } else if (inst.op === OP.STORE) {
    out = args[0] || unknownTaint('missing-store-taint');
  } else if (inst.op === OP.CBR || inst.op === OP.BR) {
    out = joinTaint(args);
  } else if (inst.op === OP.UNKNOWN || inst.op === OP.CLOBBER || inst.op === OP.CALL) {
    out = unknownTaint(`unsupported-taint-op-${inst.op}`, { instructionId: inst.id }, { labels: out.labels, control: out.control });
  }
  const source = sourceSpecForInstruction(inst, options);
  if (source) out = joinTaint(out, taintFromSourceSpec(source, inst.id) || sourceTaint(String(source.source ?? source.id ?? 'instruction-source'), { origin: inst.id }));
  const sanitizer = sanitizerFor(inst, options);
  if (sanitizer) out = sanitizeTaint(out, typeof sanitizer === 'string' ? { id: sanitizer } : sanitizer, { instructionId: inst.id });
  return out;
}

function addressBlockMap(ir) {
  const map = new Map();
  for (const block of ir?.blocks || []) {
    const first = (block.insts || []).find((inst) => inst.address != null);
    if (first) map.set(String(first.address), block.index);
  }
  return map;
}

function branchTargets(ir, block, inst, addressMap) {
  const target = inst?.extra?.target == null ? null : addressMap.get(String(inst.extra.target));
  const succ = (block?.succ || []).slice();
  if (inst.op === OP.BR) return { target: target ?? succ[0] ?? null, fallthrough: null };
  const fallthrough = succ.find((item) => item !== target) ?? (succ.length === 2 ? succ[1] : null);
  return { target, fallthrough };
}

function maxPaths(value) { return positiveLimit(value, 16); }

/** Run bounded taint propagation and retain all uncertainty in the result. */
export function analyzeTaint(ir, options = {}) {
  const cancelled = options.isCancelled ?? (() => false);
  if (typeof cancelled !== 'function') throw new TypeError('taint-isCancelled-must-be-function');
  const store = options.store instanceof TaintStore ? options.store.clone() : new TaintStore({ ...options, isCancelled: cancelled });
  if (!ir?.blocks?.length) return Object.freeze({ version: 'symbolic-taint-proof-v1', status: store.status, complete: true, paths: [], sinks: [], sources: [], taints: {}, stats: store.stats(), store });
  const addressMap = addressBlockMap(ir);
  const queue = [{ block: ir.entry || 0, prevBlock: -1, store, visits: new Map(), steps: 0, branches: [] }];
  const observedStores = [store];
  const paths = [];
  const maxSteps = positiveLimit(options.maxSteps, 2000);
  const maxBranches = positiveLimit(options.maxBranches, 32);
  const deadline = options.timeoutMs == null ? null : Date.now() + positiveLimit(options.timeoutMs, 250);
  let branches = 0;
  while (queue.length && paths.length < maxPaths(options.maxPaths)) {
    const state = queue.shift();
    observedStores.push(state.store);
    if (deadline != null && Date.now() > deadline) { state.store._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-time-budget'); paths.push({ status: state.store.status, branches: state.branches }); break; }
    if (state.store._guard() || state.steps >= maxSteps) { state.store._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-step-budget'); paths.push({ status: state.store.status, branches: state.branches }); continue; }
    const visits = (state.visits.get(state.block) || 0) + 1;
    state.visits.set(state.block, visits);
    if (visits > (options.maxBlockVisits ?? 3)) { state.store._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-loop-budget'); paths.push({ status: state.store.status, branches: state.branches }); continue; }
    const block = ir.blocks[state.block];
    if (!block) { state.store._stop(TAINT_STATUS.UNKNOWN, 'taint-missing-block'); paths.push({ status: state.store.status, branches: state.branches }); continue; }
    let transferred = false;
    for (const inst of block.insts || []) {
      state.steps++;
      if (state.steps > maxSteps) { state.store._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-step-budget'); break; }
      if (state.store._guard()) {
        paths.push({ status: state.store.status, branches: state.branches });
        transferred = true;
        break;
      }
      for (const arg of inst.args || []) {
        const input = arg?.value ?? arg;
        const source = sourceSpecFor(input, options);
        if (source) state.store.source(input, source, { provenance: { instructionId: inst.id, valueId: input?.id ?? null } });
      }
      const instructionSource = sourceSpecForInstruction(inst, options);
      if (instructionSource && inst.dst) state.store.source(inst.dst, instructionSource, { provenance: { instructionId: inst.id } });
      const out = instructionTaint(inst, state.store, options);
      if (inst.op === OP.STORE) {
        const address = memoryAddressForInstruction(inst);
        state.store.storeMemory(address, out, inst.extra?.widthBits ?? (inst.loc?.size ? inst.loc.size * 8 : 8), { aliasRelation: inst.memoryAliasRelation ?? inst.extra?.aliasRelation, addressTaint: memoryAddressTaintForInstruction(inst, state.store, options) });
      }
      if (inst.dst) state.store.setValue(inst.dst, out, { provenance: { instructionId: inst.id } });
      for (const sink of sinkSpecsFor(inst, options)) state.store.sink(sink, out, { instructionId: inst.id });
      if (typeof options.onSink === 'function' && sinkSpecsFor(inst, options).length === 0 && (inst.op === OP.RET || inst.op === OP.CALL)) options.onSink(Object.freeze({ instructionId: inst.id, taint: out }));
      if (inst.op === OP.CBR) {
        if (++branches > maxBranches) { state.store._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-branch-budget'); break; }
        const condition = joinTaint(instructionArguments(inst, state.store, options, new Set()));
        const next = branchTargets(ir, block, inst, addressMap);
        if (next.target == null || next.fallthrough == null) { state.store._stop(TAINT_STATUS.UNKNOWN, 'taint-branch-target-unknown'); break; }
        for (const [taken, destination] of [[true, next.target], [false, next.fallthrough]]) {
          const child = state.store.clone();
          child.branch(condition, { instructionId: inst.id, taken });
          observedStores.push(child);
          queue.push({ block: destination, prevBlock: state.block, store: child, visits: new Map(state.visits), steps: state.steps, branches: [...state.branches, { instructionId: inst.id, taken, taintDigest: taintDigest(condition) }] });
        }
        transferred = true;
        break;
      }
      if (inst.op === OP.BR) {
        const next = branchTargets(ir, block, inst, addressMap);
        if (next.target == null) { state.store._stop(TAINT_STATUS.UNKNOWN, 'taint-branch-target-unknown'); break; }
        queue.push({ block: next.target, prevBlock: state.block, store: state.store, visits: new Map(state.visits), steps: state.steps, branches: state.branches });
        transferred = true;
        break;
      }
      if (inst.op === OP.RET) {
        paths.push({ status: state.store.status, returnTaint: out, returnTaintDigest: taintDigest(out), branches: state.branches });
        transferred = true;
        break;
      }
    }
    if (transferred) continue;
    if ((block.succ || []).length === 1) queue.push({ block: block.succ[0], prevBlock: state.block, store: state.store, visits: new Map(state.visits), steps: state.steps, branches: state.branches });
    else if (!(block.succ || []).length) paths.push({ status: state.store.status, branches: state.branches });
    else { state.store._stop(TAINT_STATUS.UNKNOWN, 'taint-ambiguous-control-flow'); paths.push({ status: state.store.status, branches: state.branches }); }
  }
  if (queue.length) for (const pending of queue) pending.store._stop(TAINT_STATUS.BUDGET_LIMITED, 'taint-path-budget');
  const taints = {};
  const aggregateValues = new Map();
  const allSinks = [];
  const allSources = [];
  const allFlowEdges = [];
  let aggregateStatus = TAINT_STATUS.COMPLETE;
  for (const candidate of observedStores) {
    for (const [key, value] of candidate.values.entries()) {
      const previous = aggregateValues.get(key);
      aggregateValues.set(key, previous ? joinTaint(previous, value) : value);
    }
    allSinks.push(...candidate.sinks);
    allSources.push(...candidate.sources);
    allFlowEdges.push(...candidate.flowEdges);
    if (candidate.status !== TAINT_STATUS.COMPLETE) aggregateStatus = candidate.status;
  }
  const status = aggregateStatus;
  const aggregateStore = store.clone();
  aggregateStore.status = status;
  aggregateStore.workItems = Math.max(...observedStores.map((candidate) => candidate.workItems), 0);
  aggregateStore.values = new Map();
  aggregateStore.memory = new Map();
  aggregateStore.symbolicMemory = new Map();
  aggregateStore.latticeDigests = new Set();
  aggregateStore.updateCounts = new Map();
  aggregateStore.sources = [];
  aggregateStore.sinks = [];
  aggregateStore.flowEdges = [];
  aggregateStore.values = new Map(aggregateValues);
  for (const [key, value] of aggregateValues.entries()) taints[key] = value;
  for (const candidate of observedStores) {
    for (const value of candidate.values.values()) aggregateStore.latticeDigests.add(taintDigest(value));
    for (const [key, value] of candidate.memory.entries()) {
      const previous = aggregateStore.memory.get(key);
      aggregateStore.memory.set(key, previous ? joinTaint(previous, value) : value);
    }
    for (const [key, value] of candidate.symbolicMemory.entries()) {
      const previous = aggregateStore.symbolicMemory.get(key);
      aggregateStore.symbolicMemory.set(key, previous ? joinTaint(previous, value) : value);
    }
    aggregateStore.memoryUnknown ||= candidate.memoryUnknown;
    for (const [key, value] of candidate.updateCounts.entries()) aggregateStore.updateCounts.set(key, Math.max(aggregateStore.updateCounts.get(key) || 0, value));
    aggregateStore.sources.push(...candidate.sources);
    aggregateStore.sinks.push(...candidate.sinks);
    aggregateStore.flowEdges.push(...candidate.flowEdges);
    aggregateStore.reasons.push(...candidate.reasons);
  }
  aggregateStore.sources = [...new Map(aggregateStore.sources.map((source) => [source.value + ':' + taintDigest(source.taint), source])).values()];
  aggregateStore.sinks = [...new Map(aggregateStore.sinks.map((sink) => [sink.id + ':' + sink.taintDigest, sink])).values()];
  aggregateStore.flowEdges = [...new Map(aggregateStore.flowEdges.map((edge) => [edge.from + ':' + edge.to + ':' + edge.after, edge])).values()];
  aggregateStore.reasons = [...new Set(aggregateStore.reasons)];
  return Object.freeze({
    version: 'symbolic-taint-proof-v1',
    status,
    complete: status === TAINT_STATUS.COMPLETE && paths.every((path) => path.status === TAINT_STATUS.COMPLETE),
    memoryUnknown: observedStores.some((candidate) => candidate.memoryUnknown),
    paths: Object.freeze(paths),
    taints: Object.freeze(taints),
    sinks: Object.freeze([...new Map(allSinks.map((sink) => [sink.id + ':' + sink.taintDigest, sink])).values()]),
    sources: Object.freeze([...new Map(allSources.map((source) => [source.value + ':' + taintDigest(source.taint), source])).values()]),
    flowEdges: Object.freeze([...new Map(allFlowEdges.map((edge) => [edge.from + ':' + edge.to + ':' + edge.after, edge])).values()]),
    stats: observedStores.reduce((max, candidate) => {
      const stats = candidate.stats();
      return {
        latticeValues: Math.max(max.latticeValues, stats.latticeValues),
        flowEdges: Math.max(max.flowEdges, stats.flowEdges),
        workItems: Math.max(max.workItems, stats.workItems),
        updatesPerValue: Math.max(max.updatesPerValue, stats.updatesPerValue),
        sources: Math.max(max.sources, stats.sources),
        sinks: Math.max(max.sinks, stats.sinks),
        emittedRecords: Math.max(max.emittedRecords, stats.emittedRecords),
        status,
      };
    }, { latticeValues: 0, flowEdges: 0, workItems: 0, updatesPerValue: 0, sources: 0, sinks: 0, emittedRecords: 0 }),
    store: aggregateStore,
  });
}

export function createTaintStore(options = {}) { return new TaintStore(options); }
