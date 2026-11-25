#include "x86_64_decomp.hpp"
#include "../cfg/loop_engine.hpp"

namespace {

constexpr uint32_t kX86WorkArenaBytes = 256u * 1024u;
constexpr uint32_t kX86EmitArenaBytes = 512u * 1024u;
constexpr uint32_t kMaxX86Bytes = 4096u;
constexpr uint32_t kMaxX86Insns = 128u;
constexpr uint32_t kMaxX86Blocks = 64u;
constexpr uint32_t kMaxStackSlots = 32u;
constexpr uint32_t kMaxEmitBytes = 256u * 1024u;
constexpr uint8_t kRegNone = 0xffu;

alignas(16) uint8_t g_x86_work_storage[kX86WorkArenaBytes];
alignas(16) uint8_t g_x86_emit_storage[kX86EmitArenaBytes];

hex::Arena g_x86_work_arena;
hex::Arena g_x86_emit_arena;
bool g_x86_arenas_init = false;

const char* g_x86_last_text = nullptr;
uint32_t g_x86_last_text_len = 0u;
const HexLineMapEntry* g_x86_last_linemap = nullptr;
uint32_t g_x86_last_linemap_count = 0u;

void clear_x86_last_output() {
  g_x86_last_text = nullptr;
  g_x86_last_text_len = 0u;
  g_x86_last_linemap = nullptr;
  g_x86_last_linemap_count = 0u;
}

void ensure_x86_arenas() {
  if (!g_x86_arenas_init) {
    g_x86_work_arena.init_fixed(g_x86_work_storage, sizeof(g_x86_work_storage));
    g_x86_emit_arena.init_fixed(g_x86_emit_storage, sizeof(g_x86_emit_storage));
    g_x86_arenas_init = true;
  }
}

// x86_64 GPR indices:
// 0=rax, 1=rcx, 2=rdx, 3=rbx, 4=rsp, 5=rbp, 6=rsi, 7=rdi, 8..15=r8..r15
int32_t abi_param_index(uint32_t abi_id, uint8_t reg) {
  if (abi_id == HEX_X86_ABI_SYSV_AMD64) {
    // rdi, rsi, rdx, rcx, r8, r9
    switch (reg) {
      case 7u: return 0;
      case 6u: return 1;
      case 2u: return 2;
      case 1u: return 3;
      case 8u: return 4;
      case 9u: return 5;
      default: return -1;
    }
  }
  if (abi_id == HEX_X86_ABI_MICROSOFT_X64) {
    // rcx, rdx, r8, r9
    switch (reg) {
      case 1u: return 0;
      case 2u: return 1;
      case 8u: return 2;
      case 9u: return 3;
      default: return -1;
    }
  }
  return -1;
}

bool map_alu_group_to_binop(uint8_t grp, uint8_t& out_subop) {
  switch (grp) {
    case 0u: out_subop = CEMIT_BIN_ADD; return true;
    case 1u: out_subop = CEMIT_BIN_OR; return true;
    case 4u: out_subop = CEMIT_BIN_AND; return true;
    case 5u: out_subop = CEMIT_BIN_SUB; return true;
    case 6u: out_subop = CEMIT_BIN_XOR; return true;
    default: return false;
  }
}

bool map_x86_cc_to_cemit_cmp(uint8_t cc, uint8_t& out_cmp) {
  switch (cc & 0x0fu) {
    case 0x2u: out_cmp = CEMIT_CMP_ULT; return true;  // jb
    case 0x3u: out_cmp = CEMIT_CMP_UGE; return true;  // jae
    case 0x4u: out_cmp = CEMIT_CMP_EQ; return true;   // je
    case 0x5u: out_cmp = CEMIT_CMP_NE; return true;   // jne
    case 0x6u: out_cmp = CEMIT_CMP_ULE; return true;  // jbe
    case 0x7u: out_cmp = CEMIT_CMP_UGT; return true;  // ja
    case 0xcu: out_cmp = CEMIT_CMP_SLT; return true;  // jl
    case 0xdu: out_cmp = CEMIT_CMP_SGE; return true;  // jge
    case 0xeu: out_cmp = CEMIT_CMP_SLE; return true;  // jle
    case 0xfu: out_cmp = CEMIT_CMP_SGT; return true;  // jg
    default: return false;
  }
}

// Frame prologue/epilogue recognizers.
bool is_frame_prologue_or_epilogue(const HexX86Decoded& d, int64_t& rbp_delta_from_rsp) {
  // push rbp (0x55) / pop rbp (0x5d)
  if (d.kind == HEX_X86_KIND_PUSH && d.opcode == 0x55u && d.rm == 5u) return true;
  if (d.kind == HEX_X86_KIND_POP && d.opcode == 0x5du && d.rm == 5u) return true;
  // leave (0xc9, tagged as NOP in decode loop)
  if (d.opcode == 0xc9u && d.kind == HEX_X86_KIND_NOP) return true;
  const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6) & 3u);
  // mov rbp, rsp
  if (d.kind == HEX_X86_KIND_MOV && (d.opcode == 0x89u || d.opcode == 0x8bu) &&
      (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
    const uint8_t dst = (d.opcode == 0x89u) ? d.rm : d.reg;
    const uint8_t src = (d.opcode == 0x89u) ? d.reg : d.rm;
    if (dst == 5u && src == 4u) {
      rbp_delta_from_rsp = 0;
      return true;
    }
  }
  // lea rbp, [rsp + disp]
  if (d.kind == HEX_X86_KIND_LEA && (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u &&
      mod != 3u && (d.flags & HEX_X86_FLAG_RIP_REL) == 0u &&
      d.reg == 5u && d.rm == 4u && d.index_reg == kRegNone) {
    rbp_delta_from_rsp = (d.flags & HEX_X86_FLAG_HAS_DISP) != 0u ? d.disp : 0;
    return true;
  }
  // sub rsp, imm / add rsp, imm
  if (d.kind == HEX_X86_KIND_ALU && (d.opcode == 0x81u || d.opcode == 0x83u) &&
      (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u && d.rm == 4u) {
    const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3) & 7u);
    if (grp == 0u || grp == 5u) return true;
  }
  return false;
}

bool is_stack_mem_operand(const HexX86Decoded& d, int64_t rbp_delta, int64_t& out_slot_key) {
  if ((d.flags & HEX_X86_FLAG_HAS_MODRM) == 0u) return false;
  const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6) & 3u);
  if (mod == 3u) return false;
  if ((d.flags & HEX_X86_FLAG_RIP_REL) != 0u) return false;
  if (d.index_reg != kRegNone) return false;
  const int64_t disp = (d.flags & HEX_X86_FLAG_HAS_DISP) != 0u ? d.disp : 0;
  if (d.rm == 5u) {
    out_slot_key = disp;
    return true;
  }
  if (d.rm == 4u) {
    out_slot_key = disp - rbp_delta;
    return true;
  }
  return false;
}

