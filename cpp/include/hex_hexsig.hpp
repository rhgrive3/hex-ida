#ifndef HEX_HEXSIG_HPP
#define HEX_HEXSIG_HPP

#include "hex_abi.hpp"
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// 1. Bitfield / Struct / Union Access Evidence PODs (v6 §4)
// ============================================================================

typedef enum HexBitfieldOpKind {
  HEX_BF_OP_UNKNOWN = 0,
  HEX_BF_OP_UBFX    = 1,  // UBFM (immr <= imms, imms < reg_bits - 1)
  HEX_BF_OP_SBFX    = 2,  // SBFM (immr <= imms, imms < reg_bits - 1)
  HEX_BF_OP_BFI     = 3,  // BFM (imms < immr)
  HEX_BF_OP_BFXIL   = 4,  // BFM (immr <= imms)
  HEX_BF_OP_AND_LSR = 5,  // AND+LSR or LSR+AND extraction sequence
  HEX_BF_OP_BIC_ORR = 6,  // BIC+ORR bitfield insertion sequence
  HEX_BF_OP_TBZ_TST = 7,  // TBZ/TBNZ or TST bit test
} HexBitfieldOpKind;

typedef enum HexFieldTypeHint {
  HEX_FIELD_TYPE_UNKNOWN  = 0,
  HEX_FIELD_TYPE_INT      = 1,
  HEX_FIELD_TYPE_UINT     = 2,
  HEX_FIELD_TYPE_FLOAT    = 3,
  HEX_FIELD_TYPE_DOUBLE   = 4,
  HEX_FIELD_TYPE_PTR      = 5,
  HEX_FIELD_TYPE_SIMD     = 6,
  HEX_FIELD_TYPE_BITFIELD = 7,
} HexFieldTypeHint;

enum {
  HEX_BF_FLAG_NONE     = 0u,
  HEX_BF_FLAG_SIGNED   = 1u << 0,
  HEX_BF_FLAG_WRITE    = 1u << 1,
  HEX_BF_FLAG_64BIT    = 1u << 2,
  HEX_BF_FLAG_FROM_MEM = 1u << 3,
  HEX_BF_FLAG_CONFLICT = 1u << 4,
};

enum {
  HEX_SF_FLAG_NONE       = 0u,
  HEX_SF_FLAG_HAS_BF     = 1u << 0,
  HEX_SF_FLAG_IN_UNION   = 1u << 1,
  HEX_SF_FLAG_IS_PADDING = 1u << 2,
  HEX_SF_FLAG_READ       = 1u << 3,
  HEX_SF_FLAG_WRITE      = 1u << 4,
  HEX_SF_FLAG_SIGNED     = 1u << 5,
  HEX_SF_FLAG_UNSIGNED   = 1u << 6,
};

enum {
  HEX_UNION_FLAG_CONFIRMED      = 1u << 0,
  HEX_UNION_FLAG_TYPE_CONFLICT  = 1u << 1,
  HEX_UNION_FLAG_WIDTH_CONFLICT = 1u << 2,
};

typedef struct alignas(8) HexBitfieldAccess {
  uint32_t insn_offset;      // +0x00: byte offset of bitfield instruction
  int32_t  struct_offset;    // +0x04: byte offset in base struct (-1 if register-only)
  uint8_t  base_reg;         // +0x08: base pointer register (0..30, 0xFF if none)
  uint8_t  src_reg;          // +0x09: source/container register
  uint8_t  dst_reg;          // +0x0A: destination register
  uint8_t  op_kind;          // +0x0B: HexBitfieldOpKind
  uint8_t  lsb;              // +0x0C: bitfield LSB (0..63)
  uint8_t  width;            // +0x0D: bitfield width in bits (1..64)
  uint8_t  container_bytes;  // +0x0E: container byte width (1, 2, 4, 8)
  uint8_t  flags;            // +0x0F: HEX_BF_FLAG_*
  uint64_t bit_mask;         // +0x10: bitmask in container coordinates
} HexBitfieldAccess;

