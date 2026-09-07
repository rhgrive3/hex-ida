/**
 * Bounded byte addressed symbolic memory.
 *
 * This module is deliberately a small consumer of the canonical semantic
 * memory facts.  It does not discover aliases or reaching definitions.  A
 * concrete address can use a sparse byte map; the first symbolic address
 * escalates the state to the conservative array tier.  Reads from a hole or
 * from a possibly aliased write stay explicit unknowns.
 */

import {
  createBv,
  createConcat,
  createExtract,
  createFreshSymbol,
  createUnknownSemantic,
} from '../expr/factory.js';
import { EXPR_KIND, isBvSort } from '../expr/kinds.js';
import { computeStructuralHash } from '../expr/hash.js';
import {
  CANONICAL_MEMORY_FORWARDING_CONSUMER,
  CANONICAL_MEMORY_FORWARDING_PURPOSE,
  forwardMemoryValue,
  isCanonicalExactMemoryForwarding,
} from '../../semantics/memoryssa/queries.js';
import { stableDigest } from '../../core/identity/index.js';

export const BYTE_MEMORY_VERSION = 'symbolic-byte-memory-v1';

export const MEMORY_TIER = Object.freeze({
  CONCRETE: 'concrete',
  ARRAY: 'array',
});

export const MEMORY_RESULT_STATUS = Object.freeze({
  EXACT: 'exact',
  UNKNOWN: 'unknown',
  PARTIAL: 'partial',
  BUDGET_LIMITED: 'budget-limited',
  CANCELLED: 'cancelled',
  UNSUPPORTED: 'unsupported',
});

function fail(message) { throw new TypeError(message); }

function positiveSafeInteger(value, name, fallback) {
  const selected = value == null ? fallback : value;
  if (typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected <= 0) {
    throw new TypeError(`${name} must be a positive primitive safe integer`);
  }
  return selected;
}

function normalizeWidthBits(value, fallback = 8) {
  const width = value == null ? fallback : value;
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0 || width % 8 !== 0) {
    throw new TypeError('symbolic-memory-width-must-be-positive-byte-aligned');
  }
  return width;
}

function normalizeEndian(value, fallback = 'little') {
  const endian = value == null ? fallback : value;
  if (endian !== 'little' && endian !== 'big') throw new TypeError('symbolic-memory-endian-invalid');
  return endian;
}

function parseBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^[+-]?(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  return null;
}

function isPlainMap(value) {
  return value instanceof Map || (value && typeof value === 'object' && !Array.isArray(value));
}

function entries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value);
  return [];
}

function canonicalExpressionAdapter() {
  return Object.freeze({
    constant(width, value) { return createBv(width, value); },
    unknown(width, reason, detail = null) { return createUnknownSemantic({ kind: 'bv', width }, reason, detail); },
    fresh(width, name, meta = {}) { return createFreshSymbol({ kind: 'bv', width }, name, meta); },
    isConstant(value) { return value?.kind === EXPR_KIND.CONST && isBvSort(value.sort); },
    isUnknown(value) { return value?.kind === EXPR_KIND.UNKNOWN_SEMANTIC; },
    constantValue(value) { return value?.kind === EXPR_KIND.CONST && typeof value.value === 'bigint' ? value.value : null; },
    widthOf(value) { return isBvSort(value?.sort) ? value.sort.width : null; },
    extract(value, high, low) {
      if (high === low && value?.sort?.width === 8) return value;
      return createExtract(value, high, low);
    },
    concat(left, right) { return createConcat(left, right); },
    structuralKey(value) {
      // The canonical Expr hash intentionally maps unsupported nodes to an
      // unknown sentinel.  Memory addresses may still be opaque but distinct
      // caller identities, so retain a deterministic structural key for
      // those objects instead of collapsing every pointer into one alias.
      if (value?.kind && Object.values(EXPR_KIND).includes(value.kind)) return computeStructuralHash(value);
      return stableDigest(value);
    },
  });
}

