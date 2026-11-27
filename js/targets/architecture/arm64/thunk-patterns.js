// ARM64 C++ Multiple-Inheritance & Virtual-Inheritance Thunk Pattern Adapter (§12.2).
// INV-005: Lives under js/targets/architecture/arm64/, ZERO imports from js/targets/abi/.

const THUNK_KIND_NON_VIRTUAL = 1;
const THUNK_KIND_VIRTUAL = 2;
const THUNK_KIND_VIRTUAL_MIXED = 3;
const THUNK_KIND_COVARIANT = 4;

function readU32(bytes, off) {
  return (
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  );
}

function signExtend(val, bits) {
  const shift = 32 - bits;
  return (val << shift) >> shift;
}

function isPacOrBtiHint(w) {
  // PACIASP (0xD503233F), PACIBSP (0xD503237F), BTI c/j/jc (0xD503241F..0xD50324FF), NOP (0xD503201F)
  return ((w & 0xfffff01f) >>> 0) === 0xd503201f;
}

/**
 * Decode ADD/SUB X0, X0, #imm12 (optional LSL #12):
 *   ADD Xd, Xn, #imm12: sf=1, op=0, S=0 -> 0x91000000 (mask 0xFF800000)
 *   SUB Xd, Xn, #imm12: sf=1, op=1, S=0 -> 0xD1000000 (mask 0xFF800000)
 */
function decodeAddSubX0Imm(w) {
  const rd = w & 0x1f;
  const rn = (w >>> 5) & 0x1f;
  if (rd !== 0 || rn !== 0) return null;
  const opBits = (w & 0xff800000) >>> 0;
  if (opBits !== 0x91000000 && opBits !== 0xd1000000) return null;
  const sh = (w >>> 22) & 1;
  const imm12 = (w >>> 10) & 0xfff;
  const mag = sh ? (imm12 << 12) : imm12;
  return opBits === 0xd1000000 ? -mag : mag;
}

/**
 * Decode unconditional B #imm26: 0x14000000 (mask 0xFC000000).
 */
function decodeUncondBranch(w, pc) {
  if (((w & 0xfc000000) >>> 0) !== 0x14000000) return null;
  const imm26 = signExtend(w & 0x03ffffff, 26);
  return BigInt(pc) + BigInt(imm26 * 4);
}

/**
 * Decode LDR Xt, [X0, #0] (unsigned offset: 0xF9400000, rt=16|17, rn=0, imm12=0).
 */
function decodeLoadVtablePtr(w) {
  if (((w & 0xfffffc00) >>> 0) !== 0xf9400000) return null;
  const rn = (w >>> 5) & 0x1f;
  const rt = w & 0x1f;
  if (rn !== 0) return null;
  return rt;
}

/**
 * Decode LDUR / LDR Xt, [Xn, #simm9 or #uimm12*8] for vcall offset fetch.
 */
function decodeLoadVcallOffset(w, expectedBaseReg) {
  // LDUR Xt, [Xn, #simm9]: 0xF8400000 (mask 0xFFE00C00)
  if (((w & 0xffe00c00) >>> 0) === 0xf8400000) {
    const rn = (w >>> 5) & 0x1f;
    const rt = w & 0x1f;
    if (rn !== expectedBaseReg) return null;
    const simm9 = signExtend((w >>> 12) & 0x1ff, 9);
    return { rt, vcallOffset: simm9 };
  }
  // LDR Xt, [Xn, #uimm12*8]: 0xF9400000 (mask 0xFFC00000)
  if (((w & 0xffc00000) >>> 0) === 0xf9400000) {
    const rn = (w >>> 5) & 0x1f;
    const rt = w & 0x1f;
    if (rn !== expectedBaseReg) return null;
    const uimm = ((w >>> 10) & 0xfff) * 8;
    return { rt, vcallOffset: uimm };
  }
  return null;
}

/**
 * Decode ADD X0, X0, Xm (shifted reg: 0x8B000000, mask 0xFFE0FC00, rd=0, rn=0).
 */
