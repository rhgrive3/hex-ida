# Closure Ledger Contract

## Recovery row

Each recovery row MUST include:

```text
ID | Handoff item | Current implementation | Commit evidence | Current tests |
Status | Incomplete delta | Required action | Owner/model | Risk | Exit proof
```

Status is exactly one of `DONE`, `PARTIAL`, `NOT STARTED`, `SUPERSEDED`, or
`CONFLICTED`. Handoff prose alone cannot produce `DONE`. `DONE` proves the same
requirement; `SUPERSEDED` proves an equal-or-stronger canonical mechanism. Partial
reuse is limited to independently reviewed minimal commits/hunks. Conflict
resolution preserves the source ref and occurs at the first incorrect canonical
boundary; the stale branch is never merged wholesale.

## Roadmap row

Each of the 23 roadmap findings MUST include:

```text
ID | Requirement | Current status | Source proof | Test proof | Spec proof |
Owner subsystem | Missing delta | Dependencies | Risk | Assigned model |
Required exit gate
```

Status is exactly one of `DONE`, `PARTIAL`, `REMAINING`, `REPLACED`, `OBSOLETE`,
or `BLOCKED`. `REPLACED` requires a stronger canonical mechanism that achieves the
same goal. `OBSOLETE` requires accepted architectural evidence. `BLOCKED` requires
an external dependency that repository changes cannot supply and maps only to
`BLOCKED_BY_DEPENDENCY`. Concurrent ownership is recorded on the campaign task as
`BLOCKED_BY_CONCURRENT_WORK`; it leaves the roadmap row `PARTIAL`/`REMAINING`
until reconciliation and cannot be used as an external-block disposition.

The fixed roadmap set is:

```text
HEX-C0-01 HEX-ME-01 HEX-C1-01 HEX-C1-02 HEX-C1-03 HEX-C2-01
HEX-C2-02 HEX-C3-01 HEX-C3-02 HEX-C3-03 HEX-C4-01 HEX-C4-02
HEX-C4-03 HEX-C4-04 HEX-C4-05 HEX-SYM-01 HEX-SYM-02 HEX-SYM-03
HEX-X-01 HEX-X-02 HEX-X-03 HEX-S2-01 HEX-S2-02
```

These are literal identifiers. Consumers MUST NOT add or remove the `HEX-`
prefix or otherwise normalize them when checking exact 23-row coverage.

## Implementation promotion

A production delta may enter an integration candidate only when all are true:

1. Its minimal counterexample failed before the implementation or is accompanied
   by an independently justified historical failing artifact.
2. The change occurs at the first incorrect canonical producer/consumer boundary.
3. Positive, negative, boundary, adversarial, cancellation, budget, replay, and
   downstream tests applicable to the change pass.
4. The actual changed paths match ownership and contain no duplicate semantic
   engine or generated-output mutation by a component worker.
5. A high-risk semantic change has independent Sol review and Supervisor diff/test
   verification.

`task-ownership.json` is the machine-readable authority for item 4. It contains
exactly one nonempty `allowedPaths` array and one nonempty `forbiddenOverlap`
array for every task ID. Missing or duplicate IDs, either empty array, or a
concurrent write matching a forbidden entry blocks implementation and promotion.
The exact actual changed-path inventory in `integration-inventory.json` MUST be
validated against the recorded base-to-candidate diff: its expected, actual, and
union path sets and entry paths are duplicate-free and exactly equal, and every
actual path matches its owner's `allowedPaths` and no owner's
applicable `forbiddenOverlap` rule is violated. Sequential reuse of a path is allowed only after its
dependency owner has completed and handed off the exact tree identity.

The same ownership contract contains the candidate-gate registry. Every frozen
implementation component (`T011`–`T017`, `T051`–`T057`, `T026`–`T036`, and `T045`) and every
applicable T058+ task has nonempty `owned`, `rolling`, and `shadow` command
arrays. Commands are structured argv and execute directly without a shell on
the detached synthetic candidate merge commit. The governing registry is read
from the exact living-integration parent so a component cannot approve a weaker
gate set in its own change. A missing, unsafe, skipped, or red command blocks
component acceptance.

