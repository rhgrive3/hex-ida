---
description: "Dependency-ordered execution ledger for recovery and analysis final closure"
---

# Tasks: Recovery and Analysis Final Closure

**Input**: Design and evidence documents in `/specs/005-analysis-final-closure/`

**Tests**: Counterexample-first focused, negative, boundary, adversarial,
metamorphic, differential, budget, cancellation, deterministic, integration,
exact-head, candidate-tree, runtime/browser/device, and post-merge proof are
required as applicable.

**Execution rule**: The checkbox and `Status` change only from actual evidence.
Every task uses one implementation owner. Workers do not spawn workers. SOL Ultra
is the living integration, generated-output, merge, and final evidence owner.
`contracts/task-ownership.json` MUST contain exactly one nonempty
`forbiddenOverlap` entry for every task ID. A missing, duplicate, empty, or
concurrently violated entry blocks task assignment and promotion; sequential path
reuse requires its dependency owner's completed exact-tree handoff.

**Frozen performance locks**:

- **P-COMPETITIVE** (`tests/benchmark-baseline.json`,
  `tools/validation/competitive/profile.json`): for each exact fixture SHA
  (`battlecats` `567234909b2a33d62548257c4148290d9215d7edf414fa17c6b06fcf8c7cdf13`,
  `TsumTsum` `4f877bb1d4e1503b439ce07c601a1fddd6a38a6f32395bfd3071b056f77839b3`,
  `YWP` `cd1c72a30ba29f423a670f9e534c8865689ca09890769a95822869c162d240a6`),
  `loaderRangeReads` (reads) and
  `loaderRequestedBytes` (bytes) MUST be `candidate <= 1.05 * baseline` on the
  locked three-sample Node 22/ubuntu-linux denominator. The device-class
  `universal-binary-hotpath-ms` metric is milliseconds with
  `candidate <= 1.05 * same-fixture locked reference`; it cannot pass while its
  same-binary ground-truth/reference identity is `UNMEASURED`.
- **P-PHASE8** (`tools/validation/phase8/profile.json` v3): three repetitions,
  median milliseconds on `ci-linux-x64`; `coldActiveFunction <= 250`,
  `phase8InteractiveStage <= 5`, and `phase8OptimizeStage <= 120`; all named
  hard-zero counters equal zero on the profile's exact pre-Phase-8 identity.
- **P-SYM01** (`specs/005-analysis-final-closure/contracts/performance-locks.json`,
  migrated into the canonical Phase 9 profile by T032 if and only if T025
  classifies `HEX-SYM-01` as `PARTIAL` or `REMAINING`): the
  exact 32-bit and 64-bit SAT query descriptors/digests plus the frozen
  `hex-sym01-qfbv-differential/v1` complete feasible 1–8-bit
  differential denominator MUST satisfy counts `cnfVariables <= 400000`,
  `cnfClauses <= 1600000`, `decisions <= 500000`, and
  `propagations <= 8000000`. Its generator source hashes, version, per-width
  cardinalities, 14,622 queries, and 29,244 backend results are immutable.
  Startup/solve milliseconds and heap/RSS deltas are
  identity-bound informational measurements only: finite and `>= 0`, never a
  proof. Candidate head/tree, query digests, provider fingerprint, browser
  build, and physical-device identity are part of the denominator.
- **P-EGRAPH**, **P-SYMMEM**, and **P-TAINT**
  (`specs/005-analysis-final-closure/contracts/performance-locks.json`): their
  exact fixture ID/version/digest and every count/time metric, unit, `<=`
  operator, and numeric threshold are frozen before T031/T033/T034. Budget or
  cancellation exhaustion is a conservative no-publication/partial result, not
  permission to weaken a threshold.
- **P-FINAL**: T040 resolves the exact candidate against P-COMPETITIVE,
  P-PHASE8, P-SYM01, P-EGRAPH, P-SYMMEM, P-TAINT, the exact-current applicable
  phase6/7/9/10/11 profiles, and
  `tools/validation/stage2/profile-denominators.lock.json`. The fourteen
  required H9 workload rows, exact fixture-set digest, two runtime classes,
  cache/repetition policies, and numeric targets are frozen in
  `specs/005-analysis-final-closure/contracts/final-platform-locks.json`.
  Missing, unmeasured, identity-invalid, targetless, or failing H9 rows block
  release. A non-H9 profile with no numeric performance threshold remains a
  functional/identity gate and MUST NOT be relabeled as a measured performance
  pass. If T032 revises the Phase 9 profile, the old/new identities are
  recorded, all old Phase 9 evidence is invalidated, and the revised profile is
  rerun on the exact candidate.

## Phase 1: Setup and current truth

- [x] T001 Resolve remote, main, handoff, branches, worktrees, and dirty state in `specs/005-analysis-final-closure/research.md`
  - **Contract** — Objective: freeze Reality Preflight. Current evidence: origin is `rhgrive3/hex-ida`, initial main `47f8a444`, handoff `84d277a9`, original `transcripts/` preserved. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: none. Owned paths: `research.md`. Delta: record observations only. Negative counterexample: stale repository name/SHA. Tests: live Git commands. Integration test: refetch identity comparison. Completion evidence: R-001/R-002/R-009. Status: DONE.
- [x] T002 [CAMP] Read mandatory governance, architecture, roadmap, and focused Spec Kit packages and record authority decisions in `specs/005-analysis-final-closure/research.md`
  - **Contract** — Objective: apply the strongest repository rules. Current evidence: AGENTS, CLAUDE, guardrails, constitution, root README, flash, roadmap, architecture, support, migration, two-stage and hardening documents read; six requested legacy README/protocol paths do not exist. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T001. Owned paths: `research.md`. Delta: no production change. Negative counterexample: historical roadmap overrides current architecture. Tests: path/history checks. Integration test: authority-order review. Completion evidence: R-010. Status: DONE.
- [x] T003 [CAMP] Create specification, plan, research, model, contract, and quickstart in `specs/005-analysis-final-closure/`
  - **Contract** — Objective: define the complete campaign before production edits. Current evidence: all Phase 0/1 artifacts exist. Owner/model: SOL Ultra. Risk: HIGH. Dependencies: T001-T002. Owned paths: `specs/005-analysis-final-closure/**`. Delta: coordination artifacts only. Negative counterexample: missing identity/status/blocker semantics. Tests: Spec Kit prerequisite scripts. Integration test: independent requirements review. Completion evidence: SPEC-REVIEW-02. Status: DONE.
- [x] T004 Build the ten-row handoff matrix in `specs/005-analysis-final-closure/evidence/recovery-matrix.md`
  - **Contract** — Objective: classify every dated recovery snapshot against main. Current evidence: 8 PARTIAL, 1 CONFLICTED, 1 SUPERSEDED; no DONE/NOT STARTED. Owner/model: Sol audit, SOL Ultra verification. Risk: HIGH. Dependencies: T001-T003. Owned paths: recovery matrix. Delta: read-only classification. Negative counterexample: handoff “done” text treated as truth. Tests: blob/commit/merge-tree/source/test comparisons. Integration test: supervisor reruns affected focused gates. Completion evidence: exact SHA/tree/action per row. Status: DONE.
