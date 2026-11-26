#include "../src/targets/x86_64_decomp.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

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

bool verify_c11_syntax(const std::string& code, const char* label) {
  std::FILE* pipe = popen("clang -x c -std=c11 -fsyntax-only -", "w");
  if (!pipe) {
    std::fprintf(stderr, "FAIL: popen(clang) failed for %s\n", label);
    return false;
  }
  const size_t written = std::fwrite(code.data(), 1, code.size(), pipe);
  const int rc = pclose(pipe);
  if (written != code.size() || rc != 0) {
    std::fprintf(stderr, "FAIL: C11 syntax check failed for %s (rc=%d)\n--- CODE ---\n%s\n------------\n",
                 label, rc, code.c_str());
    return false;
  }
  return true;
}

bool verify_c11_syntax_werror(const std::string& code, const char* label) {
  std::FILE* pipe = popen("clang -x c -std=c11 -Wall -Wextra -Werror -fsyntax-only -", "w");
  if (!pipe) {
    std::fprintf(stderr, "FAIL: popen(clang -Wall -Wextra -Werror) failed for %s\n", label);
    return false;
  }
  const size_t written = std::fwrite(code.data(), 1, code.size(), pipe);
  const int rc = pclose(pipe);
  if (written != code.size() || rc != 0) {
    std::fprintf(stderr, "FAIL: C11 -Wall -Wextra -Werror check failed for %s (rc=%d)\n--- CODE ---\n%s\n------------\n",
                 label, rc, code.c_str());
    return false;
  }
  return true;
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

  // 2. Reading non-param rdi on Microsoft x64 falls through to general C11 emitter -> HEX_OK
  {
    const uint8_t code[] = {0x89, 0xf8, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x140001200ULL, "nonparam_win64", 14u, HEX_X86_ABI_MICROSOFT_X64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(!text.empty());
    CHECK(text.find("nonparam_win64(void)") != std::string::npos);
    CHECK(verify_c11_syntax(text, "nonparam_win64"));
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
    CHECK(verify_c11_syntax(text, sp.name));
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
  CHECK(text.find("+ 1") != std::string::npos);
  CHECK(text.find("a1") != std::string::npos);
  CHECK(text.find("<") != std::string::npos || text.find(">=") != std::string::npos);
  CHECK(text.find("return ") != std::string::npos);
  CHECK(hex_x86_64_decomp_get_linemap_ptr() != nullptr);
  CHECK(hex_x86_64_decomp_get_linemap_count() >= 3u);
  std::printf("  [PASS] x86_64 loop structuring: %zu bytes C, %u linemap entries\n",
              text.size(), hex_x86_64_decomp_get_linemap_count());
}

void test_negative_and_general_fallback() {
  const uint8_t ok_ret[] = {0xc3};
  CHECK(hex_engine_decompile_x86_64(nullptr, 1u, 0, nullptr, 0, 0, 0) == HEX_ERR_INVALID_ARG);
  CHECK(hex_engine_decompile_x86_64(ok_ret, 0u, 0, nullptr, 0, 0, 0) == HEX_ERR_INVALID_ARG);
  CHECK(hex_engine_decompile_x86_64(ok_ret, 1u, 0, nullptr, 4u, 0, 0) == HEX_ERR_INVALID_ARG);
  CHECK(hex_engine_decompile_x86_64(ok_ret, 1u, 0, nullptr, 0, 2u, 0) == HEX_ERR_INVALID_ARG);

  // Oversized buffer (> 32 KiB) returns HEX_ERR_UNSUPPORTED.
  std::vector<uint8_t> too_big(32769u, 0x90u);
  CHECK(hex_engine_decompile_x86_64(too_big.data(), static_cast<uint32_t>(too_big.size()), 0x1000, nullptr, 0, 0, 0) ==
        HEX_ERR_UNSUPPORTED);

  // Truncated / raw / non-strict snippets now succeed via general C11 emitter!
  struct FallbackCase {
    const char* label;
    const uint8_t* bytes;
    uint32_t len;
    uint64_t base;
    const char* name;
    const char* must_contain;
  };
  const uint8_t trunc_call[] = {0xe8, 0x01, 0x00};
  const uint8_t trunc_mov[] = {0x48, 0x89};
  const uint8_t trunc_lea[] = {0x48, 0x8d, 0x44};
  const uint8_t lock_add[] = {0xf0, 0x01, 0xc0, 0xc3};
  const uint8_t oob_jmp[] = {0xeb, 0x40, 0xc3};
  const uint8_t bare_jcc[] = {0x74, 0x00, 0xc3};
  const uint8_t call_fn[] = {0xe8, 0x00, 0x00, 0x00, 0x00, 0xc3};
  const uint8_t no_ret[] = {0x89, 0xf8};
  const uint8_t push_rbx[] = {0x53, 0x5b, 0xc3};
  const uint8_t cmp_add_jcc[] = {0x89, 0xf8, 0x39, 0xf7, 0x83, 0xc0, 0x01, 0x74, 0x02, 0x89, 0xf0, 0xc3};
  const uint8_t cmp_imul_jcc[] = {0x89, 0xf8, 0x39, 0xf7, 0x0f, 0xaf, 0xc6, 0x74, 0x02, 0x89, 0xf0, 0xc3};
  const uint8_t cmp_xor_jcc[] = {0x89, 0xf8, 0x39, 0xf7, 0x31, 0xc0, 0x74, 0x02, 0x89, 0xf0, 0xc3};

  const FallbackCase cases[] = {
      {"trunc_call", trunc_call, sizeof(trunc_call), 0x1000ULL, nullptr, "x86_64 raw 0xE8"},
      {"trunc_mov", trunc_mov, sizeof(trunc_mov), 0x1000ULL, nullptr, "x86_64 raw 0x48"},
      {"trunc_lea", trunc_lea, sizeof(trunc_lea), 0x1000ULL, nullptr, "x86_64 raw 0x48"},
      {"lock_add", lock_add, sizeof(lock_add), 0x1000ULL, nullptr, "rax ="},
      {"oob_jmp", oob_jmp, sizeof(oob_jmp), 0x1000ULL, nullptr, "return sub_1042("},
      {"bare_jcc", bare_jcc, sizeof(bare_jcc), 0x1000ULL, nullptr, "return rax;"},
      {"call_fn", call_fn, sizeof(call_fn), 0x1000ULL, nullptr, "rax = sub_1005("},
      {"no_ret", no_ret, sizeof(no_ret), 0x1000ULL, nullptr, "return rax;"},
      {"push_rbx", push_rbx, sizeof(push_rbx), 0x1000ULL, nullptr, "__hex_stack"},
      {"cmp_add_jcc", cmp_add_jcc, sizeof(cmp_add_jcc), 0x600000ULL, "cmp_add_jcc", "if ("},
      {"cmp_imul_jcc", cmp_imul_jcc, sizeof(cmp_imul_jcc), 0x600100ULL, "cmp_imul_jcc", "if ("},
      {"cmp_xor_jcc", cmp_xor_jcc, sizeof(cmp_xor_jcc), 0x600200ULL, "cmp_xor_jcc", "if ("},
  };

  for (const auto& tc : cases) {
    const uint32_t nlen = tc.name ? static_cast<uint32_t>(std::strlen(tc.name)) : 0u;
    const HexStatus st = hex_engine_decompile_x86_64(
        tc.bytes, tc.len, tc.base, tc.name, nlen, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(!text.empty());
    CHECK(text.find(tc.must_contain) != std::string::npos);
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(hex_x86_64_decomp_get_linemap_ptr() != nullptr);
    CHECK(hex_x86_64_decomp_get_linemap_count() >= 1u);
    CHECK(verify_c11_syntax(text, tc.label));
  }

  // Non-flag-clobbering mov between cmp and jcc stays supported on strict fast-path (HEX_OK).
  {
    const uint8_t cmp_mov_jcc[] = {
        0x39, 0xf7,        // cmp edi, esi
        0x89, 0xf8,        // mov eax, edi (preserves flags)
        0x74, 0x02,        // je +2 (-> ret)
        0x89, 0xf0,        // mov eax, esi
        0xc3,              // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              cmp_mov_jcc, sizeof(cmp_mov_jcc), 0x600300ULL,
              "cmp_mov_jcc", 11u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
  }
  std::printf("  [PASS] general fallback cases + C11 syntax verification (12 cases)\n");
}

void test_general_call_and_tail_call() {
  // 1. Direct CALL + indirect CALL + external tail-call (SysV)
  //   push rbp; mov rbp, rsp;
  //   call +0x100 (0x402109);
  //   call rax (ff d0);
  //   pop rbp;
  //   jmp +0x200 (external tail call)
  const uint8_t code[] = {
      0x55,                               // push rbp
      0x48, 0x89, 0xe5,                   // mov rbp, rsp
      0xe8, 0x00, 0x01, 0x00, 0x00,       // call +0x100 -> 0x402109
      0xff, 0xd0,                         // call rax
      0x5d,                               // pop rbp
      0xe9, 0x00, 0x02, 0x00, 0x00,       // jmp +0x200 -> 0x402211
  };
  const HexStatus st = hex_engine_decompile_x86_64(
      code, sizeof(code), 0x402000ULL, "call_and_tail", 13u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
  CHECK(st == HEX_OK);
  const std::string text = get_emitted_text();
  CHECK(text.find("uint64 sub_402109(") != std::string::npos);
  CHECK(text.find("uint64 sub_402211(") != std::string::npos);
  CHECK(text.find("rax = sub_402109(") != std::string::npos);
  CHECK(text.find("((uint64 (*)(uint64, uint64, uint64, uint64))(uintptr_t)") != std::string::npos);
  CHECK(text.find("return sub_402211(") != std::string::npos);
  CHECK(verify_c11_syntax(text, "call_and_tail"));

  // 2. Win64 direct CALL + indirect JMP
  const uint8_t win_code[] = {
      0x48, 0x83, 0xec, 0x28,             // sub rsp, 0x28
      0xe8, 0x10, 0x00, 0x00, 0x00,       // call +0x10
      0x48, 0x83, 0xc4, 0x28,             // add rsp, 0x28
      0xff, 0xe0,                         // jmp rax
  };
  const HexStatus wst = hex_engine_decompile_x86_64(
      win_code, sizeof(win_code), 0x140005000ULL, "win64_call", 10u, HEX_X86_ABI_MICROSOFT_X64, HEX_EMIT_FLAG_JS_PARITY);
  CHECK(wst == HEX_OK);
  const std::string wtext = get_emitted_text();
  CHECK(wtext.find("rcx, rdx, r8, r9") != std::string::npos);
  CHECK(verify_c11_syntax(wtext, "win64_call"));
  std::printf("  [PASS] direct/indirect CALL & external tail-call (SysV + Win64)\n");
}

void test_general_cmovcc_setcc_and_alu_ext() {
  // cmp edi, esi; cmovl eax, edi; setge cl; movzx ecx, cl;
  // cdqe; cqo; shl rax, 3; sar rax, 1; rol eax, 4; ror eax, 4;
  // inc rax; dec rcx; neg rax; not rcx; xchg rax, rcx;
  // idiv rcx; lea rdx, [rip + 0x100]; mov r8, [rip + 0x200]; ret
  const uint8_t code[] = {
      0x39, 0xf7,                         // cmp edi, esi
      0x0f, 0x4c, 0xc7,                   // cmovl eax, edi
      0x0f, 0x9d, 0xc1,                   // setge cl
      0x0f, 0xb6, 0xc9,                   // movzx ecx, cl
      0x48, 0x98,                         // cdqe
      0x48, 0x99,                         // cqo
      0x48, 0xc1, 0xe0, 0x03,             // shl rax, 3
      0x48, 0xc1, 0xf8, 0x01,             // sar rax, 1
      0xc1, 0xc0, 0x04,                   // rol eax, 4
      0xc1, 0xc8, 0x04,                   // ror eax, 4
      0x48, 0xff, 0xc0,                   // inc rax
      0x48, 0xff, 0xc9,                   // dec rcx
      0x48, 0xf7, 0xd8,                   // neg rax
      0x48, 0xf7, 0xd1,                   // not rcx
      0x48, 0x91,                         // xchg rax, rcx
      0x48, 0xf7, 0xf9,                   // idiv rcx
      0x48, 0x8d, 0x15, 0x00, 0x01, 0x00, 0x00, // lea rdx, [rip + 0x100]
      0x4c, 0x8b, 0x05, 0x00, 0x02, 0x00, 0x00, // mov r8, [rip + 0x200]
      0xc3,                               // ret
  };
  const HexStatus st = hex_engine_decompile_x86_64(
      code, sizeof(code), 0x403000ULL, "cmov_setcc_alu", 14u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
  CHECK(st == HEX_OK);
  const std::string text = get_emitted_text();
  CHECK(text.find("if ((int64)__hex_cmp_l < (int64)__hex_cmp_r)") != std::string::npos);
  CHECK(text.find("? 1U : 0U") != std::string::npos);
  CHECK(text.find("(int64)(int32)rax") != std::string::npos);
  CHECK(text.find("global_") != std::string::npos);
  CHECK(verify_c11_syntax(text, "cmov_setcc_alu"));
  std::printf("  [PASS] cmovcc, setcc, cdqe/cqo, shifts/rotates, idiv, xchg, RIP-rel\n");
}

void test_general_sse2_and_unknown_opcodes() {
  // pxor xmm0, xmm0; movups xmm1, [rdi]; movaps [rsi], xmm1;
  // movdqa xmm2, xmm1; movdqu [rsi + 16], xmm2; movss xmm3, xmm0;
  // movsd xmm4, [rdi + 8]; xorps xmm3, xmm4; xorpd xmm0, xmm1;
  // movq xmm5, rax; movq rdx, xmm5;
  // plus raw unknown opcode 0x0f 0x0b (ud2) and 0xf4 (hlt); ret
  const uint8_t code[] = {
      0x66, 0x0f, 0xef, 0xc0,             // pxor xmm0, xmm0
      0x0f, 0x10, 0x0f,                   // movups xmm1, [rdi]
      0x0f, 0x29, 0x0e,                   // movaps [rsi], xmm1
      0x66, 0x0f, 0x6f, 0xd1,             // movdqa xmm2, xmm1
      0xf3, 0x0f, 0x7f, 0x56, 0x10,       // movdqu [rsi + 16], xmm2
      0xf3, 0x0f, 0x10, 0xd8,             // movss xmm3, xmm0
      0xf2, 0x0f, 0x10, 0x67, 0x08,       // movsd xmm4, [rdi + 8]
      0x0f, 0x57, 0xdc,                   // xorps xmm3, xmm4
      0x66, 0x0f, 0x57, 0xc1,             // xorpd xmm0, xmm1
      0x66, 0x48, 0x0f, 0x6e, 0xe8,       // movq xmm5, rax
      0x66, 0x48, 0x0f, 0x7e, 0xea,       // movq rdx, xmm5
      0x0f, 0x0b,                         // ud2 (unknown -> raw comment)
      0xf4,                               // hlt (unknown -> raw comment)
      0xc3,                               // ret
  };
  const HexStatus st = hex_engine_decompile_x86_64(
      code, sizeof(code), 0x404000ULL, "sse2_and_raw", 12u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
  CHECK(st == HEX_OK);
  const std::string text = get_emitted_text();
  CHECK(text.find("xmm0 = 0;") != std::string::npos);
  CHECK(text.find("xmm1 =") != std::string::npos);
  CHECK(text.find("xmm3 ^= xmm4;") != std::string::npos);
  CHECK(text.find("x86_64 raw 0x0F") != std::string::npos);
  CHECK(verify_c11_syntax(text, "sse2_and_raw"));
  std::printf("  [PASS] SSE2 + raw unknown opcode resilience\n");
}

void test_general_large_function_and_32k_limit() {
  // Build a 6,000-byte function (~2,000 3-byte `add rax, 1` insns + `ret`) > kMaxX86Bytes (4096)
  std::vector<uint8_t> large_code;
  large_code.reserve(6004u);
  for (uint32_t i = 0u; i < 1500u; ++i) {
    // 48 83 c0 01 -> add rax, 1 (4 bytes * 1500 = 6000 bytes)
    large_code.push_back(0x48u);
    large_code.push_back(0x83u);
    large_code.push_back(0xc0u);
    large_code.push_back(0x01u);
  }
  large_code.push_back(0xc3u);

  const HexStatus st = hex_engine_decompile_x86_64(
      large_code.data(), static_cast<uint32_t>(large_code.size()), 0x410000ULL,
      "large_6k_fn", 11u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
  CHECK(st == HEX_OK);
  const std::string text = get_emitted_text();
  CHECK(!text.empty());
  CHECK(text.find("uint64 large_6k_fn(") != std::string::npos);
  CHECK(hex_x86_64_decomp_get_linemap_count() >= 1000u);
  CHECK(verify_c11_syntax(text, "large_6k_fn"));

  // Full 32 KiB function (32768 bytes, padded with NOPs + final ret)
  std::vector<uint8_t> max_code(32768u, 0x90u);
  max_code[0] = 0x31u; max_code[1] = 0xc0u;  // xor eax, eax
  max_code[32767] = 0xc3u;                   // ret
  const HexStatus st32k = hex_engine_decompile_x86_64(
      max_code.data(), static_cast<uint32_t>(max_code.size()), 0x420000ULL,
      "max_32k_fn", 10u, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
  CHECK(st32k == HEX_OK);
  const std::string text32k = get_emitted_text();
  CHECK(!text32k.empty());
  CHECK(verify_c11_syntax(text32k, "max_32k_fn"));
  std::printf("  [PASS] large 6 KiB (%zu B C) & 32 KiB (%zu B C) functions\n",
              text.size(), text32k.size());
}

void test_repeated_emit_arena_zero_leak_and_scratch_survival() {
  const uint8_t loop_code[] = {
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
  const uint8_t add_code[] = {0xf3, 0x0f, 0x1e, 0xfa, 0x8d, 0x04, 0x37, 0xc3};

  std::string expected_loop;
  uint32_t expected_loop_lm = 0u;
  std::string expected_add;
  uint32_t expected_add_lm = 0u;

  // 80 consecutive decompiles: verifies g_x86_emit_arena resets cleanly with zero leak / OOM.
  for (int iter = 0; iter < 80; ++iter) {
    uint8_t mutable_code[32];
    char mutable_name[32];
    const bool is_loop = (iter % 2 == 0);
    const size_t code_len = is_loop ? sizeof(loop_code) : sizeof(add_code);
    std::memcpy(mutable_code, is_loop ? loop_code : add_code, code_len);
    const char* src_name = is_loop ? "sum_loop_rep" : "add_rep";
    const uint32_t name_len = static_cast<uint32_t>(std::strlen(src_name));
    std::memcpy(mutable_name, src_name, name_len + 1u);

    const HexStatus st = hex_engine_decompile_x86_64(
        mutable_code, static_cast<uint32_t>(code_len), 0x700000ULL,
        mutable_name, name_len, HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);

    // Overwrite caller buffers immediately after decompile to verify output survival in g_x86_emit_arena.
    std::memset(mutable_code, 0xAA, sizeof(mutable_code));
    std::memset(mutable_name, 0x55, sizeof(mutable_name));

    const std::string out_text = get_emitted_text();
    const uint32_t lm_cnt = hex_x86_64_decomp_get_linemap_count();
    const HexLineMapEntry* lm_ptr = hex_x86_64_decomp_get_linemap_ptr();
    CHECK(!out_text.empty());
    CHECK(lm_ptr != nullptr && lm_cnt >= 1u);

    if (is_loop) {
      if (expected_loop.empty()) {
        expected_loop = out_text;
        expected_loop_lm = lm_cnt;
      } else {
        CHECK(out_text == expected_loop);
        CHECK(lm_cnt == expected_loop_lm);
      }
    } else {
      if (expected_add.empty()) {
        expected_add = out_text;
        expected_add_lm = lm_cnt;
      } else {
        CHECK(out_text == expected_add);
        CHECK(lm_cnt == expected_add_lm);
      }
    }
  }
  std::printf("  [PASS] repeated emit arena zero-leak & scratch survival (80 iters)\n");
}


void test_strict_undeclared_label_fallback() {
  // Exact 41-byte sqlite3RenameTokenRemap sequence from libsqlite3.so.0.8.6:
  // Strict emitter previously emitted `goto L_bb7;` without defining `L_bb7:`.
  // Validator now catches it and falls back cleanly to general C11 emitter.
  const uint8_t code[] = {
      0x48, 0x8b, 0x87, 0x98, 0x01, 0x00, 0x00,  // mov rax, [rdi+0x198]
      0x48, 0x85, 0xc0,                          // test rax, rax
      0x75, 0x0d,                                // jne +0x0d (-> 0x19)
      0xeb, 0x1a,                                // jmp +0x1a (-> 0x28)
      0x66, 0x90,                                // nop
      0x48, 0x8b, 0x40, 0x18,                    // mov rax, [rax+0x18]
      0x48, 0x85, 0xc0,                          // test rax, rax
      0x74, 0x0f,                                // je +0x0f (-> 0x28)
      0x48, 0x39, 0x10,                          // cmp [rax], rdx
      0x75, 0xf2,                                // jne -0x0e (-> 0x10)
      0x48, 0x89, 0x30,                          // mov [rax], rsi
      0xc3,                                      // ret
      0x66, 0x0f, 0x1f, 0x44, 0x00, 0x00,        // nopw [rax+rax+0]
      0xc3,                                      // ret
  };
  const HexStatus st = hex_engine_decompile_x86_64(
      code, sizeof(code), 0x2e4e0ULL, "sqlite3RenameTokenRemap", 23u,
      HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
  CHECK(st == HEX_OK);
  const std::string text = get_emitted_text();
  CHECK(!text.empty());
  CHECK(text.find("L_bb") == std::string::npos);
  CHECK(text.find("goto ") == std::string::npos);
  CHECK(verify_c11_syntax(text, "sqlite3RenameTokenRemap"));
  std::printf("  [PASS] strict undeclared-label fallback (sqlite3RenameTokenRemap)\n");
}

void test_general_goto_reduction() {
  // 1. Forward if-else structuring:
  //   push rbx; cmp edi, esi; je +7 (L_else); mov eax, 1; jmp +5 (L_end);
  //   L_else: mov eax, 2; L_end: pop rbx; ret
  {
    const uint8_t code[] = {
        0x53,                          // push rbx (routes to general emitter)
        0x39, 0xf7,                    // cmp edi, esi
        0x74, 0x07,                    // je +7 (-> L_else at +12)
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0xeb, 0x05,                    // jmp +5 (-> L_end at +17)
        0xb8, 0x02, 0x00, 0x00, 0x00,  // L_else: mov eax, 2
        0x5b,                          // L_end: pop rbx
        0xc3,                          // ret
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x440000ULL, "gen_if_else", 11u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("if (") != std::string::npos);
    CHECK(text.find("} else {") != std::string::npos);
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(text.find("switch (__hex_state)") == std::string::npos);
    CHECK(verify_c11_syntax(text, "gen_if_else"));
  }

  // 2. Fallthrough goto deletion:
  //   push rbx; jmp +0 (next insn); mov eax, edi; pop rbx; ret
  {
    const uint8_t code[] = {
        0x53,        // push rbx
        0xeb, 0x00,  // jmp +0 (fallthrough to next insn)
        0x89, 0xf8,  // mov eax, edi
        0x5b,        // pop rbx
        0xc3,        // ret
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x440100ULL, "gen_fallthrough_jmp", 19u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(text.find("loc_") == std::string::npos);
    CHECK(text.find("switch (__hex_state)") == std::string::npos);
    CHECK(verify_c11_syntax(text, "gen_fallthrough_jmp"));
  }

  // 3. Inverted guard folding:
  //   push rbx; cmp edi, 0; je +2 (L_body); jmp +6 (L_exit);
  //   L_body: mov eax, 1; pop rbx; ret; L_exit: mov eax, 2; pop rbx; ret
  {
    const uint8_t code[] = {
        0x53,                          // push rbx
        0x83, 0xff, 0x00,              // cmp edi, 0
        0x74, 0x02,                    // je +2 (-> L_body at +8)
        0xeb, 0x07,                    // jmp +7 (-> L_exit at +15)
        0xb8, 0x01, 0x00, 0x00, 0x00,  // L_body: mov eax, 1
        0x5b,                          // pop rbx
        0xc3,                          // ret
        0xb8, 0x02, 0x00, 0x00, 0x00,  // L_exit: mov eax, 2
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x440200ULL, "gen_invert_guard", 16u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    // Inverted guard folds `je L_body; jmp L_exit; L_body:` into `jne L_exit;`,
    // which short-forward `if` then structures cleanly with zero gotos.
    CHECK(text.find("loc_440208") == std::string::npos);
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(text.find("if ((uint32)rdi == 0) {") != std::string::npos);
    CHECK(text.find("__hex_cmp_l") == std::string::npos);
    CHECK(text.find("switch (__hex_state)") == std::string::npos);
    CHECK(verify_c11_syntax(text, "gen_invert_guard"));
  }

  // 4. Loop `break;` and `continue;` inside `do { ... } while (...);`:
  //   0x00: 53             push rbx
  //   0x01: 31 c0          xor eax, eax
  //   0x03: 83 c0 01       L_loop: add eax, 1
  //   0x06: 39 f8          cmp eax, edi
  //   0x08: 74 09          je +9 (-> 0x13 L_exit -> break;)
  //   0x0a: 39 f0          cmp eax, esi
  //   0x0c: 74 03          je +3 (-> 0x11 L_latch -> continue;)
  //   0x0e: 83 c0 02       add eax, 2
  //   0x11: 75 f0          L_latch: jne -16 (-> 0x03 L_loop)
  //   0x13: 5b             L_exit: pop rbx
  //   0x14: c3             ret
  {
    const uint8_t code[] = {
        0x53,
        0x31, 0xc0,
        0x83, 0xc0, 0x01,
        0x39, 0xf8,
        0x74, 0x09,
        0x39, 0xf0,
        0x74, 0x03,
        0x83, 0xc0, 0x02,
        0x75, 0xf0,
        0x5b,
        0xc3,
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x440300ULL, "gen_loop_break_cont", 19u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("do {") != std::string::npos);
    CHECK(text.find("break;") != std::string::npos);
    CHECK(text.find("continue;") != std::string::npos);
    CHECK(text.find("} while (") != std::string::npos);
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(text.find("switch (__hex_state)") == std::string::npos);
    CHECK(verify_c11_syntax(text, "gen_loop_break_cont"));
  }
  std::printf("  [PASS] goto reduction: if-else, fallthrough, inverted guard, break/continue\n");
}

void test_general_recursive_6param_and_cleanup() {
  // 1. Recursive 6-param SysV self-call with unused r8:
  //   0x00: 53                push rbx
  //   0x01: 4c 89 c8          mov rax, r9     (uses 6th param r9, r8 untouched)
  //   0x04: e8 f7 ff ff ff    call -9 (-> 0x00 self!)
  //   0x09: 5b                pop rbx
  //   0x0a: c3                ret
  {
    const uint8_t code[] = {
        0x53,
        0x4c, 0x89, 0xc8,
        0xe8, 0xf7, 0xff, 0xff, 0xff,
        0x5b,
        0xc3,
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x450000ULL, nullptr, 0u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("uint64 sub_450000(uint64 a1, uint64 a2, uint64 a3, uint64 a4, uint64 a5, uint64 a6)") !=
          std::string::npos);
    CHECK(text.find("uint64 r8 = a5;") != std::string::npos);
    CHECK(text.find("rax = sub_450000(rdi, rsi, rdx, rcx, r8, r9);") != std::string::npos);
    CHECK(verify_c11_syntax(text, "recursive_6param_sysv"));
  }

  // 2. Keyword & register function name sanitization (both strict and general paths).
  {
    const uint8_t strict_ret[] = {0x31, 0xc0, 0xc3};
    const uint8_t general_ret[] = {0x53, 0x5b, 0xc3};
    const char* bad_names[] = {"default", "return", "register", "int", "rax", "r15", "xmm0", "uint64"};
    for (const char* nm : bad_names) {
      const uint32_t nlen = static_cast<uint32_t>(std::strlen(nm));
      const std::string expected = std::string("fn_") + nm;

      CHECK(hex_engine_decompile_x86_64(
                strict_ret, sizeof(strict_ret), 0x451000ULL, nm, nlen,
                HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
      std::string stext = get_emitted_text();
      CHECK(stext.find(expected) != std::string::npos);
      CHECK(verify_c11_syntax(stext, nm));

      CHECK(hex_engine_decompile_x86_64(
                general_ret, sizeof(general_ret), 0x452000ULL, nm, nlen,
                HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
      std::string gtext = get_emitted_text();
      CHECK(gtext.find(expected) != std::string::npos);
      CHECK(verify_c11_syntax(gtext, nm));
    }
    // `main` is preserved (not prefixed).
    CHECK(hex_engine_decompile_x86_64(
              strict_ret, sizeof(strict_ret), 0x453000ULL, "main", 4u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    CHECK(get_emitted_text().find("int32 main(void)") != std::string::npos);
  }

  // 3. Redundant 0x66 + 0xF3 prefix on 0F 7E (`66 F3 0F 7E C1` = `movq xmm0, xmm1`).
  {
    const uint8_t code[] = {0x66, 0xf3, 0x0f, 0x7e, 0xc1, 0xc3};
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x454000ULL, "f3_66_movq", 10u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("xmm0 = xmm1;") != std::string::npos);
    CHECK(verify_c11_syntax(text, "f3_66_movq"));
  }

  // 4. Callee table cap (> 512 unique callees) falls back to numeric function pointer cast.
  {
    std::vector<uint8_t> code;
    code.reserve(516u * 5u + 1u);
    for (uint32_t k = 0u; k < 515u; ++k) {
      // e8 <rel32> targeting distinct addresses 0x500000 + k*16
      const uint64_t next_pc = 0x460000ULL + static_cast<uint64_t>((k + 1u) * 5u);
      const uint64_t tgt = 0x500000ULL + static_cast<uint64_t>(k * 16u);
      const int32_t rel = static_cast<int32_t>(tgt - next_pc);
      code.push_back(0xe8u);
      code.push_back(static_cast<uint8_t>(rel & 0xff));
      code.push_back(static_cast<uint8_t>((rel >> 8) & 0xff));
      code.push_back(static_cast<uint8_t>((rel >> 16) & 0xff));
      code.push_back(static_cast<uint8_t>((rel >> 24) & 0xff));
    }
    code.push_back(0xc3u);
    const HexStatus st = hex_engine_decompile_x86_64(
        code.data(), static_cast<uint32_t>(code.size()), 0x460000ULL, "many_callees", 12u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("((uint64 (*)(uint64, uint64, uint64, uint64))(uintptr_t)0x") != std::string::npos);
    CHECK(verify_c11_syntax(text, "many_callees"));
  }
  std::printf("  [PASS] recursive 6-param SysV, name sanitization, 66+F3 movq, 512 callee cap\n");
}

void test_zero_goto_state_machine_and_main() {
  // 1. Irreducible two-entry loop on general path (push rbx forces general emitter):
  //   0x00: 53             push rbx
  //   0x01: 31 c0          xor eax, eax
  //   0x03: 83 ff 00       cmp edi, 0
  //   0x06: 74 07          je +7 (-> 0x0f L_b)
  //   0x08: 01 f0          L_a: add eax, esi
  //   0x0a: 83 ee 01       sub esi, 1
  //   0x0d: 74 07          je +7 (-> 0x16 L_done)
  //   0x0f: 01 f8          L_b: add eax, edi
  //   0x11: 83 ef 01       sub edi, 1
  //   0x14: 75 f2          jne -14 (-> 0x08 L_a)
  //   0x16: 5b             L_done: pop rbx
  //   0x17: c3             ret
  {
    const uint8_t code[] = {
        0x53,
        0x31, 0xc0,
        0x83, 0xff, 0x00,
        0x74, 0x07,
        0x01, 0xf0,
        0x83, 0xee, 0x01,
        0x74, 0x07,
        0x01, 0xf8,
        0x83, 0xef, 0x01,
        0x75, 0xf2,
        0x5b,
        0xc3,
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x470000ULL, "irred_general", 13u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(text.find("switch (__hex_state)") != std::string::npos);
    CHECK(text.find("case 0u:") != std::string::npos);
    CHECK(verify_c11_syntax_werror(text, "irred_general"));
  }

  // 2. Irreducible two-entry loop with strict-eligible opcodes only:
  //    Strict emitter rejects any `goto ` and falls through to general 0-goto state machine.
  {
    const uint8_t code[] = {
        0x31, 0xc0,
        0x83, 0xff, 0x00,
        0x74, 0x07,
        0x01, 0xf0,
        0x83, 0xee, 0x01,
        0x74, 0x07,
        0x01, 0xf8,
        0x83, 0xef, 0x01,
        0x75, 0xf2,
        0xc3,
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x470100ULL, "irred_strict_fallback", 21u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(text.find("switch (__hex_state)") != std::string::npos);
    CHECK(verify_c11_syntax_werror(text, "irred_strict_fallback"));
  }

  // 3. C11 `main` signature on general path (`int main(int a1, char **a2)` + `return (int)rax;`)
  {
    const uint8_t code[] = {
        0x53,        // push rbx
        0x89, 0xf8,  // mov eax, edi
        0x01, 0xf0,  // add eax, esi
        0x5b,        // pop rbx
        0xc3,        // ret
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x470200ULL, "main", 4u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("int main(int a1, char **a2)") != std::string::npos);
    CHECK(text.find("return (int)rax;") != std::string::npos);
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(verify_c11_syntax_werror(text, "general_main"));
  }
  std::printf("  [PASS] 0-goto state-machine dispatcher (general + strict fallback) & C11 main\n");
}

void test_wave32_readability_and_compare_fusion() {
  // 1. State-machine case comments: `case 0u: /* entry 0x... */` & `case 1u: /* block 0x... */`
  {
    const uint8_t code[] = {
        0x53,              // 0x480000: push rbx
        0x31, 0xc0,        // 0x480001: xor eax, eax
        0x83, 0xff, 0x00,  // 0x480003: cmp edi, 0
        0x74, 0x07,        // 0x480006: je +7 (-> 0x48000F)
        0x01, 0xf0,        // 0x480008: L_a: add eax, esi
        0x83, 0xee, 0x01,  // 0x48000A: sub esi, 1
        0x74, 0x07,        // 0x48000D: je +7 (-> 0x480016)
        0x01, 0xf8,        // 0x48000F: L_b: add eax, edi
        0x83, 0xef, 0x01,  // 0x480011: sub edi, 1
        0x75, 0xf2,        // 0x480014: jne -14 (-> 0x480008)
        0x5b,              // 0x480016: L_done: pop rbx
        0xc3,              // 0x480017: ret
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x480000ULL, "sm_comments", 11u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("case 0u: /* entry 0x480000 */") != std::string::npos);
    CHECK(text.find("case 1u: /* block 0x480008 */") != std::string::npos);
    CHECK(text.find("case 2u: /* block 0x48000F */") != std::string::npos);
    CHECK(text.find("case 3u: /* block 0x480016 */") != std::string::npos);
    CHECK(text.find("goto ") == std::string::npos);
    CHECK(verify_c11_syntax_werror(text, "sm_comments"));
  }

  // 2. Grouped zero-initialized scratch GPRs (4 per line), XMMs (4 per line),
  //    own-line rsp/rbp/params, and blank-line separation before body.
  {
    const uint8_t code[] = {
        0x55,                    // push rbp
        0x48, 0x89, 0xe5,        // mov rbp, rsp
        0x53,                    // push rbx
        0x41, 0x54,              // push r12
        0x41, 0x55,              // push r13
        0x41, 0x56,              // push r14
        0x48, 0x89, 0xf8,        // mov rax, rdi
        0x66, 0x0f, 0xef, 0xc1,        // pxor xmm0, xmm1
        0x66, 0x0f, 0xef, 0xc2,        // pxor xmm0, xmm2
        0x66, 0x0f, 0xef, 0xc3,        // pxor xmm0, xmm3
        0x66, 0x0f, 0xef, 0xc4,        // pxor xmm0, xmm4
        0x66, 0x48, 0x0f, 0x7e, 0xc0,  // movq rax, xmm0
        0x41, 0x5e,              // pop r14
        0x41, 0x5d,              // pop r13
        0x41, 0x5c,              // pop r12
        0x5b,                    // pop rbx
        0x5d,                    // pop rbp
        0xc3,                    // ret
    };
    const HexStatus st = hex_engine_decompile_x86_64(
        code, sizeof(code), 0x480100ULL, "grouped_decls", 13u,
        HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY);
    CHECK(st == HEX_OK);
    const std::string text = get_emitted_text();
    CHECK(text.find("    uint64 rsp = ") != std::string::npos);
    CHECK(text.find("    uint64 rbp = rsp;\n") != std::string::npos);
    CHECK(text.find("    uint64 rdi = a1;\n") != std::string::npos);
    CHECK(text.find("    uint64 rax = 0, rbx = 0, r12 = 0, r13 = 0;\n") != std::string::npos);
    CHECK(text.find("    uint64 r14 = 0;\n") != std::string::npos);
    CHECK(text.find("    uint64 xmm0 = 0, xmm1 = 0, xmm2 = 0, xmm3 = 0;\n") != std::string::npos);
    CHECK(text.find("    uint64 xmm4 = 0;\n\n    rsp -= 8;") != std::string::npos);
    CHECK(text.find("__hex_cmp_l") == std::string::npos);
    CHECK(verify_c11_syntax_werror(text, "grouped_decls"));
  }

  // 3. Fused CMP + JCC (signed vs unsigned, 32-bit vs 64-bit) omits __hex_cmp_l/__hex_cmp_r
  {
    // 3a. Signed 32-bit jl: push rbx; cmp edi, esi; jl +5; mov eax, 1; jmp +5; mov eax, 2; pop rbx; ret
    const uint8_t signed32[] = {
        0x53,                          // push rbx
        0x39, 0xf7,                    // cmp edi, esi
        0x7c, 0x07,                    // jl +7 (-> mov eax, 2)
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0xeb, 0x05,                    // jmp +5 (-> pop rbx)
        0xb8, 0x02, 0x00, 0x00, 0x00,  // mov eax, 2
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              signed32, sizeof(signed32), 0x480200ULL, "fused_cmp_s32", 13u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t1 = get_emitted_text();
    // if-else negates jl -> jge (`(int32)rdi >= (int32)rsi`)
    CHECK(t1.find("if ((int32)rdi >= (int32)rsi) {") != std::string::npos);
    CHECK(t1.find("__hex_cmp_l") == std::string::npos);
    CHECK(t1.find("__hex_cmp_r") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t1, "fused_cmp_s32"));

    // 3b. Unsigned 64-bit jb: push rbx; cmp rdi, rsi; jb +7; mov eax, 1; jmp +5; mov eax, 2; pop rbx; ret
    const uint8_t unsigned64[] = {
        0x53,
        0x48, 0x39, 0xf7,              // cmp rdi, rsi
        0x72, 0x07,                    // jb +7
        0xb8, 0x01, 0x00, 0x00, 0x00,
        0xeb, 0x05,
        0xb8, 0x02, 0x00, 0x00, 0x00,
        0x5b,
        0xc3,
    };
    CHECK(hex_engine_decompile_x86_64(
              unsigned64, sizeof(unsigned64), 0x480300ULL, "fused_cmp_u64", 13u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t2 = get_emitted_text();
    // if-else negates jb -> jae (`rdi >= rsi`)
    CHECK(t2.find("if (rdi >= rsi) {") != std::string::npos);
    CHECK(t2.find("__hex_cmp_l") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t2, "fused_cmp_u64"));

    // 3c. Signed 64-bit cmp rdi, -1; jge -> negated to `(int64)rdi < (int64)0xFFFFFFFFFFFFFFFFULL`
    const uint8_t signed64_neg[] = {
        0x53,
        0x48, 0x83, 0xff, 0xff,        // cmp rdi, -1
        0x7d, 0x05,                    // jge +5 (-> pop rbx)
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0x5b,
        0xc3,
    };
    CHECK(hex_engine_decompile_x86_64(
              signed64_neg, sizeof(signed64_neg), 0x480380ULL, "fused_cmp_s64_neg", 17u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t2b = get_emitted_text();
    CHECK(t2b.find("if ((int64)rdi < (int64)0xFFFFFFFFFFFFFFFFULL) {") != std::string::npos);
    CHECK(t2b.find("__hex_cmp_l") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t2b, "fused_cmp_s64_neg"));
  }

  // 4. Fused TEST + JCC (`je`, `js`) omits __hex_cmp_l/__hex_cmp_r
  {
    const uint8_t test_je_js[] = {
        0x53,                          // push rbx
        0x85, 0xf7,                    // test edi, esi
        0x74, 0x05,                    // je +5 (-> test edi, edi)
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0x85, 0xff,                    // test edi, edi
        0x78, 0x05,                    // js +5 (-> pop rbx)
        0xb8, 0x02, 0x00, 0x00, 0x00,  // mov eax, 2
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              test_je_js, sizeof(test_je_js), 0x480400ULL, "fused_test_jcc", 14u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t3 = get_emitted_text();
    CHECK(t3.find("if (((uint32)rdi & (uint32)rsi) != 0) {") != std::string::npos);
    CHECK(t3.find("if ((int32)rdi >= 0) {") != std::string::npos);
    CHECK(t3.find("(uint32)rdi & (uint32)rdi") == std::string::npos);
    CHECK(t3.find("__hex_cmp_l") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t3, "fused_test_jcc"));
  }

  // 5. Soundness negative cases: multiple JCCs or ADC after JCC must KEEP __hex_cmp_l/__hex_cmp_r
  {
    // 5a. cmp edi, esi; je +7; jl +5; mov eax, 1; pop rbx; ret
    const uint8_t multi_jcc[] = {
        0x53,                          // push rbx
        0x39, 0xf7,                    // cmp edi, esi
        0x74, 0x07,                    // je +7 (-> pop rbx)
        0x7c, 0x05,                    // jl +5 (-> pop rbx)
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              multi_jcc, sizeof(multi_jcc), 0x480500ULL, "multi_jcc_nofuse", 16u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t4 = get_emitted_text();
    CHECK(t4.find("uint64 __hex_cmp_l = 0, __hex_cmp_r = 0;") != std::string::npos);
    CHECK(t4.find("goto ") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t4, "multi_jcc_nofuse"));

    // 5b. cmp edi, esi; je +4; adc eax, edx; pop rbx; ret (ADC reads CF -> do NOT fuse!)
    const uint8_t cmp_jcc_adc[] = {
        0x53,        // push rbx
        0x39, 0xf7,  // cmp edi, esi
        0x74, 0x02,  // je +2 (-> pop rbx)
        0x11, 0xd0,  // adc eax, edx
        0x5b,        // pop rbx
        0xc3,        // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              cmp_jcc_adc, sizeof(cmp_jcc_adc), 0x480600ULL, "cmp_jcc_adc_nofuse", 18u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t5 = get_emitted_text();
    CHECK(t5.find("uint64 __hex_cmp_l = 0, __hex_cmp_r = 0;") != std::string::npos);
    CHECK(verify_c11_syntax_werror(t5, "cmp_jcc_adc_nofuse"));
  }
  std::printf("  [PASS] Wave 32 readability: case comments, grouped decls, fused CMP/TEST+JCC & soundness\n");
}


void test_wave33_track_b_readability() {
  // B1a: Fused CMP + CMOVcc and CMP + SETcc (zero __hex_cmp_l / __hex_cmp_r).
  {
    const uint8_t cmp_cmov[] = {
        0x53,              // push rbx
        0x39, 0xf7,        // cmp edi, esi
        0x0f, 0x4c, 0xc7,  // cmovl eax, edi
        0x5b,              // pop rbx
        0xc3,              // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              cmp_cmov, sizeof(cmp_cmov), 0x490000ULL, "b1_cmp_cmov", 11u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t = get_emitted_text();
    CHECK(t.find("if ((int32)rdi < (int32)rsi) rax = (uint32)rdi;") != std::string::npos);
    CHECK(t.find("__hex_cmp_l") == std::string::npos);
    CHECK(t.find("goto ") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t, "b1_cmp_cmov"));

    const uint8_t cmp_setcc[] = {
        0x53,              // push rbx
        0x48, 0x39, 0xf7,  // cmp rdi, rsi
        0x0f, 0x94, 0xc0,  // sete al
        0x5b,              // pop rbx
        0xc3,              // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              cmp_setcc, sizeof(cmp_setcc), 0x490100ULL, "b1_cmp_setcc", 12u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string ts = get_emitted_text();
    CHECK(ts.find("rdi == rsi ? 1U : 0U") != std::string::npos);
    CHECK(ts.find("__hex_cmp_l") == std::string::npos);
    CHECK(verify_c11_syntax_werror(ts, "b1_cmp_setcc"));
  }

  // B1b: Non-adjacent compare fusion (gap = 2 safe MOV+LEA) vs clobber negative cases.
  {
    // Safe gap=2: cmp edi, esi; mov ecx, 7; lea rdx, [rcx + 8]; je +3; add rax, rdx; pop rbx; ret
    const uint8_t safe_gap[] = {
        0x53,                          // push rbx
        0x39, 0xf7,                    // cmp edi, esi
        0xb9, 0x07, 0x00, 0x00, 0x00,  // mov ecx, 7
        0x48, 0x8d, 0x51, 0x08,        // lea rdx, [rcx + 8]
        0x74, 0x03,                    // je +3 (-> pop rbx)
        0x48, 0x01, 0xd0,              // add rax, rdx
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              safe_gap, sizeof(safe_gap), 0x490200ULL, "b1_gap2_safe", 12u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string tg = get_emitted_text();
    CHECK(tg.find("if ((uint32)rdi != (uint32)rsi) {") != std::string::npos);
    CHECK(tg.find("__hex_cmp_l") == std::string::npos);
    CHECK(verify_c11_syntax_werror(tg, "b1_gap2_safe"));

    // Unsafe gap=1 (clobbers edi read by cmp): cmp edi, esi; mov edi, 0; je +5; mov eax, 1; pop rbx; ret
    const uint8_t clobber_reg[] = {
        0x53,                          // push rbx
        0x39, 0xf7,                    // cmp edi, esi
        0xbf, 0x00, 0x00, 0x00, 0x00,  // mov edi, 0 (clobbers rdi!)
        0x74, 0x05,                    // je +5
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              clobber_reg, sizeof(clobber_reg), 0x490300ULL, "b1_gap1_clobber_reg", 19u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string tcr = get_emitted_text();
    CHECK(tcr.find("uint64 __hex_cmp_l = 0, __hex_cmp_r = 0;") != std::string::npos);
    CHECK(verify_c11_syntax_werror(tcr, "b1_gap1_clobber_reg"));

    // Unsafe gap=1 (CMP reads mem, intervening MOV writes mem):
    // push rbx; cmp dword ptr [rdi], 0; mov dword ptr [rsi], eax; je +5; mov eax, 1; pop rbx; ret
    const uint8_t clobber_mem[] = {
        0x53,                          // push rbx
        0x83, 0x3f, 0x00,              // cmp dword ptr [rdi], 0
        0x89, 0x06,                    // mov dword ptr [rsi], eax
        0x74, 0x05,                    // je +5
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              clobber_mem, sizeof(clobber_mem), 0x490400ULL, "b1_gap1_clobber_mem", 19u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string tcm = get_emitted_text();
    CHECK(tcm.find("uint64 __hex_cmp_l = 0, __hex_cmp_r = 0;") != std::string::npos);
    CHECK(verify_c11_syntax_werror(tcm, "b1_gap1_clobber_mem"));
  }

  // B1c: TEST r, r simplification (64-bit `test rax, rax; je` -> `rax != 0`).
  {
    const uint8_t test_self64[] = {
        0x53,                          // push rbx
        0x48, 0x85, 0xc0,              // test rax, rax
        0x74, 0x05,                    // je +5 (-> pop rbx)
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              test_self64, sizeof(test_self64), 0x490500ULL, "b1_test_self64", 14u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t = get_emitted_text();
    CHECK(t.find("if (rax != 0) {") != std::string::npos);
    CHECK(t.find("rax & rax") == std::string::npos);
    CHECK(t.find("__hex_cmp_l") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t, "b1_test_self64"));
  }

  // B1d: Tightened backward flag liveness (CALL/RET clear flags_live, dead unfused CMP gated).
  {
    // push rbx; add eax, 1; call +0x100; cmp edi, esi; je +5; jl +3; add eax, 2; cmp r10, r11; pop rbx; ret
    const uint8_t liveness_fn[] = {
        0x53,                          // push rbx
        0x83, 0xc0, 0x01,              // add eax, 1 (before CALL -> flags dead!)
        0xe8, 0x00, 0x01, 0x00, 0x00,  // call +0x100
        0x39, 0xf7,                    // cmp edi, esi (live: feeds je + jl)
        0x74, 0x05,                    // je +5 (-> cmp r10, r11)
        0x7c, 0x03,                    // jl +3 (-> cmp r10, r11)
        0x83, 0xc0, 0x02,              // add eax, 2 (before dead cmp -> flags dead!)
        0x4d, 0x39, 0xda,              // cmp r10, r11 (before RET -> dead unfused CMP!)
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              liveness_fn, sizeof(liveness_fn), 0x490600ULL, "b1_flag_liveness", 16u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t = get_emitted_text();
    // Only ONE `__hex_cmp_l =` assignment should exist (from `cmp edi, esi`, NOT `add eax, 1` or `cmp r10, r11`).
    const size_t first_cmp = t.find("__hex_cmp_l = (uint64)");
    CHECK(first_cmp != std::string::npos);
    CHECK(t.find("__hex_cmp_l = (uint64)", first_cmp + 1u) == std::string::npos);
    // B3 should also prune dead r10/r11 declarations since `cmp r10, r11` was pruned!
    CHECK(t.find("r10") == std::string::npos);
    CHECK(t.find("r11") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t, "b1_flag_liveness"));
  }

  // B2: Zero duplicate `(uint32)((uint32)...)` casts & redundant outer parens.
  {
    const uint8_t b2_code[] = {
        0x53,                          // push rbx
        0xb8, 0x01, 0x00, 0x00, 0x00,  // mov eax, 1
        0x31, 0xc9,                    // xor ecx, ecx
        0x89, 0xc2,                    // mov edx, eax
        0x01, 0xf8,                    // add eax, edi
        0x83, 0xe8, 0x03,              // sub eax, 3
        0x0f, 0xaf, 0xc6,              // imul eax, esi
        0x49, 0x89, 0xf8,              // mov r8, rdi
        0x4d, 0x01, 0xc8,              // add r8, r9
        0x48, 0x01, 0xc8,              // add rax, rcx
        0x48, 0x01, 0xd0,              // add rax, rdx
        0x4c, 0x01, 0xc0,              // add rax, r8
        0x5b,                          // pop rbx
        0xc3,                          // ret
    };
    CHECK(hex_engine_decompile_x86_64(
              b2_code, sizeof(b2_code), 0x490700ULL, "b2_clean_casts", 14u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t = get_emitted_text();
    CHECK(t.find("rax = 1;\n") != std::string::npos);
    CHECK(t.find("rcx = 0;\n") != std::string::npos);
    CHECK(t.find("rdx = (uint32)rax;\n") != std::string::npos);
    CHECK(t.find("rax = (uint32)rax + (uint32)rdi;\n") != std::string::npos);
    CHECK(t.find("rax = (uint32)rax - 3;\n") != std::string::npos);
    CHECK(t.find("rax = (uint32)rax * (uint32)rsi;\n") != std::string::npos);
    CHECK(t.find("r8 = rdi;\n") != std::string::npos);
    CHECK(t.find("r8 = r8 + r9;\n") != std::string::npos);
    CHECK(t.find("(uint32)((uint32)") == std::string::npos);
    CHECK(t.find("rax = (uint32)(1)") == std::string::npos);
    CHECK(t.find("r8 = (rdi)") == std::string::npos);
    CHECK(verify_c11_syntax_werror(t, "b2_clean_casts"));
  }

  // B3: Post-body dead local declaration pruning & exact linemap line_no adjustment.
  {
    // push rbx; cmp r12, r13; cmp r14, r15; mov eax, 42; pop rbx; ret
    // Pass 1 marks r12..r15 used, B1 prunes both dead CMPs, B3 prunes the extra
    // `uint64 r12 = 0, r13 = 0, r14 = 0, r15 = 0;` line and shifts body linemap line_no!
    const uint8_t b3_code[] = {
        0x53,                          // 0x490800: push rbx
        0x4d, 0x39, 0xec,              // 0x490801: cmp r12, r13 (dead)
        0x4d, 0x39, 0xfe,              // 0x490804: cmp r14, r15 (dead)
        0xb8, 0x2a, 0x00, 0x00, 0x00,  // 0x490807: mov eax, 42
        0x5b,                          // 0x49080C: pop rbx
        0xc3,                          // 0x49080D: ret
    };
    CHECK(hex_engine_decompile_x86_64(
              b3_code, sizeof(b3_code), 0x490800ULL, "b3_prune_decls", 14u,
              HEX_X86_ABI_SYSV_AMD64, HEX_EMIT_FLAG_JS_PARITY) == HEX_OK);
    const std::string t = get_emitted_text();
    CHECK(t.find("r12") == std::string::npos);
    CHECK(t.find("r13") == std::string::npos);
    CHECK(t.find("r14") == std::string::npos);
    CHECK(t.find("r15") == std::string::npos);
    CHECK(t.find("rax = 42;\n") != std::string::npos);
    CHECK(verify_c11_syntax_werror(t, "b3_prune_decls"));

    // Verify linemap line_no matches actual line containing `rax = 42;`!
    std::vector<std::string> lines;
    size_t pos = 0u;
    while (pos < t.size()) {
      const size_t nl = t.find('\n', pos);
      if (nl == std::string::npos) {
        lines.push_back(t.substr(pos));
        break;
      }
      lines.push_back(t.substr(pos, nl - pos));
      pos = nl + 1u;
    }
    const HexLineMapEntry* lm = hex_x86_64_decomp_get_linemap_ptr();
    const uint32_t lm_cnt = hex_x86_64_decomp_get_linemap_count();
    bool found_mov42_line = false;
    for (uint32_t k = 0u; k < lm_cnt; ++k) {
      CHECK(lm[k].line_no >= 1u && lm[k].line_no <= lines.size());
      if (lm[k].addr == 0x490807ULL) {
        CHECK(lines[lm[k].line_no - 1u].find("rax = 42;") != std::string::npos);
        found_mov42_line = true;
      }
    }
    CHECK(found_mov42_line);
  }
  std::printf("  [PASS] Wave 33 Track B: B1 fusion/liveness/test-self, B2 clean casts, B3 decl pruning + linemap\n");
}

}  // namespace

int main() {
  test_sysv_amd64_straight_line();
  test_microsoft_x64_straight_line();
  test_three_real_x86_64_binaries();
  test_x86_64_loop_structuring();
  test_negative_and_general_fallback();
  test_general_call_and_tail_call();
  test_general_cmovcc_setcc_and_alu_ext();
  test_general_sse2_and_unknown_opcodes();
  test_general_large_function_and_32k_limit();
  test_repeated_emit_arena_zero_leak_and_scratch_survival();
  test_strict_undeclared_label_fallback();
  test_general_goto_reduction();
  test_general_recursive_6param_and_cleanup();
  test_zero_goto_state_machine_and_main();
  test_wave32_readability_and_compare_fusion();
  test_wave33_track_b_readability();

  if (g_failures == 0) {
    std::printf("test_x86_64_decomp_native (ASan+UBSan): ALL PASS\n");
    return 0;
  }
  std::fprintf(stderr, "test_x86_64_decomp_native: %d FAILURE(S)\n", g_failures);
  return 1;
}
