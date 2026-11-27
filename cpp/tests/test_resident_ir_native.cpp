#include <cassert>
#include <cstdio>
#include <vector>

#include "../src/semantics/resident_ir.hpp"

using hex::Arena;
using hex::ir::IrFunction;
using hex::ir::IrPhi;
using hex::ir::IrPhiIncoming;
using hex::ir::IrStore;
using hex::ir::kNone;

static bool df_contains(const IrFunction& fn, uint32_t block, uint32_t target) {
  for (uint32_t i = fn.df_off[block]; i < fn.df_off[block + 1]; ++i) {
    if (fn.df_blocks[i] == target) return true;
  }
  return false;
}

static const IrPhi* find_phi(const IrFunction& fn, uint32_t block, uint32_t var_id) {
  for (uint32_t p = fn.block_phi_off[block]; p < fn.block_phi_off[block + 1]; ++p) {
    if (fn.phis[p].var_id == var_id) return &fn.phis[p];
  }
  return nullptr;
}

static uint32_t phi_incoming_val(const IrFunction& fn, const IrPhi& phi, uint32_t pred) {
  for (uint32_t i = 0; i < phi.incoming_count; ++i) {
    const IrPhiIncoming& inc = fn.phi_incoming[phi.incoming_offset + i];
    if (inc.pred_block_id == pred) return inc.ssa_value_id;
  }
  return kNone;
}

static uint32_t use_count_of(const IrFunction& fn, uint32_t ssa_val) {
  return fn.use_off[ssa_val + 1] - fn.use_off[ssa_val];
}

// 1. Unified sub-opcode & flag constant sanity
static void test_unified_subop_constants() {
  static_assert(HEX_IR_BIN_ADD == 0 && HEX_IR_BIN_UREM == 10, "BIN sub-opcodes 0..10");
  static_assert(HEX_IR_UN_NEG == 0 && HEX_IR_UN_SEXT32 == 3, "UN sub-opcodes 0..3");
  static_assert(HEX_IR_FLAG_WIDTH32 == 0x10u, "WIDTH32 flag == 0x10");
  static_assert((HEX_IR_BIN_UREM & HEX_IR_FLAG_WIDTH32) == 0u, "no overlap with WIDTH32");
}

// 2. Diamond CFG + determinism + idempotence
static void test_diamond_and_determinism() {
  HexIrHandle h1 = 0;
  assert(hex_ir_create(0, &h1) == HEX_OK);
  assert(h1 != 0);

  for (int i = 0; i < 4; ++i) assert(hex_ir_add_block(h1, nullptr) == HEX_OK);
  assert(hex_ir_add_edge(h1, 0, 2) == HEX_OK);
  assert(hex_ir_add_edge(h1, 0, 1) == HEX_OK);
  assert(hex_ir_add_edge(h1, 0, 1) == HEX_OK);  // duplicate
  assert(hex_ir_add_edge(h1, 2, 3) == HEX_OK);
  assert(hex_ir_add_edge(h1, 1, 3) == HEX_OK);

  constexpr uint32_t VAR_X = 10, VAR_Y = 20;
  uint32_t i_b1 = 0, i_b2 = 0, i_use = 0;
  assert(hex_ir_add_inst(h1, 0, HEX_IR_OP_CONST, 0, VAR_X, kNone, kNone, kNone, 1, nullptr) == HEX_OK);
  assert(hex_ir_add_inst(h1, 1, HEX_IR_OP_CONST, 0, VAR_X, kNone, kNone, kNone, 2, &i_b1) == HEX_OK);
  assert(hex_ir_add_inst(h1, 2, HEX_IR_OP_CONST, 0, VAR_X, kNone, kNone, kNone, 3, &i_b2) == HEX_OK);
  assert(hex_ir_add_inst(h1, 3, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, VAR_Y, VAR_X, VAR_X, kNone, 0, &i_use) == HEX_OK);
  assert(hex_ir_add_inst(h1, 3, HEX_IR_OP_RET, 0, kNone, VAR_Y, kNone, kNone, 0, nullptr) == HEX_OK);

  assert(hex_ir_run_cfg_and_ssa(h1) == HEX_OK);
  HexIrStats st1{};
  assert(hex_ir_get_stats(h1, &st1) == HEX_OK);
  assert(st1.block_count == 4 && st1.edge_count == 4 && st1.phi_count == 1);
  assert(st1.cfg_ready == 1 && st1.ssa_ready == 1);

  const IrFunction* fn = hex::ir::default_store().lookup(h1);
  assert(fn != nullptr);
  assert(fn->blocks[0].idom == kNone && fn->blocks[3].idom == 0);
  assert(fn->blocks[0].ipdom == 3 && fn->blocks[1].ipdom == 3 && fn->blocks[2].ipdom == 3);
  assert(df_contains(*fn, 1, 3) && df_contains(*fn, 2, 3) && !df_contains(*fn, 0, 3));

  const IrPhi* phi = find_phi(*fn, 3, VAR_X);
  assert(phi != nullptr && phi->incoming_count == 2);
  assert(phi_incoming_val(*fn, *phi, 1) == fn->inst_ssa_dst[i_b1]);
  assert(phi_incoming_val(*fn, *phi, 2) == fn->inst_ssa_dst[i_b2]);
  assert(fn->inst_ssa_arg0[i_use] == phi->ssa_value_id);
  assert(use_count_of(*fn, phi->ssa_value_id) == 2);

  assert(hex_ir_run_cfg_and_ssa(h1) == HEX_OK);
  HexIrStats st_rerun{};
  assert(hex_ir_get_stats(h1, &st_rerun) == HEX_OK);
  assert(st_rerun.digest_lo64 == st1.digest_lo64 && st_rerun.digest_hi64 == st1.digest_hi64);
  assert(hex_ir_release(h1) == HEX_OK);
}