typedef struct alignas(4) HexStructFieldCandidate {
  int32_t  offset;           // +0x00: byte offset from base_reg
  uint16_t size;             // +0x04: byte width (1, 2, 4, 8, 16)
  uint16_t alignment;        // +0x06: inferred natural alignment (1, 2, 4, 8, 16)
  uint8_t  base_reg;         // +0x08: base pointer register (0..30)
  uint8_t  type_hint;        // +0x09: HexFieldTypeHint
  uint8_t  flags;            // +0x0A: HEX_SF_FLAG_*
  uint8_t  bf_count;         // +0x0B: number of bitfield slices in this field
  uint16_t access_count;     // +0x0C: coalesced memory access count
  uint16_t union_group_id;   // +0x0E: 0xFFFF if none, else index in HexUnionOverlapGroup[]
  uint32_t first_insn_off;   // +0x10: first instruction byte offset observing this field
  uint32_t padding_before;   // +0x14: inferred padding bytes immediately before this field
} HexStructFieldCandidate;

typedef struct alignas(4) HexUnionOverlapGroup {
  uint16_t group_id;         // +0x00: 0-based union group index
  uint8_t  base_reg;         // +0x02: base pointer register
  uint8_t  member_count;     // +0x03: overlapping field candidates in this group
  int32_t  start_offset;     // +0x04: min byte offset of overlap span
  int32_t  end_offset;       // +0x08: max byte end offset of overlap span
  uint16_t total_accesses;   // +0x0C: total accesses across overlapping members
  uint16_t minority_pct;     // +0x0E: minority share (0..100)
  uint32_t flags;            // +0x10: HEX_UNION_FLAG_*
} HexUnionOverlapGroup;

typedef struct alignas(4) HexBitfieldStructSummary {
  uint32_t bf_count;         // +0x00: emitted HexBitfieldAccess count
  uint32_t field_count;      // +0x04: emitted HexStructFieldCandidate count
  uint32_t union_count;      // +0x08: emitted HexUnionOverlapGroup count
  uint32_t struct_size;      // +0x0C: inferred aligned size of primary struct
  uint16_t struct_align;     // +0x10: inferred max alignment of primary struct
  uint16_t total_padding;    // +0x12: inferred internal + tail padding bytes
} HexBitfieldStructSummary;

// ============================================================================
// 2. Sparse Switch & LSDA PODs (v6 §5)
// ============================================================================

typedef enum HexSwitchKind {
  HEX_SWITCH_NONE        = 0,
  HEX_SWITCH_DENSE_TABLE = 1,
  HEX_SWITCH_SPARSE_BST  = 2,
  HEX_SWITCH_HYBRID      = 3,
} HexSwitchKind;

enum {
  HEX_SWITCH_FLAG_HAS_DEFAULT     = 1u << 0,
  HEX_SWITCH_FLAG_HAS_TABLE       = 1u << 1,
  HEX_SWITCH_FLAG_BST_BALANCED    = 1u << 2,
  HEX_SWITCH_FLAG_INVERTED_BOUNDS = 1u << 3,
};

typedef struct alignas(8) HexSparseSwitchCase {
  int64_t  case_value;       // +0x00: matched case constant
  uint64_t target_va;        // +0x08: branch target virtual address
  uint32_t cmp_insn_off;     // +0x10: byte offset of CMP/CBZ instruction
  uint32_t br_insn_off;      // +0x14: byte offset of branch instruction
} HexSparseSwitchCase;

typedef struct alignas(8) HexSwitchPlan {
  uint64_t switch_va;        // +0x00: root compare/dispatch virtual address
  uint64_t default_va;       // +0x08: default target VA (0 if unknown)
  uint64_t table_va;         // +0x10: jump table VA (0 for pure sparse BST)
  int64_t  min_case;         // +0x18: minimum case value
  int64_t  max_case;         // +0x20: maximum case value
  uint16_t case_count;       // +0x28: number of cases belonging to this switch
  uint8_t  kind;             // +0x2A: HexSwitchKind
  uint8_t  index_reg;        // +0x2B: switched register (0..30, 0xFF=unknown)
  uint8_t  elem_width;       // +0x2C: jump table entry width (0 for BST, 1/2/4/8)
  uint8_t  scale_shift;      // +0x2D: jump table index shift (0..3)
  uint16_t flags;            // +0x2E: HEX_SWITCH_FLAG_*
} HexSwitchPlan;

