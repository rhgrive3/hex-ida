#ifndef HEX_DECOMPILER_PASSES_ARM64_SIMPLE_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_SIMPLE_EMIT_HPP

#include <stddef.h>
#include <stdint.h>
#include <hex_core/hex_core.hpp>
#include "decompiler/c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

HexStatus try_emit_arm64_simple(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_SIMPLE_EMIT_HPP
