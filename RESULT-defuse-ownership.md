# Semantic IR def-use ownership — residue from D's architecture invariant

Lane: `fix/arch-ir-runtime-defuse-ownership`
Base: `16987f6991664fedcab6e49042dc8f59904a217f` (`review/arch-defects-acd`, i.e. D + A + C)

This closes the remaining half of D's invariant 1
(`tests/arch-invariants/ir-runtime-ownership.test.mjs`), which lane A's
reachability-memo fix left red:

| test | before | after |
| --- | --- | --- |
| built Semantic IR owns no runtime function or closure | ✖ `['defUse']` | ✔ |
| Semantic IR stays a detached value after the analysis queries | ✖ `DataCloneError: () => projected.values could not be cloned.` | ✔ |

D's test file is **unmodified** (byte-identical blobs to the base).

## Root cause

Two producers published the def-use index as a **function-valued own property on
the Semantic IR itself**:

- `js/semantics/compat/semantic-ir-v2-to-v1.js` — `projected.defUse = () => projected.values;`
  This is the **default production path**: `js/ir-core.js buildIR` dispatches
  `V2_COMPAT` → `buildSemanticV2CompatibilityPipeline` →
  `projectSemanticIrV2ToLegacyV1`. It is the closure D's fixture actually hit.
- `js/architecture/compat/ir-core-arm64-aapcs64-v1.js` — `ir.defUse = () => ir.values;`
  The explicit legacy-v1 oracle mode (`semanticMigrationMode: 'legacy-v1'`).

The closure had no closed-over state beyond the IR itself: the def-use index was
never anything except `ir.values` (each value carries `value.uses`). But because
it was an own function property, `structuredClone(ir)` threw
`DataCloneError`, the IR stopped being a detached value, and consumers began
probing `typeof ir.defUse === 'function'` — `js/ir.js`'s
`isCanonicalV2CompatibilityProjection` turned that convenience accessor into the
compatibility contract for "this is a finished v2 → v1 projection".

The audit also found a second, **dead** function-valued own property on the same
IR: `ir.newValue = newValue;` in the legacy core (the builder closure was only
ever used through its closure scope; nothing in the tree read `ir.newValue`).

## Cache/ownership before → after

| | before | after |
| --- | --- | --- |
| def-use index | `ir.defUse` / `projected.defUse` closure owned by the IR | `defUseFor(ir)` in `js/semantics/def-use.js`; the index is the plain `values` table |
| legacy builder | `ir.newValue` closure owned by the IR (dead) | closure stays in scope only |
| contract probe | `typeof model.defUse === 'function'` | `hasDefUseIndex(model)` (semantic data: the published SSA value index) |

No WeakMap is used, deliberately. A's reachability fix needed a WeakMap because
it memoized a real per-IR closure + explored-answer map. Here there is no derived
runtime state to own: the index already *is* the IR's plain semantic data, so
ownership is "a module-level canonical reader, nothing stored on the IR". Adding
a WeakMap would only re-create empty ownership. Lifetime is unchanged (the index
lives and dies with the IR).

## Production changes

- **new** `js/semantics/def-use.js` — `defUseFor(ir)` (returns the SSA value
  table or `null`) and `hasDefUseIndex(ir)`. Dependency-free.
- `js/semantics/compat/semantic-ir-v2-to-v1.js` — do not attach `projected.defUse`.
- `js/architecture/compat/ir-core-arm64-aapcs64-v1.js` — do not attach
  `ir.defUse`, do not attach dead `ir.newValue`.
- `js/ir.js` — re-export `defUseFor`; `isCanonicalV2CompatibilityProjection`
  now identifies the projection by its producer-owned `compat` record plus the
  published SSA value index instead of by a runtime method. (Without this, every
  real projection would look like a raw legacy model and be re-lifted by the
  legacy ARM64 decoder.)
- `js/decompiler/phase8/transaction-core.js` — `seedAnalysisState` reads
  `defUseFor(ir)` instead of `ir.defUse ?? null`.

`defUse` semantics/results are unchanged: `defUseFor(ir) === ir.values`, and the
def-use relation (`value.uses`) is untouched. `js/analysis/query/**` (lane B) was
not modified.

## Consumer migration (tests)

Not D's tests. These pin the *old* contract and had to move with it:

1. `tests/semantic-v2/compat-v1-core.test.mjs` — the "current v1 public shape"
   assertion `typeof out.defUse === 'function'` → `typeof out.defUse === 'undefined'`
   + `defUseFor(out) === out.values` + no function-valued own property.
2. `tests/semantic-v2/ir-reachability-cache-ownership.test.mjs` — A's
   "pre-existing contract: defUse is the only function-valued IR property"
   (`['defUse']`) → `[]`, plus `defUseFor(ir) === ir.values` and
   `structuredClone(ir)`. A's reachability-memo contracts are untouched.
