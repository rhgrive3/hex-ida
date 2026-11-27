#include "hex_type_system.hpp"
#include "hex_core/types.hpp"

namespace {

constexpr uint32_t kTilSlotCount = 4u;  // Slot 0 (Core), 1 (Pack A), 2 (Pack B), 3 (User Header)

struct MountedTilSlot {
  bool mounted;
  uint8_t* data;
  uint32_t len;
  uint32_t arena_generation;
  uint16_t tid_base;
  uint16_t tid_cap;
  HexTilHeader header;
  uint32_t hash_index_off;
  uint32_t sel_index_off;
  uint32_t type_desc_off;
  uint32_t str_pool_end;
};

struct TilEngineState {
  MountedTilSlot slots[kTilSlotCount];
  uint32_t lookup_hits;
  uint32_t lookup_misses;
};

TilEngineState g_til = {};

inline uint16_t read_u16_le(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8u);
}

inline uint32_t read_u32_le(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8u) |
         (static_cast<uint32_t>(p[2]) << 16u) |
         (static_cast<uint32_t>(p[3]) << 24u);
}

inline uint32_t fnv1a_32_til_blob(const uint8_t* data, uint32_t len) {
  uint32_t h = 0x811c9dc5u;
  for (uint32_t i = 0u; i < len; ++i) {
    const uint8_t b = (i >= 0x20u && i <= 0x23u) ? 0u : data[i];
    h ^= static_cast<uint32_t>(b);
    h *= 0x01000193u;
  }
  return h;
}

inline uint64_t fnv1a_64(const uint8_t* data, uint32_t len) {
  uint64_t h = 0xcbf29ce484222325ULL;
  for (uint32_t i = 0u; i < len; ++i) {
    h ^= static_cast<uint64_t>(data[i]);
    h *= 0x100000001b3ULL;
  }
  return h;
}

inline bool checked_add_u32(uint32_t a, uint32_t b, uint32_t* out) {
  if (b > 0xFFFFFFFFu - a) return false;
  *out = a + b;
  return true;
}

inline bool checked_mul_u32(uint32_t a, uint32_t b, uint32_t* out) {
  if (a != 0u && b > 0xFFFFFFFFu / a) return false;
  *out = a * b;
  return true;
}

// Verify that the arena backing slot is still mounted at the same generation (prevents Use-After-Reset).
bool is_slot_live(uint32_t slot_id) {
  if (slot_id >= kTilSlotCount) return false;
  MountedTilSlot& slot = g_til.slots[slot_id];
  if (!slot.mounted || slot.data == nullptr) return false;
  HexTypeArenaSlotInfo info = {};
  if (hex_type_arena_slot_info(slot_id, &info) != HEX_OK) {
    slot.mounted = false;
    return false;
  }
  if ((info.flags & HEX_ARENA_FLAG_MOUNTED) == 0u ||
      info.generation != slot.arena_generation ||
      info.used < slot.len) {
    slot.mounted = false;
    slot.data = nullptr;
    return false;
  }
  return true;
}

inline bool validate_nul_string(const uint8_t* data, uint32_t str_start, uint32_t str_end,
                                uint32_t name_off) {
  if (str_start >= str_end) return false;
  const uint32_t pool_size = str_end - str_start;
  if (name_off >= pool_size) return false;
  const uint32_t abs_off = str_start + name_off;
  for (uint32_t i = abs_off; i < str_end; ++i) {
    if (data[i] == 0u) return true;
  }
  return false;
}

inline bool string_equals_pool(const uint8_t* data, uint32_t str_start, uint32_t str_end,
                               uint32_t name_off, const uint8_t* key, uint32_t key_len) {
  if (str_start >= str_end) return false;
  const uint32_t pool_size = str_end - str_start;
  if (name_off >= pool_size) return false;
  const uint32_t avail = pool_size - name_off;
  if (key_len >= avail) return false;
  const uint8_t* s = data + str_start + name_off;
  if (s[key_len] != 0u) return false;
  return hex::mem_cmp(s, key, key_len) == 0;
}

