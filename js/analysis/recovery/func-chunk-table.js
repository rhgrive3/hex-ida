// JS-parity discontiguous function chunk registry (§15.2).
// Manages primary entry + tail/cold/outline chunks, O(log N) owner lookup,
// adjacent range merge, detach blocklist, and 24B HexFuncChunkRange / 32B HexFuncChunk WASM export.
// Pure architecture-neutral core (INV-005: zero imports from js/targets/architecture/).

export const FUNC_CHUNK_KIND = Object.freeze({
  PRIMARY: 0,
  COLD_BLOCK: 1,
  TAIL_CALL: 2,
  OUTLINE: 3,
  LSDA_LP: 4,
});

export const CHUNK_FLAGS = Object.freeze({
  MANUAL: 1 << 0,
  UNWIND_COLD: 1 << 1,
  OUTLINED_TAIL: 1 << 2,
  LSDA_LP: 1 << 3,
  DETACHED: 1 << 4,
});

export const FUNC_CHUNK_RANGE_BYTES = 24;
export const FUNC_CHUNK_BYTES = 32;
export const DEFAULT_MAX_CHUNKS_MOBILE = 16;
export const DEFAULT_MAX_CHUNKS_DESKTOP = 64;

function toBigIntVa(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v.trim());
  throw new TypeError(`Invalid VA: ${v}`);
}

function rangeKey(startVa, endVa) {
  return `${startVa.toString(16)}:${endVa.toString(16)}`;
}

function resolveChunkKindNum(spec, isPrimary) {
  if (Number.isInteger(spec.chunkKind ?? spec.chunk_kind)) {
    return Number(spec.chunkKind ?? spec.chunk_kind) >>> 0;
  }
  if (isPrimary || spec.kind === 'primary') return FUNC_CHUNK_KIND.PRIMARY;
  if (spec.kind === 'tail_call' || spec.kind === 'outlined_tail') return FUNC_CHUNK_KIND.TAIL_CALL;
  if (spec.kind === 'outline') return FUNC_CHUNK_KIND.OUTLINE;
  if (spec.kind === 'lsda_lp') return FUNC_CHUNK_KIND.LSDA_LP;
  return FUNC_CHUNK_KIND.COLD_BLOCK;
}

export class FuncChunkTable {
  constructor(options = {}) {
    this.maxChunksCap = options.maxChunksCap ?? DEFAULT_MAX_CHUNKS_DESKTOP;
    this.archAdapter = options.archAdapter || null;
    /** @type {Map<bigint, Array<object>>} ownerFuncVa -> chunks */
    this.byOwner = new Map();
    /** @type {Array<object>} globally sorted ascending by startVa */
    this.globalIndex = [];
    /** @type {Set<string>} detached chunk range keys blocked from auto-reattach */
    this.detachedBlocklist = new Set();
  }

