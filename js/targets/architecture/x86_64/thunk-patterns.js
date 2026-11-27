// x86-64 C++ Multiple-Inheritance & Virtual-Inheritance Thunk Pattern Adapter (§12.2).
// INV-005: Lives under js/targets/architecture/x86_64/, ZERO imports from js/targets/abi/.

const THUNK_KIND_NON_VIRTUAL = 1;
const THUNK_KIND_VIRTUAL = 2;
const THUNK_KIND_VIRTUAL_MIXED = 3;

function readI8(bytes, off) {
  const v = bytes[off];
  return v >= 0x80 ? v - 0x100 : v;
}

function readI32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) | 0;
}

/**
 * Decode x86-64 `add/sub rdi|rcx, imm8|imm32` (SysV rdi=reg 7, Win64 rcx=reg 1).
 *   48 83 EF imm8  -> sub rdi, imm8
 *   48 83 C7 imm8  -> add rdi, imm8
 *   48 81 EF imm32 -> sub rdi, imm32
 *   48 81 C7 imm32 -> add rdi, imm32
 *   48 83 E9 imm8  -> sub rcx, imm8
 *   48 83 C1 imm8  -> add rcx, imm8
 *   48 81 E9 imm32 -> sub rcx, imm32
 *   48 81 C1 imm32 -> add rcx, imm32
 */
function decodeAddSubThisImm(bytes, off) {
  if (off + 4 > bytes.length || bytes[off] !== 0x48) return null;
  const op = bytes[off + 1];
  const modrm = bytes[off + 2];

  if (op === 0x83) {
    const imm = readI8(bytes, off + 3);
    if (modrm === 0xef || modrm === 0xe9) return { delta: -imm, len: 4, thisReg: modrm === 0xef ? 'rdi' : 'rcx' };
    if (modrm === 0xc7 || modrm === 0xc1) return { delta: imm, len: 4, thisReg: modrm === 0xc7 ? 'rdi' : 'rcx' };
  }
  if (op === 0x81 && off + 7 <= bytes.length) {
    const imm = readI32(bytes, off + 3);
    if (modrm === 0xef || modrm === 0xe9) return { delta: -imm, len: 7, thisReg: modrm === 0xef ? 'rdi' : 'rcx' };
    if (modrm === 0xc7 || modrm === 0xc1) return { delta: imm, len: 7, thisReg: modrm === 0xc7 ? 'rdi' : 'rcx' };
  }
  return null;
}

function decodeRelJmp(bytes, off, baseVa) {
  if (off + 2 <= bytes.length && bytes[off] === 0xeb) {
    const rel8 = readI8(bytes, off + 1);
    return { targetVa: baseVa + BigInt(off + 2 + rel8), len: 2 };
  }
  if (off + 5 <= bytes.length && bytes[off] === 0xe9) {
    const rel32 = readI32(bytes, off + 1);
    return { targetVa: baseVa + BigInt(off + 5 + rel32), len: 5 };
  }
  return null;
}

/**
 * Match an x86-64 C++ `this`-adjuster thunk from raw instruction bytes.
 */
export function matchX8664CxxThunk(codeBytes, funcVa = 0n) {
  const bytes = codeBytes instanceof Uint8Array ? codeBytes : new Uint8Array(codeBytes || 0);
  if (bytes.length < 6) return null;

  const baseVa = BigInt(funcVa);
  let off = 0;

  // Skip leading ENDBR64 (F3 0F 1E FA)
  if (off + 4 <= bytes.length && bytes[0] === 0xf3 && bytes[1] === 0x0f && bytes[2] === 0x1e && bytes[3] === 0xfa) {
    off += 4;
  }

  let fixedDelta = 0;
  let hasFixed = false;
  let insnCount = off > 0 ? 1 : 0;

  const adj = decodeAddSubThisImm(bytes, off);
  if (adj) {
    fixedDelta = adj.delta;
    hasFixed = true;
    off += adj.len;
    insnCount++;
  }

  // Pattern 1: Non-virtual thunk (`add/sub rdi|rcx, imm; jmp rel`)
  if (hasFixed) {
    const jmp = decodeRelJmp(bytes, off, baseVa);
    if (jmp) {
      return {
        thunkVa: baseVa,
        targetVa: jmp.targetVa,
        fixedDelta,
        vcallOffset: 0,
        kind: THUNK_KIND_NON_VIRTUAL,
        arch: 'x86_64',
        insnCount: insnCount + 1,
      };
    }
  }

  // Pattern 2/3: Virtual or Virtual-Mixed thunk:
  //   mov rax, [rdi] (48 8B 07) ; add rdi, [rax + disp8/disp32] (48 03 78 disp8 | 48 03 B8 disp32) ; jmp rel
  if (off + 3 <= bytes.length && bytes[off] === 0x48 && bytes[off + 1] === 0x8b && bytes[off + 2] === 0x07) {
    off += 3;
    insnCount++;
    let vcallOffset = null;
    if (off + 4 <= bytes.length && bytes[off] === 0x48 && bytes[off + 1] === 0x03 && bytes[off + 2] === 0x78) {
      vcallOffset = readI8(bytes, off + 3);
      off += 4;
      insnCount++;
    } else if (off + 7 <= bytes.length && bytes[off] === 0x48 && bytes[off + 1] === 0x03 && bytes[off + 2] === 0xb8) {
      vcallOffset = readI32(bytes, off + 3);
      off += 7;
      insnCount++;
    }
    if (vcallOffset !== null) {
      const jmp = decodeRelJmp(bytes, off, baseVa);
      if (jmp) {
        return {
          thunkVa: baseVa,
          targetVa: jmp.targetVa,
          fixedDelta,
          vcallOffset,
          kind: hasFixed ? THUNK_KIND_VIRTUAL_MIXED : THUNK_KIND_VIRTUAL,
          arch: 'x86_64',
          insnCount: insnCount + 1,
        };
      }
    }
  }

  return null;
}

export const x8664ThunkPatternAdapter = Object.freeze({
  arch: 'x86_64',
  matchThunk: matchX8664CxxThunk,
});
