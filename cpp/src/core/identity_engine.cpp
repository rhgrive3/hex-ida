#include "identity_engine.hpp"

#if defined(__wasm__)
extern "C" {
extern unsigned char __heap_base;
}
#endif

namespace hex {
namespace identity {

namespace {

static constexpr char kHexDigits[16] = {
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};

static constexpr size_t kMaxJsonDepth = 128u;

inline uint64_t fnv64_step(uint64_t h, uint32_t unit) {
  h ^= static_cast<uint64_t>(unit);
  return h * HEX_FNV64_PRIME;
}

struct DualFnvState {
  uint64_t a;
  uint64_t b;

  DualFnvState() : a(HEX_FNV64_OFFSET_BASIS), b(HEX_FNV64_OFFSET_SWAPPED) {}

  inline void feed_u16(uint16_t code) {
    a = fnv64_step(a, code);
    b = fnv64_step(b, code);
  }

  void feed_utf8(const uint8_t* utf8, size_t len) {
    size_t i = 0;
    while (i < len) {
      const uint8_t b0 = utf8[i];
      if (b0 < 0x80u) {
        feed_u16(b0);
        ++i;
        continue;
      }
      uint32_t cp = 0xfffdu;
      if ((b0 & 0xe0u) == 0xc0u) {
        if (i + 1 < len && (utf8[i + 1] & 0xc0u) == 0x80u) {
          const uint32_t v = ((static_cast<uint32_t>(b0 & 0x1fu) << 6) |
                              static_cast<uint32_t>(utf8[i + 1] & 0x3fu));
          if (v >= 0x80u) {
            cp = v;
            i += 2;
          } else {
            ++i;
          }
        } else {
          ++i;
        }
      } else if ((b0 & 0xf0u) == 0xe0u) {
        if (i + 2 < len &&
            (utf8[i + 1] & 0xc0u) == 0x80u &&
            (utf8[i + 2] & 0xc0u) == 0x80u) {
          const uint32_t v = ((static_cast<uint32_t>(b0 & 0x0fu) << 12) |
                              (static_cast<uint32_t>(utf8[i + 1] & 0x3fu) << 6) |
                              static_cast<uint32_t>(utf8[i + 2] & 0x3fu));
          if (v >= 0x800u && !(v >= 0xd800u && v <= 0xdfffu)) {
            cp = v;
            i += 3;
          } else {
            ++i;
          }
        } else {
          ++i;
        }
      } else if ((b0 & 0xf8u) == 0xf0u) {
        if (i + 3 < len &&
            (utf8[i + 1] & 0xc0u) == 0x80u &&
            (utf8[i + 2] & 0xc0u) == 0x80u &&
            (utf8[i + 3] & 0xc0u) == 0x80u) {
          const uint32_t v = ((static_cast<uint32_t>(b0 & 0x07u) << 18) |
                              (static_cast<uint32_t>(utf8[i + 1] & 0x3fu) << 12) |
                              (static_cast<uint32_t>(utf8[i + 2] & 0x3fu) << 6) |
                              static_cast<uint32_t>(utf8[i + 3] & 0x3fu));
          if (v >= 0x10000u && v <= 0x10ffffu) {
            cp = v;
            i += 4;
          } else {
            ++i;
          }
        } else {
          ++i;
        }
      } else {
        ++i;
      }

      if (cp <= 0xffffu) {
        feed_u16(static_cast<uint16_t>(cp));
      } else {
        const uint32_t adj = cp - 0x10000u;
        feed_u16(static_cast<uint16_t>(0xd800u | (adj >> 10)));
        feed_u16(static_cast<uint16_t>(0xdc00u | (adj & 0x3ffu)));
      }
    }
  }

  void feed_decimal_byte(uint8_t byte) {
    if (byte >= 100u) {
      feed_u16(static_cast<uint16_t>('0' + (byte / 100u)));
      feed_u16(static_cast<uint16_t>('0' + ((byte / 10u) % 10u)));
      feed_u16(static_cast<uint16_t>('0' + (byte % 10u)));
    } else if (byte >= 10u) {
      feed_u16(static_cast<uint16_t>('0' + (byte / 10u)));
      feed_u16(static_cast<uint16_t>('0' + (byte % 10u)));
    } else {
      feed_u16(static_cast<uint16_t>('0' + byte));
    }
  }

  void write_hex32(char* out) const {
    fnv64_to_hex(a, out);
    fnv64_to_hex(b, out + 16);
  }
};

// Matches js/core/identity/index.js `isArrayIndexKey`.
bool parse_array_index_key(StringView key, uint32_t* out_idx) {
  const size_t len = key.size();
  if (len == 0 || len > 10) return false;
  const uint8_t c0 = static_cast<uint8_t>(key[0]);
  if (c0 < '0' || c0 > '9') return false;
  if (c0 == '0') {
    if (len != 1) return false;
    *out_idx = 0u;
    return true;
  }
  uint64_t n = static_cast<uint64_t>(c0 - '0');
  for (size_t i = 1; i < len; ++i) {
    const uint8_t c = static_cast<uint8_t>(key[i]);
    if (c < '0' || c > '9') return false;
    n = n * 10ULL + static_cast<uint64_t>(c - '0');
  }
  if (n >= 0xffffffffULL) return false;
  *out_idx = static_cast<uint32_t>(n);
  return true;
}

// Decodes next UTF-16 code unit from a UTF-8 stream (with pending low surrogate).
struct Utf8ToUtf16Cursor {
  const uint8_t* data;
  size_t len;
  size_t pos;
  uint16_t pending_low;
  bool has_pending;

  Utf8ToUtf16Cursor(const uint8_t* d, size_t l)
      : data(d), len(l), pos(0), pending_low(0), has_pending(false) {}

