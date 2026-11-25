#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

#include "decompiler/passes/arm64_call_emit.hpp"

namespace {

alignas(16) uint8_t g_arena_buf[64u * 1024u];

void test_dispatch_table_0diff_and_variants() {
  hex::Arena arena;

  // 1. Exact `arm64-dispatch-table::entry` from all_43_functions.json (12 insns, base 0x1000)
  const uint32_t dispatch_entry[12] = {
      0xa9bf7bfdu,  // stp x29, x30, [sp, #-0x10]!
      0xd2821009u,  // mov x9, #0x1080
      0x9240000au,  // and x10, x0, #1
      0xd37df14au,  // lsl x10, x10, #3
      0x8b0a0129u,  // add x9, x9, x10
      0xf940012bu,  // ldr x11, [x9]
      0xd63f0160u,  // blr x11
      0xa8c17bfdu,  // ldp x29, x30, [sp], #0x10
      0xd65f03c0u,  // ret
      0xd503201fu,  // nop
      0xd503201fu,  // nop
      0xd503201fu,  // nop
  };

  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  assert(hex::decompiler::passes::try_emit_arm64_calls(
             dispatch_entry, 12u, 0x1000ULL, "entry", 5u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_OK);
  assert(text != nullptr && len > 0u);
  assert(lm != nullptr && lm_count >= 4u);

  const std::string expected_entry =
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "typedef __INT64_TYPE__ int64;\n"
      "typedef __UINTPTR_TYPE__ uintptr_t;\n"
      "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
      "#ifndef __HEX_ANY_ARGS\n"
      "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
      "#define __HEX_ANY_ARGS ...\n"
      "#else\n"
      "#define __HEX_ANY_ARGS\n"
      "#endif\n"
      "#endif\n"
      "void entry(int64 a1)\n"
      "{\n"
      "    uint64 x0;\n"
      "    // \xE2\x80\xA6 \xE3\x81\xBB\xE3\x81\x8B\xE3\x81\xAB 2 "
      "\xE5\x80\x8B\xE3\x81\xAE\xE7\xBD\xAE\xE3\x81\x8D\xE5\xA0\xB4"
      "\xEF\xBC\x88\xE9\x80\x80\xE9\x81\xBF\xE7\x94\xA8\xE3\x81\xAA\xE3\x81\xA9"
      "\xEF\xBC\x89\xE3\x81\x8C\xE3\x81\x82\xE3\x82\x8A\xE3\x81\xBE\xE3\x81\x99\n"
      "\n"
      "    x0 = a1;\n"
      "    x0 = ((uint64 (*)(__HEX_ANY_ARGS))(uintptr_t)(*(uint64 *)((a1 & 1) * 8 + 0x1080)))(a1);\n"
      "    return;\n"
      "}";

  const std::string got(text, len);
  if (got != expected_entry) {
    std::fprintf(stderr, "MISMATCH dispatch_entry:\n--- GOT ---\n%s\n--- EXP ---\n%s\n",
                 got.c_str(), expected_entry.c_str());
    assert(false);
  }

  bool saw_blr = false;
  bool saw_ret = false;
  for (uint32_t i = 0u; i < lm_count; ++i) {
    assert(lm[i].line_no >= 1u);
    if (lm[i].addr == 0x1018ULL) saw_blr = true;
    if (lm[i].addr == 0x1020ULL) saw_ret = true;
  }
  assert(saw_blr && saw_ret);

  // 2. Generalized variant: different scratch regs (x12/x13/x14), mask #3, table #0x40 (<100 decimal),
  //    different name `_my_dispatch`, different base_addr 0x4000, 1 trailing nop.
  const uint32_t dispatch_var[10] = {
      0xa9bf7bfdu,  // stp x29, x30, [sp, #-0x10]!
      0xd280080cu,  // mov x12, #0x40 (64)
      0x9240040du,  // and x13, x0, #3
      0xd37df1adu,  // lsl x13, x13, #3
      0x8b0d018cu,  // add x12, x12, x13
      0xf940018eu,  // ldr x14, [x12]
      0xd63f01c0u,  // blr x14
      0xa8c17bfdu,  // ldp x29, x30, [sp], #0x10
      0xd65f03c0u,  // ret
      0xd503201fu,  // nop
  };
  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             dispatch_var, 10u, 0x4000ULL, "_my_dispatch", 12u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_OK);
  const std::string got_var(text, len);
  assert(got_var.find("void my_dispatch(int64 a1)") != std::string::npos);
  assert(got_var.find("((a1 & 3) * 8 + 64)") != std::string::npos);

  // 3. Dispatch table WITHOUT trailing NOP must fail-closed under JS_PARITY (JS switches to call_<N>).
  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             dispatch_entry, 9u, 0x1000ULL, "entry", 5u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);

