# CodeFuse-DeBench functionality / recompilability lane

An independent investigation lane that measures Hex decompiler output on the
CodeFuse-DeBench method: **Raw Recompilability**, **LLM-assisted Recompilability**,
and **Runtime Functionality**.

The lane is additive. It changes no production analysis logic, does not import
anything from an in-progress E/G/F or PR-fix branch, and treats
`reports/public-benchmark/` and `reports/public-benchmark-parallel/` as read-only
inputs. The product translation-unit packager it optionally uses
(`js/analysis/query/translation-unit.js`) is already on `main`.

The exact upstream contract this lane implements is in
[`upstream-contract.md`](./upstream-contract.md).

## What is measured

| lane | input | what it answers |
|---|---|---|
| raw recompilability | Hex output after CodeFuse's deterministic, non-LLM preprocessing | does the decompiled translation unit compile and link with no repair? |
| raw function text | Hex function-scoped text, unmodified | how much of the raw lane depends on that preprocessing? |
| LLM-assisted recompilability | preprocessed source + external OpenAI-compatible endpoint | can a bounded repair loop reach a successful compile+link? |
| runtime functionality | only a produced binary, compared against the original binary | does the rebuilt program behave like the original? |

The raw and LLM-assisted lanes are separate artifacts and are never merged into
one number. A compile success is not treated as semantic correctness; only the
runtime comparison decides functionality.

## How to run

```bash
# 5-case probe (writes per-case/*.json and probe-summary.json)
node reports/investigations/codefuse-functionality/harness/probe.mjs --count 5 --timeout-ms 60000

# focused tests (offline, finite timeouts, no network)
npm run codefuse:functionality:test
```

The LLM lane stays `unsupported` unless an endpoint is reachable. Point it at a
local Ollama server (defaults) or any OpenAI-compatible endpoint:

```bash
CODEFUSE_LLM_BASE_URL=http://127.0.0.1:11434/v1 \
CODEFUSE_LLM_MODEL=qwen2.5-coder:7b \
node reports/investigations/codefuse-functionality/harness/probe.mjs
```

See [`llm.config.example.json`](./llm.config.example.json) for every configurable
field. No paid provider is hardcoded and the model is not a repository dependency.

## Artifacts

```
reports/investigations/codefuse-functionality/
├── README.md
├── upstream-contract.md
├── llm.config.example.json
├── probe-summary.json                  # machine-readable probe result
├── per-case/<case>.json                # per-case lane record
├── per-case/sources/*.c                # raw / preprocessed / TU / repaired sources
└── harness/*.mjs                       # adapter + lanes
```

`probe-summary.json` records the source SHAs, benchmark manifest hash, upstream
CodeFuse commit, compiler identity, architecture, LLM provider/base/model,
repair attempts, raw/repaired recompilability, raw/repaired functionality, and
timeout/crash counts. API keys are never written: only the env-var **name** is
recorded (`apiKeyEnv`) plus a boolean `apiKeyPresent`.

### Provenance and artifact hygiene

- `identity.headSha` names the commit the probe ran against, and
  `identity.worktreeDirty` records whether that tree was clean when the run
  started. A recorded HEAD without dirtiness cannot prove that the harness that
  produced an artifact is the harness that commit contains, so both are kept.
- Committed evidence is host-neutral: compiler paths are reduced to paths
  relative to the repository, and no absolute build-machine path is stored.
- Only bounded reductions of compiler output are committed (error/warning counts,
  the first error, and the discarded stderr size) — never the full log.

`tests/codefuse-functionality/artifact-hygiene.test.mjs` enforces all three
properties, so a regression cannot be committed silently.

## Probe result (5 cases)

Selected deterministically from the frozen manifest by facet coverage
(compiler × optimization × debug), never by hardcoded id:

`1/1_clang_O0_g`, `1/1_gcc_O1_no_g`, `1/1_clang_O2_g`, `1/1_clang_O3_g`, `1/1_clang_Os_g`.

| field | value |
|---|---|
| upstream | `c956988f8e16c85eafd4f7fd91b27feaa86bcb2b` |
| benchmark manifest | `benchmarks/public/codefuse-arm64/manifest.json` (`de5d7726…`, 160 cases) |
| compiler | `cc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0` |
| measured architecture | `x64` (linux, node v24.20.0) — **not ARM64** |
| raw recompilability (CodeFuse-preprocessed) | **0 / 5** |
| raw recompilability (unmodified function text) | **0 / 5** |
| LLM-assisted recompilability | **unsupported** (no reachable endpoint) |
| raw functionality | **0 exact + 0 partial / 5** (all `unsupported`) |
| repaired functionality | **unsupported** |
| timeouts / crashes | 0 / 0 |

Per-case (functions with pseudocode / functions without):

| case | functions | excluded | first compiler failure | product TU | LLM | functionality |
|---|---|---|---|---|---|---|
| `1/1_clang_O0_g` | 67 | 7 | `‘global_13FD8’ undeclared` | available | unsupported | unsupported |
| `1/1_clang_O2_g` | 77 | 2 | `‘global_12FD8’ undeclared` | available | unsupported | unsupported |
| `1/1_clang_O3_g` | 77 | 2 | `‘global_12FD8’ undeclared` | available | unsupported | unsupported |
| `1/1_clang_Os_g` | 74 | 2 | `‘global_12FD8’ undeclared` | available | unsupported | unsupported |
| `1/1_gcc_O1_no_g` | 72 | 2 | `‘global_13FF0’ undeclared` | available | unsupported | unsupported |

The failure class matches the earlier
[`direct-recompilability`](../direct-recompilability/README.md) investigation:
raw Hex output does not form a standalone translation unit. No case was dropped,
and no failure was converted into a pass.

## Blockers

1. **No aarch64 cross toolchain.** The corpus is ARM64; this host is x86_64. The
   raw numbers above are host measurements and must never be labelled ARM64.
2. **No ARM64 execution runtime.** Functionality requires running the original
   ARM64 binary against the rebuilt one; there is no arm64 host, emulator, or
   cross sysroot here.
3. **No reachable LLM endpoint.** The repair lane is implemented and contract
   tested, but no Ollama/OpenAI-compatible endpoint answered at probe time.

## Fairness

Published IDA/Ghidra numbers in `upstream-contract.md` were produced with the
upstream repair model, runtime, and configuration. This lane's comparison class
is recorded in `probe-summary.json` as *"same benchmark, NO reachable repair
model"*, and raw Hex values are explicitly **not** the same metric as the
published LLM-assisted values. A same-condition comparison requires reaching the
same LLM/runtime configuration.

## Progressing to a 160-case run

1. Provide an aarch64 toolchain (and, for functionality, an arm64 runtime) so the
   raw and functionality lanes measure the target architecture.
2. Point the lane at a repair endpoint; the model/config must then be recorded
   beside the raw numbers.
3. Re-run with `--count 160` (the selection function already scales and stays
   deterministic).

## Focused tests

`npm run codefuse:functionality:test` — offline, finite timeouts:

- raw vs repaired vs product-TU artifacts are never conflated;
- functions without pseudocode are recorded, not dropped;
- a failed compile stays in the denominator with a bounded first error;
- compiler/run timeouts are enforced and recorded;
- malformed LLM responses and malformed tool calls fail closed;
- a secret value never reaches configuration, errors, or artifacts;
- probe selection is deterministic with compiler/optimization/debug coverage;
- runtime mismatch/crash/timeout/unsupported never become `pass`.
