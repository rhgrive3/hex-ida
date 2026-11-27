#include "hex_manual_recovery.hpp"
#include "hex_core/hex_core.hpp"

namespace {

// ============================================================================
// Slot 5A Backing Tables
// ============================================================================

alignas(8) HexCustomAbiSpec g_custom_abis[HEX_CUSTOM_ABI_MAX_CAP];
uint32_t g_custom_abi_count = 0u;

struct alignas(8) StackOverrideEntry {
  uint64_t fn_va;
  HexStackSlotOverride spec;
};
static_assert(sizeof(StackOverrideEntry) == 32);

alignas(8) StackOverrideEntry g_stack_overrides[HEX_STACK_OVERRIDE_MAX_CAP];
uint32_t g_stack_override_count = 0u;

struct alignas(8) ShiftedPtrEntry {
  uint64_t fn_va;
  HexShiftedPtrSpec spec;
};
static_assert(sizeof(ShiftedPtrEntry) == 32);

alignas(8) ShiftedPtrEntry g_shifted_ptrs[HEX_SHIFTED_PTR_MAX_CAP];
uint32_t g_shifted_ptr_count = 0u;

// ============================================================================
// Validation Helpers (§15.3 / §15.4 Fail-Closed Rules)
// ============================================================================

bool is_valid_abi_width(uint8_t w) {
  return w == 1u || w == 2u || w == 4u || w == 8u || w == 16u;
}

bool is_fp_or_lr(uint8_t reg_id) {
  return reg_id == 29u || reg_id == 30u;
}

bool validate_abi_loc(
    const HexAbiLoc& loc,
    bool allow_none,
    uint32_t* used_gp_mask,
    uint32_t* used_fp_mask) {
  if (loc.loc_kind > static_cast<uint8_t>(HEX_ABILOC_STACK)) return false;
  if (loc.loc_kind == static_cast<uint8_t>(HEX_ABILOC_NONE)) return allow_none;
  if (!is_valid_abi_width(loc.byte_width)) return false;

  const bool allow_fp_lr = (loc.loc_flags & HEX_ABILOC_FLAG_ALLOW_FP_LR) != 0u;

  switch (loc.loc_kind) {
    case HEX_ABILOC_GPR: {
      // §15.3: SP (reg 31) is forbidden; FP (29) / LR (30) require ALLOW_FP_LR.
      if (loc.reg_id > 30u) return false;
      if (is_fp_or_lr(loc.reg_id) && !allow_fp_lr) return false;
      if (used_gp_mask != nullptr) {
        const uint32_t bit = 1u << loc.reg_id;
        if ((*used_gp_mask & bit) != 0u) return false;
        *used_gp_mask |= bit;
      }
      return true;
    }
    case HEX_ABILOC_GPR_PAIR: {
      if (loc.reg_id > 30u || loc.reg_id_hi > 30u || loc.reg_id == loc.reg_id_hi) return false;
      if ((is_fp_or_lr(loc.reg_id) || is_fp_or_lr(loc.reg_id_hi)) && !allow_fp_lr) return false;
      if (used_gp_mask != nullptr) {
        const uint32_t bits = (1u << loc.reg_id) | (1u << loc.reg_id_hi);
        if ((*used_gp_mask & bits) != 0u) return false;
        *used_gp_mask |= bits;
      }
      return true;
    }
    case HEX_ABILOC_FPR_SIMD: {
      if (loc.reg_id > 31u) return false;
      if (used_fp_mask != nullptr) {
        const uint32_t bit = 1u << loc.reg_id;
        if ((*used_fp_mask & bit) != 0u) return false;
        *used_fp_mask |= bit;
      }
      return true;
    }
    case HEX_ABILOC_FPR_PAIR: {
      if (loc.reg_id > 31u || loc.reg_id_hi > 31u || loc.reg_id == loc.reg_id_hi) return false;
      if (used_fp_mask != nullptr) {
        const uint32_t bits = (1u << loc.reg_id) | (1u << loc.reg_id_hi);
        if ((*used_fp_mask & bits) != 0u) return false;
        *used_fp_mask |= bits;
      }
      return true;
    }
    case HEX_ABILOC_STACK: {
      if (loc.sp_offset < 0 || loc.sp_offset > 4096) return false;
      return true;
    }
    default:
      return false;
  }
}

uint8_t expected_ret_count(uint8_t loc_kind) {
  switch (loc_kind) {
    case HEX_ABILOC_NONE:
      return 0u;
    case HEX_ABILOC_GPR:
    case HEX_ABILOC_FPR_SIMD:
    case HEX_ABILOC_STACK:
      return 1u;
    case HEX_ABILOC_GPR_PAIR:
    case HEX_ABILOC_FPR_PAIR:
      return 2u;
    default:
      return 0xFFu;
  }
}

bool validate_custom_abi_spec(const HexCustomAbiSpec* spec) {
  if (spec == nullptr) return false;
  if (spec->func_va == 0u) return false;
  if (spec->arg_count > HEX_CUSTOM_ABI_MAX_ARGS) return false;
  if ((spec->sp_purge_bytes & 15u) != 0u) return false;

  // Validate return location and enforce ret_count consistency (NONE->0, single->1, PAIR->2).
  if (!validate_abi_loc(spec->ret_loc, /*allow_none=*/true, nullptr, nullptr)) {
    return false;
  }
  if (spec->ret_count != expected_ret_count(spec->ret_loc.loc_kind)) {
    return false;
  }

  // Validate argument locations and reject duplicate physical registers across arguments.
  uint32_t used_gp = 0u;
  uint32_t used_fp = 0u;
  for (uint32_t i = 0u; i < spec->arg_count; ++i) {
    if (!validate_abi_loc(spec->arg_locs[i], /*allow_none=*/false, &used_gp, &used_fp)) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Binary Search Helpers
// ============================================================================

uint32_t lower_bound_abi_va(uint64_t fn_va) {
  uint32_t lo = 0u;
  uint32_t hi = g_custom_abi_count;
  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    if (g_custom_abis[mid].func_va < fn_va) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

uint32_t stack_entry_fp_rel(const HexStackSlotOverride& s) {
  return (s.slot_flags & HEX_STACK_FLAG_FP_REL) != 0u ? 1u : 0u;
}

bool stack_key_less(
    uint64_t fn_a, uint32_t fp_a, int32_t off_a,
    uint64_t fn_b, uint32_t fp_b, int32_t off_b) {
  if (fn_a != fn_b) return fn_a < fn_b;
  if (fp_a != fp_b) return fp_a < fp_b;
  return off_a < off_b;
}

uint32_t lower_bound_stack_override(uint64_t fn_va, uint32_t fp_rel, int32_t sp_offset) {
  uint32_t lo = 0u;
  uint32_t hi = g_stack_override_count;
  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    const StackOverrideEntry& e = g_stack_overrides[mid];
    if (stack_key_less(e.fn_va, stack_entry_fp_rel(e.spec), e.spec.sp_offset, fn_va, fp_rel, sp_offset)) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

bool shifted_key_less(uint64_t fn_a, uint32_t hash_a, uint64_t fn_b, uint32_t hash_b) {
  return (fn_a < fn_b) || (fn_a == fn_b && hash_a < hash_b);
}

uint32_t lower_bound_shifted_ptr(uint64_t fn_va, uint32_t var_key_hash) {
  uint32_t lo = 0u;
  uint32_t hi = g_shifted_ptr_count;
  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    if (shifted_key_less(
            g_shifted_ptrs[mid].fn_va, g_shifted_ptrs[mid].spec.var_key_hash, fn_va, var_key_hash)) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return lo;
}

}  // namespace

extern "C" {

// ============================================================================
// Global Reset Helper
// ============================================================================

HEX_WASM_EXPORT("hex_manual_recovery_reset_all")
void hex_manual_recovery_reset_all(void) {
  hex_manual_seg_reset();
  hex_func_chunk_reset();
  hex_custom_abi_reset();
  hex_stack_override_reset();
  hex_shifted_ptr_reset();
}

// ============================================================================
// Custom ABI Registry Exports
// ============================================================================

HEX_WASM_EXPORT("hex_custom_abi_reset")
void hex_custom_abi_reset(void) {
  g_custom_abi_count = 0u;
}

HEX_WASM_EXPORT("hex_custom_abi_set")
HexStatus hex_custom_abi_set(const HexCustomAbiSpec* spec) {
  if (!validate_custom_abi_spec(spec)) return HEX_ERR_INVALID_ARG;

  const uint32_t idx = lower_bound_abi_va(spec->func_va);
  if (idx < g_custom_abi_count && g_custom_abis[idx].func_va == spec->func_va) {
    g_custom_abis[idx] = *spec;
    g_custom_abis[idx].reserved2 = 0u;
    g_custom_abis[idx].reserved_tail = 0u;
    return HEX_OK;
  }

  if (g_custom_abi_count >= HEX_CUSTOM_ABI_MAX_CAP) return HEX_ERR_RESOURCE_LIMIT;

  for (uint32_t i = g_custom_abi_count; i > idx; --i) {
    g_custom_abis[i] = g_custom_abis[i - 1u];
  }
  g_custom_abis[idx] = *spec;
  g_custom_abis[idx].reserved2 = 0u;
  g_custom_abis[idx].reserved_tail = 0u;
  ++g_custom_abi_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_custom_abi_get")
HexStatus hex_custom_abi_get(uint64_t fn_va, HexCustomAbiSpec* out_spec) {
  if (out_spec == nullptr || fn_va == 0u) return HEX_ERR_INVALID_ARG;
  const uint32_t idx = lower_bound_abi_va(fn_va);
  if (idx >= g_custom_abi_count || g_custom_abis[idx].func_va != fn_va) {
    return HEX_ERR_INVALID_ARG;
  }
  *out_spec = g_custom_abis[idx];
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_custom_abi_count")
uint32_t hex_custom_abi_count(void) {
  return g_custom_abi_count;
}

HEX_WASM_EXPORT("hex_custom_abi_capacity")
uint32_t hex_custom_abi_capacity(void) {
  return HEX_CUSTOM_ABI_MAX_CAP;
}

// ============================================================================
// Stack-Slot Override Registry Exports
// ============================================================================

HEX_WASM_EXPORT("hex_stack_override_reset")
void hex_stack_override_reset(void) {
  g_stack_override_count = 0u;
}

HEX_WASM_EXPORT("hex_stack_override_set")
HexStatus hex_stack_override_set(uint64_t fn_va, const HexStackSlotOverride* spec) {
  if (spec == nullptr || fn_va == 0u || spec->byte_size == 0u) return HEX_ERR_INVALID_ARG;
  // Mutually exclusive: force_split and force_merge cannot both be set.
  if ((spec->slot_flags & (HEX_STACK_FLAG_FORCE_SPLIT | HEX_STACK_FLAG_FORCE_MERGE)) ==
      (HEX_STACK_FLAG_FORCE_SPLIT | HEX_STACK_FLAG_FORCE_MERGE)) {
    return HEX_ERR_INVALID_ARG;
  }

  // Prevent int32_t overflow in [sp_offset, sp_offset + byte_size).
  const int64_t start = static_cast<int64_t>(spec->sp_offset);
  const int64_t end = start + static_cast<int64_t>(spec->byte_size);
  if (end > static_cast<int64_t>(INT32_MAX)) return HEX_ERR_INVALID_ARG;

  const uint32_t fp_rel = stack_entry_fp_rel(*spec);
  const uint32_t idx = lower_bound_stack_override(fn_va, fp_rel, spec->sp_offset);
  const bool is_upsert =
      (idx < g_stack_override_count &&
       g_stack_overrides[idx].fn_va == fn_va &&
       stack_entry_fp_rel(g_stack_overrides[idx].spec) == fp_rel &&
       g_stack_overrides[idx].spec.sp_offset == spec->sp_offset);

  // Reject [sp_offset, sp_offset + byte_size) overlap with predecessor in same (fn_va, fp_rel) space.
  if (idx > 0u) {
    const StackOverrideEntry& prev = g_stack_overrides[idx - 1u];
    if (prev.fn_va == fn_va && stack_entry_fp_rel(prev.spec) == fp_rel) {
      const int64_t prev_end =
          static_cast<int64_t>(prev.spec.sp_offset) + static_cast<int64_t>(prev.spec.byte_size);
      if (prev_end > start) return HEX_ERR_INVALID_ARG;
    }
  }

  // Reject [sp_offset, sp_offset + byte_size) overlap with successor in same (fn_va, fp_rel) space.
  const uint32_t next_idx = is_upsert ? (idx + 1u) : idx;
  if (next_idx < g_stack_override_count) {
    const StackOverrideEntry& next = g_stack_overrides[next_idx];
    if (next.fn_va == fn_va && stack_entry_fp_rel(next.spec) == fp_rel) {
      const int64_t next_start = static_cast<int64_t>(next.spec.sp_offset);
      if (end > next_start) return HEX_ERR_INVALID_ARG;
    }
  }

  if (is_upsert) {
    g_stack_overrides[idx].spec = *spec;
    return HEX_OK;
  }

  if (g_stack_override_count >= HEX_STACK_OVERRIDE_MAX_CAP) return HEX_ERR_RESOURCE_LIMIT;

  for (uint32_t i = g_stack_override_count; i > idx; --i) {
    g_stack_overrides[i] = g_stack_overrides[i - 1u];
  }
  g_stack_overrides[idx].fn_va = fn_va;
  g_stack_overrides[idx].spec = *spec;
  ++g_stack_override_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_stack_override_get_ex")
HexStatus hex_stack_override_get_ex(
    uint64_t fn_va,
    int32_t sp_offset,
    uint32_t fp_rel,
    HexStackSlotOverride* out_spec) {
  if (out_spec == nullptr || fn_va == 0u) return HEX_ERR_INVALID_ARG;
  const uint32_t norm_fp = fp_rel != 0u ? 1u : 0u;
  const uint32_t idx = lower_bound_stack_override(fn_va, norm_fp, sp_offset);
  if (idx >= g_stack_override_count ||
      g_stack_overrides[idx].fn_va != fn_va ||
      stack_entry_fp_rel(g_stack_overrides[idx].spec) != norm_fp ||
      g_stack_overrides[idx].spec.sp_offset != sp_offset) {
    return HEX_ERR_INVALID_ARG;
  }
  *out_spec = g_stack_overrides[idx].spec;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_stack_override_get")
HexStatus hex_stack_override_get(
    uint64_t fn_va,
    int32_t sp_offset,
    HexStackSlotOverride* out_spec) {
  return hex_stack_override_get_ex(fn_va, sp_offset, 0u, out_spec);
}

HEX_WASM_EXPORT("hex_stack_override_count")
uint32_t hex_stack_override_count(void) {
  return g_stack_override_count;
}

HEX_WASM_EXPORT("hex_stack_override_capacity")
uint32_t hex_stack_override_capacity(void) {
  return HEX_STACK_OVERRIDE_MAX_CAP;
}

// ============================================================================
// Shifted-Pointer (__shifted(T, delta)) Registry Exports
// ============================================================================

HEX_WASM_EXPORT("hex_shifted_ptr_reset")
void hex_shifted_ptr_reset(void) {
  g_shifted_ptr_count = 0u;
}

HEX_WASM_EXPORT("hex_shifted_ptr_set")
HexStatus hex_shifted_ptr_set(uint64_t fn_va, const HexShiftedPtrSpec* spec) {
  if (spec == nullptr || fn_va == 0u || spec->var_key_hash == 0u) return HEX_ERR_INVALID_ARG;
  if (spec->shift_offset < 0 && (spec->spec_flags & HEX_SHIFTED_FLAG_ALLOW_NEG_OFFSET) == 0u) {
    return HEX_ERR_INVALID_ARG;
  }

  const uint32_t idx = lower_bound_shifted_ptr(fn_va, spec->var_key_hash);
  if (idx < g_shifted_ptr_count &&
      g_shifted_ptrs[idx].fn_va == fn_va &&
      g_shifted_ptrs[idx].spec.var_key_hash == spec->var_key_hash) {
    g_shifted_ptrs[idx].spec = *spec;
    g_shifted_ptrs[idx].spec.reserved = 0u;
    return HEX_OK;
  }

  if (g_shifted_ptr_count >= HEX_SHIFTED_PTR_MAX_CAP) return HEX_ERR_RESOURCE_LIMIT;

  for (uint32_t i = g_shifted_ptr_count; i > idx; --i) {
    g_shifted_ptrs[i] = g_shifted_ptrs[i - 1u];
  }
  g_shifted_ptrs[idx].fn_va = fn_va;
  g_shifted_ptrs[idx].spec = *spec;
  g_shifted_ptrs[idx].spec.reserved = 0u;
  ++g_shifted_ptr_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_shifted_ptr_get")
HexStatus hex_shifted_ptr_get(
    uint64_t fn_va,
    uint32_t var_key_hash,
    HexShiftedPtrSpec* out_spec) {
  if (out_spec == nullptr || fn_va == 0u || var_key_hash == 0u) return HEX_ERR_INVALID_ARG;
  const uint32_t idx = lower_bound_shifted_ptr(fn_va, var_key_hash);
  if (idx >= g_shifted_ptr_count ||
      g_shifted_ptrs[idx].fn_va != fn_va ||
      g_shifted_ptrs[idx].spec.var_key_hash != var_key_hash) {
    return HEX_ERR_INVALID_ARG;
  }
  *out_spec = g_shifted_ptrs[idx].spec;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_shifted_ptr_count")
uint32_t hex_shifted_ptr_count(void) {
  return g_shifted_ptr_count;
}

HEX_WASM_EXPORT("hex_shifted_ptr_capacity")
uint32_t hex_shifted_ptr_capacity(void) {
  return HEX_SHIFTED_PTR_MAX_CAP;
}

}  // extern "C"
