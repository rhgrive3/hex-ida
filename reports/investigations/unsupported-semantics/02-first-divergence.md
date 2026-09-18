# 02 — First divergence for the 320 UNSUPPORTED rows (stage 3)

The 320 rows do **not** fail in instruction decoding. They fail earlier at the
function-range authority boundary.

## Pipeline trace

1. **ELF loader establishes an exact function start.**

   Every target address has a zero-size `STT_FUNC GLOBAL HIDDEN` symbol
   (`_init` or `_fini`) in an executable, file-backed section.

   `js/binary/elf-core-original.js` accepts the exact start and creates a
   `functionSeed(... exactFunctionStart:true ...)`. Because ELF `st_size == 0`,
   the seed carries no positive `size` or `end`.

   `DT_INIT` gives an additional exact-start producer for every init address.
   Current ELF dynamic parsing does not publish the symmetric `DT_FINI` seed,
   but the `_fini` STT_FUNC already establishes the fini start.

2. **Seed/result projection preserves "start known, extent unknown".**

   `analysisFromBinaryImage()` only emits a positive `funcEnd` from a
   trustworthy seed `end` or `size`. The zero-size FUNC records therefore
   become function starts whose end is null.

   The accepted C-lane name-ranking fix changes only the canonical display name:
   FUNC identity outranks the local zero-size STT_NOTYPE mapping marker, so
   `_init` / `_fini` wins over `$x`. No extent is created by that fix.

3. **No same-region next-start window exists.**

   `SymbolIndex.functionWindowBound()` uses a proved end or a later function
   start in the same canonical executable region. The init/fini entries are the
   only function starts in their tiny dedicated sections, so the next discovered
   function is in another section and cannot bound them.

4. **FIRST DIVERGENCE: function range is rejected.**

   `App.validatedFunctionRange()` sees `fn.end == null`, asks
   `functionWindowBound()`, receives null, and returns:

   ```
   { ok:false, reason:"function-end-unproven" }
   ```

   `createAppAnalysisQueryAdapter()` applies the same fail-closed range rule
   before invoking the ARM64 analyzer. No decompiler model is produced.

5. **The public decompile query surfaces UNSUPPORTED.**

   The decompile surface receives no model/presentation and returns an
   unsupported response. In the frozen benchmark build the surfaced reason is
   `decompiler-projection-unavailable`; the earlier causal reason is
   `function-end-unproven`.

   `tools/validation/public-benchmark/subject.mjs` maps a null decompile value to
   per-function `state: UNSUPPORTED`, which is exactly how the 320 rows enter
   the report.

## Focused runtime reproductions

Four cases spanning both compilers, multiple optimization levels and debug
settings were replayed through the same `product-host.mjs → AnalysisQueryAPI`
path used by the benchmark.

| case | target | region | validated range | decompile |
|---|---:|---|---|---|
| `1/1_clang_O0_g` | init `0x860` | `.init` | `function-end-unproven` | unsupported |
| `1/1_clang_O0_g` | fini `0x2a84` | `.fini` | `function-end-unproven` | unsupported |
| `3/3_gcc_O3_no_g` | init `0x990` | `.init` | `function-end-unproven` | unsupported |
| `3/3_gcc_O3_no_g` | fini `0x2298` | `.fini` | `function-end-unproven` | unsupported |
| `5-1/5-1_clang_Os_g` | init `0xd48` | `.init` | `function-end-unproven` | unsupported |
| `5-1/5-1_clang_Os_g` | fini `0x1498` | `.fini` | `function-end-unproven` | unsupported |
| `7/7_gcc_O2_g` | init `0x848` | `.init` | `function-end-unproven` | unsupported |
| `7/7_gcc_O2_g` | fini `0x130c` | `.fini` | `function-end-unproven` | unsupported |

All eight focused targets had `fn.end == null` and no pseudocode.

The corpus-wide artifact check independently shows the same output shape for all
320 rows: `end:null`, `state:UNSUPPORTED`, `completeness:unsupported`,
`pseudocode:null`.

## What the failure is — and is not

It is **not**:

- an AArch64 decoder failure,
- a lifter/semantic-op unsupported instruction,
- caused by the displayed `$x` name,
- evidence that the addresses are IDA-only synthetic inventions.

It **is**:

- a boundary-authority limitation for real loader-designated runtime functions
  whose ELF FUNC symbols have zero size,
- intentionally fail-closed rather than inventing a generic section end,
- a real pseudocode-coverage gap under the current frozen benchmark scope.

The fact that the fail-closed policy is deliberate does not make the observable
coverage gap disappear. It means the repair must preserve the authority contract
instead of applying a generic "section start means whole-section function" rule.

## Safe generalized repair surface

A generic executable-region fallback is too broad. The evidence supports a much
narrower design:

1. Parse and retain **both** `DT_INIT` and `DT_FINI` as loader-designated
   function-entry evidence.
2. When such an address is exactly the start of its containing executable,
   fully file-backed section, allow the section end to act as an **analysis
   window**, not as a claimed exact function extent.
3. Publish the result as incomplete/partial with provenance such as
   `elf-dynamic-init-fini+section-window` and reason
   `function-end-unproven`; do not upgrade it to a proved extent.
4. Keep the rule binary-grounded. Do not key it on `.init_proc`,
   `.term_proc`, `$x`, benchmark addresses, or compiler names.
5. Add synthetic ELF fixtures that cover DT_INIT, DT_FINI, co-located mapping
   symbols, zero-sized FUNC records, a non-init executable section start
   counterexample, and a malformed/non-file-backed section counterexample.

This would let the analyzer produce partial pseudocode for the runtime entry while
remaining honest that ELF did not publish a positive FUNC extent.

Production code is intentionally unchanged by this investigation branch.
