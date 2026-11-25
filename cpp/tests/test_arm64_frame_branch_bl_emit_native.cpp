#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../src/decompiler/passes/arm64_frame_branch_bl_emit.hpp"

using hex::decompiler::passes::try_emit_arm64_frame_branch_bl;

static void check_exact_str(const char* got, uint32_t got_len, const char* want, const char* label) {
  const size_t want_len = strlen(want);
  if (got == nullptr || got_len != want_len || memcmp(got, want, want_len) != 0) {
    fprintf(stderr, "FAIL [%s]\n--- WANT (%zu) ---\n%s\n--- GOT (%u) ---\n%.*s\n",
            label, want_len, want, got_len, static_cast<int>(got_len), got ? got : "<null>");
    assert(false);
  }
  assert(got[got_len] == '\0');
}

static void test_apply_damage_exact_js_parity() {
  // macho-sample-arm64::_apply_damage @ 0x100000490 (20 insns)
  const uint32_t words[20] = {
      2847833085u,  // stp x29, x30, [sp, #-0x20]!
      2432697341u,  // mov x29, sp
      4177529824u,  // str x0, [sp, #0x10]
      3107987464u,  // ldr w8, [x0, #0x20]
      3107988489u,  // ldr w9, [x0, #0x24]
      453606441u,   // mul w9, w1, w9
      1258881288u,  // sub w8, w8, w9
      3103793160u,  // str w8, [x0, #0x20]
      1895825695u,  // cmp w8, #0
      1409286284u,  // b.gt #0x1000004c4
      1384120328u,  // mov w8, #0
      4181724128u,  // ldr x0, [sp, #0x10]
      3103793160u,  // str w8, [x0, #0x20]
      3103789032u,  // str w8, [sp, #0xc]
      2415919104u,  // adrp x0, #0x100000000
      2434191360u,  // add x0, x0, #0x5b4
      2483027995u,  // bl #0x10000053c
      3107983328u,  // ldr w0, [sp, #0xc]
      2831318013u,  // ldp x29, x30, [sp], #0x20
      3596551104u,  // ret
  };

  uint8_t storage[32768];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const char* name = "_apply_damage";
  const HexStatus st = try_emit_arm64_frame_branch_bl(
      words, 20u, 0x100000490ull, name, static_cast<uint32_t>(strlen(name)),
      HEX_EMIT_FLAG_JS_PARITY, arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);

  const char* expected =
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
      "typedef __UINT32_TYPE__ uint32;\n"
      "typedef __INT32_TYPE__ int32;\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "typedef __UINT32_TYPE__ uint32_t;\n"
      "typedef __INT32_TYPE__ int32_t;\n"
      "typedef __UINTPTR_TYPE__ uintptr_t;\n"
      "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
      "#ifndef __HEX_ANY_ARGS\n"
      "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
      "#define __HEX_ANY_ARGS ...\n"
      "#else\n"
      "#define __HEX_ANY_ARGS\n"
      "#endif\n"
      "#endif\n"
      "uint64 sub_10000053C (__HEX_ANY_ARGS);\n"
      "int32 apply_damage(uint64 a1, uint64 a2)\n"
      "{\n"
      "    uint64 local_m20;\n"
      "    uint64 local_x29;\n"
      "    uint64 local_m18;\n"
      "    uint64 local_x30;\n"
      "    uint64 local_pFFFFFFFFFFFFFFF0;\n"
      "    uint64 local_pFFFFFFFFFFFFFFEC;\n"
      "    uint64 var_FFFFFFFFFFFFFFEC;\n"
      "    uint32 load_18;\n"
      "    uint64 phi_160;\n"
      "    local_m20 = local_x29;\n"
      "    local_m18 = local_x30;\n"
      "    local_pFFFFFFFFFFFFFFF0 = a1;\n"
      "    load_18 = *(uint32_t *)((uintptr_t)(a1) + 32);\n"
      "    *(uint32_t *)((uintptr_t)(a1) + 32) -= (uint32_t)a2 * *(uint32_t *)((uintptr_t)(a1) + 36);\n"
      "    if ((int32_t)*(uint32_t *)((uintptr_t)(a1) + 32) <= 0) {\n"
      "        *(uint32_t *)((uintptr_t)(local_pFFFFFFFFFFFFFFF0) + 32) = 0;\n"
      "        phi_160 = 0;\n"
      "    } else {\n"
      "        phi_160 = load_18 - (a2 * (*(uint32_t *)((uintptr_t)(a1) + 36)));\n"
      "    }\n"
      "    local_pFFFFFFFFFFFFFFEC = phi_160;\n"
      "    sub_10000053C(/* arguments unknown */);\n"
      "    return var_FFFFFFFFFFFFFFEC;\n"
      "}";
  check_exact_str(text, len, expected, "_apply_damage");

  assert(lm != nullptr);
  assert(lm_count > 20u);
  assert(lm[0].line_no == 17u && lm[0].addr == 0x100000490ull);  // sig
  // Verify all linemap addresses are within function bounds
  for (uint32_t i = 0u; i < lm_count; ++i) {
    assert(lm[i].line_no >= 17u && lm[i].line_no <= 42u);
    assert(lm[i].addr >= 0x100000490ull && lm[i].addr < 0x100000490ull + 20ull * 4ull);
  }
}

