// JS-parity __usercall / __userpurge custom ABI specification store & validator (§15.3).
// Architecture-specific register names are injected via DI archAdapter (INV-005).

export const ABI_LOC_KIND = Object.freeze({
  NONE: 0,
  GPR: 1,
  FPR_SIMD: 2,
  GPR_PAIR: 3,
  FPR_PAIR: 4,
  STACK: 5,
});

export const ABI_FLAGS = Object.freeze({
  USERPURGE: 1 << 0,
  VARIADIC: 1 << 1,
  CUSTOM_CLOBBER: 1 << 2,
  PRESERVE_ALL: 1 << 3,
});

export const ABI_LOC_FLAGS = Object.freeze({
  HIDDEN_THIS: 1 << 0,
  SRET: 1 << 1,
  SIGN_EXT: 1 << 2,
  ALLOW_FP_LR: 1 << 3,
});

export const MAX_CUSTOM_ABI_ARGS = 12;
export const CUSTOM_ABI_SPEC_BYTES = 192;
export const CUSTOM_ABI_PIN_MASK = 0x0007ffff;

function toBigIntVa(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v.trim());
  return 0n;
}

function emptyAbiLoc() {
  return {
    locKind: ABI_LOC_KIND.NONE,
    regId: 0xff,
    regIdHi: 0xff,
    byteWidth: 0,
    spOffset: 0,
    locFlags: 0,
  };
}

/**
 * Compute C++ HexCustomAbiSpec::ret_count (+0x0F) matching hex_manual_recovery.hpp:177:
 * NONE -> 0, GPR_PAIR/FPR_PAIR -> 2, GPR/FPR_SIMD/STACK -> 1.
 */
export function computeRetCount(retLoc) {
  const kind = Number(retLoc?.locKind ?? ABI_LOC_KIND.NONE);
  if (kind === ABI_LOC_KIND.NONE) return 0;
  if (kind === ABI_LOC_KIND.GPR_PAIR || kind === ABI_LOC_KIND.FPR_PAIR) return 2;
  if (
    kind === ABI_LOC_KIND.GPR ||
    kind === ABI_LOC_KIND.FPR_SIMD ||
    kind === ABI_LOC_KIND.STACK
  ) {
    return 1;
  }
  return 0;
}

