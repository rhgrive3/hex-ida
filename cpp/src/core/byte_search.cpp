#include "byte_search.hpp"

namespace {

static inline uint8_t fold_ascii_byte(uint8_t byte) {
  return (byte >= 65u && byte <= 90u) ? static_cast<uint8_t>(byte + 32u) : byte;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_byte_search_find")
HexStatus hex_byte_search_find(
    const uint8_t* haystack,
    uint32_t haystack_len,
    uint32_t from_offset,
    const uint8_t* pattern,
    const uint8_t* masks,
    uint32_t pattern_len,
    uint32_t flags,
    uint32_t* out_match_offset) {
  if (out_match_offset == nullptr) return HEX_ERR_INVALID_ARG;
  if (pattern == nullptr) return HEX_ERR_INVALID_ARG;
  if (pattern_len == 0u || pattern_len > HEX_BYTE_SEARCH_MAX_PATTERN) {
    return HEX_ERR_INVALID_ARG;
  }
  if (haystack_len > 0u && haystack == nullptr) return HEX_ERR_INVALID_ARG;

  const bool fold_ascii = (flags & HEX_BYTE_SEARCH_FLAG_FOLD_ASCII) != 0u;
  const bool use_mask = !fold_ascii && ((flags & HEX_BYTE_SEARCH_FLAG_HAS_MASK) != 0u);
  if (use_mask && masks == nullptr) return HEX_ERR_INVALID_ARG;

  if (from_offset > haystack_len || (haystack_len - from_offset) < pattern_len) {
    *out_match_offset = HEX_BYTE_SEARCH_NOT_FOUND;
    return HEX_OK;
  }

  if (use_mask) {
    bool all_zero_mask = true;
    for (uint32_t i = 0u; i < pattern_len; ++i) {
      if (masks[i] != 0u) {
        all_zero_mask = false;
        break;
      }
    }
    if (all_zero_mask) {
      bool all_zero_pattern = true;
      for (uint32_t i = 0u; i < pattern_len; ++i) {
        if (pattern[i] != 0u) {
          all_zero_pattern = false;
          break;
        }
      }
      *out_match_offset = all_zero_pattern ? from_offset : HEX_BYTE_SEARCH_NOT_FOUND;
      return HEX_OK;
    }
  }

  // Stack-allocated Horspool skip table (no static BSS buffer).
  uint32_t skip[256];
  for (uint32_t b = 0u; b < 256u; ++b) {
    skip[b] = pattern_len;
  }

  const uint32_t last = pattern_len - 1u;
  for (uint32_t index = 0u; index < last; ++index) {
    const uint32_t distance = last - index;
    if (fold_ascii) {
      skip[fold_ascii_byte(pattern[index])] = distance;
    } else if (!use_mask || masks[index] == 255u) {
      skip[pattern[index]] = distance;
    } else {
      const uint8_t m = masks[index];
      const uint8_t p = pattern[index];
      for (uint32_t byte = 0u; byte < 256u; ++byte) {
        if (static_cast<uint8_t>(byte & m) == p) {
          skip[byte] = distance;
        }
      }
    }
  }

  const uint64_t end = static_cast<uint64_t>(haystack_len - pattern_len);
  uint64_t at = static_cast<uint64_t>(from_offset);

  if (fold_ascii) {
    while (at <= end) {
      const uint8_t tail = fold_ascii_byte(haystack[at + last]);
      bool matched = true;
      for (uint32_t rev = pattern_len; rev > 0u; --rev) {
        const uint32_t index = rev - 1u;
        if (fold_ascii_byte(haystack[at + index]) != fold_ascii_byte(pattern[index])) {
          matched = false;
          break;
        }
      }
      if (matched) {
        *out_match_offset = static_cast<uint32_t>(at);
        return HEX_OK;
      }
      at += static_cast<uint64_t>(skip[tail]);
    }
  } else if (use_mask) {
    while (at <= end) {
      const uint8_t tail = haystack[at + last];
      bool matched = true;
      for (uint32_t rev = pattern_len; rev > 0u; --rev) {
        const uint32_t index = rev - 1u;
        if (static_cast<uint8_t>(haystack[at + index] & masks[index]) != pattern[index]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        *out_match_offset = static_cast<uint32_t>(at);
        return HEX_OK;
      }
      at += static_cast<uint64_t>(skip[tail]);
    }
  } else {
    while (at <= end) {
      const uint8_t tail = haystack[at + last];
      bool matched = true;
      for (uint32_t rev = pattern_len; rev > 0u; --rev) {
        const uint32_t index = rev - 1u;
        if (haystack[at + index] != pattern[index]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        *out_match_offset = static_cast<uint32_t>(at);
        return HEX_OK;
      }
      at += static_cast<uint64_t>(skip[tail]);
    }
  }

  *out_match_offset = HEX_BYTE_SEARCH_NOT_FOUND;
  return HEX_OK;
}

}  // extern "C"
