#include "resident_ir.hpp"

namespace hex {
namespace ir {

namespace {

constexpr uint64_t kFnvOffsetLo = 0xcbf29ce484222325ULL;
constexpr uint64_t kFnvOffsetHi = 0x84222325cbf29ce4ULL;
constexpr uint64_t kFnvPrime = 0x100000001b3ULL;

inline void hash_u32_pair(uint64_t& lo, uint64_t& hi, uint32_t v) {
  for (uint32_t i = 0; i < 4; ++i) {
    const uint8_t b = static_cast<uint8_t>((v >> (i * 8u)) & 0xffu);
    lo ^= static_cast<uint64_t>(b);
    lo *= kFnvPrime;
    hi ^= static_cast<uint64_t>(b) ^ static_cast<uint64_t>(i * 0x9du);
    hi *= kFnvPrime;
  }
}

inline void hash_u64_pair(uint64_t& lo, uint64_t& hi, uint64_t v) {
  hash_u32_pair(lo, hi, static_cast<uint32_t>(v & 0xffffffffULL));
  hash_u32_pair(lo, hi, static_cast<uint32_t>((v >> 32) & 0xffffffffULL));
}

inline bool heap_push_min(Vec<uint32_t>& heap, uint32_t item) {
  if (!heap.push_back(item)) return false;
  size_t idx = heap.size() - 1;
  while (idx > 0) {
    const size_t parent = (idx - 1) >> 1;
    if (heap[idx] >= heap[parent]) break;
    swap_val(heap[idx], heap[parent]);
    idx = parent;
  }
  return true;
}

inline uint32_t heap_pop_min(Vec<uint32_t>& heap) {
  const uint32_t top = heap[0];
  const uint32_t last = heap.back();
  heap.pop_back();
  const size_t n = heap.size();
  if (n > 0) {
    heap[0] = last;
    size_t idx = 0;
    for (;;) {
      const size_t left = idx * 2 + 1;
      const size_t right = left + 1;
      size_t smallest = idx;
      if (left < n && heap[left] < heap[smallest]) smallest = left;
      if (right < n && heap[right] < heap[smallest]) smallest = right;
      if (smallest == idx) break;
      swap_val(heap[idx], heap[smallest]);
      idx = smallest;
    }
  }
  return top;
}

struct StackNode {
  uint32_t val_id;
  uint32_t prev;
};

struct RenameFrame {
  uint32_t block_id;
  uint32_t child_idx;
  uint32_t pushed_start;
  uint32_t pushed_count;
  uint8_t entered;
  uint8_t pad0;
  uint16_t pad1;
};

struct RawUse {
  uint32_t ssa_val;
  uint32_t user_index;
  uint8_t user_kind;
  uint8_t operand_slot;
  uint16_t pad;
};

struct PhiPlacement {
  uint32_t block_id;
  uint32_t dense_var;
};

inline bool push_var_stack(
    Vec<StackNode>& pool,
    Vec<uint32_t>& top,
    uint32_t dense_var,
    uint32_t val_id) {
  const uint32_t node_idx = static_cast<uint32_t>(pool.size());
  StackNode node{val_id, top[dense_var]};
  if (!pool.push_back(node)) return false;
  top[dense_var] = node_idx;
  return true;
}

inline void pop_var_stack(const Vec<StackNode>& pool, Vec<uint32_t>& top, uint32_t dense_var) {
  const uint32_t cur = top[dense_var];
  if (cur != kNone) {
    top[dense_var] = pool[cur].prev;
  }
}

inline uint32_t peek_var_stack(const Vec<StackNode>& pool, const Vec<uint32_t>& top, uint32_t dense_var) {
  const uint32_t cur = top[dense_var];
  return cur == kNone ? kNone : pool[cur].val_id;
}

inline bool is_dom(const IrFunction& fn, uint32_t a, uint32_t d) {
  const uint32_t n = fn.header.block_count;
  if (a >= n || d >= n) return false;
  if (!fn.reachable_mask[a] || !fn.reachable_mask[d]) return false;
  if (a == d) return true;
  return fn.dom_tin[a] >= 0 && fn.dom_tin[a] <= fn.dom_tin[d] && fn.dom_tout[d] <= fn.dom_tout[a];
}

// ---------------------------------------------------------------------------
// Self-contained non-recursive CFG analysis (zero dependency on cfg_engine)
// ---------------------------------------------------------------------------
bool compute_reachable_dfs(
    Arena& scratch,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    uint32_t entry,
    uint8_t* out_mask,
    int32_t* out_order,
    uint32_t* out_count) {
  mem_set(out_mask, 0, n);
  *out_count = 0u;
  if (entry >= n) return true;

  const uint32_t m = succ_off[n];
  const size_t cap = static_cast<size_t>(m) + static_cast<size_t>(n) + 2u;
  uint32_t* stack = scratch.alloc<uint32_t>(cap);
  if (!stack) return false;

  uint32_t sp = 0u;
  stack[sp++] = entry;
  uint32_t count = 0u;
  while (sp > 0u) {
    const uint32_t u = stack[--sp];
    if (out_mask[u]) continue;
    out_mask[u] = 1u;
    out_order[count++] = static_cast<int32_t>(u);
    const uint32_t sb = succ_off[u];
    const uint32_t se = succ_off[u + 1u];
    for (uint32_t e = sb; e < se; ++e) {
      const int32_t v = succ_dst[e];
      if (v >= 0 && static_cast<uint32_t>(v) < n && !out_mask[static_cast<uint32_t>(v)]) {
        stack[sp++] = static_cast<uint32_t>(v);
      }
    }
  }
  *out_count = count;
  return true;
}

bool compute_idom_chk(
    Arena& scratch,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    const uint32_t* pred_off,
    const int32_t* pred_src,
    const uint8_t* allowed,
    uint32_t entry,
    int32_t* idom) {
  for (uint32_t i = 0; i < n; ++i) idom[i] = -1;
  if (entry >= n || (allowed && !allowed[entry])) return true;

  uint8_t* seen = arena_alloc_zeroed<uint8_t>(scratch, n);
  int32_t* rpo = scratch.alloc<int32_t>(n);
  int32_t* rank = scratch.alloc<int32_t>(n);
  uint32_t* st_node = scratch.alloc<uint32_t>(n);
  uint32_t* st_next = scratch.alloc<uint32_t>(n);
  if (!seen || !rpo || !rank || !st_node || !st_next) return false;
  for (uint32_t i = 0; i < n; ++i) rank[i] = -1;

  seen[entry] = 1u;
  uint32_t sp = 0u;
  st_node[sp] = entry;
  st_next[sp] = succ_off[entry];
  ++sp;

  uint32_t post_len = 0u;
  while (sp > 0u) {
    const uint32_t u = st_node[sp - 1u];
    const uint32_t end = succ_off[u + 1u];
    if (st_next[sp - 1u] < end) {
      const int32_t next = succ_dst[st_next[sp - 1u]++];
      if (next < 0 || static_cast<uint32_t>(next) >= n) continue;
      const uint32_t nu = static_cast<uint32_t>(next);
      if ((allowed && !allowed[nu]) || seen[nu]) continue;
      seen[nu] = 1u;
      st_node[sp] = nu;
      st_next[sp] = succ_off[nu];
      ++sp;
    } else {
      rpo[post_len++] = static_cast<int32_t>(u);
      --sp;
    }
  }
  if (post_len == 0u) return true;

  for (uint32_t i = 0; i < post_len / 2u; ++i) {
    swap_val(rpo[i], rpo[post_len - 1u - i]);
  }
  for (uint32_t i = 0; i < post_len; ++i) {
    rank[static_cast<uint32_t>(rpo[i])] = static_cast<int32_t>(i);
  }

  idom[entry] = static_cast<int32_t>(entry);
  const uint32_t max_guard = n * 2u + 4u;
  auto intersect = [&](int32_t a, int32_t b) -> int32_t {
    uint32_t guard = max_guard;
    while (a != b && guard-- > 0u) {
      while (a >= 0 && b >= 0 && rank[a] > rank[b]) a = idom[a];
      while (a >= 0 && b >= 0 && rank[b] > rank[a]) b = idom[b];
      if (a < 0 || b < 0) return -1;
    }
    return (a == b) ? a : -1;
  };

  bool changed = true;
  for (uint32_t round = 0; changed && round < max_guard; ++round) {
    changed = false;
    for (uint32_t ri = 1u; ri < post_len; ++ri) {
      const uint32_t node = static_cast<uint32_t>(rpo[ri]);
      const uint32_t pb = pred_off[node];
      const uint32_t pe = pred_off[node + 1u];
      if (pb == pe) continue;
      int32_t next = -1;
      for (uint32_t e = pb; e < pe; ++e) {
        const int32_t p = pred_src[e];
        if (p < 0 || static_cast<uint32_t>(p) >= n) continue;
        if ((allowed && !allowed[static_cast<uint32_t>(p)]) || idom[p] < 0) continue;
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

bool compute_dom_euler(
    Arena& scratch,
    uint32_t n,
    const int32_t* idom,
    const uint8_t* reachable,
    int32_t* tin,
    int32_t* tout,
    int32_t* depth) {
  for (uint32_t i = 0; i < n; ++i) {
    tin[i] = -1;
    tout[i] = -1;
    depth[i] = 0;
  }
  if (n == 0u) return true;

  uint32_t* child_off = arena_alloc_zeroed<uint32_t>(scratch, n + 1u);
  uint32_t* child_list = scratch.alloc<uint32_t>(n);
  uint32_t* roots = scratch.alloc<uint32_t>(n);
  uint32_t* cursor = scratch.alloc<uint32_t>(n);
  uint32_t* st_node = scratch.alloc<uint32_t>(static_cast<size_t>(n) * 2u + 2u);
  uint8_t* st_exit = scratch.alloc<uint8_t>(static_cast<size_t>(n) * 2u + 2u);
  if (!child_off || !child_list || !roots || !cursor || !st_node || !st_exit) return false;

  uint32_t root_count = 0u;
  for (uint32_t i = 0; i < n; ++i) {
    if (!reachable[i]) continue;
    if (idom[i] >= 0 && static_cast<uint32_t>(idom[i]) < n) {
      child_off[static_cast<uint32_t>(idom[i]) + 1u]++;
    } else {
      roots[root_count++] = i;
    }
  }
  for (uint32_t i = 0; i < n; ++i) child_off[i + 1u] += child_off[i];
  for (uint32_t i = 0; i < n; ++i) cursor[i] = child_off[i];
  for (uint32_t i = 0; i < n; ++i) {
    if (!reachable[i]) continue;
    if (idom[i] >= 0 && static_cast<uint32_t>(idom[i]) < n) {
      child_list[cursor[static_cast<uint32_t>(idom[i])]++] = i;
    }
  }

  int32_t clock = 0;
  for (uint32_t r = 0; r < root_count; ++r) {
    uint32_t sp = 0u;
    st_node[sp] = roots[r];
    st_exit[sp] = 0u;
    ++sp;
    while (sp > 0u) {
      --sp;
      const uint32_t u = st_node[sp];
      if (st_exit[sp]) {
        tout[u] = clock++;
        continue;
      }
      tin[u] = clock++;
      st_node[sp] = u;
      st_exit[sp] = 1u;
      ++sp;
      const uint32_t cb = child_off[u];
      const uint32_t ce = child_off[u + 1u];
      for (uint32_t k = ce; k > cb; --k) {
        const uint32_t kid = child_list[k - 1u];
        depth[kid] = depth[u] + 1;
        st_node[sp] = kid;
        st_exit[sp] = 0u;
        ++sp;
      }
    }
  }
  return true;
}

bool compute_scc_kosaraju(
    Arena& scratch,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    const uint32_t* pred_off,
    const int32_t* pred_src,
    const int32_t* reach_order,
    uint32_t reach_count,
    const uint8_t* reachable,
    int32_t* comp_of,
    uint32_t* out_num_comp) {
  for (uint32_t i = 0; i < n; ++i) comp_of[i] = -1;
  *out_num_comp = 0u;
  if (reach_count == 0u) return true;

  uint8_t* seen = arena_alloc_zeroed<uint8_t>(scratch, n);
  uint8_t* assigned = arena_alloc_zeroed<uint8_t>(scratch, n);
  uint32_t* finish = scratch.alloc<uint32_t>(n);
  uint32_t* st_node = scratch.alloc<uint32_t>(n);
  uint32_t* st_next = scratch.alloc<uint32_t>(n);
  if (!seen || !assigned || !finish || !st_node || !st_next) return false;

  uint32_t finish_len = 0u;
  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const uint32_t root = static_cast<uint32_t>(reach_order[ri]);
    if (seen[root]) continue;
    seen[root] = 1u;
    uint32_t sp = 0u;
    st_node[sp] = root;
    st_next[sp] = succ_off[root];
    ++sp;
    while (sp > 0u) {
      const uint32_t u = st_node[sp - 1u];
      const uint32_t end = succ_off[u + 1u];
      if (st_next[sp - 1u] < end) {
        const int32_t next = succ_dst[st_next[sp - 1u]++];
        if (next < 0 || static_cast<uint32_t>(next) >= n) continue;
        const uint32_t nu = static_cast<uint32_t>(next);
        if (!reachable[nu] || seen[nu]) continue;
        seen[nu] = 1u;
        st_node[sp] = nu;
        st_next[sp] = succ_off[nu];
        ++sp;
      } else {
        finish[finish_len++] = u;
        --sp;
      }
    }
  }

  uint32_t num_comp = 0u;
  for (uint32_t fi = finish_len; fi > 0u; --fi) {
    const uint32_t root = finish[fi - 1u];
    if (assigned[root]) continue;
    uint32_t sp = 0u;
    st_node[sp++] = root;
    assigned[root] = 1u;
    while (sp > 0u) {
      const uint32_t u = st_node[--sp];
      comp_of[u] = static_cast<int32_t>(num_comp);
      const uint32_t pb = pred_off[u];
      const uint32_t pe = pred_off[u + 1u];
      for (uint32_t e = pb; e < pe; ++e) {
        const int32_t p = pred_src[e];
        if (p < 0 || static_cast<uint32_t>(p) >= n) continue;
        const uint32_t pu = static_cast<uint32_t>(p);
        if (!reachable[pu] || assigned[pu]) continue;
        assigned[pu] = 1u;
        st_node[sp++] = pu;
      }
    }
    ++num_comp;
  }
  *out_num_comp = num_comp;
  return true;
}

bool compute_postdom_idom(
    Arena& scratch,
    uint32_t n,
    const uint32_t* succ_off,
    const int32_t* succ_dst,
    const int32_t* reach_order,
    uint32_t reach_count,
    const uint8_t* reachable,
    const int32_t* comp_of,
    uint32_t num_comp,
    const uint8_t* term_mask,
    int32_t* out_pdom_idom) {
  const uint32_t np1 = n + 1u;
  for (uint32_t i = 0; i < np1; ++i) out_pdom_idom[i] = -1;
  if (reach_count == 0u) return true;

  uint8_t* comp_has_out = num_comp > 0u ? arena_alloc_zeroed<uint8_t>(scratch, num_comp) : nullptr;
  uint8_t* comp_has_exit = num_comp > 0u ? arena_alloc_zeroed<uint8_t>(scratch, num_comp) : nullptr;
  uint8_t* non_term_sink = arena_alloc_zeroed<uint8_t>(scratch, n);
  uint32_t* rev_off = arena_alloc_zeroed<uint32_t>(scratch, np1 + 1u);
  if ((num_comp > 0u && (!comp_has_out || !comp_has_exit)) || !non_term_sink || !rev_off) {
    return false;
  }

  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const uint32_t i = static_cast<uint32_t>(reach_order[ri]);
    const int32_t ci = comp_of[i];
    const uint32_t sb = succ_off[i];
    const uint32_t se = succ_off[i + 1u];
    bool has_internal = false;
    for (uint32_t e = sb; e < se; ++e) {
      const int32_t j = succ_dst[e];
      if (j < 0 || static_cast<uint32_t>(j) >= n || !reachable[static_cast<uint32_t>(j)]) continue;
      has_internal = true;
      if (ci != comp_of[j]) comp_has_out[ci] = 1u;
    }
    if (!has_internal || (term_mask && term_mask[i])) comp_has_exit[ci] = 1u;
  }

  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const uint32_t i = static_cast<uint32_t>(reach_order[ri]);
    const int32_t ci = comp_of[i];
    if (ci >= 0 && !comp_has_out[ci] && !comp_has_exit[ci]) {
      non_term_sink[i] = 1u;
    }
  }

  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const uint32_t i = static_cast<uint32_t>(reach_order[ri]);
    const uint32_t sb = succ_off[i];
    const uint32_t se = succ_off[i + 1u];
    bool has_internal = false;
    for (uint32_t e = sb; e < se; ++e) {
      const int32_t j = succ_dst[e];
      if (j < 0 || static_cast<uint32_t>(j) >= n || !reachable[static_cast<uint32_t>(j)]) continue;
      has_internal = true;
      rev_off[static_cast<uint32_t>(j) + 1u]++;
    }
    if (!has_internal || non_term_sink[i] || (term_mask && term_mask[i])) {
      rev_off[n + 1u]++;
    }
  }
  for (uint32_t i = 0; i < np1; ++i) rev_off[i + 1u] += rev_off[i];

  const uint32_t rev_m = rev_off[np1];
  int32_t* rev_dst = rev_m > 0u ? scratch.alloc<int32_t>(rev_m) : nullptr;
  uint32_t* rev_cur = scratch.alloc<uint32_t>(np1);
  if ((rev_m > 0u && !rev_dst) || !rev_cur) return false;
  for (uint32_t i = 0; i < np1; ++i) rev_cur[i] = rev_off[i];

  for (uint32_t ri = 0; ri < reach_count; ++ri) {
    const uint32_t i = static_cast<uint32_t>(reach_order[ri]);
    const uint32_t sb = succ_off[i];
    const uint32_t se = succ_off[i + 1u];
    bool has_internal = false;
    for (uint32_t e = sb; e < se; ++e) {
      const int32_t j = succ_dst[e];
      if (j < 0 || static_cast<uint32_t>(j) >= n || !reachable[static_cast<uint32_t>(j)]) continue;
      has_internal = true;
      rev_dst[rev_cur[static_cast<uint32_t>(j)]++] = static_cast<int32_t>(i);
    }
    if (!has_internal || non_term_sink[i] || (term_mask && term_mask[i])) {
      rev_dst[rev_cur[n]++] = static_cast<int32_t>(i);
    }
  }

  // Build predecessors of reverse graph
  uint32_t* rp_off = arena_alloc_zeroed<uint32_t>(scratch, np1 + 1u);
  int32_t* rp_src = rev_m > 0u ? scratch.alloc<int32_t>(rev_m) : nullptr;
  uint32_t* rp_cur = scratch.alloc<uint32_t>(np1);
  uint8_t* pdom_reach = arena_alloc_zeroed<uint8_t>(scratch, np1);
  int32_t* pdom_order = scratch.alloc<int32_t>(np1);
  if (!rp_off || (rev_m > 0u && !rp_src) || !rp_cur || !pdom_reach || !pdom_order) return false;

  for (uint32_t u = 0; u < np1; ++u) {
    for (uint32_t e = rev_off[u]; e < rev_off[u + 1u]; ++e) {
      rp_off[static_cast<uint32_t>(rev_dst[e]) + 1u]++;
    }
  }
  for (uint32_t u = 0; u < np1; ++u) {
    rp_off[u + 1u] += rp_off[u];
    rp_cur[u] = rp_off[u];
  }
  for (uint32_t u = 0; u < np1; ++u) {
    for (uint32_t e = rev_off[u]; e < rev_off[u + 1u]; ++e) {
      rp_src[rp_cur[static_cast<uint32_t>(rev_dst[e])]++] = static_cast<int32_t>(u);
    }
  }

  uint32_t pdom_rc = 0u;
  if (!compute_reachable_dfs(scratch, np1, rev_off, rev_dst, n, pdom_reach, pdom_order, &pdom_rc)) {
    return false;
  }
  return compute_idom_chk(scratch, np1, rev_off, rev_dst, rp_off, rp_src, pdom_reach, n, out_pdom_idom);
}

void compute_structural_digest(IrFunction& fn) {
  uint64_t lo = kFnvOffsetLo;
  uint64_t hi = kFnvOffsetHi;

  hash_u32_pair(lo, hi, fn.header.entry_block);
  hash_u32_pair(lo, hi, fn.header.block_count);
  hash_u32_pair(lo, hi, fn.header.inst_count);
  hash_u32_pair(lo, hi, fn.header.value_count);
  hash_u32_pair(lo, hi, fn.reachable_count);
  hash_u32_pair(lo, hi, fn.scc_count);

  const uint32_t n = fn.header.block_count;
  for (uint32_t b = 0; b < n; ++b) {
    const IrBlock& blk = fn.blocks[b];
    hash_u32_pair(lo, hi, blk.first_inst);
    hash_u32_pair(lo, hi, blk.inst_count);
    hash_u32_pair(lo, hi, blk.succ_count);
    hash_u32_pair(lo, hi, blk.pred_count);
    hash_u32_pair(lo, hi, blk.idom);
    hash_u32_pair(lo, hi, blk.ipdom);
    hash_u32_pair(lo, hi, blk.scc_id);
    hash_u32_pair(lo, hi, blk.loop_header);
    const uint32_t sb = fn.succ_off[b];
    const uint32_t se = fn.succ_off[b + 1];
    for (uint32_t e = sb; e < se; ++e) {
      hash_u32_pair(lo, hi, static_cast<uint32_t>(fn.succ_dst[e]));
    }
    const uint32_t db = fn.df_off[b];
    const uint32_t de = fn.df_off[b + 1];
    for (uint32_t e = db; e < de; ++e) {
      hash_u32_pair(lo, hi, fn.df_blocks[e]);
    }
  }

  const uint32_t m = fn.header.inst_count;
  for (uint32_t i = 0; i < m; ++i) {
    const IrInst& ins = fn.insts[i];
    hash_u32_pair(lo, hi, (static_cast<uint32_t>(ins.op) << 16) | ins.flags);
    hash_u32_pair(lo, hi, fn.inst_block[i]);
    hash_u32_pair(lo, hi, fn.inst_ssa_dst[i]);
    hash_u32_pair(lo, hi, fn.inst_ssa_arg0[i]);
    hash_u32_pair(lo, hi, fn.inst_ssa_arg1[i]);
    hash_u32_pair(lo, hi, fn.inst_ssa_arg2[i]);
    hash_u64_pair(lo, hi, ins.imm64_or_sym);
  }

  for (size_t p = 0; p < fn.phis.size(); ++p) {
    const IrPhi& phi = fn.phis[p];
    hash_u32_pair(lo, hi, phi.block_id);
    hash_u32_pair(lo, hi, phi.var_id);
    hash_u32_pair(lo, hi, phi.ssa_value_id);
    hash_u32_pair(lo, hi, phi.incoming_count);
    for (uint32_t k = 0; k < phi.incoming_count; ++k) {
      const IrPhiIncoming& inc = fn.phi_incoming[phi.incoming_offset + k];
      hash_u32_pair(lo, hi, inc.pred_block_id);
      hash_u32_pair(lo, hi, inc.ssa_value_id);
    }
  }

  for (size_t v = 0; v < fn.values.size(); ++v) {
    const IrValueDef& def = fn.values[v];
    hash_u32_pair(lo, hi, def.ssa_value_id);
    hash_u32_pair(lo, hi, def.var_id);
    hash_u32_pair(lo, hi, def.def_block);
    hash_u32_pair(lo, hi, def.def_site);
    hash_u32_pair(lo, hi, static_cast<uint32_t>(def.kind));
    hash_u32_pair(lo, hi, fn.use_off[v + 1] - fn.use_off[v]);
  }

  fn.header.digest_lo64 = js::mix64(lo);
  fn.header.digest_hi64 = js::mix64(hi ^ lo);
}

}  // namespace

void IrFunction::init(Arena* arena, uint32_t entry_block) {
  mem_set(&header, 0, sizeof(header));
  header.entry_block = entry_block;
  blocks.init(arena);
  raw_edges.init(arena);
  insts.init(arena);
  inst_block.init(arena);
  block_inst_off.init(arena);
  block_inst_ids.init(arena);
  succ_off.init(arena);
  succ_dst.init(arena);
  pred_off.init(arena);
  pred_src.init(arena);
  reachable_mask.init(arena);
  dom_tin.init(arena);
  dom_tout.init(arena);
  dom_depth.init(arena);
  reachable_count = 0;
  scc_count = 0;
  df_off.init(arena);
  df_blocks.init(arena);
  block_phi_off.init(arena);
  phis.init(arena);
  phi_incoming.init(arena);
  inst_ssa_dst.init(arena);
  inst_ssa_arg0.init(arena);
  inst_ssa_arg1.init(arena);
  inst_ssa_arg2.init(arena);
  values.init(arena);
  use_off.init(arena);
  uses.init(arena);
}

void IrStore::init(Arena* persistent_arena, Arena* scratch_arena) {
  arena_ = persistent_arena;
  scratch_ = scratch_arena ? scratch_arena : persistent_arena;
  active_count_ = 0u;
  initialized_ = (persistent_arena != nullptr);
  for (uint32_t i = 0; i < kMaxSlots; ++i) {
    slots_[i].fn = nullptr;
    slots_[i].generation = 1u;
    slots_[i].in_use = 0u;
    slots_[i].reserved = 0u;
  }
}

void IrStore::reset() {
  for (uint32_t i = 0; i < kMaxSlots; ++i) {
    slots_[i].fn = nullptr;
    slots_[i].in_use = 0u;
    slots_[i].generation = (slots_[i].generation == 255u) ? 1u : static_cast<uint8_t>(slots_[i].generation + 1u);
  }
  active_count_ = 0u;
  if (arena_) arena_->reset();
  if (scratch_ && scratch_ != arena_) scratch_->reset();
}

const IrFunction* IrStore::lookup(HexIrHandle handle) const {
  if (!initialized_ || handle == 0u) return nullptr;
  const uint32_t slot = handle_slot(handle);
  const uint8_t gen = handle_gen(handle);
  if (gen == 0u || slot >= kMaxSlots) return nullptr;
  const Slot& s = slots_[slot];
  if (!s.in_use || s.generation != gen || !s.fn) return nullptr;
  return s.fn;
}

IrFunction* IrStore::lookup_mut(HexIrHandle handle) {
  return const_cast<IrFunction*>(lookup(handle));
}

bool IrStore::dominates(const IrFunction& fn, uint32_t ancestor, uint32_t descendant) const {
  return is_dom(fn, ancestor, descendant);
}

HexStatus IrStore::create(uint32_t entry_block, HexIrHandle* out_handle) {
  if (!out_handle) return HEX_ERR_INVALID_ARG;
  *out_handle = 0u;
  if (!initialized_ || !arena_) return HEX_ERR_OOM;

  uint32_t free_slot = kNone;
  for (uint32_t i = 0; i < kMaxSlots; ++i) {
    if (!slots_[i].in_use) {
      free_slot = i;
      break;
    }
  }
  if (free_slot == kNone) return HEX_ERR_RESOURCE_LIMIT;

  IrFunction* fn = arena_->alloc<IrFunction>(1);
  if (!fn) return HEX_ERR_OOM;
  fn->init(arena_, entry_block);

  Slot& s = slots_[free_slot];
  if (s.generation == 0u) s.generation = 1u;
  s.fn = fn;
  s.in_use = 1u;
  ++active_count_;
  *out_handle = make_handle(free_slot, s.generation);
  return HEX_OK;
}

HexStatus IrStore::release(HexIrHandle handle) {
  if (!initialized_ || handle == 0u) return HEX_ERR_INVALID_ARG;
  const uint32_t slot = handle_slot(handle);
  const uint8_t gen = handle_gen(handle);
  if (gen == 0u || slot >= kMaxSlots) return HEX_ERR_INVALID_ARG;
  Slot& s = slots_[slot];
  if (!s.in_use || s.generation != gen) return HEX_ERR_INVALID_ARG;
  s.fn = nullptr;
  s.in_use = 0u;
  s.generation = (s.generation == 255u) ? 1u : static_cast<uint8_t>(s.generation + 1u);
  if (active_count_ > 0u) --active_count_;
  if (active_count_ == 0u) {
    if (arena_) arena_->reset();
  }
  return HEX_OK;
}

HexStatus IrStore::add_block(HexIrHandle handle, uint32_t* out_block_id) {
  IrFunction* fn = lookup_mut(handle);
  if (!fn) return HEX_ERR_INVALID_ARG;
  if (fn->blocks.size() >= kMaxBlocks) return HEX_ERR_RESOURCE_LIMIT;

  IrBlock blk{};
  blk.first_inst = 0u;
  blk.inst_count = 0u;
  blk.succ_offset = 0u;
  blk.succ_count = 0u;
  blk.pred_offset = 0u;
  blk.pred_count = 0u;
  blk.idom = kNone;
  blk.ipdom = kNone;
  blk.scc_id = kNone;
  blk.loop_header = kNone;

  const uint32_t id = static_cast<uint32_t>(fn->blocks.size());
  if (!fn->blocks.push_back(blk)) return HEX_ERR_OOM;
  fn->header.block_count = static_cast<uint32_t>(fn->blocks.size());
  fn->header.cfg_ready = 0u;
  fn->header.ssa_ready = 0u;
  if (out_block_id) *out_block_id = id;
  return HEX_OK;
}

HexStatus IrStore::add_edge(HexIrHandle handle, uint32_t from_block, uint32_t to_block) {
  IrFunction* fn = lookup_mut(handle);
  if (!fn) return HEX_ERR_INVALID_ARG;
  if (from_block >= fn->blocks.size() || to_block >= fn->blocks.size()) {
    return HEX_ERR_INVALID_ARG;
  }
  if (fn->raw_edges.size() >= kMaxEdges) return HEX_ERR_RESOURCE_LIMIT;

  IrEdge edge{from_block, to_block};
  if (!fn->raw_edges.push_back(edge)) return HEX_ERR_OOM;
  fn->header.cfg_ready = 0u;
  fn->header.ssa_ready = 0u;
  return HEX_OK;
}

HexStatus IrStore::add_inst(
    HexIrHandle handle,
    uint32_t block_id,
    uint16_t op,
    uint16_t flags,
    uint32_t dst_val,
    uint32_t arg0,
    uint32_t arg1,
    uint32_t arg2,
    uint64_t imm64_or_sym,
    uint32_t* out_inst_id) {
  IrFunction* fn = lookup_mut(handle);
  if (!fn) return HEX_ERR_INVALID_ARG;
  if (block_id >= fn->blocks.size()) return HEX_ERR_INVALID_ARG;
  if (fn->insts.size() >= kMaxInsts) return HEX_ERR_RESOURCE_LIMIT;

  IrInst inst{};
  inst.op = op;
  inst.flags = flags;
  inst.dst_val = dst_val;
  inst.arg0 = arg0;
  inst.arg1 = arg1;
  inst.arg2 = arg2;
  inst.aux_offset = kNone;
  inst.origin_idx = static_cast<uint32_t>(fn->insts.size());
  inst.imm64_or_sym = imm64_or_sym;

  const uint32_t inst_id = static_cast<uint32_t>(fn->insts.size());
  if (!fn->insts.push_back(inst)) return HEX_ERR_OOM;
  if (!fn->inst_block.push_back(block_id)) {
    fn->insts.pop_back();
    return HEX_ERR_OOM;
  }
  fn->header.inst_count = static_cast<uint32_t>(fn->insts.size());
  fn->header.ssa_ready = 0u;
  if (out_inst_id) *out_inst_id = inst_id;
  return HEX_OK;
}

HexStatus IrStore::get_stats(HexIrHandle handle, HexIrStats* out_stats) const {
  if (!out_stats) return HEX_ERR_INVALID_ARG;
  const IrFunction* fn = lookup(handle);
  if (!fn) return HEX_ERR_INVALID_ARG;

  out_stats->block_count = fn->header.block_count;
  out_stats->edge_count = fn->header.cfg_ready
                              ? static_cast<uint32_t>(fn->succ_dst.size())
                              : static_cast<uint32_t>(fn->raw_edges.size());
  out_stats->inst_count = fn->header.inst_count;
  out_stats->value_count = fn->header.value_count;
  out_stats->phi_count = static_cast<uint32_t>(fn->phis.size());
  out_stats->use_count = static_cast<uint32_t>(fn->uses.size());
  out_stats->reachable_block_count = fn->reachable_count;
  out_stats->scc_count = fn->scc_count;
  out_stats->cfg_ready = fn->header.cfg_ready;
  out_stats->ssa_ready = fn->header.ssa_ready;
  out_stats->memssa_ready = fn->header.memssa_ready;
  out_stats->reserved = 0u;
  out_stats->digest_lo64 = fn->header.digest_lo64;
  out_stats->digest_hi64 = fn->header.digest_hi64;
  return HEX_OK;
}

HexStatus IrStore::run_cfg_and_ssa(HexIrHandle handle) {
  IrFunction* fn = lookup_mut(handle);
  if (!fn || !arena_ || !scratch_) return HEX_ERR_INVALID_ARG;

  const uint32_t n = fn->header.block_count;
  const uint32_t inst_count = fn->header.inst_count;
  if (n > 0 && fn->header.entry_block >= n) return HEX_ERR_INVALID_ARG;

  // Reset derived tables for idempotent re-execution.
  fn->header.cfg_ready = 0u;
  fn->header.ssa_ready = 0u;
  fn->header.value_count = 0u;
  fn->header.digest_lo64 = 0ULL;
  fn->header.digest_hi64 = 0ULL;
  fn->reachable_count = 0u;
  fn->scc_count = 0u;

  fn->block_inst_off.clear();
  fn->block_inst_ids.clear();
  fn->succ_off.clear();
  fn->succ_dst.clear();
  fn->pred_off.clear();
  fn->pred_src.clear();
  fn->reachable_mask.clear();
  fn->dom_tin.clear();
  fn->dom_tout.clear();
  fn->dom_depth.clear();
  fn->df_off.clear();
  fn->df_blocks.clear();
  fn->block_phi_off.clear();
  fn->phis.clear();
  fn->phi_incoming.clear();
  fn->inst_ssa_dst.clear();
  fn->inst_ssa_arg0.clear();
  fn->inst_ssa_arg1.clear();
  fn->inst_ssa_arg2.clear();
  fn->values.clear();
  fn->use_off.clear();
  fn->uses.clear();

  if (n == 0u) {
    if (!fn->block_inst_off.resize(1, 0u)) return HEX_ERR_OOM;
    if (!fn->succ_off.resize(1, 0u)) return HEX_ERR_OOM;
    if (!fn->pred_off.resize(1, 0u)) return HEX_ERR_OOM;
    if (!fn->df_off.resize(1, 0u)) return HEX_ERR_OOM;
    if (!fn->block_phi_off.resize(1, 0u)) return HEX_ERR_OOM;
    if (!fn->use_off.resize(1, 0u)) return HEX_ERR_OOM;
    fn->header.cfg_ready = 1u;
    fn->header.ssa_ready = 1u;
    compute_structural_digest(*fn);
    return HEX_OK;
  }

  Arena* scratch = scratch_;
  const bool separate_scratch = (scratch != arena_);

  // -------------------------------------------------------------------------
  // Phase 1: Build per-block instruction CSR & canonical CSR CFG + CFG analysis
  // -------------------------------------------------------------------------
  if (!fn->block_inst_off.resize(n + 1, 0u)) return HEX_ERR_OOM;
  if (inst_count > 0 && !fn->block_inst_ids.resize(inst_count, 0u)) return HEX_ERR_OOM;
  if (!fn->succ_off.resize(n + 1, 0u)) return HEX_ERR_OOM;
  if (!fn->pred_off.resize(n + 1, 0u)) return HEX_ERR_OOM;
  if (!fn->succ_dst.reserve(fn->raw_edges.size())) return HEX_ERR_OOM;
  if (!fn->pred_src.reserve(fn->raw_edges.size())) return HEX_ERR_OOM;
  if (!fn->reachable_mask.resize(n, 0u)) return HEX_ERR_OOM;
  if (!fn->dom_tin.resize(n, -1)) return HEX_ERR_OOM;
  if (!fn->dom_tout.resize(n, -1)) return HEX_ERR_OOM;
  if (!fn->dom_depth.resize(n, 0)) return HEX_ERR_OOM;
  if (!fn->df_off.resize(n + 1, 0u)) return HEX_ERR_OOM;
  if (!fn->block_phi_off.resize(n + 1, 0u)) return HEX_ERR_OOM;
  if (inst_count > 0) {
    if (!fn->inst_ssa_dst.resize(inst_count, kNone)) return HEX_ERR_OOM;
    if (!fn->inst_ssa_arg0.resize(inst_count, kNone)) return HEX_ERR_OOM;
    if (!fn->inst_ssa_arg1.resize(inst_count, kNone)) return HEX_ERR_OOM;
    if (!fn->inst_ssa_arg2.resize(inst_count, kNone)) return HEX_ERR_OOM;
  }

  for (uint32_t i = 0; i < inst_count; ++i) {
    fn->block_inst_off[fn->inst_block[i] + 1]++;
  }
  for (uint32_t b = 0; b < n; ++b) {
    fn->block_inst_off[b + 1] += fn->block_inst_off[b];
    fn->blocks[b].first_inst = fn->block_inst_off[b];
    fn->blocks[b].inst_count = fn->block_inst_off[b + 1] - fn->block_inst_off[b];
  }

  {
    ArenaScope cfg_scope(*scratch);

    uint32_t* inst_cur = scratch->alloc<uint32_t>(n);
    uint8_t* term_mask = arena_alloc_zeroed<uint8_t>(*scratch, n);
    if (!inst_cur || !term_mask) return HEX_ERR_OOM;
    for (uint32_t b = 0; b < n; ++b) inst_cur[b] = fn->block_inst_off[b];
    for (uint32_t i = 0; i < inst_count; ++i) {
      const uint32_t b = fn->inst_block[i];
      fn->block_inst_ids[inst_cur[b]++] = i;
      if (fn->insts[i].op == HEX_IR_OP_RET) term_mask[b] = 1u;
    }

    const size_t raw_m = fn->raw_edges.size();
    IrEdge* sorted_edges = raw_m > 0 ? scratch->alloc<IrEdge>(raw_m) : nullptr;
    if (raw_m > 0 && !sorted_edges) return HEX_ERR_OOM;
    if (raw_m > 0) {
      mem_copy(sorted_edges, fn->raw_edges.data(), raw_m * sizeof(IrEdge));
      if (!stable_sort(*scratch, sorted_edges, raw_m, [](const IrEdge& a, const IrEdge& b) {
            if (a.from != b.from) return a.from < b.from;
            return a.to < b.to;
          })) {
        return HEX_ERR_OOM;
      }
    }

    size_t unique_m = 0;
    for (size_t e = 0; e < raw_m; ++e) {
      if (unique_m > 0 &&
          sorted_edges[e].from == sorted_edges[unique_m - 1].from &&
          sorted_edges[e].to == sorted_edges[unique_m - 1].to) {
        continue;
      }
      sorted_edges[unique_m++] = sorted_edges[e];
    }

    for (size_t e = 0; e < unique_m; ++e) {
      fn->succ_off[sorted_edges[e].from + 1]++;
      fn->pred_off[sorted_edges[e].to + 1]++;
    }
    for (uint32_t b = 0; b < n; ++b) {
      fn->succ_off[b + 1] += fn->succ_off[b];
      fn->pred_off[b + 1] += fn->pred_off[b];
      fn->blocks[b].succ_offset = fn->succ_off[b];
      fn->blocks[b].succ_count = fn->succ_off[b + 1] - fn->succ_off[b];
      fn->blocks[b].pred_offset = fn->pred_off[b];
      fn->blocks[b].pred_count = fn->pred_off[b + 1] - fn->pred_off[b];
    }

    if (unique_m > 0) {
      if (!fn->succ_dst.resize(unique_m, 0)) return HEX_ERR_OOM;
      if (!fn->pred_src.resize(unique_m, 0)) return HEX_ERR_OOM;
      uint32_t* s_cur = scratch->alloc<uint32_t>(n);
      uint32_t* p_cur = scratch->alloc<uint32_t>(n);
      if (!s_cur || !p_cur) return HEX_ERR_OOM;
      for (uint32_t b = 0; b < n; ++b) {
        s_cur[b] = fn->succ_off[b];
        p_cur[b] = fn->pred_off[b];
      }
      for (size_t e = 0; e < unique_m; ++e) {
        const uint32_t u = sorted_edges[e].from;
        const uint32_t v = sorted_edges[e].to;
        fn->succ_dst[s_cur[u]++] = static_cast<int32_t>(v);
        fn->pred_src[p_cur[v]++] = static_cast<int32_t>(u);
      }
    }

    // Self-contained CFG analysis (reachability, idom, Euler tour, SCC, post-dom).
    int32_t* reach_order = scratch->alloc<int32_t>(n);
    int32_t* idom_arr = scratch->alloc<int32_t>(n);
    int32_t* comp_of = scratch->alloc<int32_t>(n);
    int32_t* pdom_idom = scratch->alloc<int32_t>(n + 1u);
    if (!reach_order || !idom_arr || !comp_of || !pdom_idom) return HEX_ERR_OOM;

    uint32_t reach_count = 0u;
    if (!compute_reachable_dfs(
            *scratch, n, fn->succ_off.data(),
            unique_m > 0 ? fn->succ_dst.data() : nullptr,
            fn->header.entry_block, fn->reachable_mask.data(), reach_order, &reach_count)) {
      return HEX_ERR_OOM;
    }
    if (!compute_idom_chk(
            *scratch, n, fn->succ_off.data(),
            unique_m > 0 ? fn->succ_dst.data() : nullptr,
            fn->pred_off.data(),
            unique_m > 0 ? fn->pred_src.data() : nullptr,
            fn->reachable_mask.data(), fn->header.entry_block, idom_arr)) {
      return HEX_ERR_OOM;
    }
    if (!compute_dom_euler(
            *scratch, n, idom_arr, fn->reachable_mask.data(),
            fn->dom_tin.data(), fn->dom_tout.data(), fn->dom_depth.data())) {
      return HEX_ERR_OOM;
    }
    uint32_t num_comp = 0u;
    if (!compute_scc_kosaraju(
            *scratch, n, fn->succ_off.data(),
            unique_m > 0 ? fn->succ_dst.data() : nullptr,
            fn->pred_off.data(),
            unique_m > 0 ? fn->pred_src.data() : nullptr,
            reach_order, reach_count, fn->reachable_mask.data(), comp_of, &num_comp)) {
      return HEX_ERR_OOM;
    }
    if (!compute_postdom_idom(
            *scratch, n, fn->succ_off.data(),
            unique_m > 0 ? fn->succ_dst.data() : nullptr,
            reach_order, reach_count, fn->reachable_mask.data(),
            comp_of, num_comp, term_mask, pdom_idom)) {
      return HEX_ERR_OOM;
    }

    fn->reachable_count = reach_count;
    fn->scc_count = num_comp;
    for (uint32_t b = 0; b < n; ++b) {
      fn->blocks[b].idom = idom_arr[b] >= 0 ? static_cast<uint32_t>(idom_arr[b]) : kNone;
      fn->blocks[b].ipdom = (pdom_idom[b] >= 0 && static_cast<uint32_t>(pdom_idom[b]) < n)
                                ? static_cast<uint32_t>(pdom_idom[b])
                                : kNone;
      fn->blocks[b].scc_id = comp_of[b] >= 0 ? static_cast<uint32_t>(comp_of[b]) : kNone;
      fn->blocks[b].loop_header = kNone;
    }

    // Non-recursive natural loop header detection (bounded strictly to dominated body).
    uint32_t* loop_stamp = arena_alloc_zeroed<uint32_t>(*scratch, n);
    uint32_t* loop_stack = scratch->alloc<uint32_t>(n);
    if (!loop_stamp || !loop_stack) return HEX_ERR_OOM;
    uint32_t cur_stamp = 0u;

    for (uint32_t u = 0; u < n; ++u) {
      if (!fn->reachable_mask[u]) continue;
      const uint32_t sb = fn->succ_off[u];
      const uint32_t se = fn->succ_off[u + 1];
      for (uint32_t e = sb; e < se; ++e) {
        const uint32_t h = static_cast<uint32_t>(fn->succ_dst[e]);
        if (!is_dom(*fn, h, u)) continue;

        ++cur_stamp;
        auto mark_loop_node = [&](uint32_t node) {
          const uint32_t prev = fn->blocks[node].loop_header;
          if (prev == kNone || fn->dom_depth[h] > fn->dom_depth[prev]) {
            fn->blocks[node].loop_header = h;
          }
        };

        loop_stamp[h] = cur_stamp;
        mark_loop_node(h);
        uint32_t sp = 0u;
        if (u != h) {
          loop_stamp[u] = cur_stamp;
          mark_loop_node(u);
          loop_stack[sp++] = u;
        }
        while (sp > 0u) {
          const uint32_t x = loop_stack[--sp];
          const uint32_t pb = fn->pred_off[x];
          const uint32_t pe = fn->pred_off[x + 1];
          for (uint32_t pei = pb; pei < pe; ++pei) {
            const uint32_t p = static_cast<uint32_t>(fn->pred_src[pei]);
            if (!fn->reachable_mask[p] || loop_stamp[p] == cur_stamp) continue;
            if (!is_dom(*fn, h, p)) continue;
            loop_stamp[p] = cur_stamp;
            mark_loop_node(p);
            if (p != h) loop_stack[sp++] = p;
          }
        }
      }
    }

    // Phase 2 (Pass 1): Count Dominator Frontier entries per block.
    uint32_t* df_seen = arena_alloc_zeroed<uint32_t>(*scratch, n);
    if (!df_seen) return HEX_ERR_OOM;

    for (uint32_t b = 0; b < n; ++b) {
      if (!fn->reachable_mask[b]) continue;
      const uint32_t pb = fn->pred_off[b];
      const uint32_t pe = fn->pred_off[b + 1];
      uint32_t reach_preds = 0u;
      for (uint32_t e = pb; e < pe; ++e) {
        if (fn->reachable_mask[static_cast<uint32_t>(fn->pred_src[e])]) ++reach_preds;
      }
      if (reach_preds == 0u || (reach_preds < 2u && b != fn->header.entry_block)) continue;

      const uint32_t target_idom = fn->blocks[b].idom;
      const uint32_t mark = b + 1u;
      for (uint32_t e = pb; e < pe; ++e) {
        uint32_t runner = static_cast<uint32_t>(fn->pred_src[e]);
        if (!fn->reachable_mask[runner]) continue;
        uint32_t guard = n + 2u;
        while (runner != kNone && runner != target_idom && guard-- > 0u) {
          if (df_seen[runner] != mark) {
            df_seen[runner] = mark;
            fn->df_off[runner + 1]++;
          }
          runner = fn->blocks[runner].idom;
        }
      }
    }
    for (uint32_t b = 0; b < n; ++b) fn->df_off[b + 1] += fn->df_off[b];
  }

  // Phase 2 (Pass 2): Populate Dominator Frontier CSR (sorted ascending per block).
  const uint32_t total_df = fn->df_off[n];
  if (total_df > 0u && !fn->df_blocks.resize(total_df, 0u)) return HEX_ERR_OOM;
  if (total_df > 0u) {
    ArenaScope df_scope(*scratch);
    uint32_t* df_seen = arena_alloc_zeroed<uint32_t>(*scratch, n);
    uint32_t* df_cur = scratch->alloc<uint32_t>(n);
    if (!df_seen || !df_cur) return HEX_ERR_OOM;
    for (uint32_t b = 0; b < n; ++b) df_cur[b] = fn->df_off[b];

    for (uint32_t b = 0; b < n; ++b) {
      if (!fn->reachable_mask[b]) continue;
      const uint32_t pb = fn->pred_off[b];
      const uint32_t pe = fn->pred_off[b + 1];
      uint32_t reach_preds = 0u;
      for (uint32_t e = pb; e < pe; ++e) {
        if (fn->reachable_mask[static_cast<uint32_t>(fn->pred_src[e])]) ++reach_preds;
      }
      if (reach_preds == 0u || (reach_preds < 2u && b != fn->header.entry_block)) continue;

      const uint32_t target_idom = fn->blocks[b].idom;
      const uint32_t mark = b + 1u;
      for (uint32_t e = pb; e < pe; ++e) {
        uint32_t runner = static_cast<uint32_t>(fn->pred_src[e]);
        if (!fn->reachable_mask[runner]) continue;
        uint32_t guard = n + 2u;
        while (runner != kNone && runner != target_idom && guard-- > 0u) {
          if (df_seen[runner] != mark) {
            df_seen[runner] = mark;
            fn->df_blocks[df_cur[runner]++] = b;
          }
          runner = fn->blocks[runner].idom;
        }
      }
    }
  }

  fn->header.cfg_ready = 1u;

  // -------------------------------------------------------------------------
  // Phase 3-5: All temporaries on scratch_ with O(1) ScratchGuard reclamation
  // -------------------------------------------------------------------------
  const size_t scratch_mark = scratch->used();
  struct ScratchGuard {
    Arena* arena;
    size_t mark;
    bool active;
    ~ScratchGuard() {
      if (active && arena) arena->restore(mark);
    }
  } ssa_scratch_guard{scratch, scratch_mark, separate_scratch};

  // Phase 3: Variable collection (OrderedSet) -> ascending var_id sort -> Worklist PHI Placement
  OrderedSet<uint32_t> var_set(scratch);
  for (uint32_t b = 0; b < n; ++b) {
    const uint32_t ib = fn->block_inst_off[b];
    const uint32_t ie = fn->block_inst_off[b + 1];
    for (uint32_t idx = ib; idx < ie; ++idx) {
      const IrInst& ins = fn->insts[fn->block_inst_ids[idx]];
      if (ins.dst_val != kNone && !var_set.add(ins.dst_val)) return HEX_ERR_OOM;
      if (ins.arg0 != kNone && !var_set.add(ins.arg0)) return HEX_ERR_OOM;
      if (ins.arg1 != kNone && !var_set.add(ins.arg1)) return HEX_ERR_OOM;
      if (ins.arg2 != kNone && !var_set.add(ins.arg2)) return HEX_ERR_OOM;
    }
  }

  const uint32_t var_count = var_set.size();
  if (var_count == 0u) {
    if (!fn->use_off.resize(1, 0u)) return HEX_ERR_OOM;
    fn->header.ssa_ready = 1u;
    compute_structural_digest(*fn);
    return HEX_OK;
  }

  Vec<uint32_t> dense_to_var(scratch);
  OrderedMap<uint32_t, uint32_t> var_to_dense(scratch);
  if (!dense_to_var.reserve(var_count) || !var_to_dense.reserve(var_count)) {
    return HEX_ERR_OOM;
  }
  for (auto it = var_set.begin(); it != var_set.end(); ++it) {
    if (!dense_to_var.push_back(*it)) return HEX_ERR_OOM;
  }
  if (!stable_sort(*scratch, dense_to_var.data(), var_count, [](uint32_t a, uint32_t b) {
        return a < b;
      })) {
    return HEX_ERR_OOM;
  }
  for (uint32_t dense = 0; dense < var_count; ++dense) {
    if (!var_to_dense.set(dense_to_var[dense], dense)) return HEX_ERR_OOM;
  }

  Vec<uint32_t> def_off(scratch);
  if (!def_off.resize(var_count + 1, 0u)) return HEX_ERR_OOM;
  uint32_t* var_last_def_block = scratch->alloc<uint32_t>(var_count);
  if (!var_last_def_block) return HEX_ERR_OOM;
  for (uint32_t v = 0; v < var_count; ++v) var_last_def_block[v] = kNone;

  for (uint32_t b = 0; b < n; ++b) {
    if (!fn->reachable_mask[b]) continue;
    const uint32_t ib = fn->block_inst_off[b];
    const uint32_t ie = fn->block_inst_off[b + 1];
    for (uint32_t idx = ib; idx < ie; ++idx) {
      const uint32_t dst = fn->insts[fn->block_inst_ids[idx]].dst_val;
      if (dst == kNone) continue;
      const uint32_t* dv = var_to_dense.find(dst);
      if (!dv) return HEX_ERR_INTERNAL;
      if (var_last_def_block[*dv] != b) {
        var_last_def_block[*dv] = b;
        def_off[*dv + 1]++;
      }
    }
  }
  for (uint32_t v = 0; v < var_count; ++v) def_off[v + 1] += def_off[v];

  const uint32_t total_def_blocks = def_off[var_count];
  Vec<uint32_t> def_blocks(scratch);
  if (total_def_blocks > 0u && !def_blocks.resize(total_def_blocks, 0u)) return HEX_ERR_OOM;
  uint32_t* def_cur = scratch->alloc<uint32_t>(var_count);
  if (!def_cur) return HEX_ERR_OOM;
  for (uint32_t v = 0; v < var_count; ++v) {
    def_cur[v] = def_off[v];
    var_last_def_block[v] = kNone;
  }
  for (uint32_t b = 0; b < n; ++b) {
    if (!fn->reachable_mask[b]) continue;
    const uint32_t ib = fn->block_inst_off[b];
    const uint32_t ie = fn->block_inst_off[b + 1];
    for (uint32_t idx = ib; idx < ie; ++idx) {
      const uint32_t dst = fn->insts[fn->block_inst_ids[idx]].dst_val;
      if (dst == kNone) continue;
      const uint32_t dv = *var_to_dense.find(dst);
      if (var_last_def_block[dv] != b) {
        var_last_def_block[dv] = b;
        def_blocks[def_cur[dv]++] = b;
      }
    }
  }

  uint32_t* is_def_stamp = arena_alloc_zeroed<uint32_t>(*scratch, n);
  uint32_t* queued_stamp = arena_alloc_zeroed<uint32_t>(*scratch, n);
  uint32_t* has_phi_stamp = arena_alloc_zeroed<uint32_t>(*scratch, n);
  if (!is_def_stamp || !queued_stamp || !has_phi_stamp) return HEX_ERR_OOM;

  Vec<uint32_t> work_heap(scratch);
  Vec<PhiPlacement> placements(scratch);
  for (uint32_t v = 0; v < var_count; ++v) {
    const uint32_t stamp = v + 1u;
    work_heap.clear();
    const uint32_t db = def_off[v];
    const uint32_t de = def_off[v + 1];
    for (uint32_t i = db; i < de; ++i) {
      const uint32_t b = def_blocks[i];
      is_def_stamp[b] = stamp;
      queued_stamp[b] = stamp;
      if (!heap_push_min(work_heap, b)) return HEX_ERR_OOM;
    }
    while (!work_heap.empty()) {
      const uint32_t b = heap_pop_min(work_heap);
      const uint32_t fb = fn->df_off[b];
      const uint32_t fe = fn->df_off[b + 1];
      for (uint32_t fi = fb; fi < fe; ++fi) {
        const uint32_t f = fn->df_blocks[fi];
        if (!fn->reachable_mask[f] || has_phi_stamp[f] == stamp) continue;
        has_phi_stamp[f] = stamp;
        if (placements.size() >= kMaxPhis) return HEX_ERR_RESOURCE_LIMIT;
        if (!placements.push_back(PhiPlacement{f, v})) return HEX_ERR_OOM;
        fn->block_phi_off[f + 1]++;
        if (is_def_stamp[f] != stamp && queued_stamp[f] != stamp) {
          queued_stamp[f] = stamp;
          if (!heap_push_min(work_heap, f)) return HEX_ERR_OOM;
        }
      }
    }
  }

  for (uint32_t b = 0; b < n; ++b) fn->block_phi_off[b + 1] += fn->block_phi_off[b];
  const uint32_t phi_count = fn->block_phi_off[n];
  if (phi_count > 0u && !fn->phis.resize(phi_count, IrPhi{})) return HEX_ERR_OOM;

  uint32_t* phi_cur = scratch->alloc<uint32_t>(n);
  if (!phi_cur) return HEX_ERR_OOM;
  for (uint32_t b = 0; b < n; ++b) phi_cur[b] = fn->block_phi_off[b];

  // Placements are in ascending var_id order -> per-block PHIs are strictly ascending by var_id.
  for (size_t i = 0; i < placements.size(); ++i) {
    const uint32_t b = placements[i].block_id;
    const uint32_t dv = placements[i].dense_var;
    const uint32_t p_idx = phi_cur[b]++;
    IrPhi& phi = fn->phis[p_idx];
    phi.block_id = b;
    phi.var_id = dense_to_var[dv];
    phi.ssa_value_id = kNone;
    phi.incoming_offset = 0u;
    phi.incoming_count = 0u;
  }

  // Pre-compute incoming slots with 32-bit overflow & resource-limit guard.
  uint32_t total_phi_incoming = 0u;
  uint32_t* phi_in_cur = phi_count > 0u ? scratch->alloc<uint32_t>(phi_count) : nullptr;
  if (phi_count > 0u && !phi_in_cur) return HEX_ERR_OOM;
  for (uint32_t p = 0; p < phi_count; ++p) {
    const uint32_t b = fn->phis[p].block_id;
    uint32_t expected = fn->blocks[b].pred_count;
    if (b == fn->header.entry_block && expected > 0u) {
      if (expected == UINT32_MAX) return HEX_ERR_RESOURCE_LIMIT;
      ++expected;
    }
    if (expected > UINT32_MAX - total_phi_incoming ||
        total_phi_incoming + expected > kMaxPhiIncoming) {
      return HEX_ERR_RESOURCE_LIMIT;
    }
    fn->phis[p].incoming_offset = total_phi_incoming;
    fn->phis[p].incoming_count = 0u;
    phi_in_cur[p] = total_phi_incoming;
    total_phi_incoming += expected;
  }
  if (total_phi_incoming > 0u && !fn->phi_incoming.resize(total_phi_incoming, IrPhiIncoming{kNone, kNone})) {
    return HEX_ERR_OOM;
  }

  // -------------------------------------------------------------------------
  // Phase 4: Non-Recursive Cytron SSA Renaming & Def-Use Recording
  // -------------------------------------------------------------------------
  auto alloc_value = [&](uint32_t var_id, uint32_t def_block, uint32_t def_site, HexIrValueKind kind, uint32_t* out_id) -> bool {
    const uint32_t id = static_cast<uint32_t>(fn->values.size());
    IrValueDef def{};
    def.ssa_value_id = id;
    def.var_id = var_id;
    def.def_block = def_block;
    def.def_site = def_site;
    def.kind = static_cast<uint8_t>(kind);
    def.reserved0 = 0u;
    def.reserved1 = 0u;
    if (!fn->values.push_back(def)) return false;
    *out_id = id;
    return true;
  };

  Vec<RawUse> raw_uses(scratch);
  auto record_use = [&](uint32_t ssa_val, uint32_t user_idx, HexIrUserKind kind, uint8_t slot) -> HexStatus {
    if (ssa_val == kNone) return HEX_OK;
    if (raw_uses.size() >= kMaxUses) return HEX_ERR_RESOURCE_LIMIT;
    RawUse u{ssa_val, user_idx, static_cast<uint8_t>(kind), slot, 0u};
    return raw_uses.push_back(u) ? HEX_OK : HEX_ERR_OOM;
  };

  Vec<StackNode> stack_pool(scratch);
  Vec<uint32_t> var_stack_top(scratch);
  Vec<uint32_t> seed_vals(scratch);
  if (!var_stack_top.resize(var_count, kNone)) return HEX_ERR_OOM;
  if (!seed_vals.resize(var_count, kNone)) return HEX_ERR_OOM;

  for (uint32_t v = 0; v < var_count; ++v) {
    uint32_t sid = kNone;
    if (!alloc_value(dense_to_var[v], fn->header.entry_block, kNone, HEX_IR_VAL_ENTRY, &sid)) {
      return HEX_ERR_OOM;
    }
    seed_vals[v] = sid;
    if (!push_var_stack(stack_pool, var_stack_top, v, sid)) return HEX_ERR_OOM;
  }

  uint32_t* dom_child_off = arena_alloc_zeroed<uint32_t>(*scratch, n + 1);
  uint32_t* dom_child_list = scratch->alloc<uint32_t>(n);
  uint32_t* dom_child_cur = scratch->alloc<uint32_t>(n);
  if (!dom_child_off || !dom_child_list || !dom_child_cur) return HEX_ERR_OOM;
  for (uint32_t b = 0; b < n; ++b) {
    if (!fn->reachable_mask[b]) continue;
    const uint32_t idom = fn->blocks[b].idom;
    if (idom != kNone && idom < n) dom_child_off[idom + 1]++;
  }
  for (uint32_t b = 0; b < n; ++b) dom_child_off[b + 1] += dom_child_off[b];
  for (uint32_t b = 0; b < n; ++b) dom_child_cur[b] = dom_child_off[b];
  for (uint32_t b = 0; b < n; ++b) {
    if (!fn->reachable_mask[b]) continue;
    const uint32_t idom = fn->blocks[b].idom;
    if (idom != kNone && idom < n) dom_child_list[dom_child_cur[idom]++] = b;
  }

  const uint32_t entry_b = fn->header.entry_block;
  if (fn->blocks[entry_b].pred_count > 0u) {
    const uint32_t pb = fn->block_phi_off[entry_b];
    const uint32_t pe = fn->block_phi_off[entry_b + 1];
    for (uint32_t p = pb; p < pe; ++p) {
      const uint32_t dv = *var_to_dense.find(fn->phis[p].var_id);
      const uint32_t sv = seed_vals[dv];
      fn->phis[p].incoming_count++;
      if (phi_in_cur[p] >= fn->phi_incoming.size()) return HEX_ERR_INTERNAL;
      fn->phi_incoming[phi_in_cur[p]++] = IrPhiIncoming{kNone, sv};
    }
  }

  Vec<RenameFrame> frames(scratch);
  Vec<uint32_t> pushed_vars(scratch);
  if (fn->reachable_mask[entry_b]) {
    if (!frames.push_back(RenameFrame{entry_b, dom_child_off[entry_b], 0u, 0u, 0u, 0u, 0u})) {
      return HEX_ERR_OOM;
    }
  }

  while (!frames.empty()) {
    RenameFrame& frame = frames.back();
    const uint32_t b = frame.block_id;
    if (!frame.entered) {
      frame.entered = 1u;
      frame.pushed_start = static_cast<uint32_t>(pushed_vars.size());

      const uint32_t pb = fn->block_phi_off[b];
      const uint32_t pe = fn->block_phi_off[b + 1];
      for (uint32_t p = pb; p < pe; ++p) {
        const uint32_t dv = *var_to_dense.find(fn->phis[p].var_id);
        uint32_t val_id = kNone;
        if (!alloc_value(fn->phis[p].var_id, b, p, HEX_IR_VAL_PHI, &val_id)) return HEX_ERR_OOM;
        fn->phis[p].ssa_value_id = val_id;
        if (!push_var_stack(stack_pool, var_stack_top, dv, val_id)) return HEX_ERR_OOM;
        if (!pushed_vars.push_back(dv)) return HEX_ERR_OOM;
      }

      const uint32_t ib = fn->block_inst_off[b];
      const uint32_t ie = fn->block_inst_off[b + 1];
      for (uint32_t idx = ib; idx < ie; ++idx) {
        const uint32_t inst_id = fn->block_inst_ids[idx];
        const IrInst& ins = fn->insts[inst_id];

        if (ins.arg0 != kNone) {
          const uint32_t dv = *var_to_dense.find(ins.arg0);
          const uint32_t cur = peek_var_stack(stack_pool, var_stack_top, dv);
          fn->inst_ssa_arg0[inst_id] = cur;
          const HexStatus ust = record_use(cur, inst_id, HEX_IR_USER_INST, 0u);
          if (ust != HEX_OK) return ust;
        }
        if (ins.arg1 != kNone) {
          const uint32_t dv = *var_to_dense.find(ins.arg1);
          const uint32_t cur = peek_var_stack(stack_pool, var_stack_top, dv);
          fn->inst_ssa_arg1[inst_id] = cur;
          const HexStatus ust = record_use(cur, inst_id, HEX_IR_USER_INST, 1u);
          if (ust != HEX_OK) return ust;
        }
        if (ins.arg2 != kNone) {
          const uint32_t dv = *var_to_dense.find(ins.arg2);
          const uint32_t cur = peek_var_stack(stack_pool, var_stack_top, dv);
          fn->inst_ssa_arg2[inst_id] = cur;
          const HexStatus ust = record_use(cur, inst_id, HEX_IR_USER_INST, 2u);
          if (ust != HEX_OK) return ust;
        }
        if (ins.dst_val != kNone) {
          const uint32_t dv = *var_to_dense.find(ins.dst_val);
          uint32_t val_id = kNone;
          if (!alloc_value(ins.dst_val, b, inst_id, HEX_IR_VAL_DEF, &val_id)) return HEX_ERR_OOM;
          fn->inst_ssa_dst[inst_id] = val_id;
          if (!push_var_stack(stack_pool, var_stack_top, dv, val_id)) return HEX_ERR_OOM;
          if (!pushed_vars.push_back(dv)) return HEX_ERR_OOM;
        }
      }

      frame.pushed_count = static_cast<uint32_t>(pushed_vars.size()) - frame.pushed_start;

      const uint32_t sb = fn->succ_off[b];
      const uint32_t se = fn->succ_off[b + 1];
      for (uint32_t si = sb; si < se; ++si) {
        const uint32_t succ = static_cast<uint32_t>(fn->succ_dst[si]);
        const uint32_t spb = fn->block_phi_off[succ];
        const uint32_t spe = fn->block_phi_off[succ + 1];
        for (uint32_t p = spb; p < spe; ++p) {
          const uint32_t dv = *var_to_dense.find(fn->phis[p].var_id);
          const uint32_t cur = peek_var_stack(stack_pool, var_stack_top, dv);
          fn->phis[p].incoming_count++;
          if (phi_in_cur[p] >= fn->phi_incoming.size()) return HEX_ERR_INTERNAL;
          fn->phi_incoming[phi_in_cur[p]++] = IrPhiIncoming{b, cur};
        }
      }
    }

    const uint32_t child_end = dom_child_off[b + 1];
    if (frame.child_idx < child_end) {
      const uint32_t child = dom_child_list[frame.child_idx++];
      if (!frames.push_back(RenameFrame{child, dom_child_off[child], 0u, 0u, 0u, 0u, 0u})) {
        return HEX_ERR_OOM;
      }
      continue;
    }

    for (uint32_t k = frame.pushed_count; k > 0u; --k) {
      const uint32_t dv = pushed_vars[frame.pushed_start + k - 1u];
      pop_var_stack(stack_pool, var_stack_top, dv);
    }
    while (pushed_vars.size() > frame.pushed_start) pushed_vars.pop_back();
    frames.pop_back();
  }

  // Local renaming for unreachable blocks.
  for (uint32_t b = 0; b < n; ++b) {
    if (fn->reachable_mask[b]) continue;
    OrderedMap<uint32_t, uint32_t> local_val(scratch);

    auto get_or_undef = [&](uint32_t var_id, uint32_t* out_val) -> bool {
      if (const uint32_t* existing = local_val.find(var_id)) {
        *out_val = *existing;
        return true;
      }
      uint32_t uid = kNone;
      if (!alloc_value(var_id, b, kNone, HEX_IR_VAL_UNDEF, &uid)) return false;
      if (!local_val.set(var_id, uid)) return false;
      *out_val = uid;
      return true;
    };

    const uint32_t ib = fn->block_inst_off[b];
    const uint32_t ie = fn->block_inst_off[b + 1];
    for (uint32_t idx = ib; idx < ie; ++idx) {
      const uint32_t inst_id = fn->block_inst_ids[idx];
      const IrInst& ins = fn->insts[inst_id];

      if (ins.arg0 != kNone) {
        uint32_t cur = kNone;
        if (!get_or_undef(ins.arg0, &cur)) return HEX_ERR_OOM;
        fn->inst_ssa_arg0[inst_id] = cur;
        const HexStatus ust = record_use(cur, inst_id, HEX_IR_USER_INST, 0u);
        if (ust != HEX_OK) return ust;
      }
      if (ins.arg1 != kNone) {
        uint32_t cur = kNone;
        if (!get_or_undef(ins.arg1, &cur)) return HEX_ERR_OOM;
        fn->inst_ssa_arg1[inst_id] = cur;
        const HexStatus ust = record_use(cur, inst_id, HEX_IR_USER_INST, 1u);
        if (ust != HEX_OK) return ust;
      }
      if (ins.arg2 != kNone) {
        uint32_t cur = kNone;
        if (!get_or_undef(ins.arg2, &cur)) return HEX_ERR_OOM;
        fn->inst_ssa_arg2[inst_id] = cur;
        const HexStatus ust = record_use(cur, inst_id, HEX_IR_USER_INST, 2u);
        if (ust != HEX_OK) return ust;
      }
      if (ins.dst_val != kNone) {
        uint32_t val_id = kNone;
        if (!alloc_value(ins.dst_val, b, inst_id, HEX_IR_VAL_DEF, &val_id)) return HEX_ERR_OOM;
        fn->inst_ssa_dst[inst_id] = val_id;
        if (!local_val.set(ins.dst_val, val_id)) return HEX_ERR_OOM;
      }
    }

    const uint32_t sb = fn->succ_off[b];
    const uint32_t se = fn->succ_off[b + 1];
    for (uint32_t si = sb; si < se; ++si) {
      const uint32_t succ = static_cast<uint32_t>(fn->succ_dst[si]);
      const uint32_t spb = fn->block_phi_off[succ];
      const uint32_t spe = fn->block_phi_off[succ + 1];
      for (uint32_t p = spb; p < spe; ++p) {
        uint32_t cur = kNone;
        if (!get_or_undef(fn->phis[p].var_id, &cur)) return HEX_ERR_OOM;
        fn->phis[p].incoming_count++;
        if (phi_in_cur[p] >= fn->phi_incoming.size()) return HEX_ERR_INTERNAL;
        fn->phi_incoming[phi_in_cur[p]++] = IrPhiIncoming{b, cur};
      }
    }
  }

  // Canonicalize PHI incoming order (virtual entry kNone first, then ascending pred_block_id),
  // THEN record PHI Def-Use edges so IrUse.operand_slot matches the final sorted slot index.
  for (uint32_t p = 0; p < phi_count; ++p) {
    const uint32_t cnt = fn->phis[p].incoming_count;
    IrPhiIncoming* slice = cnt > 0u ? (fn->phi_incoming.data() + fn->phis[p].incoming_offset) : nullptr;
    if (cnt > 1u) {
      if (!stable_sort(*scratch, slice, cnt, [](const IrPhiIncoming& a, const IrPhiIncoming& b) {
            if (a.pred_block_id == b.pred_block_id) return a.ssa_value_id < b.ssa_value_id;
            if (a.pred_block_id == kNone) return true;
            if (b.pred_block_id == kNone) return false;
            return a.pred_block_id < b.pred_block_id;
          })) {
        return HEX_ERR_OOM;
      }
    }
    for (uint32_t k = 0; k < cnt; ++k) {
      const HexStatus ust = record_use(
          slice[k].ssa_value_id, p, HEX_IR_USER_PHI, static_cast<uint8_t>(k & 0xffu));
      if (ust != HEX_OK) return ust;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 5: Build Def-Use Chains (CSR) & Structural Digest
  // -------------------------------------------------------------------------
  const uint32_t val_count = static_cast<uint32_t>(fn->values.size());
  fn->header.value_count = val_count;
  if (!fn->use_off.resize(val_count + 1, 0u)) return HEX_ERR_OOM;
  for (size_t i = 0; i < raw_uses.size(); ++i) {
    fn->use_off[raw_uses[i].ssa_val + 1]++;
  }
  for (uint32_t v = 0; v < val_count; ++v) {
    fn->use_off[v + 1] += fn->use_off[v];
  }
  const uint32_t use_count = fn->use_off[val_count];
  if (use_count > 0u) {
    if (!fn->uses.resize(use_count, IrUse{})) return HEX_ERR_OOM;
    uint32_t* use_cur = scratch->alloc<uint32_t>(val_count);
    if (!use_cur) return HEX_ERR_OOM;
    for (uint32_t v = 0; v < val_count; ++v) use_cur[v] = fn->use_off[v];
    for (size_t i = 0; i < raw_uses.size(); ++i) {
      const RawUse& ru = raw_uses[i];
      fn->uses[use_cur[ru.ssa_val]++] = IrUse{ru.user_index, ru.user_kind, ru.operand_slot, 0u};
    }
  }

  fn->header.ssa_ready = 1u;
  compute_structural_digest(*fn);
  return HEX_OK;
}

// ---------------------------------------------------------------------------
// Global Resident IrStore backing (separate Fixed Scratch Arena + Persistent Arena)
// ---------------------------------------------------------------------------
namespace {

Arena g_default_scratch_arena;
Arena g_default_arena;
IrStore g_default_store;
bool g_default_ready = false;

#if defined(__wasm__)
extern "C" unsigned char __heap_base;
constexpr size_t kWasmScratchBytes = 1024u * 1024u;  // 1 MiB fixed scratch region
#else
alignas(8) uint8_t g_native_scratch_backing[2u * 1024u * 1024u];
alignas(8) uint8_t g_native_backing[8u * 1024u * 1024u];
#endif

void ensure_default_store() {
  if (g_default_ready) return;
#if defined(__wasm__)
  const uintptr_t base = (reinterpret_cast<uintptr_t>(&__heap_base) + 7u) & ~static_cast<uintptr_t>(7u);
  size_t total = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u;
  const size_t min_needed = base + kWasmScratchBytes + 65536u;
  if (total < min_needed) {
    const size_t pages = (min_needed - total + 65535u) / 65536u;
    if (__builtin_wasm_memory_grow(0, static_cast<int32_t>(pages)) >= 0) {
      total = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u;
    }
  }
  const size_t avail = total > base ? (total - base) : 0u;
  const size_t scratch_len = avail > kWasmScratchBytes ? kWasmScratchBytes : (avail / 2u);
  const size_t persist_len = avail > scratch_len ? (avail - scratch_len) : 0u;
  g_default_scratch_arena.init_fixed(reinterpret_cast<uint8_t*>(base), scratch_len);
  g_default_arena.init_external(reinterpret_cast<uint8_t*>(base + scratch_len), persist_len, true);
#else
  g_default_scratch_arena.init_fixed(g_native_scratch_backing, sizeof(g_native_scratch_backing));
  g_default_arena.init_external(g_native_backing, sizeof(g_native_backing), false);
#endif
  g_default_store.init(&g_default_arena, &g_default_scratch_arena);
  g_default_ready = true;
}

}  // namespace

IrStore& default_store() {
  ensure_default_store();
  return g_default_store;
}

}  // namespace ir
}  // namespace hex

extern "C" {

HexStatus hex_ir_create(uint32_t entry_block, HexIrHandle* out_handle) {
  return hex::ir::default_store().create(entry_block, out_handle);
}

HexStatus hex_ir_release(HexIrHandle handle) {
  return hex::ir::default_store().release(handle);
}

HexStatus hex_ir_add_block(HexIrHandle handle, uint32_t* out_block_id) {
  return hex::ir::default_store().add_block(handle, out_block_id);
}

HexStatus hex_ir_add_edge(HexIrHandle handle, uint32_t from_block, uint32_t to_block) {
  return hex::ir::default_store().add_edge(handle, from_block, to_block);
}

HexStatus hex_ir_add_inst(
    HexIrHandle handle,
    uint32_t block_id,
    uint16_t op,
    uint16_t flags,
    uint32_t dst_val,
    uint32_t arg0,
    uint32_t arg1,
    uint32_t arg2,
    uint64_t imm64_or_sym,
    uint32_t* out_inst_id) {
  return hex::ir::default_store().add_inst(
      handle, block_id, op, flags, dst_val, arg0, arg1, arg2, imm64_or_sym, out_inst_id);
}

HexStatus hex_ir_run_cfg_and_ssa(HexIrHandle handle) {
  return hex::ir::default_store().run_cfg_and_ssa(handle);
}

HexStatus hex_ir_get_stats(HexIrHandle handle, HexIrStats* out_stats) {
  return hex::ir::default_store().get_stats(handle, out_stats);
}

}  // extern "C"
