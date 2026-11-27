#include "hex_type_system.hpp"
#include "hex_core/types.hpp"

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

inline uint32_t align8_u32(uint32_t x) {
  return (x + 7u) & ~7u;
}

inline bool checked_align8_u32(uint32_t x, uint32_t* out) {
  if (x > 0xFFFFFFF8u) return false;
  *out = (x + 7u) & ~7u;
  return true;
}

// Authority-aligned Lattice rank for TilTypeId (§4.2: Local Header > Recovered Struct):
//   0: UNKNOWN / INVALID
//   1: Builtin primitive (0x0001..0x003F)
//   2: Core TIL (0x0040..0x0FFF)
//   3: Tier 2 Pack TIL (0x1000..0x5FFF)
//   4: Cross-func Recovered Struct (0x8000..0xFFFE)
//   5: Local Header / Imported C11 Type (0x6000..0x7FFF)
inline uint8_t til_type_rank(TilTypeId tid) {
  if (tid == TIL_TYPE_UNKNOWN || tid == TIL_TYPE_INVALID) return 0u;
  if (tid >= TIL_LOCAL_MIN && tid <= TIL_LOCAL_MAX) return 5u;
  if (tid >= TIL_RECOVERED_MIN && tid <= TIL_RECOVERED_MAX) return 4u;
  if (tid >= TIL_PACK_MIN && tid <= TIL_PACK_MAX) return 3u;
  if (tid >= TIL_CORE_MIN && tid <= TIL_CORE_MAX) return 2u;
  return 1u;
}

inline TilTypeId join_til_id(TilTypeId cur, TilTypeId incoming) {
  if (incoming == TIL_TYPE_UNKNOWN || incoming == TIL_TYPE_INVALID) return cur;
  if (cur == TIL_TYPE_UNKNOWN || cur == TIL_TYPE_INVALID) return incoming;
  const uint8_t r_cur = til_type_rank(cur);
  const uint8_t r_inc = til_type_rank(incoming);
  if (r_inc > r_cur) return incoming;
  if (r_inc == r_cur && cur == TIL_TYPE_VOID && incoming != TIL_TYPE_VOID) return incoming;
  return cur;
}

inline uint8_t hex_type_rank(HexTypeId id) {
  if (hex_type_is_none(id)) return 0u;
  const TilTypeId base = hex_type_base_til(id);
  const uint8_t ptr_d = hex_type_ptr_depth(id);
  const uint8_t kind = hex_type_kind(id);
  const uint8_t aux = hex_type_aux_meta(id);
  if (base == TIL_TYPE_UNKNOWN && ptr_d == 0u) return 0u;
  if (ptr_d >= 1u) {
    if (base >= TIL_LOCAL_MIN && base <= TIL_LOCAL_MAX) return 6u;
    if (base >= TIL_RECOVERED_MIN && base <= TIL_RECOVERED_MAX) return 5u;
    if (kind == HEX_TYPE_KIND_STRUCT || kind == HEX_TYPE_KIND_UNION ||
        kind == HEX_TYPE_KIND_OBJC_OBJ) {
      return 4u;
    }
    return 3u;
  }
  if (kind == HEX_TYPE_KIND_SCALAR &&
      (aux == HEX_AUX_SCALAR_ENUM || aux == HEX_AUX_SCALAR_BITMASK)) {
    return 2u;
  }
  if (base >= TIL_LOCAL_MIN && base <= TIL_LOCAL_MAX) return 5u;
  if (kind == HEX_TYPE_KIND_STRUCT || kind == HEX_TYPE_KIND_OBJC_OBJ) return 4u;
  return 1u;
}