struct LiftBuilder {
  hex::Vec<CEmitInst> insts;
  uint32_t reg_val[16];
  uint32_t reg_fixed_var[16];
  uint32_t param_val[6];

  int64_t slot_keys[kMaxStackSlots];
  uint32_t slot_val[kMaxStackSlots];
  uint32_t slot_fixed_var[kMaxStackSlots];
  uint32_t num_slots;

  uint32_t next_ssa;
  uint32_t num_params;
  uint32_t abi_id;
  uint64_t base_addr;
  int64_t rbp_delta;
  bool multi_block;
  bool wrote_rax;
  uint8_t ret_width;
  bool oom;

  // Last CMP state in current basic block for Jcc
  bool has_cmp;
  uint32_t cmp_lhs;
  uint32_t cmp_rhs;
  uint16_t cmp_width;

  explicit LiftBuilder(hex::Arena* arena, uint32_t abi, uint64_t base, bool is_multi)
      : insts(arena),
        num_slots(0u),
        next_ssa(0u),
        num_params(0u),
        abi_id(abi),
        base_addr(base),
        rbp_delta(0),
        multi_block(is_multi),
        wrote_rax(false),
        ret_width(0u),
        oom(false),
        has_cmp(false),
        cmp_lhs(CEMIT_IR_NO_VAL),
        cmp_rhs(CEMIT_IR_NO_VAL),
        cmp_width(32u) {
    for (uint32_t i = 0u; i < 16u; ++i) {
      reg_val[i] = CEMIT_IR_NO_VAL;
      reg_fixed_var[i] = CEMIT_IR_NO_VAL;
    }
    for (uint32_t i = 0u; i < 6u; ++i) param_val[i] = CEMIT_IR_NO_VAL;
    for (uint32_t i = 0u; i < kMaxStackSlots; ++i) {
      slot_keys[i] = 0;
      slot_val[i] = CEMIT_IR_NO_VAL;
      slot_fixed_var[i] = CEMIT_IR_NO_VAL;
    }
  }

  uint32_t emit_inst_dst(uint8_t op, uint8_t flags, uint16_t width,
                         uint32_t dst_id, uint32_t src0, uint32_t src1,
                         uint64_t imm, uint64_t addr) {
    CEmitInst ci{};
    ci.op = op;
    ci.flags = flags;
    ci.width = width;
    ci.dst = dst_id;
    ci.src0 = src0;
    ci.src1 = src1;
    ci.src2 = CEMIT_IR_NO_VAL;
    ci.imm = imm;
    ci.addr = addr;
    if (!insts.push_back(ci)) {
      oom = true;
      return CEMIT_IR_NO_VAL;
    }
    return ci.dst;
  }

  uint32_t emit_inst(uint8_t op, uint8_t flags, uint16_t width,
                     uint32_t src0, uint32_t src1, uint64_t imm, uint64_t addr,
                     bool has_dst) {
    const uint32_t dst_id = has_dst ? next_ssa++ : CEMIT_IR_NO_VAL;
    return emit_inst_dst(op, flags, width, dst_id, src0, src1, imm, addr);
  }

  uint32_t emit_const(uint16_t width, uint64_t val, uint64_t addr) {
    return emit_inst(CEMIT_IR_CONST, 0u, width, CEMIT_IR_NO_VAL, CEMIT_IR_NO_VAL, val, addr, true);
  }

  int32_t find_or_add_slot(int64_t key) {
    for (uint32_t i = 0u; i < num_slots; ++i) {
      if (slot_keys[i] == key) return static_cast<int32_t>(i);
    }
    if (num_slots >= kMaxStackSlots) return -1;
    const uint32_t idx = num_slots++;
    slot_keys[idx] = key;
    slot_val[idx] = CEMIT_IR_NO_VAL;
    slot_fixed_var[idx] = multi_block ? next_ssa++ : CEMIT_IR_NO_VAL;
    return static_cast<int32_t>(idx);
  }

  uint32_t read_slot(int64_t key) {
    const int32_t idx = find_or_add_slot(key);
    if (idx < 0) return CEMIT_IR_NO_VAL;
    if (multi_block) {
      return slot_val[idx] != CEMIT_IR_NO_VAL ? slot_val[idx] : CEMIT_IR_NO_VAL;
    }
    return slot_val[idx];
  }

  bool write_slot(int64_t key, uint32_t val, uint16_t width, uint64_t addr) {
    const int32_t idx = find_or_add_slot(key);
    if (idx < 0) return false;
    if (multi_block) {
      const uint32_t fv = slot_fixed_var[idx];
      emit_inst_dst(CEMIT_IR_COPY, 0u, width, fv, val, CEMIT_IR_NO_VAL, 0u, addr);
      if (oom) return false;
      slot_val[idx] = fv;
      return true;
    }
    slot_val[idx] = val;
    return true;
  }

  uint32_t read_reg(uint8_t reg) {
    if (reg >= 16u) return CEMIT_IR_NO_VAL;
    if (reg_val[reg] != CEMIT_IR_NO_VAL) return reg_val[reg];
    const int32_t pidx = abi_param_index(abi_id, reg);
    if (pidx < 0 || pidx >= 6) return CEMIT_IR_NO_VAL;
    if (param_val[pidx] == CEMIT_IR_NO_VAL) {
      const uint32_t pv = emit_inst(
          CEMIT_IR_PARAM, 0u, 64u, CEMIT_IR_NO_VAL, CEMIT_IR_NO_VAL,
          static_cast<uint64_t>(pidx), base_addr, true);
      if (oom) return CEMIT_IR_NO_VAL;
      param_val[pidx] = pv;
      const uint32_t needed = static_cast<uint32_t>(pidx) + 1u;
      if (needed > num_params) num_params = needed;
    }
    reg_val[reg] = param_val[pidx];
    return reg_val[reg];
  }

  uint32_t alloc_dst_for_reg(uint8_t reg) {
    if (multi_block && reg < 16u && reg_fixed_var[reg] != CEMIT_IR_NO_VAL) {
      return reg_fixed_var[reg];
    }
    return next_ssa++;
  }

  void write_reg(uint8_t reg, uint32_t ssa_id, uint8_t width) {
    if (reg >= 16u) return;
    reg_val[reg] = ssa_id;
    if (reg == 0u) {
      wrote_rax = true;
      ret_width = width;
    }
  }

