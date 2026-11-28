# Hex Support Matrix

This document is a human projection of the machine-readable capability truth in `js/platform/capability-maturity.js` (with evidence-gated promotion rules in `js/platform/stage2-capability-maturity.js`).

Do not infer support from the presence of a parser, decoder, adapter, menu item, legacy analysis pipeline, or third-party engine. UI code should consume `supportTruthForImage()` and render it through `supportDisplayForTruth()` instead of inventing support labels.

Status values:

- **Supported** — this stage satisfies the Master Architecture contract for the stated target.
- **Partial** — useful implementation exists, but one or more required parts are incomplete.
- **Unsupported** — the implementation does not provide this stage.
- **Unavailable** — the implementation exists, but a required runtime dependency is unavailable.

`level` (`fullySatisfiedLevel`) is the highest **cumulative fully satisfied** maturity level. `implementedLevel` is the furthest stage with current implementation, including compatibility or partial implementation. A target never receives a higher maturity level by skipping an incomplete prerequisite.

## Architecture maturity

Projected from `currentSupportMatrix().architectures` in `js/platform/capability-maturity.js`:

| Architecture | Detect (`A0`) | Decode (`A1`) | Exact low-level effects (`A2`) | CFG + Semantic IR (`A3`) | SSA + MemorySSA (`A4`) | Types / interproc (`A5`) | Decompile (`A6`) | Runtime/debug/patch (`A7`) | Maturity level | Implemented through |
|---|---|---|---|---|---|---|---|---|---|---|
| `arm64` | Supported | Supported | **Partial** | Supported | Supported | Supported | Supported | Partial | **A1** | **A6** |
| `arm64e` | Supported | Supported | **Partial** | Partial | Partial | Partial | Partial | Partial | **A1** | **A6** |
| `x86_64` | Supported | Supported | **Partial** | Supported | Supported | **Partial** | Supported | Unsupported | **A1** | **A6** |
| `riscv64` | Supported | Supported | **Partial** | Supported | Supported | **Partial** | Supported | Unsupported | **A1** | **A6** |
| unknown | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | none | none |

Important limitations:

- `arm64`: Full Semantic IR/SSA/dataflow/decompiler capability is active (with `wasm/hex_engine.wasm` acceleration and legacy ARM64 oracle parity). Because exact `MachineEffects` (`A2`) coverage is proven for a measured instruction subset rather than the entire ISA, `A2` remains **Partial** and cumulative maturity stays **A1**.
- `arm64e`: Includes PAC decoding, `LDUR`/`STUR`, ObjC/Swift5 metadata, and `MiniArm64Emu` PAC support, while pointer-authentication data semantics and full-ISA exact `MachineEffects` remain **Partial**; cumulative maturity stays **A1**.
- `x86_64`: Mandatory 144-tuple compiler corpus proves exact `MachineEffects`, Semantic IR, CFG, SSA, MemorySSA, and shared decompilation (`implementedLevel: A6`). Full-ISA exactness and independent x86-64 type/interprocedural proof remain **Partial**, and `A7` is **Unsupported**; cumulative maturity stays **A1**.
- `riscv64`: Frozen **RV64IMC / LP64** profile proves 264 mandatory ELF tuples through the shared middle-end (`implementedLevel: A6`). Extensions `A`, `F`, `D`, `Q`, `V`, `Zicsr`, and privileged instructions are outside the profile and **Unsupported**; `riscv` (width-ambiguous) and `riscv32` are **Unsupported**. Cumulative maturity stays **A1**.
- If the decoder is unavailable at runtime (`decoderAvailable: false`), a recognized architecture is downgraded to effective **A0 Detect** and decoder-dependent implemented stages become **Unavailable**.

## Native format maturity

Projected from `currentSupportMatrix().formats` in `js/platform/capability-maturity.js`:

| Format | Detect (`F0`) | Parse (`F1`) | Load / mapping (`F2`) | Imports / exports / relocations (`F3`) | Function / debug / unwind (`F4`) | Runtime / language metadata (`F5`) | Validated rebuild / patch (`F6`) | Maturity level | Implemented through |
|---|---|---|---|---|---|---|---|---|---|
| `macho` (Mach-O) | Supported | Supported | Supported | **Partial** | Partial | Partial | Unsupported | **F2** | **F5** |
| `elf` (ELF) | Supported | Supported | Supported | **Partial** | Partial | Unsupported | Unsupported | **F2** | **F4** |
| `pe` (PE/PE32+) | Supported | Supported | Supported | **Partial** | Partial | Unsupported | Unsupported | **F2** | **F4** |

