#ifndef HEX_TYPE_SYSTEM_HPP
#define HEX_TYPE_SYSTEM_HPP

#include <stdint.h>
#include <stddef.h>
#include "hex_abi.hpp"
#include "hex_runtime_profile.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// §1.1 16-bit TilTypeId Fixed Namespace (65,536 IDs)
// ============================================================================
typedef uint16_t TilTypeId;

enum HexTilBuiltinType {
  TIL_TYPE_UNKNOWN   = 0x0000u,
  TIL_TYPE_VOID      = 0x0001u,
  TIL_TYPE_BOOL      = 0x0002u,
  TIL_TYPE_I8        = 0x0003u,
  TIL_TYPE_U8        = 0x0004u,
  TIL_TYPE_I16       = 0x0005u,
  TIL_TYPE_U16       = 0x0006u,
  TIL_TYPE_I32       = 0x0007u,
  TIL_TYPE_U32       = 0x0008u,
  TIL_TYPE_I64       = 0x0009u,
  TIL_TYPE_U64       = 0x000Au,
  TIL_TYPE_I128      = 0x000Bu,
  TIL_TYPE_U128      = 0x000Cu,
  TIL_TYPE_F16       = 0x000Du,
  TIL_TYPE_F32       = 0x000Eu,
  TIL_TYPE_F64       = 0x000Fu,
  TIL_TYPE_V128      = 0x0010u,
  TIL_TYPE_OBJC_ID   = 0x0011u,
  TIL_TYPE_OBJC_SEL  = 0x0012u,
  TIL_CORE_MIN       = 0x0040u,
  TIL_CORE_MAX       = 0x0FFFu,
  TIL_PACK_MIN       = 0x1000u,
  TIL_PACK_MAX       = 0x5FFFu,
  TIL_LOCAL_MIN      = 0x6000u,
  TIL_LOCAL_MAX      = 0x7FFFu,
  TIL_RECOVERED_MIN  = 0x8000u,
  TIL_RECOVERED_MAX  = 0xFFFEu,
  TIL_TYPE_INVALID   = 0xFFFFu,
};

// ============================================================================
// §1.2 32-bit HexTypeId Canonical Bit Layout
//   Bit 31..24 (8-bit): aux_meta
//   Bit 23..21 (3-bit): kind_tag (HexTypeKind)
//   Bit 20     (1-bit): is_pac_signed
//   Bit 19     (1-bit): is_const
//   Bit 18..16 (3-bit): ptr_depth (0..6, 7=saturated)
//   Bit 15..0  (16-bit): base_til_id (TilTypeId)
// ============================================================================
typedef uint32_t HexTypeId;

#define HEX_TYPE_ID_NONE 0xFFFFFFFFu

enum HexTypeKind {
  HEX_TYPE_KIND_SCALAR   = 0u,  // Primitive / Scalar (aux_meta: 0=normal, 1=ENUM, 2=BITMASK)
  HEX_TYPE_KIND_STRUCT   = 1u,
  HEX_TYPE_KIND_ARRAY    = 2u,
  HEX_TYPE_KIND_FUNC_PTR = 3u,
  HEX_TYPE_KIND_BITFIELD = 4u,
  HEX_TYPE_KIND_UNION    = 5u,
  HEX_TYPE_KIND_OBJC_OBJ = 6u,  // ObjC / Swift nominal object
  HEX_TYPE_KIND_INVALID  = 7u,
};

enum HexScalarAuxMeta {
  HEX_AUX_SCALAR_NORMAL  = 0u,
  HEX_AUX_SCALAR_ENUM    = 1u,
  HEX_AUX_SCALAR_BITMASK = 2u,
  HEX_AUX_SCALAR_INVALID = 0xFFu,
};

