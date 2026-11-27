#include "sha256.hpp"

namespace {

static constexpr uint32_t kSha256K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static inline uint32_t rotr32(uint32_t x, uint32_t n) {
  return (x >> n) | (x << (32u - n));
}

static inline uint32_t load_be32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24u) |
         (static_cast<uint32_t>(p[1]) << 16u) |
         (static_cast<uint32_t>(p[2]) << 8u) |
         static_cast<uint32_t>(p[3]);
}

static inline void store_be32(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>((v >> 24u) & 0xffu);
  p[1] = static_cast<uint8_t>((v >> 16u) & 0xffu);
  p[2] = static_cast<uint8_t>((v >> 8u) & 0xffu);
  p[3] = static_cast<uint8_t>(v & 0xffu);
}

#define HEX_SHA256_SIGMA0(x) (rotr32((x), 2u) ^ rotr32((x), 13u) ^ rotr32((x), 22u))
#define HEX_SHA256_SIGMA1(x) (rotr32((x), 6u) ^ rotr32((x), 11u) ^ rotr32((x), 25u))
#define HEX_SHA256_GAMMA0(x) (rotr32((x), 7u) ^ rotr32((x), 18u) ^ ((x) >> 3u))
#define HEX_SHA256_GAMMA1(x) (rotr32((x), 17u) ^ rotr32((x), 19u) ^ ((x) >> 10u))
#define HEX_SHA256_CH(x, y, z) ((z) ^ ((x) & ((y) ^ (z))))
#define HEX_SHA256_MAJ(x, y, z) (((x) & (y)) | ((z) & ((x) | (y))))

#define HEX_SHA256_STEP(a, b, c, d, e, f, g, h, k, wt)                                \
  do {                                                                                \
    const uint32_t t1 = (h) + HEX_SHA256_SIGMA1(e) + HEX_SHA256_CH(e, f, g) + (k) + (wt); \
    const uint32_t t2 = HEX_SHA256_SIGMA0(a) + HEX_SHA256_MAJ(a, b, c);               \
    (d) += t1;                                                                        \
    (h) = t1 + t2;                                                                    \
  } while (0)

#define HEX_SHA256_R00_15(a, b, c, d, e, f, g, h, idx)              \
  do {                                                              \
    w[(idx)] = load_be32(block + (idx) * 4u);                       \
    HEX_SHA256_STEP(a, b, c, d, e, f, g, h, kSha256K[(idx)], w[(idx)]); \
  } while (0)

#define HEX_SHA256_W_UPDATE(idx)                                             \
  (w[(idx) & 15u] = w[(idx) & 15u] + HEX_SHA256_GAMMA0(w[((idx) + 1u) & 15u]) \
                    + w[((idx) + 9u) & 15u] + HEX_SHA256_GAMMA1(w[((idx) + 14u) & 15u]))

#define HEX_SHA256_R16_63(a, b, c, d, e, f, g, h, idx)                     \
  do {                                                                     \
    const uint32_t wt = HEX_SHA256_W_UPDATE(idx);                          \
    HEX_SHA256_STEP(a, b, c, d, e, f, g, h, kSha256K[(idx)], wt);          \
  } while (0)

#define HEX_SHA256_OCTET_16_63(base)                               \
  HEX_SHA256_R16_63(a, b, c, d, e, f, g, h, (base) + 0u);          \
  HEX_SHA256_R16_63(h, a, b, c, d, e, f, g, (base) + 1u);          \
  HEX_SHA256_R16_63(g, h, a, b, c, d, e, f, (base) + 2u);          \
  HEX_SHA256_R16_63(f, g, h, a, b, c, d, e, (base) + 3u);          \
  HEX_SHA256_R16_63(e, f, g, h, a, b, c, d, (base) + 4u);          \
  HEX_SHA256_R16_63(d, e, f, g, h, a, b, c, (base) + 5u);          \
  HEX_SHA256_R16_63(c, d, e, f, g, h, a, b, (base) + 6u);          \
  HEX_SHA256_R16_63(b, c, d, e, f, g, h, a, (base) + 7u)

