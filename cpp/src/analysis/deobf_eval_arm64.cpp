#include "hex_deobf.hpp"

namespace {

inline uint32_t read_u32_le(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

inline int64_t sign_extend(uint64_t val, uint32_t bits) {
  const uint32_t shift = 64u - bits;
  return static_cast<int64_t>(val << shift) >> shift;
}

inline uint64_t splitmix64_next(uint64_t& state) {
  state += 0x9E3779B97F4A7C15ULL;
  uint64_t z = state;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
  return z ^ (z >> 31);
}

bool decode_cond_branch_target(uint32_t insn, uint64_t branch_va, uint64_t& out_target) {
  if ((insn & 0xFF000010u) == 0x54000000u) {
    const int64_t delta = sign_extend((insn >> 5) & 0x7FFFFu, 19u) << 2;
    out_target = static_cast<uint64_t>(static_cast<int64_t>(branch_va) + delta);
    return true;
  }
  if ((insn & 0x7E000000u) == 0x34000000u) {
    const int64_t delta = sign_extend((insn >> 5) & 0x7FFFFu, 19u) << 2;
    out_target = static_cast<uint64_t>(static_cast<int64_t>(branch_va) + delta);
    return true;
  }
  if ((insn & 0x7E000000u) == 0x36000000u) {
    const int64_t delta = sign_extend((insn >> 5) & 0x3FFFu, 14u) << 2;
    out_target = static_cast<uint64_t>(static_cast<int64_t>(branch_va) + delta);
    return true;
  }
  return false;
}

bool is_indirect_branch(uint32_t insn, uint32_t& out_rn) {
  if ((insn & 0xFFFFFC1Fu) == 0xD61F0000u || (insn & 0xFFFFFC1Fu) == 0xD63F0000u) {
    out_rn = (insn >> 5) & 31u;
    return true;
  }
  return false;
}

inline void mark_reg(uint32_t& mask, uint32_t r) {
  if (r < 31u) mask |= (1u << r);
}

// Track GPRs written by a successfully executed instruction.
void record_written_regs(uint32_t insn, uint32_t& written_mask) {
  // BL / BLR write x30
  if ((insn & 0xFC000000u) == 0x94000000u || (insn & 0xFFFFFC1Fu) == 0xD63F0000u) {
    mark_reg(written_mask, 30u);
    return;
  }
  // ADR / ADRP, MOVZ/MOVN/MOVK, ADD/SUB imm/reg, Logical imm/reg, MADD/MSUB, CSEL, SBFM/UBFM, LDR lit
  if ((insn & 0x1F000000u) == 0x10000000u ||
      (insn & 0x1F800000u) == 0x12800000u ||
      (insn & 0x1F800000u) == 0x11000000u ||
      (insn & 0x1F200000u) == 0x0B000000u ||
      (insn & 0x1F000000u) == 0x0A000000u ||
      (insn & 0x1F800000u) == 0x12000000u ||
      (insn & 0x7FE00000u) == 0x1B000000u ||
      (insn & 0x3FE00800u) == 0x1A800000u ||
      (insn & 0x1F800000u) == 0x13000000u ||
      (insn & 0x3F000000u) == 0x18000000u) {
    mark_reg(written_mask, insn & 31u);
    return;
  }
  // LDP / STP
  if ((insn & 0x3E000000u) == 0x28000000u) {
    const uint32_t mode = (insn >> 23) & 3u;
    if (((insn >> 22) & 1u) != 0u) {  // LDP
      mark_reg(written_mask, insn & 31u);
      mark_reg(written_mask, (insn >> 10) & 31u);
    }
    if (mode == 1u || mode == 3u) {  // writeback Rn
      mark_reg(written_mask, (insn >> 5) & 31u);
    }
    return;
  }
  // LDR/STR unsigned offset / register offset
  if ((insn & 0x3F000000u) == 0x39000000u || (insn & 0x3F200C00u) == 0x38200800u) {
    const uint32_t opc = (insn >> 22) & 3u;
    if (opc == 1u || opc == 2u) {
      mark_reg(written_mask, insn & 31u);
    }
    return;
  }
  // LDR/STR pre/post-index
  if ((insn & 0x3F200400u) == 0x38000400u) {
    const uint32_t opc = (insn >> 22) & 3u;
    if (opc == 1u) mark_reg(written_mask, insn & 31u);
    mark_reg(written_mask, (insn >> 5) & 31u);
    return;
  }
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_deobf_eval_opaque_branch")
HexStatus hex_deobf_eval_opaque_branch(
    const uint8_t* code_ptr, uint32_t code_len,
    uint64_t code_va, uint64_t entry_va, uint64_t branch_va,
    uint32_t step_limit, HexOpaqueBranchResult* out_result) {
  if (code_ptr == nullptr || out_result == nullptr || code_len < 4u || step_limit == 0u) {
    return HEX_ERR_INVALID_ARG;
  }

  out_result->outcome = HEX_OPAQUE_UNKNOWN;
  out_result->samples_tested = 0u;
  out_result->taken_count = 0u;
  out_result->fault_code = HEX_ARM64_FAULT_NONE;
  out_result->branch_va = branch_va;
  out_result->taken_target = 0ULL;
  out_result->fallthrough_va = branch_va + 4ULL;
  out_result->resolved_target = 0ULL;

  if ((branch_va & 3ULL) != 0ULL || branch_va < code_va ||
      (branch_va - code_va) + 4ULL > static_cast<uint64_t>(code_len)) {
    out_result->fault_code = HEX_ARM64_FAULT_PC_OOB;
    return HEX_ERR_INVALID_ARG;
  }

  const uint32_t branch_insn =
      read_u32_le(code_ptr + static_cast<uint32_t>(branch_va - code_va));
  uint64_t taken_target = 0ULL;
  if (!decode_cond_branch_target(branch_insn, branch_va, taken_target)) {
    out_result->fault_code = HEX_ARM64_FAULT_UNSUPPORTED_INSN;
    return HEX_ERR_UNSUPPORTED;
  }
  out_result->taken_target = taken_target;

  // Deterministic input sample suite across ALL 8 argument registers x0..x7:
  // 8 boundary-value permutations + 8 SplitMix64 vectors.
  static constexpr uint32_t kNumSamples = 16u;
  static constexpr uint64_t kSeedValues[8] = {
      0ULL,
      1ULL,
      2ULL,
      5ULL,
      7ULL,
      42ULL,
      0x7FFFFFFFULL,
      0xFFFFFFFFFFFFFFFFULL,
  };

  uint64_t rng = 0x517CC1B727220A95ULL;
  uint32_t reached = 0u;
  uint32_t taken = 0u;
  uint32_t last_fault = HEX_ARM64_FAULT_NONE;

  HexArm64EmuState emu;
  for (uint32_t s = 0u; s < kNumSamples; ++s) {
    if (hex_arm64_emu_init(&emu, entry_va, code_va, code_len, step_limit) != HEX_OK) {
      return HEX_ERR_INVALID_ARG;
    }
    if (s < 8u) {
      for (uint32_t r = 0u; r < 8u; ++r) {
        emu.x[r] = kSeedValues[(s + r) & 7u];
      }
    } else {
      for (uint32_t r = 0u; r < 8u; ++r) {
        emu.x[r] = splitmix64_next(rng);
      }
    }

    bool hit_branch = false;
    while (emu.halted == 0u) {
      if (emu.pc == branch_va) {
        hit_branch = true;
        break;
      }
      const HexStatus st = hex_arm64_emu_step(&emu, code_ptr, code_len);
      if (st != HEX_OK) {
        last_fault = emu.fault_code;
        break;
      }
    }

    if (!hit_branch) {
      if (last_fault == HEX_ARM64_FAULT_NONE) {
        last_fault = emu.fault_code;
      }
      continue;
    }

    const HexStatus bst = hex_arm64_emu_step(&emu, code_ptr, code_len);
    if (bst != HEX_OK) {
      last_fault = emu.fault_code;
      continue;
    }

    ++reached;
    if (emu.pc == taken_target && taken_target != branch_va + 4ULL) {
      ++taken;
    } else if (emu.pc != branch_va + 4ULL) {
      ++taken;
    }
  }

  out_result->samples_tested = reached;
  out_result->taken_count = taken;
  out_result->fault_code = last_fault;

  if (reached == kNumSamples) {
    if (taken == kNumSamples) {
      out_result->outcome = HEX_OPAQUE_ALWAYS_TAKEN;
      out_result->resolved_target = taken_target;
    } else if (taken == 0u) {
      out_result->outcome = HEX_OPAQUE_NEVER_TAKEN;
      out_result->resolved_target = branch_va + 4ULL;
    } else {
      out_result->outcome = HEX_OPAQUE_UNKNOWN;
      out_result->resolved_target = 0ULL;
    }
  }

  return HEX_OK;
}

HEX_WASM_EXPORT("hex_deobf_resolve_indirect_target")
HexStatus hex_deobf_resolve_indirect_target(
    const uint8_t* code_ptr, uint32_t code_len,
    uint64_t code_va, uint64_t entry_va, uint64_t init_x0,
    uint32_t step_limit, HexIndirectTargetResult* out_result) {
  if (code_ptr == nullptr || out_result == nullptr || code_len < 4u || step_limit == 0u) {
    return HEX_ERR_INVALID_ARG;
  }

  out_result->resolved = 0u;
  out_result->fault_code = HEX_ARM64_FAULT_NONE;
  out_result->steps_used = 0u;
  out_result->reg_index = 0u;
  out_result->branch_va = 0ULL;
  out_result->target_va = 0ULL;

  HexArm64EmuState emu;
  if (hex_arm64_emu_init(&emu, entry_va, code_va, code_len, step_limit) != HEX_OK) {
    return HEX_ERR_INVALID_ARG;
  }
  emu.x[0] = init_x0;

  // Track initialized/written GPRs: x0 is explicitly initialized via init_x0.
  uint32_t written_regs = (1u << 0);

  while (emu.halted == 0u) {
    if (emu.pc == HEX_ARM64_EMU_SENTINEL_LR) {
      out_result->fault_code = HEX_ARM64_FAULT_HALTED_RET;
      out_result->steps_used = emu.step_count;
      return HEX_OK;
    }
    // Enforce step_limit BEFORE decoding/executing the next instruction.
    if (emu.step_count >= step_limit) {
      out_result->fault_code = HEX_ARM64_FAULT_STEP_LIMIT;
      out_result->steps_used = emu.step_count;
      return HEX_OK;
    }
    if ((emu.pc & 3ULL) != 0ULL || emu.pc < code_va ||
        (emu.pc - code_va) + 4ULL > static_cast<uint64_t>(code_len)) {
      out_result->fault_code = HEX_ARM64_FAULT_PC_OOB;
      out_result->steps_used = emu.step_count;
      return HEX_OK;
    }

    const uint32_t insn = read_u32_le(code_ptr + static_cast<uint32_t>(emu.pc - code_va));
    uint32_t rn = 0u;
    if (is_indirect_branch(insn, rn)) {
      // Fail-close on XZR (rn==31), uninitialized target register, or null target (0ULL).
      const bool reg_init = (rn < 31u) && (((written_regs >> rn) & 1u) != 0u);
      const uint64_t target = reg_init ? emu.x[rn] : 0ULL;
      out_result->reg_index = rn;
      out_result->branch_va = emu.pc;
      out_result->steps_used = emu.step_count + 1u;
      if (!reg_init || target == 0ULL) {
        out_result->resolved = 0u;
        out_result->fault_code = HEX_ARM64_FAULT_NONE;
        out_result->target_va = 0ULL;
        return HEX_OK;
      }
      out_result->resolved = 1u;
      out_result->fault_code = HEX_ARM64_FAULT_NONE;
      out_result->target_va = target;
      return HEX_OK;
    }

    const HexStatus st = hex_arm64_emu_step(&emu, code_ptr, code_len);
    if (st != HEX_OK) {
      out_result->fault_code = emu.fault_code;
      out_result->steps_used = emu.step_count;
      return HEX_OK;
    }
    record_written_regs(insn, written_regs);
  }

  out_result->fault_code = emu.fault_code;
  out_result->steps_used = emu.step_count;
  return HEX_OK;
}

}  // extern "C"
