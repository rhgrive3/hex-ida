# Feature Specification: ABI Aggregate and Prototype Unification

**Feature Branch**: `feat/analysis-hex-c3-02-abi-unification`

**Created**: 2026-08-29

**Status**: Implementation checkpoint complete — independent review and delivery gates pending

**Input**: User description: "Close HEX-C3-02 ABI aggregate/prototype unification with one canonical ABI model across profiles, calls, summaries, and decompiler consumers."

## Finding Contract

- **FINDING_ID**: HEX-C3-02
- **PROBLEM**: Aggregate argument/return and prototype interpretation diverge between target ABI classifiers, Semantic IR call projection, summaries, and decompiler-facing prototype recovery. The divergence can fabricate argument locations, return registers, hidden structure-return pointers, aggregate pieces, or exact prototypes when the architecture/profile or evidence is unknown.
- **FIRST_DIVERGENCE**: After PR #2499 made `js/decompiler/types/prototype.js` profile-aware, the consumer still accepts an adapter by `id` alone (ignoring stale, malformed, mismatched, or conflicting ABI identity), and it flattens each live physical entry register into an independent argument. It therefore drops canonical aggregate/HFA/HVA grouping and piece metadata before downstream publication. The selected canonical ABI plugin and adapter are upstream; this is the first remaining consumer divergence on current main.
- **CANONICAL_OWNER**: `js/targets/abi/**` owns architecture/profile ABI classification; `js/analysis/semantic-function-base.js` owns the canonical adapter boundary; Semantic IR call classification and summaries consume that boundary; decompiler prototype and aggregate layout modules are consumers only.
- **PRODUCER**: decoded architecture/profile identity and the registered ABI plugin produce argument, return, aggregate-piece, stack, hidden-sret, register-class, and variadic-frontier facts.
- **CANONICAL_FACT**: a versioned ABI classification result whose profile identity, calling convention, parameter/return locations, aggregate pieces, alignment, padding, variadic state, and completeness are explicit.
- **IDENTITY_SOURCE**: architecture plugin identity/version plus ABI plugin `id`, `semanticVersion`, `semanticIdentity`, platform/profile identity, and binary/slice/function analysis identity supplied by the canonical Semantic IR route.
- **PROVENANCE_SOURCE**: ABI plugin classification evidence tied to the decoded function/call, function prototype evidence, source parameter/return evidence, and the canonical Semantic IR origin chain; no rendered text, register spelling, or decompiler inference is provenance.
- **COMPLETENESS_SOURCE**: classifier result completeness/partial/unsupported status, profile support and identity validation, known versus anonymous variadic frontier, aggregate layout proof, and call/callee agreement. Missing, malformed, stale, conflicting, or unsupported evidence remains explicit.
- **INVALIDATION_SOURCE**: architecture/profile/ABI semantic version, binary and slice identity, function/call target identity, prototype/type evidence, Semantic IR schema/version, summary digest, and any changed classifier or aggregate-layout dependency.
- **DIRECT_CONSUMERS**: Semantic IR call nodes, compatibility projection, function summaries, `recoverFunctionPrototype`, aggregate layout recovery, high-variable/type recovery, and call-site prototype consumers.
- **DOWNSTREAM_CONSUMERS**: decompiler signatures and C-like output, caller/callee agreement checks, points-to/return summaries, query surfaces, type/prototype displays, and release verification corpora.
- **POSITIVE_CASES**: supported and identity-valid AAPCS64/Darwin ARM64/arm64e, SysV AMD64, Microsoft x64, Microsoft vectorcall, and supported generic RISC-V LP64-family classifier rows for integer, FP, pointer, aggregate, split-register, stack, HFA/HVA, hidden-sret, and return cases.
- **NEGATIVE_CASES**: unsupported ABI, stale/mismatched architecture or profile identity, malformed adapter/classifier evidence, conflicting ABI completeness, unknown/anonymous variadic frontier, incomplete aggregate member/layout data, indirect-call uncertainty, contradictory caller/callee observations, thunk/tail-call ambiguity, and any conflicting ABI classifications.
- **CONSERVATIVE_BOUNDARY**: publish an exact argument/return location or exact prototype only when the selected canonical profile is supported, identity-valid, complete for the requested fact, and free of unresolved aggregate/variadic/caller-callee conflict. Otherwise publish explicit partial, unknown, unsupported, or ambiguous state and retain alternatives where the existing schema permits.
- **NON_GOALS**: inventing a new ABI, broadening unsupported profile coverage, replacing the canonical ABI registry/classifiers, solving recursive structural types, inferring arity from merely-live registers, or changing generated artifacts outside the integration owner.
- **FORBIDDEN_SHORTCUTS**: decompiler-private ABI rules; points-to-private ABI rules; architecture-name heuristics; hard-coded register literals in generic consumers; unsupported-to-exact or partial-to-complete promotion; truthy capability checks; caller/callee consensus as a substitute for ABI proof; test-only expectation changes; generated-file hand edits; and denominator/assertion weakening.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One ABI Fact Reaches Every Prototype Consumer (Priority: P1)