  bool next(uint16_t* out) {
    if (has_pending) {
      *out = pending_low;
      has_pending = false;
      return true;
    }
    if (pos >= len) return false;
    const uint8_t b0 = data[pos];
    if (b0 < 0x80u) {
      *out = b0;
      ++pos;
      return true;
    }
    uint32_t cp = 0xfffdu;
    if ((b0 & 0xe0u) == 0xc0u && pos + 1 < len && (data[pos + 1] & 0xc0u) == 0x80u) {
      const uint32_t v = ((static_cast<uint32_t>(b0 & 0x1fu) << 6) |
                          static_cast<uint32_t>(data[pos + 1] & 0x3fu));
      if (v >= 0x80u) {
        cp = v;
        pos += 2;
      } else {
        ++pos;
      }
    } else if ((b0 & 0xf0u) == 0xe0u && pos + 2 < len &&
               (data[pos + 1] & 0xc0u) == 0x80u &&
               (data[pos + 2] & 0xc0u) == 0x80u) {
      const uint32_t v = ((static_cast<uint32_t>(b0 & 0x0fu) << 12) |
                          (static_cast<uint32_t>(data[pos + 1] & 0x3fu) << 6) |
                          static_cast<uint32_t>(data[pos + 2] & 0x3fu));
      if (v >= 0x800u && !(v >= 0xd800u && v <= 0xdfffu)) {
        cp = v;
        pos += 3;
      } else {
        ++pos;
      }
    } else if ((b0 & 0xf8u) == 0xf0u && pos + 3 < len &&
               (data[pos + 1] & 0xc0u) == 0x80u &&
               (data[pos + 2] & 0xc0u) == 0x80u &&
               (data[pos + 3] & 0xc0u) == 0x80u) {
      const uint32_t v = ((static_cast<uint32_t>(b0 & 0x07u) << 18) |
                          (static_cast<uint32_t>(data[pos + 1] & 0x3fu) << 12) |
                          (static_cast<uint32_t>(data[pos + 2] & 0x3fu) << 6) |
                          static_cast<uint32_t>(data[pos + 3] & 0x3fu));
      if (v >= 0x10000u && v <= 0x10ffffu) {
        cp = v;
        pos += 4;
      } else {
        ++pos;
      }
    } else {
      ++pos;
    }

    if (cp <= 0xffffu) {
      *out = static_cast<uint16_t>(cp);
    } else {
      const uint32_t adj = cp - 0x10000u;
      *out = static_cast<uint16_t>(0xd800u | (adj >> 10));
      pending_low = static_cast<uint16_t>(0xdc00u | (adj & 0x3ffu));
      has_pending = true;
    }
    return true;
  }
};

// Exact JS UTF-16 code-unit lexicographical comparison for UTF-8 StringViews.
int compare_utf8_as_utf16(StringView a, StringView b) {
  Utf8ToUtf16Cursor ca(reinterpret_cast<const uint8_t*>(a.data()), a.size());
  Utf8ToUtf16Cursor cb(reinterpret_cast<const uint8_t*>(b.data()), b.size());
  uint16_t ua = 0;
  uint16_t ub = 0;
  for (;;) {
    const bool ha = ca.next(&ua);
    const bool hb = cb.next(&ub);
    if (!ha && !hb) return 0;
    if (!ha) return -1;
    if (!hb) return 1;
    if (ua != ub) return ua < ub ? -1 : 1;
  }
}

bool append_bytes(Vec<char>& out, const char* data, size_t len) {
  if (len == 0) return true;
  const size_t old_size = out.size();
  if (len > static_cast<size_t>(-1) - old_size) return false;
  if (!out.resize(old_size + len)) return false;
  mem_copy(out.data() + old_size, data, len);
  return true;
}

bool append_char(Vec<char>& out, char c) {
  return out.push_back(c);
}

bool append_repeat_char(Vec<char>& out, char c, size_t count) {
  if (count == 0) return true;
  const size_t old_size = out.size();
  if (count > static_cast<size_t>(-1) - old_size) return false;
  if (!out.resize(old_size + count)) return false;
  mem_set(out.data() + old_size, static_cast<unsigned char>(c), count);
  return true;
}

bool append_i64(Vec<char>& out, int64_t val) {
  char tmp[32];
  size_t n = 0;
  uint64_t mag = 0;
  if (val < 0) {
    if (!append_char(out, '-')) return false;
    mag = static_cast<uint64_t>(-(val + 1)) + 1ULL;
  } else {
    mag = static_cast<uint64_t>(val);
  }
  if (mag == 0) {
    return append_char(out, '0');
  }
  while (mag > 0) {
    tmp[n++] = static_cast<char>('0' + (mag % 10ULL));
    mag /= 10ULL;
  }
  for (size_t i = n; i > 0; --i) {
    if (!append_char(out, tmp[i - 1])) return false;
  }
  return true;
}

// ============================================================================
// Exact freestanding IEEE-754 double -> ECMA-262 shortest decimal (Dragon4)
// Zero heap allocation, zero lookup tables, exact for all finite doubles.
// ============================================================================
struct BigUint {
  static constexpr uint32_t kMaxLimbs = 44u;
  uint32_t limbs[kMaxLimbs];
  uint32_t len;

  void set_zero() { len = 0u; }

  void set_u64(uint64_t v) {
    if (v == 0ULL) {
      len = 0u;
    } else if (v <= 0xffffffffULL) {
      limbs[0] = static_cast<uint32_t>(v);
      len = 1u;
    } else {
      limbs[0] = static_cast<uint32_t>(v & 0xffffffffULL);
      limbs[1] = static_cast<uint32_t>(v >> 32);
      len = 2u;
    }
  }

  void trim() {
    while (len > 0u && limbs[len - 1u] == 0u) --len;
  }

  void shift_left(uint32_t bits) {
    if (len == 0u || bits == 0u) return;
    const uint32_t word_shift = bits >> 5;
    const uint32_t bit_shift = bits & 31u;
    if (bit_shift == 0u) {
      for (uint32_t i = len; i > 0u; --i) {
        limbs[i - 1u + word_shift] = limbs[i - 1u];
      }
      for (uint32_t i = 0u; i < word_shift; ++i) limbs[i] = 0u;
      len += word_shift;
    } else {
      const uint32_t carry = limbs[len - 1u] >> (32u - bit_shift);
      if (carry != 0u) {
        limbs[len + word_shift] = carry;
      }
      for (uint32_t i = len - 1u; i > 0u; --i) {
        limbs[i + word_shift] = (limbs[i] << bit_shift) | (limbs[i - 1u] >> (32u - bit_shift));
      }
      limbs[word_shift] = limbs[0] << bit_shift;
      for (uint32_t i = 0u; i < word_shift; ++i) limbs[i] = 0u;
      len += word_shift + (carry != 0u ? 1u : 0u);
    }
  }

  void mul_u32(uint32_t m) {
    if (len == 0u || m == 1u) return;
    if (m == 0u) {
      len = 0u;
      return;
    }
    uint64_t carry = 0ULL;
    for (uint32_t i = 0u; i < len; ++i) {
      const uint64_t prod = static_cast<uint64_t>(limbs[i]) * static_cast<uint64_t>(m) + carry;
      limbs[i] = static_cast<uint32_t>(prod & 0xffffffffULL);
      carry = prod >> 32;
    }
    if (carry != 0ULL) {
      limbs[len++] = static_cast<uint32_t>(carry);
    }
  }

  void mul_pow5(uint32_t exp) {
    static constexpr uint32_t kPow5[14] = {
        1u, 5u, 25u, 125u, 625u, 3125u, 15625u, 78125u,
        390625u, 1953125u, 9765625u, 48828125u, 244140625u, 1220703125u};
    while (exp >= 13u) {
      mul_u32(kPow5[13]);
      exp -= 13u;
    }
    if (exp > 0u) {
      mul_u32(kPow5[exp]);
    }
  }

  void mul_pow10(uint32_t exp) {
    if (exp == 0u || len == 0u) return;
    mul_pow5(exp);
    shift_left(exp);
  }

  static int compare(const BigUint& a, const BigUint& b) {
    if (a.len != b.len) return a.len < b.len ? -1 : 1;
    for (uint32_t i = a.len; i > 0u; --i) {
      const uint32_t av = a.limbs[i - 1u];
      const uint32_t bv = b.limbs[i - 1u];
      if (av != bv) return av < bv ? -1 : 1;
    }
    return 0;
  }

