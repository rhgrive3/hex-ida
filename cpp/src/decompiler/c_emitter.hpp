#ifndef HEX_DECOMPILER_C_EMITTER_HPP
#define HEX_DECOMPILER_C_EMITTER_HPP

#include <stddef.h>
#include <stdint.h>
#include <hex_core/hex_core.hpp>

#ifdef __cplusplus
extern "C" {
#endif

// Sentinel for missing SSA value / operand.
static const uint32_t CEMIT_IR_NO_VAL = 0xFFFFFFFFu;

// Emit flags for hex_decomp_emit_c_ex.
static const uint32_t HEX_EMIT_FLAG_NONE = 0u;
static const uint32_t HEX_EMIT_FLAG_JS_PARITY = 1u;

// C-Emitter POD IR opcodes (namespaced to avoid collision with resident_ir.hpp).
typedef enum CEmitIrOp {
  CEMIT_IR_NOP = 0,
  CEMIT_IR_CONST = 1,
  CEMIT_IR_COPY = 2,
  CEMIT_IR_BINOP = 3,
  CEMIT_IR_UNOP = 4,
  CEMIT_IR_LOAD = 5,
  CEMIT_IR_STORE = 6,
  CEMIT_IR_CMP = 7,
  CEMIT_IR_CALL = 8,
  CEMIT_IR_RET = 9,
  CEMIT_IR_BRANCH = 10,
  CEMIT_IR_CONDBR = 11,
  CEMIT_IR_PHI = 12,
  CEMIT_IR_PARAM = 13,
  CEMIT_IR_SELECT = 14,
  CEMIT_IR_CAST = 15,
} CEmitIrOp;

// Binary sub-opcodes (stored in CEmitInst::flags & 0x0fu).
typedef enum CEmitBinOp {
  CEMIT_BIN_ADD = 0,
  CEMIT_BIN_SUB = 1,
  CEMIT_BIN_MUL = 2,
  CEMIT_BIN_SDIV = 3,
  CEMIT_BIN_UDIV = 4,
  CEMIT_BIN_SREM = 5,
  CEMIT_BIN_AND = 6,
  CEMIT_BIN_OR = 7,
  CEMIT_BIN_XOR = 8,
  CEMIT_BIN_SHL = 9,
  CEMIT_BIN_SHR = 10,
} CEmitBinOp;

// Unary sub-opcodes (stored in CEmitInst::flags & 0x0fu).
typedef enum CEmitUnOp {
  CEMIT_UN_NEG = 0,
  CEMIT_UN_NOT = 1,
  CEMIT_UN_LNOT = 2,
  CEMIT_UN_ZEXT = 3,
} CEmitUnOp;

// Comparison sub-opcodes (stored in CEmitInst::flags & 0x0fu).
typedef enum CEmitCmpOp {
  CEMIT_CMP_EQ = 0,
  CEMIT_CMP_NE = 1,
  CEMIT_CMP_SLT = 2,
  CEMIT_CMP_SLE = 3,
  CEMIT_CMP_SGT = 4,
  CEMIT_CMP_SGE = 5,
  CEMIT_CMP_ULT = 6,
  CEMIT_CMP_ULE = 7,
  CEMIT_CMP_UGT = 8,
  CEMIT_CMP_UGE = 9,
} CEmitCmpOp;

// High flag bits on CEmitInst::flags (low 4 bits reserved for sub-opcode).
static const uint8_t CEMIT_IR_FLAG_SUBOP_MASK = 0x0Fu;
static const uint8_t CEMIT_IR_FLAG_DEAD = 0x80u;
static const uint8_t CEMIT_IR_FLAG_SIGNED = 0x40u;

// Backward-compatible aliases for standalone c_emitter callers (e.g. test_c_emitter_native.cpp).
#ifndef HEX_SEMANTICS_RESIDENT_IR_HPP
static const uint32_t HEX_IR_NO_VAL = CEMIT_IR_NO_VAL;
typedef CEmitIrOp HexIrOp;
static const uint8_t HEX_IR_NOP = CEMIT_IR_NOP;
static const uint8_t HEX_IR_CONST = CEMIT_IR_CONST;
static const uint8_t HEX_IR_COPY = CEMIT_IR_COPY;
static const uint8_t HEX_IR_BINOP = CEMIT_IR_BINOP;
static const uint8_t HEX_IR_UNOP = CEMIT_IR_UNOP;
static const uint8_t HEX_IR_LOAD = CEMIT_IR_LOAD;
static const uint8_t HEX_IR_STORE = CEMIT_IR_STORE;
static const uint8_t HEX_IR_CMP = CEMIT_IR_CMP;
static const uint8_t HEX_IR_CALL = CEMIT_IR_CALL;
static const uint8_t HEX_IR_RET = CEMIT_IR_RET;
static const uint8_t HEX_IR_BRANCH = CEMIT_IR_BRANCH;
static const uint8_t HEX_IR_CONDBR = CEMIT_IR_CONDBR;
static const uint8_t HEX_IR_PHI = CEMIT_IR_PHI;
static const uint8_t HEX_IR_PARAM = CEMIT_IR_PARAM;
static const uint8_t HEX_IR_SELECT = CEMIT_IR_SELECT;
static const uint8_t HEX_IR_CAST = CEMIT_IR_CAST;

typedef CEmitBinOp HexIrBinOp;
static const uint8_t HEX_IR_BIN_ADD = CEMIT_BIN_ADD;
static const uint8_t HEX_IR_BIN_SUB = CEMIT_BIN_SUB;
static const uint8_t HEX_IR_BIN_MUL = CEMIT_BIN_MUL;
static const uint8_t HEX_IR_BIN_SDIV = CEMIT_BIN_SDIV;
static const uint8_t HEX_IR_BIN_UDIV = CEMIT_BIN_UDIV;
static const uint8_t HEX_IR_BIN_SREM = CEMIT_BIN_SREM;
static const uint8_t HEX_IR_BIN_AND = CEMIT_BIN_AND;
static const uint8_t HEX_IR_BIN_OR = CEMIT_BIN_OR;
static const uint8_t HEX_IR_BIN_XOR = CEMIT_BIN_XOR;
static const uint8_t HEX_IR_BIN_SHL = CEMIT_BIN_SHL;
static const uint8_t HEX_IR_BIN_SHR = CEMIT_BIN_SHR;

typedef CEmitUnOp HexIrUnOp;
static const uint8_t HEX_IR_UN_NEG = CEMIT_UN_NEG;
static const uint8_t HEX_IR_UN_NOT = CEMIT_UN_NOT;
static const uint8_t HEX_IR_UN_LNOT = CEMIT_UN_LNOT;
static const uint8_t HEX_IR_UN_ZEXT = CEMIT_UN_ZEXT;

typedef CEmitCmpOp HexIrCmpOp;
static const uint8_t HEX_IR_CMP_EQ = CEMIT_CMP_EQ;
static const uint8_t HEX_IR_CMP_NE = CEMIT_CMP_NE;
static const uint8_t HEX_IR_CMP_SLT = CEMIT_CMP_SLT;
static const uint8_t HEX_IR_CMP_SLE = CEMIT_CMP_SLE;
static const uint8_t HEX_IR_CMP_SGT = CEMIT_CMP_SGT;
static const uint8_t HEX_IR_CMP_SGE = CEMIT_CMP_SGE;
static const uint8_t HEX_IR_CMP_ULT = CEMIT_CMP_ULT;
static const uint8_t HEX_IR_CMP_ULE = CEMIT_CMP_ULE;
static const uint8_t HEX_IR_CMP_UGT = CEMIT_CMP_UGT;
static const uint8_t HEX_IR_CMP_UGE = CEMIT_CMP_UGE;

static const uint8_t HEX_IR_FLAG_SUBOP_MASK = CEMIT_IR_FLAG_SUBOP_MASK;
static const uint8_t HEX_IR_FLAG_DEAD = CEMIT_IR_FLAG_DEAD;
static const uint8_t HEX_IR_FLAG_SIGNED = CEMIT_IR_FLAG_SIGNED;
#endif

// Compact POD instruction view (zero-copy compatible with Resident IR).
typedef struct CEmitInst {
  uint8_t op;
  uint8_t flags;
  uint16_t width;  // Bit width: 8, 16, 32, 64 (0 => default 64)
  uint32_t dst;
  uint32_t src0;
  uint32_t src1;
  uint32_t src2;
  uint64_t imm;
  uint64_t addr;
} CEmitInst;

// Zero-copy function input view bridging IrFunction + LoopResult to C emitter.
typedef struct CEmitFunctionView {
  const char* func_name;
  uint32_t func_name_len;
  uint64_t entry_va;
  uint32_t num_params;
  uint8_t ret_width;      // 0 = void, 8/16/32/64
  uint8_t ret_is_signed;  // 0 = unsigned, 1 = signed
  uint16_t reserved_;

  uint32_t num_blocks;
  uint32_t entry_block;
  const uint32_t* block_inst_off;  // length num_blocks + 1
  const uint64_t* block_addr;      // nullable; length num_blocks
  const CEmitInst* insts;
  uint32_t num_insts;

  const uint32_t* succ_off;  // length num_blocks + 1
  const uint32_t* succ_dst;  // successor block IDs

  const int32_t* idom;   // nullable; length num_blocks (-1 for entry/unreachable)
  const int32_t* ipdom;  // nullable; length num_blocks (-1 for exit/none)

  uint32_t num_loops;
  const uint32_t* loop_header;          // nullable; length num_loops
  const int32_t* loop_parent;           // nullable; length num_loops (-1 for outermost)
  const int32_t* node_innermost_loop;   // nullable; length num_blocks (-1 if outside loops)
} CEmitFunctionView;

// 1-based source line mapping entry.
typedef struct HexLineMapEntry {
  uint32_t line_no;   // 1-based line number in emitted C text
  uint32_t block_id;  // Origin basic block ID (source block for control transfers)
  uint64_t addr;      // Origin VA (source block / terminator VA)
} HexLineMapEntry;

// Public C ABI (exported via HEX_WASM_EXPORT).
HEX_WASM_EXPORT("hex_decomp_reset")
void hex_decomp_reset(void);

HEX_WASM_EXPORT("hex_decomp_emit_c")
int32_t hex_decomp_emit_c(const CEmitFunctionView* view, uint32_t max_bytes);

HEX_WASM_EXPORT("hex_decomp_emit_c_ex")
int32_t hex_decomp_emit_c_ex(const CEmitFunctionView* view,
                             uint32_t max_bytes,
                             uint32_t emit_flags);

HEX_WASM_EXPORT("hex_decomp_get_text_ptr")
const char* hex_decomp_get_text_ptr(void);

HEX_WASM_EXPORT("hex_decomp_get_text_len")
uint32_t hex_decomp_get_text_len(void);

HEX_WASM_EXPORT("hex_decomp_get_linemap_ptr")
const HexLineMapEntry* hex_decomp_get_linemap_ptr(void);

HEX_WASM_EXPORT("hex_decomp_get_linemap_count")
uint32_t hex_decomp_get_linemap_count(void);

#ifdef __cplusplus
}  // extern "C"

namespace hex {
namespace decompiler {

// Bind an external scratch arena (used by Wave 2 engine_runtime::bind_subsystems).
void bind_arena(hex::Arena* scratch_arena);

}  // namespace decompiler
}  // namespace hex
#endif

#endif  // HEX_DECOMPILER_C_EMITTER_HPP
