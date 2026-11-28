# Hex Master Architecture Specification

> **Status:** Canonical target architecture specification  
> **Updated:** 2026-11-28  
> **Repository:** `rhgrive3/hex-ida`  
> **Primary product constraint:** Browser/iPad-first, universal binary analysis, beginner-to-expert, evidence-first  
> **Current capability truth:** [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), projected from `js/platform/capability-maturity.js` (and evidence-gated promotions in `js/platform/stage2-capability-maturity.js`)  
> **Research evidence:** [`SOURCES.md`](SOURCES.md)

## 1. Authority and source-of-truth order

Use the following order when documents disagree:

1. This specification (`docs/HEX_MASTER_ARCHITECTURE.md`).
2. Versioned public API and schema contracts (including [`../ABI.md`](../ABI.md) for the C++/WASM engine).
3. Current source code and automated tests, for what Hex actually implements today.
4. `js/platform/capability-maturity.js`, `js/platform/stage2-capability-maturity.js`, and [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), for graded capability claims.
5. [`ENGINEERING_PROCESS_GUARDRAILS.md`](ENGINEERING_PROCESS_GUARDRAILS.md) and [`MIGRATION_GUARDRAILS.md`](MIGRATION_GUARDRAILS.md), for process and compatibility boundaries.
6. [`SOURCES.md`](SOURCES.md), for durable external technical references.

## 2. Non-negotiable architectural invariants

1. **One semantic truth with inspectable provenance**: Disassembly, CFG, SSA/MemorySSA, decompiled C, Clean View, and AI projections derive from the same canonical semantic analysis with explicit source provenance.
2. **Explicit unknown and unsupported states**: Missing decoding, partial effects, budget exhaustion, or unsupported extensions remain explicit (`partial`, `unsupported`, `unavailable`, `unknown`) rather than silently succeeding.
3. **Conservative alias, call, control-flow, and memory reasoning**: Unknown memory locations never collapse to `MustAlias`; unknown stores act as proof barriers.
4. **Architecture, ABI, platform, and language separation**: Generic semantic middle-end, decompiler core (`js/decompiler/pipeline-core.js`), and UI layers must not hardcode decoder internals or raw instruction-text parsing.
5. **Parser/loader separation & bounded I/O**: Native binary loaders (`js/binary/`) operate over bounded range reads (`js/bytesource/`) and hostile-input budgets without assuming whole-file memory residency.
6. **Runtime evidence never silently overwrites static truth**: Dynamic observations (`js/runtime/`, `js/runtime-evidence/`, `js/trace/`) refine or contradict static candidates with explicit provenance without mutating immutable static facts.
7. **No semantic authority for model prose**: AI outputs (`js/ai/`) cannot mint verified facts; mutations require evidence-backed proposals, explicit approval tokens, and approval-gated `CapabilityExecutor` execution.
8. **One analysis truth for beginner and expert projections**: Guided workflows (Investigate / Pinpoint / Japanese explanations) and expert views (Code / GraphView / Clean View / V6 Workbench) share the same underlying analysis model.
9. **Graded capability rather than boolean support**: Maturity levels (`A0–A7`, `F0–F6`, `M0–M6`) are cumulative; no target skips an incomplete prerequisite.
10. **Demand-driven, cancellable, and budgeted execution**: Heavy analysis, decompilation, and scanning honor cancellation signals and resource budgets to keep browser and iPad Safari responsive.
11. **Separation of user/project facts from derived artifacts**: `.hexproj` exchange data (`js/project/`) stays distinct from rebuildable caches and derived artifacts (`js/cache/`).
12. **Performance work must not trade correctness for confidence**: C++/WASM acceleration (`wasm/hex_engine.wasm`) must maintain 0-diff parity with JS or fail closed with structured fallback telemetry (`js/core/wasm-telemetry.js`).

## 3. System architecture overview

