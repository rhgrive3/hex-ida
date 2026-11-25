#include "decompiler/passes/arm64_call_emit.hpp"

namespace {

constexpr uint32_t kMaxCallWords = 64u;
constexpr uint32_t kMaxTextBytes = 8192u;
constexpr uint32_t kMaxLineMapEntries = 64u;

constexpr uint32_t masked(uint32_t w, uint32_t mask) { return w & mask; }
constexpr uint8_t reg_rd(uint32_t w) { return static_cast<uint8_t>(w & 0x1fu); }
constexpr uint8_t reg_rn(uint32_t w) { return static_cast<uint8_t>((w >> 5) & 0x1fu); }
constexpr uint8_t reg_rm(uint32_t w) { return static_cast<uint8_t>((w >> 16) & 0x1fu); }
constexpr uint8_t reg_rt2(uint32_t w) { return static_cast<uint8_t>((w >> 10) & 0x1fu); }

constexpr int64_t sign_extend(uint32_t val, uint32_t bits) {
  const uint64_t mask = (1ULL << bits) - 1ULL;
  const uint64_t sign = 1ULL << (bits - 1u);
  const uint64_t v = static_cast<uint64_t>(val) & mask;
  return static_cast<int64_t>((v ^ sign) - sign);
}

// ── ARM64 instruction matchers (UB-free, freestanding) ───────────────────────

constexpr bool is_nop(uint32_t w) { return w == 0xd503201fu; }
constexpr bool is_ret_canon(uint32_t w) { return w == 0xd65f03c0u; }
constexpr bool is_mov_fp_sp(uint32_t w) { return w == 0x910003fdu; }  // add x29, sp, #0

// `stp x29, x30, [sp, #-N]!` (64-bit pre-indexed store pair, negative imm7)
bool match_stp_fp_lr_pre(uint32_t w, uint32_t* out_frame_bytes) {
  if (masked(w, 0xffc00000u) != 0xa9800000u) return false;
  if (reg_rd(w) != 29u || reg_rt2(w) != 30u || reg_rn(w) != 31u) return false;
  const int64_t imm7 = sign_extend((w >> 15) & 0x7fu, 7u);
  if (imm7 >= 0) return false;
  const int64_t bytes = -imm7 * 8LL;
  if (bytes <= 0 || bytes > 512LL) return false;
  if (out_frame_bytes) *out_frame_bytes = static_cast<uint32_t>(bytes);
  return true;
}

// `ldp x29, x30, [sp], #N` (64-bit post-indexed load pair, positive imm7)
bool match_ldp_fp_lr_post(uint32_t w, uint32_t* out_frame_bytes) {
  if (masked(w, 0xffc00000u) != 0xa8c00000u) return false;
  if (reg_rd(w) != 29u || reg_rt2(w) != 30u || reg_rn(w) != 31u) return false;
  const int64_t imm7 = sign_extend((w >> 15) & 0x7fu, 7u);
  if (imm7 <= 0) return false;
  const int64_t bytes = imm7 * 8LL;
  if (bytes <= 0 || bytes > 512LL) return false;
  if (out_frame_bytes) *out_frame_bytes = static_cast<uint32_t>(bytes);
  return true;
}

// `movz xd/wd, #imm16, lsl #(hw*16)`
bool match_movz(uint32_t w, bool* out_is64, uint8_t* out_rd, uint64_t* out_imm) {
  if (masked(w, 0x7f800000u) != 0x52800000u) return false;
  const bool is64 = ((w >> 31) & 1u) != 0u;
  const uint32_t hw = (w >> 21) & 3u;
  if (!is64 && hw >= 2u) return false;
  const uint8_t rd = reg_rd(w);
  if (rd >= 31u) return false;
  const uint64_t imm16 = static_cast<uint64_t>((w >> 5) & 0xffffu);
  if (out_is64) *out_is64 = is64;
  if (out_rd) *out_rd = rd;
  if (out_imm) *out_imm = imm16 << (hw * 16u);
  return true;
}

// `mov xd, xm` / `mov wd, wm` (`orr xd, xzr, xm`)
bool match_mov_reg(uint32_t w, bool* out_is64, uint8_t* out_rd, uint8_t* out_rm) {
  if (masked(w, 0x7fe0ffe0u) != 0x2a0003e0u) return false;
  const uint8_t rd = reg_rd(w);
  const uint8_t rm = reg_rm(w);
  if (rd >= 31u || rm >= 31u) return false;
  if (out_is64) *out_is64 = ((w >> 31) & 1u) != 0u;
  if (out_rd) *out_rd = rd;
  if (out_rm) *out_rm = rm;
  return true;
}

// `adrp xd, #page`
bool match_adrp(uint32_t w, uint64_t pc, uint8_t* out_rd, uint64_t* out_page) {
  if (masked(w, 0x9f000000u) != 0x90000000u) return false;
  const uint8_t rd = reg_rd(w);
  if (rd >= 31u) return false;
  const uint32_t raw_imm = (((w >> 5) & 0x7ffffu) << 2) | ((w >> 29) & 3u);
  const int64_t imm = sign_extend(raw_imm, 21u);
  if (out_rd) *out_rd = rd;
  if (out_page) *out_page = (pc & ~0xfffULL) + (static_cast<uint64_t>(imm) << 12);
  return true;
}

// `add xd/wd, xn/wn, #imm` (S=0, sh[1]=0)
bool match_add_imm(uint32_t w, bool* out_is64, uint8_t* out_rd, uint8_t* out_rn, uint64_t* out_imm) {
  if (masked(w, 0x7f800000u) != 0x11000000u) return false;
  const uint8_t rd = reg_rd(w);
  const uint8_t rn = reg_rn(w);
  if (rd >= 31u || rn >= 31u) return false;
  const uint32_t shift = ((w >> 22) & 1u) ? 12u : 0u;
  const uint64_t imm = static_cast<uint64_t>((w >> 10) & 0xfffu) << shift;
  if (out_is64) *out_is64 = ((w >> 31) & 1u) != 0u;
  if (out_rd) *out_rd = rd;
  if (out_rn) *out_rn = rn;
  if (out_imm) *out_imm = imm;
  return true;
}

// `add xd, xn, xm` (64-bit shifted register, shift=0, imm6=0, S=0)
bool match_add_reg64(uint32_t w, uint8_t* out_rd, uint8_t* out_rn, uint8_t* out_rm) {
  if (masked(w, 0xffe0fc00u) != 0x8b000000u) return false;
  const uint8_t rd = reg_rd(w);
  const uint8_t rn = reg_rn(w);
  const uint8_t rm = reg_rm(w);
  if (rd >= 31u || rn >= 31u || rm >= 31u) return false;
  if (out_rd) *out_rd = rd;
  if (out_rn) *out_rn = rn;
  if (out_rm) *out_rm = rm;
  return true;
}

// `and xd, xn, #bitmask` (64-bit contiguous low-bit mask: sf=1, opc=0, N=1, immr=0, imms < 63)
bool match_and_lowmask64(uint32_t w, uint8_t* out_rd, uint8_t* out_rn, uint64_t* out_mask) {
  if (masked(w, 0xffc00000u) != 0x92400000u) return false;
  const uint32_t immr = (w >> 16) & 0x3fu;
  const uint32_t imms = (w >> 10) & 0x3fu;
  if (immr != 0u || imms >= 63u) return false;
  const uint8_t rd = reg_rd(w);
  const uint8_t rn = reg_rn(w);
  if (rd >= 31u || rn >= 31u) return false;
  if (out_rd) *out_rd = rd;
  if (out_rn) *out_rn = rn;
  if (out_mask) *out_mask = (1ULL << (imms + 1u)) - 1ULL;
  return true;
}

// `lsl xd, xn, #shift` (64-bit UBFM alias: sf=1, opc=2, N=1, imms + 1 == immr, shift = 64 - immr)
bool match_lsl_imm64(uint32_t w, uint8_t* out_rd, uint8_t* out_rn, uint32_t* out_shift) {
  if (masked(w, 0xffc00000u) != 0xd3400000u) return false;
  const uint32_t immr = (w >> 16) & 0x3fu;
  const uint32_t imms = (w >> 10) & 0x3fu;
  if (immr == 0u || imms + 1u != immr) return false;
  const uint32_t shift = 64u - immr;
  if (shift == 0u || shift > 6u) return false;
  const uint8_t rd = reg_rd(w);
  const uint8_t rn = reg_rn(w);
  if (rd >= 31u || rn >= 31u) return false;
  if (out_rd) *out_rd = rd;
  if (out_rn) *out_rn = rn;
  if (out_shift) *out_shift = shift;
  return true;
}

// `ldr xt/wt, [xn, #off]` (unsigned offset, 32-bit or 64-bit)
bool match_ldr_uoff(uint32_t w, bool* out_is64, uint8_t* out_rt, uint8_t* out_rn, uint64_t* out_off) {
  const uint32_t top = masked(w, 0xffc00000u);
  bool is64 = false;
  if (top == 0xf9400000u) {
    is64 = true;
  } else if (top == 0xb9400000u) {
    is64 = false;
  } else {
    return false;
  }
  const uint8_t rt = reg_rd(w);
  if (rt >= 31u) return false;
  const uint64_t imm12 = static_cast<uint64_t>((w >> 10) & 0xfffu);
  if (out_is64) *out_is64 = is64;
  if (out_rt) *out_rt = rt;
  if (out_rn) *out_rn = reg_rn(w);
  if (out_off) *out_off = imm12 * (is64 ? 8ULL : 4ULL);
  return true;
}

// `str xt/wt, [xn, #off]` (unsigned offset, 32-bit or 64-bit)
bool match_str_uoff(uint32_t w, bool* out_is64, uint8_t* out_rt, uint8_t* out_rn, uint64_t* out_off) {
  const uint32_t top = masked(w, 0xffc00000u);
  bool is64 = false;
  if (top == 0xf9000000u) {
    is64 = true;
  } else if (top == 0xb9000000u) {
    is64 = false;
  } else {
    return false;
  }
  const uint8_t rt = reg_rd(w);
  if (rt >= 31u) return false;
  const uint64_t imm12 = static_cast<uint64_t>((w >> 10) & 0xfffu);
  if (out_is64) *out_is64 = is64;
  if (out_rt) *out_rt = rt;
  if (out_rn) *out_rn = reg_rn(w);
  if (out_off) *out_off = imm12 * (is64 ? 8ULL : 4ULL);
  return true;
}

// `bl #target`
bool match_bl(uint32_t w, uint64_t pc, uint64_t* out_target) {
  if (masked(w, 0xfc000000u) != 0x94000000u) return false;
  const int64_t delta = sign_extend(w & 0x03ffffffu, 26u) * 4LL;
  if (out_target) *out_target = pc + static_cast<uint64_t>(delta);
  return true;
}

// `blr xn`
bool match_blr(uint32_t w, uint8_t* out_rn) {
  if (masked(w, 0xfffffc1fu) != 0xd63f0000u) return false;
  const uint8_t rn = reg_rn(w);
  if (rn >= 31u) return false;
  if (out_rn) *out_rn = rn;
  return true;
}

// ── Freestanding arena text + linemap builder ────────────────────────────────

struct EmitBuf {
  char* data;
  uint32_t cap;
  uint32_t len;
  uint32_t cur_line;
  bool overflow;

