#include "loop_engine.hpp"
#include "../../include/hex_core/hex_core.hpp"

namespace {

constexpr uint32_t kDefaultMaxLoopMemberships = 1048576u;
constexpr uint32_t kDefaultMaxLoopWalkSteps = 4194304u;
constexpr uint32_t kMaxLoopNodes = static_cast<uint32_t>(INT32_MAX / 4);

HexStatus validate_csr_input(uint32_t n, const uint32_t* succ_off, const int32_t* succ_dst) {
  if (n > kMaxLoopNodes) return HEX_ERR_RESOURCE_LIMIT;
  if (!succ_off) return HEX_ERR_INVALID_ARG;
  if (succ_off[0] != 0u) return HEX_ERR_INVALID_ARG;
  for (uint32_t i = 0; i < n; ++i) {
    if (succ_off[i] > succ_off[i + 1]) return HEX_ERR_INVALID_ARG;
  }
  if (succ_off[n] > 0u && !succ_dst) return HEX_ERR_INVALID_ARG;
  return HEX_OK;
}

inline void fill_i32(int32_t* p, size_t n, int32_t v) {
  for (size_t i = 0; i < n; ++i) p[i] = v;
}

inline void zero_u32(uint32_t* p, size_t n) {
  if (n > 0) hex::mem_set(p, 0, n * sizeof(uint32_t));
}

inline bool dominates(const HexCfgResult& cfg, uint32_t n, int32_t dom, int32_t node) {
  if (dom < 0 || node < 0) return false;
  const uint32_t ud = static_cast<uint32_t>(dom);
  const uint32_t un = static_cast<uint32_t>(node);
  if (ud >= n || un >= n) return false;
  if (!cfg.reachable_mask[ud] || !cfg.reachable_mask[un]) return false;
  const int32_t tin_d = cfg.dom_tin[ud];
  return tin_d >= 0 && tin_d <= cfg.dom_tin[un] && cfg.dom_tout[un] <= cfg.dom_tout[ud];
}

// Normalize successors matching JS normalizedSuccessors():
// filter out-of-range targets and deduplicate per row preserving first-seen order.
bool normalize_successors(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* in_off,
    const int32_t* in_dst,
    uint32_t** out_off,
    int32_t** out_dst) {
  uint32_t* off = arena.alloc<uint32_t>(static_cast<size_t>(n) + 1u);
  if (!off) return false;
  off[0] = 0;
  if (n == 0) {
    *out_off = off;
    *out_dst = nullptr;
    return true;
  }

  const uint32_t total_in = in_off[n];
  int32_t* dst = total_in > 0 ? arena.alloc<int32_t>(total_in) : nullptr;
  if (total_in > 0 && !dst) return false;

  hex::ArenaScope scratch(arena);
  uint32_t* seen = hex::arena_alloc_zeroed<uint32_t>(arena, n);
  if (!seen) return false;

  uint32_t cursor = 0;
  for (uint32_t i = 0; i < n; ++i) {
    const uint32_t stamp = i + 1u;
    const uint32_t beg = in_off[i];
    const uint32_t end = in_off[i + 1];
    if (end < beg || end > total_in) return false;
    for (uint32_t e = beg; e < end; ++e) {
      const int32_t target = in_dst[e];
      if (target < 0 || static_cast<uint32_t>(target) >= n) continue;
      const uint32_t ut = static_cast<uint32_t>(target);
      if (seen[ut] == stamp) continue;
      seen[ut] = stamp;
      dst[cursor++] = target;
    }
    off[i + 1] = cursor;
  }

  *out_off = off;
  *out_dst = dst;
  return true;
}

// Build CSR predecessors from normalized CSR successors (preserving node ascending order).
bool build_predecessors(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    uint32_t** out_pred_off,
    int32_t** out_pred_src) {
  uint32_t* pred_off = arena.alloc<uint32_t>(static_cast<size_t>(n) + 1u);
  if (!pred_off) return false;
  zero_u32(pred_off, static_cast<size_t>(n) + 1u);

  const uint32_t m = succ_off[n];
  for (uint32_t i = 0; i < n; ++i) {
    const uint32_t beg = succ_off[i];
    const uint32_t end = succ_off[i + 1];
    for (uint32_t e = beg; e < end; ++e) {
      const int32_t dst = succ_dst[e];
      if (dst >= 0 && static_cast<uint32_t>(dst) < n) {
        pred_off[static_cast<uint32_t>(dst) + 1]++;
      }
    }
  }
  for (uint32_t i = 0; i < n; ++i) {
    pred_off[i + 1] += pred_off[i];
  }

  int32_t* pred_src = m > 0 ? arena.alloc<int32_t>(m) : nullptr;
  if (m > 0 && !pred_src) return false;

  hex::ArenaScope scratch(arena);
  uint32_t* cursor = n > 0 ? arena.alloc<uint32_t>(n) : nullptr;
  if (n > 0 && !cursor) return false;
  for (uint32_t i = 0; i < n; ++i) cursor[i] = pred_off[i];

  for (uint32_t i = 0; i < n; ++i) {
    const uint32_t beg = succ_off[i];
    const uint32_t end = succ_off[i + 1];
    for (uint32_t e = beg; e < end; ++e) {
      const int32_t dst = succ_dst[e];
      if (dst >= 0 && static_cast<uint32_t>(dst) < n) {
        pred_src[cursor[static_cast<uint32_t>(dst)]++] = static_cast<int32_t>(i);
      }
    }
  }

  *out_pred_off = pred_off;
  *out_pred_src = pred_src;
  return true;
}

struct LoopBuilder {
  int32_t header;
  hex::Vec<int32_t> latches;
  hex::Vec<int32_t> nodes;
  hex::Vec<int32_t> exits;
};

struct LoopSortEntry {
  uint32_t loop_idx;
  uint32_t size;
  int32_t header_dom_depth;
};

void reset_empty_loops(HexLoopResult* out, uint32_t n) {
  out->num_loops = 0;
  out->loop_header = nullptr;
  out->loop_parent = nullptr;
  out->loop_nest_depth = nullptr;
  out->loop_latch_off = nullptr;
  out->loop_latch_nodes = nullptr;
  out->loop_node_off = nullptr;
  out->loop_body_nodes = nullptr;
  out->loop_exit_off = nullptr;
  out->loop_exit_nodes = nullptr;
  out->retained_memberships = 0;
  if (n > 0) {
    fill_i32(out->node_loop_depth, n, 0);
    fill_i32(out->node_innermost_loop, n, -1);
    fill_i32(out->header_to_loop, n, -1);
  }
}

}  // namespace

