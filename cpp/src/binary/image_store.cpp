#include "image_store.hpp"

namespace {

constexpr uint32_t kMaxSlots = 64u;
constexpr uint32_t kMaxSections = 4096u;
constexpr uint32_t kMaxMachoCmds = 4096u;
constexpr uint32_t kMaxFatSlices = 64u;
constexpr uint32_t kMaxElfPhdrs = 4096u;
constexpr size_t kScratchCap = 1024u * 1024u;       // 1 MiB fixed
constexpr size_t kDefaultImageCap = 8u * 1024u * 1024u;

#if defined(HEX_UNIFIED_WASM)
// Unified WASM builds inject image & scratch arenas via bind_global_arenas().
#elif defined(__wasm__)
extern "C" unsigned char __heap_base;
#else
alignas(16) static uint8_t g_native_scratch_buf[kScratchCap];
alignas(16) static uint8_t g_native_image_buf[kDefaultImageCap];
#endif

static hex::Arena g_default_scratch_arena;
static hex::Arena g_default_image_arena;
static hex::Arena* g_active_scratch_arena = &g_default_scratch_arena;
static hex::Arena* g_active_image_arena = &g_default_image_arena;
static bool g_arenas_initialized = false;
static bool g_externally_bound = false;

void ensure_arenas() {
  if (g_externally_bound) return;
  if (g_arenas_initialized) return;
#if defined(HEX_UNIFIED_WASM)
  g_default_scratch_arena.init_fixed(nullptr, 0u);
  g_default_image_arena.init_fixed(nullptr, 0u);
#elif defined(__wasm__)
  uint8_t* base = &__heap_base;
  g_default_scratch_arena.init_fixed(base, kScratchCap);
  g_default_image_arena.init_external(base + kScratchCap, kDefaultImageCap, true);
#else
  g_default_scratch_arena.init_fixed(g_native_scratch_buf, kScratchCap);
  g_default_image_arena.init_fixed(g_native_image_buf, kDefaultImageCap);
#endif
  g_active_scratch_arena = &g_default_scratch_arena;
  g_active_image_arena = &g_default_image_arena;
  g_arenas_initialized = true;
}

struct ImageSlot {
  bool in_use;
  uint32_t generation;
  HexImageInfo info;
  const uint8_t* raw_data;
  uint32_t raw_len;
  HexSectionInfo* sections;
  uint32_t section_count;
};

static ImageSlot g_slots[kMaxSlots];

inline HexImageHandle make_handle(uint32_t idx, uint32_t gen) {
  return (gen << 8u) | (idx & 0xffu);
}

inline ImageSlot* resolve_slot(HexImageHandle h) {
  if (h == 0u) return nullptr;
  const uint32_t idx = h & 0xffu;
  const uint32_t gen = h >> 8u;
  if (idx >= kMaxSlots || gen == 0u) return nullptr;
  ImageSlot& slot = g_slots[idx];
  if (!slot.in_use || slot.generation != gen) return nullptr;
  return &slot;
}

// Overflow-safe arithmetic and interval helpers
inline bool add_u64_checked(uint64_t a, uint64_t b, uint64_t* out) {
  if (b > UINT64_MAX - a) return false;
  *out = a + b;
  return true;
}

inline bool mul_u64_checked(uint64_t a, uint64_t b, uint64_t* out) {
  if (a != 0u && b > UINT64_MAX / a) return false;
  *out = a * b;
  return true;
}

// Closed-interval range validity: [start, start + size - 1] fits in uint64_t.
// Allows addr + size == 2^64 (e.g. start=0xFFFFFFFFFFFFF000, size=0x1000) without wraparound!
// Rejects only strictly > 2^64 (i.e., size - 1 > UINT64_MAX - start).
inline bool range_fits_u64_closed(uint64_t start, uint64_t size) {
  if (size == 0u) return true;
  return (size - 1u) <= (UINT64_MAX - start);
}

inline bool closed_intervals_overlap(
    uint64_t a_start, uint64_t a_size,
    uint64_t b_start, uint64_t b_size) {
  if (a_size == 0u || b_size == 0u) return false;
  if (!range_fits_u64_closed(a_start, a_size) || !range_fits_u64_closed(b_start, b_size)) {
    return true;  // fail-closed
  }
  const uint64_t a_end = a_start + (a_size - 1u);
  const uint64_t b_end = b_start + (b_size - 1u);
  return a_start <= b_end && b_start <= a_end;
}

// Bounds-checked integer readers
inline bool read_u16_le(const uint8_t* p, uint32_t len, uint32_t off, uint16_t* out) {
  if (len < 2u || off > len - 2u) return false;
  *out = static_cast<uint16_t>(
      static_cast<uint16_t>(p[off]) |
      (static_cast<uint16_t>(p[off + 1u]) << 8u));
  return true;
}

inline bool read_u16_be(const uint8_t* p, uint32_t len, uint32_t off, uint16_t* out) {
  if (len < 2u || off > len - 2u) return false;
  *out = static_cast<uint16_t>(
      (static_cast<uint16_t>(p[off]) << 8u) |
      static_cast<uint16_t>(p[off + 1u]));
  return true;
}

inline bool read_u32_le(const uint8_t* p, uint32_t len, uint32_t off, uint32_t* out) {
  if (len < 4u || off > len - 4u) return false;
  *out = static_cast<uint32_t>(p[off]) |
         (static_cast<uint32_t>(p[off + 1u]) << 8u) |
         (static_cast<uint32_t>(p[off + 2u]) << 16u) |
         (static_cast<uint32_t>(p[off + 3u]) << 24u);
  return true;
}

inline bool read_u32_be(const uint8_t* p, uint32_t len, uint32_t off, uint32_t* out) {
  if (len < 4u || off > len - 4u) return false;
  *out = (static_cast<uint32_t>(p[off]) << 24u) |
         (static_cast<uint32_t>(p[off + 1u]) << 16u) |
         (static_cast<uint32_t>(p[off + 2u]) << 8u) |
         static_cast<uint32_t>(p[off + 3u]);
  return true;
}

inline bool read_u64_le(const uint8_t* p, uint32_t len, uint32_t off, uint64_t* out) {
  uint32_t lo = 0u, hi = 0u;
  if (!read_u32_le(p, len, off, &lo) || !read_u32_le(p, len, off + 4u, &hi)) return false;
  *out = static_cast<uint64_t>(lo) | (static_cast<uint64_t>(hi) << 32u);
  return true;
}

inline bool read_u64_be(const uint8_t* p, uint32_t len, uint32_t off, uint64_t* out) {
  uint32_t hi = 0u, lo = 0u;
  if (!read_u32_be(p, len, off, &hi) || !read_u32_be(p, len, off + 4u, &lo)) return false;
  *out = (static_cast<uint64_t>(hi) << 32u) | static_cast<uint64_t>(lo);
  return true;
}

inline bool read_u16(const uint8_t* p, uint32_t len, uint32_t off, bool le, uint16_t* out) {
  return le ? read_u16_le(p, len, off, out) : read_u16_be(p, len, off, out);
}

inline bool read_u32(const uint8_t* p, uint32_t len, uint32_t off, bool le, uint32_t* out) {
  return le ? read_u32_le(p, len, off, out) : read_u32_be(p, len, off, out);
}

inline bool read_u64(const uint8_t* p, uint32_t len, uint32_t off, bool le, uint64_t* out) {
  return le ? read_u64_le(p, len, off, out) : read_u64_be(p, len, off, out);
}

void copy_fixed_str(char* dst, size_t dst_cap, const uint8_t* src, size_t max_src) {
  if (dst_cap == 0u) return;
  size_t i = 0u;
  while (i + 1u < dst_cap && i < max_src && src[i] != 0u) {
    dst[i] = static_cast<char>(src[i]);
    ++i;
  }
  dst[i] = '\0';
}

void copy_cstr_bounded(char* dst, size_t dst_cap, const uint8_t* base, uint32_t total_len, uint32_t off) {
  if (dst_cap == 0u) return;
  if (off >= total_len) {
    dst[0] = '\0';
    return;
  }
  size_t i = 0u;
  while (i + 1u < dst_cap && (off + i) < total_len && base[off + i] != 0u) {
    dst[i] = static_cast<char>(base[off + i]);
    ++i;
  }
  dst[i] = '\0';
}

void write_u32_name(char* dst, size_t dst_cap, const char* prefix, uint32_t idx) {
  size_t pos = 0u;
  while (prefix[pos] != '\0' && pos + 1u < dst_cap) {
    dst[pos] = prefix[pos];
    ++pos;
  }
  char digits[16];
  size_t d = 0u;
  uint32_t v = idx;
  if (v == 0u) {
    digits[d++] = '0';
  } else {
    while (v > 0u && d < sizeof(digits)) {
      digits[d++] = static_cast<char>('0' + (v % 10u));
      v /= 10u;
    }
  }
  while (d > 0u && pos + 1u < dst_cap) {
    dst[pos++] = digits[--d];
  }
  dst[pos] = '\0';
}

// ============================================================================
// Mach-O Parser (32/64/Fat)
// ============================================================================

uint32_t macho_cpu_to_arch(uint32_t cputype) {
  switch (cputype) {
    case 0x0100000Cu: return HEX_ARCH_ARM64;
    case 0x0200000Cu: return HEX_ARCH_ARM64_32;
    case 0x01000007u: return HEX_ARCH_X86_64;
    case 0x00000007u: return HEX_ARCH_X86;
    case 0x0000000Cu: return HEX_ARCH_ARM;
    case 0x01000012u: return HEX_ARCH_PPC64;
    case 0x00000012u: return HEX_ARCH_PPC;
    default: return HEX_ARCH_UNKNOWN;
  }
}

struct SegmentSpan {
  uint64_t vmaddr;
  uint64_t vmsize;
};

HexStatus parse_macho_single(
    const uint8_t* data,
    uint32_t len,
    HexImageInfo* out_info,
    hex::Vec<HexSectionInfo>& out_secs) {
  uint32_t magic = 0u;
  if (!read_u32_le(data, len, 0u, &magic)) return HEX_ERR_INVALID_ARG;

  bool is64 = false;
  bool le = true;
  if (magic == 0xFEEDFACFu) {
    is64 = true;
    le = true;
  } else if (magic == 0xCFFAEDFEu) {
    is64 = true;
    le = false;
  } else if (magic == 0xFEEDFACEu) {
    is64 = false;
    le = true;
  } else if (magic == 0xCEFAEDFEu) {
    is64 = false;
    le = false;
  } else {
    return HEX_ERR_INVALID_ARG;
  }

  const uint32_t hdr_size = is64 ? 32u : 28u;
  if (len < hdr_size) return HEX_ERR_INVALID_ARG;

  uint32_t cputype = 0u, ncmds = 0u, sizeofcmds = 0u;
  if (!read_u32(data, len, 4u, le, &cputype) ||
      !read_u32(data, len, 16u, le, &ncmds) ||
      !read_u32(data, len, 20u, le, &sizeofcmds)) {
    return HEX_ERR_INVALID_ARG;
  }
  if (ncmds > kMaxMachoCmds) return HEX_ERR_RESOURCE_LIMIT;
  if (sizeofcmds > len - hdr_size) return HEX_ERR_INVALID_ARG;

  out_info->format = HEX_FORMAT_MACHO;
  out_info->arch = macho_cpu_to_arch(cputype);
  out_info->bits = is64 ? 64u : 32u;
  out_info->endian = le ? HEX_ENDIAN_LITTLE : HEX_ENDIAN_BIG;
  out_info->entry_point = 0u;
  out_info->image_base = 0u;

  hex::Vec<SegmentSpan> segs(g_active_scratch_arena);
  uint64_t text_vmaddr = 0u;
  bool has_text_vmaddr = false;
  uint64_t main_entryoff = 0u;
  bool has_lc_main = false;

  uint32_t off = hdr_size;
  const uint32_t cmds_end = hdr_size + sizeofcmds;
  for (uint32_t ci = 0u; ci < ncmds; ++ci) {
    if (cmds_end - off < 8u) return HEX_ERR_INVALID_ARG;
    uint32_t cmd = 0u, cmdsize = 0u;
    if (!read_u32(data, len, off, le, &cmd) ||
        !read_u32(data, len, off + 4u, le, &cmdsize)) {
      return HEX_ERR_INVALID_ARG;
    }
    if (cmdsize < 8u || cmdsize > cmds_end - off) return HEX_ERR_INVALID_ARG;

    if (cmd == 0x19u || cmd == 0x01u) {
      // LC_SEGMENT_64 (0x19) or LC_SEGMENT (0x01)
      const bool seg64 = (cmd == 0x19u);
      const uint32_t seg_hdr = seg64 ? 72u : 56u;
      const uint32_t sec_stride = seg64 ? 80u : 68u;
      if (cmdsize < seg_hdr) return HEX_ERR_INVALID_ARG;

      uint64_t vmaddr = 0u, vmsize = 0u, fileoff = 0u, filesize = 0u;
      uint32_t maxprot = 0u, initprot = 0u, nsects = 0u;
      if (seg64) {
        if (!read_u64(data, len, off + 24u, le, &vmaddr) ||
            !read_u64(data, len, off + 32u, le, &vmsize) ||
            !read_u64(data, len, off + 40u, le, &fileoff) ||
            !read_u64(data, len, off + 48u, le, &filesize) ||
            !read_u32(data, len, off + 56u, le, &maxprot) ||
            !read_u32(data, len, off + 60u, le, &initprot) ||
            !read_u32(data, len, off + 64u, le, &nsects)) {
          return HEX_ERR_INVALID_ARG;
        }
      } else {
        uint32_t vm32 = 0u, vs32 = 0u, fo32 = 0u, fs32 = 0u;
        if (!read_u32(data, len, off + 24u, le, &vm32) ||
            !read_u32(data, len, off + 28u, le, &vs32) ||
            !read_u32(data, len, off + 32u, le, &fo32) ||
            !read_u32(data, len, off + 36u, le, &fs32) ||
            !read_u32(data, len, off + 40u, le, &maxprot) ||
            !read_u32(data, len, off + 44u, le, &initprot) ||
            !read_u32(data, len, off + 48u, le, &nsects)) {
          return HEX_ERR_INVALID_ARG;
        }
        vmaddr = vm32;
        vmsize = vs32;
        fileoff = fo32;
        filesize = fs32;
      }
      (void)maxprot;

      // Overflow-safe file range check
      if (filesize > 0u) {
        uint64_t fend = 0u;
        if (!add_u64_checked(fileoff, filesize, &fend) || fend > len) {
          return HEX_ERR_INVALID_ARG;
        }
      }

      // Overflow-safe VM range & ambiguous overlap check (closed interval; handles addr + size == 2^64)
      if (vmsize > 0u) {
        if (!range_fits_u64_closed(vmaddr, vmsize)) return HEX_ERR_INVALID_ARG;
        for (size_t si = 0u; si < segs.size(); ++si) {
          if (closed_intervals_overlap(segs[si].vmaddr, segs[si].vmsize, vmaddr, vmsize)) {
            return HEX_ERR_INVALID_ARG;
          }
        }
        if (!segs.push_back(SegmentSpan{vmaddr, vmsize})) return HEX_ERR_OOM;
      }

      char segname[32];
      copy_fixed_str(segname, sizeof(segname), data + off + 8u, 16u);
      if (hex::mem_cmp(segname, "__TEXT", 6u) == 0 && segname[6] == '\0') {
        text_vmaddr = vmaddr;
        has_text_vmaddr = true;
        out_info->image_base = vmaddr;
      }

      uint64_t need_sec_bytes = 0u;
      if (!mul_u64_checked(nsects, sec_stride, &need_sec_bytes) ||
          need_sec_bytes > static_cast<uint64_t>(cmdsize - seg_hdr)) {
        return HEX_ERR_INVALID_ARG;
      }
      if (out_secs.size() + nsects > kMaxSections) return HEX_ERR_RESOURCE_LIMIT;

      for (uint32_t si = 0u; si < nsects; ++si) {
        const uint32_t soff = off + seg_hdr + si * sec_stride;
        HexSectionInfo sec{};
        copy_fixed_str(sec.name, sizeof(sec.name), data + soff, 16u);
        copy_fixed_str(sec.segname, sizeof(sec.segname), data + soff + 16u, 16u);

        uint64_t saddr = 0u, ssize = 0u;
        uint32_t sfoff = 0u, sflags = 0u;
        if (seg64) {
          if (!read_u64(data, len, soff + 32u, le, &saddr) ||
              !read_u64(data, len, soff + 40u, le, &ssize) ||
              !read_u32(data, len, soff + 48u, le, &sfoff) ||
              !read_u32(data, len, soff + 64u, le, &sflags)) {
            return HEX_ERR_INVALID_ARG;
          }
        } else {
          uint32_t sa32 = 0u, ss32 = 0u;
          if (!read_u32(data, len, soff + 32u, le, &sa32) ||
              !read_u32(data, len, soff + 36u, le, &ss32) ||
              !read_u32(data, len, soff + 40u, le, &sfoff) ||
              !read_u32(data, len, soff + 56u, le, &sflags)) {
            return HEX_ERR_INVALID_ARG;
          }
          saddr = sa32;
          ssize = ss32;
        }

        const uint32_t stype = sflags & 0xffu;
        const bool is_zerofill = (stype == 1u || stype == 0x0Cu || stype == 0x12u);
        if (!is_zerofill && ssize > 0u) {
          uint64_t sfend = 0u;
          if (!add_u64_checked(static_cast<uint64_t>(sfoff), ssize, &sfend) || sfend > len) {
            return HEX_ERR_INVALID_ARG;
          }
        }

        sec.va = saddr;
        sec.size = ssize;
        sec.file_offset = is_zerofill ? 0u : static_cast<uint64_t>(sfoff);
        sec.file_size = is_zerofill ? 0u : ssize;
        sec.flags = sflags;
        sec.is_read = (initprot & 1u) ? 1u : 0u;
        sec.is_write = (initprot & 2u) ? 1u : 0u;
        sec.is_exec = ((initprot & 4u) || (sflags & 0x80000000u) || (sflags & 0x00000400u)) ? 1u : 0u;
        sec.is_nobits = is_zerofill ? 1u : 0u;

        if (!out_secs.push_back(sec)) return HEX_ERR_OOM;
      }
    } else if (cmd == 0x80000028u) {
      // LC_MAIN
      if (cmdsize < 24u) return HEX_ERR_INVALID_ARG;
      if (!read_u64(data, len, off + 8u, le, &main_entryoff)) return HEX_ERR_INVALID_ARG;
      has_lc_main = true;
    }

    off += cmdsize;
  }

  if (has_lc_main) {
    if (has_text_vmaddr) {
      uint64_t ep = 0u;
      if (!add_u64_checked(text_vmaddr, main_entryoff, &ep)) return HEX_ERR_INVALID_ARG;
      out_info->entry_point = ep;
    } else {
      out_info->entry_point = main_entryoff;
    }
  }
  return HEX_OK;
}

struct FatSliceMeta {
  uint32_t cputype;
  uint32_t cpusubtype;
  uint64_t offset;
  uint64_t size;
  uint32_t align;
};

HexStatus parse_macho_fat(
    const uint8_t* data,
    uint32_t len,
    HexImageInfo* out_info,
    hex::Vec<HexSectionInfo>& out_secs) {
  uint32_t magic_be = 0u;
  if (!read_u32_be(data, len, 0u, &magic_be)) return HEX_ERR_INVALID_ARG;
  const bool fat64 = (magic_be == 0xCAFEBABFu);
  if (!fat64 && magic_be != 0xCAFEBABEu) return HEX_ERR_INVALID_ARG;

  uint32_t nfat = 0u;
  if (!read_u32_be(data, len, 4u, &nfat)) return HEX_ERR_INVALID_ARG;
  if (nfat == 0u || nfat > kMaxFatSlices) return HEX_ERR_INVALID_ARG;

  const uint32_t entry_stride = fat64 ? 32u : 20u;
  uint64_t table_bytes = 0u;
  if (!mul_u64_checked(nfat, entry_stride, &table_bytes)) return HEX_ERR_INVALID_ARG;
  uint64_t hdr_end = 0u;
  if (!add_u64_checked(8u, table_bytes, &hdr_end) || hdr_end > len) return HEX_ERR_INVALID_ARG;

  hex::Vec<FatSliceMeta> slices(g_active_scratch_arena);
  if (!slices.reserve(nfat)) return HEX_ERR_OOM;

  for (uint32_t i = 0u; i < nfat; ++i) {
    const uint32_t eoff = 8u + i * entry_stride;
    FatSliceMeta sm{};
    if (fat64) {
      if (!read_u32_be(data, len, eoff + 0u, &sm.cputype) ||
          !read_u32_be(data, len, eoff + 4u, &sm.cpusubtype) ||
          !read_u64_be(data, len, eoff + 8u, &sm.offset) ||
          !read_u64_be(data, len, eoff + 16u, &sm.size) ||
          !read_u32_be(data, len, eoff + 24u, &sm.align)) {
        return HEX_ERR_INVALID_ARG;
      }
    } else {
      uint32_t off32 = 0u, sz32 = 0u;
      if (!read_u32_be(data, len, eoff + 0u, &sm.cputype) ||
          !read_u32_be(data, len, eoff + 4u, &sm.cpusubtype) ||
          !read_u32_be(data, len, eoff + 8u, &off32) ||
          !read_u32_be(data, len, eoff + 12u, &sz32) ||
          !read_u32_be(data, len, eoff + 16u, &sm.align)) {
        return HEX_ERR_INVALID_ARG;
      }
      sm.offset = off32;
      sm.size = sz32;
    }

    // 1. Strict align validation (align >= 64 rejected; offset must be aligned to 1 << align)
    if (sm.align >= 64u) return HEX_ERR_INVALID_ARG;
    if (sm.align > 0u) {
      const uint64_t align_mask = (1ULL << sm.align) - 1ULL;
      if ((sm.offset & align_mask) != 0u) return HEX_ERR_INVALID_ARG;
    }

    // 2. Slice bounds check (must start after fat header, fit within file, >= Mach-O header)
    if (sm.offset < hdr_end || sm.size < 28u) return HEX_ERR_INVALID_ARG;
    uint64_t send = 0u;
    if (!add_u64_checked(sm.offset, sm.size, &send) || send > len) return HEX_ERR_INVALID_ARG;

    // 3. Pairwise file-range overlap & duplicate (cputype, cpusubtype) check
    for (size_t j = 0u; j < slices.size(); ++j) {
      if (closed_intervals_overlap(slices[j].offset, slices[j].size, sm.offset, sm.size)) {
        return HEX_ERR_INVALID_ARG;
      }
      if (slices[j].cputype == sm.cputype && slices[j].cpusubtype == sm.cpusubtype) {
        return HEX_ERR_INVALID_ARG;
      }
    }

    // 4. Outer Fat (cputype, cpusubtype) must match inner Mach-O header (cputype, cpusubtype)
    const uint8_t* sp = data + static_cast<size_t>(sm.offset);
    const uint32_t slen = static_cast<uint32_t>(sm.size);
    uint32_t inner_magic = 0u;
    if (!read_u32_le(sp, slen, 0u, &inner_magic)) return HEX_ERR_INVALID_ARG;
    bool inner_le = true;
    if (inner_magic == 0xFEEDFACFu || inner_magic == 0xFEEDFACEu) {
      inner_le = true;
    } else if (inner_magic == 0xCFFAEDFEu || inner_magic == 0xCEFAEDFEu) {
      inner_le = false;
    } else {
      return HEX_ERR_INVALID_ARG;
    }
    uint32_t inner_cpu = 0u, inner_sub = 0u;
    if (!read_u32(sp, slen, 4u, inner_le, &inner_cpu) ||
        !read_u32(sp, slen, 8u, inner_le, &inner_sub)) {
      return HEX_ERR_INVALID_ARG;
    }
    if (inner_cpu != sm.cputype || inner_sub != sm.cpusubtype) {
      return HEX_ERR_INVALID_ARG;
    }

    if (!slices.push_back(sm)) return HEX_ERR_OOM;
  }

  // Select preferred slice: ARM64 > X86_64 > first
  size_t chosen = 0u;
  for (size_t i = 0u; i < slices.size(); ++i) {
    if (slices[i].cputype == 0x0100000Cu) {
      chosen = i;
      break;
    }
    if (slices[i].cputype == 0x01000007u && slices[chosen].cputype != 0x0100000Cu) {
      chosen = i;
    }
  }

  const FatSliceMeta& sel = slices[chosen];
  HexStatus st = parse_macho_single(
      data + static_cast<size_t>(sel.offset),
      static_cast<uint32_t>(sel.size),
      out_info,
      out_secs);
  if (st != HEX_OK) return st;

  out_info->is_fat = 1u;
  out_info->fat_slice_count = nfat;
  out_info->slice_offset = sel.offset;
  out_info->slice_size = sel.size;
  return HEX_OK;
}

// ============================================================================
// ELF Parser (32/64, LE/BE)
// ============================================================================

uint32_t elf_machine_to_arch(uint16_t machine, bool is64) {
  switch (machine) {
    case 183u: return HEX_ARCH_ARM64;
    case 62u: return HEX_ARCH_X86_64;
    case 3u: return HEX_ARCH_X86;
    case 40u: return HEX_ARCH_ARM;
    case 243u: return is64 ? HEX_ARCH_RISCV64 : HEX_ARCH_RISCV32;
    case 21u: return HEX_ARCH_PPC64;
    case 20u: return HEX_ARCH_PPC;
    case 8u: return is64 ? HEX_ARCH_MIPS64 : HEX_ARCH_MIPS;
    default: return HEX_ARCH_UNKNOWN;
  }
}

struct ElfPtLoad {
  uint64_t offset;
  uint64_t vaddr;
  uint64_t filesz;
  uint64_t memsz;
};

HexStatus parse_elf(
    const uint8_t* data,
    uint32_t len,
    HexImageInfo* out_info,
    hex::Vec<HexSectionInfo>& out_secs) {
  if (len < 52u) return HEX_ERR_INVALID_ARG;
  if (data[0] != 0x7Fu || data[1] != 'E' || data[2] != 'L' || data[3] != 'F') {
    return HEX_ERR_INVALID_ARG;
  }
  const uint8_t ei_class = data[4];
  const uint8_t ei_data = data[5];
  if ((ei_class != 1u && ei_class != 2u) || (ei_data != 1u && ei_data != 2u)) {
    return HEX_ERR_INVALID_ARG;
  }
  const bool is64 = (ei_class == 2u);
  const bool le = (ei_data == 1u);
  if (is64 && len < 64u) return HEX_ERR_INVALID_ARG;

  uint16_t e_type = 0u, e_machine = 0u;
  uint64_t e_entry = 0u, e_phoff = 0u, e_shoff = 0u;
  uint16_t e_phentsize = 0u, e_phnum = 0u, e_shentsize = 0u, e_shnum = 0u, e_shstrndx = 0u;

  if (!read_u16(data, len, 16u, le, &e_type) ||
      !read_u16(data, len, 18u, le, &e_machine)) {
    return HEX_ERR_INVALID_ARG;
  }

  if (is64) {
    if (!read_u64(data, len, 24u, le, &e_entry) ||
        !read_u64(data, len, 32u, le, &e_phoff) ||
        !read_u64(data, len, 40u, le, &e_shoff) ||
        !read_u16(data, len, 54u, le, &e_phentsize) ||
        !read_u16(data, len, 56u, le, &e_phnum) ||
        !read_u16(data, len, 58u, le, &e_shentsize) ||
        !read_u16(data, len, 60u, le, &e_shnum) ||
        !read_u16(data, len, 62u, le, &e_shstrndx)) {
      return HEX_ERR_INVALID_ARG;
    }
  } else {
    uint32_t en32 = 0u, ph32 = 0u, sh32 = 0u;
    if (!read_u32(data, len, 24u, le, &en32) ||
        !read_u32(data, len, 28u, le, &ph32) ||
        !read_u32(data, len, 32u, le, &sh32) ||
        !read_u16(data, len, 42u, le, &e_phentsize) ||
        !read_u16(data, len, 44u, le, &e_phnum) ||
        !read_u16(data, len, 46u, le, &e_shentsize) ||
        !read_u16(data, len, 48u, le, &e_shnum) ||
        !read_u16(data, len, 50u, le, &e_shstrndx)) {
      return HEX_ERR_INVALID_ARG;
    }
    e_entry = en32;
    e_phoff = ph32;
    e_shoff = sh32;
  }

  out_info->format = HEX_FORMAT_ELF;
  out_info->arch = elf_machine_to_arch(e_machine, is64);
  out_info->bits = is64 ? 64u : 32u;
  out_info->endian = le ? HEX_ENDIAN_LITTLE : HEX_ENDIAN_BIG;
  out_info->entry_point = e_entry;
  out_info->image_base = 0u;

  // Parse PT_LOAD segments
  hex::Vec<ElfPtLoad> loads(g_active_scratch_arena);
  if (e_phnum > 0u) {
    if (e_phnum > kMaxElfPhdrs) return HEX_ERR_RESOURCE_LIMIT;
    const uint32_t min_phent = is64 ? 56u : 32u;
    if (e_phentsize < min_phent) return HEX_ERR_INVALID_ARG;
    uint64_t ph_bytes = 0u, ph_end = 0u;
    if (!mul_u64_checked(e_phnum, e_phentsize, &ph_bytes) ||
        !add_u64_checked(e_phoff, ph_bytes, &ph_end) ||
        ph_end > len) {
      return HEX_ERR_INVALID_ARG;
    }
    bool has_base = false;
    for (uint32_t pi = 0u; pi < e_phnum; ++pi) {
      const uint32_t poff = static_cast<uint32_t>(e_phoff + static_cast<uint64_t>(pi) * e_phentsize);
      uint32_t p_type = 0u;
      if (!read_u32(data, len, poff, le, &p_type)) return HEX_ERR_INVALID_ARG;
      if (p_type != 1u) continue;  // PT_LOAD == 1

      ElfPtLoad seg{};
      if (is64) {
        if (!read_u64(data, len, poff + 8u, le, &seg.offset) ||
            !read_u64(data, len, poff + 16u, le, &seg.vaddr) ||
            !read_u64(data, len, poff + 32u, le, &seg.filesz) ||
            !read_u64(data, len, poff + 40u, le, &seg.memsz)) {
          return HEX_ERR_INVALID_ARG;
        }
      } else {
        uint32_t o32 = 0u, v32 = 0u, f32 = 0u, m32 = 0u;
        if (!read_u32(data, len, poff + 4u, le, &o32) ||
            !read_u32(data, len, poff + 8u, le, &v32) ||
            !read_u32(data, len, poff + 16u, le, &f32) ||
            !read_u32(data, len, poff + 20u, le, &m32)) {
          return HEX_ERR_INVALID_ARG;
        }
        seg.offset = o32;
        seg.vaddr = v32;
        seg.filesz = f32;
        seg.memsz = m32;
      }

      if (seg.filesz > seg.memsz) return HEX_ERR_INVALID_ARG;
      if (seg.filesz > 0u) {
        uint64_t fend = 0u;
        if (!add_u64_checked(seg.offset, seg.filesz, &fend) || fend > len) {
          return HEX_ERR_INVALID_ARG;
        }
      }
      if (!range_fits_u64_closed(seg.vaddr, seg.memsz)) return HEX_ERR_INVALID_ARG;
      if (!has_base || seg.vaddr < out_info->image_base) {
        out_info->image_base = seg.vaddr;
        has_base = true;
      }
      if (!loads.push_back(seg)) return HEX_ERR_OOM;
    }
  }

  // Parse Section Headers
  if (e_shnum == 0u || e_shoff == 0u) return HEX_OK;
  if (e_shnum > kMaxSections) return HEX_ERR_RESOURCE_LIMIT;
  const uint32_t min_shent = is64 ? 64u : 40u;
  if (e_shentsize < min_shent) return HEX_ERR_INVALID_ARG;

  uint64_t sh_bytes = 0u, sh_end = 0u;
  if (!mul_u64_checked(e_shnum, e_shentsize, &sh_bytes) ||
      !add_u64_checked(e_shoff, sh_bytes, &sh_end) ||
      sh_end > len) {
    return HEX_ERR_INVALID_ARG;
  }

  // Locate .shstrtab if valid
  uint64_t strtab_off = 0u, strtab_sz = 0u;
  bool has_strtab = false;
  if (e_shstrndx < e_shnum) {
    const uint32_t st_hdr = static_cast<uint32_t>(e_shoff + static_cast<uint64_t>(e_shstrndx) * e_shentsize);
    if (is64) {
      if (read_u64(data, len, st_hdr + 24u, le, &strtab_off) &&
          read_u64(data, len, st_hdr + 32u, le, &strtab_sz)) {
        uint64_t st_end = 0u;
        if (add_u64_checked(strtab_off, strtab_sz, &st_end) && st_end <= len) {
          has_strtab = true;
        }
      }
    } else {
      uint32_t o32 = 0u, s32 = 0u;
      if (read_u32(data, len, st_hdr + 16u, le, &o32) &&
          read_u32(data, len, st_hdr + 20u, le, &s32)) {
        uint64_t st_end = 0u;
        if (add_u64_checked(o32, s32, &st_end) && st_end <= len) {
          strtab_off = o32;
          strtab_sz = s32;
          has_strtab = true;
        }
      }
    }
  }

  if (!out_secs.reserve(e_shnum)) return HEX_ERR_OOM;

  // Synthetic placement cursor for ET_REL (e_type == 1) with overflow protection
  uint64_t rel_cursor = 0x100000ULL;
  const uint64_t rel_limit = is64 ? UINT64_MAX : 0xFFFFFFFFULL;

  for (uint32_t si = 0u; si < e_shnum; ++si) {
    const uint32_t soff = static_cast<uint32_t>(e_shoff + static_cast<uint64_t>(si) * e_shentsize);
    uint32_t sh_name = 0u, sh_type = 0u;
    uint64_t sh_flags = 0u, sh_addr = 0u, sh_offset = 0u, sh_size = 0u, sh_addralign = 0u;
    if (is64) {
      if (!read_u32(data, len, soff + 0u, le, &sh_name) ||
          !read_u32(data, len, soff + 4u, le, &sh_type) ||
          !read_u64(data, len, soff + 8u, le, &sh_flags) ||
          !read_u64(data, len, soff + 16u, le, &sh_addr) ||
          !read_u64(data, len, soff + 24u, le, &sh_offset) ||
          !read_u64(data, len, soff + 32u, le, &sh_size) ||
          !read_u64(data, len, soff + 48u, le, &sh_addralign)) {
        return HEX_ERR_INVALID_ARG;
      }
    } else {
      uint32_t fl32 = 0u, ad32 = 0u, of32 = 0u, sz32 = 0u, al32 = 0u;
      if (!read_u32(data, len, soff + 0u, le, &sh_name) ||
          !read_u32(data, len, soff + 4u, le, &sh_type) ||
          !read_u32(data, len, soff + 8u, le, &fl32) ||
          !read_u32(data, len, soff + 12u, le, &ad32) ||
          !read_u32(data, len, soff + 16u, le, &of32) ||
          !read_u32(data, len, soff + 20u, le, &sz32) ||
          !read_u32(data, len, soff + 32u, le, &al32)) {
        return HEX_ERR_INVALID_ARG;
      }
      sh_flags = fl32;
      sh_addr = ad32;
      sh_offset = of32;
      sh_size = sz32;
      sh_addralign = al32;
    }

    const bool is_nobits = (sh_type == 8u);  // SHT_NOBITS == 8
    const bool is_alloc = (sh_flags & 2u) != 0u;

    // Strict EOF / overflow validation for non-SHT_NOBITS sections (SHT_NULL == 0 skipped when size==0)
    if (!is_nobits && sh_type != 0u && sh_size > 0u) {
      uint64_t fend = 0u;
      if (!add_u64_checked(sh_offset, sh_size, &fend) || fend > len) {
        return HEX_ERR_INVALID_ARG;
      }
    }

    // PT_LOAD consistency check for SHF_ALLOC non-NOBITS sections when PT_LOADs are present
    if (!is_nobits && is_alloc && sh_size > 0u && !loads.empty()) {
      if (!range_fits_u64_closed(sh_addr, sh_size)) return HEX_ERR_INVALID_ARG;
      for (size_t li = 0u; li < loads.size(); ++li) {
        const ElfPtLoad& seg = loads[li];
        if (seg.memsz == 0u) continue;
        if (closed_intervals_overlap(seg.vaddr, seg.memsz, sh_addr, sh_size)) {
          // If section claims to live inside this PT_LOAD, ensure file mapping is consistent
          if (sh_addr >= seg.vaddr) {
            const uint64_t va_delta = sh_addr - seg.vaddr;
            uint64_t expected_off = 0u;
            if (va_delta < seg.filesz && add_u64_checked(seg.offset, va_delta, &expected_off)) {
              if (sh_offset != expected_off) {
                return HEX_ERR_INVALID_ARG;
              }
            }
          }
          break;
        }
      }
    }

    // ET_REL synthetic placement with overflow / cursor exhaustion guard
    uint64_t effective_va = sh_addr;
    if (e_type == 1u && is_alloc && effective_va == 0u && sh_size > 0u) {
      uint64_t align = (sh_addralign > 16u && sh_addralign <= 0x10000u &&
                        (sh_addralign & (sh_addralign - 1u)) == 0u)
                           ? sh_addralign
                           : 16u;
      uint64_t aligned = rel_cursor;
      const uint64_t rem = aligned & (align - 1u);
      if (rem != 0u) {
        uint64_t pad = align - rem;
        if (pad > rel_limit - aligned) return HEX_ERR_RESOURCE_LIMIT;
        aligned += pad;
      }
      if (sh_size > rel_limit - aligned) return HEX_ERR_RESOURCE_LIMIT;
      effective_va = aligned;
      rel_cursor = aligned + sh_size;
    } else if (sh_size > 0u && !range_fits_u64_closed(effective_va, sh_size)) {
      return HEX_ERR_INVALID_ARG;
    }

    HexSectionInfo sec{};
    if (has_strtab && sh_name < strtab_sz) {
      copy_cstr_bounded(
          sec.name, sizeof(sec.name),
          data + static_cast<size_t>(strtab_off),
          static_cast<uint32_t>(strtab_sz),
          sh_name);
    }
    if (sec.name[0] == '\0') {
      write_u32_name(sec.name, sizeof(sec.name), "section_", si);
    }
    sec.va = effective_va;
    sec.size = sh_size;
    sec.file_offset = is_nobits ? 0u : sh_offset;
    sec.file_size = is_nobits ? 0u : sh_size;
    sec.flags = static_cast<uint32_t>(sh_flags & 0xFFFFFFFFu);
    sec.is_read = is_alloc ? 1u : 0u;
    sec.is_write = (sh_flags & 1u) ? 1u : 0u;
    sec.is_exec = (sh_flags & 4u) ? 1u : 0u;
    sec.is_nobits = is_nobits ? 1u : 0u;

    if (!out_secs.push_back(sec)) return HEX_ERR_OOM;
  }

  return HEX_OK;
}

// ============================================================================
// PE Parser (PE32 / PE32+)
// ============================================================================

uint32_t pe_machine_to_arch(uint16_t machine) {
  switch (machine) {
    case 0x8664u: return HEX_ARCH_X86_64;
    case 0x014Cu: return HEX_ARCH_X86;
    case 0xAA64u: return HEX_ARCH_ARM64;
    case 0x01C0u:
    case 0x01C4u: return HEX_ARCH_ARM;
    default: return HEX_ARCH_UNKNOWN;
  }
}

HexStatus parse_pe(
    const uint8_t* data,
    uint32_t len,
    HexImageInfo* out_info,
    hex::Vec<HexSectionInfo>& out_secs) {
  if (len < 64u) return HEX_ERR_INVALID_ARG;
  if (data[0] != 'M' || data[1] != 'Z') return HEX_ERR_INVALID_ARG;

  uint32_t lfanew = 0u;
  if (!read_u32_le(data, len, 60u, &lfanew)) return HEX_ERR_INVALID_ARG;
  if (lfanew > len || len - lfanew < 24u) return HEX_ERR_INVALID_ARG;

  uint32_t sig = 0u;
  if (!read_u32_le(data, len, lfanew, &sig) || sig != 0x00004550u) {
    return HEX_ERR_INVALID_ARG;
  }

  const uint32_t coff_off = lfanew + 4u;
  uint16_t machine = 0u, num_secs = 0u, opt_size = 0u;
  if (!read_u16_le(data, len, coff_off + 0u, &machine) ||
      !read_u16_le(data, len, coff_off + 2u, &num_secs) ||
      !read_u16_le(data, len, coff_off + 16u, &opt_size)) {
    return HEX_ERR_INVALID_ARG;
  }
  if (num_secs > kMaxSections) return HEX_ERR_RESOURCE_LIMIT;

  const uint32_t opt_off = coff_off + 20u;
  if (opt_size < 2u || opt_off > len || opt_size > len - opt_off) {
    return HEX_ERR_INVALID_ARG;
  }

  uint16_t opt_magic = 0u;
  if (!read_u16_le(data, len, opt_off, &opt_magic)) return HEX_ERR_INVALID_ARG;
  const bool is64 = (opt_magic == 0x20Bu);
  if (!is64 && opt_magic != 0x10Bu) return HEX_ERR_INVALID_ARG;

  uint32_t ep_rva = 0u;
  uint64_t img_base = 0u;
  if (opt_size >= 20u) {
    if (!read_u32_le(data, len, opt_off + 16u, &ep_rva)) return HEX_ERR_INVALID_ARG;
  }
  if (is64) {
    if (opt_size >= 32u) {
      if (!read_u64_le(data, len, opt_off + 24u, &img_base)) return HEX_ERR_INVALID_ARG;
    }
  } else {
    if (opt_size >= 32u) {
      uint32_t ib32 = 0u;
      if (!read_u32_le(data, len, opt_off + 28u, &ib32)) return HEX_ERR_INVALID_ARG;
      img_base = ib32;
    }
  }

  out_info->format = HEX_FORMAT_PE;
  out_info->arch = pe_machine_to_arch(machine);
  out_info->bits = is64 ? 64u : 32u;
  out_info->endian = HEX_ENDIAN_LITTLE;
  out_info->image_base = img_base;
  if (ep_rva != 0u) {
    uint64_t ep = 0u;
    if (!add_u64_checked(img_base, ep_rva, &ep)) return HEX_ERR_INVALID_ARG;
    out_info->entry_point = ep;
  } else {
    out_info->entry_point = 0u;
  }

  const uint32_t sec_table_off = opt_off + opt_size;
  uint64_t sec_bytes = 0u, sec_end = 0u;
  if (!mul_u64_checked(num_secs, 40u, &sec_bytes) ||
      !add_u64_checked(sec_table_off, sec_bytes, &sec_end) ||
      sec_end > len) {
    return HEX_ERR_INVALID_ARG;
  }

  if (!out_secs.reserve(num_secs)) return HEX_ERR_OOM;

  for (uint32_t si = 0u; si < num_secs; ++si) {
    const uint32_t soff = sec_table_off + si * 40u;
    uint32_t vsize = 0u, vaddr = 0u, raw_sz = 0u, raw_ptr = 0u, chars = 0u;
    if (!read_u32_le(data, len, soff + 8u, &vsize) ||
        !read_u32_le(data, len, soff + 12u, &vaddr) ||
        !read_u32_le(data, len, soff + 16u, &raw_sz) ||
        !read_u32_le(data, len, soff + 20u, &raw_ptr) ||
        !read_u32_le(data, len, soff + 36u, &chars)) {
      return HEX_ERR_INVALID_ARG;
    }
    if (raw_sz > 0u) {
      uint64_t fend = 0u;
      if (!add_u64_checked(raw_ptr, raw_sz, &fend) || fend > len) {
        return HEX_ERR_INVALID_ARG;
      }
    }
    uint64_t va = 0u;
    if (!add_u64_checked(img_base, vaddr, &va)) return HEX_ERR_INVALID_ARG;
    const uint64_t eff_size = vsize > 0u ? static_cast<uint64_t>(vsize) : static_cast<uint64_t>(raw_sz);
    if (!range_fits_u64_closed(va, eff_size)) return HEX_ERR_INVALID_ARG;

    HexSectionInfo sec{};
    copy_fixed_str(sec.name, sizeof(sec.name), data + soff, 8u);
    sec.va = va;
    sec.size = eff_size;
    sec.file_offset = raw_ptr;
    sec.file_size = raw_sz;
    sec.flags = chars;
    sec.is_exec = (chars & 0x20000000u) ? 1u : 0u;
    sec.is_read = (chars & 0x40000000u) ? 1u : 0u;
    sec.is_write = (chars & 0x80000000u) ? 1u : 0u;
    sec.is_nobits = (raw_sz == 0u && vsize > 0u) ? 1u : 0u;

    if (!out_secs.push_back(sec)) return HEX_ERR_OOM;
  }

  return HEX_OK;
}

bool ptr_in_image_arena(const uint8_t* ptr, uint32_t len) {
  if (!g_active_image_arena || !g_active_image_arena->base()) return false;
  const uintptr_t p = reinterpret_cast<uintptr_t>(ptr);
  const uintptr_t base = reinterpret_cast<uintptr_t>(g_active_image_arena->base());
  const uintptr_t used = static_cast<uintptr_t>(g_active_image_arena->used());
  if (p < base || p > base + used) return false;
  return static_cast<uintptr_t>(len) <= (base + used - p);
}

}  // namespace

