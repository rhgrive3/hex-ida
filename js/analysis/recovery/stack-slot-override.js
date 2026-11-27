// Per-function stack-slot type/name/split override registry (§15.4).
// Supports force_split, force_merge, SP vs FP-relative offsets, and 24B HexStackSlotOverride POD export.
// Pure architecture-neutral core (INV-005: zero imports from js/targets/architecture/).

export const STACK_SLOT_FLAGS = Object.freeze({
  FORCE_SPLIT: 1 << 0,
  FORCE_MERGE: 1 << 1,
  NO_REG_PROMOTE: 1 << 2,
  FP_REL: 1 << 3,
});

export const STACK_SLOT_OVERRIDE_BYTES = 24;

function toBigIntVa(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v.trim());
  throw new TypeError(`Invalid VA: ${v}`);
}

export class StackSlotOverrideRegistry {
  constructor() {
    /** @type {Map<bigint, Array<object>>} funcVa -> sorted overrides */
    this.byFunc = new Map();
  }

  _getList(funcVa) {
    const vaBig = toBigIntVa(funcVa);
    let list = this.byFunc.get(vaBig);
    if (!list) {
      list = [];
      this.byFunc.set(vaBig, list);
    }
    return list;
  }

  _sortList(list) {
    list.sort((a, b) => {
      const aFp = (a.slotFlags & STACK_SLOT_FLAGS.FP_REL) !== 0 ? 1 : 0;
      const bFp = (b.slotFlags & STACK_SLOT_FLAGS.FP_REL) !== 0 ? 1 : 0;
      return aFp - bFp || a.spOffset - b.spOffset;
    });
  }

  setOverride(funcVa, spec, options = {}) {
    const spOffset = Number(spec.spOffset ?? spec.sp_offset);
    const byteSize = Number(spec.byteSize ?? spec.byte_size);
    if (!Number.isInteger(spOffset)) return { ok: false, reason: 'invalid_sp_offset' };
    if (!Number.isInteger(byteSize) || byteSize < 1) return { ok: false, reason: 'invalid_byte_size' };

    const slotFlags = Number(spec.slotFlags ?? spec.slot_flags ?? 0) >>> 0;
    const isFpRel = (slotFlags & STACK_SLOT_FLAGS.FP_REL) !== 0;
    const list = this._getList(funcVa);
    const newStart = spOffset;
    const newEnd = spOffset + byteSize;

    const conflicts = list.filter((e) => {
      const eFp = (e.slotFlags & STACK_SLOT_FLAGS.FP_REL) !== 0;
      if (eFp !== isFpRel) return false;
      return e.spOffset < newEnd && e.spOffset + e.byteSize > newStart;
    });

    if (conflicts.length > 0 && !options.replaceOverlapping) {
      const exactOnly =
        conflicts.length === 1 &&
        conflicts[0].spOffset === newStart &&
        conflicts[0].byteSize === byteSize;
      if (!exactOnly) {
        return { ok: false, reason: 'slot_overlap', conflicts };
      }
    }

    const conflictSet = new Set(conflicts);
    const filtered = list.filter((e) => !conflictSet.has(e));
    const entry = {
      spOffset,
      byteSize,
      hexTypeId: Number(spec.hexTypeId ?? spec.hex_type_id ?? 0) >>> 0,
      typeName: spec.typeName || null,
      arrayLen: Number(spec.arrayLen ?? spec.array_len ?? 0) >>> 0,
      slotFlags,
      name: spec.name ?? null,
      nameOff: spec.nameOff ?? 0xffffffff,
    };
    filtered.push(entry);
    this._sortList(filtered);
    this.byFunc.set(toBigIntVa(funcVa), filtered);
    return { ok: true, entry, replacedCount: conflicts.length };
  }

