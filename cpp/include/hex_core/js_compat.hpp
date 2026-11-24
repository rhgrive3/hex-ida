#ifndef HEX_CORE_JS_COMPAT_HPP
#define HEX_CORE_JS_COMPAT_HPP

#include <stdint.h>
#include <stddef.h>

namespace hex {
namespace js {

inline uint64_t f64_to_bits(double x) { return __builtin_bit_cast(uint64_t, x); }
inline double bits_to_f64(uint64_t bits) { return __builtin_bit_cast(double, bits); }
inline bool is_nan(double x) { return x != x; }
inline bool is_finite(double x) { return ((f64_to_bits(x) >> 52) & 0x7ffULL) != 0x7ffULL; }
inline double normalize_zero(double x) { return (x == 0.0) ? 0.0 : x; }
inline bool same_value_zero(double a, double b) { return (is_nan(a) && is_nan(b)) ? true : (a == b); }
inline bool same_value(double a, double b) {
  if (is_nan(a) && is_nan(b)) return true;
  if (a == 0.0 && b == 0.0) return f64_to_bits(a) == f64_to_bits(b);
  return a == b;
}

inline double trunc_f64(double x) {
  if (!is_finite(x)) return x;
  const uint64_t bits = f64_to_bits(x);
  const int32_t exp = static_cast<int32_t>((bits >> 52) & 0x7ffULL) - 1023;
  if (exp < 0) return bits_to_f64(bits & (1ULL << 63));
  if (exp >= 52) return x;
  const uint64_t frac_mask = (1ULL << (52 - exp)) - 1ULL;
  return bits_to_f64(bits & ~frac_mask);
}

inline uint32_t to_uint32(double x) {
  if (!is_finite(x) || x == 0.0) return 0u;
  const uint64_t bits = f64_to_bits(x);
  const bool neg = (bits >> 63) != 0;
  const int32_t exp = static_cast<int32_t>((bits >> 52) & 0x7ffULL) - 1023;
  if (exp < 0 || exp >= 84) return 0u;
  const uint64_t mantissa = (bits & 0x000fffffffffffffULL) | 0x0010000000000000ULL;
  uint32_t mag = 0u;
  if (exp <= 52) mag = static_cast<uint32_t>(mantissa >> (52 - exp));
  else mag = static_cast<uint32_t>((mantissa << static_cast<uint32_t>(exp - 52)) & 0xffffffffULL);
  return neg ? static_cast<uint32_t>(0u - mag) : mag;
}

inline int32_t to_int32(double x) { return static_cast<int32_t>(to_uint32(x)); }
inline uint16_t to_uint16(double x) { return static_cast<uint16_t>(to_uint32(x) & 0xffffu); }
inline int32_t imul(int32_t a, int32_t b) { return static_cast<int32_t>(static_cast<uint32_t>(a) * static_cast<uint32_t>(b)); }
inline int32_t shl32(int32_t a, int32_t b) { return static_cast<int32_t>(static_cast<uint32_t>(a) << (static_cast<uint32_t>(b) & 31u)); }
inline uint32_t ushr32(int32_t a, int32_t b) { return static_cast<uint32_t>(a) >> (static_cast<uint32_t>(b) & 31u); }
inline int32_t sar32(int32_t a, int32_t b) {
  const uint32_t sh = static_cast<uint32_t>(b) & 31u;
  const uint32_t ua = static_cast<uint32_t>(a);
  if (sh == 0u) return a;
  if ((ua & 0x80000000u) == 0u) return static_cast<int32_t>(ua >> sh);
  return static_cast<int32_t>((ua >> sh) | (~0u << (32u - sh)));
}
inline uint32_t clz32(uint32_t x) { return x == 0u ? 32u : static_cast<uint32_t>(__builtin_clz(x)); }

inline uint64_t mix64(uint64_t x) {
  x += 0x9e3779b97f4a7c15ULL;
  x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
  x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
  return x ^ (x >> 31);
}
inline uint64_t hash_u32(uint32_t x) { return mix64(static_cast<uint64_t>(x)); }
inline uint64_t hash_u64(uint64_t x) { return mix64(x); }
inline uint64_t hash_f64_svz(double x) {
  if (is_nan(x)) return mix64(0x7ff8000000000000ULL);
  if (x == 0.0) return mix64(0ULL);
  return mix64(f64_to_bits(x));
}
inline uint64_t fnv1a_64(const uint8_t* data, size_t len) {
  uint64_t h = 0xcbf29ce484222325ULL;
  for (size_t i = 0; i < len; ++i) {
    h ^= static_cast<uint64_t>(data[i]);
    h *= 0x100000001b3ULL;
  }
  return h;
}

}  // namespace js
}  // namespace hex
#endif
