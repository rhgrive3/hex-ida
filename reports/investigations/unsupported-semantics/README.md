# UNSUPPORTED semantics investigation — final recommendation

- investigation base: `05c93a1c92b34f4876060bd858e4393557d02dd4`
- scope: the 320 `hexState == UNSUPPORTED` rows in the frozen public benchmark artifact
- production code/tests/tools: unchanged on this branch
- benchmark output: unchanged; `reports/public-benchmark/summary.json` remains frozen

The evidence chain is:

`00-baseline.md` → exact 320-row inventory  
`01-binary-semantics.md` → full-corpus ELF semantics  
`02-first-divergence.md` → start-known / extent-unknown range failure

## Final classification

The 320 rows are one homogeneous class.

- **B — real code, special runtime/init-fini entity: 320**
- **C — comparator/reference fiction with no binary ground: 0**
- **D — unknown: 0**

A/B are different questions here: the **entity class** is B, while the
**observable product limitation** is a function-boundary/pseudocode coverage gap
for all 320 rows under the benchmark's current scope.

Corpus-wide binary evidence:

- 160 exact `DT_INIT` matches and 160 exact `DT_FINI` matches.
- 160 `.init` and 160 `.fini` executable section starts.
- 320 same-address zero-size `STT_FUNC GLOBAL HIDDEN` records
  (`_init` / `_fini`).
- 320 same-address AArch64 `$x` mapping markers.
- 320 sections fully file-backed by executable PT_LOAD mappings.
- 320 frozen subject rows with `end:null`, no pseudocode and
  `state:UNSUPPORTED`.

There is no decoder/lifter unsupported-instruction evidence in this cluster.
The first failure is `function-end-unproven`: start authority exists, positive
extent authority does not.

## Product vs metric

Do **not** collapse this to "metric issue, not product bug."

The fail-closed extent policy is deliberate and defensible, but the benchmark's
frozen scope is `published-artifact-quality-only`; these addresses are real,
matched, loader-designated executable functions, and Hex publishes no pseudocode.
Within that existing scope, the 320 rows are a genuine coverage limitation.

There is also a legitimate **supplemental** user-function-only lens. If a report
wants to exclude runtime loader init/fini entries, the filter must be symmetric
and binary-grounded. That supplemental view must not replace or rewrite the
frozen benchmark.

## Tool-neutral supplemental filter

A safe optional rule is:

> Exclude a comparison row iff its address equals the binary's `DT_INIT` or
> `DT_FINI` dynamic value.

This uses only the target binary's dynamic-loader contract. It does not inspect
IDA names, Hex names, mapping-symbol spellings, compiler names, or benchmark
addresses.

The full-corpus sweep now verifies the rule premise for **320 / 320** rows, so
there is no residual unknown subset.

If applied only as a separately labeled supplemental view:

| view | denominator | IDA | Hex discovered funcs | matched | Hex pseudocode |
|---|---:|---:|---:|---:|---:|
| frozen published | 11124 | 10976 | 10952 | 10804 | 10292 |
| runtime-init/fini excluded | 10804 | 10656 | 10632 | 10484 | 10292 |

The supplemental Hex pseudocode coverage is `10292 / 10804 ≈ 95.26%`.
This number is descriptive only; it is not a replacement score and does not
change `summary.json`.

## Why C does not close F

The accepted C same-address ranking repair is relevant but independent.

Before C, the frozen artifact displays `$x` because a local zero-size mapping
record wins the old naming projection. C changes canonical naming so the callable
FUNC identity wins, yielding `_init` / `_fini`.

That repairs identity presentation only. It does not create a positive size/end,
so the range gate remains `function-end-unproven` unless a separate extent/window
policy is added.

## Recommended product follow-up

Do not introduce a generic "use executable section end" rule.

A safe design should be restricted to binary-grounded dynamic runtime entries:

1. retain both `DT_INIT` and `DT_FINI` as exact loader-entry evidence;
2. require the entry address to equal the start of a fully file-backed executable
   section;
3. use that section end only as an **analysis window**, not as a proved function
   extent;
4. publish decompilation as partial/incomplete with explicit
   `function-end-unproven` provenance;
5. add independent synthetic ELF counterexamples so ordinary executable section
   starts cannot acquire this privilege.

That design can recover useful pseudocode without weakening the existing
fail-closed extent contract.

## Acceptance state

F is complete as an investigation:

- exact inventory: complete;
- binary semantics: complete across all 320 rows;
- dynamic-tag sweep: complete across all 160 binaries;
- first divergence: identified;
- C interaction: separated;
- unknown rows: 0;
- production changes: 0.

Any implementation of the recommended runtime-entry analysis-window policy should
be a separate production PR with its own synthetic regressions.
