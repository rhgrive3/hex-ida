#include "hex_abi.hpp"

namespace {

inline bool checked_add_u32(uint32_t a, uint32_t b, uint32_t* out) {
  if (b > 0xFFFFFFFFu - a) return false;
  *out = a + b;
  return true;
}

inline bool checked_mul_u32(uint32_t a, uint32_t b, uint32_t* out) {
  if (a != 0u && b > 0xFFFFFFFFu / a) return false;
  *out = a * b;
  return true;
}

inline bool checked_align8_u32(uint32_t x, uint32_t* out) {
  if (x > 0xFFFFFFF8u) return false;
  *out = (x + 7u) & ~7u;
  return true;
}

inline uint32_t align8_u32(uint32_t x) {
  return (x + 7u) & ~7u;
}

inline uint32_t min_u32(uint32_t a, uint32_t b) {
  return a < b ? a : b;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_callgraph_scratch_bytes")
uint32_t hex_callgraph_scratch_bytes(uint32_t num_nodes, uint32_t num_edges) {
  if (num_nodes == 0u) return 0u;

  uint32_t n_plus_1 = 0u;
  if (!checked_add_u32(num_nodes, 1u, &n_plus_1)) return 0u;

  uint32_t raw_offsets = 0u;
  uint32_t a_offsets = 0u;
  if (!checked_mul_u32(4u, n_plus_1, &raw_offsets)) return 0u;
  if (!checked_align8_u32(raw_offsets, &a_offsets)) return 0u;

  uint32_t raw_edges = 0u;
  uint32_t a_edges = 0u;
  if (!checked_mul_u32(4u, num_edges, &raw_edges)) return 0u;
  if (!checked_align8_u32(raw_edges, &a_edges)) return 0u;

  uint32_t raw_u32n = 0u;
  uint32_t a_u32n = 0u;
  uint32_t a_10_u32n = 0u;
  if (!checked_mul_u32(4u, num_nodes, &raw_u32n)) return 0u;
  if (!checked_align8_u32(raw_u32n, &a_u32n)) return 0u;
  if (!checked_mul_u32(10u, a_u32n, &a_10_u32n)) return 0u;

  uint32_t a_u8n = 0u;
  uint32_t a_2_u8n = 0u;
  if (!checked_align8_u32(num_nodes, &a_u8n)) return 0u;
  if (!checked_mul_u32(2u, a_u8n, &a_2_u8n)) return 0u;

  uint32_t total = 0u;
  if (!checked_add_u32(a_offsets, a_edges, &total)) return 0u;
  if (!checked_add_u32(total, a_10_u32n, &total)) return 0u;
  if (!checked_add_u32(total, a_2_u8n, &total)) return 0u;
  return total;
}

HEX_WASM_EXPORT("hex_analyze_callgraph")
uint32_t hex_analyze_callgraph(
    uint32_t num_nodes,
    const uint32_t* edge_src,
    const uint32_t* edge_dst,
    uint32_t num_edges,
    uint8_t* scratch_ptr,
    uint32_t scratch_bytes,
    uint32_t* out_scc,
    uint8_t* out_role,
    uint32_t* out_score) {
  if (num_nodes == 0u) return 0u;
  if (scratch_ptr == nullptr || out_scc == nullptr || out_role == nullptr || out_score == nullptr) {
    return 0u;
  }
  if (num_edges > 0u && (edge_src == nullptr || edge_dst == nullptr)) {
    return 0u;
  }

  const uint32_t need = hex_callgraph_scratch_bytes(num_nodes, num_edges);
  if (need == 0u || scratch_bytes < need) return 0u;

  const uint32_t sz_offsets = align8_u32(4u * (num_nodes + 1u));
  const uint32_t sz_edges = align8_u32(4u * num_edges);
  const uint32_t sz_u32n = align8_u32(4u * num_nodes);
  const uint32_t sz_u8n = align8_u32(num_nodes);

  uint8_t* cur = scratch_ptr;
  auto take_u32 = [&cur](uint32_t bytes) -> uint32_t* {
    uint32_t* p = reinterpret_cast<uint32_t*>(cur);
    cur += bytes;
    return p;
  };
  auto take_u8 = [&cur](uint32_t bytes) -> uint8_t* {
    uint8_t* p = cur;
    cur += bytes;
    return p;
  };

  uint32_t* row_ptr = take_u32(sz_offsets);
  uint32_t* col_idx = take_u32(sz_edges);
  uint32_t* out_deg = take_u32(sz_u32n);
  uint32_t* in_deg = take_u32(sz_u32n);
  uint32_t* cursor = take_u32(sz_u32n);
  uint32_t* disc = take_u32(sz_u32n);
  uint32_t* low = take_u32(sz_u32n);
  uint32_t* tarjan_stack = take_u32(sz_u32n);
  uint32_t* dfs_node = take_u32(sz_u32n);
  uint32_t* dfs_edge = take_u32(sz_u32n);
  uint32_t* scc_size = take_u32(sz_u32n);
  uint32_t* two_hop_in = take_u32(sz_u32n);
  uint8_t* on_stack = take_u8(sz_u8n);
  uint8_t* self_loop = take_u8(sz_u8n);

  for (uint32_t i = 0u; i < num_nodes; ++i) {
    out_deg[i] = 0u;
    in_deg[i] = 0u;
    disc[i] = 0u;
    low[i] = 0u;
    scc_size[i] = 0u;
    two_hop_in[i] = 0u;
    on_stack[i] = 0u;
    self_loop[i] = 0u;
  }

  for (uint32_t i = 0u; i < num_edges; ++i) {
    const uint32_t u = edge_src[i];
    const uint32_t v = edge_dst[i];
    if (u >= num_nodes || v >= num_nodes) continue;
    out_deg[u] += 1u;
    in_deg[v] += 1u;
    if (u == v) self_loop[u] = 1u;
  }

  row_ptr[0] = 0u;
  for (uint32_t i = 0u; i < num_nodes; ++i) {
    row_ptr[i + 1u] = row_ptr[i] + out_deg[i];
    cursor[i] = row_ptr[i];
  }

  for (uint32_t i = 0u; i < num_edges; ++i) {
    const uint32_t u = edge_src[i];
    const uint32_t v = edge_dst[i];
    if (u >= num_nodes || v >= num_nodes) continue;
    col_idx[cursor[u]++] = v;
  }

  // Fully non-recursive Tarjan SCC using explicit DFS and component stacks.
  uint32_t next_index = 1u;
  uint32_t tarjan_top = 0u;

  for (uint32_t start = 0u; start < num_nodes; ++start) {
    if (disc[start] != 0u) continue;

    disc[start] = next_index;
    low[start] = next_index;
    next_index += 1u;
    tarjan_stack[tarjan_top++] = start;
    on_stack[start] = 1u;

    uint32_t dfs_top = 0u;
    dfs_node[dfs_top] = start;
    dfs_edge[dfs_top] = row_ptr[start];
    dfs_top = 1u;

    while (dfs_top > 0u) {
      const uint32_t frame = dfs_top - 1u;
      const uint32_t v = dfs_node[frame];
      const uint32_t ei = dfs_edge[frame];
      if (ei < row_ptr[v + 1u]) {
        dfs_edge[frame] = ei + 1u;
        const uint32_t w = col_idx[ei];
        if (disc[w] == 0u) {
          disc[w] = next_index;
          low[w] = next_index;
          next_index += 1u;
          tarjan_stack[tarjan_top++] = w;
          on_stack[w] = 1u;
          dfs_node[dfs_top] = w;
          dfs_edge[dfs_top] = row_ptr[w];
          dfs_top += 1u;
        } else if (on_stack[w] != 0u) {
          if (disc[w] < low[v]) low[v] = disc[w];
        }
      } else {
        dfs_top -= 1u;
        if (low[v] == disc[v]) {
          uint32_t scc_start = tarjan_top;
          uint32_t min_id = v;
          while (scc_start > 0u) {
            scc_start -= 1u;
            const uint32_t w = tarjan_stack[scc_start];
            if (w < min_id) min_id = w;
            on_stack[w] = 0u;
            if (w == v) break;
          }
          const uint32_t count = tarjan_top - scc_start;
          for (uint32_t k = scc_start; k < tarjan_top; ++k) {
            out_scc[tarjan_stack[k]] = min_id;
          }
          scc_size[min_id] = count;
          tarjan_top = scc_start;
        }
        if (dfs_top > 0u) {
          const uint32_t parent = dfs_node[dfs_top - 1u];
          if (low[v] < low[parent]) low[parent] = low[v];
        }
      }
    }
  }

  // Forward 1-pass saturated accumulation for 2-hop in-degree.
  for (uint32_t i = 0u; i < num_edges; ++i) {
    const uint32_t u = edge_src[i];
    const uint32_t v = edge_dst[i];
    if (u >= num_nodes || v >= num_nodes) continue;
    const uint32_t add = min_u32(500u, in_deg[u]);
    two_hop_in[v] = min_u32(500u, two_hop_in[v] + add);
  }

  // Role classification (4 > 2 > 3 > 1 > 0) and saturated importance score (0..1000).
  for (uint32_t v = 0u; v < num_nodes; ++v) {
    const uint32_t ind = in_deg[v];
    const uint32_t outd = out_deg[v];
    uint8_t role = 0u;
    if (scc_size[out_scc[v]] >= 2u || self_loop[v] != 0u) {
      role = 4u;
    } else if (outd >= 8u && (outd >> 1u) >= ind) {
      role = 2u;
    } else if (ind >= 10u && outd <= 3u) {
      role = 3u;
    } else if (outd == 0u && ind >= 1u) {
      role = 1u;
    }
    out_role[v] = role;

    const uint32_t in_term = ind >= 84u ? 1000u : (ind * 12u);
    const uint32_t out_term = outd >= 125u ? 1000u : (outd * 8u);
    const uint32_t two_hop_term = two_hop_in[v] * 2u;
    const uint32_t rec_bonus = role == 4u ? 80u : 0u;
    out_score[v] = min_u32(1000u, in_term + out_term + two_hop_term + rec_bonus);
  }

  return num_nodes;
}

}  // extern "C"
