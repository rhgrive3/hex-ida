#include "cfg_engine.hpp"

namespace {

constexpr uint32_t kMaxCfgNodes = static_cast<uint32_t>(INT32_MAX / 4);

HexStatus validate_csr_input(uint32_t n, const uint32_t* succ_off, const int32_t* succ_dst) {
  if (n > kMaxCfgNodes) return HEX_ERR_RESOURCE_LIMIT;
  if (!succ_off) return HEX_ERR_INVALID_ARG;
  if (succ_off[0] != 0u) return HEX_ERR_INVALID_ARG;
  for (uint32_t i = 0; i < n; ++i) {
    if (succ_off[i] > succ_off[i + 1]) return HEX_ERR_INVALID_ARG;
  }
  if (succ_off[n] > 0u && !succ_dst) return HEX_ERR_INVALID_ARG;
  return HEX_OK;
}

inline void zero_u8(uint8_t* p, size_t n) {
  if (n > 0) hex::mem_set(p, 0, n);
}

inline void zero_u32(uint32_t* p, size_t n) {
  if (n > 0) hex::mem_set(p, 0, n * sizeof(uint32_t));
}

inline void fill_i32(int32_t* p, size_t n, int32_t v) {
  for (size_t i = 0; i < n; ++i) p[i] = v;
}

// Build CSR predecessors from CSR successors (preserving node ascending order).
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

// Compute reachable mask and visit order from entry via iterative DFS (matches JS reachableFrom).
bool compute_reachable(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    int32_t entry,
    uint8_t* out_mask,
    int32_t* out_order,
    uint32_t* out_count) {
  zero_u8(out_mask, n);
  *out_count = 0;
  if (entry < 0 || static_cast<uint32_t>(entry) >= n) return true;

  const size_t m = static_cast<size_t>(succ_off[n]);
  const size_t sn = static_cast<size_t>(n);
  if (m > static_cast<size_t>(-1) - sn - 2u) return false;
  const size_t stack_cap = m + sn + 2u;

  hex::ArenaScope scratch(arena);
  int32_t* stack = arena.alloc<int32_t>(stack_cap);
  if (!stack) return false;

  size_t sp = 0;
  stack[sp++] = entry;
  uint32_t count = 0;
  while (sp > 0) {
    const int32_t i = stack[--sp];
    if (out_mask[i]) continue;
    out_mask[i] = 1;
    out_order[count++] = i;
    const uint32_t beg = succ_off[static_cast<uint32_t>(i)];
    const uint32_t end = succ_off[static_cast<uint32_t>(i) + 1];
    for (uint32_t e = beg; e < end; ++e) {
      const int32_t j = succ_dst[e];
      if (j >= 0 && static_cast<uint32_t>(j) < n && !out_mask[j]) {
        stack[sp++] = j;
      }
    }
  }
  *out_count = count;
  return true;
}

// Iterative RPO + Cooper-Harvey-Kennedy immediate dominators (exact parity with JS).
bool compute_idom(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    const uint32_t* pred_off,
    const int32_t* pred_src,
    const uint8_t* allowed_mask,
    int32_t entry,
    int32_t* idom) {
  fill_i32(idom, n, -1);
  if (entry < 0 || static_cast<uint32_t>(entry) >= n) return true;
  if (allowed_mask && !allowed_mask[entry]) return true;

  hex::ArenaScope scratch(arena);
  uint8_t* seen = arena.alloc<uint8_t>(n);
  int32_t* rpo = arena.alloc<int32_t>(n);
  int32_t* rank = arena.alloc<int32_t>(n);
  int32_t* st_node = arena.alloc<int32_t>(n);
  uint32_t* st_next = arena.alloc<uint32_t>(n);
  if (!seen || !rpo || !rank || !st_node || !st_next) return false;

  zero_u8(seen, n);
  fill_i32(rank, n, -1);

  seen[entry] = 1;
  uint32_t sp = 0;
  st_node[sp] = entry;
  st_next[sp] = succ_off[static_cast<uint32_t>(entry)];
  sp++;

  uint32_t post_len = 0;
  while (sp > 0) {
    const int32_t u = st_node[sp - 1];
    const uint32_t end = succ_off[static_cast<uint32_t>(u) + 1];
    if (st_next[sp - 1] < end) {
      const int32_t next = succ_dst[st_next[sp - 1]++];
      if (next < 0 || static_cast<uint32_t>(next) >= n) continue;
      if ((allowed_mask && !allowed_mask[next]) || seen[next]) continue;
      seen[next] = 1;
      st_node[sp] = next;
      st_next[sp] = succ_off[static_cast<uint32_t>(next)];
      sp++;
    } else {
      rpo[post_len++] = u;
      sp--;
    }
  }
  if (post_len == 0) return true;

  for (uint32_t i = 0; i < post_len / 2; ++i) {
    const int32_t tmp = rpo[i];
    rpo[i] = rpo[post_len - 1 - i];
    rpo[post_len - 1 - i] = tmp;
  }
  for (uint32_t i = 0; i < post_len; ++i) {
    rank[rpo[i]] = static_cast<int32_t>(i);
  }

  idom[entry] = entry;
  const uint32_t max_guard = n * 2u + 4u;
  auto intersect = [&](int32_t a, int32_t b) -> int32_t {
    uint32_t guard = max_guard;
    while (a != b && guard-- > 0) {
      while (a >= 0 && b >= 0 && rank[a] > rank[b]) a = idom[a];
      while (a >= 0 && b >= 0 && rank[b] > rank[a]) b = idom[b];
      if (a < 0 || b < 0) return -1;
    }
    return (a == b) ? a : -1;
  };

  bool changed = true;
  for (uint32_t round = 0; changed && round < max_guard; ++round) {
    changed = false;
    for (uint32_t ri = 1; ri < post_len; ++ri) {
      const int32_t node = rpo[ri];
      const uint32_t pb = pred_off[static_cast<uint32_t>(node)];
      const uint32_t pe = pred_off[static_cast<uint32_t>(node) + 1];
      if (pb == pe) continue;
      int32_t next = -1;
      for (uint32_t e = pb; e < pe; ++e) {
        const int32_t p = pred_src[e];
        if ((allowed_mask && !allowed_mask[p]) || idom[p] < 0) continue;
        next = (next < 0) ? p : intersect(next, p);
        if (next < 0) break;
      }
      if (next >= 0 && idom[node] != next) {
        idom[node] = next;
        changed = true;
      }
    }
  }
  idom[entry] = -1;
  return true;
}

// Compute dominance tree Euler tour (tin, tout, depth) non-recursively.
bool compute_dom_index(
    hex::Arena& arena,
    uint32_t n,
    const int32_t* idom,
    const uint8_t* reachable_mask,
    int32_t* tin,
    int32_t* tout,
    int32_t* depth) {
  fill_i32(tin, n, -1);
  fill_i32(tout, n, -1);
  fill_i32(depth, n, 0);
  if (n == 0) return true;

  hex::ArenaScope scratch(arena);
  const size_t st_cap = static_cast<size_t>(n) * 2u + 2u;
  uint32_t* child_off = arena.alloc<uint32_t>(static_cast<size_t>(n) + 1u);
  int32_t* child_list = arena.alloc<int32_t>(n);
  int32_t* roots = arena.alloc<int32_t>(n);
  uint32_t* cursor = arena.alloc<uint32_t>(n);
  int32_t* st_node = arena.alloc<int32_t>(st_cap);
  uint8_t* st_exit = arena.alloc<uint8_t>(st_cap);
  if (!child_off || !child_list || !roots || !cursor || !st_node || !st_exit) return false;

  zero_u32(child_off, static_cast<size_t>(n) + 1u);
  uint32_t root_count = 0;
  for (uint32_t i = 0; i < n; ++i) {
    if (!reachable_mask[i]) continue;
    if (idom[i] >= 0 && static_cast<uint32_t>(idom[i]) < n) {
      child_off[static_cast<uint32_t>(idom[i]) + 1]++;
    } else {
      roots[root_count++] = static_cast<int32_t>(i);
    }
  }
  for (uint32_t i = 0; i < n; ++i) child_off[i + 1] += child_off[i];
  for (uint32_t i = 0; i < n; ++i) cursor[i] = child_off[i];
  for (uint32_t i = 0; i < n; ++i) {
    if (!reachable_mask[i]) continue;
    if (idom[i] >= 0 && static_cast<uint32_t>(idom[i]) < n) {
      child_list[cursor[static_cast<uint32_t>(idom[i])]++] = static_cast<int32_t>(i);
    }
  }

  int32_t clock = 0;
  for (uint32_t r = 0; r < root_count; ++r) {
    size_t sp = 0;
    st_node[sp] = roots[r];
    st_exit[sp] = 0;
    sp++;
    while (sp > 0) {
      sp--;
      const int32_t u = st_node[sp];
      const uint8_t is_exit = st_exit[sp];
      if (is_exit) {
        tout[u] = clock++;
        continue;
      }
      tin[u] = clock++;
      st_node[sp] = u;
      st_exit[sp] = 1;
      sp++;
      const uint32_t cb = child_off[static_cast<uint32_t>(u)];
      const uint32_t ce = child_off[static_cast<uint32_t>(u) + 1];
      for (uint32_t k = ce; k > cb; --k) {
        const int32_t kid = child_list[k - 1];
        depth[kid] = depth[u] + 1;
        st_node[sp] = kid;
        st_exit[sp] = 0;
        sp++;
      }
    }
  }
  return true;
}

// Iterative Kosaraju SCC (exact parity with JS strongComponents).
bool compute_scc(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    const uint32_t* pred_off,
    const int32_t* pred_src,
    const int32_t* reach_order,
    uint32_t reach_count,
    const uint8_t* reachable_mask,
    int32_t* component_of,
    uint32_t* out_num_components) {
  fill_i32(component_of, n, -1);
  *out_num_components = 0;
  if (reach_count == 0) return true;

  hex::ArenaScope scratch(arena);
  uint8_t* seen = arena.alloc<uint8_t>(n);
  int32_t* finish = arena.alloc<int32_t>(n);
  int32_t* st_node = arena.alloc<int32_t>(n);
  uint32_t* st_next = arena.alloc<uint32_t>(n);
  uint8_t* assigned = arena.alloc<uint8_t>(n);
  if (!seen || !finish || !st_node || !st_next || !assigned) return false;

  zero_u8(seen, n);
  zero_u8(assigned, n);
  uint32_t finish_len = 0;

  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const int32_t root = reach_order[ri];
    if (seen[root]) continue;
    seen[root] = 1;
    uint32_t sp = 0;
    st_node[sp] = root;
    st_next[sp] = succ_off[static_cast<uint32_t>(root)];
    sp++;
    while (sp > 0) {
      const int32_t u = st_node[sp - 1];
      const uint32_t end = succ_off[static_cast<uint32_t>(u) + 1];
      if (st_next[sp - 1] < end) {
        const int32_t next = succ_dst[st_next[sp - 1]++];
        if (next < 0 || static_cast<uint32_t>(next) >= n) continue;
        if (!reachable_mask[next] || seen[next]) continue;
        seen[next] = 1;
        st_node[sp] = next;
        st_next[sp] = succ_off[static_cast<uint32_t>(next)];
        sp++;
      } else {
        finish[finish_len++] = u;
        sp--;
      }
    }
  }

