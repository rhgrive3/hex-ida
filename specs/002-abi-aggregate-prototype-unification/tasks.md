# Tasks: HEX-C3-02 ABI Aggregate/Prototype Unification

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, and
`contracts/abi-prototype.md` in this feature directory.

**Implementation gate**: Production source edits are forbidden until the
`ANALYZE=CLEAN` refreshed checkpoint is approved by Sol and the merged PR #2499
head is reconciled/re-audited against live main `390741dc`.

## Phase 1: Setup and ownership

- [x] T001 Record authoritative repository, base SHA, PR #2499 merge, merged #2500,
  active ABI branches, and generated state in `research.md`.
- [x] T002 [P] Record the Graft-backed compressed producer/consumer trace and the
  outside-Codespaces Graft guardrail in `research.md`.
- [x] T003 [P] Create the feature specification and requirements checklist in
  `spec.md` and `checklists/requirements.md`.
- [x] T004 Reconcile the merged #2499 changes against newest live main; record
  `OLD_BASE`, `CURRENT_MAIN`, overlapping files, semantic overlap, and Sol's
  action before any production edit.

## Phase 2: Foundational design and proof

- [x] T005 Create the deterministic pre-fix regression in
  `tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs` and record its failing
  output at base `8a614ccd0184d6c25257c25d930b68af7e9ac81f`.
- [x] T006 [P] Audit all registered ABI profiles and identity/version boundaries
  in `research.md` without changing implementation files.
- [x] T007 [P] Define classification identity, provenance, completeness, and
  invalidation states in `data-model.md`.
- [x] T008 [P] Define the consumer contract in `contracts/abi-prototype.md` and
  runnable validation in `quickstart.md`.
- [x] T009 Run Spec Kit analyze using the installed workflow and require no
  unresolved quality, ownership, or soundness findings.

## Phase 2A: Current-main correction (before production)

- [x] T036 Reconcile the branch to current `origin/main` at
  `390741dcf6f8d391017b7f1ba224e35b49b973d3`, refresh the #2499 collision
  status, and confirm current open PRs #2498/#2493 do not own ABI semantics.
- [x] T037 Run the read-only 66-row ABI/profile matrix covering every registered
  profile, scalar/aggregate/HFA/HVA/sret/vararg/unknown case, and stale,
  malformed, mismatched, and conflicting evidence; record 54 PASS and 12
  deterministic prototype-consumer failures in `research.md`.
- [x] T038 Add the minimum current-main regressions for stale ABI identity and
  AAPCS64 aggregate-piece grouping; prove both fail at the current base without
  changing production code.
- [x] T039 Re-run Spec Kit analyze after the correction and obtain Sol's
  implementation spot-check approval before touching a production file.

## Phase 3: User Story 1 — one ABI fact reaches every consumer (P1)

**Goal**: selected canonical ABI classifications reach Semantic IR, summaries,
prototype recovery, and decompiler projections with one identity and exact
piece ordering.

### Tests first

- [ ] T010 [P] [US1] Extend
  `tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs` with integer, FP,
  pointer, integer/FP return, small/multi-register aggregate, split
  register/stack, stack alignment/padding, and caller/callee agreement rows.
- [ ] T011 [P] [US1] Add profile-specific positive rows for Apple arm64 and
  arm64e, AAPCS64, SysV AMD64, Microsoft x64/vectorcall, and RISC-V
  LP64/LP64F/LP64D in the phase8 ABI matrix.
- [ ] T012 [P] [US1] Add downstream integration assertions proving the same
  identity and locations in Semantic IR, summaries, and decompiler prototype
  output without editing the existing #2499-owned test file.

### Implementation

- [ ] T013 [US1] Extend the canonical adapter boundary in
  `js/analysis/semantic-function-base.js` only as needed to preserve ABI
  identity, provenance, completeness, aggregate pieces, and hidden-result
  state; do not introduce a classifier.
- [ ] T014 [US1] Update the selected canonical consumer(s), including
  `js/decompiler/types/prototype.js` after #2499 reconciliation, to consume
  adapter classifications for arguments and returns rather than register
  literals or architecture heuristics.
- [ ] T015 [US1] Preserve piece order and profile-specific aggregate, HFA/HVA,
  split, stack, alignment, padding, and sret semantics through
  `js/decompiler/pipeline-core.js`, `js/decompiler/type-recovery.js`,
  `js/decompiler/semantic-core.js`, and summary consumers where their actual
  changed-file inventory proves a need.
- [ ] T016 [US1] Verify direct downstream behavior with the focused ABI matrix,
  existing phase5/phase6 ABI contracts, and the immediate decompiler/summary
  subsystem tests.

## Phase 4: User Story 2 — conservative aggregate and variadic boundaries (P1)

**Goal**: no unsupported, incomplete, stale, malformed, conflicting, or
ambiguous evidence is promoted to an exact ABI/prototype fact.

### Tests first

- [ ] T017 [P] [US2] Add paired negatives for unsupported ABI, stale profile or
  architecture identity, malformed classifier evidence, incomplete aggregate
  layout, and profile mismatch.
