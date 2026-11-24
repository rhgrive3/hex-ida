#include "c_emitter.hpp"

namespace {

// Standalone fallback scratch buffer (512 KiB) when no external arena is bound.
static constexpr size_t kFallbackArenaBytes = 512u * 1024u;
alignas(16) static uint8_t g_fallback_storage[kFallbackArenaBytes];
static hex::Arena g_fallback_arena;
static bool g_fallback_initialized = false;
static hex::Arena* g_bound_arena = nullptr;

// Output state (stored inside active scratch arena or static fallback pointers).
static char* g_out_text = nullptr;
static uint32_t g_out_text_len = 0;
static HexLineMapEntry* g_out_linemap = nullptr;
static uint32_t g_out_linemap_count = 0;

static hex::Arena* active_arena() {
  if (g_bound_arena != nullptr) return g_bound_arena;
  if (!g_fallback_initialized) {
    g_fallback_arena.init_fixed(g_fallback_storage, kFallbackArenaBytes);
    g_fallback_initialized = true;
  }
  return &g_fallback_arena;
}

static bool is_terminator(uint8_t op) {
  return op == HEX_IR_RET || op == HEX_IR_BRANCH || op == HEX_IR_CONDBR;
}

static bool is_dead_inst(const CEmitInst& inst) {
  return (inst.flags & HEX_IR_FLAG_DEAD) != 0u || inst.op == HEX_IR_NOP;
}

static bool is_pure_inlineable(const CEmitInst& inst) {
  if (is_dead_inst(inst)) return false;
  switch (inst.op) {
    case HEX_IR_CONST:
    case HEX_IR_PARAM:
    case HEX_IR_COPY:
    case HEX_IR_BINOP:
    case HEX_IR_UNOP:
    case HEX_IR_CMP:
    case HEX_IR_SELECT:
    case HEX_IR_CAST:
      return true;
    default:
      return false;
  }
}

static uint8_t normalize_width(uint16_t w) {
  if (w == 8u || w == 16u || w == 32u || w == 64u) return static_cast<uint8_t>(w);
  return 64u;
}

// Type tracking bitmask for JS-parity fixed-width typedef prelude.
enum TypeBit : uint32_t {
  TYPE_UINT8 = 1u << 0,
  TYPE_INT8 = 1u << 1,
  TYPE_UINT16 = 1u << 2,
  TYPE_INT16 = 1u << 3,
  TYPE_UINT32 = 1u << 4,
  TYPE_INT32 = 1u << 5,
  TYPE_UINT64 = 1u << 6,
  TYPE_INT64 = 1u << 7,
};

static uint32_t type_bit_for(uint8_t width, bool is_signed) {
  switch (width) {
    case 8: return is_signed ? TYPE_INT8 : TYPE_UINT8;
    case 16: return is_signed ? TYPE_INT16 : TYPE_UINT16;
    case 32: return is_signed ? TYPE_INT32 : TYPE_UINT32;
    case 64: return is_signed ? TYPE_INT64 : TYPE_UINT64;
    default: return TYPE_UINT64;
  }
}

static const char* type_name_for(uint8_t width, bool is_signed) {
  switch (width) {
    case 8: return is_signed ? "int8" : "uint8";
    case 16: return is_signed ? "int16" : "uint16";
    case 32: return is_signed ? "int32" : "uint32";
    case 64: return is_signed ? "int64" : "uint64";
    default: return "uint64";
  }
}

static const char* binop_symbol(uint8_t flags) {
  const uint8_t sub = static_cast<uint8_t>(flags & HEX_IR_FLAG_SUBOP_MASK);
  switch (sub) {
    case HEX_IR_BIN_ADD: return " + ";
    case HEX_IR_BIN_SUB: return " - ";
    case HEX_IR_BIN_MUL: return " * ";
    case HEX_IR_BIN_SDIV: return " / ";
    case HEX_IR_BIN_UDIV: return " / ";
    case HEX_IR_BIN_SREM: return " % ";
    case HEX_IR_BIN_AND: return " & ";
    case HEX_IR_BIN_OR: return " | ";
    case HEX_IR_BIN_XOR: return " ^ ";
    case HEX_IR_BIN_SHL: return " << ";
    case HEX_IR_BIN_SHR: return " >> ";
    default: return " + ";
  }
}

static uint8_t binop_precedence(uint8_t flags) {
  const uint8_t sub = static_cast<uint8_t>(flags & HEX_IR_FLAG_SUBOP_MASK);
  switch (sub) {
    case HEX_IR_BIN_MUL:
    case HEX_IR_BIN_SDIV:
    case HEX_IR_BIN_UDIV:
    case HEX_IR_BIN_SREM:
      return 12;
    case HEX_IR_BIN_ADD:
    case HEX_IR_BIN_SUB:
      return 11;
    case HEX_IR_BIN_SHL:
    case HEX_IR_BIN_SHR:
      return 10;
    case HEX_IR_BIN_AND:
      return 7;
    case HEX_IR_BIN_XOR:
      return 6;
    case HEX_IR_BIN_OR:
      return 5;
    default:
      return 11;
  }
}

static const char* cmp_symbol(uint8_t flags) {
  const uint8_t sub = static_cast<uint8_t>(flags & HEX_IR_FLAG_SUBOP_MASK);
  switch (sub) {
    case HEX_IR_CMP_EQ: return " == ";
    case HEX_IR_CMP_NE: return " != ";
    case HEX_IR_CMP_SLT:
    case HEX_IR_CMP_ULT: return " < ";
    case HEX_IR_CMP_SLE:
    case HEX_IR_CMP_ULE: return " <= ";
    case HEX_IR_CMP_SGT:
    case HEX_IR_CMP_UGT: return " > ";
    case HEX_IR_CMP_SGE:
    case HEX_IR_CMP_UGE: return " >= ";
    default: return " == ";
  }
}

static uint8_t invert_cmp_subop(uint8_t sub) {
  switch (sub) {
    case HEX_IR_CMP_EQ: return HEX_IR_CMP_NE;
    case HEX_IR_CMP_NE: return HEX_IR_CMP_EQ;
    case HEX_IR_CMP_SLT: return HEX_IR_CMP_SGE;
    case HEX_IR_CMP_SLE: return HEX_IR_CMP_SGT;
    case HEX_IR_CMP_SGT: return HEX_IR_CMP_SLE;
    case HEX_IR_CMP_SGE: return HEX_IR_CMP_SLT;
    case HEX_IR_CMP_ULT: return HEX_IR_CMP_UGE;
    case HEX_IR_CMP_ULE: return HEX_IR_CMP_UGT;
    case HEX_IR_CMP_UGT: return HEX_IR_CMP_ULE;
    case HEX_IR_CMP_UGE: return HEX_IR_CMP_ULT;
    default: return HEX_IR_CMP_NE;
  }
}

static size_t cstr_len(const char* s) {
  if (!s) return 0;
  size_t n = 0;
  while (s[n] != '\0') ++n;
  return n;
}

// O(depth) loop membership check via node_innermost_loop + loop_parent.
static bool block_in_loop(uint32_t block_id,
                          int32_t target_loop,
                          const CEmitFunctionView& view) {
  if (target_loop < 0 || static_cast<uint32_t>(target_loop) >= view.num_loops) return false;
  if (!view.node_innermost_loop || block_id >= view.num_blocks) return false;
  int32_t cur = view.node_innermost_loop[block_id];
  uint32_t steps = 0;
  while (cur >= 0 && static_cast<uint32_t>(cur) < view.num_loops && steps <= view.num_loops) {
    if (cur == target_loop) return true;
    if (!view.loop_parent) break;
    cur = view.loop_parent[cur];
    ++steps;
  }
  return false;
}

// Find loop index whose header is `block_id` (innermost loop if multiple share header).
static int32_t find_loop_with_header(uint32_t block_id, const CEmitFunctionView& view) {
  if (!view.loop_header || view.num_loops == 0) return -1;
  int32_t found = -1;
  for (uint32_t i = 0; i < view.num_loops; ++i) {
    if (view.loop_header[i] == block_id) {
      found = static_cast<int32_t>(i);
    }
  }
  return found;
}

// Safe instruction range lookup with empty-block underflow guard.
struct InstRange {
  uint32_t start;
  uint32_t end;
  bool valid;
};

static InstRange get_block_inst_range(const CEmitFunctionView& view, uint32_t bb) {
  InstRange r{0, 0, false};
  if (!view.block_inst_off || bb >= view.num_blocks) return r;
  const uint32_t s = view.block_inst_off[bb];
  const uint32_t e = view.block_inst_off[bb + 1u];
  if (s > e || e > view.num_insts) return r;
  r.start = s;
  r.end = e;
  r.valid = true;
  return r;
}

static uint64_t get_block_origin_addr(const CEmitFunctionView& view, uint32_t bb) {
  if (bb >= view.num_blocks) return view.entry_va;
  const InstRange r = get_block_inst_range(view, bb);
  if (r.valid && r.end > r.start && view.insts != nullptr) {
    // Prefer terminator's address if present, else first non-zero instruction address.
    const CEmitInst& last = view.insts[r.end - 1u];
    if (last.addr != 0u) return last.addr;
    for (uint32_t i = r.start; i < r.end; ++i) {
      if (view.insts[i].addr != 0u) return view.insts[i].addr;
    }
  }
  if (view.block_addr != nullptr && view.block_addr[bb] != 0u) {
    return view.block_addr[bb];
  }
  return view.entry_va;
}

// Bounded text & line-map builder with UINT32_MAX clamp overflow protection.
struct TextBuf {
  hex::Arena* arena;
  char* data;
  uint32_t len;
  uint32_t cap;
  uint32_t max_bytes;
  uint32_t line_no;
  bool oom;
  bool limit_hit;