function normalizeExpressionAdapter(adapter) {
  const selected = adapter || canonicalExpressionAdapter();
  for (const name of ['constant', 'unknown', 'fresh', 'isConstant', 'constantValue', 'widthOf', 'extract', 'concat', 'structuralKey']) {
    if (typeof selected[name] !== 'function') throw new TypeError(`symbolic-memory-expression-adapter-${name}-missing`);
  }
  if (typeof selected.isUnknown !== 'function') {
    return Object.freeze({ ...selected, isUnknown: (value) => value?.kind === EXPR_KIND.UNKNOWN_SEMANTIC });
  }
  return selected;
}

function freezeDetail(detail) {
  if (detail == null || typeof detail !== 'object') return detail ?? null;
  try { return Object.freeze(structuredClone(detail)); } catch { return null; }
}

function result(status, expression, reason = null, detail = null) {
  return Object.freeze({
    status,
    exact: status === MEMORY_RESULT_STATUS.EXACT,
    expression: expression ?? null,
    reason,
    detail: freezeDetail(detail),
  });
}

function addressInfo(adapter, address) {
  const concrete = parseBigInt(address);
  if (concrete != null) return { kind: 'concrete', value: concrete, key: concrete.toString() };

  if (address?.kind === EXPR_KIND.CONST && typeof address.value === 'bigint') {
    return { kind: 'concrete', value: address.value, key: address.value.toString() };
  }
  if (address && typeof address === 'object') {
    // `address` is an absolute location.  An `offset` belongs to a base
    // descriptor and must remain symbolic unless a caller has already
    // canonicalized the complete base+offset expression.
    const direct = parseBigInt(address.address ?? null);
    if (direct != null) return { kind: 'concrete', value: direct, key: direct.toString() };
    if (address.kind === 'unknown' || address.kind === 'may-alias' || address.unknown === true) {
      return { kind: 'unknown', key: null, expression: address };
    }
    if (address.key != null && typeof address.key === 'string' && address.key.trim()) {
      return { kind: 'symbolic', key: `location:${address.key}`, expression: address };
    }
  }
  if (address != null && typeof address === 'object') {
    let key;
    try { key = adapter.structuralKey(address); } catch { key = null; }
    if (typeof key === 'string' && key) return { kind: 'symbolic', key: `expr:${key}`, expression: address };
  }
  return { kind: 'unknown', key: null, expression: address };
}

function relationFor(options = {}) {
  const relation = options.aliasRelation ?? options.relation ?? options.alias?.relation ?? null;
  if (relation === 'must' || relation === 'no' || relation === 'may' || relation === 'unknown') return relation;
  if (options.unknownAlias === true || options.mayAlias === true) return 'may';
  return null;
}

function normalizeCell(value, adapter, widthBits, index, endian) {
  const sourceWidth = adapter.widthOf(value);
  if (sourceWidth == null) {
    return adapter.unknown(8, 'symbolic-memory-store-value-untyped', { index, widthBits, endian });
  }
  if (adapter.isConstant(value)) {
    const raw = adapter.constantValue(value);
    const unsigned = BigInt.asUintN(sourceWidth, raw);
    const shiftIndex = endian === 'little' ? index : (widthBits / 8) - index - 1;
    return adapter.constant(8, unsigned >> BigInt(shiftIndex * 8));
  }
  const shiftIndex = endian === 'little' ? index : (widthBits / 8) - index - 1;
  const low = shiftIndex * 8;
  if (low + 8 > sourceWidth) {
    return adapter.unknown(8, 'symbolic-memory-store-width-mismatch', { index, widthBits, sourceWidth, endian });
  }
  return adapter.extract(value, low + 7, low);
}

function assemble(cells, widthBits, endian, adapter) {
  const bytes = widthBits / 8;
  if (cells.every((cell) => adapter.isConstant(cell))) {
    let value = 0n;
    for (let index = 0; index < bytes; index++) {
      const shift = endian === 'little' ? index : bytes - index - 1;
      value |= BigInt.asUintN(8, adapter.constantValue(cells[index])) << BigInt(shift * 8);
    }
    return adapter.constant(widthBits, value);
  }
  let expression = null;
  for (let index = 0; index < bytes; index++) {
    const cell = cells[index];
    expression = expression == null
      ? cell
      : (endian === 'little' ? adapter.concat(cell, expression) : adapter.concat(expression, cell));
  }
  return expression;
}

