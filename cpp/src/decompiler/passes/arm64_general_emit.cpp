#include "decompiler/passes/arm64_general_emit.hpp"

namespace hex::decompiler::passes {

static hex::Arena* g_general_scratch_arena = nullptr;
void set_general_scratch_arena(hex::Arena* scratch) {
  g_general_scratch_arena = scratch;
}

namespace {

static constexpr uint32_t kMinGeneralWords = 1u;
static constexpr uint32_t kMaxGeneralWords = 8192u;
static constexpr uint32_t kMaxNormNameLen = 512u;
static constexpr uint32_t kMaxGlobals = 2048u;
static constexpr uint32_t kMaxCallees = 2048u;
static constexpr uint32_t kMaxTextCap = 131072u;
static constexpr uint32_t kMaxLineMapCap = 8192u;

static inline bool is_ascii_alpha(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

static inline bool is_ascii_digit(char c) {
  return c >= '0' && c <= '9';
}

static inline bool is_ident_char(char c) {
  return is_ascii_alpha(c) || is_ascii_digit(c) || c == '_';
}

static inline int64_t sign_extend(uint64_t v, uint32_t bits) {
  const uint64_t mask = (bits >= 64u) ? ~0ULL : ((1ULL << bits) - 1ULL);
  const uint64_t sign = 1ULL << (bits - 1u);
  const uint64_t masked = v & mask;
  return static_cast<int64_t>((masked ^ sign) - sign);
}

// ARM64 DecodeBitMasks(N, imms, immr) for logical immediate instructions.
static bool decode_bitmask_imm(uint32_t N, uint32_t imms, uint32_t immr, bool is64, uint64_t* out_val) {
  if (!is64 && N != 0u) return false;
  const uint32_t combined = ((N & 1u) << 6u) | ((~imms) & 0x3Fu);
  if (combined == 0u) return false;
  uint32_t len = 0u;
  for (uint32_t b = 6u; b > 0u; --b) {
    if ((combined & (1u << b)) != 0u) {
      len = b;
      break;
    }
  }
  if (len == 0u) return false;
  const uint32_t levels = (1u << len) - 1u;
  const uint32_t S = imms & levels;
  if (S == levels) return false;
  const uint32_t R = immr & levels;
  const uint32_t esize = 1u << len;
  const uint32_t ones = S + 1u;
  uint64_t welem = (ones >= 64u) ? ~0ULL : ((1ULL << ones) - 1ULL);
  // Rotate right within esize bits.
  const uint32_t rot = R & (esize - 1u);
  if (rot != 0u) {
    const uint64_t emask = (esize >= 64u) ? ~0ULL : ((1ULL << esize) - 1ULL);
    welem = ((welem >> rot) | (welem << (esize - rot))) & emask;
  }
  // Replicate element across 64 bits.
  uint64_t res = welem;
  for (uint32_t shift = esize; shift < 64u; shift <<= 1u) {
    res |= (res << shift);
  }
  if (!is64) res &= 0xFFFFFFFFULL;
  *out_val = res;
  return true;
}


// ARM64 VFPExpandImm(imm8) -> double (sign:1, exp:11, frac:52)
static double decode_fmov_imm8(uint32_t imm8) {
  const uint64_t sign = static_cast<uint64_t>((imm8 >> 7u) & 1u);
  const uint64_t b6 = static_cast<uint64_t>((imm8 >> 6u) & 1u);
  const uint64_t b54 = static_cast<uint64_t>((imm8 >> 4u) & 3u);
  const uint64_t frac4 = static_cast<uint64_t>(imm8 & 0xFu);
  const uint64_t exp = ((b6 ^ 1ULL) << 10u) | (b6 ? 0x3FCULL : 0x000ULL) | b54;
  // Reconstruct without memcpy/std::bit_cast using exact power-of-2 math:
  // value = (-1)^sign * (1 + frac4/16) * 2^(exp - 1023)
  const int32_t e = static_cast<int32_t>(exp) - 1023;
  double val = 1.0 + static_cast<double>(frac4) / 16.0;
  if (e > 0) {
    for (int32_t k = 0; k < e; ++k) val *= 2.0;
  } else if (e < 0) {
    for (int32_t k = 0; k < -e; ++k) val *= 0.5;
  }
  return sign ? -val : val;
}

struct TextBuf {
  char* data;
  uint32_t cap;
  uint32_t len;
  uint32_t line_no;
  bool overflow;
  HexLineMapEntry* lm;
  uint32_t lm_cap;
  uint32_t lm_count;

  void put_char(char c) {
    if (overflow) return;
    if (len + 1u >= cap) {
      overflow = true;
      return;
    }
    data[len++] = c;
    data[len] = '\0';
    if (c == '\n') ++line_no;
  }

  void put_str(const char* s) {
    if (!s || overflow) return;
    while (*s != '\0') {
      put_char(*s++);
      if (overflow) return;
    }
  }

  void put_bytes(const char* s, uint32_t n) {
    if (!s || overflow) return;
    for (uint32_t i = 0u; i < n; ++i) {
      put_char(s[i]);
      if (overflow) return;
    }
  }

  void put_u64_hex(uint64_t val, bool upper) {
    static const char kLo[] = "0123456789abcdef";
    static const char kHi[] = "0123456789ABCDEF";
    const char* d = upper ? kHi : kLo;
    char tmp[16];
    uint32_t n = 0u;
    do {
      tmp[n++] = d[val & 0xFu];
      val >>= 4u;
    } while (val != 0u);
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_u64_dec(uint64_t val) {
    char tmp[24];
    uint32_t n = 0u;
    do {
      tmp[n++] = static_cast<char>('0' + (val % 10u));
      val /= 10u;
    } while (val != 0u);
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_imm(uint64_t val) {
    if (val >= 100ULL) {
      put_str("0x");
      put_u64_hex(val, true);
      if (val > 0xFFFFFFFFULL) put_str("ULL");
    } else {
      put_u64_dec(val);
    }
  }

  void put_fmov_imm(double v) {
    if (v < 0.0) {
      put_char('-');
      v = -v;
    }
    const uint64_t scaled = static_cast<uint64_t>(v * 1000000.0 + 0.5);
    put_u64_dec(scaled / 1000000ULL);
    put_char('.');
    uint64_t frac = scaled % 1000000ULL;
    char digits[6];
    for (int i = 5; i >= 0; --i) {
      digits[i] = static_cast<char>('0' + (frac % 10ULL));
      frac /= 10ULL;
    }
    int last = 5;
    while (last > 0 && digits[last] == '0') --last;
    for (int i = 0; i <= last; ++i) put_char(digits[i]);
  }

  void put_reg_x(uint32_t r) {
    if (r == 31u) {
      put_str("0ULL");
      return;
    }
    put_char('x');
    put_u64_dec(r);
  }

  void put_reg_x_or_sp(uint32_t r) {
    if (r == 31u) {
      put_str("sp");
      return;
    }
    put_char('x');
    put_u64_dec(r);
  }

  void put_reg_d(uint32_t r) {
    put_char('d');
    put_u64_dec(r & 31u);
  }

  void put_reg_q(uint32_t r) {
    put_char('q');
    put_u64_dec(r & 31u);
  }

  void record_line(uint64_t va) {
    if (!lm || lm_count >= lm_cap) return;
    lm[lm_count].line_no = line_no;
    lm[lm_count].block_id = 0u;
    lm[lm_count].addr = va;
    ++lm_count;
  }
};

static bool normalize_func_name(
    const char* raw,
    uint32_t raw_len,
    uint64_t base_addr,
    char* out_buf,
    uint32_t out_cap,
    uint32_t* out_len) {
  if (!raw || raw_len == 0u) {
    TextBuf tb{out_buf, out_cap, 0u, 1u, false, nullptr, 0u, 0u};
    tb.put_str("sub_");
    tb.put_u64_hex(base_addr, false);
    if (tb.overflow) return false;
    *out_len = tb.len;
    return true;
  }
  if (raw_len >= 2u && (raw[0] == '-' || raw[0] == '+') && raw[1] == '[') {
    return false;
  }
  uint32_t start = 0u;
  while (start < raw_len && raw[start] == '_') ++start;
  uint32_t rem = raw_len - start;
  if (rem == 0u || out_cap < 2u) return false;
  if (rem >= kMaxNormNameLen) rem = kMaxNormNameLen - 1u;
  if (rem + 1u > out_cap) rem = out_cap - 1u;
  for (uint32_t i = 0u; i < rem; ++i) {
    const char c = raw[start + i];
    out_buf[i] = is_ident_char(c) ? c : '_';
  }
  out_buf[rem] = '\0';
  if (is_ascii_digit(out_buf[0])) return false;
  *out_len = rem;
  return true;
}

struct GlobalEntry {
  uint64_t addr;
  bool needs_addr_of;
};

struct CmpState {
  bool valid;
  bool is32;
  bool is_fp;
  bool is_imm;
  bool is_cmn;
  bool lhs_is_sp;
  uint32_t lhs_reg;
  uint32_t rhs_reg;
  uint64_t rhs_imm;
  bool is_nzcv_var;
};

struct AnalysisCtx {
  uint32_t gpr_read_before_write;  // bits 0..30
  uint32_t gpr_written;            // bits 0..30
  uint32_t gpr_written_insn;       // per-instruction non-call write tracker
  uint32_t gpr_used;               // bits 0..30
  uint32_t fp_read_before_write;   // bits 0..31 (d0..d31)
  uint32_t fp_written;             // bits 0..31
  uint32_t fp_used;                // bits 0..31
  uint32_t q_used;                 // bits 0..31
  bool uses_sp;
  bool uses_uint8;
  bool uses_int8;
  bool uses_uint16;
  bool uses_int16;
  bool uses_uint32;
  bool uses_int32;
  bool uses_uint64_t;
  bool uses_int64_t;
  bool uses_uintptr;
  bool uses_uint128;
  uint32_t fp_single_mask;
  uint32_t fp_double_mask;
  uint32_t fp_param_single_mask;
  uint32_t fp_param_double_mask;
  bool uses_nzcv;
  bool uses_fp_bitcast;
  bool uses_math;
  bool has_unknown_call;
  bool returns_double;
  bool returns_float;
  bool returns_int32;
  bool returns_value;
  bool last_ret_is_fp;
  bool x0_read_since_write;
  bool d0_read_since_write;
  bool d0_compared;
  bool x0_written_32;
  bool x0_written_64;
  bool last_x0_is32;
  uint32_t ret_fp_count;
  uint32_t ret_gpr_count;
  uint32_t ret_int32_count;
  uint32_t ret_int64_count;
  bool table_overflow;
  const char* norm_name;
  uint32_t norm_len;
  uint32_t int_param_count;
  uint32_t fp_param_count;
  uint64_t adrp_page[31];
  bool adrp_valid[31];
  uint64_t saved_adrp_page[31];
  bool saved_adrp_valid[31];
  bool adrp_consumed[31];
  GlobalEntry globals[kMaxGlobals];
  uint32_t global_count;
  uint64_t callees[kMaxCallees];
  uint32_t callee_count;

  void mark_gpr_read(uint32_t r) {
    if (r >= 31u) return;
    gpr_used |= (1u << r);
    if ((gpr_written & (1u << r)) == 0u) {
      gpr_read_before_write |= (1u << r);
    }
    if (r == 0u) x0_read_since_write = true;
  }

  void clear_adrp(uint32_t r) {
    if (r >= 31u) return;
    adrp_valid[r] = false;
    if (r < 19u || r > 28u) saved_adrp_valid[r] = false;
  }

  void mark_gpr_write(uint32_t r, bool is64 = true) {
    if (r >= 31u) return;
    gpr_used |= (1u << r);
    gpr_written |= (1u << r);
    gpr_written_insn |= (1u << r);
    clear_adrp(r);
    if (r == 0u) {
      last_ret_is_fp = false;
      x0_read_since_write = false;
      last_x0_is32 = !is64;
      if (is64) x0_written_64 = true;
      else x0_written_32 = true;
    }
  }

  void mark_fp_read(uint32_t r, int width = 0) {
    r &= 31u;
    fp_used |= (1u << r);
    if ((fp_written & (1u << r)) == 0u) {
      fp_read_before_write |= (1u << r);
      if (width == 1) fp_param_single_mask |= (1u << r);
      else if (width == 2) fp_param_double_mask |= (1u << r);
    }
    if (r == 0u) d0_read_since_write = true;
  }

  void mark_fp_write(uint32_t r) {
    r &= 31u;
    fp_used |= (1u << r);
    fp_written |= (1u << r);
    if (r == 0u) {
      last_ret_is_fp = true;
      d0_read_since_write = false;
      d0_compared = false;
    }
  }

  void mark_q(uint32_t r) {
    q_used |= (1u << (r & 31u));
    uses_uint128 = true;
  }

  void add_global(uint64_t addr, bool addr_of) {
    for (uint32_t i = 0u; i < global_count; ++i) {
      if (globals[i].addr == addr) {
        if (addr_of) globals[i].needs_addr_of = true;
        return;
      }
    }
    if (global_count < kMaxGlobals) {
      globals[global_count].addr = addr;
      globals[global_count].needs_addr_of = addr_of;
      ++global_count;
    } else {
      table_overflow = true;
    }
  }

  void add_callee(uint64_t addr) {
    for (uint32_t i = 0u; i < callee_count; ++i) {
      if (callees[i] == addr) return;
    }
    if (callee_count < kMaxCallees) {
      callees[callee_count++] = addr;
    } else {
      table_overflow = true;
    }
  }

  void sort_tables() {
    for (uint32_t i = 1u; i < global_count; ++i) {
      const GlobalEntry key = globals[i];
      uint32_t j = i;
      while (j > 0u && globals[j - 1u].addr > key.addr) {
        globals[j] = globals[j - 1u];
        --j;
      }
      globals[j] = key;
    }
    for (uint32_t i = 1u; i < callee_count; ++i) {
      const uint64_t key = callees[i];
      uint32_t j = i;
      while (j > 0u && callees[j - 1u] > key) {
        callees[j] = callees[j - 1u];
        --j;
      }
      callees[j] = key;
    }
  }
};

static bool is_internal_target(uint64_t target, uint64_t base_addr, uint32_t word_count, uint32_t* out_idx) {
  if (target < base_addr) return false;
  const uint64_t diff = target - base_addr;
  if ((diff & 3ULL) != 0ULL) return false;
  const uint64_t idx = diff >> 2u;
  if (idx >= static_cast<uint64_t>(word_count)) return false;
  if (out_idx) *out_idx = static_cast<uint32_t>(idx);
  return true;
}

static void mark_ext_types(AnalysisCtx& ctx, uint32_t option) {
  switch (option) {
    case 0u: ctx.uses_uint8 = true; break;
    case 1u: ctx.uses_uint16 = true; break;
    case 2u: ctx.uses_uint32 = true; break;
    case 3u: ctx.uses_uint64_t = true; break;
    case 4u: ctx.uses_int8 = true; ctx.uses_int64_t = true; break;
    case 5u: ctx.uses_int16 = true; ctx.uses_int64_t = true; break;
    case 6u: ctx.uses_int32 = true; ctx.uses_int64_t = true; break;
    case 7u: ctx.uses_int64_t = true; break;
  }
}

static void emit_ext_reg(TextBuf& tb, uint32_t rm, uint32_t option, uint32_t imm3) {
  if (imm3 != 0u) tb.put_char('(');
  switch (option) {
    case 0u: tb.put_str("(uint64_t)(uint8_t)"); tb.put_reg_x(rm); break;
    case 1u: tb.put_str("(uint64_t)(uint16_t)"); tb.put_reg_x(rm); break;
    case 2u: tb.put_str("(uint64_t)(uint32_t)"); tb.put_reg_x(rm); break;
    case 3u: tb.put_str("(uint64_t)"); tb.put_reg_x(rm); break;
    case 4u: tb.put_str("(uint64_t)(int64_t)(int8_t)"); tb.put_reg_x(rm); break;
    case 5u: tb.put_str("(uint64_t)(int64_t)(int16_t)"); tb.put_reg_x(rm); break;
    case 6u: tb.put_str("(uint64_t)(int64_t)(int32_t)"); tb.put_reg_x(rm); break;
    default: tb.put_str("(uint64_t)(int64_t)"); tb.put_reg_x(rm); break;
  }
  if (imm3 != 0u) {
    tb.put_str(" << ");
    tb.put_u64_dec(imm3);
    tb.put_char(')');
  }
}

static void emit_shifted_reg(TextBuf& tb, uint32_t rm, uint32_t shift_type, uint32_t imm6, bool is64) {
  const uint32_t bits = is64 ? 64u : 32u;
  const uint32_t sh = imm6 & (bits - 1u);
  if (sh == 0u) {
    if (!is64) tb.put_str("(uint32_t)");
    tb.put_reg_x(rm);
    return;
  }
  if (shift_type == 2u) {
    if (is64) {
      tb.put_str("(uint64_t)((int64_t)");
      tb.put_reg_x(rm);
      tb.put_str(" >> ");
      tb.put_u64_dec(sh);
      tb.put_char(')');
    } else {
      tb.put_str("(uint32_t)((int32_t)");
      tb.put_reg_x(rm);
      tb.put_str(" >> ");
      tb.put_u64_dec(sh);
      tb.put_char(')');
    }
  } else if (shift_type == 3u) {
    tb.put_str(is64 ? "(((uint64_t)" : "(((uint32_t)");
    tb.put_reg_x(rm);
    tb.put_str(" >> ");
    tb.put_u64_dec(sh);
    tb.put_str(is64 ? ") | ((uint64_t)" : ") | ((uint32_t)");
    tb.put_reg_x(rm);
    tb.put_str(" << ");
    tb.put_u64_dec((bits - sh) & (bits - 1u));
    tb.put_str("))");
  } else {
    tb.put_str(is64 ? "((uint64_t)" : "((uint32_t)");
    tb.put_reg_x(rm);
    tb.put_str(shift_type == 0u ? " << " : " >> ");
    tb.put_u64_dec(sh);
    tb.put_char(')');
  }
}

static void emit_nzcv_addsub_tail(TextBuf& tb, bool is64, bool is_sub, uint32_t rd) {
  if (is64) {
    if (is_sub) {
      tb.put_str("; uint64_t __cr = __ca - __cb; __hex_nzcv = ((uint32_t)((__cr >> 63) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | ((__ca >= __cb) ? 2u : 0u) | ((uint32_t)((((__ca ^ __cb) & (__ca ^ __cr)) >> 63) & 1u));");
    } else {
      tb.put_str("; uint64_t __cr = __ca + __cb; __hex_nzcv = ((uint32_t)((__cr >> 63) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | ((__cr < __ca) ? 2u : 0u) | ((uint32_t)(((~(__ca ^ __cb) & (__ca ^ __cr)) >> 63) & 1u));");
    }
  } else {
    if (is_sub) {
      tb.put_str("; uint32_t __cr = __ca - __cb; __hex_nzcv = (((__cr >> 31) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | ((__ca >= __cb) ? 2u : 0u) | ((((__ca ^ __cb) & (__ca ^ __cr)) >> 31) & 1u);");
    } else {
      tb.put_str("; uint32_t __cr = __ca + __cb; __hex_nzcv = (((__cr >> 31) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | ((__cr < __ca) ? 2u : 0u) | (((~(__ca ^ __cb) & (__ca ^ __cr)) >> 31) & 1u);");
    }
  }
  if (rd < 31u) {
    tb.put_char(' ');
    tb.put_reg_x(rd);
    tb.put_str(" = __cr;");
  }
  tb.put_str(" }\n");
}

static void emit_cond_expr(TextBuf& tb, uint32_t cond, const CmpState& cmp) {
  if (!cmp.valid) {
    tb.put_str("(1)");
    return;
  }
  const uint32_t c = cond & 0xFu;
  if (cmp.is_nzcv_var) {
    switch (c) {
      case 0x0u: tb.put_str("((__hex_nzcv & 4u) != 0u)"); return;
      case 0x1u: tb.put_str("((__hex_nzcv & 4u) == 0u)"); return;
      case 0x2u: tb.put_str("((__hex_nzcv & 2u) != 0u)"); return;
      case 0x3u: tb.put_str("((__hex_nzcv & 2u) == 0u)"); return;
      case 0x4u: tb.put_str("((__hex_nzcv & 8u) != 0u)"); return;
      case 0x5u: tb.put_str("((__hex_nzcv & 8u) == 0u)"); return;
      case 0x6u: tb.put_str("((__hex_nzcv & 1u) != 0u)"); return;
      case 0x7u: tb.put_str("((__hex_nzcv & 1u) == 0u)"); return;
      case 0x8u: tb.put_str("(((__hex_nzcv & 2u) != 0u) && ((__hex_nzcv & 4u) == 0u))"); return;
      case 0x9u: tb.put_str("(((__hex_nzcv & 2u) == 0u) || ((__hex_nzcv & 4u) != 0u))"); return;
      case 0xAu: tb.put_str("((((__hex_nzcv >> 3u) & 1u) == (__hex_nzcv & 1u)))"); return;
      case 0xBu: tb.put_str("((((__hex_nzcv >> 3u) & 1u) != (__hex_nzcv & 1u)))"); return;
      case 0xCu: tb.put_str("(((__hex_nzcv & 4u) == 0u) && (((__hex_nzcv >> 3u) & 1u) == (__hex_nzcv & 1u)))"); return;
      case 0xDu: tb.put_str("(((__hex_nzcv & 4u) != 0u) || (((__hex_nzcv >> 3u) & 1u) != (__hex_nzcv & 1u)))"); return;
      default: tb.put_str("(1)"); return;
    }
  }
  if ((c == 0x4u || c == 0x5u) && !cmp.is_fp) {
    // MI (negative) / PL (non-negative): evaluate sign bit of (lhs +/- rhs)
    const char* scast = cmp.is32 ? "(int32_t)" : "(int64_t)";
    const char* ucast = cmp.is32 ? "(uint32_t)" : "(uint64_t)";
    tb.put_char('(');
    tb.put_str(scast);
    if (cmp.is_imm && cmp.rhs_imm == 0ULL) {
      if (cmp.lhs_is_sp) tb.put_reg_x_or_sp(cmp.lhs_reg);
      else tb.put_reg_x(cmp.lhs_reg);
    } else {
      tb.put_char('(');
      tb.put_str(ucast);
      if (cmp.lhs_is_sp) tb.put_reg_x_or_sp(cmp.lhs_reg);
      else tb.put_reg_x(cmp.lhs_reg);
      tb.put_str(cmp.is_cmn ? " + " : " - ");
      tb.put_str(ucast);
      if (cmp.is_imm) tb.put_imm(cmp.rhs_imm);
      else tb.put_reg_x(cmp.rhs_reg);
      tb.put_char(')');
    }
    tb.put_str(c == 0x4u ? " < 0)" : " >= 0)");
    return;
  }
  const bool signed_cmp = (c == 0xAu || c == 0xBu || c == 0xCu || c == 0xDu);
  const char* op = "==";
  switch (c) {
    case 0x0u: op = "=="; break;  // eq
    case 0x1u: op = "!="; break;  // ne
    case 0x2u: op = ">="; break;  // hs/cs
    case 0x3u: op = "<";  break;  // lo/cc
    case 0x4u: op = "<";  break;  // mi (FP less than)
    case 0x5u: op = ">="; break;  // pl (FP greater/equal)
    case 0x8u: op = ">";  break;  // hi
    case 0x9u: op = "<="; break;  // ls
    case 0xAu: op = ">="; break;  // ge
    case 0xBu: op = "<";  break;  // lt
    case 0xCu: op = ">";  break;  // gt
    case 0xDu: op = "<="; break;  // le
    default:
      tb.put_str("(1)");
      return;
  }

  tb.put_char('(');
  if (cmp.is_fp) {
    tb.put_reg_d(cmp.lhs_reg);
    tb.put_char(' ');
    tb.put_str(op);
    tb.put_char(' ');
    if (cmp.is_imm) {
      tb.put_str("0.0");
    } else {
      tb.put_reg_d(cmp.rhs_reg);
    }
    tb.put_char(')');
    return;
  }

  const char* cast = cmp.is32
      ? (signed_cmp ? "(int32_t)" : "(uint32_t)")
      : (signed_cmp ? "(int64_t)" : "(uint64_t)");

  tb.put_str(cast);
  if (cmp.lhs_is_sp) tb.put_reg_x_or_sp(cmp.lhs_reg);
  else tb.put_reg_x(cmp.lhs_reg);
  tb.put_char(' ');
  tb.put_str(op);
  tb.put_char(' ');
  if (cmp.is_cmn) tb.put_str("-(");
  tb.put_str(cast);
  if (cmp.is_imm) {
    tb.put_imm(cmp.rhs_imm);
  } else {
    tb.put_reg_x(cmp.rhs_reg);
  }
  if (cmp.is_cmn) tb.put_char(')');
  tb.put_char(')');
}

static void emit_mem_addr(TextBuf& tb, uint32_t rn, int64_t disp) {
  tb.put_str("(uintptr_t)(");
  tb.put_reg_x_or_sp(rn);
  tb.put_char(')');
  if (disp > 0) {
    tb.put_str(" + ");
    tb.put_imm(static_cast<uint64_t>(disp));
  } else if (disp < 0) {
    tb.put_str(" - ");
    const uint64_t mag = static_cast<uint64_t>(-(disp + 1)) + 1ULL;
    tb.put_imm(mag);
  }
}

static void emit_mem_load_type(TextBuf& tb, uint32_t size_bits, bool is_signed, bool is_fp) {
  if (is_fp) {
    if (size_bits == 128u) tb.put_str("*(uint128 *)(");
    else if (size_bits == 64u) tb.put_str("*(double *)(");
    else tb.put_str("*(float *)(");
    return;
  }
  if (size_bits == 8u) tb.put_str(is_signed ? "*(int8_t *)(" : "*(uint8_t *)(");
  else if (size_bits == 16u) tb.put_str(is_signed ? "*(int16_t *)(" : "*(uint16_t *)(");
  else if (size_bits == 32u) tb.put_str(is_signed ? "*(int32_t *)(" : "*(uint32_t *)(");
  else tb.put_str("*(uint64 *)(");
}

static void mark_mem_types(AnalysisCtx& ctx, uint32_t size_bits, bool is_signed, bool is_fp) {
  ctx.uses_uintptr = true;
  if (is_fp) {
    if (size_bits == 128u) ctx.uses_uint128 = true;
    return;
  }
  if (size_bits == 8u) {
    if (is_signed) ctx.uses_int8 = true;
    else ctx.uses_uint8 = true;
  } else if (size_bits == 16u) {
    if (is_signed) ctx.uses_int16 = true;
    else ctx.uses_uint16 = true;
  } else if (size_bits == 32u) {
    if (is_signed) ctx.uses_int32 = true;
    else ctx.uses_uint32 = true;
  }
}

static void mark_neon_types(AnalysisCtx& ctx, uint32_t esize, bool is_signed) {
  if (esize == 8u) { ctx.uses_uint8 = true; if (is_signed) ctx.uses_int8 = true; }
  else if (esize == 16u) { ctx.uses_uint16 = true; if (is_signed) ctx.uses_int16 = true; }
  else if (esize == 32u) { ctx.uses_uint32 = true; if (is_signed) ctx.uses_int32 = true; }
  else { ctx.uses_uint64_t = true; if (is_signed) ctx.uses_int64_t = true; }
}

static const char* neon_utype(uint32_t esize) {
  if (esize == 8u) return "uint8_t";
  if (esize == 16u) return "uint16_t";
  if (esize == 32u) return "uint32_t";
  return "uint64_t";
}

static const char* neon_stype(uint32_t esize) {
  if (esize == 8u) return "int8_t";
  if (esize == 16u) return "int16_t";
  if (esize == 32u) return "int32_t";
  return "int64_t";
}

static void emit_sync_d_to_q(TextBuf* tb, const AnalysisCtx& ctx, uint32_t r, bool is_double) {
  if (!tb || r >= 32u || (ctx.q_used & (1u << r)) == 0u) return;
  tb->put_str("    ");
  tb->put_reg_q(r);
  if (is_double) {
    tb->put_str(" = (uint128)__hex_f64_to_u64(");
    tb->put_reg_d(r);
    tb->put_str(");\n");
  } else {
    tb->put_str(" = (uint128)__hex_f32_to_u32((float)");
    tb->put_reg_d(r);
    tb->put_str(");\n");
  }
}

static void emit_sync_q_to_d(TextBuf* tb, const AnalysisCtx& ctx, uint32_t r, bool prefer_double = false) {
  if (!tb || r >= 32u || (ctx.fp_used & (1u << r)) == 0u) return;
  const bool use_double = prefer_double || (((ctx.fp_double_mask & (1u << r)) != 0u) && ((ctx.fp_single_mask & (1u << r)) == 0u));
  tb->put_str("    ");
  tb->put_reg_d(r);
  if (use_double) {
    tb->put_str(" = __hex_u64_to_f64((uint64_t)");
    tb->put_reg_q(r);
    tb->put_str(");\n");
  } else {
    tb->put_str(" = (double)__hex_u32_to_f32((uint32_t)");
    tb->put_reg_q(r);
    tb->put_str(");\n");
  }
}

static uint64_t decode_advsimd_imm64(uint32_t op, uint32_t cmode, uint32_t imm8) {
  if ((cmode & 0x8u) == 0x0u) {
    // cmode 0,2,4,6 (MOVI/MVNI 32-bit) and 1,3,5,7 (ORR/BIC 32-bit)
    const uint32_t shift = (cmode >> 1u) * 8u;
    uint32_t v = imm8 << shift;
    if ((cmode & 1u) == 0u && op != 0u) v = ~v;
    return static_cast<uint64_t>(v) | (static_cast<uint64_t>(v) << 32u);
  }
  if ((cmode & 0xCu) == 0x8u) {
    // cmode 8,10 (MOVI/MVNI 16-bit) and 9,11 (ORR/BIC 16-bit)
    const uint32_t shift = ((cmode >> 1u) & 1u) * 8u;
    uint16_t v = static_cast<uint16_t>(imm8 << shift);
    if ((cmode & 1u) == 0u && op != 0u) v = static_cast<uint16_t>(~v);
    const uint64_t w16 = static_cast<uint64_t>(v);
    return w16 | (w16 << 16u) | (w16 << 32u) | (w16 << 48u);
  }
  if ((cmode & 0xEu) == 0xCu) {
    const uint32_t ones_bits = ((cmode & 1u) + 1u) * 8u;
    uint32_t v = (imm8 << ones_bits) | ((1u << ones_bits) - 1u);
    if (op != 0u) v = ~v;
    return static_cast<uint64_t>(v) | (static_cast<uint64_t>(v) << 32u);
  }
  if (cmode == 0xEu) {
    if (op == 0u) {
      return static_cast<uint64_t>(imm8) * 0x0101010101010101ULL;
    }
    uint64_t r = 0ULL;
    for (uint32_t b = 0u; b < 8u; ++b) {
      if (((imm8 >> b) & 1u) != 0u) r |= (0xFFULL << (b * 8u));
    }
    return r;
  }
  const uint32_t a = (imm8 >> 7u) & 1u;
  const uint32_t b = (imm8 >> 6u) & 1u;
  const uint32_t cdefgh = imm8 & 0x3Fu;
  if (op == 0u) {
    const uint32_t v = (a << 31u) | ((b ^ 1u) << 30u) | (b ? (0x1Fu << 25u) : 0u) | (cdefgh << 19u);
    return static_cast<uint64_t>(v) | (static_cast<uint64_t>(v) << 32u);
  }
  return (static_cast<uint64_t>(a) << 63u) | (static_cast<uint64_t>(b ^ 1u) << 62u) |
         (b ? (0xFFULL << 54u) : 0ULL) | (static_cast<uint64_t>(cdefgh) << 48u);
}

// Single-instruction processor used in both analysis pass (emit=false) and emission pass (emit=true).
static void process_insn(
    uint32_t w,
    uint64_t pc,
    uint64_t base_addr,
    uint32_t word_count,
    AnalysisCtx& ctx,
    CmpState& cmp,
    bool emit,
    TextBuf* tb) {
  auto rec = [&]() {
    if (emit && tb) tb->record_line(pc);
  };

  // NOP / HINT / BTI / PACIASP / AUTIASP
  if (w == 0xD503201Fu || (w & 0xFFFFF01Fu) == 0xD503201Fu) {
    return;
  }

  // BRK / UDF
  if ((w & 0xFFE0001Fu) == 0xD4200000u || (w & 0xFFFF0000u) == 0x00000000u) {
    if (emit && tb) {
      rec();
      tb->put_str("    __builtin_trap();\n");
    }
    return;
  }

  // PAC* / AUT* / XPAC* (Data-processing 1-source opcode2 == 00001)
  if (((w & 0xFFFF0000u) == 0xDAC10000u && (((w >> 10u) & 0x3Fu) <= 17u))) {
    if (emit && tb) {
      rec();
      tb->put_str("    (void)0; /* pac */\n");
    }
    return;
  }

  // RET (x30 or reg) / RETAA (0xD65F0BFF) / RETAB (0xD65F0FFF)
  if ((w & 0xFFFFFC1Fu) == 0xD65F0000u || w == 0xD65F0BFFu || w == 0xD65F0FFFu) {
    if (!emit) {
      const bool fp_w = (ctx.fp_written & 1u) != 0u && (ctx.fp_used & 1u) != 0u && (((ctx.fp_single_mask | ctx.fp_double_mask) & 1u) != 0u);
      const bool gpr_w = (ctx.gpr_written & 1u) != 0u && (ctx.gpr_used & 1u) != 0u;
      bool voted_gpr = false;
      if (fp_w && !ctx.d0_compared && (!gpr_w || ctx.x0_read_since_write || (ctx.last_ret_is_fp && !ctx.d0_read_since_write))) {
        ctx.ret_fp_count += 3u;
      } else if (fp_w && ctx.d0_compared && gpr_w && !ctx.x0_read_since_write) {
        ctx.ret_gpr_count += 3u;
        voted_gpr = true;
      } else if (fp_w && ctx.d0_compared && gpr_w && ctx.x0_read_since_write && !ctx.last_ret_is_fp) {
        // e.g. tid 35: x0 is loop ptr (read by cmp), s0 is running max (compared by fcmpe)
        ctx.ret_fp_count += 2u;
      } else if (gpr_w && !ctx.x0_read_since_write && (!fp_w || ctx.d0_read_since_write || !ctx.last_ret_is_fp)) {
        ctx.ret_gpr_count += 2u;
        voted_gpr = true;
      } else if (ctx.last_ret_is_fp && fp_w && !ctx.d0_compared) {
        ctx.ret_fp_count += 1u;
      } else if (gpr_w) {
        ctx.ret_gpr_count += 1u;
        voted_gpr = true;
      } else if (fp_w) {
        ctx.ret_fp_count += 1u;
      }
      if (voted_gpr) {
        if (ctx.last_x0_is32) ctx.ret_int32_count++;
        else ctx.ret_int64_count++;
      }
    } else if (tb) {
      rec();
      if (ctx.returns_float) {
        tb->put_str("    return (float)d0;\n");
      } else if (ctx.returns_double) {
        tb->put_str("    return d0;\n");
      } else if (ctx.returns_int32) {
        tb->put_str("    return (int)(int32_t)x0;\n");
      } else if (ctx.returns_value) {
        tb->put_str("    return x0;\n");
      } else {
        tb->put_str("    return;\n");
      }
    }
    return;
  }

  // B #imm26 (unconditional branch or external tail call)
  if ((w & 0xFC000000u) == 0x14000000u) {
    const int64_t delta = sign_extend(w & 0x03FFFFFFu, 26u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    uint32_t tidx = 0u;
    if (is_internal_target(target, base_addr, word_count, &tidx)) {
      if (emit && tb) {
        rec();
        tb->put_str("    goto loc_");
        tb->put_u64_hex(target, true);
        tb->put_str(";\n");
      }
    } else {
      if (!emit) {
        ctx.add_callee(target);
      } else if (tb) {
        rec();
        if (ctx.returns_value && !ctx.returns_double) {
          tb->put_str("    return sub_");
          tb->put_u64_hex(target, true);
          tb->put_str("(/* arguments unknown */);\n");
        } else {
          tb->put_str("    sub_");
          tb->put_u64_hex(target, true);
          tb->put_str("(/* arguments unknown */);\n");
          rec();
          if (ctx.returns_double) tb->put_str("    return d0;\n");
          else tb->put_str("    return;\n");
        }
      }
    }
    return;
  }

  // BL #imm26
  if ((w & 0xFC000000u) == 0x94000000u) {
    const int64_t delta = sign_extend(w & 0x03FFFFFFu, 26u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (!emit) {
      if (target != base_addr) ctx.add_callee(target);
      ctx.mark_gpr_write(0u);
      ctx.fp_written |= 1u;
      // Caller-saved ADRP pages may be clobbered by call (x0..x18).
      for (uint32_t r = 0u; r < 19u; ++r) ctx.clear_adrp(r);
    } else if (tb) {
      rec();
      if (target == base_addr && ctx.norm_name && ctx.norm_len > 0u) {
        tb->put_str("    ");
        if (ctx.returns_double) tb->put_str("d0 = ");
        else if (ctx.returns_value) tb->put_str("x0 = ");
        tb->put_bytes(ctx.norm_name, ctx.norm_len);
        tb->put_char('(');
        bool first = true;
        for (uint32_t r = 0u; r < ctx.int_param_count; ++r) {
          if (!first) tb->put_str(", ");
          if ((ctx.gpr_used & (1u << r)) != 0u) {
            tb->put_reg_x(r);
          } else {
            tb->put_char('a');
            tb->put_u64_dec(r + 1u);
          }
          first = false;
        }
        for (uint32_t r = 0u; r < ctx.fp_param_count; ++r) {
          if (!first) tb->put_str(", ");
          if ((ctx.fp_used & (1u << r)) != 0u) {
            tb->put_reg_d(r);
          } else {
            tb->put_str("fa");
            tb->put_u64_dec(r + 1u);
          }
          first = false;
        }
        tb->put_str(");\n");
      } else {
        tb->put_str("    x0 = sub_");
        tb->put_u64_hex(target, true);
        tb->put_str("(/* arguments unknown */);\n");
      }
      for (uint32_t r = 0u; r < 19u; ++r) ctx.clear_adrp(r);
    }
    if (!cmp.is_nzcv_var) cmp.valid = false;
    return;
  }

  // BLR Xn / BLRAAZ / BLRABZ / BLRAA / BLRAB
  if ((w & 0xFFFFFC1Fu) == 0xD63F0000u || (w & 0xFFFFF81Fu) == 0xD63F081Fu || (w & 0xFFFFF800u) == 0xD73F0800u) {
    const uint32_t rn = (w >> 5u) & 31u;
    const bool has_rm = ((w & 0xFFFFF800u) == 0xD73F0800u);
    const uint32_t rm = w & 31u;
    if (!emit) {
      ctx.has_unknown_call = true;
      ctx.mark_gpr_read(rn);
      if (has_rm && rm < 31u) ctx.mark_gpr_read(rm);
      ctx.mark_gpr_read(0u);
      ctx.mark_gpr_write(0u);
      for (uint32_t r = 0u; r < 19u; ++r) ctx.clear_adrp(r);
    } else if (tb) {
      rec();
      tb->put_str("    x0 = unknown_call(x0);\n");
      for (uint32_t r = 0u; r < 19u; ++r) ctx.clear_adrp(r);
    }
    if (!cmp.is_nzcv_var) cmp.valid = false;
    return;
  }

  // BR Xn / BRAAZ / BRABZ / BRAA / BRAB (indirect branch / jump table)
  if ((w & 0xFFFFFC1Fu) == 0xD61F0000u || (w & 0xFFFFF81Fu) == 0xD61F081Fu || (w & 0xFFFFF800u) == 0xD71F0800u) {
    const uint32_t rn = (w >> 5u) & 31u;
    if (!emit) {
      ctx.mark_gpr_read(rn);
    } else if (tb) {
      rec();
      tb->put_str("    (void)");
      tb->put_reg_x(rn);
      tb->put_str("; /* indirect branch */\n");
    }
    return;
  }

  // CBZ / CBNZ
  if ((w & 0x7E000000u) == 0x34000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_nz = ((w >> 24u) & 1u) != 0u;
    const uint32_t rt = w & 31u;
    const int64_t delta = sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (!emit) {
      ctx.mark_gpr_read(rt);
      if (!is64) ctx.uses_uint32 = true;
    } else if (tb) {
      uint32_t tidx = 0u;
      if (is_internal_target(target, base_addr, word_count, &tidx)) {
        rec();
        tb->put_str("    if (");
        if (!is64) tb->put_str("(uint32_t)");
        tb->put_reg_x(rt);
        tb->put_str(is_nz ? " != 0) goto loc_" : " == 0) goto loc_");
        tb->put_u64_hex(target, true);
        tb->put_str(";\n");
      }
    }
    return;
  }

  // TBZ / TBNZ
  if ((w & 0x7E000000u) == 0x36000000u) {
    const bool is_nz = ((w >> 24u) & 1u) != 0u;
    const uint32_t bit = (((w >> 31u) & 1u) << 5u) | ((w >> 19u) & 31u);
    const uint32_t rt = w & 31u;
    const int64_t delta = sign_extend((w >> 5u) & 0x3FFFu, 14u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (!emit) {
      ctx.mark_gpr_read(rt);
    } else if (tb) {
      uint32_t tidx = 0u;
      if (is_internal_target(target, base_addr, word_count, &tidx)) {
        rec();
        tb->put_str("    if (((");
        tb->put_reg_x(rt);
        tb->put_str(" >> ");
        tb->put_u64_dec(bit);
        tb->put_str(") & 1ULL) ");
        tb->put_str(is_nz ? "!= 0) goto loc_" : "== 0) goto loc_");
        tb->put_u64_hex(target, true);
        tb->put_str(";\n");
      }
    }
    return;
  }

  // B.cond
  if ((w & 0xFF000010u) == 0x54000000u) {
    const uint32_t cond = w & 0xFu;
    const int64_t delta = sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (!emit) {
      if (cmp.valid && !cmp.is_fp) {
        const bool signed_cmp = (cond == 0xAu || cond == 0xBu || cond == 0xCu || cond == 0xDu);
        if (cmp.is32) {
          if (signed_cmp) ctx.uses_int32 = true;
          else ctx.uses_uint32 = true;
        } else {
          if (signed_cmp) ctx.uses_int64_t = true;
          else ctx.uses_uint64_t = true;
        }
      }
    } else if (tb) {
      uint32_t tidx = 0u;
      if (is_internal_target(target, base_addr, word_count, &tidx)) {
        rec();
        tb->put_str("    if ");
        emit_cond_expr(*tb, cond, cmp);
        tb->put_str(" goto loc_");
        tb->put_u64_hex(target, true);
        tb->put_str(";\n");
      }
    }
    return;
  }

  // ADRP / ADR
  if ((w & 0x1F000000u) == 0x10000000u) {
    const bool is_adrp = ((w >> 31u) & 1u) != 0u;
    const uint32_t rd = w & 31u;
    const uint32_t immlo = (w >> 29u) & 3u;
    const uint32_t immhi = (w >> 5u) & 0x7FFFFu;
    const int64_t imm21 = sign_extend((immhi << 2u) | immlo, 21u);
    const uint64_t val = is_adrp
        ? ((pc & ~0xFFFULL) + (static_cast<uint64_t>(imm21) << 12u))
        : (pc + static_cast<uint64_t>(imm21));
    if (rd < 31u) {
      if (!emit) {
        ctx.mark_gpr_write(rd);
        ctx.adrp_page[rd] = val;
        ctx.adrp_valid[rd] = is_adrp;
        if (is_adrp) {
          ctx.saved_adrp_page[rd] = val;
          ctx.saved_adrp_valid[rd] = true;
          ctx.adrp_consumed[rd] = false;
        }
      } else if (tb) {
        if (is_adrp) {
          ctx.adrp_page[rd] = val;
          ctx.adrp_valid[rd] = true;
          ctx.saved_adrp_page[rd] = val;
          ctx.saved_adrp_valid[rd] = true;
          ctx.adrp_consumed[rd] = false;
        } else {
          ctx.clear_adrp(rd);
        }
        if (!is_adrp) {
          rec();
          tb->put_str("    ");
          tb->put_reg_x(rd);
          tb->put_str(" = 0x");
          tb->put_u64_hex(val, true);
          tb->put_str("ULL;\n");
        }
      }
    }
    return;
  }

  // MOVZ / MOVN / MOVK (opc=1 is unallocated)
  if ((w & 0x1F800000u) == 0x12800000u && ((w >> 29u) & 3u) != 1u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t opc = (w >> 29u) & 3u;  // 0=movn, 2=movz, 3=movk
    const uint32_t hw = (w >> 21u) & 3u;
    const uint64_t imm16 = static_cast<uint64_t>((w >> 5u) & 0xFFFFu);
    const uint32_t rd = w & 31u;
    if (rd < 31u && (is64 || hw < 2u)) {
      const uint32_t shift = hw * 16u;
      if (opc == 3u) {  // MOVK
        if (!emit) {
          ctx.mark_gpr_read(rd);
          ctx.mark_gpr_write(rd, is64);
        } else if (tb) {
          const uint64_t clear_mask = ~(0xFFFFULL << shift);
          rec();
          tb->put_str("    ");
          tb->put_reg_x(rd);
          tb->put_str(" = (");
          tb->put_reg_x(rd);
          tb->put_str(" & 0x");
          tb->put_u64_hex(is64 ? clear_mask : (clear_mask & 0xFFFFFFFFULL), true);
          tb->put_str("ULL) | 0x");
          tb->put_u64_hex(imm16 << shift, true);
          tb->put_str("ULL;\n");
          ctx.clear_adrp(rd);
        }
      } else {
        uint64_t val = imm16 << shift;
        if (opc == 0u) val = ~val;
        if (!is64) val &= 0xFFFFFFFFULL;
        if (!emit) {
          ctx.mark_gpr_write(rd, is64);
        } else if (tb) {
          rec();
          tb->put_str("    ");
          tb->put_reg_x(rd);
          tb->put_str(" = ");
          tb->put_imm(val);
          tb->put_str(";\n");
          ctx.clear_adrp(rd);
        }
      }
    }
    return;
  }

  // Logical Immediate: AND / ORR / EOR / ANDS (TST)
  if ((w & 0x1F800000u) == 0x12000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t opc = (w >> 29u) & 3u;  // 0=and, 1=orr, 2=eor, 3=ands
    const uint32_t N = (w >> 22u) & 1u;
    const uint32_t immr = (w >> 16u) & 0x3Fu;
    const uint32_t imms = (w >> 10u) & 0x3Fu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    uint64_t imm = 0ULL;
    if (decode_bitmask_imm(N, imms, immr, is64, &imm)) {
      const bool sets_flags = (opc == 3u);
      if (sets_flags) {
        cmp = CmpState{true, !is64, false, false, false, false, 0u, 0u, 0ULL, true};
      }
      if (!emit) {
        if (rn < 31u) ctx.mark_gpr_read(rn);
        if (rd < 31u) ctx.mark_gpr_write(rd, is64);
        else if (!sets_flags) ctx.uses_sp = true;
        if (sets_flags) {
          ctx.uses_nzcv = true;
          ctx.uses_uint32 = true;
          if (is64) ctx.uses_uint64_t = true;
        }
        if (!is64 && !(sets_flags && rd == 31u)) ctx.uses_uint32 = true;
      } else if (tb) {
        if (sets_flags) {
          rec();
          tb->put_str(is64 ? "    { uint64_t __tr = (uint64_t)(" : "    { uint32_t __tr = (uint32_t)(");
          tb->put_reg_x(rn);
          tb->put_str(" & ");
          tb->put_imm(imm);
          tb->put_str(is64
              ? "); __hex_nzcv = ((uint32_t)((__tr >> 63) & 1u) << 3) | ((__tr == 0u) ? 4u : 0u);"
              : "); __hex_nzcv = (((__tr >> 31) & 1u) << 3) | ((__tr == 0u) ? 4u : 0u);");
          if (rd < 31u) {
            tb->put_char(' ');
            tb->put_reg_x(rd);
            tb->put_str(" = __tr;");
            ctx.clear_adrp(rd);
          }
          tb->put_str(" }\n");
        } else {
          rec();
          tb->put_str("    ");
          tb->put_reg_x_or_sp(rd);
          tb->put_str(" = ");
          if (opc == 1u && rn == 31u) {
            tb->put_imm(imm);
          } else {
            if (!is64) tb->put_str("(uint32_t)(");
            tb->put_reg_x(rn);
            tb->put_str(opc == 1u ? " | " : (opc == 2u ? " ^ " : " & "));
            tb->put_imm(imm);
            if (!is64) tb->put_char(')');
          }
          tb->put_str(";\n");
          if (rd < 31u) ctx.clear_adrp(rd);
        }
      }
    }
    return;
  }

  // ADD / ADDS / SUB / SUBS (immediate)
  if ((w & 0x1F800000u) == 0x11000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const bool sets_flags = ((w >> 29u) & 1u) != 0u;
    const uint32_t sh = (w >> 22u) & 1u;
    const uint64_t imm = static_cast<uint64_t>((w >> 10u) & 0xFFFu) << (sh ? 12u : 0u);
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;

    if (sets_flags) {
      cmp = CmpState{true, !is64, false, false, false, false, 0u, 0u, 0ULL, true};
    }

    // ADRP + ADD global address resolution
    if (!is_sub && !sets_flags && is64 && rn < 31u && rd < 31u && (ctx.adrp_valid[rn] || (imm != 0ULL && ctx.saved_adrp_valid[rn] && !ctx.adrp_consumed[rn])) && (((ctx.adrp_valid[rn] ? ctx.adrp_page[rn] : ctx.saved_adrp_page[rn]) + imm) >= 0x100ULL)) {
      const uint64_t gaddr = (ctx.adrp_valid[rn] ? ctx.adrp_page[rn] : ctx.saved_adrp_page[rn]) + imm;
      if (!emit) {
        const bool keep_saved = (rd == rn) && ctx.saved_adrp_valid[rd];
        const uint64_t keep_page = ctx.saved_adrp_page[rd];
        ctx.add_global(gaddr, true);
        ctx.uses_uintptr = true;
        ctx.mark_gpr_write(rd, is64);
        if (keep_saved) { ctx.saved_adrp_valid[rd] = true; ctx.saved_adrp_page[rd] = keep_page; ctx.adrp_consumed[rd] = true; }
      } else if (tb) {
        const bool keep_saved = (rd == rn) && ctx.saved_adrp_valid[rd];
        const uint64_t keep_page = ctx.saved_adrp_page[rd];
        ctx.clear_adrp(rd);
        if (keep_saved) { ctx.saved_adrp_valid[rd] = true; ctx.saved_adrp_page[rd] = keep_page; ctx.adrp_consumed[rd] = true; }
        rec();
        tb->put_str("    ");
        tb->put_reg_x(rd);
        tb->put_str(" = (uintptr_t)(&global_");
        tb->put_u64_hex(gaddr, true);
        tb->put_str(");\n");
      }
      return;
    }

    if (!emit) {
      if (rn == 31u) ctx.uses_sp = true;
      else ctx.mark_gpr_read(rn);
      if (rd < 31u) ctx.mark_gpr_write(rd, is64);
      else if (!sets_flags) ctx.uses_sp = true;
      if (sets_flags) {
        ctx.uses_nzcv = true;
        ctx.uses_uint32 = true;
        if (is64) ctx.uses_uint64_t = true;
      }
      if (!is64 && !(sets_flags && rd == 31u)) ctx.uses_uint32 = true;
    } else if (tb) {
      rec();
      if (sets_flags) {
        tb->put_str(is64 ? "    { uint64_t __ca = (uint64_t)" : "    { uint32_t __ca = (uint32_t)");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(is64 ? ", __cb = (uint64_t)" : ", __cb = (uint32_t)");
        tb->put_imm(imm);
        emit_nzcv_addsub_tail(*tb, is64, is_sub, rd);
        if (rd < 31u) ctx.clear_adrp(rd);
        return;
      }
      tb->put_str("    ");
      tb->put_reg_x_or_sp(rd);
      tb->put_str(" = ");
      if (!is64) tb->put_str("(uint32_t)(");
      tb->put_reg_x_or_sp(rn);
      if (imm != 0ULL) {
        tb->put_str(is_sub ? " - " : " + ");
        tb->put_imm(imm);
      }
      if (!is64) tb->put_char(')');
      tb->put_str(";\n");
      if (rd < 31u) ctx.clear_adrp(rd);
    }
    return;
  }

  // ADD / ADDS / SUB / SUBS (shifted register)
  if ((w & 0x1F200000u) == 0x0B000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const bool sets_flags = ((w >> 29u) & 1u) != 0u;
    const uint32_t shift_type = (w >> 22u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t imm6 = (w >> 10u) & 0x3Fu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;

    if (sets_flags) {
      cmp = CmpState{true, !is64, false, false, false, false, 0u, 0u, 0ULL, true};
    }
    if (!emit) {
      ctx.mark_gpr_read(rn);
      ctx.mark_gpr_read(rm);
      if (rd < 31u) ctx.mark_gpr_write(rd, is64);
      if (sets_flags) {
        ctx.uses_nzcv = true;
        ctx.uses_uint32 = true;
        if (is64) ctx.uses_uint64_t = true;
      }
      if (!is64) ctx.uses_uint32 = true;
      if (imm6 != 0u) {
        if (is64) ctx.uses_uint64_t = true;
        if (shift_type == 2u) { if (is64) ctx.uses_int64_t = true; else ctx.uses_int32 = true; }
      }
    } else if (tb) {
      if (sets_flags) {
        rec();
        tb->put_str(is64 ? "    { uint64_t __ca = (uint64_t)" : "    { uint32_t __ca = (uint32_t)");
        tb->put_reg_x(rn);
        tb->put_str(is64 ? ", __cb = (uint64_t)" : ", __cb = (uint32_t)");
        emit_shifted_reg(*tb, rm, shift_type, imm6, is64);
        emit_nzcv_addsub_tail(*tb, is64, is_sub, rd);
        if (rd < 31u) ctx.clear_adrp(rd);
        return;
      }
      if (rd < 31u) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x(rd);
        tb->put_str(" = ");
        if (!is64) tb->put_str("(uint32_t)(");
        if (rn == 31u && is_sub) {
          tb->put_str("-");
        } else {
          tb->put_reg_x(rn);
          tb->put_str(is_sub ? " - " : " + ");
        }
        emit_shifted_reg(*tb, rm, shift_type, imm6, is64);
        if (!is64) tb->put_char(')');
        tb->put_str(";\n");
        ctx.clear_adrp(rd);
      }
    }
    return;
  }

  // ADD / ADDS / SUB / SUBS (extended register)
  if ((w & 0x1FE00000u) == 0x0B200000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const bool sets_flags = ((w >> 29u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t option = (w >> 13u) & 7u;
    const uint32_t imm3 = (w >> 10u) & 7u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (sets_flags) {
      cmp = CmpState{true, !is64, false, false, false, false, 0u, 0u, 0ULL, true};
    }
    if (!emit) {
      if (rn == 31u) ctx.uses_sp = true;
      else ctx.mark_gpr_read(rn);
      ctx.mark_gpr_read(rm);
      if (rd < 31u) ctx.mark_gpr_write(rd, is64);
      else if (!sets_flags) ctx.uses_sp = true;
      ctx.uses_uint64_t = true;
      mark_ext_types(ctx, option);
      if (sets_flags) {
        ctx.uses_nzcv = true;
        ctx.uses_uint32 = true;
      }
      if (!is64) ctx.uses_uint32 = true;
    } else if (tb) {
      if (sets_flags) {
        rec();
        tb->put_str(is64 ? "    { uint64_t __ca = (uint64_t)" : "    { uint32_t __ca = (uint32_t)");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(is64 ? ", __cb = (uint64_t)" : ", __cb = (uint32_t)");
        emit_ext_reg(*tb, rm, option, imm3);
        emit_nzcv_addsub_tail(*tb, is64, is_sub, rd);
        if (rd < 31u) ctx.clear_adrp(rd);
        return;
      }
      rec();
      tb->put_str("    ");
      tb->put_reg_x_or_sp(rd);
      tb->put_str(" = ");
      if (!is64) tb->put_str("(uint32_t)(");
      tb->put_reg_x_or_sp(rn);
      tb->put_str(is_sub ? " - " : " + ");
      emit_ext_reg(*tb, rm, option, imm3);
      if (!is64) tb->put_char(')');
      tb->put_str(";\n");
      if (rd < 31u) ctx.clear_adrp(rd);
    }
    return;
  }

  // Logical (shifted register): AND / BIC / ORR (MOV) / ORN (MVN) / EOR / EON / ANDS
  if ((w & 0x1F000000u) == 0x0A000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t opc = (w >> 29u) & 3u;
    const uint32_t shift_type = (w >> 22u) & 3u;
    const bool invert = ((w >> 21u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t imm6 = (w >> 10u) & 0x3Fu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;

    // `mov x29, x29` (ObjC autorelease marker) -> no-op.
    if (opc == 1u && !invert && shift_type == 0u && imm6 == 0u && rn == 31u && rd == 29u && rm == 29u) {
      return;
    }
    if (opc == 3u) {
      cmp = CmpState{true, !is64, false, false, false, false, 0u, 0u, 0ULL, true};
    }
    if (!emit) {
      if (rn < 31u) ctx.mark_gpr_read(rn);
      if (rm < 31u) ctx.mark_gpr_read(rm);
      if (rd < 31u) ctx.mark_gpr_write(rd, is64);
      if (opc == 3u) {
        ctx.uses_nzcv = true;
        ctx.uses_uint32 = true;
        if (is64) ctx.uses_uint64_t = true;
      }
      if (!is64) ctx.uses_uint32 = true;
      if (imm6 != 0u) {
        if (is64) ctx.uses_uint64_t = true;
        if (shift_type == 2u) { if (is64) ctx.uses_int64_t = true; else ctx.uses_int32 = true; }
      }
    } else if (tb && opc == 3u) {
      rec();
      tb->put_str(is64 ? "    { uint64_t __tr = (uint64_t)(" : "    { uint32_t __tr = (uint32_t)(");
      tb->put_reg_x(rn);
      tb->put_str(invert ? " & ~(" : " & (");
      emit_shifted_reg(*tb, rm, shift_type, imm6, is64);
      tb->put_str(is64
          ? ")); __hex_nzcv = ((uint32_t)((__tr >> 63) & 1u) << 3) | ((__tr == 0u) ? 4u : 0u);"
          : ")); __hex_nzcv = (((__tr >> 31) & 1u) << 3) | ((__tr == 0u) ? 4u : 0u);");
      if (rd < 31u) {
        tb->put_char(' ');
        tb->put_reg_x(rd);
        tb->put_str(" = __tr;");
        ctx.clear_adrp(rd);
      }
      tb->put_str(" }\n");
      return;
    } else if (tb && rd < 31u) {
      rec();
      tb->put_str("    ");
      tb->put_reg_x(rd);
      tb->put_str(" = ");
      if (!is64) tb->put_str("(uint32_t)(");
      const bool is_mov = (opc == 1u && !invert && rn == 31u && imm6 == 0u);
      if (is_mov) {
        tb->put_reg_x(rm);
      } else if (opc == 1u && invert && rn == 31u && imm6 == 0u) {
        tb->put_str("~");
        tb->put_reg_x(rm);
      } else {
        tb->put_reg_x(rn);
        tb->put_str(opc == 1u ? " | " : (opc == 2u ? " ^ " : " & "));
        if (invert) tb->put_str("~(");
        emit_shifted_reg(*tb, rm, shift_type, imm6, is64);
        if (invert) tb->put_char(')');
      }
      if (!is64) tb->put_char(')');
      tb->put_str(";\n");
      ctx.clear_adrp(rd);
    }
    return;
  }

  // UBFM / SBFM (LSL / LSR / ASR / SXTW / SXTH / SXTB / UXTB / UXTH)
  if ((w & 0x1F800000u) == 0x13000000u &&
      (((w >> 29u) & 3u) == 0u || ((w >> 29u) & 3u) == 2u) &&
      (((w >> 22u) & 1u) == ((w >> 31u) & 1u))) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t opc = (w >> 29u) & 3u;  // 0=sbfm, 2=ubfm
    const uint32_t immr = (w >> 16u) & 0x3Fu;
    const uint32_t imms = (w >> 10u) & 0x3Fu;
    if (!is64 && (immr >= 32u || imms >= 32u)) return;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t width = is64 ? 64u : 32u;
    if (!emit) {
      ctx.mark_gpr_read(rn);
      if (rd < 31u) ctx.mark_gpr_write(rd, is64);
      ctx.uses_uint32 = true;
      if (opc == 0u) {
        ctx.uses_uint64_t = true;
        ctx.uses_int64_t = true;
        ctx.uses_int32 = true;
        ctx.uses_int16 = true;
        ctx.uses_int8 = true;
      }
    } else if (tb && rd < 31u) {
      rec();
      tb->put_str("    ");
      tb->put_reg_x(rd);
      tb->put_str(" = ");
      if (opc == 0u && is64 && immr == 0u && imms == 31u) {
        // SXTW
        tb->put_str("(uint64)(int64_t)(int32_t)(uint32_t)");
        tb->put_reg_x(rn);
      } else if (opc == 0u && immr == 0u && imms == 7u) {
        tb->put_str(is64 ? "(uint64)(int64_t)(int8_t)" : "(uint32_t)(int32_t)(int8_t)");
        tb->put_reg_x(rn);
      } else if (opc == 0u && immr == 0u && imms == 15u) {
        tb->put_str(is64 ? "(uint64)(int64_t)(int16_t)" : "(uint32_t)(int32_t)(int16_t)");
        tb->put_reg_x(rn);
      } else if (opc == 2u && imms == width - 1u) {
        // LSR
        if (!is64) tb->put_str("((uint32_t)");
        tb->put_reg_x(rn);
        if (!is64) tb->put_char(')');
        tb->put_str(" >> ");
        tb->put_u64_dec(immr);
      } else if (opc == 0u && imms == width - 1u) {
        // ASR
        tb->put_str(is64 ? "(uint64)((int64_t)" : "(uint32_t)((int32_t)");
        tb->put_reg_x(rn);
        tb->put_str(" >> ");
        tb->put_u64_dec(immr);
        tb->put_char(')');
      } else if (opc == 2u && imms + 1u == immr) {
        // LSL
        const uint32_t sh = (width - immr) & (width - 1u);
        if (!is64) tb->put_str("(uint32_t)(");
        tb->put_reg_x(rn);
        tb->put_str(" << ");
        tb->put_u64_dec(sh);
        if (!is64) tb->put_char(')');
      } else if (imms >= immr) {
        // Generic bitfield extract (UBFX / SBFX)
        const uint32_t bits = imms - immr + 1u;
        if (opc == 0u) {
          if (bits >= width) {
            if (!is64) tb->put_str("(uint32_t)");
            tb->put_reg_x(rn);
          } else {
            const uint32_t sh = width - bits;
            tb->put_str(is64 ? "(uint64)(((int64_t)(((uint64_t)" : "(uint32_t)(((int32_t)(((uint32_t)");
            tb->put_reg_x(rn);
            tb->put_str(" >> ");
            tb->put_u64_dec(immr);
            tb->put_str(") << ");
            tb->put_u64_dec(sh);
            tb->put_str(")) >> ");
            tb->put_u64_dec(sh);
            tb->put_char(')');
          }
        } else {
          const uint64_t mask = (bits >= 64u) ? ~0ULL : ((1ULL << bits) - 1ULL);
          if (!is64) tb->put_str("((uint32_t)");
          else tb->put_char('(');
          tb->put_reg_x(rn);
          tb->put_str(" >> ");
          tb->put_u64_dec(immr);
          tb->put_str(") & ");
          tb->put_imm(mask);
        }
      } else {
        // Bitfield insert-at-zero (UBFIZ / SBFIZ)
        const uint32_t bits = imms + 1u;
        if (opc == 0u) {
          const uint32_t sh_l = width - bits;
          const uint32_t sh_r = immr - bits;
          tb->put_str(is64 ? "(uint64)(((int64_t)((uint64_t)" : "(uint32_t)(((int32_t)((uint32_t)");
          tb->put_reg_x(rn);
          tb->put_str(" << ");
          tb->put_u64_dec(sh_l);
          tb->put_str(")) >> ");
          tb->put_u64_dec(sh_r);
          tb->put_char(')');
        } else {
          const uint32_t lshift = (width - immr) & (width - 1u);
          const uint64_t mask = (bits >= 64u) ? ~0ULL : ((1ULL << bits) - 1ULL);
          if (!is64) tb->put_str("(uint32_t)(");
          tb->put_str("((");
          tb->put_reg_x(rn);
          tb->put_str(" & ");
          tb->put_imm(mask);
          tb->put_str(") << ");
          tb->put_u64_dec(lshift);
          tb->put_char(')');
          if (!is64) tb->put_char(')');
        }
      }
      tb->put_str(";\n");
      ctx.clear_adrp(rd);
    }
    return;
  }

  // Conditional Select: CSEL / CSINC (CSET) / CSINV / CSNEG
  if ((w & 0x3FE00800u) == 0x1A800000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool op_neg = ((w >> 30u) & 1u) != 0u;
    const uint32_t op2 = (w >> 10u) & 1u;  // 0=csel/csinv, 1=csinc/csneg
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t cond = (w >> 12u) & 0xFu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_gpr_read(rn);
      ctx.mark_gpr_read(rm);
      if (rd < 31u) ctx.mark_gpr_write(rd, is64);
      if (!is64) ctx.uses_uint32 = true;
      if (cmp.valid && !cmp.is_fp) {
        const bool signed_cmp = (cond == 0xAu || cond == 0xBu || cond == 0xCu || cond == 0xDu);
        if (cmp.is32) {
          if (signed_cmp) ctx.uses_int32 = true;
          else ctx.uses_uint32 = true;
        } else {
          if (signed_cmp) ctx.uses_int64_t = true;
          else ctx.uses_uint64_t = true;
        }
      }
    } else if (tb && rd < 31u) {
      rec();
      tb->put_str("    ");
      tb->put_reg_x(rd);
      tb->put_str(" = ");
      if (!is64) tb->put_str("(uint32_t)(");
      emit_cond_expr(*tb, cond, cmp);
      tb->put_str(" ? ");
      tb->put_reg_x(rn);
      tb->put_str(" : ");
      if (!op_neg && op2 == 0u) {
        tb->put_reg_x(rm);
      } else if (!op_neg && op2 == 1u) {
        tb->put_char('(');
        tb->put_reg_x(rm);
        tb->put_str(" + 1ULL)");
      } else if (op_neg && op2 == 0u) {
        tb->put_str("~");
        tb->put_reg_x(rm);
      } else {
        tb->put_str("-");
        tb->put_reg_x(rm);
      }
      if (!is64) tb->put_char(')');
      tb->put_str(";\n");
      ctx.clear_adrp(rd);
    }
    return;
  }

  // MADD / MSUB / MUL / MNEG
  if ((w & 0x7FE00000u) == 0x1B000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 15u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t ra = (w >> 10u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_gpr_read(rn);
      ctx.mark_gpr_read(rm);
      if (ra < 31u) ctx.mark_gpr_read(ra);
      if (rd < 31u) ctx.mark_gpr_write(rd, is64);
      if (!is64) ctx.uses_uint32 = true;
    } else if (tb && rd < 31u) {
      rec();
      tb->put_str("    ");
      tb->put_reg_x(rd);
      tb->put_str(" = ");
      if (!is64) tb->put_str("(uint32_t)(");
      if (ra < 31u) {
        tb->put_reg_x(ra);
        tb->put_str(is_sub ? " - (" : " + (");
      } else if (is_sub) {
        tb->put_str("-(");
      }
      tb->put_reg_x(rn);
      tb->put_str(" * ");
      tb->put_reg_x(rm);
      if (ra < 31u || is_sub) tb->put_char(')');
      if (!is64) tb->put_char(')');
      tb->put_str(";\n");
      ctx.clear_adrp(rd);
    }
    return;
  }

  // UDIV / SDIV / LSLV / LSRV / ASRV
  if ((w & 0x7FE0C000u) == 0x1AC00000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t op2 = (w >> 10u) & 0x3Fu;
    if (op2 == 2u || op2 == 3u || op2 == 8u || op2 == 9u || op2 == 10u) {
      const uint32_t rm = (w >> 16u) & 31u;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      if (!emit) {
        ctx.mark_gpr_read(rn);
        ctx.mark_gpr_read(rm);
        if (rd < 31u) ctx.mark_gpr_write(rd, is64);
        ctx.uses_uint32 = true;
        ctx.uses_int32 = true;
        ctx.uses_int64_t = true;
      } else if (tb && rd < 31u) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x(rd);
        tb->put_str(" = ");
        if (op2 == 2u || op2 == 3u) {
          // UDIV / SDIV (guard division by zero at exact operand width)
          tb->put_char('(');
          if (!is64) tb->put_str("(uint32_t)");
          tb->put_reg_x(rm);
          tb->put_str(" != 0 ? ");
          if (!is64) tb->put_str("(uint32_t)");
          tb->put_char('(');
          if (op2 == 3u) tb->put_str(is64 ? "(int64_t)" : "(int32_t)");
          else if (!is64) tb->put_str("(uint32_t)");
          tb->put_reg_x(rn);
          tb->put_str(" / ");
          if (op2 == 3u) tb->put_str(is64 ? "(int64_t)" : "(int32_t)");
          else if (!is64) tb->put_str("(uint32_t)");
          tb->put_reg_x(rm);
          tb->put_str(") : 0)");
        } else {
          const char* sop = (op2 == 8u) ? " << " : " >> ";
          const uint32_t smask = is64 ? 63u : 31u;
          if (!is64) tb->put_str("(uint32_t)(");
          if (op2 == 10u) tb->put_str(is64 ? "(uint64)((int64_t)" : "((int32_t)");
          else if (!is64) tb->put_str("((uint32_t)");
          tb->put_reg_x(rn);
          if (!is64) tb->put_char(')');
          tb->put_str(sop);
          tb->put_char('(');
          tb->put_reg_x(rm);
          tb->put_str(" & ");
          tb->put_u64_dec(smask);
          tb->put_char(')');
          if (op2 == 10u && is64) tb->put_char(')');
          if (!is64) tb->put_char(')');
        }
        tb->put_str(";\n");
        ctx.clear_adrp(rd);
      }
      return;
    }
  }

  // LDP / STP (GPR 32/64 and FP/SIMD 32/64/128: signed offset, pre-index, post-index)
  if ((w & 0x3A000000u) == 0x28000000u) {
    const uint32_t opc = (w >> 30u) & 3u;
    const bool is_fp = ((w >> 26u) & 1u) != 0u;
    const uint32_t mode = (w >> 23u) & 3u;  // 1=post, 2=signed-off, 3=pre
    const bool is_load = ((w >> 22u) & 1u) != 0u;
    const int64_t imm7 = sign_extend((w >> 15u) & 0x7Fu, 7u);
    const uint32_t rt2 = (w >> 10u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rt = w & 31u;

    uint32_t scale = 4u;
    uint32_t bits = 32u;
    bool is_ldpsw = false;
    bool valid_pair = true;
    if (is_fp) {
      if (opc == 0u) { scale = 4u; bits = 32u; }
      else if (opc == 1u) { scale = 8u; bits = 64u; }
      else if (opc == 2u) { scale = 16u; bits = 128u; }
      else valid_pair = false;
    } else {
      if (opc == 2u) { scale = 8u; bits = 64u; }
      else if (opc == 0u) { scale = 4u; bits = 32u; }
      else if (opc == 1u && is_load) { scale = 4u; bits = 32u; is_ldpsw = true; }
      else valid_pair = false;
    }

    if (valid_pair) {
    const int64_t disp = imm7 * static_cast<int64_t>(scale);
    if (!emit) {
      mark_mem_types(ctx, bits, is_ldpsw, is_fp);
      if (is_ldpsw) ctx.uses_int64_t = true;
      if (rn == 31u) ctx.uses_sp = true;
      else {
        ctx.mark_gpr_read(rn);
        if (mode == 1u || mode == 3u) ctx.mark_gpr_write(rn);
      }
      if (is_fp) {
        if (bits == 128u) { ctx.mark_q(rt); ctx.mark_q(rt2); }
        else if (is_load) { ctx.mark_fp_write(rt); ctx.mark_fp_write(rt2); }
        else { ctx.mark_fp_read(rt); ctx.mark_fp_read(rt2); }
      } else {
        if (is_load) { const bool ldp64 = (opc >= 2u || is_ldpsw); ctx.mark_gpr_write(rt, ldp64); ctx.mark_gpr_write(rt2, ldp64); }
        else { ctx.mark_gpr_read(rt); ctx.mark_gpr_read(rt2); }
      }
    } else if (tb) {
      if (mode == 3u && disp != 0) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(" = ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(disp > 0 ? " + " : " - ");
        tb->put_imm(disp > 0 ? static_cast<uint64_t>(disp) : static_cast<uint64_t>(-disp));
        tb->put_str(";\n");
      }
      const int64_t eff0 = (mode == 0u || mode == 2u) ? disp : 0;
      const int64_t eff1 = eff0 + static_cast<int64_t>(scale);
      auto emit_one = [&](uint32_t reg, int64_t off) {
        if (!is_fp && is_load && reg == 31u) return;
        rec();
        tb->put_str("    ");
        if (is_load) {
          if (is_fp) {
            if (bits == 128u) tb->put_reg_q(reg);
            else tb->put_reg_d(reg);
          } else {
            tb->put_reg_x(reg);
          }
          tb->put_str(is_ldpsw ? " = (uint64)(int64_t)" : " = ");
          emit_mem_load_type(*tb, bits, is_ldpsw, is_fp);
          emit_mem_addr(*tb, rn, off);
          tb->put_str(");\n");
        } else {
          emit_mem_load_type(*tb, bits, false, is_fp);
          emit_mem_addr(*tb, rn, off);
          tb->put_str(") = ");
          if (is_fp) {
            if (bits == 128u) tb->put_reg_q(reg);
            else if (bits == 32u) { tb->put_str("(float)"); tb->put_reg_d(reg); }
            else tb->put_reg_d(reg);
          } else {
            if (bits == 32u) tb->put_str("(uint32_t)");
            tb->put_reg_x(reg);
          }
          tb->put_str(";\n");
        }
      };
      if (is_load && !is_fp && rt == rn && rt2 != rn) {
        emit_one(rt2, eff1);
        emit_one(rt, eff0);
      } else {
        emit_one(rt, eff0);
        emit_one(rt2, eff1);
      }
      if (!is_fp && is_load) {
        if (rt < 31u) ctx.clear_adrp(rt);
        if (rt2 < 31u) ctx.clear_adrp(rt2);
      }
      if ((mode == 1u || mode == 3u) && rn < 31u) ctx.clear_adrp(rn);
      if (mode == 1u && disp != 0) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(" = ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(disp > 0 ? " + " : " - ");
        tb->put_imm(disp > 0 ? static_cast<uint64_t>(disp) : static_cast<uint64_t>(-disp));
        tb->put_str(";\n");
      }
    }
    return;
    }
  }

  // LDR / STR (unsigned offset, unscaled LDUR/STUR, pre/post-index, register offset)
  if ((w & 0x3B000000u) == 0x39000000u || (w & 0x3B200000u) == 0x38000000u || (w & 0x3B200C00u) == 0x38200800u) {
    const uint32_t size_f = (w >> 30u) & 3u;
    const bool is_fp = ((w >> 26u) & 1u) != 0u;
    const uint32_t opc = (w >> 22u) & 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rt = w & 31u;

    bool is_load = false;
    bool is_signed = false;
    uint32_t bits = 64u;
    uint32_t scale = 8u;
    bool valid_ldst = true;
    if (is_fp) {
      if (size_f == 0u && (opc & 2u) != 0u) { bits = 128u; scale = 16u; is_load = (opc & 1u) != 0u; }
      else if (size_f == 0u && (opc & 2u) == 0u) { bits = 8u; scale = 1u; is_load = (opc & 1u) != 0u; }
      else if (size_f == 1u && (opc & 2u) == 0u) { bits = 16u; scale = 2u; is_load = (opc & 1u) != 0u; }
      else if (size_f == 2u && (opc & 2u) == 0u) { bits = 32u; scale = 4u; is_load = (opc & 1u) != 0u; }
      else if (size_f == 3u && (opc & 2u) == 0u) { bits = 64u; scale = 8u; is_load = (opc & 1u) != 0u; }
      else valid_ldst = false;
    } else {
      // PRFM (prefetch memory): size=3, opc=2 -> hardware hint, does not write rt.
      if (size_f == 3u && opc == 2u) return;
      is_load = (opc != 0u);
      is_signed = (opc >= 2u);
      bits = 8u << size_f;
      scale = 1u << size_f;
    }
    if (valid_ldst) {

    const bool is_uoff = ((w & 0x3B000000u) == 0x39000000u);
    const bool is_regoff = (!is_uoff && (w & 0x3B200C00u) == 0x38200800u);
    const uint32_t idx_mode = (!is_uoff && !is_regoff) ? ((w >> 10u) & 3u) : 0u;  // 0=unscaled, 1=post, 3=pre
    const int64_t disp = is_uoff
        ? static_cast<int64_t>(((w >> 10u) & 0xFFFu) * scale)
        : (is_regoff ? 0LL : sign_extend((w >> 12u) & 0x1FFu, 9u));
    const uint32_t rm = (w >> 16u) & 31u;
    const bool rm_scaled = is_regoff && (((w >> 12u) & 1u) != 0u);

    // ADRP + LDR/STR global access
    if (is_uoff && rn < 31u && ctx.adrp_valid[rn]) {
      const uint64_t gaddr = ctx.adrp_page[rn] + static_cast<uint64_t>(disp);
      if (!emit) {
        ctx.add_global(gaddr, is_fp && bits == 128u);
        if (is_fp) {
          if (bits == 128u) { ctx.mark_q(rt); ctx.uses_uintptr = true; }
          else if (bits == 8u || bits == 16u) {
            ctx.mark_q(rt);
            if (bits == 8u) ctx.uses_uint8 = true;
            else ctx.uses_uint16 = true;
          } else if (is_load) {
            ctx.mark_fp_write(rt);
            ctx.uses_fp_bitcast = true;
            ctx.uses_uint32 = true;
            ctx.uses_uint64_t = true;
            if (bits == 32u) ctx.fp_single_mask |= (1u << rt);
            else if (bits == 64u) ctx.fp_double_mask |= (1u << rt);
          } else {
            ctx.mark_fp_read(rt);
            ctx.uses_fp_bitcast = true;
            ctx.uses_uint32 = true;
            ctx.uses_uint64_t = true;
          }
        } else {
          if (is_load) {
            ctx.mark_gpr_write(rt, (size_f == 3u) || (opc == 2u));
            if (bits < 64u) {
              mark_mem_types(ctx, bits, is_signed, false);
              if (is_signed) {
                if (opc == 2u) ctx.uses_int64_t = true;
                else { ctx.uses_int32 = true; ctx.uses_uint32 = true; }
              }
            }
          } else ctx.mark_gpr_read(rt);
        }
      } else if (tb) {
        rec();
        tb->put_str("    ");
        if (is_load) {
          if (!is_fp && rt == 31u) {
            tb->put_str("(void)global_");
            tb->put_u64_hex(gaddr, true);
            tb->put_str(";\n");
          } else {
            if (is_fp && (bits == 8u || bits == 16u)) {
              tb->put_reg_q(rt);
              tb->put_str(bits == 8u ? " = (uint128)(uint8_t)global_" : " = (uint128)(uint16_t)global_");
              tb->put_u64_hex(gaddr, true);
              tb->put_str(";\n");
              emit_sync_q_to_d(tb, ctx, rt, false);
            } else if (is_fp && bits != 128u) {
              tb->put_reg_d(rt);
              if (bits == 32u) {
                tb->put_str(" = (double)__hex_u32_to_f32((uint32_t)global_");
                tb->put_u64_hex(gaddr, true);
                tb->put_str(");\n");
              } else {
                tb->put_str(" = __hex_u64_to_f64(global_");
                tb->put_u64_hex(gaddr, true);
                tb->put_str(");\n");
              }
              emit_sync_d_to_q(tb, ctx, rt, bits == 64u);
            } else if (is_fp) {
              tb->put_reg_q(rt);
              tb->put_str(" = *(uint128 *)((uintptr_t)(&global_");
              tb->put_u64_hex(gaddr, true);
              tb->put_str("));\n");
              emit_sync_q_to_d(tb, ctx, rt);
            } else {
              tb->put_reg_x(rt);
              tb->put_str(" = ");
              if (bits == 8u) {
                tb->put_str(is_signed ? ((opc == 2u) ? "(uint64)(int64_t)(int8_t)" : "(uint32_t)(int32_t)(int8_t)") : "(uint8_t)");
              } else if (bits == 16u) {
                tb->put_str(is_signed ? ((opc == 2u) ? "(uint64)(int64_t)(int16_t)" : "(uint32_t)(int32_t)(int16_t)") : "(uint16_t)");
              } else if (bits == 32u) {
                tb->put_str(is_signed ? "(uint64)(int64_t)(int32_t)" : "(uint32_t)");
              }
              tb->put_str("global_");
              tb->put_u64_hex(gaddr, true);
              tb->put_str(";\n");
            }
            if (!is_fp && rt < 31u) ctx.clear_adrp(rt);
          }
        } else {
          if (is_fp && bits == 128u) {
            tb->put_str("*(uint128 *)((uintptr_t)(&global_");
            tb->put_u64_hex(gaddr, true);
            tb->put_str(")) = ");
            tb->put_reg_q(rt);
            tb->put_str(";\n");
          } else if (is_fp && (bits == 8u || bits == 16u)) {
            tb->put_str("global_");
            tb->put_u64_hex(gaddr, true);
            tb->put_str(bits == 8u ? " = (uint8_t)" : " = (uint16_t)");
            tb->put_reg_q(rt);
            tb->put_str(";\n");
          } else if (is_fp) {
            tb->put_str("global_");
            tb->put_u64_hex(gaddr, true);
            if (bits == 32u) {
              tb->put_str(" = (uint64)__hex_f32_to_u32((float)");
              tb->put_reg_d(rt);
              tb->put_str(");\n");
            } else {
              tb->put_str(" = __hex_f64_to_u64(");
              tb->put_reg_d(rt);
              tb->put_str(");\n");
            }
          } else {
            tb->put_str("global_");
            tb->put_u64_hex(gaddr, true);
            tb->put_str(" = ");
            tb->put_reg_x(rt);
            tb->put_str(";\n");
          }
        }
      }
      return;
    }

    const bool is_fp_bh = is_fp && (bits == 8u || bits == 16u);
    if (!emit) {
      mark_mem_types(ctx, bits, is_signed, is_fp_bh ? false : is_fp);
      if (rn == 31u) ctx.uses_sp = true;
      else {
        ctx.mark_gpr_read(rn);
        if (idx_mode == 1u || idx_mode == 3u) ctx.mark_gpr_write(rn);
      }
      if (is_regoff) ctx.mark_gpr_read(rm);
      if (is_fp) {
        if (bits == 128u || is_fp_bh) ctx.mark_q(rt);
        else if (is_load) ctx.mark_fp_write(rt);
        else ctx.mark_fp_read(rt);
      } else {
        if (is_load) ctx.mark_gpr_write(rt, (((w >> 30u) & 3u) == 3u) || (((w >> 22u) & 3u) == 2u));
        else ctx.mark_gpr_read(rt);
      }
    } else if (tb) {
      if (idx_mode == 3u && disp != 0) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(" = ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(disp > 0 ? " + " : " - ");
        tb->put_imm(disp > 0 ? static_cast<uint64_t>(disp) : static_cast<uint64_t>(-disp));
        tb->put_str(";\n");
      }
      if (!is_fp && is_load && rt == 31u) {
        // Discard load to XZR.
      } else {
        rec();
        tb->put_str("    ");
        const bool raw_q_sub = is_fp_bh || (is_fp && (bits == 32u || bits == 64u) && ((ctx.q_used & (1u << rt)) != 0u));
        if (is_load) {
          if (is_fp) {
            if (bits == 128u || raw_q_sub) tb->put_reg_q(rt);
            else tb->put_reg_d(rt);
          } else {
            tb->put_reg_x(rt);
          }
          tb->put_str(raw_q_sub ? " = (uint128)(" : " = ");
          emit_mem_load_type(*tb, bits, raw_q_sub ? false : is_signed, raw_q_sub ? false : is_fp);
          if (is_regoff) {
            tb->put_str("(uintptr_t)(");
            tb->put_reg_x_or_sp(rn);
            tb->put_str(") + ");
            if (rm_scaled && scale > 1u) {
              tb->put_char('(');
              tb->put_reg_x(rm);
              tb->put_str(" * ");
              tb->put_u64_dec(scale);
              tb->put_char(')');
            } else {
              tb->put_reg_x(rm);
            }
          } else {
            emit_mem_addr(*tb, rn, (idx_mode == 1u || idx_mode == 3u) ? 0LL : disp);
          }
          tb->put_str(raw_q_sub ? "));\n" : ");\n");
          if (is_fp) {
            if (bits == 128u || raw_q_sub) emit_sync_q_to_d(tb, ctx, rt, bits == 64u);
            else emit_sync_d_to_q(tb, ctx, rt, bits == 64u);
          } else if (rt < 31u) {
            ctx.clear_adrp(rt);
          }
        } else {
          emit_mem_load_type(*tb, bits, false, raw_q_sub ? false : is_fp);
          if (is_regoff) {
            tb->put_str("(uintptr_t)(");
            tb->put_reg_x_or_sp(rn);
            tb->put_str(") + ");
            if (rm_scaled && scale > 1u) {
              tb->put_char('(');
              tb->put_reg_x(rm);
              tb->put_str(" * ");
              tb->put_u64_dec(scale);
              tb->put_char(')');
            } else {
              tb->put_reg_x(rm);
            }
          } else {
            emit_mem_addr(*tb, rn, (idx_mode == 1u || idx_mode == 3u) ? 0LL : disp);
          }
          tb->put_str(") = ");
          if (is_fp) {
            if (bits == 128u) tb->put_reg_q(rt);
            else if (raw_q_sub) {
              if (bits == 8u) tb->put_str("(uint8_t)");
              else if (bits == 16u) tb->put_str("(uint16_t)");
              else if (bits == 32u) tb->put_str("(uint32_t)");
              else tb->put_str("(uint64_t)");
              tb->put_reg_q(rt);
            } else {
              if (bits == 32u) tb->put_str("(float)");
              tb->put_reg_d(rt);
            }
          } else {
            if (bits == 8u) tb->put_str("(uint8_t)");
            else if (bits == 16u) tb->put_str("(uint16_t)");
            else if (bits == 32u) tb->put_str("(uint32_t)");
            tb->put_reg_x(rt);
          }
          tb->put_str(";\n");
        }
      }
      if ((idx_mode == 1u || idx_mode == 3u) && rn < 31u) ctx.clear_adrp(rn);
      if (idx_mode == 1u && disp != 0) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(" = ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(disp > 0 ? " + " : " - ");
        tb->put_imm(disp > 0 ? static_cast<uint64_t>(disp) : static_cast<uint64_t>(-disp));
        tb->put_str(";\n");
      }
    }
    return;
    }
  }

  // Load/Store Exclusive & Acquire/Release: LDXR / STXR / LDAXR / STLXR / LDAR / STLR
  // Exclude ARMv8.1 CAS/CASA/CASL/CASAL (bit 23 == 1 && bit 21 == 1).
  if ((w & 0x3F000000u) == 0x08000000u && !(((w >> 23u) & 1u) != 0u && ((w >> 21u) & 1u) != 0u)) {
    const uint32_t size_f = (w >> 30u) & 3u;
    const bool is_load = ((w >> 22u) & 1u) != 0u;
    const bool is_ordered_only = ((w >> 23u) & 1u) != 0u;  // ldar/stlr
    const uint32_t rs = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rt = w & 31u;
    const uint32_t bits = 8u << size_f;

    // ADRP + STLR / LDAR global
    if (is_ordered_only && rn < 31u && ctx.adrp_valid[rn]) {
      const uint64_t gaddr = ctx.adrp_page[rn];
      if (!emit) {
        ctx.add_global(gaddr, false);
        if (is_load) ctx.mark_gpr_write(rt, (((w >> 30u) & 3u) == 3u) || (((w >> 22u) & 3u) == 2u));
        else ctx.mark_gpr_read(rt);
      } else if (tb) {
        rec();
        tb->put_str("    ");
        if (is_load) {
          if (rt == 31u) {
            tb->put_str("(void)global_");
            tb->put_u64_hex(gaddr, true);
            tb->put_str(";\n");
          } else {
            tb->put_reg_x(rt);
            tb->put_str(" = global_");
            tb->put_u64_hex(gaddr, true);
            tb->put_str(";\n");
            ctx.clear_adrp(rt);
          }
        } else {
          tb->put_str("global_");
          tb->put_u64_hex(gaddr, true);
          tb->put_str(" = ");
          tb->put_reg_x(rt);
          tb->put_str(";\n");
        }
      }
      return;
    }

    if (!emit) {
      mark_mem_types(ctx, bits, false, false);
      if (rn == 31u) ctx.uses_sp = true;
      else ctx.mark_gpr_read(rn);
      if (is_load) {
        ctx.mark_gpr_write(rt);
      } else {
        ctx.mark_gpr_read(rt);
        if (!is_ordered_only && rs < 31u) ctx.mark_gpr_write(rs);
      }
    } else if (tb) {
      if (is_load) {
        if (rt < 31u) {
          rec();
          tb->put_str("    ");
          tb->put_reg_x(rt);
          tb->put_str(" = ");
          emit_mem_load_type(*tb, bits, false, false);
          emit_mem_addr(*tb, rn, 0LL);
          tb->put_str(");\n");
          ctx.clear_adrp(rt);
        }
      } else {
        rec();
        tb->put_str("    ");
        emit_mem_load_type(*tb, bits, false, false);
        emit_mem_addr(*tb, rn, 0LL);
        tb->put_str(") = ");
        if (bits == 8u) tb->put_str("(uint8_t)");
        else if (bits == 16u) tb->put_str("(uint16_t)");
        else if (bits == 32u) tb->put_str("(uint32_t)");
        tb->put_reg_x(rt);
        tb->put_str(";\n");
        if (!is_ordered_only && rs < 31u) {
          rec();
          tb->put_str("    ");
          tb->put_reg_x(rs);
          tb->put_str(" = 0;\n");
          ctx.clear_adrp(rs);
        }
      }
    }
    return;
  }

  // FMOV (immediate): sf=0, 00 11110 ftype(2) 1 imm8(8) 100 00000 Rd(5)
  if ((w & 0xFF201FE0u) == 0x1E201000u) {
    const uint32_t ftype = (w >> 22u) & 3u;
    const uint32_t imm8 = (w >> 13u) & 0xFFu;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_fp_write(rd);
      if (ftype == 0u) ctx.fp_single_mask |= (1u << rd);
      else if (ftype == 1u) ctx.fp_double_mask |= (1u << rd);
    } else if (tb) {
      rec();
      tb->put_str("    ");
      tb->put_reg_d(rd);
      tb->put_str(" = ");
      tb->put_fmov_imm(decode_fmov_imm8(imm8));
      tb->put_str(";\n");
      emit_sync_d_to_q(tb, ctx, rd, ftype == 1u);
    }
    return;
  }

  // FP Data-Processing (1-source): FMOV / FABS / FNEG / FSQRT / FCVT / FRINT*
  if ((w & 0x5F207C00u) == 0x1E204000u) {
    const uint32_t ftype = (w >> 22u) & 3u;
    const uint32_t opcode = (w >> 15u) & 0x3Fu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      const int fw = ftype == 0u ? 1 : (ftype == 1u ? 2 : 0);
      ctx.mark_fp_read(rn, fw);
      ctx.mark_fp_write(rd);
      if (opcode == 3u || (opcode >= 8u && opcode <= 15u)) {
        ctx.uses_math = true;
      }
      if (opcode == 4u) {
        ctx.fp_single_mask |= (1u << rd);
      } else if (opcode == 5u) {
        ctx.fp_double_mask |= (1u << rd);
      } else {
        if (ftype == 0u) ctx.fp_single_mask |= (1u << rd);
        else if (ftype == 1u) ctx.fp_double_mask |= (1u << rd);
      }
    } else if (tb) {
      rec();
      tb->put_str("    ");
      tb->put_reg_d(rd);
      tb->put_str(" = ");
      if (opcode == 2u) {
        tb->put_str("-");
        tb->put_reg_d(rn);
      } else if (opcode == 1u) {
        tb->put_str("(");
        tb->put_reg_d(rn);
        tb->put_str(" < 0.0 ? -");
        tb->put_reg_d(rn);
        tb->put_str(" : ");
        tb->put_reg_d(rn);
        tb->put_str(")");
      } else if (opcode == 3u) {
        tb->put_str("sqrt(");
        tb->put_reg_d(rn);
        tb->put_str(")");
      } else if (opcode == 9u) {
        tb->put_str("ceil(");
        tb->put_reg_d(rn);
        tb->put_str(")");
      } else if (opcode == 10u) {
        tb->put_str("floor(");
        tb->put_reg_d(rn);
        tb->put_str(")");
      } else if (opcode == 11u) {
        tb->put_str("trunc(");
        tb->put_reg_d(rn);
        tb->put_str(")");
      } else if (opcode == 8u || opcode == 14u || opcode == 15u) {
        tb->put_str("rint(");
        tb->put_reg_d(rn);
        tb->put_str(")");
      } else if (opcode == 12u) {
        tb->put_str("round(");
        tb->put_reg_d(rn);
        tb->put_str(")");
      } else if (opcode == 4u) {
        tb->put_str("(double)(float)");
        tb->put_reg_d(rn);
      } else {
        tb->put_reg_d(rn);
      }
      tb->put_str(";\n");
      const bool dst_is_double = (opcode == 5u) || (opcode != 4u && ftype == 1u);
      emit_sync_d_to_q(tb, ctx, rd, dst_is_double);
    }
    return;
  }

  // FP Data-Processing (2-source): FMUL / FDIV / FADD / FSUB / FMAX / FMIN / FMAXNM / FMINNM / FNMUL
  if ((w & 0x5F200C00u) == 0x1E200800u) {
    const uint32_t opcode = (w >> 12u) & 0xFu;
    if (opcode <= 8u) {
      const uint32_t rm = (w >> 16u) & 31u;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      if (!emit) {
        const uint32_t ftype = (w >> 22u) & 3u;
        const int fw = ftype == 0u ? 1 : (ftype == 1u ? 2 : 0);
        ctx.mark_fp_read(rn, fw);
        ctx.mark_fp_read(rm, fw);
        ctx.mark_fp_write(rd);
        const uint32_t mask = (1u << rn) | (1u << rm) | (1u << rd);
        if (ftype == 0u) ctx.fp_single_mask |= mask;
        else if (ftype == 1u) ctx.fp_double_mask |= mask;
      } else if (tb) {
        rec();
        tb->put_str("    ");
        tb->put_reg_d(rd);
        tb->put_str(" = ");
        if (opcode <= 3u) {
          const char* fop = (opcode == 0u) ? " * " : ((opcode == 1u) ? " / " : ((opcode == 2u) ? " + " : " - "));
          tb->put_reg_d(rn);
          tb->put_str(fop);
          tb->put_reg_d(rm);
        } else if (opcode == 4u || opcode == 6u) {
          tb->put_char('(');
          tb->put_reg_d(rn);
          tb->put_str(" > ");
          tb->put_reg_d(rm);
          tb->put_str(" ? ");
          tb->put_reg_d(rn);
          tb->put_str(" : ");
          tb->put_reg_d(rm);
          tb->put_char(')');
        } else if (opcode == 5u || opcode == 7u) {
          tb->put_char('(');
          tb->put_reg_d(rn);
          tb->put_str(" < ");
          tb->put_reg_d(rm);
          tb->put_str(" ? ");
          tb->put_reg_d(rn);
          tb->put_str(" : ");
          tb->put_reg_d(rm);
          tb->put_char(')');
        } else {
          tb->put_str("-(");
          tb->put_reg_d(rn);
          tb->put_str(" * ");
          tb->put_reg_d(rm);
          tb->put_char(')');
        }
        tb->put_str(";\n");
        emit_sync_d_to_q(tb, ctx, rd, ((w >> 22u) & 3u) == 1u);
      }
      return;
    }
  }

  // FCMP (reg or #0.0)
  if ((w & 0x5F203C00u) == 0x1E202000u) {
    const uint32_t ftype = (w >> 22u) & 3u;
    const bool is_zero = ((w >> 3u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    cmp = CmpState{true, false, false, false, false, false, 0u, 0u, 0ULL, true};
    if (!emit) {
      ctx.uses_nzcv = true;
      ctx.uses_uint32 = true;
      const int fw = ftype == 0u ? 1 : (ftype == 1u ? 2 : 0);
      ctx.mark_fp_read(rn, fw);
      if (rn == 0u || (!is_zero && rm == 0u)) ctx.d0_compared = true;
      if (ftype == 0u) ctx.fp_single_mask |= (1u << rn);
      else if (ftype == 1u) ctx.fp_double_mask |= (1u << rn);
      if (!is_zero) {
        ctx.mark_fp_read(rm, fw);
        if (ftype == 0u) ctx.fp_single_mask |= (1u << rm);
        else if (ftype == 1u) ctx.fp_double_mask |= (1u << rm);
      }
    } else if (tb) {
      rec();
      tb->put_str("    { double __fa = ");
      tb->put_reg_d(rn);
      tb->put_str(", __fb = ");
      if (is_zero) tb->put_str("0.0");
      else tb->put_reg_d(rm);
      tb->put_str("; __hex_nzcv = (__fa == __fb) ? 6u : ((__fa < __fb) ? 8u : ((__fa > __fb) ? 2u : 3u)); }\n");
    }
    return;
  }

  // Conversion between FP and Integer: FCVT* / SCVTF / UCVTF / FMOV (gpr<->fp)
  if ((w & 0x5F20FC00u) == 0x1E200000u) {
    const bool is64_int = ((w >> 31u) & 1u) != 0u;
    const uint32_t rmode = (w >> 19u) & 3u;
    const uint32_t opcode = (w >> 16u) & 7u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t ftype = (w >> 22u) & 3u;
    const bool to_int = (opcode == 0u || opcode == 1u || opcode == 4u || opcode == 5u);
    if (opcode == 6u) {
      // FMOV Wd/Xd, Sn/Dn or FMOV Xd, Vn.D[1] (ftype==2)
      if (!emit) {
        if (ftype == 2u) {
          ctx.mark_q(rn);
          if (rd < 31u) ctx.mark_gpr_write(rd, true);
          ctx.uses_uint64_t = true;
        } else {
          ctx.mark_fp_read(rn);
          if (rd < 31u) ctx.mark_gpr_write(rd, ftype == 1u);
          ctx.uses_fp_bitcast = true;
          ctx.uses_uint32 = true;
          ctx.uses_uint64_t = true;
          if (ftype == 0u) ctx.fp_single_mask |= (1u << rn);
          else if (ftype == 1u) ctx.fp_double_mask |= (1u << rn);
        }
      } else if (tb && rd < 31u) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x(rd);
        if (ftype == 2u) {
          tb->put_str(" = (uint64_t)(");
          tb->put_reg_q(rn);
          tb->put_str(" >> 64);\n");
        } else if ((ctx.q_used & (1u << rn)) != 0u) {
          tb->put_str(ftype == 0u ? " = (uint64)(uint32_t)" : " = (uint64_t)");
          tb->put_reg_q(rn);
          tb->put_str(";\n");
        } else {
          tb->put_str(ftype == 0u ? " = (uint64)__hex_f32_to_u32((float)" : " = __hex_f64_to_u64(");
          tb->put_reg_d(rn);
          tb->put_str(");\n");
        }
        ctx.clear_adrp(rd);
      }
    } else if (opcode == 7u) {
      // FMOV Sd/Dd, Wn/Xn or FMOV Vd.D[1], Xn (ftype==2)
      if (!emit) {
        ctx.mark_gpr_read(rn);
        if (ftype == 2u) {
          ctx.mark_q(rd);
          ctx.uses_uint64_t = true;
        } else {
          ctx.mark_fp_write(rd);
          ctx.uses_fp_bitcast = true;
          ctx.uses_uint32 = true;
          ctx.uses_uint64_t = true;
          if (ftype == 0u) ctx.fp_single_mask |= (1u << rd);
          else if (ftype == 1u) ctx.fp_double_mask |= (1u << rd);
        }
      } else if (tb) {
        rec();
        tb->put_str("    ");
        if (ftype == 2u) {
          tb->put_reg_q(rd);
          tb->put_str(" = (");
          tb->put_reg_q(rd);
          tb->put_str(" & (uint128)0xFFFFFFFFFFFFFFFFULL) | ((uint128)(uint64_t)");
          tb->put_reg_x(rn);
          tb->put_str(" << 64);\n");
        } else {
          tb->put_reg_d(rd);
          tb->put_str(ftype == 0u ? " = (double)__hex_u32_to_f32((uint32_t)" : " = __hex_u64_to_f64((uint64_t)");
          tb->put_reg_x(rn);
          tb->put_str(");\n");
          if ((ctx.q_used & (1u << rd)) != 0u) {
            tb->put_str("    ");
            tb->put_reg_q(rd);
            tb->put_str(ftype == 0u ? " = (uint128)(uint32_t)" : " = (uint128)(uint64_t)");
            tb->put_reg_x(rn);
            tb->put_str(";\n");
          }
        }
      }
    } else if (to_int) {
      if (!emit) {
        ctx.mark_fp_read(rn);
        if (rd < 31u) ctx.mark_gpr_write(rd, is64_int);
        ctx.uses_int64_t = true;
        ctx.uses_uint32 = true;
        if (rmode != 3u || opcode == 4u || opcode == 5u) ctx.uses_math = true;
      } else if (tb && rd < 31u) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x(rd);
        const bool is_unsigned_cvt = (opcode == 1u || opcode == 5u);
        if (is64_int) {
          tb->put_str(is_unsigned_cvt ? " = (uint64)" : " = (uint64)(int64_t)");
        } else {
          tb->put_str(is_unsigned_cvt ? " = (uint32_t)" : " = (uint32_t)(int64_t)");
        }
        if (rmode == 1u && opcode < 4u) {
          tb->put_str("ceil(");
          tb->put_reg_d(rn);
          tb->put_str(")");
        } else if (rmode == 2u && opcode < 4u) {
          tb->put_str("floor(");
          tb->put_reg_d(rn);
          tb->put_str(")");
        } else if (rmode == 0u && opcode < 4u) {
          tb->put_str("rint(");
          tb->put_reg_d(rn);
          tb->put_str(")");
        } else if (opcode == 4u || opcode == 5u) {
          tb->put_str("round(");
          tb->put_reg_d(rn);
          tb->put_str(")");
        } else {
          tb->put_reg_d(rn);
        }
        tb->put_str(";\n");
        ctx.clear_adrp(rd);
      }
    } else if (opcode == 2u || opcode == 3u) {
      if (!emit) {
        ctx.mark_gpr_read(rn);
        ctx.mark_fp_write(rd);
        if (opcode == 2u) { ctx.uses_int64_t = true; ctx.uses_int32 = true; }
        if (opcode == 3u) { ctx.uses_uint64_t = true; ctx.uses_uint32 = true; }
        if (ftype == 0u) ctx.fp_single_mask |= (1u << rd);
        else if (ftype == 1u) ctx.fp_double_mask |= (1u << rd);
      } else if (tb) {
        rec();
        tb->put_str("    ");
        tb->put_reg_d(rd);
        if (opcode == 2u) {
          tb->put_str(is64_int ? " = (double)(int64_t)" : " = (double)(int32_t)");
        } else {
          tb->put_str(is64_int ? " = (double)(uint64_t)" : " = (double)(uint32_t)");
        }
        tb->put_reg_x(rn);
        tb->put_str(";\n");
        emit_sync_d_to_q(tb, ctx, rd, ftype == 1u);
      }
    } else {
      (void)rmode;
    }
    return;
  }

  // SMULL / UMULL / SMADDL / UMADDL / SMSUBL / UMSUBL (32x32->64)
  if ((w & 0xFFE00000u) == 0x9B200000u || (w & 0xFFE00000u) == 0x9BA00000u) {
    const bool is_unsigned = ((w >> 23u) & 1u) != 0u;
    const bool is_sub = ((w >> 15u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t ra = (w >> 10u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_gpr_read(rn);
      ctx.mark_gpr_read(rm);
      if (ra < 31u) ctx.mark_gpr_read(ra);
      if (rd < 31u) ctx.mark_gpr_write(rd);
      if (is_unsigned) { ctx.uses_uint64_t = true; ctx.uses_uint32 = true; }
      else { ctx.uses_int64_t = true; ctx.uses_int32 = true; }
    } else if (tb && rd < 31u) {
      rec();
      tb->put_str("    ");
      tb->put_reg_x(rd);
      tb->put_str(" = ");
      if (ra < 31u) {
        tb->put_reg_x(ra);
        tb->put_str(is_sub ? " - " : " + ");
      } else if (is_sub) {
        tb->put_str("-");
      }
      if (is_unsigned) {
        tb->put_str("((uint64_t)(uint32_t)");
        tb->put_reg_x(rn);
        tb->put_str(" * (uint64_t)(uint32_t)");
        tb->put_reg_x(rm);
        tb->put_str(")");
      } else {
        tb->put_str("(uint64)((int64_t)(int32_t)");
        tb->put_reg_x(rn);
        tb->put_str(" * (int64_t)(int32_t)");
        tb->put_reg_x(rm);
        tb->put_str(")");
      }
      tb->put_str(";\n");
      ctx.clear_adrp(rd);
    }
    return;
  }

  // CCMP / CCMN (register & immediate)
  if ((w & 0x3FE00410u) == 0x3A400000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;  // 1=CCMP, 0=CCMN
    const bool is_imm = ((w >> 11u) & 1u) != 0u;
    const uint32_t rm_or_imm = (w >> 16u) & 31u;
    const uint32_t cond = (w >> 12u) & 15u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t nzcv_imm = w & 15u;
    if (!emit) {
      ctx.uses_nzcv = true;
      ctx.uses_uint32 = true;
      ctx.uses_int32 = true;
      ctx.uses_uint64_t = true;
      ctx.uses_int64_t = true;
      ctx.mark_gpr_read(rn);
      if (!is_imm) ctx.mark_gpr_read(rm_or_imm);
    } else if (tb) {
      rec();
      tb->put_str("    if (");
      emit_cond_expr(*tb, cond, cmp);
      tb->put_str(") { ");
      if (is64) {
        tb->put_str("uint64_t __ca = (uint64_t)");
        tb->put_reg_x(rn);
        tb->put_str(", __cb = (uint64_t)");
        if (is_imm) tb->put_u64_dec(rm_or_imm);
        else tb->put_reg_x(rm_or_imm);
        if (is_sub) {
          tb->put_str("; uint64_t __cr = __ca - __cb; __hex_nzcv = ((uint32_t)((__cr >> 63) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | ((__ca >= __cb) ? 2u : 0u) | ((uint32_t)((((__ca ^ __cb) & (__ca ^ __cr)) >> 63) & 1u));");
        } else {
          tb->put_str("; uint64_t __cr = __ca + __cb; __hex_nzcv = ((uint32_t)((__cr >> 63) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | ((__cr < __ca) ? 2u : 0u) | ((uint32_t)(((~(__ca ^ __cb) & (__ca ^ __cr)) >> 63) & 1u));");
        }
      } else {
        tb->put_str("uint32_t __ca = (uint32_t)");
        tb->put_reg_x(rn);
        tb->put_str(", __cb = (uint32_t)");
        if (is_imm) tb->put_u64_dec(rm_or_imm);
        else tb->put_reg_x(rm_or_imm);
        if (is_sub) {
          tb->put_str("; uint32_t __cr = __ca - __cb; __hex_nzcv = (((__cr >> 31) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | ((__ca >= __cb) ? 2u : 0u) | ((((__ca ^ __cb) & (__ca ^ __cr)) >> 31) & 1u);");
        } else {
          tb->put_str("; uint32_t __cr = __ca + __cb; __hex_nzcv = (((__cr >> 31) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | ((__cr < __ca) ? 2u : 0u) | (((~(__ca ^ __cb) & (__ca ^ __cr)) >> 31) & 1u);");
        }
      }
      tb->put_str(" } else { __hex_nzcv = ");
      tb->put_u64_dec(nzcv_imm);
      tb->put_str("u; }\n");
    }
    cmp = CmpState{true, !is64, false, false, false, false, 0u, 0u, 0ULL, true};
    return;
  }

  // AdvSIMD Modified Immediate: MOVI / MVNI / ORR(imm) / BIC(imm) / vector FMOV #imm
  if ((w & 0x9FF80C00u) == 0x0F000400u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t op = (w >> 29u) & 1u;
    const uint32_t cmode = (w >> 12u) & 15u;
    const uint32_t imm8 = (((w >> 16u) & 7u) << 5u) | ((w >> 5u) & 31u);
    const uint32_t rd = w & 31u;
    // Reject unallocated Q=0, op=1, cmode=0xF
    if (!(!is_128 && op == 1u && cmode == 0xFu)) {
      const bool is_orr_bic = ((cmode & 0x9u) == 0x1u) || ((cmode & 0xDu) == 0x9u);
      const bool is_scalar_d = (!is_128 && op == 1u && cmode == 0xEu);
      const uint64_t val64 = decode_advsimd_imm64(op, cmode, imm8);
      if (!emit) {
        if (is_scalar_d) {
          ctx.mark_fp_write(rd);
          ctx.fp_double_mask |= (1u << rd);
          if (val64 != 0ULL) { ctx.uses_fp_bitcast = true; ctx.uses_uint64_t = true; }
        } else {
          ctx.mark_q(rd);
          ctx.fp_written |= (1u << rd);
        }
      } else if (tb) {
        rec();
        tb->put_str("    ");
        if (is_scalar_d) {
          tb->put_reg_d(rd);
          if (val64 == 0ULL) {
            tb->put_str(" = 0.0;\n");
          } else {
            tb->put_str(" = __hex_u64_to_f64(0x");
            tb->put_u64_hex(val64, true);
            tb->put_str("ULL);\n");
          }
          emit_sync_d_to_q(tb, ctx, rd, true);
        } else if (is_orr_bic) {
          tb->put_reg_q(rd);
          tb->put_str(" = ");
          if (!is_128) tb->put_str("(");
          tb->put_reg_q(rd);
          tb->put_str(op == 0u ? " | " : " & ~");
          if (is_128) {
            tb->put_str("(((uint128)0x");
            tb->put_u64_hex(val64, true);
            tb->put_str("ULL << 64) | (uint128)0x");
            tb->put_u64_hex(val64, true);
            tb->put_str("ULL)");
          } else {
            tb->put_str("(uint128)0x");
            tb->put_u64_hex(val64, true);
            tb->put_str("ULL");
          }
          if (!is_128) tb->put_str(") & (uint128)0xFFFFFFFFFFFFFFFFULL");
          tb->put_str(";\n");
          emit_sync_q_to_d(tb, ctx, rd);
        } else {
          tb->put_reg_q(rd);
          if (val64 == 0ULL) {
            tb->put_str(" = 0;\n");
          } else if (is_128) {
            tb->put_str(" = ((uint128)0x");
            tb->put_u64_hex(val64, true);
            tb->put_str("ULL << 64) | (uint128)0x");
            tb->put_u64_hex(val64, true);
            tb->put_str("ULL;\n");
          } else {
            tb->put_str(" = (uint128)0x");
            tb->put_u64_hex(val64, true);
            tb->put_str("ULL;\n");
          }
          emit_sync_q_to_d(tb, ctx, rd);
        }
      }
      return;
    }
  }

  // Scalar FABD s/d (AdvSIMD scalar floating-point absolute difference)
  if ((w & 0xFFA0FC00u) == 0x7EA0D400u) {
    const bool is_double = ((w >> 22u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_fp_read(rn);
      ctx.mark_fp_read(rm);
      ctx.mark_fp_write(rd);
      const uint32_t mask = (1u << rn) | (1u << rm) | (1u << rd);
      if (is_double) ctx.fp_double_mask |= mask;
      else ctx.fp_single_mask |= mask;
    } else if (tb) {
      rec();
      tb->put_str("    ");
      tb->put_reg_d(rd);
      tb->put_str(" = (");
      tb->put_reg_d(rn);
      tb->put_str(" >= ");
      tb->put_reg_d(rm);
      tb->put_str(") ? (");
      tb->put_reg_d(rn);
      tb->put_str(" - ");
      tb->put_reg_d(rm);
      tb->put_str(") : (");
      tb->put_reg_d(rm);
      tb->put_str(" - ");
      tb->put_reg_d(rn);
      tb->put_str(");\n");
      emit_sync_d_to_q(tb, ctx, rd, is_double);
    }
    return;
  }

  // FMADD / FMSUB / FNMADD / FNMSUB (scalar s/d)
  if ((w & 0xFF000000u) == 0x1F000000u) {
    const uint32_t ftype = (w >> 22u) & 3u;
    const bool o1 = ((w >> 21u) & 1u) != 0u;
    const bool o0 = ((w >> 15u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t ra = (w >> 10u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_fp_read(rn);
      ctx.mark_fp_read(rm);
      ctx.mark_fp_read(ra);
      ctx.mark_fp_write(rd);
      const uint32_t mask = (1u << rn) | (1u << rm) | (1u << ra) | (1u << rd);
      if (ftype == 0u) ctx.fp_single_mask |= mask;
      else if (ftype == 1u) ctx.fp_double_mask |= mask;
    } else if (tb) {
      rec();
      tb->put_str("    ");
      tb->put_reg_d(rd);
      tb->put_str(" = ");
      if (o1) tb->put_str("-(");
      tb->put_reg_d(ra);
      tb->put_str(o0 ? " - (" : " + (");
      tb->put_reg_d(rn);
      tb->put_str(" * ");
      tb->put_reg_d(rm);
      tb->put_str(o1 ? "))" : ")");
      tb->put_str(";\n");
      emit_sync_d_to_q(tb, ctx, rd, ftype == 1u);
    }
    return;
  }

  // Scalar AdvSIMD FCVTZS/FCVTZU s/d (0x5EA1B800/0x7EA1B800) and SCVTF/UCVTF s/d (0x5E21D800/0x7E21D800)
  if ((w & 0xDFBFFC00u) == 0x5EA1B800u || (w & 0xDFBFFC00u) == 0x5E21D800u) {
    const bool is_u = ((w >> 29u) & 1u) != 0u;
    const bool is_to_int = ((w >> 23u) & 1u) != 0u;
    const bool is_double = ((w >> 22u) & 1u) != 0u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_fp_read(rn);
      ctx.mark_fp_write(rd);
      ctx.uses_fp_bitcast = true;
      ctx.uses_int32 = true;
      ctx.uses_uint32 = true;
      ctx.uses_int64_t = true;
      ctx.uses_uint64_t = true;
      const uint32_t mask = (1u << rn) | (1u << rd);
      if (is_double) ctx.fp_double_mask |= mask;
      else ctx.fp_single_mask |= mask;
    } else if (tb) {
      rec();
      tb->put_str("    ");
      tb->put_reg_d(rd);
      if (is_to_int) {
        if (is_double) {
          tb->put_str(is_u ? " = __hex_u64_to_f64((uint64_t)" : " = __hex_u64_to_f64((uint64_t)(int64_t)");
          tb->put_reg_d(rn);
          tb->put_str(");\n");
        } else {
          tb->put_str(is_u ? " = (double)__hex_u32_to_f32((uint32_t)" : " = (double)__hex_u32_to_f32((uint32_t)(int32_t)");
          tb->put_reg_d(rn);
          tb->put_str(");\n");
        }
      } else {
        if (is_double) {
          tb->put_str(is_u ? " = (double)(uint64_t)__hex_f64_to_u64(" : " = (double)(int64_t)__hex_f64_to_u64(");
          tb->put_reg_d(rn);
          tb->put_str(");\n");
        } else {
          tb->put_str(is_u ? " = (double)(uint32_t)__hex_f32_to_u32((float)" : " = (double)(int32_t)__hex_f32_to_u32((float)");
          tb->put_reg_d(rn);
          tb->put_str(");\n");
        }
      }
      emit_sync_d_to_q(tb, ctx, rd, is_double);
    }
    return;
  }

  // ADC / ADCS / SBC / SBCS (Add/Subtract with Carry)
  if ((w & 0x1FE0FC00u) == 0x1A000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const bool sets_flags = ((w >> 29u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (sets_flags) {
      cmp = CmpState{true, !is64, false, false, false, false, 0u, 0u, 0ULL, true};
    }
    if (!emit) {
      ctx.uses_nzcv = true;
      ctx.uses_uint32 = true;
      if (is64) ctx.uses_uint64_t = true;
      if (rn < 31u) ctx.mark_gpr_read(rn);
      if (rm < 31u) ctx.mark_gpr_read(rm);
      if (rd < 31u) ctx.mark_gpr_write(rd, is64);
    } else if (tb) {
      rec();
      if (is64) {
        tb->put_str("    { uint64_t __ca = (uint64_t)");
        tb->put_reg_x(rn);
        tb->put_str(", __cb = (uint64_t)");
        tb->put_reg_x(rm);
        tb->put_str(", __cin = (uint64_t)((__hex_nzcv >> 1u) & 1u); uint64_t __cr = ");
        tb->put_str(is_sub ? "__ca - __cb - (1ULL - __cin);" : "__ca + __cb + __cin;");
        if (sets_flags) {
          if (is_sub) {
            tb->put_str(" __hex_nzcv = ((uint32_t)((__cr >> 63) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | (((__ca > __cb) || (__cin && __ca == __cb)) ? 2u : 0u) | ((uint32_t)((((__ca ^ __cb) & (__ca ^ __cr)) >> 63) & 1u));");
          } else {
            tb->put_str(" __hex_nzcv = ((uint32_t)((__cr >> 63) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | (((__cr < __ca) || (__cin && __cr == __ca)) ? 2u : 0u) | ((uint32_t)(((~(__ca ^ __cb) & (__ca ^ __cr)) >> 63) & 1u));");
          }
        }
      } else {
        tb->put_str("    { uint32_t __ca = (uint32_t)");
        tb->put_reg_x(rn);
        tb->put_str(", __cb = (uint32_t)");
        tb->put_reg_x(rm);
        tb->put_str(", __cin = ((__hex_nzcv >> 1u) & 1u); uint32_t __cr = ");
        tb->put_str(is_sub ? "__ca - __cb - (1u - __cin);" : "__ca + __cb + __cin;");
        if (sets_flags) {
          if (is_sub) {
            tb->put_str(" __hex_nzcv = (((__cr >> 31) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | (((__ca > __cb) || (__cin && __ca == __cb)) ? 2u : 0u) | ((((__ca ^ __cb) & (__ca ^ __cr)) >> 31) & 1u);");
          } else {
            tb->put_str(" __hex_nzcv = (((__cr >> 31) & 1u) << 3) | ((__cr == 0u) ? 4u : 0u) | (((__cr < __ca) || (__cin && __cr == __ca)) ? 2u : 0u) | (((~(__ca ^ __cb) & (__ca ^ __cr)) >> 31) & 1u);");
          }
        }
      }
      if (rd < 31u) {
        tb->put_char(' ');
        tb->put_reg_x(rd);
        tb->put_str(" = __cr;");
        ctx.clear_adrp(rd);
      }
      tb->put_str(" }\n");
    }
    return;
  }

  // REV64 (AdvSIMD reverse elements in 64-bit doublewords: .8b/.16b/.4h/.8h/.2s/.4s)
  if ((w & 0xBF3FFC00u) == 0x0E200800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (sz <= 2u) {
      const uint32_t esize = 8u << sz;
      const uint32_t per64 = 64u / esize;
      const uint32_t halves = is_128 ? 2u : 1u;
      if (!emit) {
        if (!is_128 && sz == 2u) {
          ctx.mark_fp_read(rn);
          ctx.mark_fp_write(rd);
          ctx.uses_fp_bitcast = true;
          ctx.uses_uint64_t = true;
          ctx.uses_uint32 = true;
        } else {
          ctx.mark_q(rn);
          ctx.mark_q(rd);
          ctx.fp_written |= (1u << rd);
          mark_neon_types(ctx, esize, false);
        }
      } else if (tb) {
        rec();
        if (!is_128 && sz == 2u) {
          tb->put_str("    { uint64_t __rv = __hex_f64_to_u64(");
          tb->put_reg_d(rn);
          tb->put_str("); ");
          tb->put_reg_d(rd);
          tb->put_str(" = __hex_u64_to_f64((__rv >> 32) | (__rv << 32)); }\n");
          emit_sync_d_to_q(tb, ctx, rd, true);
        } else {
          tb->put_str("    { uint128 __vr = 0; for (int __h = 0; __h < ");
          tb->put_u64_dec(halves);
          tb->put_str("; ++__h) for (int __k = 0; __k < ");
          tb->put_u64_dec(per64);
          tb->put_str("; ++__k) { ");
          tb->put_str(neon_utype(esize));
          tb->put_str(" __a = (");
          tb->put_str(neon_utype(esize));
          tb->put_str(")(");
          tb->put_reg_q(rn);
          tb->put_str(" >> (__h * 64 + __k * ");
          tb->put_u64_dec(esize);
          tb->put_str(")); __vr |= (uint128)__a << (__h * 64 + (");
          tb->put_u64_dec(per64 - 1u);
          tb->put_str(" - __k) * ");
          tb->put_u64_dec(esize);
          tb->put_str("); } ");
          tb->put_reg_q(rd);
          tb->put_str(" = __vr; }\n");
          emit_sync_q_to_d(tb, ctx, rd);
        }
      }
      return;
    }
  }

  // Vector Bitwise Logical (64-bit Q=0 & 128-bit Q=1): AND, BIC, ORR/MOV, ORN, EOR, BSL, BIT, BIF
  if ((w & 0x9F20FC00u) == 0x0E201C00u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t u = (w >> 29u) & 1u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_q(rn);
      ctx.mark_q(rm);
      ctx.mark_q(rd);
      ctx.fp_written |= (1u << rd);
    } else if (tb) {
      rec();
      tb->put_str("    ");
      tb->put_reg_q(rd);
      tb->put_str(" = ");
      if (!is_128) tb->put_str("(");
      if (u == 0u && sz == 2u && rn == rm) {
        tb->put_reg_q(rn);
      } else if (u == 0u && sz == 0u) {
        tb->put_reg_q(rn); tb->put_str(" & "); tb->put_reg_q(rm);
      } else if (u == 0u && sz == 1u) {
        tb->put_reg_q(rn); tb->put_str(" & ~"); tb->put_reg_q(rm);
      } else if (u == 0u && sz == 2u) {
        tb->put_reg_q(rn); tb->put_str(" | "); tb->put_reg_q(rm);
      } else if (u == 0u && sz == 3u) {
        tb->put_reg_q(rn); tb->put_str(" | ~"); tb->put_reg_q(rm);
      } else if (u == 1u && sz == 0u) {
        tb->put_reg_q(rn); tb->put_str(" ^ "); tb->put_reg_q(rm);
      } else if (u == 1u && sz == 1u) {
        tb->put_str("("); tb->put_reg_q(rn); tb->put_str(" & "); tb->put_reg_q(rd);
        tb->put_str(") | ("); tb->put_reg_q(rm); tb->put_str(" & ~"); tb->put_reg_q(rd); tb->put_str(")");
      } else if (u == 1u && sz == 2u) {
        tb->put_str("("); tb->put_reg_q(rn); tb->put_str(" & "); tb->put_reg_q(rm);
        tb->put_str(") | ("); tb->put_reg_q(rd); tb->put_str(" & ~"); tb->put_reg_q(rm); tb->put_str(")");
      } else {
        tb->put_str("("); tb->put_reg_q(rn); tb->put_str(" & ~"); tb->put_reg_q(rm);
        tb->put_str(") | ("); tb->put_reg_q(rd); tb->put_str(" & "); tb->put_reg_q(rm); tb->put_str(")");
      }
      if (!is_128) tb->put_str(") & (uint128)0xFFFFFFFFFFFFFFFFULL");
      tb->put_str(";\n");
      emit_sync_q_to_d(tb, ctx, rd);
    }
    return;
  }

  // Vector NOT / MVN (0x2E205800 / 0x6E205800)
  if ((w & 0xBFFFFC00u) == 0x2E205800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_q(rn);
      ctx.mark_q(rd);
      ctx.fp_written |= (1u << rd);
    } else if (tb) {
      rec();
      tb->put_str("    ");
      tb->put_reg_q(rd);
      tb->put_str(is_128 ? " = ~" : " = (~");
      tb->put_reg_q(rn);
      tb->put_str(is_128 ? ";\n" : ") & (uint128)0xFFFFFFFFFFFFFFFFULL;\n");
      emit_sync_q_to_d(tb, ctx, rd);
    }
    return;
  }

  // Vector Integer ADD / SUB / MUL / MLA / MLS across all lane widths
  if ((w & 0x9F20FC00u) == 0x0E208400u || (w & 0xBF20FC00u) == 0x0E209C00u || (w & 0x9F20FC00u) == 0x0E209400u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t u = (w >> 29u) & 1u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t opc = (w >> 11u) & 31u;
    const uint32_t esize = 8u << sz;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    if (lanes > 0u && !(opc != 0x10u && sz == 3u)) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rm); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { ");
        tb->put_str(ut);
        tb->put_str(" __a = ("); tb->put_str(ut); tb->put_str(")("); tb->put_reg_q(rn);
        tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")), __b = (");
        tb->put_str(ut); tb->put_str(")("); tb->put_reg_q(rm);
        tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str("))");
        if (opc == 0x12u) {
          tb->put_str(", __c = ("); tb->put_str(ut); tb->put_str(")("); tb->put_reg_q(rd);
          tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")); __vr |= (uint128)(");
          tb->put_str(ut); tb->put_str(")(__c "); tb->put_str(u ? "- " : "+ ");
          tb->put_str("(__a * __b)) << (__k * "); tb->put_u64_dec(esize); tb->put_str("); } ");
        } else {
          const char* vop = (opc == 0x13u) ? " * " : (u ? " - " : " + ");
          tb->put_str("; __vr |= (uint128)("); tb->put_str(ut); tb->put_str(")(__a");
          tb->put_str(vop); tb->put_str("__b) << (__k * "); tb->put_u64_dec(esize); tb->put_str("); } ");
        }
        tb->put_reg_q(rd);
        tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Vector Integer ABS (U=0) / NEG (U=1)
  if ((w & 0x9F3FFC00u) == 0x0E20B800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const bool is_neg = ((w >> 29u) & 1u) != 0u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t esize = 8u << sz;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    if (lanes > 0u) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, true);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        const char* st = neon_stype(esize);
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { ");
        tb->put_str(st); tb->put_str(" __a = ("); tb->put_str(st); tb->put_str(")("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")); ");
        tb->put_str(ut);
        if (is_neg) {
          tb->put_str(" __r = ("); tb->put_str(ut); tb->put_str(")(0u - ("); tb->put_str(ut); tb->put_str(")__a); ");
        } else {
          tb->put_str(" __r = __a < 0 ? ("); tb->put_str(ut); tb->put_str(")(0u - ("); tb->put_str(ut); tb->put_str(")__a) : ("); tb->put_str(ut); tb->put_str(")__a; ");
        }
        tb->put_str("__vr |= (uint128)__r << (__k * "); tb->put_u64_dec(esize); tb->put_str("); } ");
        tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Vector Integer Comparisons (reg): CMEQ, CMGT, CMGE, CMHI, CMHS
  if ((w & 0xBF20FC00u) == 0x2E208C00u || (w & 0x9F20F400u) == 0x0E203400u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t u = (w >> 29u) & 1u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const bool is_eq = ((w & 0xBF20FC00u) == 0x2E208C00u);
    const bool is_ge = ((w >> 11u) & 1u) != 0u;
    const bool is_signed = (!is_eq && u == 0u);
    const uint32_t esize = 8u << sz;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    if (lanes > 0u) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rm); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, is_signed);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        const char* ct = is_signed ? neon_stype(esize) : ut;
        const char* cop = is_eq ? " == " : (is_ge ? " >= " : " > ");
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(ct); tb->put_str(" __a = ("); tb->put_str(ct); tb->put_str(")("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")), __b = (");
        tb->put_str(ct); tb->put_str(")("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rm); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")); if (__a");
        tb->put_str(cop); tb->put_str("__b) __vr |= (uint128)("); tb->put_str(ut); tb->put_str(")(~(");
        tb->put_str(ut); tb->put_str(")0) << (__k * "); tb->put_u64_dec(esize); tb->put_str("); } ");
        tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Vector Integer Comparisons vs #0: CMGT, CMEQ, CMLT, CMGE, CMLE
  if ((w & 0x9F3FFC00u) == 0x0E208800u || (w & 0x9F3FFC00u) == 0x0E209800u || (w & 0xBF3FFC00u) == 0x0E20A800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t u = (w >> 29u) & 1u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t op5 = (w >> 12u) & 0x1Fu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t esize = 8u << sz;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    if (lanes > 0u) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, true);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        const char* st = neon_stype(esize);
        const char* cop = (op5 == 10u) ? " < 0" : ((op5 == 9u) ? (u ? " <= 0" : " == 0") : (u ? " >= 0" : " > 0"));
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(st); tb->put_str(" __a = ("); tb->put_str(st); tb->put_str(")("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")); if (__a");
        tb->put_str(cop); tb->put_str(") __vr |= (uint128)("); tb->put_str(ut); tb->put_str(")(~(");
        tb->put_str(ut); tb->put_str(")0) << (__k * "); tb->put_u64_dec(esize); tb->put_str("); } ");
        tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Vector Shift Immediate: SSHR, USHR, SHL
  if ((((w & 0x9F80FC00u) == 0x0F000400u) || ((w & 0xBF80FC00u) == 0x0F005400u)) && (((w >> 19u) & 0xFu) != 0u)) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const bool is_shl = ((w & 0xBF80FC00u) == 0x0F005400u);
    const bool is_unsigned = ((w >> 29u) & 1u) != 0u;
    const uint32_t imm7 = (w >> 16u) & 0x7Fu;
    const uint32_t immh = imm7 >> 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    uint32_t esize = 8u;
    if ((immh & 8u) != 0u) esize = 64u;
    else if ((immh & 4u) != 0u) esize = 32u;
    else if ((immh & 2u) != 0u) esize = 16u;
    const uint32_t sh = is_shl ? (imm7 - esize) : (2u * esize - imm7);
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    if (lanes > 0u && (is_128 || esize < 64u)) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, !is_shl && !is_unsigned);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        const char* ct = (!is_shl && !is_unsigned) ? neon_stype(esize) : ut;
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(ct); tb->put_str(" __a = ("); tb->put_str(ct); tb->put_str(")("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")); __vr |= (uint128)(");
        tb->put_str(ut);
        if (!is_shl && sh >= esize) {
          if (is_unsigned) {
            tb->put_str(")(0u");
          } else {
            tb->put_str(")(__a < 0 ? ~("); tb->put_str(ut); tb->put_str(")0 : 0u");
          }
        } else {
          tb->put_str(")(__a "); tb->put_str(is_shl ? "<< " : ">> ");
          tb->put_u64_dec(sh);
        }
        tb->put_str(") << (__k * "); tb->put_u64_dec(esize); tb->put_str("); } ");
        tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Vector SSHLL/SXTL & USHLL/UXTL (immh in 1..7)
  if ((w & 0x9F80FC00u) == 0x0F00A400u && (((w >> 19u) & 0xFu) != 0u) && (((w >> 19u) & 0xFu) < 8u)) {
    const bool is_hi = ((w >> 30u) & 1u) != 0u;
    const bool is_unsigned = ((w >> 29u) & 1u) != 0u;
    const uint32_t imm7 = (w >> 16u) & 0x7Fu;
    const uint32_t immh = imm7 >> 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    uint32_t esize = 8u;
    if ((immh & 4u) != 0u) esize = 32u;
    else if ((immh & 2u) != 0u) esize = 16u;
    const uint32_t dst_esize = esize * 2u;
    const uint32_t sh = imm7 - esize;
    const uint32_t lanes = 64u / esize;
    const uint32_t base_bit = is_hi ? 64u : 0u;
    if (!emit) {
      ctx.mark_q(rn); ctx.mark_q(rd);
      ctx.fp_written |= (1u << rd);
      mark_neon_types(ctx, esize, !is_unsigned);
      mark_neon_types(ctx, dst_esize, !is_unsigned);
    } else if (tb) {
      rec();
      const char* sut = neon_utype(esize);
      const char* sct = is_unsigned ? sut : neon_stype(esize);
      const char* dut = neon_utype(dst_esize);
      const char* dct = is_unsigned ? dut : neon_stype(dst_esize);
      tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
      tb->put_u64_dec(lanes);
      tb->put_str("; ++__k) { "); tb->put_str(sct); tb->put_str(" __a = ("); tb->put_str(sct); tb->put_str(")("); tb->put_str(sut); tb->put_str(")(");
      tb->put_reg_q(rn); tb->put_str(" >> ("); tb->put_u64_dec(base_bit); tb->put_str(" + __k * "); tb->put_u64_dec(esize);
      tb->put_str(")); __vr |= (uint128)("); tb->put_str(dut); tb->put_str(")((("); tb->put_str(dut); tb->put_str(")("); tb->put_str(dct); tb->put_str(")__a) << ");
      tb->put_u64_dec(sh); tb->put_str(") << (__k * "); tb->put_u64_dec(dst_esize); tb->put_str("); } ");
      tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
      emit_sync_q_to_d(tb, ctx, rd);
    }
    return;
  }

  // Vector DUP element / DUP general / scalar DUP(MOV b/h/s/d, vN.Ts[idx])
  if ((w & 0xBFE0FC00u) == 0x0E000400u || (w & 0xBFE0FC00u) == 0x0E000C00u || (w & 0xFFE0FC00u) == 0x5E000400u) {
    const bool is_scalar = ((w & 0xFFE0FC00u) == 0x5E000400u);
    const bool is_gpr = (!is_scalar && ((w & 0xBFE0FC00u) == 0x0E000C00u));
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t imm5 = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if ((imm5 & 0xFu) != 0u) {
      uint32_t tz = 0u;
      while (tz < 4u && (((imm5 >> tz) & 1u) == 0u)) ++tz;
      if (is_scalar || is_128 || tz < 3u) {
      const uint32_t esize = 8u << tz;
      const uint32_t idx = imm5 >> (tz + 1u);
      const uint32_t lanes = is_scalar ? 1u : ((is_128 ? 128u : 64u) / esize);
      if (!emit) {
        if (is_gpr) { if (rn < 31u) ctx.mark_gpr_read(rn); }
        else ctx.mark_q(rn);
        ctx.mark_q(rd);
        if (is_scalar) {
          ctx.mark_fp_write(rd);
          if (esize == 32u) ctx.fp_single_mask |= (1u << rd);
          else if (esize == 64u) ctx.fp_double_mask |= (1u << rd);
          ctx.uses_fp_bitcast = true;
        } else {
          ctx.fp_written |= (1u << rd);
        }
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        tb->put_str("    { "); tb->put_str(ut); tb->put_str(" __el = ("); tb->put_str(ut); tb->put_str(")");
        if (is_gpr) {
          if (rn == 31u) tb->put_str("0");
          else tb->put_reg_x(rn);
        } else {
          tb->put_str("("); tb->put_reg_q(rn); tb->put_str(" >> "); tb->put_u64_dec(idx * esize); tb->put_str(")");
        }
        if (is_scalar) {
          tb->put_str("; "); tb->put_reg_q(rd); tb->put_str(" = (uint128)__el; ");
          if (esize == 32u) {
            tb->put_reg_d(rd); tb->put_str(" = (double)__hex_u32_to_f32(__el); }\n");
          } else if (esize == 64u) {
            tb->put_reg_d(rd); tb->put_str(" = __hex_u64_to_f64(__el); }\n");
          } else {
            tb->put_str("}\n");
            emit_sync_q_to_d(tb, ctx, rd);
          }
        } else {
          tb->put_str("; uint128 __vr = 0; for (int __k = 0; __k < ");
          tb->put_u64_dec(lanes);
          tb->put_str("; ++__k) __vr |= (uint128)__el << (__k * ");
          tb->put_u64_dec(esize); tb->put_str("); ");
          tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
          emit_sync_q_to_d(tb, ctx, rd);
        }
      }
      return;
      }
    }
  }

  // Vector EXT vD, vN, vM, #imm4
  if ((w & 0xBFE08400u) == 0x2E000000u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t imm4 = (w >> 11u) & 15u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t nbytes = is_128 ? 16u : 8u;
    const uint32_t pos = imm4 & (nbytes - 1u);
    if (!emit) {
      ctx.mark_q(rn); ctx.mark_q(rm); ctx.mark_q(rd);
      ctx.fp_written |= (1u << rd);
    } else if (tb) {
      rec();
      tb->put_str("    "); tb->put_reg_q(rd); tb->put_str(" = ");
      if (pos == 0u) {
        if (!is_128) tb->put_str("(");
        tb->put_reg_q(rn);
        if (!is_128) tb->put_str(") & (uint128)0xFFFFFFFFFFFFFFFFULL");
      } else {
        tb->put_str("((");
        if (!is_128) tb->put_str("(");
        tb->put_reg_q(rn);
        if (!is_128) tb->put_str(" & (uint128)0xFFFFFFFFFFFFFFFFULL)");
        tb->put_str(" >> "); tb->put_u64_dec(pos * 8u);
        tb->put_str(") | ("); tb->put_reg_q(rm);
        tb->put_str(" << "); tb->put_u64_dec((nbytes - pos) * 8u);
        tb->put_str("))");
        if (!is_128) tb->put_str(" & (uint128)0xFFFFFFFFFFFFFFFFULL");
      }
      tb->put_str(";\n");
      emit_sync_q_to_d(tb, ctx, rd);
    }
    return;
  }

  // Vector TBL vD, {vN..}, vM
  if ((w & 0xBFE09C00u) == 0x0E000000u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t len = ((w >> 13u) & 3u) + 1u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t nbytes = is_128 ? 16u : 8u;
    if (!emit) {
      for (uint32_t t = 0u; t < len; ++t) ctx.mark_q((rn + t) & 31u);
      ctx.mark_q(rm); ctx.mark_q(rd);
      ctx.fp_written |= (1u << rd);
      ctx.uses_uint8 = true;
    } else if (tb) {
      rec();
      tb->put_str("    { uint128 __tb["); tb->put_u64_dec(len); tb->put_str("] = {");
      for (uint32_t t = 0u; t < len; ++t) {
        if (t > 0u) tb->put_str(", ");
        tb->put_reg_q((rn + t) & 31u);
      }
      tb->put_str("}; uint128 __vr = 0; for (int __k = 0; __k < ");
      tb->put_u64_dec(nbytes);
      tb->put_str("; ++__k) { uint8_t __ix = (uint8_t)(");
      tb->put_reg_q(rm);
      tb->put_str(" >> (__k * 8)); if (__ix < ");
      tb->put_u64_dec(len * 16u);
      tb->put_str("u) __vr |= (uint128)(uint8_t)(__tb[__ix >> 4] >> ((__ix & 15u) * 8u)) << (__k * 8); } ");
      tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
      emit_sync_q_to_d(tb, ctx, rd);
    }
    return;
  }

  // Vector UZP1 / UZP2
  if ((w & 0xBF20BC00u) == 0x0E001800u && ((((w >> 12u) & 7u) == 1u) || (((w >> 12u) & 7u) == 5u))) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const bool is_uzp2 = (((w >> 12u) & 7u) == 5u);
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t esize = 8u << sz;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    const uint32_t half = lanes / 2u;
    if (half > 0u) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rm); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        const uint32_t part = is_uzp2 ? 1u : 0u;
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(half);
        tb->put_str("; ++__k) { "); tb->put_str(ut); tb->put_str(" __a = ("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> ((2 * __k + "); tb->put_u64_dec(part); tb->put_str(") * "); tb->put_u64_dec(esize);
        tb->put_str(")), __b = ("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rm); tb->put_str(" >> ((2 * __k + "); tb->put_u64_dec(part); tb->put_str(") * "); tb->put_u64_dec(esize);
        tb->put_str(")); __vr |= (uint128)__a << (__k * "); tb->put_u64_dec(esize);
        tb->put_str("); __vr |= (uint128)__b << ((__k + "); tb->put_u64_dec(half); tb->put_str(") * "); tb->put_u64_dec(esize);
        tb->put_str("); } "); tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Vector XTN / XTN2
  if ((w & 0xBF3FFC00u) == 0x0E212800u) {
    const bool is_hi = ((w >> 30u) & 1u) != 0u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (sz <= 2u) {
      const uint32_t dst_esize = 8u << sz;
      const uint32_t src_esize = dst_esize * 2u;
      const uint32_t lanes = 64u / dst_esize;
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, dst_esize, false);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(dst_esize);
        tb->put_str("    { uint128 __vr = ");
        if (is_hi) { tb->put_str("("); tb->put_reg_q(rd); tb->put_str(" & (uint128)0xFFFFFFFFFFFFFFFFULL)"); }
        else tb->put_str("0");
        tb->put_str("; for (int __k = 0; __k < "); tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(ut); tb->put_str(" __a = ("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(src_esize);
        tb->put_str(")); __vr |= (uint128)__a << ("); tb->put_u64_dec(is_hi ? 64u : 0u);
        tb->put_str(" + __k * "); tb->put_u64_dec(dst_esize); tb->put_str("); } ");
        tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Widening Vector SMULL/SMULL2 & UMULL/UMULL2
  if ((w & 0x9F20FC00u) == 0x0E20C000u) {
    const bool is_hi = ((w >> 30u) & 1u) != 0u;
    const bool is_unsigned = ((w >> 29u) & 1u) != 0u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (sz <= 2u) {
      const uint32_t esize = 8u << sz;
      const uint32_t dst_esize = esize * 2u;
      const uint32_t lanes = 64u / esize;
      const uint32_t base_bit = is_hi ? 64u : 0u;
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rm); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, !is_unsigned);
        mark_neon_types(ctx, dst_esize, !is_unsigned);
      } else if (tb) {
        rec();
        const char* sut = neon_utype(esize);
        const char* sct = is_unsigned ? sut : neon_stype(esize);
        const char* dut = neon_utype(dst_esize);
        const char* dct = is_unsigned ? dut : neon_stype(dst_esize);
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(dct); tb->put_str(" __a = ("); tb->put_str(dct); tb->put_str(")(");
        tb->put_str(sct); tb->put_str(")("); tb->put_str(sut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> ("); tb->put_u64_dec(base_bit); tb->put_str(" + __k * "); tb->put_u64_dec(esize);
        tb->put_str(")), __b = ("); tb->put_str(dct); tb->put_str(")(");
        tb->put_str(sct); tb->put_str(")("); tb->put_str(sut); tb->put_str(")(");
        tb->put_reg_q(rm); tb->put_str(" >> ("); tb->put_u64_dec(base_bit); tb->put_str(" + __k * "); tb->put_u64_dec(esize);
        tb->put_str(")); __vr |= (uint128)("); tb->put_str(dut); tb->put_str(")(__a * __b) << (__k * ");
        tb->put_u64_dec(dst_esize); tb->put_str("); } "); tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Widening Vector SADDW/UADDW/SSUBW/USUBW (+2 variants)
  if ((w & 0x9F20DC00u) == 0x0E201000u) {
    const bool is_hi = ((w >> 30u) & 1u) != 0u;
    const bool is_unsigned = ((w >> 29u) & 1u) != 0u;
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const bool is_sub = ((w >> 13u) & 1u) != 0u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (sz <= 2u) {
      const uint32_t esize = 8u << sz;
      const uint32_t dst_esize = esize * 2u;
      const uint32_t lanes = 64u / esize;
      const uint32_t base_bit = is_hi ? 64u : 0u;
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rm); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, !is_unsigned);
        mark_neon_types(ctx, dst_esize, !is_unsigned);
      } else if (tb) {
        rec();
        const char* sut = neon_utype(esize);
        const char* sct = is_unsigned ? sut : neon_stype(esize);
        const char* dut = neon_utype(dst_esize);
        const char* dct = is_unsigned ? dut : neon_stype(dst_esize);
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(dct); tb->put_str(" __a = ("); tb->put_str(dct); tb->put_str(")("); tb->put_str(dut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(dst_esize);
        tb->put_str(")), __b = ("); tb->put_str(dct); tb->put_str(")("); tb->put_str(sct); tb->put_str(")("); tb->put_str(sut); tb->put_str(")(");
        tb->put_reg_q(rm); tb->put_str(" >> ("); tb->put_u64_dec(base_bit); tb->put_str(" + __k * "); tb->put_u64_dec(esize);
        tb->put_str(")); __vr |= (uint128)("); tb->put_str(dut); tb->put_str(")(__a ");
        tb->put_str(is_sub ? "- " : "+ "); tb->put_str("__b) << (__k * "); tb->put_u64_dec(dst_esize); tb->put_str("); } ");
        tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Vector Cross-Lane Reductions: ADDV, SMAXV/UMAXV, SMINV/UMINV
  if ((w & 0xBF3FFC00u) == 0x0E31B800u || (w & 0x9F3EFC00u) == 0x0E30A800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const bool is_addv = ((w & 0xBF3FFC00u) == 0x0E31B800u);
    const bool is_unsigned = ((w >> 29u) & 1u) != 0u;
    const bool is_min = (!is_addv && (((w >> 16u) & 1u) != 0u));
    const uint32_t sz = (w >> 22u) & 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (sz <= 2u) {
      const uint32_t esize = 8u << sz;
      const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rd);
        ctx.fp_used |= (1u << rd);
        ctx.fp_written |= (1u << rd);
        ctx.uses_fp_bitcast = true;
        ctx.uses_uint32 = true;
        mark_neon_types(ctx, esize, !is_addv && !is_unsigned);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        const char* ct = (!is_addv && !is_unsigned) ? neon_stype(esize) : ut;
        tb->put_str("    { "); tb->put_str(ct); tb->put_str(" __acc = ("); tb->put_str(ct); tb->put_str(")("); tb->put_str(ut); tb->put_str(")");
        tb->put_reg_q(rn); tb->put_str("; for (int __k = 1; __k < "); tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(ct); tb->put_str(" __v = ("); tb->put_str(ct); tb->put_str(")("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")); ");
        if (is_addv) {
          tb->put_str("__acc = ("); tb->put_str(ct); tb->put_str(")(__acc + __v); } ");
        } else {
          tb->put_str("if (__v "); tb->put_str(is_min ? "< " : "> "); tb->put_str("__acc) __acc = __v; } ");
        }
        tb->put_reg_q(rd); tb->put_str(" = (uint128)("); tb->put_str(ut); tb->put_str(")__acc; ");
        tb->put_reg_d(rd); tb->put_str(" = (double)__hex_u32_to_f32((uint32_t)("); tb->put_str(ut); tb->put_str(")__acc); }\n");
      }
      return;
    }
  }

  // Scalar ADDP dD, vN.2d
  if ((w & 0xFFFFFC00u) == 0x5EF1B800u) {
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_q(rn); ctx.mark_q(rd);
      ctx.mark_fp_write(rd);
      ctx.fp_double_mask |= (1u << rd);
      ctx.uses_fp_bitcast = true;
      ctx.uses_uint64_t = true;
    } else if (tb) {
      rec();
      tb->put_str("    { uint64_t __vs = (uint64_t)");
      tb->put_reg_q(rn);
      tb->put_str(" + (uint64_t)(");
      tb->put_reg_q(rn);
      tb->put_str(" >> 64); ");
      tb->put_reg_q(rd);
      tb->put_str(" = (uint128)__vs; ");
      tb->put_reg_d(rd);
      tb->put_str(" = __hex_u64_to_f64(__vs); }\n");
    }
    return;
  }

  // Vector LD2 {vT.T, v(T+1).T}, [xN] / [xN], #imm/xM
  if ((w & 0xBFFFF000u) == 0x0C408000u || (w & 0xBFE0F000u) == 0x0CC08000u) {
    const bool is_post = ((w >> 23u) & 1u) != 0u;
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t sz = (w >> 10u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rt = w & 31u;
    const uint32_t rt2 = (rt + 1u) & 31u;
    const uint32_t esize = 8u << sz;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    const uint32_t ebytes = esize / 8u;
    if (lanes > 0u) {
      if (!emit) {
        if (rn == 31u) ctx.uses_sp = true;
        else { ctx.mark_gpr_read(rn); if (is_post) ctx.mark_gpr_write(rn); }
        if (is_post && rm < 31u) ctx.mark_gpr_read(rm);
        ctx.mark_q(rt); ctx.mark_q(rt2);
        ctx.fp_written |= (1u << rt) | (1u << rt2);
        ctx.uses_uintptr = true;
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        tb->put_str("    { uint128 __v0 = 0, __v1 = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { __v0 |= (uint128)(*("); tb->put_str(ut); tb->put_str(" *)((uintptr_t)(");
        tb->put_reg_x_or_sp(rn); tb->put_str(") + __k * "); tb->put_u64_dec(ebytes * 2u);
        tb->put_str(")) << (__k * "); tb->put_u64_dec(esize);
        tb->put_str("); __v1 |= (uint128)(*("); tb->put_str(ut); tb->put_str(" *)((uintptr_t)(");
        tb->put_reg_x_or_sp(rn); tb->put_str(") + __k * "); tb->put_u64_dec(ebytes * 2u);
        tb->put_str(" + "); tb->put_u64_dec(ebytes); tb->put_str(")) << (__k * "); tb->put_u64_dec(esize);
        tb->put_str("); } "); tb->put_reg_q(rt); tb->put_str(" = __v0; ");
        tb->put_reg_q(rt2); tb->put_str(" = __v1; ");
        if (is_post) {
          tb->put_reg_x_or_sp(rn); tb->put_str(" = "); tb->put_reg_x_or_sp(rn); tb->put_str(" + ");
          if (rm == 31u) tb->put_u64_dec(is_128 ? 32u : 16u);
          else tb->put_reg_x(rm);
          tb->put_str("; ");
          if (rn < 31u) ctx.clear_adrp(rn);
        }
        tb->put_str("}\n");
        emit_sync_q_to_d(tb, ctx, rt);
        emit_sync_q_to_d(tb, ctx, rt2);
      }
      return;
    }
  }

  // Vector Floating-Point 2-src (.2s/.4s/.2d): FADD, FSUB, FMUL, FDIV, FABD, FCMGT, FCMGE, FCMEQ
  if ((w & 0xBFA0FC00u) == 0x0E20D400u || (w & 0xBFA0FC00u) == 0x0EA0D400u ||
      (w & 0xBFA0FC00u) == 0x2E20DC00u || (w & 0xBFA0FC00u) == 0x2E20FC00u ||
      (w & 0xBFA0FC00u) == 0x2EA0D400u || (w & 0xBFA0FC00u) == 0x2EA0E400u ||
      (w & 0xBFA0FC00u) == 0x2E20E400u || (w & 0xBFA0FC00u) == 0x0E20E400u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const bool is_double = ((w >> 22u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t esize = is_double ? 64u : 32u;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    const uint32_t pat = w & 0xBFA0FC00u;
    const bool is_cmp = (pat == 0x2EA0E400u || pat == 0x2E20E400u || pat == 0x0E20E400u);
    if (lanes > 0u) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rm); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        ctx.uses_fp_bitcast = true;
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        const char* ft = is_double ? "double" : "float";
        const char* ut = is_double ? "uint64_t" : "uint32_t";
        const char* to_f = is_double ? "__hex_u64_to_f64" : "__hex_u32_to_f32";
        const char* to_u = is_double ? "__hex_f64_to_u64" : "__hex_f32_to_u32";
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(ft); tb->put_str(" __a = "); tb->put_str(to_f); tb->put_str("(("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str("))), __b = "); tb->put_str(to_f); tb->put_str("(("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rm); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str("))); ");
        if (is_cmp) {
          const char* cop = (pat == 0x2EA0E400u) ? " > " : ((pat == 0x2E20E400u) ? " >= " : " == ");
          tb->put_str("if (__a"); tb->put_str(cop); tb->put_str("__b) __vr |= (uint128)("); tb->put_str(ut); tb->put_str(")(~("); tb->put_str(ut); tb->put_str(")0) << (__k * ");
        } else if (pat == 0x2EA0D400u) {
          tb->put_str(ft); tb->put_str(" __r = (__a >= __b) ? (__a - __b) : (__b - __a); __vr |= (uint128)"); tb->put_str(to_u); tb->put_str("(__r) << (__k * ");
        } else {
          const char* fop = (pat == 0x0E20D400u) ? " + " : ((pat == 0x0EA0D400u) ? " - " : ((pat == 0x2E20DC00u) ? " * " : " / "));
          tb->put_str("__vr |= (uint128)"); tb->put_str(to_u); tb->put_str("(__a"); tb->put_str(fop); tb->put_str("__b) << (__k * ");
        }
        tb->put_u64_dec(esize); tb->put_str("); } "); tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd, is_double);
      }
      return;
    }
  }

  // Vector FP Compare vs #0.0
  if ((w & 0x9FBFFC00u) == 0x0EA0C800u || (w & 0x9FBFFC00u) == 0x0EA0D800u || (w & 0xBFBFFC00u) == 0x0EA0E800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t u = (w >> 29u) & 1u;
    const bool is_double = ((w >> 22u) & 1u) != 0u;
    const uint32_t op5 = (w >> 12u) & 0x1Fu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t esize = is_double ? 64u : 32u;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    if (lanes > 0u) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        ctx.uses_fp_bitcast = true;
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        const char* ft = is_double ? "double" : "float";
        const char* ut = is_double ? "uint64_t" : "uint32_t";
        const char* to_f = is_double ? "__hex_u64_to_f64" : "__hex_u32_to_f32";
        const char* cop = (op5 == 0x0Eu) ? " < 0.0" : ((op5 == 0x0Du) ? (u ? " <= 0.0" : " == 0.0") : (u ? " >= 0.0" : " > 0.0"));
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { "); tb->put_str(ft); tb->put_str(" __a = "); tb->put_str(to_f); tb->put_str("(("); tb->put_str(ut); tb->put_str(")(");
        tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str("))); if (__a");
        tb->put_str(cop); tb->put_str(") __vr |= (uint128)("); tb->put_str(ut); tb->put_str(")(~("); tb->put_str(ut);
        tb->put_str(")0) << (__k * "); tb->put_u64_dec(esize); tb->put_str("); } ");
        tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd);
      }
      return;
    }
  }

  // Vector FP Unary: FRINTA, FRINTP, FRINTM, FRINTZ, FCVTZS, FCVTZU, SCVTF, UCVTF
  if ((w & 0xBFBFFC00u) == 0x2E218800u || (w & 0xBFBFFC00u) == 0x0EA18800u ||
      (w & 0xBFBFFC00u) == 0x0E219800u || (w & 0xBFBFFC00u) == 0x0EA19800u ||
      (w & 0xBFBFFC00u) == 0x0EA1B800u || (w & 0xBFBFFC00u) == 0x2EA1B800u ||
      (w & 0xBFBFFC00u) == 0x0E21D800u || (w & 0xBFBFFC00u) == 0x2E21D800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const bool is_double = ((w >> 22u) & 1u) != 0u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t pat = w & 0xBFBFFC00u;
    const bool is_cvtzs = (pat == 0x0EA1B800u);
    const bool is_cvtzu = (pat == 0x2EA1B800u);
    const bool is_scvtf = (pat == 0x0E21D800u);
    const bool is_ucvtf = (pat == 0x2E21D800u);
    const bool is_int_cvt = is_cvtzs || is_cvtzu || is_scvtf || is_ucvtf;
    const uint32_t esize = is_double ? 64u : 32u;
    const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
    if (lanes > 0u) {
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        ctx.uses_fp_bitcast = true;
        if (!is_int_cvt) ctx.uses_math = true;
        mark_neon_types(ctx, esize, is_cvtzs || is_scvtf);
      } else if (tb) {
        rec();
        const char* ft = is_double ? "double" : "float";
        const char* ut = is_double ? "uint64_t" : "uint32_t";
        const char* st = is_double ? "int64_t" : "int32_t";
        const char* to_f = is_double ? "__hex_u64_to_f64" : "__hex_u32_to_f32";
        const char* to_u = is_double ? "__hex_f64_to_u64" : "__hex_f32_to_u32";
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) { ");
        if (is_scvtf || is_ucvtf) {
          tb->put_str(ut); tb->put_str(" __i = ("); tb->put_str(ut); tb->put_str(")(");
          tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str(")); ");
          tb->put_str("__vr |= (uint128)"); tb->put_str(to_u); tb->put_str("(("); tb->put_str(ft); tb->put_str(")(");
          tb->put_str(is_scvtf ? st : ut); tb->put_str(")__i) << (__k * ");
        } else {
          tb->put_str(ft); tb->put_str(" __a = "); tb->put_str(to_f); tb->put_str("(("); tb->put_str(ut); tb->put_str(")(");
          tb->put_reg_q(rn); tb->put_str(" >> (__k * "); tb->put_u64_dec(esize); tb->put_str("))); ");
          if (is_cvtzs) {
            tb->put_str("__vr |= (uint128)("); tb->put_str(ut); tb->put_str(")("); tb->put_str(st); tb->put_str(")__a << (__k * ");
          } else if (is_cvtzu) {
            tb->put_str("__vr |= (uint128)("); tb->put_str(ut); tb->put_str(")__a << (__k * ");
          } else {
            const char* mfn = (pat == 0x2E218800u) ? "round" : ((pat == 0x0EA18800u) ? "ceil" : ((pat == 0x0E219800u) ? "floor" : "trunc"));
            tb->put_str("__vr |= (uint128)"); tb->put_str(to_u); tb->put_str("(("); tb->put_str(ft); tb->put_str(")");
            tb->put_str(mfn); tb->put_str("((double)__a)) << (__k * ");
          }
        }
        tb->put_u64_dec(esize); tb->put_str("); } "); tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd, is_double);
      }
      return;
    }
  }

  // Vector FCVTL / FCVTL2 (float32 -> float64)
  if ((w & 0xBFFFFC00u) == 0x0E617800u) {
    const bool is_hi = ((w >> 30u) & 1u) != 0u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t base_bit = is_hi ? 64u : 0u;
    if (!emit) {
      ctx.mark_q(rn); ctx.mark_q(rd);
      ctx.fp_written |= (1u << rd);
      ctx.uses_fp_bitcast = true;
      ctx.uses_uint32 = true;
      ctx.uses_uint64_t = true;
    } else if (tb) {
      rec();
      tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < 2; ++__k) { float __f = __hex_u32_to_f32((uint32_t)(");
      tb->put_reg_q(rn); tb->put_str(" >> ("); tb->put_u64_dec(base_bit);
      tb->put_str(" + __k * 32))); __vr |= (uint128)__hex_f64_to_u64((double)__f) << (__k * 64); } ");
      tb->put_reg_q(rd); tb->put_str(" = __vr; }\n");
      emit_sync_q_to_d(tb, ctx, rd, true);
    }
    return;
  }

  // Part 3.1: Vector element UMOV / SMOV / INS (general & element)
  if ((w & 0xBFE0FC00u) == 0x0E003C00u || (w & 0xBFE0FC00u) == 0x0E002C00u) {
    const bool is_signed = ((w & 0x00001000u) == 0u);
    const bool is_q = ((w >> 30u) & 1u) != 0u;
    const uint32_t imm5 = (w >> 16u) & 0x1Fu;
    if (imm5 != 0u) {
      const uint32_t tz = static_cast<uint32_t>(__builtin_ctz(imm5));
      if (tz <= 3u && !(is_signed && tz >= 3u) && !(is_signed && !is_q && tz >= 2u)) {
        const uint32_t esize = 8u << tz;
        const uint32_t idx = imm5 >> (tz + 1u);
        const uint32_t rn = (w >> 5u) & 31u;
        const uint32_t rd = w & 31u;
        const bool is64_dst = is_q;
        if (!emit) {
          ctx.mark_q(rn);
          if (rd < 31u) ctx.mark_gpr_write(rd, is64_dst);
          mark_neon_types(ctx, esize, is_signed);
          if (is_signed) { ctx.uses_int64_t = true; ctx.uses_int32 = true; ctx.uses_uint32 = true; }
        } else if (tb && rd < 31u) {
          rec();
          tb->put_str("    ");
          tb->put_reg_x(rd);
          tb->put_str(" = ");
          if (is_signed) {
            tb->put_str(is64_dst ? "(uint64)(int64_t)(" : "(uint32_t)(int32_t)(");
            tb->put_str(neon_stype(esize));
          } else {
            tb->put_str("(");
            tb->put_str(neon_utype(esize));
          }
          tb->put_str(")(");
          tb->put_reg_q(rn);
          if (idx > 0u) {
            tb->put_str(" >> ");
            tb->put_u64_dec(idx * esize);
          }
          tb->put_str(");\n");
          ctx.clear_adrp(rd);
        }
        return;
      }
    }
  }
  if ((w & 0xFFE0FC00u) == 0x4E001C00u) {
    // INS Vd.<Ts>[idx], Wn/Xn (general)
    const uint32_t imm5 = (w >> 16u) & 0x1Fu;
    if (imm5 != 0u) {
      const uint32_t tz = static_cast<uint32_t>(__builtin_ctz(imm5));
      if (tz <= 3u) {
        const uint32_t esize = 8u << tz;
        const uint32_t idx = imm5 >> (tz + 1u);
        const uint32_t bitpos = idx * esize;
        const uint32_t rn = (w >> 5u) & 31u;
        const uint32_t rd = w & 31u;
        const uint64_t emask = (esize == 64u) ? 0xFFFFFFFFFFFFFFFFULL : ((1ULL << esize) - 1ULL);
        if (!emit) {
          ctx.mark_gpr_read(rn);
          ctx.mark_q(rd);
          ctx.fp_written |= (1u << rd);
          mark_neon_types(ctx, esize, false);
        } else if (tb) {
          rec();
          tb->put_str("    ");
          tb->put_reg_q(rd);
          tb->put_str(" = (");
          tb->put_reg_q(rd);
          tb->put_str(" & ~((uint128)0x");
          tb->put_u64_hex(emask, true);
          tb->put_str("ULL << ");
          tb->put_u64_dec(bitpos);
          tb->put_str(")) | ((uint128)(");
          tb->put_str(neon_utype(esize));
          tb->put_str(")");
          tb->put_reg_x(rn);
          tb->put_str(" << ");
          tb->put_u64_dec(bitpos);
          tb->put_str(");\n");
          emit_sync_q_to_d(tb, ctx, rd, esize == 64u);
        }
        return;
      }
    }
  }
  if ((w & 0xFFE08400u) == 0x6E000400u) {
    // INS Vd.<Ts>[idx1], Vn.<Ts>[idx2] (element)
    const uint32_t imm5 = (w >> 16u) & 0x1Fu;
    if (imm5 != 0u) {
      const uint32_t tz = static_cast<uint32_t>(__builtin_ctz(imm5));
      if (tz <= 3u) {
        const uint32_t esize = 8u << tz;
        const uint32_t dst_idx = imm5 >> (tz + 1u);
        const uint32_t src_idx = ((w >> 11u) & 0xFu) >> tz;
        const uint32_t dst_bit = dst_idx * esize;
        const uint32_t src_bit = src_idx * esize;
        const uint32_t rn = (w >> 5u) & 31u;
        const uint32_t rd = w & 31u;
        const uint64_t emask = (esize == 64u) ? 0xFFFFFFFFFFFFFFFFULL : ((1ULL << esize) - 1ULL);
        if (!emit) {
          ctx.mark_q(rn);
          ctx.mark_q(rd);
          ctx.fp_written |= (1u << rd);
          mark_neon_types(ctx, esize, false);
        } else if (tb) {
          rec();
          tb->put_str("    ");
          tb->put_reg_q(rd);
          tb->put_str(" = (");
          tb->put_reg_q(rd);
          tb->put_str(" & ~((uint128)0x");
          tb->put_u64_hex(emask, true);
          tb->put_str("ULL << ");
          tb->put_u64_dec(dst_bit);
          tb->put_str(")) | ((uint128)(");
          tb->put_str(neon_utype(esize));
          tb->put_str(")(");
          tb->put_reg_q(rn);
          if (src_bit > 0u) {
            tb->put_str(" >> ");
            tb->put_u64_dec(src_bit);
          }
          tb->put_str(") << ");
          tb->put_u64_dec(dst_bit);
          tb->put_str(");\n");
          emit_sync_q_to_d(tb, ctx, rd, esize == 64u);
        }
        return;
      }
    }
  }

  // Part 3.2: FCSEL (scalar FP conditional select)
  if ((w & 0xFF200C00u) == 0x1E200C00u) {
    const uint32_t ftype = (w >> 22u) & 3u;
    if (ftype <= 1u) {
      const uint32_t rm = (w >> 16u) & 31u;
      const uint32_t cond = (w >> 12u) & 0xFu;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      if (!emit) {
        const int fw = (ftype == 0u) ? 1 : 2;
        ctx.mark_fp_read(rn, fw);
        ctx.mark_fp_read(rm, fw);
        ctx.mark_fp_write(rd);
        const uint32_t mask = (1u << rn) | (1u << rm) | (1u << rd);
        if (ftype == 0u) ctx.fp_single_mask |= mask;
        else ctx.fp_double_mask |= mask;
        if (cmp.valid && !cmp.is_fp) {
          const bool signed_cmp = (cond == 0xAu || cond == 0xBu || cond == 0xCu || cond == 0xDu);
          if (cmp.is32) {
            if (signed_cmp) ctx.uses_int32 = true;
            else ctx.uses_uint32 = true;
          } else {
            if (signed_cmp) ctx.uses_int64_t = true;
            else ctx.uses_uint64_t = true;
          }
        }
      } else if (tb) {
        rec();
        tb->put_str("    ");
        tb->put_reg_d(rd);
        tb->put_str(" = ");
        emit_cond_expr(*tb, cond, cmp);
        tb->put_str(" ? ");
        tb->put_reg_d(rn);
        tb->put_str(" : ");
        tb->put_reg_d(rm);
        tb->put_str(";\n");
        emit_sync_d_to_q(tb, ctx, rd, ftype == 1u);
      }
      return;
    }
  }

  // Part 3.6: FCCMP / FCCMPE (FP conditional compare)
  if ((w & 0xFF200C00u) == 0x1E200400u) {
    const uint32_t ftype = (w >> 22u) & 3u;
    if (ftype <= 1u) {
      const uint32_t rm = (w >> 16u) & 31u;
      const uint32_t cond = (w >> 12u) & 0xFu;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t nzcv_imm = w & 0xFu;
      if (!emit) {
        ctx.uses_nzcv = true;
        ctx.uses_uint32 = true;
        const int fw = (ftype == 0u) ? 1 : 2;
        ctx.mark_fp_read(rn, fw);
        ctx.mark_fp_read(rm, fw);
        const uint32_t mask = (1u << rn) | (1u << rm);
        if (ftype == 0u) ctx.fp_single_mask |= mask;
        else ctx.fp_double_mask |= mask;
        if (cmp.valid && !cmp.is_fp) {
          const bool signed_cmp = (cond == 0xAu || cond == 0xBu || cond == 0xCu || cond == 0xDu);
          if (cmp.is32) {
            if (signed_cmp) ctx.uses_int32 = true;
            else ctx.uses_uint32 = true;
          } else {
            if (signed_cmp) ctx.uses_int64_t = true;
            else ctx.uses_uint64_t = true;
          }
        }
      } else if (tb) {
        rec();
        tb->put_str("    if (");
        emit_cond_expr(*tb, cond, cmp);
        tb->put_str(") { double __fa = ");
        tb->put_reg_d(rn);
        tb->put_str(", __fb = ");
        tb->put_reg_d(rm);
        tb->put_str("; __hex_nzcv = (__fa == __fb) ? 6u : ((__fa < __fb) ? 8u : ((__fa > __fb) ? 2u : 3u)); } else { __hex_nzcv = ");
        tb->put_u64_dec(nzcv_imm);
        tb->put_str("u; }\n");
      }
      cmp = CmpState{true, false, false, false, false, false, 0u, 0u, 0ULL, true};
      return;
    }
  }

  // Part 3.3: Vector & Scalar-by-element FMUL / FMLA / FMLS
  if ((w & 0xBF800400u) == 0x0F800000u || (w & 0xFF800400u) == 0x5F800000u) {
    const uint32_t opc4 = (w >> 12u) & 0xFu;
    const bool is_scalar_elem = ((w & 0xFF800400u) == 0x5F800000u);
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const bool is_double = ((w >> 22u) & 1u) != 0u;
    const uint32_t L = (w >> 21u) & 1u;
    const uint32_t H = (w >> 11u) & 1u;
    if ((opc4 == 1u || opc4 == 5u || opc4 == 9u) && !(is_double && L != 0u) && (is_scalar_elem || is_128 || !is_double)) {
      const uint32_t rm = (w >> 16u) & 31u;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      const uint32_t idx = is_double ? H : ((H << 1u) | L);
      const uint32_t esize = is_double ? 64u : 32u;
      if (is_scalar_elem) {
        if (!emit) {
          const int fw = is_double ? 2 : 1;
          ctx.mark_fp_read(rn, fw);
          if (opc4 != 9u) ctx.mark_fp_read(rd, fw);
          ctx.mark_fp_write(rd);
          ctx.mark_q(rm);
          ctx.uses_fp_bitcast = true;
          mark_neon_types(ctx, esize, false);
          if (is_double) ctx.fp_double_mask |= (1u << rn) | (1u << rd);
          else ctx.fp_single_mask |= (1u << rn) | (1u << rd);
        } else if (tb) {
          rec();
          const char* ut = is_double ? "uint64_t" : "uint32_t";
          const char* to_f = is_double ? "__hex_u64_to_f64" : "__hex_u32_to_f32";
          tb->put_str("    { double __e = (double)");
          tb->put_str(to_f);
          tb->put_str("((");
          tb->put_str(ut);
          tb->put_str(")(");
          tb->put_reg_q(rm);
          if (idx > 0u) { tb->put_str(" >> "); tb->put_u64_dec(idx * esize); }
          tb->put_str(")); ");
          tb->put_reg_d(rd);
          if (opc4 == 9u) {
            tb->put_str(" = ");
            tb->put_reg_d(rn);
            tb->put_str(" * __e; }\n");
          } else {
            tb->put_str(" = ");
            tb->put_reg_d(rd);
            tb->put_str(opc4 == 1u ? " + (" : " - (");
            tb->put_reg_d(rn);
            tb->put_str(" * __e); }\n");
          }
          emit_sync_d_to_q(tb, ctx, rd, is_double);
        }
      } else {
        const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
        if (!emit) {
          ctx.mark_q(rn);
          ctx.mark_q(rm);
          ctx.mark_q(rd);
          ctx.fp_written |= (1u << rd);
          ctx.uses_fp_bitcast = true;
          mark_neon_types(ctx, esize, false);
        } else if (tb) {
          rec();
          const char* ft = is_double ? "double" : "float";
          const char* ut = is_double ? "uint64_t" : "uint32_t";
          const char* to_f = is_double ? "__hex_u64_to_f64" : "__hex_u32_to_f32";
          const char* to_u = is_double ? "__hex_f64_to_u64" : "__hex_f32_to_u32";
          tb->put_str("    { ");
          tb->put_str(ft);
          tb->put_str(" __e = ");
          tb->put_str(to_f);
          tb->put_str("((");
          tb->put_str(ut);
          tb->put_str(")(");
          tb->put_reg_q(rm);
          if (idx > 0u) { tb->put_str(" >> "); tb->put_u64_dec(idx * esize); }
          tb->put_str(")); uint128 __vr = 0; for (int __k = 0; __k < ");
          tb->put_u64_dec(lanes);
          tb->put_str("; ++__k) { ");
          tb->put_str(ft);
          tb->put_str(" __a = ");
          tb->put_str(to_f);
          tb->put_str("((");
          tb->put_str(ut);
          tb->put_str(")(");
          tb->put_reg_q(rn);
          tb->put_str(" >> (__k * ");
          tb->put_u64_dec(esize);
          tb->put_str("))); ");
          if (opc4 == 9u) {
            tb->put_str("__vr |= (uint128)");
            tb->put_str(to_u);
            tb->put_str("(__a * __e) << (__k * ");
          } else {
            tb->put_str(ft);
            tb->put_str(" __acc = ");
            tb->put_str(to_f);
            tb->put_str("((");
            tb->put_str(ut);
            tb->put_str(")(");
            tb->put_reg_q(rd);
            tb->put_str(" >> (__k * ");
            tb->put_u64_dec(esize);
            tb->put_str("))); __vr |= (uint128)");
            tb->put_str(to_u);
            tb->put_str(opc4 == 1u ? "(__acc + __a * __e) << (__k * " : "(__acc - __a * __e) << (__k * ");
          }
          tb->put_u64_dec(esize);
          tb->put_str("); } ");
          tb->put_reg_q(rd);
          tb->put_str(" = __vr; }\n");
          emit_sync_q_to_d(tb, ctx, rd, is_double);
        }
      }
      return;
    }
  }

  // Part 3.4: SMULH / UMULH (64x64->128 high half)
  if ((w & 0xFFE0FC00u) == 0x9B407C00u || (w & 0xFFE0FC00u) == 0x9BC07C00u) {
    const bool is_u = ((w >> 23u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (!emit) {
      ctx.mark_gpr_read(rn);
      ctx.mark_gpr_read(rm);
      if (rd < 31u) ctx.mark_gpr_write(rd, true);
      ctx.uses_uint128 = true;
      ctx.uses_uint64_t = true;
      if (!is_u) ctx.uses_int64_t = true;
    } else if (tb && rd < 31u) {
      rec();
      tb->put_str("    ");
      tb->put_reg_x(rd);
      if (is_u) {
        tb->put_str(" = (uint64)(((uint128)(uint64_t)");
        tb->put_reg_x(rn);
        tb->put_str(" * (uint128)(uint64_t)");
        tb->put_reg_x(rm);
        tb->put_str(") >> 64);\n");
      } else {
        tb->put_str(" = (uint64)(((__int128)(int64_t)");
        tb->put_reg_x(rn);
        tb->put_str(" * (__int128)(int64_t)");
        tb->put_reg_x(rm);
        tb->put_str(") >> 64);\n");
      }
      ctx.clear_adrp(rd);
    }
    return;
  }

  // Part 3.5a: Fixed-point SCVTF / UCVTF / FCVTZS / FCVTZU (GPR <-> FP)
  if ((w & 0x5F200000u) == 0x1E000000u) {
    const bool is64_int = ((w >> 31u) & 1u) != 0u;
    const uint32_t ftype = (w >> 22u) & 3u;
    const uint32_t rmode = (w >> 19u) & 3u;
    const uint32_t opcode = (w >> 16u) & 7u;
    const uint32_t scale = (w >> 10u) & 0x3Fu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t fbits = 64u - scale;
    const bool valid_fix = (ftype <= 1u) && (fbits >= 1u) && (is64_int || fbits <= 32u) &&
                           ((rmode == 0u && (opcode == 2u || opcode == 3u)) ||
                            (rmode == 3u && (opcode == 0u || opcode == 1u)));
    if (valid_fix) {
      const bool to_fp = (opcode == 2u || opcode == 3u);
      const bool is_u = (opcode == 1u || opcode == 3u);
      if (!emit) {
        if (to_fp) {
          ctx.mark_gpr_read(rn);
          ctx.mark_fp_write(rd);
          if (ftype == 0u) ctx.fp_single_mask |= (1u << rd);
          else ctx.fp_double_mask |= (1u << rd);
        } else {
          ctx.mark_fp_read(rn, ftype == 0u ? 1 : 2);
          if (rd < 31u) ctx.mark_gpr_write(rd, is64_int);
        }
        ctx.uses_int64_t = true;
        ctx.uses_uint64_t = true;
        ctx.uses_int32 = true;
        ctx.uses_uint32 = true;
      } else if (tb) {
        rec();
        tb->put_str("    ");
        if (to_fp) {
          tb->put_reg_d(rd);
          if (is_u) tb->put_str(is64_int ? " = (double)(uint64_t)" : " = (double)(uint32_t)");
          else tb->put_str(is64_int ? " = (double)(int64_t)" : " = (double)(int32_t)");
          tb->put_reg_x(rn);
          if (fbits == 64u) {
            tb->put_str(" / 18446744073709551616.0;\n");
          } else {
            tb->put_str(" / (double)(1ULL << ");
            tb->put_u64_dec(fbits);
            tb->put_str(");\n");
          }
          emit_sync_d_to_q(tb, ctx, rd, ftype == 1u);
        } else if (rd < 31u) {
          tb->put_reg_x(rd);
          if (is64_int) tb->put_str(is_u ? " = (uint64)(" : " = (uint64)(int64_t)(");
          else tb->put_str(is_u ? " = (uint32_t)(" : " = (uint32_t)(int64_t)(");
          tb->put_reg_d(rn);
          if (fbits == 64u) {
            tb->put_str(" * 18446744073709551616.0);\n");
          } else {
            tb->put_str(" * (double)(1ULL << ");
            tb->put_u64_dec(fbits);
            tb->put_str("));\n");
          }
          ctx.clear_adrp(rd);
        }
      }
      return;
    }
  }

  // Part 3.7: BFM (BFI / BFXIL)
  if ((w & 0x7F800000u) == 0x33000000u && (((w >> 22u) & 1u) == ((w >> 31u) & 1u))) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t immr = (w >> 16u) & 0x3Fu;
    const uint32_t imms = (w >> 10u) & 0x3Fu;
    const uint32_t width = is64 ? 64u : 32u;
    if (is64 || (immr < 32u && imms < 32u)) {
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      if (!emit) {
        ctx.mark_gpr_read(rn);
        if (rd < 31u) {
          ctx.mark_gpr_read(rd);
          ctx.mark_gpr_write(rd, is64);
        }
        ctx.uses_uint32 = true;
        ctx.uses_uint64_t = true;
      } else if (tb && rd < 31u) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x(rd);
        tb->put_str(" = ");
        if (!is64) tb->put_str("(uint32_t)(");
        if (imms >= immr) {
          const uint32_t bits = imms - immr + 1u;
          const uint64_t mask = (bits >= 64u) ? ~0ULL : ((1ULL << bits) - 1ULL);
          tb->put_str("((");
          tb->put_reg_x(rd);
          tb->put_str(" & ~0x");
          tb->put_u64_hex(mask, true);
          tb->put_str("ULL) | ((");
          tb->put_reg_x(rn);
          tb->put_str(" >> ");
          tb->put_u64_dec(immr);
          tb->put_str(") & 0x");
          tb->put_u64_hex(mask, true);
          tb->put_str("ULL))");
        } else {
          const uint32_t lsb = (width - immr) & (width - 1u);
          const uint32_t bits = imms + 1u;
          const uint64_t mask = (bits >= 64u) ? ~0ULL : ((1ULL << bits) - 1ULL);
          const uint64_t ins_mask = mask << lsb;
          tb->put_str("((");
          tb->put_reg_x(rd);
          tb->put_str(" & ~0x");
          tb->put_u64_hex(ins_mask, true);
          tb->put_str("ULL) | ((");
          tb->put_reg_x(rn);
          tb->put_str(" & 0x");
          tb->put_u64_hex(mask, true);
          tb->put_str("ULL) << ");
          tb->put_u64_dec(lsb);
          tb->put_str("))");
        }
        if (!is64) tb->put_char(')');
        tb->put_str(";\n");
        ctx.clear_adrp(rd);
      }
      return;
    }
  }

  // Part 3.8: EXTR / ROR (immediate)
  if ((w & 0x7FA00000u) == 0x13800000u && (((w >> 22u) & 1u) == ((w >> 31u) & 1u))) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t lsb = (w >> 10u) & 0x3Fu;
    if (is64 || lsb < 32u) {
      const uint32_t rm = (w >> 16u) & 31u;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      const uint32_t width = is64 ? 64u : 32u;
      if (!emit) {
        ctx.mark_gpr_read(rn);
        ctx.mark_gpr_read(rm);
        if (rd < 31u) ctx.mark_gpr_write(rd, is64);
        ctx.uses_uint32 = true;
        ctx.uses_uint64_t = true;
      } else if (tb && rd < 31u) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x(rd);
        tb->put_str(" = ");
        if (lsb == 0u) {
          if (!is64) tb->put_str("(uint32_t)");
          tb->put_reg_x(rm);
        } else {
          tb->put_str(is64 ? "(((uint64_t)" : "(((uint32_t)");
          tb->put_reg_x(rm);
          tb->put_str(" >> ");
          tb->put_u64_dec(lsb);
          tb->put_str(is64 ? ") | ((uint64_t)" : ") | ((uint32_t)");
          tb->put_reg_x(rn);
          tb->put_str(" << ");
          tb->put_u64_dec(width - lsb);
          tb->put_str("))");
        }
        tb->put_str(";\n");
        ctx.clear_adrp(rd);
      }
      return;
    }
  }

  // Part 3.9: LD1R (AdvSIMD load single structure and replicate)
  if ((w & 0xBF60F000u) == 0x0D40C000u && (((w >> 23u) & 1u) != 0u || ((w >> 16u) & 31u) == 0u)) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const bool is_post = ((w >> 23u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t sz = (w >> 10u) & 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rt = w & 31u;
    if (is_128 || sz < 3u) {
      const uint32_t esize = 8u << sz;
      const uint32_t ebytes = esize / 8u;
      const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
      if (!emit) {
        ctx.uses_uintptr = true;
        if (rn == 31u) ctx.uses_sp = true;
        else {
          ctx.mark_gpr_read(rn);
          if (is_post) ctx.mark_gpr_write(rn);
        }
        if (is_post && rm < 31u) ctx.mark_gpr_read(rm);
        ctx.mark_q(rt);
        ctx.fp_written |= (1u << rt);
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        tb->put_str("    { ");
        tb->put_str(ut);
        tb->put_str(" __v = *(");
        tb->put_str(ut);
        tb->put_str(" *)((uintptr_t)(");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(")); uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) __vr |= (uint128)__v << (__k * ");
        tb->put_u64_dec(esize);
        tb->put_str("); ");
        tb->put_reg_q(rt);
        tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rt, esize == 64u);
        if (is_post) {
          rec();
          tb->put_str("    ");
          tb->put_reg_x_or_sp(rn);
          tb->put_str(" = ");
          tb->put_reg_x_or_sp(rn);
          tb->put_str(" + ");
          if (rm == 31u) tb->put_u64_dec(ebytes);
          else tb->put_reg_x(rm);
          tb->put_str(";\n");
          if (rn < 31u) ctx.clear_adrp(rn);
        }
      }
      return;
    }
  }

  // Part 3.9: LD1 / ST1 (1..4 regs) & ST2 (2 regs interleaved)
  if ((w & 0xBFBF0000u) == 0x0C000000u || (w & 0xBFA00000u) == 0x0C800000u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const bool is_post = ((w >> 23u) & 1u) != 0u;
    const bool is_load = ((w >> 22u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t opc = (w >> 12u) & 0xFu;
    const uint32_t sz = (w >> 10u) & 3u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rt = w & 31u;
    uint32_t nregs = 0u;
    const bool is_st2 = (!is_load && opc == 8u);
    if (opc == 7u) nregs = 1u;
    else if (opc == 10u) nregs = 2u;
    else if (opc == 6u) nregs = 3u;
    else if (opc == 2u) nregs = 4u;
    if (nregs > 0u || (is_st2 && (is_128 || sz < 3u))) {
      const uint32_t rbytes = is_128 ? 16u : 8u;
      if (!emit) {
        ctx.uses_uintptr = true;
        if (rn == 31u) ctx.uses_sp = true;
        else {
          ctx.mark_gpr_read(rn);
          if (is_post) ctx.mark_gpr_write(rn);
        }
        if (is_post && rm < 31u) ctx.mark_gpr_read(rm);
        if (is_st2) {
          ctx.mark_q(rt);
          ctx.mark_q((rt + 1u) & 31u);
          mark_neon_types(ctx, 8u << sz, false);
        } else {
          if (!is_128) ctx.uses_uint64_t = true;
          for (uint32_t r = 0u; r < nregs; ++r) {
            const uint32_t rg = (rt + r) & 31u;
            ctx.mark_q(rg);
            if (is_load) ctx.fp_written |= (1u << rg);
          }
        }
      } else if (tb) {
        if (is_st2) {
          const uint32_t esize = 8u << sz;
          const uint32_t ebytes = esize / 8u;
          const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
          const char* ut = neon_utype(esize);
          rec();
          tb->put_str("    for (int __k = 0; __k < ");
          tb->put_u64_dec(lanes);
          tb->put_str("; ++__k) { *(");
          tb->put_str(ut);
          tb->put_str(" *)((uintptr_t)(");
          tb->put_reg_x_or_sp(rn);
          tb->put_str(") + (__k * 2) * ");
          tb->put_u64_dec(ebytes);
          tb->put_str(") = (");
          tb->put_str(ut);
          tb->put_str(")(");
          tb->put_reg_q(rt);
          tb->put_str(" >> (__k * ");
          tb->put_u64_dec(esize);
          tb->put_str(")); *(");
          tb->put_str(ut);
          tb->put_str(" *)((uintptr_t)(");
          tb->put_reg_x_or_sp(rn);
          tb->put_str(") + (__k * 2 + 1) * ");
          tb->put_u64_dec(ebytes);
          tb->put_str(") = (");
          tb->put_str(ut);
          tb->put_str(")(");
          tb->put_reg_q((rt + 1u) & 31u);
          tb->put_str(" >> (__k * ");
          tb->put_u64_dec(esize);
          tb->put_str(")); }\n");
        } else {
          for (uint32_t r = 0u; r < nregs; ++r) {
            const uint32_t rg = (rt + r) & 31u;
            const int64_t off = static_cast<int64_t>(r * rbytes);
            rec();
            tb->put_str("    ");
            if (is_load) {
              tb->put_reg_q(rg);
              tb->put_str(is_128 ? " = *(uint128 *)(" : " = (uint128)*(uint64_t *)(");
              emit_mem_addr(*tb, rn, off);
              tb->put_str(");\n");
              emit_sync_q_to_d(tb, ctx, rg, sz == 3u);
            } else {
              tb->put_str(is_128 ? "*(uint128 *)(" : "*(uint64_t *)(");
              emit_mem_addr(*tb, rn, off);
              tb->put_str(is_128 ? ") = " : ") = (uint64_t)");
              tb->put_reg_q(rg);
              tb->put_str(";\n");
            }
          }
        }
        if (is_post) {
          const uint32_t total_bytes = (is_st2 ? 2u : nregs) * rbytes;
          rec();
          tb->put_str("    ");
          tb->put_reg_x_or_sp(rn);
          tb->put_str(" = ");
          tb->put_reg_x_or_sp(rn);
          tb->put_str(" + ");
          if (rm == 31u) tb->put_u64_dec(total_bytes);
          else tb->put_reg_x(rm);
          tb->put_str(";\n");
          if (rn < 31u) ctx.clear_adrp(rn);
        }
      }
      return;
    }
  }

  // Part 3.10a: 1-source GPR RBIT / REV16 / REV32 / REV / CLZ / CLS
  if ((w & 0x7FFFC000u) == 0x5AC00000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t opc = (w >> 10u) & 0x3Fu;
    if (opc <= 5u && !(!is64 && opc == 3u)) {
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      if (!emit) {
        ctx.mark_gpr_read(rn);
        if (rd < 31u) ctx.mark_gpr_write(rd, is64);
        ctx.uses_uint32 = true;
        ctx.uses_uint64_t = true;
      } else if (tb && rd < 31u) {
        rec();
        if (opc == 0u) {
          // RBIT
          const uint32_t width = is64 ? 64u : 32u;
          tb->put_str(is64 ? "    { uint64_t __rb = 0, __rv = (uint64_t)" : "    { uint32_t __rb = 0, __rv = (uint32_t)");
          tb->put_reg_x(rn);
          tb->put_str("; for (int __k = 0; __k < ");
          tb->put_u64_dec(width);
          tb->put_str("; ++__k) __rb = (__rb << 1) | ((__rv >> __k) & 1u); ");
          tb->put_reg_x(rd);
          tb->put_str(" = __rb; }\n");
        } else if (opc == 1u) {
          // REV16
          if (is64) {
            tb->put_str("    { uint64_t __rv = (uint64_t)");
            tb->put_reg_x(rn);
            tb->put_str("; ");
            tb->put_reg_x(rd);
            tb->put_str(" = ((__rv & 0x00FF00FF00FF00FFULL) << 8) | ((__rv >> 8) & 0x00FF00FF00FF00FFULL); }\n");
          } else {
            tb->put_str("    { uint32_t __rv = (uint32_t)");
            tb->put_reg_x(rn);
            tb->put_str("; ");
            tb->put_reg_x(rd);
            tb->put_str(" = ((__rv & 0x00FF00FFu) << 8) | ((__rv >> 8) & 0x00FF00FFu); }\n");
          }
        } else if (opc == 2u) {
          // REV (32-bit) or REV32 (64-bit)
          if (is64) {
            tb->put_str("    { uint64_t __rv = (uint64_t)");
            tb->put_reg_x(rn);
            tb->put_str("; ");
            tb->put_reg_x(rd);
            tb->put_str(" = ((uint64_t)__builtin_bswap32((uint32_t)__rv)) | ((uint64_t)__builtin_bswap32((uint32_t)(__rv >> 32)) << 32); }\n");
          } else {
            tb->put_str("    ");
            tb->put_reg_x(rd);
            tb->put_str(" = (uint32_t)__builtin_bswap32((uint32_t)");
            tb->put_reg_x(rn);
            tb->put_str(");\n");
          }
        } else if (opc == 3u) {
          // REV (64-bit)
          tb->put_str("    ");
          tb->put_reg_x(rd);
          tb->put_str(" = __builtin_bswap64((uint64_t)");
          tb->put_reg_x(rn);
          tb->put_str(");\n");
        } else if (opc == 4u) {
          // CLZ
          tb->put_str("    ");
          tb->put_reg_x(rd);
          if (is64) {
            tb->put_str(" = ((uint64_t)");
            tb->put_reg_x(rn);
            tb->put_str(" == 0ULL) ? 64ULL : (uint64)__builtin_clzll((uint64_t)");
            tb->put_reg_x(rn);
            tb->put_str(");\n");
          } else {
            tb->put_str(" = ((uint32_t)");
            tb->put_reg_x(rn);
            tb->put_str(" == 0u) ? 32u : (uint32_t)__builtin_clz((uint32_t)");
            tb->put_reg_x(rn);
            tb->put_str(");\n");
          }
        } else {
          // CLS
          if (is64) {
            tb->put_str("    { uint64_t __v = (uint64_t)");
            tb->put_reg_x(rn);
            tb->put_str("; uint64_t __x = __v ^ (__v >> 1); ");
            tb->put_reg_x(rd);
            tb->put_str(" = ((__x & 0x7FFFFFFFFFFFFFFFULL) == 0ULL) ? 63ULL : (uint64)(__builtin_clzll(__x & 0x7FFFFFFFFFFFFFFFULL) - 1); }\n");
          } else {
            tb->put_str("    { uint32_t __v = (uint32_t)");
            tb->put_reg_x(rn);
            tb->put_str("; uint32_t __x = __v ^ (__v >> 1); ");
            tb->put_reg_x(rd);
            tb->put_str(" = ((__x & 0x7FFFFFFFu) == 0u) ? 31u : (uint32_t)(__builtin_clz(__x & 0x7FFFFFFFu) - 1); }\n");
          }
        }
        ctx.clear_adrp(rd);
      }
      return;
    }
  }

  // Part 3.10b: Vector CNT (.8b/.16b), UADDLV, ZIP1/ZIP2
  if ((w & 0xBFFFFC00u) == 0x0E205800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    const uint32_t lanes = is_128 ? 16u : 8u;
    if (!emit) {
      ctx.mark_q(rn); ctx.mark_q(rd);
      ctx.fp_written |= (1u << rd);
      ctx.uses_uint8 = true;
    } else if (tb) {
      rec();
      tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
      tb->put_u64_dec(lanes);
      tb->put_str("; ++__k) __vr |= (uint128)(uint8_t)__builtin_popcount((uint8_t)(");
      tb->put_reg_q(rn);
      tb->put_str(" >> (__k * 8))) << (__k * 8); ");
      tb->put_reg_q(rd);
      tb->put_str(" = __vr; }\n");
      emit_sync_q_to_d(tb, ctx, rd);
    }
    return;
  }
  if ((w & 0xBF3FFC00u) == 0x2E303800u) {
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t sz = (w >> 22u) & 3u;
    if (sz <= 2u && (is_128 || sz < 2u)) {
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      const uint32_t esize = 8u << sz;
      const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        ctx.uses_uint64_t = true;
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        tb->put_str("    { uint64_t __s = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(lanes);
        tb->put_str("; ++__k) __s += (uint64_t)(");
        tb->put_str(neon_utype(esize));
        tb->put_str(")(");
        tb->put_reg_q(rn);
        tb->put_str(" >> (__k * ");
        tb->put_u64_dec(esize);
        tb->put_str(")); ");
        tb->put_reg_q(rd);
        tb->put_str(" = (uint128)__s; }\n");
        emit_sync_q_to_d(tb, ctx, rd, sz == 2u);
      }
      return;
    }
  }
  if ((w & 0xBF20BC00u) == 0x0E003800u) {
    // ZIP1 (bit 14 == 0) / ZIP2 (bit 14 == 1)
    const bool is_128 = ((w >> 30u) & 1u) != 0u;
    const uint32_t sz = (w >> 22u) & 3u;
    if (is_128 || sz < 3u) {
      const bool is_zip2 = ((w >> 14u) & 1u) != 0u;
      const uint32_t rm = (w >> 16u) & 31u;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      const uint32_t esize = 8u << sz;
      const uint32_t lanes = (is_128 ? 128u : 64u) / esize;
      const uint32_t half = lanes / 2u;
      const uint32_t base = is_zip2 ? half : 0u;
      if (!emit) {
        ctx.mark_q(rn); ctx.mark_q(rm); ctx.mark_q(rd);
        ctx.fp_written |= (1u << rd);
        mark_neon_types(ctx, esize, false);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(esize);
        tb->put_str("    { uint128 __vr = 0; for (int __k = 0; __k < ");
        tb->put_u64_dec(half);
        tb->put_str("; ++__k) { __vr |= (uint128)(");
        tb->put_str(ut);
        tb->put_str(")(");
        tb->put_reg_q(rn);
        tb->put_str(" >> ((");
        tb->put_u64_dec(base);
        tb->put_str(" + __k) * ");
        tb->put_u64_dec(esize);
        tb->put_str(")) << ((__k * 2) * ");
        tb->put_u64_dec(esize);
        tb->put_str("); __vr |= (uint128)(");
        tb->put_str(ut);
        tb->put_str(")(");
        tb->put_reg_q(rm);
        tb->put_str(" >> ((");
        tb->put_u64_dec(base);
        tb->put_str(" + __k) * ");
        tb->put_u64_dec(esize);
        tb->put_str(")) << ((__k * 2 + 1) * ");
        tb->put_u64_dec(esize);
        tb->put_str("); } ");
        tb->put_reg_q(rd);
        tb->put_str(" = __vr; }\n");
        emit_sync_q_to_d(tb, ctx, rd, sz == 3u);
      }
      return;
    }
  }

  // Part 3.11: LDR (literal) PC-relative load (GPR & FP/SIMD, excluding PRFM literal)
  if ((w & 0x3B000000u) == 0x18000000u) {
    const uint32_t opc = (w >> 30u) & 3u;
    const bool is_fp = ((w >> 26u) & 1u) != 0u;
    if (opc <= 2u) {
      const uint32_t rt = w & 31u;
      const int64_t delta = sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL;
      const uint64_t target = pc + static_cast<uint64_t>(delta);
      if (!emit) {
        ctx.add_global(target, is_fp && opc == 2u);
        if (is_fp) {
          if (opc == 2u) { ctx.mark_q(rt); ctx.uses_uintptr = true; }
          else {
            ctx.mark_fp_write(rt);
            ctx.uses_fp_bitcast = true;
            ctx.uses_uint32 = true;
            ctx.uses_uint64_t = true;
            if (opc == 0u) ctx.fp_single_mask |= (1u << rt);
            else ctx.fp_double_mask |= (1u << rt);
          }
        } else {
          if (rt < 31u) ctx.mark_gpr_write(rt, opc != 0u);
          if (opc == 0u) ctx.uses_uint32 = true;
          else if (opc == 2u) { ctx.uses_int32 = true; ctx.uses_int64_t = true; }
        }
      } else if (tb) {
        rec();
        tb->put_str("    ");
        if (is_fp) {
          if (opc == 2u) {
            tb->put_reg_q(rt);
            tb->put_str(" = *(uint128 *)((uintptr_t)(&global_");
            tb->put_u64_hex(target, true);
            tb->put_str("));\n");
            emit_sync_q_to_d(tb, ctx, rt);
          } else {
            tb->put_reg_d(rt);
            if (opc == 0u) {
              tb->put_str(" = (double)__hex_u32_to_f32((uint32_t)global_");
              tb->put_u64_hex(target, true);
              tb->put_str(");\n");
            } else {
              tb->put_str(" = __hex_u64_to_f64(global_");
              tb->put_u64_hex(target, true);
              tb->put_str(");\n");
            }
            emit_sync_d_to_q(tb, ctx, rt, opc == 1u);
          }
        } else if (rt == 31u) {
          tb->put_str("(void)global_");
          tb->put_u64_hex(target, true);
          tb->put_str(";\n");
        } else {
          tb->put_reg_x(rt);
          tb->put_str(opc == 0u ? " = (uint32_t)global_" : (opc == 2u ? " = (uint64)(int64_t)(int32_t)global_" : " = global_"));
          tb->put_u64_hex(target, true);
          tb->put_str(";\n");
          ctx.clear_adrp(rt);
        }
      }
      return;
    }
  }

  // Part 3.11: LSE Atomics: CAS/CASA/CASL/CASAL
  if ((w & 0x3FA07C00u) == 0x08A07C00u) {
    const uint32_t sz = (w >> 30u) & 3u;
    const uint32_t bits = 8u << sz;
    const uint32_t rs = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rt = w & 31u;
    if (!emit) {
      mark_mem_types(ctx, bits, false, false);
      if (bits == 64u) ctx.uses_uint64_t = true;
      if (rn == 31u) ctx.uses_sp = true;
      else ctx.mark_gpr_read(rn);
      ctx.mark_gpr_read(rt);
      if (rs < 31u) { ctx.mark_gpr_read(rs); ctx.mark_gpr_write(rs, bits == 64u); }
    } else if (tb) {
      rec();
      const char* ut = neon_utype(bits);
      tb->put_str("    { ");
      tb->put_str(ut);
      tb->put_str(" __old = *(");
      tb->put_str(ut);
      tb->put_str(" *)(");
      emit_mem_addr(*tb, rn, 0LL);
      tb->put_str("); if (__old == (");
      tb->put_str(ut);
      tb->put_str(")");
      tb->put_reg_x(rs);
      tb->put_str(") *(");
      tb->put_str(ut);
      tb->put_str(" *)(");
      emit_mem_addr(*tb, rn, 0LL);
      tb->put_str(") = (");
      tb->put_str(ut);
      tb->put_str(")");
      tb->put_reg_x(rt);
      tb->put_str(";");
      if (rs < 31u) {
        tb->put_char(' ');
        tb->put_reg_x(rs);
        tb->put_str(" = __old;");
        ctx.clear_adrp(rs);
      }
      tb->put_str(" }\n");
    }
    return;
  }

  // Part 3.11: LSE Atomics: LDADD / LDCLR / LDEOR / LDSET / SWP
  if ((w & 0x3F208C00u) == 0x38200000u || (w & 0x3F20FC00u) == 0x38208000u) {
    const bool is_swp = ((w & 0x3F20FC00u) == 0x38208000u);
    const uint32_t opc = (w >> 12u) & 7u;
    if (is_swp || opc <= 3u) {
      const uint32_t sz = (w >> 30u) & 3u;
      const uint32_t bits = 8u << sz;
      const uint32_t rs = (w >> 16u) & 31u;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rt = w & 31u;
      if (!emit) {
        mark_mem_types(ctx, bits, false, false);
        if (bits == 64u) ctx.uses_uint64_t = true;
        if (rn == 31u) ctx.uses_sp = true;
        else ctx.mark_gpr_read(rn);
        ctx.mark_gpr_read(rs);
        if (rt < 31u) ctx.mark_gpr_write(rt, bits == 64u);
      } else if (tb) {
        rec();
        const char* ut = neon_utype(bits);
        tb->put_str("    { ");
        tb->put_str(ut);
        tb->put_str(" __old = *(");
        tb->put_str(ut);
        tb->put_str(" *)(");
        emit_mem_addr(*tb, rn, 0LL);
        tb->put_str("); *(");
        tb->put_str(ut);
        tb->put_str(" *)(");
        emit_mem_addr(*tb, rn, 0LL);
        tb->put_str(") = ");
        if (is_swp) {
          tb->put_str("(");
          tb->put_str(ut);
          tb->put_str(")");
          tb->put_reg_x(rs);
        } else if (opc == 0u) {
          tb->put_str("__old + (");
          tb->put_str(ut);
          tb->put_str(")");
          tb->put_reg_x(rs);
        } else if (opc == 1u) {
          tb->put_str("__old & ~(");
          tb->put_str(ut);
          tb->put_str(")");
          tb->put_reg_x(rs);
        } else if (opc == 2u) {
          tb->put_str("__old ^ (");
          tb->put_str(ut);
          tb->put_str(")");
          tb->put_reg_x(rs);
        } else {
          tb->put_str("__old | (");
          tb->put_str(ut);
          tb->put_str(")");
          tb->put_reg_x(rs);
        }
        tb->put_str(";");
        if (rt < 31u) {
          tb->put_char(' ');
          tb->put_reg_x(rt);
          tb->put_str(" = __old;");
          ctx.clear_adrp(rt);
        }
        tb->put_str(" }\n");
      }
      return;
    }
  }

  // Fallback for any other valid ARM64 instruction: emit valid C11 statement + comment
  // (safe directly after a label before '}' under -std=c11, and carries a valid linemap stmt).
  if (emit && tb) {
    rec();
    tb->put_str("    (void)0; /* arm64 insn 0x");
    tb->put_u64_hex(w, true);
    tb->put_str(" */\n");
  }
}

}  // namespace


struct SLine {
  uint32_t off;
  uint32_t len;
  uint32_t orig_line;
  uint64_t label_id;
  uint32_t cond_off;
  uint32_t cond_len;
  const char* synth;
  uint32_t synth_len;
  uint16_t indent;
  int8_t brace_delta;
  uint8_t kind;  // 0=OTHER, 1=LABEL, 2=IF_GOTO, 3=GOTO, 4=SYNTH, 5=DELETED
};

static bool parse_hex_u64(const char* s, uint32_t n, uint64_t* out) {
  if (n == 0u || n > 16u) return false;
  uint64_t v = 0ULL;
  for (uint32_t i = 0u; i < n; ++i) {
    const char c = s[i];
    uint64_t d = 0ULL;
    if (c >= '0' && c <= '9') d = static_cast<uint64_t>(c - '0');
    else if (c >= 'A' && c <= 'F') d = static_cast<uint64_t>(c - 'A' + 10);
    else if (c >= 'a' && c <= 'f') d = static_cast<uint64_t>(c - 'a' + 10);
    else return false;
    v = (v << 4u) | d;
  }
  *out = v;
  return true;
}

static bool starts_with(const char* s, uint32_t len, const char* pat, uint32_t plen) {
  if (len < plen) return false;
  for (uint32_t i = 0u; i < plen; ++i) {
    if (s[i] != pat[i]) return false;
  }
  return true;
}

static bool ends_with(const char* s, uint32_t len, const char* pat, uint32_t plen) {
  if (len < plen) return false;
  for (uint32_t i = 0u; i < plen; ++i) {
    if (s[len - plen + i] != pat[i]) return false;
  }
  return true;
}

static const char* alloc_synth(hex::Arena& arena, const char* a, uint32_t alen, const char* b, uint32_t blen, const char* c, uint32_t clen, uint32_t* out_len) {
  const uint32_t total = alen + blen + clen;
  char* dst = arena.alloc<char>(total + 1u);
  if (!dst) return nullptr;
  uint32_t p = 0u;
  for (uint32_t i = 0u; i < alen; ++i) dst[p++] = a[i];
  for (uint32_t i = 0u; i < blen; ++i) dst[p++] = b[i];
  for (uint32_t i = 0u; i < clen; ++i) dst[p++] = c[i];
  dst[p] = '\0';
  *out_len = total;
  return dst;
}

static const char* alloc_neg_cond(hex::Arena& arena, const char* cond, uint32_t clen, const char* pre, uint32_t pre_len, const char* suf, uint32_t suf_len, uint32_t* out_len) {
  // Cleanly negate simple `X == 0u` / `X != 0u` / `X == 0` / `X != 0` when top-level
  int depth = 0;
  int eq_pos = -1;
  bool is_neq = false;
  for (uint32_t i = 0u; i + 4u <= clen; ++i) {
    if (cond[i] == '(') ++depth;
    else if (cond[i] == ')') --depth;
    else if (depth == 0) {
      if (cond[i] == '&' && cond[i + 1u] == '&') { eq_pos = -2; break; }
      if (cond[i] == '|' && cond[i + 1u] == '|') { eq_pos = -2; break; }
      if (i + 4u <= clen && cond[i] == ' ' && (cond[i + 1u] == '=' || cond[i + 1u] == '!') && cond[i + 2u] == '=' && cond[i + 3u] == ' ') {
        if (eq_pos == -1) { eq_pos = static_cast<int>(i); is_neq = (cond[i + 1u] == '!'); }
        else { eq_pos = -2; break; }
      }
    }
  }
  if (eq_pos > 0) {
    const uint32_t total = pre_len + clen + suf_len;
    char* dst = arena.alloc<char>(total + 1u);
    if (!dst) return nullptr;
    uint32_t p = 0u;
    for (uint32_t i = 0u; i < pre_len; ++i) dst[p++] = pre[i];
    for (uint32_t i = 0u; i < clen; ++i) {
      if (static_cast<int>(i) == eq_pos + 1) dst[p++] = is_neq ? '=' : '!';
      else dst[p++] = cond[i];
    }
    for (uint32_t i = 0u; i < suf_len; ++i) dst[p++] = suf[i];
    dst[p] = '\0';
    *out_len = total;
    return dst;
  }
  // Fallback: !(cond)
  const uint32_t total = pre_len + 2u + clen + 1u + suf_len;
  char* dst = arena.alloc<char>(total + 1u);
  if (!dst) return nullptr;
  uint32_t p = 0u;
  for (uint32_t i = 0u; i < pre_len; ++i) dst[p++] = pre[i];
  dst[p++] = '!';
  dst[p++] = '(';
  for (uint32_t i = 0u; i < clen; ++i) dst[p++] = cond[i];
  dst[p++] = ')';
  for (uint32_t i = 0u; i < suf_len; ++i) dst[p++] = suf[i];
  dst[p] = '\0';
  *out_len = total;
  return dst;
}

static bool structurize_c_body(
    TextBuf& tb,
    uint32_t body_start_off,
    uint32_t body_start_line,
    hex::Arena& work_arena,
    hex::Arena& emit_arena) {
  if (body_start_off >= tb.len) return false;
  const uint32_t body_len = tb.len - body_start_off;
  // Count lines in body
  uint32_t raw_lines = 0u;
  for (uint32_t i = body_start_off; i < tb.len; ++i) {
    if (tb.data[i] == '\n') ++raw_lines;
  }
  if (raw_lines < 2u || raw_lines > 8192u) return false;

  const uint32_t cap = raw_lines * 2u + 128u;
  SLine* stmts = work_arena.alloc<SLine>(cap);
  uint32_t* active = work_arena.alloc<uint32_t>(cap);
  int32_t* depth_arr = work_arena.alloc<int32_t>(cap);
  if (!stmts || !active || !depth_arr) return false;

  // Open-addressed hash table for O(1) label ref-count lookups (built once per iteration).
  uint32_t ht_cap = 256u;
  while (ht_cap < raw_lines * 2u && ht_cap < 32768u) ht_cap <<= 1u;
  uint64_t* ht_keys = work_arena.alloc<uint64_t>(ht_cap);
  uint32_t* ht_vals = work_arena.alloc<uint32_t>(ht_cap);
  uint8_t* ht_used = work_arena.alloc<uint8_t>(ht_cap);
  const bool ht_ok = (ht_keys && ht_vals && ht_used);

  uint32_t n = 0u;
  uint32_t cur = body_start_off;
  uint32_t cur_line = body_start_line;
  while (cur < tb.len && n < cap) {
    uint32_t nl = cur;
    while (nl < tb.len && tb.data[nl] != '\n') ++nl;
    const uint32_t llen = nl - cur;
    const char* s = tb.data + cur;
    SLine sl{};
    sl.off = cur;
    sl.len = llen;
    sl.orig_line = cur_line;
    sl.kind = 0u;
    if (llen > 5u && starts_with(s, llen, "loc_", 4u) && s[llen - 1u] == ':') {
      uint64_t lid = 0ULL;
      if (parse_hex_u64(s + 4u, llen - 5u, &lid)) {
        sl.kind = 1u;
        sl.label_id = lid;
      }
    } else if (llen > 14u && starts_with(s, llen, "    goto loc_", 13u) && s[llen - 1u] == ';') {
      uint64_t lid = 0ULL;
      if (parse_hex_u64(s + 13u, llen - 14u, &lid)) {
        sl.kind = 3u;
        sl.label_id = lid;
      }
    } else if (llen > 20u && starts_with(s, llen, "    if (", 8u) && s[llen - 1u] == ';') {
      // Find ") goto loc_" from right
      int found = -1;
      for (int k = static_cast<int>(llen) - 12; k >= 8; --k) {
        if (starts_with(s + k, llen - static_cast<uint32_t>(k), ") goto loc_", 11u)) {
          found = k;
          break;
        }
      }
      if (found > 8) {
        const uint32_t h_off = static_cast<uint32_t>(found) + 11u;
        const uint32_t h_len = llen - 1u - h_off;
        uint64_t lid = 0ULL;
        if (parse_hex_u64(s + h_off, h_len, &lid)) {
          sl.kind = 2u;
          sl.label_id = lid;
          sl.cond_off = cur + 8u;
          sl.cond_len = static_cast<uint32_t>(found) - 8u;
        }
      }
    }
    stmts[n++] = sl;
    cur = (nl < tb.len) ? (nl + 1u) : tb.len;
    ++cur_line;
  }

  auto build_ref_ht = [&](uint32_t acount) {
    if (!ht_ok) return;
    __builtin_memset(ht_used, 0, ht_cap);
    const uint32_t mask = ht_cap - 1u;
    for (uint32_t k = 0u; k < acount; ++k) {
      const SLine& x = stmts[active[k]];
      if (x.kind != 2u && x.kind != 3u) continue;
      const uint64_t key = x.label_id;
      uint32_t idx = static_cast<uint32_t>((key * 0x9E3779B97F4A7C15ULL) >> 32u) & mask;
      for (uint32_t probe = 0u; probe < ht_cap; ++probe) {
        if (ht_used[idx] == 0u) {
          ht_used[idx] = 1u;
          ht_keys[idx] = key;
          ht_vals[idx] = 1u;
          break;
        }
        if (ht_keys[idx] == key) {
          ++ht_vals[idx];
          break;
        }
        idx = (idx + 1u) & mask;
      }
    }
  };

  auto count_refs = [&](uint64_t lid, uint32_t acount) -> uint32_t {
    if (ht_ok) {
      const uint32_t mask = ht_cap - 1u;
      uint32_t idx = static_cast<uint32_t>((lid * 0x9E3779B97F4A7C15ULL) >> 32u) & mask;
      for (uint32_t probe = 0u; probe < ht_cap; ++probe) {
        if (ht_used[idx] == 0u) return 0u;
        if (ht_keys[idx] == lid) return ht_vals[idx];
        idx = (idx + 1u) & mask;
      }
      return 0u;
    }
    uint32_t rc = 0u;
    for (uint32_t k = 0u; k < acount; ++k) {
      const SLine& x = stmts[active[k]];
      if ((x.kind == 2u || x.kind == 3u) && x.label_id == lid) ++rc;
    }
    return rc;
  };

  auto insert_before = [&](uint32_t pos, const SLine& item) -> bool {
    if (n + 1u >= cap) return false;
    for (uint32_t k = n; k > pos; --k) stmts[k] = stmts[k - 1u];
    stmts[pos] = item;
    ++n;
    return true;
  };

  auto is_return_stmt = [&](const SLine& x) -> bool {
    if (x.kind == 0u) {
      const char* ns = tb.data + x.off;
      return starts_with(ns, x.len, "    return", 10u) && x.len >= 11u && ns[x.len - 1u] == ';';
    }
    if (x.kind == 4u && x.synth) {
      return starts_with(x.synth, x.synth_len, "    return", 10u) ||
             (x.brace_delta == 0 && starts_with(x.synth, x.synth_len, "    { ", 6u) &&
              ends_with(x.synth, x.synth_len, "; }", 3u));
    }
    return false;
  };

  auto is_terminator = [&](const SLine& x) -> bool {
    if (x.kind == 3u) return true;
    if (is_return_stmt(x)) return true;
    if (x.kind == 4u && x.synth && x.brace_delta == 0) {
      return starts_with(x.synth, x.synth_len, "    break;", 10u) ||
             starts_with(x.synth, x.synth_len, "    continue;", 13u);
    }
    return false;
  };

  auto strip4_off = [&](const SLine& se) -> uint32_t {
    const char* ss = tb.data + se.off;
    return (se.len >= 4u && ss[0] == ' ' && ss[1] == ' ' && ss[2] == ' ' && ss[3] == ' ') ? 4u : 0u;
  };

  auto has_bare_loop_ctrl = [&](uint32_t a0, uint32_t a1, int32_t /*d*/) -> bool {
    int32_t loop_stack[32];
    uint32_t loop_depth = 0u;
    for (uint32_t k = a0; k < a1; ++k) {
      const SLine& x = stmts[active[k]];
      if (x.kind == 4u && x.brace_delta > 0 && x.synth &&
          (starts_with(x.synth, x.synth_len, "    do {", 8u) ||
           starts_with(x.synth, x.synth_len, "    while (", 11u))) {
        if (loop_depth < 32u) loop_stack[loop_depth++] = depth_arr[k];
        else return true;  // conservative on extreme nesting
      } else if (x.kind == 4u && x.brace_delta < 0 && loop_depth > 0u &&
                 depth_arr[k] == loop_stack[loop_depth - 1u]) {
        --loop_depth;
      } else if (loop_depth == 0u && x.kind == 4u && x.synth &&
                 (ends_with(x.synth, x.synth_len, "break;", 6u) ||
                  ends_with(x.synth, x.synth_len, "continue;", 9u))) {
        return true;
      }
    }
    return false;
  };

  auto has_cross_entry = [&](uint32_t i, uint32_t j, uint32_t acount) -> bool {
    for (uint32_t m = i + 1u; m < j; ++m) {
      const SLine& sm = stmts[active[m]];
      if (sm.kind != 1u) continue;
      const uint64_t lid = sm.label_id;
      for (uint32_t k = 0u; k < i; ++k) {
        const SLine& sk = stmts[active[k]];
        if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == lid) return true;
      }
      for (uint32_t k = j + 1u; k < acount; ++k) {
        const SLine& sk = stmts[active[k]];
        if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == lid) return true;
      }
    }
    return false;
  };

  auto is_if_else_close = [&](uint32_t ck) -> bool {
    const SLine& sc = stmts[active[ck]];
    if (sc.kind != 4u || sc.brace_delta != -1 || !sc.synth) return false;
    if (!starts_with(sc.synth, sc.synth_len, "    }", 5u) ||
        starts_with(sc.synth, sc.synth_len, "    } while (", 13u)) {
      return false;
    }
    const int32_t cd = depth_arr[ck];
    for (int32_t b = static_cast<int32_t>(ck) - 1; b >= 0; --b) {
      if (depth_arr[b] == cd) {
        const SLine& sb = stmts[active[b]];
        return (sb.kind == 4u && sb.synth &&
                (starts_with(sb.synth, sb.synth_len, "    if (", 8u) ||
                 starts_with(sb.synth, sb.synth_len, "    } else {", 12u)));
      }
    }
    return false;
  };

  bool any_change = false;
  uint32_t r5_total_added = 0u;
  for (uint32_t iter = 0u; iter < 4096u; ++iter) {
    uint32_t acount = 0u;
    int32_t d = 0;
    for (uint32_t i = 0u; i < n; ++i) {
      if (stmts[i].kind == 5u) continue;
      const bool is_else_hdr = (stmts[i].kind == 4u && stmts[i].synth &&
                                starts_with(stmts[i].synth, stmts[i].synth_len, "    } else {", 12u));
      if (stmts[i].brace_delta < 0) d += stmts[i].brace_delta;
      active[acount] = i;
      depth_arr[acount] = is_else_hdr ? (d - 1) : d;
      if (stmts[i].brace_delta > 0) d += stmts[i].brace_delta;
      ++acount;
    }
    build_ref_ht(acount);

    bool changed = false;

    // Rule 0: Delete unreferenced labels
    for (uint32_t a = 0u; a < acount; ++a) {
      SLine& sl = stmts[active[a]];
      if (sl.kind == 1u && count_refs(sl.label_id, acount) == 0u) {
        sl.kind = 5u;
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // Rule 0b: Delete fallthrough goto / if-goto targeting the immediate next active label at same depth
    for (uint32_t a = 0u; a + 1u < acount; ++a) {
      SLine& sa = stmts[active[a]];
      const SLine& sb = stmts[active[a + 1u]];
      if ((sa.kind == 2u || sa.kind == 3u) && sb.kind == 1u && depth_arr[a] == depth_arr[a + 1u] && sa.label_id == sb.label_id) {
        sa.kind = 5u;
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // Rule 0c: Unreachable Dead-Code Elimination (DCE) after unconditional goto/return/break/continue
    for (uint32_t a = 0u; a + 1u < acount; ++a) {
      const SLine& sa = stmts[active[a]];
      if (!is_terminator(sa)) continue;
      const int32_t ad = depth_arr[a];
      for (uint32_t k = a + 1u; k < acount; ++k) {
        if (depth_arr[k] != ad) break;
        SLine& sk = stmts[active[k]];
        if (sk.kind == 1u || sk.brace_delta != 0) break;
        if (sk.kind == 4u && sk.synth && starts_with(sk.synth, sk.synth_len, "    } else {", 12u)) break;
        sk.kind = 5u;
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // Rule 0d: Multi-level IF/ELSE block-exit fallthrough deletion for unconditional `goto L;`
    // Deletes `goto L;` when crossing only IF/ELSE closing `}`s (never LOOP!) reaches `L:`.
    for (uint32_t a = 0u; a + 2u < acount; ++a) {
      SLine& sa = stmts[active[a]];
      if (sa.kind != 3u || depth_arr[a] <= 0) continue;
      int32_t cur_d = depth_arr[a];
      uint32_t k = a + 1u;
      uint32_t crossed = 0u;
      while (k < acount && cur_d > 0 && depth_arr[k] == cur_d - 1 && is_if_else_close(k)) {
        --cur_d;
        ++crossed;
        ++k;
      }
      if (crossed > 0u && k < acount && stmts[active[k]].kind == 1u &&
          depth_arr[k] == cur_d && stmts[active[k]].label_id == sa.label_id) {
        sa.kind = 5u;
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // Rule 0e: Adjacent-Label / Jump-to-Jump Forwarding
    // If `L1:` is immediately followed by `L2:` or `goto L2;` (L1 != L2, same depth), rewrite jumps targeting L1 -> L2.
    for (uint32_t a = 0u; a + 1u < acount && !changed; ++a) {
      const SLine& sl = stmts[active[a]];
      if (sl.kind != 1u) continue;
      const SLine& sb = stmts[active[a + 1u]];
      if (depth_arr[a + 1u] != depth_arr[a]) continue;
      if ((sb.kind == 1u || sb.kind == 3u) && sb.label_id != sl.label_id) {
        const uint64_t l1 = sl.label_id;
        const uint64_t l2 = sb.label_id;
        if (count_refs(l1, acount) > 0u) {
          for (uint32_t k = 0u; k < acount; ++k) {
            SLine& sk = stmts[active[k]];
            if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == l1) {
              sk.label_id = l2;
              changed = true;
              any_change = true;
            }
          }
        }
      }
    }
    if (changed) continue;

    // Rule 7: Short-circuit || merge: consecutive `if (C1) goto L; if (C2) goto L;` at same depth -> `if ((C1) || (C2)) goto L;`
    for (uint32_t a = 0u; a + 1u < acount && !changed; ++a) {
      SLine& s1 = stmts[active[a]];
      SLine& s2 = stmts[active[a + 1u]];
      if (s1.kind == 2u && s2.kind == 2u && depth_arr[a] == depth_arr[a + 1u] && s1.label_id == s2.label_id &&
          s1.cond_len + s2.cond_len < 512u) {
        // Combine into a single synthetic condition buffer stored in work_arena, keeping s1 as IF_GOTO
        const char* c1 = (s1.synth && s1.cond_off == 0xFFFFFFFFu) ? s1.synth : (tb.data + s1.cond_off);
        const char* c2 = (s2.synth && s2.cond_off == 0xFFFFFFFFu) ? s2.synth : (tb.data + s2.cond_off);
        const uint32_t mlen = 1u + s1.cond_len + 6u + s2.cond_len + 1u;
        char* mbuf = work_arena.alloc<char>(mlen + 1u);
        if (mbuf) {
          uint32_t p2 = 0u;
          mbuf[p2++] = '(';
          for (uint32_t z = 0u; z < s1.cond_len; ++z) mbuf[p2++] = c1[z];
          const char* mid = ") || (";
          for (uint32_t z = 0u; z < 6u; ++z) mbuf[p2++] = mid[z];
          for (uint32_t z = 0u; z < s2.cond_len; ++z) mbuf[p2++] = c2[z];
          mbuf[p2++] = ')';
          mbuf[p2] = '\0';
          s1.synth = mbuf;
          s1.cond_off = 0xFFFFFFFFu;
          s1.cond_len = p2;
          s2.kind = 5u;
          changed = true;
          any_change = true;
        }
      }
    }
    if (changed) continue;

    // Rule 5: Early-return epilogue folding (up to 24 straight-line stmts ending in `return ...;`, bounded by bloat budget):
    // Folds `goto L;` -> `<epilogue>` and `if (C) goto L;` -> `if (C) { <epilogue> }` (or `if (C) return ...;`).
    for (uint32_t a = 0u; a + 1u < acount && !changed; ++a) {
      const SLine& sl = stmts[active[a]];
      if (sl.kind != 1u) continue;
      const uint32_t refs = count_refs(sl.label_id, acount);
      if (refs == 0u) continue;
      const int32_t ld = depth_arr[a];
      int32_t ret_idx = -1;
      for (uint32_t k = a + 1u; k < acount && k <= a + 24u; ++k) {
        if (depth_arr[k] != ld || stmts[active[k]].kind != 0u) break;
        const SLine& sk = stmts[active[k]];
        const char* ns = tb.data + sk.off;
        if (starts_with(ns, sk.len, "    return", 10u) && sk.len >= 11u && ns[sk.len - 1u] == ';') {
          ret_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (ret_idx < 0) continue;
      const uint32_t ep_cnt = static_cast<uint32_t>(ret_idx) - a;  // 1..24 statements
      // Avoid duplicating a multi-stmt fallthrough epilogue when only 1 jump targets it (let Rule 4 wrap the skip cleanly).
      if (ep_cnt > 1u && refs == 1u && a > 0u && depth_arr[a - 1u] == ld && !is_terminator(stmts[active[a - 1u]])) continue;
      if (refs * ep_cnt > 320u) continue;
      // Compute combined inline epilogue text using identical strip4_off helper (bounded <= 1800 bytes)
      uint32_t ep_bytes = 0u;
      for (uint32_t e = 0u; e < ep_cnt; ++e) {
        const SLine& se = stmts[active[a + 1u + e]];
        ep_bytes += (se.len - strip4_off(se)) + (e > 0u ? 1u : 0u);
      }
      if (ep_bytes == 0u || ep_bytes > 1800u) continue;
      if (r5_total_added + refs * ep_bytes > tb.cap / 4u) continue;
      char* ep_txt = work_arena.alloc<char>(ep_bytes + 4u);
      if (!ep_txt) continue;
      uint32_t ep_len = 0u;
      for (uint32_t e = 0u; e < ep_cnt; ++e) {
        if (e > 0u) ep_txt[ep_len++] = ' ';
        const SLine& se = stmts[active[a + 1u + e]];
        const char* ss = tb.data + se.off;
        const uint32_t start = strip4_off(se);
        for (uint32_t z = start; z < se.len; ++z) ep_txt[ep_len++] = ss[z];
      }
      ep_txt[ep_len] = '\0';
      for (uint32_t k = 0u; k < acount; ++k) {
        SLine& sk = stmts[active[k]];
        if (sk.kind == 3u && sk.label_id == sl.label_id) {
          uint32_t rlen = 0u;
          const char* rtxt = (ep_cnt == 1u)
              ? alloc_synth(work_arena, "    ", 4u, ep_txt, ep_len, "", 0u, &rlen)
              : alloc_synth(work_arena, "    { ", 6u, ep_txt, ep_len, " }", 2u, &rlen);
          if (rtxt) {
            sk.kind = 4u; sk.synth = rtxt; sk.synth_len = rlen; sk.brace_delta = 0;
            r5_total_added += ep_len;
            changed = true; any_change = true;
          }
        } else if (sk.kind == 2u && sk.label_id == sl.label_id) {
          const char* cptr = (sk.cond_off == 0xFFFFFFFFu) ? sk.synth : (tb.data + sk.cond_off);
          const uint32_t extra = (ep_cnt == 1u) ? 2u : 6u;
          const uint32_t total = 8u + sk.cond_len + extra + ep_len;
          char* rtxt = work_arena.alloc<char>(total + 1u);
          if (rtxt) {
            uint32_t wp2 = 0u;
            const char* pfx = "    if (";
            for (uint32_t z = 0u; z < 8u; ++z) rtxt[wp2++] = pfx[z];
            for (uint32_t z = 0u; z < sk.cond_len; ++z) rtxt[wp2++] = cptr[z];
            if (ep_cnt == 1u) {
              rtxt[wp2++] = ')'; rtxt[wp2++] = ' ';
              for (uint32_t z = 0u; z < ep_len; ++z) rtxt[wp2++] = ep_txt[z];
            } else {
              const char* mid = ") { ";
              for (uint32_t z = 0u; z < 4u; ++z) rtxt[wp2++] = mid[z];
              for (uint32_t z = 0u; z < ep_len; ++z) rtxt[wp2++] = ep_txt[z];
              rtxt[wp2++] = ' '; rtxt[wp2++] = '}';
            }
            rtxt[wp2] = '\0';
            sk.kind = 4u; sk.synth = rtxt; sk.synth_len = wp2; sk.brace_delta = 0;
            r5_total_added += ep_len;
            changed = true; any_change = true;
          }
        }
      }
    }
    if (changed) continue;

    // Rule 8: Loop-continue folding with proper nested-loop stack tracking:
    // Inside `do { ... } while (C);` or `while (...) { ... }`, if `L_cont:` sits immediately before
    // the loop's closing brace, rewrite `goto L_cont;` / `if (C2) goto L_cont;` (outside nested loops) into `continue;`.
    for (uint32_t a = 0u; a < acount && !changed; ++a) {
      const SLine& sh = stmts[active[a]];
      if (sh.kind != 4u || sh.brace_delta != 1 || !sh.synth) continue;
      const bool is_loop_hdr = starts_with(sh.synth, sh.synth_len, "    do {", 8u) ||
                               starts_with(sh.synth, sh.synth_len, "    while (", 11u);
      if (!is_loop_hdr) continue;
      const int32_t ld = depth_arr[a];
      int32_t close_idx = -1;
      for (uint32_t k = a + 1u; k < acount; ++k) {
        if (depth_arr[k] == ld && stmts[active[k]].brace_delta == -1) {
          close_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (close_idx < 2 || stmts[active[close_idx - 1]].kind != 1u || depth_arr[close_idx - 1] != ld + 1) continue;
      const uint64_t cont_lid = stmts[active[close_idx - 1]].label_id;
      int32_t loop_stack[32];
      uint32_t loop_depth = 0u;
      for (uint32_t k = a + 1u; k < static_cast<uint32_t>(close_idx - 1); ++k) {
        SLine& sk = stmts[active[k]];
        if (sk.kind == 4u && sk.brace_delta == 1 && sk.synth &&
            (starts_with(sk.synth, sk.synth_len, "    do {", 8u) ||
             starts_with(sk.synth, sk.synth_len, "    while (", 11u))) {
          if (loop_depth < 32u) loop_stack[loop_depth++] = depth_arr[k];
          else break;
          continue;
        }
        if (sk.kind == 4u && sk.brace_delta == -1 && loop_depth > 0u &&
            depth_arr[k] == loop_stack[loop_depth - 1u]) {
          --loop_depth;
          continue;
        }
        if (loop_depth > 0u) continue;
        if (sk.kind == 3u && sk.label_id == cont_lid) {
          uint32_t clen2 = 0u;
          const char* ctxt = alloc_synth(work_arena, "    continue;", 13u, "", 0u, "", 0u, &clen2);
          if (ctxt) { sk.kind = 4u; sk.synth = ctxt; sk.synth_len = clen2; changed = true; any_change = true; }
        } else if (sk.kind == 2u && sk.label_id == cont_lid) {
          const char* cptr = (sk.cond_off == 0xFFFFFFFFu) ? sk.synth : (tb.data + sk.cond_off);
          uint32_t clen2 = 0u;
          const char* ctxt = alloc_synth(work_arena, "    if (", 8u, cptr, sk.cond_len, ") continue;", 11u, &clen2);
          if (ctxt) { sk.kind = 4u; sk.synth = ctxt; sk.synth_len = clen2; changed = true; any_change = true; }
        }
      }
    }
    if (changed) continue;

    // Rule 6: Loop-exit goto -> break; with proper nested-loop stack tracking.
    for (uint32_t a = 0u; a < acount && !changed; ++a) {
      const SLine& sh = stmts[active[a]];
      if (sh.kind != 4u || sh.brace_delta != 1 || !sh.synth) continue;
      const bool is_loop_hdr = starts_with(sh.synth, sh.synth_len, "    do {", 8u) ||
                               starts_with(sh.synth, sh.synth_len, "    while (", 11u);
      if (!is_loop_hdr) continue;
      const int32_t ld = depth_arr[a];
      int32_t close_idx = -1;
      for (uint32_t k = a + 1u; k < acount; ++k) {
        if (depth_arr[k] == ld && stmts[active[k]].brace_delta == -1) {
          close_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (close_idx < 0 || static_cast<uint32_t>(close_idx) + 1u >= acount) continue;
      const uint32_t nxt = static_cast<uint32_t>(close_idx) + 1u;
      if (stmts[active[nxt]].kind != 1u || depth_arr[nxt] != ld) continue;
      const uint64_t exit_lid = stmts[active[nxt]].label_id;
      int32_t loop_stack[32];
      uint32_t loop_depth = 0u;
      for (uint32_t k = a + 1u; k < static_cast<uint32_t>(close_idx); ++k) {
        SLine& sk = stmts[active[k]];
        if (sk.kind == 4u && sk.brace_delta == 1 && sk.synth &&
            (starts_with(sk.synth, sk.synth_len, "    do {", 8u) ||
             starts_with(sk.synth, sk.synth_len, "    while (", 11u))) {
          if (loop_depth < 32u) loop_stack[loop_depth++] = depth_arr[k];
          else break;
          continue;
        }
        if (sk.kind == 4u && sk.brace_delta == -1 && loop_depth > 0u &&
            depth_arr[k] == loop_stack[loop_depth - 1u]) {
          --loop_depth;
          continue;
        }
        if (loop_depth > 0u) continue;
        if (sk.kind == 3u && sk.label_id == exit_lid) {
          uint32_t blen = 0u;
          const char* btxt = alloc_synth(work_arena, "    break;", 10u, "", 0u, "", 0u, &blen);
          if (btxt) { sk.kind = 4u; sk.synth = btxt; sk.synth_len = blen; changed = true; any_change = true; }
        } else if (sk.kind == 2u && sk.label_id == exit_lid) {
          uint32_t blen = 0u;
          const char* btxt = alloc_synth(work_arena, "    if (", 8u, (sk.cond_off == 0xFFFFFFFFu ? sk.synth : (tb.data + sk.cond_off)), sk.cond_len, ") break;", 8u, &blen);
          if (btxt) { sk.kind = 4u; sk.synth = btxt; sk.synth_len = blen; changed = true; any_change = true; }
        }
      }
    }
    if (changed) continue;

    // Rule 1: GCC inverted loop: goto L_cond; L_body: <body>; L_cond: <0..12 straight stmts>; if (C) goto L_body;
    for (uint32_t g = 0u; g + 3u < acount && !changed; ++g) {
      const SLine& sg = stmts[active[g]];
      if (sg.kind != 3u) continue;
      const int32_t gd = depth_arr[g];
      const uint32_t b = g + 1u;
      if (depth_arr[b] != gd || stmts[active[b]].kind != 1u) continue;
      const uint64_t l_cond = sg.label_id;
      const uint64_t l_body = stmts[active[b]].label_id;
      if (l_cond == l_body) continue;
      if (count_refs(l_cond, acount) != 1u || count_refs(l_body, acount) != 1u) continue;

      // Find L_cond at same depth gd with no depth drop below gd
      int32_t c_idx = -1;
      for (uint32_t k = b + 1u; k < acount; ++k) {
        if (depth_arr[k] < gd) break;
        if (depth_arr[k] == gd && stmts[active[k]].kind == 1u && stmts[active[k]].label_id == l_cond) {
          c_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (c_idx < 0 || static_cast<uint32_t>(c_idx) <= b + 1u) continue;
      const uint32_t c = static_cast<uint32_t>(c_idx);
      if (has_bare_loop_ctrl(b + 1u, c, gd)) continue;

      // Check 0..12 straight OTHER stmts after c, ending with IF_GOTO -> l_body at depth gd
      int32_t e_idx = -1;
      for (uint32_t k = c + 1u; k < acount && k <= c + 13u; ++k) {
        if (depth_arr[k] != gd) break;
        const SLine& sk = stmts[active[k]];
        if (sk.kind == 2u && sk.label_id == l_body) {
          e_idx = static_cast<int32_t>(k);
          break;
        }
        if (sk.kind != 0u) break;
      }
      if (e_idx < 0) continue;
      const uint32_t e = static_cast<uint32_t>(e_idx);
      const SLine se_copy = stmts[active[e]];

      if (c + 1u == e) {
        // Pure while (C) { <body> }
        uint32_t slen = 0u;
        const char* hdr = alloc_synth(work_arena, "    while (", 11u, (se_copy.cond_off == 0xFFFFFFFFu ? se_copy.synth : (tb.data + se_copy.cond_off)), se_copy.cond_len, ") {", 3u, &slen);
        uint32_t clen = 0u;
        const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
        if (hdr && cls) {
          stmts[active[g]].kind = 4u; stmts[active[g]].synth = hdr; stmts[active[g]].synth_len = slen; stmts[active[g]].brace_delta = 1;
          stmts[active[b]].kind = 5u;
          stmts[active[c]].kind = 5u;
          stmts[active[e]].kind = 4u; stmts[active[e]].synth = cls; stmts[active[e]].synth_len = clen; stmts[active[e]].brace_delta = -1;
          for (uint32_t k = b + 1u; k < c; ++k) stmts[active[k]].indent++;
          changed = true;
          any_change = true;
        }
      } else {
        // while (1) { <cond_stmts> if (!(C)) break; <body> }
        const uint32_t ncond = e - (c + 1u);
        if (n + ncond + 3u < cap) {
          uint32_t hlen = 0u, blen = 0u, clen = 0u;
          const char* hdr = alloc_synth(work_arena, "    while (1) {", 15u, "", 0u, "", 0u, &hlen);
          const char* brk = alloc_neg_cond(work_arena, (se_copy.cond_off == 0xFFFFFFFFu ? se_copy.synth : (tb.data + se_copy.cond_off)), se_copy.cond_len, "    if (", 8u, ") break;", 8u, &blen);
          const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
          if (hdr && brk && cls) {
            SLine cond_buf[16];
            for (uint32_t k = 0u; k < ncond; ++k) {
              cond_buf[k] = stmts[active[c + 1u + k]];
              cond_buf[k].indent++;
              stmts[active[c + 1u + k]].kind = 5u;
            }
            const uint32_t base_indent = stmts[active[g]].indent;
            stmts[active[g]].kind = 4u; stmts[active[g]].synth = hdr; stmts[active[g]].synth_len = hlen; stmts[active[g]].brace_delta = 1;
            stmts[active[b]].kind = 5u;
            stmts[active[c]].kind = 5u;
            stmts[active[e]].kind = 4u; stmts[active[e]].synth = cls; stmts[active[e]].synth_len = clen; stmts[active[e]].brace_delta = -1;
            for (uint32_t k = b + 1u; k < c; ++k) stmts[active[k]].indent++;
            uint32_t ins_pos = active[b] + 1u;
            for (uint32_t k = 0u; k < ncond; ++k) {
              insert_before(ins_pos++, cond_buf[k]);
            }
            SLine brk_sl{};
            brk_sl.kind = 4u; brk_sl.synth = brk; brk_sl.synth_len = blen;
            brk_sl.indent = static_cast<uint16_t>(base_indent + 1u);
            brk_sl.orig_line = se_copy.orig_line;
            insert_before(ins_pos, brk_sl);
            changed = true;
            any_change = true;
          }
        }
      }
    }
    if (changed) continue;

    // Rule 5b: Single-Ref Cold Tail-Block Inlining (before Rule 2):
    // If `L_cold:` has count_refs == 1, is preceded by a terminator, and has 1..8 straight-line `kind == 0`
    // statements ending in `goto L_join;` or `return`, inline it at its single jump site and delete `L_cold:`.
    for (uint32_t a = 1u; a + 1u < acount && !changed; ++a) {
      const SLine& sl = stmts[active[a]];
      if (sl.kind != 1u) continue;
      if (count_refs(sl.label_id, acount) != 1u) continue;
      const int32_t ld = depth_arr[a];
      if (depth_arr[a - 1u] != ld || !is_terminator(stmts[active[a - 1u]])) continue;

      int32_t end_idx = -1;
      for (uint32_t k = a + 1u; k < acount && k <= a + 9u; ++k) {
        if (depth_arr[k] != ld) break;
        const SLine& sk = stmts[active[k]];
        if (sk.kind == 3u) {
          if (sk.label_id != sl.label_id && k > a + 1u && k <= a + 9u) {
            end_idx = static_cast<int32_t>(k);
          }
          break;
        }
        if (sk.kind == 0u) {
          if (is_return_stmt(sk)) {
            if (k <= a + 8u) end_idx = static_cast<int32_t>(k);
            break;
          }
          continue;
        }
        break;
      }
      if (end_idx < 0) continue;
      const uint32_t e = static_cast<uint32_t>(end_idx);
      const uint32_t cnt = e - a;  // 1..9 statements (up to 8 body + 1 goto, or up to 8 incl return)
      if (cnt == 0u || cnt > 9u) continue;

      // Find the single jump site targeting L_cold
      int32_t j_idx = -1;
      for (uint32_t k = 0u; k < acount; ++k) {
        const SLine& sk = stmts[active[k]];
        if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == sl.label_id) {
          j_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (j_idx < 0) continue;
      const uint32_t ju = static_cast<uint32_t>(j_idx);
      if (ju >= a && ju <= e) continue;  // never self-inline

      SLine blk_buf[10];
      for (uint32_t k = 0u; k < cnt; ++k) blk_buf[k] = stmts[active[a + 1u + k]];
      const SLine sj_copy = stmts[active[ju]];
      const uint32_t j_stmt_pos = active[ju];

      if (sj_copy.kind == 3u) {
        if (n + cnt < cap) {
          for (uint32_t k = a; k <= e; ++k) stmts[active[k]].kind = 5u;
          blk_buf[0].indent = sj_copy.indent;
          stmts[j_stmt_pos] = blk_buf[0];
          uint32_t ins_pos = j_stmt_pos + 1u;
          for (uint32_t k = 1u; k < cnt; ++k) {
            blk_buf[k].indent = sj_copy.indent;
            insert_before(ins_pos++, blk_buf[k]);
          }
          changed = true;
          any_change = true;
        }
      } else if (sj_copy.kind == 2u) {
        if (n + cnt + 2u < cap) {
          const char* cptr = (sj_copy.cond_off == 0xFFFFFFFFu) ? sj_copy.synth : (tb.data + sj_copy.cond_off);
          uint32_t hlen = 0u, clen = 0u;
          const char* hdr = alloc_synth(work_arena, "    if (", 8u, cptr, sj_copy.cond_len, ") {", 3u, &hlen);
          const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
          if (hdr && cls) {
            for (uint32_t k = a; k <= e; ++k) stmts[active[k]].kind = 5u;
            stmts[j_stmt_pos].kind = 4u;
            stmts[j_stmt_pos].synth = hdr;
            stmts[j_stmt_pos].synth_len = hlen;
            stmts[j_stmt_pos].brace_delta = 1;
            uint32_t ins_pos = j_stmt_pos + 1u;
            for (uint32_t k = 0u; k < cnt; ++k) {
              blk_buf[k].indent = static_cast<uint16_t>(sj_copy.indent + 1u);
              insert_before(ins_pos++, blk_buf[k]);
            }
            SLine cls_sl{};
            cls_sl.kind = 4u; cls_sl.synth = cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
            cls_sl.indent = sj_copy.indent;
            cls_sl.orig_line = sj_copy.orig_line;
            insert_before(ins_pos, cls_sl);
            changed = true;
            any_change = true;
          }
        }
      }
    }
    if (changed) continue;

    // Rule 2: Backward loop: L: <body>; if (C) goto L; (or goto L;)
    // Guarded by no-cross-entry check and top-level return separation check for multi-ref while(1).
    int32_t best_li = -1, best_lj = -1;
    uint32_t best_lspan = 0xFFFFFFFFu;
    uint32_t best_lrefs = 0u;
    for (uint32_t i = 0u; i + 1u < acount; ++i) {
      const SLine& si = stmts[active[i]];
      if (si.kind != 1u) continue;
      const uint32_t refs = count_refs(si.label_id, acount);
      if (refs == 0u) continue;
      const int32_t id = depth_arr[i];
      for (uint32_t j = i + 1u; j < acount; ++j) {
        if (depth_arr[j] < id) break;
        const SLine& sj = stmts[active[j]];
        if (depth_arr[j] == id && (sj.kind == 2u || sj.kind == 3u) && sj.label_id == si.label_id) {
          bool ok_loop = (j > i + 1u) && !has_bare_loop_ctrl(i + 1u, j, id) && !has_cross_entry(i, j, acount);
          if (ok_loop && sj.kind == 3u && refs > 1u) {
            for (uint32_t k = i + 1u; k < j; ++k) {
              if (depth_arr[k] == id && is_return_stmt(stmts[active[k]])) {
                ok_loop = false;
                break;
              }
            }
          }
          if (ok_loop && (j - i) < best_lspan) {
            best_lspan = j - i;
            best_li = static_cast<int32_t>(i);
            best_lj = static_cast<int32_t>(j);
            best_lrefs = refs;
          }
          break;
        }
      }
    }
    if (best_li >= 0) {
      const uint32_t i = static_cast<uint32_t>(best_li);
      const uint32_t j = static_cast<uint32_t>(best_lj);
      const SLine sj_copy = stmts[active[j]];
      uint32_t hlen = 0u, clen = 0u;
      const char* hdr = (sj_copy.kind == 2u)
          ? alloc_synth(work_arena, "    do {", 8u, "", 0u, "", 0u, &hlen)
          : alloc_synth(work_arena, "    while (1) {", 15u, "", 0u, "", 0u, &hlen);
      const char* cls = (sj_copy.kind == 2u)
          ? alloc_synth(work_arena, "    } while (", 13u, (sj_copy.cond_off == 0xFFFFFFFFu ? sj_copy.synth : (tb.data + sj_copy.cond_off)), sj_copy.cond_len, ");", 2u, &clen)
          : alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
      if (hdr && cls) {
        if (best_lrefs == 1u) {
          stmts[active[i]].kind = 4u; stmts[active[i]].synth = hdr; stmts[active[i]].synth_len = hlen; stmts[active[i]].brace_delta = 1;
          stmts[active[i]].indent = sj_copy.indent;
          stmts[active[j]].kind = 4u; stmts[active[j]].synth = cls; stmts[active[j]].synth_len = clen; stmts[active[j]].brace_delta = -1;
          for (uint32_t k = i + 1u; k < j; ++k) stmts[active[k]].indent++;
          changed = true;
          any_change = true;
        } else if (n + 1u < cap) {
          stmts[active[j]].kind = 4u; stmts[active[j]].synth = cls; stmts[active[j]].synth_len = clen; stmts[active[j]].brace_delta = -1;
          for (uint32_t k = i + 1u; k < j; ++k) stmts[active[k]].indent++;
          SLine hdr_sl{};
          hdr_sl.kind = 4u; hdr_sl.synth = hdr; hdr_sl.synth_len = hlen; hdr_sl.brace_delta = 1;
          hdr_sl.indent = sj_copy.indent;
          hdr_sl.orig_line = stmts[active[i]].orig_line;
          insert_before(active[i] + 1u, hdr_sl);
          changed = true;
          any_change = true;
        }
      }
    }
    if (changed) continue;

    // Rule 3: Diamond if-else: if (C) goto L1; <then> goto L2; L1: <else> L2: (innermost first)
    int32_t best_ei = -1, best_em = -1, best_ee = -1;
    uint32_t best_espan = 0xFFFFFFFFu;
    for (uint32_t i = 0u; i + 4u < acount; ++i) {
      const SLine& si = stmts[active[i]];
      if (si.kind != 2u || count_refs(si.label_id, acount) != 1u) continue;
      const int32_t id = depth_arr[i];
      int32_t m_idx = -1;
      for (uint32_t k = i + 1u; k < acount; ++k) {
        if (depth_arr[k] < id) break;
        if (depth_arr[k] == id && stmts[active[k]].kind == 1u && stmts[active[k]].label_id == si.label_id) {
          m_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (m_idx < 0 || static_cast<uint32_t>(m_idx) <= i + 2u) continue;
      const uint32_t m = static_cast<uint32_t>(m_idx);
      if (depth_arr[m - 1u] != id || stmts[active[m - 1u]].kind != 3u) continue;
      const uint64_t l2 = stmts[active[m - 1u]].label_id;
      int32_t e_idx = -1;
      for (uint32_t k = m + 1u; k < acount; ++k) {
        if (depth_arr[k] < id) break;
        if (depth_arr[k] == id && stmts[active[k]].kind == 1u && stmts[active[k]].label_id == l2) {
          e_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (e_idx < 0 || static_cast<uint32_t>(e_idx) <= m + 1u) continue;
      const uint32_t e = static_cast<uint32_t>(e_idx);
      if ((e - i) < best_espan) {
        best_espan = e - i;
        best_ei = static_cast<int32_t>(i);
        best_em = static_cast<int32_t>(m);
        best_ee = static_cast<int32_t>(e);
      }
    }
    if (best_ei >= 0) {
      const uint32_t i = static_cast<uint32_t>(best_ei);
      const uint32_t m = static_cast<uint32_t>(best_em);
      const uint32_t e = static_cast<uint32_t>(best_ee);
      const SLine si_copy = stmts[active[i]];
      uint32_t hlen = 0u, elen = 0u, clen = 0u;
      const char* hdr = alloc_neg_cond(work_arena, (si_copy.cond_off == 0xFFFFFFFFu ? si_copy.synth : (tb.data + si_copy.cond_off)), si_copy.cond_len, "    if (", 8u, ") {", 3u, &hlen);
      const char* els = alloc_synth(work_arena, "    } else {", 12u, "", 0u, "", 0u, &elen);
      const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
      if (hdr && els && cls && n + 1u < cap) {
        stmts[active[i]].kind = 4u; stmts[active[i]].synth = hdr; stmts[active[i]].synth_len = hlen; stmts[active[i]].brace_delta = 1;
        stmts[active[m - 1u]].kind = 5u;
        stmts[active[m]].kind = 4u; stmts[active[m]].synth = els; stmts[active[m]].synth_len = elen; stmts[active[m]].brace_delta = 0;
        stmts[active[m]].indent = si_copy.indent;
        for (uint32_t k = i + 1u; k < m - 1u; ++k) stmts[active[k]].indent++;
        for (uint32_t k = m + 1u; k < e; ++k) stmts[active[k]].indent++;
        SLine cls_sl{};
        cls_sl.kind = 4u; cls_sl.synth = cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
        cls_sl.indent = si_copy.indent;
        cls_sl.orig_line = stmts[active[e]].orig_line;
        insert_before(active[e], cls_sl);
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // Rule 4: Forward conditional skip: if (C) goto L; <body> L: (innermost first, guarded by no-cross-entry)
    int32_t best_fi = -1, best_fj = -1;
    uint32_t best_fspan = 0xFFFFFFFFu;
    for (uint32_t i = 0u; i + 2u < acount; ++i) {
      const SLine& si = stmts[active[i]];
      if (si.kind != 2u) continue;
      const int32_t id = depth_arr[i];
      for (uint32_t j = i + 1u; j < acount; ++j) {
        if (depth_arr[j] < id) break;
        if (depth_arr[j] == id && stmts[active[j]].kind == 1u && stmts[active[j]].label_id == si.label_id) {
          if (j > i + 1u && !has_cross_entry(i, j, acount) && (j - i) < best_fspan) {
            best_fspan = j - i;
            best_fi = static_cast<int32_t>(i);
            best_fj = static_cast<int32_t>(j);
          }
          break;
        }
      }
    }
    if (best_fi >= 0) {
      const uint32_t i = static_cast<uint32_t>(best_fi);
      const uint32_t j = static_cast<uint32_t>(best_fj);
      const SLine si_copy = stmts[active[i]];
      uint32_t hlen = 0u, clen = 0u;
      const char* hdr = alloc_neg_cond(work_arena, (si_copy.cond_off == 0xFFFFFFFFu ? si_copy.synth : (tb.data + si_copy.cond_off)), si_copy.cond_len, "    if (", 8u, ") {", 3u, &hlen);
      const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
      if (hdr && cls && n + 1u < cap) {
        stmts[active[i]].kind = 4u; stmts[active[i]].synth = hdr; stmts[active[i]].synth_len = hlen; stmts[active[i]].brace_delta = 1;
        for (uint32_t k = i + 1u; k < j; ++k) stmts[active[k]].indent++;
        SLine cls_sl{};
        cls_sl.kind = 4u; cls_sl.synth = cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
        cls_sl.indent = si_copy.indent;
        cls_sl.orig_line = stmts[active[j]].orig_line;
        insert_before(active[j], cls_sl);
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // Rule 4b / 4c: Multi-level IF/ELSE block-exit conditional skip:
    // Walks up one or more enclosing IF/ELSE closing `}`s (never LOOP!) to see if `L:` immediately follows.
    for (uint32_t i = 0u; i + 2u < acount && !changed; ++i) {
      const SLine& si = stmts[active[i]];
      if (si.kind != 2u || depth_arr[i] <= 0) continue;
      const int32_t id = depth_arr[i];
      // Find matching closing brace at depth id - 1
      int32_t close_k = -1;
      for (uint32_t k = i + 1u; k < acount; ++k) {
        if (depth_arr[k] == id - 1) {
          if (is_if_else_close(k)) close_k = static_cast<int32_t>(k);
          break;
        }
      }
      if (close_k < 0 || static_cast<uint32_t>(close_k) <= i + 1u || static_cast<uint32_t>(close_k) + 1u >= acount) continue;
      const uint32_t ck = static_cast<uint32_t>(close_k);
      if (has_cross_entry(i, ck, acount)) continue;
      // Walk up any additional enclosing IF/ELSE closing `}`s (never LOOP!)
      int32_t cur_d = id - 1;
      uint32_t lbl_k = ck + 1u;
      while (lbl_k < acount && cur_d > 0 && depth_arr[lbl_k] == cur_d - 1 && is_if_else_close(lbl_k)) {
        --cur_d;
        ++lbl_k;
      }
      if (lbl_k < acount && stmts[active[lbl_k]].kind == 1u && depth_arr[lbl_k] == cur_d &&
          stmts[active[lbl_k]].label_id == si.label_id && n + 1u < cap) {
        const SLine si_copy = si;
        uint32_t hlen = 0u, clen = 0u;
        const char* hdr = alloc_neg_cond(work_arena, (si_copy.cond_off == 0xFFFFFFFFu ? si_copy.synth : (tb.data + si_copy.cond_off)), si_copy.cond_len, "    if (", 8u, ") {", 3u, &hlen);
        const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
        if (hdr && cls) {
          stmts[active[i]].kind = 4u; stmts[active[i]].synth = hdr; stmts[active[i]].synth_len = hlen; stmts[active[i]].brace_delta = 1;
          for (uint32_t k = i + 1u; k < ck; ++k) stmts[active[k]].indent++;
          SLine cls_sl{};
          cls_sl.kind = 4u; cls_sl.synth = cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
          cls_sl.indent = si_copy.indent;
          cls_sl.orig_line = stmts[active[ck]].orig_line;
          insert_before(active[ck], cls_sl);
          changed = true;
          any_change = true;
        }
      }
    }
    if (!changed) break;
  }

  if (!any_change) return false;

  // Rebuild text buffer into emit_arena (returned to caller) & remap linemap using work_arena
  const uint32_t est_cap = tb.len + (tb.len / 2u) + 16384u;
  const uint32_t new_cap = (est_cap < tb.cap) ? est_cap : tb.cap;
  char* out_mem = emit_arena.alloc<char>(new_cap);
  const uint32_t max_orig = body_start_line + raw_lines + 4u;
  uint32_t* line_remap = work_arena.alloc<uint32_t>(max_orig + 1u);
  if (!out_mem || !line_remap) return false;
  for (uint32_t i = 0u; i <= max_orig; ++i) line_remap[i] = 0u;

  uint32_t wp = 0u;
  auto put_ch = [&](char ch) {
    if (wp + 1u < new_cap) out_mem[wp++] = ch;
  };
  auto put_mem = [&](const char* s, uint32_t l) {
    for (uint32_t i = 0u; i < l; ++i) put_ch(s[i]);
  };
  auto put_hex = [&](uint64_t hv) {
    char hbuf[20];
    uint32_t hlen = 0u;
    if (hv == 0ULL) hbuf[hlen++] = '0';
    else {
      char tmp[20]; uint32_t tn = 0u;
      while (hv > 0ULL) {
        const uint32_t d4 = static_cast<uint32_t>(hv & 0xFu);
        tmp[tn++] = static_cast<char>(d4 < 10u ? ('0' + d4) : ('A' + d4 - 10u));
        hv >>= 4u;
      }
      while (tn > 0u) hbuf[hlen++] = tmp[--tn];
    }
    put_mem(hbuf, hlen);
  };

  // Copy prelude verbatim
  put_mem(tb.data, body_start_off);
  for (uint32_t l = 1u; l < body_start_line && l <= max_orig; ++l) line_remap[l] = l;

  uint32_t out_line = body_start_line;
  bool prev_was_label = false;
  for (uint32_t i = 0u; i < n; ++i) {
    const SLine& sl = stmts[i];
    if (sl.kind == 5u) continue;
    const bool is_close = (sl.kind == 4u && sl.synth && sl.synth_len >= 5u && sl.synth[4] == '}');
    if (prev_was_label && is_close) {
      for (uint16_t sp = 0u; sp < sl.indent + 1u; ++sp) put_mem("    ", 4u);
      put_mem("(void)0;\n", 9u);
      ++out_line;
    }
    if (sl.orig_line <= max_orig && line_remap[sl.orig_line] == 0u) {
      line_remap[sl.orig_line] = out_line;
    }
    if (sl.kind != 1u) {
      for (uint16_t sp = 0u; sp < sl.indent; ++sp) put_mem("    ", 4u);
    }
    if (sl.kind == 4u) {
      put_mem(sl.synth, sl.synth_len);
    } else if (sl.kind == 2u) {
      const char* cptr = (sl.cond_off == 0xFFFFFFFFu && sl.synth) ? sl.synth : (tb.data + sl.cond_off);
      put_mem("    if (", 8u);
      put_mem(cptr, sl.cond_len);
      put_mem(") goto loc_", 11u);
      put_hex(sl.label_id);
      put_ch(';');
    } else if (sl.kind == 3u) {
      put_mem("    goto loc_", 13u);
      put_hex(sl.label_id);
      put_ch(';');
    } else {
      put_mem(tb.data + sl.off, sl.len);
    }
    put_ch('\n');
    ++out_line;
    prev_was_label = (sl.kind == 1u);
  }
  if (prev_was_label) {
    put_mem("    (void)0;\n", 13u);
    ++out_line;
  }
  if (wp + 4u >= new_cap) return false;
  out_mem[wp] = '\0';

  // Fill any unmapped orig lines (from deleted labels/gotos) with nearest following line
  uint32_t last_valid = (out_line > 1u) ? (out_line - 1u) : 1u;
  for (int32_t l = static_cast<int32_t>(max_orig); l >= 1; --l) {
    if (line_remap[l] != 0u) last_valid = line_remap[l];
    else line_remap[l] = last_valid;
  }
  for (uint32_t k = 0u; k < tb.lm_count; ++k) {
    const uint32_t ol = tb.lm[k].line_no;
    if (ol >= 1u && ol <= max_orig) tb.lm[k].line_no = line_remap[ol];
  }

  tb.data = out_mem;
  tb.len = wp;
  tb.line_no = out_line;
  (void)body_len;
  return true;
}

HexStatus try_emit_arm64_general(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t /*emit_flags*/,
    hex::Arena& emit_arena,
    const char** out_text,
    uint32_t* out_text_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  if (!words || word_count < kMinGeneralWords || word_count > kMaxGeneralWords ||
      !out_text || !out_text_len || !out_linemap || !out_linemap_count) {
    return HEX_ERR_UNSUPPORTED;
  }
  // Preserve exact JS lines/sourceMap parity on 5-word synthetic framed single-ALU stubs
  // (`stp x29, x30, [sp, #-N]! ; mov x29, sp ; add/sub reg ; ldp x29, x30, [sp], #N ; ret`).
  if (word_count == 5u &&
      words[0] == 0xA9BF7BFDu &&
      words[1] == 0x910003FDu &&
      (words[2] & 0x1F200000u) == 0x0B000000u &&
      words[3] == 0xA8C17BFDu &&
      words[4] == 0xD65F03C0u) {
    return HEX_ERR_UNSUPPORTED;
  }

  const uint64_t byte_len = static_cast<uint64_t>(word_count) * 4ULL;
  if (base_addr + byte_len < base_addr) {
    return HEX_ERR_UNSUPPORTED;
  }

  char norm_name[kMaxNormNameLen + 1u];
  uint32_t norm_len = 0u;
  if (!normalize_func_name(func_name_utf8, func_name_len, base_addr, norm_name, sizeof(norm_name), &norm_len)) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Allocate temp tables in work_arena (scratch when available) and output buffers in emit_arena.
  hex::Arena& work_arena = g_general_scratch_arena ? *g_general_scratch_arena : emit_arena;
  uint8_t* is_label = work_arena.alloc<uint8_t>(word_count);
  uint8_t* has_back_edge = work_arena.alloc<uint8_t>(word_count);
  AnalysisCtx* ctx_ptr = work_arena.alloc<AnalysisCtx>(1u);
  uint32_t text_cap = (word_count <= 512u) ? kMaxTextCap : ((word_count <= 2048u) ? 393216u : 786432u);
  if (word_count > 2048u) {
    const size_t avail = (emit_arena.capacity() > emit_arena.used()) ? (emit_arena.capacity() - emit_arena.used()) : 0u;
    if (emit_arena.allow_wasm_grow() || avail >= (1024u * 1024u + 131072u)) {
      text_cap = 1024u * 1024u;
    }
  }
  const uint32_t lm_cap = (word_count <= 2048u) ? 4096u : kMaxLineMapCap;
  char* text_mem = emit_arena.alloc<char>(text_cap);
  HexLineMapEntry* lm_mem = emit_arena.alloc<HexLineMapEntry>(lm_cap);
  if (!is_label || !has_back_edge || !ctx_ptr || !text_mem || !lm_mem) {
    return HEX_ERR_OOM;
  }
  for (uint32_t i = 0u; i < word_count; ++i) { is_label[i] = 0u; has_back_edge[i] = 0u; }
  __builtin_memset(ctx_ptr, 0, sizeof(AnalysisCtx));
  AnalysisCtx& ctx = *ctx_ptr;
  text_mem[0] = '\0';

  // Pass 0: Scan all internal branch targets first so Pass 1 and Pass 2 share identical label boundaries.
  for (uint32_t i = 0u; i < word_count; ++i) {
    const uint32_t w = words[i];
    const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    uint64_t target = 0ULL;
    bool has_branch = false;
    if ((w & 0xFC000000u) == 0x14000000u) {
      target = pc + static_cast<uint64_t>(sign_extend(w & 0x03FFFFFFu, 26u) * 4LL);
      has_branch = true;
    } else if ((w & 0x7E000000u) == 0x34000000u || (w & 0xFF000010u) == 0x54000000u) {
      target = pc + static_cast<uint64_t>(sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL);
      has_branch = true;
    } else if ((w & 0x7E000000u) == 0x36000000u) {
      target = pc + static_cast<uint64_t>(sign_extend((w >> 5u) & 0x3FFFu, 14u) * 4LL);
      has_branch = true;
    }
    if (has_branch) {
      uint32_t tidx = 0u;
      if (is_internal_target(target, base_addr, word_count, &tidx)) {
        is_label[tidx] = 1u;
        if (tidx <= i) has_back_edge[tidx] = 1u;
      }
    }
  }

  // Pass 1: Collect register usage, globals, callees, and types with identical ADRP invalidation at labels.
  CmpState cmp{};
  for (uint32_t i = 0u; i < word_count; ++i) {
    if (is_label[i] != 0u) {
      const uint32_t pw = (i > 0u) ? words[i - 1u] : 0u;
      const bool after_term = (i > 0u) && (((pw & 0xFFFFFC1Fu) == 0xD65F0000u) || pw == 0xD65F0BFFu || pw == 0xD65F0FFFu || ((pw & 0xFC000000u) == 0x14000000u));
      for (uint32_t r = 0u; r < 31u; ++r) {
        if (after_term && !has_back_edge[i] && ctx.saved_adrp_valid[r]) {
          ctx.adrp_valid[r] = true;
          ctx.adrp_page[r] = ctx.saved_adrp_page[r];
          ctx.adrp_consumed[r] = false;
        } else if (r < 19u || r > 28u) {
          ctx.adrp_valid[r] = false;
        }
      }
    }
    const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    process_insn(words[i], pc, base_addr, word_count, ctx, cmp, false, nullptr);
  }
  if (ctx.table_overflow) return HEX_ERR_RESOURCE_LIMIT;
  if ((ctx.q_used & ctx.fp_used) != 0u) {
    ctx.uses_fp_bitcast = true;
    ctx.uses_uint32 = true;
    ctx.uses_uint64_t = true;
  }
  ctx.sort_tables();

  // Exact CFG backward liveness over basic blocks to prevent out-of-order loop bodies from creating phantom parameters.
  uint32_t live_in_gpr0 = ctx.gpr_read_before_write & 0xFFu;
  uint32_t live_in_fp0 = ctx.fp_read_before_write & 0xFFu;
  {
    uint32_t* blk_id = work_arena.alloc<uint32_t>(word_count);
    uint32_t num_blks = 0u;
    if (blk_id) {
      for (uint32_t i = 0u; i < word_count; ++i) {
        if (i == 0u || is_label[i] != 0u) ++num_blks;
        blk_id[i] = num_blks - 1u;
        // Start a new block after any branch or ret if another insn follows.
        const uint32_t wi = words[i];
        if (i + 1u < word_count && is_label[i + 1u] == 0u &&
            ((wi & 0xFFFFFC1Fu) == 0xD65F0000u || wi == 0xD65F0BFFu || wi == 0xD65F0FFFu ||
             (wi & 0xFC000000u) == 0x14000000u ||
             (wi & 0xFFFFFC1Fu) == 0xD61F0000u || ((wi & 0xFFFFF800u) == 0xD71F0800u || (wi & 0xFFFFF81Fu) == 0xD61F081Fu) ||
             (wi & 0x7E000000u) == 0x34000000u ||
             (wi & 0xFF000010u) == 0x54000000u || (wi & 0x7E000000u) == 0x36000000u)) {
          is_label[i + 1u] = 2u;  // internal CFG split marker (not emitted as C label)
        }
      }
      uint32_t* b_use_g = work_arena.alloc<uint32_t>(num_blks);
      uint32_t* b_def_g = work_arena.alloc<uint32_t>(num_blks);
      uint32_t* b_def_nc_g = work_arena.alloc<uint32_t>(num_blks);
      uint32_t* b_use_f = work_arena.alloc<uint32_t>(num_blks);
      uint32_t* b_def_f = work_arena.alloc<uint32_t>(num_blks);
      uint32_t* b_in_g = work_arena.alloc<uint32_t>(num_blks);
      uint32_t* b_in_f = work_arena.alloc<uint32_t>(num_blks);
      int32_t* b_s0 = work_arena.alloc<int32_t>(num_blks);
      int32_t* b_s1 = work_arena.alloc<int32_t>(num_blks);
      AnalysisCtx* bctx_ptr = work_arena.alloc<AnalysisCtx>(1u);
      if (b_use_g && b_def_g && b_def_nc_g && b_use_f && b_def_f && b_in_g && b_in_f && b_s0 && b_s1 && bctx_ptr) {
        for (uint32_t b = 0u; b < num_blks; ++b) {
          b_use_g[b] = b_def_g[b] = b_def_nc_g[b] = b_use_f[b] = b_def_f[b] = b_in_g[b] = b_in_f[b] = 0u;
          b_s0[b] = b_s1[b] = -1;
        }
        uint32_t i = 0u;
        for (uint32_t b = 0u; b < num_blks && i < word_count; ++b) {
          __builtin_memset(bctx_ptr, 0, offsetof(AnalysisCtx, globals));
          bctx_ptr->global_count = 0u;
          bctx_ptr->callee_count = 0u;
          AnalysisCtx& bctx = *bctx_ptr;
          CmpState bcmp{};
          uint32_t last_i = i;
          while (i < word_count && blk_id[i] == b) {
            const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
            // On BL or external tail-call B, x0 is implicitly read if block has not used FP regs
            const uint32_t wi = words[i];
            if ((wi & 0xFC000000u) == 0x94000000u) {
              if (bctx.fp_used == 0u && (ctx.fp_read_before_write & 0xFFu) == 0u) bctx.mark_gpr_read(0u);
            } else if ((wi & 0xFC000000u) == 0x14000000u) {
              const uint64_t tgt = pc + static_cast<uint64_t>(sign_extend(wi & 0x03FFFFFFu, 26u) * 4LL);
              uint32_t tidx = 0u;
              if (!is_internal_target(tgt, base_addr, word_count, &tidx) && bctx.fp_used == 0u && (ctx.fp_read_before_write & 0xFFu) == 0u) {
                bctx.mark_gpr_read(0u);
              }
            }
            bctx.gpr_written_insn = 0u;
            process_insn(wi, pc, base_addr, word_count, bctx, bcmp, false, nullptr);
            if ((wi & 0xFC000000u) == 0x94000000u || (wi & 0xFFFFFC1Fu) == 0xD63F0000u ||
                (wi & 0xFFFFF81Fu) == 0xD63F081Fu || (wi & 0xFFFFF800u) == 0xD73F0800u) {
              bctx.gpr_written |= 0xFFu;
              bctx.fp_written |= 0xFFu;
            } else {
              b_def_nc_g[b] |= (bctx.gpr_written_insn & 0xFFu);
            }
            last_i = i;
            ++i;
          }
          b_use_g[b] = bctx.gpr_read_before_write & 0xFFu;
          b_def_g[b] = bctx.gpr_written & 0xFFu;
          b_use_f[b] = bctx.fp_read_before_write & 0xFFu;
          b_def_f[b] = bctx.fp_written & 0xFFu;
          const uint32_t lw = words[last_i];
          const uint64_t lpc = base_addr + static_cast<uint64_t>(last_i) * 4ULL;
          if ((lw & 0xFFFFFC1Fu) == 0xD65F0000u || lw == 0xD65F0BFFu || lw == 0xD65F0FFFu ||
              (lw & 0xFFFFFC1Fu) == 0xD61F0000u || (lw & 0xFFFFF81Fu) == 0xD61F081Fu || (lw & 0xFFFFF800u) == 0xD71F0800u) {
            // RET / RETAA / RETAB / BR / BRAA / BRAB: no internal successors
          } else if ((lw & 0xFC000000u) == 0x14000000u) {
            const uint64_t tgt = lpc + static_cast<uint64_t>(sign_extend(lw & 0x03FFFFFFu, 26u) * 4LL);
            uint32_t tidx = 0u;
            if (is_internal_target(tgt, base_addr, word_count, &tidx)) b_s0[b] = static_cast<int32_t>(blk_id[tidx]);
          } else if ((lw & 0x7E000000u) == 0x34000000u || (lw & 0xFF000010u) == 0x54000000u || (lw & 0x7E000000u) == 0x36000000u) {
            if (last_i + 1u < word_count) b_s0[b] = static_cast<int32_t>(blk_id[last_i + 1u]);
            const uint64_t tgt = ((lw & 0x7E000000u) == 0x36000000u)
                ? lpc + static_cast<uint64_t>(sign_extend((lw >> 5u) & 0x3FFFu, 14u) * 4LL)
                : lpc + static_cast<uint64_t>(sign_extend((lw >> 5u) & 0x7FFFFu, 19u) * 4LL);
            uint32_t tidx = 0u;
            if (is_internal_target(tgt, base_addr, word_count, &tidx)) b_s1[b] = static_cast<int32_t>(blk_id[tidx]);
          } else {
            if (last_i + 1u < word_count) b_s0[b] = static_cast<int32_t>(blk_id[last_i + 1u]);
          }
        }
        for (uint32_t iter = 0u; iter < 64u; ++iter) {
          bool changed = false;
          for (int32_t b = static_cast<int32_t>(num_blks) - 1; b >= 0; --b) {
            uint32_t og = 0u, of = 0u;
            if (b_s0[b] >= 0) { og |= b_in_g[b_s0[b]]; of |= b_in_f[b_s0[b]]; }
            if (b_s1[b] >= 0) { og |= b_in_g[b_s1[b]]; of |= b_in_f[b_s1[b]]; }
            const uint32_t ng = b_use_g[b] | (og & ~b_def_g[b]);
            const uint32_t nf = b_use_f[b] | (of & ~b_def_f[b]);
            if (ng != b_in_g[b] || nf != b_in_f[b]) {
              b_in_g[b] = ng;
              b_in_f[b] = nf;
              changed = true;
            }
          }
          if (!changed) break;
        }
        // Only suppress x4..x7 as uninitialized loop-carried locals when:
        // (1) not read in block 0, AND (2) every block reading r before writing it either
        //     self-defines r via a non-call instruction or is transitively reachable from a non-call def of r.
        uint32_t* b_reach_def = work_arena.alloc<uint32_t>(num_blks);
        uint32_t uninit_local_mask = 0u;
        if (b_reach_def) {
          for (uint32_t b = 0u; b < num_blks; ++b) b_reach_def[b] = b_def_nc_g[b];
          for (uint32_t iter2 = 0u; iter2 < 64u; ++iter2) {
            bool ch2 = false;
            for (uint32_t b = 0u; b < num_blks; ++b) {
              const uint32_t cur_d = b_reach_def[b];
              if (b_s0[b] >= 0 && (b_reach_def[b_s0[b]] | cur_d) != b_reach_def[b_s0[b]]) {
                b_reach_def[b_s0[b]] |= cur_d; ch2 = true;
              }
              if (b_s1[b] >= 0 && (b_reach_def[b_s1[b]] | cur_d) != b_reach_def[b_s1[b]]) {
                b_reach_def[b_s1[b]] |= cur_d; ch2 = true;
              }
            }
            if (!ch2) break;
          }
          for (uint32_t r = 4u; r < 8u; ++r) {
            const uint32_t bit = 1u << r;
            if ((b_in_g[0] & bit) == 0u || (b_use_g[0] & bit) != 0u) continue;
            bool has_any_use = false;
            bool all_local_like = true;
            for (uint32_t b = 1u; b < num_blks; ++b) {
              if ((b_use_g[b] & bit) == 0u) continue;
              has_any_use = true;
              if ((b_reach_def[b] & bit) == 0u) { all_local_like = false; break; }
            }
            if (has_any_use && all_local_like) uninit_local_mask |= bit;
          }
        }
        live_in_gpr0 = b_in_g[0] & ~uninit_local_mask;
        live_in_fp0 = b_in_f[0];
      }
      // Restore is_label so only real branch targets (== 1) emit C labels
      for (uint32_t k = 0u; k < word_count; ++k) {
        if (is_label[k] == 2u) is_label[k] = 0u;
      }
    }
  }
  uint32_t int_param_count = 0u;
  for (uint32_t r = 0u; r < 8u; ++r) {
    if ((live_in_gpr0 & (1u << r)) != 0u) {
      if (r >= 4u && (live_in_gpr0 & (1u << (r - 1u))) == 0u) break;
      int_param_count = r + 1u;
    }
  }
  uint32_t fp_param_count = 0u;
  for (uint32_t r = 0u; r < 8u; ++r) {
    if ((live_in_fp0 & (1u << r)) != 0u) fp_param_count = r + 1u;
  }
  if (ctx.ret_fp_count > 0u && ctx.ret_fp_count > ctx.ret_gpr_count) {
    ctx.returns_value = true;
    ctx.returns_double = true;
    if ((ctx.fp_single_mask & 1u) != 0u && (ctx.fp_double_mask & 1u) == 0u) {
      ctx.returns_float = true;
    }
  } else if (ctx.ret_gpr_count > 0u) {
    ctx.returns_value = true;
    ctx.returns_double = false;
    ctx.returns_float = false;
    if (ctx.ret_int32_count > 0u && ctx.ret_int64_count == 0u) {
      ctx.returns_int32 = true;
      ctx.uses_int32 = true;
    }
  }
  ctx.norm_name = norm_name;
  ctx.norm_len = norm_len;
  ctx.int_param_count = int_param_count;
  ctx.fp_param_count = fp_param_count;

  TextBuf tb{text_mem, text_cap, 0u, 1u, false, lm_mem, lm_cap, 0u};

  // Emit self-contained fixed-width typedef header.
  tb.put_str("/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n");
  tb.put_str("typedef __UINT64_TYPE__ uint64;\n");
  if (ctx.uses_uint8 || ctx.uses_sp) tb.put_str("typedef __UINT8_TYPE__ uint8_t;\n");
  if (ctx.uses_int8) tb.put_str("typedef __INT8_TYPE__ int8_t;\n");
  if (ctx.uses_uint16) tb.put_str("typedef __UINT16_TYPE__ uint16_t;\n");
  if (ctx.uses_int16) tb.put_str("typedef __INT16_TYPE__ int16_t;\n");
  if (ctx.uses_uint32) tb.put_str("typedef __UINT32_TYPE__ uint32_t;\n");
  if (ctx.uses_int32) tb.put_str("typedef __INT32_TYPE__ int32_t;\n");
  if (ctx.uses_uint64_t) tb.put_str("typedef __UINT64_TYPE__ uint64_t;\n");
  if (ctx.uses_int64_t) tb.put_str("typedef __INT64_TYPE__ int64_t;\n");
  if (ctx.uses_uintptr || ctx.uses_sp) tb.put_str("typedef __UINTPTR_TYPE__ uintptr_t;\n");
  if (ctx.uses_uint128) tb.put_str("typedef unsigned __int128 uint128;\n");
  if (ctx.uses_math) {
    tb.put_str(
        "extern double sqrt(double); extern double ceil(double); extern double floor(double); "
        "extern double trunc(double); extern double round(double); extern double rint(double);\n");
  }
  if (ctx.uses_fp_bitcast) {
    tb.put_str(
        "static inline float __hex_u32_to_f32(uint32_t u) { union { uint32_t i; float f; } v; v.i = u; return v.f; }\n"
        "static inline double __hex_u64_to_f64(uint64_t u) { union { uint64_t i; double d; } v; v.i = u; return v.d; }\n"
        "static inline uint32_t __hex_f32_to_u32(float f) { union { uint32_t i; float f; } v; v.f = f; return v.i; }\n"
        "static inline uint64_t __hex_f64_to_u64(double d) { union { uint64_t i; double d; } v; v.d = d; return v.i; }\n");
  }

  // Emit external globals.
  if (ctx.global_count > 0u) {
    tb.put_str("/* hex: standalone external globals (stripped by translation unit packager). */\n");
    for (uint32_t i = 0u; i < ctx.global_count; ++i) {
      if (ctx.globals[i].needs_addr_of) {
        tb.put_str("static _Alignas(16) uint64 __hex_global_");
        tb.put_u64_hex(ctx.globals[i].addr, true);
        tb.put_str("_buf[512] = {0};\n#define global_");
        tb.put_u64_hex(ctx.globals[i].addr, true);
        tb.put_str(" (__hex_global_");
        tb.put_u64_hex(ctx.globals[i].addr, true);
        tb.put_str("_buf[0])\n");
      } else {
        tb.put_str("static uint64 global_");
        tb.put_u64_hex(ctx.globals[i].addr, true);
        tb.put_str(" = 0;\n");
      }
    }
  }

  // Emit external prototypes.
  if (ctx.callee_count > 0u || ctx.has_unknown_call) {
    tb.put_str(
        "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
        "#ifndef __HEX_ANY_ARGS\n"
        "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
        "#define __HEX_ANY_ARGS ...\n"
        "#else\n"
        "#define __HEX_ANY_ARGS\n"
        "#endif\n"
        "#endif\n");
    for (uint32_t i = 0u; i < ctx.callee_count; ++i) {
      if (ctx.callees[i] == base_addr) continue;
      tb.put_str("uint64 sub_");
      tb.put_u64_hex(ctx.callees[i], true);
      tb.put_str(" (__HEX_ANY_ARGS);\n");
    }
    if (ctx.has_unknown_call) {
      tb.put_str("uint64 unknown_call (__HEX_ANY_ARGS);\n");
    }
  }

  // Function signature.
  tb.record_line(base_addr);
  if (ctx.returns_float) tb.put_str("float ");
  else if (ctx.returns_double) tb.put_str("double ");
  else if (ctx.returns_int32) tb.put_str("int ");
  else if (ctx.returns_value) tb.put_str("uint64 ");
  else tb.put_str("void ");
  tb.put_bytes(norm_name, norm_len);
  tb.put_char('(');
  if (int_param_count == 0u && fp_param_count == 0u) {
    tb.put_str("void");
  } else {
    bool first = true;
    for (uint32_t r = 0u; r < int_param_count; ++r) {
      if (!first) tb.put_str(", ");
      tb.put_str("uint64 a");
      tb.put_u64_dec(r + 1u);
      first = false;
    }
    for (uint32_t r = 0u; r < fp_param_count; ++r) {
      if (!first) tb.put_str(", ");
      const bool has_p_info = (((ctx.fp_param_single_mask | ctx.fp_param_double_mask) & (1u << r)) != 0u);
      const bool is_s = has_p_info
          ? (((ctx.fp_param_single_mask & (1u << r)) != 0u) && ((ctx.fp_param_double_mask & (1u << r)) == 0u))
          : (((ctx.fp_single_mask & (1u << r)) != 0u) && ((ctx.fp_double_mask & (1u << r)) == 0u));
      tb.put_str(is_s ? "float fa" : "double fa");
      tb.put_u64_dec(r + 1u);
      first = false;
    }
  }
  tb.put_str(")\n{\n");

  // Local declarations.
  if (ctx.uses_nzcv) {
    tb.put_str("    uint32_t __hex_nzcv = 0;\n");
  }
  if (ctx.uses_sp) {
    tb.put_str("    uint8_t __hex_stack_frame[4096] = {0};\n");
    tb.put_str("    uint64 sp = (uintptr_t)(__hex_stack_frame + sizeof(__hex_stack_frame));\n");
  }
  for (uint32_t r = 0u; r < 31u; ++r) {
    if ((ctx.gpr_used & (1u << r)) != 0u) {
      tb.put_str("    uint64 x");
      tb.put_u64_dec(r);
      if (r < int_param_count) {
        tb.put_str(" = a");
        tb.put_u64_dec(r + 1u);
      } else {
        tb.put_str(" = 0");
      }
      tb.put_str(";\n");
    }
  }
  for (uint32_t r = 0u; r < 32u; ++r) {
    if ((ctx.fp_used & (1u << r)) != 0u) {
      tb.put_str("    double d");
      tb.put_u64_dec(r);
      if (r < fp_param_count) {
        tb.put_str(" = fa");
        tb.put_u64_dec(r + 1u);
      } else {
        tb.put_str(" = 0.0");
      }
      tb.put_str(";\n");
    }
  }
  for (uint32_t r = 0u; r < 32u; ++r) {
    if ((ctx.q_used & (1u << r)) != 0u) {
      tb.put_str("    uint128 q");
      tb.put_u64_dec(r);
      tb.put_str(" = 0;\n");
    }
  }

  // Pass 2: Emit C body statements.
  const uint32_t body_start_off = tb.len;
  const uint32_t body_start_line = tb.line_no;
  for (uint32_t r = 0u; r < 31u; ++r) { ctx.adrp_valid[r] = false; ctx.saved_adrp_valid[r] = false; ctx.adrp_consumed[r] = false; }
  cmp = ctx.uses_nzcv ? CmpState{true, false, false, false, false, false, 0u, 0u, 0ULL, true} : CmpState{};
  bool pending_label = false;
  for (uint32_t i = 0u; i < word_count; ++i) {
    const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    if (is_label[i] != 0u) {
      const uint32_t pw = (i > 0u) ? words[i - 1u] : 0u;
      const bool after_term = (i > 0u) && (((pw & 0xFFFFFC1Fu) == 0xD65F0000u) || pw == 0xD65F0BFFu || pw == 0xD65F0FFFu || ((pw & 0xFC000000u) == 0x14000000u));
      for (uint32_t r = 0u; r < 31u; ++r) {
        if (after_term && !has_back_edge[i] && ctx.saved_adrp_valid[r]) {
          ctx.adrp_valid[r] = true;
          ctx.adrp_page[r] = ctx.saved_adrp_page[r];
          ctx.adrp_consumed[r] = false;
        } else if (r < 19u || r > 28u) {
          ctx.adrp_valid[r] = false;
        }
      }
      tb.put_str("loc_");
      tb.put_u64_hex(pc, true);
      tb.put_str(":\n");
      pending_label = true;
    }
    const uint32_t before_len = tb.len;
    process_insn(words[i], pc, base_addr, word_count, ctx, cmp, true, &tb);
    if (tb.len > before_len) pending_label = false;
    if (tb.overflow) return HEX_ERR_OOM;
  }
  if (pending_label) {
    tb.put_str("    (void)0;\n");
  }

  structurize_c_body(tb, body_start_off, body_start_line, work_arena, emit_arena);
  tb.put_str("}\n");
  if (tb.overflow || tb.len == 0u) return HEX_ERR_OOM;

  // Trim trailing newline to match hex-ida convention.
  if (tb.len > 0u && tb.data[tb.len - 1u] == '\n') {
    tb.data[--tb.len] = '\0';
  }

  *out_text = tb.data;
  *out_text_len = tb.len;
  *out_linemap = tb.lm;
  *out_linemap_count = tb.lm_count;
  return HEX_OK;
}

}  // namespace hex::decompiler::passes