An analyst examining a supported binary receives the same canonical ABI interpretation for call
arguments, aggregate pieces, return locations, hidden sret, stack placement, and prototype output
across Semantic IR, summaries, and decompiler views.

**Why this priority**: ABI disagreement can produce false exact types, false argument counts,
wrong aggregate rendering, and incorrect caller/callee contracts even when individual plugins are
locally correct.

**Independent Test**: Feed identity-bound fixtures through the registered ABI classifier, the
canonical Semantic IR adapter, a summary, and the shared decompiler prototype consumer. Compare
the resulting location/classification facts and require one canonical classification identity.

**Acceptance Scenarios**:

1. **Given** a supported profile and complete scalar or aggregate prototype, **When** the call and
   function paths classify it, **Then** Semantic IR, summary, and decompiler consumers expose the
   same ordered locations, register classes, alignment, and return contract.
2. **Given** an aggregate that is returned in multiple registers, split between registers and the
   stack, or returned through hidden sret, **When** the function and call projections are built,
   **Then** every consumer preserves the classifier's piece ordering and hidden-parameter state.
3. **Given** the same profile and evidence in two deterministic runs, **When** classifications are
   compared, **Then** result identity, completeness, provenance, diagnostics, and publication are
   identical.

### User Story 2 - Profile-Specific Aggregate and Variadic Boundaries Stay Conservative (Priority: P1)

An analyst never receives an exact aggregate/prototype claim when profile identity, member layout,
variadic frontier, caller/callee agreement, or indirect-call evidence is incomplete or ambiguous.

**Why this priority**: false exact ABI placement or type is a release-blocking semantic error and
can mislead all downstream analyses.

**Independent Test**: Vary one ABI identity, completeness, layout, or conflict condition at a time
in a locked matrix. Each unsafe row remains explicitly unknown, partial, unsupported, or ambiguous.

**Acceptance Scenarios**:

1. **Given** an unsupported ABI, stale ABI identity, malformed evidence, or architecture/profile
   mismatch, **When** classification is requested, **Then** no exact argument, return, aggregate,
   hidden-sret, or prototype fact is published.
2. **Given** an anonymous variadic frontier, incomplete HFA/HVA member evidence, indirect-call
   uncertainty, or contradictory caller/callee observations, **When** a consumer requests a
   prototype, **Then** unresolved alternatives and completeness state are preserved and no exact
   placement is fabricated.
3. **Given** a thunk or tail-call whose ABI role cannot be distinguished from a normal call,
   **When** the call summary is built, **Then** the summary remains conservative and records the
   ambiguity rather than laundering it into a prototype.

### User Story 3 - Locked Profile Matrix Covers the Shared ABI Layer (Priority: P2)

Maintainers can audit one profile matrix covering the currently supported ABI plugins: Linux and
Android AAPCS64, Apple Darwin ARM64, arm64e behavior with explicit architecture identity,
SysV AMD64, Microsoft x64, Microsoft vectorcall, and generic RISC-V LP64/LP64F/LP64D consumers.

**Why this priority**: architecture support alone does not prove the platform ABI or sub-ABI; the
matrix prevents a new consumer from silently selecting the wrong canonical profile.

**Independent Test**: Run the matrix through direct classifiers and the shared Semantic IR route,
then independently count supported, partial, unsupported, malformed, stale, and conflict rows.
The matrix is deterministic and no row is removed to obtain a passing score.

**Acceptance Scenarios**:

1. **Given** each supported profile's integer, FP, pointer, aggregate, return, stack, alignment,
   and register-class rows, **When** the matrix runs, **Then** every row has a terminal explicit
   outcome and a profile identity.
2. **Given** an Apple arm64e input, **When** profile selection is requested, **Then** arm64e
   architecture identity is retained while ABI selection is explicit; architecture-name matching
   alone cannot silently select a platform profile.
3. **Given** a known variadic prototype and an unknown prototype, **When** the matrix compares
   fixed parameters and anonymous arguments, **Then** only proven fixed portions are exact and the
   remaining frontier is explicit and conservative.

