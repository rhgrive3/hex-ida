#include "engine_runtime.hpp"

#if defined(HEX_HAS_DECOMP_PASSES)
#include "decompiler/passes/arm64_simple_emit.hpp"
#include "decompiler/passes/arm64_memory_emit.hpp"
#include "decompiler/passes/arm64_branch_emit.hpp"
#include "decompiler/passes/arm64_fp_atomic_emit.hpp"
#include "decompiler/passes/arm64_call_emit.hpp"
#include "decompiler/passes/arm64_frame_bl_emit.hpp"
#include "decompiler/passes/arm64_frame_vcall_emit.hpp"
#include "decompiler/passes/arm64_frame_branch_bl_emit.hpp"
#include "decompiler/passes/arm64_frame_multicall_emit.hpp"
#include "decompiler/passes/arm64_objc_emit.hpp"
#include "decompiler/passes/arm64_udf_emit.hpp"
#include "decompiler/passes/arm64_global_thunk_emit.hpp"
#include "decompiler/passes/arm64_ir_pipeline.hpp"
#include "decompiler/passes/arm64_general_emit.hpp"
namespace hex {
namespace decompiler {
namespace passes {
void set_general_scratch_arena(hex::Arena* scratch);
void set_general_rodata_slice(uint64_t va, const uint8_t* ptr, uint32_t len);
void clear_general_rodata_slice();
void reset_general_loss_flags();
uint32_t get_general_loss_flags();
}  // namespace passes
}  // namespace decompiler
}  // namespace hex
#endif

