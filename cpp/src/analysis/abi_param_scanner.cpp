#include <stddef.h>
#include <stdint.h>

#include "hex_abi.hpp"
#include "arm64_insn_bits.hpp"

namespace {

inline void write_u32_le(uint8_t* p, uint32_t off, uint32_t v) {
  p[off] = static_cast<uint8_t>(v & 0xFFu);
  p[off + 1u] = static_cast<uint8_t>((v >> 8) & 0xFFu);
  p[off + 2u] = static_cast<uint8_t>((v >> 16) & 0xFFu);
  p[off + 3u] = static_cast<uint8_t>((v >> 24) & 0xFFu);
}

inline uint8_t popcount_u32(uint32_t v) {
  uint8_t c = 0u;
  while (v != 0u) {
    v &= (v - 1u);
    ++c;
  }
  return c;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_infer_arm64_abi")
uint32_t hex_infer_arm64_abi(const uint8_t* code_ptr, uint32_t code_len, uint8_t* out_ptr) {
  if (code_ptr == nullptr || out_ptr == nullptr || code_len < 4u) {
    return 0u;
  }

  constexpr uint32_t kMaxPassAInsns = 128u;
  constexpr uint32_t kMaxFuncInsns = 4096u;
  constexpr uint32_t kMaxRetLookback = 8u;

  uint32_t total_insns = code_len >> 2;
  if (total_insns > kMaxFuncInsns) {
    total_insns = kMaxFuncInsns;
  }

  // Pass A: entry basic block argument & prologue inference (up to 128 instructions)
  const uint32_t pass_a_limit = total_insns < kMaxPassAInsns ? total_insns : kMaxPassAInsns;
  uint32_t gp_arg_mask = 0u;
  uint32_t fp_arg_mask = 0u;
  uint32_t gp_ptr_mask = 0u;
  uint32_t written_gp = 0u;
  uint32_t written_fp = 0u;
  uint32_t stack_frame_bytes = 0u;
  uint8_t has_frame = 0u;
  uint8_t has_x8_sret = 0u;

  for (uint32_t i = 0u; i < pass_a_limit; ++i) {
    const uint32_t w = hex::arm64::read_u32_le(code_ptr, i * 4u);
    if (hex::arm64::is_stp_fp_lr(w)) {
      has_frame = 1u;
    }
    uint32_t sub_bytes = 0u;
    if (hex::arm64::is_sub_sp_imm(w, sub_bytes)) {
      stack_frame_bytes += sub_bytes;
    }

    const hex::arm64::RegUsage ru = hex::arm64::decode_reg_usage(w);
    const uint32_t live_gp_read = ru.gp_read & ~written_gp;
    const uint32_t live_fp_read = ru.fp_read & ~written_fp;
    const uint32_t live_gp_base = ru.gp_base_read & ~written_gp;

    gp_arg_mask |= live_gp_read & 0xFFu;
    fp_arg_mask |= live_fp_read & 0xFFu;
    gp_ptr_mask |= live_gp_base & 0xFFu;
    if ((live_gp_base & (1u << 8)) != 0u) {
      has_x8_sret = 1u;
    }

    written_gp |= ru.gp_write;
    written_fp |= ru.fp_write;

    if (ru.is_call || ru.is_ret || ru.is_branch) {
      break;
    }
  }

  // Pass B: return type inference across all ret sites (up to 4096 instructions)
  uint8_t ret_kind = 0u;
  for (uint32_t i = 0u; i < total_insns; ++i) {
    const uint32_t w = hex::arm64::read_u32_le(code_ptr, i * 4u);
    if (!hex::arm64::is_ret(w)) {
      continue;
    }
    uint8_t path_ret_kind = 0u;
    for (uint32_t step = 0u; step < kMaxRetLookback && i > step; ++step) {
      const uint32_t j = i - 1u - step;
      const uint32_t pw = hex::arm64::read_u32_le(code_ptr, j * 4u);
      const hex::arm64::RegUsage pru = hex::arm64::decode_reg_usage(pw);
      if (pru.is_call || pru.is_ret || pru.is_branch) {
        break;
      }
      if (pru.ret_write_kind != 0u) {
        path_ret_kind = pru.ret_write_kind;
        break;
      }
    }
    // Priority: 4=f64 > 3=f32 > 2=i64 > 1=i32 > 0=void
    if (path_ret_kind > ret_kind) {
      ret_kind = path_ret_kind;
    }
  }

  const uint8_t has_this = ((gp_ptr_mask & 1u) != 0u) ? 1u : 0u;
  const uint8_t flags = static_cast<uint8_t>(
      (has_frame ? 1u : 0u) |
      (has_this ? 2u : 0u) |
      (has_x8_sret ? 4u : 0u));
  const uint8_t gp_arg_count = popcount_u32(gp_arg_mask);
  const uint8_t fp_arg_count = popcount_u32(fp_arg_mask);

  write_u32_le(out_ptr, 0u, gp_arg_mask);
  write_u32_le(out_ptr, 4u, fp_arg_mask);
  write_u32_le(out_ptr, 8u, gp_ptr_mask);
  out_ptr[12] = ret_kind;
  out_ptr[13] = flags;
  out_ptr[14] = gp_arg_count;
  out_ptr[15] = fp_arg_count;
  write_u32_le(out_ptr, 16u, stack_frame_bytes);
  write_u32_le(out_ptr, 20u, total_insns);

  return 1u;
}

}  // extern "C"
