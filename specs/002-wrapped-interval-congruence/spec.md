# Feature Specification: HEX-C2-02 Wrapped Intervals, Congruence, and Branch Refinement

**Feature Branch**: `codex/hex-c2-02`

**Created**: 2026-08-29

**Status**: Draft

**Input**: Close HEX-C2-02 by extending the existing Phase 8 scalar facts with exact-width wrapped intervals, known bits, congruence, and conservative per-CFG-edge branch refinement.

## Context and Semantic Contract

- **FINDING_ID**: `HEX-C2-02`
- **PROBLEM**: Live `main` already publishes exact-width bitvectors, wrapped intervals, and executable-edge-aware SCCP, but it does not publish known-bit or value-congruence facts and cannot refine symbolic comparisons on individual CFG edges. Switch bounds, alignment/stride information, pointer offsets, and signed/unsigned branch facts therefore lose inexpensive precision before downstream consumers.
- **FIRST_DIVERGENCE**: `js/decompiler/phase8/range.js` widens all non-trivial bitwise operations to `full` and has no known-bit/congruence component; `js/decompiler/phase8/sccp.js` only folds comparisons when both operands are constants, so symbolic `eq`, `ne`, signed, and unsigned comparisons become overdefined and both branch edges retain the unrefined input fact.
- **CANONICAL_OWNER**: The existing Phase 8 `ranges` analysis: `js/decompiler/phase8/range.js` owns the scalar abstract domain and `js/decompiler/phase8/sccp.js` owns its CFG/SSA production and atomic publication. No second value-analysis owner may be introduced.
- **PRODUCER**: Canonical Semantic IR, CFG, and SSA producers provide width-exact values, operations, block edges, phi inputs, and origins; Phase 8 SCCP consumes those facts and produces `ranges`.
- **CANONICAL_FACT**: A versioned `ranges` result containing per-SSA-value wrapped interval, known-zero/known-one masks, congruence `(remainder, modulus)`, optional alignment/pointer-offset facts, and edge/block-entry refinement facts. `modulus = 1` means no useful congruence. Facts are over-approximations of reachable machine bit patterns.
- **IDENTITY_SOURCE**: Phase 8 transaction analysis versions, pass contract/registry version, canonical CFG/SSA identity, and the value/block IDs supplied by Semantic IR. Artifact descriptors continue to bind the result to their declared upstream identities.
- **PROVENANCE_SOURCE**: Semantic IR/SSA value and instruction `origin` records, plus CFG block/edge origins. Every published refined fact must retain the source IDs needed to explain its derivation.
- **COMPLETENESS_SOURCE**: SCCP work-list termination state and Phase 8 transaction result. `complete`, `partial`, `unknown`, cancellation, and budget exhaustion remain distinct; a partial run is never presented as a complete fixed point.
- **INVALIDATION_SOURCE**: The existing Phase 8 pass descriptor and transaction invalidation/version mechanism. Replacing `ranges` increments its analysis version and invalidates only facts that do not explicitly preserve the new result; stale artifacts are rejected by their existing identity contract.
- **DIRECT_CONSUMERS**: Phase 8 value numbering/GVN, loop-induction facts, aggregate recovery, structuring/providers, and the Phase 8 projection/query boundary that read the canonical `ranges` result.
- **DOWNSTREAM_CONSUMERS**: Decompiler switch/bounds and pointer-offset presentation, indirect-target/alias interval consumers, type/aggregate recovery, and user-visible semantic explanations that consume those projections.
- **SECOND_SEMANTIC_TRUTH_CREATED**: NO

The abstract facts are only permissions to describe or refine values. They are not permission to rewrite code, infer ABI/type truth, or treat a solver/provider result as ordinary scalar truth.

## User Scenarios & Testing

### User Story 1 - Preserve exact machine-width scalar facts (Priority: P1)

As a decompiler consumer, I need scalar facts to model the actual fixed-width machine value set, including wraparound, bit masks, and stride congruence, so that inexpensive precision improvements never exclude a reachable value.

**Why this priority**: Incorrect scalar narrowing is a soundness failure that can contaminate every downstream analysis. Exact machine semantics are the foundation for all later branch and pointer refinements.

**Independent Test**: Run architecture-neutral range and bitvector tests over widths 1, 8, 16, 32, 64, and 128. Compare each result against a small independent set oracle for wrapped arithmetic and verify that unsupported operations return an explicit conservative fact.

**Acceptance Scenarios**:

