# Tasks: Decompiler Phase 8 Canonical Expression Validation Caching

**Branch**: `perf/canonical-expression-live-data-validation` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Phase 1: Setup

**Purpose**: Confirm environment, baseline branch, and target files.

- [X] T001 Verify baseline status and Phase 8 working scope in `js/decompiler/pipeline-core.js`

---

## Phase 2: Foundational

**Purpose**: Validate imported validation primitives and ownership boundary.

- [X] T002 Verify `createValidationBatch` availability from `js/core/identity/live-data.js` without modifying identity layer

---

## Phase 3: User Story 2 - Source Map Generation Acceleration (Priority: P2) & US1

**Goal**: Eliminate duplicate `matches()` walks during printed source map expression consumer resolution.

**Independent Test**: Source map generation produces identical mapping entries with reduced validation calls.

- [X] T003 [P] [US2] Implement `consumerSourceMap` batch helper in `js/decompiler/pipeline-core.js`
- [X] T004 [US2] Wire `consumerSourceMap` into `enhanceSemanticDecompilation` in `js/decompiler/pipeline-core.js`

---

## Phase 4: User Story 3 - Safety & Fail-Closed Mutation Detection (Priority: P3)

**Goal**: Guarantee fail-closed fallback on mid-pass mutation and prove non-leakage across passes.

**Independent Test**: Counterexample tests pass, demonstrating fallback on mutation and isolation across calls.

- [X] T005 [P] [US3] Create counterexample and regression tests in `tests/phase8/substrate/consumer-source-map-batch.test.mjs`
- [X] T006 [US3] Run focused unit tests using `node --test tests/phase8/substrate/consumer-source-map-batch.test.mjs`

---

## Phase 5: Polish & Quality Gates

**Purpose**: Verify Phase 8 ownership, benchmark correctness, and performance.

- [X] T007 Validate Phase 8 ownership compliance using `node tools/validation/phase8-ownership.mjs`
- [X] T008 Run correctness comparison on `param_strcmp @ 0x18b8` using `_perf_scratch/compare.mjs`
- [X] T009 Measure validation call counts and latency reduction on `param_strcmp @ 0x18b8`

---

## Dependencies & Execution Order

1. Setup (Phase 1) → Foundational (Phase 2) → US2 Implementation (Phase 3)
2. Counterexample tests (Phase 4) can be developed alongside or immediately after Phase 3
3. Quality gates (Phase 5) validate the final combined state

## Parallel Opportunities

- T003 and T005 operate on separate files (`js/decompiler/pipeline-core.js` and `tests/phase8/substrate/consumer-source-map-batch.test.mjs`) and can be developed in parallel.