function parseLocationToken(locExpr, archAdapter) {
  const raw = String(locExpr || '').trim();
  if (!raw) return { ok: false, reason: 'empty_location' };

  // Stack location: e.g. `0x10[sp]` or `16[sp]` or `[sp+0x10]`
  const stackMatch =
    /^(0x[0-9a-fA-F]+|\d+)\s*\[\s*sp\s*\]$/i.exec(raw) ||
    /^\[\s*sp\s*\+\s*(0x[0-9a-fA-F]+|\d+)\s*\]$/i.exec(raw);
  if (stackMatch) {
    const off = Number(stackMatch[1]);
    if (!Number.isInteger(off) || off < 0 || off > 4096) {
      return { ok: false, reason: 'invalid_stack_offset' };
    }
    return {
      ok: true,
      loc: {
        locKind: ABI_LOC_KIND.STACK,
        regId: 0xff,
        regIdHi: 0xff,
        byteWidth: 8,
        spOffset: off,
        locFlags: 0,
      },
    };
  }

  // Pair location: e.g. `x0:x1` or `v0:v1`
  if (raw.includes(':')) {
    const [loTok, hiTok] = raw.split(':').map((s) => s.trim());
    const loRes = parseLocationToken(loTok, archAdapter);
    const hiRes = parseLocationToken(hiTok, archAdapter);
    if (!loRes.ok || !hiRes.ok) return { ok: false, reason: 'invalid_pair_location' };
    if (loRes.loc.locKind !== hiRes.loc.locKind) return { ok: false, reason: 'mismatched_pair_kind' };
    if (loRes.loc.locKind === ABI_LOC_KIND.GPR) {
      return {
        ok: true,
        loc: {
          locKind: ABI_LOC_KIND.GPR_PAIR,
          regId: loRes.loc.regId,
          regIdHi: hiRes.loc.regId,
          byteWidth: 16,
          spOffset: 0,
          locFlags: loRes.loc.locFlags | hiRes.loc.locFlags,
        },
      };
    }
    if (loRes.loc.locKind === ABI_LOC_KIND.FPR_SIMD) {
      return {
        ok: true,
        loc: {
          locKind: ABI_LOC_KIND.FPR_PAIR,
          regId: loRes.loc.regId,
          regIdHi: hiRes.loc.regId,
          byteWidth: 16,
          spOffset: 0,
          locFlags: loRes.loc.locFlags | hiRes.loc.locFlags,
        },
      };
    }
    return { ok: false, reason: 'unsupported_pair_kind' };
  }

  // Register lookup via injected archAdapter (INV-005)
  if (!archAdapter || typeof archAdapter.parseRegister !== 'function') {
    return { ok: false, reason: 'missing_arch_adapter' };
  }
  const parsed = archAdapter.parseRegister(raw);
  if (!parsed) return { ok: false, reason: `unknown_register:${raw}` };
  if (parsed.isSp) {
    return { ok: false, reason: 'sp_not_allowed_as_reg_arg' };
  }
  return {
    ok: true,
    loc: {
      locKind: parsed.bank === 'fpr' ? ABI_LOC_KIND.FPR_SIMD : ABI_LOC_KIND.GPR,
      regId: parsed.regId,
      regIdHi: 0xff,
      byteWidth: parsed.byteWidth || 8,
      spOffset: 0,
      locFlags: parsed.isFpOrLr ? ABI_LOC_FLAGS.ALLOW_FP_LR : 0,
    },
  };
}

/**
 * Parse IDA-compatible `__usercall` / `__userpurge` signature string using DI `archAdapter`.
 * Example: `int64_t __usercall f@<x0>(void *ctx@<x20>, uint64_t key@<0x10[sp]>)`
 */
export function parseUsercallSignature(signatureStr, archAdapter) {
  const text = String(signatureStr || '').trim();
  const sigRe =
    /^(.+?)\s+(__usercall|__userpurge)\s+([A-Za-z_][A-Za-z0-9_]*)(?:@<([^>]+)>)?\s*\(([^)]*)\)(?:\s*__purge\(\s*(0x[0-9a-fA-F]+|\d+)\s*\))?\s*;?$/;
  const m = sigRe.exec(text);
  if (!m) {
    return { ok: false, reason: 'invalid_usercall_syntax' };
  }

  const retTypeStr = m[1].trim();
  const ccTok = m[2];
  const funcName = m[3];
  const retLocTok = m[4] ? m[4].trim() : null;
  const argsStr = m[5].trim();
  const purgeBytes = m[6] ? Number(m[6]) : 0;

  let retLoc = emptyAbiLoc();
  if (retLocTok) {
    const r = parseLocationToken(retLocTok, archAdapter);
    if (!r.ok) return { ok: false, reason: `invalid_ret_loc:${r.reason}` };
    retLoc = r.loc;
  }

  const argLocs = [];
  const argTypes = [];
  const argNames = [];
  let isVariadic = false;

  if (argsStr.length > 0 && argsStr !== 'void') {
    const parts = argsStr.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (part === '...') {
        isVariadic = true;
        continue;
      }
      const am = /^(.+?)@<([^>]+)>$/.exec(part);
      if (!am) return { ok: false, reason: `missing_arg_location:${part}` };
      const decl = am[1].trim();
      const locRes = parseLocationToken(am[2].trim(), archAdapter);
      if (!locRes.ok) return { ok: false, reason: `invalid_arg_loc:${locRes.reason}` };
      const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(decl);
      const argName = nameMatch ? nameMatch[1] : `a${argLocs.length}`;
      const argType = nameMatch ? decl.slice(0, nameMatch.index).trim() || 'uint64_t' : decl;
      argLocs.push(locRes.loc);
      argTypes.push(argType);
      argNames.push(argName);
    }
  }

  let abiFlags = 0;
  if (ccTok === '__userpurge') abiFlags |= ABI_FLAGS.USERPURGE;
  if (isVariadic) abiFlags |= ABI_FLAGS.VARIADIC;

  return {
    ok: true,
    spec: {
      funcName,
      retTypeStr,
      abiFlags,
      spPurgeBytes: purgeBytes,
      argCount: argLocs.length,
      retCount: computeRetCount(retLoc),
      retLoc,
      retHexType: 0,
      clobberGpMask: 0,
      clobberFpMask: 0,
      argLocs,
      argTypes,
      argNames,
      argHexTypes: argLocs.map(() => 0),
    },
  };
}

