// ARM64 HEX-SIG Prologue & Cross-Opt Normalizer DI Adapter.
// 100% bit-for-bit parity with cpp/src/analysis/hexsig_engine.cpp `normalize_arm64_slice`.
// INV-005: Lives under js/targets/architecture/arm64/, ZERO imports from js/targets/abi/.

const ARCH_ID_ARM64 = 1; // HEX_SIG_ARCH_ARM64
const PATTERN_LEN = 32;

const TOK_ARITH = 0x1000;
const TOK_BIT = 0x2000;
const TOK_LOAD = 0x3000;
const TOK_STORE = 0x4000;
const TOK_BR_COND_ZERO = 0x5001;
const TOK_BR_COND = 0x5002;
const TOK_BR_UNCOND = 0x5003;
const TOK_CALL = 0x5004;
const TOK_RET = 0x5005;
const TOK_SELECT = 0x6001;

function readU32(bytes, off) {
  return (
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  );
}

function writeU32(bytes, off, w) {
  bytes[off] = w & 0xff;
  bytes[off + 1] = (w >>> 8) & 0xff;
  bytes[off + 2] = (w >>> 16) & 0xff;
  bytes[off + 3] = (w >>> 24) & 0xff;
}

/**
 * Normalize an ARM64 function slice matching C++ `normalize_arm64_slice` byte-for-byte:
 * - Preserves frame prologues by default (100% parity with C++ `hex_hexsig_normalize_arm64`)
 * - Tracks `adrpRegMask` and masks `imm12[21:10]` (`0xFFC003FF`) on subsequent ADD/LDR/STR using that register
 * - Masks ADR/ADRP, B/BL, B.cond, CBZ/CBNZ, TBZ/TBNZ, and LDR literal displacement bits
 */