1. **Given** a 32-bit interval ending near `2^32-1`, **When** a constant add or subtract crosses the boundary, **Then** the result is a wrapped interval at 32 bits and never a mathematical integer outside that width.
2. **Given** an unconstrained value masked by a constant, **When** the mask proves zero and one bits or an alignment residue, **Then** those facts are published without claiming a singleton unless exactly one value remains.
3. **Given** a value set with a stride, **When** two facts are joined or a loop value is widened, **Then** the resulting interval, known bits, and congruence over-approximate both inputs and remain bounded.

### User Story 2 - Refine only the path that proves a condition (Priority: P1)

As a decompiler consumer, I need comparison, switch, phi, loop, and pointer-offset facts attached to the relevant CFG edge or block entry, so that one path can become precise without changing the global value truth for other paths.

**Why this priority**: Branch-sensitive precision improves switch recovery, bounds reasoning, and pointer-offset analysis, but globally mutating a value would create false exactness on paths where the condition is false or unknown.

**Independent Test**: Build deterministic architecture-neutral CFG/SSA fixtures for equality, inequality, signed and unsigned comparisons, mask predicates, switches, phi joins, natural loops, and pointer offsets. Assert edge facts, conservative joins, bounded widening, and absence of path leakage.

**Acceptance Scenarios**:

1. **Given** `x == 0` or `x != 0` with an unconstrained `x`, **When** each branch edge is analyzed, **Then** the true edge and false edge receive distinct sound refinements while the global fact for `x` remains unchanged.
2. **Given** signed and unsigned comparisons over the same bits, **When** the sign boundary changes the result, **Then** the corresponding edge uses the requested comparison domain and never swaps signedness.
3. **Given** a switch selector with known cases and a default edge, **When** edge facts are published, **Then** each case is refined to its case value and the default excludes only values proven covered by the represented cases; incomplete or malformed case evidence stays conservative.
4. **Given** a phi or loop-carried value, **When** incoming facts are merged or the fixed point reaches its resource limit, **Then** the join/widening is monotone and the result reports incomplete status instead of fabricating a singleton.

### User Story 3 - Keep scalar precision evidence lifecycle-safe (Priority: P1)

As an analysis pipeline owner, I need scalar facts to carry identity, provenance, completeness, and invalidation evidence, so that downstream consumers can use only current, complete facts and can explain why a refinement was accepted or withheld.

**Why this priority**: A precise fact from the wrong snapshot, a cancelled run, or malformed evidence is as unsafe as an incorrect arithmetic result.

**Independent Test**: Run the Phase 8 transaction, stale-identity, cancellation, budget, malformed-input, deterministic-replay, and downstream integration tests against the same fixture twice and inspect the exact published result and version changes.

**Acceptance Scenarios**:

1. **Given** a cancelled, truncated, budget-exhausted, stale, unsupported, or malformed analysis, **When** publication is attempted, **Then** no result is published as complete and the prior authoritative state is not silently replaced.
2. **Given** identical canonical CFG/SSA input and limits, **When** the scalar pass runs twice, **Then** facts, edge keys, diagnostics, and publication digest agree exactly apart from timing.
3. **Given** a complete refined scalar result, **When** GVN, induction, aggregate, or projection consumers read it, **Then** they observe the same canonical fact and gain only proof-backed precision; no consumer creates a private scalar domain.

### Edge Cases

