#include "hex_deobf.hpp"

namespace {

static constexpr uint32_t kMaxCffBlocks = 256u;
static constexpr uint32_t kMaxCffEdges = 1024u;
static constexpr uint32_t kWordCount = (kMaxCffBlocks + 63u) / 64u;
static constexpr uint32_t kNone = 0xFFFFFFFFu;

struct BitSet256 {
  uint64_t w[kWordCount];

  void clear() {
    for (uint32_t i = 0u; i < kWordCount; ++i) w[i] = 0ULL;
  }
  void set_all(uint32_t n) {
    clear();
    for (uint32_t i = 0u; i < n; ++i) set(i);
  }
  void set(uint32_t bit) { w[bit >> 6] |= (1ULL << (bit & 63u)); }
  bool test(uint32_t bit) const { return ((w[bit >> 6] >> (bit & 63u)) & 1ULL) != 0ULL; }
  bool intersect_with(const BitSet256& other) {
    bool changed = false;
    for (uint32_t i = 0u; i < kWordCount; ++i) {
      const uint64_t next = w[i] & other.w[i];
      if (next != w[i]) {
        w[i] = next;
        changed = true;
      }
    }
    return changed;
  }
};

// Static scratch buffer for standalone WASM callers (128 KiB)
alignas(16) uint8_t g_deobf_scratch[131072u];

void zero_result(HexCffUnflattenResult* r) {
  r->status = HEX_CFF_STATUS_NOT_APPLICABLE;
  r->guard_fail_reason = HEX_CFF_GUARD_NONE;
  r->dispatcher_block = kNone;
  r->state_var_id = 0u;
  r->real_block_count = 0u;
  r->spine_block_count = 0u;
  r->recovered_edge_count = 0u;
  r->uncond_edge_count = 0u;
  r->cond_edge_count = 0u;
  r->exit_block_count = 0u;
}

uint32_t find_block_index(const HexCffBlock* blocks, uint32_t count, uint32_t block_id) {
  for (uint32_t i = 0u; i < count; ++i) {
    if (blocks[i].block_id == block_id) return i;
  }
  return kNone;
}

uint32_t find_block_by_state(const HexCffBlock* blocks, uint32_t count, uint64_t state_val,
                             uint32_t state_var_id, uint32_t dispatcher_idx) {
  for (uint32_t i = 0u; i < count; ++i) {
    if (i == dispatcher_idx) continue;
    if (blocks[i].has_match_state != 0u && blocks[i].match_state == state_val) {
      if (state_var_id == 0u || blocks[i].state_var_id == 0u ||
          blocks[i].state_var_id == state_var_id) {
        return i;
      }
    }
  }
  return kNone;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_deobf_scratch_ptr")
uint8_t* hex_deobf_scratch_ptr(void) { return g_deobf_scratch; }

HEX_WASM_EXPORT("hex_deobf_scratch_size")
uint32_t hex_deobf_scratch_size(void) { return static_cast<uint32_t>(sizeof(g_deobf_scratch)); }

HEX_WASM_EXPORT("hex_cff_unflatten")
HexStatus hex_cff_unflatten(
    const HexCffBlock* blocks, uint32_t block_count,
    const HexCffEdge* in_edges, uint32_t in_edge_count,
    HexCffEdge* out_edges, uint32_t max_out_edges,
    HexCffUnflattenResult* out_result) {
  if (blocks == nullptr || out_result == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (in_edge_count > 0u && in_edges == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (max_out_edges > 0u && out_edges == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  zero_result(out_result);

  if (block_count == 0u || block_count > kMaxCffBlocks || in_edge_count > kMaxCffEdges) {
    out_result->status = HEX_CFF_STATUS_ABORT_BUDGET;
    out_result->guard_fail_reason = HEX_CFF_GUARD_BUDGET_EXCEEDED;
    return HEX_ERR_RESOURCE_LIMIT;
  }

  // Reject duplicate block_id values immediately.
  for (uint32_t i = 0u; i < block_count; ++i) {
    for (uint32_t j = i + 1u; j < block_count; ++j) {
      if (blocks[i].block_id == blocks[j].block_id) {
        return HEX_ERR_INVALID_ARG;
      }
    }
  }

  // Locate entry block (explicit flag or index 0).
  uint32_t entry_idx = 0u;
  for (uint32_t i = 0u; i < block_count; ++i) {
    if ((blocks[i].flags & HEX_CFF_BLK_ENTRY) != 0u) {
      entry_idx = i;
      break;
    }
  }

  uint32_t in_deg[kMaxCffBlocks];
  uint32_t out_deg[kMaxCffBlocks];
  uint32_t edge_src[kMaxCffEdges];
  uint32_t edge_dst[kMaxCffEdges];
  for (uint32_t i = 0u; i < block_count; ++i) {
    in_deg[i] = 0u;
    out_deg[i] = 0u;
  }

  uint32_t valid_edge_count = 0u;
  for (uint32_t e = 0u; e < in_edge_count; ++e) {
    const uint32_t s = find_block_index(blocks, block_count, in_edges[e].src_block);
    const uint32_t d = find_block_index(blocks, block_count, in_edges[e].dst_block);
    if (s == kNone || d == kNone) continue;
    edge_src[valid_edge_count] = s;
    edge_dst[valid_edge_count] = d;
    ++valid_edge_count;
    ++out_deg[s];
    ++in_deg[d];
  }

  // Compute reachability from entry_idx via BFS.
  uint8_t reachable[kMaxCffBlocks];
  uint32_t queue[kMaxCffBlocks];
  for (uint32_t i = 0u; i < block_count; ++i) reachable[i] = 0u;
  uint32_t qh = 0u;
  uint32_t qt = 0u;
  reachable[entry_idx] = 1u;
  queue[qt++] = entry_idx;
  while (qh < qt) {
    const uint32_t u = queue[qh++];
    for (uint32_t e = 0u; e < valid_edge_count; ++e) {
      if (edge_src[e] == u && reachable[edge_dst[e]] == 0u) {
        reachable[edge_dst[e]] = 1u;
        queue[qt++] = edge_dst[e];
      }
    }
  }

  // Compute iterative dominator sets over reachable nodes.
  BitSet256 dom[kMaxCffBlocks];
  for (uint32_t i = 0u; i < block_count; ++i) {
    if (i == entry_idx) {
      dom[i].clear();
      dom[i].set(entry_idx);
    } else if (reachable[i] != 0u) {
      dom[i].set_all(block_count);
    } else {
      dom[i].clear();
    }
  }

  for (uint32_t iter = 0u; iter < block_count + 2u; ++iter) {
    bool changed = false;
    for (uint32_t b = 0u; b < block_count; ++b) {
      if (b == entry_idx || reachable[b] == 0u) continue;
      BitSet256 next_dom;
      bool first_pred = true;
      for (uint32_t e = 0u; e < valid_edge_count; ++e) {
        if (edge_dst[e] == b && reachable[edge_src[e]] != 0u) {
          if (first_pred) {
            next_dom = dom[edge_src[e]];
            first_pred = false;
          } else {
            next_dom.intersect_with(dom[edge_src[e]]);
          }
        }
      }
      if (!first_pred) {
        next_dom.set(b);
        for (uint32_t w = 0u; w < kWordCount; ++w) {
          if (next_dom.w[w] != dom[b].w[w]) {
            dom[b].w[w] = next_dom.w[w];
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  // Stage 1: Detect OLLVM CFF dispatcher hub.
  uint32_t disp_idx = kNone;
  uint32_t best_score = 0u;
  for (uint32_t b = 0u; b < block_count; ++b) {
    if (reachable[b] == 0u) continue;
    const bool has_switch = (blocks[b].flags & HEX_CFF_BLK_HAS_SWITCH) != 0u;
    if (!has_switch && out_deg[b] < 4u) continue;

    uint32_t back_edges = 0u;
    for (uint32_t e = 0u; e < valid_edge_count; ++e) {
      if (edge_dst[e] == b && dom[edge_src[e]].test(b)) {
        ++back_edges;
      }
    }
    uint32_t merge_in_deg = 0u;
    for (uint32_t e = 0u; e < valid_edge_count; ++e) {
      if (edge_dst[e] == b) {
        const uint32_t pred = edge_src[e];
        if (dom[pred].test(b) && in_deg[pred] >= 3u) {
          if (in_deg[pred] > merge_in_deg) merge_in_deg = in_deg[pred];
        }
      }
    }
    const uint32_t effective_back = back_edges > merge_in_deg ? back_edges : merge_in_deg;
    if (effective_back < 3u && in_deg[b] < 4u) continue;

    const uint32_t score = (has_switch ? 1000u : 0u) + effective_back * 16u + out_deg[b] * 8u;
    if (score > best_score) {
      best_score = score;
      disp_idx = b;
    }
  }

  if (disp_idx == kNone) {
    out_result->status = HEX_CFF_STATUS_NOT_APPLICABLE;
    return HEX_OK;
  }

  const uint32_t state_var = blocks[disp_idx].state_var_id;
  out_result->dispatcher_block = blocks[disp_idx].block_id;
  out_result->state_var_id = state_var;

  // Fail-Closed Guard 5: Dispatcher / spine must not have side effects.
  if ((blocks[disp_idx].flags & HEX_CFF_BLK_SIDE_EFFECT) != 0u) {
    out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
    out_result->guard_fail_reason = HEX_CFF_GUARD_SPINE_SIDE_EFFECT;
    return HEX_OK;
  }

  // Classify real blocks vs spine blocks.
  uint8_t is_real[kMaxCffBlocks];
  uint8_t is_spine[kMaxCffBlocks];
  for (uint32_t i = 0u; i < block_count; ++i) {
    is_real[i] = 0u;
    is_spine[i] = 0u;
  }
  is_spine[disp_idx] = 1u;

  uint32_t real_count = 0u;
  uint32_t spine_count = 1u;
  uint32_t exit_count = 0u;

  for (uint32_t i = 0u; i < block_count; ++i) {
    if (i == disp_idx || reachable[i] == 0u) continue;

    if ((blocks[i].flags & HEX_CFF_BLK_STATE_EXTERN) != 0u &&
        (state_var == 0u || blocks[i].state_var_id == state_var)) {
      out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
      out_result->guard_fail_reason = HEX_CFF_GUARD_NATURAL_FSM;
      return HEX_OK;
    }

    if ((blocks[i].flags & HEX_CFF_BLK_STATE_ESCAPES) != 0u &&
        (state_var == 0u || blocks[i].state_var_id == state_var)) {
      out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
      out_result->guard_fail_reason = HEX_CFF_GUARD_STATE_ESCAPE;
      return HEX_OK;
    }

    if (blocks[i].has_match_state != 0u) {
      // Exclude blocks belonging to a different state variable.
      if (state_var != 0u && blocks[i].state_var_id != 0u &&
          blocks[i].state_var_id != state_var) {
        continue;
      }
      if (!dom[i].test(disp_idx)) {
        out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
        out_result->guard_fail_reason = HEX_CFF_GUARD_DOMINANCE_FAIL;
        return HEX_OK;
      }
      is_real[i] = 1u;
      ++real_count;
      if ((blocks[i].flags & HEX_CFF_BLK_HAS_EXIT) != 0u) {
        ++exit_count;
      }
    } else if (i != entry_idx && dom[i].test(disp_idx) &&
               (blocks[i].flags & HEX_CFF_BLK_HAS_EXIT) == 0u &&
               (blocks[i].flags & HEX_CFF_BLK_UPDATES_STATE) == 0u) {
      if ((blocks[i].flags & HEX_CFF_BLK_SIDE_EFFECT) != 0u) {
        out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
        out_result->guard_fail_reason = HEX_CFF_GUARD_SPINE_SIDE_EFFECT;
        return HEX_OK;
      }
      is_spine[i] = 1u;
      ++spine_count;
    }
  }

  if ((blocks[disp_idx].flags & HEX_CFF_BLK_STATE_EXTERN) != 0u) {
    out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
    out_result->guard_fail_reason = HEX_CFF_GUARD_NATURAL_FSM;
    return HEX_OK;
  }
  if ((blocks[disp_idx].flags & HEX_CFF_BLK_STATE_ESCAPES) != 0u) {
    out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
    out_result->guard_fail_reason = HEX_CFF_GUARD_STATE_ESCAPE;
    return HEX_OK;
  }

  // Entry block MUST initialize state_var with a constant state (fail-closed).
  const bool entry_inits_state =
      ((blocks[entry_idx].flags & HEX_CFF_BLK_UPDATES_STATE) != 0u) &&
      ((blocks[entry_idx].flags & HEX_CFF_BLK_COND_UPDATE) == 0u) &&
      (state_var == 0u || blocks[entry_idx].state_var_id == state_var);
  if (!entry_inits_state) {
    out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
    out_result->guard_fail_reason = HEX_CFF_GUARD_UNRESOLVED_EDGE;
    return HEX_OK;
  }

  // Fail-Closed Guard 1: At least 4 real blocks with distinct state keys.
  if (real_count < 4u) {
    out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
    out_result->guard_fail_reason = HEX_CFF_GUARD_TOO_FEW_REAL;
    return HEX_OK;
  }

  for (uint32_t i = 0u; i < block_count; ++i) {
    if (is_real[i] == 0u) continue;
    for (uint32_t j = i + 1u; j < block_count; ++j) {
      if (is_real[j] == 0u) continue;
      if (blocks[i].match_state == blocks[j].match_state) {
        out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
        out_result->guard_fail_reason = HEX_CFF_GUARD_TOO_FEW_REAL;
        return HEX_OK;
      }
    }
  }

  // Stage 2 & 3: Dry-run state-transition edge recovery into local draft buffer.
  HexCffEdge draft[kMaxCffEdges];
  uint32_t draft_count = 0u;
  uint32_t uncond_count = 0u;
  uint32_t cond_count = 0u;

  auto push_draft = [&](uint32_t src_id, uint32_t dst_id, uint32_t kind, uint32_t cond) -> bool {
    if (draft_count >= kMaxCffEdges || draft_count >= max_out_edges) return false;
    draft[draft_count].src_block = src_id;
    draft[draft_count].dst_block = dst_id;
    draft[draft_count].kind = kind;
    draft[draft_count].cond_id = cond;
    ++draft_count;
    return true;
  };

  // Recover mandatory entry -> first real block edge.
  {
    const uint32_t target_idx = find_block_by_state(
        blocks, block_count, blocks[entry_idx].next_state_true, state_var, disp_idx);
    if (target_idx == kNone) {
      out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
      out_result->guard_fail_reason = HEX_CFF_GUARD_UNRESOLVED_EDGE;
      return HEX_OK;
    }
    if (!push_draft(blocks[entry_idx].block_id, blocks[target_idx].block_id,
                    HEX_CFF_EDGE_UNCOND, 0u)) {
      out_result->status = HEX_CFF_STATUS_ABORT_BUDGET;
      out_result->guard_fail_reason = HEX_CFF_GUARD_BUDGET_EXCEEDED;
      return HEX_ERR_RESOURCE_LIMIT;
    }
    ++uncond_count;
  }

  // Recover transitions for every real block.
  for (uint32_t i = 0u; i < block_count; ++i) {
    if (is_real[i] == 0u) continue;
    const HexCffBlock& blk = blocks[i];

    if ((blk.flags & HEX_CFF_BLK_HAS_EXIT) != 0u) {
      continue;
    }

    if ((blk.flags & HEX_CFF_BLK_COND_UPDATE) != 0u) {
      const uint32_t t_idx =
          find_block_by_state(blocks, block_count, blk.next_state_true, state_var, disp_idx);
      const uint32_t f_idx =
          find_block_by_state(blocks, block_count, blk.next_state_false, state_var, disp_idx);
      if (t_idx == kNone || f_idx == kNone) {
        out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
        out_result->guard_fail_reason = HEX_CFF_GUARD_UNRESOLVED_EDGE;
        return HEX_OK;
      }
      if (!push_draft(blk.block_id, blocks[t_idx].block_id, HEX_CFF_EDGE_COND_TRUE, blk.cond_id) ||
          !push_draft(blk.block_id, blocks[f_idx].block_id, HEX_CFF_EDGE_COND_FALSE, blk.cond_id)) {
        out_result->status = HEX_CFF_STATUS_ABORT_BUDGET;
        out_result->guard_fail_reason = HEX_CFF_GUARD_BUDGET_EXCEEDED;
        return HEX_ERR_RESOURCE_LIMIT;
      }
      cond_count += 2u;
    } else if ((blk.flags & HEX_CFF_BLK_UPDATES_STATE) != 0u) {
      const uint32_t t_idx =
          find_block_by_state(blocks, block_count, blk.next_state_true, state_var, disp_idx);
      if (t_idx == kNone) {
        out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
        out_result->guard_fail_reason = HEX_CFF_GUARD_UNRESOLVED_EDGE;
        return HEX_OK;
      }
      if (!push_draft(blk.block_id, blocks[t_idx].block_id, HEX_CFF_EDGE_UNCOND, 0u)) {
        out_result->status = HEX_CFF_STATUS_ABORT_BUDGET;
        out_result->guard_fail_reason = HEX_CFF_GUARD_BUDGET_EXCEEDED;
        return HEX_ERR_RESOURCE_LIMIT;
      }
      ++uncond_count;
    } else {
      out_result->status = HEX_CFF_STATUS_ABORT_GUARD;
      out_result->guard_fail_reason = HEX_CFF_GUARD_UNRESOLVED_EDGE;
      return HEX_OK;
    }
  }

  for (uint32_t i = 0u; i < draft_count; ++i) {
    out_edges[i] = draft[i];
  }

  out_result->status = HEX_CFF_STATUS_RECOVERED;
  out_result->guard_fail_reason = HEX_CFF_GUARD_NONE;
  out_result->real_block_count = real_count;
  out_result->spine_block_count = spine_count;
  out_result->recovered_edge_count = draft_count;
  out_result->uncond_edge_count = uncond_count;
  out_result->cond_edge_count = cond_count;
  out_result->exit_block_count = exit_count;
  return HEX_OK;
}

}  // extern "C"
