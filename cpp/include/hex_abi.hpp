#ifndef HEX_ABI_HPP
#define HEX_ABI_HPP

#include <stdint.h>
#include <stddef.h>

#if defined(__wasm__)
#define HEX_WASM_EXPORT(name) __attribute__((export_name(name), visibility("default")))
#else
#define HEX_WASM_EXPORT(name) __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef enum HexStatus {
  HEX_OK = 0,
  HEX_ERR_INVALID_ARG = 1,
  HEX_ERR_OOM = 2,
  HEX_ERR_RESOURCE_LIMIT = 3,
  HEX_ERR_UNSUPPORTED = 4,
  HEX_ERR_INTERNAL = 5,
} HexStatus;

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
namespace hex {

class Arena {
 public:
  Arena() : base_(nullptr), cursor_(0), capacity_(0), allow_wasm_grow_(true) {}

  void init_external(uint8_t* buffer, size_t capacity, bool allow_wasm_grow = true) {
    base_ = buffer;
    cursor_ = 0;
    capacity_ = capacity;
    allow_wasm_grow_ = allow_wasm_grow;
  }

  void init_fixed(uint8_t* buffer, size_t capacity) {
    base_ = buffer;
    cursor_ = 0;
    capacity_ = capacity;
    allow_wasm_grow_ = false;
  }

  void reset() { cursor_ = 0; }
  void restore(size_t mark) {
    if (mark <= cursor_) cursor_ = mark;
  }

  uint8_t* base() const { return base_; }
  size_t used() const { return cursor_; }
  size_t capacity() const { return capacity_; }
  bool allow_wasm_grow() const { return allow_wasm_grow_; }

  void* alloc_bytes(size_t bytes, size_t align = 8) {
    if (bytes == 0) return nullptr;
    if (align < 8) align = 8;
    if ((align & (align - 1)) != 0) return nullptr;
    const size_t mask = align - 1;
    const size_t aligned = (cursor_ + mask) & ~mask;
    if (aligned < cursor_) return nullptr;
    if (bytes > static_cast<size_t>(-1) - aligned) return nullptr;
    const size_t next = aligned + bytes;
    if (next > capacity_) {
#if defined(__wasm__)
      if (!allow_wasm_grow_) return nullptr;
      const size_t cur_mem_bytes = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u;
      const size_t base_addr = reinterpret_cast<uintptr_t>(base_);
      if (base_addr > cur_mem_bytes || next > static_cast<size_t>(-1) - base_addr) return nullptr;
      if (base_addr + next > cur_mem_bytes) {
        const size_t diff = (base_addr + next) - cur_mem_bytes;
        const size_t pages = (diff + 65535u) / 65536u;
        if (__builtin_wasm_memory_grow(0, static_cast<int32_t>(pages)) < 0) return nullptr;
        capacity_ = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u - base_addr;
      } else {
        capacity_ = cur_mem_bytes - base_addr;
      }
      if (next > capacity_) return nullptr;
#else
      return nullptr;
#endif
    }
    cursor_ = next;
    return base_ + aligned;
  }

  template <typename T>
  T* alloc(size_t count) {
    if (count == 0) return nullptr;
    if (count > (static_cast<size_t>(-1) / sizeof(T))) return nullptr;
    constexpr size_t align = alignof(T) < 8 ? 8 : alignof(T);
    return reinterpret_cast<T*>(alloc_bytes(count * sizeof(T), align));
  }

 private:
  uint8_t* base_;
  size_t cursor_;
  size_t capacity_;
  bool allow_wasm_grow_;
};

}  // namespace hex
#endif

#endif  // HEX_ABI_HPP
