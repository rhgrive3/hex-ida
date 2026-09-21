# Tasks: Decompiler Fast Profile

**Branch**: `feat/decompiler-fast-profile` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Phase 1: Setup

**Purpose**: Confirm clean state on new branch and Phase 8 working scope.

- [x] T001 Verify baseline status and lane ownership boundaries in `js/decompiler/pipeline-core.js` and `js/decompile-base.js`

---

## Phase 2: Foundational

**Purpose**: Implement profile resolution helper with defaults and override semantics.

- [x] T002 Implement `resolveDecompilerProfile` and `applyDecompilerProfile` with `'fast'` and `'deep'` presets in `js/decompiler/profiles.js` (exported across `pipeline-core.js`, `pipeline.js`, `semantic-core.js`, `semantic.js`)

---

## Phase 3: User Story 1 - Fast Decompilation Profile Option (Priority: P1)

**Goal**: Cap rewrite pass and Phase 8 solver work budgets when `profile === 'fast'`.

**Independent Test**: Decompilation with `profile: 'fast'` finishes rapidly and emits valid pseudocode with preserved statement addresses.

- [x] T003 [P] [US1] Apply resolved profile budgets (`decompilerTimeBudgetMs: 30`, `phase8TimeBudgetMs: 30`, `phase8WorkBudget: 10000`) in `js/decompiler/pipeline-core.js` and add fallback expression DAG memoization
- [x] T004 [US1] Wire `profile` option forwarding through `js/decompiler/pipeline.js` and `js/decompiler/semantic-core.js` (maintaining 100% Phase 8 lane boundary isolation)

---

## Phase 4: User Story 2 - Lightweight Provenance Binding for Fast Mode (Priority: P2)

**Goal**: Avoid multi-second exhaustive provenance collection on unoptimized functions.

**Independent Test**: `lines` retain statement addresses while `renderProvenanceBudget` is capped to 128 records.

- [x] T005 [P] [US2] Apply capped `renderProvenanceBudget` (`maxTransformRecords: 128, maxConsumers: 256`) when `profile === 'fast'` via `applyDecompilerProfile`

---

## Phase 5: User Story 3 - Safety, Testing & Quality Gates (Priority: P3)

**Purpose**: Validate unit tests, performance, and Phase 8 ownership compliance.

- [x] T006 [P] [US3] Create comprehensive unit test suite in `tests/phase8/substrate/decompiler-fast-profile.test.mjs` (6/6 tests passing)
- [x] T007 [US3] Validate Phase 8 ownership compliance using `node tools/validation/phase8-ownership.mjs` (0 violations)
- [x] T008 [US3] Verify latency reduction, expression DAG memoization, and pseudocode validity across fast profile benchmarks

---

## Dependencies & Execution Order

1. Setup (Phase 1) → Foundational (Phase 2) → US1 & US2 (Phases 3 & 4)
2. Quality Gates (Phase 5) verifies the complete implementation