  hex::Vec<HexLineMapEntry> linemap;

  TextBuf() : arena(nullptr), data(nullptr), len(0), cap(0), max_bytes(0), line_no(1u), oom(false), limit_hit(false), linemap(nullptr) {}

  void init(hex::Arena* a, uint32_t max_b) {
    arena = a;
    data = nullptr;
    len = 0;
    cap = 0;
    max_bytes = max_b;
    line_no = 1u;
    oom = false;
    limit_hit = false;
    linemap.init(a);
  }

  bool ensure_text(uint32_t add) {
    if (oom || limit_hit) return false;
    if (add == 0u) return true;
    // Clamp against max_bytes and UINT32_MAX without wrap-around.
    if (add > max_bytes || len > max_bytes - add) {
      limit_hit = true;
      return false;
    }
    if (add > UINT32_MAX - len) {
      limit_hit = true;
      return false;
    }
    const uint32_t need = len + add;
    // Reserve +1 for NUL terminator when possible (clamped at UINT32_MAX).
    const uint32_t need_nul = (need < UINT32_MAX) ? (need + 1u) : UINT32_MAX;
    if (need_nul <= cap) return true;

    uint32_t next_cap = (cap == 0u) ? 512u : cap;
    while (next_cap < need_nul) {
      if (next_cap >= (UINT32_MAX >> 1)) {
        next_cap = need_nul;
        break;
      }
      next_cap <<= 1;
    }
    if (next_cap > max_bytes && max_bytes < UINT32_MAX) {
      const uint32_t max_with_nul = max_bytes + 1u;
      if (next_cap > max_with_nul) next_cap = max_with_nul;
    }
    char* next = arena->alloc<char>(next_cap);
    if (!next) {
      oom = true;
      return false;
    }
    if (len > 0u && data != nullptr) {
      hex::mem_copy(next, data, len);
    }
    data = next;
    cap = next_cap;
    return true;
  }

  void put_char(char c) {
    if (!ensure_text(1u)) return;
    data[len++] = c;
    if (len < cap) data[len] = '\0';
    if (c == '\n') ++line_no;
  }

  void put_str_n(const char* s, uint32_t n) {
    if (!s || n == 0u) return;
    if (!ensure_text(n)) return;
    hex::mem_copy(data + len, s, n);
    for (uint32_t i = 0; i < n; ++i) {
      if (s[i] == '\n') ++line_no;
    }
    len += n;
    if (len < cap) data[len] = '\0';
  }

  void put_str(const char* s) {
    if (!s) return;
    const size_t n = cstr_len(s);
    if (n > UINT32_MAX) {
      limit_hit = true;
      return;
    }
    put_str_n(s, static_cast<uint32_t>(n));
  }

  void put_u64_dec(uint64_t v) {
    char tmp[24];
    uint32_t pos = 0;
    if (v == 0u) {
      tmp[pos++] = '0';
    } else {
      while (v > 0u) {
        tmp[pos++] = static_cast<char>('0' + (v % 10u));
        v /= 10u;
      }
    }
    if (!ensure_text(pos)) return;
    for (uint32_t i = 0; i < pos; ++i) {
      data[len++] = tmp[pos - 1u - i];
    }
    if (len < cap) data[len] = '\0';
  }

  void put_i64_dec(int64_t v) {
    if (v < 0) {
      put_char('-');
      const uint64_t mag = static_cast<uint64_t>(-(v + 1)) + 1u;
      put_u64_dec(mag);
    } else {
      put_u64_dec(static_cast<uint64_t>(v));
    }
  }

  // Always emit uppercase hex digits (e.g., 0xFFFFFFFF).
  void put_u64_hex_upper(uint64_t v) {
    static const char kHexDigits[16] = {
      '0', '1', '2', '3', '4', '5', '6', '7',
      '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'
    };
    char tmp[18];
    uint32_t pos = 0;
    if (v == 0u) {
      tmp[pos++] = '0';
    } else {
      while (v > 0u) {
        tmp[pos++] = kHexDigits[v & 0xFu];
        v >>= 4u;
      }
    }
    put_str_n("0x", 2u);
    if (!ensure_text(pos)) return;
    for (uint32_t i = 0; i < pos; ++i) {
      data[len++] = tmp[pos - 1u - i];
    }
    if (len < cap) data[len] = '\0';
  }

  void put_imm(uint64_t imm, uint16_t width, bool is_signed) {
    if (width == 32u) {
      const uint32_t u32 = static_cast<uint32_t>(imm);
      if (is_signed) {
        const int32_t s32 = static_cast<int32_t>(u32);
        if (s32 >= -999 && s32 <= 999) {
          put_i64_dec(static_cast<int64_t>(s32));
          return;
        }
      } else if (u32 <= 999u) {
        put_u64_dec(static_cast<uint64_t>(u32));
        return;
      }
      put_u64_hex_upper(static_cast<uint64_t>(u32));
      return;
    }
    if (is_signed) {
      const int64_t s64 = static_cast<int64_t>(imm);
      if (s64 >= -999 && s64 <= 999) {
        put_i64_dec(s64);
        return;
      }
    } else if (imm <= 999u) {
      put_u64_dec(imm);
      return;
    }
    put_u64_hex_upper(imm);
  }

  void record_line(uint32_t origin_block, uint64_t origin_addr) {
    HexLineMapEntry entry;
    entry.line_no = line_no;
    entry.block_id = origin_block;
    entry.addr = origin_addr;
    if (!linemap.push_back(entry)) {
      oom = true;
    }
  }
};

// Explicit iterative expression printer token.
struct ExprTok {
  enum Kind : uint8_t {
    TOK_VAL = 0,
    TOK_STR = 1,
    TOK_IMM = 2,
    TOK_LPAREN = 3,
    TOK_RPAREN = 4,
  };
  Kind kind;
  uint8_t parent_prec;
  uint8_t invert;
  uint8_t is_signed;
  uint16_t width;
  uint32_t val_id;
  uint64_t imm;
  const char* str;
};

struct EmitterCtx {
  const CEmitFunctionView& view;
  hex::Arena* arena;
  TextBuf out;
  uint32_t emit_flags;
  bool js_parity;

