# Data Model: Rendered-Entity Provenance Mapping

**Feature**: [spec.md](./spec.md) | **Date**: 2026-09-01

## Entities

### RenderedEntity

A single addressable unit of decompiled output (line or expression fragment).

| Field | Type | Constraints |
|---|---|---|
| entityKey | string | stable deterministic key `L${lineIndex}:${kind ?? 'null'}` |
| lineIndex | integer ≥ 0 | index into `result.lines` |
| kind | string \| null | rendered line kind |
| role | 'semantic' \| 'structural' | whether the entity makes a semantic claim or is source scaffolding |
| origins | OriginReference | canonical origins retained for the entity |
| complete | boolean | false when semantic provenance is missing or an origin budget truncates the entity |
| reasons | string[] | bounded explicit incompleteness reasons |
| recordRefs | integer[] | indexes into the retained transform ledger that feed this entity |

Validation: entityKey uniqueness; derived only from existing projection output. Text is not
part of identity and is not duplicated into the provenance map; the key identifies the
corresponding `result.lines[lineIndex]` entry.

### OriginReference

Pointer to canonical pre-transform evidence. Never a new semantic identity.

| Field | Type | Constraints |
|---|---|---|
| rows | integer[] | instruction source rows (sorted, unique) |
| addresses | string[] | canonical addresses (sorted, unique) |
| ir | string[] | canonical Semantic IR references (sorted, unique) |
| ssaRefs | string[] | `def:*` / `use:*` references (sorted, unique) |

For semantic entities, at least one member must be non-empty for `complete: true`. Explicit
structural scaffolding is the sole zero-origin exception: it may be complete because it makes
no semantic claim. Members are frozen, sorted, and derived from existing `line.source` and
transform-record `origin` shapes.

### TransformRecord (ledger entry; extends existing `phase8Projection.transforms` shape)

| Field | Type | Constraints |
|---|---|---|
| kind | string | non-empty |
| proof | string | non-empty |
| targets | string[] | required array; omitted/non-array values fail closed |
| origin | object | consumed origins (`rows`/`addresses`/`ir`/`ssaDefs`/`ssaUses`) |
| producedRefs | string[] | rendered entity keys fed by this retained record |
| removedRefs | string[] | reserved removal-evidence field; currently empty because removal identities are not emitted by the projection |
| version | integer | render-provenance schema version |

`removedRefs` must not be interpreted as proof of audited removals until a producer records
canonical removed identities. The current ledger provides positive rewrite/production provenance.

### ProvenanceMap (the versioned, snapshot-bound structure)

| Field | Type | Constraints |
|---|---|---|
| version | integer | schema version (starts at 1) |
| snapshotId | string \| null | bound analysis snapshot identity; null is fail-closed incomplete |
| entities | frozen `Record<entityKey, RenderedEntity>` | forward index; at most `maxEntities` entries |
| reverse | frozen `Record<originKey, entityKey[]>` | derived reverse index (sorted) |
| ledger | TransformRecord[] | bounded retained transform ledger |
| transformCount | integer | raw transform count before ledger truncation |
| budget | { maxEntities, maxOriginsPerEntity, maxTransformRecords, truncated: boolean, truncatedScopes: string[] } | caps + explicit truncation state |
| completeness | 'complete' \| 'incomplete' | aggregate conservative state |
| reasons | string[] | aggregate incompleteness reasons |
| counts | object | entity/ledger/truncation/provenance-loss telemetry |

Invariants:
- Frozen after build; identical inputs → identical serialized map (determinism).
- `reverse` is derivable from `entities` and is re-derivable at any time.
- A semantic entity is complete only with ≥ 1 origin and no per-entity truncation. A zero-origin `role: 'structural'` entity is the explicit non-semantic exception.
- Any budget truncation makes aggregate `completeness = 'incomplete'` and records `truncated`.
- Snapshot mismatch ⇒ validation rejects; map itself never mutates to "become current".
- Entries beyond `maxEntities` are absent from `entities`, counted by `counts.entitiesTruncated`, and reported through the `entities` truncated scope.

## Validation states

Validation exposes only `state: 'complete' | 'incomplete'`; the cause is carried separately in
`reasons`.

| State | Reason | Trigger | Consumer effect |
|---|---|---|---|
| complete | none | all semantic entities resolved, no truncation, snapshot current | fully trusted |
| incomplete | provenance-loss | ≥1 semantic entity has zero origins | entity flagged; hard-zero gate increments |
| incomplete | missing-snapshot / stale-snapshot | snapshotId absent or mismatched | mapping rejected as unbound/stale |
| incomplete | truncated | any budget cap hit | affected scopes flagged; counts reported |
| incomplete | cancelled | cancellation observed | conservative; no publication as complete |

## Ownership

All entities live inside `js/decompiler/phase8/**` result structures. No new persisted
artifacts; no changes to canonical semantic/SSA/MemorySSA structures.
