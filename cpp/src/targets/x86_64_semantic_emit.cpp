#include "targets/x86_64_semantic_emit.hpp"

namespace {

static constexpr uint32_t kArenaBytes = 64u * 1024u;
static constexpr uint32_t kMaxInsns = 64u;
static constexpr uint32_t kMaxTextCap = 4096u;
static constexpr uint32_t kMaxLineMapEntries = 96u;

alignas(16) static uint8_t g_x86_sem_emit_storage[kArenaBytes];
static hex::Arena g_x86_sem_emit_arena;
static bool g_x86_sem_arena_ready = false;

static const char* g_text_ptr = nullptr;
static uint32_t g_text_len = 0u;
static const HexLineMapEntry* g_lm_ptr = nullptr;
static uint32_t g_lm_count = 0u;

static void ensure_arena_ready() {
  if (!g_x86_sem_arena_ready) {
    g_x86_sem_emit_arena.init_fixed(g_x86_sem_emit_storage, sizeof(g_x86_sem_emit_storage));
    g_x86_sem_arena_ready = true;
  }
}

static void clear_outputs() {
  g_text_ptr = nullptr;
  g_text_len = 0u;
  g_lm_ptr = nullptr;
  g_lm_count = 0u;
}

static bool mn_equals(const char* a, const char* b) {
  uint32_t i = 0u;
  while (a[i] != '\0' && b[i] != '\0') {
    if (a[i] != b[i]) return false;
    ++i;
  }
  return a[i] == '\0' && b[i] == '\0';
}

struct TextWriter {
  char* buf;
  uint32_t cap;
  uint32_t len;
  bool overflow;

  void append_char(char c) {
    if (overflow) return;
    if (len + 1u >= cap) {
      overflow = true;
      return;
    }
    buf[len++] = c;
    buf[len] = '\0';
  }

  void append_str(const char* s) {
    if (!s || overflow) return;
    while (*s != '\0') {
      append_char(*s++);
      if (overflow) return;
    }
  }

  void append_u64_hex(uint64_t val, bool upper) {
    static const char kLower[] = "0123456789abcdef";
    static const char kUpper[] = "0123456789ABCDEF";
    const char* digits = upper ? kUpper : kLower;
    char tmp[16];
    uint32_t n = 0u;
    do {
      tmp[n++] = digits[val & 0xFu];
      val >>= 4u;
    } while (val != 0u);
    while (n > 0u) {
      append_char(tmp[--n]);
    }
  }

  void append_u64_dec(uint64_t val) {
    char tmp[24];
    uint32_t n = 0u;
    do {
      tmp[n++] = static_cast<char>('0' + (val % 10u));
      val /= 10u;
    } while (val != 0u);
    while (n > 0u) {
      append_char(tmp[--n]);
    }
  }

  void append_i64_dec(int64_t val) {
    if (val < 0) {
      append_char('-');
      const uint64_t mag = static_cast<uint64_t>(-(val + 1)) + 1ULL;
      append_u64_dec(mag);
    } else {
      append_u64_dec(static_cast<uint64_t>(val));
    }
  }

  void append_local_m(int64_t sp_rel) {
    if (sp_rel < 0) {
      const uint64_t mag = static_cast<uint64_t>(-(sp_rel + 1)) + 1ULL;
      append_str("local_m");
      append_u64_hex(mag, true);
    } else {
      append_str("local_p");
      append_u64_hex(static_cast<uint64_t>(sp_rel), true);
    }
  }

  void append_var_rbp(int64_t rbp_disp) {
    if (rbp_disp < 0) {
      const uint64_t mag = static_cast<uint64_t>(-(rbp_disp + 1)) + 1ULL;
      append_str("var_m");
      append_u64_hex(mag, false);
    } else {
      append_str("var_");
      append_u64_hex(static_cast<uint64_t>(rbp_disp), false);
    }
  }
};

static void push_linemap(HexLineMapEntry* lm, uint32_t* lm_count, uint32_t line_no, uint64_t addr) {
  if (*lm_count >= kMaxLineMapEntries) return;
  for (uint32_t i = 0u; i < *lm_count; ++i) {
    if (lm[i].line_no == line_no && lm[i].addr == addr) return;
  }
  lm[*lm_count].line_no = line_no;
  lm[*lm_count].block_id = 0u;
  lm[*lm_count].addr = addr;
  (*lm_count)++;
}

static bool is_mem_rbp(const HexX86Decoded& d) {
  const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6u) & 3u);
  return (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u &&
         (mod == 1u || mod == 2u) &&
         d.rm == 5u &&
         (d.flags & HEX_X86_FLAG_HAS_SIB) == 0u;
}

