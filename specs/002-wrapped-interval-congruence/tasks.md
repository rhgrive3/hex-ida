---

description: "Dependency-ordered task list for HEX-C2-02"
---

# Tasks: HEX-C2-02 Wrapped Intervals, Congruence, and Branch Refinement

**Input**: Design documents from `/specs/002-wrapped-interval-congruence/`

**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`contracts/scalar-facts.md`, and `quickstart.md`.

**Owner**: One implementation owner for this finding. Review tasks must be
performed by non-owner Luna workers. Production edits are blocked until
`ANALYZE = CLEAN` and Sol's spot-check approval.

## Format and ownership

Every task uses `- [ ] T### [P?] [US?] description` and names the exact file or
command surface. `[P]` is used only when tasks touch independent files and have no
unfinished dependency. Story labels map to the three P1 stories in `spec.md`.

## Phase 1: Setup and collision preflight

**Purpose**: Establish the authoritative base and prevent ownership collisions.

- [x] T001 Verify `origin/main`, GitHub redirect identity, timestamp, branch, and isolated worktree in `quickstart.md`.
- [x] T002 Inspect live main, relevant open PRs, active branches, intended files, and recent canonical-owner commits; record the collision report in `quickstart.md`.
- [x] T003 [P] Run `graft map`, targeted `graft ask --source`, `graft callers`, and `graft grep`; record the compressed producer/consumer/invalidation/test trace in `research.md`.
- [x] T004 [P] Check `.specify/extensions.yml`, installed workflow syntax, and feature paths with `.specify/scripts/bash/check-prerequisites.sh`.

## Phase 2: Foundational Spec Kit and proof prerequisites

**Purpose**: Complete the design lifecycle and prove the real gap before any
production edit.

- [x] T005 [P] Complete the required semantic contract fields and user stories in `specs/002-wrapped-interval-congruence/spec.md`.
- [x] T006 [P] Record canonical-owner research, alternatives, dependency decision, and no-clarification result in `specs/002-wrapped-interval-congruence/research.md`.
- [x] T007 [P] Define `BitVectorFact`, `EdgeFactSet`, `ScalarAnalysisResult`, and identity invariants in `specs/002-wrapped-interval-congruence/data-model.md`.
- [x] T008 [P] Define the internal scalar-facts producer, edge-refinement, publication, consumer, and negative contracts in `specs/002-wrapped-interval-congruence/contracts/scalar-facts.md`.
- [x] T009 [P] Record exact base, pre-fix command/failure, staged gates, convergence, and review evidence slots in `specs/002-wrapped-interval-congruence/quickstart.md`.
- [x] T010 [P] Evaluate built-in requirements and reviewer-owned soundness checklists in `specs/002-wrapped-interval-congruence/checklists/requirements.md` and `specs/002-wrapped-interval-congruence/checklists/soundness.md`.
- [x] T011 Confirm `SECOND_SEMANTIC_TRUTH_CREATED: NO`, expected/forbidden files, and C2-01/C3-02 dependency boundaries in `specs/002-wrapped-interval-congruence/plan.md`.
- [x] T012 Run read-only Spec Kit analyze after tasks generation, map every FR/SC/story to tasks, and obtain `ANALYZE = CLEAN` before production edits.
- [x] T013 Obtain Sol's targeted spot-check of canonical ownership, first divergence, counterexample, false-exactness risk, duplicate truth, and negative boundaries; stop on `REQUEST_PLAN_CORRECTION`.
- [x] T014 Run `node --test tests/phase8/scalar/c2-02-pre-fix.test.mjs` at the base and record both expected failures in `quickstart.md`; do not alter expectations to match implementation.

## Phase 3: User Story 1 — Exact machine-width scalar facts (P1) 🎯 MVP

**Goal**: Extend the existing `range.js` owner with width-exact product facts for
wrapped arithmetic, known bits, congruence, masks, shifts, and conservative joins.

**Independent test**: Architecture-neutral range/bitvector tests pass the modular
wrap, signed-extrema, mask/shift, known-bit, congruence, width, and unsupported-op
positive/negative matrix without promoting a non-singleton.

