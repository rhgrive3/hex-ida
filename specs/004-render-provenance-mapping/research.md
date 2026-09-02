# Research: Rendered-Entity Provenance Mapping (HEX-C4-03)

**Date**: 2026-09-01 | **Feature**: [spec.md](./spec.md)

## R1 — What exists today (current-state evidence)

- `js/decompiler/phase8/projection.js` — `applyPhase8Projection(result, analysis, opts)`:
  - Rewrites semantic expressions (induction-variable proof, exact-view collapses:
    nested truncation, extension-under-truncation, repeated extension).
  - Emits `result.phase8Projection` = frozen `{ version, transformCount, transforms,
    inductionNames }`.
  - Produces `result.lines` (kind/text/row/addr/source per rendered node) and
    `result.pseudocode` + `result.sourceMap` via `printProgram`.
  - Transform records already carry `origin` with `addresses/rows/ir/ssaDefs/ssaUses`
    and a `proof` string.
- `js/decompiler/phase8/contract.js` — `transformList(values)` validates pass transforms:
  `kind`, `targets` (non-empty), `proof`, `originRefs`; comment records the Phase 8 hard-zero
  exit gate `provenanceLossCount = 0`.
- `js/decompiler/phase8/artifact-identity.js` — `createPhase8ArtifactDescriptor` binds
  `binaryId`, `snapshotId`, schema/contract versions, pass registry digest, budget class.
  Stale acceptance is measured (`staleArtifactAcceptanceCount` in metrics).
- `js/decompiler/provenance.js` — row/address extraction/formatting helpers
  (`decompilerSourceRows`, `decompilerSourceAddresses`, `formatDecompilerSource`).
- `js/core/identity/origin.js` — `createOriginSet` canonical origin identity.
- `tools/validation/phase8/metrics.mjs` — safety counters include
  `staleArtifactAcceptanceCount`, `transformDeterminismFailures`, frozen provenance digests.
- Ledger classification (`docs/analysis-improvement-finding-ledger.md`, HEX-C4-03):
  `REMAINING / PARTIAL` — "transform origins and stale artifact rejection exist; full
  bidirectional mapping is unproven"; gap = every rendered entity reverse mapping.

**Decision**: Build the missing bidirectional layer *on* these structures; do not replace them.
**Rationale**: Constitution I (one canonical truth) and the card's DO-NOT-DUPLICATE
("rendered AST IDs do not become independent semantic identities").
**Alternatives considered**: standalone post-hoc mapper outside Phase 8 — rejected (would
re-derive origins without access to in-pass transform records; second truth risk).

## R2 — Where the new code lives

- New module: `js/decompiler/phase8/render-provenance.js`.
  - `buildRenderProvenance(...)`: forward map (rendered entity → origins), reverse index
    (origin → rendered entities), completeness state, budget/truncation metadata,
    snapshot binding. Frozen output, deterministic.
  - `validateRenderProvenance(...)`: fail-closed diagnostics for zero-origin entities,
    stale snapshot identity, missing binding, budget overflow; returns explicit state.
- Integration: `applyPhase8Projection` attaches frozen `result.renderProvenance` after
  building lines; projection opts pass snapshot identity through.
- Contract: extend `js/decompiler/phase8/contract.js` with validation codes for the new
  record shapes (fail-closed style consistent with existing codes).
- Tests: `tests/phase8/provenance/**` registered in the canonical Phase 8 runner
  (EP-005: verify nested-subtree discovery with a sentinel test).
- Metrics: wire validation outcome into `tools/validation/phase8/metrics.mjs` safety
  counters (provenance-loss and stale-mapping counts stay hard-zero gated).

**Decision**: single new module + minimal integration points.
**Rationale**: keeps blast radius inside the p8 ownership lane; avoids new passes.
**Alternatives**: separate Phase 8 pass — rejected (projection is where rendered entities
and transform records already meet; a later pass could only see post-rewrite state).

## R3 — Bidirectional semantics

- Forward: rendered entity (line index + node reference) → origin set = direct source rows
  (`line.source`) ∪ transform-record origins whose produced rows/expressions feed that line.
- Reverse: derived from the forward map (origin key → entity refs); deterministically built
  by sorting, never hand-maintained.
- Chains: repeated rewrites resolve by unioning origin sets across all records that touched
  the expression chain (records are pushed at each rewrite step); validation asserts the
  final fragment reaches instruction rows, not an intermediate expression only.
- Removals: a transform that eliminates an entity is recorded as consumed evidence
  (existing `targets` semantics); reverse index references the removing record.

**Decision**: origin union + sorted reverse derivation.
**Rationale**: deterministic, order-insensitive, bounded.
**Alternatives**: per-transform linked chains — rejected (unbounded growth, order-dependent).

## R4 — Staleness and identity

- The provenance map records `snapshotId` (from the Phase 8 artifact identity input) and
  schema version.
- `validateRenderProvenance` fails closed when identity is missing or mismatched.
- Same identity is already enforced at artifact level; this closes the mapping surface.

**Decision**: reuse artifact-identity snapshot binding; no new identity scheme.
**Rationale**: `js/core/identity/**` and `js/core/artifacts/**` are forbidden paths;
artifact descriptor is the published seam.

## R5 — Budgets and cancellation

- Caps: `maxEntities`, `maxOriginsPerEntity`, `maxTransformRecords` (deterministic defaults,
  overridable via projection opts); overflow ⇒ explicit `truncated` state on the affected
  scope, never silent drop; counts reported.
- Cancellation: build/validate honor the existing Phase 8 budget/cancel hooks; on
  cancellation the map is marked incomplete with the conservative reason.

**Decision**: deterministic caps + conservative degradation.
**Rationale**: Constitution IV; pathological fixtures must not hang.

## R6 — Testing strategy (deterministic proof before promotion)

1. Pre-fix counterexample: construct a rendered entity whose origins are lost by a
   many-to-one transform — validation must fail before the production fix exists.
2. Positive: each transform class (induction, view collapses) and raw pass-through lines
   resolve to canonical rows.
3. Negatives: zero-origin entity, stale snapshot, missing identity, budget overflow,
   malformed record — all explicit conservative states.
4. Determinism: identical runs produce byte-identical maps (sorted, frozen).
5. Runner discovery: sentinel test in `tests/phase8/provenance/` found by
   `tests/phase8/run.mjs`.

**Decision**: T0–T2 proportionate suite in-repo; T3 via existing Phase 8 verify/metrics.
**Rationale**: matches ledger exit contract and prior finding lanes.

## R7 — Concurrent work and ownership

- In-flight lanes (untouched): ME-01, C1-01, C2-01, C2-02, C3-02.
- Overlap check: FR-C4-03A consumes C2-01 outputs *only* through MemorySSA facts already
  published on current main; no file overlap with `js/semantics/memoryssa/**` or
  `js/analysis/**` (forbidden to this lane). If C2-01 lands first, no rework is required
  because this feature consumes published results only.
- Generated output: userscript template/release version NOT committed by this lane;
  canonical build run ephemerally; recorded as integration handoff (EP-003/EP-008).

**Decision**: proceed without waiting for C2-01; record as integration handoff if any
generated output is affected.
**Alternatives**: BLOCKED_BY_CONCURRENT_WORK — rejected because current-main published
surfaces are sufficient for the mapping layer.
