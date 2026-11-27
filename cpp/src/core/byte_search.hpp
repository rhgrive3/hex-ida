#ifndef HEX_BYTE_SEARCH_HPP
#define HEX_BYTE_SEARCH_HPP

#include "../../include/hex_core/hex_core.hpp"

#ifdef __cplusplus
extern "C" {
#endif

static const uint32_t HEX_BYTE_SEARCH_MAX_PATTERN = 4096u;
static const uint32_t HEX_BYTE_SEARCH_NOT_FOUND = 0xFFFFFFFFu;
static const uint32_t HEX_BYTE_SEARCH_FLAG_FOLD_ASCII = 1u;
static const uint32_t HEX_BYTE_SEARCH_FLAG_HAS_MASK = 2u;

// flags bitmask:
//   bit 0 (1): fold_ascii (A-Z -> a-z on haystack & pattern; masks ignored)
//   bit 1 (2): has_mask (if set and !fold_ascii, check (haystack[at+i] & masks[i]) == pattern[i])
// Returns HEX_OK and writes match offset (>= from_offset) to *out_match_offset,
// or 0xFFFFFFFFu (UINT32_MAX) when not found.
HEX_WASM_EXPORT("hex_byte_search_find")
HexStatus hex_byte_search_find(
    const uint8_t* haystack,
    uint32_t haystack_len,
    uint32_t from_offset,
    const uint8_t* pattern,
    const uint8_t* masks,
    uint32_t pattern_len,
    uint32_t flags,
    uint32_t* out_match_offset);

#ifdef __cplusplus
}
#endif

#endif