  _lowerBoundGlobal(vaBig) {
    let lo = 0;
    let hi = this.globalIndex.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.globalIndex[mid].startVa < vaBig) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _rebuildOwnerOrds(ownerVa) {
    const list = this.byOwner.get(ownerVa);
    if (!list) return;
    list.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.startVa < b.startVa ? -1 : a.startVa > b.startVa ? 1 : 0;
    });
    for (let i = 0; i < list.length; i++) {
      list[i].chunkOrd = i;
    }
  }

  /**
   * Attach a primary or secondary (tail/cold/outline/LP) chunk to `ownerFuncVa`.
   */
  attachChunk(ownerFuncVa, chunkSpec, options = {}) {
    const ownerVa = toBigIntVa(ownerFuncVa);
    const startVa = toBigIntVa(chunkSpec.startVa ?? chunkSpec.start_va);
    const endVa = toBigIntVa(chunkSpec.endVa ?? chunkSpec.end_va);
    if (endVa <= startVa) {
      return { ok: false, reason: 'invalid_range' };
    }
    if (
      this.archAdapter &&
      typeof this.archAdapter.isCodeAligned === 'function' &&
      (!this.archAdapter.isCodeAligned(startVa) || !this.archAdapter.isCodeAligned(endVa))
    ) {
      return { ok: false, reason: 'unaligned_chunk_range' };
    }

    const flags = Number(chunkSpec.chunkFlags ?? chunkSpec.chunk_flags ?? chunkSpec.flags ?? 0) >>> 0;
    const isManual = (flags & CHUNK_FLAGS.MANUAL) !== 0 || Boolean(options.manual);
    const key = rangeKey(startVa, endVa);
    if (!isManual && this.detachedBlocklist.has(key)) {
      return { ok: false, reason: 'detached_by_user' };
    }

    const idx = this._lowerBoundGlobal(startVa);
    if (idx > 0 && this.globalIndex[idx - 1].endVa > startVa) {
      return { ok: false, reason: 'chunk_overlap', conflict: this.globalIndex[idx - 1] };
    }
    if (idx < this.globalIndex.length && this.globalIndex[idx].startVa < endVa) {
      return { ok: false, reason: 'chunk_overlap', conflict: this.globalIndex[idx] };
    }

    let ownerList = this.byOwner.get(ownerVa);
    if (!ownerList) {
      ownerList = [];
      this.byOwner.set(ownerVa, ownerList);
    }
    if (ownerList.length >= this.maxChunksCap) {
      return { ok: false, reason: 'max_chunks_cap_exceeded', cap: this.maxChunksCap };
    }

    if (isManual) this.detachedBlocklist.delete(key);

    const isPrimary = Boolean(chunkSpec.isPrimary ?? startVa === ownerVa);
    const chunkKind = resolveChunkKindNum(chunkSpec, isPrimary);

    const chunk = {
      ownerFuncVa: ownerVa,
      startVa,
      endVa,
      rawOffset: Number(chunkSpec.rawOffset ?? chunkSpec.raw_offset ?? 0) >>> 0,
      chunkOrd: 0,
      chunkKind,
      chunkFlags: (isManual ? flags | CHUNK_FLAGS.MANUAL : flags) >>> 0,
      isPrimary,
      kind: chunkSpec.kind || (isPrimary ? 'primary' : 'cold'),
    };

    ownerList.push(chunk);
    this._rebuildOwnerOrds(ownerVa);
    this.globalIndex.splice(idx, 0, chunk);
    return { ok: true, chunk };
  }

  /**
   * Detach a chunk from `ownerFuncVa` and add it to the blocklist to prevent auto-reattach.
   */
  detachChunk(ownerFuncVa, startVa, endVa = null) {
    const ownerVa = toBigIntVa(ownerFuncVa);
    const s = toBigIntVa(startVa);
    const list = this.byOwner.get(ownerVa);
    if (!list) return { ok: false, reason: 'owner_not_found' };
    const pos = list.findIndex(
      (c) => c.startVa === s && (endVa === null || c.endVa === toBigIntVa(endVa))
    );
    if (pos < 0) return { ok: false, reason: 'chunk_not_found' };
    const [removed] = list.splice(pos, 1);
    removed.chunkFlags = (removed.chunkFlags | CHUNK_FLAGS.DETACHED) >>> 0;
    this._rebuildOwnerOrds(ownerVa);
    if (list.length === 0) this.byOwner.delete(ownerVa);

    const gIdx = this.globalIndex.indexOf(removed);
    if (gIdx >= 0) this.globalIndex.splice(gIdx, 1);
    this.detachedBlocklist.add(rangeKey(removed.startVa, removed.endVa));
    return { ok: true, removed };
  }

  /**
   * O(log N) lookup returning the owning function VA and chunk containing `va`.
   */
  lookupOwner(va) {
    const vaBig = toBigIntVa(va);
    const idx = this._lowerBoundGlobal(vaBig);
    if (idx < this.globalIndex.length && this.globalIndex[idx].startVa === vaBig) {
      const chunk = this.globalIndex[idx];
      return { ownerFuncVa: chunk.ownerFuncVa, chunk };
    }
    if (idx > 0) {
      const prev = this.globalIndex[idx - 1];
      if (vaBig >= prev.startVa && vaBig < prev.endVa) {
        return { ownerFuncVa: prev.ownerFuncVa, chunk: prev };
      }
    }
    return null;
  }

  getChunks(ownerFuncVa) {
    const ownerVa = toBigIntVa(ownerFuncVa);
    const list = this.byOwner.get(ownerVa);
    return list ? list.slice() : [];
  }

  /**
   * Merge contiguous chunks belonging to `ownerFuncVa` when `prev.endVa === next.startVa`.
   */
  mergeAdjacentRanges(ownerFuncVa) {
    const ownerVa = toBigIntVa(ownerFuncVa);
    const list = this.byOwner.get(ownerVa);
    if (!list || list.length < 2) return { mergedCount: 0, chunks: list ? list.slice() : [] };

    const sortedByVa = list
      .slice()
      .sort((a, b) => (a.startVa < b.startVa ? -1 : a.startVa > b.startVa ? 1 : 0));

    const merged = [sortedByVa[0]];
    let mergedCount = 0;
    for (let i = 1; i < sortedByVa.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = sortedByVa[i];
      if (prev.endVa === curr.startVa) {
        prev.endVa = curr.endVa;
        prev.chunkFlags = (prev.chunkFlags | curr.chunkFlags) >>> 0;
        prev.isPrimary = prev.isPrimary || curr.isPrimary;
        mergedCount += 1;
      } else {
        merged.push(curr);
      }
    }

    if (mergedCount > 0) {
      this.byOwner.set(ownerVa, merged);
      this._rebuildOwnerOrds(ownerVa);
      this.globalIndex = this.globalIndex.filter((c) => c.ownerFuncVa !== ownerVa);
      this.globalIndex.push(...merged);
      this.globalIndex.sort((a, b) => (a.startVa < b.startVa ? -1 : a.startVa > b.startVa ? 1 : 0));
    }

    return { mergedCount, chunks: this.getChunks(ownerVa) };
  }

  /**
   * Auto-attach outlined tail/cold chunks using injected architecture adapter (§15.2 Fail-Closed 4 conditions).
   */
  attachOutlinedCandidates(ownerFuncVa, candidates, archAdapter = this.archAdapter) {
    const ownerVa = toBigIntVa(ownerFuncVa);
    const attached = [];
    const rejected = [];
    for (const cand of candidates || []) {
      if (cand.isExported || cand.isManualFuncStart || cand.inDegree !== 1) {
        rejected.push({ cand, reason: 'fail_closed_gate' });
        continue;
      }
      if (archAdapter && typeof archAdapter.detectTailCallOrThunk === 'function') {
        const verdict = archAdapter.detectTailCallOrThunk(cand.insns || [], {
          startVa: ownerVa,
          endVa: cand.ownerEndVa ?? ownerVa,
        });
        if (verdict.hasPrologue || !verdict.isOutlinedColdCandidate) {
          rejected.push({ cand, reason: 'arch_adapter_rejected' });
          continue;
        }
      }
      const res = this.attachChunk(ownerVa, {
        startVa: cand.startVa,
        endVa: cand.endVa,
        chunkKind: FUNC_CHUNK_KIND.TAIL_CALL,
        chunkFlags: CHUNK_FLAGS.OUTLINED_TAIL,
        kind: 'outlined_tail',
      });
      if (res.ok) attached.push(res.chunk);
      else rejected.push({ cand, reason: res.reason });
    }
    return { attached, rejected };
  }

  /**
   * Export chunks for an owner function into 24B HexFuncChunkRange POD buffer (§15.2).
   */
  exportChunkRangesWasm(ownerFuncVa) {
    const chunks = this.getChunks(ownerFuncVa);
    const buf = new ArrayBuffer(chunks.length * FUNC_CHUNK_RANGE_BYTES);
    const dv = new DataView(buf);
    let rawOff = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const base = i * FUNC_CHUNK_RANGE_BYTES;
      dv.setBigUint64(base + 0x00, BigInt.asUintN(64, c.startVa), true);
      dv.setBigUint64(base + 0x08, BigInt.asUintN(64, c.endVa), true);
      dv.setUint32(base + 0x10, (c.rawOffset || rawOff) >>> 0, true);
      dv.setUint16(base + 0x14, c.chunkOrd & 0xffff, true);
      dv.setUint16(base + 0x16, c.chunkFlags & 0xffff, true);
      rawOff += Number(c.endVa - c.startVa);
    }
    return new Uint8Array(buf);
  }

  /**
   * Export chunks (either for a single owner or all owners) into 32B HexFuncChunk POD buffer
   * matching C++ `hex_manual_recovery.hpp:106-112`.
   */
  exportChunksWasm32(ownerFuncVa = null) {
    const list =
      ownerFuncVa !== null && ownerFuncVa !== undefined
        ? this.getChunks(ownerFuncVa)
        : this.globalIndex.slice();
    const buf = new ArrayBuffer(list.length * FUNC_CHUNK_BYTES);
    const dv = new DataView(buf);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const base = i * FUNC_CHUNK_BYTES;
      dv.setBigUint64(base + 0x00, BigInt.asUintN(64, c.ownerFuncVa), true);
      dv.setBigUint64(base + 0x08, BigInt.asUintN(64, c.startVa), true);
      dv.setBigUint64(base + 0x10, BigInt.asUintN(64, c.endVa), true);
      dv.setUint32(base + 0x18, (c.chunkKind ?? 0) >>> 0, true);
      dv.setUint32(base + 0x1c, (c.chunkFlags ?? 0) >>> 0, true);
    }
    return new Uint8Array(buf);
  }

  static importChunksWasm32(bytes, options = {}) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteLength % FUNC_CHUNK_BYTES !== 0) {
      throw new Error(`Invalid HexFuncChunk 32B buffer size: ${u8.byteLength}`);
    }
    const table = new FuncChunkTable(options);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = u8.byteLength / FUNC_CHUNK_BYTES;
    for (let i = 0; i < count; i++) {
      const base = i * FUNC_CHUNK_BYTES;
      const ownerFuncVa = dv.getBigUint64(base + 0x00, true);
      const startVa = dv.getBigUint64(base + 0x08, true);
      const endVa = dv.getBigUint64(base + 0x10, true);
      const chunkKind = dv.getUint32(base + 0x18, true);
      const chunkFlags = dv.getUint32(base + 0x1c, true);
      const res = table.attachChunk(ownerFuncVa, {
        startVa,
        endVa,
        chunkKind,
        chunkFlags,
        isPrimary: chunkKind === FUNC_CHUNK_KIND.PRIMARY,
      });
      if (!res.ok) {
        throw new Error(`Failed importing HexFuncChunk ${i}: ${res.reason}`);
      }
    }
    return table;
  }
}
