# Feature Specification: HEX-C2-01 Byte-Exact MemorySSA Forwarding

**Feature Branch**: `feat/analysis-hex-c2-01`

**Created**: 2026-08-29

**Status**: Draft — implementation candidate; independent review and delivery gates pending

**Input**: User description: "Close HEX-C2-01 byte-exact MemorySSA forwarding with canonical
MemorySSA proof, wrapped byte coverage, ordered reconstruction, conservative barriers, and
downstream precision without a second memory truth."

## Finding Contract

- **FINDING_ID**: `HEX-C2-01`
- **PROBLEM**: Canonical MemorySSA already identifies memory reads, writes, alias relations,
  clobbers, and reaching definitions, but the value-forwarding boundary does not yet publish a
  byte-exact value when a load is covered by several ordered writes. A partial or ambiguous write
  must not be mistaken for a complete value.
- **FIRST_DIVERGENCE**: The canonical MemorySSA proof stops at a region-level reaching definition;
  compatibility/value consumers either expose one exact same-width store or leave the load
  unresolved. No canonical byte-coverage/order fact bridges multiple proven writes into one load
  value.
- **CANONICAL_OWNER**: The existing canonical MemorySSA consumer/value-fact layer, centered on
  `js/semantics/memoryssa/**` for memory truth and its one value-forwarding consumer. The
  forwarding layer consumes MemorySSA and never becomes a second reaching-definition authority.
- **PRODUCER**: MachineEffects lowers each supported load/store/call/intrinsic into Semantic IR
  memory operations with width, address expression, endian, sequencing, origin, and completeness.
  The canonical MemorySSA builder then publishes regions, definitions, uses, alias relations,
  clobbers, access metadata, and proof provenance.
- **CANONICAL_FACT**: A load may receive an exact value only from a validated MemorySSA proof
  whose contributing writes collectively cover every load byte exactly, in a proven byte order,
  with a proven store order and no intervening uncertain clobber. Missing or disputed bytes make
  the fact non-exact.
- **IDENTITY_SOURCE**: Binary, function, snapshot, Semantic IR contract, SSA/MemorySSA contract,
  MemorySSA build/analyzer identity, access entity IDs, and deterministic proof digest supplied by
  the existing identity contracts.
- **PROVENANCE_SOURCE**: Memory access origins, canonical region identity, alias-provider proof,
  MemorySSA definition/use links, and contributing store origins. Labels, rendered strings, and
  architecture names are not provenance.
- **COMPLETENESS_SOURCE**: Semantic IR completeness, MemorySSA validation and access metadata,
  provider status, cancellation state, and resource/iteration budget status. `partial`,
  `truncated`, `cancelled`, `unsupported`, stale, malformed, or unknown evidence cannot authorize
  an exact value.
- **INVALIDATION_SOURCE**: The existing analysis snapshot/pass lifecycle and MemorySSA identity;
  any changed IR, CFG, alias result, access metadata, MemorySSA build, snapshot, analyzer version,
  or relevant input invalidates the forwarding fact.
- **DIRECT_CONSUMERS**: The canonical value-forwarding/value-numbering consumer, existing
  Semantic IR compatibility projection, and canonical points-to/value surfaces that ask for a
  loaded value.
- **DOWNSTREAM_CONSUMERS**: Scalar propagation, symbolic translation, decompiler value recovery,
  type/prototype evidence, alias/points-to queries, and public analysis/decompiler projections.
- **POSITIVE_CASES**: One exact same-width store; adjacent exact stores reconstructing a wider
  load; little-endian reconstruction; every other supported endian lane; overlapping writes when
  their order and resulting bytes are proven; deterministic replay; and at least one existing
  downstream precision improvement.
- **NEGATIVE_CASES**: Partial byte holes; overlapping writes with uncertain order; MayAlias or
  unknown alias; unknown/call/intrinsic clobbers; volatile or atomic uncertainty; stale binary,
  function, snapshot, IR, SSA, MemorySSA, analyzer, or provenance identity; malformed access or
  proof metadata; cancellation; deadline; iteration/resource budget exhaustion; truncated or
  incomplete artifacts; conflicting provenance; unsupported endian/width; and any missing byte.
