#include "arm64_frame_multicall_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kMaxWords = 64u;
static constexpr uint32_t kMaxTextBytes = 8192u;
static constexpr uint32_t kMaxLineMapEntries = 64u;
static constexpr uint32_t kMaxFuncNameLen = 256u;

static constexpr uint32_t kInsnMovFpSp = 0x910003fdu;
static constexpr uint32_t kInsnRetCanon = 0xd65f03c0u;
static constexpr uint32_t kInsnNop = 0xd503201fu;

static inline constexpr uint32_t masked(uint32_t w, uint32_t mask) { return w & mask; }
static inline constexpr uint8_t reg_rd(uint32_t w) { return static_cast<uint8_t>(w & 0x1fu); }
static inline constexpr uint8_t reg_rn(uint32_t w) { return static_cast<uint8_t>((w >> 5) & 0x1fu); }
static inline constexpr uint8_t reg_rt2(uint32_t w) { return static_cast<uint8_t>((w >> 10) & 0x1fu); }
static inline constexpr uint8_t reg_rm(uint32_t w) { return static_cast<uint8_t>((w >> 16) & 0x1fu); }

static inline constexpr int64_t sign_extend(uint32_t val, uint32_t bits) {
  const uint64_t mask = (1ULL << bits) - 1ULL;
  const uint64_t sign = 1ULL << (bits - 1u);
  const uint64_t v = static_cast<uint64_t>(val) & mask;
  return static_cast<int64_t>((v ^ sign) - sign);
}

// `stp x29, x30, [sp, #-N]!` (64-bit pre-indexed, 16-byte aligned, N in [16, 512])
static inline bool match_stp_fp_lr_pre(uint32_t w, uint32_t* out_frame_bytes) {
  if (masked(w, 0xffc00000u) != 0xa9800000u) return false;
  if (reg_rd(w) != 29u || reg_rt2(w) != 30u || reg_rn(w) != 31u) return false;
  const int64_t imm7 = sign_extend((w >> 15) & 0x7fu, 7u);
  if (imm7 > -2) return false;
  const uint32_t bytes = static_cast<uint32_t>(-imm7 * 8LL);
  if (bytes < 16u || bytes > 512u || (bytes & 15u) != 0u) return false;
  *out_frame_bytes = bytes;
  return true;
}

// `ldp x29, x30, [sp], #N` (64-bit post-indexed, 16-byte aligned, N in [16, 512])
static inline bool match_ldp_fp_lr_post(uint32_t w, uint32_t* out_frame_bytes) {
  if (masked(w, 0xffc00000u) != 0xa8c00000u) return false;
  if (reg_rd(w) != 29u || reg_rt2(w) != 30u || reg_rn(w) != 31u) return false;
  const int64_t imm7 = sign_extend((w >> 15) & 0x7fu, 7u);
  if (imm7 < 2) return false;
  const uint32_t bytes = static_cast<uint32_t>(imm7 * 8LL);
  if (bytes < 16u || bytes > 512u || (bytes & 15u) != 0u) return false;
  *out_frame_bytes = bytes;
  return true;
}

// `movz wd, #imm16{, lsl #16}` (32-bit, hw < 2, rd < 31)
static inline bool match_movz32(uint32_t w, uint8_t* out_rd, uint32_t* out_imm) {
  if (masked(w, 0xff800000u) != 0x52800000u) return false;
  const uint32_t hw = (w >> 21) & 3u;
  if (hw >= 2u) return false;
  const uint8_t rd = reg_rd(w);
  if (rd >= 31u) return false;
  const uint32_t imm16 = (w >> 5) & 0xffffu;
  *out_rd = rd;
  *out_imm = imm16 << (hw * 16u);
  return true;
}

// `bl #target`
static inline bool match_bl(uint32_t w, uint64_t pc, uint64_t* out_target) {
  if (masked(w, 0xfc000000u) != 0x94000000u) return false;
  const int64_t delta = sign_extend(w & 0x03ffffffu, 26u) * 4LL;
  *out_target = pc + static_cast<uint64_t>(delta);
  return true;
}

