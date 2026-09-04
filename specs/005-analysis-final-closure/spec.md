# Feature Specification: Recovery and Analysis Final Closure

**Feature Branch**: `recovery/final-closure-20260904`

**Created**: 2026-09-04

**Status**: Draft

**Input**: User description: "Recover all verified work from the 2026-09-04 handoff, merge and verify it on main, then reconcile and close every authoritative analysis-improvement finding with exact evidence."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recover without losing or duplicating work (Priority: P1)

As the repository owner, I need every item in the recovery handoff checked against live repository truth so completed work is reused, incomplete work is finished, and unrelated or untracked work is preserved.

**Why this priority**: All later analysis work depends on a sound and complete recovery base.

**Independent Test**: Audit every handoff row against current source, tests, commits, branches, and pull requests; then require a terminal classification and evidence for every row.

**Acceptance Scenarios**:

1. **Given** a handoff claim and a current repository state, **When** they disagree, **Then** current source, tests, and live remote state determine the classification.
2. **Given** completed work already present in main or a usable recovery commit, **When** recovery is performed, **Then** the work is reused without a second implementation.
3. **Given** dirty or untracked user work, **When** recovery work starts, **Then** that work remains untouched in its original workspace.

---

### User Story 2 - Integrate recovery as an exact proven product (Priority: P1)

As the repository owner, I need the complete recovery candidate integrated into current main only after all required correctness, scope, generated-output, review, and target-runtime evidence is bound to the exact candidate.

**Why this priority**: A green historical branch or isolated component does not prove the merged product.

**Independent Test**: Reconcile the candidate with live main, validate the candidate merge tree, merge through the required protected path, refetch main, and prove the accepted recovery commit is present.

**Acceptance Scenarios**:

1. **Given** a recovery candidate whose head or base changes, **When** evidence was produced for an earlier identity, **Then** affected evidence is stale and is rerun.
2. **Given** a required check, review finding, generated artifact, or runtime proof that is red, missing, incomplete, or unsuccessful, **When** merge readiness is evaluated, **Then** the merge remains blocked; documenting the failure does not convert it into passing evidence.
3. **Given** a merged recovery candidate, **When** live main is refetched, **Then** ancestry and post-merge smoke evidence confirm the recovered product is actually present.

---

### User Story 3 - Close the analysis-improvement roadmap (Priority: P1)

As the repository owner, I need every canonical analysis-improvement finding reconciled against the post-recovery main and every true residual requirement completed in dependency order.

**Why this priority**: The campaign is not complete while any authoritative promised item remains partial or unimplemented.

**Independent Test**: Inventory every canonical finding, prove its terminal disposition with current production wiring and tests, and require zero `PARTIAL` or `REMAINING` rows before final integration.

**Acceptance Scenarios**:

1. **Given** a historical roadmap item, **When** current production wiring and tests already satisfy it, **Then** it is recorded as completed or replaced with exact evidence and is not reimplemented.
2. **Given** an item with a real missing delta, **When** it is implemented, **Then** the smallest counterexample, conservative failure behavior, integration proof, and completion evidence are retained.
3. **Given** an item that cannot be completed from repository changes alone, **When** all safe alternatives are exhausted, **Then** it remains explicitly blocked with the external owner, evidence, and minimum unblocking action; the campaign is not called complete.

---

### User Story 4 - Preserve semantic and platform safety (Priority: P1)

As a Hex user, I need analysis improvements to increase justified precision without creating false exact facts, stale results, unsafe writer output, or desktop-only behavior that fails on the declared iPad/WebKit product.

**Why this priority**: A more precise-looking wrong result is a regression.

**Independent Test**: Exercise positive, negative, boundary, adversarial, cancellation, budget, deterministic, differential, and target-platform cases required by each changed subsystem.

**Acceptance Scenarios**:

1. **Given** incomplete, stale, cancelled, unsupported, or resource-limited evidence, **When** an exact fact is requested, **Then** the result remains explicitly uncertain.
2. **Given** a generated or rebuilt artifact, **When** publication is attempted, **Then** all required independent validity checks have executed successfully.
3. **Given** a browser/iPad-facing claim, **When** final completion is evaluated, **Then** exact-build target-device evidence is present and desktop simulation is not accepted as a substitute.

### Edge Cases

