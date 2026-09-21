# Implementation Plan: Decompiler Phase 8 Canonical Expression Validation Caching

**Branch**: `perf/canonical-expression-live-data-validation` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-canonical-expression-cache/spec.md`

## Summary

Optimize decompiler freshness validation by batching consumer history lookups during printed source map generation in `js/decompiler/pipeline-core.js` using the existing `createValidationBatch` from `js/core/identity/live-data.js`. Keep all changes strictly within Phase 8 ownership boundaries, enforce fail-closed mutation detection during settlement, and verify output equivalence on benchmark function `param_strcmp @ 0x18b8`.

## Technical Context

**Language/Version**: Node.js 20+ (ES Modules, JavaScript)
**Primary Dependencies**: Internal Hex decompiler pipeline (`js/decompiler/**`), core identity (`js/core/identity/live-data.js`)
**Storage**: In-memory AST, SSA, and provenance graph
**Testing**: `node --test` (Node test runner), focused Phase 8 test suites
**Target Platform**: Linux, macOS, iOS/WebKit compatible pure JS runtime
**Project Type**: Decompiler quality & performance optimization (Phase 8)
**Performance Goals**: >50% reduction in repeated `matches()` calls on `param_strcmp`, measurable latency reduction on warm decompile
**Constraints**: Zero changes to `js/core/identity/**` (strictly enforce Phase 8 ownership), fail-closed settlement, zero cross-transaction retention

## Constitution Check

- **I. One Canonical Semantic Truth**: PASS. No second semantic engine or heuristic fallback; uses canonical `createValidationBatch` and live `matches()` verification.
- **II. Uncertainty Is Explicit and False Certainty Blocks Release**: PASS. `settle()` re-verifies all answers against live state; mutation mid-pass forces fail-closed fallback.
- **III. Deterministic Proof Before Promotion**: PASS. Pinned counterexample tests for single-read mutation, multi-read mutation, and cross-pass isolation.
- **IV. Bounded, Cancellable, Portable Analysis**: PASS. Synchronous per-pass execution with zero memory leaks across passes or decompilations.
- **V. Exact Product and Integration Proof**: PASS. Verified against `tools/validation/phase8-ownership.mjs` with 0 violations.

## Project Structure

### Documentation (this feature)

```text
specs/006-canonical-expression-cache/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── decompiler-pipeline-caching.md
└── tasks.md             # Phase 2 output (via /speckit-tasks)
```

### Source Code Layout

- `js/decompiler/pipeline-core.js`: Add `consumerSourceMap(advanced)` helper and integrate into `enhanceSemanticDecompilation`.
- `tests/phase8/substrate/consumer-source-map-batch.test.mjs`: Dedicated counterexample tests for source map consumer batching and mutation safety.
