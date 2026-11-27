#ifndef HEX_TARGETS_X86_64_DECOMP_HPP
#define HEX_TARGETS_X86_64_DECOMP_HPP

#include "../../include/hex_core/hex_core.hpp"
#include "x86_64_decode.hpp"
#include "../decompiler/c_emitter.hpp"

#ifdef __cplusplus
extern "C" {
#endif

static const uint32_t HEX_X86_ABI_SYSV_AMD64 = 0u;
static const uint32_t HEX_X86_ABI_MICROSOFT_X64 = 1u;

HEX_WASM_EXPORT("hex_engine_decompile_x86_64")
HexStatus hex_engine_decompile_x86_64(
    const uint8_t* bytes,
    uint32_t byte_len,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t abi_id,
    uint32_t emit_flags);

HEX_WASM_EXPORT("hex_x86_64_decomp_get_text_ptr")
const char* hex_x86_64_decomp_get_text_ptr(void);

HEX_WASM_EXPORT("hex_x86_64_decomp_get_text_len")
uint32_t hex_x86_64_decomp_get_text_len(void);

HEX_WASM_EXPORT("hex_x86_64_decomp_get_linemap_ptr")
const HexLineMapEntry* hex_x86_64_decomp_get_linemap_ptr(void);

HEX_WASM_EXPORT("hex_x86_64_decomp_get_linemap_count")
uint32_t hex_x86_64_decomp_get_linemap_count(void);

#ifdef __cplusplus
}
#endif

#endif  // HEX_TARGETS_X86_64_DECOMP_HPP
