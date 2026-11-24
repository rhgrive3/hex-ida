#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "../src/binary/image_store.hpp"

namespace {

std::vector<uint8_t> read_file(const std::string& path) {
  std::ifstream ifs(path, std::ios::binary);
  assert(ifs.good() && "failed to open fixture file");
  return std::vector<uint8_t>(
      std::istreambuf_iterator<char>(ifs),
      std::istreambuf_iterator<char>());
}

void write_u16_le(std::vector<uint8_t>& buf, size_t off, uint16_t v) {
  buf[off + 0] = static_cast<uint8_t>(v & 0xffu);
  buf[off + 1] = static_cast<uint8_t>((v >> 8) & 0xffu);
}

void write_u32_le(std::vector<uint8_t>& buf, size_t off, uint32_t v) {
  buf[off + 0] = static_cast<uint8_t>(v & 0xffu);
  buf[off + 1] = static_cast<uint8_t>((v >> 8) & 0xffu);
  buf[off + 2] = static_cast<uint8_t>((v >> 16) & 0xffu);
  buf[off + 3] = static_cast<uint8_t>((v >> 24) & 0xffu);
}

void write_u32_be(std::vector<uint8_t>& buf, size_t off, uint32_t v) {
  buf[off + 0] = static_cast<uint8_t>((v >> 24) & 0xffu);
  buf[off + 1] = static_cast<uint8_t>((v >> 16) & 0xffu);
  buf[off + 2] = static_cast<uint8_t>((v >> 8) & 0xffu);
  buf[off + 3] = static_cast<uint8_t>(v & 0xffu);
}

void write_u64_le(std::vector<uint8_t>& buf, size_t off, uint64_t v) {
  write_u32_le(buf, off, static_cast<uint32_t>(v & 0xffffffffu));
  write_u32_le(buf, off + 4, static_cast<uint32_t>(v >> 32));
}

std::vector<uint8_t> make_minimal_macho64(uint32_t cputype, uint32_t cpusubtype) {
  std::vector<uint8_t> b(32, 0);
  write_u32_le(b, 0, 0xFEEDFACFu);
  write_u32_le(b, 4, cputype);
  write_u32_le(b, 8, cpusubtype);
  write_u32_le(b, 12, 2u);  // MH_EXECUTE
  write_u32_le(b, 16, 0u);  // ncmds
  write_u32_le(b, 20, 0u);  // sizeofcmds
  return b;
}

std::vector<uint8_t> make_macho64_two_segs(
    uint64_t vm1, uint64_t sz1, uint64_t vm2, uint64_t sz2) {
  // 32-byte header + 2 * 72-byte LC_SEGMENT_64 = 176 bytes
  std::vector<uint8_t> b(176, 0);
  write_u32_le(b, 0, 0xFEEDFACFu);
  write_u32_le(b, 4, 0x0100000Cu);  // ARM64
  write_u32_le(b, 8, 0u);
  write_u32_le(b, 12, 2u);
  write_u32_le(b, 16, 2u);    // ncmds = 2
  write_u32_le(b, 20, 144u);  // sizeofcmds = 2 * 72

  // Segment 1 at offset 32
  write_u32_le(b, 32, 0x19u);  // LC_SEGMENT_64
  write_u32_le(b, 36, 72u);
  std::memcpy(b.data() + 40, "__TEXT", 6);
  write_u64_le(b, 56, vm1);
  write_u64_le(b, 64, sz1);
  write_u64_le(b, 72, 0u);
  write_u64_le(b, 80, 0u);

  // Segment 2 at offset 104
  write_u32_le(b, 104, 0x19u);
  write_u32_le(b, 108, 72u);
  std::memcpy(b.data() + 112, "__DATA", 6);
  write_u64_le(b, 128, vm2);
  write_u64_le(b, 136, sz2);
  write_u64_le(b, 144, 0u);
  write_u64_le(b, 152, 0u);
  return b;
}

struct RealFixtureSpec {
  const char* path;
  uint32_t format;
  uint32_t arch;
  uint32_t bits;
  uint32_t endian;
  uint32_t expected_sections;
};

void test_real_13_binaries() {
  const RealFixtureSpec specs[] = {
      {"tests/fixtures/cxx-dwarf-holdout/holdout.stripped.elf", HEX_FORMAT_ELF, HEX_ARCH_ARM64, 64, HEX_ENDIAN_LITTLE, 11},
      {"tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.o", HEX_FORMAT_MACHO, HEX_ARCH_ARM64_32, 32, HEX_ENDIAN_LITTLE, 13},
      {"tests/phase12/rebuild/fixtures/vertical-macho-x86_64.o", HEX_FORMAT_MACHO, HEX_ARCH_X86_64, 64, HEX_ENDIAN_LITTLE, 2},
      {"tests/phase12/rebuild/fixtures/vertical-microsoft-x86.exe", HEX_FORMAT_PE, HEX_ARCH_X86, 32, HEX_ENDIAN_LITTLE, 2},
      {"tests/phase4/binary/fixtures/issue-4255-gnu-b-key-cfi.elf", HEX_FORMAT_ELF, HEX_ARCH_ARM64, 64, HEX_ENDIAN_LITTLE, 7},
      {"tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe", HEX_FORMAT_PE, HEX_ARCH_X86_64, 64, HEX_ENDIAN_LITTLE, 3},
      {"tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf", HEX_FORMAT_ELF, HEX_ARCH_X86_64, 64, HEX_ENDIAN_LITTLE, 13},
      {"tests/scpa/fixtures/arm64-real-byte-fpsimd-atomic-holdout.elf", HEX_FORMAT_ELF, HEX_ARCH_ARM64, 64, HEX_ENDIAN_LITTLE, 11},
      {"tests/scpa/fixtures/arm64-real-byte-semantic-holdout.elf", HEX_FORMAT_ELF, HEX_ARCH_ARM64, 64, HEX_ENDIAN_LITTLE, 11},
      {"tests/scpa/fixtures/dispatch-table.elf", HEX_FORMAT_ELF, HEX_ARCH_ARM64, 64, HEX_ENDIAN_LITTLE, 5},
      {"tests/scpa/fixtures/threaded-call-memory.elf", HEX_FORMAT_ELF, HEX_ARCH_ARM64, 64, HEX_ENDIAN_LITTLE, 5},
      {"tests/scpa/fixtures/threaded-integer.elf", HEX_FORMAT_ELF, HEX_ARCH_ARM64, 64, HEX_ENDIAN_LITTLE, 12},
      {"tests/stage2/fixtures/managed-real/cil/ManagedFixture.dll", HEX_FORMAT_PE, HEX_ARCH_X86, 32, HEX_ENDIAN_LITTLE, 3},
  };

  for (const auto& sp : specs) {
    auto bytes = read_file(sp.path);
    HexImageHandle h = 0;
    HexStatus st = hex_image_open(bytes.data(), static_cast<uint32_t>(bytes.size()), &h);
    assert(st == HEX_OK);
    assert(h != 0);

    HexImageInfo info{};
    assert(hex_image_get_info(h, &info) == HEX_OK);
    assert(info.format == sp.format);
    assert(info.arch == sp.arch);
    assert(info.bits == sp.bits);
    assert(info.endian == sp.endian);
    assert(info.section_count == sp.expected_sections);

    uint32_t sc = 0;
    assert(hex_image_section_count(h, &sc) == HEX_OK);
    assert(sc == sp.expected_sections);
    for (uint32_t i = 0; i < sc; ++i) {
      HexSectionInfo sec{};
      assert(hex_image_get_section(h, i, &sec) == HEX_OK);
      assert(sec.name[0] != '\0');
    }
    HexSectionInfo oob{};
    assert(hex_image_get_section(h, sc, &oob) == HEX_ERR_INVALID_ARG);

    assert(hex_image_close(h) == HEX_OK);
    // UAF check on closed handle
    assert(hex_image_get_info(h, &info) == HEX_ERR_INVALID_ARG);
    assert(hex_image_close(h) == HEX_ERR_INVALID_ARG);
  }
  std::printf("[PASS] 13 real binaries + generational handle UAF detection\n");
}

void test_corrupt_and_truncated() {
  HexImageHandle h = 0;
  uint8_t tiny[2] = {0x7F, 'E'};
  assert(hex_image_open(nullptr, 10, &h) == HEX_ERR_INVALID_ARG);
  assert(hex_image_open(tiny, 2, &h) == HEX_ERR_INVALID_ARG);

  uint8_t unk[16] = {1, 2, 3, 4, 5, 6, 7, 8};
  assert(hex_image_open(unk, 16, &h) == HEX_ERR_UNSUPPORTED);

  // Truncated ELF
  auto elf = read_file("tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf");
  assert(hex_image_open(elf.data(), 40, &h) == HEX_ERR_INVALID_ARG);
  assert(hex_image_open(elf.data(), 100, &h) == HEX_ERR_INVALID_ARG);

  // ELF section beyond EOF (SHT_PROGBITS with sh_offset + sh_size > len)
  {
    std::vector<uint8_t> bad_elf(64 + 2 * 64, 0);
    bad_elf[0] = 0x7F; bad_elf[1] = 'E'; bad_elf[2] = 'L'; bad_elf[3] = 'F';
    bad_elf[4] = 2; bad_elf[5] = 1;  // 64-bit LE
    write_u16_le(bad_elf, 16, 2);    // ET_EXEC
    write_u16_le(bad_elf, 18, 183);  // AArch64
    write_u64_le(bad_elf, 40, 64);   // e_shoff = 64
    write_u16_le(bad_elf, 58, 64);   // e_shentsize
    write_u16_le(bad_elf, 60, 2);    // e_shnum
    // Section 1: SHT_PROGBITS (1), sh_offset = 128, sh_size = 9999 > len
    write_u32_le(bad_elf, 128 + 4, 1u);
    write_u64_le(bad_elf, 128 + 24, 128u);
    write_u64_le(bad_elf, 128 + 32, 9999u);
    assert(hex_image_open(bad_elf.data(), static_cast<uint32_t>(bad_elf.size()), &h) == HEX_ERR_INVALID_ARG);
  }

  // ELF PT_LOAD mismatch with SHF_ALLOC section
  {
    // 64-byte ehdr + 56-byte phdr + 2*64-byte shdrs = 248 bytes
    std::vector<uint8_t> bad_elf(256, 0);
    bad_elf[0] = 0x7F; bad_elf[1] = 'E'; bad_elf[2] = 'L'; bad_elf[3] = 'F';
    bad_elf[4] = 2; bad_elf[5] = 1;
    write_u16_le(bad_elf, 16, 2);
    write_u16_le(bad_elf, 18, 183);
    write_u64_le(bad_elf, 32, 64);   // e_phoff
    write_u64_le(bad_elf, 40, 120);  // e_shoff
    write_u16_le(bad_elf, 54, 56);   // e_phentsize
    write_u16_le(bad_elf, 56, 1);    // e_phnum
    write_u16_le(bad_elf, 58, 64);   // e_shentsize
    write_u16_le(bad_elf, 60, 2);    // e_shnum
    // PT_LOAD: offset=0, vaddr=0x400000, filesz=256, memsz=256
    write_u32_le(bad_elf, 64 + 0, 1u);
    write_u64_le(bad_elf, 64 + 8, 0u);
    write_u64_le(bad_elf, 64 + 16, 0x400000ULL);
    write_u64_le(bad_elf, 64 + 32, 256u);
    write_u64_le(bad_elf, 64 + 40, 256u);
    // Section 1: SHT_PROGBITS, SHF_ALLOC (2), sh_addr=0x400010, sh_offset=0x20 (expected 0x10!)
    write_u32_le(bad_elf, 184 + 4, 1u);
    write_u64_le(bad_elf, 184 + 8, 2u);
    write_u64_le(bad_elf, 184 + 16, 0x400010ULL);
    write_u64_le(bad_elf, 184 + 24, 0x20u);
    write_u64_le(bad_elf, 184 + 32, 16u);
    assert(hex_image_open(bad_elf.data(), static_cast<uint32_t>(bad_elf.size()), &h) == HEX_ERR_INVALID_ARG);
  }

  // Truncated PE
  auto pe = read_file("tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe");
  assert(hex_image_open(pe.data(), 60, &h) == HEX_ERR_INVALID_ARG);
  assert(hex_image_open(pe.data(), 120, &h) == HEX_ERR_INVALID_ARG);

  std::printf("[PASS] Corrupt / truncated / ELF EOF & PT_LOAD mismatch fail-closed\n");
}

void test_macho_fat_validation() {
  auto make_fat = [](uint32_t c1, uint32_t s1, uint32_t o1, uint32_t sz1, uint32_t a1,
                     uint32_t c2, uint32_t s2, uint32_t o2, uint32_t sz2, uint32_t a2,
                     uint32_t in_c1, uint32_t in_s1, uint32_t in_c2, uint32_t in_s2) {
    std::vector<uint8_t> f(1024, 0);
    write_u32_be(f, 0, 0xCAFEBABEu);
    write_u32_be(f, 4, 2u);
    write_u32_be(f, 8, c1);  write_u32_be(f, 12, s1); write_u32_be(f, 16, o1); write_u32_be(f, 20, sz1); write_u32_be(f, 24, a1);
    write_u32_be(f, 28, c2); write_u32_be(f, 32, s2); write_u32_be(f, 36, o2); write_u32_be(f, 40, sz2); write_u32_be(f, 44, a2);
    auto m1 = make_minimal_macho64(in_c1, in_s1);
    auto m2 = make_minimal_macho64(in_c2, in_s2);
    if (o1 + m1.size() <= f.size()) std::memcpy(f.data() + o1, m1.data(), m1.size());
    if (o2 + m2.size() <= f.size()) std::memcpy(f.data() + o2, m2.data(), m2.size());
    return f;
  };

  HexImageHandle h = 0;
  // Valid 2-slice Fat (X86_64 @ 128 + ARM64 @ 256, align=7 -> 128B)
  {
    auto ok = make_fat(0x01000007u, 3u, 128u, 64u, 7u,
                       0x0100000Cu, 0u, 256u, 64u, 7u,
                       0x01000007u, 3u, 0x0100000Cu, 0u);
    assert(hex_image_open(ok.data(), static_cast<uint32_t>(ok.size()), &h) == HEX_OK);
    HexImageInfo info{};
    assert(hex_image_get_info(h, &info) == HEX_OK);
    assert(info.is_fat == 1u);
    assert(info.fat_slice_count == 2u);
    assert(info.arch == HEX_ARCH_ARM64);
    assert(info.slice_offset == 256u);
    assert(hex_image_close(h) == HEX_OK);
  }
  // align >= 64 rejected
  {
    auto bad = make_fat(0x01000007u, 3u, 128u, 64u, 64u,
                        0x0100000Cu, 0u, 256u, 64u, 7u,
                        0x01000007u, 3u, 0x0100000Cu, 0u);
    assert(hex_image_open(bad.data(), static_cast<uint32_t>(bad.size()), &h) == HEX_ERR_INVALID_ARG);
  }
  // Misaligned offset (132 % 128 != 0) rejected
  {
    auto bad = make_fat(0x01000007u, 3u, 132u, 64u, 7u,
                        0x0100000Cu, 0u, 256u, 64u, 7u,
                        0x01000007u, 3u, 0x0100000Cu, 0u);
    assert(hex_image_open(bad.data(), static_cast<uint32_t>(bad.size()), &h) == HEX_ERR_INVALID_ARG);
  }
  // Overlapping slices rejected
  {
    auto bad = make_fat(0x01000007u, 3u, 128u, 160u, 7u,
                        0x0100000Cu, 0u, 256u, 64u, 7u,
                        0x01000007u, 3u, 0x0100000Cu, 0u);
    assert(hex_image_open(bad.data(), static_cast<uint32_t>(bad.size()), &h) == HEX_ERR_INVALID_ARG);
  }
  // Duplicate (cputype, cpusubtype) rejected
  {
    auto bad = make_fat(0x0100000Cu, 0u, 128u, 64u, 7u,
                        0x0100000Cu, 0u, 256u, 64u, 7u,
                        0x0100000Cu, 0u, 0x0100000Cu, 0u);
    assert(hex_image_open(bad.data(), static_cast<uint32_t>(bad.size()), &h) == HEX_ERR_INVALID_ARG);
  }
  // Outer/Inner cputype mismatch rejected
  {
    auto bad = make_fat(0x01000007u, 3u, 128u, 64u, 7u,
                        0x0100000Cu, 0u, 256u, 64u, 7u,
                        0x0100000Cu, 0u, 0x0100000Cu, 0u);
    assert(hex_image_open(bad.data(), static_cast<uint32_t>(bad.size()), &h) == HEX_ERR_INVALID_ARG);
  }
  std::printf("[PASS] Mach-O Fat strict fail-closed validation\n");
}

void test_u64_wraparound_defense() {
  HexImageHandle h = 0;
  // Overlapping at top of 64-bit address space (addr + size == 2^64 wraps to 0 naively!)
  auto overlap = make_macho64_two_segs(
      0xFFFFFFFFFFFFF000ULL, 0x1000ULL,
      0xFFFFFFFFFFFFF800ULL, 0x800ULL);
  assert(hex_image_open(overlap.data(), static_cast<uint32_t>(overlap.size()), &h) == HEX_ERR_INVALID_ARG);

  // Strictly overflowing > 2^64 rejected
  auto over = make_macho64_two_segs(
      0xFFFFFFFFFFFFF000ULL, 0x2000ULL,
      0x1000ULL, 0x1000ULL);
  assert(hex_image_open(over.data(), static_cast<uint32_t>(over.size()), &h) == HEX_ERR_INVALID_ARG);

  // Adjacent non-overlapping up to 2^64 accepted
  auto adj = make_macho64_two_segs(
      0xFFFFFFFFFFFFE000ULL, 0x1000ULL,
      0xFFFFFFFFFFFFF000ULL, 0x1000ULL);
  assert(hex_image_open(adj.data(), static_cast<uint32_t>(adj.size()), &h) == HEX_OK);
  assert(hex_image_close(h) == HEX_OK);

  std::printf("[PASS] 2^64 wraparound closed-interval overlap defense\n");
}

void test_zero_copy_and_fixed_scratch_and_bind_arenas() {
  // 1. Fixed scratch (1 MiB) must return nullptr when exceeded, without corrupting image arena
  hex_image_scratch_reset();
  uint8_t* p1 = hex_image_scratch_alloc(512u * 1024u);
  assert(p1 != nullptr);
  uint8_t* p2 = hex_image_scratch_alloc(600u * 1024u);
  assert(p2 == nullptr);
  hex_image_scratch_reset();

  // 2. Zero-copy input API > 1 MiB (e.g. 1.5 MiB Mach-O padded)
  constexpr uint32_t kBigSize = 1536u * 1024u;
  uint8_t* in_buf = hex_image_alloc_input(kBigSize);
  assert(in_buf != nullptr);
  std::memset(in_buf, 0, kBigSize);
  auto hdr = make_minimal_macho64(0x0100000Cu, 0u);
  std::memcpy(in_buf, hdr.data(), hdr.size());

  HexImageHandle h = 0;
  assert(hex_image_open(in_buf, kBigSize, &h) == HEX_OK);
  HexImageInfo info{};
  assert(hex_image_get_info(h, &info) == HEX_OK);
  assert(info.format == HEX_FORMAT_MACHO);
  assert(info.arch == HEX_ARCH_ARM64);
  assert(info.file_size == kBigSize);
  assert(hex_image_close(h) == HEX_OK);

  // 3. External arena binding via hex::binary::bind_global_arenas
  static uint8_t ext_img_mem[256u * 1024u];
  static uint8_t ext_scr_mem[64u * 1024u];
  hex::Arena ext_img, ext_scr;
  ext_img.init_fixed(ext_img_mem, sizeof(ext_img_mem));
  ext_scr.init_fixed(ext_scr_mem, sizeof(ext_scr_mem));
  hex::binary::bind_global_arenas(&ext_img, &ext_scr);

  uint8_t* ext_in = hex_image_alloc_input(64u);
  assert(ext_in >= ext_img_mem && ext_in < ext_img_mem + sizeof(ext_img_mem));
  std::memset(ext_in, 0, 64u);
  std::memcpy(ext_in, hdr.data(), hdr.size());
  assert(hex_image_open(ext_in, 64u, &h) == HEX_OK);
  assert(hex_image_close(h) == HEX_OK);
  assert(hex_image_scratch_alloc(128u * 1024u) == nullptr);  // 64 KiB fixed cap enforced

  std::printf("[PASS] Fixed scratch, >1 MiB zero-copy input, and bind_global_arenas\n");
}

}  // namespace

int main() {
  test_real_13_binaries();
  test_corrupt_and_truncated();
  test_macho_fat_validation();
  test_u64_wraparound_defense();
  test_zero_copy_and_fixed_scratch_and_bind_arenas();
  std::printf("ALL test_binary_native TESTS PASSED\n");
  return 0;
}