  // Value metadata indexed by SSA value ID [0..max_val_id).
  uint32_t max_val_id;
  int32_t* def_inst;       // instruction index defining val, or -1
  int32_t* def_block;      // block index defining val, or -1
  uint32_t* use_count;     // number of uses
  uint8_t* inlined;        // 1 if expression is folded into its single use
  uint8_t* declared;       // 1 if local variable has been declared
  uint8_t* block_emitted;  // 1 if basic block has already been emitted
  uint8_t* block_needs_label;  // 1 if targeted by a goto

  uint32_t used_types;     // bitmask of TypeBit
  uint32_t indent;
  uint32_t effective_params;

  hex::Vec<ExprTok> expr_stack;

  void put_indent() {
    const char* unit = js_parity ? "    " : "  ";
    const uint32_t unit_len = js_parity ? 4u : 2u;
    for (uint32_t i = 0; i < indent; ++i) {
      out.put_str_n(unit, unit_len);
    }
  }

  void note_type(uint8_t w, bool is_signed) {
    used_types |= type_bit_for(w, is_signed);
  }

  // Iterative expression emission (zero recursion).
  void emit_expr(uint32_t val_id, uint8_t min_prec = 0u, bool invert_cond = false) {
    expr_stack.clear();
    ExprTok root{};
    root.kind = ExprTok::TOK_VAL;
    root.parent_prec = min_prec;
    root.invert = invert_cond ? 1u : 0u;
    root.val_id = val_id;
    if (!expr_stack.push_back(root)) {
      out.oom = true;
      return;
    }

    uint32_t steps = 0;
    static constexpr uint32_t kMaxExprSteps = 4096u;
    while (!expr_stack.empty() && !out.oom && !out.limit_hit) {
      if (++steps > kMaxExprSteps) {
        out.put_str("0");
        break;
      }
      const ExprTok tok = expr_stack.back();
      expr_stack.pop_back();

      if (tok.kind == ExprTok::TOK_STR) {
        out.put_str(tok.str);
        continue;
      }
      if (tok.kind == ExprTok::TOK_LPAREN) {
        out.put_char('(');
        continue;
      }
      if (tok.kind == ExprTok::TOK_RPAREN) {
        out.put_char(')');
        continue;
      }
      if (tok.kind == ExprTok::TOK_IMM) {
        out.put_imm(tok.imm, tok.width, tok.is_signed != 0u);
        continue;
      }

      // TOK_VAL
      const uint32_t vid = tok.val_id;
      if (vid == HEX_IR_NO_VAL) {
        if (tok.invert) out.put_str("!0");
        else out.put_str("0");
        continue;
      }

      const bool can_expand =
          vid < max_val_id && def_inst[vid] >= 0 &&
          (inlined[vid] != 0u ||
           view.insts[def_inst[vid]].op == HEX_IR_PARAM ||
           view.insts[def_inst[vid]].op == HEX_IR_CONST);

      if (!can_expand) {
        if (tok.invert) out.put_char('!');
        out.put_char('v');
        out.put_u64_dec(vid);
        continue;
      }

      const CEmitInst& inst = view.insts[def_inst[vid]];
      if (inst.op == HEX_IR_PARAM) {
        if (tok.invert) out.put_char('!');
        out.put_char('a');
        out.put_u64_dec(inst.imm + 1u);
        continue;
      }
      if (inst.op == HEX_IR_CONST) {
        if (tok.invert) {
          out.put_char('!');
          out.put_char('(');
          out.put_imm(inst.imm, inst.width, (inst.flags & HEX_IR_FLAG_SIGNED) != 0u);
          out.put_char(')');
        } else {
          out.put_imm(inst.imm, inst.width, (inst.flags & HEX_IR_FLAG_SIGNED) != 0u);
        }
        continue;
      }
      if (inst.op == HEX_IR_COPY) {
        ExprTok sub{};
        sub.kind = ExprTok::TOK_VAL;
        sub.parent_prec = tok.parent_prec;
        sub.invert = tok.invert;
        sub.val_id = inst.src0;
        if (!expr_stack.push_back(sub)) out.oom = true;
        continue;
      }
      if (inst.op == HEX_IR_CMP) {
        uint8_t subop = static_cast<uint8_t>(inst.flags & HEX_IR_FLAG_SUBOP_MASK);
        if (tok.invert) {
          subop = invert_cmp_subop(subop);
        }
        const uint8_t my_prec = 8u;
        const bool need_parens = tok.parent_prec > my_prec;
        if (need_parens) {
          ExprTok rp{}; rp.kind = ExprTok::TOK_RPAREN;
          if (!expr_stack.push_back(rp)) { out.oom = true; break; }
        }
        ExprTok rhs{}; rhs.kind = ExprTok::TOK_VAL; rhs.parent_prec = my_prec + 1u; rhs.val_id = inst.src1;
        ExprTok op{}; op.kind = ExprTok::TOK_STR; op.str = cmp_symbol(subop);
        ExprTok lhs{}; lhs.kind = ExprTok::TOK_VAL; lhs.parent_prec = my_prec; lhs.val_id = inst.src0;
        if (!expr_stack.push_back(rhs) || !expr_stack.push_back(op) || !expr_stack.push_back(lhs)) {
          out.oom = true;
          break;
        }
        if (need_parens) {
          ExprTok lp{}; lp.kind = ExprTok::TOK_LPAREN;
          if (!expr_stack.push_back(lp)) { out.oom = true; break; }
        }
        continue;
      }
      if (inst.op == HEX_IR_BINOP) {
        const uint8_t my_prec = binop_precedence(inst.flags);
        const bool need_parens = (tok.parent_prec > my_prec) || (tok.invert != 0u);
        if (need_parens) {
          ExprTok rp{}; rp.kind = ExprTok::TOK_RPAREN;
          if (!expr_stack.push_back(rp)) { out.oom = true; break; }
        }
        ExprTok rhs{}; rhs.kind = ExprTok::TOK_VAL; rhs.parent_prec = my_prec + 1u; rhs.val_id = inst.src1;
        ExprTok op{}; op.kind = ExprTok::TOK_STR; op.str = binop_symbol(inst.flags);
        ExprTok lhs{}; lhs.kind = ExprTok::TOK_VAL; lhs.parent_prec = my_prec; lhs.val_id = inst.src0;
        if (!expr_stack.push_back(rhs) || !expr_stack.push_back(op) || !expr_stack.push_back(lhs)) {
          out.oom = true;
          break;
        }
        if (need_parens) {
          ExprTok lp{}; lp.kind = ExprTok::TOK_LPAREN;
          if (!expr_stack.push_back(lp)) { out.oom = true; break; }
        }
        if (tok.invert) {
          ExprTok bang{}; bang.kind = ExprTok::TOK_STR; bang.str = "!";
          if (!expr_stack.push_back(bang)) { out.oom = true; break; }
        }
        continue;
      }
      if (inst.op == HEX_IR_UNOP) {
        const uint8_t sub = static_cast<uint8_t>(inst.flags & HEX_IR_FLAG_SUBOP_MASK);
        if (tok.invert && sub == HEX_IR_UN_LNOT) {
          ExprTok inner{}; inner.kind = ExprTok::TOK_VAL; inner.parent_prec = tok.parent_prec; inner.val_id = inst.src0;
          if (!expr_stack.push_back(inner)) out.oom = true;
          continue;
        }
        const char* prefix = "-";
        if (sub == HEX_IR_UN_NEG) prefix = "-";
        else if (sub == HEX_IR_UN_NOT) prefix = "~";
        else if (sub == HEX_IR_UN_LNOT) prefix = "!";
        else if (sub == HEX_IR_UN_ZEXT) {
          const uint8_t w = normalize_width(inst.width);
          note_type(w, false);
          prefix = (w == 32u) ? "(uint32)" : "(uint64)";
        }
        if (tok.invert) {
          ExprTok rp{}; rp.kind = ExprTok::TOK_RPAREN;
          if (!expr_stack.push_back(rp)) { out.oom = true; break; }
        }
        ExprTok inner{}; inner.kind = ExprTok::TOK_VAL; inner.parent_prec = 14u; inner.val_id = inst.src0;
        ExprTok pfx{}; pfx.kind = ExprTok::TOK_STR; pfx.str = prefix;
        if (!expr_stack.push_back(inner) || !expr_stack.push_back(pfx)) {
          out.oom = true;
          break;
        }
        if (tok.invert) {
          ExprTok lp{}; lp.kind = ExprTok::TOK_STR; lp.str = "!(";
          if (!expr_stack.push_back(lp)) { out.oom = true; break; }
        }
        continue;
      }
      if (inst.op == HEX_IR_SELECT) {
        const bool need_parens = (tok.parent_prec > 2u) || (tok.invert != 0u);
        if (need_parens) {
          ExprTok rp{}; rp.kind = ExprTok::TOK_RPAREN;
          if (!expr_stack.push_back(rp)) { out.oom = true; break; }
        }
        ExprTok fval{}; fval.kind = ExprTok::TOK_VAL; fval.parent_prec = 3u; fval.val_id = inst.src2;
        ExprTok col{}; col.kind = ExprTok::TOK_STR; col.str = " : ";
        ExprTok tval{}; tval.kind = ExprTok::TOK_VAL; tval.parent_prec = 3u; tval.val_id = inst.src1;
        ExprTok qm{}; qm.kind = ExprTok::TOK_STR; qm.str = " ? ";
        ExprTok cond{}; cond.kind = ExprTok::TOK_VAL; cond.parent_prec = 3u; cond.val_id = inst.src0;
        if (!expr_stack.push_back(fval) || !expr_stack.push_back(col) ||
            !expr_stack.push_back(tval) || !expr_stack.push_back(qm) ||
            !expr_stack.push_back(cond)) {
          out.oom = true;
          break;
        }
        if (need_parens) {
          ExprTok lp{}; lp.kind = ExprTok::TOK_LPAREN;
          if (!expr_stack.push_back(lp)) { out.oom = true; break; }
        }
        if (tok.invert) {
          ExprTok bang{}; bang.kind = ExprTok::TOK_STR; bang.str = "!";
          if (!expr_stack.push_back(bang)) { out.oom = true; break; }
        }
        continue;
      }
      if (inst.op == HEX_IR_CAST) {
        const uint8_t w = normalize_width(inst.width);
        const bool is_s = (inst.flags & HEX_IR_FLAG_SIGNED) != 0u;
        note_type(w, is_s);
        if (tok.invert) {
          ExprTok rp{}; rp.kind = ExprTok::TOK_RPAREN;
          if (!expr_stack.push_back(rp)) { out.oom = true; break; }
        }
        ExprTok inner{}; inner.kind = ExprTok::TOK_VAL; inner.parent_prec = 14u; inner.val_id = inst.src0;
        ExprTok rp_cast{}; rp_cast.kind = ExprTok::TOK_RPAREN;
        ExprTok tname{}; tname.kind = ExprTok::TOK_STR; tname.str = type_name_for(w, is_s);
        ExprTok lp_cast{}; lp_cast.kind = ExprTok::TOK_LPAREN;
        if (!expr_stack.push_back(inner) || !expr_stack.push_back(rp_cast) ||
            !expr_stack.push_back(tname) || !expr_stack.push_back(lp_cast)) {
          out.oom = true;
          break;
        }
        if (tok.invert) {
          ExprTok lp{}; lp.kind = ExprTok::TOK_STR; lp.str = "!(";
          if (!expr_stack.push_back(lp)) { out.oom = true; break; }
        }
        continue;
      }

      // Fallback: emit variable name.
      if (tok.invert) out.put_char('!');
      out.put_char('v');
      out.put_u64_dec(vid);
    }
  }

