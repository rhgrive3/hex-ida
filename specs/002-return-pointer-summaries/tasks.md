# Tasks: Complete Return-Pointer Summary Matrix (C1-02 Phase 2)

## 1. Matrix lock tests (T001–T004)

- [x] T001 Create `tests/phase7/summary/c1-02-target-matrix.test.mjs` locking User Story 2
      axes 1–6 (missing summary, identity mismatch, incomplete status, unknown call
      effects, empty provenance, arg top/bottom) — each exactly one variation, each
      asserting `topPointsTo('unresolved-call')`.
- [x] T002 Extend the same file with axes 7–11 (absent argument, malformed offset,
      target construction failure, top/bottom candidate, join-to-top budget).
- [x] T003 Add recursive-callee case (axis 12): self-recursion produces an explicit
      conservative state or budget stop reason, and never a precise guessed set.
      Hardened to drive the real `solveInterproceduralSummaries` fixed point over a
      self-recursive return-provenance cycle wired via `directCalls`.
- [x] T004 Add User Story 1 positive case: complete, identity-matched, effect-free
      callee summary yields the exact joined target set with provenance preserved.

## 2. Production gaps (T005–T006)

- [ ] T005 Run the matrix against current main. Any axis that does NOT stay
      conservative is a real soundness gap; fix it in `js/analysis/pointsto/local.js`
      or `js/analysis/summary/interprocedural.js` with the smallest change that
      restores conservatism, reusing existing budget/stop-reason machinery (R3).
- [ ] T006 Re-run `tests/phase7/summary/` focused suite plus
      `tests/phase7/pointsto/loaded-pointer-recovery.test.mjs` to prove no regression
      of the PR 2434 floor.

## 3. Evidence (T007–T009)

- [ ] T007 Record exact-head focused results and the branch SHA in
      `docs/analysis-improvement-finding-ledger.md` (C1-02 row), quiet mode.
- [ ] T008 Commit in small steps: tests first (T001–T004), then any fix, then evidence.
- [ ] T009 Leave PR creation and Sol review to the owner; do not merge to main.
