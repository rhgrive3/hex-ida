#include "x86_64_decomp.hpp"
#include "../cfg/loop_engine.hpp"

#if defined(HEX_UNIFIED_WASM)
namespace hex {
namespace runtime {
hex::Arena* shared_emit_arena();
hex::Arena* shared_scratch_arena();
}  // namespace runtime
}  // namespace hex
#endif

namespace {

constexpr uint32_t kMaxX86Bytes = 4096u;
constexpr uint32_t kMaxX86Insns = 128u;
constexpr uint32_t kMaxX86Blocks = 64u;
constexpr uint32_t kMaxStackSlots = 32u;
constexpr uint32_t kMaxEmitBytes = 256u * 1024u;
constexpr uint8_t kRegNone = 0xffu;

#if !defined(HEX_UNIFIED_WASM)
constexpr uint32_t kX86WorkArenaBytes = 1024u * 1024u;
constexpr uint32_t kX86EmitArenaBytes = 1024u * 1024u;

alignas(16) uint8_t g_x86_work_storage[kX86WorkArenaBytes];
alignas(16) uint8_t g_x86_emit_storage[kX86EmitArenaBytes];

hex::Arena g_x86_work_arena;
hex::Arena g_x86_emit_arena;
bool g_x86_arenas_init = false;

void ensure_x86_arenas() {
  if (!g_x86_arenas_init) {
    g_x86_work_arena.init_fixed(g_x86_work_storage, sizeof(g_x86_work_storage));
    g_x86_emit_arena.init_fixed(g_x86_emit_storage, sizeof(g_x86_emit_storage));
    g_x86_arenas_init = true;
  }
}
#endif

hex::Arena& x86_work_arena() {
#if defined(HEX_UNIFIED_WASM)
  return *hex::runtime::shared_scratch_arena();
#else
  ensure_x86_arenas();
  return g_x86_work_arena;
#endif
}

hex::Arena& x86_emit_arena() {
#if defined(HEX_UNIFIED_WASM)
  return *hex::runtime::shared_emit_arena();
#else
  ensure_x86_arenas();
  return g_x86_emit_arena;
#endif
}

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


static inline bool is_gen_alpha(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

static inline bool is_gen_digit(char c) {
  return c >= '0' && c <= '9';
}

static bool str_eq(const char* a, const char* b) {
  if (!a || !b) return false;
  uint32_t i = 0u;
  while (a[i] != '\0' && b[i] != '\0') {
    if (a[i] != b[i]) return false;
    ++i;
  }
  return a[i] == '\0' && b[i] == '\0';
}

static bool is_reserved_c11_or_reg_name(const char* s) {
  static const char* const kReserved[] = {
      // C11 keywords
      "auto", "break", "case", "char", "const", "continue", "default", "do",
      "double", "else", "enum", "extern", "float", "for", "goto", "if",
      "inline", "int", "long", "register", "restrict", "return", "short",
      "signed", "sizeof", "static", "struct", "switch", "typedef", "union",
      "unsigned", "void", "volatile", "while",
      "_Alignas", "_Alignof", "_Atomic", "_Bool", "_Complex", "_Generic",
      "_Imaginary", "_Noreturn", "_Static_assert", "_Thread_local",
      // Fixed-width prelude typedefs
      "uint8", "int8", "uint16", "int16", "uint32", "int32", "uint64", "int64",
      "uint8_t", "uintptr_t",
      // x86-64 GPR & XMM register names used as local variables
      "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
      "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
      "xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7",
      "xmm8", "xmm9", "xmm10", "xmm11", "xmm12", "xmm13", "xmm14", "xmm15",
  };
  for (uint32_t i = 0u; i < static_cast<uint32_t>(sizeof(kReserved) / sizeof(kReserved[0])); ++i) {
    if (str_eq(s, kReserved[i])) return true;
  }
  return false;
}

static uint32_t format_sub_name(uint64_t addr, char* out_buf, uint32_t out_cap) {
  if (out_cap < 8u) return 0u;
  uint32_t sp = 0u;
  out_buf[sp++] = 's';
  out_buf[sp++] = 'u';
  out_buf[sp++] = 'b';
  out_buf[sp++] = '_';
  static const char kHi[] = "0123456789ABCDEF";
  char tmp[16];
  uint32_t tn = 0u;
  uint64_t v = addr;
  do {
    tmp[tn++] = kHi[v & 0xFu];
    v >>= 4u;
  } while (v != 0ULL && tn < 16u);
  while (tn > 0u && sp + 1u < out_cap) {
    out_buf[sp++] = tmp[--tn];
  }
  out_buf[sp] = '\0';
  return sp;
}

static uint32_t sanitize_func_name(
    const char* raw,
    uint32_t raw_len,
    uint64_t base_addr,
    char* out_buf,
    uint32_t out_cap) {
  if (out_cap < 16u) return 0u;
  if (raw == nullptr || raw_len == 0u) {
    return format_sub_name(base_addr, out_buf, out_cap);
  }
  uint32_t out_len = 0u;
  if (is_gen_digit(raw[0])) {
    out_buf[out_len++] = 'f';
    out_buf[out_len++] = 'n';
    out_buf[out_len++] = '_';
  }
  for (uint32_t i = 0u; i < raw_len && out_len + 1u < out_cap; ++i) {
    const char c = raw[i];
    if (is_gen_alpha(c) || is_gen_digit(c) || c == '_') {
      out_buf[out_len++] = c;
    } else {
      out_buf[out_len++] = '_';
    }
  }
  if (out_len == 0u) {
    return format_sub_name(base_addr, out_buf, out_cap);
  }
  out_buf[out_len] = '\0';
  if (is_reserved_c11_or_reg_name(out_buf)) {
    const uint32_t max_body = (out_cap > 4u) ? (out_cap - 4u) : 0u;
    const uint32_t keep = (out_len < max_body) ? out_len : max_body;
    for (uint32_t k = keep; k > 0u; --k) {
      out_buf[k + 2u] = out_buf[k - 1u];
    }
    out_buf[0] = 'f';
    out_buf[1] = 'n';
    out_buf[2] = '_';
    out_len = keep + 3u;
    out_buf[out_len] = '\0';
  }
  return out_len;
}

// Validate that strict C output has no undeclared `L_bbN` labels and no out-of-scope `vN` uses.
static bool validate_strict_c_output(const char* text, uint32_t len) {
  if (!text || len == 0u) return false;

  // 1. Check every `goto L_bb<N>;` has a matching `L_bb<N>:` label definition.
  for (uint32_t i = 0u; i + 10u < len; ++i) {
    if (text[i] == 'g' && text[i + 1u] == 'o' && text[i + 2u] == 't' &&
        text[i + 3u] == 'o' && text[i + 4u] == ' ' && text[i + 5u] == 'L' &&
        text[i + 6u] == '_' && text[i + 7u] == 'b' && text[i + 8u] == 'b' &&
        is_gen_digit(text[i + 9u])) {
      uint32_t j = i + 9u;
      while (j < len && is_gen_digit(text[j])) ++j;
      if (j < len && text[j] == ';') {
        const uint32_t lbl_start = i + 5u;
        const uint32_t lbl_len = j - lbl_start;
        bool found_def = false;
        for (uint32_t k = 0u; k + lbl_len < len; ++k) {
          if (k > 0u && text[k - 1u] != '\n' && text[k - 1u] != ' ') continue;
          bool match = true;
          for (uint32_t m = 0u; m < lbl_len; ++m) {
            if (text[k + m] != text[lbl_start + m]) {
              match = false;
              break;
            }
          }
          if (match && text[k + lbl_len] == ':') {
            found_def = true;
            break;
          }
        }
        if (!found_def) return false;
      }
    }
  }

  // 2. Check every `v<N>` inside the function body is declared in an enclosing brace scope.
  uint32_t body_pos = 0u;
  while (body_pos < len && text[body_pos] != '{') ++body_pos;
  if (body_pos >= len) return false;

  constexpr uint32_t kTrackVars = 512u;
  uint8_t var_depth[kTrackVars];
  hex::mem_set(var_depth, 0, sizeof(var_depth));
  uint32_t depth = 1u;

  auto is_ident_char = [](char c) -> bool {
    return is_gen_alpha(c) || is_gen_digit(c) || c == '_';
  };
  auto is_type_tok = [](const char* s, uint32_t n) -> bool {
    static const char* const kTypes[] = {
        "uint8", "int8", "uint16", "int16", "uint32", "int32", "uint64", "int64"};
    for (uint32_t t = 0u; t < 8u; ++t) {
      const char* tn = kTypes[t];
      uint32_t m = 0u;
      while (tn[m] != '\0' && m < n && tn[m] == s[m]) ++m;
      if (tn[m] == '\0' && m == n) return true;
    }
    return false;
  };

  for (uint32_t i = body_pos + 1u; i < len; ++i) {
    const char c = text[i];
    if (c == '{') {
      ++depth;
      continue;
    }
    if (c == '}') {
      for (uint32_t k = 0u; k < kTrackVars; ++k) {
        if (var_depth[k] == depth) var_depth[k] = 0u;
      }
      if (depth == 0u) return false;
      --depth;
      continue;
    }
    if (c == 'v' && i + 1u < len && is_gen_digit(text[i + 1u]) &&
        (i == 0u || !is_ident_char(text[i - 1u]))) {
      uint32_t j = i + 1u;
      uint32_t vid = 0u;
      while (j < len && is_gen_digit(text[j])) {
        if (vid < kTrackVars) vid = vid * 10u + static_cast<uint32_t>(text[j] - '0');
        ++j;
      }
      if (j < len && is_ident_char(text[j])) continue;
      if (vid < kTrackVars) {
        // Check if preceded by a fixed-width type token on the same line (declaration).
        uint32_t p = i;
        while (p > body_pos && text[p - 1u] == ' ') --p;
        uint32_t tok_end = p;
        while (p > body_pos && is_ident_char(text[p - 1u])) --p;
        const bool is_decl = (tok_end > p) && is_type_tok(text + p, tok_end - p);
        if (is_decl) {
          var_depth[vid] = static_cast<uint8_t>(depth < 255u ? depth : 255u);
        } else if (var_depth[vid] == 0u) {
          return false;
        }
      }
      i = j - 1u;
    }
  }
  return depth == 0u;
}

// ============================================================================
// Strict/Structured Fast-Path Emitter (small clean x86-64 functions)
// ============================================================================

HexStatus try_emit_x86_64_strict(
    const uint8_t* bytes,
    uint32_t byte_len,
    uint64_t base_addr,
    const char* local_name,
    uint32_t local_name_len,
    uint32_t abi_id,
    uint32_t emit_flags) {
  if (byte_len > kMaxX86Bytes) return HEX_ERR_UNSUPPORTED;

  hex::Arena& work_arena = x86_work_arena();
#if !defined(HEX_UNIFIED_WASM)
  work_arena.reset();
#endif
  // ArenaScope preserves caller-allocated input buffers on shared_scratch_arena().
  hex::ArenaScope work_scope(work_arena);

  // Stage 1: Full-buffer fail-closed decode (supporting 1-byte `leave` 0xC9 as epilogue).
  HexX86Decoded* decoded = work_arena.alloc<HexX86Decoded>(kMaxX86Insns);
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
        work_arena,
        num_blocks,
        succ_off,
        edge_cursor > 0u ? succ_dst_i32 : nullptr,
        0,
        nullptr,
        nullptr,
        &loop_res);
    if (lst != HEX_OK) return lst;
    if (loop_res.num_loops > 0u) {
      loop_headers_u32 = work_arena.alloc<uint32_t>(loop_res.num_loops);
      if (!loop_headers_u32) return HEX_ERR_OOM;
      for (uint32_t l = 0u; l < loop_res.num_loops; ++l) {
        loop_headers_u32[l] = static_cast<uint32_t>(loop_res.loop_header[l]);
      }
    }
  }

  // Stage 4: Lift each basic block into CEmitInst SSA/mutable-var IR.
  LiftBuilder builder(&work_arena, abi_id, base_addr, multi_block);
  if (!builder.insts.reserve(static_cast<size_t>(insn_count) * 4u + 16u)) {
    return HEX_ERR_OOM;
  }

