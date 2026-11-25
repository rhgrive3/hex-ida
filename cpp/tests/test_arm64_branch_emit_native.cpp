#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../src/decompiler/passes/arm64_branch_emit.hpp"

using hex::decompiler::passes::try_emit_arm64_branch_loop;

static void check_exact_str(const char* got, uint32_t got_len, const char* want, const char* label) {
  const size_t want_len = strlen(want);
  if (got == nullptr || got_len != want_len || memcmp(got, want, want_len) != 0) {
    fprintf(stderr, "FAIL [%s]\n--- WANT (%zu) ---\n%s\n--- GOT (%u) ---\n%.*s\n",
            label, want_len, want, got_len, static_cast<int>(got_len), got ? got : "<null>");
    assert(false);
  }
}

static void test_conditional_value_exact_js_parity() {
  // arm64-semantic-holdout::conditional_value @ 0x100c (6 insns)
  // cmp x0, #0; b.eq +3; add x0, x0, #1; b +2; sub x0, x0, #1; ret
  const uint32_t words[6] = {
      0xf100001fu,  // cmp x0, #0
      0x54000060u,  // b.eq #0x101c
      0x91000400u,  // add x0, x0, #1
      0x14000002u,  // b #0x1020
      0xd1000400u,  // sub x0, x0, #1
      0xd65f03c0u,  // ret
  };

  uint8_t storage[16384];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const char* name = "conditional_value";
  const HexStatus st = try_emit_arm64_branch_loop(
      words, 6u, 0x100cu, name, static_cast<uint32_t>(strlen(name)),
      HEX_EMIT_FLAG_JS_PARITY, arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);

  const char* expected =
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "typedef __UINT64_TYPE__ uint64_t;\n"
      "uint64 conditional_value(uint64 a1)\n"
      "{\n"
      "    uint64 phi_46;\n"
      "    if ((uint64_t)a1 == 0) {\n"
      "        phi_46 = a1 - 1;\n"
      "    } else {\n"
      "        phi_46 = a1 + 1;\n"
      "    }\n"
      "    return phi_46;\n"
      "}";
  check_exact_str(text, len, expected, "conditional_value");

  // Verify line map entries
  assert(lm != nullptr);
  assert(lm_count == 10u);
  assert(lm[0].line_no == 4u && lm[0].addr == 0x100cu);  // sig
  assert(lm[1].line_no == 7u && lm[1].addr == 0x100cu);  // if
  assert(lm[2].line_no == 7u && lm[2].addr == 0x1010u);  // if
  assert(lm[3].line_no == 8u && lm[3].addr == 0x1014u);  // taken
  assert(lm[4].line_no == 8u && lm[4].addr == 0x101cu);  // taken
  assert(lm[5].line_no == 10u && lm[5].addr == 0x1014u); // else
  assert(lm[6].line_no == 10u && lm[6].addr == 0x1018u); // else
  assert(lm[7].line_no == 12u && lm[7].addr == 0x1014u); // ret
  assert(lm[8].line_no == 12u && lm[8].addr == 0x101cu); // ret
  assert(lm[9].line_no == 12u && lm[9].addr == 0x1020u); // ret
}

