#include "arm64_decode.hpp"

namespace {

constexpr uint8_t kKindCapTable[27] = {
    HEX_ARM64_CAP_FALLBACK,  // OTHER
    HEX_ARM64_CAP_FALLBACK,  // NOP
    HEX_ARM64_CAP_FALLBACK,  // ADRP
    HEX_ARM64_CAP_DECOMP,    // MOVIMM
    HEX_ARM64_CAP_DECOMP,    // MOVREG
    HEX_ARM64_CAP_DECOMP,    // ARITH
    HEX_ARM64_CAP_DECOMP,    // MUL
    HEX_ARM64_CAP_FALLBACK,  // DIV
    HEX_ARM64_CAP_FALLBACK,  // LOGIC
    HEX_ARM64_CAP_FALLBACK,  // SHIFT
    HEX_ARM64_CAP_FALLBACK,  // FARITH
    HEX_ARM64_CAP_FALLBACK,  // FMUL
    HEX_ARM64_CAP_FALLBACK,  // FCONV
    HEX_ARM64_CAP_FALLBACK,  // SIMD
    HEX_ARM64_CAP_FALLBACK,  // LOAD
    HEX_ARM64_CAP_FALLBACK,  // STORE
    HEX_ARM64_CAP_FALLBACK,  // CMP
    HEX_ARM64_CAP_FALLBACK,  // CONDBR
    HEX_ARM64_CAP_FALLBACK,  // BRANCH
    HEX_ARM64_CAP_FALLBACK,  // CALL
    HEX_ARM64_CAP_FALLBACK,  // INDCALL
    HEX_ARM64_CAP_DECOMP,    // RET
    HEX_ARM64_CAP_FALLBACK,  // CSEL
    HEX_ARM64_CAP_FALLBACK,  // ATOMIC
    HEX_ARM64_CAP_FALLBACK,  // SYS
    HEX_ARM64_CAP_FALLBACK,  // TRAP
    HEX_ARM64_CAP_FALLBACK,  // LITERAL
};

// Bit-exact, UB-free helpers on uint32_t / uint64_t.
constexpr uint32_t masked(uint32_t w, uint32_t mask) { return w & mask; }
constexpr uint8_t reg_rd(uint32_t w) { return static_cast<uint8_t>(w & 0x1fU); }
constexpr uint8_t reg_rn(uint32_t w) { return static_cast<uint8_t>((w >> 5) & 0x1fU); }
constexpr uint8_t reg_rm(uint32_t w) { return static_cast<uint8_t>((w >> 16) & 0x1fU); }

constexpr int64_t sign_extend(uint32_t value, uint32_t bits) {
  const uint64_t mask = (1ULL << bits) - 1ULL;
  const uint64_t sign = 1ULL << (bits - 1U);
  const uint64_t v = static_cast<uint64_t>(value) & mask;
  return static_cast<int64_t>((v ^ sign) - sign);
}

constexpr uint64_t add_signed_u64(uint64_t base, int64_t delta) {
  return base + static_cast<uint64_t>(delta);
}

constexpr bool is_prefetch_immediate(uint32_t w) {
  return masked(w, 0xffc00000U) == 0xf9800000U;
}

constexpr bool is_prefetch_literal(uint32_t w) {
  return masked(w, 0x3b000000U) == 0x18000000U &&
         ((w >> 30) & 3U) == 3U &&
         ((w >> 26) & 1U) == 0U;
}

constexpr bool is_call_imm(uint32_t w) { return masked(w, 0xfc000000U) == 0x94000000U; }
constexpr bool is_branch_imm(uint32_t w) { return masked(w, 0xfc000000U) == 0x14000000U; }

constexpr bool is_ret(uint32_t w) {
  return masked(w, 0xfffffc1fU) == 0xd65f0000U || masked(w, 0xfffffbffU) == 0xd65f0bffU;
}

constexpr bool is_br(uint32_t w) {
  return masked(w, 0xfffffc1fU) == 0xd61f0000U ||
         masked(w, 0xfffff81fU) == 0xd61f081fU ||
         masked(w, 0xffe0f800U) == 0xd7000800U;
}

constexpr bool is_indirect_call(uint32_t w) {
  if (masked(w, 0xfffffc1fU) == 0xd63f0000U) return true;  // blr
  if (masked(w, 0xfffff800U) == 0xd63f0800U) return true;  // blraaz / blrabz
  if (masked(w, 0xffe0f800U) == 0xd7200800U) return true;  // blraa / blrab
  return false;
}

constexpr uint32_t transfer_scale(uint32_t w) {
  const uint32_t size = (w >> 30) & 3U;
  const bool vector = ((w >> 26) & 1U) == 1U;
  const bool opc_high = ((w >> 23) & 1U) == 1U;
  return (vector && opc_high) ? (size + 4U) : size;
}

constexpr bool transfer_is_load(uint32_t w) {
  if (is_prefetch_immediate(w)) return false;
  if (((w >> 26) & 1U) == 1U) return ((w >> 22) & 1U) == 1U;
  return ((w >> 22) & 3U) != 0U;
}

constexpr bool is_add_sub_imm(uint32_t w) { return masked(w, 0x1f000000U) == 0x11000000U; }
constexpr bool is_add_sub_shifted(uint32_t w) { return masked(w, 0x1f200000U) == 0x0b000000U; }
constexpr bool is_add_sub_extended(uint32_t w) { return masked(w, 0x1f200000U) == 0x0b200000U; }
constexpr bool is_logic_imm(uint32_t w) { return masked(w, 0x1f800000U) == 0x12000000U; }
constexpr bool is_logic_shifted(uint32_t w) { return masked(w, 0x1f000000U) == 0x0a000000U; }
constexpr bool is_move_wide(uint32_t w) { return masked(w, 0x1f800000U) == 0x12800000U; }
constexpr bool is_bitfield(uint32_t w) { return masked(w, 0x1f800000U) == 0x13000000U; }
constexpr bool is_dp3(uint32_t w) { return masked(w, 0x1f000000U) == 0x1b000000U; }
constexpr bool is_dp2(uint32_t w) { return masked(w, 0x5fe00000U) == 0x1ac00000U; }
constexpr bool is_cond_select(uint32_t w) { return masked(w, 0x1fe00000U) == 0x1a800000U; }
constexpr bool is_fp_cond_select(uint32_t w) { return masked(w, 0x5f200c00U) == 0x1e200c00U; }
constexpr bool is_cond_compare(uint32_t w) { return masked(w, 0x1fe00000U) == 0x1a400000U; }
constexpr bool is_fp_dp2(uint32_t w) { return masked(w, 0x5f200c00U) == 0x1e200800U; }
constexpr bool is_fp_dp3(uint32_t w) { return masked(w, 0x5f200000U) == 0x1f000000U; }
constexpr bool is_fp_dp1(uint32_t w) { return masked(w, 0x5f207c00U) == 0x1e204000U; }
constexpr bool is_fp_compare(uint32_t w) { return masked(w, 0x5f203c00U) == 0x1e202000U; }
constexpr bool is_fp_to_int(uint32_t w) { return masked(w, 0x5f20fc00U) == 0x1e200000U; }
constexpr bool is_fp_imm(uint32_t w) { return masked(w, 0x5f201c00U) == 0x1e201000U; }
constexpr bool is_fp_fixed_convert(uint32_t w) { return masked(w, 0x5f200000U) == 0x1e000000U; }
constexpr bool is_simd_scalar_int_float_convert(uint32_t w) {
  return masked(w, 0xdf3ffc00U) == 0x5e21d800U;
}
constexpr bool is_integer_one_source_bit_op(uint32_t w) {
  return masked(w, 0x5fe00000U) == 0x5ac00000U;
}

constexpr bool is_multiply(uint32_t w) {
  if (!is_dp3(w)) return false;
  const uint32_t op31 = (w >> 21) & 7U;
  return op31 == 0U || op31 == 1U || op31 == 2U || op31 == 3U ||
         op31 == 5U || op31 == 6U || op31 == 7U;
}

constexpr bool is_divide(uint32_t w) {
  if (!is_dp2(w)) return false;
  const uint32_t opcode = (w >> 10) & 0x3fU;
  return opcode == 2U || opcode == 3U;
}

constexpr bool is_shift_op(uint32_t w) {
  if (is_bitfield(w)) return true;
  if (!is_dp2(w)) return false;
  const uint32_t opcode = (w >> 10) & 0x3fU;
  return opcode >= 8U && opcode <= 11U;
}

constexpr bool is_fp_mul_div(uint32_t w) {
  if (!is_fp_dp2(w)) return is_fp_dp3(w);
  const uint32_t opcode = (w >> 12) & 0xfU;
  return opcode == 0U || opcode == 1U || opcode == 8U;
}

constexpr bool is_fp_add_sub(uint32_t w) {
  if (!is_fp_dp2(w)) return false;
  const uint32_t opcode = (w >> 12) & 0xfU;
  return opcode == 2U || opcode == 3U || opcode == 4U || opcode == 5U;
}

constexpr bool is_simd(uint32_t w) {
  if (masked(w, 0x9f000000U) == 0x0e000000U) return true;
  if (masked(w, 0x9f000000U) == 0x0f000000U) return true;
  if (masked(w, 0xbf000000U) == 0x0c000000U) return true;
  if (masked(w, 0xbf000000U) == 0x0d000000U) return true;
  return false;
}

constexpr bool is_nop(uint32_t w) {
  if (w == 0xd503201fU) return true;
  if (masked(w, 0xffffff1fU) == 0xd503241fU) return true;
  if (masked(w, 0xfffff01fU) == 0xd503201fU) return true;
  if (w == 0xd503233fU || w == 0xd503237fU) return true;
  if (w == 0xd50323bfU || w == 0xd50323ffU) return true;
  return false;
}

constexpr bool is_system(uint32_t w) { return masked(w, 0xffc00000U) == 0xd5000000U; }

constexpr uint8_t classify_memory_kind(uint32_t w) {
  const uint32_t atomic_class = masked(w, 0x3f000000U);
  if (atomic_class == 0x08000000U) return HEX_ARM64_KIND_ATOMIC;
  if (atomic_class == 0x38000000U && ((w >> 21) & 1U) == 1U && ((w >> 10) & 3U) == 0U) {
    if (((w >> 12) & 0xfU) < 9U) return HEX_ARM64_KIND_ATOMIC;
  }
  if (masked(w, 0x3a000000U) == 0x28000000U) {
    if (((w >> 30) & 3U) == 3U) return HEX_ARM64_KIND_OTHER;
    return ((w >> 22) & 1U) == 1U ? HEX_ARM64_KIND_LOAD : HEX_ARM64_KIND_STORE;
  }
  if (masked(w, 0x3b000000U) == 0x39000000U) {
    if (is_prefetch_immediate(w)) return HEX_ARM64_KIND_OTHER;
    return transfer_is_load(w) ? HEX_ARM64_KIND_LOAD : HEX_ARM64_KIND_STORE;
  }
  if (masked(w, 0x3b200000U) == 0x38000000U ||
      masked(w, 0x3b200c00U) == 0x38200800U) {
    return transfer_is_load(w) ? HEX_ARM64_KIND_LOAD : HEX_ARM64_KIND_STORE;
  }
  return HEX_ARM64_KIND_OTHER;
}

constexpr uint8_t make_ordering(bool acq, bool rel) {
  if (acq) return rel ? HEX_ARM64_ORDER_ACQ_REL : HEX_ARM64_ORDER_ACQUIRE;
  return rel ? HEX_ARM64_ORDER_RELEASE : HEX_ARM64_ORDER_RELAXED;
}

// ── Compact freestanding text formatter ──────────────────────────────────────

struct StrBuf {
  char* dst;
  size_t cap;
  size_t len;

