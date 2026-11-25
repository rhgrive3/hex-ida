#include "string_scanner.hpp"

namespace {

static inline bool printable_code_point(uint32_t cp) {
  if (cp == 9u) return true;
  if (cp < 0x20u || (cp >= 0x7fu && cp <= 0x9fu)) return false;
  if (cp >= 0xd800u && cp <= 0xdfffu) return false;
  return cp <= 0x10ffffu;
}

// Returns ((cp << 3) | byte_len) on valid UTF-8 sequence, or 0 on invalid/truncated.
static inline uint32_t utf8_at_packed(const uint8_t* bytes, uint32_t p, uint32_t end) {
  const uint32_t b0 = bytes[p];
  if (b0 < 0x80u) return (b0 << 3u) | 1u;

  uint32_t n = 0u;
  uint32_t min_cp = 0u;
  uint32_t cp = 0u;
  if (b0 >= 0xc2u && b0 <= 0xdfu) {
    n = 2u;
    min_cp = 0x80u;
    cp = b0 & 0x1fu;
  } else if (b0 >= 0xe0u && b0 <= 0xefu) {
    n = 3u;
    min_cp = 0x800u;
    cp = b0 & 0x0fu;
  } else if (b0 >= 0xf0u && b0 <= 0xf4u) {
    n = 4u;
    min_cp = 0x10000u;
    cp = b0 & 0x07u;
  } else {
    return 0u;
  }

  if (n > end - p) return 0u;
  for (uint32_t i = 1u; i < n; ++i) {
    const uint32_t b = bytes[p + i];
    if ((b & 0xc0u) != 0x80u) return 0u;
    cp = (cp << 6u) | (b & 0x3fu);
  }
  if (cp < min_cp || cp > 0x10ffffu || (cp >= 0xd800u && cp <= 0xdfffu)) return 0u;
  return (cp << 3u) | n;
}

// Returns ((cp << 3) | byte_len) on valid UTF-16 code point (2 or 4 bytes), or 0 on invalid/truncated.
static inline uint32_t utf16_at_packed(const uint8_t* bytes, uint32_t p, uint32_t end, bool be) {
  if (end - p < 2u) return 0u;
  const uint32_t u = be
      ? ((static_cast<uint32_t>(bytes[p]) << 8u) | static_cast<uint32_t>(bytes[p + 1u]))
      : (static_cast<uint32_t>(bytes[p]) | (static_cast<uint32_t>(bytes[p + 1u]) << 8u));
  if (u >= 0xd800u && u <= 0xdbffu) {
    if (end - p < 4u) return 0u;
    const uint32_t v = be
        ? ((static_cast<uint32_t>(bytes[p + 2u]) << 8u) | static_cast<uint32_t>(bytes[p + 3u]))
        : (static_cast<uint32_t>(bytes[p + 2u]) | (static_cast<uint32_t>(bytes[p + 3u]) << 8u));
    if (v < 0xdc00u || v > 0xdfffu) return 0u;
    const uint32_t cp = 0x10000u + ((u - 0xd800u) << 10u) + (v - 0xdc00u);
    return (cp << 3u) | 4u;
  }
  if (u >= 0xdc00u && u <= 0xdfffu) return 0u;
  return (u << 3u) | 2u;
}

static inline void scan_utf16_encoding(
    const uint8_t* bytes,
    uint32_t start,
    uint32_t end,
    uint32_t range_idx,
    uint32_t min_chars,
    uint32_t max_chars,
    bool be,
    uint32_t encoding_id,
    uint32_t max_results,
    HexStringSpan* out_spans,
    uint32_t* count_io) {
  uint32_t count = *count_io;
  for (uint32_t parity = 0u; parity < 2u && count < max_results; ++parity) {
    const uint32_t delta = (parity - (start & 1u) + 2u) & 1u;
    if (delta > end - start) continue;
    uint32_t p = start + delta;
    while (end - p >= 2u && count < max_results) {
      const uint32_t first = utf16_at_packed(bytes, p, end, be);
      if (first == 0u || !printable_code_point(first >> 3u)) {
        if (end - p <= 2u) break;
        p += 2u;
        continue;
      }
      const uint32_t s = p;
      uint32_t q = p;
      uint32_t chars = 0u;
      while (end - q >= 2u && chars < max_chars) {
        const uint32_t x = utf16_at_packed(bytes, q, end, be);
        if (x == 0u || !printable_code_point(x >> 3u)) break;
        q += (x & 7u);
        ++chars;
      }
      if (chars >= min_chars) {
        out_spans[count].file_offset = s;
        out_spans[count].byte_length = q - s;
        out_spans[count].encoding = encoding_id;
        out_spans[count].range_idx = range_idx;
        ++count;
      }
      const uint64_t adv = (chars >= max_chars)
          ? static_cast<uint64_t>(q)
          : static_cast<uint64_t>(q) + (q < end ? 2ULL : 0ULL);
      const uint64_t min_next = static_cast<uint64_t>(p) + 2ULL;
      const uint64_t next_p = (adv > min_next) ? adv : min_next;
      if (next_p >= static_cast<uint64_t>(end)) break;
      p = static_cast<uint32_t>(next_p);
    }
  }
  *count_io = count;
}

}  // namespace