function* initialCellMap(initial, adapter, options) {
  for (const [rawAddress, rawValue] of entries(initial)) {
    const address = parseBigInt(rawAddress);
    if (address == null) continue;
    const wrapper = rawValue && typeof rawValue === 'object' && rawValue.kind == null && 'value' in rawValue;
    const value = wrapper ? rawValue.value : rawValue;
    const widthBits = normalizeWidthBits(wrapper ? (rawValue.widthBits ?? options.widthBits ?? 8) : (adapter.widthOf(value) ?? options.widthBits ?? 8), 8);
    const endian = normalizeEndian(wrapper ? (rawValue.endian ?? options.endian) : options.endian, options.endian ?? 'little');
    let expression = value;
    if (!adapter.widthOf(expression)) {
      const numeric = parseBigInt(value);
      if (numeric == null) continue;
      expression = adapter.constant(widthBits, numeric);
    }
    const byteCount = widthBits / 8;
    for (let index = 0; index < byteCount; index++) {
      yield [address + BigInt(index), normalizeCell(expression, adapter, widthBits, index, endian)];
    }
  }
}

export class ByteMemory {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('symbolic-memory-options-required');
    this.version = BYTE_MEMORY_VERSION;
    this.expression = normalizeExpressionAdapter(options.expression);
    this.maxConcreteBytes = positiveSafeInteger(options.maxConcreteBytes, 'maxConcreteBytes', 65536);
    this.maxSymbolicCells = positiveSafeInteger(options.maxSymbolicCells, 'maxSymbolicCells', 4096);
    this.maxStoreHistory = positiveSafeInteger(options.maxStoreHistory, 'maxStoreHistory', 4096);
    this.maxAliasForks = positiveSafeInteger(options.maxAliasForks, 'maxAliasForks', 16);
    this.signal = options.signal ?? null;
    this.isCancelled = options.isCancelled == null ? (() => false) : options.isCancelled;
    if (typeof this.isCancelled !== 'function') throw new TypeError('symbolic-memory-isCancelled-must-be-function');
    this.tier = MEMORY_TIER.CONCRETE;
    this.cells = new Map();
    this.symbolicCells = new Map();
    this.storeHistory = [];
    this.uncertain = false;
    this.aliasForks = 0;
    this._unknownReason = null;
    for (const [address, value] of initialCellMap(options.initial ?? options.bytes, this.expression, options)) {
      if (this.signal?.aborted || this.isCancelled()) {
        this._unknownReason = 'cancelled';
        break;
      }
      const key = address.toString();
      if (!this.cells.has(key) && this.cells.size >= this.maxConcreteBytes) {
        this._unknownReason = 'budget-limited';
        break;
      }
      this.cells.set(key, value);
    }
  }

  clone() {
    const copy = Object.create(ByteMemory.prototype);
    Object.assign(copy, this);
    copy.cells = new Map(this.cells);
    copy.symbolicCells = new Map(this.symbolicCells);
    copy.storeHistory = this.storeHistory.slice();
    return copy;
  }

  get status() {
    if (this._unknownReason === 'cancelled') return MEMORY_RESULT_STATUS.CANCELLED;
    if (this._unknownReason === 'budget-limited') return MEMORY_RESULT_STATUS.BUDGET_LIMITED;
    return this.uncertain ? MEMORY_RESULT_STATUS.UNKNOWN : MEMORY_RESULT_STATUS.EXACT;
  }

  stats() {
    return Object.freeze({
      tier: this.tier,
      concreteMemoryBytes: this.cells.size,
      symbolicMemoryCells: this.symbolicCells.size,
      storeHistoryEntries: this.storeHistory.length,
      aliasForks: this.aliasForks,
      status: this.status,
    });
  }

  snapshot() {
    return Object.freeze({
      version: this.version,
      tier: this.tier,
      cells: Object.freeze([...this.cells.entries()].map(([address, value]) => Object.freeze({ address, value }))),
      symbolicCells: Object.freeze([...this.symbolicCells.entries()].map(([key, value]) => Object.freeze({ key, value }))),
      uncertain: this.uncertain,
      reason: this._unknownReason,
      stats: this.stats(),
    });
  }

  _guard() {
    if (this._unknownReason === 'cancelled') {
      return result(MEMORY_RESULT_STATUS.CANCELLED, null, 'analysis-cancelled');
    }
    if (this._unknownReason === 'budget-limited') {
      return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-budget-exceeded', this.stats());
    }
    if (this.signal?.aborted || this.isCancelled()) {
      this._unknownReason = 'cancelled';
      return result(MEMORY_RESULT_STATUS.CANCELLED, null, 'analysis-cancelled');
    }
    if (this.aliasForks > this.maxAliasForks) {
      this._unknownReason = 'budget-limited';
      return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-alias-fork-budget', this.stats());
    }
    if (this.storeHistory.length > this.maxStoreHistory || this.cells.size > this.maxConcreteBytes || this.symbolicCells.size > this.maxSymbolicCells) {
      this._unknownReason = 'budget-limited';
      return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-budget-exceeded', this.stats());
    }
    return null;
  }

  _record(history) {
    if (this.storeHistory.length >= this.maxStoreHistory) {
      this._unknownReason = 'budget-limited';
      return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-store-history-budget', this.stats());
    }
    this.storeHistory.push(Object.freeze(history));
    return this._guard();
  }

  _promote() { this.tier = MEMORY_TIER.ARRAY; }

  /*
   * A byte map is a forwarding cache, not a history of independent worlds.
   * Once an access may overlap the prior state, every cached byte from that
   * state is stale.  The store performed after the invalidation may still be
   * forwarded at its own exact address; callers never get a pre-clobber byte
   * merely because its symbolic key happens to remain available.
   */
  _invalidateForwarding({ concrete = true, symbolic = true } = {}) {
    if (concrete) this.cells.clear();
    if (symbolic) this.symbolicCells.clear();
  }

  seed(address, value, options = {}) {
    return this.store(address, value, { ...options, initial: true });
  }

  store(address, value, options = {}) {
    const guard = this._guard();
    if (guard) return guard;
    const suppliedWidth = options.widthBits ?? this.expression.widthOf(value) ?? 8;
    const widthBits = normalizeWidthBits(suppliedWidth, 8);
    let storedValue = value;
    if (this.expression.widthOf(storedValue) == null) {
      const fromExpression = this.expression.isConstant(storedValue)
        ? this.expression.constantValue(storedValue)
        : null;
      const numeric = fromExpression != null ? fromExpression : parseBigInt(storedValue);
      storedValue = numeric == null
        ? this.expression.unknown(widthBits, 'symbolic-memory-store-value-untyped', { widthBits })
        : this.expression.constant(widthBits, numeric);
    }
    const endian = normalizeEndian(options.endian, 'little');
    const info = addressInfo(this.expression, address);
    const relation = relationFor(options);
    const barrier = options.volatile === true || options.atomic === true || options.barrier === true || options.ordering != null;
    if (barrier) {
      this._invalidateForwarding();
      this.uncertain = true;
      this._unknownReason = options.atomic === true || options.ordering != null ? 'atomic-memory-barrier' : 'volatile-memory-barrier';
      this._promote();
      const barrierResult = this._record({ kind: 'barrier', widthBits, endian, address: info.key, reason: this._unknownReason });
      return barrierResult || result(MEMORY_RESULT_STATUS.UNKNOWN, null, this._unknownReason);
    }
    if (relation === 'may' || relation === 'unknown' || info.kind === 'unknown') {
      this._invalidateForwarding();
      if (relation !== 'no' && this.aliasForks >= this.maxAliasForks) {
        this._unknownReason = 'budget-limited';
        return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-alias-fork-budget', this.stats());
      }
      if (relation !== 'no') this.aliasForks++;
      this.uncertain = true;
      this._unknownReason = relation === 'unknown' || info.kind === 'unknown' ? 'unknown-memory-alias' : 'may-alias-store';
      this._promote();
      const unknownResult = this._record({ kind: 'may-alias-store', widthBits, endian, address: info.key, reason: this._unknownReason });
      return unknownResult || result(MEMORY_RESULT_STATUS.UNKNOWN, null, this._unknownReason);
    }

    const isSymbolic = info.kind === 'symbolic';
    if (isSymbolic) {
      // A symbolic address can overlap every previously forwarded concrete
      // or symbolic byte.  An explicitly proven NoAlias store is the one
      // exception: its independent proof keeps the prior forwarding cache.
      if (relation !== 'no') this._invalidateForwarding();
      if (relation !== 'no' && this.aliasForks >= this.maxAliasForks) {
        this._unknownReason = 'budget-limited';
        return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-alias-fork-budget', this.stats());
      }
      if (relation !== 'no') this.aliasForks++;
      this._promote();
      // A symbolic write may overlap every concrete byte.  Keep exact
      // forwarding for the same symbolic address key, but withhold concrete
      // forwarding until an independent alias proof exists.
      this.uncertain = true;
      this._unknownReason = 'symbolic-memory-alias-uncertain';
    } else if (this.symbolicCells.size && relation !== 'no') {
      // A concrete write may be the address selected by an earlier symbolic
      // write.  Keep concrete-to-concrete forwarding, but discard symbolic
      // cells whose last writer may have been clobbered.
      this.symbolicCells.clear();
    }
    const byteCount = widthBits / 8;
    const values = [];
    for (let index = 0; index < byteCount; index++) {
      const cell = normalizeCell(storedValue, this.expression, widthBits, index, endian);
      values.push(cell);
      if (isSymbolic) {
        const key = `${info.key}:${index}`;
        if (!this.symbolicCells.has(key) && this.symbolicCells.size >= this.maxSymbolicCells) {
          this._unknownReason = 'budget-limited';
          return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-symbolic-cell-budget', this.stats());
        }
        this.symbolicCells.set(key, cell);
      } else {
        const key = (info.value + BigInt(index)).toString();
        if (!this.cells.has(key) && this.cells.size >= this.maxConcreteBytes) {
          this._unknownReason = 'budget-limited';
          return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-concrete-byte-budget', this.stats());
        }
        this.cells.set(key, cell);
      }
      const stopped = this._guard();
      if (stopped) return stopped;
    }
    const stopped = this._record({ kind: 'store', address: info.key, widthBits, endian, bytes: values });
    if (stopped) return stopped;
    return result(MEMORY_RESULT_STATUS.EXACT, null, null, { tier: this.tier, bytes: byteCount });
  }

  write(address, value, options = {}) { return this.store(address, value, options); }

  _loadUnknown(reason, detail = null) {
    const widthBits = detail?.widthBits ?? 8;
    return result(MEMORY_RESULT_STATUS.UNKNOWN, this.expression.unknown(widthBits, reason, detail), reason, detail);
  }

  read(address, widthBits, options = {}) {
    if (widthBits && typeof widthBits === 'object' && !Array.isArray(widthBits)) {
      options = { ...widthBits, ...options };
      widthBits = options.widthBits ?? 8;
    }
    const guard = this._guard();
    if (guard) return guard;
    const width = normalizeWidthBits(widthBits, 8);
    const endian = normalizeEndian(options.endian, 'little');
    const info = addressInfo(this.expression, address);
    const relation = relationFor(options);
    const barrier = options.volatile === true || options.atomic === true || options.barrier === true || options.ordering != null;
    if (barrier) {
      this._invalidateForwarding();
      this.uncertain = true;
      this._unknownReason = options.atomic === true || options.ordering != null ? 'atomic-memory-barrier' : 'volatile-memory-barrier';
      this._promote();
      return this._loadUnknown(this._unknownReason, { widthBits: width, endian, tier: this.tier, address: info.key });
    }
    if (relation === 'may' || relation === 'unknown' || info.kind === 'unknown') {
      return this._loadUnknown(relation === 'may' ? 'symbolic-memory-may-alias' : 'unknown-memory-alias', { widthBits: width, endian, tier: this.tier });
    }
    if (info.kind === 'symbolic') this._promote();
    const byteCount = width / 8;
    const cells = [];
    for (let index = 0; index < byteCount; index++) {
      const stopped = this._guard();
      if (stopped) return stopped;
      let cell = null;
      if (info.kind === 'concrete') {
        cell = this.cells.get((info.value + BigInt(index)).toString()) ?? null;
      } else {
        cell = this.symbolicCells.get(`${info.key}:${index}`) ?? null;
        if (!cell && (options.allowUnconstrainedSymbols === true || options.allowFreshSymbols === true)) {
          if (this.symbolicCells.size >= this.maxSymbolicCells) {
            this._unknownReason = 'budget-limited';
            return result(MEMORY_RESULT_STATUS.BUDGET_LIMITED, null, 'symbolic-memory-symbolic-cell-budget', this.stats());
          }
          cell = this.expression.fresh(8, `mem_${info.key}_${index}`, { source: 'symbolic-memory-array', addressKey: info.key, byte: index });
          this.symbolicCells.set(`${info.key}:${index}`, cell);
        }
      }
      if (cell == null) {
        return this._loadUnknown(this.uncertain && this._unknownReason
          ? this._unknownReason
          : 'symbolic-memory-byte-hole', {
          widthBits: width,
          endian,
          tier: this.tier,
          address: info.key,
          missingByte: index,
        });
      }
      if (this.expression.widthOf(cell) !== 8) {
        return this._loadUnknown('symbolic-memory-byte-malformed', { widthBits: width, endian, missingByte: index });
      }
      if (this.expression.isUnknown(cell)) {
        return this._loadUnknown('symbolic-memory-byte-unknown', { widthBits: width, endian, missingByte: index });
      }
      cells.push(cell);
    }
    return result(MEMORY_RESULT_STATUS.EXACT, assemble(cells, width, endian, this.expression), null, { tier: this.tier, bytes: byteCount });
  }

  load(address, widthBits, options = {}) {
    const loaded = this.read(address, widthBits, options);
    const requestedWidth = widthBits && typeof widthBits === 'object' && !Array.isArray(widthBits)
      ? widthBits.widthBits ?? 8
      : widthBits;
    return loaded.expression ?? this.expression.unknown(normalizeWidthBits(requestedWidth, 8), loaded.reason || 'symbolic-memory-read-not-exact', loaded.detail);
  }
}