- [x] T005 Audit open PRs, checks, CodeRabbit, branch overlap, and current-main CI in `specs/005-analysis-final-closure/evidence/github-state.md`
  - **Contract** — Objective: prevent duplicate work and stale green claims. Current evidence: 93 open PRs; #3255 dirty/red, #3421/#3422 red, #3425 has no checks, #3382 merged with failed checks; main has several red workflows. Owner/model: Luna Max audit, SOL Ultra verification. Risk: RELEASE. Dependencies: T001. Owned paths: GitHub evidence file only. Delta: record exact heads/check URLs/thread dispositions. Negative counterexample: combined CodeRabbit “completed” treated as approval. Tests: GitHub API exact-head queries. Integration test: compare before each promotion. Completion evidence: complete current snapshot. Status: DONE.
- [x] T006 Build the fixed 23-row pre-Stage-A roadmap inventory in `specs/005-analysis-final-closure/evidence/roadmap-matrix.md`
  - **Contract** — Objective: distinguish existing proof from true residual work. Current evidence: 12 DONE, 10 PARTIAL, 1 REMAINING. Owner/model: Luna Max audit, SOL Ultra verification. Risk: HIGH. Dependencies: T001-T003. Owned paths: roadmap matrix. Delta: no production change. Negative counterexample: unchecked roadmap box causes duplicate implementation. Tests: source/wiring/spec/test/commit lookup. Integration test: repeat from post-Stage-A main. Completion evidence: all 23 fixed IDs present. Status: DONE.
- [x] T007 [CAMP] Complete reviewer-owned requirements checks in `specs/005-analysis-final-closure/checklists/release-evidence.md`
  - **Contract** — Objective: make release requirements unambiguous. Current evidence: early reviews found fourteen gaps plus status, performance-denominator, literal-ID, and traceability defects; independent `SPEC-REVIEW-05` passed CHK001–CHK028 on the exact reviewed blobs recorded in `evidence/speckit-analysis.md`. Owner/model: independent Sol reviewer. Risk: HIGH. Dependencies: T003-T006. Owned paths: checklist marker/evidence only. Delta: mark only reviewer-approved criteria. Negative counterexample: `[x]` interpreted as implementation complete. Tests: item-by-item requirements audit. Integration test: 34/34 FR, 8/8 SC, and 48/48 task traceability. Completion evidence: `SPEC-REVIEW-05`, reviewer snapshot hashes, and PASS 28/28. Status: DONE.
- [x] T008 [CAMP] Run Spec Kit consistency analysis and record the result in `specs/005-analysis-final-closure/evidence/speckit-analysis.md`
  - **Contract** — Objective: require clean spec/plan/tasks coverage before production edits. Current evidence: `SPECKIT-ANALYZE-04` independently closed C1/H1-H4/M1-M5 and returned CLEAN on the exact reviewed blobs; `OWNERSHIP-AUDIT-03` passed 48/48. Owner/model: SOL Ultra with independent Sol review. Risk: HIGH. Dependencies: T003-T007. Owned paths: Spec Kit artifacts and analysis evidence. Delta: corrected documentation contradictions only; no production edit. Negative counterexample: an FR, SC, recovery row, or residual finding has no task. Tests: `speckit-analyze`, dependency/ownership/traceability/digest checks, and `git diff --cached --check`. Integration test: 34/34 FR, 8/8 SC, 48/48 tasks, 23/23 roadmap IDs, and all nine frozen digests. Completion evidence: `evidence/speckit-analysis.md`, zero CRITICAL/HIGH/MEDIUM findings, and explicit CLEAN. Status: DONE.
- [x] T009 Commit the analyzed planning checkpoint in `specs/005-analysis-final-closure/**`
  - **Contract** — Objective: preserve an exact pre-implementation checkpoint. Current evidence: documentation-only commit `d7eb37dd3c5b4842f127a74183547e64bef2be9f` has tree `3233b538f984befbecf091aaf2eeb4dbcea10707`; it contains all sixteen campaign artifacts reviewed by `SPEC-REVIEW-06`, `OWNERSHIP-AUDIT-04`, and `SPECKIT-ANALYZE-05`. Owner/model: SOL Ultra. Risk: MEDIUM. Dependencies: T008. Owned paths: `specs/005-analysis-final-closure/**`. Delta: documentation commit only; no production path entered the checkpoint. Negative counterexample: production diff enters before analyze. Tests: `git diff --check`, exact changed-file inventory, and commit/tree resolution. Integration test: clean checkpoint SHA. Completion evidence: commit `d7eb37dd3c5b4842f127a74183547e64bef2be9f`, tree `3233b538f984befbecf091aaf2eeb4dbcea10707`, 16/16 files under `specs/005-analysis-final-closure/`. Status: DONE.
- [ ] T046 [CAMP] Complete the mandatory master-phase pre-fanout gate and record it in `specs/005-analysis-final-closure/evidence/pre-fanout.md`
  - **Contract** — Objective: satisfy Guardrails §3.1 before any T011–T017 component implementation begins. Current evidence: governance and exit contracts are read/frozen, the clean living branch exists, and target/invalidation rules are specified; no campaign PR, exact-SHA invocation proof, ownership regression, or production walking skeleton has yet been accepted. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T009-T010. Owned paths: one campaign PR, `.github/workflows/final-closure-preflight.yml`, `tools/validation/final-closure/preflight.mjs`, `tests/final-closure/preflight.test.mjs`, and this evidence file; `tests/phase4/walking-skeleton.test.mjs` is an unchanged read-only production-chain gate. Delta: add the narrow permanent exact-SHA/ownership invocation and prove all ten preflight conditions without weakening existing candidate-tree checks. Negative counterexample: component fanout before PR creation, verifier accepts a different SHA, overlapping owner writes, mock-only skeleton, desktop proxy for iPad, or evidence reused after an invalidating identity change. Tests: exact expected-head mutation, ownership overlap mutation, real production walking skeleton, target-proof schema, and moving-main invalidation. Integration test: dedicated preflight workflow plus unchanged Phase 4 production walking skeleton on the living PR head. Completion evidence: PR/base/head IDs, exact verifier invocation, ownership registry/regression, walking-skeleton production path, target-device contract, reconciliation owner, invalidation set, and `PREFLIGHT_GREEN`. Status: PENDING.

---

## Phase 2: User Story 1 — Recover without loss or duplicate work (Priority: P1)

**Goal**: Complete all ten handoff rows on current main through their canonical
owners, starting with the first reproduced failure.

**Independent Test**: Every recovery row has current production and focused test
proof; incomplete count is zero and no stale branch was merged wholesale.

- [x] T010 [US1] Preserve the first `apply_damage` failure and current baseline evidence in `specs/005-analysis-final-closure/evidence/recovery-matrix.md`
  - **Contract** — Objective: prove the first incorrect decompiler boundary before repair. Current evidence: `node tests/decompiler-semantic.mjs` exits 1 at line 103 with `local_phi_174`; compiler-truth base and extended suites pass. Owner/model: SOL Ultra. Risk: HIGH. Dependencies: T004. Owned paths: evidence only. Delta: none. Negative counterexample: compiler-truth green hides the separate failure. Tests: exact failing command. Integration test: unchanged test must pass after T011. Completion evidence: captured assertion/output. Status: DONE.