extern "C" {

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
    uint32_t* out_count) {
  if (!out_count) return HEX_ERR_INVALID_ARG;
  *out_count = 0u;

  if ((byte_len > 0u && !bytes) ||
      (range_count > 0u && !ranges) ||
      (max_results > 0u && !out_spans) ||
      min_chars < 2u ||
      max_chars < min_chars) {
    return HEX_ERR_INVALID_ARG;
  }

  if (byte_len == 0u || range_count == 0u || max_results == 0u || (flags & 7u) == 0u) {
    return HEX_OK;
  }

  const bool scan_utf8 = (flags & HEX_STRING_SCAN_UTF8) != 0u;
  const bool scan_utf16le = (flags & HEX_STRING_SCAN_UTF16LE) != 0u;
  const bool scan_utf16be = (flags & HEX_STRING_SCAN_UTF16BE) != 0u;

  uint32_t count = 0u;

  for (uint32_t r = 0u; r < range_count; ++r) {
    if (count >= max_results) break;
    const uint32_t start = ranges[r].start;
    uint32_t end = ranges[r].end;
    if (start >= byte_len || start >= end) continue;
    if (end > byte_len) end = byte_len;
    const uint32_t ridx = ranges[r].range_idx;

    if (scan_utf8) {
      for (uint32_t p = start; p < end && count < max_results;) {
        const uint8_t b0 = bytes[p];
        if (b0 < 0x80u) {
          if (b0 != 9u && (b0 < 0x20u || b0 > 0x7eu)) {
            ++p;
            continue;
          }
        } else {
          const uint32_t first = utf8_at_packed(bytes, p, end);
          if (first == 0u || !printable_code_point(first >> 3u)) {
            ++p;
            continue;
          }
        }
        const uint32_t s = p;
        uint32_t q = p;
        uint32_t chars = 0u;
        while (q < end && chars < max_chars) {
          const uint8_t b = bytes[q];
          if (b < 0x80u) {
            if (b != 9u && (b < 0x20u || b > 0x7eu)) break;
            ++q;
            ++chars;
          } else {
            const uint32_t x = utf8_at_packed(bytes, q, end);
            if (x == 0u || !printable_code_point(x >> 3u)) break;
            q += (x & 7u);
            ++chars;
          }
        }
        if (chars >= min_chars) {
          out_spans[count].file_offset = s;
          out_spans[count].byte_length = q - s;
          out_spans[count].encoding = HEX_STRING_ENC_UTF8;
          out_spans[count].range_idx = ridx;
          ++count;
        }
        const uint64_t adv = (chars >= max_chars)
            ? static_cast<uint64_t>(q)
            : static_cast<uint64_t>(q) + (q < end ? 1ULL : 0ULL);
        const uint64_t min_next = static_cast<uint64_t>(p) + 1ULL;
        const uint64_t next_p = (adv > min_next) ? adv : min_next;
        if (next_p >= static_cast<uint64_t>(end)) break;
        p = static_cast<uint32_t>(next_p);
      }
    }

    if (scan_utf16le && count < max_results) {
      scan_utf16_encoding(bytes, start, end, ridx, min_chars, max_chars,
                          false, HEX_STRING_ENC_UTF16LE, max_results, out_spans, &count);
    }

    if (scan_utf16be && count < max_results) {
      scan_utf16_encoding(bytes, start, end, ridx, min_chars, max_chars,
                          true, HEX_STRING_ENC_UTF16BE, max_results, out_spans, &count);
    }
  }

  *out_count = count;
  return HEX_OK;
}

}  // extern "C"