inline bool is_mangled_prefix(const uint8_t* sym, uint32_t len) {
  if (len >= 2u && sym[0] == '_' && sym[1] == 'Z') return true;
  if (len >= 3u && sym[0] == '_' && sym[1] == '_' && sym[2] == 'Z') return true;
  if (len >= 2u && sym[0] == '$' && (sym[1] == 's' || sym[1] == 'S')) return true;
  if (len >= 3u && sym[0] == '_' && sym[1] == '$' && (sym[2] == 's' || sym[2] == 'S')) return true;
  if (len >= 3u && sym[0] == '_' && sym[1] == 'T' && sym[2] == '0') return true;
  return false;
}

// Only remap pack-local TIDs in [TIL_PACK_MIN (0x1000) .. TIL_PACK_MAX (0x5FFF)].
// Builtins/Core (<0x1000), Local Headers (0x6000..0x7FFF), and Recovered/Invalid (>=0x8000) pass through unchanged.
inline uint16_t remap_tid(const MountedTilSlot& slot, uint16_t raw_tid) {
  if ((slot.header.flags & HEX_TIL_FLAG_LOCAL_TID_RELATIVE) == 0u) return raw_tid;
  if (raw_tid < TIL_PACK_MIN || raw_tid > TIL_PACK_MAX) return raw_tid;
  const uint32_t delta = static_cast<uint32_t>(raw_tid - TIL_PACK_MIN);
  if (slot.tid_cap > 0u && delta >= slot.tid_cap) return TIL_TYPE_INVALID;
  const uint32_t mapped = static_cast<uint32_t>(slot.tid_base) + delta;
  if (mapped >= TIL_TYPE_INVALID) return TIL_TYPE_INVALID;
  return static_cast<uint16_t>(mapped);
}

inline HexTypeId remap_hex_type(const MountedTilSlot& slot, HexTypeId raw_id) {
  if (hex_type_is_none(raw_id) || raw_id == 0u) return raw_id;
  if ((slot.header.flags & HEX_TIL_FLAG_LOCAL_TID_RELATIVE) == 0u) return raw_id;
  const uint16_t base = hex_type_base_til(raw_id);
  const uint16_t mapped = remap_tid(slot, base);
  if (mapped == TIL_TYPE_INVALID) return HEX_TYPE_ID_NONE;
  return (raw_id & 0xFFFF0000u) | static_cast<uint32_t>(mapped);
}

void decode_sig_blob(
    const MountedTilSlot& slot,
    uint32_t slot_id,
    uint32_t sig_off,
    uint16_t entry_idx,
    HexTilSigRecord64* out_rec) {
  hex::mem_set(out_rec, 0, sizeof(HexTilSigRecord64));
  const uint8_t* p = slot.data + sig_off;
  const uint32_t name_off = read_u32_le(p + 0u);
  const uint32_t raw_ret = read_u32_le(p + 4u);
  const uint8_t flags = p[8u];
  const uint8_t arity = p[9u];
  const uint8_t fmt_arg_idx = p[10u];
  const uint8_t rsv = p[11u];

  out_rec->ret_hex_type = remap_hex_type(slot, raw_ret);
  out_rec->flags = flags;
  out_rec->arity = arity;
  out_rec->fmt_arg_idx = fmt_arg_idx;
  out_rec->format_family = static_cast<uint8_t>((flags >> 2u) & 0x07u);
  out_rec->sig_index = entry_idx;
  out_rec->matched_slot_id = static_cast<uint8_t>(slot_id);
  out_rec->call_conv = static_cast<uint8_t>(rsv & 0x03u);
  out_rec->name_off = name_off;

  const uint8_t count = arity <= HEX_TIL1_MAX_ARITY ? arity : HEX_TIL1_MAX_ARITY;
  for (uint8_t i = 0u; i < count; ++i) {
    const uint32_t raw_param = read_u32_le(p + 12u + static_cast<uint32_t>(i) * 4u);
    out_rec->param_hex_types[i] = remap_hex_type(slot, raw_param);
  }
}