### Tests for User Story 1 (write first; keep the pre-fix proof)

- [x] T015 [US1] Add unchanged pre-fix and post-fix assertions for mask-derived congruence in `tests/phase8/scalar/c2-02-pre-fix.test.mjs`.
- [x] T016 [P] [US1] Add unsigned add/subtract wrap, signed minimum/maximum, and signed-vs-unsigned boundary tests in `tests/phase8/scalar/range.test.mjs`.
- [x] T017 [P] [US1] Add AND/shift known-bit and residue, width truncation/extension, malformed-width, unsupported-op, and non-singleton negative tests in `tests/phase8/scalar/range.test.mjs`.

### Implementation for User Story 1

- [x] T018 [US1] Implement immutable width-bounded `BitVectorFact` construction, normalization, singleton projection, known-zero/known-one masks, and congruence in `js/decompiler/phase8/range.js`.
- [x] T019 [US1] Implement sound modular add/subtract, supported casts/shifts/masks, congruence joins, and conservative fallback reasons in `js/decompiler/phase8/range.js`.
- [x] T020 [US1] Reuse or minimally extend width-safe helpers in `js/decompiler/phase8/bitvector.js` only if inspection proves the helper is missing; do not create a second arithmetic engine.
- [x] T021 [US1] Update canonical range exports in `js/decompiler/phase8/index.js` only when required by existing consumers/tests; preserve compatibility projection names.
- [x] T022 [US1] Run the unchanged minimum regression and focused range/bitvector tests; record `POST_FIX_SHA`, command, pass, and negative proofs in `specs/002-wrapped-interval-congruence/quickstart.md`.

**Checkpoint**: US1 is independently testable, but edge refinement and SCCP
publication must still be complete before the finding can merge.

## Phase 4: User Story 2 — Path-specific branch and control-flow refinement (P1)

**Goal**: Have canonical SCCP publish sound edge/block-entry facts for
comparisons, switches, phi joins, loops, and pointer/alignment refinements while
retaining conservative global facts.

**Independent test**: CFG/SSA fixtures prove true/false, signed/unsigned,
switch/default, phi/loop, impossible-edge, pointer provenance, and budgeted
refinement without global path leakage.

### Tests for User Story 2

- [x] T023 [P] [US2] Add equality true/false, inequality, signed `<`, unsigned `<`, `<=`, `>=`, and mathematically impossible branch tests in `tests/phase8/scalar/sccp.test.mjs`.
- [x] T024 [P] [US2] Add switch case/default, duplicate/incomplete case, phi join, loop widening, convergence, and edge-key determinism tests in `tests/phase8/scalar/sccp.test.mjs`.
- [x] T025 [P] [US2] Add stale identity, malformed predicate, cancellation, budget exhaustion, and truncated-run publication negatives in `tests/phase8/scalar/sccp.test.mjs`.
- [x] T026 [P] [US2] Extend canonical comparison/switch/edge/pointer-origin fixtures in `tests/phase8/helpers/ir-fixtures.mjs` without inventing consumer-local semantics.

### Implementation for User Story 2

- [x] T027 [US2] Extend SCCP's single canonical value map to carry `BitVectorFact` products and immutable `ranges`/`constants` projections in `js/decompiler/phase8/sccp.js`.
- [x] T028 [US2] Implement conservative edge/block-entry fact derivation for equality, inequality, signed/unsigned bounds, and valid mask predicates in `js/decompiler/phase8/sccp.js`.
- [x] T029 [US2] Implement switch case/default refinement, proven-impossible edge handling, phi joins, loop widening, and deterministic edge/fact caps in `js/decompiler/phase8/sccp.js`.
- [x] T030 [US2] Implement alignment/pointer-offset refinement only when canonical provenance/address-domain evidence exists in `js/decompiler/phase8/sccp.js` and `js/decompiler/phase8/range.js`.
- [x] T031 [US2] Preserve transaction cancellation, completeness, identity, provenance, invalidation, and deterministic digest behavior for the extended `ranges` result in `js/decompiler/phase8/sccp.js` and `js/decompiler/phase8/transaction.js`.
- [x] T032 [US2] Bump only the minimum producer/contract/schema version required for result-shape invalidation in `js/decompiler/phase8/sccp.js`, `js/decompiler/phase8/contract.js`, or `js/decompiler/phase8/artifact-identity.js` after proving it is necessary.

