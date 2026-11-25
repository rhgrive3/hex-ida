#ifndef HEX_DECOMPILER_PASSES_ARM64_BRANCH_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_BRANCH_EMIT_HPP

#include <stddef.h>
#include <stdint.h>

#include "../../../include/hex_core/hex_core.hpp"
#include "../c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Attempt to lift and emit structured C pseudocode + source map for
// canonical ARM64 2-way conditional branches (if/else) and counting while loops.
// Returns:
//   - HEX_OK on supported pattern match and successful emission.
//   - HEX_ERR_UNSUPPORTED when the instruction sequence does not match a
//     supported branch/loop pattern (fail-closed).
//   - HEX_ERR_INVALID_ARG on null/empty required arguments.
//   - HEX_ERR_OOM if emit_arena cannot satisfy the output allocation.
HexStatus try_emit_arm64_branch_loop(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_BRANCH_EMIT_HPP
