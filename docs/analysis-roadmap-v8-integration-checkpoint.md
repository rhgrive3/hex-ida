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

The pre-commit full Phase 8 run terminated after 920.3 s with eight failing
tests. Log: `/tmp/hex-roadmap-p8-J5ReJR/full.log`. The first failure is
`phase8-measurement-abi-unavailable:riscv64` across 45 frozen corpus entries;
the downstream provenance/edge/provider counters report those missing runs.
This diagnostic run spanned source reconciliation and is not exact-head
release evidence. Repair the first divergence, then rerun on a frozen head.

The source merge may be committed locally as an IN-PROGRESS resume point;
that commit does not complete the locked generated-output transaction and is
not approval to merge #7036 into main. No release or competitor-superiority
claim is authorized by it.

Source reconciliation is locally committed as
`84d1a4f70c94169e6d65f3ba5659864207bf8e9d`, tree
`9b6039df5755ae3e32c38034c344f34b1fe005e4`, with the recorded PR head and
`404537698` as its two parents. Exact-SHA ownership CLI checks and both
ownership regression suites passed on that commit. Its 155-path inventory
retains all original 140 changed paths. It has not been pushed to #7036.

### First full-gate divergence: restore an existing ARM64e contribution

Git history identifies the first machine-effects failure precisely: merged
PR #7317 (`d37711f09f39542d11a526387cf23cb620ad4cc7`) added the four
`paciaz`/`pacibz`/`autiaz`/`autibz` effect definitions. The next architecture
merge, #7319 (`a16dcf744`), added authenticated loads but deleted those
definitions while leaving the encoding and denominator additions intact.
This is lost existing work, not a new missing implementation.

The original seven-line definition/comment patch is restored in the current
integration tree, preserving #7319's authenticated-load dispatch. The two
additional exact ownership paths are the ARM64e effect provider and
`tests/machine-effects/arm64e-retained-provider-union.test.mjs`; no blanket
architecture or verifier exemption was added. The new canonical-discovered
regression requires both merged contributions on the same product and the
full unchanged PAuth denominator. It passed 0/2 before restoration:
`/tmp/hex-roadmap-arm64e-union-before-ORLqpU/full.log`.

After restoration, the new union test plus existing zero-modifier,
authenticated-load, operand-arity and full PAuth denominator suites passed
(6.9 s). No denominator, oracle or assertion was reduced. This removes the
first diagnosed divergence, not all 20 full-gate failures; the complete gate
still requires a new run on the next exact candidate. The LLVM oracle check
also confirmed this environment has LLVM MC 14 while the AArch64 CSSC tests
require LLVM MC 18; substituting an older oracle cannot count as proof.

### Generated-output dependency resolved through main

The ARM64e restoration is committed locally at
`01ff25c034db476ec80aa0a33a64c3a94c29e103` (tree
`b7407be43d80c73f6a9275491253c598cb6da298`). The full canonical Phase 9 suite
with the existing serial option passed on that clean source head (149.0 s).

Main then merged the existing #7503 as
`058177e3ba15511aae290495fa98e7129fda2583`. Its six-file delta was inspected
and reconciled into this same integration lane without a replacement PR or
reimplementation. The canonical userscript build now passes (3.4 s).
Generated release serial: `2322242153`; protected build ID:
`aad2e431ec27488ffca245b2`; release identity:
`563ec8ef0f149c372fa23c38396dc7d203266c0a59400b429577f2af2d700c0c`.
Commit/rebuild-zero-diff and current-head runtime tests are the next checks;
this successful build alone does not unlock the integration checkpoint.

The canonical `npm run userscript:test` passed on the reconciled candidate
(55.0 s). Its final tests rewrite the deployment-identity stub to an equivalent
null export, so a subsequent canonical build restored the canonical generated
source before staging; that transient test output is not a new owned path.
The generated-runtime Chromium/WebKit sandbox E2E also passed (9.4 s), with
actual decoder/semantic Workers. Re-run it sequentially after final generated
synchronization before using it as exact-candidate evidence.

