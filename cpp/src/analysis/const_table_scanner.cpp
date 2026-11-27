#include <stddef.h>
#include <stdint.h>
#include "hex_abi.hpp"

namespace {

inline uint32_t load_u32_le(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8u) |
         (static_cast<uint32_t>(p[2]) << 16u) |
         (static_cast<uint32_t>(p[3]) << 24u);
}

inline void store_u32_le(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFFu);
  p[1] = static_cast<uint8_t>((v >> 8u) & 0xFFu);
  p[2] = static_cast<uint8_t>((v >> 16u) & 0xFFu);
  p[3] = static_cast<uint8_t>((v >> 24u) & 0xFFu);
}

inline void store_u16_le(uint8_t* p, uint16_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFFu);
  p[1] = static_cast<uint8_t>((v >> 8u) & 0xFFu);
}

inline bool is_ascii_byte(uint8_t b) {
  return (b >= 0x20u && b <= 0x7Eu) || b == 0x00u || b == 0x09u || b == 0x0Au || b == 0x0Du;
}

inline bool is_ascii_range(const uint8_t* data, uint32_t start_off, uint32_t byte_len) {
  for (uint32_t i = 0u; i < byte_len; ++i) {
    if (!is_ascii_byte(data[start_off + i])) return false;
  }
  return true;
}

inline void emit_entry(
    uint8_t* out_ptr,
    uint32_t& count,
    uint32_t start_off,
    uint32_t byte_len,
    uint32_t element_count,
    uint8_t kind,
    uint8_t elem_size,
    uint16_t stride) {
  uint8_t* dst = out_ptr + (count * 16u);
  store_u32_le(dst + 0u, start_off);
  store_u32_le(dst + 4u, byte_len);
  store_u32_le(dst + 8u, element_count);
  dst[12u] = kind;
  dst[13u] = elem_size;
  store_u16_le(dst + 14u, stride);
  ++count;
}

inline bool has_recorded_strided_at(
    const uint8_t* out_ptr,
    uint32_t strided_start_idx,
    uint32_t count,
    uint32_t start_off) {
  for (uint32_t i = strided_start_idx; i < count; ++i) {
    if (load_u32_le(out_ptr + (i * 16u)) == start_off) {
      return true;
    }
  }
  return false;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_scan_const_tables")
uint32_t hex_scan_const_tables(
    const uint8_t* data_ptr,
    uint32_t data_len,
    uint8_t* out_ptr,
    uint32_t max_out) {
  if (data_ptr == nullptr || out_ptr == nullptr || data_len < 16u || max_out == 0u) {
    return 0u;
  }

  uint32_t count = 0u;

  // Pass 1: f32 table (kind=1, elem_size=4, stride=4), 4B aligned
  {
    const uint32_t limit4 = data_len - 4u;
    uint32_t off = 0u;
    while (off <= limit4) {
      const uint32_t u0 = load_u32_le(data_ptr + off);
      const uint32_t e0 = (u0 >> 23u) & 0xFFu;
      if (e0 < 102u || e0 > 150u) {
        off += 4u;
        continue;
      }
      uint32_t run_end = off + 4u;
      bool all_same = true;
      while (run_end <= limit4) {
        const uint32_t u = load_u32_le(data_ptr + run_end);
        const uint32_t e = (u >> 23u) & 0xFFu;
        if (e < 102u || e > 150u) break;
        if (u != u0) all_same = false;
        run_end += 4u;
      }
      const uint32_t byte_len = run_end - off;
      const uint32_t elem_count = byte_len >> 2u;
      if (elem_count >= 4u && !all_same && !is_ascii_range(data_ptr, off, byte_len)) {
        emit_entry(out_ptr, count, off, byte_len, elem_count, 1u, 4u, 4u);
        if (count == max_out) return count;
      }
      off = run_end;
    }
  }

  // Pass 2: f64 table (kind=2, elem_size=8, stride=8), 8B aligned
  {
    const uint32_t limit8 = data_len - 8u;
    uint32_t off = 0u;
    while (off <= limit8) {
      const uint32_t lo0 = load_u32_le(data_ptr + off);
      const uint32_t hi0 = load_u32_le(data_ptr + off + 4u);
      const uint32_t e0 = (hi0 >> 20u) & 0x7FFu;
      if (e0 < 998u || e0 > 1046u) {
        off += 8u;
        continue;
      }
      uint32_t run_end = off + 8u;
      bool all_same = true;
      while (run_end <= limit8) {
        const uint32_t lo = load_u32_le(data_ptr + run_end);
        const uint32_t hi = load_u32_le(data_ptr + run_end + 4u);
        const uint32_t e = (hi >> 20u) & 0x7FFu;
        if (e < 998u || e > 1046u) break;
        if (lo != lo0 || hi != hi0) all_same = false;
        run_end += 8u;
      }
      const uint32_t byte_len = run_end - off;
      const uint32_t elem_count = byte_len >> 3u;
      if (elem_count >= 4u && !all_same && !is_ascii_range(data_ptr, off, byte_len)) {
        emit_entry(out_ptr, count, off, byte_len, elem_count, 2u, 8u, 8u);
        if (count == max_out) return count;
      }
      off = run_end;
    }
  }

  // Pass 3: strided_id table (kind=3, elem_size=4), 4B aligned per stride
  {
    static constexpr uint16_t kStrides[9] = {8u, 12u, 16u, 20u, 24u, 32u, 40u, 48u, 64u};
    const uint32_t strided_start_idx = count;
    for (uint32_t si = 0u; si < 9u; ++si) {
      const uint32_t stride = static_cast<uint32_t>(kStrides[si]);
      const uint32_t min_bytes = stride * 6u;
      if (data_len < min_bytes) continue;
      const uint32_t max_start = data_len - min_bytes;
      const uint32_t max_elem_pos = data_len - stride;
      uint32_t off = 0u;
      while (off <= max_start) {
        const uint32_t id0 = load_u32_le(data_ptr + off);
        if (id0 > 10000u) {
          off += 4u;
          continue;
        }
        uint32_t elem_count = 1u;
        uint32_t pos = off + stride;
        while (pos <= max_elem_pos) {
          if (load_u32_le(data_ptr + pos) != id0 + elem_count) break;
          ++elem_count;
          pos += stride;
        }
        if (elem_count >= 6u) {
          if (!has_recorded_strided_at(out_ptr, strided_start_idx, count, off)) {
            const uint32_t byte_len = elem_count * stride;
            emit_entry(out_ptr, count, off, byte_len, elem_count, 3u, 4u, static_cast<uint16_t>(stride));
            if (count == max_out) return count;
            off += byte_len;
            continue;
          }
        }
        off += 4u;
      }
    }
  }

  return count;
}

}  // extern "C"
