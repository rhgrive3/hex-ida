# Implementation Plan: Pass-Local Refinement Validation (HEX-C4-04)

**Branch**: `feat/analysis-partial-closure-20260901` | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

## Summary

Add a Phase 8 pass-local adoption gate that binds the canonical bounded-equivalence verifier
(`js/symbolic/verify/equivalence.js`) to pass transactions: a rewrite that declares a BV
before/after pair commits only with a deterministic `equivalenceProofId` minted by
`verifyBoundedEquivalence`; refuted/unknown/forged rewrites are excluded or fail the
transaction fail-closed. No second verifier; raw fallback unchanged.

## Technical Context

- **Language/Version**: JavaScript ES modules; Node test runner.
- **Primary Dependencies**: `js/decompiler/phase8/contract.js` (`createPassResult`, transform records), `js/decompiler/phase8/transaction.js` (`runPassTransaction`), `js/symbolic/verify/equivalence.js`, `js/symbolic/verify/query.js` (VERDICT/CLAIM_KIND), `js/symbolic/solver/**` (exhaustive backend floor).
- **Testing**: `tests/phase8/substrate/pass-validation.test.mjs` via Phase 8 runner; existing transaction tests stay green.

## Implementation Boundary

### Expected changed files

- `js/decompiler/phase8/contract.js` — extend transform records with an optional typed `validation` field (`equivalent` + `equivalenceProofId`, or `unknown`/`unsupported`/`refuted` + reason); fail-closed on malformed values.
- `js/decompiler/phase8/transaction.js` — at commit: (1) transforms with `refuted` validation refuse the transaction; (2) transforms with `unknown`/`unsupported` are dropped from the committed transform list with diagnostics; (3) `equivalent` transforms must carry a re-verifiable proof id (digest equality check); (4) a BV rewrite with no validation and no explicit unvalidated reason is refused.
- `js/decompiler/phase8/pass-validation.js` (new) — `validateRewriteAdoption({ beforeExpr, afterExpr, correspondence, backend/session, options })` wrapper producing the validation record; `rewriteProofDigest` deterministic digest; consumed by passes.
- `tests/phase8/substrate/pass-validation.test.mjs` (new) — positive/negative/forged/determinism matrix.
- `specs/006-pass-local-validation/**`, ledger.

### Explicitly forbidden

- A second equivalence engine; bypassing `verifyBoundedEquivalence`.
- Weakening existing transaction/contract tests; changing `PHASE8_CONTRACT_VERSION` (field is additive and optional).
- Promoting unknown/timeout to adoption.

## Design

1. **Validation record**: `{ validation: 'equivalent', equivalenceProofId, verifier: 'hex.symbolic.verify.bounded-equivalence', verdictSource: 'unsat-difference' | 'model-validated' }` or `{ validation: 'refuted'|'unknown'|'unsupported', reason: <code>, diagnostics? }`.
2. **Proof digest**: `rewriteProofDigest = stableDigest({ kind:'phase8-rewrite-adoption', passId, transformKind, targets, beforeDigest, afterDigest, verifierIdentity, verdict, claimKind })` — recomputable; commit-time check re-derives from the record and compares.
3. **Commit rules** in `runPassTransaction` after `pass.run` before staging commit:
   - any transform `validation === 'refuted'` → transaction refused `rewrite-refused:<passId>`;
   - `unknown`/`unsupported` → transform dropped, diagnostics appended (transaction may commit);
   - `equivalent` → digest must match recompute, else refuse `rewrite-proof-id-mismatch`;
   - transform with a declared `rewrite` payload but no validation and no explicit `unvalidatedReason` → refuse `rewrite-unvalidated`.
4. **Passes opt in** by attaching validation records; existing passes without rewrite payloads are unaffected (no behavior change).

## Test Strategy

- Positive: probe pass with `x+x → x<<1` via ExhaustiveBvBackend commits with proof id; replay identical.
- Refuted: `x+1 → x+2` with SAT backend → transaction refused, counterexample in diagnostics.
- Unknown: unsupported entity / missing correspondence / timeout → transform dropped, diagnostics recorded, transaction commits without the rewrite.
- Forged: mutated proof id → refuse.
- Regression: existing substrate tests unchanged and green.

## Constitution Check

| Gate | Result |
|---|---|
| One canonical semantic truth | PASS — reuses the canonical verifier |
| Explicit uncertainty | PASS — unknown/refuted never adopt |
| Deterministic counterexample | PASS — SAT model retained in diagnostics |
| Bounded/browser-safe | PASS — bounded BV slices; cancellation propagated |
| Denominator integrity | PASS — additive tests |