- Live main moves after local or CI evidence is captured.
- A recovery branch contains useful work plus stale or conflicting implementation.
- An open pull request overlaps only part of a recovered lane.
- A historical red test now fails for a different reason or has already been repaired.
- A generated artifact differs after canonical regeneration.
- A review status is green while unresolved actionable inline comments remain.
- A roadmap item is implemented but not connected to the production consumer.
- A result is precise on a positive fixture but unsafe under unknown memory, calls, aliases, identities, cancellation, or budgets.
- Required compiler, hardware, external service, or physical iPad evidence is unavailable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The campaign MUST resolve the canonical remote repository, live main identity, recovery handoff identity, branch state, pull requests, checks, reviews, and workspace state from current evidence.
- **FR-002**: The campaign MUST preserve the recovery branch and all unrelated dirty or untracked work until post-merge verification completes.
- **FR-003**: Every recovery handoff item MUST have an evidence-backed classification and a recorded implementation delta or reuse decision. During reconciliation the recovery vocabulary is exactly `DONE`, `PARTIAL`, `NOT STARTED`, `SUPERSEDED`, and `CONFLICTED`; only `DONE` and `SUPERSEDED` are terminal. `DONE` means the same requirement has current production wiring and tests; `SUPERSEDED` means a newer canonical mechanism achieves the same or stronger result with current production and test proof. Every row MUST be terminal before Stage A promotion.
- **FR-004**: Completed or superseded recovery work MUST NOT be reimplemented.
- **FR-005**: Every incomplete recovery item MUST be finished through the canonical semantic owner with a deterministic counterexample and conservative failure behavior.
- **FR-006**: Every required recovery-integration check MUST be present, completed, and successful on the exact candidate head and applicable candidate merge tree. Any missing, cancelled, skipped, timed-out, neutral, or failed required check remains blocking even when its cause is explained. Actionable review findings MUST be zero, generated artifacts MUST be canonical, and failure explanations may document only the blocked state.
- **FR-007**: Recovery MUST be merged through repository protection rules and verified on refetched live main before analysis-roadmap implementation begins.
- **FR-008**: The analysis roadmap MUST be inventoried completely from the post-recovery main, including later addenda and canonical replacement requirements.
- **FR-009**: Every roadmap finding MUST be classified only as `DONE`, `PARTIAL`, `REMAINING`, `REPLACED`, `OBSOLETE`, or `BLOCKED`, with production source, wiring, test, specification, and dependency evidence. Baseline `DONE`, `REPLACED`, or `OBSOLETE` maps to durable `COMPLETE_EXISTING`; a campaign-integrated result maps to `MERGED`; and roadmap `BLOCKED` is reserved for an external dependency and maps to `BLOCKED_BY_DEPENDENCY`. A concurrent owner does not make a roadmap requirement externally `BLOCKED`: the roadmap row remains `PARTIAL`/`REMAINING`, while its campaign task temporarily maps to `BLOCKED_BY_CONCURRENT_WORK` until the owner is reconciled, adopted, or completed.
- **FR-010**: Every `PARTIAL` or `REMAINING` finding MUST become an owned task and MUST reach a terminal evidence-backed disposition.
- **FR-011**: The final authoritative roadmap MUST contain zero `PARTIAL`, zero `REMAINING`, zero `BLOCKED`, no unchecked promised item, and no unsupported completion statement.
- **FR-012**: Analysis changes MUST preserve a single canonical truth from binary input through query and user-facing projections.
- **FR-013**: The campaign MUST record exactly one mandatory terminal evidence record for each of `falseExactNoAlias`, `falseExactMustAlias`, `falseExactIndirectTarget`, `falseExactType`, `semanticMismatch`, `stalePublicationAfterCancel`, and `invalidWriterOutputAccepted`. Each record MUST have value zero, a positive safe-integer denominator, a positive observed-sample count, and exact command, locked corpus, fixture-set, and candidate identities. Missing, duplicate, non-terminal, zero-denominator, zero-sample, identity-stale, or aggregate-only records MUST NOT satisfy this requirement.
- **FR-014**: Unknown, partial, unsupported, timeout, cancellation, stale identity, resource-limit, malformed-input, bounds-violation, and non-converged outcomes MUST become a structured rejection or explicit conservative result and MUST NOT authorize exact publication, transformation, or artifact acceptance.
- **FR-015**: Hostile-input bounds, checked arithmetic, cancellation, allocation limits, parser limits, symbolic limits, and plugin/provider isolation MUST remain enforced.
- **FR-016**: Generated outputs MUST be produced only by the integration owner from the reconciled combined tree, and a second canonical generation MUST produce zero diff.
- **FR-017**: Every meaningful candidate and final merge MUST use current-base candidate-tree proof and evidence bound to exact source, verifier, corpus, toolchain, runtime, and artifact identities as applicable.
- **FR-018**: Any repeated process failure discovered during the campaign MUST gain a permanent automated regression where technically possible.
- **FR-019**: Browser/iPad-facing completion MUST include the required production-faithful WebKit and physical iPad evidence bound to the exact build.
- **FR-020**: The final merged main MUST be refetched, smoke-tested, and documented with exact implementation and verification evidence for every major recovery and roadmap item.
- **FR-021**: A target-runtime gate is applicable when a changed source or generated input is reachable from the browser, worker, userscript, storage, runtime-provider, or UI product graph, or when the repository guardrails name that gate for the phase; an applicable physical-iPad gate MUST NOT be replaced by desktop emulation.
- **FR-022**: If post-merge verification fails, the campaign MUST preserve the failed exact-product evidence, stop dependent work, and use a repository-approved corrective pull request or recovery procedure; it MUST NOT force-rewrite main or silently continue Stage B.
- **FR-023**: Campaign pull requests MUST mean only pull requests opened, adopted, or explicitly linked by this campaign in its task ledger; unrelated issue-work pull requests MUST remain outside lifecycle mutation and final open-campaign counts.
- **FR-024**: Roadmap dispositions MUST map to the constitution's durable ledger: current pre-existing proof maps to `COMPLETE_EXISTING`, campaign-integrated proof maps to `MERGED`, and external or concurrent blocks map to the corresponding blocking state. A roadmap label MUST NOT hide an incomplete durable state.
- **FR-025**: Performance acceptance MUST use the existing frozen profile or lock-file thresholds and exact fixture/build/device identities; the campaign MUST NOT move a baseline merely to accept a regression.
- **FR-026**: The canonical roadmap ID set MUST be exactly `HEX-C0-01`, `HEX-ME-01`, `HEX-C1-01`, `HEX-C1-02`, `HEX-C1-03`, `HEX-C2-01`, `HEX-C2-02`, `HEX-C3-01`, `HEX-C3-02`, `HEX-C3-03`, `HEX-C4-01`, `HEX-C4-02`, `HEX-C4-03`, `HEX-C4-04`, `HEX-C4-05`, `HEX-SYM-01`, `HEX-SYM-02`, `HEX-SYM-03`, `HEX-X-01`, `HEX-X-02`, `HEX-X-03`, `HEX-S2-01`, and `HEX-S2-02`; these are the literal IDs used by `docs/解析ツール改善.md.txt`, the reconciliation matrix, and task applicability predicates, and no row may be silently normalized, added, omitted, or merged.
- **FR-027**: Every CodeRabbit thread or comment on a campaign pull request MUST be recorded by comment ID and classified as `ACTIONABLE`, `ALREADY_FIXED`, `FALSE_POSITIVE`, or `OUT_OF_SCOPE`; non-actionable classifications require technical evidence, and both unclassified and unresolved actionable counts MUST be zero for promotion.
- **FR-028**: All linked worktrees, local and remote recovery refs, and open pull-request heads MUST be inventoried. Except for the living integration worktree, they are read-only and MUST NOT be checked out for mutation, rebased, committed, deleted, or force-updated by this campaign.
- **FR-029**: Generic IR, CFG, SSA, and MemorySSA MUST remain architecture-neutral; instruction semantics belong to MachineEffects; ABI placement and layout belong to the ABI/type providers; every transform MUST preserve origin, provenance, and invalidation dependencies; and runtime evidence MUST NOT overwrite static truth.
- **FR-030**: External evidence MUST record, as applicable, compiler family/version/target/optimization, native oracle version or executable hash, service capability/schema version, active deployment commit/build identity, and physical iPad model/iPadOS/WebKit/build identity. Presence alone is not capability proof.
- **FR-031**: Before reusing an existing focused feature specification, the campaign MUST record its revision, canonical producer, all production consumers, current tests, and any contract drift; reuse is allowed only when those surfaces remain consistent.
- **FR-032**: After each Stage A and Stage B merge, the campaign MUST record candidate head, candidate merge tree, accepted merge commit, refetched main SHA, ancestry result, post-merge smoke evidence, and document updates. Stage B MUST NOT start until the complete Stage A record exists.
- **FR-033**: A partially useful recovered change MUST be reduced to independently reviewed minimal commits or hunks. A `CONFLICTED` row MUST preserve its source reference while the canonical owner resolves the first incorrect boundary; merging the stale branch as a whole is forbidden.
- **FR-034**: Before each performance implementation or promotion, the task MUST name the governing profile or lock path, metric, unit, comparison operator, threshold, denominator, and exact fixture/build/device identity. Current shared authorities include `tests/benchmark-baseline.json`, `tools/validation/{phase6,phase7,phase8,phase9,phase10,phase11,competitive}/profile.json`, `tools/validation/stage2/profile-denominators.lock.json`, and `specs/005-analysis-final-closure/contracts/{performance-locks,final-platform-locks}.json`. P-FINAL MUST contain a machine-readable required row for every H9 workload class, with numeric targets, cache policy, repetitions, baseline, runtime class, and fixture identity. A required P-FINAL row that is absent, unmeasured, identity-invalid, or lacks a numeric target MUST block T040 and campaign completion.