- [ ] T011 [US1] Recover and harden exact stack-return/PHI handling in `js/decompiler/legacy-exact-return-repair.js`, `js/decompiler/passes/`, `js/decompiler/pipeline.js`, and owned tests
  - **Contract** — Objective: remove `local_phi_174` only with canonical authenticated proof. Current evidence: local `e4736bf1` 9-path delta passes positives but has forgeable metadata, broad legacy reachingStore trust, regex deletion, mutation, and deadline gaps. Owner/model: SOL Ultra implementation; independent Sol review. Risk: HIGH. Dependencies: T009-T010 and T046. Owned paths: `js/decompiler/legacy-exact-return-repair.js`, `js/decompiler/passes/{manager,stack-phi-recovery,stack-return-recovery}.js`, `js/decompiler/pipeline.js`, `js/decompiler/rewrite/engine.js`, `js/decompiler/{semantic-core,semantic}.js`, the private projection boundary `js/semantics/memoryssa/operand-forwarding.js` and `js/semantics/compat/semantic-ir-v2-to-v1-memory.js`, `tests/decompiler-semantic.mjs`, dedicated stack-return/private-binding tests; `tests/phase8/performance/**` and every other MachineEffects/MemorySSA path are explicitly excluded and may only be run read-only here. Delta: selectively port minimal behavior, add private authority, same-block/size/barrier/alias proof, immutable/idempotent publication, source-map consistency, active cancellation. Negative counterexample: forged proof, intervening store/call/unknown, width/block mismatch, misleading text, replay. Tests: decompiler semantic, stack-return soundness/private-binding, deterministic transforms read-only. Integration test: decompiler + Phase 8 + compiler-truth. Completion evidence: exact diff, pre/post failure, review PASS. Status: PENDING.
- [ ] T012 [P] [US1] Repair hostile Phase 8 identity/GVN authority in `js/decompiler/phase8/analysis-identity.js`, `js/decompiler/phase8/valuenumber.js`, and owned tests
  - **Contract** — Objective: close REC-3255-P8 correctness before performance. Current evidence: proxy hides semantic identity, enumerable getter executes, returned numbers are mutable. Owner/model: Sol implementation and separate Sol review. Risk: HIGH. Dependencies: T009 and T046. Owned paths: the two source files, `tests/phase8/memory/gvn.test.mjs`, `tests/phase8/scalar/c2-02-adversarial-matrix.test.mjs`, new hostile-identity test. Delta: intrinsic-safe descriptor reads, reject accessors/proxies that cannot prove complete identity, deep immutable publication. Negative counterexample: hidden `semanticMode`/`machineFlavor`, poisoned intrinsic/getter, post-publication mutation. Tests: GVN 43-row floor, adversarial, identity DAG. Integration test: full Phase 8. Completion evidence: all hostile rows fail closed and previous positives pass. Status: PENDING.
- [ ] T013 [US1] Meet frozen Phase 8 work/cancellation budgets in `js/decompiler/phase8/` and `tests/phase8/performance/`
  - **Contract** — Objective: close large-function, cancellation, delayed-scheduling, and public-pipeline failures without moving baselines. Current evidence: snapshot performance/budget test passes 1/5; current main Phase 8 baseline run is pending. Owner/model: Sol. Risk: HIGH. Dependencies: T011-T012 and T046. Owned paths: exact Phase8 performance-critical files proven by profile plus `tests/phase8/performance/**`; no semantic-contract widening. Governing lock: `tools/validation/phase8/profile.json` v3, three-repetition `ci-linux-x64` median with `coldActiveFunction` milliseconds `<= 250`, `phase8InteractiveStage` milliseconds `<= 5`, and `phase8OptimizeStage` milliseconds `<= 120` on the profile's exact pre-Phase-8 fixture identity. Delta: reduce redundant work while retaining finite deadlines/cancellation. Negative counterexample: Infinity deadline, stale publication, main-thread stall, semantic divergence. Tests: `analysis-identity-dag`, budget, deterministic transforms, profile metrics. Integration test: Phase 8 verifier and baseline. Completion evidence: all named P-PHASE8 rows and hard-zero counters green without profile drift. Status: PENDING.
- [ ] T014 [P] [US1] Recover authenticated bounded tiered solving in `js/symbolic/solver/`, `js/symbolic/verify/`, and Phase 9 tests
  - **Contract** — Objective: close REC-SYM01 without forgeable exact authority or suite-order state. Current evidence: recovery focused 27/28; exact subclasses self-assert authority and tier result is mutable. Owner/model: Sol. Risk: HIGH. Dependencies: T009 and T046 for implementation; `[P]` permits implementation only, and T017 is an additional exact-promotion dependency that must first establish the ME contract. Owned paths: symbolic expr/solver/verify, dedicated spec/tests/tools; no decompiler or ME ownership. Governing lock: `contracts/performance-locks.json#/profiles/P-SYM01`, exact 32/64 query pair plus 14,622-query/29,244-backend-result denominator, with counts `cnfVariables <= 400000`, `cnfClauses <= 1600000`, `decisions <= 500000`, and `propagations <= 8000000`; query/provider/build/device identities are mandatory. Delta: isolate deadlines/state, private-brand exact providers, deep-freeze tiers, bounded measured 32/64-bit route under P-SYM01. Negative counterexample: forged provider, overlapping exact tiers, timeout/resource-limit, mutation, replay order. Tests: Phase9 focused/differential/lifecycle/performance/browser using the exact query IDs/digests and `hex-sym01-qfbv-differential/v1` source hashes/counts frozen in the lock. Integration test: `npm run phase9:test` and verifier. Completion evidence: exact contract and all P-SYM01 resource/target evidence; physical iPad remains a hard gate. Status: PENDING.
- [ ] T015 [US1] Recover intrinsic-safe Apple knowledge and loader evidence in `js/apple/knowledge.js`, `js/binary/macho-*.js`, and metadata tests
  - **Contract** — Objective: close REC-X02 while preserving hostile-input and signing conservatism. Current evidence: focused candidate passes but poisoned `Object.isFrozen`/`Array.prototype.filter` breaks authority; multiple open PR overlaps. Owner/model: Sol. Risk: HIGH. Dependencies: T005, T009, T016, and T046. Owned paths: Apple knowledge, Mach-O core/dyld, ObjC/Swift adapter, dedicated spec/tests; forbidden overlap until #3541/#6402/#6372/#6324/#3543 reconciliation. Delta: captured safe intrinsics, locked Apple matrix, PAC/fixup/signing consequence evidence. Negative counterexample: ambient intrinsic poisoning, malformed counts/offsets, stale vm mapping, signature ambiguity. Tests: Apple knowledge, metadata, binary, F6/rebuild. Integration test: independent reparse and `llvm-readobj` where required. Completion evidence: exact tool hash/version and locked matrix. Status: PENDING.
- [ ] T016 [P] [US1] Recover the ambiguity-preserving discovery artifact in `js/analysis/discovery/`, `js/rebuild/transaction-v2.js`, and owned verifiers
  - **Contract** — Objective: close REC-X03 with readable-byte independent proof. Current evidence: recovery focused 22/22 and verifier pass, but legacy-promoter fixtures lack committed readable bytes and #3541 overlaps. Owner/model: Sol. Risk: HIGH. Dependencies: T005, T009, and T046. Owned paths: discovery artifact/candidates/canonical/fusion/producers, constrained analysis index/rebuild boundary, dedicated specs/tests/verifiers. Delta: reconcile #3541, bind bytes, retain interval/code-data/relocation ambiguity through rewrite. Negative counterexample: collision dropped, unknown extent narrowed, unreadable synthetic fixture accepted, stale publication. Tests: discovery matrix, x03 ownership/verifier, Stage2 rebuild. Integration test: Phase7/12 and independent LLVM evidence. Completion evidence: exact corpus/verifier/tool identities. Status: PENDING.
