#ifndef HEX_BINARY_ELF_SYMBOLS_HPP
#define HEX_BINARY_ELF_SYMBOLS_HPP

#include <stddef.h>
#include <stdint.h>

#include "../../include/hex_abi.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct HexElfSymbolRecord {
  uint64_t value;     // offset 0
  uint64_t size;      // offset 8
  uint32_t name_off;  // offset 16
  uint32_t name_len;  // offset 20 (clamped NUL-terminated length; 0xFFFFFFFFu if name_off >= str_bytes_len)
  uint32_t shndx;     // offset 24 (if raw_shndx == 0xFFFF && xindex valid, read u32 from xindex; else raw u16)
  uint8_t info;       // offset 28
  uint8_t other;      // offset 29
  uint8_t flags;      // offset 30 (bit 0: name_out_of_range, bit 1: name_unterminated)
  uint8_t _pad;       // offset 31
} HexElfSymbolRecord;

static const uint32_t HEX_ELF_SYM_FLAG_64BIT = 1u << 0;
static const uint32_t HEX_ELF_SYM_FLAG_BIG_ENDIAN = 1u << 1;

static const uint8_t HEX_ELF_REC_NAME_OUT_OF_RANGE = 1u << 0;
static const uint8_t HEX_ELF_REC_NAME_UNTERMINATED = 1u << 1;

// flags bitmask:
//   bit 0 (1): is_64bit (1 = ELF64 >= 24B entry, 0 = ELF32 >= 16B entry)
//   bit 1 (2): is_big_endian (1 = BE, 0 = LE)
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
    uint32_t* out_count);

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
static_assert(sizeof(HexElfSymbolRecord) == 32u, "HexElfSymbolRecord must be 32 bytes");
static_assert(offsetof(HexElfSymbolRecord, value) == 0u, "value offset");
static_assert(offsetof(HexElfSymbolRecord, size) == 8u, "size offset");
static_assert(offsetof(HexElfSymbolRecord, name_off) == 16u, "name_off offset");
static_assert(offsetof(HexElfSymbolRecord, name_len) == 20u, "name_len offset");
static_assert(offsetof(HexElfSymbolRecord, shndx) == 24u, "shndx offset");
static_assert(offsetof(HexElfSymbolRecord, info) == 28u, "info offset");
static_assert(offsetof(HexElfSymbolRecord, other) == 29u, "other offset");
static_assert(offsetof(HexElfSymbolRecord, flags) == 30u, "flags offset");
static_assert(offsetof(HexElfSymbolRecord, _pad) == 31u, "_pad offset");
#endif

#endif  // HEX_BINARY_ELF_SYMBOLS_HPP
