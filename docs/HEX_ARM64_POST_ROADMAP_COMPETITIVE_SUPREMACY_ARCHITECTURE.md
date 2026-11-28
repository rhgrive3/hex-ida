# HEX ARM64 Competitive Architecture

Last updated: 2026-11-28

## 1. Executive Summary

Hex is a browser-first, iPad-capable binary analysis and decompilation platform centered on ARM64 / ARM64e (with multi-architecture support for x86-64 and RISC-V64 across Mach-O, dyld shared cache, ELF, and PE). As of 2026-11-28, the architecture combines:

1. **Unified C++/WASM Core Engine (`wasm/hex_engine.wasm`, ~1.1 MiB)** implementing the 10-track v6 architecture with 1:1 JS fallbacks and `js/core/wasm-telemetry.js` observability.
2. **ARM64 / ARM64e & Apple Ecosystem Specialization**: full ARM64e PAC (`PAC*`/`AUT*`/`XPAC*`) + `LDUR`/`STUR` semantics, PAC ObjC emitter, ObjC/Swift5 metadata WASM scanners, 7-pack HSIG1 hub (6 Rizin `sigdb` packs + 1 `ios-arm64-macho` pack, `6,022` total signatures across all 7 packs, achieving `24/24` function matching against `ios_arm64_crypto.o`), Ghidra `mac_osx.gdt` + Network/Metal/CoreGraphics iOS TIL packs, Ghidra `windows_vs12_64.gdt` Win32/Win64 full TIL (`13,176` definitions), and a unified 4-ABI WASM symbol demangler (Apple Swift 5, LLVM Itanium C++, Rust, and LLVM `MicrosoftDemangle`).
3. **Bounded Concrete ARM64 Micro-Emulator (`MiniArm64Emu`)**: C++/WASM-parity GPR core (arithmetic/logical/shifts/flags, `LDR`/`STR`, `LDUR`/`STUR`, and PAC/BTI hints) plus JS-side extensions for SIMD&FP `LDR`/`STR` (`B`/`H`/`S`/`D`/`Q`), `LDUR`/`STUR`, literal loads (`S`/`D`/`Q`), and NEON `EOR`/`ADD`/`DUP`.
4. **Clean View & Verified Decompiler Pipeline**: deterministic transform budgets (`fast`/`deep` profiles), optional solver/e-graph proof-backed Phase 8 scalar projection (`decompileWithProof`), and the Clean View post-emit pass (typedef prelude hiding, dead stack-spill elision, ARM64 callee-saved prologue/epilogue folding, consecutive duplicate `semantic-v2` `__asm` collapsing, and Apple ObjC/Swift ARC & `_objc_msgSend$` folding).
5. **Scope-Qualified, Proof-Carrying Analysis (SCPA)**: bounded native producers, proof DAGs, typed interprocedural flow, indirect dispatch bounds, portable offline replay (`tools/portable-checker/`), and fail-closed `UNKNOWN` preservation.

## 2. Unified v6 C++/WASM Engine & Workbench

