# Public Competitor & Gate E Benchmark Lanes

Last updated: 2026-11-28

Hex separates **public artifact / live-engine benchmarking** (`tools/validation/public-benchmark/`) from SCPA native-competitor acceptance. Public artifact lanes compare the current Hex ARM64 product path against frozen, published competitor artifacts without installing proprietary competitors locally, never set `nativeCompetitorsRun`, and consume zero native SCPA cells.

## npm Scripts (`package.json`)

| Script | Command | Purpose |
| --- | --- | --- |
| `benchmark:public:prepare` | `node tools/validation/public-benchmark/prepare.mjs` | Freeze a public suite manifest and SHA-256 hashes from a pinned benchmark checkout |
| `benchmark:public` | `node tools/validation/public-benchmark/run.mjs` | Run Hex against a frozen public manifest via child Node processes |
| `benchmark:public:test` | `node --test tests/public-benchmark/*.test.mjs` | Run runner hardening, fresh-runner, and public-benchmark unit/regression tests |
| `codefuse:functionality:probe` | `node reports/investigations/codefuse-functionality/harness/probe.mjs` | Probe CodeFuse functionality harness |
| `codefuse:functionality:test` | `node --test tests/codefuse-functionality/*.test.mjs` | Verify CodeFuse functionality harness contracts |

## Public Artifact Lanes (`tools/validation/public-benchmark/`)

### 1. CodeFuse-DeBench / Published IDA Pro 9.1 ARM64 Artifacts

Prepare once from a pinned CodeFuse-DeBench checkout (refuses to overwrite an existing suite directory and verifies `Decompiled by IDA Pro 9.1 with Hex-Rays` headers):

```bash
npm run benchmark:public:prepare -- --source /path/to/CodeFuse-DeBench --out benchmarks/public/codefuse-arm64/manifest.json
```

Run and summarize:

```bash
npm run benchmark:public -- --manifest benchmarks/public/codefuse-arm64/manifest.json --output reports/public-benchmark --timeout-ms 120000
node tools/validation/public-benchmark/report.mjs reports/public-benchmark/summary.json
```

### 2. Fresh Resumable Runner & Per-Function Hard Watchdog (`run-fresh.mjs`)

For multi-case ARM64 / HumanEval-Decompile and CodeFuse evaluation with durable per-function receipts and process-boundary `SIGKILL` supervision:

- `tools/validation/public-benchmark/run-fresh.mjs` — pool-based resumable runner across manifest cases.
- `tools/validation/public-benchmark/run-fresh-case.mjs` + `fresh-subject.mjs` — supervises each child worker with `inflight.json` progress tracking and `SIGKILL` hard watchdog (`--function-timeout-ms` + `--watchdog-grace-ms`), resuming from durable receipts on timeout. See [`FUNCTION_TIMEOUT_SEMANTICS.md`](FUNCTION_TIMEOUT_SEMANTICS.md).
- `tools/validation/public-benchmark/profile-fresh.mjs` — single-process cooperative profiler for diagnosing slow functions.

### 3. Gate E 10-Axis Scorecard (`gate-e-scorecard.mjs` / `run-gate-e-live.mjs`)

- `tools/validation/public-benchmark/gate-e-scorecard.mjs` — fail-closed 10-axis scorecard harness. Without `--input <metrics.json>`, it probes only local artifacts (`wasm/hex_engine.wasm` raw/gzip size and import count, UI files & XSS sink audit, `PRIMARY_NAV`, and `export-interop` ↔ `delta-session` round-trip) and reports unmeasured external axes as `UNMEASURED` (exit code `1`). With `--input <metrics.json>`, it evaluates all 10 axes with strict numeric thresholds and hard disqualifiers (`BEYOND_IDA_TOTAL_PASS` only when all 10 axes are measured and pass with zero disqualifiers).
- `tools/validation/public-benchmark/run-gate-e-live.mjs` — executes live runtime probes against `wasm/hex_engine.wasm`, v6 C++/JS modules (`DirtyConeIndex`, `TypeTransactionManager`, `parseLocalTypesHeader`, `compileSdkBatch`, `matchSdkPacks`, `recoverStructLayout`, `HexSigIndex`, `portDeltaAnnotations`, `runCrossFuncSlice`, `createStlPatternRecognizer`, `unflattenCffIr`, `simplifyMbaDag`, `MiniArm64Emu`, `HexDbMemoryBackend`, `delta-session`), and evaluates the recorded metrics through `gate-e-scorecard.mjs`.

## Execution Isolation & Claim Boundaries

- Benchmark binaries are passed strictly as read-only inputs and are never executed as OS processes.
- `product-host.mjs` runs through the production `Backend`, product `App` discovery/range methods, artifact route, public `AnalysisQueryAPI`, and shipped workers over a Node transport with worker network fetch disabled.
- **Allowed claims:** `Hex <candidate> vs CodeFuse-DeBench published IDA Pro 9.1 ARM64 artifacts` (or measured Gate E live metrics) strictly for metrics actually measured under the pinned manifest and commit.
- **Disallowed claims:** Native IDA timing, same-machine performance, same-Astra efficiency, or SCPA native-competitor acceptance from public-artifact runs alone.
