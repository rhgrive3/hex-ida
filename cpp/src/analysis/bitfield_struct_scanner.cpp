#include "hex_hexsig.hpp"
#include "arm64_insn_bits.hpp"

namespace {

constexpr uint8_t kNoReg = 0xFFu;
constexpr uint16_t kNoUnion = 0xFFFFu;
constexpr uint32_t kMaxRawObs = 256u;
constexpr uint32_t kMaxScratchFields = 128u;
constexpr uint32_t kMaxScratchBf = 128u;

inline uint64_t make_bit_mask(uint8_t lsb, uint8_t width) {
  if (width == 0u || lsb >= 64u) return 0ULL;
  if (width >= 64u) return ~0ULL;
  const uint64_t raw = (1ULL << width) - 1ULL;
  return raw << lsb;
}

inline uint8_t ctz64(uint64_t v) {
  if (v == 0ULL) return 64u;
  uint8_t n = 0u;
  while ((v & 1ULL) == 0ULL) {
    v >>= 1u;
    ++n;
  }
  return n;
}

inline uint8_t popcnt64(uint64_t v) {
  uint8_t c = 0u;
  while (v != 0ULL) {
    v &= (v - 1ULL);
    ++c;
  }
  return c;
}

// Exact ARMv8-A DecodeBitMasks for logical immediate instructions (AND/ANDS/ORR/EOR)
inline bool decode_arm64_bitmask_imm(uint32_t n_bit, uint32_t imms, uint32_t immr, bool is64, uint64_t& out_mask) {
  if (!is64 && n_bit != 0u) return false;
  const uint32_t combined = (n_bit << 6) | (~imms & 0x3Fu);
  int32_t len = -1;
  for (int32_t b = 6; b >= 1; --b) {
    if ((combined & (1u << static_cast<uint32_t>(b))) != 0u) {
      len = b;
      break;
    }
  }
  if (len < 1) return false;
  const uint32_t esize = 1u << static_cast<uint32_t>(len);
  const uint32_t levels = esize - 1u;
  const uint32_t s = imms & levels;
  const uint32_t r = immr & levels;
  if (s == levels) return false;  // Reserved all-ones encoding

  uint64_t welem = (s + 1u == 64u) ? ~0ULL : ((1ULL << (s + 1u)) - 1ULL);
  if (r != 0u) {
    const uint64_t emask = (esize == 64u) ? ~0ULL : ((1ULL << esize) - 1ULL);
    welem = ((welem >> r) | (welem << (esize - r))) & emask;
  }
  uint64_t result = 0ULL;
  const uint32_t reg_bits = is64 ? 64u : 32u;
  for (uint32_t pos = 0u; pos < reg_bits; pos += esize) {
    result |= (welem << pos);
  }
  out_mask = result;
  return true;
}

inline bool is_contiguous_mask(uint64_t mask, uint8_t& out_lsb, uint8_t& out_width) {
  if (mask == 0ULL) return false;
  const uint8_t lsb = ctz64(mask);
  const uint64_t shifted = mask >> lsb;
  if ((shifted & (shifted + 1ULL)) != 0ULL) return false;
  out_lsb = lsb;
  out_width = popcnt64(shifted);
  return out_width >= 1u && out_width <= 64u;
}

struct PairMemOp {
  bool valid;
  bool is_store;
  bool is_float;
  bool is_signed;
  uint8_t width;
  uint8_t rt;
  uint8_t rt2;
  uint8_t rn;
  int32_t disp;
};

inline PairMemOp decode_arm64_ldp_stp(uint32_t w) {
  PairMemOp op{false, false, false, false, 0, 0, 0, 0, 0};
  if ((w & 0x3A000000u) != 0x28000000u) return op;
  const uint32_t opc = (w >> 30) & 3u;
  const uint32_t v = (w >> 26) & 1u;
  const uint32_t l = (w >> 22) & 1u;

  uint8_t width = 0u;
  bool is_signed = false;
  if (v == 0u) {
    if (opc == 0u) {
      width = 4u;
    } else if (opc == 1u) {
      if (l == 0u) return op;
      width = 4u;
      is_signed = true;
    } else if (opc == 2u) {
      width = 8u;
    } else {
      return op;
    }
  } else {
    if (opc == 0u) width = 4u;
    else if (opc == 1u) width = 8u;
    else if (opc == 2u) width = 16u;
    else return op;
  }

  int32_t imm7 = static_cast<int32_t>((w >> 15) & 0x7Fu);
  if (imm7 & 0x40) imm7 |= ~0x7F;
  const int32_t disp = imm7 * static_cast<int32_t>(width);

  op.valid = true;
  op.is_store = (l == 0u);
  op.is_float = (v != 0u);
  op.is_signed = is_signed;
  op.width = width;
  op.rt = static_cast<uint8_t>(w & 31u);
  op.rt2 = static_cast<uint8_t>((w >> 10) & 31u);
  op.rn = static_cast<uint8_t>((w >> 5) & 31u);
  op.disp = disp;
  return op;
}

inline bool is_signed_imm_load(uint32_t w) {
  const uint32_t v = (w >> 26) & 1u;
  if (v != 0u) return false;
  const uint32_t opc = (w >> 22) & 3u;
  const uint32_t size = (w >> 30) & 3u;
  if (opc == 2u && size < 3u) return true;
  if (opc == 3u && size < 2u) return true;
  return false;
}

inline bool is_arm64_call(uint32_t w) {
  if ((w & 0xFC000000u) == 0x94000000u) return true;  // BL
  if ((w & 0xFFFFFC1Fu) == 0xD63F0000u) return true;  // BLR
  if ((w & 0xFEFFF800u) == 0xD63F0800u) return true;  // BLRAA/BLRAB
  return false;
}

// Identify GP destination register Rd (0..30) written by general ARM64 data-processing/load instructions
inline uint8_t extract_gp_clobber_rd(uint32_t w) {
  const uint8_t rd = static_cast<uint8_t>(w & 31u);
  if (rd >= 31u) return kNoReg;
  // Data Processing - Immediate: ADR/ADRP, ADD/SUB imm, Logical imm, MOV wide, Bitfield, Extract
  if ((w & 0x1C000000u) == 0x10000000u) return rd;
  // Data Processing - Register: Logical shifted, ADD/SUB shifted/ext, ADC/SBC, CondSelect, 1/2/3-src
  if ((w & 0x0E000000u) == 0x0A000000u) return rd;
  // Data Processing - Register (MADD/MSUB/UDIV/SDIV/LSLV/LSRV/ASRV/RORV/RBIT/CLZ/REV)
  if ((w & 0x1F000000u) == 0x1A000000u || (w & 0x1F000000u) == 0x1B000000u) return rd;
  // Register-offset integer load / literal integer load
  uint8_t rt = 0u, rn = 0u, rm = 0u, width = 0u;
  if (hex::arm64::is_reg_offset_load(w, rt, rn, rm, width) && rt < 31u) return rt;
  if ((w & 0x3F000000u) == 0x18000000u) return rd;  // LDR/LDRSW literal (non-FP)
  return kNoReg;
}

struct RegTrack {
  bool from_mem;
  uint8_t base_reg;
  int32_t struct_offset;
  uint8_t mem_width;
  bool lsr_pending;
  uint8_t lsr_src_reg;
  uint8_t lsr_shift;
  bool lsr_is64;
  bool and_pending;
  uint8_t and_src_reg;
  uint8_t and_lsb;
  uint8_t and_width;
  bool and_is64;
};

inline RegTrack empty_reg_track() {
  return RegTrack{false, kNoReg, -1, 0u, false, kNoReg, 0u, false, false, kNoReg, 0u, 0u, false};
}

struct RawMemObs {
  uint32_t insn_off;
  int32_t offset;
  uint8_t base_reg;
  uint8_t width;
  uint8_t type_hint;
  uint8_t flags;
};

inline bool is_trackable_struct_base(uint8_t rn) {
  return rn < 29u;
}

inline uint8_t infer_mem_type_hint(bool is_float, uint8_t width, bool is_signed) {
  if (is_float) {
    if (width == 4u) return HEX_FIELD_TYPE_FLOAT;
    if (width == 8u) return HEX_FIELD_TYPE_DOUBLE;
    if (width == 16u) return HEX_FIELD_TYPE_SIMD;
    return HEX_FIELD_TYPE_FLOAT;
  }
  if (is_signed) return HEX_FIELD_TYPE_INT;
  return HEX_FIELD_TYPE_UINT;
}

inline uint16_t infer_natural_align(uint16_t size) {
  if (size >= 16u) return 16u;
  if (size >= 8u) return 8u;
  if (size >= 4u) return 4u;
  if (size >= 2u) return 2u;
  return 1u;
}

inline bool types_conflict(uint8_t a, uint8_t b) {
  if (a == HEX_FIELD_TYPE_UNKNOWN || b == HEX_FIELD_TYPE_UNKNOWN) return false;
  if (a == b) return false;
  const bool a_int = (a == HEX_FIELD_TYPE_INT || a == HEX_FIELD_TYPE_UINT || a == HEX_FIELD_TYPE_BITFIELD);
  const bool b_int = (b == HEX_FIELD_TYPE_INT || b == HEX_FIELD_TYPE_UINT || b == HEX_FIELD_TYPE_BITFIELD);
  if (a_int && b_int) return false;
  return true;
}

inline void sort_fields(HexStructFieldCandidate* arr, uint32_t n) {
  for (uint32_t i = 1u; i < n; ++i) {
    const HexStructFieldCandidate key = arr[i];
    uint32_t j = i;
    while (j > 0u) {
      const HexStructFieldCandidate& prev = arr[j - 1u];
      const bool greater =
          (prev.base_reg > key.base_reg) ||
          (prev.base_reg == key.base_reg && prev.offset > key.offset) ||
          (prev.base_reg == key.base_reg && prev.offset == key.offset && prev.size > key.size) ||
          (prev.base_reg == key.base_reg && prev.offset == key.offset && prev.size == key.size &&
           prev.type_hint > key.type_hint);
      if (!greater) break;
      arr[j] = prev;
      --j;
    }
    arr[j] = key;
  }
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_bitfield_struct_scan")
HexStatus hex_bitfield_struct_scan(
    const uint8_t* code_ptr,
    uint32_t code_len,
    HexBitfieldAccess* out_bf,
    uint32_t max_bf,
    HexStructFieldCandidate* out_fields,
    uint32_t max_fields,
    HexUnionOverlapGroup* out_unions,
    uint32_t max_unions,
    HexBitfieldStructSummary* out_summary) {
  if (code_ptr == nullptr || out_summary == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  out_summary->bf_count = 0u;
  out_summary->field_count = 0u;
  out_summary->union_count = 0u;
  out_summary->struct_size = 0u;
  out_summary->struct_align = 0u;
  out_summary->total_padding = 0u;

  const uint32_t limit = code_len & ~3u;
  if (limit < 4u) {
    return HEX_OK;
  }

  RegTrack regs[32];
  for (uint32_t i = 0u; i < 32u; ++i) {
    regs[i] = empty_reg_track();
  }

  RawMemObs raw_obs[kMaxRawObs];
  uint32_t raw_obs_count = 0u;

  HexBitfieldAccess bf_buf[kMaxScratchBf];
  uint32_t bf_count = 0u;

  auto emit_bf = [&](const HexBitfieldAccess& rec) {
    if (bf_count < kMaxScratchBf) {
      bf_buf[bf_count++] = rec;
    }
  };

  auto emit_obs = [&](uint32_t insn_off, uint8_t base_reg, int32_t offset, uint8_t width,
                      uint8_t type_hint, uint8_t flags) {
    if (!is_trackable_struct_base(base_reg) || width == 0u) return;
    if (raw_obs_count < kMaxRawObs) {
      raw_obs[raw_obs_count++] = RawMemObs{insn_off, offset, base_reg, width, type_hint, flags};
    }
  };

  for (uint32_t off = 0u; off < limit; off += 4u) {
    const uint32_t w = hex::arm64::read_u32_le(code_ptr, off);

    // 0. Calls clobber caller-saved registers x0..x18
    if (is_arm64_call(w)) {
      for (uint32_t r = 0u; r <= 18u; ++r) {
        regs[r] = empty_reg_track();
      }
      continue;
    }

    // 1. Immediate-offset single load/store (LDR/STR/LDUR/STUR/LDRSB/LDRSH/LDRSW)
    const hex::arm64::MemOp mop = hex::arm64::decode_imm_mem(w);
    if (mop.valid) {
      const bool is_signed = !mop.is_store && is_signed_imm_load(w);
      uint8_t flags = mop.is_store ? HEX_SF_FLAG_WRITE : HEX_SF_FLAG_READ;
      if (is_signed) flags |= HEX_SF_FLAG_SIGNED;
      const uint8_t thint = infer_mem_type_hint(mop.is_float, mop.width, is_signed);
      emit_obs(off, mop.rn, mop.disp, mop.width, thint, flags);

      if (!mop.is_store && !mop.is_float && mop.rt < 31u) {
        regs[mop.rt] = RegTrack{
            is_trackable_struct_base(mop.rn),
            is_trackable_struct_base(mop.rn) ? mop.rn : kNoReg,
            is_trackable_struct_base(mop.rn) ? mop.disp : -1,
            mop.width,
            false, kNoReg, 0u, false,
            false, kNoReg, 0u, 0u, false};
      }
      continue;
    }

    // 2. Pair load/store (LDP/STP) — split into two observations per v6 §4.1
    const PairMemOp pop = decode_arm64_ldp_stp(w);
    if (pop.valid) {
      uint8_t flags = pop.is_store ? HEX_SF_FLAG_WRITE : HEX_SF_FLAG_READ;
      if (pop.is_signed) flags |= HEX_SF_FLAG_SIGNED;
      const uint8_t thint = infer_mem_type_hint(pop.is_float, pop.width, pop.is_signed);
      emit_obs(off, pop.rn, pop.disp, pop.width, thint, flags);
      emit_obs(off, pop.rn, pop.disp + static_cast<int32_t>(pop.width), pop.width, thint, flags);

      if (!pop.is_store && !pop.is_float) {
        if (pop.rt < 31u) {
          regs[pop.rt] = RegTrack{
              is_trackable_struct_base(pop.rn),
              is_trackable_struct_base(pop.rn) ? pop.rn : kNoReg,
              is_trackable_struct_base(pop.rn) ? pop.disp : -1,
              pop.width,
              false, kNoReg, 0u, false,
              false, kNoReg, 0u, 0u, false};
        }
        if (pop.rt2 < 31u) {
          regs[pop.rt2] = RegTrack{
              is_trackable_struct_base(pop.rn),
              is_trackable_struct_base(pop.rn) ? pop.rn : kNoReg,
              is_trackable_struct_base(pop.rn) ? (pop.disp + static_cast<int32_t>(pop.width)) : -1,
              pop.width,
              false, kNoReg, 0u, false,
              false, kNoReg, 0u, 0u, false};
        }
      }
      continue;
    }

    // 3. Bitfield instructions: SBFM (opc=0), BFM (opc=1), UBFM (opc=2)
    if ((w & 0x1F800000u) == 0x13000000u) {
      const uint32_t sf = (w >> 31) & 1u;
      const uint32_t opc = (w >> 29) & 3u;
      const uint32_t n_bit = (w >> 22) & 1u;
      const uint32_t immr = (w >> 16) & 0x3Fu;
      const uint32_t imms = (w >> 10) & 0x3Fu;
      const uint8_t rn = static_cast<uint8_t>((w >> 5) & 31u);
      const uint8_t rd = static_cast<uint8_t>(w & 31u);
      const uint32_t reg_bits = sf ? 64u : 32u;

      if (opc <= 2u && n_bit == sf && immr < reg_bits && imms < reg_bits) {
        const RegTrack src_info = (rn < 31u) ? regs[rn] : empty_reg_track();
        const RegTrack dst_info = (rd < 31u) ? regs[rd] : empty_reg_track();

        // Exclude standard integer extensions: UXTB/UXTH/SXTB/SXTH/SXTW
        const bool is_std_int_ext =
            (opc == 0u || opc == 2u) &&
            immr == 0u &&
            (imms == 7u || imms == 15u || (sf == 1u && imms == 31u));
        if (is_std_int_ext) {
          if (rd < 31u) regs[rd] = empty_reg_track();
          continue;
        }

        if (opc == 2u) {
          // UBFM
          if (imms == reg_bits - 1u) {
            // LSR Rd, Rn, #immr
            const uint8_t shift = static_cast<uint8_t>(immr);
            if (src_info.and_pending && shift == src_info.and_lsb && src_info.and_width > 0u) {
              // AND + LSR bitfield extract: use ONLY src_info's own snapshot (never re-read regs[and_src_reg])
              HexBitfieldAccess bf{};
              bf.insn_offset = off;
              bf.struct_offset = src_info.from_mem ? src_info.struct_offset : -1;
              bf.base_reg = src_info.from_mem ? src_info.base_reg : kNoReg;
              bf.src_reg = src_info.and_src_reg != kNoReg ? src_info.and_src_reg : rn;
              bf.dst_reg = rd;
              bf.op_kind = HEX_BF_OP_AND_LSR;
              bf.lsb = src_info.and_lsb;
              bf.width = src_info.and_width;
              bf.container_bytes = src_info.from_mem ? src_info.mem_width : (sf ? 8u : 4u);
              bf.flags = (sf ? HEX_BF_FLAG_64BIT : 0u) | (src_info.from_mem ? HEX_BF_FLAG_FROM_MEM : 0u);
              bf.bit_mask = make_bit_mask(bf.lsb, bf.width);
              emit_bf(bf);
            }
            if (rd < 31u) {
              regs[rd] = RegTrack{
                  src_info.from_mem, src_info.base_reg, src_info.struct_offset, src_info.mem_width,
                  true, rn, shift, sf != 0u,
                  false, kNoReg, 0u, 0u, false};
            }
          } else if (imms >= immr) {
            // UBFX Rd, Rn, #lsb, #width
            const uint8_t lsb = static_cast<uint8_t>(immr);
            const uint8_t width = static_cast<uint8_t>(imms - immr + 1u);
            HexBitfieldAccess bf{};
            bf.insn_offset = off;
            bf.struct_offset = src_info.from_mem ? src_info.struct_offset : -1;
            bf.base_reg = src_info.from_mem ? src_info.base_reg : kNoReg;
            bf.src_reg = rn;
            bf.dst_reg = rd;
            bf.op_kind = HEX_BF_OP_UBFX;
            bf.lsb = lsb;
            bf.width = width;
            bf.container_bytes = src_info.from_mem ? src_info.mem_width : (sf ? 8u : 4u);
            bf.flags = (sf ? HEX_BF_FLAG_64BIT : 0u) | (src_info.from_mem ? HEX_BF_FLAG_FROM_MEM : 0u);
            bf.bit_mask = make_bit_mask(lsb, width);
            emit_bf(bf);
            if (rd < 31u) regs[rd] = empty_reg_track();
          } else {
            if (rd < 31u) regs[rd] = empty_reg_track();
          }
        } else if (opc == 0u) {
          // SBFM
          if (imms >= immr && imms < reg_bits - 1u) {
            // SBFX Rd, Rn, #lsb, #width
            const uint8_t lsb = static_cast<uint8_t>(immr);
            const uint8_t width = static_cast<uint8_t>(imms - immr + 1u);
            HexBitfieldAccess bf{};
            bf.insn_offset = off;
            bf.struct_offset = src_info.from_mem ? src_info.struct_offset : -1;
            bf.base_reg = src_info.from_mem ? src_info.base_reg : kNoReg;
            bf.src_reg = rn;
            bf.dst_reg = rd;
            bf.op_kind = HEX_BF_OP_SBFX;
            bf.lsb = lsb;
            bf.width = width;
            bf.container_bytes = src_info.from_mem ? src_info.mem_width : (sf ? 8u : 4u);
            bf.flags = HEX_BF_FLAG_SIGNED | (sf ? HEX_BF_FLAG_64BIT : 0u) |
                       (src_info.from_mem ? HEX_BF_FLAG_FROM_MEM : 0u);
            bf.bit_mask = make_bit_mask(lsb, width);
            emit_bf(bf);
          }
          if (rd < 31u) regs[rd] = empty_reg_track();
        } else {
          // BFM (opc == 1): BFI (imms < immr) or BFXIL (imms >= immr)
          const bool is_bfi = (imms < immr);
          const uint8_t lsb = is_bfi ? static_cast<uint8_t>((reg_bits - immr) % reg_bits)
                                     : static_cast<uint8_t>(immr);
          const uint8_t width = is_bfi ? static_cast<uint8_t>(imms + 1u)
                                       : static_cast<uint8_t>(imms - immr + 1u);
          const RegTrack& anchor = is_bfi ? dst_info : src_info;
          HexBitfieldAccess bf{};
          bf.insn_offset = off;
          bf.struct_offset = anchor.from_mem ? anchor.struct_offset : -1;
          bf.base_reg = anchor.from_mem ? anchor.base_reg : kNoReg;
          bf.src_reg = rn;
          bf.dst_reg = rd;
          bf.op_kind = is_bfi ? HEX_BF_OP_BFI : HEX_BF_OP_BFXIL;
          bf.lsb = lsb;
          bf.width = width;
          bf.container_bytes = anchor.from_mem ? anchor.mem_width : (sf ? 8u : 4u);
          bf.flags = (is_bfi ? HEX_BF_FLAG_WRITE : 0u) | (sf ? HEX_BF_FLAG_64BIT : 0u) |
                     (anchor.from_mem ? HEX_BF_FLAG_FROM_MEM : 0u);
          bf.bit_mask = make_bit_mask(lsb, width);
          emit_bf(bf);
          if (!is_bfi && rd < 31u) regs[rd] = empty_reg_track();
        }
      } else if (rd < 31u) {
        regs[rd] = empty_reg_track();
      }
      continue;
    }

    // 4. AND / ANDS (immediate) -> LSR+AND or pending AND+LSR or TST
    if ((w & 0x7F800000u) == 0x12000000u || (w & 0x7F800000u) == 0x72000000u) {
      const bool is_ands = (w & 0x7F800000u) == 0x72000000u;
      const bool is64 = ((w >> 31) & 1u) != 0u;
      const uint32_t reg_bits = is64 ? 64u : 32u;
      const uint32_t n_bit = (w >> 22) & 1u;
      const uint32_t immr = (w >> 16) & 0x3Fu;
      const uint32_t imms = (w >> 10) & 0x3Fu;
      const uint8_t rn = static_cast<uint8_t>((w >> 5) & 31u);
      const uint8_t rd = static_cast<uint8_t>(w & 31u);
      uint64_t mask = 0ULL;
      uint8_t m_lsb = 0u;
      uint8_t m_width = 0u;
      if (decode_arm64_bitmask_imm(n_bit, imms, immr, is64, mask) &&
          is_contiguous_mask(mask, m_lsb, m_width)) {
        const RegTrack src_info = (rn < 31u) ? regs[rn] : empty_reg_track();
        if (is_ands && rd == 31u) {
          // TST Rn, #mask
          if (src_info.from_mem) {
            HexBitfieldAccess bf{};
            bf.insn_offset = off;
            bf.struct_offset = src_info.struct_offset;
            bf.base_reg = src_info.base_reg;
            bf.src_reg = rn;
            bf.dst_reg = 31u;
            bf.op_kind = HEX_BF_OP_TBZ_TST;
            bf.lsb = m_lsb;
            bf.width = m_width;
            bf.container_bytes = src_info.mem_width;
            bf.flags = (is64 ? HEX_BF_FLAG_64BIT : 0u) | HEX_BF_FLAG_FROM_MEM;
            bf.bit_mask = make_bit_mask(m_lsb, m_width);
            emit_bf(bf);
          }
        } else if (src_info.lsr_pending && m_lsb == 0u) {
          // LSR + AND bitfield extraction: verify lsb + width <= reg_bits (fail-closed)
          const uint32_t eff_bits = (src_info.lsr_is64 && is64) ? 64u : 32u;
          if (static_cast<uint32_t>(src_info.lsr_shift) + static_cast<uint32_t>(m_width) <= eff_bits) {
            HexBitfieldAccess bf{};
            bf.insn_offset = off;
            bf.struct_offset = src_info.from_mem ? src_info.struct_offset : -1;
            bf.base_reg = src_info.from_mem ? src_info.base_reg : kNoReg;
            bf.src_reg = src_info.lsr_src_reg != kNoReg ? src_info.lsr_src_reg : rn;
            bf.dst_reg = rd;
            bf.op_kind = HEX_BF_OP_AND_LSR;
            bf.lsb = src_info.lsr_shift;
            bf.width = m_width;
            bf.container_bytes = src_info.from_mem ? src_info.mem_width : (is64 ? 8u : 4u);
            bf.flags = (is64 ? HEX_BF_FLAG_64BIT : 0u) | (src_info.from_mem ? HEX_BF_FLAG_FROM_MEM : 0u);
            bf.bit_mask = make_bit_mask(bf.lsb, bf.width);
            emit_bf(bf);
          }
          if (rd < 31u) regs[rd] = empty_reg_track();
        } else if (rd < 31u) {
          // Record pending AND for potential subsequent LSR (snapshot mem info directly on rd)
          regs[rd] = RegTrack{
              src_info.from_mem, src_info.base_reg, src_info.struct_offset, src_info.mem_width,
              false, kNoReg, 0u, false,
              true, rn, m_lsb, m_width, is64};
        }
      } else if (rd < 31u) {
        regs[rd] = empty_reg_track();
      }
      (void)reg_bits;
      continue;
    }

    // 5. TBZ / TBNZ single-bit test on struct-loaded register
    if ((w & 0x7E000000u) == 0x36000000u) {
      const uint8_t rt = static_cast<uint8_t>(w & 31u);
      const uint8_t bit_pos = static_cast<uint8_t>((((w >> 31) & 1u) << 5) | ((w >> 19) & 0x1Fu));
      if (rt < 31u && regs[rt].from_mem) {
        HexBitfieldAccess bf{};
        bf.insn_offset = off;
        bf.struct_offset = regs[rt].struct_offset;
        bf.base_reg = regs[rt].base_reg;
        bf.src_reg = rt;
        bf.dst_reg = 31u;
        bf.op_kind = HEX_BF_OP_TBZ_TST;
        bf.lsb = bit_pos;
        bf.width = 1u;
        bf.container_bytes = regs[rt].mem_width;
        bf.flags = ((bit_pos >= 32u) ? HEX_BF_FLAG_64BIT : 0u) | HEX_BF_FLAG_FROM_MEM;
        bf.bit_mask = make_bit_mask(bit_pos, 1u);
        emit_bf(bf);
      }
      continue;
    }

    // 6. General GP destination register clobber clearing (MOV/ADD/SUB/ORR/EOR/etc.)
    const uint8_t clobber_rd = extract_gp_clobber_rd(w);
    if (clobber_rd < 31u) {
      regs[clobber_rd] = empty_reg_track();
    }
  }

  // Coalesce raw memory observations into HexStructFieldCandidate[]
  HexStructFieldCandidate fields[kMaxScratchFields];
  uint32_t field_count = 0u;

  for (uint32_t i = 0u; i < raw_obs_count; ++i) {
    const RawMemObs& obs = raw_obs[i];
    bool merged = false;
    for (uint32_t f = 0u; f < field_count; ++f) {
      HexStructFieldCandidate& cand = fields[f];
      if (cand.base_reg == obs.base_reg &&
          cand.offset == obs.offset &&
          cand.size == obs.width &&
          !types_conflict(cand.type_hint, obs.type_hint)) {
        if (cand.access_count < 0xFFFFu) cand.access_count++;
        cand.flags |= obs.flags;
        if (obs.type_hint == HEX_FIELD_TYPE_INT && cand.type_hint == HEX_FIELD_TYPE_UINT) {
          cand.type_hint = HEX_FIELD_TYPE_INT;
        } else if (cand.type_hint == HEX_FIELD_TYPE_UNKNOWN) {
          cand.type_hint = obs.type_hint;
        }
        merged = true;
        break;
      }
    }
    if (!merged && field_count < kMaxScratchFields) {
      HexStructFieldCandidate cand{};
      cand.offset = obs.offset;
      cand.size = obs.width;
      cand.alignment = infer_natural_align(obs.width);
      cand.base_reg = obs.base_reg;
      cand.type_hint = obs.type_hint;
      cand.flags = obs.flags;
      cand.bf_count = 0u;
      cand.access_count = 1u;
      cand.union_group_id = kNoUnion;
      cand.first_insn_off = obs.insn_off;
      cand.padding_before = 0u;
      fields[field_count++] = cand;
    }
  }

  // Link bitfield accesses to struct field candidates (matching base_reg, offset, AND container_bytes)
  for (uint32_t b = 0u; b < bf_count; ++b) {
    if ((bf_buf[b].flags & HEX_BF_FLAG_FROM_MEM) == 0u) continue;
    for (uint32_t f = 0u; f < field_count; ++f) {
      if (fields[f].base_reg == bf_buf[b].base_reg &&
          fields[f].offset == bf_buf[b].struct_offset &&
          fields[f].size == bf_buf[b].container_bytes) {
        fields[f].flags |= HEX_SF_FLAG_HAS_BF;
        if (fields[f].bf_count < 0xFFu) fields[f].bf_count++;
        if (fields[f].type_hint == HEX_FIELD_TYPE_UINT || fields[f].type_hint == HEX_FIELD_TYPE_INT) {
          fields[f].type_hint = HEX_FIELD_TYPE_BITFIELD;
        }
      }
    }
  }

  sort_fields(fields, field_count);

  // Detect union overlap groups per base_reg (all-pairs type/width conflict check)
  HexUnionOverlapGroup unions[64];
  uint32_t union_count = 0u;

  uint32_t idx = 0u;
  while (idx < field_count) {
    const uint8_t reg = fields[idx].base_reg;
    uint32_t reg_end = idx + 1u;
    while (reg_end < field_count && fields[reg_end].base_reg == reg) {
      ++reg_end;
    }

    uint32_t g_start = idx;
    while (g_start < reg_end) {
      int32_t span_start = fields[g_start].offset;
      int32_t span_end = fields[g_start].offset + static_cast<int32_t>(fields[g_start].size);
      uint32_t g_end = g_start + 1u;
      while (g_end < reg_end && fields[g_end].offset < span_end) {
        const int32_t cand_end = fields[g_end].offset + static_cast<int32_t>(fields[g_end].size);
        if (cand_end > span_end) span_end = cand_end;
        ++g_end;
      }

      const uint32_t members = g_end - g_start;
      if (members >= 2u && union_count < 64u) {
        uint32_t total_acc = 0u;
        uint32_t min_acc = 0xFFFFFFFFu;
        bool has_type_conflict = false;
        bool has_width_conflict = false;

        for (uint32_t k = g_start; k < g_end; ++k) {
          total_acc += fields[k].access_count;
          if (fields[k].access_count < min_acc) min_acc = fields[k].access_count;
          fields[k].flags |= HEX_SF_FLAG_IN_UNION;
          fields[k].union_group_id = static_cast<uint16_t>(union_count);
          for (uint32_t m = k + 1u; m < g_end; ++m) {
            if (types_conflict(fields[k].type_hint, fields[m].type_hint)) {
              has_type_conflict = true;
            }
            if (fields[k].size != fields[m].size || fields[k].offset != fields[m].offset) {
              has_width_conflict = true;
            }
          }
        }

        const uint16_t minority_pct = (total_acc > 0u)
            ? static_cast<uint16_t>((min_acc * 100u) / total_acc)
            : 0u;
        uint32_t uflags = 0u;
        if (has_type_conflict) uflags |= HEX_UNION_FLAG_TYPE_CONFLICT;
        if (has_width_conflict) uflags |= HEX_UNION_FLAG_WIDTH_CONFLICT;
        if ((minority_pct >= 25u && min_acc >= 2u) || has_type_conflict || has_width_conflict) {
          uflags |= HEX_UNION_FLAG_CONFIRMED;
        }

        HexUnionOverlapGroup ug{};
        ug.group_id = static_cast<uint16_t>(union_count);
        ug.base_reg = reg;
        ug.member_count = static_cast<uint8_t>(members > 255u ? 255u : members);
        ug.start_offset = span_start;
        ug.end_offset = span_end;
        ug.total_accesses = static_cast<uint16_t>(total_acc > 0xFFFFu ? 0xFFFFu : total_acc);
        ug.minority_pct = minority_pct;
        ug.flags = uflags;
        unions[union_count++] = ug;
      }

      g_start = g_end;
    }

    idx = reg_end;
  }

  // Padding & alignment inference per base_reg + find primary struct
  uint32_t primary_field_count = 0u;
  uint32_t primary_struct_size = 0u;
  uint16_t primary_struct_align = 0u;
  uint16_t primary_total_padding = 0u;

  idx = 0u;
  while (idx < field_count) {
    const uint8_t reg = fields[idx].base_reg;
    uint32_t reg_end = idx + 1u;
    while (reg_end < field_count && fields[reg_end].base_reg == reg) {
      ++reg_end;
    }

    int32_t prev_end = 0;
    uint16_t max_align = 1u;
    uint32_t pad_sum = 0u;
    bool first_nonneg = true;

    for (uint32_t k = idx; k < reg_end; ++k) {
      if (fields[k].alignment > max_align) max_align = fields[k].alignment;
      if (fields[k].offset >= 0) {
        if (first_nonneg) {
          if (fields[k].offset > 0) {
            fields[k].padding_before = static_cast<uint32_t>(fields[k].offset);
            pad_sum += fields[k].padding_before;
          }
          prev_end = fields[k].offset + static_cast<int32_t>(fields[k].size);
          first_nonneg = false;
        } else {
          if (fields[k].offset > prev_end) {
            fields[k].padding_before = static_cast<uint32_t>(fields[k].offset - prev_end);
            pad_sum += fields[k].padding_before;
          }
          const int32_t end = fields[k].offset + static_cast<int32_t>(fields[k].size);
          if (end > prev_end) prev_end = end;
        }
      }
    }

    uint32_t raw_size = (prev_end > 0) ? static_cast<uint32_t>(prev_end) : 0u;
    uint32_t tail_pad = 0u;
    if (raw_size > 0u && max_align > 1u && (raw_size % max_align) != 0u) {
      tail_pad = max_align - (raw_size % max_align);
    }
    const uint32_t aligned_size = raw_size + tail_pad;
    pad_sum += tail_pad;

    const uint32_t cnt = reg_end - idx;
    if (cnt > primary_field_count) {
      primary_field_count = cnt;
      primary_struct_size = aligned_size;
      primary_struct_align = max_align;
      primary_total_padding = static_cast<uint16_t>(pad_sum > 0xFFFFu ? 0xFFFFu : pad_sum);
    }

    idx = reg_end;
  }

  // Copy to caller output buffers
  const uint32_t emit_bf_cnt = (out_bf != nullptr && max_bf > 0u)
      ? (bf_count < max_bf ? bf_count : max_bf)
      : 0u;
  for (uint32_t i = 0u; i < emit_bf_cnt; ++i) {
    out_bf[i] = bf_buf[i];
  }

  const uint32_t emit_field_cnt = (out_fields != nullptr && max_fields > 0u)
      ? (field_count < max_fields ? field_count : max_fields)
      : 0u;
  for (uint32_t i = 0u; i < emit_field_cnt; ++i) {
    out_fields[i] = fields[i];
  }

  const uint32_t emit_union_cnt = (out_unions != nullptr && max_unions > 0u)
      ? (union_count < max_unions ? union_count : max_unions)
      : 0u;
  for (uint32_t i = 0u; i < emit_union_cnt; ++i) {
    out_unions[i] = unions[i];
  }

  out_summary->bf_count = emit_bf_cnt;
  out_summary->field_count = emit_field_cnt;
  out_summary->union_count = emit_union_cnt;
  out_summary->struct_size = primary_struct_size;
  out_summary->struct_align = primary_struct_align;
  out_summary->total_padding = primary_total_padding;

  return HEX_OK;
}

}  // extern "C"