extern "C" HexStatus hex_loop_analyze_arena(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    int32_t entry,
    const uint8_t* terminating_mask,
    const HexLoopBudget* budget,
    HexLoopResult* out) {
  if (!out) return HEX_ERR_INVALID_ARG;
  const HexStatus csr_st = validate_csr_input(n, succ_off, succ_dst);
  if (csr_st != HEX_OK) return csr_st;

  hex::mem_set(out, 0, sizeof(HexLoopResult));
  const uint32_t max_memberships =
      (budget && budget->max_loop_memberships > 0) ? budget->max_loop_memberships : kDefaultMaxLoopMemberships;
  const uint32_t max_walk_steps =
      (budget && budget->max_loop_walk_steps > 0) ? budget->max_loop_walk_steps : kDefaultMaxLoopWalkSteps;

  uint32_t* norm_off = nullptr;
  int32_t* norm_dst = nullptr;
  if (!normalize_successors(arena, n, succ_off, succ_dst, &norm_off, &norm_dst)) {
    return HEX_ERR_OOM;
  }

  HexStatus cfg_status = hex_cfg_analyze_arena(
      arena, n, norm_off, norm_dst, entry, terminating_mask, &out->cfg);
  if (cfg_status != HEX_OK) return cfg_status;

  if (n > 0) {
    out->node_loop_depth = arena.alloc<int32_t>(n);
    out->node_innermost_loop = arena.alloc<int32_t>(n);
    out->header_to_loop = arena.alloc<int32_t>(n);
    if (!out->node_loop_depth || !out->node_innermost_loop || !out->header_to_loop) {
      return HEX_ERR_OOM;
    }
    fill_i32(out->node_loop_depth, n, 0);
    fill_i32(out->node_innermost_loop, n, -1);
    fill_i32(out->header_to_loop, n, -1);
  }

  if (n == 0 || out->cfg.reach_count == 0) {
    out->complete = 1;
    out->stop_reason = HEX_LOOP_STOP_NONE;
    out->loop_latch_off = arena.alloc<uint32_t>(1);
    out->loop_node_off = arena.alloc<uint32_t>(1);
    out->loop_exit_off = arena.alloc<uint32_t>(1);
    if (!out->loop_latch_off || !out->loop_node_off || !out->loop_exit_off) {
      return HEX_ERR_OOM;
    }
    out->loop_latch_off[0] = 0;
    out->loop_node_off[0] = 0;
    out->loop_exit_off[0] = 0;
    return HEX_OK;
  }

  // Step 1: Detect back edges in exact JS order (reach_order x succ[from]).
  hex::Vec<int32_t> be_from(&arena);
  hex::Vec<int32_t> be_to(&arena);
  const uint32_t reach_count = out->cfg.reach_count;
  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const int32_t from = out->cfg.reach_order[ri];
    const int32_t comp_from = out->cfg.component_of[from];
    const uint32_t beg = norm_off[static_cast<uint32_t>(from)];
    const uint32_t end = norm_off[static_cast<uint32_t>(from) + 1];
    for (uint32_t e = beg; e < end; ++e) {
      const int32_t to = norm_dst[e];
      if (!out->cfg.reachable_mask[to]) continue;
      if (comp_from < 0 || comp_from != out->cfg.component_of[to]) continue;
      if (!dominates(out->cfg, n, to, from)) continue;
      if (!be_from.push_back(from) || !be_to.push_back(to)) return HEX_ERR_OOM;
    }
  }

  const uint32_t num_be = static_cast<uint32_t>(be_from.size());
  out->num_back_edges = num_be;
  if (num_be > 0) {
    out->back_edge_from = arena.alloc<int32_t>(num_be);
    out->back_edge_to = arena.alloc<int32_t>(num_be);
    if (!out->back_edge_from || !out->back_edge_to) return HEX_ERR_OOM;
    hex::mem_copy(out->back_edge_from, be_from.data(), num_be * sizeof(int32_t));
    hex::mem_copy(out->back_edge_to, be_to.data(), num_be * sizeof(int32_t));
  }

  if (num_be == 0) {
    out->complete = 1;
    out->stop_reason = HEX_LOOP_STOP_NONE;
    out->loop_latch_off = arena.alloc<uint32_t>(1);
    out->loop_node_off = arena.alloc<uint32_t>(1);
    out->loop_exit_off = arena.alloc<uint32_t>(1);
    if (!out->loop_latch_off || !out->loop_node_off || !out->loop_exit_off) {
      return HEX_ERR_OOM;
    }
    out->loop_latch_off[0] = 0;
    out->loop_node_off[0] = 0;
    out->loop_exit_off[0] = 0;
    return HEX_OK;
  }

  // Step 2: Build predecessors CSR and extract natural loop bodies via non-recursive worklist.
  uint32_t* pred_off = nullptr;
  int32_t* pred_src = nullptr;
  if (!build_predecessors(arena, n, norm_off, norm_dst, &pred_off, &pred_src)) {
    return HEX_ERR_OOM;
  }

  uint8_t stop_reason = HEX_LOOP_STOP_NONE;
  uint32_t retained_memberships = 0;
  uint32_t walk_steps = 0;

  const uint32_t max_loops = hex::min_val(num_be, n);
  LoopBuilder* builders = arena.alloc<LoopBuilder>(max_loops);
  int32_t* work_stack = arena.alloc<int32_t>(n);
  uint32_t* member_stamp = hex::arena_alloc_zeroed<uint32_t>(arena, n);
  int32_t* member_list = arena.alloc<int32_t>(n);
  uint32_t* scratch_stamp = hex::arena_alloc_zeroed<uint32_t>(arena, n);
  if (!builders || !work_stack || !member_stamp || !member_list || !scratch_stamp) {
    return HEX_ERR_OOM;
  }

  uint32_t num_loops = 0;
  uint32_t cur_member_stamp = 0;
  uint32_t cur_scratch_stamp = 0;

  for (uint32_t ei = 0; ei < num_be; ++ei) {
    const int32_t latch = out->back_edge_from[ei];
    const int32_t header = out->back_edge_to[ei];

    int32_t lid = out->header_to_loop[header];
    if (lid < 0) {
      lid = static_cast<int32_t>(num_loops++);
      out->header_to_loop[header] = lid;
      builders[lid].header = header;
      builders[lid].latches.init(&arena);
      builders[lid].nodes.init(&arena);
      builders[lid].exits.init(&arena);
      if (!builders[lid].nodes.push_back(header)) return HEX_ERR_OOM;
    }
    LoopBuilder& loop = builders[lid];

    bool latch_exists = false;
    for (size_t k = 0; k < loop.latches.size(); ++k) {
      if (loop.latches[k] == latch) {
        latch_exists = true;
        break;
      }
    }
    if (!latch_exists) {
      if (!loop.latches.push_back(latch)) return HEX_ERR_OOM;
    }

    cur_member_stamp += 1u;
    if (cur_member_stamp == 0) {
      zero_u32(member_stamp, n);
      cur_member_stamp = 1u;
    }

    uint32_t member_count = 0;
    member_stamp[header] = cur_member_stamp;
    member_list[member_count++] = header;
    uint32_t sp = 0;
    if (latch != header) {
      member_stamp[latch] = cur_member_stamp;
      member_list[member_count++] = latch;
      work_stack[sp++] = latch;
    }

    bool walk_exhausted = false;
    const int32_t header_comp = out->cfg.component_of[header];
    while (sp > 0) {
      const int32_t x = work_stack[--sp];
      if (walk_steps >= max_walk_steps) {
        if (walk_steps < UINT32_MAX) walk_steps += 1u;
        walk_exhausted = true;
        break;
      }
      walk_steps += 1u;
      const uint32_t pb = pred_off[static_cast<uint32_t>(x)];
      const uint32_t pe = pred_off[static_cast<uint32_t>(x) + 1];
      for (uint32_t pei = pb; pei < pe; ++pei) {
        const int32_t p = pred_src[pei];
        if (!out->cfg.reachable_mask[p] || member_stamp[p] == cur_member_stamp) continue;
        // Side-entry nodes make the region irreducible; do not absorb them.
        if (!dominates(out->cfg, n, header, p)) continue;
        if (out->cfg.component_of[p] != header_comp) continue;
        member_stamp[p] = cur_member_stamp;
        member_list[member_count++] = p;
        if (p != header) work_stack[sp++] = p;
      }
    }
    if (walk_exhausted) {
      stop_reason = HEX_LOOP_STOP_WALK_BUDGET;
      break;
    }

    cur_scratch_stamp += 1u;
    if (cur_scratch_stamp == 0) {
      zero_u32(scratch_stamp, n);
      cur_scratch_stamp = 1u;
    }
    const size_t before = loop.nodes.size();
    for (size_t k = 0; k < before; ++k) {
      scratch_stamp[loop.nodes[k]] = cur_scratch_stamp;
    }
    for (uint32_t k = 0; k < member_count; ++k) {
      const int32_t node = member_list[k];
      if (scratch_stamp[node] == cur_scratch_stamp) continue;
      scratch_stamp[node] = cur_scratch_stamp;
      if (!loop.nodes.push_back(node)) return HEX_ERR_OOM;
    }
    const uint32_t added = static_cast<uint32_t>(loop.nodes.size() - before);
    if (added > max_memberships - retained_memberships) {
      retained_memberships += added;
      stop_reason = HEX_LOOP_STOP_MEMBERSHIP_BUDGET;
      break;
    }
    retained_memberships += added;
  }

  // Step 3: Extract loop exits in exact JS order.
  if (stop_reason == HEX_LOOP_STOP_NONE) {
    uint32_t* exit_stamp = hex::arena_alloc_zeroed<uint32_t>(arena, n);
    if (!exit_stamp) return HEX_ERR_OOM;
    uint32_t cur_exit_stamp = 0;

    for (uint32_t lid = 0; lid < num_loops; ++lid) {
      LoopBuilder& loop = builders[lid];
      cur_scratch_stamp += 1u;
      if (cur_scratch_stamp == 0) {
        zero_u32(scratch_stamp, n);
        cur_scratch_stamp = 1u;
      }
      for (size_t k = 0; k < loop.nodes.size(); ++k) {
        scratch_stamp[loop.nodes[k]] = cur_scratch_stamp;
      }
      cur_exit_stamp += 1u;
      if (cur_exit_stamp == 0) {
        zero_u32(exit_stamp, n);
        cur_exit_stamp = 1u;
      }

      for (size_t k = 0; k < loop.nodes.size(); ++k) {
        const int32_t x = loop.nodes[k];
        const uint32_t sb = norm_off[static_cast<uint32_t>(x)];
        const uint32_t se = norm_off[static_cast<uint32_t>(x) + 1];
        for (uint32_t sei = sb; sei < se; ++sei) {
          if (walk_steps >= max_walk_steps) {
            if (walk_steps < UINT32_MAX) walk_steps += 1u;
            stop_reason = HEX_LOOP_STOP_WALK_BUDGET;
            break;
          }
          walk_steps += 1u;
          const int32_t y = norm_dst[sei];
          if (scratch_stamp[y] != cur_scratch_stamp && exit_stamp[y] != cur_exit_stamp) {
            exit_stamp[y] = cur_exit_stamp;
            if (!loop.exits.push_back(y)) return HEX_ERR_OOM;
          }
        }
        if (stop_reason != HEX_LOOP_STOP_NONE) break;
      }
      if (stop_reason != HEX_LOOP_STOP_NONE) break;
    }
  }

  out->walk_steps = walk_steps;
  out->stop_reason = stop_reason;
  if (stop_reason != HEX_LOOP_STOP_NONE) {
    out->complete = 0;
    reset_empty_loops(out, n);
    out->loop_latch_off = arena.alloc<uint32_t>(1);
    out->loop_node_off = arena.alloc<uint32_t>(1);
    out->loop_exit_off = arena.alloc<uint32_t>(1);
    if (!out->loop_latch_off || !out->loop_node_off || !out->loop_exit_off) {
      return HEX_ERR_OOM;
    }
    out->loop_latch_off[0] = 0;
    out->loop_node_off[0] = 0;
    out->loop_exit_off[0] = 0;
    return HEX_OK;
  }

  // Step 4: Materialize flat CSR arrays for loops.
  out->complete = 1;
  out->num_loops = num_loops;
  out->loop_header = arena.alloc<int32_t>(num_loops);
  out->loop_parent = arena.alloc<int32_t>(num_loops);
  out->loop_nest_depth = arena.alloc<int32_t>(num_loops);
  out->loop_latch_off = arena.alloc<uint32_t>(static_cast<size_t>(num_loops) + 1u);
  out->loop_node_off = arena.alloc<uint32_t>(static_cast<size_t>(num_loops) + 1u);
  out->loop_exit_off = arena.alloc<uint32_t>(static_cast<size_t>(num_loops) + 1u);
  if (!out->loop_header || !out->loop_parent || !out->loop_nest_depth ||
      !out->loop_latch_off || !out->loop_node_off || !out->loop_exit_off) {
    return HEX_ERR_OOM;
  }

  uint32_t total_latches = 0;
  uint32_t total_nodes = 0;
  uint32_t total_exits = 0;
  out->loop_latch_off[0] = 0;
  out->loop_node_off[0] = 0;
  out->loop_exit_off[0] = 0;
  for (uint32_t lid = 0; lid < num_loops; ++lid) {
    out->loop_header[lid] = builders[lid].header;
    out->loop_parent[lid] = -1;
    out->loop_nest_depth[lid] = 1;
    total_latches += static_cast<uint32_t>(builders[lid].latches.size());
    total_nodes += static_cast<uint32_t>(builders[lid].nodes.size());
    total_exits += static_cast<uint32_t>(builders[lid].exits.size());
    out->loop_latch_off[lid + 1] = total_latches;
    out->loop_node_off[lid + 1] = total_nodes;
    out->loop_exit_off[lid + 1] = total_exits;
  }
  out->retained_memberships = total_nodes;

  out->loop_latch_nodes = total_latches > 0 ? arena.alloc<int32_t>(total_latches) : nullptr;
  out->loop_body_nodes = total_nodes > 0 ? arena.alloc<int32_t>(total_nodes) : nullptr;
  out->loop_exit_nodes = total_exits > 0 ? arena.alloc<int32_t>(total_exits) : nullptr;
  if ((total_latches > 0 && !out->loop_latch_nodes) ||
      (total_nodes > 0 && !out->loop_body_nodes) ||
      (total_exits > 0 && !out->loop_exit_nodes)) {
    return HEX_ERR_OOM;
  }

  for (uint32_t lid = 0; lid < num_loops; ++lid) {
    const size_t lc = builders[lid].latches.size();
    const size_t nc = builders[lid].nodes.size();
    const size_t ec = builders[lid].exits.size();
    if (lc > 0) {
      hex::mem_copy(out->loop_latch_nodes + out->loop_latch_off[lid], builders[lid].latches.data(), lc * sizeof(int32_t));
    }
    if (nc > 0) {
      hex::mem_copy(out->loop_body_nodes + out->loop_node_off[lid], builders[lid].nodes.data(), nc * sizeof(int32_t));
    }
    if (ec > 0) {
      hex::mem_copy(out->loop_exit_nodes + out->loop_exit_off[lid], builders[lid].exits.data(), ec * sizeof(int32_t));
    }
  }

  // Step 5: Build parent loop tree, loop nest depth, and per-node innermost loop & depth.
  LoopSortEntry* order = arena.alloc<LoopSortEntry>(num_loops);
  if (!order) return HEX_ERR_OOM;
  for (uint32_t lid = 0; lid < num_loops; ++lid) {
    order[lid].loop_idx = lid;
    order[lid].size = out->loop_node_off[lid + 1] - out->loop_node_off[lid];
    order[lid].header_dom_depth = out->cfg.dom_depth[out->loop_header[lid]];
  }
  if (!hex::stable_sort(arena, order, num_loops, [](const LoopSortEntry& a, const LoopSortEntry& b) {
        if (a.size != b.size) return a.size > b.size;
        return a.header_dom_depth < b.header_dom_depth;
      })) {
    return HEX_ERR_OOM;
  }

  for (uint32_t oi = 0; oi < num_loops; ++oi) {
    const uint32_t lid = order[oi].loop_idx;
    const int32_t header = out->loop_header[lid];
    const int32_t parent = out->node_innermost_loop[header];
    out->loop_parent[lid] = parent;
    out->loop_nest_depth[lid] = (parent < 0) ? 1 : (out->loop_nest_depth[parent] + 1);

    const uint32_t nb = out->loop_node_off[lid];
    const uint32_t ne = out->loop_node_off[lid + 1];
    for (uint32_t k = nb; k < ne; ++k) {
      const int32_t u = out->loop_body_nodes[k];
      out->node_innermost_loop[u] = static_cast<int32_t>(lid);
    }
  }

  for (uint32_t i = 0; i < n; ++i) {
    const int32_t inner = out->node_innermost_loop[i];
    out->node_loop_depth[i] = (inner < 0) ? 0 : out->loop_nest_depth[inner];
  }

  return HEX_OK;
}