// DWARF EH Pointer Encoding constants (Itanium ABI / .gcc_except_table)
enum {
  HEX_DW_EH_PE_absptr   = 0x00u,
  HEX_DW_EH_PE_uleb128  = 0x01u,
  HEX_DW_EH_PE_udata2   = 0x02u,
  HEX_DW_EH_PE_udata4   = 0x03u,
  HEX_DW_EH_PE_udata8   = 0x04u,
  HEX_DW_EH_PE_sleb128  = 0x09u,
  HEX_DW_EH_PE_sdata2   = 0x0Au,
  HEX_DW_EH_PE_sdata4   = 0x0Bu,
  HEX_DW_EH_PE_sdata8   = 0x0Cu,
  HEX_DW_EH_PE_pcrel    = 0x10u,
  HEX_DW_EH_PE_textrel  = 0x20u,
  HEX_DW_EH_PE_datarel  = 0x30u,
  HEX_DW_EH_PE_funcrel  = 0x40u,
  HEX_DW_EH_PE_aligned  = 0x50u,
  HEX_DW_EH_PE_indirect = 0x80u,
  HEX_DW_EH_PE_omit     = 0xFFu,
};

enum {
  HEX_LSDA_CS_HAS_LP     = 1u << 0,
  HEX_LSDA_CS_IS_CLEANUP = 1u << 1,
  HEX_LSDA_CS_HAS_CATCH  = 1u << 2,
  HEX_LSDA_CS_HAS_FILTER = 1u << 3,
};

enum {
  HEX_LSDA_ACT_CLEANUP = 1u << 0,
  HEX_LSDA_ACT_CATCH   = 1u << 1,
  HEX_LSDA_ACT_FILTER  = 1u << 2,
};

enum {
  HEX_LSDA_HDR_HAS_LP_START  = 1u << 0,
  HEX_LSDA_HDR_HAS_TTYPE     = 1u << 1,
  HEX_LSDA_HDR_TRUNCATED_OUT = 1u << 2,
};

typedef struct alignas(8) HexLsdaCallSite {
  uint64_t try_start_va;     // +0x00: func_va + start_offset
  uint64_t try_end_va;       // +0x08: try_start_va + length
  uint64_t landing_pad_va;   // +0x10: 0 if no LP, else lp_start_va + lp_offset
  uint32_t action_offset;    // +0x18: 0 = cleanup only, >0 = 1-based offset in action table
  uint16_t action_index;     // +0x1C: 0xFFFF if none, else index in HexLsdaAction[]
  uint16_t flags;            // +0x1E: HEX_LSDA_CS_*
} HexLsdaCallSite;

typedef struct alignas(4) HexLsdaAction {
  int32_t  type_filter;      // +0x00: SLEB128 (>0 catch TType idx, 0=cleanup, <0 filter)
  int32_t  next_disp;        // +0x04: SLEB128 byte displacement to next action (0=end)
  uint32_t table_offset;     // +0x08: 1-based byte offset in action table
  uint16_t next_index;       // +0x0C: 0xFFFF if end, else index in HexLsdaAction[]
  uint16_t flags;            // +0x0E: HEX_LSDA_ACT_*
} HexLsdaAction;

typedef struct alignas(8) HexLsdaHeader {
  uint64_t lp_start_va;       // +0x00: landing pad base VA (defaults to func_va)
  uint32_t call_site_count;   // +0x08: parsed HexLsdaCallSite count
  uint32_t action_count;      // +0x0C: parsed HexLsdaAction count
  uint32_t ttype_base_off;    // +0x10: byte offset of TType base in LSDA buffer (0 if omit)
  uint32_t action_table_off;  // +0x14: byte offset where action table begins
  uint8_t  lp_start_enc;      // +0x18: LPStart encoding
  uint8_t  ttype_enc;         // +0x19: TType encoding
  uint8_t  call_site_enc;     // +0x1A: CallSite encoding
  uint8_t  flags;             // +0x1B: HEX_LSDA_HDR_*
  uint32_t call_site_tbl_len; // +0x1C: ULEB128 byte length of call-site table
} HexLsdaHeader;

// ============================================================================
// 3. HSIG1 Binary Signature Format PODs (v6 §11)
// ============================================================================

enum {
  HEX_SIG_ARCH_NONE  = 0u,
  HEX_SIG_ARCH_ARM64 = 1u << 0,
  HEX_SIG_ARCH_X64   = 1u << 1,
};

enum {
  HEX_SIG_ENTRY_NONE          = 0u,
  HEX_SIG_ENTRY_HAS_WILDCARDS = 1u << 0,
  HEX_SIG_ENTRY_HAS_TAIL_CRC  = 1u << 1,
  HEX_SIG_ENTRY_VENDOR_LIB    = 1u << 2,
  HEX_SIG_ENTRY_CRYPTO_LIB    = 1u << 3,
};

