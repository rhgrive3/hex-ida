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
  const uint32_t words[] = {
    0xa9bf7bfdu, 0x910003fdu, 0xd00062a0u, 0x91066000u,
    0x941311a9u, 0xd2800001u, 0xa8c17bfdu, 0xd65f03c0u,
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  assert(hex::decompiler::passes::try_emit_arm64_general(
             words, 8u, 0x100ca89ccULL, "sub_100ca89cc", 13u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert(txt != nullptr && len > 0u && lm != nullptr && lm_cnt > 0u);
  assert(contains(txt, len, "global_1018FE198"));
  assert(contains(txt, len, "sub_10116D080"));
  assert(contains(txt, len, "uint64 sub_100ca89cc("));
  assert(contains(txt, len, "return x0;"));
}

void test_adrp_invalidation_and_xzr_and_q_store() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  // adrp x8, +0x1000 ; ldr x8, [x8, #0x720] ; ldr x8, [x8] ;
  // adrp x9, -0x1000 ; ldr xzr, [x9, #0x10] ; str q0, [x9, #0x20] ;
  // ldar x9, [x9] ; ldr x9, [x9] ; ret
  const uint32_t words[] = {
    0x90000008u,  // adrp x8, #0x1008b0000
    0xf9439108u,  // ldr x8, [x8, #0x720]
    0xf9400108u,  // ldr x8, [x8]
    0xf0ffffe9u,  // adrp x9, negative offset
    0xf940093fu,  // ldr xzr, [x9, #0x10]
    0x3d800920u,  // str q0, [x9, #0x20]
    0xc8dffd29u,  // ldar x9, [x9]
    0xf9400129u,  // ldr x9, [x9]
    0xd65f03c0u,  // ret
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  assert(hex::decompiler::passes::try_emit_arm64_general(
             words, 9u, 0x1008b0830ULL, nullptr, 0u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert(contains(txt, len, "*(uint64 *)((uintptr_t)(x8))"));
  assert(contains(txt, len, "(void)global_"));
  assert(!contains(txt, len, "0ULL = global_"));
  assert(contains(txt, len, "uint128 q0 = 0;"));
  assert(contains(txt, len, " = q0;"));
  assert(contains(txt, len, "*(uint64 *)((uintptr_t)(x9))"));
}

void test_bcond_lslv_udiv_sp_prfm_ldnp_fcvtau_cas() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const uint32_t words[] = {
    0x5400006eu,  // b.al +12 (invalid cmp / default cond -> must emit `if (1) goto ...;`)
    0x1ac12000u,  // lslv w0, w0, w1 (op2=8)
    0x1ac12400u,  // lsrv w0, w0, w1 (op2=9)
    0x9ac12800u,  // asrv x0, x0, x1 (op2=10)
    0x1ac10800u,  // udiv w0, w0, w1 (32-bit div-zero guard)
    0x9100401fu,  // add sp, x0, #16 (rd=SP, rn=x0)
    0x927cedffu,  // and sp, sp, #-16 (logical imm rd=SP)
    0xf9800000u,  // prfm pldl1keep, [x0] (must NOT clobber x0)
    0xa8410402u,  // ldnp x2, x1, [x0, #16] (mode=0 keeps offset +16)
    0x1e650003u,  // fcvtau w3, d0 (opcode=5: FP -> GPR)
    0xc8a17c02u,  // cas x1, x2, [x0] (excluded from LDAR/STLR)
    0xd65f03c0u,  // ret
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  assert(hex::decompiler::passes::try_emit_arm64_general(
             words, 12u, 0x100002000ULL, "review_regressions", 18u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert(contains(txt, len, "if (1) goto loc_10000200C;"));
  assert(contains(txt, len, " << (x1 & 31)"));
  assert(contains(txt, len, " >> (x1 & 31)"));
  assert(contains(txt, len, "(int64_t)x0) >> (x1 & 63)"));
  assert(contains(txt, len, "((uint32_t)x1 != 0 ?"));
  assert(contains(txt, len, "sp = x0 + 16;"));
  assert(contains(txt, len, "sp = x15 & "));
  assert(contains(txt, len, "x2 = *(uint64 *)((uintptr_t)(x0) + 16);"));
  assert(contains(txt, len, "x3 = (uint32_t)(int64_t)d0;"));
  assert(contains(txt, len, "/* arm64 insn 0xC8A17C02 */"));
}

void test_self_recursion_and_bitmask_fp() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  // Self-recursive void function: `bl 0x100001000 ; fmov d0, #1.0 ; fmov d1, d0 ; fadd d0, d0, d1 ; ret`
  const uint32_t words[] = {
    0x94000000u,  // bl #0x100001000 (self)
    0x32183fe9u,  // mov w9, #0xffff00
    0x1e6e1000u,  // fmov d0, #1.0
    0x1e604001u,  // fmov d1, d0
    0x1e612800u,  // fadd d0, d0, d1
    0xd65f03c0u,  // ret
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  assert(hex::decompiler::passes::try_emit_arm64_general(
             words, 6u, 0x100001000ULL, "sub_100001000", 13u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  // Must NOT emit conflicting external `uint64 sub_100001000 (__HEX_ANY_ARGS);`
  assert(!contains(txt, len, "uint64 sub_100001000 (__HEX_ANY_ARGS);"));
  assert(contains(txt, len, "0xFFFF00"));
  assert(contains(txt, len, "d0 = 1.0;"));
  assert(contains(txt, len, "d0 = d0 + d1;"));
}

void test_guards_oom_and_table_overflow() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;

  // Reject pure-register 2-word stub
  const uint32_t tiny_alu[] = { 0x0b010000u, 0xd65f03c0u };
  assert(hex::decompiler::passes::try_emit_arm64_general(
             tiny_alu, 2u, 0x1000ULL, "tiny", 4u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // Reject ObjC names & digit-leading names & PC wraparound
  const uint32_t four_words[] = { 0xf9400000u, 0xf900001fu, 0xaa0003e0u, 0xd65f03c0u };
  assert(hex::decompiler::passes::try_emit_arm64_general(
             four_words, 4u, 0x1000ULL, "-[Foo bar]", 10u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);
  assert(hex::decompiler::passes::try_emit_arm64_general(
             four_words, 4u, 0x1000ULL, "123bad", 6u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);
  assert(hex::decompiler::passes::try_emit_arm64_general(
             four_words, 4u, UINT64_MAX - 8ULL, "wrap", 4u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // Tiny arena triggers HEX_ERR_OOM cleanly
  alignas(16) uint8_t tiny_buf[64];
  hex::Arena tiny_arena;
  tiny_arena.init_fixed(tiny_buf, sizeof(tiny_buf));
  assert(hex::decompiler::passes::try_emit_arm64_general(
             four_words, 4u, 0x1000ULL, "oom", 3u, 0u, tiny_arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_OOM);

  // Exceeding kMaxCallees (128) triggers HEX_ERR_RESOURCE_LIMIT cleanly
  uint32_t many_calls[135];
  for (uint32_t i = 0u; i < 134u; ++i) {
    // bl +(0x1000 + i*8) -> distinct external callee per instruction
    const uint32_t imm26 = (0x400u + i * 2u) & 0x03FFFFFFu;
    many_calls[i] = 0x94000000u | imm26;
  }
  many_calls[134] = 0xd65f03c0u;
  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_general(
             many_calls, 135u, 0x100000000ULL, "many_calls", 10u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_RESOURCE_LIMIT);

  // Trailing label before '}' emits valid C11 `(void)0;`
  const uint32_t trailing_nop[] = { 0xb4000060u, 0xd2800020u, 0xd65f03c0u, 0xd503201fu };
  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_general(
             trailing_nop, 4u, 0x1000ULL, "trail", 5u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert(contains(txt, len, "loc_100C:\n    (void)0;\n}"));
}

}  // namespace

int main() {
  test_frame_adrp_bl_ret();
  test_adrp_invalidation_and_xzr_and_q_store();
  test_bcond_lslv_udiv_sp_prfm_ldnp_fcvtau_cas();
  test_self_recursion_and_bitmask_fp();
  test_guards_oom_and_table_overflow();
  std::puts("test_arm64_general_emit_native: PASS");
  return 0;
}
