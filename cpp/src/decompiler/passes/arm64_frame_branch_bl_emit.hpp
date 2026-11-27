#ifndef HEX_DECOMPILER_PASSES_ARM64_FRAME_BRANCH_BL_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_FRAME_BRANCH_BL_EMIT_HPP

#include <stddef.h>
#include <stdint.h>

#include "../../../include/hex_core/hex_core.hpp"
#include "../c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Attempt to lift and emit 0-diff C pseudocode + source map for ARM64
// frame-setup + struct-field update + conditional clamp + bl + epilogue functions.
// Returns:
//   - HEX_OK on exact pattern match and emission.
//   - HEX_ERR_UNSUPPORTED (fail-closed) when words do not match.
//   - HEX_ERR_INVALID_ARG on invalid arguments.
//   - HEX_ERR_OOM if emit_arena cannot satisfy allocation.
HexStatus try_emit_arm64_frame_branch_bl(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_FRAME_BRANCH_BL_EMIT_HPP
