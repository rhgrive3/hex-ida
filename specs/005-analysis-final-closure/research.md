# Phase 0 Research: Recovery and Analysis Final Closure

## R-001 Canonical repository identity

**Decision**: Use the live `origin` remote as repository authority. Preflight
resolved `https://github.com/rhgrive3/hex-ida.git`; `rhgrive3/ida-245` is not used.

**Rationale**: Historical documents contain both names. The user and repository
guardrails require current remote truth.

**Rejected**: Inferring the repository name from the workspace directory or an old
handoff URL.

## R-002 Recovery source and reuse boundary

**Decision**: Treat `docs/recovery-handoff-20260904.md` at recovery head
`84d277a962515031c1bcc4eba0dca4c44c41f0b7` as the inventory source, then verify
every row against current main, local/remote recovered refs, source, wiring, tests,
open pull requests, and checks.

**Rationale**: The handoff explicitly distinguishes preserved snapshots from
accepted production. Its statuses are historical evidence.

**Rejected**: Merging the documentation-only handoff branch or any recovered lane
wholesale without inspecting its current delta.

## R-003 Roadmap authority

**Decision**: Inventory the 23 findings in `docs/解析ツール改善.md.txt`, including
its addendum, and reconcile them with the newer architecture, finding ledger,
feature specifications, production consumers, tests, and live repository state.

**Rationale**: The roadmap records promised outcomes, while current production and
machine-verifiable evidence determine implementation truth.

**Rejected**: Using unchecked boxes as proof that work is missing, or using old
"implemented" prose without production wiring and test evidence.

## R-004 Existing feature-spec reuse

**Decision**: Reuse the existing focused Spec Kit packages for loaded-pointer
recovery, return-pointer summaries, byte-exact MemorySSA, wrapped intervals and
congruence, ABI aggregate/prototype unification, versioned language metadata, and
recursive type recovery. This campaign specification coordinates integration and
closure; it does not duplicate their semantic contracts.

**Rationale**: The constitution requires one owner and prohibits duplicate
implementations.

**Rejected**: Creating a second feature spec or semantic engine for each roadmap
label solely because its historical checkbox is open.

## R-005 Evidence and moving-main policy

**Decision**: Bind promotion evidence to the complete candidate identity in
`contracts/closure-ledger.md`. A change to head, base, merge tree, verifier,
corpus, toolchain, runtime, deployment, or generated artifact invalidates the
affected evidence.

**Rationale**: Green evidence for an old head is not proof of the current product.

**Rejected**: Reusing component-head CI for a different integration tree or
accepting source merge as runtime activation proof.

## R-006 Test and output policy

**Decision**: Use the repository's current package scripts as command authority,
with focused T0/T1 work, subsystem T2 runs, and the canonical quiet wrapper for
T3. Only the integration owner regenerates combined userscript/deployment or other
generated outputs and proves a second generation is clean.

**Rationale**: Quiet output preserves test semantics while keeping complete logs;
central generation prevents mixed-source identities.

**Rejected**: Replacing canonical denominators with a smaller proxy or manually
editing generated identity files.

## R-007 Platform completion

**Decision**: Browser-facing completion requires production-faithful WebKit and,
where the guardrail applies, physical iPad evidence for the exact build. Desktop
Playwright and API presence are useful lower-tier evidence but not a substitute.

**Rationale**: Worker, storage, isolation, memory-pressure, viewport, and
cancellation behavior can differ on the declared product target.

**Rejected**: Relabeling desktop simulation as target-device proof.

## R-008 Graft applicability

**Decision**: Use the repository's prebuilt Graft graph as the first repository
context source for this campaign after the user explicitly authorized it and the
active runtime instructions identified this worktree as indexed. Do not install
or upgrade Graft as part of the campaign.

**Rationale**: The later explicit authorization supersedes the earlier
environment-default prohibition for this session. Graft remains an efficient
context graph only; exact source, Git identities, tests, and independent
verifiers retain semantic and release authority.

**Rejected**: Treating Graft summaries as implementation or release proof, or
upgrading the globally installed tool during a live candidate campaign.

