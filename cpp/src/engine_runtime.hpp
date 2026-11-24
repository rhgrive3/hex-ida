#ifndef HEX_ENGINE_RUNTIME_HPP
#define HEX_ENGINE_RUNTIME_HPP

#include <stddef.h>
#include <stdint.h>

#include "../include/hex_abi.hpp"
#include "../include/hex_core/hex_core.hpp"
#include "binary/image_store.hpp"
#include "cfg/cfg_engine.hpp"
#include "cfg/loop_engine.hpp"
#include "core/identity_engine.hpp"
#include "semantics/resident_ir.hpp"
#include "decompiler/ir_optimizer.hpp"
#include "decompiler/c_emitter.hpp"
#include "targets/arm64_decode.hpp"

#ifdef __cplusplus
extern "C" {
#endif

static const uint32_t HEX_ENGINE_ABI_VERSION = 0x00010000u;
static const uint32_t HEX_ENGINE_IMAGE_ARENA_BYTES = 4u * 1024u * 1024u;
static const uint32_t HEX_ENGINE_IR_ARENA_BYTES = 4u * 1024u * 1024u;
static const uint32_t HEX_ENGINE_SCRATCH_ARENA_BYTES = 4u * 1024u * 1024u;
static const uint32_t HEX_ENGINE_MAX_DECOMP_WORDS = 16384u;

typedef struct HexEngineArenaStats {
  uint32_t image_used;
  uint32_t image_cap;
  uint32_t ir_used;
  uint32_t ir_cap;
  uint32_t scratch_used;
  uint32_t scratch_cap;
} HexEngineArenaStats;

HEX_WASM_EXPORT("hex_engine_init")
HexStatus hex_engine_init(void);

HEX_WASM_EXPORT("hex_engine_version")
uint32_t hex_engine_version(void);

HEX_WASM_EXPORT("hex_engine_scratch_alloc")
void* hex_engine_scratch_alloc(uint32_t bytes);

HEX_WASM_EXPORT("hex_engine_scratch_reset")
void hex_engine_scratch_reset(void);

HEX_WASM_EXPORT("hex_engine_decompile_arm64")
HexStatus hex_engine_decompile_arm64(
    const uint32_t* words,
    uint32_t word_count,
    uint64_t base_addr,
    const char* func_name_utf8,
    uint32_t func_name_len,
    uint32_t emit_flags);

HEX_WASM_EXPORT("hex_engine_decompile_get_text_ptr")
const char* hex_engine_decompile_get_text_ptr(void);

HEX_WASM_EXPORT("hex_engine_decompile_get_text_len")
uint32_t hex_engine_decompile_get_text_len(void);

HEX_WASM_EXPORT("hex_engine_decompile_get_linemap_ptr")
const HexLineMapEntry* hex_engine_decompile_get_linemap_ptr(void);

HEX_WASM_EXPORT("hex_engine_decompile_get_linemap_count")
uint32_t hex_engine_decompile_get_linemap_count(void);

#ifdef __cplusplus
}  // extern "C"

namespace hex {
namespace runtime {

// Native/test helper: bind fixed external buffers to all 3 arenas for boundary & OOM testing.
HexStatus bind_external_arenas(
    uint8_t* image_buf,
    size_t image_cap,
    uint8_t* ir_buf,
    size_t ir_cap,
    uint8_t* scratch_buf,
    size_t scratch_cap);

HexEngineArenaStats get_arena_stats();

}  // namespace runtime
}  // namespace hex
#endif

#endif  // HEX_ENGINE_RUNTIME_HPP
