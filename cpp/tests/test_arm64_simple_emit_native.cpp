#include <cstdint>
#include <cstdio>
#include <cstring>

#include "decompiler/passes/arm64_simple_emit.hpp"

using hex::decompiler::passes::try_emit_arm64_simple;

static int g_pass = 0;
static int g_fail = 0;

static void check_eq_str(const char* label, const char* got, uint32_t got_len, const char* want) {
  const size_t want_len = std::strlen(want);
  if (got == nullptr || got_len != want_len || std::memcmp(got, want, want_len) != 0) {
    std::fprintf(stderr, "FAIL [%s]\n  want (%zu): %s\n  got  (%u): %s\n",
                 label, want_len, want, got_len, got ? got : "<null>");
    g_fail++;
  } else {
    g_pass++;
  }
}

static void check_true(const char* label, bool cond) {
  if (!cond) {
    std::fprintf(stderr, "FAIL [%s]\n", label);
    g_fail++;
  } else {
    g_pass++;
  }
}

static bool linemap_has(const HexLineMapEntry* lm, uint32_t count, uint32_t line_no, uint64_t addr) {
  for (uint32_t i = 0; i < count; ++i) {
    if (lm[i].line_no == line_no && lm[i].addr == addr) return true;
  }
  return false;
}

static void run_positive_case(const char* label,
                              const uint32_t* words,
                              uint32_t word_count,
                              uint64_t base_addr,
                              const char* func_name,
                              const char* expected_c,
                              uint32_t check_line_no,
                              uint64_t check_addr) {
  uint8_t mem[8192];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));

  const char* text = nullptr;
  uint32_t len = 0;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0;

  const HexStatus st = try_emit_arm64_simple(
      words, word_count, base_addr,
      func_name, static_cast<uint32_t>(std::strlen(func_name)),
      HEX_EMIT_FLAG_JS_PARITY, arena,
      &text, &len, &lm, &lm_count);
  check_true(label, st == HEX_OK);
  check_eq_str(label, text, len, expected_c);
  check_true(label, lm != nullptr && lm_count > 0);
  check_true(label, linemap_has(lm, lm_count, check_line_no, check_addr));
}

