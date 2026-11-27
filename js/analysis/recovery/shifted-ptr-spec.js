// __shifted(T, delta) pointer adjustment specification & member-access resolver (§15.4).
// Supports container_of resolution, double-shift prevention for C++ thunks,
// Path A (`ADJ(p)->field`) & Path B (`HEX_CONTAINER_OF(...)`) formatting, and 24B POD export.
// Pure architecture-neutral core (INV-005: zero imports from js/targets/architecture/).

export const SHIFTED_PTR_FLAGS = Object.freeze({
  PREFER_CONTAINER_OF: 1 << 0,
  ALLOW_NEG_OFFSET: 1 << 1,
  FROM_CXX_THUNK: 1 << 2,
});

export const SHIFTED_PTR_SPEC_BYTES = 24;

function toBigIntVa(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v.trim());
  return 0n;
}

/**
 * FNV-1a 32-bit hash matching §15.4 `var_key_hash` (e.g. `FNV-1a32("arg:0")`).
 */
export function fnv1a32(str) {
  let hash = 0x811c9dc5;
  const text = String(str);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Parse IDA-compatible `__shifted(ParentType, delta)` syntax.
 */
export function parseShiftedTypeAnnotation(str) {
  const m =
    /^(?:([A-Za-z_][A-Za-z0-9_:]*)\s*\*\s*)?__shifted\(\s*([A-Za-z_][A-Za-z0-9_:]*)\s*,\s*(-?0x[0-9a-fA-F]+|-?\d+)\s*\)$/.exec(
      String(str || '').trim()
    );
  if (!m) return null;
  const parentType = m[2];
  const shiftOffset = Number(m[3]);
  if (!Number.isInteger(shiftOffset)) return null;
  return {
    pointeeType: m[1] || parentType,
    parentType,
    shiftOffset,
  };
}

export class ShiftedPtrRegistry {
  constructor(options = {}) {
    this.archAdapter = options.archAdapter || null;
    /** @type {Map<bigint, Map<string, object>>} funcVa -> (varKey -> spec) */
    this.byFunc = new Map();
  }

  register(funcVa, spec) {
    const vaBig = toBigIntVa(funcVa);
    const varKey = String(spec.varKey || '');
    if (!varKey) return { ok: false, reason: 'missing_var_key' };
    const shiftOffset = Number(spec.shiftOffset ?? spec.shift_offset ?? 0);
    if (!Number.isInteger(shiftOffset)) return { ok: false, reason: 'invalid_shift_offset' };

    let fnMap = this.byFunc.get(vaBig);
    if (!fnMap) {
      fnMap = new Map();
      this.byFunc.set(vaBig, fnMap);
    }

    const entry = {
      varKey,
      varKeyHash: fnv1a32(varKey),
      parentTid: Number(spec.parentTid ?? spec.parent_tid ?? 0) & 0xffff,
      parentType: spec.parentType || `struct_${spec.parentTid ?? 0}`,
      specFlags: Number(spec.specFlags ?? spec.spec_flags ?? 0) & 0xffff,
      shiftOffset,
      memberOff: Number(spec.memberOff ?? spec.member_off ?? shiftOffset) | 0,
      memberName: spec.memberName ?? null,
      memberNameOff: Number(spec.memberNameOff ?? 0xffffffff) >>> 0,
    };
    fnMap.set(varKey, entry);
    return { ok: true, entry };
  }

  get(funcVa, varKey) {
    const fnMap = this.byFunc.get(toBigIntVa(funcVa));
    return fnMap ? fnMap.get(String(varKey)) || null : null;
  }

  list(funcVa) {
    const fnMap = this.byFunc.get(toBigIntVa(funcVa));
    return fnMap ? [...fnMap.values()] : [];
  }

  /**
   * Recognize shifted-pointer base idioms from instructions using DI `archAdapter`.
   */
  recognizeFromInstructions(insns, archAdapter = this.archAdapter) {
    if (!archAdapter || typeof archAdapter.recognizeShiftedBase !== 'function') {
      return [];
    }
    return archAdapter.recognizeShiftedBase(insns);
  }

  /**
   * Resolve a memory access `*(T *)(p + accessOffset)` through a shifted pointer specification.
   * Prevents double-shifting when `alreadyAdjustedByThunk` is true (§15.4).
   */
  resolveMemberAccess(funcVa, varKey, accessOffset, parentStructLayout = null, options = {}) {
    const spec = this.get(funcVa, varKey);
    if (!spec) return null;

    const alreadyAdjusted =
      Boolean(options.alreadyAdjustedByThunk) &&
      (spec.specFlags & SHIFTED_PTR_FLAGS.FROM_CXX_THUNK) !== 0;

    const effectiveShift = alreadyAdjusted ? 0 : spec.shiftOffset;
    const parentOffset = effectiveShift + Number(accessOffset);
    if (parentOffset < 0 && (spec.specFlags & SHIFTED_PTR_FLAGS.ALLOW_NEG_OFFSET) === 0) {
      return {
        ok: false,
        reason: 'negative_parent_offset',
        parentOffset,
      };
    }

    let matchedMember = null;
    if (parentStructLayout && Array.isArray(parentStructLayout.members)) {
      matchedMember =
        parentStructLayout.members.find(
          (m) => m.kind !== 'padding' && parentOffset >= m.offset && parentOffset < m.offset + m.size
        ) || null;
    }

    const varDisplay = options.varName || varKey;
    const memberName = matchedMember?.name || `field_${Math.abs(parentOffset).toString(16)}`;
    const hexShift = `0x${Math.abs(spec.shiftOffset).toString(16)}`;

    const pathAExpr = `ADJ(${varDisplay})->${memberName}`;
    const pathBC11Expr = `HEX_CONTAINER_OF(${varDisplay}, ${spec.parentType}, ${hexShift})->${memberName}`;

    return {
      ok: true,
      spec,
      parentOffset,
      doubleShiftPrevented: alreadyAdjusted,
      member: matchedMember,
      memberName,
      pathAExpr,
      pathBC11Expr,
    };
  }

  /**
   * Export shifted-ptr specs for a function to 24B HexShiftedPtrSpec POD buffer (§15.4).
   */
  exportWasm24(funcVa) {
    const specs = this.list(funcVa);
    const buf = new ArrayBuffer(specs.length * SHIFTED_PTR_SPEC_BYTES);
    const dv = new DataView(buf);
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const base = i * SHIFTED_PTR_SPEC_BYTES;
      dv.setUint32(base + 0x00, s.varKeyHash >>> 0, true);
      dv.setUint16(base + 0x04, s.parentTid & 0xffff, true);
      dv.setUint16(base + 0x06, s.specFlags & 0xffff, true);
      dv.setInt32(base + 0x08, s.shiftOffset | 0, true);
      dv.setInt32(base + 0x0c, s.memberOff | 0, true);
      dv.setUint32(base + 0x10, s.memberNameOff >>> 0, true);
      dv.setUint32(base + 0x14, 0, true);
    }
    return new Uint8Array(buf);
  }
}
