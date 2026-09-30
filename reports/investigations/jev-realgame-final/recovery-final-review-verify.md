# Independent verification — G1–G4 fixes (4b21fbd6d) + scoped decompile seam record

Lane: `jev-realgame-final` · agent: freebuff4 · evidence-only (no source edits, no commits, no API/live-Jev calls, no evaluation/outcome reads)

## 1. Tree state and byte identity

- Verified HEAD: `13d80f83cde09637d7218b81764799d3acc41cd5` (worktree clean, 0 dirty files). `4b21fbd6d` ("Verify recovery policy decisions and diagnose unbounded native query work") is an ancestor; successors `523c90a0f` and `13d80f83c` touch only `scripts/diagnose-cxx-query-recovery.mjs`, `tests/pinpoint-cxx-query-recovery-browser.mjs`, `tools/validation/phase7/cross-lane-inventory.mjs`.
- `git diff --stat b01f3e642..HEAD -- js/ scripts/jev-realgame-recovery-contract.mjs scripts/jev-realgame-final-contract.mjs userscript/` → empty. Production JS and E representation/prompt bytes are byte-identical to `b01f3e642`.
- Per-file sha256 at HEAD, all identical to my prior review hashes:

| file | sha256 (prefix) | matches prior review |
|---|---|---|
| `js/analysis/cxx/query-recovery.js` | `8fe2c74b2748bb77…` | yes |
| `js/analysis/query/app-adapter.js` | `d7e2a954782a8f71…` | yes |
| `js/analysis/cxx/project.js` | `63cd27a6adf305f6…` | yes |
| `js/analysis/cxx/member-types.js` | `d2da6615189c9fdf…` | yes |
| `js/analysis/cxx/member-index.js` | `a9763ca25965695e…` | yes |
| `js/panels-base.js` | `3b2d7c0eda1b6fcd…` | yes |
| `js/pinpoint.js` | `c94629ce03c6da91…` | yes |
| `scripts/collect-jev-realgame-recovery.mjs` | `a62b7cbe78beb677…` | yes |

## 2. Receipt hashes of the changed tooling

| file | sha256 |
|---|---|
| `scripts/verify-jev-realgame-recovery.mjs` | `a3cdbe92e3de2571d0856d9db709182d4c98a4a4f21d6d8655963cf3ecdb4b7a` |
| `scripts/evaluate-jev-realgame-recovery.mjs` | `111c730da5b38ce0c7b61ebbead53d6b2895812e3950acaf9397d80a092db909` |
| `tests/jev-realgame-final.test.mjs` | `c3d541fa06d54dc0b813249fe1c6c9a3cd1fa0511d271b2ab11297ba0b91302c` |
| `scripts/jev-realgame-recovery-contract.mjs` (= frozen `promptSha256`) | `e2f3f168feed368fc14e1d095c53590bb46f747075e364d67b71c3c01e3e3939` |
| `scripts/diagnose-cxx-query-recovery.mjs` (HEAD) | `90e37e2cfe580a3d2ce7e5858b5613e6095c6209aabc5c892f8ca9b7ba52c091` |
| `reports/…/recovery-policy-freeze.json` | `e242fa93…` (unchanged; `promptSha256` field = `e2f3f168…`, confirmed equal to the contract file hash) |

## 3. G1–G4 verification (diff `913b8d55d..4b21fbd6d`, read at HEAD)

**G1 — verifier re-hashes source bytes from current disk: FIXED.**
`verify-jev-realgame-recovery.mjs:24` — for every `[file,hash]` in `snapshot.sourceHashes`, `sha256(fs.readFileSync(new URL('../'+file,import.meta.url)))` must equal the frozen hash (`'current source drift'`). Runs inside the per-snapshot loop, so both snapshots are checked; keys resolve relative to `scripts/` → repo root. Evaluator has the same binding pre-run at `evaluate-jev-realgame-recovery.mjs:25`. Negative replay mutates both `snapshots[0].sourceHashes` and `summary.sourceHashes` to `'drift'` (so the deepEqual at :20 still passes) and must throw — covered by the sanctioned test below.

