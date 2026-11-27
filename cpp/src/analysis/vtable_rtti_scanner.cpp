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

inline void write_vtable_record(
    uint8_t* out_ptr,
    uint32_t index,
    uint32_t vtable_off,
    uint32_t entry_count,
    int32_t offset_to_top,
    uint32_t out_flags,
    uint64_t rtti_ptr,
    uint64_t first_fn_va) {
  uint8_t* rec = out_ptr + index * 32u;
  write_u32_le(rec + 0u, vtable_off);
  write_u32_le(rec + 4u, entry_count);
  write_u32_le(rec + 8u, static_cast<uint32_t>(offset_to_top));
  write_u32_le(rec + 12u, out_flags);
  write_u32_le(rec + 16u, static_cast<uint32_t>(rtti_ptr & 0xFFFFFFFFULL));
  write_u32_le(rec + 20u, static_cast<uint32_t>(rtti_ptr >> 32));
  write_u32_le(rec + 24u, static_cast<uint32_t>(first_fn_va & 0xFFFFFFFFULL));
  write_u32_le(rec + 28u, static_cast<uint32_t>(first_fn_va >> 32));
}

inline bool decode_chained_offset_64(uint64_t raw, uint64_t image_base, uint64_t& out_va) {
  if ((raw >> 63) != 0ULL) return false;
  if (((raw >> 44) & 0x7FULL) != 0ULL) return false;
  if (((raw >> 36) & 0xFFULL) != 0ULL) return false;
  const uint64_t target = raw & 0xFFFFFFFFFULL;
  if (target == 0ULL) return false;
  if (target > UINT64_MAX - image_base) return false;
  out_va = image_base + target;
  return true;
}

