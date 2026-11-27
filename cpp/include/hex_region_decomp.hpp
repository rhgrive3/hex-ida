#ifndef HEX_REGION_DECOMP_HPP
#define HEX_REGION_DECOMP_HPP

#include <stddef.h>
#include <stdint.h>

#include "hex_abi.hpp"

#ifdef __cplusplus
#define HEX_ALIGN8 alignas(8)
#else
#define HEX_ALIGN8 _Alignas(8)
#endif

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// Side-table IR flags (upper byte: non-colliding with c_emitter/IrInst 0x00..0xFF)
// ============================================================================
static const uint16_t HEX_IR_FLAG_STACK_WEB = 0x0100u;
static const uint16_t HEX_IR_FLAG_ASM_ISLAND = 0x0200u;

// Emit mode flags (§6.1 priority: JS_PARITY > TYPED_UI > TYPED_C11)
static const uint32_t HEX_TYPED_EMIT_FLAG_JS_PARITY = 1u << 0;
static const uint32_t HEX_TYPED_EMIT_FLAG_TYPED_C11 = 1u << 1;
static const uint32_t HEX_TYPED_EMIT_FLAG_TYPED_UI = 1u << 2;

// ============================================================================
// 1. Region-Scoped Decompilation Slicing (§16.3)
// ============================================================================
static const uint32_t HEX_REGION_NO_NODE = 0xFFFFFFFFu;

static const uint32_t HEX_REGION_FLAG_NONE = 0u;
static const uint32_t HEX_REGION_FLAG_NODE_CAPPED = 1u << 0;
static const uint32_t HEX_REGION_FLAG_EDGE_CAPPED = 1u << 1;
static const uint32_t HEX_REGION_FLAG_HAS_EXIT_BOUNDARY = 1u << 2;
static const uint32_t HEX_REGION_FLAG_HAS_ENTRY_BOUNDARY = 1u << 3;
static const uint32_t HEX_REGION_FLAG_SESE = 1u << 4;
static const uint32_t HEX_REGION_FLAG_LINEAR_FALLBACK = 1u << 5;
static const uint32_t HEX_REGION_FLAG_HAS_BACKEDGE = 1u << 6;

typedef struct HEX_ALIGN8 HexRegionNodeIn {
  uint64_t va;          // +0x00: Basic block start VA
  uint32_t insn_count;  // +0x08: Number of instructions in block
  uint32_t flags;       // +0x0C: Optional block flags
} HexRegionNodeIn;

typedef struct HexRegionEdgeIn {
  uint32_t src_node;  // +0x00: Source basic block index
  uint32_t dst_node;  // +0x04: Destination basic block index
} HexRegionEdgeIn;

typedef struct HEX_ALIGN8 HexRegionSlice {
  uint64_t entry_va;        // +0x00: Entry VA of the extracted region
  uint32_t node_count;      // +0x08: Number of CFG nodes included in slice
  uint32_t edge_count;      // +0x0C: Number of CFG edges included in slice
  uint32_t boundary_flags;  // +0x10: HEX_REGION_FLAG_* bitmask
  uint32_t entry_node;      // +0x14: Dominator root node index of slice
} HexRegionSlice;

typedef struct HEX_ALIGN8 HexRegionBoundarySummary {
  uint32_t entry_node;          // +0x00: Entry node index
  uint32_t exit_node;           // +0x04: Unique external exit node or HEX_REGION_NO_NODE
  uint32_t incoming_ext_edges;  // +0x08: Edges entering slice from outside
  uint32_t outgoing_ext_edges;  // +0x0C: Edges leaving slice to outside
  uint32_t total_insns;         // +0x10: Total instruction count across slice nodes
  uint32_t boundary_flags;      // +0x14: Mirror of HexRegionSlice::boundary_flags
  uint64_t exit_va;             // +0x18: VA of unique exit node, or 0
} HexRegionBoundarySummary;

// ============================================================================
// 2. Stack-Slot Lifetime Splitting (§16.4)
// ============================================================================
typedef enum HexStackAccessKind {
  HEX_STACK_ACCESS_LOAD = 0,
  HEX_STACK_ACCESS_STORE = 1,
  HEX_STACK_ACCESS_ADDR_OF = 2,
} HexStackAccessKind;

static const uint32_t HEX_STACK_ACCESS_FLAG_NONE = 0u;
static const uint32_t HEX_STACK_ACCESS_FLAG_ESCAPED = 1u << 0;

static const uint16_t HEX_STACK_WEB_FLAG_NONE = 0u;
static const uint16_t HEX_STACK_WEB_FLAG_ESCAPED = 1u << 0;
static const uint16_t HEX_STACK_WEB_FLAG_MERGED_OVERLAP = 1u << 1;
static const uint16_t HEX_STACK_WEB_FLAG_WIDTH_MISMATCH = 1u << 2;
static const uint16_t HEX_STACK_WEB_FLAG_MULTI_DEF = 1u << 3;
static const uint16_t HEX_STACK_WEB_FLAG_CROSS_BLOCK = 1u << 4;
static const uint16_t HEX_STACK_WEB_FLAG_PARTIAL_OVERLAP = 1u << 5;