namespace hex {
namespace binary {

void bind_global_arenas(hex::Arena* image_arena, hex::Arena* scratch_arena) {
  if (image_arena) g_active_image_arena = image_arena;
  if (scratch_arena) g_active_scratch_arena = scratch_arena;
  g_externally_bound = true;
  g_arenas_initialized = true;
}

}  // namespace binary
}  // namespace hex

extern "C" {

uint8_t* hex_image_alloc_input(uint32_t bytes_len) {
  ensure_arenas();
  if (bytes_len == 0u || !g_active_image_arena) return nullptr;
  return static_cast<uint8_t*>(g_active_image_arena->alloc_bytes(bytes_len, 16u));
}

uint8_t* hex_image_scratch_alloc(uint32_t bytes) {
  ensure_arenas();
  if (bytes == 0u || !g_active_scratch_arena) return nullptr;
  return static_cast<uint8_t*>(g_active_scratch_arena->alloc_bytes(bytes, 8u));
}

void hex_image_scratch_reset(void) {
  ensure_arenas();
  if (g_active_scratch_arena) g_active_scratch_arena->reset();
}

HexStatus hex_image_open(const uint8_t* data, uint32_t len, HexImageHandle* out_handle) {
  ensure_arenas();
  if (!data || len < 4u || !out_handle) return HEX_ERR_INVALID_ARG;
  *out_handle = 0u;

  uint32_t slot_idx = kMaxSlots;
  for (uint32_t i = 0u; i < kMaxSlots; ++i) {
    if (!g_slots[i].in_use) {
      slot_idx = i;
      break;
    }
  }
  if (slot_idx >= kMaxSlots) return HEX_ERR_RESOURCE_LIMIT;

  hex::ArenaScope scratch_scope(*g_active_scratch_arena);
  HexImageInfo info{};
  info.file_size = len;
  info.slice_offset = 0u;
  info.slice_size = len;

  hex::Vec<HexSectionInfo> secs(g_active_scratch_arena);
  uint32_t magic_le = 0u, magic_be = 0u;
  if (!read_u32_le(data, len, 0u, &magic_le) || !read_u32_be(data, len, 0u, &magic_be)) {
    return HEX_ERR_INVALID_ARG;
  }

  HexStatus st = HEX_ERR_UNSUPPORTED;
  if (data[0] == 0x7Fu && data[1] == 'E' && data[2] == 'L' && data[3] == 'F') {
    st = parse_elf(data, len, &info, secs);
  } else if (magic_be == 0xCAFEBABEu || magic_be == 0xCAFEBABFu) {
    st = parse_macho_fat(data, len, &info, secs);
  } else if (magic_le == 0xFEEDFACFu || magic_le == 0xCFFAEDFEu ||
             magic_le == 0xFEEDFACEu || magic_le == 0xCEFAEDFEu) {
    st = parse_macho_single(data, len, &info, secs);
  } else if (data[0] == 'M' && data[1] == 'Z') {
    st = parse_pe(data, len, &info, secs);
  } else {
    return HEX_ERR_UNSUPPORTED;
  }

  if (st != HEX_OK) return st;

  // Persist raw bytes (zero-copy if caller already used hex_image_alloc_input)
  const uint8_t* stored_raw = data;
  if (!ptr_in_image_arena(data, len)) {
    uint8_t* dst = static_cast<uint8_t*>(g_active_image_arena->alloc_bytes(len, 16u));
    if (!dst) return HEX_ERR_OOM;
    hex::mem_copy(dst, data, len);
    stored_raw = dst;
  }

  HexSectionInfo* stored_secs = nullptr;
  const uint32_t sec_count = static_cast<uint32_t>(secs.size());
  if (sec_count > 0u) {
    stored_secs = g_active_image_arena->alloc<HexSectionInfo>(sec_count);
    if (!stored_secs) return HEX_ERR_OOM;
    hex::mem_copy(stored_secs, secs.data(), sec_count * sizeof(HexSectionInfo));
  }

  info.section_count = sec_count;

  ImageSlot& slot = g_slots[slot_idx];
  uint32_t next_gen = (slot.generation + 1u) & 0x00FFFFFFu;
  if (next_gen == 0u) next_gen = 1u;
  slot.in_use = true;
  slot.generation = next_gen;
  slot.info = info;
  slot.raw_data = stored_raw;
  slot.raw_len = len;
  slot.sections = stored_secs;
  slot.section_count = sec_count;

  *out_handle = make_handle(slot_idx, next_gen);
  return HEX_OK;
}

HexStatus hex_image_close(HexImageHandle handle) {
  ImageSlot* slot = resolve_slot(handle);
  if (!slot) return HEX_ERR_INVALID_ARG;
  slot->in_use = false;
  slot->raw_data = nullptr;
  slot->raw_len = 0u;
  slot->sections = nullptr;
  slot->section_count = 0u;
  return HEX_OK;
}

HexStatus hex_image_get_info(HexImageHandle handle, HexImageInfo* out_info) {
  if (!out_info) return HEX_ERR_INVALID_ARG;
  ImageSlot* slot = resolve_slot(handle);
  if (!slot) return HEX_ERR_INVALID_ARG;
  *out_info = slot->info;
  return HEX_OK;
}

HexStatus hex_image_section_count(HexImageHandle handle, uint32_t* out_count) {
  if (!out_count) return HEX_ERR_INVALID_ARG;
  ImageSlot* slot = resolve_slot(handle);
  if (!slot) return HEX_ERR_INVALID_ARG;
  *out_count = slot->section_count;
  return HEX_OK;
}

HexStatus hex_image_get_section(
    HexImageHandle handle,
    uint32_t index,
    HexSectionInfo* out_sec) {
  if (!out_sec) return HEX_ERR_INVALID_ARG;
  ImageSlot* slot = resolve_slot(handle);
  if (!slot) return HEX_ERR_INVALID_ARG;
  if (index >= slot->section_count || !slot->sections) return HEX_ERR_INVALID_ARG;
  *out_sec = slot->sections[index];
  return HEX_OK;
}

}  // extern "C"