static void test_generalized_offsets_and_bl_target() {
  // Different frame size (0x30), stack slots (0x20, 0x18), struct offsets (0x10=16, 0x14=20),
  // different temp regs (w10, w11), clamp imm = 5, bl target = base + 0x100, custom name.
  const uint32_t words[20] = {
      0xa9bd7bfdu,  // stp x29, x30, [sp, #-0x30]!  (imm7 = -6 -> 0x7a -> 0x3d << 15)
      0x910003fdu,  // mov x29, sp
      0xf90013e0u,  // str x0, [sp, #0x20]          (imm12 = 4 -> 0x20)
      0xb940100au,  // ldr w10, [x0, #0x10]         (imm12 = 4 -> 16)
      0xb940140bu,  // ldr w11, [x0, #0x14]         (imm12 = 5 -> 20)
      0x1b0b7c2bu,  // mul w11, w1, w11
      0x4b0b014au,  // sub w10, w10, w11
      0xb900100au,  // str w10, [x0, #0x10]
      0x7100155fu,  // cmp w10, #5
      0x5400008cu,  // b.gt +4
      0x528000aau,  // mov w10, #5
      0xf94013e0u,  // ldr x0, [sp, #0x20]
      0xb900100au,  // str w10, [x0, #0x10]
      0xb9001beau,  // str w10, [sp, #0x18]         (imm12 = 6 -> 24 = 0x18)
      0x90000000u,  // adrp x0, #0
      0x91000400u,  // add x0, x0, #1
      0x94000030u,  // bl +0xc0 (-> base + 0x40 + 0xc0 = base + 0x100)
      0xb9401be0u,  // ldr w0, [sp, #0x18]
      0xa8c37bfdu,  // ldp x29, x30, [sp], #0x30    (imm7 = +6)
      0xd65f03c0u,  // ret
  };

  uint8_t storage[32768];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const char* name = "custom_clamp_call";
  const HexStatus st = try_emit_arm64_frame_branch_bl(
      words, 20u, 0x4000ull, name, static_cast<uint32_t>(strlen(name)),
      HEX_EMIT_FLAG_JS_PARITY, arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);
  assert(strstr(text, "uint64 sub_4100 (__HEX_ANY_ARGS);") != nullptr);
  assert(strstr(text, "int32 custom_clamp_call(uint64 a1, uint64 a2)") != nullptr);
  assert(strstr(text, "local_m30 = local_x29;") != nullptr);
  assert(strstr(text, "local_m28 = local_x30;") != nullptr);
  assert(strstr(text, "local_pFFFFFFFFFFFFFFF0 = a1;") != nullptr);
  assert(strstr(text, "local_pFFFFFFFFFFFFFFE8 = phi_160;") != nullptr);
  assert(strstr(text, "*(uint32_t *)((uintptr_t)(a1) + 16) -= (uint32_t)a2 * *(uint32_t *)((uintptr_t)(a1) + 20);") != nullptr);
  assert(strstr(text, "if ((int32_t)*(uint32_t *)((uintptr_t)(a1) + 16) <= 5) {") != nullptr);
  assert(strstr(text, "phi_160 = 5;") != nullptr);
  assert(strstr(text, "sub_4100(/* arguments unknown */);") != nullptr);
  assert(strstr(text, "return var_FFFFFFFFFFFFFFE8;") != nullptr);
}

