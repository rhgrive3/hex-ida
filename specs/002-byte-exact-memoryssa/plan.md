# Implementation Plan: HEX-C2-01 Byte-Exact MemorySSA Forwarding

**Branch**: `feat/analysis-hex-c2-01` | **Date**: 2026-08-29 | **Spec**: `specs/002-byte-exact-memoryssa/spec.md`

**Input**: `HEX-C2-01` — byte-exact value forwarding must be derived from the canonical
MemorySSA proof, including complete byte coverage and ordered reconstruction.

## Summary

The current canonical MemorySSA builder records memory definitions, uses, alias relations,
clobbers, and access metadata, but the value boundary only exposes the one concrete store
reached by a load. This plan adds one canonical byte-forwarding query/consumer at that boundary.
It will validate the immutable MemorySSA contract and all identity, provenance, completeness,
order, alias, and access metadata before collecting byte lanes from concrete MemorySSA
definitions. It will reconstruct only fully covered loads using width-exact integer operations
and the declared endian contract, then publish one proof-bearing value fact through the existing
compatibility/value surface. Any hole, uncertainty, stale or malformed evidence, unsupported
effect, cancellation, or budget boundary remains non-exact.

`SECOND_SEMANTIC_TRUTH_CREATED: NO`

The implementation does not create another reaching-definition, alias, points-to, or memory
graph. MemorySSA remains the sole owner of reaching/clobber truth; the new consumer is a
deterministic projection of its validated definitions and uses.

## Technical Context

**Language/Version**: JavaScript ES modules, Node.js runtime used by the repository test runners

**Primary Dependencies**: Existing Semantic IR v2, canonical MemorySSA builder/contract/validator,
canonical alias provider, identity/provenance utilities, and Semantic IR v2→v1 compatibility
projection. No new dependency.

**Storage**: In-memory immutable analysis artifacts; no persistent storage or schema migration.

**Testing**: Node repository runners (`npm run semantic-v2:test`, focused `tests/semantic-v2/*.test.mjs`,
and the owning subsystem/phase runners).

**Target Platform**: Node.js and browser-compatible ES module code already supported by the
analysis library; no architecture-specific default is introduced.

**Project Type**: Static-analysis library with Semantic IR, compatibility projections, and
regression/integration test suites.

**Performance Goals**: Linear in the validated MemorySSA path and byte lanes for a query; every
walk is bounded by the supplied cancellation and resource/iteration budget. No unbounded graph
or quadratic whole-function scan is added.

**Constraints**: BigInt/width-exact lane arithmetic; no JavaScript `Number` conversion for byte
offsets or values; fail closed on malformed, stale, partial, cancelled, truncated, unsupported,
or budget-limited evidence; preserve existing APIs and diagnostics unless the new proof is valid.

**Scale/Scope**: One canonical MemorySSA query and its direct value consumer, with focused
positive/negative coverage for the C2-01 contract and one downstream precision assertion.

## Constitution Check

*GATE: Must pass before research/design and again before implementation.*

- **I — One Canonical Semantic Truth**: PASS. MemorySSA definitions/uses and its alias provider
  remain authoritative; the consumer only projects validated proof and does not compute a second
  reaching-definition or alias relation.
- **II — Explicit Uncertainty**: PASS. Any missing byte, clobber, ambiguity, identity mismatch,
  incomplete status, malformed evidence, or unsupported effect returns an explicit non-exact state.
- **III — Deterministic Proof**: PASS after the required pre-fix regression records the current
  failure, followed by paired positive/negative, malformed, cancellation/budget, replay, and
  downstream checks.
- **IV — Bounded/Cancellable**: PASS. Query traversal and lane reconstruction use checked BigInt
  ranges and the existing signal/budget contract.
- **V — Exact Product/Integration Proof**: PASS at delivery. Spec Kit convergence, exact-head CI,
  generated-output checks, candidate merge-tree validation, and live-main verification are
  required; no generated file is hand-edited.

## Research Summary

The graft trace and source inspection establish the following ownership:

1. `js/semantics/effects/index.js:createMemoryAccess` is the producer contract for width, endian,
   alignment, volatility, atomicity, ordering, and canonical address expressions.
2. `js/analysis/alias/regions-v2.js:classifySemanticMemoryRegion` and the existing region/identity
   contracts provide canonical memory-region identity and provenance.
3. `js/semantics/memoryssa/build.js:buildMemorySsa` is the only producer of definitions, uses,
   alias relations, clobber events, access metadata, and proof links.
4. `js/semantics/memoryssa/validate.js:validateMemorySsa` and
   `js/semantics/memoryssa/contract.js:createMemorySsaContract` are the validation boundary.
5. `js/semantics/memoryssa/queries.js:reachingConcreteStore` currently supports only one
   same-width concrete store and has no byte-coverage/reconstruction query.
