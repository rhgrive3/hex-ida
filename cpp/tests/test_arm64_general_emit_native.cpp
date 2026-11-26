#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "decompiler/passes/arm64_general_emit.hpp"

namespace hex::decompiler::passes {
void set_general_scratch_arena(hex::Arena* scratch);
}

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

void assert_parens_balanced(const char* txt, uint32_t len) {
  int depth = 0;
  for (uint32_t i = 0u; i < len; ++i) {
    if (txt[i] == '(') ++depth;
    else if (txt[i] == ')') {
      --depth;
      assert(depth >= 0);
    }
  }
  assert(depth == 0);
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
  assert_parens_balanced(txt, len);
  assert(contains(txt, len, "global_1018FE198"));
  assert(contains(txt, len, "sub_10116D080"));
  assert(contains(txt, len, "uint64 sub_100ca89cc("));
  assert(contains(txt, len, "return x0;"));
}

void test_adrp_invalidation_and_xzr_and_q_store() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
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
  assert_parens_balanced(txt, len);
  assert(contains(txt, len, "*(uint64 *)((uintptr_t)(x8))"));
  assert(contains(txt, len, "(void)global_"));
  assert(!contains(txt, len, "0ULL = global_"));
  assert(contains(txt, len, "uint128 q0 = 0;"));
  assert(contains(txt, len, " = q0;"));
  assert(contains(txt, len, "*(uint64 *)((uintptr_t)(x9))"));
}

