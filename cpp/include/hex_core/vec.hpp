#ifndef HEX_CORE_VEC_HPP
#define HEX_CORE_VEC_HPP

#include <stdint.h>
#include <stddef.h>
#include "types.hpp"
#include "arena.hpp"

namespace hex {

template <typename T>
class Vec {
 public:
  explicit Vec(Arena* arena = nullptr) : arena_(arena), data_(nullptr), size_(0), cap_(0) {}
  void init(Arena* arena) { arena_ = arena; data_ = nullptr; size_ = 0; cap_ = 0; }
  void clear() { size_ = 0; }
  T* data() { return data_; }
  const T* data() const { return data_; }
  size_t size() const { return size_; }
  size_t capacity() const { return cap_; }
  bool empty() const { return size_ == 0; }
  T& operator[](size_t i) { return data_[i]; }
  const T& operator[](size_t i) const { return data_[i]; }
  T& back() { return data_[size_ - 1]; }
  const T& back() const { return data_[size_ - 1]; }
  T* begin() { return data_; }
  T* end() { return data_ + size_; }
  const T* begin() const { return data_; }
  const T* end() const { return data_ + size_; }
  Span<T> span() { return Span<T>(data_, size_); }
  Span<const T> span() const { return Span<const T>(data_, size_); }

  bool reserve(size_t min_cap) {
    if (min_cap <= cap_) return true;
    if (!arena_) return false;
    size_t new_cap = cap_ == 0 ? 8 : cap_;
    while (new_cap < min_cap) {
      if (new_cap > (static_cast<size_t>(-1) >> 1)) { new_cap = min_cap; break; }
      new_cap <<= 1;
    }
    T* next = arena_->alloc<T>(new_cap);
    if (!next) return false;
    if (size_ > 0) mem_copy(next, data_, size_ * sizeof(T));
    data_ = next;
    cap_ = new_cap;
    return true;
  }

  bool resize(size_t new_size, const T& fill = T{}) {
    if (new_size > cap_ && !reserve(new_size)) return false;
    for (size_t i = size_; i < new_size; ++i) data_[i] = fill;
    size_ = new_size;
    return true;
  }

  bool push_back(const T& value) {
    if (size_ == cap_ && !reserve(cap_ == 0 ? 8 : cap_ * 2)) return false;
    data_[size_++] = value;
    return true;
  }

  void pop_back() { if (size_ > 0) --size_; }

 private:
  Arena* arena_;
  T* data_;
  size_t size_;
  size_t cap_;
};

}  // namespace hex
#endif
