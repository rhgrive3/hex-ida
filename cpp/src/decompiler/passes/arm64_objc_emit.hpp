#ifndef HEX_DECOMPILER_PASSES_ARM64_OBJC_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_OBJC_EMIT_HPP

#include <stddef.h>
#include <stdint.h>
#include <hex_core/hex_core.hpp>
#include "decompiler/c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Freestanding arm64_32 Objective-C method 0-diff C emitter pass.
// Handles generalized Objective-C methods (-[...] / +[...]) with stack-frame
// self/_cmd spilling and ivar getter, ivar setter, or constant-return bodies.
// Fails closed with HEX_ERR_UNSUPPORTED for non-ObjC names or any unrecognized pattern.
HexStatus try_emit_arm64_objc(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_OBJC_EMIT_HPP
