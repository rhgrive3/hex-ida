#include "decompiler/passes/arm64_simple_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kMaxSimpleWords = 64u;
static constexpr uint32_t kMaxNormNameLen = 128u;
static constexpr uint32_t kMaxDefAddrs = 16u;
static constexpr uint32_t kMaxLineMapEntries = 32u;

static constexpr uint32_t kInsnRet = 0xD65F03C0u;
static constexpr uint32_t kInsnNop = 0xD503201Fu;
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
    for (uint32_t i = 0; i < n; ++i) {
      append_char(s[i]);
      if (overflow) return;
    }
  }

  void append_u64_hex(uint64_t val) {
    static const char kHex[] = "0123456789abcdef";
    char tmp[16];
    uint32_t n = 0;
    do {
      tmp[n++] = kHex[val & 0xFu];
      val >>= 4u;
    } while (val != 0u);
    while (n > 0u) {
      append_char(tmp[--n]);
    }
  }

  void append_u64_dec(uint64_t val) {
    char tmp[24];
    uint32_t n = 0;
    do {
      tmp[n++] = static_cast<char>('0' + (val % 10u));
      val /= 10u;
    } while (val != 0u);
    while (n > 0u) {
      append_char(tmp[--n]);
    }
  }

  void append_i64_dec(int64_t val) {
    if (val < 0) {
      append_char('-');
      const uint64_t mag = static_cast<uint64_t>(-(val + 1)) + 1u;
      append_u64_dec(mag);
    } else {
      append_u64_dec(static_cast<uint64_t>(val));
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
    w.append_u64_hex(base_addr);
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

static bool decode_stp_sp_pre_64(uint32_t w, uint32_t* rt, uint32_t* rt2, int32_t* disp_bytes) {
  if ((w & 0xFFC00000u) != 0xA9800000u) return false;
  const uint32_t rn = (w >> 5u) & 31u;
  if (rn != 31u) return false;
  const int32_t imm7 = sign_extend_7(w >> 15u);
  const int32_t disp = imm7 * 8;
  if (disp >= 0 || (-disp) < 16) return false;
  *rt = w & 31u;
  *rt2 = (w >> 10u) & 31u;
  *disp_bytes = disp;
  return true;
}

static bool decode_ldp_sp_post_64(uint32_t w, uint32_t* rt, uint32_t* rt2, int32_t* disp_bytes) {
  if ((w & 0xFFC00000u) != 0xA8C00000u) return false;
  const uint32_t rn = (w >> 5u) & 31u;
  if (rn != 31u) return false;
  const int32_t imm7 = sign_extend_7(w >> 15u);
  const int32_t disp = imm7 * 8;
  if (disp <= 0) return false;
  *rt = w & 31u;
  *rt2 = (w >> 10u) & 31u;
  *disp_bytes = disp;
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

}  // namespace

HexStatus try_emit_arm64_simple(
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

  if (!words || word_count == 0u || !out_text || !out_len || !out_linemap || !out_linemap_count ||
      (func_name == nullptr && func_name_len > 0u)) {
    return HEX_ERR_INVALID_ARG;
  }
  if (word_count > kMaxSimpleWords) {
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

  // Optional standard frame prologue/epilogue:
  //   stp x29, x30, [sp, #-N]!
  //   (optional) mov x29, sp
  //   ... body ...
  //   ldp x29, x30, [sp], #N
  //   ret
  bool has_frame = false;
  uint32_t frame_rt = 0u;
  uint32_t frame_rt2 = 0u;
  int32_t frame_disp = 0;
  uint64_t stp_addr = base_addr;

  uint32_t body_start = 0u;
  uint32_t body_end = word_count - 1u;

  uint32_t stp_rt = 0u;
  uint32_t stp_rt2 = 0u;
  int32_t stp_disp = 0;
  if (word_count >= 3u && decode_stp_sp_pre_64(words[0], &stp_rt, &stp_rt2, &stp_disp)) {
    if (stp_rt != 29u || stp_rt2 != 30u) {
      return HEX_ERR_UNSUPPORTED;
    }
    uint32_t ldp_rt = 0u;
    uint32_t ldp_rt2 = 0u;
    int32_t ldp_disp = 0;
    if (!decode_ldp_sp_post_64(words[word_count - 2u], &ldp_rt, &ldp_rt2, &ldp_disp)) {
      return HEX_ERR_UNSUPPORTED;
    }
    if (ldp_rt != stp_rt || ldp_rt2 != stp_rt2 || ldp_disp != -stp_disp) {
      return HEX_ERR_UNSUPPORTED;
    }
    has_frame = true;
    frame_rt = stp_rt;
    frame_rt2 = stp_rt2;
    frame_disp = stp_disp;
    stp_addr = base_addr;
    body_start = 1u;
    body_end = word_count - 2u;
    if (body_start < body_end && words[body_start] == kInsnMovX29Sp) {
      body_start++;
    }
  }

  // Scan body instructions strictly (no unrecognized instructions allowed).
  bool has_r0 = false;
  bool r0_is_64 = false;
  uint64_t r0_val = 0u;
  uint64_t def_addrs[kMaxDefAddrs];
  uint32_t def_addr_count = 0u;

  for (uint32_t i = body_start; i < body_end; ++i) {
    const uint32_t w = words[i];
    const uint64_t insn_addr = base_addr + static_cast<uint64_t>(i) * 4u;

    if (w == kInsnNop) {
      continue;
    }

    // MOVZ w0/x0, #imm16, lsl #hw*16
    if ((w & 0x7F800000u) == 0x52800000u) {
      const uint32_t sf = (w >> 31u) & 1u;
      const uint32_t hw = (w >> 21u) & 3u;
      const uint32_t imm16 = (w >> 5u) & 0xFFFFu;
      const uint32_t rd = w & 31u;
      if (rd != 0u || (sf == 0u && hw >= 2u)) return HEX_ERR_UNSUPPORTED;
      has_r0 = true;
      r0_is_64 = (sf != 0u);
      r0_val = static_cast<uint64_t>(imm16) << (hw * 16u);
      def_addr_count = 0u;
      def_addrs[def_addr_count++] = insn_addr;
      continue;
    }

    // MOVN w0/x0, #imm16, lsl #hw*16 (require follow-up arithmetic, e.g. movn+add+ret)
    if ((w & 0x7F800000u) == 0x12800000u) {
      if (word_count == 2u) return HEX_ERR_UNSUPPORTED;
      const uint32_t sf = (w >> 31u) & 1u;
      const uint32_t hw = (w >> 21u) & 3u;
      const uint32_t imm16 = (w >> 5u) & 0xFFFFu;
      const uint32_t rd = w & 31u;
      if (rd != 0u || (sf == 0u && hw >= 2u)) return HEX_ERR_UNSUPPORTED;
      has_r0 = true;
      r0_is_64 = (sf != 0u);
      const uint64_t shifted = static_cast<uint64_t>(imm16) << (hw * 16u);
      r0_val = r0_is_64
          ? ~shifted
          : static_cast<uint64_t>(static_cast<uint32_t>(~static_cast<uint32_t>(shifted)));
      def_addr_count = 0u;
      def_addrs[def_addr_count++] = insn_addr;
      continue;
    }

    // MOV w0/x0, wzr/xzr (ORR shifted register with Rn=31, shift=0, N=0, imm6=0, Rm=31)
    if ((w & 0x7FE0FFE0u) == 0x2A0003E0u) {
      const uint32_t sf = (w >> 31u) & 1u;
      const uint32_t rm = (w >> 16u) & 31u;
      const uint32_t rd = w & 31u;
      if (rd != 0u || rm != 31u) return HEX_ERR_UNSUPPORTED;
      has_r0 = true;
      r0_is_64 = (sf != 0u);
      r0_val = 0u;
      def_addr_count = 0u;
      def_addrs[def_addr_count++] = insn_addr;
      continue;
    }

    // ADD/SUB (immediate) folding on constant w0/x0
    const uint32_t op_hi = w & 0x7F800000u;
    if (op_hi == 0x11000000u || op_hi == 0x51000000u) {
      const bool is_sub = (op_hi == 0x51000000u);
      const uint32_t sf = (w >> 31u) & 1u;
      const uint32_t sh = (w >> 22u) & 1u;
      const uint32_t imm12 = (w >> 10u) & 0xFFFu;
      const uint32_t rn = (w >> 5u) & 31u;
      const uint32_t rd = w & 31u;
      if (!has_r0 || rd != 0u || rn != 0u || (sf != 0u) != r0_is_64) {
        return HEX_ERR_UNSUPPORTED;
      }
      const uint64_t imm = static_cast<uint64_t>(imm12) << (sh ? 12u : 0u);
      if (r0_is_64) {
        r0_val = is_sub ? (r0_val - imm) : (r0_val + imm);
      } else {
        const uint32_t lhs = static_cast<uint32_t>(r0_val);
        const uint32_t rhs = static_cast<uint32_t>(imm);
        r0_val = static_cast<uint64_t>(is_sub ? static_cast<uint32_t>(lhs - rhs)
                                              : static_cast<uint32_t>(lhs + rhs));
      }
      if (def_addr_count < kMaxDefAddrs) {
        def_addrs[def_addr_count++] = insn_addr;
      }
      continue;
    }

    // Any other instruction fails closed.
    return HEX_ERR_UNSUPPORTED;
  }

  // Frame-wrapped void return is not verified; fail closed.
  if (has_frame && !has_r0) {
    return HEX_ERR_UNSUPPORTED;
  }
  // Under JS_PARITY, 64-bit constant returns (uint64 vs int64) and constants >= 100 (hex vs dec,
  // including negative/wrapped values like 0xFFFFFFFF) diverge from JS; fail closed.
  if ((emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u && has_r0) {
    if (r0_is_64) {
      return HEX_ERR_UNSUPPORTED;
    }
    const uint32_t masked32 = static_cast<uint32_t>(r0_val);
    if (masked32 >= 100u) {
      return HEX_ERR_UNSUPPORTED;
    }
  }

  const uint64_t ret_addr = base_addr + static_cast<uint64_t>(word_count - 1u) * 4u;

  // Allocate text buffer and linemap on emit_arena (with rollback on OOM).
  const size_t arena_mark = emit_arena.used();
  constexpr uint32_t kTextCap = 1024u;
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

  if (!has_r0) {
    // Pattern A: trivial void return
    // Line 1: void <name>(void)
    w.append_str("void ");
    w.append_bytes(norm_name, norm_name_len);
    w.append_str("(void)\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    // Line 2: {
    w.append_str("{\n");
    cur_line++;

    // Line 3:     return;
    w.append_str("    return;\n");
    push_linemap(lm_buf, &lm_count, cur_line, ret_addr);
    cur_line++;

    // Line 4: }
    w.append_char('}');
  } else {
    // Pattern B / C: constant-folded integer return (with optional saved frame)
    // Line 1: fixed-width header comment
    w.append_str("/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    // Line 2: return type typedef
    if (r0_is_64) {
      w.append_str("typedef __INT64_TYPE__ int64;\n");
    } else {
      w.append_str("typedef __INT32_TYPE__ int32;\n");
    }
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    if (has_frame) {
      // Line 3: uint64 typedef for frame register save slots
      w.append_str("typedef __UINT64_TYPE__ uint64;\n");
      push_linemap(lm_buf, &lm_count, cur_line, base_addr);
      cur_line++;
    }

    // Signature line
    w.append_str(r0_is_64 ? "int64 " : "int32 ");
    w.append_bytes(norm_name, norm_name_len);
    w.append_str("(void)\n");
    push_linemap(lm_buf, &lm_count, cur_line, base_addr);
    cur_line++;

    // Open brace
    w.append_str("{\n");
    cur_line++;

    if (has_frame) {
      const uint64_t slot0 = static_cast<uint64_t>(-frame_disp);
      const uint64_t slot1 = slot0 - 8u;

      // 4 local declarations
      w.append_str("    uint64 local_m");
      w.append_u64_hex(slot0);
      w.append_str(";\n");
      push_linemap(lm_buf, &lm_count, cur_line, stp_addr);
      cur_line++;

      w.append_str("    uint64 local_x");
      w.append_u64_dec(frame_rt);
      w.append_str(";\n");
      push_linemap(lm_buf, &lm_count, cur_line, stp_addr);
      cur_line++;

      w.append_str("    uint64 local_m");
      w.append_u64_hex(slot1);
      w.append_str(";\n");
      push_linemap(lm_buf, &lm_count, cur_line, stp_addr);
      cur_line++;

      w.append_str("    uint64 local_x");
      w.append_u64_dec(frame_rt2);
      w.append_str(";\n");
      push_linemap(lm_buf, &lm_count, cur_line, stp_addr);
      cur_line++;

      // 2 frame save assignments
      w.append_str("    local_m");
      w.append_u64_hex(slot0);
      w.append_str(" = local_x");
      w.append_u64_dec(frame_rt);
      w.append_str(";\n");
      push_linemap(lm_buf, &lm_count, cur_line, stp_addr);
      cur_line++;

      w.append_str("    local_m");
      w.append_u64_hex(slot1);
      w.append_str(" = local_x");
      w.append_u64_dec(frame_rt2);
      w.append_str(";\n");
      push_linemap(lm_buf, &lm_count, cur_line, stp_addr);
      cur_line++;
    }

    // Return statement line
    w.append_str("    return ");
    if (r0_is_64) {
      w.append_i64_dec(static_cast<int64_t>(r0_val));
    } else {
      w.append_i64_dec(static_cast<int64_t>(static_cast<int32_t>(static_cast<uint32_t>(r0_val))));
    }
    w.append_str(";\n");

    // Record contributing addresses in JS order: last def, earlier defs, then ret
    if (def_addr_count > 0u) {
      push_linemap(lm_buf, &lm_count, cur_line, def_addrs[def_addr_count - 1u]);
      for (uint32_t k = 0u; k + 1u < def_addr_count; ++k) {
        push_linemap(lm_buf, &lm_count, cur_line, def_addrs[k]);
      }
    }
    push_linemap(lm_buf, &lm_count, cur_line, ret_addr);
    cur_line++;

    // Close brace
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
