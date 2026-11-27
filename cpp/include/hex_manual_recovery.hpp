#ifndef HEX_MANUAL_RECOVERY_HPP
#define HEX_MANUAL_RECOVERY_HPP

#include <stddef.h>
#include <stdint.h>

#include "hex_abi.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// ============================================================================
// §15.1 Manual Segment Map & 1-Byte Code/Data Boundary Overrides
// ============================================================================

typedef enum HexManualSegKind : uint8_t {
  HEX_MSEG_UNDEF    = 0,  // U: undefined raw bytes
  HEX_MSEG_CODE     = 1,  // C: forced code (ARM64 4B aligned; fail-closed if unaligned)
  HEX_MSEG_DATA_U8  = 2,  // D(1): .byte
  HEX_MSEG_DATA_U16 = 3,  // D(2): .hword
  HEX_MSEG_DATA_U32 = 4,  // D(4): .word
  HEX_MSEG_DATA_U64 = 5,  // D(8): .quad
  HEX_MSEG_STR      = 6,  // A: string (str_encoding: 0=UTF8/ASCII, 1=UTF16LE, 2=Fixed, 3=Pascal)
  HEX_MSEG_ALIGN    = 7,  // alignment padding (.balign 2^align_pow2)
} HexManualSegKind;

enum HexManualSegPerm : uint32_t {
  HEX_MSEG_PERM_R = 1u << 0,
  HEX_MSEG_PERM_W = 1u << 1,
  HEX_MSEG_PERM_X = 1u << 2,
};

enum HexManualSegFlag : uint32_t {
  HEX_MSEG_FLAG_FUNC_START          = 1u << 0,
  HEX_MSEG_FLAG_FUNC_END            = 1u << 1,
  HEX_MSEG_FLAG_OFFSET_REF          = 1u << 2,
  HEX_MSEG_FLAG_OFFSET_REL          = 1u << 3,
  HEX_MSEG_FLAG_BIG_ENDIAN          = 1u << 4,
  HEX_MSEG_FLAG_LOCK_AUTO_DISCOVERY = 1u << 5,
  HEX_MSEG_FLAG_BSS_ZERO            = 1u << 6,
};

static constexpr uint64_t HEX_MANUAL_SEG_NO_FILE = UINT64_MAX;
static constexpr uint32_t HEX_MANUAL_NAME_NONE   = 0xFFFFFFFFu;
static constexpr uint32_t HEX_MANUAL_SEG_MAX_CAP = 2048u;

// Manual segment descriptor (Slot 5A backed, sorted non-overlapping by base_va).
struct alignas(8) HexManualSegment {
  uint64_t base_va;      // +0x00: segment start virtual address
  uint64_t size;         // +0x08: segment byte length (> 0)
  uint64_t file_offset;  // +0x10: backing file offset (or HEX_MANUAL_SEG_NO_FILE)
  uint32_t perms;        // +0x18: HexManualSegPerm bitmask (R/W/X)
  uint32_t flags;        // +0x1C: HexManualSegFlag bitmask
  uint32_t name_off;     // +0x20: string table offset (HEX_MANUAL_NAME_NONE if unnamed)
  uint8_t  seg_kind;     // +0x24: HexManualSegKind (0..7)
  uint8_t  elem_size;    // +0x25: element width (0, 1, 2, 4, 8)
  uint8_t  align_pow2;   // +0x26: alignment power of 2 (0..12)
  uint8_t  reserved;     // +0x27: explicit padding (must be 0)
};

// §15.1 compact 1-byte code/data boundary override entry (24B, zero implicit padding).
struct alignas(8) HexManualSegEntry {
  uint64_t start_va;        // +0x00: range start VA (half-open, non-overlapping)
  uint32_t byte_len;        // +0x08: range byte length (>= 1)
  uint8_t  kind;            // +0x0C: HexManualSegKind (0..7)
  uint8_t  elem_size;       // +0x0D: element width (1, 2, 4, 8)
  uint8_t  str_encoding;    // +0x0E: STR only (0..3)
  uint8_t  align_pow2;      // +0x0F: ALIGN only (1..12)
  uint32_t flags;           // +0x10: HexManualSegFlag
  int32_t  offset_base_rel; // +0x14: O-key base offset delta
};