/**
 * Fail-Closed validation per §15.3.
 */
export function validateCustomAbiSpec(spec, archAdapter = null) {
  if (!spec || typeof spec !== 'object') {
    return { ok: false, reason: 'invalid_spec' };
  }
  const argCount = Number(spec.argCount ?? spec.argLocs?.length ?? 0);
  if (!Number.isInteger(argCount) || argCount < 0 || argCount > MAX_CUSTOM_ABI_ARGS) {
    return { ok: false, reason: 'arg_count_out_of_range' };
  }
  const spPurgeBytes = Number(spec.spPurgeBytes ?? 0);
  if (!Number.isInteger(spPurgeBytes) || spPurgeBytes < 0 || spPurgeBytes % 16 !== 0) {
    return { ok: false, reason: 'sp_purge_not_16b_aligned' };
  }

  const validateLoc = (loc, isArg) => {
    if (!loc) return { ok: false, reason: 'missing_loc' };
    const kind = Number(loc.locKind ?? ABI_LOC_KIND.NONE);
    if (!Number.isInteger(kind) || kind < 0 || kind > ABI_LOC_KIND.STACK) {
      return { ok: false, reason: 'invalid_loc_kind' };
    }
    if (kind === ABI_LOC_KIND.NONE) return { ok: true };
    if (kind === ABI_LOC_KIND.STACK) {
      const off = Number(loc.spOffset ?? -1);
      if (!Number.isInteger(off) || off < 0 || off > 4096) {
        return { ok: false, reason: 'invalid_stack_offset' };
      }
      return { ok: true };
    }
    const r = Number(loc.regId);
    if (!Number.isInteger(r) || r < 0 || r > 31) {
      return { ok: false, reason: 'invalid_reg_id' };
    }
    const spRegId = archAdapter?.spRegId ?? 31;
    if ((kind === ABI_LOC_KIND.GPR || kind === ABI_LOC_KIND.GPR_PAIR) && r === spRegId) {
      return { ok: false, reason: 'sp_reg_forbidden' };
    }
    if (
      isArg &&
      (kind === ABI_LOC_KIND.GPR || kind === ABI_LOC_KIND.GPR_PAIR) &&
      archAdapter &&
      typeof archAdapter.isFrameOrLinkReg === 'function' &&
      archAdapter.isFrameOrLinkReg(r) &&
      ((loc.locFlags ?? 0) & ABI_LOC_FLAGS.ALLOW_FP_LR) === 0
    ) {
      return { ok: false, reason: 'fp_lr_requires_allow_flag' };
    }
    if (kind === ABI_LOC_KIND.GPR_PAIR || kind === ABI_LOC_KIND.FPR_PAIR) {
      const rHi = Number(loc.regIdHi);
      if (!Number.isInteger(rHi) || rHi < 0 || rHi > 31 || rHi === r) {
        return { ok: false, reason: 'invalid_pair_hi_reg' };
      }
      if (kind === ABI_LOC_KIND.GPR_PAIR && rHi === spRegId) {
        return { ok: false, reason: 'sp_reg_forbidden' };
      }
    }
    return { ok: true };
  };

  if (spec.retLoc) {
    const rr = validateLoc(spec.retLoc, false);
    if (!rr.ok) return { ok: false, reason: `ret:${rr.reason}` };
  }

  const seenRegs = new Set();
  const argLocs = spec.argLocs || [];
  for (let i = 0; i < argCount; i++) {
    const loc = argLocs[i];
    const ar = validateLoc(loc, true);
    if (!ar.ok) return { ok: false, reason: `arg${i}:${ar.reason}` };
    if (loc.locKind === ABI_LOC_KIND.GPR || loc.locKind === ABI_LOC_KIND.GPR_PAIR) {
      const k1 = `g:${loc.regId}`;
      if (seenRegs.has(k1)) return { ok: false, reason: `duplicate_register:${k1}` };
      seenRegs.add(k1);
      if (loc.locKind === ABI_LOC_KIND.GPR_PAIR) {
        const k2 = `g:${loc.regIdHi}`;
        if (seenRegs.has(k2)) return { ok: false, reason: `duplicate_register:${k2}` };
        seenRegs.add(k2);
      }
    } else if (loc.locKind === ABI_LOC_KIND.FPR_SIMD || loc.locKind === ABI_LOC_KIND.FPR_PAIR) {
      const k1 = `f:${loc.regId}`;
      if (seenRegs.has(k1)) return { ok: false, reason: `duplicate_register:${k1}` };
      seenRegs.add(k1);
      if (loc.locKind === ABI_LOC_KIND.FPR_PAIR) {
        const k2 = `f:${loc.regIdHi}`;
        if (seenRegs.has(k2)) return { ok: false, reason: `duplicate_register:${k2}` };
        seenRegs.add(k2);
      }
    }
  }

  return { ok: true };
}

