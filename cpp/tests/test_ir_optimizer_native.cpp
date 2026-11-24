#include <cassert>
#include <cstdint>
#include <cstdio>
#include <vector>

#include "../src/decompiler/ir_optimizer.hpp"

namespace {

using hex::Arena;
using hex::decomp::OptStats;
using hex::decomp::optimize_ir;
using hex::ir::IrBlock;
using hex::ir::IrFunction;
using hex::ir::IrInst;
using hex::ir::IrPhi;
using hex::ir::IrPhiIncoming;
using hex::ir::kNone;

struct IrHarness {
  std::vector<uint8_t> persist_buf;
  std::vector<uint8_t> scratch_buf;
  Arena persist;
  Arena scratch;
  IrFunction fn;
  std::vector<std::vector<uint32_t>> per_block_insts;

  explicit IrHarness(size_t persist_bytes = 2 * 1024 * 1024, size_t scratch_bytes = 2 * 1024 * 1024)
      : persist_buf(persist_bytes), scratch_buf(scratch_bytes) {
    persist.init_fixed(persist_buf.data(), persist_buf.size());
    scratch.init_fixed(scratch_buf.data(), scratch_buf.size());
    fn.init(&persist, 0u);
  }

  uint32_t add_block(uint32_t idom = kNone, bool reachable = true) {
    const uint32_t bid = static_cast<uint32_t>(fn.blocks.size());
    IrBlock blk{};
    blk.idom = idom;
    blk.ipdom = kNone;
    blk.scc_id = bid;
    blk.loop_header = kNone;
    assert(fn.blocks.push_back(blk));
    assert(fn.reachable_mask.push_back(reachable ? 1u : 0u));
    per_block_insts.emplace_back();
    fn.header.block_count = static_cast<uint32_t>(fn.blocks.size());
    if (reachable) ++fn.reachable_count;
    return bid;
  }

  uint32_t alloc_val() { return fn.header.value_count++; }

  uint32_t add_inst(
      uint32_t block_id,
      uint16_t op,
      uint16_t flags,
      uint32_t ssa_dst,
      uint32_t ssa_a0,
      uint32_t ssa_a1 = kNone,
      uint32_t ssa_a2 = kNone,
      uint64_t imm = 0ULL) {
    const uint32_t id = static_cast<uint32_t>(fn.insts.size());
    IrInst ins{};
    ins.op = op;
    ins.flags = flags;
    ins.dst_val = ssa_dst;
    ins.arg0 = ssa_a0;
    ins.arg1 = ssa_a1;
    ins.arg2 = ssa_a2;
    ins.aux_offset = kNone;
    ins.origin_idx = id;
    ins.imm64_or_sym = imm;
    assert(fn.insts.push_back(ins));
    assert(fn.inst_block.push_back(block_id));
    assert(fn.inst_ssa_dst.push_back(ssa_dst));
    assert(fn.inst_ssa_arg0.push_back(ssa_a0));
    assert(fn.inst_ssa_arg1.push_back(ssa_a1));
    assert(fn.inst_ssa_arg2.push_back(ssa_a2));
    per_block_insts[block_id].push_back(id);
    fn.header.inst_count = static_cast<uint32_t>(fn.insts.size());
    return id;
  }

  uint32_t add_phi(uint32_t block_id, uint32_t var_id, uint32_t ssa_val,
                   const std::vector<IrPhiIncoming>& incoming) {
    const uint32_t pid = static_cast<uint32_t>(fn.phis.size());
    IrPhi phi{};
    phi.block_id = block_id;
    phi.var_id = var_id;
    phi.ssa_value_id = ssa_val;
    phi.incoming_offset = static_cast<uint32_t>(fn.phi_incoming.size());
    phi.incoming_count = static_cast<uint32_t>(incoming.size());
    for (const auto& inc : incoming) assert(fn.phi_incoming.push_back(inc));
    assert(fn.phis.push_back(phi));
    return pid;
  }

