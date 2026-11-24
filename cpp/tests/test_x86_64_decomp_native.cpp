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

void test_sysv_amd64() {
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
    CHECK(text.find("a1") != std::string::npos);
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

  // 4. xor eax, eax; ret (zeroing idiom -> 0 params, return 0)
  {
    const uint8_t code[] = {0x31, 0xc0, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401300ULL, "zero", 4u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int32 zero(void)") != std::string::npos);
    CHECK(text.find("return 0;") != std::string::npos);
  }

  // 5. mov rax, 0x123456789abcdef0; ret (64-bit imm)
  {
    const uint8_t code[] = {0x48, 0xb8, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401400ULL, "const64", 7u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("uint64 const64(void)") != std::string::npos);
    CHECK(text.find("0x123456789ABCDEF0") != std::string::npos);
  }

  // 6. Bitwise ALU + imm: mov eax, edi; xor eax, esi; and eax, 0x7f; or eax, 1; sub eax, 2; ret
  {
    const uint8_t code[] = {
        0x89, 0xf8,        // mov eax, edi
        0x31, 0xf0,        // xor eax, esi
        0x83, 0xe0, 0x7f,  // and eax, 0x7f
        0x83, 0xc8, 0x01,  // or eax, 1
        0x83, 0xe8, 0x02,  // sub eax, 2
        0xc3,              // ret
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401500ULL, "bitops", 6u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int32 bitops(uint64 a1, uint64 a2)") != std::string::npos);
    CHECK(text.find('^') != std::string::npos);
    CHECK(text.find('&') != std::string::npos);
    CHECK(text.find('|') != std::string::npos);
    CHECK(text.find("- 2") != std::string::npos);
  }

  // 7. nop; ret -> void function
  {
    const uint8_t code[] = {0x90, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x401600ULL, "noop", 4u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("void noop(void)") != std::string::npos);
    CHECK(text.find("return;") != std::string::npos);
  }
}

void test_microsoft_x64() {
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

  // 2. 4-arg Microsoft x64: mov rax, rcx; add rax, rdx; add rax, r8; add rax, r9; ret
  {
    const uint8_t code[] = {
        0x48, 0x89, 0xc8,  // mov rax, rcx
        0x48, 0x01, 0xd0,  // add rax, rdx
        0x4c, 0x01, 0xc0,  // add rax, r8
        0x4c, 0x01, 0xc8,  // add rax, r9
        0xc3,              // ret
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x140001100ULL, "sum4_win64", 10u, HEX_X86_ABI_MICROSOFT_X64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("uint64 sum4_win64(uint64 a1, uint64 a2, uint64 a3, uint64 a4)") != std::string::npos);
    CHECK(text.find("a1") != std::string::npos && text.find("a4") != std::string::npos);
  }

  // 3. Reading rdi on Microsoft x64 is NOT a param register -> fail-closed HEX_ERR_UNSUPPORTED
  {
    const uint8_t code[] = {0x89, 0xf8, 0xc3};  // mov eax, edi; ret
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x140001200ULL, "bad_win64", 9u, HEX_X86_ABI_MICROSOFT_X64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_ERR_UNSUPPORTED);
    CHECK(hex_x86_64_decomp_get_text_ptr() == nullptr);
    CHECK(hex_x86_64_decomp_get_text_len() == 0u);
  }
}

void test_real_binary_fragments() {
  struct BinSpec {
    const char* path;
    size_t offset;
    size_t size;
    uint64_t base;
    uint32_t abi;
  };
  const BinSpec specs[3] = {
      {"tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf", 4096u, 77u, 0x401000ULL, HEX_X86_ABI_SYSV_AMD64},
      {"tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe", 1024u, 84u, 0x140001000ULL, HEX_X86_ABI_MICROSOFT_X64},
      {"tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o", 384u, 77u, 0x0ULL, HEX_X86_ABI_SYSV_AMD64},
  };

  for (const auto& sp : specs) {
    uint8_t buf[128];
    CHECK(read_file_slice(sp.path, sp.offset, sp.size, buf));

    // Full real function contains stack/memory/branches -> fail-closed HEX_ERR_UNSUPPORTED.
    const HexStatus full_st = hex_engine_decompile_x86_64(
        buf, static_cast<uint32_t>(sp.size), sp.base, "real_fn", 7u, sp.abi, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(full_st == HEX_ERR_UNSUPPORTED);
    CHECK(hex_x86_64_decomp_get_text_ptr() == nullptr);
    CHECK(hex_x86_64_decomp_get_text_len() == 0u);

    // Tail `ret` byte extracted directly from the real binary -> valid void return.
    const uint8_t* tail_ret = buf + (sp.size - 1u);
    CHECK(tail_ret[0] == 0xc3u);
    const HexStatus ret_st = hex_engine_decompile_x86_64(
        tail_ret, 1u, sp.base + static_cast<uint64_t>(sp.size - 1u),
        "tail_ret", 8u, sp.abi, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(ret_st == HEX_OK);
    CHECK(get_emitted_text().find("return;") != std::string::npos);
  }

  // Extract `sub ecx, 1` (83 e9 01) from vertical-microsoft-x64.exe at offset 0x3f in .text
  // and pair with `mov eax, ecx; ret` to verify straight-line Win64 fragment lifting.
  {
    uint8_t pe_text[84];
    CHECK(read_file_slice("tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe", 1024u, 84u, pe_text));
    CHECK(pe_text[0x3fu] == 0x83u && pe_text[0x40u] == 0xe9u && pe_text[0x41u] == 0x01u);
    const uint8_t frag[] = {pe_text[0x3fu], pe_text[0x40u], pe_text[0x41u], 0x89u, 0xc8u, 0xc3u};
    const HexStatus st = hex_engine_decompile_x86_64(
        frag, sizeof(frag), 0x14000103fULL, "dec_arg1", 8u, HEX_X86_ABI_MICROSOFT_X64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int32 dec_arg1(uint64 a1)") != std::string::npos);
    CHECK(text.find("return a1 - 1;") != std::string::npos);
  }
}

void test_negative_and_truncated() {
  // Null / empty / bad ABI
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

  // Missing RET / interior RET / branch / memory load
  const uint8_t no_ret[] = {0x89, 0xf8};
  const uint8_t mid_ret[] = {0xc3, 0x90, 0xc3};
  const uint8_t branch_fn[] = {0xeb, 0x00, 0xc3};
  const uint8_t mem_load[] = {0x8b, 0x07, 0xc3};
  CHECK(hex_engine_decompile_x86_64(no_ret, sizeof(no_ret), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);
  CHECK(hex_engine_decompile_x86_64(mid_ret, sizeof(mid_ret), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);
  CHECK(hex_engine_decompile_x86_64(branch_fn, sizeof(branch_fn), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);
  CHECK(hex_engine_decompile_x86_64(mem_load, sizeof(mem_load), 0x1000, nullptr, 0, 0, 0) == HEX_ERR_UNSUPPORTED);
}

}  // namespace

int main() {
  test_sysv_amd64();
  test_microsoft_x64();
  test_real_binary_fragments();
  test_negative_and_truncated();

  if (g_failures == 0) {
    std::printf("test_x86_64_decomp_native (ASan+UBSan): ALL PASS\n");
    return 0;
  }
  std::fprintf(stderr, "test_x86_64_decomp_native: %d FAILURE(S)\n", g_failures);
  return 1;
}
