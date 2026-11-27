#include "hex_manual_recovery.hpp"
#include "hex_core/hex_core.hpp"

namespace {

// Slot 5A fixed backing storage for sorted non-overlapping manual segments.
alignas(8) HexManualSegment g_manual_segs[HEX_MANUAL_SEG_MAX_CAP];
uint32_t g_manual_seg_count = 0u;

// 64 KiB aligned scratch buffer for standalone WASM host <-> guest marshaling.
constexpr uint32_t kRecoveryScratchBytes = 65536u;
alignas(16) uint8_t g_recovery_scratch[kRecoveryScratchBytes];

// Returns lower_bound index in [0, g_manual_seg_count] for base_va.
uint32_t lower_bound_base_va(uint64_t base_va) {
  uint32_t lo = 0u;
  uint32_t hi = g_manual_seg_count;
  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    if (g_manual_segs[mid].base_va < base_va) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

bool is_valid_elem_size(uint8_t elem_size) {
  return elem_size == 0u || elem_size == 1u || elem_size == 2u || elem_size == 4u || elem_size == 8u;
}

bool validate_segment(const HexManualSegment* seg) {
  if (seg == nullptr) return false;
  if (seg->size == 0u) return false;
  // Prevent half-open [base_va, base_va + size) wrap-around.
  if (seg->size > (UINT64_MAX - seg->base_va)) return false;
  // Prevent file_offset + delta wrap-around when file-backed.
  if (seg->file_offset != HEX_MANUAL_SEG_NO_FILE &&
      seg->size > (UINT64_MAX - seg->file_offset)) {
    return false;
  }
  if (seg->seg_kind > static_cast<uint8_t>(HEX_MSEG_ALIGN)) return false;
  if (!is_valid_elem_size(seg->elem_size)) return false;
  if (seg->align_pow2 > 12u) return false;
  // §15.1 Fail-Closed: CODE segments require 4-byte alignment on ARM64.
  if (seg->seg_kind == static_cast<uint8_t>(HEX_MSEG_CODE)) {
    if ((seg->base_va & 3u) != 0u || (seg->size & 3u) != 0u) return false;
  }
  return true;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_recovery_scratch_ptr")
uint32_t hex_recovery_scratch_ptr(void) {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_recovery_scratch));
}

HEX_WASM_EXPORT("hex_recovery_scratch_size")
uint32_t hex_recovery_scratch_size(void) {
  return kRecoveryScratchBytes;
}

HEX_WASM_EXPORT("hex_manual_seg_reset")
void hex_manual_seg_reset(void) {
  g_manual_seg_count = 0u;
}

HEX_WASM_EXPORT("hex_manual_seg_add")
HexStatus hex_manual_seg_add(const HexManualSegment* seg) {
  if (!validate_segment(seg)) return HEX_ERR_INVALID_ARG;
  if (g_manual_seg_count >= HEX_MANUAL_SEG_MAX_CAP) return HEX_ERR_RESOURCE_LIMIT;

  const uint32_t idx = lower_bound_base_va(seg->base_va);
  const uint64_t seg_end = seg->base_va + seg->size;

  // Reject overlap with predecessor [prev.base_va, prev.base_va + prev.size).
  if (idx > 0u) {
    const HexManualSegment& prev = g_manual_segs[idx - 1u];
    const uint64_t prev_end = prev.base_va + prev.size;
    if (prev_end > seg->base_va) return HEX_ERR_INVALID_ARG;
  }

  // Reject overlap with successor [next.base_va, next.base_va + next.size).
  if (idx < g_manual_seg_count) {
    const HexManualSegment& next = g_manual_segs[idx];
    if (seg_end > next.base_va) return HEX_ERR_INVALID_ARG;
  }

  // Shift [idx, count) right by 1 to maintain sorted ascending base_va order.
  for (uint32_t i = g_manual_seg_count; i > idx; --i) {
    g_manual_segs[i] = g_manual_segs[i - 1u];
  }
  g_manual_segs[idx] = *seg;
  g_manual_segs[idx].reserved = 0u;
  ++g_manual_seg_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_manual_seg_add_entry")
int32_t hex_manual_seg_add_entry(const HexManualSegEntry* entry) {
  if (entry == nullptr) return static_cast<int32_t>(HEX_ERR_INVALID_ARG);
  if (entry->byte_len == 0u) return static_cast<int32_t>(HEX_ERR_INVALID_ARG);
  if (entry->str_encoding > 3u) return static_cast<int32_t>(HEX_ERR_INVALID_ARG);

  HexManualSegment seg{};
  seg.base_va = entry->start_va;
  seg.size = static_cast<uint64_t>(entry->byte_len);
  seg.file_offset = HEX_MANUAL_SEG_NO_FILE;
  seg.perms = (entry->kind == static_cast<uint8_t>(HEX_MSEG_CODE))
                  ? (HEX_MSEG_PERM_R | HEX_MSEG_PERM_X)
                  : HEX_MSEG_PERM_R;
  seg.flags = entry->flags;
  seg.name_off = HEX_MANUAL_NAME_NONE;
  seg.seg_kind = entry->kind;
  seg.elem_size = entry->elem_size;
  seg.align_pow2 = entry->align_pow2;
  seg.reserved = 0u;

  return static_cast<int32_t>(hex_manual_seg_add(&seg));
}

HEX_WASM_EXPORT("hex_manual_seg_load_entries")
int32_t hex_manual_seg_load_entries(const HexManualSegEntry* entries, uint32_t count) {
  if (entries == nullptr) return static_cast<int32_t>(HEX_ERR_INVALID_ARG);
  if (count > HEX_MANUAL_SEG_MAX_CAP) return static_cast<int32_t>(HEX_ERR_RESOURCE_LIMIT);

  hex_manual_seg_reset();
  for (uint32_t i = 0u; i < count; ++i) {
    const int32_t st = hex_manual_seg_add_entry(&entries[i]);
    if (st != static_cast<int32_t>(HEX_OK)) {
      // Fail-Closed: leave table clean rather than partially loaded.
      hex_manual_seg_reset();
      return st;
    }
  }
  return static_cast<int32_t>(HEX_OK);
}

HEX_WASM_EXPORT("hex_manual_seg_remove")
HexStatus hex_manual_seg_remove(uint64_t base_va) {
  const uint32_t idx = lower_bound_base_va(base_va);
  if (idx >= g_manual_seg_count || g_manual_segs[idx].base_va != base_va) {
    return HEX_ERR_INVALID_ARG;
  }
  for (uint32_t i = idx + 1u; i < g_manual_seg_count; ++i) {
    g_manual_segs[i - 1u] = g_manual_segs[i];
  }
  --g_manual_seg_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_manual_seg_lookup")
HexStatus hex_manual_seg_lookup(uint64_t va, HexManualSegment* out_seg, uint64_t* out_file_offset) {
  if (g_manual_seg_count == 0u) return HEX_ERR_INVALID_ARG;

  // Find first segment with base_va > va (upper_bound), then inspect candidate idx - 1.
  uint32_t lo = 0u;
  uint32_t hi = g_manual_seg_count;
  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    if (g_manual_segs[mid].base_va <= va) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  if (lo == 0u) return HEX_ERR_INVALID_ARG;

  const HexManualSegment& cand = g_manual_segs[lo - 1u];
  const uint64_t delta = va - cand.base_va;
  if (delta >= cand.size) return HEX_ERR_INVALID_ARG;

  if (out_seg != nullptr) {
    *out_seg = cand;
  }
  if (out_file_offset != nullptr) {
    if (cand.file_offset == HEX_MANUAL_SEG_NO_FILE) {
      *out_file_offset = HEX_MANUAL_SEG_NO_FILE;
    } else {
      *out_file_offset = cand.file_offset + delta;
    }
  }
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_manual_seg_get_at")
HexStatus hex_manual_seg_get_at(uint32_t index, HexManualSegment* out_seg) {
  if (out_seg == nullptr || index >= g_manual_seg_count) return HEX_ERR_INVALID_ARG;
  *out_seg = g_manual_segs[index];
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_manual_seg_count")
uint32_t hex_manual_seg_count(void) {
  return g_manual_seg_count;
}

HEX_WASM_EXPORT("hex_manual_seg_capacity")
uint32_t hex_manual_seg_capacity(void) {
  return HEX_MANUAL_SEG_MAX_CAP;
}

}  // extern "C"