- Widths outside the supported bitvector set, zero/negative widths, malformed masks, malformed comparator operands, and mixed-width operations remain unsupported or full with an explicit reason.
- Addition, subtraction, multiplication, shifts, truncation, zero extension, and sign extension must respect modular width, sign interpretation, and sign-bit boundaries; JavaScript `Number` precision must never be used for machine values.
- A non-singleton interval, wrapped interval, congruence with multiple members, or known-bit pattern with multiple members must never silently become an exact constant.
- Unknown, contradictory, or missing branch predicate evidence must not remove an edge. A mathematically impossible edge may be removed only when the canonical facts prove it impossible.
- Mask refinement must account for masks touching the sign bit and for shifted operands; invalid or non-constant masks remain conservative.
- Phi joins with unreachable, duplicate, contradictory, or missing predecessors must use only proven reachable predecessors and must retain unknown where reachability is not proven.
- Loop widening must terminate under deterministic work and visit budgets; cancellation or exhaustion reports partial rather than complete.
- Pointer-offset refinement must preserve the pointer's canonical provenance and address domain. Numeric congruence alone cannot mint pointer provenance.
- Switch case overlap, missing default, duplicate case values, unknown selector width, and incomplete case enumeration retain all unproven possibilities.
- Stale CFG/SSA/pass-registry/semantic identity, conflicting origins, malformed serialized facts, and publication after cancellation are rejected or withheld.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST extend the existing Phase 8 `ranges` fact and MUST NOT create a second scalar/value-analysis pipeline or private downstream range engine.
- **FR-002**: Every scalar fact MUST carry a supported exact bit width; arithmetic and bitwise operations MUST use width-exact `BigInt`/bitvector semantics and modular wrap.
- **FR-003**: The range domain MUST represent ordinary and wrapped intervals as reachable sets in `Z/2^n`, with empty and full states explicit and deterministic.
- **FR-004**: The scalar fact MUST optionally publish width-bounded known-zero and known-one bit masks. A bit not proven zero or one MUST remain unknown.
- **FR-005**: The scalar fact MUST optionally publish normalized congruence `x ≡ remainder (mod modulus)`, with `modulus = 1` representing no useful residue information. Remainders and moduli MUST be width-safe and deterministic.
- **FR-006**: Join and widening of interval, known-bit, and congruence components MUST be monotone over-approximations. Widening MUST have deterministic work/visit bounds and MUST discard precision rather than invent it when the product domain cannot represent the union.
- **FR-007**: Supported constant shifts, masks, extensions, truncations, additions, subtractions, and other operations MUST refine only when their result is sound for every member of the operand facts; unsupported or ambiguous operators MUST return a conservative fact with a reason.
- **FR-008**: The comparator model MUST distinguish equality/inequality, signed ordering, and unsigned ordering at the operand width, including `=`, `!=`, `<`, `<=`, `>`, and `>=` where the canonical IR represents them.
- **FR-009**: A comparison or mask predicate MAY refine operands only on its associated CFG edge/block-entry fact set. It MUST NOT mutate the global fact for a value into a path-specific answer.
- **FR-010**: Edge refinement MUST support equality, inequality, signed and unsigned bounds, valid constant-mask predicates, and mathematically impossible branches, while retaining both edges whenever the predicate or its operand evidence is unknown.
- **FR-011**: Switch case and default edges MUST receive conservative selector refinements when case evidence is complete and width-compatible; duplicate, overlapping, incomplete, or malformed cases MUST not be treated as exhaustive.
- **FR-012**: Phi joins MUST merge only proven executable predecessors, and loop-carried facts MUST converge through a bounded fixed point/widening policy without converting a non-singleton abstract value into an exact constant.
- **FR-013**: Alignment and pointer-offset refinement MAY be published only when canonical pointer provenance/address-domain evidence is present; scalar residues MUST NOT manufacture exact pointer identity.
- **FR-014**: The pass MUST expose explicit `complete`, `partial`, `unknown`, cancelled, unsupported, malformed, stale, and budget-limited outcomes through the existing Phase 8 transaction contract.
- **FR-015**: Every published value or edge fact MUST retain identity and provenance references to the canonical SSA value, defining operation, CFG block/edge, and input facts used to derive it.
- **FR-016**: Replacing `ranges` MUST use existing atomic staging, versioning, and invalidation. A failed or incomplete run MUST leave the prior authoritative state intact and MUST NOT publish a cancelled/truncated result as complete.
- **FR-017**: Direct consumers MUST read the extended canonical `ranges` result through the declared Phase 8 dependency path. They MUST NOT recompute congruence, known bits, branch facts, or pointer offsets privately.
- **FR-018**: The result and all diagnostics MUST be deterministic for identical input identities and budgets; wall-clock timing MUST NOT affect semantic facts or publication digest.
- **FR-019**: Regression coverage MUST include unsigned add/subtract wrap, signed extrema, signed/unsigned divergence, equality true/false, inequality, signed and unsigned ordering, `<=`, `>=`, switch case/default, phi join, loop widening/convergence, budget exhaustion, AND/shift known bits or residue, alignment, pointer offsets, impossible branches, stale artifacts, cancellation, and deterministic replay.
- **FR-020**: The downstream integration tests MUST prove an observable precision improvement while preserving all paired negative cases and all existing Phase 8/semantic behavior.

### Required Proof Matrix

The implementation lane MUST record the following minimum cases with exact commands and expected outcomes: unsigned add wrap; unsigned subtract wrap; signed minimum and maximum; signed versus unsigned divergence; equality true and false; inequality; signed `<`; unsigned `<`; `<=`; `>=`; switch case and default; phi join; loop widening and convergence; budget exhaustion; AND-derived information; shift-derived known bits/residue; alignment congruence; pointer offset refinement; a mathematically impossible branch; stale artifact; cancellation; and deterministic replay. The matrix also includes malformed evidence and at least one downstream precision consumer.

### Conservative Boundary