// §15.1 segmented decode row (16B, zero implicit padding).
struct alignas(8) HexSegDecodeRow {
  uint64_t va;          // +0x00: row start VA
  uint16_t byte_len;    // +0x08: consumed bytes (CODE=4, DATA/STR/ALIGN/UNDEF>=1)
  uint8_t  seg_kind;    // +0x0A: HexManualSegKind (0..7)
  uint8_t  row_flags;   // +0x0B: bit0=is_decoded_insn, bit1=is_offset_ref, bit2=unaligned_gap
  uint32_t decoded_idx; // +0x0C: index into out_insns (0xFFFFFFFFu = non-instruction)
};

// ============================================================================
// §15.2 Discontiguous Function Chunks & Chunked CFG
// ============================================================================

typedef enum HexFuncChunkKind : uint32_t {
  HEX_CHUNK_PRIMARY    = 0,  // primary entry chunk
  HEX_CHUNK_COLD_BLOCK = 1,  // cold block (hot/cold split)
  HEX_CHUNK_TAIL_CALL  = 2,  // shared/outlined tail-call chunk
  HEX_CHUNK_OUTLINE    = 3,  // outlined helper chunk
  HEX_CHUNK_LSDA_LP    = 4,  // unwind / LSDA landing pad chunk
} HexFuncChunkKind;

enum HexFuncChunkFlag : uint32_t {
  HEX_CHUNK_FLAG_MANUAL        = 1u << 0,
  HEX_CHUNK_FLAG_UNWIND_COLD   = 1u << 1,
  HEX_CHUNK_FLAG_OUTLINED_TAIL = 1u << 2,
  HEX_CHUNK_FLAG_LSDA_LP       = 1u << 3,
  HEX_CHUNK_FLAG_DETACHED      = 1u << 4,
};

static constexpr uint32_t HEX_FUNC_CHUNK_MAX_CAP = 2048u;

// Discontiguous function chunk descriptor (32B, zero implicit padding).
struct alignas(8) HexFuncChunk {
  uint64_t owner_fn_va; // +0x00: owning function entry VA
  uint64_t start_va;    // +0x08: chunk start VA (half-open [start_va, end_va), 4B aligned)
  uint64_t end_va;      // +0x10: chunk end VA (end_va > start_va, 4B aligned)
  uint32_t chunk_kind;  // +0x18: HexFuncChunkKind (0..4)
  uint32_t flags;       // +0x1C: HexFuncChunkFlag bitmask
};

// §15.2 CFG chunk range input/output descriptor (24B, zero implicit padding).
struct alignas(8) HexFuncChunkRange {
  uint64_t start_va;    // +0x00: range start VA
  uint64_t end_va;      // +0x08: end_va > start_va
  uint32_t raw_offset;  // +0x10: offset in concatenated input buffer
  uint16_t chunk_ord;   // +0x14: 0=Primary Entry, 1..N-1=Cold/Tail
  uint16_t chunk_flags; // +0x16: HexFuncChunkFlag low 16 bits
};

// §15.2 chunked basic-block metadata (16B, zero implicit padding).
struct alignas(8) HexChunkBbMeta16 {
  uint64_t bb_start_va; // +0x00: BB start VA
  uint32_t insn_count;  // +0x08: instruction count in BB
  uint16_t chunk_ord;   // +0x0C: owning chunk ordinal (0=Primary)
  uint16_t bb_flags;    // +0x0E: bit0=is_entry, bit1=is_chunk_boundary, bit2=is_tail_exit, bit3=is_lsda_lp
};

// ============================================================================
// §15.3 Custom Calling Convention (__usercall / __userpurge)
// ============================================================================

