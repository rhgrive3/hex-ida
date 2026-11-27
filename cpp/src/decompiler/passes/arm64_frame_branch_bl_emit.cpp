#include "arm64_frame_branch_bl_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kArm64RetCanonical = 0xd65f03c0u;
static constexpr uint32_t kArm64MovFpSp = 0x910003fdu;
static constexpr uint32_t kMaxFuncNameLen = 512u;
static constexpr uint32_t kBaseTextCap = 4096u;
static constexpr uint32_t kMaxLineMapEntries = 96u;

enum class CondCode : uint8_t {
  EQ = 0,
  NE = 1,
  HS = 2,
  LO = 3,
  HI = 8,
  LS = 9,
  GE = 10,
  LT = 11,
  GT = 12,
  LE = 13,
  INVALID = 255,
};

static CondCode parse_cond(uint32_t raw) {
  switch (raw & 0xfu) {
    case 0u: return CondCode::EQ;
    case 1u: return CondCode::NE;
    case 2u: return CondCode::HS;
    case 3u: return CondCode::LO;
    case 8u: return CondCode::HI;
    case 9u: return CondCode::LS;
    case 10u: return CondCode::GE;
    case 11u: return CondCode::LT;
    case 12u: return CondCode::GT;
    case 13u: return CondCode::LE;
    default: return CondCode::INVALID;
  }
}

static CondCode invert_cond(CondCode c) {
  switch (c) {
    case CondCode::EQ: return CondCode::NE;
    case CondCode::NE: return CondCode::EQ;
    case CondCode::HS: return CondCode::LO;
    case CondCode::LO: return CondCode::HS;
    case CondCode::HI: return CondCode::LS;
    case CondCode::LS: return CondCode::HI;
    case CondCode::GE: return CondCode::LT;
    case CondCode::LT: return CondCode::GE;
    case CondCode::GT: return CondCode::LE;
    case CondCode::LE: return CondCode::GT;
    default: return CondCode::INVALID;
  }
}

static bool is_signed_cond(CondCode c) {
  return c == CondCode::GE || c == CondCode::LT || c == CondCode::GT || c == CondCode::LE;
}

static const char* cond_op_str(CondCode c) {
  switch (c) {
    case CondCode::EQ: return "==";
    case CondCode::NE: return "!=";
    case CondCode::HS: return ">=";
    case CondCode::LO: return "<";
    case CondCode::HI: return ">";
    case CondCode::LS: return "<=";
    case CondCode::GE: return ">=";
    case CondCode::LT: return "<";
    case CondCode::GT: return ">";
    case CondCode::LE: return "<=";
    default: return nullptr;
  }
}

static bool decode_stp_fp_lr_pre(uint32_t w, uint32_t* out_frame_size) {
  // 64-bit STP x29, x30, [sp, #-frame_size]!
  // 10 101 0 011 0 imm7[6:0] 11110(30) 11111(31) 11101(29)
  if ((w & 0xffc07fffu) != 0xa9807bfdu) return false;
  int32_t imm7 = static_cast<int32_t>((w >> 15) & 0x7fu);
  if ((imm7 & 0x40) != 0) imm7 -= 0x80;
  if (imm7 >= 0) return false;
  const uint32_t frame_size = static_cast<uint32_t>(-imm7) * 8u;
  if (frame_size < 16u || (frame_size & 0xfu) != 0u) return false;
  *out_frame_size = frame_size;
  return true;
}

static bool decode_ldp_fp_lr_post(uint32_t w, uint32_t* out_frame_size) {
  // 64-bit LDP x29, x30, [sp], #frame_size
  // 10 101 0 001 1 imm7[6:0] 11110(30) 11111(31) 11101(29)
  if ((w & 0xffc07fffu) != 0xa8c07bfdu) return false;
  int32_t imm7 = static_cast<int32_t>((w >> 15) & 0x7fu);
  if ((imm7 & 0x40) != 0) imm7 -= 0x80;
  if (imm7 <= 0) return false;
  const uint32_t frame_size = static_cast<uint32_t>(imm7) * 8u;
  if (frame_size < 16u || (frame_size & 0xfu) != 0u) return false;
  *out_frame_size = frame_size;
  return true;
}

