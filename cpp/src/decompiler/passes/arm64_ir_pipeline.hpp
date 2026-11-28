#pragma once

#include <stdint.h>
#include "hex_abi.hpp"
#include "hex_core/arena.hpp"
#include "decompiler/c_emitter.hpp"

namespace hex::decompiler::passes {

void set_ir_pipeline_scratch_arena(hex::Arena* scratch);

// True ARM64 -> SSA-IR -> IR Optimizer -> CFG Structurizer -> C Emitter pipeline.
// Strictly fail-closed (returns HEX_ERR_UNSUPPORTED on any unsupported instruction,
// escaping stack pointer, general memory store, or irreducible CFG) so
// arm64_general_emit handles fallback safely.
HexStatus try_emit_arm64_ir_pipeline(
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
