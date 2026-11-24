#include "riscv64_decode.hpp"

namespace {

constexpr uint8_t kRegNone = 0xffu;

inline void copy_mn(char dst[16], const char* src) {
  size_t i = 0u;
  if (src != nullptr) {
    while (i < 15u && src[i] != '\0') {
      dst[i] = src[i];
      ++i;
    }
  }
  dst[i] = '\0';
}

inline int64_t sign_extend_u64(uint64_t val, uint32_t bits) {
  const uint64_t mask = (bits >= 64u) ? ~0ULL : ((1ULL << bits) - 1ULL);
  const uint64_t sign = 1ULL << (bits - 1u);
  const uint64_t v = val & mask;
  return static_cast<int64_t>((v ^ sign) - sign);
}

inline uint64_t add_signed_u64(uint64_t base, int64_t delta) {
  return base + static_cast<uint64_t>(delta);
}

inline uint16_t read_u16_le(const uint8_t* p) {
  return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) |
                               (static_cast<uint16_t>(p[1]) << 8));
}

inline uint32_t read_u32_le(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}

// Decode 16-bit RVC compressed instruction.
static uint32_t decode_rvc16(uint16_t hw, uint64_t pc, HexRiscv64Decoded& d) {
  if (hw == 0x0000u) {
    // 0x0000 is the permanently reserved illegal instruction in RISC-V.
    d.valid = 0u;
    d.length = 0u;
    d.kind = HEX_RISCV64_KIND_UNKNOWN;
    return 0u;
  }

  d.raw = static_cast<uint32_t>(hw);
  d.length = 2u;
  d.kind = HEX_RISCV64_KIND_RVC_COMPRESSED;
  d.cap = HEX_RISCV64_CAP_FALLBACK;
  d.opcode = static_cast<uint8_t>(hw & 0x3u);
  d.funct3 = static_cast<uint8_t>((hw >> 13) & 0x7u);
  d.valid = 1u;

  const uint8_t q = d.opcode;
  const uint8_t f3 = d.funct3;
  const uint8_t rdc = static_cast<uint8_t>(((hw >> 2) & 0x7u) + 8u);
  const uint8_t rs1c = static_cast<uint8_t>(((hw >> 7) & 0x7u) + 8u);
  const uint8_t rd_full = static_cast<uint8_t>((hw >> 7) & 0x1fu);
  const uint8_t rs2_full = static_cast<uint8_t>((hw >> 2) & 0x1fu);

  if (q == 0u) {
    switch (f3) {
      case 0u: {  // c.addi4spn
        const uint32_t nzuimm =
            (((hw >> 6) & 1u) << 2) |
            (((hw >> 5) & 1u) << 3) |
            (((hw >> 11) & 3u) << 4) |
            (((hw >> 7) & 0xfu) << 6);
        if (nzuimm == 0u) {
          d.valid = 0u;
          d.length = 0u;
          d.kind = HEX_RISCV64_KIND_UNKNOWN;
          return 0u;
        }
        d.rd = rdc;
        d.rs1 = 2u;  // sp
        d.imm = static_cast<int64_t>(nzuimm);
        d.has_imm = 1u;
        copy_mn(d.mn, "c.addi4spn");
        return 2u;
      }
      case 2u: {  // c.lw
        const uint32_t uimm =
            (((hw >> 6) & 1u) << 2) |
            (((hw >> 10) & 7u) << 3) |
            (((hw >> 5) & 1u) << 6);
        d.rd = rdc;
        d.rs1 = rs1c;
        d.imm = static_cast<int64_t>(uimm);
        d.has_imm = 1u;
        copy_mn(d.mn, "c.lw");
        return 2u;
      }
      case 3u: {  // c.ld (RV64C)
        const uint32_t uimm =
            (((hw >> 10) & 7u) << 3) |
            (((hw >> 5) & 3u) << 6);
        d.rd = rdc;
        d.rs1 = rs1c;
        d.imm = static_cast<int64_t>(uimm);
        d.has_imm = 1u;
        copy_mn(d.mn, "c.ld");
        return 2u;
      }
      case 6u: {  // c.sw
        const uint32_t uimm =
            (((hw >> 6) & 1u) << 2) |
            (((hw >> 10) & 7u) << 3) |
            (((hw >> 5) & 1u) << 6);
        d.rs1 = rs1c;
        d.rs2 = rdc;
        d.imm = static_cast<int64_t>(uimm);
        d.has_imm = 1u;
        copy_mn(d.mn, "c.sw");
        return 2u;
      }
      case 7u: {  // c.sd (RV64C)
        const uint32_t uimm =
            (((hw >> 10) & 7u) << 3) |
            (((hw >> 5) & 3u) << 6);
        d.rs1 = rs1c;
        d.rs2 = rdc;
        d.imm = static_cast<int64_t>(uimm);
        d.has_imm = 1u;
        copy_mn(d.mn, "c.sd");
        return 2u;
      }
      default:
        copy_mn(d.mn, "c.op");
        return 2u;
    }
  }

  if (q == 1u) {
    const int64_t imm6 = sign_extend_u64(
        (((static_cast<uint64_t>(hw) >> 12) & 1ULL) << 5) |
        ((static_cast<uint64_t>(hw) >> 2) & 0x1fULL),
        6u);
    switch (f3) {
      case 0u:  // c.nop / c.addi
        d.rd = rd_full;
        d.rs1 = rd_full;
        d.imm = imm6;
        d.has_imm = 1u;
        copy_mn(d.mn, (rd_full == 0u && imm6 == 0) ? "c.nop" : "c.addi");
        return 2u;
      case 1u:  // c.addiw (RV64C)
        d.rd = rd_full;
        d.rs1 = rd_full;
        d.imm = imm6;
        d.has_imm = 1u;
        copy_mn(d.mn, "c.addiw");
        return 2u;
      case 2u:  // c.li
        d.rd = rd_full;
        d.imm = imm6;
        d.has_imm = 1u;
        copy_mn(d.mn, "c.li");
        return 2u;
      case 3u:  // c.addi16sp / c.lui
        if (rd_full == 2u) {
          const uint64_t raw_imm =
              (((static_cast<uint64_t>(hw) >> 12) & 1ULL) << 9) |
              (((static_cast<uint64_t>(hw) >> 3) & 3ULL) << 7) |
              (((static_cast<uint64_t>(hw) >> 5) & 1ULL) << 6) |
              (((static_cast<uint64_t>(hw) >> 2) & 1ULL) << 5) |
              (((static_cast<uint64_t>(hw) >> 6) & 1ULL) << 4);
          d.rd = 2u;
          d.rs1 = 2u;
          d.imm = sign_extend_u64(raw_imm, 10u);
          d.has_imm = 1u;
          copy_mn(d.mn, "c.addi16sp");
        } else {
          d.rd = rd_full;
          d.imm = sign_extend_u64(static_cast<uint64_t>(imm6) << 12, 18u);
          d.has_imm = 1u;
          copy_mn(d.mn, "c.lui");
        }
        return 2u;
      case 4u: {  // c.srli / c.srai / c.andi / c.sub / c.xor / c.or / c.and / c.subw / c.addw
        const uint8_t subop = static_cast<uint8_t>((hw >> 10) & 3u);
        d.rd = rs1c;
        d.rs1 = rs1c;
        if (subop == 0u || subop == 1u) {
          d.imm = static_cast<int64_t>(
              (((hw >> 12) & 1u) << 5) | ((hw >> 2) & 0x1fu));
          d.has_imm = 1u;
          copy_mn(d.mn, subop == 0u ? "c.srli" : "c.srai");
        } else if (subop == 2u) {
          d.imm = imm6;
          d.has_imm = 1u;
          copy_mn(d.mn, "c.andi");
        } else {
          d.rs2 = rdc;
          const uint8_t op2 = static_cast<uint8_t>((((hw >> 12) & 1u) << 2) | ((hw >> 5) & 3u));
          static constexpr const char* kRvcAlu[8] = {
              "c.sub", "c.xor", "c.or", "c.and",
              "c.subw", "c.addw", "c.res", "c.res",
          };
          copy_mn(d.mn, kRvcAlu[op2]);
        }
        return 2u;
      }
      case 5u: {  // c.j imm12
        const uint64_t jimm =
            (((static_cast<uint64_t>(hw) >> 12) & 1ULL) << 11) |
            (((static_cast<uint64_t>(hw) >> 8) & 1ULL) << 10) |
            (((static_cast<uint64_t>(hw) >> 9) & 3ULL) << 8) |
            (((static_cast<uint64_t>(hw) >> 6) & 1ULL) << 7) |
            (((static_cast<uint64_t>(hw) >> 7) & 1ULL) << 6) |
            (((static_cast<uint64_t>(hw) >> 2) & 1ULL) << 5) |
            (((static_cast<uint64_t>(hw) >> 11) & 1ULL) << 4) |
            (((static_cast<uint64_t>(hw) >> 3) & 7ULL) << 1);
        d.imm = sign_extend_u64(jimm, 12u);
        d.has_imm = 1u;
        d.target = add_signed_u64(pc, d.imm);
        d.has_target = 1u;
        copy_mn(d.mn, "c.j");
        return 2u;
      }
      case 6u:
      case 7u: {  // c.beqz / c.bnez
        const uint64_t bimm =
            (((static_cast<uint64_t>(hw) >> 12) & 1ULL) << 8) |
            (((static_cast<uint64_t>(hw) >> 5) & 3ULL) << 6) |
            (((static_cast<uint64_t>(hw) >> 2) & 1ULL) << 5) |
            (((static_cast<uint64_t>(hw) >> 10) & 3ULL) << 3) |
            (((static_cast<uint64_t>(hw) >> 3) & 3ULL) << 1);
        d.rs1 = rs1c;
        d.imm = sign_extend_u64(bimm, 9u);
        d.has_imm = 1u;
        d.target = add_signed_u64(pc, d.imm);
        d.has_target = 1u;
        copy_mn(d.mn, f3 == 6u ? "c.beqz" : "c.bnez");
        return 2u;
      }
      default:
        copy_mn(d.mn, "c.op");
        return 2u;
    }
  }

  // q == 2
  switch (f3) {
    case 0u:  // c.slli
      d.rd = rd_full;
      d.rs1 = rd_full;
      d.imm = static_cast<int64_t>((((hw >> 12) & 1u) << 5) | ((hw >> 2) & 0x1fu));
      d.has_imm = 1u;
      copy_mn(d.mn, "c.slli");
      return 2u;
    case 2u: {  // c.lwsp
      const uint32_t uimm =
          (((hw >> 4) & 7u) << 2) |
          (((hw >> 12) & 1u) << 5) |
          (((hw >> 2) & 3u) << 6);
      d.rd = rd_full;
      d.rs1 = 2u;
      d.imm = static_cast<int64_t>(uimm);
      d.has_imm = 1u;
      copy_mn(d.mn, "c.lwsp");
      return 2u;
    }
    case 3u: {  // c.ldsp
      const uint32_t uimm =
          (((hw >> 5) & 3u) << 3) |
          (((hw >> 12) & 1u) << 5) |
          (((hw >> 2) & 7u) << 6);
      d.rd = rd_full;
      d.rs1 = 2u;
      d.imm = static_cast<int64_t>(uimm);
      d.has_imm = 1u;
      copy_mn(d.mn, "c.ldsp");
      return 2u;
    }
    case 4u: {
      const bool bit12 = ((hw >> 12) & 1u) != 0u;
      if (!bit12) {
        if (rs2_full == 0u) {
          if (rd_full == 0u) {
            d.valid = 0u;
            d.length = 0u;
            d.kind = HEX_RISCV64_KIND_UNKNOWN;
            return 0u;
          }
          d.rs1 = rd_full;
          d.is_ret = (rd_full == 1u) ? 1u : 0u;
          copy_mn(d.mn, "c.jr");
        } else {
          d.rd = rd_full;
          d.rs2 = rs2_full;
          copy_mn(d.mn, "c.mv");
        }
      } else {
        if (rd_full == 0u && rs2_full == 0u) {
          copy_mn(d.mn, "c.ebreak");
        } else if (rs2_full == 0u) {
          d.rd = 1u;  // ra
          d.rs1 = rd_full;
          d.is_call = 1u;
          copy_mn(d.mn, "c.jalr");
        } else {
          d.rd = rd_full;
          d.rs1 = rd_full;
          d.rs2 = rs2_full;
          copy_mn(d.mn, "c.add");
        }
      }
      return 2u;
    }
    case 6u: {  // c.swsp
      const uint32_t uimm = (((hw >> 9) & 0xfu) << 2) | (((hw >> 7) & 3u) << 6);
      d.rs1 = 2u;
      d.rs2 = rs2_full;
      d.imm = static_cast<int64_t>(uimm);
      d.has_imm = 1u;
      copy_mn(d.mn, "c.swsp");
      return 2u;
    }
    case 7u: {  // c.sdsp
      const uint32_t uimm = (((hw >> 10) & 7u) << 3) | (((hw >> 7) & 7u) << 6);
      d.rs1 = 2u;
      d.rs2 = rs2_full;
      d.imm = static_cast<int64_t>(uimm);
      d.has_imm = 1u;
      copy_mn(d.mn, "c.sdsp");
      return 2u;
    }
    default:
      copy_mn(d.mn, "c.op");
      return 2u;
  }
}