  // Compute general memory effective address `[base + index*scale + disp]` (non-stack, non-RIP).
  uint32_t emit_mem_addr(const HexX86Decoded& d) {
    if ((d.flags & HEX_X86_FLAG_RIP_REL) != 0u) return CEMIT_IR_NO_VAL;
    uint32_t acc = CEMIT_IR_NO_VAL;
    if (d.rm != kRegNone) {
      const uint32_t bv = read_reg(d.rm);
      if (bv == CEMIT_IR_NO_VAL) return CEMIT_IR_NO_VAL;
      acc = bv;
    }
    if (d.index_reg != kRegNone) {
      const uint32_t iv = read_reg(d.index_reg);
      if (iv == CEMIT_IR_NO_VAL) return CEMIT_IR_NO_VAL;
      uint32_t scaled = iv;
      if (d.scale > 1u) {
        const uint32_t sc = emit_const(64u, static_cast<uint64_t>(d.scale), d.pc);
        if (oom) return CEMIT_IR_NO_VAL;
        scaled = emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_MUL, 64u, iv, sc, 0u, d.pc, true);
        if (oom) return CEMIT_IR_NO_VAL;
      }
      if (acc == CEMIT_IR_NO_VAL) {
        acc = scaled;
      } else {
        acc = emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_ADD, 64u, acc, scaled, 0u, d.pc, true);
        if (oom) return CEMIT_IR_NO_VAL;
      }
    }
    if ((d.flags & HEX_X86_FLAG_HAS_DISP) != 0u && d.disp != 0) {
      if (acc == CEMIT_IR_NO_VAL) {
        acc = emit_const(64u, static_cast<uint64_t>(d.disp), d.pc);
      } else if (d.disp > 0) {
        const uint32_t dv = emit_const(64u, static_cast<uint64_t>(d.disp), d.pc);
        if (oom) return CEMIT_IR_NO_VAL;
        acc = emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_ADD, 64u, acc, dv, 0u, d.pc, true);
      } else {
        const uint64_t mag = 0ULL - static_cast<uint64_t>(d.disp);
        const uint32_t dv = emit_const(64u, mag, d.pc);
        if (oom) return CEMIT_IR_NO_VAL;
        acc = emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_SUB, 64u, acc, dv, 0u, d.pc, true);
      }
      if (oom) return CEMIT_IR_NO_VAL;
    }
    return acc;
  }

  // Read either a stack slot or a general memory operand into an SSA value.
  uint32_t read_mem_operand(const HexX86Decoded& d, uint16_t width) {
    int64_t slot_key = 0;
    if (is_stack_mem_operand(d, rbp_delta, slot_key)) {
      return read_slot(slot_key);
    }
    const uint32_t addr_v = emit_mem_addr(d);
    if (addr_v == CEMIT_IR_NO_VAL) return CEMIT_IR_NO_VAL;
    return emit_inst(CEMIT_IR_LOAD, 0u, width, addr_v, CEMIT_IR_NO_VAL, 0u, d.pc, true);
  }

  // Write an SSA value to either a stack slot or a general memory operand.
  bool write_mem_operand(const HexX86Decoded& d, uint32_t val, uint16_t width) {
    int64_t slot_key = 0;
    if (is_stack_mem_operand(d, rbp_delta, slot_key)) {
      return write_slot(slot_key, val, width, d.pc);
    }
    const uint32_t addr_v = emit_mem_addr(d);
    if (addr_v == CEMIT_IR_NO_VAL) return false;
    emit_inst(CEMIT_IR_STORE, 0u, width, addr_v, val, 0u, d.pc, false);
    return !oom;
  }
};

