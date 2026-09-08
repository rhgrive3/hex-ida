# Analysis roadmap v8 integration checkpoint

Status: IN PROGRESS. This checkpoint does not close the research roadmap or
claim superiority over IDA/Ghidra. The original 23 findings and all acceptance
requirements in `docs/解析ツール改善.md.txt` remain the objective.

## Authoritative inputs and integration owner

- Source ZIP: `tmp/analysis-roadmap-local-v8-implemented-main.zip`, SHA-256
  `735b2738f614ecb38d00de539221fdecaedcf7673d73b5ad477dd28a47027ade`.
- Existing integration PR: #7036, branch
  `feat/analysis-roadmap-v8-current-main-20260907`.
- Inherited PR head: `8254ebe98bf6060bd902837d3751428a4fc15860`.
- Reconciliation base fetched from live main on 2026-09-09:
  `404537698d019abe9c1c685718689a34ff5ebb4d`.
- Local integration worktree: `/mnt/workspace/hex-roadmap-v8-integration`.
- Integration, moving-main reconciliation, and generated-output owner: this
  branch. No parallel component lanes have been started.
- The original worktree's untracked `tmp/` and `diagnostics/` are preserved.

The existing PR already contains the 140-path v8 delta plus the producer-time
IR binding repair requested by its first review. Its next review requires
current-main reconciliation, preservation of that delta, ownership validation,
and fresh exact-head proof. Historical local PASS reports are not current proof.

## Reconciliation and first divergences

Five files conflicted: type constraints, type graph, solver session, static
scalar translator, and verification-query construction. Reconciliation retains
the live-main primitive structural-integer boundary, explicit aggregate bounds,
array constructor identity, invalid entity identity, AbortSignal subscription
validation, null translation-target refusal, and bounded metadata rejection.
The v8 bounded snapshots, recursive union/array recovery, source binding,
query hashing, solver admission and taint/memory paths remain present.

The initial combined focused run had 343/356 passing tests. Subsequent focused
reconciliation exposed and repaired missing recursive-array annotations and
changed structural-integer diagnostic codes. Another serial run had 171/176
passing tests: all five remaining failures were proof-query deadlines.

A CPU profile of the actual production optimizer showed repeated model-object
construction and async recursion in exhaustive enumeration. The solver now
uses the existing evaluator's Map environment and an iterative mixed-radix
counter, materializing only SAT witnesses. Enumeration domains, deadlines,
task-queue yields, model validation and tier agreement are unchanged. The
post-change proof/real-backend/tier-deployment/abort-race selection passed in
41.7 seconds. New tests additionally require all 64 mixed Bool/BV valuations,
the final valuation's SAT witness, immutable prior witnesses across replay,
and host cancellation at a yield.

The full Phase 9 gate passed with the existing supported serial option:
`HEX_PHASE_TEST_CONCURRENCY=1 node scripts/run-quiet-command.mjs --label roadmap-p9-serial -- npm run phase9:test`
(152.5 s). This predates the subsequent metadata-ceiling reconciliation below;
the current exact candidate still requires a fresh full run. The default
parallel run had timed out in `verify/symbolic-footprint-oracle.test.mjs` under
local contention. No timeout, sample, denominator or assertion was relaxed.
The two old `equivalence.test.mjs` sort-mismatch assertions also fail on the
original main worktree at `8d4991de03de5ae340fc158db9891ab3fd1d9b77`.
Those files and the equivalence implementation are identical at the fetched
`404537698` base. The newer #6092 contract explicitly requires UNKNOWN instead
of a fabricated REFUTED/SAT result when sorts differ. Baseline log:
`/tmp/hex-roadmap-existing-sort-contract-WBOlOb/full.log`. This is a diagnosed
baseline inconsistency, not a passing broad gate.

