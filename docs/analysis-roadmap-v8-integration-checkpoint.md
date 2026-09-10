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

## Dedicated random-instruction checkpoint — 2026-09-09

Production implementation and generated output:
`6e91742ac82c8b2027a31ee07c25b23673552e70`.
Follow-up version/invalidation test synchronization:
`1a386fab870dc0863d452e672d7f34a0b7dba771`. The latter changes only
`phase2-integration.test.mjs` and `viewer-artifact-cancel.test.mjs`; it does not
change production code, native fixtures, the random verifier or generated output.
Evidence below remains bound to its stated head, not silently relabeled.

RDRAND and RDSEED now have dedicated operand/encoding validation and normal
register/flag transfers, instead of the extended-system catch-all partial.
The accepted byte matrix has 544 encodings: both families, all ModRM register
selectors, optional 66, and at most one final REX. REX.W overrides 66; 16-bit
writes preserve upper bits, 32-bit writes zero-extend, and REX.B selects R8–R15.
Conflicting widths/registers/access roles, missing operands, memory forms,
unexpected bytes and unproved prefix combinations emit no definite operations.
The original 1487-witness registry and its digest are unchanged.

The hardware result and CF are distinct nondeterministic intrinsic outputs.
CF is not inferred from whether the result is zero. OF/SF/ZF/AF/PF are cleared,
and other flags are preserved. RDSEED failure explicitly selects zero. The
vendor-neutral RDRAND intrinsic retains an implementation-dependent invalid
failure result: Intel documents zero, whereas AMD's cited RDRAND contract does
not guarantee it. No retry loop, host constant or entropy-quality claim is
invented. Feature absence is an explicit conditional #UD; normal transfers do
not constitute native fault-path proof.

Specification sources read for this change:

- Intel SDM Volume 2B, RDRAND/RDSEED, printed pp.4-541–4-544:
  https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf
- AMD-authored APM Volume 3, revision 3.35 (June 2023), printed pp.299–300,
  read from this mirror because the current AMD download endpoints failed:
  https://kib.kiev.ua/x86docs/AMD/AMD64/24594_APM_v3-r3.35.pdf
  This is explicitly revision-pinned evidence, not a claim to have read the
  unavailable revision 3.37. No secondary interpretation substitutes for it.

Semantic version is `5.2.5-stage2-x86-denominator`. Generated serial is
`2322242164`, build `ea8ba82cc47da991d409018a`, release identity
`015f3edce74d406f8b799ad1e751ff9ced9b47084c5275bff2d2d2b0116f43af`.
Generated rebuilds passed with zero diff on both heads (2.1 s and 2.7 s).
The existing x87 trusted-terminal-domain test now uses the real browser
receiver, retains all its positive/negative assertions including RDRAND,
and passes in Chromium 140.0.7339.16 and WebKit 26.0. The version fixture fix
also proves that artifacts from 5.2.4 cannot alias the new cache identity;
the four viewer/artifact/cancellation tests pass on `1a386fab8` (2.4 s).

New independent projection tests execute 156,672 cases across direct dedicated
lifting and both actual browser receivers. They cover zero-valued success,
failed generation, all accepted encodings, upper-register canaries and prior
flag patterns. Mutations of CF, zero extension and RDSEED failure selection are
rejected. This tests result projection, not the generator's distribution.

Native fixture `tools/validation/machine-effects/fixtures/random-oracle.c` was
compiled with GCC 11.4.0 and Clang 18.1.3 using
`-O2 -Wall -Wextra -Werror -mno-red-zone`. It checks CPUID first, executes the
real instructions, and captures registers/flags rather than reimplementing
the lifter. Both compiler binaries passed comparison on clean `6e91742ac`:

- GCC: 53.8 s; each browser compared 1536 observations / 12 encodings.
  RDRAND: 768 successes, no observed failures. RDSEED: 432 successes,
  336 failures.
- Clang: 52.8 s; each browser compared 1536 observations / 12 encodings.
  RDRAND: 768 successes, no observed failures. RDSEED: 448 successes,
  320 failures.
- Native CPU: GenuineIntel, signature 657105; leaf1 ECX 4277842447,
  leaf7 EBX 4055836651. Proofs include both browser versions and binary,
  observation, fixture, evaluator and verifier hashes.
- Atomically published, fsynced, non-overwriting reports:
  `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/random-native-gcc-6e91742ac.json`
  and `random-native-clang-6e91742ac.json` in the same directory.
  Status is `PASS_NORMAL_PROJECTION_ONLY`: comparisons condition on the
  hardware's nondeterministic returned value/CF. RDRAND native failure,
  entropy quality, other CPU implementations, feature-disabled faults,
  unobserved native encodings and physical iPad remain unproven.

Full real-receiver diagnostic on `6e91742ac` completed both browsers (47.6 s):
**141 exact / 1209 exact-with-intrinsic / 137 partial**, status `NOT-CLOSED`.
There are 134 extended-system gaps, INT delivery, UD0 shape and UD1 shape.
Reports are in
`/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-x86-receiver-denominator-detyFU/`.
A row-by-row comparison against the prior `5IAeCk` diagnostic proves that only
IDs 625 and 626 changed; the other 1485 rows are identical in both browsers.
The encrypted userscript browser regression also passed on `6e91742ac` (5.9 s).

Canonical `npm run check`, using installed Git 2.49.1:

- `6e91742ac`: FAIL (138.3 s), stale Phase 2 version pin plus the unchanged
  closure matrix. The new random test, #6133 and independent-oracle-report pass.
- `1a386fab8`: FAIL (111.5 s), **only**
  `x86-long64-closure-matrix.test.mjs`. The old six-file x86 failure set is
  reduced to this one, but the complete 1487-witness requirement is not waived.
  The command stops at the MachineEffects invariant; later full gates, including
  Phase 7/8/9 on this new product, are not proven by this run.
- Latest canonical log:
  `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-1a386-check-d9ikwd/full.log`.

Actual changed inventory remains explicitly owned: 221 paths against
`058177e3ba15511aae290495fa98e7129fda2583`, with 23/24 Phase 7/8 slices.
Ownership regressions pass. The shared main ref advanced concurrently to
`99d4cf84857ca01d7b72480b9156d1ee560fb49b`; candidate tree computed for that
main and `6e91742ac` is `59294ca7b22621f73c0359b36c5605abc4278016`.
It was not runtime-tested or merged. Source PR search still found only the
previously reused #6910 lineage for RDRAND/x87, not a separate implementation
to import. No duplicate PR, remote push or merge was performed.

Keep the integration checkpoint locked. Next work is the remaining canonical
closure test's actual receiver path and the 137 real semantic gaps, followed
by all remaining independent/candidate/runtime gates and the unchanged
23-finding completion audit. None of those findings is newly declared done,
and no Ghidra/IDA superiority claim follows from this checkpoint.

## 2026-09-09 real-receiver closure gate — unaccepted working checkpoint

The working tree above `fb8a1207e88791958552ec229d0d78a48a5ccddf` now exercises
all unchanged 1487 canonical witnesses through the existing production decoder
and semantic receiver in Chromium 140.0.7339.16 and WebKit 26.0. This is a
**dirty-tree diagnostic, not exact-head release evidence**. The modified
closure gate remains red; under EP-031 it is not ready for PR acceptance and
is left as uncommitted work. Integration remains checkpoint-locked.

The earlier working test stopped with 81 unowned rows because it mistook
`metadata.family` labels (`flags`, `bit-manipulation`, `foundation`) for
dispatcher ownership. The pre-existing decoder-denominator ownership contract
already documents that distinction. The corrected test uses the canonical
dispatcher only to obtain `ownerId`, discarding its unbranded Node effect
result. Actual completeness, operations, summaries and faults are taken only
from the real receiver. Identity/origin fields needed for the ownership call
come from its observed bundle. No private provenance is minted or transferred.

The matrix evaluator no longer supplies `closureMatrixTerminal:true`, and its
self-test rejects that override. Missing/invalid completeness cannot default
to exact merely because an owner exists. Register/flag operations and intrinsic
register/memory declarations now contribute to the structural summary;
memory counts denote declared effects/access entries, not bus transactions or
an independent proof of the full architectural footprint. These changes alter
acceptance/reporting semantics: affected old matrix evidence is invalidated
even though the structural schema remains v1. This is not a hardware oracle.

Verification on this working tree:

- New `x86-closure-matrix-summary.test.mjs`: PASS. Includes missing-evidence,
  ownership-label, hidden register/flag, memory-summary and override negatives.
  Replaying it against the committed old evaluator fails at the override
  assertion (`2 !== 1`), confirming an old-behavior regression.
- Both Phase 7/8 ownership regression files: 8 tests PASS. The actual union
  against frozen base `058177e3ba15511aae290495fa98e7129fda2583`, including
  uncommitted/untracked paths, is 224 files; Phase 7/8 slices remain 23/24.
- Canonical closure gate: FAIL after **both** browser scans, 40.7 s.
  Each engine reports 141 exact / 1209 exact-with-intrinsic / 137 partial /
  0 unowned. The unchanged zero-partial acceptance assertion fails at 137.
  Log: `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-real-closure-owner-identity-uiaZWe/full.log`.
  The browser helper's PASS messages attest transport/test callback completion,
  not semantic closure; the whole-command exit is 1.
- Full canonical `npm run check` with installed Git 2.49.1: FAIL, 113.2 s,
  only `x86-long64-closure-matrix.test.mjs` in the MachineEffects failure set.
  The new summary regression is discovered and passes in the canonical runner.
  Both browser scans again report the same 137 partial / 0 unowned result.
  Log: `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-closure-wip-check-vdQbQe/full.log`.
  The invariant chain stops here; later gates are not proven. This run does
  not satisfy EP-031 for the changed closure test and is not a green release.

Working verifier SHA-256:
`3e576d352b4178f66d52c7a7cd41f21b96442e959a85f8d404adfd143b123903`.
Working canonical test SHA-256:
`c1aa34a93c7b44f2f3fed408331721823304c0d356fba36310895d3af78acd53`.
Working summary self-test SHA-256:
`d372959eb0b6c483630aa237cf622000322b871d03cfdd1775f93ad866ace829`.

FSGSBASE remains unimplemented, not newly promoted. A dependency probe used
actual receiver effects for `488b00`, `64488b00` and `65488b00` in both browsers,
then the canonical `lowerMachineEffectBundleToSemanticIr` in Node. All six
observations had exact MachineEffects but partial IR with
`unsupported-machine-expression:x86-effective-address`. Source inspection of
`js/semantics/compat/index.js` confirms this same lowerer consumes bundles in
the shared pipeline. The TLS calculation additionally carries
`tls-segment-base-unknown`, with no explicit FS/GS base added. This establishes
a representation/precision dependency, not proof of an unsafe optimizer
rewrite. Do not implement FSGSBASE by promoting an opaque summary or inventing
a TLS memory mutation; first establish shared address/base dependencies and
their conservative lowering/invalidation behavior.

Fresh PR inspection found the same OPEN/DRAFT #7036 at remote head
`8254ebe98bf6060bd902837d3751428a4fc15860`; searches for `x86-effective-address`
and `FSGSBASE` returned no matching PR. No duplicate PR, push, merge, production
source change or generated-output change was performed at this checkpoint.
All 23 findings and competitive evidence remain required; none is newly done.
All test/probe processes started for this checkpoint have exited. Resume from
the six preserved dirty/untracked paths reported by Git, not by recreating
the browser gate. Next semantic work must address the canonical address
lowering/base-state dependency with actual receiver-to-IR regressions and
independent address projections, then continue the remaining 137 gaps and
the unchanged whole-roadmap completion audit.

## 2026-09-09 scalar-address IR integration — local WIP, not release acceptance

The x86 address producer now projects ordinary scalar effective addresses
using existing generic register/constant/add/shift/zero-extend expressions.
No x86 opcode or expression names were added to shared Semantic IR. Legacy
address descriptors remain diagnostic; the executable expression is the
generic projection. Address-size arithmetic wraps at 32 or 64 bits before
the 32-bit result is zero-extended. RIP/EIP-relative addressing uses the
actual decoded instruction length. LEA's existing materialized offset path
is unchanged.

FS/GS and VSIB are **not** newly promoted. An FS/GS offset alone is not a
linear address, and the prefix alone cannot prove separation from ordinary
memory. The next dependency includes explicit hidden bases, all base writers
(including segment-selector writes), and conservative alias/invalidation
behavior. The old unresolved wrappers remain for those cases until that
contract is implemented. The four FSGSBASE families and all 23 roadmap
findings remain in scope. Relevant primary architectural reference:
https://docs.kernel.org/arch/x86/x86_64/fsgs.html

Semantic/cache identity advances to `5.2.6-stage2-x86-denominator`. Existing
version fixtures are updated, with an explicit 5.2.5 artifact non-alias check.
Canonical generated build: serial `2322242165`, build ID
`62dab945407dbe8d21c98274`, release identity
`9afe50180bf1bf1adfb3777a7b0c5df51318aa28277e2991333ae67441bd6c55`.
An initial build passed (2.9 s); exact-head rebuild verification is still
required before accepting this checkpoint.

New `tests/machine-effects/x86-address-ir.test.mjs` uses 632 independently
constructed MOV load/store encodings and eight initial-register patterns
in each browser: **10,112 address projections**. Coverage includes all 16
base registers, legal SIB index registers, every scale, REX extensions,
address-size override, ignored legacy segments, signed displacement,
no-base forms and RIP/EIP wrapping. The test observes the actual receiver's
whole pre-SSA IR, not a Node re-lift. A decoded UD2 terminator closes the CFG;
it is not executed on the host and is not counted as an address fixture.
Three deliberately incorrect IR transformations (add/sub, scale direction,
sign/zero extension) are detected. Four FS/GS cases per browser stay partial.
The helper returns whole-function IR only when explicitly requested, without
changing receiver semantics or exposing a terminalization override.

Working-tree evidence before a local checkpoint commit:

- Address IR regression: PASS, 61.6 s, Chromium 140.0.7339.16 and WebKit 26.0.
  This proves scalar address projection only, not native instruction execution,
  fault behavior, physical iPad operation or complete MachineEffects semantics.
- Existing memory denominator: PASS, 13.1 s; unchanged **100,992 address +
  7,231 semantic + 16 moffs** cases. Its evaluator now reads the generic
  `fromBits` field while retaining the old wrapper's `fromWidthBits` form.
  No encoding, expected arithmetic value or denominator was removed.
- Old producer replay: the committed pre-fix address module loaded without
  editing the worktree still produces partial IR for `488b00`, rejected by
  the new complete-address requirement.
- Existing address unit tests: 20 PASS; segment-authority and Phase 2
  integration PASS. Ownership plus viewer/artifact tests: 12 PASS. Actual
  inventory is 227 paths with unchanged Phase 7/8 slices 23/24.
- `npm run semantic-v2:test`: 96 ordinary files and the current-corpus group
  PASS; userscript synchronization PASS (45.7 s). Core, migration, semantic,
  runtime, UI, platform, decompiler, compiler-truth and benchmark child commands
  PASS. The complete command is **FAIL**: required `effects:test` and
  `invariants:test` each report the closure matrix and independent-oracle-report.
  This invocation mistakenly inherited system Git 2.34; it is not accepted
  as the required toolchain run. Log:
  `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-address-semantic-v2-qB3sE6/full.log`.

To prevent another wrong-Git campaign invocation, use the durable local runner:
`bash /mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/run-roadmap-gate.sh LABEL COMMAND ...`.
It pins the already-installed Git/Node directories, asserts Git 2.49.1 and
Node v24.20.0, selects the
durable log directory, and invokes the unchanged whole-command quiet wrapper.
This is a campaign execution guard, not a replacement gate or repository-wide
toolchain policy. The original failing closure test remains a release blocker.

All work here is local WIP. No new PR, push, component acceptance or merge is
authorized by these results. Full exact-head gates, the 137 semantic gaps,
FS/GS shared-state work, native/browser/device proofs, reconciliation and the
complete 23-finding audit remain required. Competitive superiority is unproven.

### Exact local WIP checkpoint `5835cc929`

Local commit `5835cc9294016176061ffff2f22adb35795aa149` records the scalar
address implementation, generated outputs and previously uncommitted verifier
work. It is a local WIP commit, not the remote PR head and not EP-031/phase
acceptance of the still-failing closure test. The source worktree was clean
for the following runs:

- Canonical generated rebuild: PASS, 2.7 s; explicit diff over template,
  release-version and deployment-identity output was zero.
- `npm run check` through the pinned local runner: FAIL, 115.6 s. The new
  632-encoding address test passes in both engines (5056 projections each),
  and the closure matrix still reports 137 partial / 0 unowned. There are
  **two** failing MachineEffects files: `independent-oracle-report.test.mjs`
  and `x86-long64-closure-matrix.test.mjs`. Later invariant gates were not run.
  Log: `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-5835-check-UpSsHW/full.log`.