/**
 * Mirrors `hex_custom_abi_validate_and_project` (§15.3).
 */
export function projectCustomAbiToSig16(spec, inoutSig16 = {}, inoutPinMask = 0, archAdapter = null) {
  const check = validateCustomAbiSpec(spec, archAdapter);
  if (!check.ok) return { ok: false, reason: check.reason };

  let gpArgMask = 0;
  let fpArgMask = 0;
  for (let i = 0; i < spec.argCount; i++) {
    const loc = spec.argLocs[i];
    if (loc.locKind === ABI_LOC_KIND.GPR && loc.regId < 8) gpArgMask |= 1 << loc.regId;
    if (loc.locKind === ABI_LOC_KIND.GPR_PAIR) {
      if (loc.regId < 8) gpArgMask |= 1 << loc.regId;
      if (loc.regIdHi < 8) gpArgMask |= 1 << loc.regIdHi;
    }
    if (loc.locKind === ABI_LOC_KIND.FPR_SIMD && loc.regId < 8) fpArgMask |= 1 << loc.regId;
    if (loc.locKind === ABI_LOC_KIND.FPR_PAIR) {
      if (loc.regId < 8) fpArgMask |= 1 << loc.regId;
      if (loc.regIdHi < 8) fpArgMask |= 1 << loc.regIdHi;
    }
  }

  let retKind = 0;
  if (spec.retLoc) {
    if (spec.retLoc.locKind === ABI_LOC_KIND.GPR) retKind = 1;
    else if (spec.retLoc.locKind === ABI_LOC_KIND.FPR_SIMD) retKind = 2;
    else if (
      spec.retLoc.locKind === ABI_LOC_KIND.GPR_PAIR ||
      spec.retLoc.locKind === ABI_LOC_KIND.FPR_PAIR
    ) {
      retKind = 3;
    }
  }

  const nextSig16 = {
    ...inoutSig16,
    gpArgMask: gpArgMask & 0xff,
    fpArgMask: fpArgMask & 0xff,
    retInfo: ((inoutSig16.retInfo ?? 0) & ~0x0f) | (retKind & 0x0f),
    confidence: 255,
  };
  const nextPinMask = ((inoutPinMask >>> 0) | CUSTOM_ABI_PIN_MASK) >>> 0;

  return { ok: true, sig16: nextSig16, pinMask: nextPinMask };
}

