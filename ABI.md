# hex-ida Unified C++/WASM Engine C ABI Specification

- **ABI Version**: `HEX_ENGINE_ABI_VERSION = 0x00010000` (`hex_engine_version()`, `cpp/src/engine_runtime.hpp`)
- **Distribution Artifact**: `wasm/hex_engine.wasm` & `js/core/hex-engine-wasm.js` (Base64-embedded freestanding `hex_engine.wasm`, **1,129,165 bytes**, **61 freestanding C++20 units** (58 core/target/analysis units + 3 demangler units), **214 exports** [1 linear memory + 213 functions], **0 external imports**, **9.3125 MiB [149 pages]** initial linear memory, built via `node scripts/build-wasm.mjs` using `clang++ --target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory` + `wasm-opt -O3 --enable-bulk-memory`, zero Emscripten)
- **Host Boundary**: `js/ui/`, `js/ai/`, `js/auth/`, `js/userscript/` MUST access WASM exclusively through `js/core/hex-engine-bridge.js`. `js/core/hex-engine-wasm.js` is a bridge-internal implementation detail and MUST NOT be imported directly from Host layers (enforced by `tests/performance/wave6-release-gates.test.mjs`).

## 1. Error Codes (`HexStatus`, `int32_t`)

- `0` (`HEX_OK`): Success
- `1` (`HEX_ERR_INVALID_ARG`): Invalid pointer, size, or argument
- `2` (`HEX_ERR_OOM`): Fixed arena capacity exhausted (fail-closed)
- `3` (`HEX_ERR_RESOURCE_LIMIT`): Budget or safety limit exceeded (fail-closed)
- `4` (`HEX_ERR_UNSUPPORTED`): Unsupported architecture, instruction, or parity gate fallback
- `5` (`HEX_ERR_INTERNAL`): Internal invariant or unexpected state error (fail-closed)

## 2. Exported C ABI Surface (`HEX_WASM_EXPORT`)

### Unified Runtime & Runtime Profile (`cpp/src/engine_runtime.hpp`, `cpp/include/hex_runtime_profile.hpp`)
- `hex_engine_init() -> HexStatus`
- `hex_engine_version() -> uint32_t` (`0x00010000`)
- `hex_engine_scratch_alloc(uint32_t bytes) -> void*`
- `hex_engine_scratch_reset() -> void`
- `hex_engine_decompile_arm64(const uint32_t* words, uint32_t word_count, uint64_t base_addr, const char* func_name_utf8, uint32_t func_name_len, uint32_t emit_flags) -> HexStatus`
- `hex_engine_decompile_get_text_ptr`, `hex_engine_decompile_get_text_len`, `hex_engine_decompile_get_linemap_ptr`, `hex_engine_decompile_get_linemap_count`
- `hex_set_runtime_profile`, `hex_get_runtime_profile`, `hex_get_runtime_limits`

### Core: Identity, Byte Search & SHA-256 (`cpp/src/core/`)
- Identity: `hex_identity_reset`, `hex_identity_alloc`, `hex_identity_fnv64_bytes`, `hex_identity_digest_utf8`, `hex_identity_digest_bytes`, `hex_identity_stable_stringify`, `hex_identity_merge_origins`, `hex_identity_merge_origins_sorted`
- Byte Search: `hex_byte_search_find`
- SHA-256: `hex_sha256_compress_blocks`, `hex_sha256_hash`

### Binary: Image Store, String Scanner, ELF Symbols & Crypto/Entropy (`cpp/src/binary/`)
- Image Store: `hex_image_alloc_input`, `hex_image_open`, `hex_image_close`, `hex_image_get_info`, `hex_image_section_count`, `hex_image_get_section`, `hex_image_scratch_alloc`, `hex_image_scratch_reset`
- String Scanner & ELF Symbols: `hex_string_scan_ranges`, `hex_elf_extract_symbols`
- Crypto & Entropy: `hex_shannon_entropy_x1000`, `hex_scan_high_entropy_windows`, `hex_crypto_scan_buffer`