typedef struct HEX_ALIGN8 HexStackAccessIn {
  uint32_t inst_idx;      // +0x00: Linear/RPO instruction index
  int32_t stack_offset;   // +0x04: Normalized SP-relative offset
  uint16_t kind;          // +0x08: HexStackAccessKind
  uint16_t width_bytes;   // +0x0A: Access width in bytes (1,2,4,8,16)
  uint32_t type_id;       // +0x0C: Type ID hint (0 = unknown)
  uint32_t block_id;      // +0x10: Basic block ID
  uint32_t flags;         // +0x14: HEX_STACK_ACCESS_FLAG_*
} HexStackAccessIn;

typedef struct HEX_ALIGN8 HexStackWebEntry {
  int32_t stack_offset;   // +0x00: Normalized SP-relative stack slot offset
  uint32_t web_id;        // +0x04: Distinct web index within stack_offset (0, 1, ...)
  uint32_t def_idx;       // +0x08: Primary defining instruction index
  uint32_t first_use_idx; // +0x0C: Earliest instruction index in this web
  uint32_t last_use_idx;  // +0x10: Latest instruction index in this web
  uint16_t width_bytes;   // +0x14: Access width in bytes
  uint16_t flags;         // +0x16: HEX_STACK_WEB_FLAG_*
  uint32_t type_id;       // +0x18: Voted type ID for this web
  uint32_t reserved_;     // +0x1C: Zero-initialized padding
} HexStackWebEntry;

// ============================================================================
// 3. ASM Island Preservation (§16.5)
// ============================================================================
typedef enum HexAsmIslandKind {
  HEX_ASM_ISLAND_NONE = 0,
  HEX_ASM_ISLAND_UNKNOWN = 1,
  HEX_ASM_ISLAND_SYS = 2,
  HEX_ASM_ISLAND_SVC = 3,
  HEX_ASM_ISLAND_CRYPTO_AES = 4,
  HEX_ASM_ISLAND_CRYPTO_SHA = 5,
  HEX_ASM_ISLAND_SVE = 6,
  HEX_ASM_ISLAND_PAC = 7,
} HexAsmIslandKind;

static const uint32_t HEX_ASM_FLAG_NONE = 0u;
static const uint32_t HEX_ASM_FLAG_CLOBBERS_MEM = 1u << 0;
static const uint32_t HEX_ASM_FLAG_CLOBBERS_FLAGS = 1u << 1;
static const uint32_t HEX_ASM_FLAG_MAY_TRAP = 1u << 2;
static const uint32_t HEX_ASM_FLAG_SIMD_VEC = 1u << 3;
static const uint32_t HEX_ASM_FLAG_SIDE_EFFECT = 1u << 4;

typedef struct HEX_ALIGN8 HexAsmIslandEntry {
  uint64_t insn_va;         // +0x00: Virtual address of instruction
  uint32_t raw_word;        // +0x08: Raw 32-bit ARM64 instruction word
  uint32_t kind;            // +0x0C: HexAsmIslandKind
  uint32_t reg_read_mask;   // +0x10: GPR read bitmask (bit i = x[i], bit 31 = sp)
  uint32_t reg_write_mask;  // +0x14: GPR write/clobber bitmask
  uint32_t flags;           // +0x18: HEX_ASM_FLAG_*
  uint32_t reserved_;       // +0x1C: Zero-initialized padding
} HexAsmIslandEntry;

// ============================================================================
// 4. Deterministic Typed C Token Emitter Context (§6)
// ============================================================================
typedef enum HexTypedEmitTokenKind {
  HEX_EMIT_TOK_TEXT = 0,
  HEX_EMIT_TOK_CAST = 1,
  HEX_EMIT_TOK_MEMBER_ARROW = 2,
  HEX_EMIT_TOK_MEMBER_DOT = 3,
  HEX_EMIT_TOK_SHIFTED_PTR = 4,
  HEX_EMIT_TOK_ASM_ISLAND = 5,
  HEX_EMIT_TOK_STACK_LOCAL = 6,
} HexTypedEmitTokenKind;

typedef struct HEX_ALIGN8 HexTypedEmitToken {
  uint32_t kind;      // +0x00: HexTypedEmitTokenKind
  uint32_t type_id;   // +0x04: Associated type ID
  uint32_t text_off;  // +0x08: Byte offset into output buffer
  uint32_t text_len;  // +0x0C: Byte length in output buffer
  uint64_t va;        // +0x10: Originating VA
} HexTypedEmitToken;

typedef struct HEX_ALIGN8 HexTypedEmitOp {
  uint32_t kind;           // +0x00: HexTypedEmitTokenKind
  uint32_t type_id;        // +0x04: Type ID hint
  uint32_t name_off;       // +0x08: Primary string offset in string_pool
  uint32_t name_len;       // +0x0C: Primary string length
  uint32_t field_off;      // +0x10: Secondary string offset in string_pool
  uint32_t field_len;      // +0x14: Secondary string length
  int64_t offset_or_imm;   // +0x18: Signed byte offset or raw_word
  uint32_t aux;            // +0x20: Aux (web_id or HexAsmIslandKind)
  uint32_t flags;          // +0x24: HEX_TYPED_EMIT_FLAG_*
  uint64_t va;             // +0x28: Originating VA
} HexTypedEmitOp;