  void finalize_ssa() {
    fn.block_inst_off.clear();
    fn.block_inst_ids.clear();
    uint32_t cursor = 0u;
    assert(fn.block_inst_off.push_back(0u));
    for (size_t b = 0; b < per_block_insts.size(); ++b) {
      fn.blocks[b].first_inst = cursor;
      fn.blocks[b].inst_count = static_cast<uint32_t>(per_block_insts[b].size());
      for (uint32_t iid : per_block_insts[b]) {
        assert(fn.block_inst_ids.push_back(iid));
        ++cursor;
      }
      assert(fn.block_inst_off.push_back(cursor));
    }
    fn.header.cfg_ready = 1u;
    fn.header.ssa_ready = 1u;
  }
};

void test_const_fold_64_32_shifts_and_divzero() {
  IrHarness h;
  const uint32_t b0 = h.add_block();
  const uint32_t v0 = h.alloc_val();
  const uint32_t v1 = h.alloc_val();
  const uint32_t v_add32 = h.alloc_val();
  const uint32_t v_asr32 = h.alloc_val();
  const uint32_t v_asr64 = h.alloc_val();
  const uint32_t v_shl32 = h.alloc_val();
  const uint32_t v_zero = h.alloc_val();
  const uint32_t v_div0 = h.alloc_val();

  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v0, kNone, kNone, kNone, 0xffffffffULL);
  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v1, kNone, kNone, kNone, 1ULL);
  const uint32_t i_add32 = h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_ADD | HEX_IR_FLAG_WIDTH32, v_add32, v0, v1);
  // ASR32(0x80000000, 35) -> shift masked by 31 => shift 3 => 0xf0000000
  const uint32_t v_neg32 = h.alloc_val();
  const uint32_t v_sh35 = h.alloc_val();
  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v_neg32, kNone, kNone, kNone, 0x80000000ULL);
  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v_sh35, kNone, kNone, kNone, 35ULL);
  const uint32_t i_asr32 = h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_ASR | HEX_IR_FLAG_WIDTH32, v_asr32, v_neg32, v_sh35);
  // ASR64(0x8000000000000000, 65) -> shift masked by 63 => shift 1 => 0xc000000000000000
  const uint32_t v_neg64 = h.alloc_val();
  const uint32_t v_sh65 = h.alloc_val();
  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v_neg64, kNone, kNone, kNone, 0x8000000000000000ULL);
  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v_sh65, kNone, kNone, kNone, 65ULL);
  const uint32_t i_asr64 = h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_ASR, v_asr64, v_neg64, v_sh65);
  const uint32_t i_shl32 = h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_SHL | HEX_IR_FLAG_WIDTH32, v_shl32, v1, v_sh35);
  // UDIV by 0 must NOT fold (fallback preserved)
  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v_zero, kNone, kNone, kNone, 0ULL);
  const uint32_t i_div0 = h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_UDIV, v_div0, v0, v_zero);

  // Anchor all outputs in side-effecting STORE/RET so DCE keeps them
  h.add_inst(b0, HEX_IR_OP_STORE, 0u, kNone, v_add32, v_asr32, v_asr64);
  h.add_inst(b0, HEX_IR_OP_STORE, 0u, kNone, v_shl32, v_div0);
  h.add_inst(b0, HEX_IR_OP_RET, 0u, kNone, v_div0);
  h.finalize_ssa();

  OptStats stats{};
  assert(optimize_ir(h.fn, h.scratch, 16u, &stats) == HEX_OK);
  assert(stats.const_folds >= 4u);
  assert(h.fn.insts[i_add32].op == HEX_IR_OP_CONST && h.fn.insts[i_add32].imm64_or_sym == 0ULL);
  assert(h.fn.insts[i_asr32].op == HEX_IR_OP_CONST && h.fn.insts[i_asr32].imm64_or_sym == 0xf0000000ULL);
  assert(h.fn.insts[i_asr64].op == HEX_IR_OP_CONST && h.fn.insts[i_asr64].imm64_or_sym == 0xc000000000000000ULL);
  assert(h.fn.insts[i_shl32].op == HEX_IR_OP_CONST && h.fn.insts[i_shl32].imm64_or_sym == 8ULL);
  assert(h.fn.insts[i_div0].op == HEX_IR_OP_BIN);
  std::printf("  [PASS] constant folding (64/32 wrap, masked shifts, div-by-zero fallback)\n");
}