After T048 is `DONE`, Stage B component applicability comes only from the
machine-readable residual-coverage packet bound to the current base, canonical
T025 handoff, exact roadmap matrix, all 23 findings, and all candidate tasks.
Packet statuses must equal the parsed statuses in the exact matrix bytes; a
recomputed hash over contradictory packet claims is invalid. The verifier hashes
the raw matrix blob at the T025 handoff commit as well as the current bytes, so a
post-handoff replacement plus a recomputed packet is invalid. Until T048 reaches
`DONE`, component admission is closed and the Stage B inventory remains the
exact T047 three-path PREFANOUT set.
T025's handoff is independently recovered from the unique full-reachable-DAG
transition where T025 is `DONE` and no parent is `DONE`; all reachable
descendants must retain `DONE`. Rewriting the mutable inventory to a later
matrix-bearing ancestor, hiding the transition behind a reversed-parent merge,
or creating a parallel transition is invalid even when all current byte hashes
agree.
`implementationAction: IMPLEMENT` and `RECONCILE_OWNER` enter the checkpoint
set, but only `IMPLEMENT` may open a campaign-owned component lane. A valid
`NO_EDIT`/`COMPLETE_EXISTING` task is DONE without an implementation handoff or
checkpoint; an adopted concurrent-owner result still requires its exact handoff
and checkpoint, while external-block dispositions remain non-admissible and
must carry the exact external owner, repository limitation, attempted
alternatives, evidence, and minimum unblock action.
Missing, stale, duplicate, unknown, or status-inconsistent
coverage blocks all component admission rather than reverting to the frozen
task-number range.

## Candidate promotion

The integration owner MUST record the exact head, tree, refetched base, candidate
merge tree, verifier and corpus identities, toolchain/runtime identities, and
generated artifact identities. Required evidence for a different identity is
invalid. Candidate promotion requires:

- zero unexplained required failures;
- zero `falseExactNoAlias`, `falseExactMustAlias`,
  `falseExactIndirectTarget`, `falseExactType`, `semanticMismatch`,
  `stalePublicationAfterCancel`, and `invalidWriterOutputAccepted`; every
  counter separately binds its producing command, locked corpus identity,
  denominator, and exact candidate identity;
- canonical generation followed by a second zero-diff generation;
- all exact-head and candidate-merge-tree checks green;
- every CodeRabbit comment classified, with actionable comments repaired and
  regression-tested;
- active-runtime and physical-device proof where the affected release contract
  requires them;
- no unresolved ownership collision or merge conflict.

### Integration checkpoint transaction (§3.4)

Between component promotions, T049 (Stage A) or T050 (Stage B) MUST advance one
and only one checkpoint transaction. The transaction is an append-only Git
chain, not a claim assembled from unrelated commits:

```text
I_i -> M_i -> G_i -> E_i
          ^       ^
          |       |
          C_i     evidence-only child
```

The roles and parent/tree rules are fixed:

| Identity | Required role and proof |
|---|---|
| `I_i` | The exact living-integration head immediately before accepting the component. For the first checkpoint it is the unique full-DAG canonical T046 first-DONE transition. Thereafter it is either the previous `E_(i-1)` (`mainReconciliation.mode = NOOP`) or the exact two-parent reconciliation merge of that `E_(i-1)` with the refetched current main (`EXACT_MERGE`). No single-parent replay, cherry-pick, reversed parents, hidden conflict edit, or stale main identity is permitted. |
| `C_i` | The immutable exact component head recorded by `taskHandoffs[acceptedTaskId]`. Its resolved commit and tree MUST equal that handoff's `headSha` and `treeSha`; it is never replaced by a mutable branch tip or a worker's prose. |
| `M_i` | The exact candidate merge commit with exactly two parents, first `I_i` and second `C_i`. Its tree MUST equal the independently computed `candidateMergeTreeSha`; a component head or a hand-authored product commit cannot substitute for this merge. |
| `G_i` | A single-parent child of `M_i` produced by the integration owner from the reconciled combined tree. Every non-generated `M_i -> G_i` path MUST appear exactly once in `integrationReconciliation.paths`, be owned by T049/T050, and exclude component/publication paths. Its tree includes the governed generated paths `js/userscript/deployment-identity.generated.js`, `userscript/hex.user.template.js`, and `userscript/release-version.json`. The canonical generator MUST run twice against this product and the second run MUST have zero tracked diff. |
| `E_i` | A single-parent evidence-only child of `G_i`. Its parent MUST be `G_i`, and its diff MUST be limited to the exact stage allowlist: Stage A `contracts/integration-inventory.json`, `evidence/stage-a-checkpoints.md`, and `tasks.md`; Stage B uses the corresponding `stage-b-checkpoints.md` path. It MUST NOT alter source, tests, generated output, or the product tree. |

