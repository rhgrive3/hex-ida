#ifndef HEX_DECOMPILER_IR_OPTIMIZER_HPP
#define HEX_DECOMPILER_IR_OPTIMIZER_HPP

#include <stdint.h>
#include <stddef.h>

#include "../../include/hex_abi.hpp"
#include "../../include/hex_core/hex_core.hpp"

#if defined(__has_include)
#if __has_include("../semantics/resident_ir.hpp")
#include "../semantics/resident_ir.hpp"
#define HEX_DECOMP_HAS_RESIDENT_IR 1
#endif
#endif

#ifndef HEX_DECOMP_HAS_RESIDENT_IR
#define HEX_DECOMP_HAS_RESIDENT_IR 0
#endif

#ifdef __cplusplus
extern "C" {
#endif

#if !HEX_DECOMP_HAS_RESIDENT_IR
static const uint32_t HEX_IR_NONE = 0xffffffffu;

typedef enum HexIrOp {
  HEX_IR_OP_NOP = 0,
  HEX_IR_OP_CONST = 1,
  HEX_IR_OP_MOV = 2,
  HEX_IR_OP_BIN = 3,
  HEX_IR_OP_UN = 4,
  HEX_IR_OP_LOAD = 5,
  HEX_IR_OP_STORE = 6,
  HEX_IR_OP_CMP = 7,
  HEX_IR_OP_BR = 8,
  HEX_IR_OP_CBR = 9,
  HEX_IR_OP_CALL = 10,
  HEX_IR_OP_RET = 11,
  HEX_IR_OP_PHI = 12,
  HEX_IR_OP_STATE_READ = 13,
  HEX_IR_OP_STATE_WRITE = 14,
  HEX_IR_OP_UNKNOWN = 15,
} HexIrOp;

typedef enum HexIrUserKind {
  HEX_IR_USER_INST = 0,
  HEX_IR_USER_PHI = 1,
} HexIrUserKind;
#endif

// Sub-opcodes encoded in IrInst::flags low nibble (flags & 0x0fu) for HEX_IR_OP_BIN.
typedef enum HexIrBinOp {
  HEX_IR_BIN_ADD = 0,
  HEX_IR_BIN_SUB = 1,
  HEX_IR_BIN_MUL = 2,
  HEX_IR_BIN_AND = 3,
  HEX_IR_BIN_OR = 4,
  HEX_IR_BIN_XOR = 5,
  HEX_IR_BIN_SHL = 6,
  HEX_IR_BIN_LSR = 7,
  HEX_IR_BIN_ASR = 8,
  HEX_IR_BIN_UDIV = 9,
  HEX_IR_BIN_UREM = 10,
} HexIrBinOp;

// Sub-opcodes encoded in IrInst::flags low nibble (flags & 0x0fu) for HEX_IR_OP_UN.
typedef enum HexIrUnOp {
  HEX_IR_UN_NEG = 0,
  HEX_IR_UN_NOT = 1,
  HEX_IR_UN_ZEXT32 = 2,
  HEX_IR_UN_SEXT32 = 3,
} HexIrUnOp;

// Width flag in IrInst::flags: 0 = 64-bit, 0x10u = 32-bit.
static const uint16_t HEX_IR_FLAG_WIDTH32 = 0x10u;

// Public C ABI: run fixed-point SSA optimization passes on a resident IR handle.
// Returns HEX_OK on fixed-point convergence, HEX_ERR_RESOURCE_LIMIT if max_iters
// is exhausted before convergence, HEX_ERR_INVALID_ARG on invalid handle/args,
// or HEX_ERR_OOM if scratch memory is insufficient.
HEX_WASM_EXPORT("hex_decomp_optimize_ir")
HexStatus hex_decomp_optimize_ir(
    uint32_t ir_handle,
    uint32_t max_iters,
    uint32_t* out_changed_count);

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
#if !HEX_DECOMP_HAS_RESIDENT_IR
namespace hex {
namespace ir {

static constexpr uint32_t kNone = HEX_IR_NONE;
static constexpr uint32_t kMaxUses = 1048576u;

struct IrFunctionHeader {
  uint32_t entry_block;
  uint32_t block_count;
  uint32_t inst_count;
  uint32_t value_count;
  uint8_t cfg_ready;
  uint8_t ssa_ready;
  uint8_t memssa_ready;
  uint8_t reserved;
  uint64_t digest_lo64;
  uint64_t digest_hi64;
};

struct IrBlock {
  uint32_t first_inst;
  uint32_t inst_count;
  uint32_t succ_offset;
  uint32_t succ_count;
  uint32_t pred_offset;
  uint32_t pred_count;
  uint32_t idom;
  uint32_t ipdom;
  uint32_t scc_id;
  uint32_t loop_header;
};

struct IrInst {
  uint16_t op;
  uint16_t flags;
  uint32_t dst_val;
  uint32_t arg0;
  uint32_t arg1;
  uint32_t arg2;
  uint32_t aux_offset;
  uint32_t origin_idx;
  uint64_t imm64_or_sym;
};

struct IrPhi {
  uint32_t block_id;
  uint32_t var_id;
  uint32_t ssa_value_id;
  uint32_t incoming_offset;
  uint32_t incoming_count;
};

struct IrPhiIncoming {
  uint32_t pred_block_id;
  uint32_t ssa_value_id;
};

struct IrUse {
  uint32_t user_index;
  uint8_t user_kind;
  uint8_t operand_slot;
  uint16_t reserved;
};

struct IrFunction {
  IrFunctionHeader header;
  Vec<IrBlock> blocks;
  Vec<IrInst> insts;
  Vec<uint32_t> inst_block;
  Vec<uint32_t> block_inst_off;
  Vec<uint32_t> block_inst_ids;
  Vec<uint8_t> reachable_mask;
  uint32_t reachable_count;
  uint32_t scc_count;
  Vec<IrPhi> phis;
  Vec<IrPhiIncoming> phi_incoming;
  Vec<uint32_t> inst_ssa_dst;
  Vec<uint32_t> inst_ssa_arg0;
  Vec<uint32_t> inst_ssa_arg1;
  Vec<uint32_t> inst_ssa_arg2;
  Vec<uint32_t> use_off;
  Vec<IrUse> uses;

  void init(Arena* arena, uint32_t entry_block) {
    mem_set(&header, 0, sizeof(header));
    header.entry_block = entry_block;
    blocks.init(arena);
    insts.init(arena);
    inst_block.init(arena);
    block_inst_off.init(arena);
    block_inst_ids.init(arena);
    reachable_mask.init(arena);
    reachable_count = 0u;
    scc_count = 0u;
    phis.init(arena);
    phi_incoming.init(arena);
    inst_ssa_dst.init(arena);
    inst_ssa_arg0.init(arena);
    inst_ssa_arg1.init(arena);
    inst_ssa_arg2.init(arena);
    use_off.init(arena);
    uses.init(arena);
  }
};

}  // namespace ir
}  // namespace hex
#endif

namespace hex {
namespace decomp {

static constexpr uint32_t kMaxOptIters = 256u;

struct OptStats {
  uint32_t iterations;
  uint32_t total_changes;
  uint32_t const_folds;
  uint32_t algebraic_simplifications;
  uint32_t copy_propagations;
  uint32_t phi_simplifications;
  uint32_t cse_eliminations;
  uint32_t dce_eliminations;
};

// Core freestanding SSA optimizer operating in-place on a resident IrFunction.
// All temporary tables are allocated on `scratch` and reclaimed O(1) via ArenaScope.
HexStatus optimize_ir(
    hex::ir::IrFunction& fn,
    hex::Arena& scratch,
    uint32_t max_iters,
    OptStats* out_stats = nullptr);

}  // namespace decomp
}  // namespace hex
#endif

#endif  // HEX_DECOMPILER_IR_OPTIMIZER_HPP
