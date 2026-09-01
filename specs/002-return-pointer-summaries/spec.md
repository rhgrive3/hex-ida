# Feature Specification: Return-Pointer Summaries (HEX-C1-02)

**Feature Branch**: `feat/analysis-c1-02-target-matrix`

**Created**: 2026-09-01

**Status**: Verified / Complete

**Input**: User description: "Audit HEX-C1-02 against CURRENT live main, reconcile and integrate complete / incomplete / recursive return-pointer target matrix into main, and complete finding evidence."

## Finding Contract

- **FINDING_ID**: HEX-C1-02
- **PROBLEM**: Local points-to analysis treats function call returns as `unresolved-call` by default. When callees provably return an argument-derived, global-rooted, or allocation-derived pointer, callers should join these proven finite return targets without sacrificing soundness. Conversely, when callee summaries are missing, stale, incomplete, recursive without convergence, or malformed, callers must never invent an exact return pointer.
- **FIRST_DIVERGENCE**: An analysis attempting interprocedural return propagation without an explicit summary contract either assumes purity for unresolved calls, guesses argument-return equivalence, drops unknown alternatives to retain false exactness, or fails to terminate on recursive call graphs.
- **CANONICAL_OWNER**: `js/analysis/summary/contract.js`, `js/analysis/summary/local.js`, `js/analysis/summary/interprocedural.js`, and `js/analysis/pointsto/local.js`.
- **PRODUCER**: Local summary analysis (`buildLocalFunctionSummary`) and interprocedural summary solving (`solveInterproceduralSummaries`).
- **CANONICAL_FACT**: `FunctionSummary` with `returnProvenance` list of finite facts (`kind: 'arg' | 'root' | 'allocation'`, `returnIndex`, `argIndex`, `offset`, `rootEntityId`, `allocationSiteId`) bound to a complete `status`.
- **IDENTITY_SOURCE**: Pinned snapshot identity, function identity, analyzer identity (`phase7.summary.local`, `phase7.summary.interprocedural`), schema version (`2`), contract version (`1.1.0`), and content digest (`functionSummaryDigest`).
- **PROVENANCE_SOURCE**: Verified Semantic IR return expressions, argument ordinals, canonical root identities, and allocation site IDs; never guessed offsets or name heuristics.
- **COMPLETENESS_SOURCE**: `createAnalysisStatus` completeness enum (`complete`, `partial`, `unsupported`, `truncated`), explicit `unknownCallEffects`, and broad memory write effects.
- **INVALIDATION_SOURCE**: Modified function IR/CFG/SSA, changed callee summaries, snapshot transition, analyzer version bump, or budget exhaustion.
- **DIRECT_CONSUMERS**: `analyzeLocalPointsTo` call transfer node handling.
- **DOWNSTREAM_CONSUMERS**: Alias analysis, indirect call target resolution, type constraint inference (`TypeConstraintGraph`), decompiler pointer analysis, and query engine.
- **POSITIVE_CASES**:
  - Complete, identity-matching callee summary with argument return provenance (`kind: 'arg'`) forwards caller arguments with proven offsets.
  - Complete callee summary with root (`kind: 'root'`) and allocation (`kind: 'allocation'`) provenance creates exact rooted/allocation points-to targets.
  - Multi-return ABI preserves return index separation.
  - Multi-alternative return provenance joins all targets with precise offset ranges.
  - Interprocedural summary solving preserves converged return provenance across function calls and wrappers.
- **NEGATIVE_CASES (13-Axis Target Matrix)**:
  1. Summary missing: callee ID not found in summary provider.
  2. Targetless call: call node without target entities or non-exhaustive indirect call.
  3. Analyzer / snapshot / schema / contract / function identity mismatch.
  4. Incomplete / partial / unsupported / truncated summary status.
  5. Unknown call effects present or broad memory write effects.
  6. Empty return provenance list for the consumed return index.
  7. Wrong or missing return index in provenance.
  8. Argument points-to set is TOP or BOTTOM.
  9. Argument index absent from call node.
  10. Malformed or non-integer offset.
  11. Unknown provenance kind or missing root/allocation identity.
  12. Points-to target budget overflow (`maxTargetsPerSet`).
  13. Self-recursive or mutually recursive functions failing fixed-point convergence or exceeding iteration budget.
- **CONSERVATIVE_BOUNDARY**: Any failure across the 13 negative axes falls back strictly to `topPointsTo('unresolved-call')` or canonical conservative loss reasons (`target-cap`). No partial summary is ever promoted to exact truth.
- **NON_GOALS**: Guessing pointer offsets from unanalyzed callee bodies; converting non-exhaustive indirect calls into exact singletons; laundering string names into root proofs; bypassing interprocedural fixed-point budgets.
- **FORBIDDEN_SHORTCUTS**: Silently dropping unknown return alternatives; assuming unproven arguments are NULL/0; ignoring recursion non-convergence; skipping analyzer identity checks.

## User Scenarios & Testing

### User Story 1 — Complete Callee Yields Precise Joined Target Set (Priority: P1)

Given a callee summary with complete status, matching snapshot/analyzer identity, no unknown call effects, and valid return provenance, the caller's call node produces an exact joined target set with offsets and root identities preserved.

**Acceptance Scenarios**:
1. **Given** a callee returning `arg0` with offset 0 and `arg1` with offset 16, **When** analyzed by local points-to, **Then** `call_ret` has `top: false` and exactly contains both shifted argument roots.
2. **Given** a callee returning `root` and `allocation` provenance, **When** analyzed, **Then** `call_ret` receives canonical `rooted` and `allocation` points-to targets.

### User Story 2 — 13-Axis Incomplete / Mismatched Callee Stays Unresolved (Priority: P1)

Varying any one of the 13 negative axes independently forces `analyzeLocalPointsTo` to return `top: true` with `lossReasons: ['unresolved-call']` (or `'target-cap'`).

**Acceptance Scenarios**:
1. Every individual negative axis in the 13-axis matrix produces conservative points-to without throwing unhandled exceptions.

### User Story 3 — Interprocedural Recursion & Budget Bounded (Priority: P1)

Self-recursive and mutually recursive call graphs processed via `solveInterproceduralSummaries` terminate within budget, propagate monotone effects, and publish conservative statuses on non-convergence.

**Acceptance Scenarios**:
1. **Given** self-recursive or mutually recursive functions, **When** solved with `solveInterproceduralSummaries`, **Then** the solve terminates deterministically.
2. **Given** a recursion budget exhaustion (`maxIterationsPerComponent: 0`), **When** solved, **Then** the summary carries `recursion-unconverged` unknown call effect and caller points-to stays `unresolved-call`.

## Requirements

- R1: The 13-axis target matrix is locked in `tests/phase7/summary/c1-02-target-matrix.test.mjs`.
- R2: No production change relaxes an existing `unresolved-call` boundary without complete summary proof.
- R3: Interprocedural recursion must reuse canonical `solveInterproceduralSummaries` fixed point and budget mechanics.
- R4: All verification must run on exact current-main head.