### CFG, Loops & Deobfuscation (`cpp/src/cfg/`, `cpp/src/decompiler/mba_simplifier.cpp`, `cpp/src/analysis/{mini_arm64_emu,deobf_eval_arm64}.cpp`)
- CFG & Loops: `get_heap_base`, `cfg_reset`, `cfg_alloc`, `cfg_analyze`, `cfg_get_result_ptr`, `hex_loop_reset`, `hex_loop_alloc`, `hex_loop_analyze`, `hex_loop_get_ptr`
- Deobfuscation & MiniArm64Emu: `hex_deobf_scratch_ptr`, `hex_deobf_scratch_size`, `hex_cff_unflatten`, `hex_mba_eval`, `hex_mba_verify_equiv`, `hex_mba_simplify`, `hex_arm64_emu_init`, `hex_arm64_emu_step`, `hex_arm64_emu_run`, `hex_deobf_eval_opaque_branch`, `hex_deobf_resolve_indirect_target`

### Target Decoders & Target Decompilers (`cpp/src/targets/`)
- ARM64 / ARM64e Decoder (24 exports): `hex_arm64_classify_word`, `hex_arm64_kind_capability`, `hex_arm64_is_decompiler_supported`, `hex_arm64_kind_name`, `hex_arm64_atomic_op_name`, `hex_arm64_ordering_name`, `hex_arm64_mem_mode_name`, `hex_arm64_decode_word`, `hex_arm64_decode_batch`, `hex_arm64_decode_batch_pcs`, `hex_arm64_classify_batch`, `hex_arm64_branch_imm26`, `hex_arm64_cond_branch_target`, `hex_arm64_literal_target`, `hex_arm64_word_target`, `hex_arm64_pc_rel_target`, `hex_arm64_paired_offset`, `hex_arm64_memory_access`, `hex_arm64_compare_immediate`, `hex_arm64_is_stp_to_sp`, `hex_arm64_is_sub_sp`, `hex_arm64_looks_like_prologue`, `hex_arm64_looks_like_end`, `hex_arm64_is_pac_word`
- x86_64 Decoder (6 exports): `hex_x86_64_decode_one`, `hex_x86_64_decode_batch`, `hex_x86_64_insn_length`, `hex_x86_64_kind_decomp_cap`, `hex_x86_64_is_decompiler_supported`, `hex_x86_64_kind_name`
- x86_64 Decompiler & Semantic Emitter (10 exports): `hex_engine_decompile_x86_64`, `hex_x86_64_decomp_get_text_ptr`, `hex_x86_64_decomp_get_text_len`, `hex_x86_64_decomp_get_linemap_ptr`, `hex_x86_64_decomp_get_linemap_count`, `hex_engine_decompile_x86_64_semantic`, `hex_x86_64_semantic_get_text_ptr`, `hex_x86_64_semantic_get_text_len`, `hex_x86_64_semantic_get_linemap_ptr`, `hex_x86_64_semantic_get_linemap_count`
- RISC-V 64-bit Decoder (5 exports): `hex_riscv64_insn_length`, `hex_riscv64_decode_one`, `hex_riscv64_decode_batch`, `hex_riscv64_is_decompiler_supported`, `hex_riscv64_kind_name`

### Resident IR, Optimizer, Region Decompiler & C Emitter (`cpp/src/semantics/`, `cpp/src/decompiler/`)
- Resident IR: `hex_ir_create`, `hex_ir_release`, `hex_ir_add_block`, `hex_ir_add_edge`, `hex_ir_add_inst`, `hex_ir_run_cfg_and_ssa`, `hex_ir_get_stats`
- Optimizer & C Emitter: `hex_decomp_optimize_ir`, `hex_decomp_reset`, `hex_decomp_emit_c`, `hex_decomp_emit_c_ex`, `hex_decomp_get_text_ptr`, `hex_decomp_get_text_len`, `hex_decomp_get_linemap_ptr`, `hex_decomp_get_linemap_count`
- Region Decompiler / Stack Web / Asm Island / Typed Emit: `hex_region_extract`, `hex_stack_web_split`, `hex_asm_island_classify`, `hex_asm_island_register`, `hex_typed_emit_format`