inline HexTypeId join_hex_type(HexTypeId cur, HexTypeId incoming) {
  if (hex_type_is_none(incoming) || incoming == 0u) return cur;
  if (hex_type_is_none(cur) || cur == 0u) return incoming;
  const uint8_t r_cur = hex_type_rank(cur);
  const uint8_t r_inc = hex_type_rank(incoming);
  if (r_inc > r_cur) return incoming;
  if (r_inc == r_cur && hex_type_base_til(cur) == TIL_TYPE_VOID &&
      hex_type_base_til(incoming) != TIL_TYPE_VOID) {
    return incoming;
  }
  return cur;
}

// Explicit Lattice rank & compatibility domain for 4-bit arg_class_packed (0..12):
//   Domains: 0=ANY(unknown), 1=INT_SCALAR, 2=FLOAT_SCALAR, 3=POINTER
//   Ranks:   UNKNOWN(0) < INT/FLOAT(1) < ENUM(2) < PTR(3) < STRUCT_PTR(4) < VTABLE_PTR(5)
//   FLOAT_SCALAR is incompatible with INT_SCALAR and POINTER.
//   ENUM (rank 2) can promote INT_SCALAR (rank 1) but never overwrites PTR/STRUCT_PTR/VTABLE_PTR.
enum ArgClassDomain : uint8_t {
  ARG_DOM_ANY   = 0u,
  ARG_DOM_INT   = 1u,
  ARG_DOM_FLOAT = 2u,
  ARG_DOM_PTR   = 3u,
};

struct ArgClassMeta {
  uint8_t rank;
  uint8_t domain;
};

constexpr ArgClassMeta kArgClassTable[16] = {
    {0u, ARG_DOM_ANY},    // 0: UNKNOWN
    {1u, ARG_DOM_INT},    // 1: INT
    {1u, ARG_DOM_INT},    // 2: UINT
    {1u, ARG_DOM_INT},    // 3: I32
    {1u, ARG_DOM_INT},    // 4: U32
    {1u, ARG_DOM_INT},    // 5: I64
    {1u, ARG_DOM_INT},    // 6: U64
    {1u, ARG_DOM_FLOAT},  // 7: F32
    {1u, ARG_DOM_FLOAT},  // 8: F64
    {3u, ARG_DOM_PTR},    // 9: PTR
    {4u, ARG_DOM_PTR},    // 10: STRUCT_PTR
    {5u, ARG_DOM_PTR},    // 11: VTABLE_PTR
    {2u, ARG_DOM_INT},    // 12: ENUM
    {0u, ARG_DOM_ANY},    // 13: reserved
    {0u, ARG_DOM_ANY},    // 14: reserved
    {0u, ARG_DOM_ANY},    // 15: reserved
};

inline uint16_t join_arg_class(uint16_t cur, uint16_t inc) {
  const ArgClassMeta mc = kArgClassTable[cur & 0xFu];
  const ArgClassMeta mi = kArgClassTable[inc & 0xFu];
  if (mi.rank == 0u) return cur;
  if (mc.rank == 0u) return inc;
  if (cur == inc) return cur;
  // Never cross FLOAT <-> INT/PTR boundaries
  if (mc.domain == ARG_DOM_FLOAT || mi.domain == ARG_DOM_FLOAT) {
    return cur;
  }
  // Safe monotone promotion strictly by Lattice rank
  return (mi.rank > mc.rank) ? inc : cur;
}

inline uint8_t decayed_confidence(uint8_t callee_conf) {
  uint32_t d = (static_cast<uint32_t>(callee_conf) * 230u) >> 8u;
  if (d > 254u) d = 254u;
  return static_cast<uint8_t>(d);
}

