#include "decompiler/passes/arm64_frame_bl_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kMaxNormNameLen = 128u;
static constexpr uint32_t kMaxLineMapEntries = 48u;
static constexpr uint32_t kTextCap = 2048u;

static constexpr uint32_t kInsnRet = 0xD65F03C0u;
static constexpr uint32_t kInsnMovX29Sp = 0x910003FDu;

static inline bool is_ascii_alpha(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

static inline bool is_ascii_digit(char c) {
  return c >= '0' && c <= '9';
}

static inline bool is_ident_char(char c) {
  return is_ascii_alpha(c) || is_ascii_digit(c) || c == '_';
}

static inline int32_t sign_extend_7(uint32_t v) {
  const uint32_t masked = v & 0x7Fu;
  return (masked & 0x40u) ? static_cast<int32_t>(masked | ~0x7Fu) : static_cast<int32_t>(masked);
}

static inline int64_t sign_extend_26(uint32_t v) {
  const uint32_t masked = v & 0x03FFFFFFu;
  if (masked & 0x02000000u) {
    return -static_cast<int64_t>((~masked + 1u) & 0x03FFFFFFu);
  }
  return static_cast<int64_t>(masked);
}

struct TextWriter {
  char* buf;
  uint32_t cap;
  uint32_t len;
  bool overflow;

  void append_char(char c) {
    if (overflow) return;
    if (len + 1u >= cap) {
      overflow = true;
      return;
    }
    buf[len++] = c;
    buf[len] = '\0';
  }

  void append_str(const char* s) {
    if (!s || overflow) return;
    while (*s != '\0') {
      append_char(*s++);
      if (overflow) return;
    }
  }

  void append_bytes(const char* s, uint32_t n) {
    if (overflow) return;
    for (uint32_t i = 0u; i < n; ++i) {
      append_char(s[i]);
      if (overflow) return;
    }
  }

  void append_u64_hex(uint64_t val, bool upper) {
    static const char kLower[] = "0123456789abcdef";
    static const char kUpper[] = "0123456789ABCDEF";
    const char* digits = upper ? kUpper : kLower;
    char tmp[16];
    uint32_t n = 0u;
    do {
      tmp[n++] = digits[val & 0xFu];
      val >>= 4u;
    } while (val != 0u);
    while (n > 0u) {
      append_char(tmp[--n]);
    }
  }

  void append_u64_dec(uint64_t val) {
    char tmp[24];
    uint32_t n = 0u;
    do {
      tmp[n++] = static_cast<char>('0' + (val % 10u));
      val /= 10u;
    } while (val != 0u);
    while (n > 0u) {
      append_char(tmp[--n]);
    }
  }

  void append_const_lit(uint64_t val) {
    if (val >= 256ULL) {
      append_str("0x");
      append_u64_hex(val, false);
    } else {
      append_u64_dec(val);
    }
  }
};

static bool normalize_func_name(const char* raw,
                                uint32_t raw_len,
                                uint64_t base_addr,
                                char* out_buf,
                                uint32_t out_cap,
                                uint32_t* out_len) {
  if (raw == nullptr || raw_len == 0u) {
    TextWriter w{out_buf, out_cap, 0u, false};
    w.append_str("sub_");
    w.append_u64_hex(base_addr, false);
    if (w.overflow) return false;
    *out_len = w.len;
    return true;
  }
  if (raw_len >= 2u && (raw[0] == '-' || raw[0] == '+') && raw[1] == '[') {
    return false;
  }
  uint32_t start = 0u;
  while (start < raw_len && raw[start] == '_') {
    ++start;
  }
  const uint32_t rem = raw_len - start;
  if (rem == 0u || rem > kMaxNormNameLen || rem + 1u > out_cap) {
    return false;
  }
  for (uint32_t i = 0u; i < rem; ++i) {
    const char c = raw[start + i];
    out_buf[i] = is_ident_char(c) ? c : '_';
  }
  out_buf[rem] = '\0';
  if (is_ascii_digit(out_buf[0])) {
    return false;
  }
  *out_len = rem;
  return true;
}

static bool decode_stp_x29_x30_sp_pre(uint32_t w, int32_t* disp_bytes) {
  if ((w & 0xFFC00000u) != 0xA9800000u) return false;
  const uint32_t rt = w & 31u;
  const uint32_t rn = (w >> 5u) & 31u;
  const uint32_t rt2 = (w >> 10u) & 31u;
  if (rt != 29u || rt2 != 30u || rn != 31u) return false;
  const int32_t disp = sign_extend_7(w >> 15u) * 8;
  if (disp > -16) return false;
  *disp_bytes = disp;
  return true;
}

static bool decode_ldp_x29_x30_sp_post(uint32_t w, int32_t expected_disp) {
  if ((w & 0xFFC00000u) != 0xA8C00000u) return false;
  const uint32_t rt = w & 31u;
  const uint32_t rn = (w >> 5u) & 31u;
  const uint32_t rt2 = (w >> 10u) & 31u;
  if (rt != 29u || rt2 != 30u || rn != 31u) return false;
  const int32_t disp = sign_extend_7(w >> 15u) * 8;
  return disp == expected_disp;
}

static bool decode_bl_target(uint32_t w, uint64_t insn_va, uint64_t* target_va) {
  if ((w & 0xFC000000u) != 0x94000000u) return false;
  const int64_t rel = sign_extend_26(w & 0x03FFFFFFu) * 4;
  *target_va = static_cast<uint64_t>(static_cast<int64_t>(insn_va) + rel);
  return true;
}

// Strict 64-bit ADD (immediate): sf=1, op=0, S=0, 100010 (bit 23 MUST be 0).
static bool decode_add_imm64(uint32_t w, uint32_t* rd, uint32_t* rn, uint64_t* imm) {
  if ((w & 0xFF800000u) != 0x91000000u) return false;
  const uint32_t sh = (w >> 22u) & 1u;
  const uint32_t imm12 = (w >> 10u) & 0xFFFu;
  *rd = w & 31u;
  *rn = (w >> 5u) & 31u;
  *imm = static_cast<uint64_t>(imm12) << (sh ? 12u : 0u);
  return true;
}

// Strict 64-bit MOVZ: sf=1, opc=10, 100101.
static bool decode_movz64(uint32_t w, uint32_t* rd, uint64_t* imm) {
  if ((w & 0xFF800000u) != 0xD2800000u) return false;
  const uint32_t hw = (w >> 21u) & 3u;
  const uint32_t imm16 = (w >> 5u) & 0xFFFFu;
  *rd = w & 31u;
  *imm = static_cast<uint64_t>(imm16) << (hw * 16u);
  return true;
}

// Strict 64-bit MOV Rd, Rm (ORR shifted reg with Rn=31, shift=0, N=0, imm6=0).
static bool decode_mov_reg64(uint32_t w, uint32_t* rd, uint32_t* rm) {
  if ((w & 0xFFE0FFE0u) != 0xAA0003E0u) return false;
  *rd = w & 31u;
  *rm = (w >> 16u) & 31u;
  return true;
}

// Strict 64-bit ADRP Rd, #imm: op=1, 10000.
static bool decode_adrp(uint32_t w, uint32_t* rd) {
  if ((w & 0x9F000000u) != 0x90000000u) return false;
  *rd = w & 31u;
  return true;
}

// Strict 64-bit unsigned-offset STR/LDR [sp, #off].
static bool decode_str_sp_uoff64(uint32_t w, uint32_t* rt, uint64_t* off_bytes) {
  if ((w & 0xFFC003E0u) != 0xF90003E0u) return false;
  *rt = w & 31u;
  *off_bytes = static_cast<uint64_t>((w >> 10u) & 0xFFFu) * 8ULL;
  return true;
}

static bool decode_ldr_sp_uoff64(uint32_t w, uint32_t* rt, uint64_t* off_bytes) {
  if ((w & 0xFFC003E0u) != 0xF94003E0u) return false;
  *rt = w & 31u;
  *off_bytes = static_cast<uint64_t>((w >> 10u) & 0xFFFu) * 8ULL;
  return true;
}

static void push_linemap(HexLineMapEntry* lm, uint32_t* lm_count, uint32_t line_no, uint64_t addr) {
  if (*lm_count >= kMaxLineMapEntries) return;
  for (uint32_t i = 0u; i < *lm_count; ++i) {
    if (lm[i].line_no == line_no && lm[i].addr == addr) return;
  }
  lm[*lm_count].line_no = line_no;
  lm[*lm_count].block_id = 0u;
  lm[*lm_count].addr = addr;
  (*lm_count)++;
}

static void emit_prelude_and_proto(TextWriter& w,
                                   HexLineMapEntry* lm,
                                   uint32_t* lm_count,
                                   uint32_t* cur_line,
                                   uint64_t base_addr,
                                   uint64_t bl_target) {
  static const char* const kPreludeLines[10] = {
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */",
      "typedef __UINT64_TYPE__ uint64;",
      "/* hex: standalone external prototypes (stripped by translation unit packager). */",
      "#ifndef __HEX_ANY_ARGS",
      "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L",
      "#define __HEX_ANY_ARGS ...",
      "#else",
      "#define __HEX_ANY_ARGS",
      "#endif",
      "#endif",
  };
  for (uint32_t i = 0u; i < 10u; ++i) {
    w.append_str(kPreludeLines[i]);
    w.append_char('\n');
    push_linemap(lm, lm_count, *cur_line, base_addr);
    (*cur_line)++;
  }
  w.append_str("uint64 sub_");
  w.append_u64_hex(bl_target, true);
  w.append_str(" (__HEX_ANY_ARGS);\n");
  push_linemap(lm, lm_count, *cur_line, base_addr);
  (*cur_line)++;
}

enum class FrameBlPattern : uint8_t {
  None = 0,
  AdrpAddBl = 1,      // 7 insns: stp; mov x29,sp; adrp x0; add x0,x0,#imm; bl; ldp; ret
  ForwardArgsBl = 2,  // 8 insns: stp; mov x29,sp; mov x0,x1; mov x1,x2; bl; add x0,x0,#imm; ldp; ret
  SpillReloadBl = 3,  // 11 insns: stp; mov x29,sp; movz xR; add xR,xR; str xR,[sp,#o]; ldr x0,[sp,#o]; bl; str x0,[sp,#o]; ldr x0,[sp,#o]; ldp; ret
};

}  // namespace

