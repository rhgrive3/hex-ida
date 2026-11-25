# hex-ida C++/WASM Migration Progress Log

## Agent Governance Summary (Impl vs Independent Review Counts)
| Wave | Scope | Impl Agents (Parallel Worktrees) | Independent Review Agents | Status |
|---|---|---:|---:|---|
| Wave 0–3 (Prior) | Research, profiling, `hex_core`, L1–L8 initial modules & reviews | 9 | 5 | Rebuilt in persistent workspace |
| Rebuild Wave 1 (Persistent) | L0–L8 full freestanding C++20 rebuild with all prior review fixes baked in | 9 | — (verified in Wave 6) | **COMPLETE** (10/10 Native ASan/UBSan PASS) |
| Integration Wave 2 (Persistent) | `engine_runtime`, `build-wasm.mjs`, `controlflow.js`, `hex-engine-bridge.js`, `decompile.js`, E2E/x86_64/release-gate tests, fuzz suite, docs | 5 | 5 (R1) | **COMPLETE** |
| Wave 6 Review Fix & Re-Verification | 2-lane C++/JS fix for R1 findings (`g_emit_arena`, `IrStore::release`, strict ARM64 parity, `sourceMap`, symbol norm, `detectModelArchitecture`, `benchmark-final-e2e.mjs`, IIFE static imports, `c_emitter` left-assoc parens, `ABI.md`/`ROLLBACK.md` sync) | 2 | 4 (R2 re-verification across Perspectives 2–5) | **COMPLETE** |

## Verification & Quality Gates (Final)
- **Unified WASM Artifact**: `js/core/hex-engine-wasm.js` (`hex_engine.wasm` = **218,119 bytes**, 10 freestanding C++20 units, `clang++ --target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory` + `wasm-opt -O3 --enable-bulk-memory`, **0 Emscripten**)
- **Native ASan/UBSan (`-Wall -Wextra -Werror`)**: **12/12 suites PASS** (including `test_fuzz_robustness_native`: 2,840 corrupt/truncated/mutated binaries + 5,000 random functions + 1,200 `engine_runtime`/`c_emitter` scratch-isolation cases — 0 crash / 0 UB / 0 OOB / 0 leak)
- **Node Differential & Parity Suites**:
  - `tests/performance/e2e-decompile-differential.test.mjs`: **4/4 PASS** (13 real multi-arch binaries + 6 corrupt/mutant + ORR/FMOV/MNEG/SMULL/MOVN/edge-case regressions + `HEX_ENGINE=js` + `WebAssembly.validate=false`, **0-diff** on `pseudocode`, `lines`, `sourceMap`, mandatory `>=1` WASM telemetry)
  - `tests/performance/wave2-cfg-wasm-parity.test.mjs`: **1/1 PASS**
  - `tests/performance/wave5-x86_64-decode-parity.test.mjs`: **2/2 PASS** (76/76 real x86_64 insns + truncated `CALL rel32` fail-closed)
  - `tests/performance/wave6-release-gates.test.mjs`: **3/3 PASS**
- **Static & Packaging Gates**:
  - `npm run lint`: **PASS** (`5833 files ok`)
  - `npm run module-boundaries:test`: **PASS** (Host layers `js/{ui,ai,auth,userscript}/` have 0 direct internal engine imports)
  - `npm run userscript:build`: **PASS** (tiny loader `14,614 bytes`, protected runtime `19,469,655 -> 5,631,580 bytes`; auto-bumped version files reverted cleanly)
  - Pre-existing baseline failures separated in `tests/baseline-failures.json` (4 items verified on unmodified `origin/main`).

## Final E2E Benchmark (`node --expose-gc scripts/benchmark-final-e2e.mjs --rounds=2 --wasm7-iters=20`)
- **Full Corpus (13 Real Binaries × 43 Functions)**:
  - `js`: **12,130.55 ms** (median) | Peak RSS **412.38 MB** | Peak heapUsed **274.53 MB**
  - `wasm`: **11,311.31 ms** (**1.07x**) | Peak RSS **407.32 MB** | Peak heapUsed **270.45 MB**
  - `auto`: **11,466.15 ms** (**1.06x**; R2 independent run: **10,564.22 ms / 1.51x**) | Peak RSS **399.53 MB** | Peak heapUsed **269.56 MB**
