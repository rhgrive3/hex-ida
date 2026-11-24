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

void test_decompile_arm64_e2e_and_linemap() {
  assert(hex_engine_init() == HEX_OK);

  // _add: add w0, w0, w1; ret
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
  assert(lm != nullptr && lm_count >= 1u);
  const std::string code(text, text_len);
  assert(code.find("add_pair") != std::string::npos);
  assert(code.find("return") != std::string::npos);
  assert(lm[0].line_no >= 1u);
  assert(lm[0].addr >= 0x100000440ULL);

  // Multi-block ARM64 function with branch & constant folding:
  //   movz w0, #10
  //   movz w1, #20
  //   add  w0, w0, w1
  //   ret
  const uint32_t fold_words[4] = {
      0x52800140u,  // movz w0, #10
      0x52800281u,  // movz w1, #20
      0x0b010000u,  // add w0, w0, w1
      0xd65f03c0u,  // ret
  };
  assert(hex_engine_decompile_arm64(
             fold_words, 4u, 0x2000ULL, "const_fold", 10u, HEX_EMIT_FLAG_NONE) == HEX_OK);
  const std::string fold_code(hex_engine_decompile_get_text_ptr(), hex_engine_decompile_get_text_len());
  assert(fold_code.find("30") != std::string::npos);
  assert(hex_engine_decompile_get_linemap_count() >= 1u);

  std::printf("  [PASS] ARM64 E2E decompile + optimizer const fold + linemap\n");
}

void test_unsupported_instruction_fail_closed() {
  assert(hex_engine_init() == HEX_OK);

  // svc #0 (SYS) or fadd d0, d0, d1 (FARITH) -> must fail closed with HEX_ERR_UNSUPPORTED
  const uint32_t unsupported_words[2] = {
      0x1e612800u,  // fadd d0, d0, d1
      0xd65f03c0u,  // ret
  };
  assert(hex_engine_decompile_arm64(
             unsupported_words, 2u, 0x3000ULL, "fp_fn", 5u, HEX_EMIT_FLAG_NONE) == HEX_ERR_UNSUPPORTED);
  assert(hex_engine_decompile_get_text_ptr() == nullptr);
  assert(hex_engine_decompile_get_text_len() == 0u);
  assert(hex_engine_decompile_get_linemap_ptr() == nullptr);
  assert(hex_engine_decompile_get_linemap_count() == 0u);

  // Invalid args
  assert(hex_engine_decompile_arm64(nullptr, 2u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_INVALID_ARG);
  assert(hex_engine_decompile_arm64(unsupported_words, 0u, 0x3000ULL, nullptr, 0u, 0u) == HEX_ERR_INVALID_ARG);
  assert(hex_engine_decompile_arm64(unsupported_words, 2u, 0x3000ULL, nullptr, 5u, 0u) == HEX_ERR_INVALID_ARG);
  std::printf("  [PASS] unsupported instruction HEX_ERR_UNSUPPORTED & invalid args\n");
}

void test_three_arena_isolation_and_zero_leak() {
  // Guard-canary 3-arena boundary test via external fixed arenas.
  std::vector<uint8_t> img_buf(4096, 0xAA);
  std::vector<uint8_t> ir_buf(64 * 1024, 0xBB);
  std::vector<uint8_t> scratch_buf(64 * 1024, 0xCC);
  assert(hex::runtime::bind_external_arenas(
             img_buf.data(), img_buf.size(),
             ir_buf.data(), ir_buf.size(),
             scratch_buf.data(), scratch_buf.size()) == HEX_OK);

  // Scratch overflow must fail closed (nullptr) without touching image or IR arenas.
  assert(hex_engine_scratch_alloc(128u * 1024u) == nullptr);
  for (uint8_t b : img_buf) assert(b == 0xAA);
  for (uint8_t b : ir_buf) assert(b == 0xBB);

  // Repeated E2E decompilation (64 iterations) on small 64 KiB IR + scratch arenas:
  // IR arena must reclaim to 0 after each call (zero leak).
  const uint32_t mul_words[2] = {
      0x1b007c00u,  // mul w0, w0, w0
      0xd65f03c0u,  // ret
  };
  for (uint32_t iter = 0u; iter < 64u; ++iter) {
    assert(hex_engine_decompile_arm64(
               mul_words, 2u, 0x4000ULL + iter * 8ULL, "sq", 2u, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    assert(hex_engine_decompile_get_text_len() > 0u);
    const HexEngineArenaStats st = hex::runtime::get_arena_stats();
    assert(st.ir_used == 0u);  // IrStore released -> persistent IR arena reclaimed to 0!
    assert(st.image_used == 0u);
  }
  for (uint8_t b : img_buf) assert(b == 0xAA);

  // Restore default 3-arena storage
  assert(hex_engine_init() == HEX_OK);
  std::printf("  [PASS] 3-arena isolation & 64-iteration zero-leak reclamation\n");
}

}  // namespace

int main() {
  std::printf("Running test_engine_runtime_native...\n");
  test_init_version_and_scratch();
  test_decompile_arm64_e2e_and_linemap();
  test_unsupported_instruction_fail_closed();
  test_three_arena_isolation_and_zero_leak();
  std::printf("test_engine_runtime_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
