#include <stddef.h>
#include <stdint.h>
#include "../../include/hex_abi.hpp"

namespace {

// Freestanding log2(x) for x > 0 with < 1e-6 error (0 libc/libm imports).
inline double fast_log2(double x) {
  union {
    double d;
    uint64_t u;
  } v;
  v.d = x;
  int32_t exp = static_cast<int32_t>((v.u >> 52) & 0x7FFu) - 1023;
  v.u = (v.u & 0x000FFFFFFFFFFFFFull) | 0x3FF0000000000000ull;  // m in [1, 2)
  // Transform m to y = (m - 1) / (m + 1) in [0, 1/3) so ln(m) = 2*(y + y^3/3 + y^5/5 + y^7/7)
  double m = v.d;
  double y = (m - 1.0) / (m + 1.0);
  double y2 = y * y;
  double ln_m = 2.0 * y * (1.0 + y2 * (1.0 / 3.0 + y2 * (1.0 / 5.0 + y2 * (1.0 / 7.0 + y2 * (1.0 / 9.0)))));
  constexpr double INV_LN2 = 1.44269504088896340736;
  return static_cast<double>(exp) + ln_m * INV_LN2;
}

inline uint32_t entropy_from_hist_x1000(const uint32_t hist[256], uint32_t len) {
  if (len == 0) return 0u;
  const double inv_len = 1.0 / static_cast<double>(len);
  double h = 0.0;
  for (uint32_t i = 0; i < 256u; ++i) {
    uint32_t c = hist[i];
    if (c == 0u) continue;
    double p = static_cast<double>(c) * inv_len;
    h -= p * fast_log2(p);
  }
  if (h < 0.0) h = 0.0;
  if (h > 8.0) h = 8.0;
  return static_cast<uint32_t>(h * 1000.0 + 0.5);
}

inline bool mem_eq(const uint8_t* a, const uint8_t* b, uint32_t n) {
  for (uint32_t i = 0; i < n; ++i) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

// Standard public cryptographic constant signatures (FindCrypt-style).
// 1: AES S-Box (first 16 bytes)
static const uint8_t SIG_AES_SBOX[16] = {
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5,
  0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76
};
// 2: AES Inverse S-Box (first 16 bytes)
static const uint8_t SIG_AES_INV_SBOX[16] = {
  0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38,
  0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb
};
// 3: SHA-256 K[0..3] little-endian & big-endian
static const uint8_t SIG_SHA256_K_LE[16] = {
  0x98, 0x2f, 0x8a, 0x42, 0x91, 0x44, 0x37, 0x71,
  0xcf, 0xfb, 0xc0, 0xb5, 0xa5, 0xdb, 0xb5, 0xe9
};
static const uint8_t SIG_SHA256_K_BE[16] = {
  0x42, 0x8a, 0x2f, 0x98, 0x71, 0x37, 0x44, 0x91,
  0xb5, 0xc0, 0xfb, 0xcf, 0xe9, 0xb5, 0xdb, 0xa5
};
// 4: SHA-256 H0[0..3] little-endian & big-endian
static const uint8_t SIG_SHA256_H0_LE[16] = {
  0x67, 0xe6, 0x09, 0x6a, 0x85, 0xae, 0x67, 0xbb,
  0x72, 0xf3, 0x6e, 0x3c, 0x3a, 0xf5, 0x4f, 0xa5
};
static const uint8_t SIG_SHA256_H0_BE[16] = {
  0x6a, 0x09, 0xe6, 0x67, 0xbb, 0x67, 0xae, 0x85,
  0x3c, 0x6e, 0xf3, 0x72, 0xa5, 0x4f, 0xf5, 0x3a
};
// 5: MD5 T[0..3] little-endian
static const uint8_t SIG_MD5_T_LE[16] = {
  0x78, 0xa4, 0x6a, 0xd7, 0x56, 0xb7, 0xc7, 0xe8,
  0xdb, 0x70, 0x20, 0x24, 0xee, 0xce, 0xbd, 0xc1
};
// 6: ChaCha20 / Salsa20 "expand 32-byte k" / "expand 16-byte k"
static const uint8_t SIG_CHACHA_32[16] = {
  'e', 'x', 'p', 'a', 'n', 'd', ' ', '3', '2', '-', 'b', 'y', 't', 'e', ' ', 'k'
};
static const uint8_t SIG_CHACHA_16[16] = {
  'e', 'x', 'p', 'a', 'n', 'd', ' ', '1', '6', '-', 'b', 'y', 't', 'e', ' ', 'k'
};
// 7: CRC32 IEEE table entries [0..3] little-endian
static const uint8_t SIG_CRC32_IEEE_LE[16] = {
  0x00, 0x00, 0x00, 0x00, 0x96, 0x30, 0x07, 0x77,
  0x2c, 0x61, 0x0e, 0xee, 0xba, 0x51, 0x09, 0x99
};

struct CryptoSig {
  uint32_t algo_id;
  uint32_t report_len;
  const uint8_t* bytes;
};

static const CryptoSig CRYPTO_SIGS[] = {
  { 1u, 256u, SIG_AES_SBOX },
  { 2u, 256u, SIG_AES_INV_SBOX },
  { 3u, 256u, SIG_SHA256_K_LE },
  { 3u, 256u, SIG_SHA256_K_BE },
  { 4u, 32u,  SIG_SHA256_H0_LE },
  { 4u, 32u,  SIG_SHA256_H0_BE },
  { 5u, 256u, SIG_MD5_T_LE },
  { 6u, 16u,  SIG_CHACHA_32 },
  { 6u, 16u,  SIG_CHACHA_16 },
  { 7u, 1024u, SIG_CRC32_IEEE_LE },
};

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_shannon_entropy_x1000")
uint32_t hex_shannon_entropy_x1000(const uint8_t* data, uint32_t len) {
  if (!data || len == 0u) return 0u;
  uint32_t hist[256];
  for (uint32_t i = 0; i < 256u; ++i) hist[i] = 0u;
  for (uint32_t i = 0; i < len; ++i) hist[data[i]]++;
  return entropy_from_hist_x1000(hist, len);
}

HEX_WASM_EXPORT("hex_scan_high_entropy_windows")
uint32_t hex_scan_high_entropy_windows(
    const uint8_t* data,
    uint32_t len,
    uint32_t window_size,
    uint32_t step,
    uint32_t threshold_x1000,
    uint32_t* out_pairs,
    uint32_t max_hits) {
  if (!data || !out_pairs || max_hits == 0u || window_size == 0u || len < window_size) return 0u;
  if (step == 0u) step = window_size;

  uint32_t hist[256];
  for (uint32_t i = 0; i < 256u; ++i) hist[i] = 0u;
  for (uint32_t i = 0; i < window_size; ++i) hist[data[i]]++;

  uint32_t hits = 0u;
  uint32_t pos = 0u;
  while (pos + window_size <= len && hits < max_hits) {
    uint32_t ent = entropy_from_hist_x1000(hist, window_size);
    if (ent >= threshold_x1000) {
      out_pairs[hits * 2u] = pos;
      out_pairs[hits * 2u + 1u] = ent;
      hits++;
    }
    uint32_t next_pos = pos + step;
    if (next_pos + window_size > len) break;
    if (step < window_size) {
      for (uint32_t i = 0; i < step; ++i) {
        hist[data[pos + i]]--;
        hist[data[pos + window_size + i]]++;
      }
    } else {
      for (uint32_t i = 0; i < 256u; ++i) hist[i] = 0u;
      for (uint32_t i = 0; i < window_size; ++i) hist[data[next_pos + i]]++;
    }
    pos = next_pos;
  }
  return hits;
}

HEX_WASM_EXPORT("hex_crypto_scan_buffer")
uint32_t hex_crypto_scan_buffer(
    const uint8_t* data,
    uint32_t len,
    uint32_t* out_triples,
    uint32_t max_hits) {
  if (!data || !out_triples || max_hits == 0u || len < 16u) return 0u;
  // Fast 256-bit first-byte bloom filter so non-matching bytes skip in 1 check.
  uint32_t first_mask[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  constexpr uint32_t NUM_SIGS = static_cast<uint32_t>(sizeof(CRYPTO_SIGS) / sizeof(CRYPTO_SIGS[0]));
  for (uint32_t s = 0; s < NUM_SIGS; ++s) {
    uint8_t b0 = CRYPTO_SIGS[s].bytes[0];
    first_mask[b0 >> 5] |= (1u << (b0 & 31u));
  }

  uint32_t hits = 0u;
  uint32_t limit = len - 16u;
  for (uint32_t i = 0; i <= limit && hits < max_hits; ++i) {
    uint8_t b0 = data[i];
    if ((first_mask[b0 >> 5] & (1u << (b0 & 31u))) == 0u) continue;
    for (uint32_t s = 0; s < NUM_SIGS && hits < max_hits; ++s) {
      const CryptoSig& sig = CRYPTO_SIGS[s];
      if (b0 == sig.bytes[0] && data[i + 1u] == sig.bytes[1] && mem_eq(data + i, sig.bytes, 16u)) {
        out_triples[hits * 3u] = i;
        out_triples[hits * 3u + 1u] = sig.algo_id;
        out_triples[hits * 3u + 2u] = sig.report_len;
        hits++;
        break;
      }
    }
  }
  return hits;
}

}  // extern "C"