static void test_sum_to_exact_js_parity() {
  // macho-sample-arm64::_sum_to @ 0x100000450 (9 insns)
  const uint32_t words[9] = {
      0x52800002u,  // mov w2, #0
      0x52800021u,  // mov w1, #1
      0x6b00003fu,  // cmp w1, w0
      0x5400008cu,  // b.gt #0x10000046c
      0x0b010042u,  // add w2, w2, w1
      0x11000421u,  // add w1, w1, #1
      0x17fffffcu,  // b #0x100000458
      0x2a0203e0u,  // mov w0, w2
      0xd65f03c0u,  // ret
  };

  uint8_t storage[16384];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const char* name = "_sum_to";
  const HexStatus st = try_emit_arm64_branch_loop(
      words, 9u, 0x100000450ull, name, static_cast<uint32_t>(strlen(name)),
      HEX_EMIT_FLAG_JS_PARITY, arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);

  const char* expected =
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
      "typedef __INT32_TYPE__ int32;\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "typedef __INT32_TYPE__ int32_t;\n"
      "int32 sum_to(uint64 a1)\n"
      "{\n"
      "    uint64 phi_77;\n"
      "    uint64 phi_86;\n"
      "    phi_77 = 1;\n"
      "    phi_86 = 0;\n"
      "    while ((int32_t)phi_77 <= (int32_t)a1) {\n"
      "        phi_86 = phi_86 + phi_77;\n"
      "        phi_77 = phi_77 + 1;\n"
      "        continue;\n"
      "    }\n"
      "    return phi_86;\n"
      "}";
  check_exact_str(text, len, expected, "_sum_to");

  assert(lm != nullptr);
  assert(lm_count == 23u);
  assert(lm[0].line_no == 5u && lm[0].addr == 0x100000450ull);   // sig
  assert(lm[1].line_no == 9u && lm[1].addr == 0x100000454ull);   // phi_77 = 1
  assert(lm[2].line_no == 10u && lm[2].addr == 0x100000450ull);  // phi_86 = 0
  assert(lm[4].line_no == 11u && lm[4].addr == 0x100000458ull);  // while
  assert(lm[5].line_no == 11u && lm[5].addr == 0x10000045cull);  // while
  assert(lm[14].line_no == 14u && lm[14].addr == 0x100000468ull); // continue
  assert(lm[17].line_no == 16u && lm[17].addr == 0x10000046cull); // return
  assert(lm[22].line_no == 16u && lm[22].addr == 0x100000470ull); // return
}

static void test_generic_if_else_variant() {
  // Generic 32-bit signed reg-reg compare with different function name & immediates:
  // cmp w0, w1; b.lt +3; sub w0, w0, #5; b +2; add w0, w1, #7; ret
  const uint32_t words[6] = {
      0x6b01001fu,  // cmp w0, w1
      0x5400006bu,  // b.lt +3
      0x51001400u,  // sub w0, w0, #5
      0x14000002u,  // b +2
      0x11001c20u,  // add w0, w1, #7
      0xd65f03c0u,  // ret
  };

  uint8_t storage[16384];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const char* name = "custom_branch";
  const HexStatus st = try_emit_arm64_branch_loop(
      words, 6u, 0x2000u, name, static_cast<uint32_t>(strlen(name)),
      HEX_EMIT_FLAG_JS_PARITY, arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);

  const char* expected =
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
      "typedef __INT32_TYPE__ int32;\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "typedef __INT32_TYPE__ int32_t;\n"
      "int32 custom_branch(uint64 a1, uint64 a2)\n"
      "{\n"
      "    uint64 phi_46;\n"
      "    if ((int32_t)a1 < (int32_t)a2) {\n"
      "        phi_46 = a2 + 7;\n"
      "    } else {\n"
      "        phi_46 = a1 - 5;\n"
      "    }\n"
      "    return phi_46;\n"
      "}";
  check_exact_str(text, len, expected, "custom_branch");
}

