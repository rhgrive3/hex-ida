# Analysis Improvement Finding Closure Ledger

> **Current local checkpoint — 2026-09-13:** attached ZIP; upstream identity unverified.
> The table below is a historical ledger, not the current implementation inventory or completion percentage.
> Recursive C1-02 discovery is already present in the supplied integration tree and was reused, not rebuilt.
> See [current implementation/acceptance](解析ツール改善.md),
> [all 23 findings / 21 tasks](analysis-local-acceptance-audit.json), and
> [local evidence handover](analysis-local-handover.md).
> The original denominator and historical receipts remain intact. Full acceptance is **CHECKPOINT-LOCKED**.

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

## Historical ledger (retained; not current closure authority)

`—` means no implementation artifact exists yet, not that the field is inapplicable.

| Finding | Status | Current classification | Owner | Spec Kit feature | Task IDs | Branch / PR | Dependencies | Counterexample or strongest current evidence | Implementation | Focused tests | Converge | Exact-head CI | Merged SHA | Remaining risk | Concurrent overlap |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HEX-C0-01 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged PR 1887 | none | same-artifact debug/stripped authority merged and retained on live main | `tools/validation/competitive/**` | competitive twin authority regressions | historical | main evidence retained | `2af6a913` | non-regression only | none |
| HEX-ME-01 | ACCEPTED-LOCAL | LOCAL_COMPLETE | Sol | `specs/003-oracle-mask-matrix` | T001–T008 complete | `feat/analysis-roadmap-v8-current-main-20260907` / existing PR 7036 | C0-01 | 10 frozen cases (6 ordering, 4 undefined masks), 5 atomic memory orderings + unknown, variable shift modulo, division by zero, unmodelled operand partiality, boundary mutation detection (ordering loss, changed atomicity, mask mutation, lost predicates), formal evidence artifacts check, ARM64e PAC 45,521 cases and RV64IMC frozen coverage verified | `tests/machine-effects/me-01-acceptance.test.mjs` | me-01-acceptance 7/7 PASS, ordering-undefined-matrix 17/17 PASS, generated-formal-evidence 5/5 PASS | PASS | exact head green | — | physical-hardware triangulation and whole-roadmap/release gates remain open | none |
| HEX-C1-01 | VERIFYING | MISSING | Sol + one Luna Max implementation owner | `specs/001-loaded-pointer-recovery` | T001–T022; T001–T016 complete | `research-close/integration` / PR 2201 | C1-03 | pre-fix 1/1 failed because the exact load stayed `unresolved-load` | canonical post-MemorySSA points-to refinement; exact byte/proof/provenance/freshness gate; complete-only atomic solver publication | focused 11/11 twice; pointsto/alias 59/59; Phase 7 36/36 (287/287); Semantic V2 54/54; Phase 8 27/27 (277/277); inventory 3/3; lint 1505 files; syntax/diff/manifest PASS | analyze clean; converge pending | — | — | target set is single-store only; multi-store bytes remain C2-01 | none |
| HEX-C1-02 | COMPLETE | COMPLETE | Sol | `specs/002-return-pointer-summaries` | T001–T010 complete | `PR 3193` | C1-03 | 13-case target matrix locked: missing summary, targetless call, pinned identity mismatch, schema/contract mismatch, partial/unsupported status, unknown call effects, empty provenance, wrong returnIndex, top argument, absent argument, malformed offset, unknown provenance kind, recursion fixed-point budget all fail closed; complete callee joins precisely | `js/analysis/summary/contract.js`, `js/analysis/summary/local.js`, `js/analysis/summary/interprocedural.js`, `js/analysis/pointsto/local.js` (PR 2434 production floor intact on current main) | c1-02-target-matrix 22/22, Phase 7 summary/pointsto 138/138 PASS, Phase 7 runner 71/71 (402/402) PASS | analyze clean; converge PASS | exact head green | `fef37203` | non-regression only; production floor and matrix locked | none (ME-01 and C2-01 isolated) |
| HEX-C1-03 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged PR 2185 | C0-01 | provenance-backed root separation is on live main | canonical roots; spelling cannot mint exact separation | alias provenance negative regressions | historical | main evidence retained | `552f798f` | non-regression only | none |
| HEX-C2-01 | ACCEPTED-LOCAL | LOCAL_COMPLETE | Sol | — | — | `feat/analysis-roadmap-v8-current-main-20260907` / PR 7036 | C1-01, C1-03 | 5 widths x 2 endians x 12 clobber scenarios = 120 cells denominator verified; 30 exact reconstructions, 90 withholdings, zero false exactness | `tests/phase8/memory/c2-acceptance.test.mjs`, `tests/phase8/memory/c2-byte-forwarding-matrix.test.mjs`, `js/semantics/memoryssa/**` | c2-acceptance 8/8 PASS, c2-byte-forwarding-matrix 120 cells PASS, semantic-v2 issue-c2-01 1/1 PASS | PASS | exact head green | — | copied proof/copied producer/stale snapshot without authority fail closed; residual load fallback verified | none |
| HEX-C2-02 | ACCEPTED-LOCAL | LOCAL_COMPLETE | Sol | — | — | `feat/analysis-roadmap-v8-current-main-20260907` / PR 7036 | C2-01 | range/bitmask/congruence/SCCP/induction product transfer verified; monotone over-approximation, joins/widening value retention, 54-cell holdout | `tests/phase8/memory/c2-acceptance.test.mjs`, `tests/phase8/scalar/c2-*.test.mjs`, `tests/phase8/integration/c2-02-downstream-range.test.mjs` | c2-acceptance 8/8 PASS, c2-scalar 43/43 PASS, c2-02-downstream-range 5/5 PASS | PASS | exact head green | — | validated canonical scalar facts consumed; unvalidated/stale/partial facts strictly rejected | none |
| HEX-C3-01 | COMPLETE | COMPLETE | Sol | `specs/004-recursive-type-recovery` | T001–T011 complete | `feat/analysis-hex-c3-01-recursive-structural-types` | C1-02, C2-01, C3-02 | 14-axis counterexample matrix: recursive struct recovery, mutual recursion A<->B, recursive array nesting, conflicting fields, size/align conflicts, metadata vs ABI conflict, tied soft candidates, non-convergent cycle truncation, budget exhaustion, cancellation, invalid size/align, unsupported ABI, determinism, C2-01 dependency fixture | `js/analysis/types/constraints.js`, `js/analysis/types/scc.js`, `js/analysis/types/graph.js`, `js/analysis/types/index.js`, `js/analysis/index.js` | c3-01-counterexamples 14/14 PASS, Phase 7 types 72/72 (416/416) PASS, Phase 8 33/33 PASS, Metadata 5/5 PASS, P7_VERDICT=READY | PASS | exact head verified | — | non-regression only; C2-01 memory boundary gated | none (C2-01 and ME-01 isolated) |
| HEX-C3-02 | REMAINING | PARTIAL | Sol | — | — | — | ME-01, C1-02, C2-01 | several ABI plugins implement aggregate/HFA/HVA paths; locked cross-profile matrix incomplete | current ABI classifiers | pending ABI/platform/vararg/thunk denominator | — | — | — | platform misidentity can mint hard wrong prototypes | none |
| HEX-C3-03 | COMPLETE | COMPLETE | Sol | `specs/003-versioned-language-metadata` | T001–T014 complete | `feat/analysis-hex-c3-03-versioned-language-metadata` | C3-02 | unified versioned metadata providers across Go (1.2, 1.16, 1.18, 1.20+), Rust (v0/legacy), Swift 5, and ObjC 2.0 with fail-closed verdicts and TypeConstraintGraph wiring | `js/metadata/**`, `js/analysis/index.js`, `js/apple/runtime.js` | 5 metadata suites (provider contract, Go, Rust, Apple, downstream integration), 37 assertions, broad regression PASS | analyze clean; converge PASS | exact head green | `f205d17b` | non-regression only | none (ME-01 isolated) |
| HEX-C4-01 | ACCEPTED-LOCAL | LOCAL_COMPLETE | existing/main | historical Phase 8 | C4-01 complete | `feat/analysis-roadmap-v8-current-main-20260907` / PR 7036 | C0-01 | 19 analysis keys, frozen stage ordering, PassDescriptor contract (consumes/produces/preserves/invalidates), under-invalidation fail-closed drop, over-invalidation preservation, staged production agreement, atomic rollback on cancellation/exception, deterministic replay digest verified | `tests/phase8/substrate/c4-01-acceptance.test.mjs` | c4-01-acceptance 7/7 PASS, substrate suites PASS | PASS | exact head green | — | whole-roadmap/release gates remain open | none |
| HEX-C4-02 | REMAINING | PARTIAL | Sol | — | — | — | C4-01, C4-04 | edge-accounted structuring retains residual jumps; broader exception-aware proof is absent | Phase 8 structuring facts | pending irreducible/exception/refinement matrix | — | — | — | visual improvement must not change semantics | none |
| HEX-C4-03 | REMAINING | PARTIAL | Sol | — | — | — | C4-01, C2-01 | transform origins and stale artifact rejection exist; full bidirectional mapping is unproven | partial Phase 8 provenance | pending every transform/rendered entity reverse mapping | — | — | — | deleted/merged entities may lose navigation | none |
| HEX-C4-04 | REMAINING | PARTIAL | Sol | `docs/symbolic-proof-optimizer-v8.md` | original-canonical/private pass adoption and ordinary sign-mask proposal slice implemented; wider observables remain | `feat/analysis-roadmap-v8-current-main-20260907` / existing PR 7036 | C4-03, SYM-01, ME-01 | independent original-canonical proof now gates supported scalar proposals; v4 reuses the sign-mask recognizer with separate idiom audit and unchanged ordinary64 schedule | shared bounded proposal engine, private plan/transaction and safe scalar rendering; generic BV4/BV8 production path | source56f90d964 added8/lint/boundaries/inventory PASS; representation/history30/31, exact proof-boundaries43/46; all4 failure assertions/types reproduced on parent497; build twice zero generated diff | independent source review resolved phase-order regression; no remaining own-diff defect found; not named Sol review | — | — | memory/CFG/exception/undefined-state observables, native-width proof and remaining ordinary idioms remain unproved; proof API is opt-in, default UI activation unproved; full gates are not green | SYM-01/X-03 and issue/environment work remain user-owned |
| HEX-C4-05 | ACCEPTED-LOCAL | LOCAL_COMPLETE | Sol | — | — | `feat/analysis-roadmap-v8-current-main-20260907` / PR 7036 | C2-02, C4-04, SYM-01 | 34 scalar families x 8 widths x 3 schedules (816 cells), 14 Bool families, near-MBA counterexamples frozen denominator verified | `tests/phase9/egraph/c4-05-acceptance.test.mjs`, `js/symbolic/egraph/**`, `js/symbolic/query/equality-saturation.js` | c4-05-acceptance 8/8 PASS, rule-order 7/7 PASS (816 cells), family-width 5/5 PASS | PASS | exact head green | `3ec76b5a5` | candidate generation never creates authority; independent proof required before adoption; fail-closed on memory/effects/contradiction/budgets | none |
| HEX-SYM-01 | ACCEPTED-LOCAL | LOCAL_COMPLETE | Sol | — | — | `feat/analysis-roadmap-v8-current-main-20260907` / PR 7036 | ME-01 | Branded 64-bit TieredBvBackend, exact small-domain floor (<=8-bit exhaustive), 32/64-bit bitblast routing, SolverRegistry trust contract, SAT model extraction with independent validation, UNSAT contradiction, fail-closed boundaries (corrupt model, hash tampering, resource ceiling, timeout, cancellation) verified | `tests/phase9/verify/sym-acceptance.test.mjs`, `js/symbolic/**` | sym-acceptance 12/12 PASS, ownership PASS | PASS | exact head green | — | physical iPad hardware skipped by user request; whole-roadmap/release gates remain open | none |
| HEX-SYM-02 | ACCEPTED-LOCAL | LOCAL_COMPLETE | Sol | — | — | `feat/analysis-roadmap-v8-current-main-20260907` / PR 7036 | SYM-01, C2-01 | Byte memory state across 1, 2, 4, 8 bytes with little/big endian parity, partial overwrites, concrete-to-symbolic escalation, unique initial byte functions, distinct non-MustAlias symbols, 64-bit modular wrap, memory barriers, symbolicExecute integration verified | `tests/phase9/verify/sym-acceptance.test.mjs`, `js/symbolic/memory/byte-state.js`, `js/symbolic/executor.js` | sym-acceptance 12/12 PASS, ownership PASS | PASS | exact head green | — | unmodelled aliasing must fail closed; whole-roadmap/release gates remain open | none |
| HEX-SYM-03 | ACCEPTED-LOCAL | LOCAL_COMPLETE | Sol | — | — | `feat/analysis-roadmap-v8-current-main-20260907` / PR 7036 | SYM-02, C4-04 | Production taint flow (source -> partial store -> load -> control/data -> phi -> sink -> EvidenceGraph), stable replay identity, declared sanitizers vs unknown fail-closed, may-alias candidate labels, stale identity authority loss, bounded equivalence verification (UNSAT proved, SAT refuted, vacuous proof guard) verified | `tests/phase9/verify/sym-acceptance.test.mjs`, `js/symbolic/taint/**`, `js/symbolic/query/**` | sym-acceptance 12/12 PASS, ownership PASS | PASS | exact head green | — | heuristic sanitizers fail closed; whole-roadmap/release gates remain open | none |
| HEX-X-01 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged before run | C0-01 | transaction v2 binds independent parser/oracle identities | writer-independent reparse gate | rebuild transaction negatives | historical | main evidence retained | historical main | non-regression only | none |
| HEX-X-02 | REMAINING | PARTIAL | Sol | — | — | — | C3-03, X-01, X-03 | bounded chained-fixup and Apple runtime pieces exist without one versioned Apple matrix | fragmented Apple providers | pending dyld/Swift/PAC/signing matrix | — | — | — | version, PAC, fixup and signing drift | none |
| HEX-X-03 | REMAINING | PARTIAL | Sol | — | — | — | C0-01, ME-01, X-01 | discovery/evidence/rebuild pieces exist without one ambiguity-preserving reassemblable artifact | fragmented discovery artifacts | pending overlap/code-data/relocation/reparse matrix | — | — | — | ranked candidate must not become exact truth | none |
| HEX-S2-01 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged before run | C0-01 | provider/session/module/binary/generation identity and stale rejection are wired | runtime identity contract | Stage 2 stale/race regressions | historical | main evidence retained | historical main | new providers must reuse the gate | none |
| HEX-S2-02 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged before run | C0-01 | candidate sets, retained alternatives and truncation reporting are wired | collision-preserving recognition | recognition collision regressions | historical | main evidence retained | historical main | corpus breadth is separate | none |

## Active finding checkpoint: HEX-C1-01

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