static inline HexTypeId hex_type_make(
    TilTypeId base_til_id,
    uint8_t ptr_depth,
    uint8_t is_const,
    uint8_t is_pac_signed,
    uint8_t kind_tag,
    uint8_t aux_meta) {
  const uint32_t clamped_ptr = ptr_depth > 7u ? 7u : (uint32_t)ptr_depth;
  const uint32_t pac_bit = (clamped_ptr >= 1u && is_pac_signed != 0u) ? 1u : 0u;
  return ((uint32_t)aux_meta << 24u) |
         (((uint32_t)kind_tag & 7u) << 21u) |
         (pac_bit << 20u) |
         ((is_const != 0u ? 1u : 0u) << 19u) |
         (clamped_ptr << 16u) |
         (uint32_t)base_til_id;
}

static inline uint32_t hex_type_is_none(HexTypeId id) {
  return (id == HEX_TYPE_ID_NONE) ||
         ((id & 0xFFFFu) == TIL_TYPE_INVALID) ||
         (((id >> 21u) & 7u) == HEX_TYPE_KIND_INVALID);
}

static inline TilTypeId hex_type_base_til(HexTypeId id) {
  return (TilTypeId)(id & 0xFFFFu);
}

static inline uint8_t hex_type_ptr_depth(HexTypeId id) {
  return (uint8_t)((id >> 16u) & 7u);
}

static inline uint8_t hex_type_is_const(HexTypeId id) {
  return (uint8_t)((id >> 19u) & 1u);
}

static inline uint8_t hex_type_is_pac(HexTypeId id) {
  return (uint8_t)((id >> 20u) & 1u);
}

static inline uint8_t hex_type_kind(HexTypeId id) {
  return (uint8_t)((id >> 21u) & 7u);
}

static inline uint8_t hex_type_aux_meta(HexTypeId id) {
  return (uint8_t)((id >> 24u) & 0xFFu);
}

// ============================================================================
// §1/§2/§3 POD Structs (exact sizes, alignments, zero implicit padding)
// ============================================================================

// 24B POD — Unified type record descriptor
struct alignas(4) HexTypeRecord {
  uint32_t type_id;          // +0x00: canonical HexTypeId
  uint32_t name_off;         // +0x04: byte offset into string pool
  uint32_t byte_size;        // +0x08: size in bytes (0 if unsized/void)
  uint32_t first_member_idx; // +0x0C: start index in field/enum member table
  uint16_t member_count;     // +0x10: number of struct fields or enum members
  uint16_t pointee_tid;      // +0x12: TilTypeId of pointee/element/underlying type
  uint8_t  kind;             // +0x14: HexTypeKind
  uint8_t  align_log2;       // +0x15: log2(alignment)
  uint8_t  qualifiers;       // +0x16: bit0:const, bit1:signed, bit2:enum, bit3:bitmask, bit4:packed
  uint8_t  slot_id;          // +0x17: originating slot (0..3) or 0xFF
};

// 20B POD — Struct/Union field descriptor
struct alignas(4) HexStructField {
  uint32_t name_off;         // +0x00: field name offset in string pool
  uint32_t field_type_id;    // +0x04: HexTypeId
  int32_t  byte_offset;      // +0x08: signed byte offset (supports negative container_of)
  uint32_t byte_size;        // +0x0C: field width in bytes
  uint8_t  bf_lsb;           // +0x10: bitfield LSB (0..63)
  uint8_t  bf_width;         // +0x11: bitfield width (0=non-bitfield, 1..64)
  uint8_t  field_flags;      // +0x12: bit0:const, bit1:volatile, bit2:synthetic, bit3:pinned
  uint8_t  reserved;         // +0x13: explicit 0
};

// 12B POD — Enum / Bitmask member descriptor
struct alignas(4) HexEnumMember {
  uint32_t name_off;         // +0x00: member name offset in string pool
  int32_t  value_lo;         // +0x04: low 32 bits of 64-bit signed value
  int32_t  value_hi;         // +0x08: high 32 bits of 64-bit signed value
};

// §2.1 HexFuncSig ABI flag bits & confidence constants
enum HexAbiFlags {
  HEX_ABI_FLAG_HAS_FRAME    = 1u << 0u,
  HEX_ABI_FLAG_HAS_THIS     = 1u << 1u,
  HEX_ABI_FLAG_HAS_X8_SRET  = 1u << 2u,
  HEX_ABI_FLAG_IS_VARIADIC  = 1u << 3u,
  HEX_ABI_FLAG_HAS_INDIRECT = 1u << 4u,
  HEX_ABI_FLAG_IS_RECURSIVE = 1u << 5u,
};

