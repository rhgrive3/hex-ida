# Feature Specification: Loaded-Pointer Recovery

**Feature Branch**: `research-close/integration`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "Close HEX-C1-01 MemorySSA-backed loaded-pointer recovery on CURRENT live main without unrelated Issue work."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recover a Proven Loaded Pointer (Priority: P1)

An analyst examining a pointer stored to memory and loaded later receives the same finite target
set and provenance that were already proven for the stored pointer when one complete, current,
byte-exact reaching-store proof exists.

**Why this priority**: This closes the current `unresolved-load` precision boundary and improves
alias, indirect-target, type, and decompiler consumers without creating a second memory truth.

**Independent Test**: A deterministic function stores a pointer to a known object, reloads it at
the same compatible width, and uses the result. The loaded value resolves to the stored pointer's
target and offset with its provenance preserved.

**Acceptance Scenarios**:

1. **Given** one complete and current reaching store that exactly covers the loaded pointer bytes,
   **When** the loaded pointer is analyzed, **Then** its finite target set equals the stored
   pointer's proven finite target set.
2. **Given** a stored pointer to a known field offset, **When** the pointer is loaded through exact
   memory evidence, **Then** the target offset, width, root identity, and provenance are preserved.
3. **Given** two identical runs over the same analysis snapshot, **When** results are compared,
   **Then** the pointer result, proof identity, completeness, and diagnostics are identical.

---

### User Story 2 - Keep Unproven Loads Unresolved (Priority: P1)

An analyst never receives a precise pointer target when any required alias, byte coverage,
provenance, freshness, completeness, or resource proof is absent.

**Why this priority**: A false precise pointer can produce false `NoAlias`, false indirect targets,
and false types; those outcomes are release blockers.

**Independent Test**: Each unsafe boundary is varied one at a time. Every case remains explicitly
unresolved and no downstream consumer receives an exact target.

**Acceptance Scenarios**:

1. **Given** only MayAlias or unknown alias evidence, **When** the pointer is loaded, **Then** the
   result remains explicitly unresolved.
2. **Given** a partial overlap, incompatible width, or byte-order reconstruction that is not fully
   proven, **When** the pointer is loaded, **Then** the result remains explicitly unresolved.
3. **Given** an intervening unknown clobber, incomplete call, volatile/atomic uncertainty, stale
   analysis, truncated analysis, cancellation, resource limit, or unsupported reconstruction,
   **When** the pointer is loaded, **Then** the result remains explicitly unresolved with the
   applicable conservative state retained.
4. **Given** a stored scalar or pointer whose provenance is missing or incompatible, **When** it is
   reloaded as a pointer, **Then** no precise points-to target is published.

---

### User Story 3 - Preserve Canonical Ownership and Consumers (Priority: P2)

Downstream alias, indirect-target, type, query, and decompiler consumers observe the improved
canonical points-to fact through their existing interfaces and do not introduce private load
recovery logic.

**Why this priority**: Precision is useful only when it reaches existing consumers while preserving
one semantic source of truth and invalidation behavior.

**Independent Test**: One downstream consumer resolves the recovered pointer, while the same
consumer remains conservative for a matching negative case. A repository search and ownership
check finds no second reaching-definition implementation or unrelated Issue change.

**Acceptance Scenarios**:

1. **Given** a proven loaded pointer used by an existing downstream consumer, **When** that consumer
   queries canonical analysis, **Then** it receives the recovered target without special-case
   heuristics.
2. **Given** an unproven loaded pointer, **When** the same consumer queries canonical analysis,
   **Then** it receives the existing unresolved behavior.

### Edge Cases

- Multiple reaching stores that agree in value but lack one complete exact proof remain unresolved.
- Phi or loop-carried memory definitions remain unresolved unless the canonical memory fact proves
  one exact compatible stored pointer without non-convergence.
- Zero-width, non-integer, malformed, oversized, or mixed-endian access metadata is rejected or
  remains unresolved; it never produces a precise target.
- A valid proof from another snapshot, function, semantic version, or invalidated dependency is
  stale and cannot be reused.
- An exact store of a pointer-sized value does not authorize recovery when its root identity or
  provenance cannot be validated.
- Budget exhaustion and cancellation preserve deterministic conservative publication and do not
  leak partially staged precision.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST keep the existing canonical memory and points-to analyses as the only
  authorities for reaching memory definitions and pointer targets.
