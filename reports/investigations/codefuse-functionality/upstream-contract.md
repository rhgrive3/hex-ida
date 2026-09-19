# CodeFuse-DeBench upstream contract

Pinned upstream: `codefuse-ai/CodeFuse-DeBench`

| field | value |
|---|---|
| repository | https://github.com/codefuse-ai/CodeFuse-DeBench |
| pinned commit | `c956988f8e16c85eafd4f7fd91b27feaa86bcb2b` |
| pinned commit date | 2026-05-29 |
| paper | https://arxiv.org/abs/2605.29490 |
| license | Apache-2.0 |

Every statement below was read from the pinned commit. File paths are relative to
the upstream repository root. Where this lane cannot reproduce the upstream
behaviour, it is listed under "Documented deviations"; nothing is inferred.

## 1. Stage overview

The upstream framework has three stages:

1. Readability (`evaluator/readability/eval_readability.py`) — host-side LLM scoring.
2. **Syntactic Correctness / Recompilation** (`evaluator/syntactic/auto_fixer_v3.py`).
3. **Functionality / Semantic Fidelity** (`evaluator/semantic/run_instrumentation.py`).

This lane targets stages 2 and 3.

## 2. Step 2 — Recompilation contract

Source files: `evaluator/syntactic/auto_fixer_v3.py`,
`evaluator/syntactic/utils/compiler.py`, `evaluator/syntactic/utils/llm_client.py`,
`evaluator/syntactic/utils/error_parser_v3.py`, `docs/STEP2_METRICS.md`.

### 2.1 Input

A single decompiled C source file for one benchmark task. Two environment
variables modify behaviour: `BINBENCH_ORIGINAL_CMD` (the original build command,
so the repaired file is compiled with the same toolchain/flags as the original
binary) and `BINBENCH_PRIMARY_SOURCE` (which source argument is the primary one).

### 2.2 Deterministic pre-LLM preprocessing

`auto_fixer_v3.py::preprocess_decompiled_code` runs before the first compile and
before any LLM call:

- decompiler detection (`ida`, `ghidra`, `binaryai`, `angr`, `retdec`, else `unknown`);
- common type normalization (`__int64` → `long long`, and the other MSVC widths);
- per-decompiler syntax normalization (e.g. IDA `__fastcall`; Ghidra `undefined8`);
- CRT/startup stub function removal (`_start`, `frame_dummy`, `__do_global_dtors_aux`
  and the ARM/libgcc `__aeabi_*` helpers, etc.);
- optional injection of a fixed `uintN_t`/`size_t` typedef block;
- a final `re.sub(r' +', ' ', code)` whitespace collapse.

This is part of the published method, so an honest "raw recompilability" number
must state whether it was applied.

### 2.3 Repair loop

```
decompiled code -> compile / link -> parse errors -> LLM patch -> apply -> retry
```

- Compile fallback command: `gcc -c -g -O0 <file> -o /dev/null`.
- Link fallback command: `gcc -O0 -g <file> -o <out>` (macOS adds `-arch arm64`).
- When `BINBENCH_ORIGINAL_CMD` is set, the toolchain is adapted from that command
  (source argument swapped, `-o` replaced, `--target` normalized for armv7).
- The LLM is asked for patches through two tools:
  `edit_code_block {search_block, replace_block}` (preferred, exact match) and
  `replace_string {old_str, new_str, replace_all}`.
- Default maximum iterations: `--max-iters 50`.

### 2.4 Result states

`success` (compilation and linking both succeed), `linker_failed` (compiles but
does not link), `compile_failed` (never compiles). Task-level exceptional states:
`context_exceeded`, `tool_call_invalid`, `api_error`.

### 2.5 Outputs

`syntactic/repair_trace.json` (fields include `final_status`, `total_iterations`,
`history`, `initial_errors`, `historical_lowest_errors`), `compile_checkpoint.json`,
`fix_<bin_name>.c`, and the rebuilt binary at `bin/<bin_name>_fixed`.

### 2.6 Published metric

"The Recompilability = Full Success (FS) rate" (README). Full success means the
case reaches the `success` state.

## 3. LLM contract

Source files: `evaluator/syntactic/utils/llm_client.py`, `config/llm_config.json`,
`config/llm_key_inventory.json`, `docs/LLM_CONFIGURATION_GUIDE.md`.

- The client is the **OpenAI Python client** (`from openai import OpenAI`) with a
  provider-supplied `base_url`, so any OpenAI-compatible `/chat/completions`
  endpoint is a valid backend.
- A profile defines `key_provider`, `preferred_key_aliases`, `base_url`, `model`,
  `temperature`, and optionally `enable_thinking` / `stream_for_thinking`.
