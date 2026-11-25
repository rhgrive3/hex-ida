#include "elf_symbols.hpp"

namespace {

static constexpr uint32_t kMaxNameScanBytes = 1u << 20;  // 1 MiB cap per symbol name
static constexpr uint16_t kShnXindex = 0xFFFFu;

static inline uint16_t read_u16(const uint8_t* p, bool be) {
  if (be) {
    return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8u) | static_cast<uint16_t>(p[1]));
  }
  return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8u));
}

static inline uint32_t read_u32(const uint8_t* p, bool be) {
  if (be) {
    return (static_cast<uint32_t>(p[0]) << 24u) |
           (static_cast<uint32_t>(p[1]) << 16u) |
           (static_cast<uint32_t>(p[2]) << 8u) |
           static_cast<uint32_t>(p[3]);
  }
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8u) |
         (static_cast<uint32_t>(p[2]) << 16u) |
         (static_cast<uint32_t>(p[3]) << 24u);
}

static inline uint64_t read_u64(const uint8_t* p, bool be) {
  if (be) {
    return (static_cast<uint64_t>(read_u32(p, true)) << 32u) |
           static_cast<uint64_t>(read_u32(p + 4u, true));
  }
  return static_cast<uint64_t>(read_u32(p, false)) |
         (static_cast<uint64_t>(read_u32(p + 4u, false)) << 32u);
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_elf_extract_symbols")
HexStatus hex_elf_extract_symbols(
    const uint8_t* sym_bytes,
    uint32_t sym_bytes_len,
    uint32_t ent_size,
    uint32_t count,
    const uint8_t* str_bytes,
    uint32_t str_bytes_len,
    const uint8_t* xindex_bytes,
    uint32_t xindex_bytes_len,
    uint32_t flags,
    HexElfSymbolRecord* out_records,
    uint32_t max_records,
    uint32_t* out_count) {
  if (!out_count) return HEX_ERR_INVALID_ARG;
  *out_count = 0u;

  if (count == 0u) return HEX_OK;

  const bool is_64 = (flags & HEX_ELF_SYM_FLAG_64BIT) != 0u;
  const bool is_be = (flags & HEX_ELF_SYM_FLAG_BIG_ENDIAN) != 0u;
  const uint32_t min_ent = is_64 ? 24u : 16u;

  if (!sym_bytes ||
      !out_records ||
      max_records < count ||
      ent_size < min_ent ||
      static_cast<uint64_t>(count) * static_cast<uint64_t>(ent_size) > static_cast<uint64_t>(sym_bytes_len)) {
    return HEX_ERR_INVALID_ARG;
  }

  const bool xindex_valid =
      (xindex_bytes != nullptr) &&
      (static_cast<uint64_t>(count) * 4ULL <= static_cast<uint64_t>(xindex_bytes_len));

  for (uint32_t i = 0u; i < count; ++i) {
    const uint8_t* entry = sym_bytes + static_cast<size_t>(i) * static_cast<size_t>(ent_size);

    uint32_t name_off = 0u;
    uint8_t info = 0u;
    uint8_t other = 0u;
    uint16_t raw_shndx = 0u;
    uint64_t value = 0ULL;
    uint64_t size = 0ULL;

    if (is_64) {
      name_off = read_u32(entry + 0u, is_be);
      info = entry[4u];
      other = entry[5u];
      raw_shndx = read_u16(entry + 6u, is_be);
      value = read_u64(entry + 8u, is_be);
      size = read_u64(entry + 16u, is_be);
    } else {
      name_off = read_u32(entry + 0u, is_be);
      value = static_cast<uint64_t>(read_u32(entry + 4u, is_be));
      size = static_cast<uint64_t>(read_u32(entry + 8u, is_be));
      info = entry[12u];
      other = entry[13u];
      raw_shndx = read_u16(entry + 14u, is_be);
    }

    uint32_t shndx = static_cast<uint32_t>(raw_shndx);
    if (raw_shndx == kShnXindex && xindex_valid) {
      shndx = read_u32(xindex_bytes + static_cast<size_t>(i) * 4u, is_be);
    }

    uint32_t name_len = 0xFFFFFFFFu;
    uint8_t rec_flags = 0u;
    if (!str_bytes || name_off >= str_bytes_len) {
      rec_flags |= HEX_ELF_REC_NAME_OUT_OF_RANGE;
    } else {
      const uint32_t rem = str_bytes_len - name_off;
      const uint32_t scan_limit = (rem < kMaxNameScanBytes) ? rem : kMaxNameScanBytes;
      const uint8_t* s = str_bytes + name_off;
      uint32_t len = 0u;
      while (len < scan_limit && s[len] != 0u) {
        ++len;
      }
      name_len = len;
      if (len == scan_limit) {
        rec_flags |= HEX_ELF_REC_NAME_UNTERMINATED;
      }
    }

    HexElfSymbolRecord& rec = out_records[i];
    rec.value = value;
    rec.size = size;
    rec.name_off = name_off;
    rec.name_len = name_len;
    rec.shndx = shndx;
    rec.info = info;
    rec.other = other;
    rec.flags = rec_flags;
    rec._pad = 0u;
  }

  *out_count = count;
  return HEX_OK;
}

}  // extern "C"
