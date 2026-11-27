#include "hex_region_decomp.hpp"

namespace {

constexpr uint32_t kMaxAccesses = 2048u;
constexpr uint32_t kMaxSlots = 512u;
constexpr uint32_t kMaxDefsPerSlot = 128u;

struct StackWebScratch {
  int32_t unique_offsets[kMaxSlots];
  int64_t slot_min_start[kMaxSlots];
  int64_t slot_max_end[kMaxSlots];
  uint32_t slot_uf[kMaxSlots];
  uint8_t slot_processed[kMaxSlots];

  uint32_t group_access_idx[kMaxAccesses];

  // Candidate live-range segments for a single non-escaped single-block slot
  uint32_t seg_def_idx[kMaxDefsPerSlot + 1u];
  uint32_t seg_first_idx[kMaxDefsPerSlot + 1u];
  uint32_t seg_last_idx[kMaxDefsPerSlot + 1u];
  uint16_t seg_width[kMaxDefsPerSlot + 1u];
  uint32_t seg_type_id[kMaxDefsPerSlot + 1u];

  uint32_t uf_parent[kMaxDefsPerSlot + 1u];
  uint32_t access_seg[kMaxAccesses];
  uint32_t root_to_out_idx[kMaxDefsPerSlot + 1u];
};

StackWebScratch g_stack_scratch;

inline uint32_t uf_find(uint32_t* parent, uint32_t x) {
  while (parent[x] != x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

inline void uf_union(uint32_t* parent, uint32_t a, uint32_t b) {
  const uint32_t ra = uf_find(parent, a);
  const uint32_t rb = uf_find(parent, b);
  if (ra != rb) {
    if (ra < rb) {
      parent[rb] = ra;
    } else {
      parent[ra] = rb;
    }
  }
}

void sort_offsets_asc(int32_t* arr, uint32_t n) {
  for (uint32_t i = 1u; i < n; ++i) {
    const int32_t key = arr[i];
    uint32_t j = i;
    while (j > 0u && arr[j - 1u] > key) {
      arr[j] = arr[j - 1u];
      --j;
    }
    arr[j] = key;
  }
}

inline bool access_less(const HexStackAccessIn& a, const HexStackAccessIn& b) {
  if (a.inst_idx != b.inst_idx) return a.inst_idx < b.inst_idx;
  const uint32_t rank_a = (a.kind == HEX_STACK_ACCESS_LOAD) ? 0u
                        : (a.kind == HEX_STACK_ACCESS_STORE) ? 1u : 2u;
  const uint32_t rank_b = (b.kind == HEX_STACK_ACCESS_LOAD) ? 0u
                        : (b.kind == HEX_STACK_ACCESS_STORE) ? 1u : 2u;
  return rank_a < rank_b;
}

void sort_slot_accesses(uint32_t* indices, uint32_t n,
                        const HexStackAccessIn* accesses) {
  for (uint32_t i = 1u; i < n; ++i) {
    const uint32_t key = indices[i];
    uint32_t j = i;
    while (j > 0u && access_less(accesses[key], accesses[indices[j - 1u]])) {
      indices[j] = indices[j - 1u];
      --j;
    }
    indices[j] = key;
  }
}

inline int64_t effective_width(uint16_t width_bytes) {
  return (width_bytes > 0u) ? static_cast<int64_t>(width_bytes) : 1ll;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_stack_web_split")
int32_t hex_stack_web_split(
    const HexStackAccessIn* accesses,
    uint32_t access_count,
    HexStackWebEntry* out_webs,
    uint32_t out_webs_cap,
    uint32_t* out_web_count,
    uint32_t* out_access_web_map) {
  if (out_web_count == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  *out_web_count = 0u;
  if (access_count == 0u) {
    return HEX_OK;
  }
  if (accesses == nullptr || out_webs == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (access_count > kMaxAccesses) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  StackWebScratch& s = g_stack_scratch;

  // 1. Collect unique stack offsets sorted ascending
  uint32_t unique_count = 0u;
  for (uint32_t i = 0u; i < access_count; ++i) {
    const int32_t off = accesses[i].stack_offset;
    bool found = false;
    for (uint32_t u = 0u; u < unique_count; ++u) {
      if (s.unique_offsets[u] == off) {
        found = true;
        break;
      }
    }
    if (!found) {
      if (unique_count >= kMaxSlots) {
        return HEX_ERR_RESOURCE_LIMIT;
      }
      s.unique_offsets[unique_count++] = off;
    }
  }
  sort_offsets_asc(s.unique_offsets, unique_count);

  // 2. Compute byte interval [stack_offset, stack_offset + max_width) per unique offset
  for (uint32_t u = 0u; u < unique_count; ++u) {
    const int32_t off = s.unique_offsets[u];
    s.slot_min_start[u] = static_cast<int64_t>(off);
    s.slot_max_end[u] = static_cast<int64_t>(off) + 1ll;
    s.slot_uf[u] = u;
    s.slot_processed[u] = 0u;
  }
  for (uint32_t i = 0u; i < access_count; ++i) {
    const int32_t off = accesses[i].stack_offset;
    const int64_t end = static_cast<int64_t>(off) + effective_width(accesses[i].width_bytes);
    for (uint32_t u = 0u; u < unique_count; ++u) {
      if (s.unique_offsets[u] == off) {
        if (end > s.slot_max_end[u]) {
          s.slot_max_end[u] = end;
        }
        break;
      }
    }
  }

  // 3. Union distinct offsets whose byte ranges [start, end) intersect (partial overlap)
  for (uint32_t u = 0u; u < unique_count; ++u) {
    for (uint32_t v = u + 1u; v < unique_count; ++v) {
      if (s.slot_min_start[u] < s.slot_max_end[v] &&
          s.slot_min_start[v] < s.slot_max_end[u]) {
        uf_union(s.slot_uf, u, v);
      }
    }
  }

  uint32_t total_webs = 0u;

  // 4. Process each connected component of byte-overlapping offsets
  for (uint32_t u = 0u; u < unique_count; ++u) {
    const uint32_t comp_root = uf_find(s.slot_uf, u);
    if (s.slot_processed[comp_root]) continue;
    s.slot_processed[comp_root] = 1u;

    uint32_t comp_slot_count = 0u;
    int32_t min_slot_off = s.unique_offsets[u];
    int64_t comp_max_end = s.slot_max_end[u];
    for (uint32_t v = u; v < unique_count; ++v) {
      if (uf_find(s.slot_uf, v) == comp_root) {
        comp_slot_count++;
        if (s.unique_offsets[v] < min_slot_off) min_slot_off = s.unique_offsets[v];
        if (s.slot_max_end[v] > comp_max_end) comp_max_end = s.slot_max_end[v];
      }
    }
    const bool has_partial_overlap = (comp_slot_count > 1u);

    // Gather all accesses belonging to this offset component
    uint32_t n = 0u;
    bool escaped = false;
    bool width_mismatch = false;
    bool multi_block = false;
    uint32_t first_block = 0u;
    bool have_block = false;
    uint16_t first_width = 0u;
    uint16_t max_width = 0u;
    uint32_t store_count = 0u;

    for (uint32_t i = 0u; i < access_count; ++i) {
      // Find offset slot index for accesses[i]
      uint32_t slot_idx = unique_count;
      for (uint32_t v = u; v < unique_count; ++v) {
        if (s.unique_offsets[v] == accesses[i].stack_offset) {
          slot_idx = v;
          break;
        }
      }
      if (slot_idx >= unique_count || uf_find(s.slot_uf, slot_idx) != comp_root) {
        continue;
      }

      s.group_access_idx[n++] = i;
      const HexStackAccessIn& acc = accesses[i];
      if (acc.kind == HEX_STACK_ACCESS_ADDR_OF ||
          (acc.flags & HEX_STACK_ACCESS_FLAG_ESCAPED) != 0u) {
        escaped = true;
      }
      if (acc.kind == HEX_STACK_ACCESS_STORE) {
        store_count++;
      }
      if (!have_block) {
        first_block = acc.block_id;
        have_block = true;
      } else if (acc.block_id != first_block) {
        multi_block = true;
      }
      if (acc.width_bytes > 0u) {
        if (first_width == 0u) {
          first_width = acc.width_bytes;
        } else if (acc.width_bytes != first_width) {
          width_mismatch = true;
        }
        if (acc.width_bytes > max_width) {
          max_width = acc.width_bytes;
        }
      }
    }

    sort_slot_accesses(s.group_access_idx, n, accesses);

    // Fail-closed pinning:
    // - cross-offset partial overlap (also propagates escaped across overlapping offsets)
    // - cross-block accesses (prevents diamond-with-load & loop backedge mis-splits)
    // - escaped / address-taken slots
    // - width mismatch or >128 stores
    if (has_partial_overlap || multi_block || escaped || width_mismatch ||
        store_count > kMaxDefsPerSlot) {
      if (total_webs >= out_webs_cap) {
        return HEX_ERR_RESOURCE_LIMIT;
      }
      uint32_t def_idx = accesses[s.group_access_idx[0]].inst_idx;
      bool found_store = false;
      uint32_t first_idx = accesses[s.group_access_idx[0]].inst_idx;
      uint32_t last_idx = first_idx;
      uint32_t voted_type = 0u;

      for (uint32_t k = 0u; k < n; ++k) {
        const HexStackAccessIn& acc = accesses[s.group_access_idx[k]];
        if (!found_store && acc.kind == HEX_STACK_ACCESS_STORE) {
          def_idx = acc.inst_idx;
          found_store = true;
        }
        if (acc.inst_idx < first_idx) first_idx = acc.inst_idx;
        if (acc.inst_idx > last_idx) last_idx = acc.inst_idx;
        if (voted_type == 0u && acc.type_id != 0u) {
          voted_type = acc.type_id;
        }
        if (out_access_web_map != nullptr) {
          out_access_web_map[s.group_access_idx[k]] = total_webs;
        }
      }

      uint16_t wflags = HEX_STACK_WEB_FLAG_NONE;
      if (escaped) wflags |= HEX_STACK_WEB_FLAG_ESCAPED;
      if (width_mismatch) wflags |= HEX_STACK_WEB_FLAG_WIDTH_MISMATCH;
      if (store_count > 1u) wflags |= HEX_STACK_WEB_FLAG_MULTI_DEF;
      if (multi_block) {
        wflags |= HEX_STACK_WEB_FLAG_MERGED_OVERLAP | HEX_STACK_WEB_FLAG_CROSS_BLOCK;
      }
      if (has_partial_overlap) {
        wflags |= HEX_STACK_WEB_FLAG_MERGED_OVERLAP | HEX_STACK_WEB_FLAG_PARTIAL_OVERLAP;
      }
      if (store_count > kMaxDefsPerSlot) {
        wflags |= HEX_STACK_WEB_FLAG_MERGED_OVERLAP;
      }

      const int64_t span_bytes = comp_max_end - static_cast<int64_t>(min_slot_off);
      const uint16_t out_width = has_partial_overlap
          ? static_cast<uint16_t>(span_bytes > 0xFFFFll ? 0xFFFFu : span_bytes)
          : max_width;

      HexStackWebEntry& out = out_webs[total_webs++];
      out.stack_offset = min_slot_off;
      out.web_id = 0u;
      out.def_idx = def_idx;
      out.first_use_idx = first_idx;
      out.last_use_idx = last_idx;
      out.width_bytes = out_width;
      out.flags = wflags;
      out.type_id = voted_type;
      out.reserved_ = 0u;
      continue;
    }

    // Single-block, non-escaped, uniform-width slot: partition into disjoint live ranges
    uint32_t seg_count = 0u;
    uint32_t cur_seg = 0xFFFFFFFFu;

    for (uint32_t k = 0u; k < n; ++k) {
      const HexStackAccessIn& acc = accesses[s.group_access_idx[k]];
      if (acc.kind == HEX_STACK_ACCESS_STORE) {
        cur_seg = seg_count++;
        s.seg_def_idx[cur_seg] = acc.inst_idx;
        s.seg_first_idx[cur_seg] = acc.inst_idx;
        s.seg_last_idx[cur_seg] = acc.inst_idx;
        s.seg_width[cur_seg] = acc.width_bytes;
        s.seg_type_id[cur_seg] = acc.type_id;
        s.uf_parent[cur_seg] = cur_seg;
        s.access_seg[k] = cur_seg;
      } else {
        if (cur_seg == 0xFFFFFFFFu) {
          cur_seg = seg_count++;
          s.seg_def_idx[cur_seg] = acc.inst_idx;
          s.seg_first_idx[cur_seg] = acc.inst_idx;
          s.seg_last_idx[cur_seg] = acc.inst_idx;
          s.seg_width[cur_seg] = acc.width_bytes;
          s.seg_type_id[cur_seg] = acc.type_id;
          s.uf_parent[cur_seg] = cur_seg;
          s.access_seg[k] = cur_seg;
        } else {
          if (acc.inst_idx > s.seg_last_idx[cur_seg]) {
            s.seg_last_idx[cur_seg] = acc.inst_idx;
          }
          if (s.seg_type_id[cur_seg] == 0u && acc.type_id != 0u) {
            s.seg_type_id[cur_seg] = acc.type_id;
          }
          s.access_seg[k] = cur_seg;
        }
      }
    }

    // Merge any segments whose [first, last] intervals overlap
    for (uint32_t i = 0u; i < seg_count; ++i) {
      for (uint32_t j = i + 1u; j < seg_count; ++j) {
        if (s.seg_first_idx[i] <= s.seg_last_idx[j] &&
            s.seg_first_idx[j] <= s.seg_last_idx[i]) {
          uf_union(s.uf_parent, i, j);
        }
      }
    }

    for (uint32_t i = 0u; i < seg_count; ++i) {
      s.root_to_out_idx[i] = 0xFFFFFFFFu;
    }

    uint32_t local_web_id = 0u;
    for (uint32_t i = 0u; i < seg_count; ++i) {
      const uint32_t r = uf_find(s.uf_parent, i);
      if (s.root_to_out_idx[r] == 0xFFFFFFFFu) {
        if (total_webs >= out_webs_cap) {
          return HEX_ERR_RESOURCE_LIMIT;
        }
        const uint32_t out_i = total_webs++;
        s.root_to_out_idx[r] = out_i;

        HexStackWebEntry& out = out_webs[out_i];
        out.stack_offset = min_slot_off;
        out.web_id = local_web_id++;
        out.def_idx = s.seg_def_idx[i];
        out.first_use_idx = s.seg_first_idx[i];
        out.last_use_idx = s.seg_last_idx[i];
        out.width_bytes = s.seg_width[i];
        out.flags = HEX_STACK_WEB_FLAG_NONE;
        out.type_id = s.seg_type_id[i];
        out.reserved_ = 0u;
      } else {
        HexStackWebEntry& out = out_webs[s.root_to_out_idx[r]];
        if (s.seg_first_idx[i] < out.first_use_idx) {
          out.first_use_idx = s.seg_first_idx[i];
        }
        if (s.seg_last_idx[i] > out.last_use_idx) {
          out.last_use_idx = s.seg_last_idx[i];
        }
        if (out.type_id == 0u && s.seg_type_id[i] != 0u) {
          out.type_id = s.seg_type_id[i];
        }
        out.flags |= HEX_STACK_WEB_FLAG_MERGED_OVERLAP | HEX_STACK_WEB_FLAG_MULTI_DEF;
      }
    }

    if (out_access_web_map != nullptr) {
      for (uint32_t k = 0u; k < n; ++k) {
        const uint32_t r = uf_find(s.uf_parent, s.access_seg[k]);
        out_access_web_map[s.group_access_idx[k]] = s.root_to_out_idx[r];
      }
    }
  }

  *out_web_count = total_webs;
  return HEX_OK;
}

}  // extern "C"
