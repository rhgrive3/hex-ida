# Implementation Plan: HEX-C3-02 ABI Aggregate/Prototype Unification

**Branch**: `feat/analysis-hex-c3-02-abi-unification` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-abi-aggregate-prototype-unification/spec.md`

## Summary

HEX-C3-02 closes the remaining ABI/prototype semantic divergence after PR
#2499. The canonical `js/targets/abi/**` classifiers now select the correct
profile for scalar and several aggregate cases, but the decompiler prototype
consumer still accepts adapters by `id` without validating semantic identity,
flattens multi-register aggregate arguments into independent physical values,
and drops aggregate return piece metadata. The implementation will make the
canonical classifier and `semanticAbiAdapter` the only source of ABI argument,
return, aggregate, hidden-result, stack, and variadic placement facts.
Prototype, summary, type-recovery, and decompiler projections will consume a
provenance-bearing ABI classification and publish unknown/partial results when
identity, support, or completeness is insufficient. PR #2499 merged as
`be5636b1`; the historical implementation checkpoint was reconciled to live
main `48a0b429`. The implementation-owner branch was subsequently restacked
from fetched `origin/main` `204c82de` with the prior merge commit's unrelated
main-side changes excluded; the refreshed counterexample plan received Sol
approval before implementation.

## Technical Context

**Language/Version**: JavaScript ES modules, Node.js 20+ (repository runtime)

**Primary Dependencies**: canonical ABI plugins in `js/targets/abi/**`,
`semanticAbiAdapter`, Semantic IR/decompiler pipeline, Node built-in test runner

**Storage**: N/A; ABI evidence is immutable analysis output scoped to a run

**Testing**: `node --test` focused phase tests, owning ABI/decompiler suites,
phase/release truth gates, canonical generated-output checks, exact-head CI

**Target Platform**: Node.js analysis/decompiler runtime; supported target
profiles include Apple arm64/arm64e, AAPCS64, x86_64 SysV/Microsoft/vectorcall,
and RISC-V LP64 variants

**Project Type**: architecture-neutral binary analysis and decompiler library

**Performance Goals**: preserve existing bounded analysis behavior; prototype
recovery must not add unbounded profile/classification walks or a second global
analysis pass

**Constraints**: exact profile identity; explicit unsupported/partial/unknown;
fail closed on ambiguous aggregates; cancellation, truncation, budget, malformed
and stale evidence cannot publish complete exact ABI placement; no private ABI
classifier, architecture-name heuristic, or generated-artifact hand edit

**Scale/Scope**: shared ABI classifier/adaptor and its direct prototype/summary/
decompiler consumers; locked profile matrix and phase8 regressions, with no
unrelated architecture or type-system redesign

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **One canonical semantic truth**: PASS. ABI facts remain owned by the ABI
  plugins and shared Semantic IR adapter; downstream projections only consume
  classified evidence.
- **Explicit uncertainty and fail-closed analysis**: PASS. Unsupported,
  ambiguous, stale, cancelled, truncated, and budget-limited evidence is not
  promoted to exact placement or prototype facts.
- **Deterministic proof and counterexamples**: PASS for the historical baseline
  and current correction. The original RISC-V/unsupported-ABI regression is
  green after #2499, so it is not reused as a fabricated fix. Current main
  has independently reproduced stale-identity and aggregate-grouping failures
  in the revised phase8 regression and locked profile matrix.
- **Bounded, cancellable, portable analysis**: PASS. The plan preserves ABI
  plugin boundedness and propagates identity/completeness/cancellation state.
- **Exact product/integration proof**: PASS pending delivery gates. Exact-head
  CI, current-main reconciliation, candidate merge-tree validation, and
  post-merge live-main verification are required.
- **External ownership collision**: RECONCILIATION GATE, not a constitution
  violation. PR #2499 merged as `be5636b1` after directly editing the canonical
  prototype owner and its integration test surface. Production implementation
  remains forbidden until the branch is restacked/re-audited and Sol clears it.

## Project Structure

### Documentation (this feature)

```text
specs/002-abi-aggregate-prototype-unification/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/abi-prototype.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
js/targets/abi/                       # canonical ABI profiles/classifiers
js/analysis/semantic-function-base.js # shared ABI adapter boundary
js/analysis/semantic-function.js      # profile selection and identity
js/semantics/compat/                  # Semantic IR compatibility publication
js/decompiler/types/prototype.js      # downstream prototype projection
js/decompiler/types/layout.js         # downstream aggregate layout projection
js/decompiler/pipeline-core.js        # publication/orchestration
js/decompiler/type-recovery.js        # type/ABI evidence consumer
js/decompiler/semantic-core.js        # call/return consumer
tests/phase5/abi/                     # existing ABI contracts
tests/phase6/abi/                     # existing profile/PSABI contracts
tests/phase8/abi/                     # HEX-C3-02 profile regressions
tests/phase8/integration/             # downstream integration contracts
```

**Structure Decision**: Keep canonical classification in the existing ABI
plugin/adaptor boundary and test the downstream projection through phase8 ABI
and integration contracts. No new semantic engine or ABI owner is introduced.

## Architecture and Ownership

```text
architecture/profile identity
  -> resolveABIPlugin
  -> canonical ABI classifier (arguments / returns / aggregate pieces)
  -> semanticAbiAdapter (identity + provenance + completeness)
  -> call Semantic IR / summaries
  -> prototype, type, layout, and decompiler projections
  -> cache/invalidation and verifier/test evidence
```

`SECOND_SEMANTIC_TRUTH_CREATED: NO`.

The canonical ABI object is identified by its profile id, semantic version,
architecture id, platform predicate, and calling convention. Every downstream
exact placement must retain the source identity and completeness boundary. The
prototype projection must not infer an ABI from register spelling or substitute
an AAPCS64 default when the selected profile is unsupported or unknown.

## Phase 0 — Research and Proof Baseline

1. Record the collision preflight against live `origin/main` and GitHub
   `rhgrive3/hex-ida`: PR #2499 (`b12ccf...`) merged as
   `be5636b1baeadfaef5ae10d81406f02118dca780` after owning
   `js/decompiler/types/prototype.js`; merged PR #2500 is already in the base.
2. Trace the producer/consumer boundary and profile matrix. Audit Apple arm64,
   arm64e matching behavior, AAPCS64, SysV AMD64, Microsoft x64/vectorcall,
   and RISC-V LP64/LP64F/LP64D without changing code.
3. Run the deterministic baseline test in
   `tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs` at the base SHA and
   preserve the failing output as `PRE_FIX_FAILURE`; no expected value is
   sourced from the implementation.
4. Resolve all planning unknowns in `research.md`, including the current-main
   profile matrix and the first remaining consumer divergence after #2499.

## Phase 1 — Design Contracts

1. Define the ABI classification evidence object and its invalidation rules in
   `data-model.md`; it must distinguish exact, partial, unsupported, unknown,
   stale, cancelled, truncated, and budget-limited states.
2. Document the downstream contract in `contracts/abi-prototype.md`: profile
   identity, argument/return pieces, hidden sret, aggregate boundaries,
   variadic frontier, stack/alignment/padding, caller/callee agreement, and
   fail-closed behavior.
3. Record runnable validation commands and expected results in `quickstart.md`.
4. Re-run the Spec Kit analyze gate after the current-main correction. The
   refreshed `ANALYZE_RESULT` must be CLEAN before production implementation;
   the merged #2499 head and current-main ownership inventory remain separate
   delivery gates.

## Phase 2 — Implementation Boundary

1. After Sol clears the collision and approves the refreshed checkpoint,
   reconcile to newest live main and re-run collision preflight.
2. Preserve the merged #2499 changes; modify only the canonical ABI
   adapter/consumer boundary and owned phase8 tests. Do not create a decompiler-
   private classifier.
3. Implement profile-driven argument and return projection, including aggregate
   pieces, split register/stack locations, hidden sret, HFA/HVA, variadic
   frontiers, and exact/partial/unknown publication. Propagate identity,
   provenance, completeness, invalidation, cancellation, budget, and stale
   evidence.
4. Run the required positive matrix and paired negative matrix, then run
   Spec Kit converge until CLEAN. Any generated output is rebuilt only through
   its canonical generator.

## Phase 3 — Verification and Delivery

1. A non-owner Luna performs adversarial Review Pass 1 with fresh malformed,
   stale, incomplete/cancelled, ambiguous, and boundary checks plus aggregate,
   sret, ABI mismatch, vararg, and profile attacks.
2. Sol performs the targeted semantic review. Any semantic fix invalidates both
   review approvals and requires tests plus converge and a fresh Review 1.
3. Reconcile once with newest main, then a different non-owner Luna performs
   independent Review Pass 2 covering ownership, generated artifacts, moving
   main, exact-head CI, and the candidate merge structure.
4. Run T0–T3 gates, exact intended-head CI, canonical generator twice, and
   candidate merge-tree validation against newest live main. Merge only after
   Sol's final `APPROVE_MERGE` packet.
5. Verify the merge on live main: production path, regressions, generated state,
   no immediate collision, Spec Kit ledger, and post-merge test must all pass.

## Required Evidence Records

`ANALYZE_RESULT: CLEAN` — after the correction below, cross-artifact review
must find no unresolved clarification, placeholder, constitution,
requirement-coverage, task-order, or canonical-ownership inconsistency. The
merged #2499 reconciliation and current-main matrix are explicit delivery
gates represented in both plan and tasks, not unresolved design ambiguities.
The refreshed read-only Spec Kit analysis found no such inconsistency;
`ANALYZE_RESULT: CLEAN`. Sol's implementation spot-check approved the
canonical-owner, counterexample, and fail-closed boundary before production
edits.

```text
HISTORICAL_PRE_FIX_SHA: 8a614ccd0184d6c25257c25d930b68af7e9ac81f
HISTORICAL_PRE_FIX_COMMAND: node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
HISTORICAL_PRE_FIX_FAILURE: RISC-V adapter still reports AAPCS64; unsupported
                             ABI lacks explicit unknown contract (exit 1)
HISTORICAL_CURRENT_MAIN_SHA: 48a0b42913e63f33a03783f9676994268d8a06e8
CURRENT_PRE_FIX_COMMAND: node --test tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs
CURRENT_PRE_FIX_FAILURE: 2 of 4 subtests fail: stale aapcs64@1 is accepted as
                         supported; canonical AAPCS64 x0/x1 aggregate is
                         flattened into two prototype arguments (exit 1)
CURRENT_MATRIX_COMMAND: node tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
CURRENT_MATRIX_RESULT: 66 rows; 54 PASS, 12 FAIL, all 12 in prototype
                       identity/aggregate projection (exit 1)
POST_FIX_SHA: 439816bf34c1e26d0039c1126f33b1b85f90a06e (code restack head)
POST_FIX_COMMAND: same focused command plus required profile/subsystem gates
POST_FIX_PASS: focused matrix (44 tests), downstream-inclusive focused matrix
               (45 tests), 66-row matrix, Phase 5 (279 tests), Phase 6 (116
               tests), and Phase 8 (322 tests) pass; no generated double-run
               applies because no generated input/consumer changed
```

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | N/A | The plan uses the existing canonical ABI plugin and adapter boundary. |
