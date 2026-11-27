#include <cstdint>
#include <cstdio>
#include <cstring>

#include "decompiler/passes/arm64_objc_emit.hpp"

using hex::decompiler::passes::try_emit_arm64_objc;

static int g_pass = 0;
static int g_fail = 0;

static void check_true(const char* label, bool cond) {
  if (!cond) {
    std::fprintf(stderr, "FAIL [%s]\n", label);
    g_fail++;
  } else {
    g_pass++;
  }
}

static void check_eq_str(const char* label, const char* got, uint32_t got_len, const char* want) {
  const size_t want_len = std::strlen(want);
  if (got == nullptr || got_len != want_len || std::memcmp(got, want, want_len) != 0) {
    std::fprintf(stderr, "FAIL [%s]\n--- WANT (%zu) ---\n%s\n--- GOT (%u) ---\n%s\n",
                 label, want_len, want, got_len, got ? got : "<null>");
    g_fail++;
  } else {
    g_pass++;
  }
}

static bool linemap_has(const HexLineMapEntry* lm, uint32_t count, uint32_t line_no, uint64_t addr) {
  for (uint32_t i = 0u; i < count; ++i) {
    if (lm[i].line_no == line_no && lm[i].addr == addr) return true;
  }
  return false;
}

static void run_positive(const char* label,
                         const uint32_t* words,
                         uint32_t word_count,
                         uint64_t base_addr,
                         const char* func_name,
                         const char* expected_c,
                         uint32_t sig_line,
                         uint32_t key_stmt_line,
                         uint64_t key_stmt_addr) {
  uint8_t mem[16384];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const HexStatus st = try_emit_arm64_objc(
      words, word_count, base_addr,
      func_name, static_cast<uint32_t>(std::strlen(func_name)),
      HEX_EMIT_FLAG_JS_PARITY, arena,
      &text, &len, &lm, &lm_count);
  check_true(label, st == HEX_OK);
  check_eq_str(label, text, len, expected_c);
  check_true(label, lm != nullptr && lm_count > 0u);
  check_true(label, linemap_has(lm, lm_count, sig_line, base_addr));
  check_true(label, linemap_has(lm, lm_count, key_stmt_line, key_stmt_addr));
}

static void run_negative(const char* label,
                         const uint32_t* words,
                         uint32_t word_count,
                         uint64_t base_addr,
                         const char* func_name,
                         HexStatus expected_status) {
  uint8_t mem[16384];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));

  const char* text = "stale";
  uint32_t len = 123u;
  const HexLineMapEntry* lm = reinterpret_cast<const HexLineMapEntry*>(0x1);
  uint32_t lm_count = 123u;

  const HexStatus st = try_emit_arm64_objc(
      words, word_count, base_addr,
      func_name, func_name ? static_cast<uint32_t>(std::strlen(func_name)) : 0u,
      HEX_EMIT_FLAG_JS_PARITY, arena,
      &text, &len, &lm, &lm_count);
  check_true(label, st == expected_status);
  check_true(label, text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  check_true(label, arena.used() == 0u);
}

