#include "decompiler/passes/arm64_general_emit.hpp"

namespace hex::decompiler::passes {

static hex::Arena* g_general_scratch_arena = nullptr;
static uint64_t g_rodata_va = 0ULL;
static const uint8_t* g_rodata_ptr = nullptr;
static uint32_t g_rodata_len = 0u;
static uint32_t g_general_loss_flags = 0u;

static constexpr uint32_t kLossUnresolvedIndirectBranch = (1u << 0);
static constexpr uint32_t kLossUnknownCallArgs          = (1u << 1);
[[maybe_unused]] static constexpr uint32_t kLossDroppedTailCall = (1u << 2);
static constexpr uint32_t kLossUnsupportedInsn          = (1u << 3);
static constexpr uint32_t kLossIndirectCall             = (1u << 4);

void set_general_scratch_arena(hex::Arena* scratch) {
  g_general_scratch_arena = scratch;
}

void set_general_rodata_slice(uint64_t va, const uint8_t* ptr, uint32_t len) {
  g_rodata_va = va;
  g_rodata_ptr = ptr;
  g_rodata_len = len;
}

void clear_general_rodata_slice() {
  g_rodata_va = 0ULL;
  g_rodata_ptr = nullptr;
  g_rodata_len = 0u;
}

void reset_general_loss_flags() {
  g_general_loss_flags = 0u;
}

void add_general_loss_flags(uint32_t flags) {
  g_general_loss_flags |= flags;
}

uint32_t get_general_loss_flags() {
  return g_general_loss_flags;
}

namespace {

static constexpr uint32_t kMinGeneralWords = 1u;
static constexpr uint32_t kMaxGeneralWords = 8192u;
static constexpr uint32_t kMaxNormNameLen = 512u;
static constexpr uint32_t kMaxGlobals = 2048u;
static constexpr uint32_t kMaxCallees = 2048u;
static constexpr uint32_t kMaxTextCap = 131072u;
static constexpr uint32_t kMaxLineMapCap = 8192u;
static constexpr uint32_t kMaxJumpTables = 32u;
static constexpr uint32_t kMaxJumpTableCases = 256u;
static constexpr uint32_t kMaxSpSlots = 48u;

static bool read_rodata_bytes(
    uint64_t va,
    uint32_t nbytes,
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    uint8_t* out) {
  if (!out || nbytes == 0u) return false;
  if (g_rodata_ptr && g_rodata_len > 0u && va >= g_rodata_va) {
    const uint64_t off = va - g_rodata_va;
    const uint64_t rlen = static_cast<uint64_t>(g_rodata_len);
    if (off <= rlen && static_cast<uint64_t>(nbytes) <= rlen - off) {
      for (uint32_t k = 0u; k < nbytes; ++k) out[k] = g_rodata_ptr[off + k];
      return true;
    }
  }
  if (words && word_count > 0u && va >= base_addr) {
    const uint64_t off = va - base_addr;
    const uint64_t clen = static_cast<uint64_t>(word_count) * 4ULL;
    if (off <= clen && static_cast<uint64_t>(nbytes) <= clen - off) {
      for (uint32_t k = 0u; k < nbytes; ++k) {
        const uint64_t bo = off + k;
        out[k] = static_cast<uint8_t>((words[bo >> 2u] >> ((bo & 3u) * 8u)) & 0xFFu);
      }
      return true;
    }
  }
  return false;
}

static bool read_rodata_u8(uint64_t va, const uint32_t* words, uint32_t word_count, uint64_t base_addr, uint8_t* out) {
  return read_rodata_bytes(va, 1u, words, word_count, base_addr, out);
}

static bool read_rodata_s8(uint64_t va, const uint32_t* words, uint32_t word_count, uint64_t base_addr, int8_t* out) {
  uint8_t b = 0u;
  if (!read_rodata_u8(va, words, word_count, base_addr, &b)) return false;
  *out = static_cast<int8_t>(b);
  return true;
}

static bool read_rodata_u16(uint64_t va, const uint32_t* words, uint32_t word_count, uint64_t base_addr, uint16_t* out) {
  uint8_t b[2];
  if (!read_rodata_bytes(va, 2u, words, word_count, base_addr, b)) return false;
  *out = static_cast<uint16_t>(static_cast<uint16_t>(b[0]) | (static_cast<uint16_t>(b[1]) << 8u));
  return true;
}

static bool read_rodata_s16(uint64_t va, const uint32_t* words, uint32_t word_count, uint64_t base_addr, int16_t* out) {
  uint16_t v = 0u;
  if (!read_rodata_u16(va, words, word_count, base_addr, &v)) return false;
  *out = static_cast<int16_t>(v);
  return true;
}

static bool read_rodata_u32(uint64_t va, const uint32_t* words, uint32_t word_count, uint64_t base_addr, uint32_t* out) {
  uint8_t b[4];
  if (!read_rodata_bytes(va, 4u, words, word_count, base_addr, b)) return false;
  *out = static_cast<uint32_t>(b[0]) |
         (static_cast<uint32_t>(b[1]) << 8u) |
         (static_cast<uint32_t>(b[2]) << 16u) |
         (static_cast<uint32_t>(b[3]) << 24u);
  return true;
}

static bool read_rodata_s32(uint64_t va, const uint32_t* words, uint32_t word_count, uint64_t base_addr, int32_t* out) {
  uint32_t v = 0u;
  if (!read_rodata_u32(va, words, word_count, base_addr, &v)) return false;
  *out = static_cast<int32_t>(v);
  return true;
}

static bool read_rodata_u64(uint64_t va, const uint32_t* words, uint32_t word_count, uint64_t base_addr, uint64_t* out) {
  uint8_t b[8];
  if (!read_rodata_bytes(va, 8u, words, word_count, base_addr, b)) return false;
  *out = static_cast<uint64_t>(b[0]) |
         (static_cast<uint64_t>(b[1]) << 8u) |
         (static_cast<uint64_t>(b[2]) << 16u) |
         (static_cast<uint64_t>(b[3]) << 24u) |
         (static_cast<uint64_t>(b[4]) << 32u) |
         (static_cast<uint64_t>(b[5]) << 40u) |
         (static_cast<uint64_t>(b[6]) << 48u) |
         (static_cast<uint64_t>(b[7]) << 56u);
  return true;
}

struct JumpTableInfo {
  uint32_t br_idx;
  uint32_t load_idx;
  uint8_t br_reg;
  uint8_t index_reg;
  bool index_is32;
  bool index_clobbered;
  bool resolved;
  bool is_func_table;
  bool is_indirect_tail;
  bool has_default_target;
  uint64_t default_target;
  uint32_t case_count;
  uint64_t* case_targets;
};

struct SpSlot {
  int64_t canon_off;
  uint32_t slot_id;
  uint8_t width;
  bool is_fp;
  bool conflicted;
};

struct SpPromoState {
  static constexpr int64_t kUnvisited = (-9223372036854775807LL - 1LL);
  bool active;
  bool all_sp_promoted;
  bool omit_x29_sp_mov;
  int64_t min_sp_off;
  int64_t* insn_sp_off;
  SpSlot slots[kMaxSpSlots];
  uint32_t slot_count;

  const SpSlot* find_promoted(int64_t canon_off, uint8_t width, bool is_fp) const {
    if (!active) return nullptr;
    for (uint32_t i = 0u; i < slot_count; ++i) {
      if (slots[i].canon_off == canon_off) {
        if (!slots[i].conflicted && slots[i].width == width && slots[i].is_fp == is_fp) {
          return &slots[i];
        }
        return nullptr;
      }
    }
    return nullptr;
  }
};

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
  bool is_tst;
  bool lhs_is_sp;
  uint32_t lhs_reg;
  uint32_t rhs_reg;
  uint64_t rhs_imm;
  bool is_nzcv_var;
  bool is_ccmp;
  bool ccmp_else_val;
  uint32_t ccmp_outer_cond;
  const CmpState* ccmp_outer;
};

static inline CmpState make_nzcv_cmp(bool is32 = false) {
  return CmpState{true, is32, false, false, false, false, false, 0u, 0u, 0ULL, true, false, false, 0u, nullptr};
}

struct AnalysisCtx {
  uint32_t gpr_read_before_write;  // bits 0..30
  uint32_t gpr_written;            // bits 0..30
  uint32_t gpr_written_insn;       // per-instruction non-call write tracker
  uint32_t gpr_used;               // bits 0..30
  uint32_t fp_read_before_write;   // bits 0..31 (d0..d31)
  uint32_t fp_written;             // bits 0..31
  uint32_t fp_used;                // bits 0..31
  uint32_t fp_read;                // bits 0..31
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
  bool uses_sw_idx;
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
  const JumpTableInfo* jts;
  uint32_t jt_count;
  const uint8_t* call_argc;
  const SpPromoState* sp_promo;
  uint32_t cur_insn_idx;
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
    fp_read |= (1u << r);
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

static bool insn_reads_nzcv(uint32_t w) {
  if ((w & 0xFF000010u) == 0x54000000u) return true;  // B.cond
  if ((w & 0x3FE00800u) == 0x1A800000u) return true;  // CSEL/CSINC/CSINV/CSNEG
  if ((w & 0x3FE00410u) == 0x3A400000u) return true;  // CCMP/CCMN
  if ((w & 0x1FE0FC00u) == 0x1A000000u) return true;  // ADC/ADCS/SBC/SBCS
  if ((w & 0xFF200C00u) == 0x1E200C00u && ((w >> 22u) & 3u) <= 1u) return true;  // FCSEL
  if ((w & 0xFF200C00u) == 0x1E200400u && ((w >> 22u) & 3u) <= 1u) return true;  // FCCMP/FCCMPE
  return false;
}

static bool insn_writes_nzcv(uint32_t w) {
  if ((w & 0x1F800000u) == 0x12000000u && ((w >> 29u) & 3u) == 3u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    uint64_t imm = 0ULL;
    return decode_bitmask_imm((w >> 22u) & 1u, (w >> 10u) & 0x3Fu, (w >> 16u) & 0x3Fu, is64, &imm);
  }
  if ((w & 0x1F800000u) == 0x11000000u && ((w >> 29u) & 1u) != 0u) return true;  // ADDS/SUBS imm
  if ((w & 0x1F200000u) == 0x0B000000u && ((w >> 29u) & 1u) != 0u) return true;  // ADDS/SUBS shifted reg
  if ((w & 0x1FE00000u) == 0x0B200000u && ((w >> 29u) & 1u) != 0u) return true;  // ADDS/SUBS extended reg
  if ((w & 0x1F000000u) == 0x0A000000u && ((w >> 29u) & 3u) == 3u) return true;  // ANDS/BICS shifted reg
  if ((w & 0x5F203C00u) == 0x1E202000u) return true;                              // FCMP
  if ((w & 0x3FE00410u) == 0x3A400000u) return true;                              // CCMP/CCMN
  if ((w & 0x1FE0FC00u) == 0x1A000000u && ((w >> 29u) & 1u) != 0u) return true;   // ADCS/SBCS
  if ((w & 0xFF200C00u) == 0x1E200400u && ((w >> 22u) & 3u) <= 1u) return true;   // FCCMP/FCCMPE
  return false;
}

static bool try_decode_fusable_cmp(uint32_t w, CmpState* out) {
  // CMP / CMN immediate (SUBS/ADDS with rd == 31)
  if ((w & 0x1F800000u) == 0x11000000u && ((w >> 29u) & 1u) != 0u && (w & 31u) == 31u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const uint32_t sh = (w >> 22u) & 1u;
    const uint64_t imm = static_cast<uint64_t>((w >> 10u) & 0xFFFu) << (sh ? 12u : 0u);
    const uint32_t rn = (w >> 5u) & 31u;
    *out = CmpState{true, !is64, false, true, !is_sub, false, rn == 31u, rn, 0u, imm, false, false, false, 0u, nullptr};
    return true;
  }
  // CMP / CMN shifted register with imm6 == 0 (SUBS/ADDS with rd == 31)
  if ((w & 0x1F200000u) == 0x0B000000u && ((w >> 29u) & 1u) != 0u && (w & 31u) == 31u && (((w >> 10u) & 0x3Fu) == 0u)) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    *out = CmpState{true, !is64, false, false, !is_sub, false, false, rn, rm, 0ULL, false, false, false, 0u, nullptr};
    return true;
  }
  // TST immediate (ANDS imm with rd == 31)
  if ((w & 0x1F800000u) == 0x12000000u && ((w >> 29u) & 3u) == 3u && (w & 31u) == 31u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    uint64_t imm = 0ULL;
    if (decode_bitmask_imm((w >> 22u) & 1u, (w >> 10u) & 0x3Fu, (w >> 16u) & 0x3Fu, is64, &imm)) {
      const uint32_t rn = (w >> 5u) & 31u;
      *out = CmpState{true, !is64, false, true, false, true, false, rn, 0u, imm, false, false, false, 0u, nullptr};
      return true;
    }
  }
  // TST shifted register (ANDS reg with rd == 31, !invert, imm6 == 0)
  if ((w & 0x1F000000u) == 0x0A000000u && ((w >> 29u) & 3u) == 3u && (w & 31u) == 31u &&
      (((w >> 21u) & 1u) == 0u) && (((w >> 10u) & 0x3Fu) == 0u)) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    *out = CmpState{true, !is64, false, false, false, true, false, rn, rm, 0ULL, false, false, false, 0u, nullptr};
    return true;
  }
  // FCMP (reg or #0.0)
  if ((w & 0x5F203C00u) == 0x1E202000u) {
    const bool is_zero = ((w >> 3u) & 1u) != 0u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    *out = CmpState{true, false, true, is_zero, false, false, false, rn, rm, 0ULL, false, false, false, 0u, nullptr};
    return true;
  }
  return false;
}

static bool try_decode_fusable_addsub(uint32_t w, CmpState* out, bool* out_zn_only) {
  // SUBS / ADDS immediate (S=1, rd < 31)
  if ((w & 0x1F800000u) == 0x11000000u && ((w >> 29u) & 1u) != 0u && (w & 31u) < 31u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const uint32_t sh = (w >> 22u) & 1u;
    const uint64_t imm = static_cast<uint64_t>((w >> 10u) & 0xFFFu) << (sh ? 12u : 0u);
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (imm == 0ULL) {
      // rn +/- 0 has V=0, N=sign(rd), Z=(rd==0); for SUBS C=1 matches CMP rd,#0,
      // for ADDS C=0 matches CMN rd,#0 (EQ/NE/MI/PL/GE/LT/GT/LE exact).
      *out = CmpState{true, !is64, false, true, !is_sub, false, false, rd, 0u, 0ULL, false, false, false, 0u, nullptr};
      if (out_zn_only) *out_zn_only = false;
      return true;
    }
    if (rd != rn) {
      // Pre-operation operand rn is preserved after writing rd, so flags match CMP/CMN rn, #imm.
      *out = CmpState{true, !is64, false, true, !is_sub, false, rn == 31u, rn, 0u, imm, false, false, false, 0u, nullptr};
      if (out_zn_only) *out_zn_only = false;
      return true;
    }
    *out = CmpState{true, !is64, false, true, false, false, false, rd, 0u, 0ULL, false, false, false, 0u, nullptr};
    if (out_zn_only) *out_zn_only = true;
    return true;
  }
  // SUBS / ADDS shifted register (S=1, rd < 31)
  if ((w & 0x1F200000u) == 0x0B000000u && ((w >> 29u) & 1u) != 0u && (w & 31u) < 31u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const uint32_t imm6 = (w >> 10u) & 0x3Fu;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    if (imm6 == 0u && is_sub && rd != rn && rd != rm) {
      // Pre-subtraction operands rn and rm are both preserved, so flags match CMP rn, rm.
      *out = CmpState{true, !is64, false, false, false, false, false, rn, rm, 0ULL, false, false, false, 0u, nullptr};
      if (out_zn_only) *out_zn_only = false;
      return true;
    }
    *out = CmpState{true, !is64, false, true, false, false, false, rd, 0u, 0ULL, false, false, false, 0u, nullptr};
    if (out_zn_only) *out_zn_only = true;
    return true;
  }
  return false;
}

static bool is_control_flow_or_call(uint32_t w) {
  if ((w & 0xFC000000u) == 0x94000000u) return true;  // BL
  if ((w & 0xFFFFFC1Fu) == 0xD63F0000u || (w & 0xFFFFF81Fu) == 0xD63F081Fu || (w & 0xFFFFF800u) == 0xD73F0800u) return true;  // BLR/BLRAA/BLRAB
  if ((w & 0xFC000000u) == 0x14000000u) return true;  // B
  if ((w & 0xFFFFFC1Fu) == 0xD61F0000u || (w & 0xFFFFF81Fu) == 0xD61F081Fu || (w & 0xFFFFF800u) == 0xD71F0800u) return true;  // BR/BRAA/BRAB
  if ((w & 0xFFFFFC1Fu) == 0xD65F0000u || w == 0xD65F0BFFu || w == 0xD65F0FFFu) return true;  // RET/RETAA/RETAB
  if ((w & 0x7E000000u) == 0x34000000u) return true;  // CBZ/CBNZ
  if ((w & 0x7E000000u) == 0x36000000u) return true;  // TBZ/TBNZ
  if ((w & 0xFF000010u) == 0x54000000u) return true;  // B.cond
  if ((w & 0xFF000000u) == 0xD4000000u) return true;  // Exception-generating (SVC/HVC/SMC/BRK/HLT)
  if ((w & 0xFFFFFC1Fu) == 0xD69F0000u || w == 0xD69F0BFFu || w == 0xD69F0FFFu) return true;  // ERET/ERETAA/ERETAB
  return false;
}

static bool try_decode_ccmp(uint32_t w, CmpState* out_inner, uint32_t* out_outer_cond, uint32_t* out_nzcv_imm) {
  if ((w & 0x3FE00410u) != 0x3A400000u) return false;
  const bool is64 = ((w >> 31u) & 1u) != 0u;
  const bool is_sub = ((w >> 30u) & 1u) != 0u;
  const bool is_imm = ((w >> 11u) & 1u) != 0u;
  const uint32_t rm_or_imm = (w >> 16u) & 31u;
  const uint32_t cond = (w >> 12u) & 15u;
  const uint32_t rn = (w >> 5u) & 31u;
  const uint32_t nzcv_imm = w & 15u;
  *out_inner = CmpState{true, !is64, false, is_imm, !is_sub, false, false, rn,
                        is_imm ? 0u : rm_or_imm, is_imm ? static_cast<uint64_t>(rm_or_imm) : 0ULL,
                        false, false, false, 0u, nullptr};
  *out_outer_cond = cond;
  *out_nzcv_imm = nzcv_imm;
  return true;
}

static bool eval_nzcv_imm(uint32_t nzcv, uint32_t cond) {
  const bool n = ((nzcv >> 3u) & 1u) != 0u;
  const bool z = ((nzcv >> 2u) & 1u) != 0u;
  const bool c = ((nzcv >> 1u) & 1u) != 0u;
  const bool v = (nzcv & 1u) != 0u;
  switch (cond & 0xFu) {
    case 0x0u: return z;
    case 0x1u: return !z;
    case 0x2u: return c;
    case 0x3u: return !c;
    case 0x4u: return n;
    case 0x5u: return !n;
    case 0x6u: return v;
    case 0x7u: return !v;
    case 0x8u: return c && !z;
    case 0x9u: return !c || z;
    case 0xAu: return n == v;
    case 0xBu: return n != v;
    case 0xCu: return !z && (n == v);
    case 0xDu: return z || (n != v);
    default: return true;
  }
}

static bool try_get_ccmp_consumer_cond(
    uint32_t w, uint64_t pc, uint64_t base_addr, uint32_t word_count, uint32_t* out_cond) {
  if ((w & 0xFF000010u) == 0x54000000u) {
    const int64_t delta = sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (!is_internal_target(target, base_addr, word_count, nullptr)) return false;
    *out_cond = w & 0xFu;
    return true;
  }
  if ((w & 0x3FE00800u) == 0x1A800000u) {
    *out_cond = (w >> 12u) & 0xFu;
    return true;
  }
  if ((w & 0xFF200C00u) == 0x1E200C00u && ((w >> 22u) & 3u) <= 1u) {
    *out_cond = (w >> 12u) & 0xFu;
    return true;
  }
  return false;
}

static bool try_get_fusable_consumer_cond(
    uint32_t w, uint64_t pc, uint64_t base_addr, uint32_t word_count, uint32_t* out_cond) {
  if ((w & 0xFF000010u) == 0x54000000u) {
    const int64_t delta = sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (!is_internal_target(target, base_addr, word_count, nullptr)) return false;
    *out_cond = w & 0xFu;
    return true;
  }
  if ((w & 0x3FE00800u) == 0x1A800000u) {
    *out_cond = (w >> 12u) & 0xFu;
    return true;
  }
  if ((w & 0xFF200C00u) == 0x1E200C00u && ((w >> 22u) & 3u) <= 1u) {
    *out_cond = (w >> 12u) & 0xFu;
    return true;
  }
  if ((w & 0x3FE00410u) == 0x3A400000u) {
    *out_cond = (w >> 12u) & 0xFu;
    return true;
  }
  if ((w & 0xFF200C00u) == 0x1E200400u && ((w >> 22u) & 3u) <= 1u) {
    *out_cond = (w >> 12u) & 0xFu;
    return true;
  }
  return false;
}