- [ ] T017 [P] [US1] Complete MachineEffects ground truth and reconcile oracle recovery through `tools/validation/competitive/`, `js/semantics/`, and target-owned effects
  - **Contract** — Objective: close REC-ME01 and REC-ME-ORACLE without a second authority, including their C0 ground-truth prerequisite. Current evidence: #3425 head `128542c7` has no checks; recovery is 24/25 and loses explicit undefined result; raw BSF/BSR binding and hostile descriptors remain; competitive binary rows retain legacy-unproven/UNMEASURED identities. Owner/model: Sol implementation, separate Sol oracle review, SOL Ultra integration. Risk: HIGH. Dependencies: T005, T009, and T046. Owned paths: `tools/validation/competitive/**`, `tests/competitive/**`, `js/semantics/effects/**`, target-owned x86 effects, non-memory `js/semantics/compat/semantic-ir-v2-to-v1.js` projections, and dedicated ME/spec/test/validation paths; T011's operand-forwarding and `semantic-ir-v2-to-v1-memory.js` paths are excluded. #3425 is the only active ME branch authority. Delta: identity-bound same-binary ground truth, strict undefined transport, decoded operand binding, hostile descriptor rejection, non-self oracle breadth. Negative counterexample: different-source twin, self-oracle, unsupported/undefined folded exact, forged operand descriptor, relaxed-memory mismatch, empty candidate SHA. Tests: competitive twin/ground-truth, effects, semantic-v2 undefined transport, SCCP, oracle adversarial/schema/report. Integration test: full ME locked corpus and independent formal/QEMU/hardware evidence. Completion evidence: no unmeasured/unproven required row, zero mismatches, and cutover-eligible exact identities. Status: PENDING.
- [ ] T018 [US1] Revalidate all ten recovery rows and close the superseded C2 row in `specs/005-analysis-final-closure/evidence/recovery-matrix.md`
  - **Contract** — Objective: make handoff unfinished count zero. Current evidence: C2 unknown is superseded by `f1dbad86`; other rows await T011-T017. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T011-T017. Owned paths: recovery matrix and campaign tasks only. Delta: evidence-backed status updates. Negative counterexample: composite REC-P8-S marked done despite conflict. Tests: every row's focused exit gate, `memoryssa-unknown-partition`. Integration test: affected subsystem matrix. Completion evidence: ten terminal rows, PARTIAL/CONFLICTED/NOT STARTED zero. Status: PENDING.

---

## Phase 3: User Story 2 — Integrate recovery as an exact proven product (Priority: P1)

**Goal**: Merge the complete Stage A product through protection and verify it on
refetched main.

**Independent Test**: Exact candidate, merge tree, accepted commit, and refetched
main identities have all required green evidence and ancestry.

- [ ] T019 [US2] Run convergence and independent recovery reviews in `specs/005-analysis-final-closure/evidence/recovery-reviews.md`
  - **Contract** — Objective: adversarially review actual integrated diffs. Current evidence: e473 concerns and lane audits exist; no final reviews. Owner/model: non-owner Sol reviewers; SOL Ultra verifies. Risk: RELEASE. Dependencies: T018. Owned paths: review evidence only. Delta: fixes return to owning task. Negative counterexample: worker report accepted without diff/test inspection. Tests: five fresh attacks per high-risk lane. Integration test: rerun impacted T0-T2 after fixes. Completion evidence: no CHANGES_REQUIRED on exact head and convergence clean. Status: PENDING.
- [ ] T020 [US2] Canonically regenerate combined artifacts twice via `scripts/build-userscript.mjs` and record identities in `specs/005-analysis-final-closure/evidence/stage-a-candidate.md`
  - **Contract** — Objective: produce one combined generated transaction. Current evidence: current-main Generated userscript sync is red. Owner/model: SOL Ultra only. Risk: RELEASE. Dependencies: T019. Owned paths: canonical generated userscript/release identity files and evidence. Delta: generator output only. Negative counterexample: manual hash/edit or worker-generated mixed tree. Tests: first build expected diff, second build zero diff, userscript tests. Integration test: generated sync workflow. Completion evidence: source/build/artifact hashes. Status: PENDING.
- [ ] T021 [US2] Run required quiet full and subsystem gates on the Stage A head and record logs in `specs/005-analysis-final-closure/evidence/stage-a-candidate.md`
  - **Contract** — Objective: achieve zero unexplained red locally. Current evidence: compiler truth and Phase7 pass; Phase9 first run was setup-red before `npm ci`; Phase8 still running; current main CI red. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T019-T020. Owned paths: evidence/log references only. Delta: fixes return to owner and gain regressions. Negative counterexample: historical/pre-existing red waived. Tests: quiet `npm run check`, `npm test`, semantic, decompiler, workers/runtime/browser and changed subsystems. Integration test: verifiers/corpora/benchmarks. Completion evidence: commands, denominators, logs, exact head, zero unexplained failures. Status: PENDING.
- [ ] T022 [US2] Open or update the Stage A PR and classify exact-head CI and every CodeRabbit thread in `specs/005-analysis-final-closure/evidence/stage-a-github.md`
  - **Contract** — Objective: bind external review/check evidence to exact candidate and prevent recurrence of #3382's red/review-blocked merge. Current evidence: historic #3255 has two actionable CodeRabbit threads plus manual width blocker and failed CI; #3382 merged despite failed checks/changes requested. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T021. Owned paths: campaign PR, `.github/workflows/**`, `tests/phase-runner-contract.mjs` or the narrow existing guardrail regression, and evidence; no unrelated PR lifecycle mutation. Delta: use a clean campaign PR or deliberately adopted PR and add a permanent automated expected-head/review/required-check regression where technically possible. Negative counterexample: old green/combined review status or merge while a required check/review is red. Tests: guardrail regression, exact-head GitHub checks, and four-way comment classification. Integration test: zero unclassified/actionable and enforced merge gate. Completion evidence: regression path plus PR/head/check/thread IDs. Status: PENDING.
- [ ] T023 [US2] Validate the fresh-main Stage A candidate merge tree in `specs/005-analysis-final-closure/evidence/stage-a-candidate.md`
  - **Contract** — Objective: prove the product that main would receive. Current evidence: historic merge trees are stale. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T022. Owned paths: integration worktree and evidence; only owner reconciles main. Delta: one current-main reconciliation and generated refresh. Negative counterexample: base moves or hidden conflict/generated drift. Tests: guardrail-prescribed candidate-tree subset plus ownership/security/semantics. Integration test: exact merge-tree verifiers. Completion evidence: base/head/tree SHA and all required gates. Status: PENDING.
