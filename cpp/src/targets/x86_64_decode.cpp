#include "x86_64_decode.hpp"

namespace {

constexpr uint32_t kMaxInsnBytes = 15u;
constexpr uint8_t kRegNone = 0xffu;

constexpr const char* kAluMn[8] = {
    "add", "or", "adc", "sbb", "and", "sub", "xor", "cmp",
};

constexpr const char* kJccMn[16] = {
    "jo", "jno", "jb", "jae", "je", "jne", "jbe", "ja",
    "js", "jns", "jp", "jnp", "jl", "jge", "jle", "jg",
};

inline void copy_mn(char dst[16], const char* src) {
  size_t i = 0;
  if (src != nullptr) {
    while (i < 15u && src[i] != '\0') {
      dst[i] = src[i];
      ++i;
    }
  }
  dst[i] = '\0';
}

inline uint64_t add_signed_u64(uint64_t base, int64_t delta) {
  return base + static_cast<uint64_t>(delta);
}

struct Reader {
  const uint8_t* data;
  uint32_t len;
  uint32_t pos;
  bool truncated;
  bool over_limit;

  void init(const uint8_t* p, uint32_t n) {
    data = p;
    len = n;
    pos = 0u;
    truncated = false;
    over_limit = false;
  }

  bool read_u8(uint8_t& out) {
    if (pos >= kMaxInsnBytes) {
      over_limit = true;
      return false;
    }
    if (pos >= len) {
      truncated = true;
      return false;
    }
    out = data[pos++];
    return true;
  }

  bool read_u16_le(uint16_t& out) {
    uint8_t b0 = 0, b1 = 0;
    if (!read_u8(b0) || !read_u8(b1)) return false;
    out = static_cast<uint16_t>(static_cast<uint16_t>(b0) | (static_cast<uint16_t>(b1) << 8));
    return true;
  }

  bool read_u32_le(uint32_t& out) {
    uint8_t b[4] = {0, 0, 0, 0};
    for (int i = 0; i < 4; ++i) {
      if (!read_u8(b[i])) return false;
    }
    out = static_cast<uint32_t>(b[0]) |
          (static_cast<uint32_t>(b[1]) << 8) |
          (static_cast<uint32_t>(b[2]) << 16) |
          (static_cast<uint32_t>(b[3]) << 24);
    return true;
  }

  bool read_u64_le(uint64_t& out) {
    uint32_t lo = 0, hi = 0;
    if (!read_u32_le(lo) || !read_u32_le(hi)) return false;
    out = static_cast<uint64_t>(lo) | (static_cast<uint64_t>(hi) << 32);
    return true;
  }

  bool read_i8(int64_t& out) {
    uint8_t v = 0;
    if (!read_u8(v)) return false;
    out = static_cast<int64_t>(static_cast<int8_t>(v));
    return true;
  }

  bool read_i16(int64_t& out) {
    uint16_t v = 0;
    if (!read_u16_le(v)) return false;
    out = static_cast<int64_t>(static_cast<int16_t>(v));
    return true;
  }

  bool read_i32(int64_t& out) {
    uint32_t v = 0;
    if (!read_u32_le(v)) return false;
    out = static_cast<int64_t>(static_cast<int32_t>(v));
    return true;
  }

