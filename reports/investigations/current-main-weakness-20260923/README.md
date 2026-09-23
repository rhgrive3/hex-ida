# Main snapshot weakness measurement at 09dfcb283 (2026-09-23)

Scope: **investigation and measurement only.** No production analysis, decompiler, emitter or
policy change. Every artifact here is produced by the measurement lane described below and is
hash-bound in [`manifest.json`](./manifest.json).

Provenance: the artifacts were **measured on snapshot base** `09dfcb283f721b6598f34675a8a42480147d5752`
(see the next section); this report is **committed** on `2b8e98d61`, which is `origin/main` at commit time.
During that interval, 22 commits advanced `main` (including C++ member projection and evidence changes);
therefore, this report documents the **09dfcb283 snapshot** and does not claim to represent the unmeasured
current HEAD without explicit focused evidence. Per-function receipts
(`measurements/run-20260923-stratified/receipts/`, ~9 MB, 2300+ files) are regenerable from the
committed case records and are intentionally not committed.

## Direct answers

| # | Question | Answer |
| ---: | --- | --- |
| 1 | What is the measured product base? | `09dfcb283f721b6598f34675a8a42480147d5752` (`fix(build): bind classic source reads to validated inode (#9467)`), pinned in a clean detached worktree `/mnt/workspace/hex-ida-main-measure`; `sourceIdentity=d28028877bb24054114cb6f9b149c95f74ec9b694d0ab33efc3ebdeaf1ede6e8`, `configHash=9ae87e001607206aa0d08cb7124674dafe32dea83a9ee07570640a7e96d60b90`. `origin/main` has since moved to `2b8e98d61` (**22 commits** of drift), so this is a snapshot, not "latest main" forever. |
| 2 | Does the measured snapshot fail to decompile functions? | **No, not on this corpus.** 2258/2258 functions `PASS`, all `completeness=complete`, `reasons={}` , 0 `UNSUPPORTED`, 0 withheld projections, 32/32 cases `MEASURED`. The old hard-failure taxonomy is empty on this snapshot; the observed weaknesses are **quality, coverage and latency**. |
| 3 | What limits quality on the snapshot? | **Control-flow fallback**: 286/2258 functions (12.7%) still emit `goto` (2497 instances; 8 libgcc soft-float functions `__addtf3`/`__multf3` hold **75.6%** of the instances, max **312** in one function). **Unsupported semantics**: 95 functions have unknown instructions out of 1960 observed numeric values (4.85% of observed; 298 unobserved/null; not 4.2% of total). Only 12 of the 95 also emit gotos. |
| 4 | Does the output recompile? | **No.** Raw concatenation fails **32/32 cases** and **192/192** individually sampled function bodies. While `undeclared-local` is the first diagnostic in 32/32 cases and survives TU packaging, single-function samples show multiple failure families (`undeclared-identifier`: 86, `undeclared-local`: 52, `unknown-type-name`: 31, `undeclared-global`: 23). Declaring locals alone does not achieve full recompilation. |
| 5 | What is the latency profile? | `p50 1.40 s`, `p90 7.97 s`, `p95 12.22 s`, `p99 30.70 s`, `max **149.6 s**`, mean 3.49 s over 2258 functions (7 890 s of function time). The top 9.9% of functions hold 50% of all analysis time. |
| 6 | Is latency size-driven? | Only on average (`rho(elapsed,size)=0.904`). The **tail is not**: `test_composite_types` (772 B) 149.6 s, `test_array_types` (620 B) 82.5 s, `array_3d` (312 B, **0 gotos**) 73.4 s — composite/array type handling, not CFG size. |
| 7 | Where does the tail time actually go? | Only **7–12%** is inside the pass manager's recorded execution time. Inside that recorded window, `capturePassState` dominates (12 893–123 843 objects). The remaining ~90% sits outside the recorded pass manager window (AST transformation, Phase 8 projection, and unprofiled overhead). Repeated certified-data calls in `array_3d` account for only ~48 ms and do not explain the 31+ s wall time. |
| 8 | Biggest single actionable gap | Emitted stack locals (`local_*`, `local_p*`, `var_*`) lack declarations: fixing them resolves the first divergence across 32/32 cases and unlocks 43/192 single-function bodies to pass syntax checks, exposing subsequent missing type/macro definitions (`uint64`, globals). |

