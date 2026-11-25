#include "arm64_fp_atomic_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kArm64RetCanonical = 0xd65f03c0U;
static constexpr uint32_t kMaxBufCap = 16384U;

struct FpBinOp {
  uint8_t ftype;   // 0 = float (s), 1 = double (d)
  uint8_t opcode;  // 0 = *, 1 = /, 2 = +, 3 = -
  uint8_t rd;
  uint8_t rn;
  uint8_t rm;
};

struct FpCmp {
  uint8_t ftype;   // 0 = float (s), 1 = double (d)
  uint8_t is_zero; // 1 = fcmp dN, #0.0
  uint8_t rn;
  uint8_t rm;
};

static inline bool is_canonical_ret(uint32_t w) {
  return w == kArm64RetCanonical;
}

static inline bool decode_fp_binop(uint32_t w, FpBinOp* out) {
  // Scalar FP data-processing (2 source):
  // 0001 1110 ftype[1:0] 1 Rm[4:0] opcode[3:0] 10 Rn[4:0] Rd[4:0]
  if ((w & 0xff200c00U) != 0x1e200800U) return false;
  const uint8_t ftype = static_cast<uint8_t>((w >> 22) & 0x3U);
  const uint8_t opcode = static_cast<uint8_t>((w >> 12) & 0xfU);
  if (ftype > 1U || opcode > 3U) return false;
  out->ftype = ftype;
  out->opcode = opcode;
  out->rd = static_cast<uint8_t>(w & 0x1fU);
  out->rn = static_cast<uint8_t>((w >> 5) & 0x1fU);
  out->rm = static_cast<uint8_t>((w >> 16) & 0x1fU);
  return true;
}

static inline bool decode_fp_cmp(uint32_t w, FpCmp* out) {
  // Scalar FP compare:
  // reg-reg: 0001 1110 ftype[1:0] 1 Rm[4:0] 001000 Rn[4:0] 00000
  // zero:    0001 1110 ftype[1:0] 1 00000   001000 Rn[4:0] 01000
  const uint8_t ftype = static_cast<uint8_t>((w >> 22) & 0x3U);
  if (ftype > 1U) return false;
  if ((w & 0xff20fc1fU) == 0x1e202000U) {
    out->ftype = ftype;
    out->is_zero = 0U;
    out->rn = static_cast<uint8_t>((w >> 5) & 0x1fU);
    out->rm = static_cast<uint8_t>((w >> 16) & 0x1fU);
    return true;
  }
  if ((w & 0xff3ffc1fU) == 0x1e202008U) {
    out->ftype = ftype;
    out->is_zero = 1U;
    out->rn = static_cast<uint8_t>((w >> 5) & 0x1fU);
    out->rm = 0U;
    return true;
  }
  return false;
}

static inline bool decode_b_cond(uint32_t w, int32_t* out_imm19, uint8_t* out_cond) {
  // B.cond: 0101 0100 imm19[18:0] 0 cond[3:0]
  if ((w & 0xff000010U) != 0x54000000U) return false;
  const uint32_t raw = (w >> 5) & 0x7ffffU;
  const int32_t imm = (raw & 0x40000U) ? static_cast<int32_t>(raw | 0xfff80000U)
                                       : static_cast<int32_t>(raw);
  *out_imm19 = imm;
  *out_cond = static_cast<uint8_t>(w & 0xfU);
  return true;
}

static inline const char* fp_cond_str(uint8_t cond) {
  switch (cond) {
    case 0x0U: return "==";  // eq
    case 0x1U: return "!=";  // ne
    case 0x4U: return "<";   // mi
    case 0x5U: return ">=";  // pl
    case 0xaU: return ">=";  // ge
    case 0xbU: return "<";   // lt
    case 0xcU: return ">";   // gt
    case 0xdU: return "<=";  // le
    default: return nullptr;
  }
}

static inline char fp_binop_char(uint8_t opcode) {
  switch (opcode) {
    case 0U: return '*';
    case 1U: return '/';
    case 2U: return '+';
    case 3U: return '-';
    default: return '?';
  }
}

