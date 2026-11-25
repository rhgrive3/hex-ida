# hex-ida Unified C++/WASM Engine C ABI Specification

- **ABI Version**: `0x00010000` (`hex_engine_version()`)
- **Distribution Artifact**: `js/core/hex-engine-wasm.js` (Base64-embedded freestanding `hex_engine.wasm`, 429,411 bytes, 27 freestanding C++20 units, 99 exports, 0 imports, 6.6875 MiB (107 pages) initial linear memory, built via `node scripts/build-wasm.mjs` using `clang++ --target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory` + `wasm-opt -O3 --enable-bulk-memory`, zero Emscripten)
- **Host Boundary**: `js/ui/`, `js/ai/`, `js/auth/`, `js/userscript/` MUST NOT import internal engine modules directly; all WASM access goes through `js/core/hex-engine-bridge.js` and `js/core/hex-engine-wasm.js`.

## 1. Error Codes (`HexStatus`, `int32_t`)
- `0` (`HEX_OK`): Success
- `1` (`HEX_ERR_INVALID_ARG`): Invalid pointer, size, or argument
- `2` (`HEX_ERR_OOM`): Fixed arena capacity exhausted (fail-closed)
- `3` (`HEX_ERR_RESOURCE_LIMIT`): Budget or safety limit exceeded (fail-closed)
- `4` (`HEX_ERR_UNSUPPORTED`): Unsupported architecture, instruction, or parity gate fallback
- `5` (`HEX_ERR_PARSE`): Malformed binary or JSON input (fail-closed)
- `6` (`HEX_ERR_INVALID_HANDLE`): Stale/invalid generational handle (UAF prevented)

## 2. Exported C ABI Symbols (`HEX_WASM_EXPORT`)

### Unified Runtime (`cpp/src/engine_runtime.hpp`)
- `hex_engine_init() -> HexStatus`
- `hex_engine_version() -> uint32_t`
- `hex_engine_scratch_alloc(uint32_t bytes) -> void*`
- `hex_engine_scratch_reset() -> void`
- `hex_engine_decompile_arm64(const uint32_t* words, uint32_t word_count, uint64_t base_addr, const char* func_name_utf8, uint32_t func_name_len, uint32_t emit_flags) -> HexStatus`
- `hex_engine_decompile_get_text_ptr() -> const char*`
- `hex_engine_decompile_get_text_len() -> uint32_t`
- `hex_engine_decompile_get_linemap_ptr() -> const HexLineMapEntry*`
- `hex_engine_decompile_get_linemap_count() -> uint32_t`

### Identity (`cpp/src/core/identity_engine.hpp`)
- `hex_identity_reset`, `hex_identity_alloc`, `hex_identity_fnv64_bytes`, `hex_identity_digest_utf8`, `hex_identity_digest_bytes`, `hex_identity_stable_stringify`, `hex_identity_merge_origins`, `hex_identity_merge_origins_sorted`

### Binary Image Store & String Scanner (`cpp/src/binary/image_store.hpp`, `cpp/src/binary/string_scanner.hpp`)
- `hex_image_alloc_input`, `hex_image_open`, `hex_image_close`, `hex_image_get_info`, `hex_image_section_count`, `hex_image_get_section`, `hex_image_scratch_alloc`, `hex_image_scratch_reset`
- `hex_string_scan_ranges(const uint8_t* bytes, uint32_t byte_len, const HexStringScanRange* ranges, uint32_t range_count, uint32_t min_chars, uint32_t max_chars, uint32_t flags, uint32_t max_results, HexStringSpan* out_spans, uint32_t* out_count) -> HexStatus`

### Byte Search & SHA-256 (`cpp/src/core/byte_search.hpp`, `cpp/src/core/sha256.hpp`)
- `hex_byte_search_find(const uint8_t* haystack, uint32_t haystack_len, uint32_t from_offset, const uint8_t* pattern, const uint8_t* masks, uint32_t pattern_len, uint32_t flags, uint32_t* out_match_offset) -> HexStatus`
- `hex_sha256_compress_blocks(uint32_t* state, const uint8_t* blocks, uint32_t block_count) -> HexStatus`
- `hex_sha256_hash(const uint8_t* data, uint32_t len, uint8_t* out_digest32) -> HexStatus`

