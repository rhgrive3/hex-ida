#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "../include/hex_core/hex_core.hpp"

namespace {

struct Rng {
  uint64_t state;
  explicit Rng(uint64_t seed) : state(seed) {}
  uint64_t next_u64() {
    uint64_t x = state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    state = x;
    return x;
  }
  uint32_t next_u32() { return static_cast<uint32_t>(next_u64() >> 16); }
};

// Reference ECMA-262 ToUint32 using std::fmod / std::trunc (only in native test oracle).
uint32_t ref_to_uint32(double x) {
  if (!std::isfinite(x) || x == 0.0) return 0u;
  double t = std::trunc(x);
  constexpr double kTwo32 = 4294967296.0;
  double m = std::fmod(t, kTwo32);
  if (m < 0.0) m += kTwo32;
  if (m >= kTwo32 || m == 0.0) return 0u;
  return static_cast<uint32_t>(m);
}

void test_js_compat_100k_fuzz() {
  using namespace hex::js;

  // Deterministic edge cases
  const uint64_t special_bits[] = {
      0x0000000000000000ULL,  // +0.0
      0x8000000000000000ULL,  // -0.0
      0x7ff0000000000000ULL,  // +Inf
      0xfff0000000000000ULL,  // -Inf
      0x7ff8000000000000ULL,  // canonical qNaN
      0x7ff8000000000001ULL,  // alt qNaN
      0xfff8000012345678ULL,  // negative qNaN
      0x0000000000000001ULL,  // min subnormal
      0x8000000000000001ULL,  // -min subnormal
      0x0010000000000000ULL,  // min normal
      0x7fefffffffffffffULL,  // MAX_VALUE
      0xffefffffffffffffULL,  // -MAX_VALUE
  };
  for (uint64_t b : special_bits) {
    double v = bits_to_f64(b);
    assert(f64_to_bits(v) == b);
    assert(to_uint32(v) == ref_to_uint32(v));
    assert(to_int32(v) == static_cast<int32_t>(ref_to_uint32(v)));
    assert(to_uint16(v) == static_cast<uint16_t>(ref_to_uint32(v) & 0xffffu));
  }

  // SameValueZero / SameValue / normalize_zero
  const double pos0 = bits_to_f64(0x0000000000000000ULL);
  const double neg0 = bits_to_f64(0x8000000000000000ULL);
  const double nan1 = bits_to_f64(0x7ff8000000000000ULL);
  const double nan2 = bits_to_f64(0xfff80000deadbeefULL);
  assert(same_value_zero(pos0, neg0));
  assert(!same_value(pos0, neg0));
  assert(same_value_zero(nan1, nan2));
  assert(same_value(nan1, nan2));
  assert(f64_to_bits(normalize_zero(neg0)) == 0ULL);
  assert(is_nan(nan1) && is_nan(nan2) && !is_finite(nan1));
  assert(!is_finite(bits_to_f64(0x7ff0000000000000ULL)));
  assert(is_finite(123.456));

  // Boundary powers of 2
  const double boundary_vals[] = {
      0.0, -0.0, 0.5, -0.5, 0.9999999999, -0.9999999999,
      1.0, -1.0, 2147483647.0, 2147483648.0, -2147483648.0, -2147483649.0,
      4294967295.0, 4294967296.0, -4294967296.0, 4294967297.5, -4294967297.5,
      9007199254740991.0, -9007199254740991.0, 9007199254740992.0,
      static_cast<double>(1ULL << 52) + 1.0,
      static_cast<double>(1ULL << 62),
      std::ldexp(1.0, 83),
      std::ldexp(1.0, 84),
      -std::ldexp(1.0, 83),
      -std::ldexp(1.0, 84),
  };
  for (double v : boundary_vals) {
    assert(to_uint32(v) == ref_to_uint32(v));
    assert(to_int32(v) == static_cast<int32_t>(ref_to_uint32(v)));
    assert(to_uint16(v) == static_cast<uint16_t>(ref_to_uint32(v) & 0xffffu));
    if (std::isfinite(v)) {
      double t = trunc_f64(v);
      double rt = std::trunc(v);
      assert(f64_to_bits(t) == f64_to_bits(rt));
    }
  }

  // 100,000-iteration fuzz across doubles and 32-bit integer ops
  Rng rng(0x123456789abcdef1ULL);
  for (uint32_t iter = 0; iter < 100000u; ++iter) {
    const uint64_t r = rng.next_u64();
    double v = 0.0;
    const uint32_t mode = static_cast<uint32_t>(r & 3u);
    if (mode == 0u) {
      // Raw random bit pattern (includes subnormals, NaNs, Infs, huge exponents)
      v = bits_to_f64(rng.next_u64());
    } else if (mode == 1u) {
      // Moderate range around int32/uint32 boundaries
      const int64_t s = static_cast<int64_t>(rng.next_u64() % 20000000000ULL) - 10000000000LL;
      const double frac = static_cast<double>(rng.next_u32() & 0xffffu) / 65536.0;
      v = static_cast<double>(s) + (s < 0 ? -frac : frac);
    } else if (mode == 2u) {
      // Exponents in [-10, 90]
      const int exp = static_cast<int>(rng.next_u32() % 101u) - 10;
      const double mant = 1.0 + static_cast<double>(rng.next_u64() & ((1ULL << 52) - 1ULL)) / static_cast<double>(1ULL << 52);
      v = std::ldexp((rng.next_u32() & 1u) ? -mant : mant, exp);
    } else {
      // Exact safe integers
      const int64_t k = static_cast<int64_t>(rng.next_u64() & 0x001fffffffffffffULL) - (1LL << 52);
      v = static_cast<double>(k);
    }

    assert(to_uint32(v) == ref_to_uint32(v));
    assert(to_int32(v) == static_cast<int32_t>(ref_to_uint32(v)));
    assert(to_uint16(v) == static_cast<uint16_t>(ref_to_uint32(v) & 0xffffu));
    if (std::isfinite(v)) {
      assert(f64_to_bits(trunc_f64(v)) == f64_to_bits(std::trunc(v)));
    }

    // 32-bit JS integer ops
    const int32_t a = static_cast<int32_t>(rng.next_u32());
    const int32_t b = static_cast<int32_t>(rng.next_u32());
    const uint32_t sh = static_cast<uint32_t>(b) & 31u;
    assert(imul(a, b) == static_cast<int32_t>(static_cast<uint32_t>(a) * static_cast<uint32_t>(b)));
    assert(shl32(a, b) == static_cast<int32_t>(static_cast<uint32_t>(a) << sh));
    assert(ushr32(a, b) == (static_cast<uint32_t>(a) >> sh));
    const int32_t expected_sar = (sh == 0u)
        ? a
        : (a >= 0 ? static_cast<int32_t>(static_cast<uint32_t>(a) >> sh)
                  : static_cast<int32_t>((static_cast<uint32_t>(a) >> sh) | (~0u << (32u - sh))));
    assert(sar32(a, b) == expected_sar);

    const uint32_t ua = static_cast<uint32_t>(a);
    uint32_t ref_clz = 32u;
    for (int bit = 31; bit >= 0; --bit) {
      if ((ua >> bit) & 1u) { ref_clz = static_cast<uint32_t>(31 - bit); break; }
    }
    assert(clz32(ua) == ref_clz);
  }

  // FNV-1a-64 smoke check ("foobar" = 0x85944171f73967e8)
  const char* fb = "foobar";
  assert(fnv1a_64(reinterpret_cast<const uint8_t*>(fb), 6) == 0x85944171f73967e8ULL);
  std::printf("  [PASS] js_compat 100k fuzz\n");
}

void test_ordered_map_set_60k_fuzz() {
  std::vector<uint8_t> mem(64 * 1024 * 1024);
  hex::Arena arena;
  arena.init_fixed(mem.data(), mem.size());

  hex::OrderedMap<uint32_t, uint64_t> map(&arena);
  hex::OrderedSet<uint32_t> set(&arena);
  std::vector<std::pair<uint32_t, uint64_t>> ref;

  auto ref_find = [&](uint32_t k) -> int {
    for (size_t i = 0; i < ref.size(); ++i) {
      if (ref[i].first == k) return static_cast<int>(i);
    }
    return -1;
  };

  Rng rng(0x9e3779b97f4a7c15ULL);
  for (uint32_t step = 0; step < 60000u; ++step) {
    const uint32_t op = rng.next_u32() % 100u;
    const uint32_t key = rng.next_u32() % 256u;

    if (op < 55u) {
      const uint64_t val = rng.next_u64();
      assert(map.set(key, val));
      assert(set.add(key));
      const int idx = ref_find(key);
      if (idx >= 0) ref[static_cast<size_t>(idx)].second = val;
      else ref.emplace_back(key, val);
    } else if (op < 85u) {
      const bool erased_map = map.erase(key);
      const bool erased_set = set.erase(key);
      const int idx = ref_find(key);
      assert(erased_map == (idx >= 0));
      assert(erased_set == (idx >= 0));
      if (idx >= 0) ref.erase(ref.begin() + idx);
    } else if (op < 98u) {
      uint64_t* p = map.find(key);
      const bool hs = set.has(key);
      const int idx = ref_find(key);
      assert((p != nullptr) == (idx >= 0));
      assert(hs == (idx >= 0));
      if (idx >= 0) assert(*p == ref[static_cast<size_t>(idx)].second);
    } else {
      map.clear();
      set.clear();
      ref.clear();
    }

    assert(map.size() == ref.size());
    assert(set.size() == ref.size());

    if ((step & 1023u) == 0u || step == 59999u) {
      size_t i = 0;
      for (const auto& entry : map) {
        assert(i < ref.size());
        assert(entry.key == ref[i].first);
        assert(entry.value == ref[i].second);
        ++i;
      }
      assert(i == ref.size());
      i = 0;
      for (uint32_t sk : set) {
        assert(i < ref.size());
        assert(sk == ref[i].first);
        ++i;
      }
      assert(i == ref.size());
    }
  }

  // SameValueZero double key test (+0.0 == -0.0, NaN == NaN across distinct NaN bit patterns)
  {
    hex::ArenaScope scope(arena);
    hex::OrderedMap<double, int32_t> dmap(&arena);
    const double p0 = hex::js::bits_to_f64(0x0000000000000000ULL);
    const double n0 = hex::js::bits_to_f64(0x8000000000000000ULL);
    const double nan_a = hex::js::bits_to_f64(0x7ff8000000000000ULL);
    const double nan_b = hex::js::bits_to_f64(0xfff8000012345678ULL);

    assert(dmap.set(p0, 10));
    assert(dmap.set(n0, 20));
    assert(dmap.size() == 1u);
    assert(dmap.find(p0) != nullptr && *dmap.find(p0) == 20);
    assert(dmap.find(n0) != nullptr && *dmap.find(n0) == 20);

    assert(dmap.set(nan_a, 100));
    assert(dmap.set(nan_b, 200));
    assert(dmap.size() == 2u);
    assert(dmap.find(nan_a) != nullptr && *dmap.find(nan_a) == 200);
    assert(dmap.find(nan_b) != nullptr && *dmap.find(nan_b) == 200);
    assert(dmap.erase(nan_a));
    assert(!dmap.has(nan_b));
    assert(dmap.size() == 1u);
  }

  // OOM fail-closed test for OrderedMap & OrderedSet
  {
    uint8_t tiny[32];
    hex::Arena oom_arena;
    oom_arena.init_fixed(tiny, sizeof(tiny));
    hex::OrderedMap<uint32_t, uint32_t> oom_map(&oom_arena);
    assert(!oom_map.set(1u, 2u));
    assert(oom_map.empty());
    hex::OrderedSet<uint32_t> oom_set(&oom_arena);
    assert(!oom_set.add(1u));
    assert(oom_set.empty());
  }

  std::printf("  [PASS] OrderedMap/OrderedSet 60k stateful fuzz + SameValueZero + OOM\n");
}

void test_stable_sort_1000_arrays() {
  struct Item {
    int32_t key;
    uint32_t orig_idx;
  };

  std::vector<uint8_t> mem(4 * 1024 * 1024);
  hex::Arena arena;
  arena.init_fixed(mem.data(), mem.size());

  Rng rng(0xdeadbeefcafebabeULL);
  for (uint32_t t = 0; t < 1000u; ++t) {
    const size_t n = static_cast<size_t>(rng.next_u32() % 257u);
    const int32_t key_mod = 1 + static_cast<int32_t>(rng.next_u32() % 12u);  // high duplicate density
    std::vector<Item> arr(n);
    for (size_t i = 0; i < n; ++i) {
      arr[i] = Item{static_cast<int32_t>(rng.next_u32() % static_cast<uint32_t>(key_mod)) - 4,
                    static_cast<uint32_t>(i)};
    }
    const size_t before_used = arena.used();
    const bool ok = hex::stable_sort(arena, arr.data(), arr.size(),
                                     [](const Item& a, const Item& b) { return a.key < b.key; });
    assert(ok);
    assert(arena.used() == before_used);  // ArenaScope must reclaim scratch

    for (size_t i = 1; i < n; ++i) {
      assert(arr[i - 1].key <= arr[i].key);
      if (arr[i - 1].key == arr[i].key) {
        assert(arr[i - 1].orig_idx < arr[i].orig_idx);
      }
    }
  }

  // OOM fail-closed on n > 16
  {
    uint8_t tiny[32];
    hex::Arena oom_arena;
    oom_arena.init_fixed(tiny, sizeof(tiny));
    std::vector<Item> arr(32);
    for (uint32_t i = 0; i < 32u; ++i) arr[i] = Item{static_cast<int32_t>(32u - i), i};
    assert(!hex::stable_sort(oom_arena, arr.data(), arr.size(),
                             [](const Item& a, const Item& b) { return a.key < b.key; }));
    assert(!hex::stable_sort<Item>(oom_arena, nullptr, 4,
                                   [](const Item& a, const Item& b) { return a.key < b.key; }));
  }

  std::printf("  [PASS] stable_sort 1,000 arrays stability + OOM\n");
}

void test_vec_string_view_arena_scope() {
  std::vector<uint8_t> mem(256 * 1024);
  hex::Arena arena;
  arena.init_fixed(mem.data(), mem.size());

  // ArenaScope & arena_alloc_zeroed
  {
    const size_t mark0 = arena.used();
    {
      hex::ArenaScope s1(arena);
      uint64_t* z = hex::arena_alloc_zeroed<uint64_t>(arena, 64);
      assert(z != nullptr);
      for (int i = 0; i < 64; ++i) assert(z[i] == 0ULL);
      assert(arena.used() > mark0);
    }
    assert(arena.used() == mark0);
  }

  // Vec push/pop/resize/span/OOM
  {
    hex::ArenaScope scope(arena);
    hex::Vec<uint32_t> v(&arena);
    assert(v.empty());
    for (uint32_t i = 0; i < 1000u; ++i) assert(v.push_back(i * 3u));
    assert(v.size() == 1000u);
    assert(v.back() == 2997u);
    v.pop_back();
    assert(v.size() == 999u);
    assert(v.resize(1024u, 77u));
    assert(v[1023] == 77u);
    auto sp = v.span();
    assert(sp.size() == 1024u && sp[10] == 30u);
    v.clear();
    assert(v.empty());

    uint8_t tiny[16];
    hex::Arena oom_arena;
    oom_arena.init_fixed(tiny, sizeof(tiny));
    hex::Vec<uint64_t> oom_vec(&oom_arena);
    assert(!oom_vec.reserve(64));
  }

  // StringView & clone_string
  {
    hex::ArenaScope scope(arena);
    hex::StringView a("hex_wasm_engine");
    assert(a.size() == 15u);
    assert(a.starts_with("hex_"));
    assert(a.ends_with("engine"));
    assert(a.find('w') == 4u);
    assert(a.find("wasm") == 4u);
    assert(a.find("missing") == hex::StringView::npos);
    assert(a.substr(4, 4) == hex::StringView("wasm"));
    assert(hex::StringView("abc") < hex::StringView("abd"));
    assert(hex::StringView("ab") < hex::StringView("abc"));

    hex::StringView cloned = hex::clone_string(arena, a);
    assert(cloned == a && cloned.data() != a.data() && cloned.data()[cloned.size()] == '\0');
  }

  // U16StringView
  {
    const uint16_t u1[] = {0x0041, 0x3042, 0xd83d, 0xde00};
    const uint16_t u2[] = {0x0041, 0x3042, 0xd83d, 0xde01};
    hex::U16StringView v1(u1, 4);
    hex::U16StringView v2(u2, 4);
    hex::U16StringView v1_copy(u1, 4);
    assert(v1 == v1_copy);
    assert(v1 != v2);
    assert(v1 < v2);
    assert(v1.hash() == v1_copy.hash());
  }

  std::printf("  [PASS] Vec / StringView / U16StringView / ArenaScope\n");
}

}  // namespace

int main() {
  std::printf("Running test_hex_core_fuzz...\n");
  test_js_compat_100k_fuzz();
  test_ordered_map_set_60k_fuzz();
  test_stable_sort_1000_arrays();
  test_vec_string_view_arena_scope();
  std::printf("test_hex_core_fuzz (ASan+UBSan): ALL PASS\n");
  return 0;
}