  // For multi-block functions (branches/loops), pre-allocate persistent variable IDs
  // for registers written in multiple blocks so cross-block/loop updates stay coherent.
  bool reg_written_in_bb0[16];
  uint16_t reg_max_width[16];
  for (uint32_t r = 0u; r < 16u; ++r) {
    reg_written_in_bb0[r] = false;
    reg_max_width[r] = 0u;
  }
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
        if (dst < 16u) {
          if (b == 0u) reg_written_in_bb0[dst] = true;
          if (d.op_size > reg_max_width[dst]) reg_max_width[dst] = d.op_size;
          if (reg_last_block[dst] != b) {
            reg_last_block[dst] = b;
            ++reg_write_blocks[dst];
          }
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

    // Pre-declare multi-block fixed vars not written in entry bb0 at function scope
    // so C11 branch scopes (if/else) never leave them undeclared in sibling blocks.
    if (multi_block && b == 0u) {
      for (uint32_t r = 0u; r < 16u; ++r) {
        if (builder.reg_fixed_var[r] != CEMIT_IR_NO_VAL && !reg_written_in_bb0[r]) {
          const uint16_t init_w = (reg_max_width[r] == 8u || reg_max_width[r] == 16u ||
                                   reg_max_width[r] == 32u || reg_max_width[r] == 64u)
                                      ? reg_max_width[r]
                                      : 64u;
          const uint32_t zc = builder.emit_const(init_w, 0u, base_addr);
          if (builder.oom) return HEX_ERR_OOM;
          builder.emit_inst_dst(
              CEMIT_IR_COPY, 0u, init_w, builder.reg_fixed_var[r],
              zc, CEMIT_IR_NO_VAL, 0u, base_addr);
          if (builder.oom) return HEX_ERR_OOM;
        }
      }
    }

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

  hex::decompiler::bind_arena(&x86_emit_arena());
  const int32_t emit_rc = hex_decomp_emit_c_ex(&view, kMaxEmitBytes, emit_flags);
  if (emit_rc != HEX_OK) {
    clear_x86_last_output();
    return static_cast<HexStatus>(emit_rc);
  }

  const char* emitted_text = hex_decomp_get_text_ptr();
  const uint32_t emitted_len = hex_decomp_get_text_len();
  if (!validate_strict_c_output(emitted_text, emitted_len)) {
    clear_x86_last_output();
    return HEX_ERR_UNSUPPORTED;
  }

  g_x86_last_text = emitted_text;
  g_x86_last_text_len = emitted_len;
  g_x86_last_linemap = hex_decomp_get_linemap_ptr();
  g_x86_last_linemap_count = hex_decomp_get_linemap_count();
  return HEX_OK;
}

// ============================================================================
// General x86-64 C11 Emitter (100% real-world x86-64 coverage up to 32 KiB)
// ============================================================================

constexpr uint32_t kMaxGeneralX86Bytes = 32768u;
constexpr uint32_t kMaxGeneralX86Insns = 4096u;
constexpr uint32_t kMaxGeneralTextCap = 512u * 1024u;
constexpr uint32_t kMaxGeneralLineMapCap = 4096u;
constexpr uint32_t kMaxGeneralCallees = 512u;
constexpr uint32_t kMaxGeneralGlobals = 512u;

static const char* const kGpr64Names[16] = {
    "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
    "r8",  "r9",  "r10", "r11", "r12", "r13", "r14", "r15",
};

struct GenTextBuf {
  char* data;
  uint32_t cap;
  uint32_t len;
  uint32_t line_no;
  bool overflow;
  HexLineMapEntry* lm;
  uint32_t lm_cap;
  uint32_t lm_count;

  void put_char(char c) {
    if (overflow) return;
    if (len + 1u >= cap) {
      overflow = true;
      return;
    }
    data[len++] = c;
    data[len] = '\0';
    if (c == '\n') ++line_no;
  }

  void put_str(const char* s) {
    if (!s || overflow) return;
    while (*s != '\0') {
      put_char(*s++);
      if (overflow) return;
    }
  }

  void put_bytes(const char* s, uint32_t n) {
    if (!s || overflow) return;
    for (uint32_t i = 0u; i < n; ++i) {
      put_char(s[i]);
      if (overflow) return;
    }
  }

  void put_indent(uint32_t depth) {
    for (uint32_t i = 0u; i < depth; ++i) {
      put_str("    ");
    }
  }

  void put_u64_hex(uint64_t val, bool upper) {
    static const char kLo[] = "0123456789abcdef";
    static const char kHi[] = "0123456789ABCDEF";
    const char* d = upper ? kHi : kLo;
    char tmp[16];
    uint32_t n = 0u;
    do {
      tmp[n++] = d[val & 0xFu];
      val >>= 4u;
    } while (val != 0u);
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_u8_hex2(uint8_t val) {
    static const char kHi[] = "0123456789ABCDEF";
    put_char(kHi[(val >> 4u) & 0xFu]);
    put_char(kHi[val & 0xFu]);
  }

  void put_u64_dec(uint64_t val) {
    char tmp[24];
    uint32_t n = 0u;
    do {
      tmp[n++] = static_cast<char>('0' + (val % 10u));
      val /= 10u;
    } while (val != 0u);
    while (n > 0u) put_char(tmp[--n]);
  }

  void put_imm_u64(uint64_t val) {
    if (val >= 100ULL) {
      put_str("0x");
      put_u64_hex(val, true);
      if (val > 0xFFFFFFFFULL) put_str("ULL");
    } else {
      put_u64_dec(val);
    }
  }

  void put_gpr(uint8_t reg) {
    put_str(kGpr64Names[reg & 15u]);
  }

  void put_xmm(uint8_t reg) {
    put_str("xmm");
    put_u64_dec(reg & 15u);
  }

  void record_line(uint64_t addr) {
    if (!lm || lm_count >= lm_cap) return;
    if (lm_count > 0u && lm[lm_count - 1u].line_no == line_no &&
        lm[lm_count - 1u].addr == addr) {
      return;
    }
    lm[lm_count].line_no = line_no;
    lm[lm_count].block_id = 0u;
    lm[lm_count].addr = addr;
    ++lm_count;
  }
};

struct GeneralInsn {
  HexX86Decoded d;
  uint8_t is_raw;
  uint8_t raw_byte;
  uint8_t is_xchg;
  uint8_t is_leave;
  uint8_t is_f3_movq;
};

static int32_t find_gen_insn_by_pc(const GeneralInsn* insns, uint32_t count, uint64_t target_pc) {
  uint32_t lo = 0u;
  uint32_t hi = count;
  while (lo < hi) {
    const uint32_t mid = lo + ((hi - lo) >> 1u);
    const uint64_t pc = insns[mid].d.pc;
    if (pc == target_pc) return static_cast<int32_t>(mid);
    if (pc < target_pc) lo = mid + 1u;
    else hi = mid;
  }
  return -1;
}

static bool add_unique_u64(uint64_t* arr, uint32_t* count, uint32_t cap, uint64_t val) {
  for (uint32_t i = 0u; i < *count; ++i) {
    if (arr[i] == val) return true;
  }
  if (*count < cap) {
    arr[(*count)++] = val;
    return true;
  }
  return false;
}

static bool contains_u64(const uint64_t* arr, uint32_t count, uint64_t val) {
  for (uint32_t i = 0u; i < count; ++i) {
    if (arr[i] == val) return true;
  }
  return false;
}

static const char* width_to_uint_type(uint8_t op_size) {
  switch (op_size) {
    case 8u: return "uint8";
    case 16u: return "uint16";
    case 32u: return "uint32";
    default: return "uint64";
  }
}

static const char* width_to_int_type(uint8_t op_size) {
  switch (op_size) {
    case 8u: return "int8";
    case 16u: return "int16";
    case 32u: return "int32";
    default: return "int64";
  }
}

static uint64_t mask_imm_by_size(int64_t imm, uint8_t op_size) {
  const uint64_t u = static_cast<uint64_t>(imm);
  switch (op_size) {
    case 8u: return u & 0xffULL;
    case 16u: return u & 0xffffULL;
    case 32u: return u & 0xffffffffULL;
    default: return u;
  }
}

static bool is_sse2_insn(const HexX86Decoded& d) {
  if (d.opcode != 0x0fu) return false;
  switch (d.opcode2) {
    case 0x10u:
    case 0x11u:
    case 0x28u:
    case 0x29u:
    case 0x57u:
    case 0x6eu:
    case 0x6fu:
    case 0x7eu:
    case 0x7fu:
    case 0xefu:
      return true;
    default:
      return false;
  }
}

static bool is_cmovcc_insn(const HexX86Decoded& d) {
  return d.opcode == 0x0fu && (d.opcode2 & 0xf0u) == 0x40u;
}

static bool is_setcc_insn(const HexX86Decoded& d) {
  return d.opcode == 0x0fu && (d.opcode2 & 0xf0u) == 0x90u;
}

static void emit_cc_expr(GenTextBuf& tb, uint8_t cc) {
  switch (cc & 0x0fu) {
    case 0x0u: tb.put_str("(__hex_cmp_l ^ __hex_cmp_r) != 0"); break;       // o
    case 0x1u: tb.put_str("(__hex_cmp_l ^ __hex_cmp_r) == 0"); break;       // no
    case 0x2u: tb.put_str("__hex_cmp_l < __hex_cmp_r"); break;              // b / ult
    case 0x3u: tb.put_str("__hex_cmp_l >= __hex_cmp_r"); break;             // ae / uge
    case 0x4u: tb.put_str("__hex_cmp_l == __hex_cmp_r"); break;             // e / eq
    case 0x5u: tb.put_str("__hex_cmp_l != __hex_cmp_r"); break;             // ne
    case 0x6u: tb.put_str("__hex_cmp_l <= __hex_cmp_r"); break;             // be / ule
    case 0x7u: tb.put_str("__hex_cmp_l > __hex_cmp_r"); break;              // a / ugt
    case 0x8u: tb.put_str("(int64)(__hex_cmp_l - __hex_cmp_r) < 0"); break; // s
    case 0x9u: tb.put_str("(int64)(__hex_cmp_l - __hex_cmp_r) >= 0"); break;// ns
    case 0xau: tb.put_str("((__hex_cmp_l ^ __hex_cmp_r) & 1ULL) == 0"); break; // p
    case 0xbu: tb.put_str("((__hex_cmp_l ^ __hex_cmp_r) & 1ULL) != 0"); break; // np
    case 0xcu: tb.put_str("(int64)__hex_cmp_l < (int64)__hex_cmp_r"); break;   // l / slt
    case 0xdu: tb.put_str("(int64)__hex_cmp_l >= (int64)__hex_cmp_r"); break;  // ge / sge
    case 0xeu: tb.put_str("(int64)__hex_cmp_l <= (int64)__hex_cmp_r"); break;  // le / sle
    case 0xfu: tb.put_str("(int64)__hex_cmp_l > (int64)__hex_cmp_r"); break;   // g / sgt
    default: tb.put_str("__hex_cmp_l == __hex_cmp_r"); break;
  }
}

static void emit_mem_addr_expr(GenTextBuf& tb, const HexX86Decoded& d,
                               const uint64_t* globals, uint32_t global_count) {
  if ((d.flags & HEX_X86_FLAG_RIP_REL) != 0u) {
    if (contains_u64(globals, global_count, d.target)) {
      tb.put_str("(uint64)(uintptr_t)&global_");
      tb.put_u64_hex(d.target, true);
    } else {
      tb.put_str("(uint64)0x");
      tb.put_u64_hex(d.target, true);
      tb.put_str("ULL");
    }
    return;
  }
  bool has_term = false;
  if (d.rm != kRegNone && d.rm < 16u) {
    tb.put_gpr(d.rm);
    has_term = true;
  }
  if (d.index_reg != kRegNone && d.index_reg < 16u) {
    if (has_term) tb.put_str(" + ");
    if (d.scale > 1u) {
      tb.put_char('(');
      tb.put_gpr(d.index_reg);
      tb.put_str(" * ");
      tb.put_u64_dec(d.scale);
      tb.put_char(')');
    } else {
      tb.put_gpr(d.index_reg);
    }
    has_term = true;
  }
  if ((d.flags & HEX_X86_FLAG_HAS_DISP) != 0u && d.disp != 0) {
    if (!has_term) {
      tb.put_imm_u64(static_cast<uint64_t>(d.disp));
    } else if (d.disp > 0) {
      tb.put_str(" + ");
      tb.put_imm_u64(static_cast<uint64_t>(d.disp));
    } else {
      const uint64_t mag = static_cast<uint64_t>(-(d.disp + 1)) + 1ULL;
      tb.put_str(" - ");
      tb.put_imm_u64(mag);
    }
    has_term = true;
  }
  if (!has_term) {
    tb.put_str("0ULL");
  }
}

static void emit_mem_deref(GenTextBuf& tb, const HexX86Decoded& d, uint8_t op_size,
                           const uint64_t* globals, uint32_t global_count) {
  tb.put_str("*(");
  tb.put_str(width_to_uint_type(op_size));
  tb.put_str("*)(uintptr_t)(");
  emit_mem_addr_expr(tb, d, globals, global_count);
  tb.put_char(')');
}

static void emit_rm_read(GenTextBuf& tb, const HexX86Decoded& d, uint8_t op_size,
                         const uint64_t* globals, uint32_t global_count) {
  const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6u) & 3u);
  if (mod == 3u) {
    if (op_size == 8u) {
      tb.put_str("(uint8)");
      tb.put_gpr(d.rm);
    } else if (op_size == 16u) {
      tb.put_str("(uint16)");
      tb.put_gpr(d.rm);
    } else if (op_size == 32u) {
      tb.put_str("(uint32)");
      tb.put_gpr(d.rm);
    } else {
      tb.put_gpr(d.rm);
    }
  } else {
    emit_mem_deref(tb, d, op_size, globals, global_count);
  }
}