- API keys live only in environment variables referenced as `${BINBENCH_*_API_KEY}`
  and are expanded by `config/config_loader.py`; real keys are never committed.
- Template profiles: `glm_official`, `qwen3.5-plus`, `minimax`, `deepseek`.
- Multiple keys are rotated on quota/exhaustion patterns; retries use exponential
  backoff (`[60, 120, 240, 480, 960]` seconds); context-window errors are not retried.

This lane keeps the same interface shape (base URL, model, key env, temperature)
but defaults to a **local Ollama OpenAI-compatible endpoint** and never hardcodes
a paid provider.

## 4. Step 3 — Functionality contract

Source files: `evaluator/semantic/run_instrumentation.py`,
`evaluator/semantic/analyze_traces.py`, `evaluator/semantic/semantic_utils.py`,
`evaluator/semantic/trace_format.py`, `evaluator/semantic/hook_trace.js`,
`docs/SEMANTIC_EVALUATION_DETAILS.md`.

### 4.1 Runtime oracle

Both the **original binary** and the **repaired (recompiled) binary** are run and
compared; the original is the ground-truth side.

- Program-level: stdout is parsed into test lines using
  `TEST_ID_RE = ([A-Z]{2,}(?:-[A-Z0-9]+)+)`, keyed by `(test_id, occurrence)` and
  whitespace-normalized. The denominator is the **union of stable cases observed
  on either side**. States: `exact`, `partial`, `fail`, `unsupported`.
  Exit code and signal are compared separately (`process_status_match`).
- Function-level: driver functions come from `target_functions.json` plus calls
  discovered in `main()`; comparisons are call-sequence ratio, feature-function
  match ratio, driver print match ratio, and a normalized I/O match ratio.
- Instruction-level: `SequenceMatcher` over normalized register-signature tokens;
  explicitly diagnostic-only and not used for pass/fail.
- Overall `quality_status`: `pass` / `partial` / `fail` / `unsupported`, with the
  documented degradation rules (e.g. program pass + function fail → `partial`).

### 4.2 Capture and tracing

Program stdout/stderr/exit/signal are captured with a 30 s default timeout
(`stdbuf -o0 -e0` when unbuffered capture is available). Function tracing uses
**Frida** (`hook_trace.js`), with symbols parsed via `readelf`/`nm`. Trace format
version is `2` (`write_raw_bytes_v2`); analysis version is `5`.

### 4.3 Outputs

`program_original.json`, `program_decompiled.json`, `stdout_original.txt`,
`stdout_decompiled.txt`, `trace_original.txt`, `trace_decompiled.txt`,
`semantic_context.json`, `result_metrics.json`, `result_analysis.md`.

### 4.4 Architecture-specific requirements

The pipeline runs inside a guest VM per architecture (`binbench-arm64.yaml`
and friends); for `arm32`/`x86` the guest may recompile natively at runtime to
avoid glibc mismatches. ARM64 evidence therefore requires an ARM64 execution
environment (an arm64 host, an emulator such as `qemu-aarch64`, or a cross
toolchain plus a target runtime) — a host x86_64 run is not ARM64 evidence.

### 4.5 Published metric

"The Functionality = program-level Exact Stdout + Partial rate" (README).

## 5. Published numbers at the pinned commit

| decompiler | Readability | Recompilability | Functionality |
|---|---|---|---|
| IDA | 5.73 (#1) | 64.8% (#2) | 29.7% (#1) |
| Ghidra | 5.50 (#2) | 65.5% (#1) | 22.8% (#2) |
| BinaryAI | 4.99 (#3) | 47.2% (#4) | 14.8% (#3) |
| RetDec | 4.51 (#4) | 50.2% (#3) | 1.5% (#5) |
| Angr | 4.36 (#5) | 38.0% (#5) | 9.2% (#4) |

These were produced with the upstream repair LLM, runtime, and configuration.
They are **not** the same measurement as a raw Hex value (see the fairness note
in `README.md`).

## 6. Documented deviations in this lane

1. **Stub-function end detection.** Upstream searches for the *next* `{` after a
   matched CRT definition; this lane uses the `{` that terminates the match and a
   balanced-brace scan. Same intent, deterministic result. Recorded here because
   the upstream scan can overrun a body.
2. **Stable-case set.** Upstream derives stable/unstable program-level cases from
   the benchmark source plus `case_stability_config.json`. This repository does not
   ship that source, so the stable set defaults to the union of test ids observed
   on either side; the `(test_id, occurrence)` key and normalization are unchanged.
3. **No Frida trace yet.** Function-level and instruction-level evidence are not
   produced by this lane at probe time; only program-level comparison is measured.
4. **Host architecture.** The probe environment is x86_64, so any compile/link it
   reports is a host measurement, never an ARM64 measurement.
