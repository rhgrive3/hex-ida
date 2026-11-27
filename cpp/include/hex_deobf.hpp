#ifndef HEX_DEOBF_HPP
#define HEX_DEOBF_HPP

#include <stddef.h>
#include <stdint.h>

#include "hex_abi.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// 1. Control-Flow Flattening (CFF) Unflatten POD Structs & Constants
// ============================================================================

enum HexCffBlockFlags : uint32_t {
  HEX_CFF_BLK_NONE          = 0u,
  HEX_CFF_BLK_ENTRY         = 1u << 0,
  HEX_CFF_BLK_HAS_SWITCH    = 1u << 1,  // Dispatcher switch / compare hub
  HEX_CFF_BLK_UPDATES_STATE = 1u << 2,  // Writes state variable unconditionally or conditionally
  HEX_CFF_BLK_COND_UPDATE   = 1u << 3,  // Conditionally selects next_state_true / next_state_false
  HEX_CFF_BLK_HAS_EXIT      = 1u << 4,  // Function exit / return block
  HEX_CFF_BLK_SIDE_EFFECT   = 1u << 5,  // Contains side-effecting instruction
  HEX_CFF_BLK_STATE_ESCAPES = 1u << 6,  // State var escapes or stack-alias unsafe
  HEX_CFF_BLK_STATE_EXTERN  = 1u << 7,  // State var comes from arg/global/call (natural FSM guard)
};

enum HexCffEdgeKind : uint32_t {
  HEX_CFF_EDGE_FALLTHROUGH = 0u,
  HEX_CFF_EDGE_UNCOND      = 1u,
  HEX_CFF_EDGE_COND_TRUE   = 2u,
  HEX_CFF_EDGE_COND_FALSE  = 3u,
  HEX_CFF_EDGE_SWITCH      = 4u,
  HEX_CFF_EDGE_BACKEDGE    = 5u,
};

enum HexCffStatus : uint32_t {
  HEX_CFF_STATUS_RECOVERED      = 0u,
  HEX_CFF_STATUS_NOT_APPLICABLE = 1u,
  HEX_CFF_STATUS_ABORT_GUARD    = 2u,
  HEX_CFF_STATUS_ABORT_BUDGET   = 3u,
};

enum HexCffGuardReason : uint32_t {
  HEX_CFF_GUARD_NONE              = 0u,
  HEX_CFF_GUARD_TOO_FEW_REAL      = 1u,
  HEX_CFF_GUARD_NATURAL_FSM       = 2u,
  HEX_CFF_GUARD_STATE_ESCAPE      = 3u,
  HEX_CFF_GUARD_UNRESOLVED_EDGE   = 4u,
  HEX_CFF_GUARD_SPINE_SIDE_EFFECT = 5u,
  HEX_CFF_GUARD_DOMINANCE_FAIL    = 6u,
  HEX_CFF_GUARD_BUDGET_EXCEEDED   = 7u,
};

struct alignas(8) HexCffBlock {
  uint32_t block_id;          // +0x00
  uint32_t flags;             // +0x04: HexCffBlockFlags
  uint32_t state_var_id;      // +0x08: state variable identifier
  uint32_t cond_id;           // +0x0C: condition id when COND_UPDATE is set
  uint64_t match_state;       // +0x10: dispatcher case key for this block
  uint64_t next_state_true;   // +0x18: next state (unconditional or true branch)
  uint64_t next_state_false;  // +0x20: next state (false branch when COND_UPDATE)
  uint32_t has_match_state;   // +0x28: 1 if block is a dispatcher target for match_state
  uint32_t reserved;          // +0x2C
};

struct alignas(4) HexCffEdge {
  uint32_t src_block;         // +0x00
  uint32_t dst_block;         // +0x04
  uint32_t kind;              // +0x08: HexCffEdgeKind
  uint32_t cond_id;           // +0x0C: condition id for conditional edges
};

