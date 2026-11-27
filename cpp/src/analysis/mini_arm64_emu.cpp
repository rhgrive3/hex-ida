#include "hex_deobf.hpp"

namespace {

inline int64_t sign_extend(uint64_t val, uint32_t bits) {
  const uint32_t shift = 64u - bits;
  return static_cast<int64_t>(val << shift) >> shift;
}

inline uint32_t read_u32_le(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

inline uint64_t read_le_bytes(const uint8_t* p, uint32_t width) {
  uint64_t v = 0ULL;
  for (uint32_t i = 0u; i < width; ++i) {
    v |= static_cast<uint64_t>(p[i]) << (i * 8u);
  }
  return v;
}

inline void write_le_bytes(uint8_t* p, uint32_t width, uint64_t v) {
  for (uint32_t i = 0u; i < width; ++i) {
    p[i] = static_cast<uint8_t>((v >> (i * 8u)) & 0xFFULL);
  }
}

inline uint64_t read_gpr(const HexArm64EmuState* s, uint32_t reg, bool sp_mode, bool is64) {
  uint64_t v = 0ULL;
  if (reg == 31u) {
    v = sp_mode ? s->sp : 0ULL;
  } else {
    v = s->x[reg];
  }
  return is64 ? v : (v & 0xFFFFFFFFULL);
}

inline void write_gpr(HexArm64EmuState* s, uint32_t reg, uint64_t val, bool sp_mode, bool is64) {
  const uint64_t masked = is64 ? val : (val & 0xFFFFFFFFULL);
  if (reg == 31u) {
    if (sp_mode) s->sp = masked;
  } else {
    s->x[reg] = masked;
  }
}

inline uint64_t shift_reg(uint64_t v, uint32_t shift_type, uint32_t amount, bool is64) {
  const uint32_t bits = is64 ? 64u : 32u;
  if (!is64) v &= 0xFFFFFFFFULL;
  if (amount == 0u) return v;
  if (amount >= bits) {
    if (shift_type == 2u) {  // ASR
      const bool neg = is64 ? ((v >> 63) != 0ULL) : (((v >> 31) & 1ULL) != 0ULL);
      return neg ? (is64 ? ~0ULL : 0xFFFFFFFFULL) : 0ULL;
    }
    return 0ULL;
  }
  switch (shift_type) {
    case 0u:  // LSL
      return is64 ? (v << amount) : ((v << amount) & 0xFFFFFFFFULL);
    case 1u:  // LSR
      return v >> amount;
    case 2u:  // ASR
      if (is64) return static_cast<uint64_t>(static_cast<int64_t>(v) >> amount);
      return static_cast<uint64_t>(static_cast<uint32_t>(static_cast<int32_t>(v) >> amount));
    case 3u:  // ROR
      if (is64) return (v >> amount) | (v << (64u - amount));
      return ((v >> amount) | (v << (32u - amount))) & 0xFFFFFFFFULL;
    default:
      return v;
  }
}

inline uint32_t compute_add_flags(uint64_t a, uint64_t b, uint64_t res, bool is64) {
  uint32_t flags = 0u;
  if (is64) {
    if ((res >> 63) != 0ULL) flags |= HEX_ARM64_FLAG_N;
    if (res == 0ULL) flags |= HEX_ARM64_FLAG_Z;
    if (res < a) flags |= HEX_ARM64_FLAG_C;
    if (((~(a ^ b)) & (a ^ res) & (1ULL << 63)) != 0ULL) flags |= HEX_ARM64_FLAG_V;
  } else {
    const uint32_t a32 = static_cast<uint32_t>(a);
    const uint32_t b32 = static_cast<uint32_t>(b);
    const uint32_t r32 = static_cast<uint32_t>(res);
    if ((r32 >> 31) != 0u) flags |= HEX_ARM64_FLAG_N;
    if (r32 == 0u) flags |= HEX_ARM64_FLAG_Z;
    if (r32 < a32) flags |= HEX_ARM64_FLAG_C;
    if (((~(a32 ^ b32)) & (a32 ^ r32) & 0x80000000u) != 0u) flags |= HEX_ARM64_FLAG_V;
  }
  return flags;
}

inline uint32_t compute_sub_flags(uint64_t a, uint64_t b, uint64_t res, bool is64) {
  uint32_t flags = 0u;
  if (is64) {
    if ((res >> 63) != 0ULL) flags |= HEX_ARM64_FLAG_N;
    if (res == 0ULL) flags |= HEX_ARM64_FLAG_Z;
    if (a >= b) flags |= HEX_ARM64_FLAG_C;
    if (((a ^ b) & (a ^ res) & (1ULL << 63)) != 0ULL) flags |= HEX_ARM64_FLAG_V;
  } else {
    const uint32_t a32 = static_cast<uint32_t>(a);
    const uint32_t b32 = static_cast<uint32_t>(b);
    const uint32_t r32 = static_cast<uint32_t>(res);
    if ((r32 >> 31) != 0u) flags |= HEX_ARM64_FLAG_N;
    if (r32 == 0u) flags |= HEX_ARM64_FLAG_Z;
    if (a32 >= b32) flags |= HEX_ARM64_FLAG_C;
    if (((a32 ^ b32) & (a32 ^ r32) & 0x80000000u) != 0u) flags |= HEX_ARM64_FLAG_V;
  }
  return flags;
}

inline uint32_t compute_logic_flags(uint64_t res, bool is64) {
  uint32_t flags = 0u;
  if (is64) {
    if ((res >> 63) != 0ULL) flags |= HEX_ARM64_FLAG_N;
    if (res == 0ULL) flags |= HEX_ARM64_FLAG_Z;
  } else {
    const uint32_t r32 = static_cast<uint32_t>(res);
    if ((r32 >> 31) != 0u) flags |= HEX_ARM64_FLAG_N;
    if (r32 == 0u) flags |= HEX_ARM64_FLAG_Z;
  }
  return flags;
}

inline bool eval_cond(uint32_t nzcv, uint32_t cond) {
  const bool N = (nzcv & HEX_ARM64_FLAG_N) != 0u;
  const bool Z = (nzcv & HEX_ARM64_FLAG_Z) != 0u;
  const bool C = (nzcv & HEX_ARM64_FLAG_C) != 0u;
  const bool V = (nzcv & HEX_ARM64_FLAG_V) != 0u;
  bool res = false;
  switch (cond >> 1) {
    case 0u: res = Z; break;
    case 1u: res = C; break;
    case 2u: res = N; break;
    case 3u: res = V; break;
    case 4u: res = C && !Z; break;
    case 5u: res = (N == V); break;
    case 6u: res = !Z && (N == V); break;
    case 7u: res = true; break;
    default: res = false; break;
  }
  if ((cond & 1u) != 0u && (cond >> 1) != 7u) res = !res;
  return res;
}

// Decode ARM64 logical bitmask immediate (N, immr, imms).
bool decode_bitmask_imm(bool is64, uint32_t N, uint32_t immr, uint32_t imms, uint64_t& out) {
  if (!is64 && N != 0u) return false;
  uint32_t len = 0u;
  const uint32_t combined = (N << 6) | (~imms & 0x3Fu);
  for (int32_t bit = 6; bit >= 1; --bit) {
    if (((combined >> bit) & 1u) != 0u) {
      len = static_cast<uint32_t>(bit);
      break;
    }
  }
  if (len < 1u) return false;
  const uint32_t esize = 1u << len;
  const uint32_t levels = esize - 1u;
  const uint32_t S = imms & levels;
  const uint32_t R = immr & levels;
  if (S == levels) return false;

  const uint64_t welem = (1ULL << (S + 1u)) - 1ULL;
  uint64_t rotated = welem;
  if (R != 0u) {
    const uint64_t mask = (esize == 64u) ? ~0ULL : ((1ULL << esize) - 1ULL);
    rotated = ((welem >> R) | (welem << (esize - R))) & mask;
  }
  uint64_t replicated = 0ULL;
  for (uint32_t pos = 0u; pos < 64u; pos += esize) {
    replicated |= (rotated << pos);
  }
  out = is64 ? replicated : (replicated & 0xFFFFFFFFULL);
  return true;
}

bool mem_read(const HexArm64EmuState* s, const uint8_t* code_ptr, uint32_t code_len,
              uint64_t addr, uint32_t width, uint64_t& out_val) {
  if (width == 0u || width > 8u) return false;
  if (addr >= s->stack_base && addr < s->stack_top && (s->stack_top - addr) >= width) {
    const uint32_t off = static_cast<uint32_t>(addr - s->stack_base);
    out_val = read_le_bytes(s->stack + off, width);
    return true;
  }
  if (code_ptr != nullptr && addr >= s->code_va &&
      (addr - s->code_va) <= static_cast<uint64_t>(code_len) &&
      (static_cast<uint64_t>(code_len) - (addr - s->code_va)) >= width) {
    const uint32_t off = static_cast<uint32_t>(addr - s->code_va);
    out_val = read_le_bytes(code_ptr + off, width);
    return true;
  }
  return false;
}

bool mem_write(HexArm64EmuState* s, uint64_t addr, uint32_t width, uint64_t val) {
  if (width == 0u || width > 8u) return false;
  if (addr >= s->stack_base && addr < s->stack_top && (s->stack_top - addr) >= width) {
    const uint32_t off = static_cast<uint32_t>(addr - s->stack_base);
    write_le_bytes(s->stack + off, width, val);
    return true;
  }
  return false;
}

HexStatus set_fault(HexArm64EmuState* s, HexArm64EmuFault fault, HexStatus status) {
  s->fault_code = fault;
  s->halted = 1u;
  return status;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_arm64_emu_init")
HexStatus hex_arm64_emu_init(
    HexArm64EmuState* state, uint64_t entry_pc, uint64_t code_va,
    uint32_t code_len, uint32_t step_limit) {
  if (state == nullptr || code_len < 4u || step_limit == 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  for (uint32_t i = 0u; i < 31u; ++i) state->x[i] = 0ULL;
  state->x[30] = HEX_ARM64_EMU_SENTINEL_LR;
  state->stack_base = HEX_ARM64_EMU_STACK_BASE;
  state->stack_top = HEX_ARM64_EMU_STACK_TOP;
  state->sp = HEX_ARM64_EMU_STACK_TOP - 64ULL;
  state->pc = entry_pc;
  state->nzcv = 0u;
  state->step_count = 0u;
  state->step_limit = step_limit;
  state->fault_code = HEX_ARM64_FAULT_NONE;
  state->code_va = code_va;
  state->code_len = code_len;
  state->halted = 0u;
  for (uint32_t i = 0u; i < HEX_ARM64_EMU_STACK_SIZE; ++i) {
    state->stack[i] = 0u;
  }
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_arm64_emu_step")
HexStatus hex_arm64_emu_step(
    HexArm64EmuState* state, const uint8_t* code_ptr, uint32_t code_len) {
  if (state == nullptr || code_ptr == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (state->halted != 0u) {
    return (state->fault_code == HEX_ARM64_FAULT_HALTED_RET) ? HEX_OK : HEX_ERR_RESOURCE_LIMIT;
  }

  if (state->pc == HEX_ARM64_EMU_SENTINEL_LR) {
    return set_fault(state, HEX_ARM64_FAULT_HALTED_RET, HEX_OK);
  }

  if (state->step_count >= state->step_limit) {
    return set_fault(state, HEX_ARM64_FAULT_STEP_LIMIT, HEX_ERR_RESOURCE_LIMIT);
  }

  const uint32_t eff_len = (code_len < state->code_len) ? code_len : state->code_len;
  if ((state->pc & 3ULL) != 0ULL || state->pc < state->code_va ||
      (state->pc - state->code_va) + 4ULL > static_cast<uint64_t>(eff_len)) {
    return set_fault(state, HEX_ARM64_FAULT_PC_OOB, HEX_ERR_RESOURCE_LIMIT);
  }

  const uint32_t insn_off = static_cast<uint32_t>(state->pc - state->code_va);
  const uint32_t insn = read_u32_le(code_ptr + insn_off);
  const uint64_t cur_pc = state->pc;
  uint64_t next_pc = cur_pc + 4ULL;
  ++state->step_count;

  // 1. NOP / PAC / BTI hints (NOP, PACIAZ/SP, PACIBZ/SP, AUTIAZ/SP, AUTIBZ/SP, XPACLRI, BTI)
  if ((insn & 0xFFFFF01Fu) == 0xD503201Fu) {
    state->pc = next_pc;
    return HEX_OK;
  }

  // 2. Unconditional Branch Register: BR / BLR / RET
  if ((insn & 0xFFFFFC1Fu) == 0xD61F0000u) {
    const uint32_t rn = (insn >> 5) & 31u;
    state->pc = read_gpr(state, rn, false, true);
    return HEX_OK;
  }
  if ((insn & 0xFFFFFC1Fu) == 0xD63F0000u) {
    const uint32_t rn = (insn >> 5) & 31u;
    const uint64_t target = read_gpr(state, rn, false, true);
    state->x[30] = next_pc;
    state->pc = target;
    return HEX_OK;
  }
  if ((insn & 0xFFFFFC1Fu) == 0xD65F0000u || insn == 0xD65F0BFFu || insn == 0xD65F0FFFu) {
    const uint32_t rn = (insn == 0xD65F0BFFu || insn == 0xD65F0FFFu) ? 30u : ((insn >> 5) & 31u);
    const uint64_t target = read_gpr(state, rn, false, true);
    state->pc = target;
    if (target == HEX_ARM64_EMU_SENTINEL_LR) {
      return set_fault(state, HEX_ARM64_FAULT_HALTED_RET, HEX_OK);
    }
    return HEX_OK;
  }

  // 3. Unconditional Branch Immediate: B / BL
  if ((insn & 0x7C000000u) == 0x14000000u) {
    const bool is_bl = ((insn >> 31) & 1u) != 0u;
    const int64_t delta = sign_extend(insn & 0x03FFFFFFu, 26u) << 2;
    if (is_bl) state->x[30] = next_pc;
    state->pc = static_cast<uint64_t>(static_cast<int64_t>(cur_pc) + delta);
    return HEX_OK;
  }

  // 4. Conditional Branch: B.cond
  if ((insn & 0xFF000010u) == 0x54000000u) {
    const uint32_t cond = insn & 0xFu;
    if (eval_cond(state->nzcv, cond)) {
      const int64_t delta = sign_extend((insn >> 5) & 0x7FFFFu, 19u) << 2;
      next_pc = static_cast<uint64_t>(static_cast<int64_t>(cur_pc) + delta);
    }
    state->pc = next_pc;
    return HEX_OK;
  }

  // 5. Compare and Branch: CBZ / CBNZ
  if ((insn & 0x7E000000u) == 0x34000000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const bool is_nz = ((insn >> 24) & 1u) != 0u;
    const uint32_t rt = insn & 31u;
    const uint64_t val = read_gpr(state, rt, false, is64);
    const bool taken = is_nz ? (val != 0ULL) : (val == 0ULL);
    if (taken) {
      const int64_t delta = sign_extend((insn >> 5) & 0x7FFFFu, 19u) << 2;
      next_pc = static_cast<uint64_t>(static_cast<int64_t>(cur_pc) + delta);
    }
    state->pc = next_pc;
    return HEX_OK;
  }

  // 6. Test Bit and Branch: TBZ / TBNZ
  if ((insn & 0x7E000000u) == 0x36000000u) {
    const uint32_t b5 = (insn >> 31) & 1u;
    const uint32_t b40 = (insn >> 19) & 31u;
    const uint32_t bit_pos = (b5 << 5) | b40;
    const bool is_nz = ((insn >> 24) & 1u) != 0u;
    const uint32_t rt = insn & 31u;
    const uint64_t val = read_gpr(state, rt, false, true);
    const bool bit_set = ((val >> bit_pos) & 1ULL) != 0ULL;
    if (is_nz ? bit_set : !bit_set) {
      const int64_t delta = sign_extend((insn >> 5) & 0x3FFFu, 14u) << 2;
      next_pc = static_cast<uint64_t>(static_cast<int64_t>(cur_pc) + delta);
    }
    state->pc = next_pc;
    return HEX_OK;
  }

  // 7. PC-Relative Addressing: ADR / ADRP
  if ((insn & 0x1F000000u) == 0x10000000u) {
    const bool is_adrp = ((insn >> 31) & 1u) != 0u;
    const uint64_t immlo = (insn >> 29) & 3u;
    const uint64_t immhi = (insn >> 5) & 0x7FFFFu;
    const int64_t imm21 = sign_extend((immhi << 2) | immlo, 21u);
    const uint32_t rd = insn & 31u;
    uint64_t res = 0ULL;
    if (is_adrp) {
      res = (cur_pc & ~0xFFFULL) + static_cast<uint64_t>(imm21 << 12);
    } else {
      res = static_cast<uint64_t>(static_cast<int64_t>(cur_pc) + imm21);
    }
    write_gpr(state, rd, res, false, true);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 8. Move Wide Immediate: MOVN / MOVZ / MOVK
  if ((insn & 0x1F800000u) == 0x12800000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const uint32_t opc = (insn >> 29) & 3u;
    const uint32_t hw = (insn >> 21) & 3u;
    if (!is64 && hw >= 2u) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const uint64_t imm16 = (insn >> 5) & 0xFFFFu;
    const uint32_t shift = hw * 16u;
    const uint32_t rd = insn & 31u;
    uint64_t res = 0ULL;
    if (opc == 0u) {
      res = ~(imm16 << shift);
    } else if (opc == 2u) {
      res = imm16 << shift;
    } else if (opc == 3u) {
      const uint64_t cur = read_gpr(state, rd, false, is64);
      res = (cur & ~(0xFFFFULL << shift)) | (imm16 << shift);
    } else {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    write_gpr(state, rd, res, false, is64);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 9. Add/Sub Immediate: ADD / ADDS / SUB / SUBS
  if ((insn & 0x1F800000u) == 0x11000000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const bool is_sub = ((insn >> 30) & 1u) != 0u;
    const bool set_flags = ((insn >> 29) & 1u) != 0u;
    const uint32_t sh = (insn >> 22) & 1u;
    const uint64_t imm = static_cast<uint64_t>((insn >> 10) & 0xFFFu) << (sh ? 12u : 0u);
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rd = insn & 31u;
    const uint64_t a = read_gpr(state, rn, true, is64);
    const uint64_t res = is_sub ? (a - imm) : (a + imm);
    if (set_flags) {
      state->nzcv = is_sub ? compute_sub_flags(a, imm, res, is64)
                           : compute_add_flags(a, imm, res, is64);
    }
    write_gpr(state, rd, res, !set_flags, is64);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 10. Add/Sub Shifted Register: ADD / ADDS / SUB / SUBS
  if ((insn & 0x1F200000u) == 0x0B000000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const bool is_sub = ((insn >> 30) & 1u) != 0u;
    const bool set_flags = ((insn >> 29) & 1u) != 0u;
    const uint32_t shift_type = (insn >> 22) & 3u;
    const uint32_t imm6 = (insn >> 10) & 63u;
    if (shift_type == 3u || (!is64 && imm6 >= 32u)) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const uint32_t rm = (insn >> 16) & 31u;
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rd = insn & 31u;
    const uint64_t a = read_gpr(state, rn, false, is64);
    const uint64_t b = shift_reg(read_gpr(state, rm, false, is64), shift_type, imm6, is64);
    const uint64_t res = is_sub ? (a - b) : (a + b);
    if (set_flags) {
      state->nzcv = is_sub ? compute_sub_flags(a, b, res, is64)
                           : compute_add_flags(a, b, res, is64);
    }
    write_gpr(state, rd, res, false, is64);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 11. Logical Shifted Register: AND / ORR / EOR / ANDS / BIC / ORN / EON / BICS
  if ((insn & 0x1F000000u) == 0x0A000000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const uint32_t opc = (insn >> 29) & 3u;
    const uint32_t shift_type = (insn >> 22) & 3u;
    const bool invert = ((insn >> 21) & 1u) != 0u;
    const uint32_t imm6 = (insn >> 10) & 63u;
    if (!is64 && imm6 >= 32u) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const uint32_t rm = (insn >> 16) & 31u;
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rd = insn & 31u;
    const uint64_t a = read_gpr(state, rn, false, is64);
    uint64_t b = shift_reg(read_gpr(state, rm, false, is64), shift_type, imm6, is64);
    if (invert) b = ~b;
    uint64_t res = 0ULL;
    if (opc == 0u || opc == 3u) res = a & b;
    else if (opc == 1u) res = a | b;
    else res = a ^ b;
    if (opc == 3u) {
      state->nzcv = compute_logic_flags(res, is64);
    }
    write_gpr(state, rd, res, false, is64);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 12. Logical Immediate: AND / ORR / EOR / ANDS (TST)
  if ((insn & 0x1F800000u) == 0x12000000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const uint32_t opc = (insn >> 29) & 3u;
    const uint32_t N = (insn >> 22) & 1u;
    const uint32_t immr = (insn >> 16) & 63u;
    const uint32_t imms = (insn >> 10) & 63u;
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rd = insn & 31u;
    uint64_t imm = 0ULL;
    if (!decode_bitmask_imm(is64, N, immr, imms, imm)) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const uint64_t a = read_gpr(state, rn, false, is64);
    uint64_t res = 0ULL;
    if (opc == 0u || opc == 3u) res = a & imm;
    else if (opc == 1u) res = a | imm;
    else res = a ^ imm;
    if (opc == 3u) {
      state->nzcv = compute_logic_flags(res, is64);
    }
    write_gpr(state, rd, res, opc != 3u, is64);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 13. Data Processing 3-source: MADD / MSUB (MUL = MADD with Ra=31)
  if ((insn & 0x7FE00000u) == 0x1B000000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const bool is_sub = ((insn >> 15) & 1u) != 0u;
    const uint32_t rm = (insn >> 16) & 31u;
    const uint32_t ra = (insn >> 10) & 31u;
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rd = insn & 31u;
    const uint64_t a = read_gpr(state, rn, false, is64);
    const uint64_t b = read_gpr(state, rm, false, is64);
    const uint64_t acc = read_gpr(state, ra, false, is64);
    const uint64_t res = is_sub ? (acc - a * b) : (acc + a * b);
    write_gpr(state, rd, res, false, is64);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 14. Conditional Select: CSEL / CSINC / CSINV / CSNEG (bit 29 S must be 0)
  if ((insn & 0x3FE00800u) == 0x1A800000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const bool op = ((insn >> 30) & 1u) != 0u;
    const uint32_t rm = (insn >> 16) & 31u;
    const uint32_t cond = (insn >> 12) & 15u;
    const bool o2 = ((insn >> 10) & 1u) != 0u;
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rd = insn & 31u;
    uint64_t res = 0ULL;
    if (eval_cond(state->nzcv, cond)) {
      res = read_gpr(state, rn, false, is64);
    } else {
      res = read_gpr(state, rm, false, is64);
      if (op) res = ~res;
      if (o2) res += 1ULL;
    }
    write_gpr(state, rd, res, false, is64);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 15. Bitfield: SBFM / UBFM (strict N == sf and immr/imms < bits checks)
  if ((insn & 0x1F800000u) == 0x13000000u) {
    const bool is64 = ((insn >> 31) & 1u) != 0u;
    const uint32_t opc = (insn >> 29) & 3u;
    const uint32_t N = (insn >> 22) & 1u;
    const uint32_t immr = (insn >> 16) & 63u;
    const uint32_t imms = (insn >> 10) & 63u;
    const uint32_t bits = is64 ? 64u : 32u;
    if (N != (is64 ? 1u : 0u) || immr >= bits || imms >= bits) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rd = insn & 31u;
    const uint64_t src = read_gpr(state, rn, false, is64);
    uint64_t res = 0ULL;
    if (opc == 2u) {  // UBFM
      if (imms >= immr) {
        const uint32_t width = imms - immr + 1u;
        const uint64_t mask = (width == 64u) ? ~0ULL : ((1ULL << width) - 1ULL);
        res = (src >> immr) & mask;
      } else {
        const uint32_t lshift = bits - immr;
        const uint32_t width = imms + 1u;
        const uint64_t mask = (width == 64u) ? ~0ULL : ((1ULL << width) - 1ULL);
        res = (src & mask) << lshift;
      }
    } else if (opc == 0u) {  // SBFM
      if (imms >= immr) {
        const uint32_t width = imms - immr + 1u;
        const uint64_t mask = (width == 64u) ? ~0ULL : ((1ULL << width) - 1ULL);
        res = static_cast<uint64_t>(sign_extend((src >> immr) & mask, width));
      } else {
        const uint32_t lshift = bits - immr;
        const uint32_t width = imms + 1u;
        const uint64_t mask = (width == 64u) ? ~0ULL : ((1ULL << width) - 1ULL);
        res = static_cast<uint64_t>(sign_extend(src & mask, width)) << lshift;
      }
    } else {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    write_gpr(state, rd, res, false, is64);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 16. LDR Literal (GPR only: bit 26 V == 0 via 0x3F000000u mask)
  if ((insn & 0x3F000000u) == 0x18000000u) {
    const uint32_t opc = (insn >> 30) & 3u;
    const int64_t delta = sign_extend((insn >> 5) & 0x7FFFFu, 19u) << 2;
    const uint64_t addr = static_cast<uint64_t>(static_cast<int64_t>(cur_pc) + delta);
    const uint32_t rt = insn & 31u;
    uint64_t val = 0ULL;
    if (opc == 0u) {
      if (!mem_read(state, code_ptr, eff_len, addr, 4u, val)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, val, false, false);
    } else if (opc == 1u) {
      if (!mem_read(state, code_ptr, eff_len, addr, 8u, val)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, val, false, true);
    } else if (opc == 2u) {
      if (!mem_read(state, code_ptr, eff_len, addr, 4u, val)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, static_cast<uint64_t>(sign_extend(val, 32u)), false, true);
    } else {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    state->pc = next_pc;
    return HEX_OK;
  }

  // 17. Load/Store Pair: LDP / STP (GPR only: bit 26 V == 0 via 0x3E000000u mask)
  if ((insn & 0x3E000000u) == 0x28000000u) {
    const uint32_t opc = (insn >> 30) & 3u;
    const uint32_t mode = (insn >> 23) & 3u;
    const bool is_load = ((insn >> 22) & 1u) != 0u;
    if ((opc != 0u && opc != 2u) || mode == 0u) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const bool is64 = (opc == 2u);
    const uint32_t width = is64 ? 8u : 4u;
    const int64_t imm7 = sign_extend((insn >> 15) & 0x7Fu, 7u) * static_cast<int64_t>(width);
    const uint32_t rt2 = (insn >> 10) & 31u;
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rt = insn & 31u;
    const uint64_t base = read_gpr(state, rn, true, true);
    const uint64_t addr =
        (mode == 1u) ? base : static_cast<uint64_t>(static_cast<int64_t>(base) + imm7);

    if (is_load) {
      uint64_t v1 = 0ULL;
      uint64_t v2 = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v1) ||
          !mem_read(state, code_ptr, eff_len, addr + width, width, v2)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, v1, false, is64);
      write_gpr(state, rt2, v2, false, is64);
    } else {
      const uint64_t v1 = read_gpr(state, rt, false, is64);
      const uint64_t v2 = read_gpr(state, rt2, false, is64);
      if (!mem_write(state, addr, width, v1) || !mem_write(state, addr + width, width, v2)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
    }
    if (mode == 1u || mode == 3u) {
      write_gpr(state, rn, static_cast<uint64_t>(static_cast<int64_t>(base) + imm7), true, true);
    }
    state->pc = next_pc;
    return HEX_OK;
  }

  // 18. Load/Store Register (Unsigned Offset; GPR only: bit 26 V == 0 via 0x3F000000u)
  if ((insn & 0x3F000000u) == 0x39000000u) {
    const uint32_t size = (insn >> 30) & 3u;
    const uint32_t opc = (insn >> 22) & 3u;
    // Reject PRFM (size==3 && opc==2)
    if (size == 3u && opc == 2u) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const uint32_t width = 1u << size;
    const uint64_t imm = static_cast<uint64_t>((insn >> 10) & 0xFFFu) << size;
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rt = insn & 31u;
    const uint64_t addr = read_gpr(state, rn, true, true) + imm;

    if (opc == 0u) {
      const uint64_t v = read_gpr(state, rt, false, size == 3u);
      if (!mem_write(state, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
    } else if (opc == 1u) {
      uint64_t v = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, v, false, size == 3u);
    } else if (opc == 2u) {
      uint64_t v = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, static_cast<uint64_t>(sign_extend(v, width * 8u)), false, true);
    } else {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    state->pc = next_pc;
    return HEX_OK;
  }

  // 19. Load/Store Register (Pre/Post-index; GPR only: bit 26 V == 0 via 0x3F200400u)
  if ((insn & 0x3F200400u) == 0x38000400u) {
    const uint32_t size = (insn >> 30) & 3u;
    const uint32_t opc = (insn >> 22) & 3u;
    const uint32_t mode = (insn >> 10) & 3u;
    const uint32_t width = 1u << size;
    const int64_t imm9 = sign_extend((insn >> 12) & 0x1FFu, 9u);
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rt = insn & 31u;
    const uint64_t base = read_gpr(state, rn, true, true);
    const uint64_t addr =
        (mode == 1u) ? base : static_cast<uint64_t>(static_cast<int64_t>(base) + imm9);

    if (opc == 0u) {
      const uint64_t v = read_gpr(state, rt, false, size == 3u);
      if (!mem_write(state, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
    } else if (opc == 1u) {
      uint64_t v = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, v, false, size == 3u);
    } else {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    write_gpr(state, rn, static_cast<uint64_t>(static_cast<int64_t>(base) + imm9), true, true);
    state->pc = next_pc;
    return HEX_OK;
  }

  // 20. Load/Store Register (Register Offset; GPR only: bit 26 V == 0 via 0x3F200C00u)
  if ((insn & 0x3F200C00u) == 0x38200800u) {
    const uint32_t size = (insn >> 30) & 3u;
    const uint32_t opc = (insn >> 22) & 3u;
    const uint32_t opt = (insn >> 13) & 7u;
    // Reject PRFM (size==3 && opc==2) and invalid extend option (must be 2, 3, 6, or 7)
    if ((size == 3u && opc == 2u) ||
        (opt != 2u && opt != 3u && opt != 6u && opt != 7u)) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const uint32_t rm = (insn >> 16) & 31u;
    const uint32_t S = (insn >> 12) & 1u;
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rt = insn & 31u;
    const uint32_t width = 1u << size;
    const uint32_t shift = S ? size : 0u;
    uint64_t idx_val = read_gpr(state, rm, false, true);
    if (opt == 2u) idx_val = idx_val & 0xFFFFFFFFULL;
    else if (opt == 6u) idx_val = static_cast<uint64_t>(sign_extend(idx_val, 32u));
    const uint64_t addr = read_gpr(state, rn, true, true) + (idx_val << shift);

    if (opc == 0u) {
      const uint64_t v = read_gpr(state, rt, false, size == 3u);
      if (!mem_write(state, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
    } else if (opc == 1u) {
      uint64_t v = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, v, false, size == 3u);
    } else if (opc == 2u) {
      uint64_t v = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, static_cast<uint64_t>(sign_extend(v, width * 8u)), false, true);
    } else {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    state->pc = next_pc;
    return HEX_OK;
  }

  // 21. Load/Store Register (Unscaled Signed 9-bit Immediate: LDUR / STUR; GPR only)
  if ((insn & 0x3F200C00u) == 0x38000000u) {
    const uint32_t size = (insn >> 30) & 3u;
    const uint32_t opc = (insn >> 22) & 3u;
    // Reject PRFUM (size==3 && opc==2) and unallocated (opc==3 && size>=2)
    if ((size == 3u && opc == 2u) || (opc == 3u && size >= 2u)) {
      return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
    }
    const uint32_t width = 1u << size;
    const int64_t imm9 = sign_extend((insn >> 12) & 0x1FFu, 9u);
    const uint32_t rn = (insn >> 5) & 31u;
    const uint32_t rt = insn & 31u;
    const uint64_t addr = read_gpr(state, rn, true, true) + static_cast<uint64_t>(imm9);

    if (opc == 0u) {
      const uint64_t v = read_gpr(state, rt, false, size == 3u);
      if (!mem_write(state, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
    } else if (opc == 1u) {
      uint64_t v = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, v, false, size == 3u);
    } else if (opc == 2u) {
      uint64_t v = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, static_cast<uint64_t>(sign_extend(v, width * 8u)), false, true);
    } else {
      // opc == 3u && size < 2u: 32-bit sign-extending LDURSB/LDURSH Wt
      uint64_t v = 0ULL;
      if (!mem_read(state, code_ptr, eff_len, addr, width, v)) {
        return set_fault(state, HEX_ARM64_FAULT_MEM_OOB, HEX_ERR_RESOURCE_LIMIT);
      }
      write_gpr(state, rt, static_cast<uint64_t>(sign_extend(v, width * 8u)), false, false);
    }
    state->pc = next_pc;
    return HEX_OK;
  }

  return set_fault(state, HEX_ARM64_FAULT_UNSUPPORTED_INSN, HEX_ERR_UNSUPPORTED);
}

HEX_WASM_EXPORT("hex_arm64_emu_run")
HexStatus hex_arm64_emu_run(
    HexArm64EmuState* state, const uint8_t* code_ptr, uint32_t code_len) {
  if (state == nullptr || code_ptr == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  while (state->halted == 0u) {
    const HexStatus st = hex_arm64_emu_step(state, code_ptr, code_len);
    if (st != HEX_OK) {
      return st;
    }
  }
  return (state->fault_code == HEX_ARM64_FAULT_HALTED_RET) ? HEX_OK : HEX_ERR_RESOURCE_LIMIT;
}

}  // extern "C"
