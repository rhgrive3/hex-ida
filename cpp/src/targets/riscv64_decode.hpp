#ifndef HEX_TARGETS_RISCV64_DECODE_HPP
#define HEX_TARGETS_RISCV64_DECODE_HPP

#include "../../include/hex_core/hex_core.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum HexRiscv64Kind {
  HEX_RISCV64_KIND_UNKNOWN = 0,
  HEX_RISCV64_KIND_LUI = 1,
  HEX_RISCV64_KIND_AUIPC = 2,
  HEX_RISCV64_KIND_JAL = 3,
  HEX_RISCV64_KIND_JALR = 4,
  HEX_RISCV64_KIND_BRANCH = 5,
  HEX_RISCV64_KIND_LOAD = 6,
  HEX_RISCV64_KIND_STORE = 7,
  HEX_RISCV64_KIND_OP_IMM = 8,
  HEX_RISCV64_KIND_OP_IMM_32 = 9,
  HEX_RISCV64_KIND_OP = 10,
  HEX_RISCV64_KIND_OP_32 = 11,
  HEX_RISCV64_KIND_SYSTEM = 12,
  HEX_RISCV64_KIND_RVC_COMPRESSED = 13,
} HexRiscv64Kind;

typedef enum HexRiscv64DecompCap {
  HEX_RISCV64_CAP_FALLBACK = 0,
  HEX_RISCV64_CAP_DECOMP = 1,
} HexRiscv64DecompCap;

typedef struct HexRiscv64Decoded {
  uint64_t pc;
  uint64_t target;
  int64_t imm;
  uint32_t raw;
  uint8_t length;
  uint8_t kind;
  uint8_t cap;
  uint8_t opcode;
  uint8_t funct3;
  uint8_t funct7;
  uint8_t rd;
  uint8_t rs1;
  uint8_t rs2;
  uint8_t has_imm;
  uint8_t has_target;
  uint8_t is_ret;
  uint8_t is_call;
  uint8_t valid;
  char mn[16];
} HexRiscv64Decoded;

HEX_WASM_EXPORT("hex_riscv64_insn_length")
uint32_t hex_riscv64_insn_length(const uint8_t* bytes, uint32_t len);

HEX_WASM_EXPORT("hex_riscv64_decode_one")
uint32_t hex_riscv64_decode_one(
    const uint8_t* bytes,
    uint32_t len,
    uint64_t pc,
    HexRiscv64Decoded* out);

HEX_WASM_EXPORT("hex_riscv64_decode_batch")
uint32_t hex_riscv64_decode_batch(
    const uint8_t* bytes,
    uint32_t byte_len,
    uint64_t base_pc,
    HexRiscv64Decoded* out,
    uint32_t max_out);

HEX_WASM_EXPORT("hex_riscv64_is_decompiler_supported")
int32_t hex_riscv64_is_decompiler_supported(const uint8_t* bytes, uint32_t len);

HEX_WASM_EXPORT("hex_riscv64_kind_name")
const char* hex_riscv64_kind_name(uint8_t kind);

#ifdef __cplusplus
}
#endif

#endif  // HEX_TARGETS_RISCV64_DECODE_HPP