  void init(char* buf, size_t capacity) {
    dst = buf;
    cap = capacity;
    len = 0;
    if (cap > 0) dst[0] = '\0';
  }

  void push(char c) {
    if (len + 1 < cap) {
      dst[len++] = c;
      dst[len] = '\0';
    }
  }

  void append(const char* s) {
    if (!s) return;
    while (*s != '\0') push(*s++);
  }

  void append_u64_dec(uint64_t v) {
    char tmp[24];
    size_t n = 0;
    if (v == 0) {
      push('0');
      return;
    }
    while (v > 0 && n < sizeof(tmp)) {
      tmp[n++] = static_cast<char>('0' + (v % 10ULL));
      v /= 10ULL;
    }
    while (n > 0) push(tmp[--n]);
  }

  void append_u64_hex(uint64_t v) {
    static constexpr char kHex[] = "0123456789abcdef";
    char tmp[16];
    size_t n = 0;
    if (v == 0) {
      push('0');
      return;
    }
    while (v > 0 && n < sizeof(tmp)) {
      tmp[n++] = kHex[v & 0xfULL];
      v >>= 4;
    }
    while (n > 0) push(tmp[--n]);
  }

  void append_imm_hex(uint64_t v) {
    append("#0x");
    append_u64_hex(v);
  }

  void append_signed_imm_hex(int64_t v) {
    if (v < 0) {
      append("#-0x");
      const uint64_t mag = 0ULL - static_cast<uint64_t>(v);
      append_u64_hex(mag);
    } else {
      append("#0x");
      append_u64_hex(static_cast<uint64_t>(v));
    }
  }

  void append_gp_reg(uint8_t r, bool is64, bool sp_for_31) {
    if (r == 31U) {
      if (sp_for_31) {
        append(is64 ? "sp" : "wsp");
      } else {
        append(is64 ? "xzr" : "wzr");
      }
      return;
    }
    push(is64 ? 'x' : 'w');
    append_u64_dec(r);
  }

