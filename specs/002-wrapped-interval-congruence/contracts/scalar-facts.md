# Internal Contract: Canonical Phase 8 Scalar Facts

**Owner**: `js/decompiler/phase8/range.js` (domain) and
`js/decompiler/phase8/sccp.js` (producer/publication).
**Finding**: `HEX-C2-02`
**Status**: design contract; implementation must preserve existing public
compatibility views unless a versioned contract change is required.

## Inputs

The producer accepts the existing canonical Phase 8 context:

- Semantic IR values and operations with width and origin;
- canonical CFG edges, terminators, switch cases, and block IDs;
- canonical SSA IDs, definitions, uses, and phi predecessors;
- upstream Phase 8 transaction identity and versions; and
- deterministic work, edge, fact, cancellation, and memory budgets.

No consumer-local IR, architecture-name heuristic, solver result, or private
pointer/type/ABI fact is a valid input source.

## Canonical value operation

Conceptually:

```js
evaluateScalarFact(operation, operandFacts, context) -> BitVectorFact
```

The implementation may retain or adapt existing function names, but the result
must be the one canonical product used by SCCP. It must:

1. validate width, operands, masks, shifts, and operation support;
2. use width-exact `BigInt`/bitvector semantics;
3. preserve wrapped interval semantics in `Z/2^n`;
4. derive known bits/congruence only with a proof valid for every member;
5. normalize congruence (`modulus = 1` means no information);
6. preserve provenance and reason codes; and
7. return conservative/unsupported/malformed status instead of narrowing when
   the product cannot represent the result soundly.

## Edge refinement operation

Conceptually:

```js
refineEdgeFact(edge, predicate, incomingFacts, context) -> EdgeFactSet
```

Allowed predicates include canonical equality, inequality, signed/unsigned
constant bounds, valid constant-mask predicates, and complete switch case
predicates. Refinement rules are edge-local:

- true and false edges receive separately derived facts;
- the global facts map is unchanged by a single predicate;
- a mathematically impossible edge may be marked unreachable only with a proof;
- unknown or malformed predicates retain conservative reachability and facts;
- switch default excludes represented cases only when case coverage is explicitly
  complete, non-overlapping, and width-compatible; and
- an edge refinement that cannot be represented as one sound fact is omitted.

## Publication contract

`runSccpPass` continues to stage a `ScalarAnalysisResult` under the existing
`ranges` key through `runPassTransaction`.

- Results bind to `CanonicalAnalysisIdentity`.
- A result is `complete` only after bounded fixed-point work terminates without
  cancellation, malformed input, stale identity, or budget exhaustion.
- Cancellation, truncation, budget exhaustion, or contract failure must not
  overwrite the prior authoritative result as complete.
- Replacement increments the existing ranges version and invalidates consumers
  according to the existing dependency declaration.
- Edge keys, value IDs, diagnostics, and digest input are sorted/canonicalized;
  timing is not semantic.

## Consumer contract

GVN, induction, aggregate recovery, structuring, providers, switch/bounds, and
projection/query consumers read the extended result through the declared Phase 8
dependency path. They may consume a fact only after checking identity and
completeness. They must not independently recompute residues, known bits, path
conditions, pointer offsets, or scalar ranges.

## Required conservative behavior

The producer must withhold exactness for:

- one or more unmodelled operand values;
- any width/sign/mask/shift mismatch or malformed memory/IR value;
- incomplete or contradictory CFG/SSA/switch evidence;
- unknown alias-like inputs to scalar refinement, if surfaced at this boundary;
- stale identity, conflicting provenance, or invalid serialization;
- cancellation, deadline, work/edge/fact budget exhaustion, or truncated work;
- unsupported ABI/type/pointer provenance (these are not scalar permissions); and
- a non-singleton product, even if its endpoints or residue look narrow.

## Compatibility and versioning

The existing `ranges`/`constants` views remain available as immutable projections.
If edge facts/product fields alter a serialized shape or semantic interpretation,
the implementation must make the smallest corresponding producer/schema/contract
version change so pre-change artifacts are rejected. No hand-edited generated
artifact or alternate cache key is allowed.

## Contract test obligations

Tests must prove both positive and paired negative behavior for wrap, signed vs
unsigned comparisons, equality/inequality, switch/default, phi/loop widening,
known bits/residue, alignment/pointer offsets, impossible branches, stale and
malformed evidence, cancellation, budget exhaustion, deterministic replay, and a
direct downstream consumer. The same minimal pre-fix reproducer must fail at the
base and pass unchanged after implementation.
