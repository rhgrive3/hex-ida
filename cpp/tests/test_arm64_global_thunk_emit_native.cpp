#include <cassert>
#include <cstdio>
#include <cstring>

#include "decompiler/passes/arm64_global_thunk_emit.hpp"

namespace {

static void test_adrp_add_global_getter() {
  alignas(16) uint8_t mem[65536];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));

  // sub_1002606d0: adrp x0, #0x101651000 ; add x0, x0, #0x5b0 ; ret
  // base_addr = 0x1002606d0 -> page = 0x100260000, delta = 0x13f1000 = 0x13f1 pages
  // immlo = 1 (bits 30:29), immhi = 0x4fc (bits 23:5)
  const uint32_t adrp = 0x90000000u | ((0x13f1u & 3u) << 29u) | (((0x13f1u >> 2u) & 0x7ffffu) << 5u) | 0u;
  const uint32_t add = 0x91000000u | (0x5b0u << 10u) | (0u << 5u) | 0u;
  const uint32_t ret = 0xd65f03c0u;
  const uint32_t words[3] = {adrp, add, ret};

  const char* text = nullptr;
  uint32_t text_len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;
  const HexStatus st = hex::decompiler::passes::try_emit_arm64_global_thunk(
      words, 3u, 0x1002606d0ULL, "sub_1002606d0", 13u, 0u,
      arena, &text, &text_len, &lm, &lm_count);
  assert(st == HEX_OK);
  assert(text != nullptr && std::strstr(text, "global_1016515B0") != nullptr);
  assert(std::strstr(text, "return (uintptr_t)(&global_1016515B0);") != nullptr);
}

static void test_pure_tail_call_thunk() {
  alignas(16) uint8_t mem[65536];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));

  // mov w1, #1 ; b #0x1000ed8bc (external)
  const uint32_t words[2] = {0x52800021u, 0x17ffffccu};
  const char* text = nullptr;
  uint32_t text_len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;
  const HexStatus st = hex::decompiler::passes::try_emit_arm64_global_thunk(
      words, 2u, 0x1000ed98cULL, "sub_1000ed98c", 13u, 0u,
      arena, &text, &text_len, &lm, &lm_count);
  assert(st == HEX_OK);
  assert(std::strcmp(text, "void sub_1000ed98c(void)\n{\n}") == 0);

  // Guard: reading x0 before definition must return HEX_ERR_UNSUPPORTED
  arena.reset();
  const uint32_t bad_words[2] = {0xf9400401u, 0x140003ffu};  // ldr x1, [x0, #8] ; b #0x2000
  assert(hex::decompiler::passes::try_emit_arm64_global_thunk(
             bad_words, 2u, 0x1000ULL, "t", 1u, 0u, arena, &text, &text_len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
}

static void test_frame_bl_tail_wrapper() {
  alignas(16) uint8_t mem[65536];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));

  // stp x29, x30, [sp, #-0x10]! ; mov x29, sp ; bl +0x100 ; ldp x29, x30, [sp], #0x10 ; b +0x200
  const uint32_t words[5] = {
      0xa9bf7bfdu,
      0x910003fdu,
      0x94000040u,  // bl pc + 0x100
      0xa8c17bfdu,
      0x14000080u,  // b pc + 0x200
  };
  const char* text = nullptr;
  uint32_t text_len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;
  const HexStatus st = hex::decompiler::passes::try_emit_arm64_global_thunk(
      words, 5u, 0x100000ULL, "sub_100000", 10u, 0u,
      arena, &text, &text_len, &lm, &lm_count);
  assert(st == HEX_OK);
  assert(std::strstr(text, "sub_100108(/* arguments unknown */);") != nullptr);
}

}  // namespace

static void test_security_and_parity_regressions() {
  alignas(16) uint8_t mem[65536];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));
  const char* text = nullptr;
  uint32_t text_len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  // 1) STR Q0, [x9, #0x10] (V=1, opc=2) must NOT be deleted as a pure load
  {
    const uint32_t words[2] = {0x3d800520u, 0x14000400u};
    assert(hex::decompiler::passes::try_emit_arm64_global_thunk(
               words, 2u, 0x100000ULL, "t", 1u, 0u, arena, &text, &text_len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }
  // 2) LDR D0, [x9] (V=1) followed by LDR x8, [x0, #8] must NOT treat x0 as defined
  {
    const uint32_t words[3] = {0xfd400120u, 0xf9400408u, 0x14000400u};
    assert(hex::decompiler::passes::try_emit_arm64_global_thunk(
               words, 3u, 0x100000ULL, "t", 1u, 0u, arena, &text, &text_len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }
  // 3) PRFM pldl1keep, [x9] (size=3, opc=2) followed by LDR x8, [x0, #8] must NOT treat x0 as defined
  {
    const uint32_t words[3] = {0xf9800120u, 0xf9400408u, 0x14000400u};
    assert(hex::decompiler::passes::try_emit_arm64_global_thunk(
               words, 3u, 0x100000ULL, "t", 1u, 0u, arena, &text, &text_len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }
  // 4) Pattern 3 self-recursive BL must be rejected
  {
    const uint32_t words[5] = {0xa9bf7bfdu, 0x910003fdu, 0x97fffffeu, 0xa8c17bfdu, 0x14000080u};
    assert(hex::decompiler::passes::try_emit_arm64_global_thunk(
               words, 5u, 0x100000ULL, "sub_100000", 10u, 0u, arena, &text, &text_len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }
  // 5) INT64_MAX boundary ADRP+ADD+RET (no signed overflow UB) & UINT64_MAX wrap rejection
  {
    const uint32_t adrp_plus1 = 0x90000000u | (1u << 29u);
    const uint32_t add_0 = 0x91000000u;
    const uint32_t ret = 0xd65f03c0u;
    const uint32_t words[3] = {adrp_plus1, add_0, ret};
    arena.reset();
    assert(hex::decompiler::passes::try_emit_arm64_global_thunk(
               words, 3u, 0x7ffffffffffff000ULL, nullptr, 0u, 0u, arena, &text, &text_len, &lm, &lm_count) == HEX_OK);
    assert(std::strstr(text, "sub_7FFFFFFFFFFFF000") != nullptr);
    arena.reset();
    assert(hex::decompiler::passes::try_emit_arm64_global_thunk(
               words, 3u, UINT64_MAX - 4ULL, nullptr, 0u, 0u, arena, &text, &text_len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }
  // 6) Unnamed fallback function uses uppercase hex (sub_100ABC)
  {
    const uint32_t words[2] = {0x52800021u, 0x14000400u};
    arena.reset();
    assert(hex::decompiler::passes::try_emit_arm64_global_thunk(
               words, 2u, 0x100abcULL, nullptr, 0u, 0u, arena, &text, &text_len, &lm, &lm_count) == HEX_OK);
    assert(std::strcmp(text, "void sub_100ABC(void)\n{\n}") == 0);
  }
}

int main() {
  test_adrp_add_global_getter();
  test_pure_tail_call_thunk();
  test_frame_bl_tail_wrapper();
  test_security_and_parity_regressions();
  std::printf("test_arm64_global_thunk_emit_native (ASan+UBSan, regressions): ALL PASS\n");
  return 0;
}