**G2 — `finalPolicy` and `failureCauses` re-derived: FIXED.**
- `failureCauses`: verifier `:41-45` recomputes `unreachableBecauseNotRecovered → ['candidate recovery failure']`, then `'stochastic instability'` iff `callArms.some(a=>new Set(row.arms[a].repeatedKeys).size>1)`, then `'insufficient member semantics or reranking failure'` iff `row.funnel.shortlist&&!row.arms.E.correct`; `assert.deepEqual(row.failureCauses,causes)`. Conditions, order, and string literals match the evaluator (`evaluate-jev-realgame-recovery.mjs:40,53,54`) line-for-line, and `row.funnel` was already deep-asserted against a fresh `funnel()` at `:40`.
- `finalPolicy`: verifier `:79-86` re-derives `DEVELOPMENT_ONLY / NOT_DECIDED / OPTIONAL_ADVISORY / NO_GO` from `summary.role`, `primary=summary.summaries.E`, `summary.perGame[*].E.net/regression/unsafeConfident/apiErrorRate`, and `controls.rows`, and binds `summary.controlsSha256` to the supplied `controlsBytes` (`:81`). The expression matches the evaluator (`:62-65`) exactly. New optional 4th CLI arg `controlsFile` wired at `:97,105`.
- Residual (minor, noted not blocking): the `finalPolicy` block is guarded `if(summary.role)` (`:79`); a direct API caller passing a summary without `role` would skip it. The CLI path cannot — `main()` indexes `experiment.corpora[summary.role]` first, which throws for a missing role.

**G3 — direct `promptSha256` assertion: FIXED (both sides).**
- Verifier `:15`: `assert.equal(policy.promptSha256, sha256(fs.readFileSync(new URL('./jev-realgame-recovery-contract.mjs',import.meta.url))))`.
- Evaluator `:17`: throws `'frozen representation/prompt binding'` pre-run on the same comparison.
- Independently confirmed: `recovery-policy-freeze.json` `promptSha256 = e2f3f168feed368…` equals the current contract file hash (both above), so the frozen binding holds at HEAD.

**G4 — per-row budget replay assertions: FIXED.**
Verifier `:35-38`, per case row: `attempted.length <= policy.collection.maxFunctionsPerQuery`; addresses unique (`new Set(…).size`); `Number.isFinite(elapsedMs) && elapsedMs>=0`; `elapsedMs >= policy.collection.maxElapsedMs ⇒ status==='budget-exhausted'`.
- Both real freezes carry `collection.maxFunctionsPerQuery:8`, `maxElapsedMs:15000` (read directly), so no `TypeError` bypass.
- Source-consistency of the invariant: `recoverCxxQueryMembers` caps `attempted` at `maxFunctions` and only ever sets `budget-exhausted` when `now()-started>=maxElapsedMs` (checked pre-loop-iteration `query-recovery.js:76` and post-loop `:85`, with `elapsedMs:now()-started` at `:86`) — the verifier's implication direction is exactly what the producer guarantees, including the boundary case.
- Negative replay covers `elapsedMs=20000` with `status:'complete'` → must throw.
- Residual (minor): no assertion on `recovery.status` values when `elapsedMs < maxElapsedMs`, nor on `attempted[].address` shape; missing `recovery`/`collection` fails closed via TypeError.

## 4. Sanctioned test (the single permitted command)

```
node --test --test-name-pattern='recovery replay' tests/jev-realgame-final.test.mjs
→ tests 1, pass 1, fail 0 (3402ms) — "recovery replay rejects gold, build, candidate selection and oracle payload drift"
```
The three new negative mutations (sourceHashes drift, `elapsedMs=20000`, `failureCauses=['wrong gold']`) are inside this case and pass with the original `assert.deepEqual(...,{cases:1,verified:1,calls:2,valid:true})` baseline intact.

## 5. G5

Clarification acknowledged (category veto was a synthetic contract test; real corpora score verified layout class/offset/size/type identity; recovered category is machine-use, often `widthOnly`). No corpus change made; `fresh-holdout.json` remains `31a02476…`.

## 6. Scoped decompile path — plausible wait/CPU seams (source-only, no outcome claims)

Recorded from source at HEAD `13d80f83c`. These are static seams, not a diagnosis of the running OpenMW jobs.