export function normalizeArm64Prologue(codeBytes, opts = {}) {
  const bytes = codeBytes instanceof Uint8Array ? codeBytes : new Uint8Array(codeBytes || 0);
  const maxBytes = Math.min(PATTERN_LEN, opts.maxBytes ?? PATTERN_LEN);
  const avail = bytes.length & ~3;
  const normLen = Math.min(avail, maxBytes);

  const pattern = new Uint8Array(PATTERN_LEN);
  const mask = new Uint8Array(PATTERN_LEN);
  let adrpRegMask = 0;

  for (let off = 0; off < normLen; off += 4) {
    const w = readU32(bytes, off);
    let m = 0xffffffff;

    if ((w & 0x1f000000) === 0x10000000) {
      // ADR / ADRP: mask immlo[30:29] and immhi[23:5]
      m = 0x9f00001f;
      const rd = w & 31;
      if (rd < 31) adrpRegMask = (adrpRegMask | (1 << rd)) >>> 0;
    } else if ((w & 0x7c000000) === 0x14000000) {
      // B / BL: mask imm26[25:0]
      m = 0xfc000000;
    } else if (((w & 0xff000010) >>> 0) === 0x54000000) {
      // B.cond: mask imm19[23:5]
      m = 0xff00001f;
    } else if ((w & 0x7e000000) === 0x34000000) {
      // CBZ / CBNZ: mask imm19[23:5]
      m = 0xff00001f;
    } else if ((w & 0x7e000000) === 0x36000000) {
      // TBZ / TBNZ: mask imm14[18:5]
      m = 0xfff8001f;
    } else if ((w & 0x3b000000) === 0x18000000) {
      // LDR / LDRSW / PRFM (literal): mask imm19[23:5]
      m = 0xff00001f;
    } else if ((w & 0x7f800000) === 0x11000000) {
      // ADD (immediate): if Rn came from ADRP, mask page-offset imm12[21:10]
      const rn = (w >>> 5) & 31;
      const rd = w & 31;
      if (rn < 31 && ((adrpRegMask & (1 << rn)) !== 0)) {
        m = 0xffc003ff;
      }
      if (rd < 31) adrpRegMask = (adrpRegMask & ~(1 << rd)) >>> 0;
    } else if ((w & 0x3b000000) === 0x39000000) {
      // LDR/STR (unsigned imm): if Rn came from ADRP, mask page-offset imm12[21:10]
      const rn = (w >>> 5) & 31;
      const rt = w & 31;
      if (rn < 31 && ((adrpRegMask & (1 << rn)) !== 0)) {
        m = 0xffc003ff;
      }
      if (rt < 31 && ((w & 0x00400000) !== 0)) {
        adrpRegMask = (adrpRegMask & ~(1 << rt)) >>> 0;
      }
    } else {
      const rd = w & 31;
      if (rd < 31) adrpRegMask = (adrpRegMask & ~(1 << rd)) >>> 0;
    }

    writeU32(pattern, off, (w & m) >>> 0);
    writeU32(mask, off, m >>> 0);
  }

  // Cross-opt canonical token generation + op-class profile (§11.1)
  const totalWords = Math.floor(bytes.length / 4);
  const tokens = [];
  const constants = [];
  let cArith = 0;
  let cBit = 0;
  let cMem = 0;
  let cBrCall = 0;

  for (let i = 0; i < totalWords; i++) {
    const w = readU32(bytes, i * 4);
    if (((w & 0xfffff01f) >>> 0) === 0xd503201f) continue; // NOP/PAC/BTI

    if (w === 0xd65f03c0) {
      tokens.push(TOK_RET);
      cBrCall++;
    } else if (((w & 0xfc000000) >>> 0) === 0x94000000) {
      tokens.push(TOK_CALL);
      cBrCall++;
    } else if (((w & 0xfc000000) >>> 0) === 0x14000000) {
      tokens.push(TOK_BR_UNCOND);
      cBrCall++;
    } else if ((w & 0x7e000000) === 0x34000000) {
      tokens.push(TOK_BR_COND_ZERO);
      cBrCall++;
    } else if (((w & 0xff000010) >>> 0) === 0x54000000) {
      tokens.push(TOK_BR_COND);
      cBrCall++;
    } else if ((w & 0x1fe00800) === 0x1a800000) {
      tokens.push(TOK_SELECT);
      cArith++;
    } else if ((w & 0x3a000000) === 0x28000000) {
      const isLoad = Boolean((w >>> 22) & 1);
      const tok = isLoad ? TOK_LOAD : TOK_STORE;
      tokens.push(tok, tok);
      cMem += 2;
    } else if ((w & 0x3b000000) === 0x39000000 || (w & 0x3b200c00) === 0x38000000) {
      const isLoad = Boolean((w >>> 22) & 1);
      tokens.push(isLoad ? TOK_LOAD : TOK_STORE);
      cMem++;
    } else if ((w & 0x1f800000) === 0x12800000) {
      const imm16 = (w >>> 5) & 0xffff;
      const hw = (w >>> 21) & 3;
      const val = BigInt(imm16) << BigInt(hw * 16);
      if (val > 16n) constants.push(val);
      tokens.push(TOK_ARITH | 0x01);
      cArith++;
    } else if ((w & 0x1f000000) === 0x0a000000 || (w & 0x1f800000) === 0x12000000) {
      tokens.push(TOK_BIT | ((w >>> 29) & 3));
      cBit++;
    } else {
      tokens.push(TOK_ARITH | ((w >>> 24) & 0x1f));
      cArith++;
    }
  }

  const totalOps = Math.max(1, cArith + cBit + cMem + cBrCall);
  const pArith = Math.min(255, Math.round((cArith * 255) / totalOps));
  const pBit = Math.min(255, Math.round((cBit * 255) / totalOps));
  const pMem = Math.min(255, Math.round((cMem * 255) / totalOps));
  const pBrCall = Math.min(255, Math.round((cBrCall * 255) / totalOps));
  const opProfile32 = (pArith | (pBit << 8) | (pMem << 16) | (pBrCall << 24)) >>> 0;

  return {
    archId: ARCH_ID_ARM64,
    pattern,
    mask,
    length: normLen,
    tokens,
    opProfile32,
    constants,
  };
}

export const arm64HexSigNormalizer = Object.freeze({
  archId: ARCH_ID_ARM64,
  arch: 'arm64',
  normalizePrologue: normalizeArm64Prologue,
});