## Measured base and sample

| Item | Value |
| --- | --- |
| Corpus | `benchmarks/public/codefuse-arm64/manifest.json` (160 cases, 8 case groups × 20 configs, all `arm64`) |
| Sample | **32 cases** = 8 groups (`1, 2, 3, 4, 5-1, 5-23, 6, 7`) × 4 compiler configs (`clang_O0_g`, `clang_O2_no_g`, `gcc_O1_g`, `gcc_Os_no_g`) |
| Functions | 2258 (per-case 41 … 216) |
| Run config | `--workers 8 --function-timeout-ms 10000 --structure slow --structure-threshold-ms 250` |
| Run result | 32/32 `MEASURED`, wall 1 108 869 ms, 0 `ERROR`/`NOT_RUN` |

The corpus is a **decompilation benchmark** (Hex-Rays reference), not the real-binary/game
holdout set — see *What was not measured*.

## Part A — current-main failure taxonomy (measured)

Measured on the 32-case sample above. "First failure" means the first divergence recorded for
that function, so counts below are **first-divergence counts** and are deduplicated across
symptoms.

| Category | Count | Share | Evidence | Root cause | First divergence |
| --- | ---: | ---: | --- | --- | --- |
| decompile failure (no/`non-complete` result) | 0 | 0.0% | `analysis.json functionStates` | — | n/a |
| `UNSUPPORTED` case / unsupported architecture | 0 | 0.0% | `summary.json states` | — | n/a |
| projection withheld / schema drift | 0 | 0.0% | `coverage.projectionWithheld` | — | n/a |
| function discovery / extent | 0 | 0.0% | `functionDiscoveryComplete=true` for 32/32 | — | n/a |
| signature / type-recovery missing | 0 | 0.0% | `signature=true` 2258/2258 | not a limiter on this corpus | n/a |
| **control-flow fallback (`goto` emitted)** | 286 | 12.7% | `analysis.json goto`; ≥4 gotos 49 (2.2%), ≥11 gotos 17 (0.75%), max **312**, sum 2497 | 8 functions (`__addtf3` 2964 B/312 gotos, `__multf3` 2048 B/160 gotos, ×4 configs) hold 1888/2497 = **75.6%** of all goto instances; the remaining ≥11-goto functions are deliberate stress cases (`vla_stack`, `alloca_usage`, `varargs_func`, `param_fork_exec`, `param_vectorized_loop`, …) | structuring / loop recovery |
| **unsupported / unknown instructions** | 95 | 4.85% (obs) | `coverage.unknownInstructions` (sum 292; 95 functions with >0 unknown instructions out of 1960 observed numeric values = 4.85%; 298 unobserved/null; not 4.2% of total) | a **distinct** cause from the row above — only 12 of the 95 also emit `goto`; 112/292 instances are in the soft-float helpers, the rest spread over 87 functions | instruction semantics |
| unstructured `coverage.mode` | 336 | 14.9% | `coverage.structured=1922` | partially downstream: 226 of the 336 also emit `goto`, **110 do not** | n/a |
| **direct recompilation failure** | 32 cases / 192 fn | 100% of cases | `recompilability/replay-summary.json` | emitted text is not valid C | Case level first divergence is `undeclared-local` 32/32; individual function first-failure families are diverse: `undeclared-identifier` 86, `undeclared-local` 52, `unknown-type-name` 31, `undeclared-global` 23 |
| **TU packaging failure** | 6 cases / 391 fn | 100% of probed cases | `tu-replay/tu-replay-summary.json` | packager declares prototypes/globals but bodies still reference undeclared locals and unknown types; `completeness=partial` with 453 unresolved prototypes, 108 unresolved globals, 14 pseudo-intrinsics, 6 call sentinels | same `undeclared-local` |
| warnings without a structured reason | 1643 | 72.8% | `coverage.warnings` sum 5135, mean 2.27/function | warning taxonomy is not machine-classifiable — instrument first | n/a |
| **extreme latency / pathological cost** | 224 | 9.9% | `latency.byCase`, see Part B | non-size-driven composite/type blowup + repeated capture | `test_composite_types` |