- **WASM-Eligible Subset (3 Functions × 20 Iterations = 60 Decompilations, identical `sink: 12380`)**:
  - `js`: **3,731.90 ms** (186.595 ms/pass) | Peak RSS **362.99 MB** | Peak heapUsed **233.35 MB**
  - `wasm`: **4.07 ms** (0.204 ms/pass, **916.93x**) | Peak RSS **306.59 MB** | Peak heapUsed **59.39 MB**
  - `auto`: **3.39 ms** (0.170 ms/pass, **1,100.86x**; R2 independent run: **2.80 ms / 1,543.24x**) | Peak RSS **191.96 MB** | Peak heapUsed **57.80 MB**

## Uncovered Standalone Architectures (Automatic JS Fallback)
- `riscv64`, `arm64e`, `x86_64` decompilation, `x86` decompilation: automatically fall back per-function to JS with structured `decompile:non_arm64_arch:<arch>` telemetry.

## Wave 7 (Persistent 9-Parallel Expansion & 9-Parallel Independent Review)
- **Impl Agents**: 9 parallel worktrees (`E1` identity wire, `E2` binary wire, `E3` words.js wire, `E4` ARM64 decode gate expansion, `E5` ARM64 runtime lifting expansion, `E6` `x86_64_decomp` SysV/Win64 vertical slice, `E7` WASM memory/export optimization, `E8` `controlflow`/`benchmark` alignment, `E9` Wave 7 expanded parity suite)
- **Independent Review Agents**: 9 parallel non-overlapping reviewers (`R1`–`R9`, zero self-review)
- **Review Findings Resolved**: `js/core/identity/index.js` safe-integer 0-ULP gate (`1e-50`/`1.2345e-300`/`9.999999999999999e20`), `js/binary/index.js` `WASM_FORMAT_BY_ID` ELF/Mach-O ID alignment, `engine_runtime.cpp` `g_emit_arena` rebind before emit, `x86_64_decomp.cpp` length bounds guard, `arm64_decode.cpp` `s_bit==0` guard, `wave7-expanded-parity.test.mjs` mandatory `>=7` WASM decompile assert + `t.skip` removal, `ABI.md` 84-export sync.
- **Unified WASM Artifact**: `wasm/hex_engine.wasm` (**221,868 bytes**, 11 freestanding C++20 units, **84 exports**, **0 imports**, initial linear memory **13.75 MiB** <= 16 MiB)
- **Wave 7 Benchmark**: Full corpus WASM calls **101,567** (`identity`: 101,236, `cfg`: 156, `loops`: 156, `binary`: 13, `decompile`: 6 functions); `js` mode verified **0** WASM calls across all 7 domains; WASM-eligible 6-function subset **1,766.04x** speedup (`7,152.47 ms` -> `4.05 ms`, `heapUsed` `309.59 MB` -> `63.12 MB`).

## Wave 8 (Persistent 9-Parallel Full-Coverage & Memory Optimization)
- **Impl Agents**: 9 parallel worktrees (`F1` identity crossing threshold, `F2` initial linear memory halving 13.75 -> 6.50 MiB, `F3` `hex-engine-bridge.js` x86_64 decompile + Resident IR/Optimizer + RISC-V64 bridges, `F4` `arm64e` PAC `hex_arm64_is_pac_word` + fail-closed gate, `F5` ARM64 variable shifts `LSLV/LSRV/ASRV` & `MOV` alias lifting, `F6` freestanding `riscv64_decode` RV64I/M + RVC 16-bit, `F7` `build-wasm.mjs` 12-unit auto-link + `words.js` `hex_arm64_classify_batch` fast path, `F8` `controlflow.js` `options._engine` precedence + `benchmark-final-e2e.mjs` `sink`/`x86_64_decompile`, `F9` `wave8-full-coverage.test.mjs`)
- **Unified WASM Artifact**: `wasm/hex_engine.wasm` (**229,882 bytes**, 12 freestanding C++20 units, **90 exports**, **0 imports**, initial linear memory **6.50 MiB** <= 8 MiB)
- **Verification**: All **9 Node test suites (29/29 subtests)** PASS, all **13 Native ASan/UBSan suites** PASS, `npm run lint` (`5838 files ok`) PASS, `npm run module-boundaries:test` PASS, `npm run userscript:build` PASS (protected runtime `19,856,150 -> 5,774,625 bytes`).
- **Wave 8 Benchmark (`--expose-gc`)**: Full corpus `auto` **9,789.51 ms** (Peak RSS **397.12 MB** vs JS 415.52 MB, Peak heapUsed **261.09 MB** vs JS 286.10 MB, `sink: 20791` exact match across all modes, `js` mode **0** WASM calls); WASM-eligible 6-function subset **1,086.66x–1,125.75x** speedup (`6,259.19 ms` -> `5.56–5.76 ms`).

