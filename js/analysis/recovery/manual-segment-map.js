// JS-parity sorted non-overlapping Manual Segment Map (§15.1).
// Supports 1-byte code/data/string/align overrides, va <-> fileOffset mapping,
// overlap rejection, 24B HexManualSegEntry & 40B HexManualSegment POD export to WASM Slot 5A.
// Pure architecture-neutral core (INV-005: zero imports from js/targets/architecture/).

export const MANUAL_SEG_KIND = Object.freeze({
  UNDEF: 0,
  CODE: 1,
  DATA_U8: 2,
  DATA_U16: 3,
  DATA_U32: 4,
  DATA_U64: 5,
  STR: 6,
  ALIGN: 7,
});

export const MANUAL_SEG_PERM = Object.freeze({
  R: 1 << 0,
  W: 1 << 1,
  X: 1 << 2,
});

export const MANUAL_SEG_FLAGS = Object.freeze({
  FUNC_START: 1 << 0,
  FUNC_END: 1 << 1,
  OFFSET_REF: 1 << 2,
  OFFSET_REL: 1 << 3,
  BIG_ENDIAN: 1 << 4,
  LOCK_AUTO_DISCOVERY: 1 << 5,
  BSS_ZERO: 1 << 6,
});

export const STR_ENCODING = Object.freeze({
  UTF8_ASCII: 0,
  UTF16LE: 1,
  FIXED: 2,
  PASCAL: 3,
});

export const MANUAL_SEG_NO_FILE = 0xffffffffffffffffn;
export const MANUAL_NAME_NONE = 0xffffffff;
export const MANUAL_SEG_ENTRY_BYTES = 24;
export const MANUAL_SEGMENT_BYTES = 40;
export const MAX_MANUAL_SEGMENTS = 8192;

function toBigIntVa(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v.trim());
  throw new TypeError(`Invalid VA: ${v}`);
}

function defaultElemSizeForKind(kind) {
  switch (kind) {
    case MANUAL_SEG_KIND.DATA_U16:
      return 2;
    case MANUAL_SEG_KIND.CODE:
    case MANUAL_SEG_KIND.DATA_U32:
      return 4;
    case MANUAL_SEG_KIND.DATA_U64:
      return 8;
    default:
      return 1;
  }
}

function defaultPermsForKind(kind) {
  if (kind === MANUAL_SEG_KIND.CODE) return MANUAL_SEG_PERM.R | MANUAL_SEG_PERM.X;
  if (kind === MANUAL_SEG_KIND.UNDEF) return MANUAL_SEG_PERM.R;
  return MANUAL_SEG_PERM.R | MANUAL_SEG_PERM.W;
}

export class ManualSegmentMap {
  constructor(options = {}) {
    /** @type {Array<object>} sorted ascending by startVa, strictly non-overlapping */
    this.entries = [];
    this.maxSegments = options.maxSegments ?? MAX_MANUAL_SEGMENTS;
    this.archAdapter = options.archAdapter || null;
  }

  get size() {
    return this.entries.length;
  }

