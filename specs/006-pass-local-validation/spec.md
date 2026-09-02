# Feature Specification: Pass-Local Refinement Validation (HEX-C4-04)

**Feature Branch**: `feat/analysis-partial-closure-20260901`

**Created**: 2026-09-01

**Status**: Draft

**Input**: Close HEX-C4-04 — make the existing bounded symbolic equivalence verifier a uniform pass-local adoption gate for Phase 8 scalar rewrites, without weakening raw fallback.

## Problem

`js/symbolic/verify/equivalence.js` (`verifyBoundedEquivalence`) already proves/refutes bounded equivalence over the exact-width BV DAG with explicit unknown, correspondence, preconditions and model validation. Phase 8 transactions (`runPassTransaction`) enforce declared consumes/produces/invalidations, but a rewrite that commits does not carry a machine-checked refinement proof: a pass may claim `proof: 'algebraic'` and publish without independent validation.

## User Stories & Acceptance Scenarios

### US1 — A proved rewrite commits with its proof (P1)

A Phase 8 pass attaches a validation request per rewrite (before/after BV expressions, correspondence, declared observables). When the verifier proves equivalence, the transaction records the proof id next to the transform and commits normally.

**Acceptance**:
1. Given an equivalent rewrite (e.g. `x+x` → `x<<1`), when the pass runs through the adoption gate, then the result commits with an `equivalenceProofId` on the transform record.
2. Given a replay with the same inputs, the proof id is identical (deterministic).

### US2 — A refuted or unknown rewrite never commits (P1)

When the verifier refutes the rewrite (SAT counterexample) or cannot decide (timeout, unsupported translation, missing correspondence, inconsistent precondition), the transaction refuses to adopt that rewrite: the pass must fall back to the unrewritten program and record an explicit diagnostic.

**Acceptance**:
1. Given a non-equivalent rewrite, when the gate runs, then the adoption is refused with `refuted` and the offending counterexample evidence is retained in the diagnostic.
2. Given an unsupported translation or a timeout, the outcome is explicit `unknown` and the rewrite is not adopted (no silent skip-green).
3. Given a corrupted SAT model, model validation fails the proof (never mints adoption).

### US3 — The gate is uniform and opt-out is explicit (P2)

Passes that declare rewrites must either run the gate per rewrite or explicitly declare the rewrite kind as unvalidated with a reason; the transaction records which rewrites were machine-validated.

**Acceptance**:
1. Given a transaction result whose transform carries `validation: 'refuted'`, when the transaction tries to commit, it is refused (fail closed).
2. Given a result with `validation: 'unknown'` and diagnostics, the rewrite is dropped but the transaction may commit with the rewrite excluded.
3. Given a forged proof id on a transform, the transaction validation rejects it.

## Edge Cases

- A rewrite whose observables include non-BV state (memory/calls) is `unsupported` for the scalar gate; it stays unadopted unless a broader proof is provided by the memory-bearing lane (out of scope here).
- The gate itself cancelling/budget-exhausted yields `unknown`, never `proved`.
- Empty rewrites (no transforms) bypass the gate entirely.

## Requirements

- **FR-001**: Every Phase 8 transform that declares a BV-expression before/after pair MUST carry machine validation before commit (`validated: 'equivalent'` + `equivalenceProofId`) or be refused.
- **FR-002**: `refuted` rewrites MUST NOT commit; `unknown`/`unsupported` rewrites MUST be excluded from the commit with diagnostics, keeping the rest of the transaction intact.
- **FR-003**: Proof ids MUST be deterministic digests of the validated claim and MUST be re-verified (digest equality) at commit time; a forged/mismatched id fails the transaction.
- **FR-004**: The gate MUST reuse the canonical `verifyBoundedEquivalence` and the existing solver session/backend registry — no second verifier, no parallel truth.
- **FR-005**: Raw fallback behavior is unchanged: a refused rewrite leaves the program as-is (never deletes the original).
- **FR-006**: All existing denominators unchanged or increased; no assertion weakened.
- **FR-007**: The gate MUST be bounded/cancellable and must propagate `unknown` on cancellation/timeout.

## Success Criteria

- **SC-001**: All locked positive cases commit with proof ids; replays are byte-identical.
- **SC-002**: All refuted/unknown/forged cases fail closed with explicit reasons.
- **SC-003**: `npm run phase8:test` and the focused suite are green.
