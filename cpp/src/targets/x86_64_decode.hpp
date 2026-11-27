#ifndef HEX_TARGETS_X86_64_DECODE_HPP
#define HEX_TARGETS_X86_64_DECODE_HPP

#include "../../include/hex_abi.hpp"
#include "../../include/hex_core/hex_core.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum HexX86Kind {
  HEX_X86_KIND_UNKNOWN = 0,
  HEX_X86_KIND_NOP = 1,
  HEX_X86_KIND_MOV = 2,
  HEX_X86_KIND_MOVZX = 3,
  HEX_X86_KIND_MOVSX = 4,
  HEX_X86_KIND_ALU = 5,
  HEX_X86_KIND_CMP = 6,
  HEX_X86_KIND_MUL = 7,
  HEX_X86_KIND_LEA = 8,
  HEX_X86_KIND_JMP = 9,
  HEX_X86_KIND_JCC = 10,
  HEX_X86_KIND_CALL = 11,
  HEX_X86_KIND_RET = 12,
  HEX_X86_KIND_PUSH = 13,
  HEX_X86_KIND_POP = 14,
} HexX86Kind;

typedef enum HexX86DecompCap {
  HEX_X86_CAP_FALLBACK = 0,
  HEX_X86_CAP_DECOMP = 1,
} HexX86DecompCap;

typedef enum HexX86DecodeFlags {
  HEX_X86_FLAG_HAS_REX = 1u << 0,
  HEX_X86_FLAG_HAS_66 = 1u << 1,
  HEX_X86_FLAG_HAS_MODRM = 1u << 2,
  HEX_X86_FLAG_HAS_SIB = 1u << 3,
  HEX_X86_FLAG_RIP_REL = 1u << 4,
  HEX_X86_FLAG_HAS_DISP = 1u << 5,
  HEX_X86_FLAG_HAS_IMM = 1u << 6,
  HEX_X86_FLAG_HAS_TARGET = 1u << 7,
  HEX_X86_FLAG_TRUNCATED = 1u << 8,
  HEX_X86_FLAG_INVALID = 1u << 9,
} HexX86DecodeFlags;

typedef struct HexX86Decoded {
  uint64_t pc;
  uint64_t target;
  int64_t disp;
  int64_t imm;
  uint32_t flags;
  uint8_t length;
  uint8_t kind;
  uint8_t cap;
  uint8_t rex;
  uint8_t opcode;
  uint8_t opcode2;
  uint8_t modrm;
  uint8_t sib;
  uint8_t op_size;
  uint8_t reg;
  uint8_t rm;
  uint8_t index_reg;
  uint8_t scale;
  uint8_t disp_size;
  uint8_t imm_size;
  uint8_t valid;
  char mn[16];
} HexX86Decoded;

HEX_WASM_EXPORT("hex_x86_64_decode_one")
HexStatus hex_x86_64_decode_one(
    const uint8_t* bytes,
    uint32_t len,
    uint64_t pc,
    HexX86Decoded* out);

HEX_WASM_EXPORT("hex_x86_64_decode_batch")
HexStatus hex_x86_64_decode_batch(
    const uint8_t* bytes,
    uint32_t len,
    uint64_t base_pc,
    HexX86Decoded* out_insns,
    uint32_t max_insns,
    uint32_t* out_count);

HEX_WASM_EXPORT("hex_x86_64_insn_length")
uint32_t hex_x86_64_insn_length(const uint8_t* bytes, uint32_t len);

HEX_WASM_EXPORT("hex_x86_64_kind_decomp_cap")
uint32_t hex_x86_64_kind_decomp_cap(uint8_t kind);

HEX_WASM_EXPORT("hex_x86_64_is_decompiler_supported")
uint32_t hex_x86_64_is_decompiler_supported(const uint8_t* bytes, uint32_t len);

HEX_WASM_EXPORT("hex_x86_64_kind_name")
const char* hex_x86_64_kind_name(uint8_t kind);

#ifdef __cplusplus
}
#endif

#endif  // HEX_TARGETS_X86_64_DECODE_HPP