  uint32_t num_comp = 0;
  for (uint32_t fi = finish_len; fi > 0; --fi) {
    const int32_t root = finish[fi - 1];
    if (assigned[root]) continue;
    uint32_t sp = 0;
    st_node[sp++] = root;
    assigned[root] = 1;
    while (sp > 0) {
      const int32_t node = st_node[--sp];
      component_of[node] = static_cast<int32_t>(num_comp);
      const uint32_t pb = pred_off[static_cast<uint32_t>(node)];
      const uint32_t pe = pred_off[static_cast<uint32_t>(node) + 1];
      for (uint32_t e = pb; e < pe; ++e) {
        const int32_t next = pred_src[e];
        if (!reachable_mask[next] || assigned[next]) continue;
        assigned[next] = 1;
        st_node[sp++] = next;
      }
    }
    num_comp++;
  }
  *out_num_components = num_comp;
  return true;
}

}  // namespace

extern "C" HexStatus hex_cfg_analyze_arena(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    int32_t entry,
    const uint8_t* terminating_mask,
    HexCfgResult* out) {
  if (!out) return HEX_ERR_INVALID_ARG;
  const HexStatus csr_st = validate_csr_input(n, succ_off, succ_dst);
  if (csr_st != HEX_OK) return csr_st;

  out->reachable_mask = n > 0 ? arena.alloc<uint8_t>(n) : nullptr;
  out->reach_order = n > 0 ? arena.alloc<int32_t>(n) : nullptr;
  out->reach_count = 0;
  out->idom = n > 0 ? arena.alloc<int32_t>(n) : nullptr;
  out->dom_tin = n > 0 ? arena.alloc<int32_t>(n) : nullptr;
  out->dom_tout = n > 0 ? arena.alloc<int32_t>(n) : nullptr;
  out->dom_depth = n > 0 ? arena.alloc<int32_t>(n) : nullptr;
  out->component_of = n > 0 ? arena.alloc<int32_t>(n) : nullptr;
  out->num_components = 0;

  const uint32_t np1 = n + 1u;
  out->pdom_idom = arena.alloc<int32_t>(np1);
  out->pdom_tin = arena.alloc<int32_t>(np1);
  out->pdom_tout = arena.alloc<int32_t>(np1);
  out->pdom_depth = arena.alloc<int32_t>(np1);
  out->pdom_reachable_mask = arena.alloc<uint8_t>(np1);
  out->non_term_mask = n > 0 ? arena.alloc<uint8_t>(n) : nullptr;

  if ((n > 0 && (!out->reachable_mask || !out->reach_order || !out->idom ||
                 !out->dom_tin || !out->dom_tout || !out->dom_depth ||
                 !out->component_of || !out->non_term_mask)) ||
      !out->pdom_idom || !out->pdom_tin || !out->pdom_tout ||
      !out->pdom_depth || !out->pdom_reachable_mask) {
    return HEX_ERR_OOM;
  }

  if (n == 0) {
    out->pdom_idom[0] = -1;
    out->pdom_tin[0] = 0;
    out->pdom_tout[0] = 1;
    out->pdom_depth[0] = 0;
    out->pdom_reachable_mask[0] = 1;
    return HEX_OK;
  }

  hex::ArenaScope work_scope(arena);

  uint32_t* pred_off = nullptr;
  int32_t* pred_src = nullptr;
  if (!build_predecessors(arena, n, succ_off, succ_dst, &pred_off, &pred_src)) {
    return HEX_ERR_OOM;
  }

  uint32_t reach_count = 0;
  if (!compute_reachable(arena, n, succ_off, succ_dst, entry, out->reachable_mask, out->reach_order, &reach_count)) {
    return HEX_ERR_OOM;
  }
  out->reach_count = reach_count;

  if (!compute_idom(arena, n, succ_off, succ_dst, pred_off, pred_src, out->reachable_mask, entry, out->idom)) {
    return HEX_ERR_OOM;
  }

  if (!compute_dom_index(arena, n, out->idom, out->reachable_mask, out->dom_tin, out->dom_tout, out->dom_depth)) {
    return HEX_ERR_OOM;
  }

  if (!compute_scc(arena, n, succ_off, succ_dst, pred_off, pred_src, out->reach_order, reach_count, out->reachable_mask, out->component_of, &out->num_components)) {
    return HEX_ERR_OOM;
  }

  // Post-dominators: identify non-terminating bottom SCCs and build reverse CSR graph with synthetic EXIT = n
  zero_u8(out->non_term_mask, n);
  const uint32_t num_comp = out->num_components;
  uint8_t* comp_has_out = num_comp > 0 ? arena.alloc<uint8_t>(num_comp) : nullptr;
  uint8_t* comp_has_exit = num_comp > 0 ? arena.alloc<uint8_t>(num_comp) : nullptr;
  uint8_t* non_term_sink = arena.alloc<uint8_t>(n);
  int32_t* bad_stack = arena.alloc<int32_t>(n);
  if ((num_comp > 0 && (!comp_has_out || !comp_has_exit)) || !non_term_sink || !bad_stack) {
    return HEX_ERR_OOM;
  }
  if (num_comp > 0) {
    zero_u8(comp_has_out, num_comp);
    zero_u8(comp_has_exit, num_comp);
  }
  zero_u8(non_term_sink, n);

  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const int32_t i = out->reach_order[ri];
    const int32_t ci = out->component_of[i];
    const uint32_t beg = succ_off[static_cast<uint32_t>(i)];
    const uint32_t end = succ_off[static_cast<uint32_t>(i) + 1];
    bool has_internal = false;
    for (uint32_t e = beg; e < end; ++e) {
      const int32_t j = succ_dst[e];
      if (j < 0 || static_cast<uint32_t>(j) >= n || !out->reachable_mask[j]) continue;
      has_internal = true;
      if (ci != out->component_of[j]) comp_has_out[ci] = 1;
    }
    const bool is_term = terminating_mask && terminating_mask[i];
    if (!has_internal || is_term) comp_has_exit[ci] = 1;
  }

  uint32_t bad_sp = 0;
  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const int32_t i = out->reach_order[ri];
    const int32_t ci = out->component_of[i];
    if (ci >= 0 && !comp_has_out[ci] && !comp_has_exit[ci]) {
      non_term_sink[i] = 1;
      if (!out->non_term_mask[i]) {
        out->non_term_mask[i] = 1;
        bad_stack[bad_sp++] = i;
      }
    }
  }
  while (bad_sp > 0) {
    const int32_t i = bad_stack[--bad_sp];
    const uint32_t pb = pred_off[static_cast<uint32_t>(i)];
    const uint32_t pe = pred_off[static_cast<uint32_t>(i) + 1];
    for (uint32_t e = pb; e < pe; ++e) {
      const int32_t p = pred_src[e];
      if (!out->reachable_mask[p] || out->non_term_mask[p]) continue;
      out->non_term_mask[p] = 1;
      bad_stack[bad_sp++] = p;
    }
  }

  // Build reverse CSR graph of size n + 1 (EXIT = n)
  uint32_t* rev_off = arena.alloc<uint32_t>(static_cast<size_t>(np1) + 1u);
  if (!rev_off) return HEX_ERR_OOM;
  zero_u32(rev_off, static_cast<size_t>(np1) + 1u);

  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const int32_t i = out->reach_order[ri];
    const uint32_t beg = succ_off[static_cast<uint32_t>(i)];
    const uint32_t end = succ_off[static_cast<uint32_t>(i) + 1];
    bool has_internal = false;
    for (uint32_t e = beg; e < end; ++e) {
      const int32_t j = succ_dst[e];
      if (j < 0 || static_cast<uint32_t>(j) >= n || !out->reachable_mask[j]) continue;
      has_internal = true;
      rev_off[static_cast<uint32_t>(j) + 1]++;
    }
    const bool is_term = terminating_mask && terminating_mask[i];
    if (!has_internal || non_term_sink[i] || is_term) {
      rev_off[n + 1]++;
    }
  }
  for (uint32_t i = 0; i < np1; ++i) {
    if (rev_off[i + 1] > UINT32_MAX - rev_off[i]) return HEX_ERR_RESOURCE_LIMIT;
    rev_off[i + 1] += rev_off[i];
  }

  const uint32_t rev_m = rev_off[np1];
  int32_t* rev_dst = rev_m > 0 ? arena.alloc<int32_t>(rev_m) : nullptr;
  uint32_t* rev_cur = arena.alloc<uint32_t>(np1);
  if ((rev_m > 0 && !rev_dst) || !rev_cur) return HEX_ERR_OOM;
  for (uint32_t i = 0; i < np1; ++i) rev_cur[i] = rev_off[i];

  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const int32_t i = out->reach_order[ri];
    const uint32_t beg = succ_off[static_cast<uint32_t>(i)];
    const uint32_t end = succ_off[static_cast<uint32_t>(i) + 1];
    bool has_internal = false;
    for (uint32_t e = beg; e < end; ++e) {
      const int32_t j = succ_dst[e];
      if (j < 0 || static_cast<uint32_t>(j) >= n || !out->reachable_mask[j]) continue;
      has_internal = true;
      rev_dst[rev_cur[static_cast<uint32_t>(j)]++] = i;
    }
    const bool is_term = terminating_mask && terminating_mask[i];
    if (!has_internal || non_term_sink[i] || is_term) {
      rev_dst[rev_cur[n]++] = i;
    }
  }

  uint32_t* rev_pred_off = nullptr;
  int32_t* rev_pred_src = nullptr;
  if (!build_predecessors(arena, np1, rev_off, rev_dst, &rev_pred_off, &rev_pred_src)) {
    return HEX_ERR_OOM;
  }

  int32_t* rev_reach_order = arena.alloc<int32_t>(np1);
  if (!rev_reach_order) return HEX_ERR_OOM;
  uint32_t rev_reach_count = 0;
  if (!compute_reachable(arena, np1, rev_off, rev_dst, static_cast<int32_t>(n), out->pdom_reachable_mask, rev_reach_order, &rev_reach_count)) {
    return HEX_ERR_OOM;
  }

  if (!compute_idom(arena, np1, rev_off, rev_dst, rev_pred_off, rev_pred_src, out->pdom_reachable_mask, static_cast<int32_t>(n), out->pdom_idom)) {
    return HEX_ERR_OOM;
  }

  if (!compute_dom_index(arena, np1, out->pdom_idom, out->pdom_reachable_mask, out->pdom_tin, out->pdom_tout, out->pdom_depth)) {
    return HEX_ERR_OOM;
  }

  return HEX_OK;
}