export const SymbolicByteMemory = ByteMemory;

/**
 * Consume the canonical MemorySSA producer.  A non-exact fact is returned as
 * an explicit non-exact result; callers must not fall back to location names
 * or structural reachingStore links.
 */
export function readCanonicalMemory(memorySsa, useOrId, options = {}) {
  const queryOptions = {
    ...options,
    consumerId: options.consumerId ?? CANONICAL_MEMORY_FORWARDING_CONSUMER,
    purpose: options.purpose ?? CANONICAL_MEMORY_FORWARDING_PURPOSE,
  };
  let fact;
  try {
    fact = forwardMemoryValue(memorySsa, useOrId, queryOptions);
  } catch (error) {
    let widthBits = 8;
    try { widthBits = normalizeWidthBits(options.widthBits ?? 8, 8); } catch { /* retain bounded fallback */ }
    return Object.freeze({
      status: error?.name === 'AbortError' ? MEMORY_RESULT_STATUS.CANCELLED : MEMORY_RESULT_STATUS.UNKNOWN,
      exact: false,
      expression: createUnknownSemantic({ kind: 'bv', width: widthBits }, error?.message || 'canonical-memory-forwarding-query-failed'),
      fact: null,
    });
  }
  if (!isCanonicalExactMemoryForwarding(fact, options.context ?? null)) {
    let widthBits = Number.isSafeInteger(Number(fact?.widthBits)) && Number(fact.widthBits) > 0
      ? Number(fact.widthBits) : 8;
    try { widthBits = normalizeWidthBits(widthBits, 8); } catch { widthBits = 8; }
    const status = Object.values(MEMORY_RESULT_STATUS).includes(fact?.status)
      ? fact.status : MEMORY_RESULT_STATUS.UNKNOWN;
    return Object.freeze({
      status,
      exact: false,
      expression: createUnknownSemantic({ kind: 'bv', width: widthBits }, fact?.reason || 'canonical-memory-forwarding-not-exact', {
        factStatus: fact?.status ?? null,
        factReason: fact?.reason ?? null,
      }),
      fact,
    });
  }
  return Object.freeze({
    status: MEMORY_RESULT_STATUS.EXACT,
    exact: true,
    expression: createBv(Number(fact.widthBits), fact.value),
    fact,
  });
}

export function createByteMemory(options = {}) { return new ByteMemory(options); }