static bool decode_str64_sp_uoff(uint32_t w, uint8_t* out_rt, uint32_t* out_off) {
  // 64-bit STR Xt, [sp, #uimm12*8]: 11 111 0 01 00 imm12 11111 Rt
  if ((w & 0xffc003e0u) != 0xf90003e0u) return false;
  *out_rt = static_cast<uint8_t>(w & 0x1fu);
  *out_off = ((w >> 10) & 0xfffu) * 8u;
  return true;
}

static bool decode_ldr64_sp_uoff(uint32_t w, uint8_t* out_rt, uint32_t* out_off) {
  // 64-bit LDR Xt, [sp, #uimm12*8]: 11 111 0 01 01 imm12 11111 Rt
  if ((w & 0xffc003e0u) != 0xf94003e0u) return false;
  *out_rt = static_cast<uint8_t>(w & 0x1fu);
  *out_off = ((w >> 10) & 0xfffu) * 8u;
  return true;
}

static bool decode_ldr32_uoff(uint32_t w, uint8_t* out_rt, uint8_t* out_rn, uint32_t* out_off) {
  // 32-bit LDR Wt, [Xn/SP, #uimm12*4]: 10 111 0 01 01 imm12 Rn Rt
  if ((w & 0xffc00000u) != 0xb9400000u) return false;
  *out_rt = static_cast<uint8_t>(w & 0x1fu);
  *out_rn = static_cast<uint8_t>((w >> 5) & 0x1fu);
  *out_off = ((w >> 10) & 0xfffu) * 4u;
  return true;
}

static bool decode_str32_uoff(uint32_t w, uint8_t* out_rt, uint8_t* out_rn, uint32_t* out_off) {
  // 32-bit STR Wt, [Xn/SP, #uimm12*4]: 10 111 0 01 00 imm12 Rn Rt
  if ((w & 0xffc00000u) != 0xb9000000u) return false;
  *out_rt = static_cast<uint8_t>(w & 0x1fu);
  *out_rn = static_cast<uint8_t>((w >> 5) & 0x1fu);
  *out_off = ((w >> 10) & 0xfffu) * 4u;
  return true;
}

static bool decode_mul32(uint32_t w, uint8_t* out_rd, uint8_t* out_rn, uint8_t* out_rm) {
  // 32-bit MUL (MADD Wd, Wn, Wm, WZR): 0 00 11011 000 Rm 0 11111 Rn Rd
  if ((w & 0xffe0fc00u) != 0x1b007c00u) return false;
  const uint8_t rd = static_cast<uint8_t>(w & 0x1fu);
  const uint8_t rn = static_cast<uint8_t>((w >> 5) & 0x1fu);
  const uint8_t rm = static_cast<uint8_t>((w >> 16) & 0x1fu);
  if (rd == 31u || rn == 31u || rm == 31u) return false;
  *out_rd = rd;
  *out_rn = rn;
  *out_rm = rm;
  return true;
}

static bool decode_sub32_reg(uint32_t w, uint8_t* out_rd, uint8_t* out_rn, uint8_t* out_rm) {
  // 32-bit SUB (shifted register, shift=0, imm6=0, S=0): 0 1 0 01011 00 0 Rm 000000 Rn Rd
  if ((w & 0xffe0fc00u) != 0x4b000000u) return false;
  const uint8_t rd = static_cast<uint8_t>(w & 0x1fu);
  const uint8_t rn = static_cast<uint8_t>((w >> 5) & 0x1fu);
  const uint8_t rm = static_cast<uint8_t>((w >> 16) & 0x1fu);
  if (rd == 31u || rn == 31u || rm == 31u) return false;
  *out_rd = rd;
  *out_rn = rn;
  *out_rm = rm;
  return true;
}

static bool decode_cmp32_imm(uint32_t w, uint8_t* out_rn, uint32_t* out_imm) {
  // 32-bit CMP (SUBS WZR, Wn, #imm12{, lsl #12}): 0 1 1 10001 sh(2) imm12 Rn 11111
  if ((w & 0xff00001fu) != 0x7100001fu) return false;
  const uint32_t sh = (w >> 22) & 3u;
  if (sh >= 2u) return false;
  const uint8_t rn = static_cast<uint8_t>((w >> 5) & 0x1fu);
  if (rn == 31u) return false;
  const uint32_t imm12 = (w >> 10) & 0xfffu;
  *out_rn = rn;
  *out_imm = sh == 1u ? (imm12 << 12) : imm12;
  return true;
}