### CFG & Loop Analysis (`cpp/src/cfg/cfg_engine.hpp`, `loop_engine.hpp`)
- `get_heap_base`, `cfg_reset`, `cfg_alloc`, `cfg_analyze`, `cfg_get_result_ptr`
- `hex_loop_reset`, `hex_loop_alloc`, `hex_loop_analyze`, `hex_loop_get_ptr`

### Target Decoders & Target Decompilers (`cpp/src/targets/arm64_decode.hpp`, `x86_64_decode.hpp`, `x86_64_decomp.hpp`, `x86_64_semantic_emit.hpp`, `riscv64_decode.hpp`)
- ARM64 (24 exports): `hex_arm64_classify_word`, `hex_arm64_kind_capability`, `hex_arm64_is_decompiler_supported`, `hex_arm64_kind_name`, `hex_arm64_atomic_op_name`, `hex_arm64_ordering_name`, `hex_arm64_mem_mode_name`, `hex_arm64_decode_word`, `hex_arm64_decode_batch`, `hex_arm64_decode_batch_pcs`, `hex_arm64_classify_batch`, `hex_arm64_branch_imm26`, `hex_arm64_cond_branch_target`, `hex_arm64_literal_target`, `hex_arm64_word_target`, `hex_arm64_pc_rel_target`, `hex_arm64_paired_offset`, `hex_arm64_memory_access`, `hex_arm64_compare_immediate`, `hex_arm64_is_stp_to_sp`, `hex_arm64_is_sub_sp`, `hex_arm64_looks_like_prologue`, `hex_arm64_looks_like_end`, `hex_arm64_is_pac_word`
- x86_64 Semantic Decompiler (5 exports): `hex_engine_decompile_x86_64_semantic`, `hex_x86_64_semantic_get_text_ptr`, `hex_x86_64_semantic_get_text_len`, `hex_x86_64_semantic_get_linemap_ptr`, `hex_x86_64_semantic_get_linemap_count`
- x86_64 Decompiler (5 exports): `hex_engine_decompile_x86_64`, `hex_x86_64_decomp_get_text_ptr`, `hex_x86_64_decomp_get_text_len`, `hex_x86_64_decomp_get_linemap_ptr`, `hex_x86_64_decomp_get_linemap_count`
- RISC-V 64-bit Decoder (5 exports): `hex_riscv64_insn_length`, `hex_riscv64_decode_one`, `hex_riscv64_decode_batch`, `hex_riscv64_is_decompiler_supported`, `hex_riscv64_kind_name`
- x86_64 Decoder (6 exports): `hex_x86_64_decode_one`, `hex_x86_64_decode_batch`, `hex_x86_64_insn_length`, `hex_x86_64_kind_decomp_cap`, `hex_x86_64_is_decompiler_supported`, `hex_x86_64_kind_name`

### Resident IR, Optimizer & C Emitter (`cpp/src/semantics/resident_ir.hpp`, `cpp/src/decompiler/{ir_optimizer,c_emitter}.hpp`)
- `hex_ir_create`, `hex_ir_release`, `hex_ir_add_block`, `hex_ir_add_edge`, `hex_ir_add_inst`, `hex_ir_run_cfg_and_ssa`, `hex_ir_get_stats`
- `hex_decomp_optimize_ir`
- `hex_decomp_reset`, `hex_decomp_emit_c`, `hex_decomp_emit_c_ex`, `hex_decomp_get_text_ptr`, `hex_decomp_get_text_len`, `hex_decomp_get_linemap_ptr`, `hex_decomp_get_linemap_count`

## 3. Memory Ownership & Isolation
- 4 physically isolated fixed-capacity arenas (`init_fixed()`, `allow_wasm_grow_ = false`):
  - `g_image_arena` (binary image store)
  - `g_ir_arena` (resident IR store)
  - `g_scratch_arena` (transient call inputs & per-pass working buffers, protected by `ArenaScope`)
  - `g_emit_arena` (512 KiB dedicated C emitter output & linemap buffer; survives subsequent `hex_engine_scratch_alloc` calls)
