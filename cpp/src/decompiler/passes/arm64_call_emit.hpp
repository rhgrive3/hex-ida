#ifndef HEX_DECOMPILER_PASSES_ARM64_CALL_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_CALL_EMIT_HPP

#include <stdint.h>

#include <hex_core/hex_core.hpp>

#include "decompiler/c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Generic ARM64 frame prologue + direct/indirect call (`bl`/`blr`) + epilogue C emitter.
//
// Supported patterns:
//   1. Dispatch-table indirect call (both JS_PARITY and non-parity modes, 0-diff with JS):
//      `stp x29, x30, [sp, #-N]!; movz xB, #table; and xI, x0, #mask; lsl xI, xI, #sh;
//       add xB, xB, xI; ldr xT, [xB]; blr xT; ldp x29, x30, [sp], #N; ret; nop+`
//   2. Standard frame + single direct/indirect call (non-parity mode; fails closed under
//      HEX_EMIT_FLAG_JS_PARITY where JS emits internal SSA-ID-dependent `call_<v.id>` names):
//      `stp x29, x30, [sp, #-N]!; mov x29, sp; ... bl/blr ...; ldp x29, x30, [sp], #N; ret`
//
// Returns HEX_ERR_UNSUPPORTED (fail-closed) for any instruction sequence outside these forms.
HexStatus try_emit_arm64_calls(
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
    uint32_t* out_linemap_count);

}  // namespace passes
}  // namespace decompiler
}  // namespace hex

#endif  // HEX_DECOMPILER_PASSES_ARM64_CALL_EMIT_HPP