void test_width32_identity_lowers_to_zext32() {
  IrHarness h;
  const uint32_t b0 = h.add_block();
  const uint32_t v_arg = h.alloc_val();  // unknown 64-bit value (may have non-zero upper 32 bits)
  const uint32_t v_zero = h.alloc_val();
  const uint32_t v_res32 = h.alloc_val();
  const uint32_t v_res64 = h.alloc_val();

  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v_zero, kNone, kNone, kNone, 0ULL);
  const uint32_t i_add32 = h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_ADD | HEX_IR_FLAG_WIDTH32, v_res32, v_arg, v_zero);
  const uint32_t i_add64 = h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, v_res64, v_arg, v_zero);
  h.add_inst(b0, HEX_IR_OP_STORE, 0u, kNone, v_res32, v_res64);
  h.add_inst(b0, HEX_IR_OP_RET, 0u, kNone, v_res32);
  h.finalize_ssa();

  OptStats stats{};
  assert(optimize_ir(h.fn, h.scratch, 16u, &stats) == HEX_OK);
  // 32-bit identity MUST become HEX_IR_OP_UN / HEX_IR_UN_ZEXT32 (NOT 64-bit MOV!)
  assert(h.fn.insts[i_add32].op == HEX_IR_OP_UN);
  assert(h.fn.insts[i_add32].flags == HEX_IR_UN_ZEXT32);
  assert(h.fn.inst_ssa_arg0[i_add32] == v_arg);
  // 64-bit identity lowers to MOV, gets copy-propagated into STORE, then eliminated by DCE
  assert(h.fn.insts[i_add64].op == HEX_IR_OP_NOP);
  std::printf("  [PASS] WIDTH32 identity lowers to HEX_IR_UN_ZEXT32 (upper-32 zero-ext preserved)\n");
}

void test_cse_cmp_immediate_and_commutativity() {
  IrHarness h;
  const uint32_t b0 = h.add_block();
  const uint32_t b1 = h.add_block(b0);
  const uint32_t v_x = h.alloc_val();
  const uint32_t v_y = h.alloc_val();
  const uint32_t v_cmp1 = h.alloc_val();
  const uint32_t v_cmp2 = h.alloc_val();
  const uint32_t v_cmp3 = h.alloc_val();
  const uint32_t v_sum1 = h.alloc_val();
  const uint32_t v_sum2 = h.alloc_val();

  // CMP with different immediates MUST NOT be merged by CSE
  const uint32_t i_cmp1 = h.add_inst(b0, HEX_IR_OP_CMP, 0u, v_cmp1, v_x, kNone, kNone, 10ULL);
  const uint32_t i_cmp2 = h.add_inst(b0, HEX_IR_OP_CMP, 0u, v_cmp2, v_x, kNone, kNone, 20ULL);
  // CMP with same immediate in dominated block SHOULD be merged by CSE
  const uint32_t i_cmp3 = h.add_inst(b1, HEX_IR_OP_CMP, 0u, v_cmp3, v_x, kNone, kNone, 10ULL);
  // Commutative ADD(x, y) and ADD(y, x) SHOULD be merged by CSE
  h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, v_sum1, v_x, v_y);
  const uint32_t i_sum2 = h.add_inst(b1, HEX_IR_OP_BIN, HEX_IR_BIN_ADD, v_sum2, v_y, v_x);

  const uint32_t i_st1 = h.add_inst(b1, HEX_IR_OP_STORE, 0u, kNone, v_cmp1, v_cmp2, v_cmp3);
  const uint32_t i_st2 = h.add_inst(b1, HEX_IR_OP_STORE, 0u, kNone, v_sum1, v_sum2);
  h.add_inst(b1, HEX_IR_OP_RET, 0u, kNone, v_sum2);
  h.finalize_ssa();

  OptStats stats{};
  assert(optimize_ir(h.fn, h.scratch, 16u, &stats) == HEX_OK);
  assert(stats.cse_eliminations >= 2u);
  assert(h.fn.insts[i_cmp1].op == HEX_IR_OP_CMP);
  assert(h.fn.insts[i_cmp2].op == HEX_IR_OP_CMP);  // distinct imm preserved
  assert(h.fn.insts[i_cmp3].op == HEX_IR_OP_NOP);  // CSE -> MOV -> CopyProp -> DCE
  assert(h.fn.inst_ssa_arg2[i_st1] == v_cmp1);
  assert(h.fn.insts[i_sum2].op == HEX_IR_OP_NOP);
  assert(h.fn.inst_ssa_arg1[i_st2] == v_sum1);
  std::printf("  [PASS] dominator-tree CSE (CMP imm sensitivity + commutative BIN)\n");
}

