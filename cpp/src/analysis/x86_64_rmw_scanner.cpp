#include "hex_abi.hpp"

#include <stddef.h>
#include <stdint.h>

namespace {

struct RmwHit {
  uint32_t load_off;
  uint32_t store_off;
  int32_t disp;
  uint8_t base_reg;
  uint8_t op_kind;
  uint8_t flags;
  uint8_t width;
  uint32_t arith_off;
};

static_assert(sizeof(RmwHit) == 20u, "RmwHit must be 20 bytes");
static_assert(offsetof(RmwHit, load_off) == 0u, "RmwHit::load_off offset mismatch");
static_assert(offsetof(RmwHit, store_off) == 4u, "RmwHit::store_off offset mismatch");
static_assert(offsetof(RmwHit, disp) == 8u, "RmwHit::disp offset mismatch");
static_assert(offsetof(RmwHit, base_reg) == 12u, "RmwHit::base_reg offset mismatch");
static_assert(offsetof(RmwHit, op_kind) == 13u, "RmwHit::op_kind offset mismatch");
static_assert(offsetof(RmwHit, flags) == 14u, "RmwHit::flags offset mismatch");
static_assert(offsetof(RmwHit, width) == 15u, "RmwHit::width offset mismatch");
static_assert(offsetof(RmwHit, arith_off) == 16u, "RmwHit::arith_off offset mismatch");

struct RmwSummary {
  uint32_t clamped_sub;
  uint32_t unclamped_sub;
  uint32_t add_rmw;
  uint32_t total_hits;
};

struct DecodedInsn {
  uint32_t off;
  uint8_t len;
  bool valid;
  bool has_lock;
  bool has_repne;
  bool has_rep;
  bool has_66;
  bool has_67;
  bool is_vex;
  uint8_t rex_w;
  uint8_t rex_r;
  uint8_t rex_x;
  uint8_t rex_b;
  uint8_t map;       // 0=1B, 1=0F, 2=0F38, 3=0F3A
  uint8_t opcode;
  bool has_modrm;
  uint8_t mod;
  uint8_t reg_field;
  uint8_t rm_field;
  uint8_t reg_num;
  uint8_t rm_reg_num;
  bool has_mem;
  bool mem_valid;
  bool is_rip_rel;
  uint8_t base_reg;
  int32_t disp;
};

inline int32_t read_i32_le(const uint8_t* p, uint32_t off) {
  const uint32_t v =
      static_cast<uint32_t>(p[off]) |
      (static_cast<uint32_t>(p[off + 1u]) << 8) |
      (static_cast<uint32_t>(p[off + 2u]) << 16) |
      (static_cast<uint32_t>(p[off + 3u]) << 24);
  return static_cast<int32_t>(v);
}

inline void write_u32_le(uint8_t* dst, uint32_t value) {
  dst[0] = static_cast<uint8_t>(value & 0xFFu);
  dst[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
  dst[2] = static_cast<uint8_t>((value >> 16) & 0xFFu);
  dst[3] = static_cast<uint8_t>((value >> 24) & 0xFFu);
}

inline void write_rmw_hit_le(uint8_t* dst, const RmwHit& hit) {
  write_u32_le(dst + 0u, hit.load_off);
  write_u32_le(dst + 4u, hit.store_off);
  write_u32_le(dst + 8u, static_cast<uint32_t>(hit.disp));
  dst[12] = hit.base_reg;
  dst[13] = hit.op_kind;
  dst[14] = hit.flags;
  dst[15] = hit.width;
  write_u32_le(dst + 16u, hit.arith_off);
}

inline uint32_t sat_mul_1000(uint32_t count, uint32_t weight) {
  if (count == 0u || weight == 0u) return 0u;
  const uint32_t limit = 1000u / weight;
  if (count > limit) return 1000u;
  const uint32_t prod = count * weight;
  return prod > 1000u ? 1000u : prod;
}

inline uint32_t sat_add_1000(uint32_t a, uint32_t b) {
  const uint32_t sum = a + b;
  return sum > 1000u ? 1000u : sum;
}

inline bool is_legacy_prefix(uint8_t b) {
  return b == 0xF0u || b == 0xF2u || b == 0xF3u ||
         b == 0x66u || b == 0x67u ||
         b == 0x26u || b == 0x2Eu || b == 0x36u || b == 0x3Eu ||
         b == 0x64u || b == 0x65u;
}

inline DecodedInsn make_fallback_insn(uint32_t pos) {
  DecodedInsn insn{};
  insn.off = pos;
  insn.len = 1u;
  insn.valid = false;
  return insn;
}

// 100% parity variable-length x86-64 decoder.
// Always guarantees len >= 1 and pos + len <= code_len, max len <= 15.
DecodedInsn decode_x86_64_insn(const uint8_t* code, uint32_t code_len, uint32_t pos) {
  DecodedInsn d{};
  d.off = pos;
  d.len = 1u;
  d.valid = false;

  if (pos >= code_len) return d;

  const uint32_t rem = code_len - pos;
  const uint32_t max_end = pos + (rem < 15u ? rem : 15u);
  uint32_t cur = pos;

  // 1. Legacy prefixes
  while (cur < max_end && is_legacy_prefix(code[cur])) {
    const uint8_t p = code[cur++];
    if (p == 0xF0u) d.has_lock = true;
    else if (p == 0xF2u) d.has_repne = true;
    else if (p == 0xF3u) d.has_rep = true;
    else if (p == 0x66u) d.has_66 = true;
    else if (p == 0x67u) d.has_67 = true;
  }

  // 2. REX prefix (0x40..0x4F)
  bool has_rex = false;
  if (cur < max_end && (code[cur] & 0xF0u) == 0x40u) {
    const uint8_t rex = code[cur++];
    has_rex = true;
    d.rex_w = (rex >> 3) & 1u;
    d.rex_r = (rex >> 2) & 1u;
    d.rex_x = (rex >> 1) & 1u;
    d.rex_b = rex & 1u;
  }

  if (cur >= max_end) return make_fallback_insn(pos);

  uint8_t op = code[cur++];
  bool need_modrm = false;
  uint32_t imm_size = 0u;
  bool check_grp3_imm = false;
  const uint32_t imm_z = d.has_66 ? 2u : 4u;
  const uint32_t imm_v = d.rex_w ? 8u : (d.has_66 ? 2u : 4u);

  // 3. VEX 2-byte (0xC5) / 3-byte (0xC4)
  if (!has_rex && (op == 0xC5u || op == 0xC4u)) {
    d.is_vex = true;
    if (op == 0xC5u) {
      if (cur + 2u > max_end) return make_fallback_insn(pos);
      const uint8_t v1 = code[cur++];
      d.rex_r = ((~v1) >> 7) & 1u;
      const uint8_t pp = v1 & 3u;
      if (pp == 1u) d.has_66 = true;
      else if (pp == 2u) d.has_rep = true;
      else if (pp == 3u) d.has_repne = true;
      d.map = 1u;
      d.opcode = code[cur++];
    } else {
      if (cur + 3u > max_end) return make_fallback_insn(pos);
      const uint8_t v1 = code[cur++];
      const uint8_t v2 = code[cur++];
      d.rex_r = ((~v1) >> 7) & 1u;
      d.rex_x = ((~v1) >> 6) & 1u;
      d.rex_b = ((~v1) >> 5) & 1u;
      d.map = v1 & 0x1Fu;
      if (d.map < 1u || d.map > 3u) return make_fallback_insn(pos);
      d.rex_w = (v2 >> 7) & 1u;
      const uint8_t pp = v2 & 3u;
      if (pp == 1u) d.has_66 = true;
      else if (pp == 2u) d.has_rep = true;
      else if (pp == 3u) d.has_repne = true;
      d.opcode = code[cur++];
    }

    if (d.map == 1u && d.opcode == 0x77u) {
      need_modrm = false;
      imm_size = 0u;
    } else {
      need_modrm = true;
      if (d.map == 3u) {
        imm_size = 1u;
      } else if (d.map == 1u &&
                 (d.opcode == 0x70u || d.opcode == 0x71u || d.opcode == 0x72u ||
                  d.opcode == 0x73u || d.opcode == 0xC2u || d.opcode == 0xC4u ||
                  d.opcode == 0xC5u || d.opcode == 0xC6u)) {
        imm_size = 1u;
      }
    }
  } else if (op == 0x0Fu) {
    // 4. Two-byte / Three-byte escape (0F / 0F 38 / 0F 3A)
    if (cur >= max_end) return make_fallback_insn(pos);
    const uint8_t op2 = code[cur++];
    if (op2 == 0x38u) {
      if (cur >= max_end) return make_fallback_insn(pos);
      d.map = 2u;
      d.opcode = code[cur++];
      need_modrm = true;
      imm_size = 0u;
    } else if (op2 == 0x3Au) {
      if (cur >= max_end) return make_fallback_insn(pos);
      d.map = 3u;
      d.opcode = code[cur++];
      need_modrm = true;
      imm_size = 1u;
    } else {
      d.map = 1u;
      d.opcode = op2;
      if (op2 >= 0x80u && op2 <= 0x8Fu) {
        need_modrm = false;
        imm_size = 4u;
      } else if (op2 == 0x05u || op2 == 0x07u || op2 == 0x08u || op2 == 0x09u ||
                 op2 == 0x0Bu || (op2 >= 0x30u && op2 <= 0x35u) ||
                 op2 == 0x77u || op2 == 0xA0u || op2 == 0xA1u || op2 == 0xA2u ||
                 op2 == 0xA8u || op2 == 0xA9u || op2 == 0xAAu ||
                 (op2 >= 0xC8u && op2 <= 0xCFu)) {
        need_modrm = false;
        imm_size = 0u;
      } else if (op2 == 0x70u || op2 == 0x71u || op2 == 0x72u || op2 == 0x73u ||
                 op2 == 0xA4u || op2 == 0xACu || op2 == 0xBAu || op2 == 0xC2u ||
                 op2 == 0xC4u || op2 == 0xC5u || op2 == 0xC6u) {
        need_modrm = true;
        imm_size = 1u;
      } else {
        need_modrm = true;
        imm_size = 0u;
      }
    }
  } else {
    // 5. One-byte legacy opcode
    d.map = 0u;
    d.opcode = op;
    if ((op <= 0x3Fu) && ((op & 7u) <= 3u)) {
      need_modrm = true;
      imm_size = 0u;
    } else if ((op <= 0x3Fu) && ((op & 7u) == 4u)) {
      need_modrm = false;
      imm_size = 1u;
    } else if ((op <= 0x3Fu) && ((op & 7u) == 5u)) {
      need_modrm = false;
      imm_size = imm_z;
    } else if (op >= 0x50u && op <= 0x5Fu) {
      need_modrm = false;
      imm_size = 0u;
    } else if (op == 0x63u) {
      need_modrm = true;
      imm_size = 0u;
    } else if (op == 0x68u) {
      need_modrm = false;
      imm_size = imm_z;
    } else if (op == 0x69u) {
      need_modrm = true;
      imm_size = imm_z;
    } else if (op == 0x6Au) {
      need_modrm = false;
      imm_size = 1u;
    } else if (op == 0x6Bu) {
      need_modrm = true;
      imm_size = 1u;
    } else if (op >= 0x6Cu && op <= 0x6Fu) {
      need_modrm = false;
      imm_size = 0u;
    } else if (op >= 0x70u && op <= 0x7Fu) {
      need_modrm = false;
      imm_size = 1u;
    } else if (op == 0x80u || op == 0x83u) {
      need_modrm = true;
      imm_size = 1u;
    } else if (op == 0x81u) {
      need_modrm = true;
      imm_size = imm_z;
    } else if (op >= 0x84u && op <= 0x8Fu) {
      need_modrm = true;
      imm_size = 0u;
    } else if (op >= 0x90u && op <= 0x9Fu && op != 0x9Au) {
      need_modrm = false;
      imm_size = 0u;
    } else if (op >= 0xA0u && op <= 0xA3u) {
      need_modrm = false;
      imm_size = d.has_67 ? 4u : 8u;
    } else if ((op >= 0xA4u && op <= 0xA7u) || (op >= 0xAAu && op <= 0xAFu)) {
      need_modrm = false;
      imm_size = 0u;
    } else if (op == 0xA8u) {
      need_modrm = false;
      imm_size = 1u;
    } else if (op == 0xA9u) {
      need_modrm = false;
      imm_size = imm_z;
    } else if (op >= 0xB0u && op <= 0xB7u) {
      need_modrm = false;
      imm_size = 1u;
    } else if (op >= 0xB8u && op <= 0xBFu) {
      need_modrm = false;
      imm_size = imm_v;
    } else if (op == 0xC0u || op == 0xC1u || op == 0xC6u) {
      need_modrm = true;
      imm_size = 1u;
    } else if (op == 0xC2u || op == 0xCAu) {
      need_modrm = false;
      imm_size = 2u;
    } else if (op == 0xC3u || op == 0xC9u || op == 0xCBu || op == 0xCCu || op == 0xCFu) {
      need_modrm = false;
      imm_size = 0u;
    } else if (op == 0xC7u) {
      need_modrm = true;
      imm_size = imm_z;
    } else if (op == 0xC8u) {
      need_modrm = false;
      imm_size = 3u;
    } else if (op == 0xCDu) {
      need_modrm = false;
      imm_size = 1u;
    } else if ((op >= 0xD0u && op <= 0xD3u) || (op >= 0xD8u && op <= 0xDFu)) {
      need_modrm = true;
      imm_size = 0u;
    } else if (op == 0xD7u) {
      need_modrm = false;
      imm_size = 0u;
    } else if ((op >= 0xE0u && op <= 0xE7u) || op == 0xEBu) {
      need_modrm = false;
      imm_size = 1u;
    } else if (op == 0xE8u || op == 0xE9u) {
      need_modrm = false;
      imm_size = 4u;
    } else if ((op >= 0xECu && op <= 0xEFu) || op == 0xF1u || op == 0xF4u ||
               op == 0xF5u || (op >= 0xF8u && op <= 0xFDu)) {
      need_modrm = false;
      imm_size = 0u;
    } else if (op == 0xF6u || op == 0xF7u) {
      need_modrm = true;
      check_grp3_imm = true;
    } else if (op == 0xFEu || op == 0xFFu) {
      need_modrm = true;
      imm_size = 0u;
    } else {
      return make_fallback_insn(pos);
    }
  }

  // 6. ModRM / SIB / disp
  if (need_modrm) {
    if (cur >= max_end) return make_fallback_insn(pos);
    const uint8_t modrm = code[cur++];
    d.has_modrm = true;
    d.mod = (modrm >> 6) & 3u;
    d.reg_field = (modrm >> 3) & 7u;
    d.rm_field = modrm & 7u;
    d.reg_num = static_cast<uint8_t>((d.rex_r << 3) | d.reg_field);
    d.rm_reg_num = static_cast<uint8_t>((d.rex_b << 3) | d.rm_field);

    if (check_grp3_imm) {
      if (d.reg_field == 0u || d.reg_field == 1u) {
        imm_size = (d.opcode == 0xF6u) ? 1u : imm_z;
      } else {
        imm_size = 0u;
      }
    }

    if (d.mod != 3u) {
      d.has_mem = true;
      uint32_t disp_size = 0u;
      if (d.rm_field == 4u) {
        // SIB required regardless of REX.B
        if (cur >= max_end) return make_fallback_insn(pos);
        const uint8_t sib = code[cur++];
        const uint8_t sib_base3 = sib & 7u;
        const uint8_t sib_idx3 = (sib >> 3) & 7u;
        const uint8_t idx_reg = static_cast<uint8_t>((d.rex_x << 3) | sib_idx3);
        const bool has_index = (idx_reg != 4u);
        if (d.mod == 0u && sib_base3 == 5u) {
          // No base register + disp32
          d.mem_valid = false;
          disp_size = 4u;
        } else {
          d.base_reg = static_cast<uint8_t>((d.rex_b << 3) | sib_base3);
          d.mem_valid = !has_index;
          disp_size = (d.mod == 1u) ? 1u : (d.mod == 2u ? 4u : 0u);
        }
      } else if (d.mod == 0u && d.rm_field == 5u) {
        // [rip + disp32] regardless of REX.B
        d.is_rip_rel = true;
        d.base_reg = 16u;
        d.mem_valid = true;
        disp_size = 4u;
      } else {
        d.base_reg = static_cast<uint8_t>((d.rex_b << 3) | d.rm_field);
        d.mem_valid = true;
        disp_size = (d.mod == 1u) ? 1u : (d.mod == 2u ? 4u : 0u);
      }

      if (disp_size > 0u) {
        if (cur + disp_size > max_end) return make_fallback_insn(pos);
        if (disp_size == 1u) {
          d.disp = static_cast<int32_t>(static_cast<int8_t>(code[cur]));
        } else {
          d.disp = read_i32_le(code, cur);
        }
        cur += disp_size;
      }
    }
  }

  // 7. Immediate
  if (imm_size > 0u) {
    if (cur + imm_size > max_end) return make_fallback_insn(pos);
    cur += imm_size;
  }

  d.len = static_cast<uint8_t>(cur - pos);
  d.valid = true;
  return d;
}

inline bool resolve_mem_target(
    const DecodedInsn& d,
    uint32_t base_off,
    uint8_t* out_base_reg,
    int32_t* out_disp) {
  if (!d.has_mem || !d.mem_valid) return false;
  if (d.is_rip_rel) {
    const int64_t next_off = static_cast<int64_t>(d.off) + static_cast<int64_t>(d.len);
    const int64_t target =
        static_cast<int64_t>(base_off) + next_off + static_cast<int64_t>(d.disp);
    if (target < -2147483648LL || target > 2147483647LL) return false;
    *out_base_reg = 16u;
    *out_disp = static_cast<int32_t>(target);
    return true;
  }
  // Exclude RSP(4) and RBP(5) ONLY; never exclude R12(12) or R13(13)
  if (d.base_reg == 4u || d.base_reg == 5u) return false;
  *out_base_reg = d.base_reg;
  *out_disp = d.disp;
  return true;
}

inline bool is_direct_clamp_insn(const DecodedInsn& d) {
  if (!d.valid || d.is_vex) return false;
  if (d.map == 0u) {
    const uint8_t op = d.opcode;
    if (op >= 0x38u && op <= 0x3Du) return true;  // cmp
    if ((op == 0x80u || op == 0x81u || op == 0x83u) && d.reg_field == 7u) return true;  // cmp imm
    if (op == 0x84u || op == 0x85u || op == 0xA8u || op == 0xA9u) return true;  // test
    if ((op == 0xF6u || op == 0xF7u) && (d.reg_field == 0u || d.reg_field == 1u)) return true;  // test imm
    if (op >= 0x70u && op <= 0x7Fu) return true;  // jcc rel8
  } else if (d.map == 1u) {
    const uint8_t op = d.opcode;
    if (op >= 0x40u && op <= 0x4Fu) return true;  // cmovcc
    if (op >= 0x80u && op <= 0x8Fu) return true;  // jcc rel32
  }
  return false;
}

inline bool is_lms_clamp_insn(const DecodedInsn& d) {
  if (!d.valid) return false;
  if (is_direct_clamp_insn(d)) return true;
  if (d.map == 1u) {
    const uint8_t op = d.opcode;
    if (op == 0x2Eu || op == 0x2Fu) return true;  // ucomiss/ucomisd/comiss/comisd
    if (op == 0x5Du || op == 0x5Fu) return true;  // minss/minsd/maxss/maxsd
  }
  return false;
}

inline bool is_control_barrier(const DecodedInsn& d) {
  if (!d.valid || d.is_vex || d.map != 0u) return false;
  const uint8_t op = d.opcode;
  if (op == 0xC2u || op == 0xC3u || op == 0xCAu || op == 0xCBu) return true;  // ret
  if (op == 0xE8u || op == 0xE9u || op == 0xEBu) return true;                 // call / jmp
  if (op == 0xFFu && (d.reg_field == 2u || d.reg_field == 3u ||
                      d.reg_field == 4u || d.reg_field == 5u)) {
    return true;  // call / jmp r/m
  }
  return false;
}

inline uint8_t gp_op_width(const DecodedInsn& d, bool is_byte_op) {
  if (is_byte_op) return 1u;
  if (d.rex_w) return 8u;
  if (d.has_66) return 2u;
  return 4u;
}

// Returns written GP register (0..15) for non-load/non-arith instructions, or 255 if none.
inline uint8_t get_other_gp_write_reg(const DecodedInsn& d) {
  if (!d.valid || d.is_vex) return 255u;
  const uint8_t op = d.opcode;
  if (d.map == 0u) {
    if (op == 0x88u || op == 0x89u) return d.mod == 3u ? d.rm_reg_num : 255u;
    if (op == 0x8Au || op == 0x8Bu) return d.mod == 3u ? d.reg_num : 255u;
    if (op == 0x8Du) return d.reg_num;  // lea
    if (op >= 0x58u && op <= 0x5Fu) return static_cast<uint8_t>((d.rex_b << 3) | (op & 7u));  // pop
    if (op >= 0xB0u && op <= 0xBFu) return static_cast<uint8_t>((d.rex_b << 3) | (op & 7u));  // mov imm
    if ((op == 0xC6u || op == 0xC7u || op == 0x8Fu) && d.mod == 3u && d.reg_field == 0u) {
      return d.rm_reg_num;
    }
    if ((op == 0x08u || op == 0x09u || op == 0x10u || op == 0x11u ||
         op == 0x18u || op == 0x19u || op == 0x20u || op == 0x21u ||
         op == 0x30u || op == 0x31u) && d.mod == 3u) {
      return d.rm_reg_num;
    }
    if (op == 0x0Au || op == 0x0Bu || op == 0x12u || op == 0x13u ||
        op == 0x1Au || op == 0x1Bu || op == 0x22u || op == 0x23u ||
        op == 0x32u || op == 0x33u) {
      return d.reg_num;
    }
    if ((op == 0x80u || op == 0x81u || op == 0x83u) && d.mod == 3u && d.reg_field != 7u) {
      return d.rm_reg_num;
    }
    if ((op == 0xC0u || op == 0xC1u || (op >= 0xD0u && op <= 0xD3u)) && d.mod == 3u) {
      return d.rm_reg_num;
    }
    if ((op == 0xF6u || op == 0xF7u) && d.mod == 3u &&
        (d.reg_field == 2u || d.reg_field == 3u)) {
      return d.rm_reg_num;
    }
    if (op == 0x69u || op == 0x6Bu) return d.reg_num;  // imul
  } else if (d.map == 1u) {
    if (op == 0xAFu) return d.reg_num;  // imul
    if (op >= 0x40u && op <= 0x4Fu) return d.reg_num;  // cmovcc
    if ((op == 0xB6u || op == 0xB7u || op == 0xBEu || op == 0xBFu) && d.mod == 3u) {
      return d.reg_num;
    }
  }
  return 255u;
}

struct PendingLoad {
  bool active;
  bool is_float;
  uint8_t reg;
  uint8_t base_reg;
  uint8_t width;
  uint8_t op_kind;  // 0=none, 1=sub, 2=add
  bool clamped;
  int32_t disp;
  uint32_t load_off;
  uint32_t arith_off;
  uint32_t load_insn_idx;
};

struct PendingClamp {
  bool active;
  bool is_direct;
  bool clamped;
  uint8_t op_kind;
  uint32_t emit_insn_idx;
  uint32_t hit_index;  // index in out_hits, or 0xFFFFFFFFu if not stored
};

uint32_t scan_x86_64_rmw_core(
    const uint8_t* code,
    uint32_t code_len,
    uint32_t base_off,
    RmwHit* out_hits,
    uint32_t max_out,
    RmwSummary* summary) {
  constexpr uint32_t kMaxPending = 16u;
  constexpr uint32_t kMaxPendingClamp = 4u;

  PendingLoad pending[kMaxPending]{};
  PendingClamp pclamp[kMaxPendingClamp]{};
  uint32_t pclamp_cursor = 0u;

  uint32_t written = 0u;
  uint32_t insn_idx = 0u;
  int64_t last_direct_clamp_idx = -100;

  auto emit_hit = [&](const RmwHit& hit, bool is_direct) {
    const bool is_clamped = (hit.flags & 1u) != 0u;
    uint32_t stored_idx = 0xFFFFFFFFu;
    if (out_hits != nullptr && written < max_out) {
      out_hits[written] = hit;
      stored_idx = written;
      written++;
    }
    if (summary != nullptr) {
      summary->total_hits++;
      if (hit.op_kind == 1u) {
        if (is_clamped) summary->clamped_sub++;
        else summary->unclamped_sub++;
      } else if (hit.op_kind == 2u) {
        summary->add_rmw++;
      }
    }
    if (!is_clamped) {
      pclamp[pclamp_cursor] = PendingClamp{
          true, is_direct, false, hit.op_kind, insn_idx, stored_idx};
      pclamp_cursor = (pclamp_cursor + 1u) & (kMaxPendingClamp - 1u);
    }
  };

  auto invalidate_base_reg = [&](uint8_t gp_reg) {
    for (uint32_t i = 0u; i < kMaxPending; ++i) {
      if (pending[i].active && pending[i].base_reg == gp_reg) {
        pending[i].active = false;
      }
    }
  };

  uint32_t pos = 0u;
  while (pos < code_len) {
    const DecodedInsn d = decode_x86_64_insn(code, code_len, pos);
    pos += d.len;

    // Expire pending loads older than 16 instructions
    for (uint32_t i = 0u; i < kMaxPending; ++i) {
      if (pending[i].active && (insn_idx - pending[i].load_insn_idx) > 16u) {
        pending[i].active = false;
      }
    }

    if (!d.valid) {
      insn_idx++;
      continue;
    }

    // Control barrier: call / ret / jmp clears all pending loads and post-clamp windows
    if (is_control_barrier(d)) {
      for (uint32_t i = 0u; i < kMaxPending; ++i) pending[i].active = false;
      for (uint32_t i = 0u; i < kMaxPendingClamp; ++i) pclamp[i].active = false;
      insn_idx++;
      continue;
    }

    // Clamp tracking (before / during / up to 3 instructions after store/direct-rmw)
    const bool dir_clamp = is_direct_clamp_insn(d);
    const bool lms_clamp = dir_clamp || is_lms_clamp_insn(d);

    if (dir_clamp) {
      last_direct_clamp_idx = static_cast<int64_t>(insn_idx);
    }
    if (lms_clamp) {
      for (uint32_t i = 0u; i < kMaxPendingClamp; ++i) {
        if (!pclamp[i].active || pclamp[i].clamped) continue;
        if ((insn_idx - pclamp[i].emit_insn_idx) > 3u) {
          pclamp[i].active = false;
          continue;
        }
        if (pclamp[i].is_direct && !dir_clamp) continue;
        pclamp[i].clamped = true;
        pclamp[i].active = false;
        if (pclamp[i].hit_index != 0xFFFFFFFFu && out_hits != nullptr) {
          out_hits[pclamp[i].hit_index].flags |= 1u;
        }
        if (summary != nullptr && pclamp[i].op_kind == 1u && summary->unclamped_sub > 0u) {
          summary->unclamped_sub--;
          summary->clamped_sub++;
        }
      }
      for (uint32_t i = 0u; i < kMaxPending; ++i) {
        if (pending[i].active) pending[i].clamped = true;
      }
    }

    // 1. Direct memory RMW
    if (!d.is_vex && d.map == 0u && d.has_mem && d.mem_valid) {
      uint8_t dir_op_kind = 0u;
      bool is_byte_op = false;
      const uint8_t op = d.opcode;
      if (op == 0x00u || op == 0x01u) {
        dir_op_kind = 2u;
        is_byte_op = (op == 0x00u);
      } else if (op == 0x28u || op == 0x29u) {
        dir_op_kind = 1u;
        is_byte_op = (op == 0x28u);
      } else if (op == 0x80u || op == 0x81u || op == 0x83u) {
        if (d.reg_field == 0u) dir_op_kind = 2u;
        else if (d.reg_field == 5u) dir_op_kind = 1u;
        is_byte_op = (op == 0x80u);
      } else if (op == 0xFEu || op == 0xFFu) {
        if (d.reg_field == 0u) dir_op_kind = 2u;
        else if (d.reg_field == 1u) dir_op_kind = 1u;
        is_byte_op = (op == 0xFEu);
      }

      if (dir_op_kind != 0u) {
        uint8_t mem_base = 0u;
        int32_t mem_disp = 0;
        if (resolve_mem_target(d, base_off, &mem_base, &mem_disp)) {
          const bool pre_clamped =
              (static_cast<int64_t>(insn_idx) - last_direct_clamp_idx) <= 3;
          const uint8_t flags = static_cast<uint8_t>(
              (pre_clamped ? 1u : 0u) | 4u | (d.has_lock ? 8u : 0u));
          RmwHit hit{};
          hit.load_off = d.off;
          hit.store_off = d.off;
          hit.arith_off = d.off;
          hit.disp = mem_disp;
          hit.base_reg = mem_base;
          hit.op_kind = dir_op_kind;
          hit.flags = flags;
          hit.width = gp_op_width(d, is_byte_op);
          emit_hit(hit, true);
        }
        insn_idx++;
        continue;
      }
    }

    // 2. Store (GP or Scalar FP) matching a modified pending load
    if (!d.is_vex && d.has_mem && d.mem_valid) {
      bool is_store = false;
      bool is_float_store = false;
      uint8_t store_width = 0u;
      if (d.map == 0u && (d.opcode == 0x88u || d.opcode == 0x89u)) {
        is_store = true;
        is_float_store = false;
        store_width = gp_op_width(d, d.opcode == 0x88u);
      } else if (d.map == 1u && d.opcode == 0x11u && (d.has_rep || d.has_repne)) {
        is_store = true;
        is_float_store = true;
        store_width = d.has_repne ? 8u : 4u;
      }

      if (is_store) {
        uint8_t mem_base = 0u;
        int32_t mem_disp = 0;
        if (resolve_mem_target(d, base_off, &mem_base, &mem_disp)) {
          int32_t best_slot = -1;
          for (uint32_t i = 0u; i < kMaxPending; ++i) {
            if (!pending[i].active) continue;
            if (pending[i].is_float != is_float_store) continue;
            if (pending[i].reg != d.reg_num) continue;
            if (pending[i].base_reg != mem_base) continue;
            if (pending[i].disp != mem_disp) continue;
            if (pending[i].op_kind == 0u) continue;
            if ((insn_idx - pending[i].load_insn_idx) > 16u) continue;
            if (best_slot < 0 ||
                pending[i].load_insn_idx > pending[best_slot].load_insn_idx) {
              best_slot = static_cast<int32_t>(i);
            }
          }
          if (best_slot >= 0) {
            const PendingLoad& pl = pending[best_slot];
            RmwHit hit{};
            hit.load_off = pl.load_off;
            hit.store_off = d.off;
            hit.arith_off = pl.arith_off;
            hit.disp = pl.disp;
            hit.base_reg = pl.base_reg;
            hit.op_kind = pl.op_kind;
            hit.flags = static_cast<uint8_t>(
                (pl.clamped ? 1u : 0u) | (pl.is_float ? 2u : 0u));
            hit.width = store_width;
            emit_hit(hit, false);
            pending[best_slot].active = false;
          }
        }
        insn_idx++;
        continue;
      }
    }

    // 3. Load (GP or Scalar FP)
    if (!d.is_vex && d.has_mem && d.mem_valid) {
      bool is_load = false;
      bool is_float_load = false;
      uint8_t load_width = 0u;
      if (d.map == 0u && (d.opcode == 0x8Au || d.opcode == 0x8Bu || d.opcode == 0x63u)) {
        is_load = true;
        is_float_load = false;
        load_width = (d.opcode == 0x63u) ? 4u : gp_op_width(d, d.opcode == 0x8Au);
      } else if (d.map == 1u &&
                 (d.opcode == 0xB6u || d.opcode == 0xB7u ||
                  d.opcode == 0xBEu || d.opcode == 0xBFu)) {
        is_load = true;
        is_float_load = false;
        load_width = (d.opcode == 0xB6u || d.opcode == 0xBEu) ? 1u : 2u;
      } else if (d.map == 1u && d.opcode == 0x10u && (d.has_rep || d.has_repne)) {
        is_load = true;
        is_float_load = true;
        load_width = d.has_repne ? 8u : 4u;
      }

      if (is_load) {
        if (!is_float_load) {
          invalidate_base_reg(d.reg_num);
        }
        for (uint32_t i = 0u; i < kMaxPending; ++i) {
          if (pending[i].active &&
              pending[i].is_float == is_float_load &&
              pending[i].reg == d.reg_num) {
            pending[i].active = false;
          }
        }
        uint8_t mem_base = 0u;
        int32_t mem_disp = 0;
        if (resolve_mem_target(d, base_off, &mem_base, &mem_disp)) {
          uint32_t target_slot = kMaxPending;
          uint32_t oldest_slot = 0u;
          for (uint32_t i = 0u; i < kMaxPending; ++i) {
            if (!pending[i].active) {
              target_slot = i;
              break;
            }
            if (pending[i].load_insn_idx < pending[oldest_slot].load_insn_idx) {
              oldest_slot = i;
            }
          }
          if (target_slot == kMaxPending) target_slot = oldest_slot;
          pending[target_slot] = PendingLoad{
              true, is_float_load, d.reg_num, mem_base, load_width,
              0u, false, mem_disp, d.off, 0u, insn_idx};
        }
        insn_idx++;
        continue;
      }
    }

    // 4. Modify (GP add/sub/inc/dec or Scalar FP addss/subss/addsd/subsd)
    if (!d.is_vex) {
      uint8_t mod_op_kind = 0u;
      bool mod_is_float = false;
      uint8_t mod_dst = 255u;

      if (d.map == 0u) {
        const uint8_t op = d.opcode;
        if ((op == 0x00u || op == 0x01u) && d.mod == 3u) {
          mod_op_kind = 2u;
          mod_dst = d.rm_reg_num;
        } else if (op == 0x02u || op == 0x03u) {
          mod_op_kind = 2u;
          mod_dst = d.reg_num;
        } else if (op == 0x04u || op == 0x05u) {
          mod_op_kind = 2u;
          mod_dst = 0u;
        } else if ((op == 0x28u || op == 0x29u) && d.mod == 3u) {
          mod_op_kind = 1u;
          mod_dst = d.rm_reg_num;
        } else if (op == 0x2Au || op == 0x2Bu) {
          mod_op_kind = 1u;
          mod_dst = d.reg_num;
        } else if (op == 0x2Cu || op == 0x2Du) {
          mod_op_kind = 1u;
          mod_dst = 0u;
        } else if ((op == 0x80u || op == 0x81u || op == 0x83u) && d.mod == 3u) {
          if (d.reg_field == 0u) {
            mod_op_kind = 2u;
            mod_dst = d.rm_reg_num;
          } else if (d.reg_field == 5u) {
            mod_op_kind = 1u;
            mod_dst = d.rm_reg_num;
          }
        } else if ((op == 0xFEu || op == 0xFFu) && d.mod == 3u) {
          if (d.reg_field == 0u) {
            mod_op_kind = 2u;
            mod_dst = d.rm_reg_num;
          } else if (d.reg_field == 1u) {
            mod_op_kind = 1u;
            mod_dst = d.rm_reg_num;
          }
        }
      } else if (d.map == 1u && (d.opcode == 0x58u || d.opcode == 0x5Cu) &&
                 (d.has_rep || d.has_repne)) {
        mod_op_kind = (d.opcode == 0x58u) ? 2u : 1u;
        mod_is_float = true;
        mod_dst = d.reg_num;
      }

      if (mod_op_kind != 0u && mod_dst < 16u) {
        if (!mod_is_float) {
          invalidate_base_reg(mod_dst);
        }
        for (uint32_t i = 0u; i < kMaxPending; ++i) {
          if (pending[i].active &&
              pending[i].is_float == mod_is_float &&
              pending[i].reg == mod_dst &&
              pending[i].op_kind == 0u) {
            pending[i].op_kind = mod_op_kind;
            pending[i].arith_off = d.off;
          }
        }
        insn_idx++;
        continue;
      }
    }

    // 5. Other GP register write invalidates pending loads using that register as base_reg
    const uint8_t written_gp = get_other_gp_write_reg(d);
    if (written_gp < 16u) {
      invalidate_base_reg(written_gp);
    }

    insn_idx++;
  }

  return written;
}

inline bool is_hw_crypto_insn(const DecodedInsn& d) {
  if (!d.valid) return false;
  // AES-NI: 66 0F 38 DB..DF / 66 0F 3A DF (and VEX equivalents)
  if (d.has_66) {
    if (d.map == 2u && d.opcode >= 0xDBu && d.opcode <= 0xDFu) return true;
    if (d.map == 3u && d.opcode == 0xDFu) return true;
  }
  // SHA-NI: 0F 38 C8..CD
  if (!d.is_vex && d.map == 2u && d.opcode >= 0xC8u && d.opcode <= 0xCDu) return true;
  return false;
}

inline bool is_ret_insn(const DecodedInsn& d) {
  return d.valid && !d.is_vex && d.map == 0u &&
         (d.opcode == 0xC2u || d.opcode == 0xC3u || d.opcode == 0xCAu || d.opcode == 0xCBu);
}

inline bool is_call_insn(const DecodedInsn& d) {
  return d.valid && !d.is_vex && d.map == 0u &&
         (d.opcode == 0xE8u || (d.opcode == 0xFFu && (d.reg_field == 2u || d.reg_field == 3u)));
}

inline bool is_load_insn(const DecodedInsn& d) {
  if (!d.valid || d.is_vex || !d.has_mem) return false;
  if (d.map == 0u && (d.opcode == 0x8Au || d.opcode == 0x8Bu || d.opcode == 0x63u)) return true;
  if (d.map == 1u && (d.opcode == 0xB6u || d.opcode == 0xB7u ||
                      d.opcode == 0xBEu || d.opcode == 0xBFu)) {
    return true;
  }
  if (d.map == 1u && d.opcode == 0x10u && (d.has_rep || d.has_repne)) return true;
  return false;
}

inline bool is_store_insn(const DecodedInsn& d) {
  if (!d.valid || d.is_vex || !d.has_mem) return false;
  if (d.map == 0u) {
    const uint8_t op = d.opcode;
    if (op == 0x88u || op == 0x89u) return true;
    if ((op == 0xC6u || op == 0xC7u) && d.reg_field == 0u) return true;
    if (op == 0x00u || op == 0x01u || op == 0x28u || op == 0x29u) return true;
    if ((op == 0x80u || op == 0x81u || op == 0x83u) &&
        (d.reg_field == 0u || d.reg_field == 5u)) {
      return true;
    }
    if ((op == 0xFEu || op == 0xFFu) &&
        (d.reg_field == 0u || d.reg_field == 1u)) {
      return true;
    }
  } else if (d.map == 1u && d.opcode == 0x11u && (d.has_rep || d.has_repne)) {
    return true;
  }
  return false;
}

inline bool is_muldiv_insn(const DecodedInsn& d) {
  if (!d.valid || d.is_vex) return false;
  if (d.map == 0u) {
    if (d.opcode == 0x69u || d.opcode == 0x6Bu) return true;
    if ((d.opcode == 0xF6u || d.opcode == 0xF7u) &&
        (d.reg_field >= 4u && d.reg_field <= 7u)) {
      return true;
    }
  } else if (d.map == 1u && d.opcode == 0xAFu) {
    return true;
  }
  return false;
}

inline bool is_fp_insn(const DecodedInsn& d) {
  if (!d.valid) return false;
  if (d.map == 1u) {
    const uint8_t op = d.opcode;
    if (op >= 0x2Au && op <= 0x2Fu) return true;
    if ((op >= 0x51u && op <= 0x53u) || (op >= 0x58u && op <= 0x5Fu)) return true;
  }
  return false;
}

inline bool is_bitwise_insn(const DecodedInsn& d) {
  if (!d.valid || d.is_vex) return false;
  if (d.map == 0u) {
    const uint8_t op = d.opcode;
    if ((op >= 0x08u && op <= 0x0Du) || (op >= 0x20u && op <= 0x25u)) return true;
    if (op >= 0x30u && op <= 0x33u) {
      // Exclude xor reg, reg zeroing idiom
      if (d.mod == 3u && d.reg_num == d.rm_reg_num) return false;
      return true;
    }
    if (op == 0x34u || op == 0x35u) return true;
    if ((op == 0x80u || op == 0x81u || op == 0x83u) &&
        (d.reg_field == 1u || d.reg_field == 4u || d.reg_field == 6u)) {
      return true;
    }
    if ((op == 0xF6u || op == 0xF7u) && d.reg_field == 2u) return true;  // not
    if (op == 0xC0u || op == 0xC1u || (op >= 0xD0u && op <= 0xD3u)) return true;  // shifts/rotates
  } else if (d.map == 1u) {
    const uint8_t op = d.opcode;
    if (op == 0xA4u || op == 0xA5u || op == 0xACu || op == 0xADu) return true;  // shld/shrd
    if (op >= 0xC8u && op <= 0xCFu) return true;  // bswap
  }
  return false;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_scan_x86_64_rmw_fields")
uint32_t hex_scan_x86_64_rmw_fields(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint32_t base_off,
    uint8_t* out_ptr,
    uint32_t max_out) {
  if (code_ptr == nullptr || out_ptr == nullptr || code_len < 1u || max_out == 0u) {
    return 0u;
  }

  RmwHit* out_hits = reinterpret_cast<RmwHit*>(out_ptr);
  const uint32_t written = scan_x86_64_rmw_core(
      code_ptr, code_len, base_off, out_hits, max_out, nullptr);

  for (uint32_t i = 0u; i < written; ++i) {
    const RmwHit hit = out_hits[i];
    write_rmw_hit_le(out_ptr + i * 20u, hit);
  }

  return written;
}

HEX_WASM_EXPORT("hex_classify_x86_64_behavior")
uint32_t hex_classify_x86_64_behavior(
    const uint8_t* code_ptr,
    uint32_t code_len,
    uint8_t* out_ptr) {
  if (code_ptr == nullptr || out_ptr == nullptr || code_len < 1u) {
    return 0u;
  }

  RmwSummary rmw{0u, 0u, 0u, 0u};
  scan_x86_64_rmw_core(code_ptr, code_len, 0u, nullptr, 0u, &rmw);

  uint32_t insn_count = 0u;
  uint32_t clamp_ops = 0u;
  uint32_t hw_crypto = 0u;
  uint32_t ret_ops = 0u;
  uint32_t load_ops = 0u;
  uint32_t store_ops = 0u;
  uint32_t muldiv_ops = 0u;
  uint32_t fp_ops = 0u;
  uint32_t bitwise_ops = 0u;
  uint32_t call_ops = 0u;

  uint32_t pos = 0u;
  while (pos < code_len) {
    const DecodedInsn d = decode_x86_64_insn(code_ptr, code_len, pos);
    pos += d.len;
    insn_count++;

    if (!d.valid) continue;

    if (is_lms_clamp_insn(d)) clamp_ops++;
    if (is_hw_crypto_insn(d)) hw_crypto++;
    if (is_ret_insn(d)) ret_ops++;
    if (is_call_insn(d)) call_ops++;
    if (is_load_insn(d)) load_ops++;
    if (is_store_insn(d)) store_ops++;
    if (is_muldiv_insn(d)) muldiv_ops++;
    if (is_fp_insn(d)) fp_ops++;
    if (is_bitwise_insn(d)) bitwise_ops++;
  }

  const uint32_t drain_score = sat_add_1000(
      sat_add_1000(sat_mul_1000(rmw.clamped_sub, 450u),
                   sat_mul_1000(rmw.unclamped_sub, 250u)),
      sat_mul_1000(clamp_ops, 40u));

  const uint32_t accum_score = sat_add_1000(
      sat_mul_1000(rmw.add_rmw, 350u),
      sat_mul_1000(store_ops, 40u));

  const uint32_t ratio_score = sat_add_1000(
      sat_mul_1000(muldiv_ops, 220u),
      sat_mul_1000(fp_ops, 120u));

  const uint32_t crypto_score = sat_add_1000(
      sat_mul_1000(hw_crypto, 500u),
      sat_mul_1000(bitwise_ops, 80u));

  const uint32_t accessor_score =
      (insn_count <= 8u &&
       call_ops == 0u &&
       (load_ops + store_ops) >= 1u &&
       ret_ops >= 1u &&
       rmw.clamped_sub == 0u &&
       rmw.unclamped_sub == 0u &&
       rmw.add_rmw == 0u)
          ? 900u
          : 0u;

  uint32_t best_score = 0u;
  uint32_t top_category = 0u;
  const uint32_t scores[5] = {
      drain_score,
      accum_score,
      ratio_score,
      crypto_score,
      accessor_score,
  };
  for (uint32_t i = 0u; i < 5u; ++i) {
    if (scores[i] > best_score) {
      best_score = scores[i];
      top_category = i + 1u;
    }
  }
  if (best_score < 250u) {
    top_category = 0u;
  }

  const uint32_t flags =
      (rmw.clamped_sub > 0u ? 1u : 0u) |
      (hw_crypto > 0u ? 2u : 0u) |
      (muldiv_ops > 0u ? 4u : 0u) |
      (rmw.add_rmw > 0u ? 8u : 0u) |
      (accessor_score > 0u ? 16u : 0u);

  write_u32_le(out_ptr + 0u, drain_score);
  write_u32_le(out_ptr + 4u, accum_score);
  write_u32_le(out_ptr + 8u, ratio_score);
  write_u32_le(out_ptr + 12u, crypto_score);
  write_u32_le(out_ptr + 16u, accessor_score);
  write_u32_le(out_ptr + 20u, top_category);
  write_u32_le(out_ptr + 24u, insn_count);
  write_u32_le(out_ptr + 28u, flags);

  return 1u;
}

}  // extern "C"
