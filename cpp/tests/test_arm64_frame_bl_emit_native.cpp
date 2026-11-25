#include <cstdint>
#include <cstdio>
#include <cstring>

#include "decompiler/passes/arm64_frame_bl_emit.hpp"

using hex::decompiler::passes::try_emit_arm64_frame_bl;

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
                         uint32_t bl_line,
                         uint64_t bl_addr,
                         uint32_t ret_line,
                         uint64_t ret_addr) {
  uint8_t mem[16384];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));

  const char* text = nullptr;
  uint32_t len = 0u;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0u;

  const HexStatus st = try_emit_arm64_frame_bl(
      words, word_count, base_addr,
      func_name, static_cast<uint32_t>(std::strlen(func_name)),
      HEX_EMIT_FLAG_JS_PARITY, arena,
      &text, &len, &lm, &lm_count);
  check_true(label, st == HEX_OK);
  check_eq_str(label, text, len, expected_c);
  check_true(label, lm != nullptr && lm_count > 0u);
  check_true(label, linemap_has(lm, lm_count, sig_line, base_addr));
  check_true(label, linemap_has(lm, lm_count, bl_line, bl_addr));
  check_true(label, linemap_has(lm, lm_count, ret_line, ret_addr));
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

  // Pre-fill outputs with sentinels to verify entry zero-clearing.
  const char* sentinel = "stale";
  const char* text = sentinel;
  uint32_t len = 999u;
  const HexLineMapEntry* lm = reinterpret_cast<const HexLineMapEntry*>(0x1);
  uint32_t lm_count = 999u;

  const HexStatus st = try_emit_arm64_frame_bl(
      words, word_count, base_addr,
      func_name, func_name ? static_cast<uint32_t>(std::strlen(func_name)) : 0u,
      HEX_EMIT_FLAG_JS_PARITY, arena,
      &text, &len, &lm, &lm_count);
  check_true(label, st == expected_status);
  check_true(label, text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  check_true(label, arena.used() == 0u);
}

