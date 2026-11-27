#ifndef HEX_SEMANTICS_RESIDENT_IR_HPP
#define HEX_SEMANTICS_RESIDENT_IR_HPP

#include <stdint.h>
#include <stddef.h>

#include "../../include/hex_abi.hpp"
#include "../../include/hex_core/hex_core.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef uint32_t HexIrHandle;

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

// Unified sub-opcode constants encoded in IrInst::flags (low 4 bits: flags & HEX_IR_SUBOP_MASK).
// Single source of truth shared across resident_ir, ir_optimizer, c_emitter, and engine_runtime.
static const uint16_t HEX_IR_SUBOP_MASK = 0x0fu;
static const uint16_t HEX_IR_FLAG_WIDTH32 = 0x10u;

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

typedef enum HexIrUnOp {
  HEX_IR_UN_NEG = 0,
  HEX_IR_UN_NOT = 1,
  HEX_IR_UN_ZEXT32 = 2,
  HEX_IR_UN_SEXT32 = 3,
} HexIrUnOp;

typedef enum HexIrValueKind {
  HEX_IR_VAL_ENTRY = 0,
  HEX_IR_VAL_DEF = 1,
  HEX_IR_VAL_PHI = 2,
  HEX_IR_VAL_UNDEF = 3,
} HexIrValueKind;

typedef enum HexIrUserKind {
  HEX_IR_USER_INST = 0,
  HEX_IR_USER_PHI = 1,
} HexIrUserKind;

typedef struct HexIrStats {
  uint32_t block_count;
  uint32_t edge_count;
  uint32_t inst_count;
  uint32_t value_count;
  uint32_t phi_count;
  uint32_t use_count;
  uint32_t reachable_block_count;
  uint32_t scc_count;
  uint8_t cfg_ready;
  uint8_t ssa_ready;
  uint8_t memssa_ready;
  uint8_t reserved;
  uint64_t digest_lo64;
  uint64_t digest_hi64;
} HexIrStats;

// Public C ABI for Resident IR Store.
HEX_WASM_EXPORT("hex_ir_create")
HexStatus hex_ir_create(uint32_t entry_block, HexIrHandle* out_handle);

HEX_WASM_EXPORT("hex_ir_release")
HexStatus hex_ir_release(HexIrHandle handle);

HEX_WASM_EXPORT("hex_ir_add_block")
HexStatus hex_ir_add_block(HexIrHandle handle, uint32_t* out_block_id);

HEX_WASM_EXPORT("hex_ir_add_edge")
HexStatus hex_ir_add_edge(HexIrHandle handle, uint32_t from_block, uint32_t to_block);

HEX_WASM_EXPORT("hex_ir_add_inst")
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
    uint32_t* out_inst_id);

HEX_WASM_EXPORT("hex_ir_run_cfg_and_ssa")
HexStatus hex_ir_run_cfg_and_ssa(HexIrHandle handle);

HEX_WASM_EXPORT("hex_ir_get_stats")
HexStatus hex_ir_get_stats(HexIrHandle handle, HexIrStats* out_stats);

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
namespace hex {
namespace ir {

static constexpr uint32_t kNone = HEX_IR_NONE;
static constexpr uint32_t kMaxSlots = 256u;
static constexpr uint32_t kMaxBlocks = 16384u;
static constexpr uint32_t kMaxEdges = 131072u;
static constexpr uint32_t kMaxInsts = 262144u;
static constexpr uint32_t kMaxPhis = 262144u;
static constexpr uint32_t kMaxPhiIncoming = 1048576u;
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

struct IrEdge {
  uint32_t from;
  uint32_t to;
};

struct IrPhi {
  uint32_t block_id;
  uint32_t var_id;
  uint32_t ssa_value_id;
  uint32_t incoming_offset;
  uint32_t incoming_count;
};

struct IrPhiIncoming {
  uint32_t pred_block_id;  // kNone represents virtual entry predecessor
  uint32_t ssa_value_id;
};

struct IrValueDef {
  uint32_t ssa_value_id;
  uint32_t var_id;
  uint32_t def_block;
  uint32_t def_site;  // inst_id for DEF, phi_id for PHI, kNone for ENTRY/UNDEF
  uint8_t kind;       // HexIrValueKind
  uint8_t reserved0;
  uint16_t reserved1;
};

struct IrUse {
  uint32_t user_index;   // inst_id or phi_id
  uint8_t user_kind;     // HexIrUserKind
  uint8_t operand_slot;  // 0/1/2 for inst args, or sorted incoming index for phi
  uint16_t reserved;
};

struct IrFunction {
  IrFunctionHeader header;