  static void add_to(const BigUint& a, const BigUint& b, BigUint& out) {
    const uint32_t n = a.len > b.len ? a.len : b.len;
    uint64_t carry = 0ULL;
    for (uint32_t i = 0u; i < n; ++i) {
      const uint64_t av = i < a.len ? a.limbs[i] : 0ULL;
      const uint64_t bv = i < b.len ? b.limbs[i] : 0ULL;
      const uint64_t sum = av + bv + carry;
      out.limbs[i] = static_cast<uint32_t>(sum & 0xffffffffULL);
      carry = sum >> 32;
    }
    out.len = n;
    if (carry != 0ULL) {
      out.limbs[out.len++] = static_cast<uint32_t>(carry);
    }
  }

  void sub_in_place(const BigUint& b) {
    uint64_t borrow = 0ULL;
    for (uint32_t i = 0u; i < len; ++i) {
      const uint64_t av = limbs[i];
      const uint64_t bv = (i < b.len ? static_cast<uint64_t>(b.limbs[i]) : 0ULL) + borrow;
      if (av >= bv) {
        limbs[i] = static_cast<uint32_t>(av - bv);
        borrow = 0ULL;
      } else {
        limbs[i] = static_cast<uint32_t>((1ULL << 32) + av - bv);
        borrow = 1ULL;
      }
    }
    trim();
  }