// Propagate facts for a single caller from its outgoing callsites.
// Returns true iff any structural field (masks/types/ret_info/this_til) changed.
bool propagate_single_caller(
    uint32_t caller_idx,
    const uint32_t* row_ptr,
    const HexCallsiteFact* facts,
    uint32_t num_edges,
    HexFuncSig* sig_pool,
    uint32_t sig_pool_count,
    const uint32_t* pin_mask,
    uint32_t* ext_sig_pool,
    uint32_t ext_sig_count) {
  HexFuncSig& caller = sig_pool[caller_idx];

  // Respect USER_PINNED (confidence == 255 == 1.0): completely immutable.
  if (caller.confidence == HEX_CONFIDENCE_USER_PINNED) return false;

  const uint32_t pins = (pin_mask != nullptr) ? pin_mask[caller_idx] : 0u;
  const uint32_t e_begin = row_ptr[caller_idx];
  const uint32_t e_end = row_ptr[caller_idx + 1u];
  if (e_begin > e_end || e_end > num_edges) return false;

  const HexFuncSig before = caller;
  bool ext_changed = false;
  uint8_t best_inferred_conf = caller.confidence;

  for (uint32_t ei = e_begin; ei < e_end; ++ei) {
    const HexCallsiteFact& fact = facts[ei];
    const uint32_t callee_idx = fact.callee_idx;
    if (callee_idx >= sig_pool_count || callee_idx == caller_idx) continue;

    const HexFuncSig& callee = sig_pool[callee_idx];
    const uint8_t dec_conf = decayed_confidence(callee.confidence);
    const bool is_variadic_call =
        ((callee.abi_flags & HEX_ABI_FLAG_IS_VARIADIC) != 0u) ||
        ((fact.site_flags & HEX_SITE_FLAG_VARIADIC) != 0u);
    bool site_contributed = false;

    const bool has_ext = (ext_sig_pool != nullptr &&
                          caller.ext_sig_idx < ext_sig_count &&
                          callee.ext_sig_idx < ext_sig_count);
    uint32_t* caller_ext = has_ext ? (ext_sig_pool + static_cast<size_t>(caller.ext_sig_idx) * 9u)
                                   : nullptr;
    const uint32_t* callee_ext =
        has_ext ? (ext_sig_pool + static_cast<size_t>(callee.ext_sig_idx) * 9u) : nullptr;

    // 1. Forwarded argument propagation via reg_pass_map (callee arg k <- caller reg src_reg)
    for (uint32_t k = 0u; k < 8u; ++k) {
      const uint32_t src_reg = (fact.reg_pass_map >> (k * 4u)) & 0xFu;
      if (src_reg >= 8u) continue;
      if ((pins & HEX_PIN_GP_ARG(src_reg)) != 0u) continue;

      const uint8_t callee_bit = static_cast<uint8_t>(1u << k);
      const uint8_t caller_bit = static_cast<uint8_t>(1u << src_reg);

      // Variadic guard: block back-propagation for non-fixed variadic argument slots
      if (is_variadic_call && (callee.gp_arg_mask & callee_bit) == 0u) {
        continue;
      }

      if ((callee.gp_arg_mask & callee_bit) != 0u) {
        if ((caller.gp_arg_mask & caller_bit) == 0u) {
          caller.gp_arg_mask |= caller_bit;
          site_contributed = true;
        }
      }
      if ((callee.ptr_arg_mask & callee_bit) != 0u) {
        if ((caller.ptr_arg_mask & caller_bit) == 0u) {
          caller.ptr_arg_mask |= caller_bit;
          site_contributed = true;
        }
      }

      // Signedness propagation (monotone, avoid contradictory signed+unsigned bits)
      const bool c_signed = ((callee.signed_arg_mask >> k) & 1u) != 0u;
      const bool c_unsigned = ((callee.signed_arg_mask >> (8u + k)) & 1u) != 0u;
      const bool my_signed = ((caller.signed_arg_mask >> src_reg) & 1u) != 0u;
      const bool my_unsigned = ((caller.signed_arg_mask >> (8u + src_reg)) & 1u) != 0u;
      if (c_signed && !c_unsigned && !my_signed && !my_unsigned) {
        caller.signed_arg_mask |= static_cast<uint16_t>(1u << src_reg);
        site_contributed = true;
      } else if (c_unsigned && !c_signed && !my_signed && !my_unsigned) {
        caller.signed_arg_mask |= static_cast<uint16_t>(1u << (8u + src_reg));
        site_contributed = true;
      }

      // This-pointer propagation (x0 -> x0)
      if (k == 0u && src_reg == 0u && (pins & HEX_PIN_THIS) == 0u &&
          (callee.abi_flags & HEX_ABI_FLAG_HAS_THIS) != 0u &&
          callee.this_til_id != TIL_TYPE_UNKNOWN) {
        const TilTypeId joined_this = join_til_id(caller.this_til_id, callee.this_til_id);
        if (joined_this != caller.this_til_id) {
          caller.this_til_id = joined_this;
          caller.abi_flags |= HEX_ABI_FLAG_HAS_THIS;
          site_contributed = true;
        } else if ((caller.abi_flags & HEX_ABI_FLAG_HAS_THIS) == 0u) {
          caller.abi_flags |= HEX_ABI_FLAG_HAS_THIS;
          site_contributed = true;
        }
      }

      // Arg class nibble promotion for x0..x3 via explicit Lattice join
      if (k < 4u && src_reg < 4u) {
        const uint16_t c_cls = static_cast<uint16_t>((callee.arg_class_packed >> (k * 4u)) & 0xFu);
        const uint16_t m_cls =
            static_cast<uint16_t>((caller.arg_class_packed >> (src_reg * 4u)) & 0xFu);
        const uint16_t joined_cls = join_arg_class(m_cls, c_cls);
        if (joined_cls != m_cls) {
          caller.arg_class_packed = static_cast<uint16_t>(
              (caller.arg_class_packed & ~(0xFu << (src_reg * 4u))) |
              (joined_cls << (src_reg * 4u)));
          site_contributed = true;
        }
      }

      // Extended HexTypeId argument promotion
      if (has_ext) {
        const HexTypeId joined_arg = join_hex_type(caller_ext[src_reg], callee_ext[k]);
        if (joined_arg != caller_ext[src_reg]) {
          caller_ext[src_reg] = joined_arg;
          ext_changed = true;
          site_contributed = true;
        }
      }
    }

    // 2. Return value propagation (direct passthrough or tail-call)
    const bool ret_flows =
        (fact.ret_used_mask & (HEX_RET_USED_PASSTHROUGH | HEX_RET_USED_TAILCALL)) != 0u;
    if (ret_flows && (pins & HEX_PIN_RET) == 0u) {
      const TilTypeId joined_ret = join_til_id(caller.ret_til_id, callee.ret_til_id);
      if (joined_ret != caller.ret_til_id) {
        caller.ret_til_id = joined_ret;
        site_contributed = true;
      }
      const uint8_t cur_ret_kind = static_cast<uint8_t>(caller.ret_info & 0x0Fu);
      const uint8_t cal_ret_kind = static_cast<uint8_t>(callee.ret_info & 0x0Fu);
      if (cur_ret_kind == 0u && cal_ret_kind != 0u) {
        caller.ret_info = callee.ret_info;
        site_contributed = true;
      }
      if (has_ext) {
        const HexTypeId joined_ret_hex = join_hex_type(caller_ext[8], callee_ext[8]);
        if (joined_ret_hex != caller_ext[8]) {
          caller_ext[8] = joined_ret_hex;
          ext_changed = true;
          site_contributed = true;
        }
      }
    }

    // 3. Tail-call FP arg inheritance (skipped for variadic calls)
    if (!is_variadic_call && (fact.ret_used_mask & HEX_RET_USED_TAILCALL) != 0u) {
      for (uint32_t k = 0u; k < 8u; ++k) {
        if ((pins & HEX_PIN_FP_ARG(k)) != 0u) continue;
        const uint8_t bit = static_cast<uint8_t>(1u << k);
        if ((callee.fp_arg_mask & bit) != 0u && (caller.fp_arg_mask & bit) == 0u) {
          caller.fp_arg_mask |= bit;
          site_contributed = true;
        }
      }
    }

    if (site_contributed && dec_conf > best_inferred_conf) {
      best_inferred_conf = dec_conf;
    }
  }

  // Update decayed confidence (never reaching 255 / USER_PINNED)
  if (best_inferred_conf > caller.confidence && best_inferred_conf < HEX_CONFIDENCE_USER_PINNED) {
    caller.confidence = best_inferred_conf;
  }

  // Convergence check strictly ignores confidence (per §2.2)
  const bool sig_changed =
      (caller.abi_flags != before.abi_flags) ||
      (caller.gp_arg_mask != before.gp_arg_mask) ||
      (caller.fp_arg_mask != before.fp_arg_mask) ||
      (caller.ptr_arg_mask != before.ptr_arg_mask) ||
      (caller.ret_info != before.ret_info) ||
      (caller.ret_til_id != before.ret_til_id) ||
      (caller.this_til_id != before.this_til_id) ||
      (caller.arg_class_packed != before.arg_class_packed) ||
      (caller.signed_arg_mask != before.signed_arg_mask) ||
      ext_changed;

  return sig_changed;
}

