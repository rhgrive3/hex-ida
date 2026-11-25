#include "arm64_branch_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kArm64RetWord = 0xd65f03c0u;
static constexpr uint32_t kMaxParams = 8u;

enum class CmpCond : uint8_t {
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

struct DecodedCmp {
  bool valid;
  bool is_64;
  bool is_imm;
  uint8_t rn;
  uint8_t rm;
  uint64_t imm;
};

struct DecodedArith {
  bool valid;
  bool is_64;
  bool is_sub;
  bool is_imm;
  uint8_t rd;
  uint8_t rn;
  uint8_t rm;
  uint64_t imm;
};

struct DecodedMovImm {
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

struct DecodedCondBr {
  bool valid;
  CmpCond cond;
  int32_t offset_words;
};

struct DecodedBranch {
  bool valid;
  int32_t offset_words;
};

static CmpCond parse_cond(uint32_t raw) {
  switch (raw & 0xfu) {
    case 0u: return CmpCond::EQ;
    case 1u: return CmpCond::NE;
    case 2u: return CmpCond::HS;
    case 3u: return CmpCond::LO;
    case 8u: return CmpCond::HI;
    case 9u: return CmpCond::LS;
    case 10u: return CmpCond::GE;
    case 11u: return CmpCond::LT;
    case 12u: return CmpCond::GT;
    case 13u: return CmpCond::LE;
    default: return CmpCond::INVALID;
  }
}

static CmpCond invert_cond(CmpCond c) {
  switch (c) {
    case CmpCond::EQ: return CmpCond::NE;
    case CmpCond::NE: return CmpCond::EQ;
    case CmpCond::HS: return CmpCond::LO;
    case CmpCond::LO: return CmpCond::HS;
    case CmpCond::HI: return CmpCond::LS;
    case CmpCond::LS: return CmpCond::HI;
    case CmpCond::GE: return CmpCond::LT;
    case CmpCond::LT: return CmpCond::GE;
    case CmpCond::GT: return CmpCond::LE;
    case CmpCond::LE: return CmpCond::GT;
    default: return CmpCond::INVALID;
  }
}

static bool is_signed_cond(CmpCond c) {
  return c == CmpCond::GE || c == CmpCond::LT || c == CmpCond::GT || c == CmpCond::LE;
}

static const char* cond_op_str(CmpCond c) {
  switch (c) {
    case CmpCond::EQ: return "==";
    case CmpCond::NE: return "!=";
    case CmpCond::HS: return ">=";
    case CmpCond::LO: return "<";
    case CmpCond::HI: return ">";
    case CmpCond::LS: return "<=";
    case CmpCond::GE: return ">=";
    case CmpCond::LT: return "<";
    case CmpCond::GT: return ">";
    case CmpCond::LE: return "<=";
    default: return nullptr;
  }
}

static DecodedCmp decode_cmp(uint32_t w) {
  DecodedCmp out{};
  out.valid = false;
  // CMP (immediate): sf 1 1 10001 sh(2) imm12(12) Rn(5) 11111
  if ((w & 0x7f00001fu) == 0x7100001fu) {
    const uint32_t sh = (w >> 22) & 3u;
    if (sh >= 2u) return out;  // unallocated shift encoding
    const uint32_t rn = (w >> 5) & 0x1fu;
    if (rn == 31u) return out;
    const uint32_t imm12 = (w >> 10) & 0xfffu;
    out.valid = true;
    out.is_64 = ((w >> 31) & 1u) != 0u;
    out.is_imm = true;
    out.rn = static_cast<uint8_t>(rn);
    out.rm = 0u;
    out.imm = sh == 1u ? (static_cast<uint64_t>(imm12) << 12) : static_cast<uint64_t>(imm12);
    return out;
  }
  // CMP (shifted register, shift=0, imm6=0): sf 1 1 01011 00 0 Rm(5) 000000 Rn(5) 11111
  if ((w & 0x7fe0fc1fu) == 0x6b00001fu) {
    const uint32_t rn = (w >> 5) & 0x1fu;
    const uint32_t rm = (w >> 16) & 0x1fu;
    if (rn == 31u || rm == 31u) return out;
    out.valid = true;
    out.is_64 = ((w >> 31) & 1u) != 0u;
    out.is_imm = false;
    out.rn = static_cast<uint8_t>(rn);
    out.rm = static_cast<uint8_t>(rm);
    out.imm = 0u;
    return out;
  }
  return out;
}

static DecodedArith decode_arith(uint32_t w) {
  DecodedArith out{};
  out.valid = false;
  // ADD/SUB (immediate, S=0): sf op 0 10001 sh(2) imm12(12) Rn(5) Rd(5)
  if ((w & 0x3f000000u) == 0x11000000u) {
    const uint32_t sh = (w >> 22) & 3u;
    if (sh >= 2u) return out;
    const uint32_t rd = w & 0x1fu;
    const uint32_t rn = (w >> 5) & 0x1fu;
    if (rd == 31u || rn == 31u) return out;
    const uint32_t imm12 = (w >> 10) & 0xfffu;
    out.valid = true;
    out.is_64 = ((w >> 31) & 1u) != 0u;
    out.is_sub = ((w >> 30) & 1u) != 0u;
    out.is_imm = true;
    out.rd = static_cast<uint8_t>(rd);
    out.rn = static_cast<uint8_t>(rn);
    out.rm = 0u;
    out.imm = sh == 1u ? (static_cast<uint64_t>(imm12) << 12) : static_cast<uint64_t>(imm12);
    return out;
  }
  // ADD/SUB (shifted register, S=0, shift=0, imm6=0): sf op 0 01011 00 0 Rm(5) 000000 Rn(5) Rd(5)
  if ((w & 0x3fe0fc00u) == 0x0b000000u) {
    const uint32_t rd = w & 0x1fu;
    const uint32_t rn = (w >> 5) & 0x1fu;
    const uint32_t rm = (w >> 16) & 0x1fu;
    if (rd == 31u || rn == 31u || rm == 31u) return out;
    out.valid = true;
    out.is_64 = ((w >> 31) & 1u) != 0u;
    out.is_sub = ((w >> 30) & 1u) != 0u;
    out.is_imm = false;
    out.rd = static_cast<uint8_t>(rd);
    out.rn = static_cast<uint8_t>(rn);
    out.rm = static_cast<uint8_t>(rm);
    out.imm = 0u;
    return out;
  }
  return out;
}

static DecodedMovImm decode_mov_imm(uint32_t w) {
  DecodedMovImm out{};
  out.valid = false;
  // MOVZ: sf 10 100101 hw(2) imm16(16) Rd(5)
  if ((w & 0x7f800000u) == 0x52800000u) {
    const bool is_64 = ((w >> 31) & 1u) != 0u;
    const uint32_t hw = (w >> 21) & 3u;
    if (!is_64 && hw >= 2u) return out;  // unallocated 32-bit MOVZ hw>=2
    const uint32_t rd = w & 0x1fu;
    if (rd == 31u) return out;
    const uint64_t imm16 = (w >> 5) & 0xffffu;
    out.valid = true;
    out.is_64 = is_64;
    out.rd = static_cast<uint8_t>(rd);
    out.imm = imm16 << (hw * 16u);
    return out;
  }
  return out;
}

static DecodedMovReg decode_mov_reg(uint32_t w) {
  DecodedMovReg out{};
  out.valid = false;
  // MOV (register) = ORR Rd, WZR/XZR, Rm (shift=0, imm6=0): sf 01 01010 00 0 Rm(5) 000000 11111 Rd(5)
  if ((w & 0x7fe0ffe0u) == 0x2a0003e0u) {
    const uint32_t rd = w & 0x1fu;
    const uint32_t rm = (w >> 16) & 0x1fu;
    if (rd == 31u || rm == 31u) return out;
    out.valid = true;
    out.is_64 = ((w >> 31) & 1u) != 0u;
    out.rd = static_cast<uint8_t>(rd);
    out.rm = static_cast<uint8_t>(rm);
    return out;
  }
  return out;
}

static DecodedCondBr decode_cond_br(uint32_t w) {
  DecodedCondBr out{};
  out.valid = false;
  // B.cond: 01010100 imm19(19) 0 cond(4)
  if ((w & 0xff000010u) == 0x54000000u) {
    const CmpCond c = parse_cond(w & 0xfu);
    if (c == CmpCond::INVALID) return out;
    int32_t imm19 = static_cast<int32_t>((w >> 5) & 0x7ffffu);
    if ((imm19 & 0x40000) != 0) imm19 -= 0x80000;
    out.valid = true;
    out.cond = c;
    out.offset_words = imm19;
    return out;
  }
  return out;
}

static DecodedBranch decode_branch(uint32_t w) {
  DecodedBranch out{};
  out.valid = false;
  // B: 000101 imm26(26)
  if ((w & 0xfc000000u) == 0x14000000u) {
    int32_t imm26 = static_cast<int32_t>(w & 0x03ffffffu);
    if ((imm26 & 0x02000000) != 0) imm26 -= 0x04000000;
    out.valid = true;
    out.offset_words = imm26;
    return out;
  }
  return out;
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
    if (s == nullptr) {
      overflow = true;
      return;
    }
    if (n >= cap || len > cap - 1u - n) {
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

  void put_u64_hex_lower(uint64_t v) {
    static const char kHex[] = "0123456789abcdef";
    char tmp[16];
    uint32_t n = 0u;
    if (v == 0u) {
      tmp[n++] = '0';
    } else {
      while (v > 0u) {
        tmp[n++] = kHex[v & 0xfu];
        v >>= 4;
      }
    }
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_param_name(uint8_t reg) {
    put_char('a');
    put_u64_dec(static_cast<uint64_t>(reg) + 1u);
  }

  void put_func_name(const char* name, uint32_t name_len, uint64_t base_addr) {
    if (name != nullptr && name_len > 0u) {
      uint32_t start = 0u;
      while (start < name_len && name[start] == '_') ++start;
      if (start < name_len) {
        put_n(name + start, name_len - start);
        return;
      }
    }
    put_cstr("sub_");
    put_u64_hex_lower(base_addr);
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

static const char* cast_for_cmp(bool is_64, CmpCond cond) {
  if (is_signed_cond(cond)) {
    return is_64 ? "(int64_t)" : "(int32_t)";
  }
  return is_64 ? "(uint64_t)" : "(uint32_t)";
}

static void emit_typedef_prelude(
    EmitWriter& w,
    bool need_int32,
    bool need_uint64,
    bool need_int32_t,
    bool need_uint32_t,
    bool need_int64_t,
    bool need_uint64_t) {
  w.put_cstr("/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n");
  if (need_int32) w.put_cstr("typedef __INT32_TYPE__ int32;\n");
  if (need_uint64) w.put_cstr("typedef __UINT64_TYPE__ uint64;\n");
  if (need_int32_t) w.put_cstr("typedef __INT32_TYPE__ int32_t;\n");
  if (need_uint32_t) w.put_cstr("typedef __UINT32_TYPE__ uint32_t;\n");
  if (need_int64_t) w.put_cstr("typedef __INT64_TYPE__ int64_t;\n");
  if (need_uint64_t) w.put_cstr("typedef __UINT64_TYPE__ uint64_t;\n");
}

static void emit_arith_rhs_params(EmitWriter& w, const DecodedArith& op) {
  w.put_param_name(op.rn);
  w.put_cstr(op.is_sub ? " - " : " + ");
  if (op.is_imm) {
    w.put_u64_dec(op.imm);
  } else {
    w.put_param_name(op.rm);
  }
}

static HexStatus try_emit_if_else(
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
  // Canonical 2-way diamond:
  //   0: cmp xN/wN, (#imm | xM/wM)
  //   1: b.cond +3  (-> 4)
  //   2: add/sub x0/w0, ... (fallthrough branch)
  //   3: b +2       (-> 5)
  //   4: add/sub x0/w0, ... (taken branch)
  //   5: ret
  if (word_count != 6u) return HEX_ERR_UNSUPPORTED;
  if (words[5] != kArm64RetWord) return HEX_ERR_UNSUPPORTED;

  const DecodedCmp cmp = decode_cmp(words[0]);
  const DecodedCondBr cbr = decode_cond_br(words[1]);
  const DecodedArith fall = decode_arith(words[2]);
  const DecodedBranch br = decode_branch(words[3]);
  const DecodedArith taken = decode_arith(words[4]);

  if (!cmp.valid || !cbr.valid || !fall.valid || !br.valid || !taken.valid) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (cbr.offset_words != 3 || br.offset_words != 2) {
    return HEX_ERR_UNSUPPORTED;
  }
  // Both branches must write return register r0 with consistent width.
  if (fall.rd != 0u || taken.rd != 0u) return HEX_ERR_UNSUPPORTED;
  if (fall.is_64 != taken.is_64) return HEX_ERR_UNSUPPORTED;

  // All source registers must be AAPCS64 parameter registers (r0..r7).
  uint8_t max_param = 0u;
  auto track_param = [&](uint8_t r) -> bool {
    if (r >= kMaxParams) return false;
    if (r > max_param) max_param = r;
    return true;
  };
  if (!track_param(cmp.rn)) return HEX_ERR_UNSUPPORTED;
  if (!cmp.is_imm && !track_param(cmp.rm)) return HEX_ERR_UNSUPPORTED;
  if (!track_param(fall.rn)) return HEX_ERR_UNSUPPORTED;
  if (!fall.is_imm && !track_param(fall.rm)) return HEX_ERR_UNSUPPORTED;
  if (!track_param(taken.rn)) return HEX_ERR_UNSUPPORTED;
  if (!taken.is_imm && !track_param(taken.rm)) return HEX_ERR_UNSUPPORTED;

  const uint32_t param_count = static_cast<uint32_t>(max_param) + 1u;
  const bool ret_is_64 = fall.is_64;
  const bool js_parity = (emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u;
  const bool cmp_signed = is_signed_cond(cbr.cond);
  const char* cond_op = cond_op_str(cbr.cond);
  if (cond_op == nullptr) return HEX_ERR_UNSUPPORTED;

  const size_t mark = emit_arena.used();
  const uint32_t text_cap = 2048u + func_name_len;
  const uint32_t lm_cap = 32u;
  char* text_buf = emit_arena.alloc<char>(text_cap);
  HexLineMapEntry* lm_buf = emit_arena.alloc<HexLineMapEntry>(lm_cap);
  if (text_buf == nullptr || lm_buf == nullptr) {
    emit_arena.restore(mark);
    return HEX_ERR_OOM;
  }

  EmitWriter w{};
  w.init(text_buf, text_cap, lm_buf, lm_cap);

  if (js_parity) {
    emit_typedef_prelude(
        w,
        !ret_is_64,
        true,
        !cmp.is_64 && cmp_signed,
        !cmp.is_64 && !cmp_signed,
        cmp.is_64 && cmp_signed,
        cmp.is_64 && !cmp_signed);
  }

  // Signature line
  w.map_addr(0u, base_addr);
  w.put_cstr(ret_is_64 ? "uint64 " : "int32 ");
  w.put_func_name(func_name, func_name_len, base_addr);
  w.put_char('(');
  if (param_count == 0u) {
    w.put_cstr("void");
  } else {
    for (uint32_t p = 0u; p < param_count; ++p) {
      if (p > 0u) w.put_cstr(", ");
      w.put_cstr("uint64 ");
      w.put_param_name(static_cast<uint8_t>(p));
    }
  }
  w.put_cstr(")\n{\n");

  // Local phi declaration
  w.put_cstr("    uint64 phi_46;\n");

  // if (<cond>) {
  w.map_addr(0u, base_addr + 0u);
  w.map_addr(0u, base_addr + 4u);
  w.put_cstr("    if (");
  const char* cast = cast_for_cmp(cmp.is_64, cbr.cond);
  w.put_cstr(cast);
  w.put_param_name(cmp.rn);
  w.put_char(' ');
  w.put_cstr(cond_op);
  w.put_char(' ');
  if (cmp.is_imm) {
    w.put_u64_dec(cmp.imm);
  } else {
    w.put_cstr(cast);
    w.put_param_name(cmp.rm);
  }
  w.put_cstr(") {\n");

  // Taken branch body
  w.map_addr(1u, base_addr + 8u);
  w.map_addr(1u, base_addr + 16u);
  w.put_cstr("        phi_46 = ");
  emit_arith_rhs_params(w, taken);
  w.put_cstr(";\n");

  // } else {
  w.put_cstr("    } else {\n");

  // Fallthrough branch body
  w.map_addr(2u, base_addr + 8u);
  w.map_addr(2u, base_addr + 12u);
  w.put_cstr("        phi_46 = ");
  emit_arith_rhs_params(w, fall);
  w.put_cstr(";\n");

  w.put_cstr("    }\n");

  // return phi_46;
  w.map_addr(3u, base_addr + 8u);
  w.map_addr(3u, base_addr + 16u);
  w.map_addr(3u, base_addr + 20u);
  w.put_cstr("    return phi_46;\n}");

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

static void emit_loop_reg_name(
    EmitWriter& w,
    uint8_t reg,
    uint8_t phi_lo_reg,
    uint8_t phi_hi_reg) {
  if (reg == phi_lo_reg) {
    w.put_cstr("phi_77");
  } else if (reg == phi_hi_reg) {
    w.put_cstr("phi_86");
  } else {
    w.put_param_name(reg);
  }
}

static HexStatus try_emit_counting_while(
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
  // Canonical counting while loop:
  //   0: mov rA, #initA
  //   1: mov rB, #initB
  //   2: cmp r_idx, (r_bound | #imm)    [loop header]
  //   3: b.cond +4  (-> 7)              [loop exit branch]
  //   4: add/sub r_u0, ...              [loop body stmt 1]
  //   5: add/sub r_u1, ...              [loop body stmt 2]
  //   6: b -4       (-> 2)              [loop backedge]
  //   7: mov r0, r_acc                  [exit return copy]
  //   8: ret
  if (word_count != 9u) return HEX_ERR_UNSUPPORTED;
  if (words[8] != kArm64RetWord) return HEX_ERR_UNSUPPORTED;

  const DecodedMovImm init0 = decode_mov_imm(words[0]);
  const DecodedMovImm init1 = decode_mov_imm(words[1]);
  const DecodedCmp cmp = decode_cmp(words[2]);
  const DecodedCondBr exit_cbr = decode_cond_br(words[3]);
  const DecodedArith body0 = decode_arith(words[4]);
  const DecodedArith body1 = decode_arith(words[5]);
  const DecodedBranch back_br = decode_branch(words[6]);
  const DecodedMovReg ret_mov = decode_mov_reg(words[7]);

  if (!init0.valid || !init1.valid || !cmp.valid || !exit_cbr.valid ||
      !body0.valid || !body1.valid || !back_br.valid || !ret_mov.valid) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (exit_cbr.offset_words != 4 || back_br.offset_words != -4) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Two distinct loop-carried registers (must not clobber r0 before exit).
  if (init0.rd == init1.rd || init0.rd == 0u || init1.rd == 0u) {
    return HEX_ERR_UNSUPPORTED;
  }
  const uint8_t r_lo = init0.rd < init1.rd ? init0.rd : init1.rd;
  const uint8_t r_hi = init0.rd < init1.rd ? init1.rd : init0.rd;
  const uint64_t init_lo_val = init0.rd < init1.rd ? init0.imm : init1.imm;
  const uint64_t init_hi_val = init0.rd < init1.rd ? init1.imm : init0.imm;
  const uint32_t init_lo_idx = init0.rd < init1.rd ? 0u : 1u;
  const uint32_t init_hi_idx = init0.rd < init1.rd ? 1u : 0u;

  auto is_phi_reg = [&](uint8_t r) -> bool {
    return r == r_lo || r == r_hi;
  };

  // Exit mov must move one of the loop-carried registers into r0.
  if (ret_mov.rd != 0u || !is_phi_reg(ret_mov.rm)) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Loop body statements must each update one distinct loop-carried register.
  if (!is_phi_reg(body0.rd) || !is_phi_reg(body1.rd) || body0.rd == body1.rd) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Validate all operand registers are either phi regs or AAPCS64 params (r0..r7, non-phi).
  uint8_t max_param = 0u;
  bool has_param = false;
  auto check_op_reg = [&](uint8_t r) -> bool {
    if (is_phi_reg(r)) return true;
    if (r >= kMaxParams) return false;
    if (!has_param || r > max_param) max_param = r;
    has_param = true;
    return true;
  };

  // Header cmp must reference at least one loop-carried register on LHS.
  if (!is_phi_reg(cmp.rn)) return HEX_ERR_UNSUPPORTED;
  if (!cmp.is_imm && !check_op_reg(cmp.rm)) return HEX_ERR_UNSUPPORTED;
  if (!check_op_reg(body0.rn)) return HEX_ERR_UNSUPPORTED;
  if (!body0.is_imm && !check_op_reg(body0.rm)) return HEX_ERR_UNSUPPORTED;
  if (!check_op_reg(body1.rn)) return HEX_ERR_UNSUPPORTED;
  if (!body1.is_imm && !check_op_reg(body1.rm)) return HEX_ERR_UNSUPPORTED;

  const CmpCond while_cond = invert_cond(exit_cbr.cond);
  const char* while_op = cond_op_str(while_cond);
  if (while_op == nullptr) return HEX_ERR_UNSUPPORTED;

  const uint32_t param_count = has_param ? (static_cast<uint32_t>(max_param) + 1u) : 0u;
  const bool ret_is_64 = ret_mov.is_64;
  const bool js_parity = (emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u;
  const bool cmp_signed = is_signed_cond(while_cond);

  const size_t mark = emit_arena.used();
  const uint32_t text_cap = 2048u + func_name_len;
  const uint32_t lm_cap = 64u;
  char* text_buf = emit_arena.alloc<char>(text_cap);
  HexLineMapEntry* lm_buf = emit_arena.alloc<HexLineMapEntry>(lm_cap);
  if (text_buf == nullptr || lm_buf == nullptr) {
    emit_arena.restore(mark);
    return HEX_ERR_OOM;
  }

  EmitWriter w{};
  w.init(text_buf, text_cap, lm_buf, lm_cap);

  if (js_parity) {
    emit_typedef_prelude(
        w,
        !ret_is_64,
        true,
        !cmp.is_64 && cmp_signed,
        !cmp.is_64 && !cmp_signed,
        cmp.is_64 && cmp_signed,
        cmp.is_64 && !cmp_signed);
  }

  // Signature line
  w.map_addr(0u, base_addr);
  w.put_cstr(ret_is_64 ? "uint64 " : "int32 ");
  w.put_func_name(func_name, func_name_len, base_addr);
  w.put_char('(');
  for (uint32_t p = 0u; p < param_count; ++p) {
    if (p > 0u) w.put_cstr(", ");
    w.put_cstr("uint64 ");
    w.put_param_name(static_cast<uint8_t>(p));
  }
  w.put_cstr(")\n{\n");

  // Local phi declarations (ordered by register number: r_lo -> phi_77, r_hi -> phi_86)
  w.put_cstr("    uint64 phi_77;\n");
  w.put_cstr("    uint64 phi_86;\n");

  // Initializations in phi order
  w.map_addr(0u, base_addr + static_cast<uint64_t>(init_lo_idx) * 4u);
  w.put_cstr("    phi_77 = ");
  w.put_u64_dec(init_lo_val);
  w.put_cstr(";\n");

  w.map_addr(0u, base_addr + static_cast<uint64_t>(init_hi_idx) * 4u);
  if (init_hi_idx != init_lo_idx) {
    w.map_addr(0u, base_addr + static_cast<uint64_t>(init_lo_idx) * 4u);
  }
  w.put_cstr("    phi_86 = ");
  w.put_u64_dec(init_hi_val);
  w.put_cstr(";\n");

  // while (<negated_cond>) {
  w.map_addr(1u, base_addr + 8u);
  w.map_addr(1u, base_addr + 12u);
  w.put_cstr("    while (");
  const char* cast = cast_for_cmp(cmp.is_64, while_cond);
  w.put_cstr(cast);
  emit_loop_reg_name(w, cmp.rn, r_lo, r_hi);
  w.put_char(' ');
  w.put_cstr(while_op);
  w.put_char(' ');
  if (cmp.is_imm) {
    w.put_u64_dec(cmp.imm);
  } else {
    w.put_cstr(cast);
    emit_loop_reg_name(w, cmp.rm, r_lo, r_hi);
  }
  w.put_cstr(") {\n");

  // Loop body statement 1 (words[4])
  w.map_addr(2u, base_addr + 0u);
  w.map_addr(2u, base_addr + 16u);
  w.map_addr(2u, base_addr + 4u);
  w.map_addr(2u, base_addr + 20u);
  w.map_addr(2u, base_addr + 24u);
  w.put_cstr("        ");
  emit_loop_reg_name(w, body0.rd, r_lo, r_hi);
  w.put_cstr(" = ");
  emit_loop_reg_name(w, body0.rn, r_lo, r_hi);
  w.put_cstr(body0.is_sub ? " - " : " + ");
  if (body0.is_imm) {
    w.put_u64_dec(body0.imm);
  } else {
    emit_loop_reg_name(w, body0.rm, r_lo, r_hi);
  }
  w.put_cstr(";\n");

  // Loop body statement 2 (words[5])
  w.map_addr(2u, base_addr + 4u);
  w.map_addr(2u, base_addr + 20u);
  w.map_addr(2u, base_addr + 24u);
  w.put_cstr("        ");
  emit_loop_reg_name(w, body1.rd, r_lo, r_hi);
  w.put_cstr(" = ");
  emit_loop_reg_name(w, body1.rn, r_lo, r_hi);
  w.put_cstr(body1.is_sub ? " - " : " + ");
  if (body1.is_imm) {
    w.put_u64_dec(body1.imm);
  } else {
    emit_loop_reg_name(w, body1.rm, r_lo, r_hi);
  }
  w.put_cstr(";\n");

  // continue;
  w.map_addr(2u, base_addr + 24u);
  w.map_addr(2u, base_addr + 16u);
  w.map_addr(2u, base_addr + 20u);
  w.put_cstr("        continue;\n");
  w.put_cstr("    }\n");

  // return <ret_phi>;
  w.map_addr(3u, base_addr + 28u);
  w.map_addr(3u, base_addr + 0u);
  w.map_addr(3u, base_addr + 16u);
  w.map_addr(3u, base_addr + 4u);
  w.map_addr(3u, base_addr + 20u);
  w.map_addr(3u, base_addr + 32u);
  w.put_cstr("    return ");
  emit_loop_reg_name(w, ret_mov.rm, r_lo, r_hi);
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

}  // namespace

HexStatus try_emit_arm64_branch_loop(
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
  if (func_name_len > 256u) return HEX_ERR_UNSUPPORTED;
  if (func_name != nullptr && func_name_len > 0u) {
    for (uint32_t i = 0u; i < func_name_len; ++i) {
      const char ch = func_name[i];
      const bool ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
                      (ch >= '0' && ch <= '9') || ch == '_';
      if (!ok) return HEX_ERR_UNSUPPORTED;
    }
  }

  if (word_count == 6u) {
    return try_emit_if_else(
        words, word_count, base_addr, func_name, func_name_len,
        emit_flags, emit_arena, out_text, out_len, out_linemap, out_linemap_count);
  }
  if (word_count == 9u) {
    return try_emit_counting_while(
        words, word_count, base_addr, func_name, func_name_len,
        emit_flags, emit_arena, out_text, out_len, out_linemap, out_linemap_count);
  }
  return HEX_ERR_UNSUPPORTED;
}

}  // namespace passes
}  // namespace decompiler
}  // namespace hex