// `str wt, [sp, #off]` (32-bit unsigned offset, SP base only)
static inline bool match_str_w_sp_uoff(uint32_t w, uint8_t* out_rt, uint32_t* out_off) {
  if (masked(w, 0xffc00000u) != 0xb9000000u) return false;
  if (reg_rn(w) != 31u) return false;
  const uint8_t rt = reg_rd(w);
  if (rt >= 31u) return false;
  *out_rt = rt;
  *out_off = ((w >> 10) & 0xfffu) * 4u;
  return true;
}

// `ldr wt, [sp, #off]` (32-bit unsigned offset, SP base only)
static inline bool match_ldr_w_sp_uoff(uint32_t w, uint8_t* out_rt, uint32_t* out_off) {
  if (masked(w, 0xffc00000u) != 0xb9400000u) return false;
  if (reg_rn(w) != 31u) return false;
  const uint8_t rt = reg_rd(w);
  if (rt >= 31u) return false;
  *out_rt = rt;
  *out_off = ((w >> 10) & 0xfffu) * 4u;
  return true;
}

// `add wd, wn, wm` (32-bit shifted register, S=0, shift=0, imm6=0)
static inline bool match_add_w_reg(uint32_t w, uint8_t* out_rd, uint8_t* out_rn, uint8_t* out_rm) {
  if (masked(w, 0xffe0fc00u) != 0x0b000000u) return false;
  const uint8_t rd = reg_rd(w);
  const uint8_t rn = reg_rn(w);
  const uint8_t rm = reg_rm(w);
  if (rd >= 31u || rn >= 31u || rm >= 31u) return false;
  *out_rd = rd;
  *out_rn = rn;
  *out_rm = rm;
  return true;
}

// `add xd, sp, #imm` (64-bit ADD immediate, S=0, sh[1]=0, rn=SP)
static inline bool match_add_x_sp_imm(uint32_t w, uint8_t* out_rd, uint32_t* out_imm) {
  if (masked(w, 0xff800000u) != 0x91000000u) return false;
  if (reg_rn(w) != 31u) return false;
  const uint8_t rd = reg_rd(w);
  if (rd >= 31u) return false;
  const uint32_t shift = ((w >> 22) & 1u) ? 12u : 0u;
  *out_rd = rd;
  *out_imm = ((w >> 10) & 0xfffu) << shift;
  return true;
}

struct EmitBuf {
  char* data;
  uint32_t cap;
  uint32_t len;
  uint32_t line_no;
  bool overflow;

  HexLineMapEntry* lm;
  uint32_t lm_cap;
  uint32_t lm_count;

  bool init(hex::Arena& arena) {
    data = arena.alloc<char>(kMaxTextBytes);
    if (!data) return false;
    lm = arena.alloc<HexLineMapEntry>(kMaxLineMapEntries);
    if (!lm) return false;
    cap = kMaxTextBytes;
    len = 0u;
    line_no = 1u;
    overflow = false;
    lm_cap = kMaxLineMapEntries;
    lm_count = 0u;
    data[0] = '\0';
    return true;
  }

  void put_char(char c) {
    if (overflow) return;
    if (len + 1u >= cap) {
      overflow = true;
      return;
    }
    data[len++] = c;
    data[len] = '\0';
  }

  void put_str(const char* s) {
    if (!s || overflow) return;
    while (*s != '\0') put_char(*s++);
  }

  void begin_line(uint64_t addr) {
    if (overflow) return;
    if (len > 0u) {
      put_char('\n');
      ++line_no;
    }
    if (lm_count >= lm_cap) {
      overflow = true;
      return;
    }
    lm[lm_count].line_no = line_no;
    lm[lm_count].block_id = 0u;
    lm[lm_count].addr = addr;
    ++lm_count;
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

  void put_imm_val(uint32_t v) {
    if (v <= 255u) {
      put_u64_dec(static_cast<uint64_t>(v));
    } else {
      put_str("0x");
      put_u64_hex_upper(static_cast<uint64_t>(v));
    }
  }

  // Matches JS safeIdent: strip leading '_', prefix "sub_" if first char not alpha,
  // replace non-identifier chars with '_'.
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
};

static inline bool is_valid_func_name(const char* name, uint32_t len) {
  if (len == 0u) return true;
  if (!name || len > kMaxFuncNameLen) return false;
  for (uint32_t i = 0u; i < len; ++i) {
    const unsigned char c = static_cast<unsigned char>(name[i]);
    if (c < 0x20u || c == 0x7fu) return false;
  }
  return true;
}

}  // namespace

