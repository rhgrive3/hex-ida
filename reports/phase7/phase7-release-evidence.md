# Phase 7 release evidence — READY

- product: `034d5ae0d9509fb1b859663ae169f7745b334405` (tree `e437f7cbc4638959c74a6491303cf23c26f16048`, branch `feat/analysis-hex-c3-01-recursive-structural-types`, clean: true)
- verifier: phase7.verifier 1.0.0 (source sha256 `1de28d218aa3eda0`)
- profile version: 1
- corpus: phase7-alias-memory-corpus v1, digest `519bd15f3a918dbc2b436aca4870455d`, frozen match: true
- scoring: phase7.scoring 1.0.0; truth: phase7.corpus.declared-truth 1.0.0

## Alias precision (same frozen query set, same denominator)

| metric | baseline | candidate |
|---|---|---|
| exact relations proven | 1/3 | 3/3 |
| strong proven rate | 0.063 | 0.188 |
| may rate | 0.938 | 0.813 |
| unknown rate | 0.000 | 0.000 |
| false NoAlias | 0 | 0 |
| false MustAlias | 0 | 0 |

## Memory links

| metric | baseline | candidate |
|---|---|---|
| exact links | 2 | 2 |
| barriers correctly held | 2 | 2 |
| barrier bypasses | 0 | 0 |

## Checkpoints

- x P7-0
- x P7-1
- x P7-2
- x P7-3a
- x P7-3b
- x P7-3c
- x P7-4
- x P7-5a
- x P7-5b
- x P7-6
- x P7-I

## Failures

None.
