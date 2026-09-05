# Feature Specification: Rendered-Entity Provenance Mapping

**Feature Branch**: `feat/analysis-hex-c4-03-provenance`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "Close HEX-C4-03 raw/optimized/rendered bidirectional provenance mapping per docs/解析ツール改善.md.txt, on current live main, without unrelated Issue work."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Navigate From Rendered Output to Canonical Evidence (Priority: P1)

An analyst reading the decompiled pseudocode clicks or queries any rendered fragment — an
expression, condition, store, or return — and reaches the canonical pre-transform evidence
(instruction rows, Semantic IR expression, origin rows) that produced it, even when that fragment
survived several optimizing transforms.

**Why this priority**: Without reverse navigation, UI and AI consumers can over-trust a rendered
projection whose canonical origin has been silently lost by a many-to-one transform (CSE, DCE,
φ elimination, switch recovery, struct field rendering). Reverse navigation is the primary value
of provenance and gates every other consumer.

**Independent Test**: A deterministic function contains an optimized expression; the rendered
line for that expression resolves to its source instruction rows and Semantic IR identity; a
second, identical run produces identical mappings.

**Acceptance Scenarios**:

1. **Given** a rendered pseudocode line derived from optimized semantic expressions, **When** the
   analyst requests the canonical origin of that line or expression, **Then** the response names
   the originating instruction rows and canonical semantic references with a deterministic
   identity.
2. **Given** a many-to-one transform (a merged, folded, or rewritten expression), **When** the
   rendered fragment is traced backward, **Then** every consumed origin it replaced remains
   reachable, and no consumed origin is silently dropped.
3. **Given** two identical analysis runs over the same snapshot, **When** mappings are compared,
   **Then** they are identical, including transform records and origin identities.

---

### User Story 2 - Detect Lost or Stale Provenance (Priority: P1)

An analyst (or automated gate) is never shown rendered output whose provenance is incomplete or
stale: if any rendered entity cannot be traced to canonical evidence, or the mapping describes an
older analysis snapshot, the failure is explicit rather than silent.

**Why this priority**: False provenance — mapping that looks valid but points at stale or missing
evidence — is a false-exactness class blocked by the constitution; silent loss is the core failure
mode this finding exists to close.

**Independent Test**: A transform that drops an origin, and a stale snapshot identity, are each
injected; validation detects both and the affected surface is explicitly marked incomplete
instead of silently trusted.

**Acceptance Scenarios**:

1. **Given** a rendered entity whose only origin was deleted by a transform, **When** provenance
   validation runs, **Then** the entity is reported as provenance-incomplete with the transform
   that caused the loss, and it is never presented as fully trustworthy.
2. **Given** rendered output computed against a previous analysis snapshot, **When** the current
   snapshot identity no longer matches, **Then** the stale mapping is rejected rather than served
   as current.
3. **Given** a rendered entity with no transforming rewrite at all (raw pass-through), **When**
   validation runs, **Then** it resolves through the unchanged direct mapping without requiring
   synthetic transform records.

---

### User Story 3 - Transform Ledger Records What Each Optimization Consumed and Produced (Priority: P2)

For every optimizing transform the decompiler applies, an analyst or tooling can inspect what the
transform consumed, what it produced, and which proof/authority kind justifies it, in one bounded
ledger.

**Why this priority**: The ledger is what makes Stories 1 and 2 auditable and debuggable, but it is
consumed through them; on its own it is secondary evidence.

**Independent Test**: A function containing at least one fold/merge transform is analyzed; the
ledger for that transform lists consumed origins, produced entities, and version identity, and the
ledger is bounded by a budget with deterministic content.

**Acceptance Scenarios**:

1. **Given** a transform that merges two expressions into one, **When** its ledger record is
   inspected, **Then** it lists both consumed origins and the one produced entity, plus the
   transform kind and version.
2. **Given** a pathological function with more transforms than the configured ledger budget,
   **When** analysis completes, **Then** the ledger records the bounded truncation explicitly and
   analysis still completes with the conservative incomplete state.

### Edge Cases

- What happens when a rendered line is produced purely from raw rows with no semantic expression?
  It must resolve to its direct raw row mapping without invented origins.
- What happens when a transform rewrites an expression repeatedly (transform on transform)? The
  final fragment must chain backward through each rewrite step to the original rows.
- What happens when an entity's origin list would grow unboundedly (deep merge chains)? The
  mapping must be bounded and, at the bound, explicit about incompleteness instead of truncating
  silently.
- What happens when the same origin feeds multiple rendered entities? Each rendered entity must
  independently carry the origin; loss of one projection must not corrupt the other.
