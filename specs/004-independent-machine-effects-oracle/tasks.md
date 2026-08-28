---
description: "Task list for an independent offline MachineEffects oracle"
---

# Tasks: Independent MachineEffects Oracle

**Input**: Design documents from `/specs/004-independent-machine-effects-oracle/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/evidence-v1.md,
quickstart.md

**Tests**: T0/T1/T2 tests are explicitly required by the feature specification. Long
architecture-wide suites are deferred until the early evidence contract is approved.

**Organization**: Tasks are grouped by user story so each story can be implemented and reviewed
independently after the foundational evidence contract is complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it uses a different file and has no dependency on incomplete
  tasks.
- **[Story]**: Required for user-story tasks and maps to the corresponding spec journey.
- Every task names an exact file path. Existing production effects, expected tables, A2 denominator,
  C0-01 manifest/profile, downstream engines, workflows, and generated output are read-only.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the offline ownership surface and deterministic seed evidence without
touching production semantics.

- [X] T001 [P] Freeze the v1 profile, authority-role, resource-budget, and forbidden-path policy in `tools/validation/machine-effects/oracle-policy.mjs`
- [X] T002 [P] Add the deterministic add counterexample seed and independent expected-state fixture inputs in `tests/machine-effects/fixtures/independent-oracle-cases.mjs`
- [X] T003 [P] Create the versioned case/result/provenance schema module skeleton in `tools/validation/machine-effects/oracle-schema.mjs`

**Checkpoint**: Offline ownership, profile inventory, required counterexample, and contract files
are present; no production or generated file is changed.

---

## Phase 2: Foundational (Blocking Evidence Contract)

**Purpose**: Build strict identity, mask, status, and adapter boundaries before any user-story
proof can be promoted.

**⚠️ CRITICAL**: No user-story implementation may be accepted until this phase preserves
independence and explicit uncertainty.

- [X] T004 Implement canonical normalization, schema validation, and digest-derived identities for cases and results in `tools/validation/machine-effects/oracle-schema.mjs`
- [X] T005 Implement machine-state shape, width, outcome, and per-observable defined-mask validation in `tools/validation/machine-effects/oracle-schema.mjs`
- [X] T006 Define bounded execution, cancellation, and explicit non-pass state handling in `tools/validation/machine-effects/oracle-runner.mjs`
- [X] T007 Define the external oracle adapter contract, distinct identity requirements, and offline/network policy in `tools/validation/machine-effects/oracle-runner.mjs`
- [X] T008 Implement a read-only A2 denominator snapshot/preservation boundary in `tools/validation/machine-effects/oracle-report.mjs`
- [X] T009 [P] Add ownership and authority-separation regression fixtures covering production evaluator, expected tables, C0-01, A2, workflow, and generated-output exclusions in `tests/machine-effects/independent-oracle-ownership.test.mjs`

**Checkpoint**: Case/result/provenance schemas reject malformed and identity-invalid inputs;
non-pass states cannot become pass by omission; production and denominator authority remain
separate.

---

## Phase 3: User Story 1 - Prove deterministic instruction state independently (Priority: P1) 🎯 MVP

**Goal**: Compare one deterministic legal add instruction against independently generated expected
register/flag/vector state and a defined-state mask, preserving the pre-fix failure.

**Independent Test**: Run T0 before implementation and observe the release-grade proof fail. After
implementation, run the same case with a distinct oracle identity and require one
`exact/equivalent` result with all required identities present.

### Tests for User Story 1 (write first and observe failure)

- [X] T010 [P] [US1] Add the pre-fix release-grade failing assertion for the deterministic add case in `tests/machine-effects/independent-oracle-counterexample.test.mjs`
- [X] T011 [P] [US1] Add non-production expected register, flag, vector state, defined-mask, ISA authority, and oracle identity fixtures in `tests/machine-effects/fixtures/independent-oracle-cases.mjs`

### Implementation for User Story 1

- [X] T012 [US1] Implement normalized corpus-case construction and stable case identity in `tools/validation/machine-effects/oracle-corpus.mjs` using the schema contract from T004-T005
- [X] T013 [US1] Implement the bounded offline oracle adapter invocation and observation capture in `tools/validation/machine-effects/oracle-runner.mjs`
- [X] T014 [US1] Implement masked register, flag, vector, and outcome comparison with distinct-oracle enforcement in `tools/validation/machine-effects/oracle-runner.mjs`
- [X] T015 [US1] Emit the positive exact/equivalent result with comparison counts, provenance, and identity fields in `tools/validation/machine-effects/oracle-report.mjs`
- [X] T016 [US1] Complete the post-implementation positive and pre-fix counterexample assertions in `tests/machine-effects/independent-oracle-counterexample.test.mjs`

**Checkpoint**: User Story 1 proves the smallest deterministic case independently; a defined-bit
mismatch blocks, and production self-agreement cannot satisfy the result.

---

## Phase 4: User Story 2 - Reject untrustworthy oracle evidence (Priority: P1)

**Goal**: Fail closed on forged, malformed, partial, undefined, stale, unavailable, cancelled,
and resource-limited evidence without creating false passes.

**Independent Test**: Run the required negative matrix and deterministic replay tests. Every
negative fixture must reject or remain blocking with an explicit reason and zero pass contribution.

### Tests for User Story 2 (write first)

- [X] T017 [P] [US2] Add negative fixtures for production-derived expected values/provenance and oracle identity/version mismatch in `tests/machine-effects/independent-oracle-negative.test.mjs`
- [X] T018 [P] [US2] Add negative fixtures for undefined bits marked defined, malformed schema, unknown fields, missing fields, truncated state, inconsistent lengths, and invalid digests in `tests/machine-effects/independent-oracle-negative.test.mjs`
- [X] T019 [P] [US2] Add unavailable, unsupported, not-integrated, cancelled, and budget-exhaustion assertions in `tests/machine-effects/independent-oracle-negative.test.mjs`
- [X] T020 [P] [US2] Add two-run byte-identical replay and stale-identity assertions in `tests/machine-effects/independent-oracle-determinism.test.mjs`

### Implementation for User Story 2

- [X] T021 [US2] Enforce strict unknown-field, required-field, duplicate-ID, shape, digest, and partial-artifact rejection in `tools/validation/machine-effects/oracle-schema.mjs`
- [X] T022 [US2] Enforce authority provenance, production-subject exclusion, and distinct oracle identity validation in `tools/validation/machine-effects/oracle-policy.mjs`
- [X] T023 [US2] Enforce undefined/unpredictable mask rules and explicit trap, fault, exception, and equivalent-outcome handling in `tools/validation/machine-effects/oracle-runner.mjs`
- [X] T024 [US2] Enforce bounded input/output/time/memory policy, cancellation propagation, and bounded diagnostics in `tools/validation/machine-effects/oracle-runner.mjs`
- [X] T025 [US2] Emit deterministic replay identities and explicit non-pass classifications in `tools/validation/machine-effects/oracle-report.mjs`

**Checkpoint**: Every required trust and uncertainty negative case is blocking or rejected; no
undefined bit, missing tool, stale identity, or partial artifact can count as pass.

---

## Phase 5: User Story 3 - Preserve honest coverage and release traceability (Priority: P2)

**Goal**: Report four current profiles, real-ISA/oracle provenance, explicit gaps, denominator
preservation, and exact product/candidate identity without promoting declarations to semantic truth.

**Independent Test**: Generate the profile report, compare the A2 denominator before/after, and
run exact-head and candidate-merge-tree verification on the actual expected SHA.

### Tests for User Story 3 (write first)

- [X] T026 [P] [US3] Add profile inventory, real-ISA authority, and explicit unsupported/unavailable gap assertions in `tests/machine-effects/independent-oracle-report.test.mjs`
- [X] T027 [P] [US3] Add A2 ID/row/count/digest preservation assertions in `tests/machine-effects/independent-oracle-denominator-preservation.test.mjs`
- [X] T028 [P] [US3] Add product/base/candidate-tree, verifier, corpus, oracle, toolchain, and generated-identity binding assertions in `tests/machine-effects/independent-oracle-report.test.mjs`

### Implementation for User Story 3

- [X] T029 [US3] Implement four-profile summaries, explicit gaps, and authority-role reporting in `tools/validation/machine-effects/oracle-report.mjs`
- [X] T030 [US3] Implement read-only A2 denominator comparison and fail-closed preservation result in `tools/validation/machine-effects/oracle-report.mjs`
- [X] T031 [US3] Implement exact product/base/candidate-tree, verifier, corpus, oracle, toolchain, and generated-identity binding in `tools/validation/machine-effects/oracle-report.mjs`
- [X] T032 [US3] Add the release-facing offline report verifier entry point and identity checks in `tools/validation/machine-effects/oracle-release-verify.mjs`
- [X] T033 [US3] Complete profile, gap, denominator, and identity report assertions in `tests/machine-effects/independent-oracle-report.test.mjs` and `tests/machine-effects/independent-oracle-denominator-preservation.test.mjs`

**Checkpoint**: Four-profile evidence is explicit, A2 remains byte-for-byte preserved, and release
reports are bound to one exact product or candidate merge tree.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Run the short validation sequence and prepare integration-owned evidence without
changing forbidden production, workflow, C0-01, denominator, or generated files.

- [ ] T034 [P] Run the T0 counterexample and T1 negative/replay commands from `specs/004-independent-machine-effects-oracle/quickstart.md` and record exact counts in the feature evidence
- [ ] T035 [P] Run the T2 profile/report/denominator commands from `specs/004-independent-machine-effects-oracle/quickstart.md` and record explicit gaps and counts in the feature evidence
- [ ] T036 Review the actual changed-file inventory against the offline allowlist in `tests/machine-effects/independent-oracle-ownership.test.mjs`
- [ ] T037 Run the permanent exact-head verifier from `tools/validation/machine-effects/oracle-release-verify.mjs` against the frozen branch head and record verifier/corpus/oracle/toolchain identities
- [ ] T038 Build the actual candidate merge tree through the Sol integration lane, rerun applicable owned gates against that tree, and record its SHA in `specs/004-independent-machine-effects-oracle/quickstart.md`
- [ ] T039 Reconcile moving `main`, canonical generated output, required CI, and post-merge live-main verification through Sol; update only the durable feature evidence under `specs/004-independent-machine-effects-oracle/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No implementation dependency; establishes the owned offline surface and
  frozen seed evidence.
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Phase 2; delivers the MVP counterexample and positive
  independent comparison.