struct alignas(4) HexCffUnflattenResult {
  uint32_t status;               // +0x00: HexCffStatus
  uint32_t guard_fail_reason;    // +0x04: HexCffGuardReason
  uint32_t dispatcher_block;     // +0x08: detected dispatcher block_id (UINT32_MAX if none)
  uint32_t state_var_id;         // +0x0C: detected state variable id
  uint32_t real_block_count;     // +0x10
  uint32_t spine_block_count;    // +0x14
  uint32_t recovered_edge_count; // +0x18
  uint32_t uncond_edge_count;    // +0x1C
  uint32_t cond_edge_count;      // +0x20
  uint32_t exit_block_count;     // +0x24
};

// ============================================================================
// 2. Linear MBA Simplifier & 3-Layer Equivalence Proof POD Structs
// ============================================================================

enum HexMbaOp : uint32_t {
  HEX_MBA_VAR       = 0u,  // lhs = var index [0..2] (x=0, y=1, z=2)
  HEX_MBA_CONST     = 1u,  // imm = 64-bit constant
  HEX_MBA_ADD       = 2u,  // lhs + rhs
  HEX_MBA_SUB       = 3u,  // lhs - rhs
  HEX_MBA_NEG       = 4u,  // -lhs
  HEX_MBA_NOT       = 5u,  // ~lhs
  HEX_MBA_AND       = 6u,  // lhs & rhs
  HEX_MBA_OR        = 7u,  // lhs | rhs
  HEX_MBA_XOR       = 8u,  // lhs ^ rhs
  HEX_MBA_MUL_CONST = 9u,  // lhs * imm
};

enum HexMbaNodeFlags : uint32_t {
  HEX_MBA_FLAG_WIDTH64 = 0u,
  HEX_MBA_FLAG_WIDTH32 = 1u << 0,
};

enum HexMbaSimplifiedKind : uint32_t {
  HEX_MBA_SIMP_NONE        = 0u,
  HEX_MBA_SIMP_CONST       = 1u,  // c0
  HEX_MBA_SIMP_LINEAR_VAR  = 2u,  // c0 + c1*x + c2*y + c3*z
  HEX_MBA_SIMP_BITWISE_AND = 3u,  // x & y (or multi-var conjunction)
  HEX_MBA_SIMP_BITWISE_OR  = 4u,  // x | y
  HEX_MBA_SIMP_BITWISE_XOR = 5u,  // x ^ y
  HEX_MBA_SIMP_NEG_VAR     = 6u,  // -x / -y / -z
  HEX_MBA_SIMP_GENERAL_LIN = 7u,  // general linear combination over Boolean basis
};

struct alignas(8) HexMbaNode {
  uint32_t op;     // +0x00: HexMbaOp
  uint32_t lhs;    // +0x04: left child index (or var index 0..2 for HEX_MBA_VAR)
  uint32_t rhs;    // +0x08: right child index
  uint32_t flags;  // +0x0C: HexMbaNodeFlags
  int64_t  imm;    // +0x10: immediate for HEX_MBA_CONST / HEX_MBA_MUL_CONST
};

struct alignas(8) HexMbaProofResult {
  uint32_t layer1_tt_ok;      // +0x00: Layer 1 exact {0,1}^k truth-table proof passed
  uint32_t layer2_basis_ok;   // +0x04: Layer 2 exhaustive 8-bit & 64-bit basis check passed
  uint32_t layer3_rand64_ok;  // +0x08: Layer 3 deterministic SplitMix64 64-bit fuzz passed
  uint32_t simplified_kind;   // +0x0C: HexMbaSimplifiedKind
  uint32_t committed;         // +0x10: 1 iff all 3 layers passed AND cost strictly reduced
  uint32_t orig_cost;         // +0x14: node count of original AST
  uint32_t simp_cost;         // +0x18: node count of simplified AST
  uint32_t out_node_count;    // +0x1C: nodes written to out_nodes
  int64_t  coeff[8];          // +0x20..+0x5F: Mobius basis [1, x, y, x&y, z, x&z, y&z, x&y&z]
};

// ============================================================================
// 3. MiniArm64Emu & Deobf Evaluator POD Structs
// ============================================================================