- [ ] T024 [US2] Merge Stage A and post-merge verify refetched `origin/main` in `specs/005-analysis-final-closure/evidence/stage-a-post-merge.md`
  - **Contract** — Objective: complete Recovery before Stage B. Current evidence: not merged. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T023 and all required CI/review green. Owned paths: protected PR merge and evidence. Delta: expected-head protected merge only. Negative counterexample: post-merge smoke fails, accepted commit absent, original workspace dirty/untracked state changes, or recovery ref changes/disappears. Tests: refetch, ancestry, changed-path smoke, generated identity, main CI, and read-only comparison of the original workspace plus `origin/wip/recovery-handoff-20260904` against T001. Integration test: full required post-merge subset. Completion evidence: candidate head/tree, accepted merge commit, refetched main, ancestry/smoke record, original `transcripts/` preservation, and exact recovery-ref retention. On failure: preserve evidence, stop Stage B, and use a repository-approved corrective PR/recovery; never force-rewrite main. Status: PENDING.

---

## Phase 4: User Story 3 — Close the complete analysis roadmap (Priority: P1)

**Goal**: Reconcile the fixed 23 findings from post-Recovery main and implement
every true residual in dependency order.

**Independent Test**: All 23 rows have current production/wiring/test/spec proof;
`PARTIAL + REMAINING + BLOCKED = 0` before final promotion.

- [ ] T047 [CAMP] Create the fresh Stage B living worktree from verified post-Recovery `origin/main` and record it in `specs/005-analysis-final-closure/evidence/stage-b-preflight.md`
  - **Contract** — Objective: ensure Stage B starts from the refetched product actually accepted by Stage A, never from the old campaign branch state. Current evidence: Stage A is not merged, so no valid Stage B base exists. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T024. Owned paths: one new clean Stage B branch/worktree and this evidence file; the original workspace, recovery refs, merged Stage A worktree, and unrelated refs remain read-only. Delta: refetch main, create the repository-convention branch/worktree at that exact SHA, prove clean tracked/untracked state, and designate it the new living integration owner. Negative counterexample: base is pre-merge main, carry-over dirty file, missing accepted ancestry, original `transcripts/` changed, or recovery ref moved/deleted. Tests: remote/head/ancestry/worktree/status comparisons. Integration test: Stage A four-identity record equals the Stage B base and new `HEAD`. Completion evidence: refetched main SHA, branch/worktree path, clean status, original-workspace/recovery-ref comparison, and integration-owner declaration. Status: PENDING.

**Applicability gate**: T025 classifies every row and T048 proves complete task
coverage before any T026–T036 or newly materialized residual lane executes.
A lane makes production changes only when its post-Stage-A row is `PARTIAL` or
`REMAINING`.
If T025 proves `DONE`, `REPLACED`, or `OBSOLETE`, the corresponding task is
completed with task checkbox/status `DONE`, `implementationAction: NO_EDIT`,
and durable state `COMPLETE_EXISTING`; the roadmap disposition independently
remains exactly `DONE`, `REPLACED`, or `OBSOLETE`. If T025 returns `BLOCKED`,
the roadmap disposition remains `BLOCKED`, durable state is
`BLOCKED_BY_DEPENDENCY`, task checkbox/status remains `PENDING`, and
`implementationAction: NO_EDIT_EXTERNAL_BLOCK`; the evidence records the exact
external dependency and failed alternatives. Other solvable lanes continue,
but final promotion remains prohibited. A concurrent owner never produces
roadmap `BLOCKED`: the row remains `PARTIAL`/`REMAINING`, its task uses durable
`BLOCKED_BY_CONCURRENT_WORK` plus `implementationAction: RECONCILE_OWNER`, and
duplicate implementation is forbidden until the competing head is adopted,
rejected with evidence, or completed. A preliminary row count or status below is
never permission to reimplement it.

- [ ] T025 [US3] Recompute all 23 roadmap rows from post-Stage-A main in `specs/005-analysis-final-closure/evidence/roadmap-matrix.md`
  - **Contract** — Objective: invalidate the pre-Stage-A inventory and avoid duplicate work. Current evidence: preliminary 12/10/1 split. Owner/model: SOL Ultra with Luna Max read-only archaeology. Risk: HIGH. Dependencies: T047. Owned paths: roadmap matrix only. Delta: source/wiring/test/spec/PR/branch/commit reconciliation; for every reused focused spec record its revision, canonical producer, all production consumers, current tests, and contract drift. Negative counterexample: copy preliminary status after merge or reuse a stale spec because its tasks are checked. Tests: all fixed IDs exactly once and every reuse audit complete. Integration test: residual task coverage. Completion evidence: post-main SHA and 23 terminal/current rows. Status: PENDING.
- [ ] T048 [CAMP] Materialize every post-T025 residual into the dependency graph before Stage B fanout in `specs/005-analysis-final-closure/tasks.md` and `evidence/stage-b-residual-coverage.md`
  - **Contract** — Objective: guarantee that every one of the 23 rows currently classified `PARTIAL`/`REMAINING`, including regressions among preliminary terminal-existing rows, has exactly one actionable owned task before implementation or T038. Current evidence: T026–T036 cover the preliminary residual set only and cannot anticipate T025 changes. Owner/model: SOL Ultra; independent Luna Max coverage audit. Risk: HIGH. Dependencies: T025. Owned paths: campaign tasks and residual-coverage evidence only. Delta: map each residual to an existing task or append a fully contracted dependency-ordered task with a new ID; never force a newly discovered row into an unrelated lane. Negative counterexample: uncovered residual, duplicate owner, row silently delegated to T037, task appended only after T038, or concurrent PR mistaken for completion. Tests: exact 23-ID bijection from residual rows to tasks, dependency-cycle/unknown-ID scan, owner/path-overlap scan, and Spec Kit analyze. Integration test: no Stage B production task may start until the coverage verifier reports 100%. Completion evidence: T025 main identity, residual IDs, task IDs, dependencies/owners, uncovered count zero, duplicate count zero, and `STAGE_B_FANOUT_GREEN`. Status: PENDING.
- [ ] T026 [P] [US3] Conditionally close same-binary twin and ground-truth coverage for HEX-C0-01 in `tools/validation/competitive/` and `tests/competitive/`
  - **Contract** — Objective: if T025 still proves the row incomplete, replace legacy-unproven/UNMEASURED binary denominators; otherwise record the applicable no-edit disposition. Current evidence: preliminary 21-row partial manifest, invalidated by T025. Owner/model: Luna Max implementation, independent Sol review. Risk: HIGH. Dependencies: T048. Owned paths: competitive manifest/profile/tests/fixtures. Delta: identity-bound debug/stripped twins and independent oracle records for every binary row under P-COMPETITIVE. Negative counterexample: different-source twins, self-oracle, null identity, denominator shrink, or implementation after a T025 terminal proof. Tests: twin and ground-truth contracts, competitive verifier, P-COMPETITIVE comparisons. Integration test: ME/X dependent corpora. Completion evidence: full denominator, zero unmeasured/unproven rows, and all P-COMPETITIVE blocking metrics within threshold, or exact terminal no-edit proof. Status: PENDING.
- [ ] T027 [US3] Close any post-recovery HEX-ME-01 residual through `js/semantics/effects/` and `tools/validation/machine-effects/`
  - **Contract** — Objective: ensure the roadmap ME card, not only recovery mechanics, is complete. Current evidence: preliminary PARTIAL; T017 owns recovery. Owner/model: Sol. Risk: HIGH. Dependencies: T017, T026, and T048. Owned paths: ME owner/tests/evidence only. Delta: only gaps still proven after T017. Negative counterexample: external absence labeled proof or unsupported result exact. Tests: full locked ME/formal/relaxed matrix. Integration test: Semantic V2/CFG/SSA/decompiler consumers. Completion evidence: zero mismatch and complete identity-bound denominator. Status: PENDING.