// 3. Loops (standard loop, entry-headed loop, side-entry loop guard, nested loops)
static void test_loops_and_nesting() {
  // Standard loop: 0 -> 1 -> {2, 3}, 2 -> 1
  HexIrHandle h = 0;
  assert(hex_ir_create(0, &h) == HEX_OK);
  for (int i = 0; i < 4; ++i) assert(hex_ir_add_block(h, nullptr) == HEX_OK);
  assert(hex_ir_add_edge(h, 0, 1) == HEX_OK);
  assert(hex_ir_add_edge(h, 1, 2) == HEX_OK);
  assert(hex_ir_add_edge(h, 1, 3) == HEX_OK);
  assert(hex_ir_add_edge(h, 2, 1) == HEX_OK);

  constexpr uint32_t VAR_I = 1;
  uint32_t i_init = 0, i_cmp = 0, i_inc = 0, i_ret = 0;
  assert(hex_ir_add_inst(h, 0, HEX_IR_OP_CONST, 0, VAR_I, kNone, kNone, kNone, 0, &i_init) == HEX_OK);
  assert(hex_ir_add_inst(h, 1, HEX_IR_OP_CMP, 0, kNone, VAR_I, kNone, kNone, 10, &i_cmp) == HEX_OK);
  assert(hex_ir_add_inst(h, 2, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, VAR_I, VAR_I, kNone, kNone, 1, &i_inc) == HEX_OK);
  assert(hex_ir_add_inst(h, 3, HEX_IR_OP_RET, 0, kNone, VAR_I, kNone, kNone, 0, &i_ret) == HEX_OK);

  assert(hex_ir_run_cfg_and_ssa(h) == HEX_OK);
  const IrFunction* fn = hex::ir::default_store().lookup(h);
  assert(fn->blocks[1].loop_header == 1 && fn->blocks[2].loop_header == 1 && fn->blocks[3].loop_header == kNone);
  const IrPhi* phi = find_phi(*fn, 1, VAR_I);
  assert(phi != nullptr && phi->incoming_count == 2);
  assert(phi_incoming_val(*fn, *phi, 0) == fn->inst_ssa_dst[i_init]);
  assert(phi_incoming_val(*fn, *phi, 2) == fn->inst_ssa_dst[i_inc]);
  assert(fn->inst_ssa_arg0[i_cmp] == phi->ssa_value_id);
  assert(fn->inst_ssa_arg0[i_ret] == phi->ssa_value_id);
  assert(hex_ir_release(h) == HEX_OK);

  // Entry-headed loop: 0 -> {1, 2}, 1 -> 0
  HexIrHandle he = 0;
  assert(hex_ir_create(0, &he) == HEX_OK);
  for (int i = 0; i < 3; ++i) assert(hex_ir_add_block(he, nullptr) == HEX_OK);
  assert(hex_ir_add_edge(he, 0, 1) == HEX_OK);
  assert(hex_ir_add_edge(he, 0, 2) == HEX_OK);
  assert(hex_ir_add_edge(he, 1, 0) == HEX_OK);
  uint32_t ie_upd = 0;
  assert(hex_ir_add_inst(he, 0, HEX_IR_OP_CMP, 0, kNone, VAR_I, kNone, kNone, 0, nullptr) == HEX_OK);
  assert(hex_ir_add_inst(he, 1, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, VAR_I, VAR_I, kNone, kNone, 1, &ie_upd) == HEX_OK);
  assert(hex_ir_add_inst(he, 2, HEX_IR_OP_RET, 0, kNone, VAR_I, kNone, kNone, 0, nullptr) == HEX_OK);
  assert(hex_ir_run_cfg_and_ssa(he) == HEX_OK);
  const IrFunction* fne = hex::ir::default_store().lookup(he);
  const IrPhi* ephi = find_phi(*fne, 0, VAR_I);
  assert(ephi != nullptr && ephi->incoming_count == 2);
  assert(fne->phi_incoming[ephi->incoming_offset + 0].pred_block_id == kNone);
  assert(fne->phi_incoming[ephi->incoming_offset + 1].pred_block_id == 1);
  assert(fne->phi_incoming[ephi->incoming_offset + 1].ssa_value_id == fne->inst_ssa_dst[ie_upd]);
  assert(hex_ir_release(he) == HEX_OK);

  // Side-entry loop guard: 0 -> {1, 2}, 1 -> 2, 2 -> {3, 4}, 3 -> 2
  HexIrHandle hs = 0;
  assert(hex_ir_create(0, &hs) == HEX_OK);
  for (int i = 0; i < 5; ++i) assert(hex_ir_add_block(hs, nullptr) == HEX_OK);
  assert(hex_ir_add_edge(hs, 0, 1) == HEX_OK);
  assert(hex_ir_add_edge(hs, 0, 2) == HEX_OK);
  assert(hex_ir_add_edge(hs, 1, 2) == HEX_OK);
  assert(hex_ir_add_edge(hs, 2, 3) == HEX_OK);
  assert(hex_ir_add_edge(hs, 2, 4) == HEX_OK);
  assert(hex_ir_add_edge(hs, 3, 2) == HEX_OK);
  assert(hex_ir_run_cfg_and_ssa(hs) == HEX_OK);
  const IrFunction* fns = hex::ir::default_store().lookup(hs);
  assert(fns->blocks[0].loop_header == kNone && fns->blocks[1].loop_header == kNone);
  assert(fns->blocks[2].loop_header == 2 && fns->blocks[3].loop_header == 2);
  assert(hex_ir_release(hs) == HEX_OK);
}

