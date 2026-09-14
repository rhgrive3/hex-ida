# Data Model: HEX-C2-02 Scalar Facts

These structures extend the existing Phase 8 `ranges` artifact. They are
conceptual contracts for implementation and tests; they do not authorize a new
analysis owner or a second cache identity.

## `BitVectorFact`

An immutable fact for one canonical SSA value.

| Field | Type/shape | Invariant |
| --- | --- | --- |
| `valueId` | canonical SSA value ID | Required; stable within the bound SSA identity. |
| `bits` | positive integer | Supported machine width; all masks and values use this width. |
| `range` | existing `Range` | `kind` is `empty`, `range`, or `full`; endpoints are reduced to `2^bits`. |
| `knownZero` | width-bounded bit mask or `null` | A 1 bit is proven zero for every represented value. |
| `knownOne` | width-bounded bit mask or `null` | A 1 bit is proven one for every represented value. |
| `congruence` | `{ remainder: bigint, modulus: bigint }` | `modulus > 0`; `0 <= remainder < modulus`; `modulus <= 2^bits`; modulus 1 means no information. |
| `alignment` | optional alignment descriptor | Present only with canonical address-domain/provenance evidence. |
| `pointerOffset` | optional offset descriptor | Never creates pointer provenance; references an existing pointer fact. |
| `constant` | optional width-safe bitvector | Present only for a proven singleton and complete valid evidence. |
| `status` | `exact`, `conservative`, `unknown`, `unsupported`, or `malformed` | Describes evidence quality, not merely object presence. |
| `reason` | stable diagnostic code/details | Required for omitted/unsupported/malformed precision. |
| `provenance` | immutable origin references | Includes defining operation, input value IDs, and canonical origin IDs. |

### Product invariants

- `knownZero & knownOne == 0`; a conflict is malformed and cannot be published as
  an exact fact.
- Every mask is reduced to the width mask `(1n << BigInt(bits)) - 1n`.
- `range` and the masks agree: known-one bits must be possible in `range`, and
  known-zero bits must be absent from every represented value. If the
  implementation cannot cheaply prove agreement, it widens to a conservative
  fact rather than asserting agreement.
- Congruence is an over-approximation of the same represented values. The
  normalized residue is never interpreted as a singleton unless the range/product
  cardinality proves one element.
- `constant` is a projection, not an independent stored truth. Consumers must be
  able to derive it from the canonical product and evidence.
- A partial/cancelled/budget-limited/stale fact cannot have `status: exact`.

## `EdgeFactSet`

An immutable path-specific fact set attached to a canonical CFG edge or block
entry.

| Field | Type/shape | Invariant |
| --- | --- | --- |
| `edgeId` | canonical `{ from, to, kind }` key | Stable and collision-free under CFG identity. |
| `blockEntryId` | optional canonical block-entry ID | Used when the consumer asks for merged entry facts. |
| `predicate` | normalized predicate descriptor | References the source terminator/condition and comparison domain. |
| `facts` | sorted map `valueId -> BitVectorFact` | Only refinements proven on this edge; absent means no refinement. |
| `reachable` | `true`, `false`, or `unknown` | `false` only after a canonical impossibility proof; unknown never means false. |
| `status` | complete/partial/unknown | Carries propagation/resource status into consumers. |
| `provenance` | edge/terminator/origin references | Explains why each refinement is valid. |

An edge fact never mutates the global value fact. At a block join, incoming facts
are combined only for proven executable predecessors. Unproven, malformed, or
missing predecessor evidence results in a conservative join.

## `ScalarAnalysisResult`

The versioned Phase 8 `ranges` payload.

| Field | Type/shape | Invariant |
| --- | --- | --- |
| `identity` | `CanonicalAnalysisIdentity` | Must match the transaction's declared upstream identity. |
| `facts` | sorted map `valueId -> BitVectorFact` | Sole global scalar truth. |
| `ranges` | compatibility map | Immutable projection of `facts`; never independently updated. |
| `constants` | compatibility map | Singleton projection of `facts`; no unsupported promotion. |
| `edgeFacts` | sorted map `edgeId -> EdgeFactSet` | Path-specific projection with canonical IDs. |
| `blockEntryFacts` | optional sorted map | Conservative joins of edge facts. |
| `completeness` | `complete`, `partial`, or `unknown` | `complete` requires fixed-point/resource success. |
| `diagnostics` | sorted stable records | Includes unsupported, malformed, stale, cancellation, and budget reasons. |
| `budget` | limits and usage | Deterministic work/edge/fact limits; no timing-dependent semantics. |
| `publicationDigest` | deterministic digest | Includes semantic facts/keys/diagnostics, excludes timing. |

## `CanonicalAnalysisIdentity`

The identity carried by a result and checked before publication/consumption:

- binary identity;
- function identity;
- snapshot identity;
- Semantic IR identity/schema;
- CFG identity/version;
- SSA identity/version;
- Phase 8 producer/pass version;
- pass registry/contract/schema identity; and
- analyzer identity/version and relevant budget class.

Identity fields are compared by the existing artifact/transaction contract. A
result from a different snapshot, SSA, producer version, analyzer, or incompatible
budget class is stale, not an exact approximation of current input.

## State transitions

```text
seeded identity
  -> running (facts private to transaction)
  -> complete fixed point -> staged ranges -> atomic commit
  -> partial/unknown/cancelled/budget/malformed -> withheld or explicitly partial
```

No transition from partial, stale, unsupported, malformed, or cancelled to exact
is legal without rerunning the canonical producer with valid evidence.
