#include "decompiler/passes/arm64_objc_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kMaxObjcNameLen = 256u;
static constexpr uint32_t kMaxLineMapEntries = 48u;
static constexpr uint32_t kTextCap = 2048u;

static constexpr uint32_t kInsnRet = 0xD65F03C0u;

static inline int64_t sign_extend_21(uint32_t v) {
  const uint32_t masked = v & 0x1FFFFFu;
  if (masked & 0x100000u) {
    return -static_cast<int64_t>((~masked + 1u) & 0x1FFFFFu);
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

static bool is_valid_objc_name(const char* name, uint32_t len) {
  if (!name || len < 5u || len > kMaxObjcNameLen) return false;
  if ((name[0] != '-' && name[0] != '+') || name[1] != '[' || name[len - 1u] != ']') {
    return false;
  }
  bool saw_space = false;
  for (uint32_t i = 2u; i + 1u < len; ++i) {
    const unsigned char c = static_cast<unsigned char>(name[i]);
    if (c < 0x20u || c >= 0x7Fu) return false;
    if (c == ';' || c == '{' || c == '}' || c == '[' || c == ']') return false;
    if (c == ' ') saw_space = true;
  }
  return saw_space;
}

// Strict 64-bit SUB sp, sp, #imm (bit 23 MUST be 0).
static bool decode_sub_sp_imm64(uint32_t w, uint64_t* imm_out) {
  if ((w & 0xFF8003FFu) != 0xD10003FFu) return false;
  const uint32_t sh = (w >> 22u) & 1u;
  const uint32_t imm12 = (w >> 10u) & 0xFFFu;
  const uint64_t imm = static_cast<uint64_t>(imm12) << (sh ? 12u : 0u);
  if (imm < 16ULL) return false;
  *imm_out = imm;
  return true;
}

// Strict 64-bit ADD sp, sp, #imm (bit 23 MUST be 0).
static bool decode_add_sp_imm64(uint32_t w, uint64_t* imm_out) {
  if ((w & 0xFF8003FFu) != 0x910003FFu) return false;
  const uint32_t sh = (w >> 22u) & 1u;
  const uint32_t imm12 = (w >> 10u) & 0xFFFu;
  *imm_out = static_cast<uint64_t>(imm12) << (sh ? 12u : 0u);
  return true;
}

// Strict 64-bit MOV Rd, Rm (ORR shifted reg with Rn=31, shift=0, N=0, imm6=0).
static bool decode_mov_reg64(uint32_t w, uint32_t* rd, uint32_t* rm) {
  if ((w & 0xFFE0FFE0u) != 0xAA0003E0u) return false;
  *rd = w & 31u;
  *rm = (w >> 16u) & 31u;
  return true;
}

// Strict 32-bit unsigned-offset STR Wt, [Rn, #off].
static bool decode_str_uoff32(uint32_t w, uint32_t* rt, uint32_t* rn, uint64_t* off_bytes) {
  if ((w & 0xFFC00000u) != 0xB9000000u) return false;
  *rt = w & 31u;
  *rn = (w >> 5u) & 31u;
  *off_bytes = static_cast<uint64_t>((w >> 10u) & 0xFFFu) * 4ULL;
  return true;
}

// Strict 32-bit unsigned-offset LDR Wt, [Rn, #off].
static bool decode_ldr_uoff32(uint32_t w, uint32_t* rt, uint32_t* rn, uint64_t* off_bytes) {
  if ((w & 0xFFC00000u) != 0xB9400000u) return false;
  *rt = w & 31u;
  *rn = (w >> 5u) & 31u;
  *off_bytes = static_cast<uint64_t>((w >> 10u) & 0xFFFu) * 4ULL;
  return true;
}

// Strict unsigned-offset LDRSW Xt, [Rn, #off].
static bool decode_ldrsw_uoff(uint32_t w, uint32_t* rt, uint32_t* rn, uint64_t* off_bytes) {
  if ((w & 0xFFC00000u) != 0xB9800000u) return false;
  *rt = w & 31u;
  *rn = (w >> 5u) & 31u;
  *off_bytes = static_cast<uint64_t>((w >> 10u) & 0xFFFu) * 4ULL;
  return true;
}

// Strict ADRP Xd, #page.
static bool decode_adrp_page(uint32_t w, uint64_t va, uint32_t* rd, uint64_t* page_va) {
  if ((w & 0x9F000000u) != 0x90000000u) return false;
  const uint32_t immlo = (w >> 29u) & 3u;
  const uint32_t immhi = (w >> 5u) & 0x7FFFFu;
  const uint32_t imm21 = (immhi << 2u) | immlo;
  *rd = w & 31u;
  const uint64_t base_page = va & ~0xFFFULL;
  *page_va = (base_page + static_cast<uint64_t>(sign_extend_21(imm21)) * 4096ULL);
  return true;
}

// Strict 64-bit ADD (shifted register, shift=0, imm6=0).
static bool decode_add_reg64(uint32_t w, uint32_t* rd, uint32_t* rn, uint32_t* rm) {
  if ((w & 0xFFE0FC00u) != 0x8B000000u) return false;
  *rd = w & 31u;
  *rn = (w >> 5u) & 31u;
  *rm = (w >> 16u) & 31u;
  return true;
}

// Strict 32-bit MOVZ Wd, #imm16, lsl #hw*16.
static bool decode_movz32(uint32_t w, uint32_t* rd, uint64_t* imm_out) {
  if ((w & 0xFF800000u) != 0x52800000u) return false;
  const uint32_t hw = (w >> 21u) & 3u;
  if (hw >= 2u) return false;
  const uint32_t imm16 = (w >> 5u) & 0xFFFFu;
  *rd = w & 31u;
  *imm_out = static_cast<uint64_t>(imm16) << (hw * 16u);
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

enum class ObjcPattern : uint8_t {
  None = 0,
  ConstReturn = 1,  // 8 insns: -[Cls sel] returning 32-bit constant
  IvarGetter = 2,   // 12 insns: -[Cls ivar] loading 32-bit ivar via adrp+ldrsw+add+ldr
  IvarSetter = 3,   // 14 insns: -[Cls setIvar:] storing 32-bit a3 via adrp+ldrsw+add+str
};

}  // namespace

HexStatus try_emit_arm64_objc(
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

  // Must be a valid ObjC method selector (-[...] or +[...]).
  if (!is_valid_objc_name(func_name, func_name_len)) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Only verified ObjC instruction counts (8, 12, or 14) are eligible.
  if (word_count != 8u && word_count != 12u && word_count != 14u) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Common prologue: sub sp, sp, #N; mov xR1, x0; str wR1, [sp, #self_off];
  //                  mov xR2, x1; str wR2, [sp, #cmd_off]
  // Common epilogue: add sp, sp, #N; ret
  uint64_t frame_size = 0ULL;
  uint64_t add_sp_size = 0ULL;
  if (!decode_sub_sp_imm64(words[0], &frame_size)) return HEX_ERR_UNSUPPORTED;
  if (!decode_add_sp_imm64(words[word_count - 2u], &add_sp_size) || add_sp_size != frame_size) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (words[word_count - 1u] != kInsnRet) return HEX_ERR_UNSUPPORTED;

  uint32_t r_self = 31u, rm_self = 31u;
  uint32_t str_self_rt = 31u, str_self_rn = 31u;
  uint64_t self_off = 0ULL;
  if (!decode_mov_reg64(words[1], &r_self, &rm_self) || rm_self != 0u || r_self >= 29u) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (!decode_str_uoff32(words[2], &str_self_rt, &str_self_rn, &self_off) ||
      str_self_rt != r_self || str_self_rn != 31u || self_off >= frame_size) {
    return HEX_ERR_UNSUPPORTED;
  }

  uint32_t r_cmd = 31u, rm_cmd = 31u;
  uint32_t str_cmd_rt = 31u, str_cmd_rn = 31u;
  uint64_t cmd_off = 0ULL;
  if (!decode_mov_reg64(words[3], &r_cmd, &rm_cmd) || rm_cmd != 1u || r_cmd >= 29u) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (!decode_str_uoff32(words[4], &str_cmd_rt, &str_cmd_rn, &cmd_off) ||
      str_cmd_rt != r_cmd || str_cmd_rn != 31u || cmd_off >= frame_size || cmd_off == self_off) {
    return HEX_ERR_UNSUPPORTED;
  }

  ObjcPattern pat = ObjcPattern::None;
  uint64_t ret_const = 0ULL;
  uint64_t global_addr = 0ULL;
  uint64_t arg_off = 0ULL;

  if (word_count == 8u) {
    // Pattern 1: movz w0, #imm
    uint32_t mov_rd = 31u;
    if (decode_movz32(words[5], &mov_rd, &ret_const) && mov_rd == 0u) {
      pat = ObjcPattern::ConstReturn;
    }
  } else if (word_count == 12u) {
    // Pattern 2: ldr wRb, [sp, #self_off]; adrp xRo, #page; ldrsw xRo, [xRo, #off];
    //            add xRb, xRb, xRo; ldr w0, [xRb, #0]
    uint32_t rb = 31u, ldr_rn = 31u;
    uint64_t ldr_off = 0ULL;
    uint32_t ro = 31u;
    uint64_t page_va = 0ULL;
    uint32_t sw_rt = 31u, sw_rn = 31u;
    uint64_t sw_off = 0ULL;
    uint32_t add_rd = 31u, add_rn = 31u, add_rm = 31u;
    uint32_t fin_rt = 31u, fin_rn = 31u;
    uint64_t fin_off = 0ULL;

    if (decode_ldr_uoff32(words[5], &rb, &ldr_rn, &ldr_off) &&
        ldr_rn == 31u && ldr_off == self_off && rb < 29u &&
        decode_adrp_page(words[6], base_addr + 24ULL, &ro, &page_va) &&
        ro < 29u && ro != rb &&
        decode_ldrsw_uoff(words[7], &sw_rt, &sw_rn, &sw_off) &&
        sw_rt == ro && sw_rn == ro &&
        decode_add_reg64(words[8], &add_rd, &add_rn, &add_rm) &&
        add_rd == rb && add_rn == rb && add_rm == ro &&
        decode_ldr_uoff32(words[9], &fin_rt, &fin_rn, &fin_off) &&
        fin_rt == 0u && fin_rn == rb && fin_off == 0ULL) {
      global_addr = page_va + sw_off;
      pat = ObjcPattern::IvarGetter;
    }
  } else if (word_count == 14u) {
    // Pattern 3: str w2, [sp, #arg_off]; ldr wRv, [sp, #arg_off]; ldr wRb, [sp, #self_off];
    //            adrp xRo, #page; ldrsw xRo, [xRo, #off]; add xRb, xRb, xRo; str wRv, [xRb, #0]
    uint32_t sarg_rt = 31u, sarg_rn = 31u;
    uint32_t rv = 31u, lval_rn = 31u;
    uint64_t lval_off = 0ULL;
    uint32_t rb = 31u, lself_rn = 31u;
    uint64_t lself_off = 0ULL;
    uint32_t ro = 31u;
    uint64_t page_va = 0ULL;
    uint32_t sw_rt = 31u, sw_rn = 31u;
    uint64_t sw_off = 0ULL;
    uint32_t add_rd = 31u, add_rn = 31u, add_rm = 31u;
    uint32_t st_rt = 31u, st_rn = 31u;
    uint64_t st_off = 0ULL;

    if (decode_str_uoff32(words[5], &sarg_rt, &sarg_rn, &arg_off) &&
        sarg_rt == 2u && sarg_rn == 31u && arg_off < frame_size &&
        arg_off != self_off && arg_off != cmd_off &&
        decode_ldr_uoff32(words[6], &rv, &lval_rn, &lval_off) &&
        lval_rn == 31u && lval_off == arg_off && rv < 29u &&
        decode_ldr_uoff32(words[7], &rb, &lself_rn, &lself_off) &&
        lself_rn == 31u && lself_off == self_off && rb < 29u && rb != rv &&
        decode_adrp_page(words[8], base_addr + 32ULL, &ro, &page_va) &&
        ro < 29u && ro != rv && ro != rb &&
        decode_ldrsw_uoff(words[9], &sw_rt, &sw_rn, &sw_off) &&
        sw_rt == ro && sw_rn == ro &&
        decode_add_reg64(words[10], &add_rd, &add_rn, &add_rm) &&
        add_rd == rb && add_rn == rb && add_rm == ro &&
        decode_str_uoff32(words[11], &st_rt, &st_rn, &st_off) &&
        st_rt == rv && st_rn == rb && st_off == 0ULL) {
      global_addr = page_va + sw_off;
      pat = ObjcPattern::IvarSetter;
    }
  }

  if (pat == ObjcPattern::None) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Allocate text buffer and linemap in emit_arena with full OOM rollback.
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

  const uint64_t local_self_mag = frame_size - self_off;
  const uint64_t local_cmd_mag = frame_size - cmd_off;

  auto emit_line = [&](const char* s, uint64_t va) {
    w.append_str(s);
    w.append_char('\n');
    push_linemap(lm_buf, &lm_count, cur_line, va);
    cur_line++;
  };

  if (pat == ObjcPattern::ConstReturn) {
    emit_line("/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */", base_addr);
    emit_line("typedef __INT32_TYPE__ int32;", base_addr);
    emit_line("typedef __UINT64_TYPE__ uint64;", base_addr);
    emit_line("typedef void * id;", base_addr);

    w.append_str("int32 ");
    w.append_bytes(func_name, func_name_len);
    w.append_str("(void)\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("{\n");
    cur_line++;

    w.append_str("    uint64 local_m");
    w.append_u64_hex(local_self_mag, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    emit_line("    uint64 self;", base_addr);

    w.append_str("    uint64 local_m");
    w.append_u64_hex(local_cmd_mag, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    emit_line("    uint64 a2;", base_addr);

    w.append_str("    local_m");
    w.append_u64_hex(local_self_mag, true);
    w.append_str(" = self;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 8ULL);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(local_cmd_mag, true);
    w.append_str(" = a2;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 16ULL);
    cur_line++;

    w.append_str("    return ");
    w.append_const_lit(ret_const);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 20ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 28ULL);
    cur_line++;

    w.append_char('}');
  } else if (pat == ObjcPattern::IvarGetter) {
    emit_line("/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */", base_addr);
    emit_line("typedef __UINT32_TYPE__ uint32;", base_addr);
    emit_line("typedef __INT32_TYPE__ int32;", base_addr);
    emit_line("typedef __UINT64_TYPE__ uint64;", base_addr);
    emit_line("typedef __UINT32_TYPE__ uint32_t;", base_addr);
    emit_line("typedef __INT32_TYPE__ int32_t;", base_addr);
    emit_line("typedef __UINT64_TYPE__ uint64_t;", base_addr);
    emit_line("typedef __INT64_TYPE__ int64_t;", base_addr);
    emit_line("typedef __UINTPTR_TYPE__ uintptr_t;", base_addr);
    emit_line("typedef void * id;", base_addr);
    emit_line("/* hex: standalone external globals (stripped by translation unit packager). */", base_addr);

    w.append_str("static uint64 global_");
    w.append_u64_hex(global_addr, true);
    w.append_str(" = 0;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    emit_line("#ifndef __hex_helper_sext_defined", base_addr);
    emit_line("#define __hex_helper_sext_defined", base_addr);
    emit_line("static inline int64_t sext(uint64_t v) { return (int64_t)(int32_t)(uint32_t)v; }", base_addr);
    emit_line("#endif", base_addr);

    w.append_str("int32 ");
    w.append_bytes(func_name, func_name_len);
    w.append_str("(void)\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("{\n");
    cur_line++;

    w.append_str("    uint64 local_m");
    w.append_u64_hex(local_self_mag, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    emit_line("    uint64 self;", base_addr);

    w.append_str("    uint64 local_m");
    w.append_u64_hex(local_cmd_mag, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    emit_line("    uint64 a2;", base_addr);

    w.append_str("    uint32 var_");
    w.append_u64_hex(self_off, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(local_self_mag, true);
    w.append_str(" = self;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 8ULL);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(local_cmd_mag, true);
    w.append_str(" = a2;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 16ULL);
    cur_line++;

    w.append_str("    return *(uint32_t *)(uintptr_t)(var_");
    w.append_u64_hex(self_off, true);
    w.append_str(" + (sext(global_");
    w.append_u64_hex(global_addr, true);
    w.append_str(")));\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 36ULL);
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 44ULL);
    cur_line++;

    w.append_char('}');
  } else {
    // ObjcPattern::IvarSetter
    const uint64_t local_arg_mag = frame_size - arg_off;

    emit_line("/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */", base_addr);
    emit_line("typedef __UINT64_TYPE__ uint64;", base_addr);
    emit_line("typedef __UINT32_TYPE__ uint32_t;", base_addr);
    emit_line("typedef __INT32_TYPE__ int32_t;", base_addr);
    emit_line("typedef __INT64_TYPE__ int64_t;", base_addr);
    emit_line("typedef __UINTPTR_TYPE__ uintptr_t;", base_addr);
    emit_line("typedef void * id;", base_addr);
    emit_line("/* hex: standalone external globals (stripped by translation unit packager). */", base_addr);

    w.append_str("static uint64 global_");
    w.append_u64_hex(global_addr, true);
    w.append_str(" = 0;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("uint64 ");
    w.append_bytes(func_name, func_name_len);
    w.append_str("(uint64 a3)\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("{\n");
    cur_line++;

    w.append_str("    uint64 local_m");
    w.append_u64_hex(local_self_mag, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    emit_line("    uint64 self;", base_addr);

    w.append_str("    uint64 local_m");
    w.append_u64_hex(local_cmd_mag, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    emit_line("    uint64 a2;", base_addr);

    w.append_str("    uint64 local_m");
    w.append_u64_hex(local_arg_mag, true);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(local_self_mag, true);
    w.append_str(" = self;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 8ULL);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(local_cmd_mag, true);
    w.append_str(" = a2;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 16ULL);
    cur_line++;

    w.append_str("    local_m");
    w.append_u64_hex(local_arg_mag, true);
    w.append_str(" = a3;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 20ULL);
    cur_line++;

    w.append_str("    *(uint32_t *)(uintptr_t)(local_m");
    w.append_u64_hex(local_self_mag, true);
    w.append_str(" + (int64_t)(int32_t)global_");
    w.append_u64_hex(global_addr, true);
    w.append_str(") = (uint32_t)a3;\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr + 44ULL);
    cur_line++;

    emit_line("    return self;", base_addr + 52ULL);

    w.append_char('}');
  }

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
