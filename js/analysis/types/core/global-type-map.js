// Cross-function global variable / data-section typed address map (§2.1).
// Supports exact lookup, range containment, shifted-pointer queries, array-stride queries,
// Data-Xref tracking (ADRP+ADD / ADRP+LDR), and monotonic confidence protection.
// Pure architecture-neutral core (INV-005).

import {
  TYPE_CONFIDENCE,
  AUTHORITY_LEVEL,
  canPromoteType,
  normalizeConfidence,
} from './safe-type-promote.js';

function toBigIntVa(va) {
  if (typeof va === 'bigint') return va;
  if (typeof va === 'number') return BigInt(Math.trunc(va));
  if (typeof va === 'string') {
    const trimmed = va.trim();
    return BigInt(trimmed);
  }
  throw new TypeError(`Invalid virtual address: ${va}`);
}

function vaKeyHex(vaBig) {
  return `0x${vaBig.toString(16)}`;
}

export class GlobalTypeMap {
  constructor() {
    /** @type {Map<bigint, object>} */
    this.entries = new Map();
    /** @type {bigint[]} sorted ascending start VAs */
    this._sortedVas = [];
    this._sortedDirty = false;
  }

  _ensureSorted() {
    if (!this._sortedDirty) return;
    this._sortedVas = [...this.entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this._sortedDirty = false;
  }

  set(va, spec = {}, options = {}) {
    const vaBig = toBigIntVa(va);
    const existing = this.entries.get(vaBig);
    const curConf = existing ? normalizeConfidence(existing.confidence) : TYPE_CONFIDENCE.UNKNOWN;
    const incConf = normalizeConfidence(spec.confidence ?? TYPE_CONFIDENCE.HEURISTIC);

    if (existing && !canPromoteType(curConf, incConf, options)) {
      return {
        ok: false,
        reason: curConf === TYPE_CONFIDENCE.USER_PINNED ? 'user_pinned_protected' : 'lower_confidence',
        entry: existing,
      };
    }

    const arrayLen = Math.max(0, Number(spec.arrayLen ?? existing?.arrayLen ?? 0) | 0);
    const elementStride = Math.max(
      1,
      Number(spec.elementStride ?? spec.stride ?? spec.byteSize ?? existing?.elementStride ?? 8) | 0
    );
    const byteSize =
      Number(spec.byteSize) > 0
        ? Number(spec.byteSize)
        : arrayLen > 0
          ? arrayLen * elementStride
          : elementStride;

    const entry = {
      va: vaBig,
      vaHex: vaKeyHex(vaBig),
      hexTypeId: spec.hexTypeId ?? existing?.hexTypeId ?? 0,
      typeName: spec.typeName ?? existing?.typeName ?? 'uint64_t',
      name: spec.name ?? existing?.name ?? `g_${vaBig.toString(16)}`,
      byteSize,
      arrayLen,
      elementStride,
      authority:
        incConf === TYPE_CONFIDENCE.USER_PINNED
          ? AUTHORITY_LEVEL.USER_MANUAL
          : spec.authority ?? existing?.authority ?? AUTHORITY_LEVEL.AUTO_TYPE,
      confidence: incConf,
      structSeedId: spec.structSeedId ?? existing?.structSeedId ?? null,
      shiftDelta: Number(spec.shiftDelta ?? existing?.shiftDelta ?? 0),
      xrefs: existing?.xrefs ? new Map(existing.xrefs) : new Map(),
    };

    if (!existing) this._sortedDirty = true;
    this.entries.set(vaBig, entry);
    return { ok: true, entry };
  }

  get(va) {
    return this.entries.get(toBigIntVa(va)) || null;
  }

  delete(va) {
    const vaBig = toBigIntVa(va);
    const existed = this.entries.delete(vaBig);
    if (existed) this._sortedDirty = true;
    return existed;
  }

  addXref(va, funcId, accessKind = 'adrp_add') {
    const vaBig = toBigIntVa(va);
    let entry = this.entries.get(vaBig);
    if (!entry) {
      this.set(vaBig, { confidence: TYPE_CONFIDENCE.UNKNOWN });
      entry = this.entries.get(vaBig);
    }
    entry.xrefs.set(funcId, accessKind);
    return entry;
  }

  getXrefs(va) {
    const entry = this.get(va);
    if (!entry) return [];
    return [...entry.xrefs.entries()].map(([funcId, accessKind]) => ({ funcId, accessKind }));
  }

  /**
   * Binary-search containing global entry for any address inside [entry.va, entry.va + entry.byteSize).
   * Resolves array element index and inner offset when `arrayLen > 0`.
   */
  queryAddress(va) {
    this._ensureSorted();
    const target = toBigIntVa(va);
    const vas = this._sortedVas;
    if (vas.length === 0) return null;

    let lo = 0;
    let hi = vas.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (vas[mid] <= target) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best < 0) return null;

    const baseVa = vas[best];
    const entry = this.entries.get(baseVa);
    const offset = Number(target - baseVa);
    if (offset < 0 || offset >= entry.byteSize) return null;

    const isArray = entry.arrayLen > 0 && entry.elementStride > 0;
    const arrayIndex = isArray ? Math.floor(offset / entry.elementStride) : null;
    const elementOffset = isArray ? offset % entry.elementStride : offset;

    return {
      entry,
      baseVa,
      queryVa: target,
      offset,
      isArray,
      arrayIndex,
      elementOffset,
    };
  }

