#include "../src/targets/riscv64_decode.hpp"

#include <cstdio>
#include <cstring>

namespace {

int g_failures = 0;

void fail_msg(const char* expr, int line) {
  std::fprintf(stderr, "FAIL (line %d): %s\n", line, expr);
  ++g_failures;
}

#define CHECK(cond) \
  do { \
    if (!(cond)) fail_msg(#cond, __LINE__); \
  } while (0)

void put_u32_le(uint8_t out[4], uint32_t w) {
  out[0] = static_cast<uint8_t>(w & 0xffu);
  out[1] = static_cast<uint8_t>((w >> 8) & 0xffu);
  out[2] = static_cast<uint8_t>((w >> 16) & 0xffu);
  out[3] = static_cast<uint8_t>((w >> 24) & 0xffu);
}

void put_u16_le(uint8_t out[2], uint16_t hw) {
  out[0] = static_cast<uint8_t>(hw & 0xffu);
  out[1] = static_cast<uint8_t>((hw >> 8) & 0xffu);
}

HexRiscv64Decoded decode32(uint32_t w, uint64_t pc) {
  uint8_t buf[4];
  put_u32_le(buf, w);
  CHECK(hex_riscv64_insn_length(buf, 4u) == 4u);
  HexRiscv64Decoded d{};
  CHECK(hex_riscv64_decode_one(buf, 4u, pc, &d) == 4u);
  CHECK(d.valid == 1u && d.length == 4u && d.cap == HEX_RISCV64_CAP_FALLBACK);
  CHECK(hex_riscv64_is_decompiler_supported(buf, 4u) == HEX_RISCV64_CAP_FALLBACK);
  return d;
}

HexRiscv64Decoded decode16(uint16_t hw, uint64_t pc) {
  uint8_t buf[2];
  put_u16_le(buf, hw);
  CHECK(hex_riscv64_insn_length(buf, 2u) == 2u);
  HexRiscv64Decoded d{};
  CHECK(hex_riscv64_decode_one(buf, 2u, pc, &d) == 2u);
  CHECK(d.valid == 1u && d.length == 2u && d.cap == HEX_RISCV64_CAP_FALLBACK);
  CHECK(hex_riscv64_is_decompiler_supported(buf, 2u) == HEX_RISCV64_CAP_FALLBACK);
  return d;
}

void test_rv64im_instructions() {
  // addi a0, a0, 42 (0x02a50513)
  {
    const auto d = decode32(0x02a50513u, 0x1000ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_OP_IMM);
    CHECK(d.rd == 10u && d.rs1 == 10u && d.has_imm == 1u && d.imm == 42);
    CHECK(std::strcmp(d.mn, "addi") == 0);
  }
  // addi sp, sp, -16 (0xff010113)
  {
    const auto d = decode32(0xff010113u, 0x1004ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_OP_IMM);
    CHECK(d.rd == 2u && d.rs1 == 2u && d.imm == -16);
  }
  // addiw a0, a0, 1 (0x0015051b)
  {
    const auto d = decode32(0x0015051bu, 0x1008ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_OP_IMM_32);
    CHECK(d.rd == 10u && d.rs1 == 10u && d.imm == 1);
    CHECK(std::strcmp(d.mn, "addiw") == 0);
  }
  // add a0, a0, a1 (0x00b50533)
  {
    const auto d = decode32(0x00b50533u, 0x100cULL);
    CHECK(d.kind == HEX_RISCV64_KIND_OP);
    CHECK(d.rd == 10u && d.rs1 == 10u && d.rs2 == 11u);
    CHECK(std::strcmp(d.mn, "add") == 0);
  }
  // sub a0, a0, a1 (0x40b50533)
  {
    const auto d = decode32(0x40b50533u, 0x1010ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_OP);
    CHECK(d.rd == 10u && d.rs1 == 10u && d.rs2 == 11u);
    CHECK(std::strcmp(d.mn, "sub") == 0);
  }
  // mul a0, a0, a1 (0x02b50533)
  {
    const auto d = decode32(0x02b50533u, 0x1014ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_OP);
    CHECK(d.rd == 10u && d.rs1 == 10u && d.rs2 == 11u);
    CHECK(std::strcmp(d.mn, "mul") == 0);
  }
  // addw / mulw (OP_32)
  {
    const auto d1 = decode32(0x00b5053bu, 0x1018ULL);
    CHECK(d1.kind == HEX_RISCV64_KIND_OP_32 && std::strcmp(d1.mn, "addw") == 0);
    const auto d2 = decode32(0x02b5053bu, 0x101cULL);
    CHECK(d2.kind == HEX_RISCV64_KIND_OP_32 && std::strcmp(d2.mn, "mulw") == 0);
  }
  // ld a0, 8(sp) (0x00813503)
  {
    const auto d = decode32(0x00813503u, 0x1020ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_LOAD);
    CHECK(d.rd == 10u && d.rs1 == 2u && d.has_imm == 1u && d.imm == 8);
    CHECK(std::strcmp(d.mn, "ld") == 0);
  }
  // sd ra, 16(sp) (0x00113823)
  {
    const auto d = decode32(0x00113823u, 0x1024ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_STORE);
    CHECK(d.rs1 == 2u && d.rs2 == 1u && d.has_imm == 1u && d.imm == 16);
    CHECK(std::strcmp(d.mn, "sd") == 0);
  }
  // beq a0, a1, +16 (0x00b50863)
  {
    const auto d = decode32(0x00b50863u, 0x2000ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_BRANCH);
    CHECK(d.rs1 == 10u && d.rs2 == 11u && d.imm == 16 && d.has_target == 1u && d.target == 0x2010ULL);
    CHECK(std::strcmp(d.mn, "beq") == 0);
  }
  // bne a0, x0, -8 (0xfe051ce3)
  {
    const auto d = decode32(0xfe051ce3u, 0x2020ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_BRANCH);
    CHECK(d.rs1 == 10u && d.rs2 == 0u && d.imm == -8 && d.target == 0x2018ULL);
    CHECK(std::strcmp(d.mn, "bne") == 0);
  }
  // jal ra, +32 (0x020000ef)
  {
    const auto d = decode32(0x020000efu, 0x3000ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_JAL);
    CHECK(d.rd == 1u && d.imm == 32 && d.has_target == 1u && d.target == 0x3020ULL);
    CHECK(d.is_call == 1u && d.is_ret == 0u && std::strcmp(d.mn, "jal") == 0);
  }
  // jalr ra, 0(a0) (0x000500e7)
  {
    const auto d = decode32(0x000500e7u, 0x3004ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_JALR);
    CHECK(d.rd == 1u && d.rs1 == 10u && d.imm == 0 && d.is_call == 1u && d.is_ret == 0u);
    CHECK(std::strcmp(d.mn, "jalr") == 0);
  }
  // ret = jalr x0, ra, 0 (0x00008067)
  {
    const auto d = decode32(0x00008067u, 0x3008ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_JALR);
    CHECK(d.rd == 0u && d.rs1 == 1u && d.imm == 0 && d.is_ret == 1u && d.is_call == 0u);
    CHECK(std::strcmp(d.mn, "ret") == 0);
  }
  // lui a0, 0x12345 (0x12345537) & negative lui a0, 0xfffff (0xfffff537)
  {
    const auto d1 = decode32(0x12345537u, 0x4000ULL);
    CHECK(d1.kind == HEX_RISCV64_KIND_LUI && d1.rd == 10u && d1.imm == 0x12345000LL);
    CHECK(std::strcmp(d1.mn, "lui") == 0);
    const auto d2 = decode32(0xfffff537u, 0x4004ULL);
    CHECK(d2.kind == HEX_RISCV64_KIND_LUI && d2.rd == 10u && d2.imm == -4096LL);
  }
  // auipc a0, 0x1 (0x00001517)
  {
    const auto d = decode32(0x00001517u, 0x4010ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_AUIPC && d.rd == 10u && d.imm == 0x1000LL);
    CHECK(d.has_target == 1u && d.target == 0x5010ULL && std::strcmp(d.mn, "auipc") == 0);
  }
  // ecall (0x00000073) & ebreak (0x00100073)
  {
    const auto d1 = decode32(0x00000073u, 0x5000ULL);
    CHECK(d1.kind == HEX_RISCV64_KIND_SYSTEM && std::strcmp(d1.mn, "ecall") == 0);
    const auto d2 = decode32(0x00100073u, 0x5004ULL);
    CHECK(d2.kind == HEX_RISCV64_KIND_SYSTEM && std::strcmp(d2.mn, "ebreak") == 0);
  }
}

void test_rvc16_instructions() {
  // c.nop (0x0001)
  {
    const auto d = decode16(0x0001u, 0x6000ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_RVC_COMPRESSED);
    CHECK(d.rd == 0u && d.imm == 0 && d.is_ret == 0u && d.is_call == 0u);
    CHECK(std::strcmp(d.mn, "c.nop") == 0);
  }
  // c.addi a0, 5 (0x0515) & c.addi a0, -1 (0x157d)
  {
    const auto d1 = decode16(0x0515u, 0x6002ULL);
    CHECK(d1.kind == HEX_RISCV64_KIND_RVC_COMPRESSED && d1.rd == 10u && d1.rs1 == 10u && d1.imm == 5);
    CHECK(std::strcmp(d1.mn, "c.addi") == 0);

    const auto d2 = decode16(0x157du, 0x6004ULL);
    CHECK(d2.kind == HEX_RISCV64_KIND_RVC_COMPRESSED && d2.rd == 10u && d2.imm == -1);
  }
  // c.jr ra (0x8082) -> is_ret == 1
  {
    const auto d = decode16(0x8082u, 0x6006ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_RVC_COMPRESSED);
    CHECK(d.rs1 == 1u && d.is_ret == 1u && d.is_call == 0u);
    CHECK(std::strcmp(d.mn, "c.jr") == 0);
  }
  // c.jalr a0 (0x9502) -> is_call == 1
  {
    const auto d = decode16(0x9502u, 0x6008ULL);
    CHECK(d.kind == HEX_RISCV64_KIND_RVC_COMPRESSED);
    CHECK(d.rd == 1u && d.rs1 == 10u && d.is_call == 1u && d.is_ret == 0u);
    CHECK(std::strcmp(d.mn, "c.jalr") == 0);
  }
}

void test_batch_and_fail_closed_negatives() {
  // Mixed stream: c.nop (2B) + add a0, a0, a1 (4B) + c.jr ra (2B) + truncated 32-bit tail (2B of 0x00008067)
  uint8_t stream[10];
  put_u16_le(stream + 0, 0x0001u);
  put_u32_le(stream + 2, 0x00b50533u);
  put_u16_le(stream + 6, 0x8082u);
  stream[8] = 0x67u;  // low 2 bits = 11 -> 32-bit insn, but only 2 bytes left (truncated!)
  stream[9] = 0x80u;

  HexRiscv64Decoded out[8];
  const uint32_t cnt = hex_riscv64_decode_batch(stream, sizeof(stream), 0x8000ULL, out, 8u);
  CHECK(cnt == 3u);
  CHECK(out[0].valid == 1u && out[0].pc == 0x8000ULL && out[0].length == 2u);
  CHECK(out[1].valid == 1u && out[1].pc == 0x8002ULL && out[1].length == 4u);
  CHECK(out[2].valid == 1u && out[2].pc == 0x8006ULL && out[2].length == 2u && out[2].is_ret == 1u);
  CHECK(out[3].valid == 0u);  // truncated tail stopped immediately with valid=0

  // Null / zero / truncated / illegal / >32-bit unsupported lengths
  HexRiscv64Decoded d{};
  CHECK(hex_riscv64_insn_length(nullptr, 4u) == 0u);
  CHECK(hex_riscv64_insn_length(stream, 0u) == 0u);
  CHECK(hex_riscv64_decode_one(nullptr, 4u, 0, &d) == 0u && d.valid == 0u);
  CHECK(hex_riscv64_decode_one(stream, 4u, 0, nullptr) == 0u);
  CHECK(hex_riscv64_decode_batch(nullptr, 4u, 0, out, 8u) == 0u);
  CHECK(hex_riscv64_decode_batch(stream, 4u, 0, nullptr, 8u) == 0u);
  CHECK(hex_riscv64_decode_batch(stream, 4u, 0, out, 0u) == 0u);

  const uint8_t trunc_rvc[1] = {0x01u};
  const uint8_t trunc_32[3] = {0x13u, 0x05u, 0xa5u};
  const uint8_t illegal_zero[2] = {0x00u, 0x00u};
  const uint8_t insn_48bit[6] = {0x1fu, 0x00u, 0x00u, 0x00u, 0x00u, 0x00u};
  CHECK(hex_riscv64_insn_length(trunc_rvc, 1u) == 0u);
  CHECK(hex_riscv64_insn_length(trunc_32, 3u) == 0u);
  CHECK(hex_riscv64_insn_length(illegal_zero, 2u) == 0u);
  CHECK(hex_riscv64_insn_length(insn_48bit, 6u) == 0u);
  CHECK(hex_riscv64_decode_one(trunc_rvc, 1u, 0, &d) == 0u && d.valid == 0u);
  CHECK(hex_riscv64_decode_one(trunc_32, 3u, 0, &d) == 0u && d.valid == 0u);
  CHECK(hex_riscv64_decode_one(illegal_zero, 2u, 0, &d) == 0u && d.valid == 0u);
  CHECK(hex_riscv64_decode_one(insn_48bit, 6u, 0, &d) == 0u && d.valid == 0u);

  // Capability always fail-closed (0)
  CHECK(hex_riscv64_is_decompiler_supported(nullptr, 0u) == HEX_RISCV64_CAP_FALLBACK);
  CHECK(hex_riscv64_is_decompiler_supported(stream, 8u) == HEX_RISCV64_CAP_FALLBACK);

  // Kind names
  CHECK(std::strcmp(hex_riscv64_kind_name(HEX_RISCV64_KIND_LUI), "lui") == 0);
  CHECK(std::strcmp(hex_riscv64_kind_name(HEX_RISCV64_KIND_RVC_COMPRESSED), "rvc_compressed") == 0);
  CHECK(std::strcmp(hex_riscv64_kind_name(255u), "unknown") == 0);
}

}  // namespace

int main() {
  test_rv64im_instructions();
  test_rvc16_instructions();
  test_batch_and_fail_closed_negatives();

  if (g_failures == 0) {
    std::printf("test_riscv64_decode_native (ASan+UBSan): ALL PASS\n");
    return 0;
  }
  std::fprintf(stderr, "test_riscv64_decode_native: %d FAILURE(S)\n", g_failures);
  return 1;
}
