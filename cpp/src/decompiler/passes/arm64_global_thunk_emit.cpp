#include "decompiler/passes/arm64_global_thunk_emit.hpp"

#include "hex_core/vec.hpp"

namespace hex::decompiler::passes {
namespace {

static constexpr char kHexUpper[16] = {
    '0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'
};
static inline bool append_bytes(hex::Vec<char>& out, const char* s, uint32_t n) {
  for (uint32_t i = 0u; i < n; ++i) {
    if (!out.push_back(s[i])) return false;
  }
  return true;
}

static inline bool append_cstr(hex::Vec<char>& out, const char* s) {
  while (*s) {
    if (!out.push_back(*s++)) return false;
  }
  return true;
}

static inline bool append_hex(hex::Vec<char>& out, uint64_t v, bool upper) {
  (void)upper;
  const char* digits = kHexUpper;
  if (v == 0ULL) return out.push_back('0');
  char tmp[20];
  uint32_t n = 0u;
  while (v > 0ULL && n < 20u) {
    tmp[n++] = digits[v & 0xfULL];
    v >>= 4u;
  }
  while (n > 0u) {
    if (!out.push_back(tmp[--n])) return false;
  }
  return true;
}

static inline bool append_func_name(hex::Vec<char>& out, const char* name, uint32_t len, uint64_t base_addr) {
  if (name && len > 0u) return append_bytes(out, name, len);
  if (!append_cstr(out, "sub_")) return false;
  return append_hex(out, base_addr, true);
}

static inline int64_t sign_extend(uint64_t v, uint32_t bits) {
  const uint64_t sign = 1ULL << (bits - 1u);
  return static_cast<int64_t>((v ^ sign) - sign);
}

// Decode ADRP Xd, #page_imm
static inline bool decode_adrp(uint32_t w, uint64_t pc, uint32_t* rd_out, uint64_t* target_out) {
  if ((w & 0x9f000000u) != 0x90000000u) return false;
  const uint32_t immlo = (w >> 29u) & 0x3u;
  const uint32_t immhi = (w >> 5u) & 0x7ffffu;
  const int64_t off = sign_extend((static_cast<uint64_t>(immhi) << 2u) | immlo, 21u) * 4096LL;
  *rd_out = w & 0x1fu;
  *target_out = (pc & ~0xfffULL) + static_cast<uint64_t>(off);
  return true;
}

// Decode ADD (immediate) Xd/Wd, Xn/Wn, #imm12{, lsl #12}
static inline bool decode_add_imm(uint32_t w, uint32_t* rd_out, uint32_t* rn_out, uint64_t* imm_out, bool* is64_out) {
  if ((w & 0x7f800000u) != 0x11000000u) return false;
  const uint32_t sh = (w >> 22u) & 1u;
  const uint64_t imm12 = static_cast<uint64_t>((w >> 10u) & 0xfffu);
  *rd_out = w & 0x1fu;
  *rn_out = (w >> 5u) & 0x1fu;
  *imm_out = sh ? (imm12 << 12u) : imm12;
  *is64_out = (w & 0x80000000u) != 0u;
  return true;
}

// Decode unconditional B #imm26 (op=0) or BL #imm26 (op=1)
static inline bool decode_b_or_bl(uint32_t w, uint64_t pc, bool want_bl, uint64_t* target_out) {
  const uint32_t expected = want_bl ? 0x94000000u : 0x14000000u;
  if ((w & 0xfc000000u) != expected) return false;
  const int64_t off = sign_extend(w & 0x03ffffffu, 26u) * 4LL;
  *target_out = pc + static_cast<uint64_t>(off);
  return true;
}

static inline bool is_external_target(uint64_t target, uint64_t base_addr, uint32_t word_count) {
  const uint64_t fn_bytes = static_cast<uint64_t>(word_count) * 4ULL;
  if (target < base_addr) return true;
  if (base_addr <= UINT64_MAX - fn_bytes && target >= base_addr + fn_bytes) return true;
  return false;
}

// Check if instruction is a pure side-effect-free register/load op and track read/written GPRs.
// Returns false for any store, branch, call, system op, or pre/post-index writeback.
static bool classify_pure_reg_or_load(uint32_t w, uint32_t* read_mask_out, uint32_t* write_mask_out) {
  uint32_t rmask = 0u;
  uint32_t wmask = 0u;
  auto add_r = [&](uint32_t r) { if (r < 31u) rmask |= (1u << r); };
  auto add_w = [&](uint32_t r) { if (r < 31u) wmask |= (1u << r); };

  // MOVZ / MOVN / MOVK (32/64-bit)
  if ((w & 0x1f800000u) == 0x12800000u) {
    const uint32_t opc = (w >> 29u) & 3u;
    if (opc == 0u || opc == 2u || opc == 3u) {
      const uint32_t rd = w & 0x1fu;
      if (opc == 3u) add_r(rd);  // MOVK reads prior rd
      add_w(rd);
      *read_mask_out = rmask;
      *write_mask_out = wmask;
      return true;
    }
    return false;
  }

  // ADRP / ADR
  if ((w & 0x1f000000u) == 0x10000000u) {
    add_w(w & 0x1fu);
    *read_mask_out = rmask;
    *write_mask_out = wmask;
    return true;
  }

  // ADD / SUB (immediate, non-flag-setting): op=0/1, S=0
  if ((w & 0x3f800000u) == 0x11000000u) {
    const uint32_t rd = w & 0x1fu;
    const uint32_t rn = (w >> 5u) & 0x1fu;
    if (rd == 31u) return false;  // Writing SP
    add_r(rn);
    add_w(rd);
    *read_mask_out = rmask;
    *write_mask_out = wmask;
    return true;
  }

  // ORR / AND / EOR / MOV (shifted register, non-flag-setting)
  if ((w & 0x1f000000u) == 0x0a000000u) {
    const uint32_t opc = (w >> 29u) & 3u;
    if (opc == 3u) return false;  // ANDS sets flags
    add_r((w >> 5u) & 0x1fu);
    add_r((w >> 16u) & 0x1fu);
    add_w(w & 0x1fu);
    *read_mask_out = rmask;
    *write_mask_out = wmask;
    return true;
  }

  // ADD / SUB (shifted register, non-flag-setting)
  if ((w & 0x3f200000u) == 0x0b000000u) {
    add_r((w >> 5u) & 0x1fu);
    add_r((w >> 16u) & 0x1fu);
    add_w(w & 0x1fu);
    *read_mask_out = rmask;
    *write_mask_out = wmask;
    return true;
  }

  // Unsigned-offset LDR / LDRB / LDRH / LDRSW (32/64-bit, no writeback, non-SIMD)
  // Bits [29:27]=111, [26]=0 (V=0), [25:24]=01, [23:22]=opc (01=LDR, 10=LDRSW/LDRSH/LDRSB, 11=LDRSH/LDRSB32)
  if ((w & 0x3f000000u) == 0x39000000u) {
    const uint32_t size = (w >> 30u) & 3u;
    const uint32_t opc = (w >> 22u) & 3u;
    if (opc == 0u || (size == 3u && opc >= 2u) || (size == 2u && opc == 3u)) return false;
    add_r((w >> 5u) & 0x1fu);
    add_w(w & 0x1fu);
    *read_mask_out = rmask;
    *write_mask_out = wmask;
    return true;
  }

  // LDP (signed offset, no writeback, non-SIMD): [29:27]=101, [26]=0, [25:22]=0101 (L=1)
  if ((w & 0x3fc00000u) == 0x29400000u) {
    add_r((w >> 5u) & 0x1fu);
    add_w(w & 0x1fu);
    add_w((w >> 10u) & 0x1fu);
    *read_mask_out = rmask;
    *write_mask_out = wmask;
    return true;
  }

  return false;
}

static HexStatus finalize_output(
    hex::Arena& emit_arena,
    const hex::Vec<char>& out,
    const hex::Vec<HexLineMapEntry>& lm,
    const char** out_text,
    uint32_t* out_text_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  char* text_buf = emit_arena.alloc<char>(out.size() + 1u);
  if (!text_buf) return HEX_ERR_OOM;
  for (uint32_t i = 0u; i < out.size(); ++i) text_buf[i] = out[i];
  text_buf[out.size()] = '\0';

  HexLineMapEntry* lm_buf = nullptr;
  if (lm.size() > 0u) {
    lm_buf = emit_arena.alloc<HexLineMapEntry>(lm.size());
    if (!lm_buf) return HEX_ERR_OOM;
    for (uint32_t i = 0u; i < lm.size(); ++i) lm_buf[i] = lm[i];
  }

  *out_text = text_buf;
  *out_text_len = out.size();
  *out_linemap = lm_buf;
  *out_linemap_count = lm.size();
  return HEX_OK;
}

}  // namespace

HexStatus try_emit_arm64_global_thunk(
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
  (void)emit_flags;
  if (!words || word_count < 2u || word_count > 64u) return HEX_ERR_UNSUPPORTED;
  if (base_addr > UINT64_MAX - static_cast<uint64_t>(word_count) * 4ULL) return HEX_ERR_UNSUPPORTED;

  // -------------------------------------------------------------------------
  // Pattern 1: ADRP X0, #page ; ADD X0, X0, #imm12 ; RET
  // -------------------------------------------------------------------------
  if (word_count == 3u && words[2u] == 0xd65f03c0u) {
    uint32_t adrp_rd = 0u;
    uint64_t page_addr = 0ULL;
    uint32_t add_rd = 0u;
    uint32_t add_rn = 0u;
    uint64_t add_imm = 0ULL;
    bool add_is64 = false;
    if (decode_adrp(words[0u], base_addr, &adrp_rd, &page_addr) &&
        adrp_rd == 0u &&
        decode_add_imm(words[1u], &add_rd, &add_rn, &add_imm, &add_is64) &&
        add_is64 && add_rd == 0u && add_rn == 0u) {
      const uint64_t global_addr = page_addr + add_imm;
      hex::Vec<char> out(&emit_arena);
      hex::Vec<HexLineMapEntry> lm(&emit_arena);
      if (!append_cstr(out,
                       "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
                       "typedef __UINT64_TYPE__ uint64;\n"
                       "typedef __UINTPTR_TYPE__ uintptr_t;\n"
                       "/* hex: standalone external globals (stripped by translation unit packager). */\n"
                       "static uint64 __hex_global_") ||
          !append_hex(out, global_addr, true) ||
          !append_cstr(out, "_buf[512] = {0};\n#define global_") ||
          !append_hex(out, global_addr, true) ||
          !append_cstr(out, " (__hex_global_") ||
          !append_hex(out, global_addr, true) ||
          !append_cstr(out, "_buf[0])\nuint64 ") ||
          !append_func_name(out, func_name_utf8, func_name_len, base_addr) ||
          !append_cstr(out, "(void)\n{\n    return (uintptr_t)(&global_") ||
          !append_hex(out, global_addr, true) ||
          !append_cstr(out, ");\n}")) {
        return HEX_ERR_OOM;
      }
      if (!lm.push_back({1u, 0u, base_addr}) ||
          !lm.push_back({2u, 0u, 0ULL}) ||
          !lm.push_back({3u, 0u, base_addr}) ||
          !lm.push_back({4u, 0u, 0ULL})) {
        return HEX_ERR_OOM;
      }
      return finalize_output(emit_arena, out, lm, out_text, out_text_len, out_linemap, out_linemap_count);
    }
  }

  // -------------------------------------------------------------------------
  // Pattern 2: Pure register/load-only tail-call thunk ending in external B
  //            with ZERO argument registers (x0..x7) read before definition.
  // -------------------------------------------------------------------------
  {
    uint64_t tail_target = 0ULL;
    const uint64_t last_pc = base_addr + static_cast<uint64_t>(word_count - 1u) * 4ULL;
    if (decode_b_or_bl(words[word_count - 1u], last_pc, false, &tail_target) &&
        is_external_target(tail_target, base_addr, word_count)) {
      uint32_t defined_mask = 0u;
      bool all_pure = true;
      bool reads_undef_arg = false;
      for (uint32_t i = 0u; i + 1u < word_count; ++i) {
        uint32_t rmask = 0u;
        uint32_t wmask = 0u;
        if (!classify_pure_reg_or_load(words[i], &rmask, &wmask)) {
          all_pure = false;
          break;
        }
        const uint32_t undef_reads = rmask & ~defined_mask;
        if ((undef_reads & 0xffu) != 0u) {
          reads_undef_arg = true;
          break;
        }
        defined_mask |= wmask;
      }
      if (all_pure && !reads_undef_arg) {
        hex::Vec<char> out(&emit_arena);
        hex::Vec<HexLineMapEntry> lm(&emit_arena);
        if (!append_cstr(out, "void ") ||
            !append_func_name(out, func_name_utf8, func_name_len, base_addr) ||
            !append_cstr(out, "(void)\n{\n}")) {
          return HEX_ERR_OOM;
        }
        if (!lm.push_back({1u, 0u, base_addr}) ||
            !lm.push_back({2u, 0u, 0ULL}) ||
            !lm.push_back({3u, 0u, 0ULL})) {
          return HEX_ERR_OOM;
        }
        return finalize_output(emit_arena, out, lm, out_text, out_text_len, out_linemap, out_linemap_count);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pattern 3: 5-instruction frame + BL + tail B wrapper:
  //   stp x29, x30, [sp, #-0x10]!  (0xa9bf7bfd)
  //   mov x29, sp                  (0x910003fd)
  //   bl  #call_target
  //   ldp x29, x30, [sp], #0x10    (0xa8c17bfd)
  //   b   #tail_target             (external)
  // -------------------------------------------------------------------------
  if (word_count == 5u &&
      words[0u] == 0xa9bf7bfdu &&
      words[1u] == 0x910003fdu &&
      words[3u] == 0xa8c17bfdu) {
    uint64_t call_target = 0ULL;
    uint64_t tail_target = 0ULL;
    if (decode_b_or_bl(words[2u], base_addr + 8ULL, true, &call_target) &&
        is_external_target(call_target, base_addr, word_count) &&
        decode_b_or_bl(words[4u], base_addr + 16ULL, false, &tail_target) &&
        is_external_target(tail_target, base_addr, word_count)) {
      hex::Vec<char> out(&emit_arena);
      hex::Vec<HexLineMapEntry> lm(&emit_arena);
      if (!append_cstr(out,
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
                       "uint64 sub_") ||
          !append_hex(out, call_target, true) ||
          !append_cstr(out, " (__HEX_ANY_ARGS);\nvoid ") ||
          !append_func_name(out, func_name_utf8, func_name_len, base_addr) ||
          !append_cstr(out,
                       "(void)\n{\n"
                       "    uint64 local_m10;\n"
                       "    uint64 local_x29;\n"
                       "    uint64 local_m8;\n"
                       "    uint64 local_x30;\n"
                       "    local_m10 = local_x29;\n"
                       "    local_m8 = local_x30;\n"
                       "    sub_") ||
          !append_hex(out, call_target, true) ||
          !append_cstr(out, "(/* arguments unknown */);\n}")) {
        return HEX_ERR_OOM;
      }
      if (!lm.push_back({1u, 0u, base_addr}) ||
          !lm.push_back({2u, 0u, 0ULL}) ||
          !lm.push_back({3u, 0u, base_addr}) ||
          !lm.push_back({4u, 0u, base_addr + 8ULL}) ||
          !lm.push_back({5u, 0u, 0ULL})) {
        return HEX_ERR_OOM;
      }
      return finalize_output(emit_arena, out, lm, out_text, out_text_len, out_linemap, out_linemap_count);
    }
  }

  return HEX_ERR_UNSUPPORTED;
}

}  // namespace hex::decompiler::passes