int main() {
  // 1. arm64_32-objc::-[Foo count] (exact 0-diff vs all_43_functions.json)
  {
    const uint32_t w[12] = {
        0xD10043FFu, 0xAA0003E8u, 0xB9000FE8u, 0xAA0103E8u,
        0xB9000BE8u, 0xB9400FE8u, 0x90000009u, 0xB9800129u,
        0x8B090108u, 0xB9400100u, 0x910043FFu, 0xD65F03C0u,
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT32_TYPE__ uint32;\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef __UINT32_TYPE__ uint32_t;\n"
        "typedef __INT32_TYPE__ int32_t;\n"
        "typedef __UINT64_TYPE__ uint64_t;\n"
        "typedef __INT64_TYPE__ int64_t;\n"
        "typedef __UINTPTR_TYPE__ uintptr_t;\n"
        "typedef void * id;\n"
        "/* hex: standalone external globals (stripped by translation unit packager). */\n"
        "static uint64 global_0 = 0;\n"
        "#ifndef __hex_helper_sext_defined\n"
        "#define __hex_helper_sext_defined\n"
        "static inline int64_t sext(uint64_t v) { return (int64_t)(int32_t)(uint32_t)v; }\n"
        "#endif\n"
        "int32 -[Foo count](void)\n"
        "{\n"
        "    uint64 local_m4;\n"
        "    uint64 self;\n"
        "    uint64 local_m8;\n"
        "    uint64 a2;\n"
        "    uint32 var_C;\n"
        "    local_m4 = self;\n"
        "    local_m8 = a2;\n"
        "    return *(uint32_t *)(uintptr_t)(var_C + (sext(global_0)));\n"
        "}";
    run_positive("arm64_32-objc::-[Foo count]", w, 12u, 0x20ULL, "-[Foo count]",
                 expected, 17u, 26u, 0x44ULL);
  }

  // 2. arm64_32-objc::-[Foo setCount:] (exact 0-diff vs all_43_functions.json)
  {
    const uint32_t w[14] = {
        0xD10043FFu, 0xAA0003E8u, 0xB9000FE8u, 0xAA0103E8u,
        0xB9000BE8u, 0xB90007E2u, 0xB94007E8u, 0xB9400FE9u,
        0x9000000Au, 0xB980014Au, 0x8B0A0129u, 0xB9000128u,
        0x910043FFu, 0xD65F03C0u,
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef __UINT32_TYPE__ uint32_t;\n"
        "typedef __INT32_TYPE__ int32_t;\n"
        "typedef __INT64_TYPE__ int64_t;\n"
        "typedef __UINTPTR_TYPE__ uintptr_t;\n"
        "typedef void * id;\n"
        "/* hex: standalone external globals (stripped by translation unit packager). */\n"
        "static uint64 global_0 = 0;\n"
        "uint64 -[Foo setCount:](uint64 a3)\n"
        "{\n"
        "    uint64 local_m4;\n"
        "    uint64 self;\n"
        "    uint64 local_m8;\n"
        "    uint64 a2;\n"
        "    uint64 local_mC;\n"
        "    local_m4 = self;\n"
        "    local_m8 = a2;\n"
        "    local_mC = a3;\n"
        "    *(uint32_t *)(uintptr_t)(local_m4 + (int64_t)(int32_t)global_0) = (uint32_t)a3;\n"
        "    return self;\n"
        "}";
    run_positive("arm64_32-objc::-[Foo setCount:]", w, 14u, 0x50ULL, "-[Foo setCount:]",
                 expected, 10u, 20u, 0x7CULL);
  }

  // 3. arm64_32-objc::-[Foo(Cat) p] (exact 0-diff vs all_43_functions.json)
  {
    const uint32_t w[8] = {
        0xD10043FFu, 0xAA0003E8u, 0xB9000FE8u, 0xAA0103E8u,
        0xB9000BE8u, 0x528000E0u, 0x910043FFu, 0xD65F03C0u,
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef void * id;\n"
        "int32 -[Foo(Cat) p](void)\n"
        "{\n"
        "    uint64 local_m4;\n"
        "    uint64 self;\n"
        "    uint64 local_m8;\n"
        "    uint64 a2;\n"
        "    local_m4 = self;\n"
        "    local_m8 = a2;\n"
        "    return 7;\n"
        "}";
    run_positive("arm64_32-objc::-[Foo(Cat) p]", w, 8u, 0x88ULL, "-[Foo(Cat) p]",
                 expected, 5u, 13u, 0x9CULL);
  }

  // Generalized case: class method +[Bar answer] returning 42
  {
    const uint32_t w[8] = {
        0xD10043FFu, 0xAA0003E8u, 0xB9000FE8u, 0xAA0103E8u,
        0xB9000BE8u, 0x52800540u, 0x910043FFu, 0xD65F03C0u,
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef void * id;\n"
        "int32 +[Bar answer](void)\n"
        "{\n"
        "    uint64 local_m4;\n"
        "    uint64 self;\n"
        "    uint64 local_m8;\n"
        "    uint64 a2;\n"
        "    local_m4 = self;\n"
        "    local_m8 = a2;\n"
        "    return 42;\n"
        "}";
    run_positive("generalized_class_method", w, 8u, 0x1000ULL, "+[Bar answer]",
                 expected, 5u, 13u, 0x1014ULL);
  }


  // ARM64e PAC case 1: PACIBSP + ConstReturn + RETAB
  {
    const uint32_t w[9] = {
        0xD503237Fu, // pacibsp
        0xD10043FFu, 0xAA0003E8u, 0xB9000FE8u, 0xAA0103E8u,
        0xB9000BE8u, 0x52800540u, 0x910043FFu,
        0xD65F0FFFu, // retab
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef void * id;\n"
        "int32 +[Bar answer](void)\n"
        "{\n"
        "    uint64 local_m4;\n"
        "    uint64 self;\n"
        "    uint64 local_m8;\n"
        "    uint64 a2;\n"
        "    local_m4 = self;\n"
        "    local_m8 = a2;\n"
        "    return 42;\n"
        "}";
    run_positive("arm64e_pac_const_return", w, 9u, 0x2000ULL, "+[Bar answer]",
                 expected, 5u, 13u, 0x2018ULL);
  }

  // ARM64e PAC case 2: BTI + PACIBSP + ConstReturn + AUTIBSP + RET
  {
    const uint32_t w[11] = {
        0xD503245Fu, // bti c
        0xD503237Fu, // pacibsp
        0xD10043FFu, 0xAA0003E8u, 0xB9000FE8u, 0xAA0103E8u,
        0xB9000BE8u, 0x52800540u, 0x910043FFu,
        0xD50323FFu, // autibsp
        0xD65F03C0u, // ret
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef void * id;\n"
        "int32 +[Bar answer](void)\n"
        "{\n"
        "    uint64 local_m4;\n"
        "    uint64 self;\n"
        "    uint64 local_m8;\n"
        "    uint64 a2;\n"
        "    local_m4 = self;\n"
        "    local_m8 = a2;\n"
        "    return 42;\n"
        "}";
    run_positive("arm64e_bti_pac_aut_ret", w, 11u, 0x3000ULL, "+[Bar answer]",
                 expected, 5u, 13u, 0x301CULL);
  }

  // Negative / fail-closed tests
  {
    const uint32_t valid8[8] = {
        0xD10043FFu, 0xAA0003E8u, 0xB9000FE8u, 0xAA0103E8u,
        0xB9000BE8u, 0x528000E0u, 0x910043FFu, 0xD65F03C0u,
    };
    run_negative("neg_null_words", nullptr, 8u, 0x88ULL, "-[Foo p]", HEX_ERR_INVALID_ARG);
    run_negative("neg_zero_count", valid8, 0u, 0x88ULL, "-[Foo p]", HEX_ERR_INVALID_ARG);
    run_negative("neg_non_objc_name", valid8, 8u, 0x88ULL, "plain_func", HEX_ERR_UNSUPPORTED);
    run_negative("neg_null_name", valid8, 8u, 0x88ULL, nullptr, HEX_ERR_UNSUPPORTED);
    run_negative("neg_malformed_objc", valid8, 8u, 0x88ULL, "-[NoSpace]", HEX_ERR_UNSUPPORTED);

    // Bit 23 set in SUB sp (MTE SUBG) must fail closed
    uint32_t bad_bit23[8];
    std::memcpy(bad_bit23, valid8, sizeof(valid8));
    bad_bit23[0] |= 0x00800000u;
    run_negative("neg_sub_bit23_set", bad_bit23, 8u, 0x88ULL, "-[Foo p]", HEX_ERR_UNSUPPORTED);

    // Mismatched SP restore
    uint32_t bad_sp[8];
    std::memcpy(bad_sp, valid8, sizeof(valid8));
    bad_sp[6] = 0x910083FFu;  // add sp, sp, #0x20
    run_negative("neg_sp_mismatch", bad_sp, 8u, 0x88ULL, "-[Foo p]", HEX_ERR_UNSUPPORTED);

    // OOM rollback test
    uint8_t tiny[64];
    hex::Arena tiny_arena;
    tiny_arena.init_fixed(tiny, sizeof(tiny));
    const char* text = "stale";
    uint32_t len = 1u;
    const HexLineMapEntry* lm = nullptr;
    uint32_t lm_count = 1u;
    const HexStatus st = try_emit_arm64_objc(
        valid8, 8u, 0x88ULL, "-[Foo(Cat) p]", 13u, HEX_EMIT_FLAG_JS_PARITY, tiny_arena,
        &text, &len, &lm, &lm_count);
    check_true("neg_oom_status", st == HEX_ERR_OOM);
    check_true("neg_oom_rollback", tiny_arena.used() == 0u);
    check_true("neg_oom_cleared", text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  }

  std::printf("test_arm64_objc_emit_native: pass=%d fail=%d\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
