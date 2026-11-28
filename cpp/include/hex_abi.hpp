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

static const uint32_t HEX_DECOMP_LOSS_NONE = 0u;
static const uint32_t HEX_DECOMP_LOSS_UNRESOLVED_INDIRECT_BRANCH = 1u << 0;
static const uint32_t HEX_DECOMP_LOSS_UNKNOWN_CALL_ARGS = 1u << 1;
static const uint32_t HEX_DECOMP_LOSS_DROPPED_TAIL_CALL = 1u << 2;
static const uint32_t HEX_DECOMP_LOSS_UNSUPPORTED_INSN = 1u << 3;
static const uint32_t HEX_DECOMP_LOSS_INDIRECT_CALL = 1u << 4;

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
namespace hex {

class Arena {
 public:
  Arena() : base_(nullptr), cursor_(0), capacity_(0), allow_wasm_grow_(false) {}

  void init_external(uint8_t* buffer, size_t capacity, bool allow_wasm_grow = true) {
    base_ = buffer;
    cursor_ = 0;
    if (!buffer) {
      capacity_ = 0;
      allow_wasm_grow_ = false;
      return;
    }
    capacity_ = capacity;
    allow_wasm_grow_ = allow_wasm_grow;
  }

  void init_fixed(uint8_t* buffer, size_t capacity) {
    base_ = buffer;
    cursor_ = 0;
    if (!buffer) {
      capacity_ = 0;
      allow_wasm_grow_ = false;
      return;
    }
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
    if (!base_ || bytes == 0) return nullptr;
    if (align < 8) align = 8;
    if ((align & (align - 1)) != 0) return nullptr;
    const uintptr_t base_addr = reinterpret_cast<uintptr_t>(base_);
    if (cursor_ > static_cast<size_t>(-1) - base_addr) return nullptr;
    const uintptr_t cur_addr = base_addr + cursor_;
    const uintptr_t mask = static_cast<uintptr_t>(align - 1);
    const uintptr_t aligned_addr = (cur_addr + mask) & ~mask;
    if (aligned_addr < cur_addr) return nullptr;
    const size_t aligned = static_cast<size_t>(aligned_addr - base_addr);
    if (bytes > static_cast<size_t>(-1) - aligned) return nullptr;
    const size_t next = aligned + bytes;
    if (next > capacity_) {
#if defined(__wasm__)
      if (!allow_wasm_grow_) return nullptr;
      const uint64_t cur_mem_bytes = static_cast<uint64_t>(__builtin_wasm_memory_size(0)) * 65536ULL;
      const uint64_t base_u64 = static_cast<uint64_t>(base_addr);
      const uint64_t next_u64 = static_cast<uint64_t>(next);
      if (base_u64 > cur_mem_bytes || next_u64 > static_cast<uint64_t>(UINT32_MAX) - base_u64) return nullptr;
      const uint64_t end_u64 = base_u64 + next_u64;
      if (end_u64 > cur_mem_bytes) {
        const uint64_t diff = end_u64 - cur_mem_bytes;
        const uint64_t pages = (diff + 65535ULL) / 65536ULL;
        if (pages == 0ULL || pages > 65536ULL) return nullptr;
        if (__builtin_wasm_memory_grow(0, static_cast<int32_t>(pages)) < 0) return nullptr;
        const uint64_t new_mem_bytes = static_cast<uint64_t>(__builtin_wasm_memory_size(0)) * 65536ULL;
        if (new_mem_bytes < base_u64) return nullptr;
        const uint64_t avail = new_mem_bytes - base_u64;
        capacity_ = static_cast<size_t>(avail > static_cast<uint64_t>(SIZE_MAX) ? static_cast<uint64_t>(SIZE_MAX) : avail);
      } else {
        const uint64_t avail = cur_mem_bytes - base_u64;
        capacity_ = static_cast<size_t>(avail > static_cast<uint64_t>(SIZE_MAX) ? static_cast<uint64_t>(SIZE_MAX) : avail);
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