## R-009 Workspace and branch safety

**Decision**: Preserve the original workspace and its untracked `transcripts/`.
Use `/teamspace/studios/this_studio/ida-245-recovery-final` as the clean living
integration worktree. Keep the recovery ref until Stage A post-merge proof.

**Rationale**: This avoids destructive cleanup and retains recovery evidence.

**Rejected**: Resetting the original workspace, deleting untracked files, force
rewriting recovery, or force pushing main.

## R-010 Authority ordering for conflicts

**Decision**: Apply, in descending force, the live remote/protection state,
repository constitution and engineering guardrails, accepted architecture and
machine-readable contracts, current production source/wiring/tests, active Spec
Kit artifacts, and finally historical handoff/roadmap prose.

**Rationale**: This preserves current executable truth without erasing promised
requirements.

**Rejected**: Letting any worker report, old PR description, old SHA, recognizer,
or AI prose act as semantic or release authority.

## R-011 External evidence identity

**Decision**: Bind compiler evidence to family/version/target/optimization, native
oracles to version or executable hash, services to capability/schema version,
runtime proof to active deployment commit/build, and device proof to iPad model,
iPadOS, WebKit, and exact build identity.

**Rationale**: Availability or a same-address observation is not proof that the
named capability or product executed.

**Rejected**: Tool-presence checks, desktop emulation, or source SHA alone as a
substitute for active runtime/device proof.

## R-012 H9 browser/iPad performance targets

**Decision**: Freeze the fourteen required H9 workload rows in
`contracts/final-platform-locks.json` before their collector is implemented.
The historical baseline remains honestly `UNMEASURED_AT_FREEZE` where
`tests/benchmark-baseline.json` has no valid measurement; it never satisfies a
candidate target. The targets are predeclared product service limits: 250 ms
cancellation settlement, 50 ms scheduler quantum, the existing 120 ms Phase 8
optimization ceiling, 15 s cold/3 s warm end-to-end TTFUA, bounded range work,
and a 768 MiB process-footprint ceiling on an actively supported physical iPad
with at most 4 GiB RAM. Current 64/256 KiB page sizes, 8/16 MiB cache bounds,
the locked real fixture hashes, and the 2 GiB logical-source generator define
the work denominators. Exact candidate measurements must cover both
production-faithful WebKit and the physical-iPad class.

**Rationale**: H9 forbids completing from functional checks while latency,
memory, cache/reopen, cancellation, or TTFUA remains unmeasured. Freezing
targets now prevents a later implementation or regression fix from moving its
own acceptance line. A first measurement that misses remains a defect, not a
reason to weaken the profile.

**Rejected**: Treating `gate: none` as a waiver, inventing a measured historical
baseline, using Chromium or a simulated user agent for iPad proof, or changing
the target in the same change that attempts to satisfy it.

## R-013 Rolling checkpoint publication lineage

**Decision**: Treat each living-integration checkpoint as the immutable
`I_i → M_i → G_i → E_i` transaction. `M_i` is the exact two-parent candidate
merge of integration parent `I_i` and component handoff `C_i`; `G_i` is its
single-parent generated/reconciled product child; `E_i` is the single-parent
evidence-only publication child. Generation, rolling-gate, and shadow-verifier
evidence must be recomputed from exact `G_i` Git blobs and exact command results.

**Rationale**: A row assembled from separate merge, generated, and evidence
commits can attest a product that never existed. The closure ledger already
defines the four identities; T046 documentation must state the same invariant
before component fanout.

**Rejected**: Conflating `M_i` and `G_i` as one `integrationProduct`, accepting
arbitrary hash-shaped evidence, or treating a verifier's self-report as an
independent oracle.

## R-014 Immutable task-handoff anchor

**Decision**: Bind `acceptedTaskId` to the exact handoff head/tree and derive the
canonical T046/T025 anchor from the unique transition in the full reachable Git
DAG where the task is `DONE` and no parent is `DONE`. Every reachable descendant
must remain `DONE`. The current mutable integration inventory is an observation
to validate, not an authority that can rewrite the historical anchor.

