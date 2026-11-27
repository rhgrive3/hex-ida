#ifndef HEX_DECOMPILER_PASSES_ARM64_FRAME_BL_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_FRAME_BL_EMIT_HPP

#include <stddef.h>
#include <stdint.h>
#include <hex_core/hex_core.hpp>
#include "decompiler/c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Freestanding ARM64 frame + direct BL 0-diff C emitter pass.
// Recognizes generalized frame-wrapped direct-call patterns (ADRP+ADD+BL,
// register-forwarding BL+ADD, and stack-slot spill/reload around BL) and
// emits JS-parity C text and 1-indexed HexLineMapEntry records into emit_arena.
// Fails closed with HEX_ERR_UNSUPPORTED for any unrecognized instruction or shape.
HexStatus try_emit_arm64_frame_bl(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_FRAME_BL_EMIT_HPP