// ============================================================================
// Public C / WASM ABI (BSS-isolated fixed arena on WASM/native)
// ============================================================================
namespace {

hex::Arena g_loop_arena;
HexLoopResult g_loop_result;

#if defined(__wasm__)
extern "C" unsigned char __heap_base;

inline uint32_t loop_ptr_to_handle(const void* p) {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(p));
}

template <typename T>
inline const T* loop_handle_to_ptr(uint32_t h) {
  return h ? reinterpret_cast<const T*>(static_cast<uintptr_t>(h)) : nullptr;
}
#else
constexpr size_t kNativeAbiArenaBytes = 16u * 1024u * 1024u;
alignas(16) uint8_t g_native_abi_buf[kNativeAbiArenaBytes];

inline uint32_t loop_ptr_to_handle(const void* p) {
  if (!p) return 0u;
  const uintptr_t base = reinterpret_cast<uintptr_t>(g_native_abi_buf);
  const uintptr_t addr = reinterpret_cast<uintptr_t>(p);
  if (addr < base || addr >= base + kNativeAbiArenaBytes) return 0u;
  return static_cast<uint32_t>(addr - base);
}

template <typename T>
inline const T* loop_handle_to_ptr(uint32_t h) {
  if (h == 0u || h >= kNativeAbiArenaBytes) return nullptr;
  return reinterpret_cast<const T*>(g_native_abi_buf + h);
}
#endif

}  // namespace