The existing local LLVM distribution was verified as Ubuntu LLVM 18.1.3 at
`/mnt/workspace/.local/hex-stage-a-llvm18/bin/llvm-mc-18`. The previously absent
`/usr/bin/llvm-mc-18` now links to that verified launcher so the unchanged
canonical tests select their required LLVM 18 oracle. No LLVM 14 executable
was replaced and no test fallback/denominator was changed.
The same verified distribution supplies the previously absent
`/usr/bin/clang-18` and `/usr/bin/llvm-objdump-18` names. LLVM 18 then passed the
unchanged integer denominator (68,899 Capstone forms plus two LLVM CSSC forms)
and the complete 267-case memory denominator. The prior memory-oracle count
failure was the LLVM 14 disassembly format, not permission to reduce cases.

The main/generated reconciliation is committed locally as
`c7d79f70703ce0d87adfb4c7c7f8af0b39f1340c`, tree
`21b292ae96ce128bc68c009a221a5ed4fa72fd02`. Canonical rebuild passed (6.2 s)
and produced zero diff in both committed userscript artifacts and the
deployment-identity stub. A subsequent sequential Chromium/WebKit sandbox
E2E passed (18.3 s) on that synchronized source/runtime. This is desktop engine
evidence, not physical iPad evidence or a deployed-runtime claim.

### Phase 8 first-divergence repair: explicit compiler ABI evidence

Merged #6975 intentionally made architecture-only RISC-V ABI selection
ambiguous. The frozen Phase 8 corpus already records `-mabi=lp64` in its
toolchain target, but `decoded-function-adapter.mjs` never received a calling
convention. All 45 RISC-V entries therefore stopped before product analysis.
The registry's refusal is retained; no architecture-based ABI guess is added.

The measurement path now passes the recorded compiler ABI to the existing
product resolver, matching both architecture and target triple. Missing,
duplicate, unsupported, conflicting or malformed target/profile metadata is
blocking. `observeCorpus`, edge accounting, aggregate certainty and provider
evidence carry the caller corpus's toolchain explicitly; missing caller
metadata cannot borrow the default frozen corpus metadata. The frozen corpus,
compiler argument records, baseline observations, denominators and thresholds
are unchanged. The default single-entry API still uses its frozen corpus
toolchain for existing frozen-entry callers.

`tests/phase8/corpus/explicit-compiler-abi.test.mjs` passed 0/2 before the repair
(log `/tmp/hex-roadmap-p8-abi-before-Tbx8Ub/full.log`) and now passes, including
negative checks across all metric consumers. Ownership checks pass using the
existing Phase 8 manifest, without frozen-path exemptions. A complete 45/45
RISC-V corpus execution passed without per-function errors (33.0 s); this
focused evidence does not replace the full Phase 8 safety/quality gate.
Verifier version advances from 1.1.0 to 1.1.1 because measurement changed;
older verifier reports are not evidence for this repaired candidate.

The exact clean ABI-repair head
`a2fcb0fee2713e28b4c213334b7441d20b0f0ed2`, tree
`8a9b16471a5a25d52ded47cba6076d497bf1b7fb`, passed the entire canonical
`npm run phase8:test` (1142.5 s), with verifier 1.1.1. Its focused ABI
regression and canonical rebuild/zero generated diff passed first. The worktree
was kept frozen for the complete run. This is full Phase 8 test evidence for
that exact head, not a release READY verdict or proof of subsequent changes.

### Retained address evidence and current budget fixtures

While that run was live, corrective work used a separate detached worktree at
the same base (`/mnt/workspace/hex-roadmap-v8-repair.kPhcD5`), leaving the
authoritative integration tree unchanged. No replacement PR was created.

The already-merged #7317 strict-address test exposed a remaining hole in the
#7053 literal-target coherence helper: malformed present target fields were
treated as absent, allowing a different valid field to produce an exact load.
The existing canonical helper now rejects malformed/out-of-domain evidence,
including an existing immediate operand whose value is invalid. Nullable
optional structured fields remain absent, and valid signed/unsigned 64-bit
wraparound remains supported. LDR, LDRSW and PRFM are checked through both the
architecture dispatcher and family provider, with/without encoding bytes.
No second address engine, reduced denominator or relaxed arity rule is used.

