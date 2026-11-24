#ifndef HEX_ARM64_DECODE_HPP
#define HEX_ARM64_DECODE_HPP

#include "../../include/hex_core/hex_core.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum HexArm64Cap {
  HEX_ARM64_CAP_FALLBACK = 0,
  HEX_ARM64_CAP_DECOMP = 1,
} HexArm64Cap;

typedef enum HexArm64Kind {
  HEX_ARM64_KIND_OTHER = 0,
  HEX_ARM64_KIND_NOP = 1,
  HEX_ARM64_KIND_ADRP = 2,
  HEX_ARM64_KIND_MOVIMM = 3,
  HEX_ARM64_KIND_MOVREG = 4,
  HEX_ARM64_KIND_ARITH = 5,
  HEX_ARM64_KIND_MUL = 6,
  HEX_ARM64_KIND_DIV = 7,
  HEX_ARM64_KIND_LOGIC = 8,
  HEX_ARM64_KIND_SHIFT = 9,
  HEX_ARM64_KIND_FARITH = 10,
  HEX_ARM64_KIND_FMUL = 11,
  HEX_ARM64_KIND_FCONV = 12,
  HEX_ARM64_KIND_SIMD = 13,
  HEX_ARM64_KIND_LOAD = 14,
  HEX_ARM64_KIND_STORE = 15,
  HEX_ARM64_KIND_CMP = 16,
  HEX_ARM64_KIND_CONDBR = 17,
  HEX_ARM64_KIND_BRANCH = 18,
  HEX_ARM64_KIND_CALL = 19,
  HEX_ARM64_KIND_INDCALL = 20,
  HEX_ARM64_KIND_RET = 21,
  HEX_ARM64_KIND_CSEL = 22,
  HEX_ARM64_KIND_ATOMIC = 23,
  HEX_ARM64_KIND_SYS = 24,
  HEX_ARM64_KIND_TRAP = 25,
  HEX_ARM64_KIND_LITERAL = 26,
} HexArm64Kind;

typedef enum HexArm64MemMode {
  HEX_ARM64_MEM_MODE_NONE = 0,
  HEX_ARM64_MEM_MODE_OFFSET = 1,
  HEX_ARM64_MEM_MODE_POST = 2,
  HEX_ARM64_MEM_MODE_PRE = 3,
} HexArm64MemMode;

typedef enum HexArm64Ordering {
  HEX_ARM64_ORDER_RELAXED = 0,
  HEX_ARM64_ORDER_ACQUIRE = 1,
  HEX_ARM64_ORDER_RELEASE = 2,
  HEX_ARM64_ORDER_ACQ_REL = 3,
} HexArm64Ordering;

typedef enum HexArm64AtomicOp {
  HEX_ARM64_ATOMIC_NONE = 0,
  HEX_ARM64_ATOMIC_CAS = 1,
  HEX_ARM64_ATOMIC_CASP = 2,
  HEX_ARM64_ATOMIC_EXCL_LOAD = 3,
  HEX_ARM64_ATOMIC_EXCL_STORE = 4,
  HEX_ARM64_ATOMIC_EXCL_LOAD_PAIR = 5,
  HEX_ARM64_ATOMIC_EXCL_STORE_PAIR = 6,
  HEX_ARM64_ATOMIC_ACQ_LOAD = 7,
  HEX_ARM64_ATOMIC_REL_STORE = 8,
  HEX_ARM64_ATOMIC_LDADD = 9,
  HEX_ARM64_ATOMIC_LDCLR = 10,
  HEX_ARM64_ATOMIC_LDEOR = 11,
  HEX_ARM64_ATOMIC_LDSET = 12,
  HEX_ARM64_ATOMIC_LDSMAX = 13,
  HEX_ARM64_ATOMIC_LDSMIN = 14,
  HEX_ARM64_ATOMIC_LDUMAX = 15,
  HEX_ARM64_ATOMIC_LDUMIN = 16,
  HEX_ARM64_ATOMIC_SWP = 17,
} HexArm64AtomicOp;

typedef struct HexArm64PcRel {
  uint8_t valid;
  uint8_t reg;
  uint8_t page;
  uint8_t _pad[5];
  uint64_t value;
} HexArm64PcRel;

typedef struct HexArm64PairedOffset {
  uint8_t valid;
  uint8_t rn;
  uint8_t rd;
  uint8_t load;
  uint8_t store;
  uint8_t prefetch;
  uint8_t gp_dest;
  uint8_t _pad;
  uint64_t imm;
} HexArm64PairedOffset;

typedef struct HexArm64MemAccess {
  uint8_t valid;
  uint8_t load;
  uint8_t store;
  uint8_t rmw;
  uint8_t atomic;
  uint8_t pair;
  uint8_t vector;
  uint8_t prefetch;
  uint8_t gp_dest;
  uint8_t signed_ext;
  uint8_t tag;
  uint8_t indexed;
  uint8_t acquire;
  uint8_t release;
  uint8_t mode;          // HexArm64MemMode
  uint8_t ordering;      // HexArm64Ordering
  uint8_t atomic_op;     // HexArm64AtomicOp
  uint8_t size;
  uint8_t element_size;
  uint8_t sign_extend_to;
  uint8_t base;
  uint8_t reg;
  uint8_t reg2;
  uint8_t compare_reg;
  uint8_t compare_reg2;
  uint8_t value_reg;
  uint8_t value_reg2;
  uint8_t result_reg;
  uint8_t result_reg2;
  uint8_t source_reg;
  uint8_t status_reg;
  uint8_t has_disp;
  uint8_t has_reg2;
  uint8_t has_status_reg;
  uint8_t _pad[6];
  int64_t disp;
} HexArm64MemAccess;