  std::printf("  [PASS] dispatch-table 0-diff + generalized variants + no-nop fail-closed\n");
}

void test_standard_frame_calls_parity_and_non_parity() {
  hex::Arena arena;
  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  // 1. arm64-semantic-holdout::direct_call (8 insns, base 0x103c)
  const uint32_t direct_call[8] = {
      0xa9bf7bfdu, 0x910003fdu, 0xaa0103e0u, 0xaa0203e1u,
      0x94000004u, 0x91000400u, 0xa8c17bfdu, 0xd65f03c0u,
  };
  // 2. macho-sample-arm64::_greet (7 insns, base 0x100000474)
  const uint32_t greet[7] = {
      0xa9bf7bfdu, 0x910003fdu, 0x90000000u, 0x91152000u,
      0x9400002eu, 0xa8c17bfdu, 0xd65f03c0u,
  };
  // 3. arm64-threaded-mem::entry (11 insns, base 0x1000)
  const uint32_t threaded_mem[11] = {
      0xa9be7bfdu, 0x910003fdu, 0xd283fe09u, 0x91004129u,
      0xf9000be9u, 0xf9400be0u, 0x94000005u, 0xf9000be0u,
      0xf9400be0u, 0xa8c27bfdu, 0xd65f03c0u,
  };
  // 4. x86_64-stripped-elf::virtual_call (8 insns, base 0x21027c)
  const uint32_t virtual_call[8] = {
      0xa9bf7bfdu, 0x910003fdu, 0xf9400008u, 0x528000e1u,
      0xf9400108u, 0xd63f0100u, 0xa8c17bfdu, 0xd65f03c0u,
  };
  // 5. x86_64-stripped-elf::_ZNK5Thing8interactEP4Base (10 insns, base 0x2102bc)
  const uint32_t thing_interact[10] = {
      0xa9bf7bfdu, 0x910003fdu, 0xf9400029u, 0xaa0103e8u,
      0xb9400c01u, 0xaa0803e0u, 0xf9400129u, 0xd63f0120u,
      0xa8c17bfdu, 0xd65f03c0u,
  };

  // Under HEX_EMIT_FLAG_JS_PARITY: all 5 must fail closed (JS embeds non-portable internal `call_<v.id>`).
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             direct_call, 8u, 0x103cULL, "direct_call", 11u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             greet, 7u, 0x100000474ULL, "_greet", 6u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             threaded_mem, 11u, 0x1000ULL, "entry", 5u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             virtual_call, 8u, 0x21027cULL, "virtual_call", 12u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             thing_interact, 10u, 0x2102bcULL, "_ZNK5Thing8interactEP4Base", 26u, HEX_EMIT_FLAG_JS_PARITY,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);

  // Under HEX_EMIT_FLAG_NONE: all 5 lift cleanly with exact targets, params, and linemaps.
  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             direct_call, 8u, 0x103cULL, "direct_call", 11u, HEX_EMIT_FLAG_NONE,
             arena, &text, &len, &lm, &lm_count) == HEX_OK);
  {
    const std::string s(text, len);
    assert(s.find("uint64 sub_105C (__HEX_ANY_ARGS);") != std::string::npos);
    assert(s.find("uint64 direct_call(uint64 a1, uint64 a2, uint64 a3)") != std::string::npos);
    assert(s.find("call_0 = sub_105C(/* arguments unknown */);") != std::string::npos);
    assert(s.find("return call_0 + 1;") != std::string::npos);
    assert(lm_count >= 5u);
  }

  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             greet, 7u, 0x100000474ULL, "_greet", 6u, HEX_EMIT_FLAG_NONE,
             arena, &text, &len, &lm, &lm_count) == HEX_OK);
  {
    const std::string s(text, len);
    assert(s.find("uint64 sub_10000053C (__HEX_ANY_ARGS);") != std::string::npos);
    assert(s.find("uint64 greet(void)") != std::string::npos);
    assert(s.find("return call_0;") != std::string::npos);
  }

  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             threaded_mem, 11u, 0x1000ULL, "entry", 5u, HEX_EMIT_FLAG_NONE,
             arena, &text, &len, &lm, &lm_count) == HEX_OK);
  {
    const std::string s(text, len);
    assert(s.find("uint64 sub_102C (__HEX_ANY_ARGS);") != std::string::npos);
    assert(s.find("local_m20 = local_x29;") != std::string::npos);
    assert(s.find("local_m18 = local_x30;") != std::string::npos);
    assert(s.find("return call_0;") != std::string::npos);
  }

  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             virtual_call, 8u, 0x21027cULL, "virtual_call", 12u, HEX_EMIT_FLAG_NONE,
             arena, &text, &len, &lm, &lm_count) == HEX_OK);
  {
    const std::string s(text, len);
    assert(s.find("uint64 unknown_call (__HEX_ANY_ARGS);") != std::string::npos);
    assert(s.find("uint64 virtual_call(uint64 a1)") != std::string::npos);
    assert(s.find("call_0 = unknown_call(a1);") != std::string::npos);
  }

  arena.reset();
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             thing_interact, 10u, 0x2102bcULL, "_ZNK5Thing8interactEP4Base", 26u, HEX_EMIT_FLAG_NONE,
             arena, &text, &len, &lm, &lm_count) == HEX_OK);
  {
    const std::string s(text, len);
    assert(s.find("uint64 ZNK5Thing8interactEP4Base(uint64 a1, uint64 a2)") != std::string::npos);
    assert(s.find("call_0 = unknown_call(a2);") != std::string::npos);
  }

  std::printf("  [PASS] standard frame+call fail-closed under JS_PARITY & generic lifting under NONE\n");
}