static constexpr uint32_t HEX_ARM64_EMU_STACK_SIZE = 4096u;
static constexpr uint64_t HEX_ARM64_EMU_STACK_TOP  = 0x00007FFF00010000ULL;
static constexpr uint64_t HEX_ARM64_EMU_STACK_BASE =
    HEX_ARM64_EMU_STACK_TOP - HEX_ARM64_EMU_STACK_SIZE;
static constexpr uint64_t HEX_ARM64_EMU_SENTINEL_LR = 0xDEADBEEF00000000ULL;

static constexpr uint32_t HEX_ARM64_FLAG_N = 1u << 31;
static constexpr uint32_t HEX_ARM64_FLAG_Z = 1u << 30;
static constexpr uint32_t HEX_ARM64_FLAG_C = 1u << 29;
static constexpr uint32_t HEX_ARM64_FLAG_V = 1u << 28;

enum HexArm64EmuFault : uint32_t {
  HEX_ARM64_FAULT_NONE             = 0u,
  HEX_ARM64_FAULT_HALTED_RET       = 1u,
  HEX_ARM64_FAULT_STEP_LIMIT       = 2u,
  HEX_ARM64_FAULT_PC_OOB           = 3u,
  HEX_ARM64_FAULT_MEM_OOB          = 4u,
  HEX_ARM64_FAULT_UNSUPPORTED_INSN = 5u,
  HEX_ARM64_FAULT_INVALID_ARG      = 6u,
};

struct alignas(8) HexArm64EmuState {
  uint64_t x[31];                            // +0x000..+0x0F7: x0..x30 (x30 = LR)
  uint64_t sp;                               // +0x0F8
  uint64_t pc;                               // +0x100
  uint32_t nzcv;                             // +0x108: N(31), Z(30), C(29), V(28)
  uint32_t step_count;                       // +0x10C
  uint32_t step_limit;                       // +0x110
  uint32_t fault_code;                       // +0x114: HexArm64EmuFault
  uint64_t code_va;                          // +0x118
  uint32_t code_len;                         // +0x120
  uint32_t halted;                           // +0x124
  uint64_t stack_base;                       // +0x128
  uint64_t stack_top;                        // +0x130
  uint8_t  stack[HEX_ARM64_EMU_STACK_SIZE];  // +0x138..+0x1137
};

enum HexOpaqueOutcome : uint32_t {
  HEX_OPAQUE_UNKNOWN      = 0u,
  HEX_OPAQUE_ALWAYS_TAKEN = 1u,
  HEX_OPAQUE_NEVER_TAKEN  = 2u,
};

struct alignas(8) HexOpaqueBranchResult {
  uint32_t outcome;         // +0x00: HexOpaqueOutcome
  uint32_t samples_tested;  // +0x04
  uint32_t taken_count;     // +0x08
  uint32_t fault_code;      // +0x0C
  uint64_t branch_va;       // +0x10
  uint64_t taken_target;    // +0x18
  uint64_t fallthrough_va;  // +0x20
  uint64_t resolved_target; // +0x28
};

struct alignas(8) HexIndirectTargetResult {
  uint32_t resolved;    // +0x00: 1 if resolved cleanly
  uint32_t fault_code;  // +0x04: HexArm64EmuFault
  uint32_t steps_used;  // +0x08
  uint32_t reg_index;   // +0x0C: Rn of BR/BLR
  uint64_t branch_va;   // +0x10
  uint64_t target_va;   // +0x18
};

#ifdef __cplusplus
static_assert(sizeof(HexCffBlock) == 48, "HexCffBlock must be 48 bytes");
static_assert(alignof(HexCffBlock) == 8, "HexCffBlock must be 8-byte aligned");

static_assert(sizeof(HexCffEdge) == 16, "HexCffEdge must be 16 bytes");
static_assert(alignof(HexCffEdge) == 4, "HexCffEdge must be 4-byte aligned");

static_assert(sizeof(HexCffUnflattenResult) == 40, "HexCffUnflattenResult must be 40 bytes");
static_assert(alignof(HexCffUnflattenResult) == 4, "HexCffUnflattenResult must be 4-byte aligned");

static_assert(sizeof(HexMbaNode) == 24, "HexMbaNode must be 24 bytes");
static_assert(alignof(HexMbaNode) == 8, "HexMbaNode must be 8-byte aligned");

