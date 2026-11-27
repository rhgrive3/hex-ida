#include <stddef.h>
#include <stdint.h>
#include "hex_abi.hpp"

namespace {

inline uint16_t read_u16_le(const uint8_t* p) {
  return static_cast<uint16_t>(p[0])
      | static_cast<uint16_t>(static_cast<uint16_t>(p[1]) << 8);
}

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

inline void write_u16_le(uint8_t* p, uint16_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFFu);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
}

inline void write_u32_le(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFFu);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
  p[2] = static_cast<uint8_t>((v >> 16) & 0xFFu);
  p[3] = static_cast<uint8_t>((v >> 24) & 0xFFu);
}

inline bool resolve_rel32_va(uint64_t sec_va, uint32_t off, int32_t disp, uint64_t& out_va) {
  if (disp == 0) return false;
  const uint64_t uoff = static_cast<uint64_t>(off);
  if (uoff > UINT64_MAX - sec_va) return false;
  const uint64_t slot_va = sec_va + uoff;
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

HEX_WASM_EXPORT("hex_scan_objc_ptr_list")
uint32_t hex_scan_objc_ptr_list(
    const uint8_t* data_ptr,
    uint32_t data_len,
    uint32_t image_base_lo,
    uint32_t image_base_hi,
    uint32_t in_flags,
    uint8_t* out_ptr,
    uint32_t max_out) {
  if (data_ptr == nullptr || out_ptr == nullptr || max_out == 0u || data_len < 8u) {
    return 0u;
  }

  const uint64_t image_base =
      static_cast<uint64_t>(image_base_lo) | (static_cast<uint64_t>(image_base_hi) << 32);
  const bool strip_pac = (in_flags & 1u) != 0u;
  const bool allow_chained_offset = (in_flags & 2u) != 0u;
  const bool allow_chained_vmaddr = (in_flags & 4u) != 0u;
  const bool any_chained = (in_flags & 6u) != 0u;

  const uint32_t slots = data_len >> 3;
  uint32_t count = 0u;

  for (uint32_t i = 0u; i < slots && count < max_out; ++i) {
    const uint32_t off = i << 3;
    const uint64_t raw = read_u64_le(data_ptr + off);
    if (raw == 0ULL) {
      continue;
    }

    // Chained fixup bind entry (bit63 == 1): skip immediately without falling through.
    if (any_chained && ((raw >> 63) == 1ULL)) {
      continue;
    }

    uint64_t va = 0ULL;
    uint32_t out_flags = 0u;
    const bool chained_hi_zero =
        (((raw >> 44) & 0x7FULL) == 0ULL) && (((raw >> 36) & 0xFFULL) == 0ULL);
    const uint64_t target = raw & 0xFFFFFFFFFULL;

    if (allow_chained_offset && image_base > 0ULL &&
        chained_hi_zero && target != 0ULL &&
        target < image_base && target <= UINT64_MAX - image_base) {
      va = image_base + target;
      out_flags = 2u;
    } else if (allow_chained_vmaddr &&
               chained_hi_zero && target != 0ULL &&
               target >= image_base) {
      va = target;
      out_flags = 4u;
    } else if (strip_pac) {
      va = raw & 0x0000FFFFFFFFFFFFULL;
      out_flags = (va != raw) ? 1u : 0u;
    } else {
      va = raw;
      out_flags = 0u;
    }

    if (va != 0ULL && (va & 3ULL) == 0ULL) {
      uint8_t* rec = out_ptr + count * 16u;
      write_u32_le(rec + 0u, off);
      write_u32_le(rec + 4u, out_flags);
      write_u32_le(rec + 8u, static_cast<uint32_t>(va & 0xFFFFFFFFULL));
      write_u32_le(rec + 12u, static_cast<uint32_t>(va >> 32));
      count += 1u;
    }
  }

  return count;
}

HEX_WASM_EXPORT("hex_scan_swift5_rel32_list")
uint32_t hex_scan_swift5_rel32_list(
    const uint8_t* data_ptr,
    uint32_t data_len,
    uint32_t sec_va_lo,
    uint32_t sec_va_hi,
    uint32_t in_flags,
    uint8_t* out_ptr,
    uint32_t max_out) {
  if (data_ptr == nullptr || out_ptr == nullptr || max_out == 0u || data_len < 4u) {
    return 0u;
  }

  const uint64_t sec_va =
      static_cast<uint64_t>(sec_va_lo) | (static_cast<uint64_t>(sec_va_hi) << 32);
  const bool allow_indirect = (in_flags & 1u) != 0u;

  const uint32_t slots = data_len >> 2;
  uint32_t count = 0u;

  for (uint32_t i = 0u; i < slots && count < max_out; ++i) {
    const uint32_t off = i << 2;
    const int32_t disp = static_cast<int32_t>(read_u32_le(data_ptr + off));
    const bool is_indirect = allow_indirect && ((disp & 1) != 0);
    const int32_t eff_disp = allow_indirect ? (disp & ~1) : disp;

    // Skip zero effective displacement (including disp == 1 when indirect flag is active).
    if (eff_disp == 0) {
      continue;
    }

    uint64_t target_va = 0ULL;
    if (!resolve_rel32_va(sec_va, off, eff_disp, target_va)) {
      continue;
    }

    uint8_t* rec = out_ptr + count * 16u;
    write_u32_le(rec + 0u, off);
    write_u32_le(rec + 4u, is_indirect ? 1u : 0u);
    write_u32_le(rec + 8u, static_cast<uint32_t>(target_va & 0xFFFFFFFFULL));
    write_u32_le(rec + 12u, static_cast<uint32_t>(target_va >> 32));
    count += 1u;
  }

  return count;
}

HEX_WASM_EXPORT("hex_scan_swift5_fieldmd")
uint32_t hex_scan_swift5_fieldmd(
    const uint8_t* data_ptr,
    uint32_t data_len,
    uint32_t sec_va_lo,
    uint32_t sec_va_hi,
    uint8_t* out_ptr,
    uint32_t max_out,
    uint32_t* out_consumed_ptr) {
  if (out_consumed_ptr != nullptr) {
    *out_consumed_ptr = 0u;
  }
  if (data_ptr == nullptr || out_ptr == nullptr || max_out == 0u || data_len < 16u) {
    return 0u;
  }

  const uint64_t sec_va =
      static_cast<uint64_t>(sec_va_lo) | (static_cast<uint64_t>(sec_va_hi) << 32);

  uint32_t off = 0u;
  uint32_t count = 0u;

  while (count < max_out && (data_len - off) >= 16u) {
    const int32_t mangled_type_name = static_cast<int32_t>(read_u32_le(data_ptr + off + 0u));
    const int32_t superclass = static_cast<int32_t>(read_u32_le(data_ptr + off + 4u));
    const uint16_t kind = read_u16_le(data_ptr + off + 8u);
    const uint16_t record_size = read_u16_le(data_ptr + off + 10u);
    const uint32_t num_fields = read_u32_le(data_ptr + off + 12u);

    if (kind > 10u) {
      break;
    }

    const bool valid_nonzero_rec =
        (record_size >= 12u) && (record_size <= 256u) && ((record_size & 3u) == 0u);
    if (num_fields > 0u) {
      if (!valid_nonzero_rec) {
        break;
      }
    } else {
      if (record_size != 0u && !valid_nonzero_rec) {
        break;
      }
    }

    const uint64_t fields_bytes =
        static_cast<uint64_t>(num_fields) * static_cast<uint64_t>(record_size);
    const uint64_t remaining = static_cast<uint64_t>(data_len - off - 16u);
    if (fields_bytes > remaining) {
      break;
    }

    uint32_t flags = 0u;
    uint64_t mangled_va = 0ULL;
    if (mangled_type_name != 0) {
      if (resolve_rel32_va(sec_va, off, mangled_type_name, mangled_va)) {
        flags |= 1u;
      }
    }
    if (superclass != 0) {
      flags |= 2u;
    }

    uint8_t* rec = out_ptr + count * 24u;
    write_u32_le(rec + 0u, off);
    write_u32_le(rec + 4u, num_fields);
    write_u16_le(rec + 8u, kind);
    write_u16_le(rec + 10u, record_size);
    write_u32_le(rec + 12u, flags);
    write_u32_le(rec + 16u, static_cast<uint32_t>(mangled_va & 0xFFFFFFFFULL));
    write_u32_le(rec + 20u, static_cast<uint32_t>(mangled_va >> 32));

    count += 1u;
    off += 16u + static_cast<uint32_t>(fields_bytes);
  }

  if (out_consumed_ptr != nullptr) {
    *out_consumed_ptr = off;
  }
  return count;
}

}  // extern "C"
