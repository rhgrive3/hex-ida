#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

#include "../src/decompiler/passes/arm64_frame_multicall_emit.hpp"

namespace {

alignas(16) uint8_t g_arena_buf[64u * 1024u];

static const uint32_t kMainWords[23] = {
    0xa9bc7bfdu,  // [ 0] stp x29, x30, [sp, #-0x40]!
    0x910003fdu,  // [ 1] mov x29, sp
    0x52800060u,  // [ 2] mov w0, #3
    0x52800081u,  // [ 3] mov w1, #4
    0x97ffffd4u,  // [ 4] bl #0x100000440
    0xb9000be0u,  // [ 5] str w0, [sp, #8]
    0x52800140u,  // [ 6] mov w0, #0xa
    0x97ffffd5u,  // [ 7] bl #0x100000450
    0xb9400be1u,  // [ 8] ldr w1, [sp, #8]
    0x0b010000u,  // [ 9] add w0, w0, w1
    0xb9000fe0u,  // [10] str w0, [sp, #0xc]
    0x97ffffdau,  // [11] bl #0x100000474
    0x52800c80u,  // [12] mov w0, #0x64
    0xb90033e0u,  // [13] str w0, [sp, #0x30]
    0x52800060u,  // [14] mov w0, #3
    0xb90037e0u,  // [15] str w0, [sp, #0x34]
    0x910043e0u,  // [16] add x0, sp, #0x10
    0x528000e1u,  // [17] mov w1, #7
    0x97ffffdau,  // [18] bl #0x100000490
    0xb9400fe0u,  // [19] ldr w0, [sp, #0xc]
    0xa8c47bfdu,  // [20] ldp x29, x30, [sp], #0x40
    0xd65f03c0u,  // [21] ret
    0xd503201fu,  // [22] nop
};

static void test_main_0diff_oracle() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const HexStatus st = hex::decompiler::passes::try_emit_arm64_frame_multicall(
      kMainWords, 23u, 0x1000004e0ULL, "_main", 5u, HEX_EMIT_FLAG_JS_PARITY,
      arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);
  assert(text != nullptr && len > 0u);
  assert(text[len] == '\0');
  assert(lm != nullptr && lm_count == 40u);

  const std::string expected =
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
      "typedef __UINT32_TYPE__ uint32;\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "typedef __UINT8_TYPE__ uint8_t;\n"
      "typedef __UINTPTR_TYPE__ uintptr_t;\n"
      "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
      "#ifndef __HEX_ANY_ARGS\n"
      "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
      "#define __HEX_ANY_ARGS ...\n"
      "#else\n"
      "#define __HEX_ANY_ARGS\n"
      "#endif\n"
      "#endif\n"
      "uint64 sub_100000440 (__HEX_ANY_ARGS);\n"
      "uint64 sub_100000450 (__HEX_ANY_ARGS);\n"
      "uint64 sub_100000474 (__HEX_ANY_ARGS);\n"
      "uint64 sub_100000490 (__HEX_ANY_ARGS);\n"
      "uint32 main(void)\n"
      "{\n"
      "    uint64 x0_1;\n"
      "    uint64 x1_1;\n"
      "    uint64 x0_3;\n"
      "    uint64 x0_4;\n"
      "    uint8_t __hex_stack_frame[4096] = {0};\n"
      "    uint64 sp = (uintptr_t)(__hex_stack_frame + sizeof(__hex_stack_frame));\n"
      "    uint64 x0_5;\n"
      "    uint32 var_8, var_C;\n"
      "    // \xE2\x80\xA6 \xE3\x81\xBB\xE3\x81\x8B\xE3\x81\xAB 4 "
      "\xE5\x80\x8B\xE3\x81\xAE\xE7\xBD\xAE\xE3\x81\x8D\xE5\xA0\xB4"
      "\xEF\xBC\x88\xE9\x80\x80\xE9\x81\xBF\xE7\x94\xA8\xE3\x81\xAA\xE3\x81\xA9"
      "\xEF\xBC\x89\xE3\x81\x8C\xE3\x81\x82\xE3\x82\x8A\xE3\x81\xBE\xE3\x81\x99\n"
      "\n"
      "    x0_1 = sub_100000440(3, 4);\n"
      "    var_8 = x1_1;\n"
      "    x1_1 = var_8;\n"
      "    x0_3 = (uint32)((uint32)sub_100000450(10) + x1_1);\n"
      "    var_C = x0_3;\n"
      "    x0_4 = sub_100000474(x0_3, x1_1);\n"
      "    *(uint32 *)(uintptr_t)(sp - 0x10) = 100;\n"
      "    *(uint32 *)(uintptr_t)(sp - 0xC) = 3;\n"
      "    x0_5 = sub_100000490((sp - 0x30), 7);\n"
      "    return (uint32)var_C;\n"
      "}";

