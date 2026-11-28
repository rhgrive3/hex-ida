# Direct recompilability — resumable measurement harness

Measurement-only harness for running resumable direct-recompilability sweeps across the 160-case `codefuse-arm64` manifest without modifying production emitter or analysis code.

## Why

A full sweep covers 160 manifest cases, and each case runs subject decompilation plus Clang validation stages. Durable per-case records ensure timeouts or interruptions never lose completed work: only unfinished cases execute on resume.

## Layout

- `resumable-measurement.mjs` — runner-agnostic core (atomic durable per-case records, resume filtering, retry manifests, summary aggregation, and HEAD/manifest identity enforcement).
- `measure-g.mjs` — manifest wiring: `benchmarks/public/codefuse-arm64/manifest.json` → `tools/validation/public-benchmark` subject runner → `clang -std=gnu11 -fsyntax-only` and `clang -std=gnu11 -O0 -c` object-compilation stages → harness core.
- `README.md` — this contract.

Unit tests live in `tests/public-benchmark/resumable-measurement.test.mjs` (run via `npm run benchmark:public:test`).

## Contract

- Case states are explicit: `PASS | FAIL | TIMEOUT | CRASH | NOT_RUN`.
- Every manifest case gets one durable record (`<store>/cases/<hex(id)>.json`), written atomically (tmp + rename).
- Resume re-executes only `NOT_RUN` and `TIMEOUT` records by default (override via `retryStates`). `PASS`, `FAIL`, and `CRASH` are terminal.
- Missing or corrupt records surface as `NOT_RUN` plus a `warnings` entry; nothing is silently dropped.
- The summary denominator is always the full manifest case count.
- `summary.complete` is `true` only when every case holds a terminal state and `warnings` is empty. Incomplete runs print `INCOMPLETE` and exit non-zero.
- Retry manifests list only retry-eligible cases, deduplicated by case ID. Records are keyed by case ID so re-running a retry cannot double-count (attempt history is appended; counts derive from the final map).
- Source HEAD SHA and manifest SHA-256 are recorded in `run.json` and enforced on resume (`measurement-identity-mismatch` is thrown rather than mixing results across revisions or manifests).
- Function-level progress (`{ total, states, extra }`) reported by the runner is preserved in each per-case record.
- A throwing runner records `CRASH`; an invalid runner verdict records `FAIL` (`invalid-runner-verdict`). Runner-reported `NOT_RUN` is accepted only for explicit input problems (`reason: input-…`, such as a missing or hash-mismatched binary).
- The compiler stage is **object compilation** (`clang -std=gnu11 -O0 -c`), not executable linking: function-level recovered translation units do not require `main`, and unresolved external symbols are outside this compile-only contract. `PASS` denotes syntax validation plus successful object emission, not a link or runtime verdict.

## Schemas (all `/v1`)

- `run.json` (`hex-recompilability-resumable-run/v1`):
  `{ schema, manifestSha256, headSha, denominator, createdAt, updatedAt }`
- Per-case (`hex-recompilability-resumable-case/v1`):
  `{ schema, caseId, state, reason, functions, headSha, manifestSha256, attempts: [{ startedAt, finishedAt, elapsedMs }] }`
- `summary.json` (`hex-recompilability-resumable-summary/v1`):
  `{ schema, denominator, complete, counts: { PASS, FAIL, TIMEOUT, CRASH, NOT_RUN }, warnings, headSha, manifestSha256, finishedAt, results: [{ id, state, reason }] }`
- `retry.json` (`hex-recompilability-resumable-retry/v1`):
  `{ schema, fromManifestSha256, headSha, retryStates, denominator, cases: [{ id, lastState, reason }] }`

## Usage

Subset (first 3 cases):

```sh
node tools/validation/direct-recompilability/measure-g.mjs \
  --store-dir /tmp/hex-g-run-1 --limit 3 --retry-manifest
```

Named cases:

```sh
node tools/validation/direct-recompilability/measure-g.mjs \
  --store-dir /tmp/hex-g-run-1 --only 1/1_clang_O0_g,1/1_clang_O0_no_g
```

Resume (same store dir; completed cases are skipped automatically):

```sh
node tools/validation/direct-recompilability/measure-g.mjs \
  --store-dir /tmp/hex-g-run-1 --retry-manifest
```

Full 160-case sweep:

```sh
node tools/validation/direct-recompilability/measure-g.mjs \
  --store-dir /tmp/hex-g-full-160 \
  --subject-timeout-ms 120000 --clang-timeout-ms 30000 --retry-manifest
```

Options:

- `--manifest <path>` (default `benchmarks/public/codefuse-arm64/manifest.json`)
- `--store-dir <path>` (required)
- `--limit <n>` / `--only <id1,id2,...>`
- `--subject-timeout-ms <ms>` (default `120000`, range `1000–900000`)
- `--clang-timeout-ms <ms>` (default `30000`, range `1000–600000`)
- `--clang <path>` (default `clang`)
- `--retry-manifest` (emit `retry.json`)