Each row MUST record `integrationParentSha` (`I_i`), `componentHeadSha`
(`C_i`), `candidateMergeTreeSha`, `acceptedMerge` (`M_i` commit/tree), and
`checkpointProduct` (`G_i` commit/tree), in addition to the accepted task, gate,
generation, verifier, and inventory evidence. `E_i` is deliberately not a row
field: the row is published inside the evidence-only `E_i` commit, so recording
that commit's own SHA in the row would be self-referential. The verifier derives
the exact historical `E_i` from the checkpoint evidence path and commit ancestry;
the next row's `integrationParentSha` fixes it as the next `I`. `acceptedMerge`
and `checkpointProduct` are distinct identities; the old ambiguous notion of one
`integrationProduct` MUST NOT conflate them.

Every row MUST also carry `mainReconciliation` and
`integrationReconciliation`. `mainReconciliation` records the prior immutable
evidence SHA, exact refetched main, mode, `I_i` commit/tree, independently
computed merge tree when applicable, and the exact allowlisted adjustment-path
set. `integrationReconciliation` records `M_i`, `G_i`, its T049/T050 owner, and
the exact non-generated path set/count/digest. Both manifests are recomputed
from Git parents, trees, and diffs; their recorded values are not authority.

Generation evidence MUST be content-derived from the exact `G_i` tree: record
the canonical command, generator blob identity, generated-output blob identities,
release/build identity, and both clean-run results. At runtime verification, the
verifier MUST detach the exact `G_i` tree, install dependencies from that
tree's exact lockfile, load the exact frozen gate registry, rerun the canonical
generator twice with a zero tracked diff, and rerun every registered rolling
and shadow argv for every task accepted through row `i` against that same
`G_i` head/tree. Rolling
evidence uses `hex-final-closure-checkpoint-rolling-evidence/v2` and MUST bind
the exact registry Git blob, registered and executed argv, child exit/signal/
spawn-error/output-limit state, and byte length plus SHA-256 of stdout and
stderr for every gate. `PASS` is derived only from those captured observations.
Each invocation retains its bounded output hashes as an audit receipt; replay
compares the stable registry, argv, candidate, process, and status contract and
does not mistake reporter timing bytes for semantics.
Shadow evidence uses the registry-pinned central verifier and foundation
contracts outside every component allowlist. The verifier executes an
independently owned oracle projection and an exact-candidate product projection
as separate bounded processes. Providers may emit canonical raw observations
only; the central verifier derives observation hashes, dispositions,
denominators, all seven counters, verdict, and evidence identity. A denominator
counts only cases explicitly tagged for that counter, and terminal aggregate
proof requires nonzero coverage for all seven. The evidence binds a distinct
governing parent (the component candidate's first parent or `G_i`'s sole `M_i`
parent), its foundation/judge blobs, and the candidate blobs; self-authority is
invalid. A component
cannot select or modify either provider, contract, comparison rule, proof
schema, or denominator through its report. The verifier MUST recompute all
identities from pinned Git blobs/content and exact command results; stored
reports are not runtime proof. Arbitrary hash-shaped strings, copied identities,
truthy status fields, two observations supplied by one task-owned process, or a
verifier report that merely certifies its own input are invalid evidence.

Process isolation is also part of the checkpoint. Ref snapshots cover every
persistent `refs/**` namespace, including stash, notes, and custom refs. Runtime
replay rejects tracked mutation and any untracked/ignored path outside the
fixed ephemeral roots `.runtime-build`, `dist`, and `node_modules`; the allowed
ephemeral manifest must remain identity-equal after it is established. The
installed dependency tree is hashed with typed, length-framed records and MUST
remain exact after every process; a live-host `node_modules` symlink is not
historical checkpoint evidence.

`E_i` is the durable publication point for the row. Historical rows MUST be
replayed from their exact `M_i -> G_i -> E_i` ancestry; changing any identity or
content invalidates that row and every dependent checkpoint. A second component
merge is invalid while the prior `E_i` is absent, stale, incomplete, red, or
not the next integration parent.

### FR-013 hard-zero counters

FR-013 MUST be recorded as seven separate counter records; an aggregate
`FR-013 = 0` claim is insufficient. Every record below MUST carry its own
observed value `0`, exact producing command, exact corpus identity, exact
denominator, and exact `CandidateIdentity` binding (including the applicable
head/tree/base/merge-tree identities). A value or binding inherited only by
reference to another row is not valid.