#if defined(__wasm__)
extern unsigned char __heap_base;

static hex::Arena g_wasm_arena;
static HexCfgResult g_wasm_result;

extern "C" {

HEX_WASM_EXPORT("get_heap_base")
uint32_t get_heap_base(void) {
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&__heap_base));
}

HEX_WASM_EXPORT("cfg_reset")
void cfg_reset(void) {
  const uint32_t base = (get_heap_base() + 7u) & ~7u;
  const size_t total = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u;
  g_wasm_arena.init_external(reinterpret_cast<uint8_t*>(base), total > base ? total - base : 0);
}

HEX_WASM_EXPORT("cfg_alloc")
uint32_t cfg_alloc(uint32_t bytes) {
  uint8_t* p = g_wasm_arena.alloc<uint8_t>(bytes);
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(p));
}

HEX_WASM_EXPORT("cfg_analyze")
uint32_t cfg_analyze(
    uint32_t n,
    uint32_t succ_off_ptr,
    uint32_t succ_dst_ptr,
    int32_t entry,
    uint32_t terminating_mask_ptr) {
  if ((succ_off_ptr & 3u) != 0u || (succ_dst_ptr & 3u) != 0u) {
    return static_cast<uint32_t>(HEX_ERR_INVALID_ARG);
  }
  const uint32_t* succ_off = succ_off_ptr
      ? reinterpret_cast<const uint32_t*>(static_cast<uintptr_t>(succ_off_ptr))
      : nullptr;
  const int32_t* succ_dst = succ_dst_ptr
      ? reinterpret_cast<const int32_t*>(static_cast<uintptr_t>(succ_dst_ptr))
      : nullptr;
  const uint8_t* term_mask = terminating_mask_ptr
      ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(terminating_mask_ptr))
      : nullptr;
  return static_cast<uint32_t>(hex_cfg_analyze_arena(g_wasm_arena, n, succ_off, succ_dst, entry, term_mask, &g_wasm_result));
}

HEX_WASM_EXPORT("cfg_get_result_ptr")
uint32_t cfg_get_result_ptr(uint32_t field_id) {
  switch (field_id) {
    case 0: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.reachable_mask));
    case 1: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.idom));
    case 2: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.dom_tin));
    case 3: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.dom_tout));
    case 4: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.dom_depth));
    case 5: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.component_of));
    case 6: return g_wasm_result.num_components;
    case 7: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.pdom_idom));
    case 8: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.pdom_tin));
    case 9: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.pdom_tout));
    case 10: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.pdom_depth));
    case 11: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.pdom_reachable_mask));
    case 12: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.non_term_mask));
    case 13: return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasm_result.reach_order));
    case 14: return g_wasm_result.reach_count;
    default: return 0;
  }
}

}  // extern "C"
#endif