uint32_t tarjan_scratch_bytes(uint32_t num_nodes, uint32_t num_edges) {
  if (num_nodes == 0u) return 0u;
  uint32_t n_plus_1 = 0u;
  if (!checked_add_u32(num_nodes, 1u, &n_plus_1)) return 0u;

  uint32_t raw_off = 0u, a_off = 0u;
  if (!checked_mul_u32(4u, n_plus_1, &raw_off) || !checked_align8_u32(raw_off, &a_off)) return 0u;

  uint32_t raw_edges = 0u, a_edges = 0u;
  if (!checked_mul_u32(4u, num_edges, &raw_edges) || !checked_align8_u32(raw_edges, &a_edges)) {
    return 0u;
  }

  uint32_t raw_u32n = 0u, a_u32n = 0u, a_7_u32n = 0u;
  if (!checked_mul_u32(4u, num_nodes, &raw_u32n) || !checked_align8_u32(raw_u32n, &a_u32n)) {
    return 0u;
  }
  if (!checked_mul_u32(7u, a_u32n, &a_7_u32n)) return 0u;

  uint32_t a_u8n = 0u;
  if (!checked_align8_u32(num_nodes, &a_u8n)) return 0u;

  uint32_t total = 0u;
  if (!checked_add_u32(a_off, a_edges, &total)) return 0u;
  if (!checked_add_u32(total, a_7_u32n, &total)) return 0u;
  if (!checked_add_u32(total, a_u8n, &total)) return 0u;
  return total;
}

