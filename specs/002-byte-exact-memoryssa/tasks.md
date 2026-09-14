# Tasks: HEX-C2-01 Byte-Exact MemorySSA Forwarding

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/byte-forwarding.md`

**Prerequisites**: Spec Kit clarify and requirements checklist complete; `ANALYZE=CLEAN` and
Sol's implementation spot-check approval are required before production source tasks.

**Tests**: Required by the finding contract. Tests are written first and the minimum regression
must fail on the base SHA before production implementation.

## Phase 1: Preflight and proof (blocking)

- [x] T001 [P] Record live base SHA, repository identity, open relevant PRs, active branches,
  canonical owner, expected/forbidden files, and semantic overlaps in the campaign checkpoint.
- [x] T002 [P] Trace producer → canonical MemorySSA → identity/provenance/completeness → consumer
  → invalidation → tests with graft and record the compressed trace in `research.md`.
- [x] T003 [P] Add the minimum adjacent exact-store/wider-load regression in
  `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs` and assert the current boundary
  does not publish an exact reconstructed value.
- [x] T004 Run T003 at base `8a614ccd0184d6c25257c25d930b68af7e9ac81f`, record command and exact
  failure in `specs/002-byte-exact-memoryssa/quickstart.md`, and attach it to CHECKPOINT A.
- [x] T005 Sol spot-check canonical ownership, first divergence, counterexample quality, false-
  exactness risk, duplicate-truth risk, and negative boundaries; block or approve implementation.

## Phase 2: Foundational canonical query (blocking implementation)

- [x] T006 Extend the canonical query surface in `js/semantics/memoryssa/queries.js` (and only a
  directly owned companion module if needed) with validated load/store byte ranges, canonical
  definition traversal, exact coverage, ordered overlap resolution, and BigInt-safe reconstruction.
- [x] T007 Preserve the existing `js/semantics/memoryssa/contract.js` and
  `js/semantics/memoryssa/validate.js` ownership boundaries while enforcing identity,
  provenance, completeness, malformed/stale, and unsupported-effect refusal at the query entry.
- [x] T008 Add bounded cancellation/deadline/iteration/resource checks to the canonical query and
  ensure no staged partial bytes are published as exact.
- [x] T009 Add proof-bearing exact/non-exact result serialization in the canonical query contract;
  bind artifact identity, access metadata, endian/width, winning definition IDs, order, and origins.

## Phase 3: User Story 1 — Recover every proven load byte (P1)

**Goal**: Forward one complete exact value or reconstruct all bytes from ordered proven stores.

**Independent Test**: The focused semantic-v2 C2-01 test compares bytes, width, endian, winning
definitions, provenance, and deterministic proof identity against independent expected values.

### Tests first

- [x] T010 [US1] Expand `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs` with exact
  same-width store→load and multiple adjacent stores covering a wider load.
- [x] T011 [US1] Add little-endian reconstruction and every other endian lane supported by the
  canonical memory-access contract in `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs`.
- [x] T012 [US1] Add ordered overlapping stores with a proven winner per byte and assert the proof
  records final winning definition IDs in `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs`.
- [x] T013 [US1] Add deterministic replay assertions for values, proof identity, provenance,
  diagnostics, ordering, and completeness in `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs`.

### Implementation

- [x] T014 [US1] Implement canonical exact coverage and endian reconstruction using only the
  validated MemorySSA links in `js/semantics/memoryssa/queries.js` (or its declared companion).
- [x] T015 [US1] Preserve width-exact and signed/unsigned final-consumer behavior while exposing
  the proof-bearing result through `js/semantics/compat/semantic-ir-v2-to-v1.js` and
  `js/semantics/compat/semantic-ir-v2-to-v1-memory.js`.

**Checkpoint**: US1 positive cases pass and every exact result has complete byte coverage and
canonical proof identity.

## Phase 4: User Story 2 — Refuse unproven bytes (P1)

**Goal**: Every missing or uncertain proof dimension remains explicitly non-exact.

**Independent Test**: Each negative mutates one proof dimension from a positive fixture and checks
that no exact value is published and the refusal reason remains visible.

### Tests first/negative proof

- [x] T016 [US2] Add partial coverage/byte-hole, width mismatch, malformed access, unsupported or
  conflicting endian, and missing metadata negatives in `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs`.
- [x] T017 [US2] Add uncertain overlap/order, MayAlias, unknown alias, unknown/call/intrinsic
  clobber, and unresolved writer negatives in `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs`.
- [x] T018 [US2] Add volatile/atomic uncertainty, conflicting provenance, stale binary/function/
  snapshot/IR/SSA/MemorySSA/analyzer identity, and invalidation negatives in the focused test.
- [x] T019 [US2] Add cancelled, deadline, iteration/resource-budget exhausted, truncated,
  incomplete, and malformed-artifact negatives; assert no partial exact result is observable.

### Implementation

- [x] T020 [US2] Route all uncertainty and validation failures through explicit non-exact statuses
  in `js/semantics/memoryssa/queries.js` without zero-filling, confidence promotion, or fallback
  memory truth.
- [x] T021 [US2] Make `js/semantics/compat/semantic-ir-v2-to-v1-memory.js` publish the canonical
  fact atomically and retain conservative legacy behavior for every negative.

**Checkpoint**: US1 and US2 pass with zero false exact values and unchanged/increased assertion
strength.

## Phase 5: User Story 3 — Preserve canonical downstream precision (P2)

**Goal**: Existing direct/downstream consumers receive the one canonical fact and retain paired
negative conservatism.

**Independent Test**: Query the existing immediate value propagation path and one direct downstream
surface with the positive and paired negative fixtures.

- [x] T022 [US3] Add downstream precision and paired-negative assertions at the existing semantic
  compatibility/value consumer in `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs`.
- [x] T023 [US3] Connect the proof-bearing canonical result through
  `js/semantics/compat/semantic-ir-v2-to-v1.js` and
  `js/semantics/compat/semantic-ir-v2-to-v1-memory.js` without adding consumer-local alias or
  reaching-definition logic.
- [x] T024 [US3] Add the downstream precision and paired-negative assertions in
  `tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs`; verify that points-to/decompiler/
  value projections consume the current identity-bound fact and reject stale or invalidated
  results, modifying no private downstream engine.

**Checkpoint**: Direct and downstream precision improves only for proven complete bytes.

## Phase 6: Validation, review, and integration evidence

- [x] T025 Run `node --check` on changed JavaScript, focused contract/schema checks, and diff
  hygiene (T0).
- [x] T026 Run the complete focused C2-01 corpus and immediate downstream/subsystem tests (T1/T2),
  then record pre/post commands and results in `quickstart.md`.
- [x] T027 Run Spec Kit `converge`; if it adds tasks, implement/test/converge until the result is
  CLEAN and check every completed task against the actual diff.
- [ ] T028 [P] Perform independent Review Pass 1 on the final implementation diff with at least
  five fresh adversarial checks (malformed, stale, incomplete/cancelled, ambiguity/alias, boundary)
  plus C2-01 byte-hole/overlap/endian/clobber/store-order attacks.
- [ ] T029 Resolve every Review Pass 1 issue, rerun implementation tests and converge, and repeat
  Review Pass 1 after any semantic head change.
- [ ] T030 Sol performs targeted semantic review of the critical diff, strongest counterexample,
  strongest negative, canonical owner, and exactness boundary before Review Pass 2.
- [ ] T031 Reconcile once with fresh main immediately before Review Pass 2; record old/current base,
  overlapping files, semantic/generated overlap, retest requirement, and action.
- [ ] T032 [P] Perform independent Review Pass 2 on current main plus exact head, Spec Kit status,
  graft owner, generated state, dependency direction, moving-main collision, and candidate merge.
- [ ] T033 Resolve every Review Pass 2 issue; invalidate/repeat prior approvals after semantic edits.
- [ ] T034 Run required broad repository/release/truth gates and exact-head CI; classify any red as
  own-change, moving-main, flaky infra, generated drift, ownership, pre-existing baseline, or unknown.
- [ ] T035 Run canonical generated build twice if this lane acquires generated inputs; second build
  must produce zero diff. Never hand-edit generated output.
- [ ] T036 Fetch newest live main and validate the exact candidate merge tree: focused, subsystem,
  release/truth, generated, ownership, and semantic collision checks.
- [ ] T037 Prepare the complete PR/final packet with finding, SHA/base, first divergence, canonical
  graft trace, Spec Kit/convergence, counterexample, negative/provenance/identity/cancel-budget/
  downstream proof, reviews, exact-head CI, candidate tree, and known limitations.
- [ ] T038 Merge only after Sol `APPROVE_MERGE` and expected-head protection; do not treat PR-ready,
  reviewed, or green CI as completion.
- [ ] T039 Refetch live main and post-merge verify merge presence, production behavior, all
  regressions, generated currency, no immediate collision, and Spec Kit ledger; record `RESULT: PASS`.

## Dependencies and Execution Order

- T001–T004 are blocking preflight/proof tasks; T005 is the Sol implementation gate.
- T006–T009 are foundational and block all user-story production tasks.
- T010–T013 and T016–T019/T022 are test-first tasks and may be prepared in parallel only when
  they touch disjoint test sections; all must fail or expose the pre-fix gap before implementation.
- T014–T015 precede T020–T021 and T023–T024.
- T025–T027 follow implementation and precede independent reviews.
- T028–T033 are sequential review gates; any semantic edit invalidates prior approvals.
- T034–T039 are final integration/merge/post-merge gates.

`C1-02` is not a dependency to reopen. If current-main evidence reveals a direct C2-01 regression,
record it explicitly and escalate to Sol; do not add unrelated range analysis here.

## Requirement and success-criterion traceability

- `FR-001` → T006, T014, T023; `FR-002` → T006, T010, T014; `FR-003` → T011, T012, T014.
- `FR-004` → T010, T014, T015; `FR-005` → T012, T014; `FR-006` → T016, T017, T020, T021.
- `FR-007` → T007, T009, T018, T020; `FR-008` → T008, T019, T020; `FR-009` → T009, T013.
- `FR-010` → T015, T022, T023, T024; `FR-011` → T011, T015; `FR-012` → T010–T013, T016–T019,
  T026; `FR-013` → T001, T002, T037.
- `SC-001` → T010–T012; `SC-002` → T016–T019; `SC-003` → T020, T026; `SC-004` → T013.
- `SC-005` → T022–T024; `SC-006` → T008, T019; `SC-007` → T026, T034; `SC-008` → T027–T039.