void test_phi_simplification_and_dce_side_effects() {
  IrHarness h;
  const uint32_t b0 = h.add_block();
  const uint32_t b1 = h.add_block(b0);
  const uint32_t v_in = h.alloc_val();
  const uint32_t v_phi = h.alloc_val();
  const uint32_t v_dead = h.alloc_val();
  const uint32_t v_ld = h.alloc_val();
  const uint32_t v_call = h.alloc_val();

  // Redundant PHI: incoming = [v_in, v_phi (self)] -> simplifies to v_in
  const uint32_t p0 = h.add_phi(b1, 1u, v_phi, {IrPhiIncoming{b0, v_in}, IrPhiIncoming{b1, v_phi}});

  // Dead pure instruction -> must be eliminated by DCE
  const uint32_t i_dead = h.add_inst(b0, HEX_IR_OP_BIN, HEX_IR_BIN_MUL, v_dead, v_in, v_in);
  // All 8 side-effecting ops -> must ALL be preserved by DCE
  const uint32_t i_load = h.add_inst(b1, HEX_IR_OP_LOAD, 0u, v_ld, v_phi);
  const uint32_t i_store = h.add_inst(b1, HEX_IR_OP_STORE, 0u, kNone, v_phi, v_ld);
  const uint32_t i_call = h.add_inst(b1, HEX_IR_OP_CALL, 0u, v_call, v_phi);
  const uint32_t i_sw = h.add_inst(b1, HEX_IR_OP_STATE_WRITE, 0u, kNone, v_phi);
  const uint32_t i_unk = h.add_inst(b1, HEX_IR_OP_UNKNOWN, 0u, kNone, v_phi);
  const uint32_t i_cbr = h.add_inst(b0, HEX_IR_OP_CBR, 0u, kNone, v_in);
  const uint32_t i_br = h.add_inst(b0, HEX_IR_OP_BR, 0u, kNone, kNone);
  const uint32_t i_ret = h.add_inst(b1, HEX_IR_OP_RET, 0u, kNone, v_phi);
  h.finalize_ssa();

  OptStats stats{};
  assert(optimize_ir(h.fn, h.scratch, 16u, &stats) == HEX_OK);
  assert(stats.phi_simplifications == 1u);
  assert(h.fn.phis[p0].ssa_value_id == kNone);
  assert(h.fn.insts[i_dead].op == HEX_IR_OP_NOP);
  assert(h.fn.insts[i_load].op == HEX_IR_OP_LOAD && h.fn.inst_ssa_arg0[i_load] == v_in);
  assert(h.fn.insts[i_store].op == HEX_IR_OP_STORE);
  assert(h.fn.insts[i_call].op == HEX_IR_OP_CALL);
  assert(h.fn.insts[i_sw].op == HEX_IR_OP_STATE_WRITE);
  assert(h.fn.insts[i_unk].op == HEX_IR_OP_UNKNOWN);
  assert(h.fn.insts[i_cbr].op == HEX_IR_OP_CBR);
  assert(h.fn.insts[i_br].op == HEX_IR_OP_BR);
  assert(h.fn.insts[i_ret].op == HEX_IR_OP_RET && h.fn.inst_ssa_arg0[i_ret] == v_in);
  std::printf("  [PASS] PHI simplification + DCE protection for all 8 side-effect ops\n");
}

void test_oom_and_invalid_args() {
  IrHarness h(256 * 1024, 32);  // tiny 32B scratch -> guaranteed OOM
  const uint32_t b0 = h.add_block();
  const uint32_t v0 = h.alloc_val();
  h.add_inst(b0, HEX_IR_OP_CONST, 0u, v0, kNone, kNone, kNone, 7ULL);
  h.add_inst(b0, HEX_IR_OP_RET, 0u, kNone, v0);
  h.finalize_ssa();

  assert(optimize_ir(h.fn, h.scratch, 0u) == HEX_ERR_INVALID_ARG);
  assert(optimize_ir(h.fn, h.scratch, 999u) == HEX_ERR_INVALID_ARG);
  assert(optimize_ir(h.fn, h.scratch, 4u) == HEX_ERR_OOM);

  uint32_t changed = 123u;
  assert(hex_decomp_optimize_ir(0u, 8u, &changed) == HEX_ERR_INVALID_ARG);
  assert(changed == 0u);
  std::printf("  [PASS] OOM fail-closed + invalid-arg / C ABI boundary checks\n");
}

}  // namespace

int main() {
  std::printf("Running test_ir_optimizer_native...\n");
  test_const_fold_64_32_shifts_and_divzero();
  test_width32_identity_lowers_to_zext32();
  test_cse_cmp_immediate_and_commutativity();
  test_phi_simplification_and_dce_side_effects();
  test_oom_and_invalid_args();
  std::printf("test_ir_optimizer_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