typedef enum HexSigMatchStatus {
  HEX_SIG_MATCH_NONE      = 0,
  HEX_SIG_MATCH_PROLOGUE  = 1,
  HEX_SIG_MATCH_FULL      = 2,
  HEX_SIG_MATCH_AMBIGUOUS = 3,
} HexSigMatchStatus;

// 32 bytes (alignas(4)) — HSIG1 Binary Pack Header
typedef struct alignas(4) HexSigHeader {
  uint8_t  magic[4];         // +0x00: {'H', 'S', 'I', 'G'}
  uint16_t version;          // +0x04: 1
  uint16_t arch_mask;        // +0x06: HEX_SIG_ARCH_*
  uint32_t entry_count;      // +0x08: number of HexSigEntry records
  uint32_t entries_off;      // +0x0C: byte offset to HexSigEntry[0] (>= 32, 8B aligned)
  uint32_t str_pool_off;     // +0x10: byte offset to UTF-8 NUL-terminated string pool
  uint32_t str_pool_len;     // +0x14: byte length of string pool
  uint32_t total_size;       // +0x18: total pack size in bytes
  uint32_t checksum_fnv32;   // +0x1C: FNV-1a 32-bit over pack with +0x1C..+0x1F zeroed
} HexSigHeader;

// 96 bytes (alignas(8)) — HSIG1 Signature Entry
typedef struct alignas(8) HexSigEntry {
  uint64_t prologue_hash64;    // +0x00: FNV-1a 64-bit hash of normalized prologue
  uint32_t name_off;           // +0x08: offset into StringPool
  uint16_t name_len;           // +0x0C: symbol name byte length (excluding NUL)
  uint16_t tail_crc16;         // +0x0E: CRC-16/CCITT of normalized tail window
  uint16_t tail_offset;        // +0x10: byte offset from func start for tail CRC
  uint16_t tail_len;           // +0x12: byte length of tail CRC window (0=none)
  uint16_t flags;              // +0x14: HEX_SIG_ENTRY_*
  uint8_t  arch;               // +0x16: HEX_SIG_ARCH_ARM64 or HEX_SIG_ARCH_X64
  uint8_t  prologue_len;       // +0x17: active prologue length in bytes (4..32)
  uint16_t min_func_len;       // +0x18: minimum function length in bytes
  uint16_t lib_id;             // +0x1A: library ID (0xFFFF=none)
  uint16_t base_confidence;    // +0x1C: base confidence (0..1000)
  uint16_t reserved;           // +0x1E: 0
  uint8_t  pattern[32];        // +0x20: 32-byte normalized prologue pattern
  uint8_t  wildcard_mask[32];  // +0x40: 32-byte bitmask (1=fixed bit, 0=wildcard bit)
} HexSigEntry;

// 32 bytes (alignas(8)) — HSIG1 Match Result
typedef struct alignas(8) HexSigMatchResult {
  uint64_t query_hash64;       // +0x00: FNV-1a 64-bit hash of normalized query prologue
  uint32_t entry_index;        // +0x08: matched HexSigEntry index (0xFFFFFFFFu=none)
  uint32_t name_off;           // +0x0C: offset in StringPool (0xFFFFFFFFu=none)
  uint16_t name_len;           // +0x10: matched symbol name length
  uint16_t lib_id;             // +0x12: matched library ID (0xFFFF=none)
  uint16_t confidence;         // +0x14: match confidence (0..1000)
  uint16_t runner_up_conf;     // +0x16: 2nd-best confidence (0..1000)
  uint16_t matched_bits;       // +0x18: fixed bits verified in prologue
  uint16_t tail_crc16_actual;  // +0x1A: computed tail CRC16 of query function
  uint8_t  status;             // +0x1C: HexSigMatchStatus
  uint8_t  tail_crc_matched;   // +0x1D: 1 if tail CRC16 matched, 0 otherwise
  uint16_t candidate_count;    // +0x1E: entries passing prologue match
} HexSigMatchResult;

// ============================================================================
// 4. Static Layout Assertions (C++20)
// ============================================================================

#ifdef __cplusplus
static_assert(sizeof(HexBitfieldAccess) == 24, "HexBitfieldAccess must be 24 bytes");
static_assert(alignof(HexBitfieldAccess) == 8, "HexBitfieldAccess alignof must be 8");

static_assert(sizeof(HexStructFieldCandidate) == 24, "HexStructFieldCandidate must be 24 bytes");
static_assert(alignof(HexStructFieldCandidate) == 4, "HexStructFieldCandidate alignof must be 4");

