#include "hex_abi.hpp"
#include "arm64_insn_bits.hpp"

namespace {

constexpr uint64_t kFnv64OffsetBasis = 0xcbf29ce484222325ULL;
constexpr uint64_t kFnv64Prime = 0x100000001b3ULL;

inline uint64_t fnv1a_u16_le(uint16_t f) {
  uint64_t h = kFnv64OffsetBasis;
  h ^= static_cast<uint64_t>(f & 0xFFu);
  h *= kFnv64Prime;
  h ^= static_cast<uint64_t>((f >> 8) & 0xFFu);
  h *= kFnv64Prime;
  return h;
}

inline void simhash_accum(int32_t v[64], uint64_t h) {
  for (uint32_t b = 0u; b < 64u; ++b) {
    v[b] += ((h >> b) & 1ULL) ? 1 : -1;
  }
}

inline void write_u32_le(uint8_t* p, uint32_t off, uint32_t val) {
  p[off] = static_cast<uint8_t>(val & 0xFFu);
  p[off + 1u] = static_cast<uint8_t>((val >> 8) & 0xFFu);
  p[off + 2u] = static_cast<uint8_t>((val >> 16) & 0xFFu);
  p[off + 3u] = static_cast<uint8_t>((val >> 24) & 0xFFu);
}

inline uint32_t popcount32(uint32_t x) {
  return static_cast<uint32_t>(__builtin_popcount(x));
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_fingerprint_arm64_func")
uint32_t hex_fingerprint_arm64_func(const uint8_t* code_ptr, uint32_t code_len, uint8_t* out_ptr) {
  if (code_ptr == nullptr || out_ptr == nullptr || code_len < 4u) {
    return 0u;
  }

  const uint32_t insn_count = code_len >> 2;
  uint32_t class_counts[12] = {};
  uint32_t bigram_bits[5] = {};  // 160 bits >= 144 (12 * 12)
  uint32_t unique_bigrams = 0u;
  int32_t v[64] = {};

  uint32_t prev_c = 0u;
  for (uint32_t i = 0u; i < insn_count; ++i) {
    const uint32_t w = hex::arm64::read_u32_le(code_ptr, i << 2);
    const uint32_t c = static_cast<uint32_t>(hex::arm64::classify_insn(w));
    if (c < 12u) {
      class_counts[c]++;
    }

    const uint16_t f1 = static_cast<uint16_t>(0x0100u | (c & 0xFu));
    simhash_accum(v, fnv1a_u16_le(f1));

    if (i > 0u) {
      const uint16_t f2 = static_cast<uint16_t>(0x0200u | ((prev_c & 0xFu) << 4) | (c & 0xFu));
      simhash_accum(v, fnv1a_u16_le(f2));

      if (prev_c < 12u && c < 12u) {
        const uint32_t bg_idx = prev_c * 12u + c;
        const uint32_t word_idx = bg_idx >> 5;
        const uint32_t bit_mask = 1u << (bg_idx & 31u);
        if ((bigram_bits[word_idx] & bit_mask) == 0u) {
          bigram_bits[word_idx] |= bit_mask;
          unique_bigrams++;
        }
      }
    }
    prev_c = c;
  }

  uint64_t simhash = 0ULL;
  for (uint32_t b = 0u; b < 64u; ++b) {
    if (v[b] >= 0) {
      simhash |= (1ULL << b);
    }
  }

  const uint32_t simhash_lo = static_cast<uint32_t>(simhash & 0xFFFFFFFFULL);
  const uint32_t simhash_hi = static_cast<uint32_t>((simhash >> 32) & 0xFFFFFFFFULL);

  write_u32_le(out_ptr, 0u, simhash_lo);
  write_u32_le(out_ptr, 4u, simhash_hi);
  write_u32_le(out_ptr, 8u, insn_count);
  write_u32_le(out_ptr, 12u, unique_bigrams);
  for (uint32_t i = 0u; i < 12u; ++i) {
    write_u32_le(out_ptr, 16u + (i << 2), class_counts[i]);
  }

  return 1u;
}

HEX_WASM_EXPORT("hex_simhash_hamming64")
uint32_t hex_simhash_hamming64(uint32_t a_lo, uint32_t a_hi, uint32_t b_lo, uint32_t b_hi) {
  return popcount32(a_lo ^ b_lo) + popcount32(a_hi ^ b_hi);
}

HEX_WASM_EXPORT("hex_match_fingerprints")
uint32_t hex_match_fingerprints(uint32_t q_lo,
                                uint32_t q_hi,
                                const uint8_t* db_ptr,
                                uint32_t db_count,
                                uint32_t max_hamming,
                                uint8_t* out_ptr,
                                uint32_t max_out) {
  if (db_ptr == nullptr || out_ptr == nullptr || db_count == 0u || max_out == 0u) {
    return 0u;
  }
  if (max_hamming > 64u) {
    max_hamming = 64u;
  }

  uint32_t bucket_counts[65] = {};
  const uint8_t* p = db_ptr;
  for (uint32_t i = 0u; i < db_count; ++i, p += 8u) {
    const uint32_t d_lo = hex::arm64::read_u32_le(p, 0u);
    const uint32_t d_hi = hex::arm64::read_u32_le(p, 4u);
    const uint32_t dist = popcount32(q_lo ^ d_lo) + popcount32(q_hi ^ d_hi);
    if (dist <= max_hamming) {
      bucket_counts[dist]++;
    }
  }

  uint32_t bucket_pos[65];
  uint32_t bucket_end[65];
  uint32_t total = 0u;
  for (uint32_t d = 0u; d <= max_hamming; ++d) {
    bucket_pos[d] = total;
    const uint32_t avail = (total < max_out) ? (max_out - total) : 0u;
    const uint32_t take = (bucket_counts[d] < avail) ? bucket_counts[d] : avail;
    total += take;
    bucket_end[d] = total;
  }

  if (total == 0u) {
    return 0u;
  }

  p = db_ptr;
  for (uint32_t i = 0u; i < db_count; ++i, p += 8u) {
    const uint32_t d_lo = hex::arm64::read_u32_le(p, 0u);
    const uint32_t d_hi = hex::arm64::read_u32_le(p, 4u);
    const uint32_t dist = popcount32(q_lo ^ d_lo) + popcount32(q_hi ^ d_hi);
    if (dist <= max_hamming && bucket_pos[dist] < bucket_end[dist]) {
      const uint32_t slot = bucket_pos[dist]++;
      write_u32_le(out_ptr, slot << 3, i);
      write_u32_le(out_ptr, (slot << 3) + 4u, dist);
    }
  }

  return total;
}

}  // extern "C"
