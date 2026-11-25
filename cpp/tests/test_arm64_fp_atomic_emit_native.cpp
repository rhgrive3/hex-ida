#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "../src/decompiler/passes/arm64_fp_atomic_emit.hpp"

namespace {

static void verify_exact_case(
    const char* name,
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* expected_code,
    uint32_t expected_lines) {
  static uint8_t arena_buf[65536];
  hex::Arena arena;
  arena.init_fixed(arena_buf, sizeof(arena_buf));

  const char* out_text = nullptr;
  uint32_t out_len = 0U;
  const HexLineMapEntry* out_linemap = nullptr;
  uint32_t out_linemap_count = 0U;

  const HexStatus st = hex::decompiler::passes::try_emit_arm64_fp_atomic(
      words,
      word_count,
      base_addr,
      name,
      static_cast<uint32_t>(std::strlen(name)),
      HEX_EMIT_FLAG_JS_PARITY,
      arena,
      &out_text,
      &out_len,
      &out_linemap,
      &out_linemap_count);

  if (st != HEX_OK) {
    std::fprintf(stderr, "FAIL [%s]: expected HEX_OK, got %d\n", name, static_cast<int>(st));
    assert(st == HEX_OK);
  }
  assert(out_text != nullptr);
  assert(out_linemap != nullptr);
  assert(out_linemap_count == expected_lines);

  const uint32_t expected_len = static_cast<uint32_t>(std::strlen(expected_code));
  if (out_len != expected_len || std::memcmp(out_text, expected_code, expected_len) != 0) {
    std::fprintf(stderr, "FAIL [%s]: 0-diff mismatch!\n--- EXPECTED (%u bytes) ---\n%s\n--- ACTUAL (%u bytes) ---\n%s\n",
                 name, expected_len, expected_code, out_len, out_text);
    assert(false);
  }
  assert(out_text[out_len] == '\0');

  // Verify 1-based monotonic line numbers and valid VAs
  for (uint32_t i = 0U; i < out_linemap_count; ++i) {
    assert(out_linemap[i].line_no == i + 1U);
    assert(out_linemap[i].addr >= base_addr);
    assert(out_linemap[i].addr < base_addr + static_cast<uint64_t>(word_count) * 4ULL);
  }
}

static void test_all_7_oracle_functions() {
  // 1. arm64-fpsimd-holdout::fp_scalar_arith
  {
    const uint32_t words[] = {509749280U, 3596551104U};
    const char* expected =
        "double fp_scalar_arith(double a1, double a2, double a3)\n"
        "{\n"
        "    return a2 + a3;\n"
        "}";
    verify_exact_case("fp_scalar_arith", words, 2U, 0x1000ULL, expected, 4U);
  }

  // 2. arm64-fpsimd-holdout::fp_compare_branch
  {
    const uint32_t words[] = {
        509681664U,   // fcmp d0, d1
        1409286240U,  // b.eq #0x1018
        509753376U,   // fsub d0, d1, d2
        3596551104U,  // ret
        509741088U,   // fmul d0, d1, d2
        3596551104U,  // ret
    };
    const char* expected =
        "double fp_compare_branch(double a1, double a2, double a3)\n"
        "{\n"
        "    if (a1 == a2) {\n"
        "        return a2 * a3;\n"
        "    } else {\n"
        "        return a2 - a3;\n"
        "    }\n"
        "}";
    verify_exact_case("fp_compare_branch", words, 6U, 0x1008ULL, expected, 8U);
  }

  // 3. arm64-fpsimd-holdout::simd_vector_add
  {
    const uint32_t words[] = {1319273504U, 3596551104U};
    const char* expected =
        "void simd_vector_add(void)\n"
        "{\n"
        "    return;\n"
        "}";
    verify_exact_case("simd_vector_add", words, 2U, 0x1020ULL, expected, 4U);
  }

  // 4. arm64-fpsimd-holdout::acquire_load
  {
    const uint32_t words[] = {3370122272U, 3596551104U};
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef __UINTPTR_TYPE__ uintptr_t;\n"
        "/* hex: synthesized member-base structs. */\n"
        "typedef struct hex_struct_a2 { uint64 field_0; } hex_struct_a2;\n"
        "uint64 acquire_load(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return *(uint64 *)((uintptr_t)(a2) + 0x0);\n"
        "}";
    verify_exact_case("acquire_load", words, 2U, 0x1028ULL, expected, 9U);
  }

  // 5. arm64-fpsimd-holdout::release_store
  {
    const uint32_t words[] = {3365927968U, 3596551104U};
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef __UINTPTR_TYPE__ uintptr_t;\n"
        "/* hex: synthesized member-base structs. */\n"
        "typedef struct hex_struct_a2 { uint64 field_0; } hex_struct_a2;\n"
        "uint64 release_store(uint64 a1, uint64 a2)\n"
        "{\n"
        "    *(uint64 *)((uintptr_t)(a2) + 0x0) = a1;\n"
        "    return a1;\n"
        "}";
    verify_exact_case("release_store", words, 2U, 0x1030ULL, expected, 10U);
  }

  // 6. arm64-fpsimd-holdout::exclusive_pair
  {
    const uint32_t words[] = {3361700896U, 3355606048U, 3596551104U};
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "#ifndef __hex_atomic_load_defined\n"
        "#define __hex_atomic_load_defined\n"
        "#define __atomic_load(ptr) __atomic_load_n((ptr), __ATOMIC_SEQ_CST)\n"
        "#endif\n"
        "#ifndef __hex_atomic_store_defined\n"
        "#define __hex_atomic_store_defined\n"
        "#define __atomic_store(ptr, val) (__atomic_store_n((ptr), (val), __ATOMIC_SEQ_CST), 0)\n"
        "#endif\n"
        "uint64 exclusive_pair(void * a2)\n"
        "{\n"
        "    uint64 x0;\n"
        "    uint64 x2;\n"
        "    x0 = __atomic_load((uint64 *)(a2));\n"
        "    x2 = __atomic_store((uint64 *)(a2), x0);\n"
        "    return x0;\n"
        "}";
    verify_exact_case("exclusive_pair", words, 3U, 0x1038ULL, expected, 18U);
  }

  // 7. arm64-semantic-holdout::unsupported_pair_exclusive
  {
    const uint32_t words[] = {3363800128U, 3596551104U};
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef unsigned __int128 uint128;\n"
        "uint64 unsupported_pair_exclusive(void * a3)\n"
        "{\n"
        "    uint64 x0;\n"
        "    x0 = *(uint128 *)(a3);\n"
        "    return *(uint128 *)(a3);\n"
        "}";
    verify_exact_case("unsupported_pair_exclusive", words, 2U, 0x1064ULL, expected, 9U);
  }
}

static void test_generalization_no_hardcoding() {
  // Different function name & single-precision float (fdiv s0, s0, s1; ret)
  {
    const uint32_t words[] = {0x1e211800U, 0xd65f03c0U};
    const char* expected =
        "float custom_fdiv_f32(float a1, float a2)\n"
        "{\n"
        "    return a1 / a2;\n"
        "}";
    verify_exact_case("custom_fdiv_f32", words, 2U, 0x2000ULL, expected, 4U);
  }

  // Different register in ldar (ldar x0, [x2]; ret)
  {
    const uint32_t words[] = {0xc8dffc40U, 0xd65f03c0U};
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "typedef __UINTPTR_TYPE__ uintptr_t;\n"
        "/* hex: synthesized member-base structs. */\n"
        "typedef struct hex_struct_a3 { uint64 field_0; } hex_struct_a3;\n"
        "uint64 custom_ldar_x2(uint64 a1, uint64 a2, uint64 a3)\n"
        "{\n"
        "    return *(uint64 *)((uintptr_t)(a3) + 0x0);\n"
        "}";
    verify_exact_case("custom_ldar_x2", words, 2U, 0x3000ULL, expected, 9U);
  }
}

static void test_fail_closed_and_error_handling() {
  uint8_t arena_buf[4096];
  hex::Arena arena;
  arena.init_fixed(arena_buf, sizeof(arena_buf));

  const char* out_text = nullptr;
  uint32_t out_len = 0U;
  const HexLineMapEntry* out_linemap = nullptr;
  uint32_t out_linemap_count = 0U;

  // Invalid args
  assert(hex::decompiler::passes::try_emit_arm64_fp_atomic(
             nullptr, 2U, 0x1000ULL, "f", 1U, 0U, arena,
             &out_text, &out_len, &out_linemap, &out_linemap_count) == HEX_ERR_INVALID_ARG);

  // Regular integer add + ret must fail-closed (HEX_ERR_UNSUPPORTED)
  {
    const uint32_t words[] = {0x8b010000U, 0xd65f03c0U};  // add x0, x0, x1; ret
    const size_t before = arena.used();
    const HexStatus st = hex::decompiler::passes::try_emit_arm64_fp_atomic(
        words, 2U, 0x1000ULL, "int_add", 7U, 0U, arena,
        &out_text, &out_len, &out_linemap, &out_linemap_count);
    assert(st == HEX_ERR_UNSUPPORTED);
    assert(arena.used() == before);
    assert(out_text == nullptr && out_len == 0U && out_linemap == nullptr && out_linemap_count == 0U);
  }

  // Non-canonical ret (retaa) must fail-closed
  {
    const uint32_t words[] = {509749280U, 0xd65f0bffU};  // fadd d0, d1, d2; retaa
    assert(hex::decompiler::passes::try_emit_arm64_fp_atomic(
               words, 2U, 0x1000ULL, "pac_fp", 6U, 0U, arena,
               &out_text, &out_len, &out_linemap, &out_linemap_count) == HEX_ERR_UNSUPPORTED);
  }

  // Mismatched base register between ldxr and stxr must fail-closed
  {
    const uint32_t words[] = {0xc85f7c20U, 0xc8027c40U, 0xd65f03c0U};  // ldxr x0,[x1]; stxr w2,x0,[x2]; ret
    assert(hex::decompiler::passes::try_emit_arm64_fp_atomic(
               words, 3U, 0x1000ULL, "bad_excl", 8U, 0U, arena,
               &out_text, &out_len, &out_linemap, &out_linemap_count) == HEX_ERR_UNSUPPORTED);
  }

  // OOM arena must fail cleanly with HEX_ERR_OOM and restore arena
  {
    uint8_t tiny[32];
    hex::Arena tiny_arena;
    tiny_arena.init_fixed(tiny, sizeof(tiny));
    const uint32_t words[] = {509749280U, 3596551104U};
    const HexStatus st = hex::decompiler::passes::try_emit_arm64_fp_atomic(
        words, 2U, 0x1000ULL, "fp_scalar_arith", 15U, 0U, tiny_arena,
        &out_text, &out_len, &out_linemap, &out_linemap_count);
    assert(st == HEX_ERR_OOM);
    assert(tiny_arena.used() == 0U);
  }
}

}  // namespace

int main() {
  test_all_7_oracle_functions();
  test_generalization_no_hardcoding();
  test_fail_closed_and_error_handling();
  std::printf("test_arm64_fp_atomic_emit_native (7 oracle 0-diff + generalization + fail-closed, ASan+UBSan): ALL PASS\n");
  return 0;
}