3. `tests/issue-4013-bfx-direction-constant.mjs` — two synthetic
   "canonical projection" fixtures satisfied the probe with `defUse: () => []`.
   Migrated to the new semantic marker `values: []` so they keep exercising the
   canonical short-circuit (with only `defUse` they silently fell through to a
   failed legacy re-lift).
4. `tests/phase8/provenance/switch-render.test.mjs` — stale comment only.

## New regression

`tests/semantic-v2/ir-def-use-ownership.test.mjs` (auto-discovered by
`npm run semantic-v2:test`): built IR owns no function-valued property (default
**and** legacy-v1 producers), `structuredClone(ir)` succeeds, `defUseFor` is
canonical/total, the def-use relation still holds (every instruction arg is
recorded in its value's `uses`), barrier semantics untouched, and a canonical
projection is not re-lifted.

Verified it catches the pre-fix defect: with only the two producers reverted,
**3 of 6 tests fail** (`built IR owns no function-valued property`,
`legacy ARM64 producer`, `barrier semantics`); restored → 6/6.

## Verification (all finite timeouts)

Focused / related — all green in this worktree:

| target | result |
| --- | --- |
| D `tests/arch-invariants/ir-runtime-ownership.test.mjs` (unmodified) | **7 / 7** (was 5 pass / 2 fail) |
| new `tests/semantic-v2/ir-def-use-ownership.test.mjs` | **6 / 6** |
| A `tests/semantic-v2/ir-reachability-cache-ownership.test.mjs` | **1 / 1** |
| `tests/semantic-v2/compat-v1-core.test.mjs` | **1 / 1** |
| `tests/phase7/analysis-query/analysis-query-decompiler-projection.test.mjs` (B, untouched) | **2 / 2** |
| `tests/issue-4013-bfx-direction-constant.mjs` | pass |
| `tests/phase8/provenance/switch-render.test.mjs` | **11 / 11** |
| `tests/phase8/provenance/validation.test.mjs` | **8 / 8** |
| `tests/phase8/issue-8902-var-structural-key-ssa-value-identity.test.mjs` | **4 / 4** |
| `tests/performance/analysis-identity.test.mjs` (baseline oracle) | **3 / 3** |
| `tests/semantic-v2/{contract-ssa-memoryssa,memoryssa-proof-cache,verification-ssa}` | **3 / 3** |
| `seedAnalysisState` consumers: `phase8/memory/{c2-acceptance,gvn,issue-4697,issue-5484,issue-5541,dce}`, `phase8/provenance/dead-call-result`, `phase8/scalar/c2-02-pre-fix` | all green (dce 16/16 at ~250 s) |
| `tests/ir.mjs` | **34 / 34** |
| `tests/ir-alias.mjs`, `tests/decompiler-semantic.mjs` (default mode) | 9/9, ok |
| `tests/migration-guardrails.mjs` | PASS |
| `tests/check.mjs` | 5273 files ok |
| `tests/arch-invariants/*.test.mjs` | 17 pass / 2 fail — the 2 reds are invariant 2 (`query-huge-producer`, lane B), not this lane |

Broader — **no new failures vs the same base**:

- `npm run semantic-v2:test` (quiet wrapper, 480 s): the same **4 execution
  lanes** fail here **and at base `16987f699`** with the identical individual
  failures: `c4-return-control-target`, `issue-3327-artifact-storage-integrity`,
  `issue-4513-memoryssa-access-provider-completeness`,
  `issue-4534-ssa-definition-binding`, `repair-storage-class-alias`,
  `repair-v1-add-with-carry-def-use`, `evidence-chain:current-corpus-group`
  (legacy-differential `ir-alias` / `decompiler-semantic`), `required-regressions`
  (`effects:test` / `invariants:test`), `userscript-sync`.
  The two legacy-differential script failures were reproduced byte-for-byte at
  base under the same `setSemanticMigrationMode('legacy-v1')` preload.
- `tests/phase7/analysis-query/*.test.mjs`: 40 pass / 8 fail — **identical at
  base** (issue-4367 / #5582 / #5630 runtime-evidence lanes).

## Known limitations

- `ir.defUse` / `ir.newValue` are no longer readable off the IR in any mode.
  Any out-of-tree consumer that probed either must use `defUseFor(ir)` from
  `js/ir.js`. In-tree consumers are all migrated.
- `seedAnalysisState`'s `seed.ssa.defUse` now carries the value table instead of
  a closure. It has no in-tree reader; the field is kept so the seed shape is
  unchanged.
- `js/analysis/query/app-adapter.js` still defensively strips an `ir.defUse`
  function from query snapshots (lane B, untouched). It is now a no-op for
  built IRs, which is the intended direction, but the strip path itself was not
  removed here.
- `DERIVED_IR_KEYS` in `js/decompiler/phase8/analysis-identity.js` still lists
  `defUse` (and the mirrored test oracle). It is a skip-list, so the entry is now
  inert; removing it is cosmetic and was left alone to keep the identity oracle
  untouched.