typedef enum HexAbiLocKind : uint8_t {
  HEX_ABILOC_NONE     = 0,
  HEX_ABILOC_GPR      = 1,
  HEX_ABILOC_FPR_SIMD = 2,
  HEX_ABILOC_GPR_PAIR = 3,
  HEX_ABILOC_FPR_PAIR = 4,
  HEX_ABILOC_STACK    = 5,
} HexAbiLocKind;

enum HexCustomAbiFlag : uint32_t {
  HEX_ABI_FLAG_USERPURGE      = 1u << 0,
  HEX_ABI_FLAG_VARIADIC       = 1u << 1,
  HEX_ABI_FLAG_CUSTOM_CLOBBER = 1u << 2,
  HEX_ABI_FLAG_PRESERVE_ALL   = 1u << 3,
};

enum HexAbiLocFlag : uint16_t {
  HEX_ABILOC_FLAG_HIDDEN_THIS = 1u << 0,
  HEX_ABILOC_FLAG_SRET        = 1u << 1,
  HEX_ABILOC_FLAG_SIGN_EXT    = 1u << 2,
  HEX_ABILOC_FLAG_ALLOW_FP_LR = 1u << 3,
};

static constexpr uint32_t HEX_CUSTOM_ABI_MAX_ARGS = 12u;
static constexpr uint32_t HEX_CUSTOM_ABI_MAX_CAP  = 512u;

// §15.3 single ABI location (8B, zero implicit padding).
struct alignas(4) HexAbiLoc {
  uint8_t  loc_kind;   // +0x00: HexAbiLocKind (0..5)
  uint8_t  reg_id;     // +0x01: 0..31 (0xFF for STACK/NONE; 31/SP forbidden; 29/30 require ALLOW_FP_LR)
  uint8_t  reg_id_hi;  // +0x02: PAIR upper reg (0xFF when non-PAIR)
  uint8_t  byte_width; // +0x03: 1, 2, 4, 8, 16
  int16_t  sp_offset;  // +0x04: STACK only (0..4096)
  uint16_t loc_flags;  // +0x06: HexAbiLocFlag
};

// §15.3 per-function custom calling convention spec (192B, zero implicit padding).
struct alignas(8) HexCustomAbiSpec {
  uint64_t  func_va;            // +0x00: target function VA
  uint32_t  abi_flags;          // +0x08: HexCustomAbiFlag
  uint16_t  sp_purge_bytes;     // +0x0C: stack cleanup bytes (16B aligned)
  uint8_t   arg_count;          // +0x0E: 0..12
  uint8_t   ret_count;          // +0x0F: NONE->0, GPR/FPR/STACK->1, PAIR->2
  HexAbiLoc ret_loc;            // +0x10: return value location (8B)
  uint32_t  ret_hex_type;       // +0x18: return HexTypeId
  uint32_t  clobber_gp_mask;    // +0x1C: clobbered GP register mask
  uint32_t  clobber_fp_mask;    // +0x20: clobbered FP/SIMD register mask
  uint32_t  reserved2;          // +0x24: explicit padding (must be 0)
  HexAbiLoc arg_locs[12];       // +0x28: argument locations (96B)
  uint32_t  arg_hex_types[12];  // +0x88: argument HexTypeIds (48B)
  uint64_t  reserved_tail;      // +0xB8: explicit tail alignment (8B -> 192B)
};

// ============================================================================
// §15.4 Stack Slot Overrides & __shifted(T, delta) Pointers
// ============================================================================

enum HexStackSlotFlag : uint32_t {
  HEX_STACK_FLAG_FORCE_SPLIT    = 1u << 0,
  HEX_STACK_FLAG_FORCE_MERGE    = 1u << 1,
  HEX_STACK_FLAG_NO_REG_PROMOTE = 1u << 2,
  HEX_STACK_FLAG_FP_REL         = 1u << 3,
};

enum HexShiftedPtrFlag : uint16_t {
  HEX_SHIFTED_FLAG_PREFER_CONTAINER_OF = 1u << 0,
  HEX_SHIFTED_FLAG_ALLOW_NEG_OFFSET    = 1u << 1,
  HEX_SHIFTED_FLAG_FROM_CXX_THUNK      = 1u << 2,
};

