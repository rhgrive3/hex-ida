# Research Notes: HEX-C2-02

**Date**: 2026-08-29
**Base**: `8a614ccd0184d6c25257c25d930b68af7e9ac81f`
**Finding**: `HEX-C2-02`

## Scope and repository evidence

This is a component-lane research record, not a second scalar implementation.
The campaign supervisor explicitly required the actual Graft CLI, so `graft map`,
`graft ask --source`, `graft callers`, and `graft grep` were run from this lane.
Graft refreshed its graph from the main checkout before answering; the
compressed results below are the authoritative trace and must be rechecked if
the lane is restacked onto a moving `main`.

Relevant current-main evidence:

- Graft `ask --source` resolves `evaluateBinaryRange` at
  `js/decompiler/phase8/range.js:L119-L164`; it calls `rangeOf`, `cardinality`,
  `fullRange`, and width-safe `unsignedOf`. The same query resolves SCCP's
  `evaluate` at `js/decompiler/phase8/sccp.js:L275-L423`, which calls the range
  evaluator, joins, casts, and bitvector helpers.
- Graft resolves `runSccpPass` at `js/decompiler/phase8/sccp.js:L146-L591` and
  `processTerminator` at `L425-L452`. The producer owns executable-block/value
  worklists and stages the sole `ranges` result; current symbolic non-constant
  terminators mark both edges executable but publish no edge fact map.
- Graft traces `runPassTransaction` at
  `js/decompiler/phase8/transaction.js:L127-L190` to `invalidationFor:L114-L118`,
  and `createPhase8ArtifactDescriptor` at
  `js/decompiler/phase8/artifact-identity.js:L75-L126` to canonical artifact
  identity/digest helpers. Cancellation, staged-key mismatch, and contract
  violations are refused before authoritative state changes.
- Graft callers identify direct production/test consumers: `runInductionPass`
  (`js/decompiler/phase8/induction.js:L420-L825`) reads `analysis.get('ranges')`
  and its `constants`; `valuenumber.js`, `aggregates.js`, `structuring.js`, and
  `providers.js` are Phase 8 consumer modules. The result must be extended at
  this owner rather than recomputed in consumers.
- Graft traces tests through `tests/phase8/scalar/range.test.mjs`,
  `sccp.test.mjs`, and this lane's `c2-02-pre-fix.test.mjs`; lifecycle/integration
  edges include `tests/phase8/substrate/invalidation.test.mjs`,
  `completeness.test.mjs`, `tests/phase8/memory/gvn.test.mjs`, loop/provider/
  structuring tests, and Phase 8 validation tools.
- `docs/flash.md` and `docs/PHASE8_CHECKPOINT.md` identify the same remaining gap:
  wrapped ranges exist, while known bits, congruence, and edge-sensitive
  refinement are not yet canonical facts.

## Decision 1 — Extend the existing range/SCCP owner

**Decision**: Add the product-domain operations to `range.js` and have `sccp.js`
produce and publish them. Keep `result.ranges` and `result.constants` as
compatibility projections of one fact map.

**Reasoning**: `range.js` is already the pure abstract-domain owner and `sccp.js`
is already the CFG/SSA producer and transaction publisher. Moving ownership to a
new module or to a consumer would create a second semantic truth, duplicate
identity handling, and make invalidation unsound.

**Rejected alternatives**:

- A solver-backed everyday value engine: it is not the canonical IR fact source,
  has an avoidable resource/cancellation surface, and would not solve publication
  identity by itself.
- A GVN/induction/provider-local residue or branch analysis: it violates the
  single-owner rule and would make two consumers disagree.
- Treating the existing endpoint range as a congruence: wrapped endpoints do
  not encode all reachable machine values and can produce false exactness.

## Decision 2 — Use an explicit product fact

The canonical value fact is an immutable object containing:

1. exact width and a wrapped `Range`;
2. width-bounded `knownZero` and `knownOne` masks;
3. normalized congruence `{ remainder, modulus }`;
4. optional alignment/pointer-offset evidence only when canonical pointer
   provenance is present; and
5. provenance and derivation references.

The product is an over-approximation. A `constant` projection is legal only when
the represented set is a singleton and identity, provenance, and completeness
are valid. The existence of a mask or residue never makes a multi-value fact
exact.