// §2.1 arg_class_packed 4-bit class codes (0..12)
enum HexArgClass {
  HEX_ARG_CLASS_UNKNOWN    = 0u,
  HEX_ARG_CLASS_INT        = 1u,
  HEX_ARG_CLASS_UINT       = 2u,
  HEX_ARG_CLASS_I32        = 3u,
  HEX_ARG_CLASS_U32        = 4u,
  HEX_ARG_CLASS_I64        = 5u,
  HEX_ARG_CLASS_U64        = 6u,
  HEX_ARG_CLASS_F32        = 7u,
  HEX_ARG_CLASS_F64        = 8u,
  HEX_ARG_CLASS_PTR        = 9u,
  HEX_ARG_CLASS_STRUCT_PTR = 10u,
  HEX_ARG_CLASS_VTABLE_PTR = 11u,
  HEX_ARG_CLASS_ENUM       = 12u,
};

// Confidence scale: 0..255 where 255 == USER_PINNED (1.0)
#define HEX_CONFIDENCE_USER_PINNED 255u

// Pin mask bits (for HexFuncSig per-slot pinning)
#define HEX_PIN_GP_ARG(i)  (1u << (i))         // bit0..7: x0..x7
#define HEX_PIN_RET        (1u << 8u)          // bit8: return value
#define HEX_PIN_THIS       (1u << 9u)          // bit9: this pointer
#define HEX_PIN_FP_ARG(i)  (1u << (10u + (i))) // bit10..17: v0..v7
#define HEX_PIN_CALL_CONV  (1u << 18u)         // bit18: calling convention

// Callsite ret_used_mask bits
enum HexRetUsedFlags {
  HEX_RET_USED_X0          = 1u << 0u,
  HEX_RET_USED_PASSTHROUGH = 1u << 1u,
  HEX_RET_USED_PTR_DEREF   = 1u << 2u,
  HEX_RET_USED_TAILCALL    = 1u << 3u,
};

// Callsite site_flags bits
enum HexCallsiteFlags {
  HEX_SITE_FLAG_INDIRECT      = 1u << 0u,
  HEX_SITE_FLAG_PAC_AUTH      = 1u << 1u,
  HEX_SITE_FLAG_VARIADIC      = 1u << 2u,
  HEX_SITE_FLAG_EXTERNAL_TIL  = 1u << 3u,
  HEX_SITE_FLAG_PINNED_TARGET = 1u << 4u,
};

// 16B POD — Exact §2.1 HexFuncSig layout (250k functions = 4.0 MB)
struct alignas(4) HexFuncSig {
  uint8_t  abi_flags;        // +0x00: bit0=has_frame, bit1=has_this, bit2=has_x8_sret, bit3=is_variadic,
                             //        bit4=has_indirect, bit5=is_recursive, bit6..7=call_conv
  uint8_t  gp_arg_mask;      // +0x01: x0..x7 used mask
  uint8_t  fp_arg_mask;      // +0x02: v0..v7 used mask
  uint8_t  ptr_arg_mask;     // +0x03: x0..x7 pointer-confirmed mask
  uint8_t  ret_info;         // +0x04: [3:0] ret_kind, [5:4] ret_reg_count, [6] is_const_ret, [7] is_this_ret
  uint8_t  confidence;       // +0x05: 0..255 (255 = USER_PINNED = 1.0)
  uint16_t ret_til_id;       // +0x06: TilTypeId
  uint16_t this_til_id;      // +0x08: TilTypeId for x0 (or x20 on swiftcall)
  uint16_t ext_sig_idx;      // +0x0A: 0xFFFF=none, else index into HexExtSig[]
  uint16_t arg_class_packed; // +0x0C: 4-bit x 4 summary for x0..x3
  uint16_t signed_arg_mask;  // +0x0E: [7:0]=signed x0..x7, [15:8]=unsigned x0..x7
};

