#include "hex_hexsig.hpp"
#include "arm64_insn_bits.hpp"

namespace {

constexpr uint8_t kNoReg = 0xFFu;
constexpr uint32_t kMaxLookback = 24u;
constexpr uint32_t kMaxScratchCases = 128u;
constexpr uint32_t kMaxActionChainSteps = 64u;

inline uint16_t read_u16_le(const uint8_t* p, uint32_t off) {
  return static_cast<uint16_t>(p[off]) |
         static_cast<uint16_t>(static_cast<uint16_t>(p[off + 1u]) << 8);
}

inline uint32_t read_u32_le(const uint8_t* p, uint32_t off) {
  return static_cast<uint32_t>(p[off]) |
         (static_cast<uint32_t>(p[off + 1u]) << 8) |
         (static_cast<uint32_t>(p[off + 2u]) << 16) |
         (static_cast<uint32_t>(p[off + 3u]) << 24);
}

inline uint64_t read_u64_le(const uint8_t* p, uint32_t off) {
  return static_cast<uint64_t>(read_u32_le(p, off)) |
         (static_cast<uint64_t>(read_u32_le(p, off + 4u)) << 32);
}

// ============================================================================
// ARM64 Branch & Compare Helpers for Sparse Switch & Jump-Table Recognition
// ============================================================================

inline bool decode_b_cond(uint32_t w, uint8_t& cond, int64_t& delta) {
  if ((w & 0xFF000010u) != 0x54000000u) return false;
  cond = static_cast<uint8_t>(w & 0xFu);
  int32_t imm19 = static_cast<int32_t>((w >> 5) & 0x7FFFFu);
  if (imm19 & 0x40000) imm19 |= ~0x7FFFF;
  delta = static_cast<int64_t>(imm19) * 4LL;
  return true;
}

inline bool decode_b_uncond(uint32_t w, int64_t& delta) {
  if ((w & 0xFC000000u) != 0x14000000u) return false;
  int32_t imm26 = static_cast<int32_t>(w & 0x03FFFFFFu);
  if (imm26 & 0x02000000) imm26 |= ~0x03FFFFFF;
  delta = static_cast<int64_t>(imm26) * 4LL;
  return true;
}

inline bool decode_cbz_cbnz(uint32_t w, bool& is_nz, uint8_t& rt, int64_t& delta) {
  if ((w & 0x7E000000u) != 0x34000000u) return false;
  is_nz = ((w >> 24) & 1u) != 0u;
  rt = static_cast<uint8_t>(w & 31u);
  int32_t imm19 = static_cast<int32_t>((w >> 5) & 0x7FFFFu);
  if (imm19 & 0x40000) imm19 |= ~0x7FFFF;
  delta = static_cast<int64_t>(imm19) * 4LL;
  return true;
}

inline bool decode_sub_imm(uint32_t w, uint8_t& rd, uint8_t& rn, uint32_t& imm) {
  if ((w & 0x5F800000u) != 0x51000000u) return false;
  rd = static_cast<uint8_t>(w & 31u);
  if (rd == 31u) return false;
  rn = static_cast<uint8_t>((w >> 5) & 31u);
  const uint32_t imm12 = (w >> 10) & 0xFFFu;
  const uint32_t sh = (w >> 22) & 1u;
  imm = sh ? (imm12 << 12) : imm12;
  return true;
}

inline bool decode_movz_movk(uint32_t w, bool& is_movk, uint8_t& rd, uint16_t& imm16, uint8_t& shift) {
  if ((w & 0x1F800000u) != 0x12800000u) return false;
  const uint32_t opc = (w >> 29) & 3u;
  if (opc != 2u && opc != 3u) return false;
  is_movk = (opc == 3u);
  rd = static_cast<uint8_t>(w & 31u);
  imm16 = static_cast<uint16_t>((w >> 5) & 0xFFFFu);
  shift = static_cast<uint8_t>(((w >> 21) & 3u) * 16u);
  return true;
}

inline bool decode_cmp_reg(uint32_t w, uint8_t& rn, uint8_t& rm) {
  if ((w & 0x7FE0FC1Fu) != 0x6B00001Fu) return false;
  rn = static_cast<uint8_t>((w >> 5) & 31u);
  rm = static_cast<uint8_t>((w >> 16) & 31u);
  return true;
}

inline bool is_ordering_cond(uint8_t cond) {
  return cond == 2u || cond == 3u || cond == 8u || cond == 9u ||
         cond == 10u || cond == 11u || cond == 12u || cond == 13u;
}

inline bool is_arm64_store(uint32_t w) {
  const hex::arm64::MemOp mop = hex::arm64::decode_imm_mem(w);
  if (mop.valid && mop.is_store) return true;
  if ((w & 0x3A400000u) == 0x28000000u) return true;  // STP
  return false;
}

inline uint8_t extract_gp_written_reg(uint32_t w) {
  const uint8_t rd = static_cast<uint8_t>(w & 31u);
  if (rd >= 31u) return kNoReg;
  if ((w & 0x1C000000u) == 0x10000000u) return rd;
  if ((w & 0x0E000000u) == 0x0A000000u) return rd;
  if ((w & 0x1F000000u) == 0x1A000000u || (w & 0x1F000000u) == 0x1B000000u) return rd;
  const hex::arm64::MemOp mop = hex::arm64::decode_imm_mem(w);
  if (mop.valid && !mop.is_store && !mop.is_float && mop.rt < 31u) return mop.rt;
  return kNoReg;
}

inline void sort_cases(HexSparseSwitchCase* arr, uint32_t n) {
  for (uint32_t i = 1u; i < n; ++i) {
    const HexSparseSwitchCase key = arr[i];
    uint32_t j = i;
    while (j > 0u && arr[j - 1u].case_value > key.case_value) {
      arr[j] = arr[j - 1u];
      --j;
    }
    arr[j] = key;
  }
}

// ============================================================================
// DWARF ULEB128 / SLEB128 & Encoded Pointer Decoders (Strict Bounds/Overflow)
// ============================================================================

inline bool decode_uleb128(const uint8_t* buf, uint32_t len, uint32_t& pos, uint64_t& out) {
  uint64_t result = 0ULL;
  uint32_t shift = 0u;
  for (uint32_t count = 0u; count < 10u; ++count) {
    if (pos >= len) return false;
    const uint8_t byte = buf[pos++];
    if (count == 9u) {
      if ((byte & 0xFEu) != 0u) return false;
    }
    result |= static_cast<uint64_t>(byte & 0x7Fu) << shift;
    if ((byte & 0x80u) == 0u) {
      out = result;
      return true;
    }
    shift += 7u;
  }
  return false;
}

inline bool decode_sleb128(const uint8_t* buf, uint32_t len, uint32_t& pos, int64_t& out) {
  uint64_t result = 0ULL;
  uint32_t shift = 0u;
  for (uint32_t count = 0u; count < 10u; ++count) {
    if (pos >= len) return false;
    const uint8_t byte = buf[pos++];
    if (count == 9u) {
      if ((byte & 0x80u) != 0u) return false;
      if (byte != 0x00u && byte != 0x7Fu) return false;
    }
    result |= static_cast<uint64_t>(byte & 0x7Fu) << shift;
    shift += 7u;
    if ((byte & 0x80u) == 0u) {
      if (shift < 64u && (byte & 0x40u) != 0u) {
        result |= (~0ULL << shift);
      }
      out = static_cast<int64_t>(result);
      return true;
    }
  }
  return false;
}

inline bool read_dwarf_encoded(
    const uint8_t* buf,
    uint32_t len,
    uint32_t& pos,
    uint8_t enc,
    uint64_t base_va,
    uint64_t& out_val,
    bool apply_base) {
  if (enc == HEX_DW_EH_PE_omit) {
    out_val = 0ULL;
    return true;
  }

  // Fail-closed on indirect pointer encodings (cannot dereference target memory safely here)
  if ((enc & HEX_DW_EH_PE_indirect) != 0u) {
    return false;
  }

  const uint8_t fmt = enc & 0x0Fu;
  const uint8_t app = enc & 0x70u;

  // Fail-closed on unresolved relative encodings (pcrel/textrel/datarel require section runtime VA)
  if (app == HEX_DW_EH_PE_pcrel || app == HEX_DW_EH_PE_textrel || app == HEX_DW_EH_PE_datarel) {
    return false;
  }
  if (app != 0u && app != HEX_DW_EH_PE_funcrel && app != HEX_DW_EH_PE_aligned) {
    return false;
  }

  if (app == HEX_DW_EH_PE_aligned) {
    const uint32_t pad = (8u - (pos & 7u)) & 7u;
    if (pad > len - pos) return false;
    pos += pad;
  }

  uint64_t raw = 0ULL;
  switch (fmt) {
    case HEX_DW_EH_PE_absptr:
    case HEX_DW_EH_PE_udata8:
      if (len - pos < 8u) return false;
      raw = read_u64_le(buf, pos);
      pos += 8u;
      break;
    case HEX_DW_EH_PE_uleb128:
      if (!decode_uleb128(buf, len, pos, raw)) return false;
      break;
    case HEX_DW_EH_PE_udata2:
      if (len - pos < 2u) return false;
      raw = read_u16_le(buf, pos);
      pos += 2u;
      break;
    case HEX_DW_EH_PE_udata4:
      if (len - pos < 4u) return false;
      raw = read_u32_le(buf, pos);
      pos += 4u;
      break;
    case HEX_DW_EH_PE_sleb128: {
      int64_t sval = 0;
      if (!decode_sleb128(buf, len, pos, sval)) return false;
      raw = static_cast<uint64_t>(sval);
      break;
    }
    case HEX_DW_EH_PE_sdata2: {
      if (len - pos < 2u) return false;
      const int16_t sval = static_cast<int16_t>(read_u16_le(buf, pos));
      raw = static_cast<uint64_t>(static_cast<int64_t>(sval));
      pos += 2u;
      break;
    }
    case HEX_DW_EH_PE_sdata4: {
      if (len - pos < 4u) return false;
      const int32_t sval = static_cast<int32_t>(read_u32_le(buf, pos));
      raw = static_cast<uint64_t>(static_cast<int64_t>(sval));
      pos += 4u;
      break;
    }
    case HEX_DW_EH_PE_sdata8:
      if (len - pos < 8u) return false;
      raw = read_u64_le(buf, pos);
      pos += 8u;
      break;
    default:
      return false;
  }

  if (apply_base && raw != 0ULL && app == HEX_DW_EH_PE_funcrel) {
    if (raw > ~0ULL - base_va) return false;
    out_val = base_va + raw;
  } else {
    out_val = raw;
  }
  return true;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_sparse_switch_detect")
HexStatus hex_sparse_switch_detect(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint64_t func_va,
    HexSwitchPlan* out_plans,
    uint32_t max_plans,
    HexSparseSwitchCase* out_cases,
    uint32_t max_cases,
    uint32_t* out_plan_count,
    uint32_t* out_case_count) {
  if (code_ptr == nullptr || out_plan_count == nullptr || out_case_count == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  *out_plan_count = 0u;
  *out_case_count = 0u;

  const uint32_t limit = code_len & ~3u;
  if (limit < 8u) return HEX_OK;

  uint32_t plan_count = 0u;
  uint32_t case_count = 0u;

  // --------------------------------------------------------------------------
  // Pass 1: Dense Jump-Table Recognition (BR Xn + bounds + optional SUB min_case)
  // --------------------------------------------------------------------------
  for (uint32_t off = 0u; off < limit && plan_count < max_plans; off += 4u) {
    const uint32_t w = read_u32_le(code_ptr, off);
    uint8_t br_reg = 0u;
    if (!hex::arm64::is_br_reg(w, br_reg) || br_reg == 30u) continue;

    bool has_rel_add = false;
    uint8_t add_rn = kNoReg;
    uint8_t add_rm = kNoReg;
    bool has_load = false;
    uint8_t table_reg = kNoReg;
    uint8_t index_reg = kNoReg;
    uint8_t elem_width = 0u;
    uint8_t scale_shift = 0u;
    bool has_pending_add = false;
    uint32_t pending_add_imm = 0u;
    uint8_t table_adrp_reg = kNoReg;
    bool has_table_va = false;
    uint64_t table_va = 0ULL;
    bool has_bounds = false;
    bool inverted_bounds = false;
    uint32_t entry_count = 0u;
    int64_t min_case = 0;
    uint64_t default_va = 0ULL;
    uint64_t root_va = func_va + static_cast<uint64_t>(off);

    for (uint32_t step = 1u; step <= kMaxLookback; ++step) {
      const uint32_t delta_bytes = step * 4u;
      if (off < delta_bytes) break;
      const uint32_t ioff = off - delta_bytes;
      const uint32_t iw = read_u32_le(code_ptr, ioff);
      if (hex::arm64::is_ret(iw)) break;

      if (!has_load && !has_rel_add) {
        bool is_sub = false, is_float = false, has_rm = false;
        uint8_t rd = 0u, rn = 0u, rm = 0u;
        if (hex::arm64::is_arith_add_sub(iw, is_sub, is_float, rd, rn, rm, has_rm)) {
          if (!is_sub && !is_float && has_rm && rd == br_reg) {
            has_rel_add = true;
            add_rn = rn;
            add_rm = rm;
            continue;
          }
        }
      }

      if (!has_load) {
        uint8_t rt = 0u, rn = 0u, rm = 0u, width = 0u;
        if (hex::arm64::is_reg_offset_load(iw, rt, rn, rm, width)) {
          if (rt == br_reg || (has_rel_add && (rt == add_rn || rt == add_rm))) {
            has_load = true;
            table_reg = rn;
            index_reg = rm;
            elem_width = width;
            table_adrp_reg = table_reg;
            const bool scaled = ((iw >> 12) & 1u) != 0u;
            if (scaled) {
              scale_shift = static_cast<uint8_t>((iw >> 30) & 3u);
            }
            continue;
          }
        }
      }

      if (has_load && !has_table_va) {
        if (!has_pending_add) {
          uint8_t rd = 0u, rn = 0u;
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
          const uint64_t pc = func_va + static_cast<uint64_t>(ioff);
          table_va = (pc & ~0xFFFULL) + static_cast<uint64_t>(page_delta) +
                     (has_pending_add ? static_cast<uint64_t>(pending_add_imm) : 0ULL);
          has_table_va = true;
          continue;
        }
        int64_t adr_delta = 0;
        if (hex::arm64::is_adr(iw, rd2, adr_delta) && rd2 == table_adrp_reg) {
          const uint64_t pc = func_va + static_cast<uint64_t>(ioff);
          table_va = pc + static_cast<uint64_t>(adr_delta) +
                     (has_pending_add ? static_cast<uint64_t>(pending_add_imm) : 0ULL);
          has_table_va = true;
          continue;
        }
      }

      if (!has_bounds) {
        uint8_t cond = 0u;
        int64_t br_delta = 0;
        if (decode_b_cond(iw, cond, br_delta) &&
            (cond == 8u || cond == 2u || cond == 9u || cond == 3u)) {
          const bool is_hi = (cond == 8u);
          const bool is_inv = (cond == 9u || cond == 3u);
          for (uint32_t k = 1u; k <= 4u; ++k) {
            if (ioff < k * 4u) break;
            const uint32_t coff = ioff - k * 4u;
            const uint32_t cw = read_u32_le(code_ptr, coff);
            uint8_t cmp_rn = 0u;
            uint32_t imm = 0u;
            if (hex::arm64::is_cmp_imm(cw, cmp_rn, imm) && (!has_load || cmp_rn == index_reg)) {
              const uint32_t ec = (is_hi || cond == 9u) ? (imm + 1u) : imm;
              if (ec >= 2u && ec <= 4097u) {
                has_bounds = true;
                inverted_bounds = is_inv;
                entry_count = ec;
                root_va = func_va + static_cast<uint64_t>(coff);
                if (!is_inv) {
                  default_va = func_va + static_cast<uint64_t>(ioff) + static_cast<uint64_t>(br_delta);
                }
                if (index_reg == kNoReg) index_reg = cmp_rn;
                for (uint32_t m = 1u; m <= 2u && coff >= m * 4u; ++m) {
                  uint8_t srd = 0u, srn = 0u;
                  uint32_t simm = 0u;
                  if (decode_sub_imm(read_u32_le(code_ptr, coff - m * 4u), srd, srn, simm) &&
                      srd == index_reg) {
                    min_case = static_cast<int64_t>(simm);
                    break;
                  }
                }
                break;
              }
            }
          }
        }
      }
    }

    if (has_load && (has_bounds || has_table_va)) {
      if (out_plans != nullptr) {
        HexSwitchPlan plan{};
        plan.switch_va = root_va;
        plan.default_va = default_va;
        plan.table_va = table_va;
        plan.min_case = min_case;
        plan.max_case = has_bounds ? (min_case + static_cast<int64_t>(entry_count) - 1LL) : min_case;
        plan.case_count = static_cast<uint16_t>(entry_count > 0xFFFFu ? 0xFFFFu : entry_count);
        plan.kind = HEX_SWITCH_DENSE_TABLE;
        plan.index_reg = index_reg;
        plan.elem_width = elem_width;
        plan.scale_shift = scale_shift;
        plan.flags = (default_va != 0ULL ? HEX_SWITCH_FLAG_HAS_DEFAULT : 0u) |
                     (has_table_va ? HEX_SWITCH_FLAG_HAS_TABLE : 0u) |
                     (inverted_bounds ? HEX_SWITCH_FLAG_INVERTED_BOUNDS : 0u);
        out_plans[plan_count] = plan;
      }
      ++plan_count;
    }
  }

  // --------------------------------------------------------------------------
  // Pass 2: Sparse Switch Binary-Search Tree / Cascading CMP+B.EQ Recognition
  //         with clobber clearing and cluster separation across calls/returns
  // --------------------------------------------------------------------------
  uint64_t reg_const[32];
  bool reg_has_const[32];
  for (uint32_t i = 0u; i < 32u; ++i) {
    reg_const[i] = 0ULL;
    reg_has_const[i] = false;
  }

  struct RegSwitchAccum {
    uint32_t first_off;
    uint32_t last_off;
    uint64_t default_va;
    uint16_t eq_count;
    uint16_t ord_count;
  };
  RegSwitchAccum acc[31];
  for (uint32_t r = 0u; r < 31u; ++r) {
    acc[r] = RegSwitchAccum{0xFFFFFFFFu, 0u, 0ULL, 0u, 0u};
  }

  struct RawCaseHit {
    uint8_t reg;
    HexSparseSwitchCase c;
  };
  RawCaseHit raw_hits[kMaxScratchCases];
  uint32_t raw_hit_count = 0u;

  bool has_last_cmp = false;
  uint8_t last_cmp_reg = kNoReg;
  int64_t last_cmp_val = 0;
  uint32_t last_cmp_off = 0u;

  auto flush_clusters = [&]() {
    for (uint8_t r = 0u; r < 31u && plan_count < max_plans; ++r) {
      if (acc[r].eq_count < 3u && !(acc[r].eq_count >= 2u && acc[r].ord_count >= 1u)) {
        continue;
      }
      HexSparseSwitchCase local_cases[kMaxScratchCases];
      uint32_t local_n = 0u;
      for (uint32_t i = 0u; i < raw_hit_count; ++i) {
        if (raw_hits[i].reg != r) continue;
        bool dup = false;
        for (uint32_t k = 0u; k < local_n; ++k) {
          if (local_cases[k].case_value == raw_hits[i].c.case_value) {
            dup = true;
            break;
          }
        }
        if (!dup && local_n < kMaxScratchCases) {
          local_cases[local_n++] = raw_hits[i].c;
        }
      }
      if (local_n < 2u) continue;
      sort_cases(local_cases, local_n);

      uint32_t emitted_for_plan = 0u;
      for (uint32_t i = 0u; i < local_n; ++i) {
        if (out_cases != nullptr && case_count < max_cases) {
          out_cases[case_count++] = local_cases[i];
          ++emitted_for_plan;
        }
      }
      if (out_plans != nullptr) {
        HexSwitchPlan plan{};
        plan.switch_va = func_va + static_cast<uint64_t>(acc[r].first_off);
        plan.default_va = acc[r].default_va;
        plan.table_va = 0ULL;
        plan.min_case = local_cases[0].case_value;
        plan.max_case = local_cases[local_n - 1u].case_value;
        plan.case_count = static_cast<uint16_t>(emitted_for_plan > 0xFFFFu ? 0xFFFFu : emitted_for_plan);
        plan.kind = HEX_SWITCH_SPARSE_BST;
        plan.index_reg = r;
        plan.elem_width = 0u;
        plan.scale_shift = 0u;
        plan.flags = (acc[r].default_va != 0ULL ? HEX_SWITCH_FLAG_HAS_DEFAULT : 0u) |
                     (acc[r].ord_count >= 1u ? HEX_SWITCH_FLAG_BST_BALANCED : 0u);
        out_plans[plan_count] = plan;
      }
      ++plan_count;
    }

    for (uint32_t r = 0u; r < 31u; ++r) {
      acc[r] = RegSwitchAccum{0xFFFFFFFFu, 0u, 0ULL, 0u, 0u};
    }
    raw_hit_count = 0u;
    has_last_cmp = false;
    last_cmp_reg = kNoReg;
  };

  for (uint32_t off = 0u; off < limit; off += 4u) {
    const uint32_t w = read_u32_le(code_ptr, off);

    // Calls / returns separate switch clusters and clobber state
    if (hex::arm64::is_call_or_ret(w)) {
      flush_clusters();
      for (uint32_t r = 0u; r <= 18u; ++r) {
        reg_has_const[r] = false;
      }
      continue;
    }

    // Track MOVZ/MOVK constants for large switch case values
    bool is_movk = false;
    uint8_t mrd = 0u;
    uint16_t mimm = 0u;
    uint8_t mshift = 0u;
    if (decode_movz_movk(w, is_movk, mrd, mimm, mshift) && mrd < 31u) {
      if (!is_movk) {
        reg_const[mrd] = static_cast<uint64_t>(mimm) << mshift;
        reg_has_const[mrd] = true;
      } else if (reg_has_const[mrd]) {
        reg_const[mrd] = (reg_const[mrd] & ~(0xFFFFULL << mshift)) |
                         (static_cast<uint64_t>(mimm) << mshift);
      }
      if (has_last_cmp && mrd == last_cmp_reg) has_last_cmp = false;
      continue;
    }

    // CMP Rn, #imm
    uint8_t cmp_rn = 0u;
    uint32_t cmp_imm = 0u;
    if (hex::arm64::is_cmp_imm(w, cmp_rn, cmp_imm) && cmp_rn < 31u) {
      has_last_cmp = true;
      last_cmp_reg = cmp_rn;
      last_cmp_val = static_cast<int64_t>(cmp_imm);
      last_cmp_off = off;
      continue;
    }

    // CMP Rn, Rm (where Rm holds a materialized constant)
    uint8_t crn = 0u, crm = 0u;
    if (decode_cmp_reg(w, crn, crm) && crn < 31u && crm < 31u) {
      if (reg_has_const[crm]) {
        has_last_cmp = true;
        last_cmp_reg = crn;
        last_cmp_val = static_cast<int64_t>(reg_const[crm]);
        last_cmp_off = off;
      } else {
        has_last_cmp = false;
      }
      continue;
    }

    // CBZ Rt, target -> case 0
    bool is_nz = false;
    uint8_t cb_rt = 0u;
    int64_t cb_delta = 0;
    if (decode_cbz_cbnz(w, is_nz, cb_rt, cb_delta) && cb_rt < 31u) {
      if (!is_nz) {
        const uint64_t target = func_va + static_cast<uint64_t>(off) + static_cast<uint64_t>(cb_delta);
        if (raw_hit_count < kMaxScratchCases) {
          raw_hits[raw_hit_count++] = RawCaseHit{
              cb_rt, HexSparseSwitchCase{0, target, off, off}};
        }
        if (acc[cb_rt].first_off == 0xFFFFFFFFu) acc[cb_rt].first_off = off;
        acc[cb_rt].last_off = off;
        acc[cb_rt].eq_count++;
      }
      continue;
    }

    // B.cond following CMP
    uint8_t cond = 0u;
    int64_t br_delta = 0;
    if (decode_b_cond(w, cond, br_delta)) {
      if (has_last_cmp && last_cmp_reg < 31u && (off - last_cmp_off) <= 12u) {
        const uint64_t target = func_va + static_cast<uint64_t>(off) + static_cast<uint64_t>(br_delta);
        if (cond == 0u) {
          if (raw_hit_count < kMaxScratchCases) {
            raw_hits[raw_hit_count++] = RawCaseHit{
                last_cmp_reg, HexSparseSwitchCase{last_cmp_val, target, last_cmp_off, off}};
          }
          if (acc[last_cmp_reg].first_off == 0xFFFFFFFFu) acc[last_cmp_reg].first_off = last_cmp_off;
          acc[last_cmp_reg].last_off = off;
          acc[last_cmp_reg].eq_count++;
        } else if (is_ordering_cond(cond)) {
          if (acc[last_cmp_reg].first_off == 0xFFFFFFFFu) acc[last_cmp_reg].first_off = last_cmp_off;
          acc[last_cmp_reg].last_off = off;
          acc[last_cmp_reg].ord_count++;
        }
      }
      continue;
    }

    // Unconditional B immediately after a CMP/B.cond chain -> default target
    int64_t ub_delta = 0;
    if (decode_b_uncond(w, ub_delta)) {
      if (has_last_cmp && last_cmp_reg < 31u &&
          (off - acc[last_cmp_reg].last_off) <= 8u && acc[last_cmp_reg].eq_count >= 2u) {
        acc[last_cmp_reg].default_va = func_va + static_cast<uint64_t>(off) + static_cast<uint64_t>(ub_delta);
      }
      has_last_cmp = false;
      continue;
    }

    // Stores or other non-compare/non-branch instructions clear stale compare state & overwritten constants
    if (is_arm64_store(w)) {
      has_last_cmp = false;
      continue;
    }
    const uint8_t written_rd = extract_gp_written_reg(w);
    if (written_rd < 31u) {
      reg_has_const[written_rd] = false;
      if (has_last_cmp && written_rd == last_cmp_reg) {
        has_last_cmp = false;
      }
    }
    // Any flag-setting instruction (ADDS/SUBS/ANDS) clobbers NZCV
    if ((w & 0x3F800000u) == 0x29000000u || (w & 0x20000000u) != 0u) {
      has_last_cmp = false;
    }
  }

  flush_clusters();

  *out_plan_count = plan_count;
  *out_case_count = case_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_lsda_parse")
HexStatus hex_lsda_parse(
    const uint8_t* lsda_ptr,
    uint32_t lsda_len,
    uint64_t func_va,
    HexLsdaHeader* out_header,
    HexLsdaCallSite* out_sites,
    uint32_t max_sites,
    HexLsdaAction* out_actions,
    uint32_t max_actions) {
  if (lsda_ptr == nullptr || out_header == nullptr || lsda_len < 3u) {
    return HEX_ERR_INVALID_ARG;
  }

  out_header->lp_start_va = func_va;
  out_header->call_site_count = 0u;
  out_header->action_count = 0u;
  out_header->ttype_base_off = 0u;
  out_header->action_table_off = 0u;
  out_header->lp_start_enc = HEX_DW_EH_PE_omit;
  out_header->ttype_enc = HEX_DW_EH_PE_omit;
  out_header->call_site_enc = HEX_DW_EH_PE_omit;
  out_header->flags = 0u;
  out_header->call_site_tbl_len = 0u;

  uint32_t pos = 0u;

  // 1. LPStart encoding & optional value
  const uint8_t lp_start_enc = lsda_ptr[pos++];
  out_header->lp_start_enc = lp_start_enc;
  if (lp_start_enc != HEX_DW_EH_PE_omit) {
    uint64_t lp_val = 0ULL;
    if (!read_dwarf_encoded(lsda_ptr, lsda_len, pos, lp_start_enc, func_va, lp_val, true)) {
      return HEX_ERR_INVALID_ARG;
    }
    out_header->lp_start_va = lp_val;
    out_header->flags |= HEX_LSDA_HDR_HAS_LP_START;
  }

  // 2. TType encoding & optional ULEB128 base offset
  if (pos >= lsda_len) return HEX_ERR_INVALID_ARG;
  const uint8_t ttype_enc = lsda_ptr[pos++];
  out_header->ttype_enc = ttype_enc;
  uint32_t ttype_base_off = 0u;
  if (ttype_enc != HEX_DW_EH_PE_omit) {
    uint64_t ttype_rel = 0ULL;
    if (!decode_uleb128(lsda_ptr, lsda_len, pos, ttype_rel)) {
      return HEX_ERR_INVALID_ARG;
    }
    if (ttype_rel > static_cast<uint64_t>(lsda_len - pos)) {
      return HEX_ERR_INVALID_ARG;
    }
    ttype_base_off = pos + static_cast<uint32_t>(ttype_rel);
    out_header->ttype_base_off = ttype_base_off;
    out_header->flags |= HEX_LSDA_HDR_HAS_TTYPE;
  }

  // 3. Call-Site encoding & ULEB128 table byte length
  if (pos >= lsda_len) return HEX_ERR_INVALID_ARG;
  const uint8_t cs_enc = lsda_ptr[pos++];
  if (cs_enc == HEX_DW_EH_PE_omit) return HEX_ERR_INVALID_ARG;
  out_header->call_site_enc = cs_enc;

  uint64_t cs_tbl_len64 = 0ULL;
  if (!decode_uleb128(lsda_ptr, lsda_len, pos, cs_tbl_len64)) {
    return HEX_ERR_INVALID_ARG;
  }
  if (cs_tbl_len64 > static_cast<uint64_t>(lsda_len - pos)) {
    return HEX_ERR_INVALID_ARG;
  }
  const uint32_t cs_tbl_len = static_cast<uint32_t>(cs_tbl_len64);
  const uint32_t cs_tbl_end = pos + cs_tbl_len;
  out_header->call_site_tbl_len = cs_tbl_len;
  out_header->action_table_off = cs_tbl_end;

  const uint32_t act_start = cs_tbl_end;
  const uint32_t act_end = (ttype_base_off > act_start && ttype_base_off <= lsda_len)
      ? ttype_base_off
      : lsda_len;

  uint32_t site_count = 0u;
  uint32_t action_count = 0u;
  const uint32_t effective_max_actions = (max_actions < 0xFFFFu) ? max_actions : 0xFFFFu;

  auto find_action_by_offset = [&](uint32_t table_off) -> uint16_t {
    if (out_actions == nullptr) return 0xFFFFu;
    for (uint32_t i = 0u; i < action_count; ++i) {
      if (out_actions[i].table_offset == table_off) {
        return static_cast<uint16_t>(i);
      }
    }
    return 0xFFFFu;
  };

  // Validate and optionally emit an action chain (invoked for ALL call sites, even truncated ones)
  auto process_action_chain = [&](uint32_t first_act_off, HexLsdaCallSite* site_ptr) -> bool {
    if (first_act_off == 0u) return true;
    if (act_start >= act_end || first_act_off - 1u >= act_end - act_start) {
      return false;
    }

    uint32_t cur_off = first_act_off;
    uint32_t visited_offs[kMaxActionChainSteps];
    uint32_t visited_n = 0u;
    uint16_t prev_idx = 0xFFFFu;

    while (cur_off != 0u) {
      if (visited_n >= kMaxActionChainSteps) return false;
      for (uint32_t v = 0u; v < visited_n; ++v) {
        if (visited_offs[v] == cur_off) return false;  // Cycle detected
      }
      visited_offs[visited_n++] = cur_off;

      if (cur_off - 1u >= act_end - act_start) return false;
      uint32_t apos = act_start + (cur_off - 1u);

      int64_t tfilter = 0;
      if (!decode_sleb128(lsda_ptr, act_end, apos, tfilter)) {
        return false;
      }
      if (tfilter < -2147483648LL || tfilter > 2147483647LL) {
        return false;
      }

      const uint32_t disp_pos = apos;
      int64_t next_disp = 0;
      if (!decode_sleb128(lsda_ptr, act_end, apos, next_disp)) {
        return false;
      }
      if (next_disp < -2147483648LL || next_disp > 2147483647LL) {
        return false;
      }

      uint16_t aflags = 0u;
      if (tfilter == 0) {
        aflags = HEX_LSDA_ACT_CLEANUP;
        if (site_ptr != nullptr) site_ptr->flags |= HEX_LSDA_CS_IS_CLEANUP;
      } else if (tfilter > 0) {
        aflags = HEX_LSDA_ACT_CATCH;
        if (site_ptr != nullptr) site_ptr->flags |= HEX_LSDA_CS_HAS_CATCH;
      } else {
        aflags = HEX_LSDA_ACT_FILTER;
        if (site_ptr != nullptr) site_ptr->flags |= HEX_LSDA_CS_HAS_FILTER;
      }

      if (site_ptr != nullptr) {
        uint16_t cur_idx = find_action_by_offset(cur_off);
        if (cur_idx == 0xFFFFu) {
          if (out_actions != nullptr && action_count < effective_max_actions) {
            cur_idx = static_cast<uint16_t>(action_count);
            HexLsdaAction act{};
            act.type_filter = static_cast<int32_t>(tfilter);
            act.next_disp = static_cast<int32_t>(next_disp);
            act.table_offset = cur_off;
            act.next_index = 0xFFFFu;
            act.flags = aflags;
            out_actions[action_count++] = act;
          } else {
            out_header->flags |= HEX_LSDA_HDR_TRUNCATED_OUT;
          }
        }
        if (cur_off == first_act_off && cur_idx != 0xFFFFu) {
          site_ptr->action_index = cur_idx;
        }
        if (prev_idx != 0xFFFFu && cur_idx != 0xFFFFu && out_actions != nullptr) {
          out_actions[prev_idx].next_index = cur_idx;
        }
        prev_idx = cur_idx;
      }

      if (next_disp == 0) {
        cur_off = 0u;
      } else {
        const int64_t next_pos = static_cast<int64_t>(disp_pos) + next_disp;
        if (next_pos < static_cast<int64_t>(act_start) ||
            next_pos >= static_cast<int64_t>(act_end)) {
          return false;
        }
        cur_off = static_cast<uint32_t>(next_pos - static_cast<int64_t>(act_start)) + 1u;
      }
    }
    return true;
  };

  // 4. Parse & validate ALL Call-Site entries strictly within [pos, cs_tbl_end)
  while (pos < cs_tbl_end) {
    uint64_t cs_start = 0ULL;
    uint64_t cs_len = 0ULL;
    uint64_t cs_lp = 0ULL;
    uint64_t cs_action = 0ULL;

    if (!read_dwarf_encoded(lsda_ptr, cs_tbl_end, pos, cs_enc, 0ULL, cs_start, false)) {
      return HEX_ERR_INVALID_ARG;
    }
    if (!read_dwarf_encoded(lsda_ptr, cs_tbl_end, pos, cs_enc, 0ULL, cs_len, false)) {
      return HEX_ERR_INVALID_ARG;
    }
    if (!read_dwarf_encoded(lsda_ptr, cs_tbl_end, pos, cs_enc, 0ULL, cs_lp, false)) {
      return HEX_ERR_INVALID_ARG;
    }
    if (!decode_uleb128(lsda_ptr, cs_tbl_end, pos, cs_action)) {
      return HEX_ERR_INVALID_ARG;
    }
    if (cs_action > 0xFFFFFFFFULL) {
      return HEX_ERR_INVALID_ARG;
    }

    if (cs_start > ~0ULL - func_va) return HEX_ERR_INVALID_ARG;
    const uint64_t try_start = func_va + cs_start;
    if (cs_len > ~0ULL - try_start) return HEX_ERR_INVALID_ARG;
    const uint64_t try_end = try_start + cs_len;
    uint64_t lp_va = 0ULL;
    if (cs_lp != 0ULL) {
      if (cs_lp > ~0ULL - out_header->lp_start_va) return HEX_ERR_INVALID_ARG;
      lp_va = out_header->lp_start_va + cs_lp;
    }

    HexLsdaCallSite* site_ptr = nullptr;
    if (out_sites != nullptr && site_count < max_sites) {
      HexLsdaCallSite cs{};
      cs.try_start_va = try_start;
      cs.try_end_va = try_end;
      cs.landing_pad_va = lp_va;
      cs.action_offset = static_cast<uint32_t>(cs_action);
      cs.action_index = 0xFFFFu;
      cs.flags = (lp_va != 0ULL ? HEX_LSDA_CS_HAS_LP : 0u) |
                 ((lp_va != 0ULL && cs_action == 0ULL) ? HEX_LSDA_CS_IS_CLEANUP : 0u);
      out_sites[site_count] = cs;
      site_ptr = &out_sites[site_count++];
    } else {
      out_header->flags |= HEX_LSDA_HDR_TRUNCATED_OUT;
    }

    if (!process_action_chain(static_cast<uint32_t>(cs_action), site_ptr)) {
      return HEX_ERR_INVALID_ARG;
    }
  }

  out_header->call_site_count = site_count;
  out_header->action_count = action_count;
  return HEX_OK;
}

}  // extern "C"
