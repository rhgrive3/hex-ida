---

description: "Dependency-ordered closure ledger for HEX-C1-01 loaded-pointer recovery"
---

# Tasks: Loaded-Pointer Recovery

**Input**: Design documents from `/specs/001-loaded-pointer-recovery/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/loaded-pointer-boundary.md`, `quickstart.md`

**Tests**: Deterministic counterexample-first positive, negative, boundary, malformed, cancellation, budget, replay, downstream, exact-head, and candidate-tree proof are mandatory.

**Organization**: Tasks are grouped by user story. One Luna implementation owner executes the shared semantic-contract tasks; Sol retains ownership, integration, verification, PR, and merge authority.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: May run in parallel only when the named files and dependencies are disjoint.
- **[Story]**: Maps the task to the corresponding specification user story.
- Every task names its evidence or changed-file path.

## Phase 1: Setup and Current-Main Ownership

**Purpose**: Freeze the source of truth and machine-check the allowed change inventory before fanout.

- [X] T001 Record exact live-main SHA, open-PR collision result, active branch/PR, and current classification in `docs/analysis-improvement-finding-ledger.md`
- [X] T002 Add or tighten the actual-inventory ownership regression for the C1-01 allowlist in `tests/phase7/ownership/manifest.test.mjs` or a narrower new file under `tests/phase7/ownership/`

---

## Phase 2: Foundational Counterexample and Boundary Fixtures

**Purpose**: Establish the smallest deterministic pre-fix failure and reusable canonical IR/MemorySSA fixtures before production edits.

**⚠️ CRITICAL**: The positive test must fail with `unresolved-load` on the recorded base before T004 begins. Negative behavior must remain conservative.

- [X] T003 Create the exact store-pointer/load-pointer counterexample and canonical boundary fixture in `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs`, run it pre-fix, and record the expected failure in `specs/001-loaded-pointer-recovery/quickstart.md`

**Checkpoint**: Current-main failure is proven and no production source has changed.

---

## Phase 3: User Story 1 - Recover a Proven Loaded Pointer (Priority: P1) 🎯 MVP

**Goal**: Recover the stored finite pointer set only through one current, complete, byte-exact canonical MemorySSA proof.

**Independent Test**: The focused positive and field-offset cases recover exactly the stored targets, offsets, widths, identities, and provenance; two identical runs have identical result and proof identity.

### Tests for User Story 1

- [X] T004 [US1] Extend `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs` with exact target/offset/width/provenance and deterministic-replay assertions that fail before implementation

### Implementation for User Story 1

- [X] T005 [US1] Implement the bounded, identity-valid MemorySSA load/use/store lookup and exact eligibility transfer in `js/analysis/pointsto/local.js`
- [X] T006 [US1] Stage baseline and post-MemorySSA points-to runs with atomic complete-only publication and escape-cache invalidation in `js/analysis/alias/solver.js`
- [X] T007 [US1] Bind the existing current MemorySSA artifact and snapshot/function identity into the canonical solver through `js/analysis/index.js` and, only if required, constrained routing in `js/semantics/compat/index.js`

**Checkpoint**: User Story 1 passes independently without a MemorySSA rebuild or second memory authority.

---

## Phase 4: User Story 2 - Keep Unproven Loads Unresolved (Priority: P1)

**Goal**: Preserve explicit conservative behavior at every alias, byte, provenance, freshness, completeness, malformed, cancellation, and resource boundary.

**Independent Test**: Vary each eligibility fact one at a time; every case publishes zero precise targets and never leaks a partially staged refined map.

### Tests for User Story 2

- [X] T008 [US2] Add MayAlias, unknown-alias/clobber, incomplete-call, multiple-definition, phi, partial-byte, width/endian, provenance, volatile, and atomic negative cases to `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs`
- [X] T009 [US2] Add stale snapshot/function/build/source-entity and malformed access-metadata cases to `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs`
- [X] T010 [US2] Add cancellation, iteration/value/target budget, truncation, no-partial-publication, and deterministic degradation cases to `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs`

### Implementation for User Story 2

- [X] T011 [US2] Complete fail-closed diagnostics, identity validation, cancellation checkpoints, and bounded index/publication behavior in `js/analysis/pointsto/local.js` and `js/analysis/alias/solver.js`

**Checkpoint**: User Stories 1 and 2 pass together with zero false certainty.

---

## Phase 5: User Story 3 - Preserve Canonical Ownership and Consumers (Priority: P2)

**Goal**: Existing consumers observe the refined canonical points-to fact without private recovery logic or ownership drift.

**Independent Test**: One existing analysis-surface consumer improves on the positive case and remains conservative on the paired negative; the actual inventory contains no forbidden or unrelated Issue-Agent path.

### Tests for User Story 3

- [X] T012 [US3] Add paired downstream analysis-surface positive/negative assertions to `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs`
- [X] T013 [US3] Run the ownership regression and exhaustive duplicate-owner search, recording results in `docs/analysis-improvement-finding-ledger.md`

### Integration for User Story 3