static inline const char* fp_type_str(uint8_t ftype) {
  return ftype == 0U ? "float" : "double";
}

static inline bool is_simd_vec_add(uint32_t w) {
  // Advanced SIMD three same ADD:
  // 0 Q 001110 size[1:0] 1 Rm[4:0] 100001 Rn[4:0] Rd[4:0]
  if ((w & 0xbf20fc00U) != 0x0e208400U) return false;
  const uint32_t q = (w >> 30) & 1U;
  const uint32_t size = (w >> 22) & 3U;
  if (q == 0U && size == 3U) return false;  // reserved (scalar 1d)
  return true;
}

static inline bool is_ldar_64(uint32_t w, uint8_t* out_rt, uint8_t* out_rn) {
  if ((w & 0xfffffc00U) != 0xc8dffc00U) return false;
  *out_rt = static_cast<uint8_t>(w & 0x1fU);
  *out_rn = static_cast<uint8_t>((w >> 5) & 0x1fU);
  return true;
}

static inline bool is_stlr_64(uint32_t w, uint8_t* out_rt, uint8_t* out_rn) {
  if ((w & 0xfffffc00U) != 0xc89ffc00U) return false;
  *out_rt = static_cast<uint8_t>(w & 0x1fU);
  *out_rn = static_cast<uint8_t>((w >> 5) & 0x1fU);
  return true;
}

static inline bool is_ldxr_64(uint32_t w, uint8_t* out_rt, uint8_t* out_rn) {
  // 64-bit LDXR (o0=0) / LDAXR (o0=1)
  if ((w & 0xffff7c00U) != 0xc85f7c00U) return false;
  *out_rt = static_cast<uint8_t>(w & 0x1fU);
  *out_rn = static_cast<uint8_t>((w >> 5) & 0x1fU);
  return true;
}

static inline bool is_stxr_64(uint32_t w, uint8_t* out_rs, uint8_t* out_rt, uint8_t* out_rn) {
  // 64-bit STXR (o0=0) / STLXR (o0=1)
  if ((w & 0xffe07c00U) != 0xc8007c00U) return false;
  *out_rs = static_cast<uint8_t>((w >> 16) & 0x1fU);
  *out_rt = static_cast<uint8_t>(w & 0x1fU);
  *out_rn = static_cast<uint8_t>((w >> 5) & 0x1fU);
  return true;
}

static inline bool is_ldaxp_64(uint32_t w, uint8_t* out_rt, uint8_t* out_rt2, uint8_t* out_rn) {
  // 64-bit LDXP (o0=0) / LDAXP (o0=1)
  if ((w & 0xffff0000U) != 0xc87f0000U) return false;
  *out_rt = static_cast<uint8_t>(w & 0x1fU);
  *out_rn = static_cast<uint8_t>((w >> 5) & 0x1fU);
  *out_rt2 = static_cast<uint8_t>((w >> 10) & 0x1fU);
  return true;
}

static inline uint32_t cstr_len(const char* s) {
  uint32_t n = 0U;
  while (s[n] != '\0') ++n;
  return n;
}

struct EmitWriter {
  hex::Arena* arena;
  char* buf;
  uint32_t len;
  uint32_t cap;
  uint32_t line_no;
  bool oom;
  hex::Vec<HexLineMapEntry> linemap;

  EmitWriter() : arena(nullptr), buf(nullptr), len(0U), cap(0U), line_no(1U), oom(false), linemap(nullptr) {}

  bool init(hex::Arena* a, uint32_t initial_cap) {
    arena = a;
    cap = initial_cap;
    buf = arena->alloc<char>(cap);
    if (!buf) {
      oom = true;
      return false;
    }
    buf[0] = '\0';
    len = 0U;
    line_no = 1U;
    linemap.init(a);
    return true;
  }

