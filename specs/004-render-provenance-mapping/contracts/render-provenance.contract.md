# Contract: Phase 8 Render Provenance

**Feature**: [spec.md](./spec.md) | **Date**: 2026-09-01

Module: `js/decompiler/phase8/render-provenance.js` (new), integrated by
`js/decompiler/phase8/projection.js` (`applyPhase8Projection`).

## buildRenderProvenance(input) → provenanceMap

**Input** (single object):

| Field | Type | Required | Notes |
|---|---|---|---|
| result | projection result | yes | post-rewrite result containing `lines`, `semanticAst`, `phase8Projection` |
| snapshotId | string | yes | bound analysis snapshot identity (from Phase 8 artifact identity input) |
| budget | object | no | `{ maxEntities, maxOriginsPerEntity, maxTransformRecords }` deterministic defaults when omitted |

**Behavior**:
1. Builds one `RenderedEntity` per entry in `result.lines`.
2. Forward origins per entity = `line.source` rows/addresses/ir/ssa ∪ origins of
   transform records feeding that entity (matched by produced refs/rows).
3. Derives reverse index (origin key → entity keys), sorted.
4. Enforces budgets; overflow marks `truncated` scopes explicitly.
5. Returns frozen provenanceMap (see data-model.md).

**Errors** (fail-closed codes, prefix `phase8-render-provenance-*`):
- `input-required`, `result-required`, `snapshot-required`
- `entity-source-invalid` (line without usable source object shape)
- `record-invalid` (transform record missing kind/proof/targets/origin)

## validateRenderProvenance(provenanceMap, expected) → validation

**Input**: frozen provenanceMap; `expected = { snapshotId }`.

**Returns** frozen `{ state, entityStates, reasons, counts }` where `state ∈
{ 'complete', 'incomplete' }` and every non-complete state carries explicit reasons from:
`provenance-loss`, `stale-snapshot`, `missing-snapshot`, `truncated`, `cancelled`.

**Rules**:
- Missing/mismatched snapshot ⇒ `stale-snapshot` / `missing-snapshot`; never silent pass.
- Any zero-origin entity ⇒ `provenance-loss` with entity keys listed (bounded).
- Validation never mutates the map; deterministic for identical inputs.

## Projection integration

`applyPhase8Projection` result gains frozen `renderProvenance` field:

```
renderProvenance = { version: 1, snapshotId, entities, reverse, ledger, budget, completeness, reasons }
```

- Absent snapshotId ⇒ completeness `incomplete` with `missing-snapshot` reason (fail-closed;
  the map is still built so diagnostics can list entities).
- Existing result fields are unchanged; additive only. Consumers that ignore the field are
  unaffected.
- The Phase 8 hard-zero gate `provenanceLossCount` counts `provenance-loss` states from
  this validation; metrics wiring in `tools/validation/phase8/metrics.mjs` exposes
  `renderProvenanceLossCount` and `renderProvenanceStaleCount` (fail on > 0 in the same
  way existing stale counters are gated).

## Versioning

- `renderProvenance.version` starts at 1.
- Any record-shape change bumps the Phase 8 contract version (existing
  `PHASE8_CONTRACT_VERSION`), invalidating older evidence per guardrails §5.