void test_bcond_lslv_asrv_div_sp_prfm_ldnp_fcvtau_cas_csel() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const uint32_t words[] = {
    0x5400006eu,  // b.al +12 (invalid cmp / default cond -> `if (1) goto ...;`)
    0x1ac12000u,  // lslv w0, w0, w1
    0x1ac12400u,  // lsrv w0, w0, w1
    0x9ac12800u,  // asrv x0, x0, x1 (64-bit)
    0x1ac12800u,  // asrv w0, w0, w1 (32-bit)
    0x1ac10800u,  // udiv w0, w0, w1
    0x9ac10c00u,  // sdiv x0, x0, x1
    0x9100401fu,  // add sp, x0, #16
    0xf10043ffu,  // cmp sp, #16 (lhs_is_sp)
    0x9a810000u,  // csel x0, x0, x1, eq
    0x1a9f17e4u,  // cset w4, eq (csinc)
    0x927cedffu,  // and sp, x15, #-16
    0xf9800000u,  // prfm pldl1keep, [x0]
    0xa8410402u,  // ldnp x2, x1, [x0, #16]
    0xa9410400u,  // ldp x0, x1, [x0, #16] (rt==rn aliasing: must load x1 before x0)
    0x1e650003u,  // fcvtau w3, d0
    0xc8a17c02u,  // cas x1, x2, [x0]
    0xd65f03c0u,  // ret
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  assert(hex::decompiler::passes::try_emit_arm64_general(
             words, 18u, 0x100002000ULL, "review_regressions", 18u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert_parens_balanced(txt, len);
  assert(contains(txt, len, "if (!(1)) {"));
  assert(contains(txt, len, "x0 = (uint64)((int64_t)x0 >> (x1 & 63));"));
  assert(contains(txt, len, "x0 = (uint32_t)(((int32_t)x0) >> (x1 & 31));"));
  assert(contains(txt, len, "((uint32_t)x1 != 0 ?"));
  assert(contains(txt, len, "((int64_t)x0 / (int64_t)x1)"));
  assert(contains(txt, len, "sp = x0 + 16;"));
  assert(contains(txt, len, "((__hex_nzcv & 4u) != 0u) ? x0 : x1;"));
  assert(contains(txt, len, "sp = x15 & "));
  assert(contains(txt, len, "x2 = *(uint64 *)((uintptr_t)(x0) + 16);"));
  assert(contains(txt, len, "x1 = *(uint64 *)((uintptr_t)(x0) + 24);\n    x0 = *(uint64 *)((uintptr_t)(x0) + 16);"));
  assert(contains(txt, len, "x3 = (uint32_t)round(d0);"));
  assert(contains(txt, len, "if (__old == (uint64_t)x1)"));
}

void test_self_recursion_and_cross_label_adrp() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  // Self-recursive function with 1 int param + cross-label ADRP invalidation
  const uint32_t words[] = {
    0xb4000080u,  // cbz x0, +16 (label at idx 4)
    0xd1000400u,  // sub x0, x0, #1
    0x97fffffeu,  // bl #0x100001abc (self-call!)
    0x90000008u,  // adrp x8, #0x100001000 (invalidated at label idx 4!)
    0xf9400108u,  // loc_100001ACC: ldr x8, [x8] (must NOT emit global_100001000)
    0xd65f03c0u,  // ret
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  assert(hex::decompiler::passes::try_emit_arm64_general(
             words, 6u, 0x100001abcULL, nullptr, 0u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert_parens_balanced(txt, len);
  assert(!contains(txt, len, "uint64 sub_100001ABC (__HEX_ANY_ARGS);"));
  assert(contains(txt, len, "x0 = sub_100001abc(x0);"));
  assert(!contains(txt, len, "global_100001000"));
  assert(contains(txt, len, "x8 = *(uint64 *)((uintptr_t)(x8));"));
}

void test_guards_oom_and_table_overflow() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;

  const uint32_t tiny_alu[] = { 0x0b010000u, 0xd65f03c0u };
  assert(hex::decompiler::passes::try_emit_arm64_general(
             tiny_alu, 2u, 0x1000ULL, "tiny", 4u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);

  const uint32_t four_words[] = { 0xf9400000u, 0xf900001fu, 0xaa0003e0u, 0xd65f03c0u };
  assert(hex::decompiler::passes::try_emit_arm64_general(
             four_words, 4u, 0x1000ULL, "-[Foo bar]", 10u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);
  assert(hex::decompiler::passes::try_emit_arm64_general(
             four_words, 4u, 0x1000ULL, "123bad", 6u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);
  assert(hex::decompiler::passes::try_emit_arm64_general(
             four_words, 4u, UINT64_MAX - 8ULL, "wrap", 4u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_UNSUPPORTED);

  // Tiny arena -> HEX_ERR_OOM
  alignas(16) uint8_t tiny_buf[64];
  hex::Arena tiny_arena;
  tiny_arena.init_fixed(tiny_buf, sizeof(tiny_buf));
  assert(hex::decompiler::passes::try_emit_arm64_general(
             four_words, 4u, 0x1000ULL, "oom", 3u, 0u, tiny_arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_OOM);

  // Exceeding kMaxCallees (2048) -> HEX_ERR_RESOURCE_LIMIT
  static uint8_t big_buf[1536u * 1024u];
  hex::Arena big_arena;
  big_arena.init_fixed(big_buf, sizeof(big_buf));
  static uint32_t many_calls[2060];
  for (uint32_t i = 0u; i < 2059u; ++i) {
    many_calls[i] = 0x94000000u | ((0x1000u + i * 2u) & 0x03FFFFFFu);
  }
  many_calls[2059] = 0xd65f03c0u;
  big_arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_general(
             many_calls, 2060u, 0x100000000ULL, "many_calls", 10u, 0u,
             big_arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_RESOURCE_LIMIT);

  // Exceeding kMaxGlobals (2048) -> HEX_ERR_RESOURCE_LIMIT
  static uint32_t many_globals[2060];
  many_globals[0] = 0x90000008u;  // adrp x8, #0x100000000
  for (uint32_t i = 0u; i < 2058u; ++i) {
    // ldr x9, [x8, #(i * 8)]
    many_globals[1u + i] = 0xf9400109u | ((i & 0xFFFu) << 10u);
  }
  many_globals[2059] = 0xd65f03c0u;
  big_arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_general(
             many_globals, 2060u, 0x100000000ULL, "many_globals", 12u, 0u,
             big_arena, &txt, &len, &lm, &lm_cnt) == HEX_ERR_RESOURCE_LIMIT);

  // Trailing label before '}' emits valid C11 `(void)0;`
  const uint32_t trailing_nop[] = { 0xb4000060u, 0xd2800020u, 0xd65f03c0u, 0xd503201fu };
  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_general(
             trailing_nop, 4u, 0x1000ULL, "trail", 5u, 0u, arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert_parens_balanced(txt, len);
  assert(contains(txt, len, "if (x0 != 0) {"));
  assert(contains(txt, len, "    (void)0;\n}"));
}

}  // namespace


void test_sparse_self_recursion_and_trailing_fallback_label() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  // Sparse param x2 (x1 unused) + self-recursive BL + trailing label before CAS fallback
  const uint32_t words[] = {
    0xb4000062u,  // cbz x2, +12 (targets idx 3 CAS fallback at end!)
    0xd1000442u,  // sub x2, x2, #1
    0x97fffffeu,  // bl self
    0x04000000u,  // loc_10000100C: unallocated -> must emit `(void)0; /* arm64 insn ... */`
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  assert(hex::decompiler::passes::try_emit_arm64_general(
             words, 4u, 0x100001000ULL, nullptr, 0u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert_parens_balanced(txt, len);
  assert(contains(txt, len, "    sub_100001000(x0, a2, x2);"));
  assert(contains(txt, len, "if (x2 != 0) {"));
  assert(contains(txt, len, "    (void)0; /* arm64 insn 0x4000000 */\n}"));
}


void test_wave23_instructions_and_pass_sync() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const uint32_t words[] = {
    0x7ea2d420u,  // fabd s0, s1, s2
    0x1e260003u,  // fmov w3, s0
    0x1e270064u,  // fmov s4, w3
    0x1e64c0a5u,  // frintp d5, d5
    0x7a1f00c6u,  // sbcs w6, w6, wzr
    0x0ea008e7u,  // rev64 v7.2s, v7.2s
    0x8b29c908u,  // add x8, x8, w9, sxtw #2
    0xd65f03c0u,  // ret
  };
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;
  assert(hex::decompiler::passes::try_emit_arm64_general(
             words, 8u, 0x2000ULL, "wave23_ops", 10u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert_parens_balanced(txt, len);
  assert(contains(txt, len, "extern double sqrt(double);"));
  assert(contains(txt, len, "__hex_f32_to_u32"));
  assert(contains(txt, len, "__hex_u32_to_f32"));
  assert(contains(txt, len, "ceil(d5)"));
  assert(contains(txt, len, "__ca > __cb"));
  assert(contains(txt, len, "__rv >> 32"));
  assert(contains(txt, len, "(int64_t)(int32_t)x9"));

  arena.reset();
  const uint32_t sync_words[] = {
    0x90000000u,  // adrp x0, #0x1000
    0x94000010u,  // bl +0x40
    0xb4000041u,  // cbz x1, +8 (targets idx 4 -> loc_1010 after RET!)
    0xd65f03c0u,  // ret
    0x91004000u,  // loc_1010: add x0, x0, #0x10 (must NOT emit undeclared global_1010)
    0xd65f03c0u,  // ret
  };
  assert(hex::decompiler::passes::try_emit_arm64_general(
             sync_words, 6u, 0x1000ULL, "adrp_bl_sync", 12u, 0u,
             arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
  assert_parens_balanced(txt, len);
  assert(!contains(txt, len, "global_1010"));
}


void test_wave25_neon_fmov_1word_and_structurizer() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  // 1. 1-word RET
  {
    const uint32_t w1[] = { 0xD65F03C0u };
    const char* txt = nullptr; uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr; uint32_t lm_cnt = 0u;
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w1, 1u, 0x100004D3CULL, "ret_only", 8u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
  }
  // 2. Scalar FMOV #imm8 (2-word stub)
  {
    arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
    const uint32_t w2[] = { 0x1E2E1000u, 0xD65F03C0u };  // fmov s0, #1.0; ret
    const char* txt = nullptr; uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr; uint32_t lm_cnt = 0u;
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w2, 2u, 0x100004E00ULL, "fmov_imm", 8u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "d0 = "));
  }
  // 3. NEON vector suite + structured do-while loop (0 gotos)
  {
    arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
    const uint32_t w3[] = {
      0x4F000421u,  // movi v1.4s, #1
      0x6F038402u,  // mvni v2.8h, #0x60
      0x4EA18400u,  // add v0.4s, v0.4s, v1.4s
      0x6E611CE4u,  // bsl v4.16b, v7.16b, v1.16b
      0x6EA08C40u,  // cmeq v0.4s, v2.4s, v0.4s
      0x4EB1B800u,  // addv s0, v0.4s
      0x5EF1B8A0u,  // addp d0, v5.2d
      0x4CDF8820u,  // ld2 {v0.4s, v1.4s}, [x1], #32
      0x6EA5D421u,  // fabd v1.4s, v1.4s, v5.4s
      0x6E218822u,  // frinta v2.4s, v1.4s
      0x4EA1B800u,  // fcvtzs v0.4s, v0.4s
      0x0E617820u,  // fcvtl v0.2d, v1.2s
      0xD1000400u,  // sub x0, x0, #1
      0xB5FFFEA0u,  // cbnz x0, -44 (back to idx 2 -> do { ... } while)
      0xD65F03C0u,  // ret
    };
    const char* txt = nullptr; uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr; uint32_t lm_cnt = 0u;
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w3, 15u, 0x100005000ULL, "neon_loop", 9u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "do {"));
    assert(contains(txt, len, "} while ("));
    assert(!contains(txt, len, "goto loc_"));
  }
  // 4. Regression checks: AdvSIMD ORR/BIC imm, SSHR #32 no-UB, invalid FMOV/DUP fallthrough
  {
    arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
    const uint32_t w4[] = {
      0x4F001420u,  // orr v0.4s, #0x1
      0x6F001420u,  // bic v0.4s, #0x1
      0x4F200420u,  // sshr v0.4s, v1.4s, #32 (must NOT emit `>> 32`)
      0x9E2E13E0u,  // unallocated FMOV-like word -> fallback comment
      0x0E080420u,  // unallocated DUP Q=0 tz=3 -> fallback comment
      0xD65F03C0u,  // ret
    };
    const char* txt = nullptr; uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr; uint32_t lm_cnt = 0u;
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w4, 6u, 0x100006000ULL, "round2_reg", 10u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "q0 = q0 | "));
    assert(contains(txt, len, "q0 = q0 & ~"));
    assert(!contains(txt, len, ">> 32"));
    assert(contains(txt, len, "/* arm64 insn 0x9E2E13E0 */"));
    assert(contains(txt, len, "/* arm64 insn 0xE080420 */"));
  }
  // 5. Intra-block write-then-read liveness: must NOT infer spurious arguments
  {
    arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
    const uint32_t w5[] = {
      0xD2800020u,  // mov x0, #1
      0x91000801u,  // add x1, x0, #2
      0xB4000041u,  // cbz x1, +8
      0xD2800060u,  // mov x0, #3
      0xD65F03C0u,  // ret
    };
    const char* txt = nullptr; uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr; uint32_t lm_cnt = 0u;
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w5, 5u, 0x100007000ULL, "zero_arg_fn", 11u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "uint64 zero_arg_fn(void)"));
  }
}

void test_wave26_structurizer_and_stubs() {
  static uint8_t buf[1536 * 1024];
  hex::Arena arena;
  arena.init_fixed(buf, sizeof(buf));

  // (a) Short-circuit || merge (Rule 7) + multi-statement tail return (Rule 5)
  // if (x0 == 0) goto L_ret; if (x1 == 0) goto L_ret; x0 = x0 + x1; return x0;
  // L_ret: x0 = 1; x0 = x0 + 2; return x0;
  {
    arena.reset();
    const uint32_t w[] = {
        0xb40000a0u,  // 0x00: cbz x0, +20 (0x14)
        0xb4000081u,  // 0x04: cbz x1, +16 (0x14)
        0x8b010000u,  // 0x08: add x0, x0, x1
        0xd65f03c0u,  // 0x0c: ret
        0xd503201fu,  // 0x10: nop (keeps L_ret non-fallthrough)
        0xd2800020u,  // 0x14: movz x0, #1
        0x91000800u,  // 0x18: add x0, x0, #2
        0xd65f03c0u,  // 0x1c: ret
    };
    const char* txt = nullptr; uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr; uint32_t lm_cnt = 0u;
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 8u, 0x100008000ULL, "short_circuit_ret", 17u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "||"));
    assert(!contains(txt, len, "goto "));
  }

  // (b) Loop with continue (Rule 8) + multi-entry do-while (Rule 2)
  // 0x00: cbz x0, +24 (0x18 -> loop_hdr)  -- creates a 2nd ref to loop_hdr
  // 0x04: add x0, x0, #1
  // 0x08: L_hdr: subs x0, x0, #1
  // 0x0c: cbz x1, +8 (0x14 -> L_cont)
  // 0x10: add x2, x2, #1
  // 0x14: L_cont: cbnz x0, -12 (0x08 -> L_hdr)
  // 0x18: ret
  {
    arena.reset();
    const uint32_t w[] = {
        0xb4000040u,  // 0x00: cbz x0, +8 (0x08 -> L_hdr)
        0x91000400u,  // 0x04: add x0, x0, #1
        0xf1000400u,  // 0x08: L_hdr: subs x0, x0, #1
        0xb4000041u,  // 0x0c: cbz x1, +8 (0x14 -> L_cont)
        0x91000442u,  // 0x10: add x2, x2, #1
        0xb5ffffa0u,  // 0x14: L_cont: cbnz x0, -12 (0x08 -> L_hdr)
        0xd65f03c0u,  // 0x18: ret
    };
    const char* txt = nullptr; uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr; uint32_t lm_cnt = 0u;
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 7u, 0x100009000ULL, "multi_entry_loop", 16u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "do {"));
    assert(contains(txt, len, "} while ("));
  }

  // (c) 2-word and 3-word real stubs (previously rejected by word_count < 4u)
  {
    arena.reset();
    const uint32_t w2[2] = {0xd2800540u, 0xd65f03c0u};  // movz x0, #42; ret
    const char* txt = nullptr; uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr; uint32_t lm_cnt = 0u;
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w2, 2u, 0x10000a000ULL, "stub2", 5u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert((contains(txt, len, "42") || contains(txt, len, "0x2a")) && contains(txt, len, "return "));
  }
}