static constexpr uint32_t HEX_STACK_OVERRIDE_MAX_CAP = 2048u;
static constexpr uint32_t HEX_SHIFTED_PTR_MAX_CAP    = 2048u;

// §15.4 stack slot override (24B, zero implicit padding).
struct alignas(8) HexStackSlotOverride {
  int32_t  sp_offset;   // +0x00: SP-relative (or FP/x29-relative if FP_REL set)
  uint32_t byte_size;   // +0x04: slot size in bytes (>= 1)
  uint32_t hex_type_id; // +0x08: forced HexTypeId
  uint32_t array_len;   // +0x0C: array length (0 = non-array)
  uint32_t slot_flags;  // +0x10: HexStackSlotFlag
  uint32_t name_off;    // +0x14: string table offset (HEX_MANUAL_NAME_NONE = auto)
};

// §15.4 shifted pointer spec (__shifted(T, delta) / container_of, 24B, zero implicit padding).
struct alignas(8) HexShiftedPtrSpec {
  uint32_t var_key_hash;    // +0x00: FNV-1a32("arg:0" / "loc:sp+0x20" etc.)
  uint16_t parent_tid;      // +0x04: parent struct TilTypeId
  uint16_t spec_flags;      // +0x06: HexShiftedPtrFlag
  int32_t  shift_offset;    // +0x08: byte shift from parent struct base
  int32_t  member_off;      // +0x0C: corresponding member offset
  uint32_t member_name_off; // +0x10: string table offset (HEX_MANUAL_NAME_NONE = numeric)
  uint32_t reserved;        // +0x14: explicit padding (must be 0)
};

// ============================================================================
// Exact ABI Layout Static Assertions (Size, Alignment, Zero Implicit Padding)
// ============================================================================

#ifdef __cplusplus
static_assert(sizeof(HexManualSegment) == 40, "HexManualSegment must be 40B");
static_assert(alignof(HexManualSegment) == 8, "HexManualSegment must be 8B aligned");
static_assert(offsetof(HexManualSegment, base_va) == 0x00);
static_assert(offsetof(HexManualSegment, size) == 0x08);
static_assert(offsetof(HexManualSegment, file_offset) == 0x10);
static_assert(offsetof(HexManualSegment, perms) == 0x18);
static_assert(offsetof(HexManualSegment, flags) == 0x1C);
static_assert(offsetof(HexManualSegment, name_off) == 0x20);
static_assert(offsetof(HexManualSegment, seg_kind) == 0x24);
static_assert(offsetof(HexManualSegment, elem_size) == 0x25);
static_assert(offsetof(HexManualSegment, align_pow2) == 0x26);
static_assert(offsetof(HexManualSegment, reserved) == 0x27);

static_assert(sizeof(HexManualSegEntry) == 24, "HexManualSegEntry must be 24B");
static_assert(alignof(HexManualSegEntry) == 8, "HexManualSegEntry must be 8B aligned");
static_assert(offsetof(HexManualSegEntry, start_va) == 0x00);
static_assert(offsetof(HexManualSegEntry, byte_len) == 0x08);
static_assert(offsetof(HexManualSegEntry, kind) == 0x0C);
static_assert(offsetof(HexManualSegEntry, elem_size) == 0x0D);
static_assert(offsetof(HexManualSegEntry, str_encoding) == 0x0E);
static_assert(offsetof(HexManualSegEntry, align_pow2) == 0x0F);
static_assert(offsetof(HexManualSegEntry, flags) == 0x10);
static_assert(offsetof(HexManualSegEntry, offset_base_rel) == 0x14);

static_assert(sizeof(HexSegDecodeRow) == 16, "HexSegDecodeRow must be 16B");
static_assert(alignof(HexSegDecodeRow) == 8, "HexSegDecodeRow must be 8B aligned");
static_assert(offsetof(HexSegDecodeRow, va) == 0x00);
static_assert(offsetof(HexSegDecodeRow, byte_len) == 0x08);
static_assert(offsetof(HexSegDecodeRow, seg_kind) == 0x0A);
static_assert(offsetof(HexSegDecodeRow, row_flags) == 0x0B);
static_assert(offsetof(HexSegDecodeRow, decoded_idx) == 0x0C);