- **CONSERVATIVE_BOUNDARY**: **One unproven byte means no exact value.** The result remains an
  explicit unknown/unresolved/partial/unsupported/truncated/cancelled state as appropriate. No
  absent byte is assumed zero, and no non-singleton value is silently made exact.
- **NON_GOALS**: A new reaching-definition engine; replacing MemorySSA; whole-program memory
  solving; speculative or probabilistic value recovery; unsupported instruction or endian
  families; silent promotion of partial artifacts; changing ABI or range semantics; decompiler-
  private forwarding; or unrelated issue work.
- **FORBIDDEN_SHORTCUTS**: Treating region identity or one `reachingStore` pointer as proof of
  whole-load coverage; forwarding through MayAlias/unknown/clobber/phi ambiguity; assuming holes
  are zero; trusting stale or malformed evidence; using names/rendering/confidence as authority;
  creating a private memory graph; weakening assertions or denominators; or publishing a staged
  value before completeness and identity checks finish.

## Amended downstream-gate ownership decision

The implementation evidence justifies a narrow, path-exact ownership exception for existing
downstream gates. The canonical owner remains `js/semantics/memoryssa/**`; the downstream files
listed below are touched only to require the producer-issued forwarding capability and its exact
load/snapshot/range/consumer context. They do not compute memory truth, alias relations, reaching
definitions, or replacement values. This is an additive exception for HEX-C2-01 and does not
relax the Phase 7 allowlist or authorize generic edits under `js/decompiler/**`,
`js/analysis/pointsto/**`, `js/symbolic/**`, or `js/ir-core.js`.

The candidate's exact 39-path downstream/process inventory is:

```text
js/analysis/pointsto/local.js
js/decompiler/passes/stack-return-recovery.js
js/decompiler/pipeline-core.js
js/decompiler/pipeline.js
js/decompiler/semantic-core.js
js/decompiler/semantic.js
js/ir-core.js
js/semantics/compat/index.js
js/semantics/compat/semantic-ir-v2-to-v1-finalize.js
js/semantics/compat/semantic-ir-v2-to-v1-memory.js
js/semantics/compat/semantic-ir-v2-to-v1.js
js/semantics/memoryssa/build.js
js/semantics/memoryssa/index.js
js/semantics/memoryssa/proof.js
js/semantics/memoryssa/queries.js
js/slice.js
js/symbolic/translate/semantic-ir.js
js/symbolic/translate/slice.js
js/symbolic/translate/support-matrix.js
specs/002-byte-exact-memoryssa/checklists/requirements.md
specs/002-byte-exact-memoryssa/checklists/soundness.md
specs/002-byte-exact-memoryssa/contracts/byte-forwarding.md
specs/002-byte-exact-memoryssa/data-model.md
specs/002-byte-exact-memoryssa/plan.md
specs/002-byte-exact-memoryssa/quickstart.md
specs/002-byte-exact-memoryssa/research.md
specs/002-byte-exact-memoryssa/spec.md
specs/002-byte-exact-memoryssa/tasks.md
tests/decompiler-semantic.mjs
tests/ir-alias.mjs
tests/ir-dataflow.mjs
tests/ir.mjs
tests/issue-430-memory-escape.mjs
tests/phase7/pointsto/loaded-pointer-recovery.test.mjs
tests/phase9/translate/support-matrix.test.mjs
tests/phase9/translate/translator.test.mjs
tests/semantic-v2/compat-v1-memory.test.mjs
tests/semantic-v2/compat-v1-stackflow-linearization.test.mjs
tests/semantic-v2/issue-c2-01-byte-exact-forwarding.test.mjs
```

Only the first 19 source paths are production ownership (the compatibility, points-to,
decompiler, symbolic, and IR entries are constrained downstream gates); the remaining 20 paths
are feature specifications, evidence, or regression tests. Any path outside this inventory remains
forbidden unless a new evidence-backed decision is recorded.

The validation-budget correction necessarily adds `js/semantics/memoryssa/contract.js` as a
canonical-owner extension (the contract itself was not modified by the original 39-path commit).
It is the sole additional production path, bringing the full candidate diff to 40 paths; it does
not widen downstream ownership or the allowlist.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recover Every Proven Load Byte (Priority: P1)

