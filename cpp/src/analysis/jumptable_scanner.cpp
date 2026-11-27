#include "hex_abi.hpp"
#include "arm64_insn_bits.hpp"

namespace {

constexpr uint32_t kRecordBytes = 24u;
constexpr uint32_t kMaxLookbackInsns = 24u;
constexpr uint32_t kMaxCmpLookbackInsns = 4u;
constexpr uint32_t kNoCmpOff = 0xFFFFFFFFu;
constexpr uint8_t kUnknownReg = 0xFFu;

constexpr uint8_t kFlagHasBounds = 1u;
constexpr uint8_t kFlagRelativeAdd = 2u;
constexpr uint8_t kFlagHasTableVa = 4u;

inline void write_u32_le(uint8_t* out, uint32_t off, uint32_t val) {
  out[off] = static_cast<uint8_t>(val & 0xFFu);
  out[off + 1u] = static_cast<uint8_t>((val >> 8) & 0xFFu);
  out[off + 2u] = static_cast<uint8_t>((val >> 16) & 0xFFu);
  out[off + 3u] = static_cast<uint8_t>((val >> 24) & 0xFFu);
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_scan_arm64_jumptables")
uint32_t hex_scan_arm64_jumptables(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint32_t text_va_lo,
    uint32_t text_va_hi,
    uint8_t* out_ptr,
    uint32_t max_out) {
  if (!code_ptr || !out_ptr || code_len < 4u || max_out == 0u) {
    return 0u;
  }

  const uint64_t text_va = static_cast<uint64_t>(text_va_lo) |
                           (static_cast<uint64_t>(text_va_hi) << 32);
  const uint32_t limit = code_len & ~3u;
  uint32_t count = 0u;

  for (uint32_t off = 0u; off < limit && count < max_out; off += 4u) {
    const uint32_t w = hex::arm64::read_u32_le(code_ptr, off);
    uint8_t target = 0u;
    if (!hex::arm64::is_br_reg(w, target) || target == 30u) {
      continue;
    }

    const uint8_t cur_reg = target;
    bool has_rel_add = false;
    uint8_t add_rn = kUnknownReg;
    uint8_t add_rm = kUnknownReg;

    bool has_load = false;
    uint8_t table_reg = kUnknownReg;
    uint8_t index_reg = kUnknownReg;
    uint8_t elem_width = 0u;

    bool has_pending_add = false;
    uint32_t pending_add_imm = 0u;
    uint8_t table_adrp_reg = kUnknownReg;
    bool has_table_va = false;
    uint64_t table_va = 0ULL;

    bool has_bounds = false;
    uint32_t cmp_off = kNoCmpOff;
    uint32_t entry_count = 0u;

    uint8_t flags = 0u;

    for (uint32_t step = 1u; step <= kMaxLookbackInsns; ++step) {
      const uint32_t delta_bytes = step * 4u;
      if (off < delta_bytes) break;
      const uint32_t insn_off = off - delta_bytes;
      const uint32_t iw = hex::arm64::read_u32_le(code_ptr, insn_off);
      if (hex::arm64::is_ret(iw)) break;

      // 1. Relative jump-table target add: add Xcur, Xrn, Xrm
      if (!has_load && !has_rel_add) {
        bool is_sub = false;
        bool is_float = false;
        bool has_rm = false;
        uint8_t rd = 0u;
        uint8_t rn = 0u;
        uint8_t rm = 0u;
        if (hex::arm64::is_arith_add_sub(iw, is_sub, is_float, rd, rn, rm, has_rm)) {
          if (!is_sub && !is_float && has_rm && rd == cur_reg) {
            has_rel_add = true;
            add_rn = rn;
            add_rm = rm;
            flags |= kFlagRelativeAdd;
            continue;
          }
        }
      }

      // 2. Indexed table load: ldr/ldrsw/ldrh/ldrb Rt, [Rn, Rm, ...]
      if (!has_load) {
        uint8_t rt = 0u;
        uint8_t rn = 0u;
        uint8_t rm = 0u;
        uint8_t width = 0u;
        if (hex::arm64::is_reg_offset_load(iw, rt, rn, rm, width)) {
          const bool rt_match = (rt == cur_reg) ||
                                (has_rel_add && (rt == add_rn || rt == add_rm));
          if (rt_match) {
            has_load = true;
            table_reg = rn;
            index_reg = rm;
            elem_width = width;
            table_adrp_reg = table_reg;
            continue;
          }
        }
      }

      // 3. Table base VA resolution: (adrp + add_imm) or standalone adrp / adr
      if (has_load && !has_table_va) {
        if (!has_pending_add) {
          uint8_t rd = 0u;
          uint8_t rn = 0u;
          uint32_t imm = 0u;
          if (hex::arm64::is_add_imm(iw, rd, rn, imm) && rd == table_reg) {
            has_pending_add = true;
            pending_add_imm = imm;
            table_adrp_reg = rn;
            continue;
          }
        }

        uint8_t rd2 = 0u;
        int64_t page_delta = 0;
        if (hex::arm64::is_adrp(iw, rd2, page_delta) && rd2 == table_adrp_reg) {
          const uint64_t pc = text_va + static_cast<uint64_t>(insn_off);
          const uint64_t add_off = has_pending_add ? static_cast<uint64_t>(pending_add_imm) : 0ULL;
          table_va = (pc & ~0xFFFULL) + static_cast<uint64_t>(page_delta) + add_off;
          has_table_va = true;
          flags |= kFlagHasTableVa;
          continue;
        }

        int64_t adr_delta = 0;
        if (hex::arm64::is_adr(iw, rd2, adr_delta) && rd2 == table_adrp_reg) {
          const uint64_t pc = text_va + static_cast<uint64_t>(insn_off);
          const uint64_t add_off = has_pending_add ? static_cast<uint64_t>(pending_add_imm) : 0ULL;
          table_va = pc + static_cast<uint64_t>(adr_delta) + add_off;
          has_table_va = true;
          flags |= kFlagHasTableVa;
          continue;
        }
      }

      // 4. Bounds check: cmp X/Windex, #imm followed within 1..4 insns by b.hi / b.hs
      if (!has_bounds) {
        bool is_hi = false;
        if (hex::arm64::is_b_hi_hs(iw, is_hi)) {
          for (uint32_t k = 1u; k <= kMaxCmpLookbackInsns; ++k) {
            const uint32_t cmp_delta = k * 4u;
            if (insn_off < cmp_delta) break;
            const uint32_t cmp_insn_off = insn_off - cmp_delta;
            const uint32_t cw = hex::arm64::read_u32_le(code_ptr, cmp_insn_off);
            if (hex::arm64::is_ret(cw)) break;
            uint8_t cmp_rn = 0u;
            uint32_t imm = 0u;
            if (hex::arm64::is_cmp_imm(cw, cmp_rn, imm)) {
              if (!has_load || cmp_rn == index_reg) {
                const uint32_t ec = is_hi ? (imm + 1u) : imm;
                if (ec >= 2u && ec <= 4097u) {
                  has_bounds = true;
                  cmp_off = cmp_insn_off;
                  entry_count = ec;
                  if (!has_load && index_reg == kUnknownReg) {
                    index_reg = cmp_rn;
                  }
                  flags |= kFlagHasBounds;
                  break;
                }
              }
            }
          }
        }
      }
    }

    // 5. Emit record if at least load, bounds, or table VA was detected
    if (!has_load && !has_bounds && !has_table_va) {
      continue;
    }

    const uint32_t rec_off = count * kRecordBytes;
    write_u32_le(out_ptr, rec_off + 0u, off);
    write_u32_le(out_ptr, rec_off + 4u, has_bounds ? cmp_off : kNoCmpOff);
    write_u32_le(out_ptr, rec_off + 8u, has_bounds ? entry_count : 0u);
    write_u32_le(out_ptr, rec_off + 12u, has_table_va ? static_cast<uint32_t>(table_va & 0xFFFFFFFFULL) : 0u);
    write_u32_le(out_ptr, rec_off + 16u, has_table_va ? static_cast<uint32_t>(table_va >> 32) : 0u);
    out_ptr[rec_off + 20u] = elem_width;
    out_ptr[rec_off + 21u] = index_reg;
    out_ptr[rec_off + 22u] = target;
    out_ptr[rec_off + 23u] = flags;
    count++;
  }

  return count;
}

}  // extern "C"