function decodeAddX0Reg(w, expectedRm) {
  if (((w & 0xffe0fc00) >>> 0) !== 0x8b000000) return null;
  const rd = w & 0x1f;
  const rn = (w >>> 5) & 0x1f;
  const rm = (w >>> 16) & 0x1f;
  return rd === 0 && rn === 0 && rm === expectedRm;
}

/**
 * Match an ARM64 C++ `this`-adjuster thunk from raw instruction bytes.
 * Returns HexThunkRecord-compatible object or null.
 */
export function matchArm64CxxThunk(codeBytes, funcVa = 0n) {
  const bytes = codeBytes instanceof Uint8Array ? codeBytes : new Uint8Array(codeBytes || 0);
  if (bytes.length < 8) return null;

  const baseVa = BigInt(funcVa);
  const words = [];
  const maxWords = Math.min(10, Math.floor(bytes.length / 4));
  for (let i = 0; i < maxWords; i++) {
    words.push(readU32(bytes, i * 4));
  }

  let idx = 0;
  while (idx < words.length && isPacOrBtiHint(words[idx])) idx++;
  if (idx + 1 >= words.length) return null;

  // Pattern 1: Non-virtual thunk: [ADD/SUB X0, X0, #imm]+ ; B target
  let fixedDelta = 0;
  let fixedInsns = 0;
  let cursor = idx;
  while (cursor < words.length && fixedInsns < 2) {
    const d = decodeAddSubX0Imm(words[cursor]);
    if (d === null) break;
    fixedDelta += d;
    fixedInsns++;
    cursor++;
  }

  if (fixedInsns > 0 && cursor < words.length) {
    const targetVa = decodeUncondBranch(words[cursor], baseVa + BigInt(cursor * 4));
    if (targetVa !== null) {
      return {
        thunkVa: baseVa,
        targetVa,
        fixedDelta,
        vcallOffset: 0,
        kind: THUNK_KIND_NON_VIRTUAL,
        arch: 'arm64',
        insnCount: cursor + 1,
      };
    }
  }

  // Pattern 2/3: Virtual or Virtual-Mixed thunk:
  //   [optional ADD/SUB X0, X0, #fixed] ; LDR Xtmp, [X0] ; LDUR/LDR Xoff, [Xtmp, #vcall] ; ADD X0, X0, Xoff ; B target
  if (cursor + 3 < words.length) {
    const vtblReg = decodeLoadVtablePtr(words[cursor]);
    if (vtblReg !== null) {
      const vcall = decodeLoadVcallOffset(words[cursor + 1], vtblReg);
      if (vcall && decodeAddX0Reg(words[cursor + 2], vcall.rt)) {
        const targetVa = decodeUncondBranch(words[cursor + 3], baseVa + BigInt((cursor + 3) * 4));
        if (targetVa !== null) {
          return {
            thunkVa: baseVa,
            targetVa,
            fixedDelta,
            vcallOffset: vcall.vcallOffset,
            kind: fixedInsns > 0 ? THUNK_KIND_VIRTUAL_MIXED : THUNK_KIND_VIRTUAL,
            arch: 'arm64',
            insnCount: cursor + 4,
          };
        }
      }
    }
  }

  // Pattern 4: Covariant return thunk (BL target ; ADD/SUB X0, X0, #delta ; RET)
  for (let i = idx; i + 2 < words.length; i++) {
    if (((words[i] & 0xfc000000) >>> 0) === 0x94000000) { // BL
      const imm26 = signExtend(words[i] & 0x03ffffff, 26);
      const targetVa = baseVa + BigInt(i * 4) + BigInt(imm26 * 4);
      const retDelta = decodeAddSubX0Imm(words[i + 1]);
      if (retDelta !== null && words[i + 2] === 0xd65f03c0) {
        return {
          thunkVa: baseVa,
          targetVa,
          fixedDelta: retDelta,
          vcallOffset: 0,
          kind: THUNK_KIND_COVARIANT,
          arch: 'arm64',
          insnCount: i + 3,
        };
      }
    }
  }

  return null;
}

export const arm64ThunkPatternAdapter = Object.freeze({
  arch: 'arm64',
  matchThunk: matchArm64CxxThunk,
});