Before repair, the original strict-address test failed at `LDR literal array
target` (`/tmp/hex-roadmap-literal-before-O2RomV/full.log`), and the new matrix
failed at `ldr/structured/pcRelTarget`
(`/tmp/hex-roadmap-literal-matrix-before-nfuovs/full.log`). After repair, all
eight selected literal/addressing/prefetch/memory-denominator suites passed
(0.8 s), including all 267 LLVM+Capstone memory cases.

Merged #7055 correctly requires the producer budget class to enter an artifact
identity when completeness depends on it. Three older foundation fixture
files omitted that class. They now declare `interactive`; the production
requirement, cache-dependency assertions and malformed-callee negatives are
unchanged. The selection previously passed 23/38 tests with all 15 failures
caused by the missing budget class
(`/tmp/hex-roadmap-p7-budget-before-ASlYZV/full.log`). All 38 now pass, together
with both ownership regressions (0.7 s). The five additional changed paths
are explicitly assigned; no blanket ownership allowance is added.

Repair candidate lint passed (4.3 s); canonical generated build passed (4.1 s).
Release serial is `2322242154`, build ID `35c29341e2040e8dec97b982`, release
identity `56f8f5e7dd27e7487b5a14b097943a89b222d3d034858ba5efe21dff7f95da8d`.
Commit/rebuild-zero-diff, complete current-head gates and runtime checks remain
required. The earlier Phase 8 green does not attest these new runtime bytes.

That repair is committed as `08afd3431bf15601839d8dd54039b6014c531c87`
(tree `761beaa4350691b67f9c6276665242129ea60013`) and was fast-forwarded
back into the same integration branch only after the earlier run terminated.
Its own-head changed tests passed (0.6 s), canonical rebuild produced zero
generated diff (3.3 s; repeated on integration in 3.4 s), exact ownership
validated 169 paths (12 Phase 7 / 24 Phase 8), and sequential generated-runtime
Chromium/WebKit sandbox E2E passed (9.7 s). This is not physical iPad evidence.

The complete Phase 7 suite on that exact head passed 1313/1327 tests (86.6 s),
leaving 14 failures instead of the prior 29:
`/tmp/hex-roadmap-p7-current-Vn0TG0/full.log`. The full `npm run check` stopped
at the MachineEffects invariant (145.0 s), with 11 failing files instead of
the previous 20: `/tmp/hex-check-8fOO1P/full.log`. Later gates were not reached;
these partial results do not satisfy the repository exit gate.

### Existing #7097 cache repair reused, not reimplemented

The remaining #4486/#4487 shared artifact failures already have a source fix
in open PR #7097 at `f8d127553914efe18e51ab86a60b9f05243c7b7b`. Its exact
`js/analysis/shared-app-artifacts.js` blob is reused after inspecting its full
delta and reconfirming that PR head. Existing canonical tests for both issues
are byte-identical on the integration and PR heads. No other #7097 paths are
imported, and this is not a claim that the entire PR has been integrated.

The fix evicts settled obsolete epoch entries, preserves in-flight consumers
until settlement, and rejects a producer when a newer symbol-generation
producer already owns the destination cache key. Both issue tests plus shared
result contracts, abort registration races, zero-waiter producer races and
retryability regressions passed with ownership checks (0.7 s).

The first remaining ARM64 branch failure was an outdated diagnostic assertion:
merged #7335 rejects malformed operands before target-coherence checking. The
test now requires that exact earlier refusal and additionally checks zero
operations/no definite control edge. Production branch behavior is unchanged.
The original assertion failed in `/tmp/hex-roadmap-branch-first-a9Vdgw/full.log`;
the corrected contract test passes (0.2 s).

The cache source and branch test are explicitly owned additional paths.
Canonical generation passed (3.2 s), producing serial `2322242155`, build ID
`59e5ab229ebea67dc8c43d27`, release identity
`bb73b24028b8795d5218e407fb00fea43397913dc8fb6b519e4cf2306889d43c`.
Exact commit/rebuild-zero-diff and new-head broad gates remain to be verified.

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
