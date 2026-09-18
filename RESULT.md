# RESULT.md — AnalysisQuery decompile public projection / serialization architecture

Lane: `fix/arch-query-projection` (`/mnt/workspace/hex-agent-b`)
Area: AnalysisQuery decompile DTO — internal analysis state vs. public presentation contract.
Primary file: `js/analysis/query/app-adapter.js`.

## 1. Consumer investigation

`AnalysisQueryAPI.decompile()` is reached from three producers in the adapter:
`app.getDecompile()` (app-owned), `result.value.decompiler` (canonical semantic function,
already `decompilerSnapshot`-projected) and `decompile(result.value.model)` (legacy ARM64).

Every production consumer was traced. Only presentation data is used:

| Consumer | Fields actually read |
| --- | --- |
| `js/ui/product-base.js` (pseudocode tab) | `res.value` → `createDecompilerProvenanceView` |
| `js/ui/decompiler-provenance.js` | `lines`, `renderProvenance.{snapshotId,completeness,reverse,entities,ledger,transformReverse}`, `code` |
| `js/ui/decompiler-provenance-sheet.js` | same as above |
| `js/ai/ui/hex-context.js` | `pseudocode ?? text ?? code` (plus `completeness`) |
| `js/ai/ui/hex-context-query-base.js` | `pseudocode ?? text ?? code` |
| `js/ai/tools/registry.js` (`decompile_function`) | `value.text`, `value.complete`, `value.reason` |
| `js/decompile-legacy.js` `decompiledText()` | `lines` only |

No production consumer reads `ir`, `ctx`, `highVariables`, `cAst`, `semanticAst`,
`semanticFacts`, `sourceMap`, `prototype`, `phase8`, `metrics`, `rewriteProof`,
`rewriteStats`, `passMetrics`, `conditions`, `sideEffects`, `importantInputs/Outputs`
or `expressionHistoryBinding` from the decompile query DTO. Raw IR is already owned by
the dedicated `semanticIR()` query (`pipeline.semanticIr`); the CFG by `cfg()`.

### Contract conflict that had to be resolved

Two existing, authoritative tests disagreed about `ir`:

- `tests/phase7/.../analysis-query-decompiler-projection.test.mjs` asserted the decompile
  DTO **keeps** a serializable `ir` (only `ir.defUse` removed). Its `ir` shape
  (`ir.nodes` / `ir.provenance`) does not exist in any real producer — it was fixture-only.
  Introduced by `313af62a6`.
- `tests/phase8/provenance/navigation.test.mjs:72-73` asserted
  `Object.hasOwn(query.value,'ir') === false` and `'ctx' === false`. This test is part of
  `npm run phase8:test` → `npm run check`, and it was **RED on the base**, because the
  deny-list projection kept both. Introduced by `9d6a98ae2`.

`decompilerSnapshot()` (`js/analysis/semantic-function-base.js:1286`) documents the intended
boundary: "Public presentation data only: never publish the private IR/context or its
executable observers through the structured-clone query boundary." The user selected the
presentation-only architecture, so the phase7 `ir` assertions were rewritten to the new
explicit contract (documented here, not silently deleted).

## 2. Before / after public DTO contract

**Before** (`cloneableDecompilerProjection`): shallow copy of the producer result plus a
deny-list of known callbacks (`ir.defUse`, `ctx.values.at/defAt`,
`ctx.rowOfAddress/addrOfRow/symbolFor/rawSymbolFor/fieldFor`). Everything else — including
the unbounded, deeply recursive internal graph — stayed in the published result.

Consequence: `AnalysisQueryAPI.#wrapResult` calls `structuredClone(value)` and then
recursive `deepFreezeTree`. `structuredClone` overflows at a nesting depth of ~2000 on
this runtime, so a large function failed with `analysis-query-value-unclonable`
(the caught `RangeError: Maximum call stack size exceeded`) **even though decompilation
succeeded**.

**After**: every producer result crosses one explicit projection:

```
published decompile DTO =
  semantic, signature, summary, pseudocode, text, code,
  lines, evidence, warnings, labels, coverage,
  renderProvenance, unknownInstructions
```

- Schema is explicit and exported: `DECOMPILE_DTO_SCHEMA = 'analysis-query-decompile-presentation-v1'`,
  `DECOMPILE_PUBLIC_FIELDS`.
- Internal producer state is declared, never published: `DECOMPILE_INTERNAL_FIELDS`
  (`ir`, `ctx`, `types`, `highVariables`, `cAst`, `semanticAst`, `semanticFacts`,
  `sourceMap`, `prototype`, `aggregateLayouts`, `rewriteProof`, `rewriteStats`,
  `passMetrics`, `phase8`, `phase8Projection`, `metrics`, `importantInputs`,
  `importantOutputs`, `sideEffects`, `conditions`, `expressionHistoryBinding`,
  `semanticSuppressionHistory`, `semanticStatementRenderHistory`). A declared internal
  field is dropped **without inspecting its contents**, which is why live observers
  (`ir.defUse`, `ctx.rowOfAddress`) no longer fail the query.
- Fail-closed is preserved: any field in *neither* list is unknown to the schema, and if it
  carries an unclonable value (function/symbol/`SharedArrayBuffer`) the query still throws
  `analysis-query-value-unclonable` instead of silently swallowing the producer error.
- Availability is explicit: a public field whose structure exceeds the clone-safe depth
  budget (64; measured presentation depth is ≤ 8) is **withheld**, not silently truncated.
  The result is then reported as `completeness:'truncated'` with
  `status.projection = { schema, withheld:[...] }`.
- `unknownInstructions` is the only `ctx`-derived public scalar (a safe integer), matching
  `decompilerSnapshot`.
- `semanticIR()` owns raw IR; `cfg()` owns the CFG.

## 3. Changed files

- `js/analysis/query/app-adapter.js` — replaced `cloneableDecompilerProjection()` with the
  explicit `publicDecompilerProjection()` + `DECOMPILE_PUBLIC_FIELDS` /
  `DECOMPILE_INTERNAL_FIELDS` / `DECOMPILE_DTO_SCHEMA`; all three `decompile()` producer
  paths now share one `publish()` boundary.
- `tests/phase7/analysis-query/analysis-query-decompiler-projection.test.mjs` — rewritten to
  the new explicit contract (`ir`/`ctx`/`highVariables`/`cAst`/`phase8` not published, raw
  IR owned by `semanticIR()`); the fail-closed test is unchanged.
- `tests/phase7/analysis-query/analysis-query-decompiler-dto.test.mjs` — new focused suite
  (tests A–D).
- `RESULT.md` — this file.

`js/analysis/query/api.js` and `js/ir-base.js` were **not** modified.

## 4. Stress test

Reproduced on the base before the fix (`/tmp/repro-large.mjs`, a synthetic producer with a
deep internal `ir.values` chain plus normal presentation fields):

| Deep-chain depth | Base | After |
| --- | --- | --- |
| 2 000+ (`structuredClone` alone) | `RangeError: Maximum call stack size exceeded` | — |
| 5 000 | `TypeError: analysis-query-value-unclonable` | query OK |
| 30 000 | `TypeError: analysis-query-value-unclonable` | query OK |
| 200 000 | `TypeError: analysis-query-value-unclonable` | query OK |

Focused tests (`tests/phase7/analysis-query/analysis-query-decompiler-{projection,dto}.test.mjs`):

- A — small normal result: `pseudocode` / `lines` / `renderProvenance` preserved, result
  and each published field frozen, detached from the producer.
- B — large synthetic producer: raw producer graph is not clone-safe at 50 000 depth
  (`assert.throws(structuredClone, RangeError)`), yet the query succeeds; presentation
  fields preserved; published size is **identical** for 2 000 and 50 000 internal depth and
  under 4 KiB → output growth is bounded by presentation data, not the analysis graph.