  bool block_has_executable_stmts(uint32_t bb) const {
    const InstRange r = get_block_inst_range(view, bb);
    if (!r.valid || r.end <= r.start || !view.insts) return false;
    for (uint32_t i = r.start; i < r.end; ++i) {
      const CEmitInst& inst = view.insts[i];
      if (is_dead_inst(inst) || is_terminator(inst.op)) continue;
      if (inst.op == HEX_IR_PARAM || inst.op == HEX_IR_PHI) continue;
      if (inst.dst != HEX_IR_NO_VAL && inst.dst < max_val_id && inlined[inst.dst] != 0u) continue;
      if (inst.op == HEX_IR_CONST && inst.dst != HEX_IR_NO_VAL &&
          inst.dst < max_val_id && use_count[inst.dst] == 0u) {
        continue;
      }
      return true;
    }
    return false;
  }

  // Emit non-terminator statements of block `bb`.
  void emit_block_stmts(uint32_t bb) {
    const InstRange r = get_block_inst_range(view, bb);
    if (!r.valid || r.end <= r.start || !view.insts) return;
    const uint64_t fallback_addr = get_block_origin_addr(view, bb);

    for (uint32_t i = r.start; i < r.end && !out.oom && !out.limit_hit; ++i) {
      const CEmitInst& inst = view.insts[i];
      if (is_dead_inst(inst) || is_terminator(inst.op)) continue;
      if (inst.op == HEX_IR_PARAM || inst.op == HEX_IR_PHI) continue;
      if (inst.dst != HEX_IR_NO_VAL && inst.dst < max_val_id && inlined[inst.dst] != 0u) continue;
      if (inst.op == HEX_IR_CONST && inst.dst != HEX_IR_NO_VAL &&
          inst.dst < max_val_id && use_count[inst.dst] == 0u) {
        continue;
      }

      const uint64_t line_addr = inst.addr != 0u ? inst.addr : fallback_addr;
      out.record_line(bb, line_addr);
      put_indent();

      if (inst.op == HEX_IR_STORE) {
        const uint8_t w = normalize_width(inst.width);
        const bool is_s = (inst.flags & HEX_IR_FLAG_SIGNED) != 0u;
        note_type(w, is_s);
        out.put_str("*(");
        out.put_str(type_name_for(w, is_s));
        out.put_str("*)(");
        emit_expr(inst.src0);
        out.put_str(") = ");
        emit_expr(inst.src1);
        out.put_str(";\n");
        continue;
      }

      if (inst.op == HEX_IR_CALL) {
        if (inst.dst != HEX_IR_NO_VAL) {
          const uint8_t w = normalize_width(inst.width);
          const bool is_s = (inst.flags & HEX_IR_FLAG_SIGNED) != 0u;
          if (inst.dst < max_val_id && declared[inst.dst] == 0u) {
            note_type(w, is_s);
            out.put_str(type_name_for(w, is_s));
            out.put_char(' ');
            declared[inst.dst] = 1u;
          }
          out.put_char('v');
          out.put_u64_dec(inst.dst);
          out.put_str(" = ");
        }
        out.put_str("sub_");
        out.put_u64_hex_upper(inst.imm);
        out.put_char('(');
        uint32_t argc = 0;
        if (inst.src0 != HEX_IR_NO_VAL) {
          emit_expr(inst.src0);
          ++argc;
        }
        if (inst.src1 != HEX_IR_NO_VAL) {
          if (argc > 0) out.put_str(", ");
          emit_expr(inst.src1);
          ++argc;
        }
        if (inst.src2 != HEX_IR_NO_VAL) {
          if (argc > 0) out.put_str(", ");
          emit_expr(inst.src2);
        }
        out.put_str(");\n");
        continue;
      }

      // Value-producing statement: [type ]vN = <rhs>;
      if (inst.dst != HEX_IR_NO_VAL) {
        const uint8_t w = normalize_width(inst.width);
        const bool is_s = (inst.flags & HEX_IR_FLAG_SIGNED) != 0u;
        if (inst.dst < max_val_id && declared[inst.dst] == 0u) {
          note_type(w, is_s);
          out.put_str(type_name_for(w, is_s));
          out.put_char(' ');
          declared[inst.dst] = 1u;
        }
        out.put_char('v');
        out.put_u64_dec(inst.dst);
        out.put_str(" = ");

        if (inst.op == HEX_IR_LOAD) {
          note_type(w, is_s);
          out.put_str("*(");
          out.put_str(type_name_for(w, is_s));
          out.put_str("*)(");
          emit_expr(inst.src0);
          out.put_str(")");
        } else if (inst.op == HEX_IR_CONST) {
          out.put_imm(inst.imm, inst.width, is_s);
        } else if (inst.op == HEX_IR_COPY) {
          emit_expr(inst.src0);
        } else if (inst.op == HEX_IR_BINOP) {
          const uint8_t prec = binop_precedence(inst.flags);
          emit_expr(inst.src0, prec);
          out.put_str(binop_symbol(inst.flags));
          emit_expr(inst.src1, static_cast<uint8_t>(prec + 1u));
        } else if (inst.op == HEX_IR_UNOP) {
          const uint8_t sub = static_cast<uint8_t>(inst.flags & HEX_IR_FLAG_SUBOP_MASK);
          if (sub == HEX_IR_UN_NEG) out.put_char('-');
          else if (sub == HEX_IR_UN_NOT) out.put_char('~');
          else if (sub == HEX_IR_UN_LNOT) out.put_char('!');
          else if (sub == HEX_IR_UN_ZEXT) {
            note_type(w, false);
            out.put_char('(');
            out.put_str(type_name_for(w, false));
            out.put_char(')');
          }
          emit_expr(inst.src0, 14u);
        } else if (inst.op == HEX_IR_CMP) {
          emit_expr(inst.src0, 8u);
          out.put_str(cmp_symbol(inst.flags));
          emit_expr(inst.src1, 9u);
        } else if (inst.op == HEX_IR_SELECT) {
          emit_expr(inst.src0, 3u);
          out.put_str(" ? ");
          emit_expr(inst.src1, 3u);
          out.put_str(" : ");
          emit_expr(inst.src2, 3u);
        } else if (inst.op == HEX_IR_CAST) {
          note_type(w, is_s);
          out.put_char('(');
          out.put_str(type_name_for(w, is_s));
          out.put_char(')');
          emit_expr(inst.src0, 14u);
        } else {
          out.put_str("0");
        }
        out.put_str(";\n");
      }
    }
  }

