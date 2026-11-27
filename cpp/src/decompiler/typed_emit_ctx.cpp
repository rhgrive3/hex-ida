#include "hex_region_decomp.hpp"

namespace {

struct BoundedWriter {
  char* buf;
  uint32_t cap;
  uint32_t pos;
  bool overflow;

  inline void init(char* b, uint32_t c) {
    buf = b;
    cap = c;
    pos = 0u;
    overflow = false;
  }

  inline bool write_char(char ch) {
    if (overflow || cap == 0u || pos + 1u >= cap) {
      overflow = true;
      return false;
    }
    buf[pos++] = ch;
    return true;
  }

  inline bool write_bytes(const char* src, uint32_t len) {
    if (overflow) return false;
    if (len == 0u) return true;
    if (src == nullptr || cap == 0u || len >= cap - pos) {
      overflow = true;
      return false;
    }
    for (uint32_t i = 0u; i < len; ++i) {
      buf[pos++] = src[i];
    }
    return true;
  }

  inline bool write_escaped_c_string(const char* src, uint32_t len) {
    if (overflow) return false;
    if (len == 0u) return true;
    if (src == nullptr) {
      overflow = true;
      return false;
    }
    for (uint32_t i = 0u; i < len; ++i) {
      const char ch = src[i];
      switch (ch) {
        case '"':
          if (!write_bytes("\\\"", 2u)) return false;
          break;
        case '\\':
          if (!write_bytes("\\\\", 2u)) return false;
          break;
        case '\n':
          if (!write_bytes("\\n", 2u)) return false;
          break;
        case '\r':
          if (!write_bytes("\\r", 2u)) return false;
          break;
        case '\t':
          if (!write_bytes("\\t", 2u)) return false;
          break;
        default:
          if (!write_char(ch)) return false;
          break;
      }
    }
    return true;
  }

  inline bool write_cstr(const char* s) {
    if (s == nullptr) return true;
    uint32_t n = 0u;
    while (s[n] != '\0') ++n;
    return write_bytes(s, n);
  }

  inline bool write_hex_u64(uint64_t val, bool prefix_0x) {
    if (prefix_0x && !write_bytes("0x", 2u)) return false;
    static const char kHex[] = "0123456789abcdef";
    char tmp[16];
    uint32_t len = 0u;
    if (val == 0ull) {
      tmp[len++] = '0';
    } else {
      while (val != 0ull) {
        tmp[len++] = kHex[val & 0xFu];
        val >>= 4u;
      }
    }
    for (uint32_t i = 0u; i < len; ++i) {
      if (!write_char(tmp[len - 1u - i])) return false;
    }
    return true;
  }

  inline bool write_dec_u32(uint32_t val) {
    char tmp[10];
    uint32_t len = 0u;
    if (val == 0u) {
      tmp[len++] = '0';
    } else {
      while (val != 0u) {
        tmp[len++] = static_cast<char>('0' + (val % 10u));
        val /= 10u;
      }
    }
    for (uint32_t i = 0u; i < len; ++i) {
      if (!write_char(tmp[len - 1u - i])) return false;
    }
    return true;
  }