- [ ] T028 [P] [US3] Complete bidirectional transform provenance for HEX-C4-03 in `js/decompiler/provenance.js` and provenance tests
  - **Contract** — Objective: map every raw, deleted, merged, optimized, and rendered entity both ways. Current evidence: source-row/address helpers partial; #3421 is stale/red. Owner/model: Sol. Risk: HIGH. Dependencies: T011 and T048. Owned paths: provenance owner, pass origin projections, dedicated tests/spec; do not adopt stale #3421 wholesale. Delta: stable entity mapping with invalidation/dependency evidence. Negative counterexample: deleted node loses origin, merge maps ambiguously, forged text ID, stale snapshot. Tests: positive/negative/source-map/replay corpus. Integration test: decompiler and query/UI navigation. Completion evidence: complete mapping denominator and exact identity. Status: PENDING.
- [ ] T029 [US3] Complete proof-gated transform adoption for HEX-C4-04 in `js/symbolic/verify/equivalence.js` and decompiler pass tests
  - **Contract** — Objective: require bounded semantic validation per opted-in pass. Current evidence: 13 focused rows; refinement/UB/memory coverage and uniform adoption missing; #3422 stale/red. Owner/model: Sol. Risk: HIGH. Dependencies: T014, T028, and T048. Owned paths: equivalence verifier, pass adoption boundary, dedicated tests/spec. Delta: pass-local proof contract covering observable memory/UB/refinement and explicit timeout/unsupported. Negative counterexample: SAT/timeout treated as equivalence, memory effect omitted, stale provenance. Tests: differential/metamorphic/adversarial eligibility/lifecycle. Integration test: decompiler pipeline. Completion evidence: all adopted transforms carry valid proof; unknown withholds. Status: PENDING.
- [ ] T030 [US3] Complete exception-aware safe structuring for HEX-C4-02 in `js/decompiler/phase8/structuring.js` and CFG corpus tests
  - **Contract** — Objective: structure reducible/exception regions while preserving every edge and safe residual gotos. Current evidence: edge accounting exists; exception-aware transforms partial. Owner/model: Sol. Risk: HIGH. Dependencies: T029 and T048. Owned paths: structuring owner/providers and tests. Delta: validated region transformations with explicit foreign/unwind/irreducible fallback. Negative counterexample: unresolved indirect/unwind edge dropped, irreducible graph prettified incorrectly, non-convergence published. Tests: CFG metamorphic/differential/adversarial corpus. Integration test: compiler-truth/decompiler. Completion evidence: zero semantic mismatch/edge loss. Status: PENDING.
- [ ] T031 [US3] Conditionally implement bounded proof-only e-graph candidate generation for HEX-C4-05 in `js/decompiler/phase8/egraph.js` and owned tests
  - **Contract** — Objective: only if T025 still classifies C4-05 as `PARTIAL`/`REMAINING`, add bounded candidate generation without direct unproved rewrites; otherwise record the applicable no-edit disposition. Current evidence: preliminary search found no module or PR; that finding is invalidated by T025, and C2-02 must be revalidated by T037. Owner/model: Sol implementation and separate Sol review. Risk: HIGH. Dependencies: T014, T029, T032, and T048. Owned paths: new pure-IR candidate module, registry declaration, dedicated tests; adoption remains C4-04. Delta: bounded equality-saturation candidate generation with origin/proof requirements. Negative counterexample: rule unsound under width/UB/memory, explosion, cancellation, direct publication, or duplicate engine after terminal current proof. Tests: exact `egraph-pure-bv-rules-v1` fixture/digest, small independent oracle, metamorphic rules, and all P-EGRAPH count/time/budget/cancel/replay gates from `contracts/performance-locks.json`. Integration test: current C2-02 facts, C4-04 adoption, and decompiler fallback. Completion evidence: every P-EGRAPH blocking row passes and no candidate publishes without independent proof, or exact terminal no-edit proof. Status: PENDING.
- [ ] T032 [US3] Close any post-recovery HEX-SYM-01 residual in `js/symbolic/solver/` and Phase 9 evidence
  - **Contract** — Objective: conditionally close only the residual proven by T025 after T014, reaching measured bounded 32/64-bit tier completion under P-SYM01. Current evidence: preliminary PARTIAL and T014 recovery, invalidated by T025. Owner/model: Sol; T032 is the single profile-migration decision owner. Risk: HIGH. Dependencies: T014, T026-T027, and the T048 applicability gate. Owned paths: symbolic solver/tests/profile. Migration predicate: migrate P-SYM01 into the canonical Phase 9 profile if and only if T025 classifies `HEX-SYM-01` as `PARTIAL` or `REMAINING`; `DONE`/`REPLACED`/`OBSOLETE` records an exact no-migration decision, and external `BLOCKED` cannot promote. Delta: only post-T014 gaps and, when the predicate is true, canonical Phase 9 profile publication with old/new identities and explicit invalidation of every old Phase 9 result. Negative counterexample: proof authority forged, timeout exact, 64-bit route unbounded, resource count above P-SYM01, duplicate work after terminal proof, or stale pre-migration evidence reused. Tests: differential/performance/browser/device on P-SYM01 denominator and old-profile rejection. Integration test: Phase9 verify rerun on the exact candidate. Completion evidence: predicate input/decision, old/new profile identities when migrated, all four P-SYM01 count ceilings, informational metrics, provider/query/build/device identities, or exact terminal no-edit proof. Status: PENDING.
- [ ] T033 [US3] Implement byte-addressed symbolic memory for HEX-SYM-02 in `js/symbolic/executor.js`, `js/symbolic/translate/`, and tests
  - **Contract** — Objective: support concrete-to-array escalation, partial writes, endian, and symbolic aliases conservatively. Current evidence: basic LOAD expression exists; C2-01 has current-main proof and is revalidated later by T037. Owner/model: Sol. Risk: HIGH. Dependencies: T032 and T048. Owned paths: symbolic memory/executor/translator/tests. Delta: bounded byte arrays and tiered memory model; reuse canonical MemorySSA facts. Negative counterexample: byte hole zero-filled, MayAlias forwarded, endian swapped, symbolic alias forced exact, array blowup. Tests: exact `symbolic-byte-memory-v1` fixture/digest, differential byte oracle, and every P-SYMMEM count/time/boundary/budget/cancel/replay gate from `contracts/performance-locks.json`. Integration test: current C2-01 contract, Phase9, and decompiler/value consumers. Completion evidence: zero false exact values and every P-SYMMEM blocking row passes. Status: PENDING.
- [ ] T034 [US3] Implement first-class taint and proof-gated deobfuscation for HEX-SYM-03 in `js/symbolic/` and transform tests
  - **Contract** — Objective: preserve taint through data/control/memory and permit deobfuscation only with C4-04 proof. Current evidence: sandbox/equivalence surfaces only. Owner/model: Sol. Risk: HIGH. Dependencies: T029, T033, and T048. Owned paths: canonical symbolic taint domain, query/projection, dedicated tests; no UI heuristic authority. Delta: bounded lattice, sources/sinks/sanitizers, provenance and adoption gate. Negative counterexample: implicit-flow loss, unknown sanitizer clears taint, timeout permits rewrite. Tests: exact `symbolic-taint-proof-v1` fixture/digest, positive/negative/control/data/memory/metamorphic cases, and every P-TAINT count/time/budget gate from `contracts/performance-locks.json`. Integration test: symbolic/decompiler/query. Completion evidence: every P-TAINT blocking row passes, zero taint loss, and no unproved transform. Status: PENDING.
