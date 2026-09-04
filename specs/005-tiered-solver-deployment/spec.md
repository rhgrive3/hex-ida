# Feature Specification: HEX-SYM-01 Tiered Solver Deployment

**Feature Branch**: `work/sym01-full`
**Created**: 2026-09-03
**Status**: Local implementation hardened; release evidence BLOCKING pending physical-iPad execution
**Exact Base**: `60980a3c9312b1dda7619d5e88b4a97df1016276`

## Context and ownership

- **FINDING_ID**: `HEX-SYM-01`
- **PROBLEM**: Phase 9 has an exact exhaustive Bool/BV provider, but its explicit width limit is 8 bits. Production therefore cannot decide ordinary 32/64-bit QF_BV verification queries.
- **FIRST_DIVERGENCE**: `createProductionSolverRegistry()` selects the exhaustive provider directly (or its worker wrapper), whose default `maxBvWidth` is 8.
- **CANONICAL_OWNER**: `js/symbolic/solver/**`; architecture, Semantic IR, evaluator, decompiler, and generated-user-script truth remain unchanged.
- **DIRECT_CONSUMERS**: Phase 9 verification entry points and the existing AI verification tools through `defaultSolverRegistry`.
- **SECOND_SEMANTIC_TRUTH_CREATED**: NO. The backend decides the existing expression contract; it does not infer architecture semantics. SAT witnesses are checked by the pre-existing independent evaluator.

## User stories

### US1 — Decide production-width QF_BV

As a verification consumer, I can submit supported 32- or 64-bit Bool/BV formulas and receive exact SAT/UNSAT, or an explicit non-proof status when deterministic limits intervene.

Acceptance: positive and contradictory 32/64 queries pass; modular wrap, signed order, saturated shifts, division by zero, signed minimum divided by minus one, and signed remainder boundaries match the evaluator.

### US2 — Route capabilities without proof laundering

As a proof consumer, small feasible domains use the exhaustive oracle while wide/large domains use bit blasting. Unsupported, malformed, timed-out, cancelled, stale, budget-limited, or corrupt-provider results never become exact evidence.

Acceptance: routing is visible in immutable capabilities and result statistics; heuristic providers are never candidates; every SAT model is independently evaluated; backend, version, query hash, worker request, and worker token identities are exact.

### US3 — Run locally in the browser worker

As an iPad/browser user, solving remains offline and dependency-free in a dedicated module Worker. Startup, solve time, CNF size, and host memory deltas are measurable without relaxing existing budgets.

Acceptance: Chromium and WebKit worker smoke tests cover the wide tier; worker termination makes timeout/cancel/stale results non-publishable. Physical-iPad validation remains required external evidence and cannot be inferred from desktop WebKit emulation.

## Functional requirements

- **FR-001**: Production MUST route supported QF_BV queries up to 64 bits to an exact backend.
- **FR-002**: Feasible domains whose maximum width is at most 8 bits and whose total domain fits the exhaustive assignment ceiling MUST use the exhaustive exact oracle first.
- **FR-003**: Other supported Bool/BV queries MUST be bit-blasted to equisatisfiable Tseitin CNF and decided by complete deterministic DPLL search.
- **FR-004**: Search or compilation exhaustion MUST return `resource-limit`; elapsed deadline MUST return `timeout`; cancellation/staleness MUST return `cancelled`. None may carry a publishable proof.
- **FR-005**: The bit-vector compiler MUST cover constants, symbols, unary operations, arithmetic, bitwise operations, variable shifts, unsigned/signed compare, unsigned/signed div/rem, connectives, ITE, extract, concat, truncation, zero extension, and sign extension.
- **FR-006**: 32/64 semantics MUST preserve modular wrap, signed two's-complement interpretation, shift saturation, SMT-LIB division-by-zero results, and `MIN / -1` overflow.
- **FR-007**: SAT model values MUST bind canonical symbol IDs and names and MUST pass `validateSatModel` before return. A malformed model MUST become `provider-failure`.
- **FR-008**: UNSAT MUST be returned only after complete CNF search. Heuristic backends MUST NOT have exact proof authority or participate in routing.
- **FR-009**: Session, router, host, and Worker MUST independently recompute the canonical query hash from structured-cloned content before accepting it; results MUST match request ID, request token, recomputed query hash, backend ID, and backend version exactly.
- **FR-010**: Capability fingerprints MUST bind routing policy, route thresholds, and both exact sub-backend fingerprints.
- **FR-011**: Runtime MUST have no network, server, native binary, dynamic package, or non-vendored dependency.
- **FR-012**: Deterministic ceilings MUST bound expression nodes, constraints, CNF variables, clauses, decisions, and propagations. Existing repository budgets, samples, denominators, and assertions MUST NOT be weakened.
- **FR-013**: Tests MUST cover positive, negative, adversarial, boundary, regression, 32/64 SAT+UNSAT, shared-width exhaustive differential, routing, worker transport, corrupt models, timeout/cancel/stale, and startup/solve/memory measurement.
- **FR-014**: Browser emulation MUST NOT be reported as physical-iPad proof.
- **FR-015**: Expression inspection MUST be call-local and iterative, stop immediately at the configured node authority, and distinguish resource exhaustion from malformed/unsupported graphs.
- **FR-016**: Every capability/resource authority MUST be a primitive positive safe integer (timeout additionally permits zero); malformed constructor or runtime input MUST fail closed and MUST NOT select a wider fallback.

## Conservative boundary

Only exact backends may return SAT/UNSAT. Partial compilation, incomplete search, malformed expression shape, unsupported width, model-validation failure, identity mismatch, cancellation, timeout, stale token, worker failure, and resource exhaustion are terminal non-proof outcomes. There is no heuristic fallback.

## Non-goals

- Quantifiers, arrays/memory theory, floating point, strings, or widths above 64.
- Incremental solving, proof certificates, clause learning, or claiming unrestricted SMT performance.
- Changes to architecture truth, Semantic IR truth, decompiler behavior, ownership manifests, workflows, generated userscripts, or package dependencies.
- Fabricating real-device evidence from a desktop browser engine or user-agent string.

## Success criteria

- **SC-001**: All required functional and adversarial tests pass with zero false SAT, false UNSAT, or unvalidated SAT witness in the covered corpus.
- **SC-002**: Bit blasting agrees with the exhaustive backend across the complete QF_BV expression surface at widths 1-8, including complete operand domains where feasible, deterministic boundary domains otherwise, and seeded random SAT/UNSAT formulas.
- **SC-003**: Production registry advertises exact QF_BV through 64 bits and visibly routes <=8-bit feasible queries to exhaustive and 32/64 queries to bit blasting.
- **SC-004**: Repeated identical queries produce identical status, model, query identity, CNF size, decision count, and propagation count; timing is excluded from deterministic evidence.
- **SC-005**: Chromium and desktop WebKit module-Worker tests pass when Playwright browsers are installed.
- **SC-006**: Physical iPad Safari evidence records the actual device/OS, exact deployed source identity, 32/64 SAT+UNSAT, cancellation, and memory-pressure behavior before release completion.
