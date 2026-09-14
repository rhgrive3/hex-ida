# Research: Loaded-Pointer Recovery

## Decision 1: Consume canonical MemorySSA after its baseline build

**Decision**: Build MemorySSA with the existing Phase 7 alias floor, validate it, then run one
monotone points-to refinement that consumes that immutable artifact. Do not rebuild MemorySSA from
the refined points-to answer.

**Rationale**: Current production ordering constructs the alias solver before MemorySSA and uses it
as MemorySSA's canonical alias provider. A post-build consumer keeps the graph acyclic and reuses the
single memory truth.

**Alternatives considered**:

- A second reaching-definition walk inside points-to: rejected as duplicate semantic authority.
- Repeated points-to/MemorySSA mutual fixed point: rejected for circular proof, cost, and unclear
  convergence.
- Decompiler-only forwarding: rejected because it bypasses canonical points-to ownership.

## Decision 2: Admit only one fully covered concrete store

**Decision**: The first C1-01 bridge accepts exactly one MustAlias `memory-def`, one complete store
value, and one complete load whose memory width and endian match the pointer value width.

**Rationale**: This is the smallest deterministic case that closes the load boundary without
inventing a byte reconstruction proof. It is directly supported by `reachingConcreteStore`.

**Alternatives considered**:

- Join multiple equal-looking stores: rejected because equality of values is not one complete
  reaching-definition proof.
- Reconstruct from partial stores: deferred to HEX-C2-01, which owns proof for every byte.

## Decision 3: Require ordinary sequencing to be positively known

**Decision**: Volatility and atomicity must both be explicitly false, ordering must be compatible
with non-atomic access, and load/store completeness must be complete. Unknown sequencing refuses
recovery.

**Rationale**: Eliminating uncertainty about an access is stronger than assuming ordinary behavior
from a missing flag. Current ARM64 ordinary-load atomicity can be unknown; this feature must not
silently override that upstream contract.

**Alternatives considered**:

- Treat unknown as ordinary: rejected as false certainty.
- Accept atomics with matching ordering: deferred because the feature requires pointer identity,
  not a new atomic-memory model.

## Decision 4: Bind the proof to current immutable artifacts

**Decision**: A runtime boundary binding carries snapshot/function/schema/build identities and is
cross-checked against current IR load/store nodes, MemorySSA use/definition source entities, access
metadata, widths, endian, and provenance. It is a consumer wrapper, not a MemorySSA schema change.

**Rationale**: MemorySSA's current contract binds function and build identities but not an external
analysis snapshot. The wrapper supplies freshness without modifying the forbidden MemorySSA owner.

**Alternatives considered**:

- Add snapshot fields to MemorySSA: rejected because Phase 7 explicitly forbids changing that
  canonical contract for this consumer.
- Match by function or variable names: rejected because names are not provenance.

## Decision 5: Publish refinement atomically

**Decision**: The solver keeps its baseline points-to run while a MemorySSA-aware run is staged. It
replaces the cache only if the refined run is current and complete; replacement invalidates escape
facts. Failure, cancellation, and truncation retain the baseline.

**Rationale**: Direct consumers can inspect the points-to map, so a partial map must not leak even if
later alias code would inspect completeness. This follows the established Phase 8 transactional
publication rule.

**Alternatives considered**:

- Publish a partial map with a partial status: rejected because consumers could misuse precision.
- Mutate the existing map in place: rejected because cancellation could leave mixed state.

## Decision 6: Preserve current budgets and architecture boundary

**Decision**: Create bounded indexes once and keep the current points-to target, iteration, widening,
and value limits. No target code, solver, thread, or new dependency is introduced.

**Rationale**: Lookup is a function-local consumer operation and can remain browser-native. Current
limits already define conservative termination.

**Alternatives considered**:

- Rescan all MemorySSA uses/metadata for every load iteration: rejected as avoidable quadratic work.
- Increase limits to gain precision: rejected because performance and denominator changes are not
  required for the finding.

## Resolved unknowns

No `NEEDS CLARIFICATION` item remains. Current source, Phase 7 ownership, Spec Kit constitution,
guardrails, and the research backlog determine all material choices.