- [ ] T035 [US3] Close any post-recovery HEX-X-03 residual in `js/analysis/discovery/` and rebuild evidence
  - **Contract** — Objective: ensure one reassemblable ambiguity-preserving artifact. Current evidence: preliminary PARTIAL and T016 recovery. Owner/model: Sol. Risk: HIGH. Dependencies: T016, T026-T027, and T048. Owned paths: X03 owner/tests/verifier. Delta: only gaps remaining after Stage A. Negative counterexample: collision or unknown extent dropped before writer. Tests: exact discovery verifier and independent bytes. Integration test: Phase7/12/rebuild. Completion evidence: full artifact/rewrite denominator. Status: PENDING.
- [ ] T036 [US3] Close any post-recovery HEX-X-02 residual in `js/binary/`, `js/apple/`, and Apple metadata evidence
  - **Contract** — Objective: complete the locked Apple loader/rebuild matrix. Current evidence: preliminary PARTIAL and T015 recovery. Owner/model: Sol. Risk: HIGH. Dependencies: T015, T026-T027, T035, and T048. Owned paths: X02 owner/tests/verifier. Delta: only remaining dyld/fixup/generic/PAC/signing rows. Negative counterexample: invalid writer output accepted, poisoned intrinsic, stale address identity. Tests: Apple/binary/metadata/F6 and independent parser. Integration test: Stage2 verify. Completion evidence: all locked rows terminal and zero invalid acceptance. Status: PENDING.
- [ ] T037 [US3] Reverify every row classified terminal-existing by T025 on the final combined tree in `specs/005-analysis-final-closure/evidence/roadmap-matrix.md`
  - **Contract** — Objective: prevent new work from regressing rows that T025 proves `DONE`, `REPLACED`, or `OBSOLETE`; the count is determined only by T025, not by the preliminary twelve-row snapshot. Current evidence: preliminary source/test proof exists and is not current after Stage A. Owner/model: SOL Ultra, Luna Max negative-test assistance. Risk: HIGH. Dependencies: T026-T036, T048, and every additional residual task materialized by T048, including evidence-only completion of non-applicable tasks. Owned paths: evidence unless a regression returns to its canonical owner. Delta: no feature reimplementation. Negative counterexample: production consumer missing, contract drift, false exactness, runtime/static identity error, or fixed twelve-row assumption. Tests: focused feature specs plus affected Phase7/8/10/12/Stage2 gates. Integration test: full semantic/decompiler/runtime/rebuild. Completion evidence: one current exact proof packet for every T025 terminal-existing row. Status: PENDING.
- [ ] T038 [US3] Set all 23 roadmap rows to evidence-backed terminal states and update `docs/解析ツール改善.md.txt` plus `docs/analysis-improvement-finding-ledger.md`
  - **Contract** — Objective: close authoritative roadmap history without deletion. Current evidence: roadmap and ledger are stale. Owner/model: SOL Ultra; Luna Max mechanical evidence formatting. Risk: RELEASE. Dependencies: T037, T048, and every residual task materialized by T048. Owned paths: the two roadmap/ledger docs and campaign evidence. Delta: completed checklist/final evidence or documented replacement; no unsupported obsolescence. Negative counterexample: TODO/TBD/PARTIAL/unchecked promised scope remains. Tests: fixed-ID/status scan and source/test link validation. Integration test: Spec Kit converge. Completion evidence: DONE/REPLACED/OBSOLETE totals, PARTIAL/REMAINING/BLOCKED zero. Status: PENDING.

---

## Phase 5: User Story 4 — Preserve semantic and platform safety (Priority: P1)

**Goal**: Prove the complete final product on security, correctness, performance,
generated, browser, runtime, and physical-device gates.

**Independent Test**: All seven hard-zero counters are zero and every applicable
identity-bound gate passes on the exact final product.

- [ ] T039 [US4] Run adversarial semantic/security review and locked zero counters in `specs/005-analysis-final-closure/evidence/final-safety.md`
  - **Contract** — Objective: prove one semantic truth, explicit unknown, hostile-input bounds, cancellation, provenance, and provider isolation. Current evidence: preliminary audits only. Owner/model: independent Sol review and SOL Ultra verification. Risk: RELEASE. Dependencies: T038. Owned paths: evidence; defects return to canonical owner. Delta: regression for each discovered repeatable defect. Negative counterexample: false NoAlias/MustAlias/target/type, stale cancel publication, invalid writer accepted. Tests: all seven separate counters with corpus/denominator identities. Integration test: semantic/decompiler/rebuild/runtime. Completion evidence: every counter exactly zero. Status: PENDING.
- [ ] T045 [P] [US4] Implement the mandatory H9 measurement and physical-iPad numeric evidence contract in `tools/validation/final-platform/`, `js/platform/physical-ipad-evidence.js`, and owned tests
  - **Contract** — Objective: make every required P-FINAL workload numerically measurable and impossible to waive as `UNMEASURED`. Current evidence: `tests/benchmark-baseline.json` leaves cold/warm open, active-function, decompiler, peak memory, cancellation, and TTFUA as `gate: none`, while the current physical-iPad record has booleans but no numeric samples. Owner/model: Sol implementation, independent Sol review, SOL Ultra verification. Risk: HIGH. Dependencies: T048. Parallel/execution note: the collector may be implemented alongside residual Stage B lanes; exact-final execution remains owned by the final platform-evidence task. Owned paths: `contracts/final-platform-locks.json`, one canonical final-platform collector/verifier/schema, physical-iPad evidence extension, and dedicated tests; no duplicate ByteSource, scheduler, renderer, or profiler. Delta: identity-bound raw samples and summaries for all fourteen H9 rows, Instruments trace identity for physical peak footprint, and fail-closed missing/unmeasured/targetless/stale evidence. Negative counterexample: absent row, NaN/negative sample, summary without raw samples, simulated iPad, stale build/device/fixture, denominator shrink, missing numeric target, or threshold relaxation in an implementation change. Tests: positive/negative/boundary/replay and one mutation per H9 row against `contracts/final-platform-locks.json`; current boolean-only and `UNMEASURED` evidence must fail. Integration test: Stage2 verifier, production-faithful WebKit scenario, and exact physical-iPad schema validation. Completion evidence: collector/verifier contract accepts only complete identity-bound numeric packets for all fourteen rows and rejects every listed counterexample. Status: PENDING.