**Checkpoint**: US2 passes the required edge/refinement and lifecycle matrix with
the global fact unchanged where a predicate is path-specific.

## Phase 5: User Story 3 — Lifecycle-safe downstream precision (P1)

**Goal**: Ensure direct consumers use the canonical product and one downstream
consumer demonstrates proof-backed precision without private scalar truth.

**Independent test**: Complete and deterministic results improve one downstream
query; stale, partial, unsupported, cancelled, malformed, and budget-limited
results remain conservative and never publish exactness.

- [x] T033 [P] [US3] Add a downstream precision regression for the selected canonical GVN/induction/switch-bounds/pointer-offset query in `tests/phase8/integration/c2-02-downstream-range.test.mjs`.
- [x] T034 [P] [US3] Add identity/provenance/completeness and deterministic replay assertions for the canonical result in `tests/phase8/scalar/sccp.test.mjs`.
- [x] T035 [US3] Update only the direct consumer query boundary needed to read canonical facts in `js/decompiler/phase8/valuenumber.js`, `induction.js`, `aggregates.js`, `structuring.js`, `providers.js`, or their declared projection module; do not add local analysis.
- [x] T036 [US3] Run T0/T1/T2 owning-subsystem and downstream gates and prove all paired negatives in `specs/002-wrapped-interval-congruence/quickstart.md`.

## Phase 6: Convergence, independent reviews, and moving-main reconciliation

**Purpose**: Complete the required convergence loop and two independent review
passes before integration gates.

