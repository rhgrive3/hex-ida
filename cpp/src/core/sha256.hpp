#ifndef HEX_CORE_SHA256_HPP
#define HEX_CORE_SHA256_HPP

#include <stddef.h>
#include <stdint.h>

#include "../../include/hex_abi.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// Compress `block_count` 64-byte SHA-256 message blocks into `state[0..7]` in-place
// per FIPS 180-4. Returns HEX_ERR_INVALID_ARG if state is null or (block_count > 0 && !blocks).
HEX_WASM_EXPORT("hex_sha256_compress_blocks")
HexStatus hex_sha256_compress_blocks(
    uint32_t* state,
    const uint8_t* blocks,
    uint32_t block_count);

// Compute the full FIPS 180-4 SHA-256 digest of `data[0..len-1]` into `out_digest32[0..31]`
// (big-endian). Returns HEX_ERR_INVALID_ARG if out_digest32 is null or (len > 0 && !data).
HEX_WASM_EXPORT("hex_sha256_hash")
HexStatus hex_sha256_hash(
    const uint8_t* data,
    uint32_t len,
    uint8_t* out_digest32);

#ifdef __cplusplus
}
#endif

#endif  // HEX_CORE_SHA256_HPP