  static uint32_t div_mod_digit(BigUint& r, const BigUint& s) {
    uint32_t q = 0u;
    while (compare(r, s) >= 0) {
      r.sub_in_place(s);
      ++q;
    }
    return q;
  }
};

bool append_positive_finite_double(Vec<char>& out, double v) {
  const double tr = js::trunc_f64(v);
  if (tr == v && v <= 9007199254740991.0) {
    return append_i64(out, static_cast<int64_t>(v));
  }

  const uint64_t bits = js::f64_to_bits(v);
  const uint32_t raw_exp = static_cast<uint32_t>((bits >> 52) & 0x7ffULL);
  const uint64_t raw_mant = bits & 0x000fffffffffffffULL;

  uint64_t m = 0ULL;
  int32_t e = 0;
  bool lower_closer = false;
  if (raw_exp == 0u) {
    m = raw_mant;
    e = 1 - 1023 - 52;
  } else {
    m = (1ULL << 52) | raw_mant;
    e = static_cast<int32_t>(raw_exp) - 1023 - 52;
    lower_closer = (raw_mant == 0ULL && raw_exp > 1u);
  }
  const bool is_even = ((m & 1ULL) == 0ULL);

  uint32_t msb = 0u;
  if (m > 0xffffffffULL) {
    msb = 32u + (31u - js::clz32(static_cast<uint32_t>(m >> 32)));
  } else {
    msb = 31u - js::clz32(static_cast<uint32_t>(m));
  }

  BigUint r, s, m_plus, m_minus;
  if (e >= 0) {
    const uint32_t ue = static_cast<uint32_t>(e);
    if (lower_closer) {
      r.set_u64(m);
      r.shift_left(ue + 2u);
      s.set_u64(4ULL);
      m_plus.set_u64(1ULL);
      m_plus.shift_left(ue + 1u);
      m_minus.set_u64(1ULL);
      m_minus.shift_left(ue);
    } else {
      r.set_u64(m);
      r.shift_left(ue + 1u);
      s.set_u64(2ULL);
      m_plus.set_u64(1ULL);
      m_plus.shift_left(ue);
      m_minus.set_u64(1ULL);
      m_minus.shift_left(ue);
    }
  } else {
    const uint32_t neg_e = static_cast<uint32_t>(-e);
    if (lower_closer) {
      r.set_u64(m << 2);
      s.set_u64(1ULL);
      s.shift_left(neg_e + 2u);
      m_plus.set_u64(2ULL);
      m_minus.set_u64(1ULL);
    } else {
      r.set_u64(m << 1);
      s.set_u64(1ULL);
      s.shift_left(neg_e + 1u);
      m_plus.set_u64(1ULL);
      m_minus.set_u64(1ULL);
    }
  }

  const int32_t log2_v = e + static_cast<int32_t>(msb);
  const int64_t scaled = static_cast<int64_t>(log2_v) * 1262611LL;
  int32_t k = static_cast<int32_t>(scaled >= 0 ? (scaled >> 22) : -(((-scaled) + 4194303LL) >> 22)) + 1;

  if (k > 0) {
    s.mul_pow10(static_cast<uint32_t>(k));
  } else if (k < 0) {
    const uint32_t nk = static_cast<uint32_t>(-k);
    r.mul_pow10(nk);
    m_plus.mul_pow10(nk);
    m_minus.mul_pow10(nk);
  }

  BigUint tmp;
  for (;;) {
    BigUint::add_to(r, m_plus, tmp);
    const int c = BigUint::compare(tmp, s);
    if (c > 0 || (is_even && c == 0)) {
      s.mul_u32(10u);
      ++k;
    } else {
      break;
    }
  }
  for (;;) {
    BigUint::add_to(r, m_plus, tmp);
    tmp.mul_u32(10u);
    const int c = BigUint::compare(tmp, s);
    if (c < 0 || (!is_even && c == 0)) {
      r.mul_u32(10u);
      m_plus.mul_u32(10u);
      m_minus.mul_u32(10u);
      --k;
    } else {
      break;
    }
  }

  char digits[24];
  int32_t dlen = 0;
  for (;;) {
    r.mul_u32(10u);
    m_plus.mul_u32(10u);
    m_minus.mul_u32(10u);
    const uint32_t q = BigUint::div_mod_digit(r, s);
    const int cmp_low = BigUint::compare(r, m_minus);
    const bool low = is_even ? (cmp_low <= 0) : (cmp_low < 0);
    BigUint::add_to(r, m_plus, tmp);
    const int cmp_high = BigUint::compare(tmp, s);
    const bool high = is_even ? (cmp_high >= 0) : (cmp_high > 0);

    if (!low && !high) {
      digits[dlen++] = static_cast<char>('0' + q);
    } else if (low && !high) {
      digits[dlen++] = static_cast<char>('0' + q);
      break;
    } else if (!low && high) {
      digits[dlen++] = static_cast<char>('0' + q + 1u);
      break;
    } else {
      tmp = r;
      tmp.shift_left(1u);
      const int cmp_mid = BigUint::compare(tmp, s);
      if (cmp_mid < 0) {
        digits[dlen++] = static_cast<char>('0' + q);
      } else if (cmp_mid > 0) {
        digits[dlen++] = static_cast<char>('0' + q + 1u);
      } else {
        digits[dlen++] = static_cast<char>('0' + ((q & 1u) ? (q + 1u) : q));
      }
      break;
    }
  }

  while (dlen > 1 && digits[dlen - 1] == '0') --dlen;

  if (dlen <= k && k <= 21) {
    if (!append_bytes(out, digits, static_cast<size_t>(dlen))) return false;
    return append_repeat_char(out, '0', static_cast<size_t>(k - dlen));
  }
  if (0 < k && k < dlen) {
    if (!append_bytes(out, digits, static_cast<size_t>(k))) return false;
    if (!append_char(out, '.')) return false;
    return append_bytes(out, digits + k, static_cast<size_t>(dlen - k));
  }
  if (-6 < k && k <= 0) {
    if (!append_bytes(out, "0.", 2)) return false;
    if (!append_repeat_char(out, '0', static_cast<size_t>(-k))) return false;
    return append_bytes(out, digits, static_cast<size_t>(dlen));
  }

  if (!append_char(out, digits[0])) return false;
  if (dlen > 1) {
    if (!append_char(out, '.')) return false;
    if (!append_bytes(out, digits + 1, static_cast<size_t>(dlen - 1))) return false;
  }
  if (!append_char(out, 'e')) return false;
  const int32_t exp = k - 1;
  if (exp >= 0) {
    if (!append_char(out, '+')) return false;
    return append_i64(out, exp);
  }
  return append_i64(out, exp);
}

bool append_json_number(Vec<char>& out, double v) {
  if (!js::is_finite(v)) {
    return append_bytes(out, "null", 4);
  }
  v = js::normalize_zero(v);
  if (v == 0.0) {
    return append_char(out, '0');
  }
  if (v < 0.0) {
    if (!append_char(out, '-')) return false;
    v = -v;
  }
  return append_positive_finite_double(out, v);
}

bool append_json_string(Vec<char>& out, StringView s) {
  if (!append_char(out, '"')) return false;
  for (size_t i = 0; i < s.size(); ++i) {
    const uint8_t c = static_cast<uint8_t>(s[i]);
    if (c == '"') {
      if (!append_bytes(out, "\\\"", 2)) return false;
    } else if (c == '\\') {
      if (!append_bytes(out, "\\\\", 2)) return false;
    } else if (c == '\b') {
      if (!append_bytes(out, "\\b", 2)) return false;
    } else if (c == '\f') {
      if (!append_bytes(out, "\\f", 2)) return false;
    } else if (c == '\n') {
      if (!append_bytes(out, "\\n", 2)) return false;
    } else if (c == '\r') {
      if (!append_bytes(out, "\\r", 2)) return false;
    } else if (c == '\t') {
      if (!append_bytes(out, "\\t", 2)) return false;
    } else if (c < 0x20u) {
      char esc[6] = {'\\', 'u', '0', '0', kHexDigits[(c >> 4) & 0xfu], kHexDigits[c & 0xfu]};
      if (!append_bytes(out, esc, 6)) return false;
    } else {
      if (!append_char(out, static_cast<char>(c))) return false;
    }
  }
  return append_char(out, '"');
}

bool is_omitted_object_value(const JsonValue& v) {
  if (v.kind == JsonKind::Undefined) return true;
  if (v.kind == JsonKind::Number && !js::is_finite(v.num_val)) return true;
  return false;
}

struct SortedMember {
  StringView key;
  const JsonValue* value;
  bool is_index;
  uint32_t index_val;
};

struct StringifyFrame {
  bool is_object;
  const JsonValue* arr_items;
  const SortedMember* obj_members;
  size_t len;
  size_t index;
};

// Non-recursive, NULL-safe canonical JSON stringifier with explicit frame stack.
HexStatus stringify_value_iterative(Arena& arena, const JsonValue& root, Vec<char>& out) {
  Vec<StringifyFrame> stack(&arena);

  auto emit_or_push = [&](const JsonValue& v) -> HexStatus {
    switch (v.kind) {
      case JsonKind::Null:
      case JsonKind::Undefined:
        return append_bytes(out, "null", 4) ? HEX_OK : HEX_ERR_OOM;
      case JsonKind::Bool:
        return (v.bool_val ? append_bytes(out, "true", 4) : append_bytes(out, "false", 5))
                   ? HEX_OK
                   : HEX_ERR_OOM;
      case JsonKind::Number:
        return append_json_number(out, v.num_val) ? HEX_OK : HEX_ERR_OOM;
      case JsonKind::Int64:
        return append_i64(out, v.int_val) ? HEX_OK : HEX_ERR_OOM;
      case JsonKind::String:
        if (v.str_val.size() > 0 && !v.str_val.data()) return HEX_ERR_INVALID_ARG;
        return append_json_string(out, v.str_val) ? HEX_OK : HEX_ERR_OOM;
      case JsonKind::Array: {
        if (v.arr_len > 0 && !v.arr_items) return HEX_ERR_INVALID_ARG;
        if (stack.size() >= kMaxJsonDepth) return HEX_ERR_RESOURCE_LIMIT;
        if (!append_char(out, '[')) return HEX_ERR_OOM;
        if (v.arr_len == 0) {
          return append_char(out, ']') ? HEX_OK : HEX_ERR_OOM;
        }
        StringifyFrame f{};
        f.is_object = false;
        f.arr_items = v.arr_items;
        f.obj_members = nullptr;
        f.len = v.arr_len;
        f.index = 0;
        return stack.push_back(f) ? HEX_OK : HEX_ERR_OOM;
      }
      case JsonKind::Object: {
        if (v.obj_len > 0 && !v.obj_members) return HEX_ERR_INVALID_ARG;
        if (stack.size() >= kMaxJsonDepth) return HEX_ERR_RESOURCE_LIMIT;
        if (!append_char(out, '{')) return HEX_ERR_OOM;
        if (v.obj_len == 0) {
          return append_char(out, '}') ? HEX_OK : HEX_ERR_OOM;
        }
        OrderedMap<StringView, const JsonValue*> dedup(&arena);
        if (!dedup.reserve(static_cast<uint32_t>(v.obj_len))) return HEX_ERR_OOM;
        for (size_t i = 0; i < v.obj_len; ++i) {
          if (!v.obj_members[i].value) return HEX_ERR_INVALID_ARG;
          if (v.obj_members[i].key.size() > 0 && !v.obj_members[i].key.data()) {
            return HEX_ERR_INVALID_ARG;
          }
          if (!dedup.set(v.obj_members[i].key, v.obj_members[i].value)) return HEX_ERR_OOM;
        }
        Vec<SortedMember> members(&arena);
        if (!members.reserve(dedup.size())) return HEX_ERR_OOM;
        for (const auto& entry : dedup) {
          if (is_omitted_object_value(*entry.value)) continue;
          SortedMember m{};
          m.key = entry.key;
          m.value = entry.value;
          m.is_index = parse_array_index_key(entry.key, &m.index_val);
          if (!members.push_back(m)) return HEX_ERR_OOM;
        }
        if (members.empty()) {
          return append_char(out, '}') ? HEX_OK : HEX_ERR_OOM;
        }
        if (!stable_sort(arena, members.data(), members.size(),
                         [](const SortedMember& a, const SortedMember& b) {
                           if (a.is_index != b.is_index) return a.is_index;
                           if (a.is_index) return a.index_val < b.index_val;
                           return compare_utf8_as_utf16(a.key, b.key) < 0;
                         })) {
          return HEX_ERR_OOM;
        }
        StringifyFrame f{};
        f.is_object = true;
        f.arr_items = nullptr;
        f.obj_members = members.data();
        f.len = members.size();
        f.index = 0;
        return stack.push_back(f) ? HEX_OK : HEX_ERR_OOM;
      }
    }
    return HEX_ERR_INVALID_ARG;
  };

  HexStatus st = emit_or_push(root);
  if (st != HEX_OK) return st;

  while (!stack.empty()) {
    StringifyFrame& top = stack.back();
    if (top.index >= top.len) {
      const char close_ch = top.is_object ? '}' : ']';
      stack.pop_back();
      if (!append_char(out, close_ch)) return HEX_ERR_OOM;
      continue;
    }
    const size_t idx = top.index++;
    if (idx != 0 && !append_char(out, ',')) return HEX_ERR_OOM;
    if (top.is_object) {
      const SortedMember m = top.obj_members[idx];
      if (!append_json_string(out, m.key)) return HEX_ERR_OOM;
      if (!append_char(out, ':')) return HEX_ERR_OOM;
      st = emit_or_push(*m.value);
      if (st != HEX_OK) return st;
    } else {
      const JsonValue& item = top.arr_items[idx];
      st = emit_or_push(item);
      if (st != HEX_OK) return st;
    }
  }
  return HEX_OK;
}

// ============================================================================
// Non-recursive freestanding JSON parser for `hex_identity_stable_stringify`
// ============================================================================
struct JsonParser {
  Arena& arena;
  const uint8_t* data;
  size_t len;
  size_t pos;