  _lowerBound(vaBig) {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid].startVa < vaBig) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Insert a manual segment entry. Rejects overlapping intervals by default.
   * For CODE segments, validates alignment via injected `archAdapter.isCodeAligned` if provided.
   */
  add(spec, options = {}) {
    const startVa = toBigIntVa(spec.startVa ?? spec.start_va ?? spec.baseVa ?? spec.base_va);
    const byteLen = Number(spec.byteLen ?? spec.byte_len ?? spec.size ?? 0);
    const kind = Number(spec.kind ?? spec.segKind ?? spec.seg_kind ?? MANUAL_SEG_KIND.UNDEF);
    if (!Number.isInteger(byteLen) || byteLen < 1) {
      return { ok: false, reason: 'invalid_byte_len' };
    }
    if (!Number.isInteger(kind) || kind < MANUAL_SEG_KIND.UNDEF || kind > MANUAL_SEG_KIND.ALIGN) {
      return { ok: false, reason: 'invalid_kind' };
    }
    if (
      kind === MANUAL_SEG_KIND.CODE &&
      this.archAdapter &&
      typeof this.archAdapter.isCodeAligned === 'function' &&
      !this.archAdapter.isCodeAligned(startVa)
    ) {
      return { ok: false, reason: 'unaligned_code_segment' };
    }

    const endVa = startVa + BigInt(byteLen);
    const rawFileOff = spec.fileOffset ?? spec.file_offset;
    const fileOffset =
      rawFileOff !== undefined && rawFileOff !== null && BigInt(rawFileOff) !== MANUAL_SEG_NO_FILE
        ? toBigIntVa(rawFileOff)
        : null;

    const conflicts = this.queryRange(startVa, endVa);
    if (conflicts.length > 0) {
      if (!options.replaceOverlapping) {
        return { ok: false, reason: 'segment_overlap', conflicts };
      }
      const conflictSet = new Set(conflicts);
      this.entries = this.entries.filter((e) => !conflictSet.has(e));
    }

    if (this.entries.length >= this.maxSegments) {
      return { ok: false, reason: 'max_segments_exceeded' };
    }

    const entry = {
      startVa,
      endVa,
      byteLen,
      kind,
      elemSize: Number(spec.elemSize ?? spec.elem_size ?? defaultElemSizeForKind(kind)) & 0xff,
      strEncoding: Number(spec.strEncoding ?? spec.str_encoding ?? 0) & 0xff,
      alignPow2: Number(spec.alignPow2 ?? spec.align_pow2 ?? 0) & 0xff,
      perms: Number(spec.perms ?? defaultPermsForKind(kind)) >>> 0,
      flags: Number(spec.flags ?? 0) >>> 0,
      nameOff: Number(spec.nameOff ?? spec.name_off ?? MANUAL_NAME_NONE) >>> 0,
      offsetBaseRel: Number(spec.offsetBaseRel ?? spec.offset_base_rel ?? 0) | 0,
      fileOffset,
    };

    const idx = this._lowerBound(startVa);
    this.entries.splice(idx, 0, entry);
    return { ok: true, entry, replacedCount: conflicts.length };
  }

  remove(startVa) {
    const vaBig = toBigIntVa(startVa);
    const idx = this._lowerBound(vaBig);
    if (idx < this.entries.length && this.entries[idx].startVa === vaBig) {
      const [removed] = this.entries.splice(idx, 1);
      return { ok: true, removed };
    }
    return { ok: false, reason: 'not_found' };
  }

  /**
   * Binary-search the manual segment containing `va` (half-open [startVa, endVa)).
   */
  queryVa(va) {
    const vaBig = toBigIntVa(va);
    const idx = this._lowerBound(vaBig);
    if (idx < this.entries.length && this.entries[idx].startVa === vaBig) {
      return this.entries[idx];
    }
    if (idx > 0) {
      const prev = this.entries[idx - 1];
      if (vaBig >= prev.startVa && vaBig < prev.endVa) return prev;
    }
    return null;
  }

  queryRange(startVa, endVa) {
    const s = toBigIntVa(startVa);
    const e = toBigIntVa(endVa);
    if (e <= s) return [];
    const out = [];
    let idx = Math.max(0, this._lowerBound(s) - 1);
    while (idx < this.entries.length) {
      const seg = this.entries[idx];
      if (seg.startVa >= e) break;
      if (seg.endVa > s) out.push(seg);
      idx += 1;
    }
    return out;
  }

  vaToFileOffset(va) {
    const vaBig = toBigIntVa(va);
    const seg = this.queryVa(vaBig);
    if (!seg || seg.fileOffset === null) return null;
    return seg.fileOffset + (vaBig - seg.startVa);
  }

  fileOffsetToVa(fileOffset) {
    const offBig = toBigIntVa(fileOffset);
    for (const seg of this.entries) {
      if (seg.fileOffset === null) continue;
      const segEndOff = seg.fileOffset + BigInt(seg.byteLen);
      if (offBig >= seg.fileOffset && offBig < segEndOff) {
        return seg.startVa + (offBig - seg.fileOffset);
      }
    }
    return null;
  }

  /**
   * Export sorted entries to exact 24B little-endian HexManualSegEntry POD buffer (§15.1).
   */
  exportWasmSlot5A() {
    const buf = new ArrayBuffer(this.entries.length * MANUAL_SEG_ENTRY_BYTES);
    const dv = new DataView(buf);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const base = i * MANUAL_SEG_ENTRY_BYTES;
      dv.setBigUint64(base + 0x00, BigInt.asUintN(64, e.startVa), true);
      dv.setUint32(base + 0x08, e.byteLen >>> 0, true);
      dv.setUint8(base + 0x0c, e.kind & 0xff);
      dv.setUint8(base + 0x0d, e.elemSize & 0xff);
      dv.setUint8(base + 0x0e, e.strEncoding & 0xff);
      dv.setUint8(base + 0x0f, e.alignPow2 & 0xff);
      dv.setUint32(base + 0x10, e.flags >>> 0, true);
      dv.setInt32(base + 0x14, e.offsetBaseRel | 0, true);
    }
    return new Uint8Array(buf);
  }

  static importWasmSlot5A(bytes, options = {}) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteLength % MANUAL_SEG_ENTRY_BYTES !== 0) {
      throw new Error(`Invalid Slot 5A buffer size: ${u8.byteLength}`);
    }
    const map = new ManualSegmentMap(options);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = u8.byteLength / MANUAL_SEG_ENTRY_BYTES;
    for (let i = 0; i < count; i++) {
      const base = i * MANUAL_SEG_ENTRY_BYTES;
      const res = map.add({
        startVa: dv.getBigUint64(base + 0x00, true),
        byteLen: dv.getUint32(base + 0x08, true),
        kind: dv.getUint8(base + 0x0c),
        elemSize: dv.getUint8(base + 0x0d),
        strEncoding: dv.getUint8(base + 0x0e),
        alignPow2: dv.getUint8(base + 0x0f),
        flags: dv.getUint32(base + 0x10, true),
        offsetBaseRel: dv.getInt32(base + 0x14, true),
      });
      if (!res.ok) {
        throw new Error(`Failed importing Slot 5A entry ${i}: ${res.reason}`);
      }
    }
    return map;
  }

  /**
   * Export sorted entries to exact 40B little-endian HexManualSegment POD buffer
   * matching C++ `hex_manual_recovery.hpp:49-60`.
   */
  exportWasmSegments40() {
    const buf = new ArrayBuffer(this.entries.length * MANUAL_SEGMENT_BYTES);
    const dv = new DataView(buf);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const base = i * MANUAL_SEGMENT_BYTES;
      dv.setBigUint64(base + 0x00, BigInt.asUintN(64, e.startVa), true);
      dv.setBigUint64(base + 0x08, BigInt.asUintN(64, BigInt(e.byteLen)), true);
      dv.setBigUint64(
        base + 0x10,
        e.fileOffset !== null ? BigInt.asUintN(64, e.fileOffset) : MANUAL_SEG_NO_FILE,
        true
      );
      dv.setUint32(base + 0x18, e.perms >>> 0, true);
      dv.setUint32(base + 0x1c, e.flags >>> 0, true);
      dv.setUint32(base + 0x20, e.nameOff >>> 0, true);
      dv.setUint8(base + 0x24, e.kind & 0xff);
      dv.setUint8(base + 0x25, e.elemSize & 0xff);
      dv.setUint8(base + 0x26, e.alignPow2 & 0xff);
      dv.setUint8(base + 0x27, 0);
    }
    return new Uint8Array(buf);
  }

  static importWasmSegments40(bytes, options = {}) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteLength % MANUAL_SEGMENT_BYTES !== 0) {
      throw new Error(`Invalid HexManualSegment 40B buffer size: ${u8.byteLength}`);
    }
    const map = new ManualSegmentMap(options);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = u8.byteLength / MANUAL_SEGMENT_BYTES;
    for (let i = 0; i < count; i++) {
      const base = i * MANUAL_SEGMENT_BYTES;
      const fileOff = dv.getBigUint64(base + 0x10, true);
      const res = map.add({
        startVa: dv.getBigUint64(base + 0x00, true),
        byteLen: Number(dv.getBigUint64(base + 0x08, true)),
        fileOffset: fileOff === MANUAL_SEG_NO_FILE ? null : fileOff,
        perms: dv.getUint32(base + 0x18, true),
        flags: dv.getUint32(base + 0x1c, true),
        nameOff: dv.getUint32(base + 0x20, true),
        kind: dv.getUint8(base + 0x24),
        elemSize: dv.getUint8(base + 0x25),
        alignPow2: dv.getUint8(base + 0x26),
      });
      if (!res.ok) {
        throw new Error(`Failed importing HexManualSegment ${i}: ${res.reason}`);
      }
    }
    return map;
  }

  clear() {
    this.entries.length = 0;
  }
}