static_assert(sizeof(HexMbaProofResult) == 96, "HexMbaProofResult must be 96 bytes");
static_assert(alignof(HexMbaProofResult) == 8, "HexMbaProofResult must be 8-byte aligned");

static_assert(sizeof(HexArm64EmuState) == 0x1138u, "HexArm64EmuState must be 4408 bytes");
static_assert(alignof(HexArm64EmuState) == 8, "HexArm64EmuState must be 8-byte aligned");

static_assert(sizeof(HexOpaqueBranchResult) == 48, "HexOpaqueBranchResult must be 48 bytes");
static_assert(alignof(HexOpaqueBranchResult) == 8, "HexOpaqueBranchResult must be 8-byte aligned");

static_assert(sizeof(HexIndirectTargetResult) == 32, "HexIndirectTargetResult must be 32 bytes");
static_assert(alignof(HexIndirectTargetResult) == 8, "HexIndirectTargetResult must be 8-byte aligned");
#endif

// ============================================================================
// 4. Extern "C" WASM Exports
// ============================================================================

HEX_WASM_EXPORT("hex_cff_unflatten")
HexStatus hex_cff_unflatten(
    const HexCffBlock* blocks, uint32_t block_count,
    const HexCffEdge* in_edges, uint32_t in_edge_count,
    HexCffEdge* out_edges, uint32_t max_out_edges,
    HexCffUnflattenResult* out_result);

HEX_WASM_EXPORT("hex_mba_eval")
uint64_t hex_mba_eval(
    const HexMbaNode* nodes, uint32_t node_count, uint32_t root_idx,
    uint64_t x, uint64_t y, uint64_t z);

HEX_WASM_EXPORT("hex_mba_verify_equiv")
HexStatus hex_mba_verify_equiv(
    const HexMbaNode* orig_nodes, uint32_t orig_count, uint32_t orig_root,
    const HexMbaNode* cand_nodes, uint32_t cand_count, uint32_t cand_root,
    uint32_t num_vars, HexMbaProofResult* out_proof);

HEX_WASM_EXPORT("hex_mba_simplify")
HexStatus hex_mba_simplify(
    const HexMbaNode* in_nodes, uint32_t in_count, uint32_t root_idx,
    HexMbaNode* out_nodes, uint32_t max_out_nodes, uint32_t* out_root_idx,
    HexMbaProofResult* out_proof);

HEX_WASM_EXPORT("hex_arm64_emu_init")
HexStatus hex_arm64_emu_init(
    HexArm64EmuState* state, uint64_t entry_pc, uint64_t code_va,
    uint32_t code_len, uint32_t step_limit);

HEX_WASM_EXPORT("hex_arm64_emu_step")
HexStatus hex_arm64_emu_step(
    HexArm64EmuState* state, const uint8_t* code_ptr, uint32_t code_len);

HEX_WASM_EXPORT("hex_arm64_emu_run")
HexStatus hex_arm64_emu_run(
    HexArm64EmuState* state, const uint8_t* code_ptr, uint32_t code_len);

HEX_WASM_EXPORT("hex_deobf_eval_opaque_branch")
HexStatus hex_deobf_eval_opaque_branch(
    const uint8_t* code_ptr, uint32_t code_len,
    uint64_t code_va, uint64_t entry_va, uint64_t branch_va,
    uint32_t step_limit, HexOpaqueBranchResult* out_result);

HEX_WASM_EXPORT("hex_deobf_resolve_indirect_target")
HexStatus hex_deobf_resolve_indirect_target(
    const uint8_t* code_ptr, uint32_t code_len,
    uint64_t code_va, uint64_t entry_va, uint64_t init_x0,
    uint32_t step_limit, HexIndirectTargetResult* out_result);

HEX_WASM_EXPORT("hex_deobf_scratch_ptr")
uint8_t* hex_deobf_scratch_ptr(void);

HEX_WASM_EXPORT("hex_deobf_scratch_size")
uint32_t hex_deobf_scratch_size(void);

#ifdef __cplusplus
}
#endif

#endif  // HEX_DEOBF_HPP