void run_tarjan_csr(
    uint32_t num_nodes,
    const uint32_t* row_ptr,
    const uint32_t* col_idx,
    uint32_t* disc,
    uint32_t* low,
    uint32_t* tarjan_stack,
    uint32_t* dfs_node,
    uint32_t* dfs_edge,
    uint8_t* on_stack,
    uint32_t* out_scc_id,
    uint32_t* out_topo_nodes,
    uint32_t* out_scc_offsets,
    uint32_t* out_num_sccs) {
  for (uint32_t i = 0u; i < num_nodes; ++i) {
    disc[i] = 0u;
    low[i] = 0u;
    on_stack[i] = 0u;
  }

  uint32_t next_index = 1u;
  uint32_t tarjan_top = 0u;
  uint32_t num_sccs = 0u;
  uint32_t topo_pos = 0u;

  if (out_scc_offsets != nullptr) out_scc_offsets[0] = 0u;

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
        if (w >= num_nodes) continue;
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
          const uint32_t scc_id = num_sccs++;
          uint32_t scc_start = tarjan_top;
          while (scc_start > 0u) {
            scc_start -= 1u;
            const uint32_t w = tarjan_stack[scc_start];
            on_stack[w] = 0u;
            if (w == v) break;
          }
          for (uint32_t k = scc_start; k < tarjan_top; ++k) {
            const uint32_t member = tarjan_stack[k];
            out_scc_id[member] = scc_id;
            out_topo_nodes[topo_pos++] = member;
          }
          if (out_scc_offsets != nullptr) out_scc_offsets[num_sccs] = topo_pos;
          tarjan_top = scc_start;
        }
        if (dfs_top > 0u) {
          const uint32_t parent = dfs_node[dfs_top - 1u];
          if (low[v] < low[parent]) low[parent] = low[v];
        }
      }
    }
  }

  *out_num_sccs = num_sccs;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_analyze_callgraph_scc_order")