- [X] T014 [US3] Run the focused test twice and record exact case counts, deterministic replay, unchanged denominators, and no weakened assertions in `docs/analysis-improvement-finding-ledger.md`

**Checkpoint**: All user stories are independently proven and the implementation inventory is ownership-clean.

---

## Phase 6: Cross-Cutting Verification, Convergence, and Merge

**Purpose**: Bind implementation completeness and release evidence to the exact product that is merged.

- [X] T015 Run changed-module syntax checks, lint, and Phase 7 ownership validation from `specs/001-loaded-pointer-recovery/quickstart.md`
- [X] T016 Run Phase 7, Semantic V2, and Phase 8 subsystem/downstream suites from `specs/001-loaded-pointer-recovery/quickstart.md` and record exact results in `docs/analysis-improvement-finding-ledger.md`
- [ ] T017 Execute `/speckit.converge`, append any unmet work to `specs/001-loaded-pointer-recovery/tasks.md`, and repeat implement/converge until CONVERGED
- [ ] T018 Refetch live main, recheck open-PR/Issue-Agent collision against the actual file inventory, reconcile once through Sol, and record the new base relationship in `docs/analysis-improvement-finding-ledger.md`
- [ ] T019 Regenerate `userscript/hex.user.template.js` and `userscript/release-version.json` only with the canonical builder, then prove a second build has zero diff
- [ ] T020 Run the Phase 7 verifier against the exact branch head and record source SHA, verifier/runtime identity, corpus identity, and result in `docs/analysis-improvement-finding-ledger.md`
- [ ] T021 Build the actual candidate merge tree against freshly fetched main, run applicable owned gates on that exact tree, and record its SHA/results in `docs/analysis-improvement-finding-ledger.md`
- [ ] T022 Complete Sol final diff/soundness review, required GitHub CI, expected-head merge of PR evidence, post-merge live-main verification, and final C1-01 `MERGED` entry in `docs/analysis-improvement-finding-ledger.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001–T002)**: T001 freezes ownership and collision truth; T002 machine-enforces the actual allowlist before worker fanout.
- **Foundational (T003)**: Depends on T001–T002 and blocks every production edit.
- **User Story 1 (T004–T007)**: T004 fails first; T005 precedes T006; T006 precedes T007 publication wiring.
- **User Story 2 (T008–T011)**: Negative tests T008–T010 may be authored after the shared fixture exists, but T011 cannot complete until T005–T007 exist.
- **User Story 3 (T012–T014)**: Depends on the canonical publication path from User Stories 1–2.
- **Release (T015–T022)**: Sequential stable-candidate proof; T017 may append work and return execution to the relevant earlier phase.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after the foundational counterexample and supplies the only production semantic bridge.
- **User Story 2 (P1)**: Shares the same implementation owner and extends User Story 1 with fail-closed boundaries; it is not a competing implementation lane.
- **User Story 3 (P2)**: Consumes the completed canonical result and does not add private recovery logic.

### Worker Ownership

- **Luna implementation owner**: T003–T012. Allowed files are exactly `js/analysis/pointsto/local.js`, `js/analysis/alias/solver.js`, `js/analysis/index.js`, optional constrained `js/semantics/compat/index.js`, and `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs`. The worker may update `quickstart.md` only for the recorded pre-fix result.
- **Sol integration owner**: T001–T002 and T013–T022, all ledger/spec/task state, generated artifacts, PR/CI interpretation, reconciliation, candidate proof, merge, and post-merge verification.
- **Forbidden to every worker**: `js/semantics/{memoryssa,ssa,ir,cfg}/**`, `js/targets/**`, `js/decompiler/**`, `js/symbolic/**`, `js/core/identity/**`, Issue branches/PRs/lifecycle, generated artifacts, task ownership changes, test weakening, denominator shrinking, and merge actions.

### Parallel Opportunities

- No production semantic-contract task is parallelized across workers.
- Sol may perform read-only collision monitoring after T001 while the single Luna owner executes T003–T012.
- T013 ownership inspection remains Sol-owned and may begin only after the worker's final inventory is stable.

## Parallel Example: Safe Supervision During User Stories 1–2

```text
Luna Max: T003–T012 in the exact allowed implementation/test files, sequentially counterexample-first.
Sol: read-only live-main/open-PR collision monitoring; no edits to the worker-owned files.
```

## Implementation Strategy

### MVP First (User Story 1)

1. Complete T001–T003 and preserve the failing pre-fix evidence.
2. Complete T004–T007 through `/speckit.implement`.
3. Run the focused positive proof without promoting or merging.
4. Complete the mandatory fail-closed and consumer stories before release.

### Incremental Closure

1. Positive exact forwarding: T004–T007.
2. Conservative boundary matrix: T008–T011.
3. Canonical consumer and ownership proof: T012–T014.
4. Convergence and exact-product proof: T015–T022.

## Notes

- Every task remains incomplete until its exact evidence exists; partial work is not rounded up.
- Tests are written and observed failing before the production task they guard.
- One implementation owner holds the C1-01 semantic contract; Sol alone integrates and merges.
- No task authorizes unrelated cleanup, Issue work, capability inflation, private semantic truth, or generated-file hand edits.