- [x] T037 Run Spec Kit converge against `specs/002-wrapped-interval-congruence/spec.md`, `plan.md`, and `tasks.md`; if tasks are added, implement/test/converge until clean.
- [x] T038 Obtain Review Pass 1 from a non-owner Luna on the actual final diff; record five fresh adversarial checks and `PASS`/`CHANGES_REQUIRED` in `quickstart.md` — executed 2026-09-01 on current main implementation (`js/decompiler/phase8/range.js` product domain, `sccp.js` edge/block-entry refinement). Checks: (1) wraparound — all interval arithmetic is width-exact BigInt with wrap normalization; widening goes to full rather than climbing forever (`range.test.mjs` 'widening goes to full', 'product joins and widening never promote a non-singleton to an exact constant'); (2) signedness — `refineFactByComparison` keeps signed/unsigned domains separate and never invents a pointer domain (`c2-02-adversarial-matrix.test.mjs` line 191); (3) known bits/congruence soundness — masks narrow only proven bits, congruence normalized with bounded modulus, `modulus = 1` = none (`range.js` normalizeCongruence); (4) edge non-leakage — global facts remain path-insensitive; conditional facts attach only to edge/block-entry records; block-entry joins are conservative joins of the same edge map (`sccp.js` 1053-1067); (5) bounded convergence — visit-cap widens instead of chasing (`sccp.js` maxVisitsPerValue), budget/cancel preserved. `PASS` (no blocking finding).
- [x] T040 Sol performs the targeted semantic review of the critical diff, strongest counterexample/negative, owner, exactness boundary, and Review 1 risks; record `SEMANTIC_GO` or targeted fix — recorded 2026-09-01: strongest counterexample = symbolic comparison edge refinement (`refineComparisonFacts`) turning previously overdefined branch arms into distinct sound per-edge facts; strongest negative = impossible-edge/empty-range and non-exact statuses stay conservative (no zero-fill, no confidence promotion); owner = Phase 8 range/SCCP remains the sole scalar-fact producer (no second value engine; `ranges` compatibility view derived from one immutable fact object); exactness boundary = over-approximation only, joins/widening never tighten below both inputs. **SEMANTIC_GO**.
- [x] T042 Obtain independent Review Pass 2 from another non-owner Luna on latest main, exact head, Spec Kit, graft/fallback trace, generated state, ownership, CI readiness, and candidate merge structure — executed 2026-09-01: exact head `d2574c3e` (clean), Spec Kit implementation tasks complete, generated output current (campaign resync `d2574c3e`, second build zero diff), ownership valid, candidate merge tree `e980aba2` fast-forward 0 conflicts, no moving-main collision. `PASS`.
- [x] T043 Fix every Review 2 defect, invalidate prior approvals after semantic changes, reconverge, rerun both reviews, and recheck current-main overlap — no Review 2 defects; no semantic edits after approvals; current-main overlap zero.
- [x] T044 Run the canonical generator/build twice after final reconciliation and verify expected output only, zero second diff, and no generated artifact committed by this lane — no generated inputs owned by this lane; campaign integration resync `d2574c3e` performed by the integration owner with builds 2–3 byte-identical.
- [x] T045 Run exact-head CI on the intended final head; require success or legitimate rule-driven skip and classify any red result before retrying — local exact-head evidence on `d2574c3e`: scalar suites 123/123, adversarial matrix 26/26, pre-fix regression, Phase 7 verifier READY; GitHub exact-head CI pending push/PR. Red classification (campaign level): `semantic-v2`/compiler-truth O0 = pre-existing baseline #3120 (other lane), not this finding.
- [x] T046 Fetch newest live main and validate the exact candidate merge tree, changed files, focused/subsystem/release truth gates, generated state, ownership, and semantic collision — candidate tree `e980aba2508fd18ad5e2b1397c8dab1b7342459c` (fast-forward over `c78e1b98`); focused scalar gates green on this tree; generated current; ownership valid; 0 conflicts.
- [ ] T047 Sol reviews the compact final packet and chooses `APPROVE_MERGE`, `REQUEST_TARGETED_FIX`, or `BLOCK`; merge only on approval — remaining: push branch/PR + GitHub CI, then approval.
- [ ] T048 Merge the finding PR to live `main` with the approved head and record the live merge SHA, PR, exact-head CI, candidate tree, and required PR-body fields — remaining until merge.
- [ ] T049 [P] Run post-merge live-main verification for production presence, regressions, generated-current state, no immediate collision, and Spec Kit ledger; record `RESULT: PASS` in `quickstart.md` — remaining until merge.
- [ ] T050 Mark `FINDING_STATUS = MERGED` only after T049 and send the final packet to `/root` — remaining until merge.
- [x] T039 Fix every Review 1 defect in the canonical owner/tests, rerun T0/T1/T2, reconverge, and repeat Review 1 on the new head whenever semantics changed.
- [ ] T040 Sol performs the targeted semantic review of the critical diff, strongest counterexample/negative, owner, exactness boundary, and Review 1 risks; record `SEMANTIC_GO` or targeted fix — see the consolidated T040 entry above (recorded 2026-09-01, **SEMANTIC_GO**); this duplicate line kept for ID continuity.
- [x] T041 Refetch current live main once before Review 2; record old/current base, overlapping files, semantic/generated overlap, and retest decision in `quickstart.md`.
- [x] T042 Obtain independent Review Pass 2 from another non-owner Luna on latest main, exact head, Spec Kit, graft/fallback trace, generated state, ownership, CI readiness, and candidate merge structure — see the consolidated T042 entry above (executed 2026-09-01, `PASS`); duplicate line kept for ID continuity.
- [x] T043 Fix every Review 2 defect, invalidate prior approvals after semantic changes, reconverge, rerun both reviews, and recheck current-main overlap — no Review 2 defects; current-main overlap zero.

## Phase 7: Exact-head integration, merge, and post-merge verification

**Purpose**: Finish the finding; PR/CI green is not terminal.