- C — unrelated callback: `metadata.callback` still rejects with
  `analysis-query-value-unclonable`; a clone-safe non-schema field (`metadata.note`) is
  simply not published.
- D — provenance/navigation: the real legacy ARM64 `decompile(model)` result keeps
  `renderProvenance` (deep-equal, detached) and `createDecompilerNavigation(...).selectLine()`
  returns `ready` through the query boundary.

Verification runs (quiet, bounded):

| Command | Base | After |
| --- | --- | --- |
| focused phase7 projection + DTO | 2 pass / 1 file red contract | **6 pass / 0 fail** |
| `npm run phase7:test` | 2646 tests / 2517 pass / **129 fail** | 2650 / 2521 / **129 fail** (same failures, +4 new passes) |
| `node --test tests/phase8/provenance/*.test.mjs` | 596 / 585 / **11 fail** | 596 / **587** / **9 fail** (fixed 2, no new failures) |
| `node --test tests/phase8/substrate/{representation-candidates,proof-target-decisions}.test.mjs` | — | **74 / 74 pass** |
| `tests/api.mjs`, `tests/ui/routes.mjs` | — | pass |
| `npm run lint` | — | pass (5266 files) |
| `npm run module-boundaries:test` | — | pass |
| `tests/product-surface-canonical.test.mjs` | 11 / 8 / 3 | 11 / 8 / 3 (identical) |

The 129 phase7 failures and the 9 remaining phase8 provenance failures were confirmed
pre-existing by re-running the same suites on the pristine base (identical counts and
identical test names). `npm run phase8:test` in full exceeds the broad-run budget and was
replaced by the focused provenance + substrate suites listed above, per the low-token /
focused-fallback rule.

## 5. Compatibility impact

- **Fixes a red gate:** `C4-03 default ARM model and direct decompiler adapter routes keep
  cloneable provenance` (phase8, part of `npm run check`) now passes.
- Product pseudocode, the provenance/navigation view and the legacy sheet are unchanged:
  `pseudocode`, `lines`, `renderProvenance` are published byte-for-byte (detached + frozen),
  and all phase8 provenance/substrate consumers of those fields pass.
- AI surfaces (`hex-context`, `hex-context-query-base`, `registry`) keep their
  `pseudocode ?? text ?? code` fallbacks.
- **Breaking for out-of-tree callers** that read `ir` / `ctx` / `highVariables` / `cAst` /
  `semanticAst` / `phase8` / `metrics` off the decompile DTO. Those are internal; raw IR is
  served by `semanticIR()`, the CFG by `cfg()`.
- Non-schema clone-safe fields are no longer passed through (strict allow-list).
- Deliberate fail-closed behaviour: a **new** internal producer field that holds a closure
  will make the query throw `analysis-query-value-unclonable` until it is added to
  `DECOMPILE_INTERNAL_FIELDS`. Verified against the real legacy decompiler result, whose
  full field set is enumerated in `DECOMPILE_INTERNAL_FIELDS`.

## 6. Known limitations

- The depth budget (64) is a backstop, not a size cap. If a producer ever ships a
  presentation field deeper than 64 the field is withheld and the result is reported
  `truncated` with `status.projection.withheld`; the product then shows the remaining
  fields rather than crashing. Real presentation data measured at depth ≤ 8, so this path
  is not exercised by the current producers.
- `decode` sizes are still linear in the rendered function: a genuinely huge function
  yields correspondingly large `pseudocode` / `lines`. The bound is that the result no
  longer depends on the internal analysis graph.
- `js/analysis/query/api.js` still uses recursive `structuredClone` + `deepFreezeTree`. It
  was not changed because the adapter boundary now guarantees shallow, clone-safe values;
  the envelope would only need hardening if a producer were allowed to publish deep data
  directly.
- The legacy ARM64 path has no dedicated raw-IR query: `semanticIR()` serves the canonical
  semantic pipeline (`pipeline.semanticIr`). Legacy consumers that used `ir` from this DTO
  must go through the legacy producer or a new dedicated query.