## Wave 9 (Persistent 9-Parallel Real-Binary Decompiler Expansion & 9-Parallel Independent Review)
- **Impl Agents**: 9 parallel worktrees (`G1` `arm64_simple_emit`, `G2` `arm64_memory_emit`, `G3` `arm64_branch_emit`, `G4` `arm64_fp_atomic_emit`, `G5` `arm64_call_emit`, `G6` `x86_64_decomp` frame/movzx/loop expansion, `G7` `build-wasm.mjs` `passes/*.cpp` auto-discovery + `-DHEX_HAS_DECOMP_PASSES=1`, `G8` `hex-engine-bridge.js` & `decompile.js` C++ pass delegation + `arm64_32`, `G9` `wave9-high-coverage.test.mjs`)
- **Independent Review Agents**: 9 parallel non-overlapping reviewers (`R1`–`R9`, zero self-review)
- **Review Findings Resolved**: `arm64_memory_emit.cpp` bit-23 `ADD`/`SUB` mask + 64-bit SP guard + post-store load invalidation + RAII arena rollback + struct field fail-closed, `arm64_branch_emit.cpp` 0-param `(void)` + `func_name` validation, `arm64_fp_atomic_emit.cpp` `EmitWriter::ensure()` unsigned-underflow OOB fix + `LDAXP` `rt2 != rt`, `arm64_call_emit.cpp` OOM/overflow arena rollback + SP-only pre-call stores, `arm64_simple_emit.cpp` `JS_PARITY` 64-bit & `>= 100` constant guard + bit-23 mask + `(nullptr, non_zero)` check, `js/decompile.js` `{ _engine: 'js' }` downstream mode propagation (0 leaked WASM calls), `wave9-high-coverage.test.mjs` `startLine` & non-empty `sourceMap` assertions, `ABI.md` / `PROGRESS.md` sync.
- **Unified WASM Artifact**: `wasm/hex_engine.wasm` (**309,942 bytes**, 17 freestanding C++20 units, **90 exports**, **0 imports**, initial linear memory **6.63 MiB** <= 8 MiB)
- **Coverage & Verification**: **26/40 ARM64/`arm64_32` real-binary functions** (up from 3 -> 6 -> 26, **4.3x** Wave 8) + **3/3 real x86_64 binaries** (`vertical-sysv-amd64.elf`, `vertical-microsoft-x64.exe`, `vertical-macho-x86_64.o`) verified 0-diff; all **7 Native ASan/UBSan suites** PASS, all **19/19 Node WASM/Wave subtests** PASS, `npm run lint` (`5839 files ok`) PASS, `npm run module-boundaries:test` PASS, `npm run userscript:build` PASS (protected runtime `20,281,957 -> 5,896,294 bytes`).
- **Wave 9 Benchmark (`--expose-gc`)**:
  - Full corpus (13 real binaries x 43 functions, `sink: 20791`): `js` **9,360.09 ms** (RSS 412.78 MB, heap 277.91 MB, 0 WASM calls) vs `auto` **6,857.91 ms** (**1.36x speedup**, RSS **392.40 MB**, heap **246.34 MB** [-31.6 MB], 26 WASM decompiles, 50,492 total WASM calls).
  - WASM-eligible 26-function subset (20x batch = 520 decompiles, `sink: 114820`): `js` **48,737.22 ms** (heap 716.34 MB) vs `auto` **11.13 ms** (**4,378.91x speedup**, RSS **220.58 MB**, heap **77.66 MB** [-89.2%]).