typedef struct HexArm64Decoded {
  uint32_t word;
  uint8_t kind;            // HexArm64Kind
  uint8_t cap;             // HexArm64Cap
  uint8_t rd;
  uint8_t rn;
  uint8_t rm;
  uint8_t has_target;
  uint8_t has_pc_rel;
  uint8_t has_memory;
  uint8_t has_compare_with;
  uint8_t has_paired_offset;
  uint8_t is_prologue;
  uint8_t is_end;
  uint8_t is_stp_to_sp;
  uint8_t is_sub_sp;
  uint8_t _pad[6];
  uint64_t pc;
  uint64_t target;
  int64_t compare_with;
  HexArm64PcRel pc_rel;
  HexArm64MemAccess memory;
  HexArm64PairedOffset paired_offset;
  char mn[16];
  char ops[64];
} HexArm64Decoded;

// Primary C ABI exports (using shared HEX_WASM_EXPORT from hex_abi.hpp)
HEX_WASM_EXPORT("hex_arm64_classify_word")
uint8_t hex_arm64_classify_word(uint32_t word);

HEX_WASM_EXPORT("hex_arm64_kind_capability")
uint8_t hex_arm64_kind_capability(uint8_t kind);

HEX_WASM_EXPORT("hex_arm64_is_decompiler_supported")
int32_t hex_arm64_is_decompiler_supported(uint32_t word);

HEX_WASM_EXPORT("hex_arm64_kind_name")
const char* hex_arm64_kind_name(uint8_t kind);

HEX_WASM_EXPORT("hex_arm64_atomic_op_name")
const char* hex_arm64_atomic_op_name(uint8_t atomic_op);

HEX_WASM_EXPORT("hex_arm64_ordering_name")
const char* hex_arm64_ordering_name(uint8_t ordering);

HEX_WASM_EXPORT("hex_arm64_mem_mode_name")
const char* hex_arm64_mem_mode_name(uint8_t mode);

HEX_WASM_EXPORT("hex_arm64_decode_word")
HexStatus hex_arm64_decode_word(uint32_t word, uint64_t pc, HexArm64Decoded* out);

HEX_WASM_EXPORT("hex_arm64_decode_batch")
HexStatus hex_arm64_decode_batch(
    const uint32_t* words,
    uint32_t count,
    uint64_t base_pc,
    HexArm64Decoded* out);

HEX_WASM_EXPORT("hex_arm64_decode_batch_pcs")
HexStatus hex_arm64_decode_batch_pcs(
    const uint32_t* words,
    const uint64_t* pcs,
    uint32_t count,
    HexArm64Decoded* out);

HEX_WASM_EXPORT("hex_arm64_classify_batch")
HexStatus hex_arm64_classify_batch(
    const uint32_t* words,
    uint32_t count,
    uint8_t* out_kinds);

// Individual word-level helpers matching js/words.js
HEX_WASM_EXPORT("hex_arm64_branch_imm26")
int32_t hex_arm64_branch_imm26(uint32_t word, uint64_t pc, uint64_t* out_target);

HEX_WASM_EXPORT("hex_arm64_cond_branch_target")
int32_t hex_arm64_cond_branch_target(uint32_t word, uint64_t pc, uint64_t* out_target);

HEX_WASM_EXPORT("hex_arm64_literal_target")
int32_t hex_arm64_literal_target(uint32_t word, uint64_t pc, uint64_t* out_target);

HEX_WASM_EXPORT("hex_arm64_word_target")
int32_t hex_arm64_word_target(uint32_t word, uint64_t pc, uint64_t* out_target);

HEX_WASM_EXPORT("hex_arm64_pc_rel_target")
int32_t hex_arm64_pc_rel_target(uint32_t word, uint64_t pc, HexArm64PcRel* out);

HEX_WASM_EXPORT("hex_arm64_paired_offset")
int32_t hex_arm64_paired_offset(uint32_t word, HexArm64PairedOffset* out);

HEX_WASM_EXPORT("hex_arm64_memory_access")
int32_t hex_arm64_memory_access(uint32_t word, HexArm64MemAccess* out);

HEX_WASM_EXPORT("hex_arm64_compare_immediate")
int32_t hex_arm64_compare_immediate(uint32_t word, int64_t* out_imm);

HEX_WASM_EXPORT("hex_arm64_is_stp_to_sp")
uint8_t hex_arm64_is_stp_to_sp(uint32_t word);

HEX_WASM_EXPORT("hex_arm64_is_sub_sp")
uint8_t hex_arm64_is_sub_sp(uint32_t word);

HEX_WASM_EXPORT("hex_arm64_looks_like_prologue")
uint8_t hex_arm64_looks_like_prologue(uint32_t word);

HEX_WASM_EXPORT("hex_arm64_looks_like_end")
uint8_t hex_arm64_looks_like_end(uint32_t word);

#ifdef __cplusplus
}
#endif

#endif  // HEX_ARM64_DECODE_HPP
