#include "hex_region_decomp.hpp"

namespace {

constexpr uint32_t kMaxCfgNodes = 2048u;
constexpr uint32_t kMaxCfgEdges = 8192u;
constexpr uint32_t kUnvisited = 0xFFFFFFFFu;

// Static BSS scratch buffers (zero libc, zero dynamic allocation)
struct RegionScratch {
  uint32_t succ_off[kMaxCfgNodes + 1u];
  uint32_t succ_dst[kMaxCfgEdges];
  uint32_t pred_off[kMaxCfgNodes + 1u];
  uint32_t pred_src[kMaxCfgEdges];
  uint32_t cursor[kMaxCfgNodes];

  uint32_t rpo_num[kMaxCfgNodes];
  uint32_t rpo_order[kMaxCfgNodes];
  uint32_t idom[kMaxCfgNodes];

  // Iterative DFS stack for RPO computation
  uint32_t dfs_node[kMaxCfgNodes];
  uint32_t dfs_edge[kMaxCfgNodes];
  uint8_t visited[kMaxCfgNodes];

  // BFS queue & slice membership
  uint32_t bfs_queue[kMaxCfgNodes];
  uint8_t in_slice[kMaxCfgNodes];
};

RegionScratch g_region_scratch;

inline uint32_t intersect_dom(uint32_t b1, uint32_t b2,
                              const uint32_t* idom,
                              const uint32_t* rpo_num,
                              uint32_t node_count) {
  uint32_t f1 = b1;
  uint32_t f2 = b2;
  const uint32_t max_guard = node_count * 2u + 16u;
  uint32_t steps = 0u;
  while (f1 != f2) {
    if (f1 >= node_count || f2 >= node_count || steps >= max_guard) {
      return kUnvisited;
    }
    while (rpo_num[f1] > rpo_num[f2]) {
      f1 = idom[f1];
      steps++;
      if (f1 >= node_count || steps >= max_guard) {
        return kUnvisited;
      }
    }
    while (rpo_num[f2] > rpo_num[f1]) {
      f2 = idom[f2];
      steps++;
      if (f2 >= node_count || steps >= max_guard) {
        return kUnvisited;
      }
    }
  }
  return f1;
}

inline bool dominates(uint32_t a, uint32_t b,
                      const uint32_t* idom,
                      const uint32_t* rpo_num,
                      uint32_t entry,
                      uint32_t node_count) {
  if (a == b) return true;
  if (a >= node_count || b >= node_count) return false;
  if (rpo_num[a] == kUnvisited || rpo_num[b] == kUnvisited) return false;
  if (rpo_num[a] > rpo_num[b]) return false;
  uint32_t cur = b;
  uint32_t steps = 0u;
  while (cur != a && cur != entry && cur < node_count && steps < node_count) {
    const uint32_t next = idom[cur];
    if (next == cur || next >= node_count) break;
    cur = next;
    steps++;
  }
  return cur == a;
}

uint32_t find_target_node(const HexRegionNodeIn* nodes,
                          uint32_t node_count,
                          uint64_t target_va) {
  // 1. Exact block start VA match
  for (uint32_t i = 0u; i < node_count; ++i) {
    if (nodes[i].va == target_va) return i;
  }
  // 2. Containment match [va, va + insn_count * 4) without 64-bit addition overflow
  for (uint32_t i = 0u; i < node_count; ++i) {
    const uint64_t start = nodes[i].va;
    const uint64_t span = static_cast<uint64_t>(nodes[i].insn_count) * 4ull;
    if (span > 0ull && target_va >= start && (target_va - start) < span) {
      return i;
    }
  }
  return HEX_REGION_NO_NODE;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_region_extract")
int32_t hex_region_extract(
    const HexRegionNodeIn* nodes,
    uint32_t node_count,
    const HexRegionEdgeIn* edges,
    uint32_t edge_count,
    uint64_t target_va,
    uint32_t max_nodes,
    uint32_t max_edges,
    HexRegionSlice* out_slice,
    uint32_t* out_node_ids,
    uint32_t out_node_ids_cap,
    HexRegionBoundarySummary* out_summary) {
  if (nodes == nullptr || node_count == 0u || out_slice == nullptr || max_nodes == 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  if (edge_count > 0u && edges == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (out_node_ids != nullptr && out_node_ids_cap == 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  if (node_count > kMaxCfgNodes || edge_count > kMaxCfgEdges) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  const uint32_t target_node = find_target_node(nodes, node_count, target_va);
  if (target_node == HEX_REGION_NO_NODE) {
    return HEX_ERR_INVALID_ARG;
  }

  // Reflect out_node_ids_cap into effective node cap to prevent silent truncation
  const uint32_t effective_max_nodes =
      (out_node_ids != nullptr && out_node_ids_cap < max_nodes) ? out_node_ids_cap : max_nodes;

  RegionScratch& s = g_region_scratch;

  // Build CSR successor & predecessor tables (filtering out-of-range edges safely)
  for (uint32_t i = 0u; i <= node_count; ++i) {
    s.succ_off[i] = 0u;
    s.pred_off[i] = 0u;
  }
  for (uint32_t e = 0u; e < edge_count; ++e) {
    const uint32_t u = edges[e].src_node;
    const uint32_t v = edges[e].dst_node;
    if (u < node_count && v < node_count) {
      s.succ_off[u + 1u]++;
      s.pred_off[v + 1u]++;
    }
  }
  for (uint32_t i = 0u; i < node_count; ++i) {
    s.succ_off[i + 1u] += s.succ_off[i];
    s.pred_off[i + 1u] += s.pred_off[i];
    s.cursor[i] = s.succ_off[i];
  }
  for (uint32_t e = 0u; e < edge_count; ++e) {
    const uint32_t u = edges[e].src_node;
    const uint32_t v = edges[e].dst_node;
    if (u < node_count && v < node_count) {
      s.succ_dst[s.cursor[u]++] = v;
    }
  }
  for (uint32_t i = 0u; i < node_count; ++i) {
    s.cursor[i] = s.pred_off[i];
  }
  for (uint32_t e = 0u; e < edge_count; ++e) {
    const uint32_t u = edges[e].src_node;
    const uint32_t v = edges[e].dst_node;
    if (u < node_count && v < node_count) {
      s.pred_src[s.cursor[v]++] = u;
    }
  }

  // Compute RPO via iterative DFS from root = 0 (or target_node if 0 cannot reach target_node)
  auto compute_rpo = [&](uint32_t root) -> uint32_t {
    for (uint32_t i = 0u; i < node_count; ++i) {
      s.visited[i] = 0u;
      s.rpo_num[i] = kUnvisited;
      s.idom[i] = kUnvisited;
    }
    uint32_t post_count = 0u;
    uint32_t sp = 0u;
    s.visited[root] = 1u;
    s.dfs_node[sp] = root;
    s.dfs_edge[sp] = s.succ_off[root];
    sp++;

    while (sp > 0u) {
      const uint32_t u = s.dfs_node[sp - 1u];
      const uint32_t end = s.succ_off[u + 1u];
      uint32_t ei = s.dfs_edge[sp - 1u];
      bool pushed = false;
      while (ei < end) {
        const uint32_t v = s.succ_dst[ei++];
        if (!s.visited[v]) {
          s.dfs_edge[sp - 1u] = ei;
          s.visited[v] = 1u;
          s.dfs_node[sp] = v;
          s.dfs_edge[sp] = s.succ_off[v];
          sp++;
          pushed = true;
          break;
        }
      }
      if (!pushed) {
        s.rpo_order[post_count++] = u;
        sp--;
      }
    }

    // Reverse postorder in place
    for (uint32_t i = 0u; i < post_count / 2u; ++i) {
      const uint32_t tmp = s.rpo_order[i];
      s.rpo_order[i] = s.rpo_order[post_count - 1u - i];
      s.rpo_order[post_count - 1u - i] = tmp;
    }
    for (uint32_t i = 0u; i < post_count; ++i) {
      s.rpo_num[s.rpo_order[i]] = i;
    }
    return post_count;
  };

  uint32_t cfg_root = 0u;
  uint32_t rpo_count = compute_rpo(cfg_root);
  if (s.rpo_num[target_node] == kUnvisited) {
    cfg_root = target_node;
    rpo_count = compute_rpo(cfg_root);
  }

  // Cooper-Harvey-Kennedy iterative dominators with convergence & bounds guards
  s.idom[cfg_root] = cfg_root;
  bool changed = true;
  const uint32_t max_chk_iters = node_count + 64u;
  uint32_t guard_iters = 0u;
  while (changed && guard_iters < max_chk_iters) {
    changed = false;
    guard_iters++;
    for (uint32_t idx = 1u; idx < rpo_count; ++idx) {
      const uint32_t b = s.rpo_order[idx];
      uint32_t new_idom = kUnvisited;
      for (uint32_t pe = s.pred_off[b]; pe < s.pred_off[b + 1u]; ++pe) {
        const uint32_t p = s.pred_src[pe];
        if (p < node_count && s.idom[p] != kUnvisited) {
          if (new_idom == kUnvisited) {
            new_idom = p;
          } else {
            new_idom = intersect_dom(p, new_idom, s.idom, s.rpo_num, node_count);
            if (new_idom == kUnvisited) {
              return HEX_ERR_INTERNAL;
            }
          }
        }
      }
      if (new_idom != kUnvisited && s.idom[b] != new_idom) {
        s.idom[b] = new_idom;
        changed = true;
      }
    }
  }
  if (changed) {
    return HEX_ERR_INTERNAL;
  }

  // Dominator-bounded BFS region extraction rooted at target_node with hard caps
  for (uint32_t i = 0u; i < node_count; ++i) {
    s.in_slice[i] = 0u;
  }

  uint32_t boundary_flags = HEX_REGION_FLAG_NONE;
  uint32_t slice_nodes = 0u;
  uint32_t slice_edges = 0u;
  uint32_t q_head = 0u;
  uint32_t q_tail = 0u;

  s.in_slice[target_node] = 1u;
  s.bfs_queue[q_tail++] = target_node;
  slice_nodes = 1u;

  while (q_head < q_tail) {
    const uint32_t u = s.bfs_queue[q_head++];
    for (uint32_t ei = s.succ_off[u]; ei < s.succ_off[u + 1u]; ++ei) {
      const uint32_t v = s.succ_dst[ei];
      if (!dominates(target_node, v, s.idom, s.rpo_num, cfg_root, node_count)) {
        continue;
      }
      if (!s.in_slice[v]) {
        if (slice_nodes >= effective_max_nodes) {
          boundary_flags |= HEX_REGION_FLAG_NODE_CAPPED | HEX_REGION_FLAG_LINEAR_FALLBACK;
          continue;
        }
        if (slice_edges >= max_edges) {
          boundary_flags |= HEX_REGION_FLAG_EDGE_CAPPED | HEX_REGION_FLAG_LINEAR_FALLBACK;
          continue;
        }
        s.in_slice[v] = 1u;
        s.bfs_queue[q_tail++] = v;
        slice_nodes++;
        slice_edges++;
      } else {
        // Detect backedge independently of edge cap
        if (dominates(v, u, s.idom, s.rpo_num, cfg_root, node_count)) {
          boundary_flags |= HEX_REGION_FLAG_HAS_BACKEDGE;
        }
        if (slice_edges < max_edges) {
          slice_edges++;
        } else {
          boundary_flags |= HEX_REGION_FLAG_EDGE_CAPPED | HEX_REGION_FLAG_LINEAR_FALLBACK;
        }
      }
    }
  }

  // Compute boundary summary (incoming/outgoing external edges, single exit check, insn count)
  uint32_t incoming_ext = 0u;
  uint32_t outgoing_ext = 0u;
  uint32_t unique_exit = HEX_REGION_NO_NODE;
  bool multiple_exits = false;
  bool all_incoming_to_entry = true;
  uint32_t total_insns = 0u;

  for (uint32_t i = 0u; i < slice_nodes; ++i) {
    const uint32_t u = s.bfs_queue[i];
    total_insns += nodes[u].insn_count;
    if (out_node_ids != nullptr) {
      out_node_ids[i] = u;
    }
    for (uint32_t ei = s.succ_off[u]; ei < s.succ_off[u + 1u]; ++ei) {
      const uint32_t v = s.succ_dst[ei];
      if (!s.in_slice[v]) {
        outgoing_ext++;
        if (unique_exit == HEX_REGION_NO_NODE) {
          unique_exit = v;
        } else if (unique_exit != v) {
          multiple_exits = true;
        }
      }
    }
    for (uint32_t pe = s.pred_off[u]; pe < s.pred_off[u + 1u]; ++pe) {
      const uint32_t p = s.pred_src[pe];
      if (!s.in_slice[p]) {
        incoming_ext++;
        if (u != target_node) {
          all_incoming_to_entry = false;
        }
      }
    }
  }

  if (incoming_ext > 0u) {
    boundary_flags |= HEX_REGION_FLAG_HAS_ENTRY_BOUNDARY;
  }
  if (outgoing_ext > 0u) {
    boundary_flags |= HEX_REGION_FLAG_HAS_EXIT_BOUNDARY;
  }
  if (multiple_exits) {
    unique_exit = HEX_REGION_NO_NODE;
  }
  if (all_incoming_to_entry && !multiple_exits &&
      (boundary_flags & (HEX_REGION_FLAG_NODE_CAPPED | HEX_REGION_FLAG_EDGE_CAPPED)) == 0u) {
    boundary_flags |= HEX_REGION_FLAG_SESE;
  }

  out_slice->entry_va = nodes[target_node].va;
  out_slice->node_count = slice_nodes;
  out_slice->edge_count = slice_edges;
  out_slice->boundary_flags = boundary_flags;
  out_slice->entry_node = target_node;

  if (out_summary != nullptr) {
    out_summary->entry_node = target_node;
    out_summary->exit_node = unique_exit;
    out_summary->incoming_ext_edges = incoming_ext;
    out_summary->outgoing_ext_edges = outgoing_ext;
    out_summary->total_insns = total_insns;
    out_summary->boundary_flags = boundary_flags;
    out_summary->exit_va =
        (unique_exit != HEX_REGION_NO_NODE) ? nodes[unique_exit].va : 0ull;
  }

  return HEX_OK;
}

}  // extern "C"
