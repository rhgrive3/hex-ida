# Function Timeout Semantics

This document describes the execution and timeout model used for per-function decompilation in benchmark runners and measurement harnesses (including `reports/investigations/current-main-weakness-20260923/harness` and `tools/validation/public-benchmark`).

## Overview

In benchmark and measurement lanes, `--function-timeout-ms` specifies a time budget per function. Previously, this setting only cancelled an in-process `AbortController` signal, allowing uncooperative or CPU-bound functions to run indefinitely and still report `state: PASS` when downstream analysis did not observe the abort signal.

The timeout model is a two-tier watchdog:
1. **Tier 1 (In-process soft abort):** An in-process `AbortController` aborts decompilation when `functionTimeoutMs` expires.
2. **Tier 2 (Process boundary hard watchdog):** The parent supervisor monitors worker progress. If a function decompilation exceeds `functionTimeoutMs + functionTimeoutGraceMs` (default grace: 2000 ms, configurable via `--function-timeout-grace-ms`), the parent sends `SIGKILL` to the child process.

## Core Rules

1. **Hard Watchdog Enforcement:**
   - The child worker reports progress events for each function: `{ type: 'function-start', address, startedAt }` and `{ type: 'function-end', address, ... }` via stdout and IPC (`process.send`).
   - If the child process does not finish within `functionTimeoutMs + graceMs`, the supervisor forcefully terminates (`SIGKILL`) the child worker.
   - The supervisor creates a durable receipt for the timed-out function with:
     - `state: 'TIMEOUT'`
     - `hard: true`
     - `elapsedMs`: measured supervisor elapsed time
     - `reason: 'function-watchdog-timeout-hard'`
   - The supervisor then respawns the child worker to process the remaining functions of the case, resuming from durable receipts (skipping already-completed functions and the timed-out function).

2. **Timeout Is Never PASS:**
   - Any function whose measured elapsed execution time exceeds `functionTimeoutMs` MUST NEVER be reported as `PASS`.
   - If a function finishes after the timeout deadline but before process termination (or in single-process tools such as `profile-fresh.mjs`), its state is coerced from `PASS` to `TIMEOUT`.

3. **Machine-Readable Case Output:**
   - Case records and summaries accurately reflect all function states, including hard and soft timeouts, without losing intermediate progress or corrupting schema contracts.