An analyst receives an exact loaded value when canonical MemorySSA proves that one or more ordered
writes cover every byte of the load, preserving width, endian interpretation, and source
provenance.

**Why this priority**: Stack locals and aggregate fields are frequently written in lanes. Closing
this boundary improves constants, pointers, and decompiler/value consumers without inventing a
second memory truth.

**Independent Test**: Build one architecture-neutral Semantic IR function with deterministic
memory accesses, construct validated canonical MemorySSA, and compare the forwarded value and
proof digest with an independently computed expected byte sequence.

**Acceptance Scenarios**:

1. **Given** one complete same-width MustAlias store and load, **when** the value consumer asks
   for the load, **then** the exact stored value is forwarded with its proof identity.
2. **Given** adjacent complete stores that cover a wider load, **when** MemorySSA proves each
   store, order, and byte lane, **then** the value is reconstructed in the declared endian order.
3. **Given** ordered overlapping stores, **when** the final byte value of every lane is proven,
   **then** the later proven bytes replace earlier bytes and the complete value is published.
4. **Given** equivalent input artifacts and the same analysis snapshot, **when** the case is replayed
   twice, **then** value bytes, proof identity, diagnostics, and completeness are identical.

### User Story 2 - Refuse Unproven Bytes (Priority: P1)

An analyst never receives a precise value when any byte, alias relation, ordering fact, provenance
identity, or completeness condition is unproven.

**Why this priority**: One fabricated byte can create false constants, pointers, aliases, targets,
types, or decompiler output; unknown is safer than silent corruption.

**Independent Test**: Vary exactly one proof dimension at a time from a positive fixture and assert
that the value remains explicit non-exact with the applicable diagnostic.

**Acceptance Scenarios**:

1. **Given** a hole, incompatible width, unsupported endian, or malformed memory metadata,
   **when** forwarding is requested, **then** no exact value is published.
2. **Given** a MayAlias, unknown alias, unknown store, unresolved call, intrinsic clobber, or
   uncertain store order, **when** forwarding is requested, **then** the clobber remains visible and
   no exact value is published.
3. **Given** volatile/atomic uncertainty, conflicting provenance, stale identity, or invalidated
   MemorySSA, **when** forwarding is requested, **then** the result is conservative and stale
   evidence is not reused.
4. **Given** cancellation, deadline, iteration limit, resource budget exhaustion, or truncation,
   **when** forwarding stops, **then** no partial staged value is published as complete.

### User Story 3 - Preserve Canonical Downstream Precision (Priority: P2)

Existing consumers receive the byte-exact fact through their canonical interfaces and retain their
prior conservative behavior for every paired negative case.

**Why this priority**: A local proof has product value only if it reaches existing consumers
without private fallback paths or ownership drift.

**Independent Test**: Query one existing downstream value/alias/decompiler surface on a positive
fixture and its paired negative, then verify that both use the same canonical proof and snapshot.

**Acceptance Scenarios**:

1. **Given** a proven reconstructed value, **when** an existing downstream consumer queries it,
   **then** precision improves through the canonical result surface.
2. **Given** the paired missing-byte or unknown-clobber fixture, **when** the same consumer queries
   it, **then** it remains unresolved and does not invent a value.
3. **Given** a changed identity or invalidated producer artifact, **when** a consumer queries the
   old proof, **then** the old proof is rejected rather than silently reused.

### Edge Cases

- Store and load ranges may be represented as arbitrary byte lanes; coverage must be evaluated
  without JavaScript `Number` precision loss.
- Endian reconstruction must preserve the declared lane order; unsupported or conflicting endian
  metadata is a refusal, not a default.
- Overlapping writes require a total, proven order for every winning byte. Equal-looking values do
  not replace order proof.
- A may-alias or unknown writer is a barrier even when all visible concrete stores appear to agree.
- Calls/intrinsics with incomplete memory summaries, volatile accesses, and atomics remain
  conservative unless their sequencing is explicitly supported and proven.
- Stale, malformed, cancelled, budget-limited, and truncated artifacts preserve their status and
  do not publish staged exactness.
