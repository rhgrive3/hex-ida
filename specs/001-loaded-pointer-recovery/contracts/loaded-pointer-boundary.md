# Contract: MemorySSA Loaded-Pointer Boundary

## Purpose

This internal contract defines when canonical MemorySSA evidence may refine a load from
`unresolved-load` to an existing finite points-to set.

## Eligibility

Recovery is eligible only when all conditions are true:

1. The boundary binding is current, complete, version-supported, and for the same immutable
   function/snapshot as IR, CFG, SSA, and points-to analysis.
2. The load is complete, has one pointer-typed output, and has one non-broad MemorySSA use whose
   source entity and access metadata match the current load node.
3. `reachingConcreteStore` returns one MustAlias concrete memory definition for that use.
4. The definition identifies one complete store with one non-address stored value.
5. Load and store access width and endian are equal; the stored and loaded value widths equal that
   access width. Every byte is covered by the same exact definition.
6. Load and store are explicitly non-volatile and non-atomic. Unknown sequencing refuses recovery.
7. The stored value already has a finite, non-top points-to set with compatible current provenance.
8. No unknown clobber, incomplete call, partial memory effect, phi ambiguity, cancellation,
   truncation, resource limit, or unsupported reconstruction participates in the proof.

## Result

- On eligibility, return a new immutable points-to set containing the stored fact's targets and
  evidence without changing root, offset, width, or provenance.
- On any failure, return the existing `unresolved-load` result or a weaker explicit conservative
  state. Returning a partial target set is forbidden.
- The refined per-function result becomes authoritative only when the entire fixed-point run is
  complete and current.

## Publication and invalidation

- Baseline and refined runs are separate immutable results.
- Install the refined run atomically only after final cancellation, identity, completeness, and
  deterministic-budget checks.
- Invalidate cached escape analysis after successful installation.
- Never rebuild or mutate MemorySSA from the refined answer.

## Explicit non-goals

- Multi-store/partial-byte reconstruction.
- Atomic or volatile forwarding.
- Return-pointer summaries.
- Target-specific pointer heuristics.
- Decompiler-private recovery.
- Changes to MemorySSA, Semantic IR, SSA, CFG, target, or identity contracts.
