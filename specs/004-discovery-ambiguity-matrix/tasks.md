# Tasks: Discovery Ambiguity Matrix (X-03 Phase 1)

## 1. Matrix (T001–T003)

- [ ] T001 Create `tests/phase7/discovery/ambiguity-matrix.test.mjs` locking User
      Story 1: swallow-overlap, partial-overlap, boundary-adjacent (no conflict),
      and shared-range cases; assert conflicts recorded and extent reset to
      `unknown`, symmetric on both candidates.
- [ ] T002 Lock User Story 2: vtable-entry and relocation-target pointing into a
      function body produce corroborating candidates (never `exact`), with
      conflicts or heuristic state, not silent merges.
- [ ] T003 Lock User Story 3 authority ladder: heuristic-only stays `heuristic`;
      one corroborator stays below `probable`; two corroborators reach `probable`
      but never `exact`; authoritative mints `exact`. Reparse in reverse order
      yields identical states and digests.

## 2. Gaps (T004)

- [ ] T004 Any failing case gets the smallest conservative fix in
      `js/analysis/discovery/`; re-run the whole discovery lane.

## 3. Evidence (T005–T006)

- [ ] T005 Exact-head quiet run of `tests/phase7/run.mjs`; record SHA/results in
      the X-03 ledger row.
- [ ] T006 Small commits; no PR; Sol review first.
