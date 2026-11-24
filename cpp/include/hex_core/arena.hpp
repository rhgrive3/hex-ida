#ifndef HEX_CORE_ARENA_HPP
#define HEX_CORE_ARENA_HPP

#include "../hex_abi.hpp"
#include "types.hpp"

namespace hex {

class ArenaScope {
 public:
  explicit ArenaScope(Arena& arena) : arena_(arena), mark_(arena.used()) {}
  ~ArenaScope() { arena_.restore(mark_); }
  ArenaScope(const ArenaScope&) = delete;
  ArenaScope& operator=(const ArenaScope&) = delete;
 private:
  Arena& arena_;
  size_t mark_;
};

template <typename T>
inline T* arena_alloc_zeroed(Arena& arena, size_t count) {
  T* ptr = arena.alloc<T>(count);
  if (!ptr) return nullptr;
  mem_set(ptr, 0, count * sizeof(T));
  return ptr;
}

}  // namespace hex
#endif