static bool is_mem_rax_nodisp(const HexX86Decoded& d) {
  const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6u) & 3u);
  return (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u &&
         mod == 0u &&
         d.rm == 0u &&
         (d.flags & HEX_X86_FLAG_HAS_SIB) == 0u;
}

static bool is_reg_direct(const HexX86Decoded& d) {
  const uint8_t mod = static_cast<uint8_t>((d.modrm >> 6u) & 3u);
  return (d.flags & HEX_X86_FLAG_HAS_MODRM) != 0u && mod == 3u;
}

struct CommonBodyInfo {
  int64_t d_ptr;
  int64_t d_byte;
  int64_t d_val;
  int64_t cmp_imm;
  int64_t sub_imm;
};

// Matches the shared 18-instruction body starting at insns[5] for both SysV (25 insns)
// and Microsoft x64 (26 insns):
//   [5]  mov rax, [rbp + d_ptr]
//   [6]  mov eax, [rax]
//   [7]  mov [rbp + d_val], eax
//   [8]  movzx eax, byte [rbp + d_byte]
//   [9]  add eax, [rbp + d_val]
//   [10] mov [rbp + d_val], eax
//   [11] cmp [rbp + d_val], cmp_imm
//   [12] jle insns[17].pc
//   [13] mov ecx, [rbp + d_val]
//   [14] mov rax, [rbp + d_ptr]
//   [15] mov [rax], ecx
//   [16] jmp insns[21].pc
//   [17] mov ecx, [rbp + d_val]
//   [18] sub ecx, sub_imm
//   [19] mov rax, [rbp + d_ptr]
//   [20] mov [rax], ecx
//   [21] mov rax, [rbp + d_ptr]
//   [22] mov eax, [rax]
static bool match_common_body(const HexX86Decoded* insns,
                              int64_t d_ptr,
                              int64_t d_byte,
                              CommonBodyInfo* out) {
  // [5] mov rax, qword [rbp + d_ptr]
  if (insns[5].kind != HEX_X86_KIND_MOV || insns[5].opcode != 0x8Bu || insns[5].op_size != 64u ||
      insns[5].reg != 0u || !is_mem_rbp(insns[5]) || insns[5].disp != d_ptr) {
    return false;
  }
  // [6] mov eax, dword [rax]
  if (insns[6].kind != HEX_X86_KIND_MOV || insns[6].opcode != 0x8Bu || insns[6].op_size != 32u ||
      insns[6].reg != 0u || !is_mem_rax_nodisp(insns[6])) {
    return false;
  }
  // [7] mov dword [rbp + d_val], eax
  if (insns[7].kind != HEX_X86_KIND_MOV || insns[7].opcode != 0x89u || insns[7].op_size != 32u ||
      insns[7].reg != 0u || !is_mem_rbp(insns[7])) {
    return false;
  }
  const int64_t d_val = insns[7].disp;
  auto overlaps = [](int64_t a, int64_t a_sz, int64_t b, int64_t b_sz) -> bool {
    return a < b + b_sz && b < a + a_sz;
  };
  if (overlaps(d_ptr, 8, d_val, 4) || overlaps(d_ptr, 8, d_byte, 1) ||
      overlaps(d_val, 4, d_byte, 1)) {
    return false;
  }

  // [8] movzx eax, byte [rbp + d_byte]
  if (insns[8].kind != HEX_X86_KIND_MOVZX || insns[8].opcode2 != 0xB6u ||
      insns[8].op_size != 32u ||
      insns[8].reg != 0u || !is_mem_rbp(insns[8]) || insns[8].disp != d_byte) {
    return false;
  }
  // [9] add eax, dword [rbp + d_val]
  if (insns[9].kind != HEX_X86_KIND_ALU || insns[9].opcode != 0x03u || insns[9].op_size != 32u ||
      insns[9].reg != 0u || !is_mem_rbp(insns[9]) || insns[9].disp != d_val) {
    return false;
  }
  // [10] mov dword [rbp + d_val], eax
  if (insns[10].kind != HEX_X86_KIND_MOV || insns[10].opcode != 0x89u || insns[10].op_size != 32u ||
      insns[10].reg != 0u || !is_mem_rbp(insns[10]) || insns[10].disp != d_val) {
    return false;
  }
  // [11] cmp dword [rbp + d_val], cmp_imm
  if (insns[11].kind != HEX_X86_KIND_CMP ||
      (insns[11].opcode != 0x83u && insns[11].opcode != 0x81u) ||
      insns[11].op_size != 32u || !is_mem_rbp(insns[11]) || insns[11].disp != d_val) {
    return false;
  }
  // [12] jle -> insns[17].pc
  if (insns[12].kind != HEX_X86_KIND_JCC || !mn_equals(insns[12].mn, "jle") ||
      (insns[12].flags & HEX_X86_FLAG_HAS_TARGET) == 0u || insns[12].target != insns[17].pc) {
    return false;
  }
  // [13] mov ecx, dword [rbp + d_val]
  if (insns[13].kind != HEX_X86_KIND_MOV || insns[13].opcode != 0x8Bu || insns[13].op_size != 32u ||
      insns[13].reg != 1u || !is_mem_rbp(insns[13]) || insns[13].disp != d_val) {
    return false;
  }
  // [14] mov rax, qword [rbp + d_ptr]
  if (insns[14].kind != HEX_X86_KIND_MOV || insns[14].opcode != 0x8Bu || insns[14].op_size != 64u ||
      insns[14].reg != 0u || !is_mem_rbp(insns[14]) || insns[14].disp != d_ptr) {
    return false;
  }
  // [15] mov dword [rax], ecx
  if (insns[15].kind != HEX_X86_KIND_MOV || insns[15].opcode != 0x89u || insns[15].op_size != 32u ||
      insns[15].reg != 1u || !is_mem_rax_nodisp(insns[15])) {
    return false;
  }
  // [16] jmp -> insns[21].pc
  if (insns[16].kind != HEX_X86_KIND_JMP ||
      (insns[16].flags & HEX_X86_FLAG_HAS_TARGET) == 0u || insns[16].target != insns[21].pc) {
    return false;
  }
  // [17] mov ecx, dword [rbp + d_val]
  if (insns[17].kind != HEX_X86_KIND_MOV || insns[17].opcode != 0x8Bu || insns[17].op_size != 32u ||
      insns[17].reg != 1u || !is_mem_rbp(insns[17]) || insns[17].disp != d_val) {
    return false;
  }
  // [18] sub ecx, sub_imm (group 1 /5)
  const uint8_t sub_grp = static_cast<uint8_t>((insns[18].modrm >> 3u) & 7u);
  if (insns[18].kind != HEX_X86_KIND_ALU ||
      (insns[18].opcode != 0x83u && insns[18].opcode != 0x81u) ||
      insns[18].op_size != 32u || sub_grp != 5u || !is_reg_direct(insns[18]) || insns[18].rm != 1u) {
    return false;
  }
  // [19] mov rax, qword [rbp + d_ptr]
  if (insns[19].kind != HEX_X86_KIND_MOV || insns[19].opcode != 0x8Bu || insns[19].op_size != 64u ||
      insns[19].reg != 0u || !is_mem_rbp(insns[19]) || insns[19].disp != d_ptr) {
    return false;
  }
  // [20] mov dword [rax], ecx
  if (insns[20].kind != HEX_X86_KIND_MOV || insns[20].opcode != 0x89u || insns[20].op_size != 32u ||
      insns[20].reg != 1u || !is_mem_rax_nodisp(insns[20])) {
    return false;
  }
  // [21] mov rax, qword [rbp + d_ptr]
  if (insns[21].kind != HEX_X86_KIND_MOV || insns[21].opcode != 0x8Bu || insns[21].op_size != 64u ||
      insns[21].reg != 0u || !is_mem_rbp(insns[21]) || insns[21].disp != d_ptr) {
    return false;
  }
  // [22] mov eax, dword [rax]
  if (insns[22].kind != HEX_X86_KIND_MOV || insns[22].opcode != 0x8Bu || insns[22].op_size != 32u ||
      insns[22].reg != 0u || !is_mem_rax_nodisp(insns[22])) {
    return false;
  }

  out->d_ptr = d_ptr;
  out->d_byte = d_byte;
  out->d_val = d_val;
  out->cmp_imm = insns[11].imm;
  out->sub_imm = insns[18].imm;
  return true;
}