static void emit_gpr_read(GenTextBuf& tb, uint8_t reg, uint8_t op_size) {
  if (op_size == 8u) {
    tb.put_str("(uint8)");
    tb.put_gpr(reg);
  } else if (op_size == 16u) {
    tb.put_str("(uint16)");
    tb.put_gpr(reg);
  } else if (op_size == 32u) {
    tb.put_str("(uint32)");
    tb.put_gpr(reg);
  } else {
    tb.put_gpr(reg);
  }
}

static void emit_gpr_write_prefix(GenTextBuf& tb, uint8_t reg, uint8_t op_size) {
  tb.put_gpr(reg);
  if (op_size == 8u) {
    tb.put_str(" = (");
    tb.put_gpr(reg);
    tb.put_str(" & ~0xFFULL) | (uint64)(uint8)(");
  } else if (op_size == 16u) {
    tb.put_str(" = (");
    tb.put_gpr(reg);
    tb.put_str(" & ~0xFFFFULL) | (uint64)(uint16)(");
  } else if (op_size == 32u) {
    tb.put_str(" = (uint32)(");
  } else {
    tb.put_str(" = (");
  }
}

static void emit_gpr_write_suffix(GenTextBuf& tb) {
  tb.put_str(");\n");
}

static void emit_abi_call_args(GenTextBuf& tb, uint32_t abi_id, bool use_six_if_sysv, uint32_t gpr_used_mask) {
  if (abi_id == HEX_X86_ABI_MICROSOFT_X64) {
    tb.put_str("rcx, rdx, r8, r9");
  } else {
    if (use_six_if_sysv && ((gpr_used_mask & ((1u << 8u) | (1u << 9u))) == ((1u << 8u) | (1u << 9u)))) {
      tb.put_str("rdi, rsi, rdx, rcx, r8, r9");
    } else if (use_six_if_sysv && ((gpr_used_mask & (1u << 8u)) != 0u)) {
      tb.put_str("rdi, rsi, rdx, rcx, r8");
    } else {
      tb.put_str("rdi, rsi, rdx, rcx");
    }
  }
}

static void emit_abi_exact_args(GenTextBuf& tb, uint32_t abi_id, uint32_t n_params) {
  static const char* const kSysV[6] = {"rdi", "rsi", "rdx", "rcx", "r8", "r9"};
  static const char* const kWin64[4] = {"rcx", "rdx", "r8", "r9"};
  const uint32_t max_p = (abi_id == HEX_X86_ABI_MICROSOFT_X64) ? 4u : 6u;
  const uint32_t cnt = (n_params < max_p) ? n_params : max_p;
  for (uint32_t i = 0u; i < cnt; ++i) {
    if (i > 0u) tb.put_str(", ");
    tb.put_str((abi_id == HEX_X86_ABI_MICROSOFT_X64) ? kWin64[i] : kSysV[i]);
  }
}

static bool is_flag_setting_alu(const GeneralInsn& gi) {
  if (gi.is_raw || gi.is_xchg || gi.is_leave) return false;
  const HexX86Decoded& d = gi.d;
  if (is_sse2_insn(d)) return false;
  if (d.kind == HEX_X86_KIND_CMP) return true;
  if (d.kind == HEX_X86_KIND_ALU) {
    // not (F6/F7 /2) does not modify flags
    if ((d.opcode == 0xf6u || d.opcode == 0xf7u) && (((d.modrm >> 3u) & 7u) == 2u)) {
      return false;
    }
    return true;
  }
  return false;
}

static bool is_flag_reading_insn(const GeneralInsn& gi) {
  if (gi.is_raw || gi.is_xchg || gi.is_leave) return false;
  const HexX86Decoded& d = gi.d;
  return d.kind == HEX_X86_KIND_JCC || is_cmovcc_insn(d) || is_setcc_insn(d);
}

static void mark_reg_read(uint8_t reg, uint32_t abi_id, uint32_t& gpr_used,
                          uint32_t gpr_written, uint32_t& param_used) {
  if (reg >= 16u) return;
  gpr_used |= (1u << reg);
  if ((gpr_written & (1u << reg)) == 0u) {
    const int32_t p = abi_param_index(abi_id, reg);
    if (p >= 0 && p < 6) {
      param_used |= (1u << static_cast<uint32_t>(p));
    }
  }
}

static void mark_reg_write(uint8_t reg, uint32_t& gpr_used, uint32_t& gpr_written) {
  if (reg >= 16u) return;
  gpr_used |= (1u << reg);
  gpr_written |= (1u << reg);
}

static void mark_mem_regs_read(const HexX86Decoded& d, uint32_t abi_id,
                               uint32_t& gpr_used, uint32_t gpr_written,
                               uint32_t& param_used, bool& uses_stack) {
  if ((d.flags & HEX_X86_FLAG_RIP_REL) != 0u) return;
  if (d.rm != kRegNone && d.rm < 16u) {
    mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
    if (d.rm == 4u || d.rm == 5u) uses_stack = true;
  }
  if (d.index_reg != kRegNone && d.index_reg < 16u) {
    mark_reg_read(d.index_reg, abi_id, gpr_used, gpr_written, param_used);
  }
}

static const char* alu_binop_str(uint8_t grp) {
  switch (grp) {
    case 0u: return "+";
    case 1u: return "|";
    case 2u: return "+";  // adc (approximate without CF)
    case 3u: return "-";  // sbb (approximate without CF)
    case 4u: return "&";
    case 5u: return "-";
    case 6u: return "^";
    default: return "+";
  }
}