// 4. Ascending var_id PHI ordering ([var=2, var=10]) & post-sort IrUse.operand_slot parity
static void test_phi_var_order_and_operand_slot_parity() {
  // 0 -> {2, 3}, 3 -> 1, 2 -> 4, 1 -> 4 (DFS visits pred=2 before pred=1, sorted to [1, 2])
  HexIrHandle h = 0;
  assert(hex_ir_create(0, &h) == HEX_OK);
  for (int i = 0; i < 5; ++i) assert(hex_ir_add_block(h, nullptr) == HEX_OK);
  assert(hex_ir_add_edge(h, 0, 2) == HEX_OK);
  assert(hex_ir_add_edge(h, 0, 3) == HEX_OK);
  assert(hex_ir_add_edge(h, 3, 1) == HEX_OK);
  assert(hex_ir_add_edge(h, 2, 4) == HEX_OK);
  assert(hex_ir_add_edge(h, 1, 4) == HEX_OK);

  constexpr uint32_t VAR_TEN = 10, VAR_TWO = 2;
  uint32_t i_b2_10 = 0, i_b2_2 = 0, i_b1_10 = 0, i_b1_2 = 0;
  assert(hex_ir_add_inst(h, 0, HEX_IR_OP_CONST, 0, VAR_TEN, kNone, kNone, kNone, 100, nullptr) == HEX_OK);
  assert(hex_ir_add_inst(h, 0, HEX_IR_OP_CONST, 0, VAR_TWO, kNone, kNone, kNone, 200, nullptr) == HEX_OK);
  assert(hex_ir_add_inst(h, 2, HEX_IR_OP_CONST, 0, VAR_TEN, kNone, kNone, kNone, 101, &i_b2_10) == HEX_OK);
  assert(hex_ir_add_inst(h, 2, HEX_IR_OP_CONST, 0, VAR_TWO, kNone, kNone, kNone, 201, &i_b2_2) == HEX_OK);
  assert(hex_ir_add_inst(h, 1, HEX_IR_OP_CONST, 0, VAR_TEN, kNone, kNone, kNone, 102, &i_b1_10) == HEX_OK);
  assert(hex_ir_add_inst(h, 1, HEX_IR_OP_CONST, 0, VAR_TWO, kNone, kNone, kNone, 202, &i_b1_2) == HEX_OK);
  assert(hex_ir_add_inst(h, 4, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, VAR_TEN, VAR_TEN, VAR_TWO, kNone, 0, nullptr) == HEX_OK);
  assert(hex_ir_add_inst(h, 4, HEX_IR_OP_RET, 0, kNone, VAR_TEN, kNone, kNone, 0, nullptr) == HEX_OK);

  assert(hex_ir_run_cfg_and_ssa(h) == HEX_OK);
  const IrFunction* fn = hex::ir::default_store().lookup(h);
  const uint32_t pb = fn->block_phi_off[4], pe = fn->block_phi_off[5];
  assert(pe - pb == 2);
  assert(fn->phis[pb + 0].var_id == VAR_TWO);
  assert(fn->phis[pb + 1].var_id == VAR_TEN);

  for (uint32_t p = pb; p < pe; ++p) {
    assert(fn->phi_incoming[fn->phis[p].incoming_offset + 0].pred_block_id == 1);
    assert(fn->phi_incoming[fn->phis[p].incoming_offset + 1].pred_block_id == 2);
  }
  assert(fn->phi_incoming[fn->phis[pb + 0].incoming_offset + 0].ssa_value_id == fn->inst_ssa_dst[i_b1_2]);
  assert(fn->phi_incoming[fn->phis[pb + 0].incoming_offset + 1].ssa_value_id == fn->inst_ssa_dst[i_b2_2]);
  assert(fn->phi_incoming[fn->phis[pb + 1].incoming_offset + 0].ssa_value_id == fn->inst_ssa_dst[i_b1_10]);
  assert(fn->phi_incoming[fn->phis[pb + 1].incoming_offset + 1].ssa_value_id == fn->inst_ssa_dst[i_b2_10]);

  uint32_t checked = 0;
  for (uint32_t v = 0; v < fn->header.value_count; ++v) {
    for (uint32_t u = fn->use_off[v]; u < fn->use_off[v + 1]; ++u) {
      const hex::ir::IrUse& use = fn->uses[u];
      if (use.user_kind == HEX_IR_USER_PHI) {
        const IrPhi& phi = fn->phis[use.user_index];
        assert(use.operand_slot < phi.incoming_count);
        assert(fn->phi_incoming[phi.incoming_offset + use.operand_slot].ssa_value_id == v);
        ++checked;
      }
    }
  }
  assert(checked == 4);
  assert(hex_ir_release(h) == HEX_OK);
}

