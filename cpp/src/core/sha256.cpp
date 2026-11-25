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

static void compress_one_block(uint32_t state[8], const uint8_t block[64]) {
  uint32_t w[64];
  for (uint32_t i = 0u; i < 16u; ++i) {
    w[i] = load_be32(block + i * 4u);
  }
  for (uint32_t i = 16u; i < 64u; ++i) {
    const uint32_t s0 = rotr32(w[i - 15u], 7u) ^ rotr32(w[i - 15u], 18u) ^ (w[i - 15u] >> 3u);
    const uint32_t s1 = rotr32(w[i - 2u], 17u) ^ rotr32(w[i - 2u], 19u) ^ (w[i - 2u] >> 10u);
    w[i] = w[i - 16u] + s0 + w[i - 7u] + s1;
  }

  uint32_t a = state[0];
  uint32_t b = state[1];
  uint32_t c = state[2];
  uint32_t d = state[3];
  uint32_t e = state[4];
  uint32_t f = state[5];
  uint32_t g = state[6];
  uint32_t h = state[7];

  for (uint32_t i = 0u; i < 64u; ++i) {
    const uint32_t s1 = rotr32(e, 6u) ^ rotr32(e, 11u) ^ rotr32(e, 25u);
    const uint32_t ch = (e & f) ^ ((~e) & g);
    const uint32_t temp1 = h + s1 + ch + kSha256K[i] + w[i];
    const uint32_t s0 = rotr32(a, 2u) ^ rotr32(a, 13u) ^ rotr32(a, 22u);
    const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temp2 = s0 + maj;

    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

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
