// x86-64 HEX-SIG Prologue & Cross-Opt Normalizer DI Adapter.
// 100% bit-for-bit parity with cpp/src/analysis/hexsig_engine.cpp `normalize_x64_slice`.
// INV-005: Lives under js/targets/architecture/x86_64/, ZERO imports from js/targets/abi/.

const ARCH_ID_X86_64 = 2; // HEX_SIG_ARCH_X64
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

const MODRM_OPS = new Set([
  0x88, 0x89, 0x8a, 0x8b, 0x8d,
  0x81, 0x83, 0x85, 0x01, 0x03,
  0x29, 0x2b, 0x31, 0x33, 0x39,
  0x3b, 0xc7, 0xff,
]);

/**
 * Normalize an x86-64 function slice matching C++ `normalize_x64_slice` byte-for-byte:
 * - Preserves frame prologues & ENDBR64 in-place (100% parity with C++ `hex_hexsig_normalize_x64`)
 * - Masks CALL/JMP rel32, JMP/Jcc rel8, 0F 8x rel32, MOV r32/r64 imm32/imm64, and RIP-relative disp32
 */
export function normalizeX8664Prologue(codeBytes, opts = {}) {
  const bytes = codeBytes instanceof Uint8Array ? codeBytes : new Uint8Array(codeBytes || 0);
  const maxBytes = Math.min(PATTERN_LEN, opts.maxBytes ?? PATTERN_LEN);
  const normLen = Math.min(bytes.length, maxBytes);

  const pattern = new Uint8Array(PATTERN_LEN);
  const mask = new Uint8Array(PATTERN_LEN);
  for (let i = 0; i < normLen; i++) {
    pattern[i] = bytes[i];
    mask[i] = 0xff;
  }

  function maskRange(start, count) {
    for (let k = 0; k < count && (start + k) < normLen; k++) {
      pattern[start + k] = 0;
      mask[start + k] = 0;
    }
  }

  const tokens = [];
  let cArith = 0;
  let cBit = 0;
  let cMem = 0;
  let cBrCall = 0;

  let pos = 0;
  while (pos < normLen) {
    // 1. Legacy prefixes
    let p = pos;
    let has66 = false;
    while (p < normLen) {
      const b = bytes[p];
      if (b === 0x66) {
        has66 = true;
        p++;
      } else if (
        b === 0x67 || b === 0xf0 || b === 0xf2 || b === 0xf3
        || b === 0x2e || b === 0x3e || b === 0x26 || b === 0x64 || b === 0x65
      ) {
        p++;
      } else {
        break;
      }
    }

    // ENDBR64: F3 0F 1E FA (kept in pattern, skipped cleanly during decode)
    if (
      pos + 4 <= normLen
      && bytes[pos] === 0xf3
      && bytes[pos + 1] === 0x0f
      && bytes[pos + 2] === 0x1e
      && bytes[pos + 3] === 0xfa
    ) {
      pos += 4;
      continue;
    }

    // 2. REX prefix (0x40..0x4F)
    let rex = 0;
    if (p < normLen && (bytes[p] & 0xf0) === 0x40) {
      rex = bytes[p];
      p++;
    }
    if (p >= normLen) break;

    const op = bytes[p++];

    // CALL rel32 (E8) / JMP rel32 (E9)
    if (op === 0xe8 || op === 0xe9) {
      maskRange(p, 4);
      tokens.push(op === 0xe8 ? TOK_CALL : TOK_BR_UNCOND);
      cBrCall++;
      pos = (p + 4 <= normLen) ? (p + 4) : normLen;
      continue;
    }

    // JMP rel8 (EB) / Jcc rel8 (70..7F)
    if (op === 0xeb || (op >= 0x70 && op <= 0x7f)) {
      maskRange(p, 1);
      tokens.push(op === 0xeb ? TOK_BR_UNCOND : (op === 0x74 || op === 0x75 ? TOK_BR_COND_ZERO : TOK_BR_COND));
      cBrCall++;
      pos = (p + 1 <= normLen) ? (p + 1) : normLen;
      continue;
    }

    // 2-byte escape 0F
    if (op === 0x0f && p < normLen) {
      const op2 = bytes[p++];
      if (op2 >= 0x80 && op2 <= 0x8f) {
        maskRange(p, 4);
        tokens.push(op2 === 0x84 || op2 === 0x85 ? TOK_BR_COND_ZERO : TOK_BR_COND);
        cBrCall++;
        pos = (p + 4 <= normLen) ? (p + 4) : normLen;
        continue;
      }
      tokens.push(TOK_ARITH | op2);
      cArith++;
      pos = p;
      continue;
    }

    // PUSH/POP r64 (50..5F), NOP (90), RET (C3)
    if ((op >= 0x50 && op <= 0x5f) || op === 0x90 || op === 0xc3) {
      if (op === 0xc3) {
        tokens.push(TOK_RET);
        cBrCall++;
      } else if (op !== 0x90) {
        tokens.push(op < 0x58 ? TOK_STORE : TOK_LOAD);
        cMem++;
      }
      pos = p;
      continue;
    }

    // MOV r64, imm64 (REX.W + B8..BF) or MOV r32, imm32 (B8..BF)
    if (op >= 0xb8 && op <= 0xbf) {
      const immLen = ((rex & 0x08) !== 0) ? 8 : (has66 ? 2 : 4);
      if (immLen >= 4) maskRange(p, immLen);
      tokens.push(TOK_ARITH | 0x01);
      cArith++;
      pos = (p + immLen <= normLen) ? (p + immLen) : normLen;
      continue;
    }

    // Common ModRM instructions
    if (MODRM_OPS.has(op) && p < normLen) {
      const modrm = bytes[p++];
      const mod = (modrm >>> 6) & 3;
      const rm = modrm & 7;
      if (mod !== 3 && rm === 4 && p < normLen) {
        p++; // SIB byte
      }
      if (mod === 0 && rm === 5) {
        maskRange(p, 4); // RIP-relative disp32
        p += 4;
      } else if (mod === 1) {
        p += 1;
      } else if (mod === 2) {
        p += 4;
      }
      if (op === 0x83) {
        p += 1;
      } else if (op === 0x81 || op === 0xc7) {
        p += (has66 ? 2 : 4);
      }
      if (op === 0x31 || op === 0x33) {
        tokens.push(TOK_BIT | op);
        cBit++;
      } else if (op === 0x8a || op === 0x8b) {
        tokens.push(TOK_LOAD);
        cMem++;
      } else if (op === 0x88 || op === 0x89) {
        tokens.push(TOK_STORE);
        cMem++;
      } else {
        tokens.push(TOK_ARITH | op);
        cArith++;
      }
      pos = p <= normLen ? p : normLen;
      continue;
    }

    tokens.push(TOK_ARITH | op);
    cArith++;
    pos = p;
  }

  const totalOps = Math.max(1, cArith + cBit + cMem + cBrCall);
  const pArith = Math.min(255, Math.round((cArith * 255) / totalOps));
  const pBit = Math.min(255, Math.round((cBit * 255) / totalOps));
  const pMem = Math.min(255, Math.round((cMem * 255) / totalOps));
  const pBrCall = Math.min(255, Math.round((cBrCall * 255) / totalOps));
  const opProfile32 = (pArith | (pBit << 8) | (pMem << 16) | (pBrCall << 24)) >>> 0;

  return {
    archId: ARCH_ID_X86_64,
    pattern,
    mask,
    length: normLen,
    tokens,
    opProfile32,
    constants: [],
  };
}

export const x8664HexSigNormalizer = Object.freeze({
  archId: ARCH_ID_X86_64,
  arch: 'x86_64',
  normalizePrologue: normalizeX8664Prologue,
});
