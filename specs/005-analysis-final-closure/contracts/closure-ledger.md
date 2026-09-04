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
exactly one nonempty `forbiddenOverlap` array for every task ID. Missing or
duplicate IDs, an empty array, or a concurrent write matching a forbidden entry
blocks implementation and promotion. Sequential reuse of a path is allowed only
after its dependency owner has completed and handed off the exact tree identity.

## Candidate promotion

The integration owner MUST record the exact head, tree, refetched base, candidate
merge tree, verifier and corpus identities, toolchain/runtime identities, and
generated artifact identities. Required evidence for a different identity is
invalid. Candidate promotion requires:

- zero unexplained required failures;
- zero false exact aliases, targets, types, semantic results, stale publications,
  or accepted invalid writer outputs on locked corpora;
- canonical generation followed by a second zero-diff generation;
- all exact-head and candidate-merge-tree checks green;
- every CodeRabbit comment classified, with actionable comments repaired and
  regression-tested;
- active-runtime and physical-device proof where the affected release contract
  requires them;
- no unresolved ownership collision or merge conflict.

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