  void skip_ws() {
    while (pos < len) {
      const uint8_t c = data[pos];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++pos;
      else break;
    }
  }

  static int hex_val(uint8_t c) {
    if (c >= '0' && c <= '9') return static_cast<int>(c - '0');
    if (c >= 'a' && c <= 'f') return static_cast<int>(10 + (c - 'a'));
    if (c >= 'A' && c <= 'F') return static_cast<int>(10 + (c - 'A'));
    return -1;
  }

  bool append_utf8_cp(Vec<char>& buf, uint32_t cp) {
    if (cp <= 0x7fu) {
      return append_char(buf, static_cast<char>(cp));
    }
    if (cp <= 0x7ffu) {
      char u[2] = {
          static_cast<char>(0xc0u | (cp >> 6)),
          static_cast<char>(0x80u | (cp & 0x3fu))};
      return append_bytes(buf, u, 2);
    }
    if (cp <= 0xffffu) {
      char u[3] = {
          static_cast<char>(0xe0u | (cp >> 12)),
          static_cast<char>(0x80u | ((cp >> 6) & 0x3fu)),
          static_cast<char>(0x80u | (cp & 0x3fu))};
      return append_bytes(buf, u, 3);
    }
    char u[4] = {
        static_cast<char>(0xf0u | (cp >> 18)),
        static_cast<char>(0x80u | ((cp >> 12) & 0x3fu)),
        static_cast<char>(0x80u | ((cp >> 6) & 0x3fu)),
        static_cast<char>(0x80u | (cp & 0x3fu))};
    return append_bytes(buf, u, 4);
  }

  bool parse_hex4(uint16_t* out) {
    if (pos + 4 > len) return false;
    uint16_t v = 0;
    for (int i = 0; i < 4; ++i) {
      const int d = hex_val(data[pos + i]);
      if (d < 0) return false;
      v = static_cast<uint16_t>((v << 4) | static_cast<uint16_t>(d));
    }
    pos += 4;
    *out = v;
    return true;
  }

  HexStatus parse_string(StringView* out) {
    if (pos >= len || data[pos] != '"') return HEX_ERR_INVALID_ARG;
    ++pos;
    const size_t start = pos;
    bool has_escape = false;
    while (pos < len) {
      const uint8_t c = data[pos];
      if (c == '"') {
        if (!has_escape) {
          *out = StringView(reinterpret_cast<const char*>(data + start), pos - start);
          ++pos;
          return HEX_OK;
        }
        break;
      }
      if (c < 0x20u) return HEX_ERR_INVALID_ARG;
      if (c == '\\') {
        has_escape = true;
        break;
      }
      ++pos;
    }
    if (!has_escape) return HEX_ERR_INVALID_ARG;

    pos = start;
    Vec<char> buf(&arena);
    while (pos < len) {
      const uint8_t c = data[pos++];
      if (c == '"') {
        char* s = arena.alloc<char>(buf.size() + 1u);
        if (!s) return HEX_ERR_OOM;
        if (!buf.empty()) mem_copy(s, buf.data(), buf.size());
        s[buf.size()] = '\0';
        *out = StringView(s, buf.size());
        return HEX_OK;
      }
      if (c < 0x20u) return HEX_ERR_INVALID_ARG;
      if (c != '\\') {
        if (!append_char(buf, static_cast<char>(c))) return HEX_ERR_OOM;
        continue;
      }
      if (pos >= len) return HEX_ERR_INVALID_ARG;
      const uint8_t esc = data[pos++];
      switch (esc) {
        case '"': if (!append_char(buf, '"')) return HEX_ERR_OOM; break;
        case '\\': if (!append_char(buf, '\\')) return HEX_ERR_OOM; break;
        case '/': if (!append_char(buf, '/')) return HEX_ERR_OOM; break;
        case 'b': if (!append_char(buf, '\b')) return HEX_ERR_OOM; break;
        case 'f': if (!append_char(buf, '\f')) return HEX_ERR_OOM; break;
        case 'n': if (!append_char(buf, '\n')) return HEX_ERR_OOM; break;
        case 'r': if (!append_char(buf, '\r')) return HEX_ERR_OOM; break;
        case 't': if (!append_char(buf, '\t')) return HEX_ERR_OOM; break;
        case 'u': {
          uint16_t u1 = 0;
          if (!parse_hex4(&u1)) return HEX_ERR_INVALID_ARG;
          uint32_t cp = u1;
          if (u1 >= 0xd800u && u1 <= 0xdbffu && pos + 2 <= len &&
              data[pos] == '\\' && data[pos + 1] == 'u') {
            const size_t saved = pos;
            pos += 2;
            uint16_t u2 = 0;
            if (parse_hex4(&u2) && u2 >= 0xdc00u && u2 <= 0xdfffu) {
              cp = 0x10000u + ((static_cast<uint32_t>(u1 - 0xd800u) << 10) |
                               static_cast<uint32_t>(u2 - 0xdc00u));
            } else {
              pos = saved;
            }
          }
          if (!append_utf8_cp(buf, cp)) return HEX_ERR_OOM;
          break;
        }
        default:
          return HEX_ERR_INVALID_ARG;
      }
    }
    return HEX_ERR_INVALID_ARG;
  }

