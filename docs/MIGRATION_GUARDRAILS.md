# Migration Guardrails

This document records compatibility and boundary contracts that protect the Hex codebase as it evolves toward [`HEX_MASTER_ARCHITECTURE.md`](HEX_MASTER_ARCHITECTURE.md).

The guardrails are intentionally narrow: they protect proven public seams, module boundaries, and safety invariants without freezing internal implementation layouts.

## Protected compatibility contracts

| Area | Contract | Gate |
|---|---|---|
| Semantic facade | `js/ir.js` remains the public compatibility boundary and retains required semantic query exports | `tests/migration-guardrails.mjs` |
| Alias safety | Unknown memory locations are never `MustAlias` (remain `MayAlias`); unknown stores between proof source and sink act as barriers | `npm run migration:test` + `npm run semantic:test` |
| Decompiler core | `js/decompiler/pipeline-core.js` consumes semantic analysis and does not read instruction mnemonic/operand text or decoder/backend internals | `npm run migration:test` + `npm run decompiler:test` |
| Host / WASM boundary | `js/ui/`, `js/ai/`, `js/auth/`, and `js/userscript/` do not import internal engine modules or `js/core/hex-engine-wasm.js` directly; all WASM access goes exclusively through `js/core/hex-engine-bridge.js` | `npm run performance:test` (`tests/performance/wave6-release-gates.test.mjs`) |
| Project exchange | `.hexproj` v1 import/export remains supported; derived cache state stays referenced rather than owned by the exchange layer | `npm run migration:test` + `tests/project-roundtrip.mjs` |
| Plugin API v1 | Existing registration entry points in `js/platform/plugin-api.js` remain available; new contribution categories are additive | `npm run migration:test` + `tests/plugin-platform.mjs` |
| Runtime evidence | Runtime evidence refines or contradicts static candidates without mutating static truth | `npm run migration:test` + `tests/runtime-evidence-fusion.mjs` |
| AI mutation | Mutation remains evidence-backed proposal → explicit approval token → approval-gated `CapabilityExecutor` → mutation adapter | `npm run migration:test` + `npm run ai:test` |
| Source-backed loader | Native loaders continue to support bounded range reads without retaining a whole-file byte array | `npm run binary:source-test` |
| Multi-arch & ARM64 parity | Semantic, decompiler, compiler-truth, and C++/WASM differential regressions remain mandatory | `npm run semantic:test` + `npm run decompiler:test` + `npm run performance:test` |

## Dependency boundary checks

`tests/migration-guardrails.mjs` and `npm run module-boundaries:test` reject forbidden direct dependencies:

- generic semantic facade/dataflow modules → architecture-specific target implementations;
- `js/project/**` → derived cache or ArtifactStore implementation;
- UI modules → `js/ir-core.js` or `js/decompiler/pipeline-core.js` private internals;
- AI modules other than approval-gated `js/ai/capabilities/executor.js` → direct binary patch implementation;
- semantic decompiler core → architecture decoder/backend implementation.

Separately, `tests/performance/wave6-release-gates.test.mjs` (`npm run performance:test`) enforces the Host-layer → WASM boundary:

- Host layers (`js/ui/`, `js/ai/`, `js/auth/`, `js/userscript/`) must not directly import `js/core/hex-engine-wasm.js` or internal engine modules bypassing `js/core/hex-engine-bridge.js`.

The sanctioned AI mutation executor is separately verified for `requiresApproval` and proposal-scoped authorization before execution.

## Deliberate compatibility exceptions

These are bounded compatibility seams, not approved patterns for new code:

- `js/ir-core.js` is a **compatibility facade** whose production default is Semantic IR v2. The legacy ARM64/AAPCS64 implementation remains available only as an explicit compatibility/oracle path via `js/architecture/compat/ir-core-arm64-aapcs64-v1.js`. New generic code MUST NOT import that architecture-specific compatibility module directly.
- Architecture/compiler-specific decompiler idioms (e.g., Apple ARC/Swift passes) may act as refinement providers, but must not become a second instruction-decoding path.
- `analysis.cacheReferences` in `.hexproj` v1 is permitted as a reference to derived analysis, not ownership of an ArtifactStore.
- Public API tests assert required exports rather than freezing the complete export set, allowing additive extensions.

## CI enforcement

- Focused contracts: `npm run migration:test`, `npm run module-boundaries:test`, and `npm run performance:test`
- Full repository gate: `npm run check` (includes `migration:test`, `module-boundaries:test`, and `performance:test` via `npm test`)

## Relationship to process guardrails

Architecture and boundary compatibility alone are not sufficient. [`ENGINEERING_PROCESS_GUARDRAILS.md`](ENGINEERING_PROCESS_GUARDRAILS.md) is the companion normative contract:

- never weaken a migration guardrail to work around an ownership, generated-output, workflow-trigger, or integration defect;
- add permanent automated regressions for repeated process defects;
- verify candidate merge trees and exact-head builds rather than relying on stale or isolated branch runs.

## Review rule

Update a guardrail only when the old contract has a tested compatibility adapter or a completed differential cutover. Never delete a failing guardrail just to turn a PR green.
