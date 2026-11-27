#ifndef HEX_CORE_STABLE_SORT_HPP
#define HEX_CORE_STABLE_SORT_HPP

#include <stdint.h>
#include <stddef.h>
#include "types.hpp"
#include "arena.hpp"

namespace hex {

template <typename T, typename Compare>
inline bool stable_sort(Arena& arena, T* data, size_t n, Compare cmp) {
  if (n <= 1) return true;
  if (!data) return false;
  constexpr size_t kRun = 16;
  for (size_t start = 0; start < n; ) {
    const size_t end = (n - start > kRun) ? (start + kRun) : n;
    for (size_t i = start + 1; i < end; ++i) {
      T key = data[i];
      size_t j = i;
      while (j > start && cmp(key, data[j - 1])) { data[j] = data[j - 1]; --j; }
      data[j] = key;
    }
    start = end;
  }
  if (n <= kRun) return true;
  ArenaScope scratch_scope(arena);
  T* buf = arena.alloc<T>(n);
  if (!buf) return false;
  T* src = data;
  T* dst = buf;
  for (size_t width = kRun; width < n; ) {
    for (size_t left = 0; left < n; ) {
      const size_t rem = n - left;
      const size_t mid = (rem > width) ? (left + width) : n;
      const size_t rem2 = n - mid;
      const size_t right = (rem2 > width) ? (mid + width) : n;
      size_t i = left, j = mid, k = left;
      while (i < mid && j < right) {
        if (cmp(src[j], src[i])) dst[k++] = src[j++];
        else dst[k++] = src[i++];
      }
      while (i < mid) dst[k++] = src[i++];
      while (j < right) dst[k++] = src[j++];
      left = right;
    }
    swap_val(src, dst);
    if (width > (static_cast<size_t>(-1) >> 1)) break;
    width <<= 1;
  }
  if (src != data) mem_copy(data, src, n * sizeof(T));
  return true;
}

}  // namespace hex
#endif
