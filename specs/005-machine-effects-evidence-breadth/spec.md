# Feature Specification: MachineEffects Independent Evidence Breadth

**Feature Branch**: `feat/hex-me-01-phase2`
**Created**: 2026-08-31
**Status**: In progress
**Input**: Complete HEX-ME-01 Phase 2 without promoting incomplete architectural, relaxed-memory, or undefined-result evidence to exact truth.

## User Scenarios & Testing

### User Story 1 - Audit architectural evidence independently (Priority: P1)

As a release reviewer, I need each MachineEffects claim bound to a named specification or formal model, architecture/profile/version, effect identity, observable set, freshness, and completeness so self-agreement cannot prove correctness.

**Independent Test**: Submit valid complete evidence and stale, wrong-profile, unsupported-version, malformed, and incomplete-observable variants. Only the complete identity-consistent artifact may authorize an exact claim.

**Acceptance Scenarios**:

1. **Given** a pinned formal or architectural artifact, **When** it is validated, **Then** every authority, model, profile, version, effect, observable, and digest identity is retained.
2. **Given** partial or stale evidence, **When** a subject claims exactness, **Then** the claim remains partial or blocking.
3. **Given** profiles without a suitable formal oracle, **When** inventory is reported, **Then** they remain explicit unsupported gaps rather than borrowing another profile's authority.

### User Story 2 - Preserve relaxed-memory boundaries (Priority: P1)

As a semantic consumer, I need relaxed, acquire, release, acq-rel, seq-cst, and unknown orderings compared against declared permitted/forbidden outcome sets without strengthening or weakening them.

**Independent Test**: Validate a frozen outcome-universe matrix and negative variants for unknown ordering, atomic/non-atomic mismatch, malformed ordering, unsupported combinations, incomplete outcome universes, and profile drift.

**Acceptance Scenarios**:

1. **Given** a complete ordering artifact, **When** Hex reports an ordering, **Then** it matches the proven ordering and outcome boundary exactly.
2. **Given** unknown or incomplete ordering evidence, **When** evaluated, **Then** no known ordering or exact allowed-outcome claim is minted.
3. **Given** atomic/non-atomic mismatch or malformed ordering, **When** validated, **Then** the artifact is rejected with zero pass contribution.

### User Story 3 - Keep undefined bits unknowable end to end (Priority: P1)

As a downstream analysis consumer, I need fully, conditionally, partially, and operand-dependently undefined results to retain their mask and exceptional-condition identity from MachineEffects through Semantic IR V2 and optimization.

**Independent Test**: Lower synthetic canonical operations for every undefined class, mutate or drop the mask at each boundary, and prove exact constant publication is blocked whenever any result bit is undefined.

**Acceptance Scenarios**:

1. **Given** a partial undefined-bit mask, **When** the operation is lowered, **Then** the same width, mask, class, reason, and condition are present in Semantic IR V2.
2. **Given** a fully or conditionally undefined result, **When** an optimizer sees concrete inputs, **Then** it cannot publish an exact constant for the affected value.
3. **Given** divide-by-zero, signed-overflow, shift-width, unsupported-form, or unknown-effect evidence, **When** proof is incomplete, **Then** named unknown/partial/unsupported state is preserved.

### Edge Cases

- Known, undefined, implementation-defined, and unobserved observable sets overlap or fail to cover the declared set.
- A model commit is syntactically valid but not the commit pinned by the profile.
- A complete artifact omits one permitted or forbidden outcome from its declared universe.
- `unknown` ordering is paired with an exact outcome universe.
- A non-atomic access carries a non-unknown ordering.
- An undefined mask is zero, wider than its result, or attached to a non-result operation.
- A partial result reaches a legacy projection or optimizer that does not understand masks.

## Requirements

### Functional Requirements