extern "C" {

void hex_loop_reset(void) {
#if defined(__wasm__)
  const uint32_t raw_base = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&__heap_base));
  const uint32_t base = (raw_base + 7u) & ~7u;
  const size_t total = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u;
  g_loop_arena.init_external(reinterpret_cast<uint8_t*>(base), total > base ? total - base : 0);
#else
  g_loop_arena.init_external(g_native_abi_buf + 8u, kNativeAbiArenaBytes - 8u);
#endif
  hex::mem_set(&g_loop_result, 0, sizeof(g_loop_result));
}

uint32_t hex_loop_alloc(uint32_t bytes) {
  uint8_t* p = g_loop_arena.alloc<uint8_t>(bytes);
  return loop_ptr_to_handle(p);
}

uint32_t hex_loop_analyze(
    uint32_t n,
    uint32_t succ_off_ptr,
    uint32_t succ_dst_ptr,
    int32_t entry,
    uint32_t terminating_mask_ptr,
    uint32_t max_loop_memberships,
    uint32_t max_loop_walk_steps) {
  if ((succ_off_ptr & 3u) != 0u || (succ_dst_ptr & 3u) != 0u) {
    return static_cast<uint32_t>(HEX_ERR_INVALID_ARG);
  }
  const uint32_t* succ_off = loop_handle_to_ptr<uint32_t>(succ_off_ptr);
  const int32_t* succ_dst = loop_handle_to_ptr<int32_t>(succ_dst_ptr);
  const uint8_t* term_mask = loop_handle_to_ptr<uint8_t>(terminating_mask_ptr);
  HexLoopBudget budget{max_loop_memberships, max_loop_walk_steps};
  return static_cast<uint32_t>(hex_loop_analyze_arena(
      g_loop_arena, n, succ_off, succ_dst, entry, term_mask, &budget, &g_loop_result));
}

