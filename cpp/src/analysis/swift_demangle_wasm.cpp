// Freestanding WASM32 integration of Apple's upstream swiftlang/swift Demangling library
// (third_party/swift-demangle/, Apache-2.0 WITH Runtime Library Exception).
// Compiles under: clang++ --target=wasm32 -std=c++20 -Os -nostdlib -fno-exceptions -fno-rtti -mbulk-memory
// Produces 0 external WASM imports, zero libc dependency, bounded bump arena reset per call.

#include "hex_abi.hpp"
#include "hex_core/types.hpp"

#include <limits.h>
#include <stddef.h>
#include <stdint.h>

// ============================================================================
// 1. Bounded Static Arena for Swift Demangler (Zero WASM Imports, O(1) Reset)
// ============================================================================
namespace hex_swift_demangle_detail {

constexpr size_t   kSwiftHeapArenaCap = 384u * 1024u;
constexpr uint32_t kMaxSwiftInputLen  = 2048u;

alignas(8) static uint8_t g_swift_heap_arena[kSwiftHeapArenaCap];
static size_t g_swift_heap_cursor = 0u;
static bool   g_swift_arena_oom   = false;

inline void reset_arena() {
  g_swift_heap_cursor = 0u;
  g_swift_arena_oom   = false;
}

inline void* arena_alloc(size_t sz, size_t align = 8u) {
  if (sz == 0u) sz = 1u;
  if (align < 8u) align = 8u;
  const size_t mask = align - 1u;
  const size_t aligned = (g_swift_heap_cursor + mask) & ~mask;
  if (aligned > kSwiftHeapArenaCap || sz > kSwiftHeapArenaCap - aligned) {
    g_swift_arena_oom = true;
    return nullptr;
  }
  void* ptr = g_swift_heap_arena + aligned;
  g_swift_heap_cursor = aligned + sz;
  return ptr;
}

inline void* arena_calloc(size_t count, size_t sz) {
  if (count != 0u && sz > kSwiftHeapArenaCap / count) {
    g_swift_arena_oom = true;
    return nullptr;
  }
  const size_t total = count * sz;
  void* p = arena_alloc(total, 8u);
  if (p) hex::mem_set(p, 0, total);
  return p;
}

inline size_t c_strlen(const char* s) {
  if (!s) return 0u;
  size_t n = 0u;
  while (s[n] != '\0') ++n;
  return n;
}

inline int c_memcmp(const void* a, const void* b, size_t n) {
  const uint8_t* pa = static_cast<const uint8_t*>(a);
  const uint8_t* pb = static_cast<const uint8_t*>(b);
  for (size_t i = 0u; i < n; ++i) {
    if (pa[i] != pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

}  // namespace hex_swift_demangle_detail

// ============================================================================
// 2. Freestanding C / std:: / llvm:: Shim for wasm32 -nostdlib
// ============================================================================
#ifndef NDEBUG
#define NDEBUG 1
#endif
#ifndef SWIFT_STDLIB_HAS_TYPE_PRINTING
#define SWIFT_STDLIB_HAS_TYPE_PRINTING 1
#endif
#ifndef __STDC_HOSTED__
#define __STDC_HOSTED__ 1
#endif

static inline void* malloc(size_t sz) { return hex_swift_demangle_detail::arena_alloc(sz, 8u); }
static inline void* calloc(size_t n, size_t sz) { return hex_swift_demangle_detail::arena_calloc(n, sz); }
static inline void  free(void*) {}
static inline void* memcpy(void* dst, const void* src, size_t n) { hex::mem_copy(dst, src, n); return dst; }
static inline void* memmove(void* dst, const void* src, size_t n) { hex::mem_move(dst, src, n); return dst; }
static inline void* memset(void* dst, int v, size_t n) { hex::mem_set(dst, static_cast<uint8_t>(v), n); return dst; }
static inline int   memcmp(const void* a, const void* b, size_t n) { return hex_swift_demangle_detail::c_memcmp(a, b, n); }
extern "C" __attribute__((weak)) size_t strlen(const char* s) { return hex_swift_demangle_detail::c_strlen(s); }
static inline int   strcmp(const char* a, const char* b) {
  while (*a && *a == *b) { ++a; ++b; }
  return static_cast<int>(static_cast<unsigned char>(*a)) - static_cast<int>(static_cast<unsigned char>(*b));
}
static inline int   strncmp(const char* a, const char* b, size_t n) {
  for (size_t i = 0u; i < n; ++i) {
    if (a[i] != b[i] || a[i] == '\0') {
      return static_cast<int>(static_cast<unsigned char>(a[i])) - static_cast<int>(static_cast<unsigned char>(b[i]));
    }
  }
  return 0;
}
static inline const void* memchr(const void* s, int c, size_t n) {
  const uint8_t* p = static_cast<const uint8_t*>(s);
  const uint8_t target = static_cast<uint8_t>(c);
  for (size_t i = 0u; i < n; ++i) {
    if (p[i] == target) return p + i;
  }
  return nullptr;
}

__attribute__((weak)) void* operator new(size_t sz) { return hex_swift_demangle_detail::arena_alloc(sz, 8u); }
__attribute__((weak)) void* operator new[](size_t sz) { return hex_swift_demangle_detail::arena_alloc(sz, 8u); }
inline void* operator new(size_t, void* p) noexcept { return p; }
inline void* operator new[](size_t, void* p) noexcept { return p; }
__attribute__((weak)) void  operator delete(void*) noexcept {}
__attribute__((weak)) void  operator delete(void*, size_t) noexcept {}
__attribute__((weak)) void  operator delete[](void*) noexcept {}
__attribute__((weak)) void  operator delete[](void*, size_t) noexcept {}

#ifndef assert
#define assert(x) ((void)0)
#endif

static void* const stderr = nullptr;
static inline int fprintf(void*, const char*, ...) { return 0; }
static inline int snprintf(char* buf, size_t cap, const char* fmt, unsigned long long v) {
  if (!buf || cap == 0u) return 0;
  bool is_hex = (fmt && fmt[0] == '%' && fmt[1] == 'l' && fmt[2] == 'l' && (fmt[3] == 'X' || fmt[3] == 'x'));
  bool upper = (fmt && fmt[3] == 'X');
  const char* digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
  unsigned long long base = is_hex ? 16ULL : 10ULL;
  char tmp[24];
  size_t n = 0u;
  do { tmp[n++] = digits[v % base]; v /= base; } while (v != 0ULL);
  size_t pos = 0u;
  while (n > 0u && pos + 1u < cap) buf[pos++] = tmp[--n];
  buf[pos] = '\0';
  return static_cast<int>(pos);
}
static inline int snprintf(char* buf, size_t cap, const char* fmt, long long v) {
  if (!buf || cap == 0u) return 0;
  size_t pos = 0u;
  unsigned long long uv;
  if (v < 0) {
    if (pos + 1u < cap) buf[pos++] = '-';
    uv = static_cast<unsigned long long>(-(v + 1)) + 1ULL;
  } else {
    uv = static_cast<unsigned long long>(v);
  }
  return static_cast<int>(pos) + snprintf(buf + pos, cap - pos, "%llu", uv);
}

namespace std {

using ::size_t;
using ::ptrdiff_t;
using ::int8_t;
using ::uint8_t;
using ::int16_t;
using ::uint16_t;
using ::int32_t;
using ::uint32_t;
using ::int64_t;
using ::uint64_t;
using ::uintptr_t;
using ::intptr_t;

[[noreturn]] inline void abort() noexcept { __builtin_trap(); }

template <class T> struct remove_reference { using type = T; };
template <class T> struct remove_reference<T&> { using type = T; };
template <class T> struct remove_reference<T&&> { using type = T; };
template <class T> using remove_reference_t = typename remove_reference<T>::type;

template <class T> struct remove_cv { using type = T; };
template <class T> struct remove_cv<const T> { using type = T; };
template <class T> struct remove_cv<volatile T> { using type = T; };
template <class T> struct remove_cv<const volatile T> { using type = T; };
template <class T> using remove_cv_t = typename remove_cv<T>::type;

template <class T, T v>
struct integral_constant {
  static constexpr T value = v;
  using value_type = T;
  using type = integral_constant;
  constexpr operator value_type() const noexcept { return value; }
};
using true_type = integral_constant<bool, true>;
using false_type = integral_constant<bool, false>;

template <bool B, class T = void> struct enable_if {};
template <class T> struct enable_if<true, T> { using type = T; };
template <bool B, class T = void> using enable_if_t = typename enable_if<B, T>::type;

template <class T, class U> struct is_same : false_type {};
template <class T> struct is_same<T, T> : true_type {};

template <class T> struct is_signed : integral_constant<bool, (T(-1) < T(0))> {};
template <class T> struct is_unsigned : integral_constant<bool, (T(0) < T(-1))> {};

template <class T> struct make_unsigned { using type = T; };
template <> struct make_unsigned<char> { using type = unsigned char; };
template <> struct make_unsigned<signed char> { using type = unsigned char; };
template <> struct make_unsigned<short> { using type = unsigned short; };
template <> struct make_unsigned<int> { using type = unsigned int; };
template <> struct make_unsigned<long> { using type = unsigned long; };
template <> struct make_unsigned<long long> { using type = unsigned long long; };
template <class T> using make_unsigned_t = typename make_unsigned<T>::type;

template <class T> struct is_trivially_destructible : integral_constant<bool, __is_trivially_destructible(T)> {};

template <class T>
constexpr remove_reference_t<T>&& move(T&& t) noexcept {
  return static_cast<remove_reference_t<T>&&>(t);
}
template <class T>
constexpr T&& forward(remove_reference_t<T>& t) noexcept {
  return static_cast<T&&>(t);
}
template <class T>
constexpr T&& forward(remove_reference_t<T>&& t) noexcept {
  return static_cast<T&&>(t);
}

template <class T>
constexpr const T& min(const T& a, const T& b) { return (b < a) ? b : a; }
template <class T>
constexpr const T& max(const T& a, const T& b) { return (a < b) ? b : a; }
template <class T>
inline void swap(T& a, T& b) noexcept {
  T tmp = move(a);
  a = move(b);
  b = move(tmp);
}

template <class It>
inline void reverse(It first, It last) {
  while ((first != last) && (first != --last)) {
    swap(*first++, *last);
  }
}

template <class InIt, class OutIt>
inline OutIt copy(InIt first, InIt last, OutIt d_first) {
  while (first != last) *d_first++ = *first++;
  return d_first;
}

template <class InIt, class Pred>
inline InIt find_if(InIt first, InIt last, Pred p) {
  for (; first != last; ++first) {
    if (p(*first)) return first;
  }
  return last;
}

template <class T> struct numeric_limits;
template <> struct numeric_limits<int> {
  static constexpr int min() noexcept { return INT_MIN; }
  static constexpr int max() noexcept { return INT_MAX; }
};
template <> struct numeric_limits<unsigned int> {
  static constexpr unsigned int min() noexcept { return 0u; }
  static constexpr unsigned int max() noexcept { return UINT_MAX; }
};
template <> struct numeric_limits<int64_t> {
  static constexpr int64_t min() noexcept { return INT64_MIN; }
  static constexpr int64_t max() noexcept { return INT64_MAX; }
};
template <> struct numeric_limits<uint64_t> {
  static constexpr uint64_t min() noexcept { return 0ULL; }
  static constexpr uint64_t max() noexcept { return UINT64_MAX; }
};
template <> struct numeric_limits<size_t> {
  static constexpr size_t min() noexcept { return 0u; }
  static constexpr size_t max() noexcept { return SIZE_MAX; }
};


template <class T1, class T2>
struct pair {
  T1 first;
  T2 second;
  constexpr pair() : first(), second() {}
  constexpr pair(const T1& a, const T2& b) : first(a), second(b) {}
  template <class U1, class U2>
  constexpr pair(U1&& a, U2&& b) : first(forward<U1>(a)), second(forward<U2>(b)) {}
};

template <class T1, class T2>
constexpr pair<remove_cv_t<remove_reference_t<T1>>, remove_cv_t<remove_reference_t<T2>>>
make_pair(T1&& a, T2&& b) {
  return {forward<T1>(a), forward<T2>(b)};
}

template <class T1, class T2>
struct tuple {
  T1 first;
  T2 second;
  constexpr tuple() : first(), second() {}
  constexpr tuple(const T1& a, const T2& b) : first(a), second(b) {}
  template <class U1, class U2>
  constexpr tuple(const pair<U1, U2>& p) : first(p.first), second(p.second) {}
};
template <size_t I, class T1, class T2> struct tuple_get_helper;
template <class T1, class T2> struct tuple_get_helper<0, T1, T2> {
  static constexpr T1& get(tuple<T1, T2>& t) noexcept { return t.first; }
  static constexpr const T1& get(const tuple<T1, T2>& t) noexcept { return t.first; }
};
template <class T1, class T2> struct tuple_get_helper<1, T1, T2> {
  static constexpr T2& get(tuple<T1, T2>& t) noexcept { return t.second; }
  static constexpr const T2& get(const tuple<T1, T2>& t) noexcept { return t.second; }
};
template <size_t I, class T1, class T2>
constexpr auto& get(tuple<T1, T2>& t) noexcept { return tuple_get_helper<I, T1, T2>::get(t); }
template <size_t I, class T1, class T2>
constexpr const auto& get(const tuple<T1, T2>& t) noexcept { return tuple_get_helper<I, T1, T2>::get(t); }

struct nullopt_t { explicit constexpr nullopt_t(int) {} };
inline constexpr nullopt_t nullopt{0};

template <class T>
class optional {
  alignas(T) uint8_t storage_[sizeof(T)];
  bool has_ = false;
  T* ptr() noexcept { return reinterpret_cast<T*>(storage_); }
  const T* ptr() const noexcept { return reinterpret_cast<const T*>(storage_); }
 public:
  optional() noexcept : has_(false) {}
  optional(nullopt_t) noexcept : has_(false) {}
  optional(const T& v) : has_(true) { new (storage_) T(v); }
  optional(T&& v) : has_(true) { new (storage_) T(move(v)); }
  optional(const optional& o) : has_(o.has_) { if (has_) new (storage_) T(*o.ptr()); }
  optional(optional&& o) noexcept : has_(o.has_) { if (has_) new (storage_) T(move(*o.ptr())); }
  ~optional() { reset(); }
  optional& operator=(nullopt_t) noexcept { reset(); return *this; }
  optional& operator=(const T& v) { reset(); new (storage_) T(v); has_ = true; return *this; }
  optional& operator=(T&& v) { reset(); new (storage_) T(move(v)); has_ = true; return *this; }
  optional& operator=(const optional& o) {
    if (this != &o) { reset(); if (o.has_) { new (storage_) T(*o.ptr()); has_ = true; } }
    return *this;
  }
  optional& operator=(optional&& o) noexcept {
    if (this != &o) { reset(); if (o.has_) { new (storage_) T(move(*o.ptr())); has_ = true; } }
    return *this;
  }
  void reset() noexcept { if (has_) { ptr()->~T(); has_ = false; } }
  bool has_value() const noexcept { return has_; }
  explicit operator bool() const noexcept { return has_; }
  T& operator*() noexcept { return *ptr(); }
  const T& operator*() const noexcept { return *ptr(); }
  T* operator->() noexcept { return ptr(); }
  const T* operator->() const noexcept { return ptr(); }
  T& value() noexcept { return *ptr(); }
  const T& value() const noexcept { return *ptr(); }
};

class string {
  char*  data_ = nullptr;
  size_t size_ = 0u;
  size_t cap_  = 0u;

  static char* empty_cstr() noexcept {
    static char z = '\0';
    return &z;
  }

  void ensure(size_t need) {
    if (need + 1u <= cap_) return;
    size_t new_cap = cap_ ? cap_ * 2u : 32u;
    while (new_cap < need + 1u) new_cap *= 2u;
    char* nb = static_cast<char*>(hex_swift_demangle_detail::arena_alloc(new_cap, 8u));
    if (!nb) return;
    if (data_ && size_ > 0u) hex::mem_copy(nb, data_, size_);
    nb[size_] = '\0';
    data_ = nb;
    cap_ = new_cap;
  }

 public:
  static constexpr size_t npos = static_cast<size_t>(-1);
  using value_type = char;
  using iterator = char*;
  using const_iterator = const char*;

  string() noexcept = default;
  string(const char* s) { if (s) append(s, hex_swift_demangle_detail::c_strlen(s)); }
  string(const char* s, size_t n) { if (s && n) append(s, n); }
  string(size_t n, char c) {
    if (n) {
      ensure(n);
      if (data_ && cap_ > n) {
        hex::mem_set(data_, static_cast<uint8_t>(c), n);
        size_ = n;
        data_[size_] = '\0';
      }
    }
  }
  string(const string& o) { if (o.size_) append(o.data_, o.size_); }
  string(string&& o) noexcept : data_(o.data_), size_(o.size_), cap_(o.cap_) {
    o.data_ = nullptr; o.size_ = 0u; o.cap_ = 0u;
  }
  string& operator=(const string& o) {
    if (this != &o) { clear(); if (o.size_) append(o.data_, o.size_); }
    return *this;
  }
  string& operator=(string&& o) noexcept {
    if (this != &o) { data_ = o.data_; size_ = o.size_; cap_ = o.cap_; o.data_ = nullptr; o.size_ = 0u; o.cap_ = 0u; }
    return *this;
  }
  string& operator=(const char* s) { clear(); if (s) append(s, hex_swift_demangle_detail::c_strlen(s)); return *this; }

  const char* c_str() const noexcept { return data_ ? data_ : empty_cstr(); }
  const char* data() const noexcept { return data_ ? data_ : empty_cstr(); }
  char* data() noexcept { return data_ ? data_ : empty_cstr(); }
  size_t size() const noexcept { return size_; }
  size_t length() const noexcept { return size_; }
  bool empty() const noexcept { return size_ == 0u; }
  void clear() noexcept { size_ = 0u; if (data_) data_[0] = '\0'; }
  void reserve(size_t n) { ensure(n); }
  void resize(size_t n, char c = '\0') {
    if (n > size_) {
      ensure(n);
      if (data_ && cap_ > n) {
        hex::mem_set(data_ + size_, static_cast<uint8_t>(c), n - size_);
        size_ = n;
        data_[size_] = '\0';
      }
    } else {
      size_ = n;
      if (data_) data_[size_] = '\0';
    }
  }
  void pop_back() noexcept { if (size_ > 0u) { --size_; data_[size_] = '\0'; } }
  char& back() noexcept { return data_[size_ - 1u]; }
  char back() const noexcept { return data_[size_ - 1u]; }
  char& front() noexcept { return data_[0]; }
  char front() const noexcept { return data_[0]; }
  char& operator[](size_t i) noexcept { return data_[i]; }
  char operator[](size_t i) const noexcept { return data_[i]; }
  iterator begin() noexcept { return data_; }
  iterator end() noexcept { return data_ ? data_ + size_ : nullptr; }
  const_iterator begin() const noexcept { return data_; }
  const_iterator end() const noexcept { return data_ ? data_ + size_ : nullptr; }

  void push_back(char c) {
    ensure(size_ + 1u);
    if (data_ && size_ + 1u < cap_) {
      data_[size_++] = c;
      data_[size_] = '\0';
    }
  }
  string& append(const char* s, size_t n) {
    if (!s || n == 0u) return *this;
    ensure(size_ + n);
    if (data_ && size_ + n < cap_) {
      hex::mem_copy(data_ + size_, s, n);
      size_ += n;
      data_[size_] = '\0';
    }
    return *this;
  }
  string& append(const char* s) { return append(s, hex_swift_demangle_detail::c_strlen(s)); }
  string& append(const string& o) { return append(o.data(), o.size()); }
  string& append(size_t n, char c) {
    for (size_t i = 0u; i < n; ++i) push_back(c);
    return *this;
  }
  string& operator+=(char c) { push_back(c); return *this; }
  string& operator+=(const char* s) { return append(s); }
  string& operator+=(const string& o) { return append(o); }

  string substr(size_t pos = 0u, size_t count = npos) const {
    if (pos >= size_) return string();
    size_t n = size_ - pos;
    if (count < n) n = count;
    return string(data() + pos, n);
  }
  size_t find(char c, size_t pos = 0u) const noexcept {
    for (size_t i = pos; i < size_; ++i) if (data_[i] == c) return i;
    return npos;
  }
  friend string operator+(const string& a, const string& b) {
    string r; r.reserve(a.size() + b.size()); r.append(a); r.append(b); return r;
  }
  friend string operator+(const string& a, const char* b) {
    string r(a); r.append(b); return r;
  }
  friend string operator+(const char* a, const string& b) {
    string r(a); r.append(b); return r;
  }
  friend bool operator==(const string& a, const string& b) noexcept {
    return a.size_ == b.size_ && (a.size_ == 0u || hex_swift_demangle_detail::c_memcmp(a.data(), b.data(), a.size_) == 0);
  }
  friend bool operator!=(const string& a, const string& b) noexcept { return !(a == b); }
  friend bool operator==(const string& a, const char* b) noexcept {
    const size_t bl = hex_swift_demangle_detail::c_strlen(b);
    return a.size_ == bl && (bl == 0u || hex_swift_demangle_detail::c_memcmp(a.data(), b, bl) == 0);
  }
  friend bool operator!=(const string& a, const char* b) noexcept { return !(a == b); }
};

inline string to_string(uint64_t v) {
  char buf[24];
  size_t n = 0u;
  do { buf[n++] = static_cast<char>('0' + (v % 10u)); v /= 10u; } while (v != 0u);
  string r;
  r.reserve(n);
  while (n > 0u) r.push_back(buf[--n]);
  return r;
}
inline string to_string(int64_t v) {
  if (v < 0) return string("-") + to_string(static_cast<uint64_t>(-(v + 1)) + 1ULL);
  return to_string(static_cast<uint64_t>(v));
}
inline string to_string(unsigned v) { return to_string(static_cast<uint64_t>(v)); }
inline string to_string(int v) { return to_string(static_cast<int64_t>(v)); }

template <class E>
class initializer_list {
  const E* begin_;
  size_t   size_;
  constexpr initializer_list(const E* b, size_t s) noexcept : begin_(b), size_(s) {}
 public:
  using value_type = E;
  using const_iterator = const E*;
  using iterator = const E*;
  constexpr initializer_list() noexcept : begin_(nullptr), size_(0u) {}
  constexpr size_t size() const noexcept { return size_; }
  constexpr const E* begin() const noexcept { return begin_; }
  constexpr const E* end() const noexcept { return begin_ + size_; }
};

template <class T>
class vector {
  T*     data_ = nullptr;
  size_t size_ = 0u;
  size_t cap_  = 0u;

  void grow(size_t min_cap) {
    size_t nc = cap_ ? cap_ * 2u : 8u;
    while (nc < min_cap) nc *= 2u;
    T* nb = static_cast<T*>(hex_swift_demangle_detail::arena_alloc(nc * sizeof(T), alignof(T)));
    if (!nb) return;
    for (size_t i = 0u; i < size_; ++i) new (nb + i) T(move(data_[i]));
    data_ = nb;
    cap_ = nc;
  }

 public:
  using value_type = T;
  using iterator = T*;
  using const_iterator = const T*;

  vector() noexcept = default;
  vector(initializer_list<T> il) {
    if (il.size()) {
      grow(il.size());
      if (data_ && cap_ >= il.size()) {
        for (const auto& item : il) new (data_ + size_++) T(item);
      }
    }
  }
  vector(const vector& o) {
    if (o.size_) {
      grow(o.size_);
      if (data_ && cap_ >= o.size_) {
        for (size_t i = 0u; i < o.size_; ++i) new (data_ + i) T(o.data_[i]);
        size_ = o.size_;
      }
    }
  }
  vector(vector&& o) noexcept : data_(o.data_), size_(o.size_), cap_(o.cap_) {
    o.data_ = nullptr; o.size_ = 0u; o.cap_ = 0u;
  }
  vector& operator=(const vector& o) {
    if (this != &o) {
      clear();
      if (o.size_) {
        if (cap_ < o.size_) grow(o.size_);
        if (data_ && cap_ >= o.size_) {
          for (size_t i = 0u; i < o.size_; ++i) new (data_ + i) T(o.data_[i]);
          size_ = o.size_;
        }
      }
    }
    return *this;
  }
  vector& operator=(vector&& o) noexcept {
    if (this != &o) { data_ = o.data_; size_ = o.size_; cap_ = o.cap_; o.data_ = nullptr; o.size_ = 0u; o.cap_ = 0u; }
    return *this;
  }
  void clear() noexcept { size_ = 0u; }
  bool empty() const noexcept { return size_ == 0u; }
  size_t size() const noexcept { return size_; }
  void reserve(size_t n) { if (n > cap_) grow(n); }
  void push_back(const T& v) {
    if (size_ >= cap_) grow(size_ + 1u);
    if (data_ && size_ < cap_) new (data_ + size_++) T(v);
  }
  void push_back(T&& v) {
    if (size_ >= cap_) grow(size_ + 1u);
    if (data_ && size_ < cap_) new (data_ + size_++) T(move(v));
  }
  template <class... Args>
  void emplace_back(Args&&... args) {
    if (size_ >= cap_) grow(size_ + 1u);
    if (data_ && size_ < cap_) new (data_ + size_++) T(forward<Args>(args)...);
  }
  void pop_back() noexcept { if (size_ > 0u) --size_; }
  iterator insert(iterator pos, const T& v) {
    size_t idx = data_ ? static_cast<size_t>(pos - data_) : 0u;
    if (idx > size_) idx = size_;
    if (size_ >= cap_) grow(size_ + 1u);
    if (!data_ || size_ >= cap_) return end();
    for (size_t i = size_; i > idx; --i) {
      new (data_ + i) T(move(data_[i - 1u]));
    }
    new (data_ + idx) T(v);
    ++size_;
    return data_ + idx;
  }
  void resize(size_t n) {
    if (n > cap_) grow(n);
    if (!data_ || n > cap_) return;
    for (size_t i = size_; i < n; ++i) new (data_ + i) T();
    size_ = n;
  }
  T& back() noexcept { return data_[size_ - 1u]; }
  const T& back() const noexcept { return data_[size_ - 1u]; }
  T& front() noexcept { return data_[0]; }
  const T& front() const noexcept { return data_[0]; }
  T& operator[](size_t i) noexcept { return data_[i]; }
  const T& operator[](size_t i) const noexcept { return data_[i]; }
  T* data() noexcept { return data_; }
  const T* data() const noexcept { return data_; }
  iterator begin() noexcept { return data_; }
  iterator end() noexcept { return data_ ? data_ + size_ : nullptr; }
  const_iterator begin() const noexcept { return data_; }
  const_iterator end() const noexcept { return data_ ? data_ + size_ : nullptr; }
  struct reverse_iterator {
    T* p;
    T& operator*() const noexcept { return *(p - 1); }
    T* operator->() const noexcept { return p - 1; }
    reverse_iterator& operator++() noexcept { --p; return *this; }
    reverse_iterator operator++(int) noexcept { auto t = *this; --p; return t; }
    bool operator==(const reverse_iterator& o) const noexcept { return p == o.p; }
    bool operator!=(const reverse_iterator& o) const noexcept { return p != o.p; }
  };
  struct const_reverse_iterator {
    const T* p;
    const T& operator*() const noexcept { return *(p - 1); }
    const T* operator->() const noexcept { return p - 1; }
    const_reverse_iterator& operator++() noexcept { --p; return *this; }
    const_reverse_iterator operator++(int) noexcept { auto t = *this; --p; return t; }
    bool operator==(const const_reverse_iterator& o) const noexcept { return p == o.p; }
    bool operator!=(const const_reverse_iterator& o) const noexcept { return p != o.p; }
  };
  reverse_iterator rbegin() noexcept { return {data_ ? data_ + size_ : nullptr}; }
  reverse_iterator rend() noexcept { return {data_}; }
  const_reverse_iterator rbegin() const noexcept { return {data_ ? data_ + size_ : nullptr}; }
  const_reverse_iterator rend() const noexcept { return {data_}; }
};

template <class Sig> class function;
template <class R, class... Args>
class function<R(Args...)> {
  using FnPtr = R(*)(void*, Args...);
  void* obj_ = nullptr;
  FnPtr fn_  = nullptr;

  template <class F>
  static R invoke_fn(void* p, Args... args) {
    return (*static_cast<F*>(p))(forward<Args>(args)...);
  }
  static R invoke_raw(void* p, Args... args) {
    return reinterpret_cast<R(*)(Args...)>(p)(forward<Args>(args)...);
  }

 public:
  function() noexcept = default;
  function(decltype(nullptr)) noexcept {}
  function(R(*raw)(Args...)) noexcept : obj_(reinterpret_cast<void*>(raw)), fn_(raw ? &invoke_raw : nullptr) {}
  template <class F, class = enable_if_t<!is_same<remove_cv_t<remove_reference_t<F>>, function>::value>>
  function(F&& f) {
    using DecayF = remove_cv_t<remove_reference_t<F>>;
    void* mem = hex_swift_demangle_detail::arena_alloc(sizeof(DecayF), alignof(DecayF));
    if (mem) {
      new (mem) DecayF(forward<F>(f));
      obj_ = mem;
      fn_ = &invoke_fn<DecayF>;
    }
  }
  explicit operator bool() const noexcept { return fn_ != nullptr; }
  R operator()(Args... args) const { return fn_(obj_, forward<Args>(args)...); }
};

}  // namespace std

// ============================================================================
// 3. Minimal llvm:: Shim (StringRef, Align, function_ref, interleave, macros)
// ============================================================================
#define LLVM_LIKELY(x)   __builtin_expect(!!(x), 1)
#define LLVM_UNLIKELY(x) __builtin_expect(!!(x), 0)
#define LLVM_FALLTHROUGH [[fallthrough]]
#define LLVM_ATTRIBUTE_ALWAYS_INLINE __attribute__((always_inline))
#define LLVM_ATTRIBUTE_NOINLINE __attribute__((noinline))
#define LLVM_READONLY __attribute__((pure))
#define LLVM_READNONE __attribute__((const))
#define LLVM_NODISCARD [[nodiscard]]
#define LLVM_UNREACHABLE __builtin_unreachable()
#define llvm_unreachable(msg) __builtin_unreachable()
#define LLVM_EXTERNAL_VISIBILITY
#define LLVM_ATTRIBUTE_USED

#ifndef SWIFT_BASIC_STLEXTRAS_H
#define SWIFT_BASIC_STLEXTRAS_H
#endif

namespace llvm {

struct Align {
  size_t value_ = 1u;
  constexpr Align() = default;
  constexpr explicit Align(size_t v) : value_(v ? v : 1u) {}
  constexpr size_t value() const noexcept { return value_; }
  template <class T>
  static constexpr Align Of() noexcept { return Align(alignof(T)); }
};

inline uintptr_t alignAddr(const void* Addr, Align Alignment) {
  const uintptr_t a = reinterpret_cast<uintptr_t>(Addr);
  const uintptr_t m = Alignment.value() - 1u;
  return (a + m) & ~m;
}

inline size_t offsetToAlignedAddr(const void* Addr, Align Alignment) {
  const uintptr_t a = reinterpret_cast<uintptr_t>(Addr);
  return static_cast<size_t>(alignAddr(Addr, Alignment) - a);
}

class StringRef {
  const char* Data = nullptr;
  size_t Length = 0u;

 public:
  static constexpr size_t npos = static_cast<size_t>(-1);
  using iterator = const char*;
  using const_iterator = const char*;

  constexpr StringRef() = default;
  constexpr StringRef(decltype(nullptr)) = delete;
  constexpr StringRef(const char* Str)
      : Data(Str), Length(Str ? __builtin_strlen(Str) : 0u) {}
  constexpr StringRef(const char* data, size_t length) : Data(data), Length(length) {}
  StringRef(const std::string& Str) : Data(Str.data()), Length(Str.size()) {}

  constexpr const char* data() const noexcept { return Data; }
  constexpr size_t size() const noexcept { return Length; }
  constexpr bool empty() const noexcept { return Length == 0u; }
  constexpr const char* begin() const noexcept { return Data; }
  constexpr const char* end() const noexcept { return Data + Length; }
  constexpr char front() const noexcept { return Data[0]; }
  constexpr char back() const noexcept { return Data[Length - 1u]; }
  constexpr char operator[](size_t i) const noexcept { return Data[i]; }

  std::string str() const { return std::string(Data, Length); }
  operator std::string() const { return str(); }
  template <typename Allocator>
  StringRef copy(Allocator& A) const {
    if (empty()) return StringRef();
    char* S = A.template Allocate<char>(Length);
    if (!S) return StringRef();
    hex::mem_copy(S, Data, Length);
    return StringRef(S, Length);
  }

  bool equals(StringRef RHS) const noexcept {
    return Length == RHS.Length && (Length == 0u || hex_swift_demangle_detail::c_memcmp(Data, RHS.Data, Length) == 0);
  }
  bool starts_with(StringRef Prefix) const noexcept {
    return Length >= Prefix.Length && (Prefix.Length == 0u || hex_swift_demangle_detail::c_memcmp(Data, Prefix.Data, Prefix.Length) == 0);
  }
  bool startswith(StringRef Prefix) const noexcept { return starts_with(Prefix); }
  bool ends_with(StringRef Suffix) const noexcept {
    return Length >= Suffix.Length && (Suffix.Length == 0u || hex_swift_demangle_detail::c_memcmp(Data + Length - Suffix.Length, Suffix.Data, Suffix.Length) == 0);
  }
  bool endswith(StringRef Suffix) const noexcept { return ends_with(Suffix); }

  StringRef substr(size_t Start, size_t N = npos) const noexcept {
    Start = Start < Length ? Start : Length;
    size_t avail = Length - Start;
    return StringRef(Data + Start, N < avail ? N : avail);
  }
  StringRef slice(size_t Start, size_t End) const noexcept {
    Start = Start < Length ? Start : Length;
    End = End < Length ? End : Length;
    if (End < Start) End = Start;
    return StringRef(Data + Start, End - Start);
  }
  StringRef drop_front(size_t N = 1u) const noexcept { return substr(N); }
  StringRef drop_back(size_t N = 1u) const noexcept { return substr(0u, N >= Length ? 0u : Length - N); }
  template <class Pred>
  StringRef drop_while(Pred F) const {
    size_t i = 0u;
    while (i < Length && F(Data[i])) ++i;
    return substr(i);
  }
  template <class Pred>
  StringRef take_while(Pred F) const {
    size_t i = 0u;
    while (i < Length && F(Data[i])) ++i;
    return substr(0u, i);
  }
  StringRef take_front(size_t N = 1u) const noexcept { return substr(0u, N); }
  StringRef take_back(size_t N = 1u) const noexcept { return N >= Length ? *this : substr(Length - N, N); }
  size_t find_last_of(char C) const noexcept { return rfind(C); }
  size_t find_first_of(char C, size_t From = 0u) const noexcept { return find(C, From); }
  bool consume_front(StringRef Prefix) noexcept {
    if (!starts_with(Prefix)) return false;
    Data += Prefix.Length;
    Length -= Prefix.Length;
    return true;
  }
  bool consume_back(StringRef Suffix) noexcept {
    if (!ends_with(Suffix)) return false;
    Length -= Suffix.Length;
    return true;
  }

  size_t find(char C, size_t From = 0u) const noexcept {
    for (size_t i = From; i < Length; ++i) if (Data[i] == C) return i;
    return npos;
  }
  size_t find(StringRef Str, size_t From = 0u) const noexcept {
    if (Str.Length == 0u) return From <= Length ? From : npos;
    if (From >= Length || Str.Length > Length - From) return npos;
    for (size_t i = From; i <= Length - Str.Length; ++i) {
      if (hex_swift_demangle_detail::c_memcmp(Data + i, Str.Data, Str.Length) == 0) return i;
    }
    return npos;
  }
  size_t rfind(char C) const noexcept {
    for (size_t i = Length; i > 0u; --i) if (Data[i - 1u] == C) return i - 1u;
    return npos;
  }
  bool contains(char C) const noexcept { return find(C) != npos; }
  bool contains(StringRef S) const noexcept { return find(S) != npos; }

  std::pair<StringRef, StringRef> split(char Separator) const noexcept {
    size_t idx = find(Separator);
    if (idx == npos) return {*this, StringRef()};
    return {slice(0u, idx), slice(idx + 1u, npos)};
  }

  friend bool operator==(StringRef LHS, StringRef RHS) noexcept { return LHS.equals(RHS); }
  friend bool operator!=(StringRef LHS, StringRef RHS) noexcept { return !LHS.equals(RHS); }
};

class StringLiteral : public StringRef {
 public:
  template <size_t N>
  constexpr StringLiteral(const char (&Str)[N]) : StringRef(Str, N - 1u) {}
};

template <class Sig> class function_ref;
template <class R, class... Args>
class function_ref<R(Args...)> {
  R(*callback_)(intptr_t, Args...) = nullptr;
  intptr_t callable_ = 0;

  template <class F>
  static R callback_fn(intptr_t c, Args... args) {
    return (*reinterpret_cast<F*>(c))(std::forward<Args>(args)...);
  }

 public:
  function_ref() = default;
  function_ref(decltype(nullptr)) {}
  template <class F, class = std::enable_if_t<!std::is_same<std::remove_cv_t<std::remove_reference_t<F>>, function_ref>::value>>
  function_ref(F&& f) noexcept
      : callback_(&callback_fn<std::remove_reference_t<F>>),
        callable_(reinterpret_cast<intptr_t>(&f)) {}
  explicit operator bool() const noexcept { return callback_ != nullptr; }
  R operator()(Args... args) const { return callback_(callable_, std::forward<Args>(args)...); }
};

template <class ForwardIt, class UnaryFn, class NullaryFn>
inline void interleave(ForwardIt begin, ForwardIt end, UnaryFn each_fn, NullaryFn between_fn) {
  if (begin == end) return;
  each_fn(*begin);
  ++begin;
  for (; begin != end; ++begin) {
    between_fn();
    each_fn(*begin);
  }
}

template <class Container, class UnaryFn, class NullaryFn>
inline void interleave(const Container& c, UnaryFn each_fn, NullaryFn between_fn) {
  auto it = c.begin();
  auto end = c.end();
  if (it == end) return;
  each_fn(*it);
  ++it;
  for (; it != end; ++it) {
    between_fn();
    each_fn(*it);
  }
}

}  // namespace llvm

namespace swift {
template <class Range, class Fn, class BetweenFn>
inline void interleave(const Range& r, Fn fn, BetweenFn between) {
  llvm::interleave(r, fn, between);
}
}  // namespace swift

// ============================================================================
// 4. Include Real Upstream Apple swiftlang/swift Demangling Sources
// ============================================================================
#include "../../third_party/swift-demangle/lib/Demangling/Punycode.cpp"
#include "../../third_party/swift-demangle/lib/Demangling/ManglingUtils.cpp"
#include "../../third_party/swift-demangle/lib/Demangling/Ownership.cpp"
#include "../../third_party/swift-demangle/lib/Demangling/Demangler.cpp"
#include "../../third_party/swift-demangle/lib/Demangling/NodePrinter.cpp"

namespace swift {
namespace Demangle {
SWIFT_BEGIN_INLINE_NAMESPACE

void fatal(uint32_t, const char*, ...) {
  __builtin_trap();
}

std::string getNodeTreeAsString(NodePointer) {
  return std::string();
}

ManglingErrorOr<std::string> mangleNode(NodePointer, Mangle::ManglingFlavor) {
  return ManglingError(ManglingError::UnsupportedNodeKind, nullptr, 0);
}

std::string demangleSymbolAsString(const char* mangledName, size_t mangledNameLength, const DemangleOptions& options) {
  if (!mangledName || mangledNameLength == 0u) return std::string();
  Demangler dem;
  NodePointer root = dem.demangleSymbol(llvm::StringRef(mangledName, mangledNameLength));
  if (!root) return std::string(mangledName, mangledNameLength);
  return nodeToString(root, options);
}

SWIFT_END_INLINE_NAMESPACE
}  // namespace Demangle
}  // namespace swift



// ============================================================================
// 5. Internal C Bridge Called by llvm_demangle_wasm.cpp
// ============================================================================
extern "C" int32_t hex_demangle_swift_impl(
    const uint8_t* in_ptr,
    uint32_t in_len,
    uint8_t* out_ptr,
    uint32_t out_cap,
    uint32_t* out_len) {
  if (!in_ptr || !out_ptr || !out_len || in_len == 0u || out_cap == 0u) {
    if (out_len) *out_len = 0u;
    if (out_ptr && out_cap > 0u) out_ptr[0] = '\0';
    return HEX_ERR_INVALID_ARG;
  }
  *out_len = 0u;
  out_ptr[0] = '\0';

  if (in_len > hex_swift_demangle_detail::kMaxSwiftInputLen) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  hex_swift_demangle_detail::reset_arena();

  llvm::StringRef mangled(reinterpret_cast<const char*>(in_ptr), in_len);
  swift::Demangle::Demangler dem;
  swift::Demangle::NodePointer root = dem.demangleSymbol(mangled);
  if (hex_swift_demangle_detail::g_swift_arena_oom) {
    return HEX_ERR_OOM;
  }
  if (!root) {
    return HEX_ERR_INVALID_ARG;
  }

  swift::Demangle::DemangleOptions opts;
  opts.SynthesizeSugarOnTypes = true;
  opts.DisplayStdlibModule = false;
  opts.DisplayObjCModule = false;

  std::string result = swift::Demangle::nodeToString(root, opts);
  if (hex_swift_demangle_detail::g_swift_arena_oom) {
    return HEX_ERR_OOM;
  }
  if (result.empty()) {
    return HEX_ERR_INVALID_ARG;
  }

  const size_t n = result.size();
  const size_t max_copy = static_cast<size_t>(out_cap - 1u);
  const size_t copy_n = n < max_copy ? n : max_copy;
  if (copy_n > 0u) {
    hex::mem_copy(out_ptr, result.data(), copy_n);
  }
  out_ptr[copy_n] = '\0';
  *out_len = static_cast<uint32_t>(copy_n);

  return (n > max_copy) ? HEX_ERR_OOM : HEX_OK;
}