  bool read_i64(int64_t& out) {
    uint64_t v = 0;
    if (!read_u64_le(v)) return false;
    out = static_cast<int64_t>(v);
    return true;
  }
};

static bool decode_modrm(
    Reader& r,
    uint8_t rex_r,
    uint8_t rex_x,
    uint8_t rex_b,
    HexX86Decoded& d) {
  uint8_t modrm = 0;
  if (!r.read_u8(modrm)) return false;
  d.modrm = modrm;
  d.flags |= HEX_X86_FLAG_HAS_MODRM;

  const uint8_t mod = static_cast<uint8_t>((modrm >> 6) & 3u);
  const uint8_t reg_low = static_cast<uint8_t>((modrm >> 3) & 7u);
  const uint8_t rm_low = static_cast<uint8_t>(modrm & 7u);
  d.reg = static_cast<uint8_t>(reg_low | (rex_r << 3));

  if (mod == 3u) {
    d.rm = static_cast<uint8_t>(rm_low | (rex_b << 3));
    return true;
  }

  if (rm_low == 4u) {
    uint8_t sib = 0;
    if (!r.read_u8(sib)) return false;
    d.sib = sib;
    d.flags |= HEX_X86_FLAG_HAS_SIB;
    d.scale = static_cast<uint8_t>(1u << ((sib >> 6) & 3u));
    const uint8_t idx_low = static_cast<uint8_t>((sib >> 3) & 7u);
    const uint8_t base_low = static_cast<uint8_t>(sib & 7u);
    const uint8_t idx_full = static_cast<uint8_t>(idx_low | (rex_x << 3));
    d.index_reg = (idx_full == 4u) ? kRegNone : idx_full;

    if (mod == 0u && base_low == 5u) {
      d.rm = kRegNone;
      int64_t disp32 = 0;
      if (!r.read_i32(disp32)) return false;
      d.disp = disp32;
      d.disp_size = 4u;
      d.flags |= HEX_X86_FLAG_HAS_DISP;
    } else {
      d.rm = static_cast<uint8_t>(base_low | (rex_b << 3));
      if (mod == 1u) {
        int64_t disp8 = 0;
        if (!r.read_i8(disp8)) return false;
        d.disp = disp8;
        d.disp_size = 1u;
        d.flags |= HEX_X86_FLAG_HAS_DISP;
      } else if (mod == 2u) {
        int64_t disp32 = 0;
        if (!r.read_i32(disp32)) return false;
        d.disp = disp32;
        d.disp_size = 4u;
        d.flags |= HEX_X86_FLAG_HAS_DISP;
      }
    }
    return true;
  }

  if (mod == 0u && rm_low == 5u) {
    d.rm = kRegNone;
    d.flags |= HEX_X86_FLAG_RIP_REL;
    int64_t disp32 = 0;
    if (!r.read_i32(disp32)) return false;
    d.disp = disp32;
    d.disp_size = 4u;
    d.flags |= HEX_X86_FLAG_HAS_DISP;
    return true;
  }

  d.rm = static_cast<uint8_t>(rm_low | (rex_b << 3));
  if (mod == 1u) {
    int64_t disp8 = 0;
    if (!r.read_i8(disp8)) return false;
    d.disp = disp8;
    d.disp_size = 1u;
    d.flags |= HEX_X86_FLAG_HAS_DISP;
  } else if (mod == 2u) {
    int64_t disp32 = 0;
    if (!r.read_i32(disp32)) return false;
    d.disp = disp32;
    d.disp_size = 4u;
    d.flags |= HEX_X86_FLAG_HAS_DISP;
  }
  return true;
}

static bool read_imm_by_size(Reader& r, uint8_t imm_bytes, HexX86Decoded& d) {
  int64_t val = 0;
  bool ok = false;
  if (imm_bytes == 1u) ok = r.read_i8(val);
  else if (imm_bytes == 2u) ok = r.read_i16(val);
  else if (imm_bytes == 4u) ok = r.read_i32(val);
  else if (imm_bytes == 8u) ok = r.read_i64(val);
  if (!ok) return false;
  d.imm = val;
  d.imm_size = imm_bytes;
  d.flags |= HEX_X86_FLAG_HAS_IMM;
  return true;
}

static uint8_t default_op_size(bool rex_w, bool has_66) {
  if (rex_w) return 64u;
  if (has_66) return 16u;
  return 32u;
}

static uint8_t imm_bytes_for_op_size(uint8_t op_size) {
  return (op_size == 16u) ? 2u : 4u;
}

static void fail_decode(Reader& r, HexX86Decoded& d) {
  d.valid = 0u;
  d.length = 0u;
  d.kind = HEX_X86_KIND_UNKNOWN;
  d.cap = HEX_X86_CAP_FALLBACK;
  d.mn[0] = '\0';
  if (r.truncated) d.flags |= HEX_X86_FLAG_TRUNCATED;
  if (r.over_limit || !r.truncated) d.flags |= HEX_X86_FLAG_INVALID;
}

static void finish_valid(Reader& r, HexX86Decoded& d, bool unsupported_prefix) {
  if (r.pos == 0u || r.pos > kMaxInsnBytes) {
    r.over_limit = true;
    fail_decode(r, d);
    return;
  }
  d.length = static_cast<uint8_t>(r.pos);
  d.valid = 1u;
  if ((d.flags & HEX_X86_FLAG_RIP_REL) != 0u && (d.flags & HEX_X86_FLAG_HAS_TARGET) == 0u) {
    d.target = add_signed_u64(d.pc + static_cast<uint64_t>(d.length), d.disp);
    d.flags |= HEX_X86_FLAG_HAS_TARGET;
  }
  if (unsupported_prefix) {
    d.cap = HEX_X86_CAP_FALLBACK;
  } else {
    d.cap = static_cast<uint8_t>(hex_x86_64_kind_decomp_cap(d.kind));
  }
}

}  // namespace