- **User Story 2 (Phase 4)**: Depends on the schemas and runner from Phases 2-3; may harden shared
  validation while preserving the US1 contract.
- **User Story 3 (Phase 5)**: Depends on the complete result/report boundary from Phases 2-4; adds
  profile, denominator, and release traceability.
- **Polish (Phase 6)**: Depends on all desired stories and Sol's integration readiness.

### User Story Dependencies

- **User Story 1 (P1)**: Depends only on Foundational; MVP can be reviewed independently.
- **User Story 2 (P1)**: Depends on Foundational and the US1 comparison envelope; its negative
  matrix is independently testable and must not weaken US1.
- **User Story 3 (P2)**: Depends on the result/report contract and read-only A2 input; it does not
  change production MachineEffects or C0-01.

### Within Each User Story

- Tests must be written and observed failing before the corresponding implementation task.
- Schema and identity rules precede comparison and report publication.
- No non-pass result may be converted to pass by dropping fields or shrinking the denominator.
- Exact-head and candidate-merge-tree evidence are separate gates and both are required for
  promotion.

### Parallel Opportunities

- T001, T002, and T003 can run in parallel because they use disjoint policy, fixture, and schema
  files.
- T009 can run in parallel with T004-T008 after the policy boundary is agreed.
- T010/T011 can run in parallel; T017-T020 can run in parallel; T026-T028 can run in parallel.
- T034-T036 are read-only/validation tasks that can run in parallel after implementation.
- No task touching the same file may run in parallel with another task touching that file.