## Decision 3 — Normalize congruence deterministically

Represent no useful residue information as `{ modulus: 1n, remainder: 0n }`.
For a width `n`, all residues are reduced modulo `2^n`; the stored modulus is
positive, bounded by `2^n`, and the remainder is in `[0, modulus)`. A singleton
may use modulus `2^n` (or the contract's equivalent exact representation), but
the singleton check still uses the represented set, not the modulus alone.

For joins, retain only a common congruence: compute a sound common divisor of the
operand moduli and compatible residue difference, otherwise normalize to modulus
1. Widening may discard residue and known bits, never invent them. Unsupported
operations return a full/unknown fact with a machine-readable reason.

## Decision 4 — Keep global facts path-insensitive

The global fact map remains the join of all proven executable paths. A comparison
or switch predicate creates an immutable `EdgeFactSet` keyed by canonical CFG
edge/block-entry identity. The edge map may narrow `x` on `x <u 10`'s true edge,
while the global `x` remains full. At joins, incoming edge facts are joined;
missing, contradictory, or unproven predecessor evidence is not silently treated
as an exact input.

An impossible edge may be marked unreachable only if the canonical fact proves it
impossible. Unknown predicates retain both edges. A refinement that cannot be
represented soundly is omitted and the edge remains conservative.

## Decision 5 — Admit only width-exact, bounded operation rules

The implementation may refine where the result is proven for every member of the
operand facts:

- wrapped add/subtract and supported casts use `BigInt` modulo `2^n`;
- constant masks derive known-zero/known-one bits and trailing-zero congruence;
- supported constant shifts derive known bits/residues only after validating the
  shift width and direction;
- constant bounds distinguish signed and unsigned domains at the operand width;
- equality/inequality and complete, non-overlapping switch cases refine only the
  associated edge; and
- pointer offsets/alignment require an existing canonical pointer provenance and
  address domain.

Arbitrary two-range bitwise combinations, malformed widths/masks, mixed-width
  comparisons, unsupported operators, ambiguous switch coverage, and incomplete
  resource runs remain full/unknown/partial. No JavaScript `Number` operation is
  permitted for machine values.

## Decision 6 — Reuse lifecycle and publication contracts

SCCP continues to run through `runPassTransaction`. The result includes explicit
  completeness and diagnostics. Cancellation, budget exhaustion, malformed input,
  stale identity, or a serialization/contract mismatch must not publish a result
  as complete or overwrite the prior authoritative state. Any producer/schema
  version bump is the minimum needed to reject old range artifacts.

Facts and edge keys must be sorted for deterministic serialization/digesting;
timing is excluded. Deterministic replay uses identical CFG/SSA identities and
budgets and compares semantic facts, diagnostics, and publication digest.

## Dependency decision — C2-01 is not a production blocker

C2-02 reads canonical CFG/SSA and current Phase 8 transaction state; it does not
consume byte-exact MemorySSA forwarding. Therefore C2-01 is not a production
dependency for this lane. C2-01 may alter an adjacent downstream memory/offset
consumer, so the lane must refetch current `main` after that merge, compare
overlapping files and generated inputs, and rerun any affected direct/downstream
tests before Review 2 and again before merge. A shared Phase 8 contract change
would invalidate this evidence and require targeted reconciliation.

## Clarify result

The feature description, current owner, conservative boundary, required proof
matrix, publication identity, and dependency policy resolve all critical
ambiguities. No clarification question is outstanding. The only implementation
choice intentionally left to code review is which existing width-safe helper in
`bitvector.js` can be reused; adding a helper is allowed only after the current
API is inspected and duplication is disproven.

## Open risks carried to implementation/review

- A wrapped interval alone cannot safely derive every bitwise result; each rule
  needs a proof or must return full.
- Complementing an inequality may be non-representable as one interval; omit that
  refinement instead of excluding values incorrectly.
- Edge-map growth and loop propagation must have deterministic caps and preserve
  partial status on exhaustion.
- Existing consumers may assume the old `ranges` shape; compatibility projection
  changes need focused tests and, if serialized, a contract/version update.
- C2-01/C3-02 moving-main changes must not be hidden by a blind rebase.