## Wave 10 (10-Parallel Frame+Call Full Expansion)
- **Impl Agents**: 10 parallel worktrees (`H1` `arm64_frame_bl_emit`, `H2` `arm64_frame_vcall_emit`, `H3` `arm64_frame_branch_bl_emit`, `H4` `arm64_frame_multicall_emit`, `H5` `arm64_frame_helpers.hpp`, `H6` `hex-engine-bridge.js` `blr` enablement + legacy `lines`/`sourceMap` parity, `H7` `arm64_call_emit` 16B align + `base_addr==0` polish, `H8` `x86_64_decomp` ALU flag-reset polish, `H9` Wave 9 R1–R5 Native ASan/UBSan regression tests, `H10` `wave10-frame-coverage.test.mjs`)
- **Unified WASM Artifact**: `wasm/hex_engine.wasm` (**356,508 bytes**, 21 freestanding C++20 units, **90 exports**, **0 imports**, initial linear memory **6.625 MiB** <= 8 MiB)
- **Coverage & Verification**: **34/40 ARM64/`arm64_32` real-binary functions** (including all 8 frame+call functions: `_greet`, `_apply_damage`, `_main`, `direct_call`, `arm64-threaded-mem::entry`, `arm64-dispatch-table::entry`, `virtual_call`, `_ZNK5Thing8interactEP4Base`) + **3/3 real x86_64 binaries** = **37/43 (86%)** verified 0-diff; **12/12 Native ASan/UBSan suites** PASS, **21/21 Node WASM/Wave subtests** PASS, `npm run lint` (`5840 files ok`) PASS, `npm run module-boundaries:test` PASS, `npm run userscript:build` PASS.
- **Wave 10 Benchmark (`--expose-gc`)**:
  - Full corpus (13 real binaries x 43 functions, `sink: 20791`): `js` **11,019.19 ms** (RSS 539.61 MB, heap 384.06 MB, 0 WASM calls) vs `auto` **3,844.13 ms** (**2.87x speedup**, RSS **373.35 MB** [-30.8%], heap **216.62 MB** [-43.6%], 34 WASM decompiles, 25,443 total WASM calls).
  - WASM-eligible 34-function subset (20x batch = 680 decompiles, `sink: 251060`): `js` **121,981.97 ms** (6,099.10 ms/pass, heap 338.64 MB) vs `auto` **16.28 ms** (0.814 ms/pass, **7,492.75x speedup**, RSS **232.04 MB** [-55.3%], heap **78.12 MB** [-76.9%]).