  inline void finish() {
    if (buf != nullptr && cap > 0u) {
      const uint32_t nul_pos = (pos < cap) ? pos : (cap - 1u);
      buf[nul_pos] = '\0';
    }
  }
};

inline const char* default_type_name(uint32_t type_id) {
  switch (type_id) {
    case 1u: return "int32_t";
    case 2u: return "uint32_t";
    case 3u: return "int64_t";
    case 4u: return "uint64_t";
    case 5u: return "float";
    case 6u: return "double";
    case 7u: return "uint8_t*";
    case 8u: return "void*";
    default: return "uint64_t";
  }
}

inline const char* default_asm_mnemonic(uint32_t island_kind) {
  switch (island_kind) {
    case HEX_ASM_ISLAND_SYS: return "sys";
    case HEX_ASM_ISLAND_SVC: return "svc";
    case HEX_ASM_ISLAND_CRYPTO_AES: return "aes";
    case HEX_ASM_ISLAND_CRYPTO_SHA: return "sha";
    case HEX_ASM_ISLAND_SVE: return "sve";
    case HEX_ASM_ISLAND_PAC: return "pac";
    default: return "insn";
  }
}

inline bool slice_valid(uint32_t off, uint32_t len, uint32_t pool_len) {
  if (len == 0u) return true;
  if (off > pool_len) return false;
  return len <= (pool_len - off);
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_typed_emit_format")
int32_t hex_typed_emit_format(
    const HexTypedEmitOp* ops,
    uint32_t op_count,
    const char* string_pool,
    uint32_t string_pool_len,
    char* out_buf,
    uint32_t out_buf_cap,
    uint32_t* out_written_len,
    HexTypedEmitToken* out_tokens,
    uint32_t out_tokens_cap,
    uint32_t* out_token_count) {
  if (out_buf == nullptr || out_buf_cap == 0u || out_written_len == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (op_count > 0u && ops == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (string_pool_len > 0u && string_pool == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  BoundedWriter w;
  w.init(out_buf, out_buf_cap);
  uint32_t emitted_tokens = 0u;

  for (uint32_t i = 0u; i < op_count; ++i) {
    const HexTypedEmitOp& op = ops[i];
    if (!slice_valid(op.name_off, op.name_len, string_pool_len) ||
        !slice_valid(op.field_off, op.field_len, string_pool_len)) {
      w.finish();
      *out_written_len = w.pos;
      if (out_token_count != nullptr) *out_token_count = emitted_tokens;
      return HEX_ERR_INVALID_ARG;
    }

    const char* name_ptr = (op.name_len > 0u) ? (string_pool + op.name_off) : nullptr;
    const char* field_ptr = (op.field_len > 0u) ? (string_pool + op.field_off) : nullptr;
    const uint32_t start_pos = w.pos;

    bool ok = true;
    switch (op.kind) {
      case HEX_EMIT_TOK_TEXT: {
        ok = w.write_bytes(name_ptr, op.name_len);
        break;
      }
      case HEX_EMIT_TOK_CAST: {
        ok = w.write_char('(');
        if (ok) {
          if (op.name_len > 0u) {
            ok = w.write_bytes(name_ptr, op.name_len);
          } else {
            ok = w.write_cstr(default_type_name(op.type_id));
          }
        }
        if (ok) ok = w.write_char(')');
        if (ok && op.field_len > 0u) {
          ok = w.write_bytes(field_ptr, op.field_len);
        }
        break;
      }
      case HEX_EMIT_TOK_MEMBER_ARROW: {
        if (op.name_len == 0u || op.field_len == 0u) {
          w.finish();
          *out_written_len = w.pos;
          if (out_token_count != nullptr) *out_token_count = emitted_tokens;
          return HEX_ERR_INVALID_ARG;
        }
        ok = w.write_bytes(name_ptr, op.name_len) &&
             w.write_bytes("->", 2u) &&
             w.write_bytes(field_ptr, op.field_len);
        break;
      }
      case HEX_EMIT_TOK_MEMBER_DOT: {
        if (op.name_len == 0u || op.field_len == 0u) {
          w.finish();
          *out_written_len = w.pos;
          if (out_token_count != nullptr) *out_token_count = emitted_tokens;
          return HEX_ERR_INVALID_ARG;
        }
        ok = w.write_bytes(name_ptr, op.name_len) &&
             w.write_char('.') &&
             w.write_bytes(field_ptr, op.field_len);
        break;
      }
      case HEX_EMIT_TOK_SHIFTED_PTR: {
        const bool has_target = (op.field_len > 0u);
        ok = w.write_bytes("((", 2u);
        if (ok) {
          ok = has_target ? w.write_bytes(field_ptr, op.field_len)
                          : w.write_cstr("uint8_t");
        }
        if (ok) ok = w.write_bytes("*)", 2u);
        if (ok) {
          if (op.offset_or_imm == 0ll) {
            ok = w.write_bytes(name_ptr, op.name_len);
          } else {
            const bool neg = (op.offset_or_imm < 0ll);
            const uint64_t mag = neg
                ? (static_cast<uint64_t>(-(op.offset_or_imm + 1ll)) + 1ull)
                : static_cast<uint64_t>(op.offset_or_imm);
            ok = w.write_bytes("((uint8_t*)", 11u) &&
                 w.write_bytes(name_ptr, op.name_len) &&
                 w.write_bytes(neg ? " - " : " + ", 3u) &&
                 w.write_hex_u64(mag, true) &&
                 w.write_char(')');
          }
        }
        if (ok) ok = w.write_char(')');
        break;
      }
      case HEX_EMIT_TOK_ASM_ISLAND: {
        const uint64_t raw_word = static_cast<uint64_t>(static_cast<uint32_t>(op.offset_or_imm));
        // §6.1 priority: JS_PARITY (1) > TYPED_UI (2) > TYPED_C11 (3)
        const bool use_c11_path =
            ((op.flags & HEX_TYPED_EMIT_FLAG_JS_PARITY) == 0u) &&
            ((op.flags & HEX_TYPED_EMIT_FLAG_TYPED_UI) == 0u) &&
            ((op.flags & HEX_TYPED_EMIT_FLAG_TYPED_C11) != 0u);
        if (use_c11_path) {
          ok = w.write_cstr("__hex_asm_island(") &&
               w.write_hex_u64(op.va, true) &&
               w.write_cstr("ULL, ") &&
               w.write_hex_u64(raw_word, true) &&
               w.write_cstr("U, 0, 0);");
        } else {
          ok = w.write_cstr("__asm__ volatile(\"");
          if (ok) {
            ok = (op.name_len > 0u)
                ? w.write_escaped_c_string(name_ptr, op.name_len)
                : w.write_cstr(default_asm_mnemonic(op.aux));
          }
          if (ok) {
            ok = w.write_cstr("\" /* ") &&
                 w.write_hex_u64(raw_word, true) &&
                 w.write_cstr(" */);");
          }
        }
        break;
      }
      case HEX_EMIT_TOK_STACK_LOCAL: {
        const bool neg = (op.offset_or_imm < 0ll);
        const uint64_t mag = neg
            ? (static_cast<uint64_t>(-(op.offset_or_imm + 1ll)) + 1ull)
            : static_cast<uint64_t>(op.offset_or_imm);
        ok = w.write_cstr(neg ? "v_sp_m" : "v_sp") &&
             w.write_hex_u64(mag, false) &&
             w.write_char('_') &&
             w.write_dec_u32(op.aux);
        break;
      }
      default: {
        w.finish();
        *out_written_len = w.pos;
        if (out_token_count != nullptr) *out_token_count = emitted_tokens;
        return HEX_ERR_INVALID_ARG;
      }
    }

    if (!ok || w.overflow) {
      w.pos = start_pos;
      w.finish();
      *out_written_len = w.pos;
      if (out_token_count != nullptr) *out_token_count = emitted_tokens;
      return HEX_ERR_RESOURCE_LIMIT;
    }

    if (out_tokens != nullptr) {
      if (emitted_tokens >= out_tokens_cap) {
        w.pos = start_pos;
        w.finish();
        *out_written_len = w.pos;
        if (out_token_count != nullptr) *out_token_count = emitted_tokens;
        return HEX_ERR_RESOURCE_LIMIT;
      }
      HexTypedEmitToken& tok = out_tokens[emitted_tokens];
      tok.kind = op.kind;
      tok.type_id = op.type_id;
      tok.text_off = start_pos;
      tok.text_len = w.pos - start_pos;
      tok.va = op.va;
    }
    emitted_tokens++;
  }

  w.finish();
  *out_written_len = w.pos;
  if (out_token_count != nullptr) {
    *out_token_count = emitted_tokens;
  }
  return HEX_OK;
}

}  // extern "C"
