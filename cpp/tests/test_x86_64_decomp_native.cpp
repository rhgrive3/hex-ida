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
      {"bare_jcc", bare_jcc, sizeof(bare_jcc), 0x1000ULL, nullptr, "loc_1002:"},
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

  if (g_failures == 0) {
    std::printf("test_x86_64_decomp_native (ASan+UBSan): ALL PASS\n");
    return 0;
  }
  std::fprintf(stderr, "test_x86_64_decomp_native: %d FAILURE(S)\n", g_failures);
  return 1;
}
