#ifndef HEX_DECOMPILER_PASSES_ARM64_MEMORY_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_MEMORY_EMIT_HPP

#include <stddef.h>
#include <stdint.h>

#include <hex_core/hex_core.hpp>
#include "../c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// General-purpose freestanding ARM64 straight-line memory lifter & C emitter.
// Handles LDR/STR (unsigned offset 32/64-bit), LDP (signed offset 32/64-bit),
// local stack-frame store-to-load forwarding (SUB/ADD sp + [sp, #off]),
// MOVZ / MOV(register) / ADD(imm/reg), and terminal RET with 0-diff JS parity.
// Fails closed with HEX_ERR_UNSUPPORTED for any instruction or pattern outside
// the verified subset.
HexStatus try_emit_arm64_memory(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_MEMORY_EMIT_HPP
