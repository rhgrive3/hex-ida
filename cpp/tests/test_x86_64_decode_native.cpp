#include "../src/targets/x86_64_decode.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

int g_failures = 0;

void fail_msg(const char* msg, int line) {
  std::fprintf(stderr, "FAIL (line %d): %s\n", line, msg);
  ++g_failures;
}

#define CHECK(cond) \
  do { \
    if (!(cond)) { \
      fail_msg(#cond, __LINE__); \
    } \
  } while (0)

struct ExpectedInsn {
  uint64_t pc;
  uint8_t len;
  const char* mn;
  uint8_t kind;
  uint64_t target;
  bool has_target;
};

static bool read_file_slice(
    const char* path,
    size_t offset,
    size_t size,
    uint8_t* out_buf) {
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

static void verify_binary_section(
    const char* label,
    const char* path,
    size_t offset,
    size_t size,
    uint64_t base_pc,
    const ExpectedInsn* expected,
    uint32_t expected_count) {
  uint8_t buf[256];
  CHECK(size <= sizeof(buf));
  if (!read_file_slice(path, offset, size, buf)) {
    std::fprintf(stderr, "FAIL: could not read %s\n", path);
    ++g_failures;
    return;
  }

  CHECK(hex_x86_64_is_decompiler_supported(buf, static_cast<uint32_t>(size)) == HEX_X86_CAP_DECOMP);

  HexX86Decoded decoded[64];
  uint32_t count = 0;
  const HexStatus st = hex_x86_64_decode_batch(
      buf, static_cast<uint32_t>(size), base_pc, decoded, 64u, &count);
  CHECK(st == HEX_OK);
  CHECK(count == expected_count);
  if (count != expected_count) {
    std::fprintf(stderr, "  %s: got count=%u expected=%u\n", label, count, expected_count);
    return;
  }

  uint32_t total_bytes = 0;
  for (uint32_t i = 0; i < expected_count; ++i) {
    const HexX86Decoded& d = decoded[i];
    const ExpectedInsn& e = expected[i];
    if (d.valid != 1u || d.pc != e.pc || d.length != e.len ||
        d.kind != e.kind || d.cap != HEX_X86_CAP_DECOMP ||
        std::strcmp(d.mn, e.mn) != 0) {
      std::fprintf(
          stderr,
          "FAIL %s[%u]: got (valid=%u pc=0x%llx len=%u kind=%u mn='%s' cap=%u) "
          "expected (pc=0x%llx len=%u kind=%u mn='%s')\n",
          label, i, d.valid, static_cast<unsigned long long>(d.pc), d.length,
          d.kind, d.mn, d.cap, static_cast<unsigned long long>(e.pc), e.len,
          e.kind, e.mn);
      ++g_failures;
    }
    if (e.has_target) {
      if ((d.flags & HEX_X86_FLAG_HAS_TARGET) == 0u || d.target != e.target) {
        std::fprintf(
            stderr,
            "FAIL %s[%u] target: got 0x%llx (flags=0x%x) expected 0x%llx\n",
            label, i, static_cast<unsigned long long>(d.target), d.flags,
            static_cast<unsigned long long>(e.target));
        ++g_failures;
      }
    }
    total_bytes += d.length;
  }
  CHECK(total_bytes == static_cast<uint32_t>(size));
}

static void test_three_real_binaries() {
  // 1. vertical-sysv-amd64.elf (.text off=4096, size=77, base=0x401000, 25 insns)
  const ExpectedInsn sysv_expected[25] = {
      {0x401000, 1, "push", HEX_X86_KIND_PUSH, 0, false},
      {0x401001, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401004, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401007, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x40100b, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x40100e, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401012, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401014, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401017, 4, "movzx", HEX_X86_KIND_MOVZX, 0, false},
      {0x40101b, 3, "add", HEX_X86_KIND_ALU, 0, false},
      {0x40101e, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401021, 4, "cmp", HEX_X86_KIND_CMP, 0, false},
      {0x401025, 6, "jle", HEX_X86_KIND_JCC, 0x401039, true},
      {0x40102b, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x40102e, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401032, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401034, 5, "jmp", HEX_X86_KIND_JMP, 0x401045, true},
      {0x401039, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x40103c, 3, "sub", HEX_X86_KIND_ALU, 0, false},
      {0x40103f, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401043, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401045, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x401049, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x40104b, 1, "pop", HEX_X86_KIND_POP, 0, false},
      {0x40104c, 1, "ret", HEX_X86_KIND_RET, 0, false},
  };
  verify_binary_section(
      "vertical-sysv-amd64.elf",
      "tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf",
      4096, 77, 0x401000ull, sysv_expected, 25u);

  // 2. vertical-microsoft-x64.exe (.text off=1024, size=84, base=0x140001000, 26 insns)
  const ExpectedInsn pe_expected[26] = {
      {0x140001000, 1, "push", HEX_X86_KIND_PUSH, 0, false},
      {0x140001001, 4, "sub", HEX_X86_KIND_ALU, 0, false},
      {0x140001005, 5, "lea", HEX_X86_KIND_LEA, 0, false},
      {0x14000100a, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x14000100d, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001011, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001015, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001017, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x14000101a, 4, "movzx", HEX_X86_KIND_MOVZX, 0, false},
      {0x14000101e, 3, "add", HEX_X86_KIND_ALU, 0, false},
      {0x140001021, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001024, 4, "cmp", HEX_X86_KIND_CMP, 0, false},
      {0x140001028, 6, "jle", HEX_X86_KIND_JCC, 0x14000103c, true},
      {0x14000102e, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001031, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001035, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001037, 5, "jmp", HEX_X86_KIND_JMP, 0x140001048, true},
      {0x14000103c, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x14000103f, 3, "sub", HEX_X86_KIND_ALU, 0, false},
      {0x140001042, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001046, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x140001048, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x14000104c, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x14000104e, 4, "add", HEX_X86_KIND_ALU, 0, false},
      {0x140001052, 1, "pop", HEX_X86_KIND_POP, 0, false},
      {0x140001053, 1, "ret", HEX_X86_KIND_RET, 0, false},
  };
  verify_binary_section(
      "vertical-microsoft-x64.exe",
      "tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe",
      1024, 84, 0x140001000ull, pe_expected, 26u);

  // 3. vertical-macho-x86_64.o (__text off=384, size=77, base=0x0, 25 insns)
  const ExpectedInsn macho_expected[25] = {
      {0x00, 1, "push", HEX_X86_KIND_PUSH, 0, false},
      {0x01, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x04, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x07, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x0b, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x0e, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x12, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x14, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x17, 4, "movzx", HEX_X86_KIND_MOVZX, 0, false},
      {0x1b, 3, "add", HEX_X86_KIND_ALU, 0, false},
      {0x1e, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x21, 4, "cmp", HEX_X86_KIND_CMP, 0, false},
      {0x25, 6, "jle", HEX_X86_KIND_JCC, 0x39, true},
      {0x2b, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x2e, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x32, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x34, 5, "jmp", HEX_X86_KIND_JMP, 0x45, true},
      {0x39, 3, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x3c, 3, "sub", HEX_X86_KIND_ALU, 0, false},
      {0x3f, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x43, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x45, 4, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x49, 2, "mov", HEX_X86_KIND_MOV, 0, false},
      {0x4b, 1, "pop", HEX_X86_KIND_POP, 0, false},
      {0x4c, 1, "ret", HEX_X86_KIND_RET, 0, false},
  };
  verify_binary_section(
      "vertical-macho-x86_64.o",
      "tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o",
      384, 77, 0x0ull, macho_expected, 25u);
}

static void test_additional_instructions() {
  HexX86Decoded d;

  // endbr64: F3 0F 1E FA
  const uint8_t endbr64[] = {0xf3, 0x0f, 0x1e, 0xfa};
  CHECK(hex_x86_64_decode_one(endbr64, sizeof(endbr64), 0x1000, &d) == HEX_OK);
  CHECK(d.valid == 1 && d.length == 4 && d.kind == HEX_X86_KIND_NOP &&
        d.cap == HEX_X86_CAP_DECOMP && std::strcmp(d.mn, "endbr64") == 0);
  CHECK(hex_x86_64_is_decompiler_supported(endbr64, sizeof(endbr64)) == HEX_X86_CAP_DECOMP);

  // RIP-relative mov rax, [rip + 0x10]: 48 8b 05 10 00 00 00
  const uint8_t rip_mov[] = {0x48, 0x8b, 0x05, 0x10, 0x00, 0x00, 0x00};
  CHECK(hex_x86_64_decode_one(rip_mov, sizeof(rip_mov), 0x2000, &d) == HEX_OK);
  CHECK(d.valid == 1 && d.length == 7 && (d.flags & HEX_X86_FLAG_RIP_REL) != 0);
  CHECK(d.target == 0x2017 && d.disp == 0x10 && d.op_size == 64);

  // SIB + disp32: lea rax, [rbx + rcx*4 + 0x100]: 48 8d 84 8b 00 01 00 00
  const uint8_t sib_lea[] = {0x48, 0x8d, 0x84, 0x8b, 0x00, 0x01, 0x00, 0x00};
  CHECK(hex_x86_64_decode_one(sib_lea, sizeof(sib_lea), 0x3000, &d) == HEX_OK);
  CHECK(d.valid == 1 && d.length == 8 && (d.flags & HEX_X86_FLAG_HAS_SIB) != 0);
  CHECK(d.scale == 4 && d.disp == 0x100 && d.kind == HEX_X86_KIND_LEA);

  // 66 prefix: mov ax, 0x1234 (66 b8 34 12)
  const uint8_t mov16[] = {0x66, 0xb8, 0x34, 0x12};
  CHECK(hex_x86_64_decode_one(mov16, sizeof(mov16), 0, &d) == HEX_OK);
  CHECK(d.valid == 1 && d.length == 4 && d.op_size == 16 && d.imm == 0x1234);

  // imul eax, ecx (0f af c1), imul eax, ecx, 3 (6b c1 03), movsxd rax, ecx (48 63 c1)
  const uint8_t imul2[] = {0x0f, 0xaf, 0xc1};
  CHECK(hex_x86_64_decode_one(imul2, sizeof(imul2), 0, &d) == HEX_OK);
  CHECK(d.valid == 1 && d.length == 3 && d.kind == HEX_X86_KIND_MUL && std::strcmp(d.mn, "imul") == 0);

  const uint8_t imul3[] = {0x6b, 0xc1, 0x03};
  CHECK(hex_x86_64_decode_one(imul3, sizeof(imul3), 0, &d) == HEX_OK);
  CHECK(d.valid == 1 && d.length == 3 && d.kind == HEX_X86_KIND_MUL && d.imm == 3);

  const uint8_t movsxd[] = {0x48, 0x63, 0xc1};
  CHECK(hex_x86_64_decode_one(movsxd, sizeof(movsxd), 0, &d) == HEX_OK);
  CHECK(d.valid == 1 && d.length == 3 && d.kind == HEX_X86_KIND_MOVSX && std::strcmp(d.mn, "movsxd") == 0);

  // call rel32: e8 10 00 00 00
  const uint8_t call_rel[] = {0xe8, 0x10, 0x00, 0x00, 0x00};
  CHECK(hex_x86_64_decode_one(call_rel, sizeof(call_rel), 0x4000, &d) == HEX_OK);
  CHECK(d.valid == 1 && d.length == 5 && d.kind == HEX_X86_KIND_CALL && d.target == 0x4015);
  CHECK(hex_x86_64_is_decompiler_supported(call_rel, sizeof(call_rel)) == HEX_X86_CAP_DECOMP);

  // xor eax, eax (31 c0); and eax, 0xff (83 e0 ff); or eax, ecx (09 c8); nop (90); ret (c3)
  const uint8_t seq[] = {0x31, 0xc0, 0x83, 0xe0, 0xff, 0x09, 0xc8, 0x90, 0xc3};
  CHECK(hex_x86_64_is_decompiler_supported(seq, sizeof(seq)) == HEX_X86_CAP_DECOMP);
}

static void test_truncated_and_invalid_fail_closed() {
  HexX86Decoded d;

  // Null / empty
  CHECK(hex_x86_64_is_decompiler_supported(nullptr, 0) == HEX_X86_CAP_FALLBACK);
  const uint8_t dummy = 0x90;
  CHECK(hex_x86_64_is_decompiler_supported(&dummy, 0) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_insn_length(nullptr, 1) == 0u);

  // Truncated CALL rel32: e8 01 00
  const uint8_t trunc_call[] = {0xe8, 0x01, 0x00};
  CHECK(hex_x86_64_is_decompiler_supported(trunc_call, sizeof(trunc_call)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_insn_length(trunc_call, sizeof(trunc_call)) == 0u);
  CHECK(hex_x86_64_decode_one(trunc_call, sizeof(trunc_call), 0x1000, &d) == HEX_OK);
  CHECK(d.valid == 0 && (d.flags & HEX_X86_FLAG_TRUNCATED) != 0 && d.cap == HEX_X86_CAP_FALLBACK);

  // Valid instruction followed by truncated CALL rel32
  const uint8_t push_then_trunc_call[] = {0x55, 0xe8, 0x01, 0x00};
  CHECK(hex_x86_64_is_decompiler_supported(push_then_trunc_call, sizeof(push_then_trunc_call)) == HEX_X86_CAP_FALLBACK);

  // Truncated JMP rel32, Jcc rel32, endbr64, ModRM, SIB, disp, imm
  const uint8_t trunc_jmp[] = {0xe9, 0x01, 0x00};
  const uint8_t trunc_jcc[] = {0x0f, 0x8e, 0x0e, 0x00};
  const uint8_t trunc_endbr[] = {0xf3, 0x0f, 0x1e};
  const uint8_t trunc_modrm[] = {0x48, 0x89};
  const uint8_t trunc_sib[] = {0x48, 0x8d, 0x6c};
  const uint8_t trunc_disp8[] = {0x48, 0x8d, 0x6c, 0x24};
  const uint8_t trunc_rip[] = {0x48, 0x8b, 0x05, 0x01, 0x02};
  const uint8_t trunc_movabs[] = {0x48, 0xb8, 0x01, 0x02, 0x03, 0x04};
  CHECK(hex_x86_64_is_decompiler_supported(trunc_jmp, sizeof(trunc_jmp)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(trunc_jcc, sizeof(trunc_jcc)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(trunc_endbr, sizeof(trunc_endbr)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(trunc_modrm, sizeof(trunc_modrm)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(trunc_sib, sizeof(trunc_sib)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(trunc_disp8, sizeof(trunc_disp8)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(trunc_rip, sizeof(trunc_rip)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(trunc_movabs, sizeof(trunc_movabs)) == HEX_X86_CAP_FALLBACK);

  // Unsupported prefixes (LOCK, REP, FS segment, addr-size 67, duplicate 66, double REX)
  const uint8_t lock_add[] = {0xf0, 0x01, 0x00};
  const uint8_t rep_nop[] = {0xf3, 0x90};
  const uint8_t fs_mov[] = {0x64, 0x48, 0x8b, 0x04, 0x25, 0x28, 0x00, 0x00, 0x00};
  const uint8_t addr32_mov[] = {0x67, 0x89, 0xc0};
  const uint8_t dup_66[] = {0x66, 0x66, 0x89, 0xc0};
  const uint8_t dup_rex[] = {0x48, 0x48, 0x89, 0xc0};
  CHECK(hex_x86_64_is_decompiler_supported(lock_add, sizeof(lock_add)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(rep_nop, sizeof(rep_nop)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(fs_mov, sizeof(fs_mov)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(addr32_mov, sizeof(addr32_mov)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(dup_66, sizeof(dup_66)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(dup_rex, sizeof(dup_rex)) == HEX_X86_CAP_FALLBACK);

  // Invalid ModRM: lea rax, rbx (mod=3) and mov r/m, imm with reg!=0
  const uint8_t bad_lea[] = {0x48, 0x8d, 0xc3};
  const uint8_t bad_mov_imm[] = {0xc7, 0xc8, 0x01, 0x00, 0x00, 0x00};
  CHECK(hex_x86_64_is_decompiler_supported(bad_lea, sizeof(bad_lea)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_is_decompiler_supported(bad_mov_imm, sizeof(bad_mov_imm)) == HEX_X86_CAP_FALLBACK);

  // > 15 bytes instruction (15x 0x66 + 0x90 = 16 bytes)
  const uint8_t over15[16] = {
      0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
      0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x90,
  };
  CHECK(hex_x86_64_is_decompiler_supported(over15, sizeof(over15)) == HEX_X86_CAP_FALLBACK);
  CHECK(hex_x86_64_insn_length(over15, sizeof(over15)) == 0u);

  // Unknown opcode: ud2 (0f 0b)
  const uint8_t ud2[] = {0x0f, 0x0b};
  CHECK(hex_x86_64_is_decompiler_supported(ud2, sizeof(ud2)) == HEX_X86_CAP_FALLBACK);
}

}  // namespace

int main() {
  test_three_real_binaries();
  test_additional_instructions();
  test_truncated_and_invalid_fail_closed();

  if (g_failures == 0) {
    std::printf("test_x86_64_decode_native: ALL PASS (76 real binary insns + extended + fail-closed)\n");
    return 0;
  }
  std::fprintf(stderr, "test_x86_64_decode_native: %d FAILURE(S)\n", g_failures);
  return 1;
}
