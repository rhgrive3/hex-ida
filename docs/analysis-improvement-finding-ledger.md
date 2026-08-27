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
| HEX-ME-01 | REMAINING | PARTIAL | Sol | — | — | — | C0-01 | external-oracle policy and differential harness exist; no formal/relaxed-memory release proof | partial oracle infrastructure | required formal/hardware/undefined-mask matrix | — | — | — | incomplete observables may create false confidence | none |
| HEX-C1-01 | VERIFYING | MISSING | Sol + one Luna Max implementation owner | `specs/001-loaded-pointer-recovery` | T001–T022; T001–T016 complete | `research-close/integration` / PR 2201 | C1-03 | pre-fix 1/1 failed because the exact load stayed `unresolved-load` | canonical post-MemorySSA points-to refinement; exact byte/proof/provenance/freshness gate; complete-only atomic solver publication | focused 11/11 twice; pointsto/alias 59/59; Phase 7 36/36 (287/287); Semantic V2 54/54; Phase 8 27/27 (277/277); inventory 3/3; lint 1505 files; syntax/diff/manifest PASS | analyze clean; converge pending | — | — | target set is single-store only; multi-store bytes remain C2-01 | none |
| HEX-C1-02 | REMAINING | MISSING | Sol | — | — | — | C1-03 | production still returns `unresolved-call` | no complete return-pointer summary relation | pending complete/incomplete/recursive target matrix | — | — | — | incomplete summary must join unknown | none |
| HEX-C1-03 | COMPLETE_EXISTING | COMPLETE | existing/main | historical | historical | merged PR 2185 | C0-01 | provenance-backed root separation is on live main | canonical roots; spelling cannot mint exact separation | alias provenance negative regressions | historical | main evidence retained | `552f798f` | non-regression only | none |
| HEX-C2-01 | REMAINING | PARTIAL | Sol | — | — | — | C1-01, C1-03 | canonical MemorySSA query exists without general byte-coverage consumer | exact-store query only | pending byte coverage, endian, overlap, clobber matrix | — | — | — | one wrong byte creates silent wrong value | none |
| HEX-C2-02 | REMAINING | PARTIAL | Sol | — | — | — | C2-01 | wrapped intervals and SCCP exist; known bits, value congruence, edge refinement absent | Phase 8 wrapped range floor | pending lattice laws, wrap, branch and widening corpus | — | — | — | signed/wrapped narrowing unsoundness | none |
| HEX-C3-01 | REMAINING | PARTIAL | Sol | — | — | — | C1-02, C2-01, C3-02 | bounded ambiguity-preserving graph exists without recursive structural breadth | `TypeConstraintGraph` authority shell | pending recursive/ambiguous/budget/cancel corpus | — | — | — | solver growth or forced type choice | none |
| HEX-C3-02 | REMAINING | PARTIAL | Sol | — | — | — | ME-01, C1-02, C2-01 | several ABI plugins implement aggregate/HFA/HVA paths; locked cross-profile matrix incomplete | current ABI classifiers | pending ABI/platform/vararg/thunk denominator | — | — | — | platform misidentity can mint hard wrong prototypes | none |
| HEX-C3-03 | REMAINING | PARTIAL | Sol | — | — | — | C3-02 | ObjC completeness and basic Swift model exist; Swift/Go/Rust version identities are incomplete | fragmented metadata providers | pending ecosystem/version/malformed matrix | — | — | — | version drift must remain partial | none |
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