### Edge Cases

- Small structures at one-byte, eight-byte, sixteen-byte, and register-boundary sizes must retain
  exact padding/alignment and piece order only when layout evidence is complete.
- HFA/HVA members at one through four elements, mixed FP/integer members, vector members, and
  unsupported scalable/vector forms must distinguish proven classification from unsupported or
  partial classification.
- Aggregates crossing a final argument register, stack alignment boundary, or split register/stack
  boundary must not be re-packed differently by a consumer.
- Hidden sret consumes the profile-designated hidden input and must not be mistaken for a visible
  user argument or ordinary return register.
- Known variadic prototypes expose only their fixed prefix as exact; anonymous variadic arguments
  remain possible/unknown according to the profile's saved-register and stack rules.
- Unknown prototypes, indirect calls, thunks, tail calls, conflicting callsites, and caller/callee
  disagreement retain explicit uncertainty.
- Profile or ABI identity from another binary, slice, function, Semantic IR version, classifier
  version, or summary digest is stale and cannot be reused.
- Cancellation, deadline, budget exhaustion, truncation, malformed ABI metadata, and failed
  classifier calls publish no staged exact result.

## Historical current-main correction (pre-implementation)

The original RISC-V/unsupported-ABI smoke regression is now green after the
merged PR #2499 and is not evidence for a new fix. A read-only audit was rerun
against historical live `origin/main` at `48a0b42913e63f33a03783f9676994268d8a06e8`.
The direct canonical classifier/profile rows are covered for Apple arm64 and
arm64e, AAPCS64, SysV AMD64, Microsoft x64/vectorcall, and RISC-V
LP64/LP64F/LP64D, including scalar arguments/returns, aggregate boundaries,
HFA/HVA, hidden sret, variadic frontiers, unknown prototypes, and unsupported
profiles. The 66-row matrix produced 54 passes and 12 deterministic failures
in the prototype consumer:

1. stale, malformed, architecture-mismatched, or conflicting ABI adapter
   evidence is accepted as `conventionKnown: true`;
2. the published prototype omits the canonical ABI semantic identity;
3. AAPCS64, Darwin HFA, Microsoft vectorcall HVA, and RISC-V LP64 aggregate
   pieces are flattened into separate arguments instead of one canonical
   aggregate argument;
4. Microsoft aggregate-indirect class/pointer evidence is lost;
5. aggregate return piece metadata is dropped, and SysV explicit aggregate
   return pieces are not projected.

The minimum deterministic current-main regressions are retained in
`tests/phase8/abi/hex-c3-02-profile-matrix.test.mjs`. They intentionally fail
2 of 4 subtests on the pre-fix base: stale ABI identity is accepted and an
AAPCS64 two-register aggregate is split into two arguments. These failures are
the revised counterexamples; the implementation proceeded only after
`ANALYZE=CLEAN` and Sol approval.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST retain `js/targets/abi/**` as the only producer and owner of ABI
  argument, return, aggregate, register-class, stack, alignment, padding, sret, and variadic facts.
- **FR-002**: The canonical Semantic IR adapter MUST carry ABI profile identity, semantic version,
  provenance, and completeness with every classification consumed by calls, summaries, and
  decompiler projections.
- **FR-003**: Function-level prototype recovery MUST consume the selected ABI adapter/classifier
  for all argument and return locations and MUST NOT contain a private architecture-specific ABI.
- **FR-004**: Aggregate argument and return classification MUST preserve member/piece order,
  register classes, split register/stack placement, alignment, padding, and hidden sret state when
  the canonical profile proves them.
- **FR-005**: HFA/HVA and other profile-specific aggregate classes MUST be exact only with complete
  member/layout evidence; unsupported scalable or otherwise unproven classes MUST remain explicit.
- **FR-006**: Known variadic prototypes MUST expose only their proven fixed prefix; anonymous
  variadic arguments and register-save/stack frontiers MUST retain profile-specific uncertainty.
- **FR-007**: Caller/callee summaries and call Semantic IR MUST agree through the canonical ABI fact
  and MUST retain contradiction/indirect-call/thunk/tail-call ambiguity instead of selecting by
  majority or confidence.
- **FR-008**: The profile matrix MUST cover all currently supported shared-layer profiles relevant
  to this repository: Apple arm64, arm64e identity behavior, AAPCS64, SysV AMD64, Microsoft x64,
  Microsoft vectorcall, and supported generic RISC-V LP64-family profiles.