bool lookup_symbol_in_slot(
    uint32_t slot_id,
    const uint8_t* key,
    uint32_t key_len,
    HexTilSigRecord64* out_rec) {
  if (!is_slot_live(slot_id)) return false;
  const MountedTilSlot& slot = g_til.slots[slot_id];
  if (slot.header.entry_count == 0u) return false;

  const uint64_t h = fnv1a_64(key, key_len);
  const uint32_t bucket = static_cast<uint32_t>(h >> 56u);
  const uint8_t* bucket_dir = slot.data + HEX_TIL1_BUCKET_DIR_OFFSET;
  const uint32_t lo_init = read_u16_le(bucket_dir + bucket * 2u);
  const uint32_t hi_init = read_u16_le(bucket_dir + (bucket + 1u) * 2u);
  if (lo_init >= hi_init) return false;

  const uint8_t* entries = slot.data + slot.hash_index_off;
  uint32_t lo = lo_init;
  uint32_t hi = hi_init;

  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    const uint8_t* ep = entries + mid * 12u;
    const uint64_t mh =
        static_cast<uint64_t>(read_u32_le(ep + 0u)) |
        (static_cast<uint64_t>(read_u32_le(ep + 4u)) << 32u);
    if (mh < h) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }

  for (uint32_t idx = lo; idx < hi_init; ++idx) {
    const uint8_t* ep = entries + idx * 12u;
    const uint64_t mh =
        static_cast<uint64_t>(read_u32_le(ep + 0u)) |
        (static_cast<uint64_t>(read_u32_le(ep + 4u)) << 32u);
    if (mh != h) break;
    const uint32_t sig_off = read_u32_le(ep + 8u);
    const uint32_t name_off = read_u32_le(slot.data + sig_off);
    if (string_equals_pool(slot.data, slot.header.str_pool_off, slot.str_pool_end,
                           name_off, key, key_len)) {
      decode_sig_blob(slot, slot_id, sig_off, static_cast<uint16_t>(idx), out_rec);
      return true;
    }
  }

  return false;
}

bool lookup_selector_in_slot(
    uint32_t slot_id,
    const uint8_t* key,
    uint32_t key_len,
    HexTilSigRecord64* out_rec) {
  if (!is_slot_live(slot_id)) return false;
  const MountedTilSlot& slot = g_til.slots[slot_id];
  if (slot.header.sel_count == 0u) return false;

  const uint64_t h = fnv1a_64(key, key_len);
  const uint8_t* entries = slot.data + slot.sel_index_off;
  uint32_t lo = 0u;
  uint32_t hi = slot.header.sel_count;

  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    const uint8_t* ep = entries + mid * 12u;
    const uint64_t mh =
        static_cast<uint64_t>(read_u32_le(ep + 0u)) |
        (static_cast<uint64_t>(read_u32_le(ep + 4u)) << 32u);
    if (mh < h) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }

  for (uint32_t idx = lo; idx < slot.header.sel_count; ++idx) {
    const uint8_t* ep = entries + idx * 12u;
    const uint64_t mh =
        static_cast<uint64_t>(read_u32_le(ep + 0u)) |
        (static_cast<uint64_t>(read_u32_le(ep + 4u)) << 32u);
    if (mh != h) break;
    const uint32_t sig_off = read_u32_le(ep + 8u);
    const uint32_t name_off = read_u32_le(slot.data + sig_off);
    if (string_equals_pool(slot.data, slot.header.str_pool_off, slot.str_pool_end,
                           name_off, key, key_len)) {
      decode_sig_blob(slot, slot_id, sig_off, static_cast<uint16_t>(idx), out_rec);
      return true;
    }
  }
  return false;
}

bool try_lookup_with_priority(
    const uint8_t* key,
    uint32_t key_len,
    uint32_t slot_mask,
    HexTilSigRecord64* out_rec) {
  // Strict priority: Slot 3 (User Header) > Slot 2 (Pack B) > Slot 1 (Pack A) > Slot 0 (Core TIL)
  for (int32_t s = 3; s >= 0; --s) {
    const uint32_t sid = static_cast<uint32_t>(s);
    if ((slot_mask & (1u << sid)) == 0u) continue;
    if (lookup_symbol_in_slot(sid, key, key_len, out_rec)) {
      return true;
    }
  }
  return false;
}

