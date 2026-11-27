#ifndef HEX_BINARY_STRING_SCANNER_HPP
#define HEX_BINARY_STRING_SCANNER_HPP

#include <stddef.h>
#include <stdint.h>

#include "../../include/hex_abi.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct HexStringScanRange {
  uint32_t start;
  uint32_t end;
  uint32_t range_idx;
  uint32_t _pad;
} HexStringScanRange;  // 16 bytes

typedef struct HexStringSpan {
  uint32_t file_offset;
  uint32_t byte_length;
  uint32_t encoding;   // 0 = utf8, 1 = utf16le, 2 = utf16be
  uint32_t range_idx;
} HexStringSpan;  // 16 bytes

static const uint32_t HEX_STRING_SCAN_UTF8 = 1u << 0;
static const uint32_t HEX_STRING_SCAN_UTF16LE = 1u << 1;
static const uint32_t HEX_STRING_SCAN_UTF16BE = 1u << 2;

static const uint32_t HEX_STRING_ENC_UTF8 = 0u;
static const uint32_t HEX_STRING_ENC_UTF16LE = 1u;
static const uint32_t HEX_STRING_ENC_UTF16BE = 2u;

// flags bitmask:
//   bit 0 (1): scan utf8
//   bit 1 (2): scan utf16le
//   bit 2 (4): scan utf16be
HEX_WASM_EXPORT("hex_string_scan_ranges")
HexStatus hex_string_scan_ranges(
    const uint8_t* bytes,
    uint32_t byte_len,
    const HexStringScanRange* ranges,
    uint32_t range_count,
    uint32_t min_chars,
    uint32_t max_chars,
    uint32_t flags,
    uint32_t max_results,
    HexStringSpan* out_spans,
    uint32_t* out_count);

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
static_assert(sizeof(HexStringScanRange) == 16u, "HexStringScanRange must be 16 bytes");
static_assert(sizeof(HexStringSpan) == 16u, "HexStringSpan must be 16 bytes");
#endif

#endif  // HEX_BINARY_STRING_SCANNER_HPP