Ceilings if each root cause is fixed independently: structuring the 8 soft-float functions would
remove 75.6% of all goto instances (and the largest single-function goto count, 312); resolving
unsupported instruction semantics would clear the 95-function unknown-instruction category (of
which only 12 are entangled with gotos); declaring emitted locals resolves the first divergence across
32/32 case-level translation units and converts 43/192 (22.4%) sampled single functions to pass syntax checks,
though 149/192 then immediately hit subsequent failures (undeclared identifiers such as `uint64`, globals, and unknown types).

## Part B — latency distribution and root cause

### Distribution (2258 functions, 8-worker run)

| metric | ms |
| --- | ---: |
| min | 8.6 |
| p50 | 1 402 |
| p90 | 7 972 |
| p95 | 12 222 |
| p99 | 30 704 |
| max | 149 641 |
| mean | 3 494 |
| sum | 7 890 475 (2.19 h) |

Concentration: **top 9.9% of functions hold 50%** of total analysis time; the top 1% hold 16.7%.

By function size (`sizeBytes`):

| bucket | count | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0–32 | 1126 | 446 | 2 088 | 3 100 | 4 381 |
| 33–64 | 490 | 1 827 | 5 065 | 8 275 | 9 176 |
| 65–128 | 347 | 5 227 | 12 400 | 16 705 | 20 413 |
| 129–256 | 183 | 6 953 | 21 934 | 31 121 | 33 098 |
| 257–512 | 84 | 8 800 | 31 337 | 73 399 | 73 399 |
| 513–1024 | 20 | 18 117 | 82 545 | **149 641** | **149 641** |
| 1025+ | 8 | 61 609 | 89 007 | 89 007 | 89 007 |

By `goto` count: 0 gotos → p50 1 212 / p99 18 022; 4–10 → p50 10 861; 11+ → mean 38 890.
Correlation `rho(elapsed,size)=0.904`, `rho(elapsed,gotos)=0.295`.

Slowest single functions (contended run):

| ms | case | function | size | gotos | unknown insns |
| ---: | --- | --- | ---: | ---: | ---: |
| 149 641 | `2/2_gcc_O1_g` | `test_composite_types` | 772 | 2 | 0 |
| 89 007 | `2/2_gcc_Os_no_g` | `__addtf3` | 2964 | 312 | 16 |
| 82 545 | `2/2_gcc_Os_no_g` | `test_array_types` | 620 | 2 | 0 |
| 73 399 | `2/2_clang_O2_no_g` | `array_3d` | 312 | 0 | 0 |
| 70 894 | `1/1_gcc_O1_g` | `test_control_flow_l2` | 652 | 2 | 0 |

### Root cause (`profile-slowest.json`, isolated re-run of the top 4)

Pass-level probe on production `globalThis.__hexPerfProbe` hooks only; production state is never
mutated and the probe global is cleared after each call.

| function | measured (8 workers) | isolated | pass total | of which rollback state capture | captured objects | duplicate verification calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `test_composite_types` (772 B) | 149 641 ms | 65 366 ms | 7 951 ms | 7 855 ms | 34 545 | 0 |
| `__addtf3` (2 964 B, 312 gotos) | 89 007 ms | 38 261 ms | 4 118 ms | 2 697 ms | 123 843 | 0 |
| `test_array_types` (620 B) | 82 545 ms | 35 196 ms | 4 011 ms | 3 923 ms | 29 941 | 0 |
| `array_3d` (312 B, 0 gotos) | 73 399 ms | 31 375 ms | 2 196 ms | 2 178 ms | 12 893 | **11** |

Findings:

- **B1 — the pass manager explains only 7–12% of the isolated wall time.** `decompilePassTotalMs` is
  2.2–8.0 s of a 31–65 s isolated call. The remaining ~88–93% of wall time sits outside the recorded
  pass manager window. Coarse harness instrumentation attributes this non-pass time primarily to the
  outer pipeline coordination (AST transformation, Phase 8 projection/structuring, and unprofiled overhead).
- **B2 — inside the recorded pass run, rollback state capture dominates.** 2 178–7 855 ms of
  the 2 196–7 951 ms pass total is `capturePassState` (deep descriptor snapshot), scaling with the
  captured object count (12 893 → 123 843 objects). The 2964-byte `__addtf3` captures ~10× the
  objects of the 312-byte `array_3d`.