extern "C" {

uint32_t hex_x86_64_kind_decomp_cap(uint8_t kind) {
  switch (static_cast<HexX86Kind>(kind)) {
    case HEX_X86_KIND_NOP:
    case HEX_X86_KIND_MOV:
    case HEX_X86_KIND_MOVZX:
    case HEX_X86_KIND_MOVSX:
    case HEX_X86_KIND_ALU:
    case HEX_X86_KIND_CMP:
    case HEX_X86_KIND_MUL:
    case HEX_X86_KIND_LEA:
    case HEX_X86_KIND_JMP:
    case HEX_X86_KIND_JCC:
    case HEX_X86_KIND_CALL:
    case HEX_X86_KIND_RET:
    case HEX_X86_KIND_PUSH:
    case HEX_X86_KIND_POP:
      return HEX_X86_CAP_DECOMP;
    case HEX_X86_KIND_UNKNOWN:
    default:
      return HEX_X86_CAP_FALLBACK;
  }
}

const char* hex_x86_64_kind_name(uint8_t kind) {
  switch (static_cast<HexX86Kind>(kind)) {
    case HEX_X86_KIND_NOP: return "nop";
    case HEX_X86_KIND_MOV: return "mov";
    case HEX_X86_KIND_MOVZX: return "movzx";
    case HEX_X86_KIND_MOVSX: return "movsx";
    case HEX_X86_KIND_ALU: return "alu";
    case HEX_X86_KIND_CMP: return "cmp";
    case HEX_X86_KIND_MUL: return "mul";
    case HEX_X86_KIND_LEA: return "lea";
    case HEX_X86_KIND_JMP: return "jmp";
    case HEX_X86_KIND_JCC: return "jcc";
    case HEX_X86_KIND_CALL: return "call";
    case HEX_X86_KIND_RET: return "ret";
    case HEX_X86_KIND_PUSH: return "push";
    case HEX_X86_KIND_POP: return "pop";
    case HEX_X86_KIND_UNKNOWN:
    default:
      return "unknown";
  }
}

HexStatus hex_x86_64_decode_one(
    const uint8_t* bytes,
    uint32_t len,
    uint64_t pc,
    HexX86Decoded* out) {
  if (bytes == nullptr || out == nullptr) return HEX_ERR_INVALID_ARG;

  hex::mem_set(out, 0, sizeof(HexX86Decoded));
  out->pc = pc;
  out->reg = kRegNone;
  out->rm = kRegNone;
  out->index_reg = kRegNone;

  if (len == 0u) {
    out->flags = HEX_X86_FLAG_TRUNCATED;
    return HEX_OK;
  }

  // Exact 4-byte CET ENDBR64: F3 0F 1E FA
  if (bytes[0] == 0xf3u) {
    if (len >= 4u && bytes[1] == 0x0fu && bytes[2] == 0x1eu && bytes[3] == 0xfau) {
      out->length = 4u;
      out->opcode = 0x0fu;
      out->opcode2 = 0x1eu;
      out->modrm = 0xfau;
      out->kind = HEX_X86_KIND_NOP;
      out->cap = HEX_X86_CAP_DECOMP;
      out->valid = 1u;
      copy_mn(out->mn, "endbr64");
      return HEX_OK;
    }
    if (len < 4u && (len == 1u || (bytes[1] == 0x0fu && (len == 2u || bytes[2] == 0x1eu)))) {
      out->flags = HEX_X86_FLAG_TRUNCATED;
      return HEX_OK;
    }
  }

  Reader r;
  r.init(bytes, len);

  bool has_66 = false;
  bool unsupported_prefix = false;
  uint8_t b = 0;

  // 1. Legacy prefixes (bounded by kMaxInsnBytes via Reader)
  while (true) {
    if (!r.read_u8(b)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    if (b == 0x66u) {
      if (has_66) unsupported_prefix = true;
      has_66 = true;
      out->flags |= HEX_X86_FLAG_HAS_66;
      continue;
    }
    if (b == 0xf0u || b == 0xf2u || b == 0xf3u || b == 0x67u ||
        b == 0x26u || b == 0x2eu || b == 0x36u || b == 0x3eu ||
        b == 0x64u || b == 0x65u) {
      unsupported_prefix = true;
      continue;
    }
    break;
  }

  // 2. Optional REX prefix (0x40..0x4F)
  uint8_t rex = 0u;
  bool has_rex = false;
  if ((b & 0xf0u) == 0x40u) {
    rex = b;
    has_rex = true;
    out->rex = rex;
    out->flags |= HEX_X86_FLAG_HAS_REX;
    if (!r.read_u8(b)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    // Consecutive REX prefixes are redundant/unsupported for decompiler
    if ((b & 0xf0u) == 0x40u) {
      fail_decode(r, *out);
      return HEX_OK;
    }
  }

  const bool rex_w = (rex & 0x08u) != 0u;
  const uint8_t rex_r = static_cast<uint8_t>((rex >> 2) & 1u);
  const uint8_t rex_x = static_cast<uint8_t>((rex >> 1) & 1u);
  const uint8_t rex_b = static_cast<uint8_t>(rex & 1u);
  const uint8_t def_size = default_op_size(rex_w, has_66);

  out->opcode = b;

  // 3. Two-byte escape 0x0F
  if (b == 0x0fu) {
    uint8_t op2 = 0;
    if (!r.read_u8(op2)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->opcode2 = op2;

    // 0F 80..8F: Jcc rel32
    if ((op2 & 0xf0u) == 0x80u) {
      int64_t rel32 = 0;
      if (!r.read_i32(rel32)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
      out->kind = HEX_X86_KIND_JCC;
      out->op_size = 64u;
      out->imm = rel32;
      out->imm_size = 4u;
      out->flags |= HEX_X86_FLAG_HAS_IMM | HEX_X86_FLAG_HAS_TARGET;
      out->target = add_signed_u64(pc + static_cast<uint64_t>(r.pos), rel32);
      copy_mn(out->mn, kJccMn[op2 & 0x0fu]);
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }

    // 0F 1F /0: multi-byte NOP r/m
    if (op2 == 0x1fu) {
      if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
      out->kind = HEX_X86_KIND_NOP;
      out->op_size = def_size;
      copy_mn(out->mn, "nop");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }

    // 0F AF: IMUL r, r/m
    if (op2 == 0xafu) {
      if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
      out->kind = HEX_X86_KIND_MUL;
      out->op_size = def_size;
      copy_mn(out->mn, "imul");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }

    // 0F B6 / 0F B7: MOVZX r, r/m8 or r/m16
    if (op2 == 0xb6u || op2 == 0xb7u) {
      if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
      out->kind = HEX_X86_KIND_MOVZX;
      out->op_size = def_size;
      copy_mn(out->mn, "movzx");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }

    // 0F BE / 0F BF: MOVSX r, r/m8 or r/m16
    if (op2 == 0xbeu || op2 == 0xbfu) {
      if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
      out->kind = HEX_X86_KIND_MOVSX;
      out->op_size = def_size;
      copy_mn(out->mn, "movsx");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }

    fail_decode(r, *out);
    return HEX_OK;
  }

  // 4. Primary 1-byte opcodes

  // Standard ALU/CMP block: 0x00..0x3D (groups 0..7: add, or, adc, sbb, and, sub, xor, cmp)
  if (b < 0x40u && (b & 0x07u) <= 5u) {
    const uint8_t grp = static_cast<uint8_t>((b >> 3) & 7u);
    const uint8_t sub = static_cast<uint8_t>(b & 7u);
    const bool is_cmp = (grp == 7u);
    out->kind = is_cmp ? HEX_X86_KIND_CMP : HEX_X86_KIND_ALU;
    copy_mn(out->mn, kAluMn[grp]);
    if (sub <= 3u) {
      out->op_size = (sub == 0u || sub == 2u) ? 8u : def_size;
      if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
    } else if (sub == 4u) {
      out->op_size = 8u;
      out->reg = 0u;
      if (!read_imm_by_size(r, 1u, *out)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
    } else {
      out->op_size = def_size;
      out->reg = 0u;
      if (!read_imm_by_size(r, imm_bytes_for_op_size(def_size), *out)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
    }
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x50..0x57: PUSH r64/r16
  if (b >= 0x50u && b <= 0x57u) {
    out->kind = HEX_X86_KIND_PUSH;
    out->op_size = has_66 ? 16u : 64u;
    out->rm = static_cast<uint8_t>((b & 7u) | (rex_b << 3));
    copy_mn(out->mn, "push");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x58..0x5F: POP r64/r16
  if (b >= 0x58u && b <= 0x5fu) {
    out->kind = HEX_X86_KIND_POP;
    out->op_size = has_66 ? 16u : 64u;
    out->rm = static_cast<uint8_t>((b & 7u) | (rex_b << 3));
    copy_mn(out->mn, "pop");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x63: MOVSXD r, r/m32
  if (b == 0x63u) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_MOVSX;
    out->op_size = def_size;
    copy_mn(out->mn, "movsxd");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x68: PUSH imm32/imm16, 0x6A: PUSH imm8
  if (b == 0x68u || b == 0x6au) {
    const uint8_t imm_sz = (b == 0x6au) ? 1u : (has_66 ? 2u : 4u);
    if (!read_imm_by_size(r, imm_sz, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_PUSH;
    out->op_size = has_66 ? 16u : 64u;
    copy_mn(out->mn, "push");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x69 / 0x6B: IMUL r, r/m, imm32(16) / imm8
  if (b == 0x69u || b == 0x6bu) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    const uint8_t imm_sz = (b == 0x6bu) ? 1u : imm_bytes_for_op_size(def_size);
    if (!read_imm_by_size(r, imm_sz, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_MUL;
    out->op_size = def_size;
    copy_mn(out->mn, "imul");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x70..0x7F: Jcc rel8
  if ((b & 0xf0u) == 0x70u) {
    int64_t rel8 = 0;
    if (!r.read_i8(rel8)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_JCC;
    out->op_size = 64u;
    out->imm = rel8;
    out->imm_size = 1u;
    out->flags |= HEX_X86_FLAG_HAS_IMM | HEX_X86_FLAG_HAS_TARGET;
    out->target = add_signed_u64(pc + static_cast<uint64_t>(r.pos), rel8);
    copy_mn(out->mn, kJccMn[b & 0x0fu]);
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x80 / 0x81 / 0x83: Group 1 ALU/CMP r/m, imm
  if (b == 0x80u || b == 0x81u || b == 0x83u) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    const uint8_t grp = static_cast<uint8_t>((out->modrm >> 3) & 7u);
    const uint8_t op_sz = (b == 0x80u) ? 8u : def_size;
    const uint8_t imm_sz = (b == 0x81u) ? imm_bytes_for_op_size(def_size) : 1u;
    if (!read_imm_by_size(r, imm_sz, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = (grp == 7u) ? HEX_X86_KIND_CMP : HEX_X86_KIND_ALU;
    out->op_size = op_sz;
    copy_mn(out->mn, kAluMn[grp]);
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x84 / 0x85: TEST r/m, r
  if (b == 0x84u || b == 0x85u) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_CMP;
    out->op_size = (b == 0x84u) ? 8u : def_size;
    copy_mn(out->mn, "test");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x88..0x8B: MOV r/m, r or MOV r, r/m
  if (b >= 0x88u && b <= 0x8bu) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_MOV;
    out->op_size = (b == 0x88u || b == 0x8au) ? 8u : def_size;
    copy_mn(out->mn, "mov");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x8D: LEA r, m (mod == 3 is #UD -> invalid)
  if (b == 0x8du) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    if (((out->modrm >> 6) & 3u) == 3u) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_LEA;
    out->op_size = def_size;
    copy_mn(out->mn, "lea");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0x90: NOP (only when REX.B == 0; with REX.B == 1 it is xchg r8, rax)
  if (b == 0x90u && rex_b == 0u) {
    out->kind = HEX_X86_KIND_NOP;
    out->op_size = def_size;
    copy_mn(out->mn, "nop");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xA8 / 0xA9: TEST AL/rAX, imm
  if (b == 0xa8u || b == 0xa9u) {
    const uint8_t imm_sz = (b == 0xa8u) ? 1u : imm_bytes_for_op_size(def_size);
    if (!read_imm_by_size(r, imm_sz, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_CMP;
    out->op_size = (b == 0xa8u) ? 8u : def_size;
    out->reg = 0u;
    copy_mn(out->mn, "test");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xB0..0xB7: MOV r8, imm8
  if (b >= 0xb0u && b <= 0xb7u) {
    if (!read_imm_by_size(r, 1u, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_MOV;
    out->op_size = 8u;
    out->rm = static_cast<uint8_t>((b & 7u) | (rex_b << 3));
    copy_mn(out->mn, "mov");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xB8..0xBF: MOV r16/32/64, imm16/32/64
  if (b >= 0xb8u && b <= 0xbfu) {
    const uint8_t imm_sz = rex_w ? 8u : (has_66 ? 2u : 4u);
    if (!read_imm_by_size(r, imm_sz, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_MOV;
    out->op_size = def_size;
    out->rm = static_cast<uint8_t>((b & 7u) | (rex_b << 3));
    copy_mn(out->mn, rex_w ? "movabs" : "mov");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xC1: Shift r/m, imm8 (shl /4, shr /5, sar /7)
  if (b == 0xc1u) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    const uint8_t grp = static_cast<uint8_t>((out->modrm >> 3) & 7u);
    if (grp != 4u && grp != 5u && grp != 7u) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    if (!read_imm_by_size(r, 1u, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_ALU;
    out->op_size = def_size;
    copy_mn(out->mn, grp == 4u ? "shl" : (grp == 5u ? "shr" : "sar"));
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xC2: RET imm16
  if (b == 0xc2u) {
    if (!read_imm_by_size(r, 2u, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_RET;
    out->op_size = 64u;
    copy_mn(out->mn, "ret");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xC3: RET
  if (b == 0xc3u) {
    out->kind = HEX_X86_KIND_RET;
    out->op_size = 64u;
    copy_mn(out->mn, "ret");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xC6 /0: MOV r/m8, imm8; 0xC7 /0: MOV r/m, imm32(16)
  if (b == 0xc6u || b == 0xc7u) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    if (((out->modrm >> 3) & 7u) != 0u) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    const uint8_t imm_sz = (b == 0xc6u) ? 1u : imm_bytes_for_op_size(def_size);
    if (!read_imm_by_size(r, imm_sz, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_MOV;
    out->op_size = (b == 0xc6u) ? 8u : def_size;
    copy_mn(out->mn, "mov");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xE8: CALL rel32
  if (b == 0xe8u) {
    int64_t rel32 = 0;
    if (!r.read_i32(rel32)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_CALL;
    out->op_size = 64u;
    out->imm = rel32;
    out->imm_size = 4u;
    out->flags |= HEX_X86_FLAG_HAS_IMM | HEX_X86_FLAG_HAS_TARGET;
    out->target = add_signed_u64(pc + static_cast<uint64_t>(r.pos), rel32);
    copy_mn(out->mn, "call");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xE9: JMP rel32
  if (b == 0xe9u) {
    int64_t rel32 = 0;
    if (!r.read_i32(rel32)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_JMP;
    out->op_size = 64u;
    out->imm = rel32;
    out->imm_size = 4u;
    out->flags |= HEX_X86_FLAG_HAS_IMM | HEX_X86_FLAG_HAS_TARGET;
    out->target = add_signed_u64(pc + static_cast<uint64_t>(r.pos), rel32);
    copy_mn(out->mn, "jmp");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xEB: JMP rel8
  if (b == 0xebu) {
    int64_t rel8 = 0;
    if (!r.read_i8(rel8)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    out->kind = HEX_X86_KIND_JMP;
    out->op_size = 64u;
    out->imm = rel8;
    out->imm_size = 1u;
    out->flags |= HEX_X86_FLAG_HAS_IMM | HEX_X86_FLAG_HAS_TARGET;
    out->target = add_signed_u64(pc + static_cast<uint64_t>(r.pos), rel8);
    copy_mn(out->mn, "jmp");
    finish_valid(r, *out, unsupported_prefix);
    return HEX_OK;
  }

  // 0xF6 / 0xF7: Group 3 (/0 test, /2 not, /3 neg)
  if (b == 0xf6u || b == 0xf7u) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    const uint8_t grp = static_cast<uint8_t>((out->modrm >> 3) & 7u);
    if (grp == 0u || grp == 1u) {
      const uint8_t imm_sz = (b == 0xf6u) ? 1u : imm_bytes_for_op_size(def_size);
      if (!read_imm_by_size(r, imm_sz, *out)) {
        fail_decode(r, *out);
        return HEX_OK;
      }
      out->kind = HEX_X86_KIND_CMP;
      out->op_size = (b == 0xf6u) ? 8u : def_size;
      copy_mn(out->mn, "test");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }
    if (grp == 2u || grp == 3u) {
      out->kind = HEX_X86_KIND_ALU;
      out->op_size = (b == 0xf6u) ? 8u : def_size;
      copy_mn(out->mn, grp == 2u ? "not" : "neg");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }
    fail_decode(r, *out);
    return HEX_OK;
  }

  // 0xFF: Group 5 (/0 inc, /1 dec, /2 call, /4 jmp, /6 push)
  if (b == 0xffu) {
    if (!decode_modrm(r, rex_r, rex_x, rex_b, *out)) {
      fail_decode(r, *out);
      return HEX_OK;
    }
    const uint8_t grp = static_cast<uint8_t>((out->modrm >> 3) & 7u);
    if (grp == 0u || grp == 1u) {
      out->kind = HEX_X86_KIND_ALU;
      out->op_size = def_size;
      copy_mn(out->mn, grp == 0u ? "inc" : "dec");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }
    if (grp == 2u) {
      out->kind = HEX_X86_KIND_CALL;
      out->op_size = 64u;
      copy_mn(out->mn, "call");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }
    if (grp == 4u) {
      out->kind = HEX_X86_KIND_JMP;
      out->op_size = 64u;
      copy_mn(out->mn, "jmp");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }
    if (grp == 6u) {
      out->kind = HEX_X86_KIND_PUSH;
      out->op_size = has_66 ? 16u : 64u;
      copy_mn(out->mn, "push");
      finish_valid(r, *out, unsupported_prefix);
      return HEX_OK;
    }
    fail_decode(r, *out);
    return HEX_OK;
  }

  (void)has_rex;
  fail_decode(r, *out);
  return HEX_OK;
}

HexStatus hex_x86_64_decode_batch(
    const uint8_t* bytes,
    uint32_t len,
    uint64_t base_pc,
    HexX86Decoded* out_insns,
    uint32_t max_insns,
    uint32_t* out_count) {
  if (bytes == nullptr || out_insns == nullptr || out_count == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  uint32_t off = 0u;
  uint32_t count = 0u;
  while (off < len && count < max_insns) {
    HexX86Decoded d;
    const HexStatus st = hex_x86_64_decode_one(
        bytes + off, len - off, base_pc + static_cast<uint64_t>(off), &d);
    if (st != HEX_OK) {
      *out_count = count;
      return st;
    }
    out_insns[count++] = d;
    if (d.valid == 0u || d.length == 0u) {
      break;
    }
    off += static_cast<uint32_t>(d.length);
  }
  *out_count = count;
  return HEX_OK;
}

uint32_t hex_x86_64_insn_length(const uint8_t* bytes, uint32_t len) {
  if (bytes == nullptr || len == 0u) return 0u;
  HexX86Decoded d;
  if (hex_x86_64_decode_one(bytes, len, 0ull, &d) != HEX_OK) return 0u;
  return (d.valid != 0u) ? static_cast<uint32_t>(d.length) : 0u;
}

uint32_t hex_x86_64_is_decompiler_supported(const uint8_t* bytes, uint32_t len) {
  if (bytes == nullptr || len == 0u) return HEX_X86_CAP_FALLBACK;
  uint32_t off = 0u;
  while (off < len) {
    HexX86Decoded d;
    const HexStatus st = hex_x86_64_decode_one(
        bytes + off, len - off, static_cast<uint64_t>(off), &d);
    if (st != HEX_OK) return HEX_X86_CAP_FALLBACK;
    if (d.valid == 0u || d.length == 0u || d.length > kMaxInsnBytes) {
      return HEX_X86_CAP_FALLBACK;
    }
    if ((d.flags & (HEX_X86_FLAG_TRUNCATED | HEX_X86_FLAG_INVALID)) != 0u) {
      return HEX_X86_CAP_FALLBACK;
    }
    if (d.cap != HEX_X86_CAP_DECOMP) {
      return HEX_X86_CAP_FALLBACK;
    }
    off += static_cast<uint32_t>(d.length);
  }
  return (off == len) ? HEX_X86_CAP_DECOMP : HEX_X86_CAP_FALLBACK;
}

}  // extern "C"
