#ifndef HEX_ARM64_INSN_BITS_HPP
#define HEX_ARM64_INSN_BITS_HPP

#include <stdint.h>
#include <stddef.h>

namespace hex::arm64 {

enum class InsnClass : uint8_t {
  OTHER = 0,
  ARITH = 1,
  MULDIV = 2,
  BITWISE = 3,
  FP_SIMD = 4,
  LOAD = 5,
  STORE = 6,
  COND_BR = 7,
  UNCOND_BR = 8,
  CALL_DIR = 9,
  CALL_IND = 10,
  CRYPTO_SYS = 11,
};

struct MemOp {
  bool valid;
  bool is_store;
  bool is_float;
  uint8_t width;
  uint8_t rt;
  uint8_t rn;
  int32_t disp;
};

struct RegUsage {
  uint32_t gp_read;
  uint32_t gp_write;
  uint32_t fp_read;
  uint32_t fp_write;
  uint32_t gp_base_read;
  uint8_t ret_write_kind; // 0=none, 1=i32, 2=i64, 3=f32, 4=f64
  bool is_call;
  bool is_ret;
  bool is_branch;
};

struct RmwHit {
  uint32_t load_off;
  uint32_t store_off;
  int32_t disp;
  uint8_t base_reg;
  uint8_t op_kind; // 1=sub, 2=add
  uint8_t flags;   // bit0=clamped, bit1=float
  uint8_t width;
  uint32_t arith_off;
};

static_assert(sizeof(RmwHit) == 20, "RmwHit must match 20-byte WASM ABI layout");

struct RmwSummary {
  uint32_t total;
  uint32_t clamped_sub;
  uint32_t unclamped_sub;
  uint32_t add_rmw;
};

inline uint32_t read_u32_le(const uint8_t* p, uint32_t off) {
  return static_cast<uint32_t>(p[off]) |
         (static_cast<uint32_t>(p[off + 1u]) << 8) |
         (static_cast<uint32_t>(p[off + 2u]) << 16) |
         (static_cast<uint32_t>(p[off + 3u]) << 24);
}

inline bool is_hw_crypto(uint32_t w) {
  if ((w & 0xFF3E0C00u) == 0x4E280800u) {
    const uint32_t op = (w >> 12) & 0x1Fu;
    if (op >= 4u && op <= 7u) return true; // AESE/AESD/AESMC/AESIMC
  }
  if ((w & 0xFF208C00u) == 0x5E000000u) return true; // SHA1/SHA256 3-reg
  if ((w & 0xFF3E0C00u) == 0x5E280800u) return true; // SHA1/SHA256 2-reg
  if ((w & 0xFF000000u) == 0xCE000000u) return true; // SHA512/SHA3/SM3/SM4
  if ((w & 0x7FE0E000u) == 0x1AC04000u) return true; // CRC32
  return false;
}

inline bool is_ret(uint32_t w) {
  return (w & 0xFFFFFC1Fu) == 0xD65F0000u ||
         (w & 0xFFFFFBFFu) == 0xD65F0BFFu;
}

inline bool is_br_reg(uint32_t w, uint8_t& rn) {
  if ((w & 0xFFFFFC1Fu) == 0xD61F0000u) {
    rn = static_cast<uint8_t>((w >> 5) & 31u);
    return true;
  }
  return false;
}

inline bool is_call_or_ret(uint32_t w) {
  if ((w & 0xFC000000u) == 0x94000000u) return true; // BL
  if ((w & 0xFFFFFC1Fu) == 0xD63F0000u) return true; // BLR
  if ((w & 0xFEFFF800u) == 0xD63F0800u) return true; // BLRAA/BLRAB
  return is_ret(w);
}

inline bool is_uncond_branch(uint32_t w) {
  if ((w & 0xFC000000u) == 0x14000000u) return true; // B
  uint8_t rn = 0;
  return is_br_reg(w, rn);
}

inline bool is_cond_branch(uint32_t w) {
  if ((w & 0xFF000010u) == 0x54000000u) return true; // B.cond
  if ((w & 0x7E000000u) == 0x34000000u) return true; // CBZ/CBNZ
  if ((w & 0x7E000000u) == 0x36000000u) return true; // TBZ/TBNZ
  return false;
}

inline MemOp decode_imm_mem(uint32_t w) {
  MemOp op{false, false, false, 0, 0, 0, 0};
  const bool is_unsigned_off = (w & 0x3B000000u) == 0x39000000u;
  const bool is_unscaled_off = (w & 0x3B200C00u) == 0x38000000u;
  if (!is_unsigned_off && !is_unscaled_off) return op;

  const uint32_t size = (w >> 30) & 3u;
  const uint32_t v = (w >> 26) & 1u;
  const uint32_t opc = (w >> 22) & 3u;

  uint8_t width = 0;
  bool is_store = false;
  if (v == 0u) {
    if (opc == 0u) {
      is_store = true;
      width = static_cast<uint8_t>(1u << size);
    } else if (opc == 1u) {
      is_store = false;
      width = static_cast<uint8_t>(1u << size);
    } else if (opc == 2u) {
      if (size == 3u) return op; // PRFM
      is_store = false;
      width = static_cast<uint8_t>(1u << size);
    } else {
      if (size >= 2u) return op;
      is_store = false;
      width = static_cast<uint8_t>(1u << size);
    }
  } else {
    const uint32_t scale = size | ((opc & 2u) ? 4u : 0u);
    if (scale > 4u) return op;
    is_store = (opc & 1u) == 0u;
    width = static_cast<uint8_t>(1u << scale);
  }

  int32_t disp = 0;
  if (is_unsigned_off) {
    const uint32_t imm12 = (w >> 10) & 0xFFFu;
    disp = static_cast<int32_t>(imm12 * static_cast<uint32_t>(width));
  } else {
    int32_t imm9 = static_cast<int32_t>((w >> 12) & 0x1FFu);
    if (imm9 & 0x100) imm9 |= ~0x1FF;
    disp = imm9;
  }

  op.valid = true;
  op.is_store = is_store;
  op.is_float = (v != 0u);
  op.width = width;
  op.rt = static_cast<uint8_t>(w & 31u);
  op.rn = static_cast<uint8_t>((w >> 5) & 31u);
  op.disp = disp;
  return op;
}

inline bool is_reg_offset_load(uint32_t w, uint8_t& rt, uint8_t& rn, uint8_t& rm, uint8_t& width) {
  if ((w & 0x3B200C00u) != 0x38200800u) return false;
  if ((w & 0x04000000u) != 0u) return false; // integer only
  const uint32_t size = (w >> 30) & 3u;
  const uint32_t opc = (w >> 22) & 3u;
  if (opc == 0u) return false; // store
  if (opc == 2u && size == 3u) return false; // PRFM
  if (opc == 3u && size >= 2u) return false;
  rt = static_cast<uint8_t>(w & 31u);
  rn = static_cast<uint8_t>((w >> 5) & 31u);
  rm = static_cast<uint8_t>((w >> 16) & 31u);
  width = static_cast<uint8_t>(1u << size);
  return true;
}

inline bool is_arith_add_sub(uint32_t w, bool& is_sub, bool& is_float,
                             uint8_t& rd, uint8_t& rn, uint8_t& rm, bool& has_rm) {
  // Integer ADD/ADDS/SUB/SUBS immediate
  if ((w & 0x1F800000u) == 0x11000000u) {
    const uint8_t d = static_cast<uint8_t>(w & 31u);
    if (d == 31u) return false; // exclude CMP/CMN and SP adjust
    is_sub = ((w >> 30) & 1u) != 0u;
    is_float = false;
    rd = d;
    rn = static_cast<uint8_t>((w >> 5) & 31u);
    rm = 31u;
    has_rm = false;
    return true;
  }
  // Integer ADD/ADDS/SUB/SUBS shifted register
  if ((w & 0x1F200000u) == 0x0B000000u && ((w >> 22) & 3u) != 3u) {
    const uint8_t d = static_cast<uint8_t>(w & 31u);
    if (d == 31u) return false; // exclude CMP/CMN
    is_sub = ((w >> 30) & 1u) != 0u;
    is_float = false;
    rd = d;
    rn = static_cast<uint8_t>((w >> 5) & 31u);
    rm = static_cast<uint8_t>((w >> 16) & 31u);
    has_rm = true;
    return true;
  }
  // Integer ADD/ADDS/SUB/SUBS extended register
  if ((w & 0x1FE00000u) == 0x0B200000u) {
    const uint8_t d = static_cast<uint8_t>(w & 31u);
    if (d == 31u) return false;
    is_sub = ((w >> 30) & 1u) != 0u;
    is_float = false;
    rd = d;
    rn = static_cast<uint8_t>((w >> 5) & 31u);
    rm = static_cast<uint8_t>((w >> 16) & 31u);
    has_rm = true;
    return true;
  }
  // Scalar FP FADD / FSUB (S or D): rd == 31 is valid (S31/D31)
  if ((w & 0xFF20EC00u) == 0x1E202800u) {
    const uint32_t ftype = (w >> 22) & 3u;
    const uint32_t opcode = (w >> 12) & 0xFu;
    if (ftype <= 1u && (opcode == 2u || opcode == 3u)) {
      is_sub = (opcode == 3u);
      is_float = true;
      rd = static_cast<uint8_t>(w & 31u);
      rn = static_cast<uint8_t>((w >> 5) & 31u);
      rm = static_cast<uint8_t>((w >> 16) & 31u);
      has_rm = true;
      return true;
    }
  }
  return false;
}

inline bool is_clamp_or_cond(uint32_t w) {
  if ((w & 0x1FE00800u) == 0x1A800000u) return true; // CSEL/CSINC/CSINV/CSNEG
  if ((w & 0xFF200C00u) == 0x1E200C00u) return true; // FCSEL
  if ((w & 0xFF20CC00u) == 0x1E204800u) {
    const uint32_t op = (w >> 12) & 0xFu;
    if (op >= 4u && op <= 7u) return true; // FMAX/FMIN/FMAXNM/FMINNM
  }
  if ((w & 0x3F80001Fu) == 0x3100001Fu) return true; // CMP/CMN imm
  if ((w & 0x3F20001Fu) == 0x2B00001Fu) return true; // CMP/CMN reg
  if ((w & 0xFF20FC07u) == 0x1E202000u) return true; // FCMP/FCMPE
  return is_cond_branch(w);
}

inline bool is_cmp_imm(uint32_t w, uint8_t& rn, uint32_t& imm) {
  if ((w & 0x7F80001Fu) != 0x7100001Fu) return false; // SUBS WZR/XZR, Rn, #imm
  rn = static_cast<uint8_t>((w >> 5) & 31u);
  const uint32_t imm12 = (w >> 10) & 0xFFFu;
  const uint32_t sh = (w >> 22) & 1u;
  imm = sh ? (imm12 << 12) : imm12;
  return true;
}

inline bool is_b_hi_hs(uint32_t w, bool& is_hi) {
  if ((w & 0xFF000010u) != 0x54000000u) return false;
  const uint32_t cond = w & 0xFu;
  if (cond == 8u) {
    is_hi = true;
    return true;
  }
  if (cond == 2u) {
    is_hi = false;
    return true;
  }
  return false;
}

inline bool is_adrp(uint32_t w, uint8_t& rd, int64_t& page_delta) {
  if ((w & 0x9F000000u) != 0x90000000u) return false;
  const uint32_t immhi = (w >> 5) & 0x7FFFFu;
  const uint32_t immlo = (w >> 29) & 3u;
  int64_t imm = static_cast<int64_t>((immhi << 2) | immlo);
  if (imm & (1LL << 20)) imm |= ~((1LL << 21) - 1LL);
  rd = static_cast<uint8_t>(w & 31u);
  page_delta = imm << 12;
  return true;
}

inline bool is_adr(uint32_t w, uint8_t& rd, int64_t& delta) {
  if ((w & 0x9F000000u) != 0x10000000u) return false;
  const uint32_t immhi = (w >> 5) & 0x7FFFFu;
  const uint32_t immlo = (w >> 29) & 3u;
  int64_t imm = static_cast<int64_t>((immhi << 2) | immlo);
  if (imm & (1LL << 20)) imm |= ~((1LL << 21) - 1LL);
  rd = static_cast<uint8_t>(w & 31u);
  delta = imm;
  return true;
}

inline bool is_add_imm(uint32_t w, uint8_t& rd, uint8_t& rn, uint32_t& imm) {
  if ((w & 0x7F800000u) != 0x11000000u) return false;
  rd = static_cast<uint8_t>(w & 31u);
  rn = static_cast<uint8_t>((w >> 5) & 31u);
  const uint32_t imm12 = (w >> 10) & 0xFFFu;
  const uint32_t sh = (w >> 22) & 1u;
  imm = sh ? (imm12 << 12) : imm12;
  return true;
}

inline bool is_stp_fp_lr(uint32_t w) {
  return (w & 0xFFC07FFFu) == 0xA9807BFDu ||
         (w & 0xFFC07FFFu) == 0xA9007BFDu;
}

inline bool is_sub_sp_imm(uint32_t w, uint32_t& bytes) {
  if ((w & 0xFF8003FFu) != 0xD10003FFu) return false;
  const uint32_t imm12 = (w >> 10) & 0xFFFu;
  const uint32_t sh = (w >> 22) & 1u;
  bytes = sh ? (imm12 << 12) : imm12;
  return true;
}

inline InsnClass classify_insn(uint32_t w) {
  // 1. Hardware crypto
  if (is_hw_crypto(w)) return InsnClass::CRYPTO_SYS;

  // 2. Calls & Branches
  if ((w & 0xFC000000u) == 0x94000000u) return InsnClass::CALL_DIR;
  if ((w & 0xFFFFFC1Fu) == 0xD63F0000u || (w & 0xFEFFF800u) == 0xD63F0800u) return InsnClass::CALL_IND;
  if (is_cond_branch(w)) return InsnClass::COND_BR;
  if (is_uncond_branch(w) || is_ret(w)) return InsnClass::UNCOND_BR;

  // 3. Load / Store (both integer and FP checked BEFORE FP_SIMD)
  const MemOp mem = decode_imm_mem(w);
  if (mem.valid) return mem.is_store ? InsnClass::STORE : InsnClass::LOAD;
  {
    uint8_t rt = 0, rn = 0, rm = 0, width = 0;
    if (is_reg_offset_load(w, rt, rn, rm, width)) return InsnClass::LOAD;
  }
  // Register-offset store (int or FP) / pre-post-index single load-store / LDP-STP
  if ((w & 0x3B200C00u) == 0x38200800u) {
    const uint32_t v = (w >> 26) & 1u;
    const uint32_t opc = (w >> 22) & 3u;
    const bool is_store = v ? ((opc & 1u) == 0u) : (opc == 0u);
    return is_store ? InsnClass::STORE : InsnClass::LOAD;
  }
  if ((w & 0x3B200400u) == 0x38000400u) {
    const uint32_t v = (w >> 26) & 1u;
    const uint32_t opc = (w >> 22) & 3u;
    const bool is_store = v ? ((opc & 1u) == 0u) : (opc == 0u);
    return is_store ? InsnClass::STORE : InsnClass::LOAD;
  }
  if ((w & 0x3A000000u) == 0x28000000u) {
    return ((w >> 22) & 1u) ? InsnClass::LOAD : InsnClass::STORE; // LDP / STP
  }

  // 4. FP / SIMD data processing
  if ((w & 0x1E000000u) == 0x1E000000u ||
      (w & 0x0F000000u) == 0x0E000000u ||
      (w & 0x5E000000u) == 0x4E000000u) {
    return InsnClass::FP_SIMD;
  }

  // 5. Multiply / Divide
  if ((w & 0x1F000000u) == 0x1B000000u ||
      (w & 0x7FE0F800u) == 0x1AC00800u) {
    return InsnClass::MULDIV;
  }

  // 6. Integer Arithmetic
  if ((w & 0x1F800000u) == 0x11000000u ||
      (w & 0x1F000000u) == 0x0B000000u) {
    return InsnClass::ARITH;
  }

  // 7. Bitwise (excluding MOV alias ORR with Rn == 31)
  if ((w & 0x1F000000u) == 0x0A000000u) {
    const uint32_t opc = (w >> 29) & 3u;
    const uint32_t N = (w >> 21) & 1u;
    const uint32_t rn = (w >> 5) & 31u;
    if (opc == 1u && N == 0u && rn == 31u) return InsnClass::OTHER; // MOV reg alias
    return InsnClass::BITWISE;
  }
  if ((w & 0x1F800000u) == 0x12000000u) {
    const uint32_t opc = (w >> 29) & 3u;
    const uint32_t rn = (w >> 5) & 31u;
    if (opc == 1u && rn == 31u) return InsnClass::OTHER; // MOV imm alias
    return InsnClass::BITWISE;
  }
  if ((w & 0x1F800000u) == 0x13000000u ||
      (w & 0x7FE0F000u) == 0x1AC02000u) {
    return InsnClass::BITWISE;
  }

  return InsnClass::OTHER;
}

inline RegUsage decode_reg_usage(uint32_t w) {
  RegUsage u{0, 0, 0, 0, 0, 0, false, false, false};

  auto add_gp_r = [&](uint8_t r) { if (r < 31u) u.gp_read |= (1u << r); };
  auto add_gp_w = [&](uint8_t r, bool is64) {
    if (r < 31u) {
      u.gp_write |= (1u << r);
      if (r == 0u) u.ret_write_kind = is64 ? 2u : 1u;
    }
  };
  auto add_fp_r = [&](uint8_t r) { if (r < 32u) u.fp_read |= (1u << r); };
  auto add_fp_w = [&](uint8_t r, bool is64) {
    if (r < 32u) {
      u.fp_write |= (1u << r);
      if (r == 0u) u.ret_write_kind = is64 ? 4u : 3u;
    }
  };

  if (is_ret(w)) {
    u.is_ret = true;
    return u;
  }
  if ((w & 0xFC000000u) == 0x94000000u) { // BL
    u.is_call = true;
    return u;
  }
  if ((w & 0xFFFFFC1Fu) == 0xD63F0000u || (w & 0xFEFFF800u) == 0xD63F0800u) { // BLR
    u.is_call = true;
    add_gp_r(static_cast<uint8_t>((w >> 5) & 31u));
    return u;
  }
  if ((w & 0xFC000000u) == 0x14000000u) { // B
    u.is_branch = true;
    return u;
  }
  if ((w & 0xFFFFFC1Fu) == 0xD61F0000u) { // BR
    u.is_branch = true;
    add_gp_r(static_cast<uint8_t>((w >> 5) & 31u));
    return u;
  }
  if ((w & 0xFF000010u) == 0x54000000u) { // B.cond
    u.is_branch = true;
    return u;
  }
  if ((w & 0x7E000000u) == 0x34000000u || (w & 0x7E000000u) == 0x36000000u) { // CBZ/CBNZ/TBZ/TBNZ
    u.is_branch = true;
    add_gp_r(static_cast<uint8_t>(w & 31u));
    return u;
  }

  // Immediate Load / Store
  const MemOp mem = decode_imm_mem(w);
  if (mem.valid) {
    if (mem.rn < 31u) {
      u.gp_read |= (1u << mem.rn);
      u.gp_base_read |= (1u << mem.rn);
    }
    if (mem.is_store) {
      if (mem.is_float) add_fp_r(mem.rt);
      else add_gp_r(mem.rt);
    } else {
      if (mem.is_float) add_fp_w(mem.rt, mem.width >= 8u);
      else add_gp_w(mem.rt, mem.width >= 8u);
    }
    return u;
  }

  // Register-offset Load
  {
    uint8_t rt = 0, rn = 0, rm = 0, width = 0;
    if (is_reg_offset_load(w, rt, rn, rm, width)) {
      if (rn < 31u) {
        u.gp_read |= (1u << rn);
        u.gp_base_read |= (1u << rn);
      }
      add_gp_r(rm);
      add_gp_w(rt, width >= 8u);
      return u;
    }
  }

  // LDP / STP
  if ((w & 0x3A000000u) == 0x28000000u) {
    const uint8_t rt = static_cast<uint8_t>(w & 31u);
    const uint8_t rn = static_cast<uint8_t>((w >> 5) & 31u);
    const uint8_t rt2 = static_cast<uint8_t>((w >> 10) & 31u);
    const bool is_load = ((w >> 22) & 1u) != 0u;
    const bool is_fp = ((w >> 26) & 1u) != 0u;
    const uint32_t opc = (w >> 30) & 3u;
    const bool is64 = (opc != 0u);
    if (rn < 31u) {
      u.gp_read |= (1u << rn);
      u.gp_base_read |= (1u << rn);
    }
    if (is_load) {
      if (is_fp) { add_fp_w(rt, is64); add_fp_w(rt2, is64); }
      else { add_gp_w(rt, is64); add_gp_w(rt2, is64); }
    } else {
      if (is_fp) { add_fp_r(rt); add_fp_r(rt2); }
      else { add_gp_r(rt); add_gp_r(rt2); }
    }
    return u;
  }

  // MOVZ / MOVN / MOVK
  if ((w & 0x1F800000u) == 0x12800000u) {
    const bool is64 = ((w >> 31) & 1u) != 0u;
    const uint8_t rd = static_cast<uint8_t>(w & 31u);
    if (((w >> 29) & 3u) == 3u) add_gp_r(rd); // MOVK reads rd
    add_gp_w(rd, is64);
    return u;
  }

  // ADRP / ADR
  if ((w & 0x1F000000u) == 0x10000000u) {
    add_gp_w(static_cast<uint8_t>(w & 31u), true);
    return u;
  }

  // Integer ADD/SUB imm (including CMP/CMN imm)
  if ((w & 0x1F800000u) == 0x11000000u) {
    const bool is64 = ((w >> 31) & 1u) != 0u;
    const uint8_t rd = static_cast<uint8_t>(w & 31u);
    const uint8_t rn = static_cast<uint8_t>((w >> 5) & 31u);
    add_gp_r(rn);
    add_gp_w(rd, is64);
    return u;
  }

  // Integer ADD/SUB reg (including CMP/CMN reg)
  if ((w & 0x1F000000u) == 0x0B000000u) {
    const bool is64 = ((w >> 31) & 1u) != 0u;
    add_gp_r(static_cast<uint8_t>((w >> 5) & 31u));
    add_gp_r(static_cast<uint8_t>((w >> 16) & 31u));
    add_gp_w(static_cast<uint8_t>(w & 31u), is64);
    return u;
  }

  // Logical reg (ORR/AND/EOR/BIC including MOV reg)
  if ((w & 0x1F000000u) == 0x0A000000u) {
    const bool is64 = ((w >> 31) & 1u) != 0u;
    add_gp_r(static_cast<uint8_t>((w >> 5) & 31u));
    add_gp_r(static_cast<uint8_t>((w >> 16) & 31u));
    add_gp_w(static_cast<uint8_t>(w & 31u), is64);
    return u;
  }

  // Logical imm / Bitfield
  if ((w & 0x1F800000u) == 0x12000000u || (w & 0x1F800000u) == 0x13000000u) {
    const bool is64 = ((w >> 31) & 1u) != 0u;
    add_gp_r(static_cast<uint8_t>((w >> 5) & 31u));
    add_gp_w(static_cast<uint8_t>(w & 31u), is64);
    return u;
  }

  // Multiply / Divide / CSEL
  if ((w & 0x1F000000u) == 0x1B000000u ||
      (w & 0x7FE0F800u) == 0x1AC00800u ||
      (w & 0x1FE00800u) == 0x1A800000u) {
    const bool is64 = ((w >> 31) & 1u) != 0u;
    add_gp_r(static_cast<uint8_t>((w >> 5) & 31u));
    add_gp_r(static_cast<uint8_t>((w >> 16) & 31u));
    add_gp_w(static_cast<uint8_t>(w & 31u), is64);
    return u;
  }

  // Scalar FP 2-source (FADD/FSUB/FMUL/FDIV/FMAX/FMIN)
  if ((w & 0xFF200C00u) == 0x1E200800u) {
    const uint32_t ftype = (w >> 22) & 3u;
    if (ftype <= 1u) {
      add_fp_r(static_cast<uint8_t>((w >> 5) & 31u));
      add_fp_r(static_cast<uint8_t>((w >> 16) & 31u));
      add_fp_w(static_cast<uint8_t>(w & 31u), ftype == 1u);
      return u;
    }
  }

  // Scalar FP 1-source (FMOV/FABS/FNEG/FSQRT)
  if ((w & 0xFF207C00u) == 0x1E204000u) {
    const uint32_t ftype = (w >> 22) & 3u;
    if (ftype <= 1u) {
      add_fp_r(static_cast<uint8_t>((w >> 5) & 31u));
      add_fp_w(static_cast<uint8_t>(w & 31u), ftype == 1u);
      return u;
    }
  }

  // Scalar FCMP
  if ((w & 0xFF20FC07u) == 0x1E202000u) {
    const uint32_t ftype = (w >> 22) & 3u;
    if (ftype <= 1u) {
      add_fp_r(static_cast<uint8_t>((w >> 5) & 31u));
      if (((w >> 3) & 1u) == 0u) add_fp_r(static_cast<uint8_t>((w >> 16) & 31u));
      return u;
    }
  }

  // Scalar FP imm (FMOV S/D, #imm)
  if ((w & 0xFF201FE0u) == 0x1E201000u) {
    const uint32_t ftype = (w >> 22) & 3u;
    if (ftype <= 1u) {
      add_fp_w(static_cast<uint8_t>(w & 31u), ftype == 1u);
      return u;
    }
  }

  return u;
}

// Shared RMW+Clamp core used by both Track 1 (scanner) and Track 8 (behavior classifier).
// Guarantees 1:1 parity between C++/WASM and JS fallback.
inline uint32_t scan_arm64_rmw_core(const uint8_t* code_ptr, uint32_t code_len,
                                    RmwHit* out_hits, uint32_t max_out,
                                    RmwSummary* summary) {
  if (summary) {
    summary->total = 0;
    summary->clamped_sub = 0;
    summary->unclamped_sub = 0;
    summary->add_rmw = 0;
  }
  if (!code_ptr || code_len < 4u) return 0u;
  if (out_hits && max_out == 0u) return 0u;

  struct PendingLoad {
    bool active;
    bool is_float;
    uint8_t val_reg;
    uint8_t base_reg;
    uint8_t width;
    uint8_t op_kind; // 0=none, 1=sub, 2=add
    bool clamped;
    int32_t disp;
    uint32_t load_off;
    uint32_t arith_off;
  };

  constexpr uint32_t MAX_PENDING = 16u;
  constexpr uint32_t MAX_WINDOW_BYTES = 64u; // 16 instructions
  PendingLoad pending[MAX_PENDING];
  for (uint32_t i = 0; i < MAX_PENDING; ++i) pending[i].active = false;

  const uint32_t limit = code_len & ~3u;
  uint32_t written = 0u;
  uint32_t total = 0u;

  auto clear_all = [&]() {
    for (uint32_t i = 0; i < MAX_PENDING; ++i) pending[i].active = false;
  };

  for (uint32_t off = 0u; off < limit; off += 4u) {
    const uint32_t w = read_u32_le(code_ptr, off);

    // Expire loads older than 16 instructions
    for (uint32_t i = 0; i < MAX_PENDING; ++i) {
      if (pending[i].active && (off - pending[i].load_off) > MAX_WINDOW_BYTES) {
        pending[i].active = false;
      }
    }

    // Control-flow barriers clear all pending loads
    if (is_call_or_ret(w) || is_uncond_branch(w)) {
      clear_all();
      continue;
    }

    // Mark clamp/cond on all active modified pending loads
    if (is_clamp_or_cond(w)) {
      for (uint32_t i = 0; i < MAX_PENDING; ++i) {
        if (pending[i].active) pending[i].clamped = true;
      }
    }

    // 1. Check immediate memory load/store
    const MemOp mem = decode_imm_mem(w);
    if (mem.valid) {
      if (!mem.is_store) {
        // Load into mem.rt
        // If integer load overwrites a pending load's base_reg, invalidate it
        if (!mem.is_float && mem.rt < 31u) {
          for (uint32_t i = 0; i < MAX_PENDING; ++i) {
            if (pending[i].active && pending[i].base_reg == mem.rt) {
              pending[i].active = false;
            }
          }
        }
        // Exclude SP (31) and FP (29), and exclude integer XZR/WZR (31)
        if (mem.rn != 31u && mem.rn != 29u && (mem.is_float || mem.rt != 31u)) {
          // Overwrite any existing slot tracking the same (is_float, val_reg), or pick free/oldest
          int32_t slot = -1;
          uint32_t oldest_off = 0xFFFFFFFFu;
          int32_t oldest_idx = 0;
          for (uint32_t i = 0; i < MAX_PENDING; ++i) {
            if (pending[i].active && pending[i].is_float == mem.is_float && pending[i].val_reg == mem.rt) {
              slot = static_cast<int32_t>(i);
              break;
            }
            if (!pending[i].active && slot < 0) slot = static_cast<int32_t>(i);
            if (pending[i].active && pending[i].load_off < oldest_off) {
              oldest_off = pending[i].load_off;
              oldest_idx = static_cast<int32_t>(i);
            }
          }
          if (slot < 0) slot = oldest_idx;
          pending[slot] = PendingLoad{
            true, mem.is_float, mem.rt, mem.rn, mem.width, 0u, false, mem.disp, off, 0u
          };
        }
      } else {
        // Store from mem.rt to [mem.rn + mem.disp]
        for (uint32_t i = 0; i < MAX_PENDING; ++i) {
          if (!pending[i].active) continue;
          if (pending[i].op_kind == 0u) continue;
          if (pending[i].is_float != mem.is_float) continue;
          if (pending[i].base_reg != mem.rn || pending[i].disp != mem.disp) continue;
          if (pending[i].val_reg != mem.rt) continue;

          bool clamped = pending[i].clamped;
          if (!clamped) {
            // Lookahead up to 3 instructions (12 bytes) after store for post-store branch/cmp
            for (uint32_t la = off + 4u; la < limit && la <= off + 12u; la += 4u) {
              const uint32_t lw = read_u32_le(code_ptr, la);
              if (is_call_or_ret(lw) || is_uncond_branch(lw)) break;
              if (is_clamp_or_cond(lw)) {
                clamped = true;
                break;
              }
            }
          }

          total++;
          if (summary) {
            summary->total++;
            if (pending[i].op_kind == 1u) {
              if (clamped) summary->clamped_sub++;
              else summary->unclamped_sub++;
            } else {
              summary->add_rmw++;
            }
          }
          if (out_hits && written < max_out) {
            out_hits[written++] = RmwHit{
              pending[i].load_off,
              off,
              pending[i].disp,
              pending[i].base_reg,
              pending[i].op_kind,
              static_cast<uint8_t>((clamped ? 1u : 0u) | (pending[i].is_float ? 2u : 0u)),
              pending[i].width,
              pending[i].arith_off,
            };
          }
          pending[i].active = false;
          break;
        }
      }
      continue;
    }

    // 2. Check ADD/SUB arithmetic
    bool is_sub = false, is_float = false, has_rm = false;
    uint8_t rd = 0, rn = 0, rm = 0;
    if (is_arith_add_sub(w, is_sub, is_float, rd, rn, rm, has_rm)) {
      // Invalidate any pending whose base_reg is overwritten by integer rd
      if (!is_float && rd < 31u) {
        for (uint32_t i = 0; i < MAX_PENDING; ++i) {
          if (pending[i].active && pending[i].base_reg == rd) {
            pending[i].active = false;
          }
        }
      }
      for (uint32_t i = 0; i < MAX_PENDING; ++i) {
        if (!pending[i].active || pending[i].is_float != is_float) continue;
        const bool match_rn = (rn == pending[i].val_reg);
        const bool match_rm = has_rm && (rm == pending[i].val_reg);
        // For SUB: field value must be the minuend (rn == val_reg). For ADD: commutative.
        if ((is_sub && match_rn) || (!is_sub && (match_rn || match_rm))) {
          pending[i].val_reg = rd;
          pending[i].op_kind = is_sub ? 1u : 2u;
          pending[i].arith_off = off;
        }
      }
      continue;
    }

    // 3. Check CSEL / FCSEL / FMAX / FMIN register propagation (e.g. csel w8, wzr, w8, lt)
    if ((w & 0x1FE00800u) == 0x1A800000u) { // CSEL/CSINC/CSINV/CSNEG
      const uint8_t crd = static_cast<uint8_t>(w & 31u);
      const uint8_t crn = static_cast<uint8_t>((w >> 5) & 31u);
      const uint8_t crm = static_cast<uint8_t>((w >> 16) & 31u);
      if (crd < 31u) {
        for (uint32_t i = 0; i < MAX_PENDING; ++i) {
          if (pending[i].active && pending[i].base_reg == crd) pending[i].active = false;
        }
        for (uint32_t i = 0; i < MAX_PENDING; ++i) {
          if (pending[i].active && !pending[i].is_float &&
              (pending[i].val_reg == crn || pending[i].val_reg == crm)) {
            pending[i].val_reg = crd;
            pending[i].clamped = true;
          }
        }
      }
      continue;
    }
    if ((w & 0xFF200C00u) == 0x1E200C00u ||
        ((w & 0xFF20CC00u) == 0x1E204800u && (((w >> 12) & 0xFu) >= 4u && ((w >> 12) & 0xFu) <= 7u))) {
      const uint8_t crd = static_cast<uint8_t>(w & 31u);
      const uint8_t crn = static_cast<uint8_t>((w >> 5) & 31u);
      const uint8_t crm = static_cast<uint8_t>((w >> 16) & 31u);
      for (uint32_t i = 0; i < MAX_PENDING; ++i) {
        if (pending[i].active && pending[i].is_float &&
            (pending[i].val_reg == crn || pending[i].val_reg == crm)) {
          pending[i].val_reg = crd;
          pending[i].clamped = true;
        }
      }
      continue;
    }

    // 4. General register overwrite invalidation for base_reg
    const RegUsage ru = decode_reg_usage(w);
    if (ru.gp_write != 0u) {
      for (uint32_t i = 0; i < MAX_PENDING; ++i) {
        if (pending[i].active && pending[i].base_reg < 31u &&
            ((ru.gp_write >> pending[i].base_reg) & 1u) != 0u) {
          pending[i].active = false;
        }
      }
    }
  }

  return out_hits ? written : total;
}

} // namespace hex::arm64

#endif // HEX_ARM64_INSN_BITS_HPP