  HexStatus parse_number(JsonValue* out) {
    bool neg = false;
    if (pos < len && data[pos] == '-') {
      neg = true;
      ++pos;
    }
    if (pos >= len || data[pos] < '0' || data[pos] > '9') return HEX_ERR_INVALID_ARG;
    const size_t int_start = pos;
    if (data[pos] == '0') {
      ++pos;
      if (pos < len && data[pos] >= '0' && data[pos] <= '9') return HEX_ERR_INVALID_ARG;
    } else {
      while (pos < len && data[pos] >= '0' && data[pos] <= '9') ++pos;
    }
    const size_t int_end = pos;

    bool has_frac = false;
    size_t frac_start = pos;
    size_t frac_end = pos;
    if (pos < len && data[pos] == '.') {
      has_frac = true;
      ++pos;
      frac_start = pos;
      if (pos >= len || data[pos] < '0' || data[pos] > '9') return HEX_ERR_INVALID_ARG;
      while (pos < len && data[pos] >= '0' && data[pos] <= '9') ++pos;
      frac_end = pos;
    }

    bool has_exp = false;
    int32_t exp_val = 0;
    if (pos < len && (data[pos] == 'e' || data[pos] == 'E')) {
      has_exp = true;
      ++pos;
      bool exp_neg = false;
      if (pos < len && (data[pos] == '+' || data[pos] == '-')) {
        exp_neg = (data[pos] == '-');
        ++pos;
      }
      if (pos >= len || data[pos] < '0' || data[pos] > '9') return HEX_ERR_INVALID_ARG;
      int64_t ev = 0;
      while (pos < len && data[pos] >= '0' && data[pos] <= '9') {
        if (ev < 1000000LL) ev = ev * 10LL + (data[pos] - '0');
        ++pos;
      }
      exp_val = static_cast<int32_t>(exp_neg ? -ev : ev);
    }

    if (!has_frac && !has_exp && (int_end - int_start) <= 15u) {
      int64_t iv = 0;
      for (size_t i = int_start; i < int_end; ++i) {
        iv = iv * 10LL + static_cast<int64_t>(data[i] - '0');
      }
      if (neg) {
        *out = (iv == 0) ? JsonValue::make_number(-0.0) : JsonValue::make_int64(-iv);
      } else {
        *out = JsonValue::make_int64(iv);
      }
      return HEX_OK;
    }

    uint64_t sig = 0ULL;
    int32_t sig_digits = 0;
    int32_t dec_exp = exp_val;
    bool non_zero = false;
    for (size_t i = int_start; i < int_end; ++i) {
      const uint8_t d = static_cast<uint8_t>(data[i] - '0');
      if (!non_zero && d == 0u) continue;
      non_zero = true;
      if (sig_digits < 19) {
        sig = sig * 10ULL + d;
        ++sig_digits;
      } else {
        ++dec_exp;
      }
    }
    for (size_t i = frac_start; i < frac_end; ++i) {
      const uint8_t d = static_cast<uint8_t>(data[i] - '0');
      if (!non_zero && d == 0u) {
        --dec_exp;
        continue;
      }
      non_zero = true;
      if (sig_digits < 19) {
        sig = sig * 10ULL + d;
        ++sig_digits;
        --dec_exp;
      }
    }

    if (!non_zero) {
      *out = JsonValue::make_number(neg ? -0.0 : 0.0);
      return HEX_OK;
    }

    static constexpr double kPow10[23] = {
        1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
        1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};
    double val = static_cast<double>(sig);
    if (dec_exp > 0) {
      int32_t rem = dec_exp;
      while (rem > 22) {
        val *= 1e22;
        rem -= 22;
        if (!js::is_finite(val)) break;
      }
      if (js::is_finite(val)) val *= kPow10[rem];
    } else if (dec_exp < 0) {
      int32_t rem = -dec_exp;
      while (rem > 22) {
        val /= 1e22;
        rem -= 22;
        if (val == 0.0) break;
      }
      if (val != 0.0) val /= kPow10[rem];
    }
    *out = JsonValue::make_number(neg ? -val : val);
    return HEX_OK;
  }

  struct ParseFrame {
    bool is_object;
    Vec<JsonValue> arr;
    Vec<JsonMember> obj;
    StringView pending_key;
    bool expecting_value;
  };

