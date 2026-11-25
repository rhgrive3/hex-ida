#ifndef HEX_DECOMPILER_PASSES_ARM64_UDF_EMIT_HPP
#define HEX_DECOMPILER_PASSES_ARM64_UDF_EMIT_HPP

#include <stddef.h>
#include <stdint.h>

#include <hex_core/hex_core.hpp>
#include "../c_emitter.hpp"

namespace hex {
namespace decompiler {
namespace passes {

// Freestanding ARM64 lifter & C emitter for functions consisting of:
//   [0]: 64-bit ADD/SUB immediate on x0 (`add/sub x0, x0, #imm`, sh[1] == 0)
//   [1]: canonical RET (`0xd65f03c0`)
//   [2..N-1]: one or more trailing UDF padding instructions (`(w & 0xffff0000u) == 0`)
// Emits 0-diff JS-parity C output and exact HexLineMapEntry records.
// Fails closed with HEX_ERR_UNSUPPORTED for any unrecognized pattern or word_count > 64.
HexStatus try_emit_arm64_udf_tail(
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

#endif  // HEX_DECOMPILER_PASSES_ARM64_UDF_EMIT_HPP