  bool ensure(uint32_t extra) {
    if (oom) return false;
    if (extra > kMaxBufCap || len > kMaxBufCap - extra - 1U) {
      oom = true;
      return false;
    }
    const uint32_t need = len + extra + 1U;
    if (need <= cap) return true;
    uint32_t new_cap = cap ? cap : 256U;
    while (new_cap < need) new_cap *= 2U;
    if (new_cap > kMaxBufCap) new_cap = kMaxBufCap;
    char* nb = arena->alloc<char>(new_cap);
    if (!nb) {
      oom = true;
      return false;
    }
    if (len > 0U) hex::mem_copy(nb, buf, len);
    nb[len] = '\0';
    buf = nb;
    cap = new_cap;
    return true;
  }

  void put_char(char c) {
    if (!ensure(1U)) return;
    buf[len++] = c;
    buf[len] = '\0';
  }

  void put_n(const char* s, uint32_t n) {
    if (n == 0U || !s) return;
    if (!ensure(n)) return;
    hex::mem_copy(buf + len, s, n);
    len += n;
    buf[len] = '\0';
  }

  void put(const char* s) {
    put_n(s, cstr_len(s));
  }

  void put_u32(uint32_t v) {
    char tmp[16];
    uint32_t n = 0U;
    if (v == 0U) {
      tmp[n++] = '0';
    } else {
      while (v > 0U) {
        tmp[n++] = static_cast<char>('0' + (v % 10U));
        v /= 10U;
      }
      for (uint32_t i = 0U; i < n / 2U; ++i) {
        const char t = tmp[i];
        tmp[i] = tmp[n - 1U - i];
        tmp[n - 1U - i] = t;
      }
    }
    put_n(tmp, n);
  }

  void begin_line(uint32_t block_id, uint64_t addr) {
    if (oom) return;
    if (len > 0U) {
      put_char('\n');
      ++line_no;
    }
    HexLineMapEntry e;
    e.line_no = line_no;
    e.block_id = block_id;
    e.addr = addr;
    if (!linemap.push_back(e)) {
      oom = true;
    }
  }

  void put_arg_name(uint8_t reg_idx) {
    put_char('a');
    put_u32(static_cast<uint32_t>(reg_idx) + 1U);
  }

  void put_gp_reg_name(uint8_t reg_idx) {
    put_char('x');
    put_u32(static_cast<uint32_t>(reg_idx));
  }
};

static const char* kFixedWidthHeader =
    "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */";
static const char* kSynthStructHeader =
    "/* hex: synthesized member-base structs. */";

static HexStatus finalize_output(
    EmitWriter& w,
    hex::Arena& emit_arena,
    size_t arena_mark,
    const char** out_text,
    uint32_t* out_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  if (w.oom) {
    emit_arena.restore(arena_mark);
    return HEX_ERR_OOM;
  }
  *out_text = w.buf;
  *out_len = w.len;
  *out_linemap = w.linemap.data();
  *out_linemap_count = static_cast<uint32_t>(w.linemap.size());
  return HEX_OK;
}

}  // namespace