static_assert(sizeof(HexFuncChunk) == 32, "HexFuncChunk must be 32B");
static_assert(alignof(HexFuncChunk) == 8, "HexFuncChunk must be 8B aligned");
static_assert(offsetof(HexFuncChunk, owner_fn_va) == 0x00);
static_assert(offsetof(HexFuncChunk, start_va) == 0x08);
static_assert(offsetof(HexFuncChunk, end_va) == 0x10);
static_assert(offsetof(HexFuncChunk, chunk_kind) == 0x18);
static_assert(offsetof(HexFuncChunk, flags) == 0x1C);

static_assert(sizeof(HexFuncChunkRange) == 24, "HexFuncChunkRange must be 24B");
static_assert(alignof(HexFuncChunkRange) == 8, "HexFuncChunkRange must be 8B aligned");
static_assert(offsetof(HexFuncChunkRange, start_va) == 0x00);
static_assert(offsetof(HexFuncChunkRange, end_va) == 0x08);
static_assert(offsetof(HexFuncChunkRange, raw_offset) == 0x10);
static_assert(offsetof(HexFuncChunkRange, chunk_ord) == 0x14);
static_assert(offsetof(HexFuncChunkRange, chunk_flags) == 0x16);

static_assert(sizeof(HexChunkBbMeta16) == 16, "HexChunkBbMeta16 must be 16B");
static_assert(alignof(HexChunkBbMeta16) == 8, "HexChunkBbMeta16 must be 8B aligned");
static_assert(offsetof(HexChunkBbMeta16, bb_start_va) == 0x00);
static_assert(offsetof(HexChunkBbMeta16, insn_count) == 0x08);
static_assert(offsetof(HexChunkBbMeta16, chunk_ord) == 0x0C);
static_assert(offsetof(HexChunkBbMeta16, bb_flags) == 0x0E);

static_assert(sizeof(HexAbiLoc) == 8, "HexAbiLoc must be 8B");
static_assert(alignof(HexAbiLoc) == 4, "HexAbiLoc must be 4B aligned");
static_assert(offsetof(HexAbiLoc, loc_kind) == 0x00);
static_assert(offsetof(HexAbiLoc, reg_id) == 0x01);
static_assert(offsetof(HexAbiLoc, reg_id_hi) == 0x02);
static_assert(offsetof(HexAbiLoc, byte_width) == 0x03);
static_assert(offsetof(HexAbiLoc, sp_offset) == 0x04);
static_assert(offsetof(HexAbiLoc, loc_flags) == 0x06);

static_assert(sizeof(HexCustomAbiSpec) == 192, "HexCustomAbiSpec must be 192B");
static_assert(alignof(HexCustomAbiSpec) == 8, "HexCustomAbiSpec must be 8B aligned");
static_assert(offsetof(HexCustomAbiSpec, func_va) == 0x00);
static_assert(offsetof(HexCustomAbiSpec, abi_flags) == 0x08);
static_assert(offsetof(HexCustomAbiSpec, sp_purge_bytes) == 0x0C);
static_assert(offsetof(HexCustomAbiSpec, arg_count) == 0x0E);
static_assert(offsetof(HexCustomAbiSpec, ret_count) == 0x0F);
static_assert(offsetof(HexCustomAbiSpec, ret_loc) == 0x10);
static_assert(offsetof(HexCustomAbiSpec, ret_hex_type) == 0x18);
static_assert(offsetof(HexCustomAbiSpec, clobber_gp_mask) == 0x1C);
static_assert(offsetof(HexCustomAbiSpec, clobber_fp_mask) == 0x20);
static_assert(offsetof(HexCustomAbiSpec, reserved2) == 0x24);
static_assert(offsetof(HexCustomAbiSpec, arg_locs) == 0x28);
static_assert(offsetof(HexCustomAbiSpec, arg_hex_types) == 0x88);
static_assert(offsetof(HexCustomAbiSpec, reserved_tail) == 0xB8);

