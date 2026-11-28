#include "decompiler/passes/arm64_ir_pipeline.hpp"

#include <stddef.h>
#include <stdint.h>

#include "cfg/cfg_engine.hpp"
#include "cfg/loop_engine.hpp"
#include "hex_core/hex_core.hpp"

namespace hex::decompiler::passes {

namespace {

static hex::Arena* g_ir_scratch_arena = nullptr;

static constexpr uint32_t kMaxWords = 512u;
static constexpr uint32_t kMaxBlocks = 512u;
static constexpr uint32_t kMaxStackSlots = 64u;
static constexpr uint32_t kSlotFlags = 31u;
static constexpr uint32_t kSlotStackBase = 32u;
static constexpr uint32_t kMaxSlots = kSlotStackBase + kMaxStackSlots;
static constexpr uint32_t kNoVal = 0xFFFFFFFFu;
static constexpr uint32_t kMaxInsts = 4096u;
static constexpr uint32_t kMaxPhiArgs = 4096u;
static constexpr uint32_t kMaxTextBytes = 256u * 1024u;
static constexpr uint32_t kMaxLineMap = 2048u;
static constexpr uint32_t kMaxInlineDepth = 6u;
static constexpr uint32_t kMaxNormNameLen = 128u;

// -----------------------------------------------------------------------------
// Bit helpers & ARM64 decoding
// -----------------------------------------------------------------------------

static inline int64_t sign_extend(uint32_t val, uint32_t bits) {
  const uint64_t mask = (1ULL << bits) - 1ULL;
  const uint64_t sign = 1ULL << (bits - 1u);
  const uint64_t v = static_cast<uint64_t>(val) & mask;
  return static_cast<int64_t>((v ^ sign) - sign);
}

static inline uint64_t mask_width(uint64_t v, uint8_t width) {
  return (width == 32u) ? (v & 0xFFFFFFFFULL) : v;
}

static inline bool decode_bitmask_imm(uint32_t sf, uint32_t N, uint32_t immr, uint32_t imms, uint64_t* out) {
  if (sf == 0u && N != 0u) return false;
  const uint32_t comb = (N << 6u) | ((~imms) & 0x3Fu);
  if (comb == 0u) return false;
  uint32_t len = 0u;
  for (uint32_t b = 6u; b >= 1u; --b) {
    if ((comb & (1u << b)) != 0u) {
      len = b;
      break;
    }
  }
  if (len < 1u) return false;
  const uint32_t levels = (1u << len) - 1u;
  if ((imms & levels) == levels) return false;
  const uint32_t S = imms & levels;
  const uint32_t R = immr & levels;
  const uint32_t esize = 1u << len;
  uint64_t welem = (esize == 64u) ? (~0ULL >> (63u - S)) : ((1ULL << (S + 1u)) - 1ULL);
  if (R != 0u) {
    const uint64_t emask = (esize == 64u) ? ~0ULL : ((1ULL << esize) - 1ULL);
    welem = ((welem >> R) | (welem << (esize - R))) & emask;
  }
  uint64_t res = welem;
  for (uint32_t sh = esize; sh < 64u; sh <<= 1u) {
    res |= (res << sh);
  }
  if (sf == 0u) res &= 0xFFFFFFFFULL;
  *out = res;
  return true;
}

enum DecKind : uint8_t {
  DK_INVALID = 0,
  DK_NOP,
  DK_ADD_IMM,
  DK_SUB_IMM,
  DK_SP_ADD_IMM,   // add/sub sp, sp, #imm  (disp in imm_s)
  DK_FP_FROM_SP,   // add x29, sp, #imm     (disp in imm_s)
  DK_SP_FROM_FP,   // add sp, x29, #imm     (disp in imm_s)
  DK_ADD_REG,      // shifted reg
  DK_SUB_REG,      // shifted reg
  DK_MADD,         // rd = ra + rn * rm
  DK_MSUB,         // rd = ra - rn * rm
  DK_UDIV,
  DK_SDIV,
  DK_LOGIC_IMM,    // opc: 0=AND, 1=ORR, 2=EOR, 3=ANDS
  DK_LOGIC_REG,    // opc: 0=AND, 1=ORR, 2=EOR, 3=ANDS; flag_n = invert rm
  DK_SHIFTV,       // subop: 0=LSLV, 1=LSRV, 2=ASRV, 3=RORV
  DK_UBFM,
  DK_SBFM,
  DK_MOVZ,
  DK_MOVN,
  DK_MOVK,
  DK_COND_SEL,     // subop: 0=CSEL, 1=CSINC, 2=CSINV, 3=CSNEG
  DK_B,
  DK_B_COND,
  DK_CBZ,
  DK_CBNZ,
  DK_TBZ,
  DK_TBNZ,
  DK_RET,
  DK_STP_64,       // pair store to sp/fp (subop: 0=signed, 1=pre, 2=post)
  DK_LDP_64,       // pair load from sp/fp (subop: 0=signed, 1=pre, 2=post)
  DK_MEM_STORE,    // scalar store [rn + disp] (32/64-bit, stack only)
  DK_MEM_LOAD,     // scalar load [rn + disp] (stack or pure read-only ptr)
};

struct DecInsn {
  DecKind kind;
  uint8_t width;     // 32 or 64
  uint8_t rd;        // or rt
  uint8_t rn;
  uint8_t rm;        // or rt2
  uint8_t ra;        // for madd/msub
  uint8_t subop;     // opc / shift / cond / addr_mode
  uint8_t aux;       // imm6 / bit_pos / hw / immr / mem_bytes
  uint8_t aux2;      // imms / is_signed
  uint8_t flags;     // bit0=sets_flags, bit1=invert_rm(N)
  uint64_t imm_u;
  int64_t imm_s;
  uint32_t target_idx;
  uint64_t pc;
};

static bool decode_arm64_word(uint32_t w, uint64_t pc, uint64_t base_addr, uint32_t word_count, DecInsn* d) {
  hex::mem_set(d, 0, sizeof(*d));
  d->kind = DK_INVALID;
  d->pc = pc;
  const uint64_t code_bytes = static_cast<uint64_t>(word_count) * 4ULL;
  if (code_bytes > UINT64_MAX - base_addr) return false;
  const uint64_t code_end = base_addr + code_bytes;

  // Canonical NOP
  if (w == 0xD503201Fu) {
    d->kind = DK_NOP;
    return true;
  }

  // Canonical RET (x30)
  if (w == 0xD65F03C0u) {
    d->kind = DK_RET;
    return true;
  }

  // B #imm26 (internal only)
  if ((w & 0xFC000000u) == 0x14000000u) {
    const int64_t delta = sign_extend(w & 0x03FFFFFFu, 26u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (target < base_addr || target >= code_end || ((target - base_addr) & 3ULL) != 0ULL) return false;
    d->kind = DK_B;
    d->target_idx = static_cast<uint32_t>((target - base_addr) / 4ULL);
    return true;
  }

  // B.cc #imm19 (internal only)
  if ((w & 0xFF000010u) == 0x54000000u) {
    const int64_t delta = sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (target < base_addr || target >= code_end || ((target - base_addr) & 3ULL) != 0ULL) return false;
    d->kind = DK_B_COND;
    d->subop = static_cast<uint8_t>(w & 0xFu);
    d->target_idx = static_cast<uint32_t>((target - base_addr) / 4ULL);
    return true;
  }

  // CBZ / CBNZ (internal only)
  if ((w & 0x7E000000u) == 0x34000000u) {
    const int64_t delta = sign_extend((w >> 5u) & 0x7FFFFu, 19u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (target < base_addr || target >= code_end || ((target - base_addr) & 3ULL) != 0ULL) return false;
    d->kind = ((w >> 24u) & 1u) ? DK_CBNZ : DK_CBZ;
    d->width = ((w >> 31u) & 1u) ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->target_idx = static_cast<uint32_t>((target - base_addr) / 4ULL);
    return true;
  }

  // TBZ / TBNZ (internal only)
  if ((w & 0x7E000000u) == 0x36000000u) {
    const int64_t delta = sign_extend((w >> 5u) & 0x3FFFu, 14u) * 4LL;
    const uint64_t target = pc + static_cast<uint64_t>(delta);
    if (target < base_addr || target >= code_end || ((target - base_addr) & 3ULL) != 0ULL) return false;
    const uint32_t b5 = (w >> 31u) & 1u;
    const uint32_t b40 = (w >> 19u) & 0x1Fu;
    d->kind = ((w >> 24u) & 1u) ? DK_TBNZ : DK_TBZ;
    d->width = b5 ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->aux = static_cast<uint8_t>((b5 << 5u) | b40);
    d->target_idx = static_cast<uint32_t>((target - base_addr) / 4ULL);
    return true;
  }

  // ADD / ADDS / SUB / SUBS (immediate)
  if ((w & 0x1F800000u) == 0x11000000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t op = (w >> 30u) & 1u;
    const uint32_t S = (w >> 29u) & 1u;
    const uint32_t sh = (w >> 22u) & 1u;
    const uint64_t imm = static_cast<uint64_t>((w >> 10u) & 0xFFFu) << (sh ? 12u : 0u);
    const uint8_t rn = static_cast<uint8_t>((w >> 5u) & 31u);
    const uint8_t rd = static_cast<uint8_t>(w & 31u);
    d->width = sf ? 64u : 32u;
    d->rd = rd;
    d->rn = rn;
    d->imm_u = imm;
    d->flags = static_cast<uint8_t>(S ? 1u : 0u);

    if (S == 0u) {
      // SP handling when S == 0
      if (rn == 31u || rd == 31u) {
        if (!sf) return false;
        if (rd == 31u && rn == 31u) {
          d->kind = DK_SP_ADD_IMM;
          d->imm_s = op ? -static_cast<int64_t>(imm) : static_cast<int64_t>(imm);
          return true;
        }
        if (rd == 29u && rn == 31u && op == 0u) {
          d->kind = DK_FP_FROM_SP;
          d->imm_s = static_cast<int64_t>(imm);
          return true;
        }
        if (rd == 31u && rn == 29u && op == 0u) {
          d->kind = DK_SP_FROM_FP;
          d->imm_s = static_cast<int64_t>(imm);
          return true;
        }
        // SP escapes to another register -> fail-closed!
        return false;
      }
    } else {
      // S == 1: rn == 31 is SP (reject), rd == 31 is ZR (CMP/CMN)
      if (rn == 31u) return false;
    }

    d->kind = op ? DK_SUB_IMM : DK_ADD_IMM;
    return true;
  }

  // ADD / ADDS / SUB / SUBS (shifted register)
  if ((w & 0x1F200000u) == 0x0B000000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t op = (w >> 30u) & 1u;
    const uint32_t S = (w >> 29u) & 1u;
    const uint32_t shift = (w >> 22u) & 3u;
    const uint32_t imm6 = (w >> 10u) & 0x3Fu;
    if (shift == 3u) return false;
    if (!sf && imm6 >= 32u) return false;
    d->kind = op ? DK_SUB_REG : DK_ADD_REG;
    d->width = sf ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->rn = static_cast<uint8_t>((w >> 5u) & 31u);
    d->rm = static_cast<uint8_t>((w >> 16u) & 31u);
    d->subop = static_cast<uint8_t>(shift);
    d->aux = static_cast<uint8_t>(imm6);
    d->flags = static_cast<uint8_t>(S ? 1u : 0u);
    return true;
  }

  // MADD / MSUB (includes MUL / MNEG)
  if ((w & 0x7FE00000u) == 0x1B000000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t o0 = (w >> 15u) & 1u;
    d->kind = o0 ? DK_MSUB : DK_MADD;
    d->width = sf ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->rn = static_cast<uint8_t>((w >> 5u) & 31u);
    d->ra = static_cast<uint8_t>((w >> 10u) & 31u);
    d->rm = static_cast<uint8_t>((w >> 16u) & 31u);
    return true;
  }

  // UDIV / SDIV
  if ((w & 0x7FE0FC00u) == 0x1AC00800u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t o1 = (w >> 10u) & 1u;
    d->kind = o1 ? DK_SDIV : DK_UDIV;
    d->width = sf ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->rn = static_cast<uint8_t>((w >> 5u) & 31u);
    d->rm = static_cast<uint8_t>((w >> 16u) & 31u);
    return true;
  }

  // Variable shifts: LSLV / LSRV / ASRV / RORV
  if ((w & 0x7FE0F000u) == 0x1AC02000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t op2 = (w >> 10u) & 3u;
    d->kind = DK_SHIFTV;
    d->width = sf ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->rn = static_cast<uint8_t>((w >> 5u) & 31u);
    d->rm = static_cast<uint8_t>((w >> 16u) & 31u);
    d->subop = static_cast<uint8_t>(op2);
    return true;
  }

  // Logical (bitmask immediate): AND / ORR / EOR / ANDS (TST)
  if ((w & 0x1F800000u) == 0x12000000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t opc = (w >> 29u) & 3u;
    const uint32_t N = (w >> 22u) & 1u;
    const uint32_t immr = (w >> 16u) & 0x3Fu;
    const uint32_t imms = (w >> 10u) & 0x3Fu;
    const uint8_t rd = static_cast<uint8_t>(w & 31u);
    // When opc != 3, rd == 31 is SP -> reject
    if (opc != 3u && rd == 31u) return false;
    uint64_t imm = 0ULL;
    if (!decode_bitmask_imm(sf, N, immr, imms, &imm)) return false;
    d->kind = DK_LOGIC_IMM;
    d->width = sf ? 64u : 32u;
    d->rd = rd;
    d->rn = static_cast<uint8_t>((w >> 5u) & 31u);
    d->subop = static_cast<uint8_t>(opc);
    d->flags = static_cast<uint8_t>(opc == 3u ? 1u : 0u);
    d->imm_u = imm;
    return true;
  }

  // Logical (shifted register): AND / BIC / ORR / ORN / EOR / EON / ANDS / BICS
  if ((w & 0x1F000000u) == 0x0A000000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t opc = (w >> 29u) & 3u;
    const uint32_t shift = (w >> 22u) & 3u;
    const uint32_t N = (w >> 21u) & 1u;
    const uint32_t imm6 = (w >> 10u) & 0x3Fu;
    if (!sf && imm6 >= 32u) return false;
    d->kind = DK_LOGIC_REG;
    d->width = sf ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->rn = static_cast<uint8_t>((w >> 5u) & 31u);
    d->rm = static_cast<uint8_t>((w >> 16u) & 31u);
    d->subop = static_cast<uint8_t>((opc << 2u) | shift);
    d->aux = static_cast<uint8_t>(imm6);
    d->flags = static_cast<uint8_t>((opc == 3u ? 1u : 0u) | (N ? 2u : 0u));
    return true;
  }

  // Bitfield: SBFM (opc=0) / UBFM (opc=2)
  if ((w & 0x1F800000u) == 0x13000000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t opc = (w >> 29u) & 3u;
    const uint32_t N = (w >> 22u) & 1u;
    const uint32_t immr = (w >> 16u) & 0x3Fu;
    const uint32_t imms = (w >> 10u) & 0x3Fu;
    if (opc != 0u && opc != 2u) return false;
    if (N != sf) return false;
    const uint32_t width = sf ? 64u : 32u;
    if (immr >= width || imms >= width) return false;
    d->kind = (opc == 2u) ? DK_UBFM : DK_SBFM;
    d->width = static_cast<uint8_t>(width);
    d->rd = static_cast<uint8_t>(w & 31u);
    d->rn = static_cast<uint8_t>((w >> 5u) & 31u);
    d->aux = static_cast<uint8_t>(immr);
    d->aux2 = static_cast<uint8_t>(imms);
    return true;
  }

  // MOVN / MOVZ / MOVK
  if ((w & 0x1F800000u) == 0x12800000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t opc = (w >> 29u) & 3u;
    const uint32_t hw = (w >> 21u) & 3u;
    if (opc == 1u) return false;
    if (!sf && hw >= 2u) return false;
    d->kind = (opc == 0u) ? DK_MOVN : (opc == 2u ? DK_MOVZ : DK_MOVK);
    d->width = sf ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->aux = static_cast<uint8_t>(hw);
    d->imm_u = static_cast<uint64_t>((w >> 5u) & 0xFFFFu);
    return true;
  }

  // Conditional select: CSEL / CSINC / CSINV / CSNEG (includes CSET / CSETM / CNEG)
  if ((w & 0x1FE00800u) == 0x1A800000u) {
    const uint32_t sf = (w >> 31u) & 1u;
    const uint32_t op = (w >> 30u) & 1u;
    const uint32_t S = (w >> 29u) & 1u;
    if (S != 0u) return false;
    const uint32_t o2 = (w >> 10u) & 1u;
    d->kind = DK_COND_SEL;
    d->width = sf ? 64u : 32u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->rn = static_cast<uint8_t>((w >> 5u) & 31u);
    d->rm = static_cast<uint8_t>((w >> 16u) & 31u);
    d->subop = static_cast<uint8_t>((op << 1u) | o2);  // 0=csel,1=csinc,2=csinv,3=csneg
    d->aux = static_cast<uint8_t>((w >> 12u) & 0xFu);  // cond
    return true;
  }

  // 64-bit integer STP / LDP (signed offset, pre-index, post-index)
  if ((w & 0xFE000000u) == 0xA8000000u) {
    const uint32_t mode = (w >> 23u) & 3u;  // 1=post, 2=signed, 3=pre
    if (mode == 0u) return false;
    const bool is_load = ((w >> 22u) & 1u) != 0u;
    const uint8_t rn = static_cast<uint8_t>((w >> 5u) & 31u);
    // Only stack/frame pair ops are supported
    if (rn != 31u && rn != 29u) return false;
    if (rn == 29u && mode != 2u) return false;
    const int64_t imm7 = sign_extend((w >> 15u) & 0x7Fu, 7u);
    d->kind = is_load ? DK_LDP_64 : DK_STP_64;
    d->width = 64u;
    d->rd = static_cast<uint8_t>(w & 31u);
    d->rn = rn;
    d->rm = static_cast<uint8_t>((w >> 10u) & 31u);  // rt2
    d->subop = static_cast<uint8_t>(mode == 2u ? 0u : (mode == 3u ? 1u : 2u));  // 0=signed,1=pre,2=post
    d->imm_s = imm7 * 8LL;
    return true;
  }

  // Integer immediate Load / Store (unsigned offset or unscaled LDUR/STUR)
  const bool is_uoff = (w & 0x3B000000u) == 0x39000000u;
  const bool is_unsc = (w & 0x3B200C00u) == 0x38000000u;
  if (is_uoff || is_unsc) {
    const uint32_t v = (w >> 26u) & 1u;
    if (v != 0u) return false;  // reject FP/SIMD
    const uint32_t size = (w >> 30u) & 3u;
    const uint32_t opc = (w >> 22u) & 3u;
    const uint8_t bytes = static_cast<uint8_t>(1u << size);
    int64_t disp = 0;
    if (is_uoff) {
      disp = static_cast<int64_t>(((w >> 10u) & 0xFFFu) * static_cast<uint32_t>(bytes));
    } else {
      disp = sign_extend((w >> 12u) & 0x1FFu, 9u);
    }
    const uint8_t rt = static_cast<uint8_t>(w & 31u);
    const uint8_t rn = static_cast<uint8_t>((w >> 5u) & 31u);

    if (opc == 0u) {
      // Store: only 32-bit or 64-bit scalar stores to stack (sp/x29)
      if (bytes != 4u && bytes != 8u) return false;
      if (rn != 31u && rn != 29u) return false;
      d->kind = DK_MEM_STORE;
      d->width = static_cast<uint8_t>(bytes * 8u);
      d->rd = rt;
      d->rn = rn;
      d->aux = bytes;
      d->imm_s = disp;
      return true;
    }
    if (opc == 2u && size == 3u) return false;  // PRFM
    if (opc == 3u && size >= 2u) return false;  // invalid

    const bool is_signed = (opc >= 2u);
    const uint8_t dst_width = (opc == 1u) ? ((size == 3u) ? 64u : 32u)
                                          : ((opc == 2u) ? 64u : 32u);
    d->kind = DK_MEM_LOAD;
    d->width = dst_width;
    d->rd = rt;
    d->rn = rn;
    d->aux = bytes;
    d->aux2 = static_cast<uint8_t>(is_signed ? 1u : 0u);
    d->imm_s = disp;
    return true;
  }

  return false;
}

// -----------------------------------------------------------------------------
// SSA-IR Data Structures
// -----------------------------------------------------------------------------

enum IrOp : uint8_t {
  OP_NOP = 0,
  OP_PARAM,
  OP_CALLEE_SAVED,
  OP_CONST,
  OP_COPY,
  OP_PHI,
  OP_ADD,
  OP_SUB,
  OP_MUL,
  OP_UDIV,
  OP_SDIV,
  OP_AND,
  OP_OR,
  OP_XOR,
  OP_SHL,
  OP_LSR,
  OP_ASR,
  OP_ROR,
  OP_NEG,
  OP_NOT,
  OP_SEXT,
  OP_ZEXT,
  OP_FLAG_SUB,
  OP_FLAG_ADD,
  OP_FLAG_TST,
  OP_SELECT,
  OP_LOAD,
};

enum TermOp : uint8_t {
  TERM_NONE = 0,
  TERM_BR,
  TERM_COND_FLAG,
  TERM_COND_ZERO,
  TERM_COND_BIT,
  TERM_RET,
};

struct IrInst {
  IrOp op;
  uint8_t width;      // 32 or 64
  uint8_t subop;      // arm64 cond for SELECT, load flags for LOAD
  uint8_t dead;       // 1 if eliminated
  uint32_t block;
  uint32_t slot;      // original virtual slot (for PHI / rename)
  uint32_t src0;
  uint32_t src1;
  uint32_t src2;
  uint64_t imm;
  uint64_t pc;
  uint32_t phi_off;   // into phi_args[]
  uint16_t phi_cnt;
  uint16_t use_count;
  uint8_t inlined;
  uint8_t is_signed_hint;
  int32_t var_idx;    // assigned local variable index (-1 if none)
};

struct PhiArg {
  uint32_t pred_blk;
  uint32_t val;
};

struct BlockTerm {
  TermOp op;
  uint8_t width;
  uint8_t cond;       // arm64 cond (TERM_COND_FLAG), is_nz (ZERO/BIT)
  uint8_t bit_pos;    // TERM_COND_BIT
  uint32_t val;       // flags / tested reg / ret val
  int32_t succ_true;
  int32_t succ_false;
  uint64_t pc;
};

struct StackSlot {
  int64_t off;
  uint8_t bytes;
};

// -----------------------------------------------------------------------------
// Condition evaluation & constant folding helpers
// -----------------------------------------------------------------------------

static inline uint8_t invert_arm64_cond(uint8_t cond) {
  return static_cast<uint8_t>(cond ^ 1u);
}

static bool eval_flag_cond_const(IrOp flag_op, uint8_t width, uint64_t a, uint64_t b, uint8_t cond, bool* out) {
  a = mask_width(a, width);
  b = mask_width(b, width);
  const int64_t sa = (width == 32u) ? static_cast<int64_t>(static_cast<int32_t>(static_cast<uint32_t>(a)))
                                    : static_cast<int64_t>(a);
  const int64_t sb = (width == 32u) ? static_cast<int64_t>(static_cast<int32_t>(static_cast<uint32_t>(b)))
                                    : static_cast<int64_t>(b);
  if (flag_op == OP_FLAG_SUB) {
    const uint64_t diff = mask_width(a - b, width);
    const bool neg = (width == 32u) ? ((diff & 0x80000000ULL) != 0ULL) : ((diff & (1ULL << 63u)) != 0ULL);
    switch (cond & 0xFu) {
      case 0x0u: *out = (a == b); return true;
      case 0x1u: *out = (a != b); return true;
      case 0x2u: *out = (a >= b); return true;
      case 0x3u: *out = (a < b); return true;
      case 0x4u: *out = neg; return true;
      case 0x5u: *out = !neg; return true;
      case 0x8u: *out = (a > b); return true;
      case 0x9u: *out = (a <= b); return true;
      case 0xAu: *out = (sa >= sb); return true;
      case 0xBu: *out = (sa < sb); return true;
      case 0xCu: *out = (sa > sb); return true;
      case 0xDu: *out = (sa <= sb); return true;
      case 0xEu: case 0xFu: *out = true; return true;
      default: return false;
    }
  }
  if (flag_op == OP_FLAG_ADD) {
    const uint64_t sum = mask_width(a + b, width);
    const bool neg = (width == 32u) ? ((sum & 0x80000000ULL) != 0ULL) : ((sum & (1ULL << 63u)) != 0ULL);
    const bool carry = (sum < a);
    switch (cond & 0xFu) {
      case 0x0u: *out = (sum == 0ULL); return true;
      case 0x1u: *out = (sum != 0ULL); return true;
      case 0x2u: *out = carry; return true;
      case 0x3u: *out = !carry; return true;
      case 0x4u: *out = neg; return true;
      case 0x5u: *out = !neg; return true;
      case 0xEu: case 0xFu: *out = true; return true;
      default:
        if (b == 0ULL) {
          switch (cond & 0xFu) {
            case 0xAu: *out = (sa >= 0); return true;
            case 0xBu: *out = (sa < 0); return true;
            case 0xCu: *out = (sa > 0); return true;
            case 0xDu: *out = (sa <= 0); return true;
            default: break;
          }
        }
        return false;
    }
  }
  if (flag_op == OP_FLAG_TST) {
    const uint64_t v = mask_width(a & b, width);
    const int64_t sv = (width == 32u) ? static_cast<int64_t>(static_cast<int32_t>(static_cast<uint32_t>(v)))
                                      : static_cast<int64_t>(v);
    switch (cond & 0xFu) {
      case 0x0u: *out = (v == 0ULL); return true;
      case 0x1u: *out = (v != 0ULL); return true;
      case 0x4u: case 0xBu: *out = (sv < 0); return true;
      case 0x5u: case 0xAu: *out = (sv >= 0); return true;
      case 0xCu: *out = (sv > 0); return true;
      case 0xDu: *out = (sv <= 0); return true;
      case 0xEu: case 0xFu: *out = true; return true;
      default: return false;
    }
  }
  return false;
}

static bool is_flag_cond_supported(IrOp flag_op, uint8_t cond, bool rhs_is_zero) {
  const uint8_t c = cond & 0xFu;
  if (c == 0xEu || c == 0xFu) return true;
  if (flag_op == OP_FLAG_SUB) {
    return (c != 0x6u && c != 0x7u);
  }
  if (flag_op == OP_FLAG_ADD) {
    if (c == 0x0u || c == 0x1u || c == 0x2u || c == 0x3u || c == 0x4u || c == 0x5u) return true;
    if (rhs_is_zero && (c == 0xAu || c == 0xBu || c == 0xCu || c == 0xDu)) return true;
    return false;
  }
  if (flag_op == OP_FLAG_TST) {
    return (c == 0x0u || c == 0x1u || c == 0x4u || c == 0x5u ||
            c == 0xAu || c == 0xBu || c == 0xCu || c == 0xDu);
  }
  return false;
}

static uint64_t fold_binop(IrOp op, uint8_t width, uint64_t a, uint64_t b) {
  a = mask_width(a, width);
  b = mask_width(b, width);
  const uint32_t sh_mask = (width == 32u) ? 31u : 63u;
  switch (op) {
    case OP_ADD: return mask_width(a + b, width);
    case OP_SUB: return mask_width(a - b, width);
    case OP_MUL: return mask_width(a * b, width);
    case OP_UDIV:
      if (b == 0ULL) return 0ULL;
      return mask_width(a / b, width);
    case OP_SDIV: {
      if (b == 0ULL) return 0ULL;
      if (width == 32u) {
        const int32_t sa = static_cast<int32_t>(static_cast<uint32_t>(a));
        const int32_t sb = static_cast<int32_t>(static_cast<uint32_t>(b));
        if (sa == (-2147483647 - 1) && sb == -1) return 0x80000000ULL;
        return static_cast<uint64_t>(static_cast<uint32_t>(sa / sb));
      } else {
        const int64_t sa = static_cast<int64_t>(a);
        const int64_t sb = static_cast<int64_t>(b);
        if (sa == (-9223372036854775807LL - 1LL) && sb == -1LL) return 0x8000000000000000ULL;
        return static_cast<uint64_t>(sa / sb);
      }
    }
    case OP_AND: return mask_width(a & b, width);
    case OP_OR:  return mask_width(a | b, width);
    case OP_XOR: return mask_width(a ^ b, width);
    case OP_SHL: return mask_width(a << (b & sh_mask), width);
    case OP_LSR: return mask_width(a >> (b & sh_mask), width);
    case OP_ASR: {
      const uint32_t sh = static_cast<uint32_t>(b & sh_mask);
      if (width == 32u) {
        const int32_t sa = static_cast<int32_t>(static_cast<uint32_t>(a));
        return static_cast<uint64_t>(static_cast<uint32_t>(sa >> sh));
      } else {
        const int64_t sa = static_cast<int64_t>(a);
        return static_cast<uint64_t>(sa >> sh);
      }
    }
    case OP_ROR: {
      const uint32_t sh = static_cast<uint32_t>(b & sh_mask);
      if (sh == 0u) return a;
      if (width == 32u) {
        const uint32_t u = static_cast<uint32_t>(a);
        return static_cast<uint64_t>((u >> sh) | (u << (32u - sh)));
      }
      return (a >> sh) | (a << (64u - sh));
    }
    default: return 0ULL;
  }
}

static uint64_t fold_unop(IrOp op, uint8_t width, uint64_t a, uint64_t imm) {
  a = mask_width(a, width);
  switch (op) {
    case OP_NEG: return mask_width(0ULL - a, width);
    case OP_NOT: return mask_width(~a, width);
    case OP_SEXT: {
      int64_t sv = 0;
      if (imm == 8ULL) sv = static_cast<int64_t>(static_cast<int8_t>(a & 0xFFULL));
      else if (imm == 16ULL) sv = static_cast<int64_t>(static_cast<int16_t>(a & 0xFFFFULL));
      else sv = static_cast<int64_t>(static_cast<int32_t>(a & 0xFFFFFFFFULL));
      return mask_width(static_cast<uint64_t>(sv), width);
    }
    case OP_ZEXT: {
      if (imm == 8ULL) return a & 0xFFULL;
      if (imm == 16ULL) return a & 0xFFFFULL;
      return a & 0xFFFFFFFFULL;
    }
    default: return a;
  }
}

// -----------------------------------------------------------------------------
// Text Writer & Formatting Helpers
// -----------------------------------------------------------------------------

static inline bool is_ascii_alpha(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}
static inline bool is_ascii_digit(char c) {
  return c >= '0' && c <= '9';
}
static inline bool is_ident_char(char c) {
  return is_ascii_alpha(c) || is_ascii_digit(c) || c == '_';
}

struct TextWriter {
  char* buf;
  uint32_t cap;
  uint32_t len;
  uint32_t cur_line;
  bool overflow;
  HexLineMapEntry* lm;
  uint32_t lm_cap;
  uint32_t lm_count;

  void putc(char c) {
    if (overflow) return;
    if (len + 1u >= cap) {
      overflow = true;
      return;
    }
    buf[len++] = c;
    buf[len] = '\0';
    if (c == '\n') cur_line++;
  }

  void puts(const char* s) {
    if (!s || overflow) return;
    while (*s != '\0') {
      putc(*s++);
      if (overflow) return;
    }
  }

  void put_bytes(const char* s, uint32_t n) {
    if (overflow) return;
    for (uint32_t i = 0u; i < n; ++i) {
      putc(s[i]);
      if (overflow) return;
    }
  }

  void put_indent(uint32_t n) {
    for (uint32_t i = 0u; i < n; ++i) {
      puts("    ");
    }
  }

  void put_u64_dec(uint64_t val) {
    char tmp[24];
    uint32_t n = 0u;
    do {
      tmp[n++] = static_cast<char>('0' + (val % 10ULL));
      val /= 10ULL;
    } while (val != 0ULL);
    while (n > 0u) putc(tmp[--n]);
  }

  void put_i64_dec(int64_t val) {
    if (val < 0) {
      putc('-');
      const uint64_t mag = static_cast<uint64_t>(-(val + 1LL)) + 1ULL;
      put_u64_dec(mag);
    } else {
      put_u64_dec(static_cast<uint64_t>(val));
    }
  }

  void put_u64_hex(uint64_t val, bool upper) {
    const char* kHex = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    char tmp[16];
    uint32_t n = 0u;
    do {
      tmp[n++] = kHex[val & 0xFULL];
      val >>= 4u;
    } while (val != 0ULL);
    while (n > 0u) putc(tmp[--n]);
  }

  void put_const(uint64_t val, uint8_t width) {
    val = mask_width(val, width);
    if (width == 32u) {
      if (val <= 999ULL) {
        put_u64_dec(val);
        if (val > 0x7FFFFFFFULL) putc('u');
      } else {
        puts("0x");
        put_u64_hex(val, true);
        putc('u');
      }
    } else {
      if (val <= 999ULL) {
        put_u64_dec(val);
      } else {
        puts("0x");
        put_u64_hex(val, true);
        puts("ULL");
      }
    }
  }

  void mark_line(uint32_t block_id, uint64_t addr) {
    if (!lm || lm_count >= lm_cap || addr == 0ULL) return;
    if (lm_count > 0u && lm[lm_count - 1u].line_no == cur_line && lm[lm_count - 1u].addr == addr) {
      return;
    }
    lm[lm_count++] = HexLineMapEntry{cur_line, block_id, addr};
  }
};

static bool normalize_func_name(const char* raw, uint32_t raw_len, uint64_t base_addr,
                                char* out, uint32_t cap, uint32_t* out_len) {
  if (!raw || raw_len == 0u) {
    TextWriter w{out, cap, 0u, 1u, false, nullptr, 0u, 0u};
    w.puts("sub_");
    w.put_u64_hex(base_addr, false);
    if (w.overflow) return false;
    *out_len = w.len;
    return true;
  }
  if (raw_len >= 2u && (raw[0] == '-' || raw[0] == '+') && raw[1] == '[') return false;
  uint32_t start = 0u;
  while (start < raw_len && raw[start] == '_') ++start;
  const uint32_t rem = raw_len - start;
  if (rem == 0u || rem > kMaxNormNameLen || rem + 1u > cap) return false;
  for (uint32_t i = 0u; i < rem; ++i) {
    out[i] = is_ident_char(raw[start + i]) ? raw[start + i] : '_';
  }
  out[rem] = '\0';
  if (is_ascii_digit(out[0])) return false;
  *out_len = rem;
  return true;
}

// -----------------------------------------------------------------------------
// Pipeline Context (all buffers live on scratch arena)
// -----------------------------------------------------------------------------

struct PipelineCtx {
  hex::Arena& scratch;
  uint32_t word_count;
  uint64_t base_addr;
  DecInsn* dec;

  // CFG
  uint32_t num_blocks;
  uint32_t* blk_start;
  uint32_t* blk_end;
  uint64_t* blk_addr;
  uint32_t* insn_to_blk;
  uint32_t* succ_off;
  int32_t* succ_dst;
  uint32_t* pred_off;
  int32_t* pred_src;
  HexCfgResult cfg;
  HexLoopResult loops;

  // Stack slots
  StackSlot stack_slots[kMaxStackSlots];
  uint32_t num_stack_slots;
  int64_t* blk_sp_in;
  int64_t* blk_fp_in;
  uint8_t* blk_fp_valid_in;
  uint8_t* blk_sp_visited;

  // SSA IR
  IrInst* insts;
  uint32_t num_insts;
  PhiArg* phi_args;
  uint32_t num_phi_args;
  BlockTerm* terms;

  // Per-block instruction lists (indices into insts[])
  uint32_t* blk_ir_off;
  uint32_t* blk_ir_cnt;
  uint32_t* blk_ir_ids;
  uint32_t total_blk_ir;

  // Dominator tree children
  uint32_t* dom_child_off;
  uint32_t* dom_child_dst;

  // Emission state
  uint8_t used_types;  // bit0=u64, bit1=u32, bit2=i32, bit3=i64, bit4=u8, bit5=u16, bit6=i8, bit7=i16
  uint8_t* blk_emitted;
  bool struct_failed;
  uint32_t max_param_count;
  uint8_t ret_width;
  bool has_ret_val;
  uint32_t num_locals;

  uint32_t add_inst(const IrInst& ins) {
    if (num_insts >= kMaxInsts) return kNoVal;
    const uint32_t id = num_insts++;
    insts[id] = ins;
    return id;
  }

  int32_t find_or_add_stack_slot(int64_t off, uint8_t bytes) {
    for (uint32_t i = 0u; i < num_stack_slots; ++i) {
      if (stack_slots[i].off == off && stack_slots[i].bytes == bytes) {
        return static_cast<int32_t>(i);
      }
    }
    if (num_stack_slots >= kMaxStackSlots) return -1;
    const uint32_t idx = num_stack_slots++;
    stack_slots[idx] = StackSlot{off, bytes};
    return static_cast<int32_t>(idx);
  }

  bool dominates(int32_t d, int32_t n) const {
    if (d < 0 || n < 0) return false;
    const uint32_t ud = static_cast<uint32_t>(d);
    const uint32_t un = static_cast<uint32_t>(n);
    if (ud >= num_blocks || un >= num_blocks) return false;
    if (!cfg.reachable_mask[ud] || !cfg.reachable_mask[un]) return false;
    const int32_t tin_d = cfg.dom_tin[ud];
    return tin_d >= 0 && tin_d <= cfg.dom_tin[un] && cfg.dom_tout[un] <= cfg.dom_tout[ud];
  }

  bool is_in_loop(int32_t blk, int32_t loop_idx) const {
    if (blk < 0 || loop_idx < 0) return false;
    const uint32_t ul = static_cast<uint32_t>(loop_idx);
    if (ul >= loops.num_loops) return false;
    const uint32_t beg = loops.loop_node_off[ul];
    const uint32_t end = loops.loop_node_off[ul + 1u];
    for (uint32_t i = beg; i < end; ++i) {
      if (loops.loop_body_nodes[i] == blk) return true;
    }
    return false;
  }

  int32_t find_single_loop_exit(int32_t loop_idx) const {
    if (loop_idx < 0 || static_cast<uint32_t>(loop_idx) >= loops.num_loops) return -1;
    const uint32_t ul = static_cast<uint32_t>(loop_idx);
    int32_t exit_target = -1;
    const uint32_t beg = loops.loop_node_off[ul];
    const uint32_t end = loops.loop_node_off[ul + 1u];
    for (uint32_t i = beg; i < end; ++i) {
      const uint32_t b = static_cast<uint32_t>(loops.loop_body_nodes[i]);
      for (uint32_t e = succ_off[b]; e < succ_off[b + 1u]; ++e) {
        const int32_t dst = succ_dst[e];
        if (!is_in_loop(dst, loop_idx)) {
          if (exit_target < 0) exit_target = dst;
          else if (exit_target != dst) return -1;
        }
      }
    }
    return exit_target;
  }
};

// -----------------------------------------------------------------------------
// Stage 2: Irreducibility check (3-color DFS on non-back-edge graph)
// -----------------------------------------------------------------------------

static bool is_cfg_reducible(const PipelineCtx& ctx) {
  hex::ArenaScope sc(ctx.scratch);
  uint8_t* color = hex::arena_alloc_zeroed<uint8_t>(ctx.scratch, ctx.num_blocks);
  int32_t* stack_node = ctx.scratch.alloc<int32_t>(ctx.num_blocks + 1u);
  uint32_t* stack_edge = ctx.scratch.alloc<uint32_t>(ctx.num_blocks + 1u);
  if (!color || !stack_node || !stack_edge) return false;

  uint32_t sp = 0u;
  color[0] = 1u;
  stack_node[sp] = 0;
  stack_edge[sp] = ctx.succ_off[0];
  ++sp;

  while (sp > 0u) {
    const int32_t u = stack_node[sp - 1u];
    uint32_t& e = stack_edge[sp - 1u];
    const uint32_t end = ctx.succ_off[static_cast<uint32_t>(u) + 1u];
    if (e >= end) {
      color[static_cast<uint32_t>(u)] = 2u;
      --sp;
      continue;
    }
    const int32_t v = ctx.succ_dst[e++];
    if (v < 0 || static_cast<uint32_t>(v) >= ctx.num_blocks) continue;
    // Skip dominating back-edges
    if (ctx.dominates(v, u)) continue;
    const uint8_t cv = color[static_cast<uint32_t>(v)];
    if (cv == 1u) {
      // Cycle without a dominating header => irreducible CFG!
      return false;
    }
    if (cv == 0u) {
      color[static_cast<uint32_t>(v)] = 1u;
      stack_node[sp] = v;
      stack_edge[sp] = ctx.succ_off[static_cast<uint32_t>(v)];
      ++sp;
    }
  }
  return true;
}

// -----------------------------------------------------------------------------
// Stack frame analysis & stack slot discovery
// -----------------------------------------------------------------------------

static bool analyze_stack_frame(PipelineCtx& ctx) {
  ctx.blk_sp_in = hex::arena_alloc_zeroed<int64_t>(ctx.scratch, ctx.num_blocks);
  ctx.blk_fp_in = hex::arena_alloc_zeroed<int64_t>(ctx.scratch, ctx.num_blocks);
  ctx.blk_fp_valid_in = hex::arena_alloc_zeroed<uint8_t>(ctx.scratch, ctx.num_blocks);
  ctx.blk_sp_visited = hex::arena_alloc_zeroed<uint8_t>(ctx.scratch, ctx.num_blocks);
  int32_t* q = ctx.scratch.alloc<int32_t>(ctx.num_blocks * 4u + 4u);
  if (!ctx.blk_sp_in || !ctx.blk_fp_in || !ctx.blk_fp_valid_in || !ctx.blk_sp_visited || !q) {
    return false;
  }

  uint32_t qh = 0u, qt = 0u;
  ctx.blk_sp_visited[0] = 1u;
  ctx.blk_sp_in[0] = 0;
  ctx.blk_fp_in[0] = 0;
  ctx.blk_fp_valid_in[0] = 0u;
  q[qt++] = 0;

  while (qh < qt) {
    const uint32_t b = static_cast<uint32_t>(q[qh++]);
    int64_t sp = ctx.blk_sp_in[b];
    int64_t fp = ctx.blk_fp_in[b];
    bool fp_valid = (ctx.blk_fp_valid_in[b] != 0u);

    for (uint32_t i = ctx.blk_start[b]; i < ctx.blk_end[b]; ++i) {
      const DecInsn& d = ctx.dec[i];
      switch (d.kind) {
        case DK_SP_ADD_IMM:
          sp += d.imm_s;
          break;
        case DK_FP_FROM_SP:
          fp_valid = true;
          fp = sp + d.imm_s;
          break;
        case DK_SP_FROM_FP:
          if (!fp_valid) return false;
          sp = fp + d.imm_s;
          break;
        case DK_STP_64:
        case DK_LDP_64: {
          int64_t base = 0;
          if (d.rn == 31u) {
            if (d.subop == 1u) sp += d.imm_s;  // pre-index
            base = (d.subop == 0u) ? (sp + d.imm_s) : sp;
            if (d.subop == 2u) sp += d.imm_s;  // post-index
          } else {
            if (!fp_valid) return false;
            base = fp + d.imm_s;
          }
          if (ctx.find_or_add_stack_slot(base, 8u) < 0) return false;
          if (ctx.find_or_add_stack_slot(base + 8LL, 8u) < 0) return false;
          if (d.kind == DK_LDP_64 && (d.rd == 29u || d.rm == 29u)) {
            fp_valid = false;
          }
          break;
        }
        case DK_MEM_STORE: {
          int64_t base = 0;
          if (d.rn == 31u) {
            base = sp + d.imm_s;
          } else if (d.rn == 29u && fp_valid) {
            base = fp + d.imm_s;
          } else {
            return false;
          }
          if (ctx.find_or_add_stack_slot(base, d.aux) < 0) return false;
          break;
        }
        case DK_MEM_LOAD: {
          if (d.rn == 31u || (d.rn == 29u && fp_valid)) {
            if (d.aux != 4u && d.aux != 8u) return false;
            const int64_t base = (d.rn == 31u ? sp : fp) + d.imm_s;
            if (ctx.find_or_add_stack_slot(base, d.aux) < 0) return false;
          }
          if (d.rd == 29u) fp_valid = false;
          break;
        }
        case DK_RET:
          if (sp != 0) return false;
          break;
        default:
          // Any non-FP-setup write to x29 invalidates fp_valid
          if (d.rd == 29u && d.kind != DK_NOP && d.kind != DK_B && d.kind != DK_B_COND &&
              d.kind != DK_CBZ && d.kind != DK_CBNZ && d.kind != DK_TBZ && d.kind != DK_TBNZ) {
            fp_valid = false;
          }
          break;
      }
    }

    for (uint32_t e = ctx.succ_off[b]; e < ctx.succ_off[b + 1u]; ++e) {
      const uint32_t s = static_cast<uint32_t>(ctx.succ_dst[e]);
      if (!ctx.blk_sp_visited[s]) {
        ctx.blk_sp_visited[s] = 1u;
        ctx.blk_sp_in[s] = sp;
        ctx.blk_fp_in[s] = fp;
        ctx.blk_fp_valid_in[s] = static_cast<uint8_t>(fp_valid ? 1u : 0u);
        if (qt >= ctx.num_blocks * 4u + 4u) return false;
        q[qt++] = static_cast<int32_t>(s);
      } else {
        if (ctx.blk_sp_in[s] != sp) return false;
        if (ctx.blk_fp_valid_in[s] && (!fp_valid || ctx.blk_fp_in[s] != fp)) {
          ctx.blk_fp_valid_in[s] = 0u;
          if (qt >= ctx.num_blocks * 4u + 4u) return false;
          q[qt++] = static_cast<int32_t>(s);
        }
      }
    }
  }

  // Verify no partially overlapping stack slots (guarantees sound scalar promotion)
  for (uint32_t i = 0u; i < ctx.num_stack_slots; ++i) {
    const int64_t a0 = ctx.stack_slots[i].off;
    const int64_t a1 = a0 + static_cast<int64_t>(ctx.stack_slots[i].bytes);
    for (uint32_t j = i + 1u; j < ctx.num_stack_slots; ++j) {
      const int64_t b0 = ctx.stack_slots[j].off;
      const int64_t b1 = b0 + static_cast<int64_t>(ctx.stack_slots[j].bytes);
      if (a0 < b1 && b0 < a1) return false;
    }
  }
  return true;
}

// -----------------------------------------------------------------------------
// Stage 3: Lift blocks + Cytron SSA construction
// -----------------------------------------------------------------------------

static bool build_ssa(PipelineCtx& ctx) {
  const uint32_t nb = ctx.num_blocks;
  const uint32_t nslots = kSlotStackBase + ctx.num_stack_slots;

  ctx.insts = ctx.scratch.alloc<IrInst>(kMaxInsts);
  ctx.phi_args = ctx.scratch.alloc<PhiArg>(kMaxPhiArgs);
  ctx.terms = hex::arena_alloc_zeroed<BlockTerm>(ctx.scratch, nb);
  ctx.num_insts = 0u;
  ctx.num_phi_args = 0u;
  if (!ctx.insts || !ctx.phi_args || !ctx.terms) return false;

  // Build dominator tree children CSR from cfg.idom
  ctx.dom_child_off = hex::arena_alloc_zeroed<uint32_t>(ctx.scratch, nb + 1u);
  ctx.dom_child_dst = ctx.scratch.alloc<uint32_t>(nb + 1u);
  if (!ctx.dom_child_off || !ctx.dom_child_dst) return false;
  for (uint32_t b = 1u; b < nb; ++b) {
    if (!ctx.cfg.reachable_mask[b]) continue;
    const int32_t p = ctx.cfg.idom[b];
    if (p >= 0 && static_cast<uint32_t>(p) < nb) {
      ctx.dom_child_off[static_cast<uint32_t>(p) + 1u]++;
    }
  }
  for (uint32_t b = 0u; b < nb; ++b) ctx.dom_child_off[b + 1u] += ctx.dom_child_off[b];
  {
    hex::ArenaScope sc(ctx.scratch);
    uint32_t* cur = ctx.scratch.alloc<uint32_t>(nb);
    if (!cur) return false;
    for (uint32_t b = 0u; b < nb; ++b) cur[b] = ctx.dom_child_off[b];
    for (uint32_t b = 1u; b < nb; ++b) {
      if (!ctx.cfg.reachable_mask[b]) continue;
      const int32_t p = ctx.cfg.idom[b];
      if (p >= 0 && static_cast<uint32_t>(p) < nb) {
        ctx.dom_child_dst[cur[static_cast<uint32_t>(p)]++] = b;
      }
    }
  }

  // Compute Dominator Frontier per block (bitmatrix: nb x nb_words)
  const uint32_t blk_words = (nb + 31u) / 32u;
  uint32_t* df_bits = hex::arena_alloc_zeroed<uint32_t>(ctx.scratch, static_cast<size_t>(nb) * blk_words);
  // Track which slots are defined in each block (bitmatrix: nslots x blk_words)
  uint32_t* def_blocks = hex::arena_alloc_zeroed<uint32_t>(ctx.scratch, static_cast<size_t>(nslots) * blk_words);
  if (!df_bits || !def_blocks) return false;

  for (uint32_t b = 0u; b < nb; ++b) {
    if (!ctx.cfg.reachable_mask[b]) continue;
    const uint32_t pb = ctx.pred_off[b];
    const uint32_t pe = ctx.pred_off[b + 1u];
    if (pe - pb < 2u) continue;
    const int32_t ib = ctx.cfg.idom[b];
    for (uint32_t e = pb; e < pe; ++e) {
      int32_t runner = ctx.pred_src[e];
      while (runner >= 0 && runner != ib) {
        if (!ctx.cfg.reachable_mask[static_cast<uint32_t>(runner)]) break;
        df_bits[static_cast<size_t>(runner) * blk_words + (b >> 5u)] |= (1u << (b & 31u));
        const int32_t next_r = ctx.cfg.idom[static_cast<uint32_t>(runner)];
        if (next_r == runner) break;
        runner = next_r;
      }
    }
  }

  // Quick scan of each reachable block to record slot definitions for PHI placement
  for (uint32_t b = 0u; b < nb; ++b) {
    if (!ctx.cfg.reachable_mask[b]) continue;
    int64_t sp = ctx.blk_sp_in[b];
    int64_t fp = ctx.blk_fp_in[b];
    auto mark_def = [&](uint32_t slot) {
      if (slot < nslots) {
        def_blocks[static_cast<size_t>(slot) * blk_words + (b >> 5u)] |= (1u << (b & 31u));
      }
    };
    for (uint32_t i = ctx.blk_start[b]; i < ctx.blk_end[b]; ++i) {
      const DecInsn& d = ctx.dec[i];
      switch (d.kind) {
        case DK_SP_ADD_IMM: sp += d.imm_s; break;
        case DK_FP_FROM_SP: fp = sp + d.imm_s; break;
        case DK_SP_FROM_FP: sp = fp + d.imm_s; break;
        case DK_ADD_IMM: case DK_SUB_IMM: case DK_ADD_REG: case DK_SUB_REG:
        case DK_LOGIC_IMM: case DK_LOGIC_REG:
          if (d.rd < 31u) mark_def(d.rd);
          if ((d.flags & 1u) != 0u) mark_def(kSlotFlags);
          break;
        case DK_MADD: case DK_MSUB: case DK_UDIV: case DK_SDIV:
        case DK_SHIFTV: case DK_UBFM: case DK_SBFM:
        case DK_MOVZ: case DK_MOVN: case DK_MOVK: case DK_COND_SEL:
          if (d.rd < 31u) mark_def(d.rd);
          break;
        case DK_STP_64: {
          int64_t base = 0;
          if (d.rn == 31u) {
            if (d.subop == 1u) sp += d.imm_s;
            base = (d.subop == 0u) ? (sp + d.imm_s) : sp;
            if (d.subop == 2u) sp += d.imm_s;
          } else {
            base = fp + d.imm_s;
          }
          const int32_t s0 = ctx.find_or_add_stack_slot(base, 8u);
          const int32_t s1 = ctx.find_or_add_stack_slot(base + 8LL, 8u);
          if (s0 >= 0) mark_def(kSlotStackBase + static_cast<uint32_t>(s0));
          if (s1 >= 0) mark_def(kSlotStackBase + static_cast<uint32_t>(s1));
          break;
        }
        case DK_LDP_64: {
          if (d.rn == 31u) {
            if (d.subop == 1u) sp += d.imm_s;
            if (d.subop == 2u) sp += d.imm_s;
          }
          if (d.rd < 31u) mark_def(d.rd);
          if (d.rm < 31u) mark_def(d.rm);
          break;
        }
        case DK_MEM_STORE: {
          const int64_t base = (d.rn == 31u ? sp : fp) + d.imm_s;
          const int32_t s0 = ctx.find_or_add_stack_slot(base, d.aux);
          if (s0 >= 0) mark_def(kSlotStackBase + static_cast<uint32_t>(s0));
          break;
        }
        case DK_MEM_LOAD:
          if (d.rd < 31u) mark_def(d.rd);
          break;
        default: break;
      }
    }
  }

  // Place PHI nodes using iterated Dominator Frontier
  // phi_id_map[b * nslots + slot] = inst_id or kNoVal
  uint32_t* phi_id_map = ctx.scratch.alloc<uint32_t>(static_cast<size_t>(nb) * nslots);
  if (!phi_id_map) return false;
  for (size_t i = 0u; i < static_cast<size_t>(nb) * nslots; ++i) phi_id_map[i] = kNoVal;

  {
    hex::ArenaScope sc(ctx.scratch);
    uint32_t* work = ctx.scratch.alloc<uint32_t>(nb + 1u);
    uint8_t* in_work = ctx.scratch.alloc<uint8_t>(nb);
    uint8_t* has_phi = ctx.scratch.alloc<uint8_t>(nb);
    if (!work || !in_work || !has_phi) return false;

    for (uint32_t s = 0u; s < nslots; ++s) {
      hex::mem_set(in_work, 0, nb);
      hex::mem_set(has_phi, 0, nb);
      uint32_t wt = 0u;
      for (uint32_t b = 0u; b < nb; ++b) {
        if ((def_blocks[static_cast<size_t>(s) * blk_words + (b >> 5u)] & (1u << (b & 31u))) != 0u) {
          work[wt++] = b;
          in_work[b] = 1u;
        }
      }
      uint32_t wh = 0u;
      while (wh < wt) {
        const uint32_t x = work[wh++];
        for (uint32_t y = 0u; y < nb; ++y) {
          if ((df_bits[static_cast<size_t>(x) * blk_words + (y >> 5u)] & (1u << (y & 31u))) == 0u) continue;
          if (!has_phi[y]) {
            has_phi[y] = 1u;
            const uint32_t pcnt = ctx.pred_off[y + 1u] - ctx.pred_off[y];
            if (ctx.num_phi_args + pcnt > kMaxPhiArgs) return false;
            IrInst phi{};
            phi.op = OP_PHI;
            phi.width = 64u;
            phi.block = y;
            phi.slot = s;
            phi.src0 = kNoVal;
            phi.src1 = kNoVal;
            phi.src2 = kNoVal;
            phi.pc = ctx.blk_addr[y];
            phi.phi_off = ctx.num_phi_args;
            phi.phi_cnt = static_cast<uint16_t>(pcnt);
            phi.var_idx = -1;
            for (uint32_t k = 0u; k < pcnt; ++k) {
              ctx.phi_args[ctx.num_phi_args++] = PhiArg{static_cast<uint32_t>(ctx.pred_src[ctx.pred_off[y] + k]), kNoVal};
            }
            const uint32_t pid = ctx.add_inst(phi);
            if (pid == kNoVal) return false;
            phi_id_map[static_cast<size_t>(y) * nslots + s] = pid;
            if (!in_work[y]) {
              in_work[y] = 1u;
              work[wt++] = y;
            }
          }
        }
      }
    }
  }

  // Create entry parameter and callee-saved definitions in block 0
  uint32_t cur_val[kMaxSlots];
  for (uint32_t s = 0u; s < kMaxSlots; ++s) cur_val[s] = kNoVal;
  for (uint32_t r = 0u; r < 8u; ++r) {
    IrInst p{};
    p.op = OP_PARAM;
    p.width = 64u;
    p.block = 0u;
    p.slot = r;
    p.src0 = kNoVal;
    p.src1 = kNoVal;
    p.src2 = kNoVal;
    p.imm = r;
    p.pc = ctx.base_addr;
    p.var_idx = -1;
    const uint32_t id = ctx.add_inst(p);
    if (id == kNoVal) return false;
    cur_val[r] = id;
  }
  for (uint32_t r = 19u; r <= 30u; ++r) {
    IrInst cs{};
    cs.op = OP_CALLEE_SAVED;
    cs.width = 64u;
    cs.block = 0u;
    cs.slot = r;
    cs.src0 = kNoVal;
    cs.src1 = kNoVal;
    cs.src2 = kNoVal;
    cs.imm = r;
    cs.pc = ctx.base_addr;
    cs.var_idx = -1;
    const uint32_t id = ctx.add_inst(cs);
    if (id == kNoVal) return false;
    cur_val[r] = id;
  }

  // Allocate per-block IR list staging (record block_id on each IrInst, then compact)
  // Walk dominator tree iteratively using explicit stack so we never overflow WASM stack!
  struct DomFrame {
    uint32_t blk;
    uint32_t child_idx;
    uint32_t saved_val[kMaxSlots];
    bool entered;
  };
  DomFrame* dstack = ctx.scratch.alloc<DomFrame>(nb + 1u);
  if (!dstack) return false;

  auto make_const = [&](uint32_t blk, uint8_t width, uint64_t val, uint64_t pc) -> uint32_t {
    IrInst c{};
    c.op = OP_CONST;
    c.width = width;
    c.block = blk;
    c.slot = 0xFFu;
    c.src0 = kNoVal;
    c.src1 = kNoVal;
    c.src2 = kNoVal;
    c.imm = mask_width(val, width);
    c.pc = pc;
    c.var_idx = -1;
    return ctx.add_inst(c);
  };

  auto read_reg = [&](uint32_t blk, uint8_t r, uint8_t width, uint64_t pc) -> uint32_t {
    if (r == 31u) return make_const(blk, width, 0ULL, pc);
    return cur_val[r];
  };

  auto emit_bin = [&](uint32_t blk, IrOp op, uint8_t width, uint32_t s0, uint32_t s1, uint64_t pc) -> uint32_t {
    if (s0 == kNoVal || s1 == kNoVal) return kNoVal;
    IrInst ins{};
    ins.op = op;
    ins.width = width;
    ins.block = blk;
    ins.slot = 0xFFu;
    ins.src0 = s0;
    ins.src1 = s1;
    ins.src2 = kNoVal;
    ins.pc = pc;
    ins.var_idx = -1;
    return ctx.add_inst(ins);
  };

  auto emit_un = [&](uint32_t blk, IrOp op, uint8_t width, uint32_t s0, uint64_t imm, uint64_t pc) -> uint32_t {
    if (s0 == kNoVal) return kNoVal;
    IrInst ins{};
    ins.op = op;
    ins.width = width;
    ins.block = blk;
    ins.slot = 0xFFu;
    ins.src0 = s0;
    ins.src1 = kNoVal;
    ins.src2 = kNoVal;
    ins.imm = imm;
    ins.pc = pc;
    ins.var_idx = -1;
    return ctx.add_inst(ins);
  };

  auto emit_shifted = [&](uint32_t blk, uint8_t rm, uint8_t width, uint8_t shift, uint8_t amt, uint64_t pc) -> uint32_t {
    uint32_t v = read_reg(blk, rm, width, pc);
    if (v == kNoVal) return kNoVal;
    if (amt == 0u) return v;
    const uint32_t c = make_const(blk, width, amt, pc);
    if (c == kNoVal) return kNoVal;
    const IrOp sop = (shift == 0u) ? OP_SHL : (shift == 1u ? OP_LSR : (shift == 2u ? OP_ASR : OP_ROR));
    return emit_bin(blk, sop, width, v, c, pc);
  };

  bool any_x0_written = false;
  uint32_t dsp = 0u;
  dstack[dsp].blk = 0u;
  dstack[dsp].child_idx = ctx.dom_child_off[0];
  dstack[dsp].entered = false;
  ++dsp;

  while (dsp > 0u) {
    DomFrame& fr = dstack[dsp - 1u];
    const uint32_t b = fr.blk;
    if (!fr.entered) {
      fr.entered = true;
      for (uint32_t s = 0u; s < nslots; ++s) fr.saved_val[s] = cur_val[s];

      // Activate PHIs in block b
      for (uint32_t s = 0u; s < nslots; ++s) {
        const uint32_t pid = phi_id_map[static_cast<size_t>(b) * nslots + s];
        if (pid != kNoVal) {
          cur_val[s] = pid;
        }
      }

      // Lift all instructions in block b
      int64_t sp = ctx.blk_sp_in[b];
      int64_t fp = ctx.blk_fp_in[b];
      bool fp_valid = (ctx.blk_fp_valid_in[b] != 0u);

      for (uint32_t i = ctx.blk_start[b]; i < ctx.blk_end[b]; ++i) {
        const DecInsn& d = ctx.dec[i];
        switch (d.kind) {
          case DK_NOP:
            break;
          case DK_SP_ADD_IMM:
            sp += d.imm_s;
            break;
          case DK_FP_FROM_SP:
            fp_valid = true;
            fp = sp + d.imm_s;
            break;
          case DK_SP_FROM_FP:
            sp = fp + d.imm_s;
            break;
          case DK_MOVZ: {
            if (d.rd < 31u) {
              const uint64_t v = d.imm_u << (d.aux * 16u);
              const uint32_t id = make_const(b, d.width, v, d.pc);
              if (id == kNoVal) return false;
              cur_val[d.rd] = id;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_MOVN: {
            if (d.rd < 31u) {
              const uint64_t v = ~(d.imm_u << (d.aux * 16u));
              const uint32_t id = make_const(b, d.width, v, d.pc);
              if (id == kNoVal) return false;
              cur_val[d.rd] = id;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_MOVK: {
            if (d.rd < 31u) {
              const uint32_t prev = read_reg(b, d.rd, d.width, d.pc);
              if (prev == kNoVal) return false;
              const uint64_t clr_mask = mask_width(~(0xFFFFULL << (d.aux * 16u)), d.width);
              const uint64_t ins_bits = d.imm_u << (d.aux * 16u);
              const uint32_t cm = make_const(b, d.width, clr_mask, d.pc);
              const uint32_t cleared = emit_bin(b, OP_AND, d.width, prev, cm, d.pc);
              const uint32_t ib = make_const(b, d.width, ins_bits, d.pc);
              const uint32_t res = emit_bin(b, OP_OR, d.width, cleared, ib, d.pc);
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_ADD_IMM:
          case DK_SUB_IMM: {
            const uint32_t lhs = read_reg(b, d.rn, d.width, d.pc);
            const uint32_t rhs = make_const(b, d.width, d.imm_u, d.pc);
            if (lhs == kNoVal || rhs == kNoVal) return false;
            if ((d.flags & 1u) != 0u) {
              const uint32_t fl = emit_bin(b, d.kind == DK_SUB_IMM ? OP_FLAG_SUB : OP_FLAG_ADD, d.width, lhs, rhs, d.pc);
              if (fl == kNoVal) return false;
              cur_val[kSlotFlags] = fl;
            }
            if (d.rd < 31u) {
              const uint32_t res = emit_bin(b, d.kind == DK_SUB_IMM ? OP_SUB : OP_ADD, d.width, lhs, rhs, d.pc);
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_ADD_REG:
          case DK_SUB_REG: {
            const uint32_t lhs = read_reg(b, d.rn, d.width, d.pc);
            const uint32_t rhs = emit_shifted(b, d.rm, d.width, d.subop, d.aux, d.pc);
            if (lhs == kNoVal || rhs == kNoVal) return false;
            if ((d.flags & 1u) != 0u) {
              const uint32_t fl = emit_bin(b, d.kind == DK_SUB_REG ? OP_FLAG_SUB : OP_FLAG_ADD, d.width, lhs, rhs, d.pc);
              if (fl == kNoVal) return false;
              cur_val[kSlotFlags] = fl;
            }
            if (d.rd < 31u) {
              uint32_t res = kNoVal;
              if (d.kind == DK_SUB_REG && d.rn == 31u) {
                res = emit_un(b, OP_NEG, d.width, rhs, 0ULL, d.pc);
              } else {
                res = emit_bin(b, d.kind == DK_SUB_REG ? OP_SUB : OP_ADD, d.width, lhs, rhs, d.pc);
              }
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_MADD:
          case DK_MSUB: {
            if (d.rd < 31u) {
              const uint32_t vn = read_reg(b, d.rn, d.width, d.pc);
              const uint32_t vm = read_reg(b, d.rm, d.width, d.pc);
              const uint32_t prod = emit_bin(b, OP_MUL, d.width, vn, vm, d.pc);
              if (prod == kNoVal) return false;
              uint32_t res = prod;
              if (d.ra == 31u) {
                if (d.kind == DK_MSUB) {
                  res = emit_un(b, OP_NEG, d.width, prod, 0ULL, d.pc);
                }
              } else {
                const uint32_t va = read_reg(b, d.ra, d.width, d.pc);
                res = emit_bin(b, d.kind == DK_MSUB ? OP_SUB : OP_ADD, d.width, va, prod, d.pc);
              }
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_UDIV:
          case DK_SDIV: {
            if (d.rd < 31u) {
              const uint32_t vn = read_reg(b, d.rn, d.width, d.pc);
              const uint32_t vm = read_reg(b, d.rm, d.width, d.pc);
              const uint32_t res = emit_bin(b, d.kind == DK_SDIV ? OP_SDIV : OP_UDIV, d.width, vn, vm, d.pc);
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_SHIFTV: {
            if (d.rd < 31u) {
              const uint32_t vn = read_reg(b, d.rn, d.width, d.pc);
              const uint32_t vm = read_reg(b, d.rm, d.width, d.pc);
              const IrOp sop = (d.subop == 0u) ? OP_SHL : (d.subop == 1u ? OP_LSR : (d.subop == 2u ? OP_ASR : OP_ROR));
              const uint32_t res = emit_bin(b, sop, d.width, vn, vm, d.pc);
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_LOGIC_IMM: {
            const uint32_t lhs = read_reg(b, d.rn, d.width, d.pc);
            const uint32_t rhs = make_const(b, d.width, d.imm_u, d.pc);
            if (lhs == kNoVal || rhs == kNoVal) return false;
            if ((d.flags & 1u) != 0u) {
              const uint32_t fl = emit_bin(b, OP_FLAG_TST, d.width, lhs, rhs, d.pc);
              if (fl == kNoVal) return false;
              cur_val[kSlotFlags] = fl;
            }
            if (d.rd < 31u) {
              uint32_t res = kNoVal;
              if (d.subop == 1u && d.rn == 31u) {
                res = rhs;  // MOV imm alias
              } else {
                const IrOp lop = (d.subop == 1u) ? OP_OR : (d.subop == 2u ? OP_XOR : OP_AND);
                res = emit_bin(b, lop, d.width, lhs, rhs, d.pc);
              }
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_LOGIC_REG: {
            const uint8_t opc = static_cast<uint8_t>((d.subop >> 2u) & 3u);
            const uint8_t shift = static_cast<uint8_t>(d.subop & 3u);
            const bool inv = (d.flags & 2u) != 0u;
            uint32_t rhs = emit_shifted(b, d.rm, d.width, shift, d.aux, d.pc);
            if (rhs == kNoVal) return false;
            if (inv) {
              rhs = emit_un(b, OP_NOT, d.width, rhs, 0ULL, d.pc);
              if (rhs == kNoVal) return false;
            }
            const uint32_t lhs = read_reg(b, d.rn, d.width, d.pc);
            if (lhs == kNoVal) return false;
            if ((d.flags & 1u) != 0u) {
              const uint32_t fl = emit_bin(b, OP_FLAG_TST, d.width, lhs, rhs, d.pc);
              if (fl == kNoVal) return false;
              cur_val[kSlotFlags] = fl;
            }
            if (d.rd < 31u) {
              uint32_t res = kNoVal;
              if (opc == 1u && d.rn == 31u) {
                // MOV reg or MVN
                res = emit_un(b, OP_COPY, d.width, rhs, 0ULL, d.pc);
              } else {
                const IrOp lop = (opc == 1u) ? OP_OR : (opc == 2u ? OP_XOR : OP_AND);
                res = emit_bin(b, lop, d.width, lhs, rhs, d.pc);
              }
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_UBFM: {
            if (d.rd < 31u) {
              const uint32_t vn = read_reg(b, d.rn, d.width, d.pc);
              if (vn == kNoVal) return false;
              const uint32_t immr = d.aux;
              const uint32_t imms = d.aux2;
              uint32_t res = kNoVal;
              if (imms == static_cast<uint32_t>(d.width) - 1u) {
                const uint32_t sh = make_const(b, d.width, immr, d.pc);
                res = emit_bin(b, OP_LSR, d.width, vn, sh, d.pc);
              } else if (imms + 1u == immr) {
                const uint32_t sh = make_const(b, d.width, static_cast<uint32_t>(d.width) - immr, d.pc);
                res = emit_bin(b, OP_SHL, d.width, vn, sh, d.pc);
              } else if (imms >= immr) {
                const uint32_t bits = imms - immr + 1u;
                if (immr == 0u && (bits == 8u || bits == 16u)) {
                  res = emit_un(b, OP_ZEXT, d.width, vn, bits, d.pc);
                } else {
                  uint32_t cur = vn;
                  if (immr != 0u) {
                    const uint32_t sh = make_const(b, d.width, immr, d.pc);
                    cur = emit_bin(b, OP_LSR, d.width, cur, sh, d.pc);
                  }
                  const uint64_t m = (bits == 64u) ? ~0ULL : ((1ULL << bits) - 1ULL);
                  const uint32_t mc = make_const(b, d.width, m, d.pc);
                  res = emit_bin(b, OP_AND, d.width, cur, mc, d.pc);
                }
              } else {
                const uint32_t bits = imms + 1u;
                const uint64_t m = (bits == 64u) ? ~0ULL : ((1ULL << bits) - 1ULL);
                const uint32_t mc = make_const(b, d.width, m, d.pc);
                const uint32_t masked = emit_bin(b, OP_AND, d.width, vn, mc, d.pc);
                const uint32_t sh = make_const(b, d.width, static_cast<uint32_t>(d.width) - immr, d.pc);
                res = emit_bin(b, OP_SHL, d.width, masked, sh, d.pc);
              }
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_SBFM: {
            if (d.rd < 31u) {
              const uint32_t vn = read_reg(b, d.rn, d.width, d.pc);
              if (vn == kNoVal) return false;
              const uint32_t immr = d.aux;
              const uint32_t imms = d.aux2;
              uint32_t res = kNoVal;
              if (imms == static_cast<uint32_t>(d.width) - 1u) {
                const uint32_t sh = make_const(b, d.width, immr, d.pc);
                res = emit_bin(b, OP_ASR, d.width, vn, sh, d.pc);
              } else if (imms >= immr) {
                const uint32_t bits = imms - immr + 1u;
                if (immr == 0u && (bits == 8u || bits == 16u || (d.width == 64u && bits == 32u))) {
                  res = emit_un(b, OP_SEXT, d.width, vn, bits, d.pc);
                } else {
                  const uint32_t shl_amt = static_cast<uint32_t>(d.width) - 1u - imms;
                  const uint32_t asr_amt = static_cast<uint32_t>(d.width) - bits;
                  uint32_t cur = vn;
                  if (shl_amt != 0u) {
                    const uint32_t c1 = make_const(b, d.width, shl_amt, d.pc);
                    cur = emit_bin(b, OP_SHL, d.width, cur, c1, d.pc);
                  }
                  const uint32_t c2 = make_const(b, d.width, asr_amt, d.pc);
                  res = emit_bin(b, OP_ASR, d.width, cur, c2, d.pc);
                }
              } else {
                const uint32_t bits = imms + 1u;
                const uint32_t shl1 = static_cast<uint32_t>(d.width) - bits;
                const uint32_t c1 = make_const(b, d.width, shl1, d.pc);
                const uint32_t t1 = emit_bin(b, OP_SHL, d.width, vn, c1, d.pc);
                const uint32_t t2 = emit_bin(b, OP_ASR, d.width, t1, c1, d.pc);
                const uint32_t c2 = make_const(b, d.width, static_cast<uint32_t>(d.width) - immr, d.pc);
                res = emit_bin(b, OP_SHL, d.width, t2, c2, d.pc);
              }
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_COND_SEL: {
            if (d.rd < 31u) {
              const uint32_t fl = cur_val[kSlotFlags];
              if (fl == kNoVal) return false;
              const uint32_t tval = read_reg(b, d.rn, d.width, d.pc);
              uint32_t fval = read_reg(b, d.rm, d.width, d.pc);
              if (tval == kNoVal || fval == kNoVal) return false;
              if (d.subop == 1u) {
                const uint32_t one = make_const(b, d.width, 1ULL, d.pc);
                fval = emit_bin(b, OP_ADD, d.width, fval, one, d.pc);
              } else if (d.subop == 2u) {
                fval = emit_un(b, OP_NOT, d.width, fval, 0ULL, d.pc);
              } else if (d.subop == 3u) {
                fval = emit_un(b, OP_NEG, d.width, fval, 0ULL, d.pc);
              }
              if (fval == kNoVal) return false;
              IrInst sel{};
              sel.op = OP_SELECT;
              sel.width = d.width;
              sel.subop = d.aux;  // arm64 cond
              sel.block = b;
              sel.slot = 0xFFu;
              sel.src0 = fl;
              sel.src1 = tval;
              sel.src2 = fval;
              sel.pc = d.pc;
              sel.var_idx = -1;
              const uint32_t res = ctx.add_inst(sel);
              if (res == kNoVal) return false;
              cur_val[d.rd] = res;
              if (d.rd == 0u) any_x0_written = true;
            }
            break;
          }
          case DK_STP_64: {
            int64_t base = 0;
            if (d.rn == 31u) {
              if (d.subop == 1u) sp += d.imm_s;
              base = (d.subop == 0u) ? (sp + d.imm_s) : sp;
              if (d.subop == 2u) sp += d.imm_s;
            } else {
              base = fp + d.imm_s;
            }
            const int32_t s0 = ctx.find_or_add_stack_slot(base, 8u);
            const int32_t s1 = ctx.find_or_add_stack_slot(base + 8LL, 8u);
            if (s0 < 0 || s1 < 0) return false;
            const uint32_t v0 = read_reg(b, d.rd, 64u, d.pc);
            const uint32_t v1 = read_reg(b, d.rm, 64u, d.pc);
            if (v0 == kNoVal || v1 == kNoVal) return false;
            cur_val[kSlotStackBase + static_cast<uint32_t>(s0)] = v0;
            cur_val[kSlotStackBase + static_cast<uint32_t>(s1)] = v1;
            break;
          }
          case DK_LDP_64: {
            int64_t base = 0;
            if (d.rn == 31u) {
              if (d.subop == 1u) sp += d.imm_s;
              base = (d.subop == 0u) ? (sp + d.imm_s) : sp;
              if (d.subop == 2u) sp += d.imm_s;
            } else {
              base = fp + d.imm_s;
            }
            const int32_t s0 = ctx.find_or_add_stack_slot(base, 8u);
            const int32_t s1 = ctx.find_or_add_stack_slot(base + 8LL, 8u);
            if (s0 < 0 || s1 < 0) return false;
            const uint32_t v0 = cur_val[kSlotStackBase + static_cast<uint32_t>(s0)];
            const uint32_t v1 = cur_val[kSlotStackBase + static_cast<uint32_t>(s1)];
            if (d.rd < 31u) {
              cur_val[d.rd] = v0;
              if (d.rd == 0u) any_x0_written = true;
            }
            if (d.rm < 31u) {
              cur_val[d.rm] = v1;
              if (d.rm == 0u) any_x0_written = true;
            }
            if (d.rd == 29u || d.rm == 29u) fp_valid = false;
            break;
          }
          case DK_MEM_STORE: {
            const int64_t base = (d.rn == 31u ? sp : fp) + d.imm_s;
            const int32_t s0 = ctx.find_or_add_stack_slot(base, d.aux);
            if (s0 < 0) return false;
            const uint32_t v0 = read_reg(b, d.rd, d.width, d.pc);
            if (v0 == kNoVal) return false;
            const uint32_t stored = (d.width == 32u) ? emit_un(b, OP_COPY, 32u, v0, 0ULL, d.pc) : v0;
            if (stored == kNoVal) return false;
            cur_val[kSlotStackBase + static_cast<uint32_t>(s0)] = stored;
            break;
          }
          case DK_MEM_LOAD: {
            if (d.rn == 31u || (d.rn == 29u && fp_valid)) {
              const int64_t base = (d.rn == 31u ? sp : fp) + d.imm_s;
              const int32_t s0 = ctx.find_or_add_stack_slot(base, d.aux);
              if (s0 < 0) return false;
              uint32_t val = cur_val[kSlotStackBase + static_cast<uint32_t>(s0)];
              if (val == kNoVal) return false;
              if (d.aux2 != 0u && d.aux == 4u && d.width == 64u) {
                val = emit_un(b, OP_SEXT, 64u, val, 32ULL, d.pc);
              } else if (d.width == 32u) {
                val = emit_un(b, OP_COPY, 32u, val, 0ULL, d.pc);
              }
              if (d.rd < 31u) {
                cur_val[d.rd] = val;
                if (d.rd == 0u) any_x0_written = true;
              }
            } else {
              // Pure read-only pointer load [xN + disp]
              if (d.rd < 31u) {
                const uint32_t ptr = read_reg(b, d.rn, 64u, d.pc);
                if (ptr == kNoVal) return false;
                uint8_t log2b = 0u;
                if (d.aux == 2u) log2b = 1u;
                else if (d.aux == 4u) log2b = 2u;
                else if (d.aux == 8u) log2b = 3u;
                IrInst ld{};
                ld.op = OP_LOAD;
                ld.width = d.width;
                ld.subop = static_cast<uint8_t>((log2b << 1u) | (d.aux2 ? 1u : 0u));
                ld.block = b;
                ld.slot = 0xFFu;
                ld.src0 = ptr;
                ld.src1 = kNoVal;
                ld.src2 = kNoVal;
                ld.imm = static_cast<uint64_t>(d.imm_s);
                ld.pc = d.pc;
                ld.var_idx = -1;
                const uint32_t res = ctx.add_inst(ld);
                if (res == kNoVal) return false;
                cur_val[d.rd] = res;
                if (d.rd == 0u) any_x0_written = true;
              }
            }
            if (d.rd == 29u) fp_valid = false;
            break;
          }
          case DK_B:
          case DK_B_COND:
          case DK_CBZ:
          case DK_CBNZ:
          case DK_TBZ:
          case DK_TBNZ:
          case DK_RET:
            break;
          default:
            return false;
        }
      }

      // Build block terminator
      const DecInsn& last = ctx.dec[ctx.blk_end[b] - 1u];
      BlockTerm& tm = ctx.terms[b];
      tm.pc = last.pc;
      tm.succ_true = -1;
      tm.succ_false = -1;
      tm.val = kNoVal;

      if (last.kind == DK_B) {
        tm.op = TERM_BR;
        tm.succ_true = static_cast<int32_t>(ctx.insn_to_blk[last.target_idx]);
      } else if (last.kind == DK_B_COND) {
        tm.op = TERM_COND_FLAG;
        tm.cond = last.subop;
        tm.val = cur_val[kSlotFlags];
        if (tm.val == kNoVal) return false;
        tm.succ_true = static_cast<int32_t>(ctx.insn_to_blk[last.target_idx]);
        if (ctx.blk_end[b] >= ctx.word_count) return false;
        tm.succ_false = static_cast<int32_t>(ctx.insn_to_blk[ctx.blk_end[b]]);
      } else if (last.kind == DK_CBZ || last.kind == DK_CBNZ) {
        tm.op = TERM_COND_ZERO;
        tm.width = last.width;
        tm.cond = static_cast<uint8_t>(last.kind == DK_CBNZ ? 1u : 0u);
        tm.val = read_reg(b, last.rd, last.width, last.pc);
        if (tm.val == kNoVal) return false;
        tm.succ_true = static_cast<int32_t>(ctx.insn_to_blk[last.target_idx]);
        if (ctx.blk_end[b] >= ctx.word_count) return false;
        tm.succ_false = static_cast<int32_t>(ctx.insn_to_blk[ctx.blk_end[b]]);
      } else if (last.kind == DK_TBZ || last.kind == DK_TBNZ) {
        tm.op = TERM_COND_BIT;
        tm.width = last.width;
        tm.cond = static_cast<uint8_t>(last.kind == DK_TBNZ ? 1u : 0u);
        tm.bit_pos = last.aux;
        tm.val = read_reg(b, last.rd, last.width, last.pc);
        if (tm.val == kNoVal) return false;
        tm.succ_true = static_cast<int32_t>(ctx.insn_to_blk[last.target_idx]);
        if (ctx.blk_end[b] >= ctx.word_count) return false;
        tm.succ_false = static_cast<int32_t>(ctx.insn_to_blk[ctx.blk_end[b]]);
      } else if (last.kind == DK_RET) {
        tm.op = TERM_RET;
        tm.val = cur_val[0];
      } else {
        // Fallthrough to next block
        if (ctx.blk_end[b] >= ctx.word_count) return false;
        tm.op = TERM_BR;
        tm.succ_true = static_cast<int32_t>(ctx.insn_to_blk[ctx.blk_end[b]]);
      }

      // Fill incoming PHI operands in all successors of block b
      for (uint32_t e = ctx.succ_off[b]; e < ctx.succ_off[b + 1u]; ++e) {
        const uint32_t succ = static_cast<uint32_t>(ctx.succ_dst[e]);
        for (uint32_t s = 0u; s < nslots; ++s) {
          const uint32_t pid = phi_id_map[static_cast<size_t>(succ) * nslots + s];
          if (pid == kNoVal) continue;
          const IrInst& phi = ctx.insts[pid];
          for (uint32_t k = 0u; k < phi.phi_cnt; ++k) {
            PhiArg& pa = ctx.phi_args[phi.phi_off + k];
            if (pa.pred_blk == b) {
              pa.val = cur_val[s];
            }
          }
        }
      }
    }

    if (fr.child_idx < ctx.dom_child_off[b + 1u]) {
      const uint32_t ch = ctx.dom_child_dst[fr.child_idx++];
      dstack[dsp].blk = ch;
      dstack[dsp].child_idx = ctx.dom_child_off[ch];
      dstack[dsp].entered = false;
      ++dsp;
    } else {
      for (uint32_t s = 0u; s < nslots; ++s) cur_val[s] = fr.saved_val[s];
      --dsp;
    }
  }

  ctx.has_ret_val = any_x0_written;
  if (!any_x0_written) {
    for (uint32_t b = 0u; b < nb; ++b) {
      if (ctx.terms[b].op == TERM_RET) ctx.terms[b].val = kNoVal;
    }
  }

  // Build per-block instruction index arrays (ordered by creation = program order, PHIs first)
  ctx.blk_ir_off = hex::arena_alloc_zeroed<uint32_t>(ctx.scratch, nb + 1u);
  ctx.blk_ir_cnt = hex::arena_alloc_zeroed<uint32_t>(ctx.scratch, nb);
  ctx.blk_ir_ids = ctx.scratch.alloc<uint32_t>(ctx.num_insts + 1u);
  if (!ctx.blk_ir_off || !ctx.blk_ir_cnt || !ctx.blk_ir_ids) return false;
  for (uint32_t i = 0u; i < ctx.num_insts; ++i) {
    ctx.blk_ir_off[ctx.insts[i].block + 1u]++;
  }
  for (uint32_t b = 0u; b < nb; ++b) ctx.blk_ir_off[b + 1u] += ctx.blk_ir_off[b];
  for (uint32_t i = 0u; i < ctx.num_insts; ++i) {
    const uint32_t b = ctx.insts[i].block;
    ctx.blk_ir_ids[ctx.blk_ir_off[b] + ctx.blk_ir_cnt[b]++] = i;
  }
  ctx.total_blk_ir = ctx.num_insts;
  return true;
}

// -----------------------------------------------------------------------------
// Stage 3b: SSA Optimization Passes (Const Fold, Copy Prop, Algebraic, DCE)
// -----------------------------------------------------------------------------

static bool optimize_ssa(PipelineCtx& ctx) {
  const uint32_t ni = ctx.num_insts;
  const uint32_t nb = ctx.num_blocks;

  uint32_t* repl = ctx.scratch.alloc<uint32_t>(ni + 1u);
  uint8_t* live = ctx.scratch.alloc<uint8_t>(ni + 1u);
  uint32_t* work = ctx.scratch.alloc<uint32_t>(ni + 1u);
  if (!repl || !live || !work) return false;

  auto resolve = [&](uint32_t v) -> uint32_t {
    uint32_t hops = 0u;
    while (v != kNoVal && v < ni && repl[v] != v && hops < 32u) {
      v = repl[v];
      ++hops;
    }
    return v;
  };

  for (uint32_t i = 0u; i < ni; ++i) repl[i] = i;

  for (uint32_t iter = 0u; iter < 8u; ++iter) {
    bool changed = false;

    // 1. Rewrite all operands through repl[]
    for (uint32_t i = 0u; i < ni; ++i) {
      IrInst& ins = ctx.insts[i];
      if (ins.dead) continue;
      if (ins.src0 != kNoVal) {
        const uint32_t r = resolve(ins.src0);
        if (r != ins.src0) { ins.src0 = r; changed = true; }
      }
      if (ins.src1 != kNoVal) {
        const uint32_t r = resolve(ins.src1);
        if (r != ins.src1) { ins.src1 = r; changed = true; }
      }
      if (ins.src2 != kNoVal) {
        const uint32_t r = resolve(ins.src2);
        if (r != ins.src2) { ins.src2 = r; changed = true; }
      }
      if (ins.op == OP_PHI) {
        for (uint32_t k = 0u; k < ins.phi_cnt; ++k) {
          PhiArg& pa = ctx.phi_args[ins.phi_off + k];
          if (pa.val != kNoVal) {
            const uint32_t r = resolve(pa.val);
            if (r != pa.val) { pa.val = r; changed = true; }
          }
        }
      }
    }
    for (uint32_t b = 0u; b < nb; ++b) {
      if (ctx.terms[b].val != kNoVal) {
        const uint32_t r = resolve(ctx.terms[b].val);
        if (r != ctx.terms[b].val) { ctx.terms[b].val = r; changed = true; }
      }
    }

    // 2. Trivial PHI elimination + Copy propagation + Constant folding + Algebraic simplification
    for (uint32_t i = 0u; i < ni; ++i) {
      IrInst& ins = ctx.insts[i];
      if (ins.dead) continue;

      if (ins.op == OP_PHI) {
        uint32_t same = kNoVal;
        bool trivial = true;
        bool all32 = true;
        for (uint32_t k = 0u; k < ins.phi_cnt; ++k) {
          const uint32_t v = ctx.phi_args[ins.phi_off + k].val;
          if (v == i) continue;
          if (v == kNoVal) { trivial = false; all32 = false; break; }
          if (ctx.insts[v].width != 32u) all32 = false;
          if (same == kNoVal) same = v;
          else if (same != v) { trivial = false; }
        }
        if (trivial && same != kNoVal) {
          repl[i] = same;
          ins.dead = 1u;
          changed = true;
          continue;
        }
        if (all32 && ins.width != 32u) {
          ins.width = 32u;
          changed = true;
        }
        continue;
      }

      if (ins.op == OP_COPY && ins.src0 != kNoVal) {
        const IrInst& s0 = ctx.insts[ins.src0];
        if (s0.op == OP_CONST) {
          ins.op = OP_CONST;
          ins.imm = mask_width(s0.imm, ins.width);
          ins.src0 = kNoVal;
          changed = true;
          continue;
        }
        if (ins.width == 64u || s0.width == 32u) {
          repl[i] = ins.src0;
          ins.dead = 1u;
          changed = true;
          continue;
        }
      }

      // Binary ops: constant folding & algebraic identities
      if (ins.op >= OP_ADD && ins.op <= OP_ROR) {
        const IrInst& s0 = ctx.insts[ins.src0];
        const IrInst& s1 = ctx.insts[ins.src1];
        const bool c0 = (s0.op == OP_CONST);
        const bool c1 = (s1.op == OP_CONST);
        if (c0 && c1) {
          const IrOp orig_op = ins.op;
          ins.op = OP_CONST;
          ins.imm = fold_binop(orig_op, ins.width, s0.imm, s1.imm);
          ins.src0 = kNoVal;
          ins.src1 = kNoVal;
          changed = true;
          continue;
        }
        const uint64_t v0 = c0 ? mask_width(s0.imm, ins.width) : 0ULL;
        const uint64_t v1 = c1 ? mask_width(s1.imm, ins.width) : 0ULL;
        const uint64_t all_ones = (ins.width == 32u) ? 0xFFFFFFFFULL : ~0ULL;

        auto turn_into_copy = [&](uint32_t src) {
          ins.op = OP_COPY;
          ins.src0 = src;
          ins.src1 = kNoVal;
          changed = true;
        };
        auto turn_into_const = [&](uint64_t val) {
          ins.op = OP_CONST;
          ins.imm = mask_width(val, ins.width);
          ins.src0 = kNoVal;
          ins.src1 = kNoVal;
          changed = true;
        };

        switch (ins.op) {
          case OP_ADD:
            if (c1 && v1 == 0ULL) turn_into_copy(ins.src0);
            else if (c0 && v0 == 0ULL) turn_into_copy(ins.src1);
            break;
          case OP_SUB:
            if (c1 && v1 == 0ULL) turn_into_copy(ins.src0);
            else if (ins.src0 == ins.src1) turn_into_const(0ULL);
            break;
          case OP_MUL:
            if ((c1 && v1 == 0ULL) || (c0 && v0 == 0ULL)) turn_into_const(0ULL);
            else if (c1 && v1 == 1ULL) turn_into_copy(ins.src0);
            else if (c0 && v0 == 1ULL) turn_into_copy(ins.src1);
            break;
          case OP_UDIV:
          case OP_SDIV:
            if (c1 && v1 == 0ULL) turn_into_const(0ULL);
            else if (c1 && v1 == 1ULL) turn_into_copy(ins.src0);
            break;
          case OP_AND:
            if ((c1 && v1 == 0ULL) || (c0 && v0 == 0ULL)) turn_into_const(0ULL);
            else if (c1 && v1 == all_ones) turn_into_copy(ins.src0);
            else if (c0 && v0 == all_ones) turn_into_copy(ins.src1);
            else if (ins.src0 == ins.src1) turn_into_copy(ins.src0);
            break;
          case OP_OR:
            if (c1 && v1 == 0ULL) turn_into_copy(ins.src0);
            else if (c0 && v0 == 0ULL) turn_into_copy(ins.src1);
            else if (ins.src0 == ins.src1) turn_into_copy(ins.src0);
            break;
          case OP_XOR:
            if (c1 && v1 == 0ULL) turn_into_copy(ins.src0);
            else if (c0 && v0 == 0ULL) turn_into_copy(ins.src1);
            else if (ins.src0 == ins.src1) turn_into_const(0ULL);
            break;
          case OP_SHL:
          case OP_LSR:
          case OP_ASR:
          case OP_ROR: {
            const uint32_t sh_mask = (ins.width == 32u) ? 31u : 63u;
            if (c1 && (v1 & sh_mask) == 0ULL) turn_into_copy(ins.src0);
            break;
          }
          default: break;
        }
        continue;
      }

      // Unary ops: constant folding
      if (ins.op >= OP_NEG && ins.op <= OP_ZEXT) {
        const IrInst& s0 = ctx.insts[ins.src0];
        if (s0.op == OP_CONST) {
          const IrOp orig_op = ins.op;
          ins.op = OP_CONST;
          ins.imm = fold_unop(orig_op, ins.width, s0.imm, ins.imm);
          ins.src0 = kNoVal;
          changed = true;
          continue;
        }
      }

      // Select simplification
      if (ins.op == OP_SELECT) {
        if (ins.src1 == ins.src2) {
          ins.op = OP_COPY;
          ins.src0 = ins.src1;
          ins.src1 = kNoVal;
          ins.src2 = kNoVal;
          changed = true;
          continue;
        }
        const IrInst& fl = ctx.insts[ins.src0];
        if ((fl.op == OP_FLAG_SUB || fl.op == OP_FLAG_ADD || fl.op == OP_FLAG_TST) &&
            ctx.insts[fl.src0].op == OP_CONST && ctx.insts[fl.src1].op == OP_CONST) {
          bool res = false;
          if (eval_flag_cond_const(fl.op, fl.width, ctx.insts[fl.src0].imm, ctx.insts[fl.src1].imm, ins.subop, &res)) {
            ins.op = OP_COPY;
            ins.src0 = res ? ins.src1 : ins.src2;
            ins.src1 = kNoVal;
            ins.src2 = kNoVal;
            changed = true;
            continue;
          }
        }
      }
    }

    // 3. Dead-Code Elimination (mark backward from terminators)
    hex::mem_set(live, 0, ni);
    uint32_t wt = 0u;
    auto mark_live = [&](uint32_t v) {
      if (v != kNoVal && v < ni && !live[v]) {
        live[v] = 1u;
        work[wt++] = v;
      }
    };
    for (uint32_t b = 0u; b < nb; ++b) {
      if (!ctx.cfg.reachable_mask[b]) continue;
      if (ctx.terms[b].val != kNoVal) mark_live(ctx.terms[b].val);
    }
    uint32_t wh = 0u;
    while (wh < wt) {
      const uint32_t id = work[wh++];
      const IrInst& ins = ctx.insts[id];
      mark_live(ins.src0);
      mark_live(ins.src1);
      mark_live(ins.src2);
      if (ins.op == OP_PHI) {
        for (uint32_t k = 0u; k < ins.phi_cnt; ++k) {
          mark_live(ctx.phi_args[ins.phi_off + k].val);
        }
      }
    }
    for (uint32_t i = 0u; i < ni; ++i) {
      if (!live[i] && !ctx.insts[i].dead) {
        ctx.insts[i].dead = 1u;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Post-DCE soundness checks:
  // 1. No live OP_CALLEE_SAVED (would mean reading uninitialized callee-saved reg)
  // 2. No live OP_PHI with kNoVal incoming arg or OP_PHI on flags
  // 3. Every live flag consumer (TERM_COND_FLAG / OP_SELECT) must point to a concrete OP_FLAG_* with supported cond
  uint32_t max_param = 0u;
  bool any_param = false;
  for (uint32_t i = 0u; i < ni; ++i) {
    const IrInst& ins = ctx.insts[i];
    if (ins.dead) continue;
    if (ins.op == OP_CALLEE_SAVED) return false;
    if (ins.op == OP_PARAM) {
      any_param = true;
      if (ins.imm + 1ULL > max_param) max_param = static_cast<uint32_t>(ins.imm + 1ULL);
    }
    if (ins.op == OP_PHI) {
      if (ins.slot == kSlotFlags) return false;
      for (uint32_t k = 0u; k < ins.phi_cnt; ++k) {
        if (ctx.phi_args[ins.phi_off + k].val == kNoVal) return false;
      }
    }
    if (ins.op == OP_SELECT) {
      if (ins.src0 == kNoVal) return false;
      const IrInst& fl = ctx.insts[ins.src0];
      if (fl.op != OP_FLAG_SUB && fl.op != OP_FLAG_ADD && fl.op != OP_FLAG_TST) return false;
      const bool rhs_zero = (ctx.insts[fl.src1].op == OP_CONST && mask_width(ctx.insts[fl.src1].imm, fl.width) == 0ULL);
      if (!is_flag_cond_supported(fl.op, ins.subop, rhs_zero)) return false;
    }
  }
  for (uint32_t b = 0u; b < nb; ++b) {
    if (!ctx.cfg.reachable_mask[b]) continue;
    const BlockTerm& tm = ctx.terms[b];
    if (tm.op == TERM_COND_FLAG) {
      if (tm.val == kNoVal) return false;
      const IrInst& fl = ctx.insts[tm.val];
      if (fl.op != OP_FLAG_SUB && fl.op != OP_FLAG_ADD && fl.op != OP_FLAG_TST) return false;
      const bool rhs_zero = (ctx.insts[fl.src1].op == OP_CONST && mask_width(ctx.insts[fl.src1].imm, fl.width) == 0ULL);
      if (!is_flag_cond_supported(fl.op, tm.cond, rhs_zero)) return false;
    }
  }

  ctx.max_param_count = any_param ? max_param : 0u;

  // Determine return width from live RET terminators
  ctx.ret_width = 0u;
  if (ctx.has_ret_val) {
    bool all_ret_32 = true;
    bool found_ret = false;
    for (uint32_t b = 0u; b < nb; ++b) {
      if (!ctx.cfg.reachable_mask[b]) continue;
      if (ctx.terms[b].op == TERM_RET && ctx.terms[b].val != kNoVal) {
        found_ret = true;
        if (ctx.insts[ctx.terms[b].val].width != 32u) all_ret_32 = false;
      }
    }
    ctx.ret_width = found_ret ? (all_ret_32 ? 32u : 64u) : 0u;
    if (!found_ret) ctx.has_ret_val = false;
  }

  // 4. Compute use counts & mark single-use expression tree inlining
  for (uint32_t i = 0u; i < ni; ++i) {
    ctx.insts[i].use_count = 0u;
    ctx.insts[i].inlined = 0u;
    ctx.insts[i].var_idx = -1;
  }
  auto add_use = [&](uint32_t v) {
    if (v != kNoVal && v < ni && ctx.insts[v].use_count < 0xFFFFu) {
      ctx.insts[v].use_count++;
    }
  };
  uint32_t* single_user_blk = ctx.scratch.alloc<uint32_t>(ni + 1u);
  uint8_t* used_by_phi = hex::arena_alloc_zeroed<uint8_t>(ctx.scratch, ni + 1u);
  uint8_t* no_inline = hex::arena_alloc_zeroed<uint8_t>(ctx.scratch, ni + 1u);
  if (!single_user_blk || !used_by_phi || !no_inline) return false;
  for (uint32_t i = 0u; i < ni; ++i) single_user_blk[i] = kNoVal;

  auto record_user = [&](uint32_t v, uint32_t user_blk, bool is_phi_user) {
    if (v == kNoVal || v >= ni) return;
    add_use(v);
    if (is_phi_user) used_by_phi[v] = 1u;
    if (single_user_blk[v] == kNoVal) single_user_blk[v] = user_blk;
    else if (single_user_blk[v] != user_blk) single_user_blk[v] = 0xFFFFFFFEu;
  };
  auto forbid_inline = [&](uint32_t v) {
    if (v == kNoVal || v >= ni) return;
    const IrOp op = ctx.insts[v].op;
    if (op != OP_CONST && op != OP_PARAM) no_inline[v] = 1u;
  };

  for (uint32_t i = 0u; i < ni; ++i) {
    const IrInst& ins = ctx.insts[i];
    if (ins.dead) continue;
    record_user(ins.src0, ins.block, false);
    record_user(ins.src1, ins.block, false);
    record_user(ins.src2, ins.block, false);
    if (ins.op == OP_SDIV || ins.op == OP_UDIV || ins.op == OP_ROR) {
      forbid_inline(ins.src0);
      forbid_inline(ins.src1);
    }
    if (ins.op == OP_PHI) {
      for (uint32_t k = 0u; k < ins.phi_cnt; ++k) {
        const PhiArg& pa = ctx.phi_args[ins.phi_off + k];
        record_user(pa.val, pa.pred_blk, true);
      }
    }
  }
  for (uint32_t b = 0u; b < nb; ++b) {
    if (!ctx.cfg.reachable_mask[b]) continue;
    record_user(ctx.terms[b].val, b, false);
  }

  // Compute expression depth and decide inlining
  uint8_t* depth = hex::arena_alloc_zeroed<uint8_t>(ctx.scratch, ni + 1u);
  if (!depth) return false;

  for (uint32_t i = 0u; i < ni; ++i) {
    IrInst& ins = ctx.insts[i];
    if (ins.dead) continue;
    if (ins.op == OP_CONST) {
      ins.inlined = 1u;
      depth[i] = 0u;
      continue;
    }
    if (ins.op == OP_PARAM || ins.op == OP_PHI) {
      ins.inlined = 0u;
      depth[i] = 0u;
      continue;
    }
    if (ins.op == OP_FLAG_SUB || ins.op == OP_FLAG_ADD || ins.op == OP_FLAG_TST) {
      ins.inlined = 1u;
      const uint8_t d0 = (ins.src0 != kNoVal && ctx.insts[ins.src0].inlined) ? depth[ins.src0] : 0u;
      const uint8_t d1 = (ins.src1 != kNoVal && ctx.insts[ins.src1].inlined) ? depth[ins.src1] : 0u;
      depth[i] = static_cast<uint8_t>((d0 > d1 ? d0 : d1) + 1u);
      continue;
    }
    const uint8_t d0 = (ins.src0 != kNoVal && ctx.insts[ins.src0].inlined) ? depth[ins.src0] : 0u;
    const uint8_t d1 = (ins.src1 != kNoVal && ctx.insts[ins.src1].inlined) ? depth[ins.src1] : 0u;
    const uint8_t d2 = (ins.src2 != kNoVal && ctx.insts[ins.src2].inlined) ? depth[ins.src2] : 0u;
    uint8_t md = d0 > d1 ? d0 : d1;
    if (d2 > md) md = d2;
    depth[i] = static_cast<uint8_t>(md + 1u);

    if (ins.use_count == 1u && !used_by_phi[i] && !no_inline[i] &&
        single_user_blk[i] == ins.block && depth[i] <= kMaxInlineDepth) {
      ins.inlined = 1u;
    }
  }

  // Assign local variable IDs to all live, non-inlined, non-PARAM instructions
  ctx.num_locals = 0u;
  for (uint32_t i = 0u; i < ni; ++i) {
    IrInst& ins = ctx.insts[i];
    if (ins.dead || ins.inlined || ins.op == OP_PARAM) continue;
    ins.var_idx = static_cast<int32_t>(++ctx.num_locals);
  }

  return true;
}

// -----------------------------------------------------------------------------
// Stage 4: C Expression & CFG-Structured Statement Emitter
// -----------------------------------------------------------------------------

static constexpr uint8_t kTypeU64 = 1u << 0u;
static constexpr uint8_t kTypeU32 = 1u << 1u;
static constexpr uint8_t kTypeI32 = 1u << 2u;
static constexpr uint8_t kTypeI64 = 1u << 3u;
static constexpr uint8_t kTypeU8  = 1u << 4u;
static constexpr uint8_t kTypeU16 = 1u << 5u;
static constexpr uint8_t kTypeI8  = 1u << 6u;
static constexpr uint8_t kTypeI16 = 1u << 7u;

static void emit_expr(PipelineCtx& ctx, TextWriter& w, uint32_t id, uint32_t depth_guard);
static void emit_sdiv_guarded(PipelineCtx& ctx, TextWriter& w, const IrInst& ins, uint32_t dg);

static void emit_typed_operand(PipelineCtx& ctx, TextWriter& w, uint32_t id, uint8_t width, bool as_signed, uint32_t dg) {
  const IrInst& ins = ctx.insts[id];
  if (ins.op == OP_CONST && !as_signed) {
    w.put_const(ins.imm, width);
    return;
  }
  if (ins.op == OP_CONST && as_signed) {
    const int64_t sv = (width == 32u)
        ? static_cast<int64_t>(static_cast<int32_t>(static_cast<uint32_t>(ins.imm)))
        : static_cast<int64_t>(ins.imm);
    if (sv == (-2147483647LL - 1LL) && width == 32u) {
      w.puts("(-2147483647 - 1)");
    } else if (sv == (-9223372036854775807LL - 1LL) && width == 64u) {
      w.puts("(-9223372036854775807LL - 1LL)");
    } else {
      w.put_i64_dec(sv);
    }
    return;
  }
  if (as_signed) {
    if (width == 32u) {
      ctx.used_types |= kTypeI32;
      w.puts("(int32_t)");
    } else {
      ctx.used_types |= kTypeI64;
      w.puts("(int64_t)");
    }
    const bool need_paren = (ins.inlined != 0u && ins.op != OP_CONST && ins.op != OP_PARAM);
    if (need_paren) w.putc('(');
    emit_expr(ctx, w, id, dg + 1u);
    if (need_paren) w.putc(')');
    return;
  }
  // Unsigned operand: omit redundant cast if width already matches
  if (width == 32u && ins.width != 32u) {
    ctx.used_types |= kTypeU32;
    w.puts("(uint32)");
    const bool need_paren = (ins.inlined != 0u && ins.op != OP_CONST && ins.op != OP_PARAM);
    if (need_paren) w.putc('(');
    emit_expr(ctx, w, id, dg + 1u);
    if (need_paren) w.putc(')');
    return;
  }
  if (width == 64u && ins.width != 64u) {
    ctx.used_types |= kTypeU64;
    w.puts("(uint64)");
    const bool need_paren = (ins.inlined != 0u && ins.op != OP_CONST && ins.op != OP_PARAM);
    if (need_paren) w.putc('(');
    emit_expr(ctx, w, id, dg + 1u);
    if (need_paren) w.putc(')');
    return;
  }
  if (ins.inlined != 0u && ins.op != OP_CONST && ins.op != OP_PARAM) {
    w.putc('(');
    emit_expr(ctx, w, id, dg + 1u);
    w.putc(')');
  } else {
    emit_expr(ctx, w, id, dg + 1u);
  }
}

static void emit_flag_cond(PipelineCtx& ctx, TextWriter& w, uint32_t flag_id, uint8_t cond, uint32_t dg) {
  const IrInst& fl = ctx.insts[flag_id];
  const uint8_t c = cond & 0xFu;
  if (c == 0xEu || c == 0xFu) {
    w.putc('1');
    return;
  }
  if (fl.op == OP_FLAG_SUB) {
    if (c == 0x4u || c == 0x5u) {
      // MI / PL: (int)(a - b) < 0 / >= 0
      if (fl.width == 32u) { ctx.used_types |= kTypeI32; w.puts("(int32_t)("); }
      else { ctx.used_types |= kTypeI64; w.puts("(int64_t)("); }
      emit_typed_operand(ctx, w, fl.src0, fl.width, false, dg);
      w.puts(" - ");
      emit_typed_operand(ctx, w, fl.src1, fl.width, false, dg);
      w.puts(c == 0x4u ? ") < 0" : ") >= 0");
      return;
    }
    const bool is_signed = (c == 0xAu || c == 0xBu || c == 0xCu || c == 0xDu);
    emit_typed_operand(ctx, w, fl.src0, fl.width, is_signed, dg);
    switch (c) {
      case 0x0u: w.puts(" == "); break;
      case 0x1u: w.puts(" != "); break;
      case 0x2u: case 0xAu: w.puts(" >= "); break;
      case 0x3u: case 0xBu: w.puts(" < "); break;
      case 0x8u: case 0xCu: w.puts(" > "); break;
      case 0x9u: case 0xDu: w.puts(" <= "); break;
      default: w.puts(" != "); break;
    }
    emit_typed_operand(ctx, w, fl.src1, fl.width, is_signed, dg);
    return;
  }
  if (fl.op == OP_FLAG_ADD) {
    const bool rhs_zero = (ctx.insts[fl.src1].op == OP_CONST && mask_width(ctx.insts[fl.src1].imm, fl.width) == 0ULL);
    if (rhs_zero && (c == 0xAu || c == 0xBu || c == 0xCu || c == 0xDu)) {
      emit_typed_operand(ctx, w, fl.src0, fl.width, true, dg);
      if (c == 0xAu) w.puts(" >= 0");
      else if (c == 0xBu) w.puts(" < 0");
      else if (c == 0xCu) w.puts(" > 0");
      else w.puts(" <= 0");
      return;
    }
    if (c == 0x2u || c == 0x3u) {
      // Carry out of a + b
      if (fl.width == 32u) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
      else { ctx.used_types |= kTypeU64; w.puts("(uint64)("); }
      emit_typed_operand(ctx, w, fl.src0, fl.width, false, dg);
      w.puts(" + ");
      emit_typed_operand(ctx, w, fl.src1, fl.width, false, dg);
      w.puts(c == 0x2u ? ") < " : ") >= ");
      emit_typed_operand(ctx, w, fl.src0, fl.width, false, dg);
      return;
    }
    if (c == 0x4u || c == 0x5u) {
      if (fl.width == 32u) { ctx.used_types |= kTypeI32; w.puts("(int32_t)("); }
      else { ctx.used_types |= kTypeI64; w.puts("(int64_t)("); }
      emit_typed_operand(ctx, w, fl.src0, fl.width, false, dg);
      w.puts(" + ");
      emit_typed_operand(ctx, w, fl.src1, fl.width, false, dg);
      w.puts(c == 0x4u ? ") < 0" : ") >= 0");
      return;
    }
    if (fl.width == 32u) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
    else { w.putc('('); }
    emit_typed_operand(ctx, w, fl.src0, fl.width, false, dg);
    w.puts(" + ");
    emit_typed_operand(ctx, w, fl.src1, fl.width, false, dg);
    w.puts(c == 0x0u ? ") == 0" : ") != 0");
    return;
  }
  // OP_FLAG_TST
  if (c == 0x0u || c == 0x1u) {
    w.putc('(');
    emit_typed_operand(ctx, w, fl.src0, fl.width, false, dg);
    w.puts(" & ");
    emit_typed_operand(ctx, w, fl.src1, fl.width, false, dg);
    w.puts(c == 0x0u ? ") == 0" : ") != 0");
    return;
  }
  if (fl.width == 32u) { ctx.used_types |= kTypeI32; w.puts("(int32_t)("); }
  else { ctx.used_types |= kTypeI64; w.puts("(int64_t)("); }
  emit_typed_operand(ctx, w, fl.src0, fl.width, false, dg);
  w.puts(" & ");
  emit_typed_operand(ctx, w, fl.src1, fl.width, false, dg);
  if (c == 0x4u || c == 0xBu) w.puts(") < 0");
  else if (c == 0x5u || c == 0xAu) w.puts(") >= 0");
  else if (c == 0xCu) w.puts(") > 0");
  else w.puts(") <= 0");
}

static void emit_expr(PipelineCtx& ctx, TextWriter& w, uint32_t id, uint32_t dg) {
  if (id == kNoVal) {
    w.putc('0');
    return;
  }
  if (dg > 16u) {
    ctx.struct_failed = true;
    return;
  }
  const IrInst& ins = ctx.insts[id];
  if (ins.op == OP_PARAM) {
    w.putc('a');
    w.put_u64_dec(ins.imm + 1ULL);
    return;
  }
  if (ins.op == OP_CONST) {
    w.put_const(ins.imm, ins.width);
    return;
  }
  if (!ins.inlined && ins.var_idx > 0) {
    w.putc('v');
    w.put_u64_dec(static_cast<uint64_t>(ins.var_idx));
    return;
  }

  // Emit inlined expression
  const bool w32 = (ins.width == 32u);
  switch (ins.op) {
    case OP_COPY:
      emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
      return;
    case OP_ADD:
    case OP_SUB:
    case OP_MUL:
    case OP_AND:
    case OP_OR:
    case OP_XOR: {
      if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
      emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
      switch (ins.op) {
        case OP_ADD: w.puts(" + "); break;
        case OP_SUB: w.puts(" - "); break;
        case OP_MUL: w.puts(" * "); break;
        case OP_AND: w.puts(" & "); break;
        case OP_OR:  w.puts(" | "); break;
        case OP_XOR: w.puts(" ^ "); break;
        default: break;
      }
      emit_typed_operand(ctx, w, ins.src1, ins.width, false, dg);
      if (w32) w.putc(')');
      return;
    }
    case OP_SHL:
    case OP_LSR: {
      if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
      emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
      w.puts(ins.op == OP_SHL ? " << " : " >> ");
      const IrInst& s1 = ctx.insts[ins.src1];
      const uint32_t sh_mask = w32 ? 31u : 63u;
      if (s1.op == OP_CONST) {
        w.put_u64_dec(s1.imm & sh_mask);
      } else {
        w.putc('(');
        emit_typed_operand(ctx, w, ins.src1, ins.width, false, dg);
        w.puts(w32 ? " & 31u)" : " & 63u)");
      }
      if (w32) w.putc(')');
      return;
    }
    case OP_ASR: {
      if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
      else { ctx.used_types |= kTypeU64; w.puts("(uint64)("); }
      emit_typed_operand(ctx, w, ins.src0, ins.width, true, dg);
      w.puts(" >> ");
      const IrInst& s1 = ctx.insts[ins.src1];
      const uint32_t sh_mask = w32 ? 31u : 63u;
      if (s1.op == OP_CONST) {
        w.put_u64_dec(s1.imm & sh_mask);
      } else {
        w.putc('(');
        emit_typed_operand(ctx, w, ins.src1, ins.width, false, dg);
        w.puts(w32 ? " & 31u)" : " & 63u)");
      }
      w.putc(')');
      return;
    }
    case OP_ROR: {
      const uint32_t bits = w32 ? 32u : 64u;
      const uint32_t sh_mask = bits - 1u;
      const IrInst& s1 = ctx.insts[ins.src1];
      if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)(("); }
      else { w.puts("(("); }
      emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
      w.puts(" >> ");
      if (s1.op == OP_CONST) {
        const uint64_t sh = s1.imm & sh_mask;
        w.put_u64_dec(sh);
        w.puts(") | (");
        emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
        w.puts(" << ");
        w.put_u64_dec((bits - sh) & sh_mask);
        w.puts("))");
      } else {
        w.putc('(');
        emit_typed_operand(ctx, w, ins.src1, ins.width, false, dg);
        w.puts(w32 ? " & 31u)) | (" : " & 63u)) | (");
        emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
        w.puts(w32 ? " << ((32u - (" : " << ((64u - (");
        emit_typed_operand(ctx, w, ins.src1, ins.width, false, dg);
        w.puts(w32 ? " & 31u)) & 31u)))" : " & 63u)) & 63u)))");
      }
      return;
    }
    case OP_UDIV: {
      const IrInst& s1 = ctx.insts[ins.src1];
      if (s1.op == OP_CONST && mask_width(s1.imm, ins.width) != 0ULL) {
        if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
        emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
        w.puts(" / ");
        w.put_const(s1.imm, ins.width);
        if (w32) w.putc(')');
      } else {
        w.putc('(');
        emit_typed_operand(ctx, w, ins.src1, ins.width, false, dg);
        w.puts(" ? (");
        emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
        w.puts(" / ");
        emit_typed_operand(ctx, w, ins.src1, ins.width, false, dg);
        w.puts(w32 ? ") : 0u)" : ") : 0ULL)");
      }
      return;
    }
    case OP_SDIV:
      emit_sdiv_guarded(ctx, w, ins, dg);
      return;
    case OP_NEG:
      if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)(-"); }
      else { w.puts("(-"); }
      emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
      w.putc(')');
      return;
    case OP_NOT:
      if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)(~"); }
      else { w.puts("(~"); }
      emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
      w.putc(')');
      return;
    case OP_SEXT:
      if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
      else { ctx.used_types |= kTypeU64; w.puts("(uint64)("); }
      if (ins.imm == 8ULL) {
        ctx.used_types |= kTypeI8;
        if (w32) { ctx.used_types |= kTypeI32; w.puts("(int32_t)(int8_t)"); }
        else { ctx.used_types |= kTypeI64; w.puts("(int64_t)(int8_t)"); }
      } else if (ins.imm == 16ULL) {
        ctx.used_types |= kTypeI16;
        if (w32) { ctx.used_types |= kTypeI32; w.puts("(int32_t)(int16_t)"); }
        else { ctx.used_types |= kTypeI64; w.puts("(int64_t)(int16_t)"); }
      } else {
        ctx.used_types |= kTypeI32 | kTypeI64;
        w.puts("(int64_t)(int32_t)");
      }
      emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
      w.putc(')');
      return;
    case OP_ZEXT:
      if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
      emit_typed_operand(ctx, w, ins.src0, ins.width, false, dg);
      if (ins.imm == 8ULL) w.puts(" & 0xFFu");
      else if (ins.imm == 16ULL) w.puts(" & 0xFFFFu");
      else w.puts(" & 0xFFFFFFFFu");
      if (w32) w.putc(')');
      return;
    case OP_SELECT:
      w.putc('(');
      emit_flag_cond(ctx, w, ins.src0, ins.subop, dg + 1u);
      w.puts(" ? ");
      emit_typed_operand(ctx, w, ins.src1, ins.width, false, dg);
      w.puts(" : ");
      emit_typed_operand(ctx, w, ins.src2, ins.width, false, dg);
      w.putc(')');
      return;
    case OP_LOAD: {
      const uint8_t log2b = static_cast<uint8_t>((ins.subop >> 1u) & 3u);
      const bool is_signed = (ins.subop & 1u) != 0u;
      const int64_t disp = static_cast<int64_t>(ins.imm);
      ctx.used_types |= kTypeU8;
      if (is_signed) {
        if (w32) { ctx.used_types |= kTypeU32 | kTypeI32; w.puts("(uint32)(int32_t)"); }
        else { ctx.used_types |= kTypeU64 | kTypeI64; w.puts("(uint64)(int64_t)"); }
      }
      if (log2b == 0u) {
        if (is_signed) { ctx.used_types |= kTypeI8; w.puts("*(const int8_t*)("); }
        else { w.puts("*(const uint8_t*)("); }
      } else if (log2b == 1u) {
        if (is_signed) { ctx.used_types |= kTypeI16; w.puts("*(const int16_t*)("); }
        else { ctx.used_types |= kTypeU16; w.puts("*(const uint16_t*)("); }
      } else if (log2b == 2u) {
        if (is_signed) { ctx.used_types |= kTypeI32; w.puts("*(const int32_t*)("); }
        else { ctx.used_types |= kTypeU32; w.puts("*(const uint32*)("); }
      } else {
        ctx.used_types |= kTypeU64;
        w.puts("*(const uint64*)(");
      }
      if (disp == 0LL) {
        emit_expr(ctx, w, ins.src0, dg + 1u);
      } else {
        w.puts("(const uint8_t*)(");
        emit_expr(ctx, w, ins.src0, dg + 1u);
        if (disp > 0LL) {
          w.puts(") + ");
          w.put_i64_dec(disp);
        } else {
          w.puts(") - ");
          w.put_i64_dec(-disp);
        }
      }
      w.putc(')');
      return;
    }
    default:
      w.putc('0');
      return;
  }
}

// Fix OP_SDIV 64-bit INT64_MIN literal cleanly in a small helper
static void emit_sdiv_guarded(PipelineCtx& ctx, TextWriter& w, const IrInst& ins, uint32_t dg) {
  const bool w32 = (ins.width == 32u);
  const IrInst& s1 = ctx.insts[ins.src1];
  const int64_t sb = s1.op == OP_CONST
      ? (w32 ? static_cast<int64_t>(static_cast<int32_t>(static_cast<uint32_t>(s1.imm)))
             : static_cast<int64_t>(s1.imm))
      : 0LL;
  if (s1.op == OP_CONST && sb != 0LL && sb != -1LL) {
    if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
    else { ctx.used_types |= kTypeU64; w.puts("(uint64)("); }
    emit_typed_operand(ctx, w, ins.src0, ins.width, true, dg);
    w.puts(" / ");
    w.put_i64_dec(sb);
    w.putc(')');
    return;
  }
  if (w32) { ctx.used_types |= kTypeU32; w.puts("(uint32)("); }
  else { ctx.used_types |= kTypeU64; w.puts("(uint64)("); }
  emit_typed_operand(ctx, w, ins.src1, ins.width, true, dg);
  w.puts(" == 0 ? 0 : ((");
  emit_typed_operand(ctx, w, ins.src0, ins.width, true, dg);
  w.puts(w32 ? " == (-2147483647 - 1) && " : " == (-9223372036854775807LL - 1LL) && ");
  emit_typed_operand(ctx, w, ins.src1, ins.width, true, dg);
  w.puts(w32 ? " == -1) ? (-2147483647 - 1) : (" : " == -1) ? (-9223372036854775807LL - 1LL) : (");
  emit_typed_operand(ctx, w, ins.src0, ins.width, true, dg);
  w.puts(" / ");
  emit_typed_operand(ctx, w, ins.src1, ins.width, true, dg);
  w.puts(")))");
}

static void emit_term_cond(PipelineCtx& ctx, TextWriter& w, const BlockTerm& tm, bool negate) {
  if (tm.op == TERM_COND_FLAG) {
    const uint8_t c = negate ? invert_arm64_cond(tm.cond) : tm.cond;
    emit_flag_cond(ctx, w, tm.val, c, 0u);
    return;
  }
  if (tm.op == TERM_COND_ZERO) {
    const bool is_nz = (tm.cond != 0u) ^ negate;
    emit_typed_operand(ctx, w, tm.val, tm.width, false, 0u);
    w.puts(is_nz ? " != 0" : " == 0");
    return;
  }
  if (tm.op == TERM_COND_BIT) {
    const bool is_nz = (tm.cond != 0u) ^ negate;
    w.puts("((");
    emit_typed_operand(ctx, w, tm.val, tm.width, false, 0u);
    if (tm.bit_pos != 0u) {
      w.puts(" >> ");
      w.put_u64_dec(tm.bit_pos);
    }
    w.puts(is_nz ? ") & 1) != 0" : ") & 1) == 0");
    return;
  }
  w.putc(negate ? '0' : '1');
}

static void emit_block_stmts(PipelineCtx& ctx, TextWriter& w, uint32_t blk, uint32_t indent) {
  const uint32_t beg = ctx.blk_ir_off[blk];
  const uint32_t end = beg + ctx.blk_ir_cnt[blk];
  for (uint32_t k = beg; k < end; ++k) {
    const uint32_t id = ctx.blk_ir_ids[k];
    const IrInst& ins = ctx.insts[id];
    if (ins.dead || ins.inlined || ins.op == OP_PARAM || ins.op == OP_PHI) continue;
    w.put_indent(indent);
    w.putc('v');
    w.put_u64_dec(static_cast<uint64_t>(ins.var_idx));
    w.puts(" = ");
    // Temporarily emit RHS directly (avoid self-var reference)
    IrInst& mut_ins = ctx.insts[id];
    mut_ins.inlined = 1u;
    if (mut_ins.op == OP_SDIV) {
      emit_sdiv_guarded(ctx, w, mut_ins, 0u);
    } else {
      emit_expr(ctx, w, id, 0u);
    }
    mut_ins.inlined = 0u;
    w.puts(";\n");
    w.mark_line(blk, ins.pc);
  }
}

static bool block_has_non_inlined_stmts(const PipelineCtx& ctx, uint32_t blk) {
  const uint32_t beg = ctx.blk_ir_off[blk];
  const uint32_t end = beg + ctx.blk_ir_cnt[blk];
  for (uint32_t k = beg; k < end; ++k) {
    const IrInst& ins = ctx.insts[ctx.blk_ir_ids[k]];
    if (!ins.dead && !ins.inlined && ins.op != OP_PARAM && ins.op != OP_PHI) return true;
  }
  return false;
}

static bool has_phi_copies(const PipelineCtx& ctx, uint32_t from_blk, int32_t to_blk) {
  if (to_blk < 0 || static_cast<uint32_t>(to_blk) >= ctx.num_blocks) return false;
  const uint32_t ub = static_cast<uint32_t>(to_blk);
  const uint32_t beg = ctx.blk_ir_off[ub];
  const uint32_t end = beg + ctx.blk_ir_cnt[ub];
  for (uint32_t k = beg; k < end; ++k) {
    const uint32_t pid = ctx.blk_ir_ids[k];
    const IrInst& phi = ctx.insts[pid];
    if (phi.dead || phi.op != OP_PHI) continue;
    for (uint32_t a = 0u; a < phi.phi_cnt; ++a) {
      const PhiArg& pa = ctx.phi_args[phi.phi_off + a];
      if (pa.pred_blk == from_blk && pa.val != pid) return true;
    }
  }
  return false;
}

// Emit parallel PHI copies along edge from_blk -> to_blk safely (handles swaps/cycles).
static void emit_phi_copies(PipelineCtx& ctx, TextWriter& w, uint32_t from_blk, int32_t to_blk, uint32_t indent) {
  if (to_blk < 0 || static_cast<uint32_t>(to_blk) >= ctx.num_blocks) return;
  const uint32_t ub = static_cast<uint32_t>(to_blk);
  const uint32_t beg = ctx.blk_ir_off[ub];
  const uint32_t end = beg + ctx.blk_ir_cnt[ub];

  struct CopyPair {
    uint32_t dst_id;
    uint32_t src_id;
    bool done;
  };
  CopyPair copies[kMaxSlots];
  uint32_t nc = 0u;

  for (uint32_t k = beg; k < end; ++k) {
    const uint32_t pid = ctx.blk_ir_ids[k];
    const IrInst& phi = ctx.insts[pid];
    if (phi.dead || phi.op != OP_PHI) continue;
    for (uint32_t a = 0u; a < phi.phi_cnt; ++a) {
      const PhiArg& pa = ctx.phi_args[phi.phi_off + a];
      if (pa.pred_blk == from_blk) {
        if (pa.val != pid) {
          if (nc >= kMaxSlots) {
            ctx.struct_failed = true;
            return;
          }
          copies[nc++] = CopyPair{pid, pa.val, false};
        }
        break;
      }
    }
  }
  if (nc == 0u) return;

  // Topological emission for non-cyclic copies; cycle-breaking via scoped temp if needed
  uint32_t remaining = nc;
  while (remaining > 0u) {
    bool progress = false;
    for (uint32_t i = 0u; i < nc; ++i) {
      if (copies[i].done) continue;
      bool dst_is_used = false;
      for (uint32_t j = 0u; j < nc; ++j) {
        if (!copies[j].done && j != i && copies[j].src_id == copies[i].dst_id) {
          dst_is_used = true;
          break;
        }
      }
      if (!dst_is_used) {
        const IrInst& dst_ins = ctx.insts[copies[i].dst_id];
        w.put_indent(indent);
        w.putc('v');
        w.put_u64_dec(static_cast<uint64_t>(dst_ins.var_idx));
        w.puts(" = ");
        emit_typed_operand(ctx, w, copies[i].src_id, dst_ins.width, false, 0u);
        w.puts(";\n");
        w.mark_line(from_blk, ctx.terms[from_blk].pc);
        copies[i].done = true;
        --remaining;
        progress = true;
      }
    }
    if (!progress) {
      // Break cycle using a block-scoped temp
      uint32_t pick = 0u;
      while (pick < nc && copies[pick].done) ++pick;
      const IrInst& dst_ins = ctx.insts[copies[pick].dst_id];
      ctx.used_types |= kTypeU64;
      w.put_indent(indent);
      w.puts("{ uint64 __t = (uint64)v");
      w.put_u64_dec(static_cast<uint64_t>(dst_ins.var_idx));
      w.puts("; ");
      // Emit chain starting at pick
      uint32_t cur = pick;
      uint32_t guard = 0u;
      while (guard++ < nc) {
        const IrInst& cur_dst = ctx.insts[copies[cur].dst_id];
        w.putc('v');
        w.put_u64_dec(static_cast<uint64_t>(cur_dst.var_idx));
        w.puts(" = ");
        uint32_t next_idx = nc;
        for (uint32_t j = 0u; j < nc; ++j) {
          if (!copies[j].done && j != cur && copies[j].dst_id == copies[cur].src_id) {
            next_idx = j;
            break;
          }
        }
        if (copies[cur].src_id == copies[pick].dst_id) {
          if (cur_dst.width == 32u) {
            ctx.used_types |= kTypeU32;
            w.puts("(uint32)__t; ");
          } else {
            w.puts("__t; ");
          }
          copies[cur].done = true;
          --remaining;
          break;
        }
        emit_typed_operand(ctx, w, copies[cur].src_id, ctx.insts[copies[cur].dst_id].width, false, 0u);
        w.puts("; ");
        copies[cur].done = true;
        --remaining;
        if (next_idx == nc) break;
        cur = next_idx;
      }
      w.puts("}\n");
    }
  }
}

static void emit_region(
    PipelineCtx& ctx,
    TextWriter& w,
    int32_t blk,
    int32_t stop_blk,
    int32_t active_loop,
    int32_t active_loop_header,
    int32_t active_loop_exit,
    uint32_t indent,
    uint32_t rec_depth) {
  if (rec_depth > 64u) {
    ctx.struct_failed = true;
    return;
  }

  while (blk >= 0 && blk != stop_blk && !ctx.struct_failed && !w.overflow) {
    const uint32_t ub = static_cast<uint32_t>(blk);
    if (ub >= ctx.num_blocks) {
      ctx.struct_failed = true;
      return;
    }

    // Check if blk is a natural loop header we haven't entered yet
    const int32_t hdr_loop = ctx.loops.header_to_loop[ub];
    if (hdr_loop >= 0 && hdr_loop != active_loop) {
      if (ctx.blk_emitted[ub]) {
        ctx.struct_failed = true;
        return;
      }
      const int32_t loop_exit = ctx.find_single_loop_exit(hdr_loop);
      const BlockTerm& htm = ctx.terms[ub];

      // Pattern 1: clean `while (cond) { ... }` header
      if ((htm.op == TERM_COND_FLAG || htm.op == TERM_COND_ZERO || htm.op == TERM_COND_BIT) &&
          !block_has_non_inlined_stmts(ctx, ub)) {
        const bool t_in = ctx.is_in_loop(htm.succ_true, hdr_loop);
        const bool f_in = ctx.is_in_loop(htm.succ_false, hdr_loop);
        if (t_in != f_in) {
          const int32_t body_blk = t_in ? htm.succ_true : htm.succ_false;
          const int32_t exit_blk = t_in ? htm.succ_false : htm.succ_true;
          const bool neg_cond = !t_in;
          if (!has_phi_copies(ctx, ub, body_blk) && !has_phi_copies(ctx, ub, exit_blk)) {
            ctx.blk_emitted[ub] = 1u;
            w.put_indent(indent);
            w.puts("while (");
            emit_term_cond(ctx, w, htm, neg_cond);
            w.puts(") {\n");
            w.mark_line(ub, htm.pc);
            emit_region(ctx, w, body_blk, blk, hdr_loop, blk, exit_blk, indent + 1u, rec_depth + 1u);
            w.put_indent(indent);
            w.puts("}\n");
            blk = exit_blk;
            continue;
          }
        }
      }

      // Pattern 2: general structured `while (1) { ... }` loop
      w.put_indent(indent);
      w.puts("while (1) {\n");
      w.mark_line(ub, ctx.blk_addr[ub]);
      emit_region(ctx, w, blk, loop_exit, hdr_loop, blk, loop_exit, indent + 1u, rec_depth + 1u);
      w.put_indent(indent);
      w.puts("}\n");
      blk = loop_exit;
      continue;
    }

    if (ctx.blk_emitted[ub]) {
      ctx.struct_failed = true;
      return;
    }
    ctx.blk_emitted[ub] = 1u;

    emit_block_stmts(ctx, w, ub, indent);

    const BlockTerm& tm = ctx.terms[ub];
    if (tm.op == TERM_RET) {
      w.put_indent(indent);
      if (ctx.has_ret_val && tm.val != kNoVal) {
        w.puts("return ");
        emit_typed_operand(ctx, w, tm.val, ctx.ret_width, false, 0u);
        w.puts(";\n");
      } else {
        w.puts("return;\n");
      }
      w.mark_line(ub, tm.pc);
      return;
    }

    if (tm.op == TERM_BR) {
      const int32_t next = tm.succ_true;
      emit_phi_copies(ctx, w, ub, next, indent);
      if (next == stop_blk) return;
      if (active_loop >= 0 && next == active_loop_header) {
        w.put_indent(indent);
        w.puts("continue;\n");
        w.mark_line(ub, tm.pc);
        return;
      }
      if (active_loop >= 0 && next == active_loop_exit) {
        w.put_indent(indent);
        w.puts("break;\n");
        w.mark_line(ub, tm.pc);
        return;
      }
      blk = next;
      continue;
    }

    if (tm.op == TERM_COND_FLAG || tm.op == TERM_COND_ZERO || tm.op == TERM_COND_BIT) {
      const int32_t t_blk = tm.succ_true;
      const int32_t f_blk = tm.succ_false;

      // Special fast-paths for loop break / continue
      if (active_loop >= 0) {
        if (t_blk == active_loop_exit && f_blk != active_loop_exit) {
          w.put_indent(indent);
          w.puts("if (");
          emit_term_cond(ctx, w, tm, false);
          w.puts(") {\n");
          w.mark_line(ub, tm.pc);
          emit_phi_copies(ctx, w, ub, t_blk, indent + 1u);
          w.put_indent(indent + 1u);
          w.puts("break;\n");
          w.put_indent(indent);
          w.puts("}\n");
          emit_phi_copies(ctx, w, ub, f_blk, indent);
          if (f_blk == stop_blk) return;
          if (f_blk == active_loop_header) {
            w.put_indent(indent);
            w.puts("continue;\n");
            return;
          }
          blk = f_blk;
          continue;
        }
        if (f_blk == active_loop_exit && t_blk != active_loop_exit) {
          w.put_indent(indent);
          w.puts("if (");
          emit_term_cond(ctx, w, tm, true);
          w.puts(") {\n");
          w.mark_line(ub, tm.pc);
          emit_phi_copies(ctx, w, ub, f_blk, indent + 1u);
          w.put_indent(indent + 1u);
          w.puts("break;\n");
          w.put_indent(indent);
          w.puts("}\n");
          emit_phi_copies(ctx, w, ub, t_blk, indent);
          if (t_blk == stop_blk) return;
          if (t_blk == active_loop_header) {
            w.put_indent(indent);
            w.puts("continue;\n");
            return;
          }
          blk = t_blk;
          continue;
        }
        if (t_blk == active_loop_header && f_blk != active_loop_header) {
          w.put_indent(indent);
          w.puts("if (");
          emit_term_cond(ctx, w, tm, false);
          w.puts(") {\n");
          w.mark_line(ub, tm.pc);
          emit_phi_copies(ctx, w, ub, t_blk, indent + 1u);
          w.put_indent(indent + 1u);
          w.puts("continue;\n");
          w.put_indent(indent);
          w.puts("}\n");
          emit_phi_copies(ctx, w, ub, f_blk, indent);
          if (f_blk == stop_blk) return;
          blk = f_blk;
          continue;
        }
        if (f_blk == active_loop_header && t_blk != active_loop_header) {
          w.put_indent(indent);
          w.puts("if (");
          emit_term_cond(ctx, w, tm, true);
          w.puts(") {\n");
          w.mark_line(ub, tm.pc);
          emit_phi_copies(ctx, w, ub, f_blk, indent + 1u);
          w.put_indent(indent + 1u);
          w.puts("continue;\n");
          w.put_indent(indent);
          w.puts("}\n");
          emit_phi_copies(ctx, w, ub, t_blk, indent);
          if (t_blk == stop_blk) return;
          blk = t_blk;
          continue;
        }
      }

      // General structured if / if-else using post-dominator pdom_idom[ub]
      int32_t merge = ctx.cfg.pdom_idom[ub];
      if (merge < 0 || static_cast<uint32_t>(merge) >= ctx.num_blocks) {
        merge = -1;
      }
      if (active_loop >= 0 && merge >= 0 && !ctx.is_in_loop(merge, active_loop)) {
        merge = stop_blk;
      }
      const int32_t inner_stop = (merge >= 0) ? merge : stop_blk;

      const bool t_empty = (t_blk == inner_stop);
      const bool f_empty = (f_blk == inner_stop);

      if (t_empty && !f_empty) {
        w.put_indent(indent);
        w.puts("if (");
        emit_term_cond(ctx, w, tm, true);
        w.puts(") {\n");
        w.mark_line(ub, tm.pc);
        emit_phi_copies(ctx, w, ub, f_blk, indent + 1u);
        emit_region(ctx, w, f_blk, inner_stop, active_loop, active_loop_header, active_loop_exit, indent + 1u, rec_depth + 1u);
        w.put_indent(indent);
        w.puts("}\n");
        if (has_phi_copies(ctx, ub, t_blk)) {
          // Rare edge: phi copy on empty branch -> emit as else
          ctx.struct_failed = true;
          return;
        }
      } else if (f_empty && !t_empty) {
        w.put_indent(indent);
        w.puts("if (");
        emit_term_cond(ctx, w, tm, false);
        w.puts(") {\n");
        w.mark_line(ub, tm.pc);
        emit_phi_copies(ctx, w, ub, t_blk, indent + 1u);
        emit_region(ctx, w, t_blk, inner_stop, active_loop, active_loop_header, active_loop_exit, indent + 1u, rec_depth + 1u);
        w.put_indent(indent);
        w.puts("}\n");
        if (has_phi_copies(ctx, ub, f_blk)) {
          ctx.struct_failed = true;
          return;
        }
      } else {
        w.put_indent(indent);
        w.puts("if (");
        emit_term_cond(ctx, w, tm, false);
        w.puts(") {\n");
        w.mark_line(ub, tm.pc);
        emit_phi_copies(ctx, w, ub, t_blk, indent + 1u);
        if (!t_empty) {
          emit_region(ctx, w, t_blk, inner_stop, active_loop, active_loop_header, active_loop_exit, indent + 1u, rec_depth + 1u);
        }
        w.put_indent(indent);
        w.puts("} else {\n");
        emit_phi_copies(ctx, w, ub, f_blk, indent + 1u);
        if (!f_empty) {
          emit_region(ctx, w, f_blk, inner_stop, active_loop, active_loop_header, active_loop_exit, indent + 1u, rec_depth + 1u);
        }
        w.put_indent(indent);
        w.puts("}\n");
      }

      if (merge < 0 || merge == stop_blk) return;
      blk = merge;
      continue;
    }

    ctx.struct_failed = true;
    return;
  }
}

}  // namespace

void set_ir_pipeline_scratch_arena(hex::Arena* scratch) {
  g_ir_scratch_arena = scratch;
}

HexStatus try_emit_arm64_ir_pipeline(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t emit_flags,
    hex::Arena& emit_arena,
    const char** out_text,
    uint32_t* out_text_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count) {
  if (!words || word_count == 0u || word_count > kMaxWords || !out_text || !out_text_len) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (static_cast<uint64_t>(word_count) * 4ULL > UINT64_MAX - base_addr) {
    return HEX_ERR_UNSUPPORTED;
  }
  if ((emit_flags & HEX_EMIT_FLAG_DISABLE_IR_PIPELINE) != 0u ||
      (emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u) {
    return HEX_ERR_UNSUPPORTED;
  }

  hex::Arena& scratch = g_ir_scratch_arena ? *g_ir_scratch_arena : emit_arena;
  hex::ArenaScope scratch_scope(scratch);

  char norm_name[kMaxNormNameLen + 1u];
  uint32_t norm_name_len = 0u;
  if (!normalize_func_name(func_name_utf8, func_name_len, base_addr,
                           norm_name, sizeof(norm_name), &norm_name_len)) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Stage 1: Decode & strictly validate every instruction in the function
  DecInsn* dec = scratch.alloc<DecInsn>(word_count);
  if (!dec) return HEX_ERR_OOM;

  for (uint32_t i = 0u; i < word_count; ++i) {
    const uint64_t pc = base_addr + static_cast<uint64_t>(i) * 4ULL;
    if (!decode_arm64_word(words[i], pc, base_addr, word_count, &dec[i])) {
      return HEX_ERR_UNSUPPORTED;
    }
  }

  // Partition basic blocks at branch targets & after terminators
  uint8_t* is_leader = hex::arena_alloc_zeroed<uint8_t>(scratch, word_count);
  uint32_t* insn_to_blk = scratch.alloc<uint32_t>(word_count);
  if (!is_leader || !insn_to_blk) return HEX_ERR_OOM;

  is_leader[0] = 1u;
  for (uint32_t i = 0u; i < word_count; ++i) {
    const DecInsn& d = dec[i];
    if (d.kind == DK_B || d.kind == DK_B_COND || d.kind == DK_CBZ || d.kind == DK_CBNZ ||
        d.kind == DK_TBZ || d.kind == DK_TBNZ) {
      if (d.target_idx < word_count) is_leader[d.target_idx] = 1u;
      if (i + 1u < word_count) is_leader[i + 1u] = 1u;
    } else if (d.kind == DK_RET) {
      if (i + 1u < word_count) is_leader[i + 1u] = 1u;
    }
  }

  uint32_t num_blocks = 0u;
  for (uint32_t i = 0u; i < word_count; ++i) {
    if (is_leader[i]) ++num_blocks;
    insn_to_blk[i] = num_blocks - 1u;
  }
  if (num_blocks == 0u || num_blocks > kMaxBlocks) return HEX_ERR_UNSUPPORTED;

  uint32_t* blk_start = scratch.alloc<uint32_t>(num_blocks);
  uint32_t* blk_end = scratch.alloc<uint32_t>(num_blocks);
  uint64_t* blk_addr = scratch.alloc<uint64_t>(num_blocks);
  if (!blk_start || !blk_end || !blk_addr) return HEX_ERR_OOM;

  {
    uint32_t b = 0u;
    for (uint32_t i = 0u; i < word_count; ++i) {
      if (is_leader[i]) {
        if (b > 0u) blk_end[b - 1u] = i;
        blk_start[b] = i;
        blk_addr[b] = dec[i].pc;
        ++b;
      }
    }
    blk_end[num_blocks - 1u] = word_count;
  }

  // Stage 2: Build CSR CFG + Dominators + Post-Dominators + Natural Loops
  uint32_t* succ_off = scratch.alloc<uint32_t>(num_blocks + 1u);
  int32_t* succ_dst = scratch.alloc<int32_t>(num_blocks * 2u + 1u);
  if (!succ_off || !succ_dst) return HEX_ERR_OOM;

  uint32_t edge_cnt = 0u;
  succ_off[0] = 0u;
  for (uint32_t b = 0u; b < num_blocks; ++b) {
    const DecInsn& last = dec[blk_end[b] - 1u];
    if (last.kind == DK_B) {
      succ_dst[edge_cnt++] = static_cast<int32_t>(insn_to_blk[last.target_idx]);
    } else if (last.kind == DK_B_COND || last.kind == DK_CBZ || last.kind == DK_CBNZ ||
               last.kind == DK_TBZ || last.kind == DK_TBNZ) {
      if (blk_end[b] >= word_count) return HEX_ERR_UNSUPPORTED;
      const int32_t t = static_cast<int32_t>(insn_to_blk[last.target_idx]);
      const int32_t f = static_cast<int32_t>(insn_to_blk[blk_end[b]]);
      succ_dst[edge_cnt++] = t;
      if (f != t) succ_dst[edge_cnt++] = f;
    } else if (last.kind == DK_RET) {
      // No outgoing edges
    } else {
      if (blk_end[b] >= word_count) return HEX_ERR_UNSUPPORTED;
      succ_dst[edge_cnt++] = static_cast<int32_t>(insn_to_blk[blk_end[b]]);
    }
    succ_off[b + 1u] = edge_cnt;
  }

  // Build CSR predecessors
  uint32_t* pred_off = hex::arena_alloc_zeroed<uint32_t>(scratch, num_blocks + 1u);
  int32_t* pred_src = scratch.alloc<int32_t>(edge_cnt + 1u);
  if (!pred_off || !pred_src) return HEX_ERR_OOM;
  for (uint32_t b = 0u; b < num_blocks; ++b) {
    for (uint32_t e = succ_off[b]; e < succ_off[b + 1u]; ++e) {
      pred_off[static_cast<uint32_t>(succ_dst[e]) + 1u]++;
    }
  }
  for (uint32_t b = 0u; b < num_blocks; ++b) pred_off[b + 1u] += pred_off[b];
  {
    hex::ArenaScope sc(scratch);
    uint32_t* cur = scratch.alloc<uint32_t>(num_blocks);
    if (!cur) return HEX_ERR_OOM;
    for (uint32_t b = 0u; b < num_blocks; ++b) cur[b] = pred_off[b];
    for (uint32_t b = 0u; b < num_blocks; ++b) {
      for (uint32_t e = succ_off[b]; e < succ_off[b + 1u]; ++e) {
        const uint32_t dst = static_cast<uint32_t>(succ_dst[e]);
        pred_src[cur[dst]++] = static_cast<int32_t>(b);
      }
    }
  }

  PipelineCtx ctx{scratch, word_count, base_addr, dec,
                  num_blocks, blk_start, blk_end, blk_addr, insn_to_blk,
                  succ_off, succ_dst, pred_off, pred_src,
                  HexCfgResult{}, HexLoopResult{},
                  {}, 0u, nullptr, nullptr, nullptr, nullptr,
                  nullptr, 0u, nullptr, 0u, nullptr,
                  nullptr, nullptr, nullptr, 0u,
                  nullptr, nullptr,
                  0u, nullptr, false, 0u, 0u, false, 0u};

  // Call hex_cfg_analyze_arena for dominators, post-dominators, reachability
  if (hex_cfg_analyze_arena(scratch, num_blocks, succ_off, edge_cnt ? succ_dst : nullptr,
                            0, nullptr, &ctx.cfg) != HEX_OK) {
    return HEX_ERR_UNSUPPORTED;
  }

  // Call hex_loop_analyze_arena for natural loops
  if (hex_loop_analyze_arena(scratch, num_blocks, succ_off, edge_cnt ? succ_dst : nullptr,
                             0, nullptr, nullptr, &ctx.loops) != HEX_OK) {
    return HEX_ERR_UNSUPPORTED;
  }
  if (!ctx.loops.complete) return HEX_ERR_UNSUPPORTED;

  // Reject irreducible CFGs cleanly
  if (!is_cfg_reducible(ctx)) return HEX_ERR_UNSUPPORTED;

  // Analyze stack frame & promote non-escaping scalar stack slots
  if (!analyze_stack_frame(ctx)) return HEX_ERR_UNSUPPORTED;

  // Stage 3: Build SSA + Optimize (const fold, copy prop, algebraic, DCE, inlining)
  if (!build_ssa(ctx)) return HEX_ERR_UNSUPPORTED;
  if (!optimize_ssa(ctx)) return HEX_ERR_UNSUPPORTED;

  // Stage 4: Emit body into temporary scratch buffer first so we know exact minimal typedefs!
  char* body_buf = scratch.alloc<char>(kMaxTextBytes);
  HexLineMapEntry* body_lm = scratch.alloc<HexLineMapEntry>(kMaxLineMap);
  ctx.blk_emitted = hex::arena_alloc_zeroed<uint8_t>(scratch, num_blocks);
  if (!body_buf || !body_lm || !ctx.blk_emitted) return HEX_ERR_OOM;
  body_buf[0] = '\0';

  TextWriter bw{body_buf, kMaxTextBytes, 0u, 1u, false, body_lm, kMaxLineMap, 0u};
  emit_region(ctx, bw, 0, -1, -1, -1, -1, 1u, 0u);
  if (ctx.struct_failed || bw.overflow) return HEX_ERR_UNSUPPORTED;

  // Verify every reachable block was emitted cleanly
  for (uint32_t b = 0u; b < num_blocks; ++b) {
    if (ctx.cfg.reachable_mask[b] && !ctx.blk_emitted[b]) {
      return HEX_ERR_UNSUPPORTED;
    }
  }

  // Mark types needed by signature and local declarations
  if (ctx.has_ret_val) {
    ctx.used_types |= (ctx.ret_width == 32u) ? kTypeU32 : kTypeU64;
  }
  if (ctx.max_param_count > 0u) {
    ctx.used_types |= kTypeU64;
  }
  for (uint32_t i = 0u; i < ctx.num_insts; ++i) {
    const IrInst& ins = ctx.insts[i];
    if (ins.dead || ins.inlined || ins.op == OP_PARAM || ins.var_idx <= 0) continue;
    ctx.used_types |= (ins.width == 32u) ? kTypeU32 : kTypeU64;
  }

  // Assemble final C output into emit_arena
  const size_t emit_mark = emit_arena.used();
  char* out_buf = emit_arena.alloc<char>(kMaxTextBytes);
  HexLineMapEntry* out_lm = emit_arena.alloc<HexLineMapEntry>(kMaxLineMap);
  if (!out_buf || !out_lm) {
    emit_arena.restore(emit_mark);
    return HEX_ERR_OOM;
  }
  out_buf[0] = '\0';

  TextWriter fw{out_buf, kMaxTextBytes, 0u, 1u, false, out_lm, kMaxLineMap, 0u};

  // Emit ONLY the minimal typedefs actually referenced
  if ((ctx.used_types & kTypeU64) != 0u) fw.puts("typedef __UINT64_TYPE__ uint64;\n");
  if ((ctx.used_types & kTypeU32) != 0u) fw.puts("typedef __UINT32_TYPE__ uint32;\n");
  if ((ctx.used_types & kTypeI32) != 0u) fw.puts("typedef __INT32_TYPE__ int32_t;\n");
  if ((ctx.used_types & kTypeI64) != 0u) fw.puts("typedef __INT64_TYPE__ int64_t;\n");
  if ((ctx.used_types & kTypeU8)  != 0u) fw.puts("typedef __UINT8_TYPE__ uint8_t;\n");
  if ((ctx.used_types & kTypeU16) != 0u) fw.puts("typedef __UINT16_TYPE__ uint16_t;\n");
  if ((ctx.used_types & kTypeI8)  != 0u) fw.puts("typedef __INT8_TYPE__ int8_t;\n");
  if ((ctx.used_types & kTypeI16) != 0u) fw.puts("typedef __INT16_TYPE__ int16_t;\n");
  if (ctx.used_types != 0u) fw.putc('\n');

  // Function signature
  if (!ctx.has_ret_val) {
    fw.puts("void ");
  } else if (ctx.ret_width == 32u) {
    fw.puts("uint32 ");
  } else {
    fw.puts("uint64 ");
  }
  fw.put_bytes(norm_name, norm_name_len);
  fw.putc('(');
  if (ctx.max_param_count == 0u) {
    fw.puts("void");
  } else {
    for (uint32_t p = 0u; p < ctx.max_param_count; ++p) {
      if (p > 0u) fw.puts(", ");
      fw.puts("uint64 a");
      fw.put_u64_dec(p + 1u);
    }
  }
  fw.puts(")\n{\n");
  fw.mark_line(0u, base_addr);

  // Minimal local variable declarations (only live non-inlined SSA vars)
  for (uint32_t i = 0u; i < ctx.num_insts; ++i) {
    const IrInst& ins = ctx.insts[i];
    if (ins.dead || ins.inlined || ins.op == OP_PARAM || ins.var_idx <= 0) continue;
    fw.puts(ins.width == 32u ? "    uint32 v" : "    uint64 v");
    fw.put_u64_dec(static_cast<uint64_t>(ins.var_idx));
    fw.puts(";\n");
  }

  // Copy body + adjust linemap line numbers
  const uint32_t body_line_offset = fw.cur_line - 1u;
  fw.put_bytes(bw.buf, bw.len);
  for (uint32_t k = 0u; k < bw.lm_count; ++k) {
    if (fw.lm_count < fw.lm_cap) {
      fw.lm[fw.lm_count++] = HexLineMapEntry{
          bw.lm[k].line_no + body_line_offset,
          bw.lm[k].block_id,
          bw.lm[k].addr};
    }
  }
  fw.puts("}\n");

  if (fw.overflow) {
    emit_arena.restore(emit_mark);
    return HEX_ERR_OOM;
  }

  *out_text = out_buf;
  *out_text_len = fw.len;
  if (out_linemap) *out_linemap = out_lm;
  if (out_linemap_count) *out_linemap_count = fw.lm_count;
  return HEX_OK;
}

}  // namespace hex::decompiler::passes
