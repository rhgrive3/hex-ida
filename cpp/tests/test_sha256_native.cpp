#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../src/core/sha256.hpp"

namespace {

static std::string to_hex(const uint8_t digest[32]) {
  static const char kHex[] = "0123456789abcdef";
  std::string out(64, '0');
  for (size_t i = 0; i < 32; ++i) {
    out[i * 2] = kHex[(digest[i] >> 4) & 0xf];
    out[i * 2 + 1] = kHex[digest[i] & 0xf];
  }
  return out;
}

static std::string hash_bytes_hex(const uint8_t* data, uint32_t len) {
  uint8_t digest[32];
  std::memset(digest, 0, sizeof(digest));
  const HexStatus st = hex_sha256_hash(data, len, digest);
  assert(st == HEX_OK);
  return to_hex(digest);
}

static void test_nist_vectors() {
  // 1. Empty string
  assert(hash_bytes_hex(nullptr, 0u) ==
         "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  // 2. "abc"
  const char* abc = "abc";
  assert(hash_bytes_hex(reinterpret_cast<const uint8_t*>(abc), 3u) ==
         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  // 3. 448-bit / 56-byte NIST vector
  const char* vec56 = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  assert(std::strlen(vec56) == 56u);
  assert(hash_bytes_hex(reinterpret_cast<const uint8_t*>(vec56), 56u) ==
         "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");

  // 4. 1,000,000 'a' characters (NIST FIPS 180-4)
  std::vector<uint8_t> million_a(1000000u, static_cast<uint8_t>('a'));
  assert(hash_bytes_hex(million_a.data(), static_cast<uint32_t>(million_a.size())) ==
         "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

static void test_block_boundaries_and_incremental_compress() {
  // Verify exact block boundary lengths: 55, 56, 63, 64, 65, 128 bytes
  const uint32_t lengths[6] = {55u, 56u, 63u, 64u, 65u, 128u};
  for (uint32_t len : lengths) {
    std::vector<uint8_t> msg(len);
    for (uint32_t i = 0u; i < len; ++i) {
      msg[i] = static_cast<uint8_t>((i * 37u + 13u) & 0xffu);
    }

    uint8_t oneshot[32];
    assert(hex_sha256_hash(msg.data(), len, oneshot) == HEX_OK);

    // Manually pad and feed via hex_sha256_compress_blocks in 1-block chunks
    std::vector<uint8_t> padded = msg;
    padded.push_back(0x80u);
    while ((padded.size() % 64u) != 56u) {
      padded.push_back(0x00u);
    }
    const uint64_t bit_len = static_cast<uint64_t>(len) * 8ULL;
    for (int shift = 56; shift >= 0; shift -= 8) {
      padded.push_back(static_cast<uint8_t>((bit_len >> shift) & 0xffu));
    }
    assert((padded.size() % 64u) == 0u);

    uint32_t state[8] = {
        0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
        0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
    };
    const uint32_t total_blocks = static_cast<uint32_t>(padded.size() / 64u);
    for (uint32_t b = 0u; b < total_blocks; ++b) {
      assert(hex_sha256_compress_blocks(state, padded.data() + b * 64u, 1u) == HEX_OK);
    }

    uint8_t streamed[32];
    for (uint32_t i = 0u; i < 8u; ++i) {
      streamed[i * 4u + 0u] = static_cast<uint8_t>((state[i] >> 24u) & 0xffu);
      streamed[i * 4u + 1u] = static_cast<uint8_t>((state[i] >> 16u) & 0xffu);
      streamed[i * 4u + 2u] = static_cast<uint8_t>((state[i] >> 8u) & 0xffu);
      streamed[i * 4u + 3u] = static_cast<uint8_t>(state[i] & 0xffu);
    }
    assert(std::memcmp(oneshot, streamed, 32u) == 0);
  }
}

static void test_invalid_arg_guards() {
  uint32_t state[8] = {0};
  uint8_t block[64] = {0};
  uint8_t out[32] = {0};

  // compress_blocks guards
  assert(hex_sha256_compress_blocks(nullptr, block, 1u) == HEX_ERR_INVALID_ARG);
  assert(hex_sha256_compress_blocks(state, nullptr, 1u) == HEX_ERR_INVALID_ARG);
  assert(hex_sha256_compress_blocks(state, nullptr, 0u) == HEX_OK);

  // hash guards
  assert(hex_sha256_hash(block, 64u, nullptr) == HEX_ERR_INVALID_ARG);
  assert(hex_sha256_hash(nullptr, 1u, out) == HEX_ERR_INVALID_ARG);
  assert(hex_sha256_hash(nullptr, 0u, out) == HEX_OK);
}

}  // namespace

int main() {
  test_nist_vectors();
  test_block_boundaries_and_incremental_compress();
  test_invalid_arg_guards();
  std::printf("test_sha256_native (ASan+UBSan, NIST FIPS 180-4 + boundaries + guards): ALL PASS\n");
  return 0;
}