- **B3 — repeated proof work is real but bounded in measured impact.** `array_3d` shows `duplicateCalls=11` with
  repeated `captureCertifiedDataGraph` (×7 from `retainAbiBinding`, ×5 from `sealFacadeAbiBindings`),
  accounting for ~48 ms of verification time. It confirms duplicate calls exist, but does not explain the 31+ s wall time.
- **B4 — extreme latency does not track instruction size or CFG complexity.** Small 312–772 B functions
  with 0–2 gotos take 31–65 s in isolation, whereas the 2964 B soft-float function with 312 gotos takes 38 s.
  While composite and array handling appear prominently in slow cases, the causal link between type handling
  and total wall time is an active hypothesis rather than a proved single bottleneck.

### What is confirmed vs what remains unproven in latency:

**Confirmed by measurement:**
1. Extreme tail latency is not explained by binary size or CFG complexity alone.
2. Pass manager accounting explains only ~7–12% of wall time in the slowest functions.
3. Within the recorded pass manager window, `capturePassState` dominates.
4. `array_3d` executes 11 duplicate certified-data calls (costing ~48 ms).

**Not yet proved:**
1. The exact millisecond-by-millisecond breakdown of the remaining ~90% wall time.
2. Whether composite/array type processing is the primary cause of total wall time or just correlated.
3. The end-to-end wall-time gain from eliminating duplicate certified-data calls (since observed cost was only ~48 ms).

### Honest limits of Part B

- Absolute latencies are **contended**: the corpus run used 8 workers while other agents were active
  on the 16-core box (`load average ≈ 3.9`), and the isolated re-run of the same functions is
  2.3–2.4× faster. Use the *relative* distribution and the isolated tail numbers; not the absolute
  p95/p99 as a single-process latency budget.
- The per-function watchdog is **not effective**: `--function-timeout-ms 10000` yet the measured max
  is 149 641 ms with `state=PASS` — **147 of 2258 functions (6.5%) exceed the 10 s watchdog but none
  is reported as `TIMEOUT`**. The downstream analysis does not honour the abort signal within a
  function, so every recorded latency above 10 s is worker-observed wall time, not a budgeted value.
- **CFG/IR structural indicators could not be read at all**: `product.query.cfg` /
  `product.query.semanticIR` returned `cfg-unavailable` for every probed function, so
  `cfgBlocks`/`irValues`/`irInstructions` are `null` and the Part B structural correlations are
  empty. Instrumenting that query path is a prerequisite for any future
  path-length/candidate-growth analysis.
- `profile-slowest` records only the **first** pass batch (`probe.passes[0]`), so per-phase
  attribution below the first batch is not available; only functions ≥250 ms were structure-probed.

## Part C — next production work candidates

Ranked by measured evidence, not by taste. None of these was implemented here.

| # | Candidate | Affected (measured) | Expected gain | Correctness risk | Perf risk | Complexity |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Declare emitted stack locals** (`local_*`, `local_p*`, `var_*`) in the pretty-printer / TU packager | 32/32 cases, 192/192 sampled functions; first diagnostic in 32/32 cases | Resolves first divergence across all 32 cases; enables 43/192 (22.4%) single functions to pass syntax check. Exposes subsequent missing type/macro definitions (`uint64`, globals) | Low — additive declarations derived from existing frame evidence; no semantic change to analysis | Low | Low–Medium |
| 2 | **Profile and reduce unrecorded pipeline wall time** (Phase 8 projection, AST rendering, composite/array type processing) | 8/8 groups; top 1% of functions = 16.7% of total time | Potential reduction in extreme tail latency (300–800 B functions costing 31–150 s); requires attributing the ~90% unrecorded wall time before claiming magnitude of gain | Low–Medium | Low | Medium |
| 3 | **Structure libgcc soft-float helpers** (`__addtf3`, `__multf3`: 312/160 gotos each) | 8 functions = 75.6% of all goto instances; max single-function goto count (312) | Removes three quarters of the goto instances from the taxonomy in one fix | Medium | Low | High |
| 4 | **Make rollback pass-state capture incremental** (12 893–123 843 objects deep-snapshotted per pass run) | Every ≥250 ms function; 2.2–7.9 s per slow function | Addresses the dominant cost inside the recorded pass manager window (up to ~10% of total function wall time) | Medium — rollback correctness is load-bearing; needs a fail-closed equivalence test | Low | Medium–High |

