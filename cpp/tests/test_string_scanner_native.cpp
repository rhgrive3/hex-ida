#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "../src/binary/string_scanner.hpp"

namespace {

static void push_str(std::vector<uint8_t>& buf, const char* s) {
  while (*s != '\0') buf.push_back(static_cast<uint8_t>(*s++));
}

static void push_u16le(std::vector<uint8_t>& buf, uint16_t u) {
  buf.push_back(static_cast<uint8_t>(u & 0xffu));
  buf.push_back(static_cast<uint8_t>((u >> 8u) & 0xffu));
}

static void push_u16be(std::vector<uint8_t>& buf, uint16_t u) {
  buf.push_back(static_cast<uint8_t>((u >> 8u) & 0xffu));
  buf.push_back(static_cast<uint8_t>(u & 0xffu));
}

static void test_utf8_ascii_tab_and_rejections() {
  std::vector<uint8_t> buf;
  // Valid ASCII with TAB (0x09): "ab\tcd" at offset 0 (len 5)
  push_str(buf, "ab\tcd");
  // Reject 0x7f (DEL) and C1 control U+0080 (c2 80) and U+009f (c2 9f)
  buf.push_back(0x7fu);
  buf.push_back(0xc2u); buf.push_back(0x80u);
  buf.push_back(0xc2u); buf.push_back(0x9fu);
  // Valid UTF-8: U+00A0 (c2 a0) + "日本語" (e6 97 a5 e6 9c ac e8 aa 9e) + U+1F680 (f0 9f 9a 80) = 5 chars, 15 bytes
  const uint32_t utf8_off = static_cast<uint32_t>(buf.size());
  const uint8_t u8[] = {
      0xc2u, 0xa0u,
      0xe6u, 0x97u, 0xa5u,
      0xe6u, 0x9cu, 0xacu,
      0xe8u, 0xaau, 0x9eu,
      0xf0u, 0x9fu, 0x9au, 0x80u,
  };
  buf.insert(buf.end(), u8, u8 + sizeof(u8));
  // Invalid overlong 2-byte NUL (c0 80), overlong slash (c0 af), UTF-8 surrogate U+D800 (ed a0 80), >0x10ffff (f4 90 80 80)
  const uint8_t bad[] = {
      0xc0u, 0x80u,
      0xc0u, 0xafu,
      0xedu, 0xa0u, 0x80u,
      0xf4u, 0x90u, 0x80u, 0x80u,
  };
  buf.insert(buf.end(), bad, bad + sizeof(bad));
  // Valid trailing string "END!" at end
  const uint32_t end_off = static_cast<uint32_t>(buf.size());
  push_str(buf, "END!");

  HexStringScanRange range{0u, static_cast<uint32_t>(buf.size()), 7u, 0u};
  HexStringSpan spans[16];
  uint32_t count = 0u;
  const HexStatus st = hex_string_scan_ranges(
      buf.data(), static_cast<uint32_t>(buf.size()),
      &range, 1u, 4u, 4096u, HEX_STRING_SCAN_UTF8, 16u, spans, &count);
  assert(st == HEX_OK);
  assert(count == 3u);

  assert(spans[0].file_offset == 0u && spans[0].byte_length == 5u && spans[0].encoding == 0u && spans[0].range_idx == 7u);
  assert(spans[1].file_offset == utf8_off && spans[1].byte_length == 15u && spans[1].encoding == 0u && spans[1].range_idx == 7u);
  assert(spans[2].file_offset == end_off && spans[2].byte_length == 4u && spans[2].encoding == 0u && spans[2].range_idx == 7u);
}

static void test_utf16_le_be_parity_and_surrogates() {
  std::vector<uint8_t> buf;
  // Parity 0 UTF-16LE: "HI" + U+1F600 (D83D DE00) + "!" = 4 chars, 10 bytes at offset 0
  push_u16le(buf, 'H');
  push_u16le(buf, 'I');
  push_u16le(buf, 0xd83du);
  push_u16le(buf, 0xde00u);
  push_u16le(buf, '!');
  // Unpaired high surrogate + NUL + padding 1 byte to shift to parity 1
  push_u16le(buf, 0xd800u);
  push_u16le(buf, 0x0000u);
  buf.push_back(0x00u);

  // Parity 1 UTF-16BE: "ABCD" at odd offset
  const uint32_t be_odd_off = static_cast<uint32_t>(buf.size());
  assert((be_odd_off & 1u) == 1u);
  push_u16be(buf, 'A');
  push_u16be(buf, 'B');
  push_u16be(buf, 'C');
  push_u16be(buf, 'D');
  // Unpaired low surrogate BE
  push_u16be(buf, 0xdc00u);

  HexStringScanRange range{0u, static_cast<uint32_t>(buf.size()), 3u, 0u};
  HexStringSpan spans[32];
  uint32_t count = 0u;
  const HexStatus st = hex_string_scan_ranges(
      buf.data(), static_cast<uint32_t>(buf.size()),
      &range, 1u, 4u, 4096u, HEX_STRING_SCAN_UTF16LE | HEX_STRING_SCAN_UTF16BE, 32u, spans, &count);
  assert(st == HEX_OK);

  bool saw_le_0 = false;
  bool saw_be_odd = false;
  for (uint32_t i = 0u; i < count; ++i) {
    if (spans[i].encoding == HEX_STRING_ENC_UTF16LE && spans[i].file_offset == 0u && spans[i].byte_length == 10u) {
      saw_le_0 = true;
    }
    if (spans[i].encoding == HEX_STRING_ENC_UTF16BE && spans[i].file_offset == be_odd_off && spans[i].byte_length == 8u) {
      saw_be_odd = true;
    }
  }
  assert(saw_le_0 && saw_be_odd);
}

static void test_max_chars_chunk_splitting_and_limit() {
  // 10-char ASCII "0123456789" with min=4, max=4 -> splits into "0123" (off 0, len 4) and "4567" (off 4, len 4); "89" < 4 dropped.
  const uint8_t data[10] = {'0','1','2','3','4','5','6','7','8','9'};
  HexStringScanRange range{0u, 10u, 0u, 0u};
  HexStringSpan spans[8];
  uint32_t count = 0u;
  assert(hex_string_scan_ranges(data, 10u, &range, 1u, 4u, 4u, HEX_STRING_SCAN_UTF8, 8u, spans, &count) == HEX_OK);
  assert(count == 2u);
  assert(spans[0].file_offset == 0u && spans[0].byte_length == 4u);
  assert(spans[1].file_offset == 4u && spans[1].byte_length == 4u);

  // max_results = 1 stops at 1
  count = 99u;
  assert(hex_string_scan_ranges(data, 10u, &range, 1u, 4u, 4u, HEX_STRING_SCAN_UTF8, 1u, spans, &count) == HEX_OK);
  assert(count == 1u);
}

static void test_range_clamping_skipping_and_invalid_args() {
  const uint8_t data[12] = {'a','b','c','d', 0, 0, 'w','x','y','z', 0, 0};
  // Range 0: invalid start >= end (skipped)
  // Range 1: start >= byte_len (skipped)
  // Range 2: end > byte_len (clamped to 12)
  HexStringScanRange ranges[3] = {
      {5u, 5u, 10u, 0u},
      {20u, 30u, 11u, 0u},
      {0u, 999u, 12u, 0u},
  };
  HexStringSpan spans[8];
  uint32_t count = 0u;
  assert(hex_string_scan_ranges(data, 12u, ranges, 3u, 4u, 64u, HEX_STRING_SCAN_UTF8, 8u, spans, &count) == HEX_OK);
  assert(count == 2u);
  assert(spans[0].file_offset == 0u && spans[0].byte_length == 4u && spans[0].range_idx == 12u);
  assert(spans[1].file_offset == 6u && spans[1].byte_length == 4u && spans[1].range_idx == 12u);

  // Invalid argument checks
  assert(hex_string_scan_ranges(data, 12u, ranges, 1u, 4u, 64u, 1u, 8u, spans, nullptr) == HEX_ERR_INVALID_ARG);
  assert(hex_string_scan_ranges(nullptr, 12u, ranges, 1u, 4u, 64u, 1u, 8u, spans, &count) == HEX_ERR_INVALID_ARG);
  assert(hex_string_scan_ranges(data, 12u, nullptr, 1u, 4u, 64u, 1u, 8u, spans, &count) == HEX_ERR_INVALID_ARG);
  assert(hex_string_scan_ranges(data, 12u, ranges, 1u, 4u, 64u, 1u, 8u, nullptr, &count) == HEX_ERR_INVALID_ARG);
  assert(hex_string_scan_ranges(data, 12u, ranges, 1u, 1u, 64u, 1u, 8u, spans, &count) == HEX_ERR_INVALID_ARG);
  assert(hex_string_scan_ranges(data, 12u, ranges, 1u, 8u, 4u, 1u, 8u, spans, &count) == HEX_ERR_INVALID_ARG);
}

}  // namespace

int main() {
  test_utf8_ascii_tab_and_rejections();
  test_utf16_le_be_parity_and_surrogates();
  test_max_chars_chunk_splitting_and_limit();
  test_range_clamping_skipping_and_invalid_args();
  std::printf("test_string_scanner_native (ASan+UBSan): ALL PASS\n");
  return 0;
}