### Wait seams (no adapter-side timeout; cancellation is cooperative only)

- **W1 — `await entry.buildPromise` (`app-adapter.js:46`)**: `buildPromise = provider.build().catch(()=>null)` (`:125`) — `.catch` converts rejections but there is no signal race and no timeout; `provider.build()` (`project.js:310-330`) takes no signal. The read closure (`app-adapter.js:96-102`) awaits `backend.readAt(addr,len)` and only catches *rejections* — a never-settling `readAt` hangs the first recovery call and every later one (the pending promise is cached in `SLICE_CXX_PROVIDERS`). Same await also on the ordinary decompile path (`:1210`) and translation-unit path (`:1259`), so even non-recovery decompiles can block on it.
- **W2 — `await query.snapshot({signal})` (`app-adapter.js:43`)** → `api.js:311-315` → `currentIdentity` → `await app.backend.ensureBinaryId({signal})` (`app-adapter.js:819-822`) or `await app.ensureAnalysisIdentity()` (`:823-824`): the try/catch only handles rejection, not a promise that never settles; `ensureAnalysisIdentity()` receives no signal at all.
- **W3 — `await query.decompile(...)` (`app-adapter.js:63`)** → `api.js:333-365 #wrapResult`: awaits `executeFn` with `aborted(options)` checks only before/after (`api.js:312,314,320,322,336,338`); no timeout race around the producer. The decompile DTO adapter has no `throwIfAborted` (only `translationUnit` does, `app-adapter.js:1237`).
- **W4 — budget checked only pre-await (`query-recovery.js:76`)**: `now()-started>=maxElapsedMs` is evaluated *before* each `decompile` await (`:79`); the post-loop check (`:85`) can only label `budget-exhausted` after the last decompile returns, so one slow function extends wall time past `maxElapsedMs`, and `decompilerTimeBudgetMs:1500` passed at `:79` is documented as a **best-effort cooperative** budget (`api.js:441`), not a hard wall-clock cap.
- **W5 — no session deadline and no signal in the collector (`collect-jev-realgame-recovery.mjs:38-41`)**: the per-case loop calls `recoverCxxMembersForQuery(...{enabled:true,maxFunctions,maxElapsedMs})` with **no `signal` argument**, so `checkBinding`'s abort check (`app-adapter.js:53`) is a no-op for the whole run; budgets are per query, with no whole-session deadline across the serial case loop.
- **W6 — app-side awaits below the adapter (`app-adapter.js:1187-1191` `app.getDecompile(id,options)`; `:785-797` `loadFunction` → `app.analyzeFunction` / `directFetch` / `produceFunction`)**: the adapter applies no timeout of its own; it relies on the producer honoring `options.signal`, which the collector never sets (W5).

### CPU seams (bounded loops, heavy constants)

- **C1 — RTTI/vtable evidence build**: `buildCxxClassEvidence` (`rtti-evidence.js:371`) with `maxClasses:2500, maxSlots:128, maxReads:8192` (`app-adapter.js:116-124`) — bounded read count but sequential async reads over the whole binary on first use per slice; cached per slice (WeakMap, `rtti-evidence.js:612-629`, `maxEntries=4`).
- **C2 — planner construction/scoring**: `createCxxQueryPlanner` scans every `symbols.names[i]` once per provider+`symbolsGen` (cached at `app-adapter.js:51-58`); `plan()` scores/filter-sorts **all** rows per query (`query-recovery.js:49-58`) — O(functions) per case.
- **C3 — recovery loop bounded**: ≤ `maxFunctions` (8) decompiles per query, budget validation `maxElapsedMs<=120000` (`query-recovery.js:67-72`).
- **C4 — per-case `pinpointField({limit:400})` (`collect-jev-realgame-recovery.mjs:43`)**: bounded output; the scan itself is linear in field count × cases.
- **C5 — per-planned-function full analysis**: `loadFunction` → `app.analyzeFunction`/`produceFunction` (`app-adapter.js:785-797`) is the heavy CPU candidate per function; decode is budgeted (`'semantic-function-decode-budget'`, `:776`) but decompiler pass time is only cooperatively budgeted (see W4).

Source-only record: no inference about the OpenMW jobs' eventual results is made here.