- Encrypted userscript browser regression: PASS, 5.5 s.
- Independent report isolated with Git 2.49.1: FAIL, 0.6 s. This is now a
  real moving-main reconciliation failure, not an unsupported Git option.
  Shared `origin/main` advanced from `99d4cf84857ca01d7b72480b9156d1ee560fb49b`
  to `4e869019d2d26592932bcf6f80d25132ebb982a5`. Git reports conflicts in
  `js/analysis/types/graph.js`, `userscript/hex.user.template.js` and
  `userscript/release-version.json`. The reported tree hash
  `2c0db2ffaf868a1bdd97b427e3d2a7346f86ddec` accompanies conflict stages; it is
  **not** a clean or verified candidate tree. Do not silence this gate by
  extracting its first output line or dropping the candidate requirement.
  Log: `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-5835-independent-report-dHaQM7/full.log`.

The local runner's toolchain guard was tested from a deliberately restricted
`PATH=/usr/bin:/bin`; it selected and asserted installed Git 2.49.1 and Node
v24.20.0 successfully. It does not resolve actual source conflicts.

All test processes started in this checkpoint have exited. Next action is
read-only review and in-place reconciliation with freshly resolved live main,
preserving both current-main pointer/field claim fixes and the roadmap's type
work. Regenerate outputs, never hand-merge their conflict text. Re-audit the
integration inventory against the explicitly recorded new reconciliation
base, then verify the actual resolved candidate. Do not create a replacement
PR. After reconciliation, continue FS/GS state/address dependencies, the
remaining semantic gaps and all 23 findings; none is newly declared complete.

## 2026-09-09 main reconciliation and opaque-input provenance — WIP

Reconciled the same local integration branch with fetched main
`4e869019d2d26592932bcf6f80d25132ebb982a5`. Local merge commit
`2216ced7a4af8d72d469eaea994b09f2e1ea697e` has resolved candidate tree
`18085c40244b9a2f1567f9062403cc86c05d4417`. Git 2.49.1 candidate merge-tree
verification against that base returned this tree without conflicts. PR #7036
remains the existing draft; no new PR, push, remote merge or component acceptance
was performed. The checkpoint remains locked.

