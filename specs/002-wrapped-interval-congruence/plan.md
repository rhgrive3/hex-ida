# Implementation Plan: HEX-C2-02 Wrapped Intervals, Congruence, and Branch Refinement

**Branch**: `codex/hex-c2-02` | **Date**: 2026-08-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-wrapped-interval-congruence/spec.md`

## Summary

Extend the existing Phase 8 SCCP/range owner with a width-exact product domain: wrapped intervals, known-zero/known-one masks, normalized congruence, and conservative edge/block-entry refinements. Preserve the current `ranges` compatibility view while deriving it from one immutable scalar-fact object. Add only bounded comparison, mask, switch, phi, loop, alignment, and pointer-offset refinements that can be proven from canonical CFG/SSA facts. Keep global facts path-insensitive and attach conditional facts to edge/block-entry records. Continue using Phase 8 transaction staging, identity, provenance, completeness, cancellation, and invalidation rather than adding a publication path.

## Technical Context

**Language/Version**: JavaScript ES modules on the repository's supported Node/browser runtime; `BigInt` is mandatory for machine integers.

**Primary Dependencies**: Existing Phase 8 `bitvector.js`, `range.js`, `sccp.js`, transaction/pass contract, canonical Semantic IR/CFG/SSA and origin records. No solver, native library, or new runtime dependency.

**Storage**: In-memory immutable Phase 8 analysis state and its existing artifact/transaction publication boundary; no persistent schema or generated artifact is owned by this lane.

**Testing**: Node built-in test runner through `tests/phase8/run.mjs`, architecture-neutral fixtures, Phase 8 owning-subsystem runner, and existing repository gates. Required failures are proved with the smallest deterministic tests before implementation.

**Target Platform**: Browser-native decompiler path, including iOS/iPadOS/WebKit constraints; generic scalar logic must remain architecture-neutral.

**Project Type**: Browser-first universal binary-analysis/decompiler library and application.

**Performance Goals**: Bounded monotone analysis with deterministic work, visit, fact, edge, and memory caps. Ordinary Phase 8 fixtures must remain within the existing standard budget; no quadratic all-terminator rescans or unbounded edge-state growth.

**Constraints**: Preserve existing Phase 8 pass ordering and transaction semantics. Use width-safe `BigInt` arithmetic only. Unknown, unsupported, stale, partial, cancelled, malformed, and resource-limited facts remain explicit. Component CI may build generated userscript output ephemerally but must not commit it.

**Scale/Scope**: Supported widths are the existing Phase 8 set (1, 8, 16, 32, 64, 128). The product domain is function-local and CFG-bounded; edge refinements are capped and collapse conservatively when the cap is reached. No whole-binary path enumeration.

**SECOND_SEMANTIC_TRUTH_CREATED**: NO. The existing Phase 8 `ranges` analysis remains the only scalar semantic owner; compatibility maps are immutable projections of that result.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. One Canonical Semantic Truth — PASS**: `range.js` remains the domain owner and `sccp.js` remains the producer/publication owner. CFG/SSA/origins are consumed from upstream. No consumer-local range or solver engine is planned.
- **II. Uncertainty Is Explicit — PASS**: Non-singleton facts never become exact. Unsupported operations, missing evidence, stale identities, cancellation, truncation, malformed values, and budget exhaustion retain explicit conservative states.
- **III. Deterministic Proof Before Promotion — PASS**: The task sequence begins with minimum regressions and recorded pre-fix failures, followed by paired negatives, deterministic replay, malformed/stale/resource cases, and downstream proof. No implementation task precedes `ANALYZE = CLEAN` and Sol spot-check approval.
- **IV. Bounded, Cancellable, Portable Analysis — PASS**: All new edge/domain work uses deterministic caps and existing cancellation checkpoints. Arithmetic is architecture-neutral and width exact; no browser/platform dependency is added.
- **V. Exact Product and Integration Proof — PASS**: Pass/version/registry identity and transaction versions bind the result. The component owns no committed generated output. Exact-head CI, candidate merge-tree validation, moving-main reconciliation, merge, and post-merge live-main proof remain release gates.
- **Process guardrails — PASS**: Actual-file ownership, independent review, current-main collision checks, no generated hand edits, and evidence invalidation are explicit in the tasks and quickstart.

## Repository Trace and Canonical Ownership

### Producer → consumer chain

1. Canonical Semantic IR/CFG/SSA producers (`js/semantics/ir/**`, `js/semantics/cfg/**`, `js/semantics/ssa/**`) provide machine-width operations, value IDs, block/edge topology, phi inputs, and origin evidence.
2. `js/decompiler/phase8/transaction.js` seeds and version-binds those facts; it is the only state publication boundary.
3. `js/decompiler/phase8/range.js` owns pure wrapped interval and product-domain operations.
4. `js/decompiler/phase8/sccp.js` owns executable-edge propagation, global fact joins, edge/block-entry refinement, diagnostics, completeness, and the `ranges` result staged through the existing transaction.
5. Direct consumers read the result through Phase 8: `valuenumber.js`, `induction.js`, `aggregates.js`, `structuring.js`, `providers.js`, and projection/query code.
6. Downstream decompiler switch/bounds, pointer-offset, alias interval, type/aggregate, and explanation projections consume those declared facts; none derives an alternative scalar truth.
7. Existing identity/provenance/invalidation code (`phase8/artifact-identity.js`, transaction versions, IR origins) rejects stale or unsupported publication.

### Graft summary (compressed; actual CLI trace)

`Semantic IR/CFG/SSA → range.js:evaluateBinaryRange (L119-L164) → sccp.js:evaluate (L275-L423) / processTerminator (L425-L452) / runSccpPass (L146-L591) → transaction.js:runPassTransaction (L127-L190) / invalidationFor (L114-L118) → artifact-identity.js:createPhase8ArtifactDescriptor (L75-L126) → GVN/induction/aggregate/structuring/providers → projection/query/tests`.

Graft callers confirm `evaluateBinaryRange` is called by SCCP and the scalar
range tests; `runSccpPass` is imported by the Phase 8 registry/pipeline and
scalar, memory, loop, provider, structuring, corpus, identity, budget, and
verifier tests. `runInductionPass` reads `analysis.get('ranges')`; transaction
and invalidation tests cover the publication boundary. The actual Graft trace
found no competing scalar producer.

Identity is the Phase 8 pass/registry/contract plus CFG/SSA versions and canonical value/block IDs. Provenance is value/instruction/block/edge origin. Completeness is SCCP fixed-point/work-budget state carried through the transaction. The existing `ranges` result is the sole scalar semantic object; `ranges` and `constants` compatibility views are derived from immutable facts.

## Design Details

### Product-domain representation

- Keep the existing `Range` shape (`bits`, `kind`, `lower`, `upper`) and pure APIs source-compatible for current consumers.
- Add an immutable scalar-fact constructor and operations in `js/decompiler/phase8/range.js`. A fact contains the range plus width-bounded `knownZero`, `knownOne`, normalized `{ remainder, modulus }`, optional alignment, optional pointer-offset descriptor, and provenance references.
- The canonical SCCP map stores one fact per SSA value. Existing `result.ranges` and `result.constants` remain deterministic read-only projections derived from those facts, not independently updated maps.
- Known masks intersect on joins; overlapping known-zero/known-one bits are malformed and force an explicit unknown/full result. All masks are normalized with the declared width.
- Congruence uses `modulus = 1` for no information. Constant facts may use the width modulus for exact values. Add/sub/multiply-by-constant/left-shift/mask trailing-zero rules are admitted only where modular arithmetic proves them; joins use a gcd-style common divisor and discard unsupported residue information.
- A product-domain fact is exact only when its represented set is a singleton and identity/provenance/completeness are valid. A non-singleton product cannot be emitted as a constant.

### Sound operation coverage

- Preserve existing exact add/sub/cast behavior and extend constant shifts, constant multiplication, mask-derived known bits, and trailing-zero congruence where the result is exact for every operand member.
- For operations whose exact set cannot fit the domain (including arbitrary two-range bitwise operations, unsafe signed conversions, invalid shifts, unsupported widths, and ambiguous relational closure), return full/unknown with a reason.
- Every candidate operation is checked against width, signedness, and modular wrap before publication. No JavaScript `Number` participates in machine-value arithmetic.

### Edge/block-entry refinement

- Maintain an immutable map keyed by canonical edge identity (`from`, `to`, `kind`) or block-entry identity. Each entry maps SSA value IDs to derived product facts and carries the predicate and origin IDs.
- Derive comparison predicates only from canonical IR definitions. Support equality/inequality and signed/unsigned constant bounds in both true and false directions. Treat a non-representable complement as no refinement rather than a false interval.
- Derive mask predicates only when the mask and compared value are width-compatible constants and the implied known bits/residue are mathematically valid.
- For switches, consume explicit canonical case values when present; case facts are exact only for width-compatible cases. Default excludes represented cases only when case enumeration is complete and non-overlapping; otherwise it retains unproven values.
- Do not mutate the global fact when creating an edge fact. At block merges, join incoming edge facts conservatively. A contradictory edge is marked unreachable only when the canonical fact proves it impossible.
- Propagate edge facts through a bounded work list. Loop headers use monotone joins and deterministic widening; once resource limits are hit, preserve an explicit partial result and never publish a singleton from an unfinished state.
- Pointer offset and alignment facts may refine an existing pointer only when its canonical provenance/address domain is present. A numeric residue never creates provenance.

### Publication, identity, and invalidation

- Bump the SCCP producer version and, if the serialized result shape requires it, the Phase 8 contract/schema version so old artifacts cannot be reused. The pass registry digest must change with the producer version.
- Stage the complete `ranges` result through `runPassTransaction`; cancellation, thrown errors, malformed facts, stale identity, and post-run budget checks leave prior state untouched.
- Include edge facts and product-domain data in deterministic result/digest serialization with sorted IDs/keys. Exclude timing.
- Keep generated userscript files, release version files, and unrelated issue-owned paths out of this lane.

## Dependency Graph

```text
canonical Semantic IR/CFG/SSA/origins
          │
          ▼
Phase 8 transaction identity + seeded state
          │
          ▼
range.js product domain ──► sccp.js global/edge facts
          │                         │
          │                         ▼
          └──────────────► GVN / induction / aggregate / structuring / providers
                                      │
                                      ▼
                         decompiler projections and queries
```

- C2-01 is not required to implement or validate this scalar producer: C2-02 consumes only canonical CFG/SSA and existing transaction facts. C2-01 may change adjacent downstream memory/offset consumers, so the integration owner must refetch and rerun those consumers after C2-01 merges.
- C3-02 is independent; its ABI/prototype files are forbidden in this component lane. Any current-main change to a shared Phase 8 contract invalidates this plan's evidence and requires reconciliation.
- Generated output remains integration-owned.

## Implementation Boundary and Ownership

### Expected component files

- `js/decompiler/phase8/range.js` — canonical interval/product-domain operations.
- `js/decompiler/phase8/sccp.js` — canonical producer, edge propagation, joins, fixed-point/budget handling, and result projections.
- `js/decompiler/phase8/bitvector.js` — only if a missing width-safe helper is proven necessary; no duplicate arithmetic.
- `js/decompiler/phase8/index.js` — exports for canonical domain/query helpers if required by consumers/tests.
- `js/decompiler/phase8/contract.js` — only the minimum pass/contract version bump required by result-shape invalidation.
- `tests/phase8/helpers/ir-fixtures.mjs` — canonical fixture metadata for comparisons, switch case values, pointer provenance, and edge identities.
- `tests/phase8/scalar/range.test.mjs`, `tests/phase8/scalar/sccp.test.mjs`, and one focused `tests/phase8/scalar/c2-02*.test.mjs` — positive, negative, boundary, stale/cancel/budget, replay, and downstream regressions.
- `tests/phase8/integration/**` — only the minimal direct-consumer regression needed to prove a downstream precision improvement.

### Forbidden component files

- `js/analysis/pointsto/**`, `js/semantics/memoryssa/**`, `js/decompiler/types/prototype.js`, and any C2-01/C3-02 canonical owner files.
- `userscript/**`, release-version/generated templates, unrelated `tools/validation/**`, and Issue-Agent-owned files.
- New parallel scalar engines, solver adapters, private pointer/ABI/type analyses, or alternate artifact/cache identity modules.

Actual changed-file inventory must be checked against this list before review and before merge. If a required shared contract file is touched by concurrent work, stop and reconcile rather than silently broadening ownership.

## Minimal Failing Cases (before implementation)

1. **Congruence gap**: an unconstrained 32-bit value `x` plus a constant `4` has no canonical congruence in current `ranges`; the pre-fix assertion requires a normalized residue/modulus fact (at minimum a mask-derived trailing-zero case such as `x & 0xFC`). Current behavior returns `full` with no congruence field.
2. **Comparison/edge gap**: an unconstrained 8-bit `x` compared with `x <u 10` (and a signed sign-boundary pair) leaves both edges executable with no edge-specific range fact. The pre-fix assertion requires true edge `[0,9]`, false edge `[10,255]` for the unsigned constant-bound case, while the global `x` fact remains full.

The pre-fix command and exact failure are recorded in `quickstart.md` and the implementation checkpoint. These tests are added before production edits and run against `8a614ccd0184d6c25257c25d930b68af7e9ac81f`.

## Test Strategy and Evidence Gates

### T0 — preflight and contract

- `node --check` on changed JavaScript modules.
- Markdown/spec/plan/tasks/checklist schema checks.
- Actual changed-file ownership and forbidden-path checks.

### T1 — deterministic scalar lane

- Run the minimum failing cases and prove failure before implementation.
- Run all required range/bitvector/SCCP positives and paired negatives: unsigned add/sub wrap; signed extrema; signed/unsigned divergence; equality/inequality/order bounds; switch case/default; phi; loop widening/convergence; budget; AND/shift known bits/residue; alignment; pointer offsets; impossible branch; stale/malformed/cancelled; replay.

### T2 — subsystem/downstream

- `node tests/phase8/run.mjs --filter scalar` (or the repository's actual runner filter) and `npm run phase8:test`.
- Direct GVN/induction/aggregate/structuring/projection regression proving at least one downstream precision gain and no private recomputation.
- Existing Phase 8 determinism, completeness, invalidation, and artifact-identity tests.

### T3 — release proof (integration owner)

- Reconcile once with current `main`, rerun changed-surface and Phase 8 gates on exact head.
- Canonical generated build #1 and #2 with zero additional diff; this lane commits no generated output.
- Exact-head CI, independent verifier, candidate merge-tree validation, expected-head merge, live-main refetch, and post-merge verification.

## Phase 0 Research Decisions

### Decision 1: Extend `range.js` rather than create a scalar engine

- **Decision**: Keep `range.js` as the canonical domain and make SCCP the only producer.
- **Rationale**: The current Phase 8 result and all direct consumers already flow through this owner. A new module would duplicate truth and create identity/invalidation drift.
- **Alternatives considered**: A solver-backed value engine (too expensive and not a canonical everyday proof); consumer-local facts (forbidden by the constitution).

### Decision 2: Publish edge facts separately from global facts

- **Decision**: Store immutable edge/block-entry refinements and retain a path-insensitive global join.
- **Rationale**: A branch fact is only valid on its edge; mutating global truth would cause false exactness on sibling paths.
- **Alternatives considered**: Mutating the value's global range (unsound); enumerating every path (unbounded and unnecessary).

### Decision 3: Use an explicit no-information congruence

- **Decision**: Normalize no congruence to `{ modulus: 1, remainder: 0 }` and retain width bounds.
- **Rationale**: A single canonical representation makes joins, digesting, and consumers deterministic.
- **Alternatives considered**: `null`/missing (ambiguous between no proof and missing producer); arbitrary modulus (can imply false precision).

### Decision 4: Keep unsupported operations conservative

- **Decision**: Return full/unknown plus reason when the product domain cannot represent an exact result.
- **Rationale**: The feature improves precision only where proof is cheap and exact; unknown is safer than a fabricated interval.
- **Alternatives considered**: Endpoint arithmetic or heuristic residue propagation (false-exactness risk at wrap/sign boundaries).

## Phase 1 Design Artifacts

See [data-model.md](data-model.md), [contracts/scalar-facts.md](contracts/scalar-facts.md), and [quickstart.md](quickstart.md). All unknowns from Technical Context are resolved; no unresolved clarification gate remains.

## Constitution Check — Post-Design

- **Canonical ownership**: PASS; one Phase 8 scalar fact owner, no duplicate engine.
- **Conservative exactness**: PASS; singleton promotion requires a one-element represented set plus valid identity/provenance/completeness.
- **Bounded/cancellable**: PASS; product and edge propagation have deterministic caps and existing transaction cancellation.
- **Deterministic evidence**: PASS; facts/keys/diagnostics are sorted and timing is excluded from semantic digest.
- **Ownership/generated output**: PASS; expected files are narrow and generated output is integration-owned.
- **Dependency/moving main**: PASS; C2-01 and C3-02 remain separate; fresh-main reconciliation occurs before Review 2 and merge.

## Complexity Tracking

No constitution violations are proposed. The product domain and edge map are extensions of the existing owner, not additional projects or semantic authorities.
