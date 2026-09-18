# 01 — Binary semantics of the 320 addresses (stage 2)

- baseSha: `05c93a1c92b34f4876060bd858e4393557d02dd4`
- exact inventory: `unsupported-functions.json`
- corrected corpus-wide semantic aggregation: `semantics.json` schema `hex-investigation-unsupported-semantics/v2`
- source benchmark artifacts are read-only.

## Corpus-wide result

The full 160-binary sweep closes the residual that existed in the first draft.

All **320 / 320** UNSUPPORTED rows are binary-grounded ELF runtime entities:

| property | corpus result |
|---|---:|
| rows | 320 |
| cases | 160 |
| `.init` rows | 160 |
| `.fini` rows | 160 |
| exact `DT_INIT` address matches | 160 / 160 |
| exact `DT_FINI` address matches | 160 / 160 |
| executable section starts | 320 / 320 |
| section fully file-backed by executable PT_LOAD | 320 / 320 |
| exact same-address `STT_FUNC` | 320 / 320 |
| FUNC binding | GLOBAL 320 |
| FUNC visibility | HIDDEN 320 |
| FUNC `st_size` | 0 for all 320 |
| same-address AArch64 mapping marker | `$x` 320 / 320 |
| unknown rows | 0 |

The section sizes are invariant in this corpus:

- `.init`: 24 bytes in all 160 binaries.
- `.fini`: 20 bytes in all 160 binaries.

The function symbols are likewise invariant:

- `_init`: 160 zero-size GLOBAL/HIDDEN FUNC symbols.
- `_fini`: 160 zero-size GLOBAL/HIDDEN FUNC symbols.

The benchmark-reference labels are `.init_proc` / `.term_proc`; those are
reference-tool labels, not ELF symbol names. The frozen Hex artifact displays
`$x` at these addresses because the old same-address canonical-name projection
allowed the local zero-size mapping marker to win. That display issue is separate
from function discovery and extent.

## Representative binary

`1/1_clang_O0_g`, SHA-256
`9600e39427753dcf4d4dc4c3ab218eca92bbf2fe898a8d3ca8204202ac0135ce`.

Ground truth:

- `.init @ 0x860`, size `0x18`, AX.
- `.fini @ 0x2a84`, size `0x14`, AX.
- `_init @ 0x860`, `STT_FUNC GLOBAL HIDDEN`, size 0.
- `_fini @ 0x2a84`, `STT_FUNC GLOBAL HIDDEN`, size 0.
- `$x @ 0x860` and `$x @ 0x2a84`, local `STT_NOTYPE` mapping markers.
- dynamic `DT_INIT == 0x860`.
- dynamic `DT_FINI == 0x2a84`.
- both sections are fully file-backed inside an executable PT_LOAD.

The reference artifact emits:

```c
/* Function: .init_proc @ 0x860 */
__int64 init_proc() { return call_weak_fn(); }

/* Function: .term_proc @ 0x2A84 */
void term_proc() { ; }
```

This proves only that the reference tool chose to model the loader entry bodies as
functions. The ELF evidence independently establishes that they are real executable
runtime entries: the dynamic loader contract points to those addresses and the
binary publishes FUNC symbols there.

## Mapping-symbol correction

The first draft's `semantics.json` reported `mappingSymbol:null`. That was an
aggregation bug: it failed to carry the same-address NOTYPE record into the
dedicated column. The corrected v2 sweep parses every symbol table and records
`$x` at **320 / 320** target addresses.

This does not change the root cause:

- the FUNC symbol proves an exact start,
- the mapping symbol affects presentation/code-data interpretation,
- neither record supplies a positive function extent because both are size 0.

The C lane's accepted same-address ranking makes the callable FUNC identity win
the displayed name (`_init` / `_fini`) over `$x`. It does **not** make the
function end non-null.

## Classification

Primary entity class: **B — real code, special runtime/init-fini entity (320).**

That classification is about *what the binary entity is*. It must not be
misread as "there is no product gap": under the frozen benchmark's current
published-artifact-quality scope these are legitimate matched addresses, and Hex
publishes no pseudocode for them because the extent gate fails. Stage 3 traces
that product limitation precisely.

A user-function-only metric may choose to exclude dynamic-loader init/fini
entries symmetrically as a supplemental lens. That is a scope choice, not a
replacement for the frozen benchmark and not evidence that the current Hex
coverage gap is fictitious.