// 16B POD — Exact §2.1 HexCallsiteFact layout
struct alignas(4) HexCallsiteFact {
  uint32_t callee_idx;       // +0x00: callee func_idx (0xFFFFFFFFu = indirect/unresolved)
  uint32_t reg_pass_map;     // +0x04: 4-bit nibble per callee arg 0..7 (0..7=caller x0..x7, 0xE=local/const, 0xF=unused)
  uint16_t vtable_slot;      // +0x08: 0xFFFF=direct call, else vtable slot index
  uint8_t  ret_used_mask;    // +0x0A: HexRetUsedFlags
  uint8_t  site_flags;       // +0x0B: HexCallsiteFlags
  uint32_t ext_target_off;   // +0x0C: external TIL/indirect table offset (0xFFFFFFFFu=none)
};

// 36B POD — Extended function signature (HexTypeId for gp[0..7] + return type)
struct alignas(4) HexExtSig {
  uint32_t gp_arg_types[8];  // +0x00..+0x1F: HexTypeId for x0..x7
  uint32_t ret_hex_type;     // +0x20: HexTypeId for return value
};

// ============================================================================
// §3.1 TIL1 Binary Format Structures
// ============================================================================
#define HEX_TIL1_MAGIC_0 'T'
#define HEX_TIL1_MAGIC_1 'I'
#define HEX_TIL1_MAGIC_2 'L'
#define HEX_TIL1_MAGIC_3 '1'
#define HEX_TIL1_VERSION 1u
#define HEX_TIL1_BUCKET_DIR_OFFSET 36u     // 0x24
#define HEX_TIL1_BUCKET_DIR_BYTES  516u    // 257 * 2 + 2 pad
#define HEX_TIL1_HASH_INDEX_OFFSET 552u    // 0x228
#define HEX_TIL1_MAX_ARITY         12u

enum HexTilHeaderFlags {
  HEX_TIL_FLAG_IS_CORE            = 1u << 0u,
  HEX_TIL_FLAG_LOCAL_TID_RELATIVE = 1u << 1u,
  HEX_TIL_FLAG_HAS_EXT_CHUNK      = 1u << 2u,
};

enum HexTilLookupFlags {
  HEX_TIL_LOOKUP_RAW_ONLY        = 1u << 0u,
  HEX_TIL_LOOKUP_ALLOW_STRIP1    = 1u << 1u,
  HEX_TIL_LOOKUP_ALLOW_STRIP_ALL = 1u << 2u,
  HEX_TIL_LOOKUP_DEFAULT         = (1u << 1u) | (1u << 2u),
};

// 36B POD — Exact §3.1 TIL1 Header
struct alignas(4) HexTilHeader {
  uint8_t  magic[4];         // +0x00: "TIL1"
  uint16_t version;          // +0x04: 1
  uint16_t flags;            // +0x06: HexTilHeaderFlags | abi_mask
  uint32_t entry_count;      // +0x08: number of symbol hash index entries
  uint32_t sel_count;        // +0x0C: number of ObjC selector index entries
  uint32_t type_count;       // +0x10: number of TypeDesc entries
  uint32_t sig_pool_off;     // +0x14: 4B-aligned byte offset to SigBlob pool
  uint32_t str_pool_off;     // +0x18: byte offset to UTF-8 NUL-terminated string pool
  uint32_t ext_chunk_off;    // +0x1C: 4B-aligned byte offset to ExtChunk (0 if absent)
  uint32_t checksum_fnv32;   // +0x20: FNV-1a 32-bit checksum (with +0x20..+0x23 zeroed)
};

// 12B POD — Exact §3.1 Hash Index / Selector Index entry
struct alignas(4) HexTilSymbolEntry {
  uint32_t hash_lo;          // +0x00: low 32 bits of FNV-1a 64-bit hash
  uint32_t hash_hi;          // +0x04: high 32 bits of FNV-1a 64-bit hash
  uint32_t sig_off;          // +0x08: byte offset into TIL1 blob's SigPool
};