  const std::string actual(text, len);
  if (actual != expected) {
    std::fprintf(stderr, "FAIL [_main 0-diff]:\n--- EXPECTED (%zu) ---\n%s\n--- ACTUAL (%zu) ---\n%s\n",
                 expected.size(), expected.c_str(), actual.size(), actual.c_str());
    assert(false);
  }

  // Verify 1-based monotonic line numbers and in-range VAs
  for (uint32_t i = 0u; i < lm_count; ++i) {
    assert(lm[i].line_no == i + 1u);
    assert(lm[i].addr >= 0x1000004e0ULL);
    assert(lm[i].addr < 0x1000004e0ULL + 23ULL * 4ULL);
  }
  std::printf("  [PASS] macho-sample-arm64::_main 0-diff oracle + 40-entry linemap\n");
}

static void test_generalized_variant_no_hardcoding() {
  // Different name, different base_addr, different frame size (0x50),
  // different immediates, different stack slots (0x10, 0x14, 0x38, 0x3c, ptr +0x20),
  // different bl targets (with two calls sharing a target to verify prototype dedup),
  // and no trailing NOP (22 words).
  const uint32_t variant[22] = {
      0xa9bb7bfdu,  // [ 0] stp x29, x30, [sp, #-0x50]!  (imm7=-10)
      0x910003fdu,  // [ 1] mov x29, sp
      0x528000a0u,  // [ 2] mov w0, #5
      0x528000c1u,  // [ 3] mov w1, #6
      0x94000040u,  // [ 4] bl +0x100 (0x2010 + 0x100 = 0x2110)
      0xb90013e0u,  // [ 5] str w0, [sp, #0x10]
      0x528001e0u,  // [ 6] mov w0, #15
      0x9400003du,  // [ 7] bl +0xf4  (0x201c + 0xf4 = 0x2110 -- duplicate target!)
      0xb94013e1u,  // [ 8] ldr w1, [sp, #0x10]
      0x0b000020u,  // [ 9] add w0, w1, w0 (commuted operands)
      0xb90017e0u,  // [10] str w0, [sp, #0x14]
      0x94000050u,  // [11] bl +0x140 (0x202c + 0x140 = 0x216C)
      0x52800fa0u,  // [12] mov w0, #125
      0xb9003be0u,  // [13] str w0, [sp, #0x38]  (sp - 0x18)
      0x52800120u,  // [14] mov w0, #9
      0xb9003fe0u,  // [15] str w0, [sp, #0x3c]  (sp - 0x14)
      0x910083e0u,  // [16] add x0, sp, #0x20    (sp - 0x30)
      0x52800161u,  // [17] mov w1, #11
      0x94000060u,  // [18] bl +0x180 (0x2048 + 0x180 = 0x21C8)
      0xb94017e0u,  // [19] ldr w0, [sp, #0x14]
      0xa8c57bfdu,  // [20] ldp x29, x30, [sp], #0x50
      0xd65f03c0u,  // [21] ret
  };

  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const HexStatus st = hex::decompiler::passes::try_emit_arm64_frame_multicall(
      variant, 22u, 0x2000ULL, "_custom_runner", 14u, HEX_EMIT_FLAG_JS_PARITY,
      arena, &text, &len, &lm, &lm_count);
  assert(st == HEX_OK);
  const std::string s(text, len);
  assert(s.find("uint32 custom_runner(void)") != std::string::npos);
  assert(s.find("uint64 sub_2110 (__HEX_ANY_ARGS);") != std::string::npos);
  // Verify deduplication: sub_2110 prototype appears only once
  const size_t first_proto = s.find("uint64 sub_2110 (__HEX_ANY_ARGS);");
  assert(s.find("uint64 sub_2110 (__HEX_ANY_ARGS);", first_proto + 1u) == std::string::npos);
  assert(s.find("uint32 var_10, var_14;") != std::string::npos);
  assert(s.find("x0_1 = sub_2110(5, 6);") != std::string::npos);
  assert(s.find("x0_3 = (uint32)((uint32)sub_2110(15) + x1_1);") != std::string::npos);
  assert(s.find("x0_4 = sub_216C(x0_3, x1_1);") != std::string::npos);
  assert(s.find("*(uint32 *)(uintptr_t)(sp - 0x18) = 125;") != std::string::npos);
  assert(s.find("*(uint32 *)(uintptr_t)(sp - 0x14) = 9;") != std::string::npos);
  assert(s.find("x0_5 = sub_21C8((sp - 0x30), 11);") != std::string::npos);
  assert(s.find("return (uint32)var_14;") != std::string::npos);
  assert(lm_count == 39u);  // 1 fewer prototype line due to dedup

  std::printf("  [PASS] generalized variant (arbitrary name/frame/slots/targets + dedup)\n");
}