inline bool resolve_relative32_va(uint64_t data_va, uint32_t off, int32_t disp, uint64_t& out_va) {
  if (disp == 0) return false;
  const uint64_t uoff = static_cast<uint64_t>(off);
  if (uoff > UINT64_MAX - data_va) return false;
  const uint64_t slot_va = data_va + uoff;
  if (disp < 0) {
    const uint64_t mag = static_cast<uint64_t>(-static_cast<int64_t>(disp));
    if (mag > slot_va) return false;
    out_va = slot_va - mag;
  } else {
    const uint64_t pos = static_cast<uint64_t>(disp);
    if (pos > UINT64_MAX - slot_va) return false;
    out_va = slot_va + pos;
  }
  return true;
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

HEX_WASM_EXPORT("hex_scan_vtables_ext")
uint32_t hex_scan_vtables_ext(
    const uint8_t* data_ptr,
    uint32_t data_len,
    uint32_t text_lo_lo,
    uint32_t text_lo_hi,
    uint32_t text_hi_lo,
    uint32_t text_hi_hi,
    uint32_t image_base_lo,
    uint32_t image_base_hi,
    uint32_t data_va_lo,
    uint32_t data_va_hi,
    uint32_t ptr_size,
    uint32_t in_flags,
    uint8_t* out_ptr,
    uint32_t max_out) {
  const uint64_t text_lo =
      static_cast<uint64_t>(text_lo_lo) | (static_cast<uint64_t>(text_lo_hi) << 32);
  const uint64_t text_hi =
      static_cast<uint64_t>(text_hi_lo) | (static_cast<uint64_t>(text_hi_hi) << 32);
  const uint64_t image_base =
      static_cast<uint64_t>(image_base_lo) | (static_cast<uint64_t>(image_base_hi) << 32);
  const uint64_t data_va =
      static_cast<uint64_t>(data_va_lo) | (static_cast<uint64_t>(data_va_hi) << 32);

  if (data_ptr == nullptr || out_ptr == nullptr || max_out == 0u ||
      (ptr_size != 4u && ptr_size != 8u) || text_hi <= text_lo) {
    return 0u;
  }

  const uint32_t min_len = ((in_flags & 4u) != 0u && data_va > 0ULL) ? 12u : (ptr_size * 3u);
  if (data_len < min_len) {
    return 0u;
  }

  const bool strip_pac = ((in_flags & 1u) != 0u) && (ptr_size == 8u);
  uint32_t count = 0u;

  // Pass 1: absolute pointers (identical to hex_scan_vtables)
  if (data_len >= ptr_size * 3u && count < max_out) {
    const uint32_t last_start = data_len - ptr_size * 3u;
    const uint32_t last_slot = data_len - ptr_size;
    uint32_t off = 0u;

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
        write_vtable_record(out_ptr, count, vtable_off, entry_count, out_offset_to_top, out_flags, out_rtti_ptr, va0);
        count += 1u;
      }

      off = run_end;
    }
  }

  // Pass 2: DYLD_CHAINED_PTR_64_OFFSET (out_flags |= 4u)
  if ((in_flags & 2u) != 0u && ptr_size == 8u && image_base > 0ULL && data_len >= 24u && count < max_out) {
    const uint32_t last_start = data_len - 24u;
    const uint32_t last_slot = data_len - 8u;
    uint32_t off = 0u;

    while (off <= last_start && count < max_out) {
      const uint64_t raw0 = read_u64_le(data_ptr + off);
      uint64_t va0 = 0ULL;
      if (!decode_chained_offset_64(raw0, image_base, va0) ||
          !is_valid_code_ptr(va0, text_lo, text_hi) ||
          is_valid_code_ptr(normalize_ptr(raw0, strip_pac), text_lo, text_hi)) {
        off += 8u;
        continue;
      }

      uint32_t entry_count = 1u;
      uint32_t run_end = off + 8u;

      while (run_end <= last_slot) {
        const uint64_t raw_i = read_u64_le(data_ptr + run_end);
        uint64_t va_i = 0ULL;
        if (!decode_chained_offset_64(raw_i, image_base, va_i) ||
            !is_valid_code_ptr(va_i, text_lo, text_hi) ||
            is_valid_code_ptr(normalize_ptr(raw_i, strip_pac), text_lo, text_hi)) {
          break;
        }
        entry_count += 1u;
        run_end += 8u;
      }

      if (entry_count >= 3u) {
        const uint32_t vtable_off = off;
        int32_t out_offset_to_top = 0;
        uint64_t out_rtti_ptr = 0ULL;
        uint32_t has_rtti = 0u;

        if (vtable_off >= 16u) {
          const int64_t off_top = static_cast<int64_t>(read_u64_le(data_ptr + (vtable_off - 16u)));
          const uint64_t rtti_raw = read_u64_le(data_ptr + (vtable_off - 8u));
          uint64_t rtti_ptr = 0ULL;
          const bool top_ok = (off_top >= -0x100000LL) && (off_top <= 0LL);
          const bool rtti_ok = decode_chained_offset_64(rtti_raw, image_base, rtti_ptr) &&
                               ((rtti_ptr & 7ULL) == 0ULL) &&
                               !(rtti_ptr >= text_lo && rtti_ptr < text_hi);
          if (top_ok && rtti_ok) {
            has_rtti = 1u;
            out_offset_to_top = static_cast<int32_t>(off_top);
            out_rtti_ptr = rtti_ptr;
          }
        }

        const uint32_t out_flags = (has_rtti ? 1u : 0u) | 4u;
        write_vtable_record(out_ptr, count, vtable_off, entry_count, out_offset_to_top, out_flags, out_rtti_ptr, va0);
        count += 1u;
      }

      off = run_end;
    }
  }

  // Pass 3: 32-bit relative vtables (out_flags |= 8u)
  if ((in_flags & 4u) != 0u && data_va > 0ULL && data_len >= 12u && count < max_out) {
    const uint32_t last_start = data_len - 12u;
    const uint32_t last_slot = data_len - 4u;
    uint32_t off = 0u;

    while (off <= last_start && count < max_out) {
      const int32_t disp0 = static_cast<int32_t>(read_u32_le(data_ptr + off));
      uint64_t va0 = 0ULL;
      if (!resolve_relative32_va(data_va, off, disp0, va0) ||
          !is_valid_code_ptr(va0, text_lo, text_hi)) {
        off += 4u;
        continue;
      }

      uint32_t entry_count = 1u;
      uint32_t run_end = off + 4u;

      while (run_end <= last_slot) {
        const int32_t disp_i = static_cast<int32_t>(read_u32_le(data_ptr + run_end));
        uint64_t va_i = 0ULL;
        if (!resolve_relative32_va(data_va, run_end, disp_i, va_i) ||
            !is_valid_code_ptr(va_i, text_lo, text_hi)) {
          break;
        }
        entry_count += 1u;
        run_end += 4u;
      }

      if (entry_count >= 3u) {
        const uint32_t vtable_off = off;
        int32_t out_offset_to_top = 0;
        uint64_t out_rtti_ptr = 0ULL;
        uint32_t has_rtti = 0u;

        if (vtable_off >= 8u) {
          const int32_t off_top = static_cast<int32_t>(read_u32_le(data_ptr + (vtable_off - 8u)));
          const int32_t rtti_disp = static_cast<int32_t>(read_u32_le(data_ptr + (vtable_off - 4u)));
          uint64_t rtti_ptr = 0ULL;
          const bool top_ok = (off_top >= -0x100000) && (off_top <= 0);
          const bool rtti_ok = resolve_relative32_va(data_va, vtable_off - 4u, rtti_disp, rtti_ptr) &&
                               (rtti_ptr != 0ULL) &&
                               ((rtti_ptr & 3ULL) == 0ULL) &&
                               !(rtti_ptr >= text_lo && rtti_ptr < text_hi);
          if (top_ok && rtti_ok) {
            has_rtti = 1u;
            out_offset_to_top = off_top;
            out_rtti_ptr = rtti_ptr;
          }
        }

        const uint32_t out_flags = (has_rtti ? 1u : 0u) | 8u;
        write_vtable_record(out_ptr, count, vtable_off, entry_count, out_offset_to_top, out_flags, out_rtti_ptr, va0);
        count += 1u;
      }

      off = run_end;
    }
  }

  return count;
}

}  // extern "C"
