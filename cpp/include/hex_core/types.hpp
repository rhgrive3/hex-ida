#ifndef HEX_CORE_TYPES_HPP
#define HEX_CORE_TYPES_HPP

#include <stdint.h>
#include <stddef.h>
#include <limits.h>

namespace hex {

inline void mem_copy(void* dst, const void* src, size_t n) {
  if (n == 0) return;
#if defined(__wasm__)
  uint8_t* d = static_cast<uint8_t*>(dst);
  const uint8_t* s = static_cast<const uint8_t*>(src);
  for (size_t i = 0; i < n; ++i) d[i] = s[i];
#else
  __builtin_memcpy(dst, src, n);
#endif
}

inline void mem_move(void* dst, const void* src, size_t n) {
  if (n == 0 || dst == src) return;
#if defined(__wasm__)
  uint8_t* d = static_cast<uint8_t*>(dst);
  const uint8_t* s = static_cast<const uint8_t*>(src);
  if (d < s) {
    for (size_t i = 0; i < n; ++i) d[i] = s[i];
  } else {
    for (size_t i = n; i > 0; --i) d[i - 1] = s[i - 1];
  }
#else
  __builtin_memmove(dst, src, n);
#endif
}

inline void mem_set(void* dst, int val, size_t n) {
  if (n == 0) return;
#if defined(__wasm__)
  uint8_t* d = static_cast<uint8_t*>(dst);
  const uint8_t b = static_cast<uint8_t>(val);
  for (size_t i = 0; i < n; ++i) d[i] = b;
#else
  __builtin_memset(dst, val, n);
#endif
}

inline int mem_cmp(const void* a, const void* b, size_t n) {
  if (n == 0) return 0;
#if defined(__wasm__)
  const uint8_t* pa = static_cast<const uint8_t*>(a);
  const uint8_t* pb = static_cast<const uint8_t*>(b);
  for (size_t i = 0; i < n; ++i) {
    if (pa[i] != pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
#else
  return __builtin_memcmp(a, b, n);
#endif
}

template <typename T>
constexpr const T& min_val(const T& a, const T& b) {
  return (b < a) ? b : a;
}

template <typename T>
constexpr const T& max_val(const T& a, const T& b) {
  return (a < b) ? b : a;
}

template <typename T>
constexpr void swap_val(T& a, T& b) {
  T tmp = static_cast<T&&>(a);
  a = static_cast<T&&>(b);
  b = static_cast<T&&>(tmp);
}

template <typename T>
class Span {
 public:
  constexpr Span() : data_(nullptr), size_(0) {}
  constexpr Span(T* data, size_t size) : data_(data), size_(size) {}
  constexpr T* data() const { return data_; }
  constexpr size_t size() const { return size_; }
  constexpr bool empty() const { return size_ == 0; }
  constexpr T& operator[](size_t i) const { return data_[i]; }
  constexpr T* begin() const { return data_; }
  constexpr T* end() const { return data_ + size_; }
  constexpr Span<T> subspan(size_t offset, size_t count) const {
    if (offset >= size_) return Span<T>();
    const size_t avail = size_ - offset;
    return Span<T>(data_ + offset, count < avail ? count : avail);
  }
 private:
  T* data_;
  size_t size_;
};

}  // namespace hex
#endif