function writeAbiLoc(dv, offset, loc) {
  const l = loc || emptyAbiLoc();
  dv.setUint8(offset + 0, (l.locKind ?? 0) & 0xff);
  dv.setUint8(offset + 1, (l.regId ?? 0xff) & 0xff);
  dv.setUint8(offset + 2, (l.regIdHi ?? 0xff) & 0xff);
  dv.setUint8(offset + 3, (l.byteWidth ?? 0) & 0xff);
  dv.setInt16(offset + 4, l.spOffset ?? 0, true);
  dv.setUint16(offset + 6, (l.locFlags ?? 0) & 0xffff, true);
}

/**
 * Export a validated CustomAbiSpec to exact 192B POD Uint8Array (§15.3 / hex_manual_recovery.hpp:172-186).
 */
export function exportCustomAbiWasm192(spec) {
  const buf = new ArrayBuffer(CUSTOM_ABI_SPEC_BYTES);
  const dv = new DataView(buf);
  dv.setBigUint64(0x00, BigInt.asUintN(64, toBigIntVa(spec.funcVa ?? 0n)), true);
  dv.setUint32(0x08, (spec.abiFlags ?? 0) >>> 0, true);
  dv.setUint16(0x0c, (spec.spPurgeBytes ?? 0) & 0xffff, true);
  dv.setUint8(0x0e, (spec.argCount ?? 0) & 0xff);
  dv.setUint8(0x0f, computeRetCount(spec.retLoc) & 0xff);
  writeAbiLoc(dv, 0x10, spec.retLoc);
  dv.setUint32(0x18, (spec.retHexType ?? 0) >>> 0, true);
  dv.setUint32(0x1c, (spec.clobberGpMask ?? 0) >>> 0, true);
  dv.setUint32(0x20, (spec.clobberFpMask ?? 0) >>> 0, true);
  dv.setUint32(0x24, 0, true);
  for (let i = 0; i < MAX_CUSTOM_ABI_ARGS; i++) {
    writeAbiLoc(dv, 0x28 + i * 8, spec.argLocs?.[i]);
    dv.setUint32(0x88 + i * 4, (spec.argHexTypes?.[i] ?? 0) >>> 0, true);
  }
  dv.setBigUint64(0xb8, 0n, true);
  return new Uint8Array(buf);
}

export class CustomAbiStore {
  constructor(options = {}) {
    this.archAdapter = options.archAdapter || null;
    /** @type {Map<bigint, object>} */
    this.specs = new Map();
  }

  set(funcVa, spec) {
    const vaBig = toBigIntVa(funcVa);
    const full = { ...spec, funcVa: vaBig, retCount: computeRetCount(spec.retLoc) };
    const check = validateCustomAbiSpec(full, this.archAdapter);
    if (!check.ok) return { ok: false, reason: check.reason };
    this.specs.set(vaBig, full);
    return { ok: true, spec: full };
  }

  setFromSignature(funcVa, signatureStr) {
    const parsed = parseUsercallSignature(signatureStr, this.archAdapter);
    if (!parsed.ok) return parsed;
    return this.set(funcVa, parsed.spec);
  }

  get(funcVa) {
    return this.specs.get(toBigIntVa(funcVa)) || null;
  }

  delete(funcVa) {
    return this.specs.delete(toBigIntVa(funcVa));
  }

  validateAndProject(funcVa, inoutSig16 = {}, inoutPinMask = 0) {
    const spec = this.get(funcVa);
    if (!spec) return { ok: false, reason: 'not_found' };
    return projectCustomAbiToSig16(spec, inoutSig16, inoutPinMask, this.archAdapter);
  }

  get size() {
    return this.specs.size;
  }
}
