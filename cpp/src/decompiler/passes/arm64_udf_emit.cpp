#include "arm64_udf_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kArm64RetWord = 0xd65f03c0u;
static constexpr uint32_t kMaxUdfTailWords = 64u;
static constexpr uint32_t kMaxFuncNameLen = 256u;

static constexpr char kHexLower[16] = {
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};

// Exact UTF-8 bytes for "    __builtin_trap();   // ここに来たら異常\n"
static constexpr char kUdfTrapLine[] =
    "    __builtin_trap();   // \xe3\x81\x93\xe3\x81\x93\xe3\x81\xab\xe6\x9d\xa5\xe3\x81\x9f\xe3\x82\x89\xe7\x95\xb0\xe5\xb8\xb8\n";

static bool is_ident_start(uint8_t c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
}

static bool is_ident_char(uint8_t c) {
  return is_ident_start(c) || (c >= '0' && c <= '9');
}

static bool validate_func_name(const char* raw, uint32_t len, uint32_t* out_start) {
  *out_start = 0u;
  if (len > kMaxFuncNameLen) return false;
  if (raw == nullptr || len == 0u) return true;
  if (len >= 2u && ((raw[0] == '-' && raw[1] == '[') || (raw[0] == '+' && raw[1] == '['))) {
    return false;
  }
  uint32_t start = 0u;
  while (start < len && raw[start] == '_') ++start;
  if (start == len) return true;
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

  void put_u64_hex_lower(uint64_t v) {
    char tmp[16];
    uint32_t n = 0u;
    if (v == 0u) {
      tmp[n++] = '0';
    } else {
      while (v > 0u) {
        tmp[n++] = kHexLower[v & 0xfu];
        v >>= 4;
      }
    }
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_imm(uint64_t v) {
    if (v >= 256ULL) {
      put_cstr("0x");
      put_u64_hex_lower(v);
    } else {
      put_u64_dec(v);
    }
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

HexStatus try_emit_arm64_udf_tail(
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

  // Must be [add/sub x0, x0, #imm; ret; udf+], capped at 64 words.
  if (word_count < 3u || word_count > kMaxUdfTailWords) {
    return HEX_ERR_UNSUPPORTED;
  }

  uint32_t name_start = 0u;
  if (!validate_func_name(func_name, func_name_len, &name_start)) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [0]: 64-bit ADD/SUB immediate, S=0, sh[1]=0, Rn=0, Rd=0:
  //   ADD: 1 0 0 10001 0 sh(1) imm12(12) 00000 00000 -> (w & 0xff8003ffu) == 0x91000000u
  //   SUB: 1 1 0 10001 0 sh(1) imm12(12) 00000 00000 -> (w & 0xff8003ffu) == 0xd1000000u
  const uint32_t w0 = words[0];
  if ((w0 & 0xbf8003ffu) != 0x91000000u) {
    return HEX_ERR_UNSUPPORTED;
  }
  const bool is_sub = ((w0 >> 30) & 1u) != 0u;
  const uint32_t sh = (w0 >> 22) & 1u;
  const uint64_t imm = static_cast<uint64_t>((w0 >> 10) & 0xfffu) << (sh ? 12u : 0u);

  // [1]: canonical RET (x30)
  if (words[1] != kArm64RetWord) {
    return HEX_ERR_UNSUPPORTED;
  }

  // [2..word_count-1]: all trailing words must be UDF (`(w & 0xffff0000u) == 0`)
  const uint32_t udf_count = word_count - 2u;
  for (uint32_t i = 2u; i < word_count; ++i) {
    if ((words[i] & 0xffff0000u) != 0x00000000u) {
      return HEX_ERR_UNSUPPORTED;
    }
  }

  const size_t mark = emit_arena.used();
  const uint32_t trap_line_len = static_cast<uint32_t>(sizeof(kUdfTrapLine) - 1u);
  const uint32_t text_cap = 512u + func_name_len + udf_count * trap_line_len;
  const uint32_t lm_cap = 4u + udf_count;

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
        "typedef __INT64_TYPE__ int64;\n");
  }

  // Signature line
  w.map_addr(0u, base_addr);
  w.put_cstr("uint64 ");
  if (func_name != nullptr && name_start < func_name_len) {
    w.put_n(func_name + name_start, func_name_len - name_start);
  } else {
    w.put_cstr("sub_");
    w.put_u64_hex_lower(base_addr);
  }
  w.put_cstr("(int64 a1)\n{\n");

  // Return statement (mapped to arith + ret VAs)
  w.map_addr(0u, base_addr);
  w.map_addr(0u, base_addr + 4ULL);
  w.put_cstr("    return a1 ");
  w.put_char(is_sub ? '-' : '+');
  w.put_char(' ');
  w.put_imm(imm);
  w.put_cstr(";\n");

  // Trailing UDF traps
  for (uint32_t i = 0u; i < udf_count; ++i) {
    w.map_addr(i + 1u, base_addr + static_cast<uint64_t>(2u + i) * 4ULL);
    w.put_n(kUdfTrapLine, trap_line_len);
  }

  // Closing brace (no trailing newline)
  w.put_char('}');

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