| Subsystem | Primary Modules | Current Implementation |
| --- | --- | --- |
| Unified WASM engine | `wasm/hex_engine.wasm`, `js/core/hex-engine-wasm.js`, `js/core/wasm-telemetry.js` | Compiled C++/WASM engine with streaming `> 1 MiB` SHA-256, adaptive bisection, callgraph `memory.grow`, uncapped chunk `maxOut`, multi-section const scanning, xref linking, and chained/relative32 vtable scanners. |
| Binary analysis WASM scanners | `js/analysis/wasm-abi-scanner.js`, `wasm-behavior-classifier.js`, `wasm-callgraph-metrics.js`, `wasm-const-table-scanner.js`, `wasm-func-fingerprint.js`, `wasm-jumptable-scanner.js`, `wasm-objc-swift-scanner.js`, `wasm-rmw-scanner.js`, `wasm-vtable-scanner.js`, `wasm-x86-64-rmw-scanner.js`, `wasm-xref-linker.js` | Native-speed scanning over ARM64 and x86-64 code/metadata with JS parity fallbacks. |
| Type & TIL infrastructure | `js/analysis/types/core/` (`c11-header-parser.js`, `til-binary-compiler.js`, `til-pack-manager.js`, `til-lite-resolver.js`, `sdk-batch-compiler.js`, `sdk-fingerprint.js`, `sdk-matcher.js`, `struct-recovery.js`, `dirty-cone.js`, `type-transaction.js`, `tbd-parser.js`, `swiftinterface-parser.js`) | Transactional type system with dirty-cone invalidation, C11 header / `.tbd` / `.swiftinterface` parsing, Ghidra `mac_osx.gdt` Apple Darwin/iOS/macOS full TIL, Network/Metal/CoreGraphics iOS TIL, and Ghidra `windows_vs12_64.gdt` Win32/Win64 full TIL (`13,176` definitions) built via `npm run hubs:build`. |
| 4-ABI Symbol Demangler | `js/analysis/types/core/symbol-demangler.js`, `third_party/llvm-demangle/`, `third_party/swift-demangle/` | WASM-first demangler with 1:1 JS fallback covering Apple Swift 5 (`$s`/`_$s`/`_T0`), LLVM Itanium C++ (`_Z`), Rust (`_R`/legacy), and LLVM `MicrosoftDemangle` MSVC C++ (`?`). |
| Signatures & Delta Porting | `js/analysis/signature/` (`hex-sig-extractor.js`, `hex-sig-index.js`, `hex-sig-pack.js`, `hexsig-hub-loader.js`, `delta-porting.js`), `scripts/import-rizin-sigdb.mjs` | `HSIG1` pack encoder/matcher with ARM64 PC-relative masking, 7-pack hub (6 Rizin `sigdb` packs + 1 `ios-arm64-macho` pack; `6,022` total signatures across all 7 packs, `24/24` function matching on `ios_arm64_crypto.o`), and cross-version annotation porting. |
| Deobfuscation & Slicing | `js/analysis/deobf/cff-unflatten.js`, `js/analysis/deobf/mba-simplifier.js`, `js/analysis/slicing/cross-func-slice.js`, `js/analysis/cxx/stl-pattern-recognizer.js` | Control-flow flattening (CFF) unflattening, MBA DAG simplification (including strict proof flag), cross-function slicing, and C++ STL pattern recognition. |
| Storage & UI Workbench | `js/cache/hexdb/`, `js/cache/delta-session.js`, `js/ui/v6-workbench-bridge.js`, `js/ui/export-interop.js` | IndexedDB/memory `HEX-DB`, versioned `.hexdb` delta session persistence, C header / DWARF / JSON interop export, Omnibox exact jump, GraphView i18n, cancellable decompile, and full V6 Workbench wiring. |

## 3. ARM64 / ARM64e Specialization & Micro-Emulation

### 3.1 ARM64e PAC & Apple Mach-O / dyld Shared Cache

- **Loader (`js/binary/macho-core.js`, `macho-dyld.js`, `dyld-shared-cache-core.js`, `dyld-shared-cache-slide-v5.js`)**: Multi-slice Mach-O, `MH_OBJECT` relocatable object recovery (including `0x0`), dyld shared cache slide info v2/v5, chained fixups with ARM64e PAC key/diversity/address-diversity metadata preservation, `LC_FUNCTION_STARTS`, and `LC_CODE_SIGNATURE` inspection.
- **MachineEffects & Semantics (`js/targets/architecture/arm64/`, `js/targets/architecture/arm64e/`)**: Exact A64 integer, flag, control-flow, memory, FP, SIMD, system, BTI, and ARM64e PAC (`PAC*`/`AUT*`/`XPAC*`, `PACM`, `PAuth_LR`) semantics verified against the fail-closed LLVM 18 oracle (`docs/machine-effects-prerequisites.md`).
- **ObjC & Swift Metadata (`js/metadata/objc.js`, `js/metadata/swift.js`, `js/objc.js`, `js/swift.js`, `js/analysis/apple/`)**: Class/category/protocol/selector/IMP recovery, bare ObjC selector fallback, ARM64e PAC ObjC emitter, Swift witness tables, vtables, generic contexts, and capture descriptors.

### 3.2 `MiniArm64Emu` (`js/targets/architecture/arm64/mini-arm64-emu.js`)

Bounded concrete micro-emulator pairing the C++/WASM GPR core (`cpp/src/analysis/mini_arm64_emu.cpp`) with JS-side SIMD&FP/NEON extensions:

- Deterministic step/page/depth limits (`HEX_EMU_STOP_REASON`: `RETURN_OK`, `STEP_LIMIT`, `PAGE_LIMIT`, `EXT_CALL`, `SYSCALL_SYS`, `UNINIT_READ`, `UNSUPPORTED_INSN`, `CALL_DEPTH`), `4 KiB` page protection (`R`/`W`/`X`/`BSS`), and built-in `memcpy`/`memset`/`memmove`/`strlen` stubs.
- **C++/WASM parity scope (`cpp/src/analysis/mini_arm64_emu.cpp`)**: GPR arithmetic/logical/shift/bitfield/conditional/branch instructions, GPR `LDR`/`STR` (unsigned, pre/post-index, literal), GPR `LDUR`/`STUR` (including sign-extending `LDURSB`/`LDURSH`), and NOP/PAC/BTI hints.
- **JS-side extensions (`js/targets/architecture/arm64/mini-arm64-emu.js`)**: SIMD&FP `LDR`/`STR` (`B`/`H`/`S`/`D`/`Q`, unsigned and pre/post-index), SIMD&FP `LDUR`/`STUR` (`B`/`H`/`S`/`D`/`Q`), SIMD&FP literal loads (`S`/`D`/`Q`), and NEON `EOR` (`8B`/`16B`), `ADD` (`16B`), and `DUP` (`16B`).

