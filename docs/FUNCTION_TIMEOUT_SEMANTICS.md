# Function Timeout Semantics

Decision record for the `--function-timeout-ms` semantics question
(`docs/HEX_COMPLETION_GOAL.md`, required result 2). Covers the per-function decompilation
runners in the benchmark and measurement lanes (`tools/validation/public-benchmark` and
`reports/investigations/current-main-weakness-20260923/harness`).

## Decision

`--function-timeout-ms` is **hard wherever a parent supervises a child worker process, and
explicitly best-effort (cooperative) in-process**. There is no third mode: every surface is either
supervised (SIGKILL at a process boundary) or documented here as best-effort.

| Surface | Mode | Enforced by |
| --- | --- | --- |
| `run-fresh.mjs` → `run-fresh-case.mjs` → `fresh-subject.mjs` | **hard** | parent `SIGKILL` when the `inflight.json` marker is older than `functionTimeoutMs + --watchdog-grace-ms` (default 2000 ms) |
| `harness/measure-functions.mjs` → `harness/case-worker.mjs` | **hard** | parent `SIGKILL` when `functionTimeoutMs + --function-timeout-grace-ms` (default 2000 ms) elapses after `function-start` |
| `product.query.decompile` in-process options (`signal`, `decompilerTimeBudgetMs`, `phase8TimeBudgetMs`) | **best-effort (cooperative)** | abort/budget checks at loop, phase and pass boundaries |
| `profile-fresh.mjs` (`--function-timeout-ms`) | **best-effort (cooperative)** | in-process `AbortController`; the CLI usage text states this |
| Bare `fresh-subject.mjs` / `case-worker.mjs` started without a supervisor | **best-effort (cooperative)** | in-process `AbortController` plus the never-`PASS` coercion |

## Overview

In benchmark and measurement lanes, `--function-timeout-ms` specifies a time budget per function.
When the setting was introduced it only cancelled an in-process `AbortController` signal, allowing
uncooperative or CPU-bound functions to run indefinitely and still report `state: PASS` when
downstream analysis did not observe the abort signal. That is why the hard tier was added:
JavaScript cannot preempt a synchronously executing analysis pass inside the same isolate, so a real
deadline requires something that can be killed — a child process.

The timeout model is therefore a two-tier watchdog:
1. **Tier 1 (In-process soft abort):** An in-process `AbortController` aborts decompilation when
   `functionTimeoutMs` expires. This tier only works where the analysis yields to the event loop; a
   synchronous loop past the deadline cannot even observe that the timer fired.
2. **Tier 2 (Process boundary hard watchdog):** The parent supervisor monitors worker progress and
   kills the worker with `SIGKILL` when a function exceeds `functionTimeoutMs + graceMs`.

## Core Rules

1. **Hard Watchdog Enforcement (supervised runners only):**
   - The child worker reports progress for each function: an `inflight.json` marker keyed by function
     address (`fresh-subject.mjs`), and `{ type: 'function-start', address, startedAt }` /
     `{ type: 'function-end', address, ... }` events over stdout and IPC (`case-worker.mjs`).
   - If the child does not finish a function within `functionTimeoutMs + graceMs`, the supervisor
     forcefully terminates (`SIGKILL`) the child worker and creates a durable receipt for the
     timed-out function with:
     - `state: 'TIMEOUT'`
     - `hard: true`
     - `elapsedMs`: measured supervisor elapsed time
     - `reason: 'function-watchdog-timeout'` (`run-fresh-case.mjs`) or
       `'function-watchdog-timeout-hard'` (`measure-functions.mjs`)
   - The supervisor then respawns the child to process the remaining functions of the case, resuming
     from durable receipts (skipping already-completed functions and the timed-out function).
   - **Scope of the hard tier:** it covers per-function decompilation only. Time before the first
     function of a child (binary open, snapshot, function discovery, receipt resume) is bounded by the
     runner's setup/no-progress budget — `--setup-timeout-ms` (default 60000 ms) for
     `run-fresh-case.mjs`, `--product-timeout-ms` (default 900000 ms) for the measurement harness —
     not by `--function-timeout-ms`. In `run-fresh-case.mjs` that budget is restarted by every
     observed progress event (a function started, or a function finished), so the marker-less gap
     between two functions is never misreported as `case-setup-timeout`, while a child that stops
     making progress is still killed within the budget. Post-function structure probing in
     `case-worker.mjs` (`product.query.cfg` / `product.query.semanticIR`) runs with the watchdog
     cleared and is best-effort, not per-function enforced.

2. **Timeout Is Never PASS:**
   - Any function whose measured elapsed execution time exceeds `functionTimeoutMs` MUST NEVER be
     reported as `PASS`.
   - If a function finishes after the timeout deadline but before process termination (or in
     single-process tools such as `profile-fresh.mjs`), its state is coerced from `PASS` to `TIMEOUT`
     with reason `function-timeout-elapsed-exceeded`.

3. **Machine-Readable Case Output:**
   - Case records and summaries accurately reflect all function states, including hard and soft
     timeouts, without losing intermediate progress or corrupting schema contracts.

## Product-Facing Timeout and Budget Semantics

Outside benchmark harnesses with process-boundary supervision:
- **`product.query.decompile` (and underlying `decompile()`):**
  - All timeouts and cancellation signals (`options.signal`, `options.decompilerTimeBudgetMs`,
    `options.phase8TimeBudgetMs`) are **best-effort (cooperative)**.
  - In-process passes check deadlines and abort signals at loop, phase, or pass boundaries.
    CPU-bound or uncooperative work within an atomic step cannot be forcefully interrupted without a
    process boundary, and a synchronous step that overruns the deadline blocks the timer itself.
- **CLI and Single-Process Tools:**
  - Tools running in a single Node.js process without a supervisor watchdog (such as
    `tools/validation/public-benchmark/profile-fresh.mjs`) use cooperative in-process abort
    (`AbortController`). While they coerce any completion exceeding `functionTimeoutMs` from `PASS` to
    `TIMEOUT`, they cannot forcibly preempt hung synchronous CPU execution.
  - Multi-process harnesses (`run-fresh.mjs` / `run-fresh-case.mjs` and `measure-functions.mjs`)
    provide the authoritative hard watchdog tier via SIGKILL supervision.

## Regression Evidence

- `tests/public-benchmark/fresh-runner.test.mjs`
  - `hard function watchdog persists TIMEOUT and restarts from the next durable state` — the
    supervisor really kills a child that never finishes its function.
  - `case setup timeout never fires for the gap between two measured functions` — a child that has
    already exceeded the setup budget while running a function is not aborted for the marker-less gap
    between functions.
  - `a stall between two functions is still bounded by the setup/no-progress budget` — the same gap is
    still bounded, so the hard tier stays bounded after the fix.
  - `a child that never reaches a function is still killed as case-setup-timeout`.
- `tests/issue-function-timeout-hard-watchdog.test.mjs`
  - `parent watchdog kills child hung in busy loop and completes other functions` — a real
    `while (true) {}` child is SIGKILLed and recorded `TIMEOUT`/`hard:true`.
  - `elapsed > functionTimeoutMs is never reported PASS in fresh-subject`.
  - `profile-fresh best-effort tier: synchronous uncooperative work blocks the deadline timer`.
  - `profile-fresh best-effort tier: async work that yields is cooperatively aborted at the deadline`.
