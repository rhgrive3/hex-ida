# Tasks: Phase 8 Provenance Completion (HEX-C4-03)

## Phase 1: Counterexample tests first (blocking)

- [x] T001 Create `tests/phase8/projection/line-provenance.test.mjs` with: (a) positive — collapsed
  truncation + induction rename keeps every consumed origin id on the produced source; (b) every
  rendered line resolves through `lineProvenance`; (c) negative — forged mapping fails closed;
  (d) determinism — two runs deep-equal; (e) text stability — pseudocode unchanged. Assert the
  pre-feature state fails the new assertions (provenance completeness not yet published).

## Phase 2: Implementation

- [x] T002 Union consumed origin ids into produced node sources in `js/decompiler/phase8/projection.js`
  merge/collapse/induction transforms (no id dropped).
- [x] T003 Publish frozen deterministic `lineProvenance` per output line in `applyPhase8Projection`
  (outputStartLine/outputEndLine → resolved origin incl. evidence reasons and intersecting transform records).
- [x] T004 Add `verifyLineProvenance` fail-closed verifier in `js/decompiler/phase8/projection.js`.

## Phase 3: Verification

- [x] T005 Run the focused new suite and the existing projection suites (`tests/phase8/projection/`,
  `tests/phase8/integration/final-projection.test.mjs`) — all green, pseudocode text unchanged.
- [x] T006 Run `npm run phase8:test` subsystem gate and record results in the ledger.
- [x] T007 Update `docs/analysis-improvement-finding-ledger.md` HEX-C4-03 row with exact evidence.
