#include "hex_region_decomp.hpp"

namespace {

inline uint32_t gpr_bit(uint32_t reg) {
  return (reg < 31u) ? (1u << reg) : 0u;
}

inline uint32_t gpr_or_sp_bit(uint32_t reg) {
  return (reg < 32u) ? (1u << reg) : 0u;
}

// Classify a 32-bit ARM64 instruction word into an ASM Island entry.
// Returns HEX_ASM_ISLAND_NONE for standard modeled instructions.
HexAsmIslandEntry classify_arm64_word(uint64_t insn_va, uint32_t w) {
  HexAsmIslandEntry e;
  e.insn_va = insn_va;
  e.raw_word = w;
  e.kind = HEX_ASM_ISLAND_NONE;
  e.reg_read_mask = 0u;
  e.reg_write_mask = 0u;
  e.flags = HEX_ASM_FLAG_NONE;
  e.reserved_ = 0u;

  // 1. UDF / permanently unallocated 0x0000xxxx
  if ((w & 0xFFFF0000u) == 0x00000000u) {
    e.kind = HEX_ASM_ISLAND_UNKNOWN;
    e.reg_read_mask = 0x000000FFu;
    e.reg_write_mask = 0x000000FFu;
    e.flags = HEX_ASM_FLAG_CLOBBERS_MEM | HEX_ASM_FLAG_CLOBBERS_FLAGS |
              HEX_ASM_FLAG_MAY_TRAP | HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }

  // 2. SVE / SVE2 encoding space: bits[28:25] == 0b0010
  if ((w & 0x1E000000u) == 0x04000000u) {
    e.kind = HEX_ASM_ISLAND_SVE;
    e.flags = HEX_ASM_FLAG_SIMD_VEC | HEX_ASM_FLAG_SIDE_EFFECT;

    const uint32_t rd = w & 0x1Fu;
    const uint32_t rn = (w >> 5u) & 0x1Fu;
    const uint32_t rm = (w >> 16u) & 0x1Fu;

    // 2a. SVE Loads and Stores: bit 31 == 1 (0x84/0x85, 0xA4/0xA5, 0xC4/0xC5, 0xE4/0xE5)
    if ((w & 0x80000000u) != 0u) {
      e.reg_read_mask = gpr_or_sp_bit(rn);
      // Scalar-plus-scalar indexed loads/stores have bits[15:13] == 0b010 or 0b011
      const uint32_t mode = (w >> 13u) & 0x7u;
      if ((mode == 2u || mode == 3u) && rm < 31u) {
        e.reg_read_mask |= gpr_bit(rm);
      }
      e.flags |= HEX_ASM_FLAG_CLOBBERS_MEM;
      return e;
    }

    // 2b. RDVL Xd, #imm6 (0x04BF5000 mask 0xFFFFF800)
    if ((w & 0xFFFFF800u) == 0x04BF5000u) {
      e.reg_write_mask = gpr_bit(rd);
      return e;
    }

    // 2c. ADDVL / ADDPL Xd|SP, Xn|SP, #imm6 (0x04205000 / 0x04605000 mask 0xFFA0F800)
    if ((w & 0xFFA0F800u) == 0x04205000u) {
      e.reg_read_mask = gpr_or_sp_bit(rn);
      e.reg_write_mask = gpr_or_sp_bit(rd);
      return e;
    }

    // 2d. CNTB / CNTH / CNTW / CNTD Xd, pattern, MUL #imm4 (0x0420E000 mask 0xFF30FC00)
    if ((w & 0xFF30FC00u) == 0x0420E000u) {
      e.reg_write_mask = gpr_bit(rd);
      return e;
    }

    // 2e. INCB/H/W/D, DECB/H/W/D, SQINC*, SQDEC*, UQINC*, UQDEC* scalar (0x0430C000 mask 0xFF30C000)
    if ((w & 0xFF30C000u) == 0x0430C000u) {
      e.reg_read_mask = gpr_bit(rd);
      e.reg_write_mask = gpr_bit(rd);
      return e;
    }

    // 2f. CNTP Xd, Pg, Pn (0x25208000 mask 0xFF3FC200)
    if ((w & 0xFF3FC200u) == 0x25208000u) {
      e.reg_write_mask = gpr_bit(rd);
      return e;
    }

    // 2g. CLASTA / CLASTB / LASTA / LASTB scalar to GPR (0x052AA000 / 0x052BA000 / 0x0522A000 / 0x0523A000)
    if ((w & 0xFF36E000u) == 0x0522A000u) {
      const bool is_clast = ((w & 0x00080000u) != 0u);
      e.reg_read_mask = is_clast ? gpr_bit(rd) : 0u;
      e.reg_write_mask = gpr_bit(rd);
      return e;
    }

    // 2h. WHILELT / WHILELE / WHILELO / WHILELS Pd.T, Rn, Rm (0x25200400 mask 0xFF20EC00)
    if ((w & 0xFF20EC00u) == 0x25200400u) {
      e.reg_read_mask = gpr_bit(rn) | gpr_bit(rm);
      e.flags |= HEX_ASM_FLAG_CLOBBERS_FLAGS;
      return e;
    }

    return e;
  }

  // 3. Crypto AES: AESE / AESD / AESMC / AESIMC
  if ((w & 0xFFFFCC00u) == 0x4E284800u) {
    e.kind = HEX_ASM_ISLAND_CRYPTO_AES;
    e.flags = HEX_ASM_FLAG_SIMD_VEC | HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }

  // 4. Crypto SHA: SHA1 / SHA256 (2-reg & 3-reg) and SHA512 / SHA3
  const bool is_sha_2reg =
      ((w & 0xFFFF8C00u) == 0x5E280800u) && (((w >> 12u) & 7u) <= 2u);
  const bool is_sha_3reg =
      ((w & 0xFFE08C00u) == 0x5E000000u) && (((w >> 12u) & 7u) <= 6u);
  const bool is_sha512_3reg = ((w & 0xFFE0F000u) == 0xCE608000u);  // SHA512H/H2/SU1/RAX1
  const bool is_sha512_su0 = ((w & 0xFFFFFC00u) == 0xCEC08000u);   // SHA512SU0
  const bool is_sha3_eor3 = ((w & 0xFFE08000u) == 0xCE000000u);    // EOR3
  const bool is_sha3_bcax = ((w & 0xFFE08000u) == 0xCE200000u);    // BCAX
  const bool is_sha3_xar = ((w & 0xFFE00000u) == 0xCE800000u);     // XAR
  if (is_sha_2reg || is_sha_3reg || is_sha512_3reg || is_sha512_su0 ||
      is_sha3_eor3 || is_sha3_bcax || is_sha3_xar) {
    e.kind = HEX_ASM_ISLAND_CRYPTO_SHA;
    e.flags = HEX_ASM_FLAG_SIMD_VEC | HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }

  // 5. Exception generation: SVC / HVC / SMC / BRK
  if ((w & 0xFFE0001Fu) == 0xD4000001u) {  // SVC #imm16
    e.kind = HEX_ASM_ISLAND_SVC;
    e.reg_read_mask = 0x000101FFu;   // x0..x7 + x8 (Linux) + x16 (Darwin)
    e.reg_write_mask = 0x00000003u;  // x0..x1
    e.flags = HEX_ASM_FLAG_CLOBBERS_MEM | HEX_ASM_FLAG_CLOBBERS_FLAGS |
              HEX_ASM_FLAG_MAY_TRAP | HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }
  if ((w & 0xFFE0001Fu) == 0xD4000002u ||  // HVC #imm16
      (w & 0xFFE0001Fu) == 0xD4000003u) {  // SMC #imm16
    e.kind = HEX_ASM_ISLAND_SVC;
    e.reg_read_mask = 0x000101FFu;
    e.reg_write_mask = 0x0000000Fu;  // SMCCC returns in x0..x3
    e.flags = HEX_ASM_FLAG_CLOBBERS_MEM | HEX_ASM_FLAG_CLOBBERS_FLAGS |
              HEX_ASM_FLAG_MAY_TRAP | HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }
  if ((w & 0xFFE0001Fu) == 0xD4200000u) {  // BRK #imm16
    e.kind = HEX_ASM_ISLAND_SVC;
    e.reg_read_mask = 0u;
    e.reg_write_mask = 0u;
    e.flags = HEX_ASM_FLAG_CLOBBERS_MEM | HEX_ASM_FLAG_CLOBBERS_FLAGS |
              HEX_ASM_FLAG_MAY_TRAP | HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }

  // 6. PAC* Pointer Authentication
  // 6a. Hint-space PACIASP / PACIBSP / AUTIASP / AUTIBSP
  if (w == 0xD503233Fu || w == 0xD503237Fu ||
      w == 0xD50323BFu || w == 0xD50323FFu) {
    e.kind = HEX_ASM_ISLAND_PAC;
    e.reg_read_mask = (1u << 30u) | (1u << 31u);
    e.reg_write_mask = (1u << 30u);
    e.flags = HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }
  // 6b. Hint-space PACIAZ / PACIBZ / AUTIAZ / AUTIBZ / XPACLRI
  if (w == 0xD503231Fu || w == 0xD503235Fu ||
      w == 0xD503239Fu || w == 0xD50323DFu ||
      w == 0xD50320FFu) {
    e.kind = HEX_ASM_ISLAND_PAC;
    e.reg_read_mask = (1u << 30u);
    e.reg_write_mask = (1u << 30u);
    e.flags = HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }
  // 6c. Hint-space PACIA1716 / PACIB1716 / AUTIA1716 / AUTIB1716
  if (w == 0xD503211Fu || w == 0xD503215Fu ||
      w == 0xD503219Fu || w == 0xD50321DFu) {
    e.kind = HEX_ASM_ISLAND_PAC;
    e.reg_read_mask = (1u << 17u) | (1u << 16u);
    e.reg_write_mask = (1u << 17u);
    e.flags = HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }
  // 6d. Data-processing 1-source PAC*/AUT*/XPAC* (strict opcode check)
  if ((w & 0xFFFF0000u) == 0xDAC10000u) {
    const uint32_t opcode = (w >> 10u) & 0x3Fu;
    const uint32_t rn = (w >> 5u) & 0x1Fu;
    const uint32_t rd = w & 0x1Fu;
    if (opcode <= 0x07u) {
      // PACIA..AUTDB (Z=0): uses Rd and Rn|SP
      e.kind = HEX_ASM_ISLAND_PAC;
      e.reg_read_mask = gpr_bit(rd) | gpr_or_sp_bit(rn);
      e.reg_write_mask = gpr_bit(rd);
      e.flags = HEX_ASM_FLAG_SIDE_EFFECT;
      return e;
    }
    if (opcode <= 0x11u && rn == 31u) {
      // PACIZA..AUTDZB (0x08..0x0F, Z=1) and XPACI/XPACD (0x10..0x11): Rn=31 is NOT SP
      e.kind = HEX_ASM_ISLAND_PAC;
      e.reg_read_mask = gpr_bit(rd);
      e.reg_write_mask = gpr_bit(rd);
      e.flags = HEX_ASM_FLAG_SIDE_EFFECT;
      return e;
    }
  }
  // 6e. PACGA Xd, Xn, Xm|SP
  if ((w & 0xFFE0FC00u) == 0x9AC03000u) {
    const uint32_t rd = w & 0x1Fu;
    const uint32_t rn = (w >> 5u) & 0x1Fu;
    const uint32_t rm = (w >> 16u) & 0x1Fu;
    e.kind = HEX_ASM_ISLAND_PAC;
    e.reg_read_mask = gpr_bit(rn) | gpr_or_sp_bit(rm);
    e.reg_write_mask = gpr_bit(rd);
    e.flags = HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }
  // 6f. PAC authenticated branches/returns: BRAAZ/BRABZ, BLRAAZ/BLRABZ, BRAA/BRAB, BLRAA/BLRAB, RETAA/RETAB/ERETAA/ERETAB
  if (w == 0xD65F0BFFu || w == 0xD65F0FFFu ||  // RETAA / RETAB
      w == 0xD69F0BFFu || w == 0xD69F0FFFu) {  // ERETAA / ERETAB
    const bool is_eret = ((w & 0x00800000u) != 0u);
    e.kind = HEX_ASM_ISLAND_PAC;
    e.reg_read_mask = (1u << 30u) | (1u << 31u);
    e.reg_write_mask = 0u;
    e.flags = HEX_ASM_FLAG_SIDE_EFFECT | (is_eret ? HEX_ASM_FLAG_MAY_TRAP : 0u);
    return e;
  }
  if ((w & 0xFFFFFB1Fu) == 0xD61F081Fu ||  // BRAAZ / BRABZ
      (w & 0xFFFFFB1Fu) == 0xD63F081Fu) {  // BLRAAZ / BLRABZ
    const bool is_link = ((w & 0x00200000u) != 0u);
    const uint32_t rn = (w >> 5u) & 0x1Fu;
    e.kind = HEX_ASM_ISLAND_PAC;
    e.reg_read_mask = gpr_bit(rn);
    e.reg_write_mask = is_link ? (1u << 30u) : 0u;
    e.flags = HEX_ASM_FLAG_SIDE_EFFECT | (is_link ? HEX_ASM_FLAG_CLOBBERS_MEM : 0u);
    return e;
  }
  if ((w & 0xFFFFFB00u) == 0xD71F0800u ||  // BRAA / BRAB
      (w & 0xFFFFFB00u) == 0xD73F0800u) {  // BLRAA / BLRAB
    const bool is_link = ((w & 0x00200000u) != 0u);
    const uint32_t rn = (w >> 5u) & 0x1Fu;
    const uint32_t rm = w & 0x1Fu;
    e.kind = HEX_ASM_ISLAND_PAC;
    e.reg_read_mask = gpr_bit(rn) | gpr_or_sp_bit(rm);
    e.reg_write_mask = is_link ? (1u << 30u) : 0u;
    e.flags = HEX_ASM_FLAG_SIDE_EFFECT | (is_link ? HEX_ASM_FLAG_CLOBBERS_MEM : 0u);
    return e;
  }

  // 7. System instructions: MRS / MSR / Barriers (DMB/DSB/ISB)
  // 7a. MRS Xt, <sysreg>: 0xD5300000..0xD53FFFFF
  if ((w & 0xFFF00000u) == 0xD5300000u) {
    const uint32_t rt = w & 0x1Fu;
    e.kind = HEX_ASM_ISLAND_SYS;
    e.reg_read_mask = 0u;
    e.reg_write_mask = gpr_bit(rt);
    e.flags = HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }
  // 7b. MSR <sysreg>, Xt: 0xD5100000..0xD51FFFFF
  if ((w & 0xFFF00000u) == 0xD5100000u) {
    const uint32_t rt = w & 0x1Fu;
    const uint32_t sysreg_bits = w & 0x000FFFE0u;
    const bool is_nzcv_or_daif = (sysreg_bits == 0x000B4200u || sysreg_bits == 0x000B4220u);
    e.kind = HEX_ASM_ISLAND_SYS;
    e.reg_read_mask = gpr_bit(rt);
    e.reg_write_mask = 0u;
    e.flags = HEX_ASM_FLAG_CLOBBERS_MEM | HEX_ASM_FLAG_SIDE_EFFECT |
              (is_nzcv_or_daif ? HEX_ASM_FLAG_CLOBBERS_FLAGS : 0u);
    return e;
  }
  // 7c. MSR <pstatefield>, #imm: 0xD500401F mask 0xFFF8F01F
  if ((w & 0xFFF8F01Fu) == 0xD500401Fu) {
    e.kind = HEX_ASM_ISLAND_SYS;
    e.reg_read_mask = 0u;
    e.reg_write_mask = 0u;
    e.flags = HEX_ASM_FLAG_CLOBBERS_FLAGS | HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }
  // 7d. Memory/Instruction barriers: DSB / DMB / ISB
  if ((w & 0xFFFFF09Fu) == 0xD503309Fu) {
    e.kind = HEX_ASM_ISLAND_SYS;
    e.reg_read_mask = 0u;
    e.reg_write_mask = 0u;
    e.flags = HEX_ASM_FLAG_CLOBBERS_MEM | HEX_ASM_FLAG_SIDE_EFFECT;
    return e;
  }

  return e;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_asm_island_classify")
uint32_t hex_asm_island_classify(
    uint64_t insn_va,
    uint32_t raw_word,
    HexAsmIslandEntry* out_entry) {
  const HexAsmIslandEntry entry = classify_arm64_word(insn_va, raw_word);
  if (out_entry != nullptr) {
    *out_entry = entry;
  }
  return entry.kind;
}

HEX_WASM_EXPORT("hex_asm_island_register")
int32_t hex_asm_island_register(
    HexAsmIslandEntry* table,
    uint32_t capacity,
    uint32_t* inout_count,
    uint64_t insn_va,
    uint32_t raw_word,
    uint32_t* out_index,
    uint16_t* inout_inst_flags) {
  if (table == nullptr || inout_count == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  const HexAsmIslandEntry entry = classify_arm64_word(insn_va, raw_word);
  if (entry.kind == HEX_ASM_ISLAND_NONE) {
    if (out_index != nullptr) {
      *out_index = 0xFFFFFFFFu;
    }
    return HEX_OK;
  }

  const uint32_t idx = *inout_count;
  if (idx >= capacity) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  table[idx] = entry;
  *inout_count = idx + 1u;
  if (out_index != nullptr) {
    *out_index = idx;
  }
  if (inout_inst_flags != nullptr) {
    *inout_inst_flags = static_cast<uint16_t>(*inout_inst_flags | HEX_IR_FLAG_ASM_ISLAND);
  }
  return HEX_OK;
}

}  // extern "C"
