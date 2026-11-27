#include <stddef.h>
#include <stdint.h>
#include "hex_abi.hpp"

namespace {

inline uint32_t read_u32_le(const uint8_t* p) {
  return static_cast<uint32_t>(p[0])
      | (static_cast<uint32_t>(p[1]) << 8)
      | (static_cast<uint32_t>(p[2]) << 16)
      | (static_cast<uint32_t>(p[3]) << 24);
}

inline uint64_t read_u64_le(const uint8_t* p) {
  const uint64_t lo = static_cast<uint64_t>(read_u32_le(p));
  const uint64_t hi = static_cast<uint64_t>(read_u32_le(p + 4));
  return lo | (hi << 32);
}

inline void write_u32_le(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFFu);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
  p[2] = static_cast<uint8_t>((v >> 16) & 0xFFu);
  p[3] = static_cast<uint8_t>((v >> 24) & 0xFFu);
}

inline uint64_t read_ptr_raw(const uint8_t* p, uint32_t ptr_size) {
  return ptr_size == 8u ? read_u64_le(p) : static_cast<uint64_t>(read_u32_le(p));
}

inline uint64_t normalize_ptr(uint64_t raw, bool strip_pac) {
  return strip_pac ? (raw & 0x0000FFFFFFFFFFFFULL) : raw;
}

inline bool is_valid_code_ptr(uint64_t va, uint64_t text_lo, uint64_t text_hi) {
  return va >= text_lo && va < text_hi && ((va & 3ULL) == 0ULL);
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_scan_vtables")
uint32_t hex_scan_vtables(
    const uint8_t* data_ptr,
    uint32_t data_len,
    uint32_t text_lo_lo,
    uint32_t text_lo_hi,
    uint32_t text_hi_lo,
    uint32_t text_hi_hi,
    uint32_t ptr_size,
    uint32_t in_flags,
    uint8_t* out_ptr,
    uint32_t max_out) {
  const uint64_t text_lo =
      static_cast<uint64_t>(text_lo_lo) | (static_cast<uint64_t>(text_lo_hi) << 32);
  const uint64_t text_hi =
      static_cast<uint64_t>(text_hi_lo) | (static_cast<uint64_t>(text_hi_hi) << 32);

  if (data_ptr == nullptr || out_ptr == nullptr || max_out == 0u ||
      (ptr_size != 4u && ptr_size != 8u) || data_len < ptr_size * 3u ||
      text_hi <= text_lo) {
    return 0u;
  }

  const bool strip_pac = ((in_flags & 1u) != 0u) && (ptr_size == 8u);
  const uint32_t last_start = data_len - ptr_size * 3u;
  const uint32_t last_slot = data_len - ptr_size;

  uint32_t off = 0u;
  uint32_t count = 0u;

  while (off <= last_start && count < max_out) {
    const uint64_t raw0 = read_ptr_raw(data_ptr + off, ptr_size);
    const uint64_t va0 = normalize_ptr(raw0, strip_pac);
    if (!is_valid_code_ptr(va0, text_lo, text_hi)) {
      off += ptr_size;
      continue;
    }

    uint32_t entry_count = 1u;
    bool pac_stripped = strip_pac && ((raw0 >> 48) != 0ULL);
    uint32_t run_end = off + ptr_size;

    while (run_end <= last_slot) {
      const uint64_t raw_i = read_ptr_raw(data_ptr + run_end, ptr_size);
      const uint64_t va_i = normalize_ptr(raw_i, strip_pac);
      if (!is_valid_code_ptr(va_i, text_lo, text_hi)) {
        break;
      }
      if (strip_pac && ((raw_i >> 48) != 0ULL)) {
        pac_stripped = true;
      }
      entry_count += 1u;
      run_end += ptr_size;
    }

    if (entry_count >= 3u) {
      const uint32_t vtable_off = off;
      int32_t out_offset_to_top = 0;
      uint64_t out_rtti_ptr = 0ULL;
      uint32_t has_rtti = 0u;

      if (vtable_off >= 2u * ptr_size) {
        const int64_t off_top = (ptr_size == 8u)
            ? static_cast<int64_t>(read_u64_le(data_ptr + (vtable_off - 16u)))
            : static_cast<int64_t>(static_cast<int32_t>(read_u32_le(data_ptr + (vtable_off - 8u))));
        const uint64_t rtti_raw = read_ptr_raw(data_ptr + (vtable_off - ptr_size), ptr_size);
        const uint64_t rtti_ptr = normalize_ptr(rtti_raw, strip_pac);

        const bool top_ok = (off_top >= -0x100000LL) && (off_top <= 0LL);
        const bool rtti_ok = (rtti_ptr != 0ULL) &&
                             ((rtti_ptr % static_cast<uint64_t>(ptr_size)) == 0ULL) &&
                             !(rtti_ptr >= text_lo && rtti_ptr < text_hi);
        if (top_ok && rtti_ok) {
          has_rtti = 1u;
          out_offset_to_top = static_cast<int32_t>(off_top);
          out_rtti_ptr = rtti_ptr;
        }
      }

      const uint32_t out_flags = (has_rtti ? 1u : 0u) | (pac_stripped ? 2u : 0u);
      uint8_t* rec = out_ptr + count * 32u;
      write_u32_le(rec + 0u, vtable_off);
      write_u32_le(rec + 4u, entry_count);
      write_u32_le(rec + 8u, static_cast<uint32_t>(out_offset_to_top));
      write_u32_le(rec + 12u, out_flags);
      write_u32_le(rec + 16u, static_cast<uint32_t>(out_rtti_ptr & 0xFFFFFFFFULL));
      write_u32_le(rec + 20u, static_cast<uint32_t>(out_rtti_ptr >> 32));
      write_u32_le(rec + 24u, static_cast<uint32_t>(va0 & 0xFFFFFFFFULL));
      write_u32_le(rec + 28u, static_cast<uint32_t>(va0 >> 32));
      count += 1u;
    }

    off = run_end;
  }

  return count;
}

}  // extern "C"
