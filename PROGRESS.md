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