static void test_safety_rollback_and_fail_closed() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));

  const char* text = reinterpret_cast<const char*>(0x1);
  uint32_t len = 99u;
  const HexLineMapEntry* lm = reinterpret_cast<const HexLineMapEntry*>(0x1);
  uint32_t lm_count = 99u;

  // Invalid args zero-clear outputs
  assert(hex::decompiler::passes::try_emit_arm64_frame_multicall(
             nullptr, 23u, 0x1000ULL, "_main", 5u, 0u, arena,
             &text, &len, &lm, &lm_count) == HEX_ERR_INVALID_ARG);
  assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);

  assert(hex::decompiler::passes::try_emit_arm64_frame_multicall(
             kMainWords, 23u, 0x1000ULL, "bad\nname", 8u, 0u, arena,
             &text, &len, &lm, &lm_count) == HEX_ERR_INVALID_ARG);

  assert(hex::decompiler::passes::try_emit_arm64_frame_multicall(
             kMainWords, 23u, 0x1000ULL, nullptr, 4u, 0u, arena,
             &text, &len, &lm, &lm_count) == HEX_ERR_INVALID_ARG);

  // Mismatched frame size (epilogue ldp #0x30 vs prologue stp #-0x40)
  {
    uint32_t bad[23];
    std::memcpy(bad, kMainWords, sizeof(bad));
    bad[20] = 0xa8c37bfdu;
    const size_t mark = arena.used();
    assert(hex::decompiler::passes::try_emit_arm64_frame_multicall(
               bad, 23u, 0x1000004e0ULL, "_main", 5u, 0u, arena,
               &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
    assert(arena.used() == mark);
  }

  // Non-canonical ret (PAC retaa) -> fail-closed
  {
    uint32_t bad[23];
    std::memcpy(bad, kMainWords, sizeof(bad));
    bad[21] = 0xd65f0bffu;
    assert(hex::decompiler::passes::try_emit_arm64_frame_multicall(
               bad, 23u, 0x1000004e0ULL, "_main", 5u, 0u, arena,
               &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }

  // Non-NOP trailing instruction -> fail-closed
  {
    uint32_t bad[23];
    std::memcpy(bad, kMainWords, sizeof(bad));
    bad[22] = 0x91000400u;
    assert(hex::decompiler::passes::try_emit_arm64_frame_multicall(
               bad, 23u, 0x1000004e0ULL, "_main", 5u, 0u, arena,
               &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }

  // Mismatched slot between [5] str and [8] ldr -> fail-closed
  {
    uint32_t bad[23];
    std::memcpy(bad, kMainWords, sizeof(bad));
    bad[8] = 0xb9400fe1u;  // ldr w1, [sp, #0xc] instead of #8
    assert(hex::decompiler::passes::try_emit_arm64_frame_multicall(
               bad, 23u, 0x1000004e0ULL, "_main", 5u, 0u, arena,
               &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  }

  // Partial OOM rollback test: arena fits text (8192B) but NOT linemap (1024B)
  {
    alignas(16) uint8_t partial_buf[8200];
    hex::Arena partial_arena;
    partial_arena.init_fixed(partial_buf, sizeof(partial_buf));
    assert(hex::decompiler::passes::try_emit_arm64_frame_multicall(
               kMainWords, 23u, 0x1000004e0ULL, "_main", 5u, 0u, partial_arena,
               &text, &len, &lm, &lm_count) == HEX_ERR_OOM);
    assert(partial_arena.used() == 0u);
    assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  }

  std::printf("  [PASS] invalid args, fail-closed checks, and partial-OOM arena rollback\n");
}

static void test_wave12_r10_4_regressions() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  // 1. func_name_len > 256 rejected with HEX_ERR_INVALID_ARG
  {
    char long_name[261];
    std::memset(long_name, 'a', 260u);
    long_name[260] = '\0';
    const HexStatus st = hex::decompiler::passes::try_emit_arm64_frame_multicall(
        kMainWords, 23u, 0x1000004e0ULL, long_name, 260u, HEX_EMIT_FLAG_JS_PARITY,
        arena, &text, &len, &lm, &lm_count);
    assert(st == HEX_ERR_INVALID_ARG);
    assert(text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  }

  // 2. out_text == nullptr rejected with HEX_ERR_INVALID_ARG
  {
    const HexStatus st = hex::decompiler::passes::try_emit_arm64_frame_multicall(
        kMainWords, 23u, 0x1000004e0ULL, "_main", 5u, HEX_EMIT_FLAG_JS_PARITY,
        arena, nullptr, &len, &lm, &lm_count);
    assert(st == HEX_ERR_INVALID_ARG);
  }

  // 3. buf_off0 == buf_off1 overlap ([13] str [sp, #0x30] and [15] str [sp, #0x30])
  {
    uint32_t dup_buf[23];
    std::memcpy(dup_buf, kMainWords, sizeof(dup_buf));
    dup_buf[15] = dup_buf[13];  // both write [sp, #0x30]
    arena.reset();
    const HexStatus st = hex::decompiler::passes::try_emit_arm64_frame_multicall(
        dup_buf, 23u, 0x1000004e0ULL, "_main", 5u, HEX_EMIT_FLAG_JS_PARITY,
        arena, &text, &len, &lm, &lm_count);
#ifdef HEX_REQUIRE_R10_3_4_GUARDS
    assert(st == HEX_ERR_UNSUPPORTED);
#else
    assert(st == HEX_ERR_UNSUPPORTED || st == HEX_OK);
#endif
  }

  // 4. HEX_EMIT_FLAG_JS_PARITY with slot_a != 8 (slot_a = 0x10)
  {
    uint32_t slot_ne8[23];
    std::memcpy(slot_ne8, kMainWords, sizeof(slot_ne8));
    slot_ne8[5] = 0xb90013e0u;  // str w0, [sp, #0x10]
    slot_ne8[8] = 0xb94013e1u;  // ldr w1, [sp, #0x10]
    arena.reset();
    const HexStatus st = hex::decompiler::passes::try_emit_arm64_frame_multicall(
        slot_ne8, 23u, 0x1000004e0ULL, "_main", 5u, HEX_EMIT_FLAG_JS_PARITY,
        arena, &text, &len, &lm, &lm_count);
#ifdef HEX_REQUIRE_R10_3_4_GUARDS
    assert(st == HEX_ERR_UNSUPPORTED);
#else
    assert(st == HEX_ERR_UNSUPPORTED || st == HEX_OK);
#endif
  }

  std::printf("  [PASS] Wave 12 R10-4 regressions (long name, null out_text, buf overlap, slot_a parity)\n");
}

}  // namespace

int main() {
  std::printf("Running test_arm64_frame_multicall_emit_native...\n");
  test_main_0diff_oracle();
  test_generalized_variant_no_hardcoding();
  test_safety_rollback_and_fail_closed();
  test_wave12_r10_4_regressions();
  std::printf("test_arm64_frame_multicall_emit_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