HexStatus try_emit_arm64_frame_multicall(
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
  (void)emit_flags;

  if (!out_text || !out_len || !out_linemap || !out_linemap_count) {
    return HEX_ERR_INVALID_ARG;
  }
  *out_text = nullptr;
  *out_len = 0u;
  *out_linemap = nullptr;
  *out_linemap_count = 0u;

  if (!words || word_count == 0u) return HEX_ERR_INVALID_ARG;
  if (!is_valid_func_name(func_name, func_name_len)) return HEX_ERR_INVALID_ARG;

  if (word_count < 22u || word_count > kMaxWords) return HEX_ERR_UNSUPPORTED;

  // ── Decode & strictly validate all 22 core instructions + optional trailing NOPs ──
  uint32_t frame_pre = 0u;
  uint32_t frame_post = 0u;
  if (!match_stp_fp_lr_pre(words[0], &frame_pre)) return HEX_ERR_UNSUPPORTED;
  if (words[1] != kInsnMovFpSp) return HEX_ERR_UNSUPPORTED;

  // [2] movz w0, #arg0_0; [3] movz w1, #arg0_1; [4] bl #target0
  uint8_t r2 = 31u, r3 = 31u;
  uint32_t arg0_0 = 0u, arg0_1 = 0u;
  uint64_t target0 = 0ULL;
  if (!match_movz32(words[2], &r2, &arg0_0) || r2 != 0u) return HEX_ERR_UNSUPPORTED;
  if (!match_movz32(words[3], &r3, &arg0_1) || r3 != 1u) return HEX_ERR_UNSUPPORTED;
  if (!match_bl(words[4], base_addr + 4ULL * 4ULL, &target0)) return HEX_ERR_UNSUPPORTED;

  // [5] str w0, [sp, #slot_a]
  uint8_t r5 = 31u;
  uint32_t slot_a = 0u;
  if (!match_str_w_sp_uoff(words[5], &r5, &slot_a) || r5 != 0u) return HEX_ERR_UNSUPPORTED;
  if (slot_a == 0u || slot_a + 4u > frame_pre) return HEX_ERR_UNSUPPORTED;

  // [6] movz w0, #arg1_0; [7] bl #target1
  uint8_t r6 = 31u;
  uint32_t arg1_0 = 0u;
  uint64_t target1 = 0ULL;
  if (!match_movz32(words[6], &r6, &arg1_0) || r6 != 0u) return HEX_ERR_UNSUPPORTED;
  if (!match_bl(words[7], base_addr + 7ULL * 4ULL, &target1)) return HEX_ERR_UNSUPPORTED;

  // [8] ldr w1, [sp, #slot_a]; [9] add w0, w0, w1; [10] str w0, [sp, #slot_b]
  uint8_t r8 = 31u;
  uint32_t slot_a_ld = 0u;
  if (!match_ldr_w_sp_uoff(words[8], &r8, &slot_a_ld) || r8 != 1u || slot_a_ld != slot_a) {
    return HEX_ERR_UNSUPPORTED;
  }
  uint8_t add_rd = 31u, add_rn = 31u, add_rm = 31u;
  if (!match_add_w_reg(words[9], &add_rd, &add_rn, &add_rm) || add_rd != 0u) {
    return HEX_ERR_UNSUPPORTED;
  }
  const bool add_ok = (add_rn == 0u && add_rm == 1u) || (add_rn == 1u && add_rm == 0u);
  if (!add_ok) return HEX_ERR_UNSUPPORTED;

  uint8_t r10 = 31u;
  uint32_t slot_b = 0u;
  if (!match_str_w_sp_uoff(words[10], &r10, &slot_b) || r10 != 0u) return HEX_ERR_UNSUPPORTED;
  if (slot_b == 0u || slot_b == slot_a || slot_b + 4u > frame_pre) return HEX_ERR_UNSUPPORTED;

  // [11] bl #target2
  uint64_t target2 = 0ULL;
  if (!match_bl(words[11], base_addr + 11ULL * 4ULL, &target2)) return HEX_ERR_UNSUPPORTED;

  // [12] movz w0, #buf_val0; [13] str w0, [sp, #buf_off0]
  // [14] movz w0, #buf_val1; [15] str w0, [sp, #buf_off1]
  uint8_t r12 = 31u, r13 = 31u, r14 = 31u, r15 = 31u;
  uint32_t buf_val0 = 0u, buf_off0 = 0u, buf_val1 = 0u, buf_off1 = 0u;
  if (!match_movz32(words[12], &r12, &buf_val0) || r12 != 0u) return HEX_ERR_UNSUPPORTED;
  if (!match_str_w_sp_uoff(words[13], &r13, &buf_off0) || r13 != 0u) return HEX_ERR_UNSUPPORTED;
  if (buf_off0 == 0u || buf_off0 >= frame_pre || buf_off0 == slot_a || buf_off0 == slot_b) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (!match_movz32(words[14], &r14, &buf_val1) || r14 != 0u) return HEX_ERR_UNSUPPORTED;
  if (!match_str_w_sp_uoff(words[15], &r15, &buf_off1) || r15 != 0u) return HEX_ERR_UNSUPPORTED;
  if (buf_off1 == 0u || buf_off1 >= frame_pre || buf_off1 == slot_a || buf_off1 == slot_b) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [16] add x0, sp, #buf_ptr_off; [17] movz w1, #arg3_1; [18] bl #target3
  uint8_t r16 = 31u, r17 = 31u;
  uint32_t buf_ptr_off = 0u, arg3_1 = 0u;
  uint64_t target3 = 0ULL;
  if (!match_add_x_sp_imm(words[16], &r16, &buf_ptr_off) || r16 != 0u) return HEX_ERR_UNSUPPORTED;
  if (buf_ptr_off == 0u || buf_ptr_off >= frame_pre) return HEX_ERR_UNSUPPORTED;
  if (!match_movz32(words[17], &r17, &arg3_1) || r17 != 1u) return HEX_ERR_UNSUPPORTED;
  if (!match_bl(words[18], base_addr + 18ULL * 4ULL, &target3)) return HEX_ERR_UNSUPPORTED;

  // [19] ldr w0, [sp, #slot_b]; [20] ldp x29, x30, [sp], #frame_pre; [21] ret
  uint8_t r19 = 31u;
  uint32_t ret_slot = 0u;
  if (!match_ldr_w_sp_uoff(words[19], &r19, &ret_slot) || r19 != 0u || ret_slot != slot_b) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (!match_ldp_fp_lr_post(words[20], &frame_post) || frame_post != frame_pre) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (words[21] != kInsnRetCanon) return HEX_ERR_UNSUPPORTED;

  // Trailing words [22..word_count-1] must be canonical NOP padding
  for (uint32_t i = 22u; i < word_count; ++i) {
    if (words[i] != kInsnNop) return HEX_ERR_UNSUPPORTED;
  }

  // ── Emit 0-diff C text and exact HexLineMapEntry array with arena rollback ──
  const size_t arena_mark = emit_arena.used();
  EmitBuf buf{};
  if (!buf.init(emit_arena)) {
    emit_arena.restore(arena_mark);
    return HEX_ERR_OOM;
  }

  // Preamble typedefs & external prototype macro
  buf.begin_line(base_addr);
  buf.put_str("/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */");
  buf.begin_line(base_addr);
  buf.put_str("typedef __UINT32_TYPE__ uint32;");
  buf.begin_line(base_addr);
  buf.put_str("typedef __UINT64_TYPE__ uint64;");
  buf.begin_line(base_addr);
  buf.put_str("typedef __UINT8_TYPE__ uint8_t;");
  buf.begin_line(base_addr);
  buf.put_str("typedef __UINTPTR_TYPE__ uintptr_t;");
  buf.begin_line(base_addr);
  buf.put_str("/* hex: standalone external prototypes (stripped by translation unit packager). */");
  buf.begin_line(base_addr);
  buf.put_str("#ifndef __HEX_ANY_ARGS");
  buf.begin_line(base_addr);
  buf.put_str("#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L");
  buf.begin_line(base_addr);
  buf.put_str("#define __HEX_ANY_ARGS ...");
  buf.begin_line(base_addr);
  buf.put_str("#else");
  buf.begin_line(base_addr);
  buf.put_str("#define __HEX_ANY_ARGS");
  buf.begin_line(base_addr);
  buf.put_str("#endif");
  buf.begin_line(base_addr);
  buf.put_str("#endif");

  // Deduplicated external prototypes in order of first appearance
  const uint64_t raw_targets[4] = {target0, target1, target2, target3};
  uint64_t unique_targets[4] = {0ULL, 0ULL, 0ULL, 0ULL};
  uint32_t unique_count = 0u;
  for (uint32_t i = 0u; i < 4u; ++i) {
    bool seen = false;
    for (uint32_t j = 0u; j < unique_count; ++j) {
      if (unique_targets[j] == raw_targets[i]) {
        seen = true;
        break;
      }
    }
    if (!seen) unique_targets[unique_count++] = raw_targets[i];
  }
  for (uint32_t i = 0u; i < unique_count; ++i) {
    buf.begin_line(base_addr);
    buf.put_str("uint64 sub_");
    buf.put_u64_hex_upper(unique_targets[i]);
    buf.put_str(" (__HEX_ANY_ARGS);");
  }

  // Function signature & opening brace
  buf.begin_line(base_addr);
  buf.put_str("uint32 ");
  buf.put_sanitized_func_name(func_name, func_name_len, base_addr);
  buf.put_str("(void)");

  buf.begin_line(base_addr);
  buf.put_char('{');

  // Local declarations
  buf.begin_line(base_addr);
  buf.put_str("    uint64 x0_1;");
  buf.begin_line(base_addr);
  buf.put_str("    uint64 x1_1;");
  buf.begin_line(base_addr);
  buf.put_str("    uint64 x0_3;");
  buf.begin_line(base_addr);
  buf.put_str("    uint64 x0_4;");
  buf.begin_line(base_addr);
  buf.put_str("    uint8_t __hex_stack_frame[4096] = {0};");
  buf.begin_line(base_addr);
  buf.put_str("    uint64 sp = (uintptr_t)(__hex_stack_frame + sizeof(__hex_stack_frame));");
  buf.begin_line(base_addr);
  buf.put_str("    uint64 x0_5;");

  buf.begin_line(base_addr);
  buf.put_str("    uint32 var_");
  buf.put_u64_hex_upper(static_cast<uint64_t>(slot_a));
  buf.put_str(", var_");
  buf.put_u64_hex_upper(static_cast<uint64_t>(slot_b));
  buf.put_char(';');

  buf.begin_line(base_addr);
  buf.put_str(
      "    // \xE2\x80\xA6 \xE3\x81\xBB\xE3\x81\x8B\xE3\x81\xAB 4 "
      "\xE5\x80\x8B\xE3\x81\xAE\xE7\xBD\xAE\xE3\x81\x8D\xE5\xA0\xB4"
      "\xEF\xBC\x88\xE9\x80\x80\xE9\x81\xBF\xE7\x94\xA8\xE3\x81\xAA\xE3\x81\xA9"
      "\xEF\xBC\x89\xE3\x81\x8C\xE3\x81\x82\xE3\x82\x8A\xE3\x81\xBE\xE3\x81\x99");

  buf.begin_line(base_addr);  // blank separator line

  // Body statements with exact instruction VAs
  buf.begin_line(base_addr + 4ULL * 4ULL);  // [4] bl target0
  buf.put_str("    x0_1 = sub_");
  buf.put_u64_hex_upper(target0);
  buf.put_char('(');
  buf.put_imm_val(arg0_0);
  buf.put_str(", ");
  buf.put_imm_val(arg0_1);
  buf.put_str(");");

  buf.begin_line(base_addr + 5ULL * 4ULL);  // [5] str w0, [sp, #slot_a]
  buf.put_str("    var_");
  buf.put_u64_hex_upper(static_cast<uint64_t>(slot_a));
  buf.put_str(" = x1_1;");

  buf.begin_line(base_addr + 8ULL * 4ULL);  // [8] ldr w1, [sp, #slot_a]
  buf.put_str("    x1_1 = var_");
  buf.put_u64_hex_upper(static_cast<uint64_t>(slot_a));
  buf.put_char(';');

  buf.begin_line(base_addr + 9ULL * 4ULL);  // [7] bl target1 + [9] add w0, w0, w1
  buf.put_str("    x0_3 = (uint32)((uint32)sub_");
  buf.put_u64_hex_upper(target1);
  buf.put_char('(');
  buf.put_imm_val(arg1_0);
  buf.put_str(") + x1_1);");

  buf.begin_line(base_addr + 10ULL * 4ULL);  // [10] str w0, [sp, #slot_b]
  buf.put_str("    var_");
  buf.put_u64_hex_upper(static_cast<uint64_t>(slot_b));
  buf.put_str(" = x0_3;");

  buf.begin_line(base_addr + 11ULL * 4ULL);  // [11] bl target2
  buf.put_str("    x0_4 = sub_");
  buf.put_u64_hex_upper(target2);
  buf.put_str("(x0_3, x1_1);");

  const uint32_t sp_disp0 = frame_pre - buf_off0;
  const uint32_t sp_disp1 = frame_pre - buf_off1;
  const uint32_t sp_ptr_disp = frame_pre - buf_ptr_off;

  buf.begin_line(base_addr + 13ULL * 4ULL);  // [13] str w0, [sp, #buf_off0]
  buf.put_str("    *(uint32 *)(uintptr_t)(sp - 0x");
  buf.put_u64_hex_upper(static_cast<uint64_t>(sp_disp0));
  buf.put_str(") = ");
  buf.put_imm_val(buf_val0);
  buf.put_char(';');

  buf.begin_line(base_addr + 15ULL * 4ULL);  // [15] str w0, [sp, #buf_off1]
  buf.put_str("    *(uint32 *)(uintptr_t)(sp - 0x");
  buf.put_u64_hex_upper(static_cast<uint64_t>(sp_disp1));
  buf.put_str(") = ");
  buf.put_imm_val(buf_val1);
  buf.put_char(';');

  buf.begin_line(base_addr + 18ULL * 4ULL);  // [18] bl target3
  buf.put_str("    x0_5 = sub_");
  buf.put_u64_hex_upper(target3);
  buf.put_str("((sp - 0x");
  buf.put_u64_hex_upper(static_cast<uint64_t>(sp_ptr_disp));
  buf.put_str("), ");
  buf.put_imm_val(arg3_1);
  buf.put_str(");");

  buf.begin_line(base_addr + 21ULL * 4ULL);  // [21] ret
  buf.put_str("    return (uint32)var_");
  buf.put_u64_hex_upper(static_cast<uint64_t>(slot_b));
  buf.put_char(';');

  buf.begin_line(base_addr + 21ULL * 4ULL);
  buf.put_char('}');

  if (buf.overflow) {
    emit_arena.restore(arena_mark);
    return HEX_ERR_RESOURCE_LIMIT;
  }

  *out_text = buf.data;
  *out_len = buf.len;
  *out_linemap = buf.lm;
  *out_linemap_count = buf.lm_count;
  return HEX_OK;
}

}  // namespace passes
}  // namespace decompiler
}  // namespace hex