  /**
   * Split an existing stack slot into sub-slots at relative split sizes or child specs.
   */
  splitSlot(funcVa, spOffset, subSlots, options = {}) {
    const fpRel = Boolean(options.fpRel);
    const list = this._getList(funcVa);
    const existing = list.find(
      (e) => e.spOffset === spOffset && (((e.slotFlags & STACK_SLOT_FLAGS.FP_REL) !== 0) === fpRel)
    );
    if (!existing) return { ok: false, reason: 'slot_not_found' };
    if (!Array.isArray(subSlots) || subSlots.length < 2) {
      return { ok: false, reason: 'need_at_least_two_subslots' };
    }

    const totalSize = subSlots.reduce((s, x) => s + Number(x.byteSize || 0), 0);
    if (totalSize !== existing.byteSize) {
      return { ok: false, reason: 'split_size_mismatch', expected: existing.byteSize, actual: totalSize };
    }

    const remaining = list.filter((e) => e !== existing);
    let cursor = existing.spOffset;
    const created = [];
    for (let i = 0; i < subSlots.length; i++) {
      const sub = subSlots[i];
      const entry = {
        spOffset: cursor,
        byteSize: Number(sub.byteSize),
        hexTypeId: Number(sub.hexTypeId ?? 0) >>> 0,
        typeName: sub.typeName || `uint${Math.min(64, sub.byteSize * 8)}_t`,
        arrayLen: Number(sub.arrayLen ?? 0) >>> 0,
        slotFlags:
          ((sub.slotFlags ?? 0) |
            STACK_SLOT_FLAGS.FORCE_SPLIT |
            (fpRel ? STACK_SLOT_FLAGS.FP_REL : 0)) >>>
          0,
        name: sub.name || `${existing.name || 'var'}_${i}`,
        nameOff: sub.nameOff ?? 0xffffffff,
      };
      remaining.push(entry);
      created.push(entry);
      cursor += entry.byteSize;
    }

    this._sortList(remaining);
    this.byFunc.set(toBigIntVa(funcVa), remaining);
    return { ok: true, slots: created };
  }

  /**
   * Merge slots covering [startOffset, endOffset) into a single override with FORCE_MERGE.
   */
  mergeSlots(funcVa, startOffset, endOffset, mergedSpec = {}, options = {}) {
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) {
      return { ok: false, reason: 'invalid_merge_range' };
    }
    const fpRel = Boolean(options.fpRel);
    const slotFlags =
      ((mergedSpec.slotFlags ?? 0) |
        STACK_SLOT_FLAGS.FORCE_MERGE |
        (fpRel ? STACK_SLOT_FLAGS.FP_REL : 0)) >>>
      0;
    return this.setOverride(
      funcVa,
      {
        ...mergedSpec,
        spOffset: startOffset,
        byteSize: endOffset - startOffset,
        slotFlags,
      },
      { replaceOverlapping: true }
    );
  }

  querySlot(funcVa, spOffset, fpRel = false) {
    const list = this.byFunc.get(toBigIntVa(funcVa));
    if (!list) return null;
    for (const e of list) {
      if (((e.slotFlags & STACK_SLOT_FLAGS.FP_REL) !== 0) !== Boolean(fpRel)) continue;
      if (spOffset >= e.spOffset && spOffset < e.spOffset + e.byteSize) {
        return { entry: e, innerOffset: spOffset - e.spOffset };
      }
    }
    return null;
  }

  getOverrides(funcVa) {
    const list = this.byFunc.get(toBigIntVa(funcVa));
    return list ? list.slice() : [];
  }

  removeOverride(funcVa, spOffset, fpRel = false) {
    const vaBig = toBigIntVa(funcVa);
    const list = this.byFunc.get(vaBig);
    if (!list) return false;
    const idx = list.findIndex(
      (e) => e.spOffset === spOffset && (((e.slotFlags & STACK_SLOT_FLAGS.FP_REL) !== 0) === Boolean(fpRel))
    );
    if (idx < 0) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.byFunc.delete(vaBig);
    return true;
  }

  /**
   * Export overrides for a function into 24B HexStackSlotOverride POD Uint8Array (§15.4).
   */
  exportWasm24(funcVa) {
    const list = this.getOverrides(funcVa);
    const buf = new ArrayBuffer(list.length * STACK_SLOT_OVERRIDE_BYTES);
    const dv = new DataView(buf);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const base = i * STACK_SLOT_OVERRIDE_BYTES;
      dv.setInt32(base + 0x00, e.spOffset | 0, true);
      dv.setUint32(base + 0x04, e.byteSize >>> 0, true);
      dv.setUint32(base + 0x08, e.hexTypeId >>> 0, true);
      dv.setUint32(base + 0x0c, e.arrayLen >>> 0, true);
      dv.setUint32(base + 0x10, e.slotFlags >>> 0, true);
      dv.setUint32(base + 0x14, e.nameOff >>> 0, true);
    }
    return new Uint8Array(buf);
  }
}
