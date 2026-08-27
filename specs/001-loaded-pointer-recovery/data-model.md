# Data Model: Loaded-Pointer Recovery

## LoadedPointerRequest

Represents one pointer-typed Semantic IR load considered by the points-to fixed point.

| Field | Rule |
|---|---|
| functionId | Must equal the current IR and MemorySSA function identity |
| snapshotId | Must equal the current analysis snapshot binding |
| loadNodeId | Must identify one current complete load node |
| loadedValueId | Must be the load's single pointer-typed output |
| widthBits | Positive, pointer-compatible, and equal across load, store, and stored value |
| endian | Exact current load byte order; must equal the store byte order |
| memoryDescriptor | Must match validated MemorySSA access metadata |

## MemoryBoundaryBinding

Associates one immutable MemorySSA artifact with the analysis snapshot that consumes it without
changing the MemorySSA contract.

| Field | Rule |
|---|---|
| snapshotId | Exact equality with the points-to analysis status identity |
| functionId | Exact equality with IR, CFG, SSA, and MemorySSA |
| semanticIrVersion | Must match the current IR contract |
| memorySsaBuildVersion | Must be the supported current build identity |
| memorySsa | Validated immutable artifact; provider unavailable means unsupported |
| completeness | Must be complete for precision publication |

State transitions:

```text
unvalidated -> current
unvalidated -> stale
unvalidated -> unsupported
current -> invalidated when any bound identity changes
```

Only `current` may participate in recovery.

## ReachingStoreEvidence

Derived from the canonical MemorySSA use and definition.

| Field | Rule |
|---|---|
| useId | One use whose sourceEntityId is the load node |
| definitionId | The use's reaching definition |
| aliasRelation | Must be MustAlias-equivalent |
| definitionKind | Must be one concrete memory definition |
| storeNodeId | Definition source entity; must identify one current complete store node |
| loadAccessMetadata | Must be exact, non-broad, and match the load descriptor |
| storeAccessMetadata | Must be exact, non-broad, and match the store descriptor |
| providerProof | Must be present, current, and complete |

## StoredPointerFact

The existing points-to result for the value written by the reaching store.

| Field | Rule |
|---|---|
| storedValueId | Exactly one non-address input to the store |
| targets | Finite, non-bottom, non-top target set |
| roots and offsets | Preserved exactly; no new root or offset is inferred |
| widthBits | Equal to request width and store width |
| evidence and provenance | Must be non-empty and compatible with current source identities |
| loss reasons | Any loss that destroys pointer identity blocks exact recovery |

## RecoveredPointsToResult

| State | Meaning | Publication |
|---|---|---|
| exact finite set | All eligibility rules pass | Install only as part of a complete refined run |
| unresolved-load | Proof absent or ineligible | Preserve baseline behavior |
| partial | Cancellation or incomplete dependency | Do not install refined map |
| truncated | Deterministic resource limit reached | Do not install refined map |
| unsupported | Contract, version, or reconstruction unsupported | Preserve baseline behavior |
| stale | Binding or source identity mismatch | Preserve baseline behavior |

The recovered exact set copies the stored fact's targets and provenance. It does not claim a new
alias or memory proof.
