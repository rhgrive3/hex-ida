# Tasks: Formal / Relaxed-Memory / Undefined-Mask Oracle Matrix (ME-01 Phase 1)

## 1. Survey (T001–T002)

- [x] T001 Map the existing oracle infrastructure: `EXTERNAL_ORACLE_POLICY`,
      `runDifferentialHarness`, memory-ordering lowering
      (`js/semantics/ir/from-machine-effects.js` default `ordering: 'unknown'`).
- [x] T002 Inventory which architectural undefined outputs/masks the current
      machine-effects lowering already models vs. drops (per arm64 denominator) — recorded 2026-09-01
      as the `ME01_UNDEFINED_INVENTORY` frozen inventory inside
      `tools/validation/machine-effects/ordering-undefined-matrix.mjs`: modeled = a64 variable-shift
      modulo, SDIV/UDIV division-by-zero returns-zero, SDIV signed-overflow wrap, acquire/release/relaxed
      orderings; not modeled (conservative) = non-atomic ordering rejected at contract, unknown ordering
      rejected, absent ordering defaults to explicit `unknown` at the effect-to-V2 boundary
      (`js/semantics/ir/from-machine-effects.js`), unmodelled operand keeps bundle `partial`.

## 2. Denominator (T003–T005)

- [x] T003 Create `tools/validation/machine-effects/ordering-undefined-matrix.mjs`:
      frozen per-case records for every `SEMANTIC_MEMORY_ORDERINGS` value plus
      undefined-output and undefined-bit-mask cases. Each record: id, ordering,
      must-preserve, must-forbid (re-orderings the oracle source forbids),
      expected classification — created 2026-09-01: frozen module with
      `ME01_ORDERING_RECORDS`, `ME01_UNDEFINED_OUTPUT_RECORDS`, `ME01_CONTRACT_RECORDS`,
      `ME01_UNDEFINED_INVENTORY`, schema validator, and the composite
      `ME01_ORDERING_UNDEFINED_MATRIX`; every record carries id / ordering / must-preserve /
      must-forbid / expected-classification.
- [x] T004 Register any new oracle source in `EXTERNAL_ORACLE_POLICY` with role,
      semantic authority, and required paths (no network) — done on the merged phase2 branch:
      `formal-architectural-models` and `herdtools7-aarch64-memory-model` (litmus fixtures,
      declared-outcome-universe authority) registered in `tools/validation/machine-effects/external-oracles.mjs`
      with `defaultNetworkRequired: false`.
- [x] T005 Add `tests/machine-effects/ordering-undefined-matrix.test.mjs` running
      each record through the real lowering + differential classification:
      ordering preserved bit-exactly or classified `mismatch`; `unknown` stays
      `unknown`; undefined outputs stay conservative; masks survive to V2 — test exists on the merged
      branch and now also consumes the frozen matrix module (10/10 PASS 2026-09-01).

## 3. Gaps (T006)

- [x] T006 Any record that fails because production drops an ordering or an
      undefined bit gets the smallest fix in the lowering path; re-run the full
      machine-effects suite to prove no sibling regression — no record fails on current
      main + phase2 merge (orderings preserved, undefined outputs explicit, conservative states held);
      full `npm run effects:test` PASS (238.8s quiet run) and `tests/machine-effects/` 163/163 on head
      `git+post-merge` — no lowering fix required.

## 4. Evidence (T007–T008)

- [x] T007 Exact-head run of `tests/machine-effects/` quiet; record results and SHA
      in the ME-01 ledger row — quiet run on campaign head: `npm run effects:test` PASS;
      `node --test tests/machine-effects/*.test.mjs` 163/163; formal evidence artifacts digest check PASS;
      recorded in the ledger ME-01 row.
- [x] T008 Small commits; no PR; Sol review first — increments kept small (matrix module + test
      import + generated resync + allowlist extension); PR/merge remains a separate Sol-gated step.