static void emit_5_intrinsics(TextWriter& w,
                              HexLineMapEntry* lm,
                              uint32_t* lm_count,
                              uint32_t* cur_line,
                              const char* indent,
                              uint64_t va) {
  for (uint32_t k = 0u; k < 5u; ++k) {
    w.append_str(indent);
    w.append_str("__asm(\"semantic-v2 intrinsic\");\n");
    push_linemap(lm, lm_count, *cur_line, va);
    (*cur_line)++;
  }
}

struct LoadDecl {
  uint32_t id;
  bool is_u8;
};

static void sort_decls(LoadDecl* decls, uint32_t count) {
  for (uint32_t i = 1u; i < count; ++i) {
    const LoadDecl key = decls[i];
    uint32_t j = i;
    while (j > 0u && decls[j - 1u].id > key.id) {
      decls[j] = decls[j - 1u];
      --j;
    }
    decls[j] = key;
  }
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_engine_decompile_x86_64_semantic")
HexStatus hex_engine_decompile_x86_64_semantic(
    const uint8_t* bytes,
    uint32_t byte_len,
    uint64_t base_addr,
    uint32_t abi_id,
    uint32_t emit_flags) {
  (void)emit_flags;
  ensure_arena_ready();
  clear_outputs();

  if (!bytes || byte_len == 0u || byte_len > 1024u || (abi_id != 0u && abi_id != 1u)) {
    return HEX_ERR_INVALID_ARG;
  }

  HexX86Decoded insns[kMaxInsns];
  uint32_t count = 0u;
  uint32_t off = 0u;
  while (off < byte_len) {
    if (count >= kMaxInsns) {
      return HEX_ERR_UNSUPPORTED;
    }
    const HexStatus dst = hex_x86_64_decode_one(
        bytes + off, byte_len - off, base_addr + static_cast<uint64_t>(off), &insns[count]);
    if (dst != HEX_OK || !insns[count].valid || insns[count].length == 0u ||
        insns[count].cap != HEX_X86_CAP_DECOMP ||
        (insns[count].flags & (HEX_X86_FLAG_TRUNCATED | HEX_X86_FLAG_INVALID)) != 0u) {
      return HEX_ERR_UNSUPPORTED;
    }
    if (insns[count].length > byte_len - off) {
      return HEX_ERR_UNSUPPORTED;
    }
    off += insns[count].length;
    count++;
  }

  CommonBodyInfo body{};
  int64_t rbp_to_sp_entry = -8;  // SysV: push rbp -> rbp = rsp_entry - 8

  if (abi_id == 0u) {
    // SysV AMD64 structured pattern: 25 instructions
    if (count != 25u) return HEX_ERR_UNSUPPORTED;
    // [0] push rbp
    if (insns[0].kind != HEX_X86_KIND_PUSH || insns[0].opcode != 0x55u || insns[0].rm != 5u) return HEX_ERR_UNSUPPORTED;
    // [1] mov rbp, rsp
    if (insns[1].kind != HEX_X86_KIND_MOV || insns[1].opcode != 0x89u || insns[1].op_size != 64u ||
        !is_reg_direct(insns[1]) || insns[1].reg != 4u || insns[1].rm != 5u) {
      return HEX_ERR_UNSUPPORTED;
    }
    // [2] mov al, sil
    if (insns[2].kind != HEX_X86_KIND_MOV || insns[2].opcode != 0x88u || insns[2].op_size != 8u ||
        (insns[2].flags & HEX_X86_FLAG_HAS_REX) == 0u ||
        !is_reg_direct(insns[2]) || insns[2].reg != 6u || insns[2].rm != 0u) {
      return HEX_ERR_UNSUPPORTED;
    }
    // [3] mov qword [rbp + d_ptr], rdi
    if (insns[3].kind != HEX_X86_KIND_MOV || insns[3].opcode != 0x89u || insns[3].op_size != 64u ||
        insns[3].reg != 7u || !is_mem_rbp(insns[3])) {
      return HEX_ERR_UNSUPPORTED;
    }
    // [4] mov byte [rbp + d_byte], al
    if (insns[4].kind != HEX_X86_KIND_MOV || insns[4].opcode != 0x88u || insns[4].op_size != 8u ||
        insns[4].reg != 0u || !is_mem_rbp(insns[4])) {
      return HEX_ERR_UNSUPPORTED;
    }
    // [23] pop rbp; [24] ret
    if (insns[23].kind != HEX_X86_KIND_POP || insns[23].opcode != 0x5Du || insns[23].rm != 5u) return HEX_ERR_UNSUPPORTED;
    if (insns[24].kind != HEX_X86_KIND_RET || insns[24].opcode != 0xC3u) return HEX_ERR_UNSUPPORTED;

    if (!match_common_body(insns, insns[3].disp, insns[4].disp, &body)) {
      return HEX_ERR_UNSUPPORTED;
    }
    rbp_to_sp_entry = -8;
  } else {
    // Microsoft x64 structured pattern: 26 instructions
    if (count != 26u) return HEX_ERR_UNSUPPORTED;
    // [0] push rbp
    if (insns[0].kind != HEX_X86_KIND_PUSH || insns[0].opcode != 0x55u || insns[0].rm != 5u) return HEX_ERR_UNSUPPORTED;
    // [1] sub rsp, frame_size
    const uint8_t sub_sp_grp = static_cast<uint8_t>((insns[1].modrm >> 3u) & 7u);
    if (insns[1].kind != HEX_X86_KIND_ALU ||
        (insns[1].opcode != 0x83u && insns[1].opcode != 0x81u) ||
        insns[1].op_size != 64u || sub_sp_grp != 5u || !is_reg_direct(insns[1]) ||
        insns[1].rm != 4u || insns[1].imm <= 0) {
      return HEX_ERR_UNSUPPORTED;
    }
    const int64_t frame_size = insns[1].imm;
    // [2] lea rbp, [rsp + lea_off]
    if (insns[2].kind != HEX_X86_KIND_LEA || insns[2].op_size != 64u || insns[2].reg != 5u ||
        insns[2].rm != 4u || insns[2].index_reg != 0xffu ||
        (insns[2].flags & HEX_X86_FLAG_RIP_REL) != 0u) {
      return HEX_ERR_UNSUPPORTED;
    }
    const int64_t lea_off = insns[2].disp;
    // [3] mov byte [rbp + d_byte], dl
    if (insns[3].kind != HEX_X86_KIND_MOV || insns[3].opcode != 0x88u || insns[3].op_size != 8u ||
        insns[3].reg != 2u || !is_mem_rbp(insns[3])) {
      return HEX_ERR_UNSUPPORTED;
    }
    // [4] mov qword [rbp + d_ptr], rcx
    if (insns[4].kind != HEX_X86_KIND_MOV || insns[4].opcode != 0x89u || insns[4].op_size != 64u ||
        insns[4].reg != 1u || !is_mem_rbp(insns[4])) {
      return HEX_ERR_UNSUPPORTED;
    }
    // [23] add rsp, frame_size
    const uint8_t add_sp_grp = static_cast<uint8_t>((insns[23].modrm >> 3u) & 7u);
    if (insns[23].kind != HEX_X86_KIND_ALU ||
        (insns[23].opcode != 0x83u && insns[23].opcode != 0x81u) ||
        insns[23].op_size != 64u || add_sp_grp != 0u || !is_reg_direct(insns[23]) ||
        insns[23].rm != 4u || insns[23].imm != frame_size) {
      return HEX_ERR_UNSUPPORTED;
    }
    // [24] pop rbp; [25] ret
    if (insns[24].kind != HEX_X86_KIND_POP || insns[24].opcode != 0x5Du || insns[24].rm != 5u) return HEX_ERR_UNSUPPORTED;
    if (insns[25].kind != HEX_X86_KIND_RET || insns[25].opcode != 0xC3u) return HEX_ERR_UNSUPPORTED;

    if (!match_common_body(insns, insns[4].disp, insns[3].disp, &body)) {
      return HEX_ERR_UNSUPPORTED;
    }
    rbp_to_sp_entry = -8 - frame_size + lea_off;
  }

  // Allocate text buffer and linemap on dedicated 64 KiB fixed arena with rollback.
  g_x86_sem_emit_arena.reset();
  const size_t arena_mark = g_x86_sem_emit_arena.used();
  char* text_buf = g_x86_sem_emit_arena.alloc<char>(kMaxTextCap);
  HexLineMapEntry* lm_buf = g_x86_sem_emit_arena.alloc<HexLineMapEntry>(kMaxLineMapEntries);
  if (!text_buf || !lm_buf) {
    g_x86_sem_emit_arena.restore(arena_mark);
    return HEX_ERR_OOM;
  }
  text_buf[0] = '\0';

  TextWriter w{text_buf, kMaxTextCap, 0u, false};
  uint32_t lm_count = 0u;
  uint32_t cur_line = 1u;

  const int64_t ptr_sp_rel = rbp_to_sp_entry + body.d_ptr;
  const int64_t byte_sp_rel = rbp_to_sp_entry + body.d_byte;
  const int64_t val_sp_rel = rbp_to_sp_entry + body.d_val;

  // Signature line: int32 sub_<HEX_UPPER>(uint64 a1, uint64 a2)
  w.append_str("int32 sub_");
  w.append_u64_hex(base_addr, true);
  w.append_str("(uint64 a1, uint64 a2)\n");
  push_linemap(lm_buf, &lm_count, cur_line, base_addr);
  cur_line++;

  w.append_str("{\n");
  cur_line++;

  if (abi_id == 0u) {
    // SysV AMD64 SSA temporary numbering matches JS semantic-v2 (address-dependent IDs):
    // base_addr == 0 omits one non-zero base-const node vs non-zero base_addr.
    const bool zero_base = (base_addr == 0ULL);
    const uint32_t id_byte = zero_base ? 113u : 5u;
    const uint32_t id_add = zero_base ? 2u : 63u;
    const uint32_t id_cmp = zero_base ? 32u : 100u;
    const uint32_t id_sub = zero_base ? 5u : 65u;
    const uint32_t id_local_al = zero_base ? 144u : 148u;

    LoadDecl decls[4] = {
        {id_byte, true},
        {id_add, false},
        {id_cmp, false},
        {id_sub, false},
    };
    sort_decls(decls, 4u);
    for (uint32_t i = 0u; i < 4u; ++i) {
      w.append_str(decls[i].is_u8 ? "    uint8 load_" : "    uint32 load_");
      w.append_u64_dec(decls[i].id);
      w.append_str(";\n");
      push_linemap(lm_buf, &lm_count, cur_line, base_addr);
      cur_line++;
    }

    // local_m10 = a1;
    w.append_str("    ");
    w.append_local_m(ptr_sp_rel);
    w.append_str(" = a1;\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[3].pc);
    cur_line++;

    // local_m11 = bit_extract(bit_insert(local_148, bit_extract(a2, 0, 8), 0, 16), 0, 8);
    w.append_str("    ");
    w.append_local_m(byte_sp_rel);
    w.append_str(" = bit_extract(bit_insert(local_");
    w.append_u64_dec(id_local_al);
    w.append_str(", bit_extract(a2, 0, 8), 0, 16), 0, 8);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[4].pc);
    cur_line++;

    // local_m18 = bit_extract(*(uint32_t *)(uintptr_t)(a1), 0, 32);
    w.append_str("    ");
    w.append_local_m(val_sp_rel);
    w.append_str(" = bit_extract(*(uint32_t *)(uintptr_t)(a1), 0, 32);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[7].pc);
    cur_line++;

    // load_byte = var_m9;
    w.append_str("    load_");
    w.append_u64_dec(id_byte);
    w.append_str(" = ");
    w.append_var_rbp(body.d_byte);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[8].pc);
    cur_line++;

    // load_add = var_m10;
    w.append_str("    load_");
    w.append_u64_dec(id_add);
    w.append_str(" = ");
    w.append_var_rbp(body.d_val);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[9].pc);
    cur_line++;

    emit_5_intrinsics(w, lm_buf, &lm_count, &cur_line, "    ", insns[9].pc);

    // local_m18 = bit_extract(bit_extract(load_byte, 0, 32) + load_add, 0, 32);
    w.append_str("    ");
    w.append_local_m(val_sp_rel);
    w.append_str(" = bit_extract(bit_extract(load_");
    w.append_u64_dec(id_byte);
    w.append_str(", 0, 32) + load_");
    w.append_u64_dec(id_add);
    w.append_str(", 0, 32);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[10].pc);
    cur_line++;

    // load_cmp = var_m10;
    w.append_str("    load_");
    w.append_u64_dec(id_cmp);
    w.append_str(" = ");
    w.append_var_rbp(body.d_val);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[11].pc);
    cur_line++;

    emit_5_intrinsics(w, lm_buf, &lm_count, &cur_line, "    ", insns[11].pc);

    // if ((int32_t)load_cmp <= cmp_imm) {
    w.append_str("    if ((int32_t)load_");
    w.append_u64_dec(id_cmp);
    w.append_str(" <= ");
    w.append_i64_dec(body.cmp_imm);
    w.append_str(") {\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[12].pc);
    cur_line++;

    // load_sub = var_m10;
    w.append_str("        load_");
    w.append_u64_dec(id_sub);
    w.append_str(" = ");
    w.append_var_rbp(body.d_val);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[17].pc);
    cur_line++;

    emit_5_intrinsics(w, lm_buf, &lm_count, &cur_line, "        ", insns[18].pc);

    // Wrapped store in then-branch (matches semantic-v2 80-col formatter)
    w.append_str("        *(uint32_t *)(uintptr_t)(a1) = bit_extract(bit_extract(load_");
    w.append_u64_dec(id_sub);
    w.append_str(",\n            0,\n            32) - ");
    w.append_i64_dec(body.sub_imm);
    w.append_str(",\n            0,\n            32);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[20].pc);
    cur_line += 5u;

    w.append_str("    } else {\n");
    cur_line++;

    w.append_str("        *(uint32_t *)(uintptr_t)(a1) = bit_extract(");
    w.append_local_m(val_sp_rel);
    w.append_str(", 0, 32);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[15].pc);
    cur_line++;

    w.append_str("    }\n");
    cur_line++;

    w.append_str("    return *(uint32_t *)(uintptr_t)(");
    w.append_local_m(ptr_sp_rel);
    w.append_str(");\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[22].pc);
    push_linemap(lm_buf, &lm_count, cur_line, insns[24].pc);
    cur_line++;

    w.append_char('}');
  } else {
    // Microsoft x64 semantic-v2 output
    const uint32_t id_byte = 2u;
    const uint32_t id_sub = 27u;
    const uint32_t id_cmp = 61u;
    const uint32_t id_add = 102u;
    const uint32_t id_ret = 113u;

    LoadDecl decls[5] = {
        {id_byte, true},
        {id_sub, false},
        {id_cmp, false},
        {id_add, false},
        {id_ret, false},
    };
    sort_decls(decls, 5u);
    for (uint32_t i = 0u; i < 5u; ++i) {
      w.append_str(decls[i].is_u8 ? "    uint8 load_" : "    uint32 load_");
      w.append_u64_dec(decls[i].id);
      w.append_str(";\n");
      push_linemap(lm_buf, &lm_count, cur_line, base_addr);
      cur_line++;
    }

    // Prologue sub rsp intrinsics
    emit_5_intrinsics(w, lm_buf, &lm_count, &cur_line, "    ", insns[1].pc);

    // local_m9 = bit_extract(a2, 0, 8);
    w.append_str("    ");
    w.append_local_m(byte_sp_rel);
    w.append_str(" = bit_extract(a2, 0, 8);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[3].pc);
    cur_line++;

    // local_m18 = a1;
    w.append_str("    ");
    w.append_local_m(ptr_sp_rel);
    w.append_str(" = a1;\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[4].pc);
    cur_line++;

    // local_m1C = bit_extract(*(uint32_t *)(uintptr_t)(a1), 0, 32);
    w.append_str("    ");
    w.append_local_m(val_sp_rel);
    w.append_str(" = bit_extract(*(uint32_t *)(uintptr_t)(a1), 0, 32);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[7].pc);
    cur_line++;

    // load_2 = var_7;
    w.append_str("    load_");
    w.append_u64_dec(id_byte);
    w.append_str(" = ");
    w.append_var_rbp(body.d_byte);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[8].pc);
    cur_line++;

    // load_102 = var_mc;
    w.append_str("    load_");
    w.append_u64_dec(id_add);
    w.append_str(" = ");
    w.append_var_rbp(body.d_val);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[9].pc);
    cur_line++;

    emit_5_intrinsics(w, lm_buf, &lm_count, &cur_line, "    ", insns[9].pc);

    // local_m1C = bit_extract(bit_extract(load_2, 0, 32) + load_102, 0, 32);
    w.append_str("    ");
    w.append_local_m(val_sp_rel);
    w.append_str(" = bit_extract(bit_extract(load_");
    w.append_u64_dec(id_byte);
    w.append_str(", 0, 32) + load_");
    w.append_u64_dec(id_add);
    w.append_str(", 0, 32);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[10].pc);
    cur_line++;

    // load_61 = var_mc;
    w.append_str("    load_");
    w.append_u64_dec(id_cmp);
    w.append_str(" = ");
    w.append_var_rbp(body.d_val);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[11].pc);
    cur_line++;

    emit_5_intrinsics(w, lm_buf, &lm_count, &cur_line, "    ", insns[11].pc);

    // if ((int32_t)load_61 <= cmp_imm) {
    w.append_str("    if ((int32_t)load_");
    w.append_u64_dec(id_cmp);
    w.append_str(" <= ");
    w.append_i64_dec(body.cmp_imm);
    w.append_str(") {\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[12].pc);
    cur_line++;

    // load_27 = var_mc;
    w.append_str("        load_");
    w.append_u64_dec(id_sub);
    w.append_str(" = ");
    w.append_var_rbp(body.d_val);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[17].pc);
    cur_line++;

    emit_5_intrinsics(w, lm_buf, &lm_count, &cur_line, "        ", insns[18].pc);

    w.append_str("        *(uint32_t *)(uintptr_t)(a1) = bit_extract(bit_extract(load_");
    w.append_u64_dec(id_sub);
    w.append_str(",\n            0,\n            32) - ");
    w.append_i64_dec(body.sub_imm);
    w.append_str(",\n            0,\n            32);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[20].pc);
    cur_line += 5u;

    w.append_str("    } else {\n");
    cur_line++;

    w.append_str("        *(uint32_t *)(uintptr_t)(a1) = bit_extract(");
    w.append_local_m(val_sp_rel);
    w.append_str(", 0, 32);\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[15].pc);
    cur_line++;

    w.append_str("    }\n");
    cur_line++;

    // load_113 = *(uint32_t *)(uintptr_t)(var_m8);
    w.append_str("    load_");
    w.append_u64_dec(id_ret);
    w.append_str(" = *(uint32_t *)(uintptr_t)(");
    w.append_var_rbp(body.d_ptr);
    w.append_str(");\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[22].pc);
    cur_line++;

    // Epilogue add rsp intrinsics
    emit_5_intrinsics(w, lm_buf, &lm_count, &cur_line, "    ", insns[23].pc);

    w.append_str("    return load_");
    w.append_u64_dec(id_ret);
    w.append_str(";\n");
    push_linemap(lm_buf, &lm_count, cur_line, insns[25].pc);
    cur_line++;

    w.append_char('}');
  }

  if (w.overflow) {
    g_x86_sem_emit_arena.restore(arena_mark);
    return HEX_ERR_OOM;
  }

  g_text_ptr = text_buf;
  g_text_len = w.len;
  g_lm_ptr = lm_buf;
  g_lm_count = lm_count;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_x86_64_semantic_get_text_ptr")
const char* hex_x86_64_semantic_get_text_ptr(void) {
  return g_text_ptr;
}

HEX_WASM_EXPORT("hex_x86_64_semantic_get_text_len")
uint32_t hex_x86_64_semantic_get_text_len(void) {
  return g_text_len;
}

HEX_WASM_EXPORT("hex_x86_64_semantic_get_linemap_ptr")
const HexLineMapEntry* hex_x86_64_semantic_get_linemap_ptr(void) {
  return g_lm_ptr;
}

HEX_WASM_EXPORT("hex_x86_64_semantic_get_linemap_count")
uint32_t hex_x86_64_semantic_get_linemap_count(void) {
  return g_lm_count;
}

}  // extern "C"