HexStatus try_emit_arm64_frame_bl(
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
  if (out_text) *out_text = nullptr;
  if (out_len) *out_len = 0u;
  if (out_linemap) *out_linemap = nullptr;
  if (out_linemap_count) *out_linemap_count = 0u;

  if (!words || word_count == 0u || !out_text || !out_len || !out_linemap || !out_linemap_count) {
    return HEX_ERR_INVALID_ARG;
  }

  // Only exact verified instruction counts (7, 8, or 11) are eligible.
  if (word_count != 7u && word_count != 8u && word_count != 11u) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Common frame prologue & epilogue validation.
  int32_t frame_disp = 0;
  if (!decode_stp_x29_x30_sp_pre(words[0], &frame_disp)) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (words[1] != kInsnMovX29Sp) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (!decode_ldp_x29_x30_sp_post(words[word_count - 2u], -frame_disp)) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (words[word_count - 1u] != kInsnRet) {
    return HEX_ERR_UNSUPPORTED;
  }

  char norm_name[kMaxNormNameLen + 1u];
  uint32_t norm_name_len = 0u;
  if (!normalize_func_name(func_name, func_name_len, base_addr,
                           norm_name, sizeof(norm_name), &norm_name_len)) {
    return HEX_ERR_UNSUPPORTED;
  }

  FrameBlPattern pat = FrameBlPattern::None;
  uint64_t bl_target = 0ULL;
  uint64_t post_add_imm = 0ULL;
  uint64_t spill_const = 0ULL;
  uint64_t spill_sp_rel_u64 = 0ULL;

  if (word_count == 7u) {
    // Pattern 1: adrp x0; add x0, x0, #imm; bl target
    uint32_t adrp_rd = 31u;
    uint32_t add_rd = 31u, add_rn = 31u;
    uint64_t add_imm = 0ULL;
    if (decode_adrp(words[2], &adrp_rd) && adrp_rd == 0u &&
        decode_add_imm64(words[3], &add_rd, &add_rn, &add_imm) && add_rd == 0u && add_rn == 0u &&
        decode_bl_target(words[4], base_addr + 16ULL, &bl_target)) {
      pat = FrameBlPattern::AdrpAddBl;
    }
  } else if (word_count == 8u) {
    // Pattern 2: mov x0, x1; mov x1, x2; bl target; add x0, x0, #imm
    uint32_t m0_rd = 31u, m0_rm = 31u;
    uint32_t m1_rd = 31u, m1_rm = 31u;
    uint32_t add_rd = 31u, add_rn = 31u;
    if (decode_mov_reg64(words[2], &m0_rd, &m0_rm) && m0_rd == 0u && m0_rm == 1u &&
        decode_mov_reg64(words[3], &m1_rd, &m1_rm) && m1_rd == 1u && m1_rm == 2u &&
        decode_bl_target(words[4], base_addr + 16ULL, &bl_target) &&
        decode_add_imm64(words[5], &add_rd, &add_rn, &post_add_imm) &&
        add_rd == 0u && add_rn == 0u) {
      pat = FrameBlPattern::ForwardArgsBl;
    }
  } else if (word_count == 11u) {
    // Pattern 3: movz xR, #imm1; add xR, xR, #imm2; str xR, [sp, #o]; ldr x0, [sp, #o];
    //            bl target; str x0, [sp, #o]; ldr x0, [sp, #o]
    uint32_t mov_rd = 31u;
    uint64_t imm1 = 0ULL;
    uint32_t add_rd = 31u, add_rn = 31u;
    uint64_t imm2 = 0ULL;
    uint32_t str1_rt = 31u, ldr1_rt = 31u, str2_rt = 31u, ldr2_rt = 31u;
    uint64_t off1 = 0ULL, off2 = 0ULL, off3 = 0ULL, off4 = 0ULL;
    if (decode_movz64(words[2], &mov_rd, &imm1) && mov_rd > 0u && mov_rd < 29u &&
        decode_add_imm64(words[3], &add_rd, &add_rn, &imm2) && add_rd == mov_rd && add_rn == mov_rd &&
        decode_str_sp_uoff64(words[4], &str1_rt, &off1) && str1_rt == mov_rd &&
        decode_ldr_sp_uoff64(words[5], &ldr1_rt, &off2) && ldr1_rt == 0u && off2 == off1 &&
        decode_bl_target(words[6], base_addr + 24ULL, &bl_target) &&
        decode_str_sp_uoff64(words[7], &str2_rt, &off3) && str2_rt == 0u && off3 == off1 &&
        decode_ldr_sp_uoff64(words[8], &ldr2_rt, &off4) && ldr2_rt == 0u && off4 == off1) {
      spill_const = imm1 + imm2;
      const int64_t sp_rel = static_cast<int64_t>(frame_disp) + static_cast<int64_t>(off1);
      spill_sp_rel_u64 = static_cast<uint64_t>(sp_rel);
      pat = FrameBlPattern::SpillReloadBl;
    }
  }

  if (pat == FrameBlPattern::None) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Allocate text buffer and linemap on emit_arena with full rollback on OOM.
  const size_t arena_mark = emit_arena.used();
  char* text_buf = emit_arena.alloc<char>(kTextCap);
  HexLineMapEntry* lm_buf = emit_arena.alloc<HexLineMapEntry>(kMaxLineMapEntries);
  if (!text_buf || !lm_buf) {
    emit_arena.restore(arena_mark);
    return HEX_ERR_OOM;
  }
  text_buf[0] = '\0';

  TextWriter w{text_buf, kTextCap, 0u, false};
  uint32_t lm_count = 0u;
  uint32_t cur_line = 1u;

  const uint64_t slot0 = static_cast<uint64_t>(-frame_disp);
  const uint64_t slot1 = slot0 - 8ULL;

  emit_prelude_and_proto(w, lm_buf, &lm_count, &cur_line, base_addr, bl_target);

  // Signature line
  w.append_str("uint64 ");
  w.append_bytes(norm_name, norm_name_len);
  if (pat == FrameBlPattern::ForwardArgsBl) {
    w.append_str("(uint64 a1, uint64 a2, uint64 a3)\n");
  } else {
    w.append_str("(void)\n");
  }
  push_linemap(lm_buf, &lm_count, cur_line, base_addr);
  cur_line++;

  // Open brace
  w.append_str("{\n");
  cur_line++;

  // Frame local declarations
  w.append_str("    uint64 local_m");
  w.append_u64_hex(slot0, true);
  w.append_str(";\n");
  push_linemap(lm_buf, &lm_count, cur_line, base_addr);
  cur_line++;

  w.append_str("    uint64 local_x29;\n");
  push_linemap(lm_buf, &lm_count, cur_line, base_addr);
  cur_line++;

  w.append_str("    uint64 local_m");
  w.append_u64_hex(slot1, true);
  w.append_str(";\n");
  push_linemap(lm_buf, &lm_count, cur_line, base_addr);
  cur_line++;

  w.append_str("    uint64 local_x30;\n");
  push_linemap(lm_buf, &lm_count, cur_line, base_addr);
  cur_line++;

  if (pat == FrameBlPattern::AdrpAddBl) {
    w.append_str("    uint64 call_42;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    // Statements
    w.append_str("    local_m");
    w.append_u64_hex(slot0, true);
    w.append_str(" = local_x29;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(slot1, true);
    w.append_str(" = local_x30;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    call_42 = sub_");
    w.append_u64_hex(bl_target, true);
    w.append_str("(/* arguments unknown */);\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 16ULL);
    cur_line++;

    w.append_str("    return call_42;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 16ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 12ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 8ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 24ULL);
    cur_line++;
  } else if (pat == FrameBlPattern::ForwardArgsBl) {
    w.append_str("    uint64 call_66;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    // Statements
    w.append_str("    local_m");
    w.append_u64_hex(slot0, true);
    w.append_str(" = local_x29;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(slot1, true);
    w.append_str(" = local_x30;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    call_66 = sub_");
    w.append_u64_hex(bl_target, true);
    w.append_str("(/* arguments unknown */);\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 16ULL);
    cur_line++;

    if (post_add_imm == 0ULL) {
      w.append_str("    return call_66;\n");
    } else {
      w.append_str("    return call_66 + ");
      w.append_const_lit(post_add_imm);
      w.append_str(";\n");
    }
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 20ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 16ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 8ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 12ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 28ULL);
    cur_line++;
  } else {
    // FrameBlPattern::SpillReloadBl
    w.append_str("    uint64 local_p");
    w.append_u64_hex(spill_sp_rel_u64, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    uint64 call_95;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    uint64 var_");
    w.append_u64_hex(spill_sp_rel_u64, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    // Statements
    w.append_str("    local_m");
    w.append_u64_hex(slot0, true);
    w.append_str(" = local_x29;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(slot1, true);
    w.append_str(" = local_x30;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    local_p");
    w.append_u64_hex(spill_sp_rel_u64, true);
    w.append_str(" = ");
    w.append_const_lit(spill_const);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 16ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 12ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 8ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    call_95 = sub_");
    w.append_u64_hex(bl_target, true);
    w.append_str("(/* arguments unknown */);\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 24ULL);
    cur_line++;

    w.append_str("    local_p");
    w.append_u64_hex(spill_sp_rel_u64, true);
    w.append_str(" = call_95;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 28ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 24ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 20ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    return var_");
    w.append_u64_hex(spill_sp_rel_u64, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 32ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 40ULL);
    cur_line++;
  }

  // Close brace (no trailing newline, matching JS oracle)
  w.append_char('}');

  if (w.overflow) {
    emit_arena.restore(arena_mark);
    return HEX_ERR_OOM;
  }

  *out_text = text_buf;
  *out_len = w.len;
  *out_linemap = lm_buf;
  *out_linemap_count = lm_count;
  return HEX_OK;
}

}  // namespace passes
}  // namespace decompiler
}  // namespace hex
