#ifndef HEX_DECOMPILER_PASSES_ARM64_FRAME_HELPERS_HPP
#define HEX_DECOMPILER_PASSES_ARM64_FRAME_HELPERS_HPP

#include <stddef.h>
#include <stdint.h>

#include <hex_core/hex_core.hpp>

namespace hex {
namespace decompiler {
namespace passes {
namespace frame_util {

namespace detail {

constexpr uint32_t kMaxSymbolNameLen = 256u;

constexpr int64_t sign_extend(uint32_t value, uint32_t bits) noexcept {
  const uint64_t mask = (1ULL << bits) - 1ULL;
  const uint64_t sign = 1ULL << (bits - 1u);
  const uint64_t v = static_cast<uint64_t>(value) & mask;
  return static_cast<int64_t>((v ^ sign) - sign);
}

constexpr uint64_t abs_i64_u64(int64_t v) noexcept {
  return (v < 0) ? (static_cast<uint64_t>(-(v + 1)) + 1ULL)
                 : static_cast<uint64_t>(v);
}

constexpr bool is_ascii_alpha(char c) noexcept {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

constexpr bool is_ascii_digit(char c) noexcept {
  return c >= '0' && c <= '9';
}

inline uint32_t write_prefix_and_upper_hex(
    const char* prefix, uint64_t mag, char* out, uint32_t cap) noexcept {
  if (!out || cap == 0u) return 0u;
  static constexpr char kHex[] = "0123456789ABCDEF";

  char digits[16];
  uint32_t dn = 0u;
  do {
    digits[dn++] = kHex[mag & 0xFULL];
    mag >>= 4u;
  } while (mag != 0ULL && dn < 16u);

  uint32_t plen = 0u;
  while (prefix[plen] != '\0') ++plen;

  if (plen + dn + 1u > cap) {
    out[0] = '\0';
    return 0u;
  }

  uint32_t pos = 0u;
  for (uint32_t i = 0u; i < plen; ++i) out[pos++] = prefix[i];
  while (dn > 0u) out[pos++] = digits[--dn];
  out[pos] = '\0';
  return pos;
}

}  // namespace detail

// Decode `stp x29, x30, [sp, #-N]!` (64-bit pre-indexed, N >= 16, 16-byte aligned).
inline bool decode_stp_fp_lr_pre(uint32_t w, uint32_t* out_frame_bytes) noexcept {
  if ((w & 0xFFC00000u) != 0xA9800000u) return false;
  const uint32_t rt = w & 31u;
  const uint32_t rn = (w >> 5u) & 31u;
  const uint32_t rt2 = (w >> 10u) & 31u;
  if (rt != 29u || rt2 != 30u || rn != 31u) return false;
  const int64_t imm7 = detail::sign_extend((w >> 15u) & 0x7Fu, 7u);
  if (imm7 >= 0) return false;
  const uint64_t bytes = static_cast<uint64_t>(-imm7) * 8ULL;
  if (bytes < 16ULL || (bytes & 15ULL) != 0ULL || bytes > 512ULL) return false;
  if (out_frame_bytes) *out_frame_bytes = static_cast<uint32_t>(bytes);
  return true;
}

// Decode `ldp x29, x30, [sp], #N` (64-bit post-indexed, N >= 16, 16-byte aligned).
inline bool decode_ldp_fp_lr_post(uint32_t w, uint32_t* out_frame_bytes) noexcept {
  if ((w & 0xFFC00000u) != 0xA8C00000u) return false;
  const uint32_t rt = w & 31u;
  const uint32_t rn = (w >> 5u) & 31u;
  const uint32_t rt2 = (w >> 10u) & 31u;
  if (rt != 29u || rt2 != 30u || rn != 31u) return false;
  const int64_t imm7 = detail::sign_extend((w >> 15u) & 0x7Fu, 7u);
  if (imm7 <= 0) return false;
  const uint64_t bytes = static_cast<uint64_t>(imm7) * 8ULL;
  if (bytes < 16ULL || (bytes & 15ULL) != 0ULL || bytes > 512ULL) return false;
  if (out_frame_bytes) *out_frame_bytes = static_cast<uint32_t>(bytes);
  return true;
}

// Decode direct branch-with-link `bl #imm26` (strictly rejects unconditional `b`).
inline bool decode_bl_target(uint32_t w, uint64_t pc, uint64_t* out_target) noexcept {
  if ((w & 0xFC000000u) != 0x94000000u) return false;
  const int64_t delta = detail::sign_extend(w & 0x03FFFFFFu, 26u) * 4LL;
  if (out_target) *out_target = pc + static_cast<uint64_t>(delta);
  return true;
}

// Decode `adrp xd, #page` (strictly rejects `adr` and xzr/sp destination).
inline bool decode_adrp_target(
    uint32_t w, uint64_t pc, uint8_t* out_rd, uint64_t* out_page) noexcept {
  if ((w & 0x9F000000u) != 0x90000000u) return false;
  const uint8_t rd = static_cast<uint8_t>(w & 31u);
  if (rd >= 31u) return false;
  const uint32_t raw_imm = (((w >> 5u) & 0x7FFFFu) << 2u) | ((w >> 29u) & 3u);
  const int64_t imm = detail::sign_extend(raw_imm, 21u);
  if (out_rd) *out_rd = rd;
  if (out_page) *out_page = (pc & ~0xFFFULL) + (static_cast<uint64_t>(imm) << 12u);
  return true;
}

// Decode canonical indirect call `blr xn` (strictly rejects PAC blraa/blrab/blraaz/blrabz, br, ret, xzr).
inline bool decode_blr_reg(uint32_t w, uint8_t* out_rn) noexcept {
  if ((w & 0xFFFFFC1Fu) != 0xD63F0000u) return false;
  const uint8_t rn = static_cast<uint8_t>((w >> 5u) & 31u);
  if (rn >= 31u) return false;
  if (out_rn) *out_rn = rn;
  return true;
}

// Validate a C identifier symbol name (rejects ObjC selectors, newlines, NULs, leading digits, non-ident chars).
inline bool is_valid_c_symbol_name(const char* s, uint32_t len) noexcept {
  if (!s || len == 0u || len > detail::kMaxSymbolNameLen) return false;
  const char c0 = s[0];
  if (!detail::is_ascii_alpha(c0) && c0 != '_') return false;
  for (uint32_t i = 1u; i < len; ++i) {
    const char c = s[i];
    if (!detail::is_ascii_alpha(c) && !detail::is_ascii_digit(c) && c != '_') {
      return false;
    }
  }
  return true;
}

// Format signed stack coordinate matching JS oracle (`local_0`, `local_m<HEX>`, `local_p<HEX>`).
// Returns bytes written (excluding NUL), or 0 on invalid arguments / insufficient capacity.
inline uint32_t format_signed_stack_slot(int64_t signed_off, char* out, uint32_t cap) noexcept {
  if (!out || cap == 0u) return 0u;
  if (signed_off == 0) {
    static constexpr char kZero[] = "local_0";
    if (8u > cap) {
      out[0] = '\0';
      return 0u;
    }
    for (uint32_t i = 0u; i < 8u; ++i) out[i] = kZero[i];
    return 7u;
  }
  const uint64_t mag = detail::abs_i64_u64(signed_off);
  return detail::write_prefix_and_upper_hex(signed_off < 0 ? "local_m" : "local_p", mag, out, cap);
}

// Format signed stack variable name matching JS semantic-core (`var_<HEX>`, `var_m<HEX>`).
inline uint32_t format_var_stack_slot(int64_t signed_off, char* out, uint32_t cap) noexcept {
  if (!out || cap == 0u) return 0u;
  const uint64_t mag = detail::abs_i64_u64(signed_off);
  return detail::write_prefix_and_upper_hex(signed_off < 0 ? "var_m" : "var_", mag, out, cap);
}

// RAII rollback guard for hex::Arena: restores arena cursor on scope exit unless commit() is called.
class ArenaRollbackGuard {
 public:
  explicit ArenaRollbackGuard(hex::Arena& arena) noexcept
      : arena_(arena), mark_(arena.used()), active_(true) {}

  ~ArenaRollbackGuard() noexcept { rollback(); }

  ArenaRollbackGuard(const ArenaRollbackGuard&) = delete;
  ArenaRollbackGuard& operator=(const ArenaRollbackGuard&) = delete;
  ArenaRollbackGuard(ArenaRollbackGuard&&) = delete;
  ArenaRollbackGuard& operator=(ArenaRollbackGuard&&) = delete;

  void commit() noexcept { active_ = false; }
  void dismiss() noexcept { active_ = false; }

  void rollback() noexcept {
    if (active_) {
      arena_.restore(mark_);
      active_ = false;
    }
  }

  size_t mark() const noexcept { return mark_; }
  bool active() const noexcept { return active_; }

 private:
  hex::Arena& arena_;
  size_t mark_;
  bool active_;
};

}  // namespace frame_util
}  // namespace passes
}  // namespace decompiler
}  // namespace hex

#endif  // HEX_DECOMPILER_PASSES_ARM64_FRAME_HELPERS_HPP