**Rationale**: Otherwise a compromised or later-edited inventory can relabel a
component or rewrite the evidence source after the task was accepted.

**Rejected**: Accepting the latest inventory entry, a mutable branch tip,
first-parent-only history that can hide the real transition behind a reversed
merge, or a worker's prose as the canonical handoff identity.

## R-015 Recovery-fetch and path-decoding isolation

**Decision**: Fetch recovery authority only into a dedicated scratch ref and
protect the canonical recovery tracking ref and unrelated refs with a
transaction snapshot. Git changed-path decoding is fail-closed: invalid UTF-8,
leading BOM, and control-byte paths are rejected rather than normalized into an
allowlist path.

**Rationale**: A recovery fetch must not silently rewrite the evidence used to
prove preservation, and byte-level path ambiguity can bypass ownership checks.

**Rejected**: Force-updating `refs/remotes/origin/wip/recovery-handoff-20260904`,
globally freezing or mutating unrelated refs, stripping a BOM, or replacing
invalid bytes before ownership validation.

## R-016 Moving-main and product reconciliation

**Decision**: A later checkpoint input is either the preceding evidence commit
unchanged (`mainReconciliation.mode = NOOP`) or an exact ordered two-parent merge
of that commit with refetched current main (`EXACT_MERGE`). Conflict-free merge
tree output is independently recomputed and any adjustment is restricted to its
explicit allowlist. Separately, every non-generated `M_i -> G_i` edit is listed
exactly in a T049/T050-owned `integrationReconciliation` manifest.

**Rationale**: Requiring `I_i === E_(i-1)` forever deadlocks a correctly moving
main, while allowing an opaque reconciliation commit lets source or evidence
changes bypass the component and publication contracts. Distinct manifests
keep main reconciliation, component acceptance, generation, and evidence
publication independently auditable.

**Rejected**: Stale-main reuse, reversed merge parents, a reconciliation
cherry-pick, hidden conflict resolution, component paths in `G_i`, or shared
contract edits smuggled into `E_i`.

## R-017 Observed rolling and fixed shadow evidence

**Decision**: Rolling evidence v2 is produced only by executing every registry
argv for the cumulative accepted-task set and capturing the exact
candidate/registry identity, exit status, signal, spawn error, output-limit
state, and per-invocation stdout/stderr byte digests. Runtime verification
repeats those commands on detached exact `G_i` and compares stable process
semantics while retaining each output digest as an audit receipt. Shadow proof
uses one registry-fixed central verifier and pinned foundation contracts outside
component ownership. It executes an independent oracle projection and an
exact-candidate product projection separately; providers emit only raw
observations, and the central verifier derives the case relation, denominators,
all seven hard-zero counters, verdict, and evidence identity. For each required
counter, the foundation contract must contain an explicit non-empty case mapping;
the derived denominator must be a positive safe integer; and the completed
checkpoint must contain terminal shadow evidence for that counter with observed
failures exactly zero. Aggregate `PASS` is invalid when any counter is missing,
unmapped, non-terminal, zero-denominator, or nonzero. Candidate and authority
identities are separate: the authority is the component candidate's exact first
parent or `G_i`'s exact sole `M_i` parent, never the candidate itself; authority
foundation/judge blobs must equal the candidate blobs. Exact-G lockfiles
provision dependencies, whose installed tree is checked with typed,
length-framed hashing. Process invariants cover all persistent refs and a fixed
runtime-ephemeral allowlist.

**Rationale**: A constructor that emits `PASS` without process observations, a
component-selected verifier/oracle, one task-owned process supplying both sides,
or a vacuous zero-denominator counter is self-certification. Bounded output
identities preserve an audit trail without treating nondeterministic reporter
timing as semantics.

**Rejected**: Truthy status fields, output text that merely says `PASS`,
registry/argv substitution, missing or zero-denominator counters, non-terminal
counter records, worktree-only providers, live-host dependency symlinks,
unbounded output, undeclared runtime files, or mutations to stash, notes, and
custom refs.
