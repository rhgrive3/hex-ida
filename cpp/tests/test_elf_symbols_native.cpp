#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "../src/binary/elf_symbols.hpp"

namespace {

static void put_u16(std::vector<uint8_t>& buf, uint16_t v, bool be) {
  if (be) {
    buf.push_back(static_cast<uint8_t>((v >> 8u) & 0xffu));
    buf.push_back(static_cast<uint8_t>(v & 0xffu));
  } else {
    buf.push_back(static_cast<uint8_t>(v & 0xffu));
    buf.push_back(static_cast<uint8_t>((v >> 8u) & 0xffu));
  }
}

static void put_u32(std::vector<uint8_t>& buf, uint32_t v, bool be) {
  if (be) {
    buf.push_back(static_cast<uint8_t>((v >> 24u) & 0xffu));
    buf.push_back(static_cast<uint8_t>((v >> 16u) & 0xffu));
    buf.push_back(static_cast<uint8_t>((v >> 8u) & 0xffu));
    buf.push_back(static_cast<uint8_t>(v & 0xffu));
  } else {
    buf.push_back(static_cast<uint8_t>(v & 0xffu));
    buf.push_back(static_cast<uint8_t>((v >> 8u) & 0xffu));
    buf.push_back(static_cast<uint8_t>((v >> 16u) & 0xffu));
    buf.push_back(static_cast<uint8_t>((v >> 24u) & 0xffu));
  }
}

static void put_u64(std::vector<uint8_t>& buf, uint64_t v, bool be) {
  if (be) {
    put_u32(buf, static_cast<uint32_t>(v >> 32u), true);
    put_u32(buf, static_cast<uint32_t>(v & 0xffffffffULL), true);
  } else {
    put_u32(buf, static_cast<uint32_t>(v & 0xffffffffULL), false);
    put_u32(buf, static_cast<uint32_t>(v >> 32u), false);
  }
}

static void push_elf64_sym(std::vector<uint8_t>& buf,
                           uint32_t name, uint8_t info, uint8_t other, uint16_t shndx,
                           uint64_t value, uint64_t size, bool be) {
  put_u32(buf, name, be);
  buf.push_back(info);
  buf.push_back(other);
  put_u16(buf, shndx, be);
  put_u64(buf, value, be);
  put_u64(buf, size, be);
}

static void push_elf32_sym(std::vector<uint8_t>& buf,
                           uint32_t name, uint32_t value, uint32_t size,
                           uint8_t info, uint8_t other, uint16_t shndx, bool be) {
  put_u32(buf, name, be);
  put_u32(buf, value, be);
  put_u32(buf, size, be);
  buf.push_back(info);
  buf.push_back(other);
  put_u16(buf, shndx, be);
}

static void test_elf64_le_and_be_with_xindex_and_edge_names() {
  // strtab: "\0main\0unterm" (no trailing NUL after "unterm"!)
  const uint8_t strtab[] = {0, 'm', 'a', 'i', 'n', 0, 'u', 'n', 't', 'e', 'r', 'm'};
  const uint32_t strtab_len = static_cast<uint32_t>(sizeof(strtab));

  for (int be_i = 0; be_i < 2; ++be_i) {
    const bool be = (be_i == 1);
    std::vector<uint8_t> syms;
    std::vector<uint8_t> xidx;

    // 0: normal symbol "main"
    push_elf64_sym(syms, 1u, 0x12u, 0x00u, 3u, 0x0000000100401000ULL, 0x48ULL, be);
    put_u32(xidx, 3u, be);

    // 1: SHN_XINDEX symbol with unterminated name at offset 6 ("unterm")
    push_elf64_sym(syms, 6u, 0x11u, 0x02u, 0xFFFFu, 0x0000000200002000ULL, 0x100ULL, be);
    put_u32(xidx, 0x00012345u, be);

    // 2: out-of-range name_off
    push_elf64_sym(syms, 999u, 0x00u, 0x00u, 0u, 0ULL, 0ULL, be);
    put_u32(xidx, 0u, be);

    HexElfSymbolRecord recs[3];
    std::memset(recs, 0xaa, sizeof(recs));
    uint32_t out_count = 0u;
    const uint32_t flags = HEX_ELF_SYM_FLAG_64BIT | (be ? HEX_ELF_SYM_FLAG_BIG_ENDIAN : 0u);
    const HexStatus st = hex_elf_extract_symbols(
        syms.data(), static_cast<uint32_t>(syms.size()), 24u, 3u,
        strtab, strtab_len,
        xidx.data(), static_cast<uint32_t>(xidx.size()),
        flags, recs, 3u, &out_count);
    assert(st == HEX_OK);
    assert(out_count == 3u);

    assert(recs[0].name_off == 1u && recs[0].name_len == 4u && recs[0].flags == 0u);
    assert(recs[0].value == 0x0000000100401000ULL && recs[0].size == 0x48ULL);
    assert(recs[0].shndx == 3u && recs[0].info == 0x12u && recs[0].other == 0x00u && recs[0]._pad == 0u);

    assert(recs[1].name_off == 6u && recs[1].name_len == 6u && recs[1].flags == HEX_ELF_REC_NAME_UNTERMINATED);
    assert(recs[1].value == 0x0000000200002000ULL && recs[1].size == 0x100ULL);
    assert(recs[1].shndx == 0x00012345u && recs[1].info == 0x11u && recs[1].other == 0x02u);

    assert(recs[2].name_off == 999u && recs[2].name_len == 0xFFFFFFFFu && recs[2].flags == HEX_ELF_REC_NAME_OUT_OF_RANGE);
    assert(recs[2].shndx == 0u);

    // Without xindex (nullptr), SHN_XINDEX stays raw 0xFFFFu
    assert(hex_elf_extract_symbols(
               syms.data(), static_cast<uint32_t>(syms.size()), 24u, 3u,
               strtab, strtab_len, nullptr, 0u, flags, recs, 3u, &out_count) == HEX_OK);
    assert(recs[1].shndx == 0xFFFFu);
  }
}

static void test_elf32_le_and_be() {
  const uint8_t strtab[] = {0, 'f', 'o', 'o', 0};
  for (int be_i = 0; be_i < 2; ++be_i) {
    const bool be = (be_i == 1);
    std::vector<uint8_t> syms;
    push_elf32_sym(syms, 1u, 0x08048100u, 0x20u, 0x12u, 0x01u, 14u, be);

    HexElfSymbolRecord rec{};
    uint32_t out_count = 0u;
    const uint32_t flags = be ? HEX_ELF_SYM_FLAG_BIG_ENDIAN : 0u;
    assert(hex_elf_extract_symbols(
               syms.data(), static_cast<uint32_t>(syms.size()), 16u, 1u,
               strtab, static_cast<uint32_t>(sizeof(strtab)),
               nullptr, 0u, flags, &rec, 1u, &out_count) == HEX_OK);
    assert(out_count == 1u);
    assert(rec.name_off == 1u && rec.name_len == 3u && rec.flags == 0u);
    assert(rec.value == 0x08048100ULL && rec.size == 0x20ULL);
    assert(rec.info == 0x12u && rec.other == 0x01u && rec.shndx == 14u);
  }
}

static void test_invalid_args() {
  uint8_t buf[32] = {0};
  HexElfSymbolRecord recs[2];
  uint32_t out_count = 99u;

  // Null out_count
  assert(hex_elf_extract_symbols(buf, 32u, 24u, 1u, nullptr, 0u, nullptr, 0u, 1u, recs, 2u, nullptr) == HEX_ERR_INVALID_ARG);
  // count == 0 succeeds and zeros out_count
  assert(hex_elf_extract_symbols(nullptr, 0u, 0u, 0u, nullptr, 0u, nullptr, 0u, 1u, nullptr, 0u, &out_count) == HEX_OK);
  assert(out_count == 0u);
  // Null sym_bytes / out_records
  assert(hex_elf_extract_symbols(nullptr, 32u, 24u, 1u, nullptr, 0u, nullptr, 0u, 1u, recs, 2u, &out_count) == HEX_ERR_INVALID_ARG);
  assert(hex_elf_extract_symbols(buf, 32u, 24u, 1u, nullptr, 0u, nullptr, 0u, 1u, nullptr, 2u, &out_count) == HEX_ERR_INVALID_ARG);
  // max_records < count
  assert(hex_elf_extract_symbols(buf, 32u, 16u, 2u, nullptr, 0u, nullptr, 0u, 0u, recs, 1u, &out_count) == HEX_ERR_INVALID_ARG);
  // ent_size too small for ELF64 (23 < 24) and ELF32 (15 < 16)
  assert(hex_elf_extract_symbols(buf, 32u, 23u, 1u, nullptr, 0u, nullptr, 0u, 1u, recs, 2u, &out_count) == HEX_ERR_INVALID_ARG);
  assert(hex_elf_extract_symbols(buf, 32u, 15u, 1u, nullptr, 0u, nullptr, 0u, 0u, recs, 2u, &out_count) == HEX_ERR_INVALID_ARG);
  // count * ent_size > sym_bytes_len
  assert(hex_elf_extract_symbols(buf, 32u, 24u, 2u, nullptr, 0u, nullptr, 0u, 1u, recs, 2u, &out_count) == HEX_ERR_INVALID_ARG);
}

}  // namespace

int main() {
  test_elf64_le_and_be_with_xindex_and_edge_names();
  test_elf32_le_and_be();
  test_invalid_args();
  std::printf("test_elf_symbols_native (ASan+UBSan, ELF64/32 LE/BE + XINDEX + guards): ALL PASS\n");
  return 0;
}