  /**
   * Resolve a shifted pointer query (`__shifted(T, delta)`): subtracts delta to locate
   * the containing parent global object and reports parent base + field offset.
   */
  queryShifted(ptrVa, shiftDelta) {
    const ptrBig = toBigIntVa(ptrVa);
    const delta = BigInt(Math.trunc(Number(shiftDelta || 0)));
    const adjustedVa = ptrBig - delta;
    if (adjustedVa < 0n) return null;
    const hit = this.queryAddress(adjustedVa);
    if (!hit) return null;
    return {
      ...hit,
      ptrVa: ptrBig,
      shiftDelta: Number(delta),
      adjustedVa,
      memberOffset: Number(ptrBig - hit.baseVa),
    };
  }

  /**
   * Resolve an array element address and metadata given base VA + element index.
   */
  queryArrayElement(baseVa, index) {
    const entry = this.get(baseVa);
    if (!entry || entry.arrayLen <= 0) return null;
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= entry.arrayLen) return null;
    const elemVa = entry.va + BigInt(idx * entry.elementStride);
    return {
      entry,
      baseVa: entry.va,
      elementVa: elemVa,
      elementVaHex: vaKeyHex(elemVa),
      index: idx,
      stride: entry.elementStride,
    };
  }

  /**
   * Persist into `notes.types["data:<va>"]` format (§2.1).
   */
  toNotesTypes() {
    this._ensureSorted();
    const out = {};
    for (const va of this._sortedVas) {
      const e = this.entries.get(va);
      out[`data:${e.vaHex}`] = {
        hexTypeId: e.hexTypeId,
        typeName: e.typeName,
        name: e.name,
        byteSize: e.byteSize,
        arrayLen: e.arrayLen,
        elementStride: e.elementStride,
        authority: e.authority,
        confidence: e.confidence,
        structSeedId: e.structSeedId,
      };
    }
    return out;
  }

  static fromNotesTypes(notesTypes) {
    const map = new GlobalTypeMap();
    if (!notesTypes || typeof notesTypes !== 'object') return map;
    for (const [k, v] of Object.entries(notesTypes)) {
      if (!k.startsWith('data:')) continue;
      const vaStr = k.slice('data:'.length);
      map.set(vaStr, v);
    }
    return map;
  }

  get size() {
    return this.entries.size;
  }
}