// Decode 32-bit RV64I/M instruction.
static uint32_t decode_rv32_word(uint32_t w, uint64_t pc, HexRiscv64Decoded& d) {
  const uint8_t opcode = static_cast<uint8_t>(w & 0x7fu);
  const uint8_t rd = static_cast<uint8_t>((w >> 7) & 0x1fu);
  const uint8_t funct3 = static_cast<uint8_t>((w >> 12) & 0x7u);
  const uint8_t rs1 = static_cast<uint8_t>((w >> 15) & 0x1fu);
  const uint8_t rs2 = static_cast<uint8_t>((w >> 20) & 0x1fu);
  const uint8_t funct7 = static_cast<uint8_t>((w >> 25) & 0x7fu);

  const int64_t imm_i = sign_extend_u64((static_cast<uint64_t>(w) >> 20) & 0xfffULL, 12u);
  const int64_t imm_s = sign_extend_u64(
      (((static_cast<uint64_t>(w) >> 25) & 0x7fULL) << 5) |
      ((static_cast<uint64_t>(w) >> 7) & 0x1fULL),
      12u);
  const int64_t imm_b = sign_extend_u64(
      (((static_cast<uint64_t>(w) >> 31) & 1ULL) << 12) |
      (((static_cast<uint64_t>(w) >> 7) & 1ULL) << 11) |
      (((static_cast<uint64_t>(w) >> 25) & 0x3fULL) << 5) |
      (((static_cast<uint64_t>(w) >> 8) & 0xfULL) << 1),
      13u);
  const int64_t imm_u = sign_extend_u64(static_cast<uint64_t>(w) & 0xfffff000ULL, 32u);
  const int64_t imm_j = sign_extend_u64(
      (((static_cast<uint64_t>(w) >> 31) & 1ULL) << 20) |
      (((static_cast<uint64_t>(w) >> 12) & 0xffULL) << 12) |
      (((static_cast<uint64_t>(w) >> 20) & 1ULL) << 11) |
      (((static_cast<uint64_t>(w) >> 21) & 0x3ffULL) << 1),
      21u);

  d.raw = w;
  d.length = 4u;
  d.cap = HEX_RISCV64_CAP_FALLBACK;
  d.opcode = opcode;
  d.funct3 = funct3;
  d.funct7 = funct7;
  d.valid = 1u;

  switch (opcode) {
    case 0x37u:  // LUI
      d.kind = HEX_RISCV64_KIND_LUI;
      d.rd = rd;
      d.imm = imm_u;
      d.has_imm = 1u;
      copy_mn(d.mn, "lui");
      return 4u;

    case 0x17u:  // AUIPC
      d.kind = HEX_RISCV64_KIND_AUIPC;
      d.rd = rd;
      d.imm = imm_u;
      d.has_imm = 1u;
      d.target = add_signed_u64(pc, imm_u);
      d.has_target = 1u;
      copy_mn(d.mn, "auipc");
      return 4u;

    case 0x6fu:  // JAL
      d.kind = HEX_RISCV64_KIND_JAL;
      d.rd = rd;
      d.imm = imm_j;
      d.has_imm = 1u;
      d.target = add_signed_u64(pc, imm_j);
      d.has_target = 1u;
      d.is_call = (rd == 1u || rd == 5u) ? 1u : 0u;
      copy_mn(d.mn, "jal");
      return 4u;

    case 0x67u:  // JALR
      if (funct3 != 0u) break;
      d.kind = HEX_RISCV64_KIND_JALR;
      d.rd = rd;
      d.rs1 = rs1;
      d.imm = imm_i;
      d.has_imm = 1u;
      d.is_ret = (rd == 0u && rs1 == 1u && imm_i == 0) ? 1u : 0u;
      d.is_call = (rd == 1u || rd == 5u) ? 1u : 0u;
      copy_mn(d.mn, d.is_ret ? "ret" : "jalr");
      return 4u;

    case 0x63u: {  // BRANCH
      static constexpr const char* kBrMn[8] = {
          "beq", "bne", nullptr, nullptr, "blt", "bge", "bltu", "bgeu",
      };
      if (kBrMn[funct3] == nullptr) break;
      d.kind = HEX_RISCV64_KIND_BRANCH;
      d.rs1 = rs1;
      d.rs2 = rs2;
      d.imm = imm_b;
      d.has_imm = 1u;
      d.target = add_signed_u64(pc, imm_b);
      d.has_target = 1u;
      copy_mn(d.mn, kBrMn[funct3]);
      return 4u;
    }

    case 0x03u: {  // LOAD
      static constexpr const char* kLoadMn[8] = {
          "lb", "lh", "lw", "ld", "lbu", "lhu", "lwu", nullptr,
      };
      if (kLoadMn[funct3] == nullptr) break;
      d.kind = HEX_RISCV64_KIND_LOAD;
      d.rd = rd;
      d.rs1 = rs1;
      d.imm = imm_i;
      d.has_imm = 1u;
      copy_mn(d.mn, kLoadMn[funct3]);
      return 4u;
    }

    case 0x23u: {  // STORE
      static constexpr const char* kStoreMn[8] = {
          "sb", "sh", "sw", "sd", nullptr, nullptr, nullptr, nullptr,
      };
      if (kStoreMn[funct3] == nullptr) break;
      d.kind = HEX_RISCV64_KIND_STORE;
      d.rs1 = rs1;
      d.rs2 = rs2;
      d.imm = imm_s;
      d.has_imm = 1u;
      copy_mn(d.mn, kStoreMn[funct3]);
      return 4u;
    }

    case 0x13u: {  // OP_IMM
      d.kind = HEX_RISCV64_KIND_OP_IMM;
      d.rd = rd;
      d.rs1 = rs1;
      d.has_imm = 1u;
      if (funct3 == 1u) {
        if ((w >> 26) != 0u) break;
        d.imm = static_cast<int64_t>((w >> 20) & 0x3fu);
        copy_mn(d.mn, "slli");
        return 4u;
      }
      if (funct3 == 5u) {
        const uint32_t hi6 = (w >> 26) & 0x3fu;
        if (hi6 != 0x00u && hi6 != 0x10u) break;
        d.imm = static_cast<int64_t>((w >> 20) & 0x3fu);
        copy_mn(d.mn, hi6 == 0x10u ? "srai" : "srli");
        return 4u;
      }
      static constexpr const char* kImmMn[8] = {
          "addi", nullptr, "slti", "sltiu", "xori", nullptr, "ori", "andi",
      };
      d.imm = imm_i;
      copy_mn(d.mn, kImmMn[funct3]);
      return 4u;
    }

    case 0x1bu: {  // OP_IMM_32
      d.kind = HEX_RISCV64_KIND_OP_IMM_32;
      d.rd = rd;
      d.rs1 = rs1;
      d.has_imm = 1u;
      if (funct3 == 0u) {
        d.imm = imm_i;
        copy_mn(d.mn, "addiw");
        return 4u;
      }
      if (funct3 == 1u && funct7 == 0x00u) {
        d.imm = static_cast<int64_t>((w >> 20) & 0x1fu);
        copy_mn(d.mn, "slliw");
        return 4u;
      }
      if (funct3 == 5u && (funct7 == 0x00u || funct7 == 0x20u)) {
        d.imm = static_cast<int64_t>((w >> 20) & 0x1fu);
        copy_mn(d.mn, funct7 == 0x20u ? "sraiw" : "srliw");
        return 4u;
      }
      break;
    }

    case 0x33u: {  // OP (RV64I + RV64M)
      d.kind = HEX_RISCV64_KIND_OP;
      d.rd = rd;
      d.rs1 = rs1;
      d.rs2 = rs2;
      if (funct7 == 0x01u) {
        static constexpr const char* kMulMn[8] = {
            "mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu",
        };
        copy_mn(d.mn, kMulMn[funct3]);
        return 4u;
      }
      if (funct7 == 0x00u) {
        static constexpr const char* kOp00[8] = {
            "add", "sll", "slt", "sltu", "xor", "srl", "or", "and",
        };
        copy_mn(d.mn, kOp00[funct3]);
        return 4u;
      }
      if (funct7 == 0x20u && (funct3 == 0u || funct3 == 5u)) {
        copy_mn(d.mn, funct3 == 0u ? "sub" : "sra");
        return 4u;
      }
      break;
    }

    case 0x3bu: {  // OP_32 (RV64I + RV64M)
      d.kind = HEX_RISCV64_KIND_OP_32;
      d.rd = rd;
      d.rs1 = rs1;
      d.rs2 = rs2;
      if (funct7 == 0x01u) {
        if (funct3 == 0u) { copy_mn(d.mn, "mulw"); return 4u; }
        if (funct3 == 4u) { copy_mn(d.mn, "divw"); return 4u; }
        if (funct3 == 5u) { copy_mn(d.mn, "divuw"); return 4u; }
        if (funct3 == 6u) { copy_mn(d.mn, "remw"); return 4u; }
        if (funct3 == 7u) { copy_mn(d.mn, "remuw"); return 4u; }
        break;
      }
      if (funct7 == 0x00u) {
        if (funct3 == 0u) { copy_mn(d.mn, "addw"); return 4u; }
        if (funct3 == 1u) { copy_mn(d.mn, "sllw"); return 4u; }
        if (funct3 == 5u) { copy_mn(d.mn, "srlw"); return 4u; }
        break;
      }
      if (funct7 == 0x20u && (funct3 == 0u || funct3 == 5u)) {
        copy_mn(d.mn, funct3 == 0u ? "subw" : "sraw");
        return 4u;
      }
      break;
    }

    case 0x73u: {  // SYSTEM
      d.kind = HEX_RISCV64_KIND_SYSTEM;
      if (funct3 == 0u) {
        if (w == 0x00000073u) {
          copy_mn(d.mn, "ecall");
          return 4u;
        }
        if (w == 0x00100073u) {
          copy_mn(d.mn, "ebreak");
          return 4u;
        }
        copy_mn(d.mn, "system");
        return 4u;
      }
      d.rd = rd;
      d.rs1 = rs1;
      d.imm = static_cast<int64_t>((w >> 20) & 0xfffu);
      d.has_imm = 1u;
      static constexpr const char* kCsrMn[8] = {
          nullptr, "csrrw", "csrrs", "csrrc", nullptr, "csrrwi", "csrrsi", "csrrci",
      };
      if (kCsrMn[funct3] == nullptr) break;
      copy_mn(d.mn, kCsrMn[funct3]);
      return 4u;
    }

    default:
      break;
  }

  d.kind = HEX_RISCV64_KIND_UNKNOWN;
  d.rd = kRegNone;
  d.rs1 = kRegNone;
  d.rs2 = kRegNone;
  d.has_imm = 0u;
  d.has_target = 0u;
  d.mn[0] = '\0';
  return 4u;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_riscv64_insn_length")
uint32_t hex_riscv64_insn_length(const uint8_t* bytes, uint32_t len) {
  if (bytes == nullptr || len == 0u) return 0u;
  const uint8_t b0 = bytes[0];
  if ((b0 & 0x3u) != 0x3u) {
    // 16-bit RVC compressed instruction
    if (len < 2u) return 0u;
    if (b0 == 0u && bytes[1] == 0u) return 0u;  // 0x0000 illegal
    return 2u;
  }
  if ((b0 & 0x1cu) != 0x1cu) {
    // Standard 32-bit RISC-V instruction
    if (len < 4u) return 0u;
    return 4u;
  }
  // 48-bit / 64-bit / >64-bit extended lengths are unsupported -> fail-closed 0
  return 0u;
}

HEX_WASM_EXPORT("hex_riscv64_decode_one")
uint32_t hex_riscv64_decode_one(
    const uint8_t* bytes,
    uint32_t len,
    uint64_t pc,
    HexRiscv64Decoded* out) {
  if (out != nullptr) {
    hex::mem_set(out, 0, sizeof(HexRiscv64Decoded));
    out->pc = pc;
    out->rd = kRegNone;
    out->rs1 = kRegNone;
    out->rs2 = kRegNone;
    out->cap = HEX_RISCV64_CAP_FALLBACK;
  }
  if (bytes == nullptr || len == 0u || out == nullptr) return 0u;

  const uint32_t ilen = hex_riscv64_insn_length(bytes, len);
  if (ilen == 0u || ilen > len) {
    out->valid = 0u;
    out->length = 0u;
    return 0u;
  }

  if (ilen == 2u) {
    return decode_rvc16(read_u16_le(bytes), pc, *out);
  }
  return decode_rv32_word(read_u32_le(bytes), pc, *out);
}

HEX_WASM_EXPORT("hex_riscv64_decode_batch")
uint32_t hex_riscv64_decode_batch(
    const uint8_t* bytes,
    uint32_t byte_len,
    uint64_t base_pc,
    HexRiscv64Decoded* out,
    uint32_t max_out) {
  if (bytes == nullptr || out == nullptr || max_out == 0u) return 0u;
  uint32_t off = 0u;
  uint32_t count = 0u;
  while (off < byte_len && count < max_out) {
    const uint32_t ilen = hex_riscv64_decode_one(
        bytes + off, byte_len - off, base_pc + static_cast<uint64_t>(off), &out[count]);
    if (ilen == 0u || out[count].valid == 0u) {
      out[count].valid = 0u;
      break;
    }
    off += ilen;
    ++count;
  }
  return count;
}

HEX_WASM_EXPORT("hex_riscv64_is_decompiler_supported")
int32_t hex_riscv64_is_decompiler_supported(const uint8_t* bytes, uint32_t len) {
  (void)bytes;
  (void)len;
  // Independent RISC-V binary corpus not yet verified: fail-closed to JS fallback.
  return HEX_RISCV64_CAP_FALLBACK;
}

HEX_WASM_EXPORT("hex_riscv64_kind_name")
const char* hex_riscv64_kind_name(uint8_t kind) {
  switch (static_cast<HexRiscv64Kind>(kind)) {
    case HEX_RISCV64_KIND_LUI: return "lui";
    case HEX_RISCV64_KIND_AUIPC: return "auipc";
    case HEX_RISCV64_KIND_JAL: return "jal";
    case HEX_RISCV64_KIND_JALR: return "jalr";
    case HEX_RISCV64_KIND_BRANCH: return "branch";
    case HEX_RISCV64_KIND_LOAD: return "load";
    case HEX_RISCV64_KIND_STORE: return "store";
    case HEX_RISCV64_KIND_OP_IMM: return "op_imm";
    case HEX_RISCV64_KIND_OP_IMM_32: return "op_imm_32";
    case HEX_RISCV64_KIND_OP: return "op";
    case HEX_RISCV64_KIND_OP_32: return "op_32";
    case HEX_RISCV64_KIND_SYSTEM: return "system";
    case HEX_RISCV64_KIND_RVC_COMPRESSED: return "rvc_compressed";
    case HEX_RISCV64_KIND_UNKNOWN:
    default:
      return "unknown";
  }
}

}  // extern "C"
