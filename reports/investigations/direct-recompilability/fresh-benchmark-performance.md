# Fresh decompile benchmark runner

This lane measures fresh Hex analysis without changing decompiler semantics. It is intentionally separate from the compiler/taxonomy stages in `reports/investigations/direct-recompilability/harness/`.

## Why a second runner exists

The original `tools/validation/public-benchmark/run.mjs` executes cases serially and only persists a case artifact after the subject process exits. A slow function can therefore consume the case timeout and discard every function completed earlier in the same binary.

The fresh runner keeps the product analysis path unchanged but changes execution ownership:

```text
case worker process
  -> open binary once
  -> product ELF/load/discovery/program setup once
  -> decompile functions sequentially in the same Binary/App/query session
  -> atomically persist one receipt after each function
  -> if one function stops making progress, parent kills that subject only
  -> write explicit TIMEOUT receipt for the in-flight function
  -> reopen the case and resume from the remaining functions
```

Across cases, `run-fresh.mjs` uses a bounded worker pool. Worker count is CLI-configurable; no corpus-specific value is hard-coded.

## Commands

Profile a binary without changing output artifacts:

```bash
node tools/validation/public-benchmark/profile-fresh.mjs \
  benchmarks/public/codefuse-arm64/inputs/<sha>.bin \
  --functions 20 --function-timeout-ms 30000
```

Run a cold smoke measurement:

```bash
rm -rf /tmp/hex-fresh-smoke
node tools/validation/public-benchmark/run-fresh.mjs \
  --manifest benchmarks/public/codefuse-arm64/manifest.json \
  --output /tmp/hex-fresh-smoke/out \
  --receipt-dir /tmp/hex-fresh-smoke/receipts \
  --limit 5 --workers 4 \
  --function-timeout-ms 10000
```

Resume the same run by repeating the command. Completed receipts are reused only when binary SHA-256, source identity, benchmark config, architecture and endianness all match.

Retry only timed-out functions:

```bash
node tools/validation/public-benchmark/run-fresh.mjs \
  --manifest benchmarks/public/codefuse-arm64/manifest.json \
  --output /tmp/hex-fresh-smoke/out \
  --receipt-dir /tmp/hex-fresh-smoke/receipts \
  --limit 5 --workers 4 \
  --function-timeout-ms 10000 \
  --retry-state TIMEOUT
```

Worker scaling is measured by repeating the same cold subset with `--workers 1`, `4`, `8`, `12`, and `16`. Use a fresh receipt directory for every cold measurement.

## Profiling fields

`product-host.mjs` records read-only setup timings for:

- binary read
- binary SHA-256 identity
- product binary open / parse / load
- binary identity binding
- symbol analysis
- function discovery
- program construction
- total binary setup

Function execution records wall time per function. `fresh-summary.json` adds case wall time, throughput, restart count, executed function count and reused function count.

## Durability and identity

Function receipts use one atomic file per function address. The receipt identity contains:

- case ID
- binary SHA-256
- source/worktree identity
- benchmark configuration digest
- architecture
- endianness
- receipt schema

The stored function result has its own digest. Invalid JSON, stale identity, address mismatch, non-terminal state, or result-digest mismatch is treated as a cache miss and is recomputed.

`TIMEOUT` is explicit and terminal by default. `--retry-state TIMEOUT` makes only existing timeout receipts retryable. A timeout is never converted to PASS or silently omitted from the denominator.

## Stage separation

The fresh runner writes the same per-case subject JSON shape used by the public benchmark. Compiler and taxonomy stages can consume saved pseudocode without repeating fresh Hex analysis. Receipts live separately under `--receipt-dir` and are execution state, not benchmark truth.

## Local recovery evidence

During recovery of this work, `1/1_clang_O0_g` was intentionally interrupted by outer process limits multiple times. Completed function receipts survived each interruption and the next invocation resumed from the unfinished tail instead of restarting the binary's completed functions. A hard per-function watchdog also converted a pathological function into an explicit `TIMEOUT` receipt and continued the case on the next subject process.

This is durability evidence, not a completed 160-case performance claim. Full cold worker-scaling numbers should be produced from clean receipt directories before reporting an end-to-end speedup for all 160 cases.