Recommended order: **1 → 2 → 3 → 4**. #1 is the only candidate that changes *correctness of the
emitted artifact* rather than speed, and it is independently the cheapest and verified via diagnostic probe.

## What was not measured

- No real-binary / game holdout set, and no full 160-case run — this is the 32-case stratified
  codefuse-arm64 sample only.
- The TU packager probe covers 6 cases (`gcc_Os_no_g` of groups 1, 3, 4, 5-23, 6, 7); the raw
  recompilation replay covers all 32. A separate 2-case probe (`7/7_clang_O2_no_g`,
  `7/7_gcc_Os_no_g`, kept as `tu-replay-summary.2cases.json`) agrees.
- No frozen-denominator comparison (`aggregate.mjs --frozen` was not supplied).
- No C++ object/evidence, Pinpoint, or Jev lane is in scope; those are separate investigations
  (`reports/investigations/jev-full-opportunity-audit`, `jev-rescue-regression-gap`,
  `pinpoint-jev-probe-audit-20260923`).

## Artifacts

| Path | What it is |
| --- | --- |
| `harness/lib.mjs` | shared helpers (percentiles, atomic JSON, provenance/identity) |
| `harness/measure-functions.mjs` | corpus runner (per-case worker fan-out, resume receipts) |
| `harness/case-worker.mjs` | one-case worker: decompile every discovered function + optional structure probe |
| `harness/aggregate.mjs` | receipts → `analysis.json` (taxonomy, latency, goto, structure) |
| `harness/recompile-replay.mjs` | raw TU reconstruction + clang syntax/object replay |
| `harness/tu-replay.mjs` | opt-in product packager (`query.translationUnit`) + same clang replay |
| `harness/profile-slowest.mjs` | pass-level profiler for the slowest functions |
| `harness/build-manifest.mjs` | hash-binds every artifact into `manifest.json` |
| `measurements/run-20260923-stratified/summary.json` | 32/32 case run summary + provenance |
| `measurements/run-20260923-stratified/cases/*.json` | per-case function records (incl. pseudocode) |
| `measurements/run-20260923-stratified/analysis.json` | aggregated taxonomy + latency + goto + structure |
| `measurements/run-20260923-stratified/recompilability/replay-summary.json` | raw recompilation replay (32 cases / 192 functions) |
| `measurements/run-20260923-stratified/tu-replay/tu-replay-summary.json` | product TU packaging replay (6 cases) |
| `measurements/run-20260923-stratified/profile-slowest.json` | pass-level profile of the top 4 slowest functions |
| `manifest.json` | sha256 of every artifact above + provenance |

## Reproduction

The measurement lane must run against the pinned base, never the shared working tree
(this environment switches branches under other agents):

```bash
BASE=09dfcb283f721b6598f34675a8a42480147d5752
git -C /mnt/workspace/hex-ida worktree add --detach /mnt/workspace/hex-ida-main-measure "$BASE"

# 1) corpus run (8 workers, ~19 min on this box)
node harness/measure-functions.mjs \
  --output measurements/run-20260923-stratified --workers 8 \
  --function-timeout-ms 10000 --structure slow \
  --case-id 1/1_clang_O0_g --case-id 1/1_clang_O2_no_g ...   # 32 stratified ids

# 2) taxonomy + latency
node harness/aggregate.mjs --run measurements/run-20260923-stratified

# 3) raw direct-recompilability replay (32 cases, ~13 s)
node harness/recompile-replay.mjs --run measurements/run-20260923-stratified

# 4) opt-in product TU packaging replay (bounded probe, ~50 s/case)
node harness/tu-replay.mjs --run measurements/run-20260923-stratified \
  --case-id 1/1_gcc_Os_no_g --case-id 3/3_gcc_Os_no_g ...

# 5) pass-level root cause for the tail (~45 s/slow function)
node harness/profile-slowest.mjs --run measurements/run-20260923-stratified --top 4
```

Steps 4 and 5 import the production host, so run them from the pinned worktree
(`/mnt/workspace/hex-ida-main-measure`); steps 2 and 3 only read receipts and can run anywhere.