The graph conflict was the already-imported upstream pointer/field repair
(#7495). The resolved graph is byte-identical to the pre-merge integration
version, retaining its recursive-type and safe-property work. Seven type
regression files passed, and all 41 test files changed between the former base
`058177e3ba15511aae290495fa98e7129fda2583` and the fetched main passed together
(4.5 s). Generated output was canonically built and rebuilt with zero diff:
serial `2322242166`, build `060e3fa62cb06d9b8b65b10c`, release identity
`0e39f3886d8ca075c2278c6bf398643de029e2bafac2eca255ce196f0b2419f3`.
This identity describes the local product, not an active deployed runtime.

Against the new explicitly recorded base, the exact committed inventory was
226 paths (Phase 7: 22; Phase 8: 24). The one removed delta is
`tests/phase7/types/issue-4503-structural-array-claims.test.mjs`, now identical
on main. It was not silently excluded from inventory validation.

### Settled clean-head `2216ced7a` evidence

- `npm run check`: FAIL, 130.3 s, at the MachineEffects closure matrix only:
  both actual browser receivers report 141 exact / 1209 exact-with-intrinsic /
  137 partial / 0 unowned. Subsequent invariant gates were not reached.
  The new scalar-address regression passed within this run.
  Log: `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-2216-check-uESGIb/full.log`.
- Full `npm run phase7:test`: PASS, 59.1 s.
- Independent oracle report self-test: PASS, 59.7 s. This proves the report and
  candidate-head verification path, not completion of all ISA semantics.
- Full `npm run phase9:test`: PASS, 26.5 s.
- Full `npm run phase8:test`: FAIL, 543.6 s. The unchanged frozen provenance
  comparator found three cases: `gvn_call_barrier.O1`, `gvn_call_barrier.O2`
  and `structure_switch.O0`, all x86-64. Separately, finalizer test setup failed
  copying Capstone into the persistent temporary directory with errno -122.
  Log: `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-2216-p8-s2SPs2/full.log`.
- Encrypted userscript browser test initially failed launching Chromium with
  its profile in the quota-limited directory. The identical test with only
  child `TMPDIR=/tmp` passed in both engines (4.4 s). Source stayed in this
  worktree. No test semantics, browser denominator or timeout was weakened.

### First-divergence repair in the working tree

The indirect-switch case loses the MOVSXD target-load address `0x940023` at
opaque statement emission: the compatibility IR retains the target argument,
but `semantic-core.js` printed UNKNOWN with only the statement's own source.
The repair reuses the existing bounded SSA dependency traversal for explicit
UNKNOWN arguments. It does not decode assembly, infer indirect destinations,
promote unknown semantics or attach arbitrary nearby instructions as evidence.

Checked existing PR #3421 at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`:
its bidirectional ledger and residual-goto changes do not repair this opaque
argument boundary. That larger implementation is still to be reused, not
recreated. This repair does not claim to integrate or complete #3421.

New `tests/phase8/provenance/unknown-input-source.test.mjs` has a generic
SSA regression and the frozen real-x86 case through interactive and optimized
decompiler/printer paths. Both fail on the unchanged production code and pass
after the repair (1.8 s). It checks input origins/IR IDs, duplicate suppression,
unrelated-definition exclusion, and preservation of the unresolved statement.
These are Node product-path tests, not physical-device evidence.

Both ownership regressions, frozen provenance verifier tests, typed-origin
tests and the finalizer transaction tests passed together (0.7 s), with child
temporary storage on `/tmp`. The complete no-op-equivalence test was rerun
unchanged: still FAIL (90.9 s), now only the two call-barrier cases. The switch
case is repaired, but the comparator was not weakened. Remaining MOV RBX,RDI
origins are `0x770003` and `0x780003`; the ABI-neutral call's canonical unknown
state definition breaks the later RBX value chain. Do not assume call
preservation or invent source dependencies merely to make this comparator green.
Log: `/mnt/workspace/hex-roadmap-recovery-durable.UWZe3G/hex-roadmap-provenance-after-F6N5Hm/full.log`.

The two new paths (semantic core and its regression) are explicitly assigned
to Phase 8 in the roadmap inventory. The manifest reconciliation base now
records `4e869019d2d26592932bcf6f80d25132ebb982a5`.

### Storage and resume boundary

The subsequent canonical build FAILED with quota errno -122 while closing an
output file, after advancing the tentative release record to serial 2322242167,
build `7a228b00c8547ab13ecfc6d4`, identity
`6c3d154ef89f2aab8652e2f23437403b324702c5395744eeda7e860e291341e3`.
These are NOT accepted generated-output proof. Git also reported an index-lock
close error. No stale index lock remained; live goal DB integrity still returned
`ok`. Do not restore the earlier goal DB backup over resumed accounting.

Only the failed build's regenerable, untracked `dist` and `.runtime-build`
directories were relocated to `/tmp/hex-roadmap-failed-build-wcAqHN/` to free
approximately 13.5 MiB. They are recoverable there but are an incomplete build,
not release evidence. No source, Git history, other worktree, user cache or
evidence report was deleted or moved. Source and this checkpoint remain durable.

Before acceptance: restore reliable persistent write capacity, complete the
canonical generated build/rebuild transaction, then run exact-head gates.
Resume from Git state rather than assuming the tentative build succeeded.
All test handles cited above are terminal. The 137 MachineEffects gaps, FS/GS
base writers/invalidation, the two provenance cases, #3421 integration, all
23 findings and the required real-browser/device/release proofs remain scope.
No finding or competitive-superiority claim is newly marked complete.

### Storage recovery and durable-publication regression (supersedes the pause above)

A later small-file write/fsync/readback succeeded. The two zero-byte generated
files were restored through verified sibling files, fsynced and atomically
renamed from exact `2216ced7a` Git content. No goal DB rollback was performed.
The previously failed build and this campaign's 529 KiB Node compile cache
remain recoverable under `/tmp/hex-roadmap-failed-build-wcAqHN/`; only regenerable
campaign outputs were moved. Four pending source files were separately copied
and byte-verified there; authoritative source was never moved out of this repo.

The repeated EDQUOT/truncation failure now has a repository regression:
`scripts/userscript-publication.mjs` stages each generated file with exclusive
creation, checks write/fsync/close and reads the bytes back before replacement.
The canonical builder publishes its committed loader/release pair only after
all dist writes finish. The pair uses an exclusive publication lock and
hard-link backups so a caught late failure can restore old content without
another data write. If rollback fails, recovery backups and the lock remain and
another publisher fails closed. This is error-rollback publication, NOT a claim
of crash-atomic replacement of two filesystem names. A killed publisher's
recovery state requires inspection.

`tests/userscript-publication.mjs` is imported by the existing canonical
`tests/userscript-release-version.mjs`. It injects partial write, sync, close,
false-success short-write, readback, second-rename, directory-sync and rollback
failures, plus stale expected content. It verifies old bytes remain unchanged
on handled failure, recovery state survives failed rollback, successful output
is exact and normal cleanup finishes. The old committed builder fails the
new wiring requirements (early serial write/direct loader truncation).
Both unit fault regressions and the canonical release-version test passed.

Actual NFS EDQUOT recurred during the first protected builder invocation,
this time at staging fsync. The builder failed and all three existing committed
generated files remained byte-identical to HEAD, including deployment identity.
Thus the real storage error no longer truncated them. An ordinary apply_patch
edit to the ownership validator separately hit the same quota and became empty;
it was recovered via a verified, fsynced sibling before continuing. Never treat
a tool's empty success response as proof of persisted source bytes.

After that recovery, the canonical build passed (2.2 s), generated files were
staged, and a second canonical build passed (2.6 s) with zero unstaged generated
diff. Settled identity: serial `2322242167`, build
`7a228b00c8547ab13ecfc6d4`, release identity
`128ee9e66622ba35e70c707ea5ba13d2dc9e879d8fdc3f876b87121904301053`.
The publication helper is explicitly included in release identity inputs.
This supersedes the earlier failed tentative release identity.

Both ownership regressions and the opaque-input product regressions passed
together (2.2 s). Actual working inventory is 232 paths (Phase 7: 22; Phase 8:
26), including four exact integration paths for builder/publication/tests.
Canonical release-version regressions passed again after building (0.8 s).
Encrypted userscript tests in Chromium and WebKit passed after the rebuild
settled (4.6 s). An earlier browser invocation overlapped the rebuild and failed
on missing runtime-secrets; that was invalid orchestration, not product proof.
Do not run consumers of dist/.runtime-build concurrently with their builder.

These are pre-commit results. Exact-head gates still need to run after the WIP
commit. The checkpoint stays locked: the two call-barrier provenance cases,
137 MachineEffects gaps, full 23-finding audit, #3421 reuse and all required
independent/device/release evidence remain outstanding.

The verified untracked runtime outputs were then relocated to
`/tmp/hex-roadmap-verified-runtime-StrdvO/`, with symlinks preserving the original
`dist` and `.runtime-build` lookup paths. Runtime-secrets and public-manifest
SHA-256 values were unchanged across relocation. Source, committed loader,
release identity and Git history stayed in the durable worktree. The builder
may replace these symlinks on its next run; it still requires persistent space.

### Persistent-storage resume, 2026-09-09

User resolved capacity and directed this lane to finish the analysis-roadmap
TODOs; unrelated issue/performance work belongs to parallel workers. New command
TMPDIR/TMP/TEMP all use `/mnt/workspace/.dev-state/agent-work/scratch`.
Command receipts and failed logs now live under
`/mnt/workspace/.dev-state/agent-work/evidence/analysis-roadmap-20260909/`.
The canonical builder replaced the former temporary-target output symlinks with
real persistent generated files. Build passed (5.2 s), existing generated index
diff remained zero, ownership plus opaque-input regressions passed (6.9 s), and
canonical userscript release regressions passed (4.5 s). Old temporary receipts
are historical references only and must not be assumed to survive.

PR #3421 remains open at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`;
reuse its C4-03 implementation rather than create a competing implementation.
The original goal was resumed through the supported Codex app-server
`thread/goal/set` operation (status only); `get_goal` confirms `active`.
The objective and accounting were retained, not recreated or restored from an
old database. No completion is claimed.

### C4-03 existing-PR reuse candidate, 2026-09-09

Parent WIP `3940aa6a7b82da5116cb8ad82b90686c99962ba3` is backed up to the
existing #7036 branch. The C4-03 source candidate reuses all 18 changed paths
from #3421 at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`, including its
bidirectional render map, transform ledger, safety counters and regressions.
Git's intermediate merge tree `e7d7c0c9431ea2f4735e3f847bb5d10d49010914`
contained two projection conflicts; it is NOT a resolved or accepted tree.
Current query-local proof authority and cancellation checks were retained;
solver-constant records now supply the PR ledger's proof and target fields.
Publication checks run again after render-map construction.

Integration also connects the current legacy shared-cleanup goto path to the
actual predecessor terminator and destination instruction origins. Missing
instructions refuse that structuring path instead of inventing provenance.
The existing PR regression now asserts both exact addresses and excludes an
unrelated address. Its address-only ledger fixture was corrected to expect the
public decimal-string canonical form already produced by the PR itself.
No semantic authority, ABI assumption, corpus denominator or timeout was added.

Actual inventory against frozen reconciliation base
`4e869019d2d26592932bcf6f80d25132ebb982a5`: 246 paths, Phase 7: 22,
Phase 8: 39. The complete tracked/untracked union passes ownership validation;
the legacy bridge has an exact integration-owned path, not a blanket exception.

Persistent evidence root for the following receipts:
`/mnt/workspace/.dev-state/agent-work/evidence/analysis-roadmap-20260909/`.

- Focused provenance and CFG: PASS (5.5 s), receipt
  `c4-03-provenance-final-439d8e15-1163-4f90-9b99-1e8b1139e4c0.json`.
- Combined provenance/ownership/v8 proof regressions: 85/86 passed; first
  optimizer case exceeded its existing deadline. Isolated optimizer: 8/9.
  Clean parent comparison: 7/9, including the same deadline plus the machine
  optimizer-withheld case. This comparison is not a green optimizer gate.
- Full candidate frozen corpus: 12/14 passed (334.0 s), receipt
  `c4-03-corpus-9a6cfb9a-78ce-40b5-8867-6a5157f5fc61.json`.
  The added render-map check passed across all 135 functions. The only two
  failures are `x86_64.quality.gvn_call_barrier.O1` and `.O2`, each retaining
  9 of the 10 required addresses. The clean parent corpus had the same two
  failures (11/13 passed). The changed corpus suite is still RED: EP-031
  acceptance is not established by baseline equivalence.
- Canonical generation PASS (5.9 s), subsequent rebuild PASS (6.1 s), zero
  generated diff against the staged generated pair. Serial `2322242168`,
  build `65215f8ee81b271cd91940b1`, release identity
  `67e1ead8cf2f3a688a6137a309f1041eeeba35ec67887a51daf06188d8fed8df`.
  Deployment identity is null; no deployed/live-runtime claim follows.
- Encrypted-runtime Chromium/WebKit sandbox browser test after rebuilding:
  PASS (24.9 s), receipt
  `c4-03-browser-82ed40aa-290e-4600-83a5-98a47d6dd33f.json`.

These are working-candidate results, not clean-commit release evidence.
The checkpoint remains locked; #3421 and #7036 are not merged or accepted.
All 23 findings remain in scope, including raw/deleted-entity and UI/query
navigation proof not established by render-map construction alone.

### Other relevant PRs are reuse inputs, not duplicate implementation work

`pr-reuse-inventory.json` in the evidence root records 32 relevant open PRs,
their observed heads and mappings to 15 roadmap findings (observed
2026-09-09T08:46:10Z). Revalidate their live heads before acceptance.
Important groups include MemorySSA/points-to (#7502, #7504, #7551), type/ABI
(#7635, #7636, #7512, #7518), metadata (#7674, #7540, #7672), rebuild
(#7513, #7527), runtime identity (#7675, #7526), and recognition
(#7507, #7543, #7579). This inventory is relevance evidence, not completed work.
Parallel issue/performance owners keep their implementation scope.

Next C4-04 reuse input is #3422 at
`ca25c71f1a6f18f0ba043800fb066f8068f2df73`. Its owned-snapshot/pass-validation
facade must be reconciled with, not substituted for, the newer query-local
proof-capability registry in this branch. No next component acceptance is
authorized while this checkpoint remains locked.

### C4-03 canonical product navigation — TODO implementation, 2026-09-09

The active goal is now explicitly: finish the analysis-MD TODOs first; physical
device checks, environment limitations and issue fixes are handled elsewhere.
This lane does not claim release/device acceptance by skipping those external
checks. It prioritizes missing roadmap mechanisms and focused regressions.
The user also reports decompiler performance improvements on latest main and
a forthcoming second one-file improvement; preserve those at the next main
reconciliation instead of duplicating performance work here.

The previous full Phase 8 run on clean `89af94801865abc0d85640ae048aa68d822c6a51`
was explicitly interrupted in its final verifier remeasurement after 1788 s
to prioritize the newly scoped TODO work. Its runner and child were confirmed
terminal before any product edit. Receipt
`c4-03-exact-phase8-10d3e92c-dfa1-4566-bd28-453a96fd0e47.json` records exit 1;
the retained log reports the two known call-barrier corpus failures. This is
an INTERRUPTED, incomplete broad gate, not a full result or acceptance proof.
It is not restarted in this TODO turn.

New `js/ui/decompiler-provenance.js` consumes #3421's existing immutable
`renderProvenance.entities` and `.reverse` through the production
AnalysisQueryAPI result. `js/ui/product-base.js` now mounts it in the canonical
pseudocode tab. It adds:

- rendered line to original instruction addresses, including direct assembly
  navigation through the existing router;
- instruction-address lookup to all mapped rendered lines, with visible
  selection and keyboard activation;
- the same logical line text for viewing/copying, including wrapping;
- exact BigInt addresses, without truncating high bits;
- explicit unavailable/no-match states, paged address details retaining access
  to every origin, and
  no navigation from incomplete maps;
- fresh outer query-snapshot checks before selection and navigation, separate
  from the inner canonical IR snapshot; cancellation/disposal are rechecked
  after asynchronous reads;
- selection ordering so old async requests or pending clicks cannot override
  a newer visible selection.

The new 12-test navigation regression uses the real Phase 8 projection and
AnalysisQueryAPI, plus a small DOM model for view interactions. It also pins
production-route wiring. This is local contract/UI-handler evidence, not a
real-device/browser claim. The final canonical provenance group passed (26.8 s),
receipt `c4-03-navigation-settled-owned-b02edec1-6922-4b38-a7ed-b097ca5cd2e1.json`.
Both roadmap ownership regression files passed with the navigation tests.
The complete actual inventory is 250 paths (Phase 7: 22; Phase 8: 40), with
three exact integration-owned UI/CSS paths and no blanket ownership widening.

A scratch prototype initially asserted a unique SSA origin despite deliberately
sharing the collapse instruction with the condition. The one-line lookup now
uses the return node's distinct SSA origin; the multiple-line instruction
lookup retains its exact two-line assertion. No production map was changed to
fit the fixture. A later successful prototype run encountered an ENOTEMPTY
error in quiet-log cleanup; no environment repair was attempted. Direct Node
execution then verified all nine prototype tests; the authoritative 12-test
suite additionally covers production wiring, all address pages, and unmapped
legacy query text. Navigation plus both ownership files also passed directly
with 20 tests and no failures.

Final canonical generation passed (5.4 s), and the second rebuild passed
(7.4 s) with zero generated diff. Settled serial `2322242171`, build
`29fee2c7852f10bff969f69a`, release identity
`30a4aa9461e6989e61e7611e9bcea0d406427f88f4950d31b9d94bd076e6c41b`.
Receipts: `c4-03-navigation-settled-build-36df48f2-9a3d-46e1-9122-28175344b2e9.json`
and `c4-03-navigation-settled-rebuild-706d3510-3c24-455d-ab17-18be0f3edefa.json`.
No physical-device check or unrelated issue/performance fix was added.
Remaining C4-03 work includes complete raw/deleted-entity transform histories
and the separate legacy sheet's reverse-navigation surface. The two frozen
call-barrier losses remain unclosed. This is further work on the same C4-03
candidate, not acceptance of a next component or completion of all findings.

### C4-03 legacy navigation access — TODO implementation, 2026-09-09

The separate legacy decompiler now opens `js/ui/decompiler-provenance-sheet.js`
from its “命令との双方向対応” control. This sheet consumes the same
AnalysisQueryAPI envelope and shared provenance view as the product tab;
it does not implement another reverse index, decompiler, or router.
Existing assembly, annotation, copy and diagram controls remain intact.
The child sheet preserves full-width address navigation through the existing
`app.goToAddress` route and has its own copy/wrap controls.

The sheet checks closure, API identity, backend/generation and slice identity
after each asynchronous query. Closing it makes pending publication and
navigation ineligible, including the period before deferred Sheet destruction.
Missing query support and absent pseudocode are explicit unavailable states.
The 16 navigation tests passed, including four new legacy-sheet regressions
using the real query/projection with a local DOM/Sheet model. Both ownership
files passed (8 tests). Complete actual tracked/untracked inventory passes:
252 paths, Phase 7: 22, Phase 8: 40. Only the two exact integration-owned
legacy UI paths were added to ownership.

Canonical provenance group PASS (15.3 s), receipt
`c4-03-legacy-owned-3ba3b0c0-fe82-43e8-9a9c-0c5bf7aa5890.json`.
Canonical generation PASS (5.2 s), receipt
`c4-03-legacy-build-7a3d9bb2-f465-456f-ba53-9d191eeedc97.json`:
serial `2322242172`, build `fc4c2300b247a4061946f647`, release identity
`ef9182e30fa492a0d25a2fa8a9681c40a089996b0a93944c8e260d2919475e6f`.
Exact-head and second-rebuild evidence is recorded in the durable resume
checkpoint after commit. Deployment identity is not claimed.

This closes the previously missing legacy navigation access, not the whole
C4-03 finding. Complete raw/deleted/merged entity transform histories and the
full class denominator remain open. No device/browser, environment, performance
or unrelated issue work was added. No new component was accepted and the
integration acceptance lock remains in force. Main has not been reconciled in
this step; the user's performance changes must be preserved at reconciliation.

### C4-03 actual expression history — TODO implementation, 2026-09-09

Live #3421 remains OPEN at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`.
Its already-reused render mapper does not capture the earlier RewriteEngine
source transitions. This step extends that existing producer and mapper, not
another rewrite engine, AST identity, solver or cache.

Every accepted RewriteEngine application now snapshots its before/after
canonical source arrays alongside the existing rule, phase, structural keys
and proof kind. Snapshots are immutable, do not retain recursive evidence,
and do not change the resulting expression object or its source IDs. This is
important for source-derived load identities: merging an eliminated operator's
IDs into a surviving load would not be mere bookkeeping. Rejected/no-op/cancelled
applications produce no new history. Retained source arrays have a separate
512-origin default cap per side; truncation is carried into the public map.
The existing rewrite rules, time/work limits and semantic admission are unchanged.

The existing `renderProvenance.ledger` includes these chronological expression
records before the final Phase 8 view records, sharing the same record budget.
Their nested `originHistory` distinguishes consumed, produced and elided
canonical origin references. Its explicit scope is
`replacement-expression-source`: these are not deleted canonical IR entities.
A truncated snapshot never certifies an absent origin as elided. Historical
proofs with missing snapshots remain explicitly unavailable. `transformReverse`
indexes origins to this same ledger, separately from the existing line index.

The shared product/legacy UI can display these histories from an instruction
lookup, including all origin references and paged record lists. A history with
no established rendered consumer says so explicitly; it does not select a
nearby/shared-input line or authorize an assembly callback. History lookup and
paging use the existing fresh-query snapshot and disposal checks. Code copying
still copies only pseudocode. Public history addresses are decimal strings.

Focused evidence on the settled source:

- 12 expression-history regressions (actual engine, snapshots, query, omission,
  chronology, limits, cancellation and malformed history);
- 18 navigation/UI-handler regressions, including history display/paging;
- both roadmap ownership suites, 8 tests;
- canonical provenance group PASS 13.1 s, receipt
  `c4-03-expression-settled-owned-4b276ca2-d949-46d7-a678-b60cd56fcb6d.json`;
- existing semantic pipeline PASS 0.7 s, receipt
  `c4-03-expression-pipeline-cea2ff4a-020f-446c-acc6-1a15c734d5b2.json`;
- existing rewrite semantic properties PASS 0.2 s, receipt
  `c4-03-expression-settled-rewrite-6ffd9c10-b497-4ea4-be2a-c53c6f510828.json`;
- existing pass-manager/rewrite-budget regressions PASS, 7 tests;
- full actual inventory: 254 paths, Phase 7: 22, Phase 8: 42.

Canonical generation PASS 3.6 s, receipt
`c4-03-expression-settled-build-e8f62f95-bf06-4d60-bf14-76de91fd3ef2.json`.
Settled serial `2322242174`, build `36d45bf11b49224245a2d096`, release identity
`d99291604f2cd7345b06e3f64be2d4c92c30ca3e0c050943ced974375c33c875`.
Second-rebuild and exact-commit evidence follow in the durable resume checkpoint.

Not done: this records actual expression-source elimination, not complete
raw/optimized/rendered entity correspondence. These expression histories have
`renderedBinding: unresolved`; exact consumer binding and the full
CSE/DCE/phi/switch/struct-field removal/merge denominator remain TODOs. Existing
view-collapse line navigation remains available, but is not used as proof of
the unresolved history bindings. C4-04 and the rest of the original findings
remain open. No component acceptance/merge, full gate, browser/device/runtime
claim, main reconciliation, or unrelated issue/performance work occurred.

### C4-03 observed expression consumers — TODO implementation, 2026-09-09

The preceding history step intentionally left rendered bindings unresolved.
This step connects actual store, return and direct-value branch consumers from
the existing semantic producer to the existing final projection. A live PR
search again found #3421 at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928` and
#3422 at `ca25c71f1a6f18f0ba043800fb066f8068f2df73`; their reuse status is
unchanged. No competing implementation or new component merge was created.

`pipeline-core.js` retains the exact records for each produced value and issues
private consumer bindings only while constructing statements that actually use
that value. Store/return roots are identity-checked. The cbz/cbnz/tbz/tbnz
condition producers additionally check their actual nested expression object;
flag reconstruction does not borrow that edge. Existing bounded live-object
observation checks the expression, records, canonical value and instruction.
The original expression/source IDs, including source-derived load identities,
are not changed. Copied public descriptors or record payloads do not acquire
these private bindings.

The final projection captures valid consumers before its owned transformations
and observes the lines it actually emits. A condition is linked only after a
successful condition replacement; already-identical output is supported, while
malformed/ambiguous replacement remains unbound. The shared render mapper
matches those exact record objects, unions the consumed origins into the
rendered entity, and records `renderedBinding: producer-bound`. A different
statement reading the same input is not linked. Late mutation invalidates
the resulting map; copied or edited lines cannot replay the binding. The
validator checks the record/entity back-reference. Existing query-snapshot,
truncation and cancellation boundaries remain in force.

The shared UI now distinguishes observed consumers from unresolved histories.
Instruction lookup selects the actual consumer lines, shows their transform
history and enables the existing instruction navigation. Copy text remains
unchanged. The producer's cumulative observation work is bounded per function
(at most 4096 consumers and the existing projection edge allowance); lower
`renderProvenanceBindingBudget` caps leave later bindings unresolved without
changing decompilation. Failed observation is not retried for every later line.

Focused evidence:

- 13 real-producer consumer regressions, including shared-input negatives,
  unchanged load identity, store/return/branch consumers, query navigation,
  mutation/copy refusal, late mutation, malformed/ambiguous conditions and caps;
- 19 shared navigation/UI-handler tests and 12 expression-history tests;
- both roadmap ownership suites (8) and existing budget regressions (7);
- canonical provenance PASS 13.4 s, receipt
  `c4-03-consumer-settled-owned-b26d6137-ac63-4689-b722-fcaaf29045b2.json`;
- settled semantic pipeline PASS 0.6 s, receipt
  `c4-03-consumer-settled-pipeline-b2943bac-3b08-4870-a0c9-5628f7aeaf44.json`;
- unchanged rewrite semantic properties PASS 0.2 s, receipt
  `c4-03-consumer-rewrite-217603d7-ce0f-4cde-8ba1-19575cd780d8.json`;
- full actual inventory: 256 paths, Phase 7: 22, Phase 8: 44.

An initial test assigned the exact same surviving input object while expecting
replacement invalidation. The negative fixture now actually replaces the
expression object; the positive shared-input case still requires no cross-link.
An initial missing-entry guard failed two existing standalone-map tests and was
corrected before the settled canonical run. No tests were waived or excluded.

Canonical generation PASS 3.6 s, receipt
`c4-03-consumer-build-e051fd2e-8643-4a6c-9392-c151117ab289.json`:
serial `2322242175`, build `b2b5dd6a6c92363e070e960c`, release identity
`a3e588dea7e306aff60e35cd0b5cf9ef33ce8497586505d3385d52cead9dc6e5`.
Exact-head and zero-diff second-rebuild receipts follow in the durable resume
checkpoint. This is Node contract/UI-handler evidence, not browser/device proof.

C4-03 remains open. Remaining work includes retention across successive owned
projections, consumers replaced by later recovery passes, and the complete
CSE/DCE/phi/switch/struct-field removed/merged-entity denominator. An unobserved
replacement is still unresolved, not reattached by expression text or a shared
origin. No other original finding is declared complete. Main reconciliation,
full integration acceptance, device/runtime proof and unrelated issue/performance
work were not performed; the existing acceptance lock remains in force.

### C4-03 observation-cap publication — same TODO step, 2026-09-09

The initial consumer implementation was committed as
`e026b2f11c8cc9e53f968fb669b795d1ae5f3ac8`, tree
`0ec9a0bff6e93c81f9bd0361c2b117901a196b3e`; all 59 focused tests passed on that
head, receipt `c4-03-consumer-exact-719dc0b6-26c4-4284-bc34-9599b71ae9e5.json`.
Its second generation was clean, receipt
`c4-03-consumer-rebuild-eb68674f-2d65-4ce5-8dcb-df4160604fe4.json`.

Final inspection identified a completeness gap in the new observation cap:
when one consumer was bound and a later consumer hit the cap, the bound record
alone could hide the missing observation. The same producer now publishes an
immutable `expressionHistoryBinding` disposition scoped to consumer observations.
Budget exhaustion or unavailable observation marks the public map incomplete,
including when some observed edges remain present. Pseudocode is unchanged;
incomplete navigation follows the existing unavailable path. The cap regression
now asserts this disposition and the map's incomplete reason, not just the
retained edge count. This is a correction to this TODO implementation, not an
unrelated issue repair or a weakening of the denominator.

Settled canonical provenance PASS 32.2 s, receipt
`c4-03-consumer-budget-owned-72269841-a6ee-49f5-8302-8e7d0678bd96.json`.
Canonical generation PASS 8.7 s, receipt
`c4-03-consumer-budget-build-0ae3bc1c-44d8-45ba-84f8-f10fceb13768.json`:
serial `2322242176`, build `f6421e50803d3ba3fb4bd54d`, release identity
`4410dbe4a8506195b7a49ef4730efaea6c7f051b4c4d1ae181d04e2d431647c2`.
The final exact-head and zero-diff rebuild receipts are recorded in the durable
resume checkpoint. The incomplete C4-03 scope and acceptance lock above remain
unchanged; neither commit constitutes a component acceptance or release.

### C4-03 successive owned projections — TODO implementation, 2026-09-09

Observed consumers now survive successive owned Phase 8 projections. The
projection keeps one private current observation per owned C AST and retains
the original producer bindings, not a recursively growing chain of earlier
projection observers. The current body, conditions, rewrite records, IR and
producer completeness disposition must still match. Ordinary production result
wrappers can retain those exact objects; copied/replaced AST data or public
history flags cannot issue the transition. Later recovery passes that replace
the expression outside this owned transition still remain unbound.

Earlier actual view/solver records are retained in
`phase8Projection.history.transforms`. Existing `phase8Projection.transforms`
and `transformCount` continue to describe only this invocation's newly applied
transforms. This preserves the public optimizer's adoption-count contract:
replaying a successful optimization reports zero new adoptions while keeping
the earlier solver record in the render-provenance ledger. Metrics continue to
measure current work; the shared provenance ledger consumes the retained history.

Retention uses the existing bounded data observer and explicit consumer/edge
caps. Missing/stale history, exhausted observation, cancellation and late
mutation cannot become complete merely through a later no-op projection.
Private history is published only at the final current/non-cancelled boundary.
Existing source/load/IR identities and proof-admission authority remain unchanged.

Focused evidence:

- 19 consumer-binding tests, including 12 successive store/return/branch
  projections, earlier view-record retention, exact-object wrappers,
  equal-looking replacements/copies, persistent incomplete state and unchanged
  load/IR identity; the previous consumer and UI regressions remain included;
- canonical provenance PASS 13.7 s, receipt
  `c4-03-reprojection-owned-settled-4cea0c9c-9c83-4950-b7e4-615769d300bb.json`;
- 13 existing proof-origin/publication tests PASS 2.5 s, receipt
  `c4-03-reprojection-proof-settled-165240cd-6036-491d-92b8-7192b5b269fd.json`.
  The real public-optimizer replay test now additionally requires a genuine
  first solver application, retained exact record/query/plan identity, a
  complete provenance map on replay and no new adoption. Its timeout and
  admission checks were not weakened;
- existing semantic pipeline PASS 0.7 s, receipt
  `c4-03-reprojection-pipeline-05a5860b-c809-4a8b-bdc3-9db0a9020586.json`;
- full actual inventory remains 256 paths, Phase 7: 22, Phase 8: 44.

Canonical generation PASS 3.7 s, receipt
`c4-03-reprojection-build-0e6e4819-1d98-4134-9363-1c9f80bba8f8.json`:
serial `2322242177`, build `9b9c26a35c1de6790a33dae0`, release identity
`647d7408e80828b6d9402e27765652d4b2d3019403d930e9c270edf31ccaf949`.
Exact-head and clean second-rebuild receipts follow in the durable checkpoint.

Live relevant PR heads remain #3421
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928` and #3422
`ca25c71f1a6f18f0ba043800fb066f8068f2df73`. Their reuse status is unchanged;
no new component was accepted and main was not reconciled in this step.
C4-03 remains open for later recovery-pass transitions and the full
CSE/DCE/phi/switch/struct-field removed/merged class denominator. All other
original findings and the integration acceptance lock remain in force.
No device/runtime, full gate, unrelated issue or performance work was added.

### C4-03 stack/phi/return recovery transitions — TODO implementation, 2026-09-09

Successful stack/CFG-phi recovery now emits one immutable before/after origin
record per actual return site, including the load, reaching stores, selected
controller and return instructions used by recovery. Failed width/barrier
reconstruction emits no applied transform. These records describe presentation
replacement; they do not claim that canonical IR instructions were deleted.

Private bindings associate each record with its own observed return expression.
The later stack-return recovery records its actual replacement and retains the
valid preceding phi history. The public semantic pipeline regression exercises
both passes, not only a prepared AST, and requires their records to remain bound
through repeated owned Phase 8 projections. No new semantic IDs, source mutation
of surviving loads, second recovery engine or relaxed proof admission is added.

Both passes reuse the existing bounded projection-data observer over canonical
instruction/value/CFG roots. Root descriptor replacement, accessor replay,
copied ASTs, changed widths/CFG and altered records cannot establish bindings.
Observations are shared across return sites; retained transitions are reobserved
as data rather than forming recursive observer chains. Consumer/edge exhaustion,
missing observation and truncated origins remain explicitly incomplete.

Evidence before final commit:

- 12 new recovery regressions cover forwarding, two-arm phi, multiple return
  sites, real public pipeline, stale/copy/accessor rejection, unsuccessful
  recovery, bounded/truncated history and repeated projections;
- canonical provenance PASS 15.8 s:
  `c4-03-stack-recovery-owned-settled-2714c720-b09f-4c92-b6b7-1fe96a31677a.json`;
- existing access-width, proof-origin/publication, return reanchor and both
  ownership regressions PASS 2.5 s:
  `c4-03-stack-recovery-boundaries-a7f414e9-b151-4e4f-920d-57be81022db0.json`;
- semantic pipeline PASS 0.6 s:
  `c4-03-stack-recovery-pipeline-settled-58d64443-c855-4777-a881-87aec2cf44cb.json`.

PR #3421 remains at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928` and its
previously reused mapper remains the implementation base. #3422 remains at
`ca25c71f1a6f18f0ba043800fb066f8068f2df73`; its admission incompatibility audit
still applies. No component merge, moving-main reconciliation, unrelated issue
or performance work is included. Integration acceptance remains LOCKED.

C4-03 still needs internal recovery simplification histories, the other legacy
recovery transitions, and full CSE/DCE/switch/struct-field removed/merged class
coverage. This step does not close C4-03 or any other original finding.

### C4-03 recovery-internal rewrite histories — TODO implementation, 2026-09-09

The existing stack-phi and stack-return passes now retain the actual
`RewriteEngine.proof` records for successful internal simplifications. A bounded
journal delegates to the same engine, without changing rewrite rules, roots,
admission, work limits or time limits. Each accepted return binds its internal
records together with the enclosing recovery record. The later return pass
preserves valid earlier phi records through its existing observed transition.

Tentative CFG recovery is transactional for provenance: failed subtrees roll
back their records and collected dependency origins. An unresolved nested
condition load can remain in a successfully recovered outer return without
publishing simplifications from the abandoned nested attempt. Rejected return
sites also restore history capacity before the next site is processed.

The journal retains at most 1024 records per pass invocation, or a lower
`renderProvenanceBudget.maxTransformRecords` request. Exhaustion never changes
the recovered pseudocode; it adds `recovery-rewrite-history-budget` to the
incomplete producer disposition. Existing mapper limits and stale/cancelled
observation checks still apply. No unapplied candidate becomes an applied
transform, and no canonical instruction deletion is claimed.

Evidence before final commit:

- recovery suite extended from 12 to 19 tests, including real nested-add and
  boolean-select simplification records, both public recovery transitions,
  stable record identity, repeated projection, capacity exhaustion, abandoned
  return recovery and abandoned nested-condition recovery;
- canonical provenance PASS 13.7 s:
  `c4-03-recovery-internal-owned-settled-acfbd2cc-484e-4bb1-ba7d-2a52403394f8.json`;
- width/proof/publication/reanchor/ownership boundaries PASS 2.3 s:
  `c4-03-recovery-internal-boundaries-d1a2f6a9-33eb-4349-aeaa-d4e9a5264dad.json`;
- semantic pipeline PASS 0.6 s:
  `c4-03-recovery-internal-pipeline-3b685ccb-56e6-463b-aaf1-ef4c3dcc89ee.json`;
- existing rewrite regression PASS 0.2 s:
  `c4-03-recovery-internal-rewrite-49ea2a03-70df-485e-9a3e-8bd1d769c553.json`.

All changes remain in already assigned paths; no new component is accepted.
The live C4-03 PR search still resolves to the already-reused #3421 head
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928`. No main reconciliation or parallel
performance/issue work is included. Other legacy recovery transitions and the
full CSE/DCE/switch/struct-field removed/merged class coverage remain open.
The original finding scope and integration acceptance lock are unchanged.

### C4-03 legacy stack-value and return histories — TODO implementation, 2026-09-09

The existing same-block legacy stack recovery moved from `pipeline.js` into
`passes/legacy-stack-recovery.js`; its reaching-store, width and barrier
predicate is unchanged, and its old exported helper remains reexported by the
pipeline. Actual load replacements now produce immutable source histories and
private bindings to the corresponding return consumers. Valid observed core
store-expression rewrites are retained, without assigning a shared input's
history to unrelated returns.

The real public-pipeline test exposed an earlier producer:
`materializeLegacyExactStackValues` had already replaced semantic-value loads
before same-block return recovery ran. That existing producer now records its
actual replacements and issues observed value-entry histories. Nested local
transitions are collected privately and published with one bounded final
observation, not one whole-graph observation per value or recursive observer
chains. Same-block recovery consumes these exact histories; final stack-return
recovery carries the valid earlier consumer through its owned transition.

This changes provenance only. It does not strengthen the earlier legacy
materializer's admission checks or claim that its predicate equals canonical
v2 MemorySSA forwarding. Canonical v2 remains excluded from both legacy paths.
Actual expression/load/IR identities and decompiled semantics remain unchanged.

History allocation is capped at 1024 new records per producer invocation, with
lower requested limits supported. Value/return consumer and graph-observation
limits remain bounded. Exhaustion is explicit even when the only retained
history slot holds an inherited core rewrite and the later materialization
record itself cannot be retained. Copied value entries/descriptors, changed
canonical roots/widths and accessor replay cannot mint a binding.

Evidence before final commit:

- 10 new canonical-discovered legacy tests: single/nested spill, actual stored
  producer history, unrelated-return negatives, full public pipeline, existing
  gate exclusions, mutation/copy/accessor rejection, materialization chain,
  budget propagation and no-op reruns;
- canonical provenance PASS 14.4 s:
  `c4-03-legacy-stack-owned-settled-4ad55864-7194-40ca-a307-47f04794073e.json`;
- deterministic/width/proof/publication/reanchor/ownership boundaries PASS 2.3 s:
  `c4-03-legacy-stack-boundaries-491afb93-edc8-48d7-966b-d263bd595ba0.json`;
- semantic pipeline PASS 0.6 s:
  `c4-03-legacy-stack-pipeline-bc804e98-9bf0-4fd9-9a76-c588d7d8d495.json`.

The already-reused #3421 still has head
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928`. No component merge, main
reconciliation or unrelated issue/performance work is included. Actual
rendered-entity removal/merge coverage (including proof-only spill removal),
other view transformations, CSE/DCE/switch/struct-field denominator coverage and
all original findings remain open. Integration acceptance remains LOCKED.

### C4-03 actual spill statement removal/suppression — TODO implementation, 2026-09-09

Two existing applied presentation transformations now retain their removed
statement history: core return-preservation spill suppression and the later
proof-only stack-spill removal. Their existing semantic/removal predicates and
resulting code remain unchanged. Already-empty input lines do not manufacture
another suppression event. Histories bind to the actual surviving return through
the existing private producer/consumer observations.

`renderedRemoval` names the `pre-transform-render` scope, operation, old line
position and kind. A producer-bound record can expose a transform-local
`before:<record-index>:L<old-index>:<kind>` tombstone in `removedRefs`. This is
neither a current rendered line nor a canonical IR identity; source navigation
continues to use the existing canonical origins and current `producedRefs`.
Copied/unbound history cannot certify a tombstone. The validator rejects current
line aliases, malformed scopes/positions and inconsistent removed references.
Ordinary in-place expression rewrites still have empty `removedRefs`.

The shared provenance UI explicitly labels removed/suppressed rendered statements
and their old position, while preserving the warning that canonical IR was not
deleted. The UI regression requires selecting the surviving return rather than
the unrelated statement which moved into the old position, unchanged pseudocode
copy content, and clearing history/navigation after snapshot invalidation.

Producer record limits do not change which statements are actually removed.
Missing observations, exhausted record budgets and unverified consumer bindings
remain explicit; no unapplied optimizer candidate is reported as a removal.

Evidence before final commit:

- 8 new removal regressions plus a shared-UI regression cover both real
  producers, canonical-IR non-mutation, shifted positions, private bindings,
  repeated projection, failed predicates, copy/mutation rejection, budget
  exhaustion, already-hidden lines and malformed tombstones;
- canonical provenance PASS 15.4 s:
  `c4-03-render-removal-owned-e2e9613f-df33-45e5-8799-9484773ee980.json`;
- deterministic/width/proof/publication/reanchor/ownership boundaries PASS 2.3 s:
  `c4-03-render-removal-boundaries-8f7a84f5-ba67-44fa-b21d-5024887175a8.json`;
- semantic pipeline PASS 0.6 s:
  `c4-03-render-removal-pipeline-5892c869-5327-47a7-9d5e-b3326bf6568f.json`.

The reused C4-03 PR #3421 remains at
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928`. No component merge, main
reconciliation or unrelated issue/performance work is included. These concrete
spill transformations do not prove the full CSE/DCE/switch/struct-field
removed/merged class denominator. Other view transitions and all original
findings remain open; integration acceptance stays LOCKED.

## C4-03 actual struct-field rendering history

The existing canonical field-location renderer now records its actual consumed
memory accesses, including store lvalues and nested load bases. Records are
issued for emitted consumers, not for unused aggregate-layout candidates.
The original instruction and base SSA origins remain navigable through the
existing #3421 mapper and private producer/consumer observation. Equal field
names and offsets do not correlate independent accesses. Repeated consumers
of one actual location share the original record; owned reprojection retains
history without counting it as a new optimizer adoption.

`fieldFor` naming remains presentation metadata, explicitly not type/layout
proof. Its existing fallback spelling and exception behavior, canonical IR,
load source/identity and pseudocode are unchanged. Bounded history or observation
failure withholds complete provenance instead of changing generated statements.
Copied descriptors/records and mutated canonical locations do not carry binding
authority. No new semantic engine, ABI rule or layout inference is introduced.

Seven new regressions cover independent equal-name accesses, unused candidates,
source/IR preservation, missing names, copy/mutation rejection, record/observer
limits, repeated projections, nested bases, shared consumers and the public
decompiler -> query -> navigation path with stale-snapshot rejection.

Precommit evidence in persistent `evidence/analysis-roadmap-20260909`:

- canonical provenance PASS 16.4 s:
  `c4-03-field-owned-c1d677fa-10c6-420b-9687-337e4b24fbfe.json`;
- deterministic/width/proof/publication/reanchor/ownership boundaries PASS 5.6 s:
  `c4-03-field-boundaries-8cc9feee-ff63-459a-83cc-d0da0f318d6c.json`;
- semantic pipeline PASS 0.6 s:
  `c4-03-field-pipeline-6728c98f-f6d2-4efa-a433-fc9f25729de3.json`.

Live #3421 still resolves to `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`;
the related PR search found no newer replacement for that mapping producer.
No component merge or main reconciliation is included. The user's concurrent
main performance changes remain for the defined reconciliation point, not
overwritten or reimplemented here. Source/test coverage of this field renderer
does not close arbitrary CSE/DCE/switch transformations, the original 23 finding
requirements, or integration acceptance. The checkpoint remains LOCKED.

## C4-03 actual switch-render transitions

The existing switch renderer now retains each actual emitted header/case/default/
closing span's branch origins and its own target origins. Replaced raw branches
receive pre-transform render tombstones; insertion without removal does not.
Private line/result observations carry the records through the existing core
and #3421 mapper. Copying metadata, changing source/target data or editing C AST
text cannot replay a binding. A second actual insertion preserves prior history.
The existing compatibility-name normalization carries only its own deterministic
spelling transition, not arbitrary edits. No switch eligibility, target rule,
selector semantics, pseudocode or semantic/legacy mode is changed.

The real public indirect-switch fixture enters the existing faithful fallback
because its targets are disconnected. That path now also publishes the same
mapper's switch history without inventing an analysis snapshot or promoting
fallback to semantic mode. Missing snapshot identity remains explicit. Observers
cover the renderer's instruction/block roots and descriptor/model inputs; the
IR envelope's helper methods and unused dominator Sets are not renderer inputs.
Record/observation limits preserve output and report incomplete history.

Eleven new tests cover actual spans and target separation, replaced/insertion-only
history, repeated projection, descriptor/IR/line/AST mutation, copied fallback,
compatibility spelling, budgets, rejected descriptors and snapshot-bound rendered
artifact navigation. The latter sends cloneable rendered artifacts, not the live
IR envelope: passing that envelope with its existing `defUse` method directly to
the generic query API is rejected as unclonable. No unrelated query-adapter repair
or complete end-to-end product-query claim is included.

Persistent precommit receipts (`evidence/analysis-roadmap-20260909`):

- canonical provenance PASS 20.3 s:
  `c4-03-switch-owned-final-b856ac4f-26bd-4de1-b0e2-62f1327a4280.json`;
- existing canonical switch tests PASS 0.4 s:
  `c4-03-switch-existing-03e7d021-9385-4f33-9542-c8e09f4cf984.json`;
- semantic pipeline/public switch PASS 0.6/1.0 s:
  `c4-03-switch-pipeline-9d1d3ddb-90ec-4f59-b0dc-b33d3e0669be.json`,
  `c4-03-switch-public-ff864806-8e5a-4544-bf4d-c0afa9b01964.json`;
- deterministic/width/proof/publication/ownership/reanchor PASS 5.5 s:
  `c4-03-switch-boundaries-29dea5d5-a125-4f72-bd57-3c31eccdc6c9.json`.

Live #3421 is unchanged at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`;
its mapper is reused. No main reconciliation, component merge or independent
acceptance occurs here. CSE/DCE coverage and all original finding requirements
remain open; Phase 8 DCE identifies candidates rather than applying removal, so
its candidates must not be reported as executed transformations. Integration
acceptance remains LOCKED. Concurrent main performance work is preserved for the
defined reconciliation point.

## C4-04 requested-target decision coverage

The actual proof-plan and optimizer APIs now retain one ordered audit row for
every inspected requested target: semantic/raw identity, width/operator,
candidate count and selected/unsupported/unchanged/refuted/unknown disposition.
In particular, independently proved nonconstant candidates no longer disappear
from the result: they explicitly report the existing constant-only projection
boundary. A complete decision denominator is not complete proof coverage.

The existing private plan/receipt and atomic transaction remain the only adoption
authority. A selected proof is not called adopted until the actual published
projection contains its semantic value ID and exact query hash. Failed/stale/
cancelled publication resets all reported target decisions to unknown and keeps
aggregate adoption zero. An uninspected request has unknown target count, not an
invented empty completed denominator. Decision rows and coverage are immutable;
the inspected request set participates in the plan's audit identity. No new
solver, transaction core, semantic rule or nonconstant/memory/CFG adoption is
introduced.

Eight new tests cover ordered mixed target decisions, real independently proved
nonconstant refusal, non-total target refusal, resource/early failure, immutable
audit vs private authority, actual adopted transforms, publication withholding,
and a 10-cell exact width/operator denominator (1/4/8/32/64 x xor/udiv). This is
the decision-reporting prerequisite, not the entire risky-rewrite registry or a
claim that C4-04 is complete.

Precommit persistent receipts (`evidence/analysis-roadmap-20260909`):

- canonical substrate PASS 62.1 s:
  `c4-04-decisions-substrate-62c3bc80-a027-4a29-b37f-6e343d3cf3c4.json`;
- optimizer/publication/performance/ownership boundaries PASS 6.3 s:
  `c4-04-decisions-boundaries-5cf743c6-635d-4607-8456-e608c525b0f5.json`;
- canonical provenance PASS 19.8 s:
  `c4-04-decisions-provenance-ff1acda8-ce83-4755-a130-10b81041f722.json`.

The full original backlog table was reread. C1 boundary bridges and the C4-05
candidate generator already exist and are not reimplemented. Live #3422 remains
`ca25c71f1a6f18f0ba043800fb066f8068f2df73`; its no-adoption/explicit-unknown
intent is reused, not its incompatible older transaction core. The next scalar
extension requires a producer-owned mapping from the canonical translator's
query-local input symbols to actual rendered input expressions; parsing symbol
names or recreating an evaluator would not establish that mapping. Nonconstant
projection and memory/CFG/exception observables remain open, alongside all other
original findings. No main reconciliation or component acceptance occurs here;
integration remains LOCKED.

## C4-04 producer-owned input correspondence

The scalar extension now carries the existing translator's actual query-local
input symbols and SSA value objects through the private proof plan and committed
overlay to the representation producer. Translation and proof semantics are not
duplicated. Public entry input IDs are immutable audit data, not authority. A
staged/copied overlay, copied result/value/AST, stale identity, changed input or
cancelled query cannot provide the relation. The display endpoint is resolved
through the producer's already-observed IR/AST pairing, not register spelling or
a caller-supplied ID map. Current constant projection consumes that correspondence.

The mapping is target-local: equal query-local symbol IDs can designate different
SSA values in different target translations. Equal register spellings remain
distinct actual inputs; the existing ambiguous-name proof refusal remains in
force. A separate distinct-name fixture proves a real nonconstant candidate and
resolves its surviving input, but this checkpoint does not yet adopt that term.

Twelve added regressions (nine canonical Phase 9 egraph tests and three Phase 8
substrate tests) exercise both actual endpoints, per-target ordering, shared
dependencies, numeric/string IDs, universal versus execution-configured inputs,
immutable audit records, unissued identity getters, copied/staged artifacts,
mutation, cancellation and budget refusal. The existing transaction, provenance
and optimizer tests remain part of validation. Persistent precommit receipts:

- vertical input/projection/optimizer tests PASS 9.3 s:
  `c4-04-input-binding-vertical-60eae22e-b206-4b7a-9f0d-41b106017682.json`;
- canonical substrate PASS 63.5 s:
  `c4-04-input-binding-substrate-5eb21753-3449-45f8-a24e-d54fd86cee58.json`.

An earlier render run failed two proof deadlines (receipt
`c4-04-input-binding-render-df1eef0d-b0fd-4592-b9e2-ba2a65502aa5.json`). Its log
is retained; it is not a passing run. No timeout or assertion was relaxed.
Final committed-head receipts are recorded in the persistent resume checkpoint.

Next: use these actual input endpoints when projecting independently proved
nonconstant scalar candidates, with exact width/operator semantics and explicit
refusal for unrepresentable terms. Arbitrary nonconstant construction/adoption,
the full risky-rewrite denominator, and memory/CFG/exception observables remain
open. Existing #3422 proof/unknown intent and #3421 provenance work remain reused.
Main performance changes announced by the user are reserved for the defined
reconciliation lane; none are overwritten or reimplemented here. This is source
progress, not a component acceptance or integration unlock.

## C4-04 independently proved nonconstant scalar projection

The producer-owned input relation now reaches actual nonconstant publication.
The existing candidate query and independent proof consumer select an eligible
BV term; a bounded immutable display recipe lowers it through the existing C AST
constructors. No candidate generator, evaluator, solver or transaction core is
replaced. The legacy solver pass ID advances to version 2.0.0; nonconstant ledger
records use `solver-scalar`, while existing constant records remain intact.

The recipe supports inputs, arithmetic/bitwise/unary operations, saturating
shifts, comparisons, Boolean terms, selection, casts, extraction and concatenation
within 1–64 bits. Native-width unsigned views/masks and explicit sign extension
preserve the BV meaning at the C integer-promotion boundary. Shift guards avoid
both C undefined counts and a mismatch with the existing masked-count AST
evaluator. Unsupported/unknown/division/effect terms never acquire a recipe.
Compilation caps unique nodes, depth and expanded operands, including duplicated
operands introduced by guarded shifts; budgets cannot truncate a term into proof.

Only a current real committed overlay can publish these recipes. Shared observed
roots must agree on the exact recipe and actual input expression objects, not
hashes or display names. Private published-recipe history makes replay idempotent
without manufacturing authority from serialized records. Origin/proof history is
retained while the current adopted count returns to zero on a fresh replay.

Eight new canonical substrate tests cover exhaustive widths 1–5, native-width
boundary values, scalar operator/width conversions, Boolean terms, bounds,
unavailable/forged inputs, actual nonconstant MBA publication, stale/withheld
admission and replay. A real printed-C/UBSan regression uses CC or cc. The existing
real-machine cancellation fixture now explicitly asserts two constant and three
nonconstant SSA projections (five decision rows), preserving `return 0` and the
original machine instructions. This counts projection bindings, not removed IR.

The first independent printed-C run found signed-select return promotion and
32-to-64 sign-extension errors that AST evaluation alone missed. The lowering
was corrected; the permanent compiler regression covers both. Full supplemental
Clang 14 / -O2 / UBSan replay passes 134 generated functions and 5,576 cases over
widths 1/4/8/16/32/64. Its precommit receipt is
`c4-04-scalar-c-oracle-74a80b63-0349-4765-957b-e9d1c207a227.json`; failed receipt
`c4-04-scalar-c-oracle-3a412222-5984-4f84-bccf-27f2f48aacc7.json` is retained.
The reproducible verifier is preserved in persistent evidence as
`evidence/analysis-roadmap-20260909/verify-scalar-c.mjs`. An initial pinned Clang
18 invocation lacked its UBSan runtime; no environment repair or sanitizer
waiver was made. The permanent regression uses the available CC/cc driver and
the supplemental matrix uses system Clang 14. Exact-head receipts follow in the
persistent resume checkpoint; these are not browser or full release evidence.

Live #3422 was rechecked at unchanged head
`ca25c71f1a6f18f0ba043800fb066f8068f2df73`, with no additional open C4-04 PR found
by the scoped query. Its proof/no-adoption intent and existing #3421 provenance
remain reused. No main reconciliation or component acceptance occurs here.
Scalar display adoption is implemented, but the full risky-rewrite registry,
memory/CFG/exception/UB observables and all other original findings remain open.
The user's separate main performance changes are neither overwritten nor copied
into a duplicate implementation. Integration remains LOCKED.

Final precommit canonical substrate rerun failed 8 tests with deadline/partial
results (163.3 s), receipt
`c4-04-scalar-final-substrate-681a2ca0-127c-41b8-904a-00ba89ada721.json`.
The focused changed-file rerun also had deadline/withheld failures (25.1 s),
receipt `c4-04-scalar-final-focused-7c889a5c-f734-4a7c-a6c5-fd4d344ab13b.json`.
Concurrent host work was observed, but these runs are failures, not waived green
gates or proof of a solely environmental cause. Existing deadlines and assertion
floors were not changed. The previous compiler/AST/production successes remain
historical evidence; exact committed-head results must be checked separately.

## C4-04 registered transaction rewrite policies

The registered Phase 8 transaction denominator is now built from the actual
eight production descriptors plus the opt-in proof descriptor. Each row records
the pass version, stage, analysis/candidate families and allowed transform kinds.
Unknown or duplicate registrations and an incomplete descriptor union fail the
registry check. This is not a detached hand-maintained count of executed work.

All eight ordinary passes currently publish analyses or candidates, not
transforms. The transaction boundary rejects any reported transform from these
analysis-only descriptors, after the existing immutable result snapshot and
before any invalidation or staged publication. The production vertical requires
a classified policy. The standalone generic transaction API remains available
for other descriptors without turning them into registered production passes.
The actual proof descriptor may report only `solver-constant` or `solver-scalar`;
its existing private plan, receipt and final admission checks remain mandatory.
A matching string ID, copied descriptor, registry row or digest is not proof.

Every published or withheld vertical now carries frozen `rewriteCoverage` rows
for the full registered denominator, including disabled stages/proof mode.
Rows distinguish `analysis-only`, `unsupported`, `not-requested`, `unknown`,
`unchanged` and `proof-committed`. Result status/completeness remain explicit;
`accounted` counts listed rows, not proved or completed families.
`proofTransformCount` counts actual published proof transaction records, not
rendered adoption. Any withheld publication reports zero committed transforms
and unknown selected rows, even after earlier private transactions succeeded.
The registry version and policy are included in execution registry identity.

`tests/phase8/substrate/rewrite-registry.test.mjs` exercises the exact union and
policy identity, actual enabled/disabled/missing-input execution, real proof
publication, unsupported targets, copied plans/descriptors, rejection of
transforms from every ordinary descriptor, and cancellation at every observed
vertical transaction check. State snapshots must remain unchanged on refusal.
An initial test incorrectly compared registration order with dependency-sorted
execution order; it now compares the exact ID-to-row mapping. Failed receipts
are retained; final exact-head results belong in the persistent checkpoint.

The first canonical substrate run failed nine deadline/partial-result checks
(275.2 s), including proof preparation before the new transaction policy runs.
The focused rerun also failed two proof-preparation deadline assertions. No
deadline, proof backend, assertion, sample or denominator was weakened. These
remain failed evidence, not environment-waived acceptance; later exact-head
verification must record its own results. Live PR reuse checks still found
#3422 at `ca25c71f1a6f18f0ba043800fb066f8068f2df73` and already-reused #3421 at
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928`, without another open C4-04 match.

This closes the registered-transaction classification/enforcement step, not
FR-C4-04A as a whole. Representation RewriteEngine/view transformations and the
full risky scalar family/width denominator still need coverage. This check does
not prove arbitrary trusted JavaScript passes cannot secretly mutate their raw
IR input; it restricts staged/reported publication. Memory, CFG, exception/UB and
bounded-loop observables remain FR-C4-04B work. Original findings and the frozen
compiler denominator are unchanged. No component merge, moving-main acceptance,
device/environment repair or separate performance work is included. Integration
acceptance remains LOCKED.

## C4-04 existing representation rules as independently verified candidates

The optional proof entry now accepts `candidateStrategy:'representation-rules'`.
It reuses all 64 actual `DEFAULT_RULES` and the existing RewriteEngine. Canonical
symbolic analysis has an explicit `translate-only` mode: it still issues the
real target/input/taint relation and retains stale/mutation checks, but runs zero
candidate queries and returns frozen empty candidate arrays. The Phase 8 owner
then generates proposals without introducing a symbolic-to-decompiler import
dependency or an external callback/rule injection interface.

`phase8/representation-candidates.js` creates a disposable exact-width pattern
tree from the existing bounded expression recipe. Repeated input occurrences
have explicit bindings to the same actual canonical symbol, not equality inferred
from a display name. The existing rule matcher, preconditions, cost gate, phase
order and work/iteration/application bounds remain in use. The proposal syntax
adapter invokes existing canonical Expr constructors; it neither evaluates a
program nor determines proof eligibility. A proposed after term is independently
verified against the original canonical before term by the existing candidate
judge. Only an eligible private receipt can enter the existing plan, transaction
and projection path; the temporary AST never becomes a published representation.

All 64 registered rules appear in each generated batch's frozen coverage report.
Counts mean candidate-tree work, not committed transformations. A contributor to
a proved whole proposal is not a universally proved rule. Refuted candidates,
unsupported source/output, cancellation, stale identity and exhausted budgets
cannot authorize publication. Child generator resource counts charge the parent
plan. Pass version is 2.1.0, and the chosen strategy plus per-target generator
coverage enter the plan's audit identity. The ordinary synchronous decompile
does not load the optional module or change its rendering behavior.

Permanent tests exercise: the exact 64-rule union; an 18-cell width/operator
matrix (1/4/8/16/32/64 by xor/or/add) retaining the refuted BV1 add cell; the actual
unsigned-select-to-abs rule's refuted candidate; no plan entry for a refuted
chain; object-bound inputs; unsupported effects/accessors/cycles/depth; exhaustive
small-width adapter checks; resource/lifecycle refusal; translation-only issued
input ownership; actual producer -> private plan -> transaction -> projection,
including the public ARM64 machine-to-decompiler entry's proved-but-already-
rendered EOR and explicitly unsupported ADD-auxiliary cases;
no adoption on replay or withheld publication. The first fixtures assumed a
shared-DAG pattern cost equaled tree cost and that an already rendered constant
would be newly adopted. The pattern view now explicitly expands only the already
bounded tree and binds each leaf; the production test verifies an actual changed
nonconstant output. Failed runs remain retained, not waived proof.

The first public ADD fixture was rejected by the existing executor because its
lifted stream contains BFX/is-zero auxiliaries outside that execution profile.
No instruction was removed and no opcode/environment/issue repair was made to
force success. The permanent machine-entry test retains that unsupported cell
and separately verifies EOR's real proof transaction without falsely counting
its already-rendered constant as new adoption. This is not whole ARM64 coverage.

This adds a working proof-gated use of existing display rules. It does not mark
all 64 rules universally sound or close FR-C4-04A/C4-05A. Full family/width/idiom
coverage and the remaining ordinary legacy-view adoption boundaries stay open,
as do C4-04B memory/CFG/exception/UB observables and all original findings. Existing
e-graph/solver/transaction implementations remain reused. No issue/performance/
environment/device lane is repaired here. Integration acceptance stays LOCKED.

## C4-05 frozen scalar-family and width coverage

`tests/phase9/egraph/family-width-matrix.test.mjs` introduces an explicit
34-family x 8-width denominator (272 cells), with widths 1/2/3/4/8/16/32/64.
It reuses the actual canonical Expr factories, existing e-graph, extraction,
independent candidate verifier and private receipt validator. No candidate rule,
solver, deadline, resource ceiling or production rendering behavior is changed.
The canonical Phase 9 egraph group discovers this test. Its new exact path belongs
to the existing symbolic owner, not a blanket ownership exemption.

Every cell is attempted, including unsupported intermediate BV65 expressions.
Direct integer formulas check the original source as well as every published
candidate: all input pairs at widths 1–4, and an explicit boundary cross-product
at larger widths. Every eligible result requires the actual privately issued
receipt, original before/after objects and a proved evidence verdict; a copied
receipt fails. The evidence records candidate IDs, source/output hashes, costs,
rule histories, query hashes, measured resource counters, elapsed time and explicit
dispositions. Allocation counters are not measured process peak memory.

The initial retained run produced 240 proved-candidate cells, 5 unchanged
equal-cost double-add cells, 24 unknown/withheld cells and 3 unsupported/withheld
cells, with 47,180 concrete input-pair checks. A candidate is not an adopted
projection. Equal-cost add/shift extraction may retain the original hash-ranked
term; this is not counted as proof. The 24 wide proof attempts returned
`cancelled` through the current verifier boundary; this report does not infer a
more specific timeout/solver-limit cause or repair that separate owner.

The first test attempt incorrectly required a candidate for every equal-cost
double-add and a completed proof for every native-width cancellation. The retained
inventory established those distinct outcomes. The permanent regression now
requires positive proof on the supported cells, permits bounded refusal only on
the explicitly enumerated wide-family gaps, and requires an empty candidate batch
on every refusal. It does not waive arbitrary new failures or promote those gaps
to proved status. The retained report explicitly has `completeProofCoverage:false`.
The frozen matrix and known-unsupported rows remain in the denominator.

Additional permanent checks cover 14 symbolic Bool families (not conflated with
BV1), 8 independently refuted off-by-one MBA candidates, all 272 cells with zero
work budget, and cancellation-expression discovery/association variants plus
replay at all 8 widths. Search extraction is checked separately from proof
availability, without injecting alternative rules into the production API.
This is association/discovery metamorphism, not a claim to have tested every
possible rule schedule.

The existing real-producer nonconstant MBA fixture now exercises all 8 widths
through proof planning, transaction and rendered projection. Small-width cells
require actual adoption, proof-linked provenance and exhaustive output checks;
unproved wide cells must retain the original pseudocode, IR and expressions with
zero adoption. Its previous fixed uint8 return annotation now follows the fixture
width. This remains synthetic Semantic IR evidence, not the frozen 135-binary
compiler corpus, raw instruction support or physical-device proof.

Both existing PR #3421 and #3422 were rechecked at their previously inspected
heads; the open egraph/equality-saturation search found the current integration
PR #7036 and no separate implementation to duplicate. Full legacy rule coverage,
arbitrary rule-order metamorphism, memory/CFG/exception observables, native-width
proof gaps and required integration acceptance remain open. All original 23
findings are retained; no finding is marked complete. Acceptance remains LOCKED.

## C4-05 actual rule-order metamorphism

The equality-saturation query now has three finite built-in `ruleOrder` values:
`canonical` (the unchanged default), `reverse`, and `discovery`. The same existing
rules generate a completed proposal batch before scheduling; no externally supplied
rule, comparator, solver result or proof is accepted. Scheduling changes only the
order of that batch's addition/union, not its contents or the search/rebuild
boundary. The default ordering and resource charge remain unchanged. This is a
bounded candidate-generation control, not a second semantic engine.

The order is snapshotted as data before asynchronous work. Query/candidate output,
the owned symbolic target and Phase 8 target decisions report it; the plan's audit
binding also includes it. Pass version is 2.2.0. Unknown orders, coercible objects,
callbacks/accessors and orders on other strategies are rejected without silently
falling back to the default. Only the existing private verifier/plan/transaction
capabilities authorize adoption; schedule metadata and a copied receipt do not.

The existing 34-family x 8-width denominator and independent formulas moved
unchanged into a shared test fixture module, so canonical and order-metamorphic
tests cannot silently use different corpora. The order test covers all 816 cells:
807 supported searches must have the same bounded Pareto choices/costs under all
three actual schedules, and 9 unsupported intermediate-width cases remain explicit.
Each schedule's extracted candidates separately face the existing independent
verifier and the concrete formulas. Previously recorded native-width proof gaps
are still unknown/withheld with no candidates, not upgraded to proof successes.

Further regressions cover the scheduling primitive's actual permutations and
unchanged default cost, all 14 Bool families under all three orders, exact
N-1/N/N+1 work/allocation boundaries per schedule, deterministic replay, invalid
configuration, cancellation and stale identity. A real producer/optimizer test
threads all three schedules through the private plan/transaction and rendered
projection: outputs match, query/provenance IDs survive and plan audit IDs differ
by schedule. Original IR and producer output stay intact.

The open egraph/equality-saturation/C4-05 search was repeated and found the current
PR #7036, with no separate candidate implementation to duplicate. No solver or
performance issue, device/environment repair, component merge or main merge is
included. This discharges the declared finite three-schedule regression item;
it does not prove arbitrary permutations, unbounded search, every native proof,
the whole original C4-05 card or the full 23-finding roadmap. The 135-binary
compiler denominator and all remaining scope stay unchanged. Integration
acceptance remains LOCKED.

## C4-05 generator audit on actual adopted-transform history

The equality-saturation query now reports its actual frozen effective `limits`;
the owned symbolic target retains them alongside its existing query metrics.
For an independently eligible equality candidate, Phase 8 creates a bounded,
deeply frozen `generatorAudit`: candidate/proof query IDs, rule-set version and
order, applied search rules, the selected candidate's extraction cost, effective
limits and measured counters. It is carried by the genuine plan entry and its
committed overlay into actual `phase8Projection.transforms` and
`renderProvenance.ledger`, including retained history on replay.

This connects the existing candidate information to the real transformed output;
it is not another ledger or verifier. Pass version is 2.3.0. The canonical pass
result's exact transform/validation/rewrite schemas are unchanged. Its plan and
proof IDs still link the committed entry, while the rendered-transform ledger
holds the bounded generator record. Copying/editing the audit never creates a
plan, committed overlay, producer input binding or proof capability.

The applied-rule set is explicitly search-wide, not an invented derivation
certificate for one candidate. Query counters and limits are not per-rule costs,
whole-function totals, internal solver ceilings or physical peak memory. Dynamic
wall-clock observations remain outside stable plan/audit identity. Audit capture
is charged to the parent plan budget; limits are captured from the actual query,
not reconstructed from defaults or copied from caller-supplied metadata.

Nine permanent substrate tests exercise effective nondefault limits and async
mutation, owned target propagation, genuine committed overlays, constant and
nonconstant real projection under all three schedules, proof-linked provenance
and replay, deterministic identity, fake plans/overlays/history, late refusal and
exact N-1/N/N+1 parent capture budgets. Other strategies remain unlabeled rather
than receiving fabricated equality metadata.
The existing public ARM64 EOR/MBA machine-to-decompiler regression also checks
every actual transform's generator audit and matching render-ledger entry; no
instruction or target-device coverage is removed to force that fixture through.

The first tests incorrectly required null-prototype input dictionaries to remain
prototype-identical after JSON transport, and treated every new result wrapper
as a new AST. The product deliberately permits wrappers retaining the same owned
AST. The corrected regression requires value-preserving audit serialization,
zero adoption from forged metadata, explicitly incomplete history after history
substitution, and refusal of copied ASTs. No product authority was weakened or
issue-lane behavior changed to accommodate those initial fixture assumptions.

The live relevant PR search again found the existing integration PR #7036 and no
separate egraph implementation to duplicate. This implements the stated C4-05
rule-set/budget/cost/proof-ID history path for adopted equality candidates.
Native-width proof gaps, arbitrary permutations/unbounded expressions, ordinary
legacy-view adoption, memory/CFG/exception observables and full integration
acceptance remain open. All 23 original findings and the frozen 135-binary
compiler denominator remain; no whole finding is newly closed. Acceptance LOCKED.

## C4-03 initial semantic-render omission history

The actual `semantic-core` emitter now records initial runtime-noise call and
mechanical stack-spill omissions in the existing render-provenance ledger.
These are **observed display events, not semantic DCE or equivalence proofs**.
Canonical CALL/STORE instructions and the existing display predicates are
unchanged. Original diagnostic `ctx.suppressed` entries remain available.

Only the emitter issues the private suppression-history binding. Actual event
instruction/source identities are checked at the end of emission; a bounded
instruction-local observation then binds the diagnostics and canonical objects
to the completed render. The IR envelope, instruction-array identity, selected
instruction positions and immutable disposition must remain current. This is
not a full-CFG suppression-soundness proof. The selected faithful-CFG fallback
starts its own event list instead of publishing the abandoned structured attempt
twice. Capture and publication budgets, unavailable observations, cancellation,
copied diagnostics, stale instructions and mutations during map construction
remain explicit incomplete states. They do not alter actual emitted output.

Records carry `kind:display-suppression`, the observed rule/reason and original
row/address/IR references. The existing `transformReverse` maps these sources to
history. There is no fabricated pre-transform C line, `removedRefs` tombstone,
replacement-expression edge or rendered consumer. Origin overlap with a visible
line is not a binding. Public projection records cannot mint this event kind.
The existing shared PassResult/proof contracts and render-map version are not
changed; no new semantic identity or independent ledger is created.

The existing snapshot-bound UI now shows these omission reasons and explicitly
distinguishes them from semantic deletion/equivalence. History alone does not
authorize navigation through a nonexistent rendered line. Ten new canonical
provenance tests exercise real machine-input CALL emission, actual mechanical
STORE suppression, non-suppression/expert negatives, replay, private ownership,
budgets/cancellation, source changes during emission, stale mid-build data and
real faithful-CFG fallback. One
additional UI/query regression uses the actual cloneable rendered artifacts,
matching the established switch-history fixture: the live compatibility IR owns
methods and is not itself a cloneable query value. No query-adapter issue repair
or real-browser/device acceptance is claimed.

Existing PR #3421 remains the reused C4-03 foundation; live head
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928` was rechecked. The existing integration
PR #7036 remains authoritative. Other concurrently open issue/performance PRs
are not merged or reimplemented here. One exact new Phase 8 provenance test path
is added to the ownership union, with no shared-contract exemption.

C4-03 still requires the remaining view-transform and complete removed/merged
class denominator. All 23 original findings, the 135-binary compiler denominator,
mandatory central current-main reconciliation and exact integration acceptance
remain open. Acceptance stays LOCKED; device/environment/issue/performance work
continues to belong to the other lanes.

## C4-03 actual legacy-idiom transformation history

The four existing `recoverArm64ClangIdiom` applications (`madd`, `msub`,
`bit_extract`, signed-mask `max`) were executed before RewriteEngine without
entering its history. `pipeline-core` now captures these actual before/after
source transitions and prepends them to the existing per-value rewrite history.
The same existing private consumer observations bind them to actual stores,
returns and nested expressions. No separate recognizer, semantic AST, ledger,
identity or proof authority is introduced. Descriptive shape labels are not
semantic IDs. Recognition rules and emitted semantics are unchanged.

Each record explicitly says `legacy-idiom-recognition-not-equivalence`.
Recording an existing display transformation is not a new proof of the
recognizer's soundness: ordinary legacy-view proof gating remains C4-04 work.
The mandatory representation fallback records its actual recognizer executions
even when the optional rewrite pass was skipped. Function-wide capped history
and existing consumer-observation budgets keep omissions explicit/incomplete
without changing the recognizer's output. Copied history/consumer data cannot
manufacture a replacement edge. Repeated owned projections carry the history
without re-running or duplicating those events.

Seven new canonical provenance tests cover all four actual recognizers across
eight widths (32 finite source-history cells, **not** 32 equivalence theorems),
nested/shared consumers, unmatched shapes, private/stale rejection, exhausted
history/consumer budgets, actual deadline-skipped mandatory fallback and
snapshot-bound query navigation. Canonical data and original root identities
are checked separately because structuredClone does not retain DominanceView
prototypes. A skipped PassManager entry has `ok:true, skipped:true`; the test
uses `skipped` to distinguish it from actual execution. No scheduler/deadline or
canonical-IR behavior was changed to satisfy these fixture checks.

Live open idiom-title PR search found no additional implementation; reused
C4-03 PR #3421 and existing integration PR #7036 remain authoritative. CSE/DCE
inspection found `valueNumbers`/`deadCode` fact publishers with `transforms:[]`
and no display-adoption consumer in the current pipeline/projection. This is
not an implemented rendered CSE/DCE path and does not justify synthetic
removal histories. The full removed/merged-class denominator remains open.
One exact new Phase 8 test path is added to the ownership union. All original
23 findings and the frozen 135-binary compiler denominator remain; integration
acceptance stays LOCKED and no whole finding is newly closed.

## C4-03 actual equal-incoming phi view collapse

The existing expression builder selects the first incoming expression when all
phi inputs have the same structural key. This is a separate path from the
already integrated stack/phi recovery pass. It now retains a bounded source
history containing the canonical phi and every incoming value/definition, and
binds that history to the actual rendered consumers through the existing
per-value histories and private producer observations.

Dependency histories follow the actual builder call/memo path, not a second
SSA traversal or equality-of-rendered-node inference. This distinction matters
when a phi and an unrelated value share the exact same expression object. The
unrelated consumer must not inherit the phi history. Nested uses propagate the
actual event; already-constant values that bypass the phi builder do not invent
one. Unequal inputs retain the existing phi representation without a collapse
event. The canonical phi, incoming edges, chosen expression, memo semantics and
display predicates are unchanged.

Records explicitly say `observed-phi-view-collapse-not-equivalence`: no new
CFG-edge or equivalence proof is claimed. Before exposing a binding, the actual
selection-time instruction/input observation and the existing rendered-consumer
observation must both remain current. Copies do not carry this private binding.
A later renderer callback changing incoming edges leaves earlier history
unbound/incomplete. Observation work consumes the same cumulative function
budget; history count and origin snapshots are bounded. Missing/cancelled
observations and exhausted budgets preserve the actual output but cannot claim
complete provenance. Mandatory deadline-skipped representation fallback retains
its actual selection history as well.

Nine new canonical provenance tests cover distinct equal definitions and shared
AST inputs across eight widths (16 source-history cells, not equivalence proofs),
nested/repeated consumers, unequal and unvisited/precomputed negatives, changed
edges/definitions, copied metadata, callback mutation, history/observation limits,
the real mandatory fallback, replay and snapshot-bound query navigation from
the phi and second incoming definition to the actual return. Canonical data and
original root identity are checked separately. Existing idiom and canonical
provenance regressions remain required; no device/environment or issue/performance
repair is included. One exact Phase 8 test path is added to the ownership union.

Existing PR #3421 remains reused; the open phi-title PR search found no additional
implementation. All 23 original findings, the 135-binary compiler denominator,
C4-04 legacy proof gating and the remaining C4-03 class denominator remain open.
The preceding checkpoint's broad deadline-related failures are retained, not
waived as baseline or silently converted into acceptance. Integration stays LOCKED.

## C4-03 actual C AST compound-store spelling history

The existing C AST producer spells a direct same-location load/add/sub/mul/store
as post-increment, post-decrement or a compound assignment. Those five actual
branches now append bounded source histories to the existing rewrite ledger.
The record retains the load, arithmetic, store and rendered address inputs;
implicit spelling is not removal of a canonical load or value. Before/after
origin sets therefore retain those inputs, with no invented deleted semantic
entity, replacement AST, memory proof or RMW analysis-fact adoption.

Only the actual store-render consumer receives its record, not another store
or return that consumes the same expression. Selection-time observations bind
the original instruction root/position, inputs, expression and location before
calling an abort hook. Consumer publication and later projection check those
observations again. Mutation, replaced instructions and copied public records
cannot manufacture a current rendered edge. Caps and cancellation preserve the
actual existing output while reporting incomplete provenance. The observation
closure retains the selected IR inputs, not the full pipeline state.

The proof label is `observed-store-spelling-not-memory-equivalence`: the existing
display predicate is unchanged and is not newly certified for atomicity,
aliasing, overflow or memory observables. Phase 8 currently expands the compound
text back to an ordinary assignment; the actual earlier spelling event is
retained through that owned projection and replay, not presented as the current
line spelling. The earlier semantic-core RMW renderer (including division) and
explicit later spelling-transition histories remain separate uncompleted paths.

Nine new canonical provenance tests cover five actual spellings at eight widths
(40 source-history cells, not equivalence proofs), distinct actual consumers,
non-rendered/reversed/different-location negatives, stale/copy/root refusal,
late renderer callback mutation, cumulative record limits, cancellation,
mandatory deadline-skipped fallback, replay and snapshot-bound query navigation.
Canonical IR data/root identities and existing output predicates are preserved.
The exact new test path is assigned to Phase 8 ownership.

Live PR #3421 remains the reused foundation at
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928`. The open compound-title search found
no match; the provenance-title search also found the unrelated cache issue PR
#7746, which is not imported into this TODO lane. These searches are not an
exhaustive proof that no other implementation exists. All original 23 findings,
the 135-binary denominator and existing broad substrate failures remain open;
no requirement is narrowed or marked complete. Acceptance remains LOCKED.

## C4-03 initial RMW-render history and owned consumer handoff

The initial semantic renderer's actual seven RMW spelling branches now record
post-increment/decrement, add/sub/mul assignment and signed/unsigned division
assignment through the same expression-origin history and final render ledger.
The earlier C AST compound-store event remains a separate actual later event;
neither is inferred from RMW facts alone or from source/text equality. All
load/arithmetic/store dependencies remain canonical inputs, not deleted semantic
entities. The proof label stays `observed-store-spelling-not-memory-equivalence`.
This does not certify the existing RMW predicate or issue alias, atomicity,
overflow or memory-observable equivalence proof.

Only the initial emitter privately binds its actual line. It snapshots the
selected instruction/RMW inputs before operand rendering can invoke symbol
callbacks, then observes the emitted line and rechecks the selection. Original
instruction root/position, operand mutation, copied lines, copied dispositions
and copied downstream records are checked. Historical events remain available
without a current binding when inputs become stale. The faithful-CFG fallback
discards events for its abandoned structured attempt, retaining only final
emission events; it does not replenish the cumulative observation budget.

The existing compatibility-name normalization has one implementation and carries
only an observed line through that exact spelling transition. Its switch-line
handoff is retained. The C AST producer consumes the exact initial line/store
pair and carries its history through the public pipeline, Phase 8 projection,
replay and query navigation. Division receives this handoff even though the
later C AST renderer prints it as a full assignment. That is historical-event
continuity, not an assertion that compound spelling survives every projection.
Explicit later spelling-transition records and other C4-03 transform classes
remain open.

Twelve new canonical provenance tests cover seven actual branches across eight
widths (56 source-history cells through the public pipeline, not RMW theorems),
distinct initial/later events and replay, non-emitted analysis facts, real stack
name normalization, stale/copy/root/validator-tampering refusal, caps/cancellation, symbol callbacks
during and after emission, faithful fallback, late map-construction mutation
and snapshot-bound division navigation. The initial naming fixture was corrected
to use the renderer's real `stackSlots` name input; no production naming behavior
or expected output predicate was changed to satisfy it.

PR #3421 remains the reused foundation at
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928`. A new relevant query-layer PR #7820
was inspected at `e1380aec9468c865ad276379656b801f1ada6931`: it preserves
inconclusive runtime verdicts and fixes omitted-epoch snapshot defaults. Its
four changed paths do not implement initial RMW rendering. It remains a central
reconciliation/reuse candidate owned by the parallel issue lane; no duplicate
query fix or ad-hoc component merge was made here. The RMW-title search was
empty; PR #7746 remains unrelated cache work. Search results are not an
exhaustive no-duplicate proof. All original 23 findings and the frozen135-binary
denominator remain open; no whole requirement is closed. Acceptance stays LOCKED.

## C4-03 explicit store-spelling expansion transitions

The two previously noted expansion paths now issue their own actual history:
`expand-initial-store-spelling` for the initial compound line becoming an ordinary
C AST assignment, and `expand-projected-store-spelling` for an actual compound
C AST node becoming the final Phase 8 assignment. The history distinguishes
the initial renderer, C AST producer and final projection instead of presenting
an earlier compound spelling as the current line. These records reuse the same
expression history/ledger and `observed-store-spelling-not-memory-equivalence`
label; original load/arithmetic/store origins remain present in both sets.

The initial expansion requires the private initial line/store observation. The
projected expansion additionally requires a private observation of the actual
C AST node, not just its semantic-expression descriptor or equal text. That
snapshot is taken by the producer and consumed before the owned projection
changes/clones the node. Caller copies, edited incoming text and replaced public
validators cannot issue a transition. Observation work shares the existing
cumulative edge allowance; the same consumer is not counted twice merely for
observing its node. Missing observations/record capacity are explicit incomplete
history, while the existing printed output remains unchanged. Existing recovery
and expression histories keep their own producer requirements.

Projection records join the existing rewrite history with actual line bindings
and survive ordinary replay once, without duplicate events. A copied published
history loses its replay binding. The asynchronous proof path can perform its
owned AST clone without mutating the original result and retain the spelling
event; a real independently proved scalar operand replacement inside a store
also retains it. Only that pure scalar operand is proved/adopted, not the memory
update or its spelling. Unresolved memory and mismatched address spaces continue
to be refused by the existing proof boundary.

Eight new tests plus the extended two existing producer-path matrices cover
40 direct C AST and 56 initial/public-pipeline cells (source/spelling cells, not
96 memory-equivalence theorems), actual IDs/reverse navigation, copied/edited
nodes, frozen observations, late callbacks, caps, replay, owned proof cloning,
real scalar adoption and explicit memory refusals. Positive proof fixtures now
declare their precise ordinary little-endian memory and matching address-space
identity; the default display fixtures retain unknown qualifiers. The negative
tests retain those original rejection cases. Typed legacy proof value IDs use
the existing `legacy-number:` contract, never a new identity namespace.

PR #3421 remains reused. PR #7814 at
`c0227beacfdf9ce753b822fb2598ac02524d4fc5` was inspected after the spelling-title
search: it addresses primitive integer parsing in scalar range evidence, not
rendered store spelling. It remains a relevant central-reconciliation candidate
owned by the parallel issue lane, alongside the previously inspected #7820;
neither issue fix is duplicated here. The actual owner inventory gains no new
path. All original 23 findings and the frozen135-binary denominator remain;
the wider C4-03 class audit, C4-04 proof gating and full integration acceptance
are not closed by this store-spelling chain. Acceptance remains LOCKED.

## C4-03 actual MOV operand-selection history

The existing expression builder now records `select-mov-operand` when it really
executes the MOV branch and selects `buildArg`'s result. The existing source
history, build frames/memo entries and private expression-consumer bindings carry
the MOV and input origins to actual return/store/load consumers. Equal input
ASTs, unrelated returns and copied public records cannot borrow the selection.
Precomputed constants bypassing that branch do not invent an unvisited event.
Value-mode and address-mode memo entries remain distinct; operand-width, shift
and extension behavior is unchanged. Canonical IR/SSA objects and output AST
semantics are not rewritten by this history addition.

The label `observed-mov-view-selection-not-equivalence` is deliberately limited
to the actual view selection. It does not independently prove copy elimination,
memory forwarding or changed-width equivalence. A copied unresolved load remains
a load with its original unknown qualifiers; its canonical source is not marked
elided. The selected-away MOV remains reachable through the existing reverse
navigation while canonical instructions remain intact.

Private input observation starts before recursive input construction can invoke
a symbol/type callback. Output observation and revalidation precede issuance;
later source edits, changed operand views, root/index replacement and getters
cannot replay the old producer. Record slots are reserved before recursion and
never refilled by failed observations or memo hits. Input/output observations
share the cumulative edge budget. Missing/cancelled/stale/capped history stays
explicitly incomplete without changing the legacy display selection.

Fourteen new tests cover sixteen direct/chained source-selection cells over
eight widths, nested/repeated consumers, three operand-view variants, unresolved
loads, separate address-mode use, precomputed bypass, copied and changed sources,
callback-time mutation, getter refusal, recursive last-slot reservation, degraded
mandatory fallback, projection replay and query staleness. These are not sixteen
new scalar or memory equivalence proofs. The exact ownership manifest adds only
the new MOV provenance test path; the canonical provenance runner discovers it.

The first exact substrate run exposed a deterministic public-pipeline interaction:
legacy stack recovery cloned unchanged composite expressions and attempted to
rebind the newly present MOV history as a stack recovery. Its full recovery
observation rejected the fixture's Set-valued dominators, leaving even a pure
scalar MOV replay incomplete. A new regression failed before the correction.
The no-op recovery traversal now preserves its original expression identity;
actual changed children still go through the existing stack-recovery observation
and width/barrier gates. Neither the data boundary nor timeout/assertion is
weakened. The regression exercises real scalar proof adoption, subsequent replay,
the MOV's rendered lineage and preservation of the original producer.

PR #3421 remains reused at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`.
Live MOV/C4-03/provenance searches found no separate matching MOV-history PR;
this is not an exhaustive proof of absence. The related query-boundary PR #7820
has moved to `0237e980e0d60940df8d98b6bcfc333f984b208d`; its current body/files
still describe the parallel issue lane's verdict/epoch fixes and remain a central
reconciliation candidate, not duplicated here. No component or main merge was
performed. All original23 findings, the remaining C4-03 class denominator,
C4-04 proof gating, C4-05 proof gaps, frozen135 compiler binaries and required
integration acceptance remain open. Acceptance stays LOCKED.

## C4-03 actual address-mode load selection

The existing address-mode `reachingStore` branch now issues
`select-address-load-store-operand` only when it actually selects the stored
operand. Its before-source preserves the load, selected store and stored input;
the existing build-history frame carries the event through the actual outer
load/return/store consumer. A separate value-mode read of the same load remains
a load and does not acquire this address-selection event. Precomputed constants,
missing reaching stores and the self-link guard do not invent unvisited events.

The private MOV selection observation is reused as a shared build-selection
observer, not a second provenance ledger. Exact canonical root/position checks
now cover related selected instructions as well as the primary value/definition.
Observation begins before recursive stored-operand construction; callbacks,
modified input views, copied nonmember stores, root replacement and getters
cannot attach old history to a new selection. MOV/address-load selections share
one pre-reserved bounded record allowance and the existing cumulative edge
budget. Failing history does not change the legacy branch's expression output.

The proof label is `observed-address-load-selection-not-memory-equivalence`.
This records the legacy view decision, not certified MemorySSA forwarding,
aliasing, atomicity or volatility. Canonical loads/stores and their original
unknown qualifiers are retained. The existing canonical numeric-forwarding gate
is unchanged; no structural reachingStore fact is promoted to its authority.

Twelve new tests cover eight width/source cells, selected-load/store reverse
navigation, nested MOV/repeated consumers, the full public compatibility path,
value/address separation, bypass cases, nonmember/copy/edit/getter refusal,
in-operand callback mutation, cumulative shared limits, mandatory fallback,
projection replay and stale query navigation. The ownership manifest adds only
the new address-load provenance test path. These are source-selection tests,
not eight independent memory-equivalence proofs.

PR #3421 remains reused at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`.
The live forwarding search identified #7738 at
`67f34e72254c60da9825ee2301c8b8f15d77cccf`; its body/files describe canonical
access-provider issuer checks in the parallel memory-issue lane, not this render
history. Preserve it as a central reconciliation candidate without duplicating
or importing its issue fix. Search results are not exhaustive absence proof.

Numeric load constants still require an upstream-producer audit: compatibility
projection can already set `load.dst.const`, bypassing the lower builder's
canonical-forwarding branch. That producer and precomputed-value history must
not be conflated with an observed address selection. General flag-condition
reconstruction and the complete rendered/removed class audit also remain open,
alongside C4-04 proof gating, C4-05 gaps, all original23 findings and frozen135
compiler binaries. No component/main merge occurred; acceptance stays LOCKED.

## C4-03 precomputed-value consumption history

The expression builder now records `select-precomputed-value` when it actually
selects a supplied integer/floating constant for a nonliteral definition. This
is a consumer event, not a guessed trace of upstream constant-folding passes.
Literal definitions and unvisited MOV/phi/address-load branches do not acquire
fictional events. The before-source retains declared operand, phi incoming and
address dependencies; the after-source is the actual selected constant. The
label `observed-precomputed-value-selection-not-equivalence` does not certify
the supplied value, which still belongs to C4-04 admission work.

The existing private build-selection observer now supports actual phi-list
membership as well as instruction-list membership. Dependency collection is
bounded to512values/250ms, selection slots share the existing pre-reserved
MOV/address-load allowance, and observations share the cumulative edge budget.
Missing/truncated history remains explicit. Canonical objects, scalar output,
widths and existing memory/solver gates are not changed by this bookkeeping.

Memory-derived constants only acquire additional contributing-store dependencies from a
currently valid canonical numeric MemorySSA fact and an unambiguous projected
source-entity mapping. The selected numeric constant must agree at its width
with that fact. An explicit exact fact whose proof is copied/invalid, values
mismatch, mappings are missing or floating-memory interpretation is unsupported
leaves that claimed source history incomplete; a structural
reachingStore cannot supply a numeric source certificate. Existing canonical
proof currentness is rechecked by the private history observation on later use.
Without an exact claim, the observed supplied constant and declared load/address
origins can still be recorded completely; no store roots or upstream computation
trace are invented. Provenance completeness is not semantic proof eligibility.
This covers real upstream compatibility constants that bypass the lower
builder's explicit numeric-forwarding branch, without inventing that branch's
execution or a new memory theorem.

Twelve new tests cover24bin/MOV/phi width/source cells, two floating widths and
four real canonical numeric-load widths, ordinary/public pipelines, replay,
declared dependencies and query reverse navigation, copied/changed facts and
contexts, changed constants/phi roots/getters, mismatched numeric values,
mandatory fallback, absent memory authority and bounded large dependencies.
The real memory fixture uses the existing canonical IR/CFG/MemorySSA/compatibility
chain from the C2-01 regressions, not a fabricated exact fact. Its callable
compatibility root properties are checked for identity separately from cloned
data, because functions are not structured-cloneable. Fallback assertions select
the actual rendered consumer record, not the first potentially unused history
copy. Public history copies lose projected bindings without revoking the original
private consumer itself. No expectation/timeout is relaxed for proof failures.

Related existing MOV proof tests had intermittent `deadline` refusals during
verification. Diagnostic assertion output now includes the actual refusal and
target decisions. A clean parent checkout and a later current-tree diagnostic
both passed; the diagnostic confirms this fixture produced zero new precomputed
history records. Those checks do not erase the failed receipts or prove the
timing issue fixed. Only subsequent exact-head gates can support this head.

PR #3421 remains reused at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`.
Constant/provenance search also identified #7550 at
`6ebaa3477c5e720d7bdf756c60a4a590bd254764`; current body/files describe the
parallel points-to constant-kind and query slice-identity issues, not this render
history. Keep it as a central reconciliation candidate, without duplicating its
fixes or treating its prose as verification. One new exact provenance test path
is added to ownership. No component/main merge occurred. Actual upstream folding
pass histories, general flag-condition
history and the full rendered/removed class audit remain open, as do all23
findings, C4-04/C4-05 work, frozen135compiler binaries and required integration
acceptance. Acceptance stays LOCKED.

## C4-03 explicit canonical numeric-load selection history

The lower LOAD builder branch now emits `select-canonical-load-constant` only
after the existing current canonical numeric-forwarding gate actually selects
the constant. The shared constant-selection source observer retains the load,
declared operands and uniquely mapped contributing-store sources using the same
private build frame, cumulative observation budget and pre-reserved selection
slots as precomputed/MOV/address-load history. No second ledger, issuer or
semantic identity is introduced. Existing canonical proof eligibility, numeric
output and memory facts are unchanged.

The event is labelled `observed-canonical-load-selection-not-new-memory-proof`:
it describes consumption of the existing proof, not a new theorem or an inferred
upstream pass. A precomputed load takes its own earlier branch and never acquires
this unvisited event. Later changed facts, contexts, source roots or store fields
invalidate private consumer bindings. Missing/ambiguous source projections and
exhausted history budgets remain incomplete even when scalar output is retained.

Seven additional tests in the existing precomputed-value history test file cover
four real canonical MemorySSA widths (8/16/32/64), public rendering/replay,
source-to-return query navigation and stale refusal, invalid/copied facts before
selection, source/context/private-consumer/public-history changes after selection,
fallback, record/edge/consumer/cancel bounds, ambiguous store projections and
non-executing getter refusal. The fixture clears only the compatibility-supplied
scalar constant and verifies that the existing independent canonical gate stays
valid, exercising the actual lower branch without fabricated proof authority.

PR #3421 remains the reused provenance foundation. Search also returned #7548
at `574683a98a59a5ecb1a79ba789a0f0f5789dac3d`; its inspected body and four
changed paths concern Phase 7 alias binary identity and escape-cache authority,
not this render-history consumer. Preserve it as a central reconciliation
candidate rather than duplicate those parallel issue fixes. No new ownership
path or component/main merge is added. This closes one observed producer gap,
not the full rendered/removed-class requirement or original23findings. General
upstream compatibility transforms, full C4-03 audit,
C4-04/C4-05 proofs, frozen135compiler corpus and required integration acceptance
remain open. Goal ACTIVE and integration acceptance LOCKED.

## C4-03 actual flag-condition reconstruction history

`compareFromFlags` now records `reconstruct-flag-condition` for each actually
visited CMP reconstruction, including the recursive previous comparison of a
conditional CMP. Existing NZCV expressions, unsupported intrinsic fallbacks,
operand widths, always-condition output and scalar/CFG eligibility are unchanged.
The evidence label `observed-flag-reconstruction-not-equivalence` describes a
display producer, not an independent flag, scalar, executed-path or CFG theorem.
Missing/non-CMP flag definitions and direct-value CBZ/TBZ branches do not invent
a reconstruction event.

Select-value construction carries these events in its existing build frame and
SSA consumer. General flag branches now own a separate actual visited build
frame: they consume buildArg, not expressionFor, and therefore cannot borrow or
overwrite a value's expressionProofs entry. The branch observer validates exact
canonical branch/value/list roots before and after construction, then the same
private expression-consumer binder admits the observed condition. Branch records
use valueId:null; no synthetic SSA identity or new public issuer is created.
The CMP producer reserves its transform slot before recursion; the additional
branch-root observation spends shared edges but is not another transform.

Thirteen new tests cover288builder source cells (four producers, eighteen
conditions, four widths), conditional CMP, selected values, distinct conditions
on one flag value, existing field-render producer handoff inside a condition,
public projection/replay, reverse query/staleness, unknown/
direct-value cases, copied records/descriptors and mutated sources/roots/getters,
malformed/ambiguous rendered conditions, fallback and nested/record/edge/consumer/
cancellation bounds. These are provenance cells, not hardware floating-width
coverage or288equivalence proofs. An initial bound assertion incorrectly counted
consumer ledger copies as new producer reservations; it now checks the actual
CMP producer count after the earlier MOV reservation. The failed receipt is
retained, and no production limit was increased to satisfy that test.

PR #3421 remains reused at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`.
The NZCV search found relevant parallel printing PR #7839 at
`497f81e22b5437af9f86d0ae292a243889d4b838`. Its body and complete three-file
diff were inspected: floating-domain comparison printing plus FCMP lt/le alias
handling, with a foundation regression. This is important central reconciliation
work, not evidence that current floating output is correct. No duplicate printing
fix or component merge is made here; this change only observes existing output.

One exact provenance-test ownership path is added. Full rendered/removed-class
coverage, upstream compatibility transformations, ordinary scalar proof admission,
memory/CFG/exception/UB/loop proofs, native/arbitrary-schedule requirements,
original23finding closure, frozen135compiler corpus and required exact integration
acceptance remain open. Goal ACTIVE; integration acceptance remains LOCKED.

## C4-03 actual compatibility stack LOAD-to-operand history

The existing canonical stack operand-identity path now describes each actual
LOAD-to-MOV compatibility operation at its mutation site. The owning projector
privately seals those descriptions only after instruction IDs, def-use links,
public-state normalization and final projection metadata have been assigned.
Calling the exported memory attachment helper or copying a description cannot
issue this finalization authority. The original projected memory-access object,
LOAD/address inputs, contributing STORE, forwarded SSA input and existing
canonical operand proof are retained without changing forwarding eligibility.

The decompiler consumes that privately observed transition in its actual build
frame and existing ledger as `project-stack-load-to-operand`, labelled
`observed-compat-memory-transition-not-new-proof`. It is distinct from the later
`select-mov-operand` display event and can be carried through a precomputed-value
consumer without inventing a second upstream operation. No semantic IDs or new
memory theorem are introduced. The original LOAD identity still links to its
canonical access; a return of the same stored input that never consumed the LOAD
does not inherit its history.

Finalized canonical instruction/value/block positions and root descriptors,
forwarded input/store/access/proof identity and mutable dependency data remain
bound. Later changes, public copies, getters, missing observation, post-projection
alias changes or exhausted bounds refuse complete history. A private expected-
transition marker survives deletion of public descriptive metadata, so removing
that metadata cannot turn a known stale operation into apparently complete
history. Observations are capped by the existing graph limits, transition
descriptions by1024, and downstream work uses the existing cumulative selection/
edge/consumer budgets without rescanning after exhaustion.

To reuse one observer without importing decompiler code into semantic projection,
the existing ownDataEntries and captureProjectionIrData implementations and
limits moved unchanged to `js/core/identity/live-data.js`. Their original solver
and Phase 8 entry points re-export the same function/limit objects. A byte-level
comparison against parent8e31ecf93 confirms the moved implementations are
unchanged. There is no new observer, serializer, proof engine or canonical memory
model. Exact ownership adds only this shared utility, the projector-finalization
file and the new provenance test; a regression rejects unreviewed sibling paths.

Eleven tests exercise the real canonical IR/CFG/MemorySSA/compatibility path at
four widths and both endiannesses (eight source cells, not new memory proofs),
public projection/replay, original STORE/address navigation and stale snapshots,
before/after-render mutations, actual position/root replacement, copied proofs/
descriptors, metadata removal, getters, unknown/atomic negatives, fallback,
resource bounds, exact shared utility identity/ownership and independent calls
to the attachment helper. The latter can perform a real operation but cannot
mint a projector-owned history record. Initial fixture failures compared an
input canonical object to its normalized projected copy by identity, and used
the wrong SSA reference spelling; they are corrected to the actual access
identity plus canonical content and existing `ssa:def:` format. Both failure
receipts are retained; production success criteria were not relaxed.

The precommit canonical `semantic-v2:test` run was RED, not a full-gate pass.
Its required-regression lane reported WebKit launch failure because
`libxslt.so.1` is unavailable; environment repair remains outside this task.
Separately, its userscript-sync lane detected this change's not-yet-generated
template (`f9c924414e2f67449b76be50`). The canonical build subsequently succeeded;
exact committed-head sync verification is still required before reporting that
generated-output failure resolved. Both full nested logs and the failed outer
receipt are retained in persistent evidence. Scoped passes do not replace the
red canonical gate, real-device evidence or full integration acceptance.

PR #3421 remains reused at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`.
Scoped operand-forwarding search found no matching implementation. Broader stack
operand search returned #7508 at `768b660bb0d215aa25fd1171c2b3df9a39f13c19`;
its inspected file inventory is string scanning, RISC-V ABI and structured-target
issue work, not this compatibility producer. Preserve parallel changes for
central reconciliation rather than duplicate them. No component/main merge or
printing/issue/performance/device/environment repair is made here.

Actual upstream constant-fold operations and state-alias/normalization handoffs,
the full rendered/removed-class audit, original23finding closure, C4-04/C4-05
proof requirements, frozen135compiler corpus and required exact integration
acceptance remain open. The current consumer history does not substitute for
those upstream operations. Goal ACTIVE and integration acceptance LOCKED.

## C4-03 actual compatibility constant writes and range handoff

Both existing compatibility constant-propagation loops now describe only actual
changes to `dst.const`, immediately before the existing write. Descriptions
retain original source/output/input objects, input constant/width facts, before
and after constants, stage, round and bounded operation ordinal. There is no new
evaluator, scalar/memory proof, semantic ID, forwarding decision or pass schedule.
The final owning projector seals those events with the existing finalized-root,
instruction/value-position and bounded plain-data observation. Calling exported
propagation/finalization helpers with copied data cannot register that authority.
Descriptions cap at 1024; skipped descriptions keep their real sources marked
unavailable rather than silently becoming unobserved.

The actual display build consumes the private events as
`fold-compatibility-constant` / `observed-compat-constant-write-not-equivalence`.
It follows recorded input definitions even when precomputed display skips their
expressions. Existing build frames, consumer bindings and ledger remain the only
route to rendered lines. Separate semantic-value consumers may have separate
ledger copies of one original operation; stage/round/ordinal do not invent new
executions. Existing budgets/cancellation still withhold complete mapping without
changing pseudocode. Unknown or unchanged values do not invent fold operations.

Canonical provenance testing exposed a real handoff requirement: the public IR
facade's existing range annotator changes `value.range` after projector sealing.
Temporary diagnostics located the first mismatch at that range write and were
removed. The six existing range helpers/annotator moved to the shared semantic
compatibility range module; the facade calls the same algorithm, with unchanged
range formulas and six-round limit. Only actual range writes publish a private,
bounded owner-bound chain. The original data observer still rejects any mutation
by default; its non-authoritative write-chain comparison is used only with those
privately issued range events and separately bound new range graphs. Manual
range edits, copied owners, interrupted chains, changed scalar facts and later
range-object mutation cannot authorize a successor. This is an observed handoff,
not an independent range theorem or a general public resealing API.

Seventeen new tests cover ten real stage/width source cells, seventeen scalar
operation fixtures, producer/copy/getter/budget boundaries, dependency histories,
public rendering/replay and range handoff/forgery/exhaustion. Existing canonical
MemorySSA tests now also check actual LOAD constant-write history at four widths.
The lower-load test deliberately clears a finalized constant: its lower numeric
selection remains observed, but its upstream history must now be incomplete and
query navigation refused. The positive query uses the unmodified canonical
projection and retains stale-snapshot rejection. Existing switch/runtime-omission
positive tests remain mandatory, not changed to accept the integration failure.

Retained red receipts include the initial semantic-consumer copy-count fixture
error, the old full-navigation assertion on a deliberately invalidated constant,
missing intrinsic-summary fixture metadata, and pre-handoff canonical failures.
No success criterion or production timeout was relaxed. Prior broad gate failures
at c0e0270fe remain recorded separately; scoped checks do not establish a full
repository, independent, compiler/device or current-main acceptance pass.

PR #3421 is reused at `4cd5b3eb9200b1180985b9df3a74f8245a5cc928`. Scoped
constant/provenance search also returned #7550 at
`6ebaa3477c5e720d7bdf756c60a4a590bd254764`; its inspected inventory/body concern
points-to constant authority and string-state cache identity, not this producer.
No duplicate implementation, component/main merge or parallel issue/performance/
environment repair was made. Other public-facade constant writes, state-alias and
normalization operations, full rendered/removed-class coverage, original findings
and C4-02/04/05 proof obligations remain open. Goal ACTIVE; acceptance LOCKED.

## C4-03 actual public-facade constant propagation

The existing `ir-core.js` `propagateExactLegacyConstants` pass now records its
actual constant writes, including constants newly available after canonical ABI
preserved-state restoration. The evaluator describes only values it actually
reads, retaining recursive input definitions, original constants/widths,
operation/literal facts and argument identities. Evaluating an intermediate is
not recorded as a write to that intermediate: its separate later write keeps
its own original operation ordinal. The arithmetic, pass order, width handling
and existing ABI recovery decisions are unchanged; this is not another evaluator
or an ABI/scalar equivalence proof.

Only the owning public-v2 facade seals these events after its existing
normalization sequence. Original inputs must remain compatible with the recorded
actual writes; source/output/dependency objects and instruction/value positions
are then observed by the same pure-data matcher used by the projector. That
matcher is now shared with the facade, but registers nothing and cannot attach
or reseal either issuer's histories. Both issuers keep private WeakMaps and
read-only access. The actual range annotator's existing private handoff applies;
arbitrary edits, getters, copied roots and later range mutations cannot preserve
authority. At most 1024 operation descriptions and 512 read values per operation
are retained. Exhaustion leaves actual sources expected-but-unavailable and does
not change their computed constants.

The existing expression consumer now follows both projector and facade records,
including recursively evaluated dependencies skipped by precomputed rendering.
Facade operations enter the same ledger as `fold-facade-constant` with proof kind
`observed-facade-constant-write-not-equivalence`. Consumers, budgets, cancellation,
replay and reverse mappings reuse the existing machinery; no semantic IDs or
parallel ledger are introduced. A valid facade record does not replace missing
projector history or prove the upstream ABI state-restoration operation.

The new canonical-discovered provenance file exercises the actual public build
path, fourteen arithmetic/native-width fixtures, original read/write ordering,
unknown/call-clobbered inputs, explicit legacy mode, copied/getter/stale inputs,
range handoff, public rendering/replay and budget/cancellation behavior. A
350-instruction arithmetic fixture exceeds 1024 actual facade writes and retains
all numeric outputs despite unavailable bounded observation. These fixtures are
not the frozen compiler-corpus denominator. Initial test failures came from an
incorrect block index and missing explicit return type in the test's public
facade call; tests now use the actual existing typed-return path, without
weakening provenance checks. A mistyped module-test command and the diagnostic
failures are retained in evidence; the actual module-boundary gate passes.

Live scoped constant/history PR search still resolves to this integration PR;
the previously reused #3421 remains OPEN at
`4cd5b3eb9200b1180985b9df3a74f8245a5cc928`. No component/main merge, duplicate
constant engine, issue/performance/device/environment repair or acceptance
promotion is made. State compaction, ABI/state/location/call/return normalization
histories and their owned handoffs remain open, as do complete removed/merged
coverage, original findings, C4-02/04/05 and required integration acceptance.
Goal ACTIVE; acceptance LOCKED.

## C4-03 actual state compaction and alias-edge history

`compactProjectedState` now describes its actual state-read, state-write-source
and state-write-address shadow operations and missing-source-state-key transfer.
The same existing resolver still chooses every replacement. Each actual changed
reference retains its original slot/value, selected value and actual earlier
alias-creating operations. Covered writer slots are instruction arguments,
condition values, address base/index, location base, incoming phi values and
locations-map bases. Transitive shortcuts preserve their earlier creating
operations, not merely the final value or a public shadow flag. Descriptions cap
at 1024 and causal/value traversal at 512; the extra alias-history index stores
only retained events. Exhaustion leaves expected/unavailable markers and does
not change state projection.

Only final owning projection seals these records. Changed identity fields and
actual selected references must still match the owned operations; final
instruction/value positions, original sources and slot objects are observed by
the shared bounded data matcher. Shared location-map entries are owner-bound.
The existing private range handoff applies. Public finalizer descriptions cannot
register authority on copied IR. Missing causal predecessors are rejected in
original operation order rather than recovered from metadata.

The existing expression-build machinery now consumes state operations alongside
projector/facade constant histories, including original inputs hidden by a
precomputed expression. Actual return/store/branch/flag consumers also retain
their own rewritten edges instead of borrowing history from the selected value.
The ledger uses `compact-public-state` with proof kind
`observed-state-compaction-not-equivalence`, existing origin IDs, consumer
bindings and cumulative budgets. Unrelated consumers cannot inherit an edge just
because they share its selected value. This is observed projection history, not
a new state, memory, scalar or CFG equivalence theorem.

The canonical provenance runner discovers the new state-compaction test file.
Tests cover four source widths, all seven writer slots, the three shadow classes,
state-key transfer and later unchanged version normalization, transitive alias
causes, original/selected values, private issuance/getter/copy/stale boundaries,
range handoff, core/public rendering, replay, query reverse navigation and stale
snapshot refusal, cancellation/budgets and mandatory representation fallback.
The unchanged parent finalizer and current finalizer additionally produce equal
complete fixture IR for four operation configurations with normal/exhausted
observation, including a repeated pass. These are synthetic operation checks,
not a replacement for compiler-corpus or independent-verifier requirements.

Retained diagnostic failures show an initial fixture incorrectly expecting a
canonical SSA read to take the separate local-physical-view path, and a query
fixture passing function-bearing IR instead of the existing cloneable rendered
result fields. The corrected tests exercise the actual local-state and query
paths; production admission was not relaxed. PR #3421 remains the reused
foundation. #7548 changes alias binary/cache identity, not this writer; #7097's
projector patch adds undefined-result-attribute admission, not state history.
Its oversized full diff was unavailable (HTTP 406); the per-file API supplied
the relevant patch. No component/main merge or parallel repair was performed.

The first committed state-history candidate, `755b02d73`, passed 15 of its 16
exact scoped gates but failed `decompiler:test`: the unchanged `damage` clamp
test lost its `max` rewrite because repeated history validation exhausted the
existing 250 ms pass budget. The isolated test also failed. A read-only runtime
overlay of the three changed files at parent `0b585a864` passed, and CPU profiling
identified repeated live-data matching. This is this addition's regression,
not a waived baseline failure or parallel performance task. All red receipts
and the failed runtime profile are retained.

The follow-up keeps the original whole-producer mutation checks and dependency
coverage. Canonical expression construction now holds operation records
privately, snapshots shared construction inputs before callbacks, and validates
each selected projector producer and each shared observation after all input
callbacks before those records can become rewrite proofs. Later consumers still
perform fresh checks. Source/output observations are separated so records sharing
one observation do not repeatedly scan it in the same synchronous validation.
Actual record slots remain individually reserved and cumulative edge budgets
still apply; no deadline, rewrite rule, oracle, or completeness rule is relaxed.
Candidate readers expose immutable issuer descriptions, not a current certificate
or a way to reseal copies. The attempted narrower per-source producer check was
rejected after an existing mutation regression failed; it is not in this change.

Three permanent regressions cover bounded producer-check counts without a
wall-clock assertion, mutation at every observed cancellation-callback boundary
(including earlier completed frames), and stale/copied candidate descriptions.
The check-count regression fails against the unchanged `755b02d73` runtime with
18 producer-root checks, and passes against the batched implementation with its
bound of 8. The unchanged isolated decompiler test and focused provenance tests
pass in the working tree. Final exact-head gates are required before push; these
working-tree results are not release or integration acceptance.

Unused-entry suppression, public-state ordering/version changes as explicit
operation classes, other facade normalization handoffs, and raw call/location
consumers without an existing observed expression remain open. Full C4-03 class
coverage, original findings, C4-02/04/05, compiler corpus and integration
acceptance are not closed. Goal ACTIVE; acceptance LOCKED.

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
| HEX-C4-03 | Navigation, expression/recovery/legacy-idiom, equal-incoming-phi, actual compatibility stack LOAD-to-MOV and MOV/address-load/precomputed-value/canonical-numeric-load selection, actual flag/conditional-CMP reconstruction and branch/select consumers, initial RMW/C AST compound-store histories, owned handoffs and explicit assignment-expansion records, successive projections, actual spill statement removal and initial runtime/stack display-omission history implemented; other view transforms and full removed/merged class coverage still open |
| HEX-C4-04 | Proof-gated scalar projection, owned inputs, transaction coverage and optional reuse of all 64 display rules as independently verified candidates implemented; ordinary legacy-view adoption, full family/width denominator and memory/CFG/exception observables remain open |
| HEX-C4-05 | Frozen 272-cell scalar/14-Bool/8-width producer coverage and 3 actual schedules (816 scalar cells); adopted-transform history now preserves actual rule/cost/budget/proof audits. Native proof gaps, arbitrary permutations and full acceptance remain open |
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
