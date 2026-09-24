# Output recompilation measurement (2026-09-24)

The baseline was measured on `origin/main` product source `7dc72cc2ae3a69c129d6a0755d34e5ec5ab4df02`, using one `gcc_O1_g` case per group, the same eight selected case IDs, and a 10 s per-function watchdog plus 2 s hard grace. The worker retained all timed-out functions. Exact receipts and logs are under `/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/out2/current-main-before-watchdog-fixed/`.

The current baseline is recorded in [before.json](before.json). The post-fix measurement is recorded in [after.json](after.json); it was measured at output-lane head `66dbd44ab23fd39f9bd8fc22f2f184240c311e53` on the same eight case IDs, same watchdog configuration, and the same replay derivation rules. Exact receipts and logs are under `/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/out2/current-output-after-final/`. The lane's product fix is the final public C output closure plus TU fallback declarations; see the lane evidence `RESULT.md` for commits, files, and focused tests.

The older `before-run/` directory in this report tree is retained as historical material from base `e54c993e2`; none of its measurements are used below. The build helper [build-after.mjs](build-after.mjs) assembles `after.json` from a completed harness run plus its replay outputs using the exact schema and derivation rules of `before.json`.

`origin/main` later advanced to `1df5283bb`. A path comparison against the measured `7dc72cc2a` baseline found no changes under `js/`; the numbers below retain the exact measured head and are not relabeled as a rerun on the later repository commit.

## Before and after

| Measure | Before: current main (`7dc72cc2a`) | After: output lane (`66dbd44ab`) |
| --- | ---: | ---: |
| Cases measured | 8/8 | 8/8 |
| Functions discovered | 530 | 530 |
| Completed / watchdog timeout | 525 / 5 | 527 / 3 |
| Functions with goto / observed goto edges | 126 / 269 | 128 / 273 |
| Unknown-instruction functions / instances | 19 / 40 | 19 / 40 |
| Structured / linear (unstructured) / timeout functions | 383 / 142 / 5 | 383 / 144 / 3 |
| Raw syntax sample: cases passing | 0/8 | 0/8 |
| Raw syntax sample: case first-failure families (8 cases) | undeclared-local 8 | undeclared-global 8 |
| Raw syntax sample: function first-failure families (48 functions) | local 10; identifier 22; type 8; global 8 | none 24; global 24 |
| TU packaging: unresolved pseudo-intrinsic / sentinel / callee / global / prototype | 14 / 8 / n/a / 132 / 547 | 16 / 8 / 99 / 149 / 590 |
| TU syntax sample: cases passing | 0/8 | 0/8 |

Raw single-function first diagnostics moved one layer outward: every sampled undeclared-local, undeclared-identifier, and unknown-type-name first failure is gone (10/10 local, 22/22 identifier, 8/8 type-name eliminated from the 48-function sample; 24 sampled functions now parse). All eight cases now fail first on undeclared globals (`global_*` names with no usable evidence at single-function scope). The per-function closure deliberately does not invent global declarations: a fabricated per-function type could contradict TU-level evidence, so globals stay visible exactly as emitted and remain the packager's work.

The packaged TU still fails all eight cases (0 rescued) but on the packager's own new failure layer instead of on the raw layer: per-case TU first families are now label, identifier, struct-kind redefinition, argument-count, array-assignability, and builtin-redeclaration diagnostics rather than undeclared locals/type names. TU fallback declarations for unresolved globals (`extern uint8_t name[]`), unresolved callees, and pseudo-intrinsics are present and counted separately; unresolved entries stay explicit, so the unresolved totals did not drop and `unresolved-callee` (functions referenced as data or without call-instruction evidence) is now reported as its own named kind instead of being folded into the prototype count.

The five baseline timeouts are retained in the denominator: `1/1_gcc_O1_g@5852`, `2/2_gcc_O1_g@5364`, `2/2_gcc_O1_g@6176`, `2/2_gcc_O1_g@9152`, and `3/3_gcc_O1_g@7196`. Their names were absent from the original timeout receipts; each case/address pair is preserved in `before.json`. The after run timed out 3 functions, all in `2/2_gcc_O1_g` (`5364` test_composite_types, `6176` __addtf3, `9152` __multf3; reasons recorded in `after.json`); timeout count differences are watchdog-runtime variation, not a product claim.


## Measurement limits

Unknown-instruction counts and structured/linear mode counts describe completed functions only (525 before, 527 after). A timed-out function has no completed pseudocode or coverage classification. The per-function syntax families come from the fixed 48-function replay sample (six functions per case), not the full completed set. Baseline and after timeout sets differ in membership (see the timeout note above); the before/after completed-function counts therefore differ by watchdog-runtime variation, which is also why goto/linear counts move slightly.

The lane target was undeclared-local 0 and unknown-type-name 0 in first-failure terms: met on the 48-function replay sample (0 undeclared-local and 0 unknown-type-name first failures after; 24/48 sampled functions parse). Raw cases still fail 0/8 and TU cases still fail 0/8; the remaining honest gaps are the undeclared-global first layer (single-function scope has no evidence for `global_*` types) and the packager's new TU-only failure layer named above. The integration candidate owns the full canonical release gate.