- [ ] T040 [P] [US4] Run frozen benchmarks, browser/WebKit, runtime, and physical iPad gates in `specs/005-analysis-final-closure/evidence/final-platform.md`
  - **Contract** — Objective: prove bounded portable product behavior against P-FINAL. Current evidence: no exact final build/device yet. Owner/model: SOL Ultra; authorized physical-device runner external if needed. Risk: RELEASE. Dependencies: T038 and T045. Owned paths: evidence and existing profile outputs only. Delta: no threshold movement; regressions return to owners. Negative counterexample: desktop API presence passed as iPad proof, inactive deployment, memory/cancellation over limit, denominator drift, required H9 row absent/unmeasured/targetless, or an unmeasured metric relabeled as pass. Tests: all fourteen H9 rows in `contracts/final-platform-locks.json`, P-COMPETITIVE, P-PHASE8, P-SYM01, P-EGRAPH, P-SYMMEM, P-TAINT, exact-current applicable phase6/7/9/10/11 profiles, Stage2 denominator lock, browser/runtime gates, production-faithful WebKit and physical iPad. If T032 revises Phase 9, record old/new profile identities, invalidate old evidence, and rerun it on the exact candidate. Integration test: exact candidate/build/deployment/device identity. Completion evidence: all fourteen required H9 rows are measured and pass on both required runtime classes; every P-FINAL row records governing path, metric, unit, operator, threshold, denominator and exact fixture/build/device identity. Status: PENDING.
- [ ] T041 [US4] Regenerate final combined output twice and verify deployment/build identity in `specs/005-analysis-final-closure/evidence/final-candidate.md`
  - **Contract** — Objective: bind generated product to final combined source. Current evidence: none for final head. Owner/model: SOL Ultra only. Risk: RELEASE. Dependencies: T039-T040. Owned paths: generated artifacts and evidence. Delta: canonical generator only. Negative counterexample: second diff, stale embedded SHA, manual edit, inactive deployment. Tests: userscript build/test, deployment identity check. Integration test: runtime/browser activation. Completion evidence: zero second diff and exact hashes. Status: PENDING.
- [ ] T042 [US4] Run final Spec Kit analyze/implement/converge loop and full quiet local release gates in `specs/005-analysis-final-closure/evidence/final-candidate.md`
  - **Contract** — Objective: prove no specified/task work remains and zero unexplained red. Current evidence: pending. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T038-T041. Owned paths: campaign Spec Kit/evidence; any appended task must be implemented before rerun. Delta: append-only convergence tasks where needed. Negative counterexample: near-complete status accepted. Tests: Spec Kit analyze/converge, quiet `npm run check`, `npm test`, all applicable verifiers. Integration test: exact candidate head. Completion evidence: CONVERGED, all tasks/evidence complete, full gates green. Status: PENDING.
- [ ] T043 [US4] Obtain exact-head CI, CodeRabbit disposition, and current-main candidate-tree approval in `specs/005-analysis-final-closure/evidence/final-github.md`
  - **Contract** — Objective: meet final protected merge gate. Current evidence: current main/open roadmap PRs are red or unverified. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T042. Owned paths: final campaign PR and evidence only. Delta: one living reconciliation; no unrelated PR mutation. Negative counterexample: base moves, stale review, unclassified comment, skipped blocking check. Tests: exact-head and merge-tree workflows, thread audit, generated/ownership gates. Integration test: final candidate tree. Completion evidence: all blocking checks green, unclassified/actionable zero, APPROVE_MERGE. Status: PENDING.
- [ ] T044 [US4] Merge final candidate and post-merge verify live main in `specs/005-analysis-final-closure/evidence/final-post-merge.md`
  - **Contract** — Objective: finish only after live main contains and runs the final product. Current evidence: not merged. Owner/model: SOL Ultra. Risk: RELEASE. Dependencies: T043. Owned paths: protected merge, final roadmap/spec/evidence. Delta: expected-head merge and post-merge records. Negative counterexample: accepted commit absent, smoke/generated/runtime failure, original workspace/recovery ref changed, open campaign PR or in-scope blocker. Tests: refetch, ancestry, smoke, required main CI/runtime/browser, and read-only comparison of original workspace dirty/untracked state plus recovery-ref identity against T001. Integration test: final roadmap/source/test/spec agreement. Completion evidence: four merge identities, preserved original workspace/recovery ref, all 23 terminal with remaining zero, no campaign PR/blocker. Status: PENDING.

---

## Dependencies and execution order

- T001-T009 freeze repository truth and block production changes.
- T046 runs after T009-T010 and blocks every T011-T017 implementation until its
  evidence says `PREFLIGHT_GREEN` on the living PR head.
- T011 and T012 may run in parallel only on their disjoint declared paths; T013
  starts only after both complete. T014/T016/T017 may run in parallel where their
  `contracts/task-ownership.json` entries remain disjoint, and T016 must precede
  T015's final Apple matrix.
- T018-T024 are sequential Stage A integration and post-merge gates.
- T047 creates the fresh Stage B worktree from verified Stage A main; T025 starts
  only there, and T048 blocks every residual implementation lane until all
  nonterminal rows have exactly one fully contracted task.
- After T048, T026/T028 and eligible independent lanes may start in parallel;
  semantic dependency chains remain:
  `C0 → ME`, `C4-03 → C4-04 → C4-02/C4-05`,
  `SYM-01 → SYM-02 → SYM-03`, and `X-03 → X-02`.
- T045 may implement the fixed H9 collector after T048 alongside residual lanes;
  T040 cannot execute/promote until both T038 and T045 complete. T038-T044 are
  otherwise the final closure and exact-product chain. No MVP checkpoint is a
  campaign stop condition.

## Requirement traceability

- `[CAMP]` marks cross-story governance work: T002, T003, T007, T008, T046,
  T047, and T048.
- T002 → FR-001, FR-028, FR-031
- T003 → FR-017, FR-025, FR-031
- T007 → FR-001, FR-017, FR-025, FR-031
- T008 → FR-010, FR-017, FR-031
- T046 → FR-017, FR-018, FR-021, FR-028, FR-029
- T047 → FR-002, FR-007, FR-008, FR-028, FR-032
- T048 → FR-008, FR-009, FR-010, FR-026, FR-031

- FR-001–FR-004 → T001, T004–T006, T018, T025, T037
- FR-005–FR-007 → T010–T024
- FR-008–FR-011 → T006, T025–T038, T042, T044
- FR-012–FR-015 → T011–T017, T028–T034, T039
- FR-016–FR-018 → T009, T020, T022–T023, T039, T041, T043
- FR-019–FR-025 → T013, T024, T026, T032, T039–T044
- FR-026–FR-031 → T005–T006, T017, T025, T036–T038, T043
- FR-032–FR-034 → T009, T013, T023–T026, T032, T040, T043–T044
- FR-027 → T022
- FR-028 → T024, T044
- FR-030 → T040
- FR-033 → T011–T018
- FR-034 → T013–T014, T026, T031–T034, T040, T045
- SC-001–SC-002 → T004, T018–T024
- SC-003 → T025–T038
- SC-004 → T039
- SC-005 → T020–T023, T039–T043
- SC-006 → T038, T042, T044
- SC-007 → T043–T044
- SC-008 → T013, T026, T032, T040

## Parallel execution examples

```text
After T046 is PREFLIGHT_GREEN:
  Sol lane A: T011 decompiler recovery
  Sol lane B: T012 Phase 8 identity, then T013 only after T011 and T012
  Sol lane C: one of T014/T015/T016/T017, with no owned-path overlap

After T047 → T025 → T048:
  Luna Max + Sol review: T026 ground-truth corpus
  Sol lane: T028 provenance
  Sol lane: T032 SYM-01 residual
```

## Completion definition

The campaign is complete only at T044. Stage A PR creation or merge, partial
roadmap implementation, worker reports, old CI, or unavailable device evidence do
not satisfy completion.
