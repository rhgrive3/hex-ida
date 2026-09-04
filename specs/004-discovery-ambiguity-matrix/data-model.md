# Data Model

## DiscoveryArtifact (`hex-discovery-ambiguity-artifact/v1`)

- `artifactId`: content-derived identity over every field below.
- Live factory issuance: module-private runtime brand required by consumer
  boundaries in addition to `artifactId`; it is intentionally not serializable.
- `binding`: `{ binaryId, sourceHash, snapshotId, architectureId }`.
- `producerRuns[]`: producer ID/version/architecture, completeness, stop reason,
  evidence count, supplied interval count, and a non-serializable canonical-run
  issuance authority used when authoritative evidence is present.
- `status`: canonical Phase 7 AnalysisStatus.
- `publication`: `complete` or `withheld` with reason.
- `resource`: immutable normalized X-03 limits plus observed cardinalities and
  collision-work bound.
- `evidence[]`: canonical discovery evidence, including producer identity,
  reference location, relocation ID, and a framed type-preserving JSON-safe
  symbolic expression. Partial extent evidence carries a separate
  `extentCoverageComplete` bit; `extentRole: partial` alone never closes extent
  coverage.
- `functionCandidates[]`: stable candidate identity, start/extent states,
  evidence IDs, digest, and all associated collision IDs.
- `intervalClaims[]`: original code/data/padding/unsupported ranges. Evidence
  ranges remain here even if overlap reconciliation withdraws candidate regions.
  Supplied IDs are rejected; IDs derive from the complete typed payload and are
  unique across supplied and inferred namespaces.
- `collisionSets[]`: unresolved alternatives for function overlap, code/data
  overlap, or an in-body reference.
- `references[]`: relocation, vtable/data, and jump-table point references.

## CollisionSet

- `collisionId`: content-derived identity.
- `kind`: `function-overlap`, `function-contained-start`, `code-data`, or
  `code-data-reference`.
- `range` or `at`: exact intersection range or point address.
- `alternatives[]`: sorted members carrying their source IDs/provenance.
- `resolution`: always `unresolved` in v1.

## DiscoveryRebuildBinding (`hex-discovery-rebuild-binding/v1`)

- Source artifact and binding identities.
- Complete collision sets and references, not only counts/digests.
- Content digest.

The format-safe rebuild factory automatically stores this object inside
`expectedOriginalState`, which already participates in transaction identity.
Reparse comparison rejects missing
collision/reference member IDs and requires the reparsed artifact source hash to
equal the separately supplied materialized output hash. Snapshot identity may
change for a legitimate output parse; binary and architecture identity may not.

## Canonical output discovery

- Derived only by transaction-v2 from an immutable copy of the exact
  materialized output bytes.
- Recomputes the output hash, invokes the canonical binary parser, and runs the
  module-owned discovery producers.
- Must be complete and bind the transaction binary, architecture, output hash,
  collision IDs, and reference IDs.
- Callback-authored artifacts, hashes, attestations, clones, and serialized
  structures carry no reparse authority.
- Every nested canonical parser status is an own-data observation. Any partial,
  incomplete, stopped, cancelled, truncated, or non-null partial-reason status
  makes canonical output discovery unavailable.

## Verified publication

- The promoter receives a frozen byte array and an identity-only materialized
  view, never the mutable validated buffer.
- Atomic/committed protocol and identity fields are strict primitive data.
- Committed bytes are read from the promotion result or a post-commit reader and
  rehashed independently; absent or mismatched bytes withhold publication.
- Cancellation/deadline checks occur before promotion, after the promoter, and
  after committed-byte verification.

## State Rules

- Analysis complete + exact binding + complete producer identities => publication
  complete.
- Any stale binding, incomplete producer, cancellation, budget stop, or missing
  identity => publication withheld.
- Producer/evidence version or architecture mismatch, count mismatch, or a
  complete run with no evidence/interval authority => publication withheld.
- Artifact resource exhaustion => empty collision/evidence projection with
  publication withheld; no silent complete truncation.
- Artifact budget overrides may only tighten hard ceilings and must be primitive
  positive safe integers; raw accessors are not evaluated.
- Complete candidate views are re-derived from the shared fusion rules and
  exactly compared across names, extents, ownership, evidence, conflicts, and
  global overlap reconciliation.
- Only complete publication can create a rebuild binding.
- A public checksum or self-hashed binding is not a live issuance brand.
- Loader-reparse validation derives a complete output artifact internally
  whenever the transaction carries a discovery binding; the writer cannot
  self-prove this inside its mutation result.
- Discovery-affecting operations without a source binding carry
  `discoveryStatus: unproven` and cannot validate. Explicit data-only metadata
  operations remain outside that gate even when their file layout moves.