- **FR-001**: Evidence MUST record source/specification identity, architecture, profile, version, instruction/effect identity, relevant observables, known/undefined/implementation-defined/unobserved partitions, freshness, and completeness.
- **FR-002**: Exact authorization MUST require complete evidence, a complete observable partition, current identities, and a profile/version match.
- **FR-003**: Stale, malformed, wrong-profile, unsupported-version, partial, unknown, or incomplete-observable evidence MUST contribute zero exact passes.
- **FR-004**: Formal/model output MUST remain offline and version-pinned; no formal runtime may be embedded in browser production code.
- **FR-005**: The ordering contract MUST cover relaxed, acquire, release, acq-rel, seq-cst, and unknown, and distinguish permitted from forbidden outcomes.
- **FR-006**: Unknown ordering MUST never be strengthened; incomplete ordering evidence MUST never authorize exactness.
- **FR-007**: Atomic/non-atomic mismatch, malformed ordering, unsupported combinations, incomplete outcome universes, and architecture/profile drift MUST fail closed.
- **FR-008**: Canonical MachineEffects MUST represent fully, conditionally, partially, and operand-dependently undefined result bits with width, mask, class, reason, and named condition where applicable.
- **FR-009**: Undefined-result information MUST survive MachineEffects serialization, Semantic IR V2 lowering, compatibility projection, downstream analysis, and release verification.
- **FR-010**: A downstream consumer MUST NOT publish an exact scalar fact when its producing operation has any active undefined result bit.
- **FR-011**: Named exceptional conditions MUST cover divide-by-zero, signed overflow, and shift/count width boundaries without assigning invented values where the architecture leaves behavior undefined.
- **FR-012**: The profile inventory MUST remain exactly the four production profiles declared by A2; evidence availability and exact/partial boundaries MUST be reported separately for each.
- **FR-013**: Existing A2 rows/count/digest and existing oracle denominators MUST remain unchanged.
- **FR-014**: Release evidence MUST bind exact product/base/candidate identity, verifier version, corpus identity, oracle/model identity, and deterministic artifact digest.
- **FR-015**: Production implementation output, compatibility lowering, decoder text, and competitor agreement MUST NOT serve as the expected architectural oracle.
- **FR-016**: Malformed artifacts and identity mutations MUST be permanent negative regressions; no denominator, assertion, or required gate may be weakened.

### Key Entities

- **ArchitecturalEvidence**: Versioned independent claim for one profile/effect and its complete observable partition.
- **MemoryOutcomeEvidence**: Ordering claim with atomicity, permitted/forbidden outcomes, and a declared outcome universe.
- **UndefinedResult**: Width-bounded undefined-bit mask, class, reason, and optional activation condition.
- **EvidenceAssessment**: Fail-closed decision that distinguishes exact, partial, unsupported, malformed, stale, and mismatch.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All eight required counterexample classes fail before implementation and pass only through fail-closed classification afterward.
- **SC-002**: All six ordering identities and all four undefined-result classes have deterministic positive and negative coverage.
- **SC-003**: Undefined-mask transport loss is zero across every named pipeline boundary.
- **SC-004**: False exact promotion count is zero for stale, partial, unsupported, malformed, and incomplete evidence.
- **SC-005**: All four production profiles appear in one inventory with an explicit evidence status and exact/partial boundary.
- **SC-006**: Focused, canonical MachineEffects, Semantic IR V2, affected Phase 8, full repository, generated-output, candidate-tree, and exact-head CI gates are green.

## Assumptions

- Existing #2372 offline oracle schema/runner/report and current A2/external-oracle policy are the only validation owners to extend.
- Pinned Sail/Isla/herd artifacts and separately identified QEMU executions are independent evidence sources, but unavailable execution remains explicit and cannot be simulated by Hex.
- ARM64/A64 receives formal and relaxed-memory evidence first; other supported profiles remain partial where no equivalent model output is present.
- No production language-metadata, Swift, Objective-C, Go, or Rust file is in scope.