F3 is intentionally conservative: loaders parse substantial import, export, relocation, and chained-fixup metadata while explicitly preserving known incomplete/unsupported edge cases. F4/F5 remain **Partial** where coverage is incomplete; F6 (`validatedRebuildPatch`) is **Unsupported** in the base matrix.

## Managed / VM frontends

Projected from `currentSupportMatrix().managed` in `js/platform/capability-maturity.js`:

| Frontend | Detect container (`M0`) | Metadata (`M1`) | Exact VMEffects (`M2`) | CFG + SSA (`M3`) | Types / interproc (`M4`) | Decompiler (`M5`) | Runtime / debug (`M6`) | Maturity level | Implemented through |
|---|---|---|---|---|---|---|---|---|---|
| `wasm` | Supported | Supported | Supported | Supported | Supported | Supported | Unsupported | **M5** | **M5** |
| `dex` | Supported | Supported | Supported | Supported | Supported | Supported | Unsupported | **M5** | **M5** |
| `cil` | Supported | Supported | Supported | Supported | Supported | Supported | Unsupported | **M5** | **M5** |
| `jvm` | Supported | Supported | Supported | Supported | Supported | Supported | Unsupported | **M5** | **M5** |

Each managed frontend decodes VM operations into exact `VMEffects`, lowers to shared Semantic IR/CFG/SSA, and runs type/interprocedural analysis and decompilation through the shared middle-end. `.wasm` and `.dex` binaries are wired directly into the asynchronous `openBinarySource` / platform worker open path via `js/managed/adapter.js` (exposing sections, functions, imports, exports, and `managedFrontend` truth without disturbing Mach-O `0xCAFEBABE` FAT detection). `M6` (runtime debugging / live provider integration) remains **Unsupported** in the base matrix.

## Knowledge, capability rules, collaboration, patterns & rebuild

Projected from `currentSupportMatrix().phase12` (`phase12Maturity()`) in `js/platform/capability-maturity.js`:

| Capability | Status | Authority | Known limitations |
|---|---|---|---|
| `knowledgePackages` | Partial | `suggestion-only` | `legacy-v2-compatibility-adapter`, `package-derived-facts-require-local-promotion` |
| `capabilityRules` | Partial | `deterministic-evidence-only` | `partial-upstream-propagates`, `no-ai-capability-minting` |
| `collaboration` | Partial | `local-canonical-only` | `remote-security-gate-required`, `derived-analysis-excluded` |
| `patterns` | Partial | `read-only-bounded` | `no-arbitrary-javascript`, `no-loader-semantic-mutation` |
| `rebuild` | Partial | `R0-shadow-only` | `operation-profile-proof-required`, `publication-explicit-and-atomic` |

## Evidence-gated promotion (`stage2-capability-maturity.js`)

`js/platform/stage2-capability-maturity.js` defines strict, unforgeable proof-gated promotions above the conservative base matrix:
- Architecture profiles (`arm64:a64`, `arm64e:a64+pac`, `x86_64:long-64`, `riscv64:rv64imc`) may promote to `A6` with a validated exact-head Stage 1 profile proof and to `A7` with a validated runtime profile proof.
- Format profiles (`macho:64`, `elf:64`, `pe:pe32`/`pe:pe32+`) may promote static levels (`F5`/`F4`) and `F6` only with validated exact-head and rebuild proofs.
- Managed frontends (`managed:<id>:m6`) and Phase 12 capabilities promote to `supported` only when their respective validated runtime, remote-collaboration, or rebuild proofs are supplied.

## Verification & maintenance

- `tests/phase6/foundation/capability-truth.test.mjs` pins these declarations against `js/platform/capability-maturity.js` and `tools/validation/phase6/profile.json`.
- When implementation maturity changes, update `js/platform/capability-maturity.js` (or `stage2-capability-maturity.js`) and its tests first, then update this projection in the same change.
