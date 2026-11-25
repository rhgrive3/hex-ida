#include "../src/targets/x86_64_decomp.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace {

int g_failures = 0;

void fail_msg(const char* expr, int line) {
  std::fprintf(stderr, "FAIL (line %d): %s\n", line, expr);
  ++g_failures;
}

#define CHECK(cond) \
  do { \
    if (!(cond)) fail_msg(#cond, __LINE__); \
  } while (0)

bool read_file_slice(const char* path, size_t offset, size_t size, uint8_t* out_buf) {
  std::FILE* fp = std::fopen(path, "rb");
  if (!fp) return false;
  if (std::fseek(fp, static_cast<long>(offset), SEEK_SET) != 0) {
    std::fclose(fp);
    return false;
  }
  const size_t n = std::fread(out_buf, 1, size, fp);
  std::fclose(fp);
  return n == size;
}

std::string get_emitted_text() {
  const char* p = hex_x86_64_decomp_get_text_ptr();
  const uint32_t n = hex_x86_64_decomp_get_text_len();
  if (!p || n == 0u) return std::string();
  return std::string(p, n);
}

void test_sysv_amd64_straight_line() {
  // 1. endbr64; lea eax, [rdi + rsi]; ret
  {
    const uint8_t code[] = {0xf3, 0x0f, 0x1e, 0xfa, 0x8d, 0x04, 0x37, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401000ULL, "add_sysv", 8u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int32 add_sysv(uint64 a1, uint64 a2)") != std::string::npos);
    CHECK(text.find("return a1 + a2;") != std::string::npos);
    CHECK(hex_x86_64_decomp_get_linemap_ptr() != nullptr);
    CHECK(hex_x86_64_decomp_get_linemap_count() >= 1u);
  }

  // 2. lea rax, [rdi + rsi*4 + 8]; ret
  {
    const uint8_t code[] = {0x48, 0x8d, 0x44, 0xb7, 0x08, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401100ULL, "lea_scaled", 10u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("uint64 lea_scaled(uint64 a1, uint64 a2)") != std::string::npos);
    CHECK(text.find("a2 * 4") != std::string::npos);
    CHECK(text.find("+ 8") != std::string::npos);
  }

  // 3. mov eax, edi; imul eax, esi; add eax, edx; ret
  {
    const uint8_t code[] = {0x89, 0xf8, 0x0f, 0xaf, 0xc6, 0x01, 0xd0, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401200ULL, "fma3", 4u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int32 fma3(uint64 a1, uint64 a2, uint64 a3)") != std::string::npos);
    CHECK(text.find("return a1 * a2 + a3;") != std::string::npos);
  }

  // 4. xor eax, eax; ret
  {
    const uint8_t code[] = {0x31, 0xc0, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401300ULL, "zero", 4u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int32 zero(void)") != std::string::npos);
    CHECK(text.find("return 0;") != std::string::npos);
  }

  // 5. Frame prologue + leave; ret: push rbp; mov rbp, rsp; mov eax, edi; add eax, 1; leave; ret
  {
    const uint8_t code[] = {0x55, 0x48, 0x89, 0xe5, 0x89, 0xf8, 0x83, 0xc0, 0x01, 0xc9, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401500ULL, "inc_leave", 9u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int32 inc_leave(uint64 a1)") != std::string::npos);
    CHECK(text.find("return a1 + 1;") != std::string::npos);
  }
}

void test_microsoft_x64_straight_line() {
  // 1. lea eax, [rcx + rdx]; ret
  {
    const uint8_t code[] = {0x8d, 0x04, 0x11, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x140001000ULL, "add_win64", 9u, HEX_X86_ABI_MICROSOFT_X64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int32 add_win64(uint64 a1, uint64 a2)") != std::string::npos);
    CHECK(text.find("return a1 + a2;") != std::string::npos);
  }

  // 2. Reading rdi on Microsoft x64 is NOT a param register -> fail-closed HEX_ERR_UNSUPPORTED
  {
    const uint8_t code[] = {0x89, 0xf8, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x140001200ULL, "bad_win64", 9u, HEX_X86_ABI_MICROSOFT_X64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_ERR_UNSUPPORTED);
  }
}

void test_three_real_x86_64_binaries() {
  struct BinSpec {
    const char* name;
    const char* path;
    size_t offset;
    size_t size;
    uint64_t base;
    uint32_t abi;
  };
  const BinSpec specs[3] = {
      {"p5_vertical_seed", "tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf", 4096u, 77u, 0x401000ULL, HEX_X86_ABI_SYSV_AMD64},
      {"sub_140001000", "tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe", 1024u, 84u, 0x140001000ULL, HEX_X86_ABI_MICROSOFT_X64},
      {"p5_vertical_macho", "tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o", 384u, 77u, 0x0ULL, HEX_X86_ABI_SYSV_AMD64},
  };

  for (const auto& sp : specs) {
    uint8_t buf[128];
    CHECK(read_file_slice(sp.path, sp.offset, sp.size, buf));

    const HexStatus st = hex_engine_decompile_x86_64(
        buf, static_cast<uint32_t>(sp.size), sp.base,
        sp.name, static_cast<uint32_t>(std::strlen(sp.name)),
        sp.abi, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);

    const std::string text = get_emitted_text();
    const HexLineMapEntry* lm = hex_x86_64_decomp_get_linemap_ptr();
    const uint32_t lm_cnt = hex_x86_64_decomp_get_linemap_count();
    CHECK(!text.empty());
    CHECK(lm != nullptr && lm_cnt >= 3u);
    CHECK(text.find("(uint64 a1, uint64 a2)") != std::string::npos);
    CHECK(text.find("if (") != std::string::npos);
    CHECK(text.find("return ") != std::string::npos);
    CHECK(text.find("*(uint32*)(") != std::string::npos);
    std::printf("  [PASS] real binary %s: %zu bytes C, %u linemap entries\n",
                sp.name, text.size(), lm_cnt);
  }
}

void test_x86_64_loop_structuring() {
  // sum_loop(uint64 a1):
  //   0x00: 31 c0          xor eax, eax
  //   0x02: 31 c9          xor ecx, ecx
  //   0x04: 39 f9          cmp ecx, edi
  //   0x06: 7d 09          jge +9 (-> 0x11 done)
  //   0x08: 01 c8          add eax, ecx        (loop header)
  //   0x0a: 83 c1 01       add ecx, 1
  //   0x0d: 39 f9          cmp ecx, edi
  //   0x0f: 7c f7          jl -9 (-> 0x08 loop)
  //   0x11: c3             ret
  const uint8_t code[] = {
      0x31, 0xc0,
      0x31, 0xc9,
      0x39, 0xf9,
      0x7d, 0x09,
      0x01, 0xc8,
      0x83, 0xc1, 0x01,
      0x39, 0xf9,
      0x7c, 0xf7,
      0xc3,
  };
  const HexStatus st = hex_engine_decompile_x86_64(
      code, sizeof(code), 0x500000ULL, "sum_loop", 8u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
  CHECK(st == HEX_OK);
  const std::string text = get_emitted_text();
  CHECK(text.find("int32 sum_loop(uint64 a1)") != std::string::npos);
  CHECK(text.find("while") != std::string::npos || text.find("do {") != std::string::npos);
  CHECK(text.find("return ") != std::string::npos);
  CHECK(hex_x86_64_decomp_get_linemap_ptr() != nullptr);
  CHECK(hex_x86_64_decomp_get_linemap_count() >= 3u);
  std::printf("  [PASS] x86_64 loop structuring: %zu bytes C, %u linemap entries\n",
              text.size(), hex_x86_64_decomp_get_linemap_count());
}

void test_negative_and_fail_closed() {
  const uint8_t ok_ret[] = {0xc3};
  CHECK(hex_engine_decompile_x86_64(nullptr, 1u, 0, nullptr, 0, 0, 0) == HEX_ERR_INVALID_ARG);
  CHECK(hex_engine_decompile_x86_64(ok_ret, 0u, 0, nullptr, 0, 0, 0) == HEX_ERR_INVALID_ARG);
  CHECK(hex_engine_decompile_x86_64(ok_ret, 1u, 0, nullptr, 4u, 0, 0) == HEX_ERR_INVALID_ARG);
  CHECK(hex_engine_decompile_x86_64(ok_ret, 1u, 0, nullptr, 0, 2u, 0) == HEX_ERR_INVALID_ARG);

  // Truncated CALL rel32: e8 01 00
  const uint8_t trunc_call[] = {0xe8, 0x01, 0x00};
  CHECK(hex_engine_decompile_x86_64(trunc_call, sizeof(trunc_call), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);

  // Truncated MOV / LEA
  const uint8_t trunc_mov[] = {0x48, 0x89};
  const uint8_t trunc_lea[] = {0x48, 0x8d, 0x44};
  CHECK(hex_engine_decompile_x86_64(trunc_mov, sizeof(trunc_mov), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);
  CHECK(hex_engine_decompile_x86_64(trunc_lea, sizeof(trunc_lea), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);

  // Unsupported prefix (LOCK add)
  const uint8_t lock_add[] = {0xf0, 0x01, 0xc0, 0xc3};
  CHECK(hex_engine_decompile_x86_64(lock_add, sizeof(lock_add), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);

  // Out-of-bounds jump target (jmp +0x40)
  const uint8_t oob_jmp[] = {0xeb, 0x40, 0xc3};
  CHECK(hex_engine_decompile_x86_64(oob_jmp, sizeof(oob_jmp), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);

  // Conditional jump without preceding cmp
  const uint8_t bare_jcc[] = {0x74, 0x00, 0xc3};
  CHECK(hex_engine_decompile_x86_64(bare_jcc, sizeof(bare_jcc), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);

  // Direct call (unsupported in standalone x86_64 decomp)
  const uint8_t call_fn[] = {0xe8, 0x00, 0x00, 0x00, 0x00, 0xc3};
  CHECK(hex_engine_decompile_x86_64(call_fn, sizeof(call_fn), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);

  // Missing RET / non-rbp push rbx (0x53)
  const uint8_t no_ret[] = {0x89, 0xf8};
  const uint8_t push_rbx[] = {0x53, 0x5b, 0xc3};
  CHECK(hex_engine_decompile_x86_64(no_ret, sizeof(no_ret), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);
  CHECK(hex_engine_decompile_x86_64(push_rbx, sizeof(push_rbx), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);
}

}  // namespace

int main() {
  test_sysv_amd64_straight_line();
  test_microsoft_x64_straight_line();
  test_three_real_x86_64_binaries();
  test_x86_64_loop_structuring();
  test_negative_and_fail_closed();

  if (g_failures == 0) {
    std::printf("test_x86_64_decomp_native (ASan+UBSan): ALL PASS\n");
    return 0;
  }
  std::fprintf(stderr, "test_x86_64_decomp_native: %d FAILURE(S)\n", g_failures);
  return 1;
}