  // Input SoA storage (resident in persistent Arena)
  Vec<IrBlock> blocks;
  Vec<IrEdge> raw_edges;
  Vec<IrInst> insts;
  Vec<uint32_t> inst_block;  // block_id per instruction

  // Canonical per-block instruction index (CSR)
  Vec<uint32_t> block_inst_off;
  Vec<uint32_t> block_inst_ids;

  // Canonical CSR CFG
  Vec<uint32_t> succ_off;
  Vec<int32_t> succ_dst;
  Vec<uint32_t> pred_off;
  Vec<int32_t> pred_src;

  // CFG analysis SoA arrays
  Vec<uint8_t> reachable_mask;
  Vec<int32_t> dom_tin;
  Vec<int32_t> dom_tout;
  Vec<int32_t> dom_depth;
  uint32_t reachable_count;
  uint32_t scc_count;

  // Dominator Frontier (CSR)
  Vec<uint32_t> df_off;
  Vec<uint32_t> df_blocks;

  // SSA PHI nodes and incoming edges
  Vec<uint32_t> block_phi_off;
  Vec<IrPhi> phis;
  Vec<IrPhiIncoming> phi_incoming;

  // SSA renamed operands (SoA parallel to insts)
  Vec<uint32_t> inst_ssa_dst;
  Vec<uint32_t> inst_ssa_arg0;
  Vec<uint32_t> inst_ssa_arg1;
  Vec<uint32_t> inst_ssa_arg2;

  // SSA Value definitions and Def-Use chains (CSR)
  Vec<IrValueDef> values;
  Vec<uint32_t> use_off;
  Vec<IrUse> uses;

  void init(Arena* arena, uint32_t entry_block);
};

class IrStore {
 public:
  constexpr IrStore()
      : arena_(nullptr), scratch_(nullptr), active_count_(0u), initialized_(false), slots_{} {}

  // Initialize with separate persistent Resident IR Arena and Scratch Arena.
  // All Phase 1-5 temporary structures are allocated on scratch_arena and reclaimed O(1).
  void init(Arena* persistent_arena, Arena* scratch_arena = nullptr);
  void reset();

  HexStatus create(uint32_t entry_block, HexIrHandle* out_handle);
  HexStatus release(HexIrHandle handle);
  HexStatus add_block(HexIrHandle handle, uint32_t* out_block_id);
  HexStatus add_edge(HexIrHandle handle, uint32_t from_block, uint32_t to_block);
  HexStatus add_inst(
      HexIrHandle handle,
      uint32_t block_id,
      uint16_t op,
      uint16_t flags,
      uint32_t dst_val,
      uint32_t arg0,
      uint32_t arg1,
      uint32_t arg2,
      uint64_t imm64_or_sym,
      uint32_t* out_inst_id);
  HexStatus run_cfg_and_ssa(HexIrHandle handle);
  HexStatus get_stats(HexIrHandle handle, HexIrStats* out_stats) const;

  const IrFunction* lookup(HexIrHandle handle) const;
  IrFunction* lookup_mut(HexIrHandle handle);

  bool dominates(const IrFunction& fn, uint32_t ancestor, uint32_t descendant) const;
  uint32_t active_count() const { return active_count_; }

 private:
  struct Slot {
    IrFunction* fn;
    uint8_t generation;  // 1..255 (never 0)
    uint8_t in_use;
    uint16_t reserved;
  };

  static constexpr HexIrHandle make_handle(uint32_t slot_idx, uint8_t gen) {
    return (static_cast<uint32_t>(gen) << 24) | (slot_idx & 0x00ffffffu);
  }
  static constexpr uint32_t handle_slot(HexIrHandle h) { return h & 0x00ffffffu; }
  static constexpr uint8_t handle_gen(HexIrHandle h) {
    return static_cast<uint8_t>((h >> 24) & 0xffu);
  }

  Arena* arena_;
  Arena* scratch_;
  uint32_t active_count_;
  bool initialized_;
  Slot slots_[kMaxSlots];
};

// Access the default global store used by the C ABI.
IrStore& default_store();

}  // namespace ir
}  // namespace hex
#endif

#endif  // HEX_SEMANTICS_RESIDENT_IR_HPP