static void compress_one_block(uint32_t state[8], const uint8_t block[64]) {
  // 16-word rolling window promoted to WASM local registers by LLVM SROA.
  uint32_t w[16];

  uint32_t a = state[0];
  uint32_t b = state[1];
  uint32_t c = state[2];
  uint32_t d = state[3];
  uint32_t e = state[4];
  uint32_t f = state[5];
  uint32_t g = state[6];
  uint32_t h = state[7];

  // Rounds 0..15: load big-endian message words + compress
  HEX_SHA256_R00_15(a, b, c, d, e, f, g, h, 0u);
  HEX_SHA256_R00_15(h, a, b, c, d, e, f, g, 1u);
  HEX_SHA256_R00_15(g, h, a, b, c, d, e, f, 2u);
  HEX_SHA256_R00_15(f, g, h, a, b, c, d, e, 3u);
  HEX_SHA256_R00_15(e, f, g, h, a, b, c, d, 4u);
  HEX_SHA256_R00_15(d, e, f, g, h, a, b, c, 5u);
  HEX_SHA256_R00_15(c, d, e, f, g, h, a, b, 6u);
  HEX_SHA256_R00_15(b, c, d, e, f, g, h, a, 7u);
  HEX_SHA256_R00_15(a, b, c, d, e, f, g, h, 8u);
  HEX_SHA256_R00_15(h, a, b, c, d, e, f, g, 9u);
  HEX_SHA256_R00_15(g, h, a, b, c, d, e, f, 10u);
  HEX_SHA256_R00_15(f, g, h, a, b, c, d, e, 11u);
  HEX_SHA256_R00_15(e, f, g, h, a, b, c, d, 12u);
  HEX_SHA256_R00_15(d, e, f, g, h, a, b, c, 13u);
  HEX_SHA256_R00_15(c, d, e, f, g, h, a, b, 14u);
  HEX_SHA256_R00_15(b, c, d, e, f, g, h, a, 15u);

  // Rounds 16..63: rolling 16-word schedule update + compress
  HEX_SHA256_OCTET_16_63(16u);
  HEX_SHA256_OCTET_16_63(24u);
  HEX_SHA256_OCTET_16_63(32u);
  HEX_SHA256_OCTET_16_63(40u);
  HEX_SHA256_OCTET_16_63(48u);
  HEX_SHA256_OCTET_16_63(56u);

  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

#undef HEX_SHA256_OCTET_16_63
#undef HEX_SHA256_R16_63
#undef HEX_SHA256_W_UPDATE
#undef HEX_SHA256_R00_15
#undef HEX_SHA256_STEP
#undef HEX_SHA256_MAJ
#undef HEX_SHA256_CH
#undef HEX_SHA256_GAMMA1
#undef HEX_SHA256_GAMMA0
#undef HEX_SHA256_SIGMA1
#undef HEX_SHA256_SIGMA0

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_sha256_compress_blocks")
HexStatus hex_sha256_compress_blocks(
    uint32_t* state,
    const uint8_t* blocks,
    uint32_t block_count) {
  if (!state || (block_count > 0u && !blocks)) {
    return HEX_ERR_INVALID_ARG;
  }
  if (block_count > (UINT32_MAX / 64u)) return HEX_ERR_RESOURCE_LIMIT;
  for (uint32_t i = 0u; i < block_count; ++i) {
    compress_one_block(state, blocks + static_cast<size_t>(i) * 64u);
  }
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_sha256_hash")
HexStatus hex_sha256_hash(
    const uint8_t* data,
    uint32_t len,
    uint8_t* out_digest32) {
  if (!out_digest32 || (len > 0u && !data)) {
    return HEX_ERR_INVALID_ARG;
  }

  uint32_t state[8] = {
      0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
      0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
  };

  const uint32_t full_blocks = len / 64u;
  for (uint32_t i = 0u; i < full_blocks; ++i) {
    compress_one_block(state, data + static_cast<size_t>(i) * 64u);
  }

  const uint32_t rem = len % 64u;
  uint8_t tail[64];
  for (uint32_t i = 0u; i < 64u; ++i) {
    tail[i] = 0u;
  }
  const uint8_t* rem_ptr = data + static_cast<size_t>(full_blocks) * 64u;
  for (uint32_t i = 0u; i < rem; ++i) {
    tail[i] = rem_ptr[i];
  }
  tail[rem] = 0x80u;

  if (rem >= 56u) {
    compress_one_block(state, tail);
    for (uint32_t i = 0u; i < 56u; ++i) {
      tail[i] = 0u;
    }
  }

  const uint64_t bit_len = static_cast<uint64_t>(len) * 8ULL;
  store_be32(tail + 56u, static_cast<uint32_t>(bit_len >> 32u));
  store_be32(tail + 60u, static_cast<uint32_t>(bit_len & 0xffffffffULL));
  compress_one_block(state, tail);

  for (uint32_t i = 0u; i < 8u; ++i) {
    store_be32(out_digest32 + i * 4u, state[i]);
  }
  return HEX_OK;
}

}  // extern "C"