void test_wave27_fixes_insns_and_structurizer_v3() {
  static uint8_t buf[1536u * 1024u];
  hex::Arena arena;
  arena.init_fixed(buf, sizeof(buf));
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;

  // (1) REV64.2S phase-ordering fix: rev64 v1.2s, v0.2s followed by 128-bit NEON on v0 only (v1 never marked q)
  {
    arena.reset();
    const uint32_t w[] = {
      0x0EA00801u,  // rev64 v1.2s, v0.2s
      0x4EA01C00u,  // mov v0.16b, v0.16b (marks q0 only, NOT q1)
      0xD65F03C0u,  // ret
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 3u, 0x100010000ULL, "rev64_phase", 11u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "double d1"));
    assert(!contains(txt, len, "q1 = "));
    assert(contains(txt, len, "__rv >> 32"));
  }

  // (2) LDPSW + FMAX + FNMUL + SBFX + FCSEL + SMULH + UMULH + RETAA + RETAB
  {
    arena.reset();
    const uint32_t w[] = {
      0x69410C02u,  // ldpsw x2, x3, [x0, #8]
      0x1E624820u,  // fmax d0, d1, d2
      0x1E628823u,  // fnmul d3, d1, d2
      0x93442C24u,  // sbfx x4, x1, #4, #8 (immr=4, imms=11)
      0xEB03005Fu,  // cmp x2, x3
      0x1E630C00u,  // fcsel d0, d0, d3, eq
      0x9B427C25u,  // smulh x5, x1, x2
      0x9BC27C26u,  // umulh x6, x1, x2
      0xB4000040u,  // cbz x0, +8 -> retaa
      0xD65F0FFFu,  // retab
      0xD65F0BFFu,  // retaa
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 11u, 0x100011000ULL, "wave27_insns", 12u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "(uint64)(int64_t)*(int32_t *)"));
    assert(contains(txt, len, "(d1 > d2 ? d1 : d2)"));
    assert(contains(txt, len, "-(d1 * d2)"));
    assert(contains(txt, len, "(int64_t)(((uint64_t)x1 >> 4) << 56)) >> 56"));
    assert(contains(txt, len, " ? d0 : d3;"));
    assert(contains(txt, len, "(__int128)(int64_t)x1 * (__int128)(int64_t)x2) >> 64"));
    assert(contains(txt, len, "(uint128)(uint64_t)x1 * (uint128)(uint64_t)x2) >> 64"));
    assert(contains(txt, len, "return "));
    assert(!contains(txt, len, "/* arm64 insn"));
  }

  // (3) Long symbol names (>128 chars and >512 chars safely truncated, not HEX_ERR_UNSUPPORTED)
  {
    arena.reset();
    char name200[201];
    name200[0] = 'f';
    for (uint32_t i = 1u; i < 200u; ++i) name200[i] = 'a';
    name200[200] = '\0';
    const uint32_t w[] = { 0xD2800020u, 0xD65F03C0u };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 2u, 0x100012000ULL, name200, 200u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert(contains(txt, len, name200));

    arena.reset();
    char name600[601];
    name600[0] = 'g';
    for (uint32_t i = 1u; i < 600u; ++i) name600[i] = 'b';
    name600[600] = '\0';
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 2u, 0x100012100ULL, name600, 600u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
  }

  // (4) Structurizer Rule 0b (fallthrough goto deleted) + Rule 0c (DCE after unconditional return)
  {
    arena.reset();
    const uint32_t w[] = {
      0x14000001u,  // 0x00: b +4 (fallthrough to next insn -> Rule 0b deletes!)
      0xD2800020u,  // 0x04: loc_...: mov x0, #1
      0xD65F03C0u,  // 0x08: ret
      0xD2800FA0u,  // 0x0c: mov x0, #125 (unreachable dead code -> Rule 0c deletes!)
      0xD65F03C0u,  // 0x10: ret (unreachable)
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 5u, 0x100013000ULL, "rule_0b_0c", 10u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(!contains(txt, len, "goto "));
    assert(!contains(txt, len, "0x7D"));
    assert(!contains(txt, len, "125"));
  }

  // (5) Structurizer Rule 4b / 4c: multi-level if/else block-exit conditional skip
  {
    arena.reset();
    const uint32_t w[] = {
      0xB40000E0u,  // 0x00: cbz x0, +28 (0x1c -> L_end)
      0xB40000C1u,  // 0x04: cbz x1, +24 (0x1c -> L_end)
      0xB40000A2u,  // 0x08: cbz x2, +20 (0x1c -> L_end)
      0x91000400u,  // 0x0c: add x0, x0, #1
      0xB4000063u,  // 0x10: cbz x3, +12 (0x1c -> L_end)
      0x91000800u,  // 0x14: add x0, x0, #2
      0x91000C00u,  // 0x18: add x0, x0, #3
      0xD65F03C0u,  // 0x1c: L_end: ret
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 8u, 0x100014000ULL, "rule_4b_4c", 10u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(!contains(txt, len, "goto "));
  }

  // (6) Structurizer Rule 5b: single-ref cold tail-block inlining
  {
    arena.reset();
    const uint32_t w[] = {
      0xB40000C0u,  // 0x00: cbz x0, +24 (0x18 -> L_cold)
      0x91000400u,  // 0x04: add x0, x0, #1
      0x91000800u,  // 0x08: L_join: add x0, x0, #2
      0x91000C00u,  // 0x0c: add x0, x0, #3
      0xD65F03C0u,  // 0x10: ret
      0xD65F03C0u,  // 0x14: ret (terminator before L_cold)
      0xD28000E0u,  // 0x18: L_cold: mov x0, #7
      0x91001000u,  // 0x1c: add x0, x0, #4
      0x17FFFFFBu,  // 0x20: b -20 (0x08 -> L_join)
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 9u, 0x100015000ULL, "rule_5b_cold", 12u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "x0 = 7;"));
    assert(!contains(txt, len, "loc_100015018"));
  }

  // (7) Structurizer Rule 8: explicit `continue;` assertion inside a loop (including after an inner loop)
  {
    arena.reset();
    const uint32_t w[] = {
      0xF1000400u,  // 0x00: L_outer: subs x0, x0, #1
      0xD1000421u,  // 0x04: L_inner: sub x1, x1, #1
      0xB5FFFFE1u,  // 0x08: cbnz x1, -4 (0x04 -> L_inner)
      0xB4000042u,  // 0x0c: cbz x2, +8 (0x14 -> L_cont)
      0x91000463u,  // 0x10: add x3, x3, #1
      0xB5FFFF60u,  // 0x14: L_cont: cbnz x0, -20 (0x00 -> L_outer)
      0xD65F03C0u,  // 0x18: ret
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 7u, 0x100016000ULL, "rule_8_continue", 15u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "continue;"));
    assert(!contains(txt, len, "goto "));
  }
}