  HexLineMapEntry* lm;
  uint32_t lm_cap;
  uint32_t lm_count;

  bool init(hex::Arena& arena) {
    const size_t mark = arena.used();
    data = arena.alloc<char>(kMaxTextBytes);
    lm = arena.alloc<HexLineMapEntry>(kMaxLineMapEntries);
    if (!data || !lm) {
      arena.restore(mark);
      return false;
    }
    cap = kMaxTextBytes;
    len = 0u;
    cur_line = 1u;
    overflow = false;
    lm_cap = kMaxLineMapEntries;
    lm_count = 0u;
    data[0] = '\0';
    return true;
  }

  void put_char(char c) {
    if (len + 1u >= cap) {
      overflow = true;
      return;
    }
    data[len++] = c;
    data[len] = '\0';
    if (c == '\n') ++cur_line;
  }

  void put_str(const char* s) {
    if (!s) return;
    while (*s != '\0') put_char(*s++);
  }

  void put_u64_dec(uint64_t v) {
    char tmp[24];
    uint32_t n = 0u;
    if (v == 0ULL) {
      put_char('0');
      return;
    }
    while (v > 0ULL && n < 24u) {
      tmp[n++] = static_cast<char>('0' + (v % 10ULL));
      v /= 10ULL;
    }
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_u64_hex_upper(uint64_t v) {
    static constexpr char kHex[] = "0123456789ABCDEF";
    char tmp[16];
    uint32_t n = 0u;
    if (v == 0ULL) {
      put_char('0');
      return;
    }
    while (v > 0ULL && n < 16u) {
      tmp[n++] = kHex[v & 0xfULL];
      v >>= 4;
    }
    while (n > 0u) put_char(tmp[--n]);
  }

  // Matches JS decompile-base.js: decimal for < 100, uppercase 0x... for >= 100.
  void put_js_imm(uint64_t v) {
    if (v < 100ULL) {
      put_u64_dec(v);
    } else {
      put_str("0x");
      put_u64_hex_upper(v);
    }
  }

  // Matches JS safeIdent(name, 'sub'): strip leading '_', replace non-ident chars with '_'.
  void put_sanitized_func_name(const char* name, uint32_t name_len, uint64_t base_addr) {
    if (!name || name_len == 0u) {
      put_str("sub_");
      put_u64_hex_upper(base_addr);
      return;
    }
    uint32_t start = 0u;
    while (start < name_len && name[start] == '_') ++start;
    if (start >= name_len) {
      put_str("sub_");
      put_u64_hex_upper(base_addr);
      return;
    }
    const char first = name[start];
    const bool first_alpha =
        (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z');
    if (!first_alpha) {
      put_str("sub_");
    }
    for (uint32_t i = start; i < name_len; ++i) {
      const char c = name[i];
      const bool ok =
          (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '_';
      put_char(ok ? c : '_');
    }
  }

  void record_line(uint64_t addr) {
    if (lm_count >= lm_cap || addr == 0ULL) return;
    for (uint32_t i = 0u; i < lm_count; ++i) {
      if (lm[i].line_no == cur_line && lm[i].addr == addr) return;
    }
    lm[lm_count].line_no = cur_line;
    lm[lm_count].block_id = 0u;
    lm[lm_count].addr = addr;
    ++lm_count;
  }
};

// ── Pattern 1: Dispatch-table indirect call (0-diff under JS_PARITY) ─────────
//
// Recognizes:
//   [0] stp x29, x30, [sp, #-N]!
//   [1] movz xBase, #table_addr
//   [2] and xIdx, x0, #mask
//   [3] lsl xIdx, xIdx, #shift
//   [4] add xBase, xBase, xIdx     (or add xBase, xIdx, xBase)
//   [5] ldr xTarget, [xBase]
//   [6] blr xTarget
//   [7] ldp x29, x30, [sp], #N
//   [8] ret
//   [9..word_count-1] 1+ trailing `nop`
HexStatus try_emit_dispatch_table(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name,
    uint32_t func_name_len,
    hex::Arena& emit_arena,
    const char** out_text,
    uint32_t* out_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  if (word_count < 10u) return HEX_ERR_UNSUPPORTED;

  uint32_t frame_pre = 0u;
  uint32_t frame_post = 0u;
  if (!match_stp_fp_lr_pre(words[0], &frame_pre)) return HEX_ERR_UNSUPPORTED;

  bool movz_64 = false;
  uint8_t base_reg = 31u;
  uint64_t table_addr = 0ULL;
  if (!match_movz(words[1], &movz_64, &base_reg, &table_addr) || !movz_64 || base_reg == 0u) {
    return HEX_ERR_UNSUPPORTED;
  }

  uint8_t idx_reg = 31u;
  uint8_t and_rn = 31u;
  uint64_t idx_mask = 0ULL;
  if (!match_and_lowmask64(words[2], &idx_reg, &and_rn, &idx_mask) ||
      and_rn != 0u || idx_reg == 0u || idx_reg == base_reg) {
    return HEX_ERR_UNSUPPORTED;
  }

  uint8_t lsl_rd = 31u;
  uint8_t lsl_rn = 31u;
  uint32_t lsl_shift = 0u;
  if (!match_lsl_imm64(words[3], &lsl_rd, &lsl_rn, &lsl_shift) ||
      lsl_rd != idx_reg || lsl_rn != idx_reg) {
    return HEX_ERR_UNSUPPORTED;
  }

  uint8_t add_rd = 31u;
  uint8_t add_rn = 31u;
  uint8_t add_rm = 31u;
  if (!match_add_reg64(words[4], &add_rd, &add_rn, &add_rm) || add_rd != base_reg) {
    return HEX_ERR_UNSUPPORTED;
  }
  const bool add_ops_ok =
      (add_rn == base_reg && add_rm == idx_reg) || (add_rn == idx_reg && add_rm == base_reg);
  if (!add_ops_ok) return HEX_ERR_UNSUPPORTED;

  bool ldr_64 = false;
  uint8_t target_reg = 31u;
  uint8_t ldr_rn = 31u;
  uint64_t ldr_off = 0ULL;
  if (!match_ldr_uoff(words[5], &ldr_64, &target_reg, &ldr_rn, &ldr_off) ||
      !ldr_64 || ldr_rn != base_reg || ldr_off != 0ULL || target_reg == 0u) {
    return HEX_ERR_UNSUPPORTED;
  }

  uint8_t blr_rn = 31u;
  if (!match_blr(words[6], &blr_rn) || blr_rn != target_reg) return HEX_ERR_UNSUPPORTED;

  if (!match_ldp_fp_lr_post(words[7], &frame_post) || frame_post != frame_pre) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (!is_ret_canon(words[8])) return HEX_ERR_UNSUPPORTED;

  // Require at least one trailing NOP (matches JS multi-block dispatch-table emitter path).
  for (uint32_t i = 9u; i < word_count; ++i) {
    if (!is_nop(words[i])) return HEX_ERR_UNSUPPORTED;
  }

  const size_t emit_mark = emit_arena.used();
  EmitBuf buf{};
  if (!buf.init(emit_arena)) return HEX_ERR_OOM;

  const uint64_t stride = 1ULL << lsl_shift;

  buf.put_str(
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "typedef __INT64_TYPE__ int64;\n"
      "typedef __UINTPTR_TYPE__ uintptr_t;\n"
      "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
      "#ifndef __HEX_ANY_ARGS\n"
      "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
      "#define __HEX_ANY_ARGS ...\n"
      "#else\n"
      "#define __HEX_ANY_ARGS\n"
      "#endif\n"
      "#endif\n");

  buf.record_line(base_addr);
  buf.put_str("void ");
  buf.put_sanitized_func_name(func_name, func_name_len, base_addr);
  buf.put_str("(int64 a1)\n"
              "{\n"
              "    uint64 x0;\n"
              "    // \xE2\x80\xA6 \xE3\x81\xBB\xE3\x81\x8B\xE3\x81\xAB 2 "
              "\xE5\x80\x8B\xE3\x81\xAE\xE7\xBD\xAE\xE3\x81\x8D\xE5\xA0\xB4"
              "\xEF\xBC\x88\xE9\x80\x80\xE9\x81\xBF\xE7\x94\xA8\xE3\x81\xAA\xE3\x81\xA9"
              "\xEF\xBC\x89\xE3\x81\x8C\xE3\x81\x82\xE3\x82\x8A\xE3\x81\xBE\xE3\x81\x99\n"
              "\n");

  buf.record_line(base_addr);
  buf.put_str("    x0 = a1;\n");

  buf.record_line(base_addr + 24ULL);  // blr instruction VA
  buf.put_str("    x0 = ((uint64 (*)(__HEX_ANY_ARGS))(uintptr_t)(*(uint64 *)((a1 & ");
  buf.put_js_imm(idx_mask);
  buf.put_str(") * ");
  buf.put_u64_dec(stride);
  buf.put_str(" + ");
  buf.put_js_imm(table_addr);
  buf.put_str(")))(a1);\n");

  buf.record_line(base_addr + 32ULL);  // ret instruction VA
  buf.put_str("    return;\n"
              "}");

  if (buf.overflow) { emit_arena.restore(emit_mark); return HEX_ERR_RESOURCE_LIMIT; }

  *out_text = buf.data;
  *out_len = buf.len;
  *out_linemap = buf.lm;
  *out_linemap_count = buf.lm_count;
  return HEX_OK;
}

// ── Pattern 2: Generic frame + single bl/blr call (non-JS-parity mode) ───────
//
// Under HEX_EMIT_FLAG_JS_PARITY, JS emits `call_<v.id>` where `v.id` is an
// internal JS SSA value counter that shifts unpredictably on immediate/VA edits,
// so this path fails closed under HEX_EMIT_FLAG_JS_PARITY and emits clean
// deterministic `call_0` C pseudocode under HEX_EMIT_FLAG_NONE.
HexStatus try_emit_standard_frame_call(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name,
    uint32_t func_name_len,
    uint32_t emit_flags,
    hex::Arena& emit_arena,
    const char** out_text,
    uint32_t* out_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  if ((emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (word_count < 5u) return HEX_ERR_UNSUPPORTED;

  uint32_t frame_pre = 0u;
  uint32_t frame_post = 0u;
  if (!match_stp_fp_lr_pre(words[0], &frame_pre)) return HEX_ERR_UNSUPPORTED;
  if (!is_mov_fp_sp(words[1])) return HEX_ERR_UNSUPPORTED;
  if (!match_ldp_fp_lr_post(words[word_count - 2u], &frame_post) || frame_post != frame_pre) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (!is_ret_canon(words[word_count - 1u])) return HEX_ERR_UNSUPPORTED;

  // Locate the single call instruction (`bl` or `blr`) inside [2 .. word_count - 3].
  uint32_t call_idx = kMaxCallWords;
  bool is_direct_call = false;
  uint64_t direct_target = 0ULL;
  uint8_t indirect_reg = 31u;

  for (uint32_t i = 2u; i + 2u < word_count; ++i) {
    const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    uint64_t target = 0ULL;
    uint8_t blr_r = 31u;
    if (match_bl(words[i], pc, &target)) {
      if (call_idx != kMaxCallWords) return HEX_ERR_UNSUPPORTED;  // multiple calls
      call_idx = i;
      is_direct_call = true;
      direct_target = target;
    } else if (match_blr(words[i], &blr_r)) {
      if (call_idx != kMaxCallWords) return HEX_ERR_UNSUPPORTED;
      call_idx = i;
      is_direct_call = false;
      indirect_reg = blr_r;
    }
  }
  if (call_idx == kMaxCallWords) return HEX_ERR_UNSUPPORTED;

  // Validate pre-call instructions and infer argument count / x0 origin.
  uint32_t defined_mask = 0u;
  uint32_t rbw_arg_mask = 0u;
  uint8_t x0_arg_origin = 0u;  // 0..7 if x0 holds an entry argument at call site, 31 otherwise
  bool x0_tracks_arg = true;

  auto record_read = [&](uint8_t r) -> bool {
    if (r == 31u) return true;  // SP/ZR handled by caller
    if ((defined_mask & (1u << r)) == 0u) {
      if (r >= 8u) return false;
      rbw_arg_mask |= (1u << r);
    }
    return true;
  };

  uint8_t reg_origin[31];
  for (uint8_t r = 0u; r < 31u; ++r) reg_origin[r] = (r < 8u) ? r : 31u;

  for (uint32_t i = 2u; i < call_idx; ++i) {
    const uint32_t w = words[i];
    const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    bool is64 = false;
    uint8_t rd = 31u, rn = 31u, rm = 31u;
    uint64_t imm = 0ULL;

    if (is_nop(w)) continue;
    if (match_movz(w, &is64, &rd, &imm)) {
      defined_mask |= (1u << rd);
      reg_origin[rd] = 31u;
      if (rd == 0u) x0_tracks_arg = false;
    } else if (match_mov_reg(w, &is64, &rd, &rm)) {
      if (!record_read(rm)) return HEX_ERR_UNSUPPORTED;
      defined_mask |= (1u << rd);
      reg_origin[rd] = reg_origin[rm];
      if (rd == 0u) {
        x0_tracks_arg = (reg_origin[rd] < 8u);
        x0_arg_origin = reg_origin[rd];
      }
    } else if (match_adrp(w, pc, &rd, &imm)) {
      defined_mask |= (1u << rd);
      reg_origin[rd] = 31u;
      if (rd == 0u) x0_tracks_arg = false;
    } else if (match_add_imm(w, &is64, &rd, &rn, &imm)) {
      if (!record_read(rn)) return HEX_ERR_UNSUPPORTED;
      defined_mask |= (1u << rd);
      reg_origin[rd] = 31u;
      if (rd == 0u) x0_tracks_arg = false;
    } else if (match_ldr_uoff(w, &is64, &rd, &rn, &imm)) {
      if (rn != 31u && !record_read(rn)) return HEX_ERR_UNSUPPORTED;
      defined_mask |= (1u << rd);
      reg_origin[rd] = 31u;
      if (rd == 0u) x0_tracks_arg = false;
    } else if (match_str_uoff(w, &is64, &rd, &rn, &imm)) {
      if (rn != 31u) return HEX_ERR_UNSUPPORTED;
      if (!record_read(rd)) return HEX_ERR_UNSUPPORTED;
    } else {
      return HEX_ERR_UNSUPPORTED;
    }
  }

  if (!is_direct_call) {
    if (!record_read(indirect_reg)) return HEX_ERR_UNSUPPORTED;
  }

  // Validate post-call instructions [call_idx + 1 .. word_count - 3]:
  // support empty, `add x0, x0, #imm`, or `str x0, [sp, #off]; ldr x0, [sp, #off]`.
  bool has_post_add = false;
  uint64_t post_add_imm = 0ULL;
  uint64_t post_add_va = 0ULL;
  const uint32_t post_count = (word_count - 2u) - (call_idx + 1u);

  if (post_count == 1u) {
    bool is64 = false;
    uint8_t rd = 31u, rn = 31u;
    uint64_t imm = 0ULL;
    const uint32_t pw = words[call_idx + 1u];
    if (match_add_imm(pw, &is64, &rd, &rn, &imm) && is64 && rd == 0u && rn == 0u && imm > 0ULL) {
      has_post_add = true;
      post_add_imm = imm;
      post_add_va = base_addr + static_cast<uint64_t>(call_idx + 1u) * 4ULL;
    } else if (!is_nop(pw)) {
      return HEX_ERR_UNSUPPORTED;
    }
  } else if (post_count == 2u) {
    bool s64 = false, l64 = false;
    uint8_t srt = 31u, srn = 31u, lrt = 31u, lrn = 31u;
    uint64_t soff = 0ULL, loff = 0ULL;
    if (!match_str_uoff(words[call_idx + 1u], &s64, &srt, &srn, &soff) ||
        !match_ldr_uoff(words[call_idx + 2u], &l64, &lrt, &lrn, &loff) ||
        !s64 || !l64 || srt != 0u || srn != 31u || lrt != 0u || lrn != 31u || soff != loff) {
      return HEX_ERR_UNSUPPORTED;
    }
  } else if (post_count > 2u) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Infer parameter count from highest read-before-write argument register (contiguous 1..N).
  uint32_t param_count = 0u;
  if (rbw_arg_mask != 0u) {
    uint32_t max_arg = 0u;
    for (uint32_t r = 0u; r < 8u; ++r) {
      if ((rbw_arg_mask & (1u << r)) != 0u) max_arg = r;
    }
    param_count = max_arg + 1u;
  }

  const size_t emit_mark = emit_arena.used();
  EmitBuf buf{};
  if (!buf.init(emit_arena)) return HEX_ERR_OOM;

  buf.put_str(
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
      "#ifndef __HEX_ANY_ARGS\n"
      "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
      "#define __HEX_ANY_ARGS ...\n"
      "#else\n"
      "#define __HEX_ANY_ARGS\n"
      "#endif\n"
      "#endif\n");

  if (is_direct_call) {
    buf.put_str("uint64 sub_");
    buf.put_u64_hex_upper(direct_target);
    buf.put_str(" (__HEX_ANY_ARGS);\n");
  } else {
    buf.put_str("uint64 unknown_call (__HEX_ANY_ARGS);\n");
  }

  buf.record_line(base_addr);
  buf.put_str("uint64 ");
  buf.put_sanitized_func_name(func_name, func_name_len, base_addr);
  buf.put_char('(');
  if (param_count == 0u) {
    buf.put_str("void");
  } else {
    for (uint32_t p = 0u; p < param_count; ++p) {
      if (p > 0u) buf.put_str(", ");
      buf.put_str("uint64 a");
      buf.put_u64_dec(static_cast<uint64_t>(p + 1u));
    }
  }
  buf.put_str(")\n{\n");

  const uint64_t slot_fp = static_cast<uint64_t>(frame_pre);
  const uint64_t slot_lr = static_cast<uint64_t>(frame_pre - 8u);

  buf.put_str("    uint64 local_m");
  buf.put_u64_hex_upper(slot_fp);
  buf.put_str(";\n    uint64 local_x29;\n    uint64 local_m");
  buf.put_u64_hex_upper(slot_lr);
  buf.put_str(";\n    uint64 local_x30;\n    uint64 call_0;\n");

  buf.record_line(base_addr);
  buf.put_str("    local_m");
  buf.put_u64_hex_upper(slot_fp);
  buf.put_str(" = local_x29;\n");

  buf.record_line(base_addr);
  buf.put_str("    local_m");
  buf.put_u64_hex_upper(slot_lr);
  buf.put_str(" = local_x30;\n");

  const uint64_t call_va = base_addr + static_cast<uint64_t>(call_idx) * 4ULL;
  buf.record_line(call_va);
  if (is_direct_call) {
    buf.put_str("    call_0 = sub_");
    buf.put_u64_hex_upper(direct_target);
    buf.put_str("(/* arguments unknown */);\n");
  } else {
    buf.put_str("    call_0 = unknown_call(");
    if (x0_tracks_arg && x0_arg_origin < param_count) {
      buf.put_char('a');
      buf.put_u64_dec(static_cast<uint64_t>(x0_arg_origin + 1u));
    } else {
      buf.put_str("/* arguments unknown */");
    }
    buf.put_str(");\n");
  }

  const uint64_t ret_va = base_addr + static_cast<uint64_t>(word_count - 1u) * 4ULL;
  if (has_post_add) buf.record_line(post_add_va);
  buf.record_line(call_va);
  buf.record_line(ret_va);
  buf.put_str("    return call_0");
  if (has_post_add) {
    buf.put_str(" + ");
    buf.put_js_imm(post_add_imm);
  }
  buf.put_str(";\n}");

  if (buf.overflow) { emit_arena.restore(emit_mark); return HEX_ERR_RESOURCE_LIMIT; }

  *out_text = buf.data;
  *out_len = buf.len;
  *out_linemap = buf.lm;
  *out_linemap_count = buf.lm_count;
  return HEX_OK;
}

}  // namespace

namespace hex {
namespace decompiler {
namespace passes {

HexStatus try_emit_arm64_calls(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name,
    uint32_t func_name_len,
    uint32_t emit_flags,
    hex::Arena& emit_arena,
    const char** out_text,
    uint32_t* out_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  if (!out_text || !out_len || !out_linemap || !out_linemap_count) {
    return HEX_ERR_INVALID_ARG;
  }
  *out_text = nullptr;
  *out_len = 0u;
  *out_linemap = nullptr;
  *out_linemap_count = 0u;

  if (!words || word_count == 0u) return HEX_ERR_INVALID_ARG;
  if (func_name_len > 0u && !func_name) return HEX_ERR_INVALID_ARG;
  if (word_count > kMaxCallWords) return HEX_ERR_UNSUPPORTED;

  // Try Pattern 1: dispatch-table indirect call (0-diff under both JS_PARITY and NONE).
  HexStatus st = try_emit_dispatch_table(
      words, word_count, base_addr, func_name, func_name_len,
      emit_arena, out_text, out_len, out_linemap, out_linemap_count);
  if (st != HEX_ERR_UNSUPPORTED) return st;

  // Try Pattern 2: generic frame + single bl/blr call (non-parity mode only;
  // fails closed under HEX_EMIT_FLAG_JS_PARITY to guarantee 0-diff).
  return try_emit_standard_frame_call(
      words, word_count, base_addr, func_name, func_name_len, emit_flags,
      emit_arena, out_text, out_len, out_linemap, out_linemap_count);
}

}  // namespace passes
}  // namespace decompiler
}  // namespace hex