## Parallel Example: User Story 1

```text
1. T010: Write the pre-fix deterministic add failure in tests/machine-effects/independent-oracle-counterexample.test.mjs.
2. T011: Prepare the independent expected-state fixture in tests/machine-effects/fixtures/independent-oracle-cases.mjs.
3. Observe the T0 failure before T012-T015 implementation.
4. Implement T012-T015 sequentially across corpus, runner, and report boundaries.
5. Run T016 to prove the same case now passes only with distinct oracle identity and defined-mask evidence.
```

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Setup and Foundational phases, including the pre-fix T0 fixture.
2. Run T010 and preserve its expected release-grade failure.
3. Implement T012-T015 without modifying production MachineEffects or expected tables.
4. Run T016 and stop for review if the positive result lacks distinct identity, mask, or provenance.

### Incremental Delivery

1. Add User Story 1 and prove the deterministic add case independently.
2. Add User Story 2 and prove every required fail-closed negative and deterministic replay.
3. Add User Story 3 and prove profile gaps, A2 preservation, and exact release identities.
4. Run T0/T1/T2, exact-head, and candidate-tree gates through Sol before any release promotion.

### Integration Handoff

Sol alone reconciles moving `main`, owns committed generated output, dispatches required CI, proves
the candidate merge tree, merges with expected-head protection, refetches live `main`, and updates
final release evidence. This feature owner must not edit Issue/Gemini lifecycle, production
MachineEffects, C0-01, A2 denominator, workflows, or generated output.

## Notes

- `[P]` means disjoint files and no dependency on incomplete tasks.
- User-story labels map tasks to the three independently testable journeys in spec.md.
- T0 is intentionally failing before implementation; T1/T2 remain bounded early proof, not a
  substitute for later long real-ISA suites.
- The existing `independent-oracle.mjs` scalar/address helpers, compatibility differential
  harness, external-oracle policy, and A2 denominator are read-only subjects/supporting evidence;
  none is silently promoted to ISA truth.
- No task authorizes a second production evaluator, expected-table generation from the subject, or
  denominator deletion/rewriting.
