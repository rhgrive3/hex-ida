# Tasks: Pass-Local Refinement Validation (HEX-C4-04)

## Phase 1: Tests first (blocking)

- [x] T001 Create `tests/phase8/substrate/pass-validation.test.mjs`: positive commit with proof id
  (`x+x → x<<1`, ExhaustiveBvBackend, deterministic replay), refuted rewrite refuses transaction,
  unknown/unsupported rewrite is dropped with diagnostics, forged proof id refuses, unvalidated
  rewrite payload refuses; pre-fix assertions fail on the base.

## Phase 2: Implementation

- [x] T002 Add typed transform `validation` field + `rewriteProofDigest` recompute check in
  `js/decompiler/phase8/contract.js` (fail-closed on malformed validation payloads).
- [x] T003 Add `js/decompiler/phase8/pass-validation.js` with `validateRewriteAdoption` wrapping
  the canonical `verifyBoundedEquivalence` (backend/session reuse, cancellation propagation,
  explicit unknown outcomes).
- [x] T004 Wire commit-time adoption rules into `js/decompiler/phase8/transaction.js`
  (refused on refuted/forged/unvalidated; drop+diagnose on unknown/unsupported; digest recheck on equivalent).

## Phase 3: Verification

- [x] T005 Run the focused suite + existing substrate suites (`pass-contract`, `invalidation`,
  `completeness`, `vertical`) — all green.
- [x] T006 Run `npm run phase8:test` and record results in the ledger.
- [x] T007 Update `docs/analysis-improvement-finding-ledger.md` HEX-C4-04 row with exact evidence.