## 4. Decompiler, Clean View & Proof-Carrying Optimization

- **Core Pipeline (`js/decompiler/pipeline.js`, `pipeline-core.js`, `semantic-core.js`, `c-output-closure.js`)**: Semantic IR v2 → CFG → SSA → MemorySSA → Phase 8 transforms → C AST → pretty-printer, governed by deterministic work limits and monotonic safety ceilings (`docs/DECOMPILER_BUDGETS.md`).
- **Clean View (`js/decompiler/clean-view.js`, `js/decompiler/apple-arc-swift-pass.js`)**: Pure, deterministic post-emit presentation pass enabled by default in the Pseudo-C tab:
  - Hides fixed-width primitive/`id` typedef preludes while keeping recovered `typedef struct`/`union`/`enum` declarations.
  - Conservatively elides dead stack-spill assignments and unused local declarations.
  - Folds ARM64 callee-saved register prologue/epilogue stack save/restore pairs (`x19..x30`, `fp`, `lr`, `d8..d15`).
  - Collapses consecutive duplicate `semantic-v2` `__asm(...)` lines.
  - Rewrites `_objc_msgSend$<sel>` and direct `objc_msgSend` calls to Objective-C message syntax, folds ObjC/Swift ARC retain/release boilerplate, and demangles inline 4-ABI symbols.
- **Explicit Solver-Backed Scalar Projection (`decompileWithProof`)**: Opt-in asynchronous e-graph / representation-rule / SMT verification with private `WeakMap` proof capabilities and frozen `generatorAudit` metadata (`docs/symbolic-proof-optimizer-v8.md`).

## 5. Scoped Analysis (SCPA) & Conditional Extensions

The scoped analysis subsystem (`js/analysis/`, `js/core/evidence/`, `js/runtime/`) enforces:

- **Scope-qualified judgments**: Every query binds `world`, `assumptions`, `snapshotId`, and `isCurrent()` checks; stale generations and cancelled signals fail closed before publication.
- **Native SCPA producers**: Proof DAG replay, typed range/alias kernels, object lifetime/subobject partitions, real-binary indirect dispatch tables/thunks, canonical ABI + MemorySSA typed flow queries, counted-loop fragment verification, and read-only retained `TraceProvider` async binding.
- **Conditional extensions**: Opt-in scalar loop induction (`L03`), bounded adaptive context refinement (`L06`), captured async event order (`L07`), detached portable replay (`L09`), and finite SVE/SME/memory-event models (`docs/SCPA_CONDITIONAL_ANALYSIS.md`, `docs/SCPA_CONDITIONAL_MODELS.md`, `docs/SCPA_FUNCTIONAL_ACCEPTANCE.md`).

## 6. Browser / iPad & Security Boundaries

- **Memory discipline**: Streaming `ByteSource` + bounded LRU `CachedByteSource`, lazy streaming SHA-256 (`> 1 MiB` WASM streaming), `Transferable` `ArrayBuffer` worker transfers, and epoch-based stale-result rejection (`docs/universal-platform.md`).
- **Process-boundary timeouts**: In-process APIs (`AnalysisQueryAPI.decompile`, UI cancellation, `profile-fresh.mjs`) are explicitly **best-effort (cooperative)**; hard per-function deadlines are enforced via parent `SIGKILL` supervision in multi-process benchmark runners (`docs/FUNCTION_TIMEOUT_SEMANTICS.md`).
- **Trust boundaries**: Benchmark inputs are never executed as OS processes; worker network fetch is disabled during benchmark runs; optional OpenJev advisory calls (`docs/design/openjev-boundary-referee.md`) never confer proof or verdict authority.

## 7. Verification, Gate E & Remaining External Acceptance

- **Local & CI verification**: `npm run check` (or `npm run check:parallel`), `npm run scpa:test`, `npm run effects:test`, `npm run benchmark:public:test`, `npm run userscript:test`, and `node tools/validation/public-benchmark/run-gate-e-live.mjs` (evaluated fail-closed by `gate-e-scorecard.mjs`). See [`PUBLIC_COMPETITOR_BENCHMARK.md`](PUBLIC_COMPETITOR_BENCHMARK.md).
- **Explicitly open external gates**: Native licensed competitor runs (IDA/Ghidra native-best adapters), Same-Astra T0–T3 comparative trials, multi-toolchain compiler twins, physical iPad/WebKit performance/memory telemetry, and blind human readability studies remain external acceptance requirements and are never substituted by local synthetic or public-artifact runs.
