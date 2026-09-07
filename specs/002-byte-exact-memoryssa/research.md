# Research Notes: HEX-C2-01

## Decision 1: Keep MemorySSA as the only memory truth

- **Evidence**: `js/semantics/memoryssa/build.js:buildMemorySsa` creates the canonical memory
  regions, definitions, uses, alias relations, clobbers, and access metadata. Its input is the
  Semantic IR and canonical alias provider.
- **Decision**: Add a query/consumer over the validated MemorySSA artifact. Do not add a private
  reaching-definition walk, alias solver, or parallel memory graph.
- **Rejected**: Reusing the legacy `buildMemorySSA` in
  `js/architecture/compat/ir-core-arm64-aapcs64-v1.js`; that path is compatibility code and would
  create a second semantic owner.

## Decision 2: Make byte coverage an explicit proof

- **Evidence**: `js/semantics/memoryssa/queries.js:reachingConcreteStore` returns only one
  `memory-def` when a use is `must`; it does not prove that a differently sized load is covered by
  one or more stores. `attachMemorySsa` publishes only this one-store result as `reachingStore`.
- **Decision**: Build a width-exact byte interval from canonical access metadata, collect only
  MemorySSA-linked concrete stores, and require every load lane to have a proven winner. Use
  BigInt for offsets and values.
- **Rejected**: Treating a region ID, matching location key, or a single reaching store as whole-
  load coverage; these are not byte-level proofs.

## Decision 3: Fail closed at every uncertainty boundary

- **Evidence**: `createMemorySsaContract` and `validateMemorySsa` reject malformed links,
  identity mismatches, missing provenance, and dangling metadata. The builder emits explicit
  may/unknown/call/intrinsic clobber definitions.
- **Decision**: The forwarding result remains unknown/partial/unsupported/stale/cancelled or
  budget-limited when any such evidence is present. No byte is initialized with zero merely to
  complete a value.
- **Rejected**: A confidence score, “best effort” byte, or generated artifact as a proof source.

## Decision 4: Preserve endian and order at the final consumer boundary

- **Evidence**: `createMemoryAccess` makes `widthBits` and `endian` part of the canonical access
  contract, while the existing compatibility propagation masks values after a same-width store.
- **Decision**: Reconstruct bytes in the access endian and retain a deterministic ordered list of
  winning definitions in the proof. Overlaps require a canonical order; equal values do not remove
  the need for order evidence.
- **Rejected**: Host-endian conversion or numeric `Number` arithmetic for addresses/bit lanes.

## Decision 5: Publish atomically through the existing value surface

- **Evidence**: `js/semantics/compat/semantic-ir-v2-to-v1-memory.js:attachMemorySsa` is the
  direct projection boundary and `propagateValues` consumes its `reachingStore` relationship.
- **Decision**: The canonical query returns a proof-bearing result first; the compatibility/value
  layer adopts it only after validation and completeness checks succeed. All negative cases retain
  the existing conservative path.
- **Rejected**: Consumer-local forwarding in points-to or decompiler code, or a hidden fallback
  that promotes a partial artifact.

## Decision 6: Bound work and preserve identity

- **Evidence**: Existing MemorySSA build/query APIs accept cancellation and resource limits, and
  analysis artifacts carry function, source, and transform provenance.
- **Decision**: Every definition/lane traversal checks the signal and a deterministic work budget;
  the result includes a stable identity/provenance digest tied to the current MemorySSA/access
  artifact and is rejected when stale or malformed.
- **Rejected**: Unbounded predecessor rescans, mutable shared caches without identity keys, or
  stale-result reuse after a snapshot/IR/analyzer change.

## Decision 7: Gate existing downstream consumers on the canonical capability

- **Evidence**: The review found that direct point-to, decompiler, compatibility, and symbolic
  projection paths could still observe a structural `reachingStore` edge, a projected `memUse`
  store/phi, or a shape-compatible forwarding object after the canonical query refused exactness.
  Those paths are consumers of the published MemorySSA fact, not independent owners of memory or
  alias truth.
- **Decision**: Keep the canonical query and compatibility projection as the sole producers. The
  affected consumers (`js/analysis/pointsto/local.js`, `js/decompiler/**`, `js/ir-core.js`,
  `js/slice.js`, and `js/symbolic/translate/**`) now accept exactness only through the canonical
  predicate/capability, and preserve an unresolved load when the fact is absent, stale, or
  malformed. The point-to boundary calls the canonical query for its operand capability; it does
  not build a reaching-definition or alias graph. The decompiler and slice changes are consumer
  gates only: they remove structural substitutions and resolve canonical contributor IDs through
  the already-published IR/MemorySSA handoff.
- **Evidence tests**: Focused forged-fact and cross-wiring negatives, point-to stale/provider
  negatives, compatibility stack-flow negatives, decompiler structural-fallback negatives, and
  symbolic support-matrix negatives permanently cover this boundary.
- **Rejected**: Restoring any consumer-local linear scan, stack-flow recovery, provider-proof
  heuristic, or shape-only exactness check.

## Required Counterexample

The minimum failure is two adjacent exact stores followed by a wider load in the same canonical
memory region. Existing behavior has a `memory-def`/`must` relationship only at the region-level
boundary and does not publish a reconstructed load value. The pre-fix regression records this
non-exact result before any production source changes.

## Compressed Graft Trace

```text
PRODUCER: MachineEffects memory access -> Semantic IR load/store/call/intrinsic descriptors
CANONICAL_OWNER: js/semantics/memoryssa/build.js + contract.js + validate.js + queries.js
CANONICAL_OBJECT: validated MemorySSA regions, definitions, uses, accessMetadata, and proof links
IDENTITY: binary/function/snapshot, Semantic IR + SSA/MemorySSA contract/build, analyzer/version,
          access entity IDs, and stable proof digest
PROVENANCE: access origins, region identity, alias-provider proof, MemorySSA use/definition links,
            contributing store origins
COMPLETENESS: Semantic IR/MemorySSA validation, provider status, cancellation, deadline,
              iteration/resource budgets, and explicit incomplete/truncated state
PUBLICATION: js/semantics/compat/semantic-ir-v2-to-v1.js ->
             js/semantics/compat/semantic-ir-v2-to-v1-memory.js -> legacy value propagation
INVALIDATION: changed IR/CFG/SSA/alias/access metadata, MemorySSA build, snapshot, analyzer, or
              provenance identity rejects the old proof
DIRECT_CONSUMERS: MemorySSA query surface, compatibility projection, canonical value/points-to ask
DOWNSTREAM: scalar propagation, symbolic/decompiler value recovery, points-to/type/prototype
            evidence, public projections
TEST_OWNER: tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs plus existing MemorySSA /
            compatibility runners
COLLISIONS: current main 99bb9a40; merged #2775, open #2745/#2777, and active C2-02 have zero
            path overlap with the 40-path C2-01 inventory. Historical/stale C3-02 and generic
            P3 refs overlap downstream paths but have no open PR and no live-main delta; no
            semantic/generated collision exists. Actual Graft traces saved ~4,002,139 tokens.
```
