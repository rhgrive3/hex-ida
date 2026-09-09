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
- Active persistent integration worktree: `/mnt/workspace/hex-roadmap-v8-integration`.
  The old `/tmp/hex-roadmap-recovery.wWNZ2Z/repo` disappeared when the execution
  environment changed. Its source patches have been recovered; old temporary
  test logs and commit objects are not current evidence. See durable recovery below.
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

The reused slice and branch assertion are committed at
`68319ac9b5f8c476f3387129e2a592f22e27d954` (tree
`959867d2c40b64b73d5734cfc43399487cbfd96f`) and fast-forwarded into the
same integration branch. Own-head targeted tests passed (0.6 s); canonical
rebuild produced zero generated diff (3.5 s; repeated on integration in
3.3 s); generated-runtime Chromium/WebKit sandbox E2E passed (8.2 s).
The complete changed inventory is 171 paths (13 Phase 7 / 24 Phase 8).

Full Phase 7 on that exact head passed 1315/1327 tests (68.8 s), with the two
reused fixes removing their failures:
`/tmp/hex-roadmap-p7-cache-exact-LREJCy/full.log`. The remaining 12 are
canonical proof address-space normalization (#6066), summary region geometry
and merge identity (#4064), provenance index typing (#4314/#6069), canonical
summary writes (#4320/#5752), and fallback completeness (#5851). The next
#6066 correction also already exists as a one-line change in #7097's pinned
`pointsto/lattice.js`; it has been inspected but not yet imported.

The next MachineEffects diagnostic selection is retained at
`/tmp/hex-roadmap-next-me-0jjBMr/full.log`. It distinguishes conflicting
`movzx ax,bx` width expectations (#5553), a stale source-shape routing assertion (#5566),
RISC-V compressed-profile contract differences (#5999), and x87 terminal
authority failures (#6133). These are unresolved; no oracle/terminal-domain
coverage is claimed from the earlier targeted ARM64 successes.

### Phase 7 remaining-boundary reconciliation

The documentation checkpoint head `391e320774bb40392624cc98dc17ec9d7ba0778d`
(tree `32163ae71b17d5326d9e26b5ae1473df8e67f552`) passed the entire canonical
Phase 9 suite with the supported serial option (132.4 s). It remained clean
and unchanged while that run was live. Subsequent corrections were prepared
in the existing detached repair worktree, not a replacement integration PR.

The #6066 address-space normalization correction is now reused exactly from
#7097 `f8d127553914efe18e51ab86a60b9f05243c7b7b`; that live PR head was
reconfirmed. The complete points-to test directory passes (1.0 s), including
canonical-proof precision and unbranded/lookalike proof refusals.

For #4064, the existing local summary builder already carried canonical region
geometry for intrinsic access scopes but omitted it from direct load/store
effects. Both paths now feed the same existing `createMemoryEffect` geometry
validator. The omission is also present on the merged #7467 source head; this
is a missed producer path, not grounds to import an older summary engine.

The public summary boundary already defines number-only safe nonnegative
argument/return indices. Its unused `optionalIndex` validator is now used
instead of the coercing helper, so serialized string and BigInt indices cannot
be laundered through construction. Arbitrary-precision offsets retain their
existing exact integer normalization. The #6069 positive fixture now uses
canonical numeric indices and supplies the required argument index; its
hexadecimal, binary, octal and signed offset assertions remain. The #4314
consumer matrix additionally checks BigInt indices for both fields.

The other failures were old fixtures bypassing newer existing contracts:

- #4064 duplicate-geometry models now supply exact model schema/version,
  target/snapshot identity and provenance; rejection of incomplete models is
  unchanged. One-sided geometry still cannot prove separation, while two
  canonical proofs retain both instruction origins.
- #4320's positive disjoint-write check now uses actual canonical geometry,
  with overlapping and id-only-negative controls. Different region labels
  alone do not prove disjoint memory.
- #5752's resolved intrinsic fixture now returns a real canonical region.
- #5851's incomplete callee carries its required broad fallback write; its
  modeled external call carries the existing versioned model contract.
  Neither missing-model rejection nor unresolved-call conservatism is relaxed.

All six previously failing summary test files passed (0.8 s), then the entire
summary test directory passed (1.6 s). Both ownership regressions passed
(0.6 s), lint passed (3.0 s), and canonical generation passed (3.3 s). The
inventory is 179 exact paths (21 Phase 7 / 24 Phase 8). Release serial is
`2322242156`, build ID `aa7381613722f0b52e060deb`, release identity
`e0e61b7bc8db36b81342a26c359222d1d590f4a9bd6db94ea5f26cc84cf08ba9`.
These focused results require commit/rebuild-zero-diff, complete new-head
Phase 7 and downstream verification before they can close the remaining gate.

That reconciliation is committed at
`d0da0fe577dc3c82f8bce18e5341f0e155b35e10` (tree
`ba8c3912c0edf8b3e19d0bd58eea6cc010ed784b`). Canonical rebuild produced
zero generated diff (3.0 s), and the entire canonical Phase 7 suite passed
(79.4 s), removing the remaining 12 failures without excluding tests. The
same integration branch then fast-forwarded to that tested tree. Its rebuild
again produced zero generated diff (3.3 s); generated-runtime Chromium/WebKit
sandbox E2E passed (8.3 s) in the detached worktree. Full Phase 8 was started
there on the frozen `d0da0fe57` source and remains pending at this checkpoint.

The full repository gate on `d0da0fe57` stopped at 10 MachineEffects files
(145.2 s), log `/tmp/hex-check-PMCHWg/full.log`. No later gate is inferred
green from that stopped chain.

### x86 conflicting fixture expectations, independently checked

The #5553 negative fixture predates `36e1c24498c2f8dc4ccc0c757d2a2e13678fbf87`,
which added MOVZX/MOVSX 16-to-16 operand-size handling. The canonical integer
denominator already requires those same real byte sequences to remain exact.
Rather than treating either test expectation as independent truth, a bounded
native probe checked the RAX result of five byte sequences across 105 cases
on GenuineIntel Xeon Platinum 8269CY (x86_64). MOVZX16/MOVSX16 preserve upper
RAX and copy the source's low 16 bits in those observations; MOVSXD16/32/64
also matched the canonical denominator's update policies.

The standalone fixture is retained at
`tools/validation/machine-effects/fixtures/move-extension-register-oracle.c`.
Its source SHA-256 is
`eed187708d7577167dea2c7999d1130a5c45ec97754a875027137d5767575702`;
the observed binary SHA-256 was
`315fe142d4f13d63f9f3e938390b363bd91f23e3246afc8da8e72c3102f053cd`.
Command: `/usr/bin/gcc -O2 -Wall -Wextra -Werror <fixture.c> -o <temporary-binary>`,
then execute that binary. Compiler: Ubuntu GCC 11.4.0-1ubuntu1~22.04.3.
The initial standalone LLVM 18 link attempt failed because its local libc
launcher conflicted with the system linker; this is not a successful LLVM
oracle run. Host GCC supplies this separate native probe only, not any frozen
LLVM corpus requirement. This probe measures RAX only: no claim is made about
flags, faults, all CPU implementations or the complete MachineEffects oracle.

The two #5553 cases remain in the permanent test matrix, now with their
observed/current-canonical positive expectations. All other malformed width
and deferred-memory negatives remain. #5566's source-shape assertion now
requires the existing receiver-provenance argument (`decoded`); its dynamic
SETcc, unknown-set-family and SETSSBSY fail-closed checks are unchanged.
Both corrected fixtures, the full existing integer denominator and ownership
regressions passed together (23.6 s). No production x86 instruction logic or
denominator was changed by this reconciliation.

### Restore the existing RISC-V decoder union

Full `npm run check` on clean `e58a71745244093b0577d57517b0819aa4f09189`
stopped at eight MachineEffects files (148.5 s), down from ten on `d0da0fe57`.
Log: `/tmp/hex-check-i49w0R/full.log`. The two corrected x86 fixture files
passed; the remaining files are independent-oracle-report, #5999 compressed
capability, both #6133 x87 files, closure matrix, extended state, FP denominator
and SIMD denominator. Later commands in the check chain were not reached.

The RISC-V first divergence is a lost producer union, not an obsolete rejection
expectation. Merge `91fafb2d3d6fb707d38583d3b4de479bd7b017f6` (#7010) removed
the existing #7262/#7070/#6973 address/geometry typing, primitive identity,
intrinsic byte snapshot and two-way compressed-capability validation. Its
parent `617d7eb4c65635fc91f81bdecfc2df7fd0fbe7bf` already contains those repairs.
The single existing decoder is restored from that exact parent; the only
additional reconciliation preserves #7010's `compressed-profile-contradiction`
diagnostic when a C-capable mode explicitly denies C. The reverse contradiction
retains `compressed-capability-conflict`, and non-booleans remain invalid.
Two older fixture assertions now name that preserved diagnostic; their
rejection conditions and all positive cases remain unchanged.

A canonical MachineEffects union test imports the existing #5813 typed-field,
#5990 identity and #4992 byte-authority regressions, so those prior contributions
cannot silently disappear behind a later gate. Before restoration, that union
plus #5999 failed (0.3 s), including an actual missing rejection for typed
geometry and for `rv64im` with `compressedInstructions:true`.
Log: `/tmp/hex-roadmap-riscv-union-before-gsM7YT/full.log`.
After restoration, the union, both #5999 suites, #6009 byte-domain and both
ownership regressions passed (0.6 s). Lint passed (3.3 s); canonical generation
passed (3.2 s), serial `2322242157`, build `67f64a2ec292d23c98bdf2d9`, release
identity `9a075a3cec9dae23a7a709f1281af4361587b0bd5b3a2ee4685fbe6552498c30`.
The broader RISC-V MachineEffects and Phase 6 decoder selection, plus #6038
strict-token checks, passed (19.9 s). The actual 185-path inventory validates
with the existing Phase 7/8 slices (21/24 paths). Exact-head rebuild and full
affected gates remain required after commit.

At that checkpoint the separate full Phase 8 process on frozen `d0da0fe57`
was still live. It subsequently terminated PASS (1152.6 s); that historical
result cannot attest the subsequent RISC-V or x86 source restorations.

Next x86 diagnosis: the #6910 head
`e5331237de68183c0c8b11d9e7f083c0e7161d8d` contains the missing Capstone
`flagsKind` producer classification; #7489 restored consumers but not that
producer. Inspect and reuse the existing contribution rather than inventing a
parallel x87 classifier. Separately, the old direct parser/lifter tests do not
enter #7483's dedicated receiver revalidation Worker. Missing worker authority
must not be papered over by minting a brand in tests or weakening the production
guard. These observations explain next checks, not an x86 fix or passing gate.

## x86 receiver and filesystem recovery checkpoint (2026-09-09)

The previous implementation turn made progress, not merely a status update.
The active local copy remains on the same canonical integration branch at
`b64d71cf985f5c07daf6fb160544339e14d7a0d1`, with the following uncommitted
repairs. No new PR, push, merge, or release claim accompanies this checkpoint.

- Reused #6910's missing Capstone flag-domain producer. The regression checks
  real decoded x87 instructions and preserves public unbranded fail-closed
  behavior. `FEMMS` stays outside the x87 flag domain.
- The actual dedicated receiver redecoded bytes, but the shared compatibility
  pipeline then spread the decoded row, losing its private object identity.
  An optional architecture-owned `liftDecodedExact` hook now receives the
  original row plus canonical context. Other architectures retain `liftExact`.
  No cloned row is rebranded. Generic compatibility and x86 semantic versions
  advance to `1.2.0` and `5.2.1-stage2-x86-denominator` respectively.
- Real source-browser tests cover 13 x87 encodings through both Workers and
  the shared pipeline in Chromium and WebKit (PASS, 4.4 s). The prior missing
  identity failed FSQRT in `/tmp/hex-roadmap-x87-real-browser-ELu2C0/full.log`.
  Generated encrypted-userscript coverage now also requires FSQRT terminal
  effects; the first canonical build and both-engine run passed (7.6 s).
- FCOMI-family Capstone union masks cannot represent their dual flag domain
  reliably. The initial repair named six arithmetic RFLAGS outputs and FPSW C1
  using Intel SDM Vol. 2A, document 253666-088, FCOMI/FUCOMI pages 3-366/367.
  This is a summary, not a numerical or exception-path implementation.
  The native oracle below exposed a C1 discrepancy. The subsequent diagnosis
  below removes that initial C1-write claim before commit.
- The native fixture `x87-compare-flags-oracle.c` executes four encodings and
  twelve finite cases, compiled with GCC 11.4.0 and `-mno-red-zone`.
  On the Xeon Platinum 8269CY/KVM host all six RFLAGS bits match, and C0/C2/C3
  are preserved, but C1 remains set in all twelve cases rather than clearing.
  The oracle correctly returns FAIL (12 divergences). Source SHA-256:
  `1ae6e661190b3ea17bbf62fcad2025930c32c317a8fea1adeef36ee2c5b8b109`.
  Neither expected values nor the acceptance threshold were weakened.
- Focused changed-surface tests passed (2.6 s), and lint passed (3.3 s).
  Full semantic-v2 diagnostic failed (293.2 s), log
  `/tmp/hex-roadmap-x87-shared-pipeline-tBPvd4/full.log`: stale pipeline version
  and missing CFG function identity in two fixtures, two ObjC corpus failures,
  existing MachineEffects denominator failures, and stale generated sync.
  These are not a passing integration gate.
- The previously live full Phase 8 run on exact `d0da0fe57` terminated PASS
  (1152.6 s). The LLVM-18-equipped Phase 6 run on `b64d71cf98` terminated FAIL
  (171.1 s), log `/tmp/hex-roadmap-riscv-phase6-llvm18-lR9lOf/full.log`.
  No test handles from either run remain live. Neither result attests this
  dirty x86 repair tree.

Recovery: shared `/mnt/workspace` NFS returned **Disk quota exceeded** on
explicit `sync`, despite misleading free-space output. A patch could report
success but fail on close, leaving the newly created native C fixture empty.
Existing modified source files were nonempty and copied byte-for-byte into
`/tmp/hex-roadmap-recovery.wWNZ2Z/changes`, then into a full local clone.
The native fixture was restored and hash-checked on local disk. Nothing was
deleted. Do not write or commit on the former NFS worktrees until writes are
independently revalidated. The local clone uses the same branch and GitHub
origin; recorded `origin/main` is `058177e3ba15511aae290495fa98e7129fda2583`,
not a newly fetched live-main claim. Its dependency symlink is read-only use
of the existing installation. Resume builds, tests, and commits in the local
copy. All 23 findings and the integration checkpoint lock remain open.

### Native C1 diagnosis and final working-tree checks

Independent hardware testing reported by the QEMU patch author on 2026-09-02
corroborates the distinction: FCOMI/FCOMIP/FUCOMI/FUCOMIP preserve C1, whereas
FCOM/FUCOM/FICOM clear it, despite the SDM wording:
[QEMU v3 patch and hardware results](https://www.mail-archive.com/qemu-devel@nongnu.org/msg1222232.html).
The local native probe now includes three ordinary FCOM controls using the
same seed/capture sequence. Those controls really clear C1 and preserve the
arithmetic flags. The four FCOMI encodings preserve C1 and correctly write
all six arithmetic flags. This is bounded host evidence, not all CPU models,
NaNs, exceptions, or the complete MachineEffects denominator.

The oracle requires an explicit reference; there is no default that hides a
specification mismatch. With `--reference=observed-hardware`, all 15 cases
pass. With `--reference=intel-sdm`, it still exits 1 with all 12 FCOMI C1
discrepancies, log `/tmp/hex-roadmap-x87-sdm-reference-UODIdB/full.log`.
The product and source-browser assertions now preserve all four x87 C flags
for FCOMI while retaining six RFLAGS outputs and no invented prior-RFLAGS
dependency. The changed test failed the initial C1-writing repair before the
correction (`/tmp/hex-roadmap-x87-hardware-c1-before-uf2fuU/full.log`).
Current native fixture SHA-256 is
`f8d88a1f5095f6afa211a987dc1092fde8fe82acae3aa622c3394b31f734d571`;
GCC binary SHA-256 is
`aa91c2e25a8246a1cbc69cc7c71a10785c0ec5f0f7b252046a4d5ceac04a3d13`.
This diagnoses the host/spec disagreement; formal/target-specific release
acceptance across the required denominator remains unfinished.

Both shared-pipeline fixture failures reproduced on untouched `b64d71cf98`
in `/tmp/hex-roadmap-b64-shared-fixture-baseline-Yu1jDe/full.log`.
The pipeline fixture now expects MemorySSA `1.0.1`, already introduced by
#7113 (`520d8d19b`). The #5414/#5865 fixture now supplies its own CFG function
identity; the existing #6395 head still omitted it. The budget assertion,
accessor snapshot assertions, and separate #3908 foreign-CFG refusal remain
unchanged. No product validator was relaxed to repair either fixture.

Changed-surface tests including both fixture fixes, #3908, hook validation,
viewer version binding and ownership passed (2.3 s). Source Chromium/WebKit
worker proof passed again (4.3 s); lint passed (1.5 s). The actual union is
202 paths with Phase 7/8 slices of 21/24. Canonical build passed (2.8 s), serial
`2322242159`, build `45fb663018c02a425216eee3`, release identity
`bac08d027996e189b7a52298dd0cba83e9b2acbf7b7562c0dec711df07878eb1`.
The final generated encrypted-userscript browser run passed in both engines
(7.4 s), after the hardware-aligned C1 change and this canonical generation.
Commit, zero-diff rebuild, and exact-head checks remain required; these working
tree results are not clean-commit attestations. Full gates still have the
previously recorded ObjC and MachineEffects denominator failures.

### Exact x86 checkpoint and ObjC fixture reconciliation

The x86 repair is committed at
`8a11036847975c0cac3d8a33c7ede6e81f61d3f9`. On that clean exact head,
canonical rebuild passed (2.8 s) with zero generated diff; changed-surface
tests plus #5082 receiver-provenance negatives passed (2.3 s); source browser
proof passed (4.1 s); generated encrypted-userscript browser proof passed
(7.4 s), both in Chromium and WebKit. No full-gate or release claim follows.

The two ObjC corpus failures reproduced on that head (0/2), log
`/tmp/hex-roadmap-8a110-objc-baseline-1bw9aL/full.log`. Existing PRs already
contain the correct production behavior; only the stale fixtures need repair:

- #6817/#3979 validates the declared `protocol_t` size/flags. The old fixture
  left size zero yet expected complete metadata. It now declares a 72-byte
  fixed prefix, preserves the positive completeness assertions, and separately
  requires a zero-sized record to remain incomplete.
- #6639/#6076 (`862a94375`) keeps selector candidates inconclusive when a
  receiver hierarchy is missing. The old #529 fixture treated an absent class
  as a proven contradiction. It now tests both a known unrelated root (zero
  candidates) and an unknown class (both observed candidates, unresolved and
  partial). Category/inheritance/override/protocol tests remain present.

The focused retained-contract and ownership run passed (0.5 s), the existing
#6076 hierarchy negative passed (0.1 s), and full `npm run decompiler:test`
passed (15.0 s). Ownership checks validate the actual 204-path union, retaining
Phase 7/8 slices of 21/24. No ObjC product source was duplicated or relaxed.
One direct invocation of `integration-final-evidence.test.mjs` correctly
refused missing in-process producer evidence; it is not a corpus result.
The next allowed corpus check is the existing `current-corpus-group.mjs`,
which executes the real v2 and legacy producers in their canonical order.
Commit and exact-head reruns of this fixture-only reconciliation remain due.

### Settled exact-head results and next resume command

ObjC fixture reconciliation is committed at
`2a01b75d897cff5d39ae176c5d77e253dfc573ff`. On that exact clean head:

- canonical rebuild passed (2.9 s), zero generated diff;
- all touched ObjC/ownership tests and existing boundary regressions passed
  (0.5 s);
- canonical Phase 3 `current-corpus-group.mjs` passed (17.0 s), retaining all
  25 v2 commands and the same 25 legacy commands, differential/provenance and
  downstream report checks. This is not the full semantic-v2 required-gate
  chain or external release approval;
- full `node scripts/run-quiet-command.mjs --label check -- npm run check`
  terminated FAIL (119.9 s), log `/tmp/hex-check-0kK7Th/full.log`. It stopped
  in the MachineEffects invariant gate before later check-chain stages.

The seven failing files were `independent-oracle-report`, the two #6133 x87
tests, `x86-long64-closure-matrix`, `x86-long64-extended-state`,
`x86-long64-fp-denominator`, and `x86-long64-simd-denominator` (all `.test.mjs`).
The first was an environment failure: `/usr/bin/git` is 2.34.1 and rejects
`merge-tree --write-tree`. The already installed Git 2.49.1 produced candidate
tree `9ca91a1212e708d2e375829b83c1c1b9c5993865`; with that executable in PATH,
the unchanged independent-oracle-report test passed (11.0 s), including its
isolated clean-head refusal proof. The other six files are still unresolved.
The full check was NOT rerun under Git 2.49.1, so this does not turn its FAIL
into PASS. All processes named in this checkpoint are now terminal.

Use the existing toolchain for subsequent gates, without replacing system Git:

```sh
env PATH=/mnt/workspace/.local/hex-stage-a-toolchain/install/bin:$PATH node scripts/run-quiet-command.mjs --label check -- npm run check
```

Native x87 observations were also reproduced with Clang 18.1.3 at this head:
15/15 observed-hardware cases pass; the strict SDM reference retains the same
12 C1 discrepancies (`/tmp/hex-roadmap-x87-clang18-sdm-00pqLZ/full.log`).
Clang's wrapper exports its own libc path, so a host `/usr/bin/ld` or shell
wrapper cannot be used as its linker. Successful compile command:

```sh
clang-18 --ld-path=/mnt/workspace/.local/hex-stage-a-llvm18/root/usr/lib/llvm-18/bin-local/ld.lld -O2 -Wall -Wextra -Werror -mno-red-zone tools/validation/machine-effects/fixtures/x87-compare-flags-oracle.c -o /tmp/hex-roadmap-recovery.wWNZ2Z/x87-oracle-clang18
```

Clang binary SHA-256:
`f9061a768007886a9db0f5c1becc086068787bce12f21c93ea84c7d5b2aa5a7d`.
This corroborates the bounded GCC observations; it does not replace QEMU,
other CPU targets, exception/NaN coverage, or the all-profile release oracle.

Next: resolve the remaining x86 proof topology and semantic gaps through the
real receiver path without minting brands, dropping witnesses, or promoting
partial results to force the 1487-witness matrix green. Source-browser proof
currently covers 13 x87 encodings, not that complete matrix. Preserve the
23-finding scope and the existing integration PR. No remote write occurred.

### Full real-receiver survey and #7514 reuse (2026-09-09)

Previous goal turn: progress (committed runtime/fixture repairs and fresh
evidence). This turn measured all 1,487 canonical decoder witnesses through
the actual classic decoder Worker, dedicated receiver revalidation Worker,
and shared semantic pipeline on clean `8bec402e86a2dbf809bc69ee16adce537f1d8969`.
No private brand or Worker realm was fabricated. Both engines completed the
whole denominator, with no decode or receiver errors, and identical counts:

| Observed MachineEffects state | Chromium 140.0.7339.16 | WebKit 26.0 |
|---|---:|---:|
| exact | 139 | 139 |
| exact-with-intrinsic | 1207 | 1207 |
| partial | 141 | 141 |

This is a structural production-path survey, **not numerical/hardware semantic
equivalence**, and the survey exits FAIL / NOT-CLOSED (82.8 s). Of the 141
partials, 138 require dedicated extended-system semantics, one requires INT
delivery-state modeling, and two are UD0/UD1 operand-shape rejections. The
UD0/UD1 decoder witness bytes are `0fff`/`0fb9`; investigate their relationship
to the existing #6055 ModR/M-form proof, without silently changing the witness
denominator or admitting malformed operands.

Full log: `/tmp/hex-roadmap-all-x86-real-receiver-nL3Gcr/full.log`.
Artifacts: `/tmp/hex-x86-receiver-denominator-wMBx8L/{chromium,webkit}.json`.
SHA-256 respectively:
`efcc1075c90087102a0b94fe05b81c45e40dcee3a804f999a25d6d2c138f8aa6`,
`157290e559ad4736a044995a8c0b2058cd77db538f6c913d2a0d08a618c6a6f6`.
Diagnostic driver: `/tmp/hex-roadmap-recovery.wWNZ2Z/receiver-denominator-probe.mjs`.
It leaves unavailable outcomes explicit and does not replace the canonical
matrix or its currently failing release assertions.

Existing open PR #7514 was rechecked at
`8c2f7453cf835206d60eb335dbeb7fea0dbceb4b`. Its #5563 and #5569 fixes are
reused, retaining this branch's prior x87 flag-domain/comparison repairs.
The real receiver accepts `machineEffectsContext.closureMatrixTerminal:true`.
Before this repair, a seven-case browser probe with that option returned seven
`exact-with-intrinsic` bundles, including IRET/IRETD/IRETQ incorrectly classified
as traps and SAVEPREVSSP with unproven implicit memory. The survey's structural
success is therefore explicitly **not** correctness evidence. Those records
are in `/tmp/hex-x86-receiver-denominator-NwOGRJ/{chromium,webkit}.json`.

The reused fixes prevent IRET-group trap promotion and keep operandless system
partials conservative where the terminal helper has no proven memory surface.
They do not implement missing interrupt-return/CET semantics. The x86 semantic
version advances to `5.2.2-stage2-x86-denominator`. The PR's two original test
case sets are retained, but their fake WorkerGlobalScope/prototype/brand setup
is removed. Unit tests directly exercise the summary helper while separately
requiring public unbranded dispatch to stay partial. Real browser regressions
exercise all seven cases in both ordinary and closure-matrix contexts, retaining
SGDT's explicit 80-bit memory write as a positive control.

Before repair, both reused unit cases failed (0.3 s), log
`/tmp/hex-roadmap-7514-reused-before-qAq2aS/full.log`; the actual browser test
failed on IRET promotion (2.2 s), log
`/tmp/hex-roadmap-7514-real-browser-before-ZOJybA/full.log`.
After repair, changed-surface/ownership/provenance checks passed (2.3 s) and
source Chromium/WebKit proof passed (5.1 s). These are working-tree checks,
not exact-head evidence for a subsequently committed product.

### Browser-only pointer-refinement diagnostic crash

The stronger encrypted-userscript fixture analyzes MOV, FSQRT, IRETQ,
SAVEPREVSSP and RET together under the same real receiver. It exposed an earlier
failure: `canonicalMemoryPointerRegionEvidence` unconditionally accessed
`process.env.HEX_DEBUG_C2_POINTER`, but browser Workers have no Node `process`.
This diagnostic was introduced by `4ee37b74c` and is also present in existing
#7103's head; the current fix does not duplicate an already-fixed contribution.
The generated-runtime failure persisted after rebuilding the #7514-only fix:
`/tmp/hex-roadmap-7514-generated-browser-after-jHUDOJ/full.log`.

The diagnostic flag now requires an available Node process, explicit opt-in,
and a callable stderr sink. Producer-brand, access-table, SSA and region proofs
are unchanged; absent producer evidence remains unknown. A new canonical Phase
7 alias test covers absent/undefined/null/minimal process globals, missing
stderr and explicitly enabled diagnostics, requiring identical unknown-region
results. Its old-code failure is recorded in
`/tmp/hex-roadmap-region-browser-before-9BuKeD/full.log`. The focused alias and
ownership tests passed (0.5 s). Rebuild passed (3.0 s); the stronger encrypted
userscript test now passes in both browsers (7.8 s).

The actual union validates at 208 paths, Phase 7/8 slices 23/24. Canonical
generated serial is `2322242161`, build `3e845431ecf17b8684955245`, release
identity `2045d84d959c9556ba2b3d37eff33994cb81258dc7bb6b6e688ad0f67ca72f85`.
Commit, zero-diff rebuild, exact-head owned/browser checks and full affected
Phase 7 gate are next. The six old x86 release tests, 141 real-path partials,
and all 23 original findings remain unclosed. No PR push or merge occurred.

### Exact #7514/browser checkpoint settled

The repair is committed at `207e8b7dde8c48d9185061a106ca6ead4e2c8dc6`.
On that exact clean head, canonical rebuild passed (2.8 s), generated diff was
zero, all touched unit/ownership/provenance tests passed (2.4 s), source-browser
proof passed (5.1 s), encrypted generated-browser proof passed (7.7 s), and the
full canonical `npm run phase7:test` passed (58.6 s). Both browser engines are
required by those browser tests. These results do not close the full repository
gate, Phase 8/9 exact-head proof, or any of the original 23 findings.

The seven-system-case diagnostic was repeated with real Workers and the
closure-matrix option: both engines now report six partials and only SGDT as
exact-with-intrinsic, preserving its explicit memory surface. The diagnostic
correctly exits NOT-CLOSED; that is expected, not a new product regression.
Artifacts: `/tmp/hex-x86-receiver-denominator-vvzaDT/{chromium,webkit}.json`;
log: `/tmp/hex-roadmap-system-exact-survey-r7WCYb/full.log` (3.5 s).

The full receiver driver was strengthened to bind **every input byte** and the
decoded instruction code to the canonical witness before admitting a result.
It also records its own SHA-256. The new full run on exact `207e8b7dd` completed
all 1,487 witnesses in both engines (82.4 s), with zero byte/ID mismatches,
zero decode/receiver failures, and the same 139 exact / 1207 intrinsic / 141
partial counts. Status remains FAIL / NOT-CLOSED. This validates structural
transport, not the numerical or architectural equivalence of opaque intrinsics.
Driver SHA-256:
`a036992a953cc0e8158f182e7e497ef28a3e76bf037b90e83f8d8cef7b92f529`.
Artifacts: `/tmp/hex-x86-receiver-denominator-oppUGD/{chromium,webkit}.json`.
Artifact SHA-256 respectively:
`a5730cb2b965e550de750a21e0e06e05b1b49e365869b0e37326d13d141097fb`,
`cd27065fb3b2f1761d320091f742459893183a55af27da846834cc37410e5bb3`.
Log: `/tmp/hex-roadmap-all-x86-exact-receiver-FFjAFu/full.log`.

Additional decoder diagnosis: local deployed Capstone reports length 2 and zero
operands for all four byte strings `0fff`, `0fb9`, `0fffc0`, `0fb9c0`; simply
adding a ModR/M byte to the witness would not make this decoder consume it.
Do not blindly rewrite the corpus to force the #6055 synthetic operand proof
to pass. An official Intel Vol. 2B download was attempted but not successfully
retrieved in this turn, so no new ISA-specification claim rests on that search.

All test/diagnostic handles from this turn are terminal. Resume from this
local recovery repository; NFS writes remain unvalidated. Next substantive
work is real dedicated semantics and independent proof for the remaining
141 cases, plus reconciliation of the old Node-only x86 test topology without
weakening its denominator. The same integration PR remains authoritative; no
remote write, replacement PR, component merge, or release occurred.

### Durable recovery and dedicated LAHF/SAHF semantics (2026-09-09)

The execution environment was replaced after the LAHF/SAHF implementation turn.
Both previously live handles were absent and `/tmp/hex-roadmap-recovery.wWNZ2Z`
was gone. The persistent integration worktree remained clean at
`b64d71cf985f5c07daf6fb160544339e14d7a0d1`; the older repair snapshot and this
thread's session record survived. Do not report the lost local commits or
their temporary logs as currently inspectable artifacts.

The NFS quota condition was revalidated before editing: an isolated new file
in `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G` passed write, explicit
`fsync`, close and byte-exact readback. Source was recovered onto the existing
integration branch from the preserved repair diff and this thread's literal
`apply_patch` records. Historical commands, remote actions, reset redemptions
and failed patches were not replayed. The #7514 tests were recovered from
the same existing PR head with their recorded unbranded-unit adaptation.
The restored x87 C fixture has the previously recorded SHA-256
`f8d88a1f5095f6afa211a987dc1092fde8fe82acae3aa622c3394b31f734d571`.
The literal recovery recipe is also saved in that persistent recovery directory.

LAHF/SAHF now have dedicated bit-vector transfers, rather than opaque terminal
intrinsics. LAHF writes the canonical AH view and preserves AL/RAX[63:16] and
all flags; SAHF writes only CF/PF/AF/ZF/SF and preserves the other flags and
RAX. Their CPUID.80000001H:ECX[0] #UD condition stays explicit; host support is
not assumed. Malformed bytes, unproved prefix combinations and explicit
operands cannot emit definite transfers. All 16 single REX prefixes retain
implicit AH, including REX.B. No other extended-system family is promoted.
Existing PR search for `lahf sahf` returned no matching PR before this work.

The independent test interpreter executes only the emitted primitive subset
and has no mnemonic-specific execution or intrinsic fallback. Its bit-mask
reference covers 34 encodings / 104,448 input cases, and permanent mutation
negatives reject a wrong reserved bit and wrong AH source bit. Production
classic decoder -> dedicated receiver -> shared semantic pipeline is checked
in both browser engines, including whole-byte identity. The encrypted opaque
userscript fixture also includes LAHF and REX.B+SAHF.

`lahf-sahf-oracle.c` captures actual native RAX and RFLAGS before/after each
instruction. An explicit `HEX_X86_FLAG_ORACLE=<compiled-binary>` browser run
requires the complete 73,984-member native input set, rejects duplicates and
substitutions, and compares the real browser-produced bundles to those native
outputs. GCC and Clang are separate builds. This proves the measured normal
execution states on the identified host, not CPUID-disabled fault execution,
all CPU implementations, physical iPad behavior, or the complete ME oracle.

Sources: Intel SDM Vol. 2A, LAHF (253666-060US, p. 3-514), and Vol. 2B,
SAHF (pp. 4-580/581), fetched from Intel's official manual PDFs in this thread.
The native differential is required to corroborate, not replace, those rules.

Recovered semantic/cache versions are compat 1.2.0 and x86 5.2.3. The old
2322242161 release state was restored exactly from its recorded JSON before
canonical generation, so the new content advances the known serial rather
than reusing a lower serial from the older persistent checkout. Generated
files are rebuilt, not hand-merged.

Initial recovered unit/provenance/ownership checks passed except the frozen
LLVM viewer proof, which found the reset environment's LLVM 14. The surviving
verified LLVM 18.1.3 wrappers were re-exposed only at missing versioned paths;
the unchanged exact toolchain probe and viewer proof then passed. Chromium
source/generated runs passed; WebKit initially could not launch because
libxslt.so.1 was missing. The canonical Playwright WebKit dependency installer
completed. Both-engine, native, generated, exact-head and full-gate reruns are
still required below; no skip-green is inferred from environment recovery.

Live main was read as `cb1666bdef6a124984180caee5581b4a9a9e5c7a`; #7036 remains
OPEN/DRAFT at `8254ebe98bf6060bd902837d3751428a4fc15860`. No component merge,
replacement PR, remote push or cutover happened during recovery. The recorded
reconciliation base remains 058177e3b; fresh candidate-tree reconciliation is
required before final integration. All 23 finding acceptance obligations remain.

After dependency recovery, the full touched-test selection passed (1.7 s),
the source-browser/native GCC comparison passed in both engines (10.3 s),
and the encrypted generated-browser test passed in both engines (8.1 s).
These were dirty-tree diagnostics, not exact-head release proof. Generated
serial is 2322242162, build `305ac11ff4ca34bfa9dd3090`, release identity
`0e72145d2848805d6eb4d83a015081434047562370d34a24b67679ad7cf0981d`.

The source-browser verifier now supports an explicit
`HEX_X86_FLAG_ORACLE_REPORT=<new-persistent-path>`: it requires a clean exact
product, both engines and the full native input set, rechecks product/oracle
identity, and publishes a validated fsync-backed atomic report only on success.
It records product/verifier/evaluator/fixture/binary hashes, CPU/compiler/browser
identities and the unproven domains. Failed or interrupted runs do not publish a
final artifact. This makes new native evidence durable without treating old
logs or successful console chatter as recoverable proof.

### Exact recovery proof and canonical null-prefix gap (2026-09-09)

Recovered product `9662123bd83ebd6ed1fe57bf2b3fe10dc77c2ee8` passed the
generated rebuild/zero-diff check, touched tests, encrypted generated runtime,
and both Chromium/WebKit native comparisons. Durable reports are
`/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/native-gcc-9662123.json`
and `native-clang-9662123.json` in the same directory. Each compiler/engine
pair covers 73,984 normal-execution cases and 34 encodings, with the exact
product, verifier, evaluator, fixture, executable and observation identities.

The full unchanged `npm run check` on that head failed in six x86 test files:
`issue-6133-x87-terminal-family-authority`,
`issue-6133-x87-trusted-terminal-domain`, `x86-long64-closure-matrix`,
`x86-long64-extended-state`, `x86-long64-fp-denominator`, and
`x86-long64-simd-denominator` (all under `tests/machine-effects/`, `.test.mjs`).
The durable log is `hex-roadmap-966-check-fANUju/full.log` under the same
recovery directory. Later gates were not reached; the full gate is not green.

The clean-head actual receiver survey of all 1,487 canonical instructions
returned 139 exact, 1,207 exact-with-intrinsic, and 141 partial in both engines.
Reports are `hex-x86-receiver-denominator-v2ScEc/{chromium,webkit}.json` under
that directory. Counts are structural coverage, not independent value proof.
Crucially, its unchanged LAHF/SAHF witnesses are `269f`/`269e`: the initial
dedicated proof covered unprefixed and single-REX bytes but missed ES prefixes.
The next action follows this first divergence, not a replacement denominator.

The regression now requires both original witnesses to occur in the value-proof
inventory. It failed on the old product (`partial` versus `exact`) before the
repair. The repair admits a single CS/DS/ES/SS null prefix only for LAHF/SAHF;
multiple prefixes, FS/GS, size overrides, REP and LOCK still emit no definite
transfer. A separate negative prevents promoting unrelated system families.
Intel SDM Vol. 1 p. 3-10 and AMD APM Vol. 2 section 2.5.2 specify the null
segment behavior in 64-bit mode. Sources inspected:
[Intel SDM](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-1-manual.pdf),
[AMD APM, university mirror](https://users.cs.northwestern.edu/~pdinda/icsclass/doc/AMD_ARCH_MANUALS/Volume_2-System_Programming.pdf).
The live existing-PR search for `lahf sahf` returned no matches before repair.

The expanded proof has 42 encodings / 129,024 reference-value cases and
91,392 native observations per compiler/engine. Native and report schemas
advance to v2; v1 evidence does not satisfy this expanded acceptance matrix.
The encrypted generated fixture now also contains the canonical ES+LAHF form.
Semantic version advances to x86 5.2.4, generated serial 2322242163, build
`8410c2a7aca62c18ec8be0e7`. Initial unit and GCC/browser diagnostics passed;
clean-head native reports, rebuilt generated output and full-inventory reruns
remain required after committing this repair. No finding is marked complete.

### Null-prefix exact-head results and approved storage recovery (2026-09-09)

Product `2ff3d02869e4457d65be76a8ec25c3844e215a3c` now has the following
observed results; these are not blanket release or finding-closure claims:

- canonical userscript rebuild PASS (2.2 s), generated diff zero;
- native GCC/browser PASS (8.1 s), Clang/browser PASS (8.6 s), each engine
  covering all 91,392 input states and 42 encodings;
- encrypted generated Chromium/WebKit runtime PASS (4.2 s);
- full canonical Phase 7 tests PASS (68.6 s);
- full canonical Phase 8 tests PASS (481.5 s), including verifier self-tests;
- existing competitive twin/ground-truth tests PASS (1.5 s).

Native v2 reports are `native-gcc-2ff3d0286.json` and
`native-clang-2ff3d0286.json` in
`/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G`. They retain the exact
product/verifier/evaluator/fixture/binary/observation identities and unproven
domains. The 1,487-instruction receiver survey is
`hex-x86-receiver-denominator-5IAeCk/{chromium,webkit}.json` in that directory.
Both engines now report 141 exact, 1,207 exact-with-intrinsic and 139 partial;
the unchanged `269f`/`269e` witnesses are exact dedicated transfers. The survey
is still NOT-CLOSED: 136 extended-system families plus INT, UD0 and UD1 remain.
Structural exactness is not a substitute for architecture-wide value proof.

Full `npm run check` failed (65.8 s) in the six previously listed x86 files
and `independent-oracle-report.test.mjs`. Its preserved log is
`hex-roadmap-2ff3-check-YYeWZK/full.log` in the same recovery directory.
The additional failure was traced to persistent-storage EDQUOT while writing
Git objects, not silently classified as a semantic pass. A small explicit
fsync/readback probe also failed and read back zero bytes; source/checkpoint
editing was paused. The product worktree remained clean at the committed head.

The user explicitly approved relocating only already-extracted installer
archives. All 21 named LLVM `.deb` files and `git-v2.49.1.tar.gz` (22 files,
110,314,190 bytes) were copied with exclusive creation to
`/tmp/hex-roadmap-installer-backup.fdYZ1w`, fsynced, and SHA-256 verified before
any originals were unlinked. Every original was revalidated immediately before
removal; all backup hashes were rechecked afterwards. Source, installed tool
trees and proof artifacts were not removed. A complete durable manifest is
`/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/approved-installer-relocation-manifest.json`.
The manifest's `source`, `destination`, size and SHA-256 support restoration.
The backup itself is temporary and may disappear on environment replacement.

The first post-removal file sync still failed. Fresh probes subsequently
passed explicit fsync plus exact readback in both the product worktree and
durable evidence directory. The probe inside the product was then removed.
Git 2.49.1 and Clang 18.1.3 remained runnable. Normal persistent Git storage
successfully produced candidate tree `4d279a66501f8fde8c650c19588735b8774eada0`
for main `1f8884e3e14f02b346b0fe2dc3ea918ccc03e94d` and product `2ff3d0286`.
The unchanged independent-oracle-report test then passed (12.9 s) on the clean
product. This does not turn the preceding full seven-failure run green or
prove the candidate's runtime; it isolates and resolves the storage failure.

No remote push, replacement PR or component merge occurred. Next work remains
the six x86 gate failures, broader independent semantic evidence, current-main
reconciliation and all original 23 finding acceptance obligations. Historical
ledger COMPLETE labels are not fresh proof against this integration product.

## Real browser receiver regression checkpoint — 2026-09-09

Verified test/integration head:
`4a5094ebe4d7a1e5fbfdf2cac5401236179dcc93`, on the same persistent
worktree and existing PR #7036. Production semantics and generated content
are unchanged from `2ff3d02869e4457d65be76a8ec25c3844e215a3c`.

Four formerly failing canonical MachineEffects files now exercise the actual
classic decoder Worker followed by the dedicated semantic revalidation Worker
and shared production pipeline, on both Chromium 140.0.7339.16 and WebKit 26.0:

- `issue-6133-x87-terminal-family-authority.test.mjs`;
- `x86-long64-extended-state.test.mjs`;
- `x86-long64-fp-denominator.test.mjs`;
- `x86-long64-simd-denominator.test.mjs`.

The common test transport is `tests/machine-effects/helpers/x86-browser-effects.mjs`.
It checks response IDs, exact input bytes, addresses, instruction counts and
one effect bundle per instruction, and closes browser/Worker resources after
success or failure. It neither emulates WorkerGlobalScope nor mints private
decoder/receiver provenance. The FSQRT regression separately proves that the
structured-cloned decoder row remains partial with zero operations when lifted
directly in Node. FSAVE now checks both WAIT and FNSAVE, instead of silently
discarding the instruction after WAIT. Existing exactness assertions, all
68 FP / 125 SIMD forms, and synthetic malformed/untrusted negatives remain.
All seven changed paths are explicitly integration-owned; the full inventory
against `058177e3ba15511aae290495fa98e7129fda2583` is 217 paths, with unchanged
23-path Phase 7 and 24-path Phase 8 slices. The four ownership regressions pass.

Exact-head validation:

- Canonical generated build PASS (2.8 s), followed by clean Git status.
- First canonical `npm run check` FAIL (74.7 s), three files. The independent
  oracle report failure was caused by default Git 2.34.1 lacking
  `merge-tree --write-tree`, not by a new oracle divergence or storage error.
- Repeated the **whole unchanged canonical command** with installed Git 2.49.1
  explicitly on PATH: FAIL (111.4 s), now only
  `issue-6133-x87-trusted-terminal-domain.test.mjs` and
  `x86-long64-closure-matrix.test.mjs`. All four changed tests passed in this
  canonical run; independent-oracle-report passed too. The full command still
  stops at the MachineEffects invariant; later gates are not thereby proven.
- Full log:
  `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-4a5094-git249-check-TY8kYK/full.log`.
- LAHF/SAHF native v2 proof rerun on this clean exact head: GCC 11.4.0 PASS
  (16.3 s), Clang 18.1.3 PASS (16.4 s). Each compiler's actual observations were
  compared against 91,392 cases / 42 encodings in each browser. Reports:
  `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/native-gcc-4a5094ebe.json`
  and `native-clang-4a5094ebe.json` in the same directory. Their status remains
  `PASS_NORMAL_EXECUTION_ONLY`; CPUID-disabled faults, other CPUs, physical iPad
  and the complete MachineEffects denominator are not proven.
- Main ref observed `1f8884e3e14f02b346b0fe2dc3ea918ccc03e94d`; Git 2.49.1
  computes candidate tree `6ae3f8ace4acd1d68235d91b6fa39935ad679221`.
  This is merge computation, not candidate runtime proof or authorization to merge.

Resume commands MUST retain the installed Git toolchain, for example:

```sh
PATH=/mnt/workspace/.local/hex-stage-a-toolchain/install/bin:$PATH TMPDIR=/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G node scripts/run-quiet-command.mjs --label check -- npm run check
```

The remaining #6133 test was investigated through the real browser path too:
its x87/FCOMI/FCMOV cases reached their existing positive assertions, but RDRAND
`0fc7f0` is genuinely partial in both browsers, with
`x86-extended-system-family-requires-dedicated-semantics`. Its existing positive
requirement was NOT weakened or removed. The exploratory change to that file
was reverted before this commit; the failing test remains unchanged. Existing
PR search found #6910's already-reused x87 fix and no separate RDRAND successor
implementation. A dedicated semantic implementation/proof is still needed,
alongside routing the remaining integration positives through the real receiver.

The canonical 1487-witness closure test is unchanged and still blocking. The
prior actual-receiver diagnostic had 139 partial rows; this test-only checkpoint
does not remove any of those product gaps or claim a fresh full-denominator run.
No source PR was duplicated, no remote push/merge occurred, and none of the
23 original finding acceptance obligations is newly marked complete. Next work
remains the two blocking x86 tests and actual missing semantics, independent
semantic evidence, current-main reconciliation and the full completion audit.

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
