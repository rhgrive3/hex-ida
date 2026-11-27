#pragma once

#include <stdint.h>
#include "hex_abi.hpp"
#include "hex_core/arena.hpp"
#include "decompiler/c_emitter.hpp"

namespace hex::decompiler::passes {

HexStatus try_emit_arm64_global_thunk(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t emit_flags,
    hex::Arena& emit_arena,
    const char** out_text,
    uint32_t* out_text_len,
    const HexLineMapEntry** out_linemap,
    uint32_t* out_linemap_count);

}  // namespace hex::decompiler::passes