  HexStatus parse_document(JsonValue* root_out) {
    Vec<ParseFrame> stack(&arena);
    JsonValue current{};
    bool have_value = false;

    auto attach_value = [&](const JsonValue& val) -> HexStatus {
      if (stack.empty()) {
        current = val;
        have_value = true;
        return HEX_OK;
      }
      ParseFrame& top = stack.back();
      if (top.is_object) {
        JsonValue* boxed = arena.alloc<JsonValue>(1u);
        if (!boxed) return HEX_ERR_OOM;
        *boxed = val;
        JsonMember m{top.pending_key, boxed};
        if (!top.obj.push_back(m)) return HEX_ERR_OOM;
        top.expecting_value = false;
      } else {
        if (!top.arr.push_back(val)) return HEX_ERR_OOM;
        top.expecting_value = false;
      }
      return HEX_OK;
    };

    for (;;) {
      skip_ws();
      if (!stack.empty() && !stack.back().expecting_value) {
        if (pos >= len) return HEX_ERR_INVALID_ARG;
        const uint8_t c = data[pos];
        if (stack.back().is_object) {
          if (c == '}') {
            ++pos;
            ParseFrame done = stack.back();
            stack.pop_back();
            const JsonValue obj = JsonValue::make_object(done.obj.data(), done.obj.size());
            const HexStatus st = attach_value(obj);
            if (st != HEX_OK) return st;
            if (stack.empty()) break;
            continue;
          }
          if (c != ',') return HEX_ERR_INVALID_ARG;
          ++pos;
          skip_ws();
          StringView key;
          const HexStatus ks = parse_string(&key);
          if (ks != HEX_OK) return ks;
          skip_ws();
          if (pos >= len || data[pos] != ':') return HEX_ERR_INVALID_ARG;
          ++pos;
          stack.back().pending_key = key;
          stack.back().expecting_value = true;
          continue;
        } else {
          if (c == ']') {
            ++pos;
            ParseFrame done = stack.back();
            stack.pop_back();
            const JsonValue arr = JsonValue::make_array(done.arr.data(), done.arr.size());
            const HexStatus st = attach_value(arr);
            if (st != HEX_OK) return st;
            if (stack.empty()) break;
            continue;
          }
          if (c != ',') return HEX_ERR_INVALID_ARG;
          ++pos;
          stack.back().expecting_value = true;
          continue;
        }
      }

      if (pos >= len) return HEX_ERR_INVALID_ARG;
      const uint8_t c = data[pos];
      if (c == '{') {
        if (stack.size() >= kMaxJsonDepth) return HEX_ERR_RESOURCE_LIMIT;
        ++pos;
        skip_ws();
        if (pos < len && data[pos] == '}') {
          ++pos;
          const HexStatus st = attach_value(JsonValue::make_object(nullptr, 0));
          if (st != HEX_OK) return st;
          if (stack.empty()) break;
          continue;
        }
        StringView key;
        const HexStatus ks = parse_string(&key);
        if (ks != HEX_OK) return ks;
        skip_ws();
        if (pos >= len || data[pos] != ':') return HEX_ERR_INVALID_ARG;
        ++pos;
        ParseFrame f{true, Vec<JsonValue>(&arena), Vec<JsonMember>(&arena), key, true};
        if (!stack.push_back(f)) return HEX_ERR_OOM;
      } else if (c == '[') {
        if (stack.size() >= kMaxJsonDepth) return HEX_ERR_RESOURCE_LIMIT;
        ++pos;
        skip_ws();
        if (pos < len && data[pos] == ']') {
          ++pos;
          const HexStatus st = attach_value(JsonValue::make_array(nullptr, 0));
          if (st != HEX_OK) return st;
          if (stack.empty()) break;
          continue;
        }
        ParseFrame f{false, Vec<JsonValue>(&arena), Vec<JsonMember>(&arena), StringView(), true};
        if (!stack.push_back(f)) return HEX_ERR_OOM;
      } else if (c == '"') {
        StringView sv;
        const HexStatus st = parse_string(&sv);
        if (st != HEX_OK) return st;
        const HexStatus at = attach_value(JsonValue::make_string(sv));
        if (at != HEX_OK) return at;
        if (stack.empty()) break;
      } else if (c == 't' && pos + 4 <= len && mem_cmp(data + pos, "true", 4) == 0) {
        pos += 4;
        const HexStatus at = attach_value(JsonValue::make_bool(true));
        if (at != HEX_OK) return at;
        if (stack.empty()) break;
      } else if (c == 'f' && pos + 5 <= len && mem_cmp(data + pos, "false", 5) == 0) {
        pos += 5;
        const HexStatus at = attach_value(JsonValue::make_bool(false));
        if (at != HEX_OK) return at;
        if (stack.empty()) break;
      } else if (c == 'n' && pos + 4 <= len && mem_cmp(data + pos, "null", 4) == 0) {
        pos += 4;
        const HexStatus at = attach_value(JsonValue::make_null());
        if (at != HEX_OK) return at;
        if (stack.empty()) break;
      } else if (c == '-' || (c >= '0' && c <= '9')) {
        JsonValue num{};
        const HexStatus st = parse_number(&num);
        if (st != HEX_OK) return st;
        const HexStatus at = attach_value(num);
        if (at != HEX_OK) return at;
        if (stack.empty()) break;
      } else {
        return HEX_ERR_INVALID_ARG;
      }
    }

    skip_ws();
    if (!have_value || pos != len) return HEX_ERR_INVALID_ARG;
    *root_out = current;
    return HEX_OK;
  }
};

// ============================================================================
// Global Arena management with shared external Arena pointer support
// ============================================================================
Arena g_owned_arena;
Arena* g_active_arena = nullptr;
bool g_external_arena_bound = false;
bool g_owned_fixed_bound = false;
bool g_owned_arena_ready = false;

#if defined(__wasm__)
void init_default_arena() {
  const uintptr_t raw = reinterpret_cast<uintptr_t>(&__heap_base);
  const uintptr_t aligned = (raw + 7u) & ~static_cast<uintptr_t>(7u);
  const size_t total = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u;
  g_owned_arena.init_external(
      reinterpret_cast<uint8_t*>(aligned),
      total > aligned ? total - aligned : 0u);
  g_owned_arena_ready = true;
  g_owned_fixed_bound = false;
  g_external_arena_bound = false;
  g_active_arena = &g_owned_arena;
}
#else
alignas(16) static uint8_t g_native_buf[4 * 1024 * 1024];

void init_default_arena() {
  g_owned_arena.init_external(g_native_buf, sizeof(g_native_buf));
  g_owned_arena_ready = true;
  g_owned_fixed_bound = false;
  g_external_arena_bound = false;
  g_active_arena = &g_owned_arena;
}
#endif

inline Arena& active_arena() {
  if (g_active_arena != nullptr) return *g_active_arena;
  init_default_arena();
  return *g_active_arena;
}

}  // namespace

void fnv64_to_hex(uint64_t hash, char* out16) {
  for (int i = 0; i < 16; ++i) {
    const uint32_t shift = static_cast<uint32_t>((15 - i) * 4);
    out16[i] = kHexDigits[(hash >> shift) & 0xfULL];
  }
}

HexStatus stable_stringify(Arena& arena, const JsonValue& value, StringView* out) {
  if (!out) return HEX_ERR_INVALID_ARG;
  Vec<char> buf(&arena);
  const HexStatus st = stringify_value_iterative(arena, value, buf);
  if (st != HEX_OK) return st;
  const size_t len = buf.size();
  char* result = arena.alloc<char>(len + 1u);
  if (!result) return HEX_ERR_OOM;
  if (len > 0) mem_copy(result, buf.data(), len);
  result[len] = '\0';
  *out = StringView(result, len);
  return HEX_OK;
}

HexStatus stable_digest(Arena& arena, const JsonValue& value, char* out_hex32) {
  if (!out_hex32) return HEX_ERR_INVALID_ARG;
  ArenaScope scope(arena);
  StringView canonical;
  const HexStatus st = stable_stringify(arena, value, &canonical);
  if (st != HEX_OK) return st;
  return hex_identity_digest_utf8(
      reinterpret_cast<const uint8_t*>(canonical.data()),
      static_cast<uint32_t>(canonical.size()),
      out_hex32);
}

HexStatus merge_origins_arena(
    Arena& arena,
    const uint8_t* data_a,
    const uint32_t* offsets_a,
    uint32_t count_a,
    const uint8_t* data_b,
    const uint32_t* offsets_b,
    uint32_t count_b,
    bool sort_canonical,
    HexOriginMergeResult* out) {
  if (!out) return HEX_ERR_INVALID_ARG;
  if (count_a > 0 && (!data_a || !offsets_a)) return HEX_ERR_INVALID_ARG;
  if (count_b > 0 && (!data_b || !offsets_b)) return HEX_ERR_INVALID_ARG;

  const uint64_t total_inputs = static_cast<uint64_t>(count_a) + static_cast<uint64_t>(count_b);
  if (total_inputs > OrderedSet<StringView>::MapType::kMaxEntries) return HEX_ERR_RESOURCE_LIMIT;

  OrderedSet<StringView> seen(&arena);
  if (total_inputs > 0 && !seen.reserve(static_cast<uint32_t>(total_inputs))) {
    return HEX_ERR_OOM;
  }

  auto ingest = [&](const uint8_t* data, const uint32_t* offsets, uint32_t count) -> HexStatus {
    for (uint32_t i = 0; i < count; ++i) {
      const uint32_t beg = offsets[i];
      const uint32_t end = offsets[i + 1];
      if (end < beg) return HEX_ERR_INVALID_ARG;
      const StringView sv(reinterpret_cast<const char*>(data + beg), static_cast<size_t>(end - beg));
      if (!seen.add(sv)) return HEX_ERR_OOM;
    }
    return HEX_OK;
  };

  HexStatus st = ingest(data_a, offsets_a, count_a);
  if (st != HEX_OK) return st;
  st = ingest(data_b, offsets_b, count_b);
  if (st != HEX_OK) return st;

  const uint32_t unique_count = seen.size();
  Vec<StringView> ordered(&arena);
  if (unique_count > 0 && !ordered.reserve(unique_count)) return HEX_ERR_OOM;

  uint64_t total_bytes = 0;
  for (const StringView& sv : seen) {
    if (!ordered.push_back(sv)) return HEX_ERR_OOM;
    total_bytes += sv.size();
  }
  if (total_bytes > 0xffffffffULL) return HEX_ERR_RESOURCE_LIMIT;

  if (sort_canonical && ordered.size() > 1) {
    if (!stable_sort(arena, ordered.data(), ordered.size(),
                     [](const StringView& a, const StringView& b) {
                       return compare_utf8_as_utf16(a, b) < 0;
                     })) {
      return HEX_ERR_OOM;
    }
  }

  uint32_t* out_offsets = arena.alloc<uint32_t>(static_cast<size_t>(unique_count) + 1u);
  if (!out_offsets) return HEX_ERR_OOM;

  uint8_t* out_data = nullptr;
  if (total_bytes > 0) {
    out_data = arena.alloc<uint8_t>(static_cast<size_t>(total_bytes));
    if (!out_data) return HEX_ERR_OOM;
  }

  uint32_t cursor = 0;
  for (uint32_t i = 0; i < unique_count; ++i) {
    out_offsets[i] = cursor;
    const size_t n = ordered[i].size();
    if (n > 0) {
      mem_copy(out_data + cursor, ordered[i].data(), n);
      cursor += static_cast<uint32_t>(n);
    }
  }
  out_offsets[unique_count] = cursor;

  out->data = out_data;
  out->offsets = out_offsets;
  out->count = unique_count;
  out->byte_len = cursor;
  return HEX_OK;
}

void bind_global_arena_ptr(Arena* arena) {
  if (arena != nullptr) {
    g_active_arena = arena;
    g_external_arena_bound = true;
  } else {
    g_external_arena_bound = false;
    g_active_arena = g_owned_arena_ready ? &g_owned_arena : nullptr;
  }
}

void bind_global_arena(uint8_t* buffer, size_t capacity) {
  g_owned_arena.init_fixed(buffer, capacity);
  g_owned_arena_ready = true;
  g_owned_fixed_bound = true;
  g_external_arena_bound = false;
  g_active_arena = &g_owned_arena;
}

}  // namespace identity
}  // namespace hex

