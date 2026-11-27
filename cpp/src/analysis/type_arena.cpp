#include "hex_type_system.hpp"
#include "hex_core/types.hpp"

namespace {

struct TypeArenaState {
  bool initialized;
  HexRuntimeLimits limits;
  uintptr_t base_addr;
  uint32_t committed_bytes;
  HexTypeArenaSlotInfo slots[HEX_ARENA_SLOT_COUNT];
};

TypeArenaState g_type_arena = {};

#if !defined(__wasm__)
// Host-build fallback backing store (only used when compiled natively, not wasm32).
alignas(16) uint8_t g_host_arena_backing[HEX_MOBILE_TYPE_ARENA_BYTES];
#endif

constexpr uint32_t kFixedSlotOffsets[5] = {
    0u,
    HEX_SLOT0_CORE_TIL_BYTES,
    HEX_SLOT0_CORE_TIL_BYTES + HEX_SLOT1_PACK_A_BYTES,
    HEX_SLOT0_CORE_TIL_BYTES + HEX_SLOT1_PACK_A_BYTES + HEX_SLOT2_PACK_B_BYTES,
    HEX_SLOT0_CORE_TIL_BYTES + HEX_SLOT1_PACK_A_BYTES + HEX_SLOT2_PACK_B_BYTES +
        HEX_SLOT3_USER_HEADER_BYTES,
};

constexpr uint32_t kFixedSlotCaps[5] = {
    HEX_SLOT0_CORE_TIL_BYTES,
    HEX_SLOT1_PACK_A_BYTES,
    HEX_SLOT2_PACK_B_BYTES,
    HEX_SLOT3_USER_HEADER_BYTES,
    HEX_SLOT4_HSIG1_BYTES,
};

void configure_fixed_slots(bool reset_usage) {
  for (uint32_t i = 0u; i < 5u; ++i) {
    g_type_arena.slots[i].slot_id = i;
    g_type_arena.slots[i].base_offset = kFixedSlotOffsets[i];
    g_type_arena.slots[i].capacity = kFixedSlotCaps[i];
    g_type_arena.slots[i].flags =
        (g_type_arena.slots[i].flags & (HEX_ARENA_FLAG_COMMITTED | HEX_ARENA_FLAG_MOUNTED)) |
        HEX_ARENA_FLAG_FIXED;
    if (reset_usage) {
      g_type_arena.slots[i].used = 0u;
      g_type_arena.slots[i].flags &= ~HEX_ARENA_FLAG_MOUNTED;
      g_type_arena.slots[i].generation += 1u;
    }
  }
}

void configure_dynamic_slots(const HexRuntimeLimits& lim) {
  const uint32_t off_5a = HEX_FIXED_SLOTS_TOTAL_BYTES;
  const uint32_t off_5b = off_5a + lim.slot5a_bytes;
  const uint32_t off_va = off_5b + lim.slot5b_bytes;
  const uint32_t off_vb = off_va + lim.volatile_a_bytes;

  const uint32_t offsets[4] = {off_5a, off_5b, off_va, off_vb};
  const uint32_t caps[4] = {
      lim.slot5a_bytes,
      lim.slot5b_bytes,
      lim.volatile_a_bytes,
      lim.volatile_b_bytes,
  };
  const uint32_t flags[4] = {
      0u,
      0u,
      HEX_ARENA_FLAG_VOLATILE,
      HEX_ARENA_FLAG_VOLATILE,
  };

  for (uint32_t k = 0u; k < 4u; ++k) {
    const uint32_t id = 5u + k;
    g_type_arena.slots[id].slot_id = id;
    g_type_arena.slots[id].base_offset = offsets[k];
    g_type_arena.slots[id].capacity = caps[k];
    g_type_arena.slots[id].used = 0u;
    g_type_arena.slots[id].flags = flags[k];
    g_type_arena.slots[id].generation += 1u;
  }
}

void ensure_initialized() {
  if (g_type_arena.initialized) return;
  g_type_arena.limits = hex::kMobileRuntimeLimits;
#if defined(__wasm__)
  const size_t cur_pages = static_cast<size_t>(__builtin_wasm_memory_size(0));
  g_type_arena.base_addr = static_cast<uintptr_t>(cur_pages * 65536u);
  g_type_arena.committed_bytes = 0u;
#else
  g_type_arena.base_addr = reinterpret_cast<uintptr_t>(g_host_arena_backing);
  g_type_arena.committed_bytes = sizeof(g_host_arena_backing);
#endif
  configure_fixed_slots(true);
  configure_dynamic_slots(g_type_arena.limits);
  g_type_arena.initialized = true;
}

bool ensure_committed(uint32_t end_offset) {
  if (end_offset > g_type_arena.limits.type_arena_max_bytes) return false;
  if (end_offset <= g_type_arena.committed_bytes) return true;

#if defined(__wasm__)
  const size_t max_size_t = static_cast<size_t>(-1);
  if (static_cast<size_t>(end_offset) > max_size_t - static_cast<size_t>(g_type_arena.base_addr)) {
    return false;
  }
  const size_t required_mem = static_cast<size_t>(g_type_arena.base_addr) + end_offset;
  size_t cur_mem = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u;

  if (required_mem > cur_mem) {
    const size_t diff = required_mem - cur_mem;
    const size_t exact_pages = (diff + 65535u) / 65536u;
    const size_t chunk_pages = ((exact_pages + 15u) / 16u) * 16u;
    const size_t arena_ceiling =
        static_cast<size_t>(g_type_arena.base_addr) + g_type_arena.limits.type_arena_max_bytes;
    const size_t max_grow_pages =
        (arena_ceiling > cur_mem) ? ((arena_ceiling - cur_mem + 65535u) / 65536u) : exact_pages;
    const size_t grow_pages = (chunk_pages <= max_grow_pages) ? chunk_pages : exact_pages;

    if (__builtin_wasm_memory_grow(0, static_cast<int32_t>(grow_pages)) < 0) {
      if (grow_pages != exact_pages) {
        if (__builtin_wasm_memory_grow(0, static_cast<int32_t>(exact_pages)) < 0) {
          return false;
        }
      } else {
        return false;
      }
    }
    cur_mem = static_cast<size_t>(__builtin_wasm_memory_size(0)) * 65536u;
  }

  size_t avail = (cur_mem > static_cast<size_t>(g_type_arena.base_addr))
                     ? (cur_mem - static_cast<size_t>(g_type_arena.base_addr))
                     : 0u;
  if (avail > g_type_arena.limits.type_arena_max_bytes) {
    avail = g_type_arena.limits.type_arena_max_bytes;
  }
  g_type_arena.committed_bytes = static_cast<uint32_t>(avail);
  return end_offset <= g_type_arena.committed_bytes;
#else
  return end_offset <= g_type_arena.committed_bytes;
#endif
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_set_runtime_profile")
HexStatus hex_set_runtime_profile(uint32_t tier) {
  if (tier != HEX_PROFILE_MOBILE && tier != HEX_PROFILE_DESKTOP) {
    return HEX_ERR_INVALID_ARG;
  }
  ensure_initialized();
  g_type_arena.limits = hex::runtime_limits_for_tier(tier);
  configure_dynamic_slots(g_type_arena.limits);
  if (g_type_arena.committed_bytes > g_type_arena.limits.type_arena_max_bytes) {
    g_type_arena.committed_bytes = g_type_arena.limits.type_arena_max_bytes;
  }
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_get_runtime_profile")
uint32_t hex_get_runtime_profile(void) {
  ensure_initialized();
  return g_type_arena.limits.profile_tier;
}

HEX_WASM_EXPORT("hex_get_runtime_limits")
HexStatus hex_get_runtime_limits(struct HexRuntimeLimits* out_limits) {
  if (out_limits == nullptr) return HEX_ERR_INVALID_ARG;
  ensure_initialized();
  *out_limits = g_type_arena.limits;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_type_arena_init")
HexStatus hex_type_arena_init(void) {
  if (!g_type_arena.initialized) {
    ensure_initialized();
  } else {
    configure_fixed_slots(true);
    configure_dynamic_slots(g_type_arena.limits);
  }
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_type_arena_slot_cap")
uint32_t hex_type_arena_slot_cap(uint32_t slot_id) {
  ensure_initialized();
  if (slot_id >= HEX_ARENA_SLOT_COUNT) return 0u;
  return g_type_arena.slots[slot_id].capacity;
}

HEX_WASM_EXPORT("hex_type_arena_slot_used")
uint32_t hex_type_arena_slot_used(uint32_t slot_id) {
  ensure_initialized();
  if (slot_id >= HEX_ARENA_SLOT_COUNT) return 0u;
  return g_type_arena.slots[slot_id].used;
}

HEX_WASM_EXPORT("hex_type_arena_slot_info")
HexStatus hex_type_arena_slot_info(uint32_t slot_id, struct HexTypeArenaSlotInfo* out_info) {
  if (out_info == nullptr || slot_id >= HEX_ARENA_SLOT_COUNT) {
    return HEX_ERR_INVALID_ARG;
  }
  ensure_initialized();
  *out_info = g_type_arena.slots[slot_id];
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_type_arena_slot_ptr")
uint8_t* hex_type_arena_slot_ptr(uint32_t slot_id) {
  ensure_initialized();
  if (slot_id >= HEX_ARENA_SLOT_COUNT) return nullptr;
  HexTypeArenaSlotInfo& slot = g_type_arena.slots[slot_id];
  if (slot.capacity > g_type_arena.limits.type_arena_max_bytes - slot.base_offset) {
    return nullptr;
  }
  const uint32_t end_off = slot.base_offset + slot.capacity;
  if (!ensure_committed(end_off)) return nullptr;
  slot.flags |= HEX_ARENA_FLAG_COMMITTED;
  return reinterpret_cast<uint8_t*>(g_type_arena.base_addr + slot.base_offset);
}

HEX_WASM_EXPORT("hex_type_arena_alloc_slot")
uint8_t* hex_type_arena_alloc_slot(uint32_t slot_id, uint32_t bytes) {
  ensure_initialized();
  if (slot_id >= HEX_ARENA_SLOT_COUNT || bytes == 0u) return nullptr;
  HexTypeArenaSlotInfo& slot = g_type_arena.slots[slot_id];
  if (bytes > slot.capacity) return nullptr;
  const uint32_t end_off = slot.base_offset + bytes;
  if (!ensure_committed(end_off)) return nullptr;
  slot.used = bytes;
  slot.flags |= (HEX_ARENA_FLAG_COMMITTED | HEX_ARENA_FLAG_MOUNTED);
  slot.generation += 1u;
  return reinterpret_cast<uint8_t*>(g_type_arena.base_addr + slot.base_offset);
}

HEX_WASM_EXPORT("hex_type_arena_bump_alloc")
uint8_t* hex_type_arena_bump_alloc(uint32_t slot_id, uint32_t bytes, uint32_t align) {
  ensure_initialized();
  if (slot_id >= HEX_ARENA_SLOT_COUNT || bytes == 0u) return nullptr;
  if (align == 0u) align = 8u;
  if ((align & (align - 1u)) != 0u) return nullptr;

  HexTypeArenaSlotInfo& slot = g_type_arena.slots[slot_id];
  const uint32_t mask = align - 1u;
  if (slot.used > 0xFFFFFFFFu - mask) return nullptr;
  const uint32_t aligned = (slot.used + mask) & ~mask;
  if (bytes > slot.capacity || aligned > slot.capacity - bytes) return nullptr;

  const uint32_t next_used = aligned + bytes;
  const uint32_t end_off = slot.base_offset + next_used;
  if (!ensure_committed(end_off)) return nullptr;

  slot.used = next_used;
  slot.flags |= HEX_ARENA_FLAG_COMMITTED;
  return reinterpret_cast<uint8_t*>(g_type_arena.base_addr + slot.base_offset + aligned);
}

HEX_WASM_EXPORT("hex_type_arena_reset_slot")
HexStatus hex_type_arena_reset_slot(uint32_t slot_id) {
  ensure_initialized();
  if (slot_id >= HEX_ARENA_SLOT_COUNT) return HEX_ERR_INVALID_ARG;
  HexTypeArenaSlotInfo& slot = g_type_arena.slots[slot_id];
  slot.used = 0u;
  slot.flags &= ~HEX_ARENA_FLAG_MOUNTED;
  slot.generation += 1u;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_type_arena_reset_volatile")
void hex_type_arena_reset_volatile(void) {
  ensure_initialized();
  hex_type_arena_reset_slot(HEX_ARENA_SLOT_VOLATILE_A);
  hex_type_arena_reset_slot(HEX_ARENA_SLOT_VOLATILE_B);
}

HEX_WASM_EXPORT("hex_type_arena_reset_all")
void hex_type_arena_reset_all(void) {
  ensure_initialized();
  for (uint32_t i = 0u; i < HEX_ARENA_SLOT_COUNT; ++i) {
    hex_type_arena_reset_slot(i);
  }
}

}  // extern "C"