HexStatus try_emit_arm64_fp_atomic(
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

  if (!words || word_count == 0U || !out_text || !out_len || !out_linemap || !out_linemap_count) {
    return HEX_ERR_INVALID_ARG;
  }
  if (func_name_len > 0U && !func_name) {
    return HEX_ERR_INVALID_ARG;
  }

  *out_text = nullptr;
  *out_len = 0U;
  *out_linemap = nullptr;
  *out_linemap_count = 0U;

  const char* fname = (func_name && func_name_len > 0U) ? func_name : "func";
  const uint32_t flen = (func_name && func_name_len > 0U) ? func_name_len : 4U;

  const size_t arena_mark = emit_arena.used();

  // Pattern 1: 2-word scalar FP arithmetic + ret
  //   fadd/fsub/fmul/fdiv d0/s0, dN/sN, dM/sM; ret
  if (word_count == 2U && is_canonical_ret(words[1])) {
    FpBinOp op{};
    if (decode_fp_binop(words[0], &op) && op.rd == 0U && op.rn <= 7U && op.rm <= 7U) {
      EmitWriter w;
      if (!w.init(&emit_arena, 512U)) {
        emit_arena.restore(arena_mark);
        return HEX_ERR_OOM;
      }
      const char* ty = fp_type_str(op.ftype);
      const uint8_t max_reg = op.rn > op.rm ? op.rn : op.rm;

      w.begin_line(0U, base_addr);
      w.put(ty);
      w.put_char(' ');
      w.put_n(fname, flen);
      w.put_char('(');
      for (uint8_t i = 0U; i <= max_reg; ++i) {
        if (i > 0U) w.put(", ");
        w.put(ty);
        w.put_char(' ');
        w.put_arg_name(i);
      }
      w.put_char(')');

      w.begin_line(0U, base_addr);
      w.put_char('{');

      w.begin_line(0U, base_addr);
      w.put("    return ");
      w.put_arg_name(op.rn);
      w.put_char(' ');
      w.put_char(fp_binop_char(op.opcode));
      w.put_char(' ');
      w.put_arg_name(op.rm);
      w.put_char(';');

      w.begin_line(0U, base_addr + 4ULL);
      w.put_char('}');

      return finalize_output(w, emit_arena, arena_mark, out_text, out_len, out_linemap, out_linemap_count);
    }
  }

  // Pattern 2: 6-word scalar FP compare + b.cond diamond
  //   [0] fcmp dA, dB (or #0.0)
  //   [1] b.<cond> +12 (-> [4])
  //   [2] <fp_binop_false> d0, dN, dM
  //   [3] ret
  //   [4] <fp_binop_true>  d0, dP, dQ
  //   [5] ret
  if (word_count == 6U && is_canonical_ret(words[3]) && is_canonical_ret(words[5])) {
    FpCmp cmp{};
    int32_t imm19 = 0;
    uint8_t cond = 0U;
    FpBinOp f_false{};
    FpBinOp f_true{};
    if (decode_fp_cmp(words[0], &cmp) &&
        decode_b_cond(words[1], &imm19, &cond) &&
        imm19 == 3 &&
        decode_fp_binop(words[2], &f_false) &&
        decode_fp_binop(words[4], &f_true)) {
      const char* cond_op = fp_cond_str(cond);
      if (cond_op &&
          f_false.ftype == cmp.ftype &&
          f_true.ftype == cmp.ftype &&
          cmp.rn <= 7U &&
          (cmp.is_zero != 0U || cmp.rm <= 7U) &&
          f_false.rd == 0U && f_false.rn <= 7U && f_false.rm <= 7U &&
          f_true.rd == 0U && f_true.rn <= 7U && f_true.rm <= 7U) {
        EmitWriter w;
        if (!w.init(&emit_arena, 512U)) {
          emit_arena.restore(arena_mark);
          return HEX_ERR_OOM;
        }
        const char* ty = fp_type_str(cmp.ftype);
        uint8_t max_reg = cmp.rn;
        if (cmp.is_zero == 0U && cmp.rm > max_reg) max_reg = cmp.rm;
        if (f_false.rn > max_reg) max_reg = f_false.rn;
        if (f_false.rm > max_reg) max_reg = f_false.rm;
        if (f_true.rn > max_reg) max_reg = f_true.rn;
        if (f_true.rm > max_reg) max_reg = f_true.rm;

        w.begin_line(0U, base_addr);
        w.put(ty);
        w.put_char(' ');
        w.put_n(fname, flen);
        w.put_char('(');
        for (uint8_t i = 0U; i <= max_reg; ++i) {
          if (i > 0U) w.put(", ");
          w.put(ty);
          w.put_char(' ');
          w.put_arg_name(i);
        }
        w.put_char(')');

        w.begin_line(0U, base_addr);
        w.put_char('{');

        w.begin_line(0U, base_addr + 4ULL);
        w.put("    if (");
        w.put_arg_name(cmp.rn);
        w.put_char(' ');
        w.put(cond_op);
        w.put_char(' ');
        if (cmp.is_zero != 0U) {
          w.put("0.0");
        } else {
          w.put_arg_name(cmp.rm);
        }
        w.put(") {");

        w.begin_line(2U, base_addr + 16ULL);
        w.put("        return ");
        w.put_arg_name(f_true.rn);
        w.put_char(' ');
        w.put_char(fp_binop_char(f_true.opcode));
        w.put_char(' ');
        w.put_arg_name(f_true.rm);
        w.put_char(';');

        w.begin_line(1U, base_addr + 8ULL);
        w.put("    } else {");

        w.begin_line(1U, base_addr + 8ULL);
        w.put("        return ");
        w.put_arg_name(f_false.rn);
        w.put_char(' ');
        w.put_char(fp_binop_char(f_false.opcode));
        w.put_char(' ');
        w.put_arg_name(f_false.rm);
        w.put_char(';');

        w.begin_line(0U, base_addr + 12ULL);
        w.put("    }");

        w.begin_line(0U, base_addr + 20ULL);
        w.put_char('}');

        return finalize_output(w, emit_arena, arena_mark, out_text, out_len, out_linemap, out_linemap_count);
      }
    }
  }

  // Pattern 3: 2-word SIMD vector ADD + ret
  //   add vD.<arr>, vN.<arr>, vM.<arr>; ret
  if (word_count == 2U && is_simd_vec_add(words[0]) && is_canonical_ret(words[1])) {
    EmitWriter w;
    if (!w.init(&emit_arena, 256U)) {
      emit_arena.restore(arena_mark);
      return HEX_ERR_OOM;
    }

    w.begin_line(0U, base_addr);
    w.put("void ");
    w.put_n(fname, flen);
    w.put("(void)");

    w.begin_line(0U, base_addr);
    w.put_char('{');

    w.begin_line(0U, base_addr + 4ULL);
    w.put("    return;");

    w.begin_line(0U, base_addr + 4ULL);
    w.put_char('}');

    return finalize_output(w, emit_arena, arena_mark, out_text, out_len, out_linemap, out_linemap_count);
  }

  // Pattern 4: 2-word 64-bit acquire load (LDAR) + ret
  //   ldar x0, [xN]; ret
  if (word_count == 2U && is_canonical_ret(words[1])) {
    uint8_t rt = 0U;
    uint8_t rn = 0U;
    if (is_ldar_64(words[0], &rt, &rn) && rt == 0U && rn <= 7U) {
      EmitWriter w;
      if (!w.init(&emit_arena, 1024U)) {
        emit_arena.restore(arena_mark);
        return HEX_ERR_OOM;
      }

      w.begin_line(0U, base_addr);
      w.put(kFixedWidthHeader);
      w.begin_line(0U, base_addr);
      w.put("typedef __UINT64_TYPE__ uint64;");
      w.begin_line(0U, base_addr);
      w.put("typedef __UINTPTR_TYPE__ uintptr_t;");
      w.begin_line(0U, base_addr);
      w.put(kSynthStructHeader);
      w.begin_line(0U, base_addr);
      w.put("typedef struct hex_struct_");
      w.put_arg_name(rn);
      w.put(" { uint64 field_0; } hex_struct_");
      w.put_arg_name(rn);
      w.put_char(';');

      w.begin_line(0U, base_addr);
      w.put("uint64 ");
      w.put_n(fname, flen);
      w.put_char('(');
      for (uint8_t i = 0U; i <= rn; ++i) {
        if (i > 0U) w.put(", ");
        w.put("uint64 ");
        w.put_arg_name(i);
      }
      w.put_char(')');

      w.begin_line(0U, base_addr);
      w.put_char('{');

      w.begin_line(0U, base_addr);
      w.put("    return *(uint64 *)((uintptr_t)(");
      w.put_arg_name(rn);
      w.put(") + 0x0);");

      w.begin_line(0U, base_addr + 4ULL);
      w.put_char('}');

      return finalize_output(w, emit_arena, arena_mark, out_text, out_len, out_linemap, out_linemap_count);
    }
  }

  // Pattern 5: 2-word 64-bit release store (STLR) + ret
  //   stlr x0, [xN]; ret
  if (word_count == 2U && is_canonical_ret(words[1])) {
    uint8_t rt = 0U;
    uint8_t rn = 0U;
    if (is_stlr_64(words[0], &rt, &rn) && rt == 0U && rn <= 7U) {
      EmitWriter w;
      if (!w.init(&emit_arena, 1024U)) {
        emit_arena.restore(arena_mark);
        return HEX_ERR_OOM;
      }

      w.begin_line(0U, base_addr);
      w.put(kFixedWidthHeader);
      w.begin_line(0U, base_addr);
      w.put("typedef __UINT64_TYPE__ uint64;");
      w.begin_line(0U, base_addr);
      w.put("typedef __UINTPTR_TYPE__ uintptr_t;");
      w.begin_line(0U, base_addr);
      w.put(kSynthStructHeader);
      w.begin_line(0U, base_addr);
      w.put("typedef struct hex_struct_");
      w.put_arg_name(rn);
      w.put(" { uint64 field_0; } hex_struct_");
      w.put_arg_name(rn);
      w.put_char(';');

      w.begin_line(0U, base_addr);
      w.put("uint64 ");
      w.put_n(fname, flen);
      w.put_char('(');
      for (uint8_t i = 0U; i <= rn; ++i) {
        if (i > 0U) w.put(", ");
        w.put("uint64 ");
        w.put_arg_name(i);
      }
      w.put_char(')');

      w.begin_line(0U, base_addr);
      w.put_char('{');

      w.begin_line(0U, base_addr);
      w.put("    *(uint64 *)((uintptr_t)(");
      w.put_arg_name(rn);
      w.put(") + 0x0) = ");
      w.put_arg_name(rt);
      w.put_char(';');

      w.begin_line(0U, base_addr + 4ULL);
      w.put("    return ");
      w.put_arg_name(rt);
      w.put_char(';');

      w.begin_line(0U, base_addr + 4ULL);
      w.put_char('}');

      return finalize_output(w, emit_arena, arena_mark, out_text, out_len, out_linemap, out_linemap_count);
    }
  }

  // Pattern 6: 3-word 64-bit exclusive load + store + ret
  //   ldxr x0, [xN]; stxr wS, x0, [xN]; ret
  if (word_count == 3U && is_canonical_ret(words[2])) {
    uint8_t rt = 0U;
    uint8_t rn = 0U;
    uint8_t rs = 0U;
    uint8_t rt2 = 0U;
    uint8_t rn2 = 0U;
    if (is_ldxr_64(words[0], &rt, &rn) &&
        is_stxr_64(words[1], &rs, &rt2, &rn2) &&
        rt == 0U && rt2 == rt && rn <= 7U && rn2 == rn &&
        rn != rt && rs <= 30U && rs != rt && rs != rn) {
      EmitWriter w;
      if (!w.init(&emit_arena, 1024U)) {
        emit_arena.restore(arena_mark);
        return HEX_ERR_OOM;
      }

      w.begin_line(0U, base_addr);
      w.put(kFixedWidthHeader);
      w.begin_line(0U, base_addr);
      w.put("typedef __UINT64_TYPE__ uint64;");
      w.begin_line(0U, base_addr);
      w.put("#ifndef __hex_atomic_load_defined");
      w.begin_line(0U, base_addr);
      w.put("#define __hex_atomic_load_defined");
      w.begin_line(0U, base_addr);
      w.put("#define __atomic_load(ptr) __atomic_load_n((ptr), __ATOMIC_SEQ_CST)");
      w.begin_line(0U, base_addr);
      w.put("#endif");
      w.begin_line(0U, base_addr);
      w.put("#ifndef __hex_atomic_store_defined");
      w.begin_line(0U, base_addr);
      w.put("#define __hex_atomic_store_defined");
      w.begin_line(0U, base_addr);
      w.put("#define __atomic_store(ptr, val) (__atomic_store_n((ptr), (val), __ATOMIC_SEQ_CST), 0)");
      w.begin_line(0U, base_addr);
      w.put("#endif");

      w.begin_line(0U, base_addr);
      w.put("uint64 ");
      w.put_n(fname, flen);
      w.put("(void * ");
      w.put_arg_name(rn);
      w.put_char(')');

      w.begin_line(0U, base_addr);
      w.put_char('{');

      w.begin_line(0U, base_addr);
      w.put("    uint64 ");
      w.put_gp_reg_name(rt);
      w.put_char(';');

      w.begin_line(0U, base_addr + 4ULL);
      w.put("    uint64 ");
      w.put_gp_reg_name(rs);
      w.put_char(';');

      w.begin_line(0U, base_addr);
      w.put("    ");
      w.put_gp_reg_name(rt);
      w.put(" = __atomic_load((uint64 *)(");
      w.put_arg_name(rn);
      w.put("));");

      w.begin_line(0U, base_addr + 4ULL);
      w.put("    ");
      w.put_gp_reg_name(rs);
      w.put(" = __atomic_store((uint64 *)(");
      w.put_arg_name(rn);
      w.put("), ");
      w.put_gp_reg_name(rt);
      w.put(");");

      w.begin_line(0U, base_addr + 8ULL);
      w.put("    return ");
      w.put_gp_reg_name(rt);
      w.put_char(';');

      w.begin_line(0U, base_addr + 8ULL);
      w.put_char('}');

      return finalize_output(w, emit_arena, arena_mark, out_text, out_len, out_linemap, out_linemap_count);
    }
  }

  // Pattern 7: 2-word 64-bit exclusive pair load (LDAXP/LDXP) + ret
  //   ldaxp x0, x1, [xN]; ret
  if (word_count == 2U && is_canonical_ret(words[1])) {
    uint8_t rt = 0U;
    uint8_t rt2 = 0U;
    uint8_t rn = 0U;
    if (is_ldaxp_64(words[0], &rt, &rt2, &rn) &&
        rt == 0U && rt2 <= 30U && rn <= 7U && rn != rt && rn != rt2) {
      EmitWriter w;
      if (!w.init(&emit_arena, 512U)) {
        emit_arena.restore(arena_mark);
        return HEX_ERR_OOM;
      }

      w.begin_line(0U, base_addr);
      w.put(kFixedWidthHeader);
      w.begin_line(0U, base_addr);
      w.put("typedef __UINT64_TYPE__ uint64;");
      w.begin_line(0U, base_addr);
      w.put("typedef unsigned __int128 uint128;");

      w.begin_line(0U, base_addr);
      w.put("uint64 ");
      w.put_n(fname, flen);
      w.put("(void * ");
      w.put_arg_name(rn);
      w.put_char(')');

      w.begin_line(0U, base_addr);
      w.put_char('{');

      w.begin_line(0U, base_addr);
      w.put("    uint64 ");
      w.put_gp_reg_name(rt);
      w.put_char(';');

      w.begin_line(0U, base_addr);
      w.put("    ");
      w.put_gp_reg_name(rt);
      w.put(" = *(uint128 *)(");
      w.put_arg_name(rn);
      w.put(");");

      w.begin_line(0U, base_addr + 4ULL);
      w.put("    return *(uint128 *)(");
      w.put_arg_name(rn);
      w.put(");");

      w.begin_line(0U, base_addr + 4ULL);
      w.put_char('}');

      return finalize_output(w, emit_arena, arena_mark, out_text, out_len, out_linemap, out_linemap_count);
    }
  }

  emit_arena.restore(arena_mark);
  return HEX_ERR_UNSUPPORTED;
}

}  // namespace passes
}  // namespace decompiler
}  // namespace hex
