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

}  // namespace

int main() {
  std::printf("Running test_engine_runtime_native...\n");
  test_init_version_and_scratch();
  test_decompile_arm64_e2e_and_folded_linemap();
  test_emit_arena_isolation_from_scratch();
  test_strict_parity_rejections();
  test_three_arena_isolation_and_zero_leak();
  std::printf("test_engine_runtime_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