// 12B POD — Exact §3.1 TypeDesc entry (parity with til-binary-compiler.js)
struct alignas(4) HexTilTypeDesc {
  uint16_t kind;             // +0x00: HexTypeKind
  uint8_t  bits;             // +0x02: bit width (8, 16, 32, 64, etc.)
  uint8_t  qualifiers;       // +0x03: bit0:const, bit1:signed, bit2:enum, bit3:bitmask
  uint16_t pointee_tid;      // +0x04: TilTypeId
  uint16_t local_tid;        // +0x06: 0 = implicit (tid_base + i), non-zero = explicit TID
  uint32_t name_off;         // +0x08: offset into StringPool
};

// 64B POD — Exact §3.1 HexTilSigRecord64 lookup output
struct alignas(4) HexTilSigRecord64 {
  uint32_t ret_hex_type;       // +0x00: HexTypeId
  uint8_t  flags;              // +0x04: bit0:var, bit1:noret, bit2..4:fmt_fam, bit5:alloc, bit6:free, bit7:objc_cls
  uint8_t  arity;              // +0x05: 0..12
  uint8_t  fmt_arg_idx;        // +0x06: 0xFF=none
  uint8_t  format_family;      // +0x07: 0..4
  uint16_t sig_index;          // +0x08: index within matched slot
  uint8_t  matched_slot_id;    // +0x0A: 0..3
  uint8_t  call_conv;          // +0x0B: 0:AAPCS64, 1:swiftcall, 2:swifttailcc
  uint32_t name_off;           // +0x0C: offset into matched slot's StringPool
  uint32_t param_hex_types[12];// +0x10..+0x3F: parameter HexTypeIds (unused = 0)
};

// 32B POD — TIL engine aggregate statistics
struct alignas(4) HexTilStats {
  uint32_t mounted_slot_mask;  // +0x00: bit0..3
  uint32_t total_entries;      // +0x04
  uint32_t total_selectors;    // +0x08
  uint32_t total_types;        // +0x0C
  uint32_t total_bytes;        // +0x10
  uint32_t lookup_hits;        // +0x14
  uint32_t lookup_misses;      // +0x18
  uint32_t reserved;           // +0x1C
};

// ============================================================================
// §8.1 g_type_arena Slot Definitions & Slot Info POD
// ============================================================================
enum HexTypeArenaSlotId {
  HEX_ARENA_SLOT_CORE_TIL    = 0u,  // 0 .. 160 KiB
  HEX_ARENA_SLOT_PACK_A      = 1u,  // 160 .. 416 KiB
  HEX_ARENA_SLOT_PACK_B      = 2u,  // 416 .. 672 KiB
  HEX_ARENA_SLOT_USER_HEADER = 3u,  // 672 .. 800 KiB
  HEX_ARENA_SLOT_HSIG1       = 4u,  // 800 .. 1024 KiB
  HEX_ARENA_SLOT_MANUAL_5A   = 5u,  // Mobile 512 KiB / Desktop 3 MiB
  HEX_ARENA_SLOT_ASM_WEB_5B  = 6u,  // Mobile 512 KiB / Desktop 4 MiB
  HEX_ARENA_SLOT_VOLATILE_A  = 7u,  // Mobile 4 MiB / Desktop 24 MiB
  HEX_ARENA_SLOT_VOLATILE_B  = 8u,  // Mobile 2 MiB / Desktop 16 MiB
  HEX_ARENA_SLOT_COUNT       = 9u,
};

enum HexArenaSlotFlags {
  HEX_ARENA_FLAG_FIXED     = 1u << 0u,
  HEX_ARENA_FLAG_VOLATILE  = 1u << 1u,
  HEX_ARENA_FLAG_COMMITTED = 1u << 2u,
  HEX_ARENA_FLAG_MOUNTED   = 1u << 3u,
};