6. `js/semantics/compat/semantic-ir-v2-to-v1-memory.js:attachMemorySsa` publishes that one-store
   result as legacy `reachingStore`; `propagateValues` is an immediate downstream consumer.

The first divergence is therefore the missing canonical MemorySSA-to-value byte-proof consumer,
not the architecture producers, region classifier, alias provider, or C1-02 range work.

## Planned Contract and Data Flow

```text
MachineEffects memory access
  -> Semantic IR memory node/access metadata
  -> canonical region + identity/provenance
  -> MemorySSA definitions/uses/alias/clobber proof
  -> validated byte-forwarding query (single canonical consumer)
  -> compatibility/value fact with proof identity
  -> scalar/value/points-to/decompiler consumers
```

For each load, the consumer will derive a width-exact byte interval from canonical access
metadata and inspect only MemorySSA-linked definitions reachable from the load use. It will
reject any path containing a phi, unknown/may/call/intrinsic clobber, missing or conflicting
metadata, non-must relation, unsupported volatile/atomic semantics, uncertain order, or identity/
completeness mismatch. For a complete path it will assign each byte to the latest proven store
in the canonical order, require every load lane to be assigned exactly once, and combine lanes
according to the declared endian. The resulting fact carries contributing definition IDs, source
origins, identity digest, and completeness; it is published atomically only after all checks
succeed.

`SECOND_SEMANTIC_TRUTH_CREATED: NO` is a hard plan gate. If implementation design would need a
new memory graph or independent alias/reaching-definition result, implementation is blocked and
the plan must be corrected.

## Expected Source/Test Structure

```text
js/semantics/memoryssa/
├── build.js                            # canonical byte-range/order/coverage publication
├── queries.js                         # canonical byte-proof query surface
└── ...                                # existing contract/validation remain owners
js/semantics/compat/
├── index.js                           # bind pipeline identity to MemorySSA artifacts
├── semantic-ir-v2-to-v1.js            # preserve/pass the validated MemorySSA artifact
├── semantic-ir-v2-to-v1-memory.js     # one compatibility/value publication boundary
└── semantic-ir-v2-to-v1-finalize.js   # consume the atomic exact-value fact
tests/semantic-v2/
└── issue-c2-01-byte-exact-forwarding.test.mjs
specs/002-byte-exact-memoryssa/         # durable Spec Kit evidence only
```

The exact source file list is finalized after the counterexample and implementation task
inspection. Existing architecture producers, legacy private MemorySSA, points-to-private
engines, decompiler-private ABI/value logic, workflows, and generated artifacts are not owned by
this lane.

## Identity, Provenance, and Invalidation

- **Identity**: binary, function, snapshot, Semantic IR contract, SSA/MemorySSA contract/build,
  analyzer/version, memory access entity IDs, and stable proof digest must match the query.
- **Provenance**: access origin, region identity, alias-provider proof, MemorySSA use/definition
  links, and every contributing store origin are retained. Rendered labels and architecture names
  cannot authorize exactness.
- **Completeness**: IR and MemorySSA validation state, provider state, cancellation, deadline,
  iteration, and resource budgets are checked before publication.
- **Invalidation**: changed IR/CFG/SSA/alias/access metadata, MemorySSA build, snapshot, analyzer
  identity, or relevant provenance invalidates the proof; no stale result is reused.

## Implementation Phases

1. **Counterexample and contract fixture** — add the smallest deterministic adjacent-store/wider-
   load regression to the owning semantic-v2 runner and record the current non-exact failure.
2. **Canonical query** — extend the existing MemorySSA query surface (or its directly owned
   module) with bounded byte-range coverage, ordered store selection, proof identity, and explicit
   non-exact reasons. Use BigInt and existing abort/budget contracts.
3. **Value publication** — connect exactly one compatibility/value boundary to the canonical query;
   publish only complete proof-bearing values and preserve current conservative behavior on every
   negative case.
4. **Focused corpus** — cover all required C2-01 positives and negatives, including both endian
   lanes where supported, overlap/order, MayAlias/unknown/call clobbers, malformed/stale identity,
   cancellation/deadline/budget/truncation, deterministic replay, and downstream precision.
5. **Subsystem/convergence** — run T0–T2 tests, canonical generated checks if applicable, Spec Kit
   converge until CLEAN, then prepare the actual diff for independent review and exact-head gates.

## Changed-File Allowlist / Forbidden Surface

Expected production files are limited to the canonical MemorySSA builder/query and direct
compatibility/value consumer, plus their direct tests. Spec Kit files under
`specs/002-byte-exact-memoryssa/` are expected process artifacts. No generated output is
expected.

Forbidden unless a later evidence-backed ownership decision is recorded: architecture effect
producers, `js/analysis/pointsto/**`, `js/decompiler/**`, legacy private MemorySSA in
`js/architecture/compat/**`, unrelated finding specs/tests, workflows/CI, and generated userscript
or distribution artifacts.

## Complexity Tracking

No constitution violations. No complexity exception requested.