Reconciliation now aligns those old assertions with the existing #6092 UNKNOWN
contract, uses the genuine ExhaustiveBvBackend in the #5498 authority fixture,
and fixes #5489 deserialization by constructing wide connectives from a dense
array rather than spreading beyond the JavaScript argument-count ceiling.
Targeted current-main regression/Expr/real-backend checks passed (27.4 s).

The metadata merge initially reduced main's public 512-depth/65,536-node
ceilings to the old v8 identity defaults. That was corrected: main's ceilings
remain explicit, while v8's separate 40,000-unit serialized-expansion guard,
accessor refusal, cycle refusal, immutable snapshots and longest-DAG-path
checks remain enforced. A permanent test pins the public constants and accepts
a 256-level identity through query creation and structured-clone validation.
Metadata boundaries + #5496 + tiered deployment tests passed (17.9 s).

## Existing-PR reuse and current gate evidence

Live main and #7036 still resolve to the recorded base/head above. Existing
open PRs were inspected before adding repairs:

- #7495 at `6f7e04680c859c9b8bcbb99600d3106a6ae69665`: its exact
  `issue-4503-structural-array-claims.test.mjs` exposed three failures on the
  integrated v8 tree (explicit field, recursive field, merged pointer shape).
  The existing field/pointer constructor repair is reused in `types/graph.js`,
  retaining v8 union/recursive-array behavior and adding SCC metadata only when
  recursive. Canonical Phase 7 `--group types` passed (5.1 s). This imports only
  the type slice, not the PR's separate summary-argument changes, and does not
  claim that the whole PR is merged or accepted.
- #7507 at `4e52752bf346adc738c6b528379b6f053e4ee3be` and #7515 at
  `fad35f6750e47b963333087f896f728d2d41d1da` contain related exact-solver and
  translator repairs. Their overlap with v8 is recorded for reconciliation;
  unrelated knowledge/runtime changes have not been copied into this lane.
- #7503 at `6cac8502d47555bda258494d4cf3f450e41f34c3` owns the existing
  userscript Capstone build fix. The candidate's canonical build reproduced
  `Could not resolve "node:fs"` in the x86 semantic-revalidation Worker.
  Log: `/tmp/hex-roadmap-userscript-build-8vfEUx/full.log`. Do not reimplement
  that fix or hand-edit generated files. Generated synchronization remains a
  blocking integration dependency; this checkpoint is not unlocked.

Full Phase 7 on the candidate before the #7495 slice: 1,294/1,323 tests passed,
29 failed. A clean detached worktree at the exact `404537698` base ran the
same canonical command: 1,261/1,290 passed, 29 failed. After normalizing only
worktree roots and elapsed times, all 29 failing test names match; no new
failure name was introduced by that candidate. This is new-failure evidence,
not a green gate or proof that all failure diagnostics are equivalent. The
subsequent #7495 type slice and metadata change require final re-verification.

- Candidate log: `/tmp/hex-roadmap-p7-rE2vNj/full.log`, SHA-256
  `502840dc0d1865370ef26d04fbacdbdbdf98be32ab6501c096bd70ea9804c102`.
- Base log: `/tmp/hex-roadmap-base-p7-vz6oty/full.log`, SHA-256
  `0a3583253e901e05bfb04d8f06a6d13df81fbc15d755a285d2517f1f314353de`.
- Base worktree: `/mnt/workspace/hex-roadmap-base-404537`, tracked tree clean.

`npm run check` ran canonically and failed (172.6 s) at
`invariants:test` / `machine-effects-contract`, with 20 failing machine-effects
files. Log: `/tmp/hex-check-CZZkTS/full.log`. The first reported divergence is
`arm64e-pac-denominator-registry-drift`; additional failures include an LLVM
CSSC feature/toolchain mismatch and invalid exact-commit evidence on this
uncommitted merge tree. These failures are not waived as unrelated. Diagnose
them against the exact base and already-existing owner PRs before changing
production code, denominator sets or test expectations.

