#include <cassert>
#include <cstdint>
#include <cstdio>
#include <vector>
#include "../src/cfg/cfg_engine.hpp"

static void run_diamond_test() {
  // 0 -> {1, 2}, 1 -> {3}, 2 -> {3}, 3 -> {}
  std::vector<uint8_t> buf(1024 * 1024);
  hex::Arena arena;
  arena.init_external(buf.data(), buf.size());

  uint32_t succ_off[] = {0, 2, 3, 4, 4};
  int32_t succ_dst[] = {1, 2, 3, 3};
  HexCfgResult res{};
  HexStatus st = hex_cfg_analyze_arena(arena, 4, succ_off, succ_dst, 0, nullptr, &res);
  assert(st == HEX_OK);
  assert(res.reach_count == 4);
  // JS DFS order: push 1, 2 -> pop 2, push 3 -> pop 3 -> pop 1
  assert(res.reach_order[0] == 0);
  assert(res.reach_order[1] == 2);
  assert(res.reach_order[2] == 3);
  assert(res.reach_order[3] == 1);
  for (int i = 0; i < 4; ++i) assert(res.reachable_mask[i] == 1);
  assert(res.idom[0] == -1);
  assert(res.idom[1] == 0);
  assert(res.idom[2] == 0);
  assert(res.idom[3] == 0);
  assert(res.pdom_idom[0] == 3);
  assert(res.pdom_idom[1] == 3);
  assert(res.pdom_idom[2] == 3);
  assert(res.pdom_idom[3] == 4);  // synthetic EXIT
  for (int i = 0; i < 4; ++i) assert(res.non_term_mask[i] == 0);
}

static void run_infinite_loop_test() {
  // 0 -> {1, 2}, 1 -> {1} (non-terminating sink), 2 -> {} (exit)
  std::vector<uint8_t> buf(1024 * 1024);
  hex::Arena arena;
  arena.init_external(buf.data(), buf.size());

  uint32_t succ_off[] = {0, 2, 3, 3};
  int32_t succ_dst[] = {1, 2, 1};
  HexCfgResult res{};
  HexStatus st = hex_cfg_analyze_arena(arena, 3, succ_off, succ_dst, 0, nullptr, &res);
  assert(st == HEX_OK);
  assert(res.non_term_mask[0] == 1);
  assert(res.non_term_mask[1] == 1);
  assert(res.non_term_mask[2] == 0);
  assert(res.pdom_idom[0] == 3);  // synthetic EXIT
}

static void run_empty_and_unreachable_test() {
  std::vector<uint8_t> buf(1024 * 1024);
  hex::Arena arena;
  arena.init_external(buf.data(), buf.size());

  uint32_t empty_off[] = {0};
  HexCfgResult res{};
  assert(hex_cfg_analyze_arena(arena, 0, empty_off, nullptr, 0, nullptr, &res) == HEX_OK);

  arena.reset();
  // 0 -> {1}, 1 -> {}, 2 -> {3}, 3 -> {2} (unreachable cycle)
  uint32_t succ_off[] = {0, 1, 1, 2, 3};
  int32_t succ_dst[] = {1, 3, 2};
  assert(hex_cfg_analyze_arena(arena, 4, succ_off, succ_dst, 0, nullptr, &res) == HEX_OK);
  assert(res.reachable_mask[0] == 1 && res.reachable_mask[1] == 1);
  assert(res.reachable_mask[2] == 0 && res.reachable_mask[3] == 0);
  assert(res.component_of[2] == -1 && res.component_of[3] == -1);
}

static void run_oom_and_malformed_csr_test() {
  std::vector<uint8_t> buf(1024 * 1024);
  hex::Arena arena;
  HexCfgResult res{};

  // OOM
  {
    std::vector<uint8_t> tiny(16);
    arena.init_external(tiny.data(), tiny.size());
    uint32_t succ_off[] = {0, 1, 1};
    int32_t succ_dst[] = {1};
    assert(hex_cfg_analyze_arena(arena, 2, succ_off, succ_dst, 0, nullptr, &res) == HEX_ERR_OOM);
  }

  // n > INT32_MAX / 4 => HEX_ERR_RESOURCE_LIMIT
  {
    arena.init_external(buf.data(), buf.size());
    uint32_t off[] = {0};
    assert(hex_cfg_analyze_arena(arena, static_cast<uint32_t>(INT32_MAX / 4) + 1u, off, nullptr, 0, nullptr, &res) == HEX_ERR_RESOURCE_LIMIT);
  }

  // NULL succ_off
  {
    arena.init_external(buf.data(), buf.size());
    assert(hex_cfg_analyze_arena(arena, 0, nullptr, nullptr, 0, nullptr, &res) == HEX_ERR_INVALID_ARG);
    assert(hex_cfg_analyze_arena(arena, 2, nullptr, nullptr, 0, nullptr, &res) == HEX_ERR_INVALID_ARG);
  }

  // succ_off[0] != 0
  {
    arena.init_external(buf.data(), buf.size());
    uint32_t bad_off[] = {1, 1, 2};
    int32_t dst[] = {1, 0};
    assert(hex_cfg_analyze_arena(arena, 2, bad_off, dst, 0, nullptr, &res) == HEX_ERR_INVALID_ARG);
  }

  // Non-monotonic succ_off
  {
    arena.init_external(buf.data(), buf.size());
    uint32_t bad_off[] = {0, 5, 2};
    int32_t dst[] = {1, 0};
    assert(hex_cfg_analyze_arena(arena, 2, bad_off, dst, 0, nullptr, &res) == HEX_ERR_INVALID_ARG);
  }

  // succ_off[n] > 0 && succ_dst == nullptr
  {
    arena.init_external(buf.data(), buf.size());
    uint32_t off[] = {0, 1, 2};
    assert(hex_cfg_analyze_arena(arena, 2, off, nullptr, 0, nullptr, &res) == HEX_ERR_INVALID_ARG);
  }
}

int main() {
  run_diamond_test();
  run_infinite_loop_test();
  run_empty_and_unreachable_test();
  run_oom_and_malformed_csr_test();
  std::printf("test_cfg_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
