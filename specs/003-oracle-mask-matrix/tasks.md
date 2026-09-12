# Tasks: Formal / Relaxed-Memory / Undefined-Mask Oracle Matrix (ME-01 Phase 1)

## 1. Survey (T001–T002)

- [x] T001 Map the existing oracle infrastructure: `EXTERNAL_ORACLE_POLICY`,
      `tools/validation/semantic-v2/differential.mjs` / `runDifferentialHarness`, memory-ordering lowering
      (`js/semantics/ir/from-machine-effects.js` default `ordering: 'unknown'`).
- [x] T002 Inventory which architectural undefined outputs/masks the current
      machine-effects lowering already models vs. drops (per arm64 denominator).

## 2. Denominator (T003–T005)

- [x] T003 Create `tools/validation/machine-effects/ordering-undefined-matrix.mjs`:
      frozen per-case records for every `SEMANTIC_MEMORY_ORDERINGS` value plus
      undefined-output and undefined-bit-mask cases. Each record: id, ordering,
      must-preserve, must-forbid (re-orderings the oracle source forbids),
      expected classification.
- [x] T004 Register any new oracle source in `EXTERNAL_ORACLE_POLICY` with role,
      semantic authority, and required paths (no network).
- [x] T005 Add `tests/machine-effects/ordering-undefined-matrix.test.mjs` running
      each record through the real lowering + differential classification:
      ordering preserved bit-exactly or classified `mismatch`; `unknown` stays
      `unknown`; undefined outputs stay conservative; masks survive to V2.

## 3. Gaps (T006)

- [x] T006 Any record that fails because production drops an ordering or an
      undefined bit gets the smallest fix in the lowering path; re-run the full
      machine-effects suite to prove no sibling regression.

## 4. Evidence (T007–T008)

- [ ] T007 Exact-head run of `tests/machine-effects/` quiet; record results and SHA
      in the ME-01 ledger row.
- [ ] T008 Small commits; no PR; Sol review first.

## 2026-09-12 integration checkpoint

T002 is recorded in research.md: generic mask transport exists, but no ARM64
producer supplies per-result masks and no pinned formal record proves such masks.
Absence alone is not a demonstrated production drop. T004 reuses the two existing
policy registrations; no duplicate oracle was introduced. T003/T005 now lock ten
transport cases and five separate, claim-local litmus references. Matching a
synthetic transport case is not architectural undefined-bit proof.

The ten transport cases show no dropped ordering or undefined bit in the existing
production path, so T006 requires no production patch. All 33 focused matrix,
ownership and existing V2 mask-transport tests pass. Observations cover V2 memory,
MemorySSA memory/sequencing, V1 memory and masks. Negative mutations cover loss,
atomicity and conditional predicates; unmodified-copy controls prevent graph
cloning errors from masquerading as successful semantic detection.

The canonical 220-file run finished with 13 failures in untouched compiler,
WebKit, pre-existing instruction and prior-oracle-artifact checks. Its matrix
file passed. Full-suite green is unproven; issue/environment repairs are excluded
by the user. Retained receipt:
`me01-canonical-wip-cf43787c-0cfb-44a4-975f-c39628e6849d.json`.
Focused repaired receipt:
`me01-downstream-repaired-ee16f832-d22a-4cf8-b4ca-43d1c2cd232a.json`.
Both are under persistent evidence/analysis-roadmap-20260909.

T007 exact-head evidence is pending. T008 stays open until the named Sol review
exists; an independent read-only review does not claim that model-specific gate.
No new PR is being created; authorized source backup uses the existing integration
branch/PR #7036. The whole ME-01 finding remains PARTIAL.
