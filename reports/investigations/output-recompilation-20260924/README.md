# Output recompilation measurement (2026-09-24)

The baseline was remeasured on current `origin/main` product source `7dc72cc2ae3a69c129d6a0755d34e5ec5ab4df02`, using one `gcc_O1_g` case per group, the same eight selected case IDs, and a 10 s per-function watchdog plus 2 s hard grace. The worker retained all timed-out functions. Exact receipts and logs are under `/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/out2/current-main-before-watchdog-fixed/`.

The older `before-run/` directory in this report tree is retained as historical material from base `e54c993e2`; none of its measurements are used below. The current baseline is recorded in [before.json](before.json).

`origin/main` later advanced to `1df5283bb`. A path comparison against the measured `7dc72cc2a` baseline found no changes under `js/`; the numbers below retain the exact measured head and are not relabeled as a rerun on the later repository commit.

## Before and after

| Measure | Before: current main | After: output lane |
| --- | ---: | ---: |
| Cases measured | 8/8 | Not measured: ownership blocker |
| Functions discovered | 530 | Not measured |
| Completed / watchdog timeout | 525 / 5 | Not measured |
| Functions with goto / observed goto edges | 126 / 269 | Not measured |
| Unknown-instruction functions / instances | 19 / 40 | Not measured |
| Structured / linear (unstructured) / timeout functions | 383 / 142 / 5 | Not measured |
| Raw syntax sample: cases passing | 0/8 | Not measured |
| Raw syntax sample: first failure families (48 functions) | local 10; identifier 22; type 8; global 8 | Not measured |
| TU packaging: unresolved pseudo-intrinsic / sentinel / global / prototype | 14 / 8 / 132 / 547 | Not measured |
| TU syntax sample: cases passing | 0/8 | Not measured |

The raw syntax sample is six functions per case. All eight selected translation units failed first on undeclared locals. The eight unknown-type-name diagnostics in the sample were `uint64` uses. The TU package replay found no rescued cases and reported every package as evidence-incomplete.

The five baseline timeouts are retained in the denominator: `1/1_gcc_O1_g@5852`, `2/2_gcc_O1_g@5364`, `2/2_gcc_O1_g@6176`, `2/2_gcc_O1_g@9152`, and `3/3_gcc_O1_g@7196`. Their names were absent from the original timeout receipts; each case/address pair is preserved in `before.json`.

## Measurement limits

Unknown-instruction counts and structured/linear mode counts describe the 525 completed functions only. A timed-out function has no completed pseudocode or coverage classification. The per-function syntax families come from the fixed 48-function replay sample, not the full 525-function set.

The after run could not be measured because the required final C output hook is `js/decompile-base.js` and the TU packager is `js/analysis/query/translation-unit.js`, both outside this lane's owned paths. No edits were made to either file. The exact ownership blocker is recorded in the lane evidence `BLOCKER.md`. The integration candidate owns the full canonical release gate.
