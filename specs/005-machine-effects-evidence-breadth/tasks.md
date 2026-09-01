# Tasks: MachineEffects Independent Evidence Breadth

## Phase 1: Setup

- [x] T001 Record live origin/main and open-PR overlap in `specs/005-machine-effects-evidence-breadth/research.md`
- [x] T002 Reconcile #2372 and #3059 existing artifacts without production duplication

## Phase 2: Foundational

- [x] T003 Add failing eight-class counterexamples in `tests/machine-effects/evidence-breadth-counterexamples.test.mjs`
- [x] T004 Define V2 architectural evidence validation in `tools/validation/machine-effects/oracle-evidence-v2.mjs`

## Phase 3: User Story 1 - Architectural identity (P1)

- [x] T005 [US1] Add complete/stale/wrong-profile/unsupported/malformed/incomplete tests in `tests/machine-effects/formal-architectural-evidence.test.mjs`
- [x] T006 [US1] Add the four-profile evidence inventory and exact boundary in `tools/validation/machine-effects/oracle-evidence-v2.mjs`

## Phase 4: User Story 2 - Relaxed memory (P1)

- [x] T007 [US2] Add six-ordering outcome and negative matrix in `tests/machine-effects/relaxed-memory-evidence.test.mjs`
- [x] T008 [US2] Enforce atomicity, ordering, and outcome-universe invariants in `tools/validation/machine-effects/oracle-evidence-v2.mjs`

## Phase 5: User Story 3 - Undefined results (P1)

- [x] T009 [US3] Add canonical undefined-result validation in `js/semantics/effects/index.js`
- [x] T010 [US3] Prove transport in `tests/semantic-v2/undefined-result-transport.test.mjs`
- [x] T011 [US3] Preserve the descriptor in `js/semantics/ir/from-machine-effects.js`
- [x] T012 [US3] Add consumer negative coverage in `tests/phase8/scalar/undefined-result-soundness.test.mjs`
- [x] T013 [US3] Block exact folding in `js/decompiler/phase8/sccp.js`

## Phase 6: Generated independent evidence and release boundary

- [x] T014 Generate pinned Isla, Sail RISC-V, herdtools7, and independently executed QEMU artifacts from checked-in source inputs with `tools/validation/machine-effects/generate-formal-evidence.mjs`
- [x] T015 Verify artifact/source/model mutations and claim-local exact boundaries in `tests/machine-effects/generated-formal-evidence.test.mjs`
- [x] T016 Bind every exact report result to recomputable architectural evidence claims in `tools/validation/machine-effects/oracle-report.mjs`
- [x] T017 Preserve undefined-result uncertainty through both legacy compatibility projections and a real x86 producer

## Phase 7: Verification and cutover

- [x] T018 Run focused and canonical MachineEffects/Semantic V2/Phase 8 tests
- [x] T019 Run denominator, lint, generated-output, and full repository gates — executed 2026-09-01 on campaign head (post-merge `fb2fa341` + resync): A2 denominator invariants PASS, lint 1810 files ok, generated output rebuilt canonically (serial `2322242130`, second build zero diff), `npm run effects:test` PASS, `tests/machine-effects/` 163/163; full-repo red classification: `arm64-compiler-truth`/`semantic-v2` compiler-truth O0 = pre-existing baseline #3120 (other lane `fix/compiler-truth-o0-symbolic-stack-forwarding-run12`), not this lane
- [x] T020 Perform three adversarial review passes and repair findings
- [x] T021 Reconcile current main and verify the candidate merge tree
- [x] T022 Update `docs/analysis-improvement-finding-ledger.md` with exact evidence and honest COMPLETE/PARTIAL state
- [ ] T023 Create one PR, verify exact-head CI/reviews, merge if all gates are green, and refetch live main

## Dependencies & Execution Order

T003 precedes T004-T017. Contract T009 precedes transport T011, which precedes consumers T013/T017. T014-T017 bind generated independent evidence before the sequential T018-T023 release gates.

## Implementation Strategy

Implement the failing counterexample denominator first, then canonical contract → transport → consumer → release evidence. Unsupported profiles remain explicit rather than delaying or weakening the supported subset.
