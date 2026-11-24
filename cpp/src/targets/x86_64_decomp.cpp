#include "x86_64_decomp.hpp"

namespace {

constexpr uint32_t kX86WorkArenaBytes = 128u * 1024u;
constexpr uint32_t kX86EmitArenaBytes = 512u * 1024u;
constexpr uint32_t kMaxX86Bytes = 4096u;
constexpr uint32_t kMaxX86Insns = 128u;
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

struct LiftBuilder {
  hex::Vec<CEmitInst> insts;
  uint32_t reg_val[16];
  uint32_t param_val[6];
  uint32_t next_ssa;
  uint32_t num_params;
  uint32_t abi_id;
  uint64_t base_addr;
  bool wrote_rax;
  uint8_t ret_width;
  bool oom;

  explicit LiftBuilder(hex::Arena* arena, uint32_t abi, uint64_t base)
      : insts(arena),
        next_ssa(0u),
        num_params(0u),
        abi_id(abi),
        base_addr(base),
        wrote_rax(false),
        ret_width(0u),
        oom(false) {
    for (uint32_t i = 0u; i < 16u; ++i) reg_val[i] = CEMIT_IR_NO_VAL;
    for (uint32_t i = 0u; i < 6u; ++i) param_val[i] = CEMIT_IR_NO_VAL;
  }

  uint32_t emit_inst(uint8_t op, uint8_t flags, uint16_t width,
                     uint32_t src0, uint32_t src1, uint64_t imm, uint64_t addr,
                     bool has_dst) {
    CEmitInst ci{};
    ci.op = op;
    ci.flags = flags;
    ci.width = width;
    ci.dst = has_dst ? next_ssa++ : CEMIT_IR_NO_VAL;
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

  uint32_t emit_const(uint16_t width, uint64_t val, uint64_t addr) {
    return emit_inst(CEMIT_IR_CONST, 0u, width, CEMIT_IR_NO_VAL, CEMIT_IR_NO_VAL, val, addr, true);
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

  void write_reg(uint8_t reg, uint32_t ssa_id, uint8_t width) {
    if (reg >= 16u) return;
    reg_val[reg] = ssa_id;
    if (reg == 0u) {
      wrote_rax = true;
      ret_width = width;
    }
  }
};

bool lift_one_x86_insn(LiftBuilder& b, const HexX86Decoded& d) {
  if (d.kind == HEX_X86_KIND_NOP) {
    return true;
  }

  // Only 32-bit and 64-bit GPR integer operations are supported.
  if (d.op_size != 32u && d.op_size != 64u) {
    return false;
  }
  const uint16_t w = d.op_size;
  const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6) & 3u);