bool lift_one_x86_insn(LiftBuilder& b, const HexX86Decoded& d) {
  if (d.kind == HEX_X86_KIND_NOP) return true;
  if (is_frame_prologue_or_epilogue(d, b.rbp_delta)) {
    if (d.kind == HEX_X86_KIND_ALU) b.has_cmp = false;
    return true;
  }

  if (d.op_size != 8u && d.op_size != 16u && d.op_size != 32u && d.op_size != 64u) {
    return false;
  }
  const uint16_t w = d.op_size;
  const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6) & 3u);

  if (d.kind == HEX_X86_KIND_MOV) {
    // mov r, imm32/64 (B8..BF)
    if (d.opcode >= 0xb8u && d.opcode <= 0xbfu) {
      if (w != 32u && w != 64u) return false;
      if (d.rm >= 16u) return false;
      uint64_t val = static_cast<uint64_t>(d.imm);
      if (w == 32u) val &= 0xffffffffULL;
      const uint32_t cv = b.emit_inst_dst(
          CEMIT_IR_CONST, 0u, w, b.alloc_dst_for_reg(d.rm),
          CEMIT_IR_NO_VAL, CEMIT_IR_NO_VAL, val, d.pc);
      if (b.oom) return false;
      b.write_reg(d.rm, cv, d.op_size);
      return true;
    }
    // mov r/m, imm32 (C7 /0) or mov r/m8, imm8 (C6 /0)
    if ((d.opcode == 0xc6u || d.opcode == 0xc7u) && (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
      uint64_t val = static_cast<uint64_t>(d.imm);
      if (w == 8u) val &= 0xffULL;
      else if (w == 16u) val &= 0xffffULL;
      else if (w == 32u) val &= 0xffffffffULL;
      if (mod == 3u) {
        if (d.rm >= 16u) return false;
        const uint32_t cv = b.emit_inst_dst(
            CEMIT_IR_CONST, 0u, w, b.alloc_dst_for_reg(d.rm),
            CEMIT_IR_NO_VAL, CEMIT_IR_NO_VAL, val, d.pc);
        if (b.oom) return false;
        b.write_reg(d.rm, cv, d.op_size);
        return true;
      }
      const uint32_t cv = b.emit_const(w, val, d.pc);
      if (b.oom) return false;
      return b.write_mem_operand(d, cv, w);
    }
    // mov r/m, r (88/89) or mov r, r/m (8A/8B)
    if ((d.opcode >= 0x88u && d.opcode <= 0x8bu) && (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
      const bool dst_is_rm = (d.opcode == 0x88u || d.opcode == 0x89u);
      if (mod == 3u) {
        const uint8_t dst = dst_is_rm ? d.rm : d.reg;
        const uint8_t src = dst_is_rm ? d.reg : d.rm;
        const uint32_t sv = b.read_reg(src);
        if (sv == CEMIT_IR_NO_VAL) return false;
        const uint32_t mv = b.emit_inst_dst(
            CEMIT_IR_COPY, 0u, w, b.alloc_dst_for_reg(dst),
            sv, CEMIT_IR_NO_VAL, 0u, d.pc);
        if (b.oom) return false;
        b.write_reg(dst, mv, d.op_size);
        return true;
      }
      if (dst_is_rm) {
        const uint32_t sv = b.read_reg(d.reg);
        if (sv == CEMIT_IR_NO_VAL) return false;
        return b.write_mem_operand(d, sv, w);
      } else {
        const uint32_t lv = b.read_mem_operand(d, w);
        if (lv == CEMIT_IR_NO_VAL) return false;
        if (b.multi_block && d.reg < 16u && b.reg_fixed_var[d.reg] != CEMIT_IR_NO_VAL) {
          const uint32_t mv = b.emit_inst_dst(
              CEMIT_IR_COPY, 0u, w, b.reg_fixed_var[d.reg], lv, CEMIT_IR_NO_VAL, 0u, d.pc);
          if (b.oom) return false;
          b.write_reg(d.reg, mv, d.op_size);
        } else {
          b.write_reg(d.reg, lv, d.op_size);
        }
        return true;
      }
    }
    return false;
  }

  if (d.kind == HEX_X86_KIND_MOVZX) {
    if ((d.flags & HEX_X86_FLAG_HAS_MODRM) == 0u) return false;
    const uint16_t src_w = (d.opcode2 == 0xb6u) ? 8u : 16u;
    uint32_t sv = CEMIT_IR_NO_VAL;
    if (mod == 3u) {
      sv = b.read_reg(d.rm);
    } else {
      sv = b.read_mem_operand(d, src_w);
    }
    if (sv == CEMIT_IR_NO_VAL) return false;
    const uint32_t zv = b.emit_inst_dst(
        CEMIT_IR_UNOP, CEMIT_UN_ZEXT, w, b.alloc_dst_for_reg(d.reg),
        sv, CEMIT_IR_NO_VAL, 0u, d.pc);
    if (b.oom) return false;
    b.write_reg(d.reg, zv, d.op_size);
    return true;
  }

  if (d.kind == HEX_X86_KIND_CMP) {
    // cmp r/m, imm (80/81/83 /7)
    if ((d.opcode == 0x80u || d.opcode == 0x81u || d.opcode == 0x83u) &&
        (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
      uint32_t lv = (mod == 3u) ? b.read_reg(d.rm) : b.read_mem_operand(d, w);
      if (lv == CEMIT_IR_NO_VAL) return false;
      uint64_t imm_val = static_cast<uint64_t>(d.imm);
      if (w == 8u) imm_val &= 0xffULL;
      else if (w == 16u) imm_val &= 0xffffULL;
      else if (w == 32u) imm_val &= 0xffffffffULL;
      const uint32_t rv = b.emit_const(w, imm_val, d.pc);
      if (b.oom) return false;
      b.has_cmp = true;
      b.cmp_lhs = lv;
      b.cmp_rhs = rv;
      b.cmp_width = w;
      return true;
    }
    // cmp r/m, r (38/39) or cmp r, r/m (3A/3B)
    if (d.opcode >= 0x38u && d.opcode <= 0x3bu && (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
      const bool lhs_is_rm = (d.opcode == 0x38u || d.opcode == 0x39u);
      uint32_t lv = CEMIT_IR_NO_VAL;
      uint32_t rv = CEMIT_IR_NO_VAL;
      if (mod == 3u) {
        lv = b.read_reg(lhs_is_rm ? d.rm : d.reg);
        rv = b.read_reg(lhs_is_rm ? d.reg : d.rm);
      } else if (lhs_is_rm) {
        lv = b.read_mem_operand(d, w);
        rv = b.read_reg(d.reg);
      } else {
        lv = b.read_reg(d.reg);
        rv = b.read_mem_operand(d, w);
      }
      if (lv == CEMIT_IR_NO_VAL || rv == CEMIT_IR_NO_VAL) return false;
      b.has_cmp = true;
      b.cmp_lhs = lv;
      b.cmp_rhs = rv;
      b.cmp_width = w;
      return true;
    }
    // cmp al/rax, imm (3C/3D)
    if ((d.opcode == 0x3cu || d.opcode == 0x3du) && (d.flags & HEX_X86_FLAG_HAS_IMM) != 0u) {
      const uint32_t lv = b.read_reg(0u);
      if (lv == CEMIT_IR_NO_VAL) return false;
      uint64_t imm_val = static_cast<uint64_t>(d.imm);
      if (w == 8u) imm_val &= 0xffULL;
      else if (w == 32u) imm_val &= 0xffffffffULL;
      const uint32_t rv = b.emit_const(w, imm_val, d.pc);
      if (b.oom) return false;
      b.has_cmp = true;
      b.cmp_lhs = lv;
      b.cmp_rhs = rv;
      b.cmp_width = w;
      return true;
    }
    // test r, r (84/85 mod == 3, same reg -> cmp r, 0)
    if ((d.opcode == 0x84u || d.opcode == 0x85u) &&
        (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u && d.reg == d.rm) {
      const uint32_t lv = b.read_reg(d.reg);
      if (lv == CEMIT_IR_NO_VAL) return false;
      const uint32_t rv = b.emit_const(w, 0u, d.pc);
      if (b.oom) return false;
      b.has_cmp = true;
      b.cmp_lhs = lv;
      b.cmp_rhs = rv;
      b.cmp_width = w;
      return true;
    }
    return false;
  }

  if (d.kind == HEX_X86_KIND_ALU) {
    // Flag-clobbering ALU instructions (add/sub/xor/and/or) invalidate any prior cmp state.
    b.has_cmp = false;
    if (w != 32u && w != 64u) return false;

    // Standard ALU: 01/03 (add), 09/0B (or), 21/23 (and), 29/2B (sub), 31/33 (xor)
    if (d.opcode < 0x40u) {
      const uint8_t grp = static_cast<uint8_t>((d.opcode >> 3) & 7u);
      const uint8_t sub = static_cast<uint8_t>(d.opcode & 7u);
      uint8_t binop = 0u;
      if (!map_alu_group_to_binop(grp, binop)) return false;

      if (sub == 1u || sub == 3u) {
        if ((d.flags & HEX_X86_FLAG_HAS_MODRM) == 0u) return false;
        if (mod == 3u) {
          const uint8_t dst = (sub == 1u) ? d.rm : d.reg;
          const uint8_t rhs_reg = (sub == 1u) ? d.reg : d.rm;
          if (binop == CEMIT_BIN_XOR && dst == rhs_reg) {
            const uint32_t zv = b.emit_inst_dst(
                CEMIT_IR_CONST, 0u, w, b.alloc_dst_for_reg(dst),
                CEMIT_IR_NO_VAL, CEMIT_IR_NO_VAL, 0u, d.pc);
            if (b.oom) return false;
            b.write_reg(dst, zv, d.op_size);
            return true;
          }
          const uint32_t lv = b.read_reg(dst);
          const uint32_t rv = b.read_reg(rhs_reg);
          if (lv == CEMIT_IR_NO_VAL || rv == CEMIT_IR_NO_VAL) return false;
          const uint32_t ov = b.emit_inst_dst(
              CEMIT_IR_BINOP, binop, w, b.alloc_dst_for_reg(dst), lv, rv, 0u, d.pc);
          if (b.oom) return false;
          b.write_reg(dst, ov, d.op_size);
          return true;
        }
        // Memory operand form: e.g. `add eax, dword ptr [rbp - 0x10]` (sub == 3)
        if (sub == 3u) {
          const uint32_t lv = b.read_reg(d.reg);
          const uint32_t rv = b.read_mem_operand(d, w);
          if (lv == CEMIT_IR_NO_VAL || rv == CEMIT_IR_NO_VAL) return false;
          const uint32_t ov = b.emit_inst_dst(
              CEMIT_IR_BINOP, binop, w, b.alloc_dst_for_reg(d.reg), lv, rv, 0u, d.pc);
          if (b.oom) return false;
          b.write_reg(d.reg, ov, d.op_size);
          return true;
        }
        // sub == 1 with memory destination: `add [rbp - 0x10], eax`
        const uint32_t lv = b.read_mem_operand(d, w);
        const uint32_t rv = b.read_reg(d.reg);
        if (lv == CEMIT_IR_NO_VAL || rv == CEMIT_IR_NO_VAL) return false;
        const uint32_t ov = b.emit_inst(CEMIT_IR_BINOP, binop, w, lv, rv, 0u, d.pc, true);
        if (b.oom) return false;
        return b.write_mem_operand(d, ov, w);
      }

      if (sub == 5u && (d.flags & HEX_X86_FLAG_HAS_IMM) != 0u) {
        const uint32_t lv = b.read_reg(0u);
        if (lv == CEMIT_IR_NO_VAL) return false;
        uint64_t imm_val = static_cast<uint64_t>(d.imm);
        if (w == 32u) imm_val &= 0xffffffffULL;
        const uint32_t iv = b.emit_const(w, imm_val, d.pc);
        if (b.oom) return false;
        const uint32_t ov = b.emit_inst_dst(
            CEMIT_IR_BINOP, binop, w, b.alloc_dst_for_reg(0u), lv, iv, 0u, d.pc);
        if (b.oom) return false;
        b.write_reg(0u, ov, d.op_size);
        return true;
      }
      return false;
    }

    // Group 1 ALU r/m, imm8/imm32 (81 / 83)
    if ((d.opcode == 0x81u || d.opcode == 0x83u) && (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
      const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3) & 7u);
      uint8_t binop = 0u;
      if (!map_alu_group_to_binop(grp, binop)) return false;
      uint64_t imm_val = static_cast<uint64_t>(d.imm);
      if (w == 32u) imm_val &= 0xffffffffULL;
      const uint32_t iv = b.emit_const(w, imm_val, d.pc);
      if (b.oom) return false;
      if (mod == 3u) {
        const uint32_t lv = b.read_reg(d.rm);
        if (lv == CEMIT_IR_NO_VAL) return false;
        const uint32_t ov = b.emit_inst_dst(
            CEMIT_IR_BINOP, binop, w, b.alloc_dst_for_reg(d.rm), lv, iv, 0u, d.pc);
        if (b.oom) return false;
        b.write_reg(d.rm, ov, d.op_size);
        return true;
      }
      const uint32_t lv = b.read_mem_operand(d, w);
      if (lv == CEMIT_IR_NO_VAL) return false;
      const uint32_t ov = b.emit_inst(CEMIT_IR_BINOP, binop, w, lv, iv, 0u, d.pc, true);
      if (b.oom) return false;
      return b.write_mem_operand(d, ov, w);
    }
    return false;
  }

  if (d.kind == HEX_X86_KIND_MUL) {
    // Flag-clobbering IMUL instructions invalidate any prior cmp state.
    b.has_cmp = false;
    if (w != 32u && w != 64u) return false;
    if (d.opcode == 0x0fu && d.opcode2 == 0xafu &&
        (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
      const uint32_t lv = b.read_reg(d.reg);
      const uint32_t rv = b.read_reg(d.rm);
      if (lv == CEMIT_IR_NO_VAL || rv == CEMIT_IR_NO_VAL) return false;
      const uint32_t ov = b.emit_inst_dst(
          CEMIT_IR_BINOP, CEMIT_BIN_MUL, w, b.alloc_dst_for_reg(d.reg), lv, rv, 0u, d.pc);
      if (b.oom) return false;
      b.write_reg(d.reg, ov, d.op_size);
      return true;
    }
    if ((d.opcode == 0x69u || d.opcode == 0x6bu) &&
        (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
      const uint32_t lv = b.read_reg(d.rm);
      if (lv == CEMIT_IR_NO_VAL) return false;
      uint64_t imm_val = static_cast<uint64_t>(d.imm);
      if (w == 32u) imm_val &= 0xffffffffULL;
      const uint32_t iv = b.emit_const(w, imm_val, d.pc);
      if (b.oom) return false;
      const uint32_t ov = b.emit_inst_dst(
          CEMIT_IR_BINOP, CEMIT_BIN_MUL, w, b.alloc_dst_for_reg(d.reg), lv, iv, 0u, d.pc);
      if (b.oom) return false;
      b.write_reg(d.reg, ov, d.op_size);
      return true;
    }
    return false;
  }

  if (d.kind == HEX_X86_KIND_LEA) {
    if (w != 32u && w != 64u) return false;
    if ((d.flags & HEX_X86_FLAG_HAS_MODRM) == 0u || mod == 3u) return false;
    if ((d.flags & HEX_X86_FLAG_RIP_REL) != 0u) return false;
    if (d.reg >= 16u) return false;

    uint32_t acc = CEMIT_IR_NO_VAL;
    if (d.rm != kRegNone) {
      const uint32_t bv = b.read_reg(d.rm);
      if (bv == CEMIT_IR_NO_VAL) return false;
      acc = bv;
    }
    if (d.index_reg != kRegNone) {
      const uint32_t iv = b.read_reg(d.index_reg);
      if (iv == CEMIT_IR_NO_VAL) return false;
      uint32_t scaled = iv;
      if (d.scale > 1u) {
        const uint32_t sc = b.emit_const(w, static_cast<uint64_t>(d.scale), d.pc);
        if (b.oom) return false;
        scaled = b.emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_MUL, w, iv, sc, 0u, d.pc, true);
        if (b.oom) return false;
      }
      if (acc == CEMIT_IR_NO_VAL) {
        acc = scaled;
      } else {
        acc = b.emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_ADD, w, acc, scaled, 0u, d.pc, true);
        if (b.oom) return false;
      }
    }
    if ((d.flags & HEX_X86_FLAG_HAS_DISP) != 0u && d.disp != 0) {
      if (acc == CEMIT_IR_NO_VAL) {
        uint64_t dv = static_cast<uint64_t>(d.disp);
        if (w == 32u) dv &= 0xffffffffULL;
        acc = b.emit_const(w, dv, d.pc);
        if (b.oom) return false;
      } else if (d.disp > 0) {
        const uint32_t dv = b.emit_const(w, static_cast<uint64_t>(d.disp), d.pc);
        if (b.oom) return false;
        acc = b.emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_ADD, w, acc, dv, 0u, d.pc, true);
        if (b.oom) return false;
      } else {
        const uint64_t mag = 0ULL - static_cast<uint64_t>(d.disp);
        const uint32_t dv = b.emit_const(w, mag, d.pc);
        if (b.oom) return false;
        acc = b.emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_SUB, w, acc, dv, 0u, d.pc, true);
        if (b.oom) return false;
      }
    }
    if (acc == CEMIT_IR_NO_VAL) {
      acc = b.emit_const(w, 0u, d.pc);
      if (b.oom) return false;
    }
    if (b.multi_block && b.reg_fixed_var[d.reg] != CEMIT_IR_NO_VAL) {
      acc = b.emit_inst_dst(CEMIT_IR_COPY, 0u, w, b.reg_fixed_var[d.reg], acc, CEMIT_IR_NO_VAL, 0u, d.pc);
      if (b.oom) return false;
    }
    b.write_reg(d.reg, acc, d.op_size);
    return true;
  }

  return false;
}

int32_t find_insn_by_pc(const HexX86Decoded* decoded, uint32_t count, uint64_t target_pc) {
  for (uint32_t i = 0u; i < count; ++i) {
    if (decoded[i].pc == target_pc) return static_cast<int32_t>(i);
  }
  return -1;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_engine_decompile_x86_64")
HexStatus hex_engine_decompile_x86_64(
    const uint8_t* bytes,
    uint32_t byte_len,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t abi_id,
    uint32_t emit_flags) {
  ensure_x86_arenas();
  clear_x86_last_output();

  if (bytes == nullptr || byte_len == 0u) return HEX_ERR_INVALID_ARG;
  if (func_name_len > 0u && func_name_utf8 == nullptr) return HEX_ERR_INVALID_ARG;
  if (abi_id != HEX_X86_ABI_SYSV_AMD64 && abi_id != HEX_X86_ABI_MICROSOFT_X64) {
    return HEX_ERR_INVALID_ARG;
  }
  if (byte_len > kMaxX86Bytes) return HEX_ERR_UNSUPPORTED;

  // Copy function name to stack so it is never aliased with any arena.
  char local_name[256];
  uint32_t local_name_len = 0u;
  if (func_name_utf8 != nullptr && func_name_len > 0u) {
    local_name_len = func_name_len < (sizeof(local_name) - 1u)
        ? func_name_len
        : static_cast<uint32_t>(sizeof(local_name) - 1u);
    hex::mem_copy(local_name, func_name_utf8, local_name_len);
    local_name[local_name_len] = '\0';
  }

  g_x86_work_arena.reset();
  hex::ArenaScope work_scope(g_x86_work_arena);

  // Stage 1: Full-buffer fail-closed decode (supporting 1-byte `leave` 0xC9 as epilogue).
  HexX86Decoded* decoded = g_x86_work_arena.alloc<HexX86Decoded>(kMaxX86Insns);
  if (!decoded) return HEX_ERR_OOM;

  uint32_t off = 0u;
  uint32_t insn_count = 0u;
  bool has_ret = false;
  while (off < byte_len) {
    if (insn_count >= kMaxX86Insns) return HEX_ERR_UNSUPPORTED;
    HexX86Decoded& d = decoded[insn_count];
    if (bytes[off] == 0xc9u) {
      hex::mem_set(&d, 0, sizeof(HexX86Decoded));
      d.pc = base_addr + static_cast<uint64_t>(off);
      d.length = 1u;
      d.opcode = 0xc9u;
      d.kind = HEX_X86_KIND_NOP;
      d.cap = HEX_X86_CAP_DECOMP;
      d.valid = 1u;
      d.reg = kRegNone;
      d.rm = kRegNone;
      d.index_reg = kRegNone;
      d.mn[0] = 'l'; d.mn[1] = 'e'; d.mn[2] = 'a'; d.mn[3] = 'v'; d.mn[4] = 'e'; d.mn[5] = '\0';
    } else {
      const HexStatus st = hex_x86_64_decode_one(
          bytes + off, byte_len - off, base_addr + static_cast<uint64_t>(off), &d);
      if (st != HEX_OK) return HEX_ERR_UNSUPPORTED;
      if (d.valid == 0u || d.length == 0u ||
          (d.flags & (HEX_X86_FLAG_TRUNCATED | HEX_X86_FLAG_INVALID)) != 0u ||
          d.cap != HEX_X86_CAP_DECOMP) {
        return HEX_ERR_UNSUPPORTED;
      }
      if (static_cast<uint32_t>(d.length) > byte_len - off) return HEX_ERR_UNSUPPORTED;
    }

    if (d.kind == HEX_X86_KIND_CALL) return HEX_ERR_UNSUPPORTED;
    if (d.kind == HEX_X86_KIND_RET) {
      if (d.opcode != 0xc3u) return HEX_ERR_UNSUPPORTED;
      has_ret = true;
    }
    if ((d.kind == HEX_X86_KIND_JMP || d.kind == HEX_X86_KIND_JCC) &&
        (d.flags & HEX_X86_FLAG_HAS_TARGET) == 0u) {
      return HEX_ERR_UNSUPPORTED;
    }

    off += static_cast<uint32_t>(d.length);
    ++insn_count;
  }
  if (off != byte_len || insn_count == 0u || !has_ret) return HEX_ERR_UNSUPPORTED;

  // Stage 2: Basic block partitioning & jump target validation.
  uint8_t is_leader[kMaxX86Insns];
  uint32_t insn_to_block[kMaxX86Insns];
  hex::mem_set(is_leader, 0, insn_count);
  is_leader[0] = 1u;

  for (uint32_t i = 0u; i < insn_count; ++i) {
    const HexX86Decoded& d = decoded[i];
    if (d.kind == HEX_X86_KIND_JMP || d.kind == HEX_X86_KIND_JCC) {
      const int32_t tidx = find_insn_by_pc(decoded, insn_count, d.target);
      if (tidx < 0) return HEX_ERR_UNSUPPORTED;  // out-of-function or misaligned branch target
      is_leader[static_cast<uint32_t>(tidx)] = 1u;
      if (i + 1u < insn_count) is_leader[i + 1u] = 1u;
    } else if (d.kind == HEX_X86_KIND_RET) {
      if (i + 1u < insn_count) is_leader[i + 1u] = 1u;
    }
  }

  uint32_t block_start[kMaxX86Blocks];
  uint32_t block_end[kMaxX86Blocks];
  uint64_t block_addr[kMaxX86Blocks];
  uint32_t num_blocks = 0u;
  for (uint32_t i = 0u; i < insn_count; ++i) {
    if (is_leader[i]) {
      if (num_blocks >= kMaxX86Blocks) return HEX_ERR_UNSUPPORTED;
      if (num_blocks > 0u) block_end[num_blocks - 1u] = i;
      block_start[num_blocks] = i;
      block_addr[num_blocks] = decoded[i].pc;
      ++num_blocks;
    }
    insn_to_block[i] = num_blocks - 1u;
  }
  block_end[num_blocks - 1u] = insn_count;

  // Build CFG successor CSR arrays (for Jcc: succ[0]=taken, succ[1]=fallthrough).
  uint32_t succ_off[kMaxX86Blocks + 1u];
  int32_t succ_dst_i32[kMaxX86Blocks * 2u];
  uint32_t succ_dst_u32[kMaxX86Blocks * 2u];
  uint32_t edge_cursor = 0u;

  for (uint32_t b = 0u; b < num_blocks; ++b) {
    succ_off[b] = edge_cursor;
    const uint32_t last_i = block_end[b] - 1u;
    const HexX86Decoded& tail = decoded[last_i];
    if (tail.kind == HEX_X86_KIND_RET) {
      // no successors
    } else if (tail.kind == HEX_X86_KIND_JMP) {
      const int32_t tidx = find_insn_by_pc(decoded, insn_count, tail.target);
      if (tidx < 0) return HEX_ERR_UNSUPPORTED;
      const uint32_t tb = insn_to_block[static_cast<uint32_t>(tidx)];
      succ_dst_i32[edge_cursor] = static_cast<int32_t>(tb);
      succ_dst_u32[edge_cursor] = tb;
      ++edge_cursor;
    } else if (tail.kind == HEX_X86_KIND_JCC) {
      const int32_t tidx = find_insn_by_pc(decoded, insn_count, tail.target);
      if (tidx < 0 || b + 1u >= num_blocks) return HEX_ERR_UNSUPPORTED;
      const uint32_t tb = insn_to_block[static_cast<uint32_t>(tidx)];
      const uint32_t fb = b + 1u;
      succ_dst_i32[edge_cursor] = static_cast<int32_t>(tb);
      succ_dst_u32[edge_cursor] = tb;
      ++edge_cursor;
      succ_dst_i32[edge_cursor] = static_cast<int32_t>(fb);
      succ_dst_u32[edge_cursor] = fb;
      ++edge_cursor;
    } else {
      if (b + 1u >= num_blocks) return HEX_ERR_UNSUPPORTED;  // fall off end without ret
      succ_dst_i32[edge_cursor] = static_cast<int32_t>(b + 1u);
      succ_dst_u32[edge_cursor] = b + 1u;
      ++edge_cursor;
    }
  }
  succ_off[num_blocks] = edge_cursor;

  // Stage 3: Dominators & Natural Loops via loop_engine (for multi-block functions).
  const bool multi_block = (num_blocks > 1u);
  HexLoopResult loop_res{};
  int32_t single_idom[1] = {-1};
  int32_t single_ipdom[1] = {-1};
  uint32_t* loop_headers_u32 = nullptr;

  if (multi_block) {
    const HexStatus lst = hex_loop_analyze_arena(
        g_x86_work_arena,
        num_blocks,
        succ_off,
        edge_cursor > 0u ? succ_dst_i32 : nullptr,
        0,
        nullptr,
        nullptr,
        &loop_res);
    if (lst != HEX_OK) return lst;
    if (loop_res.num_loops > 0u) {
      loop_headers_u32 = g_x86_work_arena.alloc<uint32_t>(loop_res.num_loops);
      if (!loop_headers_u32) return HEX_ERR_OOM;
      for (uint32_t l = 0u; l < loop_res.num_loops; ++l) {
        loop_headers_u32[l] = static_cast<uint32_t>(loop_res.loop_header[l]);
      }
    }
  }

  // Stage 4: Lift each basic block into CEmitInst SSA/mutable-var IR.
  LiftBuilder builder(&g_x86_work_arena, abi_id, base_addr, multi_block);
  if (!builder.insts.reserve(static_cast<size_t>(insn_count) * 4u + 16u)) {
    return HEX_ERR_OOM;
  }

  // For multi-block functions (branches/loops), pre-allocate persistent variable IDs
  // for registers written in multiple blocks so cross-block/loop updates stay coherent.
  if (multi_block) {
    uint32_t reg_write_blocks[16];
    uint32_t reg_last_block[16];
    for (uint32_t r = 0u; r < 16u; ++r) {
      reg_write_blocks[r] = 0u;
      reg_last_block[r] = 0xffffffffu;
    }
    for (uint32_t b = 0u; b < num_blocks; ++b) {
      for (uint32_t i = block_start[b]; i < block_end[b]; ++i) {
        const HexX86Decoded& d = decoded[i];
        int64_t dummy_delta = 0;
        if (d.kind == HEX_X86_KIND_NOP || is_frame_prologue_or_epilogue(d, dummy_delta)) continue;
        uint8_t dst = kRegNone;
        const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6) & 3u);
        if (d.kind == HEX_X86_KIND_MOV) {
          if (d.opcode >= 0xb8u && d.opcode <= 0xbfu) dst = d.rm;
          else if ((d.opcode == 0xc6u || d.opcode == 0xc7u) && mod == 3u) dst = d.rm;
          else if ((d.opcode == 0x88u || d.opcode == 0x89u) && mod == 3u) dst = d.rm;
          else if (d.opcode == 0x8au || d.opcode == 0x8bu) dst = d.reg;
        } else if (d.kind == HEX_X86_KIND_MOVZX || d.kind == HEX_X86_KIND_LEA || d.kind == HEX_X86_KIND_MUL) {
          dst = d.reg;
        } else if (d.kind == HEX_X86_KIND_ALU) {
          if (d.opcode < 0x40u) {
            const uint8_t sub = static_cast<uint8_t>(d.opcode & 7u);
            if (sub == 1u && mod == 3u) dst = d.rm;
            else if (sub == 3u) dst = d.reg;
            else if (sub == 5u) dst = 0u;
          } else if ((d.opcode == 0x81u || d.opcode == 0x83u) && mod == 3u) {
            dst = d.rm;
          }
        }
        if (dst < 16u && reg_last_block[dst] != b) {
          reg_last_block[dst] = b;
          ++reg_write_blocks[dst];
        }
      }
    }
    for (uint32_t r = 0u; r < 16u; ++r) {
      if (reg_write_blocks[r] > 1u) {
        builder.reg_fixed_var[r] = builder.next_ssa++;
      }
    }
  }

  uint32_t block_inst_off[kMaxX86Blocks + 1u];
  for (uint32_t b = 0u; b < num_blocks; ++b) {
    block_inst_off[b] = static_cast<uint32_t>(builder.insts.size());
    builder.has_cmp = false;

    const uint32_t bs = block_start[b];
    const uint32_t be = block_end[b];
    for (uint32_t i = bs; i < be; ++i) {
      const HexX86Decoded& d = decoded[i];
      if (d.kind == HEX_X86_KIND_RET) {
        builder.emit_inst(
            CEMIT_IR_RET, 0u, builder.wrote_rax ? builder.ret_width : 0u,
            builder.wrote_rax ? builder.reg_val[0] : CEMIT_IR_NO_VAL,
            CEMIT_IR_NO_VAL, 0u, d.pc, false);
        if (builder.oom) return HEX_ERR_OOM;
        continue;
      }
      if (d.kind == HEX_X86_KIND_JMP) {
        builder.emit_inst(
            CEMIT_IR_BRANCH, 0u, 0u, CEMIT_IR_NO_VAL, CEMIT_IR_NO_VAL, d.target, d.pc, false);
        if (builder.oom) return HEX_ERR_OOM;
        continue;
      }
      if (d.kind == HEX_X86_KIND_JCC) {
        if (!builder.has_cmp) return HEX_ERR_UNSUPPORTED;
        const uint8_t cc = (d.opcode == 0x0fu) ? static_cast<uint8_t>(d.opcode2 & 0x0fu)
                                               : static_cast<uint8_t>(d.opcode & 0x0fu);
        uint8_t cmp_op = 0u;
        if (!map_x86_cc_to_cemit_cmp(cc, cmp_op)) return HEX_ERR_UNSUPPORTED;
        const uint32_t cond_v = builder.emit_inst(
            CEMIT_IR_CMP, cmp_op, builder.cmp_width, builder.cmp_lhs, builder.cmp_rhs, 0u, d.pc, true);
        if (builder.oom) return HEX_ERR_OOM;
        builder.emit_inst(
            CEMIT_IR_CONDBR, cmp_op, 0u, cond_v, CEMIT_IR_NO_VAL, d.target, d.pc, false);
        if (builder.oom) return HEX_ERR_OOM;
        continue;
      }
      if (!lift_one_x86_insn(builder, d)) {
        return builder.oom ? HEX_ERR_OOM : HEX_ERR_UNSUPPORTED;
      }
    }
  }
  block_inst_off[num_blocks] = static_cast<uint32_t>(builder.insts.size());

  // Stage 5: Emit structured C text + linemap into the physically isolated g_x86_emit_arena.
  CEmitFunctionView view{};
  view.func_name = local_name_len > 0u ? local_name : nullptr;
  view.func_name_len = local_name_len;
  view.entry_va = base_addr;
  view.num_params = builder.num_params;
  view.ret_width = builder.wrote_rax ? builder.ret_width : 0u;
  view.ret_is_signed = (builder.wrote_rax && builder.ret_width == 32u) ? 1u : 0u;
  view.num_blocks = num_blocks;
  view.entry_block = 0u;
  view.block_inst_off = block_inst_off;
  view.block_addr = block_addr;
  view.insts = builder.insts.data();
  view.num_insts = static_cast<uint32_t>(builder.insts.size());
  view.succ_off = succ_off;
  view.succ_dst = edge_cursor > 0u ? succ_dst_u32 : nullptr;
  view.idom = multi_block ? loop_res.cfg.idom : single_idom;
  view.ipdom = multi_block ? loop_res.cfg.pdom_idom : single_ipdom;
  view.num_loops = multi_block ? loop_res.num_loops : 0u;
  view.loop_header = loop_headers_u32;
  view.loop_parent = multi_block ? loop_res.loop_parent : nullptr;
  view.node_innermost_loop = multi_block ? loop_res.node_innermost_loop : nullptr;

  hex::decompiler::bind_arena(&g_x86_emit_arena);
  const int32_t emit_rc = hex_decomp_emit_c_ex(&view, kMaxEmitBytes, emit_flags);
  if (emit_rc != HEX_OK) {
    clear_x86_last_output();
    return static_cast<HexStatus>(emit_rc);
  }

  g_x86_last_text = hex_decomp_get_text_ptr();
  g_x86_last_text_len = hex_decomp_get_text_len();
  g_x86_last_linemap = hex_decomp_get_linemap_ptr();
  g_x86_last_linemap_count = hex_decomp_get_linemap_count();
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_x86_64_decomp_get_text_ptr")
const char* hex_x86_64_decomp_get_text_ptr(void) {
  return g_x86_last_text;
}

HEX_WASM_EXPORT("hex_x86_64_decomp_get_text_len")
uint32_t hex_x86_64_decomp_get_text_len(void) {
  return g_x86_last_text_len;
}

HEX_WASM_EXPORT("hex_x86_64_decomp_get_linemap_ptr")
const HexLineMapEntry* hex_x86_64_decomp_get_linemap_ptr(void) {
  return g_x86_last_linemap;
}

HEX_WASM_EXPORT("hex_x86_64_decomp_get_linemap_count")
uint32_t hex_x86_64_decomp_get_linemap_count(void) {
  return g_x86_last_linemap_count;
}

}  // extern "C"
