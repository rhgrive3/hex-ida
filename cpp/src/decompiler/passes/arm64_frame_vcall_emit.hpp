#ifndef HEX_DECOMPILER_PASSES_ARM64_FRAME_VCALL_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_FRAME_VCALL_EMIT_HPP

#include <stddef.h>
#include <stdint.h>

#include <hex_core/hex_core.hpp>
#include "../c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Freestanding ARM64 frame prologue + vtable indirect call (BLR) + epilogue C emitter.
// Handles canonical 8-instruction direct-receiver vcall and 10-instruction
// receiver-swap + member-load vcall patterns with 0-diff JS parity.
// Strictly rejects PAC indirect calls (BLRAA/BLRAB/BLRAAZ/BLRABZ) and any
// unrecognized instruction/frame shape with HEX_ERR_UNSUPPORTED (fail-closed).
HexStatus try_emit_arm64_frame_vcall(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_FRAME_VCALL_EMIT_HPP
