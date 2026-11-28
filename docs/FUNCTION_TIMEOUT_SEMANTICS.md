# Function Timeout Semantics

Last updated: 2026-11-28

Decision record for `--function-timeout-ms` and in-process decompilation cancellation across the benchmark runners (`tools/validation/public-benchmark/`), measurement harnesses, and public `AnalysisQueryAPI.decompile` / UI surfaces.

## Decision

`--function-timeout-ms` is **hard wherever a parent supervises a child worker process, and explicitly best-effort (cooperative) in-process**. There is no third mode: every surface is either supervised (`SIGKILL` at a process boundary) or explicitly documented as best-effort (cooperative).

| Surface | Mode | Enforced by |
| --- | --- | --- |
| `run-fresh.mjs` → `run-fresh-case.mjs` → `fresh-subject.mjs` | **hard** | Parent `SIGKILL` when the `inflight.json` marker is older than `functionTimeoutMs + --watchdog-grace-ms` (default `2000 ms`) |
| Supervised measurement harness (`measure-functions.mjs` → `case-worker.mjs`) | **hard** | Parent `SIGKILL` when `functionTimeoutMs + --function-timeout-grace-ms` (default `2000 ms`) elapses after `function-start` |
| `AnalysisQueryAPI.decompile` / UI cancellable decompile (`signal`, `decompilerTimeBudgetMs`, `phase8TimeBudgetMs`) | **best-effort (cooperative)** | Abort and budget checks at loop, phase, and pass boundaries |
| `tools/validation/public-benchmark/profile-fresh.mjs` (`--function-timeout-ms`) | **best-effort (cooperative)** | In-process `AbortController` plus elapsed-time `TIMEOUT` coercion (documented in CLI usage) |
| Bare `fresh-subject.mjs` / `case-worker.mjs` run without a supervisor | **best-effort (cooperative)** | In-process `AbortController` plus the never-`PASS` coercion |

## Two-Tier Watchdog Model

JavaScript cannot preempt a synchronously executing analysis pass inside the same isolate. The timeout model therefore separates cooperative in-process cancellation from hard process-boundary enforcement:

1. **Tier 1 (In-process soft abort):** An in-process `AbortController` and pass-level deadlines (`decompilerTimeBudgetMs`, `phase8TimeBudgetMs`, `transformSafetyCeilingMs`) abort decompilation when the budget expires. This tier operates at loop, phase, and pass boundaries; a synchronous CPU-bound step that overruns the deadline blocks the event loop until it returns.
2. **Tier 2 (Process boundary hard watchdog):** The parent supervisor monitors worker progress and forcefully terminates the worker with `SIGKILL` when a function exceeds `functionTimeoutMs + graceMs`.

## Core Rules

1. **Hard Watchdog Enforcement (supervised runners only):**
   - The child worker reports per-function progress: an `inflight.json` marker keyed by function address (`fresh-subject.mjs`), or `{ type: 'function-start', address, startedAt }` / `{ type: 'function-end', address, ... }` events over stdout/IPC (`case-worker.mjs`).
   - If the child does not finish a function within `functionTimeoutMs + graceMs`, the supervisor terminates the worker with `SIGKILL` and writes a durable receipt for that function with:
     - `state: 'TIMEOUT'`
     - `hard: true`
     - `elapsedMs`: supervisor-measured elapsed time
     - `reason: 'function-watchdog-timeout'` (`run-fresh-case.mjs`) or `'function-watchdog-timeout-hard'` (`measure-functions.mjs`)
   - The supervisor respawns the child to continue remaining functions from durable receipts, skipping already-completed and timed-out functions.
   - **Scope of the hard tier:** Covers per-function decompilation only. Setup and between-function progress are bounded by `--setup-timeout-ms` (default `60000 ms` in `run-fresh-case.mjs`, reset on every observed progress event so marker-less gaps between functions are not misclassified as `case-setup-timeout` while stalls remain bounded) or `--product-timeout-ms` (default `900000 ms` in `measure-functions.mjs`).

2. **Timeout Is Never `PASS`:**
   - Any function whose measured elapsed execution time exceeds `functionTimeoutMs` must never be reported as `PASS`.
   - If a function completes after the deadline before process termination (or in single-process tools such as `profile-fresh.mjs`), its state is coerced from `PASS` to `TIMEOUT` with reason `function-timeout-elapsed-exceeded`.

3. **Durable Machine-Readable Output:**
   - Case records and summaries preserve all completed and timed-out function receipts without corrupting output schemas.

## Product-Facing Timeout and Cancellation Semantics

Outside process-supervised benchmark runners:

- **`AnalysisQueryAPI.decompile` (`js/analysis/query/api.js`) and UI cancellable decompile:**
  - `options.signal`, `options.decompilerTimeBudgetMs`, and `options.phase8TimeBudgetMs` are **best-effort (cooperative)**.
  - Passes check abort signals and deadlines at loop, phase, and pass boundaries; an atomic synchronous step cannot be preempted without a process boundary.
- **Single-Process CLI Tools (`tools/validation/public-benchmark/profile-fresh.mjs`):**
  - Uses cooperative in-process `AbortController` cancellation and coerces any completion exceeding `functionTimeoutMs` to `TIMEOUT`, but cannot preempt hung synchronous execution.

## Regression Verification

- `tests/function-timeout-semantics-documented.test.mjs` — verifies `profile-fresh.mjs` CLI usage, this document's cooperative vs. Tier 2 `SIGKILL` contract, and `AnalysisQueryAPI.decompile` JSDoc.
- `tests/public-benchmark/fresh-runner.test.mjs` — verifies hard watchdog `TIMEOUT` persistence, durable restart, setup/no-progress timeout boundaries, and between-function stall handling.
- `tests/issue-function-timeout-hard-watchdog.test.mjs` — verifies real busy-loop `SIGKILL` termination (`TIMEOUT`/`hard: true`), elapsed-exceeded coercion, and cooperative async abort behavior.