extern "C" {

void hex_identity_reset(void) {
  if (hex::identity::g_external_arena_bound && hex::identity::g_active_arena != nullptr) {
    hex::identity::g_active_arena->reset();
    return;
  }
  if (hex::identity::g_owned_fixed_bound) {
    hex::identity::g_owned_arena.reset();
    return;
  }
  hex::identity::init_default_arena();
}

void* hex_identity_alloc(uint32_t bytes) {
  if (bytes == 0u) return nullptr;
  return hex::identity::active_arena().alloc_bytes(static_cast<size_t>(bytes), 8u);
}

uint64_t hex_identity_fnv64_bytes(const uint8_t* data, uint32_t len, uint64_t seed) {
  uint64_t h = seed;
  if (!data || len == 0u) return h;
  for (uint32_t i = 0; i < len; ++i) {
    h ^= static_cast<uint64_t>(data[i]);
    h *= HEX_FNV64_PRIME;
  }
  return h;
}

HexStatus hex_identity_digest_utf8(const uint8_t* utf8, uint32_t len, char* out_hex32) {
  if (!out_hex32) return HEX_ERR_INVALID_ARG;
  if (len > 0u && !utf8) return HEX_ERR_INVALID_ARG;
  hex::identity::DualFnvState state;
  if (len > 0u) {
    state.feed_utf8(utf8, static_cast<size_t>(len));
  }
  state.write_hex32(out_hex32);
  return HEX_OK;
}

HexStatus hex_identity_digest_bytes(
    const uint8_t* data,
    uint32_t len,
    uint32_t start,
    uint32_t end,
    int32_t mask_start,
    int32_t mask_end,
    char* out_hex32) {
  if (!out_hex32) return HEX_ERR_INVALID_ARG;
  if (len > 0u && !data) return HEX_ERR_INVALID_ARG;
  if (start > end || end > len) return HEX_ERR_INVALID_ARG;

  hex::identity::DualFnvState state;
  state.feed_u16('[');
  for (uint32_t idx = start; idx < end; ++idx) {
    const int64_t i64 = static_cast<int64_t>(idx);
    const bool masked = (i64 >= static_cast<int64_t>(mask_start) &&
                         i64 < static_cast<int64_t>(mask_end));
    const uint8_t byte = masked ? 0u : data[idx];
    state.feed_decimal_byte(byte);
    if (idx + 1u < end) {
      state.feed_u16(',');
    }
  }
  state.feed_u16(']');
  state.write_hex32(out_hex32);
  return HEX_OK;
}

HexStatus hex_identity_stable_stringify(
    const uint8_t* json_utf8,
    uint32_t len,
    uint8_t** out_ptr,
    uint32_t* out_len) {
  if (!out_ptr || !out_len) return HEX_ERR_INVALID_ARG;
  if (len == 0u || !json_utf8) return HEX_ERR_INVALID_ARG;

  hex::Arena& arena = hex::identity::active_arena();
  hex::identity::JsonParser parser{arena, json_utf8, static_cast<size_t>(len), 0u};
  hex::identity::JsonValue root{};
  HexStatus st = parser.parse_document(&root);
  if (st != HEX_OK) return st;

  hex::StringView canonical;
  st = hex::identity::stable_stringify(arena, root, &canonical);
  if (st != HEX_OK) return st;

  *out_ptr = reinterpret_cast<uint8_t*>(const_cast<char*>(canonical.data()));
  *out_len = static_cast<uint32_t>(canonical.size());
  return HEX_OK;
}

HexStatus hex_identity_merge_origins(
    const uint8_t* data_a,
    const uint32_t* offsets_a,
    uint32_t count_a,
    const uint8_t* data_b,
    const uint32_t* offsets_b,
    uint32_t count_b,
    HexOriginMergeResult* out) {
  return hex::identity::merge_origins_arena(
      hex::identity::active_arena(),
      data_a, offsets_a, count_a,
      data_b, offsets_b, count_b,
      false, out);
}

HexStatus hex_identity_merge_origins_sorted(
    const uint8_t* data_a,
    const uint32_t* offsets_a,
    uint32_t count_a,
    const uint8_t* data_b,
    const uint32_t* offsets_b,
    uint32_t count_b,
    HexOriginMergeResult* out) {
  return hex::identity::merge_origins_arena(
      hex::identity::active_arena(),
      data_a, offsets_a, count_a,
      data_b, offsets_b, count_b,
      true, out);
}

}  // extern "C"