// 24B POD — Type Arena Slot Status Descriptor
struct alignas(4) HexTypeArenaSlotInfo {
  uint32_t slot_id;       // +0x00: HexTypeArenaSlotId
  uint32_t base_offset;   // +0x04: byte offset from g_type_arena base
  uint32_t capacity;      // +0x08: slot capacity in bytes
  uint32_t used;          // +0x0C: bytes currently allocated in this slot
  uint32_t flags;         // +0x10: HexArenaSlotFlags
  uint32_t generation;    // +0x14: incremented on reset / re-mount
};

#ifdef __cplusplus
static_assert(sizeof(HexTypeRecord) == 24 && alignof(HexTypeRecord) == 4,
              "HexTypeRecord must be 24B, align 4");
static_assert(sizeof(HexStructField) == 20 && alignof(HexStructField) == 4,
              "HexStructField must be 20B, align 4");
static_assert(sizeof(HexEnumMember) == 12 && alignof(HexEnumMember) == 4,
              "HexEnumMember must be 12B, align 4");
static_assert(sizeof(HexFuncSig) == 16 && alignof(HexFuncSig) == 4,
              "HexFuncSig must be 16B, align 4");
static_assert(sizeof(HexCallsiteFact) == 16 && alignof(HexCallsiteFact) == 4,
              "HexCallsiteFact must be 16B, align 4");
static_assert(sizeof(HexExtSig) == 36 && alignof(HexExtSig) == 4,
              "HexExtSig must be 36B, align 4");
static_assert(sizeof(HexTilHeader) == 36 && alignof(HexTilHeader) == 4,
              "HexTilHeader must be 36B, align 4");
static_assert(sizeof(HexTilSymbolEntry) == 12 && alignof(HexTilSymbolEntry) == 4,
              "HexTilSymbolEntry must be 12B, align 4");
static_assert(sizeof(HexTilTypeDesc) == 12 && alignof(HexTilTypeDesc) == 4,
              "HexTilTypeDesc must be 12B, align 4");
static_assert(sizeof(HexTilSigRecord64) == 64 && alignof(HexTilSigRecord64) == 4,
              "HexTilSigRecord64 must be 64B, align 4");
static_assert(sizeof(HexTilStats) == 32 && alignof(HexTilStats) == 4,
              "HexTilStats must be 32B, align 4");
static_assert(sizeof(HexTypeArenaSlotInfo) == 24 && alignof(HexTypeArenaSlotInfo) == 4,
              "HexTypeArenaSlotInfo must be 24B, align 4");
#endif

// ============================================================================
// WASM Export Declarations — Type Arena (type_arena.cpp)
// ============================================================================
HEX_WASM_EXPORT("hex_type_arena_init")
HexStatus hex_type_arena_init(void);

HEX_WASM_EXPORT("hex_type_arena_slot_ptr")
uint8_t* hex_type_arena_slot_ptr(uint32_t slot_id);

HEX_WASM_EXPORT("hex_type_arena_slot_cap")
uint32_t hex_type_arena_slot_cap(uint32_t slot_id);

HEX_WASM_EXPORT("hex_type_arena_slot_used")
uint32_t hex_type_arena_slot_used(uint32_t slot_id);

HEX_WASM_EXPORT("hex_type_arena_slot_info")
HexStatus hex_type_arena_slot_info(uint32_t slot_id, struct HexTypeArenaSlotInfo* out_info);

HEX_WASM_EXPORT("hex_type_arena_alloc_slot")
uint8_t* hex_type_arena_alloc_slot(uint32_t slot_id, uint32_t bytes);

HEX_WASM_EXPORT("hex_type_arena_bump_alloc")
uint8_t* hex_type_arena_bump_alloc(uint32_t slot_id, uint32_t bytes, uint32_t align);

HEX_WASM_EXPORT("hex_type_arena_reset_slot")
HexStatus hex_type_arena_reset_slot(uint32_t slot_id);

HEX_WASM_EXPORT("hex_type_arena_reset_volatile")
void hex_type_arena_reset_volatile(void);

HEX_WASM_EXPORT("hex_type_arena_reset_all")
void hex_type_arena_reset_all(void);