uint32_t hex_loop_get_ptr(uint32_t field_id) {
  switch (field_id) {
    case HEX_LOOP_FIELD_NUM_BACK_EDGES: return g_loop_result.num_back_edges;
    case HEX_LOOP_FIELD_BACK_EDGE_FROM: return loop_ptr_to_handle(g_loop_result.back_edge_from);
    case HEX_LOOP_FIELD_BACK_EDGE_TO: return loop_ptr_to_handle(g_loop_result.back_edge_to);
    case HEX_LOOP_FIELD_NUM_LOOPS: return g_loop_result.num_loops;
    case HEX_LOOP_FIELD_LOOP_HEADER: return loop_ptr_to_handle(g_loop_result.loop_header);
    case HEX_LOOP_FIELD_LOOP_PARENT: return loop_ptr_to_handle(g_loop_result.loop_parent);
    case HEX_LOOP_FIELD_LOOP_NEST_DEPTH: return loop_ptr_to_handle(g_loop_result.loop_nest_depth);
    case HEX_LOOP_FIELD_LOOP_LATCH_OFF: return loop_ptr_to_handle(g_loop_result.loop_latch_off);
    case HEX_LOOP_FIELD_LOOP_LATCH_NODES: return loop_ptr_to_handle(g_loop_result.loop_latch_nodes);
    case HEX_LOOP_FIELD_LOOP_NODE_OFF: return loop_ptr_to_handle(g_loop_result.loop_node_off);
    case HEX_LOOP_FIELD_LOOP_BODY_NODES: return loop_ptr_to_handle(g_loop_result.loop_body_nodes);
    case HEX_LOOP_FIELD_LOOP_EXIT_OFF: return loop_ptr_to_handle(g_loop_result.loop_exit_off);
    case HEX_LOOP_FIELD_LOOP_EXIT_NODES: return loop_ptr_to_handle(g_loop_result.loop_exit_nodes);
    case HEX_LOOP_FIELD_NODE_LOOP_DEPTH: return loop_ptr_to_handle(g_loop_result.node_loop_depth);
    case HEX_LOOP_FIELD_NODE_INNERMOST_LOOP: return loop_ptr_to_handle(g_loop_result.node_innermost_loop);
    case HEX_LOOP_FIELD_HEADER_TO_LOOP: return loop_ptr_to_handle(g_loop_result.header_to_loop);
    case HEX_LOOP_FIELD_COMPLETE: return g_loop_result.complete;
    case HEX_LOOP_FIELD_STOP_REASON: return g_loop_result.stop_reason;
    case HEX_LOOP_FIELD_RETAINED_MEMBERSHIPS: return g_loop_result.retained_memberships;
    case HEX_LOOP_FIELD_WALK_STEPS: return g_loop_result.walk_steps;
    case HEX_LOOP_FIELD_CFG_REACHABLE_MASK: return loop_ptr_to_handle(g_loop_result.cfg.reachable_mask);
    case HEX_LOOP_FIELD_CFG_REACH_ORDER: return loop_ptr_to_handle(g_loop_result.cfg.reach_order);
    case HEX_LOOP_FIELD_CFG_REACH_COUNT: return g_loop_result.cfg.reach_count;
    case HEX_LOOP_FIELD_CFG_IDOM: return loop_ptr_to_handle(g_loop_result.cfg.idom);
    case HEX_LOOP_FIELD_CFG_COMPONENT_OF: return loop_ptr_to_handle(g_loop_result.cfg.component_of);
    case HEX_LOOP_FIELD_CFG_NUM_COMPONENTS: return g_loop_result.cfg.num_components;
    case HEX_LOOP_FIELD_CFG_PDOM_IDOM: return loop_ptr_to_handle(g_loop_result.cfg.pdom_idom);
    default: return 0u;
  }
}

}  // extern "C"
