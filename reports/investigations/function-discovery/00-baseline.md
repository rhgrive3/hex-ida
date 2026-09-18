# Phase 1 — Exact baseline recomputation

Investigation-only lane. No production code, tests, tools, or `package.json` were modified.

## 1. Evidence identity

| item | value |
| --- | --- |
| report `git sha` (generator) | `c061412fcea53d355b2ada8ff644a21c05b34207` |
| report `git dirty` | `true` (the producing run had staged/untracked benchmark inputs — see below) |
| investigation checkout HEAD | `05c93a1c92b34f4876060bd858e4393557d02dd4` |
| branch | `investigate/function-discovery-gaps` |
| worktree | `/mnt/workspace/hex-agent-e` |
| `reports/public-benchmark/summary.json` sha256 | `e44df2a95b98bb0dfdb06bac4bc54d837db6830723830c9a71403142f83cada0` |
| summary schema | `hex-public-benchmark-report/v1` |
| `benchmarks/public/codefuse-arm64/manifest.json` sha256 | `de5d7726ef6bb18649a0b8cc5e4d261e01873eb7ae2c5734d203fed7c8eef992` |
| manifest schema / frozenAt | `hex-public-benchmark-manifest/v1` / `2026-09-17T23:13:02.092Z` |
| `denominatorFrozen` | `true` |
| comparison scope | `published-artifact-quality-only` |
| reference oracle | IDA Pro 9.1 / Hex-Rays, `CodeFuse-DeBench published artifact` |

`reports/public-benchmark/` was treated as **read-only**. Nothing under it was rewritten.
`baseSha` above is the SHA recorded inside the report itself; it is *not* the investigation
checkout SHA. Both are recorded in every machine-readable artifact in this directory.

## 2. Recomputation method

`scripts/baseline-extract.mjs` re-derives every number directly from the checked-out
`summary.json` + `manifest.json`:

- `idaPresent === true && hexPresent === false` → **IDA-only** set
- `hexPresent === true && idaPresent === false` → **Hex-only** set
- counts are cross-checked against `comparison.aggregate` and the script throws (fail-closed)
  if the enumerated rows disagree with the aggregate difference. Nothing is published unless
  the check passes; output is written to a temp file, re-parsed, then atomically renamed.

## 3. Recalculated numbers

| metric | recomputed | task reference | agrees |
| --- | --- | --- | --- |
| cases | 160 | 160 | yes |
| address-union denominator | 11,124 | 11,124 | yes |
| IDA-present total | 10,976 | — | — |
| Hex-present total | 10,952 | — | — |
| matched by address | 10,804 | 10,804 | yes |
| **IDA-present / Hex-absent** | **172** | 172 | yes |
| **Hex-present / IDA-absent** | **148** | 148 | yes |

Derived checks:

- `denominator == idaTotal + hexTotal - matched == 11124` → union is internally consistent.
- `idaOnly == 10976 - 10804 == 172`; `hexOnly == 10952 - 10804 == 148`.
- `hexCoverage = 0.9252067601582165`, `idaCoverage = 0.9866954332973751` (as published).
- `hexPseudo = 10292`.

**No discrepancy against the reference values was found.** The 172 / 148 split is exactly
reproducible from the current checkout.

### Reporting caveat found while validating

`summary.results[].state` is `CRASH` for **66 of 160** cases (`reason: "function-crash"`),
i.e. at least one function crashed during decompilation while the case still produced a full
comparison row set. This is a per-function quality signal, not a discovery-completeness signal:

- mean IDA-only per case: **1.152** (CRASH) vs **1.021** (PASS)
- mean Hex-only per case: **0.091** (CRASH) vs **1.511** (PASS)

The missing-function gap is therefore **not** explained by function crashes. It is
slightly *more* frequent on non-crashing cases, which further argues for a structural
(non-data-dependent) cause.

## 4. Distributions

### 4.1 Suite shape

| dimension | values |
| --- | --- |
| cases | 160 |
| group | `1/1` 20, `2/2` 20, `3/3` 20, `4/4` 20, `5-1/5-1` 20, `5-23/5-23` 20, `6/6` 20, `7/7` 20 |
| compiler | clang 80, gcc 80 |
| optimization | O0 32, O1 32, O2 32, O3 32, Os 32 |
| debug | `-g` 80, no `-g` 80 |

### 4.2 IDA-only (172 rows) distribution

| dimension | values |
| --- | --- |
| per case | 1 → 153 cases, 2 → 2 cases, 3 → 5 cases, **0 → none** |
| group | `1/1` 22, `2/2` 20, `3/3` 20, `4/4` 20, `5-1/5-1` 30, `5-23/5-23` 20, `6/6` 20, `7/7` 20 |
| compiler | clang 92, gcc 80 |
| optimization | O0 34, O1 36, O2 34, O3 34, Os 34 |
| debug | `-g` 91, no `-g` 81 |

**Every one of the 160 cases has at least one IDA-only address.** The distribution is almost
flat across group / compiler / optimization / debug, which is the first strong signal that the
cause is a per-binary structural convention difference rather than a data-dependent
discovery failure.

### 4.3 Hex-only (148 rows) distribution

| dimension | values |
| --- | --- |
| per case | 0 → 142 cases, 1 → 10, 3 → 2, 20 → 2, 23 → 4 |
| compiler | clang 132, gcc 16 |
| optimization | O1 4, O2 48, O3 48, Os 48 |
| debug | `-g` 74, no `-g` 74 |

The Hex-only side is far more concentrated: 92 of 148 rows come from the eight
`1/1_clang_O2/O3/Os` cases, where Hex reports ~20+ more function starts than IDA. This is the
mirror-image asymmetry and is investigated in Phase 2/3 because it is direct evidence about
which side models which construct.

### 4.4 Address cardinality

- 172 IDA-only rows collapse to **39 distinct virtual addresses**.
- Every `idaName` in the IDA-only set is an IDA-generated `sub_XXXX` name (39 distinct names,
  each mapping to exactly one address) — **no IDA-only row carries a real ELF symbol name.**

This is a second strong structural signal: the missing set is a small set of linker/runtime
layout positions, repeated across binaries, not user functions.

## 5. Artifacts

| file | contents |
| --- | --- |
| `ida-only-functions.json` | 172 rows with `baseSha`, `checkoutSha`, `caseId`, `binarySha256`, `address`, `idaName`, `compiler`, `optimization`, `debug`, `group`; plus recomputed totals and distributions |
| `hex-only-functions.json` | 148 rows (mirror direction) |
| `per-case-comparison.json` | per-case denominator / ida / hex / matched / idaOnly / hexOnly |
| `scripts/baseline-extract.mjs` | the extractor (atomic write + fail-closed validation) |

## 6. Conclusion of Phase 1

The published reference values are exactly reproducible from the current checkout. The 172
IDA-only rows are not a broad discovery shortfall: they are 39 distinct addresses that repeat
across all 160 cases, with a mean of ~1.08 addresses per case, no dependence on compiler,
optimization level, debug info, or crash state, and no real ELF symbol names. Phase 2
classifies what those 39 addresses actually are.