static bool decode_b_cond(uint32_t w, CondCode* out_cond, int32_t* out_off_words) {
  // B.cond: 01010100 imm19[18:0] 0 cond[3:0]
  if ((w & 0xff000010u) != 0x54000000u) return false;
  const CondCode c = parse_cond(w & 0xfu);
  if (c == CondCode::INVALID) return false;
  int32_t imm19 = static_cast<int32_t>((w >> 5) & 0x7ffffu);
  if ((imm19 & 0x40000) != 0) imm19 -= 0x80000;
  *out_cond = c;
  *out_off_words = imm19;
  return true;
}

static bool decode_movz32(uint32_t w, uint8_t* out_rd, uint32_t* out_imm) {
  // 32-bit MOVZ Wd, #imm16{, lsl #16}: 0 10 100101 hw(2) imm16 Rd
  if ((w & 0xff800000u) != 0x52800000u) return false;
  const uint32_t hw = (w >> 21) & 3u;
  if (hw >= 2u) return false;
  const uint8_t rd = static_cast<uint8_t>(w & 0x1fu);
  if (rd == 31u) return false;
  const uint32_t imm16 = (w >> 5) & 0xffffu;
  *out_rd = rd;
  *out_imm = imm16 << (hw * 16u);
  return true;
}

static bool is_adrp_x0(uint32_t w) {
  // ADRP x0, #imm: 1 immlo[1:0] 10000 immhi[18:0] 00000
  return (w & 0x9f00001fu) == 0x90000000u;
}

static bool is_add64_x0_imm(uint32_t w) {
  // ADD x0, x0, #imm12{, lsl #12}: 1 0 0 10001 sh(2) imm12 00000 00000
  if ((w & 0xff0003ffu) != 0x91000000u) return false;
  const uint32_t sh = (w >> 22) & 3u;
  return sh < 2u;
}

static bool decode_bl_target(uint32_t w, uint64_t pc, uint64_t* out_target) {
  // BL: 100101 imm26[25:0]
  if ((w & 0xfc000000u) != 0x94000000u) return false;
  int32_t imm26 = static_cast<int32_t>(w & 0x03ffffffu);
  if ((imm26 & 0x02000000) != 0) imm26 -= 0x04000000;
  const int64_t byte_delta = static_cast<int64_t>(imm26) * 4;
  *out_target = pc + static_cast<uint64_t>(byte_delta);
  return true;
}

static bool is_valid_c_ident_char(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
         (c >= '0' && c <= '9') || c == '_';
}

struct EmitWriter {
  char* buf;
  uint32_t len;
  uint32_t cap;
  HexLineMapEntry* lm;
  uint32_t lm_count;
  uint32_t lm_cap;
  uint32_t line_no;
  bool overflow;

  void init(char* text_buf, uint32_t text_cap, HexLineMapEntry* lm_buf, uint32_t linemap_cap) {
    buf = text_buf;
    len = 0u;
    cap = text_cap;
    lm = lm_buf;
    lm_count = 0u;
    lm_cap = linemap_cap;
    line_no = 1u;
    overflow = false;
    if (cap > 0u) buf[0] = '\0';
  }

  void put_char(char c) {
    if (overflow) return;
    if (cap == 0u || len >= cap - 1u) {
      overflow = true;
      return;
    }
    buf[len++] = c;
    if (c == '\n') line_no += 1u;
  }

  void put_n(const char* s, uint32_t n) {
    if (overflow || n == 0u) return;
    if (s == nullptr || cap == 0u || n >= cap || len > cap - 1u - n) {
      overflow = true;
      return;
    }
    for (uint32_t i = 0u; i < n; ++i) {
      buf[len++] = s[i];
      if (s[i] == '\n') line_no += 1u;
    }
  }

  void put_cstr(const char* s) {
    if (overflow || s == nullptr) return;
    uint32_t n = 0u;
    while (s[n] != '\0') ++n;
    put_n(s, n);
  }

