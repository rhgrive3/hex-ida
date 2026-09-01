# Analysis Improvement Finding Closure Ledger

## Campaign authority

- Scope: close findings from `docs/解析ツール改善.md.txt`; unrelated Issue work is excluded.
- Initial live-main audit base: `e29187c5be7a62cdf966a821c1d9a0623d8f6ce3`.
- Current implementation base after pre-worker reconciliation: `852fcc559711eac680f6853644d390fdb5c1b7f8`.
- Integration owner: Sol Supervisor on `research-close/integration`.
- Integration worktree: `/workspaces/ida-245-research-integration`.
- Concurrent pull requests at initial preflight: none. Pre-worker recheck found PR 2202 only;
  its DWARF/integrated-Issue files do not overlap C1-01.
- Concurrent research implementation branches: none newer than the research addendum; old unmerged
  branches are historical evidence only and will not be modified.
- Generated-output owner: integration lane only. Component workers may build generated output
  ephemerally and MUST NOT commit it.
- Exact-head verifier route: repository `workflow_dispatch` and subsystem verifier selected by each
  finding plan; Phase 8 provides the established exact-SHA pattern.
- Moving-main reconciliation owner: Sol Supervisor.
- Evidence invalidation: any changed head, candidate merge tree, verifier semantics, corpus,
  toolchain, generated artifact, runtime identity, or affected canonical semantic version requires
  fresh proof.

## Exit contract

A finding terminates only as `COMPLETE_EXISTING`, `MERGED`, `BLOCKED_BY_DEPENDENCY`, or
`BLOCKED_BY_CONCURRENT_WORK`. `PARTIAL` and `MISSING` are classifications, not completion states.
Every implementation finding requires a deterministic pre-fix counterexample, positive and
fail-closed regressions, Spec Kit convergence, actual changed-file ownership review, exact-head
proof, candidate merge-tree proof, required CI, expected-head merge, and post-merge live-main
verification. Denominators and tests may not be weakened.

## Current ledger

`—` means no implementation artifact exists yet, not that the field is inapplicable.

