# 00 — UNSUPPORTED exact baseline (stage 1)

- baseSha (worktree checkout at investigation start): `05c93a1c92b34f4876060bd858e4393557d02dd4`
- worktree HEAD at write time: `investigate/unsupported-semantics` (see `git log`)
- source of truth (READ ONLY): `reports/public-benchmark/summary.json` + per-case `reports/public-benchmark/*.json`
- this stage output: `unsupported-functions.json` (schema `hex-investigation-unsupported-inventory/v1`)
- `reports/public-benchmark/` is untouched (verified via `git diff --name-only BASE..HEAD -- reports/public-benchmark/` = empty).

## Recompute method (from current checkout, no cached claims)

```python
d = json.load(open('reports/public-benchmark/summary.json'))
rows = [(c['caseId'], r['address'], r['idaName'], r['hexName'])
        for c in d['comparison']['cases'] for r in c['rows']
        if r.get('hexState') == 'UNSUPPORTED']
```

Cross-checked against `unsupported-functions.json` by `(caseId, address, idaName)` set equality.

## Result (recomputed 2026-09-18, F worktree)

- recomputed UNSUPPORTED rows: **320**
- `unsupported-functions.json` rows: **320**
- set match: **exact** (missing 0, extra 0)
- distinct caseIds: **160** (every case contributes exactly 2)
- per-case UNSUPPORTED distribution: `{2: 160}`

## Distribution (from `unsupported-functions.json`)

- `summaryFunctionStates` (corpus-wide, from public report): `CRASH 340 / PARTIAL 692 / PASS 9600 / UNSUPPORTED 320`
- `byIdaName`: `.term_proc 160 / .init_proc 160`
- `byHexName`: `$x 320`
- `byHexFnEndNull`: `null 320` (every UNSUPPORTED row has `hexFnEnd == null`)
- `byHexFnState`: `UNSUPPORTED 320`
- `byHexFnCompleteness`: `unsupported 320`
- `byCompiler`: `clang 160 / gcc 160`
- `byOptimization`: `O0 64 / O1 64 / O2 64 / O3 64 / Os 64` (i.e. 16 clang + 16 gcc per level × debug on/off)
- `byDebug`: `true 160 / false 160`
- `byState`: `UNSUPPORTED 320`
- every row carries `binarySha256`, `caseId`, `address`, `idaName`, `hexName/hexFnName`, `hexState`, `compiler/optimization/debug`, `baseSha`.

Sample row (`1/1_clang_O0_g @ 0x2a84`):

```json
{"caseId": "1/1_clang_O0_g", "address": "0x2a84", "idaName": ".term_proc",
 "hexName": "$x", "hexState": "UNSUPPORTED", "hexFnEnd": null,
 "hexFnState": "UNSUPPORTED", "hexFnCompleteness": "unsupported",
 "compiler": "clang", "optimization": "O0", "debug": true}
```

The sibling row in the same case is `0x860 / .init_proc / $x / UNSUPPORTED`.

## Reference values (confirmed, not assumed)

- current public report `functionStates.UNSUPPORTED`: **320** — reproduced.
- comparison-row IDA names: `.init_proc` (160), `.term_proc` (160) — reproduced.
- comparison-row Hex name: `$x` (320) — reproduced.
- Hex function end null: 320/320 — reproduced from per-case subject JSON
  (`address` decimal `2144`→`0x860`, `10884`→`0x2a84`, `end: null`,
  `state: UNSUPPORTED`, `completeness: unsupported`, `pseudocode: null`).

## Notes for later stages

- `$x` is the *displayed* Hex name on the comparison row. Stage 3 shows it is
  not the root cause of UNSUPPORTED (function end is null regardless of name).
- Do not treat "IDA emitted it" as correctness, nor "Hex says unsupported" as bug.
  Stages 2–3 classify from binary ground truth + first-divergence trace.
- C lane (`fix/arch-symbol-ranking`) is changing same-address ranking; this
  baseline is recorded *before* that fix and must be re-verified after it.
