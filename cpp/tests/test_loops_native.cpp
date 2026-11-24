#include <cassert>
#include <cstdint>
#include <cstdio>
#include <set>
#include <utility>
#include <vector>

#include "../src/cfg/loop_engine.hpp"

namespace {

struct CsrGraph {
  uint32_t n = 0;
  std::vector<uint32_t> off;
  std::vector<int32_t> dst;
};

CsrGraph build_csr(const std::vector<std::vector<int32_t>>& adj) {
  CsrGraph g;
  g.n = static_cast<uint32_t>(adj.size());
  g.off.resize(g.n + 1, 0);
  for (uint32_t i = 0; i < g.n; ++i) {
    for (int32_t v : adj[i]) g.dst.push_back(v);
    g.off[i + 1] = static_cast<uint32_t>(g.dst.size());
  }
  return g;
}

struct RefLoop {
  int32_t header = -1;
  std::vector<int32_t> latches;
  std::vector<int32_t> nodes;
  std::vector<int32_t> exits;
  int32_t parent = -1;
  int32_t nest_depth = 1;
};

struct RefResult {
  std::vector<std::pair<int32_t, int32_t>> back_edges;
  std::vector<RefLoop> loops;
  std::vector<int32_t> node_loop_depth;
  std::vector<int32_t> node_innermost_loop;
  bool complete = true;
  uint8_t stop_reason = HEX_LOOP_STOP_NONE;
  uint32_t retained_memberships = 0;
  uint32_t walk_steps = 0;
};

RefResult run_reference_oracle(
    const std::vector<std::vector<int32_t>>& raw_succ,
    int32_t entry,
    const HexCfgResult& cfg,
    uint32_t max_memberships = 1048576u,
    uint32_t max_walk_steps = 4194304u) {
  (void)entry;
  const uint32_t n = static_cast<uint32_t>(raw_succ.size());
  std::vector<std::vector<int32_t>> succ(n);
  for (uint32_t i = 0; i < n; ++i) {
    std::set<int32_t> seen;
    for (int32_t x : raw_succ[i]) {
      if (x < 0 || static_cast<uint32_t>(x) >= n) continue;
      if (seen.insert(x).second) succ[i].push_back(x);
    }
  }
  std::vector<std::vector<int32_t>> pred(n);
  for (uint32_t i = 0; i < n; ++i) {
    for (int32_t j : succ[i]) pred[static_cast<uint32_t>(j)].push_back(static_cast<int32_t>(i));
  }

  auto dom = [&](int32_t d, int32_t u) -> bool {
    if (d < 0 || u < 0 || static_cast<uint32_t>(d) >= n || static_cast<uint32_t>(u) >= n) return false;
    if (!cfg.reachable_mask[d] || !cfg.reachable_mask[u]) return false;
    return cfg.dom_tin[d] >= 0 && cfg.dom_tin[d] <= cfg.dom_tin[u] && cfg.dom_tout[u] <= cfg.dom_tout[d];
  };

  RefResult ref;
  ref.node_loop_depth.assign(n, 0);
  ref.node_innermost_loop.assign(n, -1);

  for (uint32_t ri = 0; ri < cfg.reach_count; ++ri) {
    int32_t from = cfg.reach_order[ri];
    for (int32_t to : succ[static_cast<uint32_t>(from)]) {
      if (!cfg.reachable_mask[to]) continue;
      if (cfg.component_of[from] < 0 || cfg.component_of[from] != cfg.component_of[to]) continue;
      if (!dom(to, from)) continue;
      ref.back_edges.emplace_back(from, to);
    }
  }

  std::vector<int32_t> header_to_idx(n, -1);
  for (const auto& edge : ref.back_edges) {
    int32_t latch = edge.first;
    int32_t header = edge.second;
    int32_t lid = header_to_idx[static_cast<uint32_t>(header)];
    if (lid < 0) {
      lid = static_cast<int32_t>(ref.loops.size());
      header_to_idx[static_cast<uint32_t>(header)] = lid;
      RefLoop lp;
      lp.header = header;
      lp.nodes.push_back(header);
      ref.loops.push_back(std::move(lp));
    }
    RefLoop& lp = ref.loops[static_cast<size_t>(lid)];
    bool has_latch = false;
    for (int32_t l : lp.latches) if (l == latch) has_latch = true;
    if (!has_latch) lp.latches.push_back(latch);

    std::vector<int32_t> members;
    std::set<int32_t> member_set;
    members.push_back(header);
    member_set.insert(header);
    std::vector<int32_t> stack;
    if (latch != header) {
      members.push_back(latch);
      member_set.insert(latch);
      stack.push_back(latch);
    }
    bool walk_exhausted = false;
    while (!stack.empty()) {
      int32_t x = stack.back();
      stack.pop_back();
      if (ref.walk_steps >= max_walk_steps) {
        if (ref.walk_steps < UINT32_MAX) ref.walk_steps += 1;
        walk_exhausted = true;
        break;
      }
      ref.walk_steps += 1;
      for (int32_t p : pred[static_cast<uint32_t>(x)]) {
        if (!cfg.reachable_mask[p] || member_set.count(p)) continue;
        if (!dom(header, p)) continue;
        if (cfg.component_of[p] != cfg.component_of[header]) continue;
        member_set.insert(p);
        members.push_back(p);
        if (p != header) stack.push_back(p);
      }
    }
    if (walk_exhausted) {
      ref.stop_reason = HEX_LOOP_STOP_WALK_BUDGET;
      break;
    }
    size_t before = lp.nodes.size();
    std::set<int32_t> existing(lp.nodes.begin(), lp.nodes.end());
    for (int32_t x : members) {
      if (existing.insert(x).second) lp.nodes.push_back(x);
    }
    const uint32_t added = static_cast<uint32_t>(lp.nodes.size() - before);
    if (added > max_memberships - ref.retained_memberships) {
      ref.retained_memberships += added;
      ref.stop_reason = HEX_LOOP_STOP_MEMBERSHIP_BUDGET;
      break;
    }
    ref.retained_memberships += added;
  }

  if (ref.stop_reason == HEX_LOOP_STOP_NONE) {
    for (auto& lp : ref.loops) {
      std::set<int32_t> body(lp.nodes.begin(), lp.nodes.end());
      std::set<int32_t> exit_set;
      for (int32_t x : lp.nodes) {
        for (int32_t y : succ[static_cast<uint32_t>(x)]) {
          if (ref.walk_steps >= max_walk_steps) {
            if (ref.walk_steps < UINT32_MAX) ref.walk_steps += 1;
            ref.stop_reason = HEX_LOOP_STOP_WALK_BUDGET;
            break;
          }
          ref.walk_steps += 1;
          if (!body.count(y) && exit_set.insert(y).second) {
            lp.exits.push_back(y);
          }
        }
        if (ref.stop_reason != HEX_LOOP_STOP_NONE) break;
      }
      if (ref.stop_reason != HEX_LOOP_STOP_NONE) break;
    }
  }

  if (ref.stop_reason != HEX_LOOP_STOP_NONE) {
    ref.complete = false;
    ref.loops.clear();
    ref.retained_memberships = 0;
    return ref;
  }

  ref.retained_memberships = 0;
  for (const auto& lp : ref.loops) {
    ref.retained_memberships += static_cast<uint32_t>(lp.nodes.size());
  }

  const size_t L = ref.loops.size();
  std::vector<std::set<int32_t>> body_sets(L);
  for (size_t i = 0; i < L; ++i) {
    body_sets[i].insert(ref.loops[i].nodes.begin(), ref.loops[i].nodes.end());
  }
  for (size_t i = 0; i < L; ++i) {
    int32_t best_parent = -1;
    size_t best_size = static_cast<size_t>(-1);
    int32_t best_dom_depth = -1;
    for (size_t p = 0; p < L; ++p) {
      if (p == i) continue;
      if (!body_sets[p].count(ref.loops[i].header)) continue;
      const bool strictly_outer =
          (body_sets[p].size() > body_sets[i].size()) ||
          (body_sets[p].size() == body_sets[i].size() &&
           cfg.dom_depth[ref.loops[p].header] < cfg.dom_depth[ref.loops[i].header]);
      if (!strictly_outer) continue;
      if (best_parent < 0 || body_sets[p].size() < best_size ||
          (body_sets[p].size() == best_size &&
           cfg.dom_depth[ref.loops[p].header] > best_dom_depth)) {
        best_parent = static_cast<int32_t>(p);
        best_size = body_sets[p].size();
        best_dom_depth = cfg.dom_depth[ref.loops[p].header];
      }
    }
    ref.loops[i].parent = best_parent;
  }
  for (size_t i = 0; i < L; ++i) {
    int32_t d = 1;
    int32_t cur = ref.loops[i].parent;
    size_t guard = L + 1;
    while (cur >= 0 && guard-- > 0) {
      d += 1;
      cur = ref.loops[static_cast<size_t>(cur)].parent;
    }
    assert(cur < 0);
    ref.loops[i].nest_depth = d;
  }

  for (uint32_t u = 0; u < n; ++u) {
    int32_t best = -1;
    for (size_t i = 0; i < L; ++i) {
      if (!body_sets[i].count(static_cast<int32_t>(u))) continue;
      if (best < 0 ||
          ref.loops[i].nest_depth > ref.loops[static_cast<size_t>(best)].nest_depth ||
          (ref.loops[i].nest_depth == ref.loops[static_cast<size_t>(best)].nest_depth &&
           body_sets[i].size() < body_sets[static_cast<size_t>(best)].size())) {
        best = static_cast<int32_t>(i);
      }
    }
    ref.node_innermost_loop[u] = best;
    ref.node_loop_depth[u] = (best < 0) ? 0 : ref.loops[static_cast<size_t>(best)].nest_depth;
  }

  return ref;
}

void assert_matches_oracle(
    const std::vector<std::vector<int32_t>>& adj,
    int32_t entry,
    uint32_t max_memberships = 1048576u,
    uint32_t max_walk_steps = 4194304u) {
  std::vector<uint8_t> buf(4 * 1024 * 1024);
  hex::Arena arena;
  arena.init_external(buf.data(), buf.size());

  CsrGraph csr = build_csr(adj);
  HexLoopBudget budget{max_memberships, max_walk_steps};
  HexLoopResult res{};
  HexStatus st = hex_loop_analyze_arena(
      arena, csr.n, csr.off.data(), csr.dst.empty() ? nullptr : csr.dst.data(),
      entry, nullptr, &budget, &res);
  assert(st == HEX_OK);

  RefResult ref = run_reference_oracle(adj, entry, res.cfg, max_memberships, max_walk_steps);

  assert(res.complete == (ref.complete ? 1 : 0));
  assert(res.stop_reason == ref.stop_reason);
  assert(res.walk_steps == ref.walk_steps);
  assert(res.retained_memberships == ref.retained_memberships);

  assert(res.num_back_edges == ref.back_edges.size());
  for (uint32_t i = 0; i < res.num_back_edges; ++i) {
    assert(res.back_edge_from[i] == ref.back_edges[i].first);
    assert(res.back_edge_to[i] == ref.back_edges[i].second);
  }

  assert(res.num_loops == ref.loops.size());
  for (uint32_t i = 0; i < res.num_loops; ++i) {
    const RefLoop& rl = ref.loops[i];
    assert(res.loop_header[i] == rl.header);
    assert(res.loop_parent[i] == rl.parent);
    assert(res.loop_nest_depth[i] == rl.nest_depth);
    assert(res.header_to_loop[rl.header] == static_cast<int32_t>(i));

    uint32_t lb = res.loop_latch_off[i], le = res.loop_latch_off[i + 1];
    assert(le - lb == rl.latches.size());
    for (uint32_t k = 0; k < le - lb; ++k) assert(res.loop_latch_nodes[lb + k] == rl.latches[k]);

    uint32_t nb = res.loop_node_off[i], ne = res.loop_node_off[i + 1];
    assert(ne - nb == rl.nodes.size());
    for (uint32_t k = 0; k < ne - nb; ++k) assert(res.loop_body_nodes[nb + k] == rl.nodes[k]);

    uint32_t eb = res.loop_exit_off[i], ee = res.loop_exit_off[i + 1];
    assert(ee - eb == rl.exits.size());
    for (uint32_t k = 0; k < ee - eb; ++k) assert(res.loop_exit_nodes[eb + k] == rl.exits[k]);
  }

  for (uint32_t u = 0; u < csr.n; ++u) {
    assert(res.node_innermost_loop[u] == ref.node_innermost_loop[u]);
    assert(res.node_loop_depth[u] == ref.node_loop_depth[u]);
  }
}

void test_handcrafted_loop_structures() {
  // 1. Simple while loop
  assert_matches_oracle({{1}, {2, 3}, {1}, {}}, 0);
  // 2. Self-loop
  assert_matches_oracle({{1}, {1, 2}, {}}, 0);
  // 3. Multi-latch loop
  assert_matches_oracle({{1}, {2, 3, 4}, {1}, {1}, {}}, 0);
  // 4. 3-level nested loop + sibling inner loops
  {
    std::vector<std::vector<int32_t>> adj = {
        {1}, {2, 7}, {3, 4}, {3, 2}, {5}, {6, 1}, {5}, {}};
    assert_matches_oracle(adj, 0);
    std::vector<uint8_t> buf(1024 * 1024);
    hex::Arena arena;
    arena.init_external(buf.data(), buf.size());
    CsrGraph csr = build_csr(adj);
    HexLoopResult res{};
    assert(hex_loop_analyze_arena(arena, csr.n, csr.off.data(), csr.dst.data(), 0, nullptr, nullptr, &res) == HEX_OK);
    assert(res.num_loops == 4);
    int32_t l0 = res.header_to_loop[1];
    int32_t l1a = res.header_to_loop[2];
    int32_t l2 = res.header_to_loop[3];
    int32_t l1b = res.header_to_loop[5];
    assert(res.loop_parent[l0] == -1 && res.loop_nest_depth[l0] == 1);
    assert(res.loop_parent[l1a] == l0 && res.loop_nest_depth[l1a] == 2);
    assert(res.loop_parent[l1b] == l0 && res.loop_nest_depth[l1b] == 2);
    assert(res.loop_parent[l2] == l1a && res.loop_nest_depth[l2] == 3);
    assert(res.node_loop_depth[3] == 3);
  }
  // 5. Irreducible CFG (no natural back-edge)
  assert_matches_oracle({{1, 2}, {2}, {1, 3}, {}}, 0);
  // 6. Duplicate & out-of-range edges normalization
  assert_matches_oracle({{-5, 1, 1, 99}, {2, 2, 3, -1}, {1, 1}, {}}, 0);
  // 7. Empty graph, invalid entry, unreachable cycle
  assert_matches_oracle({}, 0);
  assert_matches_oracle({{0}}, -1);
  assert_matches_oracle({{0}}, 5);
  assert_matches_oracle({{1}, {}, {3}, {2}}, 0);

  std::printf("  [PASS] handcrafted loop structures & edge cases\n");
}

void test_budgets_oom_deep_and_malformed_csr() {
  // Walk & membership budget fail-closed
  assert_matches_oracle({{1}, {2, 5}, {3}, {4}, {1}, {}}, 0, 1000, 1);
  assert_matches_oracle({{1}, {2, 5}, {3}, {4}, {1}, {}}, 0, 2, 1000);
  // UINT32_MAX budget must not wrap
  assert_matches_oracle({{1}, {2, 3}, {1}, {}}, 0, UINT32_MAX, UINT32_MAX);

  // OOM
  {
    std::vector<uint8_t> tiny(16);
    hex::Arena arena;
    arena.init_external(tiny.data(), tiny.size());
    uint32_t off[] = {0, 1, 2};
    int32_t dst[] = {1, 0};
    HexLoopResult res{};
    assert(hex_loop_analyze_arena(arena, 2, off, dst, 0, nullptr, nullptr, &res) == HEX_ERR_OOM);
  }

  // Deep non-recursive chain loop (N=4096)
  {
    const uint32_t N = 4096;
    std::vector<std::vector<int32_t>> adj(N);
    for (uint32_t i = 0; i + 1 < N; ++i) adj[i].push_back(static_cast<int32_t>(i + 1));
    adj[N - 1].push_back(0);
    std::vector<uint8_t> buf(8 * 1024 * 1024);
    hex::Arena arena;
    arena.init_external(buf.data(), buf.size());
    CsrGraph csr = build_csr(adj);
    HexLoopResult res{};
    assert(hex_loop_analyze_arena(arena, csr.n, csr.off.data(), csr.dst.data(), 0, nullptr, nullptr, &res) == HEX_OK);
    assert(res.complete == 1 && res.num_loops == 1 && res.loop_node_off[1] == N);
  }

  // Malformed CSR negative tests
  {
    std::vector<uint8_t> buf(1024 * 1024);
    hex::Arena arena;
    HexLoopResult res{};
    uint32_t ok_off[] = {0};
    arena.init_external(buf.data(), buf.size());
    assert(hex_loop_analyze_arena(arena, static_cast<uint32_t>(INT32_MAX / 4) + 1u, ok_off, nullptr, 0, nullptr, nullptr, &res) == HEX_ERR_RESOURCE_LIMIT);
    arena.init_external(buf.data(), buf.size());
    assert(hex_loop_analyze_arena(arena, 0, nullptr, nullptr, 0, nullptr, nullptr, &res) == HEX_ERR_INVALID_ARG);
    uint32_t bad0[] = {1, 1, 2};
    int32_t dst[] = {1, 0};
    assert(hex_loop_analyze_arena(arena, 2, bad0, dst, 0, nullptr, nullptr, &res) == HEX_ERR_INVALID_ARG);
    uint32_t nonmono[] = {0, 5, 2};
    assert(hex_loop_analyze_arena(arena, 2, nonmono, dst, 0, nullptr, nullptr, &res) == HEX_ERR_INVALID_ARG);
    uint32_t need_dst[] = {0, 1, 2};
    assert(hex_loop_analyze_arena(arena, 2, need_dst, nullptr, 0, nullptr, nullptr, &res) == HEX_ERR_INVALID_ARG);
  }

  // Public C ABI smoke + alignment guard
  {
    hex_loop_reset();
    const uint32_t off_h = hex_loop_alloc(16);
    const uint32_t dst_h = hex_loop_alloc(16);
    assert(off_h != 0 && dst_h != 0);
    assert(hex_loop_analyze(0, off_h, 0, 0, 0, 0, 0) == HEX_OK);
    assert(hex_loop_get_ptr(HEX_LOOP_FIELD_COMPLETE) == 1);
    assert(hex_loop_analyze(0, 0, 0, 0, 0, 0, 0) == HEX_ERR_INVALID_ARG);
    assert(hex_loop_analyze(1, off_h + 1u, 0, 0, 0, 0, 0) == HEX_ERR_INVALID_ARG);
    assert(hex_loop_analyze(1, off_h, dst_h + 2u, 0, 0, 0, 0) == HEX_ERR_INVALID_ARG);
  }

  std::printf("  [PASS] budgets, OOM, deep chain (N=4096), malformed CSR, and C ABI\n");
}

void test_random_500_cfgs() {
  uint64_t rng = 0x9e3779b97f4a7c15ULL;
  auto next_u64 = [&]() -> uint64_t {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
  };

  const int kNumGraphs = 500;
  uint64_t total_loops = 0, total_be = 0;
  int32_t max_nest = 0;

  for (int g = 0; g < kNumGraphs; ++g) {
    const uint32_t n = 1u + static_cast<uint32_t>(next_u64() % 48u);
    std::vector<std::vector<int32_t>> adj(n);
    for (uint32_t u = 0; u < n; ++u) {
      if (u + 1 < n && (next_u64() % 3u) != 0u) adj[u].push_back(static_cast<int32_t>(u + 1));
      const uint32_t deg = static_cast<uint32_t>(next_u64() % 4u);
      for (uint32_t d = 0; d < deg; ++d) adj[u].push_back(static_cast<int32_t>(next_u64() % n));
    }
    const int32_t entry = static_cast<int32_t>(next_u64() % n);
    assert_matches_oracle(adj, entry);

    std::vector<uint8_t> buf(1024 * 1024);
    hex::Arena arena;
    arena.init_external(buf.data(), buf.size());
    CsrGraph csr = build_csr(adj);
    HexLoopResult res{};
    assert(hex_loop_analyze_arena(arena, csr.n, csr.off.data(), csr.dst.empty() ? nullptr : csr.dst.data(), entry, nullptr, nullptr, &res) == HEX_OK);
    total_be += res.num_back_edges;
    total_loops += res.num_loops;
    for (uint32_t i = 0; i < res.num_loops; ++i) {
      if (res.loop_nest_depth[i] > max_nest) max_nest = res.loop_nest_depth[i];
    }
  }

  std::printf("  [PASS] %d random CFGs matched oracle 100%% (backEdges=%llu, loops=%llu, maxNest=%d)\n",
              kNumGraphs,
              static_cast<unsigned long long>(total_be),
              static_cast<unsigned long long>(total_loops),
              max_nest);
}

}  // namespace

int main() {
  std::printf("Running test_loops_native...\n");
  test_handcrafted_loop_structures();
  test_budgets_oom_deep_and_malformed_csr();
  test_random_500_cfgs();
  std::printf("test_loops_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
