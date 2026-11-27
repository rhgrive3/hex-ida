#include "hex_abi.hpp"
#include "arm64_insn_bits.hpp"

#include <stddef.h>
#include <stdint.h>

namespace {

using hex::arm64::RmwHit;

static_assert(sizeof(RmwHit) == 20u, "RmwHit must be 20 bytes");
static_assert(offsetof(RmwHit, load_off) == 0u, "RmwHit::load_off offset mismatch");
static_assert(offsetof(RmwHit, store_off) == 4u, "RmwHit::store_off offset mismatch");
static_assert(offsetof(RmwHit, disp) == 8u, "RmwHit::disp offset mismatch");
static_assert(offsetof(RmwHit, base_reg) == 12u, "RmwHit::base_reg offset mismatch");
static_assert(offsetof(RmwHit, op_kind) == 13u, "RmwHit::op_kind offset mismatch");
static_assert(offsetof(RmwHit, flags) == 14u, "RmwHit::flags offset mismatch");
static_assert(offsetof(RmwHit, width) == 15u, "RmwHit::width offset mismatch");
static_assert(offsetof(RmwHit, arith_off) == 16u, "RmwHit::arith_off offset mismatch");

inline void write_u32_le(uint8_t* dst, uint32_t value) {
  dst[0] = static_cast<uint8_t>(value & 0xFFu);
  dst[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
  dst[2] = static_cast<uint8_t>((value >> 16) & 0xFFu);
  dst[3] = static_cast<uint8_t>((value >> 24) & 0xFFu);
}

inline void write_rmw_hit_le(uint8_t* dst, const RmwHit& hit) {
  write_u32_le(dst + 0u, hit.load_off);
  write_u32_le(dst + 4u, hit.store_off);
  write_u32_le(dst + 8u, static_cast<uint32_t>(hit.disp));
  dst[12] = hit.base_reg;
  dst[13] = hit.op_kind;
  dst[14] = hit.flags;
  dst[15] = hit.width;
  write_u32_le(dst + 16u, hit.arith_off);
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_scan_arm64_rmw_fields")
uint32_t hex_scan_arm64_rmw_fields(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint8_t* out_ptr,
    uint32_t max_out) {
  if (code_ptr == nullptr || out_ptr == nullptr || code_len < 4u || max_out == 0u) {
    return 0u;
  }

  RmwHit* out_hits = reinterpret_cast<RmwHit*>(out_ptr);
  const uint32_t written = hex::arm64::scan_arm64_rmw_core(
      code_ptr, code_len, out_hits, max_out, nullptr);

  for (uint32_t i = 0u; i < written; ++i) {
    const RmwHit hit = out_hits[i];
    write_rmw_hit_le(out_ptr + i * 20u, hit);
  }

  return written;
}

}  // extern "C"
