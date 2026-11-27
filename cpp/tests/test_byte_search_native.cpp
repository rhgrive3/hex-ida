#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "../src/core/byte_search.hpp"

namespace {

static uint8_t oracle_lower(uint8_t b) {
  return (b >= 65u && b <= 90u) ? static_cast<uint8_t>(b + 32u) : b;
}

static uint32_t naive_find(
    const uint8_t* haystack,
    uint32_t haystack_len,
    uint32_t from_offset,
    const uint8_t* pattern,
    const uint8_t* masks,
    uint32_t pattern_len,
    uint32_t flags) {
  if (from_offset > haystack_len || haystack_len - from_offset < pattern_len) {
    return HEX_BYTE_SEARCH_NOT_FOUND;
  }
  const bool fold_ascii = (flags & HEX_BYTE_SEARCH_FLAG_FOLD_ASCII) != 0u;
  const bool use_mask = !fold_ascii && ((flags & HEX_BYTE_SEARCH_FLAG_HAS_MASK) != 0u);
  const uint32_t end = haystack_len - pattern_len;
  for (uint32_t at = from_offset; at <= end; ++at) {
    bool ok = true;
    for (uint32_t i = 0u; i < pattern_len; ++i) {
      if (fold_ascii) {
        if (oracle_lower(haystack[at + i]) != oracle_lower(pattern[i])) {
          ok = false;
          break;
        }
      } else if (use_mask) {
        if (static_cast<uint8_t>(haystack[at + i] & masks[i]) != pattern[i]) {
          ok = false;
          break;
        }
      } else {
        if (haystack[at + i] != pattern[i]) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return at;
  }
  return HEX_BYTE_SEARCH_NOT_FOUND;
}

struct XorShift64 {
  uint64_t state;
  explicit XorShift64(uint64_t seed) : state(seed ? seed : 0x9e3779b97f4a7c15ULL) {}
  uint64_t next() {
    uint64_t x = state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    state = x;
    return x;
  }
  uint32_t next_u32(uint32_t bound) {
    return static_cast<uint32_t>(next() % bound);
  }
};

static void test_invalid_args() {
  const uint8_t hay[4] = {1, 2, 3, 4};
  const uint8_t pat[2] = {2, 3};
  uint32_t out = 123u;

  assert(hex_byte_search_find(hay, 4, 0, pat, nullptr, 2, 0, nullptr) == HEX_ERR_INVALID_ARG);
  assert(hex_byte_search_find(hay, 4, 0, nullptr, nullptr, 2, 0, &out) == HEX_ERR_INVALID_ARG);
  assert(hex_byte_search_find(hay, 4, 0, pat, nullptr, 0, 0, &out) == HEX_ERR_INVALID_ARG);
  assert(hex_byte_search_find(hay, 4, 0, pat, nullptr, 4097, 0, &out) == HEX_ERR_INVALID_ARG);
  assert(hex_byte_search_find(nullptr, 4, 0, pat, nullptr, 2, 0, &out) == HEX_ERR_INVALID_ARG);
  assert(hex_byte_search_find(hay, 4, 0, pat, nullptr, 2, HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_ERR_INVALID_ARG);

  // haystack == nullptr with haystack_len == 0 is valid and returns NOT_FOUND
  out = 99u;
  assert(hex_byte_search_find(nullptr, 0, 0, pat, nullptr, 2, 0, &out) == HEX_OK);
  assert(out == HEX_BYTE_SEARCH_NOT_FOUND);

  // fold_ascii ignores masks even if has_mask is set and masks == nullptr
  const uint8_t text[4] = {'A', 'b', 'C', 'd'};
  const uint8_t q[2] = {'b', 'c'};
  out = 99u;
  assert(hex_byte_search_find(
             text, 4, 0, q, nullptr, 2,
             HEX_BYTE_SEARCH_FLAG_FOLD_ASCII | HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_OK);
  assert(out == 1u);
}

static void test_boundaries_and_overlaps() {
  const uint8_t hay[] = {'a', 'a', 'a', 'a', 'a'};
  const uint8_t pat[] = {'a', 'a', 'a'};
  uint32_t out = 0u;

  // Overlapping matches: 0, 1, 2, then NOT_FOUND
  assert(hex_byte_search_find(hay, 5, 0, pat, nullptr, 3, 0, &out) == HEX_OK && out == 0u);
  assert(hex_byte_search_find(hay, 5, 1, pat, nullptr, 3, 0, &out) == HEX_OK && out == 1u);
  assert(hex_byte_search_find(hay, 5, 2, pat, nullptr, 3, 0, &out) == HEX_OK && out == 2u);
  assert(hex_byte_search_find(hay, 5, 3, pat, nullptr, 3, 0, &out) == HEX_OK && out == HEX_BYTE_SEARCH_NOT_FOUND);
  assert(hex_byte_search_find(hay, 5, 5, pat, nullptr, 3, 0, &out) == HEX_OK && out == HEX_BYTE_SEARCH_NOT_FOUND);
  assert(hex_byte_search_find(hay, 5, 100, pat, nullptr, 3, 0, &out) == HEX_OK && out == HEX_BYTE_SEARCH_NOT_FOUND);

  // pattern_len == 1 and pattern_len == 2
  const uint8_t b1[1] = {'x'};
  const uint8_t h1[4] = {'a', 'b', 'x', 'c'};
  assert(hex_byte_search_find(h1, 4, 0, b1, nullptr, 1, 0, &out) == HEX_OK && out == 2u);
  assert(hex_byte_search_find(h1, 4, 3, b1, nullptr, 1, 0, &out) == HEX_OK && out == HEX_BYTE_SEARCH_NOT_FOUND);

  const uint8_t b2[2] = {'x', 'c'};
  assert(hex_byte_search_find(h1, 4, 0, b2, nullptr, 2, 0, &out) == HEX_OK && out == 2u);
}

static void test_wildcards_and_all_zero_mask() {
  const uint8_t hay[] = {0x10, 0x2F, 0x3A, 0x45, 0x5B, 0x6C};
  uint32_t out = 0u;

  // All-zero mask with all-zero pattern -> returns from_offset
  const uint8_t zero_pat[3] = {0x00, 0x00, 0x00};
  const uint8_t zero_mask[3] = {0x00, 0x00, 0x00};
  assert(hex_byte_search_find(hay, 6, 0, zero_pat, zero_mask, 3, HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_OK);
  assert(out == 0u);
  assert(hex_byte_search_find(hay, 6, 3, zero_pat, zero_mask, 3, HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_OK);
  assert(out == 3u);
  assert(hex_byte_search_find(hay, 6, 4, zero_pat, zero_mask, 3, HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_OK);
  assert(out == HEX_BYTE_SEARCH_NOT_FOUND);

  // All-zero mask with non-zero pattern -> impossible -> NOT_FOUND
  const uint8_t nonzero_pat[3] = {0x00, 0x01, 0x00};
  assert(hex_byte_search_find(hay, 6, 0, nonzero_pat, zero_mask, 3, HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_OK);
  assert(out == HEX_BYTE_SEARCH_NOT_FOUND);

  // Nibble masks: match [0x2?, 0x?A, 0x45] at offset 1
  const uint8_t nib_pat[3] = {0x20, 0x0A, 0x45};
  const uint8_t nib_mask[3] = {0xF0, 0x0F, 0xFF};
  assert(hex_byte_search_find(hay, 6, 0, nib_pat, nib_mask, 3, HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_OK);
  assert(out == 1u);

  // Impossible nibble literal (bit set outside mask) -> NOT_FOUND
  const uint8_t bad_pat[3] = {0x21, 0x0A, 0x45};
  assert(hex_byte_search_find(hay, 6, 0, bad_pat, nib_mask, 3, HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_OK);
  assert(out == HEX_BYTE_SEARCH_NOT_FOUND);
}

static void test_ascii_fold_and_utf8() {
  // ASCII A-Z folds to a-z; '@' (64), '[' (91), and UTF-8 bytes (0xC3 0x80 vs 0xC3 0xA0) do NOT fold.
  const uint8_t hay[] = {
      0xC3, 0x80, '@', '[', 'H', 'e', 'L', 'l', 'O', '_', 'w', 'O', 'r', 'L', 'd', 0xE3, 0x81, 0x82
  };
  const uint32_t hay_len = static_cast<uint32_t>(sizeof(hay));
  uint32_t out = 0u;

  const uint8_t pat1[] = {'h', 'E', 'l', 'L', 'o', '_', 'W', 'o', 'R', 'l', 'D'};
  assert(hex_byte_search_find(hay, hay_len, 0, pat1, nullptr, 11, HEX_BYTE_SEARCH_FLAG_FOLD_ASCII, &out) == HEX_OK);
  assert(out == 4u);

  // UTF-8 'À' (0xC3 0x80) must NOT match 'à' (0xC3 0xA0) under fold_ascii
  const uint8_t utf8_lower[2] = {0xC3, 0xA0};
  assert(hex_byte_search_find(hay, hay_len, 0, utf8_lower, nullptr, 2, HEX_BYTE_SEARCH_FLAG_FOLD_ASCII, &out) == HEX_OK);
  assert(out == HEX_BYTE_SEARCH_NOT_FOUND);

  // Exact UTF-8 bytes match under fold_ascii
  const uint8_t utf8_jp[3] = {0xE3, 0x81, 0x82};
  assert(hex_byte_search_find(hay, hay_len, 0, utf8_jp, nullptr, 3, HEX_BYTE_SEARCH_FLAG_FOLD_ASCII, &out) == HEX_OK);
  assert(out == 15u);

  // '@' (64) must not fold to '`' (96); '[' (91) must not fold to '{' (123)
  const uint8_t non_alpha[2] = {'`', '{'};
  assert(hex_byte_search_find(hay, hay_len, 0, non_alpha, nullptr, 2, HEX_BYTE_SEARCH_FLAG_FOLD_ASCII, &out) == HEX_OK);
  assert(out == HEX_BYTE_SEARCH_NOT_FOUND);
}

static void test_large_buffer_and_max_pattern() {
  const uint32_t hay_len = 262144u;  // 256 KiB
  const uint32_t pat_len = HEX_BYTE_SEARCH_MAX_PATTERN;  // 4096
  std::vector<uint8_t> hay(hay_len, 0x41u);
  std::vector<uint8_t> pat(pat_len, 0x41u);
  pat[pat_len - 1u] = 0x42u;
  hay[hay_len - 1u] = 0x42u;

  uint32_t out = 0u;
  assert(hex_byte_search_find(hay.data(), hay_len, 0u, pat.data(), nullptr, pat_len, 0u, &out) == HEX_OK);
  assert(out == hay_len - pat_len);

  // Case-folded match at the end of 256 KiB buffer
  pat[pat_len - 1u] = 'b';
  assert(hex_byte_search_find(
             hay.data(), hay_len, 0u, pat.data(), nullptr, pat_len,
             HEX_BYTE_SEARCH_FLAG_FOLD_ASCII, &out) == HEX_OK);
  assert(out == hay_len - pat_len);

  // Masked match at the end of 256 KiB buffer
  std::vector<uint8_t> masks(pat_len, 0xFFu);
  masks[0] = 0x00u;
  pat[0] = 0x00u;
  masks[pat_len - 1u] = 0x0Fu;
  pat[pat_len - 1u] = 0x02u;
  assert(hex_byte_search_find(
             hay.data(), hay_len, 0u, pat.data(), masks.data(), pat_len,
             HEX_BYTE_SEARCH_FLAG_HAS_MASK, &out) == HEX_OK);
  assert(out == hay_len - pat_len);
}

static void test_random_fuzz() {
  XorShift64 rng(0x20261125CAFEBABEULL);
  const uint32_t kNumCases = 1500u;
  uint64_t total_steps = 0u;

  for (uint32_t tc = 0u; tc < kNumCases; ++tc) {
    const uint32_t flags = tc & 3u;
    const bool fold_ascii = (flags & HEX_BYTE_SEARCH_FLAG_FOLD_ASCII) != 0u;
    const bool use_mask = !fold_ascii && ((flags & HEX_BYTE_SEARCH_FLAG_HAS_MASK) != 0u);

    const uint32_t hay_len = (tc % 25u == 0u) ? rng.next_u32(8u) : (1u + rng.next_u32(256u));
    const uint32_t pat_len = (tc % 30u == 0u) ? (1u + rng.next_u32(3u)) : (1u + rng.next_u32(24u));

    // Vary alphabet size so we get frequent partial/overlapping matches AND sparse misses
    const uint32_t alphabet_mode = tc % 4u;
    std::vector<uint8_t> hay(hay_len);
    std::vector<uint8_t> pat(pat_len);
    std::vector<uint8_t> masks(pat_len);

    auto gen_byte = [&](uint32_t mode) -> uint8_t {
      if (mode == 0u) return static_cast<uint8_t>(rng.next_u32(4u));
      if (mode == 1u) {
        const uint32_t v = rng.next_u32(12u);
        return static_cast<uint8_t>((v < 6u) ? ('A' + v) : ('a' + (v - 6u)));
      }
      if (mode == 2u) return static_cast<uint8_t>(rng.next_u32(256u));
      return static_cast<uint8_t>(0x40u + rng.next_u32(64u));
    };

    for (uint32_t i = 0u; i < hay_len; ++i) hay[i] = gen_byte(alphabet_mode);
    for (uint32_t i = 0u; i < pat_len; ++i) {
      pat[i] = gen_byte(alphabet_mode);
      const uint32_t mkind = rng.next_u32(6u);
      if (mkind == 0u) masks[i] = 0x00u;
      else if (mkind == 1u) masks[i] = 0xFFu;
      else if (mkind == 2u) masks[i] = 0xF0u;
      else if (mkind == 3u) masks[i] = 0x0Fu;
      else masks[i] = static_cast<uint8_t>(rng.next_u32(256u));
    }

    // Plant an actual match in ~60% of cases so we exercise match + overlap stepping thoroughly
    if (hay_len >= pat_len && (rng.next_u32(5u) < 3u)) {
      const uint32_t pos = rng.next_u32(hay_len - pat_len + 1u);
      for (uint32_t i = 0u; i < pat_len; ++i) {
        if (fold_ascii) {
          uint8_t b = hay[pos + i];
          if (b >= 'a' && b <= 'z' && (rng.next_u32(2u) == 0u)) b = static_cast<uint8_t>(b - 32u);
          else if (b >= 'A' && b <= 'Z' && (rng.next_u32(2u) == 0u)) b = static_cast<uint8_t>(b + 32u);
          pat[i] = b;
        } else if (use_mask) {
          pat[i] = static_cast<uint8_t>(hay[pos + i] & masks[i]);
        } else {
          pat[i] = hay[pos + i];
        }
      }
    } else if (use_mask && (rng.next_u32(4u) != 0u)) {
      // Keep most non-planted masked patterns satisfiable
      for (uint32_t i = 0u; i < pat_len; ++i) pat[i] = static_cast<uint8_t>(pat[i] & masks[i]);
    }

    // Step through every match from 0..end and compare with naive oracle
    uint32_t from = (tc % 7u == 0u) ? rng.next_u32(hay_len + 5u) : 0u;
    for (uint32_t iter = 0u; iter < 64u; ++iter) {
      uint32_t got = 0x12345678u;
      const uint8_t* mptr = (flags & HEX_BYTE_SEARCH_FLAG_HAS_MASK) ? masks.data() : nullptr;
      const HexStatus st = hex_byte_search_find(
          hay.empty() ? nullptr : hay.data(),
          hay_len,
          from,
          pat.data(),
          mptr,
          pat_len,
          flags,
          &got);
      assert(st == HEX_OK);
      const uint32_t expected = naive_find(
          hay.empty() ? nullptr : hay.data(),
          hay_len,
          from,
          pat.data(),
          mptr,
          pat_len,
          flags);
      if (got != expected) {
        std::fprintf(
            stderr,
            "FUZZ MISMATCH tc=%u flags=%u hay_len=%u pat_len=%u from=%u got=%u expected=%u\n",
            tc, flags, hay_len, pat_len, from, got, expected);
        assert(got == expected);
      }
      total_steps += 1u;
      if (got == HEX_BYTE_SEARCH_NOT_FOUND) break;
      from = got + 1u;
    }
  }
  std::printf("test_random_fuzz: %u cases (%llu comparisons) PASS\n",
              kNumCases, static_cast<unsigned long long>(total_steps));
}

}  // namespace

int main() {
  test_invalid_args();
  test_boundaries_and_overlaps();
  test_wildcards_and_all_zero_mask();
  test_ascii_fold_and_utf8();
  test_large_buffer_and_max_pattern();
  test_random_fuzz();
  std::printf("test_byte_search_native: ALL PASS\n");
  return 0;
}
