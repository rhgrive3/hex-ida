#ifndef HEX_DECOMPILER_PASSES_ARM64_FP_ATOMIC_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_FP_ATOMIC_EMIT_HPP

#include <stdint.h>
#include <hex_core/hex_core.hpp>
#include "../c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Attempt to lift and emit 0-diff C code for supported ARM64 scalar FP,
// SIMD vector add, and atomic/exclusive instruction patterns.
// Returns HEX_OK on exact match, HEX_ERR_UNSUPPORTED (fail-closed) otherwise.
HexStatus try_emit_arm64_fp_atomic(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_FP_ATOMIC_EMIT_HPP
