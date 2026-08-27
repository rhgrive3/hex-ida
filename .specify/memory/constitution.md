<!--
Sync Impact Report
- Version change: uninitialized template -> 1.0.0
- Modified principles: none; this is the initial project constitution
- Added sections: Core Principles, Engineering Constraints, Delivery Workflow, Governance
- Removed sections: none
- Deferred items: none
-->
# Hex Engineering Constitution

## Core Principles

### I. One Canonical Semantic Truth

Production analysis MUST have one canonical owner for each semantic fact. Machine effects,
Semantic IR, CFG, SSA, MemorySSA, alias and points-to facts, summaries, type and value facts,
decompiler projections, and query surfaces MUST form an explicit producer-to-consumer chain.
Consumers MUST NOT create private semantic engines or heuristic fallbacks to compensate for
missing upstream facts. Generic analysis MUST remain architecture-neutral; target-specific truth
belongs in the target-owned producer. Every published fact MUST carry deterministic identity,
provenance, and the dependency information needed for invalidation.

### II. Uncertainty Is Explicit and False Certainty Blocks Release

Unknown, partial, unsupported, truncated, cancelled, provider-unavailable, resource-limited,
stale, and non-converged states MUST remain explicit. They MUST NOT be promoted to exact facts or
hidden by confidence scores. A false `NoAlias`, false `MustAlias`, false exact indirect target,
false exact type, semantic mismatch, or stale publication is a release blocker. Missing or
incomplete evidence MUST fail closed. Denominator shrinking, allowlist broadening, test deletion,
assertion weakening, or converting unsupported behavior into exact behavior is prohibited.

### III. Deterministic Proof Before Promotion

Every technically testable behavior change MUST begin with the smallest deterministic
counterexample and MUST prove the pre-change failure before production implementation. Promotion
requires positive, negative, boundary, malformed-input, cancellation, budget, deterministic-replay,
and downstream-consumer evidence where applicable. Repeated process failures MUST gain a permanent
automated regression when technically possible. Competitor output, implementation self-agreement,
or a generated artifact produced by the system under test MUST NOT serve as independent ground
truth.

### IV. Bounded, Cancellable, Portable Analysis

All potentially expensive analysis MUST have deterministic work and memory bounds, support
cancellation where control can return, and degrade conservatively when a limit is reached.
Unbounded traversal, uncontrolled expression growth, mandatory heavyweight solving on the browser
fast path, and avoidable quadratic rescans are prohibited. Architecture decisions involving
browsers, workers, tabs, storage, JIT, native tooling, or background execution MUST be proven on
the named target platform. iOS, iPadOS, and WebKit constraints are first-class release inputs.

### V. Exact Product and Integration Proof

Only evidence bound to the exact head or exact candidate merge tree is valid for release. Required
proof MUST bind source SHA, base relationship, verifier identity, corpus identity, toolchain or
runtime identity, and generated artifact identity where applicable. Generated outputs are a
transaction: only the assigned integration owner commits them, canonical regeneration MUST be
repeatable, and a second generation MUST produce zero diff. Source merge does not prove runtime
activation. Moving `main` MUST be reconciled through one living integration owner, and the merged
product MUST be refetched and verified on live `main`.

## Engineering Constraints

- `docs/ENGINEERING_PROCESS_GUARDRAILS.md` is merge-blocking and defines the minimum phase,
  component, candidate-tree, generated-output, verifier, cutover, and target-device evidence.
- Ownership MUST be machine-readable where feasible and checked against the actual changed-file
  inventory. A lane MUST remain inert outside its declared files and MUST complete every required
  site inside them.
- Concurrent Issue-resolution agents are a separate workstream. Research-finding work MUST NOT
  triage or modify their Issues, branches, pull requests, labels, assignments, CI, or lifecycle.
  Overlap MUST be avoided or recorded as `BLOCKED_BY_CONCURRENT_WORK`.
- Alias, points-to, summary, value, type, decompiler, symbolic, native rebuild, and language
  metadata work MUST preserve canonical ownership and explicit completeness semantics.
- Optional solvers, native providers, metadata providers, and remote services MUST expose versioned
  capability identity. Presence or availability alone is not proof of semantic capability.
- Rebuild and generated-output acceptance MUST use an independent parser or verifier when the
  release contract requires independent proof. Producer success is not consumer validity.
- Secrets, privileged bootstrap, migration, destructive behavior, and diagnostic modes require
  explicit authority or opt-in; capability detection is not consent.

## Delivery Workflow

Every non-trivial research finding MUST use this lifecycle before production promotion:

1. Refetch live `main`, record its exact SHA, and inspect concurrent pull requests only for
   ownership collision.
2. Classify current production behavior and record the first deterministic divergence, canonical
   owner, dependencies, consumers, generated surfaces, and verifier path in the durable ledger.
3. Execute Spec Kit in order: constitution check, specify, clarify, repository graph trace, plan,
   checklist, tasks, analyze, implement, and converge.
4. Do not edit production code while specification analysis has unresolved contradictions,
   ownership gaps, dependencies, acceptance criteria, or concurrent-work collisions.
5. Execute tasks through one implementation owner per semantic contract. Parallel work is limited
   to disjoint, explicitly owned task IDs and files.
6. Run proportionate T0 through T2 validation during implementation. At the stable candidate, run
   applicable T3 proof, canonical artifact generation, exact-head CI, independent verification,
   and candidate merge-tree validation.
7. Reconcile current `main`, review the final actual diff against the ownership allowlist, merge
   with expected-head protection, refetch live `main`, and verify the merged product.
8. Update the durable finding ledger after every externally visible transition and merge. A finding
   is complete only as `COMPLETE_EXISTING`, `MERGED`, `BLOCKED_BY_DEPENDENCY`, or
   `BLOCKED_BY_CONCURRENT_WORK`; partial work remains partial.

Spec Kit convergence proves implementation completeness only. It does not replace current-main,
CI, candidate-tree, generated-output, verifier, target-device, merge, or post-merge proof.

## Governance

This constitution governs all feature specifications, plans, tasks, implementation reviews, and
release decisions in this repository. `docs/ENGINEERING_PROCESS_GUARDRAILS.md` supplies additional
normative process rules; when an ad-hoc instruction is weaker, the stronger safety requirement
applies.

Amendments require a documented reason, a Sync Impact Report, semantic versioning, and review of
affected templates and active specifications. MAJOR versions remove or redefine a principle,
MINOR versions add or materially expand governance, and PATCH versions clarify without changing
meaning. Every pull request MUST demonstrate constitutional compliance for its actual diff. Any
unresolved MUST-level violation blocks merge.

**Version**: 1.0.0 | **Ratified**: 2026-08-27 | **Last Amended**: 2026-08-27