void test_invalid_args_and_fail_closed_edge_cases() {
  hex::Arena arena;
  arena.init_fixed(g_arena_buf, sizeof(g_arena_buf));
  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;
  const uint32_t dummy[2] = {0xd503201fu, 0xd65f03c0u};

  // Null / zero args
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             nullptr, 2u, 0x1000ULL, nullptr, 0u, 0u, arena, &text, &len, &lm, &lm_count) == HEX_ERR_INVALID_ARG);
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             dummy, 0u, 0x1000ULL, nullptr, 0u, 0u, arena, &text, &len, &lm, &lm_count) == HEX_ERR_INVALID_ARG);
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             dummy, 2u, 0x1000ULL, nullptr, 4u, 0u, arena, &text, &len, &lm, &lm_count) == HEX_ERR_INVALID_ARG);
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             dummy, 2u, 0x1000ULL, nullptr, 0u, 0u, arena, nullptr, &len, &lm, &lm_count) == HEX_ERR_INVALID_ARG);

  // Mismatched frame size (stp #-16 vs ldp #32)
  const uint32_t bad_frame[5] = {
      0xa9bf7bfdu, 0x910003fdu, 0x94000004u, 0xa8c27bfdu, 0xd65f03c0u,
  };
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             bad_frame, 5u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_NONE,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);

  // Non-canonical `ret x8`
  const uint32_t bad_ret[5] = {
      0xa9bf7bfdu, 0x910003fdu, 0x94000004u, 0xa8c17bfdu, 0xd65f0100u,
  };
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             bad_ret, 5u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_NONE,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);

  // Multiple calls in one function
  const uint32_t two_calls[6] = {
      0xa9bf7bfdu, 0x910003fdu, 0x94000004u, 0x94000005u, 0xa8c17bfdu, 0xd65f03c0u,
  };
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             two_calls, 6u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_NONE,
             arena, &text, &len, &lm, &lm_count) == HEX_ERR_UNSUPPORTED);

  // Tiny arena OOM check
  alignas(16) uint8_t tiny[64];
  hex::Arena tiny_arena;
  tiny_arena.init_fixed(tiny, sizeof(tiny));
  const uint32_t simple_call[5] = {
      0xa9bf7bfdu, 0x910003fdu, 0x94000004u, 0xa8c17bfdu, 0xd65f03c0u,
  };
  assert(hex::decompiler::passes::try_emit_arm64_calls(
             simple_call, 5u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_NONE,
             tiny_arena, &text, &len, &lm, &lm_count) == HEX_ERR_OOM);

  std::printf("  [PASS] invalid args, mismatched frame, non-canonical ret, multi-call, and OOM fail-closed\n");
}

}  // namespace

int main() {
  std::printf("Running test_arm64_call_emit_native...\n");
  test_dispatch_table_0diff_and_variants();
  test_standard_frame_calls_parity_and_non_parity();
  test_invalid_args_and_fail_closed_edge_cases();
  std::printf("test_arm64_call_emit_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