int main() {
  // 1. macho-sample-arm64::_greet (exact 0-diff vs all_43_functions.json)
  {
    const uint32_t w[7] = {
        0xA9BF7BFDu, 0x910003FDu, 0x90000000u, 0x91152000u,
        0x9400002Eu, 0xA8C17BFDu, 0xD65F03C0u,
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
        "#ifndef __HEX_ANY_ARGS\n"
        "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
        "#define __HEX_ANY_ARGS ...\n"
        "#else\n"
        "#define __HEX_ANY_ARGS\n"
        "#endif\n"
        "#endif\n"
        "uint64 sub_10000053C (__HEX_ANY_ARGS);\n"
        "uint64 greet(void)\n"
        "{\n"
        "    uint64 local_m10;\n"
        "    uint64 local_x29;\n"
        "    uint64 local_m8;\n"
        "    uint64 local_x30;\n"
        "    uint64 call_42;\n"
        "    local_m10 = local_x29;\n"
        "    local_m8 = local_x30;\n"
        "    call_42 = sub_10000053C(/* arguments unknown */);\n"
        "    return call_42;\n"
        "}";
    run_positive("macho-sample-arm64::_greet", w, 7u, 0x100000474ULL, "_greet",
                 expected, 12u, 21u, 0x100000484ULL, 22u, 0x10000048CULL);
  }

  // 2. arm64-semantic-holdout::direct_call (exact 0-diff vs all_43_functions.json)
  {
    const uint32_t w[8] = {
        0xA9BF7BFDu, 0x910003FDu, 0xAA0103E0u, 0xAA0203E1u,
        0x94000004u, 0x91000400u, 0xA8C17BFDu, 0xD65F03C0u,
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
        "#ifndef __HEX_ANY_ARGS\n"
        "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
        "#define __HEX_ANY_ARGS ...\n"
        "#else\n"
        "#define __HEX_ANY_ARGS\n"
        "#endif\n"
        "#endif\n"
        "uint64 sub_105C (__HEX_ANY_ARGS);\n"
        "uint64 direct_call(uint64 a1, uint64 a2, uint64 a3)\n"
        "{\n"
        "    uint64 local_m10;\n"
        "    uint64 local_x29;\n"
        "    uint64 local_m8;\n"
        "    uint64 local_x30;\n"
        "    uint64 call_66;\n"
        "    local_m10 = local_x29;\n"
        "    local_m8 = local_x30;\n"
        "    call_66 = sub_105C(/* arguments unknown */);\n"
        "    return call_66 + 1;\n"
        "}";
    run_positive("arm64-semantic-holdout::direct_call", w, 8u, 0x103CULL, "direct_call",
                 expected, 12u, 21u, 0x104CULL, 22u, 0x1050ULL);
  }

  // 3. arm64-threaded-mem::entry (exact 0-diff vs all_43_functions.json)
  {
    const uint32_t w[11] = {
        0xA9BE7BFDu, 0x910003FDu, 0xD283FE09u, 0x91004129u,
        0xF9000BE9u, 0xF9400BE0u, 0x94000005u, 0xF9000BE0u,
        0xF9400BE0u, 0xA8C27BFDu, 0xD65F03C0u,
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
        "#ifndef __HEX_ANY_ARGS\n"
        "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
        "#define __HEX_ANY_ARGS ...\n"
        "#else\n"
        "#define __HEX_ANY_ARGS\n"
        "#endif\n"
        "#endif\n"
        "uint64 sub_102C (__HEX_ANY_ARGS);\n"
        "uint64 entry(void)\n"
        "{\n"
        "    uint64 local_m20;\n"
        "    uint64 local_x29;\n"
        "    uint64 local_m18;\n"
        "    uint64 local_x30;\n"
        "    uint64 local_pFFFFFFFFFFFFFFF0;\n"
        "    uint64 call_95;\n"
        "    uint64 var_FFFFFFFFFFFFFFF0;\n"
        "    local_m20 = local_x29;\n"
        "    local_m18 = local_x30;\n"
        "    local_pFFFFFFFFFFFFFFF0 = 0x2000;\n"
        "    call_95 = sub_102C(/* arguments unknown */);\n"
        "    local_pFFFFFFFFFFFFFFF0 = call_95;\n"
        "    return var_FFFFFFFFFFFFFFF0;\n"
        "}";
    run_positive("arm64-threaded-mem::entry", w, 11u, 0x1000ULL, "entry",
                 expected, 12u, 24u, 0x1018ULL, 26u, 0x1020ULL);
  }

  // Generalized case: arbitrary function name, negative BL offset, different immediate & frame size (0x30)
  {
    // stp x29,x30,[sp,#-0x30]! (imm7=-6 -> 0x7A -> 0xA9BD7BFD), ldp [sp],#0x30 (imm7=+6 -> 0xA8C37BFD)
    // bl -0x10 (imm26 = -4 = 0x03FFFFFC -> 0x97FFFFFC), add x0,x0,#7 (0x91001C00)
    const uint32_t w[8] = {
        0xA9BD7BFDu, 0x910003FDu, 0xAA0103E0u, 0xAA0203E1u,
        0x97FFFFFCu, 0x91001C00u, 0xA8C37BFDu, 0xD65F03C0u,
    };
    const char* expected =
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "/* hex: standalone external prototypes (stripped by translation unit packager). */\n"
        "#ifndef __HEX_ANY_ARGS\n"
        "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
        "#define __HEX_ANY_ARGS ...\n"
        "#else\n"
        "#define __HEX_ANY_ARGS\n"
        "#endif\n"
        "#endif\n"
        "uint64 sub_2000 (__HEX_ANY_ARGS);\n"
        "uint64 custom_wrapper(uint64 a1, uint64 a2, uint64 a3)\n"
        "{\n"
        "    uint64 local_m30;\n"
        "    uint64 local_x29;\n"
        "    uint64 local_m28;\n"
        "    uint64 local_x30;\n"
        "    uint64 call_66;\n"
        "    local_m30 = local_x29;\n"
        "    local_m28 = local_x30;\n"
        "    call_66 = sub_2000(/* arguments unknown */);\n"
        "    return call_66 + 7;\n"
        "}";
    run_positive("generalized_neg_bl_frame30", w, 8u, 0x2000ULL, "__custom_wrapper",
                 expected, 12u, 21u, 0x2010ULL, 22u, 0x2014ULL);
  }

  // Negative / fail-closed tests
  {
    const uint32_t valid7[7] = {
        0xA9BF7BFDu, 0x910003FDu, 0x90000000u, 0x91152000u,
        0x9400002Eu, 0xA8C17BFDu, 0xD65F03C0u,
    };
    // Invalid args
    run_negative("neg_null_words", nullptr, 7u, 0x1000ULL, "f", HEX_ERR_INVALID_ARG);
    run_negative("neg_zero_count", valid7, 0u, 0x1000ULL, "f", HEX_ERR_INVALID_ARG);

    // ObjC selector & leading-digit symbol
    run_negative("neg_objc_name", valid7, 7u, 0x1000ULL, "-[Obj foo]", HEX_ERR_UNSUPPORTED);
    run_negative("neg_digit_name", valid7, 7u, 0x1000ULL, "_123bad", HEX_ERR_UNSUPPORTED);

    // Bit 23 set in ADD imm (MTE ADDG / reserved sh=2) must fail closed!
    uint32_t bad_bit23[7];
    std::memcpy(bad_bit23, valid7, sizeof(valid7));
    bad_bit23[3] |= 0x00800000u;
    run_negative("neg_add_bit23_set", bad_bit23, 7u, 0x1000ULL, "f", HEX_ERR_UNSUPPORTED);

    // Mismatched LDP frame size
    uint32_t bad_ldp[7];
    std::memcpy(bad_ldp, valid7, sizeof(valid7));
    bad_ldp[5] = 0xA8C27BFDu;
    run_negative("neg_frame_mismatch", bad_ldp, 7u, 0x1000ULL, "f", HEX_ERR_UNSUPPORTED);

    // Non-BL instruction (B instead of BL)
    uint32_t bad_b[7];
    std::memcpy(bad_b, valid7, sizeof(valid7));
    bad_b[4] = 0x1400002Eu;
    run_negative("neg_b_instead_of_bl", bad_b, 7u, 0x1000ULL, "f", HEX_ERR_UNSUPPORTED);

    // Mismatched stack offset in Pattern 3
    const uint32_t bad_p3[11] = {
        0xA9BE7BFDu, 0x910003FDu, 0xD283FE09u, 0x91004129u,
        0xF9000BE9u, 0xF9400FE0u, 0x94000005u, 0xF9000BE0u,
        0xF9400BE0u, 0xA8C27BFDu, 0xD65F03C0u,
    };
    run_negative("neg_p3_offset_mismatch", bad_p3, 11u, 0x1000ULL, "f", HEX_ERR_UNSUPPORTED);

    // OOM rollback test with tiny fixed arena
    uint8_t tiny[64];
    hex::Arena tiny_arena;
    tiny_arena.init_fixed(tiny, sizeof(tiny));
    const char* text = "stale";
    uint32_t len = 1u;
    const HexLineMapEntry* lm = nullptr;
    uint32_t lm_count = 1u;
    const HexStatus st = try_emit_arm64_frame_bl(
        valid7, 7u, 0x100000474ULL, "_greet", 6u, HEX_EMIT_FLAG_JS_PARITY, tiny_arena,
        &text, &len, &lm, &lm_count);
    check_true("neg_oom_status", st == HEX_ERR_OOM);
    check_true("neg_oom_rollback", tiny_arena.used() == 0u);
    check_true("neg_oom_cleared", text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  }

  std::printf("test_arm64_frame_bl_emit_native: pass=%d fail=%d\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
