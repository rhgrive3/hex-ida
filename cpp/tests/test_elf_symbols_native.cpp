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

static void test_overflow_and_stride_and_boundaries() {
  uint8_t buf[64] = {0};
  HexElfSymbolRecord recs[4];
  uint32_t out_count = 0u;

  // 1) 32-bit multiplication overflow (count * ent_size wraps in u32) and output-record 32-bit wrap guard
  assert(hex_elf_extract_symbols(buf, 64u, 16u, 0x10000001u, nullptr, 0u, nullptr, 0u, 0u, recs, 0x10000001u, &out_count) == HEX_ERR_RESOURCE_LIMIT);
  assert(hex_elf_extract_symbols(buf, 0xFFFFFFFFu, 16u, 0x08000001u, nullptr, 0u, nullptr, 0u, 0u, recs, 0x08000001u, &out_count) == HEX_ERR_RESOURCE_LIMIT);
  // 32-bit count*ent_size overflow below UINT32_MAX/32 record cap -> HEX_ERR_INVALID_ARG
  assert(hex_elf_extract_symbols(buf, 0xFFFFFFFFu, 64u, 0x07000000u, nullptr, 0u, nullptr, 0u, 0u, recs, 0x07000000u, &out_count) == HEX_ERR_INVALID_ARG);

  // 2) Non-minimal entry stride (ent_size = 32 for ELF64, ent_size = 20 for ELF32)
  {
    const uint8_t strtab[] = {0, 'a', 0, 'b', 0};
    std::vector<uint8_t> s64;
    push_elf64_sym(s64, 1u, 0x12u, 0x00u, 1u, 0x1000ULL, 0x10ULL, false);
    for (int k = 0; k < 8; ++k) s64.push_back(0xAAu);
    push_elf64_sym(s64, 3u, 0x12u, 0x02u, 2u, 0x2000ULL, 0x20ULL, false);
    for (int k = 0; k < 8; ++k) s64.push_back(0xBBu);
    assert(hex_elf_extract_symbols(s64.data(), static_cast<uint32_t>(s64.size()), 32u, 2u,
                                   strtab, static_cast<uint32_t>(sizeof(strtab)),
                                   nullptr, 0u, HEX_ELF_SYM_FLAG_64BIT, recs, 4u, &out_count) == HEX_OK);
    assert(out_count == 2u && recs[0].value == 0x1000ULL && recs[1].value == 0x2000ULL && recs[1].other == 0x02u);

    std::vector<uint8_t> s32;
    push_elf32_sym(s32, 1u, 0x3000u, 0x30u, 0x12u, 0x00u, 0xFFFFu, false);
    for (int k = 0; k < 4; ++k) s32.push_back(0xCCu);
    push_elf32_sym(s32, 3u, 0x4000u, 0x40u, 0x11u, 0x01u, 5u, false);
    for (int k = 0; k < 4; ++k) s32.push_back(0xDDu);
    // 3) ELF32 SHN_XINDEX valid and truncated xindex_bytes fallback
    std::vector<uint8_t> xidx;
    put_u32(xidx, 0x00012345u, false);
    put_u32(xidx, 0u, false);
    assert(hex_elf_extract_symbols(s32.data(), static_cast<uint32_t>(s32.size()), 20u, 2u,
                                   strtab, static_cast<uint32_t>(sizeof(strtab)),
                                   xidx.data(), static_cast<uint32_t>(xidx.size()), 0u, recs, 4u, &out_count) == HEX_OK);
    assert(out_count == 2u && recs[0].shndx == 0x00012345u && recs[1].shndx == 5u);
    // Truncated xindex_bytes (only 4 bytes for count=2 -> fallback to 0xFFFF)
    assert(hex_elf_extract_symbols(s32.data(), static_cast<uint32_t>(s32.size()), 20u, 2u,
                                   strtab, static_cast<uint32_t>(sizeof(strtab)),
                                   xidx.data(), 4u, 0u, recs, 4u, &out_count) == HEX_OK);
    assert(recs[0].shndx == 0xFFFFu);
  }

  // 4) Empty symbol name (name_off=0 at '\0') and str_bytes == nullptr with str_bytes_len > 0
  {
    const uint8_t strtab[] = {0, 'x', 0};
    std::vector<uint8_t> s64;
    push_elf64_sym(s64, 0u, 0x03u, 0x00u, 1u, 0ULL, 0ULL, false);
    assert(hex_elf_extract_symbols(s64.data(), static_cast<uint32_t>(s64.size()), 24u, 1u,
                                   strtab, static_cast<uint32_t>(sizeof(strtab)),
                                   nullptr, 0u, HEX_ELF_SYM_FLAG_64BIT, recs, 4u, &out_count) == HEX_OK);
    assert(recs[0].name_len == 0u && recs[0].flags == 0u);
    assert(hex_elf_extract_symbols(s64.data(), static_cast<uint32_t>(s64.size()), 24u, 1u,
                                   nullptr, 100u, nullptr, 0u, HEX_ELF_SYM_FLAG_64BIT, recs, 4u, &out_count) == HEX_OK);
    assert((recs[0].flags & HEX_ELF_REC_NAME_OUT_OF_RANGE) != 0u);
  }

  // 5) kMaxNameScanBytes (1 MiB) exact boundary + repeated unterminated cache
  {
    const uint32_t cap = 1u << 20;
    std::vector<uint8_t> big_str(cap + 4u, static_cast<uint8_t>('A'));
    big_str[cap - 1u] = 0u;  // Terminated right at cap - 1
    std::vector<uint8_t> s64;
    push_elf64_sym(s64, 0u, 0x12u, 0u, 1u, 0ULL, 0ULL, false);
    assert(hex_elf_extract_symbols(s64.data(), static_cast<uint32_t>(s64.size()), 24u, 1u,
                                   big_str.data(), static_cast<uint32_t>(big_str.size()),
                                   nullptr, 0u, HEX_ELF_SYM_FLAG_64BIT, recs, 4u, &out_count) == HEX_OK);
    assert(recs[0].name_len == cap - 1u && recs[0].flags == 0u);

    // Move NUL to offset cap -> exceeds scan_limit (clamped with UNTERMINATED)
    big_str[cap - 1u] = static_cast<uint8_t>('A');
    big_str[cap] = 0u;
    push_elf64_sym(s64, 0u, 0x12u, 0u, 1u, 0ULL, 0ULL, false);
    assert(hex_elf_extract_symbols(s64.data(), static_cast<uint32_t>(s64.size()), 24u, 2u,
                                   big_str.data(), static_cast<uint32_t>(big_str.size()),
                                   nullptr, 0u, HEX_ELF_SYM_FLAG_64BIT, recs, 4u, &out_count) == HEX_OK);
    assert(recs[0].name_len == cap && (recs[0].flags & HEX_ELF_REC_NAME_UNTERMINATED) != 0u);
    assert(recs[1].name_len == cap && (recs[1].flags & HEX_ELF_REC_NAME_UNTERMINATED) != 0u);
  }
}

int main() {
  test_elf64_le_and_be_with_xindex_and_edge_names();
  test_elf32_le_and_be();
  test_invalid_args();
  test_overflow_and_stride_and_boundaries();
  std::printf("test_elf_symbols_native (ASan+UBSan, ELF64/32 LE/BE + XINDEX + boundaries + guards): ALL PASS\n");
  return 0;
}
