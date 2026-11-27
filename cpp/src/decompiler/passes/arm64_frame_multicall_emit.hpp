#ifndef HEX_DECOMPILER_PASSES_ARM64_FRAME_MULTICALL_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_FRAME_MULTICALL_EMIT_HPP

#include <stdint.h>
#include <hex_core/hex_core.hpp>
#include "../c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Attempt to lift and emit 0-diff C code for ARM64 frame + multi-call (`bl`) +
// stack frame buffer functions.
// Returns HEX_OK on exact match, HEX_ERR_UNSUPPORTED (fail-closed) otherwise,
// with full emit_arena rollback on every error path.
HexStatus try_emit_arm64_frame_multicall(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_FRAME_MULTICALL_EMIT_HPP