- **FR-002**: The system MUST recover a finite loaded-pointer target set only from one current,
  complete reaching-definition proof with exact alias authority equivalent to MustAlias.
- **FR-003**: The system MUST require complete compatible coverage of every loaded pointer byte,
  including pointer width and byte order, before publishing a recovered target.
- **FR-004**: The recovered result MUST preserve the stored pointer's target identity, offset,
  pointer width, root identity, provenance, snapshot identity, and completeness.
- **FR-005**: MayAlias, unknown alias, partial overlap without complete reconstruction proof,
  incompatible width, incompatible provenance, unknown clobber, incomplete call, volatile/atomic
  uncertainty, stale analysis, truncation, cancellation, resource exhaustion, and unsupported
  reconstruction MUST NOT produce a precise target.
- **FR-006**: Every refusal MUST remain explicit through the existing unresolved, partial,
  unsupported, truncated, cancelled, stale, or resource-limited state applicable to the failure.
- **FR-007**: The recovery process MUST terminate under deterministic work and state bounds and MUST
  honor cancellation without publishing partially staged precision.
- **FR-008**: Equivalent inputs and analysis identities MUST produce byte-for-byte deterministic
  result and proof identities.
- **FR-009**: Existing downstream consumers MUST receive recovered targets through the canonical
  points-to result and MUST retain conservative behavior for every negative case.
- **FR-010**: The behavior MUST be architecture-neutral and MUST NOT infer provenance from names,
  strings, rendered output, confidence, or target-specific heuristics in generic analysis.
- **FR-011**: The change MUST add deterministic positive, negative, boundary, malformed-input,
  cancellation, budget, stale-identity, and downstream-consumer regressions without shrinking any
  existing denominator or weakening any assertion.
- **FR-012**: The actual change inventory MUST contain only HEX-C1-01 specification, analysis,
  owned tests/verifiers, and integration-owned generated artifacts; unrelated Issue work is
  prohibited.

### Key Entities

- **Loaded-pointer request**: The pointer-typed load, its width, byte order, function, snapshot, and
  source semantic identity.
- **Reaching-definition proof**: The current memory fact that identifies alias authority, exact byte
  coverage, source store, clobber history, completeness, and proof provenance.
- **Stored pointer fact**: The finite target set, root and offset identities, pointer width,
  provenance, and completeness associated with the value written by the reaching store.
- **Recovered points-to result**: The canonical finite target result or explicit conservative state
  published to existing consumers.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All locked positive store-pointer/load-pointer cases recover exactly the expected
  target set, offsets, widths, identities, and provenance.
- **SC-002**: Every locked MayAlias, unknown-clobber, incomplete-call, partial-byte, incompatible-
  width, incompatible-provenance, stale, truncated, cancelled, resource-limited, malformed, and
  unsupported case publishes zero precise targets.
- **SC-003**: The focused corpus records zero false `NoAlias`, zero false `MustAlias`, zero false
  exact indirect targets, zero stale publications, and zero semantic mismatches.
- **SC-004**: Replaying every focused case twice produces zero result, diagnostic, completeness, or
  proof-identity divergences.
- **SC-005**: At least one existing downstream consumer demonstrates improved precision on the
  positive case and unchanged conservative behavior on its paired negative case.
- **SC-006**: Cancellation and every deterministic budget limit terminate within the declared work
  bound and publish no partial precise pointer result.
- **SC-007**: All pre-existing focused denominators, cases, and assertion strengths are unchanged or
  increased; none are removed, skipped, or broadened to pass.
- **SC-008**: Actual changed-file ownership, exact-head validation, candidate merge-tree proof,
  required CI, expected-head merge, and post-merge live-main verification all pass for one exact
  product identity.

## Assumptions

- Provenance-backed roots, canonical MemorySSA, pass lifecycle/invalidation, and current points-to
  ownership are already present on live main and remain non-regression prerequisites.
- The first production increment forwards only one fully covered stored pointer. General multi-
  store byte reconstruction belongs to HEX-C2-01 unless current repository wiring proves it is
  inseparable from safe C1-01 closure.
- Missing evidence has a reasonable conservative default: retain the existing unresolved result.
- No open pull request currently overlaps the finding. Collision will be rechecked before merge.