```text
Browser / iPad Safari UI (js/ui/, js/viewer/, js/graphview*.js, index.html)
  │  Default route: /code (Code), with one-tap Investigate, GraphView, Omnibox, Clean View, V6 Workbench
  ▼
Host & Orchestration Layer (js/app.js, js/backend.js, js/worker.js, js/ai/, js/userscript/)
  │  Strict module boundary -> js/core/hex-engine-bridge.js + js/core/hex-engine-wasm.js
  ▼
Unified Analysis & Execution Engine
  ├── Freestanding C++20/WASM Engine (wasm/hex_engine.wasm, 62 units, 214 exports, 0 imports)
  │     ├── Core: Identity (FNV-1a/digest), Byte Search, Streaming SHA-256
  │     ├── Binary & Targets: ImageStore, String/ELF/Crypto Scanners, ARM64/ARM64e, x86_64, RISC-V64
  │     ├── CFG / IR / Decompiler: CFG, Loops, Resident IR/SSA, IR Optimizer, C Emitter, ARM64 Passes
  │     └── Analysis & Recovery: TypeArena, TIL, HEX-SIG, 4-ABI Demangler, MiniArm64Emu, CFF/MBA, Manual Recovery
  ├── Native & Managed Frontends
  │     ├── Native formats (js/binary/): Mach-O (Fat/Thin/MH_OBJECT/Chained Fixups), ELF, PE/PE32+, Raw
  │     ├── Target semantics (js/targets/, js/semantics/): MachineEffects, Semantic IR v2, CFG, SSA, MemorySSA
  │     └── Managed frontends (js/managed/): WebAssembly (wasm), Dalvik (dex), .NET (cil), JVM (jvm)
  ├── Middle-End, Decompiler & Verification
  │     ├── js/decompiler/: Shared pipeline, Clean View, Apple ARC/Swift pass, provenance & verification
  │     ├── js/analysis/: Types, TIL/HEX-SIG, ObjC/Swift5/C++/Go/Rust/IL2CPP metadata, Pinpoint, SCPA
  │     └── js/symbolic/: Bounded symbolic evaluator, e-graph, solver abstraction, taint
  └── Platform, Persistence & Extensions
        ├── js/platform/: capability-maturity.js, stage2-capability-maturity.js, plugin-api.js
        ├── js/project/ & js/collaboration/: .hexproj v1 exchange, local ChangeLog
        └── js/auth/ & worker-entry.js: Discord auth, Cloudflare Worker, Userscript host
```

## 4. Current implementation state

Exact support truth always comes from `js/platform/capability-maturity.js` and automated tests. High-level summary as of 2026-11-28:

1. **Semantic IR v2 is the production default**: `js/ir-core.js` is a compatibility facade; the legacy ARM64/AAPCS64 implementation remains only as an explicit compatibility/oracle path (`js/architecture/compat/ir-core-arm64-aapcs64-v1.js`).
2. **Multi-architecture vertical coverage**: `arm64`, `arm64e`, `x86_64`, and `riscv64` (RV64IMC/LP64) all reach implemented depth **A6** through the shared Semantic IR / CFG / SSA / Decompiler pipeline. Because full-ISA exact `MachineEffects` coverage is still partial, cumulative maturity in the base matrix remains **A1** (with evidence-gated Stage 2 promotion modeled in `js/platform/stage2-capability-maturity.js`).
3. **Multi-format & Managed coverage**: Native loaders cover Mach-O (F2 cumulative / F5 implemented), ELF (F2 / F4), and PE/PE32+ (F2 / F4). Managed frontends (`wasm`, `dex`, `cil`, `jvm`) reach **M5** (detect, metadata, VMEffects, CFG/SSA, types/interprocedural, decompiler), with M6 runtime debugging deferred.
4. **Unified C++20/WASM acceleration**: `wasm/hex_engine.wasm` accelerates identity hashing, binary/string/byte/SHA-256 scanning, multi-arch decoding, CFG/loops, ARM64 & x86_64 decompilation, TIL, HEX-SIG, 4-ABI demangling (Itanium/Rust/Swift5/MSVC), and `MiniArm64Emu` (including SIMD&FP and ARM64e PAC), with instant JS rollback via `HEX_ENGINE=js`.
5. **UI & Plugin contracts**: The canonical default route is **Code** (`/code`), paired with Clean View, i18n GraphView, Omnibox exact jump, cancellable decompile, and V6 Workbench wiring. Plugin contribution categories are defined in `js/platform/plugin-api.js`.

## 5. Maintenance rule

When implementation maturity or architecture boundaries change:

1. Update the owning source modules, schemas, and automated tests first.
2. Update `js/platform/capability-maturity.js` (and `js/platform/stage2-capability-maturity.js` if applicable) when capability truth changes.
3. Update [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) as the human projection of that machine-readable truth.
4. Update [`../ABI.md`](../ABI.md) whenever `wasm/hex_engine.wasm` exports or memory contracts change.
5. Keep this document synchronized with live code and remove superseded statements rather than accumulating historical logs here.
