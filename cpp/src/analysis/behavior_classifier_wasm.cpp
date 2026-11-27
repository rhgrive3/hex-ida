#include "hex_abi.hpp"
#include "arm64_insn_bits.hpp"

namespace {

inline uint32_t sat_mul_1000(uint32_t count, uint32_t weight) {
  if (count == 0u || weight == 0u) return 0u;
  const uint32_t limit = 1000u / weight;
  if (count > limit) return 1000u;
  const uint32_t prod = count * weight;
  return prod > 1000u ? 1000u : prod;
}

inline uint32_t sat_add_1000(uint32_t a, uint32_t b) {
  const uint32_t sum = a + b;
  return sum > 1000u ? 1000u : sum;
}

inline void write_u32_le(uint8_t* p, uint32_t off, uint32_t v) {
  p[off] = static_cast<uint8_t>(v & 0xFFu);
  p[off + 1u] = static_cast<uint8_t>((v >> 8) & 0xFFu);
  p[off + 2u] = static_cast<uint8_t>((v >> 16) & 0xFFu);
  p[off + 3u] = static_cast<uint8_t>((v >> 24) & 0xFFu);
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_classify_arm64_behavior")
uint32_t hex_classify_arm64_behavior(const uint8_t* code_ptr, uint32_t code_len, uint8_t* out_ptr) {
  if (code_ptr == nullptr || out_ptr == nullptr || code_len < 4u) {
    return 0u;
  }

  hex::arm64::RmwSummary rmw{0u, 0u, 0u, 0u};
  hex::arm64::scan_arm64_rmw_core(code_ptr, code_len, nullptr, 0u, &rmw);

  const uint32_t insn_count = code_len >> 2;
  const uint32_t limit = insn_count << 2;

  uint32_t clamp_ops = 0u;
  uint32_t hw_crypto = 0u;
  uint32_t ret_ops = 0u;
  uint32_t load_ops = 0u;
  uint32_t store_ops = 0u;
  uint32_t muldiv_ops = 0u;
  uint32_t fp_ops = 0u;
  uint32_t bitwise_ops = 0u;
  uint32_t call_ops = 0u;

  for (uint32_t off = 0u; off < limit; off += 4u) {
    const uint32_t w = hex::arm64::read_u32_le(code_ptr, off);
    if (hex::arm64::is_clamp_or_cond(w)) clamp_ops++;
    if (hex::arm64::is_hw_crypto(w)) hw_crypto++;
    if (hex::arm64::is_ret(w)) ret_ops++;

    const hex::arm64::InsnClass cls = hex::arm64::classify_insn(w);
    if (cls == hex::arm64::InsnClass::LOAD) {
      load_ops++;
    } else if (cls == hex::arm64::InsnClass::STORE) {
      store_ops++;
    } else if (cls == hex::arm64::InsnClass::MULDIV) {
      muldiv_ops++;
    } else if (cls == hex::arm64::InsnClass::FP_SIMD) {
      fp_ops++;
    } else if (cls == hex::arm64::InsnClass::BITWISE) {
      bitwise_ops++;
    } else if (cls == hex::arm64::InsnClass::CALL_DIR ||
               cls == hex::arm64::InsnClass::CALL_IND) {
      call_ops++;
    }
  }

  const uint32_t drain_score = sat_add_1000(
      sat_add_1000(sat_mul_1000(rmw.clamped_sub, 450u),
                   sat_mul_1000(rmw.unclamped_sub, 250u)),
      sat_mul_1000(clamp_ops, 40u));

  const uint32_t accum_score = sat_add_1000(
      sat_mul_1000(rmw.add_rmw, 350u),
      sat_mul_1000(store_ops, 40u));

  const uint32_t ratio_score = sat_add_1000(
      sat_mul_1000(muldiv_ops, 220u),
      sat_mul_1000(fp_ops, 120u));

  const uint32_t crypto_score = sat_add_1000(
      sat_mul_1000(hw_crypto, 500u),
      sat_mul_1000(bitwise_ops, 80u));

  const uint32_t accessor_score =
      (insn_count <= 8u &&
       call_ops == 0u &&
       (load_ops + store_ops) >= 1u &&
       ret_ops >= 1u &&
       rmw.clamped_sub == 0u &&
       rmw.unclamped_sub == 0u &&
       rmw.add_rmw == 0u)
          ? 900u
          : 0u;

  uint32_t best_score = 0u;
  uint32_t top_category = 0u;
  const uint32_t scores[5] = {
      drain_score,
      accum_score,
      ratio_score,
      crypto_score,
      accessor_score,
  };
  for (uint32_t i = 0u; i < 5u; ++i) {
    if (scores[i] > best_score) {
      best_score = scores[i];
      top_category = i + 1u;
    }
  }
  if (best_score < 250u) {
    top_category = 0u;
  }

  const uint32_t flags =
      (rmw.clamped_sub > 0u ? 1u : 0u) |
      (hw_crypto > 0u ? 2u : 0u) |
      (muldiv_ops > 0u ? 4u : 0u) |
      (rmw.add_rmw > 0u ? 8u : 0u) |
      (accessor_score > 0u ? 16u : 0u);

  write_u32_le(out_ptr, 0u, drain_score);
  write_u32_le(out_ptr, 4u, accum_score);
  write_u32_le(out_ptr, 8u, ratio_score);
  write_u32_le(out_ptr, 12u, crypto_score);
  write_u32_le(out_ptr, 16u, accessor_score);
  write_u32_le(out_ptr, 20u, top_category);
  write_u32_le(out_ptr, 24u, insn_count);
  write_u32_le(out_ptr, 28u, flags);

  return 1u;
}

}  // extern "C"
