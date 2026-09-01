# Tasks: Rendered-Entity Provenance Mapping (HEX-C4-03)

**Input**: Design documents from `/specs/004-render-provenance-mapping/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/render-provenance.contract.md, quickstart.md

**Tests**: REQUIRED for this finding (constitution III: deterministic counterexample before
promotion; ledger exit contract: positive + fail-closed regressions). Counterexample tests
are written first and must FAIL against unmodified production code.

**Organization**: Tasks grouped by user story (US1 navigate rendered→canonical, US2 detect
lost/stale provenance, US3 transform ledger auditability).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths included in every description

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Preflight evidence and runner/ownership invariants before production edits

- [ ] T001 Record preflight in docs/analysis-improvement-finding-ledger.md: exact live-main base SHA, branch `feat/analysis-hex-c4-03-provenance`, concurrent-lane overlap check for owned paths (ME-01/C1-01/C2-01/C2-02 lanes), and first-divergence statement (rendered entities from many-to-one transforms lose reverse navigation)
- [ ] T002 [P] Verify ownership baseline: run `node tools/validation/phase8-ownership.mjs --check-manifest` and confirm planned paths (js/decompiler/phase8/**, tests/phase8/**, tools/validation/phase8/**, ledger doc) fit the p8 lane + finding-lane exception for the ledger doc
- [ ] T003 [P] Add runner-discovery sentinel test tests/phase8/provenance/discovery.test.mjs and confirm `npm run phase8:test` discovers the new subtree (EP-005 invariant)

**Checkpoint**: Preflight recorded; discovery and ownership green before production edits.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Module skeleton and fail-closed contract codes; blocks all user stories

- [ ] T004 Create js/decompiler/phase8/render-provenance.js skeleton with fail-closed error codes (`phase8-render-provenance-input-required`, `-result-required`, `-snapshot-required`, `-entity-source-invalid`, `-record-invalid`) and input validation only (no behavior yet)
- [ ] T005 [P] Add render-provenance record validation codes to js/decompiler/phase8/contract.js following the existing fail-closed helper style (kind/proof/targets/origin required)

**Checkpoint**: Foundation ready — user story implementation can begin.

---

## Phase 3: User Story 1 — Navigate From Rendered Output to Canonical Evidence (Priority: P1) 🎯 MVP

**Goal**: Every rendered pseudocode entity resolves forward to canonical origins and every
origin resolves reverse to rendered entities, deterministically.

**Independent Test**: A function containing an optimized expression renders; the rendered
entity resolves to source rows/ir refs; two runs produce byte-identical maps.

### Tests for User Story 1 (write FIRST, must FAIL before implementation)

- [ ] T006 [P] [US1] Positive test in tests/phase8/provenance/forward.test.mjs: raw pass-through line (no rewrite) resolves to its direct instruction rows without synthetic transform records
- [ ] T007 [P] [US1] Positive test in tests/phase8/provenance/forward.test.mjs: induction-variable and exact-view-collapse entities resolve to canonical rows + ir/ssa refs through transform-record origins, including a multi-rewrite chain (transform on transform) reaching the original instruction rows (SC-004)

### Implementation for User Story 1

- [ ] T008 [US1] Implement forward map (RenderedEntity → OriginReference[]) with deterministic entity keys in js/decompiler/phase8/render-provenance.js (depends on T004)
- [ ] T009 [US1] Implement reverse index (origin key → entity keys) derived by sorting from the forward map, frozen output in js/decompiler/phase8/render-provenance.js (depends on T008)
- [ ] T010 [US1] Implement chain resolution: union origin sets across all transform records feeding an entity so transform-on-transform rewrites reach original instruction rows in js/decompiler/phase8/render-provenance.js (depends on T008)
- [ ] T011 [US1] Attach frozen additive `renderProvenance` field to the result in js/decompiler/phase8/projection.js `applyPhase8Projection` (existing fields unchanged; snapshotId passed via projection opts) (depends on T008–T010)
- [ ] T012 [US1] Determinism test in tests/phase8/provenance/determinism.test.mjs: two identical runs produce byte-identical provenance maps, and every origin reference resolves to existing canonical rows/ir refs (no minted identities, FR-008) (depends on T011)

**Checkpoint**: User Story 1 independently functional — reverse navigation works and is deterministic.

---

## Phase 4: User Story 2 — Detect Lost or Stale Provenance (Priority: P1)

**Goal**: Provenance loss, stale/missing snapshot identity, budget overflow, and
cancellation are explicit fail-closed states; nothing unproven is silently trusted.

**Independent Test**: Each unsafe boundary is injected (lost origin, stale snapshot,
missing identity, budget overflow, cancellation); validation reports the exact
conservative state and never passes silently.

### Tests for User Story 2 (write FIRST; T013 is the constitution-III counterexample)

- [ ] T013 [P] [US2] Pre-fix counterexample test in tests/phase8/provenance/validation.test.mjs: a rendered entity whose origins are lost by a many-to-one transform must NOT be trusted — must FAIL against unmodified production code first, documenting the deterministic pre-fix divergence
- [ ] T014 [P] [US2] Negative matrix tests in tests/phase8/provenance/validation.test.mjs: zero-origin entity → provenance-loss with entity keys; stale snapshot → stale-snapshot; missing identity → missing-snapshot; malformed transform record → record-invalid fail-closed

### Implementation for User Story 2

- [ ] T015 [US2] Implement validateRenderProvenance(provenanceMap, { snapshotId }) returning frozen `{ state, entityStates, reasons, counts }` with states complete/incomplete and reasons provenance-loss/stale-snapshot/missing-snapshot/truncated/cancelled in js/decompiler/phase8/render-provenance.js (depends on T013, T014)
- [ ] T016 [US2] Implement budget caps maxEntities/maxOriginsPerEntity/maxTransformRecords with explicit truncated scopes and counts in js/decompiler/phase8/render-provenance.js (depends on T015)
- [ ] T017 [US2] Wire renderProvenanceLossCount and renderProvenanceStaleCount into tools/validation/phase8/metrics.mjs safety counters with the same hard-zero gating as existing stale counters (depends on T015)
- [ ] T018 [US2] Removals auditability: transforms that eliminate rendered entities record consumed evidence (removedRefs) so removal is auditable; test in tests/phase8/provenance/removal.test.mjs (depends on T015)
- [ ] T019 [US2] Cancellation test in tests/phase8/provenance/cancellation.test.mjs: pathological fixture cancelled mid-validation returns explicit incomplete/cancelled and never completes silently (depends on T016)

**Checkpoint**: User Stories 1 AND 2 both work — navigation complete and fail-closed.

---

## Phase 5: User Story 3 — Transform Ledger Records Consumed and Produced (Priority: P2)

**Goal**: Every optimizing transform has one bounded, deterministic ledger record with
consumed origins, produced entities, version, and explicit truncation.

**Independent Test**: A function with a fold/merge transform is analyzed; the ledger record
lists consumed origins, produced refs, transform kind and version; pathological input
truncates explicitly.

### Tests for User Story 3 (write FIRST, must FAIL before implementation)

- [ ] T020 [P] [US3] Ledger shape test in tests/phase8/provenance/ledger.test.mjs: records carry kind, proof, targets, originRefs, producedRefs, version; merged-expression record lists both consumed origins and one produced entity; budget overflow produces explicit truncation state (not silent drop)

### Implementation for User Story 3

- [ ] T021 [US3] Enrich ledger records (producedRefs/removedRefs/version) via contract validation in js/decompiler/phase8/contract.js and render-provenance.js, bounded by the Phase 2 caps (depends on T020, T016)

**Checkpoint**: All user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Evidence, gates, and convergence for the finding

- [ ] T022 Run focused suite, ownership, and lint gates quiet: `node --test tests/phase8/provenance/`, `npm run phase8:test`, ownership manifest check, `node scripts/run-quiet-command.mjs --label check -- npm run check`; verify actual changed-file inventory against the ownership manifest
- [ ] T023 Update docs/analysis-improvement-finding-ledger.md HEX-C4-03 row + checkpoint with implementation evidence, focused test results, exact head, and generated-output handoff (ephemeral `npm run userscript:build` check, nothing committed)
- [ ] T024 Run quickstart.md validation end-to-end and record outcomes
- [ ] T025 Spec Kit convergence: confirm all tasks complete, all FR-001–FR-010 covered by tests, denominators unweakened; record residual gaps explicitly (none expected)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on T001–T003 — BLOCKS all user stories
- **US1 (Phase 3)**: depends on Phase 2
- **US2 (Phase 4)**: depends on US1 builder (T008–T010) — counterexample T013 may be written in parallel with US1 tests but must fail before T011 lands
- **US3 (Phase 5)**: depends on US2 caps (T016)
- **Polish (Phase 6)**: depends on all stories

### User Story Dependencies

- **US1**: foundational only — independent
- **US2**: consumes US1's map builder; independently testable via injected fixtures
- **US3**: ledger enrichment on top of US2 validation/caps

### Parallel Opportunities

- T002, T003 (setup) in parallel
- T006, T007, T013, T014, T020 are independent test files — parallelizable
- T008/T009/T010 are same-file sequential; T005 parallel with T004

## Implementation Strategy

- **MVP**: US1 alone delivers reverse navigation (spec's primary value) — stop and validate
  at its checkpoint before proceeding.
- **Counterexample-first**: T013 is the constitution-III deterministic proof; commit it
  (failing) before production validation code, per research.md R6.
- **Same-file sequencing**: render-provenance.js tasks are sequential; tests are parallel.

## Notes

- Generated userscript output is NOT committed by this lane (finding-ledger contract);
  build ephemerally and record as integration handoff (T023).
- No edits to forbidden paths (js/semantics/**, js/analysis/**, js/targets/**,
  js/core/identity/**, js/core/artifacts/**).
- Keep every commit's changed-file inventory inside the ownership manifest.