// 5. Generational Handle UAF & Validation
static void test_handle_uaf_and_validation() {
  HexIrStats st{};
  assert(hex_ir_create(0, nullptr) == HEX_ERR_INVALID_ARG);
  assert(hex_ir_release(0) == HEX_ERR_INVALID_ARG);
  assert(hex_ir_get_stats(0, &st) == HEX_ERR_INVALID_ARG);

  HexIrHandle h1 = 0;
  assert(hex_ir_create(0, &h1) == HEX_OK && h1 != 0);
  assert(hex_ir_add_block(h1, nullptr) == HEX_OK);
  assert(hex_ir_add_edge(h1, 0, 99) == HEX_ERR_INVALID_ARG);
  assert(hex_ir_release(h1) == HEX_OK);
  assert(hex_ir_release(h1) == HEX_ERR_INVALID_ARG);
  assert(hex_ir_get_stats(h1, &st) == HEX_ERR_INVALID_ARG);

  HexIrHandle h2 = 0;
  assert(hex_ir_create(0, &h2) == HEX_OK);
  assert(h2 != h1 && (h2 & 0x00ffffffu) == (h1 & 0x00ffffffu) && (h2 >> 24) != (h1 >> 24));
  assert(hex_ir_get_stats(h1, &st) == HEX_ERR_INVALID_ARG);
  assert(hex_ir_get_stats(h2, &st) == HEX_OK);
  assert(hex_ir_release(h2) == HEX_OK);
}