static bool cond_fusable_for_cmp(const CmpState& c, uint32_t cond) {
  const uint32_t cc = cond & 0xFu;
  if (cc == 0xEu || cc == 0xFu) return true;
  if (cc == 0x6u || cc == 0x7u) return false;  // VS/VC overflow flag
  if (c.is_fp) {
    // IEEE-754 NaN-exact conditions ONLY: EQ(0), NE(1), LO/CC(3), MI(4), LS(9), GE(A), GT(C).
    // HS(2), PL(5), HI(8), LT(B), LE(D) evaluate true on NaN in ARM64 FCMP and must keep __hex_nzcv.
    return cc == 0x0u || cc == 0x1u || cc == 0x3u || cc == 0x4u || cc == 0x9u || cc == 0xAu || cc == 0xCu;
  }
  if (c.is_tst) {
    return cc == 0x0u || cc == 0x1u || cc == 0x4u || cc == 0x5u ||
           cc == 0xAu || cc == 0xBu || cc == 0xCu || cc == 0xDu;
  }
  if (c.is_cmn) {
    // Carry flag on addition differs when rhs==0 (no HS/LO/HI/LS).
    // Signed negation of register INT_MIN is UB; immediate rhs (<= 0xFFF000) never overflows.
    if (c.is_imm) {
      return cc == 0x0u || cc == 0x1u || cc == 0x4u || cc == 0x5u ||
             cc == 0xAu || cc == 0xBu || cc == 0xCu || cc == 0xDu;
    }
    return cc == 0x0u || cc == 0x1u || cc == 0x4u || cc == 0x5u;
  }
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
    case 6u: tb.put_str("(uint64)(int64_t)(int32_t)"); tb.put_reg_x(rm); break;
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

static void emit_fused_addsub_clean(uint32_t w, uint64_t pc, AnalysisCtx& ctx, TextBuf& tb) {
  if ((w & 0x1F800000u) == 0x11000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const uint32_t sh = (w >> 22u) & 1u;
    const uint64_t imm = static_cast<uint64_t>((w >> 10u) & 0xFFFu) << (sh ? 12u : 0u);
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    tb.record_line(pc);
    tb.put_str("    ");
    tb.put_reg_x(rd);
    tb.put_str(" = ");
    if (!is64) tb.put_str("(uint32_t)(");
    tb.put_reg_x_or_sp(rn);
    if (imm != 0ULL) {
      tb.put_str(is_sub ? " - " : " + ");
      tb.put_imm(imm);
    }
    if (!is64) tb.put_char(')');
    tb.put_str(";\n");
    ctx.clear_adrp(rd);
    return;
  }
  if ((w & 0x1F200000u) == 0x0B000000u) {
    const bool is64 = ((w >> 31u) & 1u) != 0u;
    const bool is_sub = ((w >> 30u) & 1u) != 0u;
    const uint32_t shift_type = (w >> 22u) & 3u;
    const uint32_t rm = (w >> 16u) & 31u;
    const uint32_t imm6 = (w >> 10u) & 0x3Fu;
    const uint32_t rn = (w >> 5u) & 31u;
    const uint32_t rd = w & 31u;
    tb.record_line(pc);
    tb.put_str("    ");
    tb.put_reg_x(rd);
    tb.put_str(" = ");
    if (!is64) tb.put_str("(uint32_t)(");
    if (rn == 31u && is_sub) {
      tb.put_str("-");
    } else {
      tb.put_reg_x(rn);
      tb.put_str(is_sub ? " - " : " + ");
    }
    emit_shifted_reg(tb, rm, shift_type, imm6, is64);
    if (!is64) tb.put_char(')');
    tb.put_str(";\n");
    ctx.clear_adrp(rd);
    return;
  }
}

static void emit_cond_expr(TextBuf& tb, uint32_t cond, const CmpState& cmp) {
  if (!cmp.valid) {
    tb.put_str("(1)");
    return;
  }
  if (cmp.is_ccmp && cmp.ccmp_outer) {
    CmpState inner_only = cmp;
    inner_only.is_ccmp = false;
    inner_only.ccmp_outer = nullptr;
    tb.put_char('(');
    if (cmp.ccmp_else_val) {
      tb.put_char('!');
      emit_cond_expr(tb, cmp.ccmp_outer_cond, *cmp.ccmp_outer);
      tb.put_str(" || ");
    } else {
      emit_cond_expr(tb, cmp.ccmp_outer_cond, *cmp.ccmp_outer);
      tb.put_str(" && ");
    }
    emit_cond_expr(tb, cond, inner_only);
    tb.put_char(')');
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
  if (cmp.is_tst) {
    if (c == 0x0u || c == 0x1u) {
      tb.put_str("((");
      if (cmp.is32) tb.put_str("(uint32_t)");
      tb.put_reg_x(cmp.lhs_reg);
      tb.put_str(" & ");
      if (cmp.is_imm) {
        tb.put_imm(cmp.rhs_imm);
      } else {
        if (cmp.is32) tb.put_str("(uint32_t)");
        tb.put_reg_x(cmp.rhs_reg);
      }
      tb.put_str(c == 0x0u ? ") == 0)" : ") != 0)");
      return;
    }
    const char* tst_op = nullptr;
    if (c == 0x4u || c == 0xBu) tst_op = " < 0)";
    else if (c == 0x5u || c == 0xAu) tst_op = " >= 0)";
    else if (c == 0xCu) tst_op = " > 0)";
    else if (c == 0xDu) tst_op = " <= 0)";
    if (!tst_op) {
      tb.put_str("(1)");
      return;
    }
    tb.put_char('(');
    tb.put_str(cmp.is32 ? "(int32_t)(" : "(int64_t)(");
    tb.put_reg_x(cmp.lhs_reg);
    tb.put_str(" & ");
    if (cmp.is_imm) tb.put_imm(cmp.rhs_imm);
    else tb.put_reg_x(cmp.rhs_reg);
    tb.put_char(')');
    tb.put_str(tst_op);
    return;
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
  const bool omit_u64_cast = (!cmp.is32 && !signed_cmp && !cmp.is_cmn);

  if (!omit_u64_cast) tb.put_str(cast);
  if (cmp.lhs_is_sp) tb.put_reg_x_or_sp(cmp.lhs_reg);
  else tb.put_reg_x(cmp.lhs_reg);
  tb.put_char(' ');
  tb.put_str(op);
  tb.put_char(' ');
  if (cmp.is_cmn) tb.put_str("-(");
  const bool omit_imm_cast = cmp.is_imm && !cmp.is_cmn && (!signed_cmp || cmp.rhs_imm <= 0x7FFFFFFFULL);
  if (!omit_u64_cast && !omit_imm_cast) tb.put_str(cast);
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

static const char* mem_load_type_name(uint32_t size_bits, bool is_signed, bool is_fp) {
  if (is_fp) {
    if (size_bits == 128u) return "uint128";
    if (size_bits == 64u) return "double";
    return "float";
  }
  if (size_bits == 8u) return is_signed ? "int8_t" : "uint8_t";
  if (size_bits == 16u) return is_signed ? "int16_t" : "uint16_t";
  if (size_bits == 32u) return is_signed ? "int32_t" : "uint32_t";
  return "uint64";
}

static void emit_mem_load_type(TextBuf& tb, uint32_t size_bits, bool is_signed, bool is_fp) {
  tb.put_str("*(");
  tb.put_str(mem_load_type_name(size_bits, is_signed, is_fp));
  tb.put_str(" *)(");
}

static void emit_mem_deref_typed(TextBuf& tb, const char* type_name, uint32_t rn, int64_t disp) {
  tb.put_str("*(");
  tb.put_str(type_name);
  if (disp == 0) {
    tb.put_str(" *)(uintptr_t)");
    tb.put_reg_x_or_sp(rn);
  } else {
    tb.put_str(" *)(");
    emit_mem_addr(tb, rn, disp);
    tb.put_char(')');
  }
}

static void emit_mem_deref(TextBuf& tb, uint32_t size_bits, bool is_signed, bool is_fp, uint32_t rn, int64_t disp) {
  emit_mem_deref_typed(tb, mem_load_type_name(size_bits, is_signed, is_fp), rn, disp);
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
  if ((ctx.fp_read & (1u << r)) == 0u && !(r == 0u && (ctx.returns_float || ctx.returns_double))) return;
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

static const JumpTableInfo* find_jump_table(const AnalysisCtx& ctx, uint32_t insn_idx) {
  if (!ctx.jts) return nullptr;
  for (uint32_t i = 0u; i < ctx.jt_count; ++i) {
    if (ctx.jts[i].br_idx == insn_idx) return &ctx.jts[i];
  }
  return nullptr;
}

static void emit_indirect_call_expr(TextBuf& tb, const char* ret_type, uint32_t fn_reg, uint32_t argc) {
  tb.put_str("((");
  tb.put_str(ret_type);
  tb.put_str(" (*)(");
  if (argc == 0u) {
    tb.put_str("void");
  } else {
    for (uint32_t a = 0u; a < argc; ++a) {
      if (a > 0u) tb.put_str(", ");
      tb.put_str("uint64");
    }
  }
  tb.put_str("))(uintptr_t)");
  tb.put_reg_x(fn_reg);
  tb.put_str(")(");
  for (uint32_t a = 0u; a < argc; ++a) {
    if (a > 0u) tb.put_str(", ");
    tb.put_reg_x(a);
  }
  tb.put_char(')');
}

static void emit_local_sp_name(TextBuf& tb, uint32_t slot_id) {
  tb.put_str("local_sp_");
  tb.put_u64_hex(static_cast<uint64_t>(slot_id), false);
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
        tb->put_str("    return (int32_t)x0;\n");
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
        g_general_loss_flags |= kLossUnknownCallArgs;
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
        g_general_loss_flags |= kLossUnknownCallArgs;
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
      ctx.uses_uintptr = true;
      ctx.mark_gpr_read(rn);
      if (has_rm && rm < 31u) ctx.mark_gpr_read(rm);
      ctx.mark_gpr_write(0u);
      for (uint32_t r = 0u; r < 19u; ++r) ctx.clear_adrp(r);
    } else if (tb) {
      rec();
      g_general_loss_flags |= kLossIndirectCall;
      const uint32_t argc = ctx.call_argc ? static_cast<uint32_t>(ctx.call_argc[ctx.cur_insn_idx]) : 1u;
      tb->put_str("    x0 = ");
      emit_indirect_call_expr(*tb, "uint64", rn, argc);
      tb->put_str(";\n");
      for (uint32_t r = 0u; r < 19u; ++r) ctx.clear_adrp(r);
    }
    if (!cmp.is_nzcv_var) cmp.valid = false;
    return;
  }

  // BR Xn / BRAAZ / BRABZ / BRAA / BRAB (indirect branch / jump table / indirect tail call)
  if ((w & 0xFFFFFC1Fu) == 0xD61F0000u || (w & 0xFFFFF81Fu) == 0xD61F081Fu || (w & 0xFFFFF800u) == 0xD71F0800u) {
    const uint32_t rn = (w >> 5u) & 31u;
    const JumpTableInfo* jt = find_jump_table(ctx, ctx.cur_insn_idx);
    if (!emit) {
      ctx.mark_gpr_read(rn);
      if (jt && jt->resolved) {
        if (jt->index_reg < 31u) ctx.mark_gpr_read(jt->index_reg);
        ctx.uses_uint64_t = true;
        if (jt->index_is32) ctx.uses_uint32 = true;
        if (jt->index_clobbered) ctx.uses_sw_idx = true;
        if (jt->is_func_table && jt->case_targets) {
          for (uint32_t c = 0u; c < jt->case_count; ++c) {
            if (jt->case_targets[c] != base_addr) ctx.add_callee(jt->case_targets[c]);
          }
        }
      } else if (jt && jt->is_indirect_tail) {
        ctx.uses_uintptr = true;
      }
    } else if (tb) {
      rec();
      if (jt && jt->resolved && jt->case_targets && jt->case_count > 0u) {
        if (jt->index_clobbered) {
          tb->put_str("    switch (__hex_sw_idx) {\n");
        } else {
          tb->put_str(jt->index_is32 ? "    switch ((uint64_t)(uint32_t)" : "    switch ((uint64_t)");
          tb->put_reg_x(jt->index_reg < 31u ? jt->index_reg : rn);
          tb->put_str(") {\n");
        }
        if (jt->is_func_table) {
          g_general_loss_flags |= kLossUnknownCallArgs;
        }
        for (uint32_t c = 0u; c < jt->case_count; ++c) {
          tb->put_str("        case ");
          tb->put_u64_dec(c);
          if (jt->is_func_table) {
            if (ctx.returns_value && !ctx.returns_double && !ctx.returns_float) {
              tb->put_str(": return sub_");
              tb->put_u64_hex(jt->case_targets[c], true);
              tb->put_str("(/* arguments unknown */);\n");
            } else if (ctx.returns_float) {
              tb->put_str(": sub_");
              tb->put_u64_hex(jt->case_targets[c], true);
              tb->put_str("(/* arguments unknown */); return (float)d0;\n");
            } else if (ctx.returns_double) {
              tb->put_str(": sub_");
              tb->put_u64_hex(jt->case_targets[c], true);
              tb->put_str("(/* arguments unknown */); return d0;\n");
            } else {
              tb->put_str(": sub_");
              tb->put_u64_hex(jt->case_targets[c], true);
              tb->put_str("(/* arguments unknown */); return;\n");
            }
          } else {
            tb->put_str(": goto loc_");
            tb->put_u64_hex(jt->case_targets[c], true);
            tb->put_str(";\n");
          }
        }
        if (jt->has_default_target) {
          tb->put_str("        default: goto loc_");
          tb->put_u64_hex(jt->default_target, true);
          tb->put_str(";\n");
        } else if (ctx.returns_float) {
          tb->put_str("        default: return 0.0f;\n");
        } else if (ctx.returns_double) {
          tb->put_str("        default: return 0.0;\n");
        } else if (ctx.returns_value) {
          tb->put_str("        default: return 0;\n");
        } else {
          tb->put_str("        default: return;\n");
        }
        tb->put_str("    }\n");
      } else if (jt && jt->is_indirect_tail && rn != 30u) {
        g_general_loss_flags |= kLossIndirectCall;
        const uint32_t argc = ctx.call_argc ? static_cast<uint32_t>(ctx.call_argc[ctx.cur_insn_idx]) : 0u;
        if (ctx.returns_float) {
          tb->put_str("    return ");
          emit_indirect_call_expr(*tb, "float", rn, argc);
          tb->put_str(";\n");
        } else if (ctx.returns_double) {
          tb->put_str("    return ");
          emit_indirect_call_expr(*tb, "double", rn, argc);
          tb->put_str(";\n");
        } else if (ctx.returns_int32) {
          tb->put_str("    return ");
          emit_indirect_call_expr(*tb, "int32_t", rn, argc);
          tb->put_str(";\n");
        } else if (ctx.returns_value) {
          tb->put_str("    return ");
          emit_indirect_call_expr(*tb, "uint64", rn, argc);
          tb->put_str(";\n");
        } else {
          tb->put_str("    ");
          emit_indirect_call_expr(*tb, "void", rn, argc);
          tb->put_str(";\n    return;\n");
        }
      } else {
        g_general_loss_flags |= kLossUnresolvedIndirectBranch;
        tb->put_str("    __asm__ volatile(\"\" : : \"r\"(");
        tb->put_reg_x(rn);
        tb->put_str(")); /* unresolved indirect branch br ");
        tb->put_reg_x(rn);
        tb->put_str(" */\n");
        if (ctx.returns_float) tb->put_str("    return 0.0f;\n");
        else if (ctx.returns_double) tb->put_str("    return 0.0;\n");
        else if (ctx.returns_value) tb->put_str("    return 0;\n");
        else tb->put_str("    return;\n");
      }
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
        if (bit == 0u) {
          tb->put_str("    if ((");
          tb->put_reg_x(rt);
          tb->put_str(" & 1ULL) ");
        } else {
          tb->put_str("    if (((");
          tb->put_reg_x(rt);
          tb->put_str(" >> ");
          tb->put_u64_dec(bit);
          tb->put_str(") & 1ULL) ");
        }
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
        cmp = make_nzcv_cmp(!is64);
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
      cmp = make_nzcv_cmp(!is64);
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
      if (ctx.sp_promo && ctx.sp_promo->all_sp_promoted) {
        if (rn == 31u && rd == 31u) return;
        if (rn == 31u && rd == 29u && !is_sub && ctx.sp_promo->omit_x29_sp_mov) return;
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
      cmp = make_nzcv_cmp(!is64);
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
        tb->put_str(", __cb = ");
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
      cmp = make_nzcv_cmp(!is64);
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
      cmp = make_nzcv_cmp(!is64);
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
        tb->put_str("(uint64)(int64_t)(int32_t)");
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
      if (!op_neg && op2 == 1u && rn == 31u && rm == 31u && cond < 0xEu && cmp.valid) {
        // CSET rd, invert(cond) -> (uint64)(inv_cond) or (uint64)(!(cond))
        const uint32_t inv_cond = cond ^ 1u;
        tb->put_str("(uint64)");
        if (cmp.is_nzcv_var || (!cmp.is_ccmp && cond_fusable_for_cmp(cmp, inv_cond))) {
          emit_cond_expr(*tb, inv_cond, cmp);
        } else {
          tb->put_str("(!");
          emit_cond_expr(*tb, cond, cmp);
          tb->put_char(')');
        }
        tb->put_str(";\n");
        ctx.clear_adrp(rd);
        return;
      }
      if (!is64) tb->put_str("(uint32_t)(");
      emit_cond_expr(*tb, cond, cmp);
      tb->put_str(" ? ");
      tb->put_reg_x(rn);
      tb->put_str(" : ");
      if (!op_neg && op2 == 0u) {
        tb->put_reg_x(rm);
      } else if (!op_neg && op2 == 1u) {
        if (rm == 31u) {
          tb->put_str("1ULL");
        } else {
          tb->put_char('(');
          tb->put_reg_x(rm);
          tb->put_str(" + 1ULL)");
        }
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
      const bool omit_sp_wb = (rn == 31u && ctx.sp_promo && ctx.sp_promo->all_sp_promoted);
      if (mode == 3u && disp != 0 && !omit_sp_wb) {
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
      const bool has_sp_off = (rn == 31u && ctx.sp_promo && ctx.sp_promo->active &&
                               ctx.sp_promo->insn_sp_off &&
                               ctx.sp_promo->insn_sp_off[ctx.cur_insn_idx] != SpPromoState::kUnvisited);
      const int64_t sp_base = has_sp_off
          ? (ctx.sp_promo->insn_sp_off[ctx.cur_insn_idx] + ((mode == 3u) ? disp : 0LL))
          : 0LL;
      auto emit_one = [&](uint32_t reg, int64_t off) {
        if (!is_fp && is_load && reg == 31u) return;
        const SpSlot* slot = (has_sp_off && bits <= 64u)
            ? ctx.sp_promo->find_promoted(sp_base + off, static_cast<uint8_t>(bits >> 3u), is_fp)
            : nullptr;
        rec();
        tb->put_str("    ");
        if (is_load) {
          if (is_fp) {
            if (bits == 128u) tb->put_reg_q(reg);
            else tb->put_reg_d(reg);
          } else {
            tb->put_reg_x(reg);
          }
          if (slot) {
            if (is_ldpsw) tb->put_str(" = (uint64)(int64_t)(int32_t)");
            else if (is_fp && bits == 32u) tb->put_str(" = (double)");
            else tb->put_str(" = ");
            emit_local_sp_name(*tb, slot->slot_id);
            tb->put_str(";\n");
          } else {
            tb->put_str(is_ldpsw ? " = (uint64)(int64_t)" : " = ");
            emit_mem_deref(*tb, bits, is_ldpsw, is_fp, rn, off);
            tb->put_str(";\n");
          }
        } else {
          if (slot) {
            emit_local_sp_name(*tb, slot->slot_id);
          } else {
            emit_mem_deref(*tb, bits, false, is_fp, rn, off);
          }
          tb->put_str(" = ");
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
      if (mode == 1u && disp != 0 && !omit_sp_wb) {
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
      if (is_signed && !is_fp) {
        if (opc == 2u) ctx.uses_int64_t = true;
        else { ctx.uses_int32 = true; ctx.uses_uint32 = true; }
      }
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
      const bool omit_sp_wb = (rn == 31u && ctx.sp_promo && ctx.sp_promo->all_sp_promoted);
      if (idx_mode == 3u && disp != 0 && !omit_sp_wb) {
        rec();
        tb->put_str("    ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(" = ");
        tb->put_reg_x_or_sp(rn);
        tb->put_str(disp > 0 ? " + " : " - ");
        tb->put_imm(disp > 0 ? static_cast<uint64_t>(disp) : static_cast<uint64_t>(-disp));
        tb->put_str(";\n");
      }
      const bool raw_q_sub = is_fp_bh || (is_fp && (bits == 32u || bits == 64u) && ((ctx.q_used & (1u << rt)) != 0u));
      const SpSlot* sp_slot = nullptr;
      if (rn == 31u && !is_regoff && !raw_q_sub && bits <= 64u && ctx.sp_promo && ctx.sp_promo->active &&
          ctx.sp_promo->insn_sp_off &&
          ctx.sp_promo->insn_sp_off[ctx.cur_insn_idx] != SpPromoState::kUnvisited) {
        const int64_t sp_base = ctx.sp_promo->insn_sp_off[ctx.cur_insn_idx] + ((idx_mode == 3u) ? disp : 0LL);
        const int64_t eff_disp = (idx_mode == 1u || idx_mode == 3u) ? 0LL : disp;
        sp_slot = ctx.sp_promo->find_promoted(sp_base + eff_disp, static_cast<uint8_t>(bits >> 3u), is_fp);
      }
      if (!is_fp && is_load && rt == 31u) {
        // Discard load to XZR.
      } else {
        rec();
        tb->put_str("    ");
        if (is_load) {
          if (is_fp) {
            if (bits == 128u || raw_q_sub) tb->put_reg_q(rt);
            else tb->put_reg_d(rt);
          } else {
            tb->put_reg_x(rt);
          }
          if (sp_slot) {
            tb->put_str(" = ");
            if (is_fp) {
              if (bits == 32u) tb->put_str("(double)");
            } else if (is_signed) {
              if (bits == 8u) tb->put_str((opc == 2u) ? "(uint64)(int64_t)(int8_t)" : "(uint32_t)(int32_t)(int8_t)");
              else if (bits == 16u) tb->put_str((opc == 2u) ? "(uint64)(int64_t)(int16_t)" : "(uint32_t)(int32_t)(int16_t)");
              else if (bits == 32u) tb->put_str("(uint64)(int64_t)(int32_t)");
            }
            emit_local_sp_name(*tb, sp_slot->slot_id);
            tb->put_str(";\n");
          } else {
            tb->put_str(raw_q_sub ? " = (uint128)(" : " = ");
            if (is_regoff) {
              emit_mem_load_type(*tb, bits, raw_q_sub ? false : is_signed, raw_q_sub ? false : is_fp);
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
              tb->put_str(raw_q_sub ? "));\n" : ");\n");
            } else {
              emit_mem_deref(*tb, bits, raw_q_sub ? false : is_signed, raw_q_sub ? false : is_fp, rn,
                             (idx_mode == 1u || idx_mode == 3u) ? 0LL : disp);
              tb->put_str(raw_q_sub ? ");\n" : ";\n");
            }
          }
          if (is_fp) {
            if (bits == 128u || raw_q_sub) emit_sync_q_to_d(tb, ctx, rt, bits == 64u);
            else emit_sync_d_to_q(tb, ctx, rt, bits == 64u);
          } else if (rt < 31u) {
            ctx.clear_adrp(rt);
          }
        } else {
          if (sp_slot) {
            emit_local_sp_name(*tb, sp_slot->slot_id);
            tb->put_str(" = ");
          } else if (is_regoff) {
            emit_mem_load_type(*tb, bits, false, raw_q_sub ? false : is_fp);
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
            tb->put_str(") = ");
          } else {
            emit_mem_deref(*tb, bits, false, raw_q_sub ? false : is_fp, rn,
                           (idx_mode == 1u || idx_mode == 3u) ? 0LL : disp);
            tb->put_str(" = ");
          }
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
      if (idx_mode == 1u && disp != 0 && !omit_sp_wb) {
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
          emit_mem_deref(*tb, bits, false, false, rn, 0LL);
          tb->put_str(";\n");
          ctx.clear_adrp(rt);
        }
      } else {
        rec();
        tb->put_str("    ");
        emit_mem_deref(*tb, bits, false, false, rn, 0LL);
        tb->put_str(" = ");
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
      const bool is_plain_copy =
          (opcode != 1u && opcode != 2u && opcode != 3u && opcode != 4u &&
           opcode != 8u && opcode != 9u && opcode != 10u && opcode != 11u &&
           opcode != 12u && opcode != 14u && opcode != 15u);
      const bool dst_is_double_early = (opcode == 5u) || (opcode != 4u && ftype == 1u);
      if (is_plain_copy && rd == rn) {
        if ((ctx.q_used & (1u << rd)) != 0u) {
          rec();
          emit_sync_d_to_q(tb, ctx, rd, dst_is_double_early);
        }
        return;
      }
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
    cmp = make_nzcv_cmp(false);
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
    cmp = make_nzcv_cmp(!is64);
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
      cmp = make_nzcv_cmp(!is64);
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
      cmp = make_nzcv_cmp(false);
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
              tb->put_str(is_128 ? " = " : " = (uint128)");
              emit_mem_deref_typed(*tb, is_128 ? "uint128" : "uint64_t", rn, off);
              tb->put_str(";\n");
              emit_sync_q_to_d(tb, ctx, rg, sz == 3u);
            } else {
              emit_mem_deref_typed(*tb, is_128 ? "uint128" : "uint64_t", rn, off);
              tb->put_str(is_128 ? " = " : " = (uint64_t)");
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
      tb->put_str(" __old = ");
      emit_mem_deref_typed(*tb, ut, rn, 0LL);
      tb->put_str("; if (__old == (");
      tb->put_str(ut);
      tb->put_str(")");
      tb->put_reg_x(rs);
      tb->put_str(") ");
      emit_mem_deref_typed(*tb, ut, rn, 0LL);
      tb->put_str(" = (");
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
        tb->put_str(" __old = ");
        emit_mem_deref_typed(*tb, ut, rn, 0LL);
        tb->put_str("; ");
        emit_mem_deref_typed(*tb, ut, rn, 0LL);
        tb->put_str(" = ");
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
    g_general_loss_flags |= kLossUnsupportedInsn;
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

static bool emit_flat_state_machine(
    TextBuf& tb,
    uint32_t body_start_off,
    uint32_t body_start_line,
    uint32_t raw_lines,
    uint64_t base_addr,
    const char* fallback_ret,
    hex::Arena& work_arena,
    hex::Arena& emit_arena) {
  if (body_start_off >= tb.len) return false;

  // Helper to classify a flat line from pristine tb.data[body_start_off..tb.len].
  auto parse_flat_line = [](const char* s, uint32_t llen, uint64_t* out_lid,
                            uint32_t* out_cond_rel, uint32_t* out_cond_len) -> uint8_t {
    if (llen > 5u && starts_with(s, llen, "loc_", 4u) && s[llen - 1u] == ':') {
      uint64_t lid = 0ULL;
      if (parse_hex_u64(s + 4u, llen - 5u, &lid)) {
        *out_lid = lid;
        return 1u;
      }
    } else if (llen > 14u && starts_with(s, llen, "    goto loc_", 13u) && s[llen - 1u] == ';') {
      uint64_t lid = 0ULL;
      if (parse_hex_u64(s + 13u, llen - 14u, &lid)) {
        *out_lid = lid;
        return 3u;
      }
    } else if (llen > 20u && starts_with(s, llen, "    if (", 8u) && s[llen - 1u] == ';') {
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
          *out_lid = lid;
          *out_cond_rel = 8u;
          *out_cond_len = static_cast<uint32_t>(found) - 8u;
          return 2u;
        }
      }
    } else if (llen > 20u && (starts_with(s, llen, "        case ", 13u) || starts_with(s, llen, "        default: ", 17u)) && s[llen - 1u] == ';') {
      for (uint32_t k = 8u; k + 11u < llen; ++k) {
        if (starts_with(s + k, llen - k, ": goto loc_", 11u)) {
          const uint32_t h_off = k + 11u;
          const uint32_t h_len = llen - 1u - h_off;
          uint64_t lid = 0ULL;
          if (parse_hex_u64(s + h_off, h_len, &lid)) {
            *out_lid = lid;
            *out_cond_rel = 0u;
            *out_cond_len = k + 2u;
            return 4u;
          }
          break;
        }
      }
    }
    return 0u;
  };

  // Pass 0: Quick zero-alloc scan to count labels & gotos.
  uint32_t label_cnt = 0u;
  uint32_t goto_cnt = 0u;
  {
    uint32_t cur = body_start_off;
    while (cur < tb.len) {
      uint32_t nl = cur;
      while (nl < tb.len && tb.data[nl] != '\n') ++nl;
      uint64_t lid = 0ULL;
      uint32_t cr = 0u, cl = 0u;
      const uint8_t kind = parse_flat_line(tb.data + cur, nl - cur, &lid, &cr, &cl);
      if (kind == 1u) ++label_cnt;
      else if (kind == 2u || kind == 3u || kind == 4u) ++goto_cnt;
      cur = (nl < tb.len) ? (nl + 1u) : tb.len;
    }
  }
  if (goto_cnt == 0u) return false;

  // Build single open-addressed hash table:
  // ht_used: 0=empty, 1=referenced by goto, 2=defined+assigned sequential state_id.
  uint32_t ht_cap = 256u;
  const uint32_t ht_target = (label_cnt + 16u) * 4u;
  while (ht_cap < ht_target && ht_cap < 262144u) ht_cap <<= 1u;
  uint64_t* ht_keys = work_arena.alloc<uint64_t>(ht_cap);
  uint32_t* ht_state = work_arena.alloc<uint32_t>(ht_cap);
  uint8_t* ht_used = work_arena.alloc<uint8_t>(ht_cap);
  if (!ht_keys || !ht_state || !ht_used) {
    if (&work_arena != &emit_arena) {
      ht_keys = emit_arena.alloc<uint64_t>(ht_cap);
      ht_state = emit_arena.alloc<uint32_t>(ht_cap);
      ht_used = emit_arena.alloc<uint8_t>(ht_cap);
    }
    if (!ht_keys || !ht_state || !ht_used) return false;
  }
  __builtin_memset(ht_used, 0, ht_cap);
  const uint32_t ht_mask = ht_cap - 1u;

  auto ht_mark_ref = [&](uint64_t key) {
    uint32_t idx = static_cast<uint32_t>((key * 0x9E3779B97F4A7C15ULL) >> 32u) & ht_mask;
    for (uint32_t probe = 0u; probe < ht_cap; ++probe) {
      if (ht_used[idx] == 0u) {
        ht_used[idx] = 1u;
        ht_keys[idx] = key;
        ht_state[idx] = 0xFFFFFFFEu;
        return;
      }
      if (ht_keys[idx] == key) return;
      idx = (idx + 1u) & ht_mask;
    }
  };
  auto ht_lookup = [&](uint64_t key) -> int32_t {
    uint32_t idx = static_cast<uint32_t>((key * 0x9E3779B97F4A7C15ULL) >> 32u) & ht_mask;
    for (uint32_t probe = 0u; probe < ht_cap; ++probe) {
      if (ht_used[idx] == 0u) return -1;
      if (ht_keys[idx] == key) return static_cast<int32_t>(idx);
      idx = (idx + 1u) & ht_mask;
    }
    return -1;
  };
  auto find_state = [&](uint64_t key) -> int64_t {
    const int32_t idx = ht_lookup(key);
    if (idx < 0 || ht_used[idx] != 2u) return -1;
    return static_cast<int64_t>(ht_state[idx]);
  };

  // Pass 1a: Collect all referenced goto targets.
  {
    uint32_t cur = body_start_off;
    while (cur < tb.len) {
      uint32_t nl = cur;
      while (nl < tb.len && tb.data[nl] != '\n') ++nl;
      uint64_t lid = 0ULL;
      uint32_t cr = 0u, cl = 0u;
      const uint8_t kind = parse_flat_line(tb.data + cur, nl - cur, &lid, &cr, &cl);
      if (kind == 2u || kind == 3u || kind == 4u) ht_mark_ref(lid);
      cur = (nl < tb.len) ? (nl + 1u) : tb.len;
    }
  }

  // Pass 1b: Assign sequential state_ids to every defined & referenced label.
  bool first_non_skip_checked = false;
  uint32_t next_sid = 1u;
  {
    uint32_t cur = body_start_off;
    while (cur < tb.len) {
      uint32_t nl = cur;
      while (nl < tb.len && tb.data[nl] != '\n') ++nl;
      uint64_t lid = 0ULL;
      uint32_t cr = 0u, cl = 0u;
      const uint8_t kind = parse_flat_line(tb.data + cur, nl - cur, &lid, &cr, &cl);
      if (kind == 1u) {
        const int32_t idx = ht_lookup(lid);
        if (idx >= 0 && ht_used[idx] == 1u) {
          if (!first_non_skip_checked) {
            first_non_skip_checked = true;
            next_sid = 0u;
          }
          ht_used[idx] = 2u;
          ht_state[idx] = next_sid++;
        }
      } else {
        if (!first_non_skip_checked) {
          first_non_skip_checked = true;
          next_sid = 1u;
        }
      }
      cur = (nl < tb.len) ? (nl + 1u) : tb.len;
    }
  }

  const uint32_t max_orig = body_start_line + raw_lines + 4u;
  uint32_t* line_remap = work_arena.alloc<uint32_t>(max_orig + 1u);
  if (!line_remap && &work_arena != &emit_arena) {
    line_remap = emit_arena.alloc<uint32_t>(max_orig + 1u);
  }
  if (!line_remap) return false;

  auto serialize_flat = [&](char* dst, uint32_t dst_cap, uint32_t* out_wp, uint32_t* out_line_final) -> bool {
    for (uint32_t i = 0u; i <= max_orig; ++i) line_remap[i] = 0u;
    uint32_t wp = 0u;
    bool overflow = false;
    auto put_ch = [&](char ch) {
      if (wp + 1u < dst_cap) dst[wp++] = ch;
      else overflow = true;
    };
    auto put_mem = [&](const char* s, uint32_t l) {
      if (wp + l < dst_cap) {
        hex::mem_copy(dst + wp, s, l);
        wp += l;
      } else {
        overflow = true;
      }
    };
    auto put_u32 = [&](uint32_t v) {
      char dbuf[12];
      uint32_t dn = 0u;
      if (v == 0u) dbuf[dn++] = '0';
      else {
        char tmp[12];
        uint32_t tn = 0u;
        while (v > 0u) {
          tmp[tn++] = static_cast<char>('0' + (v % 10u));
          v /= 10u;
        }
        while (tn > 0u) dbuf[dn++] = tmp[--tn];
      }
      put_mem(dbuf, dn);
    };

    auto put_hex = [&](uint64_t v) {
      static constexpr char kHex[] = "0123456789ABCDEF";
      char hbuf[18];
      uint32_t hn = 0u;
      if (v == 0ULL) hbuf[hn++] = '0';
      else {
        char tmp[18];
        uint32_t tn = 0u;
        while (v > 0ULL) {
          tmp[tn++] = kHex[v & 0xFu];
          v >>= 4u;
        }
        while (tn > 0u) hbuf[hn++] = tmp[--tn];
      }
      put_mem(hbuf, hn);
    };

    // Copy prelude verbatim
    put_mem(tb.data, body_start_off);
    for (uint32_t l = 1u; l < body_start_line && l <= max_orig; ++l) line_remap[l] = l;

    uint32_t out_line = body_start_line;
    put_mem("    unsigned int __hex_state = 0u;\n", 35u);
    put_mem("    while (__hex_state != 0xFFFFFFFFu) {\n", 41u);
    put_mem("        switch (__hex_state) {\n", 31u);
    put_mem("        case 0u: /* entry 0x", 28u);
    put_hex(base_addr);
    put_mem(" */\n", 4u);
    out_line += 4u;

    bool in_case = true;
    bool case_has_stmt = false;
    bool last_was_term = false;
    bool first_seen = false;

    uint32_t cur = body_start_off;
    uint32_t cur_line = body_start_line;
    while (cur < tb.len && !overflow) {
      uint32_t nl = cur;
      while (nl < tb.len && tb.data[nl] != '\n') ++nl;
      const uint32_t llen = nl - cur;
      const char* s = tb.data + cur;
      uint64_t lid = 0ULL;
      uint32_t cr = 0u, cl = 0u;
      const uint8_t kind = parse_flat_line(s, llen, &lid, &cr, &cl);

      if (kind == 1u) {
        const int64_t sid = find_state(lid);
        if (sid >= 0) {
          if (!first_seen && sid == 0) {
            first_seen = true;
            if (cur_line <= max_orig && line_remap[cur_line] == 0u) {
              line_remap[cur_line] = (out_line > 1u) ? (out_line - 1u) : 1u;
            }
          } else {
            first_seen = true;
            if (in_case && (!case_has_stmt || !last_was_term)) {
              put_mem("            __hex_state = ", 26u);
              put_u32(static_cast<uint32_t>(sid));
              put_mem("u; break;\n", 10u);
              ++out_line;
            }
            if (cur_line <= max_orig && line_remap[cur_line] == 0u) {
              line_remap[cur_line] = out_line;
            }
            put_mem("        case ", 13u);
            put_u32(static_cast<uint32_t>(sid));
            put_mem("u: /* block 0x", 14u);
            put_hex(lid);
            put_mem(" */\n", 4u);
            ++out_line;
            in_case = true;
            case_has_stmt = false;
            last_was_term = false;
          }
        }
      } else if (kind == 3u) {
        first_seen = true;
        if (cur_line <= max_orig && line_remap[cur_line] == 0u) line_remap[cur_line] = out_line;
        const int64_t sid = find_state(lid);
        if (sid >= 0) {
          put_mem("            __hex_state = ", 26u);
          put_u32(static_cast<uint32_t>(sid));
          put_mem("u; break;\n", 10u);
        } else {
          put_mem("        ", 8u);
          put_mem(s, llen);
          put_ch('\n');
        }
        ++out_line;
        case_has_stmt = true;
        last_was_term = true;
      } else if (kind == 2u) {
        first_seen = true;
        if (cur_line <= max_orig && line_remap[cur_line] == 0u) line_remap[cur_line] = out_line;
        const int64_t sid = find_state(lid);
        if (sid >= 0) {
          put_mem("            if (", 16u);
          put_mem(s + cr, cl);
          put_mem(") { __hex_state = ", 18u);
          put_u32(static_cast<uint32_t>(sid));
          put_mem("u; break; }\n", 12u);
        } else {
          put_mem("        ", 8u);
          put_mem(s, llen);
          put_ch('\n');
        }
        ++out_line;
        case_has_stmt = true;
        last_was_term = false;
      } else if (kind == 4u) {
        first_seen = true;
        if (cur_line <= max_orig && line_remap[cur_line] == 0u) line_remap[cur_line] = out_line;
        const int64_t sid = find_state(lid);
        if (sid >= 0) {
          put_mem("        ", 8u);
          put_mem(s + cr, cl);
          put_mem("{ __hex_state = ", 16u);
          put_u32(static_cast<uint32_t>(sid));
          put_mem("u; continue; }\n", 15u);
        } else {
          put_mem("        ", 8u);
          put_mem(s, llen);
          put_ch('\n');
        }
        ++out_line;
        case_has_stmt = true;
        last_was_term = false;
      } else {
        first_seen = true;
        if (cur_line <= max_orig && line_remap[cur_line] == 0u) line_remap[cur_line] = out_line;
        put_mem("        ", 8u);
        put_mem(s, llen);
        put_ch('\n');
        ++out_line;
        case_has_stmt = true;
        last_was_term = (starts_with(s, llen, "    return", 10u) && llen >= 11u && s[llen - 1u] == ';') ||
                        starts_with(s, llen, "    __builtin_trap();", 21u);
      }
      cur = (nl < tb.len) ? (nl + 1u) : tb.len;
      ++cur_line;
    }

    if (in_case && (!case_has_stmt || !last_was_term)) {
      put_mem("            __hex_state = 0xFFFFFFFFu; break;\n", 46u);
      ++out_line;
    }
    put_mem("        default:\n", 17u);
    put_mem("            __hex_state = 0xFFFFFFFFu;\n", 39u);
    put_mem("            break;\n", 19u);
    put_mem("        }\n", 10u);
    put_mem("    }\n", 6u);
    out_line += 5u;
    if (fallback_ret) {
      uint32_t flen = 0u;
      while (fallback_ret[flen] != '\0') ++flen;
      put_mem(fallback_ret, flen);
      ++out_line;
    }
    if (overflow || wp + 4u >= dst_cap) return false;
    dst[wp] = '\0';
    *out_wp = wp;
    *out_line_final = out_line;
    return true;
  };

  const size_t out_mark = work_arena.used();
  const uint32_t est_cap = tb.len + (raw_lines * 32u) + 32768u;
  uint32_t new_cap = (est_cap < tb.cap) ? est_cap : tb.cap;
  char* out_mem = work_arena.alloc<char>(new_cap);
  bool copy_back = true;
  uint32_t wp = 0u;
  uint32_t out_line = body_start_line;
  bool ok = (out_mem != nullptr) && serialize_flat(out_mem, new_cap, &wp, &out_line);
  if (!ok) {
    work_arena.restore(out_mark);
    const uint32_t big_cap = (est_cap > tb.cap) ? est_cap : (tb.len * 2u + 32768u);
    out_mem = emit_arena.alloc<char>(big_cap);
    copy_back = false;
    if (out_mem) {
      new_cap = big_cap;
      ok = serialize_flat(out_mem, new_cap, &wp, &out_line);
    }
  }
  if (!ok) return false;

  uint32_t last_valid = (out_line > 1u) ? (out_line - 1u) : 1u;
  for (int32_t l = static_cast<int32_t>(max_orig); l >= 1; --l) {
    if (line_remap[l] != 0u) last_valid = line_remap[l];
    else line_remap[l] = last_valid;
  }
  for (uint32_t k = 0u; k < tb.lm_count; ++k) {
    const uint32_t ol = tb.lm[k].line_no;
    if (ol >= 1u && ol <= max_orig) tb.lm[k].line_no = line_remap[ol];
  }

  if (copy_back) {
    hex::mem_copy(tb.data, out_mem, wp + 1u);
  } else {
    tb.data = out_mem;
    tb.cap = new_cap;
  }
  tb.len = wp;
  tb.line_no = out_line;
  return true;
}

static bool structurize_c_body(
    TextBuf& tb,
    uint32_t body_start_off,
    uint32_t body_start_line,
    uint64_t base_addr,
    const char* fallback_ret,
    hex::Arena& work_arena,
    hex::Arena& emit_arena) {
  if (body_start_off >= tb.len) return false;
  const size_t struct_mark = work_arena.used();
  const uint32_t body_len = tb.len - body_start_off;
  // Count lines in body
  uint32_t raw_lines = 0u;
  for (uint32_t i = body_start_off; i < tb.len; ++i) {
    if (tb.data[i] == '\n') ++raw_lines;
  }
  if (raw_lines < 2u) return false;
  if (raw_lines > 8192u) {
    return emit_flat_state_machine(tb, body_start_off, body_start_line, raw_lines, base_addr, fallback_ret, work_arena, emit_arena);
  }

  const uint32_t cap = raw_lines + raw_lines / 2u + 128u;
  SLine* stmts = work_arena.alloc<SLine>(cap);
  uint32_t* active = work_arena.alloc<uint32_t>(cap);
  int32_t* depth_arr = work_arena.alloc<int32_t>(cap);
  if (!stmts || !active || !depth_arr) {
    work_arena.restore(struct_mark);
    return emit_flat_state_machine(tb, body_start_off, body_start_line, raw_lines, base_addr, fallback_ret, work_arena, emit_arena);
  }

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
    } else if (llen > 20u && (starts_with(s, llen, "        case ", 13u) || starts_with(s, llen, "        default: ", 17u)) && s[llen - 1u] == ';') {
      for (uint32_t k = 8u; k + 11u < llen; ++k) {
        if (starts_with(s + k, llen - k, ": goto loc_", 11u)) {
          const uint32_t h_off = k + 11u;
          const uint32_t h_len = llen - 1u - h_off;
          uint64_t lid = 0ULL;
          if (parse_hex_u64(s + h_off, h_len, &lid)) {
            sl.kind = 6u;
            sl.label_id = lid;
          }
          break;
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
      if (x.kind != 2u && x.kind != 3u && x.kind != 6u) continue;
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
      if ((x.kind == 2u || x.kind == 3u || x.kind == 6u) && x.label_id == lid) ++rc;
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

  auto get_stmt_text = [&](const SLine& x, const char** out_ptr, uint32_t* out_len) -> bool {
    if (x.kind == 0u) {
      *out_ptr = tb.data + x.off;
      *out_len = x.len;
      return true;
    }
    if (x.kind == 4u && x.synth) {
      *out_ptr = x.synth;
      *out_len = x.synth_len;
      return true;
    }
    *out_ptr = nullptr;
    *out_len = 0u;
    return false;
  };

  auto strip4_ptr = [&](const char* ss, uint32_t slen) -> uint32_t {
    return (slen >= 4u && ss[0] == ' ' && ss[1] == ' ' && ss[2] == ' ' && ss[3] == ' ') ? 4u : 0u;
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

  auto is_trap_stmt = [&](const SLine& x) -> bool {
    if (x.kind == 0u) {
      const char* ns = tb.data + x.off;
      return starts_with(ns, x.len, "    __builtin_trap();", 21u);
    }
    if (x.kind == 4u && x.synth && x.brace_delta == 0) {
      return starts_with(x.synth, x.synth_len, "    __builtin_trap();", 21u);
    }
    return false;
  };

  auto is_terminator = [&](const SLine& x) -> bool {
    if (x.kind == 3u) return true;
    if (is_return_stmt(x)) return true;
    if (is_trap_stmt(x)) return true;
    if (x.kind == 4u && x.synth && x.brace_delta == 0) {
      return starts_with(x.synth, x.synth_len, "    break;", 10u) ||
             starts_with(x.synth, x.synth_len, "    continue;", 13u);
    }
    return false;
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

  auto is_else_open = [&](uint32_t ck) -> bool {
    const SLine& sc = stmts[active[ck]];
    return sc.kind == 4u && sc.brace_delta == 0 && sc.synth &&
           starts_with(sc.synth, sc.synth_len, "    } else {", 12u);
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

  // V5-5: Step out of an enclosing IF/ELSE closing `}` or `} else { ... }` at depth `cur_d - 1`.
  // Returns the active index immediately after the enclosing IF/ELSE block, or 0 if not an IF/ELSE boundary.
  auto step_out_if_else = [&](uint32_t k, int32_t cur_d, uint32_t acount) -> uint32_t {
    if (k >= acount || cur_d <= 0 || depth_arr[k] != cur_d - 1) return 0u;
    if (is_if_else_close(k)) return k + 1u;
    if (is_else_open(k)) {
      for (uint32_t m = k + 1u; m < acount; ++m) {
        if (depth_arr[m] < cur_d - 1) return 0u;
        if (depth_arr[m] == cur_d - 1) {
          return is_if_else_close(m) ? (m + 1u) : 0u;
        }
      }
    }
    return 0u;
  };

  // Returns the active index of the innermost enclosing loop header for `pos`, or -1 if outside any loop.
  auto enclosing_loop_idx = [&](uint32_t pos) -> int32_t {
    int32_t cur_d = depth_arr[pos];
    if (cur_d <= 0) return -1;
    for (int32_t k = static_cast<int32_t>(pos) - 1; k >= 0; --k) {
      if (depth_arr[k] < cur_d) {
        cur_d = depth_arr[k];
        const SLine& sk = stmts[active[k]];
        if (sk.kind == 4u && sk.brace_delta == 1 && sk.synth &&
            (starts_with(sk.synth, sk.synth_len, "    do {", 8u) ||
             starts_with(sk.synth, sk.synth_len, "    while (", 11u))) {
          return k;
        }
        if (cur_d == 0) break;
      }
    }
    return -1;
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

    // Rule 0c: Unreachable Dead-Code Elimination (DCE) after unconditional goto/return/break/continue/__builtin_trap
    for (uint32_t a = 0u; a + 1u < acount; ++a) {
      const SLine& sa = stmts[active[a]];
      if (!is_terminator(sa)) continue;
      const int32_t ad = depth_arr[a];
      for (uint32_t k = a + 1u; k < acount; ++k) {
        if (depth_arr[k] != ad) break;
        SLine& sk = stmts[active[k]];
        if (sk.kind == 1u || sk.brace_delta != 0) break;
        if (is_else_open(k)) break;
        sk.kind = 5u;
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // Rule 0d (V5-5): Multi-level IF/ELSE block-exit fallthrough deletion for unconditional `goto L;`
    // Deletes `goto L;` when crossing only IF/ELSE closing `}`s or `} else { ... }`s (never LOOP!) reaches `L:`.
    for (uint32_t a = 0u; a + 2u < acount; ++a) {
      SLine& sa = stmts[active[a]];
      if (sa.kind != 3u || depth_arr[a] <= 0) continue;
      int32_t cur_d = depth_arr[a];
      uint32_t k = a + 1u;
      uint32_t crossed = 0u;
      while (k < acount && cur_d > 0) {
        const uint32_t next_k = step_out_if_else(k, cur_d, acount);
        if (next_k == 0u) break;
        --cur_d;
        ++crossed;
        k = next_k;
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
          bool has_case_ref = false;
          for (uint32_t k = 0u; k < acount; ++k) {
            if (stmts[active[k]].kind == 6u && stmts[active[k]].label_id == l1) {
              has_case_ref = true;
              break;
            }
          }
          if (!has_case_ref) {
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
    }
    if (changed) continue;

    // Rule 7: Short-circuit || merge: consecutive `if (C1) goto L; if (C2) goto L;` at same depth -> `if ((C1) || (C2)) goto L;`
    for (uint32_t a = 0u; a + 1u < acount && !changed; ++a) {
      SLine& s1 = stmts[active[a]];
      SLine& s2 = stmts[active[a + 1u]];
      if (s1.kind == 2u && s2.kind == 2u && depth_arr[a] == depth_arr[a + 1u] && s1.label_id == s2.label_id &&
          s1.cond_len + s2.cond_len < 512u) {
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

    // V5-1: Rule 5 epilogue folding helper (called both pre-Rule-4 and as post-Rule-4c fallback):
    // Supports straight-line epilogues (<= 24 stmts) ending in `return ...;` / `{ ... return ...; }` (kind 0 or 4)
    // or `__builtin_trap();`, balanced structured `if`/`else` epilogues (<= 16 stmts, no gotos/labels/loops),
    // and depth-0 cold EOF noreturn blocks (1..12 balanced stmts preceded by a terminator, ending at EOF).
    auto try_rule5 = [&](bool is_fallback) -> bool {
      for (uint32_t a = 0u; a + 1u < acount; ++a) {
        const SLine& sl = stmts[active[a]];
        if (sl.kind != 1u) continue;
        const uint32_t refs = count_refs(sl.label_id, acount);
        if (refs == 0u) continue;
        const int32_t ld = depth_arr[a];

        int32_t ret_idx = -1;
        int32_t rel_d = 0;
        bool has_braces = false;
        bool valid_scan = true;
        bool reached_eof = false;
        for (uint32_t k = a + 1u; k < acount && k <= a + 24u; ++k) {
          if (depth_arr[k] < ld) { valid_scan = false; break; }
          const SLine& sk = stmts[active[k]];
          if (sk.kind != 0u && sk.kind != 4u) { valid_scan = false; break; }
          if (sk.kind == 4u) {
            if (!sk.synth) { valid_scan = false; break; }
            if (starts_with(sk.synth, sk.synth_len, "    do {", 8u) ||
                starts_with(sk.synth, sk.synth_len, "    while (", 11u) ||
                starts_with(sk.synth, sk.synth_len, "    } while (", 13u) ||
                ends_with(sk.synth, sk.synth_len, "break;", 6u) ||
                ends_with(sk.synth, sk.synth_len, "continue;", 9u)) {
              valid_scan = false;
              break;
            }
          }
          const bool is_eh = is_else_open(k);
          if (sk.brace_delta < 0) {
            rel_d += sk.brace_delta;
            if (rel_d < 0) { valid_scan = false; break; }
          }
          if (sk.brace_delta != 0 || is_eh) has_braces = true;
          if (rel_d == 0 && !is_eh && sk.brace_delta == 0) {
            if (is_return_stmt(sk) || is_trap_stmt(sk)) {
              if (!has_braces || (k - a) <= 16u) {
                ret_idx = static_cast<int32_t>(k);
              }
              break;
            }
          }
          if (sk.brace_delta > 0) rel_d += sk.brace_delta;
          if (k + 1u == acount) reached_eof = true;
        }

        bool is_cold_eof = false;
        if (is_fallback && ret_idx < 0 && valid_scan && reached_eof && rel_d == 0 && ld == 0 &&
            a > 0u && depth_arr[a - 1u] == 0 && is_terminator(stmts[active[a - 1u]])) {
          const uint32_t rem = (acount - 1u) - a;
          const SLine& last_sl = stmts[active[acount - 1u]];
          if (rem >= 1u && rem <= 12u && last_sl.kind == 0u) {
            const char* lp = nullptr;
            uint32_t ll = 0u;
            if (get_stmt_text(last_sl, &lp, &ll) && ends_with(lp, ll, ");", 2u)) {
              uint32_t p = 0u;
              while (p < ll && lp[p] == ' ') ++p;
              // Skip optional simple register assignment prefix `xN = ` or `wN = ` or `dN = `
              uint32_t eq = p;
              while (eq < ll && ((lp[eq] >= 'a' && lp[eq] <= 'z') || (lp[eq] >= '0' && lp[eq] <= '9') || lp[eq] == '_')) ++eq;
              if (eq > p && eq + 3u <= ll && lp[eq] == ' ' && lp[eq + 1u] == '=' && lp[eq + 2u] == ' ') {
                p = eq + 3u;
              }
              // Require an unconditional direct call `ident(...);`, excluding control keywords and casts `(type)...`
              auto is_id0 = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; };
              auto is_id = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'; };
              if (p < ll && is_id0(lp[p])) {
                uint32_t id_end = p + 1u;
                while (id_end < ll && is_id(lp[id_end])) ++id_end;
                const uint32_t id_len = id_end - p;
                const bool is_kw = (id_len == 2u && lp[p] == 'i' && lp[p + 1u] == 'f') ||
                                   (id_len == 3u && lp[p] == 'f' && lp[p + 1u] == 'o' && lp[p + 2u] == 'r') ||
                                   (id_len == 5u && starts_with(lp + p, id_len, "while", 5u)) ||
                                   (id_len == 6u && starts_with(lp + p, id_len, "switch", 6u)) ||
                                   (id_len == 6u && starts_with(lp + p, id_len, "return", 6u)) ||
                                   (id_len == 6u && starts_with(lp + p, id_len, "sizeof", 6u));
                if (!is_kw && id_end < ll && lp[id_end] == '(') {
                  // Ensure the `(` at id_end matches the closing `)` right before `;`
                  int32_t pdepth = 0;
                  bool matches_end = false;
                  for (uint32_t q = id_end; q + 1u < ll; ++q) {
                    if (lp[q] == '(') ++pdepth;
                    else if (lp[q] == ')') {
                      --pdepth;
                      if (pdepth == 0) {
                        matches_end = (q + 2u == ll && lp[q + 1u] == ';');
                        break;
                      }
                    }
                  }
                  if (matches_end) {
                    ret_idx = static_cast<int32_t>(acount - 1u);
                    is_cold_eof = true;
                  }
                }
              }
            }
          }
        }
        if (ret_idx < 0) continue;

        const uint32_t ep_cnt = static_cast<uint32_t>(ret_idx) - a;
        if (ep_cnt == 0u) continue;
        // Pre-Rule-4 skip: defer duplicating a multi-stmt 1-ref fallthrough epilogue so Rule 3/V4-1/Rule 4
        // can form clean `if/else` first; the post-Rule-4c fallback (`is_fallback == true`) folds any remainder.
        if (!is_fallback && !is_cold_eof && ep_cnt > 1u && refs == 1u && a > 0u &&
            depth_arr[a - 1u] == ld && !is_terminator(stmts[active[a - 1u]])) {
          continue;
        }
        if (refs * ep_cnt > 320u) continue;

        // Compute combined inline epilogue text (bounded <= 1800 bytes)
        uint32_t ep_bytes = 0u;
        bool text_ok = true;
        for (uint32_t e = 0u; e < ep_cnt; ++e) {
          const SLine& se = stmts[active[a + 1u + e]];
          const char* sptr = nullptr;
          uint32_t slen = 0u;
          if (!get_stmt_text(se, &sptr, &slen)) { text_ok = false; break; }
          const uint32_t st = strip4_ptr(sptr, slen);
          ep_bytes += (slen - st) + (e > 0u ? 1u : 0u);
        }
        if (!text_ok || ep_bytes == 0u || ep_bytes > 1800u) continue;
        if (r5_total_added + refs * ep_bytes > tb.cap / 4u) continue;

        char* ep_txt = work_arena.alloc<char>(ep_bytes + 4u);
        if (!ep_txt) continue;
        uint32_t ep_len = 0u;
        for (uint32_t e = 0u; e < ep_cnt; ++e) {
          if (e > 0u) ep_txt[ep_len++] = ' ';
          const SLine& se = stmts[active[a + 1u + e]];
          const char* ss = nullptr;
          uint32_t slen = 0u;
          get_stmt_text(se, &ss, &slen);
          const uint32_t start = strip4_ptr(ss, slen);
          for (uint32_t z = start; z < slen; ++z) ep_txt[ep_len++] = ss[z];
        }
        ep_txt[ep_len] = '\0';

        const bool wrap_braces = (ep_cnt > 1u) || has_braces || (stmts[active[a + 1u]].kind == 4u);
        uint32_t rewritten = 0u;
        for (uint32_t k = 0u; k < acount; ++k) {
          SLine& sk = stmts[active[k]];
          if (sk.kind == 3u && sk.label_id == sl.label_id) {
            uint32_t rlen = 0u;
            const char* rtxt = (!wrap_braces)
                ? alloc_synth(work_arena, "    ", 4u, ep_txt, ep_len, "", 0u, &rlen)
                : alloc_synth(work_arena, "    { ", 6u, ep_txt, ep_len, " }", 2u, &rlen);
            if (rtxt) {
              sk.kind = 4u; sk.synth = rtxt; sk.synth_len = rlen; sk.brace_delta = 0;
              r5_total_added += ep_len;
              ++rewritten;
            }
          } else if (sk.kind == 2u && sk.label_id == sl.label_id) {
            const char* cptr = (sk.cond_off == 0xFFFFFFFFu) ? sk.synth : (tb.data + sk.cond_off);
            const uint32_t extra = (!wrap_braces) ? 2u : 6u;
            const uint32_t total = 8u + sk.cond_len + extra + ep_len;
            char* rtxt = work_arena.alloc<char>(total + 1u);
            if (rtxt) {
              uint32_t wp2 = 0u;
              const char* pfx = "    if (";
              for (uint32_t z = 0u; z < 8u; ++z) rtxt[wp2++] = pfx[z];
              for (uint32_t z = 0u; z < sk.cond_len; ++z) rtxt[wp2++] = cptr[z];
              if (!wrap_braces) {
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
              ++rewritten;
            }
          }
        }
        if (rewritten > 0u) {
          if (is_cold_eof && rewritten == refs) {
            for (uint32_t k = a; k < acount; ++k) stmts[active[k]].kind = 5u;
          }
          any_change = true;
          return true;
        }
      }
      return false;
    };

    if (try_rule5(false)) { changed = true; continue; }

    // Rule 8 + V5-3b: Loop-continue folding with proper nested-loop stack tracking:
    // (a) L_cont: immediately before loop closing brace -> continue;
    // (b) V5-3b: L_hdr: immediately before `while (1) {` or `do { ... } while (W);` with back-edges
    //     at loop_depth == 0 -> convert `do-while(W)` to `while (1) { ... if (!(W)) break; }` and emit `continue;`.
    for (uint32_t a = 0u; a < acount && !changed; ++a) {
      const SLine& sh = stmts[active[a]];
      if (sh.kind != 4u || sh.brace_delta != 1 || !sh.synth) continue;
      const bool is_do = starts_with(sh.synth, sh.synth_len, "    do {", 8u);
      const bool is_while1 = starts_with(sh.synth, sh.synth_len, "    while (1) {", 15u);
      const bool is_while_any = starts_with(sh.synth, sh.synth_len, "    while (", 11u);
      if (!is_do && !is_while_any) continue;
      const int32_t ld = depth_arr[a];
      int32_t close_idx = -1;
      for (uint32_t k = a + 1u; k < acount; ++k) {
        if (depth_arr[k] == ld && stmts[active[k]].brace_delta == -1) {
          close_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (close_idx < 2) continue;
      const uint32_t ci = static_cast<uint32_t>(close_idx);

      // Rule 8a: L_cont: immediately before loop closing brace
      if (stmts[active[ci - 1u]].kind == 1u && depth_arr[ci - 1u] == ld + 1) {
        const uint64_t cont_lid = stmts[active[ci - 1u]].label_id;
        int32_t loop_stack[32];
        uint32_t loop_depth = 0u;
        for (uint32_t k = a + 1u; k < ci - 1u; ++k) {
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
        if (changed) break;
      }

      // V5-3b: L_hdr: immediately before `while (1) {` or `do { ... } while (W);`
      if ((is_while1 || is_do) && a > 0u && stmts[active[a - 1u]].kind == 1u && depth_arr[a - 1u] == ld) {
        const uint64_t hdr_lid = stmts[active[a - 1u]].label_id;
        const SLine& scls = stmts[active[ci]];
        const char* w_ptr = nullptr;
        uint32_t w_len = 0u;
        bool convert_do_to_while1 = false;
        if (is_do) {
          if (!scls.synth || scls.synth_len <= 15u ||
              !starts_with(scls.synth, scls.synth_len, "    } while (", 13u) ||
              !ends_with(scls.synth, scls.synth_len, ");", 2u)) {
            continue;
          }
          w_ptr = scls.synth + 13u;
          w_len = scls.synth_len - 15u;
          convert_do_to_while1 = !(w_len == 1u && w_ptr[0] == '1');
        }
        uint32_t hit_cnt = 0u;
        bool has_bare_cont = false;
        int32_t loop_stack[32];
        uint32_t loop_depth = 0u;
        for (uint32_t k = a + 1u; k < ci; ++k) {
          const SLine& sk = stmts[active[k]];
          if (sk.kind == 4u && sk.brace_delta == 1 && sk.synth &&
              (starts_with(sk.synth, sk.synth_len, "    do {", 8u) ||
               starts_with(sk.synth, sk.synth_len, "    while (", 11u))) {
            if (loop_depth < 32u) loop_stack[loop_depth++] = depth_arr[k];
            else { hit_cnt = 0u; break; }
            continue;
          }
          if (sk.kind == 4u && sk.brace_delta == -1 && loop_depth > 0u &&
              depth_arr[k] == loop_stack[loop_depth - 1u]) {
            --loop_depth;
            continue;
          }
          if (loop_depth > 0u) continue;
          if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == hdr_lid) {
            ++hit_cnt;
          } else if (convert_do_to_while1 && sk.kind == 4u && sk.synth &&
                     ends_with(sk.synth, sk.synth_len, "continue;", 9u)) {
            has_bare_cont = true;
          }
        }
        if (hit_cnt > 0u && !has_bare_cont && (!convert_do_to_while1 || n + 1u < cap)) {
          uint32_t w1len = 0u, brklen = 0u, w1clen = 0u;
          const char* w1_hdr = convert_do_to_while1 ? alloc_synth(work_arena, "    while (1) {", 15u, "", 0u, "", 0u, &w1len) : "";
          const char* brk_txt = convert_do_to_while1 ? alloc_neg_cond(work_arena, w_ptr, w_len, "    if (", 8u, ") break;", 8u, &brklen) : "";
          const char* w1_cls = convert_do_to_while1 ? alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &w1clen) : "";
          if (w1_hdr && brk_txt && w1_cls) {
            const uint32_t lp_pos = active[a];
            const uint32_t ci_pos = active[ci];
            const uint16_t lp_ind = sh.indent;
            const uint32_t ci_oline = scls.orig_line;
            loop_depth = 0u;
            for (uint32_t k = a + 1u; k < ci; ++k) {
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
              if (sk.kind == 3u && sk.label_id == hdr_lid) {
                uint32_t clen2 = 0u;
                const char* ctxt = alloc_synth(work_arena, "    continue;", 13u, "", 0u, "", 0u, &clen2);
                if (ctxt) { sk.kind = 4u; sk.synth = ctxt; sk.synth_len = clen2; changed = true; any_change = true; }
              } else if (sk.kind == 2u && sk.label_id == hdr_lid) {
                const char* cptr = (sk.cond_off == 0xFFFFFFFFu) ? sk.synth : (tb.data + sk.cond_off);
                uint32_t clen2 = 0u;
                const char* ctxt = alloc_synth(work_arena, "    if (", 8u, cptr, sk.cond_len, ") continue;", 11u, &clen2);
                if (ctxt) { sk.kind = 4u; sk.synth = ctxt; sk.synth_len = clen2; changed = true; any_change = true; }
              }
            }
            if (changed && convert_do_to_while1) {
              stmts[lp_pos].synth = w1_hdr;
              stmts[lp_pos].synth_len = w1len;
              stmts[ci_pos].synth = w1_cls;
              stmts[ci_pos].synth_len = w1clen;
              SLine brk_sl{};
              brk_sl.kind = 4u; brk_sl.synth = brk_txt; brk_sl.synth_len = brklen; brk_sl.brace_delta = 0;
              brk_sl.indent = static_cast<uint16_t>(lp_ind + 1u);
              brk_sl.orig_line = ci_oline;
              insert_before(ci_pos, brk_sl);
            }
          }
        }
      }
    }
    if (changed) continue;

    // Rule 6 (V5-5): Loop-exit goto -> break; with nested-loop tracking & `else`-skipping across enclosing IF/ELSE.
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
      int32_t cur_d = ld;
      uint32_t nxt = static_cast<uint32_t>(close_idx) + 1u;
      while (nxt < acount && !(stmts[active[nxt]].kind == 1u && depth_arr[nxt] == cur_d)) {
        if (cur_d <= 0) break;
        const uint32_t stepped = step_out_if_else(nxt, cur_d, acount);
        if (stepped == 0u) break;
        --cur_d;
        nxt = stepped;
      }
      if (nxt >= acount || stmts[active[nxt]].kind != 1u || depth_arr[nxt] != cur_d) continue;
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

    // Rule 1 (V5-2): GCC inverted loop: goto L_cond; L_body: <body>; L_cond: <0..12 straight stmts>; if (C) goto L_body;
    // Guarded by has_cross_entry(b, c, acount); supports refs(L_cond) >= 1 when no ref lies inside (b, e].
    for (uint32_t g = 0u; g + 3u < acount && !changed; ++g) {
      const SLine& sg = stmts[active[g]];
      if (sg.kind != 3u) continue;
      const int32_t gd = depth_arr[g];
      const uint32_t b = g + 1u;
      if (depth_arr[b] != gd || stmts[active[b]].kind != 1u) continue;
      const uint64_t l_cond = sg.label_id;
      const uint64_t l_body = stmts[active[b]].label_id;
      if (l_cond == l_body) continue;
      const uint32_t cond_refs = count_refs(l_cond, acount);
      if (cond_refs == 0u || count_refs(l_body, acount) != 1u) continue;

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
      if (has_cross_entry(b, c, acount) || has_bare_loop_ctrl(b + 1u, c, gd)) continue;

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
      if (cond_refs > 1u) {
        bool cond_ref_blocked = false;
        for (uint32_t k = b + 1u; k < acount; ++k) {
          const SLine& sk = stmts[active[k]];
          if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == l_cond) {
            if (k <= e || depth_arr[k] == gd) {
              cond_ref_blocked = true;
              break;
            }
          }
        }
        if (cond_ref_blocked) continue;
      }
      const SLine se_copy = stmts[active[e]];
      const uint16_t base_indent = stmts[active[g]].indent;

      if (c + 1u == e) {
        uint32_t slen = 0u;
        const char* hdr = alloc_synth(work_arena, "    while (", 11u, (se_copy.cond_off == 0xFFFFFFFFu ? se_copy.synth : (tb.data + se_copy.cond_off)), se_copy.cond_len, ") {", 3u, &slen);
        uint32_t clen = 0u;
        const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
        if (hdr && cls) {
          if (cond_refs > 1u) {
            stmts[active[g]] = stmts[active[c]];
            stmts[active[b]].kind = 4u; stmts[active[b]].synth = hdr; stmts[active[b]].synth_len = slen; stmts[active[b]].brace_delta = 1;
            stmts[active[b]].indent = base_indent;
          } else {
            stmts[active[g]].kind = 4u; stmts[active[g]].synth = hdr; stmts[active[g]].synth_len = slen; stmts[active[g]].brace_delta = 1;
            stmts[active[b]].kind = 5u;
          }
          stmts[active[c]].kind = 5u;
          stmts[active[e]].kind = 4u; stmts[active[e]].synth = cls; stmts[active[e]].synth_len = clen; stmts[active[e]].brace_delta = -1;
          for (uint32_t k = b + 1u; k < c; ++k) stmts[active[k]].indent++;
          changed = true;
          any_change = true;
        }
      } else {
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
            if (cond_refs > 1u) {
              stmts[active[g]] = stmts[active[c]];
              stmts[active[b]].kind = 4u; stmts[active[b]].synth = hdr; stmts[active[b]].synth_len = hlen; stmts[active[b]].brace_delta = 1;
              stmts[active[b]].indent = base_indent;
            } else {
              stmts[active[g]].kind = 4u; stmts[active[g]].synth = hdr; stmts[active[g]].synth_len = hlen; stmts[active[g]].brace_delta = 1;
              stmts[active[b]].kind = 5u;
            }
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

    // V4-3 (V5-3c): GCC Pre-Header Alt-Branch Loop Rotation (cap raised 16 -> 64, allows both `if (C) goto` and `goto`):
    for (uint32_t g = 0u; g + 4u < acount && !changed; ++g) {
      const SLine& sg = stmts[active[g]];
      if (sg.kind != 3u) continue;
      const int32_t gd = depth_arr[g];
      const uint32_t alt = g + 1u;
      if (depth_arr[alt] != gd || stmts[active[alt]].kind != 1u) continue;
      const uint64_t l_hdr = sg.label_id;
      const uint64_t l_alt = stmts[active[alt]].label_id;
      if (l_alt == l_hdr || count_refs(l_alt, acount) != 1u) continue;

      int32_t hdr_idx = -1;
      int32_t rel_d = 0;
      for (uint32_t k = alt + 1u; k < acount && k <= alt + 65u; ++k) {
        if (depth_arr[k] < gd) break;
        const SLine& sk = stmts[active[k]];
        if (sk.brace_delta < 0) rel_d += sk.brace_delta;
        if (rel_d < 0) break;
        if (rel_d == 0 && sk.kind == 1u && sk.label_id == l_hdr) {
          hdr_idx = static_cast<int32_t>(k);
          break;
        }
        if (sk.brace_delta > 0) rel_d += sk.brace_delta;
      }
      if (hdr_idx < 0 || rel_d != 0) continue;
      const uint32_t h = static_cast<uint32_t>(hdr_idx);
      const uint32_t alt_cnt = h - (alt + 1u);
      if (alt_cnt == 0u || alt_cnt > 64u) continue;
      if (has_cross_entry(alt, h, acount) || has_bare_loop_ctrl(alt + 1u, h, gd)) continue;

      const uint32_t lp = h + 1u;
      if (lp + 2u >= acount || depth_arr[lp] != gd) continue;
      const SLine& slp = stmts[active[lp]];
      if (slp.kind != 4u || slp.brace_delta != 1 || !slp.synth) continue;
      const bool is_do = starts_with(slp.synth, slp.synth_len, "    do {", 8u);
      const bool is_while1 = starts_with(slp.synth, slp.synth_len, "    while (1) {", 15u);
      if (!is_do && !is_while1) continue;

      int32_t close_idx = -1;
      for (uint32_t k = lp + 1u; k < acount; ++k) {
        if (depth_arr[k] == gd && stmts[active[k]].brace_delta == -1) {
          close_idx = static_cast<int32_t>(k);
          break;
        }
      }
      if (close_idx < 0) continue;
      const uint32_t ci = static_cast<uint32_t>(close_idx);
      const SLine& scls = stmts[active[ci]];
      const char* w_ptr = nullptr;
      uint32_t w_len = 0u;
      bool convert_do_to_while1 = false;
      if (is_do) {
        if (!scls.synth || scls.synth_len <= 15u ||
            !starts_with(scls.synth, scls.synth_len, "    } while (", 13u) ||
            !ends_with(scls.synth, scls.synth_len, ");", 2u)) {
          continue;
        }
        w_ptr = scls.synth + 13u;
        w_len = scls.synth_len - 15u;
        convert_do_to_while1 = !(w_len == 1u && w_ptr[0] == '1');
      }

      // Find the single `if (C) goto L_alt;` or `goto L_alt;` directly inside this loop (loop_depth == 0)
      int32_t j_idx = -1;
      bool has_bare_cont = false;
      int32_t loop_stack[32];
      uint32_t loop_depth = 0u;
      for (uint32_t k = lp + 1u; k < ci; ++k) {
        const SLine& sk = stmts[active[k]];
        if (sk.kind == 4u && sk.brace_delta == 1 && sk.synth &&
            (starts_with(sk.synth, sk.synth_len, "    do {", 8u) ||
             starts_with(sk.synth, sk.synth_len, "    while (", 11u))) {
          if (loop_depth < 32u) loop_stack[loop_depth++] = depth_arr[k];
          else { j_idx = -1; break; }
          continue;
        }
        if (sk.kind == 4u && sk.brace_delta == -1 && loop_depth > 0u &&
            depth_arr[k] == loop_stack[loop_depth - 1u]) {
          --loop_depth;
          continue;
        }
        if (loop_depth > 0u) continue;
        if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == l_alt) {
          j_idx = static_cast<int32_t>(k);
        } else if (convert_do_to_while1 && sk.kind == 4u && sk.synth &&
                   ends_with(sk.synth, sk.synth_len, "continue;", 9u)) {
          has_bare_cont = true;
        }
      }
      if (j_idx < 0 || has_bare_cont) continue;
      if (n + alt_cnt + 4u >= cap) continue;

      const uint32_t ju = static_cast<uint32_t>(j_idx);
      const SLine sj_copy = stmts[active[ju]];
      const uint32_t j_stmt_pos = active[ju];
      const uint32_t lp_stmt_pos = active[lp];
      const uint32_t ci_stmt_pos = active[ci];
      const uint16_t src_base_indent = stmts[active[g]].indent;
      const uint16_t lp_indent = slp.indent;
      const uint32_t ci_orig_line = scls.orig_line;

      SLine alt_buf[64];
      for (uint32_t k = 0u; k < alt_cnt; ++k) alt_buf[k] = stmts[active[alt + 1u + k]];
      const bool need_cont = !is_terminator(alt_buf[alt_cnt - 1u]);

      uint32_t hlen = 0u, clen = 0u, contlen = 0u;
      const char* if_hdr = "";
      const char* if_cls = "";
      if (sj_copy.kind == 2u) {
        const char* cptr = (sj_copy.cond_off == 0xFFFFFFFFu) ? sj_copy.synth : (tb.data + sj_copy.cond_off);
        if_hdr = alloc_synth(work_arena, "    if (", 8u, cptr, sj_copy.cond_len, ") {", 3u, &hlen);
        if_cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
      }
      const char* cont_txt = need_cont ? alloc_synth(work_arena, "    continue;", 13u, "", 0u, "", 0u, &contlen) : "";
      uint32_t w1len = 0u, brklen = 0u, w1clen = 0u;
      const char* w1_hdr = convert_do_to_while1 ? alloc_synth(work_arena, "    while (1) {", 15u, "", 0u, "", 0u, &w1len) : "";
      const char* brk_txt = convert_do_to_while1 ? alloc_neg_cond(work_arena, w_ptr, w_len, "    if (", 8u, ") break;", 8u, &brklen) : "";
      const char* w1_cls = convert_do_to_while1 ? alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &w1clen) : "";

      if (if_hdr && if_cls && cont_txt && w1_hdr && brk_txt && w1_cls) {
        stmts[active[g]].kind = 5u;
        for (uint32_t k = alt; k < h; ++k) stmts[active[k]].kind = 5u;
        if (convert_do_to_while1) {
          stmts[lp_stmt_pos].synth = w1_hdr;
          stmts[lp_stmt_pos].synth_len = w1len;
          stmts[ci_stmt_pos].synth = w1_cls;
          stmts[ci_stmt_pos].synth_len = w1clen;
          SLine brk_sl{};
          brk_sl.kind = 4u; brk_sl.synth = brk_txt; brk_sl.synth_len = brklen; brk_sl.brace_delta = 0;
          brk_sl.indent = static_cast<uint16_t>(lp_indent + 1u);
          brk_sl.orig_line = ci_orig_line;
          insert_before(ci_stmt_pos, brk_sl);  // ci_stmt_pos > j_stmt_pos so j_stmt_pos stays valid
        }
        if (sj_copy.kind == 2u) {
          stmts[j_stmt_pos].kind = 4u;
          stmts[j_stmt_pos].synth = if_hdr;
          stmts[j_stmt_pos].synth_len = hlen;
          stmts[j_stmt_pos].brace_delta = 1;
          uint32_t ins_pos = j_stmt_pos + 1u;
          for (uint32_t k = 0u; k < alt_cnt; ++k) {
            int32_t rel_ind = static_cast<int32_t>(alt_buf[k].indent) - static_cast<int32_t>(src_base_indent);
            if (rel_ind < 0) rel_ind = 0;
            alt_buf[k].indent = static_cast<uint16_t>(sj_copy.indent + 1u + static_cast<uint32_t>(rel_ind));
            insert_before(ins_pos++, alt_buf[k]);
          }
          if (need_cont) {
            SLine cont_sl{};
            cont_sl.kind = 4u; cont_sl.synth = cont_txt; cont_sl.synth_len = contlen; cont_sl.brace_delta = 0;
            cont_sl.indent = static_cast<uint16_t>(sj_copy.indent + 1u);
            cont_sl.orig_line = sj_copy.orig_line;
            insert_before(ins_pos++, cont_sl);
          }
          SLine cls_sl{};
          cls_sl.kind = 4u; cls_sl.synth = if_cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
          cls_sl.indent = sj_copy.indent;
          cls_sl.orig_line = sj_copy.orig_line;
          insert_before(ins_pos, cls_sl);
        } else {
          for (uint32_t k = 0u; k < alt_cnt; ++k) {
            int32_t rel_ind = static_cast<int32_t>(alt_buf[k].indent) - static_cast<int32_t>(src_base_indent);
            if (rel_ind < 0) rel_ind = 0;
            alt_buf[k].indent = static_cast<uint16_t>(sj_copy.indent + static_cast<uint32_t>(rel_ind));
          }
          stmts[j_stmt_pos] = alt_buf[0];
          uint32_t ins_pos = j_stmt_pos + 1u;
          for (uint32_t k = 1u; k < alt_cnt; ++k) {
            insert_before(ins_pos++, alt_buf[k]);
          }
          if (need_cont) {
            SLine cont_sl{};
            cont_sl.kind = 4u; cont_sl.synth = cont_txt; cont_sl.synth_len = contlen; cont_sl.brace_delta = 0;
            cont_sl.indent = sj_copy.indent;
            cont_sl.orig_line = sj_copy.orig_line;
            insert_before(ins_pos++, cont_sl);
          }
        }
        changed = true;
        any_change = true;
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

    // V5-3a: GCC Latch-Before-Header Loop Un-Rotation:
    // Matches `(goto L_hdr; || prev_is_term) L_latch: <LATCH (1..40 balanced stmts)> L_hdr: <BODY>`
    // where <BODY> ends in terminator or `if (C) goto L_latch;`, L_latch has >= 1 back-edge from <BODY>
    // and 0 refs outside (L_latch, end_of_BODY], and no bare loop control would be captured.
    for (uint32_t latch = 1u; latch + 3u < acount && !changed; ++latch) {
      const SLine& slatch = stmts[active[latch]];
      if (slatch.kind != 1u) continue;
      const int32_t gd = depth_arr[latch];
      const uint32_t prev = latch - 1u;
      if (depth_arr[prev] != gd) continue;
      const SLine& sprev = stmts[active[prev]];
      if (!is_terminator(sprev)) continue;
      const bool has_leading_goto_cand = (sprev.kind == 3u);
      const uint64_t l_latch = slatch.label_id;

      // Scan 1..40 balanced statements to find L_hdr at depth gd
      int32_t hdr_idx = -1;
      int32_t rel_d = 0;
      for (uint32_t k = latch + 1u; k < acount && k <= latch + 41u; ++k) {
        if (depth_arr[k] < gd) break;
        const SLine& sk = stmts[active[k]];
        const bool is_eh = is_else_open(k);
        if (sk.brace_delta < 0) rel_d += sk.brace_delta;
        if (rel_d < 0) break;
        if (rel_d == 0 && !is_eh && sk.kind == 1u && sk.label_id != l_latch) {
          if (has_leading_goto_cand) {
            if (sk.label_id == sprev.label_id) {
              hdr_idx = static_cast<int32_t>(k);
              break;
            }
          } else {
            hdr_idx = static_cast<int32_t>(k);
            break;
          }
        }
        if (sk.brace_delta > 0) rel_d += sk.brace_delta;
      }
      if (hdr_idx < 0 || rel_d != 0) continue;
      const uint32_t hdr = static_cast<uint32_t>(hdr_idx);
      const uint32_t latch_cnt = hdr - (latch + 1u);
      if (latch_cnt == 0u || latch_cnt > 40u) continue;
      const uint64_t l_hdr = stmts[active[hdr]].label_id;
      const bool has_leading_goto = has_leading_goto_cand && (sprev.label_id == l_hdr);

      // Scan <BODY> from hdr + 1 until top-level terminator or `if (C) goto L_latch;` at depth gd
      int32_t end_idx = -1;
      int32_t brel_d = 0;
      for (uint32_t k = hdr + 1u; k < acount; ++k) {
        if (depth_arr[k] < gd) break;
        const SLine& sk = stmts[active[k]];
        const bool is_eh = is_else_open(k);
        if (sk.brace_delta < 0) brel_d += sk.brace_delta;
        if (brel_d < 0) break;
        if (brel_d == 0 && !is_eh && sk.brace_delta == 0) {
          if ((sk.kind == 2u && sk.label_id == l_latch) || is_terminator(sk)) {
            end_idx = static_cast<int32_t>(k);
            break;
          }
        }
        if (sk.brace_delta > 0) brel_d += sk.brace_delta;
      }
      if (end_idx < 0 || brel_d != 0) continue;
      const uint32_t bend = static_cast<uint32_t>(end_idx);

      // Verify L_latch has >= 1 ref in (hdr, bend], 0 refs in (latch, hdr), and 0 refs outside [latch, bend]
      uint32_t latch_refs_body = 0u;
      bool latch_ref_bad = false;
      for (uint32_t k = 0u; k < acount; ++k) {
        const SLine& sk = stmts[active[k]];
        if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == l_latch) {
          if (k > hdr && k <= bend) ++latch_refs_body;
          else { latch_ref_bad = true; break; }
        }
      }
      if (latch_refs_body == 0u || latch_ref_bad) continue;

      // Verify no cross-entry into any label in (latch, bend) except hdr
      bool bad_cross = false;
      for (uint32_t m = latch + 1u; m < bend && !bad_cross; ++m) {
        if (m == hdr) continue;
        const SLine& sm = stmts[active[m]];
        if (sm.kind != 1u) continue;
        const uint64_t lid = sm.label_id;
        for (uint32_t k = 0u; k < latch; ++k) {
          const SLine& sk = stmts[active[k]];
          if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == lid) { bad_cross = true; break; }
        }
        for (uint32_t k = bend + 1u; k < acount && !bad_cross; ++k) {
          const SLine& sk = stmts[active[k]];
          if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == lid) { bad_cross = true; break; }
        }
      }
      if (bad_cross) continue;
      if (has_bare_loop_ctrl(latch + 1u, hdr, gd) || has_bare_loop_ctrl(hdr + 1u, bend + 1u, gd)) continue;

      const uint32_t latch_total = hdr - latch;  // L_latch + 1..40 stmts (<= 41)
      if (n + latch_total + 4u >= cap) continue;

      const uint32_t hdr_refs = count_refs(l_hdr, acount);
      const bool keep_hdr_lbl = (hdr_refs > (has_leading_goto ? 1u : 0u));
      const uint16_t base_indent = stmts[active[prev]].indent;
      const SLine sbend_copy = stmts[active[bend]];

      uint32_t hlen = 0u, clen = 0u, brklen = 0u;
      const char* w1_hdr = alloc_synth(work_arena, "    while (1) {", 15u, "", 0u, "", 0u, &hlen);
      const char* w1_cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
      const bool bend_is_if_latch = (sbend_copy.kind == 2u && sbend_copy.label_id == l_latch);
      const bool bend_is_goto_latch = (sbend_copy.kind == 3u && sbend_copy.label_id == l_latch);
      const char* brk_txt = bend_is_if_latch
          ? alloc_neg_cond(work_arena,
                           (sbend_copy.cond_off == 0xFFFFFFFFu ? sbend_copy.synth : (tb.data + sbend_copy.cond_off)),
                           sbend_copy.cond_len, "    if (", 8u, ") break;", 8u, &brklen)
          : "";
      if (w1_hdr && w1_cls && brk_txt) {
        SLine latch_buf[44];
        for (uint32_t k = 0u; k < latch_total; ++k) {
          latch_buf[k] = stmts[active[latch + k]];
          if (k > 0u) {
            int32_t rel_ind = static_cast<int32_t>(latch_buf[k].indent) - static_cast<int32_t>(base_indent);
            if (rel_ind < 0) rel_ind = 0;
            latch_buf[k].indent = static_cast<uint16_t>(base_indent + 1u + static_cast<uint32_t>(rel_ind));
          }
        }
        // 1. Indent body & rewrite body_end
        for (uint32_t k = hdr + 1u; k <= bend; ++k) stmts[active[k]].indent++;
        if (bend_is_if_latch) {
          stmts[active[bend]].kind = 4u;
          stmts[active[bend]].synth = brk_txt;
          stmts[active[bend]].synth_len = brklen;
          stmts[active[bend]].brace_delta = 0;
        } else if (bend_is_goto_latch) {
          stmts[active[bend]].kind = 5u;
        }
        // 2. Insert L_latch + <LATCH> + `}` right after active[bend] (higher index first!)
        uint32_t ins_pos = active[bend] + 1u;
        for (uint32_t k = 0u; k < latch_total; ++k) {
          insert_before(ins_pos++, latch_buf[k]);
        }
        SLine cls_sl{};
        cls_sl.kind = 4u; cls_sl.synth = w1_cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
        cls_sl.indent = base_indent;
        cls_sl.orig_line = sbend_copy.orig_line;
        insert_before(ins_pos, cls_sl);
        // 3. Delete leading goto L_hdr (if present) and original L_latch..<LATCH>
        if (has_leading_goto) stmts[active[prev]].kind = 5u;
        for (uint32_t k = latch; k < hdr; ++k) stmts[active[k]].kind = 5u;
        // 4. Emit `while (1) {` at hdr (keeping L_hdr: above it if externally referenced)
        SLine w1_sl{};
        w1_sl.kind = 4u; w1_sl.synth = w1_hdr; w1_sl.synth_len = hlen; w1_sl.brace_delta = 1;
        w1_sl.indent = base_indent;
        w1_sl.orig_line = stmts[active[hdr]].orig_line;
        if (keep_hdr_lbl) {
          insert_before(active[hdr] + 1u, w1_sl);
        } else {
          stmts[active[hdr]] = w1_sl;
        }
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // V4-1 (V5-5 multi-level `else`-skipping) + V5-6 Twin-`goto` `if-else`:
    // Matches `if (C) { <then>; goto L_join; } <else> (L_join: | enclosing-if-else->L_join: | goto L_join;)`
    // where `if` has no existing `else` and `<else>` is non-empty with balanced braces and no cross-entry.
    {
      int32_t best_vi = -1, best_vc = -1, best_ve = -1;
      uint32_t best_vspan = 0xFFFFFFFFu;
      for (uint32_t i = 0u; i + 4u < acount; ++i) {
        const SLine& si = stmts[active[i]];
        if (si.kind != 4u || si.brace_delta != 1 || !si.synth ||
            !starts_with(si.synth, si.synth_len, "    if (", 8u)) {
          continue;
        }
        const int32_t id = depth_arr[i];
        int32_t close_idx = -1;
        for (uint32_t k = i + 1u; k < acount; ++k) {
          if (depth_arr[k] < id) break;
          if (depth_arr[k] == id) {
            if (is_else_open(k)) break;
            if (is_if_else_close(k)) close_idx = static_cast<int32_t>(k);
            break;
          }
        }
        if (close_idx < 0 || static_cast<uint32_t>(close_idx) <= i + 1u) continue;
        const uint32_t ci = static_cast<uint32_t>(close_idx);
        const uint32_t gi = ci - 1u;
        if (depth_arr[gi] != id + 1 || stmts[active[gi]].kind != 3u) continue;
        const uint64_t l_join = stmts[active[gi]].label_id;
        int32_t e_idx = -1;
        for (uint32_t k = ci + 1u; k < acount; ++k) {
          if (depth_arr[k] < id) {
            // V5-5: Multi-level IF/ELSE exit check (crossing `}` or `} else { ... }`)
            if (depth_arr[k] == id - 1 && id > 0) {
              int32_t cur_d = id;
              uint32_t wk = k;
              uint32_t crossed = 0u;
              while (wk < acount && cur_d > 0) {
                const uint32_t next_wk = step_out_if_else(wk, cur_d, acount);
                if (next_wk == 0u) break;
                --cur_d;
                ++crossed;
                wk = next_wk;
              }
              if (crossed > 0u && wk < acount && stmts[active[wk]].kind == 1u &&
                  depth_arr[wk] == cur_d && stmts[active[wk]].label_id == l_join) {
                e_idx = static_cast<int32_t>(k);
              }
            }
            break;
          }
          if (depth_arr[k] == id) {
            const SLine& sk = stmts[active[k]];
            if (sk.kind == 1u && sk.label_id == l_join) {
              e_idx = static_cast<int32_t>(k);
              break;
            }
            // V5-6: Twin-`goto` `if-else`: `if (A) { <S1>; goto L; } <S2>; goto L;`
            if (sk.kind == 3u && sk.label_id == l_join) {
              e_idx = static_cast<int32_t>(k);
              break;
            }
            if (is_terminator(sk)) break;
          }
        }
        if (e_idx < 0 || static_cast<uint32_t>(e_idx) <= ci + 1u) continue;
        const uint32_t ei = static_cast<uint32_t>(e_idx);
        if (has_cross_entry(ci, ei, acount)) continue;
        if ((ei - i) < best_vspan) {
          best_vspan = ei - i;
          best_vi = static_cast<int32_t>(i);
          best_vc = static_cast<int32_t>(ci);
          best_ve = static_cast<int32_t>(ei);
        }
      }
      if (best_vi >= 0 && n + 2u < cap) {
        const uint32_t i = static_cast<uint32_t>(best_vi);
        const uint32_t ci = static_cast<uint32_t>(best_vc);
        const uint32_t ei = static_cast<uint32_t>(best_ve);
        uint32_t elen = 0u, clen = 0u;
        const char* els = alloc_synth(work_arena, "    } else {", 12u, "", 0u, "", 0u, &elen);
        const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
        if (els && cls) {
          const uint16_t base_ind = stmts[active[i]].indent;
          stmts[active[ci - 1u]].kind = 5u;  // delete tail goto L_join;
          stmts[active[ci]].kind = 4u;
          stmts[active[ci]].synth = els;
          stmts[active[ci]].synth_len = elen;
          stmts[active[ci]].brace_delta = 0;
          stmts[active[ci]].indent = base_ind;
          for (uint32_t k = ci + 1u; k < ei; ++k) stmts[active[k]].indent++;
          SLine cls_sl{};
          cls_sl.kind = 4u; cls_sl.synth = cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
          cls_sl.indent = base_ind;
          cls_sl.orig_line = stmts[active[ei]].orig_line;
          insert_before(active[ei], cls_sl);
          changed = true;
          any_change = true;
        }
      }
    }
    if (changed) continue;

    // Rule 3 (V5-2): Diamond if-else: if (C) goto L1; <then> goto L2; L1: <else> L2: (innermost first)
    // Guarded by has_cross_entry on BOTH branches so shared suffixes are never trapped inside else { ... }.
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
      if (has_cross_entry(i, m - 1u, acount) || has_cross_entry(m, e, acount)) continue;
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

    // V5-2: Small sibling-suffix duplication:
    // `if (A) { ...; if (B) goto L_suf; [<rest>] } else { ...; L_suf: <1..8 straight stmts>; }` (and symmetric case).
    for (uint32_t i = 0u; i + 5u < acount && !changed; ++i) {
      const SLine& si = stmts[active[i]];
      if (si.kind != 4u || si.brace_delta != 1 || !si.synth ||
          !starts_with(si.synth, si.synth_len, "    if (", 8u)) {
        continue;
      }
      const int32_t id = depth_arr[i];
      int32_t else_idx = -1, end_idx = -1;
      for (uint32_t k = i + 1u; k < acount; ++k) {
        if (depth_arr[k] < id) break;
        if (depth_arr[k] == id) {
          if (else_idx < 0 && is_else_open(k)) {
            else_idx = static_cast<int32_t>(k);
          } else if (else_idx >= 0 && is_if_else_close(k)) {
            end_idx = static_cast<int32_t>(k);
            break;
          } else {
            break;
          }
        }
      }
      if (else_idx < 0 || end_idx < 0) continue;
      const uint32_t ei = static_cast<uint32_t>(else_idx);
      const uint32_t ci = static_cast<uint32_t>(end_idx);

      // Try both directions: dir 0 = L_suf in else, jump in then; dir 1 = L_suf in then, jump in else.
      for (uint32_t dir = 0u; dir < 2u && !changed; ++dir) {
        const uint32_t src_b = (dir == 0u) ? (i + 1u) : (ei + 1u);
        const uint32_t src_e = (dir == 0u) ? ei : ci;
        const uint32_t dst_b = (dir == 0u) ? (ei + 1u) : (i + 1u);
        const uint32_t dst_e = (dir == 0u) ? ci : ei;

        // Find a label L_suf at depth id + 1 near the end of dst (1..8 straight stmts before dst_e)
        for (uint32_t ls = (dst_e > dst_b + 8u ? dst_e - 9u : dst_b); ls + 1u < dst_e && !changed; ++ls) {
          if (depth_arr[ls] != id + 1 || stmts[active[ls]].kind != 1u) continue;
          const uint32_t suf_cnt = dst_e - (ls + 1u);
          if (suf_cnt == 0u || suf_cnt > 8u) continue;
          bool suf_ok = true;
          uint32_t suf_bytes = 0u;
          for (uint32_t k = ls + 1u; k < dst_e; ++k) {
            const SLine& sk = stmts[active[k]];
            if (depth_arr[k] != id + 1 || sk.brace_delta != 0 || (sk.kind != 0u && sk.kind != 4u)) {
              suf_ok = false; break;
            }
            if (sk.kind == 4u && sk.synth &&
                (ends_with(sk.synth, sk.synth_len, "break;", 6u) ||
                 ends_with(sk.synth, sk.synth_len, "continue;", 9u) ||
                 is_else_open(k))) {
              suf_ok = false; break;
            }
            const char* sptr = nullptr;
            uint32_t slen = 0u;
            if (!get_stmt_text(sk, &sptr, &slen)) { suf_ok = false; break; }
            suf_bytes += slen;
          }
          if (!suf_ok || r5_total_added + suf_bytes > tb.cap / 4u) continue;
          const uint64_t l_suf = stmts[active[ls]].label_id;

          // Look for a jump to l_suf in src_b..src_e at depth id + 1 (or exiting cleanly to src_e)
          for (uint32_t j = src_b; j < src_e && !changed; ++j) {
            const SLine& sj = stmts[active[j]];
            if ((sj.kind != 2u && sj.kind != 3u) || sj.label_id != l_suf) continue;
            if (depth_arr[j] != id + 1) continue;
            if (j + 1u == src_e) {
              // Tail of sibling branch: replace `goto L_suf;` with <suf>, or `if (B) goto L_suf;` with `if (B) { <suf> }`
              if (n + suf_cnt + 2u >= cap) continue;
              SLine suf_buf[8];
              for (uint32_t k = 0u; k < suf_cnt; ++k) suf_buf[k] = stmts[active[ls + 1u + k]];
              const SLine sj_copy = sj;
              const uint32_t j_pos = active[j];
              if (sj_copy.kind == 3u) {
                for (uint32_t k = 0u; k < suf_cnt; ++k) suf_buf[k].indent = sj_copy.indent;
                stmts[j_pos] = suf_buf[0];
                uint32_t ins_pos = j_pos + 1u;
                for (uint32_t k = 1u; k < suf_cnt; ++k) insert_before(ins_pos++, suf_buf[k]);
                r5_total_added += suf_bytes;
                changed = true; any_change = true;
              } else {
                const char* cptr = (sj_copy.cond_off == 0xFFFFFFFFu) ? sj_copy.synth : (tb.data + sj_copy.cond_off);
                uint32_t hlen = 0u, clen = 0u;
                const char* hdr = alloc_synth(work_arena, "    if (", 8u, cptr, sj_copy.cond_len, ") {", 3u, &hlen);
                const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
                if (hdr && cls) {
                  stmts[j_pos].kind = 4u; stmts[j_pos].synth = hdr; stmts[j_pos].synth_len = hlen; stmts[j_pos].brace_delta = 1;
                  uint32_t ins_pos = j_pos + 1u;
                  for (uint32_t k = 0u; k < suf_cnt; ++k) {
                    suf_buf[k].indent = static_cast<uint16_t>(sj_copy.indent + 1u);
                    insert_before(ins_pos++, suf_buf[k]);
                  }
                  SLine cls_sl{};
                  cls_sl.kind = 4u; cls_sl.synth = cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
                  cls_sl.indent = sj_copy.indent;
                  cls_sl.orig_line = sj_copy.orig_line;
                  insert_before(ins_pos, cls_sl);
                  r5_total_added += suf_bytes;
                  changed = true; any_change = true;
                }
              }
            } else if (sj.kind == 2u && !has_cross_entry(j, src_e, acount)) {
              // Mid-branch `if (B) goto L_suf; <rest>` -> `if (B) { <suf> } else { <rest> }`
              if (n + suf_cnt + 3u >= cap) continue;
              SLine suf_buf[8];
              for (uint32_t k = 0u; k < suf_cnt; ++k) suf_buf[k] = stmts[active[ls + 1u + k]];
              const SLine sj_copy = sj;
              const char* cptr = (sj_copy.cond_off == 0xFFFFFFFFu) ? sj_copy.synth : (tb.data + sj_copy.cond_off);
              uint32_t hlen = 0u, elen = 0u, clen = 0u;
              const char* hdr = alloc_synth(work_arena, "    if (", 8u, cptr, sj_copy.cond_len, ") {", 3u, &hlen);
              const char* els = alloc_synth(work_arena, "    } else {", 12u, "", 0u, "", 0u, &elen);
              const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
              if (hdr && els && cls) {
                const uint32_t j_pos = active[j];
                const uint32_t se_pos = active[src_e];
                for (uint32_t k = j + 1u; k < src_e; ++k) stmts[active[k]].indent++;
                SLine cls_sl{};
                cls_sl.kind = 4u; cls_sl.synth = cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
                cls_sl.indent = sj_copy.indent;
                cls_sl.orig_line = stmts[se_pos].orig_line;
                insert_before(se_pos, cls_sl);  // higher index first
                stmts[j_pos].kind = 4u; stmts[j_pos].synth = hdr; stmts[j_pos].synth_len = hlen; stmts[j_pos].brace_delta = 1;
                uint32_t ins_pos = j_pos + 1u;
                for (uint32_t k = 0u; k < suf_cnt; ++k) {
                  suf_buf[k].indent = static_cast<uint16_t>(sj_copy.indent + 1u);
                  insert_before(ins_pos++, suf_buf[k]);
                }
                SLine els_sl{};
                els_sl.kind = 4u; els_sl.synth = els; els_sl.synth_len = elen; els_sl.brace_delta = 0;
                els_sl.indent = sj_copy.indent;
                els_sl.orig_line = sj_copy.orig_line;
                insert_before(ins_pos, els_sl);
                r5_total_added += suf_bytes;
                changed = true; any_change = true;
              }
            }
          }
        }
      }
    }
    if (changed) continue;

    // V5-4: Post-`if-else` Short-Tail Sinking (`std::function` pattern):
    // Matches `if (C1) { ...; if (C2) goto L_join; <A> } [else { <B> }] <S (1..8 straight stmts)> L_join:`
    // (or symmetric with `if (C2) goto L_join; <A>` in `else`) and sinks `<S>` into both branches.
    for (uint32_t i = 0u; i + 4u < acount && !changed; ++i) {
      const SLine& si = stmts[active[i]];
      if (si.kind != 4u || si.brace_delta != 1 || !si.synth ||
          !starts_with(si.synth, si.synth_len, "    if (", 8u)) {
        continue;
      }
      const int32_t id = depth_arr[i];
      int32_t else_idx = -1, end_idx = -1;
      for (uint32_t k = i + 1u; k < acount; ++k) {
        if (depth_arr[k] < id) break;
        if (depth_arr[k] == id) {
          if (else_idx < 0 && is_else_open(k)) {
            else_idx = static_cast<int32_t>(k);
          } else if (is_if_else_close(k)) {
            end_idx = static_cast<int32_t>(k);
            break;
          } else {
            break;
          }
        }
      }
      if (end_idx < 0) continue;
      const uint32_t if_end = static_cast<uint32_t>(end_idx);
      const bool has_else = (else_idx >= 0);
      const uint32_t then_end = has_else ? static_cast<uint32_t>(else_idx) : if_end;

      // Scan <S> (1..8 straight-line non-terminator stmts at depth id) immediately followed by L_join:
      int32_t join_idx = -1;
      uint32_t s_bytes = 0u;
      for (uint32_t k = if_end + 1u; k < acount && k <= if_end + 9u; ++k) {
        if (depth_arr[k] != id) break;
        const SLine& sk = stmts[active[k]];
        if (sk.kind == 1u) {
          if (k > if_end + 1u) join_idx = static_cast<int32_t>(k);
          break;
        }
        if (sk.kind != 0u || sk.brace_delta != 0 || is_terminator(sk)) break;
        s_bytes += sk.len;
      }
      if (join_idx < 0) continue;
      const uint32_t ji = static_cast<uint32_t>(join_idx);
      const uint32_t s_cnt = ji - (if_end + 1u);
      if (s_cnt == 0u || s_cnt > 8u) continue;
      if (r5_total_added + s_bytes * 2u > tb.cap / 4u) continue;
      if (n + s_cnt * 2u + 5u >= cap) continue;
      const uint64_t l_join = stmts[active[ji]].label_id;

      // Check branch 0 (then) and, if has_else, branch 1 (else) for `if (C2) goto L_join; <A>`
      for (uint32_t br = 0u; br < (has_else ? 2u : 1u) && !changed; ++br) {
        const uint32_t b_start = (br == 0u) ? (i + 1u) : (then_end + 1u);
        const uint32_t b_end = (br == 0u) ? then_end : if_end;
        int32_t j_found = -1;
        for (uint32_t k = b_start; k < b_end; ++k) {
          if (depth_arr[k] == id + 1 && stmts[active[k]].kind == 2u && stmts[active[k]].label_id == l_join) {
            j_found = static_cast<int32_t>(k);
          }
        }
        if (j_found < 0) continue;
        const uint32_t ju = static_cast<uint32_t>(j_found);
        // Verify <A> = (ju + 1 .. b_end - 1) has no labels, gotos, or terminators so every path through <A> reaches <S>
        bool a_ok = !has_cross_entry(ju, b_end, acount);
        for (uint32_t k = ju + 1u; k < b_end && a_ok; ++k) {
          const SLine& sk = stmts[active[k]];
          if (sk.kind == 1u || sk.kind == 2u || sk.kind == 3u || is_terminator(sk)) {
            a_ok = false;
          } else if (sk.kind == 4u && sk.synth &&
                     (ends_with(sk.synth, sk.synth_len, "break;", 6u) ||
                      ends_with(sk.synth, sk.synth_len, "continue;", 9u))) {
            a_ok = false;
          }
        }
        if (!a_ok) continue;

        SLine s_buf[8];
        for (uint32_t k = 0u; k < s_cnt; ++k) s_buf[k] = stmts[active[if_end + 1u + k]];

        const SLine sj_copy = stmts[active[ju]];
        const char* cptr = (sj_copy.cond_off == 0xFFFFFFFFu) ? sj_copy.synth : (tb.data + sj_copy.cond_off);
        uint32_t hlen = 0u, clen = 0u, elen = 0u;
        const char* neg_hdr = alloc_neg_cond(work_arena, cptr, sj_copy.cond_len, "    if (", 8u, ") {", 3u, &hlen);
        const char* cls_txt = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
        const char* els_txt = (!has_else) ? alloc_synth(work_arena, "    } else {", 12u, "", 0u, "", 0u, &elen) : "";
        if (!neg_hdr || !cls_txt || !els_txt) continue;

        const uint16_t base_ind = si.indent;
        // Mark original <S> deleted first
        for (uint32_t k = if_end + 1u; k < ji; ++k) stmts[active[k]].kind = 5u;

        // Perform insertions in strictly descending stmts[] order to preserve earlier active[] indices!
        if (br == 0u) {
          // 1. Higher index: else branch (or add `else { <S> }`) at active[if_end]
          if (!has_else) {
            const uint32_t end_pos = active[if_end];
            stmts[end_pos].synth = els_txt;
            stmts[end_pos].synth_len = elen;
            stmts[end_pos].brace_delta = 0;
            uint32_t ins_pos = end_pos + 1u;
            for (uint32_t k = 0u; k < s_cnt; ++k) {
              SLine sc = s_buf[k];
              sc.indent = static_cast<uint16_t>(base_ind + 1u);
              insert_before(ins_pos++, sc);
            }
            SLine end_cls{};
            end_cls.kind = 4u; end_cls.synth = cls_txt; end_cls.synth_len = clen; end_cls.brace_delta = -1;
            end_cls.indent = base_ind;
            end_cls.orig_line = stmts[end_pos].orig_line;
            insert_before(ins_pos, end_cls);
          } else {
            const bool else_falls = (if_end == then_end + 1u) ||
                                    !(depth_arr[if_end - 1u] == id + 1 && is_terminator(stmts[active[if_end - 1u]]));
            if (else_falls) {
              uint32_t ins_pos = active[if_end];
              for (uint32_t k = 0u; k < s_cnt; ++k) {
                SLine sc = s_buf[k];
                sc.indent = static_cast<uint16_t>(base_ind + 1u);
                insert_before(ins_pos++, sc);
              }
            }
          }
          // 2. Lower index: then branch: wrap <A> + <S> in `if (!(C2)) { <A> <S> }`
          for (uint32_t k = ju + 1u; k < then_end; ++k) stmts[active[k]].indent++;
          uint32_t ins_pos = active[then_end];
          for (uint32_t k = 0u; k < s_cnt; ++k) {
            SLine sc = s_buf[k];
            sc.indent = static_cast<uint16_t>(sj_copy.indent + 1u);
            insert_before(ins_pos++, sc);
          }
          SLine inner_cls{};
          inner_cls.kind = 4u; inner_cls.synth = cls_txt; inner_cls.synth_len = clen; inner_cls.brace_delta = -1;
          inner_cls.indent = sj_copy.indent;
          inner_cls.orig_line = sj_copy.orig_line;
          insert_before(ins_pos, inner_cls);
          stmts[active[ju]].kind = 4u;
          stmts[active[ju]].synth = neg_hdr;
          stmts[active[ju]].synth_len = hlen;
          stmts[active[ju]].brace_delta = 1;
        } else {
          // br == 1u (has_else is true):
          // 1. Higher index: else branch: wrap <A> + <S> in `if (!(C2)) { <A> <S> }`
          for (uint32_t k = ju + 1u; k < if_end; ++k) stmts[active[k]].indent++;
          uint32_t ins_pos = active[if_end];
          for (uint32_t k = 0u; k < s_cnt; ++k) {
            SLine sc = s_buf[k];
            sc.indent = static_cast<uint16_t>(sj_copy.indent + 1u);
            insert_before(ins_pos++, sc);
          }
          SLine inner_cls{};
          inner_cls.kind = 4u; inner_cls.synth = cls_txt; inner_cls.synth_len = clen; inner_cls.brace_delta = -1;
          inner_cls.indent = sj_copy.indent;
          inner_cls.orig_line = sj_copy.orig_line;
          insert_before(ins_pos, inner_cls);
          stmts[active[ju]].kind = 4u;
          stmts[active[ju]].synth = neg_hdr;
          stmts[active[ju]].synth_len = hlen;
          stmts[active[ju]].brace_delta = 1;
          // 2. Lower index: then branch: append <S> before `} else {` if then falls through
          const bool then_falls = (then_end == i + 1u) ||
                                  !(depth_arr[then_end - 1u] == id + 1 && is_terminator(stmts[active[then_end - 1u]]));
          if (then_falls) {
            uint32_t tins = active[then_end];
            for (uint32_t k = 0u; k < s_cnt; ++k) {
              SLine sc = s_buf[k];
              sc.indent = static_cast<uint16_t>(base_ind + 1u);
              insert_before(tins++, sc);
            }
          }
        }
        r5_total_added += s_bytes;
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

    // Rule 4b / 4c (V5-5): Multi-level IF/ELSE block-exit conditional skip with `else`-skipping:
    // Walks up one or more enclosing IF/ELSE closing `}`s or `} else { ... }`s (never LOOP!) to see if `L:` follows.
    for (uint32_t i = 0u; i + 2u < acount && !changed; ++i) {
      const SLine& si = stmts[active[i]];
      if (si.kind != 2u || depth_arr[i] <= 0) continue;
      const int32_t id = depth_arr[i];
      int32_t close_k = -1;
      for (uint32_t k = i + 1u; k < acount; ++k) {
        if (depth_arr[k] == id - 1) {
          if (is_if_else_close(k) || is_else_open(k)) close_k = static_cast<int32_t>(k);
          break;
        }
      }
      if (close_k < 0 || static_cast<uint32_t>(close_k) <= i + 1u) continue;
      const uint32_t ck = static_cast<uint32_t>(close_k);
      if (has_cross_entry(i, ck, acount)) continue;
      int32_t cur_d = id;
      uint32_t lbl_k = ck;
      uint32_t crossed = 0u;
      while (lbl_k < acount && cur_d > 0) {
        const uint32_t next_k = step_out_if_else(lbl_k, cur_d, acount);
        if (next_k == 0u) break;
        --cur_d;
        ++crossed;
        lbl_k = next_k;
      }
      if (crossed > 0u && lbl_k < acount && stmts[active[lbl_k]].kind == 1u && depth_arr[lbl_k] == cur_d &&
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
    if (changed) continue;

    // Rule 5b (V4-2 moved after Rules 2/3/4 + V5-6 YWP safeguard + Small Multi-Ref Cold Tail Duplication):
    // (a) Single-ref (`refs == 1`): 1..32 balanced stmts preceded by a terminator, ending in `goto L_rejoin` / `return` / `__builtin_trap()`.
    //     Rejects `goto L_rejoin`-ended blocks containing external `IF_GOTO`s when inlined into an `if (C)` jump unless `L_rejoin` follows the jump's block.
    // (b) Multi-ref (`2 <= refs <= 6`): 1..6 straight-line stmts (<= 1 internal `if_goto`), preceded by a terminator,
    //     ending in `goto`/`return`/`break`/`continue`/`__builtin_trap()`, bounded by `r5_total_added` byte budget.
    for (uint32_t a = 1u; a + 1u < acount && !changed; ++a) {
      const SLine& sl = stmts[active[a]];
      if (sl.kind != 1u) continue;
      const uint32_t refs = count_refs(sl.label_id, acount);
      if (refs == 0u || refs > 6u) continue;
      const int32_t ld = depth_arr[a];
      if (depth_arr[a - 1u] != ld || !is_terminator(stmts[active[a - 1u]])) continue;

      if (refs == 1u) {
        int32_t end_idx = -1;
        int32_t rel_depth = 0;
        for (uint32_t k = a + 1u; k < acount && k <= a + 32u; ++k) {
          if (depth_arr[k] < ld) break;
          const SLine& sk = stmts[active[k]];
          const bool is_eh = is_else_open(k);
          if (sk.brace_delta < 0) rel_depth += sk.brace_delta;
          if (rel_depth < 0) break;
          if (rel_depth == 0 && !is_eh && sk.brace_delta == 0) {
            if (sk.kind == 3u) {
              if (sk.label_id != sl.label_id && k > a + 1u) {
                end_idx = static_cast<int32_t>(k);
              }
              break;
            }
            if (is_return_stmt(sk) || is_trap_stmt(sk)) {
              end_idx = static_cast<int32_t>(k);
              break;
            }
          }
          if (sk.kind != 0u && sk.kind != 1u && sk.kind != 2u && sk.kind != 4u &&
              !(rel_depth > 0 && sk.kind == 3u)) {
            break;
          }
          if (sk.brace_delta > 0) rel_depth += sk.brace_delta;
        }
        if (end_idx < 0 || rel_depth != 0) continue;
        const uint32_t e = static_cast<uint32_t>(end_idx);
        const uint32_t cnt = e - a;
        if (cnt == 0u || cnt > 32u) continue;
        if (has_cross_entry(a, e, acount) || has_bare_loop_ctrl(a + 1u, e + 1u, ld)) continue;

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
        if (ju >= a && ju <= e) continue;

        // V5-6 YWP safeguard: if ending in `goto L_rejoin;` and jumping from `if (C) goto L_cold;`,
        // reject if block contains any external IF_GOTO unless L_rejoin immediately follows the jump's block.
        if (stmts[active[e]].kind == 3u && stmts[active[ju]].kind == 2u) {
          bool has_ext_if_goto = false;
          for (uint32_t k = a + 1u; k < e; ++k) {
            const SLine& sk = stmts[active[k]];
            if (sk.kind != 2u) continue;
            bool internal_target = false;
            for (uint32_t m = a + 1u; m < e; ++m) {
              if (stmts[active[m]].kind == 1u && stmts[active[m]].label_id == sk.label_id) {
                internal_target = true;
                break;
              }
            }
            if (!internal_target) { has_ext_if_goto = true; break; }
          }
          if (has_ext_if_goto) {
            const uint64_t l_rejoin = stmts[active[e]].label_id;
            bool rejoin_follows = false;
            const int32_t jd = depth_arr[ju];
            for (uint32_t k = ju + 1u; k < acount; ++k) {
              if (depth_arr[k] < jd) break;
              if (depth_arr[k] == jd && stmts[active[k]].kind == 1u && stmts[active[k]].label_id == l_rejoin) {
                rejoin_follows = true;
                break;
              }
            }
            if (!rejoin_follows) continue;
          }
        }

        SLine blk_buf[32];
        for (uint32_t k = 0u; k < cnt; ++k) blk_buf[k] = stmts[active[a + 1u + k]];
        const uint16_t src_base_indent = blk_buf[cnt - 1u].indent;
        const SLine sj_copy = stmts[active[ju]];
        const uint32_t j_stmt_pos = active[ju];

        if (sj_copy.kind == 3u) {
          if (n + cnt < cap) {
            for (uint32_t k = a; k <= e; ++k) stmts[active[k]].kind = 5u;
            for (uint32_t k = 0u; k < cnt; ++k) {
              int32_t rel_ind = static_cast<int32_t>(blk_buf[k].indent) - static_cast<int32_t>(src_base_indent);
              if (rel_ind < 0) rel_ind = 0;
              blk_buf[k].indent = static_cast<uint16_t>(sj_copy.indent + static_cast<uint32_t>(rel_ind));
            }
            stmts[j_stmt_pos] = blk_buf[0];
            uint32_t ins_pos = j_stmt_pos + 1u;
            for (uint32_t k = 1u; k < cnt; ++k) insert_before(ins_pos++, blk_buf[k]);
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
                int32_t rel_ind = static_cast<int32_t>(blk_buf[k].indent) - static_cast<int32_t>(src_base_indent);
                if (rel_ind < 0) rel_ind = 0;
                blk_buf[k].indent = static_cast<uint16_t>(sj_copy.indent + 1u + static_cast<uint32_t>(rel_ind));
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
      } else {
        // V5-6: Small multi-ref cold tail duplication (2 <= refs <= 6, 1..6 straight-line stmts, <= 1 internal if_goto)
        int32_t end_idx = -1;
        uint32_t if_goto_cnt = 0u;
        uint32_t blk_bytes = 0u;
        for (uint32_t k = a + 1u; k < acount && k <= a + 6u; ++k) {
          if (depth_arr[k] != ld) break;
          const SLine& sk = stmts[active[k]];
          if (sk.brace_delta != 0 || sk.kind == 1u || is_else_open(k)) break;
          if (sk.kind == 2u) {
            if (sk.label_id == sl.label_id) break;
            ++if_goto_cnt;
            if (if_goto_cnt > 1u) break;
            blk_bytes += sk.cond_len + 24u;
            continue;
          }
          if (sk.kind == 3u) {
            if (sk.label_id != sl.label_id && k > a + 1u) {
              blk_bytes += 20u;
              end_idx = static_cast<int32_t>(k);
            }
            break;
          }
          const char* sptr = nullptr;
          uint32_t slen = 0u;
          if (!get_stmt_text(sk, &sptr, &slen)) break;
          blk_bytes += slen;
          if (is_terminator(sk)) {
            end_idx = static_cast<int32_t>(k);
            break;
          }
        }
        if (end_idx < 0 || blk_bytes == 0u || blk_bytes > 600u) continue;
        const uint32_t e = static_cast<uint32_t>(end_idx);
        const uint32_t cnt = e - a;
        if (cnt == 0u || cnt > 6u) continue;
        if (r5_total_added + refs * blk_bytes > tb.cap / 4u) continue;
        if (n + refs * (cnt + 2u) >= cap) continue;

        const bool has_loop_ctrl = has_bare_loop_ctrl(a + 1u, e + 1u, ld);
        const int32_t src_loop = has_loop_ctrl ? enclosing_loop_idx(a) : -1;

        uint32_t j_list[6];
        uint32_t j_cnt = 0u;
        bool j_ok = true;
        for (uint32_t k = 0u; k < acount; ++k) {
          const SLine& sk = stmts[active[k]];
          if ((sk.kind == 2u || sk.kind == 3u) && sk.label_id == sl.label_id) {
            if (k >= a && k <= e) { j_ok = false; break; }
            if (has_loop_ctrl && enclosing_loop_idx(k) != src_loop) { j_ok = false; break; }
            if (j_cnt < 6u) j_list[j_cnt++] = k;
            else { j_ok = false; break; }
          }
        }
        if (!j_ok || j_cnt != refs) continue;

        SLine blk_buf[6];
        for (uint32_t k = 0u; k < cnt; ++k) blk_buf[k] = stmts[active[a + 1u + k]];

        // Pre-allocate any needed `if (...) {` / `}` headers before mutating
        const char* hdrs[6];
        uint32_t hlens[6];
        uint32_t clen = 0u;
        const char* cls = alloc_synth(work_arena, "    }", 5u, "", 0u, "", 0u, &clen);
        if (!cls) continue;
        bool alloc_ok = true;
        for (uint32_t r = 0u; r < j_cnt; ++r) {
          const SLine& sj = stmts[active[j_list[r]]];
          if (sj.kind == 2u) {
            const char* cptr = (sj.cond_off == 0xFFFFFFFFu) ? sj.synth : (tb.data + sj.cond_off);
            hdrs[r] = alloc_synth(work_arena, "    if (", 8u, cptr, sj.cond_len, ") {", 3u, &hlens[r]);
            if (!hdrs[r]) { alloc_ok = false; break; }
          } else {
            hdrs[r] = nullptr;
            hlens[r] = 0u;
          }
        }
        if (!alloc_ok) continue;

        // Mark cold tail deleted before inserting at jump sites in descending active[] order
        for (uint32_t k = a; k <= e; ++k) stmts[active[k]].kind = 5u;
        for (int32_t r = static_cast<int32_t>(j_cnt) - 1; r >= 0; --r) {
          const uint32_t ju = j_list[r];
          const SLine sj_copy = stmts[active[ju]];
          const uint32_t j_pos = active[ju];
          if (sj_copy.kind == 3u) {
            SLine first = blk_buf[0];
            first.indent = sj_copy.indent;
            stmts[j_pos] = first;
            uint32_t ins_pos = j_pos + 1u;
            for (uint32_t k = 1u; k < cnt; ++k) {
              SLine item = blk_buf[k];
              item.indent = sj_copy.indent;
              insert_before(ins_pos++, item);
            }
          } else {
            stmts[j_pos].kind = 4u;
            stmts[j_pos].synth = hdrs[r];
            stmts[j_pos].synth_len = hlens[r];
            stmts[j_pos].brace_delta = 1;
            uint32_t ins_pos = j_pos + 1u;
            for (uint32_t k = 0u; k < cnt; ++k) {
              SLine item = blk_buf[k];
              item.indent = static_cast<uint16_t>(sj_copy.indent + 1u);
              insert_before(ins_pos++, item);
            }
            SLine cls_sl{};
            cls_sl.kind = 4u; cls_sl.synth = cls; cls_sl.synth_len = clen; cls_sl.brace_delta = -1;
            cls_sl.indent = sj_copy.indent;
            cls_sl.orig_line = sj_copy.orig_line;
            insert_before(ins_pos, cls_sl);
          }
        }
        r5_total_added += refs * blk_bytes;
        changed = true;
        any_change = true;
      }
    }
    if (changed) continue;

    // V5-1: Post-Rule-4c Rule 5 fallback sweep (without the refs==1 && !prev_term skip)
    if (try_rule5(true)) { changed = true; continue; }

    if (!changed) break;
  }

  // Wave 31: Hybrid 2-Mode State-Machine Residual Goto Eliminator (100% zero-goto guarantee).
  {
    uint32_t acount = 0u;
    int32_t d = 0;
    for (uint32_t i = 0u; i < n; ++i) {
      if (stmts[i].kind == 5u) continue;
      const bool is_else_hdr = (stmts[i].kind == 4u && stmts[i].brace_delta == 0 && stmts[i].synth &&
                                starts_with(stmts[i].synth, stmts[i].synth_len, "    } else {", 12u));
      if (stmts[i].brace_delta < 0) d += stmts[i].brace_delta;
      active[acount] = i;
      depth_arr[acount] = is_else_hdr ? (d - 1) : d;
      if (stmts[i].brace_delta > 0) d += stmts[i].brace_delta;
      ++acount;
    }

    uint32_t residual_gotos = 0u;
    bool has_synth_goto = false;
    for (uint32_t a = 0u; a < acount; ++a) {
      const SLine& sl = stmts[active[a]];
      if (sl.kind == 2u || sl.kind == 3u) {
        ++residual_gotos;
      } else if (sl.kind == 4u && sl.synth && sl.synth_len >= 5u) {
        for (uint32_t c = 0u; c + 5u <= sl.synth_len; ++c) {
          if (sl.synth[c] == 'g' && sl.synth[c + 1u] == 'o' && sl.synth[c + 2u] == 't' &&
              sl.synth[c + 3u] == 'o' && sl.synth[c + 4u] == ' ') {
            has_synth_goto = true;
            break;
          }
        }
      }
    }

    if (residual_gotos > 0u || has_synth_goto) {
      // Check Mode 1 eligibility (Hybrid Structured-Region State Machine).
      bool mode1_ok = (!has_synth_goto && d == 0);
      if (mode1_ok) {
        int32_t loop_stack[64];
        uint32_t loop_depth = 0u;
        for (uint32_t a = 0u; a < acount; ++a) {
          const SLine& sl = stmts[active[a]];
          if (sl.kind == 4u && sl.brace_delta > 0 && sl.synth &&
              (starts_with(sl.synth, sl.synth_len, "    do {", 8u) ||
               starts_with(sl.synth, sl.synth_len, "    while (", 11u) ||
               starts_with(sl.synth, sl.synth_len, "    switch (", 12u))) {
            if (loop_depth < 64u) loop_stack[loop_depth++] = depth_arr[a];
            else { mode1_ok = false; break; }
          } else if (sl.kind == 4u && sl.brace_delta < 0 && loop_depth > 0u &&
                     depth_arr[a] == loop_stack[loop_depth - 1u]) {
            --loop_depth;
          }
          if (sl.kind == 1u && depth_arr[a] != 0) {
            mode1_ok = false;
            break;
          }
          if ((sl.kind == 2u || sl.kind == 3u) && loop_depth > 0u) {
            mode1_ok = false;
            break;
          }
          if (loop_depth == 0u && sl.kind == 4u && sl.synth &&
              (ends_with(sl.synth, sl.synth_len, "break;", 6u) ||
               ends_with(sl.synth, sl.synth_len, "continue;", 9u))) {
            mode1_ok = false;
            break;
          }
        }
        if (loop_depth != 0u) mode1_ok = false;
      }

      if (mode1_ok) {
        build_ref_ht(acount);
        uint32_t st_cap = ht_cap;
        uint64_t* st_keys = work_arena.alloc<uint64_t>(st_cap);
        uint32_t* st_vals = work_arena.alloc<uint32_t>(st_cap);
        uint8_t* st_used = work_arena.alloc<uint8_t>(st_cap);
        if (!st_keys || !st_vals || !st_used) {
          mode1_ok = false;
        } else {
          __builtin_memset(st_used, 0, st_cap);
          const uint32_t st_mask = st_cap - 1u;
          auto st_find = [&](uint64_t key) -> int64_t {
            uint32_t idx = static_cast<uint32_t>((key * 0x9E3779B97F4A7C15ULL) >> 32u) & st_mask;
            for (uint32_t probe = 0u; probe < st_cap; ++probe) {
              if (st_used[idx] == 0u) return -1;
              if (st_keys[idx] == key) return static_cast<int64_t>(st_vals[idx]);
              idx = (idx + 1u) & st_mask;
            }
            return -1;
          };
          auto st_insert = [&](uint64_t key, uint32_t val) -> bool {
            uint32_t idx = static_cast<uint32_t>((key * 0x9E3779B97F4A7C15ULL) >> 32u) & st_mask;
            for (uint32_t probe = 0u; probe < st_cap; ++probe) {
              if (st_used[idx] == 0u) {
                st_used[idx] = 1u;
                st_keys[idx] = key;
                st_vals[idx] = val;
                return true;
              }
              if (st_keys[idx] == key) return true;
              idx = (idx + 1u) & st_mask;
            }
            return false;
          };

          uint32_t first_non_skip = acount;
          for (uint32_t a = 0u; a < acount; ++a) {
            const SLine& sl = stmts[active[a]];
            if (sl.kind == 1u && count_refs(sl.label_id, acount) == 0u) continue;
            first_non_skip = a;
            break;
          }
          uint32_t next_sid = (first_non_skip < acount && stmts[active[first_non_skip]].kind == 1u) ? 0u : 1u;
          for (uint32_t a = 0u; a < acount && mode1_ok; ++a) {
            const SLine& sl = stmts[active[a]];
            if (sl.kind == 1u && count_refs(sl.label_id, acount) > 0u) {
              if (st_find(sl.label_id) < 0) {
                if (!st_insert(sl.label_id, next_sid++)) mode1_ok = false;
              }
            }
          }
          // Verify every active goto target resolves to a valid state_id.
          for (uint32_t a = 0u; a < acount && mode1_ok; ++a) {
            const SLine& sl = stmts[active[a]];
            if ((sl.kind == 2u || sl.kind == 3u) && st_find(sl.label_id) < 0) {
              mode1_ok = false;
            }
          }

          if (mode1_ok) {
            const uint32_t max_orig = body_start_line + raw_lines + 4u;
            uint32_t* line_remap = work_arena.alloc<uint32_t>(max_orig + 1u);
            if (!line_remap && &work_arena != &emit_arena) {
              line_remap = emit_arena.alloc<uint32_t>(max_orig + 1u);
            }
            if (line_remap) {
              auto serialize_mode1 = [&](char* dst, uint32_t dst_cap, uint32_t* out_wp, uint32_t* out_line_final) -> bool {
                for (uint32_t i = 0u; i <= max_orig; ++i) line_remap[i] = 0u;
                uint32_t wp = 0u;
                bool overflow = false;
                auto put_ch = [&](char ch) {
                  if (wp + 1u < dst_cap) dst[wp++] = ch;
                  else overflow = true;
                };
                auto put_mem = [&](const char* s, uint32_t l) {
                  if (wp + l < dst_cap) {
                    hex::mem_copy(dst + wp, s, l);
                    wp += l;
                  } else {
                    overflow = true;
                  }
                };
                auto put_u32 = [&](uint32_t v) {
                  char dbuf[12];
                  uint32_t dn = 0u;
                  if (v == 0u) dbuf[dn++] = '0';
                  else {
                    char tmp[12];
                    uint32_t tn = 0u;
                    while (v > 0u) {
                      tmp[tn++] = static_cast<char>('0' + (v % 10u));
                      v /= 10u;
                    }
                    while (tn > 0u) dbuf[dn++] = tmp[--tn];
                  }
                  put_mem(dbuf, dn);
                };

                auto put_hex = [&](uint64_t v) {
                  static constexpr char kHex[] = "0123456789ABCDEF";
                  char hbuf[18];
                  uint32_t hn = 0u;
                  if (v == 0ULL) hbuf[hn++] = '0';
                  else {
                    char tmp[18];
                    uint32_t tn = 0u;
                    while (v > 0ULL) {
                      tmp[tn++] = kHex[v & 0xFu];
                      v >>= 4u;
                    }
                    while (tn > 0u) hbuf[hn++] = tmp[--tn];
                  }
                  put_mem(hbuf, hn);
                };

                put_mem(tb.data, body_start_off);
                for (uint32_t l = 1u; l < body_start_line && l <= max_orig; ++l) line_remap[l] = l;

                uint32_t out_line = body_start_line;
                put_mem("    unsigned int __hex_state = 0u;\n", 35u);
                put_mem("    while (__hex_state != 0xFFFFFFFFu) {\n", 41u);
                put_mem("        switch (__hex_state) {\n", 31u);
                put_mem("        case 0u: /* entry 0x", 28u);
                put_hex(base_addr);
                put_mem(" */\n", 4u);
                out_line += 4u;

                bool in_case = true;
                bool case_has_stmt = false;
                bool last_d0_was_term = false;
                bool first_seen = false;

                for (uint32_t a = 0u; a < acount && !overflow; ++a) {
                  const SLine& sl = stmts[active[a]];
                  if (sl.kind == 1u) {
                    const int64_t sid = st_find(sl.label_id);
                    if (sid < 0) continue;  // unreferenced label
                    if (!first_seen && sid == 0) {
                      first_seen = true;
                      if (sl.orig_line <= max_orig && line_remap[sl.orig_line] == 0u) {
                        line_remap[sl.orig_line] = (out_line > 1u) ? (out_line - 1u) : 1u;
                      }
                      continue;
                    }
                    first_seen = true;
                    if (in_case && (!case_has_stmt || !last_d0_was_term)) {
                      put_mem("            __hex_state = ", 26u);
                      put_u32(static_cast<uint32_t>(sid));
                      put_mem("u; break;\n", 10u);
                      ++out_line;
                    }
                    if (sl.orig_line <= max_orig && line_remap[sl.orig_line] == 0u) {
                      line_remap[sl.orig_line] = out_line;
                    }
                    put_mem("        case ", 13u);
                    put_u32(static_cast<uint32_t>(sid));
                    put_mem("u: /* block 0x", 14u);
                    put_hex(sl.label_id);
                    put_mem(" */\n", 4u);
                    ++out_line;
                    in_case = true;
                    case_has_stmt = false;
                    last_d0_was_term = false;
                    continue;
                  }

                  first_seen = true;
                  if (sl.orig_line <= max_orig && line_remap[sl.orig_line] == 0u) {
                    line_remap[sl.orig_line] = out_line;
                  }
                  for (uint16_t sp = 0u; sp < sl.indent + 2u; ++sp) put_mem("    ", 4u);
                  if (sl.kind == 3u) {
                    const uint32_t sid = static_cast<uint32_t>(st_find(sl.label_id));
                    put_mem("    __hex_state = ", 18u);
                    put_u32(sid);
                    put_mem("u; break;", 9u);
                  } else if (sl.kind == 2u) {
                    const uint32_t sid = static_cast<uint32_t>(st_find(sl.label_id));
                    const char* cptr = (sl.cond_off == 0xFFFFFFFFu && sl.synth) ? sl.synth : (tb.data + sl.cond_off);
                    put_mem("    if (", 8u);
                    put_mem(cptr, sl.cond_len);
                    put_mem(") { __hex_state = ", 18u);
                    put_u32(sid);
                    put_mem("u; break; }", 11u);
                  } else if (sl.kind == 4u) {
                    put_mem(sl.synth, sl.synth_len);
                  } else {
                    put_mem(tb.data + sl.off, sl.len);
                  }
                  put_ch('\n');
                  ++out_line;
                  case_has_stmt = true;
                  if (depth_arr[a] == 0) {
                    last_d0_was_term = (sl.kind == 3u) || is_return_stmt(sl) || is_trap_stmt(sl);
                  }
                }

                if (in_case && (!case_has_stmt || !last_d0_was_term)) {
                  put_mem("            __hex_state = 0xFFFFFFFFu; break;\n", 46u);
                  ++out_line;
                }
                put_mem("        default:\n", 17u);
                put_mem("            __hex_state = 0xFFFFFFFFu;\n", 39u);
                put_mem("            break;\n", 19u);
                put_mem("        }\n", 10u);
                put_mem("    }\n", 6u);
                out_line += 5u;
                if (fallback_ret) {
                  uint32_t flen = 0u;
                  while (fallback_ret[flen] != '\0') ++flen;
                  put_mem(fallback_ret, flen);
                  ++out_line;
                }
                if (overflow || wp + 4u >= dst_cap) return false;
                dst[wp] = '\0';
                *out_wp = wp;
                *out_line_final = out_line;
                return true;
              };

              const size_t out_mark = work_arena.used();
              const uint32_t est_cap = tb.len + (acount * 32u) + 32768u;
              uint32_t new_cap = (est_cap < tb.cap) ? est_cap : tb.cap;
              char* out_mem = work_arena.alloc<char>(new_cap);
              bool copy_back = true;
              uint32_t wp = 0u;
              uint32_t out_line = body_start_line;
              bool ok = (out_mem != nullptr) && serialize_mode1(out_mem, new_cap, &wp, &out_line);
              if (!ok) {
                work_arena.restore(out_mark);
                const uint32_t big_cap = (est_cap > tb.cap) ? est_cap : (tb.len * 2u + 32768u);
                out_mem = emit_arena.alloc<char>(big_cap);
                copy_back = false;
                if (out_mem) {
                  new_cap = big_cap;
                  ok = serialize_mode1(out_mem, new_cap, &wp, &out_line);
                }
              }
              if (ok) {
                uint32_t last_valid = (out_line > 1u) ? (out_line - 1u) : 1u;
                for (int32_t l = static_cast<int32_t>(max_orig); l >= 1; --l) {
                  if (line_remap[l] != 0u) last_valid = line_remap[l];
                  else line_remap[l] = last_valid;
                }
                for (uint32_t k = 0u; k < tb.lm_count; ++k) {
                  const uint32_t ol = tb.lm[k].line_no;
                  if (ol >= 1u && ol <= max_orig) tb.lm[k].line_no = line_remap[ol];
                }
                if (copy_back) {
                  hex::mem_copy(tb.data, out_mem, wp + 1u);
                } else {
                  tb.data = out_mem;
                  tb.cap = new_cap;
                }
                tb.len = wp;
                tb.line_no = out_line;
                (void)body_len;
                return true;
              }
            }
          }
        }
      }

      // Mode 2 fallback: Flat-CFG State Machine from pristine tb.data[body_start_off..tb.len].
      work_arena.restore(struct_mark);
      return emit_flat_state_machine(tb, body_start_off, body_start_line, raw_lines, base_addr, fallback_ret, work_arena, emit_arena);
    }
  }

  if (!any_change) return false;

  // V4-0: Serialize into work_arena and copy back into tb.data so giant functions consume 0 extra emit_arena.
  const uint32_t est_cap = tb.len + (tb.len / 2u) + 16384u;
  const uint32_t new_cap = (est_cap < tb.cap) ? est_cap : tb.cap;
  char* out_mem = work_arena.alloc<char>(new_cap);
  bool copy_back = true;
  if (!out_mem && &work_arena != &emit_arena) {
    out_mem = emit_arena.alloc<char>(new_cap);
    copy_back = false;
  }
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

  if (copy_back) {
    hex::mem_copy(tb.data, out_mem, wp + 1u);
  } else {
    tb.data = out_mem;
    tb.cap = new_cap;
  }
  tb.len = wp;
  tb.line_no = out_line;
  (void)body_len;
  return true;
}

static uint32_t scan_arm64_jumptables(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    uint8_t* is_label,
    uint8_t* has_back_edge,
    hex::Arena& work_arena,
    JumpTableInfo* out_jts,
    uint32_t max_jts) {
  uint32_t jt_count = 0u;
  constexpr uint32_t kMaxLookback = 32u;
  constexpr uint32_t kMaxCmpLookback = 4u;

  for (uint32_t i = 0u; i < word_count && jt_count < max_jts; ++i) {
    const uint32_t w = words[i];
    if (!((w & 0xFFFFFC1Fu) == 0xD61F0000u || (w & 0xFFFFF81Fu) == 0xD61F081Fu || (w & 0xFFFFF800u) == 0xD71F0800u)) {
      continue;
    }
    const uint8_t br_reg = static_cast<uint8_t>((w >> 5u) & 31u);
    const uint64_t br_pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    JumpTableInfo& jt = out_jts[jt_count++];
    jt = JumpTableInfo{};
    jt.br_idx = i;
    jt.load_idx = 0xFFFFFFFFu;
    jt.br_reg = br_reg;
    jt.index_reg = 0xFFu;
    if (br_reg == 30u || br_reg == 31u) continue;

    bool has_rel_add = false;
    uint32_t add_idx = 0xFFFFFFFFu;
    uint8_t add_rn = 0xFFu;
    uint8_t add_rm = 0xFFu;
    uint32_t add_shift = 0u;
    bool add_is_ext = false;
    uint32_t add_option = 0u;

    bool has_load = false;
    uint32_t load_idx = 0xFFFFFFFFu;
    uint8_t load_rt = 0xFFu;
    uint8_t table_reg = 0xFFu;
    uint8_t index_reg = 0xFFu;
    bool index_is32 = false;
    uint8_t elem_width = 0u;
    bool elem_signed = false;
    uint8_t base_reg = 0xFFu;

    bool has_tbl_pending_add = false;
    uint64_t tbl_pending_imm = 0ULL;
    uint8_t tbl_adrp_reg = 0xFFu;
    bool has_table_va = false;
    uint64_t table_va = 0ULL;

    bool has_base_pending_add = false;
    uint64_t base_pending_imm = 0ULL;
    uint8_t base_adrp_reg = 0xFFu;
    bool has_base_va = false;
    uint64_t base_va = 0ULL;

    bool has_bounds = false;
    uint32_t entry_count = 0u;
    bool has_default = false;
    uint64_t default_target = 0ULL;
    bool crossed_ret = false;
    uint64_t ret_pc = 0ULL;

    for (uint32_t step = 1u; step <= kMaxLookback && step <= i; ++step) {
      const uint32_t idx = i - step;
      const uint32_t iw = words[idx];
      const uint64_t ipc = base_addr + static_cast<uint64_t>(idx) * 4ULL;
      if ((iw & 0xFFFFFC1Fu) == 0xD65F0000u || iw == 0xD65F0BFFu || iw == 0xD65F0FFFu) {
        if (crossed_ret || (!has_load && !has_rel_add)) break;
        crossed_ret = true;
        ret_pc = ipc;
        continue;
      }

      if (!crossed_ret) {
        // 1. Relative target ADD: add xTgt, xBase, xOff[, lsl/sxtw]
        if (!has_load && !has_rel_add) {
          if ((iw & 0x1F200000u) == 0x0B000000u && ((iw >> 30u) & 1u) == 0u &&
              ((iw >> 22u) & 3u) == 0u && (iw & 31u) == br_reg) {
            has_rel_add = true;
            add_idx = idx;
            add_rn = static_cast<uint8_t>((iw >> 5u) & 31u);
            add_rm = static_cast<uint8_t>((iw >> 16u) & 31u);
            add_shift = (iw >> 10u) & 0x3Fu;
            add_is_ext = false;
            add_option = 0u;
            base_reg = add_rn;
            base_adrp_reg = base_reg;
            continue;
          }
          if ((iw & 0x1FE00000u) == 0x0B200000u && ((iw >> 30u) & 1u) == 0u && (iw & 31u) == br_reg) {
            has_rel_add = true;
            add_idx = idx;
            add_rn = static_cast<uint8_t>((iw >> 5u) & 31u);
            add_rm = static_cast<uint8_t>((iw >> 16u) & 31u);
            add_shift = (iw >> 10u) & 7u;
            add_is_ext = true;
            add_option = (iw >> 13u) & 7u;
            base_reg = add_rn;
            base_adrp_reg = base_reg;
            continue;
          }
        }

        // 2. Indexed table load: ldr/ldrsw/ldrh/ldrsh/ldrb/ldrsb Rt, [Rn, Rm, ...]
        if (!has_load && (iw & 0x3B200C00u) == 0x38200800u && ((iw >> 26u) & 1u) == 0u) {
          const uint32_t size_f = (iw >> 30u) & 3u;
          const uint32_t opc = (iw >> 22u) & 3u;
          if (opc != 0u && !(size_f == 3u && opc == 2u)) {
            const uint8_t rt = static_cast<uint8_t>(iw & 31u);
            const bool rt_match = (rt == br_reg) || (has_rel_add && (rt == add_rn || rt == add_rm));
            if (rt_match) {
              has_load = true;
              load_idx = idx;
              load_rt = rt;
              table_reg = static_cast<uint8_t>((iw >> 5u) & 31u);
              index_reg = static_cast<uint8_t>((iw >> 16u) & 31u);
              const uint32_t opt = (iw >> 13u) & 7u;
              if (opt == 2u || opt == 6u) index_is32 = true;
              elem_width = static_cast<uint8_t>(1u << size_f);
              elem_signed = (opc >= 2u);
              tbl_adrp_reg = table_reg;
              if (has_rel_add) {
                base_reg = (rt == add_rn) ? add_rm : add_rn;
                base_adrp_reg = base_reg;
              }
              continue;
            }
          }
        }

        // 3a. Resolve table_va via (adrp + add_imm) or adrp or adr
        bool matched_addr = false;
        if (has_load && !has_table_va && tbl_adrp_reg < 31u) {
          if (!has_tbl_pending_add && (iw & 0x1F800000u) == 0x11000000u &&
              ((iw >> 30u) & 1u) == 0u && ((iw >> 29u) & 1u) == 0u && (iw & 31u) == tbl_adrp_reg) {
            const uint32_t sh = (iw >> 22u) & 1u;
            tbl_pending_imm = static_cast<uint64_t>((iw >> 10u) & 0xFFFu) << (sh ? 12u : 0u);
            has_tbl_pending_add = true;
            tbl_adrp_reg = static_cast<uint8_t>((iw >> 5u) & 31u);
            matched_addr = true;
          } else if ((iw & 0x9F000000u) == 0x90000000u && (iw & 31u) == tbl_adrp_reg) {
            const uint64_t immhi = static_cast<uint64_t>((iw >> 5u) & 0x7FFFFu);
            const uint64_t immlo = static_cast<uint64_t>((iw >> 29u) & 3u);
            const int64_t delta = sign_extend((immhi << 2u) | immlo, 21u) << 12u;
            table_va = (ipc & ~0xFFFULL) + static_cast<uint64_t>(delta) + (has_tbl_pending_add ? tbl_pending_imm : 0ULL);
            has_table_va = true;
            matched_addr = true;
          } else if ((iw & 0x9F000000u) == 0x10000000u && (iw & 31u) == tbl_adrp_reg) {
            const uint64_t immhi = static_cast<uint64_t>((iw >> 5u) & 0x7FFFFu);
            const uint64_t immlo = static_cast<uint64_t>((iw >> 29u) & 3u);
            const int64_t delta = sign_extend((immhi << 2u) | immlo, 21u);
            table_va = ipc + static_cast<uint64_t>(delta) + (has_tbl_pending_add ? tbl_pending_imm : 0ULL);
            has_table_va = true;
            matched_addr = true;
          }
        }

        // 3b. Resolve base_va via (adrp + add_imm) or adrp or adr
        if (has_rel_add && !has_base_va && base_adrp_reg < 31u) {
          if (has_load && has_table_va && base_reg == table_reg) {
            base_va = table_va;
            has_base_va = true;
          } else if (!has_base_pending_add && (iw & 0x1F800000u) == 0x11000000u &&
                     ((iw >> 30u) & 1u) == 0u && ((iw >> 29u) & 1u) == 0u && (iw & 31u) == base_adrp_reg) {
            const uint32_t sh = (iw >> 22u) & 1u;
            base_pending_imm = static_cast<uint64_t>((iw >> 10u) & 0xFFFu) << (sh ? 12u : 0u);
            has_base_pending_add = true;
            base_adrp_reg = static_cast<uint8_t>((iw >> 5u) & 31u);
            matched_addr = true;
          } else if ((iw & 0x9F000000u) == 0x90000000u && (iw & 31u) == base_adrp_reg) {
            const uint64_t immhi = static_cast<uint64_t>((iw >> 5u) & 0x7FFFFu);
            const uint64_t immlo = static_cast<uint64_t>((iw >> 29u) & 3u);
            const int64_t delta = sign_extend((immhi << 2u) | immlo, 21u) << 12u;
            base_va = (ipc & ~0xFFFULL) + static_cast<uint64_t>(delta) + (has_base_pending_add ? base_pending_imm : 0ULL);
            has_base_va = true;
            matched_addr = true;
          } else if ((iw & 0x9F000000u) == 0x10000000u && (iw & 31u) == base_adrp_reg) {
            const uint64_t immhi = static_cast<uint64_t>((iw >> 5u) & 0x7FFFFu);
            const uint64_t immlo = static_cast<uint64_t>((iw >> 29u) & 3u);
            const int64_t delta = sign_extend((immhi << 2u) | immlo, 21u);
            base_va = ipc + static_cast<uint64_t>(delta) + (has_base_pending_add ? base_pending_imm : 0ULL);
            has_base_va = true;
            matched_addr = true;
          }
        }
        if (matched_addr) continue;
      }

      // 4. Bounds check:
      //    (a) cmp w/xIdx, #imm; b.hi/b.hs default (forward bounds check)
      //    (b) cmp w/xIdx, #imm; b.ls/b.lo table_block (inverted bounds check, fallthrough is default/early-ret)
      if (!has_bounds && (iw & 0xFF000010u) == 0x54000000u) {
        const uint32_t cond = iw & 0xFu;
        const bool is_hi_hs = (!crossed_ret && (cond == 0x8u || cond == 0x2u));
        const bool is_ls_lo = (cond == 0x9u || cond == 0x3u);
        if (is_hi_hs || is_ls_lo) {
          const int64_t bdelta = sign_extend((iw >> 5u) & 0x7FFFFu, 19u) * 4LL;
          const uint64_t btgt = ipc + static_cast<uint64_t>(bdelta);
          bool valid_branch = true;
          if (is_ls_lo) {
            valid_branch = (btgt > ipc && btgt <= br_pc && (!crossed_ret || btgt > ret_pc));
          }
          if (valid_branch) {
            const bool is_inclusive = (cond == 0x8u || cond == 0x9u);
            const uint64_t def_tgt = is_ls_lo ? (ipc + 4ULL) : btgt;
            for (uint32_t k = 1u; k <= kMaxCmpLookback && k <= idx; ++k) {
              const uint32_t cw = words[idx - k];
              if ((cw & 0xFFFFFC1Fu) == 0xD65F0000u) break;
              if ((cw & 0x1F800000u) == 0x11000000u && ((cw >> 29u) & 3u) == 3u && (cw & 31u) == 31u) {
                const uint8_t cmp_rn = static_cast<uint8_t>((cw >> 5u) & 31u);
                const uint32_t sh = (cw >> 22u) & 1u;
                const uint32_t imm = ((cw >> 10u) & 0xFFFu) << (sh ? 12u : 0u);
                if (!has_load || cmp_rn == index_reg) {
                  const uint32_t ec = is_inclusive ? (imm + 1u) : imm;
                  if (ec >= 2u && ec <= kMaxJumpTableCases) {
                    has_bounds = true;
                    entry_count = ec;
                    has_default = true;
                    default_target = def_tgt;
                    if (index_reg == 0xFFu) index_reg = cmp_rn;
                    if (((cw >> 31u) & 1u) == 0u) index_is32 = true;
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }

    if (has_rel_add && has_load && has_table_va && !has_base_va && base_reg == table_reg) {
      base_va = table_va;
      has_base_va = true;
    }

    // Attempt to resolve case targets for Pattern A, B, or C.
    uint64_t tmp_targets[kMaxJumpTableCases];
    uint32_t resolved_n = 0u;
    bool all_ok = false;
    bool is_func_table = false;

    if (has_rel_add && has_load && has_table_va && has_base_va && elem_width > 0u) {
      // Pattern A: relative offset table (1/2/4/8 byte entries)
      const uint32_t limit = has_bounds ? entry_count : 64u;
      const bool do_sext = elem_signed || (add_is_ext && add_option >= 4u);
      all_ok = true;
      for (uint32_t c = 0u; c < limit; ++c) {
        const uint64_t byte_off = static_cast<uint64_t>(c) * static_cast<uint64_t>(elem_width);
        if (byte_off > UINT64_MAX - table_va) { all_ok = false; break; }
        const uint64_t eva = table_va + byte_off;
        int64_t sval = 0;
        uint64_t uval = 0ULL;
        bool ok = false;
        if (elem_width == 4u) {
          if (do_sext) { int32_t v = 0; ok = read_rodata_s32(eva, words, word_count, base_addr, &v); sval = v; }
          else { uint32_t v = 0u; ok = read_rodata_u32(eva, words, word_count, base_addr, &v); uval = v; }
        } else if (elem_width == 2u) {
          if (do_sext) { int16_t v = 0; ok = read_rodata_s16(eva, words, word_count, base_addr, &v); sval = v; }
          else { uint16_t v = 0u; ok = read_rodata_u16(eva, words, word_count, base_addr, &v); uval = v; }
        } else if (elem_width == 1u) {
          if (do_sext) { int8_t v = 0; ok = read_rodata_s8(eva, words, word_count, base_addr, &v); sval = v; }
          else { uint8_t v = 0u; ok = read_rodata_u8(eva, words, word_count, base_addr, &v); uval = v; }
        } else if (elem_width == 8u) {
          ok = read_rodata_u64(eva, words, word_count, base_addr, &uval);
          sval = static_cast<int64_t>(uval);
        }
        if (!ok) { all_ok = false; break; }
        const uint64_t delta = do_sext
            ? static_cast<uint64_t>(static_cast<uint64_t>(sval) << add_shift)
            : (uval << add_shift);
        const uint64_t tgt = base_va + delta;
        if (!is_internal_target(tgt, base_addr, word_count, nullptr)) {
          if (!has_bounds && resolved_n >= 2u) { all_ok = true; break; }
          all_ok = false;
          break;
        }
        tmp_targets[resolved_n++] = tgt;
      }
    } else if (!has_rel_add && has_load && elem_width == 8u && has_table_va) {
      // Pattern B: absolute 64-bit pointer table (internal jump labels OR external function-table tail-call dispatch)
      if (has_bounds) {
        bool read_ok = true;
        bool all_internal = true;
        bool all_external_code = true;
        for (uint32_t c = 0u; c < entry_count; ++c) {
          const uint64_t byte_off = static_cast<uint64_t>(c) * 8ULL;
          if (byte_off > UINT64_MAX - table_va) { read_ok = false; break; }
          const uint64_t eva = table_va + byte_off;
          uint64_t tgt = 0ULL;
          if (!read_rodata_u64(eva, words, word_count, base_addr, &tgt)) {
            read_ok = false;
            break;
          }
          tmp_targets[c] = tgt;
          const bool is_int = is_internal_target(tgt, base_addr, word_count, nullptr);
          if (!is_int) all_internal = false;
          const bool is_ext_code = (!is_int && tgt != 0ULL && (tgt & 3ULL) == 0ULL && (tgt >> 56u) == 0ULL);
          if (!is_ext_code) all_external_code = false;
        }
        if (read_ok && (all_internal || all_external_code)) {
          all_ok = true;
          resolved_n = entry_count;
          is_func_table = !all_internal && all_external_code;
        }
      } else {
        all_ok = true;
        for (uint32_t c = 0u; c < 64u; ++c) {
          const uint64_t byte_off = static_cast<uint64_t>(c) * 8ULL;
          if (byte_off > UINT64_MAX - table_va) {
            if (resolved_n >= 2u) { all_ok = true; break; }
            all_ok = false;
            break;
          }
          const uint64_t eva = table_va + byte_off;
          uint64_t tgt = 0ULL;
          if (!read_rodata_u64(eva, words, word_count, base_addr, &tgt) ||
              !is_internal_target(tgt, base_addr, word_count, nullptr)) {
            if (resolved_n >= 2u) { all_ok = true; break; }
            all_ok = false;
            break;
          }
          tmp_targets[resolved_n++] = tgt;
        }
      }
    } else if (has_rel_add && !has_load && has_base_va && has_bounds && add_shift >= 2u && add_shift <= 6u) {
      // Pattern C: computed inline dispatch (adr + add xTgt, xBase, xIdx, lsl #shift; br xTgt)
      if (index_reg == 0xFFu) index_reg = add_rm;
      const uint64_t stride = 1ULL << add_shift;
      all_ok = true;
      for (uint32_t c = 0u; c < entry_count; ++c) {
        const uint64_t tgt = base_va + static_cast<uint64_t>(c) * stride;
        if (!is_internal_target(tgt, base_addr, word_count, nullptr)) {
          all_ok = false;
          break;
        }
        tmp_targets[resolved_n++] = tgt;
      }
    }

    if (all_ok && resolved_n >= 2u && index_reg < 31u) {
      uint64_t* tgts = work_arena.alloc<uint64_t>(resolved_n);
      if (tgts) {
        for (uint32_t c = 0u; c < resolved_n; ++c) {
          tgts[c] = tmp_targets[c];
          uint32_t tidx = 0u;
          if (is_internal_target(tgts[c], base_addr, word_count, &tidx)) {
            is_label[tidx] = 1u;
            if (tidx <= i) has_back_edge[tidx] = 1u;
          }
        }
        jt.resolved = true;
        jt.is_func_table = is_func_table;
        jt.index_reg = index_reg;
        jt.index_is32 = index_is32;
        const uint32_t cap_idx = has_load ? load_idx : (has_rel_add ? add_idx : 0xFFFFFFFFu);
        jt.load_idx = cap_idx;
        if (cap_idx < i) {
          bool clobbered = has_load ? (load_rt == index_reg) : (br_reg == index_reg);
          for (uint32_t k = cap_idx + 1u; !clobbered && k < i; ++k) {
            const uint32_t kw = words[k];
            if ((kw & 0xFC000000u) == 0x94000000u ||
                (kw & 0xFFFFFC1Fu) == 0xD63F0000u ||
                (kw & 0xFFFFF81Fu) == 0xD63F081Fu ||
                (kw & 0xFFFFF800u) == 0xD73F0800u) {
              if (index_reg < 19u) clobbered = true;
              continue;
            }
            if ((kw & 0xFC000000u) == 0x14000000u ||
                (kw & 0xFF000010u) == 0x54000000u ||
                (kw & 0x7E000000u) == 0x34000000u ||
                (kw & 0x7E000000u) == 0x36000000u ||
                (kw & 0xFFFFFC1Fu) == 0xD65F0000u ||
                (kw & 0xFFFFF000u) == 0xD5032000u) {
              continue;
            }
            if (((kw & 0x3B000000u) == 0x39000000u || (kw & 0x3B200000u) == 0x38000000u || (kw & 0x3B200C00u) == 0x38200800u) &&
                ((kw >> 22u) & 3u) == 0u) {
              continue;
            }
            if ((kw & 0x3B000000u) == 0x28000000u) {
              if (((kw >> 22u) & 1u) != 0u &&
                  ((kw & 31u) == index_reg || (((kw >> 10u) & 31u) == index_reg))) {
                clobbered = true;
              }
              continue;
            }
            if ((kw & 31u) == index_reg) clobbered = true;
          }
          jt.index_clobbered = clobbered;
        }
        jt.case_count = resolved_n;
        jt.case_targets = tgts;
        uint32_t didx = 0u;
        if (has_default && is_internal_target(default_target, base_addr, word_count, &didx)) {
          jt.has_default_target = true;
          jt.default_target = default_target;
          is_label[didx] = 1u;
          if (didx <= i) has_back_edge[didx] = 1u;
        }
      }
    } else if (!has_rel_add && !has_bounds && !has_table_va) {
      // No jump-table pattern: treat as external indirect tail call (vtable / GOT / funcptr).
      jt.is_indirect_tail = true;
    }
  }
  return jt_count;
}

static void analyze_sp_promotion(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const JumpTableInfo* jts,
    uint32_t jt_count,
    AnalysisCtx& ctx,
    hex::Arena& work_arena,
    SpPromoState* out) {
  __builtin_memset(out, 0, sizeof(SpPromoState));
  if (!ctx.uses_sp || word_count == 0u) return;

  static constexpr int64_t kUnvisited = SpPromoState::kUnvisited;
  int64_t* sp_off = work_arena.alloc<int64_t>(word_count);
  if (!sp_off) return;
  for (uint32_t i = 0u; i < word_count; ++i) sp_off[i] = kUnvisited;
  sp_off[0] = 0LL;

  // Step 1: Forward constant SP-delta propagation across the CFG.
  bool converged = false;
  for (uint32_t iter = 0u; iter < 32u; ++iter) {
    bool changed = false;
    for (uint32_t i = 0u; i < word_count; ++i) {
      if (sp_off[i] == kUnvisited) continue;
      const uint32_t w = words[i];
      const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
      int64_t next_off = sp_off[i];

      if ((w & 0x1F800000u) == 0x11000000u) {
        const bool is_sub = ((w >> 30u) & 1u) != 0u;
        const bool sets_flags = ((w >> 29u) & 1u) != 0u;
        const uint32_t rn = (w >> 5u) & 31u;
        const uint32_t rd = w & 31u;
        if (!sets_flags && rd == 31u) {
          if (rn != 31u) return;  // mov sp, xN / add sp, xN, #imm -> dynamic SP
          const uint32_t sh = (w >> 22u) & 1u;
          const int64_t imm = static_cast<int64_t>(static_cast<uint64_t>((w >> 10u) & 0xFFFu) << (sh ? 12u : 0u));
          next_off += is_sub ? -imm : imm;
        }
      } else if ((w & 0x1F800000u) == 0x12000000u && ((w >> 29u) & 3u) != 3u && (w & 31u) == 31u) {
        return;  // logical imm writing sp
      } else if ((w & 0x1FE00000u) == 0x0B200000u && (((w >> 5u) & 31u) == 31u || (((w >> 29u) & 1u) == 0u && (w & 31u) == 31u))) {
        return;  // extended reg add/sub touching sp
      } else if ((w & 0x3A000000u) == 0x28000000u) {
        const uint32_t mode = (w >> 23u) & 3u;
        const uint32_t rn = (w >> 5u) & 31u;
        if (rn == 31u && (mode == 1u || mode == 3u)) {
          const uint32_t opc = (w >> 30u) & 3u;
          const bool is_fp = ((w >> 26u) & 1u) != 0u;
          const int64_t imm7 = sign_extend((w >> 15u) & 0x7Fu, 7u);
          uint32_t scale = is_fp ? (4u << opc) : ((opc == 2u) ? 8u : 4u);
          next_off += imm7 * static_cast<int64_t>(scale);
        }
      } else if ((w & 0x3B200000u) == 0x38000000u && (w & 0x3B200C00u) != 0x38200800u) {
        const uint32_t idx_mode = (w >> 10u) & 3u;
        const uint32_t rn = (w >> 5u) & 31u;
        if (rn == 31u && (idx_mode == 1u || idx_mode == 3u)) {
          next_off += sign_extend((w >> 12u) & 0x1FFu, 9u);
        }
      }

      auto prop = [&](uint32_t tgt_idx) -> bool {
        if (tgt_idx >= word_count) return true;
        if (sp_off[tgt_idx] == kUnvisited) {
          sp_off[tgt_idx] = next_off;
          changed = true;
          return true;
        }
        return sp_off[tgt_idx] == next_off;
      };

      const bool is_ret = ((w & 0xFFFFFC1Fu) == 0xD65F0000u || w == 0xD65F0BFFu || w == 0xD65F0FFFu);
      const bool is_brk = ((w & 0xFFE0001Fu) == 0xD4200000u || (w & 0xFFFF0000u) == 0x00000000u);
      const bool is_b = ((w & 0xFC000000u) == 0x14000000u);
      const bool is_br = ((w & 0xFFFFFC1Fu) == 0xD61F0000u || (w & 0xFFFFF81Fu) == 0xD61F081Fu || (w & 0xFFFFF800u) == 0xD71F0800u);
      if (is_ret || is_brk) continue;
      if (is_b) {
        const uint64_t tgt = pc + static_cast<uint64_t>(sign_extend(w & 0x03FFFFFFu, 26u) * 4LL);
        uint32_t tidx = 0u;
        if (is_internal_target(tgt, base_addr, word_count, &tidx) && !prop(tidx)) return;
        continue;
      }
      if (is_br) {
        for (uint32_t j = 0u; j < jt_count; ++j) {
          if (jts[j].br_idx == i && jts[j].resolved) {
            for (uint32_t c = 0u; c < jts[j].case_count; ++c) {
              uint32_t tidx = 0u;
              if (is_internal_target(jts[j].case_targets[c], base_addr, word_count, &tidx) && !prop(tidx)) return;
            }
            if (jts[j].has_default_target) {
              uint32_t didx = 0u;
              if (is_internal_target(jts[j].default_target, base_addr, word_count, &didx) && !prop(didx)) return;
            }
          }
        }
        continue;
      }
      if ((w & 0x7E000000u) == 0x34000000u || (w & 0xFF000010u) == 0x54000000u) {
        const uint64_t tgt = pc + static_cast<uint64_t>(sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL);
        uint32_t tidx = 0u;
        if (is_internal_target(tgt, base_addr, word_count, &tidx) && !prop(tidx)) return;
      } else if ((w & 0x7E000000u) == 0x36000000u) {
        const uint64_t tgt = pc + static_cast<uint64_t>(sign_extend((w >> 5u) & 0x3FFFu, 14u) * 4LL);
        uint32_t tidx = 0u;
        if (is_internal_target(tgt, base_addr, word_count, &tidx) && !prop(tidx)) return;
      }
      if (i + 1u < word_count && !prop(i + 1u)) return;
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  if (!converged) return;

  // Step 2: Check for SP escape and collect all fixed [sp, #imm] accesses.
  bool has_x29_sp_mov = false;
  bool unpromoted_sp_access = false;
  int64_t min_off = 0LL;
  for (uint32_t i = 0u; i < word_count; ++i) {
    if (sp_off[i] != kUnvisited && sp_off[i] < min_off) min_off = sp_off[i];
  }

  auto record_slot = [&](int64_t canon_off, uint8_t width, bool is_fp) {
    if (canon_off < min_off) min_off = canon_off;
    for (uint32_t s = 0u; s < out->slot_count; ++s) {
      if (out->slots[s].canon_off == canon_off) {
        if (out->slots[s].width != width || out->slots[s].is_fp != is_fp) {
          out->slots[s].conflicted = true;
        }
        return;
      }
    }
    if (out->slot_count < kMaxSpSlots) {
      out->slots[out->slot_count++] = SpSlot{canon_off, 0u, width, is_fp, false};
    } else {
      unpromoted_sp_access = true;
    }
  };

  for (uint32_t i = 0u; i < word_count; ++i) {
    const uint32_t w = words[i];
    if (sp_off[i] == kUnvisited) {
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      const bool addsub_sp = ((w & 0x1F800000u) == 0x11000000u) &&
                             (rn == 31u || (((w >> 29u) & 1u) == 0u && rd == 31u));
      const bool logimm_sp = ((w & 0x1F800000u) == 0x12000000u) &&
                             (((w >> 29u) & 3u) != 3u) && (rd == 31u);
      const bool extreg_sp = ((w & 0x1FE00000u) == 0x0B200000u) &&
                             (rn == 31u || (((w >> 29u) & 1u) == 0u && rd == 31u));
      const bool ldstp_sp = ((w & 0x3A000000u) == 0x28000000u) && (rn == 31u);
      const bool ldst_sp = (((w & 0x3B000000u) == 0x39000000u) ||
                            ((w & 0x3B200000u) == 0x38000000u) ||
                            ((w & 0x3B200C00u) == 0x38200800u)) && (rn == 31u);
      const bool atom_simd_sp = (((w & 0x3F000000u) == 0x08000000u) ||
                                 ((w & 0x3FA07C00u) == 0x08A07C00u) ||
                                 ((w & 0x3F208C00u) == 0x38200000u) ||
                                 ((w & 0x3F20FC00u) == 0x38208000u) ||
                                 ((w & 0xBFBF0000u) == 0x0C000000u) ||
                                 ((w & 0xBFA00000u) == 0x0C800000u) ||
                                 ((w & 0xBF9F0000u) == 0x0D000000u)) && (rn == 31u);
      if (addsub_sp || logimm_sp || extreg_sp || ldstp_sp || ldst_sp || atom_simd_sp) {
        return;
      }
      continue;
    }
    // ADD / SUB imm touching SP
    if ((w & 0x1F800000u) == 0x11000000u) {
      const bool is_sub = ((w >> 30u) & 1u) != 0u;
      const bool sets_flags = ((w >> 29u) & 1u) != 0u;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      if (rn == 31u) {
        if (!sets_flags && rd == 31u) continue;  // constant sp adjust
        if (!sets_flags && !is_sub && rd == 29u) {
          has_x29_sp_mov = true;
          continue;
        }
        return;  // sp address escapes into a register or cmp sp
      }
      continue;
    }
    // LDP / STP
    if ((w & 0x3A000000u) == 0x28000000u) {
      const uint32_t rn = (w >> 5u) & 31u;
      if (rn != 31u) continue;
      const uint32_t opc = (w >> 30u) & 3u;
      const bool is_fp = ((w >> 26u) & 1u) != 0u;
      const uint32_t mode = (w >> 23u) & 3u;
      const bool is_load = ((w >> 22u) & 1u) != 0u;
      const int64_t imm7 = sign_extend((w >> 15u) & 0x7Fu, 7u);
      uint32_t scale = 4u, bits = 32u;
      bool valid = true;
      if (is_fp) {
        if (opc == 0u) { scale = 4u; bits = 32u; }
        else if (opc == 1u) { scale = 8u; bits = 64u; }
        else if (opc == 2u) { scale = 16u; bits = 128u; }
        else valid = false;
      } else {
        if (opc == 2u) { scale = 8u; bits = 64u; }
        else if (opc == 0u) { scale = 4u; bits = 32u; }
        else if (opc == 1u && is_load) { scale = 4u; bits = 32u; }
        else valid = false;
      }
      if (!valid || bits > 64u) { unpromoted_sp_access = true; continue; }
      const int64_t disp = imm7 * static_cast<int64_t>(scale);
      const int64_t base = sp_off[i] + ((mode == 3u) ? disp : 0LL);
      const int64_t eff0 = (mode == 0u || mode == 2u) ? disp : 0LL;
      const int64_t eff1 = eff0 + static_cast<int64_t>(scale);
      record_slot(base + eff0, static_cast<uint8_t>(bits >> 3u), is_fp);
      record_slot(base + eff1, static_cast<uint8_t>(bits >> 3u), is_fp);
      continue;
    }
    // LDR / STR
    if ((w & 0x3B000000u) == 0x39000000u || (w & 0x3B200000u) == 0x38000000u || (w & 0x3B200C00u) == 0x38200800u) {
      const uint32_t rn = (w >> 5u) & 31u;
      if (rn != 31u) continue;
      const uint32_t size_f = (w >> 30u) & 3u;
      const bool is_fp = ((w >> 26u) & 1u) != 0u;
      const uint32_t opc = (w >> 22u) & 3u;
      const uint32_t rt = w & 31u;
      if (!is_fp && size_f == 3u && opc == 2u) continue;  // PRFM
      const bool is_uoff = ((w & 0x3B000000u) == 0x39000000u);
      const bool is_regoff = (!is_uoff && (w & 0x3B200C00u) == 0x38200800u);
      if (is_regoff) return;  // dynamic [sp, xM] escapes SP
      uint32_t bits = 64u, scale = 8u;
      if (is_fp) {
        if (size_f == 0u && (opc & 2u) != 0u) { unpromoted_sp_access = true; continue; }
        if (size_f == 0u || size_f == 1u) { unpromoted_sp_access = true; continue; }
        bits = (size_f == 2u) ? 32u : 64u;
        scale = (size_f == 2u) ? 4u : 8u;
        if ((ctx.q_used & (1u << rt)) != 0u) { unpromoted_sp_access = true; continue; }
      } else {
        bits = 8u << size_f;
        scale = 1u << size_f;
      }
      const uint32_t idx_mode = (!is_uoff) ? ((w >> 10u) & 3u) : 0u;
      const int64_t disp = is_uoff
          ? static_cast<int64_t>(((w >> 10u) & 0xFFFu) * scale)
          : sign_extend((w >> 12u) & 0x1FFu, 9u);
      const int64_t base = sp_off[i] + ((idx_mode == 3u) ? disp : 0LL);
      const int64_t eff = (idx_mode == 1u || idx_mode == 3u) ? 0LL : disp;
      record_slot(base + eff, static_cast<uint8_t>(bits >> 3u), is_fp);
      continue;
    }
    // Atomics or SIMD LD/ST touching SP -> SP escapes
    if (((w & 0x3F000000u) == 0x08000000u || (w & 0x3FA07C00u) == 0x08A07C00u ||
         (w & 0x3F208C00u) == 0x38200000u || (w & 0x3F20FC00u) == 0x38208000u ||
         (w & 0xBFBF0000u) == 0x0C000000u || (w & 0xBFA00000u) == 0x0C800000u ||
         (w & 0xBF9F0000u) == 0x0D000000u) && (((w >> 5u) & 31u) == 31u)) {
      return;
    }
  }

  // If mov x29, sp was present, check whether x29 is ever read outside prologue stp/ldp on sp.
  if (has_x29_sp_mov) {
    bool x29_read_non_save = false;
    AnalysisCtx* tmp_ctx = work_arena.alloc<AnalysisCtx>(1u);
    if (!tmp_ctx) return;
    for (uint32_t i = 0u; i < word_count; ++i) {
      const uint32_t w = words[i];
      // Allow prologue/epilogue stp/ldp x29, ... on sp
      if ((w & 0x3A000000u) == 0x28000000u && (((w >> 5u) & 31u) == 31u)) continue;
      if ((w & 0x1F800000u) == 0x11000000u && ((w >> 5u) & 31u) == 31u && (w & 31u) == 29u &&
          ((w >> 30u) & 1u) == 0u && ((w >> 29u) & 1u) == 0u) continue;
      __builtin_memset(tmp_ctx, 0, offsetof(AnalysisCtx, globals));
      tmp_ctx->global_count = 0u;
      tmp_ctx->callee_count = 0u;
      CmpState tcmp{};
      process_insn(w, base_addr + static_cast<uint64_t>(i) * 4ULL, base_addr, word_count, *tmp_ctx, tcmp, false, nullptr);
      if ((tmp_ctx->gpr_read_before_write & (1u << 29u)) != 0u) {
        x29_read_non_save = true;
        break;
      }
    }
    if (x29_read_non_save) return;  // x29 aliases sp and is used -> sp escapes
    out->omit_x29_sp_mov = true;
  }

  if (out->slot_count == 0u) return;

  // Sort slots by canon_off and detect overlapping byte ranges.
  for (uint32_t i = 1u; i < out->slot_count; ++i) {
    const SpSlot key = out->slots[i];
    uint32_t j = i;
    while (j > 0u && out->slots[j - 1u].canon_off > key.canon_off) {
      out->slots[j] = out->slots[j - 1u];
      --j;
    }
    out->slots[j] = key;
  }
  uint32_t promoted_count = 0u;
  uint32_t conflicted_count = 0u;
  for (uint32_t i = 0u; i < out->slot_count; ++i) {
    for (uint32_t j = i + 1u; j < out->slot_count; ++j) {
      if (out->slots[i].canon_off + static_cast<int64_t>(out->slots[i].width) > out->slots[j].canon_off) {
        out->slots[i].conflicted = true;
        out->slots[j].conflicted = true;
      }
    }
    out->slots[i].slot_id = static_cast<uint32_t>(out->slots[i].canon_off - min_off);
    if (out->slots[i].conflicted) {
      ++conflicted_count;
    } else {
      ++promoted_count;
      if (!out->slots[i].is_fp) {
        if (out->slots[i].width == 1u) ctx.uses_uint8 = true;
        else if (out->slots[i].width == 2u) ctx.uses_uint16 = true;
        else if (out->slots[i].width == 4u) ctx.uses_uint32 = true;
      }
    }
  }
  if (promoted_count == 0u) return;

  out->active = true;
  out->min_sp_off = min_off;
  out->insn_sp_off = sp_off;
  out->all_sp_promoted = (!unpromoted_sp_access && conflicted_count == 0u);
  if (out->all_sp_promoted) {
    ctx.uses_sp = false;
  }
}


// -----------------------------------------------------------------------------
// Readability Pass Helpers: Strict Magic Constant Division Recovery,
// Idempotent Double-Cast Reduction, and Safe Single-Use Temp Register Folding
// -----------------------------------------------------------------------------

struct U128Pair {
  uint64_t hi;
  uint64_t lo;
};

static U128Pair mul_u64_u64(uint64_t a, uint64_t b) {
  const uint64_t a_lo = a & 0xFFFFFFFFULL;
  const uint64_t a_hi = a >> 32u;
  const uint64_t b_lo = b & 0xFFFFFFFFULL;
  const uint64_t b_hi = b >> 32u;
  const uint64_t p0 = a_lo * b_lo;
  const uint64_t p1 = a_lo * b_hi;
  const uint64_t p2 = a_hi * b_lo;
  const uint64_t p3 = a_hi * b_hi;
  const uint64_t mid = (p0 >> 32u) + (p1 & 0xFFFFFFFFULL) + (p2 & 0xFFFFFFFFULL);
  const uint64_t lo = (p0 & 0xFFFFFFFFULL) | (mid << 32u);
  const uint64_t hi = p3 + (p1 >> 32u) + (p2 >> 32u) + (mid >> 32u);
  return U128Pair{hi, lo};
}

static uint64_t u128_shr_to_u64(U128Pair v, uint32_t shift) {
  if (shift == 0u) return v.lo;
  if (shift < 64u) return (v.lo >> shift) | (v.hi << (64u - shift));
  if (shift < 128u) return v.hi >> (shift - 64u);
  return 0ULL;
}

// Computes ceil(2^shift / m) for 32 <= shift <= 127 and m > 0, returning false if quotient >= 2^64.
static bool ceil_pow2_div_u64(uint32_t shift, uint64_t m, uint64_t* out_q) {
  if (m == 0ULL || shift < 32u || shift >= 128u) return false;
  // Represent numerator N = 2^shift + (m - 1) as 129-bit? Easier: compute floor(2^shift / m) and remainder r;
  // if r > 0, add 1.
  uint64_t q_hi = 0ULL, q_lo = 0ULL;
  uint64_t rem = 0ULL;
  // Bitwise long division of 2^shift by m (bits from `shift` down to 0)
  for (int bit = static_cast<int>(shift); bit >= 0; --bit) {
    const uint64_t in_bit = (bit == static_cast<int>(shift)) ? 1ULL : 0ULL;
    const bool carry = (rem >> 63u) != 0ULL;
    rem = (rem << 1u) | in_bit;
    uint64_t qbit = 0ULL;
    if (carry || rem >= m) {
      rem -= m;
      qbit = 1ULL;
    }
    if (bit >= 64) {
      if (qbit) q_hi |= (1ULL << (bit - 64));
    } else {
      if (qbit) q_lo |= (1ULL << bit);
    }
  }
  if (q_hi != 0ULL) return false;
  if (rem != 0ULL) {
    if (q_lo == 0xFFFFFFFFFFFFFFFFULL) return false;
    q_lo += 1ULL;
  }
  *out_q = q_lo;
  return true;
}

static bool verify_magic_udiv(uint64_t magic, uint32_t shift, uint32_t bits, uint64_t* out_divisor) {
  if (magic == 0ULL || shift < bits || shift >= 2u * bits) return false;
  uint64_t d = 0ULL;
  if (!ceil_pow2_div_u64(shift, magic, &d)) return false;
  const uint64_t umax = (bits == 32u) ? 0xFFFFFFFFULL : 0xFFFFFFFFFFFFFFFFULL;
  if (d < 2ULL || d > umax) return false;
  const uint64_t rem = umax % d;
  const uint64_t x_hi = (rem == d - 1ULL) ? umax : (umax - rem - 1ULL);
  const uint64_t probes[7] = {0ULL, 1ULL, d - 1ULL, d, d + 1ULL, x_hi, umax};
  for (uint32_t k = 0u; k < 7u; ++k) {
    const uint64_t x = probes[k];
    if (x > umax) continue;
    const uint64_t q_magic = u128_shr_to_u64(mul_u64_u64(magic, x), shift);
    if (q_magic != (x / d)) return false;
  }
  *out_divisor = d;
  return true;
}

static bool verify_magic_sdiv(uint64_t m_eff, uint32_t shift, uint32_t bits, uint64_t* out_divisor) {
  if (m_eff == 0ULL || shift < bits || shift >= 2u * bits) return false;
  uint64_t d_u = 0ULL;
  if (!ceil_pow2_div_u64(shift, m_eff, &d_u)) return false;
  const uint64_t smax_u = (bits == 32u) ? 0x7FFFFFFFULL : 0x7FFFFFFFFFFFFFFFULL;
  if (d_u < 2ULL || d_u > smax_u) return false;
  const int64_t d = static_cast<int64_t>(d_u);
  const int64_t smax = static_cast<int64_t>(smax_u);
  const int64_t smin = (bits == 32u) ? (-2147483648LL) : (-9223372036854775807LL - 1LL);

  auto check_x = [&](int64_t x) -> bool {
    if (x < smin || x > smax) return true;
    int64_t q = 0;
    if (x >= 0) {
      const uint64_t mag_q = u128_shr_to_u64(mul_u64_u64(m_eff, static_cast<uint64_t>(x)), shift);
      q = static_cast<int64_t>(mag_q);
    } else {
      // For negative x, m_eff * x = -(m_eff * |x|).
      // Arithmetic shift right by `shift`: floor(-P / 2^shift) = -ceil(P / 2^shift).
      // Adding 1 for negative sign correction gives: 1 - ceil(P / 2^shift).
      // If P is an exact multiple of 2^shift: - (P >> shift) + 1; else -( (P >> shift) + 1 ) + 1 = -(P >> shift).
      const uint64_t abs_x = (x == (-9223372036854775807LL - 1LL))
          ? 0x8000000000000000ULL
          : static_cast<uint64_t>(-x);
      const U128Pair prod = mul_u64_u64(m_eff, abs_x);
      const uint64_t q_abs = u128_shr_to_u64(prod, shift);
      bool has_low_bits = false;
      if (shift < 64u) {
        has_low_bits = (prod.lo & ((1ULL << shift) - 1ULL)) != 0ULL;
      } else if (shift == 64u) {
        has_low_bits = prod.lo != 0ULL;
      } else {
        has_low_bits = (prod.lo != 0ULL) || ((prod.hi & ((1ULL << (shift - 64u)) - 1ULL)) != 0ULL);
      }
      const int64_t floor_neg = has_low_bits ? (-static_cast<int64_t>(q_abs) - 1LL) : (-static_cast<int64_t>(q_abs));
      q = floor_neg + 1LL;
    }
    return q == (x / d);
  };

  const uint64_t rem_pos = smax_u % d_u;
  const int64_t x_pos_hi = (rem_pos == d_u - 1ULL)
      ? smax
      : static_cast<int64_t>(smax_u - rem_pos - 1ULL);
  const uint64_t smin_mag = smax_u + 1ULL;
  const uint64_t rem_neg = smin_mag % d_u;
  const int64_t x_neg_lo = (rem_neg == d_u - 1ULL)
      ? smin
      : (smin + static_cast<int64_t>(rem_neg) + 1LL);

  const int64_t probes[13] = {
    0, 1, -1, d - 1, d, d + 1, -(d - 1), -d, -(d + 1),
    x_pos_hi, smax, x_neg_lo, smin
  };
  for (uint32_t k = 0u; k < 13u; ++k) {
    if (!check_x(probes[k])) return false;
  }
  *out_divisor = d_u;
  return true;
}

static bool decode_mov_const_seq(const uint32_t* words, uint32_t word_count, uint32_t start,
                                 const uint8_t* is_label, bool has_pending_cmp, uint32_t pending_consumer,
                                 uint32_t* out_rd, bool* out_is64, uint64_t* out_val, uint32_t* out_next) {
  if (start >= word_count) return false;
  const uint32_t w = words[start];
  const uint32_t opc = (w >> 29u) & 3u;
  if ((w & 0x1F800000u) != 0x12800000u || (opc != 0u && opc != 2u)) return false;
  const uint32_t rd = w & 31u;
  const bool is64 = ((w >> 31u) & 1u) != 0u;
  const uint32_t hw = (w >> 21u) & 3u;
  if (rd >= 31u || (!is64 && hw >= 2u)) return false;
  const uint64_t imm16 = static_cast<uint64_t>((w >> 5u) & 0xFFFFu);
  uint64_t val = imm16 << (hw * 16u);
  if (opc == 0u) val = ~val;
  if (!is64) val &= 0xFFFFFFFFULL;
  uint32_t j = start + 1u;
  while (j < word_count && is_label[j] == 0u && (!has_pending_cmp || j != pending_consumer)) {
    const uint32_t wj = words[j];
    if ((wj & 0x1F800000u) != 0x12800000u || ((wj >> 29u) & 3u) != 3u) break;
    if ((wj & 31u) != rd) break;
    if ((((wj >> 31u) & 1u) != 0u) != is64) break;
    const uint32_t hw_j = (wj >> 21u) & 3u;
    if (!is64 && hw_j >= 2u) break;
    const uint64_t imm16_j = static_cast<uint64_t>((wj >> 5u) & 0xFFFFu);
    const uint32_t shift_j = hw_j * 16u;
    val = (val & ~(0xFFFFULL << shift_j)) | (imm16_j << shift_j);
    if (!is64) val &= 0xFFFFFFFFULL;
    ++j;
  }
  *out_rd = rd;
  *out_is64 = is64;
  *out_val = val;
  *out_next = j;
  return true;
}

static bool reg_is_redefined_before_use_or_dead(const uint32_t* words, uint32_t word_count,
                                                uint32_t start, uint32_t reg) {
  const uint32_t limit = (start + 16u < word_count) ? (start + 16u) : word_count;
  for (uint32_t k = start; k < limit; ++k) {
    const uint32_t w = words[k];
    if (w == 0xD65F03C0u) return (reg >= 8u && reg <= 17u);
    if (w == 0xD503201Fu) continue; // NOP
    if ((w & 0xFC000000u) == 0x14000000u || (w & 0xFC000000u) == 0x94000000u ||
        (w & 0xFF000010u) == 0x54000000u || (w & 0x7E000000u) == 0x34000000u ||
        (w & 0x7E000000u) == 0x36000000u || (w & 0xFE1FFC1Fu) == 0xD61F0000u) {
      return false;
    }
    // MOVZ / MOVN (no source register)
    const uint32_t opc = (w >> 29u) & 3u;
    if ((w & 0x1F800000u) == 0x12800000u && (opc == 0u || opc == 2u)) {
      if ((w & 31u) == reg) return true;
      continue;
    }
    // Epilogue SP adjust: ADD/SUB sp, sp, #imm (does not read GPR reg < 31)
    if ((w & 0x7F8003FFu) == 0x110003FFu || (w & 0x7F8003FFu) == 0x510003FFu) {
      continue;
    }
    // Epilogue LDP Rt1, Rt2, [sp, ...] (GPR)
    if ((w & 0x3E4003E0u) == 0x284003E0u) {
      const uint32_t ldp_opc = (w >> 30u) & 3u;
      const uint32_t mode = (w >> 23u) & 7u;
      if (ldp_opc != 3u && mode >= 1u && mode <= 3u) {
        const uint32_t rt1 = w & 31u;
        const uint32_t rt2 = (w >> 10u) & 31u;
        if (rt1 == reg || rt2 == reg) return true;
        continue;
      }
    }
    // Epilogue LDP Dt1, Dt2, [sp, ...] (SIMD/FP, does not touch GPR)
    if ((w & 0x3E4003E0u) == 0x2C4003E0u) {
      const uint32_t mode = (w >> 23u) & 7u;
      if (mode >= 1u && mode <= 3u) continue;
    }
    // Epilogue LDR Rt, [sp, ...] (unsigned offset or pre/post-index, GPR)
    if ((w & 0xBFC003E0u) == 0xB94003E0u || (w & 0xBFE007E0u) == 0xB84007E0u) {
      if ((w & 31u) == reg) return true;
      continue;
    }
    return false;
  }
  return false;
}

static bool try_emit_magic_div_seq(const uint32_t* words, uint32_t word_count, uint32_t start,
                                   uint64_t base_addr, const uint8_t* is_label,
                                   bool has_pending_cmp, uint32_t pending_consumer,
                                   AnalysisCtx& ctx, TextBuf& tb, uint32_t* out_last_idx) {
  uint32_t magic_reg = 31u;
  bool magic_is64 = false;
  uint64_t magic_val = 0ULL;
  uint32_t pos = start;
  if (!decode_mov_const_seq(words, word_count, start, is_label, has_pending_cmp, pending_consumer,
                            &magic_reg, &magic_is64, &magic_val, &pos)) {
    return false;
  }
  if (pos >= word_count || is_label[pos] != 0u || (has_pending_cmp && pos == pending_consumer)) {
    return false;
  }

  // Decode high multiply: SMULL, UMULL, SMULH, UMULH
  const uint32_t wm = words[pos];
  bool is_64 = false;
  bool is_unsigned = false;
  uint32_t prod_reg = 31u;
  uint32_t rn = 31u;
  uint32_t rm = 31u;
  if ((wm & 0xFFE0FC00u) == 0x9B207C00u) {
    is_64 = false; is_unsigned = false;
    rm = (wm >> 16u) & 31u; rn = (wm >> 5u) & 31u; prod_reg = wm & 31u;
  } else if ((wm & 0xFFE0FC00u) == 0x9BA07C00u) {
    is_64 = false; is_unsigned = true;
    rm = (wm >> 16u) & 31u; rn = (wm >> 5u) & 31u; prod_reg = wm & 31u;
  } else if ((wm & 0xFFE0FC00u) == 0x9B407C00u) {
    is_64 = true; is_unsigned = false;
    rm = (wm >> 16u) & 31u; rn = (wm >> 5u) & 31u; prod_reg = wm & 31u;
  } else if ((wm & 0xFFE0FC00u) == 0x9BC07C00u) {
    is_64 = true; is_unsigned = true;
    rm = (wm >> 16u) & 31u; rn = (wm >> 5u) & 31u; prod_reg = wm & 31u;
  } else {
    return false;
  }
  if (prod_reg >= 31u || rn >= 31u || rm >= 31u) return false;
  if (rn != magic_reg && rm != magic_reg) return false;
  const uint32_t div_reg = (rn == magic_reg) ? rm : rn;
  if (div_reg == magic_reg) return false;
  ++pos;

  auto can_step = [&](uint32_t idx) -> bool {
    return idx < word_count && is_label[idx] == 0u && (!has_pending_cmp || idx != pending_consumer);
  };

  uint32_t cur_reg = prod_reg;
  uint32_t total_shift = is_64 ? 64u : 0u;
  bool has_overflow_add = false;
  uint32_t intermediate_def_mask = (1u << prod_reg);

  // Optional 32-bit shift >> 32 (or >> s >= 32)
  // For 32-bit signed division, LSR #sh is only semantically equivalent to ASR #sh
  // on the low 32 bits when sh == 32; sh > 32 MUST use ASR.
  if (!is_64 && can_step(pos)) {
    const uint32_t ws = words[pos];
    const bool is_lsr64 = (ws & 0xFFC0FC00u) == 0xD340FC00u;
    const bool is_asr64 = (ws & 0xFFC0FC00u) == 0x9340FC00u;
    if (((ws >> 5u) & 31u) == cur_reg) {
      const uint32_t sh = (ws >> 16u) & 63u;
      const bool shift_ok = is_unsigned
          ? (is_lsr64 && sh >= 32u)
          : ((is_asr64 && sh >= 32u) || (is_lsr64 && sh == 32u));
      if (shift_ok) {
        cur_reg = ws & 31u;
        if (cur_reg >= 31u) return false;
        intermediate_def_mask |= (1u << cur_reg);
        total_shift = sh;
        ++pos;
      }
    }
  }

  // Optional overflow-correction ADD (signed division where magic >= 2^(W-1), e.g. / 7)
  if (!is_unsigned && (intermediate_def_mask & (1u << div_reg)) == 0u && can_step(pos)) {
    const uint32_t wa = words[pos];
    if (!is_64) {
      if (total_shift == 32u && (wa & 0xFFE0FC00u) == 0x0B000000u) {
        const uint32_t am = (wa >> 16u) & 31u;
        const uint32_t an = (wa >> 5u) & 31u;
        const uint32_t ad = wa & 31u;
        if (ad < 31u && ((an == cur_reg && am == div_reg) || (an == div_reg && am == cur_reg))) {
          cur_reg = ad;
          intermediate_def_mask |= (1u << cur_reg);
          has_overflow_add = true;
          ++pos;
        }
      } else if (total_shift == 0u && (wa & 0xFFE0FC00u) == 0x8B808000u) {
        const uint32_t am = (wa >> 16u) & 31u;
        const uint32_t an = (wa >> 5u) & 31u;
        const uint32_t ad = wa & 31u;
        if (ad < 31u && an == div_reg && am == cur_reg) {
          cur_reg = ad;
          intermediate_def_mask |= (1u << cur_reg);
          total_shift = 32u;
          has_overflow_add = true;
          ++pos;
        }
      }
    } else {
      if ((wa & 0xFFE0FC00u) == 0x8B000000u) {
        const uint32_t am = (wa >> 16u) & 31u;
        const uint32_t an = (wa >> 5u) & 31u;
        const uint32_t ad = wa & 31u;
        if (ad < 31u && ((an == cur_reg && am == div_reg) || (an == div_reg && am == cur_reg))) {
          cur_reg = ad;
          intermediate_def_mask |= (1u << cur_reg);
          has_overflow_add = true;
          ++pos;
        }
      }
    }
  }

  // Optional secondary right shift (ASR for signed, LSR for unsigned)
  if (can_step(pos)) {
    const uint32_t ws2 = words[pos];
    if (!is_64 && total_shift == 32u) {
      const bool ok_op = is_unsigned ? ((ws2 & 0xFFC0FC00u) == 0x53007C00u)
                                     : ((ws2 & 0xFFC0FC00u) == 0x13007C00u);
      if (ok_op && ((ws2 >> 5u) & 31u) == cur_reg) {
        const uint32_t sh = (ws2 >> 16u) & 31u;
        const uint32_t sd = ws2 & 31u;
        if (sd < 31u && sh > 0u) {
          cur_reg = sd;
          intermediate_def_mask |= (1u << cur_reg);
          total_shift += sh;
          ++pos;
        }
      }
    } else if (is_64) {
      const bool ok_op = is_unsigned ? ((ws2 & 0xFFC0FC00u) == 0xD340FC00u)
                                     : ((ws2 & 0xFFC0FC00u) == 0x9340FC00u);
      if (ok_op && ((ws2 >> 5u) & 31u) == cur_reg) {
        const uint32_t sh = (ws2 >> 16u) & 63u;
        const uint32_t sd = ws2 & 31u;
        if (sd < 31u && sh > 0u) {
          cur_reg = sd;
          intermediate_def_mask |= (1u << cur_reg);
          total_shift += sh;
          ++pos;
        }
      }
    }
  }

  const uint32_t bits = is_64 ? 64u : 32u;
  if (total_shift < bits || total_shift >= 2u * bits) return false;

  uint32_t final_rd = cur_reg;
  uint32_t last_idx = pos - 1u;

  if (!is_unsigned) {
    // Signed division REQUIRES exact negative-dividend rounding correction
    if (!can_step(pos)) return false;
    const uint32_t wc = words[pos];
    bool matched_round = false;
    const uint32_t sign_sh = is_64 ? 63u : 31u;
    const uint32_t sf_bit = is_64 ? 0x80000000u : 0x00000000u;
    const bool div_reg_alive = (intermediate_def_mask & (1u << div_reg)) == 0u;
    const auto is_valid_sign_src = [&](uint32_t r) {
      return r == cur_reg || (div_reg_alive && r == div_reg);
    };

    // Pattern A/B: ADD Rd, Rq, (Rq|Rdiv), LSR #(W-1)
    if ((wc & 0xFFE0FC00u) == (sf_bit | 0x0B400000u | (sign_sh << 10u))) {
      const uint32_t cm = (wc >> 16u) & 31u;
      const uint32_t cn = (wc >> 5u) & 31u;
      const uint32_t cd = wc & 31u;
      if (cd < 31u && cn == cur_reg && is_valid_sign_src(cm)) {
        final_rd = cd;
        last_idx = pos;
        matched_round = true;
      }
    }
    // Pattern C: SUB Rd, Rq, Rdiv, ASR #(W-1)
    if (!matched_round && (wc & 0xFFE0FC00u) == (sf_bit | 0x4B800000u | (sign_sh << 10u))) {
      const uint32_t cm = (wc >> 16u) & 31u;
      const uint32_t cn = (wc >> 5u) & 31u;
      const uint32_t cd = wc & 31u;
      if (cd < 31u && cn == cur_reg && is_valid_sign_src(cm)) {
        final_rd = cd;
        last_idx = pos;
        matched_round = true;
      }
    }
    // Pattern D/E: 2-instruction sign extract (LSR/ASR #(W-1)) + ADD/SUB
    if (!matched_round && can_step(pos + 1u)) {
      const bool is_lsr_sign = is_64 ? ((wc & 0xFFC0FC00u) == 0xD340FC00u && ((wc >> 16u) & 63u) == 63u)
                                     : ((wc & 0xFFC0FC00u) == 0x53007C00u && ((wc >> 16u) & 31u) == 31u);
      const bool is_asr_sign = is_64 ? ((wc & 0xFFC0FC00u) == 0x9340FC00u && ((wc >> 16u) & 63u) == 63u)
                                     : ((wc & 0xFFC0FC00u) == 0x13007C00u && ((wc >> 16u) & 31u) == 31u);
      const uint32_t sn = (wc >> 5u) & 31u;
      const uint32_t sd = wc & 31u;
      if ((is_lsr_sign || is_asr_sign) && sd < 31u && sd != cur_reg && is_valid_sign_src(sn)) {
        const uint32_t wc2 = words[pos + 1u];
        const uint32_t c2m = (wc2 >> 16u) & 31u;
        const uint32_t c2n = (wc2 >> 5u) & 31u;
        const uint32_t c2d = wc2 & 31u;
        if (is_lsr_sign && (wc2 & 0xFFE0FC00u) == (sf_bit | 0x0B000000u) && c2d < 31u &&
            ((c2n == cur_reg && c2m == sd) || (c2n == sd && c2m == cur_reg))) {
          intermediate_def_mask |= (1u << sd);
          final_rd = c2d;
          last_idx = pos + 1u;
          matched_round = true;
        } else if (is_asr_sign && (wc2 & 0xFFE0FC00u) == (sf_bit | 0x4B000000u) && c2d < 31u &&
                   c2n == cur_reg && c2m == sd) {
          intermediate_def_mask |= (1u << sd);
          final_rd = c2d;
          last_idx = pos + 1u;
          matched_round = true;
        }
      }
    }
    if (!matched_round) return false;
  }

  // Exact mathematical verification of (magic, shift, width, signedness, overflow_add)
  uint64_t divisor = 0ULL;
  if (is_unsigned) {
    const uint64_t m_u = is_64 ? magic_val : (magic_val & 0xFFFFFFFFULL);
    if (!verify_magic_udiv(m_u, total_shift, bits, &divisor)) return false;
  } else {
    uint64_t m_eff = 0ULL;
    if (!is_64) {
      const uint32_t m32 = static_cast<uint32_t>(magic_val & 0xFFFFFFFFULL);
      const bool msb_set = (m32 & 0x80000000u) != 0u;
      if (has_overflow_add != msb_set) return false;
      m_eff = static_cast<uint64_t>(m32);
    } else {
      const bool msb_set = (magic_val & 0x8000000000000000ULL) != 0ULL;
      if (has_overflow_add != msb_set) return false;
      m_eff = magic_val;
    }
    if (!verify_magic_sdiv(m_eff, total_shift, bits, &divisor)) return false;
  }

  // Abort folding if any intermediate defined register (other than final_rd) may be live after last_idx.
  intermediate_def_mask &= ~(1u << final_rd);
  for (uint32_t r = 0u; r < 31u; ++r) {
    if ((intermediate_def_mask & (1u << r)) != 0u) {
      if (!reg_is_redefined_before_use_or_dead(words, word_count, last_idx + 1u, r)) {
        return false;
      }
    }
  }

  const uint64_t pc = base_addr + static_cast<uint64_t>(start) * 4ULL;
  if (magic_reg != final_rd && !reg_is_redefined_before_use_or_dead(words, word_count, last_idx + 1u, magic_reg)) {
    tb.record_line(pc);
    tb.put_str("    ");
    tb.put_reg_x(magic_reg);
    tb.put_str(" = ");
    tb.put_imm(magic_val);
    tb.put_str(";\n");
    ctx.clear_adrp(magic_reg);
  }

  tb.record_line(base_addr + static_cast<uint64_t>(last_idx) * 4ULL);
  tb.put_str("    ");
  tb.put_reg_x(final_rd);
  if (!is_64 && !is_unsigned) {
    tb.put_str(" = (uint64)(uint32_t)((int32_t)");
    tb.put_reg_x(div_reg);
    tb.put_str(" / ");
    tb.put_u64_dec(divisor);
    tb.put_str(");\n");
  } else if (!is_64 && is_unsigned) {
    tb.put_str(" = (uint64)((uint32_t)");
    tb.put_reg_x(div_reg);
    tb.put_str(" / ");
    tb.put_u64_dec(divisor);
    tb.put_str("U);\n");
  } else if (is_64 && !is_unsigned) {
    tb.put_str(" = (uint64)((int64_t)");
    tb.put_reg_x(div_reg);
    tb.put_str(" / ");
    tb.put_u64_dec(divisor);
    tb.put_str("LL);\n");
  } else {
    tb.put_str(" = (");
    tb.put_reg_x(div_reg);
    tb.put_str(" / ");
    tb.put_u64_dec(divisor);
    tb.put_str("ULL);\n");
  }
  ctx.clear_adrp(final_rd);
  *out_last_idx = last_idx;
  return true;
}

static void simplify_idempotent_casts_in_body(TextBuf& tb, uint32_t body_start_off) {
  if (tb.overflow || body_start_off >= tb.len) return;
  static const struct { const char* from; uint32_t from_len; const char* to; uint32_t to_len; } kPairs[] = {
    {"(uint64)(uint64)", 16u, "(uint64)", 8u},
    {"(uint64_t)(uint64_t)", 20u, "(uint64_t)", 10u},
    {"(int64_t)(int64_t)", 18u, "(int64_t)", 9u},
    {"(uint32_t)(uint32_t)", 20u, "(uint32_t)", 10u},
    {"(int32_t)(int32_t)", 18u, "(int32_t)", 9u},
    {"(uint64)(uint64_t)", 18u, "(uint64)", 8u},
    {"(uint64_t)(uint64)", 18u, "(uint64_t)", 10u},
  };
  bool any = true;
  uint32_t rounds = 0u;
  while (any && rounds < 4u) {
    any = false;
    ++rounds;
    for (uint32_t k = 0u; k < sizeof(kPairs) / sizeof(kPairs[0]); ++k) {
      const char* pat = kPairs[k].from;
      const uint32_t plen = kPairs[k].from_len;
      const char* rep = kPairs[k].to;
      const uint32_t rlen = kPairs[k].to_len;
      uint32_t read_pos = body_start_off;
      uint32_t write_pos = body_start_off;
      while (read_pos < tb.len) {
        if (read_pos + plen <= tb.len && starts_with(tb.data + read_pos, plen, pat, plen)) {
          for (uint32_t c = 0u; c < rlen; ++c) tb.data[write_pos++] = rep[c];
          read_pos += plen;
          any = true;
        } else {
          tb.data[write_pos++] = tb.data[read_pos++];
        }
      }
      tb.len = write_pos;
      tb.data[tb.len] = '\0';
    }
  }
}

static bool is_ident_char_simple(char ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_';
}

static uint32_t count_ident_occurrences(const char* buf, uint32_t start, uint32_t end,
                                        const char* name, uint32_t name_len) {
  uint32_t count = 0u;
  for (uint32_t p = start; p + name_len <= end; ++p) {
    if (buf[p] == name[0] && starts_with(buf + p, name_len, name, name_len)) {
      const bool left_ok = (p == start) || !is_ident_char_simple(buf[p - 1u]);
      const bool right_ok = (p + name_len == end) || !is_ident_char_simple(buf[p + name_len]);
      if (left_ok && right_ok) {
        ++count;
        p += name_len - 1u;
      }
    }
  }
  return count;
}

static void fold_single_use_scratch_temps(TextBuf& tb, uint32_t body_start_off, uint32_t body_start_line,
                                          hex::Arena& work_arena) {
  if (tb.overflow || body_start_off >= tb.len) return;
  const uint32_t max_lines = 4096u;
  uint32_t* line_off = work_arena.alloc<uint32_t>(max_lines);
  uint32_t* line_len = work_arena.alloc<uint32_t>(max_lines);
  if (!line_off || !line_len) return;

  uint32_t nlines = 0u;
  uint32_t p = body_start_off;
  while (p < tb.len && nlines < max_lines) {
    const uint32_t s = p;
    while (p < tb.len && tb.data[p] != '\n') ++p;
    if (p < tb.len && tb.data[p] == '\n') ++p;
    line_off[nlines] = s;
    line_len[nlines] = p - s;
    ++nlines;
  }
  if (nlines < 2u || p < tb.len) return;

  char* out_buf = work_arena.alloc<char>(tb.cap);
  if (!out_buf) return;
  uint32_t out_len = 0u;
  uint32_t removed_lines = 0u;
  bool changed = false;

  for (uint32_t li = 0u; li < nlines; ++li) {
    const char* ln = tb.data + line_off[li];
    const uint32_t ll = line_len[li];

    bool folded = false;
    if (li + 1u < nlines && ll > 8u && ll < 120u && ln[ll - 1u] == '\n' && ln[ll - 2u] == ';') {
      uint32_t ind = 0u;
      while (ind < ll && ln[ind] == ' ') ++ind;
      if (ind + 6u < ll && ln[ind] == 'x' && ln[ind + 1u] >= '0' && ln[ind + 1u] <= '9') {
        uint32_t reg = static_cast<uint32_t>(ln[ind + 1u] - '0');
        uint32_t name_end = ind + 2u;
        if (name_end < ll && ln[name_end] >= '0' && ln[name_end] <= '9') {
          reg = reg * 10u + static_cast<uint32_t>(ln[name_end] - '0');
          ++name_end;
        }
        const uint32_t name_len = name_end - ind;
        if (reg >= 8u && reg <= 17u && name_end + 3u < ll &&
            ln[name_end] == ' ' && ln[name_end + 1u] == '=' && ln[name_end + 2u] == ' ') {
          const char* rhs = ln + name_end + 3u;
          const uint32_t rhs_len = (ll - 2u) - (name_end + 3u);
          bool pure = (rhs_len > 0u && rhs_len <= 72u);
          for (uint32_t k = 0u; pure && k < rhs_len; ++k) {
            const char c = rhs[k];
            if (c == '=' || c == ',' || c == '?' || c == ':' || c == '*' || c == '[' || c == '"') {
              pure = false;
            }
            if (c == '(' && k > 0u && is_ident_char_simple(rhs[k - 1u])) {
              pure = false;
            }
          }
          if (pure && count_ident_occurrences(rhs, 0u, rhs_len, ln + ind, name_len) == 0u) {
            const char* nxt = tb.data + line_off[li + 1u];
            const uint32_t nlen = line_len[li + 1u];
            uint32_t nind = 0u;
            while (nind < nlen && nxt[nind] == ' ') ++nind;
            if (nind == ind && nlen > nind + 3u && nxt[nind] != '}' && nxt[nind] != '{' &&
                !starts_with(nxt + nind, nlen - nind, "L_", 2u) &&
                !starts_with(nxt + nind, nlen - nind, "while", 5u) &&
                !starts_with(nxt + nind, nlen - nind, "for", 3u)) {
              const uint32_t next_uses = count_ident_occurrences(nxt, 0u, nlen, ln + ind, name_len);
              const uint32_t total_uses = count_ident_occurrences(tb.data, body_start_off, tb.len, ln + ind, name_len);
              if (next_uses == 1u && total_uses == 2u) {
                uint32_t occ_pos = 0u;
                for (uint32_t q = 0u; q + name_len <= nlen; ++q) {
                  if (nxt[q] == ln[ind] && starts_with(nxt + q, name_len, ln + ind, name_len) &&
                      (q == 0u || !is_ident_char_simple(nxt[q - 1u])) &&
                      (q + name_len == nlen || !is_ident_char_simple(nxt[q + name_len]))) {
                    occ_pos = q;
                    break;
                  }
                }
                const bool is_lhs = (occ_pos + name_len + 2u < nlen &&
                                     nxt[occ_pos + name_len] == ' ' &&
                                     nxt[occ_pos + name_len + 1u] == '=' &&
                                     nxt[occ_pos + name_len + 2u] != '=');
                const uint32_t needed = nlen - name_len + rhs_len + 2u;
                if (!is_lhs && out_len + needed < tb.cap - body_start_off) {
                  hex::mem_copy(out_buf + out_len, nxt, occ_pos);
                  out_len += occ_pos;
                  out_buf[out_len++] = '(';
                  hex::mem_copy(out_buf + out_len, rhs, rhs_len);
                  out_len += rhs_len;
                  out_buf[out_len++] = ')';
                  hex::mem_copy(out_buf + out_len, nxt + occ_pos + name_len, nlen - (occ_pos + name_len));
                  out_len += nlen - (occ_pos + name_len);
                  const uint32_t removed_line_no = body_start_line + li - removed_lines;
                  for (uint32_t k = 0u; k < tb.lm_count; ++k) {
                    if (tb.lm[k].line_no > removed_line_no) tb.lm[k].line_no -= 1u;
                  }
                  ++removed_lines;
                  ++li;
                  changed = true;
                  folded = true;
                }
              }
            }
          }
        }
      }
    }
    if (!folded) {
      if (out_len + ll >= tb.cap - body_start_off) return;
      hex::mem_copy(out_buf + out_len, ln, ll);
      out_len += ll;
    }
  }

  if (changed && body_start_off + out_len < tb.cap) {
    hex::mem_copy(tb.data + body_start_off, out_buf, out_len);
    tb.len = body_start_off + out_len;
    tb.data[tb.len] = '\0';
    if (tb.line_no > removed_lines) tb.line_no -= removed_lines;
  }
}

HexStatus try_emit_arm64_general(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t emit_flags,
    hex::Arena& emit_arena,
    const char** out_text,
    uint32_t* out_text_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  if (!words || word_count < kMinGeneralWords || word_count > kMaxGeneralWords ||
      !out_text || !out_text_len || !out_linemap || !out_linemap_count) {
    return HEX_ERR_UNSUPPORTED;
  }
  // In JS-parity mode, tiny 2-word `op; ret` stubs not matched by simple/IR emitters
  // fall back to JS to preserve 0-diff parity (e.g. mov x0, x1; ret / add x0, x0, x9; ret).
  if ((emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u &&
      word_count == 2u && words[1] == 0xD65F03C0u) {
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
  const size_t work_entry_mark = work_arena.used();
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

  // Pass 0b: Resolve internal ARM64 jump tables (Patterns A/B/C) and mark all case/default targets as labels.
  JumpTableInfo* jts = work_arena.alloc<JumpTableInfo>(kMaxJumpTables);
  if (!jts) return HEX_ERR_OOM;
  const uint32_t jt_count =
      scan_arm64_jumptables(words, word_count, base_addr, is_label, has_back_edge, work_arena, jts, kMaxJumpTables);
  ctx.jts = jts;
  ctx.jt_count = jt_count;

  // Pass 1: Collect register usage, globals, callees, types, and live argument masks for BLR/indirect BR.
  uint8_t* raw_arg_mask = work_arena.alloc<uint8_t>(word_count);
  uint8_t* pre_call_flag = work_arena.alloc<uint8_t>(word_count);
  uint8_t* call_argc = work_arena.alloc<uint8_t>(word_count);
  if (!raw_arg_mask || !pre_call_flag || !call_argc) return HEX_ERR_OOM;
  __builtin_memset(raw_arg_mask, 0, word_count);
  __builtin_memset(pre_call_flag, 0, word_count);
  __builtin_memset(call_argc, 0, word_count);
  uint32_t running_arg_mask = 0u;
  bool seen_any_call = false;
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
    ctx.cur_insn_idx = i;
    ctx.gpr_written_insn = 0u;
    const uint32_t wi = words[i];
    const bool is_bl = ((wi & 0xFC000000u) == 0x94000000u);
    const bool is_blr = ((wi & 0xFFFFFC1Fu) == 0xD63F0000u || (wi & 0xFFFFF81Fu) == 0xD63F081Fu || (wi & 0xFFFFF800u) == 0xD73F0800u);
    const bool is_br = ((wi & 0xFFFFFC1Fu) == 0xD61F0000u || (wi & 0xFFFFF81Fu) == 0xD61F081Fu || (wi & 0xFFFFF800u) == 0xD71F0800u);
    if ((is_blr || is_br) && raw_arg_mask && pre_call_flag) {
      raw_arg_mask[i] = static_cast<uint8_t>(running_arg_mask & 0xFFu);
      pre_call_flag[i] = seen_any_call ? 0u : 1u;
    }
    const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    process_insn(wi, pc, base_addr, word_count, ctx, cmp, false, nullptr);
    if (is_bl || is_blr) {
      seen_any_call = true;
      running_arg_mask = 1u;  // x0 holds call return value; x1..x7 clobbered
    } else {
      running_arg_mask |= (ctx.gpr_written_insn & 0xFFu);
    }
  }
  if (ctx.table_overflow) return HEX_ERR_RESOURCE_LIMIT;
  if ((ctx.q_used & ctx.fp_used) != 0u) {
    ctx.uses_fp_bitcast = true;
    ctx.uses_uint32 = true;
    ctx.uses_uint64_t = true;
  }
  ctx.sort_tables();

  // Exact CFG backward liveness over basic blocks to prevent out-of-order loop bodies from creating phantom parameters
  // and to soundly fuse adjacent single-use cmp/cmn/tst/fcmp + b.cc/csel/fcsel/ccmp/fccmp pairs.
  uint32_t live_in_gpr0 = ctx.gpr_read_before_write & 0xFFu;
  uint32_t live_in_fp0 = ctx.fp_read_before_write & 0xFFu;
  uint8_t* fuse_cmp_dist = work_arena.alloc<uint8_t>(word_count);
  uint8_t* fuse_ccmp = work_arena.alloc<uint8_t>(word_count);
  uint32_t* blk_id = work_arena.alloc<uint32_t>(word_count);
  if (!fuse_cmp_dist || !fuse_ccmp || !blk_id) return HEX_ERR_OOM;
  __builtin_memset(fuse_cmp_dist, 0, word_count);
  __builtin_memset(fuse_ccmp, 0, word_count);
  {
    uint32_t num_blks = 0u;
    {
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
      uint8_t* b_use_nzcv = work_arena.alloc<uint8_t>(num_blks);
      uint8_t* b_def_nzcv = work_arena.alloc<uint8_t>(num_blks);
      uint8_t* b_in_nzcv = work_arena.alloc<uint8_t>(num_blks);
      int32_t* b_s0 = work_arena.alloc<int32_t>(num_blks);
      int32_t* b_s1 = work_arena.alloc<int32_t>(num_blks);
      AnalysisCtx* bctx_ptr = work_arena.alloc<AnalysisCtx>(1u);
      if (b_use_g && b_def_g && b_def_nc_g && b_use_f && b_def_f && b_in_g && b_in_f &&
          b_use_nzcv && b_def_nzcv && b_in_nzcv && b_s0 && b_s1 && bctx_ptr) {
        for (uint32_t b = 0u; b < num_blks; ++b) {
          b_use_g[b] = b_def_g[b] = b_def_nc_g[b] = b_use_f[b] = b_def_f[b] = b_in_g[b] = b_in_f[b] = 0u;
          b_use_nzcv[b] = b_def_nzcv[b] = b_in_nzcv[b] = 0u;
          b_s0[b] = b_s1[b] = -1;
        }
        uint32_t i = 0u;
        __builtin_memset(bctx_ptr, 0, sizeof(AnalysisCtx));
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
            if (insn_reads_nzcv(wi) && b_def_nzcv[b] == 0u) b_use_nzcv[b] = 1u;
            if (insn_writes_nzcv(wi)) b_def_nzcv[b] = 1u;
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
            uint8_t on = 0u;
            if (b_s0[b] >= 0) { og |= b_in_g[b_s0[b]]; of |= b_in_f[b_s0[b]]; on |= b_in_nzcv[b_s0[b]]; }
            if (b_s1[b] >= 0) { og |= b_in_g[b_s1[b]]; of |= b_in_f[b_s1[b]]; on |= b_in_nzcv[b_s1[b]]; }
            for (uint32_t j = 0u; j < jt_count; ++j) {
              if (!jts[j].resolved || blk_id[jts[j].br_idx] != static_cast<uint32_t>(b)) continue;
              for (uint32_t c = 0u; c < jts[j].case_count; ++c) {
                uint32_t tidx = 0u;
                if (is_internal_target(jts[j].case_targets[c], base_addr, word_count, &tidx)) {
                  const uint32_t tb_id = blk_id[tidx];
                  og |= b_in_g[tb_id]; of |= b_in_f[tb_id]; on |= b_in_nzcv[tb_id];
                }
              }
              if (jts[j].has_default_target) {
                uint32_t didx = 0u;
                if (is_internal_target(jts[j].default_target, base_addr, word_count, &didx)) {
                  const uint32_t db_id = blk_id[didx];
                  og |= b_in_g[db_id]; of |= b_in_f[db_id]; on |= b_in_nzcv[db_id];
                }
              }
            }
            const uint32_t ng = b_use_g[b] | (og & ~b_def_g[b]);
            const uint32_t nf = b_use_f[b] | (of & ~b_def_f[b]);
            const uint8_t nn = static_cast<uint8_t>(b_use_nzcv[b] | (on & static_cast<uint8_t>(~b_def_nzcv[b])));
            if (ng != b_in_g[b] || nf != b_in_f[b] || nn != b_in_nzcv[b]) {
              b_in_g[b] = ng;
              b_in_f[b] = nf;
              b_in_nzcv[b] = nn;
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

        // Compute conservative single-use fuse_cmp_dist[i] (A1: CMP/CMN/TST/FCMP gap 1..8,
        // A2: SUBS/ADDS rd<31 Z/N-flag gap 1..6) and fuse_ccmp[i] (A3: CCMP/CCMN + adjacent consumer)
        // using exact CFG NZCV liveness.
        if (fuse_cmp_dist) {
          auto nzcv_live_after = [&](uint32_t k) -> bool {
            if (insn_writes_nzcv(words[k])) return false;
            const uint32_t b = blk_id[k];
            for (uint32_t j = k + 1u; j < word_count && blk_id[j] == b; ++j) {
              if (insn_reads_nzcv(words[j])) return true;
              if (insn_writes_nzcv(words[j])) return false;
            }
            if (b_s0[b] >= 0 && b_in_nzcv[b_s0[b]] != 0u) return true;
            if (b_s1[b] >= 0 && b_in_nzcv[b_s1[b]] != 0u) return true;
            return false;
          };
          for (uint32_t idx = 0u; idx + 1u < word_count; ++idx) {
            CmpState fcmp{};
            bool is_addsub_zn = false;
            if (!try_decode_fusable_cmp(words[idx], &fcmp)) {
              if (try_decode_fusable_addsub(words[idx], &fcmp, &is_addsub_zn)) {
                // is_addsub_zn is false when imm==0 or rd!=rn (full condition fusion)
              } else {
                // A3: CCMP/CCMN + adjacent single-use consumer (B.cc / CSET / CSEL / FCSEL)
                if (fuse_ccmp && is_label[idx + 1u] == 0u) {
                  CmpState inner_cmp{};
                  uint32_t outer_cond = 0u;
                  uint32_t nzcv_imm = 0u;
                  if (try_decode_ccmp(words[idx], &inner_cmp, &outer_cond, &nzcv_imm)) {
                    uint32_t consumer_cond = 0u;
                    const uint64_t next_pc = base_addr + static_cast<uint64_t>(idx + 1u) * 4ULL;
                    if (try_get_ccmp_consumer_cond(words[idx + 1u], next_pc, base_addr, word_count, &consumer_cond) &&
                        cond_fusable_for_cmp(inner_cmp, consumer_cond) &&
                        !nzcv_live_after(idx + 1u)) {
                      fuse_ccmp[idx] = 1u;
                    }
                  }
                }
                continue;
              }
            }
            const uint32_t max_k = is_addsub_zn ? 6u : 8u;
            for (uint32_t k = 1u; k <= max_k && idx + k < word_count; ++k) {
              if (is_label[idx + k] != 0u) break;
              const uint32_t wk = words[idx + k];
              const uint64_t pc_k = base_addr + static_cast<uint64_t>(idx + k) * 4ULL;
              uint32_t cond = 0u;
              if (try_get_fusable_consumer_cond(wk, pc_k, base_addr, word_count, &cond)) {
                const uint32_t cc = cond & 0xFu;
                const bool cond_ok = is_addsub_zn
                    ? (cc == 0x0u || cc == 0x1u || cc == 0x4u || cc == 0x5u)
                    : cond_fusable_for_cmp(fcmp, cond);
                if (cond_ok && !nzcv_live_after(idx + k)) {
                  fuse_cmp_dist[idx] = static_cast<uint8_t>(k);
                  if (!fcmp.is_fp) {
                    const bool need_signed = (cc == 0x4u || cc == 0x5u || cc == 0xAu || cc == 0xBu || cc == 0xCu || cc == 0xDu);
                    if (fcmp.is32) {
                      ctx.uses_uint32 = true;
                      if (need_signed) ctx.uses_int32 = true;
                    } else {
                      ctx.uses_uint64_t = true;
                      if (need_signed) ctx.uses_int64_t = true;
                    }
                  }
                }
                break;
              }
              if (is_control_flow_or_call(wk) || insn_reads_nzcv(wk) || insn_writes_nzcv(wk)) break;
              __builtin_memset(bctx_ptr, 0, offsetof(AnalysisCtx, globals));
              bctx_ptr->global_count = 0u;
              bctx_ptr->callee_count = 0u;
              CmpState scmp{};
              process_insn(wk, pc_k, base_addr, word_count, *bctx_ptr, scmp, false, nullptr);
              if (fcmp.is_fp) {
                const uint32_t fp_mod = bctx_ptr->fp_written | bctx_ptr->q_used;
                if ((fp_mod & (1u << fcmp.lhs_reg)) != 0u) break;
                if (!fcmp.is_imm && (fp_mod & (1u << fcmp.rhs_reg)) != 0u) break;
              } else {
                if (fcmp.lhs_is_sp) {
                  if (bctx_ptr->uses_sp) break;
                } else if (fcmp.lhs_reg < 31u && (bctx_ptr->gpr_written_insn & (1u << fcmp.lhs_reg)) != 0u) {
                  break;
                }
                if (!fcmp.is_imm && fcmp.rhs_reg < 31u && (bctx_ptr->gpr_written_insn & (1u << fcmp.rhs_reg)) != 0u) {
                  break;
                }
              }
            }
          }
        }
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

  // Finalize live argument counts for BLR and indirect tail-call BR instructions.
  if (call_argc && raw_arg_mask && pre_call_flag) {
    const uint32_t param_mask = (int_param_count > 0u) ? ((1u << int_param_count) - 1u) : 0u;
    for (uint32_t i = 0u; i < word_count; ++i) {
      const uint32_t wi = words[i];
      const bool is_blr = ((wi & 0xFFFFFC1Fu) == 0xD63F0000u || (wi & 0xFFFFF81Fu) == 0xD63F081Fu || (wi & 0xFFFFF800u) == 0xD73F0800u);
      const JumpTableInfo* jt = find_jump_table(ctx, i);
      const bool is_ind_tail = (jt && !jt->resolved && jt->is_indirect_tail);
      if (!is_blr && !is_ind_tail) continue;
      uint32_t m = static_cast<uint32_t>(raw_arg_mask[i]);
      if (pre_call_flag[i] != 0u) m |= param_mask;
      uint8_t argc = 0u;
      for (uint32_t r = 0u; r < 8u; ++r) {
        if ((m & (1u << r)) != 0u) argc = static_cast<uint8_t>(r + 1u);
      }
      if (argc == 0u && is_blr && (int_param_count > 0u || (ctx.gpr_used & 1u) != 0u)) {
        argc = 1u;
      }
      call_argc[i] = argc;
      if (argc > 0u) ctx.gpr_used |= ((1u << argc) - 1u);
      ctx.uses_uintptr = true;
    }
    ctx.call_argc = call_argc;
  }

  // Analyze non-escaping [sp, #const] stack slots for local variable promotion.
  SpPromoState sp_promo{};
  analyze_sp_promotion(words, word_count, base_addr, jts, jt_count, ctx, work_arena, &sp_promo);
  ctx.sp_promo = sp_promo.active ? &sp_promo : nullptr;

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
        "#ifndef __HEX_UNUSED\n"
        "#if defined(__GNUC__) || defined(__clang__)\n"
        "#define __HEX_UNUSED __attribute__((unused))\n"
        "#else\n"
        "#define __HEX_UNUSED\n"
        "#endif\n"
        "#endif\n"
        "static inline __HEX_UNUSED float __hex_u32_to_f32(uint32_t u) { union { uint32_t i; float f; } v; v.i = u; return v.f; }\n"
        "static inline __HEX_UNUSED double __hex_u64_to_f64(uint64_t u) { union { uint64_t i; double d; } v; v.i = u; return v.d; }\n"
        "static inline __HEX_UNUSED uint32_t __hex_f32_to_u32(float f) { union { uint32_t i; float f; } v; v.f = f; return v.i; }\n"
        "static inline __HEX_UNUSED uint64_t __hex_f64_to_u64(double d) { union { uint64_t i; double d; } v; v.d = d; return v.i; }\n");
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

  // Snapshot local declaration flags on stack before work_arena.restore() can reuse ctx storage.
  const bool orig_uses_nzcv = ctx.uses_nzcv;
  const bool orig_uses_sw_idx = ctx.uses_sw_idx;
  const bool orig_uses_sp = ctx.uses_sp;
  const uint32_t orig_gpr_used = ctx.gpr_used;
  const uint32_t orig_fp_used = ctx.fp_used;
  const uint32_t orig_q_used = ctx.q_used;

  // Local declarations (grouped zero-init scratch x8..x30, 4 per line).
  auto emit_local_decls = [&](TextBuf& dst, bool emit_nzcv, uint32_t gpr_mask, uint32_t fp_mask, uint32_t q_mask) {
    if (emit_nzcv) {
      dst.put_str("    uint32_t __hex_nzcv = 0;\n");
    }
    if (orig_uses_sw_idx) {
      dst.put_str("    uint64_t __hex_sw_idx = 0;\n");
    }
    if (orig_uses_sp) {
      dst.put_str("    uint8_t __hex_stack_frame[4096] = {0};\n");
      dst.put_str("    uint64 sp = (uintptr_t)(__hex_stack_frame + sizeof(__hex_stack_frame));\n");
    }
    if (sp_promo.active) {
      for (uint32_t s = 0u; s < sp_promo.slot_count; ++s) {
        if (sp_promo.slots[s].conflicted) continue;
        if (sp_promo.slots[s].is_fp) {
          dst.put_str(sp_promo.slots[s].width == 4u ? "    float " : "    double ");
          emit_local_sp_name(dst, sp_promo.slots[s].slot_id);
          dst.put_str(sp_promo.slots[s].width == 4u ? " = 0.0f;\n" : " = 0.0;\n");
        } else {
          if (sp_promo.slots[s].width == 1u) dst.put_str("    uint8_t ");
          else if (sp_promo.slots[s].width == 2u) dst.put_str("    uint16_t ");
          else if (sp_promo.slots[s].width == 4u) dst.put_str("    uint32_t ");
          else dst.put_str("    uint64 ");
          emit_local_sp_name(dst, sp_promo.slots[s].slot_id);
          dst.put_str(" = 0;\n");
        }
      }
    }
    for (uint32_t r = 0u; r < 8u; ++r) {
      if ((gpr_mask & (1u << r)) != 0u) {
        dst.put_str("    uint64 x");
        dst.put_u64_dec(r);
        if (r < int_param_count) {
          dst.put_str(" = a");
          dst.put_u64_dec(r + 1u);
        } else {
          dst.put_str(" = 0");
        }
        dst.put_str(";\n");
      }
    }
    uint32_t grp = 0u;
    for (uint32_t r = 8u; r < 31u; ++r) {
      if ((gpr_mask & (1u << r)) != 0u) {
        if (grp == 0u) dst.put_str("    uint64 x");
        else dst.put_str(", x");
        dst.put_u64_dec(r);
        dst.put_str(" = 0");
        if (++grp == 4u) {
          dst.put_str(";\n");
          grp = 0u;
        }
      }
    }
    if (grp > 0u) dst.put_str(";\n");
    for (uint32_t r = 0u; r < 32u; ++r) {
      if ((fp_mask & (1u << r)) != 0u) {
        dst.put_str("    double d");
        dst.put_u64_dec(r);
        if (r < fp_param_count) {
          dst.put_str(" = fa");
          dst.put_u64_dec(r + 1u);
        } else {
          dst.put_str(" = 0.0");
        }
        dst.put_str(";\n");
      }
    }
    for (uint32_t r = 0u; r < 32u; ++r) {
      if ((q_mask & (1u << r)) != 0u) {
        dst.put_str("    uint128 q");
        dst.put_u64_dec(r);
        dst.put_str(" = 0;\n");
      }
    }
  };
  const uint32_t decls_start_off = tb.len;
  const uint32_t decls_start_line = tb.line_no;
  emit_local_decls(tb, ctx.uses_nzcv, ctx.gpr_used, ctx.fp_used, ctx.q_used);

  // Pass 2: Emit C body statements.
  const uint32_t body_start_off = tb.len;
  const uint32_t body_start_line = tb.line_no;
  for (uint32_t r = 0u; r < 31u; ++r) { ctx.adrp_valid[r] = false; ctx.saved_adrp_valid[r] = false; ctx.adrp_consumed[r] = false; }
  cmp = ctx.uses_nzcv ? make_nzcv_cmp(false) : CmpState{};
  CmpState pending_cmp{};
  CmpState ccmp_outer_storage{};
  uint32_t pending_consumer = 0u;
  bool has_pending_cmp = false;
  bool pending_label = false;
  for (uint32_t i = 0u; i < word_count; ++i) {
    const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    if (is_label[i] != 0u) {
      has_pending_cmp = false;
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
    bool consumed_pending = false;
    if (has_pending_cmp && i == pending_consumer) {
      cmp = pending_cmp;
      has_pending_cmp = false;
      consumed_pending = true;
    }
    if (fuse_ccmp && fuse_ccmp[i] != 0u && i + 1u < word_count) {
      CmpState inner_cmp{};
      uint32_t outer_cond = 0u;
      uint32_t nzcv_imm = 0u;
      uint32_t consumer_cond = 0u;
      const uint64_t next_pc = base_addr + static_cast<uint64_t>(i + 1u) * 4ULL;
      if (try_decode_ccmp(words[i], &inner_cmp, &outer_cond, &nzcv_imm) &&
          try_get_ccmp_consumer_cond(words[i + 1u], next_pc, base_addr, word_count, &consumer_cond)) {
        ccmp_outer_storage = cmp;
        inner_cmp.is_ccmp = true;
        inner_cmp.ccmp_else_val = eval_nzcv_imm(nzcv_imm, consumer_cond);
        inner_cmp.ccmp_outer_cond = outer_cond;
        inner_cmp.ccmp_outer = &ccmp_outer_storage;
        pending_cmp = inner_cmp;
        pending_consumer = i + 1u;
        has_pending_cmp = true;
        cmp = ctx.uses_nzcv ? make_nzcv_cmp(false) : CmpState{};
        continue;
      }
    }
    if (fuse_cmp_dist && fuse_cmp_dist[i] != 0u) {
      CmpState fcmp{};
      if (try_decode_fusable_cmp(words[i], &fcmp)) {
        pending_cmp = fcmp;
        pending_consumer = i + static_cast<uint32_t>(fuse_cmp_dist[i]);
        has_pending_cmp = true;
        continue;
      }
      bool addsub_zn_only = false;
      if (try_decode_fusable_addsub(words[i], &fcmp, &addsub_zn_only)) {
        const uint32_t before_len = tb.len;
        emit_fused_addsub_clean(words[i], pc, ctx, tb);
        if (tb.len > before_len) pending_label = false;
        pending_cmp = fcmp;
        pending_consumer = i + static_cast<uint32_t>(fuse_cmp_dist[i]);
        has_pending_cmp = true;
        if (tb.overflow) return HEX_ERR_OOM;
        continue;
      }
    }
    // Strict magic constant division recovery (32/64-bit signed/unsigned, with exact verification).
    {
      uint32_t magic_last = i;
      if (try_emit_magic_div_seq(words, word_count, i, base_addr, is_label,
                                 has_pending_cmp, pending_consumer, ctx, tb, &magic_last)) {
        pending_label = false;
        if (consumed_pending) {
          cmp = ctx.uses_nzcv ? make_nzcv_cmp(false) : CmpState{};
        }
        if (tb.overflow) return HEX_ERR_OOM;
        i = magic_last;
        continue;
      }
    }
    // Fold adjacent MOVZ/MOVN + MOVK sequence targeting the same register and width.
    {
      const uint32_t w = words[i];
      const uint32_t opc = (w >> 29u) & 3u;
      if ((w & 0x1F800000u) == 0x12800000u && (opc == 0u || opc == 2u)) {
        const uint32_t rd = w & 31u;
        const bool is64 = ((w >> 31u) & 1u) != 0u;
        const uint32_t hw = (w >> 21u) & 3u;
        if (rd < 31u && (is64 || hw < 2u)) {
          const uint64_t imm16 = static_cast<uint64_t>((w >> 5u) & 0xFFFFu);
          uint64_t val = imm16 << (hw * 16u);
          if (opc == 0u) val = ~val;
          if (!is64) val &= 0xFFFFFFFFULL;
          uint32_t j = i + 1u;
          while (j < word_count && is_label[j] == 0u && (!has_pending_cmp || j != pending_consumer)) {
            const uint32_t wj = words[j];
            if ((wj & 0x1F800000u) != 0x12800000u || ((wj >> 29u) & 3u) != 3u) break;
            if ((wj & 31u) != rd) break;
            if ((((wj >> 31u) & 1u) != 0u) != is64) break;
            const uint32_t hw_j = (wj >> 21u) & 3u;
            if (!is64 && hw_j >= 2u) break;
            const uint64_t imm16_j = static_cast<uint64_t>((wj >> 5u) & 0xFFFFu);
            const uint32_t shift_j = hw_j * 16u;
            val = (val & ~(0xFFFFULL << shift_j)) | (imm16_j << shift_j);
            if (!is64) val &= 0xFFFFFFFFULL;
            ++j;
          }
          if (j > i + 1u) {
            tb.record_line(pc);
            tb.put_str("    ");
            tb.put_reg_x(rd);
            tb.put_str(" = ");
            tb.put_imm(val);
            tb.put_str(";\n");
            ctx.clear_adrp(rd);
            pending_label = false;
            if (consumed_pending) {
              cmp = ctx.uses_nzcv ? make_nzcv_cmp(false) : CmpState{};
            }
            if (tb.overflow) return HEX_ERR_OOM;
            i = j - 1u;
            continue;
          }
        }
      }
    }
    const uint32_t before_len = tb.len;
    if (ctx.jts) {
      for (uint32_t j = 0u; j < ctx.jt_count; ++j) {
        if (ctx.jts[j].resolved && ctx.jts[j].index_clobbered && ctx.jts[j].load_idx == i && ctx.jts[j].index_reg < 31u) {
          tb.put_str("    __hex_sw_idx = ");
          tb.put_str(ctx.jts[j].index_is32 ? "(uint64_t)(uint32_t)" : "(uint64_t)");
          tb.put_reg_x(ctx.jts[j].index_reg);
          tb.put_str(";\n");
          pending_label = false;
          break;
        }
      }
    }
    ctx.cur_insn_idx = i;
    process_insn(words[i], pc, base_addr, word_count, ctx, cmp, true, &tb);
    if (tb.len > before_len) pending_label = false;
    if (consumed_pending) {
      cmp = ctx.uses_nzcv ? make_nzcv_cmp(false) : CmpState{};
    }
    if (tb.overflow) return HEX_ERR_OOM;
  }
  if (pending_label) {
    tb.put_str("    (void)0;\n");
  }

  const char* fallback_ret = nullptr;
  if (ctx.returns_float) {
    fallback_ret = ((ctx.fp_used & 1u) != 0u) ? "    return (float)d0;\n" : "    return 0.0f;\n";
  } else if (ctx.returns_double) {
    fallback_ret = ((ctx.fp_used & 1u) != 0u) ? "    return d0;\n" : "    return 0.0;\n";
  } else if (ctx.returns_int32) {
    fallback_ret = ((ctx.gpr_used & 1u) != 0u) ? "    return (int32_t)x0;\n" : "    return 0;\n";
  } else if (ctx.returns_value) {
    fallback_ret = ((ctx.gpr_used & 1u) != 0u) ? "    return x0;\n" : "    return 0;\n";
  }
  if (&work_arena != &emit_arena) {
    work_arena.restore(work_entry_mark);
  }
  structurize_c_body(tb, body_start_off, body_start_line, base_addr, fallback_ret, work_arena, emit_arena);
  simplify_idempotent_casts_in_body(tb, body_start_off);
  fold_single_use_scratch_temps(tb, body_start_off, body_start_line, work_arena);

  // Post-structurize dead-local pruning: omit __hex_nzcv and unused zero-init scratch xN/dN.
  if (!tb.overflow && body_start_off < tb.len) {
    auto is_id_ch = [](char ch) -> bool {
      return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_';
    };
    bool body_uses_nzcv = false;
    uint32_t body_gpr_used = 0u;
    uint32_t body_fp_used = 0u;
    const char* bp = tb.data;
    const uint32_t blen = tb.len;
    for (uint32_t p = body_start_off; p < blen; ++p) {
      const char c = bp[p];
      if (!is_id_ch(c)) continue;
      if (p > body_start_off && is_id_ch(bp[p - 1u])) continue;
      if (c == '_' && p + 10u <= blen &&
          starts_with(bp + p, 10u, "__hex_nzcv", 10u) &&
          (p + 10u == blen || !is_id_ch(bp[p + 10u]))) {
        body_uses_nzcv = true;
      } else if ((c == 'x' || c == 'd') && p + 1u < blen && bp[p + 1u] >= '0' && bp[p + 1u] <= '9') {
        uint32_t reg = static_cast<uint32_t>(bp[p + 1u] - '0');
        uint32_t q = p + 2u;
        if (q < blen && bp[q] >= '0' && bp[q] <= '9') {
          reg = reg * 10u + static_cast<uint32_t>(bp[q] - '0');
          ++q;
        }
        if (q == blen || !is_id_ch(bp[q])) {
          if (c == 'x' && reg < 31u) body_gpr_used |= (1u << reg);
          else if (c == 'd' && reg < 32u) body_fp_used |= (1u << reg);
        }
      }
    }
    const bool keep_nzcv = orig_uses_nzcv && body_uses_nzcv;
    const uint32_t param_gpr_mask = (int_param_count > 0u) ? ((1u << int_param_count) - 1u) : 0u;
    const uint32_t param_fp_mask = (fp_param_count > 0u) ? ((1u << fp_param_count) - 1u) : 0u;
    const uint32_t keep_gpr = orig_gpr_used & (body_gpr_used | param_gpr_mask);
    const uint32_t keep_fp = orig_fp_used & (body_fp_used | param_fp_mask);
    if (keep_nzcv != orig_uses_nzcv || keep_gpr != orig_gpr_used || keep_fp != orig_fp_used) {
      char decl_buf[4096];
      TextBuf decl_tb{decl_buf, sizeof(decl_buf), 0u, 1u, false, nullptr, 0u, 0u};
      emit_local_decls(decl_tb, keep_nzcv, keep_gpr, keep_fp, orig_q_used);
      const uint32_t old_decl_len = body_start_off - decls_start_off;
      const uint32_t old_decl_lines = body_start_line - decls_start_line;
      const uint32_t new_decl_lines = decl_tb.line_no - 1u;
      if (!decl_tb.overflow && decl_tb.len <= old_decl_len && new_decl_lines <= old_decl_lines) {
        const uint32_t removed_bytes = old_decl_len - decl_tb.len;
        const uint32_t delta_lines = old_decl_lines - new_decl_lines;
        if (decl_tb.len > 0u) {
          hex::mem_copy(tb.data + decls_start_off, decl_tb.data, decl_tb.len);
        }
        if (removed_bytes > 0u) {
          const uint32_t tail_len = tb.len - body_start_off;
          char* dst_tail = tb.data + decls_start_off + decl_tb.len;
          const char* src_tail = tb.data + body_start_off;
          for (uint32_t k = 0u; k < tail_len; ++k) dst_tail[k] = src_tail[k];
          tb.len -= removed_bytes;
          tb.data[tb.len] = '\0';
        }
        if (delta_lines > 0u) {
          tb.line_no -= delta_lines;
          for (uint32_t k = 0u; k < tb.lm_count; ++k) {
            if (tb.lm[k].line_no >= body_start_line) tb.lm[k].line_no -= delta_lines;
          }
        }
      }
    }
  }
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