// Locate TypeDesc entry matching `tid` inside a live slot.
// Supports both implicit dense indexing (local_tid == 0 -> tid_base + i)
// and explicit/sparse TIDs (local_tid != 0 -> remap_tid(slot, local_tid)).
const uint8_t* find_type_in_slot(uint32_t slot_id, uint16_t tid) {
  if (!is_slot_live(slot_id)) return nullptr;
  const MountedTilSlot& slot = g_til.slots[slot_id];
  if (slot.header.type_count == 0u) return nullptr;

  for (uint32_t i = 0u; i < slot.header.type_count; ++i) {
    const uint8_t* tp = slot.data + slot.type_desc_off + i * 12u;
    const uint16_t raw_local_tid = read_u16_le(tp + 6u);
    uint16_t resolved_tid = TIL_TYPE_INVALID;
    if (raw_local_tid == 0u) {
      if (slot.tid_cap > 0u && i >= slot.tid_cap) continue;
      const uint32_t cand = static_cast<uint32_t>(slot.tid_base) + i;
      if (cand >= TIL_TYPE_INVALID) continue;
      resolved_tid = static_cast<uint16_t>(cand);
    } else {
      resolved_tid = remap_tid(slot, raw_local_tid);
    }
    if (resolved_tid == tid) {
      return tp;
    }
  }
  return nullptr;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_til_mount")
HexStatus hex_til_mount(
    uint32_t slot_id,
    const uint8_t* blob,
    uint32_t len,
    uint16_t tid_base,
    uint16_t tid_cap) {
  if (slot_id >= kTilSlotCount || blob == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (slot_id >= 1u && tid_base < TIL_PACK_MIN) {
    return HEX_ERR_INVALID_ARG;
  }
  if (len < HEX_TIL1_HASH_INDEX_OFFSET) {
    return HEX_ERR_INVALID_ARG;
  }
  const uint32_t slot_cap = hex_type_arena_slot_cap(slot_id);
  if (slot_cap == 0u || len > slot_cap) {
    return HEX_ERR_OOM;
  }

  // 1. Parse and validate 36B Header
  if (blob[0] != HEX_TIL1_MAGIC_0 || blob[1] != HEX_TIL1_MAGIC_1 ||
      blob[2] != HEX_TIL1_MAGIC_2 || blob[3] != HEX_TIL1_MAGIC_3) {
    return HEX_ERR_INVALID_ARG;
  }

  HexTilHeader hdr = {};
  hdr.magic[0] = blob[0];
  hdr.magic[1] = blob[1];
  hdr.magic[2] = blob[2];
  hdr.magic[3] = blob[3];
  hdr.version = read_u16_le(blob + 4u);
  hdr.flags = read_u16_le(blob + 6u);
  hdr.entry_count = read_u32_le(blob + 8u);
  hdr.sel_count = read_u32_le(blob + 12u);
  hdr.type_count = read_u32_le(blob + 16u);
  hdr.sig_pool_off = read_u32_le(blob + 20u);
  hdr.str_pool_off = read_u32_le(blob + 24u);
  hdr.ext_chunk_off = read_u32_le(blob + 28u);
  hdr.checksum_fnv32 = read_u32_le(blob + 32u);

  if (hdr.version != HEX_TIL1_VERSION) {
    return HEX_ERR_UNSUPPORTED;
  }

  // 2. Verify FNV-1a 32-bit checksum
  const uint32_t actual_cksum = fnv1a_32_til_blob(blob, len);
  if (actual_cksum != hdr.checksum_fnv32) {
    return HEX_ERR_INVALID_ARG;
  }

  // 3. Overflow-safe section bounds verification
  if (hdr.entry_count > 65535u) {
    return HEX_ERR_INVALID_ARG;
  }

  uint32_t hash_bytes = 0u, sel_bytes = 0u, type_bytes = 0u;
  if (!checked_mul_u32(hdr.entry_count, 12u, &hash_bytes)) return HEX_ERR_INVALID_ARG;
  if (!checked_mul_u32(hdr.sel_count, 12u, &sel_bytes)) return HEX_ERR_INVALID_ARG;
  if (!checked_mul_u32(hdr.type_count, 12u, &type_bytes)) return HEX_ERR_INVALID_ARG;

  uint32_t sel_off = 0u, type_off = 0u, table_end = 0u;
  if (!checked_add_u32(HEX_TIL1_HASH_INDEX_OFFSET, hash_bytes, &sel_off)) {
    return HEX_ERR_INVALID_ARG;
  }
  if (!checked_add_u32(sel_off, sel_bytes, &type_off)) return HEX_ERR_INVALID_ARG;
  if (!checked_add_u32(type_off, type_bytes, &table_end)) return HEX_ERR_INVALID_ARG;

  if (hdr.sig_pool_off < table_end || (hdr.sig_pool_off & 3u) != 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  if (hdr.str_pool_off < hdr.sig_pool_off || hdr.str_pool_off > len) {
    return HEX_ERR_INVALID_ARG;
  }

  uint32_t str_pool_end = len;
  if ((hdr.flags & HEX_TIL_FLAG_HAS_EXT_CHUNK) != 0u) {
    if (hdr.ext_chunk_off < hdr.str_pool_off || (hdr.ext_chunk_off & 3u) != 0u ||
        hdr.ext_chunk_off > len || len - hdr.ext_chunk_off < 8u) {
      return HEX_ERR_INVALID_ARG;
    }
    str_pool_end = hdr.ext_chunk_off;
  } else if (hdr.ext_chunk_off != 0u) {
    return HEX_ERR_INVALID_ARG;
  }

  // 4. Validate Bucket Dir (257 uint16_t entries) and Hash Index ordering + SigBlob bounds
  const uint8_t* bucket_dir = blob + HEX_TIL1_BUCKET_DIR_OFFSET;
  uint16_t prev_b = read_u16_le(bucket_dir);
  if (prev_b != 0u) return HEX_ERR_INVALID_ARG;

  for (uint32_t b = 0u; b < 256u; ++b) {
    const uint16_t next_b = read_u16_le(bucket_dir + (b + 1u) * 2u);
    if (next_b < prev_b || next_b > hdr.entry_count) return HEX_ERR_INVALID_ARG;

    uint64_t prev_hash = 0ULL;
    for (uint32_t idx = prev_b; idx < next_b; ++idx) {
      const uint8_t* ep = blob + HEX_TIL1_HASH_INDEX_OFFSET + idx * 12u;
      const uint32_t h_lo = read_u32_le(ep + 0u);
      const uint32_t h_hi = read_u32_le(ep + 4u);
      const uint32_t sig_off = read_u32_le(ep + 8u);
      const uint64_t h = static_cast<uint64_t>(h_lo) | (static_cast<uint64_t>(h_hi) << 32u);

      if ((h_hi >> 24u) != b) return HEX_ERR_INVALID_ARG;
      if (idx > prev_b && h < prev_hash) return HEX_ERR_INVALID_ARG;
      prev_hash = h;

      if (sig_off < hdr.sig_pool_off || (sig_off & 3u) != 0u ||
          sig_off > hdr.str_pool_off || hdr.str_pool_off - sig_off < 12u) {
        return HEX_ERR_INVALID_ARG;
      }
      const uint8_t arity = blob[sig_off + 9u];
      if (arity > HEX_TIL1_MAX_ARITY) return HEX_ERR_INVALID_ARG;
      const uint32_t sig_bytes = 12u + static_cast<uint32_t>(arity) * 4u;
      if (hdr.str_pool_off - sig_off < sig_bytes) return HEX_ERR_INVALID_ARG;

      const uint32_t name_off = read_u32_le(blob + sig_off);
      if (!validate_nul_string(blob, hdr.str_pool_off, str_pool_end, name_off)) {
        return HEX_ERR_INVALID_ARG;
      }
    }
    prev_b = next_b;
  }
  if (prev_b != hdr.entry_count) return HEX_ERR_INVALID_ARG;

  // 5. Validate Selector Index ordering and SigBlob bounds
  uint64_t prev_sel_hash = 0ULL;
  for (uint32_t idx = 0u; idx < hdr.sel_count; ++idx) {
    const uint8_t* ep = blob + sel_off + idx * 12u;
    const uint64_t h = static_cast<uint64_t>(read_u32_le(ep + 0u)) |
                       (static_cast<uint64_t>(read_u32_le(ep + 4u)) << 32u);
    const uint32_t sig_off = read_u32_le(ep + 8u);
    if (idx > 0u && h < prev_sel_hash) return HEX_ERR_INVALID_ARG;
    prev_sel_hash = h;

    if (sig_off < hdr.sig_pool_off || (sig_off & 3u) != 0u ||
        sig_off > hdr.str_pool_off || hdr.str_pool_off - sig_off < 12u) {
      return HEX_ERR_INVALID_ARG;
    }
    const uint8_t arity = blob[sig_off + 9u];
    if (arity > HEX_TIL1_MAX_ARITY) return HEX_ERR_INVALID_ARG;
    if (hdr.str_pool_off - sig_off < 12u + static_cast<uint32_t>(arity) * 4u) {
      return HEX_ERR_INVALID_ARG;
    }
    const uint32_t name_off = read_u32_le(blob + sig_off);
    if (!validate_nul_string(blob, hdr.str_pool_off, str_pool_end, name_off)) {
      return HEX_ERR_INVALID_ARG;
    }
  }

  // 6. Validate TypeDesc entries
  for (uint32_t i = 0u; i < hdr.type_count; ++i) {
    const uint8_t* tp = blob + type_off + i * 12u;
    const uint32_t name_off = read_u32_le(tp + 8u);
    if (!validate_nul_string(blob, hdr.str_pool_off, str_pool_end, name_off)) {
      return HEX_ERR_INVALID_ARG;
    }
  }

  // 7. Allocate arena slot, copy blob, and capture slot generation
  uint8_t* dst = hex_type_arena_alloc_slot(slot_id, len);
  if (dst == nullptr) return HEX_ERR_OOM;
  if (dst != blob) {
    hex::mem_move(dst, blob, len);
  }

  HexTypeArenaSlotInfo slot_info = {};
  if (hex_type_arena_slot_info(slot_id, &slot_info) != HEX_OK) {
    return HEX_ERR_INTERNAL;
  }

  MountedTilSlot& slot = g_til.slots[slot_id];
  slot.mounted = true;
  slot.data = dst;
  slot.len = len;
  slot.arena_generation = slot_info.generation;
  slot.tid_base = (tid_base == 0u && slot_id == HEX_ARENA_SLOT_CORE_TIL) ? TIL_CORE_MIN : tid_base;
  slot.tid_cap = tid_cap;
  slot.header = hdr;
  slot.hash_index_off = HEX_TIL1_HASH_INDEX_OFFSET;
  slot.sel_index_off = sel_off;
  slot.type_desc_off = type_off;
  slot.str_pool_end = str_pool_end;

  return HEX_OK;
}

HEX_WASM_EXPORT("hex_til_load")
HexStatus hex_til_load(const uint8_t* blob, uint32_t len) {
  return hex_til_mount(HEX_ARENA_SLOT_CORE_TIL, blob, len, TIL_CORE_MIN,
                       static_cast<uint16_t>(TIL_CORE_MAX - TIL_CORE_MIN + 1u));
}

HEX_WASM_EXPORT("hex_til_mount_pack")
HexStatus hex_til_mount_pack(
    uint32_t slot_id,
    uint16_t tid_base,
    uint16_t tid_cap,
    const uint8_t* blob,
    uint32_t len) {
  if (slot_id < 1u || slot_id > 3u) return HEX_ERR_INVALID_ARG;
  return hex_til_mount(slot_id, blob, len, tid_base, tid_cap);
}

HEX_WASM_EXPORT("hex_til_unmount_pack")
HexStatus hex_til_unmount_pack(uint32_t slot_id) {
  if (slot_id >= kTilSlotCount) return HEX_ERR_INVALID_ARG;
  hex::mem_set(&g_til.slots[slot_id], 0, sizeof(MountedTilSlot));
  return hex_type_arena_reset_slot(slot_id);
}

HEX_WASM_EXPORT("hex_til_purge_packs")
void hex_til_purge_packs(void) {
  hex_til_unmount_pack(HEX_ARENA_SLOT_PACK_A);
  hex_til_unmount_pack(HEX_ARENA_SLOT_PACK_B);
}

HEX_WASM_EXPORT("hex_til_lookup_symbol")
HexStatus hex_til_lookup_symbol(
    const uint8_t* sym,
    uint32_t len,
    uint32_t slot_mask,
    uint32_t lookup_flags,
    struct HexTilSigRecord64* out_rec64) {
  if (sym == nullptr || len == 0u || out_rec64 == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  const uint32_t eff_mask = (slot_mask == 0u) ? 0x0Fu : (slot_mask & 0x0Fu);
  const uint32_t eff_flags = (lookup_flags == 0u) ? HEX_TIL_LOOKUP_DEFAULT : lookup_flags;

  // Stage 1: Exact raw match (User Header > Pack B > Pack A > Core TIL)
  if (try_lookup_with_priority(sym, len, eff_mask, out_rec64)) {
    g_til.lookup_hits += 1u;
    return HEX_OK;
  }

  // Stage 2 & 3: Underscore stripping for non-mangled C symbols (§3.2)
  if ((eff_flags & HEX_TIL_LOOKUP_RAW_ONLY) == 0u && !is_mangled_prefix(sym, len)) {
    if ((eff_flags & HEX_TIL_LOOKUP_ALLOW_STRIP1) != 0u && len > 1u && sym[0] == '_') {
      if (try_lookup_with_priority(sym + 1u, len - 1u, eff_mask, out_rec64)) {
        g_til.lookup_hits += 1u;
        return HEX_OK;
      }
    }
    if ((eff_flags & HEX_TIL_LOOKUP_ALLOW_STRIP_ALL) != 0u) {
      uint32_t skip = 0u;
      while (skip < len && sym[skip] == '_') skip += 1u;
      if (skip > 1u && skip < len) {
        if (try_lookup_with_priority(sym + skip, len - skip, eff_mask, out_rec64)) {
          g_til.lookup_hits += 1u;
          return HEX_OK;
        }
      }
    }
  }

  g_til.lookup_misses += 1u;
  return HEX_ERR_RESOURCE_LIMIT;
}

HEX_WASM_EXPORT("hex_til_lookup")
HexStatus hex_til_lookup(
    const uint8_t* sym,
    uint32_t len,
    uint32_t slot_mask,
    uint32_t lookup_flags,
    uint8_t* out_rec64) {
  if (out_rec64 == nullptr) return HEX_ERR_INVALID_ARG;
  HexTilSigRecord64 tmp = {};
  const HexStatus st = hex_til_lookup_symbol(sym, len, slot_mask, lookup_flags, &tmp);
  if (st == HEX_OK) {
    hex::mem_copy(out_rec64, &tmp, sizeof(tmp));
  }
  return st;
}

HEX_WASM_EXPORT("hex_til_lookup_selector")
HexStatus hex_til_lookup_selector(
    const uint8_t* key,
    uint32_t len,
    uint32_t slot_mask,
    uint8_t* out_rec64) {
  if (key == nullptr || len == 0u || out_rec64 == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  const uint32_t eff_mask = (slot_mask == 0u) ? 0x0Fu : (slot_mask & 0x0Fu);
  HexTilSigRecord64 tmp = {};

  for (int32_t s = 3; s >= 0; --s) {
    const uint32_t sid = static_cast<uint32_t>(s);
    if ((eff_mask & (1u << sid)) == 0u) continue;
    if (lookup_selector_in_slot(sid, key, len, &tmp)) {
      hex::mem_copy(out_rec64, &tmp, sizeof(tmp));
      g_til.lookup_hits += 1u;
      return HEX_OK;
    }
  }

  g_til.lookup_misses += 1u;
  return HEX_ERR_RESOURCE_LIMIT;
}

HEX_WASM_EXPORT("hex_til_lookup_type")
HexStatus hex_til_lookup_type(uint16_t tid, struct HexTypeRecord* out_rec24) {
  if (out_rec24 == nullptr || tid == TIL_TYPE_UNKNOWN || tid == TIL_TYPE_INVALID) {
    return HEX_ERR_INVALID_ARG;
  }

  for (int32_t s = 3; s >= 0; --s) {
    const uint32_t sid = static_cast<uint32_t>(s);
    const uint8_t* tp = find_type_in_slot(sid, tid);
    if (tp == nullptr) continue;

    const MountedTilSlot& slot = g_til.slots[sid];
    const uint16_t kind = read_u16_le(tp + 0u);
    const uint8_t bits = tp[2u];
    const uint8_t qualifiers = tp[3u];
    const uint16_t raw_pointee = read_u16_le(tp + 4u);
    const uint32_t name_off = read_u32_le(tp + 8u);

    uint8_t aux = 0u;
    if (kind == HEX_TYPE_KIND_SCALAR) {
      if ((qualifiers & (1u << 3u)) != 0u) aux = HEX_AUX_SCALAR_BITMASK;
      else if ((qualifiers & (1u << 2u)) != 0u) aux = HEX_AUX_SCALAR_ENUM;
    }

    hex::mem_set(out_rec24, 0, sizeof(HexTypeRecord));
    out_rec24->type_id = hex_type_make(
        tid, 0u, (qualifiers & 1u) != 0u ? 1u : 0u, 0u, static_cast<uint8_t>(kind & 7u), aux);
    out_rec24->name_off = name_off;
    out_rec24->byte_size = static_cast<uint32_t>(bits) >> 3u;
    out_rec24->first_member_idx = 0u;
    out_rec24->member_count = 0u;
    out_rec24->pointee_tid = remap_tid(slot, raw_pointee);
    out_rec24->kind = static_cast<uint8_t>(kind & 0xFFu);
    out_rec24->align_log2 = 0u;
    out_rec24->qualifiers = qualifiers;
    out_rec24->slot_id = static_cast<uint8_t>(sid);
    return HEX_OK;
  }

  return HEX_ERR_RESOURCE_LIMIT;
}

HEX_WASM_EXPORT("hex_til_get_type")
HexStatus hex_til_get_type(uint16_t tid, uint8_t* out_desc12, uint8_t* out_slot_id) {
  if (out_desc12 == nullptr || tid == TIL_TYPE_UNKNOWN || tid == TIL_TYPE_INVALID) {
    return HEX_ERR_INVALID_ARG;
  }
  for (int32_t s = 3; s >= 0; --s) {
    const uint32_t sid = static_cast<uint32_t>(s);
    const uint8_t* tp = find_type_in_slot(sid, tid);
    if (tp == nullptr) continue;

    const MountedTilSlot& slot = g_til.slots[sid];
    hex::mem_copy(out_desc12, tp, 12u);
    const uint16_t remapped_pointee = remap_tid(slot, read_u16_le(tp + 4u));
    out_desc12[4u] = static_cast<uint8_t>(remapped_pointee & 0xFFu);
    out_desc12[5u] = static_cast<uint8_t>((remapped_pointee >> 8u) & 0xFFu);
    if (out_slot_id != nullptr) *out_slot_id = static_cast<uint8_t>(sid);
    return HEX_OK;
  }
  return HEX_ERR_RESOURCE_LIMIT;
}

HEX_WASM_EXPORT("hex_til_get_type_name")
HexStatus hex_til_get_type_name(
    uint16_t tid,
    uint8_t* out_utf8,
    uint32_t cap,
    uint32_t* out_len) {
  if (out_len == nullptr || tid == TIL_TYPE_UNKNOWN || tid == TIL_TYPE_INVALID) {
    return HEX_ERR_INVALID_ARG;
  }
  for (int32_t s = 3; s >= 0; --s) {
    const uint32_t sid = static_cast<uint32_t>(s);
    const uint8_t* tp = find_type_in_slot(sid, tid);
    if (tp == nullptr) continue;

    const MountedTilSlot& slot = g_til.slots[sid];
    const uint32_t name_off = read_u32_le(tp + 8u);
    const uint32_t abs_off = slot.header.str_pool_off + name_off;
    uint32_t slen = 0u;
    while (abs_off + slen < slot.str_pool_end && slot.data[abs_off + slen] != 0u) {
      slen += 1u;
    }
    *out_len = slen;
    if (out_utf8 != nullptr && cap > 0u) {
      const uint32_t copy_len = (slen < cap) ? slen : cap;
      hex::mem_copy(out_utf8, slot.data + abs_off, copy_len);
    }
    return HEX_OK;
  }
  return HEX_ERR_RESOURCE_LIMIT;
}

HEX_WASM_EXPORT("hex_til_stats")
HexStatus hex_til_stats(struct HexTilStats* out_stats) {
  if (out_stats == nullptr) return HEX_ERR_INVALID_ARG;
  hex::mem_set(out_stats, 0, sizeof(HexTilStats));
  for (uint32_t i = 0u; i < kTilSlotCount; ++i) {
    if (!is_slot_live(i)) continue;
    const MountedTilSlot& slot = g_til.slots[i];
    out_stats->mounted_slot_mask |= (1u << i);
    out_stats->total_entries += slot.header.entry_count;
    out_stats->total_selectors += slot.header.sel_count;
    out_stats->total_types += slot.header.type_count;
    out_stats->total_bytes += slot.len;
  }
  out_stats->lookup_hits = g_til.lookup_hits;
  out_stats->lookup_misses = g_til.lookup_misses;
  return HEX_OK;
}

}  // extern "C"