// ============================================================================
// WASM Export Declarations — Signature Propagation (sig_prop_wasm.cpp)
// ============================================================================
HEX_WASM_EXPORT("hex_analyze_callgraph_scc_order")
HexStatus hex_analyze_callgraph_scc_order(
    uint32_t num_nodes,
    const uint32_t* edge_src,
    const uint32_t* edge_dst,
    uint32_t num_edges,
    uint8_t* scratch_ptr,
    uint32_t scratch_bytes,
    uint32_t* out_scc_id,
    uint32_t* out_topo_nodes,
    uint32_t* out_num_sccs);

HEX_WASM_EXPORT("hex_propagate_sig_window")
HexStatus hex_propagate_sig_window(
    uint32_t window_callers,
    const uint32_t* local_row_ptr,
    const struct HexCallsiteFact* local_facts,
    uint32_t local_edges,
    struct HexFuncSig* sig_pool,
    uint32_t sig_pool_count,
    const uint32_t* pin_mask,
    uint32_t* ext_sig_pool,
    uint32_t ext_sig_count,
    uint32_t max_scc_iters);

HEX_WASM_EXPORT("hex_sig_prop_run")
HexStatus hex_sig_prop_run(
    uint32_t num_nodes,
    const uint32_t* row_ptr,
    const struct HexCallsiteFact* facts,
    uint32_t num_edges,
    struct HexFuncSig* sigs,
    const uint32_t* pin_mask,
    uint32_t* ext_sig_pool,
    uint32_t ext_sig_count,
    uint32_t max_iters,
    uint32_t* out_scc_id,
    uint32_t* out_topo_nodes,
    uint32_t* out_num_sccs);

// ============================================================================
// WASM Export Declarations — TIL1 Engine (til_engine.cpp)
// ============================================================================
HEX_WASM_EXPORT("hex_til_mount")
HexStatus hex_til_mount(
    uint32_t slot_id,
    const uint8_t* blob,
    uint32_t len,
    uint16_t tid_base,
    uint16_t tid_cap);

HEX_WASM_EXPORT("hex_til_load")
HexStatus hex_til_load(const uint8_t* blob, uint32_t len);

HEX_WASM_EXPORT("hex_til_mount_pack")
HexStatus hex_til_mount_pack(
    uint32_t slot_id,
    uint16_t tid_base,
    uint16_t tid_cap,
    const uint8_t* blob,
    uint32_t len);

HEX_WASM_EXPORT("hex_til_unmount_pack")
HexStatus hex_til_unmount_pack(uint32_t slot_id);

HEX_WASM_EXPORT("hex_til_purge_packs")
void hex_til_purge_packs(void);

HEX_WASM_EXPORT("hex_til_lookup_symbol")
HexStatus hex_til_lookup_symbol(
    const uint8_t* sym,
    uint32_t len,
    uint32_t slot_mask,
    uint32_t lookup_flags,
    struct HexTilSigRecord64* out_rec64);

HEX_WASM_EXPORT("hex_til_lookup")
HexStatus hex_til_lookup(
    const uint8_t* sym,
    uint32_t len,
    uint32_t slot_mask,
    uint32_t lookup_flags,
    uint8_t* out_rec64);

HEX_WASM_EXPORT("hex_til_lookup_selector")
HexStatus hex_til_lookup_selector(
    const uint8_t* key,
    uint32_t len,
    uint32_t slot_mask,
    uint8_t* out_rec64);

HEX_WASM_EXPORT("hex_til_lookup_type")
HexStatus hex_til_lookup_type(uint16_t tid, struct HexTypeRecord* out_rec24);

HEX_WASM_EXPORT("hex_til_get_type")
HexStatus hex_til_get_type(uint16_t tid, uint8_t* out_desc12, uint8_t* out_slot_id);

HEX_WASM_EXPORT("hex_til_get_type_name")
HexStatus hex_til_get_type_name(
    uint16_t tid,
    uint8_t* out_utf8,
    uint32_t cap,
    uint32_t* out_len);

HEX_WASM_EXPORT("hex_til_stats")
HexStatus hex_til_stats(struct HexTilStats* out_stats);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // HEX_TYPE_SYSTEM_HPP