## Wave 11 (ARM64 40/40 = 100% WASM Coverage + Wave 10 Independent Review Fixes)
- **Impl Agents**: 4 parallel worktrees (`I1` `arm64_objc_emit`, `I2` `arm64_udf_emit`, `I3` `hex-engine-bridge.js` ObjC/pair-exclusive/legacy alignment, `I4` `wave11-arm64-100pct.test.mjs`)
- **Wave 10 Independent Review Agents**: 6 parallel non-overlapping reviewers (`R10-1`–`R10-6`, zero self-review)
- **Review Findings Resolved**: `arm64_frame_bl_emit.cpp` 16B SP alignment + unsigned `bl` VA wrapping + uppercase `>= 100` hex literal + `(nullptr, non_zero)` arg guard, `arm64_frame_branch_bl_emit.cpp` 8B/4B stack-slot overlap check, `arm64_frame_multicall_emit.cpp` `buf_off0 != buf_off1` disjointness + `JS_PARITY` `slot_a == 8u` legacy gate, `ABI.md` / `PROGRESS.md` exact `6.625 MiB` (106 pages) sync.
- **Unified WASM Artifact**: `wasm/hex_engine.wasm` (**380,190 bytes**, 23 freestanding C++20 units, **90 exports**, **0 imports**, initial linear memory **6.625 MiB** [106 pages] <= 8 MiB)
- **Coverage & Verification**: **40/40 ARM64/`arm64_32` real-binary functions (100.0%, zero ARM64 fallbacks!)** + **3/3 real x86_64 binaries** = **43/43** verified 0-diff; **14/14 Native ASan/UBSan suites** PASS, **23/23 Node WASM/Wave subtests** PASS, `npm run lint` (`5841 files ok`) PASS, `npm run module-boundaries:test` PASS, `npm run userscript:build` PASS (protected runtime `20,658,513 -> 5,966,995 bytes`).
- **Wave 11 Benchmark (`--expose-gc`)**:
  - Full corpus (13 real binaries x 43 functions, `sink: 20791`): `js` **9,060.71 ms** (RSS 437.32 MB, heap 303.77 MB, 0 WASM calls) vs `auto` **1,860.70 ms** (**4.87x speedup**, RSS **291.32 MB** [-33.4%], heap **156.68 MB** [-48.4%], **40/40** ARM64 WASM decompiles, 15,283 total WASM calls).
  - WASM-eligible 40-function subset (20x batch = 800 decompiles, `sink: 325340`): `js` **142,810.46 ms** (7,140.52 ms/pass, heap 428.66 MB) vs `auto` **21.05 ms** (1.053 ms/pass, **6,784.34x speedup**, RSS **220.39 MB** [-61.2%], heap **80.32 MB** [-81.3%]).

## Wave 12 (Full-Corpus 43/43 = 100% WASM — x86_64 `analyzeSemanticFunction` Fast Path + Wave 10/11 Review Fixes)
- **Impl & Fix Agents**: 5 parallel worktrees (`J1` `x86_64_semantic_emit` freestanding C++20 5-export ABI, `J2` `semantic-function.js` / `hex-engine-bridge.js` / `build-wasm.mjs` fast-path wiring, `J3` `wave12-x86-semantic-100pct.test.mjs`, `J4` Wave 10 R10-2 `arm64_frame_vcall_emit` fixes, `J5` Wave 10 R10-1/3/4 Native ASan/UBSan regression tests)
- **Wave 11 Independent Review Agents**: 5 parallel non-overlapping reviewers (`R11-1`–`R11-5`, zero self-review; 4/5 PASS, R11-1 `arm64_objc_emit.cpp` unsigned ADRP arithmetic + strict ObjC allowlist + 16B SP align + arg-clobber guard all resolved)
- **Unified WASM Artifact**: `wasm/hex_engine.wasm` (**416,462 bytes**, 24 freestanding C++20 units, **95 exports**, **0 imports**, initial linear memory **6.6875 MiB** [107 pages] <= 8 MiB)
- **Coverage & Verification**: **43/43 real-binary functions = 100% WASM** (**40/40 ARM64/`arm64_32`** + **3/3 x86_64 `analyzeSemanticFunction`** with **`fallbackCounts: {}`** — zero fallbacks!); **15/15 Native ASan/UBSan suites** PASS, **10/10 Node Wave 10–12 & E2E subtests** PASS, `npm run lint` (`5842 files ok`) PASS, `npm run module-boundaries:test` PASS, `npm run userscript:build` PASS.
- **Wave 12 Benchmark (`--expose-gc`)**:
  - Full corpus (13 real binaries x 43 functions, **zero fallbacks**): `js` **10,731.13 ms** (RSS 411.85 MB, heap 262.92 MB) vs `wasm` **27.99 ms** (**383.39x speedup**, heap **65.00 MB** [-75.3%]) / `auto` **35.80 ms** (**299.75x speedup**, RSS **201.41 MB** [-51.1%], heap **64.20 MB** [-75.6%]).
  - WASM-eligible 40-function subset (20x batch = 800 decompiles, `sink: 325340`): `js` **158,296.35 ms** (7,914.82 ms/pass, heap 732.64 MB) vs `auto` **21.23 ms** (1.062 ms/pass, **7,456.26x speedup**, RSS **248.04 MB** [-71.9%], heap **88.41 MB** [-87.9%]).
