#ifndef HEX_TARGETS_X86_64_SEMANTIC_EMIT_HPP
#define HEX_TARGETS_X86_64_SEMANTIC_EMIT_HPP

#include <stddef.h>
#include <stdint.h>

#include <hex_core/hex_core.hpp>
#include "decompiler/c_emitter.hpp"
#include "targets/x86_64_decode.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// Decompile x86_64 machine code using the semantic-v2 0-diff structured pass.
// abi_id: 0 = SysV AMD64, 1 = Microsoft x64.
// Fails closed with HEX_ERR_INVALID_ARG or HEX_ERR_UNSUPPORTED on unrecognized
// patterns, truncated encodings, or invalid arguments.
HEX_WASM_EXPORT("hex_engine_decompile_x86_64_semantic")
HexStatus hex_engine_decompile_x86_64_semantic(
    const uint8_t* bytes,
    uint32_t byte_len,
    uint64_t base_addr,
    uint32_t abi_id,
    uint32_t emit_flags);

HEX_WASM_EXPORT("hex_x86_64_semantic_get_text_ptr")
const char* hex_x86_64_semantic_get_text_ptr(void);

HEX_WASM_EXPORT("hex_x86_64_semantic_get_text_len")
uint32_t hex_x86_64_semantic_get_text_len(void);

HEX_WASM_EXPORT("hex_x86_64_semantic_get_linemap_ptr")
const HexLineMapEntry* hex_x86_64_semantic_get_linemap_ptr(void);

HEX_WASM_EXPORT("hex_x86_64_semantic_get_linemap_count")
uint32_t hex_x86_64_semantic_get_linemap_count(void);

#ifdef __cplusplus
}
#endif

#endif  // HEX_TARGETS_X86_64_SEMANTIC_EMIT_HPP
