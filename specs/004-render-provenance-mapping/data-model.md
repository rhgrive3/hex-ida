# Data Model: Rendered-Entity Provenance Mapping

**Feature**: [spec.md](./spec.md) | **Date**: 2026-09-01

## Entities

### RenderedEntity

A single addressable unit of decompiled output (line or expression fragment).

| Field | Type | Constraints |
|---|---|---|
| entityKey | string | stable, deterministic key: line index + kind + normalized text hash |
| lineIndex | integer ≥ 0 | index into `result.lines` |
| kind | string | line kind (e.g. statement/condition/return) |
| text | string | rendered text (exact, not parsed back) |

Validation: entityKey uniqueness; derived only from existing projection output.

### OriginReference

Pointer to canonical pre-transform evidence. Never a new semantic identity.

| Field | Type | Constraints |
|---|---|---|
| rows | integer[] | instruction source rows (sorted, unique) |
| addresses | string[] | canonical addresses (sorted, unique) |
| irRefs | string[] | canonical Semantic IR references (sorted, unique) |
| ssaRefs | string[] | SSA def/use references (sorted, unique) |

Validation: at least one non-empty member; all members frozen and sorted; derived from
existing `line.source` and transform-record `origin` shapes.

### TransformRecord (ledger entry; extends existing `phase8Projection.transforms` shape)

| Field | Type | Constraints |
|---|---|---|
| kind | string | non-empty (existing contract) |
| proof | string | non-empty (existing contract) |
| targets | string[] | non-empty, sorted (existing contract) |
| originRefs / origin | object | consumed origins (rows/addresses/ir/ssa) |
| producedRefs | string[] | entity/refs produced by the rewrite |
| removedRefs | string[] | entities removed by the rewrite (auditable removal) |
| version | string | transform/schema version |

State transitions: absent → recorded (on rewrite) → consumed-by-validation.

### ProvenanceMap (the versioned, snapshot-bound structure)

| Field | Type | Constraints |
|---|---|---|
| version | integer | schema version (starts at 1) |
| snapshotId | string | bound analysis snapshot identity |
| entities | Map<entityKey, { origins: OriginReference[], complete: boolean, reasons: string[] }> | forward map |
| reverse | Map<originKey, entityKey[]> | derived reverse index (sorted) |
| ledger | TransformRecord[] | bounded transform ledger |
| budget | { maxEntities, maxOriginsPerEntity, maxTransformRecords, truncated: boolean, truncatedScopes: string[] } | caps + explicit truncation state |
| completeness | 'complete' \| 'incomplete' | aggregate conservative state |
| reasons | string[] | aggregate incompleteness reasons |

Invariants:
- Frozen after build; identical inputs → identical serialized map (determinism).
- `reverse` is derivable from `entities` and is re-derivable at any time.
- `completeness = 'complete'` only when every entity has ≥ 1 origin and no truncation.
- Snapshot mismatch ⇒ validation rejects; map itself never mutates to "become current".

## Validation states

| State | Trigger | Consumer effect |
|---|---|---|
| complete | all entities resolved, no truncation, snapshot current | fully trusted |
| incomplete:provenance-loss | ≥1 entity has zero origins | entity flagged; hard-zero gate increments |
| incomplete:stale | snapshotId missing/mismatched | mapping rejected/reported stale |
| incomplete:truncated | any budget cap hit | affected scopes flagged; counts reported |
| incomplete:cancelled | cancellation observed | conservative; no publication as complete |

## Ownership

All entities live inside `js/decompiler/phase8/**` result structures. No new persisted
artifacts; no changes to canonical semantic/SSA/MemorySSA structures.