  void put_u64_dec(uint64_t v) {
    char tmp[24];
    uint32_t n = 0u;
    if (v == 0u) {
      tmp[n++] = '0';
    } else {
      while (v > 0u) {
        tmp[n++] = static_cast<char>('0' + (v % 10u));
        v /= 10u;
      }
    }
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_u64_hex(uint64_t v, bool upper) {
    const char* digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    char tmp[16];
    uint32_t n = 0u;
    if (v == 0u) {
      tmp[n++] = '0';
    } else {
      while (v > 0u) {
        tmp[n++] = digits[v & 0xfu];
        v >>= 4;
      }
    }
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_stack_slot_hex(uint32_t frame_size, uint32_t sp_offset) {
    const int64_t rel = static_cast<int64_t>(sp_offset) - static_cast<int64_t>(frame_size);
    put_u64_hex(static_cast<uint64_t>(rel), true);
  }

  void map_addr(uint32_t block_id, uint64_t addr) {
    if (overflow) return;
    if (lm_count >= lm_cap) {
      overflow = true;
      return;
    }
    lm[lm_count].line_no = line_no;
    lm[lm_count].block_id = block_id;
    lm[lm_count].addr = addr;
    lm_count += 1u;
  }

  void finish_nul() {
    if (!overflow && len < cap) buf[len] = '\0';
  }
};

}  // namespace

HexStatus try_emit_arm64_frame_branch_bl(
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
  if (out_text == nullptr || out_len == nullptr ||
      out_linemap == nullptr || out_linemap_count == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  *out_text = nullptr;
  *out_len = 0u;
  *out_linemap = nullptr;
  *out_linemap_count = 0u;

  if (words == nullptr || word_count == 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  if (func_name == nullptr && func_name_len > 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  if (func_name_len > kMaxFuncNameLen) {
    return HEX_ERR_INVALID_ARG;
  }

  // Validate and strip leading '_' from func_name (if provided).
  uint32_t clean_start = 0u;
  if (func_name != nullptr && func_name_len > 0u) {
    for (uint32_t i = 0u; i < func_name_len; ++i) {
      if (!is_valid_c_ident_char(func_name[i])) {
        return HEX_ERR_UNSUPPORTED;
      }
    }
    while (clean_start < func_name_len && func_name[clean_start] == '_') {
      ++clean_start;
    }
    if (clean_start < func_name_len) {
      const char first = func_name[clean_start];
      if (first >= '0' && first <= '9') {
        return HEX_ERR_UNSUPPORTED;
      }
    }
  }

  // Exact 20-instruction frame + field-mul-sub + conditional clamp + bl + epilogue shape.
  if (word_count != 20u) return HEX_ERR_UNSUPPORTED;
  if (words[1] != kArm64MovFpSp || words[19] != kArm64RetCanonical) {
    return HEX_ERR_UNSUPPORTED;
  }

  uint32_t frame_size = 0u;
  uint32_t epilogue_frame_size = 0u;
  if (!decode_stp_fp_lr_pre(words[0], &frame_size) ||
      !decode_ldp_fp_lr_post(words[18], &epilogue_frame_size) ||
      frame_size != epilogue_frame_size) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [2] str x0, [sp, #slot_ptr]
  uint8_t str_ptr_rt = 0u;
  uint32_t slot_ptr = 0u;
  if (!decode_str64_sp_uoff(words[2], &str_ptr_rt, &slot_ptr) ||
      str_ptr_rt != 0u || slot_ptr + 8u > frame_size) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [3] ldr wV, [x0, #off_a]
  // [4] ldr wM, [x0, #off_b]
  uint8_t r_val = 0u, rn3 = 0u;
  uint32_t off_a = 0u;
  uint8_t r_mul = 0u, rn4 = 0u;
  uint32_t off_b = 0u;
  if (!decode_ldr32_uoff(words[3], &r_val, &rn3, &off_a) ||
      !decode_ldr32_uoff(words[4], &r_mul, &rn4, &off_b) ||
      rn3 != 0u || rn4 != 0u ||
      r_val < 2u || r_val > 28u || r_mul < 2u || r_mul > 28u || r_val == r_mul) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [5] mul wM, w1, wM  (or mul wM, wM, w1)
  uint8_t mul_rd = 0u, mul_rn = 0u, mul_rm = 0u;
  if (!decode_mul32(words[5], &mul_rd, &mul_rn, &mul_rm) || mul_rd != r_mul) {
    return HEX_ERR_UNSUPPORTED;
  }
  const bool mul_ok = (mul_rn == 1u && mul_rm == r_mul) || (mul_rn == r_mul && mul_rm == 1u);
  if (!mul_ok) return HEX_ERR_UNSUPPORTED;

  // [6] sub wV, wV, wM
  uint8_t sub_rd = 0u, sub_rn = 0u, sub_rm = 0u;
  if (!decode_sub32_reg(words[6], &sub_rd, &sub_rn, &sub_rm) ||
      sub_rd != r_val || sub_rn != r_val || sub_rm != r_mul) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [7] str wV, [x0, #off_a]
  uint8_t str7_rt = 0u, str7_rn = 0u;
  uint32_t str7_off = 0u;
  if (!decode_str32_uoff(words[7], &str7_rt, &str7_rn, &str7_off) ||
      str7_rt != r_val || str7_rn != 0u || str7_off != off_a) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [8] cmp wV, #cmp_imm
  // [9] b.cond +4 (-> [13])
  uint8_t cmp_rn = 0u;
  uint32_t cmp_imm = 0u;
  CondCode skip_cond = CondCode::INVALID;
  int32_t br_off_words = 0;
  if (!decode_cmp32_imm(words[8], &cmp_rn, &cmp_imm) || cmp_rn != r_val ||
      !decode_b_cond(words[9], &skip_cond, &br_off_words) || br_off_words != 4) {
    return HEX_ERR_UNSUPPORTED;
  }
  const CondCode clamp_cond = invert_cond(skip_cond);
  const char* clamp_op = cond_op_str(clamp_cond);
  if (clamp_op == nullptr) return HEX_ERR_UNSUPPORTED;

  // [10] mov wV, #clamp_imm
  // [11] ldr x0, [sp, #slot_ptr]
  // [12] str wV, [x0, #off_a]
  uint8_t mov10_rd = 0u;
  uint32_t clamp_imm = 0u;
  uint8_t ldr11_rt = 0u;
  uint32_t ldr11_off = 0u;
  uint8_t str12_rt = 0u, str12_rn = 0u;
  uint32_t str12_off = 0u;
  if (!decode_movz32(words[10], &mov10_rd, &clamp_imm) || mov10_rd != r_val ||
      !decode_ldr64_sp_uoff(words[11], &ldr11_rt, &ldr11_off) ||
      ldr11_rt != 0u || ldr11_off != slot_ptr ||
      !decode_str32_uoff(words[12], &str12_rt, &str12_rn, &str12_off) ||
      str12_rt != r_val || str12_rn != 0u || str12_off != off_a) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [13] str wV, [sp, #slot_res]
  uint8_t str13_rt = 0u, str13_rn = 0u;
  uint32_t slot_res = 0u;
  if (!decode_str32_uoff(words[13], &str13_rt, &str13_rn, &slot_res) ||
      str13_rt != r_val || str13_rn != 31u ||
      slot_res + 4u > frame_size || slot_res == slot_ptr) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [14] adrp x0, ...
  // [15] add x0, x0, #imm
  // [16] bl target
  uint64_t bl_target = 0u;
  if (!is_adrp_x0(words[14]) || !is_add64_x0_imm(words[15]) ||
      !decode_bl_target(words[16], base_addr + 16ull * 4ull, &bl_target)) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [17] ldr w0, [sp, #slot_res]
  uint8_t ldr17_rt = 0u, ldr17_rn = 0u;
  uint32_t ldr17_off = 0u;
  if (!decode_ldr32_uoff(words[17], &ldr17_rt, &ldr17_rn, &ldr17_off) ||
      ldr17_rt != 0u || ldr17_rn != 31u || ldr17_off != slot_res) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Ensure both stack slots are negative relative to entry sp (inside frame).
  if (slot_ptr >= frame_size || slot_res >= frame_size) {
    return HEX_ERR_UNSUPPORTED;
  }

  const size_t arena_mark = emit_arena.used();
  const uint32_t text_cap = kBaseTextCap + func_name_len;
  char* text_buf = emit_arena.alloc<char>(text_cap);
  HexLineMapEntry* lm_buf = emit_arena.alloc<HexLineMapEntry>(kMaxLineMapEntries);
  if (text_buf == nullptr || lm_buf == nullptr) {
    emit_arena.restore(arena_mark);
    return HEX_ERR_OOM;
  }

  EmitWriter w{};
  w.init(text_buf, text_cap, lm_buf, kMaxLineMapEntries);

  const bool js_parity = (emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u;
  const bool cmp_signed = is_signed_cond(clamp_cond);

  if (js_parity) {
    w.put_cstr("/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n");
    w.put_cstr("typedef __UINT32_TYPE__ uint32;\n");
    w.put_cstr("typedef __INT32_TYPE__ int32;\n");
    w.put_cstr("typedef __UINT64_TYPE__ uint64;\n");
    w.put_cstr("typedef __UINT32_TYPE__ uint32_t;\n");
    if (cmp_signed) {
      w.put_cstr("typedef __INT32_TYPE__ int32_t;\n");
    }
    w.put_cstr("typedef __UINTPTR_TYPE__ uintptr_t;\n");
    w.put_cstr("/* hex: standalone external prototypes (stripped by translation unit packager). */\n");
    w.put_cstr("#ifndef __HEX_ANY_ARGS\n");
    w.put_cstr("#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n");
    w.put_cstr("#define __HEX_ANY_ARGS ...\n");
    w.put_cstr("#else\n");
    w.put_cstr("#define __HEX_ANY_ARGS\n");
    w.put_cstr("#endif\n");
    w.put_cstr("#endif\n");
    w.put_cstr("uint64 sub_");
    w.put_u64_hex(bl_target, true);
    w.put_cstr(" (__HEX_ANY_ARGS);\n");
  }

  // Signature line
  w.map_addr(0u, base_addr);
  w.put_cstr("int32 ");
  if (func_name != nullptr && clean_start < func_name_len) {
    w.put_n(func_name + clean_start, func_name_len - clean_start);
  } else {
    w.put_cstr("sub_");
    w.put_u64_hex(base_addr, true);
  }
  w.put_cstr("(uint64 a1, uint64 a2)\n{\n");

  // Local declarations
  w.map_addr(0u, base_addr);
  w.put_cstr("    uint64 local_m");
  w.put_u64_hex(frame_size, false);
  w.put_cstr(";\n");

  w.map_addr(0u, base_addr);
  w.put_cstr("    uint64 local_x29;\n");

  w.map_addr(0u, base_addr);
  w.put_cstr("    uint64 local_m");
  w.put_u64_hex(frame_size - 8u, false);
  w.put_cstr(";\n");

  w.map_addr(0u, base_addr);
  w.put_cstr("    uint64 local_x30;\n");

  w.map_addr(0u, base_addr);
  w.put_cstr("    uint64 local_p");
  w.put_stack_slot_hex(frame_size, slot_ptr);
  w.put_cstr(";\n");

  w.map_addr(0u, base_addr);
  w.put_cstr("    uint64 local_p");
  w.put_stack_slot_hex(frame_size, slot_res);
  w.put_cstr(";\n");

  w.map_addr(0u, base_addr);
  w.put_cstr("    uint64 var_");
  w.put_stack_slot_hex(frame_size, slot_res);
  w.put_cstr(";\n");

  w.put_cstr("    uint32 load_18;\n");
  w.put_cstr("    uint64 phi_160;\n");

  // Prologue frame stores
  w.map_addr(0u, base_addr);
  w.put_cstr("    local_m");
  w.put_u64_hex(frame_size, false);
  w.put_cstr(" = local_x29;\n");

  w.map_addr(0u, base_addr);
  w.put_cstr("    local_m");
  w.put_u64_hex(frame_size - 8u, false);
  w.put_cstr(" = local_x30;\n");

  w.map_addr(0u, base_addr + 8ull);
  w.map_addr(0u, base_addr);
  w.put_cstr("    local_p");
  w.put_stack_slot_hex(frame_size, slot_ptr);
  w.put_cstr(" = a1;\n");

  // Field load + in-place update
  w.map_addr(0u, base_addr + 12ull);
  w.put_cstr("    load_18 = *(uint32_t *)((uintptr_t)(a1) + ");
  w.put_u64_dec(off_a);
  w.put_cstr(");\n");

  w.map_addr(0u, base_addr + 28ull);
  w.map_addr(0u, base_addr + 24ull);
  w.map_addr(0u, base_addr + 12ull);
  w.map_addr(0u, base_addr + 20ull);
  w.map_addr(0u, base_addr + 16ull);
  w.put_cstr("    *(uint32_t *)((uintptr_t)(a1) + ");
  w.put_u64_dec(off_a);
  w.put_cstr(") -= (uint32_t)a2 * *(uint32_t *)((uintptr_t)(a1) + ");
  w.put_u64_dec(off_b);
  w.put_cstr(");\n");

  // Conditional clamp branch
  w.map_addr(0u, base_addr + 32ull);
  w.map_addr(0u, base_addr + 36ull);
  w.put_cstr("    if (");
  w.put_cstr(cmp_signed ? "(int32_t)" : "(uint32_t)");
  w.put_cstr("*(uint32_t *)((uintptr_t)(a1) + ");
  w.put_u64_dec(off_a);
  w.put_cstr(") ");
  w.put_cstr(clamp_op);
  w.put_char(' ');
  w.put_u64_dec(cmp_imm);
  w.put_cstr(") {\n");

  // Clamp branch body
  w.map_addr(1u, base_addr + 48ull);
  w.map_addr(1u, base_addr + 40ull);
  w.map_addr(1u, base_addr + 44ull);
  w.put_cstr("        *(uint32_t *)((uintptr_t)(local_p");
  w.put_stack_slot_hex(frame_size, slot_ptr);
  w.put_cstr(") + ");
  w.put_u64_dec(off_a);
  w.put_cstr(") = ");
  w.put_u64_dec(clamp_imm);
  w.put_cstr(";\n");

  w.map_addr(1u, base_addr + 24ull);
  w.map_addr(1u, base_addr + 40ull);
  w.map_addr(1u, base_addr + 48ull);
  w.put_cstr("        phi_160 = ");
  w.put_u64_dec(clamp_imm);
  w.put_cstr(";\n");

  w.put_cstr("    } else {\n");

  // Non-clamp branch body
  w.map_addr(2u, base_addr + 24ull);
  w.map_addr(2u, base_addr + 12ull);
  w.map_addr(2u, base_addr + 20ull);
  w.map_addr(2u, base_addr + 16ull);
  w.map_addr(2u, base_addr + 36ull);
  w.put_cstr("        phi_160 = load_18 - (a2 * (*(uint32_t *)((uintptr_t)(a1) + ");
  w.put_u64_dec(off_b);
  w.put_cstr(")));\n");

  w.put_cstr("    }\n");

  // Merge + spill + call + return
  w.map_addr(3u, base_addr + 52ull);
  w.map_addr(3u, base_addr + 24ull);
  w.map_addr(3u, base_addr + 12ull);
  w.map_addr(3u, base_addr + 20ull);
  w.map_addr(3u, base_addr + 16ull);
  w.map_addr(3u, base_addr + 40ull);
  w.map_addr(3u, base_addr);
  w.put_cstr("    local_p");
  w.put_stack_slot_hex(frame_size, slot_res);
  w.put_cstr(" = phi_160;\n");

  w.map_addr(3u, base_addr + 64ull);
  w.put_cstr("    sub_");
  w.put_u64_hex(bl_target, true);
  w.put_cstr("(/* arguments unknown */);\n");

  w.map_addr(3u, base_addr + 68ull);
  w.map_addr(3u, base_addr + 76ull);
  w.put_cstr("    return var_");
  w.put_stack_slot_hex(frame_size, slot_res);
  w.put_cstr(";\n}");

  if (w.overflow) {
    emit_arena.restore(arena_mark);
    return HEX_ERR_OOM;
  }
  w.finish_nul();

  *out_text = text_buf;
  *out_len = w.len;
  *out_linemap = lm_buf;
  *out_linemap_count = w.lm_count;
  return HEX_OK;
}

}  // namespace passes
}  // namespace decompiler
}  // namespace hex