- What happens when a rendered entity is removed entirely (e.g., dead code eliminated)? The
  transform's consumed canonical origins remain auditable, but C4-03 v1 does not yet bind a
  canonical identity for the removed rendered entity itself. That residual gap must remain
  explicit and must not be reported as completed removal-identity coverage.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every rendered pseudocode entity MUST be resolvable to a deterministic set of
  canonical origins (instruction rows and/or canonical semantic references) through one bounded,
  bidirectional mapping.
- **FR-002**: The mapping MUST be validated so that a rendered entity with zero resolvable
  canonical origins is explicitly reported as provenance-incomplete; such an entity MUST NOT be
  presented as fully trusted.
- **FR-003**: The mapping MUST bind the analysis snapshot identity it was computed against and
  MUST be rejected or reported stale when compared against a different snapshot identity.
- **FR-004**: Every optimizing transform applied during rendering MUST record its consumed
  origins, produced entities, transform kind, and transform version in a bounded transform ledger
  whose content is deterministic for the same input snapshot.
- **FR-005**: When the ledger exceeds its configured budget, the overflow MUST be explicit and
  conservative (recorded truncation state), never silent.
- **FR-006**: Repeated rewrites of the same expression MUST chain: the final rendered fragment
  resolves to origins through each intermediate rewrite, and validation reaches the original
  canonical rows.
- **FR-007**: Provenance data MUST be bounded in memory: per-entity origin lists, ledger size, and
  total provenance storage MUST have deterministic caps with explicit conservative degradation.
- **FR-008**: The canonical semantic truth (semantic expressions, origin rows, MemorySSA, and
  existing transform provenance) MUST remain the sole authority; the mapping MUST NOT mint new
  semantic identities or alter canonical evidence.
- **FR-009 — UNMET IN C4-03 v1**: A rendered entity removed by a transform (e.g., eliminated dead
  code) SHOULD have a canonical removed-entity identity represented in the transform ledger so
  removal can be navigated directly. The current v1 ledger preserves consumed canonical origins
  but emits `removedRefs: []`; therefore this requirement is explicitly not satisfied and MUST NOT
  be used as a closure claim until a canonical removed-entity identity producer is implemented.
- **FR-010**: Validation MUST be cancellable and budgeted: provenance validation on a pathological
  function completes within deterministic bounds or returns an explicit incomplete state.

### Key Entities *(include if feature involves data)*

- **Rendered entity**: a line or fragment of the decompiled output (kind, text, position),
  addressable by the query/UI surface.
- **Origin reference**: a pointer to canonical pre-transform evidence — an instruction row and/or
  a canonical semantic expression reference — carrying the identity needed for reverse navigation.
- **Transform record**: the bounded ledger entry describing one optimizing transform: kind,
  version, consumed origins, produced entities, and, when a canonical removed-entity identity is
  available, removed entities. C4-03 v1 currently does not produce that removed identity.
- **Provenance map**: the versioned, snapshot-bound structure relating rendered entities to origin
  references, including its completeness state and budget metadata.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of rendered entities in the locked provenance corpus resolve to at least one
  canonical origin or carry an explicit provenance-incomplete marker; zero entities silently
  lack provenance.
- **SC-002**: Every optimizing transform in the corpus emits a deterministic ledger record;
  identical inputs produce byte-identical ledgers.
- **SC-003**: Stale mappings (snapshot identity mismatch) are rejected 100% of the time in the
  staleness matrix; no stale mapping is served as current.
- **SC-004**: Chained rewrites resolve to original instruction rows in 100% of chained cases in
  the corpus; reverse navigation never stops at an intermediate rewritten expression without
  continuing to canonical evidence.
- **SC-005**: Provenance storage and validation complete within deterministic budgets on
  pathological fixtures, returning explicit incomplete states rather than hanging or failing.

## Assumptions

- The existing Phase 8 projection transform records and origin-row architecture are the canonical
  starting point; this feature extends their coverage and enforcement rather than replacing them.
- Existing decompiler consumers (UI rendering, query surfaces) will consume the mapping through
  the current projection result; no new query engine is introduced.
- The current C4-01 pass transaction (declared consumes/produces/invalidates) is the adoption
  boundary for any transform change and remains a mandatory gate.
- MemorySSA and semantic-expression identity are upstream authorities and are out of scope for
  modification.
- Snapshot identity and artifact identity mechanisms already present in Phase 8 are reused as-is.
- Cancellation and budget semantics follow the existing Phase 8 transaction substrate.