  if (d.kind == HEX_X86_KIND_MOV) {
    // mov r, imm32/64 (B8..BF)
    if (d.opcode >= 0xb8u && d.opcode <= 0xbfu) {
      if (d.rm >= 16u) return false;
      uint64_t val = static_cast<uint64_t>(d.imm);
      if (w == 32u) val &= 0xffffffffULL;
      const uint32_t cv = b.emit_const(w, val, d.pc);
      if (b.oom) return false;
      b.write_reg(d.rm, cv, d.op_size);
      return true;
    }
    // mov r, imm32 (C7 /0 with mod == 3)
    if (d.opcode == 0xc7u && (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
      if (d.rm >= 16u) return false;
      uint64_t val = static_cast<uint64_t>(d.imm);
      if (w == 32u) val &= 0xffffffffULL;
      const uint32_t cv = b.emit_const(w, val, d.pc);
      if (b.oom) return false;
      b.write_reg(d.rm, cv, d.op_size);
      return true;
    }
    // mov r, r (89: r/m <- reg; 8B: reg <- r/m) with mod == 3
    if ((d.opcode == 0x89u || d.opcode == 0x8bu) &&
        (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
      const uint8_t dst = (d.opcode == 0x89u) ? d.rm : d.reg;
      const uint8_t src = (d.opcode == 0x89u) ? d.reg : d.rm;
      const uint32_t sv = b.read_reg(src);
      if (sv == CEMIT_IR_NO_VAL) return false;
      const uint32_t mv = b.emit_inst(CEMIT_IR_COPY, 0u, w, sv, CEMIT_IR_NO_VAL, 0u, d.pc, true);
      if (b.oom) return false;
      b.write_reg(dst, mv, d.op_size);
      return true;
    }
    return false;
  }

  if (d.kind == HEX_X86_KIND_ALU) {
    // Register-register ALU: 01/03 (add), 09/0B (or), 21/23 (and), 29/2B (sub), 31/33 (xor)
    if (d.opcode < 0x40u) {
      const uint8_t grp = static_cast<uint8_t>((d.opcode >> 3) & 7u);
      const uint8_t sub = static_cast<uint8_t>(d.opcode & 7u);
      uint8_t binop = 0u;
      if (!map_alu_group_to_binop(grp, binop)) return false;

      if (sub == 1u || sub == 3u) {
        if ((d.flags & HEX_X86_FLAG_HAS_MODRM) == 0u || mod != 3u) return false;
        const uint8_t dst = (sub == 1u) ? d.rm : d.reg;
        const uint8_t rhs_reg = (sub == 1u) ? d.reg : d.rm;

        // Zeroing idiom: xor r, r -> const 0 (does not read input register!)
        if (binop == CEMIT_BIN_XOR && dst == rhs_reg) {
          const uint32_t zv = b.emit_const(w, 0u, d.pc);
          if (b.oom) return false;
          b.write_reg(dst, zv, d.op_size);
          return true;
        }
        const uint32_t lv = b.read_reg(dst);
        const uint32_t rv = b.read_reg(rhs_reg);
        if (lv == CEMIT_IR_NO_VAL || rv == CEMIT_IR_NO_VAL) return false;
        const uint32_t ov = b.emit_inst(CEMIT_IR_BINOP, binop, w, lv, rv, 0u, d.pc, true);
        if (b.oom) return false;
        b.write_reg(dst, ov, d.op_size);
        return true;
      }

      // rAX, imm32 (sub == 5)
      if (sub == 5u && (d.flags & HEX_X86_FLAG_HAS_IMM) != 0u) {
        const uint32_t lv = b.read_reg(0u);
        if (lv == CEMIT_IR_NO_VAL) return false;
        uint64_t imm_val = static_cast<uint64_t>(d.imm);
        if (w == 32u) imm_val &= 0xffffffffULL;
        const uint32_t iv = b.emit_const(w, imm_val, d.pc);
        if (b.oom) return false;
        const uint32_t ov = b.emit_inst(CEMIT_IR_BINOP, binop, w, lv, iv, 0u, d.pc, true);
        if (b.oom) return false;
        b.write_reg(0u, ov, d.op_size);
        return true;
      }
      return false;
    }

    // Group 1 ALU r, imm8/imm32 (81 / 83 with mod == 3)
    if ((d.opcode == 0x81u || d.opcode == 0x83u) &&
        (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
      const uint8_t grp = static_cast<uint8_t>((d.modrm >> 3) & 7u);
      uint8_t binop = 0u;
      if (!map_alu_group_to_binop(grp, binop)) return false;
      const uint32_t lv = b.read_reg(d.rm);
      if (lv == CEMIT_IR_NO_VAL) return false;
      uint64_t imm_val = static_cast<uint64_t>(d.imm);
      if (w == 32u) imm_val &= 0xffffffffULL;
      const uint32_t iv = b.emit_const(w, imm_val, d.pc);
      if (b.oom) return false;
      const uint32_t ov = b.emit_inst(CEMIT_IR_BINOP, binop, w, lv, iv, 0u, d.pc, true);
      if (b.oom) return false;
      b.write_reg(d.rm, ov, d.op_size);
      return true;
    }
    return false;
  }

  if (d.kind == HEX_X86_KIND_MUL) {
    // 0F AF: imul r, r (mod == 3)
    if (d.opcode == 0x0fu && d.opcode2 == 0xafu &&
        (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
      const uint32_t lv = b.read_reg(d.reg);
      const uint32_t rv = b.read_reg(d.rm);
      if (lv == CEMIT_IR_NO_VAL || rv == CEMIT_IR_NO_VAL) return false;
      const uint32_t ov = b.emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_MUL, w, lv, rv, 0u, d.pc, true);
      if (b.oom) return false;
      b.write_reg(d.reg, ov, d.op_size);
      return true;
    }
    // 69 / 6B: imul r, r, imm (mod == 3)
    if ((d.opcode == 0x69u || d.opcode == 0x6bu) &&
        (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u) {
      const uint32_t lv = b.read_reg(d.rm);
      if (lv == CEMIT_IR_NO_VAL) return false;
      uint64_t imm_val = static_cast<uint64_t>(d.imm);
      if (w == 32u) imm_val &= 0xffffffffULL;
      const uint32_t iv = b.emit_const(w, imm_val, d.pc);
      if (b.oom) return false;
      const uint32_t ov = b.emit_inst(CEMIT_IR_BINOP, CEMIT_BIN_MUL, w, lv, iv, 0u, d.pc, true);
      if (b.oom) return false;
      b.write_reg(d.reg, ov, d.op_size);
      return true;
    }
    return false;
  }

  if (d.kind == HEX_X86_KIND_LEA) {
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
    b.write_reg(d.reg, acc, d.op_size);
    return true;
  }

  return false;
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

  // Reclaim all temporary decode/lift buffers on exit; never touch caller's arenas.
  g_x86_work_arena.reset();
  hex::ArenaScope work_scope(g_x86_work_arena);

  // Stage 1: Fail-closed full-buffer decode.
  if (hex_x86_64_is_decompiler_supported(bytes, byte_len) != HEX_X86_CAP_DECOMP) {
    return HEX_ERR_UNSUPPORTED;
  }

  HexX86Decoded* decoded = g_x86_work_arena.alloc<HexX86Decoded>(kMaxX86Insns);
  if (!decoded) return HEX_ERR_OOM;

  uint32_t off = 0u;
  uint32_t insn_count = 0u;
  while (off < byte_len) {
    if (insn_count >= kMaxX86Insns) return HEX_ERR_UNSUPPORTED;
    HexX86Decoded& d = decoded[insn_count];
    const HexStatus st = hex_x86_64_decode_one(
        bytes + off, byte_len - off, base_addr + static_cast<uint64_t>(off), &d);
    if (st != HEX_OK) return HEX_ERR_UNSUPPORTED;
    if (d.valid == 0u || d.length == 0u ||
        (d.flags & (HEX_X86_FLAG_TRUNCATED | HEX_X86_FLAG_INVALID)) != 0u ||
        d.cap != HEX_X86_CAP_DECOMP) {
      return HEX_ERR_UNSUPPORTED;
    }
    if (static_cast<uint32_t>(d.length) > byte_len - off) return HEX_ERR_UNSUPPORTED;
    off += static_cast<uint32_t>(d.length);
    ++insn_count;
  }
  if (off != byte_len || insn_count == 0u) return HEX_ERR_UNSUPPORTED;

  // Stage 2: Straight-line return gate (last insn must be canonical `ret` 0xC3; no interior RET).
  const HexX86Decoded& last = decoded[insn_count - 1u];
  if (last.kind != HEX_X86_KIND_RET || last.opcode != 0xc3u) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Stage 3: Lift straight-line instructions into CEmitInst SSA form.
  LiftBuilder builder(&g_x86_work_arena, abi_id, base_addr);
  if (!builder.insts.reserve(static_cast<size_t>(insn_count) * 4u + 8u)) {
    return HEX_ERR_OOM;
  }

  for (uint32_t i = 0u; i + 1u < insn_count; ++i) {
    if (!lift_one_x86_insn(builder, decoded[i])) {
      return builder.oom ? HEX_ERR_OOM : HEX_ERR_UNSUPPORTED;
    }
  }

  // Emit final RET instruction.
  builder.emit_inst(
      CEMIT_IR_RET, 0u, builder.wrote_rax ? builder.ret_width : 0u,
      builder.wrote_rax ? builder.reg_val[0] : CEMIT_IR_NO_VAL,
      CEMIT_IR_NO_VAL, 0u, last.pc, false);
  if (builder.oom) return HEX_ERR_OOM;

  // Stage 4: Build single-block CEmitFunctionView on g_x86_work_arena
  // and emit C text + linemap into the physically isolated g_x86_emit_arena.
  const uint32_t block_inst_off[2] = {0u, static_cast<uint32_t>(builder.insts.size())};
  const uint64_t block_addr[1] = {base_addr};
  const uint32_t succ_off[2] = {0u, 0u};
  const int32_t idom[1] = {-1};
  const int32_t ipdom[1] = {-1};

  CEmitFunctionView view{};
  view.func_name = local_name_len > 0u ? local_name : nullptr;
  view.func_name_len = local_name_len;
  view.entry_va = base_addr;
  view.num_params = builder.num_params;
  view.ret_width = builder.wrote_rax ? builder.ret_width : 0u;
  view.ret_is_signed = (builder.wrote_rax && builder.ret_width == 32u) ? 1u : 0u;
  view.num_blocks = 1u;
  view.entry_block = 0u;
  view.block_inst_off = block_inst_off;
  view.block_addr = block_addr;
  view.insts = builder.insts.data();
  view.num_insts = static_cast<uint32_t>(builder.insts.size());
  view.succ_off = succ_off;
  view.succ_dst = nullptr;
  view.idom = idom;
  view.ipdom = ipdom;
  view.num_loops = 0u;
  view.loop_header = nullptr;
  view.loop_parent = nullptr;
  view.node_innermost_loop = nullptr;

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