static_assert(sizeof(HexStackSlotOverride) == 24, "HexStackSlotOverride must be 24B");
static_assert(alignof(HexStackSlotOverride) == 8, "HexStackSlotOverride must be 8B aligned");
static_assert(offsetof(HexStackSlotOverride, sp_offset) == 0x00);
static_assert(offsetof(HexStackSlotOverride, byte_size) == 0x04);
static_assert(offsetof(HexStackSlotOverride, hex_type_id) == 0x08);
static_assert(offsetof(HexStackSlotOverride, array_len) == 0x0C);
static_assert(offsetof(HexStackSlotOverride, slot_flags) == 0x10);
static_assert(offsetof(HexStackSlotOverride, name_off) == 0x14);

static_assert(sizeof(HexShiftedPtrSpec) == 24, "HexShiftedPtrSpec must be 24B");
static_assert(alignof(HexShiftedPtrSpec) == 8, "HexShiftedPtrSpec must be 8B aligned");
static_assert(offsetof(HexShiftedPtrSpec, var_key_hash) == 0x00);
static_assert(offsetof(HexShiftedPtrSpec, parent_tid) == 0x04);
static_assert(offsetof(HexShiftedPtrSpec, spec_flags) == 0x06);
static_assert(offsetof(HexShiftedPtrSpec, shift_offset) == 0x08);
static_assert(offsetof(HexShiftedPtrSpec, member_off) == 0x0C);
static_assert(offsetof(HexShiftedPtrSpec, member_name_off) == 0x10);
static_assert(offsetof(HexShiftedPtrSpec, reserved) == 0x14);
#endif

// ============================================================================
// WASM Exported C ABI Declarations
// ============================================================================

// Scratch buffer for host <-> WASM marshaling (standalone zero-import support).
HEX_WASM_EXPORT("hex_recovery_scratch_ptr")
uint32_t hex_recovery_scratch_ptr(void);

HEX_WASM_EXPORT("hex_recovery_scratch_size")
uint32_t hex_recovery_scratch_size(void);

// Reset all §15 manual recovery registries across all Slot 5A tables.
HEX_WASM_EXPORT("hex_manual_recovery_reset_all")
void hex_manual_recovery_reset_all(void);

// --- Manual Segment Map (manual_segment_map.cpp) ---
HEX_WASM_EXPORT("hex_manual_seg_reset")
void hex_manual_seg_reset(void);

HEX_WASM_EXPORT("hex_manual_seg_add")
HexStatus hex_manual_seg_add(const HexManualSegment* seg);

HEX_WASM_EXPORT("hex_manual_seg_add_entry")
int32_t hex_manual_seg_add_entry(const HexManualSegEntry* entry);

HEX_WASM_EXPORT("hex_manual_seg_load_entries")
int32_t hex_manual_seg_load_entries(const HexManualSegEntry* entries, uint32_t count);

HEX_WASM_EXPORT("hex_manual_seg_remove")
HexStatus hex_manual_seg_remove(uint64_t base_va);

HEX_WASM_EXPORT("hex_manual_seg_lookup")
HexStatus hex_manual_seg_lookup(uint64_t va, HexManualSegment* out_seg, uint64_t* out_file_offset);

HEX_WASM_EXPORT("hex_manual_seg_get_at")
HexStatus hex_manual_seg_get_at(uint32_t index, HexManualSegment* out_seg);

HEX_WASM_EXPORT("hex_manual_seg_count")
uint32_t hex_manual_seg_count(void);

HEX_WASM_EXPORT("hex_manual_seg_capacity")
uint32_t hex_manual_seg_capacity(void);

// --- Function Chunk Table & CFG Range Merge (func_chunk_cfg.cpp) ---
HEX_WASM_EXPORT("hex_func_chunk_reset")
void hex_func_chunk_reset(void);