  void append_fp_reg(uint8_t r, uint8_t size_bytes) {
    char p = 'd';
    if (size_bytes == 1) p = 'b';
    else if (size_bytes == 2) p = 'h';
    else if (size_bytes == 4) p = 's';
    else if (size_bytes == 8) p = 'd';
    else if (size_bytes == 16) p = 'q';
    push(p);
    append_u64_dec(r);
  }
};

constexpr const char* kCondNames[16] = {
    "eq", "ne", "hs", "lo", "mi", "pl", "vs", "vc",
    "hi", "ls", "ge", "lt", "gt", "le", "al", "nv",
};

constexpr const char* kShiftNames[4] = {"lsl", "lsr", "asr", "ror"};
constexpr const char* kExtNames[8] = {
    "uxtb", "uxth", "uxtw", "uxtx", "sxtb", "sxth", "sxtw", "sxtx",
};

void format_mem_bracket(StrBuf& ops, uint8_t base, uint8_t mode, bool has_disp, int64_t disp) {
  ops.push('[');
  ops.append_gp_reg(base, true, true);
  if (mode == HEX_ARM64_MEM_MODE_POST) {
    ops.push(']');
    if (has_disp) {
      ops.append(", ");
      ops.append_signed_imm_hex(disp);
    }
  } else if (mode == HEX_ARM64_MEM_MODE_PRE) {
    if (has_disp) {
      ops.append(", ");
      ops.append_signed_imm_hex(disp);
    }
    ops.append("]!");
  } else {
    if (has_disp && disp != 0) {
      ops.append(", ");
      ops.append_signed_imm_hex(disp);
    }
    ops.push(']');
  }
}

void format_instruction_text(const HexArm64Decoded& d, char mn_out[16], char ops_out[64]) {
  const uint32_t w = d.word;
  StrBuf mn;
  StrBuf ops;
  mn.init(mn_out, 16);
  ops.init(ops_out, 64);

  if (w == 0xd503201fU) { mn.append("nop"); return; }
  if (w == 0xd503233fU) { mn.append("paciasp"); return; }
  if (w == 0xd503237fU) { mn.append("pacibsp"); return; }
  if (w == 0xd50323bfU) { mn.append("autiasp"); return; }
  if (w == 0xd50323ffU) { mn.append("autibsp"); return; }
  if (masked(w, 0xffffff1fU) == 0xd503241fU) {
    mn.append("bti");
    const uint32_t targets = (w >> 6) & 3U;
    if (targets == 1U) ops.append("c");
    else if (targets == 2U) ops.append("j");
    else if (targets == 3U) ops.append("jc");
    return;
  }
  if (masked(w, 0xfffff01fU) == 0xd503201fU) {
    mn.append("hint");
    ops.append_imm_hex((w >> 5) & 0x7fU);
    return;
  }
  if (masked(w, 0xffe0001fU) == 0xd4200000U) {
    mn.append("brk");
    ops.append_imm_hex((w >> 5) & 0xffffU);
    return;
  }
  if (masked(w, 0xffff0000U) == 0x00000000U && w != 0U) {
    mn.append("udf");
    ops.append_imm_hex(w & 0xffffU);
    return;
  }

  // Branches / Calls / Returns
  if (is_branch_imm(w) || is_call_imm(w)) {
    mn.append(is_call_imm(w) ? "bl" : "b");
    ops.append_imm_hex(d.target);
    return;
  }
  if (masked(w, 0xff000010U) == 0x54000000U) {
    mn.append("b.");
    mn.append(kCondNames[w & 0xfU]);
    ops.append_imm_hex(d.target);
    return;
  }
  if (masked(w, 0x7e000000U) == 0x34000000U) {
    const bool sf = ((w >> 31) & 1U) != 0U;
    const bool nz = ((w >> 24) & 1U) != 0U;
    mn.append(nz ? "cbnz" : "cbz");
    ops.append_gp_reg(reg_rd(w), sf, false);
    ops.append(", ");
    ops.append_imm_hex(d.target);
    return;
  }
  if (masked(w, 0x7e000000U) == 0x36000000U) {
    const uint32_t b5 = (w >> 31) & 1U;
    const uint32_t b40 = (w >> 19) & 0x1fU;
    const uint32_t bit = (b5 << 5) | b40;
    const bool nz = ((w >> 24) & 1U) != 0U;
    mn.append(nz ? "tbnz" : "tbz");
    ops.append_gp_reg(reg_rd(w), b5 != 0U, false);
    ops.append(", #");
    ops.append_u64_dec(bit);
    ops.append(", ");
    ops.append_imm_hex(d.target);
    return;
  }
  if (masked(w, 0xfffffc1fU) == 0xd65f0000U) {
    mn.append("ret");
    const uint8_t rn = reg_rn(w);
    if (rn != 30U) ops.append_gp_reg(rn, true, false);
    return;
  }
  if (masked(w, 0xfffffbffU) == 0xd65f0bffU) {
    mn.append(((w >> 10) & 1U) ? "retab" : "retaa");
    return;
  }
  if (masked(w, 0xfffffc1fU) == 0xd61f0000U) {
    mn.append("br");
    ops.append_gp_reg(reg_rn(w), true, false);
    return;
  }
  if (masked(w, 0xfffffc1fU) == 0xd63f0000U) {
    mn.append("blr");
    ops.append_gp_reg(reg_rn(w), true, false);
    return;
  }

  // ADR / ADRP
  if (d.has_pc_rel) {
    mn.append(d.pc_rel.page ? "adrp" : "adr");
    ops.append_gp_reg(d.pc_rel.reg, true, false);
    ops.append(", ");
    ops.append_imm_hex(d.pc_rel.value);
    return;
  }

  // Move wide (MOVZ / MOVN / MOVK)
  if (is_move_wide(w)) {
    const uint32_t opc = (w >> 29) & 3U;
    const bool sf = ((w >> 31) & 1U) != 0U;
    const uint32_t hw = (w >> 21) & 3U;
    const uint32_t imm16 = (w >> 5) & 0xffffU;
    if (opc == 0U || opc == 2U || opc == 3U) {
      mn.append(opc == 0U ? "movn" : (opc == 2U ? "movz" : "movk"));
      ops.append_gp_reg(reg_rd(w), sf, false);
      ops.append(", ");
      ops.append_imm_hex(imm16);
      if (hw != 0U) {
        ops.append(", lsl #");
        ops.append_u64_dec(static_cast<uint64_t>(hw) * 16ULL);
      }
      return;
    }
  }

  // ADD/SUB immediate (and CMP/CMN/MOV alias)
  if (is_add_sub_imm(w)) {
    const bool sf = ((w >> 31) & 1U) != 0U;
    const bool is_sub = ((w >> 30) & 1U) != 0U;
    const bool s_bit = ((w >> 29) & 1U) != 0U;
    const uint32_t shift = (w >> 22) & 1U;
    const uint32_t imm12 = (w >> 10) & 0xfffU;
    const uint8_t rn = reg_rn(w);
    const uint8_t rd = reg_rd(w);
    if (s_bit && rd == 31U) {
      mn.append(is_sub ? "cmp" : "cmn");
      ops.append_gp_reg(rn, sf, true);
      ops.append(", ");
      ops.append_imm_hex(imm12);
      if (shift != 0U) ops.append(", lsl #12");
      return;
    }
    if (!is_sub && !s_bit && imm12 == 0U && shift == 0U && (rd == 31U || rn == 31U)) {
      mn.append("mov");
      ops.append_gp_reg(rd, sf, true);
      ops.append(", ");
      ops.append_gp_reg(rn, sf, true);
      return;
    }
    mn.append(is_sub ? (s_bit ? "subs" : "sub") : (s_bit ? "adds" : "add"));
    ops.append_gp_reg(rd, sf, !s_bit);
    ops.append(", ");
    ops.append_gp_reg(rn, sf, true);
    ops.append(", ");
    ops.append_imm_hex(imm12);
    if (shift != 0U) ops.append(", lsl #12");
    return;
  }

  // ADD/SUB shifted register
  if (is_add_sub_shifted(w)) {
    const bool sf = ((w >> 31) & 1U) != 0U;
    const bool is_sub = ((w >> 30) & 1U) != 0U;
    const bool s_bit = ((w >> 29) & 1U) != 0U;
    const uint32_t sh = (w >> 22) & 3U;
    const uint32_t imm6 = (w >> 10) & 0x3fU;
    const uint8_t rd = reg_rd(w);
    const uint8_t rn = reg_rn(w);
    const uint8_t rm = reg_rm(w);
    if (s_bit && rd == 31U) {
      mn.append(is_sub ? "cmp" : "cmn");
      ops.append_gp_reg(rn, sf, false);
      ops.append(", ");
      ops.append_gp_reg(rm, sf, false);
    } else {
      mn.append(is_sub ? (s_bit ? "subs" : "sub") : (s_bit ? "adds" : "add"));
      ops.append_gp_reg(rd, sf, false);
      ops.append(", ");
      ops.append_gp_reg(rn, sf, false);
      ops.append(", ");
      ops.append_gp_reg(rm, sf, false);
    }
    if (imm6 != 0U) {
      ops.append(", ");
      ops.append(kShiftNames[sh]);
      ops.append(" #");
      ops.append_u64_dec(imm6);
    }
    return;
  }

  // ADD/SUB extended register
  if (is_add_sub_extended(w)) {
    const bool sf = ((w >> 31) & 1U) != 0U;
    const bool is_sub = ((w >> 30) & 1U) != 0U;
    const bool s_bit = ((w >> 29) & 1U) != 0U;
    const uint32_t opt = (w >> 13) & 7U;
    const uint32_t imm3 = (w >> 10) & 7U;
    const uint8_t rd = reg_rd(w);
    const uint8_t rn = reg_rn(w);
    const uint8_t rm = reg_rm(w);
    if (s_bit && rd == 31U) {
      mn.append(is_sub ? "cmp" : "cmn");
      ops.append_gp_reg(rn, sf, true);
    } else {
      mn.append(is_sub ? (s_bit ? "subs" : "sub") : (s_bit ? "adds" : "add"));
      ops.append_gp_reg(rd, sf, !s_bit);
      ops.append(", ");
      ops.append_gp_reg(rn, sf, true);
    }
    ops.append(", ");
    ops.append_gp_reg(rm, (opt & 3U) == 3U && sf, false);
    ops.append(", ");
    ops.append(kExtNames[opt]);
    if (imm3 != 0U) {
      ops.append(" #");
      ops.append_u64_dec(imm3);
    }
    return;
  }

  // Logical shifted register (including MOV alias)
  if (is_logic_shifted(w)) {
    const bool sf = ((w >> 31) & 1U) != 0U;
    const uint32_t opc = (w >> 29) & 3U;
    const uint32_t sh = (w >> 22) & 3U;
    const bool n_bit = ((w >> 21) & 1U) != 0U;
    const uint32_t imm6 = (w >> 10) & 0x3fU;
    const uint8_t rd = reg_rd(w);
    const uint8_t rn = reg_rn(w);
    const uint8_t rm = reg_rm(w);
    if (opc == 1U && !n_bit && rn == 31U && sh == 0U && imm6 == 0U) {
      mn.append("mov");
      ops.append_gp_reg(rd, sf, false);
      ops.append(", ");
      ops.append_gp_reg(rm, sf, false);
      return;
    }
    static constexpr const char* kLogicMn[4][2] = {
        {"and", "bic"}, {"orr", "orn"}, {"eor", "eon"}, {"ands", "bics"},
    };
    if (opc == 3U && !n_bit && rd == 31U) {
      mn.append("tst");
      ops.append_gp_reg(rn, sf, false);
      ops.append(", ");
      ops.append_gp_reg(rm, sf, false);
    } else {
      mn.append(kLogicMn[opc][n_bit ? 1 : 0]);
      ops.append_gp_reg(rd, sf, false);
      ops.append(", ");
      ops.append_gp_reg(rn, sf, false);
      ops.append(", ");
      ops.append_gp_reg(rm, sf, false);
    }
    if (imm6 != 0U) {
      ops.append(", ");
      ops.append(kShiftNames[sh]);
      ops.append(" #");
      ops.append_u64_dec(imm6);
    }
    return;
  }

  // Multiply / MADD / MSUB
  if (is_dp3(w) && ((w >> 21) & 7U) == 0U) {
    const bool sf = ((w >> 31) & 1U) != 0U;
    const bool o0 = ((w >> 15) & 1U) != 0U;
    const uint8_t ra = static_cast<uint8_t>((w >> 10) & 0x1fU);
    if (!o0 && ra == 31U) {
      mn.append("mul");
      ops.append_gp_reg(reg_rd(w), sf, false);
      ops.append(", ");
      ops.append_gp_reg(reg_rn(w), sf, false);
      ops.append(", ");
      ops.append_gp_reg(reg_rm(w), sf, false);
      return;
    }
    mn.append(o0 ? "msub" : "madd");
    ops.append_gp_reg(reg_rd(w), sf, false);
    ops.append(", ");
    ops.append_gp_reg(reg_rn(w), sf, false);
    ops.append(", ");
    ops.append_gp_reg(reg_rm(w), sf, false);
    ops.append(", ");
    ops.append_gp_reg(ra, sf, false);
    return;
  }

  // Memory load/store (pair & scalar/SIMD immediate)
  if (d.has_memory && !d.memory.atomic) {
    const HexArm64MemAccess& m = d.memory;
    if (m.pair) {
      if (m.tag) {
        mn.append("stgp");
      } else if (m.signed_ext) {
        mn.append("ldpsw");
      } else {
        mn.append(m.load ? "ldp" : "stp");
      }
      if (m.vector) {
        ops.append_fp_reg(m.reg, m.element_size);
        ops.append(", ");
        ops.append_fp_reg(m.reg2, m.element_size);
      } else {
        const bool is64 = m.element_size == 8U || m.signed_ext != 0U;
        ops.append_gp_reg(m.reg, is64, false);
        ops.append(", ");
        ops.append_gp_reg(m.reg2, is64, false);
      }
      ops.append(", ");
      format_mem_bracket(ops, m.base, m.mode, m.has_disp != 0U, m.disp);
      return;
    }
    if (!m.prefetch && !m.indexed) {
      const bool unscaled = masked(w, 0x3b200000U) == 0x38000000U && m.mode == HEX_ARM64_MEM_MODE_OFFSET;
      const uint32_t opc = (w >> 22) & 3U;
      if (m.vector) {
        mn.append(unscaled ? (m.load ? "ldur" : "stur") : (m.load ? "ldr" : "str"));
        ops.append_fp_reg(m.reg, m.size);
      } else {
        const bool is_signed_load = m.load && (opc == 2U || opc == 3U);
        if (m.size == 1U) {
          mn.append(unscaled ? (m.load ? (is_signed_load ? "ldursb" : "ldurb") : "sturb")
                             : (m.load ? (is_signed_load ? "ldrsb" : "ldrb") : "strb"));
        } else if (m.size == 2U) {
          mn.append(unscaled ? (m.load ? (is_signed_load ? "ldursh" : "ldurh") : "sturh")
                             : (m.load ? (is_signed_load ? "ldrsh" : "ldrh") : "strh"));
        } else if (m.size == 4U && is_signed_load) {
          mn.append(unscaled ? "ldursw" : "ldrsw");
        } else {
          mn.append(unscaled ? (m.load ? "ldur" : "stur") : (m.load ? "ldr" : "str"));
        }
        const bool reg64 = (m.size == 8U) || (is_signed_load && opc == 2U);
        ops.append_gp_reg(m.reg, reg64, false);
      }
      ops.append(", ");
      format_mem_bracket(ops, m.base, m.mode, m.has_disp != 0U, m.disp);
      return;
    }
  }

  // Unformatted valid instruction: leave mn/ops empty rather than misreporting as "udf".
}

}  // namespace