The only exact singleton is a one-element abstract set proved by the canonical facts. Any non-singleton abstract value MUST remain non-singleton. Missing bytes, bits, residues, branch predicates, pointer provenance, profile identity, origin, completeness, or budget evidence force `unknown`, `full`, `partial`, or another explicit conservative state. A refinement that cannot be represented exactly must be discarded or widened, never approximated by a tighter set.

### Non-Goals

- Rebuilding CFG, SSA, MemorySSA, alias, points-to, ABI, type, or symbolic-solver truth.
- Replacing the canonical Phase 8 transaction/publication mechanism or adding an alternate cache identity.
- An unrestricted relational theorem prover, unbounded path enumeration, or solver-dependent everyday value analysis.
- Decompiler-text heuristics, architecture-name heuristics, consumer-local scalar facts, or hidden fallback paths.
- Memory forwarding or ABI aggregate/prototype work owned by HEX-C2-01 and HEX-C3-02, except for compatibility with their declared downstream consumers.
- General program rewriting; this finding publishes analysis facts and does not authorize transformations.

### Forbidden Shortcuts

- Promoting unsupported, partial, stale, cancelled, truncated, budget-limited, malformed, or ambiguous evidence to exact.
- Treating an interval's endpoints as a mathematical integer interval after modular wrap, conflating signed and unsigned order, or using JavaScript `Number` for width-exact values.
- Mutating global value truth to encode one branch's fact, dropping an edge because it looks impossible, or treating an incomplete switch as exhaustive.
- Creating a private known-bit, congruence, branch, pointer-offset, or loop-analysis engine in a consumer.
- Deleting/weakening regressions, shrinking required corpora, widening allowlists, hand-editing generated artifacts, or using implementation self-agreement as an oracle.

### Identity, Provenance, and Completeness Boundaries

Identity must bind binary/function/snapshot/Semantic IR/SSA/pass-registry and analyzer version through the existing Phase 8 artifact and transaction contracts. Provenance must point to canonical SSA values, operations, CFG blocks/edges, and input fact origins. Completeness must be preserved through every consumer; no consumer may treat partial/unknown facts as complete merely because a shape is present.

## Key Entities

- **BitVectorFact**: A fixed-width machine value fact containing the width, optional exact constant, wrapped/ordinary interval, known-zero mask, known-one mask, and normalized congruence.
- **EdgeFactSet**: A block-entry/CFG-edge mapping from SSA value IDs to conservative `BitVectorFact` refinements, with predicate, source edge, and origin references.
- **ScalarAnalysisResult**: The versioned `ranges` artifact containing global facts, edge facts, diagnostics, completeness, work/budget measurements, and deterministic publication identity.
- **CanonicalAnalysisIdentity**: The CFG/SSA/value-origin/pass-registry/semantic-schema identity used to accept, invalidate, or reject a scalar result.

## Success Criteria

### Measurable Outcomes

- **SC-001**: The required proof matrix in this specification passes 100% on the exact implementation head, including every paired negative and malformed/stale/cancelled/budget case.
- **SC-002**: The smallest pre-fix equality/ordering and congruence reproducers fail on live `main` and the identical regressions pass after implementation without changing their expected outcomes.
- **SC-003**: An independent adversarial corpus containing at least one case for each conservative boundary produces zero false exact singleton, false branch exclusion, false pointer provenance, or stale complete publication.
- **SC-004**: Two deterministic runs over identical canonical identities produce byte-for-byte equivalent semantic facts, edge keys, diagnostics, and publication digest; timing may differ but does not enter the digest.
- **SC-005**: Every run terminates within configured deterministic work/memory/visit budgets, and exhausted or cancelled runs are explicitly partial/withheld rather than complete.
- **SC-006**: At least one direct downstream consumer (switch/bounds, induction, pointer offset, alias interval, or decompiler projection) observes a proof-backed precision improvement on a positive fixture while all paired negatives remain conservative.
- **SC-007**: Existing Phase 8 and broader semantic regression suites retain their pre-change pass rate, with no new false exactness or stale-publication failures.

## Assumptions

- Canonical Semantic IR, CFG, SSA, origins, and the Phase 8 transaction/version system remain the authoritative producers and publication boundary.
- The implementation is browser-native JavaScript and must use `BigInt`/width-bounded operations; no native solver or architecture-specific fallback is required for this finding.
- Existing Phase 8 tests are architecture-neutral where they test the generic domain; real-binary corpus tests remain a separate integration gate.
- C2-01 may merge before final integration and will be reconciled once before Review 2 and once before merge. No C2-02 production dependency is assumed unless the reconciled diff changes the scalar owner or direct consumer contract.
- Generated userscript output is owned by the integration/release lane. This component lane may build it ephemerally but must not commit it.