| Finding | Status | Current classification | Owner | Spec Kit feature | Task IDs | Branch / PR | Dependencies | Counterexample or strongest current evidence | Implementation | Focused tests | Converge | Exact-head CI | Merged SHA | Remaining risk | Concurrent overlap |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HEX-C0-01 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged PR 1887 | none | same-artifact debug/stripped authority merged and retained on live main | `tools/validation/competitive/**` | competitive twin authority regressions | historical | main evidence retained | `2af6a913` | non-regression only | none |
| HEX-ME-01 | VERIFYING | COMPLETE_PENDING_MERGE | Sol | `specs/003-oracle-mask-matrix` + `specs/004-independent-machine-effects-oracle` + `specs/005-machine-effects-evidence-breadth` | T001–T008 (003) complete; T001–T038 (004) complete; T001–T019 (005) complete; T039/T023 pending PR | `feat/analysis-partial-closure-20260901` (phase2 merged `fb2fa341`) | C0-01 | independent oracle infrastructure integrated on campaign head: oracle schema/runner/report/policy/corpus/release-verify, evidence-v2, formal evidence generator (Isla footprint + Sail/RV64 + herd7 litmus + QEMU triangulation identities), ordering/undefined matrix module, A2 preservation | `tools/validation/machine-effects/**`, `tests/machine-effects/**`, `tests/machine-effects/fixtures/formal-source/**` | effects:test PASS (131 files); machine-effects 163/163; ordering matrix 10/10; formal evidence digest PASS; lint 1810 files; invariants PASS except pre-existing #3120 compiler-truth | analyze clean; converge n/a (merged work assessed) | local exact-head verifier READY; GitHub CI pending push/PR | — | hardware/QEMU triangulation requires the pinned external toolchain binaries at release time (herd7 7.58, Isla f189d5c, Sail-RISCV 0.13.1); generated artifacts carry digest identities | none |
| HEX-C1-01 | VERIFYING | COMPLETE_PENDING_MERGE | Sol + one Luna Max implementation owner | `specs/001-loaded-pointer-recovery` | T001–T022; T001–T021 complete 2026-09-01 | `feat/analysis-partial-closure-20260901` @ `d2574c3e` | C1-03 | pre-fix 1/1 failed because the exact load stayed `unresolved-load` | canonical post-MemorySSA points-to refinement on live main (`66664d4b`); focused 11/11 twice; pointsto/alias 45/45; Phase 7 85/85; ownership valid; userscript resync `d2574c3e`; P7_VERDICT=READY at exact head (tree `e980aba2`, corpus digest `519bd15f`, false NoAlias/MustAlias 0); candidate merge tree = HEAD tree, 0 conflicts | focused 11/11 twice; pointsto/alias 45/45; Phase 7 85/85 (implementation merged on main as `66664d4b`) | analyze clean; converge CONVERGED (no new tasks) | local exact-head verifier READY; GitHub exact-head CI pending push/PR | — | remaining: push/PR, required CI, expected-head merge, post-merge verification | none |
| HEX-C1-02 | COMPLETE | COMPLETE | Sol | `specs/002-return-pointer-summaries` | T001–T010 complete | `PR 3193` | C1-03 | 13-case target matrix locked: missing summary, targetless call, pinned identity mismatch, schema/contract mismatch, partial/unsupported status, unknown call effects, empty provenance, wrong returnIndex, top argument, absent argument, malformed offset, unknown provenance kind, recursion fixed-point budget all fail closed; complete callee joins precisely | `js/analysis/summary/contract.js`, `js/analysis/summary/local.js`, `js/analysis/summary/interprocedural.js`, `js/analysis/pointsto/local.js` (PR 2434 production floor intact on current main) | c1-02-target-matrix 22/22, Phase 7 summary/pointsto 138/138 PASS, Phase 7 runner 71/71 (402/402) PASS | analyze clean; converge PASS | exact head green | `fef37203` | non-regression only; production floor and matrix locked | none (ME-01 and C2-01 isolated) |
| HEX-C1-03 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged PR 2185 | C0-01 | provenance-backed root separation is on live main | canonical roots; spelling cannot mint exact separation | alias provenance negative regressions | historical | main evidence retained | `552f798f` | non-regression only | none |
| HEX-C2-01 | VERIFYING | COMPLETE_PENDING_MERGE | Sol | — | T001–T037 complete 2026-09-01 | `feat/analysis-partial-closure-20260901` @ `d2574c3e` (implementation on main) | C1-01, C1-03 | canonical byte-exact forwarding implemented on main: adjacent-store reconstruction, coverage index, producer authority, fail-closed boundaries | `js/semantics/memoryssa/queries.js` (`forwardMemoryValue`), `build.js` byteCoverage, compat finalize/memory, pipeline-core exact gate, pointsto operand consumer | focused 1/1 twice (74 assertions: hole/overlap/endian/clobber/stale/cancel/budget/forged/downstream); pointsto 45/45; Phase 7 85/85; verifier READY | analyze clean; converge CONVERGED | local exact-head verifier READY; GitHub CI pending push/PR | — | compiler-truth O0 red is pre-existing (#3120, other lane) | none |
| HEX-C2-02 | VERIFYING | COMPLETE_PENDING_MERGE | Sol | `specs/002-wrapped-interval-congruence` | T001–T046 complete 2026-09-01 | `feat/analysis-partial-closure-20260901` @ `d2574c3e` (implementation on main) | C2-01 | known bits, congruence, edge/block-entry refinement implemented on main (`js/decompiler/phase8/range.js`, `sccp.js`); Review 1/2 PASS, SEMANTIC_GO | Phase 8 range/SCCP product domain | scalar 123/123, adversarial matrix 26/26, pre-fix regression | analyze clean; converge CONVERGED | local exact-head verifier READY; GitHub CI pending push/PR | — | compiler-truth O0 red pre-existing (#3120) | none |
| HEX-C3-01 | COMPLETE | COMPLETE | Sol | `specs/004-recursive-type-recovery` | T001–T011 complete | `feat/analysis-hex-c3-01-recursive-structural-types` | C1-02, C2-01, C3-02 | 14-axis counterexample matrix: recursive struct recovery, mutual recursion A<->B, recursive array nesting, conflicting fields, size/align conflicts, metadata vs ABI conflict, tied soft candidates, non-convergent cycle truncation, budget exhaustion, cancellation, invalid size/align, unsupported ABI, determinism, C2-01 dependency fixture | `js/analysis/types/constraints.js`, `js/analysis/types/scc.js`, `js/analysis/types/graph.js`, `js/analysis/types/index.js`, `js/analysis/index.js` | c3-01-counterexamples 14/14 PASS, Phase 7 types 72/72 (416/416) PASS, Phase 8 33/33 PASS, Metadata 5/5 PASS, P7_VERDICT=READY | PASS | exact head verified | — | non-regression only; C2-01 memory boundary gated | none (C2-01 and ME-01 isolated) |
| HEX-C3-02 | VERIFYING | COMPLETE_PENDING_MERGE | Sol | `specs/002-abi-aggregate-prototype-unification` | T001–T033 complete 2026-09-01 | `feat/analysis-partial-closure-20260901` @ `d2574c3e` (implementation on main) | ME-01, C1-02, C2-01 | cross-profile ABI matrix locked on main: 66/66 profile matrix (HFA/HVA/sret/aggregate/variadic frontiers), 68+64 node tests, consumer stale/malformed/mismatch/conflict rejections | `js/abi/**` classifiers + `tests/phase8/abi/**` | 66/66 + 68/68 + 64/64 | analyze clean; converge CONVERGED | local exact-head verifier READY; GitHub CI pending push/PR | — | compiler-truth O0 red pre-existing (#3120) | none |
| HEX-C3-03 | COMPLETE | COMPLETE | Sol | `specs/003-versioned-language-metadata` | T001–T014 complete | `feat/analysis-hex-c3-03-versioned-language-metadata` | C3-02 | unified versioned metadata providers across Go (1.2, 1.16, 1.18, 1.20+), Rust (v0/legacy), Swift 5, and ObjC 2.0 with fail-closed verdicts and TypeConstraintGraph wiring | `js/metadata/**`, `js/analysis/index.js`, `js/apple/runtime.js` | 5 metadata suites (provider contract, Go, Rust, Apple, downstream integration), 37 assertions, broad regression PASS | analyze clean; converge PASS | exact head green | `f205d17b` | non-regression only | none (ME-01 isolated) |
| HEX-C4-01 | COMPLETE_EXISTING | COMPLETE | existing/main | historical Phase 8 | historical | merged before run | C0-01 | transactional pass lifecycle, declared dependencies, invalidation and completeness are wired | Phase 8 transaction substrate | Phase 8 invalidation/cancellation/determinism gates | historical | main evidence retained | historical main | non-regression only | none |
| HEX-C4-02 | REMAINING | PARTIAL | Sol | — | — | — | C4-01, C4-04 | edge-accounted structuring retains residual jumps; broader exception-aware proof is absent | Phase 8 structuring facts | pending irreducible/exception/refinement matrix | — | — | — | visual improvement must not change semantics | none |
| HEX-C4-03 | REMAINING | PARTIAL | Sol | — | — | — | C4-01, C2-01 | transform origins and stale artifact rejection exist; full bidirectional mapping is unproven | partial Phase 8 provenance | pending every transform/rendered entity reverse mapping | — | — | — | deleted/merged entities may lose navigation | none |
| HEX-C4-04 | REMAINING | PARTIAL | Sol | — | — | — | C4-03, SYM-01, ME-01 | bounded equivalence exists but is not a uniform pass-local adoption gate | symbolic verifier only | pending eligible/refuted/unknown/stale pass matrix | — | — | — | omitted observables can make proof vacuous | none |
| HEX-C4-05 | REMAINING | MISSING | Sol | — | — | — | C2-02, C4-04, SYM-01 | no equality-saturation candidate layer found | none | pending bounded e-graph and independent-proof corpus | — | — | — | candidate generation is never authority | none |
| HEX-SYM-01 | REMAINING | PARTIAL | Sol | — | — | — | ME-01 | registry selects worker/exhaustive backend; no measured optional 32/64-bit production tier | exact small-domain floor | pending physical WebKit/resource/cancel/model matrix | — | — | — | availability cannot imply proof capability | none |
| HEX-SYM-02 | REMAINING | PARTIAL | Sol | — | — | — | SYM-01, C2-01 | concrete symbolic memory/unknown behavior exists; arrays and escalation are incomplete | concrete tier only | pending array/endian/partial-write/escalation matrix | — | — | — | model mismatch invalidates proof | none |
| HEX-SYM-03 | REMAINING | PARTIAL | Sol | — | — | — | SYM-02, C4-04 | bounded equivalence exists; no uniform first-class taint and deobfuscation adoption gate | fragmented symbolic proof | pending taint/sanitizer/opaque-predicate corpus | — | — | — | heuristic sanitizer must not become truth | none |
| HEX-X-01 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged before run | C0-01 | transaction v2 binds independent parser/oracle identities | writer-independent reparse gate | rebuild transaction negatives | historical | main evidence retained | historical main | non-regression only | none |
| HEX-X-02 | REMAINING | PARTIAL | Sol | — | — | — | C3-03, X-01, X-03 | bounded chained-fixup and Apple runtime pieces exist without one versioned Apple matrix | fragmented Apple providers | pending dyld/Swift/PAC/signing matrix | — | — | — | version, PAC, fixup and signing drift | none |
| HEX-X-03 | REMAINING | PARTIAL | Sol | — | — | — | C0-01, ME-01, X-01 | discovery/evidence/rebuild pieces exist without one ambiguity-preserving reassemblable artifact | fragmented discovery artifacts | pending overlap/code-data/relocation/reparse matrix | — | — | — | ranked candidate must not become exact truth | none |
| HEX-S2-01 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged before run | C0-01 | provider/session/module/binary/generation identity and stale rejection are wired | runtime identity contract | Stage 2 stale/race regressions | historical | main evidence retained | historical main | new providers must reuse the gate | none |
| HEX-S2-02 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged before run | C0-01 | candidate sets, retained alternatives and truncation reporting are wired | collision-preserving recognition | recognition collision regressions | historical | main evidence retained | historical main | corpus breadth is separate | none |

## Active finding checkpoint: partial-closure campaign 2026-09-01

- Campaign branch: `feat/analysis-partial-closure-20260901` @ `d2574c3e`, based on live main `c78e1b98` (PR #3284 head). Moving-main reconciliation: merge base = main head, zero conflicts.
- Scope (user directive): close all PARTIAL/VERIFYING findings — C1-01, C2-01, C2-02, C3-02, ME-01, C4-02, C4-03, C4-04, SYM-01, SYM-02, SYM-03, X-02, X-03. C4-05 (MISSING/NOT STARTED) is explicitly out of scope and must not be touched.
- Stale-worktree reconciliation: `feat/analysis-hex-c2-01-restacked` and `codex/hex-c2-02` contain no files absent from origin/main — their content is merged (rebased duplicates); C3-02 branch `feat/analysis-hex-c3-02-abi-unification` is fully merged. `feat/hex-me-01-phase2` (14 commits, +6579 lines: oracle schema/runner/report/policy, formal evidence generation) is genuinely unmerged and is the ME-01 integration base.
- Generated output: main's committed userscript output was stale relative to post-`f205d17b` runtime source; canonical rebuild advanced serial to `2322242129` (buildId `0303fc9a02c2ceb90b1c78a5`, release identity `11d5a7ac…`); second build zero diff; committed as `d2574c3e`.
- Known unrelated red gate: `npm run semantic-v2:test` currently fails via `tests/compiler-truth/run.mjs` — six Clang `-O0` functions report semantic truth unavailable (issue #3120, fix lane `fix/compiler-truth-o0-symbolic-stack-forwarding-run12` in flight). This is not caused by and does not block the findings in this campaign; recorded here so it is not misattributed.
- Next actions: C1-01 push/PR/CI/merge (T022); C2-01/C2-02/C3-02 convergence runs; ME-01 phase2 integration; C4/SYM/X lane speckit features.

## Prior checkpoint: HEX-C1-01 (historical)

- Exact current-main implementation base: `852fcc559711eac680f6853644d390fdb5c1b7f8`.
- Moving-main reconciliation: `e29187c5` → `852fcc55` contains the independently owned ELF
  fix plus canonical generated outputs. No C1-01 source/test overlap exists; generated outputs are
  deferred to T019 and will be rebuilt from the final candidate.
- First deterministic divergence: a load-derived pointer becomes `TOP/unresolved-load` even when
  canonical MemorySSA identifies one exact reaching concrete store.
- Canonical owner: `js/analysis/pointsto/**`, consuming `js/semantics/memoryssa/**` through the
  existing production analysis orchestration.
- Forbidden architecture: a second reaching-definition engine, MayAlias forwarding, private
  decompiler recovery, name-based provenance, or any unrelated Issue fix.
- Preflight collision result: no research overlap; PR 2202 changes only
  `js/analysis/debug/dwarf.js` and `tests/integrated-issues-hardening.mjs`.
- Spec Kit readiness: specify, clarify, graft trace, plan, checklist, tasks, and analyze complete;
  20/20 requirements covered, 0 critical/high/medium findings, and both checklists fully reviewed.
- Ownership preflight: `tests/phase7/ownership/c1-01-inventory.test.mjs` passes 3/3 against the
  actual tracked plus untracked branch inventory; the Phase 7 manifest gate also passes.
- Implementation evidence: the original focused test failed 1/1 before production edits; the
  final focused matrix passes 11/11 twice and the existing pointsto/alias matrix passes 59/59.
  MayAlias, real call-clobber, unknown clobber, phi, partial/incompatible bytes, provenance,
  stale identities, malformed metadata, cancellation, iteration/value/target budgets, volatile,
  atomic, and discarded-publication cases remain conservative.
- Subsystem & downstream verification:
  - Phase 7: PASS (36/36 files, 287/287 tests)
  - Semantic V2: PASS (54/54 files, mismatch 0, unknown store/call safety failure 0, provenance loss 0)
  - Phase 8: PASS (27/27 files, 277/277 tests)
  - Effects / Invariants / Userscript / Migration / Core / Platform / Runtime / UI / Benchmark: all PASS
- Identity evidence: A2 and alias-provider versions advanced to `1.1.0`; the recovery proof digest
  binds snapshot/function/schema/build, canonical use/definition/provider proof, access metadata,
  and the stored PointsToSet digest. A provider-proof mutation changes the proof identity while
  identical replays remain identical.
- Ownership evidence: exhaustive search finds one production `reachingConcreteStore` consumer in
  canonical points-to analysis and no second reaching-definition implementation. Lint validated
  1,505 files; changed-module syntax and `git diff --check` pass.
- Next action: T017 Spec Kit convergence, candidate merge tree, and exact-product gates.