extern "C" {

uint8_t hex_arm64_kind_capability(uint8_t kind) {
  return kind < 27U ? kKindCapTable[kind] : static_cast<uint8_t>(HEX_ARM64_CAP_FALLBACK);
}

int32_t hex_arm64_is_decompiler_supported(uint32_t w) {
  const uint8_t kind = hex_arm64_classify_word(w);
  if (hex_arm64_kind_capability(kind) != HEX_ARM64_CAP_DECOMP) return 0;

  if (kind == HEX_ARM64_KIND_RET) {
    // Only canonical `ret` (ret x30 == 0xd65f03c0); exclude `ret xN` (N!=30) and PAC RETAA/RETAB.
    return w == 0xd65f03c0U ? 1 : 0;
  }
  if (kind == HEX_ARM64_KIND_ARITH) {
    // Only unshifted register ADD/SUB/ADDS/SUBS with GPR x0..x30 / w0..w30
    if (is_add_sub_imm(w) || is_add_sub_extended(w)) return 0;
    if (((w >> 10) & 0x3fU) != 0U) return 0;
    return (reg_rd(w) < 31U && reg_rn(w) < 31U && reg_rm(w) < 31U) ? 1 : 0;
  }
  if (kind == HEX_ARM64_KIND_MUL) {
    // Strict 2-operand MUL (MADD with op31==0, o0==0, Ra==xzr/wzr (31)); exclude MSUB/MNEG/SMULL/UMULL
    const uint32_t op31 = (w >> 21) & 7U;
    const uint32_t o0 = (w >> 15) & 1U;
    const uint32_t ra = (w >> 10) & 0x1fU;
    return (op31 == 0U && o0 == 0U && ra == 31U &&
            reg_rd(w) < 31U && reg_rn(w) < 31U && reg_rm(w) < 31U)
               ? 1
               : 0;
  }
  if (kind == HEX_ARM64_KIND_MOVREG) {
    // Only ORR register move (group 5), excluding XZR/WZR and SP moves
    const uint32_t group = (w >> 25) & 0xfU;
    return (group == 5U && reg_rd(w) < 31U && reg_rm(w) < 31U) ? 1 : 0;
  }
  if (kind == HEX_ARM64_KIND_MOVIMM) {
    // Strict move-wide MOVZ (opc==2) and MOVN (opc==0); exclude MOVK, ORR (imm), FMOV (imm)
    const uint32_t op_group = (w >> 23) & 0x3fU;
    const uint32_t opc = (w >> 29) & 3U;
    return (op_group == 0x25U && (opc == 0U || opc == 2U) && reg_rd(w) < 31U) ? 1 : 0;
  }
  return 0;
}

const char* hex_arm64_kind_name(uint8_t kind) {
  static constexpr const char* kKindNames[27] = {
      "OTHER", "NOP", "ADRP", "MOVIMM", "MOVREG", "ARITH", "MUL", "DIV", "LOGIC",
      "SHIFT", "FARITH", "FMUL", "FCONV", "SIMD", "LOAD", "STORE", "CMP", "CONDBR",
      "BRANCH", "CALL", "INDCALL", "RET", "CSEL", "ATOMIC", "SYS", "TRAP", "LITERAL",
  };
  return kind < 27U ? kKindNames[kind] : "OTHER";
}

const char* hex_arm64_atomic_op_name(uint8_t atomic_op) {
  static constexpr const char* kAtomicOpNames[18] = {
      "",
      "cas",
      "casp",
      "exclusive-load",
      "exclusive-store",
      "exclusive-load-pair",
      "exclusive-store-pair",
      "acquire-load",
      "release-store",
      "ldadd",
      "ldclr",
      "ldeor",
      "ldset",
      "ldsmax",
      "ldsmin",
      "ldumax",
      "ldumin",
      "swp",
  };
  return atomic_op < 18U ? kAtomicOpNames[atomic_op] : "";
}

const char* hex_arm64_ordering_name(uint8_t ordering) {
  static constexpr const char* kOrderNames[4] = {
      "relaxed", "acquire", "release", "acq_rel",
  };
  return ordering < 4U ? kOrderNames[ordering] : "relaxed";
}

const char* hex_arm64_mem_mode_name(uint8_t mode) {
  static constexpr const char* kModeNames[4] = {
      "", "offset", "post", "pre",
  };
  return mode < 4U ? kModeNames[mode] : "";
}

int32_t hex_arm64_branch_imm26(uint32_t w, uint64_t pc, uint64_t* out_target) {
  if (!out_target) return 0;
  if (masked(w, 0x7c000000U) != 0x14000000U) return 0;
  const int64_t delta = sign_extend(w & 0x03ffffffU, 26) * 4LL;
  *out_target = add_signed_u64(pc, delta);
  return 1;
}

int32_t hex_arm64_cond_branch_target(uint32_t w, uint64_t pc, uint64_t* out_target) {
  if (!out_target) return 0;
  if (masked(w, 0xff000010U) == 0x54000000U || masked(w, 0x7e000000U) == 0x34000000U) {
    const int64_t delta = sign_extend((w >> 5) & 0x7ffffU, 19) * 4LL;
    *out_target = add_signed_u64(pc, delta);
    return 1;
  }
  if (masked(w, 0x7e000000U) == 0x36000000U) {
    const int64_t delta = sign_extend((w >> 5) & 0x3fffU, 14) * 4LL;
    *out_target = add_signed_u64(pc, delta);
    return 1;
  }
  return 0;
}

int32_t hex_arm64_literal_target(uint32_t w, uint64_t pc, uint64_t* out_target) {
  if (!out_target) return 0;
  if (masked(w, 0x3b000000U) != 0x18000000U) return 0;
  const int64_t delta = sign_extend((w >> 5) & 0x7ffffU, 19) * 4LL;
  *out_target = add_signed_u64(pc, delta);
  return 1;
}

int32_t hex_arm64_word_target(uint32_t w, uint64_t pc, uint64_t* out_target) {
  if (hex_arm64_branch_imm26(w, pc, out_target)) return 1;
  if (hex_arm64_cond_branch_target(w, pc, out_target)) return 1;
  return hex_arm64_literal_target(w, pc, out_target);
}

int32_t hex_arm64_pc_rel_target(uint32_t w, uint64_t pc, HexArm64PcRel* out) {
  if (!out) return 0;
  hex::mem_set(out, 0, sizeof(*out));
  if (masked(w, 0x1f000000U) != 0x10000000U) return 0;
  const uint32_t raw_imm = (((w >> 5) & 0x7ffffU) << 2) | ((w >> 29) & 3U);
  const int64_t imm = sign_extend(raw_imm, 21);
  out->valid = 1U;
  out->reg = reg_rd(w);
  if ((w & 0x80000000U) != 0U) {
    out->page = 1U;
    out->value = (pc & ~0xfffULL) + (static_cast<uint64_t>(imm) << 12);
  } else {
    out->page = 0U;
    out->value = add_signed_u64(pc, imm);
  }
  return 1;
}

int32_t hex_arm64_paired_offset(uint32_t w, HexArm64PairedOffset* out) {
  if (!out) return 0;
  hex::mem_set(out, 0, sizeof(*out));
  // ADD (immediate, 64-bit) with optional LSL #12 (#3936)
  if (((w >> 23) & 0x1ffU) == 0x122U) {
    const uint32_t shift = (w >> 22) & 1U;
    out->valid = 1U;
    out->rn = reg_rn(w);
    out->rd = reg_rd(w);
    out->imm = static_cast<uint64_t>((w >> 10) & 0xfffU) << (shift ? 12U : 0U);
    out->load = 0U;
    out->store = 0U;
    out->prefetch = 0U;
    out->gp_dest = 0U;
    return 1;
  }
  // LDR/STR (immediate, unsigned offset)
  if (masked(w, 0x3b000000U) == 0x39000000U) {
    const uint32_t scale = transfer_scale(w);
    const bool is_load = transfer_is_load(w);
    const bool prefetch = is_prefetch_immediate(w);
    out->valid = 1U;
    out->rn = reg_rn(w);
    out->rd = reg_rd(w);
    out->imm = static_cast<uint64_t>((w >> 10) & 0xfffU) << scale;
    out->load = is_load ? 1U : 0U;
    out->store = (!is_load && !prefetch) ? 1U : 0U;
    out->prefetch = prefetch ? 1U : 0U;
    out->gp_dest = (!prefetch && (((w >> 26) & 1U) == 0U)) ? 1U : 0U;
    return 1;
  }
  return 0;
}

int32_t hex_arm64_memory_access(uint32_t w, HexArm64MemAccess* out) {
  if (!out) return 0;
  hex::mem_set(out, 0, sizeof(*out));
  const uint32_t atomic_class = masked(w, 0x3f000000U);

  // Exclusive / acquire-release / CAS / CASP
  if (atomic_class == 0x08000000U) {
    const uint32_t size_code = (w >> 30) & 3U;
    const bool bit23 = ((w >> 23) & 1U) == 1U;
    const bool acquire_bit = ((w >> 22) & 1U) == 1U;
    const bool pair_bit = ((w >> 21) & 1U) == 1U;
    const uint8_t rs = static_cast<uint8_t>((w >> 16) & 0x1fU);
    const bool release_bit = ((w >> 15) & 1U) == 1U;
    const uint8_t encoded_rt2 = static_cast<uint8_t>((w >> 10) & 0x1fU);
    const uint8_t rt = reg_rd(w);
    const uint8_t base = reg_rn(w);

    const bool cas_pair = !bit23 && pair_bit && encoded_rt2 == 31U && size_code <= 1U;
    const bool cas_single = bit23 && pair_bit && encoded_rt2 == 31U;
    if (cas_single || cas_pair) {
      const uint8_t elem_size = cas_pair ? (size_code == 0U ? 4U : 8U)
                                         : static_cast<uint8_t>(1U << size_code);
      out->valid = 1U;
      out->load = 1U;
      out->store = 1U;
      out->rmw = 1U;
      out->atomic = 1U;
      out->atomic_op = cas_pair ? HEX_ARM64_ATOMIC_CASP : HEX_ARM64_ATOMIC_CAS;
      out->element_size = elem_size;
      out->size = cas_pair ? static_cast<uint8_t>(elem_size * 2U) : elem_size;
      out->pair = cas_pair ? 1U : 0U;
      out->base = base;
      out->reg = rs;
      out->compare_reg = rs;
      out->value_reg = rt;
      out->result_reg = rs;
      out->has_disp = 1U;
      out->disp = 0;
      out->ordering = make_ordering(acquire_bit, release_bit);
      out->acquire = acquire_bit ? 1U : 0U;
      out->release = release_bit ? 1U : 0U;
      if (cas_pair) {
        out->has_reg2 = 1U;
        out->reg2 = static_cast<uint8_t>((rs + 1U) & 31U);
        out->compare_reg2 = out->reg2;
        out->result_reg2 = out->reg2;
        out->value_reg2 = static_cast<uint8_t>((rt + 1U) & 31U);
      }
      return 1;
    }

    const bool load = acquire_bit;
    const bool exclusive = !bit23;
    const bool pair = exclusive && pair_bit;
    const uint8_t elem_size = static_cast<uint8_t>(1U << size_code);
    out->valid = 1U;
    out->load = load ? 1U : 0U;
    out->store = load ? 0U : 1U;
    out->element_size = elem_size;
    out->size = pair ? static_cast<uint8_t>(elem_size * 2U) : elem_size;
    out->pair = pair ? 1U : 0U;
    out->base = base;
    out->reg = rt;
    out->has_disp = 1U;
    out->disp = 0;
    out->atomic = 1U;
    if (exclusive) {
      if (pair) {
        out->atomic_op = load ? HEX_ARM64_ATOMIC_EXCL_LOAD_PAIR : HEX_ARM64_ATOMIC_EXCL_STORE_PAIR;
      } else {
        out->atomic_op = load ? HEX_ARM64_ATOMIC_EXCL_LOAD : HEX_ARM64_ATOMIC_EXCL_STORE;
      }
      out->ordering = make_ordering(load && release_bit, !load && release_bit);
    } else {
      out->atomic_op = load ? HEX_ARM64_ATOMIC_ACQ_LOAD : HEX_ARM64_ATOMIC_REL_STORE;
      out->ordering = load ? HEX_ARM64_ORDER_ACQUIRE : HEX_ARM64_ORDER_RELEASE;
    }
    if (pair) {
      out->has_reg2 = 1U;
      out->reg2 = encoded_rt2;
    }
    if (exclusive && !load) {
      out->has_status_reg = 1U;
      out->status_reg = rs;
    }
    return 1;
  }

  // LSE atomic memory operations
  if (atomic_class == 0x38000000U && ((w >> 21) & 1U) == 1U && ((w >> 10) & 3U) == 0U) {
    const uint32_t op_code = (w >> 12) & 0xfU;
    if (op_code < 9U) {
      const uint8_t size = static_cast<uint8_t>(1U << ((w >> 30) & 3U));
      const bool acquire = ((w >> 23) & 1U) == 1U;
      const bool release = ((w >> 22) & 1U) == 1U;
      const uint8_t source_reg = static_cast<uint8_t>((w >> 16) & 0x1fU);
      const uint8_t result_reg = reg_rd(w);
      out->valid = 1U;
      out->load = 1U;
      out->store = 1U;
      out->rmw = 1U;
      out->atomic = 1U;
      out->atomic_op = static_cast<uint8_t>(HEX_ARM64_ATOMIC_LDADD + op_code);
      out->size = size;
      out->element_size = size;
      out->base = reg_rn(w);
      out->reg = result_reg;
      out->source_reg = source_reg;
      out->value_reg = source_reg;
      out->result_reg = result_reg;
      out->has_disp = 1U;
      out->disp = 0;
      out->ordering = make_ordering(acquire, release);
      out->acquire = acquire ? 1U : 0U;
      out->release = release ? 1U : 0U;
      return 1;
    }
  }

  // Pair (ldp / stp / ldnp / stnp / ldpsw / stgp)
  if (masked(w, 0x3a000000U) == 0x28000000U) {
    const bool load = ((w >> 22) & 1U) == 1U;
    const uint32_t opc = (w >> 30) & 3U;
    const bool vector = ((w >> 26) & 1U) == 1U;
    const uint32_t index = (w >> 23) & 3U;
    const uint8_t mode = index == 1U ? HEX_ARM64_MEM_MODE_POST
                       : index == 3U ? HEX_ARM64_MEM_MODE_PRE
                                     : HEX_ARM64_MEM_MODE_OFFSET;
    if (opc == 3U) return 0;
    const int64_t imm7 = sign_extend((w >> 15) & 0x7fU, 7);
    if (opc == 1U && !vector && !load) {
      // FEAT_MTE STGP (#3975)
      out->valid = 1U;
      out->load = 0U;
      out->store = 1U;
      out->size = 16U;
      out->element_size = 8U;
      out->pair = 1U;
      out->vector = 0U;
      out->signed_ext = 0U;
      out->sign_extend_to = 0U;
      out->tag = 1U;
      out->base = reg_rn(w);
      out->reg = reg_rd(w);
      out->has_reg2 = 1U;
      out->reg2 = static_cast<uint8_t>((w >> 10) & 0x1fU);
      out->has_disp = 1U;
      out->disp = imm7 * 16LL;
      out->mode = mode;
      return 1;
    }
    const bool signed_word_pair = !vector && load && opc == 1U;
    const uint8_t elem_size = vector ? static_cast<uint8_t>(4U << opc) : (opc == 2U ? 8U : 4U);
    out->valid = 1U;
    out->load = load ? 1U : 0U;
    out->store = load ? 0U : 1U;
    out->size = static_cast<uint8_t>(elem_size * 2U);
    out->element_size = elem_size;
    out->pair = 1U;
    out->vector = vector ? 1U : 0U;
    out->signed_ext = signed_word_pair ? 1U : 0U;
    out->sign_extend_to = signed_word_pair ? 8U : 0U;
    out->base = reg_rn(w);
    out->reg = reg_rd(w);
    out->has_reg2 = 1U;
    out->reg2 = static_cast<uint8_t>((w >> 10) & 0x1fU);
    out->has_disp = 1U;
    out->disp = imm7 * static_cast<int64_t>(elem_size);
    out->mode = mode;
    return 1;
  }

  // Unsigned immediate
  if (masked(w, 0x3b000000U) == 0x39000000U) {
    const uint32_t scale = transfer_scale(w);
    const bool prefetch = is_prefetch_immediate(w);
    const bool load = !prefetch && transfer_is_load(w);
    const bool vector = ((w >> 26) & 1U) == 1U;
    out->valid = 1U;
    out->load = load ? 1U : 0U;
    out->store = (!load && !prefetch) ? 1U : 0U;
    out->size = static_cast<uint8_t>(1U << scale);
    out->element_size = out->size;
    out->vector = vector ? 1U : 0U;
    out->prefetch = prefetch ? 1U : 0U;
    out->gp_dest = (!prefetch && !vector) ? 1U : 0U;
    out->base = reg_rn(w);
    out->reg = reg_rd(w);
    out->has_disp = 1U;
    out->disp = static_cast<int64_t>(static_cast<uint64_t>((w >> 10) & 0xfffU) << scale);
    out->mode = HEX_ARM64_MEM_MODE_OFFSET;
    return 1;
  }

  // Pre / post / unscaled immediate
  if (masked(w, 0x3b200000U) == 0x38000000U) {
    const bool load = transfer_is_load(w);
    const uint32_t kind = (w >> 10) & 3U;
    const int64_t imm9 = sign_extend((w >> 12) & 0x1ffU, 9);
    out->valid = 1U;
    out->load = load ? 1U : 0U;
    out->store = load ? 0U : 1U;
    out->size = static_cast<uint8_t>(1U << transfer_scale(w));
    out->element_size = out->size;
    out->vector = (((w >> 26) & 1U) == 1U) ? 1U : 0U;
    out->base = reg_rn(w);
    out->reg = reg_rd(w);
    out->has_disp = 1U;
    out->disp = imm9;
    out->mode = kind == 1U ? HEX_ARM64_MEM_MODE_POST
              : kind == 3U ? HEX_ARM64_MEM_MODE_PRE
                           : HEX_ARM64_MEM_MODE_OFFSET;
    return 1;
  }

  // Register-indexed
  if (masked(w, 0x3b200c00U) == 0x38200800U) {
    const bool load = transfer_is_load(w);
    out->valid = 1U;
    out->load = load ? 1U : 0U;
    out->store = load ? 0U : 1U;
    out->size = static_cast<uint8_t>(1U << transfer_scale(w));
    out->element_size = out->size;
    out->vector = (((w >> 26) & 1U) == 1U) ? 1U : 0U;
    out->base = reg_rn(w);
    out->reg = reg_rd(w);
    out->has_disp = 0U;
    out->disp = 0;
    out->indexed = 1U;
    return 1;
  }

  return 0;
}

int32_t hex_arm64_compare_immediate(uint32_t w, int64_t* out_imm) {
  if (!out_imm) return 0;
  if (!is_add_sub_imm(w) || ((w >> 29) & 1U) != 1U || reg_rd(w) != 31U) return 0;
  const uint32_t shift = ((w >> 22) & 1U) ? 12U : 0U;
  const int64_t imm = static_cast<int64_t>(static_cast<uint64_t>((w >> 10) & 0xfffU) << shift);
  const bool is_sub = ((w >> 30) & 1U) == 1U;
  *out_imm = is_sub ? imm : (imm == 0 ? 0 : -imm);
  return 1;
}

uint8_t hex_arm64_classify_word(uint32_t w) {
  if (w == 0U) return HEX_ARM64_KIND_OTHER;
  switch ((w >> 25) & 0xfU) {
    case 0:
      return masked(w, 0xffff0000U) == 0x00000000U ? HEX_ARM64_KIND_TRAP : HEX_ARM64_KIND_OTHER;
    case 4:
      return classify_memory_kind(w);
    case 5:
      if (is_add_sub_shifted(w) || is_add_sub_extended(w)) {
        if (((w >> 29) & 1U) == 1U && reg_rd(w) == 31U) return HEX_ARM64_KIND_CMP;
        return HEX_ARM64_KIND_ARITH;
      }
      if (is_logic_shifted(w)) {
        const uint32_t opc = (w >> 29) & 3U;
        if (opc == 3U && reg_rd(w) == 31U) return HEX_ARM64_KIND_CMP;
        if (opc == 1U && reg_rn(w) == 31U && ((w >> 21) & 1U) == 0U &&
            ((w >> 22) & 3U) == 0U && ((w >> 10) & 0x3fU) == 0U) {
          return HEX_ARM64_KIND_MOVREG;
        }
        return HEX_ARM64_KIND_LOGIC;
      }
      return HEX_ARM64_KIND_OTHER;
    case 6: {
      const uint8_t mem_kind = classify_memory_kind(w);
      if (mem_kind != HEX_ARM64_KIND_OTHER) return mem_kind;
      return is_simd(w) ? HEX_ARM64_KIND_SIMD : HEX_ARM64_KIND_OTHER;
    }
    case 7:
      return is_simd(w) ? HEX_ARM64_KIND_SIMD : HEX_ARM64_KIND_OTHER;
    case 8:
      if (masked(w, 0x1f000000U) == 0x10000000U) return HEX_ARM64_KIND_ADRP;
      if (is_add_sub_imm(w)) {
        const uint32_t s_bit = (w >> 29) & 1U;
        if (s_bit == 1U && reg_rd(w) == 31U) return HEX_ARM64_KIND_CMP;
        if (((w >> 10) & 0xfffU) == 0U && s_bit == 0U &&
            (reg_rn(w) == 31U || reg_rd(w) == 31U)) {
          return HEX_ARM64_KIND_MOVREG;
        }
        return HEX_ARM64_KIND_ARITH;
      }
      return HEX_ARM64_KIND_OTHER;
    case 9:
      if (is_logic_imm(w)) {
        const uint32_t opc = (w >> 29) & 3U;
        if (opc == 3U && reg_rd(w) == 31U) return HEX_ARM64_KIND_CMP;
        if (opc == 1U && reg_rn(w) == 31U) return HEX_ARM64_KIND_MOVIMM;
        return HEX_ARM64_KIND_LOGIC;
      }
      if (is_move_wide(w)) return HEX_ARM64_KIND_MOVIMM;
      if (is_bitfield(w)) return HEX_ARM64_KIND_SHIFT;
      return HEX_ARM64_KIND_OTHER;
    case 10:
      if (is_nop(w)) return HEX_ARM64_KIND_NOP;
      if (masked(w, 0xffe0001fU) == 0xd4200000U) return HEX_ARM64_KIND_TRAP;
      if (is_call_imm(w)) return HEX_ARM64_KIND_CALL;
      if (is_branch_imm(w)) return HEX_ARM64_KIND_BRANCH;
      if (masked(w, 0xff000010U) == 0x54000000U || masked(w, 0x7e000000U) == 0x34000000U) {
        return HEX_ARM64_KIND_CONDBR;
      }
      if (is_system(w)) return HEX_ARM64_KIND_SYS;
      return HEX_ARM64_KIND_OTHER;
    case 11:
      if (is_call_imm(w)) return HEX_ARM64_KIND_CALL;
      if (is_indirect_call(w)) return HEX_ARM64_KIND_INDCALL;
      if (is_ret(w)) return HEX_ARM64_KIND_RET;
      if (is_branch_imm(w) || is_br(w)) return HEX_ARM64_KIND_BRANCH;
      if (masked(w, 0x7e000000U) == 0x36000000U) return HEX_ARM64_KIND_CONDBR;
      return HEX_ARM64_KIND_OTHER;
    case 12:
    case 14:
      if (masked(w, 0x3b000000U) == 0x18000000U) {
        return is_prefetch_literal(w) ? HEX_ARM64_KIND_OTHER : HEX_ARM64_KIND_LITERAL;
      }
      return classify_memory_kind(w);
    case 13:
      if (is_cond_compare(w)) return HEX_ARM64_KIND_CMP;
      if (is_multiply(w)) return HEX_ARM64_KIND_MUL;
      if (is_divide(w)) return HEX_ARM64_KIND_DIV;
      if (is_cond_select(w)) return HEX_ARM64_KIND_CSEL;
      if (is_shift_op(w) || is_integer_one_source_bit_op(w)) return HEX_ARM64_KIND_SHIFT;
      return HEX_ARM64_KIND_OTHER;
    case 15:
      if (is_fp_compare(w)) return HEX_ARM64_KIND_CMP;
      if (is_fp_mul_div(w)) return HEX_ARM64_KIND_FMUL;
      if (is_fp_add_sub(w)) return HEX_ARM64_KIND_FARITH;
      if (is_fp_to_int(w) || is_fp_fixed_convert(w) || is_simd_scalar_int_float_convert(w)) {
        return HEX_ARM64_KIND_FCONV;
      }
      if (is_fp_dp1(w)) {
        const uint32_t op = (w >> 15) & 0x3fU;
        if (op == 1U || op == 2U || op == 3U) return HEX_ARM64_KIND_FARITH;
        return HEX_ARM64_KIND_FCONV;
      }
      if (is_fp_imm(w)) return HEX_ARM64_KIND_MOVIMM;
      if (is_fp_cond_select(w)) return HEX_ARM64_KIND_CSEL;
      return HEX_ARM64_KIND_OTHER;
    default:
      return HEX_ARM64_KIND_OTHER;
  }
}

uint8_t hex_arm64_is_stp_to_sp(uint32_t w) {
  return (((w >> 30) & 3U) == 2U &&
          ((w >> 27) & 7U) == 5U &&
          ((w >> 26) & 1U) == 0U &&
          ((w >> 25) & 1U) == 0U &&
          ((w >> 22) & 1U) == 0U &&
          reg_rn(w) == 31U)
             ? 1U
             : 0U;
}

uint8_t hex_arm64_is_sub_sp(uint32_t w) {
  return (((w >> 23) & 0x1ffU) == 0x1a2U && reg_rn(w) == 31U && reg_rd(w) == 31U) ? 1U : 0U;
}

uint8_t hex_arm64_looks_like_prologue(uint32_t w) {
  return (hex_arm64_is_stp_to_sp(w) != 0U ||
          hex_arm64_is_sub_sp(w) != 0U ||
          masked(w, 0xffffff1fU) == 0xd503241fU ||
          w == 0xd503233fU ||
          w == 0xd503237fU)
             ? 1U
             : 0U;
}

uint8_t hex_arm64_looks_like_end(uint32_t w) {
  return (is_ret(w) || masked(w, 0xfc000000U) == 0x14000000U) ? 1U : 0U;
}

HexStatus hex_arm64_decode_word(uint32_t w, uint64_t pc, HexArm64Decoded* out) {
  if (!out) return HEX_ERR_INVALID_ARG;
  hex::mem_set(out, 0, sizeof(*out));
  const uint8_t kind = hex_arm64_classify_word(w);
  out->word = w;
  out->pc = pc;
  out->kind = kind;
  out->cap = hex_arm64_is_decompiler_supported(w) ? HEX_ARM64_CAP_DECOMP : HEX_ARM64_CAP_FALLBACK;
  out->rd = reg_rd(w);
  out->rn = reg_rn(w);
  out->rm = reg_rm(w);
  out->is_stp_to_sp = hex_arm64_is_stp_to_sp(w);
  out->is_sub_sp = hex_arm64_is_sub_sp(w);
  out->is_prologue = hex_arm64_looks_like_prologue(w);
  out->is_end = hex_arm64_looks_like_end(w);

  if (kind == HEX_ARM64_KIND_CALL || kind == HEX_ARM64_KIND_BRANCH) {
    if (hex_arm64_branch_imm26(w, pc, &out->target)) out->has_target = 1U;
  } else if (kind == HEX_ARM64_KIND_CONDBR) {
    if (hex_arm64_cond_branch_target(w, pc, &out->target)) out->has_target = 1U;
  } else if (kind == HEX_ARM64_KIND_LITERAL) {
    if (hex_arm64_literal_target(w, pc, &out->target)) out->has_target = 1U;
  }

  if (kind == HEX_ARM64_KIND_ADRP) {
    if (hex_arm64_pc_rel_target(w, pc, &out->pc_rel)) out->has_pc_rel = 1U;
  }

  if (kind == HEX_ARM64_KIND_LOAD || kind == HEX_ARM64_KIND_STORE || kind == HEX_ARM64_KIND_ATOMIC) {
    if (hex_arm64_memory_access(w, &out->memory)) out->has_memory = 1U;
  }

  if (kind == HEX_ARM64_KIND_CMP) {
    if (hex_arm64_compare_immediate(w, &out->compare_with)) out->has_compare_with = 1U;
  }

  if (hex_arm64_paired_offset(w, &out->paired_offset)) {
    out->has_paired_offset = 1U;
  }

  format_instruction_text(*out, out->mn, out->ops);
  return HEX_OK;
}

HexStatus hex_arm64_decode_batch(
    const uint32_t* words,
    uint32_t count,
    uint64_t base_pc,
    HexArm64Decoded* out) {
  if (count == 0U) return HEX_OK;
  if (!words || !out) return HEX_ERR_INVALID_ARG;
  for (uint32_t i = 0U; i < count; ++i) {
    const uint64_t pc = base_pc + (static_cast<uint64_t>(i) * 4ULL);
    const HexStatus st = hex_arm64_decode_word(words[i], pc, &out[i]);
    if (st != HEX_OK) return st;
  }
  return HEX_OK;
}

HexStatus hex_arm64_decode_batch_pcs(
    const uint32_t* words,
    const uint64_t* pcs,
    uint32_t count,
    HexArm64Decoded* out) {
  if (count == 0U) return HEX_OK;
  if (!words || !pcs || !out) return HEX_ERR_INVALID_ARG;
  for (uint32_t i = 0U; i < count; ++i) {
    const HexStatus st = hex_arm64_decode_word(words[i], pcs[i], &out[i]);
    if (st != HEX_OK) return st;
  }
  return HEX_OK;
}

HexStatus hex_arm64_classify_batch(
    const uint32_t* words,
    uint32_t count,
    uint8_t* out_kinds) {
  if (count == 0U) return HEX_OK;
  if (!words || !out_kinds) return HEX_ERR_INVALID_ARG;
  for (uint32_t i = 0U; i < count; ++i) {
    out_kinds[i] = hex_arm64_classify_word(words[i]);
  }
  return HEX_OK;
}

}  // extern "C"