- **FR-009**: Unsupported, stale, malformed, incomplete, cancelled, truncated, budget-limited,
  conflicting, or profile-mismatched evidence MUST NOT publish an exact ABI placement, type,
  aggregate, hidden-sret, return, or prototype.
- **FR-010**: Every published canonical fact MUST include deterministic identity, provenance,
  completeness, and invalidation dependencies sufficient to reject stale consumers and summaries.
- **FR-011**: The implementation MUST preserve bounded work, cancellation, atomic publication, and
  deterministic replay; failed or incomplete classifier work MUST NOT publish staged exactness.
- **FR-012**: Regression coverage MUST include integer, FP, pointer, integer/FP returns, aggregate
  arguments/returns, hidden sret, small and multi-register/split aggregates, HFA/HVA, stack and
  alignment, known/anonymous/unknown prototypes, indirect-call uncertainty, caller/callee
  agreement, profile identity, unsupported ABI, stale identity, malformed evidence, cancellation,
  budget, truncation, and deterministic replay.
- **FR-013**: The actual changed-file inventory MUST contain only C3-02 specification, canonical ABI
  integration, owned regressions/verifiers, and integration-owned generated outputs; unrelated
  Issue work and decompiler-private ABI logic are prohibited.

### Key Entities

- **ABI profile identity**: architecture, platform/sub-ABI, calling convention, ABI semantic
  version/identity, and support status used to select one canonical classifier.
- **ABI classification fact**: ordered parameter/return locations, register classes, aggregate
  pieces, stack offsets, alignment/padding, hidden sret, variadic state, evidence, and completeness.
- **Semantic ABI adapter**: the one shared projection from a registered ABI classifier into call
  Semantic IR, summaries, and compatibility consumers.
- **Prototype evidence bundle**: function/call evidence and source identity consumed by prototype
  recovery, including classifier identity and invalidation dependencies.
- **ABI matrix row**: a deterministic positive or conservative fixture keyed by profile, operation,
  evidence state, expected fact, and expected completeness.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every locked supported-profile positive row yields one identical ABI classification
  identity and matching locations/pieces/classes across direct classifier, Semantic IR adapter,
  summary, and decompiler consumers.
- **SC-002**: Every locked unsupported, stale, malformed, incomplete, cancelled, truncated,
  budget-limited, conflict, indirect-call, thunk, and unknown-variadic row publishes zero false
  exact ABI/prototype facts and retains its explicit conservative state.
- **SC-003**: The matrix has terminal outcomes for all currently supported profiles and required
  case classes, with zero unexplained rows, zero false exact placements, and zero false exact types.
- **SC-004**: HFA/HVA, small aggregate, multi-register, split register/stack, hidden sret, stack,
  alignment, padding, and variadic rows preserve expected piece order and profile-specific rules.
- **SC-005**: Two deterministic runs over identical identity-bound input produce identical result,
  proof, provenance, completeness, invalidation, and diagnostic records.
- **SC-006**: Cancellation, deadline, truncation, and every declared resource budget terminate
  within bounds and publish no partially staged exact ABI fact.
- **SC-007**: At least one downstream decompiler signature and one caller/callee summary demonstrate
  improved aggregate/prototype precision on positive rows and unchanged conservative behavior on
  paired negatives.
- **SC-008**: Existing ABI and issue-test denominators and assertion strength are preserved or
  increased; no required row, profile, or negative case is deleted, skipped, or weakened.
- **SC-009**: Actual changed-file ownership, Spec Kit convergence, exact-head CI, candidate merge
  tree validation, expected-head merge, and post-merge live-main verification all bind to one exact
  product identity.

## Assumptions

- The registered ABI plugins, architecture/profile registry, Semantic IR adapter, summary schema,
  decompiler pass lifecycle, and identity/invalidation primitives on live main remain the canonical
  foundations and are extended rather than replaced.
- PR #2499 is concurrent semantic work on the same `js/decompiler/types/prototype.js` owner and
  its ABI regression surface; this lane must wait, restack, or target a non-overlapping extension
  after Sol arbitrates the collision.
- The recent merged PR #2500's explicit AAPCS64 prototype contract is part of the base and must be
  preserved as an existing regression, not duplicated or weakened.
- C1-02 return-summary work is a prerequisite dependency only; it is not reopened unless current
  main proves a C3-02-relevant regression.
- Generated userscript or release artifacts are integration-owned and are not committed by this
  component lane.
- If a profile cannot prove all requested aggregate or variadic details, the appropriate outcome
  is partial/unknown/unsupported rather than widening the exactness claim.
