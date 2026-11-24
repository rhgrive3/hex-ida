#include "ir_optimizer.hpp"

namespace hex {
namespace decomp {

namespace {

using hex::ir::IrBlock;
using hex::ir::IrFunction;
using hex::ir::IrInst;
using hex::ir::IrPhi;
using hex::ir::IrPhiIncoming;
using hex::ir::IrUse;
using hex::ir::kNone;

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

void recompute_digest(IrFunction& fn) {
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

  fn.header.digest_lo64 = js::mix64(lo);
  fn.header.digest_hi64 = js::mix64(hi ^ lo);
}

inline uint64_t mask_width(uint64_t v, bool width32) {
  return width32 ? (v & 0xffffffffULL) : v;
}

inline uint64_t all_ones_for(bool width32) {
  return width32 ? 0xffffffffULL : 0xffffffffffffffffULL;
}

// UB-free arithmetic right shift for 64-bit unsigned representation.
inline uint64_t asr64(uint64_t v, uint32_t sh) {
  sh &= 63u;
  if (sh == 0u) return v;
  if ((v & (1ULL << 63)) == 0ULL) return v >> sh;
  const uint64_t fill = ~0ULL << (64u - sh);
  return (v >> sh) | fill;
}

// UB-free arithmetic right shift for 32-bit unsigned representation.
inline uint64_t asr32(uint64_t v, uint32_t sh) {
  const int32_t s = static_cast<int32_t>(static_cast<uint32_t>(v & 0xffffffffULL));
  const int32_t r = js::sar32(s, static_cast<int32_t>(sh & 31u));
  return static_cast<uint64_t>(static_cast<uint32_t>(r));
}

// Evaluate binary operation using wrapping unsigned arithmetic and masked shift widths (UB-free).
bool fold_bin(uint16_t flags, uint64_t lhs, uint64_t rhs, uint64_t* out) {
  const bool w32 = (flags & HEX_IR_FLAG_WIDTH32) != 0u;
  const uint16_t sub = static_cast<uint16_t>(flags & 0x0fu);
  const uint64_t a = mask_width(lhs, w32);
  const uint64_t b = mask_width(rhs, w32);

  switch (sub) {
    case HEX_IR_BIN_ADD:
      *out = mask_width(a + b, w32);
      return true;
    case HEX_IR_BIN_SUB:
      *out = mask_width(a - b, w32);
      return true;
    case HEX_IR_BIN_MUL:
      *out = w32
                 ? static_cast<uint64_t>(static_cast<uint32_t>(
                       js::imul(static_cast<int32_t>(static_cast<uint32_t>(a)),
                                static_cast<int32_t>(static_cast<uint32_t>(b)))))
                 : (a * b);
      return true;
    case HEX_IR_BIN_AND:
      *out = mask_width(a & b, w32);
      return true;
    case HEX_IR_BIN_OR:
      *out = mask_width(a | b, w32);
      return true;
    case HEX_IR_BIN_XOR:
      *out = mask_width(a ^ b, w32);
      return true;
    case HEX_IR_BIN_SHL:
      *out = w32
                 ? static_cast<uint64_t>(static_cast<uint32_t>(
                       js::shl32(static_cast<int32_t>(static_cast<uint32_t>(a)),
                                 static_cast<int32_t>(static_cast<uint32_t>(b)))))
                 : (a << (static_cast<uint32_t>(b) & 63u));
      return true;
    case HEX_IR_BIN_LSR:
      *out = w32
                 ? static_cast<uint64_t>(
                       js::ushr32(static_cast<int32_t>(static_cast<uint32_t>(a)),
                                  static_cast<int32_t>(static_cast<uint32_t>(b))))
                 : (a >> (static_cast<uint32_t>(b) & 63u));
      return true;
    case HEX_IR_BIN_ASR:
      *out = w32 ? asr32(a, static_cast<uint32_t>(b)) : asr64(a, static_cast<uint32_t>(b));
      return true;
    case HEX_IR_BIN_UDIV:
      if (b == 0ULL) return false;
      *out = mask_width(a / b, w32);
      return true;
    case HEX_IR_BIN_UREM:
      if (b == 0ULL) return false;
      *out = mask_width(a % b, w32);
      return true;
    default:
      return false;
  }
}

// Evaluate unary operation (UB-free).
bool fold_un(uint16_t flags, uint64_t val, uint64_t* out) {
  const bool w32 = (flags & HEX_IR_FLAG_WIDTH32) != 0u;
  const uint16_t sub = static_cast<uint16_t>(flags & 0x0fu);
  const uint64_t a = mask_width(val, w32);

  switch (sub) {
    case HEX_IR_UN_NEG:
      *out = mask_width(0ULL - a, w32);
      return true;
    case HEX_IR_UN_NOT:
      *out = mask_width(~a, w32);
      return true;
    case HEX_IR_UN_ZEXT32:
      *out = val & 0xffffffffULL;
      return true;
    case HEX_IR_UN_SEXT32: {
      const uint64_t low = val & 0xffffffffULL;
      *out = (low & 0x80000000ULL) ? (low | 0xffffffff00000000ULL) : low;
      return true;
    }
    default:
      return false;
  }
}

inline bool is_commutative_bin(uint16_t flags) {
  const uint16_t sub = static_cast<uint16_t>(flags & 0x0fu);
  return sub == HEX_IR_BIN_ADD || sub == HEX_IR_BIN_MUL ||
         sub == HEX_IR_BIN_AND || sub == HEX_IR_BIN_OR || sub == HEX_IR_BIN_XOR;
}

inline bool has_side_effects(uint16_t op) {
  switch (op) {
    case HEX_IR_OP_STORE:
    case HEX_IR_OP_LOAD:
    case HEX_IR_OP_CALL:
    case HEX_IR_OP_BR:
    case HEX_IR_OP_CBR:
    case HEX_IR_OP_RET:
    case HEX_IR_OP_STATE_WRITE:
    case HEX_IR_OP_UNKNOWN:
      return true;
    default:
      return false;
  }
}

inline bool is_cse_eligible(uint16_t op) {
  return op == HEX_IR_OP_CONST || op == HEX_IR_OP_BIN ||
         op == HEX_IR_OP_UN || op == HEX_IR_OP_CMP;
}

struct CseKey {
  uint16_t op;
  uint16_t flags;
  uint32_t a0;
  uint32_t a1;
  uint32_t a2;
  uint64_t imm;
};

struct CseKeyTraits {
  static uint64_t hash(const CseKey& k) {
    uint64_t h = js::mix64((static_cast<uint64_t>(k.op) << 16) | k.flags);
    h = js::mix64(h ^ (static_cast<uint64_t>(k.a0) << 32) ^ k.a1);
    h = js::mix64(h ^ (static_cast<uint64_t>(k.a2) << 17) ^ k.imm);
    return h;
  }
  static bool equal(const CseKey& a, const CseKey& b) {
    return a.op == b.op && a.flags == b.flags &&
           a.a0 == b.a0 && a.a1 == b.a1 && a.a2 == b.a2 && a.imm == b.imm;
  }
};

struct CseFrame {
  uint32_t block_id;
  uint32_t child_idx;
  uint32_t undo_start;
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

inline void rewrite_to_const(IrFunction& fn, uint32_t inst_id, uint64_t value) {
  IrInst& ins = fn.insts[inst_id];
  ins.op = HEX_IR_OP_CONST;
  ins.flags = 0u;
  ins.arg0 = kNone;
  ins.arg1 = kNone;
  ins.arg2 = kNone;
  ins.imm64_or_sym = value;
  fn.inst_ssa_arg0[inst_id] = kNone;
  fn.inst_ssa_arg1[inst_id] = kNone;
  fn.inst_ssa_arg2[inst_id] = kNone;
}

inline void rewrite_to_mov(IrFunction& fn, uint32_t inst_id, uint32_t src_ssa) {
  IrInst& ins = fn.insts[inst_id];
  ins.op = HEX_IR_OP_MOV;
  ins.flags = 0u;
  ins.arg1 = kNone;
  ins.arg2 = kNone;
  ins.imm64_or_sym = 0ULL;
  fn.inst_ssa_arg0[inst_id] = src_ssa;
  fn.inst_ssa_arg1[inst_id] = kNone;
  fn.inst_ssa_arg2[inst_id] = kNone;
}

// Preserve upper 32-bit zero-extension semantics when simplifying 32-bit identity ops.
inline void rewrite_to_zext32(IrFunction& fn, uint32_t inst_id, uint32_t src_ssa) {
  IrInst& ins = fn.insts[inst_id];
  ins.op = HEX_IR_OP_UN;
  ins.flags = HEX_IR_UN_ZEXT32;
  ins.arg1 = kNone;
  ins.arg2 = kNone;
  ins.imm64_or_sym = 0ULL;
  fn.inst_ssa_arg0[inst_id] = src_ssa;
  fn.inst_ssa_arg1[inst_id] = kNone;
  fn.inst_ssa_arg2[inst_id] = kNone;
}

inline void rewrite_to_nop(IrFunction& fn, uint32_t inst_id) {
  IrInst& ins = fn.insts[inst_id];
  ins.op = HEX_IR_OP_NOP;
  ins.flags = 0u;
  ins.dst_val = kNone;
  ins.arg0 = kNone;
  ins.arg1 = kNone;
  ins.arg2 = kNone;
  ins.imm64_or_sym = 0ULL;
  fn.inst_ssa_dst[inst_id] = kNone;
  fn.inst_ssa_arg0[inst_id] = kNone;
  fn.inst_ssa_arg1[inst_id] = kNone;
  fn.inst_ssa_arg2[inst_id] = kNone;
}

// Rebuild CSR Def-Use chains on fn.use_off / fn.uses after optimization.
HexStatus rebuild_def_use(IrFunction& fn, Arena& scratch) {
  ArenaScope scope(scratch);
  const uint32_t val_count = fn.header.value_count;
  const uint32_t inst_count = fn.header.inst_count;
  const uint32_t phi_count = static_cast<uint32_t>(fn.phis.size());

  Vec<RawUse> raw_uses(&scratch);
  auto add_use = [&](uint32_t val, uint32_t user_idx, HexIrUserKind kind, uint8_t slot) -> HexStatus {
    if (val == kNone || val >= val_count) return HEX_OK;
    if (raw_uses.size() >= hex::ir::kMaxUses) return HEX_ERR_RESOURCE_LIMIT;
    return raw_uses.push_back(RawUse{val, user_idx, static_cast<uint8_t>(kind), slot, 0u})
               ? HEX_OK
               : HEX_ERR_OOM;
  };

  for (uint32_t i = 0; i < inst_count; ++i) {
    if (fn.insts[i].op == HEX_IR_OP_NOP) continue;
    HexStatus st = add_use(fn.inst_ssa_arg0[i], i, HEX_IR_USER_INST, 0u);
    if (st != HEX_OK) return st;
    st = add_use(fn.inst_ssa_arg1[i], i, HEX_IR_USER_INST, 1u);
    if (st != HEX_OK) return st;
    st = add_use(fn.inst_ssa_arg2[i], i, HEX_IR_USER_INST, 2u);
    if (st != HEX_OK) return st;
  }

  for (uint32_t p = 0; p < phi_count; ++p) {
    const IrPhi& phi = fn.phis[p];
    if (phi.ssa_value_id == kNone || phi.incoming_count == 0u) continue;
    for (uint32_t k = 0; k < phi.incoming_count; ++k) {
      const uint32_t v = fn.phi_incoming[phi.incoming_offset + k].ssa_value_id;
      const HexStatus st = add_use(v, p, HEX_IR_USER_PHI, static_cast<uint8_t>(k & 0xffu));
      if (st != HEX_OK) return st;
    }
  }

  fn.use_off.clear();
  if (!fn.use_off.resize(static_cast<size_t>(val_count) + 1u, 0u)) return HEX_ERR_OOM;
  for (size_t i = 0; i < raw_uses.size(); ++i) {
    fn.use_off[raw_uses[i].ssa_val + 1u]++;
  }
  for (uint32_t v = 0; v < val_count; ++v) {
    fn.use_off[v + 1u] += fn.use_off[v];
  }

  const uint32_t total_uses = fn.use_off[val_count];
  fn.uses.clear();
  if (total_uses > 0u) {
    if (!fn.uses.resize(total_uses, IrUse{})) return HEX_ERR_OOM;
    uint32_t* cur = scratch.alloc<uint32_t>(val_count);
    if (!cur) return HEX_ERR_OOM;
    for (uint32_t v = 0; v < val_count; ++v) cur[v] = fn.use_off[v];
    for (size_t i = 0; i < raw_uses.size(); ++i) {
      const RawUse& ru = raw_uses[i];
      fn.uses[cur[ru.ssa_val]++] = IrUse{ru.user_index, ru.user_kind, ru.operand_slot, 0u};
    }
  }
  return HEX_OK;
}

}  // namespace

HexStatus optimize_ir(
    IrFunction& fn,
    Arena& scratch,
    uint32_t max_iters,
    OptStats* out_stats) {
  if (out_stats) mem_set(out_stats, 0, sizeof(OptStats));
  if (fn.header.ssa_ready == 0u) return HEX_ERR_INVALID_ARG;
  if (max_iters == 0u || max_iters > kMaxOptIters) return HEX_ERR_INVALID_ARG;

  const uint32_t n = fn.header.block_count;
  const uint32_t inst_count = fn.header.inst_count;
  const uint32_t val_count = fn.header.value_count;
  const uint32_t phi_count = static_cast<uint32_t>(fn.phis.size());

  if (n == 0u || (inst_count == 0u && phi_count == 0u)) {
    if (out_stats) out_stats->iterations = 1u;
    return HEX_OK;
  }

  if (fn.header.entry_block >= n ||
      fn.blocks.size() < n ||
      fn.reachable_mask.size() < n ||
      fn.block_inst_off.size() < static_cast<size_t>(n) + 1u ||
      fn.insts.size() < inst_count ||
      fn.inst_block.size() < inst_count ||
      fn.inst_ssa_dst.size() < inst_count ||
      fn.inst_ssa_arg0.size() < inst_count ||
      fn.inst_ssa_arg1.size() < inst_count ||
      fn.inst_ssa_arg2.size() < inst_count) {
    return HEX_ERR_INVALID_ARG;
  }

  ArenaScope top_scope(scratch);

  // Pre-build dominator tree children CSR on scratch (constant across optimization iterations).
  uint32_t* dom_child_off = arena_alloc_zeroed<uint32_t>(scratch, static_cast<size_t>(n) + 1u);
  uint32_t* dom_child_list = scratch.alloc<uint32_t>(n);
  uint32_t* dom_child_cur = scratch.alloc<uint32_t>(n);
  if (!dom_child_off || !dom_child_list || !dom_child_cur) return HEX_ERR_OOM;
  for (uint32_t b = 0; b < n; ++b) {
    if (!fn.reachable_mask[b]) continue;
    const uint32_t idom = fn.blocks[b].idom;
    if (idom != kNone && idom < n) dom_child_off[idom + 1u]++;
  }
  for (uint32_t b = 0; b < n; ++b) dom_child_off[b + 1u] += dom_child_off[b];
  for (uint32_t b = 0; b < n; ++b) dom_child_cur[b] = dom_child_off[b];
  for (uint32_t b = 0; b < n; ++b) {
    if (!fn.reachable_mask[b]) continue;
    const uint32_t idom = fn.blocks[b].idom;
    if (idom != kNone && idom < n) dom_child_list[dom_child_cur[idom]++] = b;
  }

  // Reusable per-iteration work arrays on scratch.
  uint8_t* is_const = val_count > 0u ? scratch.alloc<uint8_t>(val_count) : nullptr;
  uint64_t* const_val = val_count > 0u ? scratch.alloc<uint64_t>(val_count) : nullptr;
  uint32_t* rep = val_count > 0u ? scratch.alloc<uint32_t>(val_count) : nullptr;
  uint32_t* def_inst = val_count > 0u ? scratch.alloc<uint32_t>(val_count) : nullptr;
  uint32_t* def_phi = val_count > 0u ? scratch.alloc<uint32_t>(val_count) : nullptr;
  uint8_t* live_val = val_count > 0u ? scratch.alloc<uint8_t>(val_count) : nullptr;
  uint8_t* live_inst = inst_count > 0u ? scratch.alloc<uint8_t>(inst_count) : nullptr;
  uint8_t* live_phi = phi_count > 0u ? scratch.alloc<uint8_t>(phi_count) : nullptr;
  if ((val_count > 0u && (!is_const || !const_val || !rep || !def_inst || !def_phi || !live_val)) ||
      (inst_count > 0u && !live_inst) ||
      (phi_count > 0u && !live_phi)) {
    return HEX_ERR_OOM;
  }

  OptStats stats{};
  bool converged = false;

  for (uint32_t iter = 0; iter < max_iters; ++iter) {
    ArenaScope iter_scope(scratch);
    uint32_t iter_changes = 0u;
    ++stats.iterations;

    // -----------------------------------------------------------------------
    // Pass 1: Copy Propagation & Redundant PHI Simplification
    // -----------------------------------------------------------------------
    if (val_count > 0u) {
      for (uint32_t v = 0; v < val_count; ++v) rep[v] = v;

      // Collect copies from HEX_IR_OP_MOV.
      for (uint32_t i = 0; i < inst_count; ++i) {
        if (fn.insts[i].op != HEX_IR_OP_MOV) continue;
        const uint32_t dst = fn.inst_ssa_dst[i];
        const uint32_t src = fn.inst_ssa_arg0[i];
        if (dst != kNone && src != kNone && dst < val_count && src < val_count && dst != src) {
          rep[dst] = src;
        }
      }

      // Collect redundant PHIs (all non-self incoming values identical).
      for (uint32_t p = 0; p < phi_count; ++p) {
        const IrPhi& phi = fn.phis[p];
        if (phi.ssa_value_id == kNone || phi.incoming_count == 0u) continue;
        uint32_t unique_val = kNone;
        bool redundant = true;
        for (uint32_t k = 0; k < phi.incoming_count; ++k) {
          const uint32_t inc = fn.phi_incoming[phi.incoming_offset + k].ssa_value_id;
          if (inc == phi.ssa_value_id) continue;  // self-reference
          if (inc == kNone || inc >= val_count) {
            redundant = false;
            break;
          }
          if (unique_val == kNone) {
            unique_val = inc;
          } else if (unique_val != inc) {
            redundant = false;
            break;
          }
        }
        if (redundant && unique_val != kNone) {
          rep[phi.ssa_value_id] = unique_val;
        }
      }

      // Iterative path compression with cycle guard.
      for (uint32_t v = 0; v < val_count; ++v) {
        uint32_t cur = rep[v];
        uint32_t steps = 0u;
        while (cur < val_count && rep[cur] != cur && steps < val_count) {
          cur = rep[cur];
          ++steps;
        }
        rep[v] = (steps < val_count) ? cur : v;
      }

      // Rewrite instruction operands.
      for (uint32_t i = 0; i < inst_count; ++i) {
        if (fn.insts[i].op == HEX_IR_OP_NOP) continue;
        auto rewrite_op = [&](uint32_t& slot) {
          if (slot != kNone && slot < val_count && rep[slot] != slot) {
            slot = rep[slot];
            ++iter_changes;
            ++stats.copy_propagations;
          }
        };
        rewrite_op(fn.inst_ssa_arg0[i]);
        rewrite_op(fn.inst_ssa_arg1[i]);
        rewrite_op(fn.inst_ssa_arg2[i]);
      }

      // Rewrite PHI incoming operands & eliminate simplified PHIs.
      for (uint32_t p = 0; p < phi_count; ++p) {
        IrPhi& phi = fn.phis[p];
        if (phi.ssa_value_id == kNone || phi.incoming_count == 0u) continue;
        if (phi.ssa_value_id < val_count && rep[phi.ssa_value_id] != phi.ssa_value_id) {
          phi.ssa_value_id = kNone;
          phi.incoming_count = 0u;
          ++iter_changes;
          ++stats.phi_simplifications;
          continue;
        }
        for (uint32_t k = 0; k < phi.incoming_count; ++k) {
          uint32_t& inc = fn.phi_incoming[phi.incoming_offset + k].ssa_value_id;
          if (inc != kNone && inc < val_count && rep[inc] != inc) {
            inc = rep[inc];
            ++iter_changes;
            ++stats.copy_propagations;
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Pass 2: Constant Folding & Algebraic Simplification
    // -----------------------------------------------------------------------
    if (val_count > 0u) {
      mem_set(is_const, 0, val_count);
      for (uint32_t i = 0; i < inst_count; ++i) {
        if (fn.insts[i].op == HEX_IR_OP_CONST) {
          const uint32_t dst = fn.inst_ssa_dst[i];
          if (dst != kNone && dst < val_count) {
            is_const[dst] = 1u;
            const_val[dst] = fn.insts[i].imm64_or_sym;
          }
        }
      }

      for (uint32_t i = 0; i < inst_count; ++i) {
        const IrInst& ins = fn.insts[i];
        const uint32_t dst = fn.inst_ssa_dst[i];
        if (dst == kNone || dst >= val_count) continue;

        if (ins.op == HEX_IR_OP_UN) {
          const uint32_t a0 = fn.inst_ssa_arg0[i];
          if (a0 != kNone && a0 < val_count && is_const[a0]) {
            uint64_t folded = 0ULL;
            if (fold_un(ins.flags, const_val[a0], &folded)) {
              rewrite_to_const(fn, i, folded);
              is_const[dst] = 1u;
              const_val[dst] = folded;
              ++iter_changes;
              ++stats.const_folds;
            }
          }
        } else if (ins.op == HEX_IR_OP_BIN) {
          const uint32_t a0 = fn.inst_ssa_arg0[i];
          const uint32_t a1 = fn.inst_ssa_arg1[i];
          const bool w32 = (ins.flags & HEX_IR_FLAG_WIDTH32) != 0u;
          const uint16_t sub = static_cast<uint16_t>(ins.flags & 0x0fu);
          const uint64_t ones = all_ones_for(w32);

          const bool lhs_c = (a0 != kNone && a0 < val_count && is_const[a0]);
          const bool rhs_c = (a1 != kNone && a1 < val_count && is_const[a1]) || (a1 == kNone);
          const uint64_t lv = lhs_c ? mask_width(const_val[a0], w32) : 0ULL;
          const uint64_t rv = (a1 != kNone && a1 < val_count && is_const[a1])
                                  ? mask_width(const_val[a1], w32)
                                  : mask_width(ins.imm64_or_sym, w32);

          if (lhs_c && rhs_c) {
            uint64_t folded = 0ULL;
            if (fold_bin(ins.flags, lv, rv, &folded)) {
              rewrite_to_const(fn, i, folded);
              is_const[dst] = 1u;
              const_val[dst] = folded;
              ++iter_changes;
              ++stats.const_folds;
              continue;
            }
          }

          // Algebraic identities
          uint32_t ident_src = kNone;
          bool to_const = false;
          uint64_t c_out = 0ULL;
          const bool same_ops = (a0 != kNone && a0 == a1);

          switch (sub) {
            case HEX_IR_BIN_ADD:
              if (rhs_c && rv == 0ULL && a0 != kNone) ident_src = a0;
              else if (lhs_c && lv == 0ULL && a1 != kNone) ident_src = a1;
              break;
            case HEX_IR_BIN_SUB:
              if (rhs_c && rv == 0ULL && a0 != kNone) ident_src = a0;
              else if (same_ops) { to_const = true; c_out = 0ULL; }
              break;
            case HEX_IR_BIN_MUL:
              if ((rhs_c && rv == 0ULL) || (lhs_c && lv == 0ULL)) { to_const = true; c_out = 0ULL; }
              else if (rhs_c && rv == 1ULL && a0 != kNone) ident_src = a0;
              else if (lhs_c && lv == 1ULL && a1 != kNone) ident_src = a1;
              break;
            case HEX_IR_BIN_AND:
              if ((rhs_c && rv == 0ULL) || (lhs_c && lv == 0ULL)) { to_const = true; c_out = 0ULL; }
              else if (rhs_c && rv == ones && a0 != kNone) ident_src = a0;
              else if (lhs_c && lv == ones && a1 != kNone) ident_src = a1;
              else if (same_ops) ident_src = a0;
              break;
            case HEX_IR_BIN_OR:
              if ((rhs_c && rv == ones) || (lhs_c && lv == ones)) { to_const = true; c_out = ones; }
              else if (rhs_c && rv == 0ULL && a0 != kNone) ident_src = a0;
              else if (lhs_c && lv == 0ULL && a1 != kNone) ident_src = a1;
              else if (same_ops) ident_src = a0;
              break;
            case HEX_IR_BIN_XOR:
              if (rhs_c && rv == 0ULL && a0 != kNone) ident_src = a0;
              else if (lhs_c && lv == 0ULL && a1 != kNone) ident_src = a1;
              else if (same_ops) { to_const = true; c_out = 0ULL; }
              break;
            case HEX_IR_BIN_SHL:
            case HEX_IR_BIN_LSR:
            case HEX_IR_BIN_ASR: {
              const uint32_t sh_mask = w32 ? 31u : 63u;
              if (rhs_c && (static_cast<uint32_t>(rv) & sh_mask) == 0u && a0 != kNone) ident_src = a0;
              else if (lhs_c && lv == 0ULL) { to_const = true; c_out = 0ULL; }
              break;
            }
            case HEX_IR_BIN_UDIV:
              if (rhs_c && rv == 1ULL && a0 != kNone) ident_src = a0;
              break;
            case HEX_IR_BIN_UREM:
              if (rhs_c && rv == 1ULL) { to_const = true; c_out = 0ULL; }
              break;
            default:
              break;
          }

          if (to_const) {
            rewrite_to_const(fn, i, c_out);
            is_const[dst] = 1u;
            const_val[dst] = c_out;
            ++iter_changes;
            ++stats.algebraic_simplifications;
          } else if (ident_src != kNone) {
            if (w32) {
              rewrite_to_zext32(fn, i, ident_src);
            } else {
              rewrite_to_mov(fn, i, ident_src);
            }
            ++iter_changes;
            ++stats.algebraic_simplifications;
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Pass 3: Deterministic Dominator-Tree CSE (Scoped OrderedMap, Non-Recursive)
    // -----------------------------------------------------------------------
    if (fn.reachable_mask[fn.header.entry_block]) {
      OrderedMap<CseKey, uint32_t, CseKeyTraits> cse_table(&scratch);
      Vec<CseKey> undo_keys(&scratch);
      Vec<CseFrame> frames(&scratch);
      if (!frames.push_back(CseFrame{fn.header.entry_block, dom_child_off[fn.header.entry_block], 0u, 0u, 0u, 0u})) {
        return HEX_ERR_OOM;
      }

      while (!frames.empty()) {
        CseFrame& frame = frames.back();
        const uint32_t b = frame.block_id;
        if (!frame.entered) {
          frame.entered = 1u;
          frame.undo_start = static_cast<uint32_t>(undo_keys.size());

          const uint32_t ib = fn.block_inst_off[b];
          const uint32_t ie = fn.block_inst_off[b + 1u];
          for (uint32_t idx = ib; idx < ie; ++idx) {
            const uint32_t inst_id = fn.block_inst_ids[idx];
            const IrInst& ins = fn.insts[inst_id];
            const uint32_t dst = fn.inst_ssa_dst[inst_id];
            if (dst == kNone || !is_cse_eligible(ins.op)) continue;

            uint32_t a0 = fn.inst_ssa_arg0[inst_id];
            uint32_t a1 = fn.inst_ssa_arg1[inst_id];
            const uint32_t a2 = fn.inst_ssa_arg2[inst_id];
            if (ins.op == HEX_IR_OP_BIN && is_commutative_bin(ins.flags) &&
                a0 != kNone && a1 != kNone && a1 < a0) {
              swap_val(a0, a1);
            }

            const uint64_t imm = (ins.op == HEX_IR_OP_CONST ||
                                  ins.op == HEX_IR_OP_CMP ||
                                  (ins.op == HEX_IR_OP_BIN && a1 == kNone))
                                     ? ins.imm64_or_sym
                                     : 0ULL;
            const CseKey key{ins.op, ins.flags, a0, a1, a2, imm};
            if (const uint32_t* prev_val = cse_table.find(key)) {
              if (*prev_val != dst) {
                rewrite_to_mov(fn, inst_id, *prev_val);
                ++iter_changes;
                ++stats.cse_eliminations;
              }
            } else {
              if (!cse_table.set(key, dst)) return HEX_ERR_OOM;
              if (!undo_keys.push_back(key)) return HEX_ERR_OOM;
            }
          }
        }

        const uint32_t child_end = dom_child_off[b + 1u];
        if (frame.child_idx < child_end) {
          const uint32_t child = dom_child_list[frame.child_idx++];
          if (!frames.push_back(CseFrame{child, dom_child_off[child], 0u, 0u, 0u, 0u})) {
            return HEX_ERR_OOM;
          }
          continue;
        }

        // Backtrack: remove CSE entries added in this dominator subtree.
        while (undo_keys.size() > frame.undo_start) {
          cse_table.erase(undo_keys.back());
          undo_keys.pop_back();
        }
        frames.pop_back();
      }
    }

    // -----------------------------------------------------------------------
    // Pass 4: Side-Effect-Preserving Dead Code Elimination (Non-Recursive Worklist)
    // -----------------------------------------------------------------------
    if (val_count > 0u) {
      for (uint32_t v = 0; v < val_count; ++v) {
        def_inst[v] = kNone;
        def_phi[v] = kNone;
        live_val[v] = 0u;
      }
      if (inst_count > 0u) mem_set(live_inst, 0, inst_count);
      if (phi_count > 0u) mem_set(live_phi, 0, phi_count);

      for (uint32_t i = 0; i < inst_count; ++i) {
        if (fn.insts[i].op == HEX_IR_OP_NOP) continue;
        const uint32_t dst = fn.inst_ssa_dst[i];
        if (dst != kNone && dst < val_count) def_inst[dst] = i;
      }
      for (uint32_t p = 0; p < phi_count; ++p) {
        const uint32_t dst = fn.phis[p].ssa_value_id;
        if (dst != kNone && dst < val_count && fn.phis[p].incoming_count > 0u) {
          def_phi[dst] = p;
        }
      }

      Vec<uint32_t> work_vals(&scratch);
      auto push_live_val = [&](uint32_t v) -> bool {
        if (v == kNone || v >= val_count || live_val[v]) return true;
        live_val[v] = 1u;
        return work_vals.push_back(v);
      };

      // Seed roots: all side-effecting instructions (STORE, LOAD, CALL, BR, CBR, RET, STATE_WRITE, UNKNOWN).
      for (uint32_t i = 0; i < inst_count; ++i) {
        if (fn.insts[i].op == HEX_IR_OP_NOP) continue;
        if (!has_side_effects(fn.insts[i].op)) continue;
        live_inst[i] = 1u;
        if (!push_live_val(fn.inst_ssa_arg0[i])) return HEX_ERR_OOM;
        if (!push_live_val(fn.inst_ssa_arg1[i])) return HEX_ERR_OOM;
        if (!push_live_val(fn.inst_ssa_arg2[i])) return HEX_ERR_OOM;
      }

      while (!work_vals.empty()) {
        const uint32_t v = work_vals.back();
        work_vals.pop_back();
        const uint32_t di = def_inst[v];
        if (di != kNone && !live_inst[di]) {
          live_inst[di] = 1u;
          if (!push_live_val(fn.inst_ssa_arg0[di])) return HEX_ERR_OOM;
          if (!push_live_val(fn.inst_ssa_arg1[di])) return HEX_ERR_OOM;
          if (!push_live_val(fn.inst_ssa_arg2[di])) return HEX_ERR_OOM;
        }
        const uint32_t dp = def_phi[v];
        if (dp != kNone && !live_phi[dp]) {
          live_phi[dp] = 1u;
          const IrPhi& phi = fn.phis[dp];
          for (uint32_t k = 0; k < phi.incoming_count; ++k) {
            if (!push_live_val(fn.phi_incoming[phi.incoming_offset + k].ssa_value_id)) {
              return HEX_ERR_OOM;
            }
          }
        }
      }

      // Sweep dead instructions and dead PHIs.
      for (uint32_t i = 0; i < inst_count; ++i) {
        if (fn.insts[i].op == HEX_IR_OP_NOP) continue;
        if (!live_inst[i]) {
          rewrite_to_nop(fn, i);
          ++iter_changes;
          ++stats.dce_eliminations;
        }
      }
      for (uint32_t p = 0; p < phi_count; ++p) {
        if (fn.phis[p].ssa_value_id == kNone || fn.phis[p].incoming_count == 0u) continue;
        if (!live_phi[p]) {
          fn.phis[p].ssa_value_id = kNone;
          fn.phis[p].incoming_count = 0u;
          ++iter_changes;
          ++stats.dce_eliminations;
        }
      }
    }

    stats.total_changes += iter_changes;
    if (iter_changes == 0u) {
      converged = true;
      break;
    }
  }

  const HexStatus du_st = rebuild_def_use(fn, scratch);
  if (du_st != HEX_OK) return du_st;
  recompute_digest(fn);

  if (out_stats) *out_stats = stats;
  return converged ? HEX_OK : HEX_ERR_RESOURCE_LIMIT;
}

namespace {

alignas(8) uint8_t g_opt_scratch_buf[512u * 1024u];
Arena g_opt_scratch_arena;
bool g_opt_scratch_ready = false;

Arena& default_opt_scratch() {
  if (!g_opt_scratch_ready) {
    g_opt_scratch_arena.init_fixed(g_opt_scratch_buf, sizeof(g_opt_scratch_buf));
    g_opt_scratch_ready = true;
  }
  return g_opt_scratch_arena;
}

}  // namespace

}  // namespace decomp
}  // namespace hex

extern "C" {

HexStatus hex_decomp_optimize_ir(
    uint32_t ir_handle,
    uint32_t max_iters,
    uint32_t* out_changed_count) {
  if (out_changed_count) *out_changed_count = 0u;
#if HEX_DECOMP_HAS_RESIDENT_IR
  hex::ir::IrFunction* fn = hex::ir::default_store().lookup_mut(ir_handle);
  if (!fn) return HEX_ERR_INVALID_ARG;
  hex::decomp::OptStats stats{};
  const HexStatus st = hex::decomp::optimize_ir(*fn, hex::decomp::default_opt_scratch(), max_iters, &stats);
  if (out_changed_count) *out_changed_count = stats.total_changes;
  return st;
#else
  (void)ir_handle;
  (void)max_iters;
  (void)hex::decomp::default_opt_scratch();
  return HEX_ERR_INVALID_ARG;
#endif
}

}  // extern "C"