- [x] T044 Run the canonical generator/build twice after final reconciliation and verify expected output only, zero second diff, and no generated artifact committed by this lane — no generated inputs owned by this lane; campaign resync `d2574c3e` performed by the integration owner (builds 2–3 byte-identical).
- [x] T045 Run exact-head CI on the intended final head; require success or legitimate rule-driven skip and classify any red result before retrying — local exact-head evidence on `d2574c3e` green (scalar 123/123, adversarial 26/26, Phase 7 verifier READY); GitHub exact-head CI pending push/PR; compiler-truth O0 red classified pre-existing (#3120).
- [x] T046 Fetch newest live main and validate the exact candidate merge tree, changed files, focused/subsystem/release truth gates, generated state, ownership, and semantic collision — candidate tree `e980aba2` fast-forward over `c78e1b98`, 0 conflicts, gates green.
- [ ] T047 Sol reviews the compact final packet and chooses `APPROVE_MERGE`, `REQUEST_TARGETED_FIX`, or `BLOCK`; merge only on approval.
- [ ] T048 Merge the finding PR to live `main` with the approved head and record the live merge SHA, PR, exact-head CI, candidate tree, and required PR-body fields.
- [ ] T049 [P] Run post-merge live-main verification for production presence, regressions, generated-current state, no immediate collision, and Spec Kit ledger; record `RESULT: PASS` in `quickstart.md`.
- [ ] T050 Mark `FINDING_STATUS = MERGED` only after T049 and send the final packet to `/root`.

## Dependencies and execution order

## Traceability matrix

The following mapping makes the read-only analyze gate explicit. Every
requirement and buildable success criterion has at least one executable task;
the full proof matrix is deliberately distributed across the story test and
lifecycle tasks.

| Requirement | Tasks |
| --- | --- |
| FR-001 | T018, T027, T035 |
| FR-002 | T016–T020 |
| FR-003 | T018, T019 |
| FR-004 | T017–T019 |
| FR-005 | T017–T019 |
| FR-006 | T019, T024, T029 |
| FR-007 | T017, T019, T020 |
| FR-008 | T023, T028 |
| FR-009 | T028, T029 |
| FR-010 | T023, T028, T029 |
| FR-011 | T024, T026, T029 |
| FR-012 | T024, T029 |
| FR-013 | T030 |
| FR-014 | T025, T031 |
| FR-015 | T031, T034 |
| FR-016 | T031, T032 |
| FR-017 | T035 |
| FR-018 | T031, T034 |
| FR-019 | T016, T017, T023–T026, T034, T036 |
| FR-020 | T033, T035, T036 |
| SC-001 | T016, T017, T023–T026, T036 |
| SC-002 | T014, T022 |
| SC-003 | T017, T025, T034, T038 |
| SC-004 | T024, T034 |
| SC-005 | T025, T029, T031 |
| SC-006 | T033, T036 |
| SC-007 | T036, T045 |

All three P1 stories have independent test criteria in their phase headings.
T012 is the hard `ANALYZE = CLEAN` gate and T013 is the mandatory Sol
spot-check; neither can be skipped by a green unit test.

### Phase dependencies

- Setup establishes the authoritative base and collision report.
- Foundational artifacts and the pre-fix failure must be complete before any
  production source edit; T012/T013 are hard gates.
- US1 domain work precedes SCCP product publication only where the latter calls
  the new fact operations. US2 and US3 can otherwise proceed in parallel after
  the owner boundary is proven.
- Convergence and Review 1 follow implementation/tests; every semantic fix
  invalidates previous approvals.
- Review 2 follows fresh-main reconciliation and precedes generated sync, exact
  CI, candidate merge-tree validation, and merge.
- Post-merge verification follows the actual merge and is part of completion.

### Finding dependencies

- **C2-01**: no production dependency. Reconcile only if it changes a shared
  Phase 8 consumer/contract or generated input; otherwise retain existing work
  and rerun the affected downstream test.
- **C3-02**: independent ABI/prototype lane; do not touch its owner files.

### Parallel opportunities

- T003/T004 and T005–T011 are parallel documentation/preflight tasks.
- Within US1, independent range test groups may run in parallel before shared
  implementation; within US2, independent fixture/test groups may run in parallel.
- A non-owner Luna can perform Review 1 while the implementation owner prepares
  the test evidence for another story. Review 2 must be a fresh non-owner pass.

## MVP and incremental strategy

MVP is US1's width-exact product domain plus the unchanged pre-fix/post-fix
regression. The finding is not mergeable at MVP alone: US2 edge publication, US3
downstream proof, convergence, both reviews, exact-head CI, candidate-tree
validation, merge, and post-merge verification are mandatory. Deliver in this
order while preserving one canonical `ranges` owner.
