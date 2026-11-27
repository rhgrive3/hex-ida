#ifndef HEX_CORE_STRING_VIEW_HPP
#define HEX_CORE_STRING_VIEW_HPP

#include <stdint.h>
#include <stddef.h>
#include "types.hpp"
#include "js_compat.hpp"
#include "arena.hpp"

namespace hex {

class StringView {
 public:
  static constexpr size_t npos = static_cast<size_t>(-1);
  constexpr StringView() : data_(nullptr), size_(0) {}
  constexpr StringView(const char* data, size_t size) : data_(data), size_(size) {}
  constexpr StringView(const char* cstr) : data_(cstr), size_(0) {
    if (cstr) { while (cstr[size_] != '\0') ++size_; }
  }
  constexpr const char* data() const { return data_; }
  constexpr size_t size() const { return size_; }
  constexpr bool empty() const { return size_ == 0; }
  constexpr char operator[](size_t i) const { return data_[i]; }
  constexpr StringView substr(size_t pos, size_t count = npos) const {
    if (pos >= size_) return StringView();
    const size_t avail = size_ - pos;
    return StringView(data_ + pos, count < avail ? count : avail);
  }
  bool starts_with(StringView prefix) const {
    return prefix.size_ <= size_ && mem_cmp(data_, prefix.data_, prefix.size_) == 0;
  }
  bool ends_with(StringView suffix) const {
    return suffix.size_ <= size_ && mem_cmp(data_ + (size_ - suffix.size_), suffix.data_, suffix.size_) == 0;
  }
  size_t find(char ch, size_t pos = 0) const {
    for (size_t i = pos; i < size_; ++i) if (data_[i] == ch) return i;
    return npos;
  }
  size_t find(StringView needle, size_t pos = 0) const {
    if (needle.size_ == 0) return pos <= size_ ? pos : npos;
    if (pos >= size_ || needle.size_ > size_ - pos) return npos;
    const size_t limit = size_ - needle.size_;
    for (size_t i = pos; i <= limit; ++i) {
      if (data_[i] == needle.data_[0] && mem_cmp(data_ + i, needle.data_, needle.size_) == 0) return i;
    }
    return npos;
  }
  int compare(StringView other) const {
    const size_t n = min_val(size_, other.size_);
    const int c = mem_cmp(data_, other.data_, n);
    if (c != 0) return c;
    return size_ < other.size_ ? -1 : (size_ > other.size_ ? 1 : 0);
  }
  bool operator==(StringView other) const { return size_ == other.size_ && mem_cmp(data_, other.data_, size_) == 0; }
  bool operator!=(StringView other) const { return !(*this == other); }
  bool operator<(StringView other) const { return compare(other) < 0; }
  uint64_t hash() const { return js::fnv1a_64(reinterpret_cast<const uint8_t*>(data_), size_); }
 private:
  const char* data_;
  size_t size_;
};

class U16StringView {
 public:
  constexpr U16StringView() : data_(nullptr), size_(0) {}
  constexpr U16StringView(const uint16_t* data, size_t size) : data_(data), size_(size) {}
  constexpr const uint16_t* data() const { return data_; }
  constexpr size_t size() const { return size_; }
  constexpr bool empty() const { return size_ == 0; }
  constexpr uint16_t operator[](size_t i) const { return data_[i]; }
  int compare(U16StringView other) const {
    const size_t n = min_val(size_, other.size_);
    for (size_t i = 0; i < n; ++i) if (data_[i] != other.data_[i]) return data_[i] < other.data_[i] ? -1 : 1;
    return size_ < other.size_ ? -1 : (size_ > other.size_ ? 1 : 0);
  }
  bool operator==(U16StringView other) const {
    return size_ == other.size_ && (size_ == 0 || mem_cmp(data_, other.data_, size_ * sizeof(uint16_t)) == 0);
  }
  bool operator!=(U16StringView other) const { return !(*this == other); }
  bool operator<(U16StringView other) const { return compare(other) < 0; }
  uint64_t hash() const { return js::fnv1a_64(reinterpret_cast<const uint8_t*>(data_), size_ * sizeof(uint16_t)); }
 private:
  const uint16_t* data_;
  size_t size_;
};

inline StringView clone_string(Arena& arena, StringView sv) {
  if (sv.empty()) return StringView("", 0);
  char* buf = arena.alloc<char>(sv.size() + 1);
  if (!buf) return StringView();
  mem_copy(buf, sv.data(), sv.size());
  buf[sv.size()] = '\0';
  return StringView(buf, sv.size());
}

}  // namespace hex
#endif
