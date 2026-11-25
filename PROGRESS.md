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