### Analysis, Metadata, Type System (TIL), Signatures (HEX-SIG) & 4-ABI Demangler (`cpp/src/analysis/`)
- Scanners & Metrics: `hex_scan_arm64_rmw_fields`, `hex_scan_x86_64_rmw_fields`, `hex_scan_vtables`, `hex_scan_vtables_ext`, `hex_scan_arm64_jumptables`, `hex_infer_arm64_abi`, `hex_scan_const_tables`, `hex_bitfield_struct_scan`, `hex_sparse_switch_detect`, `hex_lsda_parse`, `hex_scan_objc_ptr_list`, `hex_scan_swift5_rel32_list`, `hex_scan_swift5_fieldmd`
- Fingerprinting, Callgraph & Classification: `hex_fingerprint_arm64_func`, `hex_simhash_hamming64`, `hex_match_fingerprints`, `hex_callgraph_scratch_bytes`, `hex_analyze_callgraph`, `hex_analyze_callgraph_scc_order`, `hex_propagate_sig_window`, `hex_sig_prop_run`, `hex_classify_arm64_behavior`, `hex_classify_x86_64_behavior`
- Type Arena & TIL Engine: `hex_type_arena_init`, `hex_type_arena_slot_cap`, `hex_type_arena_slot_used`, `hex_type_arena_slot_info`, `hex_type_arena_slot_ptr`, `hex_type_arena_alloc_slot`, `hex_type_arena_bump_alloc`, `hex_type_arena_reset_slot`, `hex_type_arena_reset_volatile`, `hex_type_arena_reset_all`, `hex_til_mount`, `hex_til_load`, `hex_til_mount_pack`, `hex_til_unmount_pack`, `hex_til_purge_packs`, `hex_til_lookup_symbol`, `hex_til_lookup`, `hex_til_lookup_selector`, `hex_til_lookup_type`, `hex_til_get_type`, `hex_til_get_type_name`, `hex_til_stats`
- HEX-SIG Engine: `hex_hexsig_mount`, `hex_hexsig_normalize_arm64`, `hex_hexsig_normalize_x64`, `hex_hexsig_match_fn`
- 4-ABI Symbol Demangler (Itanium C++, Rust, Apple Swift 5, Microsoft MSVC): `hex_demangle_in_buf_ptr`, `hex_demangle_in_buf_cap`, `hex_demangle_out_buf_ptr`, `hex_demangle_out_buf_cap`, `hex_demangle_out_len_ptr`, `hex_demangle_detect_kind`, `hex_demangle_symbol`

### Manual Recovery (`cpp/src/recovery/`)
- Recovery Scratch & Reset: `hex_recovery_scratch_ptr`, `hex_recovery_scratch_size`, `hex_manual_recovery_reset_all`
- Manual Segments: `hex_manual_seg_reset`, `hex_manual_seg_add`, `hex_manual_seg_add_entry`, `hex_manual_seg_load_entries`, `hex_manual_seg_remove`, `hex_manual_seg_lookup`, `hex_manual_seg_get_at`, `hex_manual_seg_count`, `hex_manual_seg_capacity`
- Function Chunks: `hex_func_chunk_reset`, `hex_func_chunk_add`, `hex_func_chunk_remove`, `hex_func_chunk_find_owner`, `hex_func_chunk_list_for_fn`, `hex_func_chunk_merge_cfg_ranges`, `hex_func_chunk_count`, `hex_func_chunk_capacity`
- Custom ABI, Stack Overrides & Shifted Pointers: `hex_custom_abi_{reset,set,get,count,capacity}`, `hex_stack_override_{reset,set,get,get_ex,count,capacity}`, `hex_shifted_ptr_{reset,set,get,count,capacity}`

## 3. Memory Ownership & Isolation

- Physically isolated fixed-capacity arenas (`init_fixed()`, `allow_wasm_grow_ = false`) eliminate dynamic heap allocation (`malloc`/`free`) and JS GC churn:
  - `g_image_arena`: binary image store
  - `g_ir_arena`: resident IR store
  - `g_scratch_arena`: transient call inputs and per-pass working buffers (RAII `ArenaScope`)
  - `g_emit_arena`: dedicated C emitter output and linemap buffer (survives subsequent `hex_engine_scratch_alloc` calls)
  - Dedicated subsystem arenas/buffers for `TypeArena`, `TIL`, `HEX-SIG`, `Recovery`, `Deobf`, and `Demangle`
- Whenever any WASM call may touch linear memory, JS callers re-acquire `DataView`/`TypedArray` views from `exports.memory.buffer` before reading output pointers.