Full Phase 8 remains running. Poll its live handle before any restart. Passing
selected tests does not satisfy the full gate.

The source merge may be committed locally as an IN-PROGRESS resume point;
that commit does not complete the locked generated-output transaction and is
not approval to merge #7036 into main. No release or competitor-superiority
claim is authorized by it.

## Ownership and regression policy

`tools/validation/analysis-roadmap/ownership.json` enumerates exact paths for
Phase 7, Phase 8, symbolic, semantic compatibility and integration ownership.
Both CI ownership jobs validate the whole union before selecting their phase
slice. Existing phase manifests and forbidden-path controls still apply.
Only the exact integration branch gets this route. Unknown files, glob-based
allowances, duplicate owners, relabeled frozen contracts and empty phase
inventories are rejected. Both permanent workflow-dispatch fallbacks use the
same validator. The policy regression is discovered by both canonical runners.

The original 140-path delta is still present relative to the fetched main;
new ownership/tests/checkpoint paths are additional integration work. Any
further path must be explicitly assigned and reviewed, never silently filtered.

## Completion audit still required

No finding is newly marked complete by this checkpoint. Historical ledger
classifications are leads to inspect, not proof against this candidate.

| Finding | Current evidence to audit before closure |
|---|---|
| HEX-C0-01 | Same-binary debug/strip identities across every scored binary |
| HEX-ME-01 | Formal/hardware/QEMU defined-state and relaxed-memory denominators |
| HEX-C1-01 | Current MemorySSA-backed loaded-pointer production boundary |
| HEX-C1-02 | Current return/allocation summary complete-target matrix |
| HEX-C1-03 | Provenance-backed roots and false NoAlias/MustAlias negatives |
| HEX-C2-01 | Byte-complete forwarding, endian/overlap/clobber proofs |
| HEX-C2-02 | v8 product-domain transfer plus held-out precision/loop evidence |
| HEX-C3-01 | Reconciled recursive types, ambiguity and exact layout matrix |
| HEX-C3-02 | Current locked ABI/aggregate/varargs/prototype matrix |
| HEX-C3-03 | Versioned language metadata and unknown-version matrix |
| HEX-C4-01 | Canonical transaction lifecycle and invalidation non-regression |
| HEX-C4-02 | Irreducible/exception-aware transforms and edge proofs |
| HEX-C4-03 | Every raw/optimized/rendered forward and reverse mapping |
| HEX-C4-04 | v8 pure constant projection plus remaining risky rewrite observables |
| HEX-C4-05 | Bounded e-graph candidates, independent proofs and resource matrix |
| HEX-SYM-01 | Real 32/64-bit solver tiers and physical iPad/WebKit evidence |
| HEX-SYM-02 | Byte-memory escalation, alias/partial-write independent oracle |
| HEX-SYM-03 | Taint/source/sink/sanitizer and proof-gated deobfuscation matrix |
| HEX-X-01 | Independent writer/reparse admission non-regression |
| HEX-X-02 | Apple dyld/fixup/PAC/metadata/signing matrix |
| HEX-X-03 | v8 layout candidates through discovery/rebuild/oracle production path |
| HEX-S2-01 | Runtime/session/module/generation identity non-regression |
| HEX-S2-02 | Recognition collision/alternative/truncation non-regression |

Required integration exit: lossless source inventory audit; complete canonical
Phase 7/8/9 and repository gates; generated-output build/commit/rebuild with
zero diff; exact-head verifier/corpus/toolchain identities; fresh independent
review and required CI; tested candidate merge tree; expected-head merge and
post-merge live-main verification. Browser/device or deployed-runtime claims
require their own actual runtime identities. None is replaced by Node tests.

Resume on this worktree and the same PR. Inspect Git status, HEAD/MERGE_HEAD,
live PR/main and current test handles before acting. Do not restart tests from
an old log alone. Update this checkpoint at the next integration transition.