// 6. OOM fail-closed & 2-Arena Zero-Leak Reclamation
static void test_oom_and_zero_leak() {
  bool saw_oom_create = false, saw_oom_build = false, saw_oom_run = false, saw_ok = false;
  const size_t sizes[] = {64, 512, 1024, 1536, 2048, 4096, 8192, 65536};
  for (size_t cap : sizes) {
    std::vector<uint8_t> pbuf(cap), sbuf(cap);
    Arena pa, sa;
    pa.init_fixed(pbuf.data(), pbuf.size());
    sa.init_fixed(sbuf.data(), sbuf.size());
    IrStore store;
    store.init(&pa, &sa);

    HexIrHandle h = 0;
    HexStatus st = store.create(0, &h);
    if (st == HEX_ERR_OOM) { saw_oom_create = true; continue; }
    assert(st == HEX_OK);

    bool build_oom = false;
    for (int b = 0; b < 4; ++b) {
      st = store.add_block(h, nullptr);
      if (st == HEX_ERR_OOM) { build_oom = true; break; }
      assert(st == HEX_OK);
    }
    if (!build_oom) {
      const uint32_t edges[4][2] = {{0, 1}, {0, 2}, {1, 3}, {2, 3}};
      for (int e = 0; e < 4; ++e) {
        st = store.add_edge(h, edges[e][0], edges[e][1]);
        if (st == HEX_ERR_OOM) { build_oom = true; break; }
        assert(st == HEX_OK);
      }
    }
    if (!build_oom) {
      for (uint32_t i = 0; i < 8; ++i) {
        st = store.add_inst(h, i % 4, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, i % 3, (i + 1) % 3, kNone, kNone, i, nullptr);
        if (st == HEX_ERR_OOM) { build_oom = true; break; }
        assert(st == HEX_OK);
      }
    }
    if (build_oom) { saw_oom_build = true; continue; }

    st = store.run_cfg_and_ssa(h);
    assert(sa.used() == 0);
    if (st == HEX_ERR_OOM) saw_oom_run = true;
    else { assert(st == HEX_OK); saw_ok = true; }
  }
  assert(saw_oom_create && saw_oom_build && saw_oom_run && saw_ok);

  // 64-iteration zero-leak reclamation test on 64 KiB persistent + scratch arenas
  std::vector<uint8_t> pbuf(64 * 1024), sbuf(64 * 1024);
  Arena pa, sa;
  pa.init_fixed(pbuf.data(), pbuf.size());
  sa.init_fixed(sbuf.data(), sbuf.size());
  IrStore store;
  store.init(&pa, &sa);
  for (uint32_t iter = 0; iter < 64; ++iter) {
    HexIrHandle h = 0;
    assert(store.create(0, &h) == HEX_OK);
    for (int b = 0; b < 4; ++b) assert(store.add_block(h, nullptr) == HEX_OK);
    assert(store.add_edge(h, 0, 1) == HEX_OK);
    assert(store.add_edge(h, 0, 2) == HEX_OK);
    assert(store.add_edge(h, 1, 3) == HEX_OK);
    assert(store.add_edge(h, 2, 3) == HEX_OK);
    for (uint32_t v = 0; v < 8; ++v) {
      assert(store.add_inst(h, 1, HEX_IR_OP_CONST, 0, v, kNone, kNone, kNone, v + iter, nullptr) == HEX_OK);
      assert(store.add_inst(h, 2, HEX_IR_OP_CONST, 0, v, kNone, kNone, kNone, v + iter + 1, nullptr) == HEX_OK);
      assert(store.add_inst(h, 3, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, v, v, v, kNone, 0, nullptr) == HEX_OK);
    }
    assert(store.run_cfg_and_ssa(h) == HEX_OK);
    assert(sa.used() == 0);
    assert(store.release(h) == HEX_OK);
    assert(store.active_count() == 0 && pa.used() == 0);
  }
}

int main() {
  test_unified_subop_constants();
  test_diamond_and_determinism();
  test_loops_and_nesting();
  test_phi_var_order_and_operand_slot_parity();
  test_handle_uaf_and_validation();
  test_oom_and_zero_leak();
  std::printf("test_resident_ir_native (ASan+UBSan, self-contained): ALL PASS\n");
  return 0;
}
