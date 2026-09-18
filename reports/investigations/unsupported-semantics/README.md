# UNSUPPORTED semantics investigation — recommendation (stage 4)

- baseSha: `05c93a1c92b34f4876060bd858e4393557d02dd4`
- stages: `00-baseline.md` (exact 320 inventory) → `01-binary-semantics.md`
  (CRT init/fini ground truth) → `02-first-divergence.md`
  (`function-end-unproven` → `UNSUPPORTED`) → this file.
- `reports/public-benchmark/summary.json`: **not modified** (frozen). All
  filtered numbers below are supplemental views computed from the frozen
  artifact, never a rewrite of it.

## Verdict counts (320 rows, disjoint primary classification)

- **A. Real decompilable user function where Hex has a capability gap: 0.**
  No row is an ordinary user function: every address is a zero-size HIDDEN
  FUNC at an executable init/fini section start, loader-invoked, with no user
  call edge (stage 1–2). There is no evidence of a decoder/lifter gap — the
  bytes decode (`llvm-objdump`) and IDA's 4-line/1-line pseudocode needs no
  Hex-missing instruction support.
- **B. Real code but special runtime / init-fini entity: 320.**
  All 320 are executable CRT startup/finalization bodies (`_init` in `.init`,
  `_fini` in `.fini`; sampled `DT_INIT==0x860`, `DT_FINI==0x2a84`). Real bytes,
  real FUNC symbols, real loader contract — but HIDDEN, zero-extent,
  section-start trampolines, not user functions.
- **C. Comparator/reference artifact (IDA-only fiction, no binary ground): 0.**
  Explicitly 0: the bytes, FUNC symbols, and INIT/FINI contract exist, so "IDA
  invented them" is false. C is retained as a *lens*, not a count: under a
  narrowed *user-function-only* benchmark scope the same 320 would be treated
  as out-of-scope reference rows (see filter below), but that is a scope
  decision, not a claim that IDA hallucinated.
- **D. Unknown: 0**, with one stated residual (below): full-corpus `DT_INIT`/
  `DT_FINI` sweep (currently: section+symbol aggregation on all 320, dynamic-
  tag match sampled on 1 binary). Nothing in the 320 contradicts B, so parking
  them in D would be evasive, not conservative.

**Is the 320 a product bug or a metric issue? Metric (scope) issue, not a
product bug.** Hex's `function-end-unproven` fail-closed is the designed extent
contract (#2409/#2458): zero-size FUNC + no unwind/`function_starts` extent +
cross-section next-start guard ⇒ `end null` ⇒ `UNSUPPORTED`. The pipeline
refuses to invent the section-bound end (`0x878`/`0x2a98`) without authority,
and refuses to swallow `.plt` via naive next-start extension. IDA's choice to
emit section-bounded `.init_proc`/`.term_proc` is a legitimate *reference*
policy, not proof that Hex's authority policy is wrong. Under the report's
frozen scope (`published-artifact-quality-only`) the 320 correctly stay in the
denominator as Hex non-decompiles; under a user-function scope they are
out-of-scope runtime entities. Neither lens requires a production-code change.

## Tool-neutral filter rule (for a supplemental view only)

Forbidden: hardcoding comparator labels (`.init_proc`, `.term_proc`, `$x`) or
Hex internals. Required: symmetric, binary-grounded, applicable to IDA and Hex
rows identically.

**Rule R1 (proposed):** exclude a comparison row iff its address equals the
`DT_INIT` or `DT_FINI` value parsed from the case binary's `PT_DYNAMIC`
segment. Inputs: ELF headers only. No symbol names, no section names, no tool
output. Both tools' rows at that address drop together (denominator −= rows,
not Hex-only subtraction).

- Why this rule: INIT/FINI are the loader's own designation of startup/
  finalization entry points — the tool-independent definition of "runtime
  init/fini entity". It generalizes beyond ARM64/Linux only insofar as the
  binary format names such entries; where a format has no such contract the
  rule is a no-op (fail-closed, no silent exclusion).
- Weaker alternative R2 (section+symbol, more portable, slightly name-touched):
  exclude iff address is an executable-section start **and** carries a
  zero-size `STT_FUNC` **and** the section is the image's designated init/fini
  section. R1 is preferred precisely because it avoids even section/symbol
  names. Either rule must be published with the filtered view and versioned
  with the corpus; neither rewrites the frozen report.
- Coverage honesty: R1's premise (every one of the 320 is a DT_INIT/FINI value)
  is *aggregated* for section+symbol on all 320 and *sampled* for the dynamic
  tag on 1/160 binaries. Before any gate or publication uses the filtered view,
  run the full-corpus dynamic sweep (160 `readelf -d` reads, mechanical) and
  attach its pass/fail table. If any of the 320 is not a DT_INIT/FINI value, it
  stays in (fail-closed) and this recommendation returns to D for that subset.

## Both numbers (frozen source, no overwrite)

Frozen (`reports/public-benchmark/summary.json`):

| view | denominator | IDA cov (ida/denom) | Hex cov (hexPseudo/denom) | matched |
|---|---|---|---|---|
| as-published | 11124 (ida 10976, hexFuncs 10952, matched 10804, hexPseudo 10292) | 0.9867 | 0.9252 | 10804 |
| R1-supplemental (÷320, symmetric) | 10804 (ida 10656, hexFuncs 10632, matched 10484, hexPseudo 10292) | 0.9863 | **0.9526** | 10484 |

Derivation: each of the 160 cases drops exactly its 2 UNSUPPORTED rows
(per-case UNSUPPORTED dist `{2: 160}`); pseudocode counts unchanged (the 320
have `hexMetrics == null`); IDA and matched counts drop symmetrically because
all 320 are matched-by-address rows. `functionStates` for the supplemental
view: `CRASH 340 / PARTIAL 692 / PASS 9600 / UNSUPPORTED 0` over the reduced
denominator (Hex discovered-function universe 10632).

## What changes, what does not

- Public benchmark result: **unchanged**. `summary.json` stays frozen;
  `denominatorFrozen: true` is honored.
- Product code/tests/tools/package.json: **unchanged** in this worktree
  (`git diff --name-only BASE..HEAD` = investigation reports only).
- C lane (`fix/arch-symbol-ranking`): **independent**. Its fix changes the
  displayed name (`$x` → `_init`/`_fini`) but, per stage 3's measured chain,
  leaves `end null` and the UNSUPPORTED verdict intact. Do not close this
  investigation on C's landing; re-run the re-verification list instead.

## Re-verify after C's symbol fix (checklist)

1. Recompute stage-1 set equality (`summary.json` vs `unsupported-functions.json`).
2. Re-run the stage-3 product probe on `1/1_clang_O0_g`: expect `nameAt →
   _init/_fini`, `end → null`, `functionWindowBound → null`,
   `validatedFunctionRange → ok:false/function-end-unproven`,
   `decompile → value null/unsupported` (name fixed, verdict unchanged).
3. Run the full-corpus `DT_INIT`/`DT_FINI` sweep for R1 and publish the table.
4. Confirm `reports/public-benchmark/` still untouched and `summary.json` frozen.
5. If any future extent-authority change (e.g. section-bound extent for
   zero-size init/fini FUNCs) is proposed, treat it as a product decision with
   its own tests and re-verification — not as a consequence of this report.