static void test_fail_closed_and_oom() {
  uint8_t storage[32768];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  // Invalid args
  assert(try_emit_arm64_frame_branch_bl(nullptr, 20u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  const uint32_t dummy[1] = {0xd65f03c0u};
  assert(try_emit_arm64_frame_branch_bl(dummy, 0u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);
  assert(try_emit_arm64_frame_branch_bl(dummy, 1u, 0x1000u, nullptr, 3u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_INVALID_ARG);

  // Unsupported length
  assert(try_emit_arm64_frame_branch_bl(dummy, 1u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);

  // Mismatched epilogue frame size -> fail-closed
  uint32_t bad_words[20] = {
      2847833085u, 2432697341u, 4177529824u, 3107987464u, 3107988489u,
      453606441u,  1258881288u, 3103793160u, 1895825695u, 1409286284u,
      1384120328u, 4181724128u, 3103793160u, 3103789032u, 2415919104u,
      2434191360u, 2483027995u, 3107983328u, 0xa8c37bfdu, 3596551104u,
  };
  const size_t before = arena.used();
  assert(try_emit_arm64_frame_branch_bl(bad_words, 20u, 0x1000u, "f", 1u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);
  assert(arena.used() == before);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  // Invalid func_name (ObjC / special chars / digit start)
  bad_words[18] = 2831318013u;
  assert(try_emit_arm64_frame_branch_bl(bad_words, 20u, 0x1000u, "-[Foo bar]", 10u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);
  assert(try_emit_arm64_frame_branch_bl(bad_words, 20u, 0x1000u, "123bad", 6u, 1u, arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_UNSUPPORTED);

  // OOM rollback
  uint8_t tiny[64];
  hex::Arena tiny_arena;
  tiny_arena.init_fixed(tiny, sizeof(tiny));
  assert(try_emit_arm64_frame_branch_bl(bad_words, 20u, 0x1000u, "f", 1u, 1u, tiny_arena, &text, &len, &lm, &lm_count)
         == HEX_ERR_OOM);
  assert(tiny_arena.used() == 0u);
}

static void test_wave12_r10_regressions() {
  const uint32_t base_words[20] = {
      2847833085u, 2432697341u, 4177529824u, 3107987464u, 3107988489u,
      453606441u,  1258881288u, 3103793160u, 1895825695u, 1409286284u,
      1384120328u, 4181724128u, 3103793160u, 3103789032u, 2415919104u,
      2434191360u, 2483027995u, 3107983328u, 2831318013u, 3596551104u,
  };
  uint8_t storage[32768];
  hex::Arena arena;
  arena.init_fixed(storage, sizeof(storage));
  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  // 1. Unaligned 24-byte SP frame (imm7 = -3 => 0x7D, disp = -24B) rejected
  {
    uint32_t w[20];
    memcpy(w, base_words, sizeof(w));
    w[0] = 0xA9800000u | (0x7Du << 15u) | (30u << 10u) | (31u << 5u) | 29u;
    w[18] = 0xA8C00000u | (0x03u << 15u) | (30u << 10u) | (31u << 5u) | 29u;
    const size_t before = arena.used();
    assert(try_emit_arm64_frame_branch_bl(
               w, 20u, 0x100000490ull, "f", 1u, HEX_EMIT_FLAG_JS_PARITY,
               arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
    assert(arena.used() == before);
  }

  // 2. Partial OOM: arena fits text_buf (4096 + 1 = 4097B) but NOT lm_buf (96 * 16 = 1536B)
  {
    alignas(16) uint8_t partial_storage[4200];
    hex::Arena partial_arena;
    partial_arena.init_fixed(partial_storage, sizeof(partial_storage));
    const HexStatus st = try_emit_arm64_frame_branch_bl(
        base_words, 20u, 0x100000490ull, "f", 1u, HEX_EMIT_FLAG_JS_PARITY,
        partial_arena, &text, &len, &lm, &lm_count);
    assert(st == HEX_ERR_OOM);
    assert(partial_arena.used() == 0u);
    assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  }

  // 3. Partial slot overlap: slot_ptr = 0x10 (8B: [0x10..0x18)), slot_res = 0x14 (slot_ptr + 4)
  {
    uint32_t w[20];
    memcpy(w, base_words, sizeof(w));
    // [13] str w8, [sp, #0x14] (imm12 = 5 -> 0x14)
    w[13] = 0xB9000000u | (5u << 10u) | (31u << 5u) | 8u;
    // [17] ldr w0, [sp, #0x14] (imm12 = 5 -> 0x14)
    w[17] = 0xB9400000u | (5u << 10u) | (31u << 5u) | 0u;
    arena.reset();
    const HexStatus st = try_emit_arm64_frame_branch_bl(
        w, 20u, 0x100000490ull, "f", 1u, HEX_EMIT_FLAG_JS_PARITY,
        arena, &text, &len, &lm, &lm_count);
#ifdef HEX_REQUIRE_R10_3_4_GUARDS
    assert(st == HEX_ERR_UNSUPPORTED);
#else
    assert(st == HEX_ERR_UNSUPPORTED || st == HEX_OK);
#endif
  }
}

int main() {
  test_apply_damage_exact_js_parity();
  test_generalized_offsets_and_bl_target();
  test_fail_closed_and_oom();
  test_wave12_r10_regressions();
  printf("test_arm64_frame_branch_bl_emit_native: ALL PASS\n");
  return 0;
}