namespace {

constexpr uint32_t kEmitArenaBytes = 1536u * 1024u;
constexpr uint32_t kMaxParityWords = 16u;

alignas(16) uint8_t g_image_storage[HEX_ENGINE_IMAGE_ARENA_BYTES];
alignas(16) uint8_t g_ir_storage[HEX_ENGINE_IR_ARENA_BYTES];
alignas(16) uint8_t g_scratch_storage[HEX_ENGINE_SCRATCH_ARENA_BYTES];
alignas(16) uint8_t g_emit_storage[kEmitArenaBytes];

hex::Arena g_image_arena;
hex::Arena g_ir_arena;
hex::Arena g_scratch_arena;
hex::Arena g_emit_arena;
bool g_initialized = false;

const char* g_last_text = nullptr;
uint32_t g_last_text_len = 0u;
const HexLineMapEntry* g_last_linemap = nullptr;
uint32_t g_last_linemap_count = 0u;
static uint32_t g_last_loss_flags = HEX_DECOMP_LOSS_NONE;

constexpr uint32_t kFlagVarId = 32u;
constexpr uint32_t kTempVarBase = 64u;
constexpr uint32_t kMaxEmitBytes = 256u * 1024u;

#if defined(HEX_HAS_DECOMP_PASSES)
HexStatus try_specialized_arm64_passes(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t emit_flags) {
  using PassFn = HexStatus (*)(
      const uint32_t*, uint32_t, uint64_t, const char*, uint32_t, uint32_t,
      hex::Arena&, const char**, uint32_t*, const HexLineMapEntry**, uint32_t*);
  struct PassDesc {
    PassFn fn;
    uint32_t min_words;
    uint32_t max_words;
  };
  static const PassDesc kPasses[] = {
    {&hex::decompiler::passes::try_emit_arm64_simple,           1u,  64u},
    {&hex::decompiler::passes::try_emit_arm64_memory,           1u,  64u},
    {&hex::decompiler::passes::try_emit_arm64_branch_loop,      6u,   9u},
    {&hex::decompiler::passes::try_emit_arm64_fp_atomic,        2u,   6u},
    {&hex::decompiler::passes::try_emit_arm64_calls,            5u,  64u},
    {&hex::decompiler::passes::try_emit_arm64_frame_bl,         7u,  11u},
    {&hex::decompiler::passes::try_emit_arm64_frame_vcall,      8u,  10u},
    {&hex::decompiler::passes::try_emit_arm64_frame_branch_bl, 20u,  20u},
    {&hex::decompiler::passes::try_emit_arm64_frame_multicall, 22u,  64u},
    {&hex::decompiler::passes::try_emit_arm64_objc,             8u,  14u},
    {&hex::decompiler::passes::try_emit_arm64_udf_tail,         3u,  64u},
    {&hex::decompiler::passes::try_emit_arm64_global_thunk,     2u,  64u},
    {&hex::decompiler::passes::try_emit_arm64_ir_pipeline,      1u, 512u},
    {&hex::decompiler::passes::try_emit_arm64_general,          1u,  HEX_ENGINE_MAX_DECOMP_WORDS},
  };
  // O(1) pre-filter: passes 0..11 all reject word_count > 64; jump straight to general.
  const size_t start_idx = (word_count > 64u) ? 12u : 0u;
  for (size_t i = start_idx; i < sizeof(kPasses) / sizeof(kPasses[0]); ++i) {
    if (word_count < kPasses[i].min_words || word_count > kPasses[i].max_words) {
      continue;
    }
    if (kPasses[i].fn == &hex::decompiler::passes::try_emit_arm64_ir_pipeline &&
        ((emit_flags & HEX_EMIT_FLAG_DISABLE_IR_PIPELINE) != 0u ||
         (emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u)) {
      continue;
    }
    g_emit_arena.reset();
    hex::decompiler::passes::reset_general_loss_flags();
    const char* txt = nullptr;
    uint32_t txt_len = 0u;
    const HexLineMapEntry* lm = nullptr;
    uint32_t lm_cnt = 0u;
    const HexStatus st = kPasses[i].fn(
        words, word_count, base_addr, func_name_utf8, func_name_len, emit_flags,
        g_emit_arena, &txt, &txt_len, &lm, &lm_cnt);
    if (st == HEX_OK && txt && txt_len > 0u) {
      g_last_text = txt;
      g_last_text_len = txt_len;
      g_last_linemap = lm;
      g_last_linemap_count = lm_cnt;
      g_last_loss_flags = hex::decompiler::passes::get_general_loss_flags();
      return HEX_OK;
    }
  }
  return HEX_ERR_UNSUPPORTED;
}
#endif

void clear_last_output() {
  g_last_text = nullptr;
  g_last_text_len = 0u;
  g_last_linemap = nullptr;
  g_last_linemap_count = 0u;
  g_last_loss_flags = HEX_DECOMP_LOSS_NONE;
#if defined(HEX_HAS_DECOMP_PASSES)
  hex::decompiler::passes::reset_general_loss_flags();
#endif
}

void bind_all_subsystems() {
  hex::identity::bind_global_arena_ptr(&g_scratch_arena);
  hex::binary::bind_global_arenas(&g_image_arena, &g_scratch_arena);
  hex::ir::default_store().init(&g_ir_arena, &g_scratch_arena);
  // Dedicated fixed emit arena isolates c_emitter output/work buffers from g_scratch_arena.
  hex::decompiler::bind_arena(&g_emit_arena);
}

void ensure_initialized() {
  if (!g_initialized) {
    hex_engine_init();
  }
}

uint8_t map_bin_subop(uint16_t flags) {
  switch (flags & HEX_IR_SUBOP_MASK) {
    case HEX_IR_BIN_ADD: return CEMIT_BIN_ADD;
    case HEX_IR_BIN_SUB: return CEMIT_BIN_SUB;
    case HEX_IR_BIN_MUL: return CEMIT_BIN_MUL;
    case HEX_IR_BIN_AND: return CEMIT_BIN_AND;
    case HEX_IR_BIN_OR:  return CEMIT_BIN_OR;
    case HEX_IR_BIN_XOR: return CEMIT_BIN_XOR;
    case HEX_IR_BIN_SHL: return CEMIT_BIN_SHL;
    case HEX_IR_BIN_LSR: return CEMIT_BIN_SHR;
    case HEX_IR_BIN_ASR: return CEMIT_BIN_SHR;
    case HEX_IR_BIN_UDIV: return CEMIT_BIN_UDIV;
    case HEX_IR_BIN_UREM: return CEMIT_BIN_SREM;
    default: return CEMIT_BIN_ADD;
  }
}

uint8_t map_un_subop(uint16_t flags) {
  switch (flags & HEX_IR_SUBOP_MASK) {
    case HEX_IR_UN_NEG: return CEMIT_UN_NEG;
    case HEX_IR_UN_NOT: return CEMIT_UN_NOT;
    case HEX_IR_UN_ZEXT32: return CEMIT_UN_ZEXT;
    case HEX_IR_UN_SEXT32: return CEMIT_UN_ZEXT;
    default: return CEMIT_UN_NEG;
  }
}

uint8_t map_arm64_cond_to_cemit_cmp(uint32_t cond) {
  switch (cond & 0x0fu) {
    case 0x0u: return CEMIT_CMP_EQ;
    case 0x1u: return CEMIT_CMP_NE;
    case 0x2u: return CEMIT_CMP_UGE;
    case 0x3u: return CEMIT_CMP_ULT;
    case 0x8u: return CEMIT_CMP_UGT;
    case 0x9u: return CEMIT_CMP_ULE;
    case 0xau: return CEMIT_CMP_SGE;
    case 0xbu: return CEMIT_CMP_SLT;
    case 0xcu: return CEMIT_CMP_SGT;
    case 0xdu: return CEMIT_CMP_SLE;
    default:   return CEMIT_CMP_NE;
  }
}

// JS decompile-base.js prints decimals for [0..99] and uppercase hex for >= 100,
// while c_emitter prints decimals for [0..999] and uppercase hex for >= 1000.
// Reject [100..999] under JS parity mode to guarantee strict 0-diff output.
constexpr bool is_js_parity_imm_exact(uint64_t val) {
  return !(val >= 100ULL && val <= 999ULL);
}

bool is_runtime_arm64_word_supported(uint32_t w, bool js_parity_mode) {
  // Canonical NOP (0xd503201f) can be safely skipped.
  if (w == 0xd503201fu) return true;

  const uint8_t kind = hex_arm64_classify_word(w);

  // ADD / SUB (immediate): S=0, GPR rd/rn < 31, non-zero imm (avoid x+0 fold diff).
  if (kind == HEX_ARM64_KIND_ARITH && (w & 0x1f000000u) == 0x11000000u) {
    if (((w >> 23) & 1u) != 0u) return false;
    const bool s_bit = ((w >> 29) & 1u) != 0u;
    const uint32_t rd = w & 0x1fu;
    const uint32_t rn = (w >> 5) & 0x1fu;
    if (s_bit || rd >= 31u || rn >= 31u) return false;
    const uint32_t shift = ((w >> 22) & 1u) ? 12u : 0u;
    const uint64_t imm = static_cast<uint64_t>((w >> 10) & 0xfffu) << shift;
    if (imm == 0ULL) return false;
    if (js_parity_mode && !is_js_parity_imm_exact(imm)) return false;
    return true;
  }

  // AND / EOR (unshifted register): N=0, shift=0, imm6=0, GPR rd/rn/rm < 31.
  if (kind == HEX_ARM64_KIND_LOGIC && (w & 0x1f000000u) == 0x0a000000u) {
    const uint32_t opc = (w >> 29) & 3u;
    const uint32_t n_bit = (w >> 21) & 1u;
    const uint32_t shift = (w >> 22) & 3u;
    const uint32_t imm6 = (w >> 10) & 0x3fu;
    const uint32_t rd = w & 0x1fu;
    const uint32_t rn = (w >> 5) & 0x1fu;
    const uint32_t rm = (w >> 16) & 0x1fu;
    if ((opc == 0u || opc == 2u) && n_bit == 0u && shift == 0u && imm6 == 0u &&
        rd < 31u && rn < 31u && rm < 31u) {
      if (js_parity_mode && rn == rm) return false;
      return true;
    }
    return false;
  }

  // Delegate remaining instructions to the core ARM64 capability gate.
  if (!hex_arm64_is_decompiler_supported(w)) return false;

  // Variable shifts (LSLV/LSRV/ASRV): require rn != rm.
  // Always reject ASRV (op2 == 2) regardless of js_parity_mode so arm64_general_emit
  // emits a signed arithmetic shift instead of c_emitter's unsigned CEMIT_BIN_SHR.
  if (kind == HEX_ARM64_KIND_SHIFT) {
    const uint32_t rn = (w >> 5) & 0x1fu;
    const uint32_t rm = (w >> 16) & 0x1fu;
    if (rn == rm) return false;
    const uint32_t op2 = (w >> 10) & 3u;
    if (op2 == 2u) return false;
  }

  // Reject flag-setting ADDS/SUBS under JS parity (only plain ADD/SUB).
  if (kind == HEX_ARM64_KIND_ARITH && ((w >> 29) & 1u) != 0u) return false;
  // Reject SUB reg with rn == rm under JS parity (optimizer folds x - x -> 0, JS emits a1 - a1).
  if (js_parity_mode && kind == HEX_ARM64_KIND_ARITH &&
      (w & 0x1f200000u) == 0x0b000000u && ((w >> 30) & 1u) != 0u) {
    const uint32_t rn = (w >> 5) & 0x1fu;
    const uint32_t rm = (w >> 16) & 0x1fu;
    if (rn == rm) return false;
  }

  // Enforce JS decimal/hex literal threshold parity on MOVZ/MOVN constants.
  if (js_parity_mode && kind == HEX_ARM64_KIND_MOVIMM) {
    const uint32_t opc = (w >> 29) & 3u;
    const uint32_t hw = (w >> 21) & 3u;
    const uint64_t imm16 = static_cast<uint64_t>((w >> 5) & 0xffffu);
    uint64_t val = imm16 << (hw * 16u);
    if (opc == 0u) val = ~val;
    if (((w >> 31) & 1u) == 0u) val &= 0xffffffffULL;
    if (!is_js_parity_imm_exact(val)) return false;
  }

  return true;
}

struct Arm64ParityCheckResult {
  bool supported;
  uint32_t inferred_param_count;
  uint32_t rbw_arg_mask;
  uint8_t ret_width;
};

// Strict 0-bit JS-oracle parity gate for ARM64 functions:
//   - word_count in [1, kMaxParityWords]
//   - straight-line body ending in canonical `ret` (0xd65f03c0), no interior RET
//   - no read of undefined non-argument register (reg >= 8)
//   - must write return register x0/w0 before RET
//   - no dead writes (every written register must flow to x0 at RET)
//   - read-before-write argument registers x0..x7 must be contiguous from x0 (no gaps)
Arm64ParityCheckResult check_arm64_strict_parity(
    const HexArm64Decoded* decoded, uint32_t count, bool js_parity_mode) {
  Arm64ParityCheckResult res{false, 0u, 0u, 0u};
  if (count == 0u || count > kMaxParityWords) return res;
  if (decoded[count - 1u].kind != HEX_ARM64_KIND_RET) return res;

  uint8_t insn_dst[kMaxParityWords];
  uint8_t insn_r0[kMaxParityWords];
  uint8_t insn_r1[kMaxParityWords];
  uint8_t insn_rcount[kMaxParityWords];

  uint8_t alias_origin[31];
  for (uint8_t r = 0u; r < 31u; ++r) alias_origin[r] = r;

  uint32_t defined_mask = 0u;
  uint32_t computed_mask = 0u;
  uint32_t rbw_arg_mask = 0u;
  uint8_t last_x0_width = 0u;
  bool has_non_mov_compute = false;

  for (uint32_t i = 0u; i + 1u < count; ++i) {
    const HexArm64Decoded& d = decoded[i];
    if (d.kind == HEX_ARM64_KIND_RET) return res;  // interior RET

    if (d.kind == HEX_ARM64_KIND_NOP) {
      insn_dst[i] = 31u;
      insn_r0[i] = 31u;
      insn_r1[i] = 31u;
      insn_rcount[i] = 0u;
      continue;
    }

    uint8_t dst = 31u;
    uint8_t r0 = 31u;
    uint8_t r1 = 31u;
    uint8_t rc = 0u;

    switch (d.kind) {
      case HEX_ARM64_KIND_MOVIMM:
        dst = d.rd;
        break;
      case HEX_ARM64_KIND_MOVREG:
        dst = d.rd;
        r0 = d.rm;
        rc = 1u;
        break;
      case HEX_ARM64_KIND_ARITH:
        dst = d.rd;
        r0 = d.rn;
        if ((d.word & 0x1f000000u) == 0x11000000u) {
          rc = 1u;  // ADD/SUB immediate reads only Rn
        } else {
          r1 = d.rm;
          rc = 2u;
        }
        break;
      case HEX_ARM64_KIND_MUL:
      case HEX_ARM64_KIND_LOGIC:
      case HEX_ARM64_KIND_SHIFT:
        dst = d.rd;
        r0 = d.rn;
        r1 = d.rm;
        rc = 2u;
        break;
      default:
        return res;
    }

    if (dst >= 31u) return res;
    const uint8_t reads[2] = {r0, r1};
    for (uint8_t k = 0u; k < rc; ++k) {
      const uint8_t r = reads[k];
      if (r >= 31u) return res;
      if ((defined_mask & (1u << r)) == 0u) {
        if (r >= 8u) return res;  // undefined non-argument register read
        rbw_arg_mask |= (1u << r);
      }
    }

    // Fail-closed on alias-resolved self-operand reductions and shift precedence/folding diffs.
    if (d.kind == HEX_ARM64_KIND_SHIFT) {
      if (alias_origin[r0] == alias_origin[r1]) return res;
      if (js_parity_mode &&
          (((computed_mask & (1u << r0)) != 0u) || ((computed_mask & (1u << r1)) != 0u))) {
        return res;
      }
    } else if (js_parity_mode && rc == 2u && alias_origin[r0] == alias_origin[r1]) {
      const bool is_sub_reg =
          (d.kind == HEX_ARM64_KIND_ARITH) && ((d.word & 0x1f200000u) == 0x0b000000u) &&
          (((d.word >> 30) & 1u) != 0u);
      if (is_sub_reg || d.kind == HEX_ARM64_KIND_LOGIC) {
        return res;
      }
    }

    if (d.kind == HEX_ARM64_KIND_MOVREG) {
      alias_origin[dst] = alias_origin[r0];
      if ((computed_mask & (1u << r0)) != 0u) {
        computed_mask |= (1u << dst);
      } else {
        computed_mask &= ~(1u << dst);
      }
    } else {
      has_non_mov_compute = true;
      alias_origin[dst] = dst;
      computed_mask |= (1u << dst);
    }

    defined_mask |= (1u << dst);
    if (dst == 0u) {
      last_x0_width = (((d.word >> 31) & 1u) == 0u) ? 32u : 64u;
    }

    insn_dst[i] = dst;
    insn_r0[i] = r0;
    insn_r1[i] = r1;
    insn_rcount[i] = rc;
  }

  // Must write return register x0/w0 before RET and perform at least one non-MOV op
  // (pure MOV-only functions like `mov w0, w0; ret` emit `(void) { uint64 a1; return a1; }` in JS).
  if ((defined_mask & 1u) == 0u || last_x0_width == 0u || !has_non_mov_compute) return res;

  // Backward liveness pass: reject dead writes that never reach x0 at RET.
  uint32_t live_mask = 1u;
  for (uint32_t rev = count - 1u; rev > 0u; --rev) {
    const uint32_t i = rev - 1u;
    const uint8_t dst = insn_dst[i];
    if (dst == 31u) continue;  // NOP
    if ((live_mask & (1u << dst)) == 0u) {
      return res;  // dead write
    }
    live_mask &= ~(1u << dst);
    if (insn_rcount[i] >= 1u) live_mask |= (1u << insn_r0[i]);
    if (insn_rcount[i] >= 2u) live_mask |= (1u << insn_r1[i]);
  }

  // Strict read-before-write argument inference: must be contiguous from x0 with no gaps.
  uint32_t param_count = 0u;
  if (rbw_arg_mask != 0u) {
    uint32_t max_arg = 0u;
    for (uint32_t r = 0u; r < 8u; ++r) {
      if ((rbw_arg_mask & (1u << r)) != 0u) max_arg = r;
    }
    const uint32_t expected_mask = (1u << (max_arg + 1u)) - 1u;
    if (rbw_arg_mask != expected_mask) {
      return res;  // gapped argument register usage (e.g. `mov x0, x1; ret`)
    }
    param_count = max_arg + 1u;
  }

  res.supported = true;
  res.inferred_param_count = param_count;
  res.rbw_arg_mask = rbw_arg_mask;
  res.ret_width = last_x0_width;
  return res;
}

// Lift a single supported ARM64 instruction into Resident IR.
HexStatus lift_arm64_insn(
    hex::ir::IrStore& store,
    HexIrHandle ir_handle,
    uint32_t block_id,
    const HexArm64Decoded& d,
    uint32_t& next_temp_var,
    bool& wrote_x0,
    uint8_t& ret_width) {
  const uint32_t w = d.word;
  const bool is32 = ((w >> 31) & 1u) == 0u;
  const uint16_t wflag = is32 ? HEX_IR_FLAG_WIDTH32 : 0u;
  const uint32_t kNone = hex::ir::kNone;

  auto track_ret = [&](uint32_t dst_reg) {
    if (dst_reg == 0u) {
      wrote_x0 = true;
      ret_width = is32 ? 32u : 64u;
    }
  };

  switch (d.kind) {
    case HEX_ARM64_KIND_NOP:
      return store.add_inst(ir_handle, block_id, HEX_IR_OP_NOP, 0u, kNone, kNone, kNone, kNone, 0u, nullptr);

    case HEX_ARM64_KIND_MOVIMM: {
      const uint32_t opc = (w >> 29) & 3u;
      const uint32_t hw = (w >> 21) & 3u;
      const uint64_t imm16 = static_cast<uint64_t>((w >> 5) & 0xffffu);
      uint64_t val = imm16 << (hw * 16u);
      if (opc == 0u) {  // MOVN
        val = ~val;
      }
      if (is32) val &= 0xffffffffULL;
      if (d.rd < 31u) {
        track_ret(d.rd);
        return store.add_inst(ir_handle, block_id, HEX_IR_OP_CONST, wflag, d.rd, kNone, kNone, kNone, val, nullptr);
      }
      return HEX_OK;
    }

    case HEX_ARM64_KIND_MOVREG: {
      if (d.rd >= 31u) return HEX_OK;
      track_ret(d.rd);
      if (d.rm == 31u) {
        return store.add_inst(ir_handle, block_id, HEX_IR_OP_CONST, wflag, d.rd, kNone, kNone, kNone, 0u, nullptr);
      }
      return store.add_inst(ir_handle, block_id, HEX_IR_OP_MOV, wflag, d.rd, d.rm, kNone, kNone, 0u, nullptr);
    }

    case HEX_ARM64_KIND_ARITH: {
      const bool is_sub = ((w >> 30) & 1u) != 0u;
      const uint16_t subop = is_sub ? HEX_IR_BIN_SUB : HEX_IR_BIN_ADD;
      const bool is_imm = (w & 0x1f000000u) == 0x11000000u;
      if (d.rd >= 31u) return HEX_OK;
      track_ret(d.rd);
      if (is_imm) {
        const uint32_t shift = ((w >> 22) & 1u) ? 12u : 0u;
        const uint64_t imm = static_cast<uint64_t>((w >> 10) & 0xfffu) << shift;
        const uint32_t tmp = next_temp_var++;
        HexStatus st = store.add_inst(ir_handle, block_id, HEX_IR_OP_CONST, wflag, tmp, kNone, kNone, kNone, imm, nullptr);
        if (st != HEX_OK) return st;
        return store.add_inst(
            ir_handle, block_id, HEX_IR_OP_BIN, static_cast<uint16_t>(subop | wflag),
            d.rd, d.rn, tmp, kNone, 0u, nullptr);
      }
      return store.add_inst(
          ir_handle, block_id, HEX_IR_OP_BIN, static_cast<uint16_t>(subop | wflag),
          d.rd, d.rn, d.rm, kNone, 0u, nullptr);
    }

    case HEX_ARM64_KIND_MUL: {
      if (d.rd >= 31u) return HEX_OK;
      track_ret(d.rd);
      return store.add_inst(
          ir_handle, block_id, HEX_IR_OP_BIN, static_cast<uint16_t>(HEX_IR_BIN_MUL | wflag),
          d.rd, d.rn, d.rm, kNone, 0u, nullptr);
    }

    case HEX_ARM64_KIND_LOGIC: {
      if (d.rd >= 31u) return HEX_OK;
      const uint32_t opc = (w >> 29) & 3u;
      uint16_t subop = HEX_IR_BIN_AND;
      if (opc == 1u) subop = HEX_IR_BIN_OR;
      else if (opc == 2u) subop = HEX_IR_BIN_XOR;
      track_ret(d.rd);
      return store.add_inst(
          ir_handle, block_id, HEX_IR_OP_BIN, static_cast<uint16_t>(subop | wflag),
          d.rd, d.rn, d.rm, kNone, 0u, nullptr);
    }

    case HEX_ARM64_KIND_SHIFT: {
      if (d.rd >= 31u) return HEX_OK;
      const uint32_t op2 = (w >> 10) & 3u;
      uint16_t subop = HEX_IR_BIN_SHL;
      if (op2 == 1u) subop = HEX_IR_BIN_LSR;
      else if (op2 == 2u) subop = HEX_IR_BIN_ASR;
      track_ret(d.rd);
      const uint64_t sh_mask = is32 ? 31ULL : 63ULL;
      const uint32_t tmp_mask = next_temp_var++;
      HexStatus st = store.add_inst(
          ir_handle, block_id, HEX_IR_OP_CONST, wflag, tmp_mask, kNone, kNone, kNone, sh_mask, nullptr);
      if (st != HEX_OK) return st;
      const uint32_t tmp_amt = next_temp_var++;
      st = store.add_inst(
          ir_handle, block_id, HEX_IR_OP_BIN, static_cast<uint16_t>(HEX_IR_BIN_AND | wflag),
          tmp_amt, d.rm, tmp_mask, kNone, 0u, nullptr);
      if (st != HEX_OK) return st;
      return store.add_inst(
          ir_handle, block_id, HEX_IR_OP_BIN, static_cast<uint16_t>(subop | wflag),
          d.rd, d.rn, tmp_amt, kNone, 0u, nullptr);
    }

    case HEX_ARM64_KIND_CMP: {
      if (d.has_compare_with) {
        const uint32_t tmp = next_temp_var++;
        HexStatus st = store.add_inst(
            ir_handle, block_id, HEX_IR_OP_CONST, wflag, tmp, kNone, kNone, kNone,
            static_cast<uint64_t>(d.compare_with), nullptr);
        if (st != HEX_OK) return st;
        return store.add_inst(
            ir_handle, block_id, HEX_IR_OP_CMP, wflag, kFlagVarId, d.rn, tmp, kNone,
            static_cast<uint64_t>(d.compare_with), nullptr);
      }
      return store.add_inst(
          ir_handle, block_id, HEX_IR_OP_CMP, wflag, kFlagVarId, d.rn, d.rm, kNone, 0u, nullptr);
    }

    case HEX_ARM64_KIND_CONDBR: {
      const bool is_bcond = (w & 0xff000010u) == 0x54000000u;
      if (is_bcond) {
        const uint8_t cemit_cmp = map_arm64_cond_to_cemit_cmp(w & 0x0fu);
        return store.add_inst(
            ir_handle, block_id, HEX_IR_OP_CBR, static_cast<uint16_t>(cemit_cmp),
            kNone, kFlagVarId, kNone, kNone, d.target, nullptr);
      }
      const bool is_cbnz = ((w >> 24) & 1u) != 0u;
      const uint8_t cemit_cmp = is_cbnz ? CEMIT_CMP_NE : CEMIT_CMP_EQ;
      return store.add_inst(
          ir_handle, block_id, HEX_IR_OP_CBR, static_cast<uint16_t>(cemit_cmp),
          kNone, d.rd, kNone, kNone, d.target, nullptr);
    }

    case HEX_ARM64_KIND_BRANCH:
      return store.add_inst(
          ir_handle, block_id, HEX_IR_OP_BR, 0u, kNone, kNone, kNone, kNone, d.target, nullptr);

    case HEX_ARM64_KIND_RET:
      return store.add_inst(
          ir_handle, block_id, HEX_IR_OP_RET, 0u, kNone,
          wrote_x0 ? 0u : kNone, kNone, kNone, 0u, nullptr);

    default:
      return HEX_ERR_UNSUPPORTED;
  }
}

}  // namespace

namespace hex {
namespace runtime {

hex::Arena* shared_emit_arena() {
  ensure_initialized();
  return &g_emit_arena;
}

hex::Arena* shared_scratch_arena() {
  ensure_initialized();
  return &g_scratch_arena;
}

HexStatus bind_external_arenas(
    uint8_t* image_buf,
    size_t image_cap,
    uint8_t* ir_buf,
    size_t ir_cap,
    uint8_t* scratch_buf,
    size_t scratch_cap) {
  if (!image_buf || image_cap == 0u || !ir_buf || ir_cap == 0u || !scratch_buf || scratch_cap == 0u) {
    return HEX_ERR_INVALID_ARG;
  }
  g_image_arena.init_fixed(image_buf, image_cap);
  g_ir_arena.init_fixed(ir_buf, ir_cap);
  g_scratch_arena.init_fixed(scratch_buf, scratch_cap);
  g_emit_arena.init_fixed(g_emit_storage, sizeof(g_emit_storage));
  bind_all_subsystems();
  clear_last_output();
  g_initialized = true;
  return HEX_OK;
}

HexEngineArenaStats get_arena_stats() {
  ensure_initialized();
  HexEngineArenaStats st{};
  st.image_used = static_cast<uint32_t>(g_image_arena.used());
  st.image_cap = static_cast<uint32_t>(g_image_arena.capacity());
  st.ir_used = static_cast<uint32_t>(g_ir_arena.used());
  st.ir_cap = static_cast<uint32_t>(g_ir_arena.capacity());
  st.scratch_used = static_cast<uint32_t>(g_scratch_arena.used());
  st.scratch_cap = static_cast<uint32_t>(g_scratch_arena.capacity());
  return st;
}

}  // namespace runtime
}  // namespace hex

extern "C" {

HEX_WASM_EXPORT("hex_engine_init")
HexStatus hex_engine_init(void) {
  g_image_arena.init_fixed(g_image_storage, sizeof(g_image_storage));
  g_ir_arena.init_fixed(g_ir_storage, sizeof(g_ir_storage));
  g_scratch_arena.init_fixed(g_scratch_storage, sizeof(g_scratch_storage));
  g_emit_arena.init_fixed(g_emit_storage, sizeof(g_emit_storage));
  bind_all_subsystems();
#if defined(HEX_HAS_DECOMP_PASSES)
  hex::decompiler::passes::clear_general_rodata_slice();
#endif
  clear_last_output();
  g_initialized = true;
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_engine_version")
uint32_t hex_engine_version(void) {
  return HEX_ENGINE_ABI_VERSION;
}

HEX_WASM_EXPORT("hex_engine_scratch_alloc")
void* hex_engine_scratch_alloc(uint32_t bytes) {
  ensure_initialized();
  if (bytes == 0u) return nullptr;
  return g_scratch_arena.alloc_bytes(static_cast<size_t>(bytes), 8u);
}

HEX_WASM_EXPORT("hex_engine_scratch_reset")
void hex_engine_scratch_reset(void) {
  ensure_initialized();
#if defined(HEX_HAS_DECOMP_PASSES)
  hex::decompiler::passes::clear_general_rodata_slice();
#endif
  g_scratch_arena.reset();
}

HEX_WASM_EXPORT("hex_engine_decompile_arm64")
HexStatus hex_engine_decompile_arm64(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t emit_flags) {
  ensure_initialized();
  clear_last_output();

  if (!words || word_count == 0u) return HEX_ERR_INVALID_ARG;
  if (word_count > HEX_ENGINE_MAX_DECOMP_WORDS) return HEX_ERR_RESOURCE_LIMIT;
  if (func_name_len > 0u && !func_name_utf8) return HEX_ERR_INVALID_ARG;

  // Guard caller-allocated inputs on g_scratch_arena (e.g., words / func_name_utf8)
  // and guarantee O(1) reclamation of all temporary pipeline buffers on every exit path.
  const size_t scratch_entry_mark = g_scratch_arena.used();
  hex::ArenaScope scratch_scope(g_scratch_arena);

  // Stage 1: ARM64 capability gate (if primary straight-line SSA rejects, try specialized 0-diff passes).
  const bool js_parity_mode = (emit_flags & HEX_EMIT_FLAG_JS_PARITY) != 0u;
  bool primary_supported = (word_count <= kMaxParityWords);
  if (primary_supported) {
    for (uint32_t i = 0u; i < word_count; ++i) {
      if (!is_runtime_arm64_word_supported(words[i], js_parity_mode)) {
        primary_supported = false;
        break;
      }
    }
  }

  HexArm64Decoded* decoded = nullptr;
  Arm64ParityCheckResult parity{};
  HexStatus st = HEX_OK;
  if (primary_supported) {
    decoded = g_scratch_arena.alloc<HexArm64Decoded>(word_count);
    if (!decoded) return HEX_ERR_OOM;
    st = hex_arm64_decode_batch(words, word_count, base_addr, decoded);
    if (st != HEX_OK) return st;
    parity = check_arm64_strict_parity(decoded, word_count, js_parity_mode);
    primary_supported = parity.supported;
  }

  auto fallback_to_specialized = [&](HexIrHandle& active_ir) -> HexStatus {
    if (active_ir != 0u) {
      hex::ir::default_store().release(active_ir);
      active_ir = 0u;
    }
    clear_last_output();
#if defined(HEX_HAS_DECOMP_PASSES)
    g_scratch_arena.restore(scratch_entry_mark);
    hex::decompiler::passes::set_ir_pipeline_scratch_arena(&g_scratch_arena);
    hex::decompiler::passes::set_general_scratch_arena(&g_scratch_arena);
    return try_specialized_arm64_passes(
        words, word_count, base_addr, func_name_utf8, func_name_len, emit_flags);
#else
    (void)scratch_entry_mark;
    return HEX_ERR_UNSUPPORTED;
#endif
  };

  if (!primary_supported) {
    HexIrHandle no_ir = 0u;
    return fallback_to_specialized(no_ir);
  }

  // Stage 2: Basic block partitioning.
  uint8_t* is_leader = hex::arena_alloc_zeroed<uint8_t>(g_scratch_arena, word_count);
  uint32_t* insn_to_block = g_scratch_arena.alloc<uint32_t>(word_count);
  if (!is_leader || !insn_to_block) return HEX_ERR_OOM;

  is_leader[0] = 1u;
  const uint64_t code_end = base_addr + static_cast<uint64_t>(word_count) * 4ULL;
  for (uint32_t i = 0u; i < word_count; ++i) {
    const HexArm64Decoded& d = decoded[i];
    if (d.has_target && (d.kind == HEX_ARM64_KIND_BRANCH || d.kind == HEX_ARM64_KIND_CONDBR)) {
      if (d.target >= base_addr && d.target < code_end && ((d.target - base_addr) & 3ULL) == 0ULL) {
        const uint32_t target_idx = static_cast<uint32_t>((d.target - base_addr) / 4ULL);
        if (target_idx < word_count) is_leader[target_idx] = 1u;
      }
      if (i + 1u < word_count) is_leader[i + 1u] = 1u;
    } else if (d.kind == HEX_ARM64_KIND_RET) {
      if (i + 1u < word_count) is_leader[i + 1u] = 1u;
    }
  }

  uint32_t num_blocks = 0u;
  for (uint32_t i = 0u; i < word_count; ++i) {
    if (is_leader[i]) ++num_blocks;
    insn_to_block[i] = num_blocks - 1u;
  }

  uint64_t* block_addrs = g_scratch_arena.alloc<uint64_t>(num_blocks);
  if (!block_addrs) return HEX_ERR_OOM;
  {
    uint32_t cur_b = 0u;
    for (uint32_t i = 0u; i < word_count; ++i) {
      if (is_leader[i]) block_addrs[cur_b++] = decoded[i].pc;
    }
  }

  // Stage 3: Build Resident IR in IrStore.
  hex::ir::IrStore& store = hex::ir::default_store();
  HexIrHandle ir_handle = 0u;
  st = store.create(0u, &ir_handle);
  if (st != HEX_OK) return st;

  auto fail_cleanup = [&](HexStatus err) -> HexStatus {
    if (ir_handle != 0u) store.release(ir_handle);
    clear_last_output();
    return err;
  };

  for (uint32_t b = 0u; b < num_blocks; ++b) {
    st = store.add_block(ir_handle, nullptr);
    if (st != HEX_OK) return fail_cleanup(st);
  }

  hex::Vec<uint64_t> ir_inst_addrs(&g_scratch_arena);
  if (!ir_inst_addrs.reserve(static_cast<size_t>(word_count) * 3u)) {
    return fail_cleanup(HEX_ERR_OOM);
  }

  bool wrote_x0 = false;
  uint8_t ret_width = 0u;
  uint32_t next_temp_var = kTempVarBase;

  for (uint32_t i = 0u; i < word_count; ++i) {
    const uint32_t blk = insn_to_block[i];
    const hex::ir::IrFunction* fn_before = store.lookup(ir_handle);
    const size_t prev_count = fn_before ? fn_before->insts.size() : 0u;

    st = lift_arm64_insn(store, ir_handle, blk, decoded[i], next_temp_var, wrote_x0, ret_width);
    if (st != HEX_OK) return fail_cleanup(st);

    const hex::ir::IrFunction* fn_after = store.lookup(ir_handle);
    const size_t new_count = fn_after ? fn_after->insts.size() : prev_count;
    for (size_t k = prev_count; k < new_count; ++k) {
      if (!ir_inst_addrs.push_back(decoded[i].pc)) return fail_cleanup(HEX_ERR_OOM);
    }

    const bool at_block_end = (i + 1u == word_count) || (insn_to_block[i + 1u] != blk);
    if (at_block_end) {
      const HexArm64Decoded& d = decoded[i];
      if (d.kind == HEX_ARM64_KIND_BRANCH) {
        if (d.has_target && d.target >= base_addr && d.target < code_end && ((d.target - base_addr) & 3ULL) == 0ULL) {
          const uint32_t t_idx = static_cast<uint32_t>((d.target - base_addr) / 4ULL);
          st = store.add_edge(ir_handle, blk, insn_to_block[t_idx]);
          if (st != HEX_OK) return fail_cleanup(st);
        }
      } else if (d.kind == HEX_ARM64_KIND_CONDBR) {
        if (d.has_target && d.target >= base_addr && d.target < code_end && ((d.target - base_addr) & 3ULL) == 0ULL) {
          const uint32_t t_idx = static_cast<uint32_t>((d.target - base_addr) / 4ULL);
          st = store.add_edge(ir_handle, blk, insn_to_block[t_idx]);
          if (st != HEX_OK) return fail_cleanup(st);
        }
        if (i + 1u < word_count) {
          st = store.add_edge(ir_handle, blk, insn_to_block[i + 1u]);
          if (st != HEX_OK) return fail_cleanup(st);
        }
      } else if (d.kind != HEX_ARM64_KIND_RET) {
        if (i + 1u < word_count) {
          st = store.add_edge(ir_handle, blk, insn_to_block[i + 1u]);
          if (st != HEX_OK) return fail_cleanup(st);
        }
      }
    }
  }

  // Stage 4: CFG + Dominator Tree + Dominator Frontier + Cytron SSA.
  st = store.run_cfg_and_ssa(ir_handle);
  if (st != HEX_OK) return fail_cleanup(st);

  // Stage 5: Fixed-point SSA IR Optimization.
  uint32_t opt_changed = 0u;
  st = hex_decomp_optimize_ir(ir_handle, 16u, &opt_changed);
  if (st != HEX_OK && st != HEX_ERR_RESOURCE_LIMIT) return fail_cleanup(st);

  const hex::ir::IrFunction* fn = store.lookup(ir_handle);
  if (!fn || fn->header.block_count != num_blocks) {
    return fail_cleanup(HEX_ERR_INTERNAL);
  }
  if (js_parity_mode) {
    // Reject folded constants in [100..999] where c_emitter decimal vs JS hex would diverge.
    for (size_t idx = 0u; idx < fn->insts.size(); ++idx) {
      const hex::ir::IrInst& ins = fn->insts[idx];
      if (ins.op == HEX_IR_OP_CONST && !is_js_parity_imm_exact(ins.imm64_or_sym)) {
        return fallback_to_specialized(ir_handle);
      }
    }
  }

  // Stage 6: Natural Loop Analysis via loop_engine (uses cfg_engine internally).
  HexLoopResult loop_res{};
  st = hex_loop_analyze_arena(
      g_scratch_arena,
      num_blocks,
      fn->succ_off.data(),
      fn->succ_dst.empty() ? nullptr : fn->succ_dst.data(),
      static_cast<int32_t>(fn->header.entry_block),
      nullptr,
      nullptr,
      &loop_res);
  if (st != HEX_OK) return fail_cleanup(st);

  // Stage 7: Bridge Resident IR + LoopResult into CEmitFunctionView (on g_scratch_arena)
  // and emit C text + linemap into the physically isolated g_emit_arena.
  uint32_t entry_param_count = 0u;
  for (size_t v = 0u; v < fn->values.size(); ++v) {
    const hex::ir::IrValueDef& vd = fn->values[v];
    if (vd.kind == HEX_IR_VAL_ENTRY && vd.var_id < 8u && ((parity.rbw_arg_mask & (1u << vd.var_id)) != 0u)) {
      ++entry_param_count;
    }
  }

  const size_t total_emit_insts = fn->insts.size() + entry_param_count;
  CEmitInst* emit_insts = g_scratch_arena.alloc<CEmitInst>(total_emit_insts > 0u ? total_emit_insts : 1u);
  uint32_t* emit_block_off = g_scratch_arena.alloc<uint32_t>(num_blocks + 1u);
  uint32_t* loop_headers_u32 = loop_res.num_loops > 0u
      ? g_scratch_arena.alloc<uint32_t>(loop_res.num_loops)
      : nullptr;
  uint32_t* succ_dst_u32 = !fn->succ_dst.empty()
      ? g_scratch_arena.alloc<uint32_t>(fn->succ_dst.size())
      : nullptr;
  if (!emit_insts || !emit_block_off ||
      (loop_res.num_loops > 0u && !loop_headers_u32) ||
      (!fn->succ_dst.empty() && !succ_dst_u32)) {
    return fail_cleanup(HEX_ERR_OOM);
  }
  for (size_t e = 0u; e < fn->succ_dst.size(); ++e) {
    succ_dst_u32[e] = static_cast<uint32_t>(fn->succ_dst[e]);
  }
  for (uint32_t l = 0u; l < loop_res.num_loops; ++l) {
    loop_headers_u32[l] = static_cast<uint32_t>(loop_res.loop_header[l]);
  }

  uint32_t emit_cursor = 0u;
  for (uint32_t b = 0u; b < num_blocks; ++b) {
    emit_block_off[b] = emit_cursor;
    if (b == fn->header.entry_block) {
      for (size_t v = 0u; v < fn->values.size(); ++v) {
        const hex::ir::IrValueDef& vd = fn->values[v];
        if (vd.kind == HEX_IR_VAL_ENTRY && vd.var_id < 8u && ((parity.rbw_arg_mask & (1u << vd.var_id)) != 0u)) {
          CEmitInst pi{};
          pi.op = CEMIT_IR_PARAM;
          pi.flags = 0u;
          pi.width = 64u;
          pi.dst = vd.ssa_value_id;
          pi.src0 = CEMIT_IR_NO_VAL;
          pi.src1 = CEMIT_IR_NO_VAL;
          pi.src2 = CEMIT_IR_NO_VAL;
          pi.imm = vd.var_id;
          pi.addr = block_addrs[b];
          emit_insts[emit_cursor++] = pi;
        }
      }
    }

    const uint32_t ib = fn->block_inst_off[b];
    const uint32_t ie = fn->block_inst_off[b + 1u];
    for (uint32_t idx = ib; idx < ie; ++idx) {
      const uint32_t iid = fn->block_inst_ids[idx];
      const hex::ir::IrInst& ins = fn->insts[iid];
      const uint32_t ssa_dst = fn->inst_ssa_dst[iid];
      const uint32_t ssa_a0 = fn->inst_ssa_arg0[iid];
      const uint32_t ssa_a1 = fn->inst_ssa_arg1[iid];
      const uint32_t ssa_a2 = fn->inst_ssa_arg2[iid];
      const uint16_t width = (ins.flags & HEX_IR_FLAG_WIDTH32) ? 32u : 64u;
      const uint64_t va = (iid < ir_inst_addrs.size()) ? ir_inst_addrs[iid] : block_addrs[b];

      CEmitInst ei{};
      ei.width = width;
      ei.dst = (ssa_dst == hex::ir::kNone) ? CEMIT_IR_NO_VAL : ssa_dst;
      ei.src0 = (ssa_a0 == hex::ir::kNone) ? CEMIT_IR_NO_VAL : ssa_a0;
      ei.src1 = (ssa_a1 == hex::ir::kNone) ? CEMIT_IR_NO_VAL : ssa_a1;
      ei.src2 = (ssa_a2 == hex::ir::kNone) ? CEMIT_IR_NO_VAL : ssa_a2;
      ei.imm = ins.imm64_or_sym;
      ei.addr = va;

      switch (ins.op) {
        case HEX_IR_OP_NOP:
          ei.op = CEMIT_IR_NOP;
          ei.flags = CEMIT_IR_FLAG_DEAD;
          break;
        case HEX_IR_OP_CONST:
          ei.op = CEMIT_IR_CONST;
          ei.flags = 0u;
          break;
        case HEX_IR_OP_MOV:
          ei.op = CEMIT_IR_COPY;
          ei.flags = 0u;
          break;
        case HEX_IR_OP_BIN: {
          const uint16_t sub = static_cast<uint16_t>(ins.flags & HEX_IR_SUBOP_MASK);
          if (sub == HEX_IR_BIN_ASR || sub == HEX_IR_BIN_UREM) {
            return fallback_to_specialized(ir_handle);
          }
          ei.op = CEMIT_IR_BINOP;
          ei.flags = map_bin_subop(ins.flags);
          break;
        }
        case HEX_IR_OP_UN: {
          const uint16_t sub = static_cast<uint16_t>(ins.flags & HEX_IR_SUBOP_MASK);
          if (sub == HEX_IR_UN_SEXT32) {
            return fallback_to_specialized(ir_handle);
          }
          ei.op = CEMIT_IR_UNOP;
          ei.flags = map_un_subop(ins.flags);
          break;
        }
        case HEX_IR_OP_CMP:
          ei.op = CEMIT_IR_CMP;
          ei.flags = CEMIT_CMP_NE;
          break;
        case HEX_IR_OP_BR:
          ei.op = CEMIT_IR_BRANCH;
          ei.flags = 0u;
          break;
        case HEX_IR_OP_CBR:
          ei.op = CEMIT_IR_CONDBR;
          ei.flags = static_cast<uint8_t>(ins.flags & CEMIT_IR_FLAG_SUBOP_MASK);
          break;
        case HEX_IR_OP_RET:
          ei.op = CEMIT_IR_RET;
          ei.flags = 0u;
          break;
        default:
          ei.op = CEMIT_IR_NOP;
          ei.flags = CEMIT_IR_FLAG_DEAD;
          break;
      }
      emit_insts[emit_cursor++] = ei;
    }
  }
  emit_block_off[num_blocks] = emit_cursor;

  CEmitFunctionView view{};
  view.func_name = func_name_utf8;
  view.func_name_len = func_name_len;
  view.entry_va = base_addr;
  view.num_params = parity.inferred_param_count;
  view.ret_width = parity.ret_width;
  view.ret_is_signed = (parity.ret_width == 32u) ? 1u : 0u;
  view.num_blocks = num_blocks;
  view.entry_block = fn->header.entry_block;
  view.block_inst_off = emit_block_off;
  view.block_addr = block_addrs;
  view.insts = emit_insts;
  view.num_insts = emit_cursor;
  view.succ_off = fn->succ_off.data();
  view.succ_dst = succ_dst_u32;
  view.idom = loop_res.cfg.idom;
  view.ipdom = loop_res.cfg.pdom_idom;
  view.num_loops = loop_res.num_loops;
  view.loop_header = loop_headers_u32;
  view.loop_parent = loop_res.loop_parent;
  view.node_innermost_loop = loop_res.node_innermost_loop;

  // c_emitter runs against g_emit_arena (physically separate from g_scratch_arena).
  hex::decompiler::bind_arena(&g_emit_arena);
  const int32_t emit_rc = hex_decomp_emit_c_ex(&view, kMaxEmitBytes, emit_flags);
  store.release(ir_handle);
  ir_handle = 0u;

  if (emit_rc != HEX_OK) {
    clear_last_output();
    return static_cast<HexStatus>(emit_rc);
  }

  g_last_text = hex_decomp_get_text_ptr();
  g_last_text_len = hex_decomp_get_text_len();
  g_last_linemap = hex_decomp_get_linemap_ptr();
  g_last_linemap_count = hex_decomp_get_linemap_count();
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_engine_decompile_get_text_ptr")
const char* hex_engine_decompile_get_text_ptr(void) {
  return g_last_text;
}

HEX_WASM_EXPORT("hex_engine_decompile_get_text_len")
uint32_t hex_engine_decompile_get_text_len(void) {
  return g_last_text_len;
}

HEX_WASM_EXPORT("hex_engine_decompile_get_linemap_ptr")
const HexLineMapEntry* hex_engine_decompile_get_linemap_ptr(void) {
  return g_last_linemap;
}

HEX_WASM_EXPORT("hex_engine_decompile_get_linemap_count")
uint32_t hex_engine_decompile_get_linemap_count(void) {
  return g_last_linemap_count;
}

HEX_WASM_EXPORT("hex_engine_decompile_get_loss_flags")
uint32_t hex_engine_decompile_get_loss_flags(void) {
  return g_last_loss_flags;
}

HEX_WASM_EXPORT("hex_engine_decompile_set_rodata_slice")
void hex_engine_decompile_set_rodata_slice(
    uint32_t va_lo, uint32_t va_hi, const uint8_t* ptr, uint32_t len) {
#if defined(HEX_HAS_DECOMP_PASSES)
  const uint64_t va = static_cast<uint64_t>(va_lo) | (static_cast<uint64_t>(va_hi) << 32);
  hex::decompiler::passes::set_general_rodata_slice(va, ptr, len);
#else
  (void)va_lo;
  (void)va_hi;
  (void)ptr;
  (void)len;
#endif
}

HEX_WASM_EXPORT("hex_engine_decompile_clear_rodata_slice")
void hex_engine_decompile_clear_rodata_slice(void) {
#if defined(HEX_HAS_DECOMP_PASSES)
  hex::decompiler::passes::clear_general_rodata_slice();
#endif
}

}  // extern "C"