HexStatus hex_analyze_callgraph_scc_order(
    uint32_t num_nodes,
    const uint32_t* edge_src,
    const uint32_t* edge_dst,
    uint32_t num_edges,
    uint8_t* scratch_ptr,
    uint32_t scratch_bytes,
    uint32_t* out_scc_id,
    uint32_t* out_topo_nodes,
    uint32_t* out_num_sccs) {
  if (num_nodes == 0u || out_scc_id == nullptr || out_topo_nodes == nullptr ||
      out_num_sccs == nullptr || scratch_ptr == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if ((reinterpret_cast<uintptr_t>(scratch_ptr) & 7u) != 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  if (num_edges > 0u && (edge_src == nullptr || edge_dst == nullptr)) {
    return HEX_ERR_INVALID_ARG;
  }

  HexRuntimeLimits limits = {};
  hex_get_runtime_limits(&limits);
  if (num_nodes > limits.max_sig_prop_nodes) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  const uint32_t need = tarjan_scratch_bytes(num_nodes, num_edges);
  if (need == 0u || scratch_bytes < need) {
    return HEX_ERR_OOM;
  }

  const uint32_t sz_off = align8_u32(4u * (num_nodes + 1u));
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

  uint32_t* row_ptr = take_u32(sz_off);
  uint32_t* col_idx = take_u32(sz_edges);
  uint32_t* out_deg = take_u32(sz_u32n);
  uint32_t* cursor = take_u32(sz_u32n);
  uint32_t* disc = take_u32(sz_u32n);
  uint32_t* low = take_u32(sz_u32n);
  uint32_t* tarjan_stack = take_u32(sz_u32n);
  uint32_t* dfs_node = take_u32(sz_u32n);
  uint32_t* dfs_edge = take_u32(sz_u32n);
  uint8_t* on_stack = take_u8(sz_u8n);

  for (uint32_t i = 0u; i < num_nodes; ++i) out_deg[i] = 0u;
  for (uint32_t i = 0u; i < num_edges; ++i) {
    if (edge_src[i] < num_nodes && edge_dst[i] < num_nodes) {
      out_deg[edge_src[i]] += 1u;
    }
  }

  row_ptr[0] = 0u;
  for (uint32_t i = 0u; i < num_nodes; ++i) {
    row_ptr[i + 1u] = row_ptr[i] + out_deg[i];
    cursor[i] = row_ptr[i];
  }
  for (uint32_t i = 0u; i < num_edges; ++i) {
    if (edge_src[i] < num_nodes && edge_dst[i] < num_nodes) {
      col_idx[cursor[edge_src[i]]++] = edge_dst[i];
    }
  }

  run_tarjan_csr(
      num_nodes, row_ptr, col_idx, disc, low, tarjan_stack, dfs_node, dfs_edge, on_stack,
      out_scc_id, out_topo_nodes, nullptr, out_num_sccs);

  return HEX_OK;
}

HEX_WASM_EXPORT("hex_propagate_sig_window")
HexStatus hex_propagate_sig_window(
    uint32_t window_callers,
    const uint32_t* local_row_ptr,
    const struct HexCallsiteFact* local_facts,
    uint32_t local_edges,
    struct HexFuncSig* sig_pool,
    uint32_t sig_pool_count,
    const uint32_t* pin_mask,
    uint32_t* ext_sig_pool,
    uint32_t ext_sig_count,
    uint32_t max_scc_iters) {
  if (window_callers == 0u || local_row_ptr == nullptr || sig_pool == nullptr ||
      sig_pool_count < window_callers) {
    return HEX_ERR_INVALID_ARG;
  }
  if (local_edges > 0u && local_facts == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  HexRuntimeLimits limits = {};
  hex_get_runtime_limits(&limits);
  if (window_callers > limits.max_sig_prop_nodes) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  // Validate CSR row_ptr before any propagation
  if (local_row_ptr[0] != 0u || local_row_ptr[window_callers] > local_edges) {
    return HEX_ERR_INVALID_ARG;
  }
  for (uint32_t c = 0u; c < window_callers; ++c) {
    if (local_row_ptr[c] > local_row_ptr[c + 1u] || local_row_ptr[c + 1u] > local_edges) {
      return HEX_ERR_INVALID_ARG;
    }
  }

  uint32_t iters = max_scc_iters;
  if (iters == 0u || iters > limits.max_sig_prop_iters) {
    iters = limits.max_sig_prop_iters;
  }

  for (uint32_t it = 0u; it < iters; ++it) {
    bool any_changed = false;
    for (uint32_t c = 0u; c < window_callers; ++c) {
      if (propagate_single_caller(
              c, local_row_ptr, local_facts, local_edges, sig_pool, sig_pool_count, pin_mask,
              ext_sig_pool, ext_sig_count)) {
        any_changed = true;
      }
    }
    if (!any_changed) break;
  }

  return HEX_OK;
}

HEX_WASM_EXPORT("hex_sig_prop_run")
HexStatus hex_sig_prop_run(
    uint32_t num_nodes,
    const uint32_t* row_ptr,
    const struct HexCallsiteFact* facts,
    uint32_t num_edges,
    struct HexFuncSig* sigs,
    const uint32_t* pin_mask,
    uint32_t* ext_sig_pool,
    uint32_t ext_sig_count,
    uint32_t max_iters,
    uint32_t* out_scc_id,
    uint32_t* out_topo_nodes,
    uint32_t* out_num_sccs) {
  if (num_nodes == 0u || row_ptr == nullptr || sigs == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (num_edges > 0u && facts == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  // Enforce runtime node limit BEFORE dereferencing row_ptr[num_nodes] to prevent OOB read
  HexRuntimeLimits limits = {};
  hex_get_runtime_limits(&limits);
  if (num_nodes > limits.max_sig_prop_nodes) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  if (row_ptr[0] != 0u || row_ptr[num_nodes] > num_edges) {
    return HEX_ERR_INVALID_ARG;
  }

  uint32_t eff_iters = max_iters;
  if (eff_iters == 0u || eff_iters > limits.max_sig_prop_iters) {
    eff_iters = limits.max_sig_prop_iters;
  }

  // Allocate temporary Tarjan & SCC structures from g_type_arena Volatile A.
  hex_type_arena_reset_slot(HEX_ARENA_SLOT_VOLATILE_A);

  auto alloc_u32 = [](uint32_t count) -> uint32_t* {
    if (count == 0u) return nullptr;
    if (count > 0xFFFFFFFFu / 4u) return nullptr;
    return reinterpret_cast<uint32_t*>(
        hex_type_arena_bump_alloc(HEX_ARENA_SLOT_VOLATILE_A, count * 4u, 8u));
  };

  uint32_t* col_idx = (num_edges > 0u) ? alloc_u32(num_edges) : nullptr;
  uint32_t* disc = alloc_u32(num_nodes);
  uint32_t* low = alloc_u32(num_nodes);
  uint32_t* tarjan_stack = alloc_u32(num_nodes);
  uint32_t* dfs_node = alloc_u32(num_nodes);
  uint32_t* dfs_edge = alloc_u32(num_nodes);
  uint32_t* scc_id = alloc_u32(num_nodes);
  uint32_t* topo_nodes = alloc_u32(num_nodes);
  uint32_t* scc_offsets = alloc_u32(num_nodes + 1u);
  uint8_t* on_stack =
      hex_type_arena_bump_alloc(HEX_ARENA_SLOT_VOLATILE_A, num_nodes, 8u);

  if ((num_edges > 0u && col_idx == nullptr) || disc == nullptr || low == nullptr ||
      tarjan_stack == nullptr || dfs_node == nullptr || dfs_edge == nullptr ||
      scc_id == nullptr || topo_nodes == nullptr || scc_offsets == nullptr ||
      on_stack == nullptr) {
    hex_type_arena_reset_slot(HEX_ARENA_SLOT_VOLATILE_A);
    return HEX_ERR_OOM;
  }

  // Validate CSR monotonicity and extract callee column indices
  for (uint32_t u = 0u; u < num_nodes; ++u) {
    if (row_ptr[u] > row_ptr[u + 1u] || row_ptr[u + 1u] > num_edges) {
      hex_type_arena_reset_slot(HEX_ARENA_SLOT_VOLATILE_A);
      return HEX_ERR_INVALID_ARG;
    }
    for (uint32_t ei = row_ptr[u]; ei < row_ptr[u + 1u]; ++ei) {
      col_idx[ei] = facts[ei].callee_idx;
    }
  }

  uint32_t num_sccs = 0u;
  run_tarjan_csr(
      num_nodes, row_ptr, col_idx, disc, low, tarjan_stack, dfs_node, dfs_edge, on_stack,
      scc_id, topo_nodes, scc_offsets, &num_sccs);

  // Bottom-up SCC fixed-point propagation (callees processed before callers)
  for (uint32_t s = 0u; s < num_sccs; ++s) {
    const uint32_t begin = scc_offsets[s];
    const uint32_t end = scc_offsets[s + 1u];
    const uint32_t scc_sz = end - begin;

    for (uint32_t k = begin; k < end; ++k) {
      const uint32_t u = topo_nodes[k];
      if (sigs[u].confidence == HEX_CONFIDENCE_USER_PINNED) continue;
      bool is_rec = (scc_sz >= 2u);
      if (!is_rec) {
        for (uint32_t ei = row_ptr[u]; ei < row_ptr[u + 1u]; ++ei) {
          if (facts[ei].callee_idx == u) {
            is_rec = true;
            break;
          }
        }
      }
      if (is_rec) sigs[u].abi_flags |= HEX_ABI_FLAG_IS_RECURSIVE;
    }

    const uint32_t scc_max_iters = (scc_sz == 1u) ? 1u : eff_iters;
    for (uint32_t it = 0u; it < scc_max_iters; ++it) {
      bool changed = false;
      for (uint32_t k = begin; k < end; ++k) {
        const uint32_t u = topo_nodes[k];
        if (propagate_single_caller(
                u, row_ptr, facts, num_edges, sigs, num_nodes, pin_mask, ext_sig_pool,
                ext_sig_count)) {
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  if (out_scc_id != nullptr) {
    hex::mem_copy(out_scc_id, scc_id, static_cast<size_t>(num_nodes) * 4u);
  }
  if (out_topo_nodes != nullptr) {
    hex::mem_copy(out_topo_nodes, topo_nodes, static_cast<size_t>(num_nodes) * 4u);
  }
  if (out_num_sccs != nullptr) {
    *out_num_sccs = num_sccs;
  }

  hex_type_arena_reset_slot(HEX_ARENA_SLOT_VOLATILE_A);
  return HEX_OK;
}

}  // extern "C"
