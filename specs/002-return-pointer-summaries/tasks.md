# Tasks: Return-Pointer Summaries Matrix & Verification (HEX-C1-02)

## 1. Matrix Lock Tests (T001–T004)

- [x] T001 Create `tests/phase7/summary/c1-02-target-matrix.test.mjs` locking 13-axis negative matrix:
      axis 1 (missing summary), axis 2 (targetless call), axis 3 (snapshot/analyzer/schema/contract/function identity mismatch),
      axis 4 (partial/truncated status), axis 5 (unknown call effects), axis 6 (empty provenance),
      axis 7 (wrong/missing return index), axis 8 (top argument), axis 9 (absent argument),
      axis 10 (malformed offset), axis 11 (unknown provenance kind), axis 12 (budget target cap).
- [x] T002 Add recursion axes 13a/13b/13c: self-recursion, mutual recursion, and unconverged recursion
      through the real `solveInterproceduralSummaries` fixed point.
- [x] T003 Add positive cases: precise join of multiple argument provenance facts and root/allocation provenance facts.
- [x] T004 Run focused test suite `node --test tests/phase7/summary/c1-02-target-matrix.test.mjs` (22/22 PASS).

## 2. Production & Subsystem Verification (T005–T008)

- [x] T005 Verify production floor from PR #2434 on current main (`js/analysis/pointsto/local.js`, `js/analysis/summary/**`). No production change needed as current main is already strictly fail-closed.
- [x] T006 Run all Phase 7 summary and pointsto suites (`tests/phase7/summary/*.test.mjs`, `tests/phase7/pointsto/*.test.mjs`) (138/138 PASS).
- [x] T007 Run canonical Phase 7 runner and verify loaded-pointer recovery floor (`tests/phase7/pointsto/loaded-pointer-recovery.test.mjs`).
- [x] T008 Run broad repository checks (`npm run check` / `npm test`).

## 3. Evidence & Reconciliation (T009–T010)

- [x] T009 Update `docs/analysis-improvement-finding-ledger.md` for HEX-C1-02 with exact-head matrix evidence and COMPLETE status.
- [x] T010 Validate PR, exact-head CI, merge to main, and post-merge verification.
