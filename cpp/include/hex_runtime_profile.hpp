#ifndef HEX_RUNTIME_PROFILE_HPP
#define HEX_RUNTIME_PROFILE_HPP

#include <stdint.h>
#include "hex_abi.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// 2-Tier Adaptive Runtime Profile Tiers (v6 §16.1–16.2)
enum HexRuntimeProfileTier {
  HEX_PROFILE_MOBILE = 0u,   // 8 MiB g_type_arena (iPad Safari / 256 MB Worker Heap)
  HEX_PROFILE_DESKTOP = 1u,  // 48 MiB g_type_arena (Desktop / Node / 1024 MB Worker Heap)
};

// Fixed resident slot capacities (Slots 0..4 = 1,024 KiB = 1 MiB, identical across tiers)
#define HEX_SLOT0_CORE_TIL_BYTES    (160u * 1024u)   // 0 .. 160 KiB
#define HEX_SLOT1_PACK_A_BYTES      (256u * 1024u)   // 160 .. 416 KiB
#define HEX_SLOT2_PACK_B_BYTES      (256u * 1024u)   // 416 .. 672 KiB
#define HEX_SLOT3_USER_HEADER_BYTES (128u * 1024u)   // 672 .. 800 KiB
#define HEX_SLOT4_HSIG1_BYTES       (224u * 1024u)   // 800 .. 1024 KiB
#define HEX_FIXED_SLOTS_TOTAL_BYTES (1024u * 1024u)  // 1 MiB

// Mobile profile (8 MiB total type arena)
#define HEX_MOBILE_TYPE_ARENA_BYTES (8u * 1024u * 1024u)
#define HEX_MOBILE_SLOT5A_BYTES     (512u * 1024u)
#define HEX_MOBILE_SLOT5B_BYTES     (512u * 1024u)
#define HEX_MOBILE_VOLATILE_A_BYTES (4u * 1024u * 1024u)
#define HEX_MOBILE_VOLATILE_B_BYTES (2u * 1024u * 1024u)
#define HEX_MOBILE_MAX_SIG_NODES    8192u
#define HEX_MOBILE_MAX_SIG_ITERS    6u

// Desktop profile (48 MiB total type arena)
#define HEX_DESKTOP_TYPE_ARENA_BYTES (48u * 1024u * 1024u)
#define HEX_DESKTOP_SLOT5A_BYTES     (3u * 1024u * 1024u)
#define HEX_DESKTOP_SLOT5B_BYTES     (4u * 1024u * 1024u)
#define HEX_DESKTOP_VOLATILE_A_BYTES (24u * 1024u * 1024u)
#define HEX_DESKTOP_VOLATILE_B_BYTES (16u * 1024u * 1024u)
#define HEX_DESKTOP_MAX_SIG_NODES    65536u
#define HEX_DESKTOP_MAX_SIG_ITERS    16u

// 32-byte POD runtime limits descriptor (zero implicit padding)
struct alignas(4) HexRuntimeLimits {
  uint32_t profile_tier;         // +0x00: HEX_PROFILE_MOBILE (0) or HEX_PROFILE_DESKTOP (1)
  uint32_t type_arena_max_bytes; // +0x04: 8 MiB (Mobile) / 48 MiB (Desktop)
  uint32_t slot5a_bytes;         // +0x08: 512 KiB (Mobile) / 3 MiB (Desktop)
  uint32_t slot5b_bytes;         // +0x0C: 512 KiB (Mobile) / 4 MiB (Desktop)
  uint32_t volatile_a_bytes;     // +0x10: 4 MiB (Mobile) / 24 MiB (Desktop)
  uint32_t volatile_b_bytes;     // +0x14: 2 MiB (Mobile) / 16 MiB (Desktop)
  uint32_t max_sig_prop_nodes;   // +0x18: 8192 (Mobile) / 65536 (Desktop)
  uint32_t max_sig_prop_iters;   // +0x1C: 6 (Mobile) / 16 (Desktop)
};

#ifdef __cplusplus
static_assert(sizeof(HexRuntimeLimits) == 32 && alignof(HexRuntimeLimits) == 4,
              "HexRuntimeLimits must be 32B POD with alignof == 4");
#endif

HEX_WASM_EXPORT("hex_set_runtime_profile")
HexStatus hex_set_runtime_profile(uint32_t tier);

HEX_WASM_EXPORT("hex_get_runtime_profile")
uint32_t hex_get_runtime_profile(void);

HEX_WASM_EXPORT("hex_get_runtime_limits")
HexStatus hex_get_runtime_limits(struct HexRuntimeLimits* out_limits);

#ifdef __cplusplus
}  // extern "C"

namespace hex {

constexpr HexRuntimeLimits kMobileRuntimeLimits = {
    HEX_PROFILE_MOBILE,
    HEX_MOBILE_TYPE_ARENA_BYTES,
    HEX_MOBILE_SLOT5A_BYTES,
    HEX_MOBILE_SLOT5B_BYTES,
    HEX_MOBILE_VOLATILE_A_BYTES,
    HEX_MOBILE_VOLATILE_B_BYTES,
    HEX_MOBILE_MAX_SIG_NODES,
    HEX_MOBILE_MAX_SIG_ITERS,
};

constexpr HexRuntimeLimits kDesktopRuntimeLimits = {
    HEX_PROFILE_DESKTOP,
    HEX_DESKTOP_TYPE_ARENA_BYTES,
    HEX_DESKTOP_SLOT5A_BYTES,
    HEX_DESKTOP_SLOT5B_BYTES,
    HEX_DESKTOP_VOLATILE_A_BYTES,
    HEX_DESKTOP_VOLATILE_B_BYTES,
    HEX_DESKTOP_MAX_SIG_NODES,
    HEX_DESKTOP_MAX_SIG_ITERS,
};

static_assert(HEX_FIXED_SLOTS_TOTAL_BYTES + kMobileRuntimeLimits.slot5a_bytes +
                      kMobileRuntimeLimits.slot5b_bytes + kMobileRuntimeLimits.volatile_a_bytes +
                      kMobileRuntimeLimits.volatile_b_bytes ==
                  kMobileRuntimeLimits.type_arena_max_bytes,
              "Mobile slot budgets must sum to 8 MiB");

static_assert(HEX_FIXED_SLOTS_TOTAL_BYTES + kDesktopRuntimeLimits.slot5a_bytes +
                      kDesktopRuntimeLimits.slot5b_bytes + kDesktopRuntimeLimits.volatile_a_bytes +
                      kDesktopRuntimeLimits.volatile_b_bytes ==
                  kDesktopRuntimeLimits.type_arena_max_bytes,
              "Desktop slot budgets must sum to 48 MiB");

constexpr HexRuntimeLimits runtime_limits_for_tier(uint32_t tier) {
  return (tier == HEX_PROFILE_DESKTOP) ? kDesktopRuntimeLimits : kMobileRuntimeLimits;
}

}  // namespace hex
#endif

#endif  // HEX_RUNTIME_PROFILE_HPP