- [ ] T018 [P] [US2] Add negatives for anonymous/unknown variadic frontier,
  indirect calls, contradictory caller/callee observations, thunk/tail-call
  ambiguity, and hidden-sret ambiguity.
- [ ] T019 [P] [US2] Add cancellation, deadline, truncation, budget exhaustion,
  failed-classifier, and deterministic replay rows; prove no staged exact
  result is published.

### Implementation

- [ ] T020 [US2] Preserve explicit partial/unknown/unsupported/conflict states
  across adapter, summaries, prototype, and decompiler publication; reject
  stale or malformed identity/evidence atomically.
- [ ] T021 [US2] Implement or wire profile-specific known-vararg fixed prefixes,
  anonymous frontiers, HFA/HVA evidence limits, indirect-call uncertainty,
  and caller/callee conflict handling without majority or confidence
  laundering.
- [ ] T022 [US2] Run paired-negative and downstream tests; any false exactness
  is a hard blocker and must be fixed before convergence.

## Phase 5: User Story 3 — locked profile matrix (P2)

**Goal**: all supported shared-layer profiles have explicit terminal positive or
conservative outcomes without shrinking the denominator.

- [ ] T023 [P] [US3] Complete the locked matrix for integer/FP/pointer arguments,
  returns, aggregate boundaries, register classes, stack placement, alignment,
  padding, sret, HFA/HVA, and variadic cases.
- [ ] T024 [P] [US3] Complete arm64e profile identity rows and unsupported/stale
  ABI identity rows; prove architecture compatibility does not silently select
  an Apple platform ABI.
- [ ] T025 [US3] Compare direct classifier, adapter, Semantic IR, summary, and
  prototype outcomes and record every row's identity/completeness/diagnostic.

## Phase 6: Convergence, independent reviews, and delivery

- [ ] T026 Run Spec Kit converge; process every generated task through
  implementation, focused tests, and another converge until `CLEAN`.
- [ ] T027 Have a non-owner Luna perform adversarial Review Pass 1 on the exact
  implementation head with at least five fresh malformed, stale, incomplete,
  ambiguous, and boundary attacks plus finding-specific ABI attacks.
- [ ] T028 Fix every Review 1 finding, rerun implementation tests and converge,
  and repeat Review 1 on the new semantic head when applicable.
- [ ] T029 Sol performs targeted semantic review of the critical diff, strongest
  counterexample, strongest negative, canonical owner, and exactness boundary.
- [ ] T030 Reconcile once with newest live main; a different non-owner Luna
  performs independent Review Pass 2 over ownership, generated state,
  dependency direction, exact-head CI, and candidate merge structure.
- [ ] T031 Fix every Review 2 finding and invalidate prior approvals after any
  semantic change; rerun converge and both reviews as required.
- [ ] T032 Run canonical generated build twice when applicable, then exact-head
  CI on the intended PR head. Classify red checks rather than weakening gates.
- [ ] T033 Fetch newest live main and validate the exact candidate merge tree;
  record main/head/candidate SHAs, tree, focused/subsystem/release truth,
  generated state, ownership, and semantic collision.
- [ ] T034 Submit Sol's final packet and merge only after `APPROVE_MERGE` with
  all required evidence and no hard-zero soundness violation.
- [ ] T035 On live main, verify merge presence, production path, regressions,
  generated currentness, no immediate collision, Spec Kit ledger, and post-
  merge tests; record `RESULT: PASS` and `FINDING_STATUS = MERGED`.

## Dependencies and execution order

- T001–T009 are prerequisites for production work; T004 and Sol's collision
  decision are an external gate.
- T010–T012 must be written and fail before T013–T015 implementation.
- T016 precedes T017–T022; the negative matrix must never be weakened to match
  an implementation.
- T023–T025 can run in parallel once the adapter/consumer contract exists, but
  all rows depend on the canonical profile identity.
- T026–T035 are sequential delivery gates. Any semantic fix after a review
  invalidates prior review approvals.

## Parallel opportunities

- Profile audit (T006), evidence model (T007), and consumer contract (T008) are
  independent documentation work.
- Positive matrix rows (T010–T012), paired negatives (T017–T019), and profile
  rows (T023–T024) can be developed in separate test files where ownership
  preflight confirms no overlap.
- Review Pass 1 and other finding lanes may proceed in parallel, but reviewers
  must be non-owners and may not approve a stale semantic head.

## Requirement and success-criterion coverage

| Requirement | Task coverage |
|---|---|
| FR-001, FR-002, FR-003 | T013–T015, T025 |
| FR-004, FR-005, FR-006 | T010–T011, T015, T021, T023 |
| FR-007 | T012, T015, T018, T021, T025 |
| FR-008 | T011, T023–T024 |
| FR-009, FR-010, FR-011 | T017–T022, T026, T032 |
| FR-012 | T010–T012, T017–T019, T023–T025 |
| FR-013 | T004, T014–T015, T030–T033 |
| SC-001, SC-004 | T010–T016, T023, T025 |
| SC-002, SC-006 | T017–T022 |
| SC-003 | T011, T023–T025 |
| SC-005 | T019, T025 |
| SC-007 | T012, T016, T022 |
| SC-008 | T016–T019, T032 |
| SC-009 | T026–T035 |
