#pragma once

#include <stdint.h>
#include "hex_abi.hpp"
#include "hex_core/arena.hpp"
#include "decompiler/c_emitter.hpp"

namespace hex::decompiler::passes {

void set_general_scratch_arena(hex::Arena* scratch);
void set_general_rodata_slice(uint64_t va, const uint8_t* ptr, uint32_t len);
void clear_general_rodata_slice();
void reset_general_loss_flags();
void add_general_loss_flags(uint32_t flags);
uint32_t get_general_loss_flags();

// General freestanding C++20 ARM64 decompiler pass.
// Handles arbitrary real-world ARM64 functions (frames, globals, calls,
// branches, loops, memory, FP/SIMD, atomics, bitmasks, conditional selects)
// when specialized narrow 0-diff passes do not match.
HexStatus try_emit_arm64_general(
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