- Replaying the same immutable artifacts must yield byte-identical values, diagnostics, and proof
  identities.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST consume the existing canonical MemorySSA artifact for all exact
  load/store forwarding and MUST NOT create a second reaching-definition or memory-alias engine.
- **FR-002**: The system MUST represent each load and contributing store as a width-exact byte
  range and MUST prove complete coverage of every load byte before publishing an exact value.
- **FR-003**: The system MUST reconstruct values from ordered contributing writes using the access
  endian contract and MUST never assume an uncovered byte is zero or otherwise fabricate it.
- **FR-004**: A single exact same-width store MAY authorize forwarding only when its alias relation,
  access metadata, order, provenance, identity, and completeness are all validated.
- **FR-005**: Multiple stores MAY authorize reconstruction only when every contributing byte is
  backed by a concrete MemorySSA proof, all overlaps have a proven order, and no uncertain writer
  reaches the load.
- **FR-006**: MayAlias, unknown alias, unknown/call/intrinsic clobbers, uncertain order, partial
  coverage, incompatible width/endian, volatile/atomic uncertainty, unsupported effects, or
  malformed evidence MUST produce no exact value.
- **FR-007**: Binary, function, snapshot, Semantic IR, SSA/MemorySSA, analyzer/version,
  access-metadata, and provenance identities MUST match the current query before a fact is used.
- **FR-008**: Cancellation, deadline, iteration/resource limits, incomplete/truncated artifacts,
  and validation failure MUST stop or degrade conservatively and MUST NOT publish a partial result
  as complete.
- **FR-009**: Exact forwarding and proof identities MUST be deterministic for identical artifacts,
  and changing any identity-bearing input MUST invalidate or change the proof digest.
- **FR-010**: The canonical value fact MUST flow to existing direct and downstream consumers
  without decompiler-private, points-to-private, or architecture-name heuristic forwarding.
- **FR-011**: The implementation MUST preserve exact bit widths, signed interpretation at the final
  consumer boundary, supported endian lanes, atomic/volatile semantics, and byte ordering.
- **FR-012**: Regression coverage MUST include every positive and negative dimension named by this
  specification, including malformed/stale/cancelled/budget/truncated evidence, deterministic
  replay, and downstream precision.
- **FR-013**: The implementation and test inventory MUST contain only the C2-01 canonical consumer,
  its owned tests/spec evidence, and explicitly required integration metadata; unrelated finding
  work is prohibited.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every locked positive case publishes exactly the expected bytes, width, endian result,
  contributing store identities, and provenance with zero missing-byte errors.
- **SC-002**: Every locked negative case publishes zero exact values and retains an explicit reason
  for the missing proof dimension.
- **SC-003**: The focused C2-01 corpus records zero false exact values, false NoAlias/MustAlias
  consequences, stale publications, malformed-proof acceptances, or semantic mismatches.
- **SC-004**: Two deterministic replays of the focused corpus produce zero differences in values,
  proof identities, diagnostics, completeness, and ordering.
- **SC-005**: At least one existing direct downstream consumer shows improved precision for a
  reconstructed positive case and unchanged conservative behavior for its paired negative.
- **SC-006**: Cancellation and each declared budget/deadline boundary terminate within its bound
  and publish no incomplete exact value.
- **SC-007**: Existing test denominators and assertion strengths are unchanged or increased; no
  failing test, corpus row, workflow, or generated artifact is removed or weakened.
- **SC-008**: Exact-head CI, candidate merge-tree validation, generated-output checks, merge, and
  post-merge live-main verification all bind to one exact merged product identity.

## Assumptions

- HEX-C1-01 and HEX-C1-03 provide the current canonical MemorySSA, provenance, identity, and
  conservative points-to foundations; C1-02 is not reopened by this finding.
- The existing MemorySSA builder and alias provider are authoritative and can expose enough
  source/access metadata to validate byte ranges; any missing capability remains explicit and is
  not guessed.
- The supported endian set is the set already declared by the canonical memory-access contract;
  no new architecture-specific endian default is introduced.
- Existing downstream consumers can adopt one canonical value fact through their current public
  surfaces; consumer-specific duplicate forwarding is out of scope.
- Generated userscript artifacts are integration-owned and are rebuilt only by the canonical
  generator after final reconciliation.