void test_wave29_structurizer_v4_and_wall_cleanup() {
  static uint8_t buf[1536u * 1024u];
  static uint8_t scratch_buf[1536u * 1024u];
  hex::Arena arena;
  hex::Arena scratch;
  arena.init_fixed(buf, sizeof(buf));
  scratch.init_fixed(scratch_buf, sizeof(scratch_buf));
  const char* txt = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_cnt = 0u;

  // (1) V4-1: Structured-`if` tail-`goto` -> `if (...) { ... } else { ... }` (0 gotos)
  {
    arena.reset();
    const uint32_t w[] = {
      0xB40000C0u,  // 0x00: cbz x0, +24 (0x18 -> L_cold)
      0x91000400u,  // 0x04: add x0, x0, #1
      0x91000800u,  // 0x08: L_join: add x0, x0, #2
      0x91000C00u,  // 0x0c: add x0, x0, #3
      0xD65F03C0u,  // 0x10: ret
      0xD65F03C0u,  // 0x14: ret (terminator before L_cold)
      0xD28000E0u,  // 0x18: L_cold: mov x0, #7
      0x91001000u,  // 0x1c: add x0, x0, #4
      0x17FFFFFBu,  // 0x20: b -20 (0x08 -> L_join)
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 9u, 0x100020000ULL, "v4_if_else", 10u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "} else {"));
    assert(!contains(txt, len, "goto "));
  }

  // (2) V4-2: Generalized single-ref cold tail-block with inner `if-goto` and internal label
  {
    arena.reset();
    const uint32_t w[] = {
      0xB40000A0u,  // 0x00: cbz x0, +20 (0x14 -> L_cold)
      0x91000400u,  // 0x04: add x0, x0, #1
      0x91000800u,  // 0x08: L_join: add x0, x0, #2
      0xD65F03C0u,  // 0x0c: ret
      0xD65F03C0u,  // 0x10: ret (terminator before L_cold)
      0x91000421u,  // 0x14: L_cold: add x1, x1, #1
      0xB4000041u,  // 0x18: cbz x1, +8 (0x20 -> L_inner)
      0x91002800u,  // 0x1c: add x0, x0, #10
      0x91005000u,  // 0x20: L_inner: add x0, x0, #20
      0x17FFFFF9u,  // 0x24: b -28 (0x08 -> L_join)
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 10u, 0x100021000ULL, "v4_cold_inner_if", 16u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "x0 = x0 + 10;"));
    assert(contains(txt, len, "x0 = x0 + 20;"));
    assert(contains(txt, len, "} else {"));
    assert(!contains(txt, len, "goto "));
  }

  // (3) V4-3: GCC pre-header alt-branch loop rotation (`goto L_hdr; L_alt: ... L_hdr: do { ... if (C) goto L_alt; ... } while (...)`)
  {
    arena.reset();
    const uint32_t w[] = {
      0x14000004u,  // 0x00: b +16 (0x10 -> L_hdr)
      0x91000442u,  // 0x04: L_alt: add x2, x2, #1
      0x91000863u,  // 0x08: add x3, x3, #2
      0xB40000A3u,  // 0x0c: cbz x3, +20 (0x20 -> L_exit)
      0xF1000400u,  // 0x10: L_hdr: subs x0, x0, #1
      0xB4FFFF81u,  // 0x14: cbz x1, -16 (0x04 -> L_alt)
      0x91000484u,  // 0x18: add x4, x4, #1
      0xB5FFFFA0u,  // 0x1c: cbnz x0, -12 (0x10 -> L_hdr)
      0xD65F03C0u,  // 0x20: L_exit: ret
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 9u, 0x100022000ULL, "v4_loop_rotate", 14u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "while (1) {"));
    assert(contains(txt, len, "continue;"));
    assert(contains(txt, len, "break;"));
    assert(!contains(txt, len, "goto "));
  }

  // (4) V4-0: Tight emit_arena + separate work_arena (zero extra emit_arena consumption during structurization)
  {
    // text_cap = 131072 + lm_cap = 4096 * sizeof(HexLineMapEntry) = 4096 * 16 = 65536 => ~196608 bytes
    static uint8_t tight_emit_buf[200u * 1024u];
    hex::Arena tight_emit;
    tight_emit.init_fixed(tight_emit_buf, sizeof(tight_emit_buf));
    scratch.reset();
    hex::decompiler::passes::set_general_scratch_arena(&scratch);
    const uint32_t w[] = {
      0xB4000040u,  // cbz x0, +8
      0x91000400u,  // add x0, x0, #1
      0xD65F03C0u,  // ret
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 3u, 0x100023000ULL, "v4_tight_arena", 14u, 0u,
               tight_emit, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    hex::decompiler::passes::set_general_scratch_arena(nullptr);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "if (x0 == 0) return x0;"));
    assert(!contains(txt, len, "goto "));
  }

  // (5) Part 2: C11 -Wall cleanup: `__attribute__((unused))` on FP bitcast helpers & no FP self-copy `d0 = d0;`
  {
    arena.reset();
    const uint32_t w[] = {
      0x1E260003u,  // fmov w3, s0 (triggers uses_fp_bitcast)
      0x1E604000u,  // fmov d0, d0 (self-copy: must be suppressed!)
      0x1E604020u,  // fmov d0, d1 (non-self-copy: must still emit `d0 = d1;`)
      0xD65F03C0u,  // ret
    };
    assert(hex::decompiler::passes::try_emit_arm64_general(
               w, 4u, 0x100024000ULL, "v4_wall_cleanup", 15u, 0u,
               arena, &txt, &len, &lm, &lm_cnt) == HEX_OK);
    assert_parens_balanced(txt, len);
    assert(contains(txt, len, "__attribute__((unused))"));
    assert(contains(txt, len, "static inline __HEX_UNUSED float __hex_u32_to_f32"));
    assert(contains(txt, len, "static inline __HEX_UNUSED double __hex_u64_to_f64"));
    assert(contains(txt, len, "static inline __HEX_UNUSED uint32_t __hex_f32_to_u32"));
    assert(contains(txt, len, "static inline __HEX_UNUSED uint64_t __hex_f64_to_u64"));
    assert(!contains(txt, len, "d0 = d0;"));
    assert(contains(txt, len, "d0 = d1;"));
  }
}

int main() {
  test_frame_adrp_bl_ret();
  test_adrp_invalidation_and_xzr_and_q_store();
  test_bcond_lslv_asrv_div_sp_prfm_ldnp_fcvtau_cas_csel();
  test_self_recursion_and_cross_label_adrp();
  test_guards_oom_and_table_overflow();
  test_sparse_self_recursion_and_trailing_fallback_label();
  test_wave23_instructions_and_pass_sync();
  test_wave25_neon_fmov_1word_and_structurizer();
  test_wave26_structurizer_and_stubs();
  test_wave27_fixes_insns_and_structurizer_v3();
  test_wave29_structurizer_v4_and_wall_cleanup();
  std::puts("test_arm64_general_emit_native: PASS");
  return 0;
}