### Key Entities

- **Recovery item**: One handoff obligation, its recovered commits, current implementation state, tests, risk, and terminal evidence.
- **Roadmap finding**: One canonical analysis-improvement requirement, dependencies, current proof, missing delta, and terminal disposition.
- **Candidate identity**: The exact head, tree, live-main base, candidate merge tree, and generated/runtime identities that evidence proves.
- **Merge identity record**: Four non-interchangeable identities: candidate head SHA, candidate merge-tree SHA, accepted merge-commit SHA, and refetched live-main SHA.
- **Evidence record**: A bounded record of the requirement, counterexample, implementation, tests, review, verifier, corpus, toolchain, platform, and merge result.
- **External blocker**: A requirement that repository changes cannot satisfy, with owner, attempted alternatives, evidence, and minimum unblocking action.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of recovery handoff items have a terminal evidence-backed classification, and incomplete recovery items equal zero.
- **SC-002**: The recovery candidate is present in refetched live main; every required check for the exact accepted product was present, completed, and successful; and actionable review findings equal zero. An explained failed, skipped, cancelled, timed-out, neutral, or missing check does not satisfy this criterion.
- **SC-003**: 100% of canonical analysis-roadmap findings have a terminal evidence-backed disposition; `PARTIAL + REMAINING + BLOCKED = 0`.
- **SC-004**: Each named FR-013 counter has exactly one terminal identity-bound record with value zero, positive denominator, positive observed-sample count, and exact command, locked corpus, fixture-set, and candidate identities on every required evidence surface.
- **SC-005**: Required focused, subsystem, full, verifier, generated-output, benchmark, browser, runtime, and target-device gates pass on the exact final candidate and affected candidate merge tree.
- **SC-006**: The final roadmap, specification, task ledger, capability claims, and production behavior agree, with zero stale promised item.
- **SC-007**: Live main contains the final accepted product and has zero open campaign pull requests and zero unresolved in-scope blocker before the campaign is reported complete.
- **SC-008**: Every applicable performance gate meets its predeclared frozen threshold with the same denominator and exact fixture/build/device identity, or the campaign remains incomplete with the measured regression recorded.

## Assumptions

- The live Git remote and repository protection settings remain the authority for names, heads, and merge method.
- Existing recovered commits and completed feature specifications are reused after verification.
- Current source, production wiring, tests, and machine-readable capability truth outrank historical roadmap prose.
- External proof that cannot be produced in this environment remains a real blocker unless an authorized external runner supplies identity-bound evidence; it is never replaced by a weaker proxy.
- Concurrent unrelated issue work is not mutated by this campaign and is treated as an overlap constraint when it touches owned paths.
- A pull request is a campaign pull request only after its exact number and ownership role are recorded in `tasks.md`; discovery of an unrelated open pull request does not make it campaign-owned.
