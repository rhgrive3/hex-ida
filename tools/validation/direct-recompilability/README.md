# G direct recompilability — resumable measurement harness

Measurement-only lane. This directory must not change production
emitter/analysis code (`js/decompile-base.js`,
`js/decompiler/semantic-core.js`, `js/decompiler/pipeline-core.js`, …).
Production defects stay with the G repair lane (PR #9229).

## Why

A full G sweep covers 160 manifest cases and each case can take minutes
(subject decompile + clang stages). A timeout or interruption must not lose
completed work: completed cases stay durable, and only unfinished cases run
again on resume.

## Layout

- `resumable-measurement.mjs` — runner-agnostic core (durable per-case
  records, resume, retry manifests, summaries, identity enforcement).
- `measure-g.mjs` — G wiring: codefuse manifest → existing
  `tools/validation/public-benchmark` subject runner → clang
  syntax + object-compilation stages → harness core.
- `README.md` — this contract.

## Contract

- Case states are explicit: `PASS | FAIL | TIMEOUT | CRASH | NOT_RUN`.
- Every manifest case gets one durable record
  (`<store>/cases/<hex(id)>.json`), written atomically (tmp + rename).
- Resume re-executes only `NOT_RUN` and `TIMEOUT` records by default
  (override with `retryStates`). `PASS`, `FAIL`, `CRASH` are terminal.
- Missing/corrupt records surface as `NOT_RUN` plus a `warnings` entry;
  nothing is silently dropped.
- The summary denominator is always the full manifest case count.
- `summary.complete` is true only when every case holds a terminal state
  and no warnings exist. Incomplete runs print `INCOMPLETE` and exit
  non-zero; they must never be presented as complete.
- Retry manifests list only retry-eligible cases, deduplicated by id.
  Records are keyed by case id, so executing a retry twice cannot
  double-count (attempt history is appended, counts come from the final map).
- The source HEAD SHA and manifest hash are recorded in `run.json` and
  enforced: resuming with a different HEAD or manifest throws
  `measurement-identity-mismatch` instead of mixing results.
- Function-level progress (`{ total, states, extra }`) reported by the
  runner is preserved in the per-case record.
- A runner that throws is recorded as `CRASH`; an invalid runner verdict is
  recorded as `FAIL` (`invalid-runner-verdict`). The only accepted `NOT_RUN`
  from a runner is an explicit input problem (`reason: input-…`), e.g. a
  missing or hash-mismatched binary — it stays retryable instead of blaming
  the product.
- The compiler stage is intentionally **object compilation**, not executable
  linking: function-level recovered translation units do not require `main`,
  and unresolved external symbols are outside this compile-only contract.
  `PASS` means syntax validation plus successful `clang -O0 -c` object
  emission; it must not be described as a link or runtime result.

## Schemas (all `/v1`)

`run.json` (`hex-recompilability-resumable-run/v1`):
`{ schema, manifestSha256, headSha, denominator, createdAt, updatedAt }`.

Per-case (`hex-recompilability-resumable-case/v1`):
`{ schema, caseId, state, reason, functions, headSha, manifestSha256,
attempts: [{ startedAt, finishedAt, elapsedMs }]`.

`summary.json` (`hex-recompilability-resumable-summary/v1`):
`{ schema, denominator, complete, counts: { PASS, FAIL, TIMEOUT, CRASH,
NOT_RUN }, warnings, headSha, manifestSha256, finishedAt,
results: [{ id, state, reason }] }`.

`retry.json` (`hex-recompilability-resumable-retry/v1`):
`{ schema, fromManifestSha256, headSha, retryStates, denominator,
cases: [{ id, lastState, reason }] }`.

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
  --store-dir reports/investigations/direct-recompilability-production-20260919/measurements/fresh-160 \
  --subject-timeout-ms 120000 --clang-timeout-ms 30000 --retry-manifest
```

Tuning: `--subject-timeout-ms` (1000–900000),
`--clang-timeout-ms` (1000–600000), `--clang <path>`.

## Notes for the #9229 lane

- Suggested cherry-picks from this branch: the three new files under
  `tools/validation/direct-recompilability/` (core, CLI, README) plus
  `tests/public-benchmark/resumable-measurement.test.mjs`. Nothing else in
  this branch touches production paths.
- Fresh measurement artifacts (if produced) belong under
  `reports/investigations/direct-recompilability-production-20260919/measurements/`
  and carry their own HEAD/manifest pins; do not merge them into the frozen
  baseline reports.