// ============================================================================
// Public C ABI WASM Exports
// ============================================================================
HEX_WASM_EXPORT("hex_region_extract")
int32_t hex_region_extract(
    const HexRegionNodeIn* nodes,
    uint32_t node_count,
    const HexRegionEdgeIn* edges,
    uint32_t edge_count,
    uint64_t target_va,
    uint32_t max_nodes,
    uint32_t max_edges,
    HexRegionSlice* out_slice,
    uint32_t* out_node_ids,
    uint32_t out_node_ids_cap,
    HexRegionBoundarySummary* out_summary);

HEX_WASM_EXPORT("hex_stack_web_split")
int32_t hex_stack_web_split(
    const HexStackAccessIn* accesses,
    uint32_t access_count,
    HexStackWebEntry* out_webs,
    uint32_t out_webs_cap,
    uint32_t* out_web_count,
    uint32_t* out_access_web_map);

HEX_WASM_EXPORT("hex_asm_island_classify")
uint32_t hex_asm_island_classify(
    uint64_t insn_va,
    uint32_t raw_word,
    HexAsmIslandEntry* out_entry);

HEX_WASM_EXPORT("hex_asm_island_register")
int32_t hex_asm_island_register(
    HexAsmIslandEntry* table,
    uint32_t capacity,
    uint32_t* inout_count,
    uint64_t insn_va,
    uint32_t raw_word,
    uint32_t* out_index,
    uint16_t* inout_inst_flags);

HEX_WASM_EXPORT("hex_typed_emit_format")
int32_t hex_typed_emit_format(
    const HexTypedEmitOp* ops,
    uint32_t op_count,
    const char* string_pool,
    uint32_t string_pool_len,
    char* out_buf,
    uint32_t out_buf_cap,
    uint32_t* out_written_len,
    HexTypedEmitToken* out_tokens,
    uint32_t out_tokens_cap,
    uint32_t* out_token_count);

#ifdef __cplusplus
}  // extern "C"

// Side-table flag non-collision assertions with lower 8-bit IR / c_emitter flags
static_assert((HEX_IR_FLAG_STACK_WEB & 0x00FFu) == 0u,
              "HEX_IR_FLAG_STACK_WEB must not collide with lower 8-bit IR/CEmit flags");
static_assert((HEX_IR_FLAG_ASM_ISLAND & 0x00FFu) == 0u,
              "HEX_IR_FLAG_ASM_ISLAND must not collide with lower 8-bit IR/CEmit flags");
static_assert((HEX_IR_FLAG_STACK_WEB & HEX_IR_FLAG_ASM_ISLAND) == 0u,
              "Side-table flags must be disjoint");

// Exact POD layout assertions (wasm32 & native 64-bit invariant)
static_assert(sizeof(HexRegionNodeIn) == 16, "HexRegionNodeIn must be 16 bytes");
static_assert(alignof(HexRegionNodeIn) == 8, "HexRegionNodeIn must be 8-byte aligned");

static_assert(sizeof(HexRegionEdgeIn) == 8, "HexRegionEdgeIn must be 8 bytes");
static_assert(alignof(HexRegionEdgeIn) == 4, "HexRegionEdgeIn must be 4-byte aligned");

static_assert(sizeof(HexRegionSlice) == 24, "HexRegionSlice must be 24 bytes");
static_assert(alignof(HexRegionSlice) == 8, "HexRegionSlice must be 8-byte aligned");

static_assert(sizeof(HexRegionBoundarySummary) == 32, "HexRegionBoundarySummary must be 32 bytes");
static_assert(alignof(HexRegionBoundarySummary) == 8, "HexRegionBoundarySummary must be 8-byte aligned");

static_assert(sizeof(HexStackAccessIn) == 24, "HexStackAccessIn must be 24 bytes");
static_assert(alignof(HexStackAccessIn) == 8, "HexStackAccessIn must be 8-byte aligned");

static_assert(sizeof(HexStackWebEntry) == 32, "HexStackWebEntry must be 32 bytes");
static_assert(alignof(HexStackWebEntry) == 8, "HexStackWebEntry must be 8-byte aligned");

static_assert(sizeof(HexAsmIslandEntry) == 32, "HexAsmIslandEntry must be 32 bytes");
static_assert(alignof(HexAsmIslandEntry) == 8, "HexAsmIslandEntry must be 8-byte aligned");

static_assert(sizeof(HexTypedEmitToken) == 24, "HexTypedEmitToken must be 24 bytes");
static_assert(alignof(HexTypedEmitToken) == 8, "HexTypedEmitToken must be 8-byte aligned");

static_assert(sizeof(HexTypedEmitOp) == 48, "HexTypedEmitOp must be 48 bytes");
static_assert(alignof(HexTypedEmitOp) == 8, "HexTypedEmitOp must be 8-byte aligned");

#endif

#endif  // HEX_REGION_DECOMP_HPP