| Counter | Required value | Required per-counter binding |
|---|---:|---|
| `falseExactNoAlias` | `0` | exact command, corpus identity, denominator, and candidate identity |
| `falseExactMustAlias` | `0` | exact command, corpus identity, denominator, and candidate identity |
| `falseExactIndirectTarget` | `0` | exact command, corpus identity, denominator, and candidate identity |
| `falseExactType` | `0` | exact command, corpus identity, denominator, and candidate identity |
| `semanticMismatch` | `0` | exact command, corpus identity, denominator, and candidate identity |
| `stalePublicationAfterCancel` | `0` | exact command, corpus identity, denominator, and candidate identity |
| `invalidWriterOutputAccepted` | `0` | exact command, corpus identity, denominator, and candidate identity |

Each CodeRabbit record contains its comment/thread ID, one of `ACTIONABLE`,
`ALREADY_FIXED`, `FALSE_POSITIVE`, or `OUT_OF_SCOPE`, and technical evidence for
every non-actionable disposition. Unclassified count and unresolved actionable
count must both be zero.

## Merge and post-merge promotion

Merge MUST use repository protection and expected-head semantics. After merge,
the integration owner MUST refetch `origin/main`, prove accepted-commit ancestry,
and run the required smoke suite on main. Stage B may start only after Stage A has
recorded its candidate head, candidate merge tree, accepted merge commit, refetched
main SHA, ancestry result, smoke evidence, and document updates. Final closure
additionally requires roadmap `PARTIAL + REMAINING + BLOCKED = 0`, no open
campaign PR, and final roadmap/spec/evidence agreement.

## Frozen performance evidence

`performance-locks.json` is the machine-readable implementation-time authority
for P-SYM01, P-EGRAPH, P-SYMMEM, and P-TAINT. It freezes each governing fixture
ID/version/digest and every blocking metric, unit, operator, and numeric
threshold before production implementation. Changing a descriptor, corpus,
threshold, or identity algorithm invalidates earlier evidence and requires a
new reviewed planning revision; implementation tasks cannot silently move it.

### SYM-01

The P-SYM01 performance/resource lock applies to an exact 32-bit and 64-bit SAT
query pair plus the complete feasible 1–8-bit differential denominator. On the
same candidate head/tree and canonical query/provider identities, all counts
must meet these inclusive ceilings:

| Metric | Unit | Operator | Threshold |
|---|---|---|---:|
| CNF variables | count | `<=` | 400000 |
| CNF clauses | count | `<=` | 1600000 |
| Solver decisions | count | `<=` | 500000 |
| Solver propagations | count | `<=` | 8000000 |

Startup/solve elapsed milliseconds and heap/RSS byte deltas are observational:
they must be finite and non-negative but do not authorize exact proof or release.
The exact query descriptors/digests, 1–8-bit generator source hashes, generator
version, per-width cardinalities, and 14,622-query/29,244-backend-result
denominator are frozen in `performance-locks.json`. Evidence binds the candidate
head/tree, query digests, provider capability
fingerprint, browser build, and, at release, physical iPad model/iPadOS/WebKit
and deployed build identity. T032 is the sole migration decision owner and
migrates this lock into the canonical Phase 9 profile if and only if T025
classifies `HEX-SYM-01` as `PARTIAL` or `REMAINING`. It records old/new profile
identities, invalidates old evidence, and reruns the revised profile; every other
roadmap disposition records a no-migration or blocking decision explicitly.

### Final browser/iPad workload budget

`final-platform-locks.json` freezes all fourteen H9 workload rows, the ten-member
real/synthetic fixture set, two required runtime classes, cache and repetition
policies, numeric latency/read-work/memory/cancellation targets, and measurement
protocol. A required row that is missing, unmeasured on the exact candidate,
identity-invalid, lacks a numeric target, or misses a target blocks release. The
legacy `gate: none` entries in `tests/benchmark-baseline.json` document missing
historical measurement; they do not waive P-FINAL. Desktop or simulated evidence
cannot satisfy the physical-iPad runtime class.

## Conservative semantic publication

Exact pointer/value/type/target publication requires complete proof from canonical
provenance and dependencies. Unknown stores/calls, MayAlias, incomplete indirect
callees, partial byte coverage, stale summaries, unsupported operations, timeouts,
cancellation, resource limits, provider absence, and non-convergence remain
explicit uncertainty and cannot authorize an exact result.

Generic IR/CFG/SSA/MemorySSA remains architecture-neutral. MachineEffects owns
instruction semantics; ABI/type providers own ABI placement/layout; transforms
retain provenance and invalidation dependencies; runtime evidence never overwrites
static truth. Malformed input, bounds violations, and non-convergence produce a
structured rejection or explicit unknown, not exact publication.
