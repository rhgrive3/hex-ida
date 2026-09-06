# Contract: Phase 8 Render Provenance

**Feature**: [spec.md](./spec.md) | **Date**: 2026-09-01

Module: `js/decompiler/phase8/render-provenance.js` (new), integrated by
`js/decompiler/phase8/projection.js` (`applyPhase8Projection`).

## buildRenderProvenance(input) → provenanceMap

**Input** (single object):

| Field | Type | Required | Notes |
|---|---|---|---|
| result | projection result | yes | post-rewrite result containing `lines`, `semanticAst`, `phase8Projection` |
| snapshotId | string \| null | no | bound analysis snapshot identity; absent/null is represented as incomplete `missing-snapshot`, never authoritative |
| budget | object | no | `{ maxEntities, maxOriginsPerEntity, maxTransformRecords }` deterministic defaults when omitted |

**Behavior**:
1. Builds up to `maxEntities` `RenderedEntity` records from `result.lines`. Entries beyond the cap are omitted from `entities`, counted by `counts.entitiesTruncated`, and mark the `entities` budget scope plus `truncated` reason.
2. Forward origins per entity = `line.source` rows/addresses/IR/SSA ∪ origins of
   transform records feeding that entity, correlated across every canonical origin kind.
3. Derives reverse index (origin key → entity keys), sorted.
4. Enforces budgets; overflow marks `truncated` scopes explicitly.
5. Returns frozen provenanceMap (see data-model.md).

**Errors** (fail-closed codes, prefix `phase8-render-provenance-*`):
- `result-required`
- `snapshot-required` for a supplied non-null snapshot value that is not a non-empty string
- `entity-source-invalid` (line without usable object shape)
- `record-invalid` / record field errors (transform record missing or malformed kind/proof/targets/origin)

A missing/null snapshot is not a construction exception: the map is retained for diagnostics and is marked incomplete with `missing-snapshot`.

## validateRenderProvenance(provenanceMap, expected) → validation

**Input**: frozen provenanceMap; `expected = { snapshotId }`.

**Returns** frozen `{ state, entityStates, reasons, counts }` where `state ∈
{ 'complete', 'incomplete' }` and every non-complete state carries explicit reasons from:
`provenance-loss`, `stale-snapshot`, `missing-snapshot`, `truncated`, `cancelled`.

**Rules**:
- Missing/mismatched snapshot ⇒ `missing-snapshot` / `stale-snapshot`; never silent pass.
- A zero-origin **semantic** entity ⇒ `provenance-loss`. Explicit structural scaffolding (`role: 'structural'`) is the only zero-origin completeness exception and does not mint a semantic claim.
- Validation never mutates the map; deterministic for identical inputs.

## Projection integration

`applyPhase8Projection` result gains frozen `renderProvenance` field:

```javascript
renderProvenance = { version: 1, snapshotId, entities, reverse, ledger, budget, completeness, reasons }
```

- Absent snapshotId ⇒ completeness `incomplete` with `missing-snapshot` reason (fail-closed;
  the map is still built so diagnostics can list entities).
- Existing result fields are unchanged; additive only. Consumers that ignore the field are
  unaffected.
- The Phase 8 hard-zero safety wiring counts both provenance loss and unbound evidence;
  `tools/validation/phase8/metrics.mjs` exposes `renderProvenanceLossCount` and
  `renderProvenanceUnboundCount`, including a missing provenance map for a semantic result.

## Versioning

- `renderProvenance.version` starts at 1.
- Any record-shape change bumps the Phase 8 contract version (existing
  `PHASE8_CONTRACT_VERSION`), invalidating older evidence per guardrails §5.
