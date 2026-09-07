# Tasks: Formal / Relaxed-Memory / Undefined-Mask Oracle Matrix (ME-01 Phase 1)

## 1. Survey (T001–T002)

- [x] T001 Map the existing oracle infrastructure: `EXTERNAL_ORACLE_POLICY`,
      `runDifferentialHarness`, memory-ordering lowering
      (`js/semantics/ir/from-machine-effects.js` default `ordering: 'unknown'`).
- [ ] T002 Inventory which architectural undefined outputs/masks the current
      machine-effects lowering already models vs. drops (per arm64 denominator).

## 2. Denominator (T003–T005)

- [ ] T003 Create `tools/validation/machine-effects/ordering-undefined-matrix.mjs`:
      frozen per-case records for every `SEMANTIC_MEMORY_ORDERINGS` value plus
      undefined-output and undefined-bit-mask cases. Each record: id, ordering,
      must-preserve, must-forbid (re-orderings the oracle source forbids),
      expected classification.
- [ ] T004 Register any new oracle source in `EXTERNAL_ORACLE_POLICY` with role,
      semantic authority, and required paths (no network).
- [ ] T005 Add `tests/machine-effects/ordering-undefined-matrix.test.mjs` running
      each record through the real lowering + differential classification:
      ordering preserved bit-exactly or classified `mismatch`; `unknown` stays
      `unknown`; undefined outputs stay conservative; masks survive to V2.

## 3. Gaps (T006)

- [ ] T006 Any record that fails because production drops an ordering or an
      undefined bit gets the smallest fix in the lowering path; re-run the full
      machine-effects suite to prove no sibling regression.

## 4. Evidence (T007–T008)

- [ ] T007 Exact-head run of `tests/machine-effects/` quiet; record results and SHA
      in the ME-01 ledger row.
- [ ] T008 Small commits; no PR; Sol review first.