static_assert(sizeof(HexUnionOverlapGroup) == 20, "HexUnionOverlapGroup must be 20 bytes");
static_assert(alignof(HexUnionOverlapGroup) == 4, "HexUnionOverlapGroup alignof must be 4");

static_assert(sizeof(HexBitfieldStructSummary) == 20, "HexBitfieldStructSummary must be 20 bytes");
static_assert(alignof(HexBitfieldStructSummary) == 4, "HexBitfieldStructSummary alignof must be 4");

static_assert(sizeof(HexSparseSwitchCase) == 24, "HexSparseSwitchCase must be 24 bytes");
static_assert(alignof(HexSparseSwitchCase) == 8, "HexSparseSwitchCase alignof must be 8");

static_assert(sizeof(HexSwitchPlan) == 48, "HexSwitchPlan must be 48 bytes");
static_assert(alignof(HexSwitchPlan) == 8, "HexSwitchPlan alignof must be 8");

static_assert(sizeof(HexLsdaCallSite) == 32, "HexLsdaCallSite must be 32 bytes");
static_assert(alignof(HexLsdaCallSite) == 8, "HexLsdaCallSite alignof must be 8");

static_assert(sizeof(HexLsdaAction) == 16, "HexLsdaAction must be 16 bytes");
static_assert(alignof(HexLsdaAction) == 4, "HexLsdaAction alignof must be 4");

static_assert(sizeof(HexLsdaHeader) == 32, "HexLsdaHeader must be 32 bytes");
static_assert(alignof(HexLsdaHeader) == 8, "HexLsdaHeader alignof must be 8");

static_assert(sizeof(HexSigHeader) == 32, "HexSigHeader must be 32 bytes");
static_assert(alignof(HexSigHeader) == 4, "HexSigHeader alignof must be 4");

static_assert(sizeof(HexSigEntry) == 96, "HexSigEntry must be 96 bytes");
static_assert(alignof(HexSigEntry) == 8, "HexSigEntry alignof must be 8");

static_assert(sizeof(HexSigMatchResult) == 32, "HexSigMatchResult must be 32 bytes");
static_assert(alignof(HexSigMatchResult) == 8, "HexSigMatchResult alignof must be 8");
#endif

// ============================================================================
// 5. extern "C" WASM Exports
// ============================================================================

HEX_WASM_EXPORT("hex_bitfield_struct_scan")
HexStatus hex_bitfield_struct_scan(
    const uint8_t* code_ptr,
    uint32_t code_len,
    HexBitfieldAccess* out_bf,
    uint32_t max_bf,
    HexStructFieldCandidate* out_fields,
    uint32_t max_fields,
    HexUnionOverlapGroup* out_unions,
    uint32_t max_unions,
    HexBitfieldStructSummary* out_summary);

HEX_WASM_EXPORT("hex_hexsig_mount")
HexStatus hex_hexsig_mount(
    const uint8_t* pack_ptr,
    uint32_t pack_len);

HEX_WASM_EXPORT("hex_hexsig_normalize_arm64")
HexStatus hex_hexsig_normalize_arm64(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint8_t* out_norm32,
    uint8_t* out_mask32,
    uint64_t* out_hash64);

HEX_WASM_EXPORT("hex_hexsig_normalize_x64")
HexStatus hex_hexsig_normalize_x64(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint8_t* out_norm32,
    uint8_t* out_mask32,
    uint64_t* out_hash64);

HEX_WASM_EXPORT("hex_hexsig_match_fn")
HexStatus hex_hexsig_match_fn(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint32_t arch,
    HexSigMatchResult* out_result);

HEX_WASM_EXPORT("hex_sparse_switch_detect")
HexStatus hex_sparse_switch_detect(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint64_t func_va,
    HexSwitchPlan* out_plans,
    uint32_t max_plans,
    HexSparseSwitchCase* out_cases,
    uint32_t max_cases,
    uint32_t* out_plan_count,
    uint32_t* out_case_count);

HEX_WASM_EXPORT("hex_lsda_parse")
HexStatus hex_lsda_parse(
    const uint8_t* lsda_ptr,
    uint32_t lsda_len,
    uint64_t func_va,
    HexLsdaHeader* out_header,
    HexLsdaCallSite* out_sites,
    uint32_t max_sites,
    HexLsdaAction* out_actions,
    uint32_t max_actions);

#ifdef __cplusplus
}
#endif

#endif  // HEX_HEXSIG_HPP
