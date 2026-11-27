#include "hex_hexsig.hpp"
#include "arm64_insn_bits.hpp"

namespace {

constexpr uint32_t kMaxPackBytes = 224u * 1024u;  // Slot 4 budget (224 KiB)
constexpr uint32_t kFnv32Offset = 0x811C9DC5u;
constexpr uint32_t kFnv32Prime = 0x01000193u;
constexpr uint64_t kFnv64Offset = 0xCBF29CE484222325ULL;
constexpr uint64_t kFnv64Prime = 0x100000001B3ULL;
constexpr uint16_t kMinAmbiguityMargin = 40u;

struct MountedHsigPack {
  bool mounted;
  const uint8_t* pack_ptr;
  uint32_t pack_len;
  uint16_t arch_mask;
  uint32_t entry_count;
  uint32_t entries_off;
  uint32_t str_pool_off;
  uint32_t str_pool_len;
};

MountedHsigPack g_pack{false, nullptr, 0u, 0u, 0u, 0u, 0u, 0u};

inline uint16_t read_u16_le(const uint8_t* p, uint32_t off) {
  return static_cast<uint16_t>(p[off]) |
         static_cast<uint16_t>(static_cast<uint16_t>(p[off + 1u]) << 8);
}

inline uint32_t read_u32_le(const uint8_t* p, uint32_t off) {
  return static_cast<uint32_t>(p[off]) |
         (static_cast<uint32_t>(p[off + 1u]) << 8) |
         (static_cast<uint32_t>(p[off + 2u]) << 16) |
         (static_cast<uint32_t>(p[off + 3u]) << 24);
}

inline uint64_t read_u64_le(const uint8_t* p, uint32_t off) {
  return static_cast<uint64_t>(read_u32_le(p, off)) |
         (static_cast<uint64_t>(read_u32_le(p, off + 4u)) << 32);
}

inline void write_u32_le(uint8_t* p, uint32_t off, uint32_t v) {
  p[off + 0u] = static_cast<uint8_t>(v & 0xFFu);
  p[off + 1u] = static_cast<uint8_t>((v >> 8) & 0xFFu);
  p[off + 2u] = static_cast<uint8_t>((v >> 16) & 0xFFu);
  p[off + 3u] = static_cast<uint8_t>((v >> 24) & 0xFFu);
}

inline uint32_t fnv1a_32_pack(const uint8_t* p, uint32_t len) {
  uint32_t h = kFnv32Offset;
  for (uint32_t i = 0u; i < len; ++i) {
    // Zero out header checksum field at +0x1C..+0x1F
    const uint8_t b = (i >= 0x1Cu && i < 0x20u) ? 0u : p[i];
    h ^= static_cast<uint32_t>(b);
    h *= kFnv32Prime;
  }
  return h;
}

inline uint64_t fnv1a_64(const uint8_t* p, uint32_t len) {
  uint64_t h = kFnv64Offset;
  for (uint32_t i = 0u; i < len; ++i) {
    h ^= static_cast<uint64_t>(p[i]);
    h *= kFnv64Prime;
  }
  return h;
}

inline uint16_t crc16_ccitt_update(uint16_t crc, const uint8_t* p, uint32_t len) {
  for (uint32_t i = 0u; i < len; ++i) {
    crc ^= static_cast<uint16_t>(static_cast<uint16_t>(p[i]) << 8);
    for (uint32_t bit = 0u; bit < 8u; ++bit) {
      if ((crc & 0x8000u) != 0u) {
        crc = static_cast<uint16_t>((crc << 1) ^ 0x1021u);
      } else {
        crc = static_cast<uint16_t>(crc << 1);
      }
    }
  }
  return crc;
}

inline uint8_t popcnt8(uint8_t v) {
  uint8_t c = 0u;
  while (v != 0u) {
    v = static_cast<uint8_t>(v & (v - 1u));
    ++c;
  }
  return c;
}

// Normalize ARM64 instructions into out_norm / out_mask (up to max_bytes, multiple of 4)
inline uint32_t normalize_arm64_slice(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint8_t* out_norm,
    uint8_t* out_mask,
    uint32_t max_bytes) {
  const uint32_t avail = code_len & ~3u;
  const uint32_t norm_len = avail < max_bytes ? avail : max_bytes;
  uint32_t adrp_reg_mask = 0u;

  for (uint32_t off = 0u; off < norm_len; off += 4u) {
    const uint32_t w = read_u32_le(code_ptr, off);
    uint32_t mask = 0xFFFFFFFFu;

    if ((w & 0x1F000000u) == 0x10000000u) {
      // ADR / ADRP: mask immlo[30:29] and immhi[23:5]
      mask = 0x9F00001Fu;
      const uint8_t rd = static_cast<uint8_t>(w & 31u);
      if (rd < 31u) adrp_reg_mask |= (1u << rd);
    } else if ((w & 0x7C000000u) == 0x14000000u) {
      // B / BL: mask imm26[25:0]
      mask = 0xFC000000u;
    } else if ((w & 0xFF000010u) == 0x54000000u) {
      // B.cond: mask imm19[23:5]
      mask = 0xFF00001Fu;
    } else if ((w & 0x7E000000u) == 0x34000000u) {
      // CBZ / CBNZ: mask imm19[23:5]
      mask = 0xFF00001Fu;
    } else if ((w & 0x7E000000u) == 0x36000000u) {
      // TBZ / TBNZ: mask imm14[18:5]
      mask = 0xFFF8001Fu;
    } else if ((w & 0x3B000000u) == 0x18000000u) {
      // LDR (literal) / LDRSW (literal) / PRFM (literal): mask imm19[23:5]
      mask = 0xFF00001Fu;
    } else if ((w & 0x7F800000u) == 0x11000000u) {
      // ADD (immediate): if Rn came from ADRP, mask page-offset imm12[21:10]
      const uint8_t rn = static_cast<uint8_t>((w >> 5) & 31u);
      const uint8_t rd = static_cast<uint8_t>(w & 31u);
      if (rn < 31u && ((adrp_reg_mask & (1u << rn)) != 0u)) {
        mask = 0xFFC003FFu;
      }
      if (rd < 31u) adrp_reg_mask &= ~(1u << rd);
    } else if ((w & 0x3B000000u) == 0x39000000u) {
      // LDR/STR (unsigned imm): if Rn came from ADRP, mask page-offset imm12[21:10]
      const uint8_t rn = static_cast<uint8_t>((w >> 5) & 31u);
      const uint8_t rt = static_cast<uint8_t>(w & 31u);
      if (rn < 31u && ((adrp_reg_mask & (1u << rn)) != 0u)) {
        mask = 0xFFC003FFu;
      }
      if (rt < 31u && ((w & 0x00400000u) != 0u)) adrp_reg_mask &= ~(1u << rt);
    } else {
      const uint8_t rd = static_cast<uint8_t>(w & 31u);
      if (rd < 31u) adrp_reg_mask &= ~(1u << rd);
    }

    write_u32_le(out_norm, off, w & mask);
    write_u32_le(out_mask, off, mask);
  }

  for (uint32_t i = norm_len; i < max_bytes; ++i) {
    out_norm[i] = 0u;
    out_mask[i] = 0u;
  }
  return norm_len;
}

// Helper to consume x86-64 ModRM + optional SIB + displacement (including SIB mod==0 && base==5 disp32)
inline void consume_x64_modrm(
    const uint8_t* code_ptr,
    uint32_t norm_len,
    uint32_t& p,
    uint8_t* out_norm,
    uint8_t* out_mask) {
  if (p >= norm_len) return;
  const uint8_t modrm = code_ptr[p++];
  const uint8_t mod = (modrm >> 6) & 3u;
  const uint8_t rm = modrm & 7u;

  bool sib_disp32 = false;
  if (mod != 3u && rm == 4u) {
    if (p >= norm_len) {
      p = norm_len;
      return;
    }
    const uint8_t sib = code_ptr[p++];
    if (mod == 0u && (sib & 7u) == 5u) {
      sib_disp32 = true;  // Mandatory 4-byte disp32 with no base register
    }
  }

  if (mod == 0u && rm == 5u) {
    // RIP-relative disp32 -> mask 4 bytes
    for (uint32_t k = 0u; k < 4u && (p + k) < norm_len; ++k) {
      out_norm[p + k] = 0u;
      out_mask[p + k] = 0u;
    }
    p = (p + 4u <= norm_len) ? (p + 4u) : norm_len;
  } else if (sib_disp32 || mod == 2u) {
    p = (p + 4u <= norm_len) ? (p + 4u) : norm_len;
  } else if (mod == 1u) {
    p = (p + 1u <= norm_len) ? (p + 1u) : norm_len;
  }
}

inline bool x64_two_byte_has_modrm(uint8_t op2) {
  // CMOVcc (40..4F), SETcc (90..9F), MOVZX (B6/B7), MOVSX (BE/BF), IMUL (AF),
  // multi-byte NOP (1F), BT*/BSF/BSR (A3/AB/B3/BB/BC/BD), SSE mov/arith (10..17, 28..2F, 51..5F)
  if (op2 >= 0x40u && op2 <= 0x4Fu) return true;
  if (op2 >= 0x90u && op2 <= 0x9Fu) return true;
  if (op2 == 0xB6u || op2 == 0xB7u || op2 == 0xBEu || op2 == 0xBFu || op2 == 0xAFu || op2 == 0x1Fu) {
    return true;
  }
  if (op2 == 0xA3u || op2 == 0xABu || op2 == 0xB3u || op2 == 0xBBu || op2 == 0xBCu || op2 == 0xBDu) {
    return true;
  }
  if ((op2 >= 0x10u && op2 <= 0x17u) || (op2 >= 0x28u && op2 <= 0x2Fu)) return true;
  return false;
}

// Normalize x86-64 prologue bytes (masks PC-relative CALL/JMP/Jcc/RIP-rel disp32 & imm64)
inline uint32_t normalize_x64_slice(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint8_t* out_norm,
    uint8_t* out_mask,
    uint32_t max_bytes) {
  const uint32_t norm_len = code_len < max_bytes ? code_len : max_bytes;
  for (uint32_t i = 0u; i < max_bytes; ++i) {
    out_norm[i] = (i < norm_len) ? code_ptr[i] : 0u;
    out_mask[i] = (i < norm_len) ? 0xFFu : 0u;
  }

  auto mask_range = [&](uint32_t start, uint32_t count) {
    for (uint32_t k = 0u; k < count && (start + k) < norm_len; ++k) {
      out_norm[start + k] = 0u;
      out_mask[start + k] = 0u;
    }
  };

  uint32_t pos = 0u;
  while (pos < norm_len) {
    // ENDBR64: F3 0F 1E FA
    if (pos + 4u <= norm_len && code_ptr[pos] == 0xF3u && code_ptr[pos + 1u] == 0x0Fu &&
        code_ptr[pos + 2u] == 0x1Eu && code_ptr[pos + 3u] == 0xFAu) {
      pos += 4u;
      continue;
    }

    // 1. Legacy prefixes
    uint32_t p = pos;
    bool has_66 = false;
    while (p < norm_len) {
      const uint8_t b = code_ptr[p];
      if (b == 0x66u) {
        has_66 = true;
        ++p;
      } else if (b == 0x67u || b == 0xF0u || b == 0xF2u || b == 0xF3u ||
                 b == 0x2Eu || b == 0x3Eu || b == 0x26u || b == 0x64u || b == 0x65u) {
        ++p;
      } else {
        break;
      }
    }

    // 2. REX prefix (0x40..0x4F)
    uint8_t rex = 0u;
    if (p < norm_len && (code_ptr[p] & 0xF0u) == 0x40u) {
      rex = code_ptr[p];
      ++p;
    }
    if (p >= norm_len) break;

    const uint8_t op = code_ptr[p++];

    // CALL rel32 (E8) / JMP rel32 (E9)
    if (op == 0xE8u || op == 0xE9u) {
      mask_range(p, 4u);
      pos = (p + 4u <= norm_len) ? (p + 4u) : norm_len;
      continue;
    }

    // JMP rel8 (EB) / Jcc rel8 (70..7F)
    if (op == 0xEBu || (op >= 0x70u && op <= 0x7Fu)) {
      mask_range(p, 1u);
      pos = (p + 1u <= norm_len) ? (p + 1u) : norm_len;
      continue;
    }

    // 2-byte escape 0F
    if (op == 0x0Fu && p < norm_len) {
      const uint8_t op2 = code_ptr[p++];
      if (op2 >= 0x80u && op2 <= 0x8Fu) {
        // Jcc rel32
        mask_range(p, 4u);
        pos = (p + 4u <= norm_len) ? (p + 4u) : norm_len;
        continue;
      }
      if (op2 == 0xBAu) {
        // BT/BTS/BTR/BTC r/m, imm8
        consume_x64_modrm(code_ptr, norm_len, p, out_norm, out_mask);
        p = (p + 1u <= norm_len) ? (p + 1u) : norm_len;
        pos = p;
        continue;
      }
      if (x64_two_byte_has_modrm(op2)) {
        consume_x64_modrm(code_ptr, norm_len, p, out_norm, out_mask);
        pos = p;
        continue;
      }
      pos = p;
      continue;
    }

    // PUSH/POP r64 (50..5F), NOP (90), RET (C3)
    if ((op >= 0x50u && op <= 0x5Fu) || op == 0x90u || op == 0xC3u) {
      pos = p;
      continue;
    }

    // MOV r64, imm64 (REX.W + B8..BF) or MOV r32, imm32 (B8..BF)
    if (op >= 0xB8u && op <= 0xBFu) {
      const uint32_t imm_len = ((rex & 0x08u) != 0u) ? 8u : (has_66 ? 2u : 4u);
      if (imm_len >= 4u) mask_range(p, imm_len);
      pos = (p + imm_len <= norm_len) ? (p + imm_len) : norm_len;
      continue;
    }

    // Common ModRM instructions: MOV (88..8B), LEA (8D), ALU (01/03/29/2B/31/33/39/3B/81/83/85/C1/C7/FF)
    const bool has_modrm =
        (op == 0x88u || op == 0x89u || op == 0x8Au || op == 0x8Bu || op == 0x8Du ||
         op == 0x81u || op == 0x83u || op == 0x85u || op == 0x01u || op == 0x03u ||
         op == 0x29u || op == 0x2Bu || op == 0x31u || op == 0x33u || op == 0x39u ||
         op == 0x3Bu || op == 0xC1u || op == 0xC7u || op == 0xFFu);
    if (has_modrm && p < norm_len) {
      consume_x64_modrm(code_ptr, norm_len, p, out_norm, out_mask);
      if (op == 0x83u || op == 0xC1u) {
        p = (p + 1u <= norm_len) ? (p + 1u) : norm_len;
      } else if (op == 0x81u || op == 0xC7u) {
        const uint32_t ilen = has_66 ? 2u : 4u;
        p = (p + ilen <= norm_len) ? (p + ilen) : norm_len;
      }
      pos = p;
      continue;
    }

    // Fallback: advance 1 byte from original position
    pos = p;
  }

  return norm_len;
}

inline uint16_t compute_normalized_tail_crc16(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint32_t tail_offset,
    uint32_t tail_len,
    uint32_t arch) {
  if (tail_len == 0u || tail_offset > code_len || tail_len > code_len - tail_offset) {
    return 0u;
  }
  uint16_t crc = 0xFFFFu;
  uint32_t consumed = 0u;
  while (consumed < tail_len) {
    const uint32_t rem = tail_len - consumed;
    const uint32_t chunk = rem < 32u ? rem : 32u;
    uint8_t norm[32];
    uint8_t mask[32];
    uint32_t nlen = 0u;
    if (arch == HEX_SIG_ARCH_ARM64) {
      nlen = normalize_arm64_slice(code_ptr + tail_offset + consumed, chunk, norm, mask, chunk);
      if (nlen < chunk) {
        for (uint32_t i = nlen; i < chunk; ++i) {
          norm[i] = code_ptr[tail_offset + consumed + i];
        }
        nlen = chunk;
      }
    } else {
      nlen = normalize_x64_slice(code_ptr + tail_offset + consumed, chunk, norm, mask, chunk);
    }
    crc = crc16_ccitt_update(crc, norm, nlen);
    consumed += chunk;
  }
  return crc;
}

inline HexSigEntry read_entry_le(const uint8_t* base, uint32_t off) {
  HexSigEntry e{};
  e.prologue_hash64 = read_u64_le(base, off + 0x00u);
  e.name_off = read_u32_le(base, off + 0x08u);
  e.name_len = read_u16_le(base, off + 0x0Cu);
  e.tail_crc16 = read_u16_le(base, off + 0x0Eu);
  e.tail_offset = read_u16_le(base, off + 0x10u);
  e.tail_len = read_u16_le(base, off + 0x12u);
  e.flags = read_u16_le(base, off + 0x14u);
  e.arch = base[off + 0x16u];
  e.prologue_len = base[off + 0x17u];
  e.min_func_len = read_u16_le(base, off + 0x18u);
  e.lib_id = read_u16_le(base, off + 0x1Au);
  e.base_confidence = read_u16_le(base, off + 0x1Cu);
  e.reserved = read_u16_le(base, off + 0x1Eu);
  for (uint32_t i = 0u; i < 32u; ++i) {
    e.pattern[i] = base[off + 0x20u + i];
    e.wildcard_mask[i] = base[off + 0x40u + i];
  }
  return e;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_hexsig_mount")
HexStatus hex_hexsig_mount(const uint8_t* pack_ptr, uint32_t pack_len) {
  if (pack_ptr == nullptr || pack_len < sizeof(HexSigHeader) || pack_len > kMaxPackBytes) {
    return HEX_ERR_INVALID_ARG;
  }

  // Validate header magic "HSIG" and version == 1
  if (pack_ptr[0] != 'H' || pack_ptr[1] != 'S' || pack_ptr[2] != 'I' || pack_ptr[3] != 'G') {
    return HEX_ERR_INVALID_ARG;
  }
  const uint16_t version = read_u16_le(pack_ptr, 0x04u);
  const uint16_t arch_mask = read_u16_le(pack_ptr, 0x06u);
  const uint32_t entry_count = read_u32_le(pack_ptr, 0x08u);
  const uint32_t entries_off = read_u32_le(pack_ptr, 0x0Cu);
  const uint32_t str_pool_off = read_u32_le(pack_ptr, 0x10u);
  const uint32_t str_pool_len = read_u32_le(pack_ptr, 0x14u);
  const uint32_t total_size = read_u32_le(pack_ptr, 0x18u);
  const uint32_t expected_crc = read_u32_le(pack_ptr, 0x1Cu);

  if (version != 1u) return HEX_ERR_UNSUPPORTED;
  if (arch_mask == 0u || (arch_mask & ~(HEX_SIG_ARCH_ARM64 | HEX_SIG_ARCH_X64)) != 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  if (total_size != pack_len) return HEX_ERR_INVALID_ARG;
  if (entries_off < sizeof(HexSigHeader) || (entries_off & 7u) != 0u) {
    return HEX_ERR_INVALID_ARG;
  }

  // Overflow-safe section bounds checks
  const uint32_t max_entries = (pack_len - entries_off) / sizeof(HexSigEntry);
  if (entry_count > max_entries) return HEX_ERR_INVALID_ARG;
  const uint32_t entries_end = entries_off + entry_count * static_cast<uint32_t>(sizeof(HexSigEntry));

  if (str_pool_off < entries_end || str_pool_off > pack_len) return HEX_ERR_INVALID_ARG;
  if (str_pool_len > pack_len - str_pool_off) return HEX_ERR_INVALID_ARG;

  // Verify FNV-1a 32-bit pack checksum
  const uint32_t actual_crc = fnv1a_32_pack(pack_ptr, pack_len);
  if (actual_crc != expected_crc) return HEX_ERR_INVALID_ARG;

  // Validate every entry's metadata and string pool bounds
  const uint8_t* str_pool = pack_ptr + str_pool_off;
  for (uint32_t i = 0u; i < entry_count; ++i) {
    const uint32_t eoff = entries_off + i * static_cast<uint32_t>(sizeof(HexSigEntry));
    const HexSigEntry e = read_entry_le(pack_ptr, eoff);
    if (e.arch != HEX_SIG_ARCH_ARM64 && e.arch != HEX_SIG_ARCH_X64) {
      return HEX_ERR_INVALID_ARG;
    }
    if ((e.arch & arch_mask) == 0u) {
      return HEX_ERR_INVALID_ARG;
    }
    if (e.prologue_len < 4u || e.prologue_len > 32u) {
      return HEX_ERR_INVALID_ARG;
    }
    if (e.arch == HEX_SIG_ARCH_ARM64 && (e.prologue_len & 3u) != 0u) {
      return HEX_ERR_INVALID_ARG;
    }
    if (e.name_off >= str_pool_len || e.name_len >= str_pool_len - e.name_off) {
      return HEX_ERR_INVALID_ARG;
    }
    if (str_pool[e.name_off + e.name_len] != 0u) {
      return HEX_ERR_INVALID_ARG;
    }
  }

  g_pack.mounted = true;
  g_pack.pack_ptr = pack_ptr;
  g_pack.pack_len = pack_len;
  g_pack.arch_mask = arch_mask;
  g_pack.entry_count = entry_count;
  g_pack.entries_off = entries_off;
  g_pack.str_pool_off = str_pool_off;
  g_pack.str_pool_len = str_pool_len;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_hexsig_normalize_arm64")
HexStatus hex_hexsig_normalize_arm64(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint8_t* out_norm32,
    uint8_t* out_mask32,
    uint64_t* out_hash64) {
  if (code_ptr == nullptr || out_norm32 == nullptr || out_mask32 == nullptr || code_len < 4u) {
    return HEX_ERR_INVALID_ARG;
  }
  const uint32_t nlen = normalize_arm64_slice(code_ptr, code_len, out_norm32, out_mask32, 32u);
  if (out_hash64 != nullptr) {
    *out_hash64 = fnv1a_64(out_norm32, nlen);
  }
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_hexsig_normalize_x64")
HexStatus hex_hexsig_normalize_x64(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint8_t* out_norm32,
    uint8_t* out_mask32,
    uint64_t* out_hash64) {
  if (code_ptr == nullptr || out_norm32 == nullptr || out_mask32 == nullptr || code_len < 1u) {
    return HEX_ERR_INVALID_ARG;
  }
  const uint32_t nlen = normalize_x64_slice(code_ptr, code_len, out_norm32, out_mask32, 32u);
  if (out_hash64 != nullptr) {
    *out_hash64 = fnv1a_64(out_norm32, nlen);
  }
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_hexsig_match_fn")
HexStatus hex_hexsig_match_fn(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint32_t arch,
    HexSigMatchResult* out_result) {
  if (code_ptr == nullptr || out_result == nullptr || code_len < 4u) {
    return HEX_ERR_INVALID_ARG;
  }
  if (arch != HEX_SIG_ARCH_ARM64 && arch != HEX_SIG_ARCH_X64) {
    return HEX_ERR_INVALID_ARG;
  }

  out_result->query_hash64 = 0ULL;
  out_result->entry_index = 0xFFFFFFFFu;
  out_result->name_off = 0xFFFFFFFFu;
  out_result->name_len = 0u;
  out_result->lib_id = 0xFFFFu;
  out_result->confidence = 0u;
  out_result->runner_up_conf = 0u;
  out_result->matched_bits = 0u;
  out_result->tail_crc16_actual = 0u;
  out_result->status = HEX_SIG_MATCH_NONE;
  out_result->tail_crc_matched = 0u;
  out_result->candidate_count = 0u;

  if (!g_pack.mounted || g_pack.pack_ptr == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  uint8_t q_norm[32];
  uint8_t q_mask[32];
  uint32_t q_len = 0u;
  if (arch == HEX_SIG_ARCH_ARM64) {
    q_len = normalize_arm64_slice(code_ptr, code_len, q_norm, q_mask, 32u);
  } else {
    q_len = normalize_x64_slice(code_ptr, code_len, q_norm, q_mask, 32u);
  }
  const uint64_t q_hash64 = fnv1a_64(q_norm, q_len);
  out_result->query_hash64 = q_hash64;

  uint32_t best_idx = 0xFFFFFFFFu;
  uint32_t best_name_off = 0xFFFFFFFFu;
  uint16_t best_name_len = 0u;
  uint16_t best_lib_id = 0xFFFFu;
  uint16_t best_conf = 0u;
  uint16_t second_conf = 0u;
  uint16_t best_bits = 0u;
  uint16_t best_crc = 0u;
  uint8_t best_tail_ok = 0u;
  uint16_t cand_count = 0u;

  for (uint32_t i = 0u; i < g_pack.entry_count; ++i) {
    const uint32_t eoff = g_pack.entries_off + i * static_cast<uint32_t>(sizeof(HexSigEntry));
    const HexSigEntry e = read_entry_le(g_pack.pack_ptr, eoff);

    if (e.arch != arch) continue;
    if (code_len < e.min_func_len || q_len < e.prologue_len) continue;

    // Stage 1: Fast FNV-1a 64-bit hash filter for non-wildcard entries
    if ((e.flags & HEX_SIG_ENTRY_HAS_WILDCARDS) == 0u) {
      const uint64_t qh = (e.prologue_len == q_len) ? q_hash64 : fnv1a_64(q_norm, e.prologue_len);
      if (qh != e.prologue_hash64) continue;
    }

    // Stage 2a: Masked-byte verification
    bool bytes_ok = true;
    uint16_t fixed_bits = 0u;
    for (uint32_t b = 0u; b < e.prologue_len; ++b) {
      const uint8_t m = e.wildcard_mask[b];
      if ((q_norm[b] & m) != (e.pattern[b] & m)) {
        bytes_ok = false;
        break;
      }
      fixed_bits = static_cast<uint16_t>(fixed_bits + popcnt8(m));
    }
    if (!bytes_ok) continue;

    // Stage 2b: Tail CRC16 verification (when required by entry)
    uint8_t tail_matched = 0u;
    uint16_t actual_crc = 0u;
    if ((e.flags & HEX_SIG_ENTRY_HAS_TAIL_CRC) != 0u && e.tail_len > 0u) {
      if (static_cast<uint32_t>(e.tail_offset) > code_len ||
          static_cast<uint32_t>(e.tail_len) > code_len - static_cast<uint32_t>(e.tail_offset)) {
        continue;
      }
      actual_crc = compute_normalized_tail_crc16(code_ptr, code_len, e.tail_offset, e.tail_len, arch);
      if (actual_crc != e.tail_crc16) continue;
      tail_matched = 1u;
    }

    // Count candidate only after passing BOTH prologue and Tail CRC16 verification
    if (cand_count < 0xFFFFu) ++cand_count;

    // Confidence calculation (0..1000)
    const uint32_t base_c = e.base_confidence > 0u ? e.base_confidence : 850u;
    const uint32_t total_bits = static_cast<uint32_t>(e.prologue_len) * 8u;
    uint32_t score = (total_bits > 0u) ? ((base_c / 2u) + ((base_c - base_c / 2u) * fixed_bits) / total_bits) : 0u;
    if (tail_matched) score += 100u;
    if (e.prologue_len == 32u) score += 20u;
    if (score > 1000u) score = 1000u;
    const uint16_t conf = static_cast<uint16_t>(score);

    if (conf > best_conf) {
      second_conf = best_conf;
      best_conf = conf;
      best_idx = i;
      best_name_off = e.name_off;
      best_name_len = e.name_len;
      best_lib_id = e.lib_id;
      best_bits = fixed_bits;
      best_crc = actual_crc;
      best_tail_ok = tail_matched;
    } else if (conf > second_conf) {
      second_conf = conf;
    }
  }

  out_result->candidate_count = cand_count;
  if (best_idx != 0xFFFFFFFFu) {
    out_result->entry_index = best_idx;
    out_result->name_off = best_name_off;
    out_result->name_len = best_name_len;
    out_result->lib_id = best_lib_id;
    out_result->confidence = best_conf;
    out_result->runner_up_conf = second_conf;
    out_result->matched_bits = best_bits;
    out_result->tail_crc16_actual = best_crc;
    out_result->tail_crc_matched = best_tail_ok;
    const uint16_t margin = (best_conf >= second_conf) ? static_cast<uint16_t>(best_conf - second_conf) : 0u;
    if (cand_count > 1u && margin < kMinAmbiguityMargin) {
      out_result->status = HEX_SIG_MATCH_AMBIGUOUS;
    } else if (best_tail_ok) {
      out_result->status = HEX_SIG_MATCH_FULL;
    } else {
      out_result->status = HEX_SIG_MATCH_PROLOGUE;
    }
  }

  return HEX_OK;
}

}  // extern "C"
