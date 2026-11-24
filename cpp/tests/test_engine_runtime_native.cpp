#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../src/engine_runtime.hpp"

namespace {

void test_init_version_and_scratch() {
  assert(hex_engine_init() == HEX_OK);
  assert(hex_engine_version() == HEX_ENGINE_ABI_VERSION);

  void* p1 = hex_engine_scratch_alloc(128u);
  assert(p1 != nullptr);
  assert((reinterpret_cast<uintptr_t>(p1) & 7u) == 0u);
  assert(hex_engine_scratch_alloc(0u) == nullptr);

  hex_engine_scratch_reset();
  const HexEngineArenaStats st = hex::runtime::get_arena_stats();
  assert(st.scratch_used == 0u);
  assert(st.image_cap == HEX_ENGINE_IMAGE_ARENA_BYTES);
  assert(st.ir_cap == HEX_ENGINE_IR_ARENA_BYTES);
  assert(st.scratch_cap == HEX_ENGINE_SCRATCH_ARENA_BYTES);
  std::printf("  [PASS] init, version, and scratch alloc/reset\n");
}

void test_decompile_arm64_e2e_and_folded_linemap() {
  assert(hex_engine_init() == HEX_OK);

  // _add: add w0, w0, w1 (0x100000440); ret (0x100000444)
  const uint32_t add_words[2] = {
      0x0b010000u,  // add w0, w0, w1
      0xd65f03c0u,  // ret
  };
  const char* name = "add_pair";
  assert(hex_engine_decompile_arm64(
             add_words, 2u, 0x100000440ULL, name,
             static_cast<uint32_t>(std::strlen(name)),
             HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);

  const char* text = hex_engine_decompile_get_text_ptr();
  const uint32_t text_len = hex_engine_decompile_get_text_len();
  const HexLineMapEntry* lm = hex_engine_decompile_get_linemap_ptr();
  const uint32_t lm_count = hex_engine_decompile_get_linemap_count();

  assert(text != nullptr && text_len > 0u);
  assert(lm != nullptr && lm_count >= 2u);
  const std::string code(text, text_len);
  assert(code.find("add_pair(uint64 a1, uint64 a2)") != std::string::npos);
  assert(code.find("return a1 + a2;") != std::string::npos);

  // R2 Major-4: folded `return a1 + a2;` line must record BOTH 0x100000440 and 0x100000444.
  bool saw_add_va = false;
  bool saw_ret_va = false;
  for (uint32_t i = 0u; i < lm_count; ++i) {
    assert(lm[i].line_no >= 1u);
    if (lm[i].addr == 0x100000440ULL) saw_add_va = true;
    if (lm[i].addr == 0x100000444ULL) saw_ret_va = true;
  }
  assert(saw_add_va && saw_ret_va);

  // Constant-return function: `movz w0, #42; ret` -> 0 args (`void`), NOT 1 arg!
  const uint32_t const_words[2] = {
      0x52800540u,  // movz w0, #42
      0xd65f03c0u,  // ret
  };
  assert(hex_engine_decompile_arm64(
             const_words, 2u, 0x2000ULL, "ret42", 5u, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
  const std::string c42(hex_engine_decompile_get_text_ptr(), hex_engine_decompile_get_text_len());
  assert(c42.find("ret42(void)") != std::string::npos);
  assert(c42.find("return 42;") != std::string::npos);

  // Constant folding through optimizer: movz w0, #10; movz w1, #20; add w0, w0, w1; ret
  const uint32_t fold_words[4] = {
      0x52800140u,  // movz w0, #10
      0x52800281u,  // movz w1, #20
      0x0b010000u,  // add w0, w0, w1
      0xd65f03c0u,  // ret
  };
  assert(hex_engine_decompile_arm64(
             fold_words, 4u, 0x2100ULL, "const_fold", 10u, HEX_EMIT_FLAG_NONE) == HEX_OK);
  const std::string fold_code(hex_engine_decompile_get_text_ptr(), hex_engine_decompile_get_text_len());
  assert(fold_code.find("const_fold(void)") != std::string::npos);
  assert(fold_code.find("30") != std::string::npos);

  std::printf("  [PASS] ARM64 E2E decompile + folded linemap + strict arg inference\n");
}

void test_emit_arena_isolation_from_scratch() {
  assert(hex_engine_init() == HEX_OK);
  hex_engine_scratch_reset();

  // Allocate words + func_name directly on g_scratch_arena (simulating WASM JS bridge).
  uint32_t* words_in_scratch = static_cast<uint32_t*>(hex_engine_scratch_alloc(2u * sizeof(uint32_t)));
  char* name_in_scratch = static_cast<char*>(hex_engine_scratch_alloc(16u));
  assert(words_in_scratch != nullptr && name_in_scratch != nullptr);
  words_in_scratch[0] = 0x0b010000u;  // add w0, w0, w1
  words_in_scratch[1] = 0xd65f03c0u;  // ret
  std::memcpy(name_in_scratch, "scratch_fn", 11u);

  const uint32_t used_before = hex::runtime::get_arena_stats().scratch_used;
  assert(hex_engine_decompile_arm64(
             words_in_scratch, 2u, 0x1000ULL, name_in_scratch, 10u, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);

  // 1. Caller's scratch inputs must be completely untouched, and scratch cursor restored.
  assert(words_in_scratch[0] == 0x0b010000u);
  assert(words_in_scratch[1] == 0xd65f03c0u);
  assert(std::memcmp(name_in_scratch, "scratch_fn", 11u) == 0);
  assert(hex::runtime::get_arena_stats().scratch_used == used_before);

  // 2. Capture emitted text & linemap, then clobber g_scratch_arena with subsequent allocations.
  const char* text_ptr = hex_engine_decompile_get_text_ptr();
  const uint32_t text_len = hex_engine_decompile_get_text_len();
  const HexLineMapEntry* lm_ptr = hex_engine_decompile_get_linemap_ptr();
  const uint32_t lm_cnt = hex_engine_decompile_get_linemap_count();
  assert(text_ptr != nullptr && text_len > 0u && lm_ptr != nullptr && lm_cnt >= 2u);
  const std::string snapshot(text_ptr, text_len);
  const std::vector<HexLineMapEntry> lm_snapshot(lm_ptr, lm_ptr + lm_cnt);

  hex_engine_scratch_reset();
  void* clobber = hex_engine_scratch_alloc(256u * 1024u);
  assert(clobber != nullptr);
  std::memset(clobber, 0x5A, 256u * 1024u);

  // Emitted text & linemap live in g_emit_arena -> must remain byte-for-byte intact!
  assert(std::string(text_ptr, text_len) == snapshot);
  for (uint32_t i = 0u; i < lm_cnt; ++i) {
    assert(lm_ptr[i].line_no == lm_snapshot[i].line_no);
    assert(lm_ptr[i].block_id == lm_snapshot[i].block_id);
    assert(lm_ptr[i].addr == lm_snapshot[i].addr);
  }
  std::printf("  [PASS] g_emit_arena isolation & scratch clobber survival (no aliasing UAF)\n");
}

void test_strict_parity_rejections() {
  assert(hex_engine_init() == HEX_OK);

  // 1. Non-canonical `ret x8` (0xd65f0100) must be rejected by arm64_decode & runtime.
  assert(hex_arm64_is_decompiler_supported(0xd65f03c0u) == 1);
  assert(hex_arm64_is_decompiler_supported(0xd65f0100u) == 0);
  const uint32_t ret_x8[2] = {0x52800020u, 0xd65f0100u};
  assert(hex_engine_decompile_arm64(ret_x8, 2u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_UNSUPPORTED);

  // 2. Unsupported FP instruction (`fadd d0, d0, d1`)
  const uint32_t fp_words[2] = {0x1e612800u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(fp_words, 2u, 0x3000ULL, "fp_fn", 5u, 0u) == HEX_ERR_UNSUPPORTED);

  // 3. word_count > 16 (17 instructions)
  uint32_t long_words[17];
  for (int i = 0; i < 16; ++i) long_words[i] = 0x0b010000u;  // add w0, w0, w1
  long_words[16] = 0xd65f03c0u;                              // ret
  assert(hex_engine_decompile_arm64(long_words, 17u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_UNSUPPORTED);

  // 4. Undefined non-argument register read (`add x0, x0, x9; ret`)
  const uint32_t undef_x9[2] = {0x8b090000u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(undef_x9, 2u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_UNSUPPORTED);

  // 5. Return without writing x0/w0 (`add x2, x0, x1; ret`)
  const uint32_t no_x0_write[2] = {0x8b010002u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(no_x0_write, 2u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_UNSUPPORTED);

  // 6. Dead write (`movz x9, #1; movz x0, #2; ret`)
  const uint32_t dead_write[3] = {0xd2800029u, 0xd2800040u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(dead_write, 3u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_UNSUPPORTED);

  // 7. Gapped argument register (`mov x0, x1; ret` reads x1 without reading x0)
  const uint32_t gapped_arg[2] = {0xaa0103e0u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(gapped_arg, 2u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_UNSUPPORTED);

  // 8. Invalid args
  assert(hex_engine_decompile_arm64(nullptr, 2u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_INVALID_ARG);
  assert(hex_engine_decompile_arm64(fp_words, 0u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_INVALID_ARG);
  assert(hex_engine_decompile_arm64(fp_words, 2u, 0x3000ULL, nullptr, 5u, 0u) == HEX_ERR_INVALID_ARG);

  std::printf("  [PASS] strict 0-bit parity rejections & invalid args\n");
}

void test_three_arena_isolation_and_zero_leak() {
  std::vector<uint8_t> img_buf(4096, 0xAA);
  std::vector<uint8_t> ir_buf(64 * 1024, 0xBB);
  std::vector<uint8_t> scratch_buf(64 * 1024, 0xCC);
  assert(hex::runtime::bind_external_arenas(
             img_buf.data(), img_buf.size(),
             ir_buf.data(), ir_buf.size(),
             scratch_buf.data(), scratch_buf.size()) == HEX_OK);

  assert(hex_engine_scratch_alloc(128u * 1024u) == nullptr);
  for (uint8_t b : img_buf) assert(b == 0xAA);
  for (uint8_t b : ir_buf) assert(b == 0xBB);

  const uint32_t mul_words[2] = {
      0x1b007c00u,  // mul w0, w0, w0
      0xd65f03c0u,  // ret
  };
  for (uint32_t iter = 0u; iter < 64u; ++iter) {
    assert(hex_engine_decompile_arm64(
               mul_words, 2u, 0x4000ULL + iter * 8ULL, "sq", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    assert(hex_engine_decompile_get_text_len() > 0u);
    const HexEngineArenaStats st = hex::runtime::get_arena_stats();
    assert(st.ir_used == 0u);
    assert(st.scratch_used == 0u);
    assert(st.image_used == 0u);
  }
  for (uint8_t b : img_buf) assert(b == 0xAA);

  assert(hex_engine_init() == HEX_OK);
  std::printf("  [PASS] 3-arena isolation & 64-iteration zero-leak reclamation\n");
}


void test_wave7_expanded_arm64_lifting_0diff() {
  assert(hex_engine_init() == HEX_OK);

  auto expect_exact = [](const uint32_t* words, uint32_t count, const char* name, const char* expected_full) {
    assert(hex_engine_decompile_arm64(
               words, count, 0x1000ULL, name,
               static_cast<uint32_t>(std::strlen(name)),
               HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string got(hex_engine_decompile_get_text_ptr(), hex_engine_decompile_get_text_len());
    if (got != expected_full) {
      std::fprintf(stderr, "MISMATCH for %s:\n--- GOT ---\n%s\n--- EXP ---\n%s\n",
                   name, got.c_str(), expected_full);
      assert(false);
    }
  };

  // 1. ADD (immediate): add w0, w0, #1; ret
  {
    const uint32_t w[2] = {0x11000400u, 0xd65f03c0u};
    expect_exact(w, 2u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 fn(uint64 a1)\n"
        "{\n"
        "    return a1 + 1;\n"
        "}");
  }

  // 2. SUB (immediate): sub x0, x0, #4; ret
  {
    const uint32_t w[2] = {0xd1001000u, 0xd65f03c0u};
    expect_exact(w, 2u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "uint64 fn(uint64 a1)\n"
        "{\n"
        "    return a1 - 4;\n"
        "}");
  }

  // 3. SUB (shifted register): sub w0, w0, w1; ret
  {
    const uint32_t w[2] = {0x4b010000u, 0xd65f03c0u};
    expect_exact(w, 2u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 fn(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 - a2;\n"
        "}");
  }

  // 4. AND (register): and w0, w0, w1; ret
  {
    const uint32_t w[2] = {0x0a010000u, 0xd65f03c0u};
    expect_exact(w, 2u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 fn(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 & a2;\n"
        "}");
  }

  // 5. EOR (register): eor x0, x0, x1; ret
  {
    const uint32_t w[2] = {0xca010000u, 0xd65f03c0u};
    expect_exact(w, 2u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "uint64 fn(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 ^ a2;\n"
        "}");
  }

  // 6. NOP skip: nop; add w0, w0, w1; ret
  {
    const uint32_t w[3] = {0xd503201fu, 0x0b010000u, 0xd65f03c0u};
    expect_exact(w, 3u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 fn(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 + a2;\n"
        "}");
  }

  // 7. MOVZ simple constants (decimal <= 99 and uppercase hex >= 1000)
  {
    const uint32_t w42[2] = {0x52800540u, 0xd65f03c0u};  // movz w0, #42; ret
    expect_exact(w42, 2u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "int32 fn(void)\n"
        "{\n"
        "    return 42;\n"
        "}");

    const uint32_t w1234[2] = {0xd2824680u, 0xd65f03c0u};  // movz x0, #0x1234; ret
    expect_exact(w1234, 2u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "uint64 fn(void)\n"
        "{\n"
        "    return 0x1234;\n"
        "}");

    const uint32_t w10000[2] = {0xd2a00020u, 0xd65f03c0u};  // movz x0, #1, lsl #16; ret
    expect_exact(w10000, 2u, "fn",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "uint64 fn(void)\n"
        "{\n"
        "    return 0x10000;\n"
        "}");
  }

  // 8. Fail-closed checks (must return HEX_ERR_UNSUPPORTED to preserve 0-diff):
  //    (a) Frame prologue/epilogue (JS emits local_m10/local_x29 stack saves -> must fail-closed)
  const uint32_t frame_fn[5] = {
      0xa9bf7bfdu,  // stp x29, x30, [sp, #-16]!
      0x910003fdu,  // mov x29, sp
      0x0b010000u,  // add w0, w0, w1
      0xa8c17bfdu,  // ldp x29, x30, [sp], #16
      0xd65f03c0u,  // ret
  };
  assert(hex_engine_decompile_arm64(frame_fn, 5u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  //    (b) Constant in [100..999] (JS prints 0xFF, c_emitter prints 255 -> fail-closed)
  const uint32_t movz_255[2] = {0x52801fe0u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(movz_255, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  //    (c) Folded constant landing in [100..999]: movz w0, #60; movz w1, #60; add w0, w0, w1; ret -> 120
  const uint32_t fold_120[4] = {0x52800780u, 0x52800781u, 0x0b010000u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(fold_120, 4u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  //    (d) ADD immediate #0 (optimizer folds a1 + 0 -> a1 while JS prints a1 + 0 -> fail-closed)
  const uint32_t add_zero[2] = {0x11000000u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(add_zero, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  //    (e) BIC (N=1) and shifted AND (imm6 != 0) -> fail-closed
  const uint32_t bic_w[2] = {0x0a210000u, 0xd65f03c0u};
  const uint32_t and_sh[2] = {0x0a010400u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(bic_w, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);
  assert(hex_engine_decompile_arm64(and_sh, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  std::printf("  [PASS] Wave 7 expanded ARM64 lifting 0-diff & fail-closed checks\n");
}


void test_wave8_shifts_and_mov_alias_0diff() {
  assert(hex_engine_init() == HEX_OK);

  auto expect_exact = [](const uint32_t* words, uint32_t count, const char* name, const char* expected_full) {
    assert(hex_engine_decompile_arm64(
               words, count, 0x1000ULL, name,
               static_cast<uint32_t>(std::strlen(name)),
               HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string got(hex_engine_decompile_get_text_ptr(), hex_engine_decompile_get_text_len());
    if (got != expected_full) {
      std::fprintf(stderr, "MISMATCH for %s:\n--- GOT ---\n%s\n--- EXP ---\n%s\n",
                   name, got.c_str(), expected_full);
      assert(false);
    }
  };

  // 1. Variable shifts (LSLV / LSRV / ASRV, 32-bit & 64-bit, rn != rm): 0-diff with JS decompile-base.js
  {
    const uint32_t lsl_w[2] = {0x1ac12000u, 0xd65f03c0u};  // lsl w0, w0, w1; ret
    expect_exact(lsl_w, 2u, "lsl_w",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 lsl_w(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 << (a2 & 31);\n"
        "}");

    const uint32_t lsl_x[2] = {0x9ac12000u, 0xd65f03c0u};  // lsl x0, x0, x1; ret
    expect_exact(lsl_x, 2u, "lsl_x",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "uint64 lsl_x(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 << (a2 & 63);\n"
        "}");

    const uint32_t lsr_w[2] = {0x1ac12400u, 0xd65f03c0u};  // lsr w0, w0, w1; ret
    expect_exact(lsr_w, 2u, "lsr_w",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 lsr_w(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 >> (a2 & 31);\n"
        "}");

    const uint32_t lsr_x[2] = {0x9ac12400u, 0xd65f03c0u};  // lsr x0, x0, x1; ret
    expect_exact(lsr_x, 2u, "lsr_x",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "uint64 lsr_x(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 >> (a2 & 63);\n"
        "}");

    const uint32_t asr_w[2] = {0x1ac12800u, 0xd65f03c0u};  // asr w0, w0, w1; ret
    expect_exact(asr_w, 2u, "asr_w",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 asr_w(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 >> (a2 & 31);\n"
        "}");

    const uint32_t asr_x[2] = {0x9ac12800u, 0xd65f03c0u};  // asr x0, x0, x1; ret
    expect_exact(asr_x, 2u, "asr_x",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "uint64 asr_x(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 >> (a2 & 63);\n"
        "}");

    // Shift into temp register followed by add: (a1 << (a2 & 31)) + a2
    const uint32_t lsl_temp_add[3] = {0x1ac12002u, 0x0b010040u, 0xd65f03c0u};
    expect_exact(lsl_temp_add, 3u, "lsl_temp_add",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 lsl_temp_add(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return (a1 << (a2 & 31)) + a2;\n"
        "}");
  }

  // 2. Register MOV alias via temp registers (orr wd, wzr, wm / orr xd, xzr, xm)
  {
    // mov w2, w0; add w0, w2, w1; ret -> return a1 + a2;
    const uint32_t mov_temp_w[3] = {0x2a0003e2u, 0x0b010040u, 0xd65f03c0u};
    expect_exact(mov_temp_w, 3u, "mov_temp_w",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 mov_temp_w(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 + a2;\n"
        "}");

    // mov x2, x0; add x0, x2, x1; ret -> return a1 + a2;
    const uint32_t mov_temp_x[3] = {0xaa0003e2u, 0x8b010040u, 0xd65f03c0u};
    expect_exact(mov_temp_x, 3u, "mov_temp_x",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "uint64 mov_temp_x(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 + a2;\n"
        "}");

    // mov w2, w0; mov w3, w1; add w0, w2, w3; ret -> return a1 + a2;
    const uint32_t mov_two_w[4] = {0x2a0003e2u, 0x2a0103e3u, 0x0b030040u, 0xd65f03c0u};
    expect_exact(mov_two_w, 4u, "mov_two_w",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 mov_two_w(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 + a2;\n"
        "}");

    // mov w2, w0; lsl w0, w2, w1; ret -> return a1 << (a2 & 31);
    const uint32_t mov_then_lsl[3] = {0x2a0003e2u, 0x1ac12040u, 0xd65f03c0u};
    expect_exact(mov_then_lsl, 3u, "mov_then_lsl",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "typedef __UINT64_TYPE__ uint64;\n"
        "int32 mov_then_lsl(uint64 a1, uint64 a2)\n"
        "{\n"
        "    return a1 << (a2 & 31);\n"
        "}");

    // movz w2, #5; mov w0, w2; ret -> return 5;
    const uint32_t mov_const[3] = {0x528000a2u, 0x2a0203e0u, 0xd65f03c0u};
    expect_exact(mov_const, 3u, "mov_const",
        "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n"
        "typedef __INT32_TYPE__ int32;\n"
        "int32 mov_const(void)\n"
        "{\n"
        "    return 5;\n"
        "}");
  }

  // 3. Fail-closed rejections (must return HEX_ERR_UNSUPPORTED)
  // (a) Variable shift with rn == rm
  const uint32_t lsl_same[2] = {0x1ac02000u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(lsl_same, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  // (b) RORV (op2=0x0b)
  const uint32_t ror_w[2] = {0x1ac12c00u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(ror_w, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  // (c) Shift with computed LHS under JS_PARITY (parenthesization divergence guard)
  const uint32_t add_then_lsl[3] = {0x0b010000u, 0x1ac22000u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(add_then_lsl, 3u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  // (d) Pure MOV-only functions (JS emits `(void) { uint64 a1; return a1; }`)
  const uint32_t mov_self[2] = {0x2a0003e0u, 0xd65f03c0u};
  const uint32_t mov_chain[3] = {0xaa0003e2u, 0xaa0203e0u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(mov_self, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);
  assert(hex_engine_decompile_arm64(mov_chain, 3u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  // (e) Gapped argument MOV (`mov x0, x1; ret`)
  const uint32_t mov_gap[2] = {0xaa0103e0u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(mov_gap, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  // (f) Alias-resolved self-operand SUB / SHIFT via MOV
  const uint32_t mov_sub_same[3] = {0x2a0003e2u, 0x4b000040u, 0xd65f03c0u};
  const uint32_t mov_lsl_same[3] = {0x2a0003e2u, 0x1ac02040u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(mov_sub_same, 3u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);
  assert(hex_engine_decompile_arm64(mov_lsl_same, 3u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  // (g) Existing fail-closed invariants: rn==rm SUB/AND/EOR & unallocated sh[1] bit
  const uint32_t sub_same[2] = {0x4b000000u, 0xd65f03c0u};
  const uint32_t and_same[2] = {0x0a000000u, 0xd65f03c0u};
  const uint32_t eor_same[2] = {0xca000000u, 0xd65f03c0u};
  const uint32_t bad_sh1[2] = {0x11800400u, 0xd65f03c0u};
  assert(hex_engine_decompile_arm64(sub_same, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);
  assert(hex_engine_decompile_arm64(and_same, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);
  assert(hex_engine_decompile_arm64(eor_same, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);
  assert(hex_engine_decompile_arm64(bad_sh1, 2u, 0x1000ULL, "fn", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_ERR_UNSUPPORTED);

  std::printf("  [PASS] Wave 8 variable shifts & MOV alias 0-diff + fail-closed checks\n");
}

}  // namespace

int main() {
  std::printf("Running test_engine_runtime_native...\n");
  test_init_version_and_scratch();
  test_decompile_arm64_e2e_and_folded_linemap();
  test_emit_arena_isolation_from_scratch();
  test_strict_parity_rejections();
  test_three_arena_isolation_and_zero_leak();
  test_wave7_expanded_arm64_lifting_0diff();
  test_wave8_shifts_and_mov_alias_0diff();
  std::printf("test_engine_runtime_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
