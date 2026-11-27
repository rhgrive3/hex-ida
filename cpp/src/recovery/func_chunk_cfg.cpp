#include "hex_manual_recovery.hpp"
#include "hex_core/hex_core.hpp"

namespace {

// Slot 5A fixed backing storage for discontiguous function chunks, sorted by start_va.
alignas(8) HexFuncChunk g_func_chunks[HEX_FUNC_CHUNK_MAX_CAP];
uint32_t g_func_chunk_count = 0u;

uint32_t lower_bound_chunk_start(uint64_t start_va) {
  uint32_t lo = 0u;
  uint32_t hi = g_func_chunk_count;
  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    if (g_func_chunks[mid].start_va < start_va) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

bool validate_chunk(const HexFuncChunk* chunk) {
  if (chunk == nullptr) return false;
  if (chunk->owner_fn_va == 0u) return false;
  if (chunk->end_va <= chunk->start_va) return false;
  // §15.2 Fail-Closed: ARM64 instruction chunks must be 4-byte aligned.
  if ((chunk->start_va & 3u) != 0u || (chunk->end_va & 3u) != 0u) return false;
  if (chunk->chunk_kind > static_cast<uint32_t>(HEX_CHUNK_LSDA_LP)) return false;
  return true;
}

bool is_detached(const HexFuncChunk& c) {
  return (c.flags & HEX_CHUNK_FLAG_DETACHED) != 0u;
}

bool is_primary_chunk(const HexFuncChunk& c, uint64_t owner_fn_va) {
  return c.chunk_kind == static_cast<uint32_t>(HEX_CHUNK_PRIMARY) ||
         (c.start_va <= owner_fn_va && owner_fn_va < c.end_va);
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_func_chunk_reset")
void hex_func_chunk_reset(void) {
  g_func_chunk_count = 0u;
}

HEX_WASM_EXPORT("hex_func_chunk_add")
HexStatus hex_func_chunk_add(const HexFuncChunk* chunk) {
  if (!validate_chunk(chunk)) return HEX_ERR_INVALID_ARG;
  if (g_func_chunk_count >= HEX_FUNC_CHUNK_MAX_CAP) return HEX_ERR_RESOURCE_LIMIT;

  const uint32_t idx = lower_bound_chunk_start(chunk->start_va);

  // Reject overlap with predecessor [prev.start_va, prev.end_va).
  if (idx > 0u) {
    if (g_func_chunks[idx - 1u].end_va > chunk->start_va) return HEX_ERR_INVALID_ARG;
  }
  // Reject overlap with successor [next.start_va, next.end_va).
  if (idx < g_func_chunk_count) {
    if (chunk->end_va > g_func_chunks[idx].start_va) return HEX_ERR_INVALID_ARG;
  }

  for (uint32_t i = g_func_chunk_count; i > idx; --i) {
    g_func_chunks[i] = g_func_chunks[i - 1u];
  }
  g_func_chunks[idx] = *chunk;
  ++g_func_chunk_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_func_chunk_remove")
HexStatus hex_func_chunk_remove(uint64_t start_va) {
  const uint32_t idx = lower_bound_chunk_start(start_va);
  if (idx >= g_func_chunk_count || g_func_chunks[idx].start_va != start_va) {
    return HEX_ERR_INVALID_ARG;
  }
  for (uint32_t i = idx + 1u; i < g_func_chunk_count; ++i) {
    g_func_chunks[i - 1u] = g_func_chunks[i];
  }
  --g_func_chunk_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_func_chunk_find_owner")
HexStatus hex_func_chunk_find_owner(
    uint64_t va,
    uint64_t* out_owner_fn_va,
    HexFuncChunk* out_chunk) {
  if (g_func_chunk_count == 0u) return HEX_ERR_INVALID_ARG;

  // Find first chunk with start_va > va, then check candidate idx - 1.
  uint32_t lo = 0u;
  uint32_t hi = g_func_chunk_count;
  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    if (g_func_chunks[mid].start_va <= va) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  if (lo == 0u) return HEX_ERR_INVALID_ARG;

  const HexFuncChunk& cand = g_func_chunks[lo - 1u];
  if (va >= cand.end_va || is_detached(cand)) return HEX_ERR_INVALID_ARG;

  if (out_owner_fn_va != nullptr) {
    *out_owner_fn_va = cand.owner_fn_va;
  }
  if (out_chunk != nullptr) {
    *out_chunk = cand;
  }
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_func_chunk_list_for_fn")
HexStatus hex_func_chunk_list_for_fn(
    uint64_t owner_fn_va,
    HexFuncChunk* out_chunks,
    uint32_t max_chunks,
    uint32_t* out_count) {
  if (out_count == nullptr || owner_fn_va == 0u) return HEX_ERR_INVALID_ARG;

  uint32_t total = 0u;
  uint32_t written = 0u;
  for (uint32_t i = 0u; i < g_func_chunk_count; ++i) {
    const HexFuncChunk& c = g_func_chunks[i];
    if (c.owner_fn_va != owner_fn_va || is_detached(c)) continue;
    ++total;
    if (out_chunks != nullptr && written < max_chunks) {
      out_chunks[written++] = c;
    }
  }

  if (out_chunks != nullptr && total > max_chunks) {
    *out_count = written;
    return HEX_ERR_RESOURCE_LIMIT;
  }
  *out_count = total;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_func_chunk_merge_cfg_ranges")
HexStatus hex_func_chunk_merge_cfg_ranges(
    uint64_t owner_fn_va,
    uint32_t max_chunks_cap,
    HexFuncChunkRange* out_ranges,
    uint32_t max_ranges,
    uint32_t* out_range_count) {
  if (out_range_count == nullptr || owner_fn_va == 0u) return HEX_ERR_INVALID_ARG;

  // Gather indices of active chunks for owner_fn_va: primary first, then secondary in start_va order.
  // Bounded stack buffer: Desktop cap is 64 (§15.2); allow up to 128 before capping.
  constexpr uint32_t kScratchCap = 128u;
  uint32_t ordered_idx[kScratchCap];
  uint32_t ordered_count = 0u;
  const uint32_t effective_cap =
      (max_chunks_cap == 0u || max_chunks_cap > kScratchCap) ? kScratchCap : max_chunks_cap;
  bool truncated = false;

  // Pass 1: primary chunk(s) first so chunk_ord == 0 is always the function entry chunk.
  for (uint32_t i = 0u; i < g_func_chunk_count; ++i) {
    const HexFuncChunk& c = g_func_chunks[i];
    if (c.owner_fn_va != owner_fn_va || is_detached(c)) continue;
    if (is_primary_chunk(c, owner_fn_va)) {
      if (ordered_count < effective_cap) {
        ordered_idx[ordered_count++] = i;
      } else {
        truncated = true;
      }
    }
  }

  // Pass 2: remaining discontiguous chunks (cold / tail-call / outline / LSDA LP).
  for (uint32_t i = 0u; i < g_func_chunk_count; ++i) {
    const HexFuncChunk& c = g_func_chunks[i];
    if (c.owner_fn_va != owner_fn_va || is_detached(c)) continue;
    if (!is_primary_chunk(c, owner_fn_va)) {
      if (ordered_count < effective_cap) {
        ordered_idx[ordered_count++] = i;
      } else {
        truncated = true;
      }
    }
  }

  // Build merged HexFuncChunkRange spans: coalesce directly adjacent chunks with matching flags/kind,
  // preserving strict separation across discontiguous gaps (no implicit cross-chunk fallthrough).
  // Track coalescing state in local variables so out_ranges == nullptr measurement mode matches exactly.
  uint32_t range_count = 0u;
  uint32_t running_raw_off = 0u;
  bool has_prev = false;
  uint64_t prev_end_va = 0u;
  uint32_t prev_kind = 0u;
  uint32_t prev_flags = 0u;

  for (uint32_t k = 0u; k < ordered_count; ++k) {
    const HexFuncChunk& cur = g_func_chunks[ordered_idx[k]];
    const uint64_t span64 = cur.end_va - cur.start_va;
    if (span64 > static_cast<uint64_t>(UINT32_MAX - running_raw_off)) {
      return HEX_ERR_RESOURCE_LIMIT;
    }
    const uint32_t span32 = static_cast<uint32_t>(span64);

    if (has_prev &&
        prev_end_va == cur.start_va &&
        prev_kind == cur.chunk_kind &&
        prev_flags == cur.flags) {
      prev_end_va = cur.end_va;
      if (out_ranges != nullptr && range_count > 0u && range_count <= max_ranges) {
        out_ranges[range_count - 1u].end_va = cur.end_va;
      }
      running_raw_off += span32;
      continue;
    }

    if (out_ranges != nullptr) {
      if (range_count >= max_ranges) {
        truncated = true;
        break;
      }
      HexFuncChunkRange& dst = out_ranges[range_count];
      dst.start_va = cur.start_va;
      dst.end_va = cur.end_va;
      dst.raw_offset = running_raw_off;
      dst.chunk_ord = static_cast<uint16_t>(range_count);
      dst.chunk_flags = static_cast<uint16_t>(cur.flags & 0xFFFFu);
    }
    has_prev = true;
    prev_end_va = cur.end_va;
    prev_kind = cur.chunk_kind;
    prev_flags = cur.flags;
    running_raw_off += span32;
    ++range_count;
  }

  *out_range_count = range_count;
  return truncated ? HEX_ERR_RESOURCE_LIMIT : HEX_OK;
}

HEX_WASM_EXPORT("hex_func_chunk_count")
uint32_t hex_func_chunk_count(void) {
  return g_func_chunk_count;
}

HEX_WASM_EXPORT("hex_func_chunk_capacity")
uint32_t hex_func_chunk_capacity(void) {
  return HEX_FUNC_CHUNK_MAX_CAP;
}

}  // extern "C"