HEX_WASM_EXPORT("hex_func_chunk_add")
HexStatus hex_func_chunk_add(const HexFuncChunk* chunk);

HEX_WASM_EXPORT("hex_func_chunk_remove")
HexStatus hex_func_chunk_remove(uint64_t start_va);

HEX_WASM_EXPORT("hex_func_chunk_find_owner")
HexStatus hex_func_chunk_find_owner(uint64_t va, uint64_t* out_owner_fn_va, HexFuncChunk* out_chunk);

HEX_WASM_EXPORT("hex_func_chunk_list_for_fn")
HexStatus hex_func_chunk_list_for_fn(
    uint64_t owner_fn_va,
    HexFuncChunk* out_chunks,
    uint32_t max_chunks,
    uint32_t* out_count);

HEX_WASM_EXPORT("hex_func_chunk_merge_cfg_ranges")
HexStatus hex_func_chunk_merge_cfg_ranges(
    uint64_t owner_fn_va,
    uint32_t max_chunks_cap,
    HexFuncChunkRange* out_ranges,
    uint32_t max_ranges,
    uint32_t* out_range_count);

HEX_WASM_EXPORT("hex_func_chunk_count")
uint32_t hex_func_chunk_count(void);

HEX_WASM_EXPORT("hex_func_chunk_capacity")
uint32_t hex_func_chunk_capacity(void);

// --- Custom ABI, Stack Slot Override & Shifted Pointer Registries (custom_abi_spec.cpp) ---
HEX_WASM_EXPORT("hex_custom_abi_reset")
void hex_custom_abi_reset(void);

HEX_WASM_EXPORT("hex_custom_abi_set")
HexStatus hex_custom_abi_set(const HexCustomAbiSpec* spec);

HEX_WASM_EXPORT("hex_custom_abi_get")
HexStatus hex_custom_abi_get(uint64_t fn_va, HexCustomAbiSpec* out_spec);

HEX_WASM_EXPORT("hex_custom_abi_count")
uint32_t hex_custom_abi_count(void);

HEX_WASM_EXPORT("hex_custom_abi_capacity")
uint32_t hex_custom_abi_capacity(void);

HEX_WASM_EXPORT("hex_stack_override_reset")
void hex_stack_override_reset(void);

HEX_WASM_EXPORT("hex_stack_override_set")
HexStatus hex_stack_override_set(uint64_t fn_va, const HexStackSlotOverride* spec);

HEX_WASM_EXPORT("hex_stack_override_get")
HexStatus hex_stack_override_get(uint64_t fn_va, int32_t sp_offset, HexStackSlotOverride* out_spec);

HEX_WASM_EXPORT("hex_stack_override_get_ex")
HexStatus hex_stack_override_get_ex(
    uint64_t fn_va,
    int32_t sp_offset,
    uint32_t fp_rel,
    HexStackSlotOverride* out_spec);

HEX_WASM_EXPORT("hex_stack_override_count")
uint32_t hex_stack_override_count(void);

HEX_WASM_EXPORT("hex_stack_override_capacity")
uint32_t hex_stack_override_capacity(void);

HEX_WASM_EXPORT("hex_shifted_ptr_reset")
void hex_shifted_ptr_reset(void);

HEX_WASM_EXPORT("hex_shifted_ptr_set")
HexStatus hex_shifted_ptr_set(uint64_t fn_va, const HexShiftedPtrSpec* spec);

HEX_WASM_EXPORT("hex_shifted_ptr_get")
HexStatus hex_shifted_ptr_get(uint64_t fn_va, uint32_t var_key_hash, HexShiftedPtrSpec* out_spec);

HEX_WASM_EXPORT("hex_shifted_ptr_count")
uint32_t hex_shifted_ptr_count(void);

HEX_WASM_EXPORT("hex_shifted_ptr_capacity")
uint32_t hex_shifted_ptr_capacity(void);

#ifdef __cplusplus
}
#endif

#endif  // HEX_MANUAL_RECOVERY_HPP