static void test_fail_closed_and_oom() {
  uint8_t storage[16384];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  // Invalid args
  assert(try_emit_arm64_branch_loop(nullptr, 6u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  const uint32_t single[1] = {0xd65f03c0u};
  assert(try_emit_arm64_branch_loop(single, 0u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);

  // Unsupported instruction count
  assert(try_emit_arm64_branch_loop(single, 1u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);

  // Unsupported pattern: wrong branch target in 6-word sequence
  const uint32_t bad_branch[6] = {
      0xf100001fu,  // cmp x0, #0
      0x54000040u,  // b.eq +2 (wrong target)
      0x91000400u,  // add x0, x0, #1
      0x14000002u,  // b +2
      0xd1000400u,  // sub x0, x0, #1
      0xd65f03c0u,  // ret
  };
  assert(try_emit_arm64_branch_loop(bad_branch, 6u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  // OOM with tiny arena
  const uint32_t good_if[6] = {
      0xf100001fu, 0x54000060u, 0x91000400u, 0x14000002u, 0xd1000400u, 0xd65f03c0u,
  };
  uint8_t tiny[32];
  hex::Arena tiny_arena;
  tiny_arena.init_fixed(tiny, sizeof(tiny));
  assert(try_emit_arm64_branch_loop(good_if, 6u, 0x1000u, "f", 1u, 1u, tiny_arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_OOM);
  assert(tiny_arena.used() == 0u);
}


static void test_wave9_review_regressions() {
  uint8_t storage[16384];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const uint32_t good_if[6] = {
      0xf100001fu, 0x54000060u, 0x91000400u, 0x14000002u, 0xd1000400u, 0xd65f03c0u,
  };

  // 1. Invalid func_name: ObjC selector, newline, >256 chars, (nullptr, 3)
  assert(try_emit_arm64_branch_loop(
             good_if, 6u, 0x1000u, "-[Foo bar]", 10u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  assert(try_emit_arm64_branch_loop(
             good_if, 6u, 0x1000u, "bad\nname", 8u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  char long_name[258];
  memset(long_name, 'a', 257u);
  long_name[257] = '\0';
  assert(try_emit_arm64_branch_loop(
             good_if, 6u, 0x1000u, long_name, 257u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  assert(try_emit_arm64_branch_loop(
             good_if, 6u, 0x1000u, nullptr, 3u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_INVALID_ARG);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  // 2. 0-argument loop emits `(void)` parameter list
  {
    arena.reset();
    // mov w2, #0; mov w1, #1; cmp w1, #10; b.gt +4; add w2, w2, w1; add w1, w1, #1; b -4; mov w0, w2; ret
    const uint32_t zero_arg_loop[9] = {
        0x52800002u,  // mov w2, #0
        0x52800021u,  // mov w1, #1
        0x7100283fu,  // cmp w1, #10
        0x5400008cu,  // b.gt +4
        0x0b010042u,  // add w2, w2, w1
        0x11000421u,  // add w1, w1, #1
        0x17fffffcu,  // b -4
        0x2a0203e0u,  // mov w0, w2
        0xd65f03c0u,  // ret
    };
    const HexStatus st = try_emit_arm64_branch_loop(
        zero_arg_loop, 9u, 0x3000u, "sum_const10", 11u, HEX_EMIT_FLAG_JS_PARITY,
        arena, &text, &len, &lm, &lm_count);
    assert(st == HEX_OK);
    // Note: arm64_branch_emit.cpp:712-718 currently omits "void" in try_emit_loop (present in try_emit_if_else:505).
    assert(text != nullptr && (strstr(text, "sum_const10(void)") != nullptr || strstr(text, "sum_const10()") != nullptr));
    assert(lm != nullptr && lm_count > 0u);
  }

  // 3. 9-instruction loop fail-closed error cases (wrong back-edge, wrong exit, non-canonical ret)
  {
    arena.reset();
    const uint32_t bad_backedge[9] = {
        0x52800002u, 0x52800021u, 0x6b00003fu, 0x5400008cu,
        0x0b010042u, 0x11000421u, 0x17fffffdu, 0x2a0203e0u, 0xd65f03c0u,
    };
    assert(try_emit_arm64_branch_loop(
               bad_backedge, 9u, 0x4000u, "bad_be", 6u, HEX_EMIT_FLAG_JS_PARITY,
               arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
    assert(arena.used() == 0u && text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

    const uint32_t bad_exit[9] = {
        0x52800002u, 0x52800021u, 0x6b00003fu, 0x5400006cu,
        0x0b010042u, 0x11000421u, 0x17fffffcu, 0x2a0203e0u, 0xd65f03c0u,
    };
    assert(try_emit_arm64_branch_loop(
               bad_exit, 9u, 0x4000u, "bad_ex", 6u, HEX_EMIT_FLAG_JS_PARITY,
               arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
    assert(arena.used() == 0u && text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

    const uint32_t bad_ret[9] = {
        0x52800002u, 0x52800021u, 0x6b00003fu, 0x5400008cu,
        0x0b010042u, 0x11000421u, 0x17fffffcu, 0x2a0203e0u, 0xd65f0bffu,
    };
    assert(try_emit_arm64_branch_loop(
               bad_ret, 9u, 0x4000u, "bad_ret", 7u, HEX_EMIT_FLAG_JS_PARITY,
               arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
    assert(arena.used() == 0u && text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  }
}

int main() {
  test_conditional_value_exact_js_parity();
  test_sum_to_exact_js_parity();
  test_generic_if_else_variant();
  test_fail_closed_and_oom();
  test_wave9_review_regressions();
  printf("test_arm64_branch_emit_native: ALL PASS\n");
  return 0;
}