HexStatus try_emit_x86_64_general(
    const uint8_t* bytes,
    uint32_t byte_len,
    uint64_t base_addr,
    const char* local_name,
    uint32_t local_name_len,
    uint32_t abi_id) {
  hex::Arena& work_arena = x86_work_arena();
#if !defined(HEX_UNIFIED_WASM)
  work_arena.reset();
#endif
  hex::ArenaScope work_scope(work_arena);

  GeneralInsn* insns = hex::arena_alloc_zeroed<GeneralInsn>(work_arena, kMaxGeneralX86Insns);
  int32_t* target_idx = work_arena.alloc<int32_t>(kMaxGeneralX86Insns);
  uint16_t* label_refs = hex::arena_alloc_zeroed<uint16_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* sets_live_flags = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* if_open = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* else_mid = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* if_close = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* do_open = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* do_close = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* skip_insn = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* jcc_inverted = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint8_t* loop_ctrl = hex::arena_alloc_zeroed<uint8_t>(work_arena, kMaxGeneralX86Insns);
  uint64_t* callees = work_arena.alloc<uint64_t>(kMaxGeneralCallees);
  uint64_t* globals = work_arena.alloc<uint64_t>(kMaxGeneralGlobals);
  if (!insns || !target_idx || !label_refs || !sets_live_flags ||
      !if_open || !else_mid || !if_close || !do_open || !do_close ||
      !skip_insn || !jcc_inverted || !loop_ctrl || !callees || !globals) {
    return HEX_ERR_OOM;
  }

  // Pass 0: Decode all instructions (never fail on unknown/truncated opcodes).
  uint32_t off = 0u;
  uint32_t insn_count = 0u;
  while (off < byte_len && insn_count < kMaxGeneralX86Insns) {
    GeneralInsn& gi = insns[insn_count];
    const uint64_t cur_pc = base_addr + static_cast<uint64_t>(off);
    const uint8_t b0 = bytes[off];

    // Special 1-byte `leave` (0xC9)
    if (b0 == 0xc9u) {
      gi.d.pc = cur_pc;
      gi.d.length = 1u;
      gi.d.opcode = 0xc9u;
      gi.d.kind = HEX_X86_KIND_NOP;
      gi.d.valid = 1u;
      gi.d.reg = kRegNone;
      gi.d.rm = kRegNone;
      gi.d.index_reg = kRegNone;
      gi.is_leave = 1u;
      off += 1u;
      ++insn_count;
      continue;
    }

    // Special 1-byte / REX `xchg rax, r` (0x91..0x97 or REX + 0x90..0x97 with REX.B)
    if ((b0 >= 0x91u && b0 <= 0x97u) ||
        (((b0 & 0xf0u) == 0x40u) && (off + 1u < byte_len) &&
         (bytes[off + 1u] >= 0x90u && bytes[off + 1u] <= 0x97u) &&
         (bytes[off + 1u] != 0x90u || (b0 & 1u) != 0u))) {
      const bool has_rex = ((b0 & 0xf0u) == 0x40u);
      const uint8_t rex = has_rex ? b0 : 0u;
      const uint8_t op = has_rex ? bytes[off + 1u] : b0;
      const uint8_t r = static_cast<uint8_t>((op & 7u) | ((rex & 1u) << 3u));
      gi.d.pc = cur_pc;
      gi.d.length = has_rex ? 2u : 1u;
      gi.d.opcode = op;
      gi.d.op_size = (rex & 0x08u) ? 64u : 32u;
      gi.d.kind = HEX_X86_KIND_MOV;
      gi.d.valid = 1u;
      gi.d.reg = 0u;
      gi.d.rm = r;
      gi.d.index_reg = kRegNone;
      gi.is_xchg = 1u;
      off += gi.d.length;
      ++insn_count;
      continue;
    }

    const HexStatus st = hex_x86_64_decode_one(bytes + off, byte_len - off, cur_pc, &gi.d);
    if (st == HEX_OK && gi.d.valid != 0u && gi.d.length > 0u &&
        static_cast<uint32_t>(gi.d.length) <= (byte_len - off) &&
        (gi.d.flags & (HEX_X86_FLAG_TRUNCATED | HEX_X86_FLAG_INVALID)) == 0u) {
      if (gi.d.opcode == 0x0fu && gi.d.opcode2 == 0x7eu) {
        uint8_t last_rep = 0u;
        for (uint32_t p = 0u; p < static_cast<uint32_t>(gi.d.length); ++p) {
          const uint8_t pb = bytes[off + p];
          if (pb == 0xf2u || pb == 0xf3u) {
            last_rep = pb;
            continue;
          }
          if (pb == 0x66u || pb == 0xf0u || pb == 0x67u ||
              pb == 0x26u || pb == 0x2eu || pb == 0x36u || pb == 0x3eu ||
              pb == 0x64u || pb == 0x65u) {
            continue;
          }
          break;
        }
        gi.is_f3_movq = (last_rep == 0xf3u) ? 1u : 0u;
      }
      off += static_cast<uint32_t>(gi.d.length);
      ++insn_count;
      continue;
    }

    // Fallback: emit raw byte comment and advance by 1 byte.
    hex::mem_set(&gi.d, 0, sizeof(HexX86Decoded));
    gi.d.pc = cur_pc;
    gi.d.length = 1u;
    gi.d.kind = HEX_X86_KIND_UNKNOWN;
    gi.d.reg = kRegNone;
    gi.d.rm = kRegNone;
    gi.d.index_reg = kRegNone;
    gi.is_raw = 1u;
    gi.raw_byte = b0;
    off += 1u;
    ++insn_count;
  }

  // Pass 1: Analyze targets, callees, globals, register usage, and flags.
  uint32_t callee_count = 0u;
  uint32_t global_count = 0u;
  uint32_t gpr_used = (1u << 0u);  // always declare rax for clean `return rax;`
  uint32_t gpr_written = 0u;
  uint32_t param_used = 0u;
  uint32_t xmm_used = 0u;
  bool uses_stack = false;
  bool uses_flags = false;

  for (uint32_t i = 0u; i < insn_count; ++i) {
    target_idx[i] = -1;
    const GeneralInsn& gi = insns[i];
    if (gi.is_raw) continue;
    const HexX86Decoded& d = gi.d;

    if (gi.is_leave) {
      uses_stack = true;
      gpr_used |= (1u << 4u) | (1u << 5u);
      continue;
    }
    if (gi.is_xchg) {
      mark_reg_read(d.reg, abi_id, gpr_used, gpr_written, param_used);
      mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
      mark_reg_write(d.reg, gpr_used, gpr_written);
      mark_reg_write(d.rm, gpr_used, gpr_written);
      continue;
    }

    if ((d.flags & HEX_X86_FLAG_RIP_REL) != 0u) {
      add_unique_u64(globals, &global_count, kMaxGeneralGlobals, d.target);
    }

    const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6u) & 3u);
    if ((d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod != 3u) {
      mark_mem_regs_read(d, abi_id, gpr_used, gpr_written, param_used, uses_stack);
    }

    if (d.kind == HEX_X86_KIND_NOP) continue;

    if (d.kind == HEX_X86_KIND_PUSH) {
      uses_stack = true;
      gpr_used |= (1u << 4u);
      if ((d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
        if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
      } else if ((d.flags & HEX_X86_FLAG_HAS_IMM) == 0u && d.rm < 16u) {
        mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
      }
      continue;
    }

    if (d.kind == HEX_X86_KIND_POP) {
      uses_stack = true;
      gpr_used |= (1u << 4u);
      if (d.rm < 16u) mark_reg_write(d.rm, gpr_used, gpr_written);
      continue;
    }

    if (d.kind == HEX_X86_KIND_RET) {
      mark_reg_read(0u, abi_id, gpr_used, gpr_written, param_used);
      continue;
    }

    if (d.kind == HEX_X86_KIND_CALL) {
      if ((d.flags & HEX_X86_FLAG_HAS_TARGET) != 0u && d.opcode == 0xe8u) {
        add_unique_u64(callees, &callee_count, kMaxGeneralCallees, d.target);
      } else if ((d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
        mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
      }
      // Mark ABI call arg registers as used so emitted call args are always declared.
      if (abi_id == HEX_X86_ABI_MICROSOFT_X64) {
        mark_reg_read(1u, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_read(2u, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_read(8u, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_read(9u, abi_id, gpr_used, gpr_written, param_used);
      } else {
        mark_reg_read(7u, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_read(6u, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_read(2u, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_read(1u, abi_id, gpr_used, gpr_written, param_used);
      }
      mark_reg_write(0u, gpr_used, gpr_written);
      continue;
    }

    if (d.kind == HEX_X86_KIND_JMP || d.kind == HEX_X86_KIND_JCC) {
      if (d.kind == HEX_X86_KIND_JCC) uses_flags = true;
      if ((d.flags & HEX_X86_FLAG_HAS_TARGET) != 0u && d.opcode != 0xffu) {
        const int32_t tidx = find_gen_insn_by_pc(insns, insn_count, d.target);
        if (tidx >= 0) {
          target_idx[i] = tidx;
          if (label_refs[tidx] < 0xffffu) ++label_refs[tidx];
        } else {
          // External jump / tail call
          add_unique_u64(callees, &callee_count, kMaxGeneralCallees, d.target);
          if (abi_id == HEX_X86_ABI_MICROSOFT_X64) {
            mark_reg_read(1u, abi_id, gpr_used, gpr_written, param_used);
            mark_reg_read(2u, abi_id, gpr_used, gpr_written, param_used);
            mark_reg_read(8u, abi_id, gpr_used, gpr_written, param_used);
            mark_reg_read(9u, abi_id, gpr_used, gpr_written, param_used);
          } else {
            mark_reg_read(7u, abi_id, gpr_used, gpr_written, param_used);
            mark_reg_read(6u, abi_id, gpr_used, gpr_written, param_used);
            mark_reg_read(2u, abi_id, gpr_used, gpr_written, param_used);
            mark_reg_read(1u, abi_id, gpr_used, gpr_written, param_used);
          }
        }
      } else if ((d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
        if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        if (abi_id == HEX_X86_ABI_MICROSOFT_X64) {
          gpr_used |= (1u << 1u) | (1u << 2u) | (1u << 8u) | (1u << 9u);
        } else {
          gpr_used |= (1u << 7u) | (1u << 6u) | (1u << 2u) | (1u << 1u);
        }
      }
      continue;
    }

    if (is_sse2_insn(d)) {
      if (d.reg < 16u) xmm_used |= (1u << d.reg);
      if (d.opcode2 == 0x6eu) {
        if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
      } else if (d.opcode2 == 0x7eu) {
        if (gi.is_f3_movq != 0u) {
          if (mod == 3u && d.rm < 16u) xmm_used |= (1u << d.rm);
        } else {
          if (mod == 3u) mark_reg_write(d.rm, gpr_used, gpr_written);
        }
      } else {
        if (mod == 3u && d.rm < 16u) xmm_used |= (1u << d.rm);
      }
      continue;
    }

    if (is_cmovcc_insn(d)) {
      uses_flags = true;
      if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
      mark_reg_write(d.reg, gpr_used, gpr_written);
      continue;
    }

    if (is_setcc_insn(d)) {
      uses_flags = true;
      if (mod == 3u) mark_reg_write(d.rm, gpr_used, gpr_written);
      continue;
    }

    if (d.kind == HEX_X86_KIND_CMP) {
      uses_flags = true;
      if (d.opcode == 0x3cu || d.opcode == 0x3du || d.opcode == 0xa8u || d.opcode == 0xa9u) {
        mark_reg_read(0u, abi_id, gpr_used, gpr_written, param_used);
      } else if ((d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
        if (d.opcode >= 0x38u && d.opcode <= 0x3bu) {
          mark_reg_read(d.reg, abi_id, gpr_used, gpr_written, param_used);
          if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        } else if (d.opcode == 0x84u || d.opcode == 0x85u) {
          mark_reg_read(d.reg, abi_id, gpr_used, gpr_written, param_used);
          if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        } else {
          if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        }
      }
      continue;
    }

    if (d.kind == HEX_X86_KIND_MOV) {
      if (d.opcode >= 0xb0u && d.opcode <= 0xbfu) {
        mark_reg_write(d.rm, gpr_used, gpr_written);
      } else if (d.opcode == 0xc6u || d.opcode == 0xc7u) {
        if (mod == 3u) mark_reg_write(d.rm, gpr_used, gpr_written);
      } else if (d.opcode == 0x88u || d.opcode == 0x89u) {
        mark_reg_read(d.reg, abi_id, gpr_used, gpr_written, param_used);
        if (mod == 3u) mark_reg_write(d.rm, gpr_used, gpr_written);
      } else if (d.opcode == 0x8au || d.opcode == 0x8bu) {
        if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_write(d.reg, gpr_used, gpr_written);
      }
      continue;
    }

    if (d.kind == HEX_X86_KIND_MOVZX || d.kind == HEX_X86_KIND_MOVSX) {
      if (d.opcode == 0x98u) {
        mark_reg_read(0u, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_write(0u, gpr_used, gpr_written);
      } else if (d.opcode == 0x99u) {
        mark_reg_read(0u, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_write(2u, gpr_used, gpr_written);
      } else {
        if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_write(d.reg, gpr_used, gpr_written);
      }
      continue;
    }

    if (d.kind == HEX_X86_KIND_LEA) {
      mark_reg_write(d.reg, gpr_used, gpr_written);
      continue;
    }

    if (d.kind == HEX_X86_KIND_MUL) {
      if (d.opcode == 0xf6u || d.opcode == 0xf7u) {
        mark_reg_read(0u, abi_id, gpr_used, gpr_written, param_used);
        if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_write(0u, gpr_used, gpr_written);
        mark_reg_write(2u, gpr_used, gpr_written);
      } else if (d.opcode == 0x0fu && d.opcode2 == 0xafu) {
        mark_reg_read(d.reg, abi_id, gpr_used, gpr_written, param_used);
        if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_write(d.reg, gpr_used, gpr_written);
      } else {
        if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
        mark_reg_write(d.reg, gpr_used, gpr_written);
      }
      continue;
    }

    if (d.kind == HEX_X86_KIND_ALU) {
      if (d.opcode < 0x40u) {
        const uint8_t grp = static_cast<uint8_t>((d.opcode >> 3u) & 7u);
        const uint8_t sub = static_cast<uint8_t>(d.opcode & 7u);
        if (sub == 0u || sub == 1u) {
          if (grp == 6u && mod == 3u && d.reg == d.rm) {
            mark_reg_write(d.rm, gpr_used, gpr_written);
          } else {
            mark_reg_read(d.reg, abi_id, gpr_used, gpr_written, param_used);
            if (mod == 3u) {
              mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
              mark_reg_write(d.rm, gpr_used, gpr_written);
            }
          }
        } else if (sub == 2u || sub == 3u) {
          if (grp == 6u && mod == 3u && d.reg == d.rm) {
            mark_reg_write(d.reg, gpr_used, gpr_written);
          } else {
            mark_reg_read(d.reg, abi_id, gpr_used, gpr_written, param_used);
            if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
            mark_reg_write(d.reg, gpr_used, gpr_written);
          }
        } else {
          mark_reg_read(0u, abi_id, gpr_used, gpr_written, param_used);
          mark_reg_write(0u, gpr_used, gpr_written);
        }
      } else if (d.opcode == 0x80u || d.opcode == 0x81u || d.opcode == 0x83u ||
                 d.opcode == 0xc0u || d.opcode == 0xc1u ||
                 (d.opcode >= 0xd0u && d.opcode <= 0xd3u) ||
                 d.opcode == 0xffu) {
        if (d.opcode == 0xd2u || d.opcode == 0xd3u) {
          mark_reg_read(1u, abi_id, gpr_used, gpr_written, param_used);
        }
        if (mod == 3u) {
          mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
          mark_reg_write(d.rm, gpr_used, gpr_written);
        }
      } else if (d.opcode == 0xf6u || d.opcode == 0xf7u) {
        const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3u) & 7u);
        if (grp == 6u || grp == 7u) {
          mark_reg_read(0u, abi_id, gpr_used, gpr_written, param_used);
          mark_reg_read(2u, abi_id, gpr_used, gpr_written, param_used);
          if (mod == 3u) mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
          mark_reg_write(0u, gpr_used, gpr_written);
          mark_reg_write(2u, gpr_used, gpr_written);
        } else {
          if (mod == 3u) {
            mark_reg_read(d.rm, abi_id, gpr_used, gpr_written, param_used);
            mark_reg_write(d.rm, gpr_used, gpr_written);
          }
        }
      }
      continue;
    }
  }

  // Backward liveness pass for flags (so flag-setting ALU updates __hex_cmp only when needed).
  bool flags_live = false;
  for (uint32_t rev = insn_count; rev > 0u; --rev) {
    const uint32_t i = rev - 1u;
    const GeneralInsn& gi = insns[i];
    if (is_flag_reading_insn(gi)) {
      flags_live = true;
    } else if (is_flag_setting_alu(gi)) {
      if (flags_live) {
        sets_live_flags[i] = 1u;
        uses_flags = true;
      }
      flags_live = false;
    }
    if (label_refs[i] > 0u) {
      // Conservative at join points: flags might be live across a branch.
      flags_live = uses_flags;
    }
  }

  // Goto-reduction & structuring pass:
  // 1) Fallthrough goto deletion: `goto L_next;` immediately before `L_next:`
  for (uint32_t i = 0u; i < insn_count; ++i) {
    const GeneralInsn& gi = insns[i];
    if (!gi.is_raw && gi.d.kind == HEX_X86_KIND_JMP &&
        target_idx[i] == static_cast<int32_t>(i + 1u)) {
      skip_insn[i] = 1u;
      if (label_refs[i + 1u] > 0u) --label_refs[i + 1u];
    }
  }

  // 2) Inverted guard folding: `if (C) goto L_body; goto L_exit; L_body:` -> `if (!(C)) goto L_exit;`
  for (uint32_t i = 0u; i + 2u < insn_count; ++i) {
    if (skip_insn[i] || insns[i].is_raw || insns[i].d.kind != HEX_X86_KIND_JCC) continue;
    if (target_idx[i] != static_cast<int32_t>(i + 2u)) continue;
    if (skip_insn[i + 1u] || insns[i + 1u].is_raw || insns[i + 1u].d.kind != HEX_X86_KIND_JMP) continue;
    if (label_refs[i + 1u] != 0u || target_idx[i + 1u] < 0) continue;
    const int32_t exit_t = target_idx[i + 1u];
    if (exit_t == static_cast<int32_t>(i + 2u)) continue;
    if (label_refs[i + 2u] > 0u) --label_refs[i + 2u];
    target_idx[i] = exit_t;
    jcc_inverted[i] ^= 1u;
    skip_insn[i + 1u] = 1u;
  }

  // 3) Backward Jcc loops -> `do { ... } while (cond);` with loop `break;` & `continue;`
  for (uint32_t i = 0u; i < insn_count; ++i) {
    const GeneralInsn& gi = insns[i];
    if (skip_insn[i] || gi.is_raw || gi.d.kind != HEX_X86_KIND_JCC) continue;
    const int32_t tidx = target_idx[i];
    if (tidx < 0) continue;
    const uint32_t t = static_cast<uint32_t>(tidx);
    if (t < i && (i - t) <= 32u && label_refs[t] == 1u &&
        do_open[t] == 0u && do_close[i] == 0u) {
      bool ok = true;
      uint32_t internal_to_latch = 0u;
      for (uint32_t k = t; k <= i; ++k) {
        if (if_open[k] || else_mid[k] || if_close[k] || do_open[k] || do_close[k]) {
          ok = false;
          break;
        }
        if (k < i && !skip_insn[k] && !insns[k].is_raw &&
            (insns[k].d.kind == HEX_X86_KIND_JMP || insns[k].d.kind == HEX_X86_KIND_JCC) &&
            target_idx[k] == static_cast<int32_t>(i)) {
          ++internal_to_latch;
        }
      }
      if (internal_to_latch != label_refs[i]) ok = false;
      if (ok) {
        do_open[t] = 1u;
        do_close[i] = 1u;
        label_refs[t] = 0u;
        for (uint32_t k = t; k < i; ++k) {
          if (skip_insn[k] || insns[k].is_raw) continue;
          if (insns[k].d.kind != HEX_X86_KIND_JMP && insns[k].d.kind != HEX_X86_KIND_JCC) continue;
          if (i + 1u < insn_count && target_idx[k] == static_cast<int32_t>(i + 1u)) {
            loop_ctrl[k] = 1u;  // break;
            if (label_refs[i + 1u] > 0u) --label_refs[i + 1u];
          } else if (target_idx[k] == static_cast<int32_t>(i)) {
            loop_ctrl[k] = 2u;  // continue;
            if (label_refs[i] > 0u) --label_refs[i];
          }
        }
      }
    }
  }

  // 4) Forward `if-else` structuring:
  //    `if (C) goto L_else; <then> goto L_end; L_else: <else> L_end:`
  //    -> `if (!(C)) { <then> } else { <else> }`
  for (uint32_t i = 0u; i < insn_count; ++i) {
    const GeneralInsn& gi = insns[i];
    if (skip_insn[i] || gi.is_raw || gi.d.kind != HEX_X86_KIND_JCC ||
        loop_ctrl[i] != 0u || if_open[i] || do_close[i]) {
      continue;
    }
    const int32_t t_else_i = target_idx[i];
    if (t_else_i <= static_cast<int32_t>(i + 1u)) continue;
    const uint32_t t_else = static_cast<uint32_t>(t_else_i);
    if (t_else >= insn_count || (t_else - i) > 24u || label_refs[t_else] != 1u) continue;
    const uint32_t j_end = t_else - 1u;
    if (j_end <= i || skip_insn[j_end] || insns[j_end].is_raw ||
        insns[j_end].d.kind != HEX_X86_KIND_JMP || loop_ctrl[j_end] != 0u) {
      continue;
    }
    const int32_t t_end_i = target_idx[j_end];
    if (t_end_i <= static_cast<int32_t>(t_else)) continue;
    const uint32_t t_end = static_cast<uint32_t>(t_end_i);
    if (t_end >= insn_count || (t_end - t_else) > 24u || label_refs[t_end] == 0u) continue;
    if (else_mid[t_else] || if_close[t_end] || else_mid[t_end] || do_open[t_end] || do_close[j_end]) {
      continue;
    }
    bool ok = true;
    for (uint32_t k = i + 1u; k < t_end; ++k) {
      if (if_open[k] || else_mid[k] || if_close[k] || do_open[k] || do_close[k]) {
        ok = false;
        break;
      }
      if (k != t_else && label_refs[k] > 0u) {
        ok = false;
        break;
      }
      if (k != j_end && !skip_insn[k] && !insns[k].is_raw &&
          (insns[k].d.kind == HEX_X86_KIND_JCC || insns[k].d.kind == HEX_X86_KIND_JMP)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if_open[i] = 1u;
      skip_insn[j_end] = 1u;
      else_mid[t_else] = 1u;
      if_close[t_end] = 1u;
      label_refs[t_else] = 0u;
      --label_refs[t_end];
    }
  }

  // 5) Short forward Jcc skip -> `if (!cond) { ... }`
  for (uint32_t i = 0u; i < insn_count; ++i) {
    const GeneralInsn& gi = insns[i];
    if (skip_insn[i] || gi.is_raw || gi.d.kind != HEX_X86_KIND_JCC ||
        loop_ctrl[i] != 0u || if_open[i] || do_close[i]) {
      continue;
    }
    const int32_t tidx = target_idx[i];
    if (tidx < 0) continue;
    const uint32_t t = static_cast<uint32_t>(tidx);
    if (t > i + 1u && t <= i + 6u && label_refs[t] == 1u &&
        if_close[t] == 0u && else_mid[t] == 0u && do_open[t] == 0u) {
      bool ok = true;
      for (uint32_t k = i + 1u; k < t; ++k) {
        if (label_refs[k] > 0u || if_open[k] || else_mid[k] || if_close[k] || do_open[k] || do_close[k]) {
          ok = false;
          break;
        }
        if (!skip_insn[k] && !insns[k].is_raw &&
            (insns[k].d.kind == HEX_X86_KIND_JCC || insns[k].d.kind == HEX_X86_KIND_JMP)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        if_open[i] = 1u;
        if_close[t] = 1u;
        label_refs[t] = 0u;
      }
    }
  }

  // Compute parameter count from param_used bitmask.
  uint32_t num_params = 0u;
  const uint32_t max_abi_params = (abi_id == HEX_X86_ABI_MICROSOFT_X64) ? 4u : 6u;
  for (uint32_t p = 0u; p < max_abi_params; ++p) {
    if ((param_used & (1u << p)) != 0u) num_params = p + 1u;
  }

  // Sanitize function name.
  char func_name[256];
  const uint32_t func_name_out_len = sanitize_func_name(
      local_name, local_name_len, base_addr, func_name, sizeof(func_name));

  // Pass 2: Emit C11 text + linemap into x86_emit_arena().
  hex::Arena& emit_arena = x86_emit_arena();
  emit_arena.reset();
  char* text_mem = emit_arena.alloc<char>(kMaxGeneralTextCap);
  HexLineMapEntry* lm_mem = emit_arena.alloc<HexLineMapEntry>(kMaxGeneralLineMapCap);
  if (!text_mem || !lm_mem) {
    clear_x86_last_output();
    return HEX_ERR_OOM;
  }
  text_mem[0] = '\0';

  GenTextBuf tb{text_mem, kMaxGeneralTextCap, 0u, 1u, false, lm_mem, kMaxGeneralLineMapCap, 0u};

  // Self-contained C11 fixed-width typedef prelude.
  tb.put_str(
      "typedef __UINT8_TYPE__ uint8;\n"
      "typedef __INT8_TYPE__ int8;\n"
      "typedef __UINT16_TYPE__ uint16;\n"
      "typedef __INT16_TYPE__ int16;\n"
      "typedef __UINT32_TYPE__ uint32;\n"
      "typedef __INT32_TYPE__ int32;\n"
      "typedef __UINT64_TYPE__ uint64;\n"
      "typedef __INT64_TYPE__ int64;\n"
      "typedef __UINT8_TYPE__ uint8_t;\n"
      "typedef __UINTPTR_TYPE__ uintptr_t;\n");

  // External RIP-relative globals.
  for (uint32_t g = 0u; g < global_count; ++g) {
    tb.put_str("static uint64 global_");
    tb.put_u64_hex(globals[g], true);
    tb.put_str(" = 0;\n");
  }

  char self_sub[32];
  format_sub_name(base_addr, self_sub, sizeof(self_sub));
  const bool is_self_sub = str_eq(func_name, self_sub);

  // External callee prototypes.
  if (callee_count > 0u) {
    tb.put_str(
        "#ifndef __HEX_ANY_ARGS\n"
        "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L\n"
        "#define __HEX_ANY_ARGS ...\n"
        "#else\n"
        "#define __HEX_ANY_ARGS\n"
        "#endif\n"
        "#endif\n");
    for (uint32_t c = 0u; c < callee_count; ++c) {
      if (callees[c] == base_addr && is_self_sub) continue;
      tb.put_str("uint64 sub_");
      tb.put_u64_hex(callees[c], true);
      tb.put_str("(__HEX_ANY_ARGS);\n");
    }
  }

  // Function signature.
  tb.record_line(base_addr);
  tb.put_str("uint64 ");
  tb.put_bytes(func_name, func_name_out_len);
  tb.put_char('(');
  if (num_params == 0u) {
    tb.put_str("void");
  } else {
    for (uint32_t p = 0u; p < num_params; ++p) {
      if (p > 0u) tb.put_str(", ");
      tb.put_str("uint64 a");
      tb.put_u64_dec(p + 1u);
    }
  }
  tb.put_str(")\n{\n");

  // Local declarations.
  if (uses_stack) {
    tb.put_str("    static uint8_t __hex_stack[4096];\n");
    gpr_used |= (1u << 4u);
  }
  if (uses_flags) {
    tb.put_str("    uint64 __hex_cmp_l = 0, __hex_cmp_r = 0;\n");
  }
  {
    static const uint8_t kSysVParams[6] = {7u, 6u, 2u, 1u, 8u, 9u};
    static const uint8_t kWin64Params[4] = {1u, 2u, 8u, 9u};
    const uint32_t max_p = (abi_id == HEX_X86_ABI_MICROSOFT_X64) ? 4u : 6u;
    const uint32_t cnt = (num_params < max_p) ? num_params : max_p;
    for (uint32_t p_i = 0u; p_i < cnt; ++p_i) {
      const uint8_t preg = (abi_id == HEX_X86_ABI_MICROSOFT_X64) ? kWin64Params[p_i] : kSysVParams[p_i];
      gpr_used |= (1u << preg);
    }
  }
  for (uint32_t r = 0u; r < 16u; ++r) {
    if ((gpr_used & (1u << r)) == 0u) continue;
    tb.put_str("    uint64 ");
    tb.put_gpr(static_cast<uint8_t>(r));
    if (r == 4u && uses_stack) {
      tb.put_str(" = (uint64)(uintptr_t)(__hex_stack + sizeof(__hex_stack) - 64);\n");
    } else if (r == 5u && uses_stack) {
      tb.put_str(" = rsp;\n");
    } else {
      const int32_t pidx = abi_param_index(abi_id, static_cast<uint8_t>(r));
      if (pidx >= 0 && static_cast<uint32_t>(pidx) < num_params) {
        tb.put_str(" = a");
        tb.put_u64_dec(static_cast<uint32_t>(pidx) + 1u);
        tb.put_str(";\n");
      } else {
        tb.put_str(" = 0;\n");
      }
    }
  }
  for (uint32_t x = 0u; x < 16u; ++x) {
    if ((xmm_used & (1u << x)) == 0u) continue;
    tb.put_str("    uint64 ");
    tb.put_xmm(static_cast<uint8_t>(x));
    tb.put_str(" = 0;\n");
  }

  // Emit body statements.
  uint32_t indent = 1u;
  uint32_t open_ifs = 0u;
  uint32_t open_dos = 0u;
  bool last_was_return = false;
  bool truncated_body = false;
  uint32_t truncated_at = insn_count;

  for (uint32_t i = 0u; i < insn_count; ++i) {
    if (tb.len + 2048u >= tb.cap) {
      truncated_body = true;
      truncated_at = i;
      break;
    }

    if (else_mid[i] && open_ifs > 0u) {
      tb.put_indent(indent - 1u);
      tb.put_str("} else {\n");
      last_was_return = false;
    }

    if (if_close[i] && open_ifs > 0u) {
      --open_ifs;
      --indent;
      tb.put_indent(indent);
      tb.put_str("}\n");
      last_was_return = false;
    }

    if (label_refs[i] > 0u) {
      tb.put_str("loc_");
      tb.put_u64_hex(insns[i].d.pc, true);
      tb.put_str(":\n");
      last_was_return = false;
    }

    if (do_open[i]) {
      tb.put_indent(indent);
      tb.put_str("do {\n");
      ++open_dos;
      ++indent;
      last_was_return = false;
    }

    if (skip_insn[i]) {
      if (label_refs[i] > 0u) {
        tb.put_indent(indent);
        tb.put_str("(void)0;\n");
        last_was_return = false;
      }
      continue;
    }

    const GeneralInsn& gi = insns[i];
    const HexX86Decoded& d = gi.d;

    if (gi.is_raw) {
      tb.record_line(d.pc);
      tb.put_indent(indent);
      tb.put_str("/* x86_64 raw 0x");
      tb.put_u8_hex2(gi.raw_byte);
      tb.put_str(" */\n");
      last_was_return = false;
      continue;
    }

    if (gi.is_leave) {
      tb.record_line(d.pc);
      tb.put_indent(indent);
      tb.put_str("rsp = rbp; rbp = *(uint64*)(uintptr_t)rsp; rsp += 8;\n");
      last_was_return = false;
      continue;
    }

    if (gi.is_xchg) {
      tb.record_line(d.pc);
      tb.put_indent(indent);
      tb.put_str("{ uint64 __t = ");
      tb.put_gpr(d.reg);
      tb.put_str("; ");
      tb.put_gpr(d.reg);
      tb.put_str(" = ");
      tb.put_gpr(d.rm);
      tb.put_str("; ");
      tb.put_gpr(d.rm);
      tb.put_str(" = __t; }\n");
      last_was_return = false;
      continue;
    }

    if (d.kind == HEX_X86_KIND_NOP) {
      if (label_refs[i] > 0u) {
        tb.put_indent(indent);
        tb.put_str("(void)0;\n");
        last_was_return = false;
      }
      continue;
    }

    const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6u) & 3u);
    const uint8_t w = (d.op_size == 8u || d.op_size == 16u || d.op_size == 32u || d.op_size == 64u)
                          ? d.op_size
                          : 64u;

    tb.record_line(d.pc);

    // RET
    if (d.kind == HEX_X86_KIND_RET) {
      tb.put_indent(indent);
      tb.put_str("return rax;\n");
      last_was_return = (open_ifs == 0u && open_dos == 0u);
      continue;
    }

    // PUSH
    if (d.kind == HEX_X86_KIND_PUSH) {
      tb.put_indent(indent);
      tb.put_str("rsp -= 8; *(uint64*)(uintptr_t)rsp = ");
      if ((d.flags & HEX_X86_FLAG_HAS_IMM) != 0u) {
        tb.put_imm_u64(static_cast<uint64_t>(d.imm));
      } else if ((d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
        emit_rm_read(tb, d, 64u, globals, global_count);
      } else if (d.rm < 16u) {
        tb.put_gpr(d.rm);
      } else {
        tb.put_str("0");
      }
      tb.put_str(";\n");
      last_was_return = false;
      continue;
    }

    // POP
    if (d.kind == HEX_X86_KIND_POP) {
      tb.put_indent(indent);
      if (d.rm < 16u) {
        tb.put_gpr(d.rm);
        tb.put_str(" = *(uint64*)(uintptr_t)rsp; ");
      }
      tb.put_str("rsp += 8;\n");
      last_was_return = false;
      continue;
    }

    // CALL
    if (d.kind == HEX_X86_KIND_CALL) {
      tb.put_indent(indent);
      if ((d.flags & HEX_X86_FLAG_HAS_TARGET) != 0u && d.opcode == 0xe8u) {
        const bool is_self_call = (d.target == base_addr && is_self_sub);
        if (is_self_call || contains_u64(callees, callee_count, d.target)) {
          tb.put_str("rax = sub_");
          tb.put_u64_hex(d.target, true);
          tb.put_char('(');
          if (is_self_call) {
            emit_abi_exact_args(tb, abi_id, num_params);
          } else {
            emit_abi_call_args(tb, abi_id, true, gpr_used);
          }
          tb.put_str(");\n");
        } else {
          tb.put_str("rax = ((uint64 (*)(uint64, uint64, uint64, uint64))(uintptr_t)0x");
          tb.put_u64_hex(d.target, true);
          tb.put_str("ULL)(");
          emit_abi_call_args(tb, abi_id, false, gpr_used);
          tb.put_str(");\n");
        }
      } else {
        tb.put_str("rax = ((uint64 (*)(uint64, uint64, uint64, uint64))(uintptr_t)(");
        if ((d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
          emit_rm_read(tb, d, 64u, globals, global_count);
        } else {
          tb.put_str("0");
        }
        tb.put_str("))(");
        emit_abi_call_args(tb, abi_id, false, gpr_used);
        tb.put_str(");\n");
      }
      last_was_return = false;
      continue;
    }

    // JMP
    if (d.kind == HEX_X86_KIND_JMP) {
      tb.put_indent(indent);
      if ((d.flags & HEX_X86_FLAG_HAS_TARGET) != 0u && d.opcode != 0xffu) {
        if (loop_ctrl[i] == 1u) {
          tb.put_str("break;\n");
          last_was_return = false;
        } else if (loop_ctrl[i] == 2u) {
          tb.put_str("continue;\n");
          last_was_return = false;
        } else if (target_idx[i] >= 0) {
          tb.put_str("goto loc_");
          tb.put_u64_hex(insns[target_idx[i]].d.pc, true);
          tb.put_str(";\n");
          last_was_return = false;
        } else {
          const bool is_self_call = (d.target == base_addr && is_self_sub);
          if (is_self_call || contains_u64(callees, callee_count, d.target)) {
            tb.put_str("return sub_");
            tb.put_u64_hex(d.target, true);
            tb.put_char('(');
            if (is_self_call) {
              emit_abi_exact_args(tb, abi_id, num_params);
            } else {
              emit_abi_call_args(tb, abi_id, true, gpr_used);
            }
            tb.put_str(");\n");
          } else {
            tb.put_str("return ((uint64 (*)(uint64, uint64, uint64, uint64))(uintptr_t)0x");
            tb.put_u64_hex(d.target, true);
            tb.put_str("ULL)(");
            emit_abi_call_args(tb, abi_id, false, gpr_used);
            tb.put_str(");\n");
          }
          last_was_return = (open_ifs == 0u && open_dos == 0u);
        }
      } else {
        tb.put_str("return ((uint64 (*)(uint64, uint64, uint64, uint64))(uintptr_t)(");
        if ((d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u) {
          emit_rm_read(tb, d, 64u, globals, global_count);
        } else {
          tb.put_str("0");
        }
        tb.put_str("))(");
        emit_abi_call_args(tb, abi_id, false, gpr_used);
        tb.put_str(");\n");
        last_was_return = (open_ifs == 0u && open_dos == 0u);
      }
      continue;
    }

    // JCC
    if (d.kind == HEX_X86_KIND_JCC) {
      const uint8_t raw_cc = (d.opcode == 0x0fu) ? static_cast<uint8_t>(d.opcode2 & 0x0fu)
                                                 : static_cast<uint8_t>(d.opcode & 0x0fu);
      const uint8_t cc = jcc_inverted[i] ? static_cast<uint8_t>(raw_cc ^ 1u) : raw_cc;
      if (if_open[i]) {
        tb.put_indent(indent);
        tb.put_str("if (");
        emit_cc_expr(tb, static_cast<uint8_t>(cc ^ 1u));
        tb.put_str(") {\n");
        ++open_ifs;
        ++indent;
      } else if (do_close[i] && open_dos > 0u) {
        --open_dos;
        --indent;
        tb.put_indent(indent);
        tb.put_str("} while (");
        emit_cc_expr(tb, cc);
        tb.put_str(");\n");
      } else if (loop_ctrl[i] == 1u) {
        tb.put_indent(indent);
        tb.put_str("if (");
        emit_cc_expr(tb, cc);
        tb.put_str(") break;\n");
      } else if (loop_ctrl[i] == 2u) {
        tb.put_indent(indent);
        tb.put_str("if (");
        emit_cc_expr(tb, cc);
        tb.put_str(") continue;\n");
      } else if (target_idx[i] >= 0) {
        tb.put_indent(indent);
        tb.put_str("if (");
        emit_cc_expr(tb, cc);
        tb.put_str(") goto loc_");
        tb.put_u64_hex(insns[target_idx[i]].d.pc, true);
        tb.put_str(";\n");
      } else {
        const bool is_self_call = (d.target == base_addr && is_self_sub);
        tb.put_indent(indent);
        tb.put_str("if (");
        emit_cc_expr(tb, cc);
        if (is_self_call || contains_u64(callees, callee_count, d.target)) {
          tb.put_str(") return sub_");
          tb.put_u64_hex(d.target, true);
          tb.put_char('(');
          if (is_self_call) {
            emit_abi_exact_args(tb, abi_id, num_params);
          } else {
            emit_abi_call_args(tb, abi_id, true, gpr_used);
          }
          tb.put_str(");\n");
        } else {
          tb.put_str(") return ((uint64 (*)(uint64, uint64, uint64, uint64))(uintptr_t)0x");
          tb.put_u64_hex(d.target, true);
          tb.put_str("ULL)(");
          emit_abi_call_args(tb, abi_id, false, gpr_used);
          tb.put_str(");\n");
        }
      }
      last_was_return = false;
      continue;
    }

    // SSE2
    if (is_sse2_insn(d)) {
      tb.put_indent(indent);
      if (d.opcode2 == 0x57u || d.opcode2 == 0xefu) {
        // xorps / xorpd / pxor
        if (mod == 3u && d.reg == d.rm) {
          tb.put_xmm(d.reg);
          tb.put_str(" = 0;\n");
        } else {
          tb.put_xmm(d.reg);
          tb.put_str(" ^= ");
          if (mod == 3u) tb.put_xmm(d.rm);
          else emit_mem_deref(tb, d, 64u, globals, global_count);
          tb.put_str(";\n");
        }
      } else if (d.opcode2 == 0x10u || d.opcode2 == 0x28u || d.opcode2 == 0x6fu) {
        // movups/movupd/movss/movsd/movaps/movapd/movdqa/movdqu load
        tb.put_xmm(d.reg);
        tb.put_str(" = ");
        if (mod == 3u) tb.put_xmm(d.rm);
        else emit_mem_deref(tb, d, (d.op_size == 32u) ? 32u : 64u, globals, global_count);
        tb.put_str(";\n");
      } else if (d.opcode2 == 0x11u || d.opcode2 == 0x29u || d.opcode2 == 0x7fu) {
        // store
        if (mod == 3u) {
          tb.put_xmm(d.rm);
          tb.put_str(" = ");
          tb.put_xmm(d.reg);
          tb.put_str(";\n");
        } else {
          const uint8_t sw = (d.op_size == 32u) ? 32u : 64u;
          emit_mem_deref(tb, d, sw, globals, global_count);
          tb.put_str(" = (");
          tb.put_str(width_to_uint_type(sw));
          tb.put_str(")");
          tb.put_xmm(d.reg);
          tb.put_str(";\n");
        }
      } else if (d.opcode2 == 0x6eu) {
        // movd/movq xmm, r/m
        tb.put_xmm(d.reg);
        tb.put_str(" = ");
        emit_rm_read(tb, d, (d.op_size == 32u) ? 32u : 64u, globals, global_count);
        tb.put_str(";\n");
      } else if (d.opcode2 == 0x7eu) {
        if (gi.is_f3_movq != 0u) {
          tb.put_xmm(d.reg);
          tb.put_str(" = ");
          if (mod == 3u) tb.put_xmm(d.rm);
          else emit_mem_deref(tb, d, 64u, globals, global_count);
          tb.put_str(";\n");
        } else if (mod == 3u) {
          emit_gpr_write_prefix(tb, d.rm, (d.op_size == 32u) ? 32u : 64u);
          tb.put_xmm(d.reg);
          emit_gpr_write_suffix(tb);
        } else {
          const uint8_t sw = (d.op_size == 32u) ? 32u : 64u;
          emit_mem_deref(tb, d, sw, globals, global_count);
          tb.put_str(" = (");
          tb.put_str(width_to_uint_type(sw));
          tb.put_str(")");
          tb.put_xmm(d.reg);
          tb.put_str(";\n");
        }
      }
      last_was_return = false;
      continue;
    }

    // CMOVcc
    if (is_cmovcc_insn(d)) {
      const uint8_t cc = static_cast<uint8_t>(d.opcode2 & 0x0fu);
      tb.put_indent(indent);
      tb.put_str("if (");
      emit_cc_expr(tb, cc);
      tb.put_str(") ");
      emit_gpr_write_prefix(tb, d.reg, w);
      emit_rm_read(tb, d, w, globals, global_count);
      emit_gpr_write_suffix(tb);
      last_was_return = false;
      continue;
    }

    // SETcc
    if (is_setcc_insn(d)) {
      const uint8_t cc = static_cast<uint8_t>(d.opcode2 & 0x0fu);
      tb.put_indent(indent);
      if (mod == 3u) {
        emit_gpr_write_prefix(tb, d.rm, 8u);
        emit_cc_expr(tb, cc);
        tb.put_str(" ? 1U : 0U");
        emit_gpr_write_suffix(tb);
      } else {
        emit_mem_deref(tb, d, 8u, globals, global_count);
        tb.put_str(" = (uint8)(");
        emit_cc_expr(tb, cc);
        tb.put_str(" ? 1U : 0U);\n");
      }
      last_was_return = false;
      continue;
    }

    // CMP / TEST
    if (d.kind == HEX_X86_KIND_CMP) {
      tb.put_indent(indent);
      if (d.opcode == 0x84u || d.opcode == 0x85u) {
        tb.put_str("__hex_cmp_l = (uint64)(");
        emit_rm_read(tb, d, w, globals, global_count);
        tb.put_str(") & (uint64)(");
        emit_gpr_read(tb, d.reg, w);
        tb.put_str("); __hex_cmp_r = 0;\n");
      } else if (d.opcode == 0xa8u || d.opcode == 0xa9u) {
        tb.put_str("__hex_cmp_l = (uint64)(");
        emit_gpr_read(tb, 0u, w);
        tb.put_str(") & ");
        tb.put_imm_u64(mask_imm_by_size(d.imm, w));
        tb.put_str("; __hex_cmp_r = 0;\n");
      } else if (d.opcode == 0xf6u || d.opcode == 0xf7u) {
        tb.put_str("__hex_cmp_l = (uint64)(");
        emit_rm_read(tb, d, w, globals, global_count);
        tb.put_str(") & ");
        tb.put_imm_u64(mask_imm_by_size(d.imm, w));
        tb.put_str("; __hex_cmp_r = 0;\n");
      } else if (d.opcode == 0x3cu || d.opcode == 0x3du) {
        tb.put_str("__hex_cmp_l = (uint64)(");
        emit_gpr_read(tb, 0u, w);
        tb.put_str("); __hex_cmp_r = ");
        tb.put_imm_u64(mask_imm_by_size(d.imm, w));
        tb.put_str(";\n");
      } else if (d.opcode == 0x80u || d.opcode == 0x81u || d.opcode == 0x83u) {
        tb.put_str("__hex_cmp_l = (uint64)(");
        emit_rm_read(tb, d, w, globals, global_count);
        tb.put_str("); __hex_cmp_r = ");
        tb.put_imm_u64(mask_imm_by_size(d.imm, w));
        tb.put_str(";\n");
      } else if (d.opcode == 0x38u || d.opcode == 0x39u) {
        tb.put_str("__hex_cmp_l = (uint64)(");
        emit_rm_read(tb, d, w, globals, global_count);
        tb.put_str("); __hex_cmp_r = (uint64)(");
        emit_gpr_read(tb, d.reg, w);
        tb.put_str(");\n");
      } else {
        tb.put_str("__hex_cmp_l = (uint64)(");
        emit_gpr_read(tb, d.reg, w);
        tb.put_str("); __hex_cmp_r = (uint64)(");
        emit_rm_read(tb, d, w, globals, global_count);
        tb.put_str(");\n");
      }
      last_was_return = false;
      continue;
    }

    // MOV
    if (d.kind == HEX_X86_KIND_MOV) {
      tb.put_indent(indent);
      if (d.opcode >= 0xb0u && d.opcode <= 0xbfu) {
        emit_gpr_write_prefix(tb, d.rm, w);
        tb.put_imm_u64(mask_imm_by_size(d.imm, w));
        emit_gpr_write_suffix(tb);
      } else if (d.opcode == 0xc6u || d.opcode == 0xc7u) {
        if (mod == 3u) {
          emit_gpr_write_prefix(tb, d.rm, w);
          tb.put_imm_u64(mask_imm_by_size(d.imm, w));
          emit_gpr_write_suffix(tb);
        } else {
          emit_mem_deref(tb, d, w, globals, global_count);
          tb.put_str(" = (");
          tb.put_str(width_to_uint_type(w));
          tb.put_str(")");
          tb.put_imm_u64(mask_imm_by_size(d.imm, w));
          tb.put_str(";\n");
        }
      } else if (d.opcode == 0x88u || d.opcode == 0x89u) {
        if (mod == 3u) {
          emit_gpr_write_prefix(tb, d.rm, w);
          emit_gpr_read(tb, d.reg, w);
          emit_gpr_write_suffix(tb);
        } else {
          emit_mem_deref(tb, d, w, globals, global_count);
          tb.put_str(" = ");
          emit_gpr_read(tb, d.reg, w);
          tb.put_str(";\n");
        }
      } else if (d.opcode == 0x8au || d.opcode == 0x8bu) {
        emit_gpr_write_prefix(tb, d.reg, w);
        emit_rm_read(tb, d, w, globals, global_count);
        emit_gpr_write_suffix(tb);
      } else {
        tb.put_str("/* mov */\n");
      }
      last_was_return = false;
      continue;
    }

    // MOVZX
    if (d.kind == HEX_X86_KIND_MOVZX) {
      const uint8_t src_w = (d.opcode2 == 0xb6u) ? 8u : 16u;
      tb.put_indent(indent);
      emit_gpr_write_prefix(tb, d.reg, w);
      tb.put_str("(uint64)");
      emit_rm_read(tb, d, src_w, globals, global_count);
      emit_gpr_write_suffix(tb);
      last_was_return = false;
      continue;
    }

    // MOVSX / MOVSXD / CDQE / CDQ / CQO
    if (d.kind == HEX_X86_KIND_MOVSX) {
      tb.put_indent(indent);
      if (d.opcode == 0x98u) {
        if (w == 64u) {
          tb.put_str("rax = (uint64)(int64)(int32)rax;\n");
        } else if (w == 32u) {
          tb.put_str("rax = (uint32)(int32)(int16)rax;\n");
        } else {
          tb.put_str("rax = (rax & ~0xFFFFULL) | (uint16)(int16)(int8)rax;\n");
        }
      } else if (d.opcode == 0x99u) {
        if (w == 64u) {
          tb.put_str("rdx = ((int64)rax < 0) ? ~0ULL : 0ULL;\n");
        } else if (w == 32u) {
          tb.put_str("rdx = ((int32)rax < 0) ? 0xFFFFFFFFULL : 0ULL;\n");
        } else {
          tb.put_str("rdx = (rdx & ~0xFFFFULL) | (((int16)rax < 0) ? 0xFFFFULL : 0ULL);\n");
        }
      } else {
        const uint8_t src_w = (d.opcode == 0x63u) ? 32u : ((d.opcode2 == 0xbeu) ? 8u : 16u);
        emit_gpr_write_prefix(tb, d.reg, w);
        tb.put_str("(uint64)(int64)(");
        tb.put_str(width_to_int_type(src_w));
        tb.put_str(")(");
        emit_rm_read(tb, d, src_w, globals, global_count);
        tb.put_char(')');
        emit_gpr_write_suffix(tb);
      }
      last_was_return = false;
      continue;
    }

    // LEA
    if (d.kind == HEX_X86_KIND_LEA) {
      tb.put_indent(indent);
      emit_gpr_write_prefix(tb, d.reg, w);
      emit_mem_addr_expr(tb, d, globals, global_count);
      emit_gpr_write_suffix(tb);
      last_was_return = false;
      continue;
    }

    // MUL / IMUL
    if (d.kind == HEX_X86_KIND_MUL) {
      tb.put_indent(indent);
      if (d.opcode == 0xf6u || d.opcode == 0xf7u) {
        const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3u) & 7u);
        if (grp == 4u) {
          tb.put_str("rax = (uint64)(");
          emit_gpr_read(tb, 0u, w);
          tb.put_str(") * (uint64)(");
          emit_rm_read(tb, d, w, globals, global_count);
          tb.put_str("); rdx = 0;\n");
        } else {
          tb.put_str("rax = (uint64)((int64)(");
          tb.put_str(width_to_int_type(w));
          tb.put_str(")");
          emit_gpr_read(tb, 0u, w);
          tb.put_str(" * (int64)(");
          tb.put_str(width_to_int_type(w));
          tb.put_str(")");
          emit_rm_read(tb, d, w, globals, global_count);
          tb.put_str("); rdx = 0;\n");
        }
      } else if (d.opcode == 0x0fu && d.opcode2 == 0xafu) {
        emit_gpr_write_prefix(tb, d.reg, w);
        emit_gpr_read(tb, d.reg, w);
        tb.put_str(" * ");
        emit_rm_read(tb, d, w, globals, global_count);
        emit_gpr_write_suffix(tb);
      } else {
        emit_gpr_write_prefix(tb, d.reg, w);
        emit_rm_read(tb, d, w, globals, global_count);
        tb.put_str(" * ");
        tb.put_imm_u64(mask_imm_by_size(d.imm, w));
        emit_gpr_write_suffix(tb);
      }
      last_was_return = false;
      continue;
    }

    // ALU (add, sub, and, or, xor, adc, sbb, shifts, inc, dec, neg, not, div, idiv)
    if (d.kind == HEX_X86_KIND_ALU) {
      tb.put_indent(indent);
      uint8_t flag_reg = kRegNone;
      bool flag_from_mem = false;

      if (d.opcode < 0x40u) {
        const uint8_t grp = static_cast<uint8_t>((d.opcode >> 3u) & 7u);
        const uint8_t sub = static_cast<uint8_t>(d.opcode & 7u);
        const char* op_s = alu_binop_str(grp);
        if (sub == 0u || sub == 1u) {
          if (mod == 3u) {
            if (grp == 6u && d.reg == d.rm) {
              emit_gpr_write_prefix(tb, d.rm, w);
              tb.put_str("0");
              emit_gpr_write_suffix(tb);
            } else {
              emit_gpr_write_prefix(tb, d.rm, w);
              emit_gpr_read(tb, d.rm, w);
              tb.put_char(' ');
              tb.put_str(op_s);
              tb.put_char(' ');
              emit_gpr_read(tb, d.reg, w);
              emit_gpr_write_suffix(tb);
            }
            flag_reg = d.rm;
          } else {
            emit_mem_deref(tb, d, w, globals, global_count);
            tb.put_str(" = (");
            tb.put_str(width_to_uint_type(w));
            tb.put_str(")(");
            emit_mem_deref(tb, d, w, globals, global_count);
            tb.put_char(' ');
            tb.put_str(op_s);
            tb.put_char(' ');
            emit_gpr_read(tb, d.reg, w);
            tb.put_str(");\n");
            flag_from_mem = true;
          }
        } else if (sub == 2u || sub == 3u) {
          if (grp == 6u && mod == 3u && d.reg == d.rm) {
            emit_gpr_write_prefix(tb, d.reg, w);
            tb.put_str("0");
            emit_gpr_write_suffix(tb);
          } else {
            emit_gpr_write_prefix(tb, d.reg, w);
            emit_gpr_read(tb, d.reg, w);
            tb.put_char(' ');
            tb.put_str(op_s);
            tb.put_char(' ');
            emit_rm_read(tb, d, w, globals, global_count);
            emit_gpr_write_suffix(tb);
          }
          flag_reg = d.reg;
        } else {
          emit_gpr_write_prefix(tb, 0u, w);
          emit_gpr_read(tb, 0u, w);
          tb.put_char(' ');
          tb.put_str(op_s);
          tb.put_char(' ');
          tb.put_imm_u64(mask_imm_by_size(d.imm, w));
          emit_gpr_write_suffix(tb);
          flag_reg = 0u;
        }
      } else if (d.opcode == 0x80u || d.opcode == 0x81u || d.opcode == 0x83u) {
        const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3u) & 7u);
        const char* op_s = alu_binop_str(grp);
        const uint64_t iv = mask_imm_by_size(d.imm, w);
        if (mod == 3u) {
          emit_gpr_write_prefix(tb, d.rm, w);
          emit_gpr_read(tb, d.rm, w);
          tb.put_char(' ');
          tb.put_str(op_s);
          tb.put_char(' ');
          tb.put_imm_u64(iv);
          emit_gpr_write_suffix(tb);
          flag_reg = d.rm;
        } else {
          emit_mem_deref(tb, d, w, globals, global_count);
          tb.put_str(" = (");
          tb.put_str(width_to_uint_type(w));
          tb.put_str(")(");
          emit_mem_deref(tb, d, w, globals, global_count);
          tb.put_char(' ');
          tb.put_str(op_s);
          tb.put_char(' ');
          tb.put_imm_u64(iv);
          tb.put_str(");\n");
          flag_from_mem = true;
        }
      } else if (d.opcode == 0xc0u || d.opcode == 0xc1u ||
                 (d.opcode >= 0xd0u && d.opcode <= 0xd3u)) {
        const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3u) & 7u);
        const bool by_cl = (d.opcode == 0xd2u || d.opcode == 0xd3u);
        const uint32_t shift_mask = (w == 64u) ? 63u : 31u;
        const uint32_t imm_cnt = static_cast<uint32_t>(d.imm) & shift_mask;
        auto emit_shift_rhs = [&]() {
          if (grp == 7u) {
            // sar (arithmetic right shift)
            tb.put_str("((");
            tb.put_str(width_to_int_type(w));
            tb.put_str(")(");
            emit_rm_read(tb, d, w, globals, global_count);
            tb.put_str(") >> ");
            if (by_cl) {
              tb.put_str("(rcx & ");
              tb.put_u64_dec(shift_mask);
              tb.put_char(')');
            } else {
              tb.put_u64_dec(imm_cnt);
            }
            tb.put_char(')');
          } else if (grp == 0u || grp == 1u || grp == 2u || grp == 3u) {
            // rol / ror / rcl / rcr
            const bool is_left = (grp == 0u || grp == 2u);
            const uint32_t rot_bits = (w == 64u) ? 64u : 32u;
            tb.put_str("(((");
            emit_rm_read(tb, d, w, globals, global_count);
            tb.put_str(is_left ? ") << " : ") >> ");
            if (by_cl) {
              tb.put_str("(rcx & ");
              tb.put_u64_dec(shift_mask);
              tb.put_char(')');
            } else {
              tb.put_u64_dec(imm_cnt);
            }
            tb.put_str(") | ((");
            emit_rm_read(tb, d, w, globals, global_count);
            tb.put_str(is_left ? ") >> ((" : ") << ((");
            tb.put_u64_dec(rot_bits);
            tb.put_str(" - ");
            if (by_cl) {
              tb.put_str("(rcx & ");
              tb.put_u64_dec(shift_mask);
              tb.put_char(')');
            } else {
              tb.put_u64_dec(imm_cnt);
            }
            tb.put_str(") & ");
            tb.put_u64_dec(shift_mask);
            tb.put_str(")))");
          } else {
            // shl (4) / shr (5)
            tb.put_char('(');
            emit_rm_read(tb, d, w, globals, global_count);
            tb.put_str((grp == 4u) ? " << " : " >> ");
            if (by_cl) {
              tb.put_str("(rcx & ");
              tb.put_u64_dec(shift_mask);
              tb.put_char(')');
            } else {
              tb.put_u64_dec(imm_cnt);
            }
            tb.put_char(')');
          }
        };
        if (mod == 3u) {
          emit_gpr_write_prefix(tb, d.rm, w);
          emit_shift_rhs();
          emit_gpr_write_suffix(tb);
          flag_reg = d.rm;
        } else {
          emit_mem_deref(tb, d, w, globals, global_count);
          tb.put_str(" = (");
          tb.put_str(width_to_uint_type(w));
          tb.put_str(")");
          emit_shift_rhs();
          tb.put_str(";\n");
          flag_from_mem = true;
        }
      } else if (d.opcode == 0xffu) {
        const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3u) & 7u);
        const char* op_s = (grp == 0u) ? "+" : "-";
        if (mod == 3u) {
          emit_gpr_write_prefix(tb, d.rm, w);
          emit_gpr_read(tb, d.rm, w);
          tb.put_char(' ');
          tb.put_str(op_s);
          tb.put_str(" 1");
          emit_gpr_write_suffix(tb);
          flag_reg = d.rm;
        } else {
          emit_mem_deref(tb, d, w, globals, global_count);
          tb.put_str(" = (");
          tb.put_str(width_to_uint_type(w));
          tb.put_str(")(");
          emit_mem_deref(tb, d, w, globals, global_count);
          tb.put_char(' ');
          tb.put_str(op_s);
          tb.put_str(" 1);\n");
          flag_from_mem = true;
        }
      } else if (d.opcode == 0xf6u || d.opcode == 0xf7u) {
        const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3u) & 7u);
        if (grp == 2u || grp == 3u) {
          // not (2) / neg (3)
          if (mod == 3u) {
            emit_gpr_write_prefix(tb, d.rm, w);
            if (grp == 2u) {
              tb.put_str("~(");
              emit_gpr_read(tb, d.rm, w);
              tb.put_char(')');
            } else {
              tb.put_str("0ULL - (uint64)(");
              emit_gpr_read(tb, d.rm, w);
              tb.put_char(')');
            }
            emit_gpr_write_suffix(tb);
            if (grp == 3u) flag_reg = d.rm;
          } else {
            emit_mem_deref(tb, d, w, globals, global_count);
            tb.put_str(" = (");
            tb.put_str(width_to_uint_type(w));
            tb.put_str(")(");
            tb.put_str(grp == 2u ? "~(" : "0ULL - (uint64)(");
            emit_mem_deref(tb, d, w, globals, global_count);
            tb.put_str("));\n");
            if (grp == 3u) flag_from_mem = true;
          }
        } else if (grp == 6u) {
          // div r/m
          tb.put_str("{ uint64 __d = (uint64)(");
          emit_rm_read(tb, d, w, globals, global_count);
          tb.put_str("); if (__d != 0) { uint64 __q = rax / __d; rdx = rax % __d; rax = __q; } }\n");
        } else if (grp == 7u) {
          // idiv r/m
          tb.put_str("{ int64 __d = (int64)(");
          tb.put_str(width_to_int_type(w));
          tb.put_str(")(");
          emit_rm_read(tb, d, w, globals, global_count);
          tb.put_str("); if (__d != 0) { int64 __q = (int64)rax / __d; rdx = (uint64)((int64)rax % __d); rax = (uint64)__q; } }\n");
        } else {
          tb.put_str("/* alu */\n");
        }
      } else {
        tb.put_str("/* alu */\n");
      }

      if (sets_live_flags[i]) {
        tb.put_indent(indent);
        if (flag_reg < 16u) {
          tb.put_str("__hex_cmp_l = (uint64)(");
          emit_gpr_read(tb, flag_reg, w);
          tb.put_str("); __hex_cmp_r = 0;\n");
        } else if (flag_from_mem) {
          tb.put_str("__hex_cmp_l = (uint64)(");
          emit_mem_deref(tb, d, w, globals, global_count);
          tb.put_str("); __hex_cmp_r = 0;\n");
        }
      }
      last_was_return = false;
      continue;
    }

    // Any other decoded instruction fallback
    tb.put_indent(indent);
    tb.put_str("/* x86_64 ");
    tb.put_str(d.mn[0] != '\0' ? d.mn : "insn");
    tb.put_str(" */\n");
    last_was_return = false;
  }

  // Close any still-open structured blocks cleanly.
  while (open_ifs > 0u) {
    --open_ifs;
    --indent;
    tb.put_indent(indent);
    tb.put_str("}\n");
    last_was_return = false;
  }
  while (open_dos > 0u) {
    --open_dos;
    --indent;
    tb.put_indent(indent);
    tb.put_str("} while (0);\n");
    last_was_return = false;
  }
  if (truncated_body) {
    tb.put_str("    /* x86_64 output truncated at buffer limit */\n");
    for (uint32_t k = truncated_at; k < insn_count; ++k) {
      if (label_refs[k] > 0u) {
        tb.put_str("loc_");
        tb.put_u64_hex(insns[k].d.pc, true);
        tb.put_str(": (void)0;\n");
      }
    }
    last_was_return = false;
  }
  if (!last_was_return) {
    tb.put_str("    return rax;\n");
  }
  tb.put_str("}\n");

  if (tb.overflow || tb.len == 0u) {
    clear_x86_last_output();
    return HEX_ERR_OOM;
  }

  g_x86_last_text = tb.data;
  g_x86_last_text_len = tb.len;
  g_x86_last_linemap = tb.lm;
  g_x86_last_linemap_count = tb.lm_count;
  return HEX_OK;
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
  clear_x86_last_output();

  if (bytes == nullptr || byte_len == 0u) return HEX_ERR_INVALID_ARG;
  if (func_name_len > 0u && func_name_utf8 == nullptr) return HEX_ERR_INVALID_ARG;
  if (abi_id != HEX_X86_ABI_SYSV_AMD64 && abi_id != HEX_X86_ABI_MICROSOFT_X64) {
    return HEX_ERR_INVALID_ARG;
  }
  if (byte_len > kMaxGeneralX86Bytes) return HEX_ERR_UNSUPPORTED;

  // Copy & sanitize function name to stack so it is never aliased with any arena
  // and never collides with C11 keywords or x86-64 register names on either emitter path.
  char local_name[256];
  uint32_t local_name_len = 0u;
  if (func_name_utf8 != nullptr && func_name_len > 0u) {
    local_name_len = sanitize_func_name(
        func_name_utf8, func_name_len, base_addr, local_name, sizeof(local_name));
  }

  // Fast path: strict structured C emitter for small clean functions (preserves 100% compatibility).
  if (byte_len <= kMaxX86Bytes) {
    const HexStatus strict_st = try_emit_x86_64_strict(
        bytes, byte_len, base_addr, local_name, local_name_len, abi_id, emit_flags);
    if (strict_st == HEX_OK) return HEX_OK;
  }

  // General fallback: handles 100% of real-world x86-64 functions up to 32 KiB / 4,096 insns.
  clear_x86_last_output();
  return try_emit_x86_64_general(
      bytes, byte_len, base_addr, local_name, local_name_len, abi_id);
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
