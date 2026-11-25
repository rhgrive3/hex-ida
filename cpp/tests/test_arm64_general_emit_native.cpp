#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "decompiler/passes/arm64_general_emit.hpp"

namespace {

alignas(16) uint8_t g_arena_buf[512u * 1024u];

bool contains(const char* hay, uint32_t hay_len, const char* needle) {
  if (!hay || !needle) return false;
  const size_t nlen = std::strlen(needle);
  if (nlen == 0u) return true;
  if (hay_len < nlen) return false;
  for (size_t i = 0u; i + nlen <= hay_len; ++i) {
    if (std::memcmp(hay + i, needle, nlen) == 0) return true;
  }
  return false;
}

void test_frame_adrp_bl_ret() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  // stp x29, x30, [sp, #-0x10]! ; mov x29, sp ; adrp x0, #0x1018fe000 ; add x0, x0, #0x198 ;
  // bl #0x10116d080 ; mov x1, #0 ; ldp x29, x30, [sp], #0x10 ; ret
  const uint32_t words[] = {
    0xa9bf7bfdu, 0x910003fdu, 0xd00062a0u, 0x91066000u,
    0x941311a9u, 0xd2800001u, 0xa8c17bfdu, 0xd65f03c0u,
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  const HexStatus st = hex::decompiler::passes::try_emit_arm64_general(
      words, 8u, 0x100ca89ccULL, "sub_100ca89cc", 13u, HEX_EMIT_FLAG_JS_PARITY,
      arena, &txt, &len, &lm, &lm_cnt);
  assert(st == HEX_OK);
  assert(txt != nullptr && len > 0u && lm != nullptr && lm_cnt > 0u);
  assert(contains(txt, len, "global_1018FE198"));
  assert(contains(txt, len, "sub_10116D080"));
  assert(contains(txt, len, "uint64 sub_100ca89cc("));
  assert(contains(txt, len, "return x0;"));
}

void test_adrp_invalidation_on_ldr_overwrite() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  // adrp x8, #0x10163b000 ; ldr x8, [x8, #0x720] ; ldr x8, [x8] ; ret
  // Second ldr must NOT treat overwritten x8 as ADRP page 0x10163B000!
  const uint32_t words[] = {
    0x90006c48u,  // adrp x8, ...
    0xf9439108u,  // ldr x8, [x8, #0x720]
    0xf9400108u,  // ldr x8, [x8]
    0xd65f03c0u,  // ret
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  const HexStatus st = hex::decompiler::passes::try_emit_arm64_general(
      words, 4u, 0x1008b0830ULL, nullptr, 0u, 0u,
      arena, &txt, &len, &lm, &lm_cnt);
  assert(st == HEX_OK);
  assert(contains(txt, len, "*(uint64 *)((uintptr_t)(x8))"));
}

void test_bitmask_imm_and_fp_ops() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  // mov w9, #0xffff00 ; fmov d0, #1.0 ; fmov d1, d0 ; fadd d0, d0, d1 ; fcvtas w0, d0 ; ret
  const uint32_t words[] = {
    0x32183fe9u,  // orr w9, wzr, #0xffff00
    0x1e6e1000u,  // fmov d0, #1.0
    0x1e604001u,  // fmov d1, d0
    0x1e612800u,  // fadd d0, d0, d1
    0x1e640000u,  // fcvtas w0, d0
    0xd65f03c0u,  // ret
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  const HexStatus st = hex::decompiler::passes::try_emit_arm64_general(
      words, 6u, 0x100001000ULL, "fp_mix", 6u, 0u,
      arena, &txt, &len, &lm, &lm_cnt);
  assert(st == HEX_OK);
  assert(contains(txt, len, "0xFFFF00"));
  assert(contains(txt, len, "d0 = 1.0;"));
  assert(contains(txt, len, "d0 = d0 + d1;"));
  assert(contains(txt, len, "return x0;"));
}

void test_guards_and_rejections() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;

  // Reject pure-register 2-word stub (preserves synthetic regression fallback tests)
  const uint32_t tiny_alu[] = { 0x0b010000u, 0xd65f03c0u };
  assert(hex::decompiler::passes::try_emit_arm64_general(
      tiny_alu, 2u, 0x1000ULL, "tiny", 4u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // Reject ObjC names
  const uint32_t four_words[] = { 0xf9400000u, 0xf900001fu, 0xaa0003e0u, 0xd65f03c0u };
  assert(hex::decompiler::passes::try_emit_arm64_general(
      four_words, 4u, 0x1000ULL, "-[Foo bar]", 10u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // Reject digit-leading symbol name
  assert(hex::decompiler::passes::try_emit_arm64_general(
      four_words, 4u, 0x1000ULL, "123bad", 6u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // Reject base_addr + byte_len wraparound
  assert(hex::decompiler::passes::try_emit_arm64_general(
      four_words, 4u, UINT64_MAX - 8ULL, "wrap", 4u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // Trailing label before '}' emits valid C11 `(void)0;`
  const uint32_t trailing_nop[] = {
    0xb4000060u,  // cbz x0, +12 (points to idx 3 NOP)
    0xd2800020u,  // mov x0, #1
    0xd65f03c0u,  // ret
    0xd503201fu,  // nop (branch target at end)
  };
  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_general(
      trailing_nop, 4u, 0x1000ULL, "trail", 5u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert(contains(txt, len, "loc_100C:\n    (void)0;\n}"));
}

}  // namespace

int main() {
  test_frame_adrp_bl_ret();
  test_adrp_invalidation_on_ldr_overwrite();
  test_bitmask_imm_and_fp_ops();
  test_guards_and_rejections();
  std::puts("test_arm64_general_emit_native: PASS");
  return 0;
}
