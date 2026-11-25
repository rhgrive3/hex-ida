#include "arm64_memory_emit.hpp"

namespace hex {
namespace decompiler {
namespace passes {

namespace {

static constexpr uint32_t kNoExpr = 0xffffffffu;
static constexpr uint32_t kMaxLocalSlots = 32u;
static constexpr uint32_t kMaxStmts = 128u;
static constexpr uint32_t kMaxExprNodes = 256u;
static constexpr uint32_t kMaxPrintDepth = 64u;

static constexpr char kHexLower[16] = {
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};

static constexpr char kHexUpper[16] = {
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'};

enum class ExprKind : uint8_t {
  Param = 0,
  Const = 1,
  Add = 2,
  Load = 3,
};

struct ExprNode {
  ExprKind kind;
  uint8_t bits;       // 32 or 64
  uint8_t param_idx;  // 0..7 for Param
  uint8_t _pad;
  uint32_t lhs;       // for Add / Load (base expr)
  uint32_t rhs;       // for Add
  uint64_t imm;       // for Const
  int64_t disp;       // for Load
};

struct LocalSlot {
  int64_t sp_off;      // signed offset relative to entry SP
  uint32_t cur_expr;   // forwarded expression id
  bool declared;
};

enum class StmtKind : uint8_t {
  LocalAssign = 0,
  MemStore = 1,
};

struct Stmt {
  StmtKind kind;
  uint8_t bits;
  uint16_t slot_idx;   // for LocalAssign
  uint32_t base_expr;  // for MemStore
  uint32_t val_expr;   // for LocalAssign / MemStore
  int64_t disp;        // for MemStore
  uint64_t va;
};

struct StructFieldSet {
  bool used;
  uint32_t field_count;
  uint64_t offsets[16];
};

bool append_str(Vec<char>& out, const char* s, size_t n) {
  if (n == 0) return true;
  const size_t old = out.size();
  if (n > static_cast<size_t>(-1) - old) return false;
  if (!out.resize(old + n)) return false;
  mem_copy(out.data() + old, s, n);
  return true;
}

bool append_cstr(Vec<char>& out, const char* s) {
  size_t n = 0;
  while (s[n] != '\0') ++n;
  return append_str(out, s, n);
}

bool append_ch(Vec<char>& out, char c) {
  return out.push_back(c);
}

bool append_u64_dec(Vec<char>& out, uint64_t v) {
  char tmp[24];
  size_t n = 0;
  if (v == 0ULL) return append_ch(out, '0');
  while (v > 0ULL) {
    tmp[n++] = static_cast<char>('0' + (v % 10ULL));
    v /= 10ULL;
  }
  for (size_t i = n; i > 0; --i) {
    if (!append_ch(out, tmp[i - 1])) return false;
  }
  return true;
}

bool append_i64_dec(Vec<char>& out, int64_t v) {
  if (v < 0) {
    if (!append_ch(out, '-')) return false;
    return append_u64_dec(out, static_cast<uint64_t>(-(v + 1)) + 1ULL);
  }
  return append_u64_dec(out, static_cast<uint64_t>(v));
}

bool append_u64_hex(Vec<char>& out, uint64_t v, bool upper) {
  const char* digits = upper ? kHexUpper : kHexLower;
  char tmp[20];
  size_t n = 0;
  if (v == 0ULL) return append_ch(out, '0');
  while (v > 0ULL) {
    tmp[n++] = digits[v & 0xfULL];
    v >>= 4;
  }
  for (size_t i = n; i > 0; --i) {
    if (!append_ch(out, tmp[i - 1])) return false;
  }
  return true;
}

bool append_local_name(Vec<char>& out, int64_t sp_off) {
  if (sp_off < 0) {
    const uint64_t mag = static_cast<uint64_t>(-(sp_off + 1)) + 1ULL;
    if (!append_cstr(out, "local_m")) return false;
    return append_u64_hex(out, mag, true);
  }
  if (!append_cstr(out, "var_")) return false;
  return append_u64_hex(out, static_cast<uint64_t>(sp_off), true);
}

bool append_const_literal(Vec<char>& out, uint64_t v) {
  if (v >= 256ULL) {
    if (!append_cstr(out, "0x")) return false;
    return append_u64_hex(out, v, false);
  }
  return append_u64_dec(out, v);
}

bool is_ident_char(uint8_t c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
}

bool sanitize_func_name(const char* raw, uint32_t len, uint64_t base_addr, Vec<char>& out) {
  if (raw && len >= 2u && ((raw[0] == '-' && raw[1] == '[') || (raw[0] == '+' && raw[1] == '['))) {
    return false;  // Fail closed on ObjC method selectors
  }
  if (raw && len > 0u) {
    uint32_t start = 0u;
    while (start < len && raw[start] == '_') ++start;
    if (start < len) {
      const uint8_t first = static_cast<uint8_t>(raw[start]);
      if (first >= '0' && first <= '9') return false;
      for (uint32_t i = start; i < len; ++i) {
        const uint8_t c = static_cast<uint8_t>(raw[i]);
        if (!append_ch(out, is_ident_char(c) ? static_cast<char>(c) : '_')) return false;
      }
      return true;
    }
  }
  if (!append_cstr(out, "sub_")) return false;
  return append_u64_hex(out, base_addr, false);
}

enum class PrintOp : uint8_t {
  EmitExpr = 0,
  EmitLiteral = 1,
};

struct PrintTask {
  PrintOp op;
  uint8_t parent_is_add;
  uint32_t expr_id;
  const char* lit;
};

// Non-recursive expression printer using explicit task stack.
bool emit_expr_iterative(Arena& arena, const Vec<ExprNode>& exprs, uint32_t root_id, Vec<char>& out) {
  Vec<PrintTask> stack(&arena);
  if (!stack.reserve(32)) return false;
  if (!stack.push_back(PrintTask{PrintOp::EmitExpr, 0u, root_id, nullptr})) return false;

  while (!stack.empty()) {
    const PrintTask t = stack.back();
    stack.pop_back();
    if (t.op == PrintOp::EmitLiteral) {
      if (!append_cstr(out, t.lit)) return false;
      continue;
    }
    if (t.expr_id >= exprs.size()) return false;
    const ExprNode& e = exprs[t.expr_id];
    switch (e.kind) {
      case ExprKind::Param:
        if (!append_ch(out, 'a')) return false;
        if (!append_u64_dec(out, static_cast<uint64_t>(e.param_idx) + 1ULL)) return false;
        break;
      case ExprKind::Const:
        if (!append_const_literal(out, e.imm)) return false;
        break;
      case ExprKind::Add: {
        if (stack.size() + 5u > kMaxPrintDepth) return false;
        const bool wrap = (t.parent_is_add != 0u);
        if (wrap && !stack.push_back(PrintTask{PrintOp::EmitLiteral, 0u, 0u, ")"})) return false;
        if (!stack.push_back(PrintTask{PrintOp::EmitExpr, 1u, e.rhs, nullptr})) return false;
        if (!stack.push_back(PrintTask{PrintOp::EmitLiteral, 0u, 0u, " + "})) return false;
        if (!stack.push_back(PrintTask{PrintOp::EmitExpr, 1u, e.lhs, nullptr})) return false;
        if (wrap && !stack.push_back(PrintTask{PrintOp::EmitLiteral, 0u, 0u, "("})) return false;
        break;
      }
      case ExprKind::Load: {
        const bool wrap = (t.parent_is_add != 0u);
        if (wrap && !append_ch(out, '(')) return false;
        if (e.bits == 32u) {
          if (!append_cstr(out, "*(uint32_t *)((uintptr_t)(")) return false;
        } else {
          if (!append_cstr(out, "*(uint64 *)((uintptr_t)(")) return false;
        }
        // Base is guaranteed Param in supported subset; emit directly to avoid recursion.
        if (e.lhs >= exprs.size() || exprs[e.lhs].kind != ExprKind::Param) return false;
        if (!append_ch(out, 'a')) return false;
        if (!append_u64_dec(out, static_cast<uint64_t>(exprs[e.lhs].param_idx) + 1ULL)) return false;
        if (e.bits == 32u) {
          if (e.disp >= 0) {
            if (!append_cstr(out, ") + ")) return false;
            if (!append_i64_dec(out, e.disp)) return false;
          } else {
            if (!append_cstr(out, ") - ")) return false;
            if (!append_u64_dec(out, static_cast<uint64_t>(-(e.disp + 1)) + 1ULL)) return false;
          }
        } else {
          if (e.disp >= 0) {
            if (!append_cstr(out, ") + 0x")) return false;
            if (!append_u64_hex(out, static_cast<uint64_t>(e.disp), false)) return false;
          } else {
            if (!append_cstr(out, ") - 0x")) return false;
            if (!append_u64_hex(out, static_cast<uint64_t>(-(e.disp + 1)) + 1ULL, false)) return false;
          }
        }
        if (!append_ch(out, ')')) return false;
        if (wrap && !append_ch(out, ')')) return false;
        break;
      }
    }
  }
  return true;
}

inline int64_t sign_extend_7(uint32_t imm7) {
  return (imm7 & 0x40u) ? static_cast<int64_t>(imm7 | ~0x7fu) : static_cast<int64_t>(imm7);
}

struct ArenaRollback {
  hex::Arena& arena;
  size_t mark;
  bool armed;
  ~ArenaRollback() {
    if (armed) arena.restore(mark);
  }
};

bool record_struct_field(StructFieldSet* sets, uint8_t param_idx, uint64_t off) {
  if (param_idx >= 8u) return false;
  StructFieldSet& s = sets[param_idx];
  s.used = true;
  for (uint32_t i = 0; i < s.field_count; ++i) {
    if (s.offsets[i] == off) return true;
  }
  if (s.field_count >= 16u) return false;
  s.offsets[s.field_count++] = off;
  return true;
}

}  // namespace

HexStatus try_emit_arm64_memory(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name,
    uint32_t func_name_len,
    uint32_t emit_flags,
    hex::Arena& emit_arena,
    const char** out_text,
    uint32_t* out_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  (void)emit_flags;
  if (out_text) *out_text = nullptr;
  if (out_len) *out_len = 0u;
  if (out_linemap) *out_linemap = nullptr;
  if (out_linemap_count) *out_linemap_count = 0u;
  if (!words || word_count == 0u || !out_text || !out_len || !out_linemap || !out_linemap_count) {
    return HEX_ERR_INVALID_ARG;
  }
  if (word_count > 64u) return HEX_ERR_UNSUPPORTED;
  ArenaRollback arena_guard{emit_arena, emit_arena.used(), true};

  // Must end with canonical ARM64 RET (x30).
  if (words[word_count - 1u] != 0xd65f03c0u) {
    return HEX_ERR_UNSUPPORTED;
  }

  Vec<char> clean_name(&emit_arena);
  if (!sanitize_func_name(func_name, func_name_len, base_addr, clean_name)) {
    return HEX_ERR_UNSUPPORTED;
  }

  Vec<ExprNode> exprs(&emit_arena);
  if (!exprs.reserve(64)) return HEX_ERR_OOM;

  auto push_expr = [&](const ExprNode& node, uint32_t* id_out) -> HexStatus {
    if (exprs.size() >= kMaxExprNodes) return HEX_ERR_UNSUPPORTED;
    *id_out = static_cast<uint32_t>(exprs.size());
    return exprs.push_back(node) ? HEX_OK : HEX_ERR_OOM;
  };

  uint32_t reg_expr[31];
  uint8_t reg_bits[31];
  bool reg_written[31];
  bool param_read[8];
  bool param_is_ptr64[8];
  StructFieldSet structs[8];

  for (uint32_t r = 0; r < 31u; ++r) {
    reg_expr[r] = kNoExpr;
    reg_bits[r] = 64u;
    reg_written[r] = false;
  }
  for (uint32_t p = 0; p < 8u; ++p) {
    ExprNode pn{};
    pn.kind = ExprKind::Param;
    pn.bits = 64u;
    pn.param_idx = static_cast<uint8_t>(p);
    uint32_t pid = kNoExpr;
    const HexStatus st = push_expr(pn, &pid);
    if (st != HEX_OK) return st;
    reg_expr[p] = pid;
    param_read[p] = false;
    param_is_ptr64[p] = false;
    structs[p].used = false;
    structs[p].field_count = 0u;
  }

  LocalSlot slots[kMaxLocalSlots];
  uint32_t slot_count = 0u;

  auto find_or_add_slot = [&](int64_t sp_off) -> int32_t {
    for (uint32_t i = 0; i < slot_count; ++i) {
      if (slots[i].sp_off == sp_off) return static_cast<int32_t>(i);
    }
    if (slot_count >= kMaxLocalSlots) return -1;
    slots[slot_count].sp_off = sp_off;
    slots[slot_count].cur_expr = kNoExpr;
    slots[slot_count].declared = true;
    return static_cast<int32_t>(slot_count++);
  };

  bool reg_load_invalidated[31];
  for (uint32_t i = 0; i < 31u; ++i) reg_load_invalidated[i] = false;
  auto read_reg = [&](uint32_t r, uint32_t* out_id) -> bool {
    if (r >= 31u || reg_load_invalidated[r]) return false;
    if (reg_expr[r] == kNoExpr) return false;
    if (!reg_written[r] && r < 8u) param_read[r] = true;
    *out_id = reg_expr[r];
    return true;
  };

  Vec<Stmt> stmts(&emit_arena);
  if (!stmts.reserve(32)) return HEX_ERR_OOM;

  int64_t sp_delta = 0;
  bool has_mem_op = false;
  bool uses_u32_deref = false;
  bool uses_uintptr = false;
  uint64_t r0_last_va = base_addr + static_cast<uint64_t>(word_count - 1u) * 4ULL;

  for (uint32_t i = 0; i + 1u < word_count; ++i) {
    const uint32_t w = words[i];
    const uint64_t va = base_addr + static_cast<uint64_t>(i) * 4ULL;

    // 1. MOVZ (32/64-bit)
    if ((w & 0x7f800000u) == 0x52800000u) {
      const uint8_t bits = (w >> 31) ? 64u : 32u;
      const uint32_t hw = (w >> 21) & 3u;
      if (bits == 32u && hw >= 2u) return HEX_ERR_UNSUPPORTED;
      const uint64_t imm16 = (w >> 5) & 0xffffu;
      const uint32_t rd = w & 31u;
      if (rd == 31u) return HEX_ERR_UNSUPPORTED;
      ExprNode cn{};
      cn.kind = ExprKind::Const;
      cn.bits = bits;
      cn.imm = imm16 << (hw * 16u);
      uint32_t cid = kNoExpr;
      const HexStatus st = push_expr(cn, &cid);
      if (st != HEX_OK) return st;
      reg_expr[rd] = cid;
      reg_bits[rd] = bits;
      reg_written[rd] = true;
      if (rd == 0u) r0_last_va = va;
      continue;
    }

    // 2. MOV (register alias of ORR: sf 0101010 00 0 Rm 000000 11111 Rd)
    if ((w & 0x7fe0ffe0u) == 0x2a0003e0u) {
      const uint8_t bits = (w >> 31) ? 64u : 32u;
      const uint32_t rm = (w >> 16) & 31u;
      const uint32_t rd = w & 31u;
      if (rd == 31u) return HEX_ERR_UNSUPPORTED;
      uint32_t src_id = kNoExpr;
      if (!read_reg(rm, &src_id)) return HEX_ERR_UNSUPPORTED;
      reg_expr[rd] = src_id;
      reg_bits[rd] = bits;
      reg_written[rd] = true;
      if (rd == 0u) r0_last_va = va;
      continue;
    }

    // 3. ADD (immediate, non-flag-setting): sf 0 0 100010 sh imm12 Rn Rd (bit 23 must be 0)
    if ((w & 0x7f800000u) == 0x11000000u) {
      const uint8_t bits = (w >> 31) ? 64u : 32u;
      const uint32_t sh = (w >> 22) & 1u;
      const uint64_t imm = static_cast<uint64_t>((w >> 10) & 0xfffu) << (sh ? 12u : 0u);
      const uint32_t rn = (w >> 5) & 31u;
      const uint32_t rd = w & 31u;
      if (rd == 31u && rn == 31u) {
        if (bits != 64u) return HEX_ERR_UNSUPPORTED;
        sp_delta += static_cast<int64_t>(imm);
        continue;
      }
      if (rd == 31u || rn == 31u) return HEX_ERR_UNSUPPORTED;
      uint32_t lhs_id = kNoExpr;
      if (!read_reg(rn, &lhs_id)) return HEX_ERR_UNSUPPORTED;
      uint32_t res_id = kNoExpr;
      if (exprs[lhs_id].kind == ExprKind::Const) {
        ExprNode folded{};
        folded.kind = ExprKind::Const;
        folded.bits = bits;
        folded.imm = (bits == 32u)
                         ? static_cast<uint32_t>(exprs[lhs_id].imm + imm)
                         : (exprs[lhs_id].imm + imm);
        const HexStatus st = push_expr(folded, &res_id);
        if (st != HEX_OK) return st;
      } else {
        ExprNode cn{};
        cn.kind = ExprKind::Const;
        cn.bits = bits;
        cn.imm = imm;
        uint32_t rhs_id = kNoExpr;
        HexStatus st = push_expr(cn, &rhs_id);
        if (st != HEX_OK) return st;
        ExprNode an{};
        an.kind = ExprKind::Add;
        an.bits = bits;
        an.lhs = lhs_id;
        an.rhs = rhs_id;
        st = push_expr(an, &res_id);
        if (st != HEX_OK) return st;
      }
      reg_expr[rd] = res_id;
      reg_bits[rd] = bits;
      reg_written[rd] = true;
      if (rd == 0u) r0_last_va = va;
      continue;
    }

    // 4. SUB (immediate, non-flag-setting): sf 1 0 100010 sh imm12 Rn Rd (bit 23 must be 0)
    if ((w & 0x7f800000u) == 0x51000000u) {
      if ((w >> 31) == 0u) return HEX_ERR_UNSUPPORTED;
      const uint32_t sh = (w >> 22) & 1u;
      const uint64_t imm = static_cast<uint64_t>((w >> 10) & 0xfffu) << (sh ? 12u : 0u);
      const uint32_t rn = (w >> 5) & 31u;
      const uint32_t rd = w & 31u;
      if (rd == 31u && rn == 31u) {
        sp_delta -= static_cast<int64_t>(imm);
        continue;
      }
      return HEX_ERR_UNSUPPORTED;
    }

    // 5. ADD (shifted register, shift=0, imm6=0): sf 0 0 01011 00 0 Rm 000000 Rn Rd
    if ((w & 0x7fe0fc00u) == 0x0b000000u) {
      const uint8_t bits = (w >> 31) ? 64u : 32u;
      const uint32_t rm = (w >> 16) & 31u;
      const uint32_t rn = (w >> 5) & 31u;
      const uint32_t rd = w & 31u;
      if (rd == 31u || rn == 31u || rm == 31u) return HEX_ERR_UNSUPPORTED;
      uint32_t lhs_id = kNoExpr;
      uint32_t rhs_id = kNoExpr;
      if (!read_reg(rn, &lhs_id) || !read_reg(rm, &rhs_id)) return HEX_ERR_UNSUPPORTED;
      ExprNode an{};
      an.kind = ExprKind::Add;
      an.bits = bits;
      an.lhs = lhs_id;
      an.rhs = rhs_id;
      uint32_t res_id = kNoExpr;
      const HexStatus st = push_expr(an, &res_id);
      if (st != HEX_OK) return st;
      reg_expr[rd] = res_id;
      reg_bits[rd] = bits;
      reg_written[rd] = true;
      if (rd == 0u) r0_last_va = va;
      continue;
    }

    // 6. STR (unsigned offset, 64-bit 0xf9000000 or 32-bit 0xb9000000)
    if ((w & 0xffc00000u) == 0xf9000000u || (w & 0xffc00000u) == 0xb9000000u) {
      const bool is64 = ((w & 0xffc00000u) == 0xf9000000u);
      const uint8_t bits = is64 ? 64u : 32u;
      const uint64_t scale = is64 ? 8ULL : 4ULL;
      const int64_t disp = static_cast<int64_t>(((w >> 10) & 0xfffu) * scale);
      const uint32_t rn = (w >> 5) & 31u;
      const uint32_t rt = w & 31u;
      uint32_t val_id = kNoExpr;
      if (!read_reg(rt, &val_id)) return HEX_ERR_UNSUPPORTED;
      has_mem_op = true;

      if (rn == 31u) {
        const int64_t slot_off = sp_delta + disp;
        const int32_t sidx = find_or_add_slot(slot_off);
        if (sidx < 0) return HEX_ERR_UNSUPPORTED;
        slots[sidx].cur_expr = val_id;
        if (stmts.size() >= kMaxStmts) return HEX_ERR_UNSUPPORTED;
        if (!stmts.push_back(Stmt{StmtKind::LocalAssign, bits, static_cast<uint16_t>(sidx), kNoExpr, val_id, 0, va})) {
          return HEX_ERR_OOM;
        }
      } else {
        uint32_t base_id = kNoExpr;
        if (!read_reg(rn, &base_id)) return HEX_ERR_UNSUPPORTED;
        if (exprs[base_id].kind != ExprKind::Param) return HEX_ERR_UNSUPPORTED;
        uses_uintptr = true;
        if (is64) {
          param_is_ptr64[exprs[base_id].param_idx] = true;
          if (!record_struct_field(structs, exprs[base_id].param_idx, static_cast<uint64_t>(disp))) {
            return HEX_ERR_UNSUPPORTED;
          }
        } else {
          uses_u32_deref = true;
        }
        if (stmts.size() >= kMaxStmts) return HEX_ERR_UNSUPPORTED;
        if (!stmts.push_back(Stmt{StmtKind::MemStore, bits, 0u, base_id, val_id, disp, va})) {
          return HEX_ERR_OOM;
        }
        for (uint32_t rr = 0u; rr < 31u; ++rr) {
          if (reg_written[rr] && reg_expr[rr] < exprs.size() &&
              exprs[reg_expr[rr]].kind == ExprKind::Load) {
            reg_load_invalidated[rr] = true;
          }
        }
      }
      continue;
    }

    // 7. LDR (unsigned offset, 64-bit 0xf9400000 or 32-bit 0xb9400000)
    if ((w & 0xffc00000u) == 0xf9400000u || (w & 0xffc00000u) == 0xb9400000u) {
      const bool is64 = ((w & 0xffc00000u) == 0xf9400000u);
      const uint8_t bits = is64 ? 64u : 32u;
      const uint64_t scale = is64 ? 8ULL : 4ULL;
      const int64_t disp = static_cast<int64_t>(((w >> 10) & 0xfffu) * scale);
      const uint32_t rn = (w >> 5) & 31u;
      const uint32_t rt = w & 31u;
      if (rt == 31u) return HEX_ERR_UNSUPPORTED;
      has_mem_op = true;

      if (rn == 31u) {
        const int64_t slot_off = sp_delta + disp;
        int32_t found = -1;
        for (uint32_t s = 0; s < slot_count; ++s) {
          if (slots[s].sp_off == slot_off) {
            found = static_cast<int32_t>(s);
            break;
          }
        }
        if (found < 0 || slots[found].cur_expr == kNoExpr) return HEX_ERR_UNSUPPORTED;
        reg_expr[rt] = slots[found].cur_expr;
        reg_bits[rt] = bits;
        reg_written[rt] = true;
        if (rt == 0u) r0_last_va = va;
      } else {
        uint32_t base_id = kNoExpr;
        if (!read_reg(rn, &base_id)) return HEX_ERR_UNSUPPORTED;
        if (exprs[base_id].kind != ExprKind::Param) return HEX_ERR_UNSUPPORTED;
        uses_uintptr = true;
        if (is64) {
          param_is_ptr64[exprs[base_id].param_idx] = true;
          if (!record_struct_field(structs, exprs[base_id].param_idx, static_cast<uint64_t>(disp))) {
            return HEX_ERR_UNSUPPORTED;
          }
        } else {
          uses_u32_deref = true;
        }
        ExprNode ln{};
        ln.kind = ExprKind::Load;
        ln.bits = bits;
        ln.lhs = base_id;
        ln.disp = disp;
        uint32_t lid = kNoExpr;
        const HexStatus st = push_expr(ln, &lid);
        if (st != HEX_OK) return st;
        reg_expr[rt] = lid;
        reg_bits[rt] = bits;
        reg_written[rt] = true;
        reg_load_invalidated[rt] = false;
        if (rt == 0u) r0_last_va = va;
      }
      continue;
    }

    // 8. LDP (signed offset, 64-bit 0xa9400000 or 32-bit 0x29400000, non-writeback)
    if ((w & 0xffc00000u) == 0xa9400000u || (w & 0xffc00000u) == 0x29400000u) {
      const bool is64 = ((w & 0xffc00000u) == 0xa9400000u);
      const uint8_t bits = is64 ? 64u : 32u;
      const int64_t scale = is64 ? 8 : 4;
      const int64_t disp = sign_extend_7((w >> 15) & 0x7fu) * scale;
      const uint32_t rt2 = (w >> 10) & 31u;
      const uint32_t rn = (w >> 5) & 31u;
      const uint32_t rt = w & 31u;
      if (rt == 31u || rt2 == 31u || rn == 31u || rt == rt2) return HEX_ERR_UNSUPPORTED;
      uint32_t base_id = kNoExpr;
      if (!read_reg(rn, &base_id)) return HEX_ERR_UNSUPPORTED;
      if (exprs[base_id].kind != ExprKind::Param) return HEX_ERR_UNSUPPORTED;
      has_mem_op = true;
      uses_uintptr = true;
      if (!is64) uses_u32_deref = true;

      ExprNode ln1{};
      ln1.kind = ExprKind::Load;
      ln1.bits = bits;
      ln1.lhs = base_id;
      ln1.disp = disp;
      uint32_t lid1 = kNoExpr;
      HexStatus st = push_expr(ln1, &lid1);
      if (st != HEX_OK) return st;

      ExprNode ln2{};
      ln2.kind = ExprKind::Load;
      ln2.bits = bits;
      ln2.lhs = base_id;
      ln2.disp = disp + scale;
      uint32_t lid2 = kNoExpr;
      st = push_expr(ln2, &lid2);
      if (st != HEX_OK) return st;

      reg_expr[rt] = lid1;
      reg_bits[rt] = bits;
      reg_written[rt] = true;
      reg_expr[rt2] = lid2;
      reg_bits[rt2] = bits;
      reg_written[rt2] = true;
      if (rt == 0u || rt2 == 0u) r0_last_va = va;
      continue;
    }

    return HEX_ERR_UNSUPPORTED;
  }

  // Must contain at least one memory instruction and balanced SP.
  if (!has_mem_op || sp_delta != 0) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Determine parameter count (highest referenced param + 1).
  uint32_t num_params = 0u;
  for (uint32_t p = 0; p < 8u; ++p) {
    if (param_read[p]) num_params = p + 1u;
  }

  // Determine return kind matching JS decompiler oracle:
  //   0 = void, 1 = void* (passthrough ptr a1), 2 = int32 (32-bit w0), 3 = uint64 (64-bit x0)
  uint8_t ret_kind = 0u;
  if (reg_written[0]) {
    ret_kind = (reg_bits[0] == 32u) ? 2u : 3u;
  } else if (param_is_ptr64[0]) {
    ret_kind = 1u;
  } else if (param_read[0]) {
    ret_kind = 3u;
  } else {
    ret_kind = 0u;
  }

  bool any_struct = false;
  for (uint32_t p = 0; p < 8u; ++p) {
    if (structs[p].used && structs[p].field_count > 0u) any_struct = true;
  }

  const bool need_int32 = (ret_kind == 2u);
  const bool need_uint64 = (ret_kind == 3u || num_params > 0u || slot_count > 0u || any_struct);
  const bool need_uint32_t = uses_u32_deref;
  const bool need_uintptr = uses_uintptr || (ret_kind == 1u);

  Vec<char> text(&emit_arena);
  if (!text.reserve(512)) return HEX_ERR_OOM;
  Vec<HexLineMapEntry> lmap(&emit_arena);
  if (!lmap.reserve(16)) return HEX_ERR_OOM;

  uint32_t line_no = 1u;
  auto finish_line = [&]() -> bool {
    if (!append_ch(text, '\n')) return false;
    ++line_no;
    return true;
  };
  auto push_lmap = [&](uint32_t ln, uint64_t va) -> bool {
    return lmap.push_back(HexLineMapEntry{ln, 0u, va});
  };

  // 1. Fixed-width integer typedef prelude
  if (!append_cstr(text, "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */") ||
      !finish_line()) {
    return HEX_ERR_OOM;
  }
  if (need_int32) {
    if (!append_cstr(text, "typedef __INT32_TYPE__ int32;") || !finish_line()) return HEX_ERR_OOM;
  }
  if (need_uint64) {
    if (!append_cstr(text, "typedef __UINT64_TYPE__ uint64;") || !finish_line()) return HEX_ERR_OOM;
  }
  if (need_uint32_t) {
    if (!append_cstr(text, "typedef __UINT32_TYPE__ uint32_t;") || !finish_line()) return HEX_ERR_OOM;
  }
  if (need_uintptr) {
    if (!append_cstr(text, "typedef __UINTPTR_TYPE__ uintptr_t;") || !finish_line()) return HEX_ERR_OOM;
  }

  // 2. Synthesized member-base structs (when 64-bit pointer derefs exist)
  if (any_struct) {
    if (!append_cstr(text, "/* hex: synthesized member-base structs. */") || !finish_line()) return HEX_ERR_OOM;
    for (uint32_t p = 0; p < 8u; ++p) {
      if (!structs[p].used || structs[p].field_count == 0u) continue;
      if (!append_cstr(text, "typedef struct hex_struct_a") ||
          !append_u64_dec(text, static_cast<uint64_t>(p) + 1ULL) ||
          !append_cstr(text, " { ")) {
        return HEX_ERR_OOM;
      }
      for (uint32_t f = 0; f < structs[p].field_count; ++f) {
        if (!append_cstr(text, "uint64 field_") ||
            !append_u64_hex(text, structs[p].offsets[f], true) ||
            !append_cstr(text, "; ")) {
          return HEX_ERR_OOM;
        }
      }
      if (!append_cstr(text, "} hex_struct_a") ||
          !append_u64_dec(text, static_cast<uint64_t>(p) + 1ULL) ||
          !append_ch(text, ';') ||
          !finish_line()) {
        return HEX_ERR_OOM;
      }
    }
  }

  // 3. Function signature
  if (!push_lmap(line_no, base_addr)) return HEX_ERR_OOM;
  if (ret_kind == 0u) {
    if (!append_cstr(text, "void ")) return HEX_ERR_OOM;
  } else if (ret_kind == 1u) {
    if (!append_cstr(text, "void * ")) return HEX_ERR_OOM;
  } else if (ret_kind == 2u) {
    if (!append_cstr(text, "int32 ")) return HEX_ERR_OOM;
  } else {
    if (!append_cstr(text, "uint64 ")) return HEX_ERR_OOM;
  }
  if (!append_str(text, clean_name.data(), clean_name.size()) || !append_ch(text, '(')) return HEX_ERR_OOM;
  if (num_params == 0u) {
    if (!append_cstr(text, "void")) return HEX_ERR_OOM;
  } else {
    for (uint32_t p = 0; p < num_params; ++p) {
      if (p > 0u && !append_cstr(text, ", ")) return HEX_ERR_OOM;
      if (!append_cstr(text, "uint64 a") || !append_u64_dec(text, static_cast<uint64_t>(p) + 1ULL)) {
        return HEX_ERR_OOM;
      }
    }
  }
  if (!append_ch(text, ')') || !finish_line()) return HEX_ERR_OOM;
  if (!append_ch(text, '{') || !finish_line()) return HEX_ERR_OOM;

  // 4. Local stack slot declarations
  for (uint32_t s = 0; s < slot_count; ++s) {
    if (!append_cstr(text, "    uint64 ") ||
        !append_local_name(text, slots[s].sp_off) ||
        !append_ch(text, ';') ||
        !finish_line()) {
      return HEX_ERR_OOM;
    }
  }

  // 5. Statements (local assignments & memory stores)
  for (size_t i = 0; i < stmts.size(); ++i) {
    const Stmt& st = stmts[i];
    if (!push_lmap(line_no, st.va)) return HEX_ERR_OOM;
    if (!append_cstr(text, "    ")) return HEX_ERR_OOM;
    if (st.kind == StmtKind::LocalAssign) {
      if (!append_local_name(text, slots[st.slot_idx].sp_off) ||
          !append_cstr(text, " = ") ||
          !emit_expr_iterative(emit_arena, exprs, st.val_expr, text) ||
          !append_ch(text, ';') ||
          !finish_line()) {
        return HEX_ERR_OOM;
      }
    } else {
      if (st.bits == 32u) {
        if (!append_cstr(text, "*(uint32_t *)((uintptr_t)(")) return HEX_ERR_OOM;
      } else {
        if (!append_cstr(text, "*(uint64 *)((uintptr_t)(")) return HEX_ERR_OOM;
      }
      if (!emit_expr_iterative(emit_arena, exprs, st.base_expr, text)) return HEX_ERR_OOM;
      if (st.bits == 32u) {
        if (!append_cstr(text, ") + ") || !append_i64_dec(text, st.disp)) return HEX_ERR_OOM;
      } else {
        if (!append_cstr(text, ") + 0x") || !append_u64_hex(text, static_cast<uint64_t>(st.disp), false)) {
          return HEX_ERR_OOM;
        }
      }
      if (!append_cstr(text, ") = ") ||
          !emit_expr_iterative(emit_arena, exprs, st.val_expr, text) ||
          !append_ch(text, ';') ||
          !finish_line()) {
        return HEX_ERR_OOM;
      }
    }
  }

  // 6. Return statement
  const uint64_t ret_va = base_addr + static_cast<uint64_t>(word_count - 1u) * 4ULL;
  if (!push_lmap(line_no, reg_written[0] ? r0_last_va : ret_va)) return HEX_ERR_OOM;
  if (ret_kind == 0u) {
    if (!append_cstr(text, "    return;") || !finish_line()) return HEX_ERR_OOM;
  } else if (ret_kind == 1u) {
    if (!append_cstr(text, "    return (void *)(uintptr_t)(a1);") || !finish_line()) return HEX_ERR_OOM;
  } else {
    if (!append_cstr(text, "    return ") ||
        !emit_expr_iterative(emit_arena, exprs, reg_expr[0], text) ||
        !append_ch(text, ';') ||
        !finish_line()) {
      return HEX_ERR_OOM;
    }
  }

  // Closing brace (no trailing newline to match JS oracle exact string)
  if (!append_ch(text, '}')) return HEX_ERR_OOM;

  // Materialize NUL-terminated output string and linemap array in emit_arena.
  const size_t tlen = text.size();
  char* out_buf = emit_arena.alloc<char>(tlen + 1u);
  if (!out_buf) return HEX_ERR_OOM;
  mem_copy(out_buf, text.data(), tlen);
  out_buf[tlen] = '\0';

  HexLineMapEntry* lm_buf = nullptr;
  if (!lmap.empty()) {
    lm_buf = emit_arena.alloc<HexLineMapEntry>(lmap.size());
    if (!lm_buf) return HEX_ERR_OOM;
    mem_copy(lm_buf, lmap.data(), lmap.size() * sizeof(HexLineMapEntry));
  }

  arena_guard.armed = false;
  *out_text = out_buf;
  *out_len = static_cast<uint32_t>(tlen);
  *out_linemap = lm_buf;
  *out_linemap_count = static_cast<uint32_t>(lmap.size());
  return HEX_OK;
}

}  // namespace passes
}  // namespace decompiler
}  // namespace hex