  // Get terminator instruction of block `bb`, or nullptr if none / empty block.
  const CEmitInst* get_terminator(uint32_t bb) const {
    const InstRange r = get_block_inst_range(view, bb);
    if (!r.valid || r.end <= r.start || !view.insts) return nullptr;
    const CEmitInst& last = view.insts[r.end - 1u];
    if (is_terminator(last.op)) return &last;
    return nullptr;
  }

  // Get successors of block `bb`.
  uint32_t get_succs(uint32_t bb, uint32_t* out_s, uint32_t max_s) const {
    if (!view.succ_off || !view.succ_dst || bb >= view.num_blocks) return 0u;
    const uint32_t s = view.succ_off[bb];
    const uint32_t e = view.succ_off[bb + 1u];
    if (s > e) return 0u;
    uint32_t n = 0u;
    for (uint32_t i = s; i < e && n < max_s; ++i) {
      out_s[n++] = view.succ_dst[i];
    }
    return n;
  }

  // Emit break / continue / goto anchored to origin_block's address!
  void emit_transition(uint32_t origin_block,
                       uint64_t origin_addr,
                       uint32_t target_block,
                       int32_t cur_loop_id,
                       uint32_t loop_header_bb,
                       uint32_t loop_exit_bb) {
    out.record_line(origin_block, origin_addr);
    put_indent();
    if (cur_loop_id >= 0 && target_block == loop_header_bb) {
      out.put_str("continue;\n");
    } else if (cur_loop_id >= 0 && target_block == loop_exit_bb) {
      out.put_str("break;\n");
    } else {
      if (target_block < view.num_blocks) block_needs_label[target_block] = 1u;
      out.put_str("goto L_bb");
      out.put_u64_dec(target_block);
      out.put_str(";\n");
    }
  }
};

// Explicit iterative structuring work-frame (zero recursion).
struct RegionFrame {
  enum Kind : uint8_t {
    FRAME_BLOCK = 0,
    FRAME_CLOSE_BRACE = 1,
    FRAME_ELSE_OPEN = 2,
    FRAME_DO_WHILE_CLOSE = 3,
  };
  Kind kind;
  uint32_t bb;
  uint32_t stop_bb;
  int32_t loop_id;
  uint32_t loop_header_bb;
  uint32_t loop_exit_bb;
  uint32_t cond_val;
  uint8_t invert_cond;
  uint32_t origin_bb;
  uint64_t origin_addr;
};

static uint32_t find_loop_exit_block(const CEmitFunctionView& view, int32_t loop_id) {
  if (loop_id < 0 || !view.succ_off || !view.succ_dst) return HEX_IR_NO_VAL;
  for (uint32_t bb = 0; bb < view.num_blocks; ++bb) {
    if (!block_in_loop(bb, loop_id, view)) continue;
    const uint32_t s = view.succ_off[bb];
    const uint32_t e = view.succ_off[bb + 1u];
    if (s > e) continue;
    for (uint32_t i = s; i < e; ++i) {
      const uint32_t dst = view.succ_dst[i];
      if (dst < view.num_blocks && !block_in_loop(dst, loop_id, view)) {
        return dst;
      }
    }
  }
  return HEX_IR_NO_VAL;
}

static void emit_body_iterative(EmitterCtx& ctx) {
  const CEmitFunctionView& view = ctx.view;
  hex::Vec<RegionFrame> stack(ctx.arena);

  RegionFrame entry{};
  entry.kind = RegionFrame::FRAME_BLOCK;
  entry.bb = view.entry_block;
  entry.stop_bb = HEX_IR_NO_VAL;
  entry.loop_id = -1;
  entry.loop_header_bb = HEX_IR_NO_VAL;
  entry.loop_exit_bb = HEX_IR_NO_VAL;
  if (!stack.push_back(entry)) {
    ctx.out.oom = true;
    return;
  }

  uint32_t guard_steps = 0;
  const uint32_t max_steps = (view.num_blocks + 1u) * 32u + 64u;

  while (!stack.empty() && !ctx.out.oom && !ctx.out.limit_hit) {
    if (++guard_steps > max_steps) break;

    const RegionFrame f = stack.back();
    stack.pop_back();

    if (f.kind == RegionFrame::FRAME_CLOSE_BRACE) {
      if (ctx.indent > 0u) --ctx.indent;
      ctx.put_indent();
      ctx.out.put_str("}\n");
      continue;
    }

    if (f.kind == RegionFrame::FRAME_ELSE_OPEN) {
      if (ctx.indent > 0u) --ctx.indent;
      ctx.put_indent();
      ctx.out.put_str("} else {\n");
      ++ctx.indent;
      continue;
    }

    if (f.kind == RegionFrame::FRAME_DO_WHILE_CLOSE) {
      if (ctx.indent > 0u) --ctx.indent;
      ctx.out.record_line(f.origin_bb, f.origin_addr);
      ctx.put_indent();
      ctx.out.put_str("} while (");
      ctx.emit_expr(f.cond_val, 0u, f.invert_cond != 0u);
      ctx.out.put_str(");\n");
      continue;
    }

    // FRAME_BLOCK
    const uint32_t bb = f.bb;
    if (bb == HEX_IR_NO_VAL || bb >= view.num_blocks) continue;
    if (bb == f.stop_bb) continue;

    if (ctx.block_emitted[bb] != 0u) {
      // Already emitted target: emit control transfer if we have an origin, else skip.
      continue;
    }

    // Check if `bb` starts a new loop (not the currently active loop header).
    const int32_t hdr_loop = find_loop_with_header(bb, view);
    if (hdr_loop >= 0 && hdr_loop != f.loop_id) {
      const uint32_t exit_bb = find_loop_exit_block(view, hdr_loop);
      const CEmitInst* term = ctx.get_terminator(bb);
      uint32_t succs[2] = {HEX_IR_NO_VAL, HEX_IR_NO_VAL};
      const uint32_t nsucc = ctx.get_succs(bb, succs, 2u);
      const uint64_t hdr_addr = (term && term->addr != 0u) ? term->addr : get_block_origin_addr(view, bb);

      // Push post-loop continuation (exit_bb) BEFORE loop close brace so it runs after loop.
      if (exit_bb != HEX_IR_NO_VAL && exit_bb != f.stop_bb) {
        RegionFrame after{};
        after.kind = RegionFrame::FRAME_BLOCK;
        after.bb = exit_bb;
        after.stop_bb = f.stop_bb;
        after.loop_id = f.loop_id;
        after.loop_header_bb = f.loop_header_bb;
        after.loop_exit_bb = f.loop_exit_bb;
        if (!stack.push_back(after)) { ctx.out.oom = true; break; }
      }

      // Case 1: Header-tested loop (CONDBR where one arm is inside loop and one arm exits).
      if (term && term->op == HEX_IR_CONDBR && nsucc == 2u) {
        const bool t_in = block_in_loop(succs[0], hdr_loop, view);
        const bool f_in = block_in_loop(succs[1], hdr_loop, view);
        if (t_in != f_in) {
          const uint32_t body_bb = t_in ? succs[0] : succs[1];
          const uint32_t out_bb = t_in ? succs[1] : succs[0];
          const bool invert_for_continue = !t_in;
          const bool has_hdr_stmts = ctx.block_has_executable_stmts(bb);

          ctx.block_emitted[bb] = 1u;

          if (has_hdr_stmts) {
            // Review fix: header has executable statements ->
            // while (1) { <header>; if (!cond) break; <body>; }
            ctx.out.record_line(bb, hdr_addr);
            ctx.put_indent();
            ctx.out.put_str("while (1) {\n");
            ++ctx.indent;

            ctx.emit_block_stmts(bb);

            // Exit test with break anchored to header block's origin address.
            ctx.out.record_line(bb, hdr_addr);
            ctx.put_indent();
            ctx.out.put_str("if (");
            ctx.emit_expr(term->src0, 0u, !invert_for_continue);
            ctx.out.put_str(") break;\n");
          } else {
            // Pure header condition test -> while (<cond>) { <body>; }
            ctx.out.record_line(bb, hdr_addr);
            ctx.put_indent();
            ctx.out.put_str("while (");
            ctx.emit_expr(term->src0, 0u, invert_for_continue);
            ctx.out.put_str(") {\n");
            ++ctx.indent;
          }

          RegionFrame close{};
          close.kind = RegionFrame::FRAME_CLOSE_BRACE;
          if (!stack.push_back(close)) { ctx.out.oom = true; break; }

          if (body_bb != bb && body_bb < view.num_blocks) {
            RegionFrame body{};
            body.kind = RegionFrame::FRAME_BLOCK;
            body.bb = body_bb;
            body.stop_bb = bb;  // Stop when reaching back-edge to header
            body.loop_id = hdr_loop;
            body.loop_header_bb = bb;
            body.loop_exit_bb = out_bb;
            if (!stack.push_back(body)) { ctx.out.oom = true; break; }
          }
          continue;
        }
      }

      // Case 2 / Case 3: General loop -> while (1) { <header + body> }
      ctx.out.record_line(bb, hdr_addr);
      ctx.put_indent();
      ctx.out.put_str("while (1) {\n");
      ++ctx.indent;

      RegionFrame close{};
      close.kind = RegionFrame::FRAME_CLOSE_BRACE;
      if (!stack.push_back(close)) { ctx.out.oom = true; break; }

      RegionFrame inner{};
      inner.kind = RegionFrame::FRAME_BLOCK;
      inner.bb = bb;
      inner.stop_bb = exit_bb;
      inner.loop_id = hdr_loop;
      inner.loop_header_bb = bb;
      inner.loop_exit_bb = exit_bb;
      if (!stack.push_back(inner)) { ctx.out.oom = true; break; }
      continue;
    }

    // Emit current basic block.
    ctx.block_emitted[bb] = 1u;
    if (ctx.block_needs_label[bb] != 0u) {
      ctx.out.put_str("L_bb");
      ctx.out.put_u64_dec(bb);
      ctx.out.put_str(":\n");
    }

    ctx.emit_block_stmts(bb);

    const CEmitInst* term = ctx.get_terminator(bb);
    uint32_t succs[2] = {HEX_IR_NO_VAL, HEX_IR_NO_VAL};
    const uint32_t nsucc = ctx.get_succs(bb, succs, 2u);
    const uint64_t term_addr = (term && term->addr != 0u) ? term->addr : get_block_origin_addr(view, bb);

    if (term && term->op == HEX_IR_RET) {
      ctx.out.record_line(bb, term_addr);
      ctx.put_indent();
      if (term->src0 != HEX_IR_NO_VAL) {
        ctx.out.put_str("return ");
        ctx.emit_expr(term->src0);
        ctx.out.put_str(";\n");
      } else {
        ctx.out.put_str("return;\n");
      }
      continue;
    }

    if (term && term->op == HEX_IR_CONDBR && nsucc == 2u) {
      const uint32_t t_bb = succs[0];
      const uint32_t f_bb = succs[1];

      // Determine merge block via ipdom (if valid and distinct).
      uint32_t merge_bb = f.stop_bb;
      if (view.ipdom != nullptr && view.ipdom[bb] >= 0) {
        const uint32_t cand = static_cast<uint32_t>(view.ipdom[bb]);
        if (cand < view.num_blocks && cand != bb) {
          // Ensure merge_bb stays within the current loop if inside one.
          if (f.loop_id < 0 || block_in_loop(cand, f.loop_id, view) || cand == f.loop_exit_bb) {
            merge_bb = cand;
          }
        }
      }

      // Check for single-branch early break/continue inside a loop.
      const bool t_is_loop_ctrl =
          (f.loop_id >= 0) && (t_bb == f.loop_header_bb || t_bb == f.loop_exit_bb);
      const bool f_is_loop_ctrl =
          (f.loop_id >= 0) && (f_bb == f.loop_header_bb || f_bb == f.loop_exit_bb);

      if (t_is_loop_ctrl && !f_is_loop_ctrl) {
        ctx.out.record_line(bb, term_addr);
        ctx.put_indent();
        ctx.out.put_str("if (");
        ctx.emit_expr(term->src0, 0u, false);
        ctx.out.put_str(") {\n");
        ++ctx.indent;
        ctx.emit_transition(bb, term_addr, t_bb, f.loop_id, f.loop_header_bb, f.loop_exit_bb);
        --ctx.indent;
        ctx.put_indent();
        ctx.out.put_str("}\n");

        if (f_bb != f.stop_bb && f_bb < view.num_blocks) {
          if (ctx.block_emitted[f_bb] == 0u) {
            RegionFrame next = f;
            next.bb = f_bb;
            if (!stack.push_back(next)) { ctx.out.oom = true; break; }
          } else {
            ctx.emit_transition(bb, term_addr, f_bb, f.loop_id, f.loop_header_bb, f.loop_exit_bb);
          }
        }
        continue;
      }

      if (f_is_loop_ctrl && !t_is_loop_ctrl) {
        ctx.out.record_line(bb, term_addr);
        ctx.put_indent();
        ctx.out.put_str("if (");
        ctx.emit_expr(term->src0, 0u, true);
        ctx.out.put_str(") {\n");
        ++ctx.indent;
        ctx.emit_transition(bb, term_addr, f_bb, f.loop_id, f.loop_header_bb, f.loop_exit_bb);
        --ctx.indent;
        ctx.put_indent();
        ctx.out.put_str("}\n");

        if (t_bb != f.stop_bb && t_bb < view.num_blocks) {
          if (ctx.block_emitted[t_bb] == 0u) {
            RegionFrame next = f;
            next.bb = t_bb;
            if (!stack.push_back(next)) { ctx.out.oom = true; break; }
          } else {
            ctx.emit_transition(bb, term_addr, t_bb, f.loop_id, f.loop_header_bb, f.loop_exit_bb);
          }
        }
        continue;
      }

      // Standard if / if-else structuring.
      const bool has_then = (t_bb != merge_bb) && (t_bb < view.num_blocks) && (ctx.block_emitted[t_bb] == 0u);
      const bool has_else = (f_bb != merge_bb) && (f_bb < view.num_blocks) && (ctx.block_emitted[f_bb] == 0u);

      // Push continuation at merge_bb first (runs after if/else closes).
      if (merge_bb != f.stop_bb && merge_bb != HEX_IR_NO_VAL && merge_bb < view.num_blocks) {
        RegionFrame cont = f;
        cont.bb = merge_bb;
        if (!stack.push_back(cont)) { ctx.out.oom = true; break; }
      }

      if (has_then && has_else) {
        ctx.out.record_line(bb, term_addr);
        ctx.put_indent();
        ctx.out.put_str("if (");
        ctx.emit_expr(term->src0, 0u, false);
        ctx.out.put_str(") {\n");
        ++ctx.indent;

        RegionFrame close{}; close.kind = RegionFrame::FRAME_CLOSE_BRACE;
        RegionFrame else_b = f; else_b.bb = f_bb; else_b.stop_bb = merge_bb;
        RegionFrame else_open{}; else_open.kind = RegionFrame::FRAME_ELSE_OPEN;
        RegionFrame then_b = f; then_b.bb = t_bb; then_b.stop_bb = merge_bb;

        if (!stack.push_back(close) || !stack.push_back(else_b) ||
            !stack.push_back(else_open) || !stack.push_back(then_b)) {
          ctx.out.oom = true;
          break;
        }
      } else if (has_then) {
        ctx.out.record_line(bb, term_addr);
        ctx.put_indent();
        ctx.out.put_str("if (");
        ctx.emit_expr(term->src0, 0u, false);
        ctx.out.put_str(") {\n");
        ++ctx.indent;

        RegionFrame close{}; close.kind = RegionFrame::FRAME_CLOSE_BRACE;
        RegionFrame then_b = f; then_b.bb = t_bb; then_b.stop_bb = merge_bb;
        if (!stack.push_back(close) || !stack.push_back(then_b)) {
          ctx.out.oom = true;
          break;
        }
      } else if (has_else) {
        ctx.out.record_line(bb, term_addr);
        ctx.put_indent();
        ctx.out.put_str("if (");
        ctx.emit_expr(term->src0, 0u, true);
        ctx.out.put_str(") {\n");
        ++ctx.indent;

        RegionFrame close{}; close.kind = RegionFrame::FRAME_CLOSE_BRACE;
        RegionFrame else_b = f; else_b.bb = f_bb; else_b.stop_bb = merge_bb;
        if (!stack.push_back(close) || !stack.push_back(else_b)) {
          ctx.out.oom = true;
          break;
        }
      } else {
        // Both arms already emitted or loop transitions: emit explicit transitions anchored to origin `bb`.
        if (t_bb != merge_bb) {
          ctx.out.record_line(bb, term_addr);
          ctx.put_indent();
          ctx.out.put_str("if (");
          ctx.emit_expr(term->src0, 0u, false);
          ctx.out.put_str(") {\n");
          ++ctx.indent;
          ctx.emit_transition(bb, term_addr, t_bb, f.loop_id, f.loop_header_bb, f.loop_exit_bb);
          --ctx.indent;
          ctx.put_indent();
          ctx.out.put_str("}\n");
        }
        if (f_bb != merge_bb) {
          ctx.emit_transition(bb, term_addr, f_bb, f.loop_id, f.loop_header_bb, f.loop_exit_bb);
        }
      }
      continue;
    }

    // Unconditional branch or fallthrough.
    if (nsucc >= 1u) {
      const uint32_t next_bb = succs[0];
      if (next_bb == f.stop_bb) {
        // Implicitly falls through to loop header or merge point.
        continue;
      }
      if (f.loop_id >= 0 && (next_bb == f.loop_header_bb || next_bb == f.loop_exit_bb)) {
        ctx.emit_transition(bb, term_addr, next_bb, f.loop_id, f.loop_header_bb, f.loop_exit_bb);
        continue;
      }
      if (next_bb < view.num_blocks && ctx.block_emitted[next_bb] == 0u) {
        RegionFrame next = f;
        next.bb = next_bb;
        if (!stack.push_back(next)) { ctx.out.oom = true; break; }
      } else if (next_bb < view.num_blocks) {
        ctx.emit_transition(bb, term_addr, next_bb, f.loop_id, f.loop_header_bb, f.loop_exit_bb);
      }
    }
  }
}

static void emit_js_parity_prelude(TextBuf& buf, uint32_t used_types) {
  if (used_types == 0u) return;
  buf.put_str(
      "/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */\n");
  struct TypeDecl {
    uint32_t bit;
    const char* line;
  };
  static const TypeDecl kDecls[] = {
    {TYPE_UINT8,  "typedef __UINT8_TYPE__ uint8;\n"},
    {TYPE_INT8,   "typedef __INT8_TYPE__ int8;\n"},
    {TYPE_UINT16, "typedef __UINT16_TYPE__ uint16;\n"},
    {TYPE_INT16,  "typedef __INT16_TYPE__ int16;\n"},
    {TYPE_UINT32, "typedef __UINT32_TYPE__ uint32;\n"},
    {TYPE_INT32,  "typedef __INT32_TYPE__ int32;\n"},
    {TYPE_UINT64, "typedef __UINT64_TYPE__ uint64;\n"},
    {TYPE_INT64,  "typedef __INT64_TYPE__ int64;\n"},
  };
  for (size_t i = 0; i < sizeof(kDecls) / sizeof(kDecls[0]); ++i) {
    if ((used_types & kDecls[i].bit) != 0u) {
      buf.put_str(kDecls[i].line);
    }
  }
  buf.put_char('\n');
}

static void emit_signature(TextBuf& buf,
                           const CEmitFunctionView& view,
                           uint32_t num_params,
                           uint32_t* used_types_out) {
  if (view.ret_width == 0u) {
    buf.put_str("void ");
  } else {
    const uint8_t rw = normalize_width(view.ret_width);
    const bool rs = view.ret_is_signed != 0u;
    if (used_types_out) *used_types_out |= type_bit_for(rw, rs);
    buf.put_str(type_name_for(rw, rs));
    buf.put_char(' ');
  }

  if (view.func_name != nullptr && view.func_name_len > 0u) {
    buf.put_str_n(view.func_name, view.func_name_len);
  } else {
    buf.put_str("sub_");
    buf.put_u64_hex_upper(view.entry_va);
  }

  buf.put_char('(');
  if (num_params == 0u) {
    buf.put_str("void");
  } else {
    for (uint32_t i = 0; i < num_params; ++i) {
      if (i > 0u) buf.put_str(", ");
      if (used_types_out) *used_types_out |= TYPE_UINT64;
      buf.put_str("uint64 a");
      buf.put_u64_dec(i + 1u);
    }
  }
  buf.put_str(") {\n");
}

static int32_t emit_c_impl(const CEmitFunctionView* view,
                           uint32_t max_bytes,
                           uint32_t emit_flags) {
  g_out_text = nullptr;
  g_out_text_len = 0u;
  g_out_linemap = nullptr;
  g_out_linemap_count = 0u;

  if (!view || max_bytes == 0u) return HEX_ERR_INVALID_ARG;
  if (view->num_blocks == 0u || view->entry_block >= view->num_blocks) return HEX_ERR_INVALID_ARG;
  if (!view->block_inst_off) return HEX_ERR_INVALID_ARG;
  if (view->num_insts > 0u && !view->insts) return HEX_ERR_INVALID_ARG;

  // Validate block_inst_off monotonicity and bounds (guards against empty/corrupt tables).
  for (uint32_t bb = 0; bb < view->num_blocks; ++bb) {
    const uint32_t s = view->block_inst_off[bb];
    const uint32_t e = view->block_inst_off[bb + 1u];
    if (s > e || e > view->num_insts) return HEX_ERR_INVALID_ARG;
  }

  hex::Arena* arena = active_arena();
  if (!arena) return HEX_ERR_INTERNAL;
  arena->reset();

  // Compute max SSA value ID and parameter count.
  uint32_t max_val = 0u;
  uint32_t inferred_params = view->num_params;
  for (uint32_t i = 0; i < view->num_insts; ++i) {
    const CEmitInst& inst = view->insts[i];
    if (inst.dst != HEX_IR_NO_VAL && inst.dst + 1u > max_val) max_val = inst.dst + 1u;
    if (inst.src0 != HEX_IR_NO_VAL && inst.src0 + 1u > max_val) max_val = inst.src0 + 1u;
    if (inst.src1 != HEX_IR_NO_VAL && inst.src1 + 1u > max_val) max_val = inst.src1 + 1u;
    if (inst.src2 != HEX_IR_NO_VAL && inst.src2 + 1u > max_val) max_val = inst.src2 + 1u;
    if (inst.op == HEX_IR_PARAM && inst.imm < 32u) {
      const uint32_t p = static_cast<uint32_t>(inst.imm) + 1u;
      if (p > inferred_params) inferred_params = p;
    }
  }
  if (max_val == 0u) max_val = 1u;

  int32_t* def_inst = arena->alloc<int32_t>(max_val);
  int32_t* def_block = arena->alloc<int32_t>(max_val);
  uint32_t* use_count = hex::arena_alloc_zeroed<uint32_t>(*arena, max_val);
  uint8_t* inlined = hex::arena_alloc_zeroed<uint8_t>(*arena, max_val);
  uint8_t* declared = hex::arena_alloc_zeroed<uint8_t>(*arena, max_val);
  uint8_t* block_emitted = hex::arena_alloc_zeroed<uint8_t>(*arena, view->num_blocks);
  uint8_t* block_needs_label = hex::arena_alloc_zeroed<uint8_t>(*arena, view->num_blocks);

  if (!def_inst || !def_block || !use_count || !inlined || !declared ||
      !block_emitted || !block_needs_label) {
    return HEX_ERR_OOM;
  }

  for (uint32_t v = 0; v < max_val; ++v) {
    def_inst[v] = -1;
    def_block[v] = -1;
  }

  // Record definitions and use counts.
  for (uint32_t bb = 0; bb < view->num_blocks; ++bb) {
    const InstRange r = get_block_inst_range(*view, bb);
    if (!r.valid) continue;
    for (uint32_t i = r.start; i < r.end; ++i) {
      const CEmitInst& inst = view->insts[i];
      if (is_dead_inst(inst)) continue;
      if (inst.dst != HEX_IR_NO_VAL && inst.dst < max_val && def_inst[inst.dst] < 0) {
        def_inst[inst.dst] = static_cast<int32_t>(i);
        def_block[inst.dst] = static_cast<int32_t>(bb);
      }
      if (inst.src0 != HEX_IR_NO_VAL && inst.src0 < max_val) ++use_count[inst.src0];
      if (inst.src1 != HEX_IR_NO_VAL && inst.src1 < max_val) ++use_count[inst.src1];
      if (inst.src2 != HEX_IR_NO_VAL && inst.src2 < max_val) ++use_count[inst.src2];
    }
  }

  // Mark single-use pure expressions within the same block for folding (enables `return a1 + a2;`).
  for (uint32_t bb = 0; bb < view->num_blocks; ++bb) {
    const InstRange r = get_block_inst_range(*view, bb);
    if (!r.valid) continue;
    for (uint32_t i = r.start; i < r.end; ++i) {
      const CEmitInst& inst = view->insts[i];
      if (is_dead_inst(inst)) continue;
      const uint32_t srcs[3] = {inst.src0, inst.src1, inst.src2};
      for (uint32_t k = 0; k < 3u; ++k) {
        const uint32_t sv = srcs[k];
        if (sv == HEX_IR_NO_VAL || sv >= max_val) continue;
        if (def_inst[sv] >= 0 && def_block[sv] == static_cast<int32_t>(bb) &&
            use_count[sv] == 1u && is_pure_inlineable(view->insts[def_inst[sv]])) {
          inlined[sv] = 1u;
        }
      }
    }
  }

  // Emit function body first into body buffer so we know exact `used_types` for JS-parity prelude.
  EmitterCtx ctx{*view, arena, TextBuf(), emit_flags, (emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u,
                 max_val, def_inst, def_block, use_count, inlined, declared,
                 block_emitted, block_needs_label, 0u, 1u, inferred_params, hex::Vec<ExprTok>(arena)};
  ctx.out.init(arena, max_bytes);

  emit_body_iterative(ctx);
  if (ctx.out.oom) return HEX_ERR_OOM;
  if (ctx.out.limit_hit) return HEX_ERR_RESOURCE_LIMIT;

  // Assemble final output: [JS-parity prelude] + signature + body + closing brace.
  TextBuf final_buf;
  final_buf.init(arena, max_bytes);

  uint32_t sig_types = ctx.used_types;
  if (view->ret_width != 0u) {
    sig_types |= type_bit_for(normalize_width(view->ret_width), view->ret_is_signed != 0u);
  }
  if (inferred_params > 0u) {
    sig_types |= TYPE_UINT64;
  }

  if (ctx.js_parity) {
    emit_js_parity_prelude(final_buf, sig_types);
  }
  emit_signature(final_buf, *view, inferred_params, nullptr);

  const uint32_t body_line_offset = final_buf.line_no - 1u;
  if (ctx.out.len > 0u && ctx.out.data != nullptr) {
    final_buf.put_str_n(ctx.out.data, ctx.out.len);
  }
  final_buf.put_str("}\n");

  if (final_buf.oom) return HEX_ERR_OOM;
  if (final_buf.limit_hit) return HEX_ERR_RESOURCE_LIMIT;

  // Adjust body line map entries by header/prelude line count.
  const size_t lm_count = ctx.out.linemap.size();
  HexLineMapEntry* lm_out = nullptr;
  if (lm_count > 0u) {
    lm_out = arena->alloc<HexLineMapEntry>(lm_count);
    if (!lm_out) return HEX_ERR_OOM;
    for (size_t i = 0; i < lm_count; ++i) {
      lm_out[i] = ctx.out.linemap[i];
      lm_out[i].line_no += body_line_offset;
    }
  }

  g_out_text = final_buf.data;
  g_out_text_len = final_buf.len;
  g_out_linemap = lm_out;
  g_out_linemap_count = static_cast<uint32_t>(lm_count);
  return HEX_OK;
}

}  // namespace

namespace hex {
namespace decompiler {

void bind_arena(hex::Arena* scratch_arena) {
  g_bound_arena = scratch_arena;
}

}  // namespace decompiler
}  // namespace hex

extern "C" {

HEX_WASM_EXPORT("hex_decomp_reset")
void hex_decomp_reset(void) {
  g_out_text = nullptr;
  g_out_text_len = 0u;
  g_out_linemap = nullptr;
  g_out_linemap_count = 0u;
  hex::Arena* arena = active_arena();
  if (arena) arena->reset();
}

HEX_WASM_EXPORT("hex_decomp_emit_c")
int32_t hex_decomp_emit_c(const CEmitFunctionView* view, uint32_t max_bytes) {
  return emit_c_impl(view, max_bytes, HEX_EMIT_FLAG_NONE);
}

HEX_WASM_EXPORT("hex_decomp_emit_c_ex")
int32_t hex_decomp_emit_c_ex(const CEmitFunctionView* view,
                             uint32_t max_bytes,
                             uint32_t emit_flags) {
  return emit_c_impl(view, max_bytes, emit_flags);
}

HEX_WASM_EXPORT("hex_decomp_get_text_ptr")
const char* hex_decomp_get_text_ptr(void) {
  return g_out_text;
}

HEX_WASM_EXPORT("hex_decomp_get_text_len")
uint32_t hex_decomp_get_text_len(void) {
  return g_out_text_len;
}

HEX_WASM_EXPORT("hex_decomp_get_linemap_ptr")
const HexLineMapEntry* hex_decomp_get_linemap_ptr(void) {
  return g_out_linemap;
}

HEX_WASM_EXPORT("hex_decomp_get_linemap_count")
uint32_t hex_decomp_get_linemap_count(void) {
  return g_out_linemap_count;
}

}  // extern "C"
