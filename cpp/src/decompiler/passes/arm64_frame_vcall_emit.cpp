#include "arm64_frame_vcall_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kArm64RetWord = 0xd65f03c0u;
static constexpr uint32_t kArm64MovFpSpWord = 0x910003fdu;  // add x29, sp, #0
static constexpr uint32_t kMaxFuncNameLen = 256u;

static constexpr char kHexLower[16] = {
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};

static constexpr char kHexUpper[16] = {
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'};

struct DecodedLdrUoff {
  bool valid;
  bool is_64;
  uint8_t rt;
  uint8_t rn;
  uint64_t disp;
};

struct DecodedMovz {
  bool valid;
  bool is_64;
  uint8_t rd;
  uint64_t imm;
};

struct DecodedMovReg {
  bool valid;
  bool is_64;
  uint8_t rd;
  uint8_t rm;
};

struct DecodedBlr {
  bool valid;
  uint8_t rn;
};

static inline int32_t sign_extend_7(uint32_t imm7) {
  return (imm7 & 0x40u) ? static_cast<int32_t>(imm7 | ~0x7fu) : static_cast<int32_t>(imm7);
}

// Decodes `stp x29, x30, [sp, #-frame]!` (64-bit pre-indexed STP).
// Returns frame size in bytes (positive multiple of 16), or 0 if invalid.
static uint32_t decode_stp_fp_lr_pre(uint32_t w) {
  if ((w & 0xffc00000u) != 0xa9800000u) return 0u;
  const uint32_t rt = w & 0x1fu;
  const uint32_t rn = (w >> 5) & 0x1fu;
  const uint32_t rt2 = (w >> 10) & 0x1fu;
  if (rt != 29u || rt2 != 30u || rn != 31u) return 0u;
  const int32_t imm7 = sign_extend_7((w >> 15) & 0x7fu);
  if (imm7 >= 0) return 0u;
  const uint32_t frame = static_cast<uint32_t>(-imm7) * 8u;
  if (frame < 16u || (frame & 15u) != 0u) return 0u;
  return frame;
}

// Decodes `ldp x29, x30, [sp], #frame` (64-bit post-indexed LDP).
// Returns frame size in bytes (positive multiple of 16), or 0 if invalid.
static uint32_t decode_ldp_fp_lr_post(uint32_t w) {
  if ((w & 0xffc00000u) != 0xa8c00000u) return 0u;
  const uint32_t rt = w & 0x1fu;
  const uint32_t rn = (w >> 5) & 0x1fu;
  const uint32_t rt2 = (w >> 10) & 0x1fu;
  if (rt != 29u || rt2 != 30u || rn != 31u) return 0u;
  const int32_t imm7 = sign_extend_7((w >> 15) & 0x7fu);
  if (imm7 <= 0) return 0u;
  const uint32_t frame = static_cast<uint32_t>(imm7) * 8u;
  if (frame < 16u || (frame & 15u) != 0u) return 0u;
  return frame;
}

static DecodedLdrUoff decode_ldr_uoff(uint32_t w) {
  DecodedLdrUoff out{};
  const uint32_t op = w & 0xffc00000u;
  if (op != 0xf9400000u && op != 0xb9400000u) return out;
  const uint32_t rt = w & 0x1fu;
  const uint32_t rn = (w >> 5) & 0x1fu;
  if (rt == 31u || rn == 31u) return out;
  const bool is_64 = (op == 0xf9400000u);
  const uint64_t scale = is_64 ? 8ULL : 4ULL;
  out.valid = true;
  out.is_64 = is_64;
  out.rt = static_cast<uint8_t>(rt);
  out.rn = static_cast<uint8_t>(rn);
  out.disp = static_cast<uint64_t>((w >> 10) & 0xfffu) * scale;
  return out;
}

static DecodedMovz decode_movz(uint32_t w) {
  DecodedMovz out{};
  if ((w & 0x7f800000u) != 0x52800000u) return out;
  const bool is_64 = ((w >> 31) & 1u) != 0u;
  const uint32_t hw = (w >> 21) & 3u;
  if (!is_64 && hw >= 2u) return out;
  const uint32_t rd = w & 0x1fu;
  if (rd == 31u) return out;
  const uint64_t imm16 = (w >> 5) & 0xffffu;
  out.valid = true;
  out.is_64 = is_64;
  out.rd = static_cast<uint8_t>(rd);
  out.imm = imm16 << (hw * 16u);
  return out;
}

static DecodedMovReg decode_mov_reg(uint32_t w) {
  DecodedMovReg out{};
  // MOV (register alias of ORR): sf 01 01010 00 0 Rm(5) 000000 11111 Rd(5)
  if ((w & 0x7fe0ffe0u) != 0x2a0003e0u) return out;
  const uint32_t rd = w & 0x1fu;
  const uint32_t rm = (w >> 16) & 0x1fu;
  if (rd == 31u || rm == 31u) return out;
  out.valid = true;
  out.is_64 = ((w >> 31) & 1u) != 0u;
  out.rd = static_cast<uint8_t>(rd);
  out.rm = static_cast<uint8_t>(rm);
  return out;
}

// Strictly decodes non-PAC `BLR Xn` ONLY: 1101011 0 0 01 11111 000000 Rn(5) 00000.
// All PAC variants (BLRAA, BLRAB, BLRAAZ, BLRABZ) fail this mask and are rejected.
static DecodedBlr decode_blr_non_pac(uint32_t w) {
  DecodedBlr out{};
  if ((w & 0xfffffc1fu) != 0xd63f0000u) return out;
  const uint32_t rn = (w >> 5) & 0x1fu;
  if (rn == 31u) return out;
  out.valid = true;
  out.rn = static_cast<uint8_t>(rn);
  return out;
}

static bool is_scratch_reg(uint8_t r) {
  return r >= 8u && r <= 15u;
}

static bool is_ident_start(uint8_t c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
}

static bool is_ident_char(uint8_t c) {
  return is_ident_start(c) || (c >= '0' && c <= '9');
}

// Validates and normalizes C function name: rejects ObjC selectors, control/non-ident
// characters, leading digits, and oversized lengths.
static bool validate_func_name(const char* raw, uint32_t len, uint32_t* out_start) {
  *out_start = 0u;
  if (len > kMaxFuncNameLen) return false;
  if (raw == nullptr || len == 0u) return true;
  if (len >= 2u && ((raw[0] == '-' && raw[1] == '[') || (raw[0] == '+' && raw[1] == '['))) {
    return false;
  }
  uint32_t start = 0u;
  while (start < len && raw[start] == '_') ++start;
  if (start == len) return true;  // All underscores -> fallback to sub_<addr>
  if (!is_ident_start(static_cast<uint8_t>(raw[start]))) return false;
  for (uint32_t i = start; i < len; ++i) {
    if (!is_ident_char(static_cast<uint8_t>(raw[i]))) return false;
  }
  *out_start = start;
  return true;
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
  }

  void put_char(char c) {
    if (overflow) return;
    if (len + 1u >= cap) {
      overflow = true;
      return;
    }
    buf[len++] = c;
    if (c == '\n') line_no += 1u;
  }

  void put_n(const char* s, uint32_t n) {
    if (overflow || n == 0u) return;
    if (s == nullptr || n >= cap || len > cap - 1u - n) {
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
    const char* digits = upper ? kHexUpper : kHexLower;
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

  void put_param(uint8_t idx) {
    put_char('a');
    put_u64_dec(static_cast<uint64_t>(idx) + 1u);
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

struct VcallPlan {
  uint32_t frame_bytes;
  uint32_t num_params;
  uint8_t call_arg_param;  // 0-based param index passed to unknown_call(aK)
  uint32_t call_ssa_id;    // 69 for 8-insn direct vcall, 62 for 10-insn swap vcall
  uint64_t blr_va;
  uint64_t ret_va;
};

static bool match_vcall_pattern(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    VcallPlan* plan) {
  if (word_count != 8u && word_count != 10u) return false;
  if (base_addr > UINT64_MAX - static_cast<uint64_t>(word_count - 1u) * 4ULL) {
    return false;
  }

  // Common frame prologue & epilogue:
  //   [0] stp x29, x30, [sp, #-frame]!
  //   [1] mov x29, sp
  //   [N-2] ldp x29, x30, [sp], #frame
  //   [N-1] ret
  const uint32_t frame_pre = decode_stp_fp_lr_pre(words[0]);
  if (frame_pre == 0u) return false;
  if (words[1] != kArm64MovFpSpWord) return false;
  const uint32_t frame_post = decode_ldp_fp_lr_post(words[word_count - 2u]);
  if (frame_post != frame_pre) return false;
  if (words[word_count - 1u] != kArm64RetWord) return false;

  if (word_count == 8u) {
    // Pattern 1 (8 insns):
    //   [2] ldr xT, [xRecv, #0]
    //   [3] movz wArg/xArg, #imm  (arg reg 1..7)
    //   [4] ldr xT, [xT, #0]
    //   [5] blr xT                (non-PAC strictly)
    const DecodedLdrUoff l0 = decode_ldr_uoff(words[2]);
    const DecodedMovz mv = decode_movz(words[3]);
    const DecodedLdrUoff l1 = decode_ldr_uoff(words[4]);
    const DecodedBlr blr = decode_blr_non_pac(words[5]);

    if (!l0.valid || !l0.is_64 || !is_scratch_reg(l0.rt) || l0.rn != 0u || l0.disp != 0u) {
      return false;
    }
    if (!mv.valid || mv.rd == 0u || mv.rd >= 8u || mv.rd == l0.rt) {
      return false;
    }
    if (!l1.valid || !l1.is_64 || l1.rn != l0.rt || l1.rt != l0.rt || l1.disp != 0u) {
      return false;
    }
    if (!blr.valid || blr.rn != l1.rt) {
      return false;
    }

    plan->frame_bytes = frame_pre;
    plan->num_params = 1u;
    plan->call_arg_param = 0u;
    plan->call_ssa_id = 69u;
    plan->blr_va = base_addr + 5u * 4ULL;
    plan->ret_va = base_addr + 7u * 4ULL;
    return true;
  }

  // Pattern 2 (10 insns):
  //   [2] ldr xT, [x1, #0]          (contiguous arg: xRecv == x1, xT in 8..15)
  //   [3] mov xTmp, x1              (xTmp in 8..15, xTmp != xT)
  //   [4] ldr wArg/xArg, [x0, #disp] (contiguous arg: xSelf == x0, arg in 1..7)
  //   [5] mov x0, xTmp
  //   [6] ldr xT, [xT, #0]
  //   [7] blr xT                    (non-PAC strictly)
  const DecodedLdrUoff l0 = decode_ldr_uoff(words[2]);
  const DecodedMovReg mv_save = decode_mov_reg(words[3]);
  const DecodedLdrUoff l_arg = decode_ldr_uoff(words[4]);
  const DecodedMovReg mv_x0 = decode_mov_reg(words[5]);
  const DecodedLdrUoff l1 = decode_ldr_uoff(words[6]);
  const DecodedBlr blr = decode_blr_non_pac(words[7]);

  if (!l0.valid || !l0.is_64 || !is_scratch_reg(l0.rt) || l0.rn != 1u || l0.disp != 0u) {
    return false;
  }
  if (!mv_save.valid || !mv_save.is_64 || !is_scratch_reg(mv_save.rd) ||
      mv_save.rd == l0.rt || mv_save.rm != l0.rn) {
    return false;
  }
  if (!l_arg.valid || l_arg.rn != 0u || l_arg.rt == 0u || l_arg.rt >= 8u) {
    return false;
  }
  if (!mv_x0.valid || !mv_x0.is_64 || mv_x0.rd != 0u || mv_x0.rm != mv_save.rd) {
    return false;
  }
  if (!l1.valid || !l1.is_64 || l1.rn != l0.rt || l1.rt != l0.rt || l1.disp != 0u) {
    return false;
  }
  if (!blr.valid || blr.rn != l1.rt) {
    return false;
  }

  const uint8_t max_p = l0.rn > l_arg.rn ? l0.rn : l_arg.rn;
  plan->frame_bytes = frame_pre;
  plan->num_params = static_cast<uint32_t>(max_p) + 1u;
  plan->call_arg_param = l0.rn;
  plan->call_ssa_id = 62u;
  plan->blr_va = base_addr + 7u * 4ULL;
  plan->ret_va = base_addr + 9u * 4ULL;
  return true;
}

}  // namespace

HexStatus try_emit_arm64_frame_vcall(
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

  uint32_t name_start = 0u;
  if (!validate_func_name(func_name, func_name_len, &name_start)) {
    return HEX_ERR_UNSUPPORTED;
  }

  VcallPlan plan{};
  if (!match_vcall_pattern(words, word_count, base_addr, &plan)) {
    return HEX_ERR_UNSUPPORTED;
  }

  const size_t mark = emit_arena.used();
  const uint32_t text_cap = 2048u + func_name_len;
  const uint32_t lm_cap = 16u;
  char* text_buf = emit_arena.alloc<char>(text_cap);
  HexLineMapEntry* lm_buf = emit_arena.alloc<HexLineMapEntry>(lm_cap);
  if (text_buf == nullptr || lm_buf == nullptr) {
    emit_arena.restore(mark);
    return HEX_ERR_OOM;
  }

  EmitWriter w{};
  w.init(text_buf, text_cap, lm_buf, lm_cap);

  const bool js_parity = (emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u;
  if (js_parity) {
    w.put_cstr(
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
        "#ifndef __HEX_ANY_ARGS\n"
        "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
        "#define __HEX_ANY_ARGS ...\n"
        "#else\n"
        "#define __HEX_ANY_ARGS\n"
        "#endif\n"
        "#endif\n"
        "uint64 unknown_call (__HEX_ANY_ARGS);\n");
  }

  // Signature line
  w.map_addr(0u, base_addr);
  w.put_cstr("uint64 ");
  if (func_name != nullptr && name_start < func_name_len) {
    w.put_n(func_name + name_start, func_name_len - name_start);
  } else {
    w.put_cstr("sub_");
    w.put_u64_hex(base_addr, false);
  }
  w.put_char('(');
  if (plan.num_params == 0u) {
    w.put_cstr("void");
  } else {
    for (uint32_t p = 0u; p < plan.num_params; ++p) {
      if (p > 0u) w.put_cstr(", ");
      w.put_cstr("uint64 ");
      w.put_param(static_cast<uint8_t>(p));
    }
  }
  w.put_cstr(")\n{\n");

  // Local declarations: local_m<frame>, local_x29, local_m<frame-8>, local_x30, call_<id>
  const uint64_t fp_off = static_cast<uint64_t>(plan.frame_bytes);
  const uint64_t lr_off = fp_off - 8ULL;

  w.put_cstr("    uint64 local_m");
  w.put_u64_hex(fp_off, true);
  w.put_cstr(";\n");
  w.put_cstr("    uint64 local_x29;\n");
  w.put_cstr("    uint64 local_m");
  w.put_u64_hex(lr_off, true);
  w.put_cstr(";\n");
  w.put_cstr("    uint64 local_x30;\n");
  w.put_cstr("    uint64 call_");
  w.put_u64_dec(plan.call_ssa_id);
  w.put_cstr(";\n");

  // Frame save assignments (mapped to stp VA)
  w.map_addr(0u, base_addr);
  w.put_cstr("    local_m");
  w.put_u64_hex(fp_off, true);
  w.put_cstr(" = local_x29;\n");

  w.map_addr(0u, base_addr);
  w.put_cstr("    local_m");
  w.put_u64_hex(lr_off, true);
  w.put_cstr(" = local_x30;\n");

  // Indirect call statement (mapped to blr VA)
  w.map_addr(0u, plan.blr_va);
  w.put_cstr("    call_");
  w.put_u64_dec(plan.call_ssa_id);
  w.put_cstr(" = unknown_call(");
  w.put_param(plan.call_arg_param);
  w.put_cstr(");\n");

  // Return statement (mapped to blr + ret VAs)
  w.map_addr(0u, plan.blr_va);
  w.map_addr(0u, plan.ret_va);
  w.put_cstr("    return call_");
  w.put_u64_dec(plan.call_ssa_id);
  w.put_cstr(";\n}");

  if (w.overflow) {
    emit_arena.restore(mark);
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