static void run_negative_case(const char* label,
                              const uint32_t* words,
                              uint32_t word_count,
                              uint64_t base_addr,
                              const char* func_name,
                              HexStatus expected_status) {
  uint8_t mem[8192];
  hex::Arena arena;
  arena.init_fixed(mem, sizeof(mem));

  const char* text = nullptr;
  uint32_t len = 0;
  const HexLineMapEntry* lm = nullptr;
  uint32_t lm_count = 0;

  const HexStatus st = try_emit_arm64_simple(
      words, word_count, base_addr,
      func_name, func_name ? static_cast<uint32_t>(std::strlen(func_name)) : 0u,
      HEX_EMIT_FLAG_JS_PARITY, arena,
      &text, &len, &lm, &lm_count);
  check_true(label, st == expected_status);
  check_true(label, text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
}

int main() {
  // 1-4. Trivial ret-only stubs (exact JS oracle from all_43_functions.json)
  {
    const uint32_t w[] = { 0xD65F03C0u };
    run_positive_case(
        "__cxa_pure_virtual", w, 1, 0x21029Cu, "__cxa_pure_virtual",
        "void cxa_pure_virtual(void)\n{\n    return;\n}",
        3u, 0x21029Cu);
    run_positive_case(
        "_start", w, 1, 0x2102A0u, "_start",
        "void start(void)\n{\n    return;\n}",
        3u, 0x2102A0u);
    run_positive_case(
        "_ZN4BaseD2Ev", w, 1, 0x2102A4u, "_ZN4BaseD2Ev",
        "void ZN4BaseD2Ev(void)\n{\n    return;\n}",
        3u, 0x2102A4u);
    run_positive_case(
        "_ZN5ThingD0Ev", w, 1, 0x2102B8u, "_ZN5ThingD0Ev",
        "void ZN5ThingD0Ev(void)\n{\n    return;\n}",
        3u, 0x2102B8u);
  }

  // 5. atexit: mov w0, wzr; ret
  {
    const uint32_t w[] = { 0x2A1F03E0u, 0xD65F03C0u };
    run_positive_case(
        "atexit", w, 2, 0x210268u, "atexit",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "int32 atexit(void)\n"
        "{\n"
        "    return 0;\n"
        "}",
        5u, 0x210268u);
  }

  // 6. arithmetic_wrap: movn w0, #0; add w0, w0, #1; ret
  {
    const uint32_t w[] = { 0x12800000u, 0x11000400u, 0xD65F03C0u };
    run_positive_case(
        "arithmetic_wrap", w, 3, 0x1000u, "arithmetic_wrap",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "int32 arithmetic_wrap(void)\n"
        "{\n"
        "    return 0;\n"
        "}",
        5u, 0x1004u);
  }

  // 7. _bkey_fn: stp x29, x30, [sp, #-16]!; mov x29, sp; mov w0, wzr; ldp x29, x30, [sp], #16; ret
  {
    const uint32_t w[] = { 0xA9BF7BFDu, 0x910003FDu, 0x2A1F03E0u, 0xA8C17BFDu, 0xD65F03C0u };
    run_positive_case(
        "_bkey_fn", w, 5, 0x4000B0u, "_bkey_fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 bkey_fn(void)\n"
        "{\n"
        "    uint64 local_m10;\n"
        "    uint64 local_x29;\n"
        "    uint64 local_m8;\n"
        "    uint64 local_x30;\n"
        "    local_m10 = local_x29;\n"
        "    local_m8 = local_x30;\n"
        "    return 0;\n"
        "}",
        12u, 0x4000B8u);
  }

  // Generalized cases (proving no function-name hardcoding)
  {
    const uint32_t w_movz[] = { 0x52800540u, 0xD65F03C0u };  // movz w0, #42; ret
    run_positive_case(
        "gen_movz_42", w_movz, 2, 0x2000u, "custom_const_42",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "int32 custom_const_42(void)\n"
        "{\n"
        "    return 42;\n"
        "}",
        5u, 0x2000u);

    // Standalone `movn w0, #0; ret` fails closed to JS for strict unsigned-literal parity.
    const uint32_t w_movn_neg[] = { 0x12800000u, 0xD65F03C0u };
    run_negative_case("gen_movn_neg1_fail_closed", w_movn_neg, 2, 0x3000u, "ret_minus_one", HEX_ERR_UNSUPPORTED);
  }

  // Negative / fail-closed cases
  {
    const uint32_t w_orr_imm[] = { 0x320003E0u, 0xD65F03C0u };  // orr w0, wzr, #1
    run_negative_case("neg_orr_imm", w_orr_imm, 2, 0x1000u, "f_orr", HEX_ERR_UNSUPPORTED);

    const uint32_t w_fmov[] = { 0x1E204000u, 0xD65F03C0u };  // fmov s0, s0
    run_negative_case("neg_fmov", w_fmov, 2, 0x1000u, "f_fmov", HEX_ERR_UNSUPPORTED);

    const uint32_t w_mneg[] = { 0x1B01FC00u, 0xD65F03C0u };  // msub/mneg w0, w0, w1, wzr
    run_negative_case("neg_mneg", w_mneg, 2, 0x1000u, "f_mneg", HEX_ERR_UNSUPPORTED);

    const uint32_t w_smull[] = { 0x9B217C00u, 0xD65F03C0u };  // smull x0, w0, w1
    run_negative_case("neg_smull", w_smull, 2, 0x1000u, "f_smull", HEX_ERR_UNSUPPORTED);

    const uint32_t w_param_add[] = { 0x11000400u, 0xD65F03C0u };  // add w0, w0, #1 (live param w0)
    run_negative_case("neg_live_param_add", w_param_add, 2, 0x1000u, "f_param", HEX_ERR_UNSUPPORTED);

    const uint32_t w_no_ret[] = { 0x2A1F03E0u };
    run_negative_case("neg_no_ret", w_no_ret, 1, 0x1000u, "f_noret", HEX_ERR_UNSUPPORTED);

    const uint32_t w_bad_frame[] = { 0xA9BF7BFDu, 0x2A1F03E0u, 0xA8C27BFDu, 0xD65F03C0u };  // disp mismatch
    run_negative_case("neg_frame_mismatch", w_bad_frame, 4, 0x1000u, "f_badframe", HEX_ERR_UNSUPPORTED);

    const uint32_t w_ret[] = { 0xD65F03C0u };
    run_negative_case("neg_objc_name", w_ret, 1, 0x1000u, "-[Foo bar]", HEX_ERR_UNSUPPORTED);
    run_negative_case("neg_empty_words", w_ret, 0, 0x1000u, "f_empty", HEX_ERR_INVALID_ARG);

    // OOM check with tiny fixed arena
    uint8_t tiny[32];
    hex::Arena tiny_arena;
    tiny_arena.init_fixed(tiny, sizeof(tiny));
    const char* text = nullptr;
    uint32_t len = 0;
    const HexLineMapEntry* lm = nullptr;
    uint32_t lm_count = 0;
    const HexStatus st = try_emit_arm64_simple(
        w_ret, 1, 0x1000u, "_start", 6u, HEX_EMIT_FLAG_JS_PARITY, tiny_arena,
        &text, &len, &lm, &lm_count);
    check_true("neg_oom", st == HEX_ERR_OOM && tiny_arena.used() == 0u);
  }


  // Wave 9 R1-R5 review regressions
  {
    // 1. 64-bit MOVZ x0 under JS_PARITY rejected
    const uint32_t w_movz_x0[] = { 0xD2800540u, 0xD65F03C0u };  // movz x0, #42; ret
    run_negative_case("w9_movz_x0_64_rejected", w_movz_x0, 2, 0x1000u, "f_movz_x0", HEX_ERR_UNSUPPORTED);

    // 2. Immediates >= 100 (#255, #1000) and `sub 0 - 1` rejected
    const uint32_t w_imm255[] = { 0x52801FE0u, 0xD65F03C0u };  // movz w0, #255; ret
    run_negative_case("w9_imm_255_rejected", w_imm255, 2, 0x1000u, "f_255", HEX_ERR_UNSUPPORTED);

    const uint32_t w_imm1000[] = { 0x52807D00u, 0xD65F03C0u };  // movz w0, #1000; ret
    run_negative_case("w9_imm_1000_rejected", w_imm1000, 2, 0x1000u, "f_1000", HEX_ERR_UNSUPPORTED);

    const uint32_t w_sub_neg1[] = { 0x2A1F03E0u, 0x51000400u, 0xD65F03C0u };  // mov w0, wzr; sub w0, w0, #1; ret
    run_negative_case("w9_sub_0_minus_1_rejected", w_sub_neg1, 3, 0x1000u, "f_sub_neg1", HEX_ERR_UNSUPPORTED);

    // 3. `nop; movn w0, #0; ret` rejected
    const uint32_t w_nop_movn[] = { 0xD503201Fu, 0x12800000u, 0xD65F03C0u };
    run_negative_case("w9_nop_movn_rejected", w_nop_movn, 3, 0x1000u, "f_nop_movn", HEX_ERR_UNSUPPORTED);

    // 4. bit-23 set ADD (0x11800400) rejected
    const uint32_t w_add_bit23[] = { 0x12800000u, 0x11800400u, 0xD65F03C0u };
    run_negative_case("w9_add_bit23_rejected", w_add_bit23, 3, 0x1000u, "f_add_b23", HEX_ERR_UNSUPPORTED);

    // 5. (nullptr, 3) returns HEX_ERR_INVALID_ARG
    uint8_t mem[4096];
    hex::Arena arena;
    arena.init_fixed(mem, sizeof(mem));
    const char* text = nullptr;
    uint32_t len = 0u;
    const HexLineMapEntry* lm = nullptr;
    uint32_t lm_count = 0u;
    const uint32_t w_ret[] = { 0xD65F03C0u };
    const HexStatus st = try_emit_arm64_simple(
        w_ret, 1, 0x1000u, nullptr, 3u, HEX_EMIT_FLAG_JS_PARITY, arena,
        &text, &len, &lm, &lm_count);
    check_true("w9_null_name_nonzero_len_invalid_arg",
               st == HEX_ERR_INVALID_ARG && text == nullptr && len == 0u && lm == nullptr && lm_count == 0u);
  }

  std::printf("test_arm64_simple_emit_native: pass=%d fail=%d\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
