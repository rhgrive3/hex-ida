# Feature Specification: Complete Return-Pointer Summary Matrix (C1-02 Phase 2)

**Feature Branch**: `feat/analysis-hex-c1-02-phase2`

**Created**: 2026-08-30

**Status**: Draft

**Input**: Ledger row HEX-C1-02 pending matrix: complete / incomplete / recursive target
coverage for return summaries, on top of the PR 2434 floor already merged to main.

## Problem

`js/analysis/pointsto/local.js` call handling returns `topPointsTo('unresolved-call')`
whenever the callee summary is missing, identity-mismatched, incomplete, or carries
unknown call effects. PR 2434 added return-provenance plumbing and retrospective gap
tests, but the ledger still records: "production still returns `unresolved-call`";
pending = complete/incomplete/recursive target matrix.

The dangerous direction is precision without proof: an incomplete or recursive callee
must never contribute a finite, precise return set to the caller.

## User Scenarios & Testing

### User Story 1 — Complete callee yields precise return set (P1)

Given a callee summary with `isCompleteStatus(summary.status)`, no unknown call
effects, matching identity, and non-empty `returnProvenance` for the consumed
return index, the caller's call result is the exact joined target set, not
`unresolved-call`.

### User Story 2 — Every incompleteness axis stays unresolved (P1)

Varying exactly one axis at a time must each independently produce
`topPointsTo('unresolved-call')`:

1. missing summary (no entry for calleeId),
2. identity mismatch (analyzer/version/snapshot),
3. incomplete status (partial/unsupported),
4. non-empty `unknownCallEffects`,
5. empty `returnProvenance` for the consumed index,
6. provenance kind `arg` whose argument set is top or bottom,
7. provenance kind `arg` whose argument is absent (`argumentIds[prov.argIndex] == null`),
8. malformed offset (non-integer string),
9. provenance target construction failure,
10. candidate set top or bottom after shift,
11. join overflow to top (budget), and
12. recursive callee (summary references its own functionId).

### User Story 3 — Recursion terminates and stays explicit (P1)

A self-recursive or mutually recursive callee whose summary is structurally complete
must not loop the fixed point; its return provenance is either excluded with an
explicit conservative state or bounded by the interprocedural budget, and the
observable result is never a silently guessed precise set.

## Requirements

- R1: The 12-axis matrix is locked by a deterministic test with one variation per case.
- R2: No production change may relax an existing `unresolved-call` boundary without a
  proven complete summary; PR 2434 behavior is the floor, not the ceiling to relax.
- R3: Recursion handling must reuse the existing interprocedural budget/stop-reason
  machinery; no second scheduler.
- R4: Evidence recorded in the ledger uses exact-head verifier runs only.

## Out of scope

- Multi-store byte coverage (C2-01 lane, owned by the parallel worktrees).
- Library modeling of specific callees.
